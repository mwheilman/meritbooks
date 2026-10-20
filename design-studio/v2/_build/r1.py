"""R1 — Reports home: ask, favourites, the question shelves, packs (FPB-reports-fpna §1, §3 A1–A2, §5; IA §3.6.1 Reports)."""
from rf_common import *
from rf_data import LOSS_JOBS, LOSS_REST, LOSS_TOTAL, LOSS_REV, EB, REV, GP, REV_DEPTS
from rf_catalog import SHELVES, TOTAL, LIVE, PART, NEW

CSS = """
.ask{display:flex;align-items:center;gap:12px;height:48px;padding:0 8px 0 16px;border:1px solid var(--midnight);background:var(--white)}
.ask:focus-within{border-color:var(--electric);box-shadow:0 0 0 1px var(--electric)}
.ask input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:15px;line-height:24px;color:var(--ink)}
.ask input::placeholder{color:var(--ink-3)}
.sugg{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.sugg .btn{font-weight:500;color:var(--ink-2)}
.ans{margin-top:24px;background:var(--white);border:1px solid var(--line);border-top:2px solid var(--electric)}
.ans-h{display:grid;grid-template-columns:48px 1fr auto;column-gap:8px;padding:16px 16px 12px}
.ans-b{display:grid;grid-template-columns:minmax(0,1fr) 300px;border-top:1px solid var(--line)}
.ans-b>div{padding:12px 16px 16px}
.ans-b>div+div{background:var(--canvas);border-left:1px solid var(--line)}
.ans-f{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--line)}
.ans-f .sp{flex:1}
.mbar{display:block;height:8px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='5' height='5'%3E%3Crect width='5' height='5' fill='%23fff'/%3E%3Cpath d='M-1 6 6-1' stroke='%23B42318' stroke-width='1.6'/%3E%3C/svg%3E");box-shadow:inset 0 0 0 1px var(--neg);margin-left:auto}
.lin{list-style:none}
.lin li{padding:8px 0;border-bottom:1px solid var(--line-2)}
.lin li:last-child{border-bottom:0}
.lin .k{display:block;font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2)}
.lin .v{display:block;margin-top:2px;color:var(--ink)}
.qry{display:block;font-family:var(--f-text);margin-top:4px;padding:8px;background:var(--white);border:1px solid var(--line);font-size:12px;line-height:16px;color:var(--ink-2);white-space:pre-wrap}
.fav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.fcard{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--white);border:1px solid var(--line);transition:border-color var(--fast)}
.fcard:hover{border-color:var(--electric)}
.fcard .top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.fcard .star{color:var(--electric);flex:none}
.fcard .val{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.fcard .fig-v{font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums}
.fcard .ft{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--ink-3);border-top:1px solid var(--line);padding-top:8px}
.shelves{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px;border-top:1px solid var(--electric)}
.shelf{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 0;border-bottom:1px solid var(--line);cursor:pointer}
.shelf:hover{background:var(--sky);box-shadow:-8px 0 0 var(--sky),8px 0 0 var(--sky)}
.shelf.is-open{background:var(--sky);box-shadow:inset 3px 0 var(--electric),-8px 0 0 var(--sky),8px 0 0 var(--sky);padding-left:12px}
.shelf .q{font-weight:600;color:var(--ink)}
.shelf .c{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink-2)}
.shelf .ex{grid-column:1/-1;font-size:12px;line-height:16px;color:var(--ink-3)}
.shelf .bs{grid-column:1/-1;margin-top:4px}
.bsm{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:16px;color:var(--ink-3)}
.bsm s{display:inline-flex;height:6px;width:96px;text-decoration:none;background:var(--grey-200)}
.bsm s i{display:block;height:6px}
.bsm s i.l{background:var(--midnight)} .bsm s i.p{background:var(--blue-300)}
.open-shelf{margin-top:24px}
.aud{display:inline-flex;flex-wrap:wrap;gap:4px}
.aud .tag{height:20px}
.side .sec-h:first-child{margin-top:0}
.pk{padding:12px 0;border-bottom:1px solid var(--line)}
.pk .row{align-items:flex-start}
.pk .l1{white-space:normal}
.pk .l2{white-space:normal}
.pk .meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
.sch li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);list-style:none}
.sch .t-cap{white-space:nowrap}
.rv li{list-style:none;display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
.sec-h .link{display:inline-flex;align-items:center;min-height:32px}
.rv a{min-height:32px;display:inline-flex;align-items:center}
.ov-note{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;line-height:16px;color:var(--ink-3)}
.ov-note b{font-weight:600;color:var(--ink-2)}
"""


def ask_block():
    sugg = ["Why did EBITDA miss in September?", "Revenue per technician by month", "Customers over 60 days with an open job",
            "Gross margin, Heartland vs Metro, last 12 months"]
    rows = ""
    worst = min(j[4] for j in LOSS_JOBS)
    for jid, name, sold, rev, m in LOSS_JOBS:
        rows += (f'<tr class="ln" tabindex="0" data-drill="{jid}"><td><span class="l1" style="white-space:normal">{E(name.split(" · ")[1])}</span><span class="l2" style="white-space:normal">{E(name.split(" · ")[0])} · {jid} · sold {sold}</span></td>'
                 f'<td class="n">{nn(rev)}</td><td class="n">{dl(m)}</td><td class="n">{m / rev * 100:.1f}%</td>'
                 f'<td><span class="mbar" style="width:{m / worst * 100:.0f}%"></span></td></tr>')
    rows += (f'<tr class="ln" tabindex="0" data-drill="9 more jobs"><td><span class="l1 ink-2">{LOSS_REST[0]} more jobs</span><span class="l2">all sold Jun 2–29</span></td>'
             f'<td class="n">{nn(LOSS_REST[1])}</td><td class="n">{dl(LOSS_REST[2])}</td><td class="n">{LOSS_REST[2] / LOSS_REST[1] * 100:.1f}%</td><td></td></tr>')
    rows += (f'<tr class="tot"><td>14 installs</td><td class="n">{nn(LOSS_REV)}</td><td class="n">{dl(LOSS_TOTAL)}</td><td class="n">{LOSS_TOTAL / LOSS_REV * 100:.1f}%</td><td></td></tr>')
    table = (f'<table class="lay" aria-label="Installs with negative margin, September"><colgroup><col><col style="width:88px"><col style="width:80px"><col style="width:64px"><col style="width:72px"></colgroup>'
             f'<thead><tr><th>Job · worst first</th><th>Revenue</th><th>Margin</th><th>%</th><th></th></tr></thead><tbody>{rows}</tbody></table>')
    qry = ("select job, sum(revenue) rev, sum(revenue) - sum(cost) margin\nfrom ledger_lines  -- posted only, RLS\nwhere client = 'C-103' and department = 'Install'\n  and period = '2026-09' and job is not null\ngroup by job having margin < 0\norder by margin")
    lineage = f"""<ul class="lin" aria-label="How this answer was built">
<li><span class="k">Metric</span><span class="v">Job margin = recognized job revenue − job cost</span></li>
<li><span class="k">Accounts, by role</span><span class="v">Install revenue (4100–4120) · cost of revenue on jobs (5100–5400)</span></li>
<li><span class="k">Filters</span><span class="v">Heartland · Install · September 2026 · margin below zero</span></li>
<li><span class="k">Rows read</span><span class="v">14 jobs from 1,126 posted lines</span></li>
<li><span class="k">Query · read-only</span><code class="qry">{E(qry)}</code></li></ul>"""
    return f"""<div class="ask" role="search">{ico("search")}<input aria-label="Ask a question or find a report" value="Which installs lost money in September?"><span class="kbd">/</span>{btn("Ask", "primary")}</div>
<div class="sugg" aria-label="Suggested questions">{"".join(btn(E(s)) for s in sugg)}</div>
<section class="ans" aria-labelledby="ans-t"><div class="ans-h"><span class="note-no">A</span><div><div class="note-kind">Answer · built from your question</div>
<h2 class="note-title" id="ans-t">14 installs lost money in September: {f0(LOSS_TOTAL)} on {f0(LOSS_REV)} of revenue</h2>
<p class="ink-2" style="margin-top:4px">All 14 were sold in June on Carrier’s old price list. That’s the install-margin step in the management report.</p></div>
<div class="btn-row">{btn("Chart", "quiet", "", "chart")}{btn("Open in builder", "quiet", "", "table")}</div></div>
<div class="ans-b"><div>{table}</div><div>{lineage}</div></div>
<div class="ans-f"><span class="basis" style="margin:0"><span>Spec written by AI from your words</span><span>Figures from the <b>posted ledger</b> · September final</span></span><span class="sp"></span>
{btn("Add to pack", "", "", "plus")}{btn("Save as report", "primary", "", "star")}</div></section>"""


FAVS = [
    ("Monthly management report", "Heartland · September", f0(EB["act"]), f'EBITDA · budget {f0(EB["bud"])}', [118, 126, 131, 104, 142, 168, 171, 159, 141, 152, 163, 186, 84], [120, 125, 130, 120, 140, 150, 160, 150, 140, 150, 160, 170, 132], "Opened today"),
    ("Department P&L vs budget", "Install · Brent Kolb", "8.4%", "Gross margin · budget 9.5%", [12.1, 11.4, 10.9, 11.8, 12.4, 13.1, 12.8, 11.2, 10.4, 12.6, 14.1, 15.0, 8.4], None, "Sent Oct 15"),
    ("13-week cash", "Heartland", "1,212,400", "Low point, week of Nov 16 · minimum 750,000", [1.68, 1.61, 1.55, 1.49, 1.42, 1.38, 1.31, 1.27, 1.21, 1.24, 1.29, 1.33, 1.36], None, "Refreshed 7:42 AM"),
    ("Covenant compliance", "Northwest Bank · DSCR", "1.58×", "Minimum 1.25× · Q3 test", [1.71, 1.69, 1.66, 1.64, 1.65, 1.63, 1.61, 1.60, 1.59, 1.60, 1.59, 1.58, 1.58], [1.25] * 13, "Certificate due Oct 30"),
    ("AR aging", "Heartland", "64,320", "Over 60 days · Aug 58,900", [41, 44, 47, 45, 49, 52, 50, 54, 57, 55, 58.9, 61, 64.3], None, "Opened yesterday"),
    ("HVAC agreements", "Industry KPIs · KP-02", "78.0%", "Renewal rate · peer median 74%", [74, 75, 75, 76, 76, 77, 77, 78, 78, 77, 78, 78, 78], None, "Opened Oct 12"),
]


def favourites():
    out = '<div class="fav">'
    for name, scope, v, vs, s, b, ft in FAVS:
        out += (f'<a class="fcard" href="#"><span class="top"><span><span class="l1">{E(name)}</span><span class="l2">{E(scope)}</span></span>'
                f'<span class="star">{ico("star", label="Pinned")}</span></span>'
                f'<span class="val"><span><span class="fig-v">{v}</span><span class="t-cap" style="display:block;color:var(--ink-2)">{E(vs)}</span></span>{spark(s, 88, 32, b)}</span>'
                f'<span class="ft"><span>{E(ft)}</span><span>13 months</span></span></a>')
    return out + "</div>"


OPEN = "What moved, and why?"


def shelves():
    out = '<div class="shelves" role="list">'
    for s in SHELVES:
        ex = ", ".join(r["name"] for r in s["rows"][:2])
        tot = s["n"]
        bar_ = (f'<span class="bsm review-ov"><s><i class="l" style="width:{s["live"] / tot * 100:.0f}%"></i><i class="p" style="width:{s["part"] / tot * 100:.0f}%"></i></s>'
                f'{s["live"]} live · {s["part"]} partial · {s["new"]} new</span>')
        op = " is-open" if s["q"] == OPEN else ""
        out += (f'<div class="shelf{op}" role="listitem" tabindex="0"><span class="q">{E(s["q"])}</span><span class="c">{tot}</span>'
                f'<span class="ex">{E(s["fam"])} · {E(ex)}</span><span class="bs">{bar_}</span></div>')
    out += "</div>"
    return out


def open_shelf():
    s = next(x for x in SHELVES if x["q"] == OPEN)
    rows = ""
    for r in s["rows"]:
        aud = "".join(f'<span class="tag">{a}</span>' for a in r["aud"].split())
        st = {"Live": "", "Partial": "", "New": ""}[r["st"]]
        fav = ' <span class="tag tag--ai">Pinned</span>' if r["id"] == "MG-01" else ""
        rows += (f'<tr class="ln" tabindex="0" data-drill="{E(r["name"])}"><td><span class="code">{r["id"]}</span></td><td class="l"><span class="l1" style="white-space:normal">{E(r["name"])}{fav}</span>'
                 f'<span class="l2" style="white-space:normal">{E(r["purpose"])}</span></td><td class="l"><span class="aud">{aud}</span></td>'
                 f'<td class="l"><span class="bsm review-ov">{r["st"]}</span></td></tr>')
    return (f'<div class="open-shelf"><div class="sec-h" style="margin-top:0"><span class="t-head">{E(OPEN)} · {s["n"]} reports</span><span class="t-cap">Management reports · sorted by use</span></div>'
            f'<table class="lay" aria-label="{E(OPEN)} reports"><colgroup><col style="width:64px"><col><col style="width:150px"><col style="width:72px"></colgroup>'
            f'<thead><tr><th>ID</th><th class="l">Report · what it answers</th><th class="l">For</th><th class="l">Build</th></tr></thead><tbody>{rows}</tbody></table></div>')


def side():
    packs = [("Monthly management pack · September", "To Mike Heilman, Dan Hartwell · due Fri Oct 23", "risk", "Commentary not reviewed", btn("Review", "primary")),
             ("Department budget vs actual · September", "4 department heads · sent Oct 15, the day after close", "ready", "4 of 4 opened · 2 replied", btn("Replies", "quiet")),
             ("Northwest Bank lender pack · Q3", "Statements, compliance certificate, BBC, AR aging", "track", "Scheduled Oct 30 · approve first", btn("Preview", "quiet")),
             ("Board package · Q3", "Merit Management Group — Consolidated · board Nov 6", "track", "Drafting · 2 members open", btn("Open", "quiet"))]
    pk = "".join(f'<div class="pk"><span class="l1">{E(n)}</span><span class="l2">{E(s)}</span><div class="meta">{status(k, w)}{b}</div></div>' for n, s, k, w, b in packs)
    sch = [("After each close", "Department BvA → 4 department heads", "Next: Nov 13"), ("Monthly · day 3", "Flash report → Mike Heilman", "Nov 3"),
           ("Weekly · Mon 7 AM", "Weekly operating report → Mike, Dan", "Oct 26"), ("Quarterly", "Northwest lender pack · approve first", "Oct 30")]
    sc = "".join(f'<li><span><span class="l1">{E(b)}</span><span class="l2">{E(a)}</span></span><span class="t-cap">{E(c)}</span></li>' for a, b, c in sch)
    rv = [("Monthly management report", "Today"), ("Install · cost of revenue (drill)", "Today"), ("WIP schedule", "Yesterday"), ("AR aging detail", "Yesterday"), ("Borrowing base certificate", "Oct 14")]
    r = "".join(f'<li><a class="link" href="#">{E(a)}</a><span class="t-cap">{b}</span></li>' for a, b in rv)
    return f"""<aside class="side" aria-label="Packs and deliveries">
<div class="sec-h"><span class="t-head">Packs &amp; deliveries</span><a class="link" href="#">All packs</a></div>{pk}
<div class="sec-h"><span class="t-head">Scheduled</span><span class="t-cap">4 schedules</span></div><ul class="sch">{sc}</ul>
<div class="sec-h"><span class="t-head">Recently viewed</span></div><ul class="rv">{r}</ul></aside>"""


def page():
    tabs = '<div class="tabs" role="tablist" aria-label="Reports">' + "".join(
        f'<button class="tab" role="tab" aria-selected="{"true" if i == 0 else "false"}" type="button">{t} <span class="n">{n}</span></button>'
        for i, (t, n) in enumerate([("Library", TOTAL), ("Favourites", 6), ("Saved views", 11), ("Scheduled", 4), ("Shared with me", 3)])) + "</div>"
    seg = "".join(f'<button type="button" aria-pressed="{"true" if i == 0 else "false"}">{s}</button>' for i, s in enumerate(["Everyone", "Owner", "Department heads", "Lenders"]))
    left = (f'{ask_block()}<div class="sec-h"><span class="t-head">Favourites</span><a class="link" href="#">Manage</a></div>{favourites()}'
            f'<div class="sec-h"><span class="t-head">Library · {TOTAL} reports, by the question they answer</span><div class="seg" role="group" aria-label="Show reports for">{seg}</div></div>'
            f'{shelves()}<p class="ov-note"><span class="bsm review-ov">dashed</span><span><b>Review overlay, not in the product:</b> build status from FPB-reports-fpna §1 — {LIVE} live, {PART} partial, {NEW} new.</span></p>'
            f'{open_shelf()}')
    head_ = (f'<div class="page-head" style="margin-bottom:8px"><div><div class="eyebrow">Planning &amp; reports<span class="sl">//</span>Reports</div>'
             f'<h1 class="t-title" style="margin-top:4px">Reports</h1></div><div class="btn-row">{btn("Builder", "", "", "table")}{btn("New report", "primary", "", "plus")}</div></div>')
    return f'<div class="page">{head_}{tabs}<div class="two" style="margin-top:24px"><div>{left}</div>{side()}</div></div>'


def build_frame():
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "September final · closed Oct 14", "<b>1 pack waiting on review</b>"])
    return app("client", "density-report", h_rail("Reports"), h_bar("<b>Reports</b>"), main + page(), 3220, live=True)


def build():
    html = head("R1 · Reports home", CSS) + sheet_top("R1-reports-home.html") + '<main id="main" class="sheet">'
    html += board_h("R1", "FPB-reports-fpna §1 library · §3 A1 ask, A2 lineage · §5 packs · IA §3.6.1 Reports",
                    "Ask a question, get a report you can keep",
                    f"The reports home leads with a question box that answers in the ledger’s own numbers and shows how it got them. "
                    f"Below it: the six reports this CFO lives in, then the library of {TOTAL} reports arranged by the question each one answers, "
                    "and on the right, every pack that is due, sent or scheduled.")
    html += pair_h("1 · Reports home", "Heartland · Planning &amp; reports · Reports. Nora (CFO) has just asked a question.")
    html += frame(build_frame(), "Populated state · AI answer with lineage · library filtered to everyone",
                  f"Ties: 5 jobs + 9 more = {f0(LOSS_TOTAL)} on {f0(LOSS_REV)}; shelf counts sum to {TOTAL}")
    html += anno([("Answers show their working", "Metric, account roles, filters, rows read and the read-only query sit beside the result. The AI writes the spec; the report engine runs it, so Save as report reproduces it exactly."),
                  ("Shelves are questions", "“Who owes us?” not “AR”. Fourteen shelves cover every report family; search still finds “aging” and “P&amp;L”."),
                  ("Favourites carry a number", "Each pinned report shows its headline figure, a comparison and 13 months of trend, so the home answers before anything opens."),
                  ("Packs are work", "Due, sent, opened and replied — with the one action each needs. The department BvA went out the day after close.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../R1-reports-home.html", "w").write(build())
    print("ok R1", TOTAL, LIVE, PART, NEW)
