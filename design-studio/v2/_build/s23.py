"""S23 — FP&A for the CFO / finance director (IA-SPEC 4.6, 4.8, 3.6.1 Budgets + FP&A & scenarios, 3.6.5, 3.11)."""
from fo_common import *
from data import BY, G

CSS = """
/* S23 layout only */
.pad{padding:0 var(--margin)}
.lay{table-layout:fixed}
.lay th{padding:8px;border-bottom:1px solid var(--electric);font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:right;white-space:nowrap;vertical-align:bottom}
.lay th:first-child,.lay th.l{text-align:left}
.lay td{height:44px;padding:4px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.lay td:first-child{text-align:left;white-space:normal}
.lay tr>*:first-child{padding-left:0}
.lay tr>*:last-child{padding-right:0}
.lay tr.ln:hover td{background:var(--sky)}
.lay tr.elim td{color:var(--ink-2)}
.lay tr.tot td{font-weight:700;border-bottom:0;height:48px}
.lay tr.tot td.n{border-top:1px solid var(--midnight);border-bottom:3px double var(--electric)}
.lay tr.sub td{font-weight:600}
.lay .hp{visibility:hidden}
.lay tr.out td{color:var(--ink-2)}
/* signature: the plan bar — actual, committed, estimated, against a budget tick */
.pb{position:relative;display:block;height:16px;background:transparent}
.pb span{position:absolute;top:0;bottom:0}
.pb .a{background:var(--midnight)}
.pb .c{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--blue-200) 3px 6px)}
.pb .e{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--blue-300)}
.pb .b{top:-5px;bottom:-5px;width:2px;margin-left:-1px;background:var(--neg)}
.pb .b.ok{background:var(--pos)}
.lgd{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:12px;line-height:16px;color:var(--ink-2)}
.lgd span{display:inline-flex;align-items:center;gap:6px}
.lgd i{display:inline-block;width:20px;height:10px}
.lgd i.a{background:var(--midnight)} .lgd i.c{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--blue-200) 3px 6px)}
.lgd i.e{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--blue-300)} .lgd i.b{width:2px;height:16px;background:var(--neg)}
.dlt.neg{color:var(--neg)} .dlt.pos{color:var(--pos)}
.two{display:grid;grid-template-columns:minmax(0,1fr) 352px;column-gap:24px}
.mo{display:grid;grid-template-columns:repeat(12,1fr);gap:8px;align-items:end;height:168px;padding-top:8px;border-bottom:1px solid var(--midnight)}
.mo div{position:relative;height:100%;display:flex;align-items:flex-end;justify-content:center}
.mo .bud{position:absolute;left:4px;right:4px;bottom:0;box-shadow:inset 0 0 0 1px var(--steel)}
.mo .act{position:relative;width:55%;background:var(--midnight)}
.mo .fc{position:relative;width:55%;background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--blue-200) 3px 6px)}
.mo-ax{display:grid;grid-template-columns:repeat(12,1fr);gap:8px;margin-top:6px;font-size:12px;line-height:16px;color:var(--ink-3);text-align:center}
.mo-ax b{color:var(--ink);font-weight:600}
.drv td{height:44px}
.drv .in{width:96px;height:32px;text-align:right}
.drv tr.grp td{height:auto;padding-top:16px;font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);border-bottom:0}
.src{font-size:12px;line-height:16px;color:var(--ink-3)}
.versions li .vt{font-weight:600}
.sc{display:grid;grid-template-columns:240px repeat(4,minmax(0,1fr));border-top:2px solid var(--electric)}
.sc>div{padding:12px 16px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);min-width:0}
.sc>div:nth-child(5n){border-right:0}
.sc .h{background:var(--white)}
.sc .h .t-head{display:block;margin-top:4px}
.sc .h p{font-size:12px;line-height:16px;color:var(--ink-2);margin-top:4px}
.sc .base{background:var(--canvas)}
.sc .m{color:var(--ink-2);display:flex;align-items:center}
.sc .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums}
.sc .d{display:block;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.sc .d.neg{color:var(--neg)} .sc .d.pos{color:var(--pos)} .sc .d.z{color:var(--ink-3)}
.notes3{display:grid;grid-template-columns:repeat(3,1fr);column-gap:24px;margin-top:24px}
.notes3 .notes-head{grid-column:1/-1}
.wgs{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:136px;gap:24px;margin-top:24px}
.bc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line)}
"""

MEMBERS = ["mmg", "heartland", "metro", "dorrian", "crystal", "aim", "icc", "revived", "artistry"]
SHARE = {"metro": .45, "dorrian": .40, "crystal": .55, "aim": .60, "icc": .65, "revived": .55, "artistry": .80}
R = {}
for k in MEMBERS:
    c = BY[k]
    if k == "mmg":
        R[k] = dict(ytd=2808000, com=936000, est=0, bud=3744000)
    elif k == "heartland":
        R[k] = dict(ytd=13284600, com=1936200, est=2115840, bud=17880000)
    else:
        ytd = round(c["rev"] * 8.6 / 100) * 100
        q4 = round(c["rev"] * 2.95 / 100) * 100
        com = round(q4 * SHARE[k] / 100) * 100
        R[k] = dict(ytd=ytd, com=com, est=q4 - com, bud=round(c["rev_bud"] * 11.6 / 1000) * 1000)
    r = R[k]
    r["ref"] = r["ytd"] + r["com"] + r["est"]
    r["var"] = r["ref"] - r["bud"]
    mb = c["ebitda_bud"] / c["rev_bud"]
    ms = c["ebitda"] / c["rev"]
    r["eb_bud"] = round(r["bud"] * mb / 100) * 100
    r["eb_ref"] = round(r["ref"] * (0.5 * ms + 0.5 * mb) / 100) * 100
    r["gm"] = c["gp"] / c["rev"] * 100
ELIM = {f: R["mmg"][f] for f in ("ytd", "com", "est", "bud", "ref", "var")}
TOT = {f: sum(R[k][f] for k in MEMBERS) - ELIM.get(f, 0) for f in ("ytd", "com", "est", "bud", "ref", "var")}
TOT["eb_bud"] = sum(R[k]["eb_bud"] for k in MEMBERS)
TOT["eb_ref"] = sum(R[k]["eb_ref"] for k in MEMBERS)
assert TOT["ref"] == TOT["ytd"] + TOT["com"] + TOT["est"]
assert TOT["var"] == TOT["ref"] - TOT["bud"]
assert ELIM["ytd"] == 9 * G["elim"]  # nine months of 312,000 fees

# Heartland drivers (Q4 = Oct-Dec)
HQ = dict(calls=1980, ticket=236, inst_signed=148, inst_pipe=70, inst_avg=10200, members=4740, fee=30)
HQ_SERV = HQ["calls"] * HQ["ticket"] * 3
HQ_INST_C = HQ["inst_signed"] * HQ["inst_avg"]
HQ_INST_E = HQ["inst_pipe"] * HQ["inst_avg"]
HQ_MAINT = HQ["members"] * HQ["fee"] * 3
assert HQ_INST_C + HQ_MAINT == R["heartland"]["com"]
assert HQ_SERV + HQ_INST_E == R["heartland"]["est"]
HB = dict(calls=2050, ticket=240, inst=240, inst_avg=10000, members=4800, fee=30)
HB_Q4 = HB["calls"] * HB["ticket"] * 3 + HB["inst"] * HB["inst_avg"] + HB["members"] * HB["fee"] * 3
assert HB_Q4 == 4308000
H_REF_Q4 = HQ_SERV + HQ_INST_C + HQ_INST_E + HQ_MAINT
H_BUD_YTD = R["heartland"]["bud"] - HB_Q4
assert (R["heartland"]["ytd"] - H_BUD_YTD) + (H_REF_Q4 - HB_Q4) == R["heartland"]["var"]

W = [7, 6.5, 7, 7.5, 8.5, 10.5, 12, 11.5]


def spread(total, weights, step=100):
    s = sum(weights)
    out = [round(total * w / s / step) * step for w in weights]
    out[-1] += total - sum(out)
    return out


H_ACT = spread(R["heartland"]["ytd"] - BY["heartland"]["rev"], W) + [BY["heartland"]["rev"]]
H_BUD = spread(H_BUD_YTD - BY["heartland"]["rev_bud"], W) + [BY["heartland"]["rev_bud"]]
H_FC = spread(H_REF_Q4, [36, 33, 31], 10)
H_BQ4 = spread(HB_Q4, [36, 33, 31])
assert sum(H_ACT) == R["heartland"]["ytd"] and sum(H_BUD) == H_BUD_YTD and sum(H_FC) == H_REF_Q4 and sum(H_BQ4) == HB_Q4


def pct(x):
    return f"{x:.1f}%"


def dl(x, dec=0):
    s = f0(x) if not dec else f2(x)
    cls = "neg" if x < 0 else ("pos" if x > 0 else "")
    return f'<span class="dlt {cls}">{s}{HP if x >= 0 else ""}</span>'


def nn(x):
    return f0(x) + (HP if x >= 0 else "")


# --------------------------------------------------------------- frame A: consolidated BvA, layered
def plan_bar(r, scale):
    a = r["ytd"] / scale * 100
    c = r["com"] / scale * 100
    e = r["est"] / scale * 100
    b = r["bud"] / scale * 100
    ok = " ok" if r["ref"] >= r["bud"] else ""
    lab = (f'Actual {f0(r["ytd"])}, committed {f0(r["com"])}, estimated {f0(r["est"])}, budget {f0(r["bud"])}')
    return (f'<span class="pb" role="img" aria-label="{lab}"><span class="a" style="left:0;width:{a:.2f}%"></span>'
            f'<span class="c" style="left:{a:.2f}%;width:{c:.2f}%"></span><span class="e" style="left:{a + c:.2f}%;width:{e:.2f}%"></span>'
            f'<span class="b{ok}" style="left:{b:.2f}%"></span></span>')


def cons_rail():
    groups = [("Merit Management Group — Consolidated", [("Group home",), ("Statements",), ("Eliminations", False, 1), ("Intercompany pairs", False, 1),
                                                         ("Cash across group",), ("Budget vs actual & FP&A", True), ("Covenants",), ("Board & lender packs",),
                                                         ("Group close", False, "7/9"), ("Group setup",)]),
              ("Workspace", [("Back to workspace",)])]
    return rail(groups, "Nora Lindqvist", "CFO")


def ctx_group():
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false" style="max-width:none">{ico("layers")}<span class="ctx-name">Merit Management Group — Consolidated</span>'
            f'<span class="ctx-tag ctx-tag--ro">Read-only</span>{ico("down")}<span class="kbd">⌘J</span></button>')


def group_frame():
    rows_k = sorted([k for k in MEMBERS if k != "mmg"], key=lambda k: R[k]["var"])
    scale = max(max(R[k]["bud"], R[k]["ref"]) for k in rows_k) * 1.02
    tr = ""
    for k in rows_k:
        r = R[k]
        tr += (f'<tr class="ln" data-drill="{BY[k]["name"]} · Budgets"><td><span class="l1">{E(BY[k]["name"])}</span><span class="l2">GM {pct(r["gm"])} Sep</span></td>'
               f'<td class="l">{plan_bar(r, scale)}</td><td>{nn(r["ytd"])}</td><td>{nn(r["com"])}</td><td>{nn(r["est"])}</td><td class="b">{nn(r["ref"])}</td><td>{nn(r["bud"])}</td><td>{dl(r["var"])}</td>'
               f'<td>{dl(r["eb_ref"] - r["eb_bud"])}</td></tr>')
    m = R["mmg"]
    tr += (f'<tr class="ln"><td><span class="l1">Merit Management Group LLC</span><span class="l2">Own books · management fees</span></td><td class="l">{plan_bar(m, scale)}</td>'
           f'<td>{nn(m["ytd"])}</td><td>{nn(m["com"])}</td><td>{nn(m["est"])}</td><td class="b">{nn(m["ref"])}</td><td>{nn(m["bud"])}</td><td>{dl(m["var"])}</td><td>{dl(m["eb_ref"] - m["eb_bud"])}</td></tr>')
    tr += (f'<tr class="elim"><td>Intercompany fees</td><td></td><td>{f0(-ELIM["ytd"])}</td><td>{f0(-ELIM["com"])}</td><td>—{HP}</td><td>{f0(-ELIM["ref"])}</td><td>{f0(-ELIM["bud"])}</td><td>—{HP}</td><td>—{HP}</td></tr>')
    tr += (f'<tr class="tot"><td>9 clients, eliminations on</td><td></td><td class="n">{nn(TOT["ytd"])}</td><td class="n">{nn(TOT["com"])}</td><td class="n">{nn(TOT["est"])}</td><td class="n">{nn(TOT["ref"])}</td>'
           f'<td class="n">{nn(TOT["bud"])}</td><td class="n">{dl(TOT["var"])}</td><td class="n">{dl(TOT["eb_ref"] - TOT["eb_bud"])}</td></tr>')
    table = (f'<table class="lay" aria-label="FY 2026 revenue: actual, committed, estimated, reforecast and budget, by client">'
             f'<colgroup><col style="width:192px"><col><col style="width:104px"><col style="width:96px"><col style="width:96px"><col style="width:112px"><col style="width:104px"><col style="width:96px"><col style="width:104px"></colgroup>'
             f'<thead><tr><th>Client · most under first</th><th class="l">FY 2026 revenue</th><th>Jan–Sep</th><th>Committed</th><th>Estimated</th><th>Reforecast</th><th>Budget</th><th>vs budget</th><th>EBITDA vs bud</th></tr></thead><tbody>{tr}</tbody></table>')
    lg = ('<div class="lgd"><span><i class="a"></i>Actual · posted, Jan–Sep</span><span><i class="c"></i>Committed · signed jobs, agreements, open POs</span>'
          '<span><i class="e"></i>Estimated · driver model, Oct–Dec</span><span><i class="b"></i>Budget, approved Dec 2025</span></div>')
    hl = R["heartland"]
    note = f"""<aside class="notes notes3" aria-label="Notes"><div class="notes-head"><span class="eyebrow">Notes to the reforecast</span><span class="t-cap">v3 · Oct 6</span></div>
<article class="note" data-note="1"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Largest miss</div><div class="note-title">Heartland is {f0(-hl["var"])} under budget for the year</div></div></div>
<p>Two parts: Jan–Sep came in under, and Q4 installs are short of plan. Equipment costs rose on 14 jobs, which is why EBITDA misses by more than revenue.</p>
<ul class="ev"><li>Jan–Sep actual vs budget<span class="dl"></span><span class="v">{f0(hl["ytd"] - H_BUD_YTD)}</span></li><li>Oct–Dec reforecast vs budget<span class="dl"></span><span class="v">{f0(H_REF_Q4 - HB_Q4)}</span></li>
<li class="ev-total">Full year<span class="dl"></span><span class="v">{f0(hl["var"])}</span></li></ul>
<div class="basis"><span>Basis: <b>posted ledger + driver model</b></span><span>Computed; AI only words it</span></div>
<div class="note-acts"><button class="btn btn--quiet" type="button">Open Heartland drivers{ico("right")}</button></div></article>
<article class="note" data-note="2"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">How sure is Q4</div><div class="note-title">{TOT["com"] / (TOT["com"] + TOT["est"]) * 100:.0f}% of the rest of the year is already signed</div></div></div>
<p>Committed is backlog from Buildertrend and ServiceTitan, maintenance agreements and open POs. Estimated is the driver model. Artistry is mostly committed; Dorrian mostly estimated.</p>
<ul class="ev"><li>Committed, Oct–Dec<span class="dl"></span><span class="v">{f0(TOT["com"])}</span></li><li>Estimated, Oct–Dec<span class="dl"></span><span class="v">{f0(TOT["est"])}</span></li>
<li class="ev-total">Rest of year<span class="dl"></span><span class="v">{f0(TOT["com"] + TOT["est"])}</span></li></ul></article>
<article class="note" data-note="3"><div class="note-top"><span class="note-no">3</span><div><div class="note-kind">Outside this group</div><div class="note-title">Clive, Heritage, Swan Creek, Wild Rose</div></div></div>
<p>They’re owned through the funds, so they aren’t in this total. See them side by side in Insights · Compare clients, never summed (IA §3.11).</p></article></aside>"""
    page = (f'<div class="page"><div class="page-head"><div><div class="eyebrow">Merit Management Group — Consolidated<span class="sl">//</span>Budget vs actual &amp; FP&amp;A</div>'
            f'<h1 class="t-title" style="margin-top:4px">FY 2026: where the year lands</h1></div><div class="btn-row"><div class="seg" role="group" aria-label="Measure"><button type="button" aria-pressed="true">Revenue</button><button type="button" aria-pressed="false">EBITDA</button><button type="button" aria-pressed="false">Cash</button></div>'
            f'{btn("Export", "", "", "download")}</div></div>'
            f'<div>{lg}<div style="margin-top:16px">{table}</div><p class="t-cap" style="margin-top:12px">Totals tie: actual + committed + estimated = reforecast on every row. Eliminations are the own-books fees, shown as their own line. Bars share one scale. EBITDA vs budget is the reforecast’s full-year EBITDA less budget.</p></div>{note}</div>')
    main = ctxline(["Mon Oct 19", "FY 2026", "Reforecast v3, Oct 6", "September preliminary · 2 members open", "<b>" + f0(-TOT["var"]) + " under budget for the year</b>"]) + page
    return app("consolidated", "density-report", cons_rail(), bar(ctx_group(), "<b>Budget vs actual &amp; FP&amp;A</b>", cmd="Jump to client, statement, account…"), main, 1180, live=True)


# --------------------------------------------------------------- frame B: Heartland drivers + reforecast
def h_rail():
    uses = {"Purchase orders", "Payroll", "Inventory", "Debt & covenants", "Revenue recognition", "Jobs", "WIP", "Intercompany"}
    return rail(client_nav(uses, "Budgets", {"Inbox": 2}), "Nora Lindqvist", "CFO")


def b_tabs(sel):
    out = '<div class="tabs" role="tablist" aria-label="Budgets">'
    for t in ["Plan", "Drivers", "Reforecast", "Cycle", "Budget vs actual"]:
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}</button>'
    return out + "</div>"


def months():
    mx = max(max(H_ACT), max(H_BUD), max(H_FC), max(H_BQ4)) * 1.05
    cols, ax = "", ""
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    for i in range(12):
        b = (H_BUD + H_BQ4)[i]
        v = (H_ACT + H_FC)[i]
        cls = "act" if i < 9 else "fc"
        cols += (f'<div title="{names[i]}: {"actual" if i < 9 else "reforecast"} {f0(v)} · budget {f0(b)}"><span class="bud" style="height:{b / mx * 100:.1f}%"></span>'
                 f'<span class="{cls}" style="height:{v / mx * 100:.1f}%"></span></div>')
        ax += f'<span>{"<b>" + names[i] + "</b>" if i == 8 else names[i]}</span>'
    return f'<div class="mo" role="img" aria-label="Heartland monthly revenue, actual Jan to Sep and reforecast Oct to Dec, against budget outlines">{cols}</div><div class="mo-ax">{ax}</div>'


def drivers_frame():
    def row(name, src, bud, run, ref, unit="", fmt=None, eff=None):
        fmt = fmt or (lambda x: f"{x:,}")
        e = f'<td>{dl(eff)}</td>' if eff is not None else "<td></td>"
        inp = f'<input class="input input--money in" aria-label="{E(name)} reforecast" value="{fmt(ref)}">'
        return (f'<tr class="ln"><td><span class="l1">{name}</span><span class="src">{src}</span></td><td>{fmt(bud)}{unit}</td><td>{fmt(run)}{unit}</td>'
                f'<td>{inp}</td>{e}</tr>')
    rows = '<tr class="grp"><td colspan="5">Revenue drivers · per month unless noted · effect on revenue</td></tr>'
    rows += row("Service calls", "ServiceTitan · completed calls", HB["calls"], 2012, HQ["calls"], eff=(HQ["calls"] * HQ["ticket"] - HB["calls"] * HB["ticket"]) * 3)
    rows += row("Average service ticket", "ServiceTitan · invoiced ÷ calls", HB["ticket"], 237, HQ["ticket"], fmt=lambda x: f"{x:,.2f}")
    rows += row("Installs, Oct–Dec", "Buildertrend 148 signed · ServiceTitan 70 from pipeline", HB["inst"], 231, HQ["inst_signed"] + HQ["inst_pipe"], eff=(HQ["inst_signed"] + HQ["inst_pipe"] - HB["inst"]) * HB["inst_avg"] + (HQ["inst_signed"] + HQ["inst_pipe"]) * (HQ["inst_avg"] - HB["inst_avg"]))
    rows += row("Average install", "GL 4100 ÷ completed installs", HB["inst_avg"], 10318, HQ["inst_avg"], fmt=lambda x: f"{x:,.2f}")
    rows += row("Maintenance members", "ServiceTitan · active agreements", HB["members"], 4762, HQ["members"], eff=(HQ["members"] - HB["members"]) * HQ["fee"] * 3)
    rows += '<tr class="grp"><td colspan="5">Cost drivers · effect on EBITDA, not in the total</td></tr>'
    rows += row("Equipment cost, % of install", "GL 5100 ÷ 4100 · Carrier increases Jul 1", 46.0, 49.1, 48.5, unit="%", fmt=lambda x: f"{x:.1f}", eff=-round((HQ_INST_C + HQ_INST_E) * 0.025))
    rows += row("Technicians", "Payroll · 2 open roles", 38, 37, 36, eff=round(2 * 7800 * 3))
    serv_eff = (HQ["calls"] * HQ["ticket"] - HB["calls"] * HB["ticket"]) * 3
    inst_eff = (HQ["inst_signed"] + HQ["inst_pipe"] - HB["inst"]) * HB["inst_avg"] + (HQ["inst_signed"] + HQ["inst_pipe"]) * (HQ["inst_avg"] - HB["inst_avg"])
    maint_eff = (HQ["members"] - HB["members"]) * HQ["fee"] * 3
    assert serv_eff + inst_eff + maint_eff == H_REF_Q4 - HB_Q4, (serv_eff, inst_eff, maint_eff, H_REF_Q4 - HB_Q4)
    rows += (f'<tr class="tot"><td>Q4 revenue, reforecast vs budget</td><td class="n">{nn(HB_Q4)}</td><td></td><td class="n">{nn(H_REF_Q4)}</td><td class="n">{dl(H_REF_Q4 - HB_Q4)}</td></tr>')
    table = (f'<table class="lay drv" aria-label="Heartland driver model, Q4"><colgroup><col><col style="width:104px"><col style="width:112px"><col style="width:120px"><col style="width:112px"></colgroup>'
             f'<thead><tr><th>Driver · source</th><th>Budget</th><th>Jan–Sep</th><th>Q4 refcst</th><th>Q4 effect</th></tr></thead><tbody>{rows}</tbody></table>')
    vers = f"""<ol class="versions" aria-label="Reforecast versions">
<li class="is-current"><span class="vno">v3</span><span><span class="vt">9+3 · Oct 6 · Nora Lindqvist</span><span class="t-cap" style="display:block">September preliminary · current</span></span><span class="tnum b">{f0(R["heartland"]["ref"])}</span></li>
<li><span class="vno">v2</span><span><span class="vt">6+6 · Jul 8</span><span class="t-cap" style="display:block">before Carrier’s July increase</span></span><span class="tnum">{f0(17612000)}</span></li>
<li><span class="vno">v1</span><span><span class="vt">3+9 · Apr 7</span></span><span class="tnum">{f0(17905000)}</span></li>
<li><span class="vno">B</span><span><span class="vt">Budget · approved Dec 12, 2025</span></span><span class="tnum">{f0(R["heartland"]["bud"])}</span></li></ol>"""
    side = f"""<div><div class="row row--between"><span class="t-head">Versions</span><span class="t-cap">Each version is kept; budget never changes</span></div>{vers}
<div class="inline-notice inline-notice--info" style="margin-top:16px">{ico("info")}<span><b>September closes Oct 21.</b> Reforecast after close to roll v4 on final September numbers.</span></div>
<div class="btn-row" style="margin-top:16px">{btn("Reforecast now", "primary")}{btn("Compare versions")}</div></div>"""
    page = (f'<div class="page"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Planning &amp; reports<span class="sl">//</span>Budgets</div><h1 class="t-title" style="margin-top:4px">Heartland FY 2026</h1></div>'
            f'<div class="btn-row">{btn("Scenarios", "", "", "branch")}</div></div>{b_tabs("Drivers")}'
            f'<div class="two" style="margin-top:24px"><div><div class="row row--between"><span class="t-head">Revenue by month · actual and reforecast against budget</span><span class="t-cap">outline = budget</span></div>{months()}'
            f'<div style="margin-top:32px">{table}</div><p class="t-cap" style="margin-top:12px">Change a Q4 value and the reforecast, EBITDA and 13-week cash recompute. Q4 effects sum to the total.</p></div>{side}</div></div>')
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "Budgets", "<b>Reforecast v3 · " + f0(R["heartland"]["var"]) + " vs budget</b>"]) + page
    return app("client", "density-report", h_rail(), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Budgets / <b>Drivers</b>", cmd="Jump to account, driver, report…"), main, 1180)


# --------------------------------------------------------------- frame C: scenarios
SC_BASE = dict(rev=19400000, eb=1420000, cash=1210000, dscr=1.58)
SCEN = [("Carrier +6% in January, pass half through", "From “What if Carrier raises prices 6% in January and we pass half through?”",
         dict(rev=174000, eb=-174000, cash=-148000, dscr=-0.19), "Equipment cost +6% · install price +3%"),
        ("Two more install crews from Nov 1", "Pinned to Nora’s home", dict(rev=1320000, eb=198000, cash=-160000, dscr=0.08), "Installs +3 a week · techs +6 · 2 trucks"),
        ("Lose the Polk County Schools agreement", "Renewal is Jan 31", dict(rev=-286000, eb=-121000, cash=-62000, dscr=-0.09), "Members −310 · service calls −40 a month")]


def scen_frame():
    hdr = '<div class="h base"><span class="eyebrow">Base</span><span class="t-head">Reforecast v3</span><p>Next 12 months, Oct 2026–Sep 2027</p></div>'
    hdr = '<div class="h"><span class="eyebrow">Heartland</span><span class="t-head">Next 12 months</span></div>' + hdr
    for t, s, d, a in SCEN:
        hdr += f'<div class="h"><span class="eyebrow">Scenario</span><span class="t-head">{t}</span><p>{s}</p><p class="ink-3">{a}</p></div>'

    def line(lbl, key, fmt, dfmt):
        out = f'<div class="m">{lbl}</div><div class="base"><span class="v">{fmt(SC_BASE[key])}</span><span class="d z">base</span></div>'
        for t, s, d, a in SCEN:
            v = SC_BASE[key] + d[key]
            cls = "pos" if d[key] > 0 else ("neg" if d[key] < 0 else "z")
            if key == "cash":
                cls = "pos" if d[key] > 0 else "neg"
            out += f'<div><span class="v">{fmt(v)}</span><span class="d {cls}">{dfmt(d[key])}</span></div>'
        return out
    body = hdr
    body += line("Revenue", "rev", f0, lambda x: ("+" if x > 0 else "") + f0(x))
    body += line("EBITDA", "eb", f0, lambda x: ("+" if x > 0 else "") + f0(x))
    body += line("Lowest cash, 13 weeks", "cash", f0, lambda x: ("+" if x > 0 else "") + f0(x))
    body += line("DSCR at Dec 31 · Northwest min 1.25×", "dscr", lambda x: f"{x:.2f}×", lambda x: ("+" if x > 0 else "−" if x < 0 else "") + f"{abs(x):.2f}×")
    acts = '<div class="m"></div><div class="base"></div>' + "".join(f'<div><div class="btn-row">{btn("Pin" if i != 1 else "Pinned", "quiet")}{btn("Apply to reforecast…")}</div></div>' for i in range(3))
    grid = f'<div class="sc" role="table" aria-label="Scenarios compared with the base reforecast">{body}{acts}</div>'
    note = f"""<article class="note note--panel" style="margin-top:24px"><div class="note-top"><span class="note-no">A</span><div><div class="note-kind">How the question became drivers</div><div class="note-title">“Carrier raises prices 6% in January and we pass half through”</div></div></div>
<ul class="ev"><li>Equipment cost on installs, +6% from Jan 1<span class="dl"></span><span class="v">(348,000)</span></li><li>Install price, +3% from Jan 1<span class="dl"></span><span class="v">174,000</span></li>
<li class="ev-total">EBITDA effect, next 12 months<span class="dl"></span><span class="v">(174,000)</span></li></ul>
<div class="basis"><span>Parsed by rules · works with AI off</span><span>Install volume held at v3</span></div></article>"""
    page = (f'<div class="page"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Planning &amp; reports<span class="sl">//</span>FP&amp;A &amp; scenarios</div><h1 class="t-title" style="margin-top:4px">Scenarios</h1></div>'
            f'<div class="btn-row"><div class="search" style="width:420px">{ico("search")}<input aria-label="Ask a what-if" placeholder="Ask a what-if: “what if we hire two techs in March?”"></div>{btn("New scenario", "primary", "", "plus")}</div></div>'
            f'{grid}{note}</div>')
    assert SCEN[0][2]["eb"] == -348000 + 174000
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "FP&amp;A &amp; scenarios", "<b>3 scenarios against v3</b>"]) + page
    return app("client", "density-report", h_rail().replace('aria-current="page"', "").replace('>FP&amp;A &amp; scenarios<', ' aria-current="page">FP&amp;A &amp; scenarios<'),
               bar(ctx_client("Heartland Heating & Cooling", "C-103"), "FP&amp;A / <b>Scenarios</b>", cmd="Jump to account, driver, report…"), main, 900)


# --------------------------------------------------------------- widgets on the CFO / FD / DH homes
def widgets():
    hl = R["heartland"]
    body1 = f"""<div class="wg-body--pad"><div class="row row--between"><span class="ink-2">Group reforecast · v3 Oct 6</span><span class="b tnum">{f0(TOT["ref"])}</span></div>
<div class="row row--between" style="margin-top:4px"><span class="ink-2">Budget</span><span class="tnum">{f0(TOT["bud"])}</span></div>
<div class="row row--between" style="margin-top:4px"><span class="ink-2">vs budget</span><span class="tnum neg b">{f0(TOT["var"])}</span></div>
<div style="margin-top:12px">{plan_bar(TOT, max(TOT["bud"], TOT["ref"]) * 1.02)}</div><p class="t-cap" style="margin-top:8px">Heartland is {f0(hl["var"])} of it</p></div>"""
    w1 = wg("fpa.reforecast", "Forecast vs budget", body1, 1, 1, 4, 2, meta="FY 2026", foot=f'<span>Last reforecast 13 days ago</span>{btn("Reforecast now", "primary")}', label_id="w-rf")
    cyc = [("Heartland Heating &amp; Cooling", "3 of 4 departments in", "track", "On track"), ("Dorrian HVAC", "due Oct 16 · nothing in", "overdue", "Overdue"),
           ("Iowa Custom Cabinets", "submitted Oct 14", "ready", "In review"), ("AIM Kitchen &amp; Bath", "drafting", "track", "Drafting")]
    b2 = "".join(f'<div class="bc-row"><span><span class="l1">{c}</span><span class="l2">{s}</span></span>{status(k, w)}</div>' for c, s, k, w in cyc)
    w2 = wg("fpa.budget_cycle", "FY 2027 budget cycle", b2, 5, 1, 4, 2, count="13", meta="5 in · 1 overdue · due Nov 6", foot=f'<span>Top-down targets sent Oct 1</span>{btn("Review 2 submissions")}', label_id="w-bc")
    b3 = f"""<div class="wg-body--pad"><p class="t-head">Brent Kolb · Install, Heartland</p><p class="ink-2" style="margin-top:4px">Your FY 2027 budget is due <b class="ink">Fri Nov 6</b>. Target from Nora: 9,600,000 revenue, 46% equipment cost.</p>
<div class="row row--between" style="margin-top:12px"><span class="ink-2">Drafted so far</span><span class="tnum b">8 of 12 months</span></div></div>"""
    w3 = wg("fpa.budget_cycle", "Budget submission", b3, 9, 1, 4, 2, meta="Department head", foot=f'<span>Saved 2 days ago</span>{btn("Open my budget", "primary")}', label_id="w-dh")
    e1 = f'<div class="wg-state"><span class="wg-empty-mark">{ico("plus")}</span><p class="t-head">No budget for FY 2027 at Wild Rose yet.</p><p>Start from FY 2026 actuals plus a growth rate, or import a spreadsheet.</p></div>'
    w4 = wg("fpa.reforecast", "Forecast vs budget", e1, 1, 3, 6, 2, meta="Empty state", foot=f'<span>Wild Rose Interiors</span>{btn("Start budget")}', label_id="w-e")
    d1 = f'<div class="wg-state"><span class="wg-done-mark">{ico("check")}</span><p class="t-head">Every FY 2027 budget is in and approved.</p><p>13 of 13 · next reforecast after October closes, about Nov 18.</p></div>'
    w5 = wg("fpa.budget_cycle", "FY 2027 budget cycle", d1, 7, 3, 6, 2, meta="Done state", label_id="w-d")
    return f'<div class="wgs density-cockpit">{w1}{w2}{w3}{w4}{w5}</div>'


def build():
    html = head("S23 · FP&A", CSS) + sheet_top("S23-fpna.html") + '<main id="main" class="sheet">'
    html += board_h("S23", "IA-SPEC §4.6 · §4.8 · §3.6.1 Budgets, FP&amp;A &amp; scenarios · §3.6.5 · §3.11",
                    "Nora’s plan: where the year lands, and how sure we are of it",
                    "Every plan figure is split three ways: what has posted, what is signed, and what the driver model estimates. "
                    "The CFO reads that across the consolidated group, opens one client’s drivers to see why, and tests a what-if against the same numbers. "
                    "Annual Report density; budgets and scenarios stay inside the client where the drivers live.")
    html += pair_h("1 · The group’s year", "Consolidated context, Budget vs actual &amp; FP&amp;A. A total is allowed here because Nora holds the group; eliminations are a line.")
    html += frame(group_frame(), "Open state · report density · notes are deterministic, the AI only writes their words",
                  f"Ties: reforecast {f0(TOT['ref'])} = actual {f0(TOT['ytd'])} + committed {f0(TOT['com'])} + estimated {f0(TOT['est'])}")
    html += anno([("Three layers, one bar", "Posted actuals are solid Midnight; committed is the brand’s slash hatched in blue; estimated is an outline. The tick is the budget: red when the bar falls short."),
                  ("Certainty is a number", "Note 2 says how much of the rest of the year is already signed. A reforecast that is 80% estimated reads differently from one that is 80% committed."),
                  ("Totals only where allowed", "The 9 members sum because this is the consolidated context. The 4 fund-owned clients are named and sent to Compare clients."),
                  ("Profitability rides along", "GM % for September sits under each client name. Insights · Profitability by client holds the ranking.")])
    html += pair_h("2 · One client’s drivers", "Heartland · Budgets · Drivers. The tab row is the whole budget lifecycle: Plan · Drivers · Reforecast · Cycle · Budget vs actual.")
    html += frame(drivers_frame(), "Drivers tab · each driver names its source system", f"Ties: Q4 effects sum to {f0(H_REF_Q4 - HB_Q4)}; with Jan–Sep {f0(R['heartland']['ytd'] - H_BUD_YTD)} = {f0(R['heartland']['var'])}, note 1")
    html += pair_h("3 · Scenarios", "FP&amp;A &amp; scenarios. Three what-ifs against the same base, one typed as a question.")
    html += frame(scen_frame(), "Scenario compare · deltas against v3 · applying one to the reforecast asks first", "Covenant line uses Heartland’s Northwest DSCR test (S24 has the covenant)")
    html += anno([("Drivers have sources", "Calls and members come from ServiceTitan, backlog from Buildertrend, cost ratios from the ledger. A driver nobody can source isn’t a driver."),
                  ("Versions are kept", "v1 to v3 and the budget stay side by side. The budget is never edited; it’s compared against."),
                  ("A question becomes arithmetic", "The typed what-if is parsed into two driver changes shown as a ledger that sums, and it works with AI off."),
                  ("The covenant is in the scenario", "DSCR at Dec 31 is a row, so a scenario that hurts the lender test says so before anyone applies it.")])
    html += pair_h("4 · On the homes", "fpa.reforecast and fpa.budget_cycle for the CFO, the department head’s submission card, and their empty and done states.")
    html += widgets()
    html += foot()
    return html


if __name__ == "__main__":
    open("../S23-fpna.html", "w").write(build())
    print("ok", TOT)
