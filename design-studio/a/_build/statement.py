from common import page, nref, acct, pct
assert 1986000 - 2100000 == -412000 + 298000

ELIM = 312000
# Materials & equipment by entity: (entity, oct, sep, budget, closed?)
MAT = [
    ("Heartland Heating & Cooling", 590341, 512880, 508400, True),
    ("Dorrian HVAC", 368940, 381220, 372000, False),
    ("Metro Heating & Cooling", 412610, 431050, 418000, True),
    ("Heritage Interiors", 271050, 262330, 270000, True),
    ("Crystal Kitchen & Bath", 244470, 236910, 238000, False),
    ("Iowa Custom Cabinets", 309480, 301770, 305000, True),
    ("Revived Interiors", 152220, 149600, 150000, True),
    ("Artistry Homes", 873840, 774190, 924000, False),
    ("Clive Power Equipment", 836500, 870800, 804000, True),
    ("Swan Creek", 96150, 94400, 95000, True),
    ("AIM", 72100, 70500, 71000, True),
    ("Wild Rose", 60090, 59300, 60000, False),
]
mat = tuple(sum(m[i] for m in MAT) for i in (1, 2, 3))

REV = [
    ("HVAC", 3503500, 3712900, 3600000, 3),
    ("Interiors and cabinetry", 2598400, 2511300, 2550000, None),
    ("Homebuilding", 1986000, 1742000, 2100000, 2),
    ("Equipment sales and service", 1248500, 1301200, 1200000, None),
    ("Other operating", 859100, 842700, 850000, None),
    ("Management fees", ELIM, ELIM, ELIM, None),
    ("Intercompany eliminations", -ELIM, -ELIM, -ELIM, None),
]
COGS = [
    ("Materials and equipment", *mat, 1),
    ("Direct labor", 1486200, 1522800, 1505000, None),
    ("Subcontractors", 1062400, 948300, 1040000, None),
    ("Job overhead and vehicles", 318700, 309400, 315000, None),
]
OPEX = [
    ("Indirect salaries and wages", 912300, 905800, 920000, None),
    ("Rent and occupancy", 214600, 214600, 216000, None),
    ("Insurance", 148900, 130500, 131000, 4),
    ("Marketing", 96400, 112800, 105000, None),
    ("Professional fees", 71200, 58900, 65000, None),
    ("Software and IT", 44800, 43900, 45000, None),
    ("Management fees", ELIM, ELIM, ELIM, None),
    ("Intercompany eliminations", -ELIM, -ELIM, -ELIM, None),
    ("Other general and administrative", 88300, 91200, 90000, None),
]
BELOW = [
    ("Depreciation and amortization", 142800, 141900, 143000, None),
    ("Interest expense", 118400, 119700, 118000, None),
]


def tot(rows):
    return tuple(sum(r[i] for r in rows) for i in (1, 2, 3))


rev, cogs, opex, below = tot(REV), tot(COGS), tot(OPEX), tot(BELOW)
gp = tuple(rev[i] - cogs[i] for i in range(3))
ebitda = tuple(gp[i] - opex[i] for i in range(3))
ni = tuple(ebitda[i] - below[i] for i in range(3))
gm = tuple(gp[i] / rev[i] * 100 for i in range(3))


def fu(var, kind):
    if var == 0:
        return '<span class="fu mut">–</span>'
    fav = (var > 0) if kind == "rev" else (var < 0)
    return f'<span class="fu {"pos-t" if fav else "neg-t"}" aria-label="{"favorable" if fav else "unfavorable"}">{"F" if fav else "U"}</span>'


def row(label, o, s, b, note=None, kind="exp", cls="", lbl_cls="l", extra_attr=""):
    var = o - b
    vp = (var / abs(b) * 100) if b else 0
    material = abs(var) >= 10000 and abs(vp) >= 5
    nt = nref(note, f"See note {note}") if note else ""
    vcls = " mat" if material else ""
    return (f'<tr class="{cls}"{extra_attr}><td class="{lbl_cls}">{label}</td><td class="nt">{nt}</td>'
            f'<td class="n cur">{acct(o)}</td><td class="n">{acct(s)}</td><td class="n mut">{acct(o - s)}</td>'
            f'<td class="n">{acct(b)}</td><td class="n{vcls}">{acct(var)}</td><td class="n{vcls}">{pct(vp)}</td>'
            f'<td class="fuc">{fu(var, kind)}</td></tr>')


def head(t):
    return f'<tr class="head"><td colspan="9">{t}</td></tr>'


rows = head("Revenue")
for r in REV:
    rows += row(r[0], r[1], r[2], r[3], r[4], "rev", "elim" if r[1] < 0 or r[0] == "Management fees" else "")
rows += row("Total revenue", *rev, kind="rev", cls="sub")
rows += head("Cost of revenue")
for r in COGS:
    if r[0].startswith("Materials"):
        attr = ' aria-expanded="true" data-note="1"'
        rows += row('<button class="tw" aria-label="Collapse materials by entity"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>Materials and equipment',
                    r[1], r[2], r[3], r[4], "exp", "open", extra_attr=attr)
        for e in MAT:
            p = '' if e[4] else '<span class="pre" title="Entity not yet closed">P</span>'
            hot = " hot" if e[0].startswith("Heartland") else ""
            rows += row(f'{e[0]}{p}', e[1], e[2], e[3], None, "exp", "drill" + hot, "l ind",
                        ' data-note="1"' if hot else "")
        rows += '<tr class="drill-end"><td colspan="9"></td></tr>'
    else:
        rows += row(r[0], r[1], r[2], r[3], r[4], "exp")
rows += row("Total cost of revenue", *cogs, kind="exp", cls="sub")
rows += '<tr class="gap"><td colspan="9"></td></tr>'
rows += row("Gross profit", *gp, kind="rev", cls="sub")
rows += (f'<tr class="ratio"><td class="l">Gross margin</td><td class="nt"></td><td class="n cur">{pct(gm[0])}</td><td class="n">{pct(gm[1])}</td>'
         f'<td class="n mut">{acct(gm[0]-gm[1],1)} pts</td><td class="n">{pct(gm[2])}</td><td class="n">{acct(gm[0]-gm[2],1)} pts</td><td></td>'
         f'<td class="fuc">{fu(round(gm[0]-gm[2],3), "rev")}</td></tr>')
rows += head("Operating expenses")
for r in OPEX:
    rows += row(r[0], r[1], r[2], r[3], r[4], "exp", "elim" if r[1] < 0 or r[0] == "Management fees" else "")
rows += row("Total operating expenses", *opex, kind="exp", cls="sub")
rows += '<tr class="gap"><td colspan="9"></td></tr>'
rows += row("EBITDA", *ebitda, kind="rev", cls="sub")
for r in BELOW:
    rows += row(r[0], r[1], r[2], r[3], r[4], "exp")
rows += row("Net income before taxes", *ni, kind="rev", cls="grand")

# Note figures — computed, so the commentary ties to the table
mat_var = mat[0] - mat[2]
hh = MAT[0]
hh_var = hh[1] - hh[3]
ah = MAT[7]
art_under = ah[1] - ah[3]
other_over = mat_var - hh_var - art_under
hvac = REV[0]
ins = OPEX[2]

extra = r"""
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 352px}
.colm{padding:0 40px 64px}
.head2{display:flex;justify-content:space-between;align-items:flex-start;margin-top:24px;gap:24px}
.head2 .sub{margin-top:8px}
.ctrl{display:flex;gap:16px;align-items:center;margin-top:24px;padding:16px 0;border-top:1px solid var(--grey-200);border-bottom:1px solid var(--grey-200)}
.ctrl .lbl{font-size:var(--t-xs);letter-spacing:.14em;text-transform:uppercase;font-weight:500;color:var(--steel);margin-right:8px}
.ctrl .sp{flex:1}
.chk{display:inline-flex;align-items:center;gap:8px;height:32px;font-size:var(--t-sm);color:var(--midnight);cursor:pointer}
.chk input{appearance:none;width:16px;height:16px;border:1px solid var(--steel);background:var(--white);display:grid;place-content:center;margin:0}
.chk input:checked{background:var(--blue);border-color:var(--blue)}
.chk input:checked::after{content:"";width:8px;height:4px;border:2px solid #fff;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
table.is{margin-top:24px}
table.is th.cur,table.is td.cur{background:var(--white)}
table.is{table-layout:fixed}
table.is td{height:32px;padding:4px 8px}
table.is th{padding-left:8px;padding-right:8px}
table.is td.nt{width:40px;text-align:center;padding:0}
table.is td.nt .nref{top:0;vertical-align:middle;padding:2px 4px}
table.is th.nt{width:40px;text-align:center;padding-left:0;padding-right:0}
table.is td.fuc{width:28px;padding-left:4px;padding-right:0;text-align:center}

table.is td.n.mat{font-weight:600}
table.is tbody tr:not(.head):not(.gap):not(.drill-end):hover{background:var(--sky)}
table.is tbody tr:not(.head):not(.gap):not(.drill-end):hover td.cur{background:var(--sky)}
tr.elim td{color:var(--steel)}
tr.open td{font-weight:600}
tr.open td.l{color:var(--blue)}
.tw{display:inline-grid;place-content:center;width:32px;height:32px;margin:-4px 0 -4px -8px;color:var(--blue);vertical-align:middle}
.tw:hover{background:var(--sky)}
tr.drill td{font-size:var(--t-xs);color:var(--steel);height:28px;background:var(--canvas)}
tr.drill td.cur{background:#EFECE6}
tr.drill td.l.ind{padding-left:28px;color:var(--midnight)}
tr.drill.hot td,tr.drill.hot td.cur{background:var(--sky)}
tr.drill.hot td.l{box-shadow:inset 2px 0 0 var(--blue)}
tr.drill-end td{height:8px;padding:0;background:var(--canvas)}
.pre{display:inline-block;margin-left:8px;font-size:var(--t-xs);font-weight:700;color:var(--warn);border:1px solid var(--warn);width:16px;height:16px;line-height:14px;text-align:center}
tr.ratio td{color:var(--steel);font-size:var(--t-xs)}
.foot{margin-top:24px;display:flex;gap:32px;font-size:var(--t-xs);line-height:16px;color:var(--steel)}
.notes{padding:32px 28px 64px;border-left:1px solid var(--grey-200)}
.notes .title{margin-bottom:8px}
.notes .sub{margin-bottom:24px}
.signoff{margin-top:8px;border-top:1px solid var(--grey-300);padding-top:16px;font-size:var(--t-sm);line-height:20px;color:var(--steel)}
"""

body = f"""
<div class="wrap">
<div class="colm">
  <div class="pagehead" style="padding:32px 0 0"><div class="eyebrow">03<span class="sl">//</span>Statements</div><div class="pageno">03</div></div>
  <div class="head2">
    <div><h1 class="title">Consolidated income statement</h1>
      <p class="sub">Merit Management Group and subsidiaries · Month ended October 31, 2026 · Unaudited draft, 11 of 15 entities closed</p></div>
    <div style="display:flex;gap:8px"><button class="btn">Export PDF</button><button class="btn primary">Add to board pack</button></div>
  </div>
  <div class="ctrl" role="toolbar" aria-label="Statement options">
    <button class="btn" aria-haspopup="listbox" aria-label="Period: October 2026">October 2026 <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
    <div class="seg" role="group" aria-label="Columns"><button aria-pressed="true">Consolidated</button><button aria-pressed="false">By segment</button><button aria-pressed="false">By entity</button></div>
    <span class="sp"></span>
    <label class="chk"><input type="checkbox" checked> Show eliminations</label>
    <label class="chk"><input type="checkbox" checked> Bold material variances</label>
  </div>

  <table class="ledger is" aria-describedby="isfoot">
    <colgroup><col><col style="width:36px"><col style="width:96px"><col style="width:96px"><col style="width:88px"><col style="width:96px"><col style="width:88px"><col style="width:68px"><col style="width:24px"></colgroup>
    <thead><tr><th>In US dollars</th><th class="nt">Note</th><th class="n cur">Oct 2026</th><th class="n">Sep 2026</th><th class="n">Change</th>
      <th class="n">Budget</th><th class="n">Variance</th><th class="n">Var %</th><th></th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
  <div class="foot" id="isfoot"><span><b style="color:var(--midnight)">F / U</b> favorable or unfavorable to budget</span>
    <span><span class="pre" style="margin:0 4px 0 0">P</span> preliminary — entity not yet closed</span>
    <span><b style="color:var(--midnight)">Bold variance</b> exceeds 5% and $10,000</span>
    <span>Variance = actual − budget</span></div>
</div>

<aside class="notes" aria-labelledby="nt">
  <div class="pagehead" style="padding:0 0 24px"><div class="eyebrow">Commentary</div></div>
  <h2 class="title" id="nt">Notes to the statement</h2>
  <p class="sub">Drafted by MeritBooks from posted GL detail. The controller signs off before this goes in the board pack.</p>

  <article class="note" id="note-1" data-note="1">
    <div class="note-top"><span class="note-no" aria-hidden="true">1</span><div>
      <div class="kind">Note 1 · Materials and equipment</div>
      <h3>${mat_var:,} over budget, driven by Heartland's ${hh_var:,}</h3></div></div>
    <p>Heartland absorbed two supplier price increases on 14 jobs quoted before they took effect. Artistry ran under budget only because a closing slipped (note 2), so the underlying overage is larger than it looks.</p>
    <ul class="ev">
      <li>Heartland Heating &amp; Cooling<span class="dl"></span><span class="v">{acct(hh_var)}</span></li>
      <li>Artistry Homes, timing<span class="dl"></span><span class="v">{acct(art_under)}</span></li>
      <li>All other entities<span class="dl"></span><span class="v">{acct(other_over)}</span></li>
      <li style="font-weight:600">Total variance<span class="dl"></span><span class="v">{acct(mat_var)}</span></li>
    </ul>
    <div class="basis"><span><b>88%</b> confidence</span><span>612 GL lines · 3 price letters</span></div>
    <div class="acts"><a class="btn ghost" href="#">Open GL detail</a><a class="btn ghost" href="#">Edit note</a></div>
  </article>

  <article class="note" id="note-2" data-note="2">
    <div class="note-top"><span class="note-no" aria-hidden="true">2</span><div>
      <div class="kind">Note 2 · Homebuilding revenue</div>
      <h3>One closing moved to November 12</h3></div></div>
    <p>Lot 6 at Prairie Trail was set to close October 29. The appraisal came in late, and revenue is recognized at closing. An unbudgeted spec-home sale offset part of it.</p>
    <ul class="ev">
      <li>Lot 6, Prairie Trail, moved to Nov<span class="dl"></span><span class="v">{acct(-412000)}</span></li>
      <li>Spec home, 2210 Aspen Ct, not budgeted<span class="dl"></span><span class="v">{acct(298000)}</span></li>
      <li style="font-weight:600">Revenue vs budget<span class="dl"></span><span class="v">{acct(REV[2][1]-REV[2][3])}</span></li>
    </ul>
    <div class="basis"><span><b>Exact</b> · closing schedule</span><span>Recognized at closing</span></div>
  </article>

  <article class="note" id="note-3" data-note="3">
    <div class="note-top"><span class="note-no" aria-hidden="true">3</span><div>
      <div class="kind">Note 3 · HVAC revenue</div>
      <h3>Down ${hvac[2]-hvac[1]:,} on September — seasonal</h3></div></div>
    <p>Service calls fell 14% as cooling season ended. Replacement installs held flat. The same shoulder dip appeared in October 2025.</p>
    <ul class="ev">
      <li>Service calls, Oct vs Sep<span class="dl"></span><span class="v">1,212 vs 1,409</span></li>
      <li>Installs, Oct vs Sep<span class="dl"></span><span class="v">187 vs 189</span></li>
    </ul>
    <div class="basis"><span><b>81%</b> confidence</span><span>Work orders, 3 entities</span></div>
  </article>

  <article class="note" id="note-4" data-note="4">
    <div class="note-top"><span class="note-no" aria-hidden="true">4</span><div>
      <div class="kind">Note 4 · Insurance</div>
      <h3>Renewal landed in October, not January</h3></div></div>
    <p>General liability and auto renewed October 1 at 14.1% higher premiums. The budget assumed a January renewal. Reforecast the remaining two months.</p>
    <ul class="ev">
      <li>Change vs September<span class="dl"></span><span class="v">{acct(ins[1]-ins[2])}</span></li>
      <li>Variance to budget<span class="dl"></span><span class="v">{acct(ins[1]-ins[3])}</span></li>
    </ul>
    <div class="basis"><span><b>Exact</b> · policy schedule</span></div>
  </article>
  <p class="signoff">Controller sign-off pending · 4 notes drafted · 0 edited</p>
</aside>
</div>
"""

js = r"""
document.querySelectorAll('.tw').forEach(function(b){b.addEventListener('click',function(){
  var tr=b.closest('tr'),open=tr.getAttribute('aria-expanded')==='true';tr.setAttribute('aria-expanded',!open);
  var n=tr.nextElementSibling;while(n&&(n.classList.contains('drill')||n.classList.contains('drill-end'))){n.hidden=open;n=n.nextElementSibling}
  b.style.transform=open?'rotate(-90deg)':'';});});
"""

with open("../statement.html", "w") as f:
    f.write(page("Consolidated income statement", "Statements", body, extra, js, "Dana Ruiz", "Controller"))
print("rev", rev, "cogs", cogs, "gp", gp, "opex", opex, "ebitda", ebitda, "ni", ni, "gm", [round(x, 1) for x in gm])
print("mat", mat, "mat_var", mat_var, "hh_var", hh_var, "art", art_under, "other", other_over)
