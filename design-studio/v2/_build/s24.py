"""S24 — Debt & covenants hub + lender portal (IA-SPEC 3.6.1 /debt tabs, 4.6 cfo.covenants, debt.lender_calendar,
debt.borrowing_base, 4.15 lender viewer, 3.6.6 lender portal, 6.2 lender reporting, M-14)."""
from fo_common import *

CSS = """
/* S24 layout only */
.pad{padding:0 var(--margin)}
.dtabs{margin-top:16px}
.lay{table-layout:fixed}
.lay th{padding:8px;border-bottom:1px solid var(--electric);font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:right;white-space:nowrap}
.lay th:first-child,.lay th.l{text-align:left}
.lay td{height:44px;padding:4px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.lay td:first-child,.lay td.l{text-align:left}
.lay tr>*:first-child{padding-left:0}
.lay tr>*:last-child{padding-right:0}
.lay .hp{visibility:hidden}
.lay tr.tot td{font-weight:700;border-bottom:0}
.lay tr.tot td.n{border-top:1px solid var(--midnight);border-bottom:3px double var(--electric)}
.lay tr.sub td{font-weight:600}
.lay tr.sub td.n{border-top:1px solid var(--midnight)}
.lay tr.less td{color:var(--ink-2)}
.lay tr.less td:first-child{padding-left:16px}
/* signature: the headroom ruler — the limit, today, and the next three tests */
.cov{display:grid;grid-template-columns:200px minmax(0,1fr) 136px;gap:24px;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
.cov:first-of-type{border-top:2px solid var(--electric)}
.cov .nm{font-weight:600}
.cov .tm{font-size:12px;line-height:16px;color:var(--ink-3)}
.cov .vv{text-align:right}
.cov .vv .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums}
.ru{position:relative;height:56px}
.ru .track{position:absolute;left:0;right:0;top:24px;height:8px;background:var(--grey-100);box-shadow:inset 0 0 0 1px var(--line-2)}
.ru .zone{position:absolute;top:24px;height:8px;background:repeating-linear-gradient(135deg,var(--neg-wash) 0 4px,var(--neg) 4px 5px)}
.ru .lim{position:absolute;top:14px;height:28px;width:2px;margin-left:-1px;background:var(--neg)}
.ru .lim span{position:absolute;top:-14px;left:-40px;width:80px;text-align:center;font-size:12px;line-height:12px;color:var(--neg);font-weight:600;white-space:nowrap}
.ru .now{position:absolute;top:18px;width:12px;height:20px;margin-left:-6px;background:var(--midnight)}
.ru .fc{position:absolute;top:21px;width:10px;height:14px;margin-left:-5px;background:var(--white);box-shadow:inset 0 0 0 2px var(--electric)}
.ru .fc.bad{box-shadow:inset 0 0 0 2px var(--neg)}
.ru .lb{position:absolute;top:42px;font-size:12px;line-height:14px;color:var(--ink-3);white-space:nowrap;transform:translateX(-50%)}
.ru .lb.now-l{color:var(--ink);font-weight:600}
.lgd{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:12px;line-height:16px;color:var(--ink-2)}
.lgd span{display:inline-flex;align-items:center;gap:6px}
.lgd i{display:inline-block}
.reg{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);background:var(--white)}
.reg>div{padding:12px 16px;border-right:1px solid var(--line);min-width:0}
.reg>div:last-child{border-right:0}
.reg .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.reg .t-cap{display:block}
.two{display:grid;grid-template-columns:minmax(0,1fr) 352px;column-gap:32px}
.cert{background:var(--white);border:1px solid var(--line-2);padding:32px 40px;position:relative}
.cert::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:repeating-linear-gradient(135deg,var(--electric) 0 2px,transparent 2px 6px)}
.cert-h{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:16px;border-bottom:2px solid var(--electric)}
.cert-h .t-section{color:var(--ink)}
.sig{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:32px}
.sig div{border-top:1px solid var(--ink);padding-top:6px;font-size:12px;line-height:16px;color:var(--ink-2)}
.cal{list-style:none;border-top:2px solid var(--electric)}
.cal li{display:grid;grid-template-columns:88px minmax(0,1fr) 168px auto;gap:16px;align-items:center;padding:12px 12px;border-bottom:1px solid var(--line)}
.cal .dt{font:700 20px/24px var(--f-display);color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.cal .dt small{display:block;font:500 12px/16px var(--f-text);color:var(--ink-3);letter-spacing:.08em;text-transform:uppercase}
.cal .w b{display:block;font-weight:600}
.cal .w span{font-size:12px;line-height:16px;color:var(--ink-3)}
.cal li.is-next{background:var(--sky);box-shadow:inset 3px 0 0 var(--electric)}
.wgs{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:136px;gap:24px;margin-top:24px}
.lc-row{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line)}
.lc-row .d{font-weight:700;font-variant-numeric:tabular-nums}
/* lender portal — outside the app shell */
.portal{background:var(--warm);height:700px;display:flex;flex-direction:column}
.p-top{display:flex;align-items:center;gap:16px;height:64px;padding:0 40px;background:var(--white);border-bottom:1px solid var(--line)}
.p-top img{height:24px;width:auto}
.p-top .sp{flex:1}
.p-band{display:flex;align-items:center;gap:16px;height:40px;padding:0 40px;background:var(--canvas);border-bottom:1px solid var(--line);color:var(--ink-2);font-size:12px;line-height:16px;white-space:nowrap}
.p-band b{color:var(--ink);font-weight:600}
.p-body{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:40px;padding:32px 40px;flex:1;min-height:0}
.dl-list{list-style:none;border-top:2px solid var(--electric)}
.dl-list li{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.dl-list b{display:block;font-weight:600}
.dl-list span.s{font-size:12px;line-height:16px;color:var(--ink-3)}
.cs{list-style:none;margin-top:12px}
.cs li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;min-height:40px;border-bottom:1px solid var(--line)}
.cs2 li{grid-template-columns:minmax(0,1fr) auto;padding:8px 0}
.cov .fcl{grid-column:2/3;margin-top:-8px}
.cert .lay td{height:36px}
.cs .v{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
"""

TODAY = "Mon Oct 19"
LENDER = "Northwest Bank"
OFFICER = "Karen Voss"
TERM_BAL, LOC_LIMIT, LOC_DRAWN = 2640400.00, 1500000.00, 720000.00
VAN_BAL = 186214.40
FUNDED = TERM_BAL + LOC_DRAWN
TTM_EBITDA = 1240000
LEV = FUNDED / TTM_EBITDA
assert abs(round(LEV, 2) - 2.71) < .001, LEV
DS_TTM = 642700
DSCR = (TTM_EBITDA - 186000) / DS_TTM
assert abs(round(DSCR, 2) - 1.64) < .006, DSCR

COVS = [  # name, terms, actual, limit, kind(min/max), forecasts [(label, value)], fmt
    ("Debt service coverage", "Minimum 1.25× · trailing 12 months · quarterly", round(DSCR, 2), 1.25, "min", [("Dec 31", 1.58), ("Mar 31", 1.49), ("Jun 30", 1.52)], "x", (1.0, 2.0)),
    ("Senior funded debt to EBITDA", "Maximum 3.00× · trailing 12 months · quarterly", round(LEV, 2), 3.00, "max", [("Dec 31", 2.86), ("Mar 31", 2.94), ("Jun 30", 2.88)], "x", (2.0, 3.4)),
    ("Tangible net worth", "Minimum 2,500,000 · quarterly", 3412000, 2500000, "min", [("Dec 31", 3520000), ("Mar 31", 3488000), ("Jun 30", 3610000)], "$", (2000000, 4000000)),
    ("Capital expenditures", "Maximum 400,000 a fiscal year", 286000, 400000, "max", [("Dec 31", 372000)], "$", (0, 480000)),
]

# borrowing base certificate, as of Sep 30
AR_TOTAL = 2184300.00
AR_INEL = [("Over 90 days past invoice", 96420.00), ("Cross-aged · Polk County Schools, 50%+ over 90", 18200.00),
           ("Retainage held by customers", 42000.00), ("Contra · Johnstone Supply also a customer", 6880.00)]
AR_ELIG = round(AR_TOTAL - sum(v for _, v in AR_INEL), 2)
AR_ADV = round(AR_ELIG * 0.80, 2)
INV_TOTAL = 1204600.00
INV_INEL = [("No movement in 365 days", 88300.00), ("Committed to open jobs · in WIP", 140000.00)]
INV_ELIG = round(INV_TOTAL - sum(v for _, v in INV_INEL), 2)
INV_ADV = min(round(INV_ELIG * 0.50, 2), 500000.00)
BB = round(AR_ADV + INV_ADV, 2)
AVAIL = round(min(LOC_LIMIT, BB) - LOC_DRAWN, 2)
assert AR_ELIG == 2020800.00 and INV_ELIG == 976300.00 and AVAIL == 780000.00, (AR_ELIG, INV_ELIG, AVAIL)


def fmtv(v, f):
    return f"{v:.2f}×" if f == "x" else f0(v)


def ruler(actual, limit, kind, fc, f, rng):
    lo, hi = rng
    def x(v):
        return max(0, min(100, (v - lo) / (hi - lo) * 100))
    zone = f'<span class="zone" style="left:0;width:{x(limit):.2f}%"></span>' if kind == "min" else f'<span class="zone" style="left:{x(limit):.2f}%;right:0"></span>'
    out = f'<div class="ru" role="img" aria-label="{"Minimum" if kind == "min" else "Maximum"} {fmtv(limit, f)}, now {fmtv(actual, f)}, forecast {", ".join(l + " " + fmtv(v, f) for l, v in fc)}"><span class="track"></span>{zone}'
    out += f'<span class="lim" style="left:{x(limit):.2f}%"><span>{"min" if kind == "min" else "max"} {fmtv(limit, f)}</span></span>'
    worst = min(fc, key=lambda t: (t[1] - limit) if kind == "min" else (limit - t[1]))
    for l, v in fc:
        tight = (v - limit if kind == "min" else limit - v) < (0.10 if f == "x" else limit * 0.08)
        out += f'<span class="fc{" bad" if tight else ""}" style="left:{x(v):.2f}%"></span>'
    out += f'<span class="lb" style="left:{x(worst[1]):.2f}%">{worst[0]} · {fmtv(worst[1], f)}</span>'
    out += f'<span class="now" style="left:{x(actual):.2f}%"></span><span class="lb now-l" style="left:{x(actual):.2f}%;top:0">Sep 30</span></div>'
    return out


def h_rail(cur="Debt & covenants"):
    uses = {"Purchase orders", "Payroll", "Inventory", "Debt & covenants", "Revenue recognition", "Jobs", "WIP", "Intercompany"}
    return rail(client_nav(uses, cur, {"Inbox": 2, "Debt & covenants": 1}), "Nora Lindqvist", "CFO")


def d_tabs(sel):
    out = '<div class="tabs dtabs" role="tablist" aria-label="Debt and covenants">'
    for t, c in [("Register", "3"), ("Covenants", "4"), ("Borrowing base", "1"), ("Lender reporting", "2")]:
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}<span class="n">{c}</span></button>'
    return out + "</div>"


def head_block(sel, right=""):
    return (f'<div class="page-head" style="margin-bottom:0"><div><div class="eyebrow">Cash &amp; debt<span class="sl">//</span>Debt &amp; covenants</div>'
            f'<h1 class="t-title" style="margin-top:4px">Heartland’s debt with {LENDER}</h1></div><div class="btn-row">{right}</div></div>{d_tabs(sel)}')


# --------------------------------------------------------------- frame 1: covenants (with register strip)
def cov_frame():
    reg = f"""<div class="reg" style="margin-top:24px"><div><span class="eyebrow">Term loan · ••0418</span><span class="v">{f2(TERM_BAL)}</span><span class="t-cap">6.85% fixed · matures Jun 2029 · 49,820.14 monthly</span></div>
<div><span class="eyebrow">Line of credit · ••0419</span><span class="v">{f2(LOC_DRAWN)}</span><span class="t-cap">of {f0(LOC_LIMIT)} · Prime + 0.75% · renews Jun 30</span></div>
<div><span class="eyebrow">Available to draw</span><span class="v">{f2(AVAIL)}</span><span class="t-cap">borrowing base {f0(BB)} · certificate due Tue</span></div>
<div><span class="eyebrow">Funded debt · covenant basis</span><span class="v">{f2(FUNDED)}</span><span class="t-cap">van notes {f0(VAN_BAL)} excluded by the agreement</span></div></div>"""
    covs = ""
    for nm, tm, act, lim, kind, fc, f, rng in COVS:
        head = (act - lim) if kind == "min" else (lim - act)
        hv = f"{head:.2f}×" if f == "x" else f0(head)
        tight = min((v - lim) if kind == "min" else (lim - v) for _, v in fc)
        st = status("ready", "Inside") if tight > (0.10 if f == "x" else lim * 0.08) else status("risk", "Tight by Mar 31" if nm.startswith("Senior") else "Tight")
        covs += (f'<div class="cov"><div><span class="nm">{nm}</span><span class="tm" style="display:block">{tm}</span></div>{ruler(act, lim, kind, fc, f, rng)}'
                 f'<div class="vv"><span class="v">{fmtv(act, f)}</span><span class="t-cap">headroom {hv}</span><div style="margin-top:4px">{st}</div></div></div>')
        covs = covs[:-6] + f'<span class="tm fcl">Forecast {" · ".join(l + " " + fmtv(v, f) for l, v in fc)}</span></div>'
    lg = ('<div class="lgd"><span><i style="width:12px;height:16px;background:var(--midnight)"></i>Sep 30, preliminary</span>'
          '<span><i style="width:10px;height:14px;box-shadow:inset 0 0 0 2px var(--electric)"></i>Forecast · reforecast v3</span>'
          '<span><i style="width:10px;height:14px;box-shadow:inset 0 0 0 2px var(--neg)"></i>Forecast within 0.10× or 8%</span>'
          '<span><i style="width:24px;height:8px;background:repeating-linear-gradient(135deg,var(--neg-wash) 0 4px,var(--neg) 4px 5px)"></i>Breach</span></div>')
    note = f"""<aside class="notes" aria-label="Notes"><div class="notes-head"><span class="eyebrow">Notes</span><span class="t-cap">computed from the ledger</span></div>
<article class="note"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Leverage</div><div class="note-title">Tight by Mar 31, at 2.94× against 3.00×</div></div></div>
<p>Trailing EBITDA falls as last winter’s strong quarter rolls off. The Carrier scenario in S23 takes it to 3.08×, a breach.</p>
<ul class="ev"><li>Funded debt, Sep 30<span class="dl"></span><span class="v">{f0(FUNDED)}</span></li><li>Trailing 12-month EBITDA<span class="dl"></span><span class="v">{f0(TTM_EBITDA)}</span></li><li class="ev-total">Leverage<span class="dl"></span><span class="v">{LEV:.2f}×</span></li></ul>
<div class="basis"><span>Definitions from the loan agreement §6.2</span><span>Parsed Jun 2022, confirmed by Erin Vance</span></div>
<div class="note-acts"><button class="btn btn--quiet" type="button">Paying 120,000 on the line keeps Mar 31 at 2.84×</button></div></article>
<article class="note"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">Preliminary</div><div class="note-title">September isn’t closed</div></div></div>
<p>Heartland’s September closed Oct 14, but the controller hasn’t hard-closed it. The certificate uses these figures only after hard close.</p></article></aside>"""
    page = (f'<div class="page">{head_block("Covenants", btn("Upload amendment", "", "", "upload") + btn("Prepare certificate", "primary"))}{reg}'
            f'<div class="two" style="margin-top:32px"><div><span class="t-head">Four tests · Q3, certificate due Nov 15</span><div style="margin:8px 0 12px">{lg}</div>{covs}</div>{note}</div></div>')
    main = ctxline([TODAY, "Heartland Heating &amp; Cooling", "Q3 test · Sep 30", "<b>Inside all 4 · leverage tight by Mar 31</b>"]) + page
    return app("client", "density-report", h_rail(), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Debt &amp; covenants / <b>Covenants</b>", cmd="Jump to loan, covenant, report…"), main, 1140, live=True)


# --------------------------------------------------------------- frame 2: borrowing base certificate
def bbc_frame():
    def L(lbl, v, cls=""):
        return f'<tr class="{cls}"><td>{lbl}</td><td class="n">{f2(v)}{HP if v >= 0 else ""}</td></tr>'
    rows = '<tr><td colspan="2" style="height:auto;padding-top:8px" class="eyebrow">Accounts receivable · aging Sep 30</td></tr>'
    rows += L("Total receivables", AR_TOTAL)
    for l, v in AR_INEL:
        rows += L("Less " + l.lower()[0] + l[1:], -v, "less")
    rows += L("Eligible receivables", AR_ELIG, "sub")
    rows += L("× 80% advance rate", AR_ADV)
    rows += '<tr><td colspan="2" style="height:auto;padding-top:20px" class="eyebrow">Inventory · perpetual, Sep 30</td></tr>'
    rows += L("Total inventory", INV_TOTAL)
    for l, v in INV_INEL:
        rows += L("Less " + l.lower()[0] + l[1:], -v, "less")
    rows += L("Eligible inventory", INV_ELIG, "sub")
    rows += L("× 50% advance rate, capped at 500,000", INV_ADV)
    rows += f'<tr class="sub"><td>Borrowing base</td><td class="n">{f2(BB)}</td></tr>'
    rows += L("Line limit", LOC_LIMIT)
    rows += L("Lesser of limit and borrowing base", min(LOC_LIMIT, BB))
    rows += L("Less outstanding on the line", -LOC_DRAWN, "less")
    rows += f'<tr class="tot"><td>Available to draw</td><td class="n">{f2(AVAIL)}</td></tr>'
    table = f'<table class="lay" aria-label="Borrowing base certificate"><colgroup><col><col style="width:160px"></colgroup><tbody>{rows}</tbody></table>'
    cert = f"""<div class="cert"><div class="cert-h"><div><div class="eyebrow">Borrowing base certificate<span class="sl">//</span>No. 2026-09</div>
<h2 class="t-section" style="margin-top:4px">Heartland Heating &amp; Cooling, LLC</h2><p class="t-cap" style="margin-top:4px">To {LENDER} · Revolving line ••0419 · as of Sep 30, 2026</p></div>
<div style="text-align:right">{status("track", "Draft")}<p class="t-cap" style="margin-top:4px">Due Tue Oct 20</p></div></div>{table}
<div class="sig"><div>Nora Lindqvist, CFO · certifies the above is true and complete</div><div>Received by {LENDER}</div></div></div>"""
    side = f"""<div><article class="note note--panel"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">What changed from August</div><div class="note-title">Availability up 64,210</div></div></div>
<ul class="ev"><li>Eligible receivables, +146,800 × 80%<span class="dl"></span><span class="v">117,440</span></li><li>Eligible inventory, −46,460 × 50%<span class="dl"></span><span class="v">(23,230)</span></li>
<li>Line drawn 30,000 more<span class="dl"></span><span class="v">(30,000)</span></li><li class="ev-total">Change in availability<span class="dl"></span><span class="v">64,210</span></li></ul>
<div class="basis"><span>From the AR aging and inventory ledgers</span><span>Rules from the loan agreement §2.4</span></div></article>
<div class="panel-sec"><div class="panel-sec-h"><h3>Attached when sent</h3></div><ul class="ev"><li>AR aging, Sep 30<span class="dl"></span><span class="v">PDF · 214 customers</span></li><li>AP aging, Sep 30<span class="dl"></span><span class="v">PDF</span></li><li>Inventory by location<span class="dl"></span><span class="v">XLSX</span></li></ul></div>
<div class="inline-notice inline-notice--warn" style="margin-top:16px">{ico("alert")}<span><b>One check before sending.</b> Polk County Schools is cross-aged this month. Confirm with Karen Voss that the 18,200 exclusion matches the bank’s reading.</span></div>
<div class="btn-row" style="margin-top:16px">{btn("Approve &amp; send to Northwest", "primary", "", "send", 'data-say="Sent to Northwest Bank"')}{btn("Download PDF", "", "", "download")}</div>
<p class="t-cap" style="margin-top:8px">Sending needs step-up sign-in. Karen sees it in the lender portal, and the delivery is logged.</p></div>"""
    assert abs(117440 - 23230 - 30000 - 64210) < .001
    page = f'<div class="page">{head_block("Borrowing base", btn("History", "", "", "history"))}<div class="two" style="margin-top:24px">{cert}{side}</div></div>'
    main = ctxline([TODAY, "Heartland Heating &amp; Cooling", "Borrowing base · Sep 30", "<b>Due tomorrow</b>"]) + page
    return app("client", "density-report", h_rail(), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Debt &amp; covenants / <b>Borrowing base</b>", cmd="Jump to loan, covenant, report…"), main, 1180)


# --------------------------------------------------------------- frame 3: lender reporting
def lr_frame():
    items = [("Oct 20", "Tue", "Borrowing base certificate · September", "Monthly by the 20th · with AR and AP agings", "Drafted Oct 19 · waiting on you", "next", btn("Review &amp; send", "primary")),
             ("Nov 15", "Sun", "Compliance certificate · Q3", "45 days after quarter end · 4 tests + internal statements", "Drafts Nov 2 after September hard-closes", "", btn("Preview")),
             ("Nov 20", "Fri", "Borrowing base certificate · October", "Monthly by the 20th", "Drafts Nov 12", "", ""),
             ("Dec 31", "Thu", "FY 2027 budget and projections", "Annual · from Budgets, FY 2027 cycle", "Heartland: 3 of 4 departments in", "", btn("Open cycle")),
             ("Apr 30", "Fri", "Reviewed financial statements · FY 2026", "120 days after year end · by the CPA firm", "Engagement letter on file", "", "")]
    cal = '<ol class="cal" aria-label="Due to Northwest Bank">'
    for d, wd, t, rule, st, cls, b in items:
        cal += f'<li class="{"is-next" if cls else ""}"><span class="dt">{d}<small>{wd}</small></span><span class="w"><b>{t}</b><span>{rule}</span></span><span class="t-cap">{st}</span><span>{b}</span></li>'
    cal += "</ol>"
    hist = [("Sep 18", "Borrowing base · August", "Sent by Nora Lindqvist", "Opened by Karen Voss Sep 18"), ("Aug 12", "Compliance certificate · Q2", "Sent by Nora Lindqvist", "Opened Aug 13"),
            ("Aug 19", "Borrowing base · July", "Sent by Nora Lindqvist", "Opened Aug 19")]
    hl = '<ul class="cs cs2" aria-label="Delivered">' + "".join(f'<li><span><b class="b">{t}</b><span class="t-cap" style="display:block">{d} · {o}</span></span>{status("ready", "On time")}</li>' for d, t, s, o in hist) + "</ul>"
    side = f"""<div><div class="row row--between"><span class="t-head">Who sees it at Northwest</span></div>
<div class="inline-notice" style="margin-top:8px">{ico("user")}<span><b>Karen Voss · VP, commercial lending.</b> Lender viewer, access until Sep 30, 2027. She sees what has been delivered to her, nothing live.</span></div>
<div class="row row--between" style="margin-top:24px"><span class="t-head">Delivered</span><span class="t-cap">every view is logged</span></div>{hl}
<button class="btn btn--quiet" type="button" style="margin-top:8px">{ico("eye")}Preview Karen’s portal</button></div>"""
    page = (f'<div class="page">{head_block("Lender reporting", btn("Add obligation", "", "", "plus"))}<div class="two" style="margin-top:24px">'
            f'<div><div class="row row--between" style="margin-bottom:12px"><span class="t-head">Due to {LENDER}</span><span class="t-cap">From the loan agreement · drafts are prepared ahead, never sent without approval</span></div>{cal}</div>{side}</div></div>')
    main = ctxline([TODAY, "Heartland Heating &amp; Cooling", "Lender reporting", "<b>1 due tomorrow</b>"]) + page
    return app("client", "density-report", h_rail(), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Debt &amp; covenants / <b>Lender reporting</b>", cmd="Jump to loan, covenant, report…"), main, 840)


# --------------------------------------------------------------- frame 4: lender portal (external)
def portal_frame():
    dl = [("Borrowing base certificate · August", "Delivered Sep 18 · with AR and AP agings", "Sep 18"), ("Compliance certificate · Q2 2026", "Delivered Aug 12 · 4 tests, internal statements", "Aug 12"),
          ("Borrowing base certificate · July", "Delivered Aug 19", "Aug 19"), ("Reviewed financial statements · FY 2025", "Delivered Apr 22 · Denman & Company", "Apr 22")]
    lst = '<ul class="dl-list" aria-label="Delivered to you">' + "".join(f'<li><span><b>{t}</b><span class="s">{s}</span></span><span class="t-cap">{d}</span>{btn("Open", "", "", "download")}</li>' for t, s, d in dl) + "</ul>"
    cs = [("Debt service coverage", "1.71×", "min 1.25×"), ("Senior funded debt to EBITDA", "2.62×", "max 3.00×"), ("Tangible net worth", "3,286,000", "min 2,500,000"), ("Capital expenditures, YTD", "198,000", "max 400,000")]
    csl = '<ul class="cs" aria-label="Covenant status from the last certificate">' + "".join(f'<li><span>{n}</span><span class="v">{v}</span><span>{status("ready", "Passed")}</span></li>' for n, v, _ in cs) + "</ul>"
    due = [("Tue Oct 20", "Borrowing base · September"), ("Sun Nov 15", "Compliance certificate · Q3"), ("Fri Nov 20", "Borrowing base · October")]
    dul = '<ul class="cs" aria-label="Due from Heartland">' + "".join(f'<li><span>{t}</span><span class="t-cap">{d}</span><span></span></li>' for d, t in due) + "</ul>"
    body = f"""<div class="portal"><div class="p-top"><img src="assets/merit-logo-on-light.png" alt="Merit" width="80" height="24"><span class="eyebrow">Lender portal</span><span class="sp"></span>
<span class="t-cap">Karen Voss · Northwest Bank</span><button class="btn btn--quiet" type="button">Sign out</button></div>
<div class="p-band"><b>Heartland Heating &amp; Cooling, LLC</b><span class="sl">//</span><span>Term loan ••0418 · Line ••0419</span><span class="sl">//</span><span>Read-only · you see what Heartland delivered, nothing live</span><span class="sp" style="flex:1"></span><span>Access until Sep 30, 2027</span></div>
<div class="p-body"><div><h1 class="t-title">Delivered to you</h1><p class="ink-2" style="margin:4px 0 16px">Newest first. Each document is the version Heartland approved and sent.</p>{lst}</div>
<div><div class="t-head">Covenant status</div><p class="t-cap">As of the Q2 certificate, delivered Aug 12. Q3 is due Nov 15.</p>{csl}
<div class="t-head" style="margin-top:32px">Due from Heartland</div>{dul}
<p class="t-cap" style="margin-top:24px">Questions go to Nora Lindqvist, CFO. Every page you open is logged and visible to Heartland.</p></div></div></div>"""
    return body


def widgets():
    rows = [("Oct 20", "Heartland · Northwest", "Borrowing base · Sep", "Approve &amp; send", "primary"), ("Oct 30", "AIM · Lincoln Savings", "Q3 financials", "Prepare", ""),
            ("Nov 15", "Heartland · Northwest", "Compliance cert · Q3", "Preview", ""), ("Nov 30", "Dorrian · Bank of Iowa", "Compliance cert · below 1.25×", "Draft lender note", "danger")]
    b = "".join(f'<div class="lc-row"><span class="d">{d}</span><span><span class="l1">{t}</span><span class="l2">{w}</span></span><button class="btn{(" btn--" + k) if k else ""}" type="button">{a}</button></div>' for d, w, t, a, k in rows)
    w1 = wg("debt.lender_calendar", "Lender calendar", b, 1, 1, 6, 2, count="4", meta="next 45 days · 5 lenders", foot='<span>Drafts are prepared 10 days ahead</span>', label_id="w-lc")
    d1 = f'<div class="wg-state"><span class="wg-done-mark">{ico("check")}</span><p class="t-head">Everything due to lenders is sent.</p><p>Next: Northwest compliance certificate, Nov 15. Drafts Nov 2.</p></div>'
    w2 = wg("debt.lender_calendar", "Lender calendar", d1, 7, 1, 3, 2, meta="Done", label_id="w-lcd")
    e1 = f'<div class="wg-state"><span class="wg-empty-mark">{ico("doc")}</span><p class="t-head">Nothing delivered yet.</p><p>Wild Rose’s lender portal opens when the first document is sent.</p></div>'
    w3 = wg("lv.deliverables", "Deliverables", e1, 10, 1, 3, 2, meta="Lender portal · empty", label_id="w-lve")
    return f'<div class="wgs density-cockpit">{w1}{w2}{w3}</div>'


def build():
    html = head("S24 · Debt, covenants and lender reporting", CSS) + sheet_top("S24-debt-lender.html") + '<main id="main" class="sheet">'
    html += board_h("S24", "IA-SPEC §3.6.1 Debt &amp; covenants · §4.6 · §4.15 · §3.6.6 · §6.2 lender reporting",
                    "Heartland and Northwest Bank: how close to every limit, and what’s owed to the lender when",
                    "One page per client with four tabs: Register, Covenants, Borrowing base, Lender reporting. Covenants are measured from the ledger and projected from the reforecast, "
                    "so a tight quarter shows before it arrives. Certificates are drafted ahead and sent only on approval; the lender sees what was delivered and nothing else.")
    html += pair_h("1 · Covenants", "Heartland · Debt &amp; covenants · Covenants, with the register above. Each ruler shows the limit, Sep 30 and the next tests.")
    html += frame(cov_frame(), "Open state · report density · the headroom ruler is this board’s signature", f"Ties: funded debt {f0(FUNDED)} ÷ EBITDA {f0(TTM_EBITDA)} = {LEV:.2f}× · DSCR base Dec 31 1.58× = S23")
    html += anno([("Distance, not a pass mark", "A green tick hides how close you are. The ruler puts the limit, today and the next three quarters on one line; the hatched end is breach."),
                  ("Forecast from the plan", "Forecast marks come from reforecast v3 in S23, so changing a driver moves the covenant. The Carrier scenario is named where it would breach."),
                  ("Definitions are the bank’s", "Each test is computed the way the agreement defines it, parsed from the loan documents and confirmed by the controller. Van notes are excluded because §6.2 says so."),
                  ("Preliminary says so", "Until September hard-closes, the figures are marked preliminary and the certificate won’t use them.")])
    html += pair_h("2 · Borrowing base", "The September certificate, drafted from the AR aging and inventory ledgers, waiting for Nora’s approval.")
    html += frame(bbc_frame(), "Borrowing base tab · the certificate is the document the bank receives", f"Ties: {f0(AR_ADV)} + {f0(INV_ADV)} = {f0(BB)}; limit {f0(LOC_LIMIT)} − drawn {f0(LOC_DRAWN)} = {f0(AVAIL)}")
    html += pair_h("3 · Lender reporting", "Everything owed to Northwest, from the loan agreement, with what’s been delivered and opened.")
    html += frame(lr_frame(), "Lender reporting tab · M-14 obligations · drafts prepared ahead", "Nov 15 matches the IA’s example “Next: Northwest compliance cert, Nov 15”")
    html += pair_h("4 · Karen’s view", "The lender portal, outside the app shell. Read-only, time-boxed, delivered items only (IA §4.15).")
    html += f'<div class="frame">{portal_frame()}</div><div class="frame-cap"><span>Lender portal · /portal/lender · lv.deliverables, lv.calendar, lv.covenant_status</span><span>Covenant status is from the Q2 certificate, not today’s ledger</span></div>'
    html += anno([("Nothing live", "The portal shows the last delivered certificate’s figures, labelled with its date. Today’s 2.71× isn’t visible to the bank until Nora sends Q3."),
                  ("Delivery is the event", "Approve &amp; send is the release: step-up sign-in, a logged delivery, and the item appears in Karen’s list."),
                  ("The tenant sees the views", "Every page Karen opens is logged and shown on the Delivered list as “Opened by”."),
                  ("Across lenders", "debt.lender_calendar on the CFO home lists every client’s lender dates; Dorrian’s below-minimum test offers a lender note, not a certificate.")])
    html += widgets()
    html += foot()
    return html


if __name__ == "__main__":
    open("../S24-debt-lender.html", "w").write(build())
    print("ok", BB, AVAIL, LEV, DSCR)
