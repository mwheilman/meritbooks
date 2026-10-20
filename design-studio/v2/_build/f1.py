"""F1 — Budget builder: department budgets with owners, stages, templates and upload (FPB-reports-fpna §4)."""
from rf_common import *
from rf_data import CYCLE, CY_REV_T, CY_REV_P, CY_OH_T, CY_OH_P, INSTALL_TPL, UPLOAD_ROWS, UP_REV, UP_COST

CSS = """
.f1-figs .fig-vs b{font-weight:600;color:var(--ink)}
.cyc .lay td{height:56px}
.cyc .lay .l1,.cyc .lay .l2{white-space:normal}
.cyc .stg-c .t-cap{display:block;margin-top:2px}
.track{position:relative;height:104px;margin-top:8px}
.track .ax{position:absolute;left:0;right:0;top:28px;height:2px;background:var(--line-2)}
.track .done{position:absolute;left:0;top:28px;height:2px;background:var(--electric)}
.track .ms{position:absolute;top:0;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:4px;width:120px;text-align:center}
.track .ms.lo b{margin-top:32px}
.track .ms i{display:block;width:4px;height:14px;margin-top:21px;background:var(--grey-400);transform:skewX(-45deg)}
.track .ms.on i{background:var(--electric)}
.track .ms .t-cap{line-height:16px}
.track .ms b{font-weight:600;font-size:12px;line-height:16px}
.track .ms.first{align-items:flex-start;transform:translateX(-2px);text-align:left}
.track .ms.last{align-items:flex-end;transform:translateX(calc(-100% + 2px));text-align:right}
.track .today{position:absolute;top:18px;width:2px;height:22px;background:var(--midnight);transform:translateX(-50%)}
.track .today span{position:absolute;top:-18px;left:50%;transform:translateX(-50%);white-space:nowrap;font:600 12px/16px var(--f-text)}
.tpl-l li{list-style:none;display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.tpl-l .l1,.tpl-l .l2{white-space:normal}
.ihm{display:inline-grid;place-items:center;width:16px;height:16px;margin-top:2px;font-size:11px;font-weight:700;line-height:1}
.ihm.f{box-shadow:inset 0 0 0 1.5px var(--steel);color:var(--steel)}
.ihm.o{background:var(--electric);color:var(--white)}
.ihm.c{background:repeating-linear-gradient(135deg,var(--electric) 0 2px,var(--white) 2px 4px);box-shadow:inset 0 0 0 1.5px var(--electric)}
.panel .kv{margin-top:4px}
.f1-panel{position:sticky;top:0;border:1px solid var(--line-2)}
.app--frame .main{position:relative}
.dialog--wide{width:760px}
.steps{display:flex;gap:16px;margin-top:12px;font-size:12px;line-height:16px;color:var(--ink-3)}
.steps span{display:inline-flex;align-items:center;gap:6px}
.steps span.on{color:var(--ink-2)}
.steps span.cur{color:var(--ink);font-weight:600}
.file{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--canvas);box-shadow:inset 3px 0 var(--steel)}
.file .l1,.file .l2{white-space:normal}
.tie{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}
.tie>div{padding:12px 16px;border:1px solid var(--line)}
.up td{height:44px}
.up tr.attn td:first-child{box-shadow:inset 3px 0 var(--neg);padding-left:12px}
.up .select{height:32px}
.tgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.tcard{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--white);border:1px solid var(--line);min-width:0}
.tcard.is-sel{border-color:var(--electric);box-shadow:inset 0 0 0 1px var(--electric)}
.tcard .l1,.tcard .l2{white-space:normal}
.tcard .chips{display:flex;flex-wrap:wrap;gap:4px}
.tcard .ft{display:flex;flex-direction:column;align-items:flex-start;gap:0;border-top:1px solid var(--line);padding-top:8px;margin-top:auto}
.tcard .ft .btn{margin-left:-12px}
.tnav li{list-style:none}
.tnav a{display:flex;justify-content:space-between;align-items:center;min-height:32px;padding:0 8px;color:var(--ink-2);font-weight:500}
.tnav a[aria-current=page]{background:var(--sky);color:var(--ink);box-shadow:inset 3px 0 var(--electric)}
.tnav .eyebrow{display:block;padding:16px 8px 4px}
.tl3{display:grid;grid-template-columns:200px minmax(0,1fr) 368px;column-gap:24px;align-items:start}
"""

TABS = ["Plan", "Drivers", "Reforecast", "Cycle", "Budget vs actual", "Templates", "Headcount", "Capex"]


def b_tabs(sel):
    return '<div class="tabs" role="tablist" aria-label="Budgets">' + "".join(
        f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}</button>' for t in TABS) + "</div>"


def head_(primary):
    return (f'<div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Planning &amp; reports<span class="sl">//</span>Budgets</div>'
            f'<h1 class="t-title" style="margin-top:4px">FY 2027 budget</h1></div>'
            f'<div class="btn-row">{btn("Upload budget", "", "", "upload")}{btn("Templates", "", "", "copy")}{primary}</div></div>')


def figs():
    def fig(l, v, vs, link):
        return f'<div class="fig"><span class="fig-l">{l}</span><span class="fig-v tnum">{v}</span><span class="fig-vs">{vs}</span><a class="link" href="#" style="min-height:32px;display:inline-flex;align-items:center">{link}</a></div>'
    return ('<div class="figs f1-figs">'
            + fig("Revenue plan so far", f0(CY_REV_P), f'<span>target <b>{f0(CY_REV_T)}</b></span><span>Install 4 months to go</span>', "Plan by month")
            + fig("Departments in", "3 of 4", '<span>1 approved · 2 in review</span>', "Who’s waiting")
            + fig("Overhead plan", f0(CY_OH_P), f'<span>cap <b>{f0(CY_OH_T)}</b></span><span class="neg">{f0(CY_OH_T - CY_OH_P)}</span>', "Overhead lines")
            + fig("Submissions due", "Fri Nov 6", '<span>18 days · CFO approval Nov 13</span>', "Cycle calendar")
            + "</div>")


def track():
    ms = [("Oct 1", "Targets sent", 0, True, "first"), ("Oct 23", "Controller review", 31.0, False, ""), ("Nov 6", "Submissions due", 50.7, False, ""),
          ("Nov 13", "CFO approval", 60.6, False, "lo"), ("Dec 11", "Budget approved · locked", 100, False, "last")]
    out = '<div class="track" role="img" aria-label="Cycle calendar: targets sent Oct 1, controller review Oct 23, submissions due Nov 6, CFO approval Nov 13, budget locked Dec 11. Today is Oct 19.">'
    out += '<span class="ax"></span><span class="done" style="width:25.4%"></span><span class="today" style="left:25.4%"><span>Today · Oct 19</span></span>'
    for d, t, x, on, k in ms:
        out += f'<span class="ms{" on" if on else ""} {k}" style="left:{x}%"><i></i><b>{d}</b><span class="t-cap">{t}</span></span>'
    return out + "</div>"


def cycle_table():
    rows = ""
    for grp, kind in [("Revenue departments · revenue and gross margin", "rev"), ("Overhead departments · spend", "oh")]:
        rows += f'<tr class="grp"><td colspan="6">{grp}</td></tr>'
        for c in [x for x in CYCLE if x["kind"] == kind]:
            sel = " is-sel" if c["k"] == "install" else ""
            if c["stage"] is None:
                st = stage(0, finance=True)
            elif c["stage"] == 4:
                st = stage(0, done_all=True)
            else:
                st = stage(c["stage"])
            if kind == "rev":
                if c["k"] == "install":
                    var = '<span class="t-cap">8 of 12 months</span>'
                else:
                    var = dl(c["plan"] - c["target"])
                plan = f'<span class="l1 tnum" style="text-align:right">{nn(c["plan"])}</span><span class="l2" style="text-align:right">GM {c["gm"]:.1f}%</span>'
            else:
                var = dl(c["target"] - c["plan"])
                plan = f'<span class="l1 tnum" style="text-align:right">{nn(c["plan"])}</span>'
            tgt = (f'<span class="l1 tnum" style="text-align:right">{nn(c["target"])}</span><span class="l2" style="text-align:right">GM {c["gm_t"]:.1f}%</span>' if kind == "rev" else nn(c["target"]))
            act = {"service": btn("View", "quiet"), "install": btn("Remind", "quiet"), "maint": btn("View", "quiet"),
                   "sm": btn("Review"), "admin": btn("Edit", "quiet"), "exec": btn("Edit", "quiet")}[c["k"]]
            rows += (f'<tr class="ln{sel}" tabindex="0" data-drill="{E(c["name"])} budget"><td><span class="l1">{E(c["name"])}</span>'
                     f'<span class="l2">{E(c["owner"])} · {E(c["tpl"])}</span></td>'
                     f'<td class="l stg-c">{st}<span class="t-cap">{E(c["when"])}</span></td><td class="n">{tgt}</td><td class="n">{plan}</td><td class="n">{var}</td><td class="n">{act}</td></tr>')
        if kind == "rev":
            rows += (f'<tr class="sub"><td>Revenue departments</td><td class="l"><span class="t-cap">3 of 3 owners working</span></td><td class="n">{nn(CY_REV_T)}</td><td class="n">{nn(CY_REV_P)}</td>'
                     f'<td class="n"><span class="t-cap">Install open</span></td><td></td></tr>')
        else:
            rows += (f'<tr class="sub"><td>Overhead departments</td><td></td><td class="n">{nn(CY_OH_T)}</td><td class="n">{nn(CY_OH_P)}</td><td class="n">{dl(CY_OH_T - CY_OH_P)}</td><td></td></tr>')
    return (f'<table class="lay" aria-label="FY 2027 department budgets: owner, stage, target and plan"><colgroup><col><col style="width:168px"><col style="width:104px"><col style="width:104px"><col style="width:88px"><col style="width:80px"></colgroup>'
            f'<thead><tr><th>Department · owner</th><th class="l">Stage</th><th>Target</th><th>Plan</th><th>vs target</th><th></th></tr></thead><tbody>{rows}</tbody></table>')


def panel():
    lines = ""
    marks = {"Equipment": "o", "Trucks & fuel": "c"}
    for g, items in INSTALL_TPL:
        lines += f'<li style="grid-template-columns:1fr;border-bottom:1px solid var(--line-2);padding-top:16px"><span class="eyebrow">{g}</span></li>'
        for n_, f_, s_ in items:
            m = marks.get(n_, "f")
            lab = {"f": "Follows the Merit HVAC set", "o": "Overridden for Heartland", "c": "Heartland only"}[m]
            sym = {"f": "↳", "o": "", "c": ""}[m]
            lines += (f'<li><span class="ihm {m}" role="img" aria-label="{lab}" title="{lab}">{sym}</span><span><span class="l1">{E(n_)}</span>'
                      f'<span class="l2">{E(f_)} · {E(s_)}</span></span></li>')
    return f"""<aside class="panel f1-panel" aria-label="Install department budget">
<div class="panel-head"><div class="eyebrow">Department budget<span class="sl">//</span>Install</div>
<div class="t-head" style="margin-top:4px">Brent Kolb is drafting · 8 of 12 months</div>
<p class="t-cap" style="margin-top:4px">Template HVAC · Install, from the Merit HVAC set v2. Due Fri Nov 6.</p></div>
<div class="panel-body">
<div class="panel-sec"><div class="panel-sec-h"><h3>Target from Nora · Oct 1</h3></div>
<dl class="kv"><dt>Revenue</dt><dd>9,600,000</dd><dt>Equipment, % of install</dt><dd>46.0%</dd><dt>Gross margin</dt><dd>12.0%</dd></dl></div>
<div class="panel-sec"><article class="note note--panel"><div class="note-kind">Check before submitting</div>
<div class="note-title">Equipment at 46.0% is below the last six months</div>
<p>At the trailing rate the plan’s install margin is 12.0%, on target. At 46.0% it overstates gross profit.</p>
<ul class="ev"><li>Brent’s draft · equipment<span class="dl"></span><span class="v">46.0%</span></li><li>Trailing 6 months · GL 5100 ÷ 4100<span class="dl"></span><span class="v">49.1%</span></li>
<li class="ev-total">Overstated gross profit, FY 2027<span class="dl"></span><span class="v">297,972</span></li></ul>
<div class="basis"><span>Basis: <b>template formula + posted actuals</b></span><span>AI proposes; Brent decides</span></div>
<div class="note-acts">{btn("Suggest 49.1% to Brent", "quiet", "", "send")}</div></article></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Template lines · drivers</h3><span class="t-cap">11 lines</span></div>
<ul class="tpl-l">{lines}</ul>
<p class="t-cap" style="margin-top:8px"><span class="ihm f" aria-hidden="true">↳</span> follows the firm’s set · <span class="ihm o" aria-hidden="true"></span> overridden · <span class="ihm c" aria-hidden="true"></span> this client only</p></div>
</div>
<div class="panel-foot">{btn("Remind Brent", "", "", "bell")}<span class="sp"></span>{btn("Open Install budget", "primary")}</div></aside>"""


def frame_cycle():
    left = (f'{figs()}<div class="sec-h"><span class="t-head">Cycle calendar</span><span class="t-cap">Blended: targets down Oct 1, plans up by Nov 6</span></div>{track()}'
            f'<div class="sec-h"><span class="t-head">Department budgets</span><div class="lgd"><span>'
            f'<span class="meter" aria-hidden="true"><i class="on"></i><i class="cur"></i><i></i><i></i></span>Draft · Submitted · Controller · CFO</span></div></div>'
            f'<div class="cyc">{cycle_table()}</div>'
            f'<p class="t-cap" style="margin-top:12px">Revenue “vs target” is plan less target; overhead “vs target” is cap less plan, so positive is favourable in both. Admin and Executive are finance-owned: Erin drafts them, no submission.</p>')
    page = (f'<div class="page">{head_(btn("Review Sales &amp; marketing", "primary"))}{b_tabs("Cycle")}'
            f'<div style="display:grid;grid-template-columns:minmax(0,1fr) 368px;column-gap:24px;align-items:start;margin-top:24px"><div>{left}</div>{panel()}</div></div>')
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "FY 2027 budget", "<b>3 of 4 departments in · due Fri Nov 6</b>"])
    return app("client", "density-report", h_rail("Budgets"), h_bar("Budgets / <b>Cycle</b>"), main + page, 1800, live=True)


def frame_upload():
    trs = ""
    for lbl, acct, conf, amt in UPLOAD_ROWS:
        lo = conf < 70
        cm = meter(round(conf / 10), 0, 10, label=f"Confidence {conf}")
        cls = ' class="attn"' if acct is None else ""
        if acct is None:
            sug = "5400 · Subcontract" if "Duct" in lbl else "5250 · Permits &amp; disposal"
            m = f'<select class="select" aria-label="Account for {E(lbl)}"><option>Choose an account</option><option>Suggested: {sug}</option></select>'
        else:
            m = f'<span class="l1">{E(acct)}</span><span class="l2">{"Remembered from Oct 2 upload" if conf >= 95 else "Matched by name"}</span>'
        trs += (f'<tr{cls}><td><span class="l1">{E(lbl)}</span></td><td class="l">{m}</td>'
                f'<td class="l"><span class="conf{" conf--lo" if lo else ""}">{cm}<b>{conf}</b></span></td><td class="n">{nn(amt)}</td></tr>')
    table = (f'<table class="lay up" aria-label="Map rows to accounts"><colgroup><col style="width:160px"><col><col style="width:132px"><col style="width:104px"></colgroup>'
             f'<thead><tr><th>Row in the file</th><th class="l">Account</th><th class="l">Match</th><th>FY 2027</th></tr></thead><tbody>{trs}</tbody></table>')
    steps = "".join(f'<span class="{c}">{meter(1 if c != "" else 0, 0, 1, label=s)}{s}</span>' for s, c in
                    [("File", "on"), ("Layout", "on"), ("Columns", "on"), ("Accounts", "cur"), ("Review", "")])
    dialog = f"""<div class="scrim"><div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="up-t">
<div class="dialog-head"><h2 class="t-section" id="up-t">Upload a budget</h2><div class="steps" aria-label="Step 4 of 5">{steps}</div></div>
<div class="dialog-body">
<div class="file">{ico("doc")}<span><span class="l1">Heartland_Install_FY27_v3.xlsx · sheet “Install”</span><span class="l2">From Brent Kolb · monthly layout detected · 8 rows × 12 months · dollars, costs positive</span></span></div>
<div class="row row--between" style="margin:16px 0 8px"><span class="t-head">Map rows to accounts</span><span class="t-cap">6 of 8 matched · 2 need an account</span></div>
{table}
<div class="tie"><div><span class="fig-l">Revenue</span><div class="tnum b" style="margin-top:4px">File {f0(UP_REV)} = import {f0(UP_REV)}</div><span class="t-cap">Ties to the cent</span></div>
<div><span class="fig-l">Cost of revenue</span><div class="tnum b" style="margin-top:4px">File {f0(UP_COST)} · {f0(UP_COST - 186000 - 96000)} mapped</div><span class="t-cap">282,000 waits on the 2 rows above</span></div></div>
<div class="inline-notice inline-notice--info" style="margin-top:16px">{ico("info")}<span>Imports into <b>FY 2027 Budget · draft · Install</b> and replaces Brent’s 8 drafted months. Approved versions can’t be overwritten.</span></div>
</div>
<div class="dialog-foot">{btn("Download template", "quiet", "", "download")}<span class="sp"></span>{btn("Back")}<button class="btn btn--primary" type="button" aria-disabled="true" disabled>Choose 2 accounts to import</button></div></div></div>"""
    page = (f'<div class="page">{head_(btn("Review Sales &amp; marketing", "primary"))}{b_tabs("Cycle")}<div style="margin-top:24px">{figs()}<div class="cyc" style="margin-top:24px">{cycle_table()}</div></div></div>')
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "FY 2027 budget", "<b>Uploading Install</b>"]) + page + dialog
    return app("client", "density-report", h_rail("Budgets"), h_bar("Budgets / <b>Upload</b>"), main, 1160)


TPLS = [
    ("HVAC service & install", "Industry set · 6 departments", ["calls", "ticket", "installs", "equipment %", "members"], "System · v4 · 3 clients", False),
    ("Construction · custom homes", "Industry set · 5 departments", ["homes", "contract", "margin/home", "draw timing"], "System · v3 · 1 client", False),
    ("Cabinets & millwork", "Industry set · 6 departments", ["boxes/week", "material/box", "yield %", "dealer mix"], "System · v2 · 1 client", False),
    ("Sales", "Department · 7 lines", ["quota × commission", "reps × burdened cost"], "System · v3", False),
    ("Marketing", "Department · 7 lines", ["leads × cost per lead", "% of revenue cap"], "System · v3 · 6 departments use it", True),
    ("Operations / field", "Department · 9 lines", ["jobs × hours × rate", "OT % by month", "trucks"], "System · v2", False),
    ("Admin & office", "Department · 7 lines", ["headcount", "leases", "renewals"], "System · v2", False),
    ("Executive", "Department · 5 lines", ["named positions", "events"], "System · v1", False),
    ("Merit HVAC set", "Your template · from HVAC v4", ["3 overrides", "1 client-only line"], "Merit Management Group · v2 · Oct 2", False),
]


def frame_templates():
    nav = ('<nav class="tnav" aria-label="Template library"><ul>'
           '<li><span class="eyebrow">Recommended</span></li><li><a href="#" aria-current="page">All<span class="t-cap">16</span></a></li><li><a href="#">By industry<span class="t-cap">7</span></a></li><li><a href="#">By department<span class="t-cap">9</span></a></li>'
           '<li><span class="eyebrow">Yours</span></li><li><a href="#">Merit Management Group<span class="t-cap">2</span></a></li><li><a href="#">Heartland only<span class="t-cap">1</span></a></li>'
           '<li><span class="eyebrow">Shared</span></li><li><a href="#">Published to clients<span class="t-cap">2</span></a></li></ul></nav>')
    cards = ""
    for n_, k, chips, ft, sel in TPLS:
        ch = "".join(f'<span class="tag">{E(c)}</span>' for c in chips)
        cards += (f'<div class="tcard{" is-sel" if sel else ""}" tabindex="0"><span><span class="l1">{E(n_)}</span><span class="l2">{E(k)}</span></span>'
                  f'<span class="chips">{ch}</span><span class="ft"><span class="t-cap">{E(ft)}</span>{btn("Preview", "quiet")}</span></div>')
    mk = [("Paid search & local service ads", "leads target × cost per lead", "Google Ads · LSA"), ("SEO & content", "monthly retainer", "Vendor"),
          ("Print & direct mail", "drops × cost per drop", "Seasonal weights"), ("Events & home shows", "events calendar", "Named events"),
          ("Brand & creative", "fixed", "—"), ("Marketing software", "seats × price", "/subscriptions renewals"), ("Agency fees", "% of media", "Contract")]
    li = "".join(f'<li><span class="ihm f" aria-hidden="true">↳</span><span><span class="l1">{E(a)}</span><span class="l2">{E(b)} · {E(c)}</span></span></li>' for a, b, c in mk)
    side = f"""<aside class="panel f1-panel" aria-label="Marketing template">
<div class="panel-head"><div class="eyebrow">Department template<span class="sl">//</span>Marketing · v3</div>
<div class="t-head" style="margin-top:4px">Marketing</div><p class="t-cap" style="margin-top:4px">Any industry. Owner: the marketing lead. Budgets spend against a cap and a lead target.</p></div>
<div class="panel-body"><div class="panel-sec"><div class="panel-sec-h"><h3>Recommended lines · drivers</h3><span class="t-cap">7</span></div><ul class="tpl-l">{li}</ul></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Tracks on the department’s BvA</h3></div>
<dl class="kv"><dt>Cost per lead</dt><dd>watch &gt; 20% over</dd><dt>Leads</dt><dd>vs plan</dd><dt>Marketing % of revenue</dt><dd>cap 6.0%</dd></dl></div></div>
<div class="panel-foot">{btn("Copy and edit", "", "", "copy")}<span class="sp"></span>{btn("Use for a department", "primary")}</div></aside>"""
    page = (f'<div class="page">{head_(btn("New template", "primary", "", "plus"))}{b_tabs("Templates")}'
            f'<div class="tl3" style="margin-top:24px">{nav}<div><div class="row row--between" style="margin-bottom:12px"><span class="t-head">Recommended and yours</span>'
            f'<div class="search" style="width:280px">{ico("search")}<input aria-label="Search templates" placeholder="Search templates and lines"></div></div><div class="tgrid">{cards}</div>'
            f'<p class="t-cap" style="margin-top:12px">System templates are copied, never edited in place. Editing a template makes a new version; plans keep the version they started from until the owner applies the update.</p></div>{side}</div></div>')
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "Budgets", "<b>Templates · 9 department, 7 industry, 3 yours</b>"])
    return app("client", "density-report", h_rail("Budgets"), h_bar("Budgets / <b>Templates</b>"), main + page, 1060)


def build():
    html = head("F1 · Budget builder", CSS) + sheet_top("F1-budget-builder.html") + '<main id="main" class="sheet">'
    html += board_h("F1", "FPB-reports-fpna §4.2–4.7 · IA §3.6.1 Budgets (Cycle, Templates) · widget fpa.budget_cycle",
                    "Department budgets that department heads actually own",
                    "Nora sends targets down, each department head builds up from a template, and the plan moves through "
                    "controller review to CFO approval with the gap to target in plain view. Owners can work in Excel and upload; "
                    "the template library recommends lines, drivers and KPIs by industry and by department, and every firm can publish its own.")
    html += pair_h("1 · The cycle", "Heartland · Budgets · Cycle. Report density. Install is selected: Brent is drafting from the HVAC · Install template.")
    html += frame(frame_cycle(), "Open state · blended top-down / bottom-up · one department selected",
                  f"Ties: revenue plans sum to {f0(CY_REV_P)} of {f0(CY_REV_T)}; overhead {f0(CY_OH_P)} vs cap {f0(CY_OH_T)} = {f0(CY_OH_T - CY_OH_P)}")
    html += anno([("Stage on the slash meter", "Draft · Submitted · Controller · CFO. Filled = done, outlined = waiting on that step, brick = returned. The word always sits beside it."),
                  ("Owners, not cells", "Each department names its owner and template. Owners see only their own departments; approval stays with Erin and Nora, and nobody approves their own."),
                  ("The gap is the conversation", "Plan vs target sits on every row. Sales &amp; marketing is 66,000 over its cap, so Nora’s review opens on that line."),
                  ("The co-pilot checks, it doesn’t write", "The equipment check compares Brent’s draft to posted actuals and sizes the effect. Brent decides.")])
    html += pair_h("2 · Upload from Excel", "Brent sends his workbook instead. Rows map to accounts by number, name, then the last upload’s memory; two need a person.")
    html += frame(frame_upload(), "Upload · step 4 of 5 · import blocked until every row has an account",
                  f"Ties: file revenue {f0(UP_REV)} = import; cost {f0(UP_COST)} = {f0(UP_COST - 282000)} mapped + 282,000 waiting")
    html += anno([("Nothing imports half-mapped", "Two rows have no account, so the import button says what’s missing instead of guessing."),
                  ("Totals tie before you commit", "The file’s totals and the import’s totals sit side by side, to the cent."),
                  ("Memory beats AI", "Six rows matched from Brent’s Oct 2 upload. Suggestions come only where memory and names fail, with their confidence."),
                  ("Round-trip", "Download template gives owners the same workbook shape every year, so next year’s upload maps itself.")])
    html += pair_h("3 · Templates", "Recommended by industry and by department, copied into the firm’s own set, published to clients.")
    html += frame(frame_templates(), "Template library · all recommended plus the firm’s own · Marketing selected", "Inheritance marks match S27: follows · overrides · this client only")
    html += anno([("Recommend, then own", "Recommended templates are a start. Copy and edit makes it yours; the firm can publish its set to every client it serves."),
                  ("Lines come with drivers", "Each line has a formula and a source, so a department head plans in leads and trucks, not in account numbers."),
                  ("KPIs ride along", "The template names what the department’s monthly budget-vs-actual will track and when it warns."),
                  ("Versions, not overwrites", "A template edit is a new version. Live plans move only when their owner applies it.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../F1-budget-builder.html", "w").write(build())
    print("ok F1")
