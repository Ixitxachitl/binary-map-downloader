// Self-checks run once on page load - correctness here matters more than usual since this feeds
// a firmware decoder with no test harness of its own in this repo. Logs to console; surfaces a
// visible banner only on failure (silent success, loud failure).
import { lonToTileX, latToTileY } from "./tileMath.js";
import { writeBlob, parseBlob, coordKey, KIND_LZ4, KIND_WHITE } from "./blobFormat.js";
import { compress as lz4Compress, decompressBlock, makeHashTable } from "../vendor/lz4-block.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testTileMath() {
  assert(lonToTileX(-180, 0) === 0, "lonToTileX(-180,0)");
  assert(lonToTileX(180 - 1e-6, 0) === 0, "lonToTileX top edge z0 should still be tile 0");
  assert(lonToTileX(0, 1) === 1, "lonToTileX(0,1) should be the right half at z1");
  assert(latToTileY(0, 1) === 1, "latToTileY(0,1) equator should be in the lower half at z1");
  assert(latToTileY(85, 1) === 0, "latToTileY(85,1) near north pole should be tile 0");
}

function testLz4RoundTrip() {
  const cases = [
    new Uint8Array(0),
    // Shorter than MIN_LENGTH (13), so compressBlock's match-search loop never runs at all and
    // mAnchor never leaves its initial value - the exact upstream-lz4js bug case fixed in
    // vendor/lz4-block.js (see the comment above compressBlock there). Non-empty, non-zero
    // content: the old `mAnchor === 0` check would have wrongly returned 0 (nothing encoded)
    // for this input purely because sIndex starts at 0 in our one-block-per-tile usage.
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    new Uint8Array(32768), // all-zero, highly compressible
    (() => {
      const a = new Uint8Array(32768);
      for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) & 0xff; // pseudo-random, low redundancy
      return a;
    })(),
    (() => {
      const a = new Uint8Array(500);
      for (let i = 0; i < a.length; i++) a[i] = i % 7 === 0 ? 1 : 0; // sparse, like a mostly-blank tile
      return a;
    })(),
  ];
  for (const input of cases) {
    const compressed = lz4Compress(input);
    const dst = new Uint8Array(input.length);
    const written = decompressBlock(compressed, dst, 0, compressed.length, 0);
    assert(written === input.length, `LZ4 round-trip length mismatch (${written} vs ${input.length})`);
    for (let i = 0; i < input.length; i++) {
      assert(dst[i] === input[i], `LZ4 round-trip byte mismatch at ${i}`);
    }
  }
  void makeHashTable; // referenced so bundlers/linters don't flag the import as unused
}

function testBlobRoundTrip() {
  const tiles = [
    { zoom: 0, tx: 0, ty: 0, kind: KIND_WHITE, payload: new Uint8Array(0) },
    { zoom: 3, tx: 5, ty: 2, kind: KIND_LZ4, payload: new Uint8Array([1, 2, 3, 4, 5]) },
    { zoom: 3, tx: 6, ty: 2, kind: KIND_LZ4, payload: new Uint8Array([255, 0, 128]) },
  ];
  const ranges = [
    { zoom: 0, xMin: 0, yMin: 0, width: 1, height: 1 },
    { zoom: 3, xMin: 5, yMin: 2, width: 2, height: 1 },
  ];
  const blob = writeBlob(tiles, ranges);
  const { tiles: parsed, ranges: parsedRanges } = parseBlob(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
  assert(parsed.size === tiles.length, "parseBlob tile count mismatch");
  assert(parsedRanges.length === ranges.length, "parseBlob range count mismatch");
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const got = parsedRanges[i];
    assert(
      got.zoom === r.zoom && got.xMin === r.xMin && got.yMin === r.yMin && got.width === r.width && got.height === r.height,
      `parseBlob range ${i} mismatch`,
    );
  }
  for (const t of tiles) {
    const got = parsed.get(coordKey(t.zoom, t.tx, t.ty));
    assert(got, `parseBlob missing tile ${t.zoom},${t.tx},${t.ty}`);
    assert(got.kind === t.kind, "parseBlob kind mismatch");
    assert(got.payload.length === t.payload.length, "parseBlob payload length mismatch");
    for (let i = 0; i < t.payload.length; i++) {
      assert(got.payload[i] === t.payload[i], "parseBlob payload byte mismatch");
    }
  }
}

/** Two disjoint regions sharing a zoom - the multi-region-per-zoom capability itself, and the
 * main reason this format now needs more than one range per zoom (see blobFormat.js). */
function testMultiRangeBlobRoundTrip() {
  const tiles = [
    { zoom: 5, tx: 0, ty: 0, kind: KIND_WHITE, payload: new Uint8Array(0) },
    { zoom: 5, tx: 1, ty: 0, kind: KIND_WHITE, payload: new Uint8Array(0) },
    { zoom: 5, tx: 0, ty: 1, kind: KIND_WHITE, payload: new Uint8Array(0) },
    { zoom: 5, tx: 1, ty: 1, kind: KIND_WHITE, payload: new Uint8Array(0) },
    { zoom: 5, tx: 10, ty: 10, kind: KIND_LZ4, payload: new Uint8Array([9, 8, 7]) },
    { zoom: 5, tx: 11, ty: 10, kind: KIND_LZ4, payload: new Uint8Array([6, 5]) },
  ];
  const ranges = [
    { zoom: 5, xMin: 0, yMin: 0, width: 2, height: 2 },
    { zoom: 5, xMin: 10, yMin: 10, width: 2, height: 1 },
  ];
  const blob = writeBlob(tiles, ranges);
  const { tiles: parsed, ranges: parsedRanges } = parseBlob(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
  assert(parsed.size === tiles.length, "multi-range parseBlob tile count mismatch");
  assert(parsedRanges.length === 2, "multi-range parseBlob should keep both ranges for the shared zoom");
  for (const t of tiles) {
    const got = parsed.get(coordKey(t.zoom, t.tx, t.ty));
    assert(got, `multi-range parseBlob missing tile ${t.zoom},${t.tx},${t.ty}`);
    assert(got.kind === t.kind, "multi-range parseBlob kind mismatch");
  }
}

/** Defense in depth (mirrors what ui.js's own pre-bake check should already have caught) -
 * writeBlob must never silently produce a file two same-zoom ranges overlap in, since that's
 * exactly what the firmware's index arithmetic can't represent. */
function testWriteBlobRejectsOverlappingSameZoomRanges() {
  const tiles = [{ zoom: 5, tx: 0, ty: 0, kind: KIND_WHITE, payload: new Uint8Array(0) }];
  const overlapping = [
    { zoom: 5, xMin: 0, yMin: 0, width: 2, height: 2 },
    { zoom: 5, xMin: 1, yMin: 1, width: 2, height: 2 },
  ];
  let threw = false;
  try {
    writeBlob(tiles, overlapping);
  } catch {
    threw = true;
  }
  assert(threw, "writeBlob should reject overlapping same-zoom ranges");
}

export function runDevTests() {
  const tests = [
    ["tileMath", testTileMath],
    ["lz4 round-trip", testLz4RoundTrip],
    ["blob round-trip", testBlobRoundTrip],
    ["multi-range blob round-trip", testMultiRangeBlobRoundTrip],
    ["writeBlob rejects overlapping ranges", testWriteBlobRejectsOverlappingSameZoomRanges],
  ];
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      fn();
      console.info(`[self-test] ${name}: OK`);
    } catch (err) {
      console.error(`[self-test] ${name}: FAILED`, err);
      failures.push(`${name}: ${err.message}`);
    }
  }
  if (failures.length > 0) {
    const banner = document.createElement("div");
    banner.style.cssText =
      "background:#c0392b;color:#fff;padding:0.5rem 1rem;font:14px monospace;position:sticky;top:0;z-index:1000";
    banner.textContent = `Self-test failure(s): ${failures.join("; ")} - baked output may be unreliable, check console.`;
    document.body.prepend(banner);
  }
  return failures.length === 0;
}
