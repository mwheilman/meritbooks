"""O15 + O16 — Chart mapping with confidence bands ordered by dollar impact, the shared Merit standard
mapping set (conflicts across clients), and dimension inference from QuickBooks classes, RFMS and account families.
Heritage Interiors (C-101), Dana Lee preparing."""
from onb import *
from onb_data import money

CSS = """
.page{padding-top:24px}
.mp{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:0;border:1px solid var(--line);background:var(--white);margin-top:16px}
.mp-main{min-width:0;display:flex;flex-direction:column}
.mp .bands{border:0;border-bottom:1px solid var(--line)}
.mp .tbl-q th{background:var(--white)}
.mp .tbl-q td{height:56px}
.mp .arrow{color:var(--ink-3);margin:0 2px}
.mp .tg{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;white-space:nowrap}
.mp .tg--neg{color:var(--neg)} .mp .tg--warn{color:var(--warn)} .mp .tg--info{color:var(--electric)}
.mp tr.q-sum td{height:44px;background:var(--canvas);color:var(--ink-2)}
.mp tr.q-tot td{height:44px;font-weight:600;border-bottom:0}
.mp tr.q-tot td.n span{display:inline-block;padding-top:6px;border-top:1px solid var(--midnight)}
.mp .panel{border-left:1px solid var(--line-2)}
.mp .panel-body{padding-bottom:16px}
.used{list-style:none}
.used li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}
.used li.is-conf{box-shadow:inset 3px 0 var(--warn);padding-left:10px}
.used .l2{white-space:normal}
.setbar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--canvas);border-bottom:1px solid var(--line);color:var(--ink-2)}
.setbar b{color:var(--ink);font-weight:600}
.setbar .sp{flex:1}
.dims{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.dim{display:flex;flex-direction:column;background:var(--white);border:1px solid var(--line)}
.dim-h{padding:12px 16px 8px}
.dim-h .eyebrow{display:block;margin-bottom:4px}
.dim-b{padding:0 16px 12px;flex:1}
.dim-b .ev li{font-size:12px;line-height:20px}
.dim-f{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line);flex-wrap:wrap}
.dim.is-merge{box-shadow:inset 0 2px var(--electric)}
.mp .keybar{gap:16px;white-space:nowrap;padding:0 16px}
.mp .keybar .keys{margin-right:-8px}
.effect{display:flex;align-items:center;gap:16px;margin-top:16px;padding:12px 16px}
.effect .sp{flex:1}
"""

# (code, name, type, target, target_sub, conf, rule, balance_cents, activity_cents, flag)
ROWS = [
    ("1499", "Due from Swan Creek", "Asset", "1450 Due from related parties", "counterparty Swan Creek", 61, "AI proposal · capped at 89", 2460000, 3180000,
     ("warn", "Swan Creek says 22,100.00")),
    ("1205", "Inventory – samples", "Asset", "No good target", "request 1320 Showroom samples", 0, "Nothing in Merit standard v3", 1841250, 612000,
     ("info", "Request account")),
    ("2310", "Sales tax payable – Polk Co", "Liability", "6810 Taxes &amp; licenses", "proposed from the name", 48, "Name contains “tax”", 1290644, 8812400,
     ("neg", "Liability → expense")),
    ("6125", "Truck fuel – installers", "Expense", "6120 Vehicle fuel", "", 66, "Merit standard v3", 988000, 2140630,
     ("warn", "Conflict · 2 clients differ")),
    ("3900", "Opening Balance Equity", "Equity", "3200 Retained earnings", "reclass, controller approves", 70, "Preflight PF-06", 725000, 0,
     ("info", "Controller")),
    ("6990", "Ask My Accountant", "Expense", "9999 Suspense", "items go to review", 52, "Preflight PF-05", 321218, 418300,
     ("", "")),
    ("4900", "Builder rebates", "Revenue", "4950 Discounts &amp; rebates", "", 57, "Name heuristic · contained", 264000, 1906220,
     ("", "")),
]
MORE_N, MORE_BAL = 31, 1350888
DECIDE_BAL = sum(r[7] for r in ROWS) + MORE_BAL
assert DECIDE_BAL == 9241000, DECIDE_BAL
assert len(ROWS) + MORE_N == 38


def conf(n):
    if n == 0:
        return '<span class="conf conf--lo"><span class="meter" role="img" aria-label="no proposal">' + "<i></i>" * 10 + '</span><b>—</b></span>'
    on = round(n / 10)
    cells = '<i class="on"></i>' * on + "<i></i>" * (10 - on)
    lo = " conf--lo" if n < 70 else ""
    return f'<span class="conf{lo}"><span class="meter" role="img" aria-label="Confidence {n}">{cells}</span><b>{n}</b></span>'


def table():
    tr = ""
    for i, (code, name, typ, tgt, tsub, c, rule, bal, act, flag) in enumerate(ROWS):
        cur = " is-cursor" if code == "6125" else ""
        attn = " is-attn" if flag[0] == "neg" else ""
        f = ""
        if flag[0]:
            icn = {"neg": "alert", "warn": "swap", "info": "plus"}[flag[0]]
            f = f'<span class="tg tg--{flag[0]}">{ico(icn, 12)}{flag[1]}</span>'
        tgt_cls = ' class="l1 ink-2"' if tgt == "No good target" else ' class="l1"'
        tr += (f'<tr class="q-row{cur}{attn}" tabindex="0"><td><span class="l1"><span class="code">{code}</span>{name}</span><span class="l2">{typ}</span></td>'
               f'<td><span{tgt_cls}>{tgt}</span><span class="l2">{tsub or "&nbsp;"}</span></td>'
               f'<td>{conf(c)}</td><td><span class="l1" style="font-weight:400;font-size:12px">{rule}</span><span class="l2">{f or "&nbsp;"}</span></td>'
               f'<td class="n"><span class="l1">{money(bal)}</span><span class="l2">{money(act)} in 21 mo</span></td></tr>')
    tr += (f'<tr class="q-sum"><td colspan="4">{MORE_N} more in Decide, each under 2,640.00 · same order</td><td class="n">{money(MORE_BAL)}</td></tr>'
           f'<tr class="q-tot"><td colspan="4">38 accounts to decide</td><td class="n"><span>{money(DECIDE_BAL)}</span></td></tr>')
    return (f'<table class="tbl tbl-q tbl-q--flush" aria-label="Accounts to decide, largest balance first">'
            f'<colgroup><col style="width:248px"><col><col style="width:128px"><col style="width:196px"><col style="width:132px"></colgroup>'
            f'<thead><tr><th>QuickBooks account</th><th>MeritBooks account</th><th>Confidence</th><th>Why</th><th class="n"><button class="th-sort" type="button" style="min-height:32px">Balance Sep 30 {ico("down",12)}</button></th></tr></thead><tbody>{tr}</tbody></table>')


def panel():
    note = f"""<article class="note note--panel">
<div class="note-kind">Shared mapping · Merit standard v3</div>
<div class="note-title">6125 Truck fuel – installers → 6120 Vehicle fuel</div>
<p>The rule exists, but two clients set it up differently, so it can’t land in Ready on its own. Heritage only needs one answer.</p>
<ul class="used" style="margin-top:8px">
<li><span class="who"><span class="l1">AIM Kitchen &amp; Bath</span><span class="l2">6120 Vehicle fuel · Luis Ortiz, Oct 1</span></span><span class="t-cap">approved</span></li>
<li class="is-conf"><span class="who"><span class="l1">Heartland Heating &amp; Cooling</span><span class="l2">6120 Vehicle fuel + department Service · Sam Kovac, Oct 16</span></span><span class="tg tg--warn">differs</span></li>
<li><span class="who"><span class="l1">Merit Fund III</span><span class="l2">no fuel account</span></span><span class="t-cap">—</span></li></ul>
<ul class="ev"><li><span>Moves into 6120 this year</span><span class="dl"></span><span class="v">9,880.00</span></li>
<li><span>Moves into 6120 across 21 months</span><span class="dl"></span><span class="v">21,406.30</span></li></ul>
<div class="basis"><span>Confidence <b>66</b></span><span>Type <b>expense → expense</b></span><span>No balances sent to AI</span></div>
</article>"""
    opts = ('<div class="panel-sec"><div class="panel-sec-h"><h3>Your answer for Heritage</h3></div>'
            '<div style="display:grid;gap:0">'
            '<label class="radio"><input type="radio" name="fu" checked><i></i>6120 Vehicle fuel, no department</label>'
            '<label class="radio"><input type="radio" name="fu"><i></i>6120 Vehicle fuel + department, like Heartland</label>'
            '<label class="radio"><input type="radio" name="fu"><i></i>Another account…</label></div>'
            '<p class="t-cap" style="margin-top:8px">Settling the rule for every client is Jordan Smith’s call. Your answer here only maps Heritage.</p></div>')
    foot = ('<div class="panel-foot"><button class="btn" type="button">' + ico("ask") + 'Ask Jordan to settle</button><span class="sp"></span>'
            '<button class="btn btn--primary" type="button">Accept <span class="kbd">A</span></button></div>')
    return (f'<aside class="panel" aria-label="Why this mapping"><div class="panel-head"><div class="eyebrow">Row 4 of 38</div>'
            f'<div class="t-head" style="margin-top:4px">Truck fuel – installers</div></div><div class="panel-body"><div class="panel-sec">{note}</div>{opts}</div>{foot}</aside>')


def dims():
    cards = [
        ("Department", "Commercial", "QuickBooks class “Commercial”", [("Transactions", "1,840"), ("Activity, 21 months", "2,412,800.00"), ("Accounts touched", "41")],
         True, "Matches the tenant’s Commercial department (Heartland, AIM)", '<button class="btn btn--primary" type="button">' + ico("merge") + 'Merge into Commercial</button>'),
        ("Department", "Residential retail", "QuickBooks class “Retail” + RFMS store “Des Moines showroom”", [("Transactions", "3,912"), ("Activity, 21 months", "1,906,400.00"), ("Accounts touched", "37")],
         False, "", '<button class="btn" type="button">Accept</button><button class="btn btn--quiet" type="button">Rename</button>'),
        ("Department", "Builder &amp; multifamily", "Account family “Sales – Builder”, “COGS – Builder”", [("Accounts in the family", "4"), ("Activity, 21 months", "1,284,300.00"), ("Transactions", "612")],
         False, "", '<button class="btn" type="button">Accept</button><button class="btn btn--quiet" type="button">Rename</button>'),
        ("Jobs", "214 open jobs", "QuickBooks sub-customers ↔ RFMS orders by order #", [("Linked by order #", "206"), ("To review side by side", "8"), ("Revenue to date, open jobs", "1,118,240.00")],
         False, "", '<button class="btn" type="button">Review 8</button><button class="btn btn--quiet" type="button">Accept 206</button>'),
    ]
    h = ""
    for kind, name, sig, ev, merge, mnote, acts in cards:
        evh = "".join(f'<li><span>{a}</span><span class="dl"></span><span class="v">{b}</span></li>' for a, b in ev)
        mn = f'<p class="t-cap" style="margin-top:8px;color:var(--electric)">{mnote}</p>' if mnote else ""
        h += (f'<article class="dim{" is-merge" if merge else ""}"><div class="dim-h"><span class="eyebrow">{kind} · proposed</span><span class="t-head">{name}</span>'
              f'<p class="t-cap" style="margin-top:2px">{sig}</p></div><div class="dim-b"><ul class="ev" style="margin-top:4px">{evh}</ul>{mn}</div><div class="dim-f">{acts}</div></article>')
    eff = (f'<div class="effect inline-notice inline-notice--info"><span class="who"><span class="l1">Accepting the three departments re-runs the mapping.</span>'
           f'<span class="l2" style="white-space:normal">The four “Sales – X / COGS – X” families become one account plus a department. 6 accounts leave Decide and 9 move from Check to Ready. History lines get the department where QuickBooks had the class; the rest are tagged pre-department.</span></span>'
           f'<span class="sp"></span><button class="btn" type="button">Preview the change</button></div>')
    return f'<div class="dims">{h}</div>{eff}'


def build():
    bands = (f'<div class="bands" role="tablist" aria-label="Confidence bands">'
             f'<button class="band-tab" role="tab" type="button" aria-selected="true"><span class="eyebrow">Decide</span><span class="v">38</span><span class="t-cap">under 70 or a warning · {money(DECIDE_BAL)}</span></button>'
             f'<button class="band-tab" role="tab" type="button" aria-selected="false"><span class="eyebrow">Check</span><span class="v">23</span><span class="t-cap">70–89 · 41,806.20</span></button>'
             f'<button class="band-tab" role="tab" type="button" aria-selected="false"><span class="eyebrow">Ready</span><span class="v">162</span><span class="t-cap">90+ · preselected · 2,318,440.00</span></button></div>')
    setbar = (f'<div class="setbar">{ico("layers")}<span>Mapping onto <b>Merit standard v3</b> · 412 rules · used on 6 clients · 2 conflicts</span><span class="sp"></span>'
              f'<div class="seg" role="group" aria-label="View"><button type="button" aria-pressed="true">By QuickBooks account</button><button type="button" aria-pressed="false">By MeritBooks account</button></div></div>')
    bulk = (f'<div class="bulk"><b>4 need the controller</b><span class="t-cap">3 account requests, 1 equity reclass</span><span class="sp"></span>'
            f'<button class="btn" type="button">Send 4 to Priya</button><button class="btn btn--primary" type="button" aria-disabled="true">Accept all Ready · 162</button></div>')
    keybar = ('<div class="keybar"><span class="keys"><span class="kbd">J</span><span class="kbd">K</span></span> move<span class="keys"><span class="kbd">A</span></span> accept'
              '<span class="keys"><span class="kbd">E</span></span> change<span class="keys"><span class="kbd">R</span></span> request account<span class="keys"><span class="kbd">?</span></span> why'
              '<span class="sp"></span><span>AI alone never lands in Ready</span></div>')
    mp = f'<div class="mp"><div class="mp-main">{bands}{setbar}{bulk}<div style="flex:1">{table()}</div>{keybar}</div>{panel()}</div>'
    main = (ctxline(["Mon Oct 19", "Heritage Interiors", "Map · day 3", f'<b>38 to decide · {money(DECIDE_BAL)}</b>', "223 QuickBooks accounts"],
                    '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Migration<span class="sl">//</span>Map<span class="sl">//</span>Heritage Interiors</div>'
              '<h1 class="t-title" style="margin-top:8px">Chart mapping</h1></div>'
              f'<div class="btn-row"><span class="prov">QuickBooks pull Oct 16 · 223 accounts · 21 monthly TBs</span><button class="btn" type="button">{ico("download")}Export mapping</button></div></div>'
            + mp
            + '<div class="sec-h"><h2>Departments and jobs found in the data</h2><span class="t-cap">from QuickBooks classes, RFMS stores and orders, and account-name families · nothing to configure</span></div>'
            + dims() + '</div>')
    a = app("client", "density-cockpit", rail_mini(CLIENT_MINI, "DL", 1), bar(ctx_client("Heritage Interiors", "C-101"), "Migration · Map", "Jump to account, job, customer…", "RFMS synced 7:02 AM"), main, extra_cls="app--mini")
    a = a.replace('class="app ', 'data-live class="app ', 1)
    body = (board_h("O15 + O16<span class=\"sl\">//</span>08-ONBOARDING §7", "Map by the dollar, once for every client",
                    "Heritage’s 223 QuickBooks accounts map onto the Merit standard chart. Ready, Check and Decide are the same bands the bank feed uses. The Decide band is ordered by balance, "
                    "and every proposal names the rule that made it. Rules approved on AIM and Heartland arrive pre-filled here; where those clients disagree, Heritage sees the conflict.",
                    '<span class="tag">Sample data</span> O15')
            + frame(a, "O15.1 · Decide band, cursor on a shared-rule conflict. The row amounts plus the 31 more equal the band total.")
            + anno([("Ordered by dollars", "Largest cutover balance first, with 21-month activity under it. The band header, the rows and the 31-more line all sum to 92,410.00."),
                    ("The rule is the reason", "Merit standard rule, QuickBooks crosswalk, name heuristic, preflight, or AI proposal capped at 89. No balances are ever sent to the model."),
                    ("Type guard", "A liability proposed onto an expense is red and can’t be accepted without a typed reason, which prints on the certificate."),
                    ("Dimensions are found, not typed", "Classes, RFMS stores and account families become department proposals with evidence; one merges into the tenant’s existing Commercial department.")]))
    return page("O15 · Chart mapping", CSS, body, "O-mapping.html")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-mapping.html")
    open(out, "w").write(build())
    print(out)
