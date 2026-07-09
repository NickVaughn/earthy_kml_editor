import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/**
 * A thin DOM helper layer. We use @xmldom/xmldom in both the renderer and the
 * test runner so parsing/serialization behaves identically everywhere.
 */

const ELEMENT_NODE = 1;

export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
}

export function serializeNode(node: Node): string {
  // xmldom's serializer accepts the same runtime shape; cast past the type gap.
  return new XMLSerializer().serializeToString(node as never);
}

const TEXT_NODE = 3;

function stripWhitespaceNodes(node: Node): void {
  const kids = node.childNodes;
  for (let i = kids.length - 1; i >= 0; i--) {
    const c = kids.item(i)!;
    if (c.nodeType === TEXT_NODE && (c.nodeValue ?? '').trim() === '') {
      node.removeChild(c);
    } else if (c.nodeType === ELEMENT_NODE) {
      stripWhitespaceNodes(c);
    }
  }
}

/**
 * Serialize an element for verbatim round-trip storage, with ignorable
 * inter-element whitespace removed so the result is a single compact block.
 * This keeps re-indentation by the serializer idempotent (no drift), while
 * preserving all real content (element text, CDATA, attributes, namespaces).
 */
export function serializeStripped(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  stripWhitespaceNodes(clone);
  return serializeNode(clone);
}

/** Local tag name without namespace prefix (e.g. "gx:Track" -> "Track"). */
export function localName(el: Element): string {
  const n = el.nodeName;
  const c = n.indexOf(':');
  return c >= 0 ? n.slice(c + 1) : n;
}

/** Direct child elements. */
export function childElements(el: Element): Element[] {
  const out: Element[] = [];
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids.item(i)!;
    if (n.nodeType === ELEMENT_NODE) out.push(n as Element);
  }
  return out;
}

/** First direct child element with the given local name. */
export function firstChild(el: Element, tag: string): Element | null {
  for (const c of childElements(el)) {
    if (localName(c) === tag) return c;
  }
  return null;
}

/** All direct child elements with the given local name. */
export function childrenNamed(el: Element, tag: string): Element[] {
  return childElements(el).filter((c) => localName(c) === tag);
}

/** Trimmed text content of an element (or '' if absent). */
export function textOf(el: Element | null): string {
  if (!el) return '';
  return (el.textContent ?? '').trim();
}

/** Text of a named direct child, or undefined if the child is absent. */
export function childText(el: Element, tag: string): string | undefined {
  const c = firstChild(el, tag);
  return c ? (c.textContent ?? '').trim() : undefined;
}

/** True if the element's only content is a single CDATA section. */
export function hasCdata(el: Element | null): boolean {
  if (!el) return false;
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (kids.item(i)!.nodeType === 4 /* CDATA_SECTION_NODE */) return true;
  }
  return false;
}

export function boolText(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

export function numText(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
