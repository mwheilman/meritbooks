"""Review bundle for the onboarding & integrations set: the 8 boards + an index, shared sprite/board css/js,
minified system.css, downscaled logos. Writes to argv[1] and prints sizes + sha1 for each file."""
import os, re, sys, hashlib
from PIL import Image
import common, onb
import o_tower, o_client, o_connect, o_mapping, o_preflight, o_tieout, o_buyin, s18

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)
V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOC = [("O10", "Migration Control Tower", "O-control-tower.html", "Fourteen Merit clients by cutover date: Wave 1 Aug 31, Wave 2 Sep 30, Wave 3 Oct 31, then Unscheduled. Eight plainly named stages, from Gather info to Live, each saying what happens, who does it and when it’s done. Blockers in dollars, one verb per row, bulk actions, and the QuickBooks connect-the-next-company loop with an EIN mismatch caught."),
       ("O11", "Client migration", "O-client-migration.html", "Heartland’s move: the eight stages with the current one, Prove balances, opened, what needs a person, every source by role and what happens to it at go-live, what the system did as a ledger that sums, the plan in plain English, and where-this-came-from."),
       ("O12", "Connect a source", "O-connect-source.html", "simPRO over its live API with a read-only promise, preview and import contract. Innergy with no API: a recipe and a drop zone that ties the WIP file to the GL, and a QuickBooks bridge labelled temporary."),
       ("O14", "Check data quality", "O-preflight.html", "Dorrian’s 24 checks on one strip, findings ranked by dollars with fix-in-QuickBooks or handle-it-for-me, and the branded report to send the client."),
       ("O15", "Match accounts", "O-mapping.html", "Heritage’s 223 accounts matched to the Merit standard chart: Ready, Check, Decide by dollars, the rule behind every proposal, a type-guard stop, a shared-rule conflict across clients, and departments found in the data."),
       ("O19", "Prove balances, practice close, sign-off", "O-tieout-certificate.html", "Prove balances: Heartland’s month-by-account grid with its drill, schedule ties and ties to outside evidence. Practice close: AIM’s September closed in both systems. Signed off: AIM’s Conversion Certificate awaiting the reviewer."),
       ("O20", "Buy-in", "O-buy-in.html", "QuickBooks beside MeritBooks for the parallel month with every difference in a note, then “What changes on Monday” for a bookkeeper coming from QuickBooks."),
       ("S18", "Integrations hub", "S18-integrations-hub.html", "Connections by client and role with health, the error queue with replay, a catalog with honest statuses for ServiceTitan, Buildertrend, Innergy, simPRO, RFMS and c-Systems, and the Ramp accounting connection.")]
INDEX = (common.head("Onboarding & integrations") + common.sheet_top("index.html")
         + '<main class="sheet" id="main"><div class="board-h"><div><div class="eyebrow">MeritBooks<span class="sl">//</span>Design System v2<span class="sl">//</span>Onboarding &amp; integrations</div>'
         '<h1 class="t-title" style="margin-top:8px">Connect or drop what they have. Build the books. Prove them.</h1>'
         '<p>Eight boards for 08-ONBOARDING-V2 and 07-INTEGRATIONS, on the v2 system. Merit Management Group moving its own clients off QuickBooks, Sage Intacct and spreadsheets, with simPRO, RFMS, Buildertrend, Innergy, FieldEdge and c-Systems in the mix. '
         'QuickBooks appears only as a source being retired, or as a bridge for systems that can’t connect yet, always labelled temporary.</p></div><span class="pg"><span class="tag">Sample data</span> Oct 19, 2026</span></div>'
         '<ol style="list-style:none;margin-top:8px">' + "".join(
             f'<li style="border-bottom:1px solid var(--line)"><a href="{h}" style="display:grid;grid-template-columns:96px 320px 1fr 24px;gap:24px;align-items:center;min-height:88px;padding:16px 0">'
             f'<span class="outline-num">{n}</span><span class="t-section" style="color:var(--ink)">{t}</span><span class="ink-2">{d}</span><span class="ink-3" aria-hidden="true">→</span></a></li>' for n, t, h, d in TOC)
         + '</ol></main></body></html>')

PAGES = {"O-control-tower.html": o_tower, "O-client-migration.html": o_client, "O-connect-source.html": o_connect,
         "O-mapping.html": o_mapping, "O-preflight.html": o_preflight, "O-tieout-certificate.html": o_tieout,
         "O-buy-in.html": o_buyin, "S18-integrations-hub.html": s18}


def mini_css(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"\s*\n\s*", "", s)
    s = re.sub(r"\s*([{};,>])\s*", r"\1", s)
    return s.replace(";}", "}").strip() + "\n"


def mini_html(s):
    s = re.sub(r">\s+<", "><", s)
    s = re.sub(r'(<td\b[^>]*?) title="[^"]*"', r"\1", s)   # tie-out grid cell tooltips only: sr text carries the meaning.
    # Other title= stay (the Tower's stage tabs explain what happens · who · done when on hover).
    return s


SPR = (common.SPRITE + onb.EXTRA_SPRITE)
SHARED_CSS = common.BOARD_CSS + onb.ONB_CSS


def shared(v):
    v = v.replace(common.SPRITE, "").replace(onb.EXTRA_SPRITE, "")
    v = v.replace(SHARED_CSS, "").replace("<style>", '<link rel="stylesheet" href="board.css"><style>', 1)
    v = v.replace(common.SCRIPT, "")
    v = v.replace("</body></html>", '<script src="board.js"></script></body></html>')
    v = v.replace('href="#i-', 'href="sprite.svg#i-')
    v = v.replace("assets/merit-logo-on-light.png", "assets/logo-light.png").replace("assets/merit-logo-on-dark.png", "assets/logo-dark.png").replace("assets/merit-icon.png", "assets/icon.png")
    # minify the page-local <style>
    v = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)).strip() + "</style>", v, flags=re.S)
    return v


for k, mod in PAGES.items():
    open(os.path.join(OUT, k), "w").write(mini_html(shared(mod.build())))
js = common.SCRIPT.replace("<script>", "").replace("</script>", "").replace("'#i-eye-off':'#i-eye'", "'sprite.svg#i-eye-off':'sprite.svg#i-eye'")
open(os.path.join(OUT, "board.js"), "w").write(re.sub(r"\n\s*", "\n", js.strip()) + "\n")
open(os.path.join(OUT, "board.css"), "w").write(mini_css(SHARED_CSS))
sp = SPR.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', '<svg xmlns="http://www.w3.org/2000/svg"><defs>', 1)
sp = sp.replace('</defs></svg><svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', "")
open(os.path.join(OUT, "sprite.svg"), "w").write(re.sub(r">\s+<", "><", sp) + "\n")

# purge unused system.css rules for the bundle
from purge import purge
allhtml = "".join(open(os.path.join(OUT, k)).read() for k in PAGES) + js
open(os.path.join(OUT, "system.css"), "w").write(purge(mini_css(open(os.path.join(V2, "system.css")).read()), allhtml + INDEX) + "\n")
open(os.path.join(OUT, "index.html"), "w").write(mini_html(shared(INDEX)))

for src, dst, size in [("merit-logo-on-dark.png", "logo-dark.png", (160, 48)), ("merit-logo-on-light.png", "logo-light.png", (184, 56)), ("merit-icon.png", "icon.png", (44, 40))]:
    im = Image.open(os.path.join(V2, "assets", src)).convert("RGBA").resize(size, Image.LANCZOS)
    im.quantize(colors=16, method=Image.FASTOCTREE).save(os.path.join(OUT, "assets", dst), optimize=True)

tot = 0
for root, _, fs in os.walk(OUT):
    for f in sorted(fs):
        p = os.path.join(root, f)
        b = open(p, "rb").read()
        tot += len(b)
        print(f"{os.path.relpath(p, OUT):32} {len(b):7} {hashlib.sha1(b).hexdigest()}")
print("total", tot)
