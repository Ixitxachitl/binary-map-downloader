// Orchestrator: enumerate planned tiles, skip anything already present in an uploaded/extended
// blob, run the fetch+render+threshold pipeline through a bounded worker pool, and report
// progress/results. Mirrors main()/worker()/bake_tile() in generate_map_tiles.py.
import { planTiles, tilesForRow, tileRangeForRegion } from "./tileMath.js";
import { coordKey, KIND_LZ4, INDEX_RECORD_SIZE } from "./blobFormat.js";
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
 *   existingRanges: [{zoom,xMin,yMin,width,height}] | null,  // that blob's own zoom-range table
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
 *
 * Returns { tiles, ranges, droppedRows, aborted, abortReason, plannedTotal, bakedTotal }. `ranges`
 * is the zoom-range table to write alongside `tiles` (see blobFormat.js's writeBlob) - built from
 * each row's own exact rectangle, not inferred from the tiles themselves (see the comment on the
 * assembly step below for why). `droppedRows` lists any row that didn't finish this run (stopped
 * or failed out partway through) - its tiles, if any, are excluded from `tiles`/`ranges` entirely
 * rather than written as a non-dense (and therefore firmware-invalid) range; re-running will
 * re-fetch it via the normal existingTiles skip-what's-already-there path.
 */
export async function runBake(config, callbacks = {}) {
  const { workers, maxConsecutiveFailures, rows, existingTiles, existingRanges, signal } = config;

  const plannedCoords = planTiles(rows);
  const tilesByCoord = new Map(existingTiles ? existingTiles.entries() : []);
  const alreadyCached = plannedCoords.filter(([z, x, y]) => tilesByCoord.has(coordKey(z, x, y))).length;
  const todo = plannedCoords.filter(([z, x, y]) => !tilesByCoord.has(coordKey(z, x, y)));

  const vectorFetcher = makeVectorFetcher(config);

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

  // Assemble the zoom-range table + tiles to write, instead of just handing back whatever's in
  // tilesByCoord: each zoom's tiles must form one or more exact dense rectangles (see
  // blobFormat.js's format comment) - a bounding box inferred after the fact from whatever tiles
  // happen to exist is exactly what caused this format to silently corrupt when two rows shared a
  // zoom, or a run was stopped mid-row. Ranges are built from the rows/existing blob instead, and
  // tiles are pulled in the matching order.
  const rowZooms = new Set(rows.map((r) => r.zoom));

  // Carried over unchanged from the uploaded blob, for any zoom the current rows don't touch at
  // all - without this, a zoom present in an extended blob but not re-added as a row would
  // silently vanish from the output.
  const carriedRanges = (existingRanges || []).filter((r) => !rowZooms.has(r.zoom));

  // A row only contributes a range (and its tiles) if every one of its planned cells actually
  // ended up baked this run or earlier (existingTiles). An incomplete row - still in flight when a
  // stop/failure-abort happened - can't be represented as one dense rectangle, so it's dropped
  // whole rather than written as a bogus non-dense range. Only the row(s) in flight at the moment
  // of a stop can end up here: everything planned earlier already finished, everything later never
  // started.
  const rowRanges = [];
  const droppedRows = [];
  for (const row of rows) {
    let complete = true;
    for (const c of tilesForRow(row.zoom, row.region)) {
      if (!tilesByCoord.has(coordKey(...c))) {
        complete = false;
        break;
      }
    }
    if (!complete) {
      droppedRows.push({ zoom: row.zoom, region: row.region });
      continue;
    }
    const { xMin, xMax, yMin, yMax } = tileRangeForRegion(row.zoom, row.region);
    rowRanges.push({ zoom: row.zoom, xMin, yMin, width: xMax - xMin + 1, height: yMax - yMin + 1 });
  }

  const ranges = [...carriedRanges, ...rowRanges].sort(
    (a, b) => a.zoom - b.zoom || a.xMin - b.xMin || a.yMin - b.yMin,
  );
  const finalTiles = ranges.flatMap((r) => tilesForRange(r, tilesByCoord));

  return {
    tiles: finalTiles,
    ranges,
    droppedRows,
    aborted,
    abortReason,
    plannedTotal: plannedCoords.length,
    bakedTotal: finalTiles.length,
  };
}

/** Pulls one range's tiles from `tilesByCoord` in the ascending (ty, tx) order the wire format
 * requires - the range's rectangle is assumed fully dense (callers only build a range once
 * they've confirmed that). */
function tilesForRange(range, tilesByCoord) {
  const out = [];
  for (let ty = range.yMin; ty < range.yMin + range.height; ty++) {
    for (let tx = range.xMin; tx < range.xMin + range.width; tx++) {
      out.push(tilesByCoord.get(coordKey(range.zoom, tx, ty)));
    }
  }
  return out;
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
