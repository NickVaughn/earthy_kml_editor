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

## How to run

- `npm run dev` — dev server + Electron with HMR.
- `npm test` / `npm run typecheck` — model tests + typecheck.
- `npm run build` — production build to `out/`.
- Boot smoke test: `NGE_SMOKE=10000 NGE_SMOKE_KML="$PWD/test/fixtures/simple.kml" npx electron-vite preview`.
