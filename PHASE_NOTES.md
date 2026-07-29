# Phase Notes

## Phase 0 — Scaffold ✅

- **Stack:** Electron 33 + electron-vite + React 18 + TypeScript (strict) + CesiumJS 1.124.
- Dropped `"type": "module"` so main/preload build as CommonJS (avoids ESM preload/`__dirname` friction); pinned `electron-store` to v8 (CJS). Renderer stays ESM via Vite.
- **Cesium asset handling** (the classic failure point): `vite-plugin-cesium` does **not** wire up correctly under electron-vite's renderer build (assets not copied, `CESIUM_BASE_URL` unset). Replaced it with an explicit approach:
  - `vite-plugin-static-copy` copies `Assets/ThirdParty/Widgets/Workers` → `out/renderer/cesium` (absolute `src` paths, since static-copy resolves against the renderer root `src/renderer`).
  - `src/renderer/src/cesium-base.ts` sets `window.CESIUM_BASE_URL = './cesium'` and is imported **first** in `main.tsx`. `./cesium` is relative so it works in both dev server and packaged `file://`.
  - Trade-off: Cesium now fully bundles into the renderer chunk (~9.5 MB). Fine for a local desktop app; can code-split later if startup suffers.
- **Boot verified** headlessly via an opt-in smoke hook (`NGE_SMOKE=<ms>`, optional `NGE_SMOKE_KML=<path>`) that pipes renderer console/errors to stdout and auto-quits.

## Phase 1 — KML model + viewer ✅

### Model (`src/renderer/src/model/`)
- Custom round-trip-faithful parser/serializer (NOT Cesium's lossy `KmlDataSource`, per PLAN §4).
- **Round-trip strategy:** anything unmodeled is preserved as raw XML (`unknownChildren`) or raw attributes (`attrs`) and re-emitted verbatim. Raw blocks are captured via `serializeStripped` (whitespace-only text nodes removed) so the serializer's re-indentation is a **fixed point** — proven by idempotency tests.
- Colors centralized in `colors.ts` (aabbggrr ↔ rgba) — the classic KML bug source, fully unit-tested.
- Style resolver follows `styleUrl` → shared `Style`/`StyleMap` (normal pair) merged with inline style; inline wins per sub-style; undefined never clobbers inherited values.

### Renderer (`src/renderer/src/{globe,ui,state}/`)
- `GlobeRenderer` owns a lean Cesium `Viewer` (every non-essential widget disabled).
- **Performance architecture (PLAN §5.1) built in from day one:** batched primitives — one `Primitive` (PerInstanceColorAppearance) for all polygon fills with per-instance `show` attributes; `PolylineCollection` for lines + polygon outlines; `PointPrimitiveCollection`/`BillboardCollection`/`LabelCollection` for points. Visibility toggles flip `show` without a rebuild.
- Pick → tree selection + balloon; tree double-click → `flyTo` (per-node bounding spheres); ancestor-aware visibility.
- Basemap switcher: Esri World Imagery, OSM, Google (satellite/roadmap/terrain via session tokens), custom XYZ.
- Description balloon renders untrusted KML HTML in a `sandbox=""` iframe (no scripts); KMZ-relative image hrefs rewritten to embedded data URLs.
- `KmlDocument` held **outside** React (mutable, 50k-node capable); zustand store holds only view state + a `revision` counter.

### Main (`src/main/`)
- Typed IPC via preload `contextBridge`. Open/Save KML + KMZ (jszip; KMZ resources surfaced as data URLs). Google session management. Settings + recent files via electron-store. macOS `open-file` + argv file-association handling. Native drag-drop via `webUtils.getPathForFile`.

## Verification results

| Check | Result |
|---|---|
| `vitest` (26 tests: colors, round-trip idempotency, model stability, style resolver, perf) | ✅ all pass |
| Typecheck (web + node, strict) | ✅ clean |
| Production build + Cesium assets copied | ✅ |
| Headless boot | ✅ renderer loads, **WebGL2: yes** (GPU confirmed, D2) |
| Load 10k-polygon KML | ✅ scene built in ~490 ms (target < 5 s, R5) |
| Parse+serialize 10k polygons | ✅ ~200 ms / ~17 ms |
| Google Map Tiles imagery (R4) | ✅ `createSession` 200 + real satellite tile fetched (256×256 JPEG) |

## Known issues / follow-ups

1. **Google imagery requires a billing-enabled Cloud project.** First key (ASU org project) had no billing → `createSession` returned `404 NOT_FOUND` and all Maps APIs were denied. Resolved by switching to a personal project with billing enabled; verified end to end (session token + real tile fetch). Note for reproducers: Maps Platform needs a billing account attached even for the free tier ($200/mo credit + 100k free tiles/mo covers personal use). Esri + OSM need no key.
2. **Interactive pan FPS** (30 fps target) not measured headlessly — needs a real GUI session. WebGL2 + batched primitives make it very likely; verify manually with `npm run dev`.
3. Raw preserved blocks gain a redundant `xmlns="…"` (xmldom adds it when serializing standalone). Semantically identical and idempotent, but slightly noisy output. Could strip redundant default-namespace decls as a polish item.
4. Coordinates are normalized on save (`-122.0` → `-122`) via `Number` round-tripping. Semantically identical; note if exact string fidelity of coordinates ever matters.
5. Shared styles nested inside sub-folders (not the Document) are registered for the resolver but preserved verbatim in place — fine for viewing; Phase 2's style-write path will formalize this.

## Phase 2 — Editing core ✅

The reason the app exists: bulk style editing + native folder management.

### Model
- **Shared-style refactor (prerequisite):** shared `Style`/`StyleMap` now live in the model (`node.styles`, same object referenced by the resolver map) instead of raw XML, so edits actually serialize. Round-trip tests still green, output is cleaner (no redundant `xmlns` on styles).
- **Mutation + undo/redo API** on `KmlDocument`: `move` (multi-node, guards against moving into own descendant), `rename`, `createFolder`, `delete`, `setVisibility`, `cut`/`copy`/`paste` (deep clone, fresh ids). Snapshot-based inverse for structural edits, property-inverse for renames/visibility. 200-entry undo stack. O(1) `parentOf` via a parent map.
- **Bulk `applyStyle`** (`bulkStyle.ts`, PLAN §4.3): selection → descendant placemarks filtered by geometry kind → patch the shared style **in place** when all its users are selected (keeps the file lean — one `<Style>` updated), else **fork** a new shared style for the subset and clear redundant inline. GC of orphaned forks on undo. Precise inverse; redo re-mints ids without leaking.

### UI
- **Tree** (react-arborist): multi-select (shift/cmd), drag-drop move wired to `doc.move`, inline rename, right-click context menu (New Folder / Rename / Cut / Copy / Paste / Delete), keyboard (Delete, Cmd+C/X/V). Height auto-measured via ResizeObserver so it shares the sidebar with the style panel.
- **Style panel:** point/line/polygon sections shown by what's in the selection; color + opacity + width + icon scale + preset icons + fill/outline toggles; **indeterminate state** on mixed values; staged edits → one Apply → one undoable bulk op.
- Undo/redo wired to the Edit menu (Cmd+Z / Shift+Cmd+Z).

### Main
- **Unsaved-changes guard:** renderer reports dirty via IPC; main intercepts window close with a Discard/Cancel dialog.
- **External-file watcher:** `fs.watch` on the open file (self-writes suppressed for 1.5 s); on external change, renderer offers reload (warns if there are unsaved edits).

### Phase 2 verification

| Check | Result |
|---|---|
| Model tests (11 new: create/rename/move/delete/copy-paste, bulk-style patch/fork/undo/redo) | ✅ 37 total pass |
| Bulk style on 5,000 features | ✅ ~4 ms, **one shared style**, value applied |
| Multi-node move reflected after save | ✅ |
| Undo/redo/undo cycle leaks no styles | ✅ |
| Typecheck (web + node) + production build | ✅ |
| Boot with full editing UI, load file | ✅ no runtime errors |

**Not verified headlessly:** live drag-drop and style-panel DOM interactions (need a GUI session or Playwright). Model logic beneath them is unit-tested. Verify manually with `npm run dev`.

## Phase 2 fixes (post-review on real data)

Testing against a real 9.7 MB survey KML (`hawaii_may26_campaign.kml`, Schema + BalloonStyle + SchemaData, 191 placemarks) surfaced three issues, all fixed:

1. **SchemaData/BalloonStyle balloons.** Balloons showed nothing for features whose attributes live in `<ExtendedData><SchemaData>` with a `<BalloonStyle>` `$[schema/field]` template (no `<description>`). Now: ExtendedData parsed into name/value fields; BalloonStyle `<text>` extracted (display-only, `raw` still round-trips); `resolveBalloonHtml` substitutes `$[name]`/`$[description]`/`$[field]`/`$[schema/field]` entities (HTML-escaped), with a default attribute table fallback. `model/balloon.ts` + tests.
2. **Polygon interiors not pickable.** These are 2D `clampToGround` polygons (KML default) rendered flat at height 0 — coplanar with the globe ellipsoid, so `scene.pick` lost the depth test to the globe and returned no feature for interior pixels (only the outline polyline picked). Fix: render the batched polygon fill as a **`GroundPrimitive`**, which drapes on the globe surface via classification and is reliably pickable in its interior. (Also fixes z-fighting.)
3. **Drag-drop depth.** The drop indicator sat ~16 px left of the checkbox column (rows have a twisty before the checkbox), so "into folder" looked like "sibling." Custom `renderCursor` aligns the line to the checkbox column at the target depth (`left = level×indent`, checkbox at `+16`), and indent widened 16→22 px so horizontal level selection is controllable. **Partial vs Google Earth:** react-arborist's `computeDrop` toggles depth by cursor-X, but only across levels valid at that Y — so end-of-subtree / above-folder gaps toggle correctly, but the gap *directly below an open folder header* only offers "inside" (positional limitation). Full GE parity would need custom drop logic replacing react-arborist's DnD.

**Two round-trip bugs the real file caught** that synthetic fixtures missed (both fixed, `hawaii` now in the round-trip suite):
- `Writer.raw` re-indented every line of a raw block, so multi-line CDATA (the HTML balloon template) grew indentation each save — broke idempotency. Now indents only the first line.
- `<open>0</open>` (folder collapsed) was dropped on save (only truthy `open` was emitted), losing folder state. Now emitted whenever defined.

## Phase 3 — Creation & geometry editing ✅

Draw and reshape features directly on the globe.

### Model (`document.ts`, `measure.ts`)
- `addPlacemark(parentId, geometry, name)` — undoable; adds under the selected container (or nearest container / root).
- `updateGeometry(nodeId, geometry)` and `setDescription(nodeId, text)` — undoable.
- `measure.ts` — Cesium-free geodesic helpers: haversine line length, spherical polygon area, formatters. Unit-tested.

### Interaction (`globe/DrawTool.ts`, `globe/EditTool.ts`)
- **DrawTool:** click to add vertices with a live rubber-band preview (CallbackProperty entities); double-click or Enter finishes; Esc cancels; a Point finishes on the first click. On finish, builds KML geometry and adds a placemark.
- **EditTool:** draggable vertex handles on the selected feature; midpoint handles to insert a vertex; right-click / Delete to remove; drag the body to move the whole feature. Camera input is suspended during a drag; each gesture commits `updateGeometry` (undoable). The edited feature's static render is hidden while editing and the scene is rebuilt on exit.
- `GlobeRenderer.startDraw/startEdit/cancelTool`; the normal pick handler yields while a tool is active.

### UI
- Toolbar tools: Add point / Draw line / Draw polygon / Edit (enabled only for a single selected placemark) / Measure, with active state and a "Done" affordance.
- Inspector panel (single-placemark selection): edit name + description.
- On-globe mode hint and a measure readout (length, plus area when ≥3 points).
- New geometry commits go through the same undo stack; edits don't rebuild the whole scene mid-gesture (the tool renders its own preview; `bumpMeta`).

### Verification

| Check | Result |
|---|---|
| Model tests (8 new: measurement math, add/update geometry, undo/redo, serialize+reparse) | ✅ 51 total pass |
| Drawn geometry serializes to valid, reparseable KML | ✅ (unit test) |
| Typecheck (web + node) + production build | ✅ |
| Boot with Phase 3 UI | ✅ no runtime errors |

**Not verified headlessly:** the actual pointer interactions (drawing clicks, vertex dragging, midpoint insert). The model + serialization beneath them is unit-tested; drive it manually with `npm run dev`. "Opens identically in Google Earth Pro" (PLAN accept) needs a manual GE check — output is standard KML 2.2 (Point/LineString/Polygon).

## Phase 3 refinements (multi-document + fixes)

- **Multiple open documents.** The workspace now holds `docs: KmlDocument[]` (each with its own path, dirty flag, undo stack). The tree shows every doc's root; the globe renders all docs in one batched scene (node ids are globally unique). Store resolves the target doc per operation (`docOf`, `activeDoc`). Opening a file adds a doc rather than replacing; the app starts with an empty workspace.
- **Delete/close a root.** Deleting a document's root node closes that file (with a confirm if it has unsaved changes) instead of failing.
- **Save moved to the tree.** Toolbar Save/Save As removed; right-click a file's root → Save / Save As… / Close File. Root rows show a dirty dot. Menu File▸Save still targets the active document.
- **Empty workspace supported** — no doc open is a valid state; drawing a feature with nothing open creates a fresh Untitled doc.
- **Default feature style** is now white outline (opaque) + white fill (~50%), applied as an explicit inline style on drawn features (self-contained + editable). Render defaults for unstyled features also changed to white. (Configurable in a future settings pass.)
- **Polygon fill visibility fix.** GroundPrimitives were nested in a generic `PrimitiveCollection`, which prevents the classification pass from rendering them — moved to the scene's dedicated `groundPrimitives` collection. This should fix both invisible fills and interior picking. *(Needs manual confirmation — can't verify pixels headlessly.)*
- **Cross-file drag.** Features/folders can be dragged between open documents. Implemented as detach-from-source + clone-into-target (fresh ids), with the referenced **shared styles copied along** (identical ids reused, conflicting ids imported under a fresh id) so dragged features keep their styling. Recorded as a **single compound undo entry** on the target document that reverts both sides. Known nit: undoing a cross-file move leaves the imported (now unused) style definitions in the target — harmless, and it keeps undo/redo symmetric. Covered by `test/crossdoc.test.ts`.

## Phase 4 — Imports ✅ (vector + raster, incl. tiling)

### Feasibility (verified before building)
gdal3.js 2.8.1 (GDAL/OGR compiled to WASM) loads in Electron's Node side: **53 vector + 128 raster drivers** incl. ESRI Shapefile, GPKG, GTiff. Confirmed it reads arbitrary filesystem paths, runs inside a `worker_thread` with the host staying responsive, and round-trips a shapefile. API notes learned the hard way:
- `initGdalJs({ path })` resolves assets **relative to cwd** (it prefixes `./`), so an absolute path fails — the worker computes `relative(cwd, distDir)`.
- `getInfo()` returns only layer names/counts — **no field schema**. `ogrinfo -json` fails (FS error). The schema is instead derived from a `-limit 5` sample conversion.
- `ogr2ogr()` returns `{local, real, all[]}`; `getOutputFiles()` returns `[{path,size}]`; `getFileBytes(path)` takes the path string.

### Vector import ✅
- **`src/main/gdal-worker.ts`** — GDAL/WASM in a worker_thread. `inspectVector` (driver, layers, feature counts, geometry type, field schema with inferred types + sample values), `convertVector` (→ GeoJSON in EPSG:4326), `inspectRaster` (stub for the raster pass). `src/main/gdal.ts` is the main-process façade (lazy worker, id-correlated requests, progress forwarding).
- **`model/geojson.ts`** — GeoJSON → KML folder: all geometry types incl. Multi\* and holes, name-from-attribute, description table from chosen attributes, **all source attributes preserved as `<ExtendedData>`**, and either one shared style or **one style per category value** (evenly-spaced hue ramp).
- **`KmlDocument.importFolder`** inserts the folder *and* registers its shared styles as ONE undoable step (undo removes both).
- **Import dialog** on drag-drop of any OGR vector: layer picker, name field, per-attribute balloon checkboxes, plus:
  - **Group into folders by a field** — features land in sub-folders named by that attribute's value, sorted naturally with `(blank)` last. Composes with categorized colouring.
  - **Colour ramps** — Categorical (distinct qualitative palette), Rainbow, Viridis, Warm, Cool, Grayscale. Continuous ramps interpolate across control points; the swatch preview updates live.
  - **Style mode + opacity** — Outline only / Fill only / Outline + fill, with an opacity slider for each part that's active (fill defaults 50%, outline 100%).
- Packaging: `asarUnpack` for gdal3.js so emscripten can read its WASM/data files.

**Verified:** the *built* worker inspects and converts the shapefile fixture end-to-end (field types + samples correct, attributes preserved). 66 tests pass (9 new in `test/import.test.ts`), typecheck + build clean, app boots.

### Raster import — single overlay ✅ (tiling still to come)

Deliberately built the no-tiling path first, to find out empirically where one
Cesium `SingleTileImageryProvider` stops being viable.

- **`convertRaster`** (worker): `gdalwarp -t_srs EPSG:4326 -dstalpha` → `gdal_translate -of PNG`, with band selection for >4-band sources, 8-bit rescaling for non-Byte data, and optional downsampling.
- **`planRaster`** (worker): a pre-flight that costs almost nothing — it predicts the *reprojected* size from a **warped VRT** (GDAL derives output dimensions from georeferencing alone, touching no pixels), and reports whether the codec forces our own decode and how much temp disk that needs. Verified exact: 2048² → 2273×1802 and 8192² → 9092×7208, each predicted in ~200 ms vs 12.7 s to actually convert.
- **Codec fallback**: the bundled WASM libtiff has only NONE/LZW/DEFLATE/PACKBITS. JPEG and ZSTD failed to open at all. When GDAL reports a missing codec we decode with geotiff.js and re-expose the pixels to GDAL as a raw file + VRT header (EPSG + geotransform), streaming rows in ~64 MB strips. All six compressions now load, output identical to the uncompressed equivalent.
- **GPU ceiling**: one overlay is one texture, so `MAX_TEXTURE_SIZE` is a hard limit; over it we resample and say so up front (with the resulting resolution %, temp disk, and VRAM estimate) so the load can be cancelled before any slow work.
- **`RasterPanel`** reports per-overlay pixel size, PNG bytes, estimated VRAM, warp ms and upload ms — the readout for this experiment.

Measured (noise-filled fixtures — worst case for PNG; real imagery compresses far better):

| Source | Warped | PNG | GDAL |
|---|---|---|---|
| 1024² | 1136×900 | 6 KB | 0.09 s |
| 2048² | 2273×1802 | 13 MB | 0.8 s |
| 4096² | 4546×3604 | 53 MB | 3.1 s |
| 8192² | 9092×7208 | 211 MB | 12.7 s |

Roughly linear in pixel count. Reprojection enlarges by ~1.2×. Decoded RGBA is
4 bytes/px regardless of PNG compression, so 67 MP ≈ 262 MB of VRAM.

Two bugs fixed on the way: `inspectRaster` read `cornerCoordinates`/`wgs84Extent`
off `getInfo()`, which doesn't carry them, so **bounds was always null** (rasters
could never have been placed); and `setBasemap` called `imageryLayers.removeAll()`,
which would have wiped raster overlays on a basemap switch.

### Raster tiling + portability ✅

Large rasters can be brought in as an XYZ pyramid instead of being scaled down.
On import, a pre-flight (`planRaster`) predicts the reprojected size from a
*warped VRT* — GDAL derives output dimensions from georeferencing alone, no
pixels touched (~200 ms even at 67 MP) — and if one overlay would exceed the
GPU's `MAX_TEXTURE_SIZE` the user chooses **Tile it** or **Resample**, as
Google Earth does.

- `tileRaster` warps once to EPSG:3857 then cuts 256px PNGs straight to disk, so
  memory stays flat regardless of source size. Cached under
  `<userData>/tiles/<hash>` keyed by file identity, served through a privileged
  `earthy-tiles://` protocol that resolves strictly inside the cache and answers
  misses with a transparent tile.
- Max zoom rounds **up** from native resolution (rounding down left 30 m data on
  38 m/px tiles) plus one oversampling level for high-DPI. Each level costs ~4x
  the tiles: 4096² → 650 tiles / 9 s at native, 2,414 / 37 s with the deeper
  levels; 8192² → ~2,400 tiles / 33 s.
- **Saving to KMZ embeds the pyramid as a KML super-overlay** (per-tile Region +
  LOD + NetworkLinks), so a tiled raster is portable and renders natively in
  Google Earth. Opening a KMZ restores the pyramid to the cache — never as data
  URLs, since there can be tens of thousands of tiles. That makes
  **File ▸ Clear Tile Cache** safe.
- Our tiles are Web Mercator while `<LatLonBox>` is plate carrée; measured, the
  mismatch is sub-pixel over the zoom range generated (~0.7px at z6, ~0.2px at
  z8) — the same approximation gdal2tiles makes for its mercator profile.

### Progress + cancel ✅

The worker was already reporting progress and `onGdalProgress` reached the
preload, but **no renderer code subscribed**, so every report was discarded.
Now shown over the globe with a bar (indeterminate where GDAL reports no
fraction) and a Cancel button. Cancelling terminates the worker — GDAL's WASM
calls are synchronous and can't be interrupted cooperatively — and the next
request spawns a fresh one; verified a 12.7 s convert aborts in 1.5 s with the
following job succeeding. Each new worker sweeps temp dirs the terminated one
couldn't clean up.

### Bugs this phase surfaced (all had escaped every fixture)

- **Overlays were duplicated on every save.** `CONTAINER_CHILD_KNOWN` listed
  Folder/Document/Placemark but not the overlay types, so each overlay was kept
  as a raw unknownChild *and* parsed as a child node. No fixture had an overlay;
  `overlay.kml` (PLAN §8 finally added) caught it immediately.
- **`inspectRaster` always returned `bounds: null`** — it read
  `cornerCoordinates`/`wgs84Extent` off `getInfo()`, which doesn't carry them.
  Rasters could never have been placed.
- **`setBasemap` called `imageryLayers.removeAll()`**, which would have wiped
  raster overlays on a basemap switch.
- **Google Terrain silently fell back to Esri.** Google requires `layerRoadmap`
  with `terrain`; without it `createSession` fails, and `applyBasemap` quietly
  substituted Esri, so the basemap looked identical rather than broken.
- **gdal3.js masks real errors** — it calls `getFileListFromDataset()` on a
  failed operation's NULL result, so any warp failure surfaced as "Pointer 'hDS'
  is NULL". An `errorHandler` now re-attaches GDAL's actual message; that is
  what exposed the next one.
- **Tiling 4-band rasters failed** ("PNG driver doesn't support 5 bands"). The
  fallback VRT declared bands with no `<ColorInterp>`, so GDAL couldn't tell
  band 4 was alpha and `-dstalpha` appended a fifth.

### Deferred from Phase 4 (user deprioritised 2026-07-23)

Vector is considered done. Left undone: multi-layer import (§6.1.2 says
"layer(s)"), a target-folder chooser, bare-`.shp`-with-sidecars verification,
the 8,000-parcel/30 s perf bar, and a ≥2 GB GeoTIFF test.

## Phase 5 — Terrain + polish (terrain ✅, polish partly done)

### 3D terrain ✅

`globe/terrain.ts` `TerrariumTerrainProvider` is **in-house**: it decodes a
Terrarium PNG into a 65×65 Int16 grid and hands Cesium a `HeightmapTerrainData`.
No worker, no extra dependency. Tiles are fetched as PNG bytes over IPC and
decoded with `createImageBitmap(Blob)` — a custom `earthy-terrain://` scheme was
tried first and produced a black globe, because the canvas read-back was tainted.

`@macrostrat/cesium-martini` was the original pick and was dropped: it needs a
consumer-supplied Web Worker that isn't in its public exports, its default
constructor throws, and it decodes Mapbox-RGB rather than Terrarium.

Built-in source is "AWS Terrain (online)". Native Terrain menu = checkbox
"Render 3D terrain" + a radio group of datasets; `render3DTerrain` and
`activeTerrainId` persist in electron-store. The old
`terrainProvider: 'none' | 'maptiler' | 'ion'` union is retired. Toggles live
without a reload (PLAN §7 acceptance) — nothing is rebuilt on toggle at all now,
since vector features no longer depend on the surface.

Note for whoever picks this up: Google's *Terrain basemap* is not this. It is
roadmap styling plus shaded relief — a flat image — so it looks nearly identical
to Google Roadmap outside mountainous areas. Real 3D relief needs a terrain
provider.

### Altitude handling ✅ — but NOT as PLAN §5.3 describes

PLAN §5.3 says to drape clamped features with `GroundPrimitive` /
`GroundPolylinePrimitive`. **That was built, measured, and reversed.** Draping is
classification: Cesium builds and renders a per-feature stencil shadow volume,
which is orders of magnitude more expensive than a flat draw. On a 7,644-polygon
KMZ it took minutes and left the app unresponsive. User's call (2026-07-28):
*"Speed and consistency are more important to me than interiors."*

So the rule is now:

- `altitudeMode === 'absolute'` **and** a vertex carries Z → render at that
  altitude. KML altitude is MSL, so the renderer adds the EGM96 geoid undulation
  to reach the ellipsoidal height Cesium positions by.
- **Everything else → flat at height 0.** Not clamped. With terrain on, those
  features sit at sea level and are partly buried by relief. That is the accepted
  trade, not a bug.
- `relativeToGround` is not implemented; it falls in the "everything else" bucket.

The app **never creates Z**. New drawn features are 2-D `lon,lat`
(`DrawTool.cartToPosition`), and imports aren't altered. There is no
elevation-setting UI — one was built in RestyleDialog and fully reverted, and
`gx:altitudeOffset` was considered and rejected as a Google extension.

### Geoid ✅

EGM96-15 (`us_nga_egm96_15.tif`, 2.6 MB) is vendored at `resources/geoid/` and
bundled via `extraResources`. It powers both the status-bar readout
(`… m MSL (… m HAE)`) and the absolute-render Z→ellipsoidal conversion.

**`src/main/geoid.ts` reads the raw bytes only** (`fs.readFile`); the renderer
parses them with geotiff and bilinear-samples N. geotiff is ESM-only, and a
static import in the CommonJS main process compiled to `require()` and threw
`ERR_REQUIRE_ESM` via its `quick-lru` dep — a hard startup crash. **Do not
reintroduce geotiff into `src/main`.** (`gdal-worker.ts` is fine; it uses a
runtime dynamic `import()`.)

### Performance — the load-time collapse and what actually caused it

A 164 MB / 7,644-polygon / 4.1M-vertex KMZ went from unusable to <10 s. Three
causes, only one of which was the terrain work. Worth recording because the first
two were each mis-diagnosed once:

- **`PolylineCollection` was ~95% of it.** It does not draw lines; it fakes
  thickness by expanding every position into a 4-vertex quad, each vertex storing
  position, prev and next as RTE-encoded pairs — 18 floats per vertex — written
  by a single-threaded JS loop inside `scene.render()`. Measured on that file:
  **1,380 MB** of vertex buffers on the main thread, versus **78 MB** for batched
  `SimplePolylineGeometry` (`arcType: ArcType.NONE`) built in a worker. Hairlines
  now take the batched path. Lines wider than 1px still need `PolylineCollection`,
  so a bulk restyle to thick lines re-enters the slow path.
- **Invisible polygon fills.** `27aef26` made the fill unconditional — rendered
  transparent when `<fill>0</fill>` — so polygon interiors stayed pickable. Every
  style in that file is `<fill>0</fill>`, so the app was triangulating 4.1M
  vertices to draw nothing. Now `<fill>0</fill>` means no fill geometry at all,
  and interiors are no longer pickable (user doesn't want them).
- **`isEffectivelyVisible` was O(n²)** — it called `pathTo`, which descends from
  the root to locate the node. Walks up the existing parent index now.

Diagnostic trap to remember: `Primitive` with `asynchronous: true` triangulates in
web workers, so fill cost does **not** block the UI. Removing it changed the wall
clock and nothing the user could feel. `GlobeRenderer` now logs what reached the
GPU plus a separate "globe interactive Xs" measured from `postRender`, because a
scene build that reports "instant" can still be followed by a long freeze.

### Polish

- Keyboard shortcuts ✅ (registry in `input/commands.ts`; see TODO.md).
- App icon ✅ — `build/make-icon.py` draws a globe with a two-vertex linestring
  and emits `icon.png` / `icon.svg` / `icon.ico` / `icon.icns` from one set of
  unit coordinates. Small `.iconset`/`.ico` entries are drawn simplified rather
  than downsampled. `build/` had to be un-ignored (it's electron-builder's
  `buildResources`, i.e. source). The Dock icon in `npm run dev` is set
  explicitly, because dev runs inside Electron's own bundle and would otherwise
  show the Electron icon.
- Layer tree ✅ — check/uncheck all now carries the folder itself, and checking
  anything opens its ancestors; unchecking closes them only once nothing visible
  is left under them.

### Still open in Phase 5

- Search box / geocode (PLAN §7 lists it; nothing exists — Cesium's own geocoder
  is disabled in the Viewer config).
- The stated acceptance bar is **unmeasured**: 50k-feature file usable, selection
  < 200 ms, pan ≥ 24 fps. This phase's perf work was driven by a real user file,
  not that fixture.
- GPU/hardware-acceleration verification in a *packaged* macOS build (ANGLE Metal).
- Windows/Linux build smoke test — targets are configured, never exercised.
- User terrain datasets: "Build Terrain from Folder" (Copernicus GLO-30 →
  Terrarium via the Phase 4 GDAL tiler), "Add Existing", and persistence for
  custom datasets. Mapterhorn PMTiles as a first-class source.

## How to run

- `npm run dev` — dev server + Electron with HMR.
- `npm test` / `npm run typecheck` — model tests + typecheck.
- `npm run build` — production build to `out/`.
- Boot smoke test: `NGE_SMOKE=10000 NGE_SMOKE_KML="$PWD/test/fixtures/simple.kml" npx electron-vite preview`.
