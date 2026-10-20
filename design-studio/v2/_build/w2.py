"""W2 — Expense-policy upload: document → extracted rules with their source sentences → simulate → publish →
acknowledgments (FPB-workforce-app §5; 08-ONBOARDING-V2 §11.4 T7; existing EXPENSE_POLICY_EXTRACT + policy-schema.ts)."""
from wf_common import *

CSS = """
/* W2 layout only */
.pad{padding:0 var(--margin)}
.stepper{display:flex;gap:0;margin-top:16px;border:1px solid var(--line);background:var(--white)}
.stepper span{flex:1;display:flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-right:1px solid var(--line);color:var(--ink-3);font-weight:500;white-space:nowrap}
.stepper span:last-child{border-right:0}
.stepper span.done{color:var(--ink-2)}
.stepper span.done svg{color:var(--pos)}
.stepper span.cur{color:var(--ink);font-weight:600;box-shadow:inset 0 -2px var(--electric)}
.stepper b{font-variant-numeric:tabular-nums}
.rv{display:grid;grid-template-columns:500px minmax(0,1fr);min-height:0;border-top:1px solid var(--line);margin-top:16px}
.docpane{background:var(--canvas);padding:20px 24px;border-right:1px solid var(--line);overflow:hidden}
.page{background:var(--white);border:1px solid var(--line-2);padding:24px 28px;font-size:13px;line-height:21px;color:var(--ink-2)}
.page h3{font:600 13px/20px var(--f-text);color:var(--ink);margin-top:14px}
.page h3:first-of-type{margin-top:8px}
.page .ptop{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:16px;color:var(--ink-3);border-bottom:1px solid var(--line);padding-bottom:8px}
/* signature: the source tether — each rule and the sentence it came from share a number and light together */
.sn{box-shadow:inset 0 -1.5px 0 var(--blue-300);transition:background-color 200ms,box-shadow 200ms;cursor:default}
.sn.un{box-shadow:inset 0 -1.5px 0 var(--warn)}
.tn{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;margin-right:4px;background:var(--electric);color:var(--white);font:600 12px/18px var(--f-text);vertical-align:1px;font-variant-numeric:tabular-nums}
.tn.un{background:var(--warn)}
.sn.is-lit,.rr.is-lit td{background:var(--sky)}
.sn.is-lit{background:var(--blue-100);box-shadow:inset 0 -2px 0 var(--electric);color:var(--ink)}
.rr.is-lit td:first-child{box-shadow:inset 3px 0 var(--electric)}
.rules-p{padding:20px var(--margin) 24px;min-width:0;display:flex;flex-direction:column;gap:16px;overflow:hidden}
.tbl-r td,.tbl-r th{padding:8px}
.tbl-r td{vertical-align:middle;border-bottom:1px solid var(--line)}
.tbl-r .k{font-weight:600}
.tbl-r .s{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
.tbl-r .v{font-weight:600;font-variant-numeric:tabular-nums}
.tbl-r .seg{height:28px}
.tbl-r .seg button{padding:0 10px;font-size:12px}
.tbl-r .seg button[aria-pressed=true]{background:var(--midnight);color:var(--warm)}
.tbl-r .acc{color:var(--pos);display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600}
.tbl-r tr.grp td{background:var(--canvas);font-size:12px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);padding:6px 8px}
.um{list-style:none}
.um li{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.um .q{color:var(--ink);font-size:13px;line-height:20px}
.um .s{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
/* simulate + publish */
.sp{display:grid;grid-template-columns:minmax(0,1fr) 392px;gap:32px;padding:20px var(--margin) 32px}
.sec{border-top:2px solid var(--electric);padding-top:12px;margin-bottom:24px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.sec-h h2{font:600 15px/24px var(--f-text)}
.strip{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);background:var(--white);margin-top:12px}
.strip>div{padding:12px 16px;border-right:1px solid var(--line)}
.strip>div:last-child{border-right:0}
.strip .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.strip .t-cap{display:block}
.dv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;align-items:center}
.dv .bars{display:flex;flex-direction:column;gap:3px}
.dv .bars span{display:block;height:8px}
.dv .bars .o{background:var(--grey-300)}
.dv .bars .n{background:var(--electric)}
.dv .bars .n.blk{background:var(--neg)}
.tbl-sim td,.tbl-sim th{padding:6px 8px;border-bottom:1px solid var(--line)}
.tbl-sim td.n{padding-right:16px}
.tbl-sim tr.fs-sub td{border-top:1px solid var(--midnight);border-bottom:0}
.lgd{display:flex;gap:16px;font-size:12px;line-height:16px;color:var(--ink-2)}
.lgd span{display:inline-flex;align-items:center;gap:6px}
.lgd i{display:inline-block;width:16px;height:8px}
.ih{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;white-space:nowrap;color:var(--ink-3)}
.ih i{position:relative;display:inline-block;width:14px;height:14px;box-shadow:inset 0 0 0 1.5px var(--night-500);flex:none}
.ih i::after{content:"";position:absolute;left:3px;top:3px;width:5px;height:5px;border-left:1.5px solid var(--night-500);border-bottom:1.5px solid var(--night-500)}
.ih.ov{color:var(--electric);font-weight:600}
.ih.ov i{background:var(--electric);box-shadow:none}
.ih.ov i::after{border-color:var(--white)}
.pubrow{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:48px;border-bottom:1px solid var(--line)}
.fup{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:10px 12px;background:var(--warn-wash);margin-top:12px;font-size:13px;line-height:20px}
.fup svg{color:var(--warn);margin-top:2px}
.ack{display:grid;grid-template-columns:minmax(0,1fr) 392px;gap:32px;padding:20px var(--margin) 28px}
.vers{list-style:none}
.vers li{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:52px;border-bottom:1px solid var(--line)}
.vers .vn{font:600 15px/24px var(--f-text)}
.prog{display:flex;gap:2px;margin-top:8px}
.prog i{flex:1;height:16px;background:var(--line-2)}
.prog i.on{background:var(--steel)}
"""

SENT = [  # (num or 'U#', text) in reading order with plain glue
    ("h", "4. Receipts and documentation"),
    ("1", "Receipts are required for every expense of $25.00 or more."),
    ("U1", "Client meals must list the names and companies of everyone attending."),
    ("h", "5. Meals and lodging"),
    ("2", "Meals while traveling overnight are limited to $75 per day."),
    ("3", "Lodging may not exceed $159 per night in Iowa"),
    ("U2", "and $229 per night outside Iowa unless approved in advance."),
    ("5", "Employees traveling overnight receive a per diem at GSA rates for the destination city."),
    ("h", "6. Travel"),
    ("4", "Use of a personal vehicle is reimbursed at 70 cents per mile."),
    ("h", "7. Alcohol, gifts and entertainment"),
    ("6", "Alcohol is not reimbursable except at client entertainment, up to $50 per event."),
    ("7", "Gifts to customers over $25 require pre-approval."),
    ("8", "Fines, traffic tickets and personal entertainment are never reimbursable."),
    ("h", "8. Approvals and purchasing"),
    ("9", "Expenses up to $500 are approved by the supervisor, up to $2,500 by the department head, and above that by the controller."),
    ("U3", "Tools and equipment over $500 must be bought through a purchase order, not on a company card."),
    ("U4", "Expense reports are due within 30 days of the expense."),
]

RULES = [  # group, num, rule, sub, value, severity (None = n/a)
    ("Receipts", "1", "Receipt required", "Every category", "25.00 and over", "WARN"),
    ("Limits", "2", "Meals", "Per day, traveling", "75.00", "WARN"),
    ("Limits", "3", "Lodging", "Per night", "159.00", "WARN"),
    ("Limits", "6", "Alcohol", "Per event, client entertainment", "50.00", "WARN"),
    ("Limits", "7", "Gifts", "Pre-approval over", "25.00", "BLOCK"),
    ("Limits", "8", "Fines · personal entertainment", "Prohibited", "Never", "BLOCK"),
    ("Rates", "4", "Mileage", "Integer cents per mile", "0.70 / mi", None),
    ("Rates", "5", "Per diem", "GSA meals by city · 312 cities", "On", "WARN"),
    ("Approvals", "9", "Approval tiers", "Supervisor ≤ 500 · dept head ≤ 2,500 · controller above", "3 tiers", None),
]
assert sorted(int(r[1]) for r in RULES) == list(range(1, 10))
UNMAPPED = [("U1", "Client meals must list everyone attending", "No attendee field on an expense line yet"),
            ("U2", "Lodging outside Iowa up to 229.00", "Lodging caps by state aren’t in the rules schema"),
            ("U3", "Tools over 500.00 through a PO, not a card", "Needs the purchase-order link · a control, not a limit"),
            ("U4", "Reports due within 30 days", "No timing rule in the schema")]

# Simulation, last 90 days
SIM = [("Receipt 25.00+", 4, 9, False), ("Lodging over 159.00", 2, 7, False), ("Meals over 75.00/day", 4, 4, False),
       ("Alcohol over 50.00", 7, 3, False), ("Gifts without pre-approval", 0, 2, True), ("Fines · personal", 2, 4, True)]
V2W = sum(a for _, a, b, blk in SIM if not blk); V3W = sum(b for _, a, b, blk in SIM if not blk)
V2B = sum(a for _, a, b, blk in SIM if blk); V3B = sum(b for _, a, b, blk in SIM if blk)
assert (V2W, V3W, V2B, V3B) == (17, 23, 2, 6)
TEAMS = [("Field service", 14), ("Install", 9), ("Sales", 6)]
assert sum(t[1] for t in TEAMS) == V3W + V3B
EMP, ACKED = 41, 29


def jordan_rail(cur):
    uses = {"Payroll", "Jobs", "WIP", "Purchase orders", "Revenue recognition"}
    drop = {"More · 2", "More · Agents", "Inventory", "Cash application", "Estimates", "Customer deposits", "Retainage"}
    keep = {it for _, items in CLIENT_TREE for it in items} - drop
    counts = {"Approvals": 7, "Exceptions": 3, "Expenses & receipts": "!9"}
    return rail(client_nav(uses, cur, counts, keep=keep), "Jordan Smith", "Controller · Merit")


def ex_tabs():
    names = [("Receipts", ""), ("Missing receipts", "9"), ("Expense reports", "4"), ("Approvals", ""), ("Reimbursements", ""), ("Policy", "")]
    out = '<div class="tabs" role="tablist" aria-label="Expenses and receipts">'
    for t, c in names:
        cn = f'<span class="n">{c}</span>' if c else ""
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == "Policy" else "false"}" type="button">{t}{cn}</button>'
    return out + "</div>"


def stepper(cur):
    st = ["Upload", "Review rules", "Simulate", "Publish"]
    out = '<div class="stepper" aria-label="Steps">'
    for i, t in enumerate(st):
        cls = "done" if i < cur else ("cur" if i == cur else "")
        mark = ico("check") if i < cur else f"<b>{i + 1}</b>"
        out += f'<span class="{cls}"{" aria-current=step" if i == cur else ""}>{mark}{t}</span>'
    return out + "</div>"


def head_block(title, cur, right=""):
    return (f'<div class="pad" style="padding-top:20px"><div class="page-head" style="margin-bottom:12px"><div><div class="eyebrow">Payables<span class="sl">//</span>Expenses &amp; receipts</div>'
            f'<h1 class="t-title" style="margin-top:4px">{title}</h1></div><div class="btn-row">{right}</div></div>{ex_tabs()}{stepper(cur) if cur is not None else ""}</div>')


LIT = "3"


def review_frame():
    doc = ""
    for k, t in SENT:
        if k == "h":
            doc += f"</p><h3>{t}</h3><p>"
            continue
        un = k.startswith("U")
        lit = " is-lit" if k == LIT else ""
        doc += f'<span class="sn{" un" if un else ""}{lit}" data-r="{k}" tabindex="0"><span class="tn{" un" if un else ""}" aria-hidden="true">{k}</span>{t}</span> '
    doc = doc.replace("</p><h3>", "<h3>", 1)
    page = (f'<div class="page" aria-label="Policy document, page 2"><div class="ptop"><span>Heartland Heating &amp; Cooling · Travel and Expense Policy · v3 draft</span><span style="white-space:nowrap">Page 2 of 6</span></div>'
            f'{doc}</p></div>')
    rows, g = "", None
    for grp, num, rule, sub, val, sev in RULES:
        if grp != g:
            rows += f'<tr class="grp"><td colspan="5">{grp}</td></tr>'
            g = grp
        lit = " is-lit" if num == LIT else ""
        if sev:
            sv = (f'<span class="seg" role="group" aria-label="If broken"><button type="button" aria-pressed="{"true" if sev == "WARN" else "false"}">Warn</button>'
                  f'<button type="button" aria-pressed="{"true" if sev == "BLOCK" else "false"}">Block</button></span>')
        else:
            sv = '<span class="t-cap">Routing</span>' if num == "9" else '<span class="t-cap">Rate</span>'
        acc = '<button class="btn btn--quiet" type="button" style="height:32px">Edit</button>' if num == LIT else f'<span class="acc">{ico("check")}Kept</span>'
        rows += (f'<tr class="rr{lit}" data-r="{num}" tabindex="0"><td style="width:36px"><span class="tn">{num}</span></td><td><span class="k">{rule}</span><span class="s">{sub}</span></td>'
                 f'<td class="v">{val}</td><td>{sv}</td><td style="text-align:right">{acc}</td></tr>')
    table = (f'<table class="tbl tbl-r" aria-label="Proposed rules"><colgroup><col style="width:40px"><col><col style="width:120px"><col style="width:132px"><col style="width:80px"></colgroup>'
             f'<thead><tr><th></th><th>Rule</th><th>Value</th><th>If broken</th><th></th></tr></thead><tbody>{rows}</tbody></table>')
    um = "".join(f'<li data-r="{k}"><span class="tn un">{k}</span><span><span class="q">{q}</span><span class="s">{why}</span></span>'
                 f'<button class="btn btn--quiet" type="button" style="height:32px">Keep as guidance</button></li>' for k, q, why in UNMAPPED)
    right = f"""<div class="rules-p"><div><div class="sec-h" style="align-items:center"><h2 class="t-section">9 rules the engine will enforce</h2><span class="tag tag--ai">Read by AI · 6 pages</span></div>
<p class="ink-2" style="margin-top:4px">Each rule carries the number of the sentence it came from. Hover either side and both light up. Nothing applies until you publish.</p></div>
{table}
<div><div class="sec-h"><h3 class="t-head">4 clauses it won’t enforce</h3><span class="t-cap">Kept word for word · never turned into a rule</span></div><ul class="um" aria-label="Clauses not enforced">{um}</ul></div></div>"""
    main = (ctxline(["Tue Oct 20", "Expense policy v2 active since Jan 1", "<b>v3 draft · uploaded 9:12 AM</b>"]) +
            head_block("Expense policy", 1, btn("Discard draft", "quiet") + btn("Simulate on 90 days", "primary", "S", "", 'data-say="Simulated on 412 lines"')) +
            f'<div class="rv" style="height:calc(100% - 252px)"><div class="docpane">{page}</div>{right}</div>')
    return app("client", "density-cockpit", jordan_rail("Expenses & receipts"),
               bar(ctx_client("Heartland Heating & Cooling", "C-103", "Oct open"), "Payables / Expenses &amp; receipts / <b>Policy</b>", cmd="Jump to employee, report, rule…", sync="Synced 9:20 AM"),
               main, 1330, live=True)


def publish_frame():
    mx = max(max(a, b) for _, a, b, _ in SIM)
    rows = ""
    for lbl, a, b, blk in SIM:
        rows += (f'<tr><td>{lbl}</td><td class="n">{a}</td><td class="n b{" neg" if blk else ""}">{b}</td>'
                 f'<td><span class="dv"><span class="sr">version 2 {a}, version 3 {b}</span><span class="bars" aria-hidden="true" style="grid-column:1/-1">'
                 f'<span class="o" style="width:{a / mx * 100:.0f}%"></span><span class="n{" blk" if blk else ""}" style="width:{b / mx * 100:.0f}%"></span></span></span></td></tr>')
    rows += f'<tr class="fs-sub"><td><b>Warn</b> · <b class="neg">Block</b></td><td class="n">{V2W} · {V2B}</td><td class="n b">{V3W} · <span class="neg">{V3B}</span></td><td></td></tr>'
    sim = (f'<table class="tbl tbl-sim" aria-label="Flags by rule, version 2 vs version 3"><colgroup><col style="width:220px"><col style="width:64px"><col style="width:64px"><col></colgroup>'
           f'<thead><tr><th>Rule</th><th class="n">v2</th><th class="n">v3</th><th><span class="lgd"><span><i style="background:var(--grey-300)"></i>v2</span><span><i style="background:var(--electric)"></i>v3 warn</span><span><i style="background:var(--neg)"></i>v3 block</span></span></th></tr></thead><tbody>{rows}</tbody></table>')
    teams = "".join(f'<span><b>{t}</b> {n}</span>' for t, n in TEAMS)
    left = f"""<div><div class="sec"><div class="sec-h"><h2>What version 3 would have done · Jul 22 – Oct 19</h2><span class="t-cap">Deterministic · same engine that runs at submit</span></div>
<div class="strip"><div><span class="eyebrow">Lines checked</span><span class="v">412</span><span class="t-cap">37 people · {f2(58214.30)}</span></div>
<div><span class="eyebrow">Would warn</span><span class="v">{V3W}</span><span class="t-cap">v2: {V2W}</span></div>
<div><span class="eyebrow">Would block</span><span class="v neg">{V3B}</span><span class="t-cap">v2: {V2B}</span></div>
<div><span class="eyebrow">Most flagged</span><span class="v">Field service</span><span class="t-cap">14 of {V3W + V3B}</span></div></div>
<div style="margin-top:16px">{sim}</div>
<p class="t-cap" style="margin-top:8px">By team: {" · ".join(f"{t} {n}" for t, n in TEAMS)} = {V3W + V3B}. Lodging is the change people will feel: the cap drops from 189.00 to 159.00.</p></div>
<article class="note" style="margin-top:0"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Read before publishing</div><div class="note-title">Four of the six blocks are tickets and fines, already refused by hand</div></div></div>
<p>Nothing that was paid under v2 would have been blocked except two customer gifts in August (Sales, 40.00 and 65.00). Version 3 would have sent those for pre-approval first.</p></article></div>"""
    right = f"""<div><div class="sec"><div class="sec-h"><h2>Publish</h2><span class="ih ov"><i></i>Heartland only</span></div>
<div class="pubrow"><span>Version</span><b>3</b></div>
<div class="pubrow"><span>Effective</span><b>Sun Nov 1, 2026</b></div>
<div class="pubrow"><span>Applies to</span><span style="text-align:right">Heartland Heating &amp; Cooling<br><span class="t-cap">Merit’s default stays on v2 for other clients</span></span></div>
<div class="pubrow"><span>Ask to acknowledge</span><b>{EMP} employees · by Nov 1</b></div>
<div class="pubrow"><span>Until acknowledged</span><span class="seg" role="group" aria-label="Until acknowledged"><button type="button" aria-pressed="true">Flag</button><button type="button" aria-pressed="false">Block submit</button></span></div>
<div class="fup">{ico("alert")}<span><b>Follow-up after publishing:</b> 3 Ramp cards have no cardholder, so the receipt rule can’t chase their charges. <a class="link" href="#">Map cards</a></span></div>
<button class="btn btn--primary btn--lg" type="button" style="width:100%;margin-top:16px" data-say="Published version 3 · effective Nov 1 · 41 employees asked to acknowledge">Publish version 3</button>
<p class="t-cap" style="margin-top:8px">Version 2 archives on Oct 31. Old reports keep the rules they were submitted under.</p></div></div>"""
    main = (ctxline(["Tue Oct 20", "Expense policy", "<b>v3 draft · simulate</b>"]) + head_block("Expense policy", 2, btn("Back to rules", "quiet")) +
            f'<div class="sp">{left}{right}</div>')
    return app("client", "density-cockpit", jordan_rail("Expenses & receipts"),
               bar(ctx_client("Heartland Heating & Cooling", "C-103", "Oct open"), "Payables / Expenses &amp; receipts / <b>Policy</b>", cmd="Jump to employee, report, rule…", sync="Synced 9:24 AM"),
               main, 960)


def ack_frame():
    prog = "".join(f'<i class="{"on" if i < ACKED else ""}"></i>' for i in range(EMP))
    pending = [("Field service", 6), ("Install", 4), ("Sales", 2)]
    assert sum(p[1] for p in pending) == EMP - ACKED
    left = f"""<div><div class="sec"><div class="sec-h"><h2>Versions</h2><button class="btn btn--quiet" type="button">{ico("upload")}Upload a new version</button></div>
<ul class="vers"><li><span class="vn">v3</span><span>Published Oct 20 by Jordan Smith · <b>active Nov 1</b><br><span class="t-cap">9 rules · 4 clauses kept as guidance · from “Heartland T&amp;E Policy v3.docx”</span></span>{status("track", "Scheduled")}</li>
<li><span class="vn">v2</span><span>Active since Jan 1, 2026 · until Oct 31<br><span class="t-cap">7 rules · typed in by hand</span></span>{status("ready", "Active")}</li>
<li><span class="vn">v1</span><span>Jan 1, 2025 – Dec 31, 2025<br><span class="t-cap">archived · reports from 2025 keep it</span></span>{status("closed", "Archived")}</li></ul></div></div>"""
    right = f"""<div><div class="sec"><div class="sec-h"><h2>Acknowledged · v3</h2><b class="tnum">{ACKED} of {EMP}</b></div>
<span class="prog" role="img" aria-label="{ACKED} of {EMP} acknowledged">{prog}</span>
<p class="t-cap" style="margin-top:8px">Still to acknowledge: {" · ".join(f"{t} {n}" for t, n in pending)}. Asked on the app Oct 20; reminded Oct 26.</p>
<div class="btn-row" style="margin-top:12px">{btn("Remind 12", "primary", "", "bell", 'data-say="Reminded 12 · in the app, then email"')}{btn("Export list", "quiet", "", "download")}</div></div></div>"""
    main = (ctxline(["Tue Oct 27", "Expense policy", f"<b>{ACKED} of {EMP} acknowledged v3 · effective Sun</b>"]) + head_block("Expense policy", None) +
            f'<div class="ack">{left}{right}</div>')
    return app("client", "density-cockpit", jordan_rail("Expenses & receipts"),
               bar(ctx_client("Heartland Heating & Cooling", "C-103", "Oct open"), "Payables / Expenses &amp; receipts / <b>Policy</b>", cmd="Jump to employee, report, rule…", sync="Synced 8:02 AM"),
               main, 520)


TETHER_JS = """<script>
(function(){function lit(n,on){document.querySelectorAll('[data-r="'+n+'"]').forEach(function(e){e.classList.toggle('is-lit',on)});}
document.querySelectorAll('[data-r]').forEach(function(el){var n=el.getAttribute('data-r');
['mouseenter','focus'].forEach(function(ev){el.addEventListener(ev,function(){document.querySelectorAll('.is-lit[data-r]').forEach(function(x){x.classList.remove('is-lit')});lit(n,true);});});
['mouseleave','blur'].forEach(function(ev){el.addEventListener(ev,function(){lit(n,false);});});});})();
</script>"""


def build():
    html = head("W2 · Expense policy upload", CSS) + sheet_top("W2-expense-policy-upload.html") + '<main id="main" class="sheet">'
    html += board_h("W2", "FPB-workforce-app §5 · 08-ONBOARDING-V2 §11.4 (T7) · EXPENSE_POLICY_EXTRACT · policy-schema.ts",
                    "Jordan’s policy: from a Word document to rules people acknowledge",
                    "Heartland wrote its travel and expense policy in Word. Jordan drops it; the compiler proposes rules in the fixed schema, each tied to the sentence it came from; "
                    "anything the schema can’t express is kept word for word and never enforced. A 90-day simulation shows what would change before anyone is affected. "
                    "Publishing schedules the version and asks every employee in scope to acknowledge it on their phone (W1).")
    html += pair_h("1 · Review rules", "Sentence 3 is lit: the lodging cap. Its second half, 229.00 outside Iowa, can’t be expressed yet, so it’s U2 below.")
    html += frame(review_frame(), "Review state · the source tether is this board’s signature: a shared number, lit together on hover or focus", "9 rules + 4 clauses = every sentence on the page")
    html += anno([("Config, not code", "The compiler can only fill the fixed ruleset schema: caps in cents, severities, tiers. It never writes logic, so a misread is a wrong number you can see, not a behaviour you can’t."),
                  ("Every rule has a source", "The number on a rule is the number on its sentence. Reviewing is reading the two side by side, not trusting a summary."),
                  ("What it can’t do, it says", "Four clauses have no home in the schema yet. They stay as guidance, listed, so nobody assumes the system enforces them."),
                  ("AI paused?", "The same review screen opens empty with the document beside it. Jordan types the nine values; everything after is deterministic.")])
    html += pair_h("2 · Simulate and publish", "The engine that checks each expense at submit runs over the last 90 days, so the effect is known before the switch.")
    html += frame(publish_frame(), "Simulate state · v2 vs v3 on the same 412 lines", f"Ties: warn {V3W} + block {V3B} = {V3W + V3B} = field service 14 + install 9 + sales 6")
    html += anno([("Effect before switch", "Twenty-three warnings and six blocks, against seventeen and two today. The lodging cap is the change people will notice."),
                  ("Scoped, inherited", "Heartland overrides Merit’s default. Other clients stay on v2 until their own controller publishes."),
                  ("Follow-ups, not surprises", "Rules that need missing data say so: three cards with no cardholder can’t be chased."),
                  ("History is kept", "Version 2 archives on Oct 31. A report keeps the rules it was submitted under, so an audit sees what applied then.")])
    html += pair_h("3 · A week later", "Policy tab, Oct 27. Who has acknowledged version 3, and a reminder for the rest.")
    html += frame(ack_frame(), "Acknowledgment progress · each mark is one employee", f"{ACKED} + 12 = {EMP}")
    html += anno([("Acknowledged, with proof", "Each acknowledgment stores the version, the date and the document’s fingerprint. W1 screen 10 is where Andre gives his."),
                  ("Budgets come in the same way", "A budget spreadsheet goes to Budgets · Plan · Import: the existing deterministic loader, previewed before it writes. The budget cycle is in FPB-reports-fpna."),
                  ("Onboarding uses this screen", "A policy dropped during client setup (08 §11.4, T7) opens here instead of landing in Documents."),
                  ("One reminder engine", "The acknowledgment reminder rides the same request engine as receipts and vendor documents.")])
    html += foot().replace("</body></html>", TETHER_JS + "</body></html>")
    return html


if __name__ == "__main__":
    open("../W2-expense-policy-upload.html", "w").write(build())
    print("ok", V3W, V3B)
