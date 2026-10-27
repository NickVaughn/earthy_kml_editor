import { dialog, type BrowserWindow } from 'electron';
import * as fsp from 'node:fs/promises';
import {
  PRESET_FILE_SUFFIX,
  presetFileText,
  parsePresetFile,
  presetConflicts,
  mergePresets,
} from '../shared/presetFile';
import { baseName } from '../shared/paths';
import { getStylePresets, setStylePresets } from './settings';

const FILTERS = [{ name: 'Earthy style presets', extensions: ['json'] }];

/** A preset name as a filename: no path separators or reserved characters. */
const fileSafe = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'preset';

/**
 * Write saved presets to a file chosen by the user — the named ones, or all.
 * Resolves to the written path, or null if there was nothing to write or the
 * user cancelled.
 */
export async function exportStylePresets(
  win: BrowserWindow,
  names?: string[],
): Promise<string | null> {
  const all = getStylePresets();
  const chosen = names ? all.filter((p) => names.includes(p.name)) : all;
  if (chosen.length === 0) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'There are no saved style presets to export.',
      detail: 'Save one from the import or restyle dialog first.',
    });
    return null;
  }
  const base = chosen.length === 1 ? fileSafe(chosen[0].name) : 'Earthy style presets';
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${base}${PRESET_FILE_SUFFIX}`,
    filters: FILTERS,
  });
  if (res.canceled || !res.filePath) return null;
  await fsp.writeFile(res.filePath, presetFileText(chosen), 'utf8');
  return res.filePath;
}

/**
 * Merge presets from a file chosen by the user into the saved ones, asking
 * how to resolve name clashes. Tells the renderer about the new list.
 */
export async function importStylePresets(win: BrowserWindow): Promise<void> {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS });
  if (res.canceled || res.filePaths.length === 0) return;
  const path = res.filePaths[0];
  const fileName = baseName(path);

  let parsed;
  try {
    parsed = parsePresetFile(await fsp.readFile(path, 'utf8'));
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: `Could not import “${fileName}”.`,
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (parsed.presets.length === 0) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: `“${fileName}” has no usable style presets.`,
      detail: parsed.skipped ? `${parsed.skipped} entries were damaged or incomplete.` : undefined,
    });
    return;
  }

  const existing = getStylePresets();
  const conflicts = presetConflicts(existing, parsed.presets);
  let onConflict: 'replace' | 'keep-both' = 'replace';
  if (conflicts.length) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Replace', 'Keep Both', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      message:
        conflicts.length === 1
          ? 'You already have a different preset with this name.'
          : `You already have different presets with ${conflicts.length} of these names.`,
      detail: `${conflicts.join('\n')}\n\nReplace yours with the imported version, or keep both (the imported one gets a number)?`,
    });
    if (response === 2) return;
    onConflict = response === 0 ? 'replace' : 'keep-both';
  }

  const m = mergePresets(existing, parsed.presets, onConflict);
  setStylePresets(m.presets);
  win.webContents.send('style-presets-changed', m.presets);

  const lines = [
    m.added && `${m.added} added`,
    m.replaced && `${m.replaced} replaced`,
    m.renamed && `${m.renamed} added under a new name`,
    m.unchanged && `${m.unchanged} already saved`,
    parsed.skipped && `${parsed.skipped} skipped as damaged or incomplete`,
  ].filter(Boolean);
  await dialog.showMessageBox(win, {
    type: 'info',
    message: `Imported style presets from “${fileName}”.`,
    detail: lines.join('\n'),
  });
}
