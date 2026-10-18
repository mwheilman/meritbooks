"""S6 — Owner home (Mike, owner, Merit Management Group workspace). Annual Report density."""
from common import *
from data import CLIENTS, BY, G, T, RUN, RUN_TOTAL, RUN_BAL, RUN_AFTER, ELIM

CSS = """
/* S6 layout only */
.slip{display:grid;grid-template-columns:minmax(0,1fr) 288px;column-gap:24px;margin-top:16px;padding:16px 20px;background:var(--white);border:1px solid var(--line)}
.slip-main .t-head{margin-top:4px}
.slip-main p{margin-top:4px;color:var(--ink-2)}
.slip-main .ev{margin-top:8px}
.slip-side{display:flex;flex-direction:column;gap:12px;padding-left:24px;border-left:1px solid var(--line)}
.slip-side .kv{gap:4px 12px}
.slip-side .inline-notice{padding:8px 12px;gap:8px}
.slip-side .inline-notice svg{margin-top:2px;color:var(--warn)}
.slip-side .btn-row{margin-top:auto}
.ev li.ev-grand{border-top:1px solid var(--midnight);border-bottom:3px double var(--electric);margin-top:4px;font-weight:600}
.ev li .ev-n{color:var(--ink-3);font-size:12px}
.dec-list{list-style:none}
.dec-row{display:grid;grid-template-columns:minmax(0,1fr) 104px auto;column-gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.dec-row p{margin-top:2px;color:var(--ink)}
.dec-row .n{font-weight:500}
[data-doneline]{display:none;align-items:center;gap:8px;color:var(--ink-2)}
[data-doneline] .wg-done-mark{width:24px;height:24px}
.is-resolved>:not([data-doneline]){display:none!important}
.is-resolved [data-doneline]{display:flex}
.slip.is-resolved{display:block;padding:12px 20px}
.dec-row.is-resolved{display:block}
.alldone{padding:24px 0;height:auto}
.glance{list-style:none}
.gl{display:grid;grid-template-columns:minmax(0,1fr) auto 16px;column-gap:12px;row-gap:4px;padding:14px 0;border-bottom:1px solid var(--line);transition:background-color var(--fast) var(--ease),box-shadow var(--fast) var(--ease)}
.gl:hover{background:var(--sky);box-shadow:-8px 0 0 var(--sky),8px 0 0 var(--sky)}
.gl .fig-l{grid-column:1;grid-row:1;align-self:center}
.gl .fig-v--dense{grid-column:2;grid-row:1;text-align:right;white-space:nowrap}
.gl .chev{grid-column:3;grid-row:1;align-self:center;color:var(--ink-3)}
.gl .fig-vs{grid-column:1;grid-row:2;flex-direction:column;gap:2px}
.gl .spark{grid-column:2/4;grid-row:2;justify-self:end;align-self:end}
.cons-foot{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);column-gap:24px;margin-top:16px}
.cons-foot .note{border-top-color:var(--electric);padding:12px 16px 12px;background:var(--canvas)}
.cons-foot .note-top{grid-template-columns:40px 1fr}
.tbl-fs.tight td{height:32px}
.bs-top{display:flex;align-items:center;gap:8px;padding:12px 0 8px}
.bs-top .meter{padding-left:8px}
.mini td{height:40px;padding:0 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.mini tr>td:first-child{padding-left:0}
.mini tr>td:last-child{padding-right:0}
.mini .l1,.mini .l2{white-space:nowrap}
.cmp td:first-child .ico{color:var(--ink-3);margin-left:6px;vertical-align:-3px}
.cmp tbody tr[data-drill]{cursor:pointer}
.cmp tbody tr[data-drill]:focus-visible{outline:2px solid var(--electric);outline-offset:-2px}
.cmp td.chev{color:var(--ink-3);text-align:right}
.cmp .tag{margin-left:8px}
.states .wg{background:var(--white);border:1px solid var(--line)}
.states .wg-head{padding:12px 16px 8px}
.ghost-wg{border:1.5px dashed var(--grey-400)!important;background:transparent!important}
"""

# ------------------------------------------------------------ sparkline
def spark(vals, w=96, h=20, label="", low_mark=False):
    lo, hi = min(vals), max(vals)
    rng = (hi - lo) or 1
    pts_ = []
    for i, v in enumerate(vals):
        x = 2 + i * (w - 4) / (len(vals) - 1)
        y = 2 + (hi - v) / rng * (h - 4)
        pts_.append((x, y))
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts_)
    mi = vals.index(lo) if low_mark else len(vals) - 1
    mx, my = pts_[mi]
    return (f'<svg class="spark" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{E(label)}">'
            f'<polyline points="{poly}" fill="none" stroke="#3D4F65" stroke-width="1.25"/>'
            f'<rect x="{mx-2:.1f}" y="{my-2:.1f}" width="4" height="4" fill="#2563EB"/></svg>')


# ------------------------------------------------------------ modules
def m_decisions(p, x=1, y=1):
    ev = "".join(f'<li>{E(v)} <span class="ev-n">· {n} bill{"s" if n > 1 else ""}</span><span class="dl"></span><span class="v">{pv(f2(a))}</span></li>' for v, n, a in RUN)
    ev += f'<li class="ev-grand">14 bills, 9 vendors<span class="dl"></span><span class="v">{pv(f2(RUN_TOTAL))}</span></li>'
    slip = f"""<article class="slip" data-dec>
  <div class="slip-main">
    <div class="eyebrow">Payment run<span class="sl">//</span>Heartland Heating &amp; Cooling</div>
    <h3 class="t-head">14 bills, paid Wed Oct 21 by ACH</h3>
    <p>Prepared by Sam Kovac, reviewed by Jordan Smith. Nora Lindqvist releases it after you approve.</p>
    <ul class="ev" aria-label="Payment run by vendor">{ev}</ul>
  </div>
  <div class="slip-side">
    <dl class="kv"><dt>Pays from</dt><dd>West Bank ••2207</dd><dt>Balance today</dt><dd>{pv(f2(RUN_BAL))}</dd><dt>After this run</dt><dd>{pv(f2(RUN_AFTER))}</dd></dl>
    <div class="inline-notice inline-notice--warn">{ico("flag")}<div><b>Johnstone Supply changed bank details Oct 12.</b> Jordan Smith confirmed by phone Oct 14.</div></div>
    <div class="btn-row"><button class="btn btn--primary" type="button" data-done="Approved Heartland payment run">Approve {pv(f2(RUN_TOTAL))}<span class="kbd">A</span></button><button class="btn" type="button">Hold</button></div>
  </div>
  <div data-doneline><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><b data-what></b><span>· Nora Lindqvist releases it Wed Oct 21</span><button class="btn btn--quiet" type="button" data-undo-line>Undo</button></div>
</article>"""

    def row(eyebrow, text, amount, actions, after):
        amt = f'<span class="n">{pv(amount)}</span>' if amount else '<span></span>'
        return (f'<li class="dec-row" data-dec><div><div class="eyebrow">{eyebrow}</div><p>{text}</p></div>{amt}<div class="btn-row">{actions}</div>'
                f'<div data-doneline><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><b data-what></b><span>{after}</span><button class="btn btn--quiet" type="button" data-undo-line>Undo</button></div></li>')
    rows = row('Bill over your 25,000 limit<span class="sl">//</span>Metro Heating &amp; Cooling',
               "Lennox International, PO-3318. Six condensing units for the Ankeny school job.", "48,200.00",
               '<button class="btn btn--primary" type="button" data-done="Approved Lennox bill">Approve</button><button class="btn" type="button" data-done="Rejected Lennox bill">Reject</button>',
               "· Sam Kovac is told")
    rows += row('Question from Dana Lee<span class="sl">//</span>Swan Creek',
                "Oct 2 wire to Polk County Treasurer. Is it 2026 property tax, or the 2025 balance?", "12,400.00",
                '<button class="btn" type="button" data-done="Answered: 2026 property tax">2026 tax</button><button class="btn" type="button" data-done="Answered: 2025 balance">2025 balance</button><button class="btn btn--quiet" type="button" data-done="Asked Dana to call">Call me</button>',
                "· Dana Lee re-codes it and the answer teaches vendor memory")
    rows += row('Sign-off<span class="sl">//</span>Artistry Homes',
                "September statements are reviewed. Jordan Smith signed the review Oct 16.", "",
                '<a class="btn btn--primary" href="#" data-done="Accepted Artistry September statements">Review and accept</a>',
                "· September is locked for Artistry Homes")
    alldone = (f'<div class="wg-state alldone" data-alldone hidden><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span>'
               '<span class="t-head">Nothing needs you.</span><p>Books are current through Aug 31. September statements for the other 12 clients are due by Oct 21.</p></div>')
    body = slip + f'<ol class="dec-list" aria-label="Other decisions">{rows}</ol>' + alldone
    return wg("ow.decisions", "Needs your input", body, x, y, 8, 4, count="4", meta="2 approvals · 1 answer · 1 sign-off",
              act=f'<a class="btn btn--quiet" href="#">Inbox{ico("right")}</a>', primary=True, label_id=f"{p}-dec")


def m_glance(p, x=9, y=1):
    cash_series = [9914770, 9802100, 9640300, 9721800, 9588200, 9466900, 9512400, 9391700, 9284600, 9146200, 9233800, 9402100, 9551300]
    rev_series = [10.92, 11.31, 11.06, 11.48, 11.72, 12.01, 11.86, 11.64, 11.93, 11.98]
    gm_series = [25.4, 25.1, 24.9, 25.6, 25.2, 24.8, 24.6, 24.9, 24.7, 23.0]
    ar_series = [1.02, 1.07, 1.11, 1.06, 1.09, 1.13, 1.13, 1.21]
    ap_series = [1.86, 2.04, 1.92, 2.11, 2.02, 2.19]

    def fig(label, value, vs, sp, href="#"):
        vs_html = "".join(f"<span>{v}</span>" for v in vs)
        return (f'<li><a class="gl" href="{href}"><span class="fig-l">{label}</span><span class="fig-v--dense">{pv(value)}</span>'
                f'{ico("chev", cls="ico chev")}<span class="fig-vs">{vs_html}</span>{sp}</a></li>')
    d_cash = T["cash"] - T["cash_sep30"]
    GMB = f'{T["gm_bud"]:.1f}%'
    d_rev_aug = T["rev"] - T["rev_aug"]
    d_rev_bud = T["rev"] - T["rev_bud"]
    items = [
        fig("Cash today", f0(T["cash"]),
            [f'<span class="pos">{pv(sgn0(d_cash))}</span> since Sep 30', f'13-week low {pv(f0(T["cash_low"]))} on Dec 4'],
            spark(cash_series, label="13-week forecast; low 9,146,200 on Dec 4", low_mark=True)),
        fig("Revenue · September", f0(T["rev"]),
            [f'{pv(sgn0(d_rev_aug))} vs Aug', f'<span class="neg">{pv(sgn0(d_rev_bud))}</span> vs budget'],
            spark(rev_series, label="Revenue, last 10 months")),
        fig("Gross margin · September", f'{T["gm"]:.1f}%',
            [f'<span class="neg">{pv(pts(T["gm"] - T["gm_aug"]))}</span> vs Aug', f'{pv(pts(T["gm"] - T["gm_bud"]))} vs budget {pv(GMB)}'],
            spark(gm_series, label="Gross margin, last 10 months")),
        fig("Receivables overdue", f0(T["ar_overdue"]),
            [f'{T["ar_overdue_n"]} invoices · {pv(sgn0(T["ar_overdue"] - T["ar_overdue_lw"]))} vs last week', f'Artistry draws are {pv("612,000")} of it'],
            spark(ar_series, label="Overdue receivables, last 8 weeks")),
        fig("Bills due in 14 days", f0(T["ap_14"]),
            [f'Cash covers it {T["cash"] / T["ap_14"]:.1f}×', 'Next run Wed Oct 21'],
            spark(ap_series, label="Bills due in 14 days, last 6 weeks")),
    ]
    body = f'<ul class="glance">{"".join(items)}</ul>'
    foot = '<span>Cash live from bank feeds · ledger through Sep 30</span>'
    return wg("ow.glance", "At a glance", body, x, y, 4, 4, meta="13 clients · intercompany out", foot=foot, label_id=f"{p}-gl")


def m_consolidated(p, x=1, y=5):
    def line(label, a, b, c, fu="", cls="fs-line", note="", bold=False):
        var = a - c
        varc = "b" if abs(var) >= 100000 else ""
        nt = f'<a class="nref" href="#{p}-n1" data-note="{p}1" aria-label="See note 1">1</a>' if note else ""
        fu_html = {"F": '<span class="fu fu--f" aria-label="favorable">F</span>', "U": '<span class="fu fu--u" aria-label="unfavorable">U</span>'}.get(fu, '<span class="fu ink-3">–</span>')
        var_td = cell(var, cls=varc) if var else f'<td class="n">{pv("—" + HP)}</td>'
        dn = f' data-note="{p}1"' if note else ""
        return f'<tr class="{cls}"{dn}><td>{label}</td><td class="nt">{nt}</td>{cell(a, cls="cur")}{cell(b)}{cell(c)}{var_td}<td>{fu_html}</td></tr>'
    rows = line("Revenue, before eliminations", G["rev_pre"], G["rev_pre_aug"], G["rev_pre_bud"], "U")
    rows += line("Intercompany management fees", -G["elim"], -G["elim"], -G["elim"], "", "fs-line fs-elim", note=True)
    rows += line("Revenue", G["rev"], G["rev_aug"], G["rev_bud"], "U", "fs-sub")
    rows += line("Gross profit", G["gp"], G["gp_aug"], G["gp_bud"], "U")
    rows += line("Operating income", G["oi"], G["oi_aug"], G["oi_bud"], "U")
    rows += line("Depreciation and amortization", G["da"], G["da_aug"], G["da_bud"], "")
    rows += line("EBITDA", G["ebitda"], G["ebitda_aug"], G["ebitda_bud"], "U", "fs-grand")
    table = f"""<table class="tbl tbl-fs" aria-label="Consolidated income, September 2026">
<colgroup><col><col style="width:40px"><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:96px"><col style="width:24px"></colgroup>
<thead><tr><th>September, preliminary</th><th class="nt">Note</th><th class="n cur">Sep 2026</th><th class="n">Aug 2026</th><th class="n">Budget</th><th class="n">vs budget</th><th></th></tr></thead>
<tbody>{rows}</tbody></table>"""
    pos = f"""<table class="tbl tbl-fs" aria-label="Group position">
<colgroup><col><col style="width:88px"><col style="width:88px"><col style="width:80px"></colgroup>
<thead><tr><th>Position</th><th class="n cur">Today</th><th class="n">Sep 30</th><th class="n">Change</th></tr></thead>
<tbody><tr class="fs-line"><td>Cash, 9 clients</td>{cell(G["cash"], cls="cur")}{cell(G["cash_sep30"])}{cell(G["cash"] - G["cash_sep30"])}</tr>
<tr class="fs-line"><td>Net debt</td>{cell(G["net_debt"], cls="cur")}{cell(G["net_debt_sep30"])}{cell(G["net_debt"] - G["net_debt_sep30"])}</tr></tbody></table>
<p class="t-cap" style="margin-top:8px">Net debt is bank and seller debt less cash. Every figure opens its statement line.</p>"""
    ev = "".join(f'<li>{E(a)}<span class="dl"></span><span class="v">{pv(f0(v))}</span></li>' for a, v in ELIM)
    ev += f'<li class="ev-total">Removed from revenue and expenses<span class="dl"></span><span class="v">{pv(f0(G["elim"]))}</span></li>'
    note = f"""<article class="note" id="{p}-n1" data-note="{p}1"><div class="note-top"><span class="note-no" aria-hidden="true">1</span><div><div class="note-kind">Note 1 · Eliminations</div><h3 class="note-title">Fees removed on both sides</h3></div></div>
<ul class="ev">{ev}</ul><div class="basis"><span><b>7 of 8</b> pairs agree</span><span>Dorrian booked 4,250.00 less</span></div></article>"""
    body = table + f'<div class="cons-foot"><div>{pos}</div>{note}</div>'
    foot = (f'<span>Draft · Dorrian HVAC and Crystal Kitchen &amp; Bath still open</span>'
            f'<a class="btn btn--primary" href="#">{ico("layers")}Open consolidated statements</a>')
    return wg("ow.consolidated", "Merit Management Group — Consolidated", body, x, y, 8, 4, meta="9 clients · eliminations on", foot=foot, label_id=f"{p}-cons")


def m_books(p, x=9, y=5, w=4):
    body = f"""<div class="bs-top">{meter(7, 1, 13, label="7 of 13 closed, 1 ready for review")}<span><b class="tnum">7 of 13</b> closed for September</span></div>
<table class="tbl mini"><colgroup><col style="width:104px"><col><col style="width:112px"></colgroup><tbody>
<tr><td>{status("blocked")}</td><td>Dorrian HVAC</td><td class="ink-2" style="text-align:right">Feed down 3 days</td></tr>
<tr><td>{status("overdue")}</td><td>Crystal Kitchen &amp; Bath</td><td class="ink-2" style="text-align:right">Due Oct 16</td></tr>
<tr><td>{status("risk")}</td><td>Clive Power Equipment</td><td class="ink-2" style="text-align:right">Due Oct 21</td></tr>
</tbody></table>
<p class="t-cap" style="margin-top:8px">Swan Creek and Heritage on track · Wild Rose ready for review</p>"""
    foot = f'<span>Reviewer: Jordan Smith</span><a class="btn btn--quiet" href="#">See what’s open{ico("right")}</a>'
    return wg("ow.books_status", "Books status", body, x, y, w, 2, meta="Closed through Aug 31", foot=foot, label_id=f"{p}-bs")


def m_covenants(p, x=9, y=7, w=4):
    body = f"""<table class="tbl mini" style="margin-top:4px"><colgroup><col><col style="width:56px"><col style="width:{120 if w == 4 else 160}px"></colgroup><tbody>
<tr><td><span class="l1">Dorrian HVAC</span><span class="l2">DSCR · Bank of Iowa · tests Nov 30</span></td><td class="n">{pv("1.18×")}</td><td style="text-align:right">{status("overdue", "Below 1.25×")}</td></tr>
<tr><td><span class="l1">Crystal Kitchen &amp; Bath</span><span class="l2">DSCR · West Bank · tests Dec 31</span></td><td class="n">{pv("1.29×")}</td><td style="text-align:right">{status("risk", "Tight · 1.25×")}</td></tr>
<tr><td><span class="l1">9 other tests</span><span class="l2">Least headroom: Heritage, 0.14×</span></td><td class="n"></td><td style="text-align:right">{status("ready", "Inside")}</td></tr>
</tbody></table>"""
    foot = f'<span>Dorrian is 84,000 short</span><a class="btn" href="#">Open Dorrian workpaper</a>'
    return wg("ow.covenants", "Covenants", body, x, y, w, 2, meta="11 tests", foot=foot, label_id=f"{p}-cov")


def m_compare(p, x=1, y=9, grant=True):
    order = ["artistry", "dorrian", "heartland", "crystal", "heritage", "metro", "swan", "wildrose", "mmg", "revived", "aim", "icc", "clive"]
    rows = ""
    for k in order:
        c = BY[k]
        gm = c["gp"] / c["rev"] * 100
        gm_aug = c["gp_aug"] / c["rev_aug"] * 100
        nm = E(c["name"])
        if k == "mmg":
            nm += '<span class="tag">Own books</span>'
        if grant and c["member"]:
            nm += f'<svg class="ico" width="16" height="16" role="img" aria-label="In Merit Management Group — Consolidated"><title>In Merit Management Group — Consolidated</title><use href="#i-layers"/></svg>'
        gm_td = f'<td class="n ink-3">—<span class="hp">)</span></td>' if k == "mmg" else pct_cell(gm)
        gma = f'<td class="n ink-3">—<span class="hp">)</span></td>' if k == "mmg" else f'<td class="n">{pv(pts(gm - gm_aug).replace(" pts", ""))}<span class="hp">)</span></td>'
        rv = c["rev"] - c["rev_bud"]
        ev = c["ebitda"] - c["ebitda_bud"]
        rows += (f'<tr class="fs-line" tabindex="0" data-drill="{E(c["name"])}"><td>{nm}</td>{cell(c["rev"], cls="cur")}'
                 f'{cell(rv) if rv else "<td class=n>—<span class=hp>)</span></td>"}{gm_td}{gma}{cell(c["ebitda"])}{cell(ev)}{cell(c["cash"])}'
                 f'<td>{status(c["close"])}</td><td class="chev">{ico("chev")}</td></tr>')
    rows += (f'<tr class="fs-line fs-elim"><td>Less intercompany management fees</td>{cell(-G["elim"], cls="cur")}<td class="n">—<span class="hp">)</span></td>'
             f'<td class="n">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td><td class="n">—<span class="hp">)</span></td><td></td><td></td></tr>')
    rows += (f'<tr class="fs-grand"><td>13 clients, intercompany out</td>{cell(T["rev"], cls="cur")}{cell(T["rev"] - T["rev_bud"])}{pct_cell(T["gm"])}'
             f'<td class="n">{pv(pts(T["gm"] - T["gm_aug"]).replace(" pts", ""))}<span class="hp">)</span></td>{cell(T["ebitda"])}{cell(T["ebitda"] - T["ebitda_bud"])}{cell(T["cash"])}<td></td><td></td></tr>')
    table = f"""<table class="tbl tbl-fs cmp" aria-label="Clients side by side, September 2026">
<colgroup><col><col style="width:104px"><col style="width:96px"><col style="width:84px"><col style="width:76px"><col style="width:96px"><col style="width:96px"><col style="width:104px"><col style="width:144px"><col style="width:24px"></colgroup>
<thead><tr><th>Client · sorted by EBITDA vs budget</th><th class="n cur">Revenue</th><th class="n">vs budget</th><th class="n">Margin</th><th class="n">vs Aug</th><th class="n">EBITDA</th><th class="n">vs budget</th><th class="n">Cash today</th><th>September close</th><th><span class="sr">Open</span></th></tr></thead>
<tbody>{rows}</tbody></table>"""
    seg = '<div class="seg" role="group" aria-label="Sort clients"><button type="button" aria-pressed="true">Behind budget</button><button type="button" aria-pressed="false">A–Z</button><button type="button" aria-pressed="false">Revenue</button></div>'
    return wg("ow.clients_compare", "Clients side-by-side", table, x, y, 12, 4, count="13", meta="September, preliminary · margin vs Aug in points", act=seg, label_id=f"{p}-cmp")


def rail_owner(grant=True):
    groups = [("Home", [("Home", True), ("Inbox", False, 4)])]
    if grant:
        groups.append(("Consolidated", [("Merit Management Group", False)]))
    groups.append(("Reports", [("Statements",), ("Cash position",), ("Budgets",), ("Board package",)]))
    foot = '<div class="eyebrow">September close</div><div class="rail-period"><span class="tnum" style="color:var(--warm);font-weight:500">7 of 13</span><span>closed</span></div>'
    return rail(groups, "Mike Heilman", "Owner", foot_extra=f'<div style="margin-bottom:16px">{foot}</div>')


def owner_app(p, grant=True, private=False, live=False):
    ctxl = ctxline(["Mon Oct 19", "September close", "Day 12 of 15", "7 of 13 clients closed", "<b>4 need you</b>"],
                   right=privacy_btn(private) + customize_btn() + '<span class="sample">Sample data</span>')
    if grant:
        mods = m_decisions(p) + m_glance(p) + m_consolidated(p, 1, 5) + m_books(p, 9, 5) + m_covenants(p, 9, 7) + m_compare(p, 1, 9, True)
    else:
        mods = m_decisions(p) + m_glance(p) + m_books(p, 1, 5, 6) + m_covenants(p, 7, 5, 6) + m_compare(p, 1, 7, False)
    main = ctxl + f'<div class="page"><div class="dash">{mods}</div></div>'
    cls = ("is-private" if private else "")
    a = app("workspace", "density-report", rail_owner(grant), bar(ctx_workspace(), "Home"), main, extra_cls=cls)
    if live:
        a = a.replace('<div class="app ', '<div data-live class="app ', 1)
    return a


def states():
    tiles = [
        ("Needs your input · done", f'<div class="wg-state"><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><span class="t-head">Nothing needs you.</span><p>Books are current through Sep 30. Next sign-off: October statements, Nov 13.</p></div>'),
        ("At a glance · empty", f'<div class="wg-state"><span class="wg-empty-mark" aria-hidden="true">{ico("plus")}</span><span class="t-head">Figures start after your first close.</span><p>October closes Nov 13. Until then, cash is live from your bank feeds.</p><a class="btn" href="#">Open cash position</a></div>'),
        ("Note · AI paused", f'<div class="wg-state"><span class="tag">AI paused</span><span class="t-head">Figures are exact. Explanations resume when AI is back.</span><p>Variances still compute from the posted ledger.</p></div>'),
        ("Consolidated · no grant", f'<div class="wg-state"><span class="t-head">Not rendered.</span><p>Without a group grant the module and its rail link don’t exist, and the grid closes the gap. No locked tile.</p></div>'),
    ]
    out = ""
    for i, (t, b) in enumerate(tiles):
        ghost = " ghost-wg" if i == 3 else ""
        out += wg(f"st{i}", t, b, i * 3 + 1, 1, 3, 2, extra_cls=ghost, label_id=f"st-{i}")
    return f'<div class="page density-report states" style="padding:24px 32px"><div class="dash">{out}</div></div>'


def build():
    html = head("S6 · Owner home", CSS) + sheet_top("S6-owner-home.html") + '<main id="main" class="sheet">'
    html += board_h('S6<span class="sl">//</span>IA-SPEC §4.5 · owner', "Mike’s home, as owner of Merit Management Group",
                    "It opens on the four things only Mike can decide, with the figures he’d check before deciding them beside it. "
                    "Below that, the group he holds a grant for, his covenants, and every client side by side. Try Approve, Hide figures (⇧H) and the client rows.",
                    "S6.1")
    html += f'<div class="frame">{owner_app("a", True, False, live=True)}</div>'
    html += '<div class="frame-cap"><span>Open state · 1440 wide · workspace context, Annual Report density · above the fold: bar, context line, Needs your input, At a glance.</span><span>Grid 12 × 136px rows</span></div>'
    html += anno([
        ("Decisions first, figures beside them", "No banner and no greeting. The left 8 columns are the work: one payment run, one bill, one question, one sign-off. The right 4 are what you’d check before approving: cash, margin, what’s due."),
        ("The slip proves the button", "The payment run lists its vendors in a ledger that sums, closed by the statement’s blue double rule. The Approve button carries the same 186,420.55. Approving is signing the total."),
        ("Intercompany never inflates a figure", "At a glance and the client table exclude intercompany fees by the related-client flag, so they don’t need a consolidation grant to be honest. The group view is the only place eliminations are computed."),
        ("Every number goes somewhere", "Each glance figure is one link with two comparisons. Each client row opens that client. Each statement line opens its report. The layers icon marks group members."),
    ])
    html += board_h('S6<span class="sl">//</span>Privacy', "Figures hidden for screen-sharing",
                    "Hide figures turns every amount, ratio and comparison into a bar of the same width. Nothing reflows, so the layout still reads, and names, counts and dates stay visible so Mike can still talk through it.",
                    "S6.2", h="h2", style=' style="margin-top:56px"')
    html += f'<div class="frame" style="height:900px">{owner_app("b", True, True)}</div>'
    html += '<div class="frame-cap"><span>Hide figures pressed · state is per session, never stored on the layout.</span><span>Cropped at 900px</span></div>'
    html += board_h('S6<span class="sl">//</span>Without a group grant', "The same owner home, no consolidation grant",
                    "Same role and the same 13 clients, but no grant on Merit Management Group — Consolidated. The module isn’t rendered and the Consolidated rail group is gone. Books status and Covenants move up and widen to six columns; the client table loses its group-member marks.",
                    "S6.3", h="h2", style=' style="margin-top:56px"')
    html += f'<div class="frame">{owner_app("c", False, False)}</div>'
    html += '<div class="frame-cap"><span>Reflowed layout · resolver output after permission filtering (IA-SPEC §5.1).</span><span>No blank tile, no lock</span></div>'
    html += board_h('S6<span class="sl">//</span>States', "Done, empty, AI paused, not rendered",
                    "Every module has a done state and an empty state. Done says what’s next; empty says what to do.", "S6.4", h="h2", style=' style="margin-top:56px"')
    html += f'<div class="frame">{states()}</div>'
    html += "</main>" + TOAST + SCRIPT + NOTE_SCRIPT + "</body></html>"
    return html


NOTE_SCRIPT = """<script>
(function(){function lit(id,on){document.querySelectorAll('[data-note="'+id+'"]').forEach(function(el){
  if(el.classList.contains('nref')||el.classList.contains('note'))el.classList.toggle('is-lit',on);else el.classList.toggle('is-lit-fig',on);});}
document.querySelectorAll('.nref,.note').forEach(function(el){var id=el.getAttribute('data-note');if(!id)return;
  ['mouseenter','focus'].forEach(function(e){el.addEventListener(e,function(){lit(id,true)})});
  ['mouseleave','blur'].forEach(function(e){el.addEventListener(e,function(){lit(id,false)})});});})();
</script>"""

if __name__ == "__main__":
    open("../S6-owner-home.html", "w").write(build())
    print("ok")
