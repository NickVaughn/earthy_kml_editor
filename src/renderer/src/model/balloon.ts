import type { KmlDocumentData, KmlNode } from './types';
import { effectiveStyle } from './style';

/**
 * Produce the HTML shown in a feature's description balloon, matching Google
 * Earth's precedence:
 *   1. A resolved BalloonStyle <text> template, with $[…] entities substituted
 *      from the placemark's name/description and ExtendedData fields.
 *   2. Otherwise, the raw <description>.
 *   3. Otherwise, a default two-column table of ExtendedData fields.
 */
export function resolveBalloonHtml(doc: KmlDocumentData, node: KmlNode): string {
  const style = effectiveStyle(doc, node);
  const fields = node.extendedData?.fields ?? [];
  const fieldMap = new Map(fields.map((f) => [f.name, f.value]));

  if (style.balloonText && style.balloonText.trim()) {
    return substituteEntities(style.balloonText, doc, node, fieldMap);
  }

  if (node.description && node.description.trim()) {
    return node.description;
  }

  if (fields.length > 0) {
    const rows = fields
      .map((f) => {
        const label = doc.schemaDisplayNames?.get(f.name) ?? f.name;
        return `<tr><td><b>${escapeHtml(label)}</b></td><td>${escapeHtml(f.value)}</td></tr>`;
      })
      .join('');
    return `<table>${rows}</table>`;
  }

  return '<em>No description.</em>';
}

/**
 * Replace KML balloon entities: $[name], $[description], $[id], and
 * $[field] / $[schema/field] / $[field/displayName] from ExtendedData.
 */
function substituteEntities(
  template: string,
  _doc: KmlDocumentData,
  node: KmlNode,
  fieldMap: Map<string, string>,
): string {
  return template.replace(/\$\[([^\]]+)\]/g, (_m, expr: string) => {
    const key = String(expr).trim();
    if (key === 'name') return escapeHtml(node.name);
    if (key === 'description') return node.description ?? '';
    if (key === 'id') return escapeHtml(node.kmlId ?? '');

    // Strip a leading "schemaName/" qualifier; keep a trailing "/displayName".
    const parts = key.split('/');
    const wantsDisplayName = parts[parts.length - 1] === 'displayName';
    const fieldName = wantsDisplayName ? parts[parts.length - 2] : parts[parts.length - 1];
    if (wantsDisplayName) return escapeHtml(fieldName ?? '');
    const value = fieldMap.get(fieldName ?? '');
    return value !== undefined ? escapeHtml(value) : '';
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
