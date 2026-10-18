import json
from common import page, nref, acct, conf_bar

ENT = {"MMG": "Merit Management Group", "Heartland": "Heartland Heating & Cooling", "Dorrian": "Dorrian HVAC",
       "Metro": "Metro Heating & Cooling", "Heritage": "Heritage Interiors", "Crystal": "Crystal Kitchen & Bath",
       "ICC": "Iowa Custom Cabinets", "Revived": "Revived Interiors", "Artistry": "Artistry Homes",
       "Clive": "Clive Power Equipment", "Swan Creek": "Swan Creek", "AIM": "AIM", "Wild Rose": "Wild Rose"}
BANK = {"MMG": "1010 · MMG Operating ••2208", "Heartland": "1010 · Heartland Operating ••4471", "Dorrian": "1010 · Dorrian Operating ••9035",
        "Metro": "1010 · Metro Operating ••6612", "Heritage": "1010 · Heritage Operating ••3390", "Crystal": "1015 · Crystal Ramp Card ••0817",
        "ICC": "1010 · ICC Operating ••7724", "Revived": "1010 · Revived Operating ••5146", "Artistry": "1010 · Artistry Operating ••8853", "Clive": "1010 · Clive Operating ••5518",
        "Swan Creek": "1010 · Swan Creek Operating ••1209", "AIM": "1010 · AIM Operating ••4480", "Wild Rose": "1010 · Wild Rose Operating ••6031"}

# date, vendor, bank text, entity, account, job, match (kind, ref), confidence, amount, (vendor, amount, date) scores, reasons
T = [
    ("Nov 4", "Amazon Marketplace", "AMAZON MKTPLACE PMTS AMZN.COM/BILL WA", "Crystal", "6420 Shop supplies", "—", ("none", "Unmatched"), 58, -186.42, (60, 50, 70),
     ["Order has 3 items; one looks like a vanity faucet, which would be job materials.", "Crystal codes Amazon to 6420 about half the time.", "Split it, or attach the order to confirm."]),
    ("Nov 3", "Jerry's Hardware", "SQ *JERRYS HARDWARE ANKENY IA", "Metro", "5100 Materials", "MH-3307", ("receipt", "Receipt"), 64, -73.18, (40, 80, 80),
     ["First charge from this vendor at Metro.", "Receipt texted by a tech on job MH-3307 the same day.", "Amount on receipt matches; vendor is new."]),
    ("Nov 3", "Iowa Dept. of Revenue", "ACH CR IA DEPT REVENUE REFUND 110326", "ICC", "2310 Sales tax payable", "—", ("none", "Unmatched"), 66, 1204.00, (90, 30, 90),
     ["A deposit from the state usually means a sales-tax overpayment refund.", "No refund is recorded as receivable, so the amount can't be matched.", "Check the September return before approving."]),
    ("Nov 2", "Check 10482", "CHECK 10482", "Heritage", "2000 Accounts payable", "—", ("multi", "2 bills"), 71, -2450.00, (50, 90, 75),
     ["Two open bills are exactly $2,450.00: Kohler Co. and Des Moines Stone.", "Check 10482 was printed Oct 29 in the Kohler payment run.", "Confirm the payee before it clears the wrong bill."]),
    ("Nov 2", "R. Alvarez", "VENMO *R ALVAREZ", "Revived", "5300 Subcontractors", "RI-0418", ("none", "Unmatched"), 74, -900.00, (70, 80, 70),
     ["Alvarez billed Revived for tile on RI-0418 twice in September.", "No W-9 on file — this payment pushes him past $600 for the year.", "Approve, then request a W-9."]),
    ("Nov 1", "Shell", "SHELL OIL 57442 URBANDALE IA", "Dorrian", "6510 Fuel", "—", ("receipt", "Receipt"), 79, -96.57, (90, 60, 95),
     ["Fuel at Shell is coded 6510 at every entity.", "Receipt image matches but the total is hand-written.", "Card belongs to a Dorrian service van."]),
    ("Oct 31", "Home Depot", "THE HOME DEPOT #2111 WEST DES MOINES", "Artistry", "5100 Materials", "AH-PT14", ("receipt", "Receipt"), 82, -1318.06, (90, 80, 70),
     ["Receipt lists lumber and fasteners for Prairie Trail lot 14.", "Superintendent's card; he buys for PT14 most weeks.", "Two days between purchase and posting."]),
    ("Oct 31", "MidAmerican Energy", "MIDAMERICAN ENERGY ACH", "Clive", "6230 Utilities", "—", ("bill", "Bill B-7731"), 86, -2904.11, (100, 70, 90),
     ["Open bill B-7731 is $2,912.40; the bank amount is $8.29 less.", "The difference matches last month's autopay credit.", "Approve to clear the bill and book the credit."]),
    ("Oct 30", "Johnstone Supply", "JOHNSTONE SUPPLY DSM 0412", "Heartland", "5100 Materials", "HH-2611", ("bill", "Bill B-20391"), 88, -3377.40, (100, 80, 80),
     ["Matches open bill B-20391 within $0.40 — a rounding credit.", "Bill is coded to job HH-2611, Beaverdale retrofit.", "Johnstone is a trusted vendor at Heartland."]),
    ("Oct 30", "Adobe", "RAMP *ADOBE CREATIVE CLD", "MMG", "6610 Software", "—", ("receipt", "Receipt"), 90, -89.99, (100, 100, 50),
     ["Same charge every month since March 2025.", "Receipt forwarded by Ramp.", "Posted 3 days after the charge."]),
    ("Nov 4", "Menards", "MENARDS ANKENY IA", "Revived", "5100 Materials", "RI-0418", ("receipt", "Receipt"), 90, -512.77, (90, 100, 70),
     ["Receipt matches to the cent.", "Revived codes Menards to 5100 on active jobs.", "RI-0418 is the only open job that bought tile this week."]),
    ("Oct 31", "Ferguson Enterprises", "FERGUSON ENT #1147 DES MOINES", "Dorrian", "5100 Materials", "DH-1174", ("bill", "Bill B-6650"), 91, -2640.00, (100, 100, 55),
     ["Matches open bill B-6650 exactly.", "Dorrian codes Ferguson to 5100 on 38 of 40 charges.", "Paid 4 days after the bill date."]),
    ("Nov 2", "Sherwin-Williams", "SHERWIN-WILLIAMS 7012", "Heritage", "5100 Materials", "HI-0722", ("receipt", "Receipt"), 92, -684.35, (100, 90, 80),
     ["Receipt from the store matches within $0.12.", "Heritage codes Sherwin-Williams to 5100.", "Job HI-0722 is the only paint job open."]),
    ("Nov 2", "Ferguson Enterprises", "FERGUSON ENT #1147 DES MOINES", "Metro", "5100 Materials", "MH-3290", ("bill", "Bill B-8812"), 93, -1876.25, (100, 100, 65),
     ["Matches open bill B-8812 exactly.", "Metro codes Ferguson to 5100 on all 51 prior charges.", "Bill references job MH-3290."]),
    ("Nov 3", "Ferguson Enterprises", "FERGUSON ENT #1147 DES MOINES", "Heartland", "5100 Materials", "HH-2611", ("bill", "Bill B-20417"), 94, -4212.80, (100, 100, 70),
     None),
    ("Nov 3", "Carrier Enterprise", "CARRIER ENTERPRISE ACH 2026", "Metro", "5110 Equipment", "MH-3307", ("bill", "Bill B-8820"), 95, -18940.00, (100, 100, 75),
     ["Matches open bill B-8820 exactly — two condensing units.", "Equipment over $10,000 is coded 5110 at Metro.", "Over the $10,000 auto-approve limit, so it waits for you."]),
    ("Nov 4", "ADP", "ADP PAYROLL FEES 110426", "ICC", "6150 Payroll processing", "—", ("bill", "Bill B-3302"), 96, -412.60, (100, 100, 80),
     ["Matches ADP's invoice exactly.", "Every ADP fee since 2024 is coded 6150.", "Weekly cadence, on schedule."]),
    ("Nov 2", "Stripe payout", "STRIPE TRANSFER ST-8W2K", "Swan Creek", "1200 Accounts receivable", "—", ("inv", "4 invoices"), 97, 12486.20, (100, 100, 85),
     ["Payout equals four paid invoices less Stripe fees of $381.80.", "Invoices INV-2291 to INV-2294 were paid Oct 30.", "Fees post to 6720 Merchant fees."]),
    ("Oct 31", "Principal Financial", "PRINCIPAL LIFE INS PREM", "MMG", "6170 Employee benefits", "—", ("bill", "Bill B-1188"), 97, -6318.00, (100, 100, 85),
     ["Matches the November premium bill exactly.", "Benefits for MMG staff, coded 6170 monthly.", "Allocation to entities runs at close."]),
    ("Nov 1", "Verizon Wireless", "VERIZON WIRELESS PAYMENTS", "AIM", "6240 Telephone", "—", ("bill", "Bill B-0951"), 98, -1142.88, (100, 100, 90),
     ["Matches the October statement exactly.", "Coded 6240 for 26 straight months.", "Autopay date."]),
]
T.sort(key=lambda t: t[7])
for t in T:
    v, a, d = t[9]
    assert abs(0.4 * v + 0.4 * a + 0.2 * d - t[7]) < 1e-9, (t[1], 0.4 * v + 0.4 * a + 0.2 * d)

CODE = {"MMG": "MMG", "Heartland": "HHC", "Dorrian": "DOR", "Metro": "MHC", "Heritage": "HER", "Crystal": "CKB", "ICC": "ICC",
        "Revived": "REV", "Artistry": "ART", "Clive": "CPE", "Swan Creek": "SWC", "AIM": "AIM", "Wild Rose": "WRS"}
FOCUS = next(i for i, t in enumerate(T) if t[1] == "Ferguson Enterprises" and t[3] == "Heartland")
HOVER = next(i for i, t in enumerate(T) if t[1] == "Ferguson Enterprises" and t[3] == "Dorrian")
sel = [i for i, t in enumerate(T) if t[7] >= 90]
sel_total = round(sum(T[i][8] for i in sel), 2)

MATCH_ICON = {
    "bill": '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 4.8 9 10 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    "receipt": '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 4.8 9 10 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    "inv": '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 4.8 9 10 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    "multi": '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v5M6 9.2v.8" stroke="currentColor" stroke-width="1.6"/></svg>',
    "none": '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
}


def band(c):
    return "hi" if c >= 90 else ("mid" if c >= 70 else "lo")


rows = ""
for i, t in enumerate(T):
    date, vendor, desc, ent, acc, job, (mk, mref), c, amt, _, _ = t
    n = i + 1
    cls = ["r"]
    if i in sel:
        cls.append("sel")
    if i == FOCUS:
        cls.append("focus")
    if i == HOVER:
        cls.append("hov")
    checked = " checked" if i in sel else ""
    vb = ""
    if i == HOVER:
        vb = '<span class="vb" title="Select all 3 Ferguson transactions in the queue">Batch 3 <kbd>V</kbd></span>'
    mcls = {"bill": "m-ok", "receipt": "m-ok", "inv": "m-ok", "multi": "m-warn", "none": "m-none"}[mk]
    rows += f"""<tr class="{' '.join(cls)}" data-i="{i}" tabindex="-1" aria-selected="{'true' if i in sel else 'false'}">
<td class="cb"><label><input type="checkbox"{checked} aria-label="Select {vendor} {acct(amt,2).split('<')[0]}"><span></span></label></td>
<td class="d tnum">{date}</td>
<td class="v"><button class="vn" title="Click to select every {vendor} transaction">{vendor}</button><span class="raw">{desc}</span>{vb}</td>
<td class="e" title="{ENT[ent]}">{CODE[ent]}</td>
<td class="a"><span class="ac">{acc}</span>{nref(n, f"Note {n}: why the AI chose this")}</td>
<td class="j tnum">{job}</td>
<td class="m {mcls}">{MATCH_ICON[mk]}<span>{mref}</span></td>
<td class="c tnum c-{band(c)}">{conf_bar(c)}<span>{c}</span></td>
<td class="n amt">{acct(amt, 2)}</td></tr>"""

data = [{"n": i + 1, "date": t[0], "vendor": t[1], "ent": ENT[t[3]], "acc": t[4], "job": t[5], "match": t[6][1],
         "conf": t[7], "amt": t[8], "s": t[9], "why": t[10] or [], "bank": BANK.get(t[3], "")} for i, t in enumerate(T)]

f = T[FOCUS]
fn = FOCUS + 1
ents = [("All", 142), ("HHC", 24), ("ART", 21), ("MHC", 19), ("DOR", 17), ("CKB", 12), ("HER", 11),
        ("ICC", 9), ("REV", 8), ("MMG", 6), ("SWC", 6), ("AIM", 5), ("WRS", 4), ("CPE", 0)]
FULL = {v: ENT[k] for k, v in CODE.items()}
FULL["All"] = "All entities"
assert sum(c for e, c in ents[1:]) == 142
estrip = "".join(
    f'<button class="es{" on" if e == "All" else ""}{" clear" if c == 0 else ""}" aria-pressed="{"true" if e == "All" else "false"}">'
    f'<span title="{FULL[e]}">{e}</span><span class="tnum">{"✓ Clear" if c == 0 else c}</span></button>' for e, c in ents)

extra = r"""
.feed{display:grid;grid-template-columns:minmax(0,1fr) 432px;height:100vh}
.q{display:flex;flex-direction:column;min-width:0;height:100vh}
.qhead{padding:24px 32px 0}
.qtitle{display:flex;align-items:flex-end;justify-content:space-between;margin-top:16px}
.qtitle .sub{margin-top:4px}
.keys{display:flex;gap:12px;font-size:var(--t-xs);color:var(--steel);align-items:center}
.keys span{display:inline-flex;gap:4px;align-items:center}
.estrip{display:flex;gap:0;margin-top:16px;border-top:1px solid var(--grey-200);border-bottom:1px solid var(--grey-200);overflow:hidden}
.es{display:flex;gap:8px;align-items:center;height:40px;padding:0 8px;font-size:var(--t-sm);color:var(--steel);border-bottom:2px solid transparent;white-space:nowrap}
.es .tnum{color:var(--midnight);font-weight:500}
.es:hover{background:var(--sky);color:var(--midnight)}
.es.on{color:var(--midnight);font-weight:600;border-bottom-color:var(--blue)}
.es.clear .tnum{color:var(--pos);font-weight:600}
.tools{display:flex;align-items:center;gap:8px;padding:12px 0}
.search{display:flex;align-items:center;gap:8px;height:32px;width:280px;padding:0 8px;border:1px solid var(--grey-300);background:var(--white);font-size:var(--t-sm);color:var(--steel)}
.search kbd{margin-left:auto}
.tools .sp{flex:1}
.tools .sortby{font-size:var(--t-xs);color:var(--steel)}
.tw{flex:1;overflow:auto;padding:0 32px;position:relative}
table.bf{width:100%;border-collapse:collapse;table-layout:fixed}
table.bf th{position:sticky;top:0;z-index:1;background:var(--warm);font-size:var(--t-xs);line-height:16px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;color:var(--steel);
  text-align:left;padding:8px 8px;border-bottom:1px solid var(--blue);white-space:nowrap}
table.bf th.n{text-align:right}
table.bf th[aria-sort] {color:var(--midnight)}
table.bf th .arr{color:var(--blue);margin-left:4px}
table.bf td{padding:0 8px;height:44px;font-size:var(--t-sm);line-height:20px;border-bottom:1px solid var(--grey-200);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
table.bf tr>*:first-child{padding-left:8px}
table.bf td.n{text-align:right;font-variant-numeric:tabular-nums}
tr.r{transition:background .12s var(--ease)}
tr.r:hover,tr.r.hov{background:var(--grey-100)}
tr.r.sel{background:#F6F9FE}
tr.r.focus,tr.r.focus:hover{background:var(--sky);box-shadow:inset 2px 0 0 var(--blue)}
tr.r.done{opacity:.5}
tr.r.flag td.v .vn{color:var(--warn)}
td.cb label{display:grid;place-content:center;width:32px;height:32px;margin-left:-8px;cursor:pointer}
td.cb input{position:absolute;opacity:0}
td.cb span{width:16px;height:16px;border:1px solid var(--steel);background:var(--white);display:grid;place-content:center}
td.cb input:checked+span{background:var(--blue);border-color:var(--blue)}
td.cb input:checked+span::after{content:"";width:8px;height:4px;border:2px solid #fff;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
td.cb input:focus-visible+span{outline:2px solid var(--blue);outline-offset:2px}
td.d{color:var(--steel)}
td.v{position:relative}
td.v .vn{display:block;font-weight:500;color:var(--midnight);text-align:left;line-height:20px;padding:6px 0;margin:-6px 0;max-width:100%;overflow:hidden;text-overflow:ellipsis}
td.v .vn:hover{color:var(--blue);text-decoration:underline;text-underline-offset:3px}
td.v .raw{display:block;font-size:var(--t-xs);line-height:16px;color:var(--steel);overflow:hidden;text-overflow:ellipsis}
.vb{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;gap:8px;align-items:center;background:var(--midnight);color:var(--white);font-size:var(--t-xs);height:28px;padding:0 4px 0 8px}
.vb kbd{background:transparent;color:var(--white);border-color:rgba(255,255,255,.55)}
td.a .ac{color:var(--midnight)}
td.a .nref{top:-4px}
td.m{display:table-cell}
td.m svg{vertical-align:-1px;margin-right:8px}
.m-ok{color:var(--midnight)} .m-ok svg{color:var(--pos)}
.m-warn{color:var(--warn);font-weight:500}
.m-none{color:var(--steel)}
td.c span:last-child{display:inline-block;width:20px;text-align:right}
.c-lo span:last-child{color:var(--neg);font-weight:600}
.c-lo .conf i.on{background:var(--neg)}
.c-mid .conf i.on{background:var(--steel)}
td.amt{font-weight:500}
.bulk{display:flex;align-items:center;gap:16px;height:56px;padding:0 32px;background:var(--midnight);color:var(--white);font-size:var(--t-sm)}
.bulk b{font-weight:600}
.bulk .mut2{color:var(--grey-300)}
.bulk .sp{flex:1}
.bulk .btn{border-color:var(--mid-700);background:transparent;color:var(--white)}
.bulk .btn:hover{border-color:var(--signal);color:var(--white);background:var(--mid-800)}
.bulk .btn.primary{background:var(--blue);border-color:var(--blue)}
.bulk .btn kbd{background:transparent;color:var(--white);border-color:rgba(255,255,255,.55)}
.toast{position:fixed;left:96px;bottom:72px;display:flex;gap:16px;align-items:center;background:var(--white);border:1px solid var(--grey-300);box-shadow:0 8px 24px rgba(10,22,40,.12);
  padding:12px 16px;font-size:var(--t-sm);color:var(--midnight);border-left:2px solid var(--pos)}
.toast a{color:var(--blue);font-weight:600}

/* Detail panel = a Note */
.panel{background:var(--canvas);border-left:1px solid var(--grey-300);display:flex;flex-direction:column;height:100vh}
.pscroll{flex:1;overflow:auto;padding:24px 32px 24px}
.ptop{display:flex;justify-content:space-between;align-items:flex-start}
.pclose{display:grid;place-content:center;width:32px;height:32px;color:var(--steel);margin:-4px -8px 0 0}
.pclose:hover{background:var(--grey-200);color:var(--midnight)}
.pamt{display:flex;justify-content:space-between;align-items:baseline;margin-top:16px;padding-bottom:16px;border-bottom:1px solid var(--blue)}
.pamt .big{font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-lg);line-height:32px;color:var(--midnight);letter-spacing:-.01em}
.pamt .meta{font-size:var(--t-xs);line-height:16px;color:var(--steel);text-align:right}
.pv{font-size:var(--t-md);font-weight:600;margin-top:16px}
.pv small{display:block;font-size:var(--t-xs);font-weight:400;color:var(--steel);line-height:16px}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;margin-top:16px}
.fld{display:flex;flex-direction:column;gap:4px}
.fld.w{grid-column:1/3}
.fld label{font-size:var(--t-xs);line-height:16px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;color:var(--steel)}
.fld .in{display:flex;align-items:center;justify-content:space-between;height:36px;padding:0 12px;background:var(--white);border:1px solid var(--grey-300);font-size:var(--t-sm);color:var(--midnight)}
.fld .in:hover{border-color:var(--steel)}
.fld .in.ai{box-shadow:inset 2px 0 0 var(--blue)}
.fld .in .tag{font-size:var(--t-xs);color:var(--blue);font-weight:600}
.psec{margin-top:24px}
.psec h4{font-size:var(--t-xs);line-height:16px;letter-spacing:.14em;text-transform:uppercase;font-weight:500;color:var(--steel);display:flex;justify-content:space-between}
.psec h4 b{color:var(--midnight);font-weight:600;letter-spacing:.08em}
table.mini{width:100%;border-collapse:collapse;margin-top:8px}
table.mini th{font-size:var(--t-xs);line-height:16px;font-weight:500;color:var(--steel);text-align:left;padding:4px 0;border-bottom:1px solid var(--blue)}
table.mini th.n,table.mini td.n{text-align:right;font-variant-numeric:tabular-nums}
table.mini td{font-size:var(--t-sm);line-height:20px;padding:4px 0;color:var(--midnight)}
table.mini tr.t td.n{border-top:1px solid var(--midnight);border-bottom:3px double var(--blue);font-weight:700}
table.mini tr.t td{font-weight:600}
table.mini td.mut{color:var(--steel)}
ol.why{list-style:none;margin-top:8px;counter-reset:w}
ol.why li{counter-increment:w;display:grid;grid-template-columns:24px 1fr;font-size:var(--t-sm);line-height:20px;color:var(--midnight);padding:8px 0;border-bottom:1px solid var(--grey-200)}
ol.why li::before{content:counter(w);font-weight:700;color:var(--blue);font-variant-numeric:tabular-nums}
.pact{display:flex;gap:8px;padding:16px 32px;border-top:1px solid var(--grey-300);background:var(--canvas)}
.pact .btn.primary{flex:1;justify-content:center}
"""

panel = f"""<aside class="panel" aria-labelledby="pn-title">
<div class="pscroll" id="pscroll">
  <div class="ptop"><div class="note-top" style="grid-template-columns:48px 1fr"><span class="note-no" id="pn-no" aria-hidden="true">{fn}</span>
    <div><div class="kind" id="pn-title">Note {fn} · AI coding</div><div class="sub" id="pn-bank">{BANK[f[3]]}</div></div></div>
    <button class="pclose" aria-label="Close panel (Esc)"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
  <div class="pamt"><span class="big tnum" id="pn-amt">{acct(f[8], 2, True).split('<')[0]}</span>
    <span class="meta"><span id="pn-date">{f[0]}, 2026</span><br>Paid out · ACH</span></div>
  <div class="pv" id="pn-vendor">{f[1]}<small>{f[2]}</small></div>

  <div class="fields">
    <div class="fld w"><label>Entity</label><div class="in ai" tabindex="0"><span id="pn-ent">{ENT[f[3]]}</span><span class="tag">AI</span></div></div>
    <div class="fld"><label>Account</label><div class="in ai" tabindex="0"><span id="pn-acc">{f[4]}</span><span class="tag">AI</span></div></div>
    <div class="fld"><label>Job</label><div class="in ai" tabindex="0"><span id="pn-job">HH-2611 · Beaverdale</span><span class="tag">AI</span></div></div>
    <div class="fld w"><label>Match</label><div class="in ai" tabindex="0"><span id="pn-match">Bill B-20417 · $4,212.80 · due Nov 18</span><span class="tag">AI</span></div></div>
    <div class="fld w"><label>Memo</label><div class="in" tabindex="0"><span class="mut" style="color:var(--steel)">PO 7781 · rough-in materials</span></div></div>
  </div>

  <div class="psec"><h4>Confidence <b id="pn-conf">{f[7]}%</b></h4>
    <table class="mini" id="pn-score"><thead><tr><th>Signal</th><th class="n">Weight</th><th class="n">Score</th><th class="n">Points</th></tr></thead>
    <tbody><tr><td>Vendor</td><td class="n">40%</td><td class="n">100</td><td class="n">40.0</td></tr>
    <tr><td>Amount</td><td class="n">40%</td><td class="n">100</td><td class="n">40.0</td></tr>
    <tr><td>Date</td><td class="n">20%</td><td class="n">70</td><td class="n">14.0</td></tr>
    <tr class="t"><td>Composite</td><td></td><td></td><td class="n">94.0</td></tr></tbody></table></div>

  <div class="psec"><h4>Why this coding</h4>
    <ol class="why" id="pn-why">
      <li><span>Amount matches open bill <b>B-20417</b> exactly, $4,212.80. Paid 2 days before the bank date.</span></li>
      <li><span>Heartland coded <b>42 of 44</b> Ferguson charges to 5100 Materials in the last 12 months.</span></li>
      <li><span>The bill references PO 7781, issued against job <b>HH-2611</b>, Beaverdale retrofit.</span></li>
    </ol></div>

  <div class="psec"><h4>Posts as <b>JE draft</b></h4>
    <table class="mini"><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
    <tbody><tr><td>2000 Accounts payable · B-20417</td><td class="n">4,212.80</td><td class="n mut">—</td></tr>
    <tr><td>1010 Heartland Operating ••4471</td><td class="n mut">—</td><td class="n">4,212.80</td></tr>
    <tr class="t"><td>Balanced</td><td class="n">4,212.80</td><td class="n">4,212.80</td></tr></tbody></table>
    <p class="sub" style="margin-top:8px">The expense was booked to 5100 when bill B-20417 was approved. This clears the payable.</p></div>

  <div class="psec"><h4>Ferguson at Heartland <b>last 5</b></h4>
    <table class="mini"><thead><tr><th>Date</th><th>Account</th><th>Job</th><th class="n">Amount</th></tr></thead>
    <tbody>
      <tr><td class="tnum">Oct 20</td><td>5100</td><td class="tnum">HH-2611</td><td class="n">(2,904.15)</td></tr>
      <tr><td class="tnum">Oct 9</td><td>5100</td><td class="tnum">HH-2588</td><td class="n">(1,118.40)</td></tr>
      <tr><td class="tnum">Sep 29</td><td>5100</td><td class="tnum">HH-2588</td><td class="n">(3,760.00)</td></tr>
      <tr><td class="tnum">Sep 17</td><td class="mut">6420</td><td class="mut">—</td><td class="n">(214.62)</td></tr>
      <tr><td class="tnum">Sep 8</td><td>5100</td><td class="tnum">HH-2570</td><td class="n">(5,402.33)</td></tr>
    </tbody></table></div>
</div>
<div class="pact"><button class="btn primary" id="approve">Approve and next <kbd>A</kbd></button>
  <button class="btn">Edit <kbd>E</kbd></button><button class="btn">Split <kbd>S</kbd></button><button class="btn">Flag <kbd>F</kbd></button></div>
</aside>"""

sel_ct = len(sel)
body = f"""
<div class="feed">
<section class="q" aria-labelledby="qt">
  <div class="qhead">
    <div style="display:flex;justify-content:space-between"><div class="eyebrow">02<span class="sl">//</span>Bank feed</div><div class="pageno">02</div></div>
    <div class="qtitle"><div><h1 class="title" id="qt">Review queue</h1>
      <p class="sub">142 to review · 61 at 90% or higher · nothing posts until you approve it</p></div>
      <div class="seg" role="group" aria-label="Status"><button aria-pressed="true">To review <span class="tnum">142</span></button><button aria-pressed="false">Flagged <span class="tnum">6</span></button><button aria-pressed="false">Approved today <span class="tnum">188</span></button></div></div>
    <div class="estrip" role="group" aria-label="Filter by entity">{estrip}</div>
    <div class="tools">
      <div class="search" role="search"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.2 9.2 12.5 12.5" stroke="currentColor" stroke-width="1.5"/></svg>Vendor, amount, account<kbd>/</kbd></div>
      <button class="btn" id="sel90" title="Selects every transaction at 90% or higher on this page">Select ≥ 90% <span class="tnum" style="color:var(--steel);font-weight:500">{sel_ct}</span></button>
      <span class="sp"></span>
      <div class="keys" aria-label="Keyboard shortcuts"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>X</kbd> select</span><span><kbd>A</kbd> approve</span>
        <span><kbd>F</kbd> flag</span><span><kbd>E</kbd> edit</span><span><kbd>V</kbd> batch</span></div>
    </div>
  </div>
  <div class="tw">
    <table class="bf" aria-label="Transactions to review">
      <colgroup><col style="width:36px"><col style="width:60px"><col><col style="width:56px"><col style="width:184px"><col style="width:76px"><col style="width:112px"><col style="width:88px"><col style="width:104px"></colgroup>
      <thead><tr><th><span class="sr">Select</span></th><th>Date</th><th>Vendor</th><th title="Entity code">Ent.</th><th>Account</th><th>Job</th><th>Match</th><th aria-sort="ascending">Conf.<span class="arr">↑</span></th><th class="n">Amount</th></tr></thead>
      <tbody id="rows">{rows}</tbody>
    </table>
  </div>
  <div class="bulk" role="region" aria-label="Bulk actions"><span><b class="tnum" id="selct">{sel_ct} selected</b> <span class="mut2">· net</span> <b class="tnum" id="seltot">{acct(sel_total, 2, True).split('<')[0]}</b></span>
    <span class="mut2">1 is over the $10,000 auto-approve limit</span><span class="sp"></span>
    <button class="btn">Flag <kbd>F</kbd></button><button class="btn">Clear <kbd>Esc</kbd></button><button class="btn primary">Approve {sel_ct} <kbd>⇧</kbd><kbd>A</kbd></button></div>
</section>
{panel}
</div>
<div class="toast" role="status" id="toast">Approved · Shell, Dorrian HVAC · posted JE-2026-10442 <a href="#">Undo <kbd>Z</kbd></a></div>
"""

js = "var TX=" + json.dumps(data, ensure_ascii=False) + ";\nvar FOCUS=" + str(FOCUS) + ";\n" + r"""
(function(){
  var rows=[].slice.call(document.querySelectorAll('#rows tr.r')),cur=FOCUS,orig=document.getElementById('pscroll').innerHTML,je=10442;
  function fmt(v){var s=Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});return v<0?'($'+s+')':'$'+s}
  function show(i){
    rows.forEach(function(r){r.classList.remove('focus')});rows[i].classList.add('focus');rows[i].scrollIntoView({block:'nearest'});cur=i;
    var t=TX[i];if(i===FOCUS){document.getElementById('pscroll').innerHTML=orig;return}
    document.getElementById('pn-no').textContent=t.n;document.getElementById('pn-title').textContent='Note '+t.n+' · AI coding';
    document.getElementById('pn-bank').textContent=t.bank;document.getElementById('pn-amt').textContent=fmt(t.amt);
    document.getElementById('pn-date').textContent=t.date+', 2026';document.getElementById('pn-vendor').firstChild.textContent=t.vendor;
    document.getElementById('pn-ent').textContent=t.ent;document.getElementById('pn-acc').textContent=t.acc;
    document.getElementById('pn-job').textContent=t.job;document.getElementById('pn-match').textContent=t.match;
    document.getElementById('pn-conf').textContent=t.conf+'%';
    var w=[40,40,20],lab=['Vendor','Amount','Date'],h='';t.s.forEach(function(s,k){h+='<tr><td>'+lab[k]+'</td><td class=n>'+w[k]+'%</td><td class=n>'+s+'</td><td class=n>'+(s*w[k]/100).toFixed(1)+'</td></tr>'});
    h+='<tr class=t><td>Composite</td><td></td><td></td><td class=n>'+(t.s[0]*.4+t.s[1]*.4+t.s[2]*.2).toFixed(1)+'</td></tr>';
    document.querySelector('#pn-score tbody').innerHTML=h;
    document.getElementById('pn-why').innerHTML=t.why.map(function(x){return '<li><span>'+x+'</span></li>'}).join('');
  }
  function recount(){var n=0,s=0;rows.forEach(function(r,i){if(r.querySelector('input').checked){n++;s+=TX[i].amt}});
    document.getElementById('selct').textContent=n+' selected';document.getElementById('seltot').textContent=fmt(Math.round(s*100)/100);}
  rows.forEach(function(r,i){r.addEventListener('click',function(e){if(e.target.closest('label,.nref'))return;show(i)});
    r.querySelector('input').addEventListener('change',function(){r.classList.toggle('sel',this.checked);recount()})});
  document.getElementById('sel90').addEventListener('click',function(){rows.forEach(function(r,i){var on=TX[i].conf>=90;r.querySelector('input').checked=on;r.classList.toggle('sel',on)});recount()});
  document.addEventListener('keydown',function(e){
    if(e.target.matches('input[type=text],textarea'))return;
    var k=e.key.toLowerCase();
    if(k==='j'){show(Math.min(rows.length-1,cur+1))}
    else if(k==='k'){show(Math.max(0,cur-1))}
    else if(k==='x'){var c=rows[cur].querySelector('input');c.checked=!c.checked;rows[cur].classList.toggle('sel',c.checked);recount()}
    else if(k==='a'&&!e.shiftKey){rows[cur].classList.add('done');var t=TX[cur];document.getElementById('toast').innerHTML='Approved · '+t.vendor+', '+t.ent+' · posted JE-2026-'+(++je)+' <a href=#>Undo <kbd>Z</kbd></a>';show(Math.min(rows.length-1,cur+1))}
    else if(k==='f'){rows[cur].classList.toggle('flag')}
    else if(k==='v'){var v=TX[cur].vendor;rows.forEach(function(r,i){if(TX[i].vendor===v){r.querySelector('input').checked=true;r.classList.add('sel')}});recount()}
    else if(k==='escape'){rows.forEach(function(r){r.querySelector('input').checked=false;r.classList.remove('sel')});recount()}
  });
})();
"""

with open("../bank-feed.html", "w") as fh:
    fh.write(page("Bank feed", "Bank feed", body, extra, js, "Jess Olsen", "Bookkeeper", collapsed=True))
print("focus", FOCUS + 1, "selected", sel_ct, sel_total)
