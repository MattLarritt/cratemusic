# Source artwork

The originals as supplied. Everything crate serves is generated from these — do
not edit the generated files, replace these and re-run the scripts below.

| File | Becomes |
| --- | --- |
| `crate - hoz lg.png` | `logo-wordmark.svg` and the `WORDMARK` path — the header |
| `crate.png` | `logo-stacked.svg` and the `STACKED` path — the sign-in card |
| `crate - notext.png` | `icon.svg`, every favicon, the apple-touch-icon and the manifest icons |

## Regenerating

Two scripts, because they need different things.

```bash
# Vectors and the inline path module. Needs potracer + numpy.
PYTHONPATH=<dir containing potracer,numpy> python3 brand/trace.py

# The platform icon bitmaps. Needs Pillow only.
python3 brand/generate.py
```

`trace.py` writes `web/public/*.svg` and `web/src/logo.ts`; `generate.py` writes
the PNG icon set. Between them they are the only things that should write to
`web/public/`.

## Why it is shaped this way

**The logo is inline SVG, not an image.** `currentColor` cannot cross an `<img>`
boundary — an SVG loaded that way is its own document and resolves it against
black — so the mark is inlined and takes `color` from the theme like text. An
earlier PNG version had to be inverted with a CSS filter to survive the dark
theme, which worked but made the logo's colour a side effect rather than
something stated.

**The favicon carries its own theming.** It is an isolated document too, but it
honours an internal `<style>`, so a `prefers-color-scheme` block inside the file
recolours it. One file replaces what was previously two pre-inverted PNG cuts
and a pair of media-qualified `<link>` tags.

**Tracing blurs the alpha first.** The sources have binary alpha — no
antialiasing at all — so every edge is a pixel staircase and potrace faithfully
traces every step of it. Straight from the source the wordmark came out at
62 KB, larger than the PNG it replaced. A one-pixel blur before thresholding
rounds the steps off: 8 KB, no visible change.

**`fill-rule="evenodd"` is load-bearing.** The disc's hole, the crate's handle
slot and the bowl of every letter are separate subpaths that have to read as
holes rather than as filled shapes stacked on top.

**The remaining PNGs exist because platforms demand bitmaps.** iOS composites
`apple-touch-icon` onto black and rounds it itself, so that one has an opaque
ground. Android crops maskable icons to a circle, so that one is inset to the
safe zone or the crate loses its corners.

## A bug worth not repeating

An earlier `generate.py` quantised to a fifteen-colour palette and then pasted
palette index 255 for the transparent region — an index that palette did not
contain. The background collapsed to index 0 and the logo shipped as a solid
black rectangle, while the `tRNS` chunk it wrote marked an index nothing
referenced, so the file looked correct to anything that only checked whether
transparency had been declared.

`generate.py` now builds a two-entry palette by hand and, after writing each
file, reads it back and asserts the alpha survived. Checking the artefact rather
than the intent is the only thing that would have caught it.
