"""S21 — Employee / cardholder receipts, 390 first (IA-SPEC 4.13, 3.6.6, 6.2 receipt chase, M-11)."""
from fo_common import *

# Tom Becker, parts & service at Clive Power Equipment, Ramp ••4410
MISSING = [  # merchant, date, amount, day, reminders, state, category
    ("O’Reilly Auto Parts", "Mon Oct 19", 186.40, 0, 1, "new", "Parts"),
    ("Casey’s General Store", "Fri Oct 16", 68.12, 3, 2, "reminded", "Fuel"),
    ("Menards", "Fri Oct 9", 342.77, 10, 4, "escalated", "Shop supplies"),
]
MISSING_TOTAL = round(sum(m[2] for m in MISSING), 2)
assert abs(MISSING_TOTAL - 597.29) < .001
DONE = [("Grainger", "Wed Oct 14", 94.20, "Matched Oct 14"), ("Napa Auto Parts", "Mon Oct 12", 41.85, "Matched Oct 12")]

CSS = """
/* S21 layout only — the cardholder's phone, 390 wide, 15px base, 44px+ targets */
body{min-width:1440px}
.phones{display:grid;grid-template-columns:repeat(3,390px);justify-content:space-between;row-gap:48px;margin-top:32px}
.phcap{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;min-height:40px}
.phcap .no{font:700 20px/28px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric);flex:none}
.phcap b{font-weight:600;display:block}
.phcap .t-cap{display:block}
.phone{position:relative;width:390px;height:844px;display:flex;flex-direction:column;background:var(--warm);border:1px solid var(--midnight);overflow:hidden;font-size:15px;line-height:24px}
.ph-status{display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 24px;flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.ph-status .sig{display:flex;gap:2px;align-items:flex-end}
.ph-status .sig i{display:block;width:3px;background:var(--ink)}
.ph-top{display:flex;align-items:center;justify-content:space-between;gap:12px;height:56px;padding:0 20px;flex:none;border-bottom:1px solid var(--line)}
.ph-top img{height:24px;width:auto}
.ph-top .who{font-size:12px;line-height:16px;color:var(--ink-2);text-align:right}
.ph-body{flex:1;min-height:0;overflow:hidden;padding:16px 20px 24px}
.ph-foot{flex:none;padding:12px 20px 28px;border-top:1px solid var(--line);background:var(--warm)}
.ph-foot .btn{width:100%;height:52px;font-size:15px}
.ph-foot .btn+.btn{margin-top:8px}
.ph-legal{margin-top:8px;font-size:12px;line-height:16px;color:var(--ink-3);text-align:center}
.ph-h{font:700 20px/28px var(--f-display);color:var(--electric);margin-top:16px}
.ph-h.ink{color:var(--ink)}
.ph-p{color:var(--ink-2);margin-top:4px}
.chg{padding:16px;background:var(--white);border:1px solid var(--line)}
.chg-top{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:16px;color:var(--ink-3)}
.chg-amt{font:600 28px/32px var(--f-text);font-variant-numeric:tabular-nums;margin-top:8px;color:var(--ink)}
.chg-m{font-weight:600;margin-top:4px}
.chg-n{font-size:12px;line-height:16px;color:var(--ink-3)}
.big{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:56px;font-size:15px}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.opts .btn{height:52px;font-size:15px;white-space:normal;line-height:20px}
.hint{display:flex;gap:12px;margin-top:16px;padding:12px 16px;background:var(--sky);box-shadow:inset 3px 0 var(--electric);font-size:12px;line-height:16px;color:var(--ink-2)}
.hint b{color:var(--ink);font-weight:600}
.hint svg{flex:none;color:var(--electric);margin-top:1px}
/* lock screen + messages */
.lock{background:var(--midnight);color:var(--warm)}
.lock .ph-status .sig i{background:var(--warm)}
.lock-time{text-align:center;font:600 64px/72px var(--f-text);font-variant-numeric:tabular-nums;margin-top:24px;letter-spacing:-.02em}
.lock-date{text-align:center;color:var(--grey-300)}
.notif{margin:24px 12px 0;padding:12px 14px;background:var(--night-800);border:1px solid var(--night-700)}
.notif-top{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--grey-300)}
.notif b{display:block;font-weight:600;margin-top:4px;color:var(--warm)}
.notif p{color:var(--grey-200);margin-top:2px}
.notif.old{opacity:.8;margin-top:8px}
.lock-quiet{display:flex;gap:10px;margin:16px 12px 0;padding:10px 14px;font-size:12px;line-height:16px;color:var(--grey-300);border:1px dashed var(--night-600)}
.lock-quiet svg{flex:none;color:var(--signal)}
.lock-foot{margin-top:auto;padding:0 24px 32px;display:flex;justify-content:space-between;color:var(--grey-300);font-size:12px}
/* camera */
.cam{background:#000;color:var(--warm)}
.cam .ph-status .sig i{background:var(--warm)}
.vf{position:relative;flex:1;margin:0;background:radial-gradient(ellipse at 50% 45%,#2A3E57 0,#0A1628 70%)}
.vf-rcpt{position:absolute;left:84px;top:96px;width:222px;height:400px;background:#F2F0EA;transform:rotate(-3deg);padding:20px 18px;display:flex;flex-direction:column;gap:7px;box-shadow:0 20px 40px rgba(0,0,0,.5)}
.vf-rcpt i{display:block;height:5px;background:#9AA4B0}
.vf-rcpt i.s{width:55%}.vf-rcpt i.m{width:75%}.vf-rcpt i.b{height:8px;background:#3D4F65;width:60%}
.vf-rcpt i.t{margin-top:auto;height:8px;background:#3D4F65}
.vf-edge{position:absolute;left:76px;top:86px;width:238px;height:420px;transform:rotate(-3deg);border:2px solid var(--signal)}
.vf-edge::before,.vf-edge::after{content:"";position:absolute;width:18px;height:18px;border:3px solid var(--warm)}
.vf-edge::before{left:-6px;top:-6px;border-right:0;border-bottom:0}
.vf-edge::after{right:-6px;bottom:-6px;border-left:0;border-top:0}
.vf-tip{position:absolute;left:0;right:0;top:20px;text-align:center}
.vf-tip span{display:inline-block;padding:6px 12px;background:rgba(10,22,40,.8);font-size:12px;line-height:16px;font-weight:600}
.vf-ctl{flex:none;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:20px 24px 36px;background:#000}
.shutter{width:72px;height:72px;border-radius:50%;border:4px solid var(--warm);display:grid;place-items:center}
.shutter i{display:block;width:56px;height:56px;border-radius:50%;background:var(--warm)}
.vf-ctl .btn{height:44px;color:var(--warm);justify-self:start}
.vf-ctl .btn:last-child{justify-self:end}
.vf-ctl .btn--quiet:hover{background:var(--night-800)}
/* matched */
.rc-thumb{display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:center;margin-top:16px;padding:8px;background:var(--white);border:1px solid var(--line)}
.rc-mini{width:72px;height:96px;background:var(--white);border:1px solid var(--line-2);padding:8px;display:flex;flex-direction:column;gap:5px}
.rc-mini i{display:block;height:3px;background:var(--grey-300)} .rc-mini i.s{width:55%} .rc-mini i.b{background:var(--ink-2);height:4px}
.mt{list-style:none;margin-top:12px}
.mt li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:32px;border-bottom:1px solid var(--line)}
.mt svg{color:var(--pos)}
.mt .v{font-weight:600;font-variant-numeric:tabular-nums}
.field-m .input{height:48px;font-size:15px}
.field-m .field-label{font-size:12px}
/* lists */
.lst{list-style:none;margin-top:12px;border-top:1px solid var(--electric)}
.lst li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.lst .m{font-weight:600}
.lst .a{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.lst .s{font-size:12px;line-height:16px;color:var(--ink-3)}
.lst .s.warn{color:var(--warn);font-weight:500}
.lst .s.neg{color:var(--neg);font-weight:500}
.lst .go{grid-column:1/-1;margin-top:8px}
.lst .go .btn{height:44px;width:100%;font-size:15px}
.lst.done li{color:var(--ink-2)}
.seg-m{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid var(--line-2);margin-top:16px}
.seg-m button{height:44px;font-weight:500;color:var(--ink-2);border-right:1px solid var(--line-2)}
.seg-m button:last-child{border-right:0}
.seg-m button[aria-pressed=true]{background:var(--midnight);color:var(--warm)}
.tot{display:flex;justify-content:space-between;margin-top:12px;padding:10px 12px;background:var(--canvas);font-size:12px;line-height:16px;color:var(--ink-2)}
.tot b{color:var(--ink);font-variant-numeric:tabular-nums}
.ok-mark{display:grid;place-items:center;width:44px;height:44px;border:1.5px solid var(--pos);color:var(--pos);background:var(--white)}
.ph-tabs{flex:none;display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);background:var(--white);padding-bottom:20px}
.ph-tabs a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;height:56px;font-size:12px;line-height:16px;color:var(--ink-2);font-weight:500}
.ph-tabs a[aria-current=page]{color:var(--electric);box-shadow:inset 0 2px var(--electric)}
.ph-tabs .cnt{font-variant-numeric:tabular-nums}
/* explain sheet */
.ph-scrim{position:absolute;inset:0;background:rgba(10,22,40,.48);display:flex;align-items:flex-end}
.ph-sheet{width:100%;background:var(--white);border-top:1px solid var(--midnight);padding:16px 20px 28px}
.ph-sheet h3{font:700 20px/28px var(--f-display);color:var(--ink)}
.ph-sheet p{color:var(--ink-2);font-size:12px;line-height:16px;margin-top:4px}
.ph-sheet .radio{min-height:44px;width:100%;border-bottom:1px solid var(--line)}
.ph-sheet .textarea{font-size:15px;margin-top:8px}
.ph-sheet .btn{width:100%;height:52px;margin-top:12px;font-size:15px}
.phones .anno-cell{display:flex;flex-direction:column;justify-content:flex-start;gap:16px;padding-top:52px}
.phones .anno-cell div{border-top:1px solid var(--line-2);padding-top:12px}
.phones .anno-cell b{display:block;font-weight:600;margin-bottom:4px}
.phones .anno-cell p{color:var(--ink-2)}
"""


def status_bar(t="2:16", dark=False):
    return (f'<div class="ph-status"><span>{t}</span><span class="sig" aria-hidden="true">'
            '<i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:10px"></i></span></div>')


def top(right="Clive Power Equipment"):
    return f'<div class="ph-top"><img src="assets/merit-logo-on-light.png" alt="Merit" width="80" height="24"><span class="who">{right}</span></div>'


def tabs(cur):
    t = [("My receipts", "receipt", "3"), ("My expenses", "money", ""), ("Requests", "ask", "")]
    out = '<nav class="ph-tabs" aria-label="Employee">'
    for l, i, c in t:
        AC = ' aria-current="page"' if l == cur else ""
        cn = f' <span class="cnt">· {c}</span>' if c else ""
        out += f'<a href="#"{AC}>{ico(i)}<span>{l}{cn}</span></a>'
    return out + "</nav>"


def charge_card(merchant, when, amt, note="Ramp ••4410 · your card"):
    return (f'<div class="chg"><div class="chg-top"><span>{when}</span><span>{note}</span></div>'
            f'<div class="chg-amt">{f2(amt)}</div><div class="chg-m">{merchant}</div></div>')


def phone(inner, cls="", label=""):
    return f'<div class="phone {cls}" role="group" aria-label="{E(label)}">{inner}</div>'


def p_sms():
    inner = status_bar("2:16") + """<div class="lock-time">2:16</div><div class="lock-date">Monday, October 19</div>
<div class="notif"><div class="notif-top"><span>Messages · Clive Power Equipment</span><span>now</span></div>
<b>Receipt for O’Reilly Auto Parts, 186.40?</b><p>Your Ramp card ••4410 was charged today at 2:14 PM. Snap the receipt: mbks.co/r/7hQ2</p></div>
<div class="notif old"><div class="notif-top"><span>Messages · Clive Power Equipment</span><span>Sun 9:00 AM</span></div>
<b>Still need: Casey’s, 68.12 · Menards, 342.77</b><p>Two receipts from last week. Tap to add them: mbks.co/r/3kT8</p></div>
<div class="lock-quiet">""" + ico("moon") + """<span>Reminders wait for 7:00 AM–8:00 PM. One text bundles everything that’s due, so you never get three in a row.</span></div>
<div class="lock-foot"><span>Swipe to open</span><span>From MeritBooks for Clive</span></div>"""
    return phone(inner, "lock", "Lock screen with the chase text")


def p_charge():
    inner = status_bar("2:16") + top() + f"""<div class="ph-body"><p class="ph-p" style="margin-top:0"><b class="ink">Tom</b>, one receipt for today’s charge. No sign-in needed.</p>
<div style="margin-top:16px">{charge_card("O’Reilly Auto Parts", "Mon Oct 19 · 2:14 PM", 186.40)}</div>
<h2 class="ph-h">Add the receipt</h2>
<button class="btn btn--primary big" type="button" style="margin-top:12px">{ico("camera")}Snap receipt</button>
<div class="opts"><button class="btn" type="button">{ico("upload")}Upload</button><button class="btn" type="button">No receipt</button></div>
<button class="btn btn--quiet big" type="button" style="margin-top:4px;height:48px">This was personal</button>
<div class="hint">{ico("info")}<span><b>Clive’s policy:</b> receipts for every charge over 25.00. Parts for a customer job? Add the work order and the cost goes to that job.</span></div></div>
<div class="ph-foot" style="padding-top:8px"><p class="ph-legal" style="margin-top:0">Secure link for Tom Becker · expires when this charge is matched</p></div>"""
    return phone(inner, "", "One charge, opened from the text")


def p_camera():
    inner = status_bar("2:17") + """<div class="vf"><div class="vf-tip"><span>Receipt found · hold still</span></div><div class="vf-rcpt" aria-hidden="true"><i class="b"></i><i class="s"></i><i></i><i class="m"></i><i></i><i class="s"></i><i class="m"></i><i></i><i class="s"></i><i class="m"></i><i></i><i class="t"></i></div><div class="vf-edge" aria-hidden="true"></div></div>
<div class="vf-ctl"><button class="btn btn--quiet" type="button">Cancel</button><button class="shutter" type="button" aria-label="Take photo"><i></i></button><button class="btn btn--quiet" type="button">Library</button></div>"""
    return phone(inner, "cam", "Camera with the receipt's edges found")


def p_matched():
    inner = status_bar("2:17") + top() + f"""<div class="ph-body"><div class="rc-thumb"><div class="rc-mini" aria-hidden="true"><i class="b"></i><i class="s"></i><i></i><i></i><i class="s"></i><i></i><i class="b" style="margin-top:auto"></i></div>
<div><b>Matches your charge</b><p class="t-cap" style="margin-top:2px">Read from the photo · retake if anything is wrong</p></div></div>
<ul class="mt" aria-label="What matched"><li>{ico("check")}<span>O’Reilly Auto Parts</span><span class="v">store #1186</span></li>
<li>{ico("check")}<span>Total on the receipt</span><span class="v">186.40</span></li><li>{ico("check")}<span>Date and time</span><span class="v">Oct 19 · 2:13 PM</span></li></ul>
<div class="hint">{ico("info")}<span><b>Looks like parts for a job.</b> 2 hydraulic hoses and fittings. Which work order?</span></div>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="wo">Work order</label><input class="input is-focus" id="wo" value="WO-22817 · Polk County Parks mower"><span class="field-help">From ServiceTitan · your open work orders</span></div></div>
<div class="ph-foot"><button class="btn btn--primary" type="button" data-sendr>Send receipt</button><p class="ph-legal">Dana Lee, Clive’s bookkeeper, sees it next</p></div>"""
    return phone(inner, "", "Matched, with the policy hint")


def p_done():
    inner = status_bar("2:18") + top() + f"""<div class="ph-body"><span class="ok-mark">{ico("check", 20)}</span>
<h2 class="ph-h ink">Sent. That one’s done.</h2><p class="ph-p">Two receipts from last week are still open. Do them now and you’re caught up.</p>
<ul class="lst" aria-label="Still open">
<li><span><span class="m">Casey’s General Store</span><br><span class="s warn">Fri Oct 16 · fuel · next reminder Wed</span></span><span class="a">68.12</span></li>
<li><span><span class="m">Menards</span><br><span class="s neg">Fri Oct 9 · 10 days · Rob Hartley was told today</span></span><span class="a">342.77</span></li></ul>
<div class="tot"><span>Still needed from you</span><b>{f2(68.12 + 342.77)}</b></div></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Do the next one</button><button class="btn" type="button">Later</button></div>"""
    assert abs(68.12 + 342.77 + 186.40 - MISSING_TOTAL) < .001
    return phone(inner, "", "Confirmation, with what's left")


def p_list():
    rows = ""
    for m, d, a, day, rem, st, cat in MISSING:
        if st == "new":
            s = f'{d} · {cat} · texted today'
            sc = "s"
        elif st == "reminded":
            s = f'{d} · {cat} · {rem} reminders · next Wed'
            sc = "s warn"
        else:
            s = f'{d} · {cat} · {day} days · sent to Rob Hartley'
            sc = "s neg"
        rows += f'<li><span><span class="m">{m}</span><br><span class="{sc}">{s}</span></span><span class="a">{f2(a)}</span></li>'
    done = "".join(f'<li><span><span class="m">{m}</span><br><span class="s">{d} · {s}</span></span><span class="a">{f2(a)}</span></li>' for m, d, a, s in DONE)
    inner = status_bar("8:05") + top("Tom Becker · Ramp ••4410") + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">My receipts</h1>
<div class="tot" style="margin-top:8px"><span>3 charges need a receipt</span><b>{f2(MISSING_TOTAL)}</b></div>
<ul class="lst" aria-label="Needs a receipt">{rows}<li class="go" style="border:0;padding-top:4px"><div class="go"><button class="btn btn--primary" type="button">{ico("camera")}Snap the oldest first</button></div></li></ul>
<p class="eyebrow" style="margin-top:20px">Done this statement</p><ul class="lst done" aria-label="Done" style="border-top-color:var(--line-2)">{done}</ul></div>{tabs("My receipts")}"""
    return phone(inner, "", "My receipts list")


def p_expenses():
    items = [("Mileage · 3 trips to Ankeny", "Approved Oct 16 by Rob Hartley", 412.38, "Paying Fri Oct 23"),
             ("Boot allowance", "Submitted Oct 14", 150.00, "Waiting on Rob Hartley"),
             ("Per diem · Kubota training, Atlanta", "Draft · 2 of 3 days entered", 138.00, "Finish to submit")]
    rows = ""
    for t, s, a, st in items:
        rows += f'<li><span><span class="m">{t}</span><br><span class="s">{s}</span></span><span class="a">{f2(a)}</span><span class="s" style="grid-column:1/-1">{st}</span></li>'
    inner = status_bar("8:06") + top("Tom Becker") + f"""<div class="ph-body"><h1 class="ph-h ink" style="margin-top:0">My expenses</h1>
<div class="seg-m" role="group" aria-label="New expense"><button type="button">{'Mileage'}</button><button type="button">Per diem</button><button type="button">Out of pocket</button></div>
<p class="t-cap" style="margin-top:6px">Mileage at the IRS rate · per diem at GSA rates for the city</p>
<ul class="lst" aria-label="Expenses">{rows}</ul>
<div class="tot"><span>Reimbursed to you in 2026</span><b>{f2(1846.22)}</b></div></div>{tabs("My expenses")}"""
    return phone(inner, "", "My expenses")


def p_explain():
    inner = status_bar("8:07") + top() + f"""<div class="ph-body">{charge_card("Menards", "Fri Oct 9 · 11:40 AM", 342.77)}
<h2 class="ph-h">Add the receipt</h2></div>
<div class="ph-scrim"><div class="ph-sheet" role="dialog" aria-modal="true" aria-labelledby="ex-h"><h3 id="ex-h">No receipt for Menards?</h3>
<p>Tell Dana what it was. A missing-receipt note stands in for the receipt, and Rob Hartley approves it.</p>
<div role="radiogroup" aria-label="Why" style="margin-top:8px"><label class="radio"><input type="radio" name="ex" checked><i></i>Lost or thrown away</label>
<label class="radio"><input type="radio" name="ex"><i></i>Store didn’t give one</label><label class="radio"><input type="radio" name="ex"><i></i>It’s in my email · I’ll forward it</label></div>
<label class="field-label sr" for="ex-t">What was it for?</label><textarea class="textarea" id="ex-t">Shelving and bolts for the new parts room</textarea>
<button class="btn btn--primary" type="button">Send note to Rob</button></div></div>"""
    return phone(inner, "", "No receipt, explained")


def build():
    html = head("S21 · Employee receipts", CSS) + sheet_top("S21-employee-receipts.html") + '<main id="main" class="sheet">'
    html += board_h("S21", "IA-SPEC §4.13 · §3.6.6 employee surface · §6.2 receipt chase",
                    "Tom’s phone: a receipt in the time it takes to pocket it",
                    "Tom Becker runs parts and service calls for Clive Power Equipment on Ramp card ••4410. He never sees the books. "
                    "A text arrives two minutes after the charge, the link opens that one charge with no sign-in, the camera finds the receipt’s edges, "
                    "and the match is shown back to him before he sends it. 390 wide, 44px targets, 15px text.", "390 × 844")
    caps = [("1", "The chase text", "2 minutes after the charge · quiet hours respected"),
            ("2", "One charge, no sign-in", "/r/7hQ2 opens straight to it"),
            ("3", "Camera", "edges found before the shutter"),
            ("4", "The match, shown back", "what was read · the policy’s question"),
            ("5", "Done, and what’s left", "no dead end"),
            ("6", "My receipts", "the home, when he opens the app"),
            ("7", "My expenses", "mileage, per diem, out of pocket"),
            ("8", "No receipt", "a note stands in, the owner approves")]
    phones = [p_sms(), p_charge(), p_camera(), p_matched(), p_done(), p_list(), p_expenses(), p_explain()]
    html += '<div class="phones">'
    for (no, t, c), ph in zip(caps, phones):
        html += f'<div><div class="phcap"><span class="no" aria-hidden="true">{no}</span><span><b>{t}</b><span class="t-cap">{c}</span></span></div>{ph}</div>'
    html += f"""<div class="anno-cell"><div><b>One charge per link</b><p>The token in the text opens one charge and nothing else. It expires when the charge is matched, so a forwarded text can’t browse anything.</p></div>
<div><b>The match is shown back</b><p>Merchant, total and time are read from the photo and checked against the card charge. A wrong read is fixed by retaking, not typing.</p></div>
<div><b>Policy speaks once, plainly</b><p>Clive’s policy is receipts over 25.00. The hint asks the one question policy needs, here the work order, and offers his open ones from ServiceTitan.</p></div>
<div><b>Ties to S20 and S22</b><p>The 412.38 mileage is the reimbursement Tess batches on S20. The three open charges, {f2(MISSING_TOTAL)}, are Tom’s row on Dana’s chase board, S22.</p></div></div>"""
    html += "</div>"
    html += foot()
    return html


if __name__ == "__main__":
    open("../S21-employee-receipts.html", "w").write(build())
    print("ok", MISSING_TOTAL)
