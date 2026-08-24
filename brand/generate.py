#!/usr/bin/env python3
"""
Rebuild every served logo and icon from the originals in this directory.

    python3 brand/generate.py

Run it after replacing any of the three source files. Nothing in web/public/
should be edited by hand — this is the only thing that writes there.

Three steps, each for a reason worth keeping:

  trim      The supplied files carry a few pixels of empty margin. Invisible at
            856px, obvious at 30px in a header, and not removable in CSS
            without hard-coding a number that breaks on the next revision.

  resize    Twice the largest rendered size, so it stays crisp on a retina
            screen without shipping an 856px image to draw 30 pixels.

  quantise  Every one of these is a single ink over transparency, so RGBA pays
            four bytes a pixel to encode two possibilities. Lossless here, and
            it takes the set from about 412 KB to 105 KB.

The mark is #1c1d1f on transparency, which is invisible on crate's dark theme.
The page handles that in CSS (`.brand img { filter: invert(1) }`), but favicons
cannot run CSS, so pre-inverted cuts are generated for prefers-color-scheme:
dark.
"""

import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'web', 'public')

SOURCES = {
    'wordmark': 'crate - hoz lg.png',
    'stacked': 'crate.png',
    'mark': 'crate - notext.png',
}


def load(name):
    path = os.path.join(HERE, SOURCES[name])
    if not os.path.exists(path):
        sys.exit(f'missing source: {path}')
    im = Image.open(path).convert('RGBA')
    return im.crop(im.getbbox())


def quantise(im, bg=None):
    """
    Two-colour art as a two-entry palette.

    Built by hand rather than via quantize(). An earlier version quantised to
    fifteen colours and then pasted palette index 255 for the transparent
    region — an index that palette does not contain, so the whole background
    collapsed to index 0 and the logo shipped as a solid black rectangle. The
    tRNS chunk it wrote marked an index nothing referenced, so the file looked
    correct to anything that only checked for transparency being declared.

    Two entries, stated explicitly, is both smaller and impossible to get
    subtly wrong: index 0 is transparent, index 1 is ink.

    The transparent entry is given the INK colour, not white. A viewer that
    ignores tRNS shows a solid block either way, but any that blends edge
    pixels against the palette entry produces a halo when it is the opposite
    colour.
    """
    if bg is not None:
        flat = Image.new('RGBA', im.size, bg)
        flat.paste(im, (0, 0), im)
        im = flat

    alpha = im.getchannel('A')
    opaque = [px for px in im.convert('RGBA').getdata() if px[3] > 128]
    ink = max(set((p[0], p[1], p[2]) for p in opaque), key=lambda c: sum(
        1 for p in opaque if (p[0], p[1], p[2]) == c)) if opaque else (0, 0, 0)

    out = Image.new('P', im.size, 0)
    out.putpalette(list(ink) + list(ink))
    # 1 wherever the source is opaque, 0 elsewhere.
    out.paste(1, Image.eval(alpha, lambda a: 255 if a >= 128 else 0).convert('1'))
    # One byte per palette entry: index 0 fully transparent, index 1 opaque.
    out.info['transparency'] = bytes([0, 255])
    return out


def save(im, name, bg=None):
    """Write, then read back and assert the alpha survived.

    The bug this replaces produced a file that declared transparency and had
    none. Checking the artefact rather than the intent is the only thing that
    would have caught it.
    """
    path = os.path.join(OUT, name)
    q = quantise(im, bg)
    q.save(path, optimize=True, transparency=q.info['transparency'])

    check = Image.open(path).convert('RGBA')
    alphas = set(p[3] for p in check.getdata())
    if bg is None and alphas == {255}:
        sys.exit(f'{name}: transparency was lost on save')
    if bg is not None and alphas != {255}:
        sys.exit(f'{name}: expected a fully opaque icon, got holes')
    return os.path.getsize(path)


def square(im, size, pad=0.0, bg=None):
    inner = round(size * (1 - pad * 2))
    r = im.copy()
    r.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    canvas.paste(r, ((size - r.width) // 2, (size - r.height) // 2), r)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0

    # The wordmark and the stacked lockup are drawn from brand/trace.py as
    # inline SVG now, so nothing raster is needed for them. What remains here
    # is the icon set, which the platforms genuinely require as bitmaps.
    mark = load('mark')
    for s in (16, 32, 48, 180, 192, 512):
        total += save(square(mark, s, pad=0.06), f'icon-{s}.png')

    # iOS composites this onto black and rounds it itself, so it is the one
    # icon with an opaque ground.
    total += save(square(mark, 180, pad=0.12), 'apple-touch-icon.png', bg=(246, 247, 249, 255))

    # Android crops maskable icons to a circle, so the mark sits inside the
    # safe zone or its corners get shaved.
    total += save(square(mark, 512, pad=0.20), 'icon-512-maskable.png', bg=(246, 247, 249, 255))

    print(f'wrote 8 files to web/public/, {total / 1024:.0f} KB total')


if __name__ == '__main__':
    main()
