"""S22 — Receipt chase, bookkeeper/manager side (IA-SPEC 4.1 exp.missing_receipts, 3.6.1 Expenses & receipts,
3.8.2 #5 Cards & receipt chase, 6.2 receipt chase loop, M-7, M-11)."""
from fo_common import *
from s21 import MISSING as TOM, MISSING_TOTAL as TOM_TOTAL

CSS = """
/* S22 layout only */
.wg .tbl-q th{background:var(--white)}
.strip{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);background:var(--white)}
.strip>div{padding:12px 16px;border-right:1px solid var(--line);min-width:0}
.strip>div:last-child{border-right:0}
.strip .v{display:block;font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.strip .t-cap{display:block}
.pad{padding:0 var(--margin)}
/* signature: the cadence track — day 0 / 2 / 5 / 10 as the brand's slash */
.trk{position:relative;display:block;height:24px;width:100%;min-width:0}
.trk::before{content:"";position:absolute;left:0;right:0;top:11px;height:1px;background:var(--line-2)}
.trk i{position:absolute;top:4px;width:4px;height:16px;margin-left:-2px;transform:skewX(-30deg);background:var(--electric)}
.trk i.up{background:var(--white);box-shadow:inset 0 0 0 1px var(--electric)}
.trk i.esc{background:var(--neg)}
.trk i.esc.up{background:var(--white);box-shadow:inset 0 0 0 1px var(--neg)}
.trk i.ps{background:var(--grey-300)}
.trk b{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--midnight)}
.trk b::after{content:attr(data-d);position:absolute;top:-1px;left:5px;font:600 12px/12px var(--f-text);color:var(--ink);white-space:nowrap;background:var(--white);padding:0 2px}
.trk b.fl::after{left:auto;right:5px}
.trk-ax{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--ink-3)}
.lg{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:12px;line-height:16px;color:var(--ink-2)}
.lg span{display:inline-flex;align-items:center;gap:6px}
.lg i{display:inline-block;width:4px;height:14px;transform:skewX(-30deg);background:var(--electric)}
.lg i.up{background:var(--white);box-shadow:inset 0 0 0 1px var(--electric)}
.lg i.esc{background:var(--neg)}
.lg i.ps{background:var(--grey-300)}
.sub td{background:var(--white)}
.sub td:first-child{padding-left:36px!important}
.qa{text-align:right;white-space:nowrap}
.qa .btn{margin-left:4px}
.split{display:grid;grid-template-columns:minmax(0,1fr) 352px;min-height:0}
.split>section{min-width:0;display:flex;flex-direction:column}
.wgs{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:136px;gap:24px;margin-top:24px}
.lbl{display:block;margin-bottom:8px}
.cfg{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:32px;padding:24px var(--margin) 32px}
.sec{border-top:2px solid var(--electric);padding-top:12px;margin-bottom:28px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.sec-h h2{font:600 15px/24px var(--f-text)}
.inh{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--ink-3);white-space:nowrap}
.inh.ov{color:var(--electric);font-weight:600}
.frm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:12px}
.days{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.day{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--line-2);background:var(--white);font-weight:600;font-variant-numeric:tabular-nums}
.day.esc{border-color:var(--neg);color:var(--neg)}
.msg{padding:16px;background:var(--canvas);border-left:3px solid var(--electric)}
.msg .bub{margin-top:8px;padding:12px 14px;background:var(--white);border:1px solid var(--line);max-width:320px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
"""

# --------------------------------------------------------------- data (Clive, 14 Ramp cards)
HOLDERS = [  # name, card, role, charges, amount, oldest_day, sent, state, escalate_to, note
    ("Marcus Dunn", "••4433", "Field tech", 4, 1388.90, 21, 4, "paused", "Rob Hartley", "Out until Fri · paused Oct 12"),
    ("Rob Hartley", "••4402", "Owner", 2, 1206.15, 15, 5, "esc", "Jordan Smith", "Owner · goes to Merit"),
    ("Tom Becker", "••4410", "Parts & service", 3, TOM_TOTAL, 10, 4, "esc", "Rob Hartley", "Escalated today"),
    ("Kyle Meyer", "••4417", "Sales", 2, 812.44, 6, 3, "rem", "Rob Hartley", "Next Wed, day 10"),
    ("Jess Alvarez", "••4421", "Office", 1, 64.30, 1, 1, "new", "Rob Hartley", "Next Tue, day 2"),
]
N_CH = sum(h[3] for h in HOLDERS)
TOTAL = round(sum(h[4] for h in HOLDERS), 2)
assert N_CH == 12 and abs(TOTAL - 4069.08) < .001, (N_CH, TOTAL)
SEP_UNSUP = 902.10  # 2 of Marcus's charges are dated September
CARDS = 14
CAUGHT_UP = CARDS - len(HOLDERS) - 1  # one new card is unmapped
EXCUSED_UNDER = 31


def trk(day, sent, state, scale=22, paused_from=14):
    pts = [0, 2, 5, 10, 15, 20]
    out = '<span class="trk" aria-hidden="true">'
    shown_next = False
    for p in pts:
        cls = []
        if p <= day and not (state == "paused" and p > paused_from):
            cls = ["esc"] if p >= 10 else []
        elif state == "paused" and p > paused_from and p <= day + 5:
            cls = ["ps"]
        elif not shown_next:
            cls = ["esc", "up"] if p >= 10 else ["up"]
            shown_next = True
        else:
            continue
        out += f'<i class="{" ".join(cls)}" style="left:{p / scale * 100:.2f}%"></i>'
    pos = min(day, scale) / scale * 100
    fl = ' class="fl"' if pos > 80 else ""
    out += f'<b{fl} style="left:{pos:.2f}%" data-d="{day}"></b></span>'
    return out


def trk_label(day, sent, state, to):
    if state == "paused":
        return f"Day {day} · {sent} sent · paused"
    if state == "esc":
        return f"Day {day} · {sent} reminders sent · escalated to {to}"
    return f"Day {day} · {sent} reminder{'s' if sent != 1 else ''} sent"


def dana_rail(cur):
    uses = {"Purchase orders", "Payroll", "Inventory", "Debt & covenants", "Customer deposits"}
    drop = {"Budgets", "FP&A & scenarios", "More · 2", "Compliance & SOX", "AI decision log", "More · Agents", "Approvals"}
    keep = {it for _, items in CLIENT_TREE for it in items} - drop
    counts = {"To review": 18, "Requests": 3, "Close": "14/22", "Reconciliation": 3, "Expenses & receipts": "!12"}
    return rail(client_nav(uses, cur, counts, keep=keep), "Dana Lee", "Bookkeeper · Clive")


def tabs(sel):
    names = [("Receipts", ""), ("Missing receipts", str(N_CH)), ("Expense reports", "3"), ("Approvals", ""), ("Reimbursements", "1"), ("Policy", "")]
    out = '<div class="tabs" role="tablist" aria-label="Expenses and receipts">'
    for t, c in names:
        cn = f'<span class="n">{c}</span>' if c else ""
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}{cn}</button>'
    return out + "</div>"


# --------------------------------------------------------------- frame 1: Missing receipts tab
def missing_frame():
    strip = f"""<div class="strip"><div><span class="eyebrow">Missing now</span><span class="v">{f2(TOTAL)}</span><span class="t-cap">{N_CH} charges · 5 cardholders</span></div>
<div><span class="eyebrow">September, unsupported</span><span class="v warn">{f2(SEP_UNSUP)}</span><span class="t-cap">2 charges · counts in step 3 Check</span></div>
<div><span class="eyebrow">Caught up</span><span class="v">{CAUGHT_UP} of {CARDS} cards</span><span class="t-cap">1 new card not mapped</span></div>
<div><span class="eyebrow">Not required · under 25.00</span><span class="v">{EXCUSED_UNDER}</span><span class="t-cap">excused by policy this month</span></div></div>"""
    rows = ""
    for name, card, role, n_, amt, day, sent, state, to, note in HOLDERS:
        attn = " is-attn" if state == "esc" else ""
        cur = " is-cursor" if name == "Tom Becker" else ""
        if state == "paused":
            act = '<button class="btn" type="button">Resume now</button>'
        elif state == "esc":
            act = '<button class="btn" type="button">Nudge now</button>'
        else:
            act = '<button class="btn" type="button">Nudge now</button>'
        rows += (f'<tr class="q-row{attn}{cur}"><td><span class="l1">{name}</span><span class="l2">{card} · {role}</span></td>'
                 f'<td class="n">{n_}</td><td class="n">{f2(amt)}</td>'
                 f'<td><span class="sr">{trk_label(day, sent, state, to)}</span>{trk(day, sent, state)}</td>'
                 f'<td><span class="l1{" neg" if state == "esc" else (" ink-2" if state == "paused" else "")}" style="font-weight:500">{note}</span><span class="l2">Then {to}</span></td>'
                 f'<td class="qa">{act}</td></tr>')
        if name == "Tom Becker":
            for m, d, a, dd, rem, st, cat in TOM:
                stt = "esc" if st == "escalated" else ("new" if st == "new" else "rem")
                rows += (f'<tr class="q-row sub"><td><span class="l1">{m.replace(" General Store", "")}</span><span class="l2">{d[4:]} · {cat}</span></td><td class="n"></td><td class="n">{f2(a)}</td>'
                         f'<td><span class="sr">{trk_label(dd, rem, stt, "Rob Hartley")}</span>{trk(dd, rem, stt)}</td>'
                         f'<td><span class="l2">{"Texted today" if st == "new" else ("Rob told today" if st == "escalated" else "Next Wed")}</span></td>'
                         f'<td class="qa"><button class="btn btn--quiet" type="button">Not required…</button></td></tr>')
    rows += f'<tr class="q-group"><td><span class="q-group-t">{CAUGHT_UP} caught up</span></td><td class="n b">{N_CH}</td><td class="n b">{f2(TOTAL)}</td><td colspan="3"></td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Missing receipts by cardholder">'
             f'<colgroup><col style="width:176px"><col style="width:48px"><col style="width:96px"><col style="width:184px"><col><col style="width:160px"></colgroup>'
             f'<thead><tr><th>Cardholder · oldest first</th><th class="n">Open</th><th class="n">Amount</th><th>Reminders by day</th><th>Where it stands</th><th></th></tr></thead><tbody>{rows}</tbody></table>')
    lg = ('<div class="lg"><span><i></i>Reminder sent</span><span><i class="up"></i>Next reminder</span><span><i class="esc"></i>Escalated at day 10</span>'
          '<span><i class="ps"></i>Paused</span><span><b style="display:inline-block;width:2px;height:14px;background:var(--midnight)"></b>Today</span></div>')
    sec = f"""<section>
<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Expenses &amp; receipts</div><h1 class="t-title" style="margin-top:4px">Missing receipts</h1></div>
<div class="btn-row">{btn("Policy & cadence", "quiet", "", "sliders")}{btn("Nudge all due", "primary", "N")}</div></div>{tabs("Missing receipts")}</div>
<div class="pad" style="padding-top:16px">{strip}</div>
<div class="pad row row--between" style="padding-top:16px;padding-bottom:8px"><span class="t-cap">Receipts required over 25.00 · the chase never stops until a charge is matched or excused</span>{lg}</div>
<div style="flex:1;min-height:0;overflow:auto">{table}</div>
<div class="keybar" style="white-space:nowrap"><span class="ph-k"><span class="kbd">J</span><span class="kbd">K</span>move</span><span class="ph-k"><span class="kbd">Enter</span>open charges</span><span class="ph-k"><span class="kbd">N</span>nudge</span><span class="ph-k"><span class="kbd">E</span>escalate</span><span class="ph-k"><span class="kbd">X</span>not required</span><span class="sp"></span><span>Matched receipts leave this list by themselves</span></div></section>"""
    note = f"""<aside class="panel" aria-label="Note on September"><div class="panel-head"><div class="eyebrow">Period end<span class="sl">//</span>September close</div><span class="t-head">What happens to unsupported spend</span></div>
<div class="panel-body"><div class="panel-sec"><article class="note" style="border-top:0;padding-top:0"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Step 3 · Check</div><div class="note-title">2 September charges have no receipt</div></div></div>
<p>Both are Marcus Dunn’s, and he’s out until Friday. Close is due <b>Wed Oct 21</b>, so they will still be open.</p>
<ul class="ev"><li>Sep 28 · Fastenal · shop supplies<span class="dl"></span><span class="v">{f2(611.45)}</span></li><li>Sep 30 · Casey’s · fuel<span class="dl"></span><span class="v">{f2(290.65)}</span></li>
<li class="ev-total">Unsupported in September<span class="dl"></span><span class="v">{f2(SEP_UNSUP)}</span></li></ul>
<div class="basis"><span>Policy: <b>post and flag</b>, don’t hold the close</span><span>Coded from vendor memory</span></div>
<div class="note-acts"><button class="btn btn--quiet" type="button">Ask Rob to approve without receipts</button></div></article></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Rob Hartley’s own charges</h3></div><p class="ink-2">The owner can’t approve his own missing receipts. They escalate to Jordan Smith at Merit, per the firm’s policy.</p></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>New card</h3></div><p class="ink-2">Ramp ••4440 was issued Oct 15 with no cardholder. Its 2 charges can’t be chased until it’s mapped.</p><button class="btn" type="button" style="margin-top:8px">Map ••4440…</button></div></div></aside>"""
    assert abs(611.45 + 290.65 - SEP_UNSUP) < .001
    main = (ctxline(["Mon Oct 19", "September close", "Due Wed Oct 21", f"<b>{N_CH} receipts missing · 2 from September</b>"]) +
            f'<div class="split" style="height:calc(100% - 32px)">{sec}{note}</div>')
    return app("client", "density-cockpit", dana_rail("Expenses & receipts"), bar(ctx_client("Clive Power Equipment", "C-102"), "Payables / Expenses &amp; receipts / <b>Missing receipts</b>", cmd="Jump to vendor, cardholder, charge…", sync="Synced 9:38 AM"),
               main, 900, live=True)


# --------------------------------------------------------------- widgets: exp.missing_receipts states
def widgets():
    # bookkeeper (Dana) across her clients
    rows = [("Clive Power Equipment", 12, 4069.08, "2 escalated · 2 from Sep", True), ("Heritage Interiors", 3, 402.18, "all within cadence", False),
            ("Swan Creek", 1, 88.20, "day 2", False), ("Wild Rose Interiors", 0, 0, "caught up", False)]
    tr = ""
    for c, k, a, s, at in rows:
        tr += (f'<tr class="q-row{" is-attn" if at else ""}" data-drill="{c} · Missing receipts"><td><span class="l1">{c}</span><span class="l2{" neg" if at else ""}">{s}</span></td>'
               f'<td class="n">{k if k else "—"}</td><td class="n">{f2(a) if a else "—"}</td></tr>')
    tot = round(sum(r[2] for r in rows), 2)
    body = (f'<table class="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Receipts to chase by client"><colgroup><col><col style="width:56px"><col style="width:104px"></colgroup>'
            f'<thead><tr><th>Client</th><th class="n">Open</th><th class="n">Amount</th></tr></thead><tbody>{tr}</tbody></table>'
            f'<div class="wg-body--pad" style="padding-top:12px"><span class="t-cap">Unsupported at period end · Clive 902.10 · counts toward Check</span></div>')
    foot = f'<span>16 charges · {f2(tot)} · last reminders 9:00 AM</span>{btn("Nudge 9 due", "primary")}'
    w1 = wg("exp.missing_receipts", "Receipts to chase", body, 1, 1, 6, 2, count="16", meta="My clients", foot=foot, label_id="w-mr1")
    # manager team view
    rows2 = [("Clive Power Equipment", "Dana Lee", 12, 4069.08), ("Crystal Kitchen & Bath", "Dana Lee", 9, 2210.40), ("Artistry Homes", "Priya Natarajan", 7, 1918.75),
             ("Heartland Heating & Cooling", "Sam Kovac", 4, 611.02)]
    tr2 = "".join(f'<tr class="q-row" data-drill="{c}"><td><span class="l1">{c}</span><span class="l2">{p}</span></td><td class="n">{k}</td><td class="n">{f2(a)}</td></tr>' for c, p, k, a in rows2)
    body2 = (f'<table class="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Receipts to chase across the team"><colgroup><col><col style="width:56px"><col style="width:104px"></colgroup>'
             f'<thead><tr><th>Client · most unsupported first</th><th class="n">Open</th><th class="n">Amount</th></tr></thead><tbody>{tr2}</tbody></table>')
    foot2 = '<span>9 other clients within cadence</span><a class="btn btn--quiet" href="#">All clients' + ico("right") + '</a>'
    w2 = wg("exp.missing_receipts", "Receipts to chase · team", body2, 7, 1, 6, 2, count="32", meta="Jordan Smith · all clients", foot=foot2, label_id="w-mr2")
    done = (f'<div class="wg-state"><span class="wg-done-mark">{ico("check")}</span><p class="t-head">Every charge over 25.00 has a receipt.</p>'
            f'<p>Wild Rose Interiors · 6 cards · statement closes Oct 31. Reminders ran 9:00 AM.</p></div>')
    w3 = wg("exp.missing_receipts", "Receipts to chase", done, 1, 3, 6, 2, meta="Done state", label_id="w-mr3")
    empty = (f'<div class="wg-state"><span class="wg-empty-mark">{ico("card")}</span><p class="t-head">Map cards to cardholders to start chasing.</p>'
             f'<p>Swan Creek has 3 card accounts from Plaid with no cardholder, so nobody can be asked for a receipt.</p></div>')
    foot4 = f'<span>Client settings · Cards &amp; receipt chase</span>{btn("Map 3 cards")}'
    w4 = wg("exp.missing_receipts", "Receipts to chase", empty, 7, 3, 6, 2, meta="Empty state", foot=foot4, label_id="w-mr4")
    late = ('<div class="inline-notice inline-notice--warn" style="margin-top:24px">' + ico("alert") +
            '<span><b>Late job state.</b> If the 9:00 AM reminder run doesn’t finish, the widget’s foot turns to “Reminders didn’t run · last ran Sun 9:00 AM” in ochre, '
            'so a stopped chase can’t hide behind a calm number (IA §4.0 rule 9).</span></div>')
    return f'<div class="wgs density-cockpit">{w1}{w2}{w3}{w4}</div>{late}'


# --------------------------------------------------------------- frame 3: client settings · cards & receipt chase
def settings_frame():
    cards = [("Ramp ••4402", "Rob Hartley", "Owner", "Jordan Smith (Merit)"), ("Ramp ••4410", "Tom Becker", "Parts & service", "Rob Hartley"),
             ("Ramp ••4417", "Kyle Meyer", "Sales", "Rob Hartley"), ("Ramp ••4421", "Jess Alvarez", "Office", "Rob Hartley"),
             ("Ramp ••4433", "Marcus Dunn", "Field tech", "Rob Hartley"), ("Ramp ••4440", "", "", "")]
    tr = ""
    for c, h, r, esc in cards:
        if h:
            tr += (f'<tr class="q-row"><td class="tnum b">{c}</td><td><span class="l1">{h}</span><span class="l2">{r}</span></td><td>{esc}</td>'
                   f'<td>{status("ready", "Chasing")}</td></tr>')
        else:
            tr += (f'<tr class="q-row is-attn"><td class="tnum b">{c}</td><td><select class="select" aria-label="Cardholder for ••4440"><option>Choose a person…</option><option>Ben Ortiz · new hire</option></select></td>'
                   f'<td class="ink-3">—</td><td>{status("blocked", "Not mapped")}</td></tr>')
    tr += f'<tr class="q-group"><td colspan="4"><span class="q-group-t">8 more cards</span><span class="ink-3">all mapped · from Ramp, synced 6:00 AM</span></td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Cards and cardholders"><colgroup><col style="width:120px"><col><col style="width:184px"><col style="width:128px"></colgroup>'
             f'<thead><tr><th>Card</th><th>Cardholder</th><th>Escalates to</th><th>Status</th></tr></thead><tbody>{tr}</tbody></table>')
    left = f"""<div>
<div class="sec"><div class="sec-h"><h2>Cards → cardholders</h2><span class="inh">{ico("card")}14 cards · 1 not mapped</span></div><p class="t-cap" style="margin:4px 0 12px">A cardholder is asked for receipts on their own charges only. They see nothing else in the books.</p>{table}</div>
<div class="sec"><div class="sec-h"><h2>When a receipt is required</h2><span class="inh ov">{ico("branch")}Overridden for Clive · Merit default 75.00</span></div>
<div class="frm"><div class="field"><label class="field-label" for="t1">Receipt required over</label><input class="input input--money" id="t1" value="25.00"><span class="field-help">Under this, charges are excused automatically</span></div>
<div class="field"><label class="field-label" for="t2">Itemized receipt for meals over</label><input class="input input--money" id="t2" value="75.00"><span class="field-help">Attendees asked on every meal</span></div>
<div class="field"><label class="field-label" for="t3">Auto-approve matched receipts under</label><input class="input input--money" id="t3" value="100.00"><span class="field-help">Over this, Dana reviews the match</span></div></div></div>
<div class="sec"><div class="sec-h"><h2>Cadence &amp; escalation</h2><span class="inh">{ico("inherit")}Following Merit default</span></div>
<div class="days" aria-label="Reminder days"><span class="day">Day 0</span><span class="day">Day 2</span><span class="day">Day 5</span><span class="day esc">Day 10 · escalate</span>{btn("Add a day", "quiet", "", "plus")}</div>
<div class="frm"><div class="field"><label class="field-label" for="e1">Escalate to</label><select class="select" id="e1"><option>Cardholder’s approver</option></select><span class="field-help">Owner’s own charges go to the firm reviewer</span></div>
<div class="field"><label class="field-label" for="e2">After escalation</label><select class="select" id="e2"><option>Keep reminding every 5 days</option></select><span class="field-help">Never stops until matched or excused</span></div>
<div class="field"><label class="field-label" for="e3">At period end</label><select class="select" id="e3"><option>Post and flag in Check</option><option>Hold the close</option></select><span class="field-help">Unsupported spend shows in step 3</span></div></div></div>
<div class="sec"><div class="sec-h"><h2>Quiet hours &amp; channels</h2><span class="inh">{ico("inherit")}Following Merit default</span></div>
<div class="frm"><div class="field"><label class="field-label" for="q1">No messages between</label><input class="input" id="q1" value="8:00 PM – 7:00 AM"><span class="field-help">Cardholder’s time zone · Central</span></div>
<div class="field"><span class="field-label">Channels, in order</span><div class="chips"><label class="check"><input type="checkbox" checked><i></i>Text</label><label class="check"><input type="checkbox" checked><i></i>App push</label><label class="check"><input type="checkbox" checked><i></i>Email</label></div></div>
<div class="field"><span class="field-label">Bundling</span><label class="switch"><input type="checkbox" checked><i></i>One message for everything due</label></div></div></div>
</div>"""
    right = f"""<div><div class="msg"><div class="eyebrow">Preview<span class="sl">//</span>day 0 text to Tom Becker</div>
<div class="bub">Receipt for O’Reilly Auto Parts, 186.40? Your Ramp card ••4410 was charged today at 2:14 PM. Snap the receipt: mbks.co/r/7hQ2</div>
<p class="t-cap" style="margin-top:8px">From “Clive Power Equipment” · Reply STOP to opt out of texts; email and push continue</p></div>
<div class="msg" style="margin-top:16px;border-left-color:var(--neg)"><div class="eyebrow">Preview<span class="sl">//</span>day 10 escalation to Rob Hartley</div>
<div class="bub">Tom Becker hasn’t sent a receipt for Menards, 342.77 (Oct 9). Approve without a receipt, or nudge Tom: mbks.co/r/9pW4</div></div>
<div class="inline-notice inline-notice--info" style="margin-top:16px">{ico("info")}<span><b>Changes apply to new reminders.</b> Charges already in the chase keep their schedule, so no one gets two texts at once.</span></div>
<div class="btn-row" style="margin-top:16px">{btn("Save", "primary")}{btn("Use Merit defaults")}</div></div>"""
    body = (f'<div class="pad" style="padding-top:24px"><div class="eyebrow">Client settings<span class="sl">//</span>5 of 14</div><h1 class="t-title" style="margin-top:4px">Cards &amp; receipt chase</h1></div>'
            f'<div class="cfg">{left}{right}</div>')
    main = ctxline(["Mon Oct 19", "Clive Power Equipment", "Client settings", "<b>1 card not mapped</b>"]) + body
    return app("client", "density-cockpit", dana_rail("Client settings"), bar(ctx_client("Clive Power Equipment", "C-102"), "Client settings / <b>Cards &amp; receipt chase</b>", cmd="Find a setting…", sync="Synced 9:38 AM"),
               main, 1260)


def build():
    html = head("S22 · Receipt chase", CSS) + sheet_top("S22-receipt-chase.html") + '<main id="main" class="sheet">'
    html += board_h("S22", "IA-SPEC §4.1 exp.missing_receipts · §3.8.2 #5 · §6.2 receipt chase",
                    "Dana’s chase board: who owes which receipt, and how hard it’s been asked for",
                    "The chase engine does the asking. The bookkeeper sees the state of it: every cardholder with open charges, where each sits on the day 0 / 2 / 5 / 10 cadence, "
                    "who it escalates to, and what September’s close inherits if receipts don’t arrive. Policy lives in Client settings, with what Clive overrides from Merit’s default in view.")
    html += pair_h("1 · Missing receipts", "Clive Power Equipment · Expenses &amp; receipts · Missing receipts tab. Tom Becker’s row is open; his three charges are the ones on his phone in S21.")
    html += frame(missing_frame(), "Open state · grouped by cardholder, oldest first · the cadence track is this board’s signature", f"Ties: {N_CH} charges = {f2(TOTAL)} · Tom {f2(TOM_TOTAL)} = S21")
    html += anno([("The track says how hard", "Each slash is a reminder on the cadence: filled sent, hollow next, red the escalation. The bar is today. You read a row’s history without opening it."),
                  ("Exceptions are rules, not alarms", "Marcus is out, so his chase pauses and resumes Monday. Rob’s own charges escalate to Merit, because an owner can’t excuse himself."),
                  ("The close knows", "September’s 902.10 without receipts doesn’t block the close; per policy it posts and appears in step 3 Check with the note."),
                  ("Small things excused", f"{EXCUSED_UNDER} charges under 25.00 were excused by policy this month. They’re counted, never chased.")])
    html += pair_h("2 · The widget, four ways", "exp.missing_receipts on the bookkeeper home (S1), the manager’s team view (S5), its done state and its empty state.")
    html += widgets()
    html += pair_h("3 · Policy &amp; cadence", "Client settings · Cards &amp; receipt chase (IA §3.8.2 #5). Every area says whether it follows Merit’s default or overrides it.")
    html += frame(settings_frame(), "Client settings area 5 of 14 · reached from the gear at the foot of the client nav, or Policy & cadence on the tab", "Inheritance marks match S27")
    html += anno([("Map, then chase", "Cards come from Ramp and Plaid; a person is attached here. An unmapped card is the first row, because nothing can be chased without it."),
                  ("Overrides are visible", "Clive asks for receipts over 25.00 where Merit’s default is 75.00. The mark says so and offers the default back."),
                  ("You see the words", "The text and the escalation are previewed with real names and amounts, so tone is a decision, not a surprise."),
                  ("One engine", "Receipt chase runs on the same request and reminder engine as client questions, W-9s and PBC (IA decision 16). Only the policy differs.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../S22-receipt-chase.html", "w").write(build())
    print("ok", N_CH, TOTAL)
