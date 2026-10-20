"""S16 · Client admin defines roles for their own staff (05 §6.5 A5, §1.6) + the firm's side (§6.4 A4)."""
from acc_common import *
from acc_data import js_data
from acc_matrix import MATRIX_JS

ENV = {"ap.bills": "VCEA", "exp.receipts": "VCEDA", "exp.reports": "VCEA", "ar.invoices": "VCER", "mdm.vendors": "VCE", "mdm.customers": "VCE",
       "cash.position": "V", "reports.financial": "VX", "docs.documents": "VCX", "req.client_requests": "VCE", "cards.transactions": "V"}
OM2 = {"ap.bills": "VCEA", "exp.receipts": "VCEDA", "exp.reports": "VCEA", "mdm.vendors": "VCE", "mdm.customers": "V",
       "cash.position": "V", "reports.financial": "VX", "docs.documents": "VCX", "req.client_requests": "VCE", "cards.transactions": "V"}
OM3 = dict(OM2); OM3["ar.invoices"] = "VC"
LIM2 = {"ap.bills:A": "≤ $2,500", "exp.reports:A": "≤ $1,000"}
LIM3 = {"ap.bills:A": "≤ $5,000", "exp.reports:A": "≤ $1,000"}
FIRM_ACTS = "APRK"  # approve, post, release, configure need Merit's approval

CSS = """
.cr{display:grid;grid-template-columns:248px minmax(0,1fr);height:calc(100% - 32px)}
.cr-roles{background:var(--white);border-right:1px solid var(--line);overflow:auto;padding:16px 0}
.cr-roles .eyebrow{display:block;padding:12px 20px 8px}
.rr{display:flex;flex-direction:column;justify-content:center;min-height:52px;padding:6px 20px;border-bottom:1px solid var(--line);cursor:pointer}
.rr:hover{background:var(--grey-100)}
.rr[aria-current=true]{background:var(--sky);box-shadow:inset 3px 0 var(--electric)}
.rr .row{gap:8px}
.cr-main{min-width:0;overflow:auto;padding:24px 32px 40px}
.cr-main .capm col.c-act{width:52px}
.env-q{position:relative;margin-top:16px}
.env-q .search{width:420px}
.env-foot{display:flex;align-items:center;gap:16px;margin-top:0;padding:12px 16px;background:var(--canvas);border:1px solid var(--line);border-top:0}
.env-foot .sp{flex:1}
.ppl2{table-layout:fixed;margin-top:8px}
.ppl2 td{height:48px}
.fa{display:grid;grid-template-columns:minmax(0,1fr) 400px;height:calc(100% - 32px)}
.fa-main{min-width:0;overflow:auto;padding:24px 32px 40px}
.fa-side{border-left:1px solid var(--line-2);background:var(--white);overflow:auto}
.fa-side .sec{padding:20px 24px;border-bottom:1px solid var(--line)}
.fa-side .sec h3{font:600 12px/16px var(--f-text);letter-spacing:.12em;text-transform:uppercase;color:var(--ink);margin-bottom:12px}
.pend{background:var(--warn-wash);box-shadow:inset 3px 0 var(--warn)}
.who-t td{height:48px}
.who-t tr.q-group td{height:40px}
.acts4{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.smalls{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:32px}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:32px 24px;border:1px dashed var(--grey-400);background:var(--white)}
"""


def rail_firm_client():
    def l(t, cur=False, c=None):
        cc = f'<span class="count">{c}</span>' if c else ""
        return f'<a class="rail-link" href="#"{" aria-current=page" if cur else ""}>{t}{cc}</a>'
    g = ('<div class="rail-group">Books</div>' + l("Client home") + l("To review", c=18) + l("Reconcile") + l("Close checklist") +
         '<div class="rail-group">Spend</div>' + l("Bills", c=7) + l("Pay runs") + l("Expenses &amp; receipts") +
         '<div class="rail-group">Sales</div>' + l("Invoices") + l("Collections") +
         '<div class="rail-group">Reports</div>' + l("Financial reports") + l("Debt &amp; covenants") +
         '<div class="rail-group">Client settings</div>' + l("Client profile") + l("People &amp; access", True) + l("Accounting setup") + l("Bank &amp; card connections"))
    return (f'<aside class="rail" aria-label="Primary"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24"><span class="prod">BOOKS</span></div>'
            f'<nav class="rail-nav" data-scroll-current>{g}</nav><div class="rail-foot"><div class="rail-user"><span class="avatar">JS</span><span>Jordan Smith<small>Accounting manager</small></span></div></div></aside>')


def client_admin_frame():
    roles = (f'<span class="eyebrow">Heritage roles</span>'
             f'<div class="rr" aria-current="true" tabindex="0"><span class="row"><span class="l1">Office manager</span><span class="tag tag--warn">v3 waiting</span></span><span class="l2">1 person · v2 live</span></div>'
             f'<div class="rr" tabindex="0"><span class="l1">Field supervisor</span><span class="l2">2 people · v1</span></div>'
             f'<div style="padding:12px 20px"><button class="btn" type="button">{ico("plus")}New Heritage role</button></div>'
             f'<span class="eyebrow">From Merit Management Group</span>'
             f'<div class="rr" tabindex="0"><span class="row"><span class="l1">Client admin</span>{ico("lock",12)}</span><span class="l2">1 person · you</span></div>'
             f'<div class="rr" tabindex="0"><span class="row"><span class="l1">Client contact</span>{ico("lock",12)}</span><span class="l2">1 person</span></div>'
             f'<div class="rr" tabindex="0"><span class="row"><span class="l1">Employee / cardholder</span>{ico("lock",12)}</span><span class="l2">4 people</span></div>'
             f'<p class="t-cap" style="padding:12px 20px">Merit’s roles can be assigned, not edited.</p>')
    people = "".join(f'<tr class="q-row"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td><span class="l1">{c}</span><span class="l2">{d}</span></td><td><span class="l1">{e}</span></td></tr>' for a, b, c, d, e in [
        ("Marcus Reyes", "marcus@heritageinteriors.com", "Office manager", "Heritage role · v2", "Today 7:58 AM")])
    return f"""<div class="app app--frame density-report" data-context="client">
{rail_client_admin("Team & roles")}
{bar_client("Heritage Interiors", "C-101 · Sep open", 'Client settings<span class="sl">//</span>People &amp; access<span class="sl">//</span><b>Team &amp; roles</b>')}
<main class="main"><div class="ctxline"><span>Heritage Interiors</span><span class="sl">//</span><span>9 people</span><span class="sl">//</span><span>Merit Management Group sets the ceiling</span><span class="sl">//</span><b id="ca-wait">1 change waiting for Merit</b></div>
<div class="cr"><nav class="cr-roles" aria-label="Roles">{roles}</nav>
<div class="cr-main"><div class="page-head" style="margin-bottom:12px"><div><div class="eyebrow">Heritage role<span class="sl">//</span>client staff only</div><h1 class="t-title" style="margin-top:4px">Office manager</h1>
<p class="ink-2" style="margin-top:6px">Approves bills up to a limit, chases receipts, answers Merit’s questions.</p></div>
<div class="btn-row" style="flex-wrap:nowrap"><span class="lvl lvl--client">Client · Heritage Interiors</span><button class="btn" type="button" id="withdraw">Withdraw v3</button></div></div>
<div class="inline-notice inline-notice--warn" id="pend"><span class="warn">{ico("clock")}</span><div><b>v3 is waiting for Merit Management Group.</b> Sent Oct 16 to Jordan Smith because it raises an approval limit. Marcus keeps v2 until Merit approves.</div></div>
<div class="env-q"><label class="search">{ico("search")}<input id="env-q" placeholder="What should an office manager be able to do?" aria-label="Find a capability" value=""></label></div>
<div id="env-msg" style="margin-top:8px"></div>
<p class="t-cap" style="margin-top:8px">Small square top right: changed in v3, compared with v2 that’s live. Cut corner: has a limit.</p>
<table class="tbl capm" id="om" style="margin-top:12px"><colgroup><col><col style="width:104px">{'<col class="c-act" style="width:52px">'*9}</colgroup></table>
<div class="env-foot">{ico("shield")}<span>Your accounting firm controls access beyond this list.</span><span class="sp"></span><button class="btn" type="button">Ask Merit for more</button></div>
<p class="t-cap" style="margin-top:8px">Changes to approve, post, release or settings go to Merit before they apply. Everything else applies when you save.</p>
<h2 class="t-section" style="margin-top:32px">People with this role</h2>
<table class="tbl tbl-q ppl2"><colgroup><col><col style="width:240px"><col style="width:180px"></colgroup><thead><tr><th>Person</th><th>Role</th><th>Last active</th></tr></thead><tbody>{people}</tbody></table>
<div class="btn-row" style="margin-top:12px"><button class="btn" type="button">{ico("user-plus")}Assign to someone at Heritage</button><span class="t-cap">Only Heritage staff and contacts are listed.</span></div>
</div></div></main></div>"""


def firm_frame():
    def p(name, sub, role, how, cap, ends, cls=""):
        return f'<tr class="q-row{cls}"><td><span class="l1">{name}</span><span class="l2">{sub}</span></td><td><span class="l1">{role}</span><span class="l2">{how}</span></td><td><span class="l1">{cap}</span></td><td><span class="l1 tnum">{ends}</span></td></tr>'
    g = lambda t, n: f'<tr class="q-group"><td colspan="4"><span class="q-group-t">{t}</span><span class="tnum b">{n}</span></td></tr>'
    rows = (g("Merit staff", 6) + p("Mike Heilman", "Owner · Tenant admin", "Owner", "All clients", "—", "—")
            + p("Nora Lindqvist", "CFO", "CFO", "All clients", "Approver", "—") + p("Erin Vance", "Controller", "Controller", "All clients", "Reviewer", "—")
            + p("Jordan Smith", "Accounting manager", "Accounting manager", "All 13 of his clients", "Lead", "—")
            + p("Dana Lee", "Bookkeeper", "Bookkeeper", "Direct on Heritage", '<span class="warn">Preparer + reviewer</span>', "—")
            + p("Alex Kim", "MeritBooks support", "Support session", "Approved by Mike · read-only", "—", '<span class="warn">Ends 11:40 AM</span>')
            + g("Heritage staff", 7) + p("Lauren Pierce", "Client admin", "Client admin", "Merit role on Heritage", "—", "—")
            + p("Marcus Reyes", "Office manager", "Office manager", "Heritage role · v2", "—", "—")
            + p("Hannah Cole, Tyler Brandt", "Field supervisors", "Field supervisor", "Heritage role · v1", "—", "—")
            + p("4 cardholders", "Own cards only", "Employee / cardholder", "Merit role", "—", "—")
            + g("Outside", 2) + p("Gina Alvarez", "Heritage bookkeeping contact", "Client contact", "Merit role · magic link", "—", "—")
            + p("Kyle Brandt", "Northwest Bank", "Lender viewer", "Delivered packs only", "—", "Sep 30, 2027"))
    return f"""<div class="app app--frame density-cockpit" data-context="client">
{rail_firm_client()}
{bar_client("Heritage Interiors", "C-101 · Sep open", 'Client settings<span class="sl">//</span><b>People &amp; access</b>')}
<main class="main"><div class="ctxline"><span>Heritage Interiors</span><span class="sl">//</span><span>15 people can open these books</span><span class="sl">//</span><b class="warn">2 coverage gaps</b><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("log")}Heritage access log</button></div>
<div class="fa"><div class="fa-main"><div class="page-head" style="margin-bottom:12px"><div><div class="eyebrow">Client settings</div><h1 class="t-title" style="margin-top:4px">People &amp; access</h1></div><button class="btn btn--primary" type="button">{ico("plus")}Give someone access</button></div>
<div class="inline-notice inline-notice--warn"><span class="warn">{ico("alert")}</span><div><b>Dana Lee is preparer and reviewer on the September close.</b> Move review to someone else before she signs off.<br><b>Only Nora Lindqvist can release pay runs here.</b> She’s out Nov 3–7. Add a backup.</div></div>
<table class="tbl tbl-q who-t" style="margin-top:16px"><colgroup><col style="width:216px"><col><col style="width:176px"><col style="width:136px"></colgroup><thead><tr><th>Person</th><th>Role · how they get in</th><th>Capacity</th><th>Ends</th></tr></thead><tbody>{rows}</tbody></table></div>
<aside class="fa-side" aria-label="Heritage access policy">
<div class="sec pend" id="appr"><h3>Waiting for you</h3><span class="l1">Lauren wants Office manager v3</span><span class="l2">Sent Oct 16 · Marcus Reyes holds it</span>
<ul class="why" style="margin-top:8px"><li><b>Approve bills</b> up to $5,000 (was $2,500)</li><li><b>Create invoices</b>, not send</li><li class="against">Inside Heritage’s envelope · no duty conflicts</li></ul>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--primary" type="button" id="appr-go">Approve v3</button><button class="btn" type="button">Return with a note</button></div></div>
<div class="sec"><h3>Heritage’s own roles</h3><label class="switch"><input type="checkbox" checked><i></i>Heritage can make roles for its staff</label>
<label class="field" style="margin-top:12px"><span class="field-label">Most a Heritage role can contain</span><select class="select"><option selected>Client staff envelope · MeritBooks standard</option><option>Heritage envelope · custom</option></select><span class="field-help">Bills, expenses, receipts, requests, documents, reports, cash view, vendors and customers without bank details, invoices. No posting, periods, recs or settings.</span></label></div>
<div class="sec"><h3>Merit approves changes that</h3><div class="acts4"><label class="check"><input type="checkbox" checked><i></i>Approve</label><label class="check"><input type="checkbox" checked><i></i>Release or send</label><label class="check"><input type="checkbox" checked><i></i>Post</label><label class="check"><input type="checkbox" checked><i></i>Change settings</label></div></div>
<div class="sec"><h3>Seats and sign-in</h3><dl class="kv" style="grid-template-columns:1fr auto;align-items:center"><dt>Heritage staff seats</dt><dd><input class="input tnum" value="15" style="width:72px;text-align:right" aria-label="Seat cap"></dd><dt>Used</dt><dd>7 of 15</dd></dl>
<label class="switch" style="margin-top:8px"><input type="checkbox" checked><i></i>Two-step sign-in for every Heritage user</label>
<label class="switch"><input type="checkbox" checked><i></i>Lauren can invite Heritage staff and contacts</label></div>
</aside></div></main></div>"""


def smalls_frame():
    return f"""<div class="smalls"><div><h3 class="t-section" style="color:var(--ink);margin-bottom:12px">Client roles turned off</h3>
<div class="empty"><span class="wg-empty-mark">{ico("lock")}</span><span class="t-head">Swan Creek uses Merit’s roles</span><p class="ink-2">Merit Management Group hasn’t turned on Swan Creek roles. You can still give your staff Client contact or Employee / cardholder.</p><div class="btn-row"><button class="btn btn--primary" type="button">Assign a role</button><button class="btn" type="button">Ask Merit to turn on Swan Creek roles</button></div></div></div>
<div><h3 class="t-section" style="color:var(--ink);margin-bottom:12px">Nothing waiting</h3>
<div class="empty"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">Office manager v3 is live</span><p class="ink-2">Jordan Smith approved it Oct 17, 9:20 AM. Marcus can now approve bills up to $5,000. It’s in Heritage’s access log.</p><button class="btn" type="button">See the log</button></div></div></div>"""


JS = "<script>\n" + js_data(env=ENV, om2=OM2, om3=OM3, lim3=LIM3) + MATRIX_JS + r"""
(function(){
  var t=document.getElementById('om');t.insertAdjacentHTML('beforeend',MBM.head(true,'What they can do'));
  var g=JSON.parse(JSON.stringify(MB.om3)),q=document.getElementById('env-q');
  function draw(){var s=q.value.trim().toLowerCase();
    var env=MB.env,keys=Object.keys(env);
    /* only envelope capabilities exist here; cells outside the envelope are absent */
    var saved=MBM.CAT;var cat={};
    MBM.render(t,{grants:g,base:MB.om2,limits:MB.lim3,edit:true,acts:function(k){return env[k]},only:function(k){return keys.indexOf(k)>-1&&(!s||(MBM.CAT[k].label+' '+MBM.CAT[k].domL).toLowerCase().indexOf(s)>-1)}});
    var m=document.getElementById('env-msg');m.innerHTML='';
    if(s.length>2&&!t.querySelector('tr.capm-res')){var hit=MBM.ORDER.filter(function(k){return (MBM.CAT[k].label+' '+MBM.CAT[k].domL).toLowerCase().indexOf(s.replace(/^(post|approve|release|see|view)\s+/,''))>-1})[0];
      m.innerHTML='<div class="inline-notice inline-notice--neg"><span class="neg"><span class="slash" aria-hidden="true"></span></span><div><b>'+(hit?MBM.esc(MBM.CAT[hit].label):'That')+' is outside what Heritage Interiors can hand out.</b> Merit Management Group controls it. <a class="link" href="#">Ask Merit</a></div></div>';}
  }
  q.addEventListener('input',function(){clearTimeout(q._t);q._t=setTimeout(draw,150)});
  t.addEventListener('click',function(e){var b=e.target.closest('button.cap');if(!b)return;var p=b.dataset.c.split(':'),cur=g[p[0]]||'';
    cur=cur.indexOf(p[1])>-1?cur.replace(p[1],''):cur+p[1];g[p[0]]=MBM.norm(cur,MBM.CAT[p[0]].acts);draw();
    var firm='APRK'.indexOf(p[1])>-1;mbToast(firm?'Changed '+MBM.capName(b.dataset.c).toLowerCase()+' · goes to Merit for approval':'Saved '+MBM.capName(b.dataset.c).toLowerCase()+' · applies now')});
  t.addEventListener('change',function(e){var s=e.target.closest('select[data-preset]');if(!s)return;var k=s.dataset.preset;g[k]=MBM.applyPreset(MB.env[k],s.value);draw()});
  draw();
  document.getElementById('withdraw').onclick=function(){document.getElementById('pend').hidden=true;document.getElementById('ca-wait').textContent='Nothing waiting for Merit';g=JSON.parse(JSON.stringify(MB.om2));draw();this.hidden=true;mbToast('Withdrew v3 · v2 stays live')};
  document.getElementById('appr-go').onclick=function(){var a=document.getElementById('appr');a.classList.remove('pend');a.innerHTML='<h3>Waiting for you</h3><span class="l1 pos">Approved Office manager v3</span><span class="l2">Live for Marcus Reyes now · logged in Heritage’s access log</span>';mbToast('Approved Office manager v3 for Heritage Interiors')};
})();
</script>"""


def build():
    h = head("S16 · Client roles", CSS)
    b = sheet_top("S16-client-roles.html") + '<main id="main" class="sheet">'
    b += board_h("S16", "05-RBAC §6.5 A5 · §6.4 A4 · §1.6", "Heritage makes roles for its own staff, inside Merit’s ceiling",
                 "Lauren Pierce runs Heritage Interiors’ office. Merit turned on Heritage roles, so she builds Office manager herself, but only from what Merit allows a client to hand out. Raising Marcus’s bill limit goes to Merit first. Then Jordan, on Merit’s side, sees who can open Heritage’s books, the gaps, the policy, and the request.", "S16.1")
    b += frame(client_admin_frame(), 1000, "Same matrix as the firm’s builder with everything outside the envelope removed, not greyed. Try searching “post journal entries”.", "Live: cells, presets, search, Withdraw")
    b += '<div class="anno"><div><b>The envelope is the edge of the page</b><p>Lauren never sees GL, periods, recs or settings. When she looks for one, the answer says who controls it and how to ask.</p></div><div><b>Which changes wait</b><p>Approve, post, release and settings go to Merit; everything else applies at once. Toasts say which happened.</p></div><div><b>Merit’s roles are locked here</b><p>She can assign Client contact or Employee / cardholder but not edit them.</p></div><div><b>Report density</b><p>Lauren isn’t an accountant, so the screen uses the Annual Report titles: fewer, larger words.</p></div></div>'
    b += '<div class="pair-h"><h2 class="t-section">Merit’s side of Heritage</h2><span class="t-cap">Who can open these books, how, the gaps, and the client policy</span></div>'
    b += frame(firm_frame(), 940, "Every way in is listed: Merit staff, Heritage staff, outsiders, and the live support session. Gaps are written as things to do.", "S16.2 · approve v3 from the panel")
    b += '<div class="pair-h"><h2 class="t-section">Off, and done</h2></div>'
    b += frame(smalls_frame(), 300, "", "S16.3")
    b += '</main>'
    return h + b + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S16-client-roles.html")
    open(out, "w").write(build()); print("wrote", out, len(build()))
