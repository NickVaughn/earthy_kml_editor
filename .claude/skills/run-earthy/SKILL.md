---
name: run-earthy
description: Build, run, and drive the Earthy Electron app (KML/KMZ editor on a Cesium globe) headlessly. Use when asked to start or launch Earthy, open a KML in it, click or draw on the globe, use the ruler or other tools, take a screenshot of the app, or confirm a change works in the real app rather than only in tests.
---

Earthy is an Electron app. Agents drive the built app with
`.claude/skills/run-earthy/driver.mjs`, a Playwright `_electron` driver run
under `xvfb-run`. It reads one command per line from stdin, so you can pipe it a
heredoc of commands for a repeatable run, or type commands into it inside tmux.

Paths are relative to the repo root.

## Prerequisites

Claude's cloud container already has Xvfb, tmux, and Playwright (global, at
`/opt/node-tools`), plus Node 22. Check:

```bash
which xvfb-run tmux && node --version && node -p "require('playwright/package.json').version"
```

## Setup and build

```bash
npm ci          # also downloads the Electron binary (node_modules/electron/dist/electron)
npm run build   # → out/; the driver runs this build, so rebuild after every source change
```

## Run (agent path)

Pipe a script of commands. Each command echoes as `> cmd`, and output follows it:

```bash
xvfb-run -a -s "-screen 0 1440x900x24" node .claude/skills/run-earthy/driver.mjs > /tmp/earthy-run.log 2>&1 <<'EOF'
launch test/fixtures/simple.kml
ss 01-opened
press m
gclick 0.45 0.45
gclick 0.55 0.55
ruler
ss 02-ruler-line
errors
quit
EOF
grep -v "GL Driver\|gles2\|ReadPixels\|WebGL" /tmp/earthy-run.log
```

Then **look at the screenshots** in `/tmp/earthy-shots/` (override with
`SCREENSHOT_DIR`). On the blue globe with a red polygon (simple.kml) you
should see a yellow ruler line, and `ruler` prints
`[Line] Map Length: … Metres | Ground Length: … | Heading: … degrees`.

To work interactively, run the driver inside tmux instead:

```bash
tmux new-session -d -s earthy -x 200 -y 50
tmux send-keys -t earthy 'xvfb-run -a -s "-screen 0 1440x900x24" node .claude/skills/run-earthy/driver.mjs 2>/dev/null' Enter
timeout 30 bash -c 'until tmux capture-pane -t earthy -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t earthy 'launch' Enter
timeout 90 bash -c 'until tmux capture-pane -t earthy -p | grep -q "^launched"; do sleep 0.5; done'
tmux send-keys -t earthy 'open test/fixtures/simple.kml' Enter
tmux capture-pane -t earthy -p
# … more commands …; finish with:
tmux send-keys -t earthy 'quit' Enter; sleep 3; tmux kill-session -t earthy
```

| command | what it does |
|---|---|
| `launch [file.kml]` | start the built app with a throwaway settings profile, opening the file if given; waits for boot |
| `open <file>` | open a KML/KMZ in the running app (as a double-click in the OS would) |
| `ss [name]` | screenshot → `/tmp/earthy-shots/<name>.png` |
| `gclick fx fy [right]` | click the globe at fractions of its area (`0.5 0.5` = centre) |
| `gdbl fx fy` / `gmove fx fy` | double-click / hover the globe |
| `gdrag fx1 fy1 fx2 fy2` | press, drag, release on the globe |
| `click <css>` / `click-text <text>` | DOM click on an element / on the button or label with that text |
| `select <css> <value>` | choose a `<select>` option |
| `press <key>` / `type <text>` | keyboard to the focused element (`m` opens the ruler, `Enter`, `Escape`, …) |
| `ruler` | the Ruler panel's tab and readout on one line |
| `coord` | status-bar cursor readout (lat, lon) |
| `text [css]` / `eval <js>` / `wait <css>` | read the DOM / evaluate in the page / wait up to 10 s |
| `errors` | page and console errors so far, minus the known startup noise |
| `sleep <ms>` / `help` / `quit` | — / list commands / kill the app and delete the profile |

`EARTHY_PROFILE=<dir>` keeps one settings profile across launches, and
`EARTHY_ION_TOKEN` / `EARTHY_GOOGLE_MAPS_API_KEY` in the environment reach the
app. Fixtures to open live in `test/fixtures/`.

## Test

```bash
npm run typecheck && npm run lint && npm test   # what CLAUDE.md asks before every push
npx vitest run test/ruler.test.ts               # one file; model/ code is Cesium-free and runs here
```

All 21 test files should pass. `test/superoverlay.test.ts` loads Electron, so
it fails if the binary is missing (see Troubleshooting).

For a person at a desktop, `npm run dev` opens a window (see the README). It is
no use headless.

## Gotchas

- **No imagery.** The cloud egress proxy refuses the tile hosts
  (`services.arcgisonline.com` → `connect_rejected`), so the globe is plain blue
  with no basemap. Vector features, tools, and the UI all render, and that is
  enough to test them. Ion and Google basemaps also need keys.
- **Startup always logs three errors that are not bugs here:** `Basemap failed:
  … Cesium ion token not configured`, `net::ERR_TUNNEL_CONNECTION_FAILED`, and a
  bare `RuntimeError` page error. The last one appears on a stock launch too.
  The driver's `errors` command hides them.
- **WebGL is software (SwiftShader).** No GPU flags are needed; stderr says
  "Automatic fallback to software WebGL has been deprecated" and repeats "GPU
  stall due to ReadPixels". Rendering is slow, so the driver pauses after each
  action. Throttled readouts, such as the ruler's ground length, can lag a few
  hundred ms behind.
- **Settings persist between launches.** Without an isolated profile, settings
  saved in `~/.config/earthy/config.json` (ruler units, basemap, terrain) carry
  into the next run, and screenshots stop being reproducible. `launch` passes
  `--user-data-dir=<temp dir>` for that reason.
- **The globe needs real mouse events at coordinates.** Cesium listens for
  pointer events on its canvas, so a DOM `.click()` does nothing there; use
  `gclick`/`gdrag`. With no file open, the Earth is a disc centred at
  `0.5 0.5` with a radius of about 0.24 of the globe width. Clicks outside it
  hit the sky: no pick, and `coord` keeps its last value. Opening a file
  frames it, so then the whole view is ground.
- **Keys go to whatever has focus.** Cesium cancels the pointer-down default
  once a tool listens for it, so clicking the globe does not blur a focused
  field (the ruler blurs it itself; the draw and edit tools do not). If a key
  seems ignored, `eval document.activeElement.tagName`.
- **`app.close()` hangs** when a document has unsaved changes: the native
  Discard/Cancel dialog waits for an answer. `quit` kills the process instead.
- **Don't pipe a long run through `| tail` under `timeout`.** When the timeout
  kills it, all output is lost. Redirect to a file, as above.

## Troubleshooting

- **`launch` → `Failed to launch: Error: spawn …/node_modules/electron/dist/electron ENOENT`**,
  or `test/superoverlay.test.ts` → `Electron failed to install correctly`: the
  install skipped the Electron binary (for example `ELECTRON_SKIP_BINARY_DOWNLOAD=1`).
  Run `node node_modules/electron/install.js`.
- **`ERROR: no build: run npm run build first`**: `out/` is missing. Build.
- **A change doesn't show up:** the driver runs `out/`, not the sources. Run
  `npm run build` again.
