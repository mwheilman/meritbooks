"""S17 · Access review / recertification (05 §6.8 A8; works at 390)."""
from acc_common import *

ITEMS = [
 ("dormant", "Dormant access", "Luis Ortiz · Bookkeeper on Artistry Homes", "revoke",
  [("Last activity on Artistry Homes", "Jul 14 · 97 days ago"), ("Actions in the last 90 days", "0"), ("Capacity", "None · Sam Kovac prepares since Jul 20"), ("Granted", "Jordan Smith · Feb 2")],
  "Nobody uses it, and his work there moved to Sam in July."),
 ("unused", "Unused capabilities", "Dana Lee · Bookkeeper · sales tax prep on 4 clients", "reduce",
  [("Sales tax: edit · Heritage Interiors", "0 uses"), ("Sales tax: edit · Clive Power Equipment", "0 uses"), ("Sales tax: edit · Swan Creek", "0 uses"), ("Sales tax: edit · Wild Rose", "0 uses")],
  "Erin files sales tax for these four. Mute it on them; keep it on Crystal, where Dana does file."),
 ("sod", "Allowed conflict", "Owen Pratt · can reopen a closed month and post into it", "keep",
  [("Reason", "Audit adjustments for Metro and AIM"), ("Safeguard", "Erin approves every reopened month"), ("This quarter", "2 reopened · both reviewed"), ("Expires", "Aug 1, 2027")],
  "Used as described and the control ran both times."),
 ("usage", "Assignment", "Sam Kovac · Bookkeeper on Clive Power Equipment", "keep",
  [("Last used", "4 days ago"), ("Actions in the last 90 days", "212"), ("Capacity", "Preparer"), ("Granted", "Jordan Smith · Mar 3, 2025")],
  "Daily use, matches his capacity."),
 ("ending", "Ends soon", "Rachel Ames · External auditor on Swan Creek", "end",
  [("Firm", "Dennison &amp; Co. CPAs"), ("Ends", "Nov 3 · 15 days"), ("Requests answered", "41 of 44"), ("Granted", "Erin Vance · Jul 6 · 120-day limit")],
  "Three requests are still open. Extending 30 days stays inside the 120-day cap only if the clock restarts with a new grant."),
 ("usage", "Permission set", "Priya Natarajan · Year-end close on Crystal Kitchen &amp; Bath", "keep",
  [("Granted", "Oct 1 · for December close"), ("Used", "Not yet"), ("Ends", "Jan 31, 2027 · by itself")],
  "Not used yet because December hasn’t started."),
 ("usage", "Assignment", "Ben Okafor · Bookkeeper on Swan Creek and Heritage Interiors", "keep",
  [("Granted", "6 days ago · Jordan Smith"), ("Actions so far", "38"), ("Capacity", "Preparer on both")],
  "New this week and already working."),
]
SUG = {"keep": ("Suggest keep", "tag--pos"), "reduce": ("Suggest reduce", "tag--warn"), "revoke": ("Suggest revoke", "tag--neg"), "end": ("Suggest let it end", "")}

CSS = """
.rv{display:grid;grid-template-columns:minmax(0,1fr) 384px;height:calc(100% - 72px)}
.rv-main{min-width:0;overflow:auto;padding:24px 32px 40px}
.camp{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:end;padding-bottom:16px;border-bottom:1px solid var(--line)}
.camp .prog{display:flex;align-items:center;gap:12px;margin-top:8px}
.list{margin-top:16px}
.attest .ev{margin-top:8px;grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:40px}
.attest .ev li{line-height:20px}
.attest .note-why{grid-column:1/-1;color:var(--ink-2);margin-top:4px}
.attest-acts .btn .kbd{margin-left:2px}
.attest.is-kept .attest-acts,.attest.is-revoked .attest-acts,.attest.is-reduced .attest-acts{display:none}
.attest .done-l{display:none;font-weight:600}
.attest.is-kept .done-l,.attest.is-revoked .done-l,.attest.is-reduced .done-l{display:inline-flex;align-items:center;gap:6px}
.attest.is-reduced{background:var(--canvas)}
.rv-side{border-left:1px solid var(--line-2);background:var(--white);display:flex;flex-direction:column;min-height:0}
.rv-side .panel-body{padding-top:4px}
.mute-l{list-style:none;border-top:1px solid var(--line)}
.mute-l li{border-bottom:1px solid var(--line)}
.ov{padding:24px 32px 40px;height:calc(100% - 32px);overflow:auto}
.ov-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;margin-top:16px}
.rvw td{height:52px}
.past td{height:52px}
.phone-wrap{height:100%;display:flex;gap:48px;align-items:flex-start;justify-content:center;padding:32px;background:var(--canvas)}
.phone{width:390px;height:780px;border:1px solid var(--midnight);background:var(--warm);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--float)}
.phone-bar{height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--midnight);color:var(--warm);flex:none}
.phone-body{flex:1;overflow:auto;padding:16px}
.phone .attest{grid-template-columns:1fr;padding:16px}
.phone .attest .ev{grid-template-columns:1fr}
.phone .attest-acts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px}
.phone .attest-acts .btn{height:44px;min-width:0;padding:0 8px}
.phone-foot{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 16px;border-top:1px solid var(--line);background:var(--white);flex:none}
.side-notes{width:420px}
.side-notes .why li{margin-top:12px}
.close-g{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:32px}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:32px 24px;border:1px dashed var(--grey-400);background:var(--white)}
.rep{background:var(--white);border:1px solid var(--line);padding:24px}
"""


def meter(done, total, n=12):
    on = round(done / total * n)
    return '<span class="meter meter--lg" role="img" aria-label="' + f'{done} of {total} decided">' + ''.join('<i class="on"></i>' if i < on else ('<i class="cur"></i>' if i == on else '<i></i>') for i in range(n)) + '</span>'


def card(i, it, phone=False):
    kind, eyebrow, claim, sug, ev, why = it
    s = SUG[sug]
    evh = "".join(f'<li><span>{a}</span><span class="dl"></span><span class="v">{b}</span></li>' for a, b in ev)
    acts = (f'<button class="btn" type="button" data-d="keep">Keep<span class="kbd">A</span></button>'
            f'<button class="btn" type="button" data-d="reduce">Reduce<span class="kbd">R</span></button>'
            f'<button class="btn btn--danger" type="button" data-d="revoke">{"Let it end" if sug=="end" else "Revoke"}<span class="kbd">X</span></button>')
    if phone:
        acts = acts.replace('<span class="kbd">A</span>', '').replace('<span class="kbd">R</span>', '').replace('<span class="kbd">X</span>', '')
    return (f'<article class="attest{" is-cursor" if i == 0 else ""}" tabindex="-1" data-i="{i}" aria-label="{E(claim)}">'
            f'<div><div class="row" style="gap:8px"><span class="attest-kind">{eyebrow}</span><span class="tag {s[1]}">{s[0]}</span></div>'
            f'<div class="attest-claim">{claim}</div></div>'
            f'<div class="attest-acts">{acts}</div><span class="done-l" style="grid-column:2;grid-row:1"></span>'
            f'<ul class="ev">{evh}</ul><p class="note-why">{why}</p></article>')


def inbox_frame():
    cards = "".join(card(i, it) for i, it in enumerate(ITEMS))
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access reviews", "jordan")}
{bar_workspace('Team<span class="sl">//</span>Access reviews<span class="sl">//</span><b>Q3 2026</b>')}
<main class="main"><div class="ctxline"><span>Q3 2026 access review</span><span class="sl">//</span><span>Due Oct 31 · 12 days</span><span class="sl">//</span><b id="ctx-left">19 left for you</b><span class="sl">//</span><span>Firm-wide 61 of 94</span></div>
<div class="rv"><div class="rv-main">
<div class="camp"><div><div class="eyebrow">Your part<span class="sl">//</span>people you granted access to</div><h1 class="t-title" style="margin-top:4px">Access review</h1>
<div class="prog">{meter(14, 33)}<span class="tnum"><b id="done-n">14</b> of 33 decided</span><span class="t-cap">· 11 kept · 2 reduced · 1 revoked</span></div></div>
<div class="tabs" role="tablist" style="border-bottom:0"><button class="tab" role="tab" aria-selected="true">To decide<span class="n tnum" id="tab-left">19</span></button><button class="tab" role="tab" aria-selected="false">Decided<span class="n tnum">14</span></button><button class="tab" role="tab" aria-selected="false">Suggested<span class="n tnum">6</span></button></div></div>
<p class="t-cap" style="margin-top:12px">Your own access is reviewed by Mike Heilman. Showing the first 7 of 19.</p>
<div class="list" id="list">{cards}</div></div>
<aside class="rv-side" aria-labelledby="side-h"><div class="panel-head"><div class="eyebrow" id="side-k">Dormant access</div><h2 class="t-head" id="side-h" style="margin-top:6px">Luis Ortiz on Artistry Homes</h2></div>
<div class="panel-body" id="side-b"></div>
<div class="panel-foot"><span class="t-cap">Decisions apply when the review closes, or now if you pick “apply now”.</span></div></aside></div>
<div class="keybar"><span><span class="kbd">J</span><span class="kbd">K</span> move</span><span><span class="kbd">A</span> keep</span><span><span class="kbd">R</span> reduce</span><span><span class="kbd">X</span> revoke</span><span><span class="kbd">Z</span> undo</span><span class="sp"></span><span>Every decision is logged with your name</span></div>
</main></div>"""


def overview_frame():
    rv = [("Jordan Smith", "His team · 7 people", 14, 33), ("Erin Vance", "Controllers, auditors", 20, 24), ("Nora Lindqvist", "Payments and payroll access", 9, 12), ("Mike Heilman", "Admins and managers", 18, 25)]
    rows = "".join(f'<tr class="q-row"><td><span class="l1">{a}</span><span class="l2">{b}</span></td><td><span class="row">{meter(d, t, 8)}<span class="tnum">{d} of {t}</span></span></td><td class="n tnum">{t-d}</td><td><button class="btn btn--quiet" type="button">Remind</button></td></tr>' for a, b, d, t in rv)
    return f"""<div class="app app--frame density-cockpit" data-context="workspace">
{rail_workspace("Access reviews")}
{bar_workspace('Team<span class="sl">//</span><b>Access reviews</b>')}
<main class="main"><div class="ctxline"><span>Quarterly</span><span class="sl">//</span><b>Q3 2026 open · 61 of 94 decided</b><span class="sl">//</span><span>Next starts Jan 5, 2027</span></div>
<div class="ov"><div class="page-head" style="margin-bottom:0"><div><div class="eyebrow">Team<span class="sl">//</span>Access reviews</div><h1 class="t-title" style="margin-top:4px">Access reviews</h1></div><div class="btn-row"><button class="btn" type="button">Edit schedule</button><button class="btn btn--primary" type="button" aria-disabled="true" title="33 items still open">Close Q3 review</button></div></div>
<div class="ov-grid"><div>
<h2 class="t-head">Q3 2026 · by reviewer</h2>
<table class="tbl tbl-q rvw" style="margin-top:8px"><colgroup><col><col style="width:232px"><col style="width:72px"><col style="width:128px"></colgroup><thead><tr><th>Reviewer</th><th>Decided</th><th class="n">Left</th><th></th></tr></thead><tbody>{rows}</tbody></table>
<div class="inline-notice" style="margin-top:12px">{ico("info")}<div>Mike is the only tenant admin, so Nora Lindqvist reviews Mike’s own access. Nobody reviews themselves.</div></div>
<h2 class="t-head" style="margin-top:32px">Past reviews</h2>
<table class="tbl tbl-q past" style="margin-top:8px"><colgroup><col><col style="width:320px"><col style="width:208px"></colgroup><thead><tr><th>Review</th><th>Outcome</th><th></th></tr></thead><tbody>
<tr class="q-row"><td><span class="l1">Q2 2026</span><span class="l2">Closed Jul 14 · on time</span></td><td><span class="l1 tnum">88 items · 71 kept · 11 reduced · 6 revoked</span><span class="l2">Saved to Documents · Access reviews</span></td><td><div class="btn-row"><button class="btn" type="button">{ico("download")}PDF</button><button class="btn" type="button">CSV</button></div></td></tr>
<tr class="q-row"><td><span class="l1">Q1 2026</span><span class="l2">Closed Apr 9 · first review</span></td><td><span class="l1 tnum">63 items · 48 kept · 9 reduced · 6 revoked</span><span class="l2">Legacy full books dropped from Mike</span></td><td><div class="btn-row"><button class="btn" type="button">{ico("download")}PDF</button><button class="btn" type="button">CSV</button></div></td></tr></tbody></table></div>
<aside><div class="surface" style="padding:20px"><div class="eyebrow">How Q3 was set up</div>
<dl class="kv" style="margin-top:12px"><dt>Scope</dt><dd>13 clients · 25 roles</dd><dt>Reviewers</dt><dd>Each person’s grantor</dd><dt>Admins reviewed by</dt><dd>Another admin or CFO</dd><dt>Opened</dt><dd>Oct 17</dd><dt>Due</dt><dd>Oct 31 · 14 days</dd><dt>Reminders</dt><dd>7 and 2 days before</dd><dt>Unreviewed at due date</dt><dd>Stay, flagged</dd></dl></div>
<div class="surface" style="padding:20px;margin-top:16px"><div class="eyebrow">What’s in it</div><dl class="kv" style="margin-top:12px"><dt>Assignments with usage</dt><dd>61</dd><dt>Allowed conflicts</dt><dd>9</dd><dt>Dormant 90 days</dt><dd>4</dd><dt>Unused capabilities</dt><dd>12</dd><dt>Ending within 30 days</dt><dd>8</dd><dt class="b" style="border-top:1px solid var(--midnight);padding-top:6px">Total</dt><dd class="b" style="border-top:1px solid var(--midnight);padding-top:6px">94</dd></dl></div></aside></div></div></main></div>"""


def phone_frame():
    it = ITEMS[0]
    return f"""<div class="phone-wrap"><div class="phone" role="region" aria-label="Access review on a phone">
<div class="phone-bar"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="64" height="19" style="height:16px;width:auto"><span class="b">Access review</span><span class="sp" style="flex:1"></span><span class="tnum" style="color:var(--grey-300)">15 of 33</span></div>
<div class="phone-body"><div class="prog" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">{meter(15, 33, 10)}<span class="t-cap">Due Oct 31</span></div>
{card(0, it, True).replace(' is-cursor', '')}
<p class="t-cap" style="margin-top:12px">Swipe or use the buttons. Reduce opens the choices on the next screen.</p></div>
<div class="phone-foot"><button class="btn btn--quiet" type="button">Previous</button><span class="t-cap tnum">1 of 18 left</span><button class="btn btn--quiet" type="button">Next</button></div></div>
<div class="side-notes"><h3 class="t-section" style="color:var(--ink)">At 390</h3><ul class="why"><li><b>One card per screen.</b> The evidence ledger stays, because the decision depends on it.</li><li><b>44px buttons</b> in a row of three. Keys drop away; the order matches the keys on desktop.</li><li><b>Reduce is a second step</b> with the same mute choices as the desktop panel.</li><li class="against"><b>No bulk keep on a phone.</b> Bulk decisions need the desktop list, where you can see what you’re keeping.</li></ul></div></div>"""


def close_frame():
    return f"""<div class="close-g"><div><h3 class="t-section" style="color:var(--ink);margin-bottom:12px">Jordan, all decided</h3>
<div class="empty"><span class="wg-done-mark">{ico("check")}</span><span class="t-head">You’ve decided all 33</span><p class="ink-2">27 kept, 4 reduced, 2 revoked. Reductions apply when Mike closes the review; the two revokes applied now because you chose “apply now”.</p><button class="btn" type="button">See your decisions</button></div>
<h3 class="t-section" style="color:var(--ink);margin:32px 0 12px">No review running</h3>
<div class="empty"><span class="wg-empty-mark">{ico("calendar")}</span><span class="t-head">Next quarterly review starts Jan 5, 2027</span><p class="ink-2">Reviewers get it in their inbox that morning. You can start one sooner, for all clients or just a few.</p><button class="btn" type="button">Start a review now</button></div></div>
<div><h3 class="t-section" style="color:var(--ink);margin-bottom:12px">Completion report</h3>
<div class="rep"><div class="eyebrow">Merit Management Group<span class="sl">//</span>Access review Q2 2026</div><p class="t-head" style="margin-top:8px">Closed Jul 14, 2026 by Mike Heilman</p>
<table class="tbl tbl-fs" style="margin-top:16px"><colgroup><col><col style="width:80px"><col style="width:80px"><col style="width:80px"><col style="width:80px"></colgroup>
<thead><tr><th>Item kind</th><th class="n">Items</th><th class="n">Kept</th><th class="n">Reduced</th><th class="n">Revoked</th></tr></thead><tbody>
<tr class="fs-line"><td>Assignments with usage</td><td class="n">58</td><td class="n">54</td><td class="n">3</td><td class="n">1</td></tr>
<tr class="fs-line"><td>Allowed conflicts</td><td class="n">7</td><td class="n">6</td><td class="n">1</td><td class="n">0</td></tr>
<tr class="fs-line"><td>Dormant 90 days</td><td class="n">5</td><td class="n">0</td><td class="n">1</td><td class="n">4</td></tr>
<tr class="fs-line"><td>Unused capabilities</td><td class="n">11</td><td class="n">5</td><td class="n">6</td><td class="n">0</td></tr>
<tr class="fs-line"><td>Ending within 30 days</td><td class="n">7</td><td class="n">6</td><td class="n">0</td><td class="n">1</td></tr>
<tr class="fs-grand"><td>Total</td><td class="n">88</td><td class="n">71</td><td class="n">11</td><td class="n">6</td></tr></tbody></table>
<p class="t-cap" style="margin-top:12px">Each decision is listed after this page with reviewer, time, reason and the change applied. Saved to Documents for the SOC evidence folder.</p>
<div class="btn-row" style="margin-top:12px"><button class="btn btn--primary" type="button">{ico("download")}Download PDF</button><button class="btn" type="button">CSV</button></div></div></div></div>"""


JS = r"""<script>
(function(){
  var list=document.getElementById('list'),cards=[].slice.call(list.querySelectorAll('.attest')),cur=0,hist=[],left=19,done=14;
  var SIDE=[
   ['Dormant access','Luis Ortiz on Artistry Homes','<p class="ink-2">Revoking removes Bookkeeper on Artistry Homes only. Luis keeps his other 3 clients.</p><label class="check" style="margin-top:8px"><input type="checkbox" checked><i></i>Apply now, not at close</label>'],
   ['Unused capabilities','Dana Lee · sales tax prep','<p class="ink-2">Reduce mutes the capability on the clients you tick. Her role stays the same.</p><ul class="mute-l" style="margin-top:8px"><li><label class="check"><input type="checkbox" checked><i></i>Heritage Interiors</label></li><li><label class="check"><input type="checkbox" checked><i></i>Clive Power Equipment</label></li><li><label class="check"><input type="checkbox" checked><i></i>Swan Creek</label></li><li><label class="check"><input type="checkbox" checked><i></i>Wild Rose</label></li><li><label class="check"><input type="checkbox"><i></i>Crystal Kitchen &amp; Bath · used 3 times</label></li></ul>'],
   ['Allowed conflict','Owen Pratt · reopen and post','<p class="ink-2">Keeping renews nothing: it is still allowed only until Aug 1, 2027. Reducing would take reopening months out of his access on Metro and AIM.</p>'],
   ['Assignment','Sam Kovac on Clive Power Equipment','<p class="ink-2">Nothing unusual. Used daily, matches capacity.</p>'],
   ['Ends soon','Rachel Ames on Swan Creek','<p class="ink-2">Letting it end closes her access Nov 3. A new grant for 30 days needs Erin Vance, who granted the first.</p>'],
   ['Permission set','Priya · Year-end close','<p class="ink-2">Ends by itself Jan 31.</p>'],
   ['Assignment','Ben Okafor on 2 clients','<p class="ink-2">Granted this week.</p>']];
  function side(){var s=SIDE[cur]||SIDE[0];document.getElementById('side-k').textContent=s[0];document.getElementById('side-h').textContent=s[1];
    document.getElementById('side-b').innerHTML=s[2]+'<label class="field" style="margin-top:16px"><span class="field-label">Note · optional for keep, required for reduce or revoke</span><textarea class="textarea" rows="2"></textarea></label>';}
  function move(i){if(i<0||i>=cards.length)return;cards[cur].classList.remove('is-cursor');cur=i;cards[cur].classList.add('is-cursor');cards[cur].focus({preventScroll:false});side()}
  function decide(d){var c=cards[cur];if(/is-(kept|reduced|revoked)/.test(c.className))return;
    var cls={keep:'is-kept',reduce:'is-reduced',revoke:'is-revoked'}[d],lab={keep:'Kept',reduce:'Reduced',revoke:'Revoked'}[d];
    c.classList.add(cls);var l=c.querySelector('.done-l');l.innerHTML=(d==='revoke'?'<span class="slash" aria-hidden="true"></span>':'<svg class="ico" width="16" height="16" aria-hidden="true"><use href="#i-check"/></svg>')+lab+' · Jordan Smith';
    l.className='done-l '+(d==='keep'?'pos':d==='revoke'?'neg':'warn');
    left--;done++;hist.push([cur,cls]);upd();var who=c.querySelector('.attest-claim').textContent;
    mbToast(lab+': '+who,function(){undo()});move(Math.min(cur+1,cards.length-1));}
  function undo(){var h=hist.pop();if(!h)return;cards[h[0]].classList.remove(h[1]);left++;done--;upd();move(h[0])}
  function upd(){document.getElementById('ctx-left').textContent=left+' left for you';document.getElementById('tab-left').textContent=left;document.getElementById('done-n').textContent=done}
  list.addEventListener('click',function(e){var a=e.target.closest('.attest');if(!a)return;move(+a.dataset.i);var b=e.target.closest('[data-d]');if(b)decide(b.dataset.d)});
  document.addEventListener('keydown',function(e){if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;var k=e.key.toLowerCase();
    if(k==='j')move(cur+1);else if(k==='k')move(cur-1);else if(k==='a')decide('keep');else if(k==='r')decide('reduce');else if(k==='x')decide('revoke');else if(k==='z')undo();else return;e.preventDefault()});
  side();
})();
</script>"""


def build():
    h = head("S17 · Access review", CSS)
    b = sheet_top("S17-access-review.html") + '<main id="main" class="sheet">'
    b += board_h("S17", "05-RBAC §6.8 A8 · §4.4", "Every quarter, each grant is kept, cut back, or ended",
                 "Jordan reviews the access he handed out. Each card says what the grant is, the evidence of use as a ledger, and a suggestion; he keeps, reduces or revokes from the keyboard. Mike sees the whole campaign and the reports auditors ask for. The same review works on a phone.", "S17.1")
    b += frame(inbox_frame(), 1160, "Reviewer inbox. J/K move, A keep, R reduce, X revoke, Z undo. The spec’s “k keep” collides with “k move”, so keep is A, as approve is everywhere else.", "Live: keys, buttons, undo, side panel per card")
    b += '<div class="anno"><div><b>Evidence before verdict</b><p>The ledger under each claim is what a reviewer would otherwise look up: last use, count, capacity, who granted it.</p></div><div><b>Suggestions are labelled</b><p>The system proposes; Jordan decides. Suggest-revoke is red only as a tag, never as a pre-checked action.</p></div><div><b>Reduce is precise</b><p>For unused capabilities, reduce mutes them on the clients you tick and leaves the role alone.</p></div><div><b>No one reviews themselves</b><p>Jordan’s own access goes to Mike; Mike’s goes to Nora because he’s the only admin.</p></div></div>'
    b += '<div class="pair-h"><h2 class="t-section">The campaign</h2><span class="t-cap">Tenant admin view: progress by reviewer, setup, past reports</span></div>'
    b += frame(overview_frame(), 860, "Close stays off while items are open. Past reviews keep their PDF and CSV, saved to Documents.", "S17.2")
    b += '<div class="pair-h"><h2 class="t-section">On a phone</h2><span class="t-cap">390 wide</span></div>'
    b += frame(phone_frame(), 860, "", "S17.3")
    b += '<div class="pair-h"><h2 class="t-section">Done, empty, and the report</h2></div>'
    b += frame(close_frame(), 720, "The report’s rows sum to the total; it’s the artifact an auditor asks for.", "S17.4")
    b += '</main>'
    return h + b + foot(JS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "S17-access-review.html")
    open(out, "w").write(build()); print("wrote", out, len(build()))
