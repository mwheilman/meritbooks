"""O14 — Data-quality preflight. Dorrian HVAC (C-105), QuickBooks + FieldEdge (via the QuickBooks bridge).
24 deterministic checks, findings ranked by dollars, fix-in-source vs handle-for-me, and the send-to-client report."""
from onb import *
from onb_data import money, DORRIAN_BLOCKERS

CSS = """
.page{padding-top:24px}
.pf-grid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));border:1px solid var(--line);background:var(--white)}
.pf{display:flex;flex-direction:column;gap:2px;min-height:72px;padding:8px 10px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.pf:nth-child(8n){border-right:0}
.pf:nth-last-child(-n+8){border-bottom:0}
.pf .id{font:600 12px/16px var(--f-text);color:var(--ink-2);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:6px}
.pf .nm{font-size:12px;line-height:16px;color:var(--ink)}
.pf .rs{font-size:12px;line-height:16px;font-weight:600;margin-top:auto;font-variant-numeric:tabular-nums}
.pf.is-blocker{background:var(--neg-wash)} .pf.is-blocker .rs{color:var(--neg)}
.pf.is-warning .rs{color:var(--warn)}
.pf.is-info .rs{color:var(--electric)}
.pf.is-passed .rs{color:var(--pos)}
.pf.is-na .nm,.pf.is-na .rs{color:var(--ink-3)}
.pf-legend{display:flex;gap:24px;align-items:center;margin:8px 0 0;color:var(--ink-2);font-size:12px}
.pf-legend b{color:var(--ink);font-variant-numeric:tabular-nums}
.pfl{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:24px;align-items:start;margin-top:24px}
.fd{background:var(--white);border:1px solid var(--line)}
.fd-row{display:grid;grid-template-columns:132px minmax(0,1fr) 112px 300px;gap:16px;align-items:center;min-height:64px;padding:8px 16px;border-bottom:1px solid var(--line)}
.fd-row.is-attn{box-shadow:inset 3px 0 var(--neg)}
.fd-row.is-open{background:var(--white);box-shadow:inset 3px 0 var(--neg),inset 0 -1px var(--line)}
.fd-row .t{font-weight:600;color:var(--ink)}
.fd-row p{color:var(--ink-2);font-size:12px;line-height:16px;margin-top:2px}
.fd-row .amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.fd-row .seg{width:100%}
.fd-row .seg button{flex:1;padding:0 8px;white-space:nowrap}
.fd-grp{display:flex;align-items:center;gap:12px;height:40px;padding:0 16px;background:var(--canvas);border-bottom:1px solid var(--line)}
.fd-detail{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:16px 16px 20px 164px;border-bottom:1px solid var(--line);background:var(--white)}
.fd-detail .ev{margin-top:4px}
.fd-detail .opt{padding:12px;border:1px solid var(--line-2)}
.fd-detail .opt.is-sel{border-color:var(--electric);box-shadow:inset 0 0 0 1px var(--electric);background:var(--sky)}
.fd-detail .opt+.opt{margin-top:8px}
.fd-detail .opt p{color:var(--ink-2);margin-top:2px}
.fd-foot{display:flex;align-items:center;gap:16px;height:48px;padding:0 16px;color:var(--ink-2)}
.fd-foot b{color:var(--ink);font-variant-numeric:tabular-nums}
.fd-foot .sp{flex:1}
.rep{background:var(--white);border:1px solid var(--line-2)}
.doc{margin:16px;padding:24px 24px 20px;background:var(--warm);border:1px solid var(--line);box-shadow:0 12px 24px -16px rgba(10,22,40,.35)}
.doc img{height:16px;width:auto}
.doc h4{font:700 20px/28px var(--f-display);color:var(--electric);margin-top:16px}
.doc .rule{margin:12px 0}
.doc ol{list-style:none;counter-reset:d}
.doc li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;line-height:16px}
.doc li::before{counter-increment:d;content:counter(d);font-weight:700;color:var(--electric)}
.doc li b{display:block;font-size:13px;line-height:20px;color:var(--ink);font-weight:600}
.doc li .v{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.doc .fine{margin-top:12px;font-size:12px;line-height:16px;color:var(--ink-3)}
"""

# id, short name, result kind, result text
CHECKS = [
    ("PF-01", "AR aging = AR account", "blocker", "4,212.50"), ("PF-02", "AP aging = AP account", "blocker", "612.00"),
    ("PF-03", "Undeposited funds", "warning", "18,940.00"), ("PF-04", "Uncategorized", "warning", "3,145.20"),
    ("PF-05", "Ask My Accountant", "warning", "1,980.00"), ("PF-06", "Opening Balance Equity", "passed", "0.00"),
    ("PF-07", "Trial balance balances", "passed", "21 of 21"), ("PF-08", "Retained earnings rolls", "passed", "Passed"),
    ("PF-09", "Abnormal signs", "warning", "2,318.75"), ("PF-10", "Bank recs current", "warning", "22,315.40"),
    ("PF-11", "Closed-period edits", "passed", "None"), ("PF-12", "Inactive with balance", "passed", "None"),
    ("PF-13", "Duplicate names", "info", "14 pairs"), ("PF-14", "1099 vendors, no TIN", "warning", "38,600.00"),
    ("PF-15", "Sales tax ties to return", "passed", "Passed"), ("PF-16", "Payroll liabilities aged", "passed", "Passed"),
    ("PF-17", "Depreciation run", "warning", "6,480.00"), ("PF-18", "Deposits in revenue", "warning", "12,400.00"),
    ("PF-19", "Retainage", "na", "Not used"), ("PF-20", "WIP = GL", "na", "No WIP jobs"),
    ("PF-21", "Loans = lender", "passed", "Passed"), ("PF-22", "Intercompany pairs", "passed", "Passed"),
    ("PF-23", "FieldEdge AR = ledger AR", "warning", "2,870.00"), ("PF-24", "Foreign currency", "na", "USD only"),
]
CNT = {k: sum(1 for c in CHECKS if c[2] == k) for k in ("blocker", "warning", "info", "passed", "na")}
assert CNT == {"blocker": 2, "warning": 9, "info": 1, "passed": 9, "na": 3} and len(CHECKS) == 24

PIP = {"blocker": "overdue", "warning": "risk", "info": "open", "passed": "ready", "na": "closed"}
WORD = {"blocker": "Blocker", "warning": "Warning", "info": "Info", "passed": "Passed", "na": "Not applicable"}


def grid():
    t = ""
    for i, n, k, r in CHECKS:
        t += (f'<div class="pf is-{k}"><span class="id"><i class="pip pip--{PIP[k]}" aria-hidden="true"></i>{i}<span class="sr">{WORD[k]}</span></span>'
              f'<span class="nm">{n}</span><span class="rs">{r}</span></div>')
    leg = (f'<div class="pf-legend"><span>{status("blocked", "Blockers")} <b>{CNT["blocker"]}</b> stop the tie-out</span>'
           f'<span>{status("risk", "Warnings")} <b>{CNT["warning"]}</b> need a decision</span><span><i class="pip pip--open" aria-hidden="true"></i> Info <b>{CNT["info"]}</b></span>'
           f'<span>{status("ready", "Passed")} <b>{CNT["passed"]}</b></span><span><i class="pip pip--closed" aria-hidden="true"></i> Not applicable <b>{CNT["na"]}</b></span>'
           f'<span class="sp" style="flex:1"></span><span class="prov">QuickBooks pull Oct 18, 6:04 AM · FieldEdge via the QuickBooks bridge</span></div>')
    return f'<div class="pf-grid" role="list" aria-label="All 24 preflight checks">{t}</div>{leg}'


def seg(opts, sel):
    return ('<div class="seg" role="group" aria-label="What to do">' +
            "".join(f'<button type="button" aria-pressed="{"true" if i == sel else "false"}">{o}</button>' for i, o in enumerate(opts)) + "</div>")


FIND_B = [("PF-01", "Receivables don’t match the A/R account", "3 journal entries hit A/R with no customer", 421250, 0, True),
          ("PF-02", "Payables don’t match the A/P account", "One bill payment recorded twice in June", 61200, 1, False)]
FIND_W = [("PF-14", "4 vendors paid over $600 have no TIN", "38,600.00 paid this year · W-9s needed for 1099s", 3860000, 0),
          ("PF-10", "Bank accounts last reconciled Jun 30", "Operating ••8812 · 23 uncleared items", 2231540, 1),
          ("PF-03", "Undeposited Funds holds 18,940.00", "41 payments never grouped into a deposit", 1894000, 1),
          ("PF-18", "Equipment deposits booked as revenue", "12 customer deposits for install jobs not yet done", 1240000, 1),
          ("PF-17", "Depreciation not run since May", "Catch-up for Jun–Sep on 9 vehicles and tools", 648000, 1),
          ("PF-04", "Uncategorized expense", "17 transactions", 314520, 1),
          ("PF-23", "2 FieldEdge invoices never reached QuickBooks", "Found in FieldEdge’s AR export; the bridge can’t see them", 287000, 2),
          ("PF-09", "Debit balance on a vendor", "Johnstone Supply, overpaid in August", 231875, 2),
          ("PF-05", "Ask My Accountant holds 1,980.00", "6 transactions", 198000, None)]
assert sum(f[3] for f in FIND_B) == sum(v for _, v in DORRIAN_BLOCKERS)


def findings():
    out = f'<div class="fd-grp"><span class="q-group-t">Blockers</span><span class="t-cap">2 · {money(sum(f[3] for f in FIND_B))} · stop the tie-out</span></div>'
    for i, t, p, v, sel, open_ in FIND_B:
        out += (f'<div class="fd-row is-attn{" is-open" if open_ else ""}" tabindex="0"><span>{status("blocked", "Blocker")}<span class="l2" style="margin-top:2px">{i}</span></span>'
                f'<div><span class="t">{t}</span><p>{p}</p></div><span class="amt">{money(v)}</span>{seg(["Fix in QuickBooks", "Handle it for me"], sel)}</div>')
        if open_:
            out += f"""<div class="fd-detail"><div>
<p class="t-head" style="margin:0;font-size:13px;line-height:20px">Dorrian’s receivables aging adds to 186,402.10, but the A/R account says 190,614.60.</p>
<p class="ink-2" style="margin-top:4px">4,212.50 sits in A/R with no invoice behind it, so nobody can collect it. It came from three journal entries.</p>
<ul class="ev"><li><span>JE 114 · Jun 3 · “AR adj”</span><span class="dl"></span><span class="v">2,400.00</span></li>
<li><span>JE 131 · Jul 31 · “reclass deposit”</span><span class="dl"></span><span class="v">1,250.00</span></li>
<li><span>JE 140 · Aug 30 · no memo</span><span class="dl"></span><span class="v">562.50</span></li>
<li class="ev-total"><span>In A/R with no customer</span><span class="dl"></span><span class="v">4,212.50</span></li></ul>
<div class="basis"><span>Check <b>PF-01</b></span><span>Rules only, no AI</span><span>Accounts <b>1200 Accounts receivable</b></span></div></div>
<div><div class="opt is-sel"><span class="t-head" style="font-size:13px;line-height:20px">Fix in QuickBooks</span><p>Dorrian’s office reverses or applies the three entries. We re-pull and this check re-runs. Goes in the report to the client.</p></div>
<div class="opt"><span class="t-head" style="font-size:13px;line-height:20px">Handle it for me</span><p>Carry 4,212.50 as one reconciling item, “Unapplied A/R from conversion”, owned by Dana Lee, cleared in October. Prints on the certificate.</p></div>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--quiet" type="button">{ico("eye")}Open the 3 entries</button><button class="btn btn--quiet" type="button">{ico("ask")}Ask someone</button></div></div></div>"""
    out += f'<div class="fd-grp"><span class="q-group-t">Warnings</span><span class="t-cap">9 · largest first · each needs a decision</span></div>'
    for i, t, p, v, sel in FIND_W:
        s = seg(["Fix in source", "Handle it", "Accept"], sel) if sel is not None else seg(["Fix in source", "Handle it", "Accept"], -1)
        out += (f'<div class="fd-row" tabindex="0"><span>{status("risk", "Warning")}<span class="l2" style="margin-top:2px">{i}</span></span>'
                f'<div><span class="t">{t}</span><p>{p}</p></div><span class="amt">{money(v)}</span>{s}</div>')
    out += (f'<div class="fd-grp"><span class="q-group-t">Info</span><span class="t-cap">1 · feeds customer and vendor matching</span></div>'
            f'<div class="fd-row" tabindex="0"><span><span class="status" style="color:var(--electric)"><i class="pip pip--open" aria-hidden="true"></i>Info</span><span class="l2" style="margin-top:2px">PF-13</span></span>'
            f'<div><span class="t">14 likely duplicate customers and vendors</span><p>“Johnstone Supply” and “Johnstone Supply Co.”, and 13 more. They become merge proposals when you map.</p></div><span class="amt">—</span><span></span></div>')
    foot = (f'<div class="fd-foot"><span><b>10 of 11</b> decided</span><span>1 waiting · PF-05</span><span class="sp"></span>'
            f'<button class="btn" type="button">{ico("retry")}Re-run after a re-pull</button><button class="btn btn--primary" type="button" aria-disabled="true">Go to mapping</button></div>')
    return f'<section class="fd" aria-label="Findings, largest first">{out}{foot}</section>'


def report():
    items = [("Three journal entries in A/R with no customer", "Reverse or apply JE 114, 131 and 140.", "4,212.50"),
             ("Four vendors need a W-9 before January", "Allied Ductwork, J. Ruiz Electric, Metro Crane, T&amp;K Sheet Metal. We’ll email each a secure W-9 link.", "38,600.00")]
    li = "".join(f'<li><span><b>{a}</b>{b}</span><span class="v">{c}</span></li>' for a, b, c in items)
    doc = (f'<div class="doc" role="img" aria-label="Preview of the PDF report to Dorrian HVAC"><img src="assets/merit-logo-on-light.png" alt="" width="54" height="16">'
           f'<h4>What we found in Dorrian HVAC’s books before we moved them</h4><p class="t-cap">QuickBooks as of Sep 30, 2026 · prepared Oct 19 by Dana Lee, Merit Management Group</p>'
           f'<hr class="rule"><p class="ink-2" style="font-size:12px;line-height:16px">We ran 24 checks and 9 passed outright. These 2 need you.</p><ol style="margin-top:8px">{li}</ol>'
           f'<p class="ink-2" style="font-size:12px;line-height:16px;margin-top:12px">We’re handling 6 more for you, including 12,400.00 of equipment deposits moving from sales to customer deposits.</p><p class="fine">Nothing in your QuickBooks was changed. MeritBooks only reads.</p></div>')
    return (f'<aside class="rep" aria-label="Report to the client"><div class="panel-head"><div class="eyebrow">Send to the client</div>'
            f'<div class="t-head" style="margin-top:4px">The items marked Fix in source</div><p class="t-cap" style="margin-top:2px">Branded PDF · updates as you decide</p></div>{doc}'
            f'<div class="panel-foot"><button class="btn" type="button">{ico("download")}PDF</button><span class="sp"></span><button class="btn btn--primary" type="button">{ico("send")}Send to Dorrian’s office</button></div></aside>')


def states():
    run = ('<div class="state"><div class="state-h"><span class="eyebrow">Loading · checks running</span></div><div class="card-b">'
           '<p class="t-head" style="margin:0">Running 24 checks on the QuickBooks pull</p><p class="ink-2" style="margin-top:4px">14 of 24 done. Mapping opens when they finish; nothing here needs you yet.</p>'
           '<div style="margin-top:12px"><span class="meter meter--lg" role="img" aria-label="14 of 24 checks done">' + '<i class="on"></i>' * 14 + '<i></i>' * 10 + '</span></div>'
           '<span class="bar-l" style="width:80%"></span><span class="bar-l" style="width:60%"></span><span class="bar-l" style="width:70%"></span></div></div>')
    done = state("Done · no blockers", "done", "No blockers. Every warning has a decision.",
                 "PF-01 cleared on the Oct 21 re-pull after Dorrian’s office reversed the three entries. 6 items are being handled for you and print on the certificate. Mapping is next.",
                 '<button class="btn btn--primary" type="button">Go to mapping</button><button class="btn" type="button">See the decision log</button>')
    err = state("Error · couldn’t run", "err", "The QuickBooks connection for Dorrian expired",
                "Intuit asked for sign-in again on Oct 18 at 11:40 PM, so the nightly pull didn’t run and the checks are a day old. Dorrian’s owner holds the QuickBooks login.",
                '<button class="btn btn--primary" type="button">' + ico("send") + 'Ask the owner to reconnect</button><button class="btn" type="button">Use yesterday’s results</button>')
    return f'<div class="states">{run}{done}{err}</div>'


def build():
    tot = money(sum(f[3] for f in FIND_B))
    main = (ctxline(["Mon Oct 19", "Dorrian HVAC", "Preflight · day 4", f'<b class="neg">2 blockers · {tot}</b>', "9 warnings · 8 decided"],
                    '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Migration<span class="sl">//</span>Preflight<span class="sl">//</span>Dorrian HVAC</div>'
              '<h1 class="t-title" style="margin-top:8px">Before we move anything</h1></div>'
              f'<div class="btn-row"><span class="srcs">{src("QuickBooks", "ok")}{src("FieldEdge", "bridge", "via QB", True)}</span></div></div>'
            + grid() + f'<div class="pfl">{findings()}{report()}</div></div>')
    a = app("client", "density-cockpit", rail_mini(CLIENT_MINI, "DL", 1), bar(ctx_client("Dorrian HVAC", "C-105"), "Migration · Preflight", "Jump to account, vendor, customer…", "QuickBooks pulled 6:04 AM"), main, extra_cls="app--mini")
    a = a.replace('class="app ', 'data-live class="app ', 1)
    body = (board_h("O14<span class=\"sl\">//</span>08-ONBOARDING §8", "What’s wrong, in dollars, before it moves",
                    "The moment Dorrian’s QuickBooks connected, 24 deterministic checks ran. Every result is on one strip; the findings below are ranked by dollars, in plain English, "
                    "and each one gets a decision: fix it in QuickBooks, or have it handled here. The fix-in-source items become a report Dana can send Dorrian’s office.",
                    '<span class="tag">Sample data</span> O14')
            + frame(a, "O14.1 · 2 blockers, the first opened with its evidence. Report preview updates as decisions are made.")
            + anno([("All 24 on one strip", "Blocker, warning, info, passed, not applicable: pip shape and word on every tile, so the strip reads in greyscale."),
                    ("Evidence that sums", "The opened blocker lists the three entries behind 4,212.50. The two blockers add to the 4,824.50 the Tower shows."),
                    ("Two kinds of fix", "Fix in source goes into the client report and re-checks on the next pull. Handle it for me names the reconciling item, its owner and when it clears."),
                    ("A gift, not a gate", "The report is Merit-branded and in the client’s words: what we found before we moved your books. It proves value before go-live.")])
            + section_h("O14.2 · Running, done and couldn’t run", "")
            + f'<div class="frame" style="background:var(--canvas)">{states()}</div>')
    return page("O14 · Preflight", CSS, body, "O-preflight.html")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "O-preflight.html")
    open(out, "w").write(build())
    print(out)
