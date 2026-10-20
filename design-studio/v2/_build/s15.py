"""S15 · One person's access (05 §6.3 A3, §6.7 A7, §5.6 view-as, §6.11 request access)."""
from acc_common import *
from acc_data import js_data
from acc_matrix import MATRIX_JS

BK = {"gl.accounts": "VC", "gl.journal_entries": "VCED", "gl.recurring_entries": "VCED", "gl.periods": "V", "gl.dimensions": "V",
      "close.checklist": "VE", "close.package": "V", "bank.transactions": "VEAX", "bank.rules": "VCED", "bank.statements": "VC",
      "bank.reconciliations": "VCEX", "cards.transactions": "VEAX", "ap.bills": "VCEDX", "ap.vendor_credits": "VC", "ap.purchase_orders": "VCED",
      "pay.batches": "V", "pay.checks": "V", "pay.customer_payments": "VCE", "exp.receipts": "VCED", "exp.reports": "VCE",
      "ar.invoices": "VCEDRX", "ar.credit_memos": "VC", "ar.estimates": "VCEDR", "ar.collections": "VER", "ar.statements": "VR",
      "payroll.register": "VCP", "tax.sales_tax": "VE", "tax.1099": "VCE",
      "reports.financial": "VX", "reports.saved_views": "VCED", "ctl.exceptions": "VE", "mdm.vendors": "VCED", "mdm.customers": "VCED",
      "docs.documents": "VCDX", "req.client_requests": "VCER", "ai.assist": "V", "home.workspace": "V"}
SR = dict(BK); SR["bank.reconciliations"] = "VCEAX"; SR["gl.journal_entries"] = "VCEDP"; SR["ap.bills"] = "VCEDAX"
YE = {"gl.year_end": "VP", "gl.periods": "VE", "close.checklist": "VEA"}
CLIENTS = {
 "metro": {"n": "Metro Heating & Cooling", "c": "C-106", "src": [["Senior bookkeeper v3", "HVAC clients set", "role", "SR"]], "mute": []},
 "heartland": {"n": "Heartland Heating & Cooling", "c": "C-103", "src": [["Senior bookkeeper v3", "HVAC clients set", "role", "SR"]], "mute": []},
 "dorrian": {"n": "Dorrian HVAC", "c": "C-105", "src": [["Senior bookkeeper v3", "HVAC clients set", "role", "SR"]], "mute": []},
 "crystal": {"n": "Crystal Kitchen & Bath", "c": "C-104", "src": [["Bookkeeper v1", "Crystal Kitchen & Bath", "role", "BK"], ["Year-end close v2", "Crystal Kitchen & Bath, until Jan 31", "set", "YE"]], "mute": []},
 "iowa": {"n": "Iowa Custom Cabinets", "c": "C-108", "src": [["Bookkeeper v1", "Iowa Custom Cabinets", "role", "BK"]], "mute": ["payroll.register"]},
}
LIM = {"gl.journal_entries:P": "≤ $10,000", "ap.bills:A": "≤ $10,000"}

CSS = """
.pa{display:grid;grid-template-columns:minmax(0,1fr) 368px;height:calc(100% - 32px)}
.pa-main{min-width:0;overflow:auto;padding:24px 32px 40px}
.who{display:flex;align-items:flex-start;gap:16px}
.who .av{width:48px;height:48px;display:grid;place-items:center;background:var(--grey-100);border:1px solid var(--line-2);font:600 15px/1 var(--f-text);flex:none}
.who .meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.sec-h{display:flex;align-items:baseline;gap:12px;margin:28px 0 8px}
.sec-h .sp{flex:1}
.asg{table-layout:fixed}
.asg td{height:52px}
.asg tr.q-group td{height:40px}
.asg .scope{display:inline-flex;align-items:center;gap:8px}
.asg .scope .t-cap{text-transform:none;letter-spacing:0;font-weight:400}
.mx-h{display:flex;align-items:center;gap:12px;margin:28px 0 8px}
.mx-h .select{width:260px}
.ex{border-left:1px solid var(--line-2);background:var(--white);display:flex;flex-direction:column;min-height:0}
.ex-b{flex:1;overflow:auto;padding:0 24px 24px}
.ex-f{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.ex-f .full{grid-column:1/3}
.fixes{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.fixes .btn{justify-content:flex-start;height:auto;min-height:32px;padding:6px 12px;white-space:normal;text-align:left}
.va{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:calc(100% - 32px)}
.va-main{padding:24px 32px;min-width:0;overflow:hidden}
.ro-btn{color:var(--ink-3)}
.dlgwrap{height:100%;background:rgba(10,22,40,.48);display:flex;justify-content:center;align-items:flex-start;padding-top:32px}
.aa{width:760px}
.aa h4{font:600 12px/16px var(--f-text);letter-spacing:.12em;text-transform:uppercase;color:var(--ink);margin:16px 0 8px}
.aa h4:first-child{margin-top:0}
.grant-l{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.gl{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;align-items:start;min-height:48px;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer}
.gl input{margin-top:3px;width:16px;height:16px;accent-color:var(--electric)}
.gl.is-no{cursor:not-allowed;color:var(--ink-3)}
.gl.is-no .l1{color:var(--ink-2)}
.gl .l2{white-space:normal}
.scope-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.chk-list{list-style:none;border:1px solid var(--line);background:var(--canvas);padding:4px 16px}
.chk-list li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:36px;border-bottom:1px solid var(--line)}
.chk-list li:last-child{border-bottom:0}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;padding:32px;height:100%;background:var(--canvas)}
.trio>section{background:var(--white);border:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.trio .hd{padding:16px 20px;border-bottom:1px solid var(--line)}
.trio .bd{padding:16px 20px;flex:1}
.f403{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.f403 .mark{width:48px;height:48px;border:1.5px solid var(--ink-2);display:grid;place-items:center;color:var(--ink-2)}
.req-card{border:1px solid var(--line);padding:16px;background:var(--white)}
"""


def assignments():
    def grp(scope, cap):
        return f'<tr class="q-group"><td colspan="5"><span class="scope"><span class="q-group-t">{scope}</span><span class="t-cap">{cap}</span></span></td></tr>'
    def r(role, kind, narrow, n2, dates, d2, by, b2, used, u2, extra=""):
        who = by + (" · ok’d " + b2.replace("Approved by ", "") if b2.startswith("Approved") else "")
        return (f'<tr class="q-row"{extra}><td><a class="l1" href="#">{role}</a><span class="l2">{kind}</span></td><td><span class="l1">{narrow}</span><span class="l2">{n2}</span></td>'
                f'<td><span class="l1 tnum">{dates}</span><span class="l2">{d2 if "left" in d2 else "by " + who}</span></td>'
                f'<td><span class="l1">{used}</span><span class="l2">{u2}</span></td><td><button class="btn btn--quiet btn--icon" type="button" aria-label="Change {role}">⋯</button></td></tr>')
    rows = (grp("Client set · HVAC clients", "Rule: tagged HVAC · Heartland Heating &amp; Cooling, Dorrian HVAC, Metro Heating &amp; Cooling")
            + r("Senior bookkeeper", "Custom role · v3", "Reviewer", "Bills and JEs ≤ $10,000", "Since Aug 4 · no end", "No end date", "Jordan Smith", "Approved by Erin Vance", "2 hours ago", "Metro · 318 actions")
            + grp("Client · Crystal Kitchen &amp; Bath", "C-104")
            + r("Bookkeeper", "Standard role · v1", "Preparer", "No limits", "Since Mar 3 · no end", "No end date", "Jordan Smith", "", "Yesterday", "61 actions")
            + r("Year-end close", "Permission set · v2", "Adds year-end posting", "Periods: open and soft close", "Oct 1 → Jan 31", '<span class="warn">104 days left</span> · by Jordan', "Jordan Smith", "Approved by Erin Vance", "Not used yet", "For December close")
            + grp("Client · Iowa Custom Cabinets", "C-108")
            + r("Bookkeeper", "Standard role · v1", "Preparer", '<span class="slash" aria-hidden="true"></span> Muted: payroll register', "Since May 12 · no end", "No end date", "Jordan Smith", "Mute added Jun 2", "3 days ago", "40 actions · mute Jun 2"))
    return (f'<table class="tbl tbl-q asg" aria-label="Priya’s access"><colgroup><col style="width:176px"><col><col style="width:184px"><col style="width:152px"><col style="width:48px"></colgroup>'
            f'<thead><tr><th>Role or set</th><th>Capacity · narrowing</th><th>Dates · granted by</th><th>Last used here</th><th></th></tr></thead><tbody>{rows}</tbody></table>')


def explainer(prefill=True):
    return f"""<aside class="ex" aria-labelledby="ex-h"><div class="panel-head"><div class="eyebrow">Explainer<span class="sl">//</span>no data is opened</div><h2 class="t-head" id="ex-h" style="margin-top:6px">Why can or can’t Priya…</h2></div>
<div class="ex-b"><div class="ex-f"><label class="field full"><span class="field-label">Do what</span><select class="select" id="ex-cap"><option value="ap">Approve a bill</option><option value="pay">Release a payment</option><option value="je">Post a journal entry</option><option value="comp">See pay rates</option></select></label>
<label class="field"><span class="field-label">On</span><select class="select" id="ex-cl"><option value="metro">Metro Heating &amp; Cooling</option><option value="crystal">Crystal Kitchen &amp; Bath</option><option value="iowa">Iowa Custom Cabinets</option></select></label>
<label class="field" id="ex-amt-f"><span class="field-label">Amount</span><input class="input input--money" id="ex-amt" value="31,400.00" inputmode="decimal"></label></div>
<div id="ex-v" class="verdict verdict--deny" style="margin-top:16px" role="status"></div>
<ol class="trace" id="ex-t" style="margin-top:8px"></ol>
<div id="ex-fx"></div>
<p class="t-cap" style="margin-top:16px">Steps run in the order every decision follows. Each links to the role, grant or rule that decided it.</p></div></aside>"""


def main_frame():
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access", "jordan")}
{bar_workspace('Team<span class="sl">//</span>Access<span class="sl">//</span><b>Priya Natarajan</b>')}
<main class="main"><div class="ctxline"><span>Priya Natarajan</span><span class="sl">//</span><span>5 clients</span><span class="sl">//</span><span>2 preparing · 3 reviewing</span><span class="sl">//</span><b>1 grant ends in 104 days</b><span class="sp"></span><button class="btn btn--quiet" type="button">{ico("log")}Her access log</button></div>
<div class="pa"><div class="pa-main">
<div class="who"><span class="av" aria-hidden="true">PN</span><div style="flex:1;min-width:0"><h1 class="t-title">Priya Natarajan</h1>
<div class="meta"><span class="tag">Primary role: Bookkeeper</span><span class="tag">Internal staff</span><span class="tag tag--pos">{ico("shield",12)}Two-step on</span><span class="t-cap">priya@meritmgmt.com · last active 8:55 AM · joined Mar 3, 2025</span></div></div>
<div class="btn-row" style="flex-wrap:nowrap"><button class="btn" type="button" id="viewas">{ico("eye")}View as Priya</button><button class="btn btn--primary" type="button">{ico("plus")}Add access</button></div></div>
<div class="sec-h"><h2 class="t-head">Assignments</h2><span class="t-cap">Grouped by where they apply. Roles stack; a mute narrows only its own row.</span></div>
{assignments()}
<div class="mx-h"><h2 class="t-head" style="flex:none">Effective access on</h2><select class="select" id="eff-cl" aria-label="Client"><option value="crystal" selected>Crystal Kitchen &amp; Bath</option><option value="metro">Metro Heating &amp; Cooling</option><option value="heartland">Heartland Heating &amp; Cooling</option><option value="dorrian">Dorrian HVAC</option><option value="iowa">Iowa Custom Cabinets</option></select>
<span class="t-cap" id="eff-src" style="flex:1;min-width:0"></span><label class="switch"><input type="checkbox" id="eff-all"><i></i>All domains</label></div>
<div class="legend" style="margin-bottom:8px">{"".join(f'<span>{a}{b}</span>' for a,b in [('<span class="cap cap--sm is-on"><i></i></span>','From a role'),('<span class="cap cap--sm is-set"><i></i></span>','From a permission set'),('<span class="cap cap--sm is-on is-lim"><i></i></span>','With a limit'),('<span class="cap cap--sm is-muted"><i></i></span>','Muted'),('<span class="cap cap--sm"><i></i></span>','Not granted')])}<span>Hover or focus any cell for its source.</span></div>
<table class="tbl capm" id="eff"><colgroup><col>{'<col style="width:52px">'*9}</colgroup></table>
</div>{explainer()}</div></main></div>"""


def viewas_frame():
    rows = [("Menards", "Oct 14 · Chase ••2291", "Shop supplies", "6110 · Shop supplies", "(1,284.16)", "96"),
            ("Iowa Hardwood Supply", "Oct 14 · Chase ••2291", "Matched to bill B-2207", "2000 · Accounts payable", "(8,940.00)", "99"),
            ("Kreg Tool", "Oct 13 · Ramp ••7710", "Receipt attached", "6120 · Small tools", "(312.48)", "91"),
            ("MidAmerican Energy", "Oct 12 · Chase ••2291", "Recurring", "6400 · Utilities", "(2,006.37)", "98"),
            ("Venmo · A. Ruiz", "Oct 12 · Chase ••2291", "No match", "Needs a decision", "(450.00)", "41")]
    trs = "".join(f'<tr class="q-row"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td><span class="l1">{d}</span><span class="l2">{c}</span></td>'
                  f'<td class="n">{e}</td><td><span class="conf{" conf--lo" if int(f) < 70 else ""}"><span class="meter" role="img" aria-label="{f} percent"><i class="on"></i><i class="on"></i><i class="{"on" if int(f)>60 else ""}"></i><i class="{"on" if int(f)>90 else ""}"></i><i class="{"on" if int(f)>95 else ""}"></i></span><b>{f}</b></span></td>'
                  f'<td><button class="btn ro-btn" type="button" aria-disabled="true" title="Read-only while viewing as">{ico("lock",12)}Approve</button></td></tr>' for a, b, c, d, e, f in rows)
    nav = ('<aside class="rail" aria-label="Priya’s navigation"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24"><span class="prod">BOOKS</span></div><nav class="rail-nav">'
           '<div class="rail-group">Books</div><a class="rail-link" href="#">Client home</a><a class="rail-link" href="#" aria-current="page">To review<span class="count">23</span></a><a class="rail-link" href="#">Reconcile</a><a class="rail-link" href="#">Close checklist</a>'
           '<div class="rail-group">Spend</div><a class="rail-link" href="#">Bills<span class="count">4</span></a><a class="rail-link" href="#">Expenses &amp; receipts</a><a class="rail-link" href="#">Vendors</a>'
           '<div class="rail-group">Sales</div><a class="rail-link" href="#">Invoices</a><a class="rail-link" href="#">Customers</a><a class="rail-link" href="#">Collections</a>'
           '<div class="rail-group">Reports</div><a class="rail-link" href="#">Financial reports</a><div class="rail-group">Tax</div><a class="rail-link" href="#">Sales tax</a><a class="rail-link" href="#">1099s</a>'
           '</nav><div class="rail-foot"><div class="rail-user"><span class="avatar">PN</span><span>Priya Natarajan<small>Bookkeeper · Iowa</small></span></div></div></aside>')
    return f"""<div class="app app--frame density-cockpit" data-context="client">
<div class="viewas-band" role="status">{ico("eye")}<span>Viewing as <b>Priya Natarajan</b></span><span class="sl">//</span><span>Read-only</span><span class="sl">//</span><span>Iowa Custom Cabinets</span><span class="sl">//</span><span>Started and logged 10:14 AM</span><span class="sp"></span><span class="clock">29:12</span><span>left</span><button class="btn" type="button">End</button></div>
{nav}
{bar_client("Iowa Custom Cabinets", "C-108 · Sep open", 'Books<span class="sl">//</span><b>To review</b>')}
<main class="main"><div class="ctxline"><span>Due Oct 21</span><span class="sl">//</span><span>23 to review</span><span class="sl">//</span><b>What Priya sees, nothing she can change from here</b></div>
<div class="va"><div class="va-main"><div class="page-head" style="margin-bottom:16px"><div><div class="eyebrow">Iowa Custom Cabinets</div><h1 class="t-title" style="margin-top:4px">To review</h1></div><div class="btn-row"><button class="btn ro-btn" type="button" aria-disabled="true">{ico("lock",12)}Approve 4 ≥ 90%</button></div></div>
<table class="tbl tbl-q"><colgroup><col><col style="width:232px"><col style="width:120px"><col style="width:112px"><col style="width:128px"></colgroup><thead><tr><th>Transaction</th><th>Coded to</th><th class="n">Amount</th><th>Confidence</th><th></th></tr></thead><tbody>{trs}</tbody></table></div>
<aside class="panel"><div class="panel-head"><div class="eyebrow">Compared with your view</div><h2 class="t-head" style="margin-top:6px">What’s different for Priya</h2></div><div class="panel-body">
<ul class="why"><li><b>Payroll is gone from her nav.</b> Muted on this assignment by Jordan Smith, Jun 2.</li><li><b>No Pay runs, Debt or Settings.</b> Bookkeeper doesn’t grant them here.</li><li><b>Approve shows for her.</b> Bank coding approval posts through the engine; locked here because view-as is read-only.</li><li class="against"><b>Bank numbers show last 4.</b> Her masking is stricter than yours, so you see hers.</li></ul>
<div class="inline-notice inline-notice--info" style="margin-top:16px"><div>You can only ever see the overlap of your access and hers. Nothing she sees is outside your 13 clients.</div></div></div></aside></div></main></div>"""


def add_access_frame():
    def gl(name, d, ok=True, checked=False, why=""):
        if not ok:
            return f'<div class="gl is-no">{ico("lock")}<span><span class="l1">{name}</span><span class="l2">{why}</span></span></div>'
        return f'<label class="gl"><input type="radio" name="aa" {"checked" if checked else ""}><span><span class="l1">{name}</span><span class="l2">{d}</span></span></label>'
    return f"""<div class="dlgwrap"><div class="dialog aa" role="dialog" aria-modal="true" aria-labelledby="aa-h">
<div class="dialog-head"><div class="eyebrow">Priya Natarajan<span class="sl">//</span>Add access</div><h3 class="t-section" id="aa-h" style="margin-top:4px">Give Priya year-end close on the HVAC clients</h3></div>
<div class="dialog-body"><h4>What</h4><div class="grant-l">
<div><div class="t-cap" style="padding:4px 0">Roles you can grant</div>{gl("Senior bookkeeper", "Custom · v3 · she holds it on HVAC clients")}{gl("Bookkeeper", "Standard · v1")}{gl("AP clerk", "Standard · v1")}{gl("Controller", "", False, why="Above your role. Ask Mike Heilman.")}</div>
<div><div class="t-cap" style="padding:4px 0">Permission sets you can grant</div>{gl("Year-end close", "Year-end posting, periods to soft close · v2", checked=True)}{gl("Quarter-end auditor extras", "Not for internal staff", False, why="External audience only.")}{gl("Wire release ≤ $50k", "", False, why="You don’t hold release, so you can’t grant it.")}</div></div>
<h4>Where and when</h4><div class="scope-row"><label class="field"><span class="field-label">Scope</span><select class="select"><option selected>Client set · HVAC clients (3)</option><option>One client…</option><option>Several clients…</option></select></label>
<label class="field"><span class="field-label">From</span><input class="input tnum" value="Nov 1, 2026"></label><label class="field"><span class="field-label">Until · required for this set</span><input class="input tnum" value="Jan 31, 2027"></label></div>
<h4>Tighten (optional)</h4><div class="scope-row"><label class="field"><span class="field-label">Post journal entries up to</span><input class="input input--money" value="10,000.00"></label><div class="field" style="grid-column:span 2"><span class="field-help" style="margin-top:22px">Can only tighten. Your own limit is $25,000, so nothing above that is offered.</span></div></div>
<h4>Checks, live</h4><ul class="chk-list"><li><span class="pos">{ico("check")}</span><span>You hold everything in Year-end close on all 3 clients</span><span class="t-cap">ceiling</span></li>
<li><span class="pos">{ico("check")}</span><span>Ends before your own access does</span><span class="t-cap">dates</span></li>
<li><span class="warn">{ico("alert")}</span><span><b>S5 soft:</b> she’d post journal entries and reopen periods on the same clients</span><span class="t-cap">duties</span></li>
<li><span class="pos">{ico("check")}</span><span>No second approver needed: no money release, limits under $100k</span><span class="t-cap">approval</span></li></ul>
<label class="field" style="margin-top:12px"><span class="field-label">Justification for S5 · stays on the exception, shown in every access review</span><textarea class="textarea" rows="2">Priya runs December close for the HVAC clients. Erin reviews every reopened period.</textarea></label></div>
<div class="dialog-foot"><span class="t-cap">Logged with your name and reason · Priya is told</span><span class="sp"></span><button class="btn" type="button">Cancel</button><button class="btn btn--primary" type="button" id="aa-go">Grant to Priya</button></div></div></div>"""


def trio_frame():
    return f"""<div class="trio">
<section aria-labelledby="t1"><div class="hd"><div class="eyebrow">Dana Lee opens a link</div><h3 class="t-head" id="t1" style="margin-top:4px">Direct URL, no access</h3></div><div class="bd f403">
<span class="mark">{ico("lock",20)}</span><span class="t-head">You don’t have access to Debt &amp; covenants on Heritage Interiors</span>
<p class="ink-2">Bookkeeper on Heritage Interiors lets you see bills, bank and the close, not debt. Ask for it and Jordan Smith gets the request.</p>
<label class="field" style="width:100%"><span class="field-label">What you need it for</span><textarea class="textarea" rows="2">Kubota loan covenant check before the October packet.</textarea></label>
<label class="field" style="width:100%"><span class="field-label">For how long</span><select class="select"><option>Until I revoke it</option><option selected>2 weeks</option><option>Today only</option></select></label>
<div class="btn-row"><button class="btn btn--primary" type="button" id="req-go">Request access</button><a class="link" href="#">Go to Heritage home</a></div></div></section>
<section aria-labelledby="t2"><div class="hd"><div class="eyebrow">On Jordan’s home</div><h3 class="t-head" id="t2" style="margin-top:4px">Access requests · 2</h3></div><div class="bd">
<div class="req-card"><span class="l1">Dana Lee · Debt &amp; covenants, view</span><span class="l2">Heritage Interiors · 2 weeks · asked 10:21 AM</span><p class="ink-2" style="margin-top:8px">“Kubota loan covenant check before the October packet.”</p>
<ul class="why" style="margin-top:8px"><li>You hold it on Heritage, so you can grant it.</li><li>No duty conflicts. Ends Nov 2.</li></ul>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--primary" type="button">Grant for 2 weeks</button><button class="btn" type="button">Deny…</button></div></div>
<div class="req-card" style="margin-top:8px"><span class="l1">Luis Ortiz · Release pay runs</span><span class="l2">Swan Creek · today only</span><p class="ink-2" style="margin-top:8px">You don’t hold release. Routed to Nora Lindqvist instead.</p></div></div></section>
<section aria-labelledby="t3"><div class="hd"><div class="eyebrow">Client staff</div><h3 class="t-head" id="t3" style="margin-top:4px">Marcus Reyes · Heritage Interiors</h3></div><div class="bd">
<dl class="kv"><dt>Audience</dt><dd>Client staff</dd><dt>Can be assigned</dt><dd>Heritage only</dd><dt>Two-step</dt><dd>On (client floor)</dd></dl>
<table class="tbl tbl-q tbl-q--flush" style="margin-top:12px"><colgroup><col><col style="width:104px"></colgroup><tbody>
<tr class="q-row"><td><span class="l1">Office manager</span><span class="l2">Client role · Heritage-made · v2</span></td><td><span class="lvl lvl--client">Client</span></td></tr>
<tr class="q-row"><td><span class="l1">Employee / cardholder</span><span class="l2">Standard · own card ••4410</span></td><td><span class="lvl lvl--tenant">Tenant</span></td></tr></tbody></table>
<p class="t-cap" style="margin-top:12px">Lauren Pierce, Heritage’s client admin, assigned Office manager. Merit sees it here and in the access log; Marcus can’t be given access to any other client.</p></div></section></div>"""


JS = "<script>\n" + js_data(clients=CLIENTS, lim=LIM, roles={"BK": BK, "SR": SR, "YE": YE}) + MATRIX_JS + r"""
(function(){
  var tbl=document.getElementById('eff');tbl.insertAdjacentHTML('beforeend',MBM.head(false,'On this client'));
  var focus=['GL','Close','Bank','AP','Payments','Payroll','Reports'];
  function eff(){var id=document.getElementById('eff-cl').value,c=MB.clients[id],g={},src={};
    c.src.forEach(function(s){var G=MB.roles[s[3]];Object.keys(G).forEach(function(k){G[k].split('').forEach(function(a){
      if((g[k]||'').indexOf(a)<0)g[k]=(g[k]||'')+a;var key=k+':'+a;if(!src[key])src[key]=s;})})});
    Object.keys(g).forEach(function(k){g[k]=MBM.norm(g[k],MBM.CAT[k].acts)});
    var lim=id==='crystal'||id==='iowa'?{}:MB.lim;
    MBM.render(tbl,{grants:g,limits:lim,doms:document.getElementById('eff-all').checked?null:focus,
      src:function(k,a){var s=src[k+':'+a],m=c.mute.indexOf(k)>-1&&(g[k]||'').indexOf(a)>-1;
        if(m)return {muted:true,t:'Muted on the Iowa Custom Cabinets assignment by Jordan Smith, Jun 2'};
        if(!s)return null;return {set:s[2]==='set',t:'From '+s[0]+' via '+s[1]+((lim[k+':'+a])?' · '+lim[k+':'+a]:'')}}});
    document.getElementById('eff-src').textContent='From '+c.src.map(function(s){return s[0]}).join(' + ')+(c.mute.length?' · 1 mute':'');
  }
  document.getElementById('eff-cl').onchange=eff;document.getElementById('eff-all').onchange=eff;eff();
  /* explainer */
  var cap=document.getElementById('ex-cap'),cl=document.getElementById('ex-cl'),amt=document.getElementById('ex-amt');
  function money(v){return '$'+Math.round(v).toLocaleString('en-US')}
  function run(){
    var c=cap.value,k=cl.value,n=parseFloat((amt.value||'0').replace(/[^0-9.]/g,''))||0,C=MB.clients[k];
    document.getElementById('ex-amt-f').hidden=(c==='comp'||c==='pay');
    var role=C.src[0][0]+' via '+C.src[0][1];
    var S=[["Signed in","Membership active · two-step verified 8:55 AM","pass"],["Context",C.n+' · '+C.c,"pass"],["Ceiling","In Merit’s plan · internal staff may do this","pass"]];
    var verdict,fix='',dec;
    if(c==='ap'){
      var has=k==='metro';
      if(!has){S.push(["Grants",role+" gives Bills: create and edit, not approve","fail"]);dec=3;verdict=['deny','Can’t approve bills on '+C.n,'No role she holds there includes approve.'];
        fix='<button class="btn" type="button">Route to Owen Pratt or Erin Vance</button><button class="btn" type="button">Grant Senior bookkeeper on '+C.n+'</button>';}
      else{S.push(["Grants",role+" · Bills: approve","pass"]);
        if(n>10000){S.push(["Limit","Up to $10,000 a bill · this one is "+money(n),"fail"]);dec=4;verdict=['deny','Can’t approve: over her $10,000 limit','Her button reads “Approve up to your limit → route”.'];
          fix='<button class="btn" type="button">Route to Erin Vance (≤ $250,000) or Nora Lindqvist</button><button class="btn" type="button" title="Your own limit is $25,000">Raise her limit · up to your $25,000, covers less than this bill</button><button class="btn" type="button">Ask Mike Heilman for a higher grant</button>';}
        else{S.push(["Limit","Up to $10,000 a bill · this one is "+money(n),"pass"]);S.push(["Duties","She didn’t enter this bill","pass"]);S.push(["Sign-in","Nothing extra for approve","pass"]);dec=S.length-1;verdict=['allow','Can approve this bill','Allowed by '+C.src[0][0]+'.'];}
      }
    } else if(c==='pay'){
      S.push(["Grants","No role or set she holds on "+C.n+" includes Pay runs: release","fail"]);dec=3;verdict=['deny','Can’t release payments anywhere','Bookkeepers prepare; release sits with Nora Lindqvist and Erin Vance.'];
      fix='<button class="btn" type="button" title="You don’t hold release">You can’t grant release · request it from Mike Heilman</button>';
    } else if(c==='je'){
      if(k!=='metro'){S.push(["Grants",role+" gives Journal entries: prepare, not post","fail"]);dec=3;verdict=['deny','Can’t post on '+C.n,'She can prepare the entry; a reviewer posts it.'];
        fix='<button class="btn" type="button">Send drafts to Owen Pratt to post</button>';}
      else{S.push(["Grants",role+" · Journal entries: post","pass"]);
        if(n>10000){S.push(["Limit","Up to $10,000 · this entry is "+money(n),"fail"]);dec=4;verdict=['deny','Can’t post: over her $10,000 limit','Over $25,000 also needs a poster other than the preparer.'];fix='<button class="btn" type="button">Route to Owen Pratt</button>';}
        else{S.push(["Limit","Up to $10,000 · this entry is "+money(n),"pass"]);S.push(["Duties","Under the $25,000 self-post threshold","pass"]);S.push(["Sign-in","Open period · nothing extra","pass"]);dec=S.length-1;verdict=['allow','Can post this entry','Allowed by Senior bookkeeper v3.'];}
      }
    } else {
      var reg=k==='iowa';
      if(reg){S.push(["Grants","Bookkeeper v1 · Payroll register: view","pass"]);S.push(["Narrowing","Muted on the Iowa assignment, Jun 2","fail"]);dec=4;verdict=['deny','Can’t see payroll on Iowa Custom Cabinets','Muted by Jordan Smith on Jun 2.'];fix='<button class="btn" type="button">Remove the mute</button>';}
      else{S.push(["Grants",role+" · Payroll register: view","pass"]);S.push(["Fields","Pay rates: grouped · department totals only","pass"]);dec=S.length-1;verdict=['allow','Sees payroll, pay rates grouped','Per-person pay stays hidden; her role’s field policy is Grouped.'];fix='<button class="btn" type="button">Show her per-person pay · needs a permission set</button>';}
    }
    var v=document.getElementById('ex-v');v.className='verdict verdict--'+verdict[0];
    v.innerHTML=(verdict[0]==='allow'?'<svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-check"/></svg>':'<span class="slash" aria-hidden="true"></span>')+'<div>'+verdict[1]+'<p>'+verdict[2]+'</p></div>';
    var rest=c==='ap'||c==='je'?['Limit','Duties','Sign-in']:['Duties','Sign-in'];
    while(S.length<7){var nm=['Grants','Limit','Duties','Sign-in','Fields'].filter(function(x){return !S.some(function(s){return s[0]===x})})[0]||'Sign-in';S.push([nm,'Not reached','skip'])}
    document.getElementById('ex-t').innerHTML=S.slice(0,7).map(function(s,i){var mark=s[2]==='pass'?'<span class="tv tv--pass"><svg class="ico" width="14" height="14" aria-hidden="true"><use href="#i-check"/></svg>Pass</span>':s[2]==='fail'?'<span class="tv tv--fail"><span class="slash" aria-hidden="true"></span>Stops</span>':'<span class="tv tv--skip">—</span>';
      return '<li class="'+(i===dec?'is-decider'+(verdict[0]==='allow'?' is-allow':''):'')+'"><span class="tno">'+(i+1)+'</span><span><span class="tl">'+s[0]+'</span><span class="td">'+s[1]+'</span></span>'+mark+'</li>'}).join('');
    document.getElementById('ex-fx').innerHTML=fix?'<div class="panel-sec-h" style="margin-top:16px"><h3>Fixes you can make</h3></div><div class="fixes">'+fix+'</div>':'';
  }
  [cap,cl].forEach(function(x){x.onchange=run});amt.addEventListener('input',function(){clearTimeout(amt._t);amt._t=setTimeout(run,200)});run();
  document.getElementById('viewas').onclick=function(){document.getElementById('f2').scrollIntoView({behavior:'smooth'});mbToast('Started view as Priya Natarajan · logged')};
  document.getElementById('aa-go').onclick=function(){this.disabled=true;this.textContent='Granted';mbToast('Granted Year-end close on HVAC clients to Priya Natarajan')};
  document.getElementById('req-go').onclick=function(){this.disabled=true;this.textContent='Requested';mbToast('Requested Debt & covenants on Heritage Interiors · sent to Jordan Smith')};
})();
</script>"""


def build():
    h = head("S15 · One person’s access", CSS)
    b = sheet_top("S15-user-access.html") + '<main id="main" class="sheet">'
    b += board_h("S15", "05-RBAC §6.3 A3 · §6.7 A7 · §5.6 · §6.11", "Everything Priya can do, where, and why",
                 "Jordan opens Priya Natarajan: Senior bookkeeper and reviewer on the three HVAC clients, Bookkeeper and preparer on Crystal Kitchen &amp; Bath and Iowa Custom Cabinets, a time-boxed year-end set on Crystal, a payroll mute on Iowa. Pick a client to see her resolved access; ask the explainer why she can or can’t do something; view as her, read-only.", "S15.1")
    b += frame(main_frame(), 1220, "Assignments grouped by scope, then the resolved matrix for one client (hover a cell for its source), then the explainer. Try $8,000, or Iowa, or “See pay rates”.", "Live: client picker, all domains, explainer inputs", "f1")
    b += '<div class="anno"><div><b>Scope is the grouping</b><p>Client set, then each client. Bookkeeper on one, reviewer on another, reads straight down.</p></div><div><b>Shape tells the source</b><p>A ring is a permission set; a slash is a mute. The tooltip names the role, the version and the assignment.</p></div><div><b>The trace is the decision</b><p>The explainer runs the same seven steps the server does and marks the one that stopped it.</p></div><div><b>Fixes respect the ceiling</b><p>Jordan’s limit is $25,000, so he isn’t offered a $50,000 grant. He’s offered a route instead.</p></div></div>'
    b += '<div class="pair-h"><h2 class="t-section">View as Priya</h2><span class="t-cap">Read-only, 30 minutes, logged at start and end</span></div>'
    b += frame(viewas_frame(), 720, "The view-as band takes the support band’s slot in Sky, not alarm red: it’s you, looking through her access. Payroll is absent because it’s muted.", "S15.2", "f2")
    b += '<div class="pair-h"><h2 class="t-section">Add access</h2><span class="t-cap">Only what Jordan can grant, checked as he picks</span></div>'
    b += frame(add_access_frame(), 900, "Locked rows say why. The duties check is live; the soft rule asks for one justification that follows the exception into every review.", "S15.3")
    b += '<div class="pair-h"><h2 class="t-section">No access, asking for it, and client staff</h2></div>'
    b += frame(trio_frame(), 620, "A 403 is never a dead end. The request lands with the nearest person who can grant it. Client staff carry a client role and can’t leave their client.", "S15.4")
    b += '</main>'
    return h + b + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S15-user-access.html")
    open(out, "w").write(build()); print("wrote", out, len(build()))
