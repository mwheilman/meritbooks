"""O12 — Connect a source. A: simPRO for Heartland (live API) at Preview. B: Innergy for Iowa Custom Cabinets
(no public API): export & drop, or a QuickBooks bridge labelled temporary."""
from onb import *
from onb_data import *

CSS = """
.page{padding-top:24px}
.cx{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:24px;align-items:start;margin-top:16px}
.facts-row{display:flex;flex-wrap:wrap;gap:8px 24px;padding:12px 16px;border-bottom:1px solid var(--line);color:var(--ink-2)}
.facts-row b{color:var(--ink);font-weight:600}
.disc td{height:44px}
.disc tr.q-row{cursor:pointer}
.disc .bar-ct{display:inline-block;height:8px;background:var(--blue-200);vertical-align:middle;margin-right:8px}
.smp{margin:0;border-top:1px solid var(--line)}
.smp td,.smp th{height:36px}
.smp td{font-size:12px}
.teaser li{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:10px 16px;border-bottom:1px solid var(--line)}
.teaser li:last-child{border-bottom:0}
.teaser p{color:var(--ink-2)}
.side{background:var(--white);border:1px solid var(--line-2);position:sticky;top:16px}
.side .panel-sec{padding:16px}
.side .panel-sec+.panel-sec{border-top:1px solid var(--line)}
.bring{display:grid;gap:0}
.bring .check{justify-content:flex-start;width:100%}
.bring .check span.r{margin-left:auto;color:var(--ink-3);font-size:12px;font-variant-numeric:tabular-nums}
.contract{display:grid;grid-template-columns:112px minmax(0,1fr);gap:8px 12px}
.contract dt{color:var(--ink-2);font-size:12px;line-height:20px}
.contract dd{color:var(--ink)}
.contract dd small{display:block;color:var(--ink-3);font-size:12px;line-height:16px}
.paths{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.path{position:relative;display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--line-2);background:var(--white);cursor:pointer}
.path:has(input:checked){border-color:var(--electric);box-shadow:inset 0 0 0 1px var(--electric)}
.path:has(input:focus-visible){outline:2px solid var(--electric);outline-offset:2px}
.path input{position:absolute;opacity:0}
.path .top{display:flex;align-items:center;gap:8px}
.path ul{list-style:none}
.path li{position:relative;padding-left:16px;margin-top:4px;color:var(--ink-2)}
.path li::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;background:var(--electric)}
.path li.minus::before{background:none;border:1px solid var(--ink-3)}
.recipe{list-style:none;counter-reset:r}
.recipe li{display:grid;grid-template-columns:32px minmax(0,1fr) 160px;gap:12px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
.recipe .no{font:700 28px/32px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric)}
.recipe .shot{height:72px;border:1px solid var(--line);background:var(--warm);padding:8px;display:flex;flex-direction:column;gap:5px}
.recipe .shot i{display:block;height:5px;background:var(--grey-200)}
.recipe .shot i.b{background:var(--electric);height:3px;width:40%}
.recipe .shot i.s{width:65%}
.recipe .shot i.h{background:var(--blue-200);height:10px;width:30%;margin-left:auto}
.recipe p{color:var(--ink-2);margin-top:2px}
.drop{display:flex;align-items:center;gap:16px;padding:16px;border:1.5px dashed var(--grey-400);background:var(--white);margin-top:12px}
.drop .sp{flex:1}
.parsed{margin-top:12px;border:1px solid var(--line);background:var(--white)}
.parsed-h{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.parsed .ev{margin:0;padding:8px 16px 12px}
.req{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--canvas);margin-top:16px}
.req .sp{flex:1}
.req .l1,.req .l2{white-space:normal}
"""

SIMPRO_ENT = [
    ("Business units", "3", "Residential install · Service &amp; maintenance · Commercial", "→ departments", 3),
    ("Jobs", "1,284", "312 open · 958 complete · 14 on hold · since Mar 2019", "Sep 30 open + 2025–26", 100),
    ("Customers", "1,206", "1,171 match QuickBooks by name + email", "link, don’t copy", 94),
    ("Open invoices", "86", "214,880.40 · oldest Jul 12", "enrich QuickBooks AR", 8),
    ("Customer payments", "9,412", "Jan 2025 – Oct 19", "after Sep 30 only", 0),
    ("Vendor orders &amp; receipts", "2,140", "Jan 2025 – Oct 19", "match, don’t post", 0),
    ("Price book items", "1,912", "41 categories", "→ items", 0),
    ("Technicians", "38", "36 match payroll", "→ employees", 3),
]


def simpro():
    disc = ""
    for n, cnt, rng, use, w in SIMPRO_ENT:
        disc += (f'<tr class="q-row{" is-cursor" if n == "Jobs" else ""}" tabindex="0"><td><span class="l1">{n}</span><span class="l2">{rng}</span></td>'
                 f'<td class="n">{cnt}</td><td><span class="l2" style="font-size:13px;color:var(--ink-2)">{use}</span></td></tr>')
    dtab = (f'<table class="tbl tbl-q tbl-q--flush disc" aria-label="What simPRO has"><colgroup><col><col style="width:88px"><col style="width:184px"></colgroup>'
            f'<thead><tr><th>In simPRO</th><th class="n">Records</th><th>How we’ll use it</th></tr></thead><tbody>{disc}</tbody></table>')
    sample_rows = [("J-24811", "Ankeny Family Dental", "Commercial", "In progress", "48,600.00", "24,300.00", "19,744.10"),
                   ("J-24807", "Patel, R. &amp; S.", "Residential install", "In progress", "14,980.00", "7,490.00", "6,112.45"),
                   ("J-24799", "Grimes Storage LLC", "Commercial", "On hold", "22,450.00", "0.00", "4,286.00"),
                   ("J-24790", "Nguyen, T.", "Residential install", "Complete", "11,240.00", "11,240.00", "7,905.20"),
                   ("J-24785", "Waukee Schools", "Service &amp; maintenance", "In progress", "6,300.00", "3,150.00", "1,980.75")]
    st = "".join(f'<tr><td class="code">{a}</td><td>{b}</td><td>{c}</td><td>{d}</td><td class="n">{e}</td><td class="n">{f}</td><td class="n">{g}</td></tr>' for a, b, c, d, e, f, g in sample_rows)
    smp = (f'<table class="tbl tbl-q tbl-q--flush tbl-q--compact smp" aria-label="Five sample jobs"><colgroup><col style="width:80px"><col><col style="width:184px"><col style="width:96px"><col style="width:96px"><col style="width:96px"><col style="width:96px"></colgroup>'
           f'<thead><tr><th>Job</th><th>Customer</th><th>Business unit</th><th>Status</th><th class="n">Contract</th><th class="n">Billed</th><th class="n">Cost</th></tr></thead><tbody>{st}</tbody></table>')
    teaser = ('<ul class="teaser" style="padding:0">'
              f'<li><div><span class="l1">{status("ready", "Open invoices tie to QuickBooks")}</span><p>86 invoices, 214,880.40 in both. The field-invoice check passes before accounts are matched.</p></div><span class="n b">0.00</span></li>'
              f'<li><div><span class="l1">{status("risk", "14 jobs on hold with unbilled cost")}</span><p>Cost to date with no billing. They’ll show on the WIP card for Sam to confirm.</p></div><span class="n b">31,240.00</span></li>'
              f'<li><div><span class="l1">{status("track", "2 technicians not in payroll")}</span><p>Likely subcontractors. Asked on the employee match, not a blocker.</p></div><span class="n b">—</span></li></ul>')
    left = (f'{promise("simPRO")}'
            f'<section class="card" style="margin-top:16px" aria-labelledby="h-disc"><div class="card-h"><h3 id="h-disc">What’s in Heartland’s simPRO</h3><span class="t-cap">Preview only. Nothing is stored except this summary.</span></div>'
            f'<div class="facts-row"><span>Build <b>heartland.simprosuite.com</b></span><span>Connected by <b>Heartland’s simPRO admin</b> via link, Oct 13</span><span>Access <b>read-only</b></span><span>Webhooks <b>jobs, invoices, payments</b></span></div>'
            f'{dtab}<div class="card-h" style="border-top:1px solid var(--line)"><h3 style="font-size:13px">Jobs · 5 of 1,284</h3><span class="t-cap">a sample, so you can check the shape</span></div>{smp}</section>'
            f'<section class="card" style="margin-top:16px" aria-labelledby="h-teaser"><div class="card-h"><h3 id="h-teaser">First look at quality</h3><span class="t-cap">3 checks that can run before a pull · all 24 data-quality checks run after</span></div>{teaser}</section>')
    bring = [("Business units → departments", "3", True), ("Jobs open at Sep 30, and jobs since Jan 2025", "418", True), ("Customers (link to QuickBooks)", "1,206", True),
             ("Open invoices (enrich QuickBooks AR)", "86", True), ("Price book items", "1,912", True), ("Technicians → employees", "38", True),
             ("Payments, orders, receipts dated after Sep 30", "feed", True), ("Timesheets", "61,220", False)]
    br = "".join(f'<label class="check"><input type="checkbox"{" checked" if c else ""}><i></i>{a}<span class="r">{b}</span></label>' for a, b, c in bring)
    contract = [("Connects", f'{tier("live")}<small>OAuth app in Heartland’s build · about 10 requests a second · first pull about 12 minutes</small>'),
                ("Proves itself with", "Job count, contract value, billed to date, cost to date, open-invoice total<small>Control totals are what let this source appear on the certificate</small>"),
                ("Who’s in charge", "QuickBooks aging is the control for opening AR. simPRO adds the job and lines.<small>Authority matrix · editable per client</small>"),
                ("Before Sep 30", "Linked for drill-down, never posted.<small>Opening balances already contain it</small>"),
                ("After Sep 30", "Invoices, payments and job costs flow in as MeritBooks documents. MeritBooks numbers them; simPRO’s number shows as the reference.<small>Stays connected after go-live</small>")]
    ct = "".join(f'<dt>{a}</dt><dd>{b}</dd>' for a, b in contract)
    side = (f'<aside class="side" aria-label="Choose and import"><div class="panel-sec"><div class="panel-sec-h"><h3>Choose what to bring</h3><span class="t-cap">pre-ticked for a field system</span></div>'
            f'<div class="bring">{br}</div></div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>The import contract</h3></div><dl class="contract">{ct}</dl></div>'
            f'<div class="panel-foot"><span class="tag">Staged, not in your books</span><span class="sp"></span><button class="btn btn--primary" type="button">Pull into staging</button></div></aside>')
    steps = ('<ol class="steps" aria-label="Connect simPRO"><li class="is-done"><span class="no">1</span>Connect</li><li aria-current="step"><span class="no">2</span>Preview</li>'
             '<li><span class="no">3</span>Pull &amp; match</li><li><span class="no">4</span>Prove balances</li></ol>')
    main = (ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "Connect systems · simPRO", "<b>Preview ready · 8 kinds of record</b>"], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Sources<span class="sl">//</span>Field system</div>'
              '<h1 class="t-title" style="margin-top:8px">simPRO</h1></div>'
              f'<div class="btn-row"><span class="srcs">{src("simPRO", "ok")}</span><button class="btn btn--quiet" type="button">Disconnect</button></div></div>'
            + steps + f'<div class="cx"><div>{left}</div>{side}</div></div>')
    a = app("client", "density-cockpit", rail_mini(CLIENT_MINI, "SK", 4), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Sources", "Jump to account, job, customer…", "simPRO connected"), main, extra_cls="app--mini")
    return a.replace('class="app ', 'data-live class="app ', 1)


def innergy():
    paths = (f'<div class="paths" role="radiogroup" aria-label="How to bring Innergy in">'
             f'<label class="path"><input type="radio" name="ip" checked><span class="top">{tier("file", "Export &amp; drop")}<span class="tag tag--pos">For the opening</span></span>'
             f'<span class="t-head">Export from Innergy, drop the files here</span>'
             f'<ul><li>Open jobs with contract, cost to date and billed to date for the WIP card</li><li>Same parser every month; no login shared with us</li>'
             f'<li class="minus">A person exports each time. You get a reminder on the 2nd</li></ul></label>'
             f'<label class="path"><input type="radio" name="ip"><span class="top">{tier("bridge", "QuickBooks bridge")}<span class="tag tag--warn">Temporary</span></span>'
             f'<span class="t-head">Read Innergy’s activity through ICC’s QuickBooks</span>'
             f'<ul><li>Innergy keeps its built-in QuickBooks sync. We read those invoices and bills daily</li><li>QuickBooks is a pipe here, not ICC’s books</li>'
             f'<li class="minus">Job detail is only what Innergy sends QuickBooks, often a summary</li><li class="minus">ICC keeps paying for QuickBooks until this ends</li></ul></label></div>')
    steps = [("Open Innergy and go to the Jobs list", "Filter status to Active and On hold. Leave the date range blank so every open job comes through."),
             ("Export the WIP view to Excel", "Use the WIP columns: contract, change orders, cost to date, billed to date, retainage. Keep the header row."),
             ("Export open AR and AP", "Both as Excel, as of Sep 30. These enrich QuickBooks’ agings; they don’t replace them."),
             ("Drop the three files below", "We recognize Innergy exports by their headers. Rename nothing.")]
    rec = "".join(f'<li><span class="no">{i+1}</span><div><span class="t-head" style="font-size:13px;line-height:20px">{a}</span><p>{b}</p></div>'
                  f'<span class="shot" role="img" aria-label="Schematic of step {i+1}"><i class="b"></i><i></i><i class="s"></i><i></i><i class="h"></i></span></li>' for i, (a, b) in enumerate(steps))
    parsed = (f'<div class="parsed"><div class="parsed-h">{ico("file")}<span class="who"><span class="l1">ICC_WIP_2026-09-30.xlsx</span>'
              f'<span class="l2">Innergy WIP export · recognized by its headers, rules only · 47 open jobs</span></span><span class="sp" style="flex:1"></span>{status("risk", "Doesn’t tie to GL")}</div>'
              f'<ul class="ev"><li><span>Cost to date, 47 open jobs, from the file</span><span class="dl"></span><span class="v">1,884,215.60</span></li>'
              f'<li><span>Work in progress asset in QuickBooks at Sep 30</span><span class="dl"></span><span class="v">1,872,735.60</span></li>'
              f'<li class="ev-total"><span>Difference · WIP vs GL check</span><span class="dl"></span><span class="v neg">11,480.00</span></li></ul>'
              f'<div class="card-f"><span>Usually a vendor bill in Innergy that hasn’t synced. The WIP card shows the jobs that carry it.</span><span class="sp"></span><button class="btn" type="button">Open the WIP card</button></div></div>')
    drop = (f'<div class="drop">{ico("upload", 16)}<span class="who"><span class="l1">2 of 3 files dropped</span><span class="l2">Waiting for open AP as of Sep 30</span></span><span class="sp"></span>'
            f'<button class="btn" type="button">Choose files</button><button class="btn" type="button">{ico("send")}Ask ICC’s office to send it</button></div>')
    req = (f'<div class="req">{tier("partner")}<span class="who"><span class="l1">Innergy has no public API. MeritBooks asked for partner access on Oct 6.</span>'
           f'<span class="l2">When it’s granted this card’s button becomes Connect. Staged data, matched accounts and proved balances don’t change.</span></span><span class="sp"></span>'
           f'<button class="btn btn--quiet" type="button">Tell me when it lands</button></div>')
    left = (f'<section class="card" aria-labelledby="h-path"><div class="card-h"><h3 id="h-path">How should Innergy come in?</h3><span class="t-cap">Iowa Custom Cabinets · millwork jobs and WIP</span></div>'
            f'<div class="card-b">{paths}{req}</div></section>'
            f'<section class="card" style="margin-top:16px" aria-labelledby="h-rec"><div class="card-h"><h3 id="h-rec">Export from Innergy in 4 steps</h3><span class="t-cap">Recipe v1 · draft, confirm with ICC’s Innergy admin</span></div>'
            f'<div class="card-b" style="padding-top:0"><ol class="recipe">{rec}</ol>{drop}{parsed}</div></section>')
    contract = [("Connects", f'{tier("file", "Export &amp; drop")}<small>Parser profile innergy.wip v1, innergy.ar v1, innergy.ap v1</small>'),
                ("Proves itself with", "Job count, contract, cost to date, billed to date, open AR and AP totals from the files<small>The file carries its own totals, so it can be certified</small>"),
                ("Who’s in charge", "QuickBooks for balances. Innergy for job identity and WIP inputs."),
                ("After go-live", "Monthly WIP file on the 2nd until Innergy access lands. The bridge, if you turn it on, carries daily invoices.")]
    ct = "".join(f'<dt>{a}</dt><dd>{b}</dd>' for a, b in contract)
    side = (f'<aside class="side" aria-label="Import contract"><div class="panel-sec"><div class="panel-sec-h"><h3>The import contract</h3></div><dl class="contract">{ct}</dl></div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>If you turn on the bridge</h3><span class="tag tag--warn">Temporary</span></div>'
            f'<p class="ink-2">MeritBooks reads ICC’s QuickBooks company once a day for documents Innergy created. It never writes to QuickBooks, and QuickBooks never becomes the ledger again.</p>'
            f'<dl class="contract" style="margin-top:12px"><dt>Ends</dt><dd>When Innergy access lands. You’re asked to keep or end it every 30 days.</dd><dt>Watch for</dt><dd>Anything also dropped as a file is matched, not posted twice.</dd></dl></div>'
            f'<div class="panel-foot"><span class="tag">Staged, not in your books</span><span class="sp"></span><button class="btn btn--primary" type="button" aria-disabled="true">Stage 3 files</button></div></aside>')
    steps_ = ('<ol class="steps" aria-label="Connect Innergy"><li aria-current="step"><span class="no">1</span>Choose a path</li><li><span class="no">2</span>Export &amp; drop</li>'
              '<li><span class="no">3</span>Pull &amp; match</li><li><span class="no">4</span>Prove balances</li></ol>')
    main = (ctxline(["Mon Oct 19", "Iowa Custom Cabinets", "Connect systems · Innergy", '<b class="warn">No API · 2 of 3 files in</b>'], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Sources<span class="sl">//</span>Field system</div>'
              '<h1 class="t-title" style="margin-top:8px">Innergy</h1></div>'
              f'<div class="btn-row"><span class="srcs">{src("Innergy", "file", "file")}</span></div></div>'
            + steps_ + f'<div class="cx"><div>{left}</div>{side}</div></div>')
    return app("client", "density-cockpit", rail_mini(CLIENT_MINI, "LO", 4), bar(ctx_client("Iowa Custom Cabinets", "C-108"), "Sources", "Jump to account, job, customer…", "QuickBooks synced 6:00 AM"), main, extra_cls="app--mini")


def build():
    body = (board_h("O12<span class=\"sl\">//</span>08-ONBOARDING §4", "Connect what they have, honestly",
                    "Every system gets the same four steps: connect, preview, pull and match, prove balances. A system with a live API connects in a click and previews before anything is stored. "
                    "A system without one gets a recipe and a drop zone, or a bridge through QuickBooks that says, in the interface, that it’s temporary.",
                    '<span class="tag">Sample data</span> O12')
            + frame(simpro(), "O12.1 · simPRO, live API · Heartland’s admin created the app from a one-step link; Sam previews before pulling.")
            + anno([("Read-only, said plainly", "The promise sits above the preview, in the interface’s voice. No write scopes exist, so there’s no setting to get wrong."),
                    ("Preview before staging", "Counts, date ranges, a 5-row sample and three quality checks that run on discovery alone. Nothing is stored but the summary."),
                    ("The contract", "What it brings, what proves it (control totals), who’s in charge of each record, and what happens before and after cutover."),
                    ("Pre-ticked by role", "A field system brings jobs, customers, open invoices and business units. Timesheets stay off until someone needs job-cost labor.")])
            + section_h("O12.2 · Innergy, no public API", "Recipe and drop for the opening; bridge offered, labelled temporary")
            + frame(innergy(), "O12.2 · Iowa Custom Cabinets. The partner request is visible; when it lands the same card says Connect.")
            + anno([("Two honest paths", "Export &amp; drop for the opening (it carries its own totals, so it certifies). A QuickBooks bridge for daily activity, tagged Temporary with an end condition."),
                    ("Recipes are steps", "Numbered because order matters. Each step names the screen and the columns. Version and draft status are printed on the recipe."),
                    ("Files prove themselves", "The dropped WIP file is recognized by its headers and tied to the GL before accounts are matched: the 11,480.00 gap is the one on the Tower."),
                    ("The upgrade path", "When Innergy grants access, the button changes from Export to Connect. Staging, matched accounts and proved balances stay as they are.")]))
    return page("O12 · Connect a source", CSS, body, "O-connect-source.html")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-connect-source.html")
    open(out, "w").write(build())
    print(out)
