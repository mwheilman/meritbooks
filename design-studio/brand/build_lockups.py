#!/usr/bin/env python3
"""
Merit Enterprise Suite — product lockup builder.

Generates the official "Merit <Product>" lockups (horizontal + vertical, four colour variants,
SVG + PNG) for every suite module, so every product name is tied into the Merit logo the same way.

How the lockup is built (see MERIT-SUITE-STYLE-GUIDE.md §1.3):
  * Monogram: Merit's own vector paths (merit_logo.svg, Merit Management Dropbox /Logo Files).
  * "Merit" wordmark: Syne Bold — the wordmark typeface — fitted to the official 2026 horizontal
    logo. Verified: the rebuilt logo differs from the official PNG on 5 of 47,880 pixels.
  * Product word: the SAME typeface, size, tracking and baseline as "Merit", separated from it by
    the SAME gap that separates the monogram from "Merit". Colour = the brand blue for the
    background (Electric Blue on light, Signal Blue on Midnight).

Usage:
  pip install fonttools uharfbuzz cairosvg
  python3 build_lockups.py                      # builds the standard module set
  python3 build_lockups.py "Field Service" Fleet  # builds extra modules too
  python3 build_lockups.py --out ../logos/lockups  # choose the output folder
Output (default): ./lockups/svg/*.svg and ./lockups/png/*.png
Never typeset a lockup with live text in HTML/CSS — always use these generated files.
"""
import io
import os
import re
import sys

import cairosvg
import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_VAR = os.path.join(HERE, "fonts", "Syne[wght].ttf")

# ---------------------------------------------------------------- brand colours (exact)
ELECTRIC, SIGNAL, MIDNIGHT, WARM, WHITE = "#2563EB", "#3B82F6", "#0A1628", "#FDFCFA", "#FFFFFF"
VARIANTS = {
    #  name        monogram   "Merit"   product   intended background
    "full-color": (ELECTRIC, MIDNIGHT, ELECTRIC),   # Warm White / white
    "on-dark":    (ELECTRIC, WARM,     SIGNAL),     # Midnight (app rail, dark sections)
    "white":      (WHITE,    WHITE,    WHITE),      # Electric Blue fills, photography
    "midnight":   (MIDNIGHT, MIDNIGHT, MIDNIGHT),   # one-colour print, stamps, embossing
}
STANDARD_MODULES = ["Books", "Projects", "CRM", "FP&A", "Inventory", "Payroll", "HR", "Platform"]

# ---------------------------------------------------------------- monogram (Merit's vector file)
MONO_PATHS = [
    "M19.7385 25.9832L18.0627 27.6589L21.6571 31.2533L23.3329 29.5776L19.7385 25.9832Z",
    "M25.1067 27.8178L21.5004 24.2458L20.1265 25.5853L19.7144 25.9975L23.3207 29.6039L23.7329 29.1917L25.1067 27.8178Z",
    "M45.0963 0.615723L26.8928 18.8192L30.4992 22.4255L45.0963 7.82841V45.3001H50.2139V0.615723H45.0963Z",
    "M5.08323 0.615723H0V45.2314H5.08323V25.7228L24.5919 45.2314H31.8046L5.08323 18.5101V7.82841L21.2259 23.9711L25.2444 27.9896L33.1441 35.8892V28.6765L5.08323 0.615723Z",
]
MONO_W, MONO_Y0, MONO_Y1 = 50.2139, 0.615723, 45.3001
MONO_H = MONO_Y1 - MONO_Y0

# ---------------------------------------------------------------- geometry (fractions of H = monogram height)
# Fitted to the official 2026 horizontal logo (120px master).
GAP = 26.5 / 120      # monogram -> "Merit"   (also "Merit" -> product)
CAP_H = 55.5 / 120    # wordmark cap height
BASE = 88.0 / 120     # baseline, from the top of the monogram
TRACK = 0.002         # tracking in em
# Vertical (guide p.08): wordmark cap height = 0.5 H, monogram -> cap gap = 0.15 H
V_CAP, V_GAP = 0.5, 0.15

# ---------------------------------------------------------------- font
_var = TTFont(FONT_VAR)
_tt = instantiateVariableFont(_var, {"wght": 700})
_buf = io.BytesIO()
_tt.save(_buf)
_gs = _tt.getGlyphSet()
_hbfont = hb.Font(hb.Face(hb.Blob(_buf.getvalue())))
UPM = _tt["head"].unitsPerEm
CAP = _tt["OS/2"].sCapHeight / UPM
DESC = abs(_tt["hhea"].descent) / UPM


def _shape(text, size):
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(_hbfont, buf, {"kern": True, "liga": True})
    s, x, out = size / UPM, 0.0, []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        out.append((_tt.getGlyphName(info.codepoint), x + pos.x_offset * s, pos.y_offset * s))
        x += pos.x_advance * s + TRACK * size
    lo = hi = None
    for name, gx, _ in out:
        bp = BoundsPen(_gs)
        _gs[name].draw(bp)
        if bp.bounds:
            a, b = gx + bp.bounds[0] * s, gx + bp.bounds[2] * s
            lo, hi = (a if lo is None else min(lo, a)), (b if hi is None else max(hi, b))
    return out, s, lo, hi


def _text(text, size, x_ink, baseline):
    glyphs, s, lo, hi = _shape(text, size)
    pen = SVGPathPen(_gs, ntos=lambda v: f"{v:.2f}")
    for name, gx, gy in glyphs:
        _gs[name].draw(TransformPen(pen, (s, 0, 0, -s, x_ink - lo + gx, baseline - gy)))
    return pen.getCommands(), x_ink - lo + hi


def _mono(x, y, h, fill):
    k = h / MONO_H
    return (f'<g transform="translate({x:.3f} {y - MONO_Y0 * k:.3f}) scale({k:.5f})" fill="{fill}">'
            + "".join(f'<path d="{d}"/>' for d in MONO_PATHS) + "</g>"), MONO_W * k


def _svg(w, h, body, title):
    title = title.replace("&", "&amp;")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.2f}" '
            f'height="{h:.2f}" role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n')


def horizontal(product, variant, h=120.0):
    cm, cw, cp = VARIANTS[variant]
    g, mw = _mono(0, 0, h, cm)
    size = CAP_H / CAP * h
    d1, r = _text("Merit", size, mw + GAP * h, BASE * h)
    body = g + f'<path fill="{cw}" d="{d1}"/>'
    if product:
        d2, r = _text(product, size, r + GAP * h, BASE * h)
        body += f'<path fill="{cp}" d="{d2}"/>'
    return _svg(r, h, body, f"Merit {product}" if product else "Merit")


def vertical(product, variant, h=120.0):
    cm, cw, cp = VARIANTS[variant]
    cap = V_CAP * h
    size = cap / CAP
    gap = GAP / CAP_H * cap
    _, _, lo1, hi1 = _shape("Merit", size)
    line = hi1 - lo1
    if product:
        _, _, lo2, hi2 = _shape(product, size)
        line += gap + (hi2 - lo2)
    mw = MONO_W * h / MONO_H
    W = max(line, mw)
    g, _ = _mono((W - mw) / 2, 0, h, cm)
    base = h + V_GAP * h + cap
    d1, r = _text("Merit", size, (W - line) / 2, base)
    body = g + f'<path fill="{cw}" d="{d1}"/>'
    if product:
        d2, _ = _text(product, size, r + gap, base)
        body += f'<path fill="{cp}" d="{d2}"/>'
    return _svg(W, base + DESC * size, body, f"Merit {product}" if product else "Merit")


def icon(variant, h=120.0):
    g, w = _mono(0, 0, h, VARIANTS[variant][0])
    return _svg(w, h, g, "Merit")


def slug(product):
    return re.sub(r"[^a-z0-9]+", "-", product.lower().replace("&", "")).strip("-")


def main(products, out):
    out_svg, out_png = os.path.join(out, "svg"), os.path.join(out, "png")
    os.makedirs(out_svg, exist_ok=True)
    os.makedirs(out_png, exist_ok=True)
    jobs = []
    for v in VARIANTS:
        jobs.append((f"merit-icon-{v}", icon(v), 512))                     # PNG height
        jobs.append((f"merit-horizontal-{v}", horizontal(None, v), 240))
        jobs.append((f"merit-vertical-{v}", vertical(None, v), 480))
        for p in products:
            jobs.append((f"merit-{slug(p)}-horizontal-{v}", horizontal(p, v), 240))
            jobs.append((f"merit-{slug(p)}-vertical-{v}", vertical(p, v), 480))
    for name, svg, ph in jobs:
        with open(os.path.join(out_svg, name + ".svg"), "w") as f:
            f.write(svg)
        cairosvg.svg2png(bytestring=svg.encode(), write_to=os.path.join(out_png, name + ".png"), output_height=ph)
    print(f"built {len(jobs)} lockups x 2 formats for: {', '.join(products)}")


if __name__ == "__main__":
    args, out = sys.argv[1:], os.path.join(HERE, "lockups")
    if "--out" in args:
        i = args.index("--out")
        out = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    extra = [a for a in args if a.strip()]
    main(STANDARD_MODULES + [p for p in extra if p not in STANDARD_MODULES], out)
