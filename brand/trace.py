#!/usr/bin/env python3
"""
Trace the logo artwork into SVG.

    PYTHONPATH=<dir with potracer+numpy> python3 brand/trace.py

Separate from generate.py because it needs potracer and numpy, which are not
worth making a hard dependency of a script that otherwise runs on Pillow alone.
The SVGs it produces are committed, so this only needs running when the source
artwork changes.

Two details that matter for output size.

The sources have BINARY alpha — no antialiasing at all — so every edge is a
pixel staircase, and potrace faithfully traces every step of it. Tracing
straight from them produced a 62 KB path for the wordmark, larger than the PNG
it was meant to replace. A one-pixel blur before thresholding rounds the steps
off and more than halves the segment count with no visible change.

And fill-rule="evenodd" is load-bearing: the disc's hole, the crate's handle
slot and the bowl of every letter are separate subpaths that must read as
holes, not as filled shapes stacked on top.
"""
import os
import re
import sys

import numpy as np
import potrace
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'web', 'public')

# Enough to round a one-pixel staircase, not enough to move an edge.
BLUR = 1.0

# The artwork's own colour, for the favicon — the one place that cannot inherit
# it from the page.
INK = '#1c1d1f'


def trace(src, out, label):
    im = Image.open(os.path.join(HERE, src)).convert('RGBA')
    im = im.crop(im.getbbox())

    a = np.array(im.getchannel('A').filter(ImageFilter.GaussianBlur(BLUR)))
    ink = a > 128

    # potracer traces the FALSE region, not the true one — the opposite of what
    # the name suggests. Passing `ink` directly traced the background instead,
    # producing one shape covering the whole canvas with the letters punched
    # out of it, so the logo rendered as a filled block. Inverting is the fix;
    # the assertion below is what stops it shipping again if this ever flips.
    path = potrace.Bitmap(~ink).trace(
        turdsize=2, alphamax=1.0, opticurve=True, opttolerance=0.2,
    )



    def f(v):
        # Two decimals is far under a pixel at any size this renders at.
        s = f'{v:.2f}'.rstrip('0').rstrip('.')
        return '0' if s in ('', '-0') else s

    d = []
    for curve in path:
        st = curve.start_point
        d.append(f'M{f(st.x)} {f(st.y)}')
        for seg in curve:
            e = seg.end_point
            if seg.is_corner:
                d.append(f'L{f(seg.c.x)} {f(seg.c.y)}L{f(e.x)} {f(e.y)}')
            else:
                d.append(
                    f'C{f(seg.c1.x)} {f(seg.c1.y)} {f(seg.c2.x)} {f(seg.c2.y)} {f(e.x)} {f(e.y)}'
                )
        d.append('Z')

    if out == 'icon.svg':
        # The favicon is the ink colour on transparency, flat. It was briefly
        # self-theming — an internal <style> with a prefers-color-scheme block,
        # since a favicon is an isolated document and cannot use currentColor —
        # but the mark is wanted dark everywhere, so the query is gone and the
        # fill is stated once. Transparency means it sits on whatever the tab
        # strip is rather than carrying a ground of its own.
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {im.width} {im.height}" '
            f'role="img" aria-label="{label}">'
            f'<path fill="{INK}" fill-rule="evenodd" d="{"".join(d)}"/>'
            f'</svg>'
        )
    else:
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {im.width} {im.height}" '
            f'role="img" aria-label="{label}">'
            f'<path fill="currentColor" fill-rule="evenodd" d="{"".join(d)}"/>'
            f'</svg>'
        )
    verify(''.join(d), ink, out)

    dest = os.path.join(OUT, out)
    open(dest, 'w').write(svg)
    print('  %-22s %6d B  viewBox 0 0 %d %d' % (out, len(svg), im.width, im.height))
    return ''.join(d), im.width, im.height


def verify(d, ink, out):
    """
    Sample the traced path and compare it to the source. Fail if they disagree.

    This exists because the polarity was wrong and shipped: potracer traces the
    FALSE region, so passing the ink mask directly traced the background, and
    the logo rendered as a filled block with the letters knocked out of it. A
    geometry heuristic — "does any subpath span the whole canvas" — did not
    catch it, because on the icon the crate legitimately does.

    Comparing what the path actually FILLS against what the artwork actually
    covers is the only check that cannot be fooled by that. An inverted trace
    scores near zero here; a correct one scores about 99, the shortfall being
    edge pixels the blur moved by a fraction.
    """
    polys, cur, pos = [], [], (0.0, 0.0)
    for m in re.finditer(r'([MLCZ])([^MLCZ]*)', d):
        cmd = m.group(1)
        args = [float(x) for x in re.findall(r'-?\d+\.?\d*', m.group(2))]
        if cmd == 'M':
            if cur:
                polys.append(cur)
            pos = (args[0], args[1])
            cur = [pos]
        elif cmd == 'L':
            pos = (args[0], args[1])
            cur.append(pos)
        elif cmd == 'C':
            p0 = pos
            for i in range(0, len(args), 6):
                c1 = (args[i], args[i + 1])
                c2 = (args[i + 2], args[i + 3])
                e = (args[i + 4], args[i + 5])
                for st in range(1, 9):
                    t = st / 8.0
                    u = 1 - t
                    cur.append((
                        u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * e[0],
                        u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * e[1],
                    ))
                p0 = e
            pos = p0
        elif cmd == 'Z':
            if cur:
                polys.append(cur)
                cur = []
    if cur:
        polys.append(cur)

    def inside(x, y):
        c = False
        for poly in polys:
            n = len(poly)
            for i in range(n):
                x1, y1 = poly[i]
                x2, y2 = poly[(i + 1) % n]
                if (y1 > y) != (y2 > y):
                    if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                        c = not c
        return c

    h, w = ink.shape
    agree = total = 0
    # Inset from the edges: the blur legitimately shifts the outermost pixels.
    for gy in range(3, 60):
        for gx in range(3, 120):
            x = w * gx / 123.0
            y = h * gy / 63.0
            total += 1
            agree += (bool(ink[int(y), int(x)]) == inside(x, y))
    pct = 100.0 * agree / total
    if pct < 97.0:
        sys.exit(
            f'{out}: traced path matches the artwork at only {pct:.1f}% of sampled '
            f'points — the trace is wrong (a flipped polarity scores near zero)'
        )
    return pct


def main():
    paths = {
        'WORDMARK': trace('crate - hoz lg.png', 'logo-wordmark.svg', 'Crate'),
        'STACKED': trace('crate.png', 'logo-stacked.svg', 'Crate'),
        'MARK': trace('crate - notext.png', 'icon.svg', 'Crate'),
    }
    emit_module(paths)


def emit_module(paths):
    """
    Also emit the paths as a TypeScript module, for inlining into the page.

    `currentColor` cannot cross an <img> boundary — an SVG loaded that way is a
    separate document and resolves it against its own initial colour, which is
    black. Inlining is what makes the logo simply take `color` from the theme,
    instead of the invert filter this replaces. It also means the mark is part
    of the first paint rather than a second request that lands after it.
    """
    dest = os.path.join(HERE, '..', 'web', 'src', 'logo.ts')
    lines = [
        '// GENERATED by brand/trace.py — do not edit.',
        '// Replace the artwork in brand/ and re-run it instead.',
        '',
    ]
    for name, (d, w, h) in paths.items():
        lines.append(f'export const {name} = {{')
        lines.append(f'  w: {w},')
        lines.append(f'  h: {h},')
        lines.append(f"  d: '{d}',")
        lines.append('};')
        lines.append('')
    open(dest, 'w').write('\n'.join(lines))
    print('  %-22s %6d B' % ('src/logo.ts', sum(len(l) for l in lines)))


if __name__ == '__main__':
    main()
