// Slippy-map (Web Mercator) tile math, plus per-zoom-row region -> tile-coord enumeration.
// Mirrors the `coords` list generate_map_tiles.py builds, but region-aware per zoom level
// instead of always the whole world.

const MAX_LAT = 85.0511287798;

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function lonToTileX(lon, z) {
  const n = 2 ** z;
  return clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1);
}

export function latToTileY(lat, z) {
  const n = 2 ** z;
  const latRad = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return clamp(Math.floor(y), 0, n - 1);
}

export function tileXToLon(tx, z) {
  const n = 2 ** z;
  return (tx / n) * 360 - 180;
}

export function tileYToLat(ty, z) {
  const n = 2 ** z;
  const yFrac = 1 - (2 * ty) / n;
  return (Math.atan(Math.sinh(Math.PI * yFrac)) * 180) / Math.PI;
}

/**
 * region is either { whole: true } or { whole: false, north, south, east, west } (degrees).
 * Antimeridian-crossing boxes (west > east) are not supported - callers should keep the drawn
 * rectangle within a single wrap of longitude, same limitation Leaflet's own bounds have by
 * default.
 */
export function tileRangeForRegion(z, region) {
  const n = 2 ** z;
  if (!region || region.whole) {
    return { xMin: 0, xMax: n - 1, yMin: 0, yMax: n - 1 };
  }
  const xMin = lonToTileX(Math.min(region.west, region.east), z);
  const xMax = lonToTileX(Math.max(region.west, region.east), z);
  // Latitude increases northward but tile y increases southward.
  const yMin = latToTileY(region.north, z);
  const yMax = latToTileY(region.south, z);
  return { xMin, xMax, yMin, yMax };
}

// How far inside a tile the reconstructed region's edges sit, in tile widths. The edges must land
// strictly *within* the first and last tiles, because tileRangeForRegion floors whatever it's
// given: an edge exactly on a tile boundary (tileXToLon(xMax + 1), the obvious inverse) floors to
// the *next* tile, so every reconstructed region came back a column and a row too big. That was
// harmless while ranges were inferred from the tiles actually baked, but ranges now come straight
// from the rows, so the inflation is written to the file - and two ranges that merely touch in an
// uploaded blob would inflate into overlapping and get the next bake refused outright.
//
// Quarter/three-quarter rather than the tile edges themselves because latitude also needs the
// inset: lon <-> tileX is exact linear arithmetic, but lat <-> tileY goes through Mercator
// transcendentals and doesn't round-trip exactly, so even the north edge could floor a tile early.
// Fuzzing every rectangle shape across z0-z18 puts both axes at zero failures here.
const RANGE_EDGE_NEAR = 0.25;
const RANGE_EDGE_FAR = 0.75;

/** Converts a zoom-range's tile rectangle back to a lat/lon region - the inverse of
 * tileMath.tileRangeForRegion, such that feeding the result back through it reproduces exactly
 * the same rectangle. The region therefore sits a fraction of a tile inside the range's true
 * extent (see above); that's cosmetic and stable, not cumulative. */
export function regionFromZoomRange(r) {
  const n = 2 ** r.zoom;
  const xMax = r.xMin + r.width - 1;
  const yMax = r.yMin + r.height - 1;
  if (r.xMin === 0 && r.yMin === 0 && r.width === n && r.height === n) {
    return { whole: true };
  }
  return {
    whole: false,
    north: tileYToLat(r.yMin + RANGE_EDGE_NEAR, r.zoom),
    south: tileYToLat(yMax + RANGE_EDGE_FAR, r.zoom),
    west: tileXToLon(r.xMin + RANGE_EDGE_NEAR, r.zoom),
    east: tileXToLon(xMax + RANGE_EDGE_FAR, r.zoom),
  };
}

export function tileCountForRegion(z, region) {
  const { xMin, xMax, yMin, yMax } = tileRangeForRegion(z, region);
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}

/** Total planned tile count across every row, without enumerating a single tile - a "whole
 * world" row at a high zoom is billions of tiles, and merely counting them by iterating (as
 * tilesForRow/planTiles do) is exactly the kind of thing that hangs/crashes a tab; this is O(1)
 * per row instead. */
export function totalPlannedCount(rows) {
  let total = 0;
  for (const row of rows) total += tileCountForRegion(row.zoom, row.region);
  return total;
}

/**
 * Picks up to `cap` [z,x,y] coords spread evenly across one zoom row's region, without ever
 * enumerating the full grid - safe to call even when the region covers billions of tiles (a
 * "whole world" row at a high zoom). Only used for sampling/estimation, never for the real bake
 * (which genuinely needs every coordinate - see tilesForRow/planTiles).
 */
export function sampleTileRegion(z, region, cap) {
  const { xMin, xMax, yMin, yMax } = tileRangeForRegion(z, region);
  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  const total = width * height;
  if (total <= cap) {
    const coords = [];
    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) coords.push([z, tx, ty]);
    }
    return coords;
  }
  const side = Math.max(1, Math.floor(Math.sqrt(cap)));
  const coords = [];
  for (let i = 0; i < side; i++) {
    const tx = Math.min(xMax, xMin + Math.floor(((i + 0.5) * width) / side));
    for (let j = 0; j < side; j++) {
      const ty = Math.min(yMax, yMin + Math.floor(((j + 0.5) * height) / side));
      coords.push([z, tx, ty]);
    }
  }
  return coords;
}

/** Yields [z, tx, ty] triples for one zoom row's region, in (ty, tx) order - same order the
 * Python script's `coords` list uses (ty outer, tx inner) so output stays deterministic. */
export function* tilesForRow(z, region) {
  const { xMin, xMax, yMin, yMax } = tileRangeForRegion(z, region);
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      yield [z, tx, ty];
    }
  }
}

/** rows: array of { zoom, region } - one per configured zoom level, in ascending zoom order. */
export function planTiles(rows) {
  const coords = [];
  for (const row of rows) {
    for (const c of tilesForRow(row.zoom, row.region)) {
      coords.push(c);
    }
  }
  return coords;
}
