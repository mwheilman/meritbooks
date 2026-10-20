"""S14 · Role builder (05 §6.2 A2). A role has two states in the UI: Current (what its holders have now)
and Proposed changes (one editable draft). Versions stay in History, one click away."""
from acc_common import *
from acc_data import js_data, AM_V5, AM_DRAFT, LIMITS_V5, LIMITS_DRAFT
from acc_matrix import MATRIX_JS


def patch(a, b):
    return {k: v for k, v in b.items() if a.get(k) != v}


CSS = """
.b-main{display:flex;flex-direction:column;height:calc(100% - 32px)}
.b-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:20px 32px 0}
.b-head .desc{color:var(--ink-2);margin-top:6px;max-width:72ch}
.b-tabs{display:flex;align-items:flex-end;gap:16px;padding:0 32px;margin-top:16px;border-bottom:1px solid var(--line)}
.b-tabs .tabs{border-bottom:0}
.b-tabs .sp{flex:1}
.b-tabs>.btn{margin-bottom:4px}
.b-tabs .tab .n.is-chg{color:var(--electric);font-weight:600}
.b-body{flex:1;min-height:0;display:grid;grid-template-columns:200px minmax(0,1fr) 336px}
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
.capm col.c-act{width:60px}
.capm td:first-child .l2{white-space:normal}
.cur-note{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 16px;background:var(--canvas);border-bottom:1px solid var(--line);color:var(--ink-2)}
.cur-note .ico{color:var(--ink-2);flex:none}
.sod-row .btn-row{flex-wrap:nowrap}
.sod-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.sod-list>div{display:flex;align-items:center;gap:12px;justify-content:space-between}
.sod-list p{flex:1;min-width:0}
.b-panel{border-left:1px solid var(--line-2);min-width:0;overflow:hidden}
.b-panel .panel-body{padding-bottom:32px}
.pfs{border:0;margin:0;padding:0;min-width:0}
.pfs[disabled]{opacity:.62}
.pol{display:grid;grid-template-columns:minmax(0,1fr) 128px;align-items:center;gap:8px 12px}
.pol .select{height:32px}
.pol dt{color:var(--ink-2)}
.lim2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.lim2 .field-label{white-space:nowrap}
.rads{display:flex;flex-direction:column}
.sel-h{display:flex;align-items:center;gap:8px}
.sel-h .t-head{flex:1;min-width:0}
.bar .ctx{flex:none}
.sum{table-layout:fixed;width:100%}
.sum td,.sum th{height:48px;padding:0 12px;border-bottom:1px solid var(--line)}
.sum th{height:40px;border-bottom:1px solid var(--electric);font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left}
.sum tr.g td{height:40px;background:var(--canvas)}
.sum td.prop{background:var(--sky)}
.sum .gone{color:var(--ink-3)}
.sum .why{color:var(--ink-2);font-size:12px;line-height:16px;display:block;margin-top:2px}
.dx{display:inline-flex;align-items:center;gap:8px}
.pubwrap{height:100%;background:rgba(10,22,40,.48);display:flex;justify-content:center;align-items:flex-start;padding-top:32px}
.pub{width:1000px}
.pub-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px}
.pub-main{padding:8px 24px 24px;min-width:0}
.pub-side{padding:16px 20px 24px;background:var(--canvas);border-left:1px solid var(--line);min-width:0}
.pub h4{display:flex;align-items:baseline;gap:8px;font:600 12px/16px var(--f-text);letter-spacing:.12em;text-transform:uppercase;color:var(--ink);margin:20px 0 8px}
.pub h4 .t-cap{text-transform:none;letter-spacing:0;font-weight:400}
.pub-side h4:first-child{margin-top:0}
.chg{list-style:none;border-top:1px solid var(--line)}
.chg li{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:center;min-height:44px;padding:4px 0;border-bottom:1px solid var(--line)}
.chg .pm{font-weight:700;text-align:center}
.ppl{table-layout:fixed;width:100%}
.ppl td,.ppl th{padding:0 8px;height:48px;border-bottom:1px solid var(--line);vertical-align:middle}
.ppl th{height:32px;font:500 12px/16px var(--f-text);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left;white-space:nowrap}
.ppl tr>*:first-child{padding-left:0}
.ppl tr.more td{height:auto;padding:6px 8px 12px 0;color:var(--ink-2)}
.cfl{list-style:none;border-top:1px solid var(--line)}
.cfl li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.cfl li .ico{color:var(--warn)}
.cfl .fixline{display:block;color:var(--ink-2);margin-top:2px}
.cfl li.is-fixed{color:var(--ink-3)}
.cfl li.is-fixed .ico{color:var(--pos)}
.cfl li.is-fixed b{color:var(--ink-2)}
.keepwhy{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:12px;margin-top:12px}
.when{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.prog{display:flex;align-items:center;gap:12px;margin-top:8px}
.appr{list-style:none}
.appr li{display:flex;align-items:center;gap:10px;min-height:44px;border-bottom:1px solid var(--line)}
.appr .avatar{width:28px;height:28px;font-size:11px}
.smalls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:32px;height:100%;background:var(--canvas)}
.hist{background:var(--white);border:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.hist-h{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.hist-h .sp{flex:1}
.hist ol{list-style:none;padding:0 20px}
.hist li{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:12px;align-items:start;padding:12px 0;border-bottom:1px solid var(--line)}
.hist li:last-child{border-bottom:0}
.hist .d{font-weight:600;font-variant-numeric:tabular-nums}
.hist p{color:var(--ink-2)}
.hist .now{font-weight:600;color:var(--pos)}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:32px 24px;border:1px dashed var(--grey-400);background:var(--white)}
"""


def ctxline(saved_id=True, saved="Proposed changes saved 9:04 AM"):
    sid = ' id="ctx-saved"' if saved_id else ""
    return (f'<div class="ctxline"><span>3 people on 13 clients</span><span class="sl">//</span><span>Internal staff</span><span class="sl">//</span>'
            f'<span>Current since Oct 2</span><span class="sl">//</span><span{sid}>{saved}</span><span class="sp"></span>'
            f'<button class="btn btn--quiet" type="button">{ico("history")}History</button><button class="btn btn--quiet" type="button">{ico("log")}Access log</button></div>')


def head_block(live=True):
    i = (lambda x: f' id="{x}"') if live else (lambda x: "")
    return f"""<div class="b-head"><div style="min-width:0">
<div class="eyebrow">Settings<span class="sl">//</span>Access &amp; roles</div>
<h1 class="t-title" style="margin-top:4px">Accounting manager</h1>
<p class="desc">Runs the close across assigned clients, reviews bookkeepers’ work, approves bills and pay runs inside a limit, and hands out client access within their own.</p></div>
<div class="btn-row" style="flex-wrap:nowrap;flex:none"><button class="btn btn--quiet" type="button"{i("discard")}>Discard changes</button>
<button class="btn" type="button"{i("save")}>Save</button><button class="btn btn--primary" type="button"{' id="publish" aria-disabled="true" title="Fix the conflict that blocks publishing first"' if live else ''}>Review &amp; publish</button></div></div>"""


def tabs(sel, n_chg, live=True):
    def t(key, label, n=None, nid=""):
        a = "true" if key == sel else "false"
        nn = f'<span class="n tnum{" is-chg" if key == "prop" else ""}"{nid}>{n}</span>' if n is not None else ""
        return f'<button class="tab" role="tab" type="button" aria-selected="{a}" data-mode="{key}">{label}{nn}</button>'
    sug = (f'<button class="btn btn--quiet" type="button"{" id=sug-b" if live else ""}>{ico("info")}MeritBooks suggests 1 update</button>')
    return (f'<div class="b-tabs"><div class="tabs" role="tablist" aria-label="Role"{" id=mode" if live else ""}>'
            f'{t("cur", "Current")}{t("prop", "Proposed changes", n_chg, " id=tab-chg" if live else "")}{t("ppl", "People", 3)}</div>'
            f'<span class="sp"></span>{sug}</div>')


def builder_frame():
    doms = "".join(f'<a href="#" data-dom="{d[0]}">{E({"Tenant": "Settings"}.get(d[0], d[0]))}<span class="n tnum"></span></a>' for d in __import__("acc_data").CATALOG)
    panel = f"""<aside class="panel b-panel" aria-label="Limits and settings for the selected permission">
<div class="panel-head"><div class="eyebrow">Selected permission</div>
<div class="sel-h" style="margin-top:8px"><span class="cap is-on is-lim cap--sm" id="sel-glyph"><i></i></span><span class="t-head" id="sel-name">Pay runs · Release</span>{ico("money",14,label="Moves money")}{ico("lock",14,label="Re-verify to use")}</div>
<p class="t-cap" id="sel-note" style="margin-top:4px">Proposed: add. Nobody with this role can release pay runs today.</p></div>
<div class="panel-body"><fieldset class="pfs" id="pfs">
<section class="panel-sec" id="sec-lim"><div class="panel-sec-h"><h3>Dollar limit</h3></div>
<div class="lim2"><label class="field"><span class="field-label">Per pay run</span><input class="input input--money" id="lim-item" value="25,000.00" inputmode="decimal"></label>
<label class="field" id="lim-day-f"><span class="field-label">Per day, per client</span><input class="input input--money" id="lim-day" value="60,000.00" inputmode="decimal"></label></div>
<p class="field-help" style="margin-top:8px">Over the limit, the button reads “Release up to your limit → route to Nora Lindqvist”.</p>
<div class="inline-notice" style="margin-top:12px">{ico("lock")}<div>Releasing always asks for a fresh sign-in check within 10 minutes. MeritBooks rule; can’t be turned off.</div></div>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--danger" type="button" id="sel-remove">Remove this permission</button></div></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Which clients</h3></div>
<div class="rads" role="radiogroup" aria-label="Which clients by default"><label class="radio"><input type="radio" name="sc" checked><i></i>The clients each person is assigned to</label><label class="radio"><input type="radio" name="sc"><i></i>All clients</label><label class="radio"><input type="radio" name="sc"><i></i>A client set</label></div>
<p class="field-help" style="margin-top:4px">Each client is one legal company. Seeing a parent never shows its subsidiaries.</p></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Departments &amp; jobs</h3></div>
<label class="field"><span class="sr">Department restriction</span><select class="select"><option selected>No restriction</option><option>Their departments · edit only</option><option>Their departments · see and edit</option><option>Chosen jobs…</option></select></label></section>
<section class="panel-sec"><div class="panel-sec-h"><h3>Sensitive fields</h3></div>
<dl class="pol"><dt>Pay rates &amp; payroll lines</dt><dd><select class="select" aria-label="Pay rates"><option>Hidden</option><option selected>Grouped</option><option>Visible</option></select></dd>
<dt>SSN and TIN</dt><dd><select class="select" aria-label="SSN and TIN"><option>Hidden</option><option selected>Last 4</option><option>Reveal, logged</option><option>Visible</option></select></dd>
<dt>Bank &amp; routing numbers</dt><dd><select class="select" aria-label="Bank numbers"><option>Hidden</option><option selected>Last 4</option><option>Reveal, logged</option><option>Visible</option></select></dd>
<dt>Home address, birth date</dt><dd><select class="select" aria-label="Personal details"><option selected>Hidden</option><option>Visible</option></select></dd></dl>
<p class="field-help" style="margin-top:8px">A single person’s access can be made stricter than this, never looser.</p></section>
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
<p class="field-help" style="margin-top:8px">For internal staff. Fixed once the role is first published.</p></section>
</fieldset></div></aside>"""
    return f"""<div class="app app--frame app--mini density-cockpit" data-context="workspace">
{rail_mini("Settings")}
{bar_workspace('Settings<span class="sl">//</span>Access &amp; roles<span class="sl">//</span><b>Accounting manager</b>')}
<main class="main">{ctxline()}
<div class="b-main">{head_block()}
{tabs("prop", 4)}
<div class="b-body"><nav class="doms" aria-label="Areas"><span class="eyebrow">Areas</span>{doms}<span class="eyebrow">Not in your plan</span><p class="off">Projects (module 2). Its permissions appear here once Merit adds it.</p></nav>
<div class="mx"><div id="sod" class="sod" aria-live="polite"></div>
<div class="mx-tools"><label class="search">{ico("search")}<input id="mx-q" placeholder="Find a permission, e.g. release a payment" aria-label="Find a permission"></label>
<label class="switch" id="mx-chg-l"><input type="checkbox" id="mx-chg"><i></i>Only proposed changes</label><span class="sp"></span>
<span class="t-cap" id="mx-count"></span></div>
<div class="mx-scroll" id="mx-scroll"><table class="tbl capm" id="mx"><colgroup><col><col style="width:104px">{'<col class="c-act" style="width:60px">'*9}</colgroup></table></div></div>
{panel}</div></div></main></div>"""


def summary_frame():
    return f"""<div class="app app--frame app--mini density-cockpit" data-context="workspace">
{rail_mini("Settings")}
{bar_workspace('Settings<span class="sl">//</span>Access &amp; roles<span class="sl">//</span><b>Accounting manager</b>')}
<main class="main">{ctxline(False, "Proposed changes saved 9:11 AM")}
<div class="b-main">{head_block(False).replace('Review &amp; publish</button>', 'Review &amp; publish</button>', 1)}
{tabs("prop", 3, False)}
<div style="padding:16px 32px 24px;overflow:auto">
<div class="row" style="gap:16px;margin-bottom:12px"><label class="switch"><input type="checkbox" checked><i></i>Only proposed changes</label><span class="sp"></span><span class="t-cap">What 3 people have now, beside what they’d have after you publish.</span><button class="btn" type="button">{ico("download")}Export</button></div>
<table class="sum" id="sum"><colgroup><col style="width:200px"><col><col style="width:236px"><col style="width:300px"><col style="width:160px"></colgroup>
<thead><tr><th>Area</th><th>Permission</th><th>Current</th><th>Proposed</th><th></th></tr></thead><tbody></tbody></table>
<p class="t-cap" style="margin-top:12px">Suggestions from MeritBooks are optional. Adding one puts it in the proposed changes above; skipping hides it for this role.</p>
</div></div></main></div>"""


def publish_frame():
    return f"""<div class="pubwrap"><div class="dialog pub" role="dialog" aria-modal="true" aria-labelledby="pub-h">
<div class="dialog-head"><div class="eyebrow">Accounting manager<span class="sl">//</span>Proposed changes</div><h3 class="t-section" id="pub-h" style="margin-top:4px">Review and publish</h3></div>
<div class="pub-grid"><div class="pub-main">
<h4>What changes</h4>
<ul class="chg"><li><span class="pm pos" aria-label="Adds">+</span><span><span class="l1">Release pay runs</span><span class="l2">Up to $25,000 a run and $60,000 a day per client</span></span></li>
<li><span class="pm" aria-label="Changes">~</span><span><span class="l1">Approve bills</span><span class="l2">Limit goes from $25,000 to $35,000</span></span></li>
<li><span class="pm neg" aria-label="Removes">−</span><span><span class="l1">Connect bank and card feeds</span><span class="l2">Tenant admins keep it</span></span></li></ul>
<h4>People affected<span class="t-cap">3 people across 13 clients</span></h4>
<table class="ppl"><colgroup><col style="width:176px"><col style="width:72px"><col><col style="width:216px"></colgroup>
<thead><tr><th>Person</th><th>Clients</th><th>Gains</th><th>Loses</th></tr></thead><tbody>
<tr><td><span class="l1">Jordan Smith</span><span class="l2">Last active 9:41 AM</span></td><td class="tnum">13</td><td><span class="l1 pos">Release pay runs ≤ $25k</span><span class="l2">Bills ≤ $35k, was $25k</span></td><td><span class="l1 neg">Connect feeds</span><span class="l2">Never used</span></td></tr>
<tr><td><span class="l1">Grace Whitfield</span><span class="l2">Last active yesterday</span></td><td class="tnum">5</td><td><span class="l1 pos">Release pay runs ≤ $25k</span><span class="l2">Bills ≤ $35k, was $25k</span></td><td><span class="l1 neg">Connect feeds</span><span class="l2">Never used</span></td></tr>
<tr><td><span class="l1">Owen Pratt</span><span class="l2">Last active 8:15 AM</span></td><td class="tnum">4</td><td><span class="l1 pos">Release pay runs ≤ $25k</span><span class="l2">Bills ≤ $35k, was $25k</span></td><td><span class="l1 neg">Connect feeds</span><span class="l2 warn">Used 6 days ago</span></td></tr>
<tr class="more"><td colspan="4">Owen connected Metro Heating &amp; Cooling’s new Ramp account on Oct 13. After this he’ll ask a tenant admin instead. He’s told when the change goes live.</td></tr></tbody></table>
<section id="cf-sec" aria-labelledby="cf-h">
<h4 id="cf-h">Conflicts to settle<span class="t-cap" id="cf-n">3 open · fix each, or keep them with a reason</span></h4>
<ul class="cfl" id="cfl"></ul>
<div id="cf-keep"><p class="t-cap" style="margin-top:12px">Or keep the ones you haven’t fixed. Your reason is filed with each and comes up in every access review until Oct 19, 2027.</p>
<div class="keepwhy"><label class="field"><span class="field-label">Why managers need this</span><textarea class="textarea" rows="2">Covers small vendor runs when Nora is out. Bigger runs still go to her.</textarea></label>
<label class="field"><span class="field-label">What keeps it in check</span><textarea class="textarea" rows="2">Nora reviews the release report every Friday.</textarea></label></div></div>
</section>
<h4>When</h4>
<div class="when" role="radiogroup" aria-label="When"><label class="opt-card"><input type="radio" name="when" checked><span class="t-head">After approval</span><p>Goes live the moment the second approver says yes.</p></label>
<label class="opt-card"><input type="radio" name="when"><span class="t-head">On a date</span><p>Schedule for Nov 2, start of the October close.</p></label></div>
<label class="field" style="margin-top:12px"><span class="field-label">Reason · required, shown in the access log</span><textarea class="textarea" rows="2" id="pub-reason">Managers release vendor runs up to $25k so Clive and Swan Creek don’t wait on Nora’s travel days.</textarea></label>
<div class="prog" id="pub-prog" hidden><span class="meter meter--lg" role="img" aria-label="Waiting for approval"><i class="on"></i><i class="cur"></i><i></i></span><span><b>Sent to Nora Lindqvist.</b> Access updates for 3 people once she approves, in about 10 seconds.</span></div>
</div>
<aside class="pub-side" aria-labelledby="ap-h"><h4 id="ap-h">Who approves</h4>
<p class="ink-2">This adds a way to move money, so a second person must say yes. You can’t approve your own change.</p>
<ul class="appr" style="margin-top:8px"><li><span class="avatar" aria-hidden="true">NL</span><span><span class="l1">Nora Lindqvist</span><span class="l2">CFO</span></span></li>
<li><span class="avatar" aria-hidden="true">EV</span><span><span class="l1">Erin Vance</span><span class="l2">Controller</span></span></li></ul>
<h4 style="margin-top:24px">Checks</h4>
<ul class="why"><li><b>Nothing blocks publishing.</b> Payroll release was taken out.</li><li><b>Everything is in your plan.</b></li><li><b>Doesn’t widen your own access.</b> You don’t hold this role.</li></ul>
<p class="t-cap" style="margin-top:16px">Earlier versions are in History. Nothing is deleted.</p>
</aside></div>
<div class="dialog-foot"><span class="t-cap" id="pub-sum">3 changes · 3 people · goes live after Nora or Erin approves</span><span class="sp"></span><button class="btn" type="button">Back to proposed changes</button><button class="btn btn--primary" type="button" id="pub-go">Send for approval</button></div>
</div></div>"""


def smalls_frame():
    def h(d, who, what, act):
        a = f'<button class="btn btn--quiet" type="button">Restore</button>' if act else '<span class="now">Current</span>'
        return f'<li><span class="d">{d}</span><span><span class="l1">{what}</span><span class="l2">{who}</span></span>{a}</li>'
    items = (h("Oct 2", "Mike Heilman · “Bigger vendor runs at Clive”", "Bill approval limit raised to $25,000", False)
             + h("Sep 3", "Mike Heilman · “Managers own their team’s home”", "Can publish dashboard layouts", True)
             + h("Aug 14", "Erin Vance · “Write-offs go to the controller”", "Write-off approval turned off", True)
             + h("Aug 1", "Set up with Merit", "Started from the MeritBooks standard role", True))
    return f"""<div class="smalls"><section class="hist" aria-labelledby="hh"><div class="hist-h"><div><div class="eyebrow">Accounting manager</div><h3 class="t-head" id="hh" style="margin-top:4px">History</h3></div><span class="sp"></span><button class="btn btn--quiet btn--icon" type="button" aria-label="Close history">{ico("x")}</button></div>
<ol>{items}</ol><p class="t-cap" style="padding:12px 20px 16px">Restore copies an earlier version into proposed changes. It goes live only when you publish.</p></section>
<div><h3 class="t-section" style="color:var(--ink);margin-bottom:12px">Nothing proposed</h3>
<div class="empty"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">No proposed changes</span><p class="ink-2">3 people have this role as it is. Change any permission to start proposing; they keep what they have until you publish.</p><button class="btn" type="button">Start proposing changes</button></div></div></div>"""


JS = r"""<script>
""" + js_data(v5=AM_V5, pd=patch(AM_V5, AM_DRAFT), limV5=LIMITS_V5, limDraft=LIMITS_DRAFT,
              sugg={"k": "tax.sales_tax", "a": "P", "t": "Let managers post the monthly sales-tax entry", "w": "They already prepare it; today a controller posts it for them."}) + "\nMB.draft=Object.assign({},MB.v5,MB.pd);\n" + MATRIX_JS + r"""
(function(){
  var g=JSON.parse(JSON.stringify(MB.draft)),lim=JSON.parse(JSON.stringify(MB.limDraft)),cur=MB.v5,sel='pay.batches:R',mode='prop',mit={};
  var tbl=document.getElementById('mx');
  var q=document.getElementById('mx-q'),chg=document.getElementById('mx-chg');
  function changed(k){return (g[k]||'')!==(cur[k]||'')}
  var SHORT={'payroll.employees:E':'employee pay edits','payroll.runs:R':'payroll release','pay.vendor_bank_details:E':'vendor bank edits','pay.batches:R':'pay run release'};
  function lower(c){if(SHORT[c])return SHORT[c];var p=c.split(':');return MBM.CAT[p[0]].label.toLowerCase().replace(/s$/,'')+' '+MBM.AN[p[1]].toLowerCase()}
  function draw(){
    var edit=mode==='prop',G=edit?g:cur,L=edit?lim:MB.limV5;
    tbl.querySelector('thead')&&tbl.querySelector('thead').remove();tbl.querySelector('tbody')&&tbl.querySelector('tbody').remove();
    var cg=tbl.querySelector('colgroup');cg.innerHTML='<col>'+(edit?'<col style="width:104px">':'')+new Array(10).join('<col class="c-act" style="width:60px">');tbl.insertAdjacentHTML('beforeend',MBM.head(edit));
    var hits=edit?MBM.sodHits(g,mit):[],t=q.value.trim().toLowerCase();
    MBM.render(tbl,{grants:G,base:edit?cur:null,limits:L,edit:edit,hits:hits,sel:edit?sel:null,idp:'b',
      only:function(k){var c=MBM.CAT[k];if(edit&&chg.checked&&!changed(k))return false;if(t&&(c.label+' '+c.domL+' '+k).toLowerCase().indexOf(t)<0&&!(t.indexOf('releas')>-1&&c.acts.indexOf('R')>-1))return false;return true}});
    var vis=tbl.querySelectorAll('tr.capm-res').length;document.getElementById('mx-count').textContent=vis+' of '+MBM.ORDER.length+' permissions';
    document.getElementById('mx-chg-l').hidden=!edit;
    document.querySelectorAll('.doms a[data-dom]').forEach(function(a){var d=a.dataset.dom,n=0,c=false;
      MBM.ORDER.forEach(function(k){if(MBM.CAT[k].dom===d){n+=MBM.norm(G[k]||'',MBM.CAT[k].acts).length;if(edit&&changed(k))c=true}});
      a.querySelector('.n').textContent=n;a.classList.toggle('has-chg',c);a.title=c?'Has proposed changes':''});
    /* conflicts: only ones the proposal introduces; ones people already have today stay quiet */
    var known=MBM.sodHits(MB.v5).map(function(r){return r.id}),fresh=hits.filter(function(r){return known.indexOf(r.id)<0});
    var hardR=fresh.filter(function(r){return r.hard}),softR=fresh.filter(function(r){return !r.hard});
    var h='';
    if(!edit){h='<div class="cur-note"><svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-info"/></svg><span>This is what 3 people have today. To change it, switch to <b>Proposed changes</b>; nobody’s access moves until you publish.</span></div>'}
    else{
    h+=hardR.map(function(r){
      var acts=r.need.map(function(n){return '<button class="btn" type="button" data-rm="'+n+'">Remove '+MBM.esc(lower(n))+'</button>'}).join('');
      return '<div class="sod-row sod-row--hard" data-need="'+r.need.join(' ')+'"><span class="sod-mark"><svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-alert"/></svg></span><p><b>Blocks publishing.</b> '+MBM.esc(r.p)+'<span class="sod-fix">Suggested fix: remove one of the two.</span></p><span class="btn-row">'+acts+'</span></div>'}).join('');
    if(softR.length){var open=window.__sodOpen;
      h+='<div class="sod-row sod-row--soft" data-need="'+softR.map(function(r){return r.need.join(' ')}).join(' ')+'"><span class="sod-mark"><svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-alert"/></svg></span><div><p><b>'+softR.length+(hardR.length?' more':'')+(softR.length>1?' conflicts need':' conflict needs')+' a fix or a reason before publishing.</b> '+(open?'':softR.map(function(r){return MBM.esc(r.p.replace(/\.$/,'').replace(/^Could /,'').replace(/, so .*/,''))}).join(' · ')+'.')+'</p>'+
        (open?'<div class="sod-list">'+softR.map(function(r){return '<div data-need="'+r.need.join(' ')+'"><p>'+MBM.esc(r.p)+'<span class="sod-fix">Suggested fix: '+MBM.esc(r.fix[1].charAt(0).toLowerCase()+r.fix[1].slice(1))+'.</span></p><button class="btn" type="button" data-ctl="'+r.id+'">Use this fix</button></div>'}).join('')+'</div>':'')+
        '</div><button class="btn btn--quiet" type="button" id="sod-tg" aria-expanded="'+(open?'true':'false')+'">'+(open?'Hide fixes':'Show fixes')+'</button></div>';}
    }
    document.getElementById('sod').innerHTML=h;
    var nh=hardR.length;
    var pb=document.getElementById('publish');if(nh&&edit){pb.setAttribute('aria-disabled','true');pb.title='Fix the conflict that blocks publishing first'}else{pb.removeAttribute('aria-disabled');pb.title=''}
    var nchg=MBM.ORDER.filter(function(k){return (g[k]||'')!==(MB.v5[k]||'')}).length+(lim['ap.bills:A']!==MB.limV5['ap.bills:A']?1:0);
    document.getElementById('tab-chg').textContent=nchg;
    document.getElementById('pfs').disabled=!edit;
    selPanel();
  }
  function selPanel(){var p=sel.split(':'),c=MBM.CAT[p[0]],G=mode==='prop'?g:cur,on=(G[p[0]]||'').indexOf(p[1])>-1;
    document.getElementById('sel-name').textContent=c.label+' · '+MBM.AN[p[1]];
    document.getElementById('sel-glyph').className='cap cap--sm'+(on?' is-on':'')+(on&&lim[sel]?' is-lim':'');
    var now=(cur[p[0]]||'').indexOf(p[1])>-1;
    document.getElementById('sel-note').textContent=mode!=='prop'?(now?'People with this role have it today.':'Not part of this role today.'):
      (on===now?(on?'Granted, same as today.':'Not granted, same as today.'):(on?'Proposed: add. Nobody with this role has it today.':'Proposed: remove. People with this role have it today.'));
    var money=/[APR]/.test(p[1]);document.getElementById('sec-lim').hidden=!(on&&money);
    document.getElementById('lim-day-f').hidden=p[1]!=='R';
  }
  tbl.addEventListener('click',function(e){var b=e.target.closest('button.cap');if(!b||mode!=='prop')return;var p=b.dataset.c.split(':'),k=p[0],a=p[1],cr=g[k]||'';
    if(sel===b.dataset.c||cr.indexOf(a)<0){cr=cr.indexOf(a)>-1?cr.replace(a,''):cr+a;if(a!=='V'&&cr&&cr.indexOf('V')<0)cr='V'+cr;g[k]=MBM.norm(cr,MBM.CAT[k].acts)}
    sel=b.dataset.c;draw();var nb=tbl.querySelector('[data-c="'+sel+'"]');if(nb)nb.focus()});
  tbl.addEventListener('change',function(e){var s=e.target.closest('select[data-preset]');if(!s)return;var k=s.dataset.preset;g[k]=MBM.applyPreset(MBM.CAT[k].acts,s.value);draw()});
  document.getElementById('sod').addEventListener('click',function(e){
    if(e.target.closest('#sod-tg')){window.__sodOpen=!window.__sodOpen;draw();return}
    var c=e.target.closest('[data-ctl]');if(c){var r=MB.sod.filter(function(x){return x.id===c.dataset.ctl})[0];mit[r.id]=1;draw();mbToast('Added: '+r.fix[1].toLowerCase(),function(){delete mit[r.id];draw()});return}
    var b=e.target.closest('[data-rm]');if(!b)return;var p=b.dataset.rm.split(':');g[p[0]]=(g[p[0]]||'').replace(p[1],'');delete lim[b.dataset.rm];
    draw();mbToast('Removed '+lower(b.dataset.rm),function(){g[p[0]]=MBM.norm((g[p[0]]||'')+p[1],MBM.CAT[p[0]].acts);draw()})});
  document.getElementById('sod').addEventListener('mouseover',function(e){var r=e.target.closest('[data-need]');tbl.querySelectorAll('.cap.is-lit').forEach(function(c){c.classList.remove('is-lit')});if(!r||!r.dataset.need)return;
    r.dataset.need.split(' ').forEach(function(n){var c=tbl.querySelector('[data-c="'+n+'"]');if(c)c.classList.add('is-lit')})});
  document.getElementById('sel-remove').onclick=function(){var p=sel.split(':');g[p[0]]=(g[p[0]]||'').replace(p[1],'');draw();mbToast('Removed '+lower(sel))};
  q.addEventListener('input',function(){clearTimeout(q._t);q._t=setTimeout(draw,150)});chg.addEventListener('change',draw);
  document.getElementById('mode').addEventListener('click',function(e){var b=e.target.closest('[data-mode]');if(!b||b.dataset.mode==='ppl')return;mode=b.dataset.mode;
    this.querySelectorAll('[data-mode]').forEach(function(x){x.setAttribute('aria-selected',String(x===b))});draw()});
  document.querySelector('.doms').addEventListener('click',function(e){var a=e.target.closest('a[data-dom]');if(!a)return;e.preventDefault();
    var r=document.getElementById('b-'+a.dataset.dom.replace(/\W/g,''));if(r){var s=document.getElementById('mx-scroll');s.scrollTop=r.offsetTop-0}});
  var sc=document.getElementById('mx-scroll');sc.addEventListener('scroll',function(){var top=sc.scrollTop+4,c=null;tbl.querySelectorAll('tr.capm-dom').forEach(function(r){if(r.offsetTop<=top)c=r.id});
    document.querySelectorAll('.doms a').forEach(function(a){a.setAttribute('aria-current',String('b-'+(a.dataset.dom||'').replace(/\W/g,'')===c))})});
  document.getElementById('save').onclick=function(){document.getElementById('ctx-saved').textContent='Proposed changes saved just now';mbToast('Saved proposed changes')};
  document.getElementById('discard').onclick=function(){var keep=JSON.parse(JSON.stringify(g)),kl=JSON.parse(JSON.stringify(lim));g=JSON.parse(JSON.stringify(cur));lim=JSON.parse(JSON.stringify(MB.limV5));draw();
    mbToast('Discarded proposed changes',function(){g=keep;lim=kl;draw()})};
  document.getElementById('sug-b').onclick=function(){document.getElementById('f2').scrollIntoView({behavior:'smooth'})};
  document.getElementById('publish').onclick=function(){if(this.getAttribute('aria-disabled')==='true'){mbToast('First fix the conflict that blocks publishing: remove payroll release or employee pay edits');return}document.getElementById('f3').scrollIntoView({behavior:'smooth'})};
  draw();
  var pr=document.getElementById('b-Payments');if(pr)sc.scrollTop=pr.offsetTop;sc.dispatchEvent(new Event('scroll'));
  /* S14.2 summary: current vs proposed, differences only (after payroll release was taken out) */
  var st=document.querySelector('#sum tbody'),rows=[],pubG=JSON.parse(JSON.stringify(MB.draft));pubG['payroll.runs']='VCEA';
  function cell(on,l){return on?'<span class="dx"><span class="cap cap--sm is-on'+(l?' is-lim':'')+'"><i></i></span>'+(l?MBM.esc(l):'Granted')+'</span>':'<span class="dx gone"><span class="cap cap--sm"><i></i></span>Not granted</span>'}
  var lastDom='';
  MBM.ORDER.forEach(function(k){var c=MBM.CAT[k];c.acts.split('').forEach(function(a){
    var cp=k+':'+a,v=(MB.v5[k]||'').indexOf(a)>-1,d=(pubG[k]||'').indexOf(a)>-1,lv=MB.limV5[cp],ld=MB.limDraft[cp];
    if(v===d&&(lv||'')===(ld||''))return;
    rows.push('<tr><td>'+(c.domL!==lastDom?MBM.esc(c.domL):'')+'</td><td><span class="l1">'+MBM.esc(c.label)+': '+MBM.AN[a].toLowerCase()+'</span></td><td>'+cell(v,v?lv:'')+'</td><td class="prop">'+cell(d,d?ld:'')+'</td><td><button class="btn btn--quiet" type="button" data-undo-row>Undo</button></td></tr>');lastDom=c.domL;})});
  var S=MB.sugg,sc2=MBM.CAT[S.k];
  rows.push('<tr class="g"><td colspan="5"><span class="q-group-t">Suggested by MeritBooks</span><span class="t-cap">Optional</span></td></tr>');
  rows.push('<tr id="sg-row"><td>'+MBM.esc(sc2.domL)+'</td><td><span class="l1">'+MBM.esc(sc2.label)+': '+MBM.AN[S.a].toLowerCase()+'</span><span class="why">'+MBM.esc(S.w)+'</span></td><td>'+cell(false)+'</td><td>'+cell(true)+'</td><td><div class="btn-row" style="flex-wrap:nowrap"><button class="btn" type="button" id="sg-add">Add</button><button class="btn btn--quiet" type="button" id="sg-skip">Skip</button></div></td></tr>');
  st.innerHTML=rows.join('');
  function sgDone(add){var r=document.getElementById('sg-row');r.lastElementChild.innerHTML='<span class="t-cap">'+(add?'Added':'Skipped')+'</span>';if(add){r.children[3].classList.add('prop')}mbToast(add?'Added to proposed changes: managers post sales tax':'Skipped the suggestion')}
  document.getElementById('sg-add').onclick=function(){sgDone(true)};document.getElementById('sg-skip').onclick=function(){sgDone(false)};
  st.addEventListener('click',function(e){var b=e.target.closest('[data-undo-row]');if(!b)return;var tr=b.closest('tr');tr.style.opacity='.5';b.outerHTML='<span class="t-cap">Undone</span>';mbToast('Took this out of the proposed changes')});
  /* S14.3 publish: conflicts in one plain sentence each, with a fix */
  var CF=MB.sod.filter(function(r){return ['S1','S6','S7'].indexOf(r.id)>-1}),fixed={};
  function cf(){var open=CF.filter(function(r){return !fixed[r.id]}).length;
    document.getElementById('cfl').innerHTML=CF.map(function(r){var f=fixed[r.id];return '<li class="'+(f?'is-fixed':'')+'"><svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-'+(f?'check':'alert')+'"/></svg><span><b>'+MBM.esc(r.p)+'</b><span class="fixline">'+(f?'Fixed: ':'Suggested fix: ')+MBM.esc(r.fix[1].charAt(0).toLowerCase()+r.fix[1].slice(1))+'.</span></span>'+(f?'<button class="btn btn--quiet" type="button" data-unfix="'+r.id+'">Undo</button>':'<button class="btn" type="button" data-fix="'+r.id+'">Use this fix</button>')+'</li>'}).join('');
    document.getElementById('cf-n').textContent=open?open+' open · fix each, or keep them with a reason':'All fixed';
    document.getElementById('cf-keep').hidden=!open;
    document.getElementById('pub-sum').textContent='3 changes · 3 people · '+(open?open+' kept with a reason · ':'')+'goes live after Nora or Erin approves';
    if(!open){setTimeout(function(){if(!CF.some(function(r){return !fixed[r.id]}))document.getElementById('cf-sec').hidden=true},900)}else document.getElementById('cf-sec').hidden=false;}
  document.getElementById('cfl').addEventListener('click',function(e){var b=e.target.closest('[data-fix],[data-unfix]');if(!b)return;if(b.dataset.fix){fixed[b.dataset.fix]=1;mbToast('Added the fix to the proposed changes')}else delete fixed[b.dataset.unfix];cf()});
  cf();
  document.getElementById('pub-go').onclick=function(){if(!document.getElementById('pub-reason').value.trim()){mbToast('Add a reason to publish');return}
    this.disabled=true;this.textContent='Sent for approval';document.getElementById('pub-prog').hidden=false;document.getElementById('pub-sum').textContent='Waiting for Nora Lindqvist · people keep their current access until then';mbToast('Sent to Nora Lindqvist for approval')};
})();
</script>"""


def build():
    h = head("S14 · Role builder", CSS)
    body = sheet_top("S14-role-builder.html") + '<main id="main" class="sheet">'
    body += board_h("S14", "05-RBAC §6.2 · A2", "Change a role, see who it touches before it ships",
                    "Mike proposes that Accounting managers can release pay runs up to $25,000. A role has two tabs: <i>Current</i>, what its 3 holders have today, and <i>Proposed changes</i>, the one draft he edits. The red row catches a conflict in plain words before publishing can; the panel holds the limit, the clients, the masking and the sign-in rules. Click any cell, or a <i>Remove</i> button in the red row.",
                    "S14.1")
    body += '<div style="margin-top:16px">' + legend() + '</div>'
    body += frame(builder_frame(), 1180, "Proposed changes tab · app rail collapsed to 64px so the matrix gets 840px. Cells that don’t apply to a resource are absent, not greyed.", "Live: Current ↔ Proposed, cells, presets, search, only-changes, the fixes in both rows, Save, Discard", "f1")
    body += '<div class="anno"><div><b>Current and Proposed</b><p>Two tabs, two words. Current is read-only and is what people have; Proposed changes is where editing happens. The count on the tab is the number of changes.</p></div><div><b>Conflicts in one sentence</b><p>No rule codes. The red row says what someone could do and the fix; publishing waits until it’s fixed. The amber row lists the rest, each with a suggested fix.</p></div><div><b>Old conflicts stay quiet</b><p>Reopening a month and posting into it is already allowed today, with reasons on file, so it doesn’t nag here.</p></div><div><b>History is one click</b><p>Versions live behind the quiet History button in the status line, not in the header.</p></div></div>'
    body += '<div class="pair-h"><h2 class="t-section">Only proposed changes</h2><span class="t-cap">Current beside Proposed, nothing else</span></div>'
    body += frame(summary_frame(), 640, "The same tab with “Only proposed changes” on, after payroll release was taken out. The MeritBooks suggestion is a single optional row with Add or Skip.", "S14.2", "f2")
    body += '<div class="pair-h"><h2 class="t-section">Review &amp; publish</h2><span class="t-cap">People affected, conflicts in plain words, a second approver</span></div>'
    body += frame(publish_frame(), 1320, "Each conflict is one sentence with a fix. Fix all three and the section disappears; keep any and one reason is filed with them.", "S14.3 · try Use this fix, then Send", "f3")
    body += '<div class="pair-h"><h2 class="t-section">History, and nothing proposed</h2></div>'
    body += frame(smalls_frame(), 400, "History opens from the status line. Restore never goes live by itself: it becomes the proposed changes.", "S14.4")
    body += '</main>'
    return h + body + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S14-role-builder.html")
    open(out, "w").write(build())
    print("wrote", out, len(build()))
