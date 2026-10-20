"""S13 · Role library (05 §6.1 A1) + template updates (§1.7, §6.10)."""
from acc_common import *

CSS = """
.lib{padding:24px 32px 32px;height:calc(100% - 32px);overflow:auto}
.lib-tabs{display:flex;align-items:flex-end;gap:24px;border-bottom:1px solid var(--line)}
.lib-tabs .tabs{border-bottom:0}
.lib-tabs .sp{flex:1}
.lib-tabs .btn{margin-bottom:4px}
.sugg{display:flex;align-items:center;gap:12px;min-height:48px;margin-top:16px;padding:4px 8px 4px 16px;background:var(--sky);box-shadow:inset 3px 0 var(--electric);color:var(--ink)}
.sugg>.ico{color:var(--electric);flex:none}
.sugg b{font-weight:600}
.sugg .sp{flex:1}
.filters{display:flex;align-items:center;gap:8px 12px;margin:16px 0 0;flex-wrap:wrap}
.filters .search{width:200px;flex:none}
.filters .select{width:auto;flex:none}
.filters .check{white-space:nowrap}
.rl-t{margin-top:12px}
.rl-t td{height:52px}
.rl-t tr.q-group td{height:40px}
.rl-t .more-row td{height:auto;padding-top:4px;padding-bottom:4px;color:var(--ink-2)}
.rl-t .more-in{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rl-t .none{color:var(--ink-3)}
.rl-t .dot{display:inline-block;width:6px;height:6px;background:var(--electric);margin-right:6px;vertical-align:1px}
.rl-t td.chk{padding-right:0}
.rowmenu{position:absolute;right:56px;width:240px}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:40px 24px;border:1px dashed var(--grey-400);background:var(--white)}
.dlgwrap{height:100%;background:rgba(10,22,40,.48);display:flex;justify-content:center;align-items:flex-start;padding-top:40px}
.sgd{width:720px}
.sgl{list-style:none;border-top:1px solid var(--line)}
.sg{display:grid;grid-template-columns:176px minmax(0,1fr) auto;gap:8px 20px;align-items:start;padding:16px 0;border-bottom:1px solid var(--line)}
.sg-b p+p{margin-top:2px}
.sg-a{display:flex;gap:8px}
.sg-done{grid-column:2/4;display:flex;align-items:center;gap:12px;color:var(--ink-2)}
.sg.is-done .sg-a{display:none}
.sg.is-done .sg-b{color:var(--ink-3)}
.sg.is-done .sg-b .t-head{color:var(--ink-2)}
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

# name, description, audience, made-by line, people, clients, last changed, by, change state, extra
# change state: "" · "proposed:<n>" (draft with n changes) · "new" (never published) · "client:<who>" (client asked Merit)
STD = [
 ("Tenant admin", "Access, settings and billing", "Internal", "1 person", "All clients", "Aug 1", "Set up with Merit", "", 0),
 ("Owner", "Decisions and approvals, not data entry", "Internal", "1 person", "All clients", "Aug 9", "Mike Heilman", "", 0),
 ("CFO", "Final release and hard close", "Internal", "1 person", "All clients", "Aug 1", "Set up with Merit", "", 0),
 ("Controller", "Close, recs, posting, approvals ≤ $250k", "Internal", "1 person", "All clients", "Sep 18", "Mike Heilman", "", 0),
 ("Accounting manager", "Runs the close, delegates client access", "Internal", "3 people", "13 clients", "Oct 2", "Mike Heilman", "proposed:4", 1),
 ("Bookkeeper", "Codes, reconciles and prepares the close", "Internal", "6 people", "13 clients", "Aug 1", "Set up with Merit", "", 1),
 ("Check processor", "Queues, prints and files pay runs", "Internal", "1 person", "13 clients", "Aug 1", "Set up with Merit", "", 0),
 ("HR / payroll", "Payroll runs, register, employees", "Internal", "1 person", "3 clients", "Sep 2", "Mike Heilman", "", 0),
 ("External auditor", "Read, export, auditor requests · ≤ 120 days", "External", "2 people", "2 clients", "Aug 1", "Set up with Merit", "", 0),
 ("Client contact", "Answers requests, uploads documents", "External", "9 people", "7 clients", "Aug 1", "Set up with Merit", "", 0),
 ("Employee / cardholder", "Own card charges and receipts only", "Client staff", "41 people", "6 clients", "Aug 1", "Set up with Merit", "", 0),
 ("Lender viewer", "Delivered packs and certificates", "External", "3 people", "2 clients", "Aug 1", "Set up with Merit", "", 0),
 ("Client admin", "Manages a client’s own staff", "Client staff", "2 people", "2 clients", "Aug 1", "Set up with Merit", "", 0),
]
UNHELD = ["Finance director", "AP clerk", "AR clerk", "Data entry", "Department head", "View-only"]
CUSTOM = [
 ("Senior bookkeeper", "Bookkeeper + rec sign-off, posts ≤ $10k", "Internal", "2 people", "5 clients", "Sep 22", "Jordan Smith", "", 0, "Custom · from Bookkeeper"),
 ("Lender package preparer", "Builds the HVAC lender pack", "Internal", "1 person", "1 group", "Sep 9", "Mike Heilman", "", 0, "Custom · started empty"),
 ("Year-end reviewer", "Reviews year-end entries, no posting", "Internal", "No one yet", "", "Not in use", "Erin Vance", "new", 0, "Custom · from Controller"),
]
CLIENT = [
 ("Office manager", "Approves bills ≤ $2,500, chases receipts", "Heritage Interiors", "1 person", "Oct 9", "Lauren Pierce", "client:Lauren Pierce"),
 ("Field supervisor", "Approves crew expenses ≤ $500", "Heritage Interiors", "2 people", "Sep 30", "Lauren Pierce", ""),
 ("Owner’s assistant", "Answers requests, uploads documents", "Crystal Kitchen & Bath", "1 person", "Oct 1", "Dave Novak", ""),
]

AUD = {'Internal': 'Internal staff', 'Client staff': 'Client staff', 'External': 'External'}


def changes(st, by):
    """The Changes column: what's proposed on this role, in words."""
    if st.startswith("proposed:"):
        n = st.split(":")[1]
        return (f'<a class="l1 link" href="#">Proposed changes · {n}</a>'
                f'<span class="l2">Draft by {by}</span>')
    if st == "new":
        return f'<span class="l1 b">New role · not in use</span><span class="l2">Draft by {by}</span>'
    if st.startswith("client:"):
        return (f'<a class="l1 link" href="#">Proposed changes · 2</a>'
                f'<span class="l2 warn">Waiting for you to approve</span>')
    return '<span class="l1 none" aria-label="No proposed changes">—</span>'


def row(name, desc, aud, made, h1, h2, last, by, st, sugg, kind, key):
    sug = ""  # suggestions live in the one note above the table, not on rows
    held = h1 not in ("No one yet",)
    hold = (f'<a class="l1 link" href="#">{h1}</a><span class="l2">{h2}</span>' if held
            else f'<span class="l1" style="color:var(--ink-3)">{h1}</span>')
    lastc = (f'<span class="l1 tnum">{last}</span><span class="l2">{by}</span>' if last != "Not in use"
             else '<span class="l1" style="color:var(--ink-3)">Never published</span>')
    return (f'<tr class="q-row" data-lvl="{key}" data-kind="{kind}" data-aud="{aud}" data-held="{1 if held else 0}" data-prop="{1 if st else 0}" data-name="{E(name.lower())}">'
            f'<td class="chk"><label class="check"><input type="checkbox" aria-label="Select {E(name)}"><i></i></label></td>'
            f'<td><a class="l1" href="#">{E(name)}</a><span class="l2">{E(desc)}</span></td>'
            f'<td><span class="l1">{AUD.get(aud, aud)}</span><span class="l2">{made}</span></td><td>{hold}</td>'
            f'<td>{lastc}</td><td>{changes(st, by)}{sug}</td>'
            f'<td><button class="btn btn--quiet btn--icon" type="button" aria-label="More actions for {E(name)}" data-menu>⋯</button></td></tr>')


def library_frame():
    rows = [f'<tr class="q-group"><td colspan="7"><span class="q-group-t">Standard roles</span><span class="tnum b">19</span><span class="t-cap" style="margin-left:12px">Ready-made by MeritBooks. Change them as you like; MeritBooks never changes them for you.</span></td></tr>']
    for r in STD:
        rows.append(row(r[0], r[1], r[2], "Standard role", r[3], r[4], r[5], r[6], r[7], r[8], "Standard", "tenant"))
    rows.append(f'<tr class="more-row" data-lvl="tenant"><td></td><td colspan="6"><div class="more-in"><button class="btn btn--quiet" type="button" id="show-unheld" aria-expanded="false">Show 6 standard roles no one holds</button><span class="t-cap">{" · ".join(UNHELD)}</span></div></td></tr>')
    rows.append('<tr class="q-group"><td colspan="7"><span class="q-group-t">Your custom roles</span><span class="tnum b">3</span></td></tr>')
    for r in CUSTOM:
        rows.append(row(r[0], r[1], r[2], r[9], r[3], r[4], r[5], r[6], r[7], r[8], "Custom", "tenant"))
    rows.append('<tr class="q-group"><td colspan="7"><span class="q-group-t">Made by clients</span><span class="tnum b">3</span><span class="t-cap" style="margin-left:12px">A client’s admin made these for their own staff, inside the limits you set for that client.</span></td></tr>')
    for r in CLIENT:
        rows.append(row(r[0], r[1], "Client staff", f"Made by {r[2]}", r[3], "1 client", r[4], r[5], r[6], 0, "Custom", "client"))
    table = (f'<table class="tbl tbl-q rl-t" id="rl"><colgroup><col style="width:48px"><col><col style="width:184px"><col style="width:120px">'
             f'<col style="width:136px"><col style="width:232px"><col style="width:64px"></colgroup>'
             f'<thead><tr><th></th><th>Role</th><th>For</th><th>People</th><th>Last published</th><th>Changes</th><th></th></tr></thead>'
             f'<tbody>{"".join(rows)}</tbody></table>')
    menu = (f'<div class="popover rowmenu" id="rowmenu" role="menu" hidden><ul class="popover-list"><li class="popover-item" role="menuitem">{ico("right")}Open</li>'
            f'<li class="popover-item" role="menuitem">{ico("copy")}Copy as a new role</li><li class="popover-item" role="menuitem">{ico("cols")}Compare with…</li>'
            f'<li class="popover-item" role="menuitem">{ico("history")}History</li>'
            f'<li class="popover-item" role="menuitem" aria-disabled="true" style="color:var(--ink-3)">{ico("lock")}<span><span class="l1" style="color:var(--ink-2)">Archive</span><span class="l2" id="arch-why">3 people hold it. Move them first.</span></span></li></ul></div>')
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access & roles")}
{bar_workspace('Settings<span class="sl">//</span><b>Access &amp; roles</b>')}
<main class="main"><div class="ctxline"><span>25 roles</span><span class="sl">//</span><span>2 with proposed changes</span><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("log")}Access log</button><button class="btn btn--quiet" type="button">{ico("download")}Export who-can-do-what</button></div>
<div class="lib" style="position:relative">
<div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Settings<span class="sl">//</span>Access &amp; roles</div><h1 class="t-title" style="margin-top:4px">Roles</h1></div>
<div class="btn-row"><button class="btn" type="button" id="cmp" hidden>{ico("cols")}Compare <span class="n" id="cmp-n">2</span></button><button class="btn btn--primary" type="button">{ico("plus")}New role</button></div></div>
<div class="lib-tabs"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">Roles<span class="n tnum">25</span></button><button class="tab" role="tab" aria-selected="false">Permission sets<span class="n tnum">7</span></button><button class="tab" role="tab" aria-selected="false">Client limits<span class="n tnum">2</span></button></div><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("shield")}Conflict rules</button></div>
<div class="sugg" id="sugg" role="note">{ico("info")}<span><b>MeritBooks suggests 2 updates</b> for Accounting manager and Bookkeeper. Optional; nothing changes unless you add them.</span><span class="sp"></span><button class="btn btn--quiet" type="button" id="sugg-open">See suggestions</button><button class="btn btn--quiet btn--icon" type="button" id="sugg-x" aria-label="Dismiss suggestions">{ico("x")}</button></div>
<div class="filters"><label class="search">{ico("search")}<input id="q" placeholder="Search roles" aria-label="Search roles"></label>
<div class="seg" role="group" aria-label="Made by"><button type="button" aria-pressed="true" data-l="">All<span class="n">25</span></button><button type="button" aria-pressed="false" data-l="tenant">Merit’s<span class="n">22</span></button><button type="button" aria-pressed="false" data-l="client">By clients<span class="n">3</span></button></div>
<select class="select" id="f-kind" aria-label="Kind"><option value="">Any kind</option><option value="Standard">Standard</option><option value="Custom">Custom</option></select>
<select class="select" id="f-aud" aria-label="For"><option value="">For anyone</option><option value="Internal">Internal staff</option><option value="Client staff">Client staff</option><option value="External">External</option></select>
<label class="check"><input type="checkbox" id="f-held"><i></i>In use</label><label class="check"><input type="checkbox" id="f-prop"><i></i>Has changes</label><label class="check"><input type="checkbox" id="f-unused"><i></i>Unused 90 days</label></div>
{table}
<div class="empty" id="empty" hidden><span class="wg-empty-mark">{ico("filter")}</span><span class="t-head">No roles match these filters</span><p class="ink-2" id="empty-why">Every role was used in the last 90 days.</p><button class="btn" type="button" id="clear">Clear filters</button></div>
{menu}
</div></main></div>"""


def suggestions_frame():
    def item(i, role, ppl, what, why):
        return (f'<li class="sg" data-i="{i}"><div class="sg-t"><span class="l1">{role}</span><span class="l2">{ppl}</span></div>'
                f'<div class="sg-b"><p class="t-head" style="font-weight:500">{what}</p><p class="ink-2">{why}</p></div>'
                f'<div class="sg-a"><button class="btn" type="button" data-add>{ico("plus")}Add</button><button class="btn btn--quiet" type="button" data-skip>Skip</button></div>'
                f'<div class="sg-done" hidden><span class="sg-msg"></span><button class="btn btn--quiet" type="button" data-undo>Undo</button></div></li>')
    items = (item(0, "Accounting manager", "3 people · 13 clients",
                  "Let managers post the monthly sales-tax entry.", "They already prepare it; today a controller has to post it for them. No new conflicts.")
             + item(1, "Bookkeeper", "6 people · 13 clients",
                    "Let bookkeepers see loans and covenants, view only.", "So they can see what a covenant needs before they close the month. Read-only; nothing they can change."))
    return f"""<div class="dlgwrap"><div class="dialog sgd" role="dialog" aria-modal="true" aria-labelledby="sg-h">
<div class="dialog-head"><div class="eyebrow">From MeritBooks<span class="sl">//</span>Oct 14</div><h3 class="t-section" id="sg-h" style="margin-top:4px">2 suggested updates</h3>
<p class="ink-2" style="margin-top:4px">Add puts a change into that role’s proposed changes, where you review and publish it as usual. Skip drops it.</p></div>
<div class="dialog-body" style="padding-top:0"><ul class="sgl" id="sgl">{items}</ul>
<div class="wg-state" id="sg-done" hidden style="height:auto;padding:24px 0;align-items:flex-start"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">All suggestions handled</span><p class="ink-2">Added changes wait in each role’s proposed changes. Nobody’s access changes until you publish.</p></div>
<p class="t-cap" style="margin-top:16px">Also from MeritBooks, already in effect since Oct 1: changing a vendor’s bank details needs a second approver, in every role.</p></div>
<div class="dialog-foot"><span class="t-cap" id="sg-left">2 to decide</span><span class="sp"></span><button class="btn" type="button">Close</button></div></div></div>"""


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
<div class="dialog-head"><div class="eyebrow">Settings<span class="sl">//</span>Access &amp; roles</div><h3 class="t-section" id="nr-h" style="margin-top:4px">New role</h3></div>
<div class="dialog-body"><div class="starts" role="radiogroup" aria-label="How to start">
<label class="opt-card"><input type="radio" name="start" checked><span class="t-head">From a standard role</span><p>Starts from a ready-made MeritBooks role. Change anything.</p></label>
<label class="opt-card"><input type="radio" name="start"><span class="t-head">Copy one of yours</span><p>Starts from any role Merit already uses, with your changes.</p></label>
<label class="opt-card"><input type="radio" name="start"><span class="t-head">Start empty</span><p>No permissions. You add each one.</p></label></div>
<label class="search" style="margin-top:16px">{ico("search")}<input placeholder="Search 21 standard roles by job, e.g. approves bills" aria-label="Search standard roles"></label>
<ul class="tpl-list" role="listbox" aria-label="Standard roles">{lis}</ul>
<div class="nr-fields"><label class="field"><span class="field-label">Name</span><input class="input" value="Senior bookkeeper — payroll"></label>
<label class="field"><span class="field-label">Who it’s for</span><select class="select"><option selected>Internal staff</option><option>Client staff</option><option>External</option></select><span class="field-help">Sets the most it can ever do. Roles for outsiders can never post, release or change settings.</span></label></div>
<p class="t-cap" style="margin-top:12px">Client roles are made by a client’s own admin, inside the limits you set in that client’s People &amp; access.</p></div>
<div class="dialog-foot"><span class="t-cap">Starts with Bookkeeper’s 41 permissions. Nobody holds it until you publish.</span><span class="sp"></span><button class="btn" type="button">Cancel</button><button class="btn btn--primary" type="button">Create and edit</button></div></div></div>"""


def smalls_frame():
    return f"""<div class="smalls"><div><h3 class="t-section" style="color:var(--ink)">No matches</h3>
<div class="empty"><span class="wg-empty-mark">{ico("filter")}</span><span class="t-head">No roles match these filters</span><p class="ink-2">Made by clients · unused in 90 days. Every client-made role was used this quarter.</p><button class="btn" type="button">Clear filters</button></div></div>
<div><h3 class="t-section" style="color:var(--ink)">First visit, nothing customized</h3>
<div class="empty"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">19 standard roles, ready to assign</span><p class="ink-2">Ready-made by MeritBooks when Merit Management Group was set up. Assign them as they are, or copy one to tailor it.</p><div class="btn-row"><button class="btn btn--primary" type="button">Assign a role</button><button class="btn" type="button">New role</button></div></div></div></div>"""


JS = r"""<script>
(function(){
  var t=document.getElementById('rl'),q=document.getElementById('q'),lvl='';
  var unheld=false;
  function apply(){
    var s=q.value.trim().toLowerCase(),k=document.getElementById('f-kind').value,a=document.getElementById('f-aud').value,
        held=document.getElementById('f-held').checked,prop=document.getElementById('f-prop').checked,unused=document.getElementById('f-unused').checked,n=0;
    t.querySelectorAll('tr.q-row').forEach(function(r){
      var ok=(!s||r.dataset.name.indexOf(s)>-1)&&(!lvl||r.dataset.lvl===lvl)&&(!k||r.dataset.kind===k)&&(!a||r.dataset.aud===a)&&(!held||r.dataset.held==='1')&&(!prop||r.dataset.prop==='1')&&!unused;
      r.hidden=!ok;if(ok)n++;});
    t.querySelectorAll('tr.q-group,tr.more-row').forEach(function(g){var nx=g.nextElementSibling,any=false;while(nx&&!nx.classList.contains('q-group')){if(nx.classList.contains('q-row')&&!nx.hidden)any=true;nx=nx.nextElementSibling}g.hidden=!any&&!g.classList.contains('more-row')?true:(g.classList.contains('more-row')?(!!lvl&&lvl!=='tenant')||!!s||unused||prop:false)});
    document.getElementById('empty').hidden=n>0;t.hidden=n===0;
  }
  q.addEventListener('input',function(){clearTimeout(q._t);q._t=setTimeout(apply,150)});
  ['f-kind','f-aud','f-held','f-prop','f-unused'].forEach(function(id){document.getElementById(id).addEventListener('change',apply)});
  document.querySelectorAll('.seg [data-l]').forEach(function(b){b.onclick=function(){document.querySelectorAll('.seg [data-l]').forEach(function(x){x.setAttribute('aria-pressed','false')});b.setAttribute('aria-pressed','true');lvl=b.dataset.l;apply()}});
  document.getElementById('clear').onclick=function(){q.value='';['f-held','f-prop','f-unused'].forEach(function(i){document.getElementById(i).checked=false});document.getElementById('f-kind').value='';document.getElementById('f-aud').value='';lvl='';document.querySelector('.seg [data-l=""]').click()};
  t.addEventListener('change',function(e){var n=t.querySelectorAll('td.chk input:checked').length,c=document.getElementById('cmp');c.hidden=n<2;document.getElementById('cmp-n').textContent=n;
    var r=e.target.closest('tr');if(r)r.classList.toggle('is-selected',e.target.checked)});
  var menu=document.getElementById('rowmenu');
  t.addEventListener('click',function(e){var b=e.target.closest('[data-menu]');if(!b)return;var r=b.closest('tr');var h=r.querySelector('td:nth-child(4) .l1').textContent;
    document.getElementById('arch-why').textContent=/No one/.test(h)?'Archive this role':h+' hold'+(h==='1 person'?'s':'')+' it. Move them first.';
    menu.style.top=(r.offsetTop+r.offsetHeight+t.offsetTop)+'px';menu.hidden=!menu.hidden;b.setAttribute('aria-expanded',String(!menu.hidden))});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')menu.hidden=true});
  document.getElementById('show-unheld').onclick=function(){unheld=!unheld;this.setAttribute('aria-expanded',String(unheld));this.textContent=unheld?'Hide roles no one holds':'Show 6 standard roles no one holds';
    mbToast(unheld?'Showing 6 roles no one holds':'Hid 6 roles no one holds')};
  var sg=document.getElementById('sugg');
  document.getElementById('sugg-x').onclick=function(){sg.hidden=true;mbToast('Dismissed MeritBooks suggestions',function(){sg.hidden=false})};
  document.getElementById('sugg-open').onclick=function(){document.getElementById('f2').scrollIntoView({behavior:'smooth'})};
  /* suggestions dialog */
  var left=2,ROLE=['Accounting manager','Bookkeeper'];
  function upd(){document.getElementById('sg-left').textContent=left?left+' to decide':'Nothing left to decide';document.getElementById('sg-done').hidden=left>0}
  document.getElementById('sgl').addEventListener('click',function(e){var li=e.target.closest('.sg');if(!li)return;var i=+li.dataset.i,b=e.target.closest('[data-add],[data-skip],[data-undo]');if(!b)return;
    if(b.hasAttribute('data-undo')){li.classList.remove('is-done');li.querySelector('.sg-done').hidden=true;left++;upd();return}
    var add=b.hasAttribute('data-add');li.classList.add('is-done');li.querySelector('.sg-done').hidden=false;
    li.querySelector('.sg-msg').textContent=add?'Added to '+ROLE[i]+'’s proposed changes':'Skipped';left--;upd();
    mbToast(add?'Added to '+ROLE[i]+'’s proposed changes':'Skipped the suggestion for '+ROLE[i])});
  document.querySelectorAll('.tpl-list li').forEach(function(li){li.onclick=function(){document.querySelectorAll('.tpl-list li').forEach(function(x){x.setAttribute('aria-selected','false')});li.setAttribute('aria-selected','true')}});
})();
</script>"""


def build():
    h = head("S13 · Role library", CSS)
    b = sheet_top("S13-role-library.html") + '<main id="main" class="sheet">'
    b += board_h("S13", "05-RBAC §6.1 A1 · §1.7 · §6.10", "Every role Merit can hand out, and who holds it",
                 "Mike’s library: the standard roles MeritBooks set up, the custom ones Merit built, and the roles Heritage Interiors and Crystal Kitchen &amp; Bath made for their own staff. Each row says who it’s for, who holds it, and whether changes are proposed. Try the filters, the row menu, and selecting two roles.", "S13.1")
    b += frame(library_frame(), 1080, "Roles tab. A role is what people have now; proposed changes are one editable draft beside it, until someone publishes.", "Live: search, made-by, kind, for, toggles, select 2 → Compare, row menu, dismiss the note", "f1")
    b += '<div class="anno"><div><b>Two states, in words</b><p>Every role is what its holders have now. If someone is editing it, the Changes column says “Proposed changes · 4” and who’s drafting.</p></div><div><b>People are a link</b><p>“3 people · 13 clients” opens them, so the cost of a change is one click from the role.</p></div><div><b>Suggestions are optional</b><p>MeritBooks’ suggestions are one quiet, dismissible note. Nothing changes unless someone adds them.</p></div><div><b>Archive explains itself</b><p>The row menu shows Archive locked with the reason: a role people hold can’t be archived. History is one item in the same menu.</p></div></div>'
    b += '<div class="pair-h"><h2 class="t-section">Suggestions from MeritBooks</h2><span class="t-cap">Opened from the note. Add or Skip, one line each.</span></div>'
    b += frame(suggestions_frame(), 560, "No diffs to read: each suggestion is one sentence, who it reaches, and why. Add drops it into the role’s proposed changes; it still goes through Review &amp; publish.", "S13.2 · add or skip both to reach the done state", "f2")
    b += '<div class="pair-h"><h2 class="t-section">New role</h2><span class="t-cap">Three ways to start</span></div>'
    b += frame(new_role_frame(), 760, "The standard-role picker reads like job descriptions. Who it’s for is chosen up front because it sets the most the role can ever do.", "S13.3")
    b += '<div class="pair-h"><h2 class="t-section">Empty and first-run</h2></div>'
    b += frame(smalls_frame(), 320, "Empty says why and offers the way out; first-run says what’s already there.", "S13.4")
    b += '</main>'
    return h + b + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S13-role-library.html")
    open(out, "w").write(build()); print("wrote", out, len(build()))
