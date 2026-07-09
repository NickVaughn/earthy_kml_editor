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

## How to run

- `npm run dev` — dev server + Electron with HMR.
- `npm test` / `npm run typecheck` — model tests + typecheck.
- `npm run build` — production build to `out/`.
- Boot smoke test: `NGE_SMOKE=10000 NGE_SMOKE_KML="$PWD/test/fixtures/simple.kml" npx electron-vite preview`.
