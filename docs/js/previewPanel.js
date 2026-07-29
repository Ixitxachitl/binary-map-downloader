// Live "select and preview components before baking" panel: fetches+renders exactly one tile at
// a user-picked spot/zoom through the same rasterSource/vectorSource/threshold code path a real
// bake uses, so toggling a road class or label class (or the threshold slider) shows its effect
// immediately without waiting for a full run.
import { lonToTileX, latToTileY } from "./tileMath.js";
import { fillTileTemplate } from "./tileSource.js";
import { fetchTileBytes } from "./fetchTiles.js";
import { decodeRasterTile } from "./rasterSource.js";
import { createVectorTileFetcher, rasterizeVectorTile } from "./vectorSource.js";
import { thresholdPreview } from "./threshold.js";

let vectorFetcher = null;
let vectorFetcherKey = null;

function drawImageDataToCanvas(imageData, canvas) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

/** canvases: { rawCanvas, thresholdCanvas, statusEl } */
export async function renderPreview(config, lat, lon, zoom, canvases) {
  const { rawCanvas, thresholdCanvas, statusEl } = canvases;
  const z = Math.max(0, Math.round(zoom));
  const tx = lonToTileX(lon, z);
  const ty = latToTileY(lat, z);
  statusEl.textContent = `Loading z${z}/${tx}/${ty}...`;

  try {
    let imageData;
    if (config.mode === "raster") {
      const url = fillTileTemplate(config.raster.urlTemplate, z, tx, ty);
      const raw = await fetchTileBytes(url);
      imageData = await decodeRasterTile(raw, config.tileSize);
    } else {
      const key = `${config.vector.urlTemplate}|${config.vector.sourceMaxzoom}`;
      if (!vectorFetcher || vectorFetcherKey !== key) {
        vectorFetcher = createVectorTileFetcher(config.vector.urlTemplate, config.vector.sourceMaxzoom);
        vectorFetcherKey = key;
      }
      const { bytes, overzoom } = await vectorFetcher(z, tx, ty);
      imageData = rasterizeVectorTile(bytes, z, { ...config.vector, tileSize: config.tileSize }, overzoom);
    }

    drawImageDataToCanvas(imageData, rawCanvas);
    const threshold = config.mode === "raster" ? config.raster.threshold : 128;
    const invert = config.mode === "raster" ? config.raster.invert : false;
    drawImageDataToCanvas(thresholdPreview(imageData, config.tileSize, threshold, invert), thresholdCanvas);
    statusEl.textContent = `z${z}/${tx}/${ty} - ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  } catch (err) {
    statusEl.textContent = `Preview failed: ${err?.message || err}`;
  }
}

/** Call when the vector/raster URL template changes, so a stale fetcher (and its ancestor-tile
 * cache) isn't reused against a different source. */
export function resetVectorFetcher() {
  vectorFetcher = null;
  vectorFetcherKey = null;
}
