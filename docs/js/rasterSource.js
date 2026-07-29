// Decodes a pre-rendered raster tile (PNG/JPEG bytes) to ImageData sized tileSize x tileSize -
// the browser equivalent of decode_tile_image() + the implicit LANCZOS resize in threshold_tile()
// in generate_map_tiles.py. There's no bundled raster provider (see tileSource.js) - the URL
// template is whatever the user pastes in.
import { makeCanvas } from "./canvasUtil.js";

export async function decodeRasterTile(bytes, tileSize) {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  const canvas = makeCanvas(tileSize, tileSize);
  const ctx = canvas.getContext("2d");
  // drawImage scales to the destination rect regardless of the bitmap's native size, matching
  // the Python script's "only resize if the fetched size doesn't already match" behavior (a
  // same-size draw is just an identity copy here).
  ctx.drawImage(bitmap, 0, 0, tileSize, tileSize);
  bitmap.close?.();
  return ctx.getImageData(0, 0, tileSize, tileSize);
}
