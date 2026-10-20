"""Review bundle for S13-S17: shared sprite/board CSS/scripts pulled out of the
pages, CSS comments stripped, logo downscaled. Writes to argv[1]."""
import os, re, sys
from PIL import Image
import acc_common as C
from acc_matrix import MATRIX_JS
from acc_data import js_base
import s16 as _s16
import s13, s14, s15, s16, s17

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)
V2 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mini_css(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"\s*\n\s*", "\n", s).strip() + "\n"


RAILS = {"m": C.rail_workspace("Access & roles"), "ja": C.rail_workspace("Access", "jordan"), "jr": C.rail_workspace("Access reviews", "jordan"),
         "mr": C.rail_workspace("Access reviews"), "mini": C.rail_mini("Settings"), "ca": C.rail_client_admin("Team & roles"), "fc": _s16.rail_firm_client()}


def mini_css2(s):
    s = mini_css(s)
    s = re.sub(r"\s*([{};,>])\s*", r"\1", s)
    s = re.sub(r":\s+", ":", s)
    return s.replace(";}", "}")


def page(html):
    html = re.sub(r"<!--SPRITE-->.*?<!--/SPRITE-->", "", html, flags=re.S)
    html = re.sub(r"<!--BOARD-->.*?<!--/BOARD-->", '<link rel="stylesheet" href="access.css">', html, flags=re.S)
    html = html.replace(C.TOAST_JS, '<div class="toast-region" aria-live="polite" id="toasts"></div>').replace(C.AUDIT_JS, "")
    html = html.replace(js_base() + "\n", "").replace(MATRIX_JS, "")
    html = html.replace("<script>\nObject.assign(MB,", '<script src="matrix.js"></script><script>\nObject.assign(MB,')
    for k, r in RAILS.items():
        html = html.replace(r, f'<aside class="rail" data-r="{k}"></aside>')
    html = html.replace('href="#i-', 'href="sprite.svg#i-').replace("href=\\\"#i-", "href=\\\"sprite.svg#i-").replace('href="#i-', 'href="sprite.svg#i-')
    html = html.replace("use href=\"#i-", "use href=\"sprite.svg#i-")
    html = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css2(m.group(1)) + "</style>", html, flags=re.S)
    html = html.replace("</body></html>", '<script src="access.js"></script></body></html>')
    html = re.sub(r">\s*\n\s*<", ">\n<", html)
    return html


pages = {"S13-role-library.html": s13.build(), "S14-role-builder.html": s14.build(), "S15-user-access.html": s15.build(),
         "S16-client-roles.html": s16.build(), "S17-access-review.html": s17.build()}
for k, v in pages.items():
    open(os.path.join(OUT, k), "w").write(page(v))
# v2.3 access rules also live in system.css; repeated here so the bundle works on the system.css already deployed.
V23 = """.capm th{padding:0 2px}.capm th:first-child{padding-left:16px}
.sod-mark{display:grid;place-items:center;width:32px;height:32px}
.sod-row--hard .sod-mark{color:var(--neg)} .sod-row--soft .sod-mark{color:var(--warn)} .sod-row--held .sod-mark{color:var(--ink-2)}
.sod-fix{display:block;margin-top:2px;color:var(--ink-2)}"""
open(os.path.join(OUT, "access.css"), "w").write(mini_css2(C.BOARD_CSS + V23))
open(os.path.join(OUT, "matrix.js"), "w").write(js_base() + "\n" + MATRIX_JS.strip().replace("#i-", "sprite.svg#i-") + "\n")
js = (C.TOAST_JS + C.AUDIT_JS).replace('<div class="toast-region" aria-live="polite" id="toasts"></div>', "")
RJS = r"""(function(){
function E(t){return t.replace(/&/g,'&amp;')}
function L(t,cur,c,al){return '<a class="rail-link" href="#"'+(t===cur?' aria-current="page"':'')+'>'+E(t)+(c!=null?'<span class="count'+(al?' count--alert':'')+'">'+c+'</span>':'')+'</a>'}
function G(n){return '<div class="rail-group">'+n+'</div>'}
function M(a,cur){return a.map(function(x){return L(x,cur)}).join('')}
function S(nav,av,nm,role){return '<aside class="rail" aria-label="Primary"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24"><span class="prod">BOOKS</span></div><nav class="rail-nav" data-scroll-current>'+nav+'</nav><div class="rail-foot"><div class="rail-user"><span class="avatar">'+av+'</span><span>'+nm+'<small>'+role+'</small></span></div></div></aside>'}
function W(m,cur){var h=G('Home')+L('Home',cur)+L('Inbox',cur,6)+G('Clients')+L('Client registry',cur,13)+M(['Add clients','Onboarding tracker'],cur)+G('Work')+L('Close grid',cur,4,1)+L('Review queue',cur,8)+L('Requests & chases',cur,11)+L('Exceptions',cur,3)+M(['Agents & gates','Practice tasks'],cur)+G('Team')+M(['Staff & capacity','Capacity assignments','Access'],cur)+L('Access requests',cur,2)+L('Access reviews',cur,m?1:33);
 if(m)h+=G('Consolidations')+L('Groups',cur,2);
 h+=G('Insights')+M(['Books health','Cash across clients','Compare clients','Profitability by client','Team performance'].concat(m?['Client economics']:[]),cur)+G('Integrations')+L('Integrations hub',cur)+G('Settings')+M(m?['Organization','Security','Access & roles','Approval workflows','Policies','AI & automation','Notifications & alerts','Dashboard layouts','Defaults for new clients','Plan & billing','Support access','Data & danger zone']:['Dashboard layouts'],cur);
 return m?S(h,'MH','Mike Heilman','Owner · Tenant admin'):S(h,'JS','Jordan Smith','Accounting manager')}
function I(i,t,cur){return '<a class="rail-icon" href="#" aria-label="'+t+'" title="'+t+'"'+(t===cur?' aria-current=page':'')+'><svg class="ico" width="16" height="16" aria-hidden="true"><use href="sprite.svg#i-'+i+'"/></svg></a>'}
var R={m:function(){return W(1,'Access & roles')},mr:function(){return W(1,'Access reviews')},ja:function(){return W(0,'Access')},jr:function(){return W(0,'Access reviews')},
 mini:function(){return '<aside class="rail" aria-label="Primary (collapsed)"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24" style="height:16px"></div><nav class="rail-nav" style="padding-top:12px">'+[['home','Home'],['inbox','Inbox · 6'],['building','Clients'],['work','Work'],['users','Team'],['layers','Consolidations'],['chart','Insights'],['plug','Integrations'],['gear','Settings']].map(function(x){return I(x[0],x[1],'Settings')}).join('')+'</nav><div class="rail-foot" style="padding:16px 0;display:grid;place-items:center"><span class="avatar" title="Mike Heilman">MH</span></div></aside>'},
 ca:function(){var c='Team & roles';return S(G('Home')+L('Home',c)+L('Requests',c,3)+G('Spend')+L('Bills',c,5)+L('Expenses & receipts',c,2)+L('Vendors',c)+G('Sales')+M(['Invoices','Customers'],c)+G('Reports')+M(['Financial reports','Cash position'],c)+G('Files')+L('Documents',c)+G('Client settings')+M(['People & access','Team & roles'],c),'LP','Lauren Pierce','Client admin · Heritage')},
 fc:function(){var c='People & access';return S(G('Books')+L('Client home',c)+L('To review',c,18)+M(['Reconcile','Close checklist'],c)+G('Spend')+L('Bills',c,7)+M(['Pay runs','Expenses & receipts'],c)+G('Sales')+M(['Invoices','Collections'],c)+G('Reports')+M(['Financial reports','Debt & covenants'],c)+G('Client settings')+M(['Client profile','People & access','Accounting setup','Bank & card connections'],c),'JS','Jordan Smith','Accounting manager')}};
document.querySelectorAll('aside[data-r]').forEach(function(a){a.outerHTML=R[a.dataset.r]()});
})();
"""
rail_js = RJS
js = rail_js + re.sub(r"</?script>", "", js).replace("#i-", "sprite.svg#i-")
open(os.path.join(OUT, "access.js"), "w").write(js.strip() + "\n")
sp = C.SPRITE.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>', '<svg xmlns="http://www.w3.org/2000/svg"><defs>')
open(os.path.join(OUT, "sprite.svg"), "w").write(sp + "\n")
open(os.path.join(OUT, "system.css"), "w").write(mini_css2(open(os.path.join(V2, "system.css")).read()))
idx = open(os.path.join(V2, "index.html")).read()
keep = set(pages)
idx = re.sub(r'\s*<li><a href="([^"]+)">.*?</li>', lambda m: m.group(0) if m.group(1) in keep else "", idx, flags=re.S)
idx = idx.replace("<dt>Stylesheet</dt>", "<dt>Review set</dt><dd>S13–S17 · access &amp; roles · Oct 20, 2026</dd><dt>Stylesheet</dt>")
idx = re.sub(r"<style>(.*?)</style>", lambda m: "<style>" + mini_css(m.group(1)) + "</style>", idx, flags=re.S)
open(os.path.join(OUT, "index.html"), "w").write(re.sub(r">\s*\n\s*<", ">\n<", idx))
im = Image.open(os.path.join(V2, "assets", "merit-logo-on-dark.png")).convert("RGBA")
im = im.resize((160, 48), Image.LANCZOS).quantize(colors=24, method=Image.FASTOCTREE)
im.save(os.path.join(OUT, "assets", "merit-logo-on-dark.png"), optimize=True)
tot = 0
for root, _, fs in os.walk(OUT):
    for f in sorted(fs):
        p = os.path.join(root, f); tot += os.path.getsize(p); print(os.path.relpath(p, OUT), os.path.getsize(p))
print("total", tot)
