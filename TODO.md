# Deferred / Out-of-scope (revisit in a later phase)

Items intentionally postponed. See PLAN.md §10 for the original out-of-scope list.

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

## Other deferred (from PLAN §10)
- NetworkLink refresh semantics (currently parsed/preserved/display-once only)
- KML Regions / LOD
- Google Photorealistic 3D Tiles basemap
- COG streaming without pre-tiling
- Geocoding beyond lat/lon parse
