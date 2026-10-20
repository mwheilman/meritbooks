"""S18 — Integrations hub (07-INTEGRATIONS-PLAN). Merit Management Group, tenant + per client.
A: connected systems by client with sync health, the error queue with retry and replay.
B: the catalog with honest statuses. C: the Ramp accounting connection."""
from onb import *

CSS = """
.page{padding-top:24px}
.hstrip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);background:var(--white)}
.hstrip .fig{padding:12px 16px;border-right:1px solid var(--line)}
.hstrip .fig:last-child{border-right:0}
.hstrip .fig-v--dense{font-size:20px}
.mx{margin-top:16px;border:1px solid var(--line);background:var(--white)}
.mx table th{background:var(--white)}
.mx td{height:56px;padding:0 6px}
.mx tr>*:first-child{padding-left:16px}
.mx tr>*:last-child{padding-right:16px}
.mx tr.ten td{background:var(--canvas)}
.cellx{display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:0;height:44px;padding:0 8px;border:1px solid var(--line);background:var(--white)}
.cellx .t{display:flex;align-items:center;gap:6px;font-weight:500;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cellx .t .pip{width:8px;height:8px}
.cellx .s{font-size:12px;line-height:16px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cellx.is-err{border-color:var(--neg);box-shadow:inset 3px 0 var(--neg)}
.cellx.is-err .s{color:var(--neg);font-weight:500}
.cellx.is-bridge{border-style:dashed}
.cellx.is-none{border-style:dashed;background:transparent}
.cellx.is-none .t{color:var(--ink-3);font-weight:400}
.cellx.is-arch{background:var(--grey-100)}
.eq{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:24px;margin-top:24px;align-items:start}
.eq .tbl-q td{height:60px;white-space:normal}
.eq .tbl-q th{background:var(--white)}
.eq .l1,.eq .l2{white-space:normal}
.cat-b{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.sys{display:flex;flex-direction:column;background:var(--white);border:1px solid var(--line);min-height:212px}
.sys-h{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:14px 16px 8px}
.sys-h .t-head{font-size:15px}
.sys-b{padding:0 16px 12px;flex:1}
.sys-b dl{display:grid;grid-template-columns:56px minmax(0,1fr);gap:4px 8px;margin-top:8px;font-size:12px;line-height:16px}
.sys-b dt{color:var(--ink-3)} .sys-b dd{color:var(--ink-2)}
.sys-f{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--line)}
.sys-f .sp{flex:1}
.sys.is-mine{box-shadow:inset 0 2px var(--electric)}
.sys.is-ask{border-style:dashed;background:transparent}
.cat-g{display:flex;align-items:baseline;gap:12px;margin:28px 0 12px}
.cat-g h3{font:600 12px/16px var(--f-text);letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.ramp{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:24px;align-items:start;margin-top:16px}
.ramp .tbl-q td{height:44px}
.ramp .tbl-q th{background:var(--white)}
.dir li{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}
.dir li:last-child{border-bottom:0}
.dir .l2{white-space:normal}
"""

COLS = ["Ledger source", "Field system", "Bank", "Card spend", "Payroll &amp; time", "AP inbox"]
# cell: (name, sub, kind) kind: ok | err | bridge | file | arch | none | warn
M = [
    ("Heartland Heating &amp; Cooling", "C-103 · tie-out", [("QuickBooks", "migrating · 6:02 AM", "ok"), ("simPRO", "4 min ago · webhooks", "ok"), ("Plaid", "2 accounts · 6:00 AM", "ok"),
                                                    ("Ramp", "entity · 7:40 AM", "ok"), ("Register file", "monthly", "file"), ("ap+heartland@", "3 bills today", "ok")]),
    ("Dorrian HVAC", "C-105 · preflight", [("QuickBooks", "migrating · 6:04 AM", "ok"), ("FieldEdge", "via QuickBooks", "bridge"), ("Plaid", "login needed · 3 days", "err"),
                                          ("Ramp", "entity · 7:40 AM", "ok"), ("Not set", "", "none"), ("ap+dorrian@", "forwarding", "ok")]),
    ("Heritage Interiors", "C-101 · map", [("QuickBooks", "migrating · 6:01 AM", "ok"), ("RFMS", "key rejected 7:02 AM", "err"), ("Plaid", "3 accounts · 6:00 AM", "ok"),
                                          ("Ramp", "entity · 7:40 AM", "ok"), ("QuickBooks Time", "installers · 6:10 AM", "ok"), ("Gmail", "AP label · backfilled", "ok")]),
    ("AIM Kitchen &amp; Bath", "C-111 · live, shadow", [("QuickBooks", "bridge transport only", "bridge"), ("Buildertrend", "via QuickBooks", "bridge"), ("Plaid", "1 account · 6:00 AM", "ok"),
                                                 ("Ramp", "entity · 7:40 AM", "ok"), ("Not set", "", "none"), ("ap+aim@", "38 bills in Sep", "ok")]),
    ("Iowa Custom Cabinets", "C-108 · map", [("QuickBooks", "migrating · 6:00 AM", "ok"), ("Innergy", "file · 2 of 3 in", "file"), ("Plaid", "2 accounts · 6:00 AM", "ok"),
                                            ("Ramp", "entity · 7:40 AM", "ok"), ("Not set", "", "none"), ("ap+icc@", "forwarding", "ok")]),
    ("Clive Power Equipment", "C-102 · connect", [("Sage Intacct", "cancelled · files only", "warn"), ("c-Systems", "GL export · weekly", "file"), ("Plaid", "1 account · 6:00 AM", "ok"),
                                                 ("Ramp", "entity · 7:40 AM", "ok"), ("Not set", "", "none"), ("ap+clive@", "forwarding", "ok")]),
    ("Merit Fund III", "C-113 · live", [("QuickBooks", "archived Oct 9", "arch"), ("None", "fund, no field system", "none"), ("Plaid", "1 account · 6:00 AM", "ok"),
                                       ("None", "", "none"), ("None", "", "none"), ("ap+fund3@", "forwarding", "ok")]),
]
KIND = {"ok": ("ready", ""), "err": ("overdue", " is-err"), "bridge": ("soft", " is-bridge"), "file": ("track", ""), "arch": ("closed", " is-arch"), "none": ("", " is-none"), "warn": ("risk", ""), "pend": ("risk", "")}


def cellx(name, sub, kind):
    pk, cls = KIND[kind]
    pip = f'<i class="pip pip--{pk}" aria-hidden="true"></i>' if pk else ""
    word = {"ok": "connected", "err": "error", "bridge": "bridge, temporary", "file": "file drop", "arch": "archived", "none": "not connected", "warn": "source cancelled", "pend": "pending"}[kind]
    return f'<div class="cellx{cls}"><span class="t">{pip}{name}<span class="sr">, {word}</span></span><span class="s">{sub or "&nbsp;"}</span></div>'


def matrix():
    head = "<tr><th>Client</th>" + "".join(f"<th>{c}</th>" for c in COLS) + "</tr>"
    ten = ('<tr class="ten"><td><span class="l1">Merit Management Group</span><span class="l2">tenant-wide</span></td>'
           + "".join(f"<td>{cellx(*c)}</td>" for c in [("Not applicable", "per client", "none"), ("Not applicable", "per client", "none"), ("Plaid", "1 production app", "ok"),
                                                         ("Ramp", "1 business · 14 entities", "ok"), ("Not chosen", "provider pending", "none"), ("Microsoft 365", "credentials pending", "pend")]) + "</tr>")
    body = ten
    for name, sub, cells in M:
        attn = " is-attn" if any(k == "err" for *_, k in cells) else ""
        body += f'<tr class="q-row{attn}" tabindex="0"><td><span class="l1">{name}</span><span class="l2">{sub}</span></td>' + "".join(f"<td>{cellx(*c)}</td>" for c in cells) + "</tr>"
    body += '<tr class="q-group"><td colspan="7"><span class="t-cap">7 more clients in Plan or Connect · 9 connections planned · <button class="btn btn--quiet" type="button" style="height:32px">Show all 14</button></span></td></tr>'
    return (f'<div class="mx"><table class="tbl tbl-q tbl-q--flush" aria-label="Connections by client and role"><colgroup><col style="width:200px">{"<col>" * 6}</colgroup>'
            f'<thead>{head}</thead><tbody>{body}</tbody></table></div>')


def strip():
    f = [("Connections", "31", "26 healthy · 2 errors · 3 bridges"), ("In today", "4,812", "records · vs 4,106 last Monday"),
         ("Open errors", "7", "5 need a person · 1 retrying · 1 with MeritBooks"), ("Oldest error", "3 days", "Dorrian’s bank login"), ("Bridges", "3", "temporary · reviewed every 30 days")]
    return '<div class="hstrip">' + "".join(f'<div class="fig"><span class="fig-l">{a}</span><span class="fig-v fig-v--dense">{b}</span><span class="fig-vs"><span>{c}</span></span></div>' for a, b, c in f) + "</div>"


ERRS = [
    ("Needs a person", "Heartland · simPRO", "Period closed for Heartland, September 2026", "Invoice 31902, dated Sep 29, arrived Oct 18. Post it to October or reopen September.", "Post to October", True),
    ("Needs a person", "Dorrian · Plaid", "Farmers State needs Dorrian’s owner to sign in again", "No bank transactions since Oct 16. The close for Dorrian is blocked on it.", "Ask the owner", False),
    ("Needs a person", "Heritage · RFMS", "RFMS rejected Heritage’s API key", "Usually the RFMS API tier changed. Re-enter the key or ask Heritage’s RFMS admin.", "Re-enter key", False),
    ("Needs a person", "AIM · Buildertrend via QuickBooks", "Vendor “Masterbrand Cabinets Inc” isn’t linked", "Looks like Masterbrand Cabinets (94). Link it and the 2 waiting bills post.", "Link vendor", False),
    ("Needs a person", "Ramp · tenant", "3 card charges coded to a retired department", "“Showroom” was merged into Residential retail on Oct 16.", "Re-code 3", False),
    ("Retrying", "Heartland · simPRO", "simPRO asked us to slow down", "Retrying at 7:46 AM, attempt 2 of 5. Nothing to do.", "", False),
    ("With MeritBooks", "Clive · c-Systems file", "The Dept column is missing from the Oct 12 export", "Reference ERR-0412. Our team is updating the parser; the file is held, not lost.", "", False),
]


def errors():
    tr = ""
    for cat, where, title, sub, act, sel in ERRS:
        k = {"Needs a person": "blocked", "Retrying": "track", "With MeritBooks": "track"}[cat]
        a = f'<button class="btn{" btn--primary" if sel else ""}" type="button">{act}</button>' if act else f'<span class="t-cap">{cat}</span>'
        tr += (f'<tr class="q-row{" is-cursor" if sel else ""}" tabindex="0"><td><span class="l1">{title}</span><span class="l2">{where} · {sub}</span></td>'
               f'<td>{status(k, cat)}</td><td style="text-align:right">{a}</td></tr>')
    t = (f'<table class="tbl tbl-q tbl-q--flush" aria-label="Integration errors"><colgroup><col><col style="width:148px"><col style="width:168px"></colgroup>'
         f'<thead><tr><th>What happened</th><th>Kind</th><th style="text-align:right">Fix</th></tr></thead><tbody>{tr}</tbody></table>')
    left = (f'<section class="card" aria-labelledby="h-eq"><div class="card-h"><h3 id="h-eq">Error queue</h3><span class="t-cap">7 open · plain English, with the fix</span>'
            f'<span style="flex:1"></span><div class="seg" role="group" aria-label="Filter"><button type="button" aria-pressed="true">All<span class="n">7</span></button><button type="button" aria-pressed="false">Needs a person<span class="n">5</span></button></div></div>{t}</section>')
    note = f"""<article class="note note--panel">
<div class="note-kind">Heartland · simPRO · invoice 31902</div>
<div class="note-title">Arrived after September was closed</div>
<p>simPRO dated the invoice Sep 29. Heartland’s September is soft-closed, so MeritBooks held it instead of re-dating it. Nothing posted.</p>
<ul class="ev"><li><span>Waukee Schools · service agreement</span><span class="dl"></span><span class="v">2,480.00</span></li>
<li><span>Sales tax</span><span class="dl"></span><span class="v">148.80</span></li>
<li class="ev-total"><span>Invoice total</span><span class="dl"></span><span class="v">2,628.80</span></li></ul>
<div class="basis"><span>Received <b>Oct 18, 2:14 PM · webhook</b></span><span>Stored payload <b>kept for replay</b></span></div>
</article>"""
    right = (f'<aside class="card" aria-label="Selected error"><div class="panel-sec" style="padding:16px">{note}</div>'
             f'<div class="panel-sec" style="padding:0 16px 16px"><div style="display:grid;gap:0">'
             f'<label class="radio"><input type="radio" name="pe" checked><i></i>Post to October 1 with a note</label>'
             f'<label class="radio"><input type="radio" name="pe"><i></i>Ask Priya to reopen September</label>'
             f'<label class="radio"><input type="radio" name="pe"><i></i>Ignore, with a reason</label></div>'
             f'<p class="t-cap" style="margin-top:8px">Replay runs the stored invoice through mapping and posting again without calling simPRO. Ignoring is logged.</p></div>'
             f'<div class="panel-foot"><button class="btn btn--quiet" type="button">{ico("link")}Open in simPRO</button><span class="sp"></span><button class="btn btn--primary" type="button">{ico("retry")}Replay to October</button></div></aside>')
    return f'<div class="eq">{left}{right}</div>'


def frame_a():
    tabs = ('<div class="tabs" role="tablist" aria-label="Integrations"><button class="tab" role="tab" type="button" aria-selected="true">Connected <span class="n">31</span></button>'
            '<button class="tab" role="tab" type="button" aria-selected="false">Errors <span class="n">7</span></button><button class="tab" role="tab" type="button" aria-selected="false">Catalog <span class="n">48</span></button>'
            '<button class="tab" role="tab" type="button" aria-selected="false">Ramp</button><button class="tab" role="tab" type="button" aria-selected="false">Bridges <span class="n">3</span></button></div>')
    main = (ctxline(["Mon Oct 19", "31 connections", '<b class="neg">2 errors · oldest 3 days</b>', "3 bridges, temporary", "Ramp synced 7:40 AM"], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Settings<span class="sl">//</span>Integrations</div><h1 class="t-title" style="margin-top:8px">Connected systems</h1></div>'
              f'<div class="btn-row"><button class="btn" type="button">{ico("plus")}Connect a system</button></div></div>'
            + tabs + '<div style="height:16px"></div>' + strip() + matrix() + errors() + '</div>')
    a = app("workspace", "density-cockpit", rail_manager("Integrations"), bar(ctx_workspace(), "Integrations", "Jump to client, system, error…", "Synced 7:42 AM"), main)
    return a.replace('class="app ', 'data-live class="app ', 1)


CAT = [
    ("Field service &amp; construction", "Stay connected after go-live as feeds of jobs, invoices and costs", [
        ("simPRO", "Field service", "live", "OAuth app in the client’s build. Webhooks.", "", "Heartland", "Connect"),
        ("RFMS", "Flooring ERP", "live", "API key on the client’s RFMS plan, Standard or higher.", "Polls hourly; RFMS has no webhooks", "Heritage", "Connect"),
        ("ServiceTitan", "Field service", "partner", "File drop of jobs and invoices for now.", "Connect through Agave, a certified ServiceTitan app", "", "Export &amp; drop"),
        ("Buildertrend", "Construction", "bridge", "Through the client’s QuickBooks sync, read daily.", "Direct when Buildertrend grants partner access", "AIM, Revived", "Set up bridge"),
        ("Innergy", "Millwork ERP", "file", "WIP, AR and AP exports. Bridge also offered.", "Partner access requested Oct 6", "Iowa Custom Cabinets", "Export &amp; drop"),
        ("c-Systems Infinity", "Equipment dealer", "file", "GL journal export from Infinity, weekly.", "Asked c-Systems about an API", "Clive", "Export &amp; drop"),
        ("FieldEdge", "Field service", "bridge", "Through the client’s QuickBooks sync.", "Partner request filed", "Dorrian", "Set up bridge"),
        ("Jobber, Housecall Pro, JobTread, Procore +8", "Field &amp; construction", "request", "Any CSV through the column mapper today.", "Ask and we’ll tell you when", "", "Request"),
    ]),
    ("Old ledgers", "One-time sources. Read, tied out, archived, then disconnected at the certificate", [
        ("QuickBooks Online", "Ledger", "live", "One sign-in per company. Read-only.", "", "11 clients", "Connect"),
        ("Sage Intacct", "Ledger", "file", "Trial balances, GL detail and agings as exports.", "API with the client’s developer license", "Clive", "Export &amp; drop"),
        ("QuickBooks Desktop · Sage 50 / 100", "Ledger", "file", "Guided export, one recipe per product.", "", "", "Export &amp; drop"),
        ("Xero · NetSuite", "Ledger", "request", "Guided export today.", "Ask and we’ll tell you when", "", "Request"),
    ]),
    ("Bank, cards &amp; payments", "Ongoing", [
        ("Plaid", "Bank feeds", "live", "Every client bank, one production app.", "", "12 clients", "Connect"),
        ("Ramp", "Cards, bills, reimbursements", "live", "One accounting connection for the Ramp business.", "", "Tenant · 14 entities", "Manage"),
        ("Stripe", "Card and ACH payments", "live", "Invoice payments and payouts.", "", "Tenant", "Manage"),
        ("Bank statement files", "OFX, QFX, CSV, BAI2", "file", "For accounts Plaid can’t reach.", "", "", "Drop a file"),
    ]),
]


def catalog():
    out = ""
    for g, gsub, items in CAT:
        cards = ""
        for name, cat, t, today, coming, used, act in items:
            mine = bool(used) and t != "request"
            dl = f'<dl><dt>Today</dt><dd>{today}</dd>' + (f'<dt>Coming</dt><dd>{coming}</dd>' if coming else "") + (f'<dt>Used by</dt><dd>{used}</dd>' if used else "") + "</dl>"
            temp = '<span class="tag tag--warn">Temporary</span>' if t == "bridge" else ""
            prim = act in ("Connect",) and not used
            cards += (f'<article class="sys{" is-mine" if mine else ""}"><div class="sys-h"><div><span class="t-head">{name}</span><p class="t-cap">{cat}</p></div>{temp}</div>'
                      f'<div class="sys-b">{tier(t)}{dl}</div><div class="sys-f"><span class="sp"></span><button class="btn{" btn--primary" if prim else ""}" type="button">{act}</button></div></article>')
        out += f'<div class="cat-g"><h3>{g}</h3><span class="t-cap">{gsub}</span></div><div class="cat-b">{cards}</div>'
    out += ('<div class="cat-g"><h3>Not listed?</h3></div><div class="cat-b"><article class="sys is-ask"><div class="sys-h"><span class="t-head">My system isn’t here</span></div>'
            '<div class="sys-b"><p class="ink-2">Tell us what it is and which client uses it. You can drop its exports today; we count every request when deciding what to build next.</p></div>'
            f'<div class="sys-f"><span class="sp"></span><button class="btn" type="button">Request a system</button></div></article>'
            '<article class="sys is-ask"><div class="sys-h"><span class="t-head">Payroll</span></div><div class="sys-b"><p class="ink-2">Register files today for every provider. The ongoing payroll connection waits on the provider choice, Check or Gusto.</p></div>'
            '<div class="sys-f"><span class="sp"></span><button class="btn" type="button">Drop a register</button></div></article></div>')
    LEG = [("live", "connects in a click"), ("partner", "the vendor gates its API; file drop meanwhile"), ("bridge", "read through the client’s own QuickBooks"),
           ("file", "export and drop; the parser recognizes it"), ("request", "CSV through the column mapper today")]
    leg = '<div class="cat-b" style="grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">' + "".join(f'<div>{tier(k)}<p class="t-cap" style="margin-top:2px">{c}</p></div>' for k, c in LEG) + "</div>"
    main = (ctxline(["Mon Oct 19", "Catalog", "48 systems", "every one has a path today"], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Settings<span class="sl">//</span>Integrations<span class="sl">//</span>Catalog</div><h1 class="t-title" style="margin-top:8px">Every system has a way in</h1></div>'
              f'<label class="search" style="width:280px">{ico("search")}<input type="search" placeholder="Find a system" aria-label="Find a system"></label></div>'
            + leg + out + '</div>')
    return app("workspace", "density-cockpit", rail_manager("Integrations"), bar(ctx_workspace(), "Integrations · Catalog", "Jump to client, system, error…", "Synced 7:42 AM"), main)


def ramp():
    ents = [("Heartland Heating &amp; Cooling", "Heartland HVAC", "14", "ok"), ("Dorrian HVAC", "Dorrian", "6", "ok"), ("Heritage Interiors", "Heritage", "9", "ok"),
            ("AIM Kitchen &amp; Bath", "AIM K&amp;B", "8", "ok"), ("Iowa Custom Cabinets", "ICC", "5", "ok"), ("Clive Power Equipment", "Clive Power", "4", "ok"),
            ("Merit Management Group LLC", "MMG", "11", "ok"), ("Swan Creek", "Swan Creek LLC", "2", "warn")]
    tr = ""
    for c, r, cards, k in ents:
        st = status("ready", "Mapped") if k == "ok" else status("risk", "Pick a client")
        tr += f'<tr class="q-row{" is-attn" if k == "warn" else ""}"><td><span class="l1">{r}</span></td><td>{c if k == "ok" else "<span class=ink-3>—</span>"}</td><td class="n">{cards}</td><td style="text-align:right">{st}</td></tr>'
    tr += '<tr class="q-group"><td colspan="4"><span class="t-cap">6 more entities · 4 mapped, 2 waiting for the client to exist</span></td></tr>'
    t = (f'<table class="tbl tbl-q tbl-q--flush" aria-label="Ramp entities to MeritBooks clients"><colgroup><col style="width:168px"><col><col style="width:72px"><col style="width:136px"></colgroup>'
         f'<thead><tr><th>Ramp entity</th><th>MeritBooks client</th><th class="n">Cards</th><th style="text-align:right">Status</th></tr></thead><tbody>{tr}</tbody></table>')
    left = (f'<section class="card" aria-labelledby="h-ent"><div class="card-h"><h3 id="h-ent">Entities → clients</h3><span class="t-cap">one Ramp business, 14 entities</span></div>{t}</section>')
    push = [("Chart of accounts, per client", "pushed Oct 16 · 251 to 412 per client"), ("Departments and jobs as Ramp fields", "pushed 7:40 AM · 61 jobs"), ("Approved vendors", "pushed 7:40 AM · 1,208")]
    pull = [("Card transactions ready to sync", "212 today"), ("Bills and bill payments", "18 today"), ("Reimbursements", "6 today")]
    ph = "".join(f'<li><span class="who"><span class="l1">{a}</span><span class="l2">{b}</span></span>{status("ready", "OK")}</li>' for a, b in push)
    pl = "".join(f'<li><span class="who"><span class="l1">{a}</span><span class="l2">{b}</span></span>{status("ready", "OK")}</li>' for a, b in pull)
    right = (f'<aside><section class="card"><div class="card-h"><h3>MeritBooks sends to Ramp</h3></div><ul class="dir" style="padding:0">{ph}</ul></section>'
             f'<section class="card" style="margin-top:16px"><div class="card-h"><h3>Ramp sends to MeritBooks</h3></div><ul class="dir" style="padding:0">{pl}</ul>'
             f'<div class="card-f"><span>Each one is acknowledged back to Ramp, with the reason when it can’t post.</span></div></section>'
             f'<div class="inline-notice inline-notice--warn" style="margin-top:16px"><span>{ico("alert")}</span><span><b>Don’t press Export in Ramp, and don’t connect Ramp to QuickBooks.</b> MeritBooks syncs every charge; a manual export or a second accounting connection would post it twice.</span></div></aside>')
    main = (ctxline(["Mon Oct 19", "Ramp", "<b>Connected · synced 7:40 AM</b>", "212 charges today", "1 entity to map"], '<span class="tag" style="margin-right:12px">Sample data</span>')
            + '<div class="page"><div class="page-head"><div><div class="eyebrow">Settings<span class="sl">//</span>Integrations<span class="sl">//</span>Card spend</div><h1 class="t-title" style="margin-top:8px">Ramp accounting connection</h1></div>'
              f'<div class="btn-row">{tier("live")}<span class="prov">Read and write accounting scopes · connected by Jordan Smith, Oct 2</span><button class="btn btn--quiet" type="button">Disconnect</button></div></div>'
            + f'<div class="ramp">{left}{right}</div></div>')
    return app("workspace", "density-cockpit", rail_manager("Integrations"), bar(ctx_workspace(), "Integrations · Ramp", "Jump to client, system, error…", "Ramp synced 7:40 AM"), main)


def build():
    body = (board_h("S18<span class=\"sl\">//</span>IA-SPEC §8 · 07-INTEGRATIONS", "Every system, every client, honestly",
                    "One place for the tenant and each client: what’s connected and how healthy it is, the errors in plain English with the fix and a replay, a catalog that never claims a connection the product can’t make, "
                    "and the Ramp accounting connection that replaces Ramp-to-QuickBooks.",
                    '<span class="tag">Sample data</span> S18')
            + frame(frame_a(), "S18.1 · Connected, by client and role. Two errors, three bridges. The selected error replays without calling the vendor.")
            + anno([("Clients × roles", "Ledger source, field system, bank, card spend, payroll, AP inbox. Each cell is the system and its health; dashed means a temporary bridge or nothing connected."),
                    ("Errors say what to do", "Grouped as needs a person, retrying, or with MeritBooks. A closed period is never silently re-dated; the invoice waits with its fix."),
                    ("Replay, not re-fetch", "Every inbound record is stored, scrubbed of payroll and bank details, so a fix re-runs it through mapping and posting."),
                    ("Tenant-wide systems on top", "Ramp, Plaid, the directory and payroll live at tenant level, so the client rows only show what’s theirs.")])
            + section_h("S18.2 · Catalog", "Phase 1 target statuses; the live catalog renders from the connector registry")
            + frame(catalog(), "S18.2 · The owner’s six named systems first. Each card says how it connects today and what’s coming, never more.")
            + anno([("Five honest statuses", "Live API, Partner pending, Bridge (temporary), File drop, On request. Pip shape and word, so they read without colour."),
                    ("Today and coming", "ServiceTitan shows file drop today and Agave next; Buildertrend shows the bridge and the partner ask. When access lands, the button changes and nothing else."),
                    ("Old ledgers leave", "QuickBooks, Sage and the rest are labelled one-time: read, tied out, archived and disconnected at the certificate."),
                    ("Nothing dead-ends", "“My system isn’t here” takes a request and points to drop-and-map today. Payroll waits on the provider choice and says so.")])
            + section_h("S18.3 · Ramp accounting connection", "Tenant level, one Ramp business, entities mapped to clients")
            + frame(ramp(), "S18.3 · MeritBooks pushes the chart, departments, jobs and vendors; Ramp sends charges, bills and reimbursements back.")
            + anno([("One connection, many clients", "Each Ramp entity maps to a MeritBooks client. An unmapped entity is held, not posted to the wrong books."),
                    ("Both directions, listed", "What MeritBooks sends and what Ramp sends, with the last time each ran and how many."),
                    ("The two mistakes, named", "Don’t press Export in Ramp; don’t connect Ramp to QuickBooks. Both would double-post, so the screen says it in words."),
                    ("Acknowledged", "Every synced item is confirmed back to Ramp, including the reason when one can’t post, such as a closed period.")]))
    return page("S18 · Integrations hub", CSS, body, "S18-integrations-hub.html")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S18-integrations-hub.html")
    open(out, "w").write(build())
    print(out)
