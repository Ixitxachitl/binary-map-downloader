// DOM wiring: config form, per-zoom region rows, live preview, estimate, bake run, report/download.
import { totalPlannedCount, tileXToLon, tileYToLat } from "./tileMath.js";
import { parseBlob, writeBlob, computeZoomRanges } from "./blobFormat.js";
import { runBake, summarizeBake } from "./bake.js";
import {
  runSamplePass,
  extrapolateEstimate,
  countRemainingByZoom,
  formatBytes,
  formatDuration,
} from "./estimate.js";
import { DEFAULT_ROAD_CLASSES, DEFAULT_LABEL_CLASSES } from "./vectorSource.js";
import { resolveOpenFreeMap } from "./tileSource.js";
import { createRegionPicker } from "./regionPicker.js";
import { renderPreview, resetVectorFetcher } from "./previewPanel.js";

const $ = (id) => document.getElementById(id);

// Past this many planned tiles, a bake is realistically infeasible (hours/days of fetching) even
// though counting/estimating that many is now cheap - "Start bake" confirms before proceeding.
const MAX_SANE_BAKE_TILES = 2_000_000;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Declared up front (before the picker/DOM wiring below that reference them) even though
// refreshEstimate/refreshPreview are only *defined* further down - those are hoisted function
// declarations, but scheduleEstimate/scheduleAutoPreviewRefresh are const bindings, so calling
// them before this line would hit the temporal dead zone rather than just "not defined yet".
const scheduleEstimate = debounce(() => refreshEstimate(), 900);
const scheduleAutoPreviewRefresh = debounce(() => refreshPreview(), 500);

const state = {
  rows: [], // { id, zoom, whole, region, linkGroupId }
  nextRowId: 1,
  nextLinkGroupId: 1,
  existingTiles: null,
  previewLocation: null, // { lat, lon }
};

function rowById(id) {
  return state.rows.find((r) => r.id === id);
}

/** A "group" of one row isn't a link - clean it up when a row leaves (or is removed from) a
 * group and only one member is left. */
function dissolveIfSingleton(groupId) {
  if (groupId == null) return;
  const members = state.rows.filter((r) => r.linkGroupId === groupId);
  if (members.length === 1) members[0].linkGroupId = null;
}

function applyRegionToRowDom(row, region) {
  const el = document.querySelector(`.zoom-row[data-id="${row.id}"]`);
  if (!el) return;
  el.querySelector(".whole-cb").checked = !!region.whole;
  el.querySelector(".bbox-readout").textContent = regionLabel(region);
}

function setRowRegionEverywhere(row, region) {
  row.whole = !!region.whole;
  row.region = region.whole ? null : region;
  picker.setRowRegion(row.id, region);
  applyRegionToRowDom(row, region);
}

/** Applies region to row - and, if row is linked, to every other row sharing its link group,
 * so linked rows always show the same rectangle on the map and bake the same area. */
function propagateRegion(row, region) {
  if (row.linkGroupId != null) {
    for (const r of state.rows) {
      if (r.linkGroupId === row.linkGroupId) setRowRegionEverywhere(r, region);
    }
  } else {
    setRowRegionEverywhere(row, region);
  }
  scheduleEstimate();
  scheduleAutoPreviewRefresh();
}

function linkOptionsHtml(row) {
  let html = '<option value="">Not linked</option>';
  for (const other of state.rows) {
    if (other.id === row.id) continue;
    const selected = row.linkGroupId != null && row.linkGroupId === other.linkGroupId ? "selected" : "";
    html += `<option value="${other.id}" ${selected}>Link with z${other.zoom}</option>`;
  }
  return html;
}

/** Rebuilds every row's link <select> - call whenever rows are added/removed/renumbered or
 * link membership changes, since the option list and labels depend on all of that. */
function refreshLinkSelects() {
  for (const row of state.rows) {
    const sel = document.querySelector(`.zoom-row[data-id="${row.id}"] .link-select`);
    if (sel) sel.innerHTML = linkOptionsHtml(row);
  }
}

function buildCheckboxGrid(container, options, defaults) {
  container.innerHTML = "";
  for (const opt of options) {
    const id = `cb_${container.id}_${opt}`;
    const wrap = document.createElement("label");
    wrap.className = "inline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.value = opt;
    cb.checked = defaults.has(opt);
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(opt));
    container.appendChild(wrap);
  }
}

function checkedValues(container) {
  return new Set(
    [...container.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => c.value),
  );
}

// Every current Map-capable target uses 512px tiles (MapTiler's native fetch resolution) - see
// generate_map_tiles.py's --tile-size / the firmware's kTileSizePx. Not exposed as a setting.
const TILE_SIZE = 512;

function buildConfig() {
  const mode = $("modeSelect").value;
  return {
    mode,
    tileSize: TILE_SIZE,
    workers: Number($("workers").value) || 1,
    maxConsecutiveFailures: Number($("maxFailures").value) || 10,
    rows: state.rows.map((r) => ({ zoom: r.zoom, region: r.whole ? { whole: true } : r.region || { whole: true } })),
    existingTiles: state.existingTiles,
    raster: {
      urlTemplate: $("rasterUrlTemplate").value.trim(),
      threshold: Number($("rasterThreshold").value),
      invert: $("rasterInvert").checked,
    },
    vector: {
      urlTemplate: $("vectorUrlTemplate").value.trim(),
      sourceMaxzoom: Number($("vectorSourceMaxzoom").value) || 14,
      roadClasses: checkedValues($("roadClassesGrid")),
      roadMinzoom: Number($("roadMinzoom").value) || 0,
      boundaryMaxAdminLevel: Number($("boundaryMaxAdminLevel").value) || 10,
      labelClasses: checkedValues($("labelClassesGrid")),
      lineWidth: Number($("vectorLineWidth").value) || 1,
      waterFill: $("waterFill").checked,
    },
  };
}

// --- Region picker + zoom rows -------------------------------------------------

const picker = createRegionPicker("regionMap", {
  onRowRegionChange(rowId, region) {
    const row = rowById(rowId);
    if (!row) return;
    propagateRegion(row, region);
  },
  onPreviewLocationChange(lat, lon) {
    state.previewLocation = { lat, lon };
    $("pickPreviewBtn").textContent = "Pick preview spot on map";
    picker.setPickingPreview(false);
    refreshPreview();
  },
});

function regionLabel(region) {
  if (!region || region.whole) return "whole world";
  return `N${region.north.toFixed(2)} S${region.south.toFixed(2)} E${region.east.toFixed(2)} W${region.west.toFixed(2)}`;
}

function renderRow(row) {
  const el = document.createElement("div");
  el.className = "zoom-row";
  el.dataset.id = String(row.id);
  el.innerHTML = `
    <input type="number" class="zoom-input" min="0" max="22" value="${row.zoom}" />
    <span class="bbox-readout"><span class="swatch" style="background:${picker.colorFor(row.id)}"></span>${regionLabel(row.whole ? { whole: true } : row.region)}</span>
    <label class="inline"><input type="checkbox" class="whole-cb" ${row.whole ? "checked" : ""} /> whole world</label>
    <select class="link-select" title="Share this row's region with another zoom level"></select>
    <button class="small draw-btn" type="button">Draw</button>
    <button class="small danger remove-btn" type="button">x</button>
  `;
  el.querySelector(".zoom-input").addEventListener("change", (e) => {
    row.zoom = Math.max(0, Math.min(22, Number(e.target.value) || 0));
    refreshLinkSelects();
    scheduleEstimate();
  });
  el.querySelector(".whole-cb").addEventListener("change", (e) => {
    const region = e.target.checked ? { whole: true } : row.region || { whole: true };
    propagateRegion(row, region);
  });
  el.querySelector(".link-select").addEventListener("change", (e) => {
    const val = e.target.value;
    const oldGroup = row.linkGroupId;
    if (val === "") {
      row.linkGroupId = null;
      dissolveIfSingleton(oldGroup);
    } else {
      const target = rowById(Number(val));
      if (!target) return;
      if (target.linkGroupId == null) target.linkGroupId = state.nextLinkGroupId++;
      row.linkGroupId = target.linkGroupId;
      dissolveIfSingleton(oldGroup);
      // Adopt the group's existing shared region so linking immediately shows one rectangle.
      propagateRegion(row, target.whole ? { whole: true } : target.region || { whole: true });
    }
    refreshLinkSelects();
    scheduleEstimate();
  });
  el.querySelector(".draw-btn").addEventListener("click", () => picker.beginDraw(row.id));
  el.querySelector(".remove-btn").addEventListener("click", () => {
    const oldGroup = row.linkGroupId;
    picker.removeRow(row.id);
    state.rows = state.rows.filter((r) => r.id !== row.id);
    el.remove();
    dissolveIfSingleton(oldGroup);
    refreshLinkSelects();
    scheduleEstimate();
  });
  $("zoomRows").appendChild(el);
  refreshLinkSelects();
}

$("addRowBtn").addEventListener("click", () => {
  const row = {
    id: state.nextRowId++,
    zoom: state.rows.length === 0 ? 0 : state.rows[state.rows.length - 1].zoom + 1,
    whole: true,
    region: null,
    linkGroupId: null,
  };
  state.rows.push(row);
  renderRow(row);
  scheduleEstimate();
});

// Seed with one default row (zoom 0, whole world) so the tool isn't empty on load.
$("addRowBtn").click();

function removeAllRows() {
  for (const row of state.rows) picker.removeRow(row.id);
  state.rows = [];
  $("zoomRows").innerHTML = "";
}

/** True if the row list is still exactly the untouched seed row - safe to replace without asking. */
function rowsAreUntouchedDefault() {
  return (
    state.rows.length === 1 &&
    state.rows[0].zoom === 0 &&
    state.rows[0].whole === true &&
    state.rows[0].linkGroupId == null
  );
}

/** Converts a zoom-range's tile rectangle back to a lat/lon region - the inverse of
 * tileMath.tileRangeForRegion. tileXToLon(tx,z)/tileYToLat(ty,z) give a tile's west/north edge
 * respectively, so the region's east/south edges come from one tile past xMax/yMax. */
function regionFromZoomRange(r) {
  const n = 2 ** r.zoom;
  const xMax = r.xMin + r.width - 1;
  const yMax = r.yMin + r.height - 1;
  if (r.xMin === 0 && r.yMin === 0 && r.width === n && r.height === n) {
    return { whole: true };
  }
  return {
    whole: false,
    north: tileYToLat(r.yMin, r.zoom),
    south: tileYToLat(yMax + 1, r.zoom),
    west: tileXToLon(r.xMin, r.zoom),
    east: tileXToLon(xMax + 1, r.zoom),
  };
}

/** Replaces the zoom-row list with one row per zoom level present in `tiles` (an uploaded blob's
 * parsed tiles), region set to match that zoom's actual coverage - so uploading a blob to extend
 * shows what's already baked instead of leaving the row list unrelated to the file. */
function populateRowsFromTiles(tiles) {
  removeAllRows();
  for (const r of computeZoomRanges(tiles)) {
    const region = regionFromZoomRange(r);
    const row = {
      id: state.nextRowId++,
      zoom: r.zoom,
      whole: region.whole,
      region: region.whole ? null : region,
      linkGroupId: null,
    };
    state.rows.push(row);
    renderRow(row);
    if (!region.whole) picker.setRowRegion(row.id, region);
  }
}

// --- Mode / source fields --------------------------------------------------

function applyMode() {
  const mode = $("modeSelect").value;
  $("vectorFields").style.display = mode === "vector" ? "" : "none";
  $("rasterFields").style.display = mode === "raster" ? "" : "none";
  scheduleEstimate();
  scheduleAutoPreviewRefresh();
}
$("modeSelect").addEventListener("change", applyMode);

buildCheckboxGrid($("roadClassesGrid"), [
  "motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "pier",
], DEFAULT_ROAD_CLASSES);
buildCheckboxGrid($("labelClassesGrid"), [
  "continent", "country", "state", "province", "city", "town", "village",
], DEFAULT_LABEL_CLASSES);

for (const id of ["roadClassesGrid", "labelClassesGrid"]) {
  $(id).addEventListener("change", () => {
    scheduleEstimate();
    scheduleAutoPreviewRefresh();
  });
}
for (const id of [
  "vectorSourceMaxzoom", "vectorLineWidth", "roadMinzoom", "boundaryMaxAdminLevel", "waterFill",
  "rasterThreshold", "rasterInvert",
]) {
  $(id).addEventListener("input", () => {
    if (id === "rasterThreshold") $("rasterThresholdValue").textContent = $("rasterThreshold").value;
    scheduleEstimate();
    scheduleAutoPreviewRefresh();
  });
}
for (const id of ["vectorUrlTemplate", "rasterUrlTemplate"]) {
  $(id).addEventListener("change", () => {
    resetVectorFetcher();
    scheduleEstimate();
    scheduleAutoPreviewRefresh();
  });
}

resolveOpenFreeMap().then(({ urlTemplate, maxzoom }) => {
  $("vectorUrlTemplate").value = urlTemplate;
  $("vectorSourceMaxzoom").value = maxzoom;
  applyMode();
});

// --- Preview ----------------------------------------------------------------

$("pickPreviewBtn").addEventListener("click", () => {
  picker.setPickingPreview(true);
  $("pickPreviewBtn").textContent = "Click the map...";
});
$("previewZoom").addEventListener("change", refreshPreview);

function refreshPreview() {
  if (!state.previewLocation) return;
  const config = buildConfig();
  renderPreview(config, state.previewLocation.lat, state.previewLocation.lon, Number($("previewZoom").value), {
    rawCanvas: $("previewRawCanvas"),
    thresholdCanvas: $("previewThresholdCanvas"),
    statusEl: $("previewStatus"),
  });
}

// --- Estimate -----------------------------------------------------------------

let estimateGeneration = 0;
async function refreshEstimate() {
  const generation = ++estimateGeneration;
  const config = buildConfig();
  // O(1) math (tileCountForRegion), never enumerates a tile grid - a "whole world" row at a high
  // zoom is billions of tiles, and actually listing them out (as an earlier version of this did)
  // is exactly what was hanging/crashing the page.
  const plannedCount = totalPlannedCount(config.rows);
  $("estPlanned").textContent = plannedCount.toLocaleString();
  $("estWarning").textContent =
    plannedCount > MAX_SANE_BAKE_TILES
      ? `That's ${plannedCount.toLocaleString()} tiles - probably too many to actually bake (narrow the region or lower the zoom). "Start bake" will ask you to confirm.`
      : "";
  if (plannedCount === 0) {
    $("estDownload").textContent = "-";
    $("estOutput").textContent = "-";
    $("estTime").textContent = "-";
    return;
  }
  if ((config.mode === "raster" && !config.raster.urlTemplate) || (config.mode === "vector" && !config.vector.urlTemplate)) {
    return; // nothing to sample against yet
  }

  const sample = await runSamplePass(config).catch(() => null);
  if (generation !== estimateGeneration) return; // a newer request superseded this one
  if (!sample) {
    $("estDownload").textContent = "everything already covered by the uploaded blob";
    $("estOutput").textContent = "-";
    $("estTime").textContent = "-";
    return;
  }
  const remainingByZoom = countRemainingByZoom(config.rows, config.existingTiles);
  const { estDownloadBytes, estOutputBytes, estSeconds } = extrapolateEstimate(
    sample.perZoom, sample.bytesPerSec, remainingByZoom, config.workers,
  );
  $("estDownload").textContent = formatBytes(estDownloadBytes);
  $("estOutput").textContent = formatBytes(estOutputBytes);
  $("estTime").textContent = formatDuration(estSeconds);
  $("estNote").textContent = `Based on a ${sample.sampledCount}-tile sample - refines once baking starts.`;
}

// --- Extend existing blob -----------------------------------------------------

$("extendBlobInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseBlob(buf);

    if (
      rowsAreUntouchedDefault() ||
      confirm(
        "Replace the current zoom levels & regions with what's actually in this file? " +
          "(Your in-progress row setup will be cleared - cancel to keep it and just extend from the file's tiles.)",
      )
    ) {
      populateRowsFromTiles(parsed.values());
    }

    state.existingTiles = parsed;
    $("extendBlobStatus").textContent = `Loaded ${parsed.size} tile(s) from '${file.name}' - these will be kept and skipped.`;
    scheduleEstimate();
  } catch (err) {
    $("extendBlobStatus").textContent = `Failed to load '${file.name}': ${err.message || err}`;
    state.existingTiles = null;
  }
});

// --- Bake run ------------------------------------------------------------------

function logLine(text) {
  const log = $("log");
  log.textContent += text + "\n";
  log.scrollTop = log.scrollHeight;
}

let abortController = null;

$("startBakeBtn").addEventListener("click", async () => {
  const config = buildConfig();
  if (config.mode === "raster" && !config.raster.urlTemplate) {
    alert("Enter a raster tile URL template first.");
    return;
  }
  if (config.mode === "vector" && !config.vector.urlTemplate) {
    alert("Enter (or wait for) a vector tile URL template first.");
    return;
  }
  const plannedCount = totalPlannedCount(config.rows);
  if (
    plannedCount > MAX_SANE_BAKE_TILES &&
    !confirm(
      `This plan covers ${plannedCount.toLocaleString()} tiles - likely hours or days to fetch, ` +
        `and more than the tab can comfortably hold in memory once baked. Narrow the region or ` +
        `lower the zoom instead unless you really mean this. Continue anyway?`,
    )
  ) {
    return;
  }

  abortController = new AbortController();
  config.signal = abortController.signal;

  $("startBakeBtn").disabled = true;
  $("stopBakeBtn").disabled = false;
  $("log").textContent = "";
  $("reportPanel").style.display = "none";
  const startedAt = performance.now();

  const result = await runBake(config, {
    onProgress({ done, total, elapsedSec, downloadBytes }) {
      $("bakeProgress").value = total ? done / total : 0;
      $("bakeProgress").max = 1;
      $("progressTiles").textContent = `${done} / ${total}`;
      const tilesPerSec = elapsedSec > 0 ? done / elapsedSec : 0;
      $("progressRate").textContent = `${tilesPerSec.toFixed(1)} tiles/s`;
      $("progressDownloaded").textContent = formatBytes(downloadBytes);

      // Live-tightening estimate: extrapolate remaining work from the running average so far.
      if (done > 0 && done < total) {
        const avgDownloadPerTile = downloadBytes / done;
        const remaining = total - done;
        $("estDownload").textContent = formatBytes(downloadBytes + avgDownloadPerTile * remaining);
        const bytesPerSec = elapsedSec > 0 ? downloadBytes / elapsedSec : 0;
        const remainingSec = bytesPerSec > 0 ? (avgDownloadPerTile * remaining) / bytesPerSec : null;
        $("estTime").textContent = formatDuration(remainingSec);
        $("estNote").textContent = "Live estimate from tiles baked so far.";
      }
    },
    onTileError(coord, err, consecutiveFailures) {
      logLine(`FAILED z${coord[0]}/${coord[1]}/${coord[2]}: ${err?.message || err} (${consecutiveFailures} in a row)`);
    },
  });

  $("startBakeBtn").disabled = false;
  $("stopBakeBtn").disabled = true;
  abortController = null;

  if (result.aborted) logLine(result.abortReason || "Stopped.");
  logLine(`Done: ${result.bakedTotal} / ${result.plannedTotal} tiles baked in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

  showReport(result, config);
});

$("stopBakeBtn").addEventListener("click", () => {
  abortController?.abort();
  $("stopBakeBtn").disabled = true;
});

function showReport(result, config) {
  const { tiles } = result;
  const summary = summarizeBake(tiles, config.tileSize);
  const blobBytes = writeBlob(tiles);
  const blobUrl = URL.createObjectURL(new Blob([blobBytes], { type: "application/octet-stream" }));

  const table = $("reportTable");
  const rows = [
    ["Total tiles", tiles.length],
    ["LZ4-compressed", tiles.filter((t) => t.kind === 0).length],
    ["WHITE (free)", tiles.filter((t) => t.kind === 1).length],
    ["BLACK (free)", tiles.filter((t) => t.kind === 2).length],
    ["Output blob size", formatBytes(blobBytes.length)],
  ];
  for (const z of summary.perZoom) {
    rows.push([`z${z.zoom}`, `${z.count} tiles, ${z.free} free, ${formatBytes(z.payloadBytes)}`]);
  }
  table.innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");

  const filename = $("outputFilename").value.trim() || "world_blob.bin";
  const blobLink = $("downloadBlobLink");
  blobLink.href = blobUrl;
  blobLink.download = filename;

  $("reportPanel").style.display = "";
}
