# Earthy - a KML/KMZ viewer and editor

A lean, cross-platform desktop **KML/KMZ viewer and editor** — a small,
self-hostable alternative for looking at and editing placemarks, paths, and
polygons on a 3D globe.

> ⚠️ **Work in progress.** This is early software (currently `v0.2.0`). Editing
> is functional, but expect rough edges, missing features, and breaking changes.
> There are no stability or data-safety guarantees yet — keep backups of any KML
> you care about.

## About this project (please read)

This project is **100% "vibe-coded."** The human author does **not** speak
JavaScript/TypeScript fluently and drove the whole thing conversationally with an
AI coding assistant (Claude Opus and Fable). That means:

- The code may not follow idiomatic JS/TS conventions in places.
- Architectural decisions were made pragmatically, not always from deep
  ecosystem expertise.
- Review it with that context in mind before relying on it, and please be kind
  (but specific!) in any feedback or issues.

It works and it's tested, but it's a hobby/learning artifact first.

## What it does (so far)

- Open and view KML/KMZ files (round-trip faithful save — it tries hard not to
  drop anything it doesn't understand).
- Draw and edit points, lines, and polygons directly on the globe, including
  freehand **Shift-drag** sketching and square vertex handles.
- A layer tree with multi-select, drag-to-reorder, folders, visibility toggles,
  and right-click menus.
- Restyle features or whole folders — a single uniform style, or colour-by-field
  categorization (like the import flow).
- Edit names and descriptions; per-feature balloons.
- Import other vector formats (via GDAL) with categorized styling.
- **Import rasters** (GeoTIFF and friends). Small ones drape as a single image
  embedded in the file; large ones can be tiled into a zoom pyramid instead of
  being scaled down — saved as a KML super-overlay, so a tiled raster stays
  portable and opens in Google Earth at full detail. Long imports show progress
  and can be cancelled.
- **Optional 3D terrain** — real relief toggled live from the Terrain menu.
  AWS Terrarium tiles are built in and keyless, with decode-time repair of the
  source's coastal defects and optional sea-floor rendering; with a free
  [Cesium ion](https://ion.cesium.com) token, Cesium World Terrain (with its
  water mask) and Cesium World Bathymetry stream instead. Vector features
  drape onto the relief, and the cursor readout reports elevation both as
  height above mean sea level and above the ellipsoid, using a bundled EGM96
  geoid grid.
- **Optional coastline mask** — download GSHHG coastline polygons once (Terrain
  menu) and the ocean is clipped to sea level even where the elevation data
  disagrees with the real coast.
- Undo/redo throughout, keyboard shortcuts, and a stack of basemaps: Esri and
  OpenStreetMap keyless; ion satellite (Google), Sentinel-2, NASA's Earth at
  Night, and Google Photorealistic 3D with an ion token; Google Hybrid /
  Roadmap / Terrain with a Google Maps key.

## API keys (all optional)

Everything works keyless (Esri imagery + AWS terrain). Two keys unlock more:

- `EARTHY_ION_TOKEN` — a [Cesium ion](https://ion.cesium.com) access token
  (free Community tier). Unlocks Cesium World Terrain, World Bathymetry (add it
  to your ion assets from the Asset Depot first), and the ion basemaps.
- `EARTHY_GOOGLE_MAPS_API_KEY` — a Google Maps Platform key with the Map Tiles
  API enabled. Unlocks the Google Hybrid / Roadmap / Terrain basemaps.

Set them either as environment variables (a shell export or an `.envrc`, which
is what `npm run dev` picks up) or in Earthy's own keys file — **File ▸ API
Keys…** opens it, with the names commented in place. The file matters for an
installed app: launched from Finder or the Dock it inherits no shell
environment, so `.envrc` never reaches it. Environment variables win over the
file, and both are read at launch, so restart after changing either.

## Built with

Earthy stands entirely on the shoulders of these projects — huge thanks to their
authors and communities:

- **[CesiumJS](https://cesium.com/cesiumjs/)** — the 3D globe and geospatial
  rendering engine.
- **[GDAL](https://gdal.org/) via [gdal3.js](https://gdal3.js.org)** — vector
  format reading/conversion (GDAL + [PROJ](https://proj.org) +
  [GEOS](https://libgeos.org), compiled to WebAssembly).
- **[Electron](https://www.electronjs.org)** — the cross-platform desktop shell.
- **[React](https://react.dev)** — the user interface.
- **[react-arborist](https://github.com/brimdata/react-arborist)** — the layer
  tree.
- **[Zustand](https://github.com/pmndrs/zustand)** — state management.
- **[@xmldom/xmldom](https://github.com/xmldom/xmldom)** — KML/XML parsing and
  serialization.
- **[JSZip](https://stuk.github.io/jszip/)** — reading/writing KMZ archives.
- **[electron-store](https://github.com/sindresorhus/electron-store)** —
  persistent settings.
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — HTML sanitization (via
  CesiumJS).

Tooling: **[Vite](https://vite.dev)** / **[electron-vite](https://electron-vite.org)**,
**[Vitest](https://vitest.dev)**, **[TypeScript](https://www.typescriptlang.org)**,
and **[ESLint](https://eslint.org)**.

## Development

```bash
npm install
npm run dev        # launch the app in dev mode
npm test           # run the test suite
npm run build      # build for production
npm run make       # build a distributable (macOS dmg, see electron-builder.yml)
```

`npm run make` writes a `.dmg` to `release/`; drag Earthy to Applications and
it launches from Finder like any other app. It is a snapshot of the code at
build time — re-run `npm run make` to pick up later changes — and it reads its
keys from the keys file above rather than from your shell.

## License

Earthy's own source code is licensed under the **PolyForm Noncommercial License
1.0.0** — free for noncommercial use. See [LICENSE](./LICENSE).

Note: this is a _source-available, noncommercial_ license, **not** an
OSI-approved "open source" license (open source licenses can't restrict
commercial use).

Earthy bundles third-party components that remain under their own licenses (MIT,
Apache-2.0, and LGPL-2.1 for the GDAL/GEOS stack). Those licenses are **not**
changed by Earthy's license. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

_Not legal advice — if you plan to redistribute, review the licensing yourself._
