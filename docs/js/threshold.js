// Grayscale threshold + 1bpp column-major packing - ports threshold_tile() and
// pack_1bpp_column_major() from generate_map_tiles.py, plus the WHITE/BLACK/LZ4 kind decision
// bake_tile() makes right after.
import { KIND_LZ4, KIND_WHITE, KIND_BLACK } from "./blobFormat.js";
import { compress as lz4Compress } from "../vendor/lz4-block.js";

function packBits1bppColumnMajor(bits, tileSize) {
  const byteCols = tileSize / 8;
  const out = new Uint8Array(byteCols * tileSize);
  for (let y = 0; y < tileSize; y++) {
    const rowBase = y * tileSize;
    for (let bx = 0; bx < byteCols; bx++) {
      let byte = 0;
      const base = bx * 8;
      for (let k = 0; k < 8; k++) {
        if (bits[rowBase + base + k]) byte |= 1 << k;
      }
      out[bx * tileSize + y] = byte;
    }
  }
  return out;
}

/** dark[y*tileSize+x] booleans (as 0/1 Uint8Array), plus whether any/all pixels ended up dark -
 * shared by thresholdAndPack (the real bake) and thresholdPreview (the live preview panel), so
 * the preview always shows exactly what a bake would produce. */
function computeDarkBits(imageData, tileSize, threshold, invert) {
  const { data } = imageData;
  const bits = new Uint8Array(tileSize * tileSize);
  let anySet = false;
  let allSet = true;

  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    const gray = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    let dark = gray < threshold;
    if (invert) dark = !dark;
    bits[i] = dark ? 1 : 0;
    anySet = anySet || dark;
    allSet = allSet && dark;
  }

  return { bits, anySet, allSet };
}

/**
 * imageData: ImageData (RGBA, tileSize x tileSize). Returns { kind, payload: Uint8Array }
 * ready to go straight into a BakedTile - WHITE/BLACK tiles get an empty payload (free, matching
 * the Python script's sentinel-return convention), anything else is LZ4-compressed.
 */
export function thresholdAndPack(imageData, tileSize, threshold, invert) {
  const { bits, anySet, allSet } = computeDarkBits(imageData, tileSize, threshold, invert);

  if (!anySet) return { kind: KIND_WHITE, payload: new Uint8Array(0) };
  if (allSet) return { kind: KIND_BLACK, payload: new Uint8Array(0) };

  const packed = packBits1bppColumnMajor(bits, tileSize);
  const compressed = lz4Compress(packed);
  return { kind: KIND_LZ4, payload: compressed };
}

/** Renders exactly what thresholdAndPack would bake (dark pixels black, rest white) back to an
 * ImageData, for the live preview panel - lets settings changes (threshold/invert/road classes/
 * etc.) be checked visually before committing to a full run. */
export function thresholdPreview(imageData, tileSize, threshold, invert) {
  const { bits } = computeDarkBits(imageData, tileSize, threshold, invert);
  const out = new ImageData(tileSize, tileSize);
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    const v = bits[i] ? 0 : 255;
    out.data[p] = v;
    out.data[p + 1] = v;
    out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}
