"""O11 + client migration workspace (/clients/[id]/migration). Heartland Heating & Cooling, Sam Kovac preparing."""
from onb import *
from onb_data import *

CSS = """
.page{padding-top:24px}
.mig{display:grid;grid-template-columns:248px minmax(0,1fr) 336px;gap:24px;align-items:start}
/* stage rail — the eight stages, current one open with its sub-steps */
.srail{background:var(--white);border:1px solid var(--line)}
.srail-h{padding:12px 16px;border-bottom:1px solid var(--line)}
.srail ol{list-style:none}
.srail li{border-bottom:1px solid var(--line)}
.srail li:last-child{border-bottom:0}
.srail a{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:48px;padding:6px 12px 6px 16px;transition:background-color var(--fast)}
.srail a:hover{background:var(--grey-100)}
.srail .sk{display:block;width:6px;height:18px;margin-left:4px;background:var(--grey-200);transform:skewX(-45deg)}
.srail .is-done .sk{background:var(--electric)}
.srail .is-cur>a{background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.srail .is-cur .sk{background:transparent;box-shadow:inset 0 0 0 1.5px var(--electric)}
.srail .is-done .r{color:var(--pos)}
.srail .r{font-size:12px;color:var(--ink-3);white-space:nowrap}
.srail a .l1{white-space:normal}
.srail .what{display:block;font-size:12px;line-height:16px;color:var(--ink-3);font-weight:400;white-space:normal}
.srail .subs{list-style:none;padding:0 12px 8px 46px;background:var(--sky)}
.srail .subs li{display:flex;justify-content:space-between;gap:8px;border:0;min-height:28px;align-items:center;font-size:12px;color:var(--ink-2)}
.srail .subs li b{font-weight:600;color:var(--ink)}
.srail .subs .neg{font-weight:600}
.srail-f{padding:12px 16px;border-top:1px solid var(--line);background:var(--canvas);font-size:12px;line-height:16px;color:var(--ink-2)}
.need li{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line)}
.need li:last-child{border-bottom:0}
.need li.is-attn{box-shadow:inset 3px 0 var(--neg)}
.need .t-head{font-size:13px;line-height:20px}
.need p{color:var(--ink-2);margin-top:2px}
.need .lock{display:flex;align-items:center;gap:6px;color:var(--ink-3);font-size:12px;margin-top:4px}
.srcs-t td{height:auto;padding-top:12px;padding-bottom:12px;white-space:normal;vertical-align:top}
.srcs-t td .l1,.srcs-t td .l2{white-space:normal}
.srcs-t .sysn{font-weight:600}
.srcs-t tr.q-row.is-selected td{background:var(--sky)}
.did{display:grid;grid-template-columns:1fr 1fr;gap:0}
.did>div{padding:12px 16px 16px}
.did>div+div{border-left:1px solid var(--line)}
.did .eyebrow{margin-bottom:8px;display:block}
.did .ev li{font-size:13px}
.plan .kv{grid-template-columns:120px minmax(0,1fr) auto;align-items:baseline;gap:10px 16px}
.plan .kv dd{text-align:left;font-weight:400;color:var(--ink-2)}
.plan .kv dd b{color:var(--ink);font-weight:600}
.plan .kv .btn{height:32px}
.drawer{background:var(--white);border:1px solid var(--line-2)}
.drawer .panel-sec{padding:16px}
.drawer .panel-sec+.panel-sec{border-top:1px solid var(--line)}
.cmt{list-style:none}
.cmt li{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;padding:8px 0}
.cmt p{color:var(--ink-2)}
.ask{display:grid;gap:8px;margin-top:8px}
.ask .btn{justify-content:flex-start}
.drawer .note-acts{flex-wrap:wrap}
.fig-link{color:inherit;border-bottom:1px dashed var(--electric)}
.fig-link.is-lit{background:var(--sky);box-shadow:inset 0 -1px var(--electric)}
"""


def stage_rail():
    rs = [("done", "Oct 12", None), ("done", "Oct 13", None), ("done", "Oct 15", None), ("done", "Oct 16", None),
          ("cur", "2 open", [("Opening &amp; schedules", "11 tied", ""), ("Monthly grid", "2 open · 1 stale", "neg"),
                             ("Subledger ties", "9 tied", ""), ("Bank, loan, tax ties", "4 of 5", "warn"), ("Preparer signs", "locked", "")]),
          ("", "October", None), ("", "Priya", None), ("", "target Oct 22", None)]
    items = [(STAGES[i], st, r, subs) for i, (st, r, subs) in enumerate(rs)]
    li = ""
    for name, st, r, subs in items:
        cls = {"done": "is-done", "cur": "is-cur", "": ""}[st]
        mark = '<span class="sk" aria-hidden="true"></span>'
        rr = (ico("check", 16) + '<span class="sr">done</span> ' + r) if st == "done" else r
        aria = ' aria-current="step"' if st == "cur" else ""
        sub = ""
        if subs:
            sub = '<ul class="subs">' + "".join(f'<li><span>{a}</span><b class="{c}">{b}</b></li>' for a, b, c in subs) + "</ul>"
        i = STAGES.index(name)
        what = f'<span class="what">{STAGE_INFO[i]["short"]}</span>' if st == "cur" else ""
        li += f'<li class="{cls}"><a href="#"{aria} title="{E(stage_desc(i))}">{mark}<span class="l1">{name}{what}</span><span class="r">{rr}</span></a>{sub}</li>'
    return (f'<nav class="srail" aria-label="Migration stages"><div class="srail-h"><span class="eyebrow">Stage 5 of 8 · {STAGES[4]}</span>'
            f'<div style="margin-top:6px">{stage_meter(4)}</div></div><ol>{li}</ol>'
            f'<div class="srail-f"><b>Done when</b> {STAGE_INFO[4]["done"][0].lower() + STAGE_INFO[4]["done"][1:]} Stages can be worked out of order where the data allows. Skipped shows as skipped, never as done.</div></nav>')


def needs_you():
    items = [
        ("is-attn", "Fix 2 differences in the balance grid · $3,140.00", "One August invoice is Install in QuickBooks and Service in simPRO, so it shows in both rows. A June 2025 fuel entry changed in QuickBooks after the pull.",
         '<button class="btn btn--primary" type="button">Open the grid</button>', ""),
        ("", "Attach the Bank of Iowa loan statement at Sep 30", "The loan ties to QuickBooks but not yet to the lender. Without the statement it prints as Internal only on the certificate.",
         '<button class="btn" type="button">' + ico("ask") + 'Ask Heartland</button>', ""),
        ("", "Sign the balance proof", "You sign; Priya Natarajan reviews and signs off the certificate after October’s practice close.",
         '<button class="btn" type="button" aria-disabled="true">' + ico("sign") + 'Sign balance proof</button>', f'<span class="lock">{ico("lock", 12)}Locked until the grid is all zero</span>'),
    ]
    li = "".join(f'<li class="{c}"><div><p class="t-head" style="margin:0">{t}</p><p>{p}</p>{lk}</div>{b}</li>' for c, t, p, b, lk in items)
    return (f'<section class="wg wg--primary" style="grid-column:auto;grid-row:auto" aria-labelledby="h-need"><div class="wg-head"><h2 class="wg-title" id="h-need">Needs you</h2>'
            f'<span class="wg-count">3</span><span class="wg-meta">everything else is done or running</span></div><ol class="need" style="padding:0">{li}</ol></section>')


def sources():
    rows = [
        ("QuickBooks Online", "Ledger · one-time", tier("live"), "Pulled Oct 17, 6:02 AM",
         "21 monthly trial balances, 251 accounts, 18,412 transactions kept for drill-down, 388 vendors", "Disconnects and archives at sign-off", "ok", False),
        ("simPRO", "Field system", tier("live"), "Webhooks on · 4 min ago",
         '1,284 jobs (312 open), <a href="#" class="fig-link is-lit" data-note="ar">86 open invoices · 214,880.40</a>, 1,206 customers (1,171 linked to QuickBooks)', "Stays connected. Jobs, invoices and payments after Sep 30 flow in", "ok", True),
        ("Plaid · Farmers State", "Bank · ••4471, ••4489", tier("live"), "Balance 6:00 AM",
         "Balances at Sep 30, 17 outstanding items from the September recs", "Stays connected as the bank feed", "ok", False),
        ("Ramp", "Card spend · tenant", tier("live"), "Synced 7:40 AM",
         "Heartland’s 14 cards, departments pushed from MeritBooks", "Stays connected. Never export from Ramp by hand", "ok", False),
        ("Documents", "Dropped Oct 13", tier("file", "Drop"), "14 files, 14 classified",
         "Loan agreement, 2 bank recs, WIP schedule, 2026 budget, operating agreement, insurance", "Kept with the client; linked to each schedule", "ok", False),
    ]
    tr = ""
    for n, role, t, last, brought, after, h, sel in rows:
        tr += (f'<tr class="q-row{" is-selected" if sel else ""}"><td><span class="l1 sysn">{n}</span><span class="l2">{role}</span><div style="margin-top:6px">{t}</div></td>'
               f'<td><span class="l1" style="font-weight:400">{brought}</span><span class="l2">{last}</span></td><td><span class="l1" style="font-weight:400">{after}</span></td></tr>')
    t = (f'<table class="tbl tbl-q tbl-q--flush srcs-t" aria-label="Sources connected for Heartland"><colgroup><col style="width:184px"><col><col style="width:176px"></colgroup>'
         f'<thead><tr><th>Source</th><th>What it brought</th><th>After go-live</th></tr></thead><tbody>{tr}</tbody></table>')
    return (f'<section class="card" aria-labelledby="h-src" style="margin-top:24px"><div class="card-h"><h3 id="h-src">Sources</h3><span class="t-cap">5 connected · ledger, field system, bank, card spend, documents</span>'
            f'<span style="flex:1"></span><button class="btn btn--quiet" type="button">{ico("plus")}Add a source</button></div>{t}</section>')


def did():
    sys_ = [("Accounts mapped from Merit standard v3", "231"), ("Mapped by the QuickBooks crosswalk", "14"), ("Mapped by you", "6")]
    total = 251
    left = "".join(f'<li><span>{a}</span><span class="dl"></span><span class="v">{b}</span></li>' for a, b in sys_)
    left += f'<li class="ev-total"><span>Accounts mapped</span><span class="dl"></span><span class="v">{total}</span></li>'
    more = [("History months posted, one entry each", "21"), ("Open invoices linked by invoice #", "86 of 86"),
            ("Departments from simPRO business units", "3"), ("Vendor habits learned from history", "214"), ("Outstanding bank items loaded", "17")]
    left2 = "".join(f'<li><span>{a}</span><span class="dl"></span><span class="v">{b}</span></li>' for a, b in more)
    right = [("Accounts matched by hand", "6", "Oct 16"), ("Data-quality decisions", "9", "Oct 15"), ("Customer merges decided", "23", "Oct 16"),
             ("Schedules confirmed", "11", "Oct 18")]
    r = "".join(f'<li><span>{a}</span><span class="dl"></span><span class="v">{b}</span></li>' for a, b, _ in right)
    return (f'<section class="card" aria-labelledby="h-did" style="margin-top:24px"><div class="card-h"><h3 id="h-did">What the system did, and what you decided</h3></div>'
            f'<div class="did"><div><span class="eyebrow">Done for you</span><ul class="ev" style="margin-top:0">{left}</ul><ul class="ev">{left2}</ul></div>'
            f'<div><span class="eyebrow">Decided by Sam Kovac</span><ul class="ev" style="margin-top:0">{r}</ul>'
            f'<p class="t-cap" style="margin-top:16px">Human-active time so far: 38 minutes across 4 sittings. Every run above can be undone with reversing entries until the certificate is issued.</p>'
            f'<div class="btn-row" style="margin-top:12px;margin-left:-12px"><button class="btn btn--quiet" type="button">{ico("undo")}Runs &amp; undo</button></div></div></div></section>')


def plan():
    kv = [("Cutover", "<b>Sep 30, 2026.</b> MeritBooks takes over Oct 1. September and earlier stay as they were in QuickBooks.", "Period check passed"),
          ("History", "<b>Monthly, Jan 2025 – Sep 2026.</b> 21 months, one summary entry per month, plus transaction detail kept read-only for drill-down.", "Wave default"),
          ("Practice close", "<b>October, in both systems.</b> QuickBooks keeps running one more month and we compare the close. Bank of Iowa gets a lender package.", "Required by tenant rule"),
          ("Chart", "<b>Merit standard chart v3</b> with departments, not Heartland’s own chart.", "Firm default"),
          ("People", "<b>Jordan Smith</b> leads · <b>Sam Kovac</b> prepares · <b>Priya Natarajan</b> reviews and signs off", "Reviewer ≠ preparer")]
    rows = "".join(f'<dt>{a}</dt><dd>{b}<div style="margin-top:2px">{prov(c)}</div></dd><dd><button class="btn btn--quiet" type="button">Change</button></dd>' for a, b, c in kv)
    return (f'<section class="card plan" aria-labelledby="h-plan" style="margin-top:24px"><div class="card-h"><h3 id="h-plan">The plan</h3><span class="t-cap">Confirmed by Jordan Smith, Oct 12 · 2 minutes</span></div>'
            f'<div class="card-b"><dl class="kv">{rows}</dl></div></section>')


def drawer():
    note = f"""<article class="note note--panel" data-note="ar">
<div class="note-kind">Where this came from</div>
<div class="note-title">Opening receivables are 214,880.40 and load once</div>
<p>QuickBooks is the control for open invoices at cutover. simPRO adds the job, lines and deposits to each one. Nothing is counted twice.</p>
<ul class="ev">
<li><span>QuickBooks A/R aging, Sep 30</span><span class="dl"></span><span class="v">214,880.40</span></li>
<li><span>simPRO open invoices to Sep 30</span><span class="dl"></span><span class="v">214,880.40</span></li>
<li class="ev-total"><span>Difference</span><span class="dl"></span><span class="v">0.00</span></li></ul>
<div class="basis"><span>Rule <b>ledger aging is control</b></span><span>Run <b>pull · Oct 17 · 9f3c…a1</b></span><span>Approved <b>Sam Kovac, Oct 16</b></span></div>
<div class="note-acts"><button class="btn btn--quiet" type="button">Open the 86 invoices</button><button class="btn btn--quiet" type="button">{ico("flag")}Report a mismatch</button></div>
</article>"""
    cm = (f'<ul class="cmt"><li>{avatar("Priya Natarajan", True)}<div><span class="l1">Priya Natarajan <span class="t-cap">· Oct 18</span></span><p>Bank of Iowa sends statements to Heartland’s office, not to us. Ask Karen?</p></div></li>'
          f'<li>{avatar("Sam Kovac", True)}<div><span class="l1">Sam Kovac <span class="t-cap">· Oct 18</span></span><p>Asked. She’s out until Wednesday.</p></div></li></ul>')
    ask = (f'<div class="ask"><button class="btn" type="button">{ico("ask")}Hand to a teammate</button>'
           f'<button class="btn" type="button">{ico("send")}Ask the client contact</button>'
           f'<button class="btn" type="button">{ico("shield")}Ask MeritBooks concierge</button></div>')
    return (f'<aside class="drawer" aria-label="Details"><div class="panel-sec">{note}</div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>Comments</h3><span class="t-cap">2</span></div>{cm}'
            f'<textarea class="textarea" aria-label="Add a comment" placeholder="Add a comment. @ to mention"></textarea></div>'
            f'<div class="panel-sec"><div class="panel-sec-h"><h3>Ask someone</h3></div><p class="t-cap">Any step can go to anyone. Client links open only that one step.</p>{ask}</div></aside>')


def states():
    metro = ('<div class="state"><div class="state-h"><span class="eyebrow">Gather info · Metro Heating &amp; Cooling</span></div><div class="card-b">'
             '<p class="t-head" style="margin:0">Which systems does Metro use?</p><p class="ink-2" style="margin-top:4px">Pre-checked from what Merit already knows. Nothing is assumed.</p>'
             '<div style="display:grid;gap:0;margin-top:8px">'
             '<label class="check"><input type="checkbox"><i></i>QuickBooks Online <span class="t-cap">· ledger</span></label>'
             '<label class="check"><input type="checkbox"><i></i>ServiceTitan <span class="t-cap">· field system</span></label>'
             '<label class="check"><input type="checkbox" checked><i></i>Ramp <span class="t-cap">· card spend, tenant-wide</span></label>'
             '<label class="check"><input type="checkbox" checked><i></i>Plaid <span class="t-cap">· bank</span></label></div>'
             '<div class="inline-notice inline-notice--info" style="margin-top:8px"><span><b>Sent Oct 17 to Metro’s owner, so Metro sits in Unscheduled:</b> “Which software runs your jobs? Which keeps your books? Who has the login?” 3 questions, answers by text.</span></div>'
             f'<div class="btn-row" style="margin-top:12px"><button class="btn" type="button">Nudge the owner</button><button class="btn btn--quiet" type="button">I know, set it myself</button></div></div></div>')
    done = state("Done · live and signed off · Merit Fund III", "done", "Live since Oct 9. Certificate CC-0002.",
                 "QuickBooks was disconnected and archived after 20 monthly reports, GL detail and the 1099 report were pulled. Plaid stays on as the bank feed. Luis Ortiz has Merit Fund III on his home.",
                 '<button class="btn" type="button">' + ico("download") + 'Certificate PDF</button><button class="btn btn--quiet" type="button">Open client home</button>')
    err = state("Error · source changed since the pull · Heartland", "err", "QuickBooks changed after Oct 17’s pull",
                "A fuel transaction dated Jun 2025, a month QuickBooks shows as closed, was edited yesterday at 4:12 PM. That cell is stale, and the balance proof can’t be signed until you re-pull or accept the change.",
                '<button class="btn btn--primary" type="button">' + ico("retry") + 'Re-pull Jun 2025</button><button class="btn" type="button">See the edit</button>')
    return f'<div class="states">{metro}{done}{err}</div>'


def build():
    main = (ctxline(["Mon Oct 19", "Cutover Sep 30", "<b>Prove balances · day 2</b>", '<b class="neg">2 differences · $3,140.00</b>', "Target go-live Thu Oct 22"],
                    '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Migration<span class="sl">//</span>Heartland Heating &amp; Cooling<span class="sl">//</span>Wave 2 · Sep 30 cutover</div>'
              '<h1 class="t-title" style="margin-top:8px">Moving Heartland onto MeritBooks</h1></div>'
              f'<div class="btn-row"><button class="btn" type="button">{ico("file")}Drop files</button><button class="btn" type="button">{ico("eye")}Side-by-side reports</button></div></div>'
            + f'<div class="mig">{stage_rail()}<div>{needs_you()}{sources()}{did()}{plan()}</div>{drawer()}</div></div>')
    app_ = app("client", "density-cockpit", rail_mini(CLIENT_MINI, "SK", 1),
               bar(ctx_client("Heartland Heating & Cooling", "C-103"), "Migration", "Jump to account, job, customer…", "simPRO synced 4 min ago"), main, extra_cls="app--mini")
    app_ = app_.replace('class="app ', 'data-live class="app ', 1)
    body = (board_h("O11<span class=\"sl\">//</span>08-ONBOARDING §5.3", "One client’s move, start to proof",
                    "Sam Kovac is preparing Heartland’s migration. The left rail is the eight stages, in plain words, with the current one, Prove balances, opened into its sub-steps. The page leads with the three things that need a person; "
                    "everything the system did is a ledger that sums. The drawer answers “where did this number come from” for the open-invoice figure he clicked.",
                    '<span class="tag">Sample data</span> O11')
            + frame(app_, "O11.1 · Prove balances stage, “where this came from” open on simPRO’s open invoices. Mini rail so the drawer never covers the work.")
            + anno([("What the system did vs what’s needed", "Done-for-you lines sum (231 + 14 + 6 = 251 accounts). The three things that need a person are the primary module, with the lock reason on the one that can’t be done yet."),
                    ("Sources by role", "Ledger, field system, bank, card spend and documents, each with how it connects and what happens to it at go-live. QuickBooks leaves; simPRO, Plaid and Ramp stay as feeds."),
                    ("Plain-English plan", "Cutover, history, practice close and chart are sentences, each with a provenance chip saying where the default came from. Every one has a Change button."),
                    ("Delegate anything", "Ask a teammate, the client contact (a link that opens only that step) or MeritBooks concierge. Comments live on the migration, not in email.")])
            + section_h("O11.2 · Gather info without answers, done, and source changed", "")
            + f'<div class="frame" style="background:var(--canvas)">{states()}</div>')
    return page("O11 · Client migration", CSS, body, "O-client-migration.html")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-client-migration.html")
    open(out, "w").write(build())
    print(out)
