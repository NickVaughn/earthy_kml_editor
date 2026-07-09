import type {
  KmlDocumentData,
  KmlNode,
  KmlStyle,
  IconStyle,
  LabelStyle,
  LineStyle,
  PolyStyle,
} from './types';

/**
 * Resolve the *effective* style for a node: shared style referenced by
 * <styleUrl> (following a StyleMap's "normal" pair) merged with any inline
 * <Style>, inline winning per sub-style.
 */

function mergeSub<T extends object>(base?: T, over?: T): T | undefined {
  if (!base) return over;
  if (!over) return base;
  // Only defined properties on `over` win; undefined must not clobber inherited
  // values (parsed sub-styles carry undefined keys for absent elements).
  const out: T = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function mergeStyles(base?: KmlStyle, over?: KmlStyle): KmlStyle {
  return {
    icon: mergeSub<IconStyle>(base?.icon, over?.icon),
    label: mergeSub<LabelStyle>(base?.label, over?.label),
    line: mergeSub<LineStyle>(base?.line, over?.line),
    poly: mergeSub<PolyStyle>(base?.poly, over?.poly),
  };
}

function localRef(styleUrl: string | undefined): string | null {
  if (!styleUrl) return null;
  const hash = styleUrl.indexOf('#');
  if (hash < 0) return null; // external file refs unsupported in Phase 1
  return styleUrl.slice(hash + 1);
}

/** Resolve a styleUrl/#id to a concrete KmlStyle, following StyleMap normal pairs. */
export function resolveStyleUrl(
  doc: KmlDocumentData,
  styleUrl: string | undefined,
  depth = 0,
): KmlStyle | undefined {
  const id = localRef(styleUrl);
  if (!id || depth > 5) return undefined;

  const direct = doc.sharedStyles.get(id);
  if (direct) return direct;

  const map = doc.sharedStyleMaps.get(id);
  if (map) {
    const normal = map.pairs.find((p) => p.key === 'normal') ?? map.pairs[0];
    if (!normal) return undefined;
    if (normal.inlineStyle) return normal.inlineStyle;
    return resolveStyleUrl(doc, normal.styleUrl, depth + 1);
  }
  return undefined;
}

/** The final style used to render a node. */
export function effectiveStyle(doc: KmlDocumentData, node: KmlNode): KmlStyle {
  const shared = resolveStyleUrl(doc, node.styleUrl);
  let inline = node.inlineStyle;
  if (!inline && node.inlineStyleMap) {
    const normal =
      node.inlineStyleMap.pairs.find((p) => p.key === 'normal') ??
      node.inlineStyleMap.pairs[0];
    inline = normal?.inlineStyle ?? resolveStyleUrl(doc, normal?.styleUrl);
  }
  return mergeStyles(shared, inline);
}
