"""F2 — FP&A analysis in the consolidated context: variance bridge by client, forecast layers, scenarios, industry KPIs
(FPB-reports-fpna §2, §3 A3/A5/A6/A7/A9, §1.8; IA §3.6.5 Budget vs actual & FP&A)."""
from rf_common import *
from data import BY, G
from rf_data import (CL_BRIDGE, G_EB_BUD, G_EB_ACT, MO_ACT, MO_COM, MO_EST, MO_BUD, BAND, TOT_YTD, TOT_COM, TOT_EST, TOT_BUD,
                     SC_BASE, SCEN, HVAC_KPI)

CSS = """
.f2 .figs .fig-vs b{font-weight:600;color:var(--ink)}
.fan{display:block;width:100%;height:auto;overflow:visible}
.fan .grid{stroke:var(--line)}
.fan .ax{stroke:var(--midnight)}
.fan .bud{fill:none;stroke:var(--steel);stroke-width:1}
.fan .act{fill:var(--midnight)}
.fan .com{fill:url(#hatch-com)}
.fan .est{fill:var(--white);stroke:var(--blue-300);stroke-width:1.5}
.fan .wh{stroke:var(--ink-2);stroke-width:1.5}
.fan text{font:500 12px/16px var(--f-text);fill:var(--ink-3);font-variant-numeric:tabular-nums}
.fan text.m{fill:var(--ink-2)}
.fan text.cur{fill:var(--ink);font-weight:700}
.fan text.v{fill:var(--ink);font-weight:600}
.fan g.mo{cursor:pointer}
.fan g.mo:focus{outline:none}
.fan g.mo:focus rect.hit,.fan g.mo:hover rect.hit{fill:var(--sky)}
.fan rect.hit{fill:transparent}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 24px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.strip>div{display:flex;flex-direction:column;gap:2px}
.strip .tnum{font-weight:500}
.strip .tnum.b{font-weight:700}
.side-kv{background:var(--canvas);padding:24px}
.side-kv .kv{gap:10px 16px}
.side-kv .kv dt.t,.side-kv .kv dd.t{font-weight:700;border-top:1px solid var(--midnight);padding-top:8px}
.sc{display:grid;grid-template-columns:232px repeat(4,minmax(0,1fr));border-top:2px solid var(--electric)}
.sc>div{padding:12px 16px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);min-width:0}
.sc>div:nth-child(5n){border-right:0}
.sc .h .t-head{display:block;margin-top:4px}
.sc .h p{font-size:12px;line-height:16px;color:var(--ink-2);margin-top:4px}
.sc .base{background:var(--canvas)}
.sc .m{color:var(--ink-2);display:flex;align-items:center}
.sc .v{display:block;font:600 15px/24px var(--f-text);font-variant-numeric:tabular-nums}
.sc .d{display:block;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.sc .d.neg{color:var(--neg)} .sc .d.pos{color:var(--pos)} .sc .d.z{color:var(--ink-3)}
.kpi td{height:48px}
.kpi td.cl{font-weight:500}
.kpi .src{font-size:12px;line-height:16px;color:var(--ink-3)}
.lowv{display:inline-flex;align-items:center;gap:4px}
.lowv i{display:inline-block;width:8px;height:8px;background:var(--neg)}
.peers{display:flex;align-items:center;gap:16px;margin-top:12px;font-size:12px;line-height:16px;color:var(--ink-3)}
.peers .rul{vertical-align:middle}
"""


def fan(w=768, h=280):
    top, base = 28, h - 40
    hi = max(max(MO_BUD), max(c + e * (1 + b) for c, e, b in zip(MO_COM, MO_EST, BAND)), max(MO_ACT)) * 1.06
    y = lambda v: top + (hi - v) / hi * (base - top)
    slot = (w - 8) / 12
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    out = [f'<svg class="fan" viewBox="0 0 {w} {h}" role="group" aria-label="Group revenue by month, FY 2026: actual January to September, committed and estimated October to December, against budget">']
    for i in range(1, 5):
        gy = y(hi * i / 4.6)
        out.append(f'<line class="grid" x1="0" x2="{w}" y1="{gy:.1f}" y2="{gy:.1f}"/>')
    for i in range(12):
        x0 = 4 + slot * i
        bw = slot * 0.58
        cx = x0 + (slot - bw) / 2
        b = MO_BUD[i]
        if i < 9:
            v = MO_ACT[i]
            lab = f"{names[i]}: actual {f0(v)}, budget {f0(b)}"
            body = f'<rect class="act" x="{cx + 4:.1f}" y="{y(v):.1f}" width="{bw - 8:.1f}" height="{y(0) - y(v):.1f}"/>'
            val = ""
        else:
            j = i - 9
            c, e, bd = MO_COM[j], MO_EST[j], BAND[j]
            lo, up = c + e * (1 - bd), c + e * (1 + bd)
            lab = f"{names[i]}: committed {f0(c)}, estimated {f0(e)}, range {f0(round(lo))} to {f0(round(up))}, budget {f0(b)}"
            body = (f'<rect class="com" x="{cx + 4:.1f}" y="{y(c):.1f}" width="{bw - 8:.1f}" height="{y(0) - y(c):.1f}"/>'
                    f'<rect class="est" x="{cx + 4.75:.1f}" y="{y(c + e):.1f}" width="{bw - 9.5:.1f}" height="{y(c) - y(c + e):.1f}"/>'
                    f'<line class="wh" x1="{cx + bw / 2:.1f}" x2="{cx + bw / 2:.1f}" y1="{y(up):.1f}" y2="{y(lo):.1f}"/>'
                    f'<line class="wh" x1="{cx + bw / 2 - 5:.1f}" x2="{cx + bw / 2 + 5:.1f}" y1="{y(up):.1f}" y2="{y(up):.1f}"/>'
                    f'<line class="wh" x1="{cx + bw / 2 - 5:.1f}" x2="{cx + bw / 2 + 5:.1f}" y1="{y(lo):.1f}" y2="{y(lo):.1f}"/>')
            val = f'<text class="v" x="{cx + bw / 2:.1f}" y="{y(up) - 6:.1f}" text-anchor="middle">{(c + e) / 1e6:.1f}M</text>'
        out.append(f'<g class="mo" tabindex="0" role="img" aria-label="{E(lab)}" data-drill="{names[i]} revenue"><rect class="hit" x="{x0:.1f}" y="{top - 22}" width="{slot:.1f}" height="{base - top + 22}"/>'
                   f'<rect class="bud" x="{cx:.1f}" y="{y(b):.1f}" width="{bw:.1f}" height="{y(0) - y(b):.1f}"/>{body}{val}<title>{E(lab)}</title>'
                   f'<text class="{"cur" if i == 8 else "m"}" x="{cx + bw / 2:.1f}" y="{base + 20:.1f}" text-anchor="middle">{names[i]}</text></g>')
    out.append(f'<line class="ax" x1="0" x2="{w}" y1="{y(0):.1f}" y2="{y(0):.1f}"/></svg>')
    return "".join(out)


BAND_HW = round(sum(e * b for e, b in zip(MO_EST, BAND)))
REF = TOT_YTD + TOT_COM + TOT_EST
assert REF == 106548940
HI_CASE = REF + BAND_HW
LO_CASE = REF - BAND_HW

SHORT = {"artistry": ("Artistry", "Homes"), "dorrian": ("Dorrian", "HVAC"), "heartland": ("Heartland", ""), "crystal": ("Crystal", "K & B"),
         "metro": ("Metro", ""), "mmg": ("Merit", "own books"), "revived": ("Revived", ""), "aim": ("AIM", "K & B"), "icc": ("Iowa", "Custom")}


def bridge_sec():
    labels = [("Budget", "EBITDA")] + [SHORT[k] for _, _, k in CL_BRIDGE] + [("Actual", "EBITDA")]
    big3 = sum(v for _, v, k in CL_BRIDGE if k in ("artistry", "dorrian", "heartland"))
    rest = sum(v for _, v, k in CL_BRIDGE if k not in ("artistry", "dorrian", "heartland"))
    assert big3 + rest == G_EB_ACT - G_EB_BUD
    svg = bridge(("Budget EBITDA", G_EB_BUD), [(n, v) for n, v, _ in CL_BRIDGE], ("Actual EBITDA", G_EB_ACT), labels, w=768, h=300,
                 notes={1: 3, 2: 2, 3: 1}, title="Group EBITDA bridge, September budget to actual, by client")
    d = BY["dorrian"]
    d_gp = d["gp"] - d["gp_bud"]
    d_oh = (d["ebitda"] - d["ebitda_bud"]) - d_gp
    ART = [("Margin on 3 homes closed · 11.2% vs 16.0% estimate", -61300), ("Warranty accrual true-up", -12400), ("Selling costs on closings", -8321)]
    assert sum(v for _, v in ART) == BY["artistry"]["ebitda"] - BY["artistry"]["ebitda_bud"]
    notes = f"""<aside class="notes" aria-label="Notes to the bridge"><div class="notes-head"><span class="eyebrow">Notes · what moved</span><span class="t-cap">Computed; AI wrote the words</span></div>
<article class="note" data-note="1"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Where the miss sits</div><div class="note-title">Three clients carry {f0(big3)} of the {f0(G_EB_ACT - G_EB_BUD)} miss</div></div></div>
<ul class="ev">{"".join(f'<li>{E(n)}<span class="dl"></span><span class="v">{f0(v)}</span></li>' for n, v, k in CL_BRIDGE if k in ("artistry", "dorrian", "heartland"))}
<li>Six others, net<span class="dl"></span><span class="v">{nn(rest)}</span></li><li class="ev-total">Group EBITDA vs budget<span class="dl"></span><span class="v">{f0(G_EB_ACT - G_EB_BUD)}</span></li></ul></article>
<article class="note" data-note="2"><div class="note-top"><span class="note-no">2</span><div><div class="note-kind">Preliminary</div><div class="note-title">Dorrian’s September is still open</div></div></div>
<p>The bank feed has been down 3 days, so these numbers can still move. Gross margin is 17.0% against a 21.0% budget.</p>
<ul class="ev"><li>Gross profit vs budget<span class="dl"></span><span class="v">{f0(d_gp)}</span></li><li>Overhead vs budget<span class="dl"></span><span class="v">{f0(d_oh)}</span></li>
<li class="ev-total">Dorrian EBITDA vs budget<span class="dl"></span><span class="v">{f0(d["ebitda"] - d["ebitda_bud"])}</span></li></ul>
<div class="note-acts">{btn("Open Dorrian’s close", "quiet", "", "right")}</div></article>
<article class="note" data-note="3"><div class="note-top"><span class="note-no">3</span><div><div class="note-kind">Explain this variance</div><div class="note-title">Artistry closed 3 homes below their estimated margin</div></div></div>
<ul class="ev">{"".join(f'<li>{E(n)}<span class="dl"></span><span class="v">{f0(v)}</span></li>' for n, v in ART)}<li class="ev-total">Artistry EBITDA vs budget<span class="dl"></span><span class="v">{f0(sum(v for _, v in ART))}</span></li></ul>
<div class="basis"><span>Basis: <b>WIP close-out + job cost</b></span></div><div class="note-acts">{btn("Open profit fade", "quiet", "", "right")}</div></article></aside>"""
    left = (f'<div class="sec-h" style="margin-top:0"><span class="t-head">September EBITDA, budget to actual, by client</span>'
            f'<div class="lgd"><span><i class="anc"></i>EBITDA</span><span><i class="fav"></i>Favourable</span><span><i class="unf"></i>Unfavourable</span></div></div>{svg}'
            f'<p class="t-cap" style="margin-top:4px">Worst first. Steps sum to {f0(G_EB_ACT - G_EB_BUD)}. Management fees eliminate inside EBITDA, so Merit’s own books show only their own result.</p>')
    return left, notes


def fan_sec():
    lg = ('<div class="lgd" style="max-width:520px;justify-content:flex-end"><span><i class="anc"></i>Actual · posted</span><span><i class="c"></i>Committed · signed jobs, agreements, POs</span>'
          '<span><i class="e"></i>Estimated · driver model</span><span><i class="w"></i>p10–p90</span><span><i class="b"></i>Budget</span></div>')
    cells = [("Actual, Jan–Sep", f0(TOT_YTD), ""), ("Committed, Oct–Dec", f0(TOT_COM), ""), ("Estimated, Oct–Dec", f0(TOT_EST), ""),
             ("Reforecast v3", f0(REF), "b"), ("Budget", f0(TOT_BUD), ""), ("vs budget", f0(REF - TOT_BUD), "neg"),
             ("High case, p90", f0(HI_CASE), ""), ("Low case, p10", f0(LO_CASE), "")]
    side = ('<div class="strip">' + "".join(f'<div><span class="fig-l">{a}</span><span class="tnum {c}">{b}</span></div>' for a, b, c in cells)
            + f'</div><div class="inline-notice inline-notice--info" style="margin-top:12px">{ico("info")}<span><b>Even the high case is {f0(TOT_BUD - HI_CASE)} short of budget.</b> '
            f'{TOT_COM / (TOT_COM + TOT_EST) * 100:.0f}% of the rest of the year is already signed; the band comes from the last 8 quarters’ forecast error.</span></div>')
    left = f'<div class="sec-h"><span class="t-head">Revenue by month · where the year lands</span>{lg}</div>{fan()}<p class="t-cap" style="margin-top:4px">Net of intercompany fees. Bars share one scale from zero. Bands are added month by month, so the range is conservative.</p>'
    return left + side, ""


def scen_sec():
    hdr = '<div class="h"><span class="eyebrow">Group · FY 2027</span><span class="t-head">Plan v1</span></div>'
    hdr += '<div class="h base"><span class="eyebrow">Base</span><span class="t-head">Budget draft v1</span><p>Rolls up the client budgets in progress</p></div>'
    for t, s, d in SCEN:
        hdr += f'<div class="h"><span class="eyebrow">Scenario</span><span class="t-head">{E(t)}</span><p>{E(s)}</p></div>'

    def line(lbl, key, fmt, dfmt):
        out = f'<div class="m">{lbl}</div><div class="base"><span class="v">{fmt(SC_BASE[key])}</span><span class="d z">base</span></div>'
        for t, s, d in SCEN:
            v = SC_BASE[key] + d[key]
            cls = "pos" if d[key] > 0 else ("neg" if d[key] < 0 else "z")
            out += f'<div><span class="v">{fmt(v)}</span><span class="d {cls}">{dfmt(d[key])}</span></div>'
        return out
    sg = lambda x: ("+" + f0(x)) if x > 0 else (f0(x) if x < 0 else "no change")
    body = hdr + line("Revenue", "rev", f0, sg) + line("EBITDA", "eb", f0, sg) + line("Lowest cash, any week", "cash", f0, sg)
    body += line("Tightest covenant · Heartland DSCR, minimum 1.25×", "dscr", lambda x: f"{x:.2f}×", lambda x: ("−" if x < 0 else "+") + f"{abs(x):.2f}×")
    acts = '<div class="m"></div><div class="base"></div>' + "".join(f'<div>{btn("Pinned" if i == 1 else "Pin", "quiet", "", "pin")}</div>' for i in range(3))
    for t, s, d in SCEN:
        assert SC_BASE["dscr"] + d["dscr"] > 1.25
    return (f'<div class="sec-h"><span class="t-head">Scenarios against the FY 2027 plan</span><div class="search" style="width:440px">{ico("search")}'
            f'<input aria-label="Ask a what-if" placeholder="Ask a what-if: “what if Iowa Custom loses its largest dealer?”"></div></div>'
            f'<div class="sc" role="table" aria-label="Scenarios compared with the plan">{body}{acts}</div>'
            f'<p class="t-cap" style="margin-top:8px">Read-only here: scenarios are built in each client and rolled up. Every scenario reruns cash and every covenant test before anyone applies it.</p>')


def fmt_kpi(v, unit):
    if unit == "%":
        return f"{v:.1f}%" if v >= 0 else f"({abs(v):.1f}%)"
    if unit == "$":
        return f"{v:,.0f}"
    return f"{v:,.0f}k"


def kpi_sec():
    tabs = '<div class="tabs" role="tablist" aria-label="Industry">' + "".join(
        f'<button class="tab" role="tab" aria-selected="{"true" if i == 0 else "false"}" type="button">{t} <span class="n">{n}</span></button>'
        for i, (t, n) in enumerate([("HVAC", 3), ("Kitchen &amp; bath", 2), ("Cabinets &amp; millwork", 1), ("Flooring &amp; interiors", 1), ("Construction", 1)])) + "</div>"
    src = ["GL", "GL", "ServiceTitan", "ServiceTitan", "GL 5100 ÷ 4100", "Payroll + GL", "ServiceTitan", "ServiceTitan"]
    rows = ""
    for (lbl, unit, h, m, d, p25, p50, p75, hib), s in zip(HVAC_KPI, src):
        vals = [h, m, d]
        lo = min(vals + [p25, p75]) - abs(p75 - p25) * 0.4
        hi = max(vals + [p25, p75]) + abs(p75 - p25) * 0.4
        r = ruler(p25, p50, p75, [("D", d, False), ("M", m, False), ("H", h, True)], lo, hi, w=240, h=40, higher=hib)
        cells = ""
        for v in vals:
            behind = (v < p25) if hib else (v > p25)
            txt = fmt_kpi(v, unit)
            cells += (f'<td class="n"><span class="lowv"><i aria-hidden="true"></i>{txt}</span><span class="sr"> below the peer 25th percentile</span></td>' if behind
                      else f'<td class="n">{txt}</td>')
        rows += (f'<tr class="ln" tabindex="0" data-drill="{E(lbl)}"><td><span class="l1">{E(lbl)}</span><span class="l2">{"higher is better" if hib else "lower is better"} · {E(s)}</span></td>'
                 f'{cells}<td class="n">{fmt_kpi(p50, unit)}</td><td class="l">{r}</td></tr>')
    table = (f'<table class="lay kpi" aria-label="HVAC KPIs by client, September 2026, against peer quartiles"><colgroup><col><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:264px"></colgroup>'
             f'<thead><tr><th>KPI · Sep 2026</th><th>Heartland</th><th>Metro</th><th>Dorrian</th><th>Peer median</th><th class="l" style="padding-left:16px">Against peers · H M D</th></tr></thead><tbody>{rows}</tbody></table>')
    leg = (f'<div class="peers">{ruler(20, 25, 30, [("H", 27, True)], 10, 40, w=120, h=24)}<span>Shaded band = peer 25th–75th percentile, tick = median, squares = each client. '
           f'<span class="lowv"><i aria-hidden="true"></i></span> = behind the peer 25th percentile.</span></div>'
           f'<p class="t-cap" style="margin-top:4px">Peers: opt-in MeritBooks HVAC companies, 5–50M revenue. Sample figures until the benchmark source is decided (FPB §10 Q3). The KPI set is the HVAC pack (KP-01 to KP-03); operational inputs come from ServiceTitan.</p>')
    note = f"""<article class="note note--panel" style="margin-top:16px"><div class="note-kind">Recommended KPI · HVAC pack</div>
<div class="note-title">Track maintenance visits completed vs due — the data is already in ServiceTitan for all three</div>
<p>Dorrian’s 64% renewal rate follows a year where 31% of agreement visits were missed. Heartland and Metro renew above the peer median.</p>
<div class="note-acts">{btn("Add to the HVAC pack", "quiet", "", "plus")}{btn("Not now", "quiet")}</div></article>"""
    return f'<div class="sec-h"><span class="t-head">KPIs by industry</span><span class="t-cap">Compared side by side, never summed</span></div>{tabs}<div style="margin-top:16px">{table}</div>{leg}{note}'


def figs():
    def fig(l, v, vs, link):
        return f'<div class="fig"><span class="fig-l">{l}</span><span class="fig-v tnum">{v}</span><span class="fig-vs">{vs}</span><a class="link" href="#" style="min-height:32px;display:inline-flex;align-items:center">{link}</a></div>'
    return ('<div class="figs">'
            + fig("September EBITDA", f0(G_EB_ACT), f'<span>budget <b>{f0(G_EB_BUD)}</b></span><span class="neg">{f0(G_EB_ACT - G_EB_BUD)}</span>', "Bridge")
            + fig("FY 2026 reforecast", f0(REF), f'<span>budget <b>{f0(TOT_BUD)}</b></span><span class="neg">{f0(REF - TOT_BUD)}</span>', "Forecast")
            + fig("Rest of year signed", f"{TOT_COM / (TOT_COM + TOT_EST) * 100:.0f}%", f'<span>committed <b>{f0(TOT_COM)}</b></span>', "Committed detail")
            + fig("Tightest covenant, FY 2027", f'{SC_BASE["dscr"]:.2f}×', '<span>Heartland DSCR · minimum <b>1.25×</b></span>', "Scenarios")
            + "</div>")


def frame_main():
    seg = "".join(f'<button type="button" aria-pressed="{"true" if s == "Month" else "false"}">{s}</button>' for s in ["Month", "Quarter", "Year to date"])
    head_ = (f'<div class="page-head"><div><div class="eyebrow">Merit Management Group — Consolidated<span class="sl">//</span>Budget vs actual &amp; FP&amp;A</div>'
             f'<h1 class="t-title" style="margin-top:4px">September, and where the year lands</h1></div>'
             f'<div class="btn-row"><div class="seg" role="group" aria-label="Period">{seg}</div>{btn("Export", "", "", "download")}{btn("Add to board pack", "primary", "", "plus")}</div></div>')
    bl, bn = bridge_sec()
    fl, fs = fan_sec()
    grid = f'<div class="two" style="margin-top:32px"><div>{bl}{fl}</div><div>{bn}</div></div>'
    page = f'<div class="page f2">{head_}{figs()}{grid}<div style="margin-top:8px">{scen_sec()}</div>{kpi_sec()}</div>'
    main = ctxline(["Mon Oct 19", "FY 2026", "September preliminary · 2 members open", "<b>September EBITDA " + f0(G_EB_ACT - G_EB_BUD) + " vs budget</b>"])
    return app("consolidated", "density-report", cons_rail(), bar(ctx_group(), "<b>Budget vs actual &amp; FP&amp;A</b>", cmd="Ask or jump to a client, report, KPI…"), main + page, 2650, live=True)


def build():
    html = head("F2 · FP&A analysis", CSS) + sheet_top("F2-fpna-analysis.html") + '<main id="main" class="sheet">'
    html += board_h("F2", "FPB-reports-fpna §2 bridge, fan, ruler · §3 A5 explain, A6 layers, A7 scenarios, A9 KPI recommendations · IA §3.6.5",
                    "The group’s month and year on one page, with the reasons attached",
                    "Nora reads the consolidated group: which clients moved EBITDA and why, how much of the rest of the year is already signed, "
                    "what three what-ifs do to cash and the tightest covenant, and how each client’s trade KPIs compare with its peers.")
    html += pair_h("1 · FP&amp;A analysis", "Consolidated context, read-only. Totals are allowed because Nora holds the group; KPIs stay side by side.")
    html += frame(frame_main(), "Populated state · September preliminary (Dorrian and Crystal still open)",
                  f"Ties: budget {f0(G_EB_BUD)} + client steps {f0(G_EB_ACT - G_EB_BUD)} = {f0(G_EB_ACT)} (S6 group); reforecast {f0(REF)} = S23")
    html += anno([("Bridge by client, worst first", "The same bridge as the management report, one level up. Each step opens that client’s own bridge."),
                  ("Preliminary says so", "Dorrian’s month isn’t closed. The note says so before anyone acts on it."),
                  ("Certainty you can see", "Committed is hatched, estimated is an outline with its p10–p90 whisker. The strip under the chart turns that into a high and low case."),
                  ("Peers as a ruler", "Each KPI shows the peer band and median with a square per client. Squares are lettered, and the value cell marks anyone behind the 25th percentile.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../F2-fpna-analysis.html", "w").write(build())
    print("ok F2", REF, HI_CASE, LO_CASE, TOT_BUD - HI_CASE)
