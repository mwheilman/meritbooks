"""Shared shell + chart marks for the Reports & FP&A boards (R1, R2, F1, F2).
Builds on fo_common (shell, rail, client nav) and system.css v2. Page-local CSS is layout plus the marks below,
which stay page-local until the lead promotes them (README §6c):
  .brg  variance bridge — anchors Midnight, favourable Electric, unfavourable brick hatch (the monogram's 45° slash)
  .fan  forecast layers by month — actual solid, committed slash-hatched, estimated outline + p10–p90 whisker, budget box
  .rul  benchmark ruler — p25–p75 band, median tick, one lettered marker per client
  .spk  sparkline — 13 points, last point squared
  .stg  stage track — Draft · Submitted · Controller · CFO on the slash meter, with the stage word beside it"""
from html import escape as E
import fo_common as F
from fo_common import ico, btn, rail, client_nav, bar, ctx_client, app, board_h, pair_h, frame, anno, foot, SPRITE
from common import f0, f2, HP, ctxline, status, meter

PAGES = [("R1-reports-home.html", "R1 Reports"), ("R2-report-view.html", "R2 Report"),
         ("F1-budget-builder.html", "F1 Budgets"), ("F2-fpna-analysis.html", "F2 FP&A")]

F.ICONS.update({
    "star": '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6Z" stroke-linejoin="round"/>',
    "pin": '<path d="M6 2.5h4l-.5 4 2.5 2.5H4L6.5 6.5Z" stroke-linejoin="round"/><path d="M8 9v4.5"/>',
    "table": '<rect x="2" y="3" width="12" height="10"/><path d="M2 6.5h12M2 10h12M6 6.5V13"/>',
    "bridge": '<path d="M2 13.5h12"/><rect x="2.5" y="4" width="2" height="9.5"/><rect x="6" y="4" width="2" height="3"/><rect x="9.5" y="7" width="2" height="2.5"/><rect x="12" y="9.5" width="1.5" height="4"/>',
    "sql": '<path d="M5 4 2 8l3 4M11 4l3 4-3 4M9.5 3l-3 10"/>',
    "ppt": '<rect x="2" y="2.5" width="12" height="9"/><path d="M8 11.5v2.5M5 14h6M5 9V7M8 9V5M11 9V6.5"/>',
})
SPRITE2 = F.sprite()

RF_CSS = """
.pad{padding:0 var(--margin)}
.two{display:grid;grid-template-columns:minmax(0,1fr) 352px;column-gap:24px;align-items:start}
.lay{table-layout:fixed}
.lay th{padding:8px;border-bottom:1px solid var(--electric);font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:right;white-space:nowrap;vertical-align:bottom}
.lay th:first-child,.lay th.l{text-align:left}
.lay td{height:40px;padding:4px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.lay td:first-child,.lay td.l{text-align:left;white-space:normal}
.lay tr>*:first-child{padding-left:0}
.lay tr>*:last-child{padding-right:0}
.lay tr.ln{cursor:pointer}
.lay tr.ln:hover td{background:var(--sky)}
.lay tr.ln:focus-visible{outline:2px solid var(--electric);outline-offset:-2px}
.lay tr.grp td{height:auto;padding-top:20px;padding-bottom:6px;font:500 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);border-bottom:1px solid var(--line-2);text-align:left}
.lay tr.sub td{font-weight:600}
.lay tr.sub td.n{border-top:1px solid var(--midnight)}
.lay tr.tot td{font-weight:700;border-bottom:0;height:44px}
.lay tr.tot td.n{border-top:1px solid var(--midnight);border-bottom:3px double var(--electric)}
.lay tr.pct td{height:28px;color:var(--ink-3);font-size:12px;border-bottom:1px solid var(--line)}
.lay tr.is-sel td{background:var(--sky);box-shadow:inset 0 1px var(--electric),inset 0 -1px var(--electric)}
.lay tr.is-sel td:first-child{box-shadow:inset 3px 0 var(--electric),inset 0 1px var(--electric),inset 0 -1px var(--electric)}
.lay .hp{visibility:hidden}
.dlt.neg{color:var(--neg)} .dlt.pos{color:var(--pos)}
.figs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;padding-bottom:24px;border-bottom:1px solid var(--line)}
.figs .fig-v{font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:32px 0 12px}
.sec-h .t-head{white-space:nowrap}
/* bridge */
.brg{display:block;width:100%;height:auto;overflow:visible}
.brg .ax{stroke:var(--midnight);stroke-width:1}
.brg .grid{stroke:var(--line);stroke-width:1}
.brg .anc{fill:var(--midnight)}
.brg .fav{fill:var(--electric)}
.brg .unf{fill:url(#hatch-neg);stroke:var(--neg);stroke-width:1.5}
.brg .con{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 3}
.brg text{font:500 12px/16px var(--f-text);fill:var(--ink-2);font-variant-numeric:tabular-nums}
.brg text.v{fill:var(--ink);font-weight:600}
.brg text.vn{fill:var(--neg);font-weight:600}
.brg text.nr{fill:var(--electric);font-weight:700}
.brg g.bar{cursor:pointer}
.brg g.bar:hover rect.hit,.brg g.bar:focus rect.hit{fill:var(--sky)}
.brg g.bar:focus{outline:none}
.brg g.bar:focus rect.hit{stroke:var(--electric);stroke-width:2}
.brg rect.hit{fill:transparent}
/* sparkline */
.spk{display:block;overflow:visible}
.spk polyline{fill:none;stroke:var(--electric);stroke-width:1.5}
.spk .bud{stroke:var(--grey-400);stroke-dasharray:3 3}
.spk rect{fill:var(--electric)}
/* legend */
.lgd{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:12px;line-height:16px;color:var(--ink-2)}
.lgd span{display:inline-flex;align-items:center;gap:6px}
.lgd i{display:inline-block;width:16px;height:10px}
.lgd i.anc{background:var(--midnight)} .lgd i.fav{background:var(--electric)}
.lgd i.unf{background:repeating-linear-gradient(135deg,var(--neg) 0 1.5px,var(--white) 1.5px 4px);box-shadow:inset 0 0 0 1.5px var(--neg)}
.lgd i.c{background:repeating-linear-gradient(135deg,var(--electric) 0 3px,var(--blue-200) 3px 6px)}
.lgd i.e{background:var(--white);box-shadow:inset 0 0 0 1.5px var(--blue-300)}
.lgd i.b{background:transparent;box-shadow:inset 0 0 0 1px var(--steel)}
.lgd i.w{width:2px;height:12px;background:var(--ink-2)}
/* stage track */
.stg{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.stg .w{font-weight:500;color:var(--ink-2)}
.stg.is-ret .w{color:var(--neg)}
.stg.is-ok .w{color:var(--pos)}
/* ruler */
.rul{display:block;overflow:visible}
.rul .trk{fill:var(--grey-100)}
.rul .iqr{fill:var(--blue-100)}
.rul .med{stroke:var(--steel);stroke-width:2}
.rul .mk rect{fill:var(--midnight)}
.rul .mk.cur rect{fill:var(--electric)}
.rul .mk text{font:700 10px/1 var(--f-text);fill:var(--white);text-anchor:middle}
.rul .end{font:400 12px/16px var(--f-text);fill:var(--ink-3)}
.kbd-hint{color:var(--ink-3);font-size:12px;display:inline-flex;gap:6px;align-items:center}
.review-ov{outline:1px dashed var(--grey-400);outline-offset:2px}
"""

HATCH = ('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
         '<pattern id="hatch-neg" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
         '<rect width="5" height="5" fill="#FFFFFF"/><rect width="1.6" height="5" fill="#B42318"/></pattern>'
         '<pattern id="hatch-com" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
         '<rect width="6" height="6" fill="#A9CCFF"/><rect width="3" height="6" fill="#2563EB"/></pattern></defs></svg>')


def head(title, css=""):
    h = F.head(title, RF_CSS + css)
    return h.replace(SPRITE, SPRITE2 + HATCH)


def sheet_top(current):
    links = '<a href="index.html">Index</a>' + "".join(
        f'<a href="{h}"{" aria-current=page" if h == current else ""}>{E(t)}</a>' for h, t in PAGES)
    return (f'<header class="sheet-top on-dark"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="eyebrow" style="color:var(--slate)">MeritBooks<span class="sl">//</span>Reports &amp; FP&amp;A</span>'
            f'<nav aria-label="Design system pages">{links}</nav></header>')


def dl(x):
    cls = "neg" if x < 0 else ("pos" if x > 0 else "")
    return f'<span class="dlt {cls}">{f0(x)}{HP if x >= 0 else ""}</span>'


def nn(x):
    return f0(x) + (HP if x >= 0 else "")


def pct(x, d=1):
    return f"{x:.{d}f}%"


# ---------------------------------------------------------------- shells
H_USES = {"Purchase orders", "Payroll", "Inventory", "Debt & covenants", "Revenue recognition", "Jobs", "WIP", "Intercompany"}


def h_rail(current, user="Nora Lindqvist", role="CFO", counts=None):
    return rail(client_nav(H_USES, current, counts or {"Inbox": 2}), user, role)


def h_bar(crumbs, cmd="Ask or jump to a report, account, job…"):
    return bar(ctx_client("Heartland Heating & Cooling", "C-103", "Sep closed"), crumbs, cmd=cmd)


def cons_rail(current="Budget vs actual & FP&A"):
    items = ["Group home", "Statements", "Eliminations", "Intercompany pairs", "Cash across group", "Budget vs actual & FP&A",
             "Covenants", "Board & lender packs", "Group close", "Group setup"]
    cnt = {"Eliminations": 1, "Intercompany pairs": 1, "Group close": "7/9"}
    groups = [("Merit Management Group — Consolidated", [(i, i == current, cnt.get(i)) for i in items]),
              ("Workspace", [("Back to workspace",)])]
    return rail(groups, "Nora Lindqvist", "CFO")


def ctx_group():
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false" style="max-width:none">{ico("layers")}'
            f'<span class="ctx-name">Merit Management Group — Consolidated</span><span class="ctx-tag ctx-tag--ro">Read-only</span>{ico("down")}<span class="kbd">⌘J</span></button>')


# ---------------------------------------------------------------- marks
def stage(cur_stage, done_all=False, finance=False, returned=False):
    """cur_stage: index 0..3 of the stage waiting; done_all: approved."""
    words = ["Drafting", "Submitted", "Controller review", "CFO approval"]
    if finance:
        return '<span class="stg"><span class="t-cap">Finance-owned · no submission</span></span>'
    cells = []
    for i in range(4):
        if done_all or i < cur_stage:
            cells.append('<i class="on"></i>')
        elif i == cur_stage:
            cells.append('<i class="bad"></i>' if returned else '<i class="cur"></i>')
        else:
            cells.append("<i></i>")
    w = "Approved" if done_all else ("Returned" if returned else words[cur_stage])
    cls = " is-ok" if done_all else (" is-ret" if returned else "")
    lab = f"Stage: {w}" + ("" if done_all else f", step {cur_stage + 1} of 4")
    return f'<span class="stg{cls}"><span class="meter meter--lg" role="img" aria-label="{lab}">{"".join(cells)}</span><span class="w">{w}</span></span>'


def spark(vals, w=120, h=28, bud=None):
    lo, hi = min(vals + (bud or [])), max(vals + (bud or []))
    rng = (hi - lo) or 1
    pts = lambda vs: " ".join(f"{i * (w - 4) / (len(vs) - 1) + 2:.1f},{h - 3 - (v - lo) / rng * (h - 6):.1f}" for i, v in enumerate(vs))
    b = f'<polyline class="bud" points="{pts(bud)}"/>' if bud else ""
    x, y = (w - 4) + 2, h - 3 - (vals[-1] - lo) / rng * (h - 6)
    return f'<svg class="spk" width="{w}" height="{h}" viewBox="0 0 {w} {h}" aria-hidden="true">{b}<polyline points="{pts(vals)}"/><rect x="{x - 2.5:.1f}" y="{y - 2.5:.1f}" width="5" height="5"/></svg>'


def bridge(start, steps, end, labels, w=768, h=300, notes=None, lo=0, title="", step_fmt=None):
    """start/end: (label, value). steps: [(label, delta)]. labels: list of 2-line label tuples for every bar.
    notes: {bar_index: note_no}. Returns an accessible SVG; each bar is focusable and drills."""
    n = len(steps) + 2
    top, base_h = 24, h - 64
    vals, run = [], start[1]
    for _, d in steps:
        vals.append((run, run + d))
        run += d
    assert run == end[1], (run, end)
    hi = max(start[1], end[1], *[max(a, b) for a, b in vals]) * 1.08
    y = lambda v: top + (hi - v) / (hi - lo) * (base_h - top)
    slot = (w - 8) / n
    bw = slot * 0.56
    out = [f'<svg class="brg" viewBox="0 0 {w} {h}" role="group" aria-label="{E(title)}">']
    # gridlines (4)
    for i in range(1, 5):
        v = lo + (hi - lo) * i / 4.4
        gy = y(v)
        out.append(f'<line class="grid" x1="0" x2="{w}" y1="{gy:.1f}" y2="{gy:.1f}"/>')
    out.append(f'<line class="ax" x1="0" x2="{w}" y1="{y(lo):.1f}" y2="{y(lo):.1f}"/>')
    fmt = step_fmt or f0
    for i in range(n):
        cx = 4 + slot * i + (slot - bw) / 2
        if i == 0 or i == n - 1:
            lab, v = (start if i == 0 else end)
            y0, y1, cls, txt, tcls, d = y(v), y(lo), "anc", f0(v), "v", None
        else:
            a, b = vals[i - 1]
            d = b - a
            y0, y1 = y(max(a, b)), y(min(a, b))
            cls = "fav" if d > 0 else "unf"
            txt = fmt(d) if d < 0 else "+" + f0(d)
            tcls = "vn" if d < 0 else "v"
            lab = steps[i - 1][0]
        hh = max(y1 - y0, 1.5)
        aria = f"{lab}: {txt}"
        nr = notes.get(i) if notes else None
        out.append(f'<g class="bar" tabindex="0" role="img" aria-label="{E(aria)}" data-drill="{E(lab)}">'
                   f'<rect class="hit" x="{4 + slot * i:.1f}" y="{top - 20}" width="{slot:.1f}" height="{h - top + 20 - 4}"/>'
                   f'<rect class="{cls}" x="{cx:.1f}" y="{y0:.1f}" width="{bw:.1f}" height="{hh:.1f}"/>'
                   f'<title>{E(aria)}</title>')
        ty = y0 - 6
        out.append(f'<text class="{tcls}" x="{cx + bw / 2:.1f}" y="{ty:.1f}" text-anchor="middle">{txt}</text>')
        if nr:
            out.append(f'<text class="nr" x="{cx + bw / 2 + len(txt) * 3.4 + 4:.1f}" y="{ty - 6:.1f}">{nr}</text>')
        l1, l2 = labels[i]
        out.append(f'<text x="{cx + bw / 2:.1f}" y="{y(lo) + 18:.1f}" text-anchor="middle">{E(l1)}</text>')
        if l2:
            out.append(f'<text x="{cx + bw / 2:.1f}" y="{y(lo) + 34:.1f}" text-anchor="middle">{E(l2)}</text>')
        out.append("</g>")
        if i < n - 1:
            nxt = vals[i][1] if i < n - 2 else end[1]
            level = start[1] if i == 0 else vals[i - 1][1]
            out.append(f'<line class="con" x1="{cx + bw:.1f}" x2="{cx + slot:.1f}" y1="{y(level):.1f}" y2="{y(level):.1f}"/>')
    out.append("</svg>")
    return "".join(out)


def ruler(p25, p50, p75, marks, lo, hi, w=260, h=28, higher=True):
    """marks: [(letter, value, current?)] — draws a p25–p75 band, a median tick and lettered markers."""
    x = lambda v: 6 + (v - lo) / (hi - lo) * (w - 12)
    a, b = sorted([x(p25), x(p75)])
    out = [f'<svg class="rul" width="{w}" height="{h}" viewBox="0 0 {w} {h}" aria-hidden="true">',
           f'<rect class="trk" x="6" y="{h / 2 - 3}" width="{w - 12}" height="6"/>',
           f'<rect class="iqr" x="{a:.1f}" y="{h / 2 - 6}" width="{b - a:.1f}" height="12"/>',
           f'<line class="med" x1="{x(p50):.1f}" x2="{x(p50):.1f}" y1="{h / 2 - 9}" y2="{h / 2 + 9}"/>']
    placed = []
    for L, v, cur in sorted(marks, key=lambda m: m[1]):
        dy = 0
        if placed and abs(x(v) - placed[-1][0]) < 15:
            dy = 8 if placed[-1][1] <= 0 else -8
            if placed[-1][1] == 0:
                placed[-1] = (placed[-1][0], -1)
        placed.append((x(v), dy))
        out.append(f'<g class="mk{" cur" if cur else ""}"><rect x="{x(v) - 7:.1f}" y="{h / 2 - 7 + dy}" width="14" height="14"/>'
                   f'<text x="{x(v):.1f}" y="{h / 2 + 3.5 + dy}">{L}</text></g>')
    out.append("</svg>")
    return "".join(out)
