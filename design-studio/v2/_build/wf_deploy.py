"""Review bundle for V1, V2, W1, W2 (+ S21, S22 linked): shared sprite / board CSS / scripts pulled out of the pages, CSS comments
stripped, logos downscaled, index limited to this set. Writes to argv[1]."""
import os, re, sys, hashlib
from PIL import Image
import common as CM
import fo_common as F
import wf_common as W
import s21, s22, v1, v2, w1, w2

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)
V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mini_css(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"\s*\n\s*", "\n", s).strip()
    s = re.sub(r"\s*([{};,>])\s*", r"\1", s)
    s = re.sub(r":\s+", ":", s)
    return s.replace(";}", "}") + "\n"


def page(html):
    html = re.sub(r"<!--SPRITE-->.*?<!--/SPRITE-->", "", html, flags=re.S)
    html = re.sub(r"<!--BOARD-->.*?<!--/BOARD-->", '<link rel="stylesheet" href="board.css">', html, flags=re.S)
    html = html.replace(CM.SCRIPT, "").replace(F.RAIL_JS, "")
    html = html.replace("</body></html>", '<script src="board.js"></script></body></html>')
    html = html.replace('href="#i-', 'href="sprite.svg#i-')
    html = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)) + "</style>", html, flags=re.S)
    return re.sub(r">\s*\n\s*<", ">\n<", html)


pages = {"V1-vendor-compliance.html": v1.build(), "V2-vendor-portal-mobile.html": v2.build(), "W1-workforce-app-mobile.html": w1.build(),
         "W2-expense-policy-upload.html": w2.build(), "S21-employee-receipts.html": s21.build(), "S22-receipt-chase.html": s22.build()}
for k, v in pages.items():
    open(os.path.join(OUT, k), "w").write(page(v))
open(os.path.join(OUT, "board.css"), "w").write(mini_css(F.BOARD_CSS + W.OWN_CSS))
js = (CM.SCRIPT + F.RAIL_JS).replace("<script>", "").replace("</script>", "").replace("'#i-eye-off':'#i-eye'", "'sprite.svg#i-eye-off':'sprite.svg#i-eye'")
open(os.path.join(OUT, "board.js"), "w").write(js.strip() + "\n")
sp = W.SPRITE.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', '<svg xmlns="http://www.w3.org/2000/svg"><defs>')
open(os.path.join(OUT, "sprite.svg"), "w").write(sp + "\n")
open(os.path.join(OUT, "system.css"), "w").write(mini_css(open(os.path.join(V2, "system.css")).read()).rstrip("\n"))  # byte-identical to acc_deploy

idx = open(os.path.join(V2, "index.html")).read()
keep = set(pages)
idx = re.sub(r'\s*<li><a href="([^"]+)">.*?</li>', lambda m: m.group(0) if m.group(1) in keep else "", idx, flags=re.S)
idx = idx.replace("<dt>Stylesheet</dt>", "<dt>Review set</dt><dd>V1–W2 · compliance &amp; workforce · Oct 20, 2026</dd><dt>Stylesheet</dt>")
idx = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)) + "</style>", idx, flags=re.S)
open(os.path.join(OUT, "index.html"), "w").write(re.sub(r">\s*\n\s*<", ">\n<", idx))

for name in ("merit-logo-on-dark.png", "merit-logo-on-light.png"):
    im = Image.open(os.path.join(V2, "assets", name)).convert("RGBA")
    im = im.resize((160, 48), Image.LANCZOS).quantize(colors=24, method=Image.FASTOCTREE)
    im.save(os.path.join(OUT, "assets", name), optimize=True)
# JSON-friendly: attribute and CSS string quotes become single quotes (no escaping needed when inlined)
def css_q(c):
    return re.sub(r'"[^"]*"', lambda k: ("'" + k.group(0)[1:-1] + "'") if "'" not in k.group(0) else k.group(0), c)


def html_q(s):
    parts = re.split(r'(<style>.*?</style>)', s, flags=re.S)
    return "".join(css_q(p) if p.startswith("<style>") else re.sub(r'(\s[\w:-]+)="([^"\']*)"', lambda m: f"{m.group(1)}='{m.group(2)}'", p) for p in parts)


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
