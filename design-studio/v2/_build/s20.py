"""S20 — Check processor home + pay runs (IA-SPEC 4.11, 3.6.1 Pay runs & checks, 6.2 procure-to-pay)."""
from fo_common import *

CSS = """
/* S20 layout only */
.wg .tbl-q th{background:var(--white)}
.qrow-act{text-align:right}
.qrow-act .btn{margin-left:4px}
.held td .l1{color:var(--ink-2)}
.pipe{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--line);background:var(--white)}
.pipe li{list-style:none;position:relative;padding:12px 16px 14px;border-right:1px solid var(--line);min-width:0}
.pipe li:last-child{border-right:0}
.pipe .no{font:700 20px/28px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric)}
.pipe .lb{display:block;font-weight:600;margin-top:2px}
.pipe .who{display:block;font-size:12px;line-height:16px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pipe li.is-cur{background:var(--sky);box-shadow:inset 0 2px var(--electric)}
.pipe li.is-cur .no{color:var(--electric);-webkit-text-stroke:0}
.pipe li.is-done .no{color:var(--ink-2);-webkit-text-stroke:0}
.split{display:grid;grid-template-columns:minmax(0,1fr) 400px;min-height:0}
.split>section{min-width:0;display:flex;flex-direction:column}
.split .panel{border-left:1px solid var(--line-2)}
.pad{padding:0 var(--margin)}
.ci th,.ci td{padding:6px 0;font-variant-numeric:tabular-nums}
.ci th{font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:right;border-bottom:1px solid var(--electric)}
.ci th:first-child{text-align:left}
.ci td{text-align:right;border-bottom:1px solid var(--line)}
.ci td:first-child{text-align:left}
.ci .hp{visibility:hidden}
.micr i{display:inline-block;width:9px;height:12px;margin:0 3px;vertical-align:-1px;background:linear-gradient(var(--ink),var(--ink)) left/3px 100% no-repeat,linear-gradient(var(--ink),var(--ink)) right top/4px 4px no-repeat,linear-gradient(var(--ink),var(--ink)) right bottom/4px 4px no-repeat}
.micr i.u{background:linear-gradient(var(--ink),var(--ink)) left/3px 100% no-repeat,linear-gradient(var(--ink),var(--ink)) 5px 0/2px 100% no-repeat,linear-gradient(var(--ink),var(--ink)) right center/2px 6px no-repeat}
.ci tr.low td{font-weight:600;border-top:1px solid var(--midnight);border-bottom:0}
.chain{list-style:none}
.chain li{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:8px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}
.chain .cno{font:700 15px/24px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric)}
.chain li.is-cur .cno{color:var(--electric);-webkit-text-stroke:0}
.chain .cl{font-weight:600}
.chain .cd{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
.chain .cs{font-size:12px;line-height:24px;color:var(--ink-2);white-space:nowrap}
/* signature: the check sequence strip — every number on the stock, accounted for */
.seq{display:flex;flex-wrap:nowrap;gap:2px;margin-top:12px}
.seq i{position:relative;display:block;flex:1;min-width:0;height:32px;background:var(--steel)}
.seq i.o{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--steel)}
.seq i.v{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--neg)}
.seq i.v::before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--neg);transform:rotate(45deg)}
.seq i.r{background:var(--electric)}
.seq i.r.j{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--neg)}
.seq i.r.j::before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--neg);transform:rotate(45deg)}
.seq i.n{background:repeating-linear-gradient(135deg,var(--white) 0 3px,var(--blue-200) 3px 5px);box-shadow:inset 0 0 0 1px var(--blue-200)}
.seq-ax{position:relative;height:16px;margin-top:6px;font-size:12px;line-height:16px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.seq-ax span{position:absolute;top:0}
.seq-lg{display:flex;flex-wrap:wrap;gap:4px 20px;margin-top:10px;font-size:12px;line-height:16px;color:var(--ink-2)}
.seq-lg span{display:inline-flex;align-items:center;gap:6px}
.seq-lg i{position:relative;display:inline-block;width:10px;height:14px;background:var(--steel)}
.seq-lg i.o{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--steel)}
.seq-lg i.v{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--neg)}
.seq-lg i.v::before{content:"";position:absolute;left:4px;top:-2px;bottom:-2px;width:2px;background:var(--neg);transform:rotate(45deg)}
.seq-lg i.r{background:var(--electric)}
.seq-lg i.n{background:repeating-linear-gradient(135deg,var(--white) 0 3px,var(--blue-200) 3px 5px);box-shadow:inset 0 0 0 1px var(--blue-200)}
/* check face preview */
.chk{position:relative;margin-top:8px;padding:16px 16px 12px;background:var(--white);border:1px solid var(--line-2);
  background-image:repeating-linear-gradient(135deg,transparent 0 10px,var(--grey-100) 10px 11px)}
.chk-top{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:16px;color:var(--ink-2)}
.chk-top b{color:var(--ink);font-weight:600}
.chk-pay{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:end;margin-top:16px}
.chk-pay .ln{border-bottom:1px solid var(--ink);padding-bottom:2px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chk-pay .amt{border:1px solid var(--ink);padding:2px 8px;font-weight:600;font-variant-numeric:tabular-nums;background:var(--white)}
.chk-words{margin-top:8px;border-bottom:1px solid var(--ink);padding-bottom:2px;font-size:12px;line-height:16px}
.chk-sig{display:flex;justify-content:space-between;align-items:end;margin-top:16px;font-size:12px;line-height:16px;color:var(--ink-3)}
.chk-sig span:last-child{width:160px;border-top:1px solid var(--ink);text-align:center;padding-top:2px}
.micr{margin-top:12px;font-weight:500;letter-spacing:.1em;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink)}
.excp{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;padding:16px 24px;background:var(--white);border:1px solid var(--line-2);box-shadow:inset 3px 0 var(--neg)}
.excp .vs{display:grid;grid-template-columns:auto auto;gap:4px 24px;margin-top:12px;justify-content:start}
.excp .vs dt{color:var(--ink-2)} .excp .vs dd{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.excp .vs dd.neg{color:var(--neg)}
.excp-acts{display:flex;flex-direction:column;gap:8px;justify-content:center;border-left:1px solid var(--line);padding-left:24px}
.excp-acts .btn{width:100%}
.nacha{font-variant-numeric:tabular-nums;font-size:12px;line-height:20px;background:var(--canvas);padding:12px 16px;white-space:pre;overflow:hidden;color:var(--ink-2)}
.nacha b{color:var(--ink);font-weight:600}
.states{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:24px}
.states .wg{height:232px}
.states .lbl{display:block;margin-bottom:8px}
.dlg-host{position:absolute;inset:0;background:rgba(10,22,40,.48);display:flex;align-items:flex-start;justify-content:center;padding-top:72px;z-index:20}
.dlg-host .dialog{width:600px}
.dlg-host .radio{min-height:32px}
.dlg-row{display:grid;grid-template-columns:600px minmax(0,1fr);gap:48px;align-items:start;margin-top:32px;padding:32px;background:var(--canvas)}
.dlg-solo .dialog{width:600px;max-width:none}
.dlg-why{padding-top:24px}
.dlg-opts{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;margin-top:8px}
"""

# ------------------------------------------------------------------ data
CLIVE_BILLS = [  # vendor, bill no, due, amount, discount, flag
    ("Kubota Tractor Corporation", "KTC-559201", "Oct 24", 21406.80, 0, ""),
    ("Kubota Tractor Corporation", "KTC-559388", "Oct 24", 4912.55, 0, ""),
    ("Stihl Inc.", "SI-2044871", "Oct 26", 6318.40, 0, ""),
    ("Exmark Manufacturing", "EX-771205", "Nov 11", 5870.00, 117.40, "disc"),
    ("Echo Inc.", "EC-33091", "Oct 25", 2916.00, 0, ""),
    ("Briggs & Stratton", "BS-640022", "Oct 23", 2377.25, 0, ""),
    ("Ames Hydraulics & Repair", "AHR-2211", "Oct 22", 1940.00, 0, "new"),
    ("Rotary Corporation", "RC-118734", "Oct 26", 1408.75, 0, ""),
    ("Farmers Cooperative Co.", "FC-10-118", "Oct 23", 1284.07, 0, "noremit"),
]
RUN_TOTAL = round(sum(a - d for *_, a, d, _f in [(b[0], b[1], b[2], b[3], b[4], b[5]) for b in CLIVE_BILLS]), 2)
assert abs(RUN_TOTAL - 48316.42) < .001, RUN_TOTAL
VENDORS = []
for b in CLIVE_BILLS:
    if b[0] not in VENDORS:
        VENDORS.append(b[0])
assert len(VENDORS) == 8
CHECKS = list(range(10521, 10529))  # one check per vendor
assert len(CHECKS) == len(VENDORS)

QUEUE = [  # client, bills, checks/entries, pay date, method, account, amount
    ("Clive Power Equipment", 9, "8 checks", "Thu Oct 22", "Check", "Farmers State ••2210", RUN_TOTAL),
    ("Iowa Custom Cabinets", 12, "10 ACH", "Fri Oct 23", "ACH", "West Bank ••6120", 96204.18),
    ("Heritage Interiors", 5, "5 checks", "Thu Oct 22", "Check", "Farmers State ••3305", 14882.60),
    ("Revived Interiors", 3, "3 checks", "Fri Oct 23", "Check", "Hills Bank ••7716", 6140.00),
]
Q_TOTAL = round(sum(q[-1] for q in QUEUE), 2)
assert abs(Q_TOTAL - 165543.20) < .001, Q_TOTAL
Q_BILLS = sum(q[1] for q in QUEUE)

# cash impact, Farmers State ••2210 operating
OP_TODAY, PAYROLL_XFER, RAMP_SETTLE, OP_MIN = 212640.18, 61200.00, 18904.33, 75000.00
OP_LOW = round(OP_TODAY - RUN_TOTAL - PAYROLL_XFER - RAMP_SETTLE, 2)
assert abs(OP_LOW - 84219.43) < .001, OP_LOW
HEADROOM = round(OP_LOW - OP_MIN, 2)

# check sequence on Farmers State ••2210 stock: 10483 .. 10530
SEQ = {}
for k in range(10483, 10521):
    SEQ[k] = "c"  # cleared
for k in (10502, 10509, 10511, 10515, 10517, 10518, 10519, 10520):
    SEQ[k] = "o"  # outstanding
SEQ[10497] = "v"; SEQ[10512] = "v"
for k in CHECKS:
    SEQ[k] = "r"
SEQ[10524] = "rj"   # jammed in this run → void & reissue
SEQ[10529] = "n"; SEQ[10530] = "n"
CLEARED = sum(1 for v in SEQ.values() if v == "c")
OUTST = sum(1 for v in SEQ.values() if v == "o")
VOIDS = sum(1 for v in SEQ.values() if v == "v")


# ------------------------------------------------------------------ shells
def pc_rail_ws():
    groups = [("Home", [("Home", True), ("Inbox", False, 3)]),
              ("Pinned · pay runs", [("Clive Power Equipment", False, 1), ("Iowa Custom Cabinets", False, 1), ("Heritage Interiors", False, 1),
                                     ("Revived Interiors", False, 1), ("Metro Heating & Cooling", False, "!1"), ("AIM Kitchen & Bath",),
                                     ("Heartland Heating & Cooling",), ("Artistry Homes",)])]
    fixed = []
    for g, links in groups:
        fl = []
        for l in links:
            if len(l) > 2 and isinstance(l[2], str) and l[2].startswith("!"):
                fl.append((l[0], l[1], l[2][1:], True))
            else:
                fl.append(l)
        fixed.append((g, fl))
    return rail(fixed, "Tess Moreno", "Check processor")


def pc_rail_client(cur="Pay runs & checks"):
    keep = {"Inbox", "Pay runs & checks", "Vendors"}
    return rail(client_nav(set(), cur, {"Inbox": 1, "Pay runs & checks": 2}, keep=keep, settings=False), "Tess Moreno", "Check processor")


def tabs(sel, counts):
    names = ["Queue", "Print", "Positive pay", "ACH files", "History", "Remittances"]
    out = '<div class="tabs" role="tablist" aria-label="Pay runs">'
    for t in names:
        c = counts.get(t)
        cn = f'<span class="n">{c}</span>' if c else ""
        out += f'<button class="tab" role="tab" aria-selected="{"true" if t == sel else "false"}" type="button">{t}{cn}</button>'
    return out + "</div>"


def pipe(cur, run_meta):
    steps = [("Queue", "Tess Moreno · you"), ("Approve", "Rob Hartley · owner"), ("Print or export", "Tess Moreno · you"),
             ("Release", "Nora Lindqvist · CFO"), ("Clear", "Farmers State Bank")]
    out = f'<ol class="pipe" aria-label="Pay run steps · {E(run_meta)}">'
    for i, (l, w) in enumerate(steps, 1):
        cls = "is-cur" if i == cur else ("is-done" if i < cur else "")
        st = " · done" if i < cur else (" · current" if i == cur else "")
        out += f'<li class="{cls}"><span class="no" aria-hidden="true">{i}</span><span class="lb">{l}<span class="sr">{st}</span></span><span class="who">{w}</span></li>'
    return out + "</ol>"


# ------------------------------------------------------------------ frame 1: home
def m_queue():
    rows = '<tr class="q-group"><td colspan="5"><span class="q-group-t">Ready to queue</span><span class="tnum b">4 clients · ' + str(Q_BILLS) + ' bills</span><span class="ink-3" style="margin-left:8px">approved, not in a run · earliest pay date first</span></td></tr>'
    for c, b, chk, d, m, acct, amt in sorted(QUEUE, key=lambda q: (q[3][-2:], q[0])):
        rows += (f'<tr class="q-row" data-drill="{E(c)} · Pay runs"><td><span class="l1">{E(c)}</span><span class="l2">{b} bills · {chk}</span></td>'
                 f'<td><span class="l1 tnum">{d}</span><span class="l2">{m} · {acct}</span></td>'
                 f'<td class="n">{f2(amt)}</td><td class="qrow-act" colspan="2"><button class="btn" type="button">Queue run</button></td></tr>')
    rows += ('<tr class="q-row held is-attn"><td><span class="l1">Crystal Kitchen &amp; Bath</span><span class="l2">4 bills · 1 held, no W-9</span></td>'
             '<td><span class="l1 tnum">Fri Oct 23</span><span class="l2">Check · West Bank ••3390</span></td>'
             f'<td class="n">{f2(11930.00)}</td><td class="qrow-act" colspan="2"><button class="btn" type="button">Queue 3, hold 1</button></td></tr>')
    rows += '<tr class="q-group"><td colspan="5"><span class="q-group-t">In flight</span><span class="tnum b">3 runs</span><span class="ink-3" style="margin-left:8px">waiting on someone else · you can’t approve or release</span></td></tr>'
    infl = [("AIM Kitchen &amp; Bath", "11 bills · ACH · pays Tue Oct 20", 58312.10, "Release", "Nora Lindqvist", "Approved by Mike Heilman"),
            ("Heartland Heating &amp; Cooling", "14 bills · ACH · pays Wed Oct 21", 186420.55, "Approve", "Mike Heilman", "Prepared by Sam Kovac"),
            ("Artistry Homes", "6 draws · ACH · pays Wed Oct 21", 402150.00, "Verify payee", "Jordan Smith", "Hansen Concrete bank unverified")]
    for c, s, a, step, who, note in infl:
        warn = step == "Verify payee"
        rows += (f'<tr class="q-row"><td><span class="l1">{c}</span><span class="l2">{s}</span></td>'
                 f'<td><span class="l1">{step} · {who}</span><span class="l2{" warn" if warn else ""}">{note}</span></td>'
                 f'<td class="n">{f2(a)}</td><td class="qrow-act" colspan="2"><a class="btn btn--quiet" href="#">Open{ico("right")}</a></td></tr>')
    body = (f'<table class="tbl tbl-q tbl-q--flush" aria-label="Approved bills ready to queue, by client and pay date">'
            f'<colgroup><col><col style="width:232px"><col style="width:112px"><col style="width:168px"><col style="width:0"></colgroup>'
            f'<thead><tr><th>Client</th><th>Pay date · method</th><th class="n">Amount</th><th></th><th></th></tr></thead><tbody>{rows}</tbody></table>')
    foot = f'<span>Ready to queue · {f2(Q_TOTAL)} across 4 clients · Crystal waits on 1 W-9</span>{btn("Queue 4 runs", "primary", "Q")}'
    return wg("pc.queue", "Ready to queue", body, 1, 1, 8, 4, count="5", meta="Approved bills · pay date ≤ Oct 23", foot=foot, primary=True, label_id="h1-q")


def m_print():
    items = [("Metro Heating &amp; Cooling", "MHC-1016 · 8 checks", "Hills Bank ••8804 · 20511–20518", 31906.14, "Assign numbers &amp; print", "Approved Fri by Jordan Smith"),
             ("Swan Creek", "SWC-1009 · 2 checks", "Two Rivers ••0142 · 3108–3109", 9450.00, "Assign numbers &amp; print", "Approved today by Rob Hartley"),
             ("AIM Kitchen &amp; Bath", "AIM-1020 · NACHA file", "Lincoln Savings ••0931 · 11 entries", 58312.10, "Built", "Sends at 4:00 PM, after Nora releases")]
    out = ""
    for c, r, acct, a, act, note in items:
        b = f'<button class="btn" type="button">{act}</button>' if act != "Built" else '<span class="tag tag--pos">File built</span>'
        out += (f'<div class="pi"><div class="row row--between"><span class="l1">{c}</span><span class="b tnum">{f2(a)}</span></div>'
                f'<span class="l2">{r} · {acct}</span><div class="row row--between" style="margin-top:8px"><span class="t-cap">{note}</span>{b}</div></div>')
    body = f'<div class="pis">{out}</div>'
    foot = '<span>Reprints and voids ask for a reason</span><a class="btn btn--quiet" href="#">Print queue' + ico("right") + '</a>'
    return wg("pc.print", "To print / export", body, 9, 1, 4, 4, count="3", meta="Approved runs", foot=foot, label_id="h1-p")


def m_pospay():
    body = f"""<div class="wg-body--pad"><div class="row row--between"><span class="b">Clive · check 10508</span>{status("blocked", "Exception")}</div>
<p class="ink-2" style="margin-top:4px">Presented for <b class="ink tnum">4,812.00</b>. Issued for <b class="ink tnum">481.20</b> to Grainger.</p>
<p class="t-cap" style="margin-top:4px">Farmers State pays it at 11:00 AM CT tomorrow unless you return it.</p></div>"""
    foot = f'<span>3 issue files sent today</span>{btn("Decide", "primary")}'
    return wg("pc.positive_pay", "Positive pay", body, 1, 5, 4, 2, count="1", meta="bank exception", foot=foot, label_id="h1-pp")


def m_ach():
    body = f"""<div class="wg-body--pad"><div class="row row--between"><span class="b">AIM · 11 entries</span><span class="b tnum">{f2(58312.10)}</span></div>
<p class="t-cap" style="margin-top:4px">Built 9:12 AM · transmits after release · no returns this week</p>
<div class="inline-notice" style="margin-top:12px;padding:8px 12px">{ico("info")}<span><b>Sandbox.</b> No ACH provider yet, so files are downloaded and uploaded to the bank by hand.</span></div></div>"""
    foot = f'<span>Heartland builds after approval</span>{btn("Download file")}'
    return wg("pc.ach_files", "ACH files", body, 5, 5, 4, 2, count="1", meta="waiting on release", foot=foot, label_id="h1-ach")


def m_history():
    body = """<dl class="kv wg-body--pad" style="row-gap:4px"><dt>Outstanding over 90 days · 6 checks</dt><dd>4,118.27</dd>
<dt>Voided this week</dt><dd>2</dd><dt>Cleared this week</dt><dd>61</dd><dt class="neg">Remittance didn’t send · Ferguson</dt><dd class="neg">1</dd></dl>"""
    foot = f'<span>Stale at 180 days → unclaimed property</span>{btn("Resend remittance")}'
    return wg("pc.history", "Check history", body, 9, 5, 4, 2, count="", meta="last 7 days", foot=foot, label_id="h1-h")


def m_reimb():
    body = f"""<div class="wg-body--pad"><div class="row row--between"><span class="b">Clive · 3 reports</span><span class="b tnum">{f2(1284.66)}</span></div>
<p class="t-cap" style="margin-top:4px">Tom Becker mileage 412.38 · Kyle Meyer parts run 588.10 · Jess Alvarez meals 284.18</p></div>"""
    assert abs(412.38 + 588.10 + 284.18 - 1284.66) < .001
    foot = f'<span>Approved by Rob Hartley</span>{btn("Create batch")}'
    return wg("pc.reimbursements", "Reimbursements", body, 1, 7, 4, 2, count="3", meta="approved, not batched", foot=foot, label_id="h1-r")


def home_frame():
    ctxl = ctxline(["Mon Oct 19", "5 clients with approved bills", "3 runs in flight", "Positive pay decision by 11:00 AM CT Tue", "<b>1 bank exception</b>"],
                   right=customize_btn() + '<span class="sample">Sample data</span>')
    css = '<style>.pis .pi{padding:12px 16px;border-bottom:1px solid var(--line)}.pis .pi:last-child{border-bottom:0}</style>'
    dash = f'<div class="page"><div class="dash">{m_queue()}{m_print()}{m_pospay()}{m_ach()}{m_history()}{m_reimb()}</div></div>'
    return app("workspace", "density-cockpit", pc_rail_ws(), bar(ctx_workspace(), "<b>Home</b>", cmd="Jump to client, vendor, check number…"),
               css + ctxl + dash, 1240, live=True)


def states_strip():
    def card(lbl, wid, title, state, body, foot=""):
        mark = '<span class="wg-done-mark">' + ico("check") + '</span>' if state == "done" else '<span class="wg-empty-mark">' + ico("plus") + '</span>'
        f = f'<div class="wg-foot">{foot}</div>' if foot else ""
        return (f'<div><span class="eyebrow lbl">{lbl}</span><section class="wg" aria-label="{title} · {state}" data-widget="{wid}">'
                f'<div class="wg-head"><h3 class="wg-title">{title}</h3></div><div class="wg-body"><div class="wg-state">{mark}{body}</div></div>{f}</section></div>')
    return '<div class="states">' + "".join([
        card("Done", "pc.queue", "Ready to queue", "done", '<p class="t-head">Everything approved is in a run.</p><p>Next batch expected Thu, when Heartland’s October bills are approved.</p>', '<span>Checked 4:10 PM</span>'),
        card("Done", "pc.positive_pay", "Positive pay", "done", '<p class="t-head">No exceptions.</p><p>Issue files sent for 3 runs today. Farmers State’s next decision window opens 7:00 AM.</p>', '<span>Bank file read 8:02 AM</span>'),
        card("Empty", "pc.positive_pay", "Positive pay", "empty", '<p class="t-head">Revived Interiors has no positive pay.</p><p>Ask Hills Bank for an issue-file format, then add it to the account.</p>', '<button class="btn" type="button" style="margin-left:auto">Set up for ••7716</button>'),
        card("Late job", "pc.history", "Check history", "empty", '<p class="t-head warn">Cleared checks haven’t updated since Fri.</p><p>The Farmers State feed is late, so “cleared” is 3 days old. Outstanding counts may be high.</p>', '<span class="warn">Bank feed 3 days late</span>'),
    ]) + "</div>"


# ------------------------------------------------------------------ frame 2: queue tab, building a run
def queue_frame():
    rows = '<tr class="q-group"><td colspan="5"><span class="q-group-t">In this run</span><span class="tnum b">9 bills · 8 vendors</span><span class="ink-3" style="margin-left:8px">due by Oct 26, or a discount that expires before</span></td></tr>'
    for v, no, due, amt, disc, flag in CLIVE_BILLS:
        tag = ""
        if flag == "disc":
            tag = f'<span class="tag tag--pos">2/10 net 30 · save {f2(disc)} by Oct 22</span>'
        elif flag == "new":
            tag = '<span class="tag tag--warn">New payee · bank verified by call-back Oct 15</span>'
        elif flag == "noremit":
            tag = '<span class="tag">No remit email · stub only</span>'
        pay = amt - disc
        rows += (f'<tr class="q-row is-selected"><td><label class="check"><input type="checkbox" checked aria-label="{E(v)} {no}"><i></i></label></td>'
                 f'<td><span class="l1">{E(v)}</span><span class="l2"><span class="code">{no}</span>{tag}</span></td>'
                 f'<td class="tnum">{due}</td><td class="n">{f2(amt)}</td><td class="n b">{f2(pay)}</td></tr>')
    rows += '<tr class="q-group"><td colspan="5"><span class="q-group-t">Held</span><span class="tnum b">1</span><span class="ink-3" style="margin-left:8px">vendor compliance · can’t be queued until cleared</span></td></tr>'
    rows += (f'<tr class="q-row is-attn"><td><label class="check"><input type="checkbox" disabled aria-label="Midwest Turf Supply, held"><i></i></label></td>'
             f'<td><span class="l1">Midwest Turf Supply</span><span class="l2"><span class="code">MTS-4410</span>No W-9 on file · chase sent Oct 12, Oct 16</span></td>'
             f'<td class="tnum">Oct 24</td><td class="n">{f2(3212.00)}</td><td class="qrow-act"><button class="btn" type="button">Nudge</button></td></tr>')
    later = 12640.10
    rows += f'<tr class="q-group"><td colspan="5"><span class="q-group-t">Due later</span><span class="tnum b">3 bills · {f2(later)}</span><span class="ink-3" style="margin-left:8px">due Nov 2–Nov 18 · left out to keep cash above the floor</span></td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Bills in pay run CPE-1022"><colgroup><col style="width:56px"><col><col style="width:80px"><col style="width:112px"><col style="width:144px"></colgroup>'
             f'<thead><tr><th><span class="sr">Select</span></th><th>Vendor · bill</th><th>Due</th><th class="n">Bill</th><th class="n">To pay</th></tr></thead><tbody>{rows}</tbody></table>')
    left = f"""<section>
<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Pay runs &amp; checks</div><h1 class="t-title" style="margin-top:4px">Pay runs</h1></div>
<div class="btn-row">{btn("New run", "", "", "plus")}</div></div>
{tabs("Queue", {"Queue": 1, "Positive pay": 1})}</div>
<div class="pad" style="padding-top:16px;padding-bottom:16px">{pipe(1, "CPE-1022")}</div>
<div class="bulk"><b>9 selected</b><span class="sl">//</span><span class="tnum">{f2(RUN_TOTAL)}</span><span class="ink-2">after a {f2(117.40)} discount</span><span class="sp"></span><button class="btn btn--quiet" type="button">Proposed by the pay-run agent · why these {ico("right")}</button></div>
<div style="flex:1;min-height:0;overflow:auto">{table}</div>
<div class="keybar" style="white-space:nowrap"><span class="ph-k"><span class="kbd">J</span><span class="kbd">K</span>move</span><span class="ph-k"><span class="kbd">X</span>include</span><span class="ph-k"><span class="kbd">D</span>due-date filter</span><span class="ph-k"><span class="kbd">⌘</span><span class="kbd">↵</span>submit</span><span class="sp"></span><span>Bills are approved in Bills, not here</span></div>
</section>"""
    ci = f"""<table class="ci" aria-label="Cash impact by bank account">
<thead><tr><th>Farmers State ••2210 · operating</th><th>Through Oct 23</th></tr></thead><tbody>
<tr><td>Balance this morning</td><td>{n(OP_TODAY)}</td></tr>
<tr><td>This run · 8 checks, Thu</td><td>{n(-RUN_TOTAL)}</td></tr>
<tr><td>Payroll funding to ••2238, Thu</td><td>{n(-PAYROLL_XFER)}</td></tr>
<tr><td>Ramp statement settles, Wed</td><td>{n(-RAMP_SETTLE)}</td></tr>
<tr class="low"><td>Projected low, Oct 23</td><td>{n(OP_LOW)}</td></tr></tbody></table>
<p class="t-cap" style="margin-top:8px">Minimum cash for Clive is {f2(OP_MIN)}, so {f2(HEADROOM)} to spare. Adding the 3 later bills would go {f2(later - HEADROOM)} under.</p>"""
    assert later > HEADROOM
    chain = f"""<ol class="chain" aria-label="Approval chain">
<li class="is-cur"><span class="cno" aria-hidden="true">1</span><span><span class="cl">Prepare · Tess Moreno</span><span class="cd">You, now</span></span><span class="cs">In progress</span></li>
<li><span class="cno" aria-hidden="true">2</span><span><span class="cl">Approve · Rob Hartley, owner</span><span class="cd">Clive’s workflow: runs over 25,000.00 go to the owner</span></span><span class="cs">Next</span></li>
<li><span class="cno" aria-hidden="true">3</span><span><span class="cl">Release · Nora Lindqvist, CFO</span><span class="cd">Step-up sign-in · fraud screen runs here</span></span><span class="cs">After print</span></li></ol>
<p class="t-cap" style="margin-top:8px">Approver and releaser must be different people, and neither can be you. Rob can’t release; Nora can’t approve this run.</p>"""
    panel = f"""<aside class="panel" aria-label="Run CPE-1022">
<div class="panel-head"><div class="eyebrow">Run CPE-1022<span class="sl">//</span>Draft</div><div class="row row--between" style="margin-top:4px"><span class="t-head">Pays Thu Oct 22 · by check</span><span class="t-head tnum">{f2(RUN_TOTAL)}</span></div>
<span class="t-cap">8 checks, numbers assigned at print · remittance advice to 7 vendors by email</span></div>
<div class="panel-body"><div class="panel-sec"><div class="panel-sec-h"><h3>Cash impact</h3><span class="t-cap">from the 13-week forecast</span></div>{ci}</div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Who signs off</h3></div>{chain}</div></div>
<div class="panel-foot"><button class="btn" type="button">Save draft</button><span class="sp"></span>{btn("Submit for approval", "primary", "⌘↵")}</div></aside>"""
    main = (ctxline(["Mon Oct 19", "Clive Power Equipment", "Approved bills due by Oct 26: 9", "<b>Minimum cash holds through Oct 23</b>"]) +
            f'<div class="split" style="height:calc(100% - 32px)">{left}{panel}</div>')
    return app("client", "density-cockpit", pc_rail_client(), bar(ctx_client("Clive Power Equipment", "C-102"), "Payables / <b>Pay runs</b>", cmd="Jump to vendor, bill, check number…"),
               main, 1000)


# ------------------------------------------------------------------ frame 3: print, with a jam
def seq_strip():
    cells = ""
    labels = {"c": "cleared", "o": "outstanding", "v": "void", "r": "this run", "rj": "this run, jammed — void", "n": "next on stock"}
    for k in sorted(SEQ):
        v = SEQ[k]
        cls = {"c": "", "o": "o", "v": "v", "r": "r", "rj": "r j", "n": "n"}[v]
        cells += f'<i class="{cls}" title="{k} · {labels[v]}"></i>'
    ks = sorted(SEQ); N = len(ks)
    ax = "".join(f'<span style="left:{ks.index(k) / N * 100:.2f}%">{k}</span>' for k in (10483, 10497, 10512, 10521)) + '<span style="right:0">10530</span>'
    lg = ('<div class="seq-lg"><span><i></i>Cleared ' + str(CLEARED) + '</span><span><i class="o"></i>Outstanding ' + str(OUTST) +
          '</span><span><i class="v"></i>Void ' + str(VOIDS + 1) + ' incl. 10524</span><span><i class="r"></i>This run 10521–10528</span><span><i class="n"></i>Reissue 10529, then stock</span></div>')
    return (f'<div role="img" aria-label="Check numbers 10483 to 10530 on Farmers State ••2210: {CLEARED} cleared, {OUTST} outstanding, {VOIDS} void before this run, '
            f'10521 to 10528 in this run with 10524 jammed, 10529 reissue.">' f'<div class="seq">{cells}</div><div class="seq-ax">{ax}</div></div>{lg}')


def print_frame():
    rows = ""
    for i, (chk, v) in enumerate(zip(CHECKS, VENDORS)):
        amt = round(sum(b[3] - b[4] for b in CLIVE_BILLS if b[0] == v), 2)
        nb = sum(1 for b in CLIVE_BILLS if b[0] == v)
        if chk == 10524:
            st = f'<td>{status("blocked", "Jammed · void")}</td><td class="qrow-act"><button class="btn btn--danger" type="button">Void &amp; reissue</button></td>'
            cls = " is-attn is-cursor"
        elif chk < 10524:
            st = f'<td>{status("ready", "Printed")}</td><td></td>'
            cls = ""
        else:
            st = '<td><span class="status status--track"><i class="pip pip--track" aria-hidden="true"></i>Queued</span></td><td></td>'
            cls = ""
        rows += (f'<tr class="q-row{cls}"><td class="tnum b">{chk}</td><td><span class="l1">{E(v)}</span><span class="l2">{nb} bill{"s" if nb > 1 else ""} · remittance on stub</span></td>'
                 f'<td class="n">{f2(amt)}</td>{st}</tr>')
    total = round(sum(b[3] - b[4] for b in CLIVE_BILLS), 2)
    assert abs(total - RUN_TOTAL) < .001
    rows += f'<tr class="q-group"><td></td><td><span class="q-group-t">8 checks</span></td><td class="n b">{f2(RUN_TOTAL)}</td><td colspan="2"><span class="ink-3">3 printed · 1 jammed · 4 queued</span></td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Print queue, run CPE-1022"><colgroup><col style="width:96px"><col><col style="width:120px"><col style="width:168px"><col style="width:160px"></colgroup>'
             f'<thead><tr><th>Check no.</th><th>Payee</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>{rows}</tbody></table>')
    left = f"""<section>
<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Pay runs &amp; checks</div><h1 class="t-title" style="margin-top:4px">Pay runs</h1></div>
<div class="btn-row">{btn("Print test page", "", "", "print")}{btn("Resume printing 4", "primary", "P", "print")}</div></div>
{tabs("Print", {"Print": 1, "Positive pay": 1})}</div>
<div class="pad" style="padding-top:16px">{pipe(3, "CPE-1022")}</div>
<div class="pad" style="padding-top:20px"><div class="row row--between"><span class="t-head">Farmers State ••2210 · check stock</span><span class="t-cap">Every number is accounted for: printed, cleared, outstanding or void</span></div>{seq_strip()}</div>
<div style="flex:1;min-height:0;overflow:auto;margin-top:20px">{table}</div>
</section>"""
    v = VENDORS[4]
    panel = f"""<aside class="panel" aria-label="Check preview">
<div class="panel-head"><div class="eyebrow">Check 10521<span class="sl">//</span>Printed 9:41 AM</div><span class="t-cap">Approved Wed by Rob Hartley · releases after print</span></div>
<div class="panel-body"><div class="panel-sec"><div class="panel-sec-h"><h3>Face</h3><span class="t-cap">alignment checked on test page</span></div>
<div class="chk"><div class="chk-top"><span><b>Clive Power Equipment</b><br>4401 NW Urbandale Dr · Urbandale IA</span><span class="tnum"><b>10521</b><br>Oct 22, 2026</span></div>
<div class="chk-pay"><span class="t-cap">Pay to</span><span class="ln">Kubota Tractor Corporation</span><span class="amt">{f2(26319.35)}</span></div>
<div class="chk-words">Twenty-six thousand three hundred nineteen and 35/100 dollars</div>
<div class="chk-sig"><span>Memo · KTC-559201, KTC-559388</span><span>Authorized signature</span></div>
<div class="micr" role="img" aria-label="MICR line: check 010521, routing 073922016, account ending 2210"><i class="u"></i>010521<i class="u"></i> <i></i>073922016<i></i> 4401••2210<i class="u"></i></div></div></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Stub</h3></div><ul class="ev"><li>KTC-559201<span class="dl"></span><span class="v">{f2(21406.80)}</span></li><li>KTC-559388<span class="dl"></span><span class="v">{f2(4912.55)}</span></li><li class="ev-total">Check total<span class="dl"></span><span class="v">{f2(26319.35)}</span></li></ul></div>
<div class="panel-sec"><div class="panel-sec-h"><h3>Positive pay</h3></div><p class="ink-2">Issue file adds each check as it prints. The void of 10524 goes on the same file, before Nora releases.</p></div></div>
<div class="panel-foot"><button class="btn" type="button">Reprint 10521…</button><span class="sp"></span><span class="t-cap">Reprint voids the original</span></div></aside>"""
    assert abs(21406.80 + 4912.55 - 26319.35) < .001
    dlg = f"""<div class="dlg-host"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="vd-t">
<div class="dialog-head"><h2 class="t-section" id="vd-t">Void check 10524 and reissue</h2><p class="ink-2" style="margin-top:4px">Echo Inc. · EC-33091 · <b class="ink tnum">{f2(2916.00)}</b></p></div>
<div class="dialog-body"><div class="field"><span class="field-label">Why is it void?</span><div class="dlg-opts" role="radiogroup" aria-label="Void reason">
<label class="radio"><input type="radio" name="vr" checked><i></i>Jammed or spoiled in printer</label><label class="radio"><input type="radio" name="vr"><i></i>Lost in the mail</label>
<label class="radio"><input type="radio" name="vr"><i></i>Wrong payee or amount</label><label class="radio"><input type="radio" name="vr"><i></i>Stale, not cashed</label></div></div>
<div class="field" style="margin-top:12px"><label class="field-label" for="vd-n">Note for the audit trail</label><textarea class="textarea" id="vd-n">Printer jam on sheet 4; original shredded, stub kept.</textarea><span class="field-help">8–500 characters · 52 written</span></div>
<ul class="ev" style="margin-top:16px"><li>Check 10524 marked void<span class="dl"></span><span class="v">no GL entry, never issued</span></li>
<li>Reissued as 10529, next on the stock<span class="dl"></span><span class="v">{f2(2916.00)}</span></li><li>Positive pay issue file<span class="dl"></span><span class="v">void 10524 · issue 10529</span></li></ul></div>
<div class="dialog-foot"><button class="btn" type="button">Cancel</button><span class="sp"></span>{btn("Void 10524 and reissue as 10529", "danger", "", "", 'data-say="Voided 10524 · reissued as 10529"')}</div></div></div>"""
    main = (ctxline(["Thu Oct 22", "Clive Power Equipment", "Run CPE-1022 approved by Rob Hartley Wed 4:12 PM", "<b>Release after print · Nora Lindqvist</b>"]) +
            f'<div class="split" style="height:calc(100% - 32px)">{left}{panel}</div>')
    global VOID_DLG
    VOID_DLG = dlg.replace('<div class="dlg-host">', '<div class="dlg-solo">', 1)
    return app("client", "density-cockpit", pc_rail_client(), bar(ctx_client("Clive Power Equipment", "C-102"), "Payables / Pay runs / <b>Print</b>", cmd="Jump to vendor, bill, check number…", sync="Synced 9:44 AM"),
               main, 960)


# ------------------------------------------------------------------ frame 4: positive pay + remittances
def pospay_frame():
    files = [("Clive · CPE-1015", "Oct 15", "Farmers State ••2210", 14, 38204.11, "Accepted"),
             ("Heritage · HI-1013", "Oct 13", "Farmers State ••3305", 6, 12118.40, "Accepted"),
             ("Metro · MHC-1012", "Oct 12", "Hills Bank ••8804", 9, 27406.90, "Accepted"),
             ("Clive · void 10512", "Oct 9", "Farmers State ••2210", 1, 0.00, "Accepted")]
    tr = "".join(f'<tr class="q-row"><td><span class="l1">{a}</span><span class="l2">{c}</span></td><td class="tnum">{b}</td><td class="n">{d}</td><td class="n">{f2(e)}</td><td>{status("ready", f)}</td></tr>' for a, b, c, d, e, f in files)
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Issue files sent"><colgroup><col><col style="width:80px"><col style="width:72px"><col style="width:120px"><col style="width:120px"></colgroup>'
             f'<thead><tr><th>Issue file</th><th>Sent</th><th class="n">Checks</th><th class="n">Amount</th><th>Bank</th></tr></thead><tbody>{tr}</tbody></table>')
    exc = f"""<div class="excp"><div><div class="row"><span class="eyebrow">Bank exception<span class="sl">//</span>Farmers State ••2210</span><span class="sp"></span>{status("blocked", "Decide by 11:00 AM CT tomorrow")}</div>
<p class="t-head" style="margin-top:8px">Check 10508 was presented for ten times what we issued.</p>
<dl class="vs"><dt>Issued Oct 2 to Grainger</dt><dd>{f2(481.20)}</dd><dt>Presented Oct 19 at a branch</dt><dd class="neg">{f2(4812.00)}</dd><dt>Payee on the image</dt><dd>Grainger</dd></dl>
<p class="ink-2" style="margin-top:8px">The amount on the image looks altered (a 0 added). Pay only if Grainger confirms; otherwise return it and the bank refuses the item.</p></div>
<div class="excp-acts">{btn("Return · don’t pay", "danger", "R", "", 'data-say="Returned check 10508"')}{btn("Pay as presented", "", "", "")}<button class="btn btn--quiet" type="button">{ico("eye")}Open check image</button>
<span class="t-cap">Returning tells Farmers State to refuse the item. Rob Hartley and Nora Lindqvist are copied.</span></div></div>"""
    rem = [("Kubota Tractor Corporation", "ar@kubota-credit.example", "Sent", "ready"), ("Stihl Inc.", "remit@stihl.example", "Opened", "ready"),
           ("Ferguson Enterprises", "ap@ferguson.example", "Bounced", "blocked"), ("Farmers Cooperative Co.", "—", "Stub only", "track")]
    rr = ""
    for v, em, s, k in rem:
        act = '<button class="btn" type="button">Resend…</button>' if k == "blocked" else ""
        rr += f'<tr class="q-row{" is-attn" if k == "blocked" else ""}"><td><span class="l1">{v}</span><span class="l2">{em}</span></td><td>{status(k, s)}</td><td class="qrow-act">{act}</td></tr>'
    rtable = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="Remittance advice"><colgroup><col><col style="width:112px"><col style="width:120px"></colgroup>'
              f'<thead><tr><th>Vendor · remit to</th><th>Advice</th><th></th></tr></thead><tbody>{rr}</tbody></table>')
    body = f"""<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Pay runs &amp; checks</div><h1 class="t-title" style="margin-top:4px">Pay runs</h1></div>
<div class="btn-row">{btn("Send issue file", "", "", "send")}</div></div>{tabs("Positive pay", {"Queue": 1, "Positive pay": 1})}</div>
<div class="pad" style="padding-top:20px">{exc}</div>
<div class="pad" style="display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:24px;padding-top:24px">
<div><div class="row row--between" style="margin-bottom:8px"><span class="t-head">Issue files</span><span class="t-cap">Each print adds checks; voids go on the next file</span></div>{table}</div>
<div><div class="row row--between" style="margin-bottom:8px"><span class="t-head">Remittances · CPE-1015</span><span class="t-cap">Emailed when the run releases</span></div>{rtable}</div></div>"""
    main = ctxline(["Mon Oct 19", "Clive Power Equipment", "<b>1 exception · 23 hours left</b>"]) + body
    return app("client", "density-cockpit", pc_rail_client(), bar(ctx_client("Clive Power Equipment", "C-102"), "Payables / Pay runs / <b>Positive pay</b>", cmd="Jump to vendor, bill, check number…"),
               main, 760)


# ------------------------------------------------------------------ frame 5: ACH file
def ach_frame():
    ents = [("Masterbrand Cabinets", "071000013", "••4471", 38204.40), ("Richelieu Hardware", "091000019", "••0028", 14116.25),
            ("Weyerhaeuser Distribution", "121000248", "••6610", 12880.00), ("Hafele America", "053000196", "••1194", 9612.88),
            ("Columbia Forest Products", "123000220", "••3301", 7744.10), ("Blum Inc.", "053101121", "••7720", 5318.45),
            ("Rev-A-Shelf", "083000108", "••2015", 3402.60), ("Iowa Hardwoods", "073972181", "••8833", 2816.50),
            ("Sherwin-Williams", "041000124", "••5509", 1260.00), ("Mid-States Glass", "073900438", "••0147", 849.00)]
    tot = round(sum(e[3] for e in ents), 2)
    assert abs(tot - 96204.18) < .001, tot
    hash_ = sum(int(e[1][:8]) for e in ents) % 10 ** 10
    tr = "".join(f'<tr class="q-row"><td class="tnum">{i:02d}</td><td><span class="l1">{v}</span><span class="l2">CCD · routing {r} · acct {a}</span></td><td class="n">{f2(m)}</td></tr>' for i, (v, r, a, m) in enumerate(ents, 1))
    tr += f'<tr class="q-group"><td></td><td><span class="q-group-t">10 entries · 12 bills</span></td><td class="n b">{f2(tot)}</td></tr>'
    table = (f'<table class="tbl tbl-q tbl-q--compact" aria-label="NACHA entries"><colgroup><col style="width:56px"><col><col style="width:120px"></colgroup>'
             f'<thead><tr><th>#</th><th>Receiver</th><th class="n">Credit</th></tr></thead><tbody>{tr}</tbody></table>')
    nacha = (f'<div class="nacha" aria-label="File control">File · <b>ICC-1023.ach</b>   built 9:20 AM by Tess Moreno<br>'
             f'Company · Iowa Custom Cabinets   ID 1421837706   SEC CCD<br>'
             f'Effective · Fri Oct 23   Originating DFI · West Bank 07390043<br>'
             f'Batch control · entries <b>10</b>   hash <b>{hash_:010d}</b>   credits <b>{f2(tot)}</b><br>'
             f'Offset debit · West Bank ••6120   {f2(tot)}</div>')
    side = f"""<div><div class="row row--between" style="margin-bottom:8px"><span class="t-head">File control</span>{status("track", "Waiting on approval")}</div>{nacha}
<div class="inline-notice" style="margin-top:16px">{ico("info")}<span><b>Sandbox · no live rail.</b> Until an ACH provider is connected, download the file and upload it in West Bank’s portal. Mark it transmitted so the bills show paid.</span></div>
<div class="btn-row" style="margin-top:16px">{btn("Download .ach", "", "", "download")}{btn("Mark transmitted…")}</div>
<p class="t-cap" style="margin-top:12px">Returns (R01–R29) land here and reopen the bill. None in 30 days.</p></div>"""
    body = f"""<div class="pad" style="padding-top:24px"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Payables<span class="sl">//</span>Pay runs &amp; checks</div><h1 class="t-title" style="margin-top:4px">Pay runs</h1></div></div>{tabs("ACH files", {"Queue": 1})}</div>
<div class="pad" style="display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:24px;padding-top:20px"><div>{table}</div>{side}</div>"""
    main = ctxline(["Mon Oct 19", "Iowa Custom Cabinets", "Run ICC-1023 · 12 bills · ACH Fri Oct 23", "<b>Approve · Jordan Smith is next</b>"]) + body
    return app("client", "density-cockpit", pc_rail_client(), bar(ctx_client("Iowa Custom Cabinets", "C-108"), "Payables / Pay runs / <b>ACH files</b>", cmd="Jump to vendor, bill, check number…"),
               main, 820)


def build():
    html = head("S20 · Check processor home and pay runs", CSS) + sheet_top("S20-pay-runs.html") + '<main id="main" class="sheet">'
    html += board_h("S20", "IA-SPEC §4.11 · §3.6.1 Pay runs &amp; checks · §6.2 procure-to-pay",
                    "Tess’s home: approved bills in, correct payments out",
                    "The check processor turns approved bills into payments: queued, numbered, printed or exported, positive-pay filed, "
                    "released by someone else, cleared. Her home is the queue across clients. Inside a client, Pay runs is one page with six tabs, and the five steps of a run sit above every tab.")
    html += pair_h("1 · Home", "Workspace, Operator Cockpit. Nav is Home, Inbox and the clients she pins; everything else is outside her role.")
    html += frame(home_frame(), "Open state · pc.queue is primary (8 of 12) · release never appears on this home", "Ties: AIM 58,312.10 and Heartland 186,420.55 match S6 and S6b")
    html += states_strip()
    html += anno([("The queue is approved bills, not bills", "Approving a bill happens in Bills by its approver. Tess sees only what’s approved and unpaid, grouped by client and pay date."),
                  ("In flight, with a name", "Runs waiting on Mike or Nora show whose turn it is. She can open them but has no verb on them: preparer ≠ approver ≠ releaser."),
                  ("A decision with a deadline", "The bank exception is the only alarm on the page, with the bank’s cutoff in the context line."),
                  ("Honest about the rails", "ACH files say Sandbox until a provider is connected. Nothing claims a transmission it didn’t make.")])
    html += pair_h("2 · Build a run", "Clive Power Equipment, Queue tab. The pay-run agent proposed the bills; Tess checks cash and submits for approval.")
    html += frame(queue_frame(), "Queue tab · run CPE-1022 · 9 bills, 8 vendors, 8 checks", f"Ties: {f2(RUN_TOTAL)} = 9 bills less the {f2(117.40)} Exmark discount · projected low {f2(OP_LOW)}")
    html += anno([("Five steps, one owner each", "Queue, Approve, Print or export, Release, Clear. The same strip sits above every tab, so a run is never lost between them."),
                  ("Cash before the click", "The panel shows the operating account through the pay date, with payroll funding and the Ramp settlement already in. It says why the later bills stayed out."),
                  ("Discounts are visible", "Exmark’s 2% is taken because it expires before the next run. The tag names the saving and the date."),
                  ("Holds can’t be queued", "Midwest Turf has no W-9, so its checkbox is disabled with the reason and a nudge, not hidden.")])
    html += pair_h("3 · Print, and a jam", "Thursday, after Rob approved. Check 10524 jammed on sheet 4; void and reissue asks for a reason.")
    html += frame(print_frame(), "Print tab · the check-stock strip accounts for every number from 10483 to 10530", "Void & reissue replaces window.confirm (06 §2 #10)")
    html += '<div class="dlg-row">' + VOID_DLG + '<div class="dlg-why"><div class="eyebrow">Same frame<span class="sl">//</span>after Void &amp; reissue on 10524</div><p class="t-head" style="margin-top:8px">The dialog that replaces window.confirm</p><p class="ink-2" style="margin-top:8px">One reason from a short list, a note for the audit trail, and a ledger of exactly what changes. The destructive verb names the check and the reissue number, and the toast repeats it.</p></div></div>'
    html += anno([("Every number accounted for", f"The strip is the signature of this screen: cleared, outstanding, void, this run, next on stock. An auditor’s gap test, drawn. {CLEARED} cleared, {OUTST} outstanding, {VOIDS} void before today."),
                  ("A void is a reason", "The dialog names what changes: the void, the reissue number, and the positive-pay file. No GL entry because 10524 was never issued."),
                  ("The face you’ll mail", "Preview shows payee, amount, words, memo and MICR, so a misaligned stock is caught on the test page, not in the mail."),
                  ("Release stays with Nora", "Printing doesn’t release. Checks leave the building after the CFO releases and the issue file is sent.")])
    html += pair_h("4 · Positive pay and remittances", "The bank flagged a presented check. One decision, a cutoff, and the evidence beside it.")
    html += frame(pospay_frame(), "Positive pay tab · exception card with Return as the safe default", "Remittance bounce matches “Remittance didn’t send · Ferguson” on the home")
    html += pair_h("5 · ACH file", "Iowa Custom Cabinets pays by ACH. The NACHA file is built from the run and waits for approval and release.")
    html += frame(ach_frame(), "ACH files tab · sandbox label until a provider is connected (04 PAY-08, PAY-09)", "Ties: 10 entries = 96,204.18 = the ICC row on the home")
    html += anno([("Returns reopen the bill", "An R-code return puts the bill back in Bills as unpaid, with the code, so nobody marks it paid twice."),
                  ("Control totals on screen", "Entry count, hash and credit total are what the bank checks. Showing them lets Tess compare with the bank’s confirmation."),
                  ("Where release lives", "Nora releases from her home (S6b, cfo.release) with the fraud screen inline. That screen isn’t repeated here on purpose."),
                  ("Nothing lost from /checks", "Queue, numbers, approve, NACHA, bill-pay CSV, remittance PDF, release and origination all have a tab. The route becomes /pay-runs.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../S20-pay-runs.html", "w").write(build())
    print("ok", RUN_TOTAL, OP_LOW, Q_TOTAL)
