// Retrying fetch + a small bounded-concurrency worker pool. Mirrors fetch_url_bytes() and the
// ThreadPoolExecutor/as_completed loop in generate_map_tiles.py, adapted to fetch()/Promises.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches url as raw bytes, retrying transient failures with linear backoff (0.5s * attempt). */
export async function fetchTileBytes(url, { retries = 3, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastErr = err;
      if (attempt < retries - 1) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastErr}`);
}

/**
 * Runs worker(item) over items with up to `concurrency` in flight at once, calling
 * onResult(item, result, error) as each one settles - the Promise-based equivalent of
 * ThreadPoolExecutor + as_completed. shouldAbort() is checked before each new dispatch (not
 * mid-flight) so an abort/stop request stops launching new work without cancelling anything
 * already in progress.
 */
export async function runPool(items, concurrency, worker, onResult, shouldAbort) {
  let next = 0;

  async function runOne() {
    while (next < items.length) {
      if (shouldAbort && shouldAbort()) return;
      const item = items[next++];
      try {
        const result = await worker(item);
        onResult(item, result, null);
      } catch (err) {
        onResult(item, null, err);
      }
    }
  }

  const runnerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: runnerCount }, runOne));
}
