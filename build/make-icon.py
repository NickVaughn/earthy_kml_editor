#!/usr/bin/env python3
"""
Generate the Earthy app icon: a globe with a two-vertex linestring drawn on it.

Source of truth for the artwork is this script (build/icon.svg mirrors it for
anyone who wants to edit in a vector editor). Everything is drawn in unit
coordinates and supersampled, so the shapes stay identical at every size.

    python3 build/make-icon.py

Writes build/icon.png (1024), build/icon.ico, and build/icon.icns —
the three files electron-builder picks up for Linux, Windows and macOS.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).parent
SIZE = 1024
SS = 4  # supersampling factor; downsampled with Lanczos for clean edges

OCEAN = (24, 86, 148, 255)
OCEAN_DEEP = (14, 56, 100, 255)
LAND = (74, 158, 86, 255)
LINE = (0, 229, 255, 255)  # the app's selection colour
CASING = (10, 26, 40, 255)  # dark outline so the line reads on any background
VERTEX = (255, 255, 255, 255)

# Abstract landmasses in unit coordinates — suggestive of continents, not a map.
# Kept irregular (no regular polygons) so they read as coastline at a glance.
LANDMASSES = [
    [(0.19, 0.37), (0.24, 0.28), (0.33, 0.24), (0.42, 0.28), (0.46, 0.35),
     (0.41, 0.41), (0.37, 0.49), (0.30, 0.51), (0.25, 0.45), (0.18, 0.43)],
    [(0.54, 0.25), (0.62, 0.18), (0.74, 0.21), (0.83, 0.30), (0.80, 0.38),
     (0.71, 0.41), (0.62, 0.37), (0.55, 0.33)],
    [(0.61, 0.49), (0.71, 0.50), (0.77, 0.58), (0.74, 0.70), (0.66, 0.79),
     (0.60, 0.71), (0.57, 0.58)],
    [(0.30, 0.61), (0.39, 0.63), (0.41, 0.72), (0.36, 0.81), (0.30, 0.77),
     (0.27, 0.68)],
]

# The linestring: two vertices, a short run across the globe.
V1 = (0.30, 0.68)
V2 = (0.70, 0.37)

CX, CY, R = 0.5, 0.5, 0.455
LINE_W = 0.042
VERTEX_R = 0.052


def px(pt, s):
    return (pt[0] * s, pt[1] * s)


def draw_icon(s: int, simplify: bool = False) -> Image.Image:
    """Render at `s` pixels. `simplify` drops the small landmasses and fattens
    the linework — below ~32px the full artwork collapses into mush, and an
    .iconset is allowed to carry different art per size."""
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    landmasses = LANDMASSES[:2] if simplify else LANDMASSES
    line_w = LINE_W * (1.45 if simplify else 1.0)
    vertex_r = VERTEX_R * (1.30 if simplify else 1.0)
    casing_w = 0.012 if simplify else 0.022

    box = [(CX - R) * s, (CY - R) * s, (CX + R) * s, (CY + R) * s]

    # Globe body, with a slightly deeper rim so the sphere reads as round.
    d.ellipse(box, fill=OCEAN)
    rim = R * 0.055 * s
    d.ellipse(box, outline=OCEAN_DEEP, width=int(rim))

    # Landmasses on their own layer, then clipped to the globe.
    land = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ld = ImageDraw.Draw(land)
    for poly in landmasses:
        ld.polygon([px(p, s) for p in poly], fill=LAND)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse(
        [(CX - R * 0.945) * s, (CY - R * 0.945) * s,
         (CX + R * 0.945) * s, (CY + R * 0.945) * s],
        fill=255,
    )
    img.paste(land, (0, 0), Image.composite(mask, Image.new("L", (s, s), 0), land.split()[3]))

    # The linestring, drawn casing-first so it stays legible over land or ocean.
    a, b = px(V1, s), px(V2, s)
    d.line([a, b], fill=CASING, width=int((line_w + casing_w) * s))
    d.line([a, b], fill=LINE, width=int(line_w * s))

    # Two vertices as dots at the ends.
    for pt in (a, b):
        for radius, colour in (
            (vertex_r + casing_w * 0.5, CASING),
            (vertex_r, LINE),
            (vertex_r * 0.42, VERTEX),
        ):
            r = radius * s
            d.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=colour)

    return img


def rgb(c) -> str:
    return "#%02x%02x%02x" % c[:3]


def write_svg() -> None:
    """Emit the same artwork as SVG, from the same constants, so the vector
    source can't drift from the rasters."""
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1024" height="1024">',
        "  <defs><clipPath id=\"globe\">"
        f'<circle cx="{CX}" cy="{CY}" r="{R * 0.945:.4f}"/></clipPath></defs>',
        f'  <circle cx="{CX}" cy="{CY}" r="{R:.4f}" fill="{rgb(OCEAN)}"'
        f' stroke="{rgb(OCEAN_DEEP)}" stroke-width="{R * 0.055:.4f}"/>',
        '  <g clip-path="url(#globe)">',
    ]
    for poly in LANDMASSES:
        pts = " ".join(f"{x},{y}" for x, y in poly)
        parts.append(f'    <polygon points="{pts}" fill="{rgb(LAND)}"/>')
    parts.append("  </g>")
    for width, colour in ((LINE_W + 0.022, CASING), (LINE_W, LINE)):
        parts.append(
            f'  <line x1="{V1[0]}" y1="{V1[1]}" x2="{V2[0]}" y2="{V2[1]}"'
            f' stroke="{rgb(colour)}" stroke-width="{width:.4f}" stroke-linecap="butt"/>'
        )
    for pt in (V1, V2):
        for radius, colour in (
            (VERTEX_R + 0.011, CASING),
            (VERTEX_R, LINE),
            (VERTEX_R * 0.42, VERTEX),
        ):
            parts.append(
                f'  <circle cx="{pt[0]}" cy="{pt[1]}" r="{radius:.4f}" fill="{rgb(colour)}"/>'
            )
    parts.append("</svg>\n")
    (BUILD / "icon.svg").write_text("\n".join(parts))


def main() -> int:
    master = draw_icon(SIZE * SS).resize((SIZE, SIZE), Image.LANCZOS)
    master.save(BUILD / "icon.png")
    write_svg()

    # Windows: multi-resolution .ico, each entry drawn at its own size so the
    # small ones get the simplified artwork rather than a mushy downsample.
    # Pillow skips any requested size larger than the image it is saving from,
    # so the base image must be the biggest one.
    ico_sizes = (256, 128, 64, 48, 32, 24, 16)
    ico_images = [
        draw_icon(s * SS, simplify=s < 32).resize((s, s), Image.LANCZOS)
        for s in ico_sizes
    ]
    ico_images[0].save(
        BUILD / "icon.ico",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:],
    )

    # macOS: .iconset -> .icns via iconutil.
    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            s = base * scale
            suffix = "" if scale == 1 else "@2x"
            src = draw_icon(s * SS, simplify=s < 32).resize((s, s), Image.LANCZOS)
            src.save(iconset / f"icon_{base}x{base}{suffix}.png")
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"iconutil unavailable ({e}); .icns not generated", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(iconset)

    print(
        f"wrote {BUILD/'icon.png'}, {BUILD/'icon.svg'}, "
        f"{BUILD/'icon.ico'}, {BUILD/'icon.icns'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
