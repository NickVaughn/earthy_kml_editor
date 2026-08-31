/**
 * Point icons Earthy can write into a KML `<IconStyle><Icon><href>`.
 *
 * KML says an IconStyle with no href means "the reader's default icon", and
 * Google Earth's default is the yellow pushpin — which it then tints by the
 * style's colour. Earthy's globe draws a plain coloured dot instead, so a file
 * with no href looked one way here and another way there. Writing an explicit
 * href is what makes the two agree.
 *
 * The hrefs are the long-standing Google KML shape URLs: every KML reader
 * recognises them, and Google Earth renders them without a round trip. Saving
 * as KMZ embeds a local copy instead (see main/icons.ts), so an archive stays
 * self-contained and works offline.
 */

export interface IconChoice {
  /** Stable id, also the embedded file's basename inside a KMZ. */
  id: string;
  label: string;
  /** Canonical remote href, written into plain .kml. */
  href: string;
}

/**
 * A circle with a dot inside — the closest standard shape to the dot Earthy's
 * globe draws, and the default for styles Earthy authors.
 */
export const DEFAULT_ICON_ID = 'circle';

const SHAPES = 'https://maps.google.com/mapfiles/kml/shapes';

export const POINT_ICONS: IconChoice[] = [
  { id: 'circle', label: 'Circle (dot)', href: `${SHAPES}/placemark_circle.png` },
  { id: 'donut', label: 'Donut', href: `${SHAPES}/donut.png` },
  { id: 'target', label: 'Target', href: `${SHAPES}/target.png` },
  { id: 'square', label: 'Square', href: `${SHAPES}/placemark_square.png` },
  { id: 'triangle', label: 'Triangle', href: `${SHAPES}/triangle.png` },
  { id: 'diamond', label: 'Open diamond', href: `${SHAPES}/open-diamond.png` },
  { id: 'star', label: 'Star', href: `${SHAPES}/star.png` },
  {
    id: 'pushpin',
    label: 'Pushpin',
    href: 'https://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png',
  },
];

export const DEFAULT_ICON_HREF: string =
  POINT_ICONS.find((i) => i.id === DEFAULT_ICON_ID)!.href;

/**
 * Path an icon takes inside a KMZ. Prefixed so it cannot collide with an image
 * the source archive already carried, and carrying the catalog id so the file
 * still identifies its own icon after a round trip.
 */
export function embeddedIconPath(id: string): string {
  return `files/earthy-icon-${id}.png`;
}

/**
 * The catalog entry for an href. Matches the remote form regardless of
 * http/https spelling, and the KMZ-embedded form, so an archive Earthy wrote
 * reopens with its icon still recognised rather than looking custom.
 * Undefined for a genuinely custom icon.
 */
export function iconChoiceByHref(href: string | undefined): IconChoice | undefined {
  if (!href) return undefined;
  const file = href.split('/').pop()?.toLowerCase();
  if (!file) return undefined;
  const embedded = /^earthy-icon-(.+)\.png$/.exec(file);
  if (embedded) return POINT_ICONS.find((i) => i.id === embedded[1]);
  return POINT_ICONS.find((i) => i.href.split('/').pop()?.toLowerCase() === file);
}
