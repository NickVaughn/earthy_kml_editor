/**
 * KML colors are 8 hex digits in **aabbggrr** order (alpha, blue, green, red) —
 * NOT the rrggbbaa most tools use. This module is the single source of truth for
 * the conversion; everything else must go through it.
 */

export interface Rgba {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  a: number; // 0-255
}

const HEX = /^[0-9a-fA-F]{8}$/;

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex2(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

/** Parse an aabbggrr KML color. Returns opaque white for malformed input. */
export function kmlToRgba(kml: string): Rgba {
  const s = kml.trim();
  if (!HEX.test(s)) return { r: 255, g: 255, b: 255, a: 255 };
  const a = parseInt(s.slice(0, 2), 16);
  const b = parseInt(s.slice(2, 4), 16);
  const g = parseInt(s.slice(4, 6), 16);
  const r = parseInt(s.slice(6, 8), 16);
  return { r, g, b, a };
}

/** Serialize to an aabbggrr KML color string (lowercase). */
export function rgbaToKml({ r, g, b, a }: Rgba): string {
  return `${hex2(a)}${hex2(b)}${hex2(g)}${hex2(r)}`;
}

/** CSS `rgba(r, g, b, a)` with alpha in 0..1 — for DOM/UI use. */
export function kmlToCss(kml: string): string {
  const { r, g, b, a } = kmlToRgba(kml);
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** `#rrggbb` (no alpha) — for <input type="color">. */
export function kmlToHexRgb(kml: string): string {
  const { r, g, b } = kmlToRgba(kml);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Combine an `#rrggbb` picker value with a separate 0..1 alpha into a KML color. */
export function hexRgbToKml(hex: string, alpha01: number): string {
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0, 2), 16) || 0;
  const g = parseInt(s.slice(2, 4), 16) || 0;
  const b = parseInt(s.slice(4, 6), 16) || 0;
  return rgbaToKml({ r, g, b, a: clampByte(alpha01 * 255) });
}
