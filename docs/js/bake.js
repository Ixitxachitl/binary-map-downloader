// Orchestrator: enumerate planned tiles, skip anything already present in an uploaded/extended
// blob, run the fetch+render+threshold pipeline through a bounded worker pool, and report
// progress/results. Mirrors main()/worker()/bake_tile() in generate_map_tiles.py.
import { planTiles } from "./tileMath.js";
import { coordKey, KIND_LZ4, KIND_WHITE, KIND_BLACK, INDEX_RECORD_SIZE } from "./blobFormat.js";
import { runPool, fetchTileBytes } from "./fetchTiles.js";
import { decodeRasterTile } from "./rasterSource.js";
import { rasterizeVectorTile, createVectorTileFetcher } from "./vectorSource.js";
import { fillTileTemplate } from "./tileSource.js";
import { thresholdAndPack } from "./threshold.js";

/** Fetches+renders+thresholds exactly one tile. Shared by the real bake pool and estimate.js's
 * pre-flight sample pass, so the estimate is measured from the same code path it's estimating. */
export async function bakeSingleTile([z, tx, ty], config, vectorFetcher, signal) {
  const { mode, tileSize } = config;
  if (mode === "raster") {
    const url = fillTileTemplate(config.raster.urlTemplate, z, tx, ty);
    const raw = await fetchTileBytes(url, { signal });
    const imageData = await decodeRasterTile(raw, tileSize);
    const { kind, payload } = thresholdAndPack(imageData, tileSize, config.raster.threshold, config.raster.invert);
    return { kind, payload, downloadBytes: raw.length };
  }
  const { bytes, overzoom } = await vectorFetcher(z, tx, ty, signal);
  const imageData = rasterizeVectorTile(bytes, z, { ...config.vector, tileSize }, overzoom);
  const { kind, payload } = thresholdAndPack(imageData, tileSize, 128, false);
  return { kind, payload, downloadBytes: bytes.length };
}

export function makeVectorFetcher(config) {
  return config.mode === "vector"
    ? createVectorTileFetcher(config.vector.urlTemplate, config.vector.sourceMaxzoom)
    : null;
}

/**
 * config = {
 *   mode: "raster" | "vector",
 *   tileSize, workers, maxConsecutiveFailures,
 *   rows: [{ zoom, region }],                 // see tileMath.planTiles
 *   existingTiles: Map<coordKey, BakedTile> | null,   // from an uploaded blob, to extend
 *   raster: { urlTemplate, threshold, invert },
 *   vector: { urlTemplate, sourceMaxzoom, roadClasses, roadMinzoom, boundaryMaxAdminLevel,
 *             labelClasses, lineWidth, waterFill },
 *   signal: AbortSignal,                      // Stop button
 * }
 * callbacks = { onProgress({done,total,newlyFetched,newTotal,elapsedSec,downloadBytes}),
 *               onTileError(coord,err,consecutiveFailures) }
 * done/total include tiles already covered by existingTiles (skipped, not re-fetched); those can
 * be a large head start on `done` for an "extend an existing blob" run, so newlyFetched/newTotal
 * (this run's actual fetch count, excluding anything skipped) is provided too, to keep the
 * progress display honest about how much *new* work is happening.
 */
export async function runBake(config, callbacks = {}) {
  const { workers, maxConsecutiveFailures, rows, existingTiles, signal } = config;

  const plannedCoords = planTiles(rows);
  const tilesByCoord = new Map(existingTiles ? existingTiles.entries() : []);
  const alreadyCached = plannedCoords.filter(([z, x, y]) => tilesByCoord.has(coordKey(z, x, y))).length;
  const todo = plannedCoords.filter(([z, x, y]) => !tilesByCoord.has(coordKey(z, x, y)));

  const vectorFetcher = makeVectorFetcher(config);

  const kindCounts = { [KIND_LZ4]: 0, [KIND_WHITE]: 0, [KIND_BLACK]: 0 };
  for (const t of tilesByCoord.values()) kindCounts[t.kind]++;

  let fetchedCount = 0;
  let downloadBytes = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let abortReason = null;
  const startTime = performance.now();

  await runPool(
    todo,
    workers,
    (coord) => bakeSingleTile(coord, config, vectorFetcher, signal),
    (coord, result, err) => {
      if (aborted) return;
      const [z, tx, ty] = coord;
      if (err) {
        consecutiveFailures++;
        callbacks.onTileError?.(coord, err, consecutiveFailures);
        if (consecutiveFailures >= maxConsecutiveFailures) {
          aborted = true;
          abortReason = `${maxConsecutiveFailures} fetches failed in a row - almost certainly a dead endpoint/key, not bad luck. Stopped early.`;
        }
        return;
      }
      consecutiveFailures = 0;
      const tile = { zoom: z, tx, ty, kind: result.kind, payload: result.payload };
      tilesByCoord.set(coordKey(z, tx, ty), tile);
      kindCounts[result.kind]++;
      fetchedCount++;
      downloadBytes += result.downloadBytes;
      callbacks.onProgress?.({
        done: alreadyCached + fetchedCount,
        total: plannedCoords.length,
        newlyFetched: fetchedCount,
        newTotal: todo.length,
        elapsedSec: (performance.now() - startTime) / 1000,
        downloadBytes,
      });
    },
    () => aborted || Boolean(signal?.aborted),
  );

  if (!aborted && signal?.aborted) {
    aborted = true;
    abortReason = "Stopped by user.";
  }

  // Preserve deterministic (z, ty, tx) ordering regardless of completion order. A stopped run
  // simply yields whatever's present - the same "partial blob" a crash mid-run would leave.
  const finalTiles = [];
  for (const c of plannedCoords) {
    const t = tilesByCoord.get(coordKey(...c));
    if (t) finalTiles.push(t);
  }

  return {
    tiles: finalTiles,
    kindCounts,
    aborted,
    abortReason,
    plannedTotal: plannedCoords.length,
    bakedTotal: finalTiles.length,
  };
}

/** Mirrors print_report()'s size/kind math, for the end-of-run report panel. */
export function summarizeBake(tiles, tileSize) {
  let rawTotal = 0;
  let compressedTotal = 0;
  const byZoom = new Map();
  for (const t of tiles) {
    if (t.kind === KIND_LZ4) {
      rawTotal += (tileSize * tileSize) / 8;
      compressedTotal += t.payload.length;
    }
    if (!byZoom.has(t.zoom)) byZoom.set(t.zoom, []);
    byZoom.get(t.zoom).push(t);
  }
  const perZoom = [...byZoom.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([zoom, zt]) => {
      const free = zt.filter((t) => t.kind !== KIND_LZ4).length;
      const payloadBytes = zt.reduce((s, t) => s + t.payload.length, 0) + INDEX_RECORD_SIZE * zt.length;
      return { zoom, count: zt.length, free, payloadBytes };
    });
  return { rawTotal, compressedTotal, perZoom };
}
