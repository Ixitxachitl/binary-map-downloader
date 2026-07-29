// Tile source configuration + overzoom math.
//
// There's no hardcoded provider here - both raster and vector modes take a generic
// {z}/{x}/{y} URL template, so any tile server works (MapTiler, Stadia, a self-hosted
// OpenMapTiles instance, etc.) just by pasting its URL pattern in. The one convenience
// built in is resolving OpenFreeMap's actual (version-suffixed) vector tile URL from its
// TileJSON as the vector-mode default, since it's free/keyless/unlimited and uses the same
// OpenMapTiles schema our vector rasterizer already expects.

export const OPENFREEMAP_TILEJSON_URL = "https://tiles.openfreemap.org/planet";

// Used only if the TileJSON fetch itself fails (e.g. offline) - OpenFreeMap's tile URLs embed a
// dataset version segment that changes periodically, so this is a fallback, not the source of truth.
const OPENFREEMAP_FALLBACK_TEMPLATE =
  "https://tiles.openfreemap.org/planet/20260726_080001_pt/{z}/{x}/{y}.pbf";
const OPENFREEMAP_FALLBACK_MAXZOOM = 14;

let openFreeMapPromise = null;

/** Resolves { urlTemplate, maxzoom } for OpenFreeMap's public instance, caching the result for
 * the page's lifetime. Falls back to a fixed (possibly-stale) template if the TileJSON fetch
 * fails, rather than blocking the tool entirely on that one request. */
export function resolveOpenFreeMap() {
  if (!openFreeMapPromise) {
    openFreeMapPromise = fetch(OPENFREEMAP_TILEJSON_URL)
      .then((resp) => {
        if (!resp.ok) throw new Error(`TileJSON fetch failed: HTTP ${resp.status}`);
        return resp.json();
      })
      .then((json) => ({
        urlTemplate: json.tiles?.[0] || OPENFREEMAP_FALLBACK_TEMPLATE,
        maxzoom: json.maxzoom ?? OPENFREEMAP_FALLBACK_MAXZOOM,
      }))
      .catch((err) => {
        console.warn("Falling back to a fixed OpenFreeMap tile URL - TileJSON fetch failed:", err);
        return { urlTemplate: OPENFREEMAP_FALLBACK_TEMPLATE, maxzoom: OPENFREEMAP_FALLBACK_MAXZOOM };
      });
  }
  return openFreeMapPromise;
}

export function fillTileTemplate(template, z, x, y) {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

/**
 * Vector tile data sources commonly cap out around z14 (OpenMapTiles' standard max) - requesting
 * a deeper zoom means "overzooming": fetch the z14 ancestor tile and read its geometry through a
 * sub-window instead. Returns the tile actually worth fetching, plus the info needed to remap
 * that tile's local coordinates into the requested (deeper) tile's local space.
 */
export function resolveOverzoom(z, x, y, sourceMaxzoom) {
  if (z <= sourceMaxzoom) {
    return { fetchZ: z, fetchX: x, fetchY: y, factor: 1, offsetX: 0, offsetY: 0 };
  }
  const factor = 2 ** (z - sourceMaxzoom);
  const fetchX = Math.floor(x / factor);
  const fetchY = Math.floor(y / factor);
  return {
    fetchZ: sourceMaxzoom,
    fetchX,
    fetchY,
    factor,
    offsetX: x - fetchX * factor, // in units of "ancestor sub-cells", range [0, factor)
    offsetY: y - fetchY * factor,
  };
}

/** Maps a point in the fetched ancestor tile's local [0, extent) space into the requested
 * (possibly deeper) tile's local [0, extent) space. Points that land outside [0, extent) are
 * outside the requested tile - callers don't need to special-case that, canvas drawing simply
 * doesn't render past the tile-sized surface. */
export function transformOverzoomPoint(px, py, extent, overzoom) {
  if (overzoom.factor === 1) return [px, py];
  const subExtent = extent / overzoom.factor;
  return [
    (px - overzoom.offsetX * subExtent) * overzoom.factor,
    (py - overzoom.offsetY * subExtent) * overzoom.factor,
  ];
}
