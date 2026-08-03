// Self-checks run once on page load - correctness here matters more than usual since this feeds
// a firmware decoder with no test harness of its own in this repo. Logs to console; surfaces a
// visible banner only on failure (silent success, loud failure).
import { lonToTileX, latToTileY, tileRangeForRegion, regionFromZoomRange } from "./tileMath.js";
import { writeBlob, parseBlob, coordKey, KIND_LZ4, KIND_WHITE } from "./blobFormat.js";
import { carryForwardRanges } from "./bake.js";
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

/** regionFromZoomRange must be an exact inverse of tileRangeForRegion: an uploaded blob's ranges
 * become UI rows via the former, and bake.js turns those rows straight back into the ranges it
 * writes via the latter, so any drift is written to the output file. The obvious inverse (region
 * edge = tileXToLon(xMax + 1)) is off by one, because that longitude is the *next* tile's west
 * edge and tileRangeForRegion floors it there - every reconstructed region came back a column and
 * a row too big, and two ranges that merely touched inflated into overlapping. Fuzzed rather than
 * spot-checked because latitude's Mercator round-trip fails on specific rectangles, not all. */
function testRegionRangeRoundTrip() {
  // Deterministic LCG - a fixed seed keeps a failure reproducible from the console message alone.
  let seed = 20260803;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let z = 0; z <= 18; z++) {
    const n = 2 ** z;
    for (let i = 0; i < 200; i++) {
      const w = 1 + rnd(Math.min(n, 8));
      const h = 1 + rnd(Math.min(n, 8));
      const range = { zoom: z, xMin: rnd(n - w + 1), yMin: rnd(n - h + 1), width: w, height: h };
      const { xMin, xMax, yMin, yMax } = tileRangeForRegion(z, regionFromZoomRange(range));
      assert(
        xMin === range.xMin &&
          xMax === range.xMin + range.width - 1 &&
          yMin === range.yMin &&
          yMax === range.yMin + range.height - 1,
        `range -> region -> range drifted at z${z} ` +
          `[${range.xMin},${range.yMin} ${range.width}x${range.height}] -> [${xMin},${yMin} ${xMax - xMin + 1}x${yMax - yMin + 1}]`,
      );
      checked++;
    }
  }
  assert(checked > 0, "round-trip fuzz didn't actually run");

  // Whole-world ranges take the { whole: true } shortcut and must survive it too.
  for (const z of [0, 1, 5, 10]) {
    const n = 2 ** z;
    const whole = { zoom: z, xMin: 0, yMin: 0, width: n, height: n };
    const { xMin, xMax, yMin, yMax } = tileRangeForRegion(z, regionFromZoomRange(whole));
    assert(xMin === 0 && yMin === 0 && xMax === n - 1 && yMax === n - 1, `whole-world round-trip failed at z${z}`);
  }
}

/** Two ranges that merely touch (share an edge, no shared tile) must stay non-overlapping through
 * the round-trip - this is the concrete symptom the off-by-one caused: uploading a valid two-region
 * blob and changing nothing got the next bake refused for "rows overlap". */
function testTouchingRangesStayDisjoint() {
  const left = { zoom: 10, xMin: 100, yMin: 100, width: 5, height: 5 };
  const right = { zoom: 10, xMin: 105, yMin: 100, width: 5, height: 5 };
  const a = tileRangeForRegion(10, regionFromZoomRange(left));
  const b = tileRangeForRegion(10, regionFromZoomRange(right));
  assert(a.xMax < b.xMin, `touching ranges overlapped after round-trip: ${a.xMax} >= ${b.xMin}`);
}

/** Extending a blob must keep every region the current rows aren't redoing. Matching on zoom
 * alone dropped an uploaded region as soon as any row shared its zoom, so baking a second city
 * at a zoom you'd already baked elsewhere silently threw the first one away. */
function testCarryForwardKeepsDisjointRangesAtTheSameZoom() {
  const ny = { zoom: 10, xMin: 300, yMin: 384, width: 4, height: 3 };
  const la = { zoom: 10, xMin: 176, yMin: 408, width: 3, height: 2 };
  const z8 = { zoom: 8, xMin: 10, yMin: 20, width: 2, height: 2 };

  // A row over LA must not disturb the uploaded NY range at the same zoom.
  const kept = carryForwardRanges([ny, z8], [la]);
  assert(kept.length === 2, `disjoint same-zoom range was dropped (kept ${kept.length} of 2)`);
  assert(kept.some((r) => r.xMin === ny.xMin), "NY range should have been carried forward");
  assert(kept.some((r) => r.zoom === 8), "untouched zoom should have been carried forward");

  // A row over NY itself supersedes it - it's being rebaked, so carrying it too would duplicate.
  assert(carryForwardRanges([ny], [ny]).length === 0, "a row covering a range should supersede it");

  // Same rectangle at a different zoom addresses different tiles entirely.
  assert(carryForwardRanges([ny], [{ ...ny, zoom: 11 }]).length === 1, "different zoom should not supersede");

  // No upload at all is the ordinary first-bake case.
  assert(carryForwardRanges(null, [ny]).length === 0, "null existingRanges should yield nothing");
}

export function runDevTests() {
  const tests = [
    ["tileMath", testTileMath],
    ["lz4 round-trip", testLz4RoundTrip],
    ["blob round-trip", testBlobRoundTrip],
    ["multi-range blob round-trip", testMultiRangeBlobRoundTrip],
    ["writeBlob rejects overlapping ranges", testWriteBlobRejectsOverlappingSameZoomRanges],
    ["range <-> region round-trip", testRegionRangeRoundTrip],
    ["touching ranges stay disjoint", testTouchingRangesStayDisjoint],
    ["carry-forward keeps disjoint same-zoom ranges", testCarryForwardKeepsDisjointRangesAtTheSameZoom],
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
