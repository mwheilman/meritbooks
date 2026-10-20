"""O20 + O24 — Buy-in. A: old vs new side by side (AIM, September, the parallel month), every figure traceable.
B: “What changed for my workflow” for Luis Ortiz, bookkeeper, coming from QuickBooks, with his first-week path."""
from onb import *
from onb_data import money, AIM_PL, AIM_MB, AIM_QB, AIM_TIMING, AIM_SHADOW_OPEN

CSS = """
.page{padding-top:24px}
.sbs{display:grid;grid-template-columns:minmax(0,1fr) 352px;column-gap:24px;margin-top:16px}
.sbs-bar{display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap}
.sbs-bar .sp{flex:1}
.sbs .tbl-fs td.d{color:var(--ink-2)}
.sbs .tbl-fs td.d.neg{color:var(--neg);font-weight:600}
.sbs .tbl-fs th.nt,.sbs .tbl-fs td.nt{width:56px}
.sbs .tbl-fs td.ex{font-size:12px;color:var(--ink-3);padding-left:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbs .tbl-fs .src-h{font-size:12px;color:var(--ink-3);text-transform:none;letter-spacing:0;font-weight:400;display:block}
.sbs .notes{align-self:start}
.sbs .note .ev li{font-size:13px}
.sbs .note.is-lit{box-shadow:-16px 0 0 var(--white),16px 0 0 var(--white),-18px 0 0 var(--electric)}
.sbs .note-acts{flex-wrap:wrap}
/* workflow page — report density, reads like a briefing */
.wf{display:grid;grid-template-columns:minmax(0,1fr) 384px;gap:48px;align-items:start;padding:32px 48px 48px}
.wf h2.t-section{margin-top:40px;padding-bottom:8px;border-bottom:2px solid var(--electric)}
.wf h2.t-section:first-of-type{margin-top:24px}
.wf .lede{font-size:15px;line-height:24px;color:var(--ink-2);max-width:68ch;margin-top:12px}
.wf .lede b{color:var(--ink);font-weight:600}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px}
.pt{border-top:1px solid var(--line-2);padding-top:12px}
.pt b{display:block;font-weight:600;color:var(--ink)}
.pt p{color:var(--ink-2);margin-top:4px}
.pt .ev{margin-top:8px}
.map td{height:44px}
.map td .arrow{color:var(--electric);font-weight:700}
.map .qb{color:var(--ink-2)}
.map .kbd{margin-left:6px}
.week{background:var(--white);border:1px solid var(--line-2);position:sticky;top:16px}
.week li{list-style:none;display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:12px;align-items:start;padding:12px 16px;border-bottom:1px solid var(--line)}
.week li:last-child{border-bottom:0}
.week li .bx{width:20px;height:20px;border:1.5px solid var(--grey-400);display:grid;place-items:center;margin-top:2px}
.week li.is-done .bx{background:var(--electric);border-color:var(--electric);color:var(--white)}
.week li.is-done .l1{color:var(--ink-2)}
.week li.is-next{background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.week .l1,.week .l2{white-space:normal}
.receipt{margin-top:16px;padding:16px;background:var(--white);border:1px solid var(--line)}
.receipt .fig-v{font-size:28px}
.terms{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 24px;margin-top:12px}
.terms div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.terms .qb{color:var(--ink-2)}
.terms b{font-weight:600}
"""


def pl_table():
    def row(code, name, mb, qb, explain, note=None, hp=True):
        d = qb - mb
        dcls = " neg" if d and explain.startswith("Open") else ""
        nref = f'<a class="nref" data-note="{note}" href="#n{note}">{note}</a>' if note else ""
        H = '<span class="hp">)</span>'
        cell = lambda v: f'{money(v)}{H if v >= 0 else ""}'
        return (f'<tr class="fs-line"{f" data-note={chr(34)}{note}{chr(34)}" if note else ""}><td><span class="code">{code}</span>{name}</td><td class="nt">{nref}</td>'
                f'<td class="n">{cell(qb)}</td><td class="n cur">{cell(mb)}</td><td class="n d{dcls}">{cell(d) if d else "—" + H}</td><td class="ex">{explain}</td></tr>')
    def sub(label, mb, qb, cls="fs-sub"):
        H = '<span class="hp">)</span>'
        cell = lambda v: f'{money(v)}{H if v >= 0 else ""}'
        d = qb - mb
        return (f'<tr class="{cls}"><td>{label}</td><td class="nt"></td><td class="n">{cell(qb)}</td><td class="n cur">{cell(mb)}</td>'
                f'<td class="n d">{cell(d) if d else "—" + H}</td><td class="ex"></td></tr>')
    ex = {"4010": ("Timing · draw 4", 1), "5110": ("Open · bill after last read", 2), "5210": ("Open · line added later", 2),
          "6610": ("Coded differently", None), "6620": ("Coded differently", None)}
    b = '<tr class="fs-head"><td colspan="6">Revenue</td></tr>'
    for code, name, mb, qb in AIM_PL["rev"]:
        e, n = ex.get(code, ("", None)); b += row(code, name, mb, qb, e, n)
    b += sub("Total revenue", AIM_MB["rev"], AIM_QB["rev"])
    b += '<tr class="fs-head"><td colspan="6">Cost of revenue</td></tr>'
    for code, name, mb, qb in AIM_PL["cogs"]:
        e, n = ex.get(code, ("", None)); b += row(code, name, mb, qb, e, n)
    b += sub("Total cost of revenue", AIM_MB["cogs"], AIM_QB["cogs"])
    b += sub("Gross profit", AIM_MB["gp"], AIM_QB["gp"])
    b += '<tr class="fs-head"><td colspan="6">Operating expenses</td></tr>'
    for code, name, mb, qb in AIM_PL["opex"]:
        e, n = ex.get(code, ("", None)); b += row(code, name, mb, qb, e, n)
    b += sub("Total operating expenses", AIM_MB["opex"], AIM_QB["opex"])
    b += '<tr class="fs-gap"><td colspan="6"></td></tr>'
    b += sub("Operating income", AIM_MB["oi"], AIM_QB["oi"], "fs-grand")
    return (f'<table class="tbl tbl-fs" aria-label="AIM income statement, September 2026, QuickBooks beside MeritBooks">'
            f'<colgroup><col><col style="width:56px"><col style="width:132px"><col style="width:132px"><col style="width:120px"><col style="width:176px"></colgroup>'
            f'<thead><tr><th>In US dollars · September 2026</th><th class="nt">Note</th><th class="n">QuickBooks<span class="src-h">parallel pull Oct 12</span></th>'
            f'<th class="n cur">MeritBooks<span class="src-h">book of record</span></th><th class="n">Difference<span class="src-h">QB − MB</span></th><th style="padding-left:16px">Why</th></tr></thead>'
            f'<tbody>{b}</tbody></table>')


def notes():
    resid = sum(v for *_, v in AIM_SHADOW_OPEN)
    n1 = f"""<article class="note" data-note="1" id="n1"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Timing</div>
<div class="note-title">Draw 4 on the Sorensen remodel</div></div></div>
<p>Invoiced in MeritBooks on <b>Sep 30</b>, the day the work was approved. QuickBooks has it on Oct 1. October will show the same amount the other way.</p>
<ul class="ev"><li><span>Invoice INV-2609-118, Sorensen</span><span class="dl"></span><span class="v">{money(AIM_TIMING)}</span></li></ul>
<div class="basis"><span>Resolved <b>Timing</b> · Luis Ortiz, Oct 13</span></div></article>"""
    n2 = f"""<article class="note is-lit" data-note="2" id="n2"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">Open · where this came from</div>
<div class="note-title">Two bills QuickBooks has that MeritBooks doesn’t yet</div></div></div>
<p>Both came from Buildertrend through the QuickBooks bridge. One synced after the bridge’s last read on Sep 30; one changed after it was read.</p>
<ul class="ev"><li><span>Masterbrand · cabinet materials</span><span class="dl"></span><span class="v">{money(AIM_SHADOW_OPEN[0][2])}</span></li>
<li><span>Kline Tile · subcontract install</span><span class="dl"></span><span class="v">{money(AIM_SHADOW_OPEN[1][2])}</span></li>
<li class="ev-total"><span>Unexplained</span><span class="dl"></span><span class="v">{money(resid)}</span></li></ul>
<div class="basis"><span>Source <b>bridge · Buildertrend via QuickBooks</b></span><span>Read <b>Sep 30, 6:00 PM</b></span></div>
<div class="note-acts"><button class="btn btn--quiet" type="button">Open the practice close</button><button class="btn btn--quiet" type="button">{ico("flag")}Report a mismatch</button></div></article>"""
    return f'<aside class="notes" aria-label="Notes to the comparison"><div class="notes-head"><span class="eyebrow">Notes</span><span class="t-cap">2 · hover a figure to light its note</span></div>{n1}{n2}</aside>'


def frame_a():
    reports = ('<div class="seg" role="group" aria-label="Report"><button type="button" aria-pressed="true">Income statement</button><button type="button" aria-pressed="false">Balance sheet</button>'
               '<button type="button" aria-pressed="false">Trial balance</button><button type="button" aria-pressed="false">AR aging</button><button type="button" aria-pressed="false">AP aging</button>'
               '<button type="button" aria-pressed="false">Job P&amp;L</button></div>')
    bar_ = (f'<div class="sbs-bar">{reports}<select class="select" style="width:156px" aria-label="Month"><option>September 2026</option><option>August 2026</option></select>'
            f'<label class="switch"><input type="checkbox"><i></i>Only rows that differ</label><span class="sp"></span>'
            f'<button class="btn" type="button">{ico("download")}Export both columns · XLSX</button></div>')
    main = (ctxline(["Mon Oct 19", "AIM Kitchen &amp; Bath", "Side by side · September, the parallel month", "<b>4 rows differ · 2 open</b>"], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Reports<span class="sl">//</span>Side by side<span class="sl">//</span>AIM Kitchen &amp; Bath</div>'
              '<h1 class="t-title" style="margin-top:8px">QuickBooks beside MeritBooks</h1></div></div>'
            + bar_ + f'<div class="sbs"><div>{pl_table()}</div>{notes()}</div></div>')
    a = app("client", "density-report", rail_mini(CLIENT_MINI, "LO", 5), bar(ctx_client("AIM Kitchen & Bath", "C-111", "Live · practice close", "open"), "Reports · Side by side", "Jump to account, job, report…", "Bridge read 6:00 AM"), main, extra_cls="app--mini")
    return a.replace('class="app ', 'data-live class="app ', 1)


def frame_b():
    stays = [("You still review every transaction", "Nothing posts from the bank feed without a person, until you choose a rule for it."),
             ("You still reconcile every account, every month", "Same statements, same sign-off. The outstanding items are already loaded."),
             ("Your vendor habits came with you", "MeritBooks learned how you coded AIM’s vendors from 20 months of QuickBooks history.")]
    auto = [("Bank and card transactions arrive coded", [("AIM, September, landed Ready", "81%"), ("Coded by your own vendor habits", "214 vendors")]),
            ("Bills from email arrive drafted", [("AIM’s AP inbox, September", "38 bills"), ("Matched to a Buildertrend bill", "31")])]
    st = "".join(f'<div class="pt"><b>{a}</b><p>{b}</p></div>' for a, b in stays)
    au = "".join(f'<div class="pt"><b>{a}</b><ul class="ev">' + "".join(f'<li><span>{x}</span><span class="dl"></span><span class="v">{y}</span></li>' for x, y in ev) + '</ul></div>' for a, ev in auto)
    moved = [("Banking → For review", "Client home → To review", "R"), ("Gear → Reconcile", "Reconciliation", "G R"), ("+ New → Journal entry", "Journal entries → New", "N"),
             ("Reports → Profit and Loss", "Reports, with a period picker", "G P"), ("Memo “Ask My Accountant”", "Ask client, from any row", "Q"),
             ("Settings → Close the books", "Close, with a reviewer’s sign-off", "")]
    mv = "".join(f'<tr class="q-row"><td class="qb">{a}</td><td><span class="arrow" aria-hidden="true">→</span></td><td>{b}{"".join(f"<span class=" + chr(34) + "kbd" + chr(34) + ">" + k + "</span>" for k in c.split()) if c else ""}</td></tr>' for a, b, c in moved)
    mvt = (f'<table class="tbl tbl-q tbl-q--flush map" style="margin-top:12px" aria-label="Where things moved"><colgroup><col style="width:44%"><col style="width:32px"><col></colgroup>'
           f'<thead><tr><th>In QuickBooks</th><th></th><th>In MeritBooks</th></tr></thead><tbody>{mv}</tbody></table>')
    new = [("A reviewer signs off your close", "Jordan Smith reviews AIM, Merit Fund III, Iowa Custom Cabinets and Revived Interiors. You send; he approves or returns with a note."),
           ("Bills over 2,500.00 need approval", "They route to Jordan Smith. Over 25,000.00 they also go to the owner. You see where each one is."),
           ("Clients answer by text", "Ask a client from any row. They answer on their phone with no login; the answer lands back on the row."),
           ("The AI explains itself", "Every suggestion carries a note with its evidence and confidence. If AI is paused, your rules and vendor habits keep coding.")]
    nw = "".join(f'<div class="pt"><b>{a}</b><p>{b}</p></div>' for a, b in new)
    terms = [("Classes", "Departments"), ("Sub-customers", "Jobs"), ("Undeposited Funds", "Payment clearing"), ("Memorized transactions", "Recurring entries"),
             ("Closing date", "Period close"), ("Products and services", "Items")]
    tm = "".join(f'<div><span class="qb">{a}</span><b>{b}</b></div>' for a, b in terms)
    left = (f'<div><div class="eyebrow">For Luis Ortiz<span class="sl">//</span>Bookkeeper<span class="sl">//</span>coming from QuickBooks Online</div>'
            f'<h1 class="t-title" style="margin-top:8px">What changes on Monday</h1>'
            f'<p class="lede">You keep doing the work you know. <b>The typing goes away</b>: transactions, bills and outstanding items arrive ready for your judgment. '
            f'Here’s what stays, what’s automated now, where things moved, and what’s new, using your own clients.</p>'
            f'<h2 class="t-section">What stays the same</h2><div class="two" style="grid-template-columns:repeat(3,1fr)">{st}</div>'
            f'<h2 class="t-section">What’s automated now</h2><div class="two">{au}</div>'
            f'<h2 class="t-section">Where things moved</h2>{mvt}'
            f'<h2 class="t-section">What’s new for you</h2><div class="two">{nw}</div>'
            f'<h2 class="t-section">Words that changed</h2><div class="terms">{tm}</div>'
            f'<p class="t-cap" style="margin-top:12px">Hover any of these words in the app and it shows what QuickBooks called it.</p></div>')
    wk = [("done", "Approve your first 10 bank transactions", "AIM · done Oct 13"), ("done", "Answer a client question", "Merit Fund III · done Oct 14"),
          ("next", "Reconcile Farmers State ••6630 for September", "AIM · 17 outstanding items already loaded"),
          ("", "Run your first close checklist", "AIM · September · 22 tasks, 14 auto-verified"), ("", "Send September to Jordan for review", "AIM · the four-step books loop")]
    wl = "".join(f'<li class="is-{s}"><span class="bx">{ico("check", 12) if s == "done" else ""}</span><span class="who"><span class="l1">{a}</span><span class="l2">{b}</span></span>'
                 f'{"<button class=" + chr(34) + "btn btn--primary" + chr(34) + " type=" + chr(34) + "button" + chr(34) + ">Start</button>" if s == "next" else ""}</li>' for s, a, b in wk)
    right = (f'<aside><section class="week" aria-labelledby="h-week"><div class="card-h"><h3 id="h-week">Your first week</h3><span class="t-cap">2 of 5 · on your real clients</span></div>'
             f'<ol style="padding:0">{wl}</ol><div class="card-f"><span>Jordan sees each person’s progress. No demo company, no fake data.</span></div></section>'
             f'<div class="receipt"><div class="fig"><span class="fig-l">First close in MeritBooks · Merit Fund III</span><span class="fig-v tnum">2.4 hours</span>'
             f'<span class="fig-vs"><span>6.5 hours for August in QuickBooks</span><span>from Merit’s time standards</span></span><button class="btn btn--quiet" type="button" style="margin-left:-12px">See where the time went</button></div></div>'
             f'<div class="receipt"><span class="t-head">Something doesn’t look right?</span><p class="ink-2" style="margin-top:4px">Report a mismatch from any number during migration. It goes to Jordan with the context attached.</p>'
             f'<div class="btn-row" style="margin-top:12px"><button class="btn" type="button">{ico("flag")}Report a mismatch</button></div></div></aside>')
    return f'<div class="app app--frame density-report" data-context="workspace" style="display:block;min-height:0"><div class="wf">{left}{right}</div></div>'


def build():
    body = (board_h("O20 + O24<span class=\"sl\">//</span>08-ONBOARDING §12", "Show me it matches. Then show me Monday.",
                    "The two questions every accountant asks before trusting a new ledger. The side-by-side puts QuickBooks and MeritBooks in adjacent columns for any month, with every difference explained in a note. "
                    "The workflow page answers what changes for this person, using his own clients, thresholds and reviewer.",
                    '<span class="tag">Sample data</span> O20')
            + frame(frame_a(), "O20.1 · AIM, September, the parallel month. Note 2 is lit from the 5110 row. Totals tie down each column.")
            + anno([("Two columns, one statement", "Source, MeritBooks, difference. Same statement rules as every report: blue header rule, Midnight subtotal rule, double rule under the total."),
                    ("Every difference has a why", "The Why column names the kind; the note shows the documents behind it, as a ledger that sums to the difference."),
                    ("Any report, any month", "Income statement, balance sheet, TB, agings and job P&amp;L. The source column comes from the archive once QuickBooks is disconnected."),
                    ("Hand it to the partner", "Export puts both columns in one XLSX. It’s what the team holds next to QuickBooks during the parallel month.")])
            + section_h("O24 · What changed for my workflow", "Generated per role and prior system, filled with this tenant’s facts")
            + f'<div class="frame" style="background:var(--warm)">{frame_b()}</div>'
            + '<div class="frame-cap"><span>O24.1 · Luis Ortiz, bookkeeper, from QuickBooks Online. Linked from his invite and from Help, forever.</span><span>sample data</span></div>'
            + anno([("Stays, automated, moved, new", "The four sections answer the real fear in order: I keep my judgment, I lose the typing, I can find things, and here’s what’s new."),
                    ("His numbers, not a demo", "81% of AIM’s September landed Ready; 214 vendor habits came from his own history; Jordan is his reviewer."),
                    ("Keys beside the verbs", "The moved-things map prints the shortcut next to each new home, so speed carries over from day one."),
                    ("The first week is real work", "Five tasks on his own migrated clients. The manager sees progress per person. The time-saved receipt uses Merit’s own time standards.")]))
    return page("O20 · Side by side + workflow", CSS, body, "O-buy-in.html", """<script>
(function(){document.querySelectorAll('[data-note]').forEach(function(el){var n=el.getAttribute('data-note');
 function lit(on){document.querySelectorAll('.note[data-note="'+n+'"]').forEach(function(x){x.classList.toggle('is-lit',on)});}
 el.addEventListener('mouseenter',function(){lit(true)});el.addEventListener('mouseleave',function(){if(n!=='2')lit(false)});});})();
</script>""")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-buy-in.html")
    open(out, "w").write(build())
    print(out)
