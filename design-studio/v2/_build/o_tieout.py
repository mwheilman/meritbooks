"""O19 + O21 + O22 — Proof. UI stage names: Prove balances (DB tie_out), Practice close (DB shadow_close), Signed off
(DB certified). A: Heartland month × account balance grid with subledger and outside-evidence ties.
B: AIM’s September practice close. C: AIM’s Conversion Certificate: preparer signed, reviewer signs off; refused state."""
from onb import *
from onb_data import money, HEARTLAND_CELLS, AIM_SHADOW_OPEN, AIM_MB, AIM_QB, AIM_TIMING

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
          "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]
YEARS = [2025] * 12 + [2026] * 9

CSS = """
.page{padding-top:24px}
.layers{grid-template-columns:repeat(4,minmax(0,1fr))}
.tg-wrap{position:relative;margin-top:16px;border:1px solid var(--line);background:var(--white)}
.tg-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}
.tg-bar .sp{flex:1}
.tg-legend{display:flex;gap:16px;align-items:center;font-size:12px;color:var(--ink-2)}
.tg-legend i{display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:-3px}
.tg{table-layout:fixed;width:100%}
.tg th,.tg td{height:28px;padding:0;border-bottom:1px solid var(--white);border-right:1px solid var(--white);font-size:12px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.tg thead th{height:24px;color:var(--ink-2);font-weight:500;background:var(--white);border-bottom:1px solid var(--line)}
.tg thead tr.yr th{text-align:left;padding-left:6px;font-weight:600;color:var(--ink);border-bottom:0;letter-spacing:.04em}
.tg thead tr.yr th.y26{box-shadow:inset 1px 0 var(--line-2)}
.tg th.acc,.tg td.acc{text-align:left;padding:0 12px 0 16px;width:248px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--ink);background:var(--white)}
.tg td.acc .code{font-size:12px}
.tg tr.grp td{height:28px;background:var(--canvas);text-align:left;padding-left:16px;font:600 12px/16px var(--f-text);letter-spacing:.12em;text-transform:uppercase}
.tg td.z{background:var(--pos-wash);color:var(--pos)}
.tg td.x{background:var(--neg-wash);color:var(--neg);font-weight:700;box-shadow:inset 0 0 0 1.5px var(--neg);cursor:pointer}
.tg td.x.is-open{background:var(--neg);color:var(--white)}
.tg td.s{background:repeating-linear-gradient(135deg,var(--warn-wash) 0 4px,var(--white) 4px 6px);color:var(--warn);font-weight:700;box-shadow:inset 0 0 0 1px var(--warn)}
.tg td.p{background:var(--grey-100);color:var(--ink-3)}
.tg td.c26{box-shadow:inset 1px 0 var(--line-2)}
.tg td.x.c26{box-shadow:inset 0 0 0 1.5px var(--neg)}
.tg tr.rf td{border-top:2px solid var(--midnight);font-weight:600}
.tg tr.more td{height:40px;background:var(--white);color:var(--ink-2);text-align:left;padding-left:16px}
.drill{position:absolute;z-index:20;width:480px;background:var(--white);border:1px solid var(--midnight);box-shadow:var(--float)}
.drill-h{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
.drill-h .sp{flex:1}
.drill .ev{margin:0;padding:8px 16px}
.drill p{color:var(--ink-2)}
.drill-b{padding:8px 16px 12px}
.drill .opt{display:grid;gap:0;margin-top:8px}
.drill-f{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:var(--canvas)}
.drill::before{content:"";position:absolute;right:-7px;top:174px;width:12px;height:12px;background:var(--white);border-right:1px solid var(--midnight);border-top:1px solid var(--midnight);transform:rotate(45deg)}
.ties{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr) minmax(0,6fr);gap:16px;margin-top:16px;align-items:start}
.ties .tbl-q td{height:40px;padding-top:8px;padding-bottom:8px;white-space:normal;overflow:visible}
.ties .tbl-q td .l1,.ties .tbl-q td .l2{white-space:normal}
.ties .tbl-q th{background:var(--white)}
.chk li{list-style:none;display:flex;justify-content:space-between;gap:8px;align-items:center;min-height:40px;padding:0 16px;border-bottom:1px solid var(--line)}
.chk li:last-child{border-bottom:0}
.signbar{display:flex;align-items:center;gap:16px;margin-top:16px;padding:12px 16px;background:var(--midnight);color:var(--grey-300)}
.signbar b{color:var(--warm)}
.signbar .sp{flex:1}
.signbar .btn[aria-disabled=true]{background:var(--night-800);border-color:var(--night-700);color:var(--slate)}
/* shadow close */
.sh{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;align-items:start;margin-top:16px}
.sh .tbl-q td{height:auto;padding-top:10px;padding-bottom:10px;white-space:normal}
.sh .l1,.sh .l2{white-space:normal}
.sh .tbl-q th{background:var(--white)}
.sh tr.is-done td{color:var(--ink-2)}
.cat{display:inline-block;padding:2px 6px;font:600 12px/16px var(--f-text);background:var(--grey-100);color:var(--ink-2);white-space:normal}
.resid{padding:16px}
.resid .fig-v{font-size:28px}
/* certificate — the one document in the set. Annual-report density, security-paper edge
   drawn with the monogram’s 45° stroke. */
.cert-wrap{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:32px;align-items:start;padding:32px 48px 48px;background:var(--canvas)}
.cert{position:relative;padding:14px;background:repeating-linear-gradient(135deg,var(--blue-200) 0 1.5px,var(--warm) 1.5px 5px);border:1px solid var(--electric)}
.cert-in{position:relative;background:var(--warm);border:3px double var(--electric);padding:40px 48px 36px}
.cert-top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
.cert-top img{height:28px;width:auto}
.cert-no{text-align:right}
.cert-no .outline-num{display:block;font-size:28px;line-height:32px}
.cert h2{margin-top:32px}
.cert .lede{font-size:15px;line-height:24px;color:var(--ink-2);margin-top:12px;max-width:62ch}
.cert .lede b{color:var(--ink);font-weight:600}
.cert-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-top:28px;border-top:2px solid var(--electric)}
.cert-facts div{padding:12px 16px 12px 0}
.cert-facts div+div{padding-left:16px;border-left:1px solid var(--line)}
.cert-facts .v{display:block;font-weight:600;color:var(--ink);margin-top:4px}
.cert-sec{margin-top:28px}
.cert-sec h3{font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);padding-bottom:8px;border-bottom:1px solid var(--electric)}
.cert .tbl-fs td{height:30px}
.cert .tbl-fs td.r{text-align:right;white-space:nowrap}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:36px}
.sig{border-top:1px solid var(--midnight);padding-top:8px}
.sig .nm{font-weight:600;color:var(--ink)}
.sig .script{display:block;height:40px;margin-top:-48px;margin-bottom:8px;font:700 20px/40px var(--f-display);color:var(--electric);letter-spacing:.02em}
.sig.is-pending .script{color:var(--ink-3);font:500 12px/40px var(--f-text);letter-spacing:.14em;text-transform:uppercase}
.hash{display:flex;align-items:center;gap:12px;margin-top:28px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;line-height:16px;color:var(--ink-3)}
.hash img{width:20px;height:auto}
.hash b{font-weight:600;color:var(--ink-2);font-variant-numeric:tabular-nums}
.appr{background:var(--white);border:1px solid var(--line-2);position:sticky;top:16px}
.appr .panel-sec{padding:16px}
.appr .panel-sec+.panel-sec{border-top:1px solid var(--line)}
.flips li{list-style:none;display:grid;grid-template-columns:16px minmax(0,1fr);gap:10px;padding:6px 0;color:var(--ink-2)}
.flips li b{color:var(--ink);font-weight:600}
.flips li .ico{margin-top:2px;color:var(--electric)}
.refused{margin-top:24px}
"""


def grid():
    # rows: (group, code, name, kind) kind: 'z' all zero; special cells by (row, month index)
    rows = [("Balance sheet · month-end balance", [
        ("1010", "Cash · Operating ••4471"), ("1020", "Cash · Payroll ••4489"), ("1200", "Accounts receivable"), ("1300", "Inventory"),
        ("1590", "Accumulated depreciation"), ("2000", "Accounts payable"), ("2100", "Ramp card payable"), ("2300", "Sales tax payable"),
        ("2420", "Customer deposits"), ("2610", "Bank of Iowa term loan"), ("3200", "Retained earnings")]),
        ("Income statement · month activity", [
        ("4010", "Revenue · Install"), ("4020", "Revenue · Service"), ("4030", "Revenue · Commercial"), ("5100", "Equipment &amp; materials"),
        ("5200", "Field labor"), ("6120", "Vehicle fuel"), ("6400", "Repairs &amp; maintenance")])]
    special = {("4010", 19): ("x", money(HEARTLAND_CELLS[0][3], 0)), ("4020", 19): ("x", money(HEARTLAND_CELLS[1][3], 0)),
               ("6120", 5): ("s", "stale")}
    for m in range(6):
        special[("4030", m)] = ("p", "pre")
    head1 = '<tr class="yr"><th class="acc"></th><th colspan="12">2025</th><th colspan="9" class="y26">2026</th></tr>'
    head2 = '<tr><th class="acc">MeritBooks account</th>' + "".join(f'<th scope="col">{m}<span class="sr"> {y}</span></th>' for m, y in zip(MONTHS, YEARS)) + "</tr>"
    body = ""
    for g, rs in rows:
        body += f'<tr class="grp"><td colspan="22">{g}</td></tr>'
        for code, name in rs:
            tds = ""
            for i in range(21):
                k, t = special.get((code, i), ("z", "0"))
                c26 = " c26" if i == 12 else ""
                op = " is-open" if (code, i) == ("4020", 19) else ""
                lab = {"z": "ties", "x": "difference " + t, "s": "source changed since pull", "p": "before the department existed"}[k]
                tds += f'<td class="{k}{c26}{op}" title="{name.replace("&amp;", "&")} · {MONTHS[i]} {YEARS[i]}: {lab}">{t}</td>'
            body += f'<tr><td class="acc"><span class="code">{code}</span>{name}</td>{tds}</tr>'
    body += ('<tr class="more"><td colspan="22">233 more accounts · every cell 0 · <button class="btn btn--quiet" type="button" style="margin-left:4px">Show all 251</button></td></tr>')
    rf = "".join(f'<td class="z{" c26" if i == 12 else ""}">0</td>' for i in range(20)) + '<td class="z">0</td>'
    body += f'<tr class="rf"><td class="acc">Roll-forward to cutover TB</td>{rf}</tr>'
    t = f'<table class="tg" aria-label="Balance grid, QuickBooks minus MeritBooks, by account and month"><colgroup><col style="width:248px">{"<col>" * 21}</colgroup><thead>{head1}{head2}</thead><tbody>{body}</tbody></table>'
    legend = ('<div class="tg-legend"><span><i style="background:var(--pos-wash);box-shadow:inset 0 0 0 1px var(--pos)"></i>0 ties</span>'
              '<span><i style="background:var(--neg-wash);box-shadow:inset 0 0 0 1.5px var(--neg)"></i>difference</span>'
              '<span><i style="background:repeating-linear-gradient(135deg,var(--warn-wash) 0 3px,var(--white) 3px 5px);box-shadow:inset 0 0 0 1px var(--warn)"></i>stale</span>'
              '<span><i style="background:var(--grey-100);box-shadow:inset 0 0 0 1px var(--grey-300)"></i>pre-department</span></div>')
    tbar = (f'<div class="tg-bar"><span class="t-head">QuickBooks minus MeritBooks</span><span class="t-cap">whole dollars · cents in the drill</span><span class="sp"></span>{legend}'
            f'<div class="seg" role="group" aria-label="Rows"><button type="button" aria-pressed="true">MeritBooks accounts</button><button type="button" aria-pressed="false">QuickBooks accounts</button></div></div>')
    drill = f"""<div class="drill popover" role="dialog" aria-label="Aug 2026, 4020 Revenue · Service" style="right:120px;top:330px">
<div class="drill-h"><span class="t-head">4020 Revenue · Service · Aug 2026</span><span class="sp"></span><button class="btn btn--icon btn--quiet" type="button" aria-label="Close">{ico("x")}</button></div>
<ul class="ev"><li><span>QuickBooks, mapped</span><span class="dl"></span><span class="v">186,420.00</span></li>
<li><span>MeritBooks, posted history</span><span class="dl"></span><span class="v">184,850.00</span></li>
<li class="ev-total"><span>Difference</span><span class="dl"></span><span class="v neg">1,570.00</span></li></ul>
<div class="drill-b"><p><b class="ink">One invoice explains it.</b> simPRO invoice 31877, Waukee Schools, 1,570.00, is a Service job in simPRO but sits in “Sales – Installation” in QuickBooks. History posted it by the simPRO job, so it moved rows. 4010 shows the same 1,570.00 the other way.</p>
<div class="basis"><span>Rule <b>history follows QuickBooks</b></span><span>Run <b>history · Oct 18 · 3b7d…e2</b></span></div>
</div>
<div class="drill-f"><button class="btn" type="button">Keep in Service, add reason</button><button class="btn btn--primary" type="button" style="margin-left:auto">Follow QuickBooks · re-post Aug</button></div></div>"""
    return f'<div class="tg-wrap">{tbar}{t}{drill}</div>'


def ties():
    tb = ('<section class="card" aria-labelledby="h-tb"><div class="card-h"><h3 id="h-tb">Cutover trial balance</h3><span class="t-cap">Sep 30</span></div><ul class="chk" style="padding:0">'
          f'<li><span>Debits = credits</span><span class="b tnum">4,812,604.18</span></li><li><span>Assets = liabilities + equity</span>{status("ready", "Ties")}</li>'
          f'<li><span>Year-end close on 2025</span>{status("ready", "Ran · RE rolls")}</li><li><span>Accounts with balance, unmapped</span><span class="b tnum">0</span></li></ul></section>')
    sl = [("AR detail = 1200", "214,880.40", "214,880.40"), ("AP detail = 2000", "318,206.55", "318,206.55"), ("Customer deposits = 2420", "48,300.00", "48,300.00"),
          ("WIP, 12 install jobs = 1180", "186,420.00", "186,420.00"), ("Debt register = 2610", "1,240,000.00", "1,240,000.00"),
          ("Fixed assets at cost = 1500", "812,400.00", "812,400.00"), ("Accumulated depreciation = 1590", "(402,118.20)", "(402,118.20)"),
          ("Prepaids = 1400", "22,860.00", "22,860.00"), ("Payroll liabilities = 2200", "41,206.30", "41,206.30")]
    rows = "".join(f'<tr class="q-row"><td>{a}</td><td class="n">{b}</td><td class="n">{c}</td><td class="n pos">0.00</td></tr>' for a, b, c in sl)
    slt = (f'<section class="card" aria-labelledby="h-sl"><div class="card-h"><h3 id="h-sl">Subledger &amp; schedule ties</h3><span class="t-cap">9 of 9 tie at Sep 30</span></div>'
           f'<table class="tbl tbl-q tbl-q--flush tbl-q--compact"><colgroup><col><col style="width:112px"><col style="width:112px"><col style="width:64px"></colgroup>'
           f'<thead><tr><th>Schedule = control</th><th class="n">Schedule</th><th class="n">GL</th><th class="n">Diff</th></tr></thead><tbody>{rows}</tbody></table></section>')
    ind = [("Bank · Farmers State ••4471, ••4489", "Plaid balance after 17 outstanding items", "ready", "Evidenced"),
           ("Bank of Iowa term loan", "Lender statement not attached yet", "risk", "Internal only"),
           ("Iowa sales tax", "August return + September collections", "ready", "Evidenced"),
           ("Payroll YTD by employee", "Provider’s YTD register, 41 people", "ready", "Evidenced"),
           ("1099 YTD by vendor", "QuickBooks 1099 report, 22 vendors", "ready", "Evidenced")]
    ir = "".join(f'<tr class="q-row{" is-attn" if k == "risk" else ""}"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td style="text-align:right">{status(k, w)}</td></tr>' for a, b, k, w in ind)
    it = (f'<section class="card" aria-labelledby="h-ind"><div class="card-h"><h3 id="h-ind">Ties to outside evidence</h3><span class="t-cap">4 of 5 evidenced</span></div>'
          f'<table class="tbl tbl-q tbl-q--flush"><colgroup><col><col style="width:132px"></colgroup><tbody>{ir}</tbody></table>'
          f'<div class="card-f"><span>Internal only doesn’t block. It prints on the certificate.</span><span class="sp"></span><button class="btn" type="button">{ico("upload")}Attach statement</button></div></section>')
    return f'<div class="ties">{tb}{slt}{it}</div>'


def frame_a():
    layers = ('<div class="bands layers" role="tablist" aria-label="Prove balances layers">'
              '<button class="band-tab" role="tab" type="button" aria-selected="true"><span class="eyebrow">1 · Monthly grid</span><span class="v">2 differences</span><span class="t-cap">3,140.00 · plus 1 stale cell</span></button>'
              '<button class="band-tab" role="tab" type="button" aria-selected="false"><span class="eyebrow">2 · Cutover trial balance</span><span class="v">Ties</span><span class="t-cap">4 checks pass</span></button>'
              '<button class="band-tab" role="tab" type="button" aria-selected="false"><span class="eyebrow">3 · Subledgers &amp; schedules</span><span class="v">9 of 9</span><span class="t-cap">every schedule = its control</span></button>'
              '<button class="band-tab" role="tab" type="button" aria-selected="false"><span class="eyebrow">4 · Outside evidence</span><span class="v">4 of 5</span><span class="t-cap">1 internal only</span></button></div>')
    sign = (f'<div class="signbar on-dark">{ico("lock")}<span><b>Sam Kovac signs the balance proof</b> when layers 1–3 are zero and every outside-evidence tie has a status. Open now: 2 differences, 1 stale cell.</span>'
            f'<span class="sp"></span><button class="btn btn--dark" type="button" aria-disabled="true">{ico("sign")}Sign balance proof</button></div>')
    main = (ctxline(["Mon Oct 19", "Heartland Heating &amp; Cooling", "Prove balances · day 2", '<b class="neg">2 differences · 3,140.00 · 1 stale</b>', "21 months · 251 accounts · 5,271 cells"],
                    '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Migration<span class="sl">//</span>Prove balances<span class="sl">//</span>Heartland Heating &amp; Cooling</div>'
              '<h1 class="t-title" style="margin-top:8px">Every month, every account, to zero</h1></div>'
              f'<div class="btn-row"><button class="btn" type="button">{ico("retry")}Re-pull Jun 2025</button><button class="btn" type="button">{ico("download")}Export grid</button></div></div>'
            + layers + grid() + ties() + sign + '</div>')
    a = app("client", "density-cockpit", rail_mini(CLIENT_MINI, "SK", 1), bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Migration · Prove balances", "Jump to account, job, customer…", "simPRO synced 4 min ago"), main, extra_cls="app--mini")
    return a.replace('class="app ', 'data-live class="app ', 1)


def frame_b():
    diffs = [("5110", "Cabinet materials", "Present in QuickBooks only", "Masterbrand bill, 1,416.00, synced from Buildertrend Sep 30 at 11:58 PM, after the bridge’s last read", AIM_SHADOW_OPEN[0][2], None),
             ("5210", "Subcontractors · install", "Amount differs", "Kline Tile bill: 4,464.00 in QuickBooks, 4,017.60 here; the bridge read it before a line was added", AIM_SHADOW_OPEN[1][2], None),
             ("4010", "Revenue · Remodel", "Timing", "Draw 4 for the Sorensen job invoiced Sep 30 here, Oct 1 in QuickBooks", -1840000, "Timing"),
             ("1200", "Accounts receivable", "Timing", "Same draw, balance side", -1840000, "Timing"),
             ("6610", "Meals", "Coded differently", "Ramp receipt said customer lunch; QuickBooks has it in office supplies", -21418, "MeritBooks right")]
    tr = ""
    for code, name, cat, why, v, res in diffs:
        done = res is not None
        r = (f'<span class="status status--ready"><i class="pip pip--ready" aria-hidden="true"></i>{res}</span>' if done else
             '<div class="btn-row" style="flex-wrap:nowrap"><button class="btn" type="button">Source right · adjust</button><button class="btn btn--quiet" type="button">Timing</button></div>')
        tr += (f'<tr class="q-row{" is-done" if done else " is-attn"}"><td><span class="l1"><span class="code">{code}</span>{name}</span><span class="l2">{why}</span></td>'
               f'<td><span class="cat">{cat}</span></td><td class="n">{money(v)}</td><td>{r}</td></tr>')
    tr += '<tr class="q-group"><td colspan="4"><span class="t-cap">9 more resolved · 4 timing, 3 MeritBooks right, 2 source right and adjusted</span></td></tr>'
    t = (f'<table class="tbl tbl-q tbl-q--flush" aria-label="September differences, QuickBooks vs MeritBooks"><colgroup><col><col style="width:184px"><col style="width:104px"><col style="width:268px"></colgroup>'
         f'<thead><tr><th>Account · what happened</th><th>Kind</th><th class="n">QB − MB</th><th>Resolution</th></tr></thead><tbody>{tr}</tbody></table>')
    resid = sum(v for *_, v in AIM_SHADOW_OPEN)
    side = (f'<aside class="card"><div class="card-h"><h3>Residual</h3><span class="t-cap">must be 0.00 or explained</span></div><div class="resid">'
            f'<div class="fig"><span class="fig-l">Unexplained, September</span><span class="fig-v tnum neg">{money(resid)}</span>'
            f'<span class="fig-vs"><span>was 22,861.18 on Oct 13</span><span>14 differences found</span></span></div>'
            f'<ul class="ev" style="margin-top:16px"><li><span>QuickBooks operating income, Sep</span><span class="dl"></span><span class="v">{money(AIM_QB["oi"])}</span></li>'
            f'<li><span>MeritBooks operating income, Sep</span><span class="dl"></span><span class="v">{money(AIM_MB["oi"])}</span></li>'
            f'<li class="ev-total"><span>Difference, QuickBooks − MeritBooks</span><span class="dl"></span><span class="v">{money(AIM_QB["oi"] - AIM_MB["oi"])}</span></li>'
            f'<li><span>Explained: Sorensen draw 4, timing</span><span class="dl"></span><span class="v">{money(AIM_TIMING)}</span></li>'
            f'<li><span>Explained: 10 others, net</span><span class="dl"></span><span class="v">0.00</span></li>'
            f'<li class="ev-total"><span>Unexplained</span><span class="dl"></span><span class="v neg">{money(-resid)}</span></li></ul>'
            f'<p class="t-cap" style="margin-top:12px">The two open items are the whole unexplained amount. Both are costs QuickBooks has and MeritBooks doesn’t yet.</p></div>'
            f'<div class="card-f"><button class="btn" type="button">{ico("eye")}Side by side</button><span class="sp"></span><button class="btn btn--primary" type="button" aria-disabled="true">Hand to certificate</button></div></aside>')
    main = (ctxline(["Mon Oct 19", "AIM Kitchen &amp; Bath", "Practice close · September in both systems", f'<b class="warn">2 open · {money(resid)}</b>', "Live in MeritBooks since Sep 1"],
                    '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Migration<span class="sl">//</span>Practice close<span class="sl">//</span>AIM Kitchen &amp; Bath</div>'
              '<h1 class="t-title" style="margin-top:8px">September, closed twice</h1></div>'
              f'<div class="btn-row"><span class="srcs">{src("QuickBooks", "ok", "parallel pull Oct 12")}{src("Buildertrend", "bridge", "via QB", True)}</span></div></div>'
            + f'<p class="ink-2" style="max-width:88ch">AIM kept QuickBooks running for September while working the month here. Both closed on Oct 12. Every account that differs is listed with what happened and how it was resolved.</p>'
            + f'<div class="sh"><section class="card">{t}</section>{side}</div></div>')
    return app("client", "density-cockpit", rail_mini(CLIENT_MINI, "LO", 1), bar(ctx_client("AIM Kitchen & Bath", "C-111", "Live · practice close", "open"), "Migration · Practice close", "Jump to account, job, customer…", "Bridge read 6:00 AM"), main, extra_cls="app--mini")


def certificate():
    srcs = [("QuickBooks Online", "Ledger · company ••4417", "pull · Sep 1 · 7a41…0c", "Tied"),
            ("Buildertrend via QuickBooks", "Field system · bridge, temporary", "bridge · daily", "Not independently tied"),
            ("Plaid · Farmers State ••6630", "Bank", "balance · Aug 31", "Evidenced")]
    sr = "".join(f'<tr class="fs-line"><td>{a}<span class="l2">{b}</span></td><td>{c}</td><td class="r">{d}</td></tr>' for a, b, c, d in srcs)
    res = [("Accounts matched", "254 accounts · 214 Ready, 31 Check, 9 Decide · 3 overrides with reasons · 0 type-guard exceptions"),
           ("Dimensions", "3 departments (Remodel, Cabinets, Design) · 61 open jobs linked to Buildertrend"),
           ("Data quality", "11 findings · 6 fixed in QuickBooks · 4 handled · 1 accepted with a note"),
           ("Balances proved", "Grid 20 months × 254 accounts, every cell 0 · cutover TB ties · 9 of 9 schedules · 5 of 6 outside-evidence ties, 1 internal only"),
           ("Practice close", "September in both systems · 14 differences, all explained · residual 0.00"),
           ("Carried forward", "17 outstanding bank items · 1099 YTD for 31 vendors · sales tax PTD · 1 reconciling item: unapplied deposit 840.00, Luis Ortiz, clears Oct 31")]
    rr = "".join(f'<tr class="fs-line"><td style="width:132px;vertical-align:top;padding-top:6px" class="ink-2">{a}</td><td style="height:auto;padding:6px 0;white-space:normal">{b}</td></tr>' for a, b in res)
    doc = f"""<article class="cert" aria-label="Conversion Certificate CC-0003, AIM Kitchen &amp; Bath"><div class="cert-in">
<div class="cert-top"><img src="assets/merit-logo-on-light.png" alt="Merit Management Group" width="92" height="28">
<div class="cert-no"><span class="eyebrow">Certificate</span><span class="outline-num">CC-0003</span><span class="t-cap">version 1</span></div></div>
<div class="eyebrow" style="margin-top:32px">Conversion Certificate<span class="sl">//</span>MeritBooks</div>
<h2 class="t-display" style="margin-top:8px">AIM Kitchen &amp; Bath, LLC</h2>
<p class="lede">The books of <b>AIM Kitchen &amp; Bath, LLC</b> (EIN ••-•••7731) were moved from QuickBooks Online to MeritBooks with a cutover of <b>August 31, 2026</b>.
Twenty months of history were posted and tied to the source, every subledger ties to its control, and September was closed in both systems with no unexplained difference.</p>
<div class="cert-facts"><div><span class="eyebrow">Cutover</span><span class="v">Aug 31, 2026</span></div><div><span class="eyebrow">History</span><span class="v">Jan 2025 – Aug 2026</span></div>
<div><span class="eyebrow">Accounts</span><span class="v">254</span></div><div><span class="eyebrow">Residual</span><span class="v">0.00</span></div></div>
<div class="cert-sec"><h3>Sources</h3><table class="tbl tbl-fs"><colgroup><col><col style="width:180px"><col style="width:168px"></colgroup><tbody>{sr}</tbody></table></div>
<div class="cert-sec"><h3>Results</h3><table class="tbl tbl-fs"><tbody>{rr}</tbody></table></div>
<div class="sigs"><div class="sig"><span class="script">Luis Ortiz</span><span class="nm">Prepared · Luis Ortiz</span><span class="t-cap" style="display:block">Signed the balance proof Oct 20, 2026, 4:12 PM</span></div>
<div class="sig is-pending"><span class="script">Awaiting sign-off</span><span class="nm">Signed off · Jordan Smith</span><span class="t-cap" style="display:block">Reviewer · must not be the preparer</span></div></div>
<div class="hash"><img src="assets/merit-icon.png" alt="" width="20" height="18"><span>SHA-256 <b>c41e 9a07 5bd2 … 33f8 9b07</b> over sources, snapshots and dispositions · snapshots 6 · stored in Documents on issue</span></div>
</div></article>"""
    checks = [("Balance proof signed by the preparer", "ready", "Luis Ortiz"), ("Grid, TB and schedules at zero", "ready", "Oct 20"), ("Practice close residual 0.00", "ready", "Oct 21"),
              ("Outside-evidence ties have a status", "ready", "5 + 1 internal"), ("Reviewer is not the preparer", "ready", "Jordan ≠ Luis")]
    ck = "".join(f'<li><span>{a}</span><span class="t-cap">{c}</span></li>' for a, k, c in checks)
    ck = "".join(f'<li style="list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)"><span>{status("ready", a)}</span><span class="t-cap">{c}</span></li>' for a, k, c in checks)
    flips = [("lock", "<b>Hard-close</b> Jan 2025 – Aug 2026. Reopening needs a controller and a second approver."),
             ("download", "<b>Archive QuickBooks</b>: 20 monthly P&amp;Ls and balance sheets, GL detail, agings, 1099 detail. Then its ledger role ends."),
             ("plug", "<b>Keep the Buildertrend bridge</b> reading the same QuickBooks company, labelled temporary, until Buildertrend access lands."),
             ("check", "<b>AIM becomes active</b> on Luis Ortiz’s home. The certificate PDF is filed in Documents.")]
    fl = "".join(f'<li>{ico(i)}<span>{t}</span></li>' for i, t in flips)
    appr = (f'<aside class="appr" aria-label="Sign off the certificate"><div class="panel-head"><div class="eyebrow">Your sign-off · reviewer</div>'
            f'<div class="t-head" style="margin-top:4px">Jordan Smith, sign off CC-0003?</div></div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>The packet</h3><span class="t-cap">5 of 5</span></div><ul style="padding:0">{ck}</ul></div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>When you sign off</h3></div><ul class="flips" style="padding:0">{fl}</ul></div>'
            f'<div class="panel-foot"><button class="btn" type="button">Send back to Luis</button><span class="sp"></span><button class="btn btn--primary" type="button" data-toast="Signed off and issued CC-0003">Sign off and issue</button></div></aside>')
    refused = ('<div class="refused inline-notice inline-notice--neg" role="alert"><span>' + ico("alert") + '</span><span><b>Refused state · Swan Creek, later.</b> '
               'Dana Lee signed Swan Creek’s balance proof, so she can’t sign off its certificate. The Sign off button is replaced by “Ask a reviewer”, '
               'listing Jordan Smith and Priya Natarajan. The database refuses the same sign-off if it’s attempted any other way.</span></div>')
    return f'<div class="cert-wrap">{doc}<div>{appr}{refused}</div></div>'


def build():
    body = (board_h("O19 + O21 + O22<span class=\"sl\">//</span>08-ONBOARDING §10", "Proof is the product",
                    "Three stages, in order. Prove balances: the grid puts every month of every account at zero against the source. Practice close: a real month runs in both systems and every difference is explained. "
                    "Signed off: together they become a Conversion Certificate. The preparer signs, a different person signs off, and the client’s pre-cutover months close for good.",
                    '<span class="tag">Sample data</span> O19')
            + frame(frame_a(), "O19.1 · Prove balances · Heartland, 21 months × 18 visible accounts of 251. The two red cells are one invoice; the drill says so and offers the fix.")
            + anno([("A heat grid that’s mostly green", "Every cell is QuickBooks minus MeritBooks. Zero is quiet green, a difference is red with dollars, stale is hatched, pre-department is grey."),
                    ("The roll-forward row", "Opening balance plus 21 months of activity has to equal the cutover trial balance. It catches a source that changed between pulls."),
                    ("Four layers, one gate", "Grid, cutover trial balance, subledger and schedule ties, then ties to outside evidence: bank, lender, tax, payroll and 1099."),
                    ("Signing is earned", "The sign bar names exactly what’s still open. Internal-only ties don’t block, but they print on the certificate.")])
            + section_h("O21 · Practice close", "AIM ran September in both systems")
            + frame(frame_b(), "O21.1 · Practice close · AIM, live since Sep 1 with QuickBooks in parallel. Two items left; the rest show how they were resolved.")
            + section_h("O22 · Signed off: the Conversion Certificate", "Oct 21, after the two practice-close items are explained")
            + f'<div class="frame" style="background:var(--canvas)">{certificate()}</div>'
            + '<div class="frame-cap"><span>O22.1 · The certificate as the reviewer sees it before signing off. Same layout becomes the hash-stamped PDF.</span><span>sample data</span></div>'
            + anno([("A document, not a dashboard", "The one Annual Report page in the set: Syne display name, double rule, a security-paper edge drawn with the monogram’s 45° stroke."),
                    ("Honest about each source", "QuickBooks tied, the bank evidenced, and the Buildertrend bridge printed as not independently tied, because it can’t supply control totals."),
                    ("Two people, enforced", "Preparer and reviewer are different people by database check. The refused state replaces Sign off with Ask a reviewer."),
                    ("What signing off does", "Hard-closes the history, archives QuickBooks, keeps the bridge only as a labelled transport, and hands AIM to its bookkeeper.")]))
    return page("O19 · Prove balances, practice close, sign-off", CSS, body, "O-tieout-certificate.html", """<script>
document.querySelectorAll('[data-toast]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById('toast');t.querySelector('[data-msg]').textContent=b.getAttribute('data-toast');t.hidden=false;setTimeout(function(){t.hidden=true},4000);});});
</script>""")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-tieout-certificate.html")
    open(out, "w").write(build())
    print(out)
