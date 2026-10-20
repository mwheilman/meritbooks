"""S27 (per the brief; IA-SPEC §8 lists the settings IA as S26) — one settings home for tenant, client and personal
settings (IA-SPEC 3.8.1 · 3.8.2 · 3.8.3, 3.9 migration, 3.10)."""
from fo_common import *

CSS = """
/* S27 layout only */
.pad{padding:0 var(--margin)}
.mig{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 16px;background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.mig b{font-weight:600}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;margin-top:24px}
.scope{border-top:2px solid var(--electric)}
.scope-h{display:flex;align-items:center;gap:12px;padding:12px 0}
.scope-h .t-section{color:var(--ink)}
.scope-h .sp{flex:1}
.ar{list-style:none}
.ar li{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:56px;padding:8px 8px 8px 0;border-bottom:1px solid var(--line);transition:background-color var(--fast)}
.ar li{position:relative}
.ar .nm a::after{content:"";position:absolute;inset:0}
.ar .nm a:focus-visible{outline:0}
.ar li:focus-within{outline:2px solid var(--electric);outline-offset:-2px}
.ar .st .btn,.ar .mv{position:relative;z-index:1}
.ar li:hover{background:var(--grey-100)}
.ar .no{font:700 15px/24px var(--f-display);color:transparent;-webkit-text-stroke:1px var(--electric);text-align:right;font-variant-numeric:tabular-nums}
.ar .nm{font-weight:600;display:flex;align-items:center;gap:8px;min-width:0}
.ar .nm a{white-space:nowrap}
.ar .ds{display:block;font-size:12px;line-height:16px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar .st{display:flex;align-items:center;gap:8px;justify-content:flex-end;white-space:nowrap}
.ar li.is-attn{box-shadow:inset 3px 0 var(--warn)}
.lock{display:inline-flex;align-items:center;gap:4px;color:var(--ink-3);font-size:12px;font-weight:500}
.mv{font-size:12px;line-height:16px;color:var(--electric);font-weight:500}
/* signature: inheritance marks — follows the firm’s default, or overrides it */
.ih{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;white-space:nowrap;color:var(--ink-3)}
.ih i{position:relative;display:inline-block;width:14px;height:14px;box-shadow:inset 0 0 0 1.5px var(--night-500);flex:none}
.ih i::after{content:"";position:absolute;left:3px;top:3px;width:5px;height:5px;border-left:1.5px solid var(--night-500);border-bottom:1.5px solid var(--night-500)}
.ih.ov{color:var(--electric);font-weight:600}
.ih.ov i{background:var(--electric);box-shadow:none}
.ih.ov i::after{border-color:var(--white)}
.ih.own{color:var(--ink-2)}
.ih.own i{box-shadow:inset 0 0 0 1.5px var(--ink-2);background:repeating-linear-gradient(135deg,transparent 0 3px,var(--grey-300) 3px 4px)}
.ih.own i::after{display:none}
.lg{display:flex;flex-wrap:wrap;gap:4px 20px}
.lin{table-layout:fixed}
.lin th{height:56px;padding:0 4px;font:500 12px/16px var(--f-text);color:var(--ink-2);text-align:center;vertical-align:bottom;padding-bottom:8px;border-bottom:1px solid var(--electric);white-space:normal}
.lin th:first-child{text-align:left;padding-left:0}
.lin td{height:40px;padding:0 4px;border-bottom:1px solid var(--line);text-align:center}
.lin td:first-child{text-align:left;padding-left:0}
.lin tr.dflt td{background:var(--canvas);font-weight:600;height:48px}
.lin tr.dflt td .t-cap{font-weight:400;display:block}
.lin .cell{display:inline-grid;place-items:center;width:32px;height:32px}
.lin .cell i{position:relative;display:block;width:16px;height:16px;box-shadow:inset 0 0 0 1.5px var(--night-500)}
.lin .cell i::after{content:"";position:absolute;left:4px;top:3px;width:6px;height:6px;border-left:1.5px solid var(--night-500);border-bottom:1.5px solid var(--night-500)}
.lin .cell.ov i{background:var(--electric);box-shadow:none}
.lin .cell.ov i::after{border-color:var(--white)}
.lin .cell.na{color:var(--ink-3)}
.lin tr:hover td{background:var(--grey-100)}
.lin tr.dflt:hover td{background:var(--canvas)}
.two{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px}
.dv{list-style:none;border-top:2px solid var(--electric)}
.dv li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;min-height:44px;border-bottom:1px solid var(--line)}
.dv .v{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.srch{position:absolute;left:50%;top:96px;transform:translateX(-50%);width:640px;z-index:30}
.popover-item .ds{display:block;font-size:12px;line-height:16px;color:var(--ink-3)}
.popover-item .scope-tag{flex:none}
"""

TENANT = [
    ("Organization", "Name, firm type, fiscal year, white-label brand", "Firm · Jan year · Merit brand", "", "", "Settings · Organization"),
    ("Security", "MFA, step-up, session limits, IP allowlist", "MFA 12 of 15", "warn", "", ""),
    ("Access & roles", "Roles, permission sets, envelopes, SoD, access log", "19 roles · 2 template updates", "", "", "/settings/roles"),
    ("Approval workflows", "Configure, visualize, simulate, coverage gaps", "1 coverage gap", "warn", "", ""),
    ("Policies", "AP and expense policy, one surface", "AP v4 · expense v2", "", "", "/bills/policy, /expenses/policy"),
    ("AI & automation", "Autonomy dial, kill switch, learned preferences, cost routing", "Auto-post off", "", "", "AI Thresholds, Learned Preferences, Cost Routing"),
    ("Notifications & alerts", "Email, SMS, push, Slack, Teams · quiet hours · digests", "8 PM–7 AM quiet", "", "", ""),
    ("Dashboard layouts", "Publish role layouts, locks, required widgets", "11 layouts", "", "", ""),
    ("Integrations", "Tenant connectors and credentials", "1 needs attention", "warn", "", "/integrations/erp"),
    ("Defaults for new clients", "Revenue, sales tax, invoices, receipt chase, close, access", "7 defaults · 10 overrides", "", "", "Revenue Recognition, Sales Tax, Invoice Display, Receipt Chase"),
    ("Plan & billing", "Plan, seats, per-client pricing, AI usage", "Billing not live", "", "", "/settings/billing"),
    ("Support access", "Approve requests, active sessions, log", "No open requests", "", "", ""),
    ("Data & danger zone", "Full export, sandbox reset, retention", "Exported Sep 30", "", "lock", "Danger Zone"),
]
assert len(TENANT) == 13
CLIENT = [  # name, contents, status, attention, inherit
    ("Client profile", "Legal name, EIN, industry, context the agents read", "EIN ••4471", "", "own"),
    ("People & access", "Who has access and how · client contacts", "11 people", "", "own"),
    ("Accounting setup", "Account roles, dimensions, fiscal calendar, modules used", "5 modules", "", "own"),
    ("Bank & card connections", "Plaid, card accounts, Ramp, statement-only", "3 accounts", "", "own"),
    ("Cards & receipt chase", "Card → cardholder, thresholds, cadence, channels", "1 card not mapped", "warn", "ov"),
    ("Inboxes", "AP email-to-bill address, mailboxes", "ap-clive@in…", "", "own"),
    ("Online payments", "Stripe Connect status and payouts", "Connected", "", "own"),
    ("Invoice branding & delivery", "Style, logo, reply-to, terms text", "", "", "fol"),
    ("Revenue policy", "Basis and method per revenue stream", "", "", "fol"),
    ("Sales tax", "Nexus, rates, provider", "", "", "ov"),
    ("Close checklist", "Template, due day, reviewer ≠ preparer", "", "", "fol"),
    ("Policies", "Client AP and expense rules on top of Merit’s", "", "", "ov"),
    ("Integrations for this client", "ServiceTitan tenant, mapping rules", "ServiceTitan", "", "own"),
    ("Data import & conversion", "Imports, history, tie-out gate", "Converted Jun 2026", "", "own"),
]
assert len(CLIENT) == 14
PERSONAL = [("Profile", "Name, email, sign-in"), ("Notifications & quiet hours", "What reaches you, and when"), ("My watch rules", "“Tell me when…”"),
            ("My dashboard", "Reset to your role’s layout"), ("Approval delegation", "Who approves while you’re away"), ("Devices", "Receipt app on your phone"),
            ("My access", "What can I do, and why")]
assert len(PERSONAL) == 7
OV_LBL = {"Cards & receipt chase": "Overrides · 1", "Sales tax": "Overrides · 2", "Policies": "Overrides · 2"}

LIN_COLS = ["Invoice branding", "Revenue policy", "Sales tax", "Receipt chase", "Close checklist", "AP & expense policy", "Client access policy"]
LIN = {  # client: tuple of 'f' follows / 'o' override / '-' n/a
    "Merit Management Group LLC": "fff-off", "Heartland Heating & Cooling": "fofffff", "Metro Heating & Cooling": "fffffff",
    "Dorrian HVAC": "fffffof", "Crystal Kitchen & Bath": "offffff", "AIM Kitchen & Bath": "fffffff", "Iowa Custom Cabinets": "fofffff",
    "Revived Interiors": "fffffff", "Artistry Homes": "ofoffff", "Clive Power Equipment": "ffoofof", "Heritage Interiors": "fffffff",
    "Swan Creek": "f-f-fff", "Wild Rose Interiors": "fffffff",
}
N_OV = sum(v.count("o") for v in LIN.values())
assert N_OV == 10, N_OV
assert LIN["Clive Power Equipment"][3] == "o" and LIN["Clive Power Equipment"][2] == "o"


def ih(kind, label=None):
    if kind == "ov":
        return f'<span class="ih ov"><i aria-hidden="true"></i>{label or "Overrides Merit"}</span>'
    if kind == "fol":
        return f'<span class="ih"><i aria-hidden="true"></i>{label or "Follows Merit"}</span>'
    return f'<span class="ih own"><i aria-hidden="true"></i>{label or "This client only"}</span>'


def mike_rail(cur="Settings"):
    return rail(workspace_nav(cur, counts={"Inbox": 4, "Access requests": 2}), "Mike Heilman", "Owner · Tenant admin")


def tenant_list():
    out = '<ol class="ar" aria-label="Tenant settings">'
    for i, (nm, ds, st, at, lk, frm) in enumerate(TENANT, 1):
        stc = f'<span class="t-cap{" warn" if at else ""}" style="{"font-weight:600" if at else ""}">{st}</span>'
        lock = f'<span class="lock">{ico("lock")}Two people</span>' if lk else ""
        mv = f'<span class="mv" title="Moved from {E(frm)}">Moved here</span>' if frm and i in (6, 10) else ""
        out += (f'<li class="{"is-attn" if at else ""}"><span class="no" aria-hidden="true">{i}</span><span><span class="nm"><a href="#" style="color:var(--ink)">{nm}</a>{mv}</span>'
                f'<span class="ds">{ds}</span></span><span class="st">{lock}{stc}</span></li>')
    return out + "</ol>"


def client_list():
    out = '<ol class="ar" aria-label="Client settings for Clive Power Equipment">'
    for i, (nm, ds, st, at, inh) in enumerate(CLIENT, 1):
        stc = f'<span class="t-cap{" warn" if at else ""}" style="{"font-weight:600" if at else ""}">{st}</span>' if st else ""
        mark = ih(inh, OV_LBL.get(nm)) if inh in ("ov", "fol") else ""
        out += (f'<li class="{"is-attn" if at else ""}"><span class="no" aria-hidden="true">{i}</span><span><span class="nm"><a href="#" style="color:var(--ink)">{nm}</a></span>'
                f'<span class="ds">{ds}</span></span><span class="st">{stc}{mark}</span></li>')
    return out + "</ol>"


def personal_list():
    out = '<ol class="ar" aria-label="Your settings">'
    for i, (nm, ds) in enumerate(PERSONAL, 1):
        out += f'<li><span class="no" aria-hidden="true">{i}</span><span><span class="nm"><a href="#" style="color:var(--ink)">{nm}</a></span><span class="ds">{ds}</span></span><span class="st"></span></li>'
    return out + "</ol>"


def mig_banner():
    return (f'<div class="mig">{ico("info")}<span><b>Settings moved this release.</b> The old one-page Settings is split into Merit’s settings and each client’s. '
            'Old links open the new home until Dec 1.</span><button class="btn btn--quiet" type="button">Where did it go?' + ico("right") + '</button></div>')


def home_frame(with_search=False):
    head_ = (f'<div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Settings</div><h1 class="t-title" style="margin-top:4px">Settings</h1></div>'
             f'<div class="search" style="width:420px">{ico("search")}<input aria-label="Find a setting" placeholder="Find a setting, or an old tab name" value="{"receipt" if with_search else ""}"><span class="kbd">/</span></div></div>')
    cols = f"""<div class="cols"><div><section class="scope" aria-labelledby="sc-t"><div class="scope-h"><h2 class="t-section" id="sc-t">Merit Management Group</h2><span class="tag">Firm · 13 areas</span><span class="sp"></span><span class="t-cap">Applies to every client</span></div>{tenant_list()}</section>
<section class="scope" aria-labelledby="sc-y" style="margin-top:32px"><div class="scope-h"><h2 class="t-section" id="sc-y">You</h2><span class="sp"></span><span class="t-cap">Mike Heilman · 7 areas</span></div>{personal_list()}</section></div>
<div><section class="scope" aria-labelledby="sc-c"><div class="scope-h"><h2 class="t-section" id="sc-c">For a client</h2>
<button class="ctx" type="button" style="background:var(--white);border-color:var(--line-2);color:var(--ink);max-width:280px" aria-haspopup="dialog"><i class="pip pip--open" aria-hidden="true"></i><span class="ctx-name">Clive Power Equipment</span>{ico("down")}</button>
<span class="sp"></span><span class="t-cap">14 areas</span></div>{client_list()}</section></div></div>"""
    lg = f'<div class="lg" style="margin-top:12px">{ih("fol")}{ih("ov", "Overrides Merit’s default")}{ih("own")}<span class="t-cap">Merit areas you can’t change aren’t shown, they’re hidden, not greyed</span></div>'
    srch = ""
    if with_search:
        items = [("Merit Management Group", "Defaults for new clients · Receipt chase", "Receipts over 75.00 · day 0 / 2 / 5 / 10", True),
                 ("Clive Power Equipment", "Cards & receipt chase", "Overrides: receipts over 25.00 · 1 card not mapped", False),
                 ("Clive Power Equipment", "Policies · expense rules", "Itemized meals over 75.00", False),
                 ("You", "Notifications & quiet hours · Receipt reminders", "Digest at 8:00 AM", False)]
        li = ""
        for sc, nm, ds, sel in items:
            li += (f'<li class="popover-item"{" aria-selected=true" if sel else ""}><span><b>{nm}</b><span class="ds">{ds}</span></span>'
                   f'<span class="r"><span class="tag">{sc}</span></span></li>')
        srch = (f'<div class="popover srch" role="dialog" aria-label="Settings search"><div class="popover-head">{ico("search")}<input aria-label="Find a setting" value="receipt"><span class="kbd">Esc</span></div>'
                f'<ul class="popover-list"><li class="popover-group"><span>4 settings</span><span>across Merit, Clive and you</span></li>{li}'
                f'<li class="popover-group"><span>Old name</span></li><li class="popover-item"><span><b>Settings · Receipt Chase</b><span class="ds">Now split: Merit’s default in Defaults for new clients, each client’s in Cards &amp; receipt chase</span></span><span class="r">{ico("right")}</span></li></ul>'
                f'<div class="popover-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> move</span><span><span class="kbd">↵</span> open</span><span>Only settings you can change are listed</span></div></div>')
    page = f'<div class="page">{head_}{mig_banner()}{lg}{cols}</div>'
    main = ctxline(["Mon Oct 19", "Merit Management Group", "Settings", "<b>3 areas need attention</b>"]) + page + (f'<div class="scrim" style="z-index:25"></div>{srch}' if with_search else "")
    return app("workspace", "density-cockpit", mike_rail(), bar(ctx_workspace(), "<b>Settings</b>", cmd="Jump to client, report, setting…"), main, 1580 if not with_search else 760,
               live=not with_search)


def lineage_frame():
    th = "".join(f"<th>{c}</th>" for c in LIN_COLS)
    dv = ["Merit standard", "Point of sale", "Iowa rates · Avalara", "Over 75.00 · 0/2/5/10", "Day 15 · reviewer ≠ preparer", "AP v4 · expense v2", "Assigned staff only"]
    rows = '<tr class="dflt"><td>Merit default<span class="t-cap">Defaults for new clients</span></td>' + "".join(f'<td><span class="t-cap">{d}</span></td>' for d in dv) + "</tr>"
    for c, v in LIN.items():
        cells = ""
        for col, k in zip(LIN_COLS, v):
            if k == "-":
                cells += '<td><span class="cell na" title="Not used">—</span></td>'
            elif k == "o":
                cells += f'<td><a class="cell ov" href="#" title="{E(c)} overrides {col}" aria-label="{E(c)}: {col}, overrides Merit"><i></i></a></td>'
            else:
                cells += f'<td><a class="cell" href="#" title="{E(c)} follows Merit for {col}" aria-label="{E(c)}: {col}, follows Merit"><i></i></a></td>'
        rows += f'<tr><td><span class="l1">{E(c)}</span></td>{cells}</tr>'
    table = (f'<table class="tbl lin" aria-label="Where clients differ from Merit’s defaults"><colgroup><col style="width:216px">{"<col>" * len(LIN_COLS)}</colgroup>'
             f'<thead><tr><th>Client</th>{th}</tr></thead><tbody>{rows}</tbody></table>')
    dl = ("".join(f'<li><span>{a}</span><span class="v">{b}</span></li>' for a, b in [("Receipt required over", "75.00"), ("Reminders", "day 0 · 2 · 5 · 10"), ("Escalate to", "cardholder’s approver"),
                                                                                       ("Quiet hours", "8 PM – 7 AM"), ("At period end", "post and flag")]))
    side = f"""<div><div class="t-head">Receipt chase · Merit default</div><ul class="dv" style="margin-top:8px">{dl}</ul>
<article class="note note--panel" style="margin-top:20px"><div class="note-top"><span class="note-no">1</span><div><div class="note-kind">Change a default</div><div class="note-title">Who it reaches</div></div></div>
<p>Raising the threshold to 100.00 changes it for the 10 clients that follow Merit. Clive keeps its 25.00. Swan Creek has no cards.</p>
<div class="note-acts"><button class="btn btn--quiet" type="button">Preview the 10 clients</button></div></article></div>"""
    page = (f'<div class="page"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Settings<span class="sl">//</span>10 of 13</div><h1 class="t-title" style="margin-top:4px">Defaults for new clients</h1></div>'
            f'<div class="btn-row">{btn("Apply a default to clients…")}</div></div>'
            f'<div class="lg" style="margin-bottom:16px">{ih("fol", "Follows Merit")}{ih("ov", "Overrides")}<span class="ih">— not used</span><span class="t-cap">{N_OV} overrides across 13 clients · click a square to open that client’s setting</span></div>'
            f'<div class="two"><div>{table}</div>{side}</div></div>')
    main = ctxline(["Mon Oct 19", "Merit Management Group", "Settings", f"<b>{N_OV} client overrides</b>"]) + page
    return app("workspace", "density-cockpit", mike_rail(), bar(ctx_workspace(), "Settings / <b>Defaults for new clients</b>", cmd="Jump to client, report, setting…"), main, 860)


def build():
    html = head("S27 · Settings", CSS) + sheet_top("S27-settings.html") + '<main id="main" class="sheet">'
    html += board_h("S27", "IA-SPEC §3.8.1 tenant · §3.8.2 client · §3.8.3 personal · §3.9 · §3.10",
                    "One settings home: Merit’s, each client’s, and yours",
                    "Today’s Settings is one page of tabs that mixes firm-wide and per-client choices. Here every area has one home in one of three scopes, side by side: "
                    "13 for the firm, 14 for whichever client is picked, 7 for you. Client areas that have a firm default say whether they follow it or override it.")
    html += pair_h("1 · The home", "Workspace · Settings, as Mike sees it (owner and tenant admin). The client column switches with the picker; the context chip doesn’t change.")
    html += frame(home_frame(), "Open state · 34 areas on one page · status phrases come from each area", "Clive’s receipt-chase override = S22")
    html += anno([("Three scopes, no hunting", "Firm, client, you. An area lives in exactly one, and the word at the top of the column says who it applies to."),
                  ("Overrides are visible", "A client area with a Merit default carries a mark: follows, or overrides with a count. Areas that are naturally per-client say so."),
                  ("Status, not just links", "Each row carries one phrase from the area itself: 1 card not mapped, MFA 12 of 15. Three amber rows are the work."),
                  ("The move is explained", "For one release a banner and “Where did it go?” map every old tab. Old URLs open the new area.")])
    html += pair_h("2 · Find a setting", "Type part of a name, or an old tab name. Results cover all three scopes and say which one.")
    html += frame(home_frame(with_search=True), "Search · “receipt” finds the firm default, Clive’s override, a policy and a notification", "Old names resolve to where they went")
    html += pair_h("3 · Where clients differ", "Defaults for new clients (tenant area 10) with the lineage grid: every client against every default.")
    html += frame(lineage_frame(), f"Defaults for new clients · {N_OV} overrides across 13 clients · the inheritance mark is this board’s signature", "Clive overrides sales tax, receipt chase and policies, as on the home")
    html += anno([("A firm’s real question", "“Which clients don’t follow our standard?” is one grid. Filled squares are overrides; each opens that client’s setting."),
                  ("Change with eyes open", "Changing a default says which clients it reaches and which keep their override, before it’s saved."),
                  ("Nothing lost from today", "Receipt Chase, AI Thresholds, Revenue Recognition, Sales Tax Rates, Invoice Display, Learned Preferences, Cost Routing, Companies, Danger Zone, Payments, Import Data: each has a row here."),
                  ("Permission-shaped", "An area you can’t configure isn’t shown. Data &amp; danger zone shows its two-person rule up front.")])
    html += foot()
    return html


if __name__ == "__main__":
    open("../S27-settings.html", "w").write(build())
    print("ok", N_OV)
