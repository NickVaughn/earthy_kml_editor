/**
 * Square vertex-handle markers for the draw/edit tools. Cesium points are always
 * round, so we render a small square to a canvas and show it as a billboard —
 * matching Google Earth's square vertex handles. Images are cached per colour.
 */

/** Display size (px) of a vertex handle billboard. */
export const HANDLE_SIZE = 11;

const cache = new Map<string, HTMLCanvasElement>();

/** A crisp white/coloured square (drawn at 2× for retina), cached by colours. */
export function squareMarker(fill: string, outline: string): HTMLCanvasElement {
  const key = `${fill}|${outline}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const S = 32; // canvas resolution; the billboard scales it to HANDLE_SIZE
  const ow = 5; // outline width in canvas pixels
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(ow / 2, ow / 2, S - ow, S - ow);
  ctx.lineWidth = ow;
  ctx.strokeStyle = outline;
  ctx.strokeRect(ow / 2, ow / 2, S - ow, S - ow);
  cache.set(key, canvas);
  return canvas;
}

/** The standard vertex handle: white fill, cyan outline. */
export function vertexMarker(): HTMLCanvasElement {
  return squareMarker('#ffffff', '#00e5ff');
}
