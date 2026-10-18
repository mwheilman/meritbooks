"""S6c — Controller home (compact). Operator Cockpit density, workspace context."""
from common import *
from data import BY
from s6 import NOTE_SCRIPT

CSS = """
/* S6c layout only */
.ctm td{height:39px}
.ctm td.c a{display:flex;align-items:center;height:38px;margin:0 -8px;padding:0 8px;transition:background-color var(--fast)}
.ctm td.c a:hover{background:var(--sky);color:var(--electric)}
.ctm td.c .behind{font-weight:600;color:var(--warn)}
.ctm td.na{color:var(--ink-3)}
.ctm th:not(:first-child){padding-right:8px}
.ctm tbody tr.sep td{border-top:2px solid var(--line-2)}
.wg .tbl-q th{background:var(--white)}
.sev{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:20px;padding:0 6px;font:600 12px/20px var(--f-text)}
.pc{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--line)}
.pc div{display:flex;flex-direction:column;gap:4px;padding:16px;border-right:1px solid var(--line)}
.pc div:last-child{border-right:0}
.pc .v{font:600 20px/28px var(--f-text);font-variant-numeric:tabular-nums}
.ic{padding:12px 16px}
.ic .ev{margin-top:4px}
"""

# module columns: bank, ar, ap, payroll, fa, accr, revrec, interco ; S=Sep 30, A=Aug 31, -=not used
M = {
    "crystal":  ("A", "S", "A", "S", "A", "A", "-", "S", "open", 31, "Oct 16"),
    "dorrian":  ("A", "A", "S", "S", "A", "A", "-", "A", "open", 63, "Oct 20"),
    "clive":    ("A", "A", "A", "S", "A", "A", "-", "-", "open", 47, "Oct 21"),
    "swan":     ("A", "S", "S", "-", "S", "A", "-", "-", "open", 4, "Oct 21"),
    "heritage": ("S", "S", "S", "S", "S", "A", "S", "-", "open", 3, "Oct 23"),
    "wildrose": ("S", "S", "S", "S", "S", "S", "-", "-", "open", 0, "Oct 23"),
    "mmg":      ("S", "S", "S", "S", "S", "S", "-", "S", "soft", 0, "Oct 21"),
    "heartland": ("S", "S", "S", "S", "S", "S", "S", "S", "soft", 0, "Oct 21"),
    "metro":    ("S", "S", "S", "S", "S", "S", "S", "S", "soft", 0, "Oct 21"),
    "aim":      ("S", "S", "S", "S", "S", "S", "-", "S", "soft", 0, "Oct 21"),
    "icc":      ("S", "S", "S", "S", "S", "S", "S", "S", "soft", 0, "Oct 21"),
    "revived":  ("S", "S", "S", "S", "S", "S", "-", "S", "soft", 0, "Oct 21"),
    "artistry": ("S", "S", "S", "S", "S", "S", "S", "S", "soft", 0, "Oct 21"),
}
COLS = ["Bank rec", "AR tie", "AP tie", "Payroll", "Fixed assets", "Accruals", "Rev rec", "Interco"]


def m_matrix(p):
    rows = ""
    for i, (k, v) in enumerate(M.items()):
        c = BY[k]
        cells = ""
        for col, s in zip(COLS, v[:8]):
            if s == "S":
                cells += '<td class="c"><a href="#">Sep 30</a></td>'
            elif s == "A":
                cells += '<td class="c"><a href="#" class="behind">Aug 31</a></td>'
            else:
                cells += '<td class="c na">—</td>'
        per = '<span class="status status--track"><i class="pip pip--open" aria-hidden="true"></i>Open</span>' if v[8] == "open" else '<span class="status status--track"><i class="pip pip--soft" aria-hidden="true"></i>Soft close</span>'
        due_cls = " neg b" if v[10] == "Oct 16" else ""
        sep = ' sep' if k == "mmg" else ""
        att = " is-attn" if k in ("crystal", "dorrian") else ""
        rows += (f'<tr class="q-row{att}{sep}"><td><span class="l1">{E(c["name"])}</span></td>{cells}<td>{per}</td>'
                 f'<td class="n">{v[9] if v[9] else "—"}</td><td class="tnum{due_cls}">{v[10]}</td></tr>')
    ths = "".join(f"<th>{c}</th>" for c in COLS)
    table = f"""<table class="tbl tbl-q tbl-q--compact tbl-q--flush ctm" aria-label="Close-through by client and module">
<colgroup><col><col style="width:80px"><col style="width:72px"><col style="width:72px"><col style="width:80px"><col style="width:112px"><col style="width:88px"><col style="width:80px"><col style="width:80px"><col style="width:112px"><col style="width:64px"><col style="width:72px"></colgroup>
<thead><tr><th>Client · open first</th>{ths}<th>Period</th><th class="n">Open</th><th>Due</th></tr></thead><tbody>{rows}</tbody></table>"""
    act = ('<div class="seg" role="group" aria-label="Period"><button type="button" aria-pressed="true">September</button><button type="button" aria-pressed="false">August</button></div>')
    return wg("ctl.close_through", "Close-through", table, 1, 1, 12, 4, count="6 open · 7 soft-closed",
              meta="Each cell: closed through · — not used", act=act, primary=True, label_id=f"{p}-ct")


def m_exceptions(p):
    def grp(t, n, note):
        return f'<tr class="q-group"><td colspan="2"><span class="q-group-t">{t}</span><span class="tnum b">{n}</span><span class="ink-3" style="margin-left:8px">{note}</span></td></tr>'
    def row(code, what, client, amt, attn=False):
        return (f'<tr class="q-row{" is-attn" if attn else ""}"><td><span class="l1">{what}</span><span class="l2"><span class="code">{code}</span>{client}</span></td>'
                f'<td class="n">{pv(amt)}</td></tr>')
    rows = grp("High", 3, "")
    rows += row("EC-3", "Intercompany out of balance", "Dorrian HVAC ↔ own books · fee", "4,250.00", True)
    rows += row("EC-1", "Possible duplicate payment", "Crystal K&amp;B · Ferguson, paid twice", "7,412.90", True)
    rows += row("EC-10", "Unusual journal entry", "Artistry · JE-2609-118 at 11:48 PM", "38,000.00", True)
    rows += grp("Medium", 5, "showing 3")
    rows += row("EC-4", "Uncategorized over 30 days", "Clive Power Equipment · 14 items", "9,284.10")
    rows += row("EC-12", "Cutoff: October invoice in September", "Heritage Interiors · INV-4471", "6,200.00")
    rows += row("EC-2", "Possible missed accrual", "Swan Creek · property tax, Oct 2 wire", "12,400.00")
    rows += grp("Low", 9, "suspense under 500.00")
    body = f'<table class="tbl tbl-q tbl-q--flush" aria-label="Exceptions by severity"><colgroup><col><col style="width:96px"></colgroup><tbody>{rows}</tbody></table>'
    foot = f'<span>Last run 6:00 AM · reruns at period end</span><a class="btn btn--quiet" href="#">All 17{ico("right")}</a>'
    return wg("ctl.exceptions", "Exceptions", body, 1, 5, 4, 4, count="17", meta="3 high", foot=foot, label_id=f"{p}-ex")


def m_recs(p):
    rows = [("Heartland · West Bank ••2207", "1,212,804.11", "Sam Kovac"), ("Metro · Hills Bank payroll ••8812", "148,220.06", "Sam Kovac"),
            ("AIM K&amp;B · Lincoln Savings ••0931", "512,377.40", "Luis Ortiz"), ("Wild Rose · West Bank ••5530", "161,904.85", "Dana Lee")]
    tr = "".join(f'<tr class="q-row" data-dec><td>{a}</td><td class="n">{pv(b)}</td><td class="n">{pv("0.00")}</td><td>{c}</td>'
                 f'<td style="text-align:right"><button class="btn" type="button">Sign off</button></td></tr>' for a, b, c in rows)
    body = f"""<table class="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Reconciliations to sign off"><colgroup><col><col style="width:120px"><col style="width:96px"><col style="width:120px"><col style="width:104px"></colgroup>
<thead><tr><th>Account · Sep 30</th><th class="n">Statement</th><th class="n">Difference</th><th>Preparer</th><th></th></tr></thead><tbody>{tr}</tbody></table>"""
    foot = '<span>Preparer and reviewer differ on all 4</span><button class="btn btn--primary" type="button">Sign off 4<span class="kbd">S</span></button>'
    return wg("ctl.rec_signoff", "Recs to sign off", body, 5, 5, 8, 2, count="4", foot=foot, label_id=f"{p}-rec")


def m_jes(p):
    rows = [("JE-2609-140", "Dorrian HVAC · accrue management fee shortfall", "4,250.00", "Dana Lee", "Post", ""),
            ("JE-2609-131", "Heartland · September warranty reserve", "18,400.00", "Sam Kovac", "Post", ""),
            ("JE-2609-127", "Iowa Custom Cabinets · reclass supplies to jobs", "6,912.44", "Luis Ortiz", "Post", ""),
            ("JE-2609-118", "Artistry · manual revenue adjustment", "38,000.00", "Priya Natarajan", "Review", '<span class="tag tag--warn">EC-10</span>')]
    tr = "".join(f'<tr class="q-row{" is-attn" if t else ""}"><td><span class="code">{a}</span>{b} {t}</td><td class="n">{pv(c)}</td><td>{d}</td>'
                 f'<td style="text-align:right"><button class="btn{" btn--danger" if t else ""}" type="button">{e}</button></td></tr>' for a, b, c, d, e, t in rows)
    body = f"""<table class="tbl tbl-q tbl-q--compact tbl-q--flush" aria-label="Journal entries to post"><colgroup><col><col style="width:104px"><col style="width:128px"><col style="width:96px"></colgroup>
<thead><tr><th>Entry · created, not posted</th><th class="n">Amount</th><th>Created by</th><th></th></tr></thead><tbody>{tr}</tbody></table>"""
    foot = '<span>Bookkeepers create; you post · 1 flagged as unusual</span><button class="btn btn--primary" type="button">Post 3<span class="kbd">P</span></button>'
    return wg("ctl.manual_jes", "Entries to post", body, 5, 7, 8, 2, count="4", foot=foot, label_id=f"{p}-je")


def m_interco(p):
    body = f"""<div class="ic"><div class="row row--between"><span class="b">Dorrian HVAC ↔ Merit Management Group LLC</span>{status("blocked", "Off 4,250.00")}</div>
<ul class="ev"><li>Merit Management Group LLC billed<span class="dl"></span><span class="v">{pv("39,000.00")}</span></li><li>Dorrian HVAC recorded<span class="dl"></span><span class="v">{pv("34,750.00")}</span></li>
<li class="ev-total">Difference<span class="dl"></span><span class="v">{pv("4,250.00")}</span></li></ul>
<p class="t-cap" style="margin-top:8px">JE-2609-140, drafted by Dana Lee, clears it when posted. The other 7 fee pairs agree.</p></div>"""
    foot = f'<span>Group: Merit Management Group — Consolidated</span><button class="btn btn--primary" type="button">Resolve pair</button>'
    return wg("ctl.intercompany", "Intercompany", body, 1, 9, 6, 2, count="7 of 8 agree", foot=foot, label_id=f"{p}-ic")


def m_periods(p):
    body = """<div class="pc"><div><span class="eyebrow">Open</span><span class="v">6</span><span class="t-cap">Still in books review</span></div>
<div><span class="eyebrow">Soft close</span><span class="v">7</span><span class="t-cap">Reviewed · posting locked to preparers</span></div>
<div><span class="eyebrow">Hard close</span><span class="v">0</span><span class="t-cap">August: all 13</span></div></div>
<p class="t-cap" style="padding:12px 16px">Hard close is gated: every module through Sep 30 and a reviewer sign-off. All 7 soft-closed clients pass.</p>"""
    foot = '<span>September</span><button class="btn btn--primary" type="button">Hard close 7…</button>'
    return wg("ctl.periods", "Period control", body, 7, 9, 6, 2, foot=foot, label_id=f"{p}-pc")


def ctl_app(p):
    groups = [("Home", [("Home", True), ("Inbox", False, 3)]),
              ("Work", [("Close grid",), ("Review queue", False, 2), ("Exceptions", False, 17), ("Recs to sign off", False, 4)]),
              ("Consolidated", [("Merit Management Group",), ("Eliminations", False, 1)]),
              ("Accounting", [("Journal entries", False, 4), ("Fiscal periods",), ("Audit trail",)]),
              ("Insights", [("Books health",)])]
    r = rail(groups, "Erin Vance", "Controller")
    ctxl = ctxline(["Mon Oct 19", "September close", "Day 12 of 15", "7 soft-closed, 0 hard-closed", "<b>3 high exceptions</b>"],
                   right=customize_btn() + '<span class="sample">Sample data</span>')
    mods = m_matrix(p) + m_exceptions(p) + m_recs(p) + m_jes(p) + m_interco(p) + m_periods(p)
    main = ctxl + f'<div class="page"><div class="dash">{mods}</div></div>'
    return app("workspace", "density-cockpit", r, bar(ctx_workspace(), "Home", cmd="Jump to client, account, JE…"), main)


def build():
    html = head("S6c · Controller home", CSS) + sheet_top("S6c-controller-home.html") + '<main id="main" class="sheet">'
    html += board_h('S6c<span class="sl">//</span>IA-SPEC §4.7 · controller', "Erin’s home: is every module closed, for every client?",
                    "The close-through matrix is the first thing on the page: 13 clients by 8 modules, each cell the date that module is closed through. "
                    "Below it, the work only a controller does: exceptions, sign-offs, posting, intercompany, and the hard close.",
                    "S6c")
    html += f'<div class="frame">{ctl_app("k")}</div>'
    html += '<div class="frame-cap"><span>Open state · Operator Cockpit density · the matrix is 12 wide, a deliberate exception to “primary is 8 of 12” (see notes).</span><span>Ties to S6: 7 closed · Dorrian 4,250.00 fee gap</span></div>'
    html += anno([
        ("Dates, not ticks", "A cell says Sep 30 or Aug 31, so a behind module reads without colour. Every cell opens that module for that client."),
        ("One gap, three places", "Dorrian’s 4,250.00 fee gap is EC-3 in Exceptions, the open pair in Intercompany and JE-2609-140 in Entries to post. Posting it clears all three."),
        ("Bookkeepers create, you post", "Entries to post lists drafts bookkeepers can’t post. The unusual one asks for Review, not Post."),
        ("Hard close is earned", "The button names its count and its gate. It hard-closes only clients whose every cell is Sep 30 with a reviewer’s sign-off."),
    ])
    html += "</main>" + TOAST + SCRIPT + "</body></html>"
    return html


if __name__ == "__main__":
    open("../S6c-controller-home.html", "w").write(build())
    print("ok")
