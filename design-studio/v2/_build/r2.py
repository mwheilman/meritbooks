"""R2 — Report view: MG-01 Monthly management report, Heartland, September 2026 (FPB-reports-fpna §1.2, §2, §3)."""
from rf_common import *
from rf_data import REV_DEPTS, OH_DEPTS, REV, GP, OH, EB, COGS, BRIDGE, INSTALL_COGS, H

CSS = """
.r2 .lay col.c-l{width:auto}
.r2-figs .fig-vs b{font-weight:600;color:var(--ink)}
.cmp{display:flex;align-items:center;gap:8px}
.cmp .t-cap{white-space:nowrap}
.notes .note .basis .tag{height:20px}
.draft-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px}
.drill{position:sticky;top:0}
.drill .panel-body{padding-bottom:16px}
.dtab{width:100%;table-layout:fixed}
.dtab th{font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:right;padding:0 0 6px;border-bottom:1px solid var(--electric)}
.dtab th:first-child{text-align:left}
.dtab td{padding:6px 0;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;vertical-align:top}
.dtab td:first-child{text-align:left}
.dtab tr.t td{font-weight:700;border-bottom:3px double var(--electric);border-top:1px solid var(--midnight)}
.dtab .hp{visibility:hidden}
.hide-note{margin-top:8px}
.r2-figs .link{display:inline-flex;align-items:center;min-height:32px}
.lay tr.is-sel td:first-child{padding-left:8px}
"""

COMPARE = "Budget"


def var_rev(a, b):
    return a - b


def row(label, sub, act, bud, aug, py, cost=False, cls="ln", note=None, drill=None, sel=False, narrow=False):
    var = (bud - act) if cost else (act - bud)
    vp = (var / bud * 100) if bud else 0
    nr = f'<a class="nref" data-note="{note}" href="#r2n{note}">{note}</a>' if note else ""
    l2 = f'<span class="l2">{sub}</span>' if sub else ""
    attrs = f' tabindex="0" data-drill="{E(drill)}"' if drill else ""
    c = cls + (" is-sel" if sel else "")
    tail = "" if narrow else f'<td class="n">{nn(aug)}</td><td class="n">{nn(py)}</td>'
    return (f'<tr class="{c}"{attrs}{" data-note=" + chr(34) + str(note) + chr(34) if note else ""}><td><span class="l1">{label}{nr}</span>{l2}</td>'
            f'<td class="n">{nn(act)}</td><td class="n">{nn(bud)}</td><td class="n">{dl(var)}</td>'
            f'<td class="n"><span class="dlt {"neg" if var < 0 else "pos" if var > 0 else ""}">{vp:.1f}%</span></td>{tail}</tr>')


def statement(narrow=False, sel_install_cogs=False):
    th_tail = "" if narrow else '<th>Aug 2026</th><th>Sep 2025</th>'
    cols = ('<colgroup><col><col style="width:104px"><col style="width:104px"><col style="width:96px"><col style="width:64px">'
            + ("" if narrow else '<col style="width:100px"><col style="width:100px">') + '</colgroup>')
    out = [f'<table class="lay" aria-label="Heartland September 2026 department P&amp;L against budget">{cols}<thead><tr><th>In US dollars</th>'
           f'<th>Sep 2026</th><th>Budget</th><th>Variance</th><th>%</th>{th_tail}</tr></thead><tbody>']
    for d in REV_DEPTS:
        r, g = d["rev"], d["gp"]
        cogs = tuple(r[i] - g[i] for i in range(4))
        out.append(f'<tr class="grp"><td colspan="{5 if narrow else 7}">{E(d["name"])} · {E(d["owner"])}</td></tr>')
        out.append(row("Revenue", "", *r, drill=f'{d["name"]} revenue', narrow=narrow))
        is_inst = d["k"] == "install"
        out.append(row("Cost of revenue", "Flexed to actual volume: (10,410)" if is_inst else "", *cogs, cost=True,
                       note=2 if is_inst else None, drill=f'{d["name"]} cost of revenue', sel=is_inst and sel_install_cogs, narrow=narrow))
        gm, gmb = g[0] / r[0] * 100, g[1] / r[1] * 100
        out.append(row("Gross profit", f"GM {gm:.1f}% · budget {gmb:.1f}%", *g, cls="sub", narrow=narrow))
    out.append(f'<tr class="grp"><td colspan="{5 if narrow else 7}">All revenue departments</td></tr>')
    out.append(row("Revenue", "", *[REV[c] for c in ("act", "bud", "aug", "py")], cls="sub", narrow=narrow))
    out.append(row("Gross profit", f'GM {GP["act"] / REV["act"] * 100:.1f}% · budget {GP["bud"] / REV["bud"] * 100:.1f}%',
                   *[GP[c] for c in ("act", "bud", "aug", "py")], cls="sub", narrow=narrow))
    out.append(f'<tr class="grp"><td colspan="{5 if narrow else 7}">Overhead departments</td></tr>')
    for d in OH_DEPTS:
        out.append(row(E(d["name"]), E(d["owner"]), *d["spend"], cost=True, note=3 if d["k"] == "sm" else None, drill=d["name"], narrow=narrow))
    out.append(row("Total overhead", "", *[OH[c] for c in ("act", "bud", "aug", "py")], cost=True, cls="sub", narrow=narrow))
    out.append(row("EBITDA", f'{EB["act"] / REV["act"] * 100:.1f}% of revenue · budget {EB["bud"] / REV["bud"] * 100:.1f}%',
                   *[EB[c] for c in ("act", "bud", "aug", "py")], cls="tot", note=1, narrow=narrow))
    out.append("</tbody></table>")
    return "".join(out)


def figs():
    def fig(l, v, vs, link):
        return f'<div class="fig"><span class="fig-l">{l}</span><span class="fig-v tnum">{v}</span><span class="fig-vs">{vs}</span><a class="link" href="#">{link}</a></div>'
    gm, gmb, gma = GP["act"] / REV["act"] * 100, GP["bud"] / REV["bud"] * 100, GP["aug"] / REV["aug"] * 100
    return ('<div class="figs r2-figs">'
            + fig("Revenue", f0(REV["act"]), f'<span>budget <b>{f0(REV["bud"])}</b></span><span class="neg">{f0(REV["act"] - REV["bud"])}</span>', "Revenue by stream")
            + fig("Gross margin", pct(gm), f'<span>budget <b>{pct(gmb)}</b></span><span>Aug <b>{pct(gma)}</b></span>', "Margin by department")
            + fig("Overhead", f0(OH["act"]), f'<span>budget <b>{f0(OH["bud"])}</b></span><span class="neg">{f0(OH["bud"] - OH["act"])}</span>', "Overhead detail")
            + fig("EBITDA", f0(EB["act"]), f'<span>budget <b>{f0(EB["bud"])}</b></span><span class="neg">{f0(EB["act"] - EB["bud"])}</span>', "EBITDA trend")
            + '</div>')


LABELS = [("Budget", "EBITDA"), ("Volume", ""), ("Install", "margin"), ("Service", "margin"), ("Agreements", "margin"),
          ("Sales &", "marketing"), ("Admin &", "office"), ("Executive", ""), ("Actual", "EBITDA")]


def the_bridge(w=768):
    return bridge(("Budget EBITDA", EB["bud"]), [(l, v) for l, v, _ in BRIDGE], ("Actual EBITDA", EB["act"]), LABELS, w=w, h=300,
                  notes={2: 2, 5: 3, 8: 1}, title="EBITDA bridge, September budget to actual")


# install flexed effects (note 2 and the drill)
FLEX = REV_DEPTS[1]["rev"][0] / REV_DEPTS[1]["rev"][1]
EFF = []
for code, name, act, bud in INSTALL_COGS:
    fx = round(bud * FLEX)
    EFF.append((code, name, act, fx, fx - act))
_d = (REV_DEPTS[1]["rev"][0] - REV_DEPTS[1]["gp"][0]) - sum(e[2] for e in EFF)
INST_RATE = sum(e[4] for e in EFF)
assert abs(INST_RATE - (-10410)) <= 2, INST_RATE
# absorb rounding into equipment so the note ties exactly to the bridge
if INST_RATE != -10410:
    c, n_, a, fx, ef = EFF[0]
    EFF[0] = (c, n_, a, fx + (-10410 - INST_RATE), ef + (-10410 - INST_RATE))
assert sum(e[4] for e in EFF) == -10410
EQ_EFF = EFF[0][4]
EQ_SPLIT = (-22400, EQ_EFF + 22400)  # 14 June-sold jobs, the other 52 installs

SM = [("Google Local Services Ads", -9400), ("Home & Garden Show booth, Sep 18–20", -3400)]
assert sum(v for _, v in SM) == -(OH_DEPTS[0]["spend"][0] - OH_DEPTS[0]["spend"][1])


def notes():
    margin = sum(v for l, v, _ in BRIDGE if "margin" in l)
    ovh = sum(v for l, v, _ in BRIDGE if l in ("Sales & marketing", "Admin & office", "Executive"))
    vol = BRIDGE[0][1]
    assert margin + ovh + vol == EB["act"] - EB["bud"]
    return f"""<aside class="notes" aria-label="Commentary">
<div class="draft-h"><span class="eyebrow">Commentary · September</span></div><div class="draft-h"><span class="row"><span class="tag tag--ai">Draft · not reviewed</span></span>{btn("Mark reviewed", "", "", "check")}</div>
<article class="note" data-note="1" id="r2n1"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">EBITDA</div><div class="note-title">September EBITDA was {f0(EB["act"])}, {f0(EB["bud"] - EB["act"])} under budget</div></div></div>
<p>Overhead ran over in three departments and install margin slipped. Volume was close to plan: revenue {f0(REV["act"] - REV["bud"])} under, 1.7%.</p>
<ul class="ev"><li>Overhead over budget<span class="dl"></span><span class="v">{f0(ovh)}</span></li><li>Margin, three departments<span class="dl"></span><span class="v">{f0(margin)}</span></li>
<li>Volume at budget margins<span class="dl"></span><span class="v">{f0(vol)}</span></li><li class="ev-total">EBITDA vs budget<span class="dl"></span><span class="v">{f0(EB["act"] - EB["bud"])}</span></li></ul>
<div class="basis"><span>Basis: <b>posted ledger, September final</b></span><span>Figures computed; AI wrote the words</span></div></article>
<article class="note" data-note="2" id="r2n2"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">Install margin</div><div class="note-title">Equipment cost {f0(-EQ_EFF)} over plan, mostly on 14 installs sold in June</div></div></div>
<p>They were quoted on Carrier’s June price list and installed after the July 1 increase. Subcontract came in under because duct work moved in-house.</p>
<ul class="ev"><li>Equipment · 14 jobs sold before Jul 1<span class="dl"></span><span class="v">{f0(EQ_SPLIT[0])}</span></li><li>Equipment · 52 other installs<span class="dl"></span><span class="v">{f0(EQ_SPLIT[1])}</span></li>
<li>Subcontract, labor, materials<span class="dl"></span><span class="v">{nn(sum(e[4] for e in EFF[1:]))}</span></li><li class="ev-total">Install margin vs budget<span class="dl"></span><span class="v">{f0(-10410)}</span></li></ul>
<div class="note-acts">{btn("Open the 14 jobs", "quiet", "", "right")}{btn("Ask Brent", "quiet", "", "ask")}</div></article>
<article class="note" data-note="3" id="r2n3"><div class="note-top"><span class="note-no">3</span><div><div class="note-kind">Sales &amp; marketing</div><div class="note-title">Spend {f0(-sum(v for _, v in SM))} over; leads up 22%, booked calls flat</div></div></div>
<ul class="ev">{"".join(f'<li>{E(l)}<span class="dl"></span><span class="v">{f0(v)}</span></li>' for l, v in SM)}<li class="ev-total">Over budget<span class="dl"></span><span class="v">{f0(sum(v for _, v in SM))}</span></li></ul>
<div class="note-acts">{btn("Ask Jill", "quiet", "", "ask")}</div></article>
</aside>"""


def drill_panel():
    rows = "".join(f'<tr><td><span class="code">{c}</span>{E(n)}</td><td>{nn(a)}</td><td>{nn(fx)}</td><td>{dl(ef)}</td></tr>' for c, n, a, fx, ef in EFF)
    ta, tf = sum(e[2] for e in EFF), sum(e[3] for e in EFF)
    rows += f'<tr class="t"><td>Install cost of revenue</td><td>{nn(ta)}</td><td>{nn(tf)}</td><td>{dl(tf - ta)}</td></tr>'
    ENT = [("Sep 4", "Carrier Enterprise", "Bill 88231 · 6 jobs", 96420), ("Sep 11", "Carrier Enterprise", "Bill 88412 · 5 jobs", 81770),
           ("Sep 22", "Carrier Enterprise", "Bill 88690 · 4 jobs", 61180), ("Sep 18", "Johnstone Supply", "Bill J-55120 · 4 jobs", 52300),
           ("Sep 25", "Ferguson Enterprises", "Bill F-20915 · 3 jobs", 34615)]
    rest = INSTALL_COGS[0][2] - sum(e[3] for e in ENT)
    ent = "".join(f'<tr><td><span class="l1">{E(v)}</span><span class="l2">{d} · {E(r)}</span></td><td>{nn(a)}</td></tr>' for d, v, r, a in ENT)
    ent += f'<tr><td><span class="l1 ink-2">31 more entries</span></td><td>{nn(rest)}</td></tr><tr class="t"><td>5100 Equipment</td><td>{nn(INSTALL_COGS[0][2])}</td></tr>'
    return f"""<aside class="panel drill" aria-label="Drill: Install cost of revenue">
<div class="panel-head"><div class="eyebrow">Drill<span class="sl">//</span>Install · cost of revenue</div>
<div class="t-head" style="margin-top:4px">{f0(ta)} against a flexed budget of {f0(tf)}</div>
<p class="t-cap" style="margin-top:4px">Flexed budget = budget cost rates × actual install revenue ({f0(REV_DEPTS[1]["rev"][0])}). Effect on EBITDA: favourable positive.</p></div>
<div class="panel-body">
<div class="panel-sec"><div class="panel-sec-h"><h3>By account</h3><span class="t-cap">September</span></div>
<table class="dtab"><colgroup><col><col style="width:84px"><col style="width:84px"><col style="width:76px"></colgroup><thead><tr><th>Account</th><th>Actual</th><th>Flexed</th><th>Effect</th></tr></thead><tbody>{rows}</tbody></table></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Largest entries · 5100</h3><span class="t-cap">36 entries</span></div>
<table class="dtab"><colgroup><col><col style="width:96px"></colgroup><tbody>{ent}</tbody></table></div>
<div class="panel-sec"><article class="note note--panel"><div class="note-kind">Explain this variance</div>
<div class="note-title">14 June-sold installs carried {f0(-EQ_SPLIT[0])} of the equipment overrun</div>
<ul class="ev"><li>Quoted on June price list<span class="dl"></span><span class="v">191,900</span></li><li>Billed at July price list<span class="dl"></span><span class="v">214,300</span></li>
<li class="ev-total">Overrun, 14 jobs<span class="dl"></span><span class="v">{f0(EQ_SPLIT[0])}</span></li></ul>
<div class="basis"><span>Basis: <b>job cost lines × Carrier price lists</b></span><span>Computed; AI wrote the words</span></div></article></div>
</div>
<div class="panel-foot">{btn("Ask Brent", "", "", "ask")}{btn("GL detail", "quiet", "", "list")}<span class="sp"></span>{btn("Add to commentary", "primary")}</div></aside>"""


def head_row(sel="Budget"):
    seg = "".join(f'<button type="button" aria-pressed="{"true" if s == sel else "false"}">{s}</button>' for s in ["Budget", "August", "Sep 2025", "YTD"])
    return (f'<div class="page-head"><div><div class="eyebrow">Reports<span class="sl">//</span>What moved, and why<span class="sl">//</span>MG-01</div>'
            f'<h1 class="t-title" style="margin-top:4px">Monthly management report</h1></div>'
            f'<div class="btn-row"><span class="cmp"><span class="t-cap">Variance against</span><div class="seg" role="group" aria-label="Variance against">{seg}</div></span>'
            f'{btn("Export", "", "", "download")}{btn("Add to pack", "primary", "", "plus")}</div></div>')


def frame_main():
    left = (f'{figs()}<div class="sec-h"><span class="t-head">EBITDA, budget to actual</span>'
            f'<div class="lgd"><span><i class="anc"></i>EBITDA</span><span><i class="fav"></i>Favourable</span><span><i class="unf"></i>Unfavourable</span></div></div>'
            f'{the_bridge()}<p class="t-cap" style="margin-top:4px">Steps sum to {f0(EB["act"] - EB["bud"])}. Volume is revenue variance at budget margins; margin steps are the rest of each department’s gross-profit variance. Select a step to drill.</p>'
            f'<div class="sec-h"><span class="t-head">Department P&amp;L</span><span class="t-cap">Variance is the effect on EBITDA: favourable positive, unfavourable in parentheses</span></div>{statement()}'
            f'<p class="t-cap" style="margin-top:12px">Totals tie to the posted ledger for September (final, closed Oct 14). Departments as posted; nothing is allocated.</p>')
    page = f'<div class="page r2">{head_row()}<div class="two"><div>{left}</div>{notes()}</div></div>'
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "September 2026 · final", "<b>EBITDA " + f0(EB["act"] - EB["bud"]) + " vs budget</b>"],
                   btn("Schedule", "quiet", "", "clock"))
    return app("client", "density-report", h_rail("Reports"), h_bar("Reports / <b>Monthly management report</b>"), main + page, 1990, live=True)


def frame_drill():
    left = (f'<div class="inline-notice inline-notice--info" style="margin-bottom:16px">{ico("info")}<span><b>Install · cost of revenue</b> is open in the panel. August and Sep 2025 columns are hidden while it’s open.</span></div>'
            f'{statement(narrow=True, sel_install_cogs=True)}')
    page = f'<div class="page r2">{head_row()}<div style="display:grid;grid-template-columns:minmax(0,1fr) 440px;column-gap:24px;align-items:start"><div>{left}</div>{drill_panel()}</div></div>'
    main = ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "September 2026 · final", "<b>Drill: Install cost of revenue</b>"])
    return app("client", "density-report", h_rail("Reports"), h_bar("Management report / <b>Install cost of revenue</b>"), main + page, 1330)


def build():
    html = head("R2 · Report view", CSS) + sheet_top("R2-report-view.html") + '<main id="main" class="sheet">'
    html += board_h("R2", "FPB-reports-fpna §1.2 MG-01 · §2 bridge · §3 A3, A5 · IA §3.6.1 Reports",
                    "Heartland’s September, explained before anyone asks",
                    "The flagship management report: one page that says what EBITDA was, the bridge from budget, every department’s numbers "
                    "against budget, last month and last year, and draft commentary whose every figure is computed and shown. "
                    "Any line or bridge step drills to the accounts, the entries and the jobs behind it.")
    html += pair_h("1 · The report", "Planning &amp; reports · Reports · MG-01. Report density. The commentary is a draft until someone marks it reviewed.")
    html += frame(frame_main(), "Populated state · September final · commentary drafted by AI from computed causes",
                  f"Ties: budget {f0(EB['bud'])} + bridge {f0(EB['act'] - EB['bud'])} = actual {f0(EB['act'])}; departments sum to the totals")
    html += anno([("The bridge is the headline", "Budget and actual are Midnight anchors; favourable steps are Electric; unfavourable steps wear the brick slash. Each step is focusable and drills."),
                  ("Variance means effect on profit", "Cost lines flip sign so every variance reads the same way: positive helps EBITDA, parentheses hurt it. F/U never relies on colour alone."),
                  ("Commentary is a ledger, not prose", "Each note states a claim, lists evidence that sums to it, names its basis, and offers the next action. It stays a draft until reviewed."),
                  ("Department owners are named", "Each section carries its owner, so “Ask Brent” sends a request to the person who can answer, attached to the line.")])
    html += pair_h("2 · Drill: explain this variance", "Selecting Install · Cost of revenue opens the drill: accounts against a flexed budget, the largest entries, and the cause.")
    html += frame(frame_drill(), "Drill state · flexed budget isolates rate from volume",
                  f"Ties: account effects sum to {f0(-10410)}, the Install margin step; entries sum to 5100 Equipment {f0(INSTALL_COGS[0][2])}")
    html += anno([("Flexed, not static", "Comparing cost to a budget flexed to actual revenue separates “we sold less” from “it cost more to deliver”. That’s the difference between the volume and margin steps."),
                  ("Down to the bill", "Accounts → entries → bill → job. The bill opens in its own drawer with the source PDF; nothing leaves the ledger."),
                  ("Explain this variance", "The cause comes from job cost lines matched to vendor price lists. The words are AI; the numbers and the matching are deterministic."),
                  ("Columns make room", "With the panel open, the comparison columns fold away instead of squeezing every figure.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../R2-report-view.html", "w").write(build())
    print("ok R2", EFF, EQ_SPLIT)
