"""S26 (per the brief; not numbered in IA-SPEC §8) — Revenue recognition run (IA-SPEC 3.6.1 Revenue recognition tabs,
4.7 rr.recognition, 6.2 rev rec loop, 04 REV-01..09). Iowa Custom Cabinets, September 2026, reviewed Fri Oct 2."""
from fo_common import *
from data import BY

CSS = """
/* S26 layout only */
.pad{padding:0 var(--margin)}
.meth{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--line);background:var(--white)}
.meth>div{padding:12px 16px;border-right:1px solid var(--line);min-width:0}
.meth>div:last-child{border-right:0;background:var(--canvas)}
.meth .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.meth .t-cap{display:block}
.meth .out{color:var(--ink-3)}
.rr td.n{font-weight:500}
.rr .pc{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.rr .pc .meter{padding:0}
.rr tr.q-sub td{background:var(--canvas);font-weight:600;height:40px}
.rr tr.q-grand td{background:var(--white);font-weight:700;height:48px;border-top:1px solid var(--midnight);border-bottom:3px double var(--electric)}
.rr .hp{visibility:hidden}
.mtag{display:inline-flex;align-items:center;height:20px;padding:0 6px;font:600 12px/20px var(--f-text);background:var(--grey-100);color:var(--ink-2);white-space:nowrap}
.mtag.ov{background:var(--sky);color:var(--electric)}
.below{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:32px;padding:24px var(--margin) 32px}
.tbl-fs.je td{height:32px}
.chain{list-style:none}
.chain li{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:8px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}
.chain .cno{font:700 15px/24px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric)}
.chain li.is-done .cno{color:var(--ink-2);-webkit-text-stroke:0}
.chain li.is-cur .cno{color:var(--electric);-webkit-text-stroke:0}
.chain .cl{font-weight:600}
.chain .cd{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
.chain .cs{font-size:12px;line-height:24px;color:var(--ink-2);white-space:nowrap}
.two{display:grid;grid-template-columns:minmax(0,1fr) 400px;column-gap:32px}
.notes .note{padding-bottom:16px}
.wf{display:grid;grid-template-columns:repeat(12,1fr);gap:6px;align-items:end;height:120px;border-bottom:1px solid var(--midnight);margin-top:12px}
.wf div{display:flex;flex-direction:column;justify-content:flex-end;height:100%}
.wf i{display:block}
.wf i.w{background:var(--steel)} .wf i.j{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--blue-200) 3px 6px)}
.wf-ax{display:grid;grid-template-columns:repeat(12,1fr);gap:6px;margin-top:6px;font-size:12px;line-height:16px;color:var(--ink-3);text-align:center}
.wgs{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:136px;gap:24px;margin-top:24px}
"""

ICC = BY["icc"]
# POC jobs: id, customer, contract, eac_aug, ctd_aug, billed_aug, eac_sep, ctd_sep, billed_sep, method source
JOBS = [
    ("J-2611", "Hubbell Homes · Grimes Crossing, 24 homes", 612000, 428400, 214200, 330000, 428400, 301800, 440000, "type"),
    ("J-2604", "Jerry’s Homes · Waukee Ridge, 18 homes", 448500, 318400, 206960, 300000, 318400, 274000, 400000, "type"),
    ("J-2598", "Kading Properties · Ankeny Flats, 96 units", 1184000, 804250, 563000, 820000, 852500, 703300, 940000, "type"),
    ("J-2619", "Ruby Hill Builders · Norwalk, 9 homes", 286000, 205900, 20590, 0, 205900, 61770, 85800, "type"),
    ("J-2622", "Hubbell Homes · Prairie Trail, 8 homes", 214800, 150400, 0, 0, 150400, 15040, 0, "type"),
    ("J-2588", "Artistry Homes · Lot 14, Waukee", 96000, 67200, 53760, 72000, 67200, 67200, 96000, "job"),
]
for j in JOBS:
    pass
POC = []
for jid, cust, K, ea, ca, ba, es, cs, bs, src in JOBS:
    e_aug = round(K * ca / ea, 2)
    e_sep = round(K * cs / es, 2)
    POC.append(dict(id=jid, cust=cust, K=K, eac=es, ctd=cs, pct=cs / es * 100, etd=e_sep, prior=e_aug, this=round(e_sep - e_aug, 2),
                    ob=round(bs - e_sep, 2), ob_aug=round(ba - e_aug, 2), dB=bs - ba, src=src, eac_aug=ea, ctd_aug=ca))
MORE = dict(n=9, this=640000.00, ob=18400.00 - 9600.00, over=18400.00, under=9600.00, over_aug=12100.00, under_aug=7300.00, dB=644000.00)
assert MORE["dB"] - MORE["this"] == (MORE["over"] - MORE["under"]) - (MORE["over_aug"] - MORE["under_aug"])
MIL = [("J-2615", "Thompson kitchen, Johnston", 48600, "Delivery · 50%", 24300.00, 24300.00, "Sep 22"),
       ("J-2617", "Nguyen remodel, Clive", 36200, "Design approved · 20%", 7240.00, 7240.00, "Sep 9"),
       ("J-2609", "Carlson kitchen and bath, Urbandale", 62000, "Install complete · 30%", 18600.00, 0.00, "Sep 28")]
WAR = dict(open=128600.00, sold=14200.00, rec=11840.00, plans=412)
WAR["close"] = WAR["open"] + WAR["sold"] - WAR["rec"]

R_POC = round(sum(p["this"] for p in POC) + MORE["this"], 2)
R_MIL = round(sum(m[4] for m in MIL), 2)
R_RUN = round(R_POC + R_MIL + WAR["rec"], 2)
AS_BILLED = 38410.00
POS = round(ICC["rev"] - R_RUN - AS_BILLED, 2)
assert 40000 < POS < 120000, POS
assert abs(R_RUN + AS_BILLED + POS - ICC["rev"]) < .005

# presented contract balances
def split(vals):
    return round(sum(v for v in vals if v > 0), 2), round(-sum(v for v in vals if v < 0), 2)
OVER_SEP, UNDER_SEP = split([p["ob"] for p in POC])
OVER_SEP = round(OVER_SEP + MORE["over"], 2); UNDER_SEP = round(UNDER_SEP + MORE["under"] + sum(m[4] - m[5] for m in MIL), 2)
OVER_AUG, UNDER_AUG = split([p["ob_aug"] for p in POC])
OVER_AUG = round(OVER_AUG + MORE["over_aug"], 2); UNDER_AUG = round(UNDER_AUG + MORE["under_aug"], 2)
D_OPEN = round(OVER_AUG + WAR["open"], 2)
D_CLOSE = round(OVER_SEP + WAR["close"], 2)
BILLED = round(sum(p["dB"] for p in POC) + MORE["dB"] + sum(m[5] for m in MIL) + WAR["sold"], 2)
assert abs(D_OPEN - UNDER_AUG + BILLED - R_RUN + UNDER_SEP - D_CLOSE) < .005, (D_OPEN, UNDER_AUG, BILLED, R_RUN, UNDER_SEP, D_CLOSE)

KAD = POC[2]
KAD_AT_NEW = round(KAD["K"] * KAD["ctd_aug"] / KAD["eac"], 2)
KAD_CATCH = round(KAD_AT_NEW - KAD["prior"], 2)
ART_THIS = POC[5]["this"]


def nn(x):
    return f2(x) + (HP if x >= 0 else "")


def ob_cell(x):
    if abs(x) < .005:
        return f'<td class="n ink-3">—{HP}</td>'
    return f'<td class="n">{nn(x)}</td>'


def pmeter(p):
    on = int(p // 10)
    part = 1 if (p % 10) >= 5 and on < 10 else 0
    return meter(on, part, 10, label=f"{p:.1f}% complete")


def icc_rail(cur="Revenue recognition"):
    uses = {"Purchase orders", "Payroll", "Inventory", "Revenue recognition", "Jobs", "WIP", "Retainage", "Intercompany", "Customer deposits"}
    return rail(client_nav(uses, cur, {"Inbox": 4, "Revenue recognition": 1, "Close": "19/24"}), "Erin Vance", "Controller")


def rtabs(sel):
    out = '<div class="tabs" role="tablist" aria-label="Revenue recognition">'
    for t in ["Run", "Accrue unbilled", "Deferred roll-forward", "Waterfall", "By method"]:
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}</button>'
    return out + "</div>"


def head_block(sel, right):
    return (f'<div class="page-head" style="margin-bottom:0"><div><div class="eyebrow">Revenue &amp; jobs<span class="sl">//</span>Revenue recognition</div>'
            f'<h1 class="t-title" style="margin-top:4px">September run · Iowa Custom Cabinets</h1></div><div class="btn-row">{right}</div></div>{rtabs(sel)}')


# --------------------------------------------------------------- frame 1: the run
def run_frame():
    meth = f"""<div class="meth"><div><span class="eyebrow">% of costs incurred</span><span class="v">{f2(R_POC)}</span><span class="t-cap">15 builder contracts</span></div>
<div><span class="eyebrow">Milestone</span><span class="v">{f2(R_MIL)}</span><span class="t-cap">3 custom jobs</span></div>
<div><span class="eyebrow">Ratably</span><span class="v">{f2(WAR["rec"])}</span><span class="t-cap">{WAR["plans"]} warranty plans</span></div>
<div><span class="eyebrow">As billed</span><span class="v out">{f2(AS_BILLED)}</span><span class="t-cap">install calls · posts on invoice</span></div>
<div><span class="eyebrow">Point of sale</span><span class="v out">{f2(POS)}</span><span class="t-cap">showroom &amp; hardware</span></div>
<div><span class="eyebrow">September revenue</span><span class="v">{f2(ICC["rev"])}</span><span class="t-cap">this run {f2(R_RUN)}</span></div></div>"""
    rows = f'<tr class="q-group"><td colspan="9"><span class="q-group-t">% of costs incurred</span><span class="ink-3">cost to date from WIP ÷ estimate at completion × contract</span></td></tr>'
    for p in POC:
        mt = '<span class="mtag">Job type · builder</span>' if p["src"] == "type" else '<span class="mtag ov">Set on this job</span>'
        attn = " is-attn" if p["id"] == "J-2598" else ""
        cur = " is-cursor" if p["id"] == "J-2598" else ""
        rel = ' <span class="tag">Related</span>' if p["id"] == "J-2588" else ""
        eac_note = f'<span class="l2 warn">was {f0(KAD["eac_aug"])}</span>' if p["id"] == "J-2598" else '<span class="l2">EAC</span>'
        rows += (f'<tr class="q-row{attn}{cur}"><td><span class="l1"><span class="code">{p["id"]}</span>{E(p["cust"].split(" · ")[0])}{rel}</span><span class="l2">{E(p["cust"].split(" · ")[1])}</span></td>'
                 f'<td>{mt}</td><td class="n">{f0(p["K"])}</td><td class="n"><span class="l1">{f0(p["eac"])}</span>{eac_note}</td><td class="n">{f0(p["ctd"])}</td>'
                 f'<td class="n"><span class="pc">{pmeter(p["pct"])}<b class="tnum">{p["pct"]:.1f}%</b></span></td>'
                 f'<td class="n">{nn(p["etd"])}</td><td class="n b">{nn(p["this"])}</td>{ob_cell(p["ob"])}</tr>')
    rows += (f'<tr class="q-row"><td><span class="l1">9 more builder contracts</span><span class="l2">under 150,000 · no estimate changes</span></td><td><span class="mtag">Job type · builder</span></td>'
             f'<td colspan="5" class="ink-3">Show all 9</td><td class="n b">{nn(MORE["this"])}</td><td class="n">{nn(MORE["ob"])}</td></tr>')
    rows += f'<tr class="q-sub"><td colspan="7">% of costs incurred · 15 contracts</td><td class="n">{nn(R_POC)}</td><td></td></tr>'
    rows += f'<tr class="q-group"><td colspan="9"><span class="q-group-t">Milestone</span><span class="ink-3">design 20% · delivery 50% · install 30%</span></td></tr>'
    for jid, c, K, ms, rec, billed, d in MIL:
        ub = round(billed - rec, 2)
        rows += (f'<tr class="q-row"><td><span class="l1"><span class="code">{jid}</span>{c.split(",")[0]}</span><span class="l2">{c.split(", ")[1]} · contract {f0(K)}</span></td>'
                 f'<td><span class="mtag">Job type · custom</span></td><td colspan="5"><span class="l1">{ms}</span><span class="l2">reached {d}{" · invoice drafted Oct 2" if billed == 0 else " · billed"}</span></td>'
                 f'<td class="n b">{nn(rec)}</td>{ob_cell(ub)}</tr>')
    rows += f'<tr class="q-sub"><td colspan="7">Milestone · 3 jobs</td><td class="n">{nn(R_MIL)}</td><td></td></tr>'
    rows += f'<tr class="q-group"><td colspan="9"><span class="q-group-t">Ratably</span><span class="ink-3">12-month warranty and service plans</span></td></tr>'
    rows += (f'<tr class="q-row"><td><span class="l1">Warranty plans</span><span class="l2">{WAR["plans"]} active · 1/12 of each plan a month</span></td><td><span class="mtag">Revenue type</span></td>'
             f'<td colspan="5" class="ink-3">From deferred revenue 2410 · {f0(WAR["sold"])} sold in September</td><td class="n b">{nn(WAR["rec"])}</td><td></td></tr>')
    rows += f'<tr class="q-grand"><td colspan="7">Recognized in this run</td><td class="n">{nn(R_RUN)}</td><td></td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact rr" aria-label="September recognition by job">'
             f'<colgroup><col style="width:272px"><col style="width:128px"><col style="width:88px"><col style="width:104px"><col style="width:88px"><col style="width:136px"><col style="width:104px"><col style="width:112px"><col style="width:112px"></colgroup>'
             f'<thead><tr><th>Job · customer</th><th>Method from</th><th class="n">Contract</th><th class="n">Estimate</th><th class="n">Cost</th><th class="n">Complete</th><th class="n">Earned</th><th class="n">This period</th><th class="n">Over / (under)</th></tr></thead><tbody>{rows}</tbody></table>')
    je = f"""<table class="tbl tbl-fs je" aria-label="Entries this run posts"><colgroup><col><col style="width:128px"><col style="width:128px"></colgroup>
<thead><tr><th>Entries · dated Sep 30</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
<tr class="fs-head"><td colspan="3">Recognition</td></tr>
<tr class="fs-line"><td><span class="code">2410</span>Deferred revenue</td><td class="n">{nn(R_RUN)}</td><td class="n"></td></tr>
<tr class="fs-line"><td><span class="code">4110</span>Revenue · builder contracts</td><td class="n"></td><td class="n">{nn(R_POC)}</td></tr>
<tr class="fs-line"><td><span class="code">4120</span>Revenue · custom residential</td><td class="n"></td><td class="n">{nn(R_MIL)}</td></tr>
<tr class="fs-line"><td><span class="code">4150</span>Revenue · warranty plans</td><td class="n"></td><td class="n">{nn(WAR["rec"])}</td></tr>
<tr class="fs-head"><td colspan="3">Unbilled accrual · reverses Oct 1</td></tr>
<tr class="fs-line"><td><span class="code">1180</span>Unbilled receivables</td><td class="n">{nn(UNDER_SEP)}</td><td class="n"></td></tr>
<tr class="fs-line"><td><span class="code">2410</span>Deferred revenue</td><td class="n"></td><td class="n">{nn(UNDER_SEP)}</td></tr>
<tr class="fs-grand"><td>Balanced</td><td class="n">{nn(R_RUN + UNDER_SEP)}</td><td class="n">{nn(R_POC + R_MIL + WAR["rec"] + UNDER_SEP)}</td></tr></tbody></table>"""
    assert abs(R_RUN + UNDER_SEP - (R_POC + R_MIL + WAR["rec"] + UNDER_SEP)) < .005
    chain = f"""<ol class="chain" aria-label="Run steps"><li class="is-done"><span class="cno">1</span><span><span class="cl">Proposed · scheduler</span><span class="cd">Thu Oct 1, 2:00 AM · revrec.monthly</span></span><span class="cs">Done</span></li>
<li class="is-done"><span class="cno">2</span><span><span class="cl">Reviewed · Luis Ortiz, preparer</span><span class="cd">Thu Oct 1, 3:40 PM · checked WIP to the job ledger</span></span><span class="cs">Done</span></li>
<li class="is-cur"><span class="cno">3</span><span><span class="cl">Post · Erin Vance, controller</span><span class="cd">Needs revrec.runs:post · not the preparer</span></span><span class="cs">You</span></li></ol>"""
    side = f"""<div><div class="row row--between"><span class="t-head">Review &amp; post</span>{status("track", "Waiting on you")}</div>{chain}
<div class="inline-notice inline-notice--warn" style="margin-top:16px">{ico("alert")}<span><b>One estimate changed.</b> Kading’s cumulative catch-up is in this period. Read note 1 before posting.</span></div>
<div class="btn-row" style="margin-top:16px">{btn("Post September run", "primary", "", "", 'data-say="Posted September run"')}{btn("Return to Luis…")}</div>
<p class="t-cap" style="margin-top:8px">Posting locks this run. A later change to an estimate flows through next month as a catch-up, never by editing September.</p></div>"""
    below = f'<div class="below"><div>{je}</div>{side}</div>'
    page = (f'<div class="page" style="padding-bottom:0">{head_block("Run", btn("Rerun preview", "", "", "repeat"))}<div style="margin-top:24px">{meth}</div></div>'
            f'<div style="margin-top:16px">{table}</div>{below}')
    main = ctxline(["Fri Oct 2", "Iowa Custom Cabinets", "September close · due Oct 13", "Run proposed Oct 1 · reviewed", "<b>Ready to post · " + f2(R_RUN) + "</b>"]) + page
    return app("client", "density-cockpit", icc_rail(), bar(ctx_client("Iowa Custom Cabinets", "C-108"), "Revenue recognition / <b>Run</b>", cmd="Jump to job, contract, account…", sync="Synced 8:14 AM"),
               main, 1500, live=True)


# --------------------------------------------------------------- frame 2: roll-forward + notes
def roll_frame():
    def L(lbl, v, cls="fs-line", note=""):
        nt = f'<a class="nref" data-note="{note}" href="#rn{note}">{note}</a>' if note else ""
        return f'<tr class="{cls}"><td>{lbl}</td><td class="nt">{nt}</td><td class="n cur">{nn(v)}</td></tr>'
    dr = '<tr class="fs-head"><td colspan="3">Deferred revenue · 2410, as presented</td></tr>'
    dr += L("Opening, Aug 31", D_OPEN)
    dr += L("Billed on recognition-managed jobs and plans", BILLED)
    dr += L("Recognized in the September run", -R_RUN, note="1")
    dr += L("Reverse August unbilled accrual, Sep 1", -UNDER_AUG)
    dr += L("September unbilled accrual", UNDER_SEP, note="2")
    dr += f'<tr class="fs-grand"><td>Closing, Sep 30</td><td class="nt"></td><td class="n cur">{nn(D_CLOSE)}</td></tr>'
    dr += '<tr class="fs-gap"><td colspan="3"></td></tr>'
    dr += L("of which billings in excess of earnings", OVER_SEP, "fs-elim")
    dr += L("of which warranty plans not yet earned", WAR["close"], "fs-elim")
    dr += '<tr class="fs-head"><td colspan="3">Unbilled receivables · 1180</td></tr>'
    dr += L("Opening, Aug 31", UNDER_AUG)
    dr += L("Reversed Sep 1", -UNDER_AUG)
    dr += L("Accrued Sep 30 · earnings in excess of billings", UNDER_SEP, note="2")
    dr += f'<tr class="fs-grand"><td>Closing, Sep 30</td><td class="nt"></td><td class="n cur">{nn(UNDER_SEP)}</td></tr>'
    assert abs(OVER_SEP + WAR["close"] - D_CLOSE) < .005
    table = (f'<table class="tbl tbl-fs" aria-label="Deferred and unbilled roll-forward"><colgroup><col><col style="width:40px"><col style="width:160px"></colgroup>'
             f'<thead><tr><th>In US dollars</th><th class="nt">Note</th><th class="n cur">Sep 2026</th></tr></thead><tbody>{dr}</tbody></table>')
    # waterfall: deferred release, next 12 months (warranty only, simple straight-line)
    wf = ""
    rel = [round(WAR["close"] * w, 2) for w in (.095, .093, .092, .09, .088, .086, .084, .082, .08, .076, .07, .064)]
    rel[-1] = round(WAR["close"] - sum(rel[:-1]), 2)
    jobs_rel = [OVER_SEP * .55, OVER_SEP * .3, OVER_SEP * .15] + [0] * 9
    mx = max(r + j for r, j in zip(rel, jobs_rel))
    for r, j in zip(rel, jobs_rel):
        wf += f'<div><i class="j" style="height:{j / mx * 100:.1f}%"></i><i class="w" style="height:{r / mx * 100:.1f}%"></i></div>'
    ax = "".join(f"<span>{m}</span>" for m in ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"])
    notes = f"""<aside class="notes" aria-label="Notes"><div class="notes-head"><span class="eyebrow">Notes to the run</span><span class="t-cap">computed · AI only words them</span></div>
<article class="note" data-note="1" id="rn1"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Estimate change</div><div class="note-title">Kading’s estimate rose 6%, so September carries a catch-up</div></div></div>
<p>Estimate at completion went from {f0(KAD["eac_aug"])} to {f0(KAD["eac"])} after the August lumber reprice. Earlier months are recomputed at the new estimate and the difference lands now.</p>
<ul class="ev"><li>Earned this month at the new estimate<span class="dl"></span><span class="v">{f2(KAD["etd"] - KAD_AT_NEW)}</span></li><li>Catch-up on work through August<span class="dl"></span><span class="v">{f2(KAD_CATCH)}</span></li>
<li class="ev-total">Kading, this period<span class="dl"></span><span class="v">{f2(KAD["this"])}</span></li></ul>
<div class="basis"><span>True-up: <b>cumulative catch-up</b>, client policy</span><span>EC-6 and EC-12 clear</span></div></article>
<article class="note" data-note="2" id="rn2"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">Unbilled</div><div class="note-title">Earned but not yet billed, {f0(UNDER_SEP)}</div></div></div>
<p>Kading, Prairie Trail and Carlson are ahead of their billing. Carlson’s install finished Sep 28; its invoice was drafted Oct 2.</p></article>
<article class="note" data-note="3"><div class="note-top"><span class="note-no">3</span><div><div class="note-kind">Related client</div><div class="note-title">Artistry Lot 14 eliminates in the group</div></div></div>
<p>Artistry Homes is a Merit client, so {f2(ART_THIS)} of this run is intercompany in Merit Management Group — Consolidated. It stays as revenue in ICC’s own books.</p></article></aside>"""
    assert abs((KAD["etd"] - KAD_AT_NEW) + KAD_CATCH - KAD["this"]) < .01
    page = (f'<div class="page">{head_block("Deferred roll-forward", btn("Export", "", "", "download"))}<div class="two" style="margin-top:24px"><div>{table}'
            f'<div style="margin-top:32px"><div class="row row--between"><span class="t-head">When deferred revenue is earned · next 12 months</span><span class="t-cap">steel = warranty plans · hatched = billings ahead of work</span></div>'
            f'<div class="wf" role="img" aria-label="Deferred revenue release by month, Oct to Sep">{wf}</div><div class="wf-ax">{ax}</div></div></div>{notes}</div></div>')
    main = ctxline(["Fri Oct 2", "Iowa Custom Cabinets", "Deferred roll-forward · Sep 30", f"<b>Closing deferred {f0(D_CLOSE)} · unbilled {f0(UNDER_SEP)}</b>"]) + page
    return app("client", "density-report", icc_rail(), bar(ctx_client("Iowa Custom Cabinets", "C-108"), "Revenue recognition / <b>Deferred roll-forward</b>", cmd="Jump to job, contract, account…", sync="Synced 8:14 AM"), main, 1180)


# --------------------------------------------------------------- frame 3: method resolution + widgets
def trace_block():
    return f"""<div class="two" style="margin-top:24px"><div><span class="eyebrow">How J-2598’s method was chosen</span><ol class="trace" style="margin-top:8px">
<li><span class="tno">1</span><span><span class="tl">Set on the job</span><span class="td">No override on J-2598</span></span><span class="tv tv--skip">Not set</span></li>
<li class="is-decider is-allow"><span class="tno">2</span><span><span class="tl">Job type · Builder contract</span><span class="td">Rule from Client settings · Revenue policy, set Mar 2025 by Erin Vance</span></span><span class="tv tv--pass">% of costs incurred</span></li>
<li><span class="tno">3</span><span><span class="tl">Revenue type</span><span class="td">Cabinet packages</span></span><span class="tv tv--skip">Not reached</span></li>
<li><span class="tno">4</span><span><span class="tl">Company default</span><span class="td">Iowa Custom Cabinets · point of sale</span></span><span class="tv tv--skip">Not reached</span></li></ol>
<p class="t-cap" style="margin-top:8px">Nine methods are available: point of sale, as billed, % of costs incurred, % complete, completed contract, milestone, ratably, subscription, cash. The first rule that applies decides.</p></div>
<div>{rr_widgets()}</div></div>"""


def rr_widgets():
    open_ = f"""<div class="wg-body--pad"><div class="row row--between"><span class="l1">Iowa Custom Cabinets</span><span class="b tnum">{f2(R_RUN)}</span></div><span class="l2">Proposed Oct 1 · reviewed by Luis Ortiz · 1 estimate changed</span>
<div class="row row--between" style="margin-top:12px"><span class="l1">Heartland Heating &amp; Cooling</span><span class="b tnum">{f2(412880.00)}</span></div><span class="l2">Proposed Oct 1 · waiting on Sam Kovac’s review</span></div>"""
    w1 = f'<section class="wg" style="height:296px" aria-labelledby="w-rr1" data-widget="rr.recognition"><div class="wg-head"><h3 class="wg-title" id="w-rr1">Revenue to recognize</h3><span class="wg-count">2</span><span class="wg-meta">Fri Oct 2</span></div><div class="wg-body">{open_}</div><div class="wg-foot"><span>5 clients use rev rec</span>{btn("Review &amp; post", "primary")}</div></section>'
    done = f'<div class="wg-state"><span class="wg-done-mark">{ico("check")}</span><p class="t-head">September recognized · posted Oct 3.</p><p>All 5 clients. October runs Sun Nov 1 at 2:00 AM.</p></div>'
    w2 = f'<section class="wg" style="height:232px;margin-top:24px" aria-labelledby="w-rr2" data-widget="rr.recognition"><div class="wg-head"><h3 class="wg-title" id="w-rr2">Revenue to recognize</h3><span class="wg-meta">Done · as on S6c, Oct 19</span></div><div class="wg-body">{done}</div><div class="wg-foot"><span>revrec.monthly ran Oct 1, 2:00 AM</span></div></section>'
    return f'<div class="density-cockpit">{w1}{w2}</div>'


def build():
    html = head("S26 · Revenue recognition run", CSS) + sheet_top("S26-rev-rec.html") + '<main id="main" class="sheet">'
    html += board_h("S26", "IA-SPEC §3.6.1 Revenue recognition · §4.7 rr.recognition · §6.2 · 04 REV-01…09",
                    "Erin posts September’s revenue for Iowa Custom Cabinets",
                    "On the 1st the scheduler proposes the run. Every job shows its method and where that method came from, % complete from WIP, earned to date, "
                    "this period and over or under billing. The preparer reviews; the controller posts. Deferred and unbilled roll forward on the next tab, with notes that sum.", "Fri Oct 2")
    html += pair_h("1 · The run", "Revenue recognition · Run. Grouped by method, with the five-way split of September revenue on top.")
    html += frame(run_frame(), "Open state · J-2598 is the cursor and the one with a note · Post is the controller’s, never the preparer’s",
                  f"Ties: {f2(R_RUN)} + as billed {f2(AS_BILLED)} + point of sale {f2(POS)} = ICC September revenue {f2(ICC['rev'])}")
    html += anno([("Method and its source", "Each row says which rule set its method: the job, its job type, its revenue type or the company default. The trace below shows the order."),
                  ("% complete you can audit", "Cost to date comes from WIP and the job ledger; the estimate is the job’s EAC. Earned = contract × cost ÷ estimate, on every row."),
                  ("Not everything is in the run", "As billed and point of sale post when invoiced. They’re shown greyed in the split so September’s revenue still adds up."),
                  ("Preview before post", "The two entries are shown balanced before anything posts, including the unbilled accrual that reverses Oct 1.")])
    html += pair_h("2 · Deferred &amp; unbilled roll-forward", "The statement view. Opening to closing for 2410 and 1180, with the release schedule and notes.")
    html += frame(roll_frame(), "Deferred roll-forward tab · report density · eliminations-style ‘of which’ lines split the closing balance",
                  f"Ties: {f0(D_OPEN)} + {f0(BILLED)} − {f0(R_RUN)} − {f0(UNDER_AUG)} + {f0(UNDER_SEP)} = {f0(D_CLOSE)}")
    html += pair_h("3 · Where the method comes from, and the widget", "The resolution order for one job, and rr.recognition open on Oct 2 and done by Oct 19.")
    html += trace_block()
    html += anno([("Catch-up is explained", "An estimate change recomputes earlier months at the new estimate. Note 1 splits Kading’s number into this month’s work and the catch-up."),
                  ("Related clients are named", "ICC sells to Artistry Homes. It’s ordinary revenue in ICC’s books and an elimination in the group, and the note says so."),
                  ("Nothing edits a closed month", "A later change flows through as next month’s catch-up. The posted run is locked."),
                  ("Matches the controller home", "S6c shows rev rec closed through Sep 30 for ICC on Oct 19; this is the run that got it there.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../S26-rev-rec.html", "w").write(build())
    print("ok R_RUN", R_RUN, "POS", POS, "D", D_OPEN, D_CLOSE, "U", UNDER_AUG, UNDER_SEP, "billed", BILLED, "kad", KAD_CATCH)
