// Leaflet-based region picker: drag out a rectangle per zoom row (or leave it "whole world"),
// plus a click-to-place marker for the live-preview location. Implemented directly against
// Leaflet's own mouse events (mousedown/mousemove/mouseup already give latLng, no pixel math
// needed) rather than pulling in the separate Leaflet.draw plugin for just rectangles.
/* global L */

const ROW_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#009688", "#f032e6", "#bcf60c"];

export function createRegionPicker(containerId, { onRowRegionChange, onPreviewLocationChange } = {}) {
  const map = L.map(containerId, { worldCopyJump: false }).setView([20, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      "(backdrop for drawing regions only - not part of the bake itself)",
    maxZoom: 19,
  }).addTo(map);

  const rowLayers = new Map(); // rowId -> L.Rectangle
  let colorIndex = 0;
  const rowColorAssignment = new Map();

  function colorFor(rowId) {
    if (!rowColorAssignment.has(rowId)) {
      rowColorAssignment.set(rowId, ROW_COLORS[colorIndex % ROW_COLORS.length]);
      colorIndex++;
    }
    return rowColorAssignment.get(rowId);
  }

  let drawing = null; // { rowId, startLatLng }
  let pickingPreview = false;
  let previewMarker = null;

  function updateRect(rowId, bounds) {
    let rect = rowLayers.get(rowId);
    if (!rect) {
      rect = L.rectangle(bounds, { color: colorFor(rowId), weight: 2, fillOpacity: 0.12 }).addTo(map);
      rowLayers.set(rowId, rect);
    } else {
      rect.setBounds(bounds);
    }
  }

  function boundsToRegion(bounds) {
    return {
      whole: false,
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
    };
  }

  map.on("mousedown", (e) => {
    if (!drawing) return;
    drawing.startLatLng = e.latlng;
  });
  map.on("mousemove", (e) => {
    if (!drawing?.startLatLng) return;
    updateRect(drawing.rowId, L.latLngBounds(drawing.startLatLng, e.latlng));
  });
  map.on("mouseup", (e) => {
    if (!drawing?.startLatLng) return;
    const bounds = L.latLngBounds(drawing.startLatLng, e.latlng);
    updateRect(drawing.rowId, bounds);
    const rowId = drawing.rowId;
    drawing = null;
    map.dragging.enable();
    map.getContainer().style.cursor = "";
    onRowRegionChange?.(rowId, boundsToRegion(bounds));
  });
  map.on("click", (e) => {
    if (drawing || !pickingPreview) return;
    if (!previewMarker) {
      previewMarker = L.circleMarker(e.latlng, {
        radius: 6,
        color: "#000",
        weight: 1,
        fillColor: "#ffdd00",
        fillOpacity: 1,
      }).addTo(map);
    } else {
      previewMarker.setLatLng(e.latlng);
    }
    onPreviewLocationChange?.(e.latlng.lat, e.latlng.lng);
  });

  return {
    map,
    beginDraw(rowId) {
      drawing = { rowId, startLatLng: null };
      map.dragging.disable();
      map.getContainer().style.cursor = "crosshair";
    },
    cancelDraw() {
      drawing = null;
      map.dragging.enable();
      map.getContainer().style.cursor = "";
    },
    setRowWhole(rowId) {
      const rect = rowLayers.get(rowId);
      if (rect) {
        map.removeLayer(rect);
        rowLayers.delete(rowId);
      }
    },
    /** Sets rowId's rectangle to match region directly (region.whole removes it) - used to
     * propagate a drawn region to other rows linked with the one actually being dragged. */
    setRowRegion(rowId, region) {
      if (!region || region.whole) {
        this.setRowWhole(rowId);
        return;
      }
      updateRect(rowId, L.latLngBounds([region.south, region.west], [region.north, region.east]));
    },
    removeRow(rowId) {
      const rect = rowLayers.get(rowId);
      if (rect) {
        map.removeLayer(rect);
        rowLayers.delete(rowId);
      }
      rowColorAssignment.delete(rowId);
    },
    colorFor,
    setPickingPreview(v) {
      pickingPreview = v;
    },
  };
}
