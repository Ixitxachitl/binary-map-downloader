// Vendored (and trimmed to just the raw LZ4 *block* format) from lz4js 0.2.0
// https://github.com/Benzinga/lz4js - ISC License, Copyright (c) John Chadwick
//
// Only compressBlock/decompressBlock are kept - the frame format (magic number,
// per-block headers, checksums) that the rest of lz4js implements isn't used here.
// This is the same raw-block layout python-lz4's `lz4.block.compress(data,
// store_size=False)` produces (no size prefix, no frame wrapper) - what
// NicheGraphics::MapTiles' decoder on the device expects. LZ4 block format is a
// standard, decoder-agnostic format: this encoder's output doesn't need to be
// byte-identical to python-lz4's, only correctly decodable by any conformant LZ4
// block decoder (verified via the compress/decompress round-trip in devTests.js).

const MIN_MATCH = 4;
const MIN_LENGTH = 13;
const SEARCH_LIMIT = 5;
const SKIP_TRIGGER = 6;
export const HASH_SIZE = 1 << 16;

const ML_BITS = 4;
const ML_MASK = (1 << ML_BITS) - 1;
const RUN_BITS = 4;
const RUN_MASK = (1 << RUN_BITS) - 1;

function readU32(b, n) {
  let x = 0;
  x |= b[n++] << 0;
  x |= b[n++] << 8;
  x |= b[n++] << 16;
  x |= b[n++] << 24;
  return x;
}

function hashU32(a) {
  a = a | 0;
  a = (a + 2127912214 + (a << 12)) | 0;
  a = a ^ -949894596 ^ (a >>> 19);
  a = (a + 374761393 + (a << 5)) | 0;
  a = (a + -744332180) ^ (a << 9);
  a = (a + -42973499 + (a << 3)) | 0;
  return (a ^ -1252372727 ^ (a >>> 16)) | 0;
}

/** Upper bound (bytes) for compressing an input of length n. */
export function compressBound(n) {
  return (n + n / 255 + 16) | 0;
}

/** Creates a fresh, zeroed match-position hash table for use with compressBlock. */
export function makeHashTable() {
  return new Uint32Array(HASH_SIZE);
}

/**
 * Compresses src[sIndex, sIndex+sLength) into dst (starting at dst[0]) as a single raw
 * LZ4 block. hashTable must be zeroed before each unrelated compression (see makeHashTable) -
 * reusing one across independent buffers without clearing would only hurt the compression
 * ratio (matches are always verified against the actual bytes before being emitted), not
 * correctness, but callers should still clear it for reproducible output. Returns the number
 * of bytes written to dst, or 0 if src was empty.
 */
export function compressBlock(src, dst, sIndex, sLength, hashTable) {
  let mIndex, mAnchor, mLength, mOffset, mStep;
  let literalCount, dIndex, sEnd, n;

  if (sLength === 0) return 0;

  dIndex = 0;
  sEnd = sLength + sIndex;
  mAnchor = sIndex;

  if (sLength >= MIN_LENGTH) {
    let searchMatchCount = (1 << SKIP_TRIGGER) + 3;

    while (sIndex + MIN_MATCH < sEnd - SEARCH_LIMIT) {
      const seq = readU32(src, sIndex);
      let hash = hashU32(seq) >>> 0;
      hash = ((hash >> 16) ^ hash) >>> 0 & 0xffff;

      mIndex = hashTable[hash] - 1;
      hashTable[hash] = sIndex + 1;

      if (mIndex < 0 || (sIndex - mIndex) >>> 16 > 0 || readU32(src, mIndex) !== seq) {
        mStep = searchMatchCount++ >> SKIP_TRIGGER;
        sIndex += mStep;
        continue;
      }

      searchMatchCount = (1 << SKIP_TRIGGER) + 3;

      literalCount = sIndex - mAnchor;
      mOffset = sIndex - mIndex;

      sIndex += MIN_MATCH;
      mIndex += MIN_MATCH;

      mLength = sIndex;
      while (sIndex < sEnd - SEARCH_LIMIT && src[sIndex] === src[mIndex]) {
        sIndex++;
        mIndex++;
      }
      mLength = sIndex - mLength;

      const token = mLength < ML_MASK ? mLength : ML_MASK;
      if (literalCount >= RUN_MASK) {
        dst[dIndex++] = (RUN_MASK << ML_BITS) + token;
        for (n = literalCount - RUN_MASK; n >= 0xff; n -= 0xff) dst[dIndex++] = 0xff;
        dst[dIndex++] = n;
      } else {
        dst[dIndex++] = (literalCount << ML_BITS) + token;
      }

      for (let i = 0; i < literalCount; i++) dst[dIndex++] = src[mAnchor + i];

      dst[dIndex++] = mOffset;
      dst[dIndex++] = mOffset >> 8;

      if (mLength >= ML_MASK) {
        for (n = mLength - ML_MASK; n >= 0xff; n -= 0xff) dst[dIndex++] = 0xff;
        dst[dIndex++] = n;
      }

      mAnchor = sIndex;
    }
  }

  // NOTE: upstream lz4js instead checks `if (mAnchor === 0) return 0`, meaning "no matches were
  // found starting from position 0" - since sIndex is always 0 in our (single tile, single
  // block) usage, that check would misfire on any real, non-empty, low-redundancy bitmap
  // (common for sparse 1-bit tiles) and silently drop the whole block. Emptiness is already
  // handled by the `sLength === 0` guard above, so nothing further needs to happen here.

  literalCount = sEnd - mAnchor;
  if (literalCount >= RUN_MASK) {
    dst[dIndex++] = RUN_MASK << ML_BITS;
    for (n = literalCount - RUN_MASK; n >= 0xff; n -= 0xff) dst[dIndex++] = 0xff;
    dst[dIndex++] = n;
  } else {
    dst[dIndex++] = literalCount << ML_BITS;
  }

  sIndex = mAnchor;
  while (sIndex < sEnd) dst[dIndex++] = src[sIndex++];

  return dIndex;
}

/** Decompresses a single raw LZ4 block of sLength bytes starting at src[sIndex] into dst
 * starting at dst[dIndex]. Returns the end write offset in dst. Used only for the in-browser
 * compress/decompress self-test (see devTests.js) - the real decode happens on-device. */
export function decompressBlock(src, dst, sIndex, sLength, dIndex) {
  let mLength, mOffset, sEnd, n, i;
  sEnd = sIndex + sLength;

  while (sIndex < sEnd) {
    const token = src[sIndex++];

    let literalCount = token >> 4;
    if (literalCount > 0) {
      if (literalCount === 0xf) {
        while (true) {
          literalCount += src[sIndex];
          if (src[sIndex++] !== 0xff) break;
        }
      }
      for (n = sIndex + literalCount; sIndex < n; ) dst[dIndex++] = src[sIndex++];
    }

    if (sIndex >= sEnd) break;

    mLength = token & 0xf;
    mOffset = src[sIndex++] | (src[sIndex++] << 8);

    if (mLength === 0xf) {
      while (true) {
        mLength += src[sIndex];
        if (src[sIndex++] !== 0xff) break;
      }
    }
    mLength += MIN_MATCH;

    for (i = dIndex - mOffset, n = i + mLength; i < n; ) dst[dIndex++] = dst[i++] | 0;
  }

  return dIndex;
}

/** Compresses the whole of `data` (a Uint8Array) as one raw LZ4 block. Mirrors
 * lz4.block.compress(data, store_size=False) in the Python script. */
export function compress(data) {
  const dst = new Uint8Array(compressBound(data.length));
  const hashTable = makeHashTable();
  const n = compressBlock(data, dst, 0, data.length, hashTable);
  return dst.subarray(0, n);
}
