# Map Tile Baker

Bakes a basemap into the 1-bit `MTLB` tile blob format read by `NicheGraphics::MapTiles`
(`src/graphics/niche/Map/MapTileRenderer.cpp` / `MapTile.h`).

## Web tool (`docs/`)

[`docs/`](docs/) is a static, client-side web app that does the whole job in the browser: draw a
region per zoom level (or use the whole world), preview how it'll render, bake, and download the
`.bin`. No server, no build step, no API key required for the default vector source
([OpenFreeMap](https://openfreemap.org/) - free, keyless, unlimited, OpenMapTiles schema).

**Hosted copy:** https://ixitxachitl.github.io/binary-map-downloader/

To use it locally: serve `docs/` with any static file server (e.g. `npx http-server docs`) and
open `index.html`. To publish your own: enable GitHub Pages for this repo (Settings -> Pages ->
Deploy from a branch -> `main` / `docs`), and the tool will be live at
`https://<user>.github.io/<repo>/`.

Highlights:
- **Per-zoom regions**: each zoom level can be "whole world" or a hand-drawn lat/lon box, instead
  of always baking the entire planet at every zoom.
- **Vector mode** fetches raw OpenMapTiles-schema vector tiles and rasterizes a minimal toner-style
  basemap (solid land, water cutout, roads, admin borders, place labels) directly in-browser -
  see `docs/js/vectorSource.js`. **Raster mode** fetches pre-rendered tile images from any
  `{z}/{x}/{y}` URL template you supply (no bundled provider).
- **Live component preview**: pick a spot/zoom on the map and see exactly how current settings
  (road classes, label classes, threshold, etc.) render before committing to a full bake.
- **Extend an existing blob**: upload a previously-downloaded `.bin` and only the tiles missing
  from it get fetched - also how you resume a bake you stopped partway through.
- **Estimates**: a small sample bake estimates total download size, output size, and time before
  you commit to the full run, then tightens into exact numbers as baking proceeds.

See `docs/vendor/README.md` for the third-party code vendored into the page (Leaflet, pbf,
`@mapbox/vector-tile`, a trimmed `lz4js`) and why nothing is loaded from a CDN at runtime.

This supersedes the original `generate_map_tiles.py` Python CLI, which baked whole zoom levels
only (no per-zoom regions) and required a MapTiler API key; it's still available in git history
if it's ever useful as a reference or for a scripted/CI use case.
