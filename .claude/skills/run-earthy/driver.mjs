// Drive the built Earthy app (Electron) headlessly: launch it under Xvfb,
// click and drag on the globe, press keys, read the DOM, take screenshots.
//
// Reads one command per line from stdin and runs them in order, so it works
// both piped (a heredoc of commands, for repeatable runs) and interactively
// (inside tmux). Run from the repo root, under xvfb-run; see SKILL.md.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

// Playwright is preinstalled globally in Claude's cloud containers, where only
// CommonJS resolution finds it.
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const ELECTRON = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/earthy-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Startup noise that is not a bug in this environment (see SKILL.md Gotchas).
const NOISE = /GL Driver|WebGL|ion token not configured|ERR_TUNNEL_CONNECTION_FAILED|^RuntimeError$|Electron Security Warning/;

let app = null;
let page = null;
let profile = null;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need() {
  if (!page) throw new Error('launch first');
}

/** Fractions of the globe area → page pixels ("0.5 0.5" is the centre of the globe view). */
async function globeAt(fx, fy) {
  const box = await page.locator('.globe').boundingBox();
  return [box.x + box.width * Number(fx), box.y + box.height * Number(fy)];
}

const COMMANDS = {
  /** launch [file.kml|kmz] — start the built app with a fresh settings profile, optionally opening a file. */
  async launch(arg) {
    if (app) return console.log('already launched');
    if (!fs.existsSync(path.join(APP_DIR, 'out/main/index.js'))) {
      throw new Error('no build: run `npm run build` first');
    }
    // A throwaway profile, so settings saved by an earlier run (units, basemap,
    // terrain) never leak in. EARTHY_PROFILE=<dir> keeps one between runs.
    profile = process.env.EARTHY_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'earthy-profile-'));
    const args = ['--no-sandbox', `--user-data-dir=${profile}`, APP_DIR];
    if (arg) args.push(path.resolve(arg));
    app = await electron.launch({ executablePath: ELECTRON, args, cwd: APP_DIR, timeout: 60_000 });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    let booted = false;
    page.on('console', (m) => {
      if (m.text().includes('boot: terrain applied')) booted = true;
      if (m.type() === 'error') errors.push(`console: ${m.text().split('\n')[0]}`);
    });
    await page.waitForSelector('.toolbar', { timeout: 30_000 });
    // The last boot step logs this; give software rendering a moment after it.
    for (let i = 0; i < 150 && !booted; i++) await sleep(100);
    await sleep(2000);
    console.log(`launched (profile ${profile})${arg ? `, opened ${arg}` : ''}`);
  },

  /** open <file.kml|kmz> — open a file in the running app, as the OS would on a double-click. */
  async open(file) {
    need();
    const abs = path.resolve(file);
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('open-requested', p), abs);
    await sleep(3000);
    console.log('opened', abs);
  },

  /** ss [name] — screenshot of the window. */
  async ss(name) {
    need();
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  /** gclick fx fy [right] — click the globe at fractions of its area. */
  async gclick(arg) {
    need();
    const [fx, fy, button] = arg.split(/\s+/);
    await page.mouse.click(...(await globeAt(fx, fy)), { button: button === 'right' ? 'right' : 'left' });
    await sleep(400);
  },

  /** gdbl fx fy — double-click the globe. */
  async gdbl(arg) {
    need();
    const [fx, fy] = arg.split(/\s+/);
    await page.mouse.dblclick(...(await globeAt(fx, fy)));
    await sleep(400);
  },

  /** gmove fx fy — move the mouse over the globe. */
  async gmove(arg) {
    need();
    const [fx, fy] = arg.split(/\s+/);
    await page.mouse.move(...(await globeAt(fx, fy)), { steps: 5 });
    await sleep(400);
  },

  /** gdrag fx1 fy1 fx2 fy2 — press, drag and release on the globe. */
  async gdrag(arg) {
    need();
    const [x1, y1, x2, y2] = arg.split(/\s+/);
    await page.mouse.move(...(await globeAt(x1, y1)));
    await page.mouse.down();
    await page.mouse.move(...(await globeAt(x2, y2)), { steps: 10 });
    await page.mouse.up();
    await sleep(500);
  },

  /** click <css> — DOM click on an element. */
  async click(sel) {
    need();
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, sel);
    console.log('click', sel, '->', r);
    await sleep(300);
  },

  /** click-text <text> — click the button whose text matches (exact first, then contains). */
  async 'click-text'(text) {
    need();
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, label, [role="button"], li')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click();
      return `OK: ${el.tagName}`;
    }, text);
    console.log('click-text', JSON.stringify(text), '->', r);
    await sleep(300);
  },

  /** select <css> <value> — choose an option in a <select>. */
  async select(arg) {
    need();
    const i = arg.lastIndexOf(' ');
    await page.selectOption(arg.slice(0, i), arg.slice(i + 1));
    await sleep(200);
    console.log('selected', arg.slice(i + 1));
  },

  /** press <key> — a key to the focused element (Playwright names: Enter, Escape, Backspace, m…). */
  async press(key) {
    need();
    await page.keyboard.press(key);
    await sleep(300);
  },

  /** type <text> — type into the focused element. */
  async type(text) {
    need();
    await page.keyboard.type(text, { delay: 30 });
  },

  /** text [css] — innerText of an element (default: the whole page). */
  async text(sel) {
    need();
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },

  /** ruler — the Ruler panel's active tab and readout, one line. */
  async ruler() {
    need();
    console.log(
      await page.evaluate(() => {
        const panel = document.querySelector('.ruler');
        if (!panel) return '(ruler closed)';
        const unit = (r) => {
          const sel = r.querySelector('select');
          return sel ? sel.selectedOptions[0].text : r.querySelector('.ruler-unit')?.innerText ?? '';
        };
        const rows = [...panel.querySelectorAll('.ruler-row')].map(
          (r) => `${r.querySelector('.ruler-label').innerText} ${r.querySelector('.ruler-value').innerText} ${unit(r)}`.trim(),
        );
        return `[${panel.querySelector('.ruler-tabs .active')?.textContent}] ${rows.join(' | ')}`;
      }),
    );
  },

  /** coord — the status bar's cursor readout (lat, lon, height). Stale while over the sky. */
  async coord() {
    need();
    console.log(await page.evaluate(() => document.querySelector('.statusbar .coord')?.innerText));
  },

  /** wait <css> — wait up to 10 s for an element. */
  async wait(sel) {
    need();
    try {
      await page.waitForSelector(sel, { timeout: 10_000 });
      console.log('found:', sel);
    } catch {
      console.log('TIMEOUT:', sel);
    }
  },

  /** eval <js> — evaluate in the page, print the result as JSON. */
  async eval(expr) {
    need();
    console.log(JSON.stringify(await page.evaluate(expr)));
  },

  /** sleep <ms> */
  async sleep(ms) {
    await sleep(Number(ms) || 1000);
  },

  /** errors — page and console errors so far, without the known startup noise. */
  async errors() {
    const real = errors.filter((e) => !NOISE.test(e.replace(/^(pageerror|console): /, '')));
    console.log(real.length ? real.join('\n') : 'no errors');
  },

  /** quit — kill the app (app.close() would hang on the unsaved-changes dialog). */
  async quit() {
    if (app) {
      const proc = app.process();
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    app = null;
    page = null;
    // Electron's helpers can still be flushing the profile for a moment.
    if (profile && !process.env.EARTHY_PROFILE) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    console.log('quit');
  },

  help() {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    for (const m of src.matchAll(/\/\*\* (\S+.*?) \*\/\n\s+(?:async )?'?[\w-]+'?\(/g)) console.log(' ', m[1]);
  },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const interactive = process.stdin.isTTY;
const prompt = () => interactive && process.stdout.write('driver> ');
console.log('earthy driver ready — "help" for commands');
prompt();
for await (const line of rl) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd && !cmd.startsWith('#')) {
    if (!interactive) console.log(`> ${line.trim()}`);
    const fn = COMMANDS[cmd];
    if (!fn) console.log(`unknown: ${cmd} — try: help`);
    else {
      try {
        await fn(rest.join(' '));
      } catch (e) {
        console.log('ERROR:', e.message.split('\n')[0]);
      }
    }
    if (cmd === 'quit') process.exit(0);
  }
  prompt();
}
await COMMANDS.quit();
process.exit(0);
