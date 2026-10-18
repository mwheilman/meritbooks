"""S6b — CFO home (compact). Annual Report density, workspace context."""
from common import *
from data import CLIENTS, BY, G, T, AR, AP
from s6 import CSS as S6CSS, NOTE_SCRIPT, m_books

CSS = S6CSS + """
/* S6b layout only */
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:2px solid var(--electric);height:100%}
.kpi{display:flex;flex-direction:column;gap:4px;padding:14px 16px 12px;border-right:1px solid var(--line);transition:background-color var(--fast) var(--ease)}
.kpi:first-child{padding-left:0}
.kpi:last-child{border-right:0}
.kpi:hover{background:var(--sky)}
.kpi .fig-v--dense{display:flex;justify-content:space-between;align-items:center}
.kpi .fig-v--dense .ico{color:var(--ink-3)}
.kpi .fig-vs{flex-direction:column;gap:2px}
.rel{list-style:none}
.rel-row{display:grid;grid-template-columns:minmax(0,1fr) 112px 132px;column-gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.rel-row p{margin-top:2px;color:var(--ink-2)}
.rel-row .n{font-weight:500}
.rel-row .btn-row{justify-content:flex-end}
.rel-row .flag{color:var(--warn);font-weight:500}
.rel-tot{display:grid;grid-template-columns:minmax(0,1fr) 112px 132px;column-gap:16px;padding:8px 0;font-weight:600}
.rel-tot .n{border-top:1px solid var(--midnight);border-bottom:3px double var(--electric);padding:4px 0}
.rel-tot.sub{font-weight:400;color:var(--ink-2)}
.rel-tot.sub .n{border:0}
.tbl-fs.t28 td{height:28px}
.tbl-fs .l2{white-space:nowrap}
.pl td{height:41px}
.pl .fs-elim td{height:32px}
.cov td{height:44px}
.pl .fs-grand td{height:40px}
"""


def m_kpis(p):
    d_cash = T["cash"] - T["cash_sep30"]
    EBM = f'{T["ebitda"] / T["rev"] * 100:.1f}%'
    EBP = "(" + f'{abs(T["ebitda"] / T["ebitda_bud"] - 1) * 100:.1f}' + "%)"
    tiles = [
        ("Cash · 13 clients", f0(T["cash"]), [f'<span class="pos">{pv(sgn0(d_cash))}</span> since Sep 30', "Live from bank feeds"]),
        ("13-week low", f0(T["cash_low"]), ["Dec 4 · payroll and draws", f'{pv("2.3×")} the 4,000,000 floor']),
        ("Revenue · Sep", f0(T["rev"]), [f'<span class="neg">{pv(sgn0(T["rev"] - T["rev_bud"]))}</span> vs budget', f'{pv(sgn0(T["rev"] - T["rev_aug"]))} vs Aug']),
        ("EBITDA · Sep", f0(T["ebitda"]), [f'<span class="neg">{pv(sgn0(T["ebitda"] - T["ebitda_bud"]))}</span> vs budget', f'{pv(EBM)} of revenue']),
        ("DSO", "47 days", [f'<span class="neg">{pv("+4 days")}</span> vs Aug', "Artistry draws drive it"]),
        ("DPO", "38 days", [f'{pv("−2 days")} vs Aug', "Terms target 40"]),
    ]
    out = ""
    for l, v, vs in tiles:
        vs_html = "".join(f"<span>{x}</span>" for x in vs)
        out += f'<a class="kpi" href="#"><span class="fig-l">{l}</span><span class="fig-v--dense">{pv(v)}{ico("chev")}</span><span class="fig-vs">{vs_html}</span></a>'
    return (f'<section class="wg" style="--x:1;--y:1;--w:12;--h:1" aria-label="Key figures, intercompany out" data-widget="cfo.kpis">'
            f'<div class="kpis">{out}</div></section>')


def m_release(p):
    rows = [
        ('Payroll<span class="sl">//</span>Metro Heating &amp; Cooling', "41 employees · pays Fri Oct 23 · approved by Jordan Smith", 214880.40,
         '<button class="btn btn--primary" type="button" data-done="Released Metro payroll">Release</button>', "· funds leave Hills Bank ••8812 Thu Oct 22"),
        ('Vendor run<span class="sl">//</span>AIM Kitchen &amp; Bath', "11 bills · pays Tue Oct 20 · approved by Mike Heilman", 58312.10,
         '<button class="btn btn--primary" type="button" data-done="Released AIM vendor run">Release</button>', "· ACH file goes at 4:00 PM"),
        ('Subcontractor draws<span class="sl">//</span>Artistry Homes', '6 payees · pays Wed Oct 21 · <span class="flag">Hansen Concrete changed bank account Oct 15, not verified</span>', 402150.00,
         '<button class="btn" type="button" data-done="Verified Hansen Concrete by call-back">Verify payee</button>', "· release unlocks once verified"),
        ('Vendor run<span class="sl">//</span>Heartland Heating &amp; Cooling', "14 bills · pays Wed Oct 21 · waiting on Mike Heilman to approve", 186420.55,
         '<span class="status status--track"><i class="pip pip--track" aria-hidden="true"></i>Waiting on owner</span>', ""),
    ]
    items = ""
    for eb, txt, amt, act, after in rows:
        dl = (f'<div data-doneline><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><b data-what></b><span>{after}</span>'
              f'<button class="btn btn--quiet" type="button" data-undo-line>Undo</button></div>') if after else ""
        items += (f'<li class="rel-row" data-dec><div><div class="eyebrow">{eb}</div><p>{txt}</p></div><span class="n">{pv(f2(amt))}</span>'
                  f'<div class="btn-row">{act}</div>{dl}</li>')
    ready = 214880.40 + 58312.10
    allv = ready + 402150.00 + 186420.55
    tot = (f'<div class="rel-tot"><span>Ready to release, 2 items</span><span class="n">{pv(f2(ready))}</span><span></span></div>'
           f'<div class="rel-tot sub"><span>All 4 waiting, incl. 2 not ready</span><span class="n">{pv(f2(allv))}</span><span></span></div>')
    body = f'<ol class="rel">{items}</ol>{tot}'
    foot = f'<span>You prepared none of these · separation of duties checked</span><button class="btn btn--primary" type="button">Release 2 · {pv(f2(ready))}</button>'
    return wg("cfo.release", "Awaiting release", body, 1, 2, 8, 3, count="4", meta="Payments and payroll", foot=foot, primary=True, label_id=f"{p}-rel")


def m_blockers(p):
    body = f"""<div class="bs-top">{meter(7, 1, 13, label="7 of 13 closed, 1 ready for review")}<span><b class="tnum">7 of 13</b> closed · target Oct 21</span></div>
<table class="tbl mini"><colgroup><col><col style="width:96px"></colgroup><tbody>
<tr><td><span class="l1">Dorrian HVAC</span><span class="l2">Bank of Iowa feed down 3 days</span></td><td style="text-align:right">{status("blocked")}</td></tr>
<tr><td><span class="l1">Crystal Kitchen &amp; Bath</span><span class="l2">Due Oct 16 · 26 to review</span></td><td style="text-align:right">{status("overdue")}</td></tr>
<tr><td><span class="l1">Clive Power Equipment</span><span class="l2">6 hours of work, 4 available</span></td><td style="text-align:right">{status("risk")}</td></tr>
</tbody></table>
<p class="t-cap" style="margin-top:8px">3 on track or ready · nothing else blocks the close</p>"""
    foot = f'<span>Consolidated can close once Dorrian and Crystal do</span><a class="btn btn--quiet" href="#">Close grid{ico("right")}</a>'
    return wg("cfo.close_blockers", "Close blockers", body, 9, 2, 4, 3, count="3", foot=foot, label_id=f"{p}-cb")


REASON = {"artistry": "Two draws slipped to October", "dorrian": "Install volume down; feed outage",
          "heartland": "Supplier price rises on 14 jobs", "crystal": "Fewer remodel starts",
          "heritage": "Design fees billed late", "metro": "On plan"}


def m_pl(p):
    order = ["artistry", "dorrian", "heartland", "crystal", "heritage", "metro"]
    rest = [c for c in CLIENTS if c["key"] not in order]
    rows = ""
    for k in order:
        c = BY[k]
        ev = c["ebitda"] - c["ebitda_bud"]
        pc = ev / c["ebitda_bud"] * 100
        rows += (f'<tr class="fs-line" tabindex="0" data-drill="{E(c["name"])} variance"><td><span class="l1">{E(c["name"])}</span><span class="l2">{REASON[k]}</span></td>'
                 f'{cell(c["rev"], cls="cur")}{cell(c["rev"] - c["rev_bud"])}{cell(c["ebitda"], cls="cur")}{cell(ev, cls="b" if abs(ev) >= 50000 else "")}'
                 f'<td class="n">{pv(f0(pc) + "%" if pc >= 0 else "(" + f"{abs(pc):.0f}" + "%)")}</td></tr>')
    r_rev = sum(c["rev"] for c in rest); r_rb = sum(c["rev_bud"] for c in rest)
    r_e = sum(c["ebitda"] for c in rest); r_eb = sum(c["ebitda_bud"] for c in rest)
    rows += (f'<tr class="fs-line" tabindex="0" data-drill="other clients"><td><span class="l1">7 other clients</span><span class="l2">All within 10% of budget</span></td>'
             f'{cell(r_rev, cls="cur")}{cell(r_rev - r_rb)}{cell(r_e, cls="cur")}{cell(r_e - r_eb)}<td class="n">{pv(f"{(r_e / r_eb - 1) * 100:.0f}%")}<span class="hp">)</span></td></tr>')
    rows += (f'<tr class="fs-line fs-elim"><td><span class="l1">Less intercompany management fees</span></td>{cell(-G["elim"], cls="cur")}<td class="n">—<span class="hp">)</span></td><td class="n cur">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td></tr>')
    te = T["ebitda"] - T["ebitda_bud"]
    TEP = "(" + f'{abs(te / T["ebitda_bud"] * 100):.0f}' + "%)"
    rows += (f'<tr class="fs-grand"><td>13 clients, intercompany out</td>{cell(T["rev"], cls="cur")}{cell(T["rev"] - T["rev_bud"])}{cell(T["ebitda"], cls="cur")}{cell(te)}'
             f'<td class="n">{pv(TEP)}</td></tr>')
    table = f"""<table class="tbl tbl-fs pl" aria-label="P&amp;L vs budget by client, September">
<colgroup><col><col style="width:104px"><col style="width:96px"><col style="width:96px"><col style="width:96px"><col style="width:64px"></colgroup>
<thead><tr><th>Client · largest EBITDA miss first</th><th class="n cur">Revenue</th><th class="n">vs budget</th><th class="n cur">EBITDA</th><th class="n">vs budget</th><th class="n">%</th></tr></thead>
<tbody>{rows}</tbody></table>"""
    return wg("cfo.compare", "P&amp;L vs budget by client", table, 1, 5, 8, 3, meta="September, preliminary · reasons are AI notes from the posted ledger", label_id=f"{p}-pl")


def m_exposure(p):
    ar_rows = "".join(f'<tr class="fs-line"><td>{a}</td>{cell(v)}</tr>' for a, v in AR)
    ap_rows = "".join(f'<tr class="fs-line"><td>{a}</td>{cell(v)}</tr>' for a, v in AP)
    ar_t = sum(v for _, v in AR); ap_t = sum(v for _, v in AP)
    body = f"""<table class="tbl tbl-fs t28" aria-label="Receivables aging"><colgroup><col><col style="width:112px"></colgroup>
<thead><tr><th>Receivables · intercompany out</th><th class="n">Today</th></tr></thead>
<tbody>{ar_rows}<tr class="fs-sub"><td>Total receivables</td>{cell(ar_t)}</tr></tbody></table>
<table class="tbl tbl-fs t28" style="margin-top:12px" aria-label="Payables"><colgroup><col><col style="width:112px"></colgroup>
<thead><tr><th>Payables · intercompany out</th><th class="n">Today</th></tr></thead>
<tbody>{ap_rows}<tr class="fs-sub"><td>Total payables</td>{cell(ap_t)}</tr></tbody></table>"""
    foot = f'<span>Overdue {pv(f0(T["ar_overdue"]))} · Artistry {pv("612,000")}</span><a class="btn btn--quiet" href="#">Collections{ico("right")}</a>'
    return wg("cfo.exposure", "Receivables &amp; payables", body, 9, 5, 4, 3, foot=foot, label_id=f"{p}-ex")


def m_cons_small(p):
    def ln(label, a, b, cls="fs-line", u=True):
        v = a - b
        vt = cell(v) if v else f'<td class="n">—<span class="hp">)</span></td>'
        return f'<tr class="{cls}"><td>{label}</td>{cell(a, cls="cur")}{cell(b)}{vt}</tr>'
    rows = ln("Revenue, before eliminations", G["rev_pre"], G["rev_pre_bud"])
    rows += ln("Intercompany management fees", -G["elim"], -G["elim"], "fs-line fs-elim")
    rows += ln("Revenue", G["rev"], G["rev_bud"], "fs-sub")
    rows += ln("EBITDA", G["ebitda"], G["ebitda_bud"], "fs-grand")
    body = f"""<table class="tbl tbl-fs" aria-label="Consolidated summary"><colgroup><col><col style="width:104px"><col style="width:104px"><col style="width:96px"></colgroup>
<thead><tr><th>9 clients · September</th><th class="n cur">Sep 2026</th><th class="n">Budget</th><th class="n">vs budget</th></tr></thead><tbody>{rows}</tbody></table>"""
    foot = f'<span>Draft · 2 members open · 7 of 8 fee pairs agree</span><a class="btn btn--primary" href="#">{ico("layers")}Open consolidated</a>'
    return wg("cfo.consolidated", "Merit Management Group — Consolidated", body, 1, 8, 6, 2, foot=foot, label_id=f"{p}-cons")


def m_cov(p):
    rows = [("Dorrian HVAC · DSCR", "Bank of Iowa · tests Nov 30", "1.18×", "1.25×", "(0.07×)", status("overdue", "Below")),
            ("Crystal Kitchen &amp; Bath · DSCR", "West Bank · tests Dec 31", "1.29×", "1.25×", "0.04×" + HP, status("risk", "Tight")),
            ("Heritage Interiors · DSCR", "Farmers State · tests Dec 31", "1.34×", "1.20×", "0.14×" + HP, status("ready", "Inside"))]
    tr = "".join(f'<tr class="fs-line"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td class="n">{pv(c)}</td><td class="n">{d}</td><td class="n">{pv(e)}</td><td>{f}</td></tr>' for a, b, c, d, e, f in rows)
    body = f"""<table class="tbl tbl-fs cov" aria-label="Covenant headroom"><colgroup><col><col style="width:64px"><col style="width:64px"><col style="width:104px"><col style="width:104px"></colgroup>
<thead><tr><th>Client · test</th><th class="n">Actual</th><th class="n">Min</th><th class="n">Headroom</th><th style="padding-left:16px">Status</th></tr></thead><tbody>{tr}
</tbody></table><p class="t-cap" style="margin-top:8px">8 more tests inside with 0.2× or more</p>"""
    body = body.replace('<td><span class="status', '<td style="padding-left:16px"><span class="status')
    foot = f'<span>Dorrian is 84,000 short of 1.25×</span><a class="btn" href="#">Draft lender note</a>'
    return wg("cfo.covenants", "Covenant headroom", body, 7, 8, 6, 2, count="11", foot=foot, label_id=f"{p}-cov")


def cfo_app(p, live=False):
    groups = [("Home", [("Home", True), ("Inbox", False, 6)]),
              ("Work", [("Approvals and release", False, 4), ("Close grid",), ("Exceptions", False, 17)]),
              ("Consolidated", [("Merit Management Group",)]),
              ("Reports", [("Statements",), ("Cash and forecast",), ("Budgets",), ("Covenants", False, 1), ("Board package",)]),
              ("Settings", [("Accounting settings",)])]
    r = rail(groups, "Nora Lindqvist", "CFO")
    ctxl = ctxline(["Mon Oct 19", "September close", "Day 12 of 15", "7 of 13 clients closed", f'<b>2 ready to release · {pv("273,192.50")}</b>'],
                   right=privacy_btn() + customize_btn() + '<span class="sample">Sample data</span>')
    mods = m_kpis(p) + m_release(p) + m_blockers(p) + m_pl(p) + m_exposure(p) + m_cons_small(p) + m_cov(p)
    main = ctxl + f'<div class="page"><div class="dash">{mods}</div></div>'
    a = app("workspace", "density-report", r, bar(ctx_workspace(), "Home"), main)
    return a.replace('<div class="app ', '<div data-live class="app ', 1) if live else a


def build():
    html = head("S6b · CFO home", CSS) + sheet_top("S6b-cfo-home.html") + '<main id="main" class="sheet">'
    html += board_h('S6b<span class="sl">//</span>IA-SPEC §4.6 · CFO', "Nora’s home: cash, plan, exposure, what’s blocking the close",
                    "One strip of six figures, each with a comparison and a destination, then the money waiting for her release. "
                    "Below: who is off plan and why, what we’re owed and owe, the group, and the covenants. Same tenant, same figures as Mike’s home.",
                    "S6b")
    html += f'<div class="frame">{cfo_app("f", True)}</div>'
    html += '<div class="frame-cap"><span>Open state · Annual Report density · CFO has all-client scope, so the group view comes with it (IA-SPEC Q4).</span><span>Ties to S6: cash 9,914,770 · revenue 11,978,300 · overdue 1,214,880</span></div>'
    html += anno([
        ("Release is the decision", "The strip is read; the release list is acted on. Only items someone else prepared and approved can be released, and one with an unverified bank change can’t until it’s verified."),
        ("The Heartland run waits on Mike", "The payment run Mike approves on S6 shows here as Waiting on owner, so neither of them wonders where it is."),
        ("Variance with a reason", "Each client row carries its one-line reason from the AI’s flux note. Open the row for the evidence that sums to the variance."),
        ("Strip, not heroes", "Six figures in DM Sans at 20px, one row high. No figure is bigger than the work beneath it."),
    ])
    html += "</main>" + TOAST + SCRIPT + NOTE_SCRIPT + "</body></html>"
    return html


if __name__ == "__main__":
    open("../S6b-cfo-home.html", "w").write(build())
    print("ok")
