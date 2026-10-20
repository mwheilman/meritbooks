"""S14 · Role builder (05 §6.2 A2)."""
from acc_common import *
from acc_data import js_data, AM_V5, AM_TPL4, AM_TPL5, AM_DRAFT, LIMITS_V5, LIMITS_DRAFT
from acc_matrix import MATRIX_JS

def patch(a, b):
    return {k: v for k, v in b.items() if a.get(k) != v}

CSS = """
.b-main{display:flex;flex-direction:column;height:calc(100% - 32px)}
.b-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:20px 32px 0}
.b-head .meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
.b-head .desc{color:var(--ink-2);margin-top:6px;max-width:72ch}
.b-tabs{padding:0 32px;margin-top:12px}
.b-body{flex:1;min-height:0;display:grid;grid-template-columns:200px minmax(0,1fr) 336px;border-top:0}
.doms{overflow:auto;background:var(--white);border-right:1px solid var(--line);padding:8px 0 16px}
.doms a{display:flex;align-items:center;gap:8px;height:32px;padding:0 16px 0 20px;color:var(--ink-2);font-weight:500;transition:background-color var(--fast)}
.doms a:hover{background:var(--grey-100);color:var(--ink)}
.doms a[aria-current=true]{background:var(--sky);color:var(--ink);box-shadow:inset 3px 0 var(--electric)}
.doms a .n{margin-left:auto;color:var(--ink-3);font-weight:500}
.doms a.has-chg .n{color:var(--electric);font-weight:600}
.doms .eyebrow{display:block;padding:16px 20px 6px}
.doms .off{padding:0 20px;color:var(--ink-3);font-size:12px;line-height:16px}
.mx{display:flex;flex-direction:column;min-width:0;min-height:0}
.mx-tools{display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--warm)}
.mx-tools .search{width:240px}
.mx-scroll{flex:1;min-height:0;overflow:auto}
.capm col.c-act{width:56px}
.capm th{padding:0 1px}
.b-panel{border-left:1px solid var(--line-2)}
.b-panel .panel-body{padding-bottom:32px}
.pol{display:grid;grid-template-columns:minmax(0,1fr) 128px;align-items:center;gap:8px 12px}
.pol .select{height:32px}
.pol dt{color:var(--ink-2)}
.lim2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.b-panel{min-width:0;overflow:hidden}
.bar .ctx{flex:none}
.sod-more{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:2px}
.sel-h{display:flex;align-items:center;gap:8px}
.sel-h .t-head{flex:1;min-width:0}
.diff{table-layout:fixed}
.diff td,.diff th{height:44px;padding:0 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.diff th{height:40px;border-bottom:1px solid var(--electric);font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left}
.diff tr.g td{height:36px;background:var(--canvas)}
.diff td.cur{background:var(--sky)}
.diff .gone{color:var(--ink-3)}
.dx{display:inline-flex;align-items:center;gap:8px}
.pubwrap{height:100%;background:rgba(10,22,40,.48);display:flex;justify-content:center;align-items:flex-start;padding-top:32px}
.pub{width:960px}
.pub-grid{display:grid;grid-template-columns:minmax(0,1fr) 288px}
.pub-main{padding:8px 24px 24px}
.pub-side{padding:16px 20px 24px;background:var(--canvas);border-left:1px solid var(--line)}
.pub h4{font:600 12px/16px var(--f-text);letter-spacing:.12em;text-transform:uppercase;color:var(--ink);margin:20px 0 8px}
.pub-side h4:first-child{margin-top:0}
.chg{list-style:none;border-top:1px solid var(--line)}
.chg li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:36px;border-bottom:1px solid var(--line)}
.chg .pm{font-weight:700;text-align:center}
.ppl{table-layout:fixed}
.ppl td,.ppl th{padding:0 8px;height:48px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ppl th{height:32px;font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left}
.ppl tr>*:first-child{padding-left:0}
.ppl tr.more td{height:auto;padding:4px 8px 12px 32px;white-space:normal;color:var(--ink-2)}
.when{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.prog{display:flex;align-items:center;gap:12px;margin-top:8px}
"""

def head_block(publish_disabled=True, draft="Draft v6 · 4 changes"):
    return f"""<div class="b-head"><div style="min-width:0">
<div class="eyebrow">Tenant role<span class="sl">//</span>Accounting manager<span class="sl">//</span>firm label “Practice manager”</div>
<h1 class="t-title" style="margin-top:4px">Accounting manager</h1>
<p class="desc">Runs the close across assigned clients, reviews bookkeepers’ work, approves bills and pay runs inside a limit, and hands out client access within their own.</p>
<div class="meta"><span class="lvl lvl--tenant">Tenant · Merit Management Group</span><span class="tag">Standard · modified</span><span class="tag">Internal staff</span>
<span class="t-cap">Based on <a class="link" href="#">Accounting manager · template v4</a></span><span class="tag tag--ai">Template v5 available</span>
<span class="t-cap">·</span><span class="tag tag--solid">v5 published Oct 2</span><span class="tag tag--warn"{' id="draft-tag"' if publish_disabled else ''}>{draft}</span>
<a class="link" href="#" style="font-size:12px">3 people · 13 clients</a></div></div>
<div class="btn-row" style="flex-wrap:nowrap;flex:none"><button class="btn btn--quiet" type="button">{ico("history")}Versions</button><button class="btn" type="button">{ico("cols")}Compare</button>
<button class="btn" type="button"{' id="save"' if publish_disabled else ''}>Save draft</button><button class="btn btn--primary" type="button" {'id="publish" aria-disabled="true"' if publish_disabled else ''}>Review &amp; publish</button></div></div>"""


def builder_frame():
    doms = "".join(f'<a href="#" data-dom="{d[0]}">{E(d[0])}<span class="n tnum"></span></a>' for d in __import__("acc_data").CATALOG)
    panel = f"""<aside class="panel b-panel" aria-label="Scope and constraints">
<div class="panel-head"><div class="eyebrow">Scope &amp; constraints</div>
<div class="sel-h" style="margin-top:8px"><span class="cap is-on is-lim cap--sm" id="sel-glyph"><i></i></span><span class="t-head" id="sel-name">Pay runs · Release</span>{ico("money",14,label="Moves money")}{ico("lock",14,label="Re-verify to use")}</div>
<p class="t-cap" id="sel-note" style="margin-top:4px">Added in this draft. Not in template v4.</p></div>
<div class="panel-body">
<section class="panel-sec" id="sec-lim"><div class="panel-sec-h"><h3>Dollar limit</h3><span class="t-cap">this capability</span></div>
<div class="lim2"><label class="field"><span class="field-label">Per pay run</span><input class="input input--money" id="lim-item" value="25,000.00" inputmode="decimal"></label>
<label class="field" id="lim-day-f"><span class="field-label">Per day, per client</span><input class="input input--money" id="lim-day" value="60,000.00" inputmode="decimal"></label></div>
<p class="field-help" style="margin-top:8px">Over the limit, the button reads “Release up to your limit → route to Nora Lindqvist”. Your own limit is unlimited, so you can set any amount.</p>
<p class="t-cap" style="margin-top:8px">Pay runs don’t take document-type, department or ownership limits.</p>
<div class="inline-notice" style="margin-top:12px">{ico("lock")}<div>Releasing always asks for a fresh sign-in check within 10 minutes. Platform rule; can’t be turned off.</div></div>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--danger" type="button" id="sel-remove">Remove this grant</button></div></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Which clients</h3><span class="t-cap">default when assigned</span></div>
<div class="seg" role="group" aria-label="Default scope"><button type="button" aria-pressed="true">Assigned clients</button><button type="button" aria-pressed="false">All clients</button><button type="button" aria-pressed="false">A client set</button></div>
<p class="field-help" style="margin-top:8px">Each client is one legal entity. A subsidiary is its own client; seeing a parent never shows its subsidiaries.</p></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Departments &amp; jobs</h3></div>
<label class="field"><span class="sr">Department restriction</span><select class="select"><option selected>No restriction</option><option>Their departments · edit only</option><option>Their departments · see and edit</option><option>Chosen jobs…</option></select></label></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Sensitive fields</h3><span class="t-cap">assignments can only tighten</span></div>
<dl class="pol"><dt>Pay rates &amp; payroll lines</dt><dd><select class="select" aria-label="Pay rates"><option>Hidden</option><option selected>Grouped</option><option>Visible</option></select></dd>
<dt>SSN and TIN</dt><dd><select class="select" aria-label="SSN and TIN"><option>Hidden</option><option selected>Last 4</option><option>Reveal, logged</option><option>Visible</option></select></dd>
<dt>Bank &amp; routing numbers</dt><dd><select class="select" aria-label="Bank numbers"><option>Hidden</option><option selected>Last 4</option><option>Reveal, logged</option><option>Visible</option></select></dd>
<dt>Home address, birth date</dt><dd><select class="select" aria-label="Personal details"><option selected>Hidden</option><option>Visible</option></select></dd></dl></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Time box</h3></div>
<dl class="pol"><dt>Longest assignment</dt><dd><select class="select" aria-label="Longest assignment"><option selected>No limit</option><option>90 days</option><option>120 days</option><option>365 days</option></select></dd></dl></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Sign-in</h3></div>
<label class="switch"><input type="checkbox" checked disabled><i></i>Two-step sign-in required</label>
<p class="field-help">Locked on: this role can approve money.</p>
<dl class="pol" style="margin-top:8px"><dt>Re-verify for release &amp; settings</dt><dd><select class="select" aria-label="Re-verify window"><option>5 min</option><option selected>10 min</option><option>15 min</option></select></dd>
<dt>Only from these networks</dt><dd><select class="select" aria-label="Network allowlist"><option selected>Any network</option><option>Merit office + VPN</option></select></dd>
<dt>Session · idle timeout</dt><dd><select class="select" aria-label="Session length"><option selected>12 h · 60 min</option><option>8 h · 30 min</option></select></dd></dl></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Who can assign it</h3></div>
<label class="field"><span class="sr">Assignable by</span><select class="select"><option>Tenant admins only</option><option selected>Tenant admins and managers</option><option>Anyone who can grant access</option></select></label>
<p class="field-help" style="margin-top:8px">Audience: internal staff. Fixed after the first publish.</p></section>
</div></aside>"""
    return f"""<div class="app app--frame app--mini density-cockpit" data-context="workspace">
{rail_mini("Settings")}
{bar_workspace('Settings<span class="sl">//</span>Access &amp; roles<span class="sl">//</span><b>Accounting manager</b>')}
<main class="main"><div class="ctxline"><span>Roles</span><span class="sl">//</span><span>Accounting manager</span><span class="sl">//</span><span id="ctx-saved">Draft v6 saved 9:04 AM</span><span class="sl">//</span><b id="ctx-sod">1 conflict blocks publishing</b><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("log")}Access log</button></div>
<div class="b-main">{head_block()}
<div class="b-tabs"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">Capabilities<span class="n tnum">120</span></button><button class="tab" role="tab" aria-selected="false">Diff<span class="n tnum" id="tab-diff">4</span></button><button class="tab" role="tab" aria-selected="false">People<span class="n tnum">3</span></button><button class="tab" role="tab" aria-selected="false">Version history<span class="n tnum">5</span></button></div></div>
<div class="b-body"><nav class="doms" aria-label="Domains"><span class="eyebrow">Domains</span>{doms}<span class="eyebrow">Not in your plan</span><p class="off">Projects (module 2). Its capabilities appear here once Merit adds it.</p></nav>
<div class="mx"><div id="sod" class="sod" aria-live="polite"></div>
<div class="mx-tools"><label class="search">{ico("search")}<input id="mx-q" placeholder="Find a capability, e.g. release a payment" aria-label="Find a capability"></label>
<label class="switch"><input type="checkbox" id="mx-chg"><i></i>Changes vs template only</label><span class="sp"></span>
<span class="t-cap" id="mx-count"></span></div>
<div class="mx-scroll" id="mx-scroll"><table class="tbl capm" id="mx"><colgroup><col><col style="width:104px">{'<col class="c-act" style="width:56px">'*9}</colgroup></table></div></div>
{panel}</div></div></main></div>"""


def diff_frame():
    return f"""<div class="app app--frame app--mini density-cockpit" data-context="workspace">
{rail_mini("Settings")}
{bar_workspace('Settings<span class="sl">//</span>Access &amp; roles<span class="sl">//</span><b>Accounting manager</b>')}
<main class="main"><div class="ctxline"><span>Roles</span><span class="sl">//</span><span>Accounting manager</span><span class="sl">//</span><span>Draft v6</span></div>
<div class="b-main">{head_block(False, 'Draft v6 · 3 changes')}
<div class="b-tabs"><div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="false">Capabilities<span class="n tnum">120</span></button><button class="tab" role="tab" aria-selected="true">Diff<span class="n tnum">7</span></button><button class="tab" role="tab" aria-selected="false">People<span class="n tnum">3</span></button><button class="tab" role="tab" aria-selected="false">Version history<span class="n tnum">5</span></button></div></div>
<div style="padding:16px 32px 24px;overflow:auto">
<div class="row" style="gap:16px;margin-bottom:12px"><div class="seg" role="group" aria-label="Compare"><button type="button" aria-pressed="true">Published ↔ draft ↔ latest template</button><button type="button" aria-pressed="false">Draft ↔ template v4</button></div><span class="sp"></span><span class="t-cap">Differences only. Same order as the matrix.</span><button class="btn" type="button">{ico("download")}Export</button></div>
<table class="diff" id="diff"><colgroup><col style="width:180px"><col><col style="width:220px"><col style="width:252px"><col style="width:220px"><col style="width:160px"></colgroup>
<thead><tr><th>Domain</th><th>Capability</th><th>Published v5</th><th>Draft v6</th><th>Template v5 · Oct 14</th><th></th></tr></thead><tbody></tbody></table>
<p class="t-cap" style="margin-top:12px">Template v5 also moved “Connect bank and card feeds” to Tenant admin. Your draft already matches it, so adopting v5 now would add one thing: posting sales tax.</p>
</div></div></main></div>"""


def publish_frame():
    return f"""<div class="pubwrap"><div class="dialog pub" role="dialog" aria-modal="true" aria-labelledby="pub-h">
<div class="dialog-head"><div class="eyebrow">Accounting manager<span class="sl">//</span>v5 → v6</div><h3 class="t-section" id="pub-h" style="margin-top:4px">Review and publish v6</h3></div>
<div class="pub-grid"><div class="pub-main">
<h4>What changes</h4>
<ul class="chg"><li><span class="pm pos">+</span><span><span class="l1">Release pay runs</span><span class="l2">≤ $25,000 a run · $60,000 a day per client</span></span><span class="tag tag--warn">3 soft conflicts</span></li>
<li><span class="pm">~</span><span><span class="l1">Approve bills</span><span class="l2">limit $25,000 → $35,000</span></span><span></span></li>
<li><span class="pm neg">−</span><span><span class="l1">Connect bank and card feeds</span><span class="l2">matches template v5; Tenant admin keeps it</span></span><span></span></li></ul>
<h4>People affected<span class="t-cap" style="text-transform:none;letter-spacing:0;margin-left:8px;font-weight:400">3 people across 13 clients</span></h4>
<table class="ppl"><colgroup><col style="width:168px"><col style="width:64px"><col><col style="width:120px"></colgroup>
<thead><tr><th>Person</th><th>Clients</th><th>Gains · loses</th><th>Exceptions</th></tr></thead><tbody>
<tr><td><span class="l1">Jordan Smith</span><span class="l2">Last active 9:41 AM</span></td><td class="tnum">13</td><td><span class="l1 pos">+ Release ≤ $25k · bills ≤ $35k</span><span class="l2 neg">− Connect feeds · never used</span></td><td><span class="tag tag--warn">S1 · S6 · S7</span></td></tr>
<tr><td><span class="l1">Grace Whitfield</span><span class="l2">Last active Yesterday</span></td><td class="tnum">5</td><td><span class="l1 pos">+ Release ≤ $25k · bills ≤ $35k</span><span class="l2 neg">− Connect feeds · never used</span></td><td><span class="tag tag--warn">S1 · S6 · S7</span></td></tr>
<tr><td><span class="l1">Owen Pratt</span><span class="l2">Last active 8:15 AM</span></td><td class="tnum">4</td><td><span class="l1 pos">+ Release ≤ $25k · bills ≤ $35k</span><span class="l2 warn">− Connect feeds · used 6 days ago</span></td><td><span class="tag tag--warn">S1 · S6 · S7</span></td></tr>
<tr class="more"><td colspan="4">Owen connected Metro Heating &amp; Cooling’s new Ramp account on Oct 13. After this, he’ll need to ask a tenant admin. He’s told when v6 goes live.</td></tr></tbody></table>
<h4>Justification for the soft conflicts</h4>
<div class="grid-12" style="row-gap:8px"><label class="field" style="grid-column:span 7"><span class="field-label">Why managers need release · attached to 9 exceptions</span><textarea class="textarea" rows="2">Covers small vendor runs when Nora is out. Bigger runs still go to her.</textarea></label>
<label class="field" style="grid-column:span 5"><span class="field-label">Compensating control</span><textarea class="textarea" rows="2">Nora reviews the release report every Friday.</textarea></label></div>
<p class="field-help" style="margin-top:6px">Exceptions expire Oct 19, 2027 and come up in every access review until then.</p>
<h4>When</h4>
<div class="when" role="radiogroup" aria-label="When"><label class="opt-card"><input type="radio" name="when" checked><span class="t-head">After approval</span><p>Goes live the moment the second approver says yes.</p></label>
<label class="opt-card"><input type="radio" name="when"><span class="t-head">On a date</span><p>Schedule for Nov 2, start of the October close.</p></label></div>
<label class="field" style="margin-top:12px"><span class="field-label">Reason · required, shown in the access log</span><textarea class="textarea" rows="2" id="pub-reason">Managers release vendor runs up to $25k so Clive and Swan Creek don’t wait on Nora’s travel days.</textarea></label>
<div class="inline-notice inline-notice--info" style="margin-top:12px">{ico("shield")}<div><b>This needs a second approver.</b> It adds a way to move money. Nora Lindqvist (CFO) or Erin Vance (Controller) can approve; you can’t approve your own change.</div></div>
<div class="prog" id="pub-prog" hidden><span class="meter meter--lg" role="img" aria-label="Waiting for approval"><i class="on"></i><i class="cur"></i><i></i></span><span><b>Sent to Nora Lindqvist</b> · access rebuilds for 3 people once she approves (about 10 seconds)</span></div>
</div>
<aside class="pub-side" aria-labelledby="vh"><h4 id="vh">Version history</h4>
<ul class="versions"><li><span class="vno">6</span><span><span class="b">Draft</span><span class="l2">Today · Mike Heilman</span></span><span class="tag tag--ai">This</span></li>
<li class="is-current"><span class="vno">5</span><span><span class="b">Current</span><span class="l2">Oct 2 · bills limit to $25k</span></span><span></span></li>
<li><span class="vno">4</span><span><span class="b">Sep 3</span><span class="l2">Can publish dashboards</span></span><button class="btn btn--quiet" type="button">Restore</button></li>
<li><span class="vno">3</span><span><span class="b">Aug 14</span><span class="l2">Write-off approval off</span></span><button class="btn btn--quiet" type="button">Restore</button></li>
<li><span class="vno">1</span><span><span class="b">Aug 1</span><span class="l2">Cloned from template v4</span></span><button class="btn btn--quiet" type="button">Restore</button></li></ul>
<p class="t-cap" style="margin-top:12px">Restoring publishes the old grants as a new version. Nothing is deleted.</p>
<h4 style="margin-top:24px">Checks</h4>
<ul class="why"><li><b>No hard conflicts.</b> Payroll release was removed.</li><li><b>Within the catalog.</b> Every capability is in your plan.</li><li class="against"><b>Doesn’t widen your access.</b> You don’t hold this role.</li></ul>
</aside></div>
<div class="dialog-foot"><span class="t-cap" id="pub-sum">3 changes · 3 people · 9 exceptions · after approval</span><span class="sp"></span><button class="btn" type="button">Back to draft</button><button class="btn btn--primary" type="button" id="pub-go">Send v6 for approval</button></div>
</div></div>"""


JS = r"""<script>
""" + js_data(v5=AM_V5, p4=patch(AM_V5, AM_TPL4), p5=patch(AM_V5, AM_TPL5), pd=patch(AM_V5, AM_DRAFT), limV5=LIMITS_V5, limDraft=LIMITS_DRAFT) + "\nMB.tpl4=Object.assign({},MB.v5,MB.p4);MB.tpl5=Object.assign({},MB.v5,MB.p5);MB.draft=Object.assign({},MB.v5,MB.pd);\n" + MATRIX_JS + r"""
(function(){
  var g=JSON.parse(JSON.stringify(MB.draft)),lim=JSON.parse(JSON.stringify(MB.limDraft)),base=MB.tpl4,sel='pay.batches:R';
  var tbl=document.getElementById('mx');tbl.insertAdjacentHTML('beforeend',MBM.head(true));
  var q=document.getElementById('mx-q'),chg=document.getElementById('mx-chg');
  function changed(k){return (g[k]||'')!==(base[k]||'')}
  function draw(){
    var hits=MBM.sodHits(g),t=q.value.trim().toLowerCase();
    MBM.render(tbl,{grants:g,base:base,limits:lim,edit:true,hits:hits,sel:sel,idp:'b',
      only:function(k){var c=MBM.CAT[k];if(chg.checked&&!changed(k))return false;if(t&&(c.label+' '+c.domL+' '+k).toLowerCase().indexOf(t)<0&&!(t.indexOf('releas')>-1&&c.acts.indexOf('R')>-1))return false;return true}});
    var vis=tbl.querySelectorAll('tr.capm-res').length;document.getElementById('mx-count').textContent=vis+' of '+MBM.ORDER.length+' capabilities';
    /* domain counts */
    document.querySelectorAll('.doms a[data-dom]').forEach(function(a){var d=a.dataset.dom,n=0,c=false;
      MBM.ORDER.forEach(function(k){if(MBM.CAT[k].dom===d){n+=MBM.norm(g[k]||'',MBM.CAT[k].acts).length;if(changed(k))c=true}});
      a.querySelector('.n').textContent=n;a.classList.toggle('has-chg',c);a.title=c?'Changed vs template':''});
    /* SoD strip */
    var held=hits.filter(function(r){return MBM.sodHits(MB.v5).some(function(x){return x.id===r.id})}),fresh=hits.filter(function(r){return held.indexOf(r)<0});
    fresh.sort(function(a,b){return (b.hard?1:0)-(a.hard?1:0)});
    var hardR=fresh.filter(function(r){return r.hard}),softR=fresh.filter(function(r){return !r.hard});
    var h=hardR.map(function(r){
      var caps=r.need.map(function(n){return '<b>'+MBM.esc(MBM.capName(n))+'</b>'}).join(' + ');
      var acts=r.need.map(function(n){var p=n.split(':');return '<button class="btn" type="button" data-rm="'+n+'">Remove '+MBM.esc(MBM.CAT[p[0]].label.toLowerCase().replace(/s$/,''))+' '+MBM.esc(MBM.AN[p[1]].toLowerCase())+'</button>'}).join('');
      return '<div class="sod-row sod-row--hard" data-need="'+r.need.join(' ')+'"><span class="sod-code">'+r.id+'</span><p><b>Blocks publishing. '+MBM.esc(r.t)+':</b> '+caps+'. Hard for firms.</p><span class="btn-row" style="flex-wrap:nowrap">'+acts+'</span></div>'}).join('');
    if(softR.length){var open=window.__sodOpen;
      h+='<div class="sod-row sod-row--soft" data-need="'+softR.map(function(r){return r.need.join(' ')}).join(' ')+'"><span class="sod-code">'+softR.map(function(r){return r.id}).join(' ')+'</span><div><p><b>'+softR.length+' soft conflict'+(softR.length>1?'s':'')+'.</b> Holders will need a written justification when you publish.</p>'+
        (open?'<div class="sod-more">'+softR.map(function(r){return '<span class="t-cap" data-need="'+r.need.join(' ')+'"><b class="warn">'+r.id+'</b> '+MBM.esc(r.t)+'</span>'}).join('')+'</div>':'')+
        '</div><button class="btn btn--quiet" type="button" id="sod-tg" aria-expanded="'+(open?'true':'false')+'">'+(open?'Hide':'Show')+' rules</button></div>';}
    document.getElementById('sod').innerHTML=h;
    var nh=fresh.filter(function(r){return r.hard}).length,ns=fresh.length-nh;
    var pb=document.getElementById('publish');if(nh){pb.setAttribute('aria-disabled','true');pb.title='Resolve the hard conflict first'}else{pb.removeAttribute('aria-disabled');pb.title=''}
    document.getElementById('ctx-sod').textContent=nh?(nh+' conflict blocks publishing'):(ns?ns+' soft conflicts · justification needed':'No conflicts');
    document.getElementById('ctx-sod').className=nh?'neg':'';
    var nchg=MBM.ORDER.filter(function(k){return (g[k]||'')!==(MB.v5[k]||'')}).length+(lim['ap.bills:A']!==MB.limV5['ap.bills:A']?1:0);
    document.getElementById('draft-tag').textContent='Draft v6 · '+nchg+' change'+(nchg===1?'':'s');document.getElementById('tab-diff').textContent=nchg;
    selPanel();
  }
  function selPanel(){var p=sel.split(':'),c=MBM.CAT[p[0]],on=(g[p[0]]||'').indexOf(p[1])>-1;
    document.getElementById('sel-name').textContent=c.label+' · '+MBM.AN[p[1]];
    document.getElementById('sel-glyph').className='cap cap--sm'+(on?' is-on':'')+(on&&lim[sel]?' is-lim':'');
    var b=(base[p[0]]||'').indexOf(p[1])>-1,v=(MB.v5[p[0]]||'').indexOf(p[1])>-1;
    document.getElementById('sel-note').textContent=(on?'Granted':'Not granted')+'. '+(on===v?'Same as v5':(on?'Added in this draft':'Removed in this draft'))+'; '+(on===b?'same as template v4.':(on?'not in template v4.':'template v4 grants it.'));
    var money=/[APR]/.test(p[1]);document.getElementById('sec-lim').hidden=!(on&&money);
    document.getElementById('lim-day-f').hidden=p[1]!=='R';
  }
  tbl.addEventListener('click',function(e){var b=e.target.closest('button.cap');if(!b)return;var p=b.dataset.c.split(':'),k=p[0],a=p[1],cur=g[k]||'';
    if(sel===b.dataset.c||cur.indexOf(a)<0){cur=cur.indexOf(a)>-1?cur.replace(a,''):cur+a;if(a!=='V'&&cur&&cur.indexOf('V')<0)cur='V'+cur;g[k]=MBM.norm(cur,MBM.CAT[k].acts)}
    sel=b.dataset.c;draw();var nb=tbl.querySelector('[data-c="'+sel+'"]');if(nb)nb.focus()});
  tbl.addEventListener('change',function(e){var s=e.target.closest('select[data-preset]');if(!s)return;var k=s.dataset.preset;g[k]=MBM.applyPreset(MBM.CAT[k].acts,s.value);draw()});
  document.getElementById('sod').addEventListener('click',function(e){if(e.target.closest('#sod-tg')){window.__sodOpen=!window.__sodOpen;draw();return}var b=e.target.closest('[data-rm]');if(!b)return;var p=b.dataset.rm.split(':');g[p[0]]=(g[p[0]]||'').replace(p[1],'');delete lim[b.dataset.rm];
    draw();mbToast('Removed '+MBM.capName(b.dataset.rm).toLowerCase(),function(){g[p[0]]=MBM.norm((g[p[0]]||'')+p[1],MBM.CAT[p[0]].acts);draw()})});
  document.getElementById('sod').addEventListener('mouseover',function(e){var r=e.target.closest('[data-need]');tbl.querySelectorAll('.cap.is-lit').forEach(function(c){c.classList.remove('is-lit')});if(!r||!r.dataset.need)return;
    r.dataset.need.split(' ').forEach(function(n){var c=tbl.querySelector('[data-c="'+n+'"]');if(c)c.classList.add('is-lit')})});
  document.getElementById('sel-remove').onclick=function(){var p=sel.split(':');g[p[0]]=(g[p[0]]||'').replace(p[1],'');draw()};
  q.addEventListener('input',function(){clearTimeout(q._t);q._t=setTimeout(draw,150)});chg.addEventListener('change',draw);
  document.querySelector('.doms').addEventListener('click',function(e){var a=e.target.closest('a[data-dom]');if(!a)return;e.preventDefault();
    var r=document.getElementById('b-'+a.dataset.dom.replace(/\W/g,''));if(r){var s=document.getElementById('mx-scroll');s.scrollTop=r.offsetTop-0}});
  var sc=document.getElementById('mx-scroll');sc.addEventListener('scroll',function(){var top=sc.scrollTop+4,cur=null;tbl.querySelectorAll('tr.capm-dom').forEach(function(r){if(r.offsetTop<=top)cur=r.id});
    document.querySelectorAll('.doms a').forEach(function(a){a.setAttribute('aria-current',String('b-'+(a.dataset.dom||'').replace(/\W/g,'')===cur))})});
  document.getElementById('save').onclick=function(){document.getElementById('ctx-saved').textContent='Draft v6 saved just now';mbToast('Saved draft v6')};
  document.getElementById('publish').onclick=function(){if(this.getAttribute('aria-disabled')==='true'){mbToast('Resolve S4 first: remove payroll release or employee-record edit');return}document.getElementById('f3').scrollIntoView({behavior:'smooth'})};
  draw();
  var pr=document.getElementById('b-Payments');if(pr)sc.scrollTop=pr.offsetTop;sc.dispatchEvent(new Event('scroll'));
  /* diff (three-way) */
  var dt=document.querySelector('#diff tbody'),rows=[],L5=MB.limV5,LD=MB.limDraft,pubG=JSON.parse(JSON.stringify(MB.draft));pubG['payroll.runs']='VCEA';
  var lastDom='';
  MBM.ORDER.forEach(function(k){var c=MBM.CAT[k];c.acts.split('').forEach(function(a){
    var cap=k+':'+a,v=(MB.v5[k]||'').indexOf(a)>-1,d=(pubG[k]||'').indexOf(a)>-1,t=(MB.tpl5[k]||'').indexOf(a)>-1;
    var lv=L5[cap],ld=LD[cap];
    if(v===d&&d===t&&lv===ld)return;
    function cell(on,l){return on?'<span class="dx"><span class="cap cap--sm is-on'+(l?' is-lim':'')+'"><i></i></span>'+(l?MBM.esc(l):'Granted')+'</span>':'<span class="dx gone"><span class="cap cap--sm"><i></i></span>Not granted</span>'}
    var t4=(MB.tpl4[k]||'').indexOf(a)>-1;var act=(t&&!d&&!t4)?'<button class="btn btn--quiet" type="button">Adopt</button>':(t&&!d&&t4)?'<span class="t-cap">Removed by you in v3</span>':((!t&&d&&!v)?'<span class="t-cap">Your change</span>':((v&&!d)?'<span class="t-cap">Removed in draft</span>':'<span class="t-cap">Your change</span>'));
    rows.push('<tr><td>'+(c.domL!==lastDom?MBM.esc(c.domL):'')+'</td><td><span class="l1">'+MBM.esc(c.label)+' · '+MBM.AN[a]+'</span></td><td>'+cell(v,v?lv:'')+'</td><td class="cur">'+cell(d,d?ld:'')+'</td><td>'+cell(t,t?lv:'')+'</td><td>'+act+'</td></tr>');lastDom=c.domL;})});
  dt.innerHTML=rows.join('');
  document.getElementById('pub-go').onclick=function(){if(!document.getElementById('pub-reason').value.trim()){mbToast('Add a reason to publish');return}
    this.disabled=true;this.textContent='Sent for approval';document.getElementById('pub-prog').hidden=false;document.getElementById('pub-sum').textContent='Waiting for Nora Lindqvist · v5 stays live until then';mbToast('Sent v6 to Nora Lindqvist for approval')};
})();
</script>"""


def build():
    h = head("S14 · Role builder", CSS)
    body = sheet_top("S14-role-builder.html") + '<main id="main" class="sheet">'
    body += board_h("S14", "05-RBAC §6.2 · A2", "Build a role, see who it touches before it ships",
                    "Mike gives the Accounting manager role release on pay runs up to $25,000. The matrix marks every cell against the template it came from; the duties strip catches the payroll conflict before publishing can; the panel holds the limit, the clients, the masking and the sign-in rules. Click any cell, or a <i>Remove</i> button in the red row.",
                    "S14.1")
    body += '<div style="margin-top:16px">' + legend() + '</div>'
    body += frame(builder_frame(), 1180, "Builder · app rail collapsed to 64px so the matrix gets 840px. Cells that don’t apply to a resource are absent, not greyed.", "Live: cells, presets, search, changes-only, removing a conflict, Save draft", "f1")
    body += '<div class="anno"><div><b>Shape, not colour</b><p>Filled means granted; the cut corner means a limit sits on it; the small square top right marks a change from the template. Each reads in greyscale.</p></div><div><b>Hard blocks, soft asks</b><p>S4 is hard for firms, so Publish stays off and the row names both cells with a fix for each. Soft rules ask for one justification at publish.</p></div><div><b>Already-known conflicts stay quiet</b><p>S5 was in v5 with exceptions on file, so it sits in a grey row and doesn’t nag.</p></div><div><b>Limits live on the grant</b><p>The panel opens on the cell you click and only offers constraints that capability supports.</p></div></div>'
    body += '<div class="pair-h"><h2 class="t-section">Diff</h2><span class="t-cap">Published ↔ draft ↔ latest template, differences only</span></div>'
    body += frame(diff_frame(), 760, "Three-way diff after payroll release is removed. “Adopt” pulls one change from the new template into the draft.", "S14.2")
    body += '<div class="pair-h"><h2 class="t-section">Review &amp; publish</h2><span class="t-cap">People affected, justification, second approver</span></div>'
    body += frame(publish_frame(), 1140, "Dialog 960px. Per-person gains and losses, the one warning that matters (Owen used what he’s losing), and why a second person must say yes.", "S14.3 · press Send to see the waiting state", "f3")
    body += '</main>'
    return h + body + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S14-role-builder.html")
    open(out, "w").write(build())
    print("wrote", out, len(build()))
