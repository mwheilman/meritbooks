"""S9 — Platform console home (Mike, platform admin). Operator Cockpit density, platform context."""
from common import *

CSS = """
/* S9 layout only */
.funnel{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:0;border-bottom:1px solid var(--line)}
.funnel .band-tab{padding:10px 16px}
.funnel .band-tab .v{font-size:20px}
.wg .tbl-q th{background:var(--white)}
.tn td{height:48px}
.tn tbody tr{cursor:pointer}
.tn tbody tr:focus-visible{outline:2px solid var(--electric);outline-offset:-2px}
.risk{font-weight:600}
.gw{padding:8px 16px 0}
.gw p{color:var(--ink-2)}
.sa{list-style:none}
.sa li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
.sa .clock{font-weight:600;font-variant-numeric:tabular-nums}
.bx{padding:12px 16px 8px}
.bx p{color:var(--ink-2);margin-top:6px}
.bi td{height:44px}
.aisp td{height:36px}
"""


def m_tenants(p):
    bands = [("All", 7, "sorted by risk", True), ("Invited", 1, "1 unopened", False), ("Signed up", 1, "2 days", False),
             ("Setting up", 1, "4 days", False), ("Converting", 1, "1 stuck", False), ("Live", 3, "2 broken feeds", False)]
    tabs = "".join(f'<button class="band-tab" role="tab" type="button" aria-selected="{"true" if s else "false"}"><span class="eyebrow">{a}</span><span class="v">{b}</span><span class="t-cap">{c}</span></button>' for a, b, c, s in bands)
    T = [
        ("Hawkeye CPA Partners", "Firm", "22 clients · 9 seats", "Converting", "day 19", "9 days ago", "14 of 22", "risk", "At risk", "Import stalled 6 days", 82, True),
        ("Prairie Dental Group", "Company", "4 companies · 6 seats", "Live", "since Aug 3", "2 hours ago", '<b class="neg">2 broken</b>', "blocked", "Feeds down", "Plaid login, 3 days", 64, True),
        ("Ostrander &amp; Lowe CPAs", "Firm", "No clients yet · 1 seat", "Signed up", "day 2", "2 days ago", "—", "track", "On track", "Setup not started", 31, False),
        ("Northfield Ag Supply", "Company", "Invited Oct 15", "Invited", "day 4", "—", "—", "track", "On track", "Invite not opened", 28, False),
        ("Merit Management Group", "Firm", "13 clients · 18 seats", "Live", "since Jul 1", "4 min ago", '<b class="neg">1 broken</b>', "track", "On track", "1 client overdue", 22, False),
        ("Cedar Valley Builders", "Company", "1 company · 2 seats", "Setting up", "day 4", "1 day ago", "3 of 3", "track", "On track", "Opening balances next", 14, False),
        ("Des Moines Bookkeeping", "Firm", "31 clients · 7 seats", "Live", "since May 12", "12 min ago", "48 of 48", "ready", "Healthy", "Closed Sep early", 6, False),
    ]
    rows = ""
    for name, typ, sub, stage, st2, last, feeds, sk, sw, why, risk, attn in T:
        tag = "tag--solid" if typ == "Firm" else ""
        rows += (f'<tr class="q-row{" is-attn" if attn else ""}" tabindex="0" data-drill="{name}"><td><span class="l1">{name}</span><span class="l2">{sub}</span></td>'
                 f'<td><span class="tag {tag}">{typ}</span></td><td><span class="l1">{stage}</span><span class="l2">{st2}</span></td>'
                 f'<td class="ink-2">{last}</td><td>{feeds}</td>'
                 f'<td><span class="l1">{status(sk, sw)}</span><span class="l2">{why}</span></td><td class="n risk{" neg" if risk >= 60 else ""}">{risk}</td></tr>')
    table = f"""<table class="tbl tbl-q tbl-q--flush tn" aria-label="Tenant health, highest risk first">
<colgroup><col><col style="width:96px"><col style="width:96px"><col style="width:92px"><col style="width:76px"><col style="width:144px"><col style="width:44px"></colgroup>
<thead><tr><th>Tenant</th><th>Type</th><th>Stage</th><th>Last active</th><th>Feeds</th><th>Health</th><th class="n">Risk</th></tr></thead><tbody>{rows}</tbody></table>"""
    body = f'<div class="bands funnel" role="tablist" aria-label="Onboarding funnel">{tabs}</div>{table}'
    foot = ('<span>Risk = activity, feeds, close lag, errors, AI burn, billing · no tenant financials</span>'
            f'<button class="btn btn--primary" type="button">Nudge Hawkeye’s owner</button>')
    act = f'<button class="btn btn--quiet" type="button">{ico("plus")}Provision tenant</button>'
    return wg("pf.tenant_health", "Tenants", body, 1, 1, 8, 4, count="7", meta="4 firms · 3 companies", act=act, foot=foot, primary=True, label_id=f"{p}-tn")


def m_ai(p):
    body = f"""<table class="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="AI gateway status and spend"><colgroup><col><col style="width:84px"><col style="width:80px"></colgroup><tbody>
<tr class="q-row is-attn"><td><span class="l1 neg">Anthropic org disabled</span><span class="l2">Since Oct 16, 9:12 AM</span></td><td></td><td style="text-align:right">{status("blocked", "Down")}</td></tr>
</tbody></table>
<div class="gw"><p>All 7 tenants on rules and vendor memory. 1,284 items wait for AI.</p></div>
<table class="tbl tbl-q tbl-q--flush tbl-q--compact aisp" aria-label="October AI spend by tenant"><colgroup><col><col style="width:84px"><col style="width:80px"></colgroup>
<thead><tr><th>October spend</th><th class="n">Spent</th><th class="n">Budget</th></tr></thead><tbody>
<tr class="q-row"><td>Merit Management Group</td><td class="n">412.60</td><td class="n">600.00</td></tr>
<tr class="q-row"><td>Des Moines Bookkeeping</td><td class="n">288.10</td><td class="n">400.00</td></tr>
</tbody></table>"""
    foot = '<span>5 others 63.80</span><button class="btn btn--primary" type="button">Open gateway settings</button>'
    return wg("pf.ai", "AI gateway", body, 9, 1, 4, 2, count='<span class="tag tag--neg">Critical</span>', foot=foot, label_id=f"{p}-ai")


def m_support(p):
    body = f"""<ul class="sa">
<li><div><span class="l1">Merit Management Group</span><span class="l2">Alex Kim · Dorrian HVAC · read-only</span></div><div class="row"><span class="clock">42:00</span><button class="btn btn--danger" type="button">End</button></div></li>
<li><div><span class="l1">Hawkeye CPA Partners</span><span class="l2">MB-2304 · read-only · 60 min</span></div><span class="status status--track"><i class="pip pip--track" aria-hidden="true"></i>Waiting 18 min</span></li>
</ul>
<p class="t-cap" style="padding:10px 16px">You see a tenant’s books only after their admin approves. Every page opened is in their access log.</p>"""
    foot = f'<a class="btn btn--quiet" href="#">Access log</a><button class="btn btn--primary" type="button">{ico("shield")}Request access</button>'
    return wg("pf.support", "Support access", body, 9, 3, 4, 2, count="1 open", foot=foot, label_id=f"{p}-sa")


def m_billing(p):
    rows = [("Merit Management Group", "18 seats on a 15-seat plan", "+135 / mo", "Review plan"),
            ("Prairie Dental Group", "5th company added Oct 9; plan covers 4", "+160 / mo", "Review plan"),
            ("Hawkeye CPA Partners", "Trial ends Oct 24 · no payment method", "", "Remind")]
    tr = "".join(f'<tr class="q-row"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td class="n">{c or "—"}</td>'
                 f'<td style="text-align:right"><button class="btn" type="button">{d}</button></td></tr>' for a, b, c, d in rows)
    body = f"""<div class="bx"><div class="row"><span class="tag tag--warn">MRR is list-price computed</span><span class="b tnum">4,430 / mo</span></div>
<p>Charging isn’t live yet, so nothing has been charged and nothing can fail.</p></div>
<table class="tbl tbl-q tbl-q--flush bi" aria-label="Billing exceptions"><colgroup><col><col style="width:96px"><col style="width:136px"></colgroup><tbody>{tr}</tbody></table>"""
    foot = f'<span>Amounts at list price</span><a class="btn btn--quiet" href="#">Plans and billing{ico("right")}</a>'
    return wg("pf.billing", "Billing exceptions", body, 1, 5, 6, 2, count="3", foot=foot, label_id=f"{p}-bi")


def m_integrations(p):
    rows = [("Plaid", "2 items · Prairie Dental, Merit", "blocked", "Failing", "7:40 AM", True),
            ("QuickBooks import", "Hawkeye token ends in 2 days", "risk", "Expiring", "7:40 AM", False),
            ("Stripe Connect", "3 accounts · charges enabled", "ready", "Healthy", "7:40 AM", False),
            ("Inbound bill email", "0 bounces in 24 hours", "ready", "Healthy", "7:38 AM", False),
            ("Ramp", "Planned, not connected", "track", "Not live", "—", False)]
    tr = "".join(f'<tr class="q-row{" is-attn" if at else ""}" tabindex="0" data-drill="{a}"><td><span class="b">{a}</span></td><td class="ink-2">{b}</td><td>{status(k, w)}</td><td class="tnum ink-3">{t}</td></tr>' for a, b, k, w, t, at in rows)
    body = f"""<table class="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Integration health by provider"><colgroup><col style="width:160px"><col><col style="width:104px"><col style="width:80px"></colgroup>
<tbody>{tr}</tbody></table>"""
    foot = f'<span>Checked every 5 minutes</span><a class="btn btn--quiet" href="#">Affected tenants{ico("right")}</a>'
    return wg("pf.integrations", "Integration health", body, 7, 5, 6, 2, count="1 failing", foot=foot, label_id=f"{p}-in")


def pf_app(p):
    groups = [("", [("Home", True)]),
              ("Tenants", [("All tenants", False, 7), ("Onboarding funnel",), ("Provision tenant",)]),
              ("Revenue", [("Plans and billing",), ("Billing exceptions", False, 3)]),
              ("Health", [("Integrations", False, 1), ("AI gateway and spend", False, "Off", True), ("Errors and deploys",)]),
              ("Support", [("Access requests", False, 1), ("Active sessions", False, 1), ("Access log",)]),
              ("Defaults", [("Dashboard templates",), ("Role templates",), ("Chart of accounts templates",)]),
              ("Admin", [("Platform team",)])]
    r = rail(groups, "Mike Heilman", "Platform admin")
    ctx = (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false">{ico("grid")}<span class="ctx-name">MeritBooks Platform</span>'
           f'{ico("down")}<span class="kbd">⌘J</span></button>')
    ctxl = ctxline(["Mon Oct 19", "7 tenants, 3 live", "1 at risk · 2 with broken feeds", '<b class="neg">AI gateway off since Oct 16</b>'],
                   right=customize_btn() + '<span class="sample">Sample data</span>')
    mods = m_tenants(p) + m_ai(p) + m_support(p) + m_billing(p) + m_integrations(p)
    main = ctxl + f'<div class="page"><div class="dash">{mods}</div></div>'
    return app("platform", "density-cockpit", r, bar(ctx, "Platform home", cmd="Jump to tenant, ticket, provider…", sync="Live"), main)


def states():
    tiles = [
        ("Tenants · empty", f'<div class="wg-state"><span class="wg-empty-mark" aria-hidden="true">{ico("plus")}</span><span class="t-head">No tenants yet.</span><p>Provision the first one, or send a sign-up link.</p><button class="btn btn--primary" type="button">Provision tenant</button></div>'),
        ("Tenant health · done", f'<div class="wg-state"><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><span class="t-head">All 7 tenants healthy.</span><p>Next check 7:45 AM.</p></div>'),
        ("AI gateway · done", f'<div class="wg-state"><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><span class="t-head">Gateway healthy · 1,204.30 this month.</span><p>No tenant over 80% of budget.</p></div>'),
        ("Support access · done", f'<div class="wg-state"><span class="wg-done-mark" aria-hidden="true">{ico("check")}</span><span class="t-head">No open sessions.</span><p>No requests waiting on a tenant.</p><button class="btn" type="button">Request access</button></div>'),
    ]
    out = "".join(wg(f"s9st{i}", t, b, i * 3 + 1, 1, 3, 2, label_id=f"s9st-{i}") for i, (t, b) in enumerate(tiles))
    return f'<div class="page density-cockpit" style="padding:24px 32px"><div class="dash">{out}</div></div>'


def build():
    html = head("S9 · Platform console home", CSS) + sheet_top("S9-platform-console-home.html") + '<main id="main" class="sheet">'
    html += board_h('S9<span class="sl">//</span>IA-SPEC §4.3 · platform admin', "Mike’s platform console: which tenants are stuck, and is it us?",
                    "The funnel and the tenant table are one module: the stage tabs filter the table, and the table is ranked by risk. "
                    "On the right, the two things that can be the platform’s fault: the AI gateway, which is down, and support access. "
                    "Tenants are firms or companies. Nothing here shows a tenant’s financial figures.",
                    "S9")
    html += f'<div class="frame">{pf_app("s")}</div>'
    html += '<div class="frame-cap"><span>Open state · Operator Cockpit density · platform context.</span><span>Counts, health and money owed to MeritBooks only (IA-SPEC R13)</span></div>'
    html += anno([
        ("Funnel as tabs", "Invited → Signed up → Setting up → Converting → Live, each with its count and the one fact that matters in that stage. The table follows the tab."),
        ("Ranked by risk, explained", "Each row says why it scores: Hawkeye’s import has stalled for 6 days; Prairie Dental’s Plaid login has been broken for 3. The score is a sort key, not a verdict."),
        ("Honest billing", "MRR is labelled list-price computed, because charging isn’t live. The module says why there are no failed payments instead of implying there are none."),
        ("Consent, visibly", "Support access shows the one live session with its countdown and End, and the request still waiting on Hawkeye’s admin. Request access asks; it never opens."),
    ])
    html += board_h('S9<span class="sl">//</span>States', "Empty and done", "What each module says when there’s nothing to do.", "S9.2", h="h2", style=' style="margin-top:56px"')
    html += f'<div class="frame">{states()}</div>'
    html += "</main>" + TOAST + SCRIPT + "</body></html>"
    return html


if __name__ == "__main__":
    open("../S9-platform-console-home.html", "w").write(build())
    print("ok")
