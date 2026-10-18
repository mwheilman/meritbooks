"""Review bundle for Vercel: the four new screens + system.css + an index, nav
limited to deployed pages, S6.2/S6.3 frames cloned client-side to keep the
payload small, CSS comments stripped, logo downscaled. Writes to argv[1]."""
import os, re, sys, base64, io
from PIL import Image
import common
common.NAV = [("index.html", "Index"), ("S6-owner-home.html", "S6 Owner"), ("S6b-cfo-home.html", "S6b CFO"),
              ("S6c-controller-home.html", "S6c Controller"), ("S9-platform-console-home.html", "S9 Platform")]
import s6, s6b, s6c, s9

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)

CLONE = r"""<script>
(function(){
  var src=document.querySelector('#fa .app');
  function clone(id,pre){var h=src.outerHTML.replace(/"a-/g,'"'+pre+'-').replace(/data-note="a1"/g,'data-note="'+pre+'1"').replace(' data-live','');
    var t=document.createElement('div');t.innerHTML=h;var a=t.firstChild;document.getElementById(id).appendChild(a);return a;}
  var b=clone('fb','b');b.classList.add('is-private');var pb=b.querySelector('[data-privacy]');pb.setAttribute('aria-pressed','true');
  pb.querySelector('span').textContent='Show figures';pb.querySelector('use').setAttribute('href','sprite.svg#i-eye-off');
  var c=clone('fc','c');
  c.querySelector('[data-widget="ow.consolidated"]').remove();
  var g=[].filter.call(c.querySelectorAll('.rail-group'),function(x){return x.textContent==='Consolidated'})[0];
  if(g){g.nextElementSibling.remove();g.remove();}
  c.querySelector('[data-widget="ow.books_status"]').setAttribute('style','--x:1;--y:5;--w:6;--h:2');
  c.querySelector('[data-widget="ow.covenants"]').setAttribute('style','--x:7;--y:5;--w:6;--h:2');
  c.querySelector('[data-widget="ow.clients_compare"]').setAttribute('style','--x:1;--y:7;--w:12;--h:4');
  c.querySelectorAll('[data-widget="ow.clients_compare"] svg[role=img]').forEach(function(s){s.remove()});
})();
</script>"""


def s6_deploy():
    html = s6.build()
    # replace frames B and C with empty hosts; give A an id
    frames = [m.start() for m in re.finditer(r'<div class="frame"', html)]
    assert len(frames) >= 4, len(frames)
    def frame_span(i):
        st = frames[i]
        # frames end right before the following frame-cap
        en = html.index('<div class="frame-cap">', st)
        return st, en
    a0, a1 = frame_span(0)
    b0, b1 = frame_span(1)
    c0, c1 = frame_span(2)
    out = (html[:a0] + '<div class="frame" id="fa">' + html[a0 + len('<div class="frame">'):b0]
           + '<div class="frame" id="fb" style="height:900px"></div>' + html[b1:c0]
           + '<div class="frame" id="fc"></div>' + html[c1:])
    # clone must run before the interaction script binds handlers
    out = out.replace(common.TOAST + common.SCRIPT, common.TOAST + CLONE + common.SCRIPT, 1)
    assert CLONE in out
    return out


def mini_css(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"\s*\n\s*", "\n", s)
    return s.strip() + "\n"


def mini_html(s):
    return re.sub(r">\s*\n\s*<", ">\n<", s)


V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pages = {"S6-owner-home.html": s6_deploy(), "S6b-cfo-home.html": s6b.build(), "S6c-controller-home.html": s6c.build(),
         "S9-platform-console-home.html": s9.build()}
def shared(v):
    v = v.replace(common.SPRITE, "")
    v = v.replace(common.BOARD_CSS, "").replace("<style>", '<link rel="stylesheet" href="board.css"><style>', 1)
    v = v.replace(common.SCRIPT, "").replace(s6.NOTE_SCRIPT, "")
    v = v.replace("</body></html>", '<script src="board.js"></script></body></html>')
    v = v.replace('href="#i-', 'href="sprite.svg#i-')
    return v
for k, v in pages.items():
    open(os.path.join(OUT, k), "w").write(mini_html(shared(v)))
js = (common.SCRIPT + s6.NOTE_SCRIPT).replace("<script>", "").replace("</script>", "").replace("'#i-eye-off':'#i-eye'", "'sprite.svg#i-eye-off':'sprite.svg#i-eye'")
assert "sprite.svg#i-eye-off" in js
open(os.path.join(OUT, "board.js"), "w").write(js.strip() + "\n")
open(os.path.join(OUT, "board.css"), "w").write(mini_css(common.BOARD_CSS))
sp = common.SPRITE.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', '<svg xmlns="http://www.w3.org/2000/svg"><defs>')
open(os.path.join(OUT, "sprite.svg"), "w").write(sp + "\n")
open(os.path.join(OUT, "system.css"), "w").write(mini_css(open(os.path.join(V2, "system.css")).read()))

idx = open(os.path.join(V2, "index.html")).read()
for gone in ["components.html", "S7-switcher-and-contexts.html", "S8-dashboard-edit.html"]:
    idx = re.sub(r'\s*<li><a href="' + re.escape(gone) + r'">.*?</li>', "", idx, flags=re.S)
idx = idx.replace("<dt>Stylesheet</dt>", "<dt>Review set</dt><dd>S6, S6b, S6c, S9 · Oct 18, 2026</dd><dt>Stylesheet</dt>")
open(os.path.join(OUT, "index.html"), "w").write(mini_html(idx))

im = Image.open(os.path.join(V2, "assets", "merit-logo-on-dark.png")).convert("RGBA")
im = im.resize((160, 48), Image.LANCZOS).quantize(colors=24, method=Image.FASTOCTREE)
im.save(os.path.join(OUT, "assets", "merit-logo-on-dark.png"), optimize=True)
for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, f)
    if os.path.isfile(p):
        print(f, os.path.getsize(p))
print("logo", os.path.getsize(os.path.join(OUT, "assets", "merit-logo-on-dark.png")))
