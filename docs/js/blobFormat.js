// MTLB binary blob format - must stay byte-compatible with the firmware's MapTileBlobFormat.h
// (NicheGraphics::MapTiles, see Ixitxachitl/meshtastic-firmware's BaseUI-Maps branch):
//
//   u32 magic 'MTL2', u32 tile_count
//   u8  zoom_range_count (N)
//   N * { u8 zoom, u16 xMin, u16 yMin, u16 width, u16 height }  (little-endian)
//   tile_count * { u8 zoom, u16 tx, u16 ty, u8 kind, u32 offset, u16 size }  (little-endian)
//   followed by concatenated payload bytes (offset is into this payload region)
//
// The zoom-range table exists so the firmware can compute a tile's index algebraically (no
// per-tile RAM index - see the firmware's comments) even when a zoom level only covers part of
// the world: each *range*'s entries must span exactly [xMin, xMin+width) x [yMin, yMin+height) in
// ascending (ty, tx) order, and ranges themselves are ordered by ascending zoom and laid out
// back-to-back in that same order in the tile-entry table.
//
// A zoom level may now be covered by more than one range, as long as they don't overlap each
// other - this lets a single blob hold multiple disjoint regions at the same zoom (e.g. two
// separate cities baked at the same zoom without also covering the ocean between them). Callers
// (bake.js) are responsible for supplying one range per contiguous region they actually baked -
// this module just encodes/decodes/validates whatever range list it's given, it doesn't infer
// ranges from tiles. This is a validation-rule relaxation only: the on-disk layout is unchanged
// from when every zoom was limited to exactly one range, and old firmware builds (which require
// strictly-ascending, non-repeating zooms) safely refuse a file that actually uses two ranges for
// the same zoom rather than misreading it - see MapTileBlobFormat.h's validateTileBlobZoomRanges.
//
// Magic was bumped from 'MTLB' to 'MTL2' when the zoom-range table was introduced, so an old
// dense-pyramid-only blob (or a new one read by old firmware) fails cleanly on the magic check
// instead of being misparsed.

export const KIND_LZ4 = 0;
export const KIND_WHITE = 1;
export const KIND_BLACK = 2;

export const INDEX_RECORD_SIZE = 12; // u8 + u16 + u16 + u8 + u32 + u16
const ZOOM_RANGE_RECORD_SIZE = 9; // u8 + u16 + u16 + u16 + u16
const MAGIC_BYTES = [0x4d, 0x54, 0x4c, 0x32]; // 'MTL2'

/** Hard ceiling on the zoom-range table: the count field on the wire is a u8. Exported so ui.js
 * can refuse a doomed setup before the bake rather than letting writeBlob throw hours later, and
 * matched by the firmware's own kTileBlobMaxZoomRanges. */
export const MAX_ZOOM_RANGES = 255;


export function coordKey(zoom, tx, ty) {
  return `${zoom},${tx},${ty}`;
}

/** Rectangle-overlap test for two ranges already known to share a zoom. Exported because the same
 * question gets asked in three places that must agree: this file's own pre-write validation,
 * bake.js deciding which uploaded ranges a row supersedes, and ui.js's pre-bake check. */
export function rangesOverlap(a, b) {
  return a.xMin < b.xMin + b.width && a.xMin + a.width > b.xMin && a.yMin < b.yMin + b.height && a.yMin + a.height > b.yMin;
}

/** Throws a clear Error if `ranges`/`tiles` don't satisfy what the firmware's own
 * validateTileBlobZoomRanges (MapTileBlobFormat.h) requires, so a bug in bake.js's range
 * assembly fails loudly here in JS instead of silently producing a file the firmware will later
 * reject (or, worse, misread). Also verifies `tiles` is laid out exactly range-by-range in the
 * order `ranges` gives, ascending (ty, tx) within each range, since the firmware's own
 * last-entry sanity check assumes that layout. */
function validateRangesAndTiles(tiles, ranges) {
  if (ranges.length > MAX_ZOOM_RANGES) {
    throw new Error(`Too many zoom ranges (${ranges.length}) - the wire format's count field is a u8`);
  }

  let prevZoom = -1;
  for (const r of ranges) {
    if (r.zoom < prevZoom) throw new Error("Zoom ranges must be sorted by non-decreasing zoom");
    prevZoom = r.zoom;
    if (r.width <= 0 || r.height <= 0) throw new Error(`Zoom ${r.zoom}: range has non-positive width/height`);
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i].zoom === ranges[j].zoom && rangesOverlap(ranges[i], ranges[j])) {
        throw new Error(`Zoom ${ranges[i].zoom}: two ranges overlap - regions sharing a zoom must be disjoint`);
      }
    }
  }

  const totalArea = ranges.reduce((s, r) => s + r.width * r.height, 0);
  if (totalArea !== tiles.length) {
    throw new Error(`Zoom-range areas (${totalArea}) don't match tile count (${tiles.length})`);
  }

  let tileIdx = 0;
  for (const r of ranges) {
    for (let ty = r.yMin; ty < r.yMin + r.height; ty++) {
      for (let tx = r.xMin; tx < r.xMin + r.width; tx++) {
        const t = tiles[tileIdx++];
        if (!t || t.zoom !== r.zoom || t.tx !== tx || t.ty !== ty) {
          throw new Error(`Tile order doesn't match zoom-range table at index ${tileIdx - 1} (expected z${r.zoom}/${tx}/${ty})`);
        }
      }
    }
  }
}

/** tiles: array of { zoom, tx, ty, kind, payload: Uint8Array }, laid out range-by-range (see
 * validateRangesAndTiles) - exactly what bake.js's range assembly produces. ranges: array of
 * { zoom, xMin, yMin, width, height }, one per contiguous region actually baked - a zoom may have
 * more than one range as long as they don't overlap (see the format comment above). */
export function writeBlob(tiles, ranges) {
  validateRangesAndTiles(tiles, ranges);
  const zoomRanges = ranges; // kept as `zoomRanges` below to mirror the on-disk field name

  let payloadSize = 0;
  for (const t of tiles) payloadSize += t.payload.length;

  const headerSize = 8;
  const zoomRangeTableSize = 1 + zoomRanges.length * ZOOM_RANGE_RECORD_SIZE;
  const indexSize = tiles.length * INDEX_RECORD_SIZE;
  const indexTableStart = headerSize + zoomRangeTableSize;
  const buf = new ArrayBuffer(indexTableStart + indexSize + payloadSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(MAGIC_BYTES, 0);
  view.setUint32(4, tiles.length, true);

  view.setUint8(headerSize, zoomRanges.length);
  let rangeOff = headerSize + 1;
  for (const r of zoomRanges) {
    view.setUint8(rangeOff, r.zoom);
    view.setUint16(rangeOff + 1, r.xMin, true);
    view.setUint16(rangeOff + 3, r.yMin, true);
    view.setUint16(rangeOff + 5, r.width, true);
    view.setUint16(rangeOff + 7, r.height, true);
    rangeOff += ZOOM_RANGE_RECORD_SIZE;
  }

  let indexOff = indexTableStart;
  let payloadOff = indexTableStart + indexSize;
  let runningOffset = 0;
  for (const t of tiles) {
    view.setUint8(indexOff, t.zoom);
    view.setUint16(indexOff + 1, t.tx, true);
    view.setUint16(indexOff + 3, t.ty, true);
    view.setUint8(indexOff + 5, t.kind);
    view.setUint32(indexOff + 6, runningOffset, true);
    view.setUint16(indexOff + 10, t.payload.length, true);
    indexOff += INDEX_RECORD_SIZE;

    bytes.set(t.payload, payloadOff);
    payloadOff += t.payload.length;
    runningOffset += t.payload.length;
  }

  return bytes;
}

/** Reconstructs { tiles: Map<coordKey, {zoom,tx,ty,kind,payload}>, ranges: [{zoom,xMin,yMin,
 * width,height}] } from a previously-downloaded .bin, so a new run can skip tiles it already
 * contains ("extend an existing blob" workflow) and so bake.js can carry forward, unchanged, any
 * range this session's rows don't touch (rather than silently dropping it - see bake.js). */
export function parseBlob(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  if (
    view.byteLength < 8 ||
    view.getUint8(0) !== MAGIC_BYTES[0] ||
    view.getUint8(1) !== MAGIC_BYTES[1] ||
    view.getUint8(2) !== MAGIC_BYTES[2] ||
    view.getUint8(3) !== MAGIC_BYTES[3]
  ) {
    throw new Error("Not an MTL2 blob (bad magic)");
  }
  const count = view.getUint32(4, true);
  const headerSize = 8;
  if (headerSize + 1 > view.byteLength) {
    throw new Error("Truncated MTL2 blob (no zoom-range count)");
  }
  const zoomRangeCount = view.getUint8(headerSize);
  const zoomRangeTableStart = headerSize + 1;
  const indexTableStart = zoomRangeTableStart + zoomRangeCount * ZOOM_RANGE_RECORD_SIZE;
  const indexSize = count * INDEX_RECORD_SIZE;
  const payloadBase = indexTableStart + indexSize;
  if (payloadBase > view.byteLength) {
    throw new Error("Truncated MTL2 blob (zoom-range/tile-entry table doesn't fit)");
  }

  const ranges = [];
  let rangeOff = zoomRangeTableStart;
  for (let i = 0; i < zoomRangeCount; i++) {
    ranges.push({
      zoom: view.getUint8(rangeOff),
      xMin: view.getUint16(rangeOff + 1, true),
      yMin: view.getUint16(rangeOff + 3, true),
      width: view.getUint16(rangeOff + 5, true),
      height: view.getUint16(rangeOff + 7, true),
    });
    rangeOff += ZOOM_RANGE_RECORD_SIZE;
  }

  const tiles = new Map();
  let indexOff = indexTableStart;
  for (let i = 0; i < count; i++) {
    const zoom = view.getUint8(indexOff);
    const tx = view.getUint16(indexOff + 1, true);
    const ty = view.getUint16(indexOff + 3, true);
    const kind = view.getUint8(indexOff + 5);
    const offset = view.getUint32(indexOff + 6, true);
    const size = view.getUint16(indexOff + 10, true);
    indexOff += INDEX_RECORD_SIZE;

    const start = payloadBase + offset;
    if (start + size > view.byteLength) {
      throw new Error(`Truncated MTL2 blob (payload for tile ${i} doesn't fit)`);
    }
    const payload = bytes.slice(start, start + size);
    tiles.set(coordKey(zoom, tx, ty), { zoom, tx, ty, kind, payload });
  }
  return { tiles, ranges };
}
