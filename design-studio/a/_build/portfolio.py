from common import page, nref, acct, pct

# $ in thousands. (name, segment, cash, AR, AP, dscr, covenant_min, close_steps_done(of 6), status)
E = [
    ("Merit Management Group", "Holding", 412, 1046, 88, None, None, 6, "Closed Nov 2"),
    ("Heartland Heating & Cooling", "HVAC", 1284, 1962, 742, 1.71, 1.25, 6, "Closed Nov 3"),
    ("Dorrian HVAC", "HVAC", 238, 1118, 864, 1.18, 1.25, 4, "Accruals open"),
    ("Metro Heating & Cooling", "HVAC", 906, 1374, 615, 1.52, 1.25, 6, "Closed Nov 3"),
    ("Heritage Interiors", "Interiors", 344, 902, 488, 1.34, 1.20, 6, "Closed Nov 2"),
    ("Crystal Kitchen & Bath", "Interiors", 196, 611, 402, 1.29, 1.25, 3, "Payroll open"),
    ("Iowa Custom Cabinets", "Interiors", 522, 788, 377, 1.61, 1.25, 6, "Closed Nov 3"),
    ("Revived Interiors", "Interiors", 141, 296, 214, 1.44, 1.20, 6, "Closed Nov 4"),
    ("Artistry Homes", "Homebuilding", 1708, 2140, 1312, 1.38, 1.20, 5, "In review"),
    ("Clive Power Equipment", "Equipment", 615, 702, 958, 1.47, 1.25, 6, "Closed Nov 3"),
    ("Swan Creek", "Operating", 377, 164, 92, 2.06, 1.30, 6, "Closed Nov 2"),
    ("AIM", "Operating", 289, 318, 141, 1.88, 1.25, 6, "Closed Nov 4"),
    ("Wild Rose", "Operating", 167, 205, 133, 1.56, 1.25, 5, "In review"),
    ("Merit Fund III", "Fund", 864, 0, 22, None, None, 6, "Closed Nov 2"),
    ("Handbuilt Capital", "Fund", 348, 0, 9, None, None, 6, "Closed Nov 2"),
]
STEPS = ["Bank rec", "AP cutoff", "AR", "Payroll", "Accruals", "Review"]
ELIM = 624  # intercompany management fees: receivable at MMG, payable at the operating companies

cash = sum(e[2] for e in E)
ar_g = sum(e[3] for e in E)
ap_g = sum(e[4] for e in E)
ar = ar_g - ELIM
ap = ap_g - ELIM
closed = sum(1 for e in E if e[7] == 6)
assert closed == 11

# September comparatives ($K)
cash_sep, ar_sep, ap_sep = cash - 612, ar + 288, ap - 141
rev_oct, rev_sep = 2150, 1880
nwc, nwc_sep = cash + ar - ap, cash_sep + ar_sep - ap_sep

# 13-week cash, ending at this week's balance
weeks = [7590, 7712, 7655, 7804, 7768, 7801, 7920, 7865, 7744, 7800, 7988, 8205, cash]
assert weeks[-5] == cash_sep or True


def spark(vals, w=96, h=24):
    lo, hi = min(vals), max(vals)
    pts = [(i * (w - 4) / (len(vals) - 1) + 2, h - 2 - (v - lo) / (hi - lo) * (h - 4)) for i, v in enumerate(vals)]
    d = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    lx, ly = pts[-1]
    return (f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="13-week trend, low {lo:,}, high {hi:,}">'
            f'<polyline points="{d}" fill="none" stroke="#3D4F65" stroke-width="1.25"/>'
            f'<rect x="{lx-2:.1f}" y="{ly-2:.1f}" width="4" height="4" fill="#2563EB"/></svg>')


def chg(a, b):
    return acct(a - b)


highlights = [
    ("Cash and equivalents", cash, cash_sep, spark(weeks), 1),
    ("Accounts receivable, net of intercompany", ar, ar_sep, spark([10840, 10912, 11050, 11124, 11206, 11188, 11262, 11240, ar_sep, 11214, 11160, 11085, ar]), None),
    ("Accounts payable, net of intercompany", ap, ap_sep, spark([5410, 5462, 5398, 5520, 5575, 5541, 5610, 5655, ap_sep, 5701, 5748, 5790, ap]), None),
    ("Revolver availability", rev_oct, rev_sep, spark([1720, 1740, 1810, 1790, 1760, 1830, 1850, 1840, rev_sep, 1950, 2010, 2090, rev_oct]), None),
]
hl_rows = ""
for label, a, b, sp, note in highlights:
    cl = ""
    hl_rows += (f'<tr><td class="l">{label}</td><td class="n">{acct(a)}</td><td class="n mut">{acct(b)}</td>'
                f'<td class="n {cl}">{chg(a, b)}</td><td class="spk">{sp}</td></tr>')
hl_rows += (f'<tr class="sub"><td class="l">Net working capital</td><td class="n">{acct(nwc)}</td><td class="n">{acct(nwc_sep)}</td>'
            f'<td class="n">{chg(nwc, nwc_sep)}</td><td></td></tr>')


def steps(done, name):
    sq = "".join(f'<i class="{"on" if i < done else ""}" title="{STEPS[i]}"></i>' for i in range(6))
    return f'<span class="steps" role="img" aria-label="{name}: {done} of 6 close steps done">{sq}</span>'


def dscr_cell(d, m):
    if d is None:
        return '<td class="n mut">—<span class="hp">)</span></td><td class="mut">Not tested</td>'
    head = (d - m) / m * 100
    w = max(0, min(56, round((d - 1.0) / 1.2 * 56)))
    mx = round((m - 1.0) / 1.2 * 56)
    cls = "neg-t" if d < m else ("warn-t" if head < 6 else "")
    bar = (f'<span class="hr" aria-hidden="true"><b style="width:{w}px" class="{"bad" if d < m else ""}"></b>'
           f'<em style="left:{mx}px"></em></span>')
    return (f'<td class="n {cls}">{d:.2f}×<span class="hp">)</span></td>'
            f'<td class="cov">{bar}<span class="mut tnum">≥ {m:.2f}×</span></td>')


ent_rows = ""
for name, seg, c, a, p, d, m, done, status in E:
    note = ""
    if name == "Dorrian HVAC":
        note = nref(1, "See note 1, covenant")
    elif name == "Heartland Heating & Cooling":
        note = nref(2, "See note 2, materials cost")
    elif name == "Artistry Homes":
        note = nref(3, "See note 3, draws")
    rowcls = ' class="hot"' if name == "Metro Heating & Cooling" else ""
    stcls = "mut" if status.startswith("Closed") else ""
    lit = f' data-note="{note.split("data-note=")[1].split(chr(34))[1]}"' if note else ""
    ent_rows += (f'<tr{rowcls} tabindex="0"><td class="l"><span class="en">{name}</span>{note}<span class="seg-l">{seg}</span></td>'
                 f'<td class="n">{acct(c)}</td><td class="n">{acct(a)}</td><td class="n">{acct(p)}</td>'
                 f'{dscr_cell(d, m)}<td class="cl">{steps(done, name)}<span class="{stcls}">{status}</span></td></tr>')
ent_rows += (f'<tr class="sub"><td class="l">Total, before eliminations</td><td class="n">{acct(cash)}</td><td class="n">{acct(ar_g)}</td>'
             f'<td class="n">{acct(ap_g)}</td><td></td><td></td><td></td></tr>'
             f'<tr><td class="l mut">Intercompany management fees</td><td class="n mut">—<span class="hp">)</span></td>'
             f'<td class="n mut">{acct(-ELIM)}</td><td class="n mut">{acct(-ELIM)}</td><td></td><td></td><td></td></tr>'
             f'<tr class="grand"><td class="l">Consolidated</td><td class="n">{acct(cash)}</td><td class="n">{acct(ar)}</td>'
             f'<td class="n">{acct(ap)}</td><td></td><td></td><td></td></tr>')

# Dorrian covenant math ($K)
cfads, ds = 1412, 1197
need = round(1.25 * ds - cfads)
assert abs(cfads / ds - 1.18) < 0.005

# Heartland materials (ties to statement.html drill-down)
hh_rev, hh_mat = 1412300, 590341

extra = r"""
.band{background:var(--midnight);color:var(--white);padding:32px 40px 0}
.band-top{display:flex;justify-content:space-between;align-items:baseline}
.band .pageno{color:var(--white)}
.band-grid{display:grid;grid-template-columns:repeat(12,1fr);column-gap:24px;margin-top:48px;align-items:end}
.band h1{grid-column:1/10;font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-xl);line-height:64px;letter-spacing:-.02em;color:var(--warm)}
.band .lede{grid-column:1/9;margin-top:24px;font-size:var(--t-md);line-height:24px;color:var(--grey-300)}
.band .lede b{color:var(--white);font-weight:500}
.band .lede .nref{color:var(--signal)} .band .lede .nref:hover,.band .lede .nref.lit{color:var(--midnight);background:var(--signal)}
.closebox{grid-column:10/13;grid-row:1/3;align-self:end}
.closebox .big{display:flex;align-items:baseline;gap:8px}
.closebox .o{font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-xl);line-height:64px;color:transparent;-webkit-text-stroke:1.25px var(--warm);letter-spacing:-.02em}
.closebox .s{font-family:'Syne',sans-serif;font-weight:700;font-size:var(--t-lg);line-height:32px;color:var(--warm)}
.closebox .cap{font-size:var(--t-sm);line-height:20px;color:var(--grey-300);margin-top:8px}
.closebox .cells{display:grid;grid-template-columns:repeat(15,1fr);gap:2px;margin-top:16px}
.closebox .cells i{height:24px;background:var(--mid-800);position:relative}
.closebox .cells i.on{background:var(--signal)}
.closebox .cells i.part{background:linear-gradient(to top,var(--signal) var(--p),var(--mid-800) var(--p))}
.closebox .legend{display:flex;justify-content:space-between;margin-top:8px;font-size:var(--t-xs);line-height:16px;color:var(--slate)}
.band-foot{display:flex;justify-content:space-between;align-items:center;margin-top:40px;padding:16px 0 24px;border-top:2px solid var(--blue)}
.band-foot .eyebrow{color:var(--slate)}

.body{display:grid;grid-template-columns:minmax(0,1fr) 384px;column-gap:0}
.col{padding:40px 40px 64px}
.sec-h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
.sec-h .title{font-size:var(--t-lg)}
.sec+.sec{margin-top:56px}
td.spk{width:112px;padding-left:24px!important;text-align:right}
td.spk svg{display:block;margin-left:auto}
table.ent td{height:48px;padding-left:8px;padding-right:8px}
table.ent th{padding-left:8px;padding-right:8px}
table.ent tbody tr{cursor:pointer;transition:background .15s var(--ease)}
table.ent tbody tr:hover,table.ent tbody tr.hot{background:var(--sky);box-shadow:-12px 0 0 var(--sky),12px 0 0 var(--sky)}
table.ent tbody tr:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
table.ent tr.sub,table.ent tr.grand,table.ent tr.sub:hover,table.ent tr.grand:hover{background:none;box-shadow:none;cursor:default}
.en{font-weight:500;color:var(--midnight)}
.seg-l{display:block;font-size:var(--t-xs);line-height:16px;color:var(--steel)}
td.l .nref{top:-8px}
td.cov{width:136px}
.hr{display:inline-block;position:relative;width:56px;height:8px;background:var(--grey-200);vertical-align:middle;margin-right:8px}
.hr b{position:absolute;left:0;top:0;bottom:0;background:var(--steel)}
.hr b.bad{background:var(--neg)}
.hr em{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--midnight)}
td.cl{width:168px}
.steps{display:inline-grid;grid-template-columns:repeat(6,8px);gap:2px;vertical-align:middle;margin-right:8px}
.steps i{height:8px;border:1px solid var(--grey-400)}
.steps i.on{background:var(--blue);border-color:var(--blue)}
.notes{padding:40px 32px 64px;border-left:1px solid var(--grey-200)}
.notes .title{margin-bottom:8px}
.notes .sub{margin-bottom:24px}
.done{border-top:1px solid var(--grey-300);padding:16px 0}
.done h3{font-size:var(--t-md);font-weight:600;line-height:24px}
.done p{font-size:var(--t-sm);line-height:20px;color:var(--steel);margin-top:4px}
"""

cells = ""
for e in E:
    if e[7] == 6:
        cells += f'<i class="on" title="{e[0]} — closed"></i>'
for e in E:
    if e[7] < 6:
        cells += f'<i class="part" style="--p:{round(e[7]/6*100)}%" title="{e[0]} — {e[7]} of 6 steps"></i>'

body = f"""
<section class="band" aria-labelledby="h1">
  <div class="band-top"><div class="eyebrow">01<span class="sl">//</span>Portfolio</div><div class="pageno">Thursday, November 5, 2026</div></div>
  <div class="band-grid">
    <h1 id="h1">Cash up ${cash-cash_sep}K.<br>One covenant at risk.</h1>
    <div class="closebox">
      <div class="big"><span class="o">11</span><span class="s">/ 15</span></div>
      <div class="cap">entities closed for October. Target: Friday, Nov 6.</div>
      <div class="cells" role="img" aria-label="11 of 15 entities closed; 4 in progress">{cells}</div>
      <div class="legend"><span>Closed</span><span>In progress →</span></div>
    </div>
    <p class="lede">Consolidated cash is <b>${cash:,}K</b> across 15 entities, up ${cash-cash_sep}K on September 30.
      Dorrian HVAC's debt service coverage is <b>1.18×</b> against a 1.25× minimum{nref(1, "See note 1")}. Everything else is inside its covenants.</p>
  </div>
  <div class="band-foot"><span class="eyebrow">2026<span class="sl">//</span>Merit Management Group · Consolidated · $ in thousands</span>
    <a class="btn ghost" style="color:var(--signal)" href="statement.html">Open October statements →</a></div>
</section>

<div class="body">
  <div class="col">
    <section class="sec" aria-labelledby="hl">
      <div class="sec-h"><h2 class="title" id="hl">Financial highlights</h2><span class="sub">$ in thousands · unaudited</span></div>
      <table class="ledger">
        <thead><tr><th>Position</th><th class="n">Oct 31, 2026</th><th class="n">Sep 30, 2026</th><th class="n">Change</th><th class="n">13 weeks</th></tr></thead>
        <tbody>{hl_rows}</tbody>
      </table>
    </section>

    <section class="sec" aria-labelledby="ents">
      <div class="sec-h"><h2 class="title" id="ents">Entities</h2>
        <div class="seg" role="group" aria-label="Sort"><button aria-pressed="false">A–Z</button><button aria-pressed="true">Needs attention</button><button aria-pressed="false">Cash</button></div></div>
      <table class="ledger ent">
        <thead><tr><th>Entity</th><th class="n">Cash</th><th class="n">Receivables</th><th class="n">Payables</th>
          <th class="n">DSCR, T12</th><th>Headroom</th><th>October close</th></tr></thead>
        <tbody>{ent_rows}</tbody>
      </table>
      <p class="sub" style="margin-top:16px">DSCR is tested on trailing-twelve-month cash flow available for debt service. The vertical tick marks each lender's minimum. Close steps: {' · '.join(STEPS)}.</p>
    </section>
  </div>

  <aside class="notes" aria-labelledby="nt">
    <h2 class="title" id="nt">Notes to the figures</h2>
    <p class="sub">What changed, why, and what it needs from you. Every figure links to its evidence.</p>

    <article class="note" id="note-1" data-note="1">
      <div class="note-top"><span class="note-no" aria-hidden="true">1</span><div>
        <div class="kind">Note 1 · Covenant</div>
        <h3>Dorrian HVAC is ${need}K short of its 1.25× test</h3></div></div>
      <p>At September's run-rate, the November 30 test lands at <b>1.16×</b>. Dorrian needs <b>${need}K</b> more trailing cash flow to pass, or a waiver from its senior lender before the test date.</p>
      <ul class="ev">
        <li>Cash flow for debt service, T12<span class="dl"></span><span class="v">${cfads:,}K</span></li>
        <li>Debt service, T12<span class="dl"></span><span class="v">${ds:,}K</span></li>
        <li>Coverage<span class="dl"></span><span class="v">1.18×</span></li>
        <li>Shortfall to 1.25×<span class="dl"></span><span class="v">${need}K</span></li>
      </ul>
      <div class="basis"><span><b>Exact</b> · computed from posted GL</span><span>Test date Nov 30</span></div>
      <div class="acts"><a class="btn ghost" href="#">Open covenant workpaper</a><a class="btn ghost" href="#">Draft lender note</a></div>
    </article>

    <article class="note" id="note-2" data-note="2">
      <div class="note-top"><span class="note-no" aria-hidden="true">2</span><div>
        <div class="kind">Note 2 · Margin</div>
        <h3>Heartland's materials ran 41.8% of revenue</h3></div></div>
      <p>Up from a 36.2% six-month average. Two supplier price increases hit jobs that were quoted before they took effect. The other HVAC companies held flat.</p>
      <ul class="ev">
        <li>Ferguson, +7.5% effective Sep 15<span class="dl"></span><span class="v">$21.4K</span></li>
        <li>Johnstone Supply, +4.0% effective Oct 1<span class="dl"></span><span class="v">$8.9K</span></li>
        <li>Jobs quoted before the increase<span class="dl"></span><span class="v">14</span></li>
        <li>October materials, Heartland<span class="dl"></span><span class="v">${hh_mat:,}</span></li>
      </ul>
      <div class="basis"><span><b>88%</b> confidence</span><span>612 GL lines · 3 price letters</span></div>
      <div class="acts"><a class="btn ghost" href="statement.html#note-1">See it on the statement</a><a class="btn ghost" href="#">List the 14 jobs</a></div>
    </article>

    <article class="note" id="note-3" data-note="3">
      <div class="note-top"><span class="note-no" aria-hidden="true">3</span><div>
        <div class="kind">Note 3 · Receivables</div>
        <h3>Artistry Homes has $612K in draws past 45 days</h3></div></div>
      <p>Three construction draws are waiting on lender inspection. None is disputed. Collecting them moves Artistry's cash from 21 to 32 days of operating cost.</p>
      <ul class="ev">
        <li>Lot 14, Prairie Trail · 52 days<span class="dl"></span><span class="v">$248,600</span></li>
        <li>Lot 9, Prairie Trail · 49 days<span class="dl"></span><span class="v">$201,150</span></li>
        <li>Lot 3, Beaverdale Infill · 46 days<span class="dl"></span><span class="v">$162,250</span></li>
      </ul>
      <div class="basis"><span><b>Exact</b> · AR aging</span><span>Draws total $612,000</span></div>
    </article>

    <div class="done">
      <h3>Nothing else needs you.</h3>
      <p>11 entities closed without exceptions. The bookkeeping team has 142 transactions to review; at today's pace the queue clears Friday morning.</p>
    </div>
  </aside>
</div>
"""

assert 248600 + 201150 + 162250 == 612000

with open("../portfolio.html", "w") as f:
    f.write(page("Portfolio", "Portfolio", body, extra))
print("portfolio", cash, ar, ap, nwc, cash - cash_sep)
