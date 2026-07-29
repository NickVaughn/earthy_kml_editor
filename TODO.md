# Deferred / Out-of-scope (revisit in a later phase)

Items intentionally postponed. See PLAN.md §10 for the original out-of-scope list.

## Keyboard shortcuts (camera + general)
**Status:** BUILT. Registry at `src/renderer/src/input/commands.ts`; dispatcher
`useKeybindings.ts`; camera actions `globe/cameraCommands.ts`; help overlay (`?`).
Shipped bindings: `u` nadir, `n` north-up, `r` reset, `f` zoom-to-selection,
`?` help. Add more by appending one entry to COMMANDS.
Design notes below kept for reference.

### Structure
- `src/renderer/src/input/commands.ts` — the registry. Adding a shortcut = adding
  one entry:
  ```ts
  interface Command {
    id: string;                       // 'view.nadir'
    keys: string;                     // 'u' | 'shift+n' | '?'
    label: string;                    // shown in the help overlay
    group: 'View' | 'Edit' | 'File';
    when?: 'always' | 'globe';        // focus scope
    run(ctx: CommandContext): void;   // ctx = { globe, store }
  }
  ```
- `src/renderer/src/input/useKeybindings.ts` — ONE window-level keydown listener
  in `App`, dispatching through the registry.
- `src/renderer/src/globe/cameraCommands.ts` — the camera actions.
- Help overlay bound to `?`, generated from the registry (so it can never drift
  out of date).

### Dispatcher rules (the part that actually matters)
Bare single-letter keys are dangerous in an app with text fields, so the
dispatcher must skip when:
1. the event target is `input` / `textarea` / `select` / `[contenteditable]` —
   protects tree inline-rename and the Inspector's name/description fields;
2. a modal is open (import dialog), except explicitly modal-safe keys (`Esc`);
3. a draw/edit tool is active and owns that key (`Enter`/`Esc`/`Delete` already
   have `window` listeners in DrawTool/EditTool) — tools take precedence;
4. modifiers are present that the binding didn't declare, so `Cmd+N` never
   triggers plain `n`.

### Camera semantics (the subtle bit)
Both commands should pivot around the **ground point at the centre of the
screen**, not the camera's own position. If you just re-orient in place, the
feature you were looking at slides out of view — which is exactly the thing that
feels broken in other viewers. So:
- Pick the globe point under the viewport centre (`camera.pickEllipsoid`).
- `u` (nadir): fly to directly above that point, `pitch = -90°`, **keep** current
  heading and range.
- `n` (north-up): same centre point, `heading = 0`, **keep** current pitch and
  range.
- Implement via `camera.lookAt(centre, new HeadingPitchRange(h, p, range))` then
  `camera.lookAtTransform(Matrix4.IDENTITY)` to release the reference frame.
- Short flight (~0.4 s) rather than a snap.
- If the centre ray misses the globe (looking at sky/horizon), fall back to
  re-orienting in place.

### Testing
Registry lookup + the guard rules are pure and unit-testable. Extract
`nadirOrientation()` / `northUpOrientation()` as pure functions returning
`{heading, pitch, range}` so the math is testable; the actual flight needs manual
confirmation.

### Candidate future bindings (pick as wanted)
`f` fly to selection · `r` reset view (north-up + nadir) · `space` toggle
selected visibility · `+`/`-` zoom · `1`–`5` switch basemap · `[`/`]` cycle
open documents.

### Effort
Small — registry + dispatcher ~100 lines, camera commands ~60, help overlay ~40.

## Drag-and-drop: full Google Earth depth parity
**Status:** partially done in Phase 2 (see PHASE_NOTES "Phase 2 fixes" #3).

react-arborist's `computeDrop` toggles drop depth by cursor-X, but only across
the levels valid at the hovered Y position. This covers end-of-subtree and
above-folder gaps, but **the gap directly below an open folder's header only
offers "inside"** — Google Earth also lets you drop as a sibling-after-folder
there by moving the cursor left.

Workarounds that work today: collapse the folder first, or drop in the gap after
the folder's last child.

**To reach full parity** we must replace react-arborist's DnD with custom drop
logic (react-arborist exposes no hook to override `computeDrop`). That means
computing `{parentId, index, level}` ourselves from pointer position + a custom
drop indicator, wired to `KmlDocument.move`. Non-trivial; needs interactive
iteration (drag behavior can't be unit-tested headlessly).

## Phase 4 leftovers (vector declared done 2026-07-23)

Small gaps against PLAN §6, deprioritised by the user:
- Multi-layer vector import — §6.1.2 says "choose layer(s)"; we do one at a time.
- No target-folder chooser in the import dialog (imports land in the selection).
- Bare `.shp` with sidecars unverified (`.zip` works).
- Perf bar never measured: 8,000 parcels in < 30 s.
- Raster never tested at ≥ 2 GB.

## Phase 5 leftovers (terrain declared done 2026-07-28)

Terrain, altitude handling, the geoid, keyboard shortcuts and the app icon are
built (PHASE_NOTES §Phase 5). Left undone:
- Search box — nothing exists; PLAN §7 asks for geocode or at minimum lat/lon
  parsing. Cesium's own geocoder is disabled in the Viewer config.
- Acceptance never measured: 50k-feature file usable, selection < 200 ms,
  pan ≥ 24 fps. The Phase 5 perf work was driven by a real user file instead.
- GPU/hardware-acceleration verification in a *packaged* macOS build (ANGLE
  Metal backend).
- Windows/Linux build smoke test — targets configured, never exercised.
- User terrain datasets: "Build Terrain from Folder" (Copernicus GLO-30 →
  Terrarium via the Phase 4 GDAL tiler), "Add Existing", persistence for custom
  datasets. Mapterhorn PMTiles as a first-class terrain source.
- `relativeToGround` altitude mode (falls in the flat-at-0 bucket today).
- Clamped features don't follow terrain — with 3D relief on they sit at sea
  level. Deliberate (see PHASE_NOTES), but revisit if draping ever gets cheap.
- Lines wider than 1px still go through `PolylineCollection`, so a bulk restyle
  to thick lines on a huge file re-enters the slow path.

## Other deferred (from PLAN §10)
- NetworkLink refresh semantics (currently parsed/preserved/display-once only)
- KML Regions / LOD
- Google Photorealistic 3D Tiles basemap
- COG streaming without pre-tiling
- Earthy renders KML super-overlays it *didn't* generate (no NetworkLink/Region
  LOD support; our own tiled rasters are recognised by their ExtendedData marker
  and rendered from the tile cache instead)
- Automatic re-tiling when a document references a pyramid that's been cleared
- Geocoding beyond lat/lon parse
