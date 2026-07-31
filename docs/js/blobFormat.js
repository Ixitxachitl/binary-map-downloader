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
// the world: each zoom's entries must span exactly [xMin, xMin+width) x [yMin, yMin+height) in
// ascending (ty, tx) order, which is exactly what bake.js's per-row planning already produces -
// this module just needs to record that rectangle per zoom, not change what gets fetched/baked.
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

export function coordKey(zoom, tx, ty) {
  return `${zoom},${tx},${ty}`;
}

/** Derives each distinct zoom's {xMin,yMin,width,height} from the actual tx/ty extent of tiles
 * present for that zoom, in ascending zoom order - the shape the firmware's zoom-range table
 * expects. Assumes (as bake.js/tileMath.js already guarantee) that each zoom's tiles are exactly
 * one dense rectangle. Exported for ui.js too, to populate the zoom-row list from an uploaded
 * blob's actual coverage. `tiles` can be any iterable of {zoom,tx,ty,...} - an array or a Map's
 * .values() both work. */
export function computeZoomRanges(tiles) {
  const byZoom = new Map();
  for (const t of tiles) {
    let r = byZoom.get(t.zoom);
    if (!r) {
      r = { zoom: t.zoom, xMin: t.tx, yMin: t.ty, xMax: t.tx, yMax: t.ty };
      byZoom.set(t.zoom, r);
    } else {
      if (t.tx < r.xMin) r.xMin = t.tx;
      if (t.tx > r.xMax) r.xMax = t.tx;
      if (t.ty < r.yMin) r.yMin = t.ty;
      if (t.ty > r.yMax) r.yMax = t.ty;
    }
  }
  return [...byZoom.values()]
    .sort((a, b) => a.zoom - b.zoom)
    .map((r) => ({ zoom: r.zoom, xMin: r.xMin, yMin: r.yMin, width: r.xMax - r.xMin + 1, height: r.yMax - r.yMin + 1 }));
}

/** tiles: array of { zoom, tx, ty, kind, payload: Uint8Array }, in ascending (zoom, ty, tx)
 * order (what bake.js's finalTiles already produces). */
export function writeBlob(tiles) {
  const zoomRanges = computeZoomRanges(tiles);

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

/** Reconstructs a Map<coordKey, {zoom,tx,ty,kind,payload}> from a previously-downloaded .bin,
 * so a new run can skip tiles it already contains ("extend an existing blob" workflow). Doesn't
 * need the zoom-range table's contents for anything (each tile's own zoom/tx/ty is already in
 * its entry) - just needs to skip over it to find where the tile-entry table actually starts. */
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
  const indexTableStart = headerSize + 1 + zoomRangeCount * ZOOM_RANGE_RECORD_SIZE;
  const indexSize = count * INDEX_RECORD_SIZE;
  const payloadBase = indexTableStart + indexSize;
  if (payloadBase > view.byteLength) {
    throw new Error("Truncated MTL2 blob (zoom-range/tile-entry table doesn't fit)");
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
  return tiles;
}
