"""Review bundle for R1, R2, F1, F2: shared sprite / board CSS / rf CSS / scripts pulled out of the pages, CSS minified,
logos downscaled, index limited to this set. Same transforms as fo_deploy so system.css and board.css stay byte-identical.
Writes to argv[1]."""
import os, re, sys, hashlib
from PIL import Image
import common as CM
import fo_common as F
import rf_common as RC
import r1, r2, f1, f2

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)
V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mini_css(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"\s*\n\s*", "\n", s).strip()
    s = re.sub(r"\s*([{};,>])\s*", r"\1", s)
    s = re.sub(r":\s+", ":", s)
    return s.replace(";}", "}") + "\n"


def css_q(c):
    return re.sub(r'"[^"]*"', lambda k: ("'" + k.group(0)[1:-1] + "'") if "'" not in k.group(0) else k.group(0), c)


def html_q(s):
    parts = re.split(r'(<style>.*?</style>)', s, flags=re.S)
    return "".join(css_q(p) if p.startswith("<style>") else re.sub(r'(\s[\w:-]+)="([^"\']*)"', lambda m: f"{m.group(1)}='{m.group(2)}'", p) for p in parts)



def page(html):
    html = re.sub(r"<!--SPRITE-->.*?<!--/SPRITE-->", RC.HATCH, html, flags=re.S)
    html = re.sub(r"<!--BOARD-->.*?<!--/BOARD-->", '<link rel="stylesheet" href="board.css"><link rel="stylesheet" href="rf.css">', html, flags=re.S)
    html = html.replace(RC.RF_CSS, "")
    html = html.replace(CM.SCRIPT, "").replace(F.RAIL_JS, "")
    html = html.replace("</body></html>", '<script src="board.js"></script></body></html>')
    html = html.replace('href="#i-', 'href="sprite.svg#i-')
    html = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)) + "</style>", html, flags=re.S)
    return re.sub(r">\s*\n\s*<", ">\n<", html)


pages = {"R1-reports-home.html": r1.build(), "R2-report-view.html": r2.build(), "F1-budget-builder.html": f1.build(), "F2-fpna-analysis.html": f2.build()}
for k, v in pages.items():
    open(os.path.join(OUT, k), "w").write(page(v))
open(os.path.join(OUT, "board.css"), "w").write(mini_css(F.BOARD_CSS))
open(os.path.join(OUT, "rf.css"), "w").write(mini_css(RC.RF_CSS))
js = (CM.SCRIPT + F.RAIL_JS).replace("<script>", "").replace("</script>", "").replace("'#i-eye-off':'#i-eye'", "'sprite.svg#i-eye-off':'sprite.svg#i-eye'")
open(os.path.join(OUT, "board.js"), "w").write(js.strip() + "\n")
used = set()
for v in pages.values():
    used |= set(re.findall(r'href="#i-([\w-]+)"', v))
used |= {"eye", "eye-off"}
sp = "".join(m for m in re.findall(r'<symbol id="i-[\w-]+".*?</symbol>', RC.SPRITE2, flags=re.S) if re.search(r'id="i-([\w-]+)"', m).group(1) in used)
sp = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>' + sp + '</defs></svg>'
sp = sp.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', '<svg xmlns="http://www.w3.org/2000/svg"><defs>')
open(os.path.join(OUT, "sprite.svg"), "w").write(sp + "\n")
open(os.path.join(OUT, "system.css"), "w").write(mini_css(open(os.path.join(V2, "system.css")).read()).rstrip("\n"))

idx = open(os.path.join(V2, "index.html")).read()
keep = set(pages)
idx = re.sub(r'\s*<li><a href="([^"]+)">.*?</li>', lambda m: m.group(0) if m.group(1) in keep else "", idx, flags=re.S)
idx = idx.replace("<dt>Stylesheet</dt>", "<dt>Review set</dt><dd>R1, R2, F1, F2 · reports &amp; FP&amp;A · Oct 20, 2026</dd><dt>Stylesheet</dt>")
idx = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)) + "</style>", idx, flags=re.S)
open(os.path.join(OUT, "index.html"), "w").write(re.sub(r">\s*\n\s*<", ">\n<", idx))

for name in ("merit-logo-on-dark.png", "merit-logo-on-light.png"):
    im = Image.open(os.path.join(V2, "assets", name)).convert("RGBA")
    im = im.resize((160, 48), Image.LANCZOS).quantize(colors=24, method=Image.FASTOCTREE)
    im.save(os.path.join(OUT, "assets", name), optimize=True)

for f in os.listdir(OUT):
    p = os.path.join(OUT, f)
    if f.endswith((".html", ".svg", ".css")):
        src = open(p).read()
        out = css_q(src) if f.endswith(".css") else html_q(src)
        out = out.replace(">\n<", "><").replace("\n", " ").strip()
        open(p, "w").write(out)
    elif f.endswith(".js"):
        src = open(p).read()
        open(p, "w").write(src.replace("\n", " ").strip())
tot = 0
for root, _, fs in os.walk(OUT):
    for f in sorted(fs):
        p = os.path.join(root, f); b = open(p, "rb").read(); tot += len(b); print(f"{os.path.relpath(p, OUT):30} {len(b):7} {hashlib.sha1(b).hexdigest()}")
print("total", tot)
