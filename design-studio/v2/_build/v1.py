"""V1 — Vendor compliance, the AP clerk's desk (FPB-vendor-compliance-chase §4-§11; IA-SPEC vc.expiring,
vc.portal_uploads, ap.holds; C·Payables·Vendor compliance)."""
from wf_common import *

CSS = """
/* V1 layout only */
.pad{padding:0 var(--margin)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:0}
.split>section{min-width:0;display:flex;flex-direction:column}
.strip{display:grid;grid-template-columns:1.25fr 1fr 1fr 1fr 1fr;border:1px solid var(--line);background:var(--white)}
.strip>div{padding:12px 16px;border-right:1px solid var(--line);min-width:0}
.strip>div:last-child{border-right:0}
.strip .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.strip .t-cap{display:block}
/* signature: the requirement strip — one cell per requirement that applies, read left to right */
.rq{display:grid;grid-template-columns:repeat(9,20px);gap:4px}
.rq i{position:relative;display:block;width:20px;height:20px}
.rq i.m{background:var(--steel)}
.rq i.e{background:repeating-linear-gradient(135deg,var(--electric) 0 2px,var(--white) 2px 5px);box-shadow:inset 0 0 0 1px var(--electric)}
.rq i.n{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--neg)}
.rq i.n::after{content:"";position:absolute;left:9px;top:1px;width:2px;height:18px;background:var(--neg);transform:rotate(45deg)}
.rq i.p{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--electric)}
.rq i.p::after{content:"";position:absolute;left:7px;top:7px;width:6px;height:6px;background:var(--electric)}
.rq i.x{background:none}
.rq i.x::after{content:"";position:absolute;left:5px;right:5px;top:9px;height:2px;background:var(--grey-300)}
.rq-h{position:relative;display:block;height:112px}
.rq-h span{position:absolute;bottom:2px;transform-origin:0 100%;transform:rotate(-45deg);font-size:12px;line-height:16px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink-2);white-space:nowrap}
.tbl-q th.rqth{vertical-align:bottom;padding-bottom:6px;overflow:visible;z-index:3}
.tbl-q thead th{vertical-align:bottom;padding-bottom:8px}
.rq-lg{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;line-height:16px;color:var(--ink-2)}
.rq-lg span{display:inline-flex;align-items:center;gap:6px}
.rq-lg .rq{grid-template-columns:20px}
/* chase track — same slash grammar as S22's cadence track */
.ct{position:relative;display:block;height:24px;width:100%}
.ct::before{content:"";position:absolute;left:0;right:0;top:11px;height:1px;background:var(--line-2)}
.ct i{position:absolute;top:4px;width:4px;height:16px;margin-left:-2px;transform:skewX(-30deg);background:var(--electric)}
.ct i.up{background:var(--white);box-shadow:inset 0 0 0 1px var(--electric)}
.ct i.esc{background:var(--neg)}
.ct i.done{background:var(--pos)}
.ct b{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--midnight)}
.ct-l{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.qa{text-align:right;white-space:nowrap}
.tbl-q td .l2{white-space:normal}
.held{font-weight:600;font-variant-numeric:tabular-nums}
/* panel: requirements vs evidence */
.rl{list-style:none}
.rl li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:2px 10px;align-items:start;padding:8px 0;border-bottom:1px solid var(--line)}
.rl li .rq{grid-template-columns:20px;margin-top:2px}
.rl .w{font-weight:600}
.rl .s{grid-column:2/-1;font-size:12px;line-height:16px;color:var(--ink-3)}
.rl .st{font-size:12px;line-height:20px;font-weight:600;white-space:nowrap}
.gauge{grid-column:2/-1;margin-top:4px}
.gauge-r{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--ink-2);margin-top:8px}
.gauge-b{position:relative;display:block;height:10px;background:var(--canvas);margin-top:4px}
.gauge-b u{position:absolute;left:0;top:0;bottom:0;background:var(--midnight)}
.gauge-b s{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--neg);margin-left:-1px}
.gauge-n{display:flex;justify-content:space-between;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--ink-3);grid-column:2}
.msgs{list-style:none}
.msgs li{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px;line-height:16px}
.msgs li span:first-child{color:var(--ink-3);font-variant-numeric:tabular-nums}
.msgs b{font-weight:600;color:var(--ink)}
/* review frame */
.rv{display:grid;grid-template-columns:600px minmax(0,1fr);min-height:0;border-top:1px solid var(--line)}
.docpane{background:var(--canvas);padding:24px;border-right:1px solid var(--line);overflow:hidden}
.acord{position:relative;background:var(--white);border:1px solid var(--line-2);padding:16px 18px;font-size:12px;line-height:16px;color:var(--ink-2);height:560px}
.acord h4{font:700 12px/16px var(--f-text);letter-spacing:.06em;color:var(--ink);display:flex;justify-content:space-between}
.acord .rowx{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
.acord .box{border:1px solid var(--line-2);padding:6px 8px;min-height:52px}
.acord .lbl{font-size:12px;line-height:16px;font-weight:600;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em}
.acord table{width:100%;border-collapse:collapse;margin-top:10px}
.acord th,.acord td{border:1px solid var(--line-2);padding:4px 6px;text-align:left;font-size:12px;line-height:16px;vertical-align:top}
.acord th{font-weight:600;color:var(--ink-3);background:var(--canvas)}
.acord td.nn{text-align:right;font-variant-numeric:tabular-nums}
.acord .grey i{display:block;height:4px;background:var(--grey-200);margin:5px 0}
.acord .hl{position:relative;box-shadow:inset 0 0 0 2px var(--electric);background:var(--sky)}
.acord .hl>b{position:absolute;left:-2px;top:-18px;height:18px;min-width:18px;padding:0 4px;background:var(--electric);color:var(--white);font:600 12px/18px var(--f-text);text-align:center}
.rv-r{padding:24px var(--margin);min-width:0;display:flex;flex-direction:column;gap:16px}
.rf{width:100%}
.rf td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}
.rf td:first-child{width:28px}
.rf .nb{display:inline-block;min-width:18px;height:18px;padding:0 4px;background:var(--electric);color:var(--white);font:600 12px/18px var(--f-text);text-align:center}
.rf .nb.bad{background:var(--neg)}
.rf .k{color:var(--ink-3);font-size:12px;line-height:16px;display:block}
.rf .v{font-weight:600}
.rf td.c{text-align:right;white-space:nowrap;width:120px}
.checks{list-style:none}
.checks li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:6px 0;align-items:start}
.checks svg{margin-top:4px}
.checks .ok svg{color:var(--pos)}
.checks .no svg{color:var(--neg)}
/* settings frame */
.cfg{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:32px;padding:24px var(--margin) 32px}
.sec{border-top:2px solid var(--electric);padding-top:12px;margin-bottom:28px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.sec-h h2{font:600 15px/24px var(--f-text)}
.ih{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;white-space:nowrap;color:var(--ink-3)}
.ih i{position:relative;display:inline-block;width:14px;height:14px;box-shadow:inset 0 0 0 1.5px var(--night-500);flex:none}
.ih i::after{content:"";position:absolute;left:3px;top:3px;width:5px;height:5px;border-left:1.5px solid var(--night-500);border-bottom:1.5px solid var(--night-500)}
.ih.ov{color:var(--electric);font-weight:600}
.ih.ov i{background:var(--electric);box-shadow:none}
.ih.ov i::after{border-color:var(--white)}
.days{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.day{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--line-2);background:var(--white);font-weight:600;font-variant-numeric:tabular-nums}
.day.esc{border-color:var(--neg);color:var(--neg)}
.msg{padding:16px;background:var(--canvas);border-left:3px solid var(--electric)}
.msg .bub{margin-top:8px;padding:12px 14px;background:var(--white);border:1px solid var(--line);font-size:13px;line-height:20px}
.tbl-cfg td,.tbl-cfg th{padding-top:8px;padding-bottom:8px}
.tbl-cfg .select{height:32px}
.drop{display:flex;gap:12px;align-items:center;padding:12px 16px;border:1px dashed var(--line-2);background:var(--white);margin-top:12px}
.drop svg{color:var(--electric);flex:none}
"""

# --------------------------------------------------------------- data (Artistry Homes, C-110)
REQS = ["W-9", "TIN match", "General liability", "Auto", "Workers’ comp", "Umbrella", "Additional insured", "Waiver of subrogation", "Primary & non-contrib."]
STATE_WORD = {"m": "met", "e": "expiring", "n": "not met", "p": "waiting for review", "x": "not required"}

ROWS = [  # name, kind, reqs, track(kind, points, today, sent, esc), held, bill, stand, l2stand, action, primary
    ("Prairie Drywall LLC", "Subcontractor · LLC", "mmnmmmnmm", ("Correction", [0, 3, 7, 14], 3, 2, False), 18420.00, "B-1182 · due Thu",
     "GL limit short · no AI endorsement", "To vendor and agent · next Sat", "Nudge agent", False),
    ("Ruiz Framing", "Subcontractor · sole proprietor", "mnmmmmmmm", ("W-9 again", [0, 3, 7, 14], 7, 3, True), 9860.00, "B-1176 · due Thu",
     "TIN doesn’t match IRS records", "3 sent · escalated to you today", "Call Luis Ruiz", False),
    ("Iowa Roofing Pros", "Subcontractor · added today", "nnnnnnnnn", ("Welcome", [0, 3, 7, 14], 0, 1, False), 6750.00, "B-1190 · draft",
     "Nothing on file yet", "Link opened 8:15 AM", "Preview", False),
    ("Precision Paint & Finish", "Subcontractor · Inc", "mmmmmnmmm", ("Renewal", [-30, -15, 0, 7], 6, 3, False), None, "Holds tomorrow · B-1185 12,300.00",
     "Umbrella expired · grace to Wed", "Agent Kari Lund · next Wed", "Nudge agent", False),
    ("Des Moines Concrete Works", "Subcontractor · Inc", "mmemmmeee", ("Renewal", [-30, -15, 0, 7], -30, 1, False), None, "",
     "GL policy expires Nov 19", "Renewal asked today · T-15 Nov 4", "Preview", False),
    ("Brightline Electric LLC", "Subcontractor · LLC", "mmmmpmmmm", ("Renewal", [-30, -15, 0, 7], -7, 2, False), None, "",
     "WC renewal uploaded 7:12 AM", "Chase stopped · waiting for you", "Review", True),
]
HELD = [r[4] for r in ROWS if r[4]]
HELD_TOTAL = round(sum(HELD), 2)
assert abs(HELD_TOTAL - 35030.00) < .001, HELD_TOTAL
ACTIVE, MET, EXEMPT = 64, 55, 3
assert len(ROWS) + MET + EXEMPT == ACTIVE
GRACE_BILL = 12300.00


def rq(states, label_prefix=""):
    cells = "".join(f'<i class="{s}" title="{E(REQS[i])}: {STATE_WORD[s]}"></i>' for i, s in enumerate(states))
    sr = "; ".join(f"{REQS[i]} {STATE_WORD[s]}" for i, s in enumerate(states) if s != "x")
    return f'<span class="sr">{label_prefix}{sr}</span><span class="rq" aria-hidden="true">{cells}</span>'


def ct(kind, pts, today, sent, esc):
    lo, hi = pts[0], pts[-1] + 3
    span = hi - lo
    out = '<span class="ct" aria-hidden="true">'
    nxt = False
    for j, p in enumerate(pts):
        left = (p - lo) / span * 100
        if j < sent:
            cls = "esc" if (esc and j == sent - 1) else ""
        elif not nxt:
            cls = "up"
            nxt = True
        else:
            continue
        out += f'<i class="{cls}" style="left:{left:.1f}%"></i>'
    tl = (min(max(today, lo), hi) - lo) / span * 100
    out += f'<b style="left:{tl:.1f}%"></b></span>'
    if kind == "Renewal":
        labs = "".join(f"<span>{'T' if p <= 0 else ''}{p if p <= 0 else '+' + str(p)}</span>" for p in pts)
        labs = labs.replace("T0", "T-0")
    else:
        labs = "".join(f"<span>day {p}</span>" if i == 0 else f"<span>{p}</span>" for i, p in enumerate(pts))
    return out + f'<span class="ct-l" aria-hidden="true">{labs}</span>'


def pri_rail(cur):
    uses = {"Purchase orders", "Jobs", "WIP", "Retainage", "Revenue recognition", "Customer deposits", "Estimates"}
    drop = {"Budgets", "FP&A & scenarios", "More · 2", "Compliance & SOX", "AI decision log", "More · Agents", "Approvals",
            "Inventory", "Cash application"}
    keep = {it for _, items in CLIENT_TREE for it in items} - drop
    counts = {"To review": 9, "Requests": 4, "Close": "15/22", "Bills": 31, "Vendor compliance": "!6"}
    return rail(client_nav(uses, cur, counts, keep=keep), "Priya Natarajan", "Bookkeeper · Artistry")


def vc_tabs(sel):
    names = [("Compliance", "6"), ("Portal uploads", "1"), ("1099 readiness", "")]
    out = '<div class="tabs" role="tablist" aria-label="Vendor compliance">'
    for t, c in names:
        cn = f'<span class="n">{c}</span>' if c else ""
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}{cn}</button>'
    return out + "</div>"


# --------------------------------------------------------------- frame 1: Compliance tab
def compliance_frame():
    strip = f"""<div class="strip">
<div><span class="eyebrow">Held from payment</span><span class="v neg">{f2(HELD_TOTAL)}</span><span class="t-cap">3 vendors · 3 bills · 2 due this week</span></div>
<div><span class="eyebrow">Holds tomorrow</span><span class="v warn">{f2(GRACE_BILL)}</span><span class="t-cap">Precision · umbrella grace ends</span></div>
<div><span class="eyebrow">Expiring soon</span><span class="v">2</span><span class="t-cap">≤ 30 days · renewals asked</span></div>
<div><span class="eyebrow">To review</span><span class="v">1</span><span class="t-cap">upload from Brightline</span></div>
<div><span class="eyebrow">Met</span><span class="v">{MET} of {ACTIVE}</span><span class="t-cap">{EXEMPT} exempt · utilities, county</span></div></div>"""
    head_lbls = "".join(f'<span style="left:{i * 24 + 6}px">{r}</span>' for i, r in enumerate(REQS))
    rows = ""
    for i, (name, kind, reqs, (tk, pts, today, sent, esc), held, bill, stand, l2, act, prim) in enumerate(ROWS):
        cls = " is-cursor" if i == 0 else ""
        cls += " is-attn" if held else ""
        hl = (f'<span class="l1 held neg">{f2(held)}</span><span class="l2">{bill}</span>' if held else
              (f'<span class="l1 warn" style="font-weight:600">Tomorrow</span><span class="l2">{f2(GRACE_BILL)}</span>' if "Holds tomorrow" in bill else '<span class="l2">—</span>'))
        b = btn(act, "primary" if prim else "", "", "", f'data-say="{E(act)} · {E(name)}"')
        rows += (f'<tr class="q-row{cls}" data-drill="{E(name)}" tabindex="0"><td><span class="l1">{name}</span><span class="l2">{stand}</span></td>'
                 f'<td>{rq(reqs)}</td>'
                 f'<td><span class="sr">{tk}: {sent} sent. {l2}</span><span class="l2" style="margin-bottom:2px" aria-hidden="true">{tk} · {sent} sent</span>{ct(tk, pts, today, sent, esc)}</td>'
                 f'<td>{hl}</td><td class="qa">{b}</td></tr>')
    rows += (f'<tr class="q-group"><td colspan="5"><span class="q-group-t">{MET} met · {EXEMPT} exempt</span>'
             f'<span class="t-cap" style="margin-left:12px">Midwest Plumbing &amp; Mechanical, Kinsley Landscape Design, Menards and 52 more · next renewal Dec 2</span>'
             f'<button class="btn btn--quiet" type="button" style="float:right">Show {MET + EXEMPT}</button></td></tr>')
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Vendors by compliance state">'
             f'<colgroup><col><col style="width:236px"><col style="width:148px"><col style="width:104px"><col style="width:152px"></colgroup>'
             f'<thead><tr><th>Vendor · worst first</th><th class="rqth"><span class="sr">Requirements, in order: {", ".join(REQS)}</span><span class="rq-h" aria-hidden="true">{head_lbls}</span></th>'
             f'<th>Chase</th><th>Held</th><th></th></tr></thead><tbody>'
             f'<tr class="q-group"><td colspan="5"><span class="q-group-t">Needs something · {len(ROWS)}</span></td></tr>{rows}</tbody></table>')
    lg = ('<div class="rq-lg"><span><span class="rq"><i class="m"></i></span>Met</span><span><span class="rq"><i class="e"></i></span>Expiring ≤ 30 days</span>'
          '<span><span class="rq"><i class="n"></i></span>Not met</span><span><span class="rq"><i class="p"></i></span>Waiting for review</span>'
          '<span><span class="rq"><i class="x"></i></span>Not required</span></div>')
    sec = f"""<section>
<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Vendor compliance</div><h1 class="t-title" style="margin-top:4px">Vendor paperwork</h1></div>
<div class="btn-row">{btn("Requirements", "quiet", "", "sliders")}{btn("Request all due", "primary", "R", "send", 'data-say="Requested 4 · one link per vendor"')}</div></div>{vc_tabs("Compliance")}</div>
<div class="pad" style="padding-top:16px">{strip}</div>
<div class="pad row row--between" style="padding-top:14px;padding-bottom:6px;gap:16px"><span class="t-cap">Template v4 · holds block payment, never approval</span>{lg}</div>
<div style="flex:1;min-height:0;overflow:auto">{table}</div>
<div class="keybar" style="white-space:nowrap"><span class="ph-k"><span class="kbd">J</span><span class="kbd">K</span>move</span><span class="ph-k"><span class="kbd">Enter</span>open vendor</span><span class="ph-k"><span class="kbd">R</span>request</span><span class="ph-k"><span class="kbd">N</span>nudge</span><span class="ph-k"><span class="kbd">V</span>review upload</span><span class="sp"></span><span>Met vendors leave by themselves</span></div></section>"""

    def li(state, word, st, sub="", extra=""):
        col = {"m": "pos", "n": "neg", "e": "blue", "p": "blue"}.get(state, "ink-3")
        return (f'<li><span class="rq" aria-hidden="true"><i class="{state}"></i></span><span class="w">{word}</span>'
                f'<span class="st {col}">{st}</span>{f"<span class=s>{sub}</span>" if sub else ""}{extra}</li>')

    def gauge(lbl, have, need):
        mx = max(have, need) * 1.04
        return (f'<div class="gauge-r"><span>{lbl}</span><span class="tnum"><b class="neg">{f0(have)}</b> of {f0(need)}</span></div>'
                f'<span class="gauge-b" role="img" aria-label="{lbl}: {f0(have)} on the certificate, {f0(need)} required">'
                f'<u style="width:{have / mx * 100:.1f}%"></u><s style="left:{need / mx * 100:.1f}%"></s></span>')
    gl = '<div class="gauge">' + gauge("Each occurrence", 500000, 1000000) + gauge("Aggregate", 1000000, 2000000) + "</div>"
    reqlist = ("<ul class='rl' aria-label='Requirements for Prairie Drywall'>"
               + li("m", "W-9", "Met", "Signed Mar 3, 2026 · LLC taxed as partnership")
               + li("m", "TIN match", "Pass", "IRS match Mar 3 via Track1099")
               + li("n", "General liability", "Not met", "Policy GL-4471902 · Hawkeye Insurance Group · to Mar 1, 2027", gl)
               + li("m", "Auto", "Met", "1,000,000 combined single limit")
               + li("m", "Workers’ comp", "Met", "Statutory · employer’s liability 500,000")
               + li("m", "Umbrella", "Met", "2,000,000")
               + li("n", "Additional insured", "Not met", "Box checked on the certificate. Artistry’s contracts require the endorsement pages (CG 20 10 and CG 20 37).")
               + li("m", "Waiver of subrogation", "Met", "Endorsement on file")
               + li("m", "Primary & non-contributory", "Met", "Endorsement on file") + "</ul>")
    panel = f"""<aside class="panel" aria-label="Prairie Drywall LLC"><div class="panel-head"><div class="eyebrow">Subcontractor<span class="sl">//</span>Template v4</div><span class="t-head">Prairie Drywall LLC</span></div>
<div class="panel-body">
<div class="panel-sec">{reqlist}</div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Held</h3></div><p class="ink-2"><b class="neg">{f2(18420.00)}</b> · B-1182 · tape and finish, Lot 14 Ashworth Pointe · due Thu Oct 22. Approved, so the liability is booked; it leaves Thursday’s run until the GL limit is fixed or an exception is granted.</p></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Correction request · opened Oct 17</h3></div>
<ul class="msgs"><li><span>Oct 17 · 2:04</span><span>Email to <b>Lisa Ochoa</b> and agent <b>Kari Lund</b>, Hawkeye Insurance Group, with Artistry’s requirement sheet</span></li>
<li><span>Oct 20 · 9:00</span><span>Text to Lisa (opted in) · email to Kari · <b>not opened yet</b></span></li>
<li><span>Sat Oct 24</span><span>Next reminder · after 2 more, to Ben Ruhl, Artistry purchasing</span></li></ul></div>
</div>
<div class="panel-foot" style="display:block"><div class="btn-row">{btn("Nudge agent now", "primary", "N", "", 'data-say="Nudged Kari Lund · Hawkeye Insurance Group"')}{btn("Accept with exception…", "", "", "lock")}</div><p class="t-cap" style="margin-top:8px">Exceptions need an accounting manager · Jordan Smith</p></div></aside>"""
    main = (ctxline(["Tue Oct 20", "September closed Oct 15", "Pay run Thu Oct 22", f"<b>3 vendors held · {f2(HELD_TOTAL)}</b>"]) +
            f'<div class="split" style="height:calc(100% - 32px)">{sec}{panel}</div>')
    return app("client", "density-cockpit", pri_rail("Vendor compliance"),
               bar(ctx_client("Artistry Homes", "C-110", "Oct open"), "Payables / Vendor compliance / <b>Compliance</b>", cmd="Jump to vendor, bill, certificate…", sync="Synced 9:41 AM"),
               main, 1088, live=True)


# --------------------------------------------------------------- frame 2: Portal upload review
def review_frame():
    acord = f"""<div class="acord" aria-label="Certificate of liability insurance, page 1, as uploaded">
<h4><span>CERTIFICATE OF LIABILITY INSURANCE</span><span>DATE 10/19/2026</span></h4>
<div class="rowx"><div class="box"><div class="lbl">Producer</div>Cornerstone Agency<br>Urbandale, IA · (515) 555-0148</div>
<div class="box"><div class="lbl">Insurer(s) affording coverage</div>A · Accident Fund Ins Co of America · NAIC 10166<br>B · Grinnell Mutual</div></div>
<div class="rowx"><div class="box"><div class="lbl">Insured</div>Brightline Electric LLC<br>2210 SE Hulsizer Rd, Ankeny IA</div><div class="box grey"><i></i><i style="width:70%"></i><i style="width:85%"></i></div></div>
<table><thead><tr><th style="width:30%">Type of insurance</th><th>Policy number</th><th>Eff</th><th>Exp</th><th style="width:28%">Limits</th></tr></thead><tbody>
<tr><td>Commercial general liability</td><td>BGL-220871</td><td>03/01/26</td><td>03/01/27</td><td class="nn">Each occ 1,000,000<br>Aggregate 2,000,000</td></tr>
<tr><td>Automobile liability</td><td>BAU-220872</td><td>03/01/26</td><td>03/01/27</td><td class="nn">CSL 1,000,000</td></tr>
<tr><td>Umbrella liab</td><td>BUM-220873</td><td>03/01/26</td><td>03/01/27</td><td class="nn">Each occ 2,000,000</td></tr>
<tr><td>Workers compensation and employers’ liability</td><td>WC 4410-9921</td><td class="hl"><b>1</b>10/27/26</td><td class="hl">10/27/27</td><td class="nn hl"><b>2</b>Statutory<br>E.L. each accident 500,000</td></tr>
</tbody></table>
<div class="rowx" style="margin-top:24px"><div class="box hl"><b>3</b><div class="lbl">Description of operations</div>Artistry Homes LLC is additional insured on a primary and non-contributory basis; waiver of subrogation applies per written contract.</div>
<div class="box hl"><b>4</b><div class="lbl">Certificate holder</div>Artistry Homes LLC<br>4100 Westown Pkwy, Ste 200<br>West Des Moines, IA 50266</div></div>
</div>"""
    fields = [("1", "Workers’ comp policy period", "Oct 27, 2026 → Oct 27, 2027", 0.97, False),
              ("2", "Employer’s liability, each accident", "500,000", 0.95, False),
              ("3", "AI, primary & non-contributory, waiver", "Stated in description", 0.88, False),
              ("4", "Certificate holder", "Artistry Homes LLC, 4100 Westown Pkwy…", 0.99, False)]
    rows = ""
    for no, k, v, c, bad in fields:
        pct = int(round(c * 100))
        on = round(c * 10)
        rows += (f'<tr><td><span class="nb{" bad" if bad else ""}">{no}</span></td><td><span class="k">{k}</span><span class="v">{v}</span></td>'
                 f'<td class="c"><span class="conf"><span class="meter" role="img" aria-label="Confidence {pct}%">{"<i class=on></i>" * on}{"<i></i>" * (10 - on)}</span><b>{pct}</b></span></td></tr>')
    checks = (f'<ul class="checks" aria-label="Checks against Artistry’s template">'
              f'<li class="ok">{ico("check")}<span><b>Workers’ comp renews the day the old policy ends</b> · no gap on Oct 27</span></li>'
              f'<li class="ok">{ico("check")}<span><b>Employer’s liability 500,000</b> meets 500,000</span></li>'
              f'<li class="ok">{ico("check")}<span><b>Holder wording matches</b> Artistry Homes LLC exactly</span></li>'
              f'<li class="ok">{ico("check")}<span><b>Endorsements already on file</b> from March (AI, waiver, primary)</span></li>'
              f'<li class="ok">{ico("check")}<span><b>Carrier rating</b> Accident Fund · A- VIII or better required</span></li></ul>')
    right = f"""<div class="rv-r"><div><div class="eyebrow">Portal upload<span class="sl">//</span>7:12 AM from Brightline Electric</div><h2 class="t-section" style="margin-top:4px">Workers’ comp renewal</h2>
<p class="ink-2" style="margin-top:4px">Read from the certificate. Numbers match the boxes on the left. Nothing is saved until you accept.</p></div>
<table class="rf" aria-label="What was read">{rows}</table>
<div><h3 class="t-head">Against the subcontractor template</h3>{checks}</div>
<article class="note" style="margin-top:0"><div class="note-top"><span class="note-no">AI</span><div><div class="note-kind">Read by COI_EXTRACT · confidence 88–99</div><div class="note-title">Additional insured is stated in the description box, not as a checkbox</div></div></div>
<p>Artistry already holds Brightline’s blanket endorsements from March, so this wording is enough for the renewal. If they hadn’t been on file, this would ask for the pages.</p></article>
<div class="btn-row" style="margin-top:auto">{btn("Accept", "primary", "A", "", 'data-say="Accepted · Brightline Electric is met through Oct 27, 2027"')}{btn("Reject with reason…", "", "R")}{btn("Accept with exception…", "quiet", "", "lock")}</div></div>"""
    main = (ctxline(["Tue Oct 20", "Portal uploads", "<b>1 waiting</b>"]) +
            f'<div class="pad" style="padding-top:20px"><div class="page-head" style="margin-bottom:12px"><div><div class="eyebrow">Payables<span class="sl">//</span>Vendor compliance</div><h1 class="t-title" style="margin-top:4px">Portal uploads</h1></div></div>{vc_tabs("Portal uploads")}</div>'
            f'<div class="rv" style="height:calc(100% - 172px)"><div class="docpane">{acord}</div>{right}</div>')
    return app("client", "density-cockpit", pri_rail("Vendor compliance"),
               bar(ctx_client("Artistry Homes", "C-110", "Oct open"), "Payables / Vendor compliance / <b>Portal uploads</b>", cmd="Jump to vendor, bill, certificate…", sync="Synced 9:41 AM"),
               main, 1000)


# --------------------------------------------------------------- frame 3: requirement template + cadence
def settings_frame():
    T = [  # requirement, minimum, evidence, hold, inherit(ov?)
        ("W-9", "Signed, current form", "Fill on portal or upload", "Block payment", False),
        ("TIN match", "IRS pass", "Track1099 · on W-9 accept and each Nov", "Block payment", False),
        ("General liability", "1,000,000 each occ · 2,000,000 agg", "Certificate", "Block payment", False),
        ("Auto", "1,000,000 CSL", "Certificate · only if vehicles on site", "Warn", False),
        ("Workers’ comp", "Statutory · EL 500,000", "Certificate or Iowa sole-proprietor exemption", "Block payment", False),
        ("Umbrella", "2,000,000", "Certificate", "Block payment", True),
        ("Additional insured", "Ongoing + completed ops", "Endorsement pages required", "Block payment", True),
        ("Waiver of subrogation", "In favor of Artistry Homes LLC", "Endorsement pages required", "Block payment", True),
        ("Primary & non-contributory", "—", "Endorsement pages required", "Warn", True),
    ]
    rows = ""
    for i, (r, mn, ev, hold, ov) in enumerate(T):
        mark = '<span class="ih ov"><i></i>Artistry overrides</span>' if ov else '<span class="ih"><i></i>Follows Merit default</span>'
        rows += (f'<tr><td><span class="l1">{r}</span><span style="display:block;margin-top:2px">{mark}</span></td><td class="tnum">{mn}</td><td>{ev}</td>'
                 f'<td><select class="select" aria-label="{E(r)} if not met" style="width:100%">{"".join(f"<option>{o}</option>" for o in [hold] + [x for x in ("Block payment", "Warn", "Track only") if x != hold])}</select></td></tr>')
    table = (f'<table class="tbl tbl-cfg" aria-label="Subcontractor template"><colgroup><col style="width:196px"><col style="width:184px"><col><col style="width:156px"></colgroup>'
             f'<thead><tr><th>Requirement · source</th><th>Minimum</th><th>Evidence</th><th>If not met</th></tr></thead><tbody>{rows}</tbody></table>')
    left = f"""<div>
<div class="sec"><div class="sec-h"><h2>Subcontractor · version 4 · active since Jul 1</h2><span class="ih ov"><i></i>4 of 9 override Merit’s default</span></div>
<p class="t-cap" style="margin-top:4px">Applies to vendors typed Subcontractor at Artistry Homes. Jobs can add more from MeritProjects (a named owner as additional insured), and those show on the vendor with the job number.</p>
<div style="margin-top:12px">{table}</div>
<div class="drop">{ico("upload")}<span><b>Drop a contract insurance exhibit</b> and the requirements are proposed with the sentence each came from. You confirm each one before it changes this template.</span></div></div>
<div class="sec"><div class="sec-h"><h2>Chase cadence</h2><span class="ih"><i></i>Follows Merit default</span></div>
<div class="frm" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:8px">
<div><span class="field-label">Renewal</span><div class="days"><span class="day">T-30</span><span class="day">T-15</span><span class="day">T-0</span><span class="day">weekly</span></div></div>
<div><span class="field-label">Missing</span><div class="days"><span class="day">day 0</span><span class="day">3</span><span class="day">7</span><span class="day">weekly</span></div></div>
<div><span class="field-label">Escalate after</span><div class="days"><span class="day esc">3 unanswered</span><span class="t-cap">to the AP owner, then Ben Ruhl</span></div></div></div>
<div class="frm" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:16px">
<div class="field"><span class="field-label">Channels</span><label class="check"><input type="checkbox" checked><i></i>Email</label><label class="check"><input type="checkbox" checked><i></i>Text, if the vendor opted in</label><label class="check"><input type="checkbox" checked><i></i>Copy the insurance agent on COI requests</label></div>
<div class="field"><span class="field-label">Quiet hours</span><span>8:00 PM – 7:00 AM vendor time · no texts on weekends</span></div>
<div class="field"><span class="field-label">Grace after expiry</span><span>7 days, then payment holds</span></div></div></div></div>"""
    right = f"""<div><div class="msg"><span class="eyebrow">Preview<span class="sl">//</span>Renewal, T-30, to the agent</span>
<div class="bub"><b>Subject: Renewal certificate needed for Des Moines Concrete Works</b><br><br>Hi Mark,<br><br>Artistry Homes needs the renewal certificate for Des Moines Concrete Works’ general liability policy CGL-77120, which expires Nov 19. The requirement sheet is attached; endorsement pages too, please.<br><br>Upload here, no account needed: mbks.co/v/R8d2<br><br>Priya Natarajan, for Artistry Homes</div>
<p class="t-cap" style="margin-top:8px">Sent from ap@artistryhomes.mbks.co · replies attach to the request</p></div>
<div class="msg" style="margin-top:16px"><span class="eyebrow">Preview<span class="sl">//</span>Text, day 3, to the vendor</span>
<div class="bub">Artistry Homes: 2 items still needed from Iowa Roofing Pros before your first payment. Takes about 3 min: mbks.co/v/Q4m9 · Reply STOP to end texts</div></div></div>"""
    SAVE5 = btn("Save version 5", "primary", "", "", 'data-say="Saved version 5 · applies to 31 subcontractors"')
    main = (ctxline(["Client settings", "Vendor requirements", "Inherits from Merit Management Group"]) +
            f'<div class="pad" style="padding-top:20px"><div class="page-head"><div><div class="eyebrow">Client settings<span class="sl">//</span>Vendor requirements</div><h1 class="t-title" style="margin-top:4px">What vendors owe Artistry</h1></div>'
            f'<div class="btn-row">{btn("Corporate supplier", "quiet")}{btn("1099 service provider", "quiet")}{btn("Professional", "quiet")}{SAVE5}</div></div></div>'
            f'<div class="cfg">{left}{right}</div>')
    return app("client", "density-cockpit", pri_rail("Client settings"),
               bar(ctx_client("Artistry Homes", "C-110", "Oct open"), "Client settings / <b>Vendor requirements</b>", cmd="Find a setting…", sync="Synced 9:41 AM"),
               main, 1240)


def build():
    html = head("V1 · Vendor compliance", CSS) + sheet_top("V1-vendor-compliance.html") + '<main id="main" class="sheet">'
    html += board_h("V1", "FPB-vendor-compliance-chase §4–§11 · IA vc.expiring · vc.portal_uploads · ap.holds",
                    "Priya’s desk: who owes Artistry which paper, and what it’s holding up",
                    "Artistry Homes builds with 31 subcontractors. Every vendor owes what its type requires: a W-9 that matches the IRS, and for subs a certificate with Artistry’s limits, "
                    "endorsements and holder wording. The chase engine asks on a cadence and copies the insurance agent. Priya only sees what needs a person: a short limit, a TIN that doesn’t match, "
                    "an upload to accept, a bill being held.")
    html += pair_h("1 · Compliance", "C·Payables·Vendor compliance. Prairie Drywall is open in the panel: two requirements fail, one bill is held, the correction request is on its second send.")
    html += frame(compliance_frame(), "Open state · worst first · the requirement strip is this board’s signature: one cell per requirement, same order on every row",
                  f"Ties: held {f2(18420)} + {f2(9860)} + {f2(6750)} = {f2(HELD_TOTAL)} · {len(ROWS)} + {MET} met + {EXEMPT} exempt = {ACTIVE}")
    html += anno([("Read a vendor in one glance", "Nine cells in a fixed order. Solid is met, a 45° hatch is expiring, a slash is not met, a dot waits for review. Words are in the panel and in screen-reader text, never colour alone."),
                  ("The limit, not just the flag", "A short limit shows as a bar against the required tick: 500,000 on the certificate, 1,000,000 required. The agent gets the same sentence."),
                  ("Holds stop money, not work", "Bills still approve and post; the liability is real. A held bill drops out of Thursday’s run with its reason, and only an accounting manager can grant an exception."),
                  ("Nobody types a reminder", "Every row’s chase is already running: welcome, correction, renewal at T-30 / T-15 / T-0. Buttons here are nudges and previews, not the engine.")])
    html += pair_h("2 · Portal uploads", "What the vendor sent, read and checked before Priya sees it. Each number on the certificate ties to a read field.")
    html += frame(review_frame(), "Waiting state · one upload · accept writes the coverage lines, recomputes holds, stops the chase", "COI_EXTRACT proposes; nothing persists until Accept")
    html += anno([("Evidence beside the claim", "The certificate stays on screen with numbered boxes. Priya checks the read against the paper, not against her memory."),
                  ("The template does the judging", "Limits compare in cents, dates by day, holder wording exactly. AI reads; deterministic rules decide; a person accepts."),
                  ("History counts", "Brightline’s endorsements came in March, so the renewal doesn’t ask for them again. The note says why."),
                  ("AI paused?", "The upload still lands here with the certificate. Priya keys four fields and the same checks run.")])
    html += pair_h("3 · Requirements and cadence", "Client settings · Vendor requirements. What Artistry asks for, where it differs from Merit’s default, and the exact words vendors and agents receive.")
    html += frame(settings_frame(), "Subcontractor template · inheritance marks match S22 and S27", "Owner’s cadence: T-30 / T-15 / T-0 then weekly")
    html += anno([("Per client, per vendor type", "Artistry overrides four of nine because its owner contracts demand endorsements. Clive keeps Merit’s default and never sees this complexity."),
                  ("Contracts become rules", "Drop the insurance exhibit from a subcontract; each requirement is proposed with its source sentence, the same pattern as the expense policy (W2)."),
                  ("The agent is a recipient", "Certificates are issued by agents. Copying the agent on COI requests is what gets them right the first time."),
                  ("Quiet, then firm", "Quiet hours and weekends hold texts. Seven days of grace after expiry, then the hold, then escalation to the client.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../V1-vendor-compliance.html", "w").write(build())
    print("ok", HELD_TOTAL)
