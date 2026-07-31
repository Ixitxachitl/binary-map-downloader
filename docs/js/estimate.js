// Pre-flight (sample-based) and live-running estimates of download size, output blob size, and
// wall-clock time. generate_map_tiles.py only ever reports these numbers after the fact
// (render_progress/print_report); this adds an upfront guess plus a running estimate that
// tightens into the exact final numbers as real tiles complete.
import { tileCountForRegion, tileRangeForRegion, sampleTileRegion } from "./tileMath.js";
import { bakeSingleTile, makeVectorFetcher } from "./bake.js";
import { INDEX_RECORD_SIZE, KIND_LZ4 } from "./blobFormat.js";

const DEFAULT_SAMPLE_CAP = 24;

/** Picks up to `cap` coords spread proportionally across rows (by each row's own planned tile
 * count) and evenly spaced within a row, so a handful of sparse high-zoom tiles don't get
 * over- or under-weighted relative to their real share of the run. Uses tileCountForRegion/
 * sampleTileRegion throughout - never enumerates a row's full tile grid, which for a "whole
 * world" row at a high zoom can be billions of tiles (exactly what was hanging the page). */
export function pickSample(rows, cap = DEFAULT_SAMPLE_CAP, existingTiles = null) {
  const weighted = rows.map((row) => ({ row, count: tileCountForRegion(row.zoom, row.region) }));
  const totalCount = weighted.reduce((sum, w) => sum + w.count, 0);
  if (totalCount === 0) return [];

  const sample = [];
  for (const { row, count } of weighted) {
    if (count === 0 || sample.length >= cap) continue;
    const share = Math.max(1, Math.round((count / totalCount) * cap));
    for (const c of sampleTileRegion(row.zoom, row.region, share)) {
      if (sample.length >= cap) break;
      if (existingTiles && existingTiles.has(`${c[0]},${c[1]},${c[2]}`)) continue;
      sample.push(c);
    }
  }
  return sample.slice(0, cap);
}

/**
 * Bakes a small sample of the planned tiles (skipping the ones already present in
 * config.existingTiles, same as a real run would) to measure avg download bytes/tile and avg
 * compressed bytes/tile *per zoom* (density varies a lot by zoom), plus throughput. Returns null
 * if there was nothing to sample (e.g. everything's already covered by an uploaded blob, or
 * every row is empty). onProgress(done, total), if given, fires after each sample tile - this can
 * take a real, visible amount of time (each sample tile is a genuine fetch+render), so callers
 * should show *something* live rather than leaving stale numbers up while it runs.
 */
export async function runSamplePass(config, cap = DEFAULT_SAMPLE_CAP, onProgress) {
  const sample = pickSample(config.rows, cap, config.existingTiles);
  if (sample.length === 0) return null;

  const vectorFetcher = makeVectorFetcher(config);
  const perZoom = new Map(); // zoom -> { count, downloadBytes, compressedBytes }
  let totalDownloadBytes = 0;
  const start = performance.now();

  for (let i = 0; i < sample.length; i++) {
    const coord = sample[i];
    const [z] = coord;
    let result;
    try {
      result = await bakeSingleTile(coord, config, vectorFetcher);
    } catch {
      onProgress?.(i + 1, sample.length);
      continue; // a flaky sample tile shouldn't sink the whole estimate
    }
    totalDownloadBytes += result.downloadBytes;
    const entry = perZoom.get(z) || { count: 0, downloadBytes: 0, compressedBytes: 0 };
    entry.count++;
    entry.downloadBytes += result.downloadBytes;
    entry.compressedBytes += result.kind === KIND_LZ4 ? result.payload.length : 0;
    perZoom.set(z, entry);
    onProgress?.(i + 1, sample.length);
  }

  const elapsedSec = (performance.now() - start) / 1000;
  const bytesPerSec = elapsedSec > 0 ? totalDownloadBytes / elapsedSec : 0;

  return { perZoom, bytesPerSec, sampledCount: sample.length };
}

/** Extrapolates estimated total download size / output blob size / time from either a sample
 * pass or the real run's running totals so far - same shape either way, so the UI can swap one
 * for the other seamlessly as a run progresses. countsByZoom: Map<zoom, plannedTileCount>. */
export function extrapolateEstimate(perZoomStats, bytesPerSec, countsByZoom, workers) {
  let estDownloadBytes = 0;
  let estOutputBytes = 0;
  const fallback = averageAcrossZooms(perZoomStats);

  for (const [zoom, plannedCount] of countsByZoom) {
    const stats = perZoomStats.get(zoom) || fallback;
    if (!stats || stats.count === 0) continue;
    const avgDownload = stats.downloadBytes / stats.count;
    const avgCompressed = stats.compressedBytes / stats.count;
    estDownloadBytes += avgDownload * plannedCount;
    estOutputBytes += (avgCompressed + INDEX_RECORD_SIZE) * plannedCount;
  }

  const effectiveBytesPerSec = bytesPerSec * Math.max(1, workers * 0.6); // rough concurrency fudge
  const estSeconds = effectiveBytesPerSec > 0 ? estDownloadBytes / effectiveBytesPerSec : null;

  return { estDownloadBytes, estOutputBytes, estSeconds };
}

function averageAcrossZooms(perZoomStats) {
  let count = 0;
  let downloadBytes = 0;
  let compressedBytes = 0;
  for (const s of perZoomStats.values()) {
    count += s.count;
    downloadBytes += s.downloadBytes;
    compressedBytes += s.compressedBytes;
  }
  return count > 0 ? { count, downloadBytes, compressedBytes } : null;
}

/** Counts tiles per zoom that still need fetching (planned minus anything already present in an
 * uploaded/extended blob) - what extrapolateEstimate's countsByZoom should be measuring against,
 * since already-cached tiles cost nothing more to produce. Never enumerates a row's tile grid:
 * the planned count is O(1) math (tileCountForRegion), and matching against an uploaded blob
 * iterates the blob's (bounded) tile map instead of the (potentially enormous) planned grid. */
export function countRemainingByZoom(rows, existingTiles) {
  const counts = new Map();
  for (const row of rows) {
    const total = tileCountForRegion(row.zoom, row.region);
    let alreadyCached = 0;
    if (existingTiles && existingTiles.size > 0 && total > 0) {
      const { xMin, xMax, yMin, yMax } = tileRangeForRegion(row.zoom, row.region);
      for (const key of existingTiles.keys()) {
        const [z, x, y] = key.split(",").map(Number);
        if (z === row.zoom && x >= xMin && x <= xMax && y >= yMin && y <= yMax) alreadyCached++;
      }
    }
    counts.set(row.zoom, (counts.get(row.zoom) || 0) + Math.max(0, total - alreadyCached));
  }
  return counts;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
