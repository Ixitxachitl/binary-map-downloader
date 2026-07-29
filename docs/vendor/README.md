# Vendored third-party code

Committed as static files (not loaded from a CDN) so the page works without depending on any
third party's uptime at runtime. Each file carries a provenance comment at the top; summary:

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `leaflet.js`, `leaflet.css` | leaflet | 1.9.4 | BSD-2-Clause | https://unpkg.com/leaflet@1.9.4/dist/ |
| `pbf.js` | pbf | 5.1.2 | BSD-3-Clause | https://unpkg.com/pbf@5.1.2/index.js |
| `vector-tile.js` | @mapbox/vector-tile | 3.0.0 | BSD-3-Clause | https://unpkg.com/@mapbox/vector-tile@3.0.0/index.js |
| `point-geometry.js` | @mapbox/point-geometry | 1.1.0 | ISC | https://unpkg.com/@mapbox/point-geometry@1.1.0/index.js |
| `lz4-block.js` | lz4js (trimmed) | 0.2.0 | ISC | https://unpkg.com/lz4js@0.2.0/lz4.js |

`pbf.js`, `vector-tile.js`, `point-geometry.js` are unmodified except import-path fixes
(`@mapbox/point-geometry` -> `./point-geometry.js`) since they ship as native ES modules already.

`lz4-block.js` is NOT a verbatim copy: only `compressBlock`/`decompressBlock` (the raw LZ4 block
codec, no frame/checksum wrapper) were kept, converted to ES module syntax, and one upstream bug
was fixed - see the comment above `compressBlock` in that file for details (the original's
"nothing encoded" early-return check misfires on non-empty, low-redundancy input when `sIndex`
is 0, which is always true for our one-block-per-tile usage).

Leaflet is loaded as a classic `<script>` (not a module) and used via the `window.L` global,
matching how it's normally distributed.
