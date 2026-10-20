"""W1 — The workforce app, 390 first (FPB-workforce-app §1, §4). Andre Willis, install lead at Heartland Heating &
Cooling. Suite Core shell; Time from MeritProjects; Pay from the payroll provider via Books; Receipts, expenses and
policy from Books. Each card says which system owns it."""
from wf_common import *
from s21 import CSS as S21CSS, status_bar, phone

CSS = S21CSS + """
/* W1 layout only */
.phones{grid-template-columns:repeat(3,390px)}
.wtop{display:flex;align-items:center;gap:12px;height:56px;padding:0 20px;flex:none;border-bottom:1px solid var(--line)}
.wtop .mk{display:grid;place-items:center;width:32px;height:32px;background:var(--electric);color:var(--white);font:700 12px/16px var(--f-display)}
.wtop b{font-weight:600;display:block;line-height:20px}
.wtop .t-cap{display:block}
.wtop .av{margin-left:auto;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--canvas);font-weight:600;font-size:13px}
.ph-tabs{grid-template-columns:repeat(5,1fr)}
.ph-tabs a{font-size:12px}
.card{margin-top:10px;padding:12px 16px;background:var(--white);border:1px solid var(--line)}
.card-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.card-h .eyebrow{white-space:nowrap}
.card .big-t{font:600 22px/28px var(--f-text);font-variant-numeric:tabular-nums;margin-top:6px}
.card .sub{font-size:13px;line-height:20px;color:var(--ink-2)}
.card .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.card .row2 .btn{height:48px;font-size:15px}
.card.on{border-color:var(--midnight);box-shadow:inset 3px 0 var(--electric)}
.card.attn{box-shadow:inset 3px 0 var(--warn)}
.line{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px}
.line .btn{height:44px}
/* signature: the shift strip — a day as segments by job, breaks as gaps, punches as the slash */
.ss{position:relative;display:block;height:20px;background:var(--canvas)}
.ss u{position:absolute;top:0;bottom:0;background:var(--midnight)}
.ss u.j2{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--sky) 3px 6px)}
.ss u.sh{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--steel)}
.ss u.run{background:linear-gradient(90deg,var(--midnight) 70%,rgba(10,22,40,.25))}
.ss u.prop{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--sky) 3px 6px);opacity:.45}
.ss i{position:absolute;top:-3px;width:3px;height:26px;margin-left:-1px;transform:skewX(-30deg);background:var(--signal)}
.ss i.miss{background:var(--neg)}
.ss-ax{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--ink-3);margin-top:4px;font-variant-numeric:tabular-nums}
.ss-lg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:16px;color:var(--ink-2);margin-top:8px}
.ss-lg span{display:inline-flex;align-items:center;gap:6px}
.ss-lg b{display:inline-block;width:16px;height:10px;background:var(--midnight)}
.ss-lg b.j2{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--sky) 3px 6px)}
.ss-lg b.sh{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--steel)}
.wk{list-style:none;margin-top:8px}
.wk li{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;gap:8px;align-items:center;min-height:44px;border-bottom:1px solid var(--line)}
.wk .d{font-size:12px;line-height:16px;font-weight:600}
.wk .d span{display:block;font-weight:400;color:var(--ink-3)}
.wk .h{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.wk .h.neg{color:var(--neg)}
.timer{font:600 48px/56px var(--f-text);font-variant-numeric:tabular-nums;letter-spacing:-.02em;margin-top:8px}
.geo{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 12px;background:var(--pos-wash);font-size:13px;line-height:20px;color:var(--ink)}
.geo svg{color:var(--pos);flex:none}
.pick{list-style:none;margin-top:8px;border-top:1px solid var(--line)}
.pick li{border-bottom:1px solid var(--line)}
.pick label{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:center;min-height:56px;padding:6px 0}
.pick .m{font-weight:600;display:block}
.pick .s{font-size:12px;line-height:16px;color:var(--ink-3);display:block}
.seglist{list-style:none;margin-top:12px}
.seglist li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 0;border-bottom:1px solid var(--line)}
.seglist .m{font-weight:600}
.seglist .s{font-size:12px;line-height:16px;color:var(--ink-3)}
.seglist .a{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.stub{list-style:none;margin-top:8px}
.stub li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px;line-height:20px}
.stub li b{font-weight:600;font-variant-numeric:tabular-nums}
.stub li.t{border-bottom:0;border-top:1px solid var(--midnight);padding-top:8px;font-weight:600}
.net{font:600 36px/44px var(--f-text);font-variant-numeric:tabular-nums;margin-top:4px}
.rules{list-style:none;margin-top:8px;counter-reset:r}
.rules li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;line-height:20px}
.rules li::before{content:"";width:4px;height:14px;margin:3px 0 0 6px;transform:skewX(-30deg);background:var(--electric)}
.rules b{font-weight:600}
.ph-foot .opts .btn+.btn{margin-top:0}
.flag{display:block;margin-top:4px;padding:6px 10px;background:var(--warn-wash);font-size:12px;line-height:16px;color:var(--ink)}
.fieldrow{display:flex;gap:8px;align-items:center}
"""

TENANT, ME = "Heartland Heating & Cooling", "Andre Willis"
J1 = ("J-2614", "Ankeny Fire Station No. 2", "RTU replacement")
J2 = ("J-2633", "Waukee Dental Arts", "Rooftop units")
AX0, AX1 = 6.0, 17.0

# Week Oct 12-18: (day, date, segments[(start,end,job)], hours, note)
WEEK = [("Mon", "12", [(7.0, 11.5, "j1"), (12.0, 15.5, "j1")], 8.0, ""),
        ("Tue", "13", [(6.75, 11.0, "j1"), (11.5, 16.25, "j2")], 9.0, ""),
        ("Wed", "14", [(7.0, 11.5, "j2"), (12.0, 15.5, "j2")], 8.0, ""),
        ("Thu", "15", [(7.0, 11.5, "j2"), (12.0, 15.0, "prop")], 7.5, "miss"),
        ("Fri", "16", [(6.5, 11.5, "j1"), (12.0, 16.5, "j1")], 9.5, ""),
        ("Sat", "17", [(7.0, 11.0, "sh")], 4.0, ""),
        ("Sun", "18", [], 0.0, "")]
for d in WEEK:
    assert abs(sum(e - s for s, e, _ in d[2]) - d[3]) < 1e-9, d
WEEK_H = sum(d[3] for d in WEEK)
OT = WEEK_H - 40
assert WEEK_H == 46.0 and OT == 6.0
BYJOB = {"j1": 0.0, "j2": 0.0, "sh": 0.0}
for d in WEEK:
    for s, e, j in d[2]:
        BYJOB["j2" if j == "prop" else j] += e - s
assert BYJOB == {"j1": 21.75, "j2": 20.25, "sh": 4.0}

# Last paycheck Fri Oct 9 (Sep 21 - Oct 4)
REG_H, OT_H, RATE = 78.0, 1.5, 31.20
GROSS = round(REG_H * RATE + OT_H * RATE * 1.5, 2)
assert GROSS == 2503.80
DED = [("Federal income tax", 214.10), ("Social Security", round(GROSS * .062, 2)), ("Medicare", round(GROSS * .0145, 2)),
       ("Iowa income tax", 92.10), ("401(k) · 5%", round(GROSS * .05, 2)), ("Health · employee share", 98.00)]
NET = round(GROSS - sum(a for _, a in DED), 2)
assert abs(NET - 1782.86) < .001, NET

RCPT = [("Lowe’s", "Tue Oct 13", 38.12, "7 days · Kelly Brandt told today", "neg"),
        ("Kum & Go", "Fri Oct 16", 71.40, "fuel · 2 reminders · next Thu", "warn"),
        ("Johnstone Supply", "Mon Oct 19", 214.86, "J-2614 · 23 31 00 from your clock", "")]
RCPT_T = round(sum(r[2] for r in RCPT), 2)
assert abs(RCPT_T - 324.38) < .001

EXP = [("Mileage · Ankeny ↔ Sioux City", "284 mi × 0.70 · Heartland policy", 198.80, ""),
       ("Per diem · Sioux City, 2 travel days", "GSA meals 68.00 × 75% × 2", 102.00, ""),
       ("Hilton Garden Inn · 1 night", "Over the 159.00 Iowa lodging cap", 184.00, "warn")]
EXP_T = round(sum(e[2] for e in EXP), 2)
assert abs(284 * .70 - 198.80) < .001 and abs(68 * .75 * 2 - 102.00) < .001 and abs(EXP_T - 484.80) < .001


def hfmt(h):
    hh = int(h)
    mm = round((h - hh) * 60)
    s = f"{hh % 12 or 12}:{mm:02d}"
    return s


def strip(segs, punches=True, miss=False, run=False):
    span = AX1 - AX0
    out = '<span class="ss" aria-hidden="true">'
    for k, (s, e, j) in enumerate(segs):
        cls = {"j1": "", "j2": "j2", "sh": "sh", "prop": "prop", "run": "run"}[j]
        out += f'<u class="{cls}" style="left:{(s - AX0) / span * 100:.2f}%;width:{(e - s) / span * 100:.2f}%"></u>'
    if punches:
        pts = []
        for k, (s, e, j) in enumerate(segs):
            pts.append((s, ""))
            if not (j in ("prop", "run")):
                pts.append((e, ""))
            elif j == "prop" and miss:
                pts.append((e, "miss"))
        seen = set()
        for p, c in pts:
            if p in seen:
                continue
            seen.add(p)
            out += f'<i class="{c}" style="left:{(p - AX0) / span * 100:.2f}%"></i>'
    return out + "</span>"


def ax():
    return '<span class="ss-ax" aria-hidden="true"><span>6a</span><span>9a</span><span>12p</span><span>3p</span><span>5p</span></span>'


def wtop(right=None):
    return (f'<div class="wtop"><span class="mk" aria-hidden="true">HH</span><span style="min-width:0"><b>Heartland Workforce</b>'
            f'<span class="t-cap">{right or ME + " · install lead"}</span></span><span class="av" aria-hidden="true">AW</span></div>')


def tabs(cur):
    t = [("Home", "home", ""), ("Time", "clock", ""), ("Receipts", "receipt", "3"), ("Pay", "money", ""), ("More", "list", "")]
    out = '<nav class="ph-tabs" aria-label="Workforce app">'
    for l, i, c in t:
        AC = ' aria-current="page"' if l == cur else ""
        cn = f' <span class="cnt">· {c}</span>' if c else ""
        out += f'<a href="#"{AC}>{ico(i)}<span>{l}{cn}</span></a>'
    return out + "</nav>"


TODAY = [(6.0 + 58 / 60, 9.2, "j1"), (9.2, 9.65, "run")]


def p_signin():
    inner = status_bar("6:52") + f"""<div class="ph-body" style="padding-top:40px"><span class="mk" style="display:grid;place-items:center;width:56px;height:56px;background:var(--electric);color:var(--white);font:700 20px/28px var(--f-display)" aria-hidden="true">HH</span>
<h1 class="ph-h ink" style="margin-top:20px;font-size:28px;line-height:32px">Heartland Workforce</h1><p class="ph-p">Clock in, send receipts, see your pay. For {TENANT} employees.</p>
<div class="field field-m" style="margin-top:24px"><label class="field-label" for="ph">Mobile number on your employee record</label><input class="input" id="ph" value="(515) 555-0172" inputmode="tel"></div>
<button class="btn btn--primary big" type="button" style="margin-top:12px">Text me a sign-in link</button>
<button class="btn big" type="button" style="margin-top:8px;height:52px">{ico("fingerprint")}Sign in with Face ID</button>
<p class="t-cap" style="margin-top:12px">No password. After the first sign-in this phone remembers you for 30 days; pay screens ask for Face ID again.</p></div>
<div class="ph-foot" style="padding-top:8px"><p class="ph-legal" style="margin-top:0">Office staff can use Sign in with Microsoft · Powered by Merit</p></div>"""
    return phone(inner, "", "Sign in")


def p_home():
    inner = status_bar("9:39") + wtop() + f"""<div class="ph-body" style="padding-top:4px">
<div class="card on"><div class="card-h"><span class="eyebrow">On the clock</span>{own("Projects", "Time · Projects")}</div>
<div class="big-t">2 h 41 m</div><div class="sub">{J1[0]} {J1[1]} · 23 81 00 Equipment set</div>
<div style="margin-top:10px">{strip(TODAY)}</div>
<div class="row2"><button class="btn" type="button">{ico("coffee")}Start break</button><button class="btn btn--primary" type="button">{ico("stop")}Clock out</button></div></div>
<div class="card attn"><div class="card-h"><span class="eyebrow">Last week · returned</span>{own("Projects", "Time · Projects")}</div><div class="line"><span class="sub"><b class="ink">Thu has no clock-out.</b> Kelly needs it fixed for Friday’s pay.</span><button class="btn" type="button">Fix</button></div></div>
<div class="card"><div class="card-h"><span class="eyebrow">Receipts owed</span>{own("Books", "Receipts · Books")}</div><div class="line"><span><b>3 charges · {f2(RCPT_T)}</b><br><span class="sub">Ramp ••5512 · oldest Oct 13</span></span><button class="btn" type="button">{ico("camera")}Snap</button></div></div>
<div class="card"><div class="card-h"><span class="eyebrow">Next paycheck</span>{own("Check", "Pay · Check")}</div><div class="line"><span><b>Fri Oct 23</b><br><span class="sub">Last: {f2(NET)} on Oct 9</span></span><button class="btn btn--quiet" type="button">View stub</button></div></div>
<div class="card"><div class="card-h"><span class="eyebrow">To acknowledge</span>{own("Books", "Policy · Books")}</div><div class="line"><span class="sub"><b class="ink">Travel &amp; expense policy v3</b> · by Nov 1</span><button class="btn btn--quiet" type="button">Read</button></div></div>
</div>{tabs("Home")}"""
    return phone(inner, "", "Home")


def p_clockin():
    inner = status_bar("6:58") + wtop() + f"""<div class="ph-body"><div class="card-h"><h1 class="ph-h ink" style="margin-top:0">Clock in</h1>{own("Projects", "Time · Projects")}</div>
<div class="geo">{ico("pin")}<span><b>On site</b> · {J1[1]} · 120 ft from the job pin</span></div>
<p class="field-label" style="margin-top:14px">Job · scheduled for you today first</p>
<ul class="pick" role="radiogroup" aria-label="Job"><li><label class="radio"><input type="radio" name="job" checked><i></i><span><span class="m">{J1[0]} · {J1[1]}</span><span class="s">{J1[2]} · crew: you, D. Moreno · today</span></span></label></li>
<li><label class="radio"><input type="radio" name="job"><i></i><span><span class="m">{J2[0]} · {J2[1]}</span><span class="s">{J2[2]} · scheduled Thu</span></span></label></li>
<li><label class="radio"><input type="radio" name="job"><i></i><span><span class="m">Shop &amp; warehouse</span><span class="s">Not a customer job</span></span></label></li></ul>
<div class="field field-m" style="margin-top:14px"><label class="field-label" for="cc">Cost code · last used first</label><select class="select input" id="cc" style="height:48px;font-size:15px"><option>23 31 00 · Ductwork</option><option>23 81 00 · Equipment set</option><option>23 09 00 · Controls</option></select></div>
<button class="btn btn--quiet" type="button" style="margin-top:8px;height:44px">{ico("camera")}Add a site photo (optional)</button></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">{ico("play")}Clock in at 6:58 AM</button><p class="ph-legal">Location is checked only when you punch, never in between</p></div>"""
    return phone(inner, "", "Clock in")


def p_onclock():
    inner = status_bar("9:39") + wtop() + f"""<div class="ph-body"><div class="card-h"><span class="eyebrow">On the clock since 6:58 AM</span>{own("Projects", "Time · Projects")}</div>
<div class="timer">2:41:07</div><p class="sub">{J1[0]} {J1[1]}</p>
<div style="margin-top:14px">{strip(TODAY)}{ax()}</div>
<ul class="seglist" aria-label="Today so far"><li><span class="m">23 31 00 · Ductwork</span><span class="a">2:14</span><span class="s">6:58 – 9:12 AM</span></li>
<li><span class="m">23 81 00 · Equipment set</span><span class="a">0:27</span><span class="s">9:12 AM – now · crane on site</span></li></ul>
<div class="hint">{ico("coffee")}<span><b>Meal break by 11:58 AM.</b> Heartland’s policy: 30 minutes after 5 hours. We’ll remind you at 11:45.</span></div></div>
<div class="ph-foot"><div class="opts" style="margin-top:0"><button class="btn" type="button">{ico("coffee")}Start break</button><button class="btn" type="button">{ico("swap")}Switch code</button></div><button class="btn btn--primary" type="button" style="margin-top:8px">{ico("stop")}Clock out</button></div>"""
    return phone(inner, "", "On the clock")


def p_clockout():
    segs = [(6.0 + 58 / 60, 9.2, "j1"), (9.2, 11.5, "j1"), (12.0, 15.0 + 34 / 60, "j1")]
    inner = status_bar("3:34") + wtop() + f"""<div class="ph-body"><div class="card-h"><h1 class="ph-h ink" style="margin-top:0">Clock out?</h1>{own("Projects", "Time · Projects")}</div>
<div class="geo">{ico("pin")}<span><b>Leaving site</b> · {J1[1]}</span></div>
<div style="margin-top:14px">{strip(segs)}{ax()}</div>
<ul class="seglist" aria-label="Today"><li><span class="m">23 31 00 · Ductwork</span><span class="a">2:14</span><span class="s">6:58 – 9:12 AM</span></li>
<li><span class="m">23 81 00 · Equipment set</span><span class="a">5:52</span><span class="s">9:12 – 11:30 AM · 12:00 – 3:34 PM</span></li>
<li><span class="m">Meal break · unpaid</span><span class="a">0:30</span><span class="s">11:30 AM – 12:00 PM</span></li>
<li><span class="m">Worked today</span><span class="a">8:06</span><span class="s">Week so far 16:36 · overtime after 40:00</span></li></ul>
<label class="check" style="margin-top:12px;min-height:44px;align-items:flex-start"><input type="checkbox" checked><i></i><span>My time is accurate and I took my meal break</span></label></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">Clock out at 3:34 PM</button><button class="btn" type="button">Keep working</button></div>"""
    assert abs((9.2 - (6 + 58 / 60)) * 60 - 134) < .6 and abs(((11.5 - 9.2) + (15 + 34 / 60 - 12)) * 60 - 352) < .6
    return phone(inner, "", "Clock out with the day's segments")


def p_week():
    lis = ""
    for d, dt, segs, h, note in WEEK:
        lab = f'{d} {dt}: {h:.1f} hours' + (", clock-out missing" if note else "")
        st = strip(segs, miss=bool(note)) if segs else '<span class="ss" aria-hidden="true"></span>'
        lis += f'<li><span class="d">{d}<span>Oct {dt}</span></span><span><span class="sr">{lab}</span>{st}</span><span class="h{" neg" if note else ""}">{h:.1f}{"?" if note else ""}</span></li>'
    inner = status_bar("9:41") + wtop() + f"""<div class="ph-body"><div class="card-h"><h1 class="ph-h ink" style="margin-top:0">Week of Oct 12</h1>{own("Projects", "Time · Projects")}</div>
<p class="sub" style="margin-top:2px">Returned by Kelly Brandt · Mon 4:10 PM</p>
<div style="margin-top:6px">{ax()}</div>
<ul class="wk" aria-label="Days">{lis}</ul>
<div class="ss-lg"><span><b></b>{J1[0]}</span><span><b class="j2"></b>{J2[0]}</span><span><b class="sh"></b>Shop</span></div>
<div class="flag" style="margin-top:10px;padding:10px 12px;font-size:13px;line-height:20px"><b>Thu: no clock-out.</b> Your phone left Waukee Dental at 3:02 PM. Use 3:00 PM?</div></div>
<div class="ph-foot"><div class="tot" style="margin-top:0"><span>{J1[0]} {BYJOB['j1']:.2f} · {J2[0]} {BYJOB['j2']:.2f} · shop {BYJOB['sh']:.1f}</span><b>{WEEK_H:.1f} h · {OT:.1f} OT</b></div>
<button class="btn btn--primary" type="button" style="margin-top:8px">Use 3:00 PM and resubmit to Kelly</button></div>"""
    return phone(inner, "", "Timesheet week, returned")


def p_pay():
    stub = "".join(f'<li><span>{k}</span><b>({f2(a)})</b></li>' for k, a in DED)
    inner = status_bar("9:44") + wtop() + f"""<div class="ph-body"><div class="card-h"><span class="eyebrow">Paid Fri Oct 9 · Sep 21 – Oct 4</span>{own("Check", "Pay · Check")}</div>
<div class="net">{f2(NET)}</div><p class="sub">Net pay · direct deposit to checking ••6630</p>
<ul class="stub" aria-label="Pay stub"><li><span>Regular · {REG_H:.1f} h × {f2(RATE)}</span><b>{f2(REG_H * RATE)}</b></li><li><span>Overtime · {OT_H:.1f} h × {f2(RATE * 1.5)}</span><b>{f2(OT_H * RATE * 1.5)}</b></li>
<li class="t"><span>Gross</span><b>{f2(GROSS)}</b></li>{stub}<li class="t"><span>Net</span><b>{f2(NET)}</b></li></ul>
<div class="card" style="margin-top:12px"><div class="card-h"><span class="eyebrow">Your hours went to</span>{own("Books", "Ledger · Books")}</div>
<div class="sub" style="margin-top:4px">{J1[0]} {J1[1]} · <b class="ink">41.5 h</b><br>{J2[0]} {J2[1]} · <b class="ink">38.0 h</b></div></div>
<div class="line" style="margin-top:8px"><span class="sub"><b class="ink">Next: Fri Oct 23</b> · after Kelly approves last week</span><button class="btn btn--quiet" type="button">{ico("download")}PDF</button></div></div>{tabs("Pay")}"""
    assert abs(41.5 + 38.0 - (REG_H + OT_H)) < 1e-9
    return phone(inner, "", "Pay stub")


def p_receipts():
    lis = ""
    for m, d, a, s, c in RCPT:
        lis += f'<li><span><span class="m">{m}</span><br><span class="s {c}">{d} · {s}</span></span><span class="a">{f2(a)}</span></li>'
    inner = status_bar("9:46") + wtop(f"{ME} · Ramp ••5512") + f"""<div class="ph-body"><div class="card-h"><h1 class="ph-h ink" style="margin-top:0">My receipts</h1>{own("Books", "Receipts · Books")}</div>
<div class="tot" style="margin-top:8px"><span>3 charges need a receipt</span><b>{f2(RCPT_T)}</b></div>
<ul class="lst" aria-label="Needs a receipt">{lis}</ul>
<div class="hint">{ico("clock")}<span><b>The job is filled in for you.</b> You were clocked into {J1[0]} · 23 31 00 when Johnstone Supply charged at 10:42 AM yesterday. Change it if that’s wrong.</span></div>
<button class="btn btn--primary big" type="button" style="margin-top:12px">{ico("camera")}Snap the oldest first</button></div>{tabs("Receipts")}"""
    return phone(inner, "", "Receipts owed")


def p_expense():
    lis = ""
    for t, s, a, c in EXP:
        fl = '<span class="flag">Over the cap · add a reason and it goes to Kelly as an exception</span>' if c else ""
        lis += f'<li><span><span class="m">{t}</span><br><span class="s">{s}</span>{fl}</span><span class="a">{f2(a)}</span></li>'
    inner = status_bar("9:48") + wtop() + f"""<div class="ph-body"><div class="card-h"><h1 class="ph-h ink" style="margin-top:0">Daikin training</h1>{own("Books", "Expenses · Books")}</div>
<p class="sub" style="margin-top:2px">Sioux City · Sep 29–30 · draft</p>
<ul class="lst" aria-label="Lines">{lis}</ul>
<div class="field field-m" style="margin-top:12px"><label class="field-label" for="why">Reason for the hotel</label><input class="input" id="why" value="Only hotel near the training site with rooms"></div>
<div class="tot"><span>Reimbursed with an AP batch · Kelly approves</span><b>{f2(EXP_T)}</b></div></div>
<div class="ph-foot"><div class="opts" style="margin-top:0"><button class="btn" type="button">{ico("plus")}Add line</button><button class="btn" type="button">{ico("camera")}Receipt</button></div><button class="btn btn--primary" type="button" style="margin-top:8px">Submit to Kelly</button></div>"""
    return phone(inner, "", "Expense report with a policy flag")


def p_policy():
    rules = [("Receipts", "for anything 25.00 and over"), ("Meals while traveling", "up to 75.00 a day"),
             ("Lodging", "up to 159.00 a night in Iowa"), ("Mileage", "70¢ a mile in your own vehicle"),
             ("Alcohol", "only at client events, up to 50.00"), ("Gifts", "over 25.00 need approval first"),
             ("Never reimbursed", "fines, tickets, personal entertainment")]
    lis = "".join(f'<li><span><b>{k}</b> · {v}</span></li>' for k, v in rules)
    inner = status_bar("9:50") + wtop() + f"""<div class="ph-body"><div class="card-h"><span class="eyebrow">New · effective Nov 1</span>{own("Books", "Policy · Books")}</div>
<h1 class="ph-h ink">Travel &amp; expense policy v3</h1><p class="sub">Published today by Jordan Smith, Controller. What changed for you: lodging cap, gifts.</p>
<ul class="rules" aria-label="The rules, in short">{lis}</ul>
<button class="btn btn--quiet" type="button" style="margin-top:6px;height:44px">{ico("doc")}Read the full policy · 6 pages</button></div>
<div class="ph-foot"><button class="btn btn--primary" type="button">{ico("fingerprint")}Acknowledge with Face ID</button><p class="ph-legal">Records version 3, today’s date and the document’s fingerprint</p></div>"""
    return phone(inner, "", "Policy acknowledgment")


def build():
    html = head("W1 · Workforce app", CSS) + sheet_top("W1-workforce-app-mobile.html") + '<main id="main" class="sheet">'
    html += board_h("W1", "FPB-workforce-app §1 ownership · §4 screens · IA §3.6.6 · §4.13",
                    "Andre’s phone: the clock, the receipts and the paycheck in one app",
                    f"Andre Willis is an install lead at {TENANT}. One app, branded Heartland, signed in by text link. Every card says which system owns it: "
                    "time comes from MeritProjects and its supervisor approval, pay from the payroll provider through Books, receipts, expenses and the policy from Books. "
                    "The shell and sign-in are Suite Core. In-app time tracking stays out of Books, as the canon requires.", "390 × 844")
    caps = [("1", "Sign in", "text link or Face ID · Core"), ("2", "Home", "what needs doing now, by owner"),
            ("3", "Clock in", "job, cost code, on-site check"), ("4", "On the clock", "segments by cost code"),
            ("5", "Clock out", "the day, attested"), ("6", "Week, returned", "fix the missed punch, resubmit"),
            ("7", "Pay stub", "provider figures, ledger’s job split"), ("8", "Receipts", "job filled in from the clock"),
            ("9", "Expense report", "policy speaks before submit"), ("10", "Policy", "rules in short, acknowledged")]
    phones = [p_signin(), p_home(), p_clockin(), p_onclock(), p_clockout(), p_week(), p_pay(), p_receipts(), p_expense(), p_policy()]
    html += '<div class="phones">'
    for (no, t, c), ph in zip(caps, phones):
        html += phone_grid_cell(no, t, c, ph)
    html += f"""<div class="anno-cell"><div><b>Who owns what</b><p>{own("Core", "Core")} shell, sign-in, notifications · {own("Projects", "Projects")} punches, timesheets, supervisor approval · {own("Check", "Provider")} stub, W-2, PTO · {own("Books", "Books")} receipts, expenses, policy, the job split of pay.</p></div>
<div><b>The shift strip</b><p>A day from 6 AM to 5 PM: solid for {J1[0]}, hatched for {J2[0]}, outlined for shop, gaps for breaks, the slash for each punch. A red slash is a punch that’s missing.</p></div></div>
<div class="anno-cell"><div><b>Totals tie</b><p>Week: {WEEK_H:.1f} h = {BYJOB['j1']:.2f} + {BYJOB['j2']:.2f} + {BYJOB['sh']:.1f}; {OT:.1f} over 40. Pay: {f2(GROSS)} − {f2(round(GROSS - NET, 2))} = {f2(NET)}; 41.5 + 38.0 h = {REG_H + OT_H:.1f} paid.</p></div>
<div><b>Ties to S21, S22, W2</b><p>The receipt flow is S21’s. Andre’s row sits on Sam Kovac’s chase board (S22). The policy summary is generated from the rules published in W2, not written by a model.</p></div></div>"""
    html += "</div>"
    html += foot()
    return html


if __name__ == "__main__":
    open("../W1-workforce-app-mobile.html", "w").write(build())
    print("ok", WEEK_H, NET, RCPT_T, EXP_T)
