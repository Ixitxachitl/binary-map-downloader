// Ports rasterize_vector_tile() from generate_map_tiles.py: decodes a MapTiler/OpenMapTiles-
// schema vector tile (.pbf) and draws a minimal basemap (solid land, water cutout, roads, admin
// borders, place labels) - no landcover/building fills, no POIs. Land is solid black (the whole
// canvas - OpenMapTiles has no standalone "land" polygon); water polygons punch that back to
// white; roads/borders/labels are drawn white on top. This is the inverse of toner-v2's own
// colors (toner leaves land white, fills only water) - matches what the original script drew.
//
// Polygon holes: the Python version had to classify rings into outer/hole (classifyRings) and
// punch holes back to the fill color by hand, because PIL's polygon fill has no hole concept.
// Canvas Path2D's "evenodd" fill rule handles nesting natively, so every ring returned by
// loadGeometry() for a qualifying feature can go into one shared path and get filled once -
// no ring classification needed here.
import { VectorTile } from "../vendor/vector-tile.js";
import { PbfReader } from "../vendor/pbf.js";
import { makeCanvas } from "./canvasUtil.js";
import { fillTileTemplate, resolveOverzoom, transformOverzoomPoint } from "./tileSource.js";
import { fetchTileBytes } from "./fetchTiles.js";

// Zoom/rank windows for the 'place' layer, transcribed from MapTiler's toner-v2 style.json
// (fetched 2026-07-29; re-derive if the upstream style changes) so labels appear/disappear at
// the same zooms toner's own label layers do. maxzoom: null means no upper bound. One layer
// from that style isn't reproduced: the catch-all "Place labels" layer (suburb/neighbourhood/
// hamlet/isolated_dwelling/island/quarter, matched by *excluding* the classes below) - it's the
// most cluttering tier and is skipped by design for a minimal basemap.
export const PLACE_LABEL_RULES = [
  { classes: new Set(["continent"]), minzoom: 0, maxzoom: 2, maxRank: null },
  { classes: new Set(["country"]), minzoom: 2, maxzoom: 10, maxRank: null },
  { classes: new Set(["state", "province"]), minzoom: 4, maxzoom: 10, maxRank: 6 },
  { classes: new Set(["city"]), minzoom: 5, maxzoom: 16, maxRank: null },
  { classes: new Set(["town"]), minzoom: 10, maxzoom: 16, maxRank: null },
  { classes: new Set(["village"]), minzoom: 12, maxzoom: null, maxRank: null },
];

function findLabelRule(cls) {
  return PLACE_LABEL_RULES.find((r) => r.classes.has(cls)) || null;
}

export const DEFAULT_ROAD_CLASSES = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "pier",
]);
export const DEFAULT_LABEL_CLASSES = new Set([
  "continent", "country", "state", "province", "city", "town", "village",
]);

/** Creates a fetcher that resolves overzoom (see tileSource.js) and de-dupes/caches ancestor
 * tile fetches across a whole bake run, so requesting many deep-zoom descendants of the same
 * source-maxzoom ancestor only downloads that ancestor once. */
export function createVectorTileFetcher(urlTemplate, sourceMaxzoom, { retries } = {}) {
  const cache = new Map(); // "z,x,y" -> Promise<Uint8Array>
  return async function fetchRawVectorTile(z, x, y, signal) {
    const overzoom = resolveOverzoom(z, x, y, sourceMaxzoom);
    const key = `${overzoom.fetchZ},${overzoom.fetchX},${overzoom.fetchY}`;
    let promise = cache.get(key);
    if (!promise) {
      const url = fillTileTemplate(urlTemplate, overzoom.fetchZ, overzoom.fetchX, overzoom.fetchY);
      promise = fetchTileBytes(url, { retries, signal });
      cache.set(key, promise);
    }
    const bytes = await promise;
    return { bytes, overzoom };
  };
}

function projected(px, py, extent, scale, overzoom) {
  const [ox, oy] = transformOverzoomPoint(px, py, extent, overzoom);
  return [ox * scale, oy * scale];
}

function addRingsToPath(path, rings, extent, scale, overzoom) {
  for (const ring of rings) {
    if (ring.length < 3) continue;
    ring.forEach((p, i) => {
      const [x, y] = projected(p.x, p.y, extent, scale, overzoom);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
  }
}

function strokeLines(ctx, lines, extent, scale, overzoom) {
  for (const line of lines) {
    if (line.length < 2) continue;
    ctx.beginPath();
    line.forEach((p, i) => {
      const [x, y] = projected(p.x, p.y, extent, scale, overzoom);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

/**
 * pbfBytes/overzoom come from createVectorTileFetcher(). opts: { roadClasses: Set<string>,
 * roadMinzoom, boundaryMaxAdminLevel, labelClasses: Set<string>, lineWidth, waterFill, tileSize }.
 * zoom is the *requested* zoom (may be deeper than the fetched ancestor tile's zoom).
 */
export function rasterizeVectorTile(pbfBytes, zoom, opts, overzoom) {
  const { roadClasses, roadMinzoom, boundaryMaxAdminLevel, labelClasses, lineWidth, waterFill, tileSize } = opts;

  const tile = new VectorTile(new PbfReader(pbfBytes));
  const canvas = makeCanvas(tileSize, tileSize);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, tileSize, tileSize);

  // "Water": brunnel != tunnel, intermittent != 1, polygons only - cut out first (white) so
  // roads/borders/labels below draw on top of it.
  const water = tile.layers.water;
  if (waterFill && water) {
    const scale = tileSize / water.extent;
    const path = new Path2D();
    for (let i = 0; i < water.length; i++) {
      const f = water.feature(i);
      const p = f.properties;
      if (p.brunnel === "tunnel" || p.intermittent === 1) continue;
      if (f.type !== 3) continue; // Polygon/MultiPolygon only
      addRingsToPath(path, f.loadGeometry(), water.extent, scale, overzoom);
    }
    ctx.fillStyle = "white";
    ctx.fill(path, "evenodd");
  }

  // "Road network": class in roadClasses, but toner draws no roads at all below roadMinzoom.
  const transportation = tile.layers.transportation;
  if (transportation && zoom >= roadMinzoom) {
    const scale = tileSize / transportation.extent;
    ctx.strokeStyle = "white";
    ctx.lineWidth = lineWidth;
    for (let i = 0; i < transportation.length; i++) {
      const f = transportation.feature(i);
      if (!roadClasses.has(f.properties.class)) continue;
      if (f.type !== 2) continue; // LineString/MultiLineString only
      strokeLines(ctx, f.loadGeometry(), transportation.extent, scale, overzoom);
    }
  }

  // "Country border" (admin_level 2) appears from zoom 2; "Other border" (admin_level 3..N)
  // from zoom 3. Maritime boundaries are always excluded, matching toner's `maritime == 0`.
  const boundary = tile.layers.boundary;
  if (boundary) {
    const scale = tileSize / boundary.extent;
    ctx.strokeStyle = "white";
    ctx.lineWidth = lineWidth;
    for (let i = 0; i < boundary.length; i++) {
      const f = boundary.feature(i);
      const p = f.properties;
      if (p.maritime) continue;
      const adminLevel = p.admin_level ?? 99;
      let minZoomForFeature;
      if (adminLevel === 2) minZoomForFeature = 2;
      else if (adminLevel >= 3 && adminLevel <= boundaryMaxAdminLevel) minZoomForFeature = 3;
      else continue;
      if (zoom < minZoomForFeature) continue;
      if (f.type !== 2) continue;
      strokeLines(ctx, f.loadGeometry(), boundary.extent, scale, overzoom);
    }
  }

  const place = tile.layers.place;
  if (place) {
    const scale = tileSize / place.extent;
    ctx.fillStyle = "white";
    ctx.font = `${Math.round((10 * tileSize) / 256)}px sans-serif`;
    // Halo (black stroke behind the white fill) so labels stay legible over the white water
    // cutout or a road/border line crossing under them, not just over black land.
    ctx.strokeStyle = "black";
    ctx.lineWidth = Math.max(2, Math.round((3 * tileSize) / 256));
    ctx.lineJoin = "round";
    for (let i = 0; i < place.length; i++) {
      const f = place.feature(i);
      const p = f.properties;
      const cls = p.class;
      if (!labelClasses.has(cls)) continue;
      const rule = findLabelRule(cls);
      if (!rule) continue; // class not in our (deliberately trimmed) set of recognized tiers
      if (!(zoom >= rule.minzoom && zoom < (rule.maxzoom ?? Infinity))) continue;
      if (rule.maxRank != null) {
        const rank = p.rank;
        if (rank == null || rank > rule.maxRank) continue;
      }
      if (cls === "country" && p.iso_a2 === "VA") continue; // toner excludes Vatican City's label
      if (f.type !== 1) continue; // Point only
      const name = p["name:latin"] || p.name;
      if (!name) continue;
      const lines = f.loadGeometry();
      for (const pointLine of lines) {
        const pt = pointLine[0];
        const [x, y] = projected(pt.x, pt.y, place.extent, scale, overzoom);
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeText(name, x + 3, y - 3);
        ctx.fillText(name, x + 3, y - 3);
      }
    }
  }

  return ctx.getImageData(0, 0, tileSize, tileSize);
}
