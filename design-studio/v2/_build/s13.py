"""S13 · Role library (05 §6.1 A1) + template updates (§1.7, §6.10)."""
from acc_common import *

CSS = """
.lib{padding:24px 32px 32px;height:calc(100% - 32px);overflow:auto}
.lib-tabs{display:flex;align-items:flex-end;gap:24px;border-bottom:1px solid var(--line)}
.lib-tabs .tabs{border-bottom:0}
.lib-tabs .sp{flex:1}
.lib-tabs .btn{margin-bottom:4px}
.filters{display:flex;align-items:center;gap:8px 12px;margin:16px 0 0;flex-wrap:wrap}
.filters .search{width:240px;flex:none}
.filters .select{width:auto;flex:none}
.filters .check{white-space:nowrap}
.rl-t{margin-top:12px}
.rl-t td{height:52px}
.rl-t tr.q-group td{height:40px}
.rl-t .more-row td{height:40px;color:var(--ink-2)}
.rl-t .exc{font-weight:600;color:var(--warn)}
.rl-t .none{color:var(--ink-3)}
.rl-t .dot{display:inline-block;width:6px;height:6px;background:var(--electric);margin-right:6px;vertical-align:1px}
.rl-t td.chk{padding-right:0}
.rowmenu{position:absolute;right:56px;width:240px}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:40px 24px;border:1px dashed var(--grey-400);background:var(--white)}
.upd{margin-top:16px;background:var(--white);border:1px solid var(--line)}
.upd+.upd{margin-top:16px}
.upd-h{display:flex;align-items:flex-start;gap:16px;padding:16px 24px;border-bottom:1px solid var(--line)}
.upd-h .t-head{display:flex;align-items:center;gap:8px}
.upd-b{display:grid;grid-template-columns:minmax(0,1fr) 340px}
.upd-b>div{padding:16px 24px}
.upd-b>aside{padding:16px 24px;background:var(--canvas);border-left:1px solid var(--line)}
.cl{list-style:none}
.cl li{display:grid;grid-template-columns:24px 112px minmax(0,1fr);gap:12px;align-items:start;padding:12px 0;border-bottom:1px solid var(--line)}
.cl li:first-child{padding-top:0}
.cl .tag{justify-self:start}
.cl p{color:var(--ink-2);margin-top:2px}
.cl .check{min-height:20px}
.upd-f{display:flex;align-items:center;gap:8px;padding:12px 24px;border-top:1px solid var(--line);background:var(--canvas)}
.upd-f .sp{flex:1}
.w3{table-layout:fixed;margin-top:4px}
.w3 th{font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left;padding:0 0 8px;border-bottom:1px solid var(--electric)}
.w3 td{height:36px;border-bottom:1px solid var(--line);white-space:nowrap}
.dlgwrap{height:100%;background:rgba(10,22,40,.48);display:flex;justify-content:center;align-items:flex-start;padding-top:40px}
.nr{width:760px}
.starts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tpl-list{list-style:none;margin-top:8px;border:1px solid var(--line);max-height:280px;overflow:auto}
.tpl-list li{display:grid;grid-template-columns:16px 168px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:44px;padding:4px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.tpl-list li:hover{background:var(--grey-100)}
.tpl-list li[aria-selected=true]{background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.tpl-list .rb{width:16px;height:16px;border:1.5px solid var(--grey-400);border-radius:50%}
.tpl-list li[aria-selected=true] .rb{border:5px solid var(--electric)}
.tpl-list .d{color:var(--ink-2);font-size:12px;line-height:16px}
.nr-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.smalls{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:32px}
.smalls h3{margin-bottom:12px}
"""

STD = [
 ("Tenant admin", "Access, settings and billing", "Standard", "Internal", "1 person", "All clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Owner", "Decisions and approvals, not data entry", "Standard · modified", "Internal", "1 person", "All clients", "v2 · Aug 9", "Mike Heilman", 0, "Active", ""),
 ("CFO", "Final release and hard close", "Standard", "Internal", "1 person", "All clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Controller", "Close, recs, posting, approvals ≤ $250k", "Standard · modified", "Internal", "1 person", "All clients", "v3 · Sep 18", "Mike Heilman", 1, "Active", ""),
 ("Accounting manager", "Runs the close, delegates client access", "Standard · modified", "Internal", "3 people", "13 clients", "v5 · Oct 2", "Mike Heilman", 3, "Active", "Update · v5"),
 ("Bookkeeper", "Codes, reconciles and prepares the close", "Standard", "Internal", "6 people", "13 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", "Update · v6"),
 ("Check processor", "Queues, prints and files pay runs", "Standard", "Internal", "1 person", "13 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("HR / payroll", "Payroll runs, register, employees", "Standard · modified", "Internal", "1 person", "3 clients", "v2 · Sep 2", "Mike Heilman", 0, "Active", ""),
 ("External auditor", "Read, export, auditor requests · ≤ 120 days", "Standard", "External", "2 people", "2 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Client contact", "Answers requests, uploads documents", "Standard", "External", "9 people", "7 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Employee / cardholder", "Own card charges and receipts only", "Standard", "Client staff", "41 people", "6 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Lender viewer", "Delivered packs and certificates", "Standard", "External", "3 people", "2 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
 ("Client admin", "Manages a client’s own staff", "Standard", "Client staff", "2 people", "2 clients", "v1 · Aug 1", "MeritBooks", 0, "Active", ""),
]
UNHELD = ["Finance director", "AP clerk", "AR clerk", "Data entry", "Department head", "View-only"]
CUSTOM = [
 ("Senior bookkeeper", "Bookkeeper + rec sign-off, posts ≤ $10k", "Custom", "Internal", "2 people", "5 clients", "v3 · Sep 22", "Jordan Smith", 0, "Active", "", "from Bookkeeper v5"),
 ("Lender package preparer", "Builds the HVAC lender pack", "Custom", "Internal", "1 person", "1 group", "v1 · Sep 9", "Mike Heilman", 0, "Active", "", "started empty"),
 ("Year-end reviewer", "Reviews year-end entries, no posting", "Custom", "Internal", "No holders", "", "Not published", "Draft by Erin Vance", 0, "Draft", "", "from Controller v3"),
]
CLIENT = [
 ("Office manager", "Approves bills ≤ $2,500, chases receipts", "Heritage Interiors", "1 person", "v2 · Oct 9", "Lauren Pierce", "Pending", "v3 at Merit"),
 ("Field supervisor", "Approves crew expenses ≤ $500", "Heritage Interiors", "2 people", "v1 · Sep 30", "Lauren Pierce", "Active", ""),
 ("Owner’s assistant", "Answers requests, uploads documents", "Crystal Kitchen & Bath", "1 person", "v1 · Oct 1", "Dave Novak", "Active", ""),
]


AUD={'Internal':'Internal staff','Client staff':'Client staff','External':'External'}

def status(st, upd):
    pip = {"Active": "pip--ready", "Draft": "pip--track", "Pending": "pip--risk"}[st]
    l2 = f'<span class="l2 blue"><span class="dot" aria-hidden="true"></span>{upd}</span>' if upd else ""
    return f'<td><span class="status status--{"ready" if st=="Active" else ("risk" if st=="Pending" else "track")}" style="font-weight:500"><i class="pip {pip}" aria-hidden="true"></i>{st}</span>{l2}</td>'


def row(name, desc, lvl, lvl2, kind, aud, h1, h2, pub, by, exc, st, upd, key, holders=True):
    exc_h = f'<span class="exc">{exc}</span>' if exc else '<span class="none">—</span>'
    hold = (f'<a class="l1 link" href="#" style="display:block">{h1}</a><span class="l2">{h2}</span>' if holders and h1 != "No holders"
            else f'<span class="l1 ink-3" style="color:var(--ink-3)">{h1}</span>')
    return (f'<tr class="q-row" data-lvl="{key}" data-kind="{kind}" data-aud="{aud}" data-held="{1 if h1!="No holders" else 0}" data-exc="{exc}" data-name="{E(name.lower())}">'
            f'<td class="chk"><label class="check"><input type="checkbox" aria-label="Select {E(name)}"><i></i></label></td>'
            f'<td><a class="l1" href="#">{E(name)}</a><span class="l2">{E(desc)}</span></td>'
            f'<td>{lvl}<span class="l2">{lvl2}</span></td>'
            f'<td><span class="l1">{kind}</span><span class="l2">{AUD[aud]}</span></td><td>{hold}</td>'
            f'<td><span class="l1 tnum">{pub}</span><span class="l2">{by}</span></td><td class="n">{exc_h}</td>{status(st, upd)}'
            f'<td><button class="btn btn--quiet btn--icon" type="button" aria-label="More actions for {E(name)}" data-menu>⋯</button></td></tr>')


def library_frame():
    T = '<span class="lvl lvl--tenant">Tenant</span>'
    rows = [f'<tr class="q-group"><td colspan="9"><span class="q-group-t">Standard roles</span><span class="tnum b">19</span><span class="t-cap" style="margin-left:12px">Cloned from MeritBooks templates when Merit joined. Edits never flow down by themselves.</span></td></tr>']
    for r in STD:
        rows.append(row(r[0], r[1], T, "from platform " + ("v1" if r[0] != "Accounting manager" else "v4"), r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], "tenant"))
    rows.append(f'<tr class="more-row" data-lvl="tenant"><td></td><td colspan="8"><button class="btn btn--quiet" type="button" id="show-unheld" aria-expanded="false" style="margin-left:-12px">Show 6 standard roles with no holders</button><span class="t-cap">{" · ".join(UNHELD)}</span></td></tr>')
    rows.append('<tr class="q-group"><td colspan="9"><span class="q-group-t">Custom roles</span><span class="tnum b">3</span></td></tr>')
    for r in CUSTOM:
        rows.append(row(r[0], r[1], T, r[11], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], "tenant"))
    rows.append('<tr class="q-group"><td colspan="9"><span class="q-group-t">Client roles</span><span class="tnum b">3</span><span class="t-cap" style="margin-left:12px">Made by a client’s admin, inside the envelope you set for that client.</span></td></tr>')
    for r in CLIENT:
        rows.append(row(r[0], r[1], '<span class="lvl lvl--client">Client</span>', r[2], "Custom", "Client staff", r[3], "1 client", r[4], r[5], 0, r[6], r[7], "client"))
    table = (f'<table class="tbl tbl-q rl-t" id="rl"><colgroup><col style="width:48px"><col><col style="width:168px"><col style="width:144px">'
             f'<col style="width:104px"><col style="width:120px"><col style="width:104px"><col style="width:112px"><col style="width:64px"></colgroup>'
             f'<thead><tr><th></th><th>Role</th><th>Owned by</th><th>Kind · audience</th><th>Holders</th><th>Last published</th><th class="n">Exceptions</th><th>Status</th><th></th></tr></thead>'
             f'<tbody>{"".join(rows)}</tbody></table>')
    menu = (f'<div class="popover rowmenu" id="rowmenu" role="menu" hidden><ul class="popover-list"><li class="popover-item" role="menuitem">{ico("right")}Open</li>'
            f'<li class="popover-item" role="menuitem">{ico("copy")}Clone</li><li class="popover-item" role="menuitem">{ico("cols")}Compare with…</li>'
            f'<li class="popover-item" role="menuitem" aria-disabled="true" style="color:var(--ink-3)">{ico("lock")}<span><span class="l1" style="color:var(--ink-2)">Archive</span><span class="l2" id="arch-why">Has 3 holders. Move them first.</span></span></li></ul></div>')
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access & roles")}
{bar_workspace('Settings<span class="sl">//</span><b>Access &amp; roles</b>')}
<main class="main"><div class="ctxline"><span>25 roles</span><span class="sl">//</span><span>7 permission sets</span><span class="sl">//</span><span>2 client envelopes</span><span class="sl">//</span><b>2 template updates waiting</b><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("log")}Access log</button><button class="btn btn--quiet" type="button">{ico("download")}Export who-can-do-what</button></div>
<div class="lib" style="position:relative">
<div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Settings<span class="sl">//</span>Access &amp; roles</div><h1 class="t-title" style="margin-top:4px">Roles</h1></div>
<div class="btn-row"><button class="btn" type="button" id="cmp" hidden>{ico("cols")}Compare <span class="n" id="cmp-n">2</span></button><button class="btn btn--primary" type="button">{ico("plus")}New role</button></div></div>
<div class="lib-tabs"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">Roles<span class="n tnum">25</span></button><button class="tab" role="tab" aria-selected="false">Permission sets<span class="n tnum">7</span></button><button class="tab" role="tab" aria-selected="false">Envelopes<span class="n tnum">2</span></button><button class="tab" role="tab" aria-selected="false">Templates<span class="n tnum">21</span></button><button class="tab" role="tab" aria-selected="false">Updates<span class="n tnum">2</span></button></div><span class="sp"></span><a class="link" href="#" style="margin-bottom:12px">Duties policy</a></div>
<div class="inline-notice inline-notice--info" style="margin-top:16px;align-items:center">{ico("info")}<div><b>MeritBooks updated two templates on Oct 14.</b> Accounting manager and Bookkeeper are based on them. Nothing changes until you adopt.</div><span class="sp"></span><button class="btn" type="button">Review updates</button></div>
<div class="filters"><label class="search">{ico("search")}<input id="q" placeholder="Search roles" aria-label="Search roles"></label>
<div class="seg" role="group" aria-label="Owned by"><button type="button" aria-pressed="true" data-l="">All<span class="n">25</span></button><button type="button" aria-pressed="false" data-l="tenant">Tenant<span class="n">22</span></button><button type="button" aria-pressed="false" data-l="client">Client<span class="n">3</span></button></div>
<select class="select" id="f-kind" aria-label="Kind"><option value="">Any kind</option><option>Standard</option><option>Standard · modified</option><option>Custom</option></select>
<select class="select" id="f-aud" aria-label="Audience"><option value="">Any audience</option><option>Internal</option><option>Client staff</option><option>External</option></select>
<label class="check"><input type="checkbox" id="f-held"><i></i>Has holders</label><label class="check"><input type="checkbox" id="f-exc"><i></i>Has exceptions</label><label class="check"><input type="checkbox" id="f-unused"><i></i>Unused 90 days</label></div>
{table}
<div class="empty" id="empty" hidden><span class="wg-empty-mark">{ico("filter")}</span><span class="t-head">No roles match these filters</span><p class="ink-2" id="empty-why">Every role was used in the last 90 days.</p><button class="btn" type="button" id="clear">Clear filters</button></div>
{menu}
</div></main></div>"""


def updates_frame():
    def item(kind, tag, name, cap, why, checked=True, applied=False):
        box = ('<span class="t-cap">Applied</span>' if applied else
               f'<label class="check"><input type="checkbox" {"checked" if checked else ""} aria-label="Pick {E(name.replace("&amp;", "&"))}"><i></i></label>')
        return f'<li>{box}<span class="tag {tag}">{kind}</span><div><span class="l1">{name}</span><span class="l2">{cap}</span><p>{why}</p></div></li>'
    am = (item("Remove", "tag--neg", "Connect bank and card feeds", "Integrations · Connections · Create", "Moved to Tenant admin. Your draft v6 already removes it.")
          + item("Add", "", "Post sales tax", "Tax · Sales tax · Post", "Managers can post the monthly sales-tax entry they already prepare.")
          + item("Split", "tag--solid", "Reconciliation sign-off became Approve and Reopen", "Bank · Reconciliations", "Applied Oct 14. Holders of Approve got both, so nobody’s access changed.", applied=True))
    bk = (item("Add · read only", "tag--pos", "View debt &amp; covenants", "Debt · Loans, Covenants · View", "New in MeritBooks: Debt covenants. Lets bookkeepers see what a covenant needs before they close.")
          + item("Add", "", "Map cards to cardholders", "Cards · Cardholders · View, Edit", "So receipt chases go to the right person.", checked=False)
          + item("Limit", "tag--warn", "Approve expense reports up to $1,000", "Expenses · Expense reports · Approve", "Was unlimited. Bigger reports go to the manager.", checked=False))
    def w3(rows):
        body = "".join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td><td>{d}</td></tr>' for a, b, c, d in rows)
        return (f'<table class="w3"><colgroup><col><col style="width:72px"><col style="width:72px"><col style="width:72px"></colgroup>'
                f'<thead><tr><th>Capability</th><th>Yours</th><th>Was</th><th>New</th></tr></thead><tbody>{body}</tbody></table>')
    on = '<span class="cap cap--sm is-on"><i></i></span>'; off = '<span class="cap cap--sm"><i></i></span>'
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access & roles")}
{bar_workspace('Settings<span class="sl">//</span>Access &amp; roles<span class="sl">//</span><b>Updates</b>')}
<main class="main"><div class="ctxline"><span>Template updates</span><span class="sl">//</span><b id="upd-left">2 waiting</b><span class="sl">//</span><span>Restrictions apply on their own, with notice</span></div>
<div class="lib"><div class="lib-tabs"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="false">Roles<span class="n tnum">25</span></button><button class="tab" role="tab" aria-selected="false">Permission sets<span class="n tnum">7</span></button><button class="tab" role="tab" aria-selected="false">Envelopes<span class="n tnum">2</span></button><button class="tab" role="tab" aria-selected="false">Templates<span class="n tnum">21</span></button><button class="tab" role="tab" aria-selected="true">Updates<span class="n tnum" id="upd-n">2</span></button></div></div>
<section class="upd" id="u1"><div class="upd-h"><div style="flex:1;min-width:0"><span class="t-head">Accounting manager<span class="lvl lvl--platform">Platform template v4 → v5</span></span><span class="t-cap">Oct 14 · your role is Standard · modified, v5 · 3 people hold it · draft v6 open</span></div><a class="link" href="#">Open the role</a></div>
<div class="upd-b"><div><ul class="cl">{am}</ul></div><aside><div class="eyebrow" style="margin-bottom:8px">Three-way</div>{w3([("Connections · Create", on, on, off), ("Sales tax · Post", off, off, on), ("Write-offs · Approve", off, on, on)])}<p class="t-cap" style="margin-top:8px">Write-offs: you removed approve in v3. The template still grants it; adopting won’t put it back.</p></aside></div>
<div class="upd-f"><button class="btn btn--quiet" type="button" data-dismiss>Dismiss</button><span class="sp"></span><span class="t-cap">No read-only additions in this one</span><button class="btn" type="button" data-pick>Adopt 2 picked</button><button class="btn btn--primary" type="button" data-all>Adopt all into draft v6</button></div></section>
<section class="upd" id="u2"><div class="upd-h"><div style="flex:1;min-width:0"><span class="t-head">Bookkeeper<span class="lvl lvl--platform">Platform template v5 → v6</span></span><span class="t-cap">Oct 14 · your role is Standard, v1 · 6 people hold it on 13 clients</span></div><a class="link" href="#">Open the role</a></div>
<div class="upd-b"><div><ul class="cl">{bk}</ul></div><aside><div class="eyebrow" style="margin-bottom:8px">Who it reaches</div><dl class="kv"><dt>People</dt><dd>6</dd><dt>Clients</dt><dd>13</dd><dt>New duty conflicts</dt><dd>None</dd><dt>Pages they’d lose</dt><dd>None</dd></dl><p class="t-cap" style="margin-top:12px">Adopting creates Bookkeeper v2 as a draft. You still review and publish it.</p></aside></div>
<div class="upd-f"><button class="btn btn--quiet" type="button" data-dismiss>Dismiss</button><span class="sp"></span><button class="btn" type="button" data-safe>Adopt safe changes · 1</button><button class="btn" type="button" data-pick>Adopt 1 picked</button><button class="btn btn--primary" type="button" data-all>Adopt all 3</button></div></section>
<div class="wg-state" id="upd-done" hidden style="height:auto;padding:32px 0"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">You’re on the latest templates</span><p>Both drafts are waiting in the builder. Next platform update is announced here and on your home.</p></div>
<div class="inline-notice" style="margin-top:24px">{ico("lock")}<div><b>Applied with notice, Oct 1:</b> vendor bank-detail edits now need a second approver. It’s a platform rule, not a template change, so it reached every role at once.</div></div>
</div></main></div>"""


def new_role_frame():
    tpls = [("Bookkeeper", "Codes, reconciles, prepares the close. No money approval.", "Primary user"),
            ("AP clerk", "Bills in, pay runs prepared.", ""),
            ("AR clerk", "Invoices out, cash applied.", ""),
            ("Check processor", "Queues, prints, files. Never approves or releases.", ""),
            ("Accounting manager", "Runs the close, approves ≤ $25k, delegates access.", ""),
            ("Controller", "Close, recs, posting, approvals ≤ $250k.", ""),
            ("Department head", "Approves own department’s spend ≤ $5k.", ""),
            ("External auditor", "Read, export, auditor requests. 120 days max.", "Locked")]
    lis = "".join(f'<li role="option" aria-selected="{"true" if i==0 else "false"}" tabindex="-1"><span class="rb"></span><span class="l1">{n}</span><span class="d">{d}</span>{f"<span class=tag>{t}</span>" if t else "<span></span>"}</li>' for i, (n, d, t) in enumerate(tpls))
    return f"""<div class="dlgwrap"><div class="dialog nr" role="dialog" aria-modal="true" aria-labelledby="nr-h">
<div class="dialog-head"><div class="eyebrow">Merit Management Group<span class="sl">//</span>Tenant role</div><h3 class="t-section" id="nr-h" style="margin-top:4px">New role</h3></div>
<div class="dialog-body"><div class="starts" role="radiogroup" aria-label="How to start">
<label class="opt-card"><input type="radio" name="start" checked><span class="t-head">From a standard role</span><p>Copies a MeritBooks template. You get “Update available” when it changes.</p></label>
<label class="opt-card"><input type="radio" name="start"><span class="t-head">Copy one of yours</span><p>Starts from any tenant role, including your edits.</p></label>
<label class="opt-card"><input type="radio" name="start"><span class="t-head">Start empty</span><p>No capabilities. You add each one.</p></label></div>
<label class="search" style="margin-top:16px">{ico("search")}<input placeholder="Search 21 templates by job, e.g. approves bills" aria-label="Search templates"></label>
<ul class="tpl-list" role="listbox" aria-label="Templates">{lis}</ul>
<div class="nr-fields"><label class="field"><span class="field-label">Name</span><input class="input" value="Senior bookkeeper — payroll"></label>
<label class="field"><span class="field-label">Audience</span><select class="select"><option selected>Internal staff</option><option>Client staff</option><option>External</option></select><span class="field-help">Sets the ceiling. External roles can never post, release or configure.</span></label></div>
<p class="t-cap" style="margin-top:12px">Client roles are made by a client’s own admin, inside the envelope you set in that client’s People &amp; access.</p></div>
<div class="dialog-foot"><span class="t-cap">Copies 41 grants from Bookkeeper v6 into a draft</span><span class="sp"></span><button class="btn" type="button">Cancel</button><button class="btn btn--primary" type="button">Create draft</button></div></div></div>"""


def smalls_frame():
    return f"""<div class="smalls"><div><h3 class="t-section" style="color:var(--ink)">No matches</h3>
<div class="empty"><span class="wg-empty-mark">{ico("filter")}</span><span class="t-head">No roles match these filters</span><p class="ink-2">Client roles · unused in 90 days. Every client role was used this quarter.</p><button class="btn" type="button">Clear filters</button></div></div>
<div><h3 class="t-section" style="color:var(--ink)">First visit, nothing customized</h3>
<div class="empty"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">19 standard roles, ready to assign</span><p class="ink-2">They were copied from MeritBooks templates when Merit Management Group was set up. Assign them as they are, or clone one to tailor it.</p><div class="btn-row"><button class="btn btn--primary" type="button">Assign a role</button><button class="btn" type="button">New role</button></div></div></div></div>"""


JS = r"""<script>
(function(){
  var t=document.getElementById('rl'),q=document.getElementById('q'),lvl='';
  var unheld=false;
  function apply(){
    var s=q.value.trim().toLowerCase(),k=document.getElementById('f-kind').value,a=document.getElementById('f-aud').value,
        held=document.getElementById('f-held').checked,exc=document.getElementById('f-exc').checked,unused=document.getElementById('f-unused').checked,n=0;
    t.querySelectorAll('tr.q-row').forEach(function(r){
      var ok=(!s||r.dataset.name.indexOf(s)>-1)&&(!lvl||r.dataset.lvl===lvl)&&(!k||r.dataset.kind===k)&&(!a||r.dataset.aud===a)&&(!held||r.dataset.held==='1')&&(!exc||+r.dataset.exc>0)&&!unused;
      r.hidden=!ok;if(ok)n++;});
    t.querySelectorAll('tr.q-group,tr.more-row').forEach(function(g){var nx=g.nextElementSibling,any=false;while(nx&&!nx.classList.contains('q-group')){if(nx.classList.contains('q-row')&&!nx.hidden)any=true;nx=nx.nextElementSibling}g.hidden=!any&&!g.classList.contains('more-row')?true:(g.classList.contains('more-row')?(!!lvl&&lvl!=='tenant')||!!s||unused:false)});
    document.getElementById('empty').hidden=n>0;t.hidden=n===0;
  }
  q.addEventListener('input',function(){clearTimeout(q._t);q._t=setTimeout(apply,150)});
  ['f-kind','f-aud','f-held','f-exc','f-unused'].forEach(function(id){document.getElementById(id).addEventListener('change',apply)});
  document.querySelectorAll('.seg [data-l]').forEach(function(b){b.onclick=function(){document.querySelectorAll('.seg [data-l]').forEach(function(x){x.setAttribute('aria-pressed','false')});b.setAttribute('aria-pressed','true');lvl=b.dataset.l;apply()}});
  document.getElementById('clear').onclick=function(){q.value='';['f-held','f-exc','f-unused'].forEach(function(i){document.getElementById(i).checked=false});document.getElementById('f-kind').value='';document.getElementById('f-aud').value='';lvl='';document.querySelector('.seg [data-l=""]').click()};
  t.addEventListener('change',function(e){var n=t.querySelectorAll('td.chk input:checked').length,c=document.getElementById('cmp');c.hidden=n<2;document.getElementById('cmp-n').textContent=n;
    var r=e.target.closest('tr');if(r)r.classList.toggle('is-selected',e.target.checked)});
  var menu=document.getElementById('rowmenu');
  t.addEventListener('click',function(e){var b=e.target.closest('[data-menu]');if(!b)return;var r=b.closest('tr');var h=r.querySelector('td:nth-child(5) .l1').textContent;
    document.getElementById('arch-why').textContent=/No holders/.test(h)?'Archive this role':'Has '+h+'. Move them first.';
    menu.style.top=(r.offsetTop+r.offsetHeight+t.offsetTop)+'px';menu.hidden=!menu.hidden;b.setAttribute('aria-expanded',String(!menu.hidden))});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')menu.hidden=true});
  document.getElementById('show-unheld').onclick=function(){unheld=!unheld;this.setAttribute('aria-expanded',String(unheld));this.textContent=unheld?'Hide roles with no holders':'Show 6 standard roles with no holders';
    mbToast(unheld?'Showing 6 roles with no holders':'Hid 6 roles with no holders')};
  /* updates */
  var left=2;
  document.querySelectorAll('.upd').forEach(function(u){u.addEventListener('click',function(e){var b=e.target.closest('[data-all],[data-pick],[data-safe],[data-dismiss]');if(!b)return;
    var name=u.querySelector('.t-head').firstChild.textContent,verb=b.hasAttribute('data-dismiss')?'Dismissed':'Adopted into a draft of';
    u.hidden=true;left--;document.getElementById('upd-n').textContent=left;document.getElementById('upd-left').textContent=left?left+' waiting':'Up to date';
    if(!left)document.getElementById('upd-done').hidden=false;
    mbToast(verb+' '+name,function(){u.hidden=false;left++;document.getElementById('upd-n').textContent=left;document.getElementById('upd-left').textContent=left+' waiting';document.getElementById('upd-done').hidden=true});})});
  document.querySelectorAll('.tpl-list li').forEach(function(li){li.onclick=function(){document.querySelectorAll('.tpl-list li').forEach(function(x){x.setAttribute('aria-selected','false')});li.setAttribute('aria-selected','true')}});
})();
</script>"""


def build():
    h = head("S13 · Role library", CSS)
    b = sheet_top("S13-role-library.html") + '<main id="main" class="sheet">'
    b += board_h("S13", "05-RBAC §6.1 A1 · §1.7 · §6.10", "Every role Merit can hand out, and who holds it",
                 "Mike’s library: the standard roles copied from MeritBooks templates, the custom ones Merit built, and the roles Heritage Interiors and Crystal Kitchen &amp; Bath made for their own staff. Holders, exceptions and template updates sit on each row. Try the filters, the row menu, and selecting two roles.", "S13.1")
    b += frame(library_frame(), 1080, "Roles tab. Owned-by chip says who can edit it: Tenant (Merit) or Client (that client’s admin). Lineage under it shows the platform template.", "Live: search, owned-by, kind, audience, toggles, select 2 → Compare, row menu, clear")
    b += '<div class="anno"><div><b>Three owners, one list</b><p>Platform templates are the source; Merit owns tenant roles; a client owns its client roles. The chip and the line under it say which.</p></div><div><b>Holders are a link</b><p>“3 people · 13 clients” opens the people, so the cost of a change is one click from the role.</p></div><div><b>Updates are a dot, not a takeover</b><p>A blue dot under status means a newer template exists. Nothing changes until someone adopts it.</p></div><div><b>Archive explains itself</b><p>The row menu shows Archive locked with the reason: a role with holders can’t be archived.</p></div></div>'
    b += '<div class="pair-h"><h2 class="t-section">Template updates</h2><span class="t-cap">Adopt all, adopt safe changes, pick, or dismiss. Nothing applies by itself.</span></div>'
    b += frame(updates_frame(), 1020, "Each change is classified: add, remove, limit, split. Splits and renames apply on their own because nobody’s access changes.", "S13.2 · adopt or dismiss both to reach the done state")
    b += '<div class="pair-h"><h2 class="t-section">New role</h2><span class="t-cap">Three ways to start</span></div>'
    b += frame(new_role_frame(), 760, "Template picker reads like job descriptions. Audience is chosen up front because it sets the ceiling.", "S13.3")
    b += '<div class="pair-h"><h2 class="t-section">Empty and first-run</h2></div>'
    b += frame(smalls_frame(), 300, "Empty says why and offers the way out; first-run says what’s already there.", "S13.4")
    b += '</main>'
    return h + b + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S13-role-library.html")
    open(out, "w").write(build()); print("wrote", out, len(build()))
