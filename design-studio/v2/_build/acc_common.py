"""Shared shell for the access-control boards (S13-S17). Builds on system.css
(including section 17, ACCESS). Page-local <style> is layout only."""
from html import escape as E

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Syne:wght@700&display=swap" rel="stylesheet">')

PAGES = [("S13-role-library.html", "S13 Roles"), ("S14-role-builder.html", "S14 Builder"),
         ("S15-user-access.html", "S15 Person"), ("S16-client-roles.html", "S16 Client roles"),
         ("S17-access-review.html", "S17 Review")]

BOARD_CSS = """
/* Board layout only (shared by S13-S17) */
body{min-width:1440px}
.sheet-top{display:flex;align-items:center;gap:24px;height:48px;padding:0 48px;background:var(--midnight);color:var(--grey-300)}
.sheet-top img{height:24px;width:auto}
.sheet-top nav{margin-left:auto;display:flex;gap:4px}
.sheet-top nav a{height:32px;display:inline-flex;align-items:center;padding:0 10px;color:var(--grey-300);font-weight:500;white-space:nowrap}
.sheet-top nav a:hover,.sheet-top nav a[aria-current=page]{background:var(--night-800);color:var(--warm)}
.sheet{padding:0 48px 96px}
.board-h{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding:40px 0 16px;border-bottom:1px solid var(--electric)}
.board-h p{margin-top:8px;color:var(--ink-2);max-width:84ch}
.board-h .pg{display:flex;align-items:center;gap:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.frame{border:1px solid var(--line-2);border-left:0;border-right:0;overflow:hidden;position:relative;margin:24px -48px 0;background:var(--warm)}
.frame-cap{display:flex;justify-content:space-between;gap:24px;margin-top:8px;font-size:12px;line-height:16px;color:var(--ink-3)}
.pair-h{display:flex;align-items:baseline;gap:12px;margin-top:48px}
.pair-h .t-section{color:var(--ink);white-space:nowrap}
.anno{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:24px}
.anno div{border-top:1px solid var(--line-2);padding-top:12px}
.anno b{display:block;font-weight:600;margin-bottom:4px}
.anno p{color:var(--ink-2)}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 20px;color:var(--ink-2);font-size:12px;line-height:16px}
.legend>span{display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.toast-region{bottom:32px}
[hidden]{display:none!important}
.audit-badge{position:fixed;right:16px;bottom:16px;z-index:999;max-width:460px;max-height:60vh;overflow:auto;padding:8px 12px;background:var(--midnight);color:var(--warm);font-size:12px;line-height:16px}
.audit-hit{outline:2px solid var(--neg)!important;outline-offset:-2px}
.l1.neg,.l2.neg{color:var(--neg)} .l1.warn,.l2.warn{color:var(--warn)} .l1.pos,.l2.pos{color:var(--pos)} .l2.blue{color:var(--electric)} .l2.ink-2{color:var(--ink-2)}
.app--frame{min-height:0;height:100%}
.app--frame .main{overflow:hidden}
.bar .ctx{flex:none}
.page-head .t-title{white-space:nowrap}
"""

ICONS = {
 "search": '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
 "down": '<path d="M4 6l4 4 4-4"/>',
 "right": '<path d="M3 8h10M9 4l4 4-4 4"/>',
 "chev": '<path d="M6 3.5 10.5 8 6 12.5"/>',
 "layers": '<path d="M8 2 14 5 8 8 2 5Z" stroke-linejoin="round"/><path d="M2 8.2l6 3 6-3"/><path d="M2 11.2l6 3 6-3"/>',
 "grid": '<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/>',
 "lock": '<rect x="3.5" y="7" width="9" height="6.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
 "x": '<path d="M4 4l8 8M12 4l-8 8"/>',
 "check": '<path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke-width="1.75"/>',
 "eye": '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
 "eye-off": '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5 13.5 2.5"/>',
 "history": '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.5H5"/><path d="M8 5v3.2l2 1.3"/>',
 "plus": '<path d="M8 3v10M3 8h10"/>',
 "minus": '<path d="M3.5 8h9"/>',
 "alert": '<path d="M8 2.2 14.2 13.5H1.8Z" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.2v1"/>',
 "shield": '<path d="M8 1.8 13.2 3.8v4.1c0 3-2.3 5.2-5.2 6.4C5.1 13.1 2.8 10.9 2.8 7.9V3.8Z" stroke-linejoin="round"/>',
 "clock": '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
 "user": '<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3"/>',
 "users": '<circle cx="6" cy="5.5" r="2.4"/><path d="M1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8"/><path d="M10.5 3.4a2.4 2.4 0 0 1 0 4.4M12 9.9c1.3.5 2.2 1.7 2.5 3.6"/>',
 "user-plus": '<circle cx="6.5" cy="5.5" r="2.6"/><path d="M1.5 14c.6-2.8 2.6-4.3 5-4.3 1.2 0 2.3.3 3.1 1M12.5 9v5M10 11.5h5"/>',
 "log": '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.5 4h1M2.5 8h1M2.5 12h1"/>',
 "key": '<circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5 13.5 2M11 4.5l2 2M9.5 6l1.5 1.5"/>',
 "send": '<path d="M2 8 14 2.5 10.5 14 8 9Z" stroke-linejoin="round"/><path d="M8 9l6-6.5"/>',
 "copy": '<rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-3h-8v8h3"/>',
 "cols": '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M6.2 2.5v11M9.8 2.5v11"/>',
 "download": '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7"/><path d="M2.5 13.5h11"/>',
 "home": '<path d="M2.5 7.5 8 2.5l5.5 5v6h-11Z" stroke-linejoin="round"/><path d="M6.5 13.5v-4h3v4"/>',
 "inbox": '<path d="M2.5 9.5 4 3h8l1.5 6.5v4h-11Z" stroke-linejoin="round"/><path d="M2.5 9.5h3.5l.8 1.5h2.4l.8-1.5h3.5"/>',
 "building": '<rect x="3" y="2.5" width="10" height="11"/><path d="M6 5.5h1M9 5.5h1M6 8.5h1M9 8.5h1M7 13.5v-2h2v2"/>',
 "work": '<path d="M2.5 4.5h2M2.5 8h2M2.5 11.5h2M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/>',
 "chart": '<path d="M2.5 13.5h11"/><path d="M4 11V7.5M7 11V4M10 11V6M13 11V9"/>',
 "plug": '<path d="M6 2v3.5M10 2v3.5M4 5.5h8v2a4 4 0 0 1-8 0Z"/><path d="M8 11.5V14"/>',
 "gear": '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
 "bill": '<path d="M4 2h5.5L12 4.5V14H4Z" stroke-linejoin="round"/><path d="M6 7.5h4M6 10.5h3"/>',
 "receipt": '<path d="M4 2h8v12l-2-1.2L8 14l-2-1.2L4 14Z" stroke-linejoin="round"/><path d="M6 6h4M6 9h4"/>',
 "doc": '<path d="M4 2h5.5L12 4.5V14H4Z" stroke-linejoin="round"/>',
 "ask": '<path d="M2.5 3h11v8H7l-3 2.5V11H2.5Z" stroke-linejoin="round"/>',
 "cash": '<rect x="1.5" y="4" width="13" height="8"/><circle cx="8" cy="8" r="1.8"/>',
 "money": '<path d="M8 2v12M11 4.5H6.7a1.8 1.8 0 0 0 0 3.6h2.6a1.8 1.8 0 0 1 0 3.6H5"/>',
 "mail": '<rect x="2" y="3.5" width="12" height="9"/><path d="M2 4l6 5 6-5" stroke-linejoin="round"/>',
 "info": '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v4M8 4.8v.6"/>',
 "undo": '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/>',
 "filter": '<path d="M2.5 3.5h11L9.2 8.5v4l-2.4 1.2V8.5Z" stroke-linejoin="round"/>',
 "calendar": '<rect x="2.5" y="3.5" width="11" height="10"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
 "phone": '<rect x="4.5" y="1.8" width="7" height="12.4"/><path d="M7 12h2"/>',
}


def sprite():
    out = ['<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>']
    for k, v in ICONS.items():
        out.append(f'<symbol id="i-{k}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">{v}</symbol>')
    out.append('</defs></svg>')
    return "\n".join(out)


SPRITE = sprite()


def ico(name, size=16, cls="ico", label=None):
    a = f'role="img" aria-label="{E(label)}"' if label else 'aria-hidden="true"'
    return f'<svg class="{cls}" width="{size}" height="{size}" {a}><use href="#i-{name}"/></svg>'


def head(title, css=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<title>{E(title)} · MeritBooks</title>
{FONTS}
<link rel="stylesheet" href="system.css">
<!--BOARD--><style>{BOARD_CSS}</style><!--/BOARD-->
<style>{css}</style></head>
<body>
<!--SPRITE-->{SPRITE}<!--/SPRITE-->
<a class="skip" href="#main">Skip to content</a>"""


def sheet_top(current):
    links = '<a href="index.html">Index</a>' + "".join(
        f'<a href="{h}"{" aria-current=page" if h == current else ""}>{E(t)}</a>' for h, t in PAGES)
    return (f'<header class="sheet-top on-dark"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="eyebrow" style="color:var(--slate)">MeritBooks<span class="sl">//</span>Access &amp; roles</span>'
            f'<nav aria-label="Design system pages">{links}</nav></header>')


def board_h(code, ref, title, para, pg):
    return (f'<div class="board-h"><div><div class="eyebrow">{code}<span class="sl">//</span>{ref}</div>'
            f'<h1 class="t-title" style="margin-top:8px">{title}</h1><p>{para}</p></div>'
            f'<span class="pg"><span class="tag">Sample data</span>{pg}</span></div>')


def frame(inner, h, cap_l, cap_r="", fid=""):
    i = f' id="{fid}"' if fid else ""
    return (f'<div class="frame"{i} style="height:{h}px">{inner}</div>'
            f'<div class="frame-cap"><span>{cap_l}</span><span>{cap_r}</span></div>')


# ---------------------------------------------------------------- rails
def _link(label, cur, count=None, alert=False):
    c = ""
    if count is not None:
        c = f'<span class="count{" count--alert" if alert else ""}">{count}</span>'
    ac = ' aria-current="page"' if label == cur else ""
    return f'<a class="rail-link" href="#"{ac}>{E(label)}{c}</a>'


def rail_workspace(cur, who="mike"):
    """Full role-filtered workspace nav (IA 3.5) for Mike (owner + tenant admin)
    or Jordan (accounting manager)."""
    g = []
    def grp(n): g.append(f'<div class="rail-group">{n}</div>')
    grp("Home"); g += [_link("Home", cur), _link("Inbox", cur, 6)]
    grp("Clients"); g += [_link("Client registry", cur, 13), _link("Add clients", cur), _link("Onboarding tracker", cur)]
    grp("Work"); g += [_link("Close grid", cur, 4, True), _link("Review queue", cur, 8), _link("Requests &amp; chases".replace("&amp;", "&"), cur, 11),
                      _link("Exceptions", cur, 3), _link("Agents & gates", cur), _link("Practice tasks", cur)]
    grp("Team"); g += [_link("Staff & capacity", cur), _link("Capacity assignments", cur), _link("Access", cur),
                      _link("Access requests", cur, 2), _link("Access reviews", cur, 33 if who == "jordan" else 1)]
    if who == "mike":
        grp("Consolidations"); g += [_link("Groups", cur, 2)]
    grp("Insights"); g += [_link("Books health", cur), _link("Cash across clients", cur), _link("Compare clients", cur),
                          _link("Profitability by client", cur), _link("Team performance", cur)]
    if who == "mike":
        g += [_link("Client economics", cur)]
    grp("Integrations"); g += [_link("Integrations hub", cur)]
    grp("Settings")
    if who == "mike":
        g += [_link(x, cur) for x in ["Organization", "Security", "Access & roles", "Approval workflows", "Policies",
                                      "AI & automation", "Notifications & alerts", "Dashboard layouts",
                                      "Defaults for new clients", "Plan & billing", "Support access", "Data & danger zone"]]
        user = ("MH", "Mike Heilman", "Owner · Tenant admin")
    else:
        g += [_link("Dashboard layouts", cur)]
        user = ("JS", "Jordan Smith", "Accounting manager")
    return (f'<aside class="rail" aria-label="Primary"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="prod">BOOKS</span></div><nav class="rail-nav" data-scroll-current>{"".join(g)}</nav>'
            f'<div class="rail-foot"><div class="rail-user"><span class="avatar">{user[0]}</span><span>{user[1]}<small>{user[2]}</small></span></div></div></aside>')


def rail_mini(cur_group="Settings", initials="MH"):
    items = [("home", "Home"), ("inbox", "Inbox · 6"), ("building", "Clients"), ("work", "Work"), ("users", "Team"),
             ("layers", "Consolidations"), ("chart", "Insights"), ("plug", "Integrations"), ("gear", "Settings")]
    links = "".join(f'<a class="rail-icon" href="#" aria-label="{E(t)}" title="{E(t)}"{" aria-current=page" if t == cur_group else ""}>{ico(i)}</a>'
                    for i, t in items)
    return (f'<aside class="rail" aria-label="Primary (collapsed)"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24" style="height:16px"></div>'
            f'<nav class="rail-nav" style="padding-top:12px">{links}</nav>'
            f'<div class="rail-foot" style="padding:16px 0;display:grid;place-items:center"><span class="avatar" title="Mike Heilman">{initials}</span></div></aside>')


def rail_client_admin(cur):
    g = []
    def grp(n): g.append(f'<div class="rail-group">{n}</div>')
    grp("Home"); g += [_link("Home", cur), _link("Requests", cur, 3)]
    grp("Spend"); g += [_link("Bills", cur, 5), _link("Expenses & receipts", cur, 2), _link("Vendors", cur)]
    grp("Sales"); g += [_link("Invoices", cur), _link("Customers", cur)]
    grp("Reports"); g += [_link("Financial reports", cur), _link("Cash position", cur)]
    grp("Files"); g += [_link("Documents", cur)]
    grp("Client settings"); g += [_link("People & access", cur), _link("Team & roles", cur)]
    return (f'<aside class="rail" aria-label="Primary"><div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="prod">BOOKS</span></div><nav class="rail-nav" data-scroll-current>{"".join(g)}</nav>'
            f'<div class="rail-foot"><div class="rail-user"><span class="avatar">LP</span><span>Lauren Pierce<small>Client admin · Heritage</small></span></div></div></aside>')


def bar_workspace(crumbs, sync="Synced 9:12 AM"):
    return (f'<header class="bar"><button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false">{ico("grid")}'
            f'<span class="ctx-name">Merit Management Group</span><span class="ctx-meta">Workspace</span>{ico("down")}<span class="kbd">⌘J</span></button>'
            f'<span class="crumbs">{crumbs}</span><button class="cmdk" type="button">{ico("search")}<span>Jump to client, person, role…</span><span class="kbd">⌘K</span></button>'
            f'<span class="sync"><i aria-hidden="true"></i>{sync}</span></header>')


def bar_client(name, meta, crumbs):
    return (f'<header class="bar"><button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false"><i class="pip pip--open" aria-hidden="true"></i>'
            f'<span class="ctx-name">{name}</span><span class="ctx-meta tnum">{meta}</span>{ico("down")}</button>'
            f'<span class="crumbs">{crumbs}</span><button class="cmdk" type="button">{ico("search")}<span>Search bills, vendors, people…</span><span class="kbd">⌘K</span></button></header>')


def legend(full=True):
    items = [('<span class="cap cap--sm is-on"><i></i></span>', "Granted"),
             ('<span class="cap cap--sm"><i></i></span>', "Not granted"),
             ('<span class="cap cap--sm is-on is-lim"><i></i></span>', "Granted with a limit"),
             ('<span class="cap cap--sm is-set"><i></i></span>', "From a permission set"),
             ('<span class="cap cap--sm is-muted"><i></i></span>', "Muted on this assignment")]
    if full:
        items += [('<span class="cap cap--sm is-on" data-delta="add"><i></i></span>', "Added vs template"),
                  ('<span class="cap cap--sm" data-delta="rem"><i></i></span>', "Removed vs template"),
                  ('<span class="cap cap--sm is-on is-hard"><i></i></span>', "Hard conflict"),
                  ('<span class="cap cap--sm is-on is-soft"><i></i></span>', "Soft conflict")]
    items += [(ico("money", 14), "Moves money"), (ico("eye-off", 14), "Sensitive fields"), (ico("lock", 14), "Re-verify to use")]
    return '<div class="legend" aria-label="Legend">' + "".join(f'<span>{a}{b}</span>' for a, b in items) + '</div>'


TOAST_JS = """<div class="toast-region" aria-live="polite" id="toasts"></div>
<script>
window.mbToast=function(msg,undo){
  var r=document.getElementById('toasts');r.innerHTML='';
  var t=document.createElement('div');t.className='toast';t.setAttribute('role','status');
  t.innerHTML='<span class="toast-mark"></span><span></span>';t.children[1].textContent=msg;
  if(undo){var b=document.createElement('button');b.className='btn btn--quiet';b.type='button';b.innerHTML='Undo<span class="kbd">⌘</span><span class="kbd">Z</span>';
    b.onclick=function(){undo();r.innerHTML=''};t.appendChild(b);}
  r.appendChild(t);clearTimeout(window.__tt);window.__tt=setTimeout(function(){r.innerHTML=''},6000);
};
document.querySelectorAll('[data-scroll-current]').forEach(function(n){var c=n.querySelector('[aria-current=page]');if(c){n.scrollTop=Math.max(0,c.offsetTop-n.clientHeight/2)}});
</script>"""

AUDIT_JS = """<script>
/* Layout audit: add ?audit (or set window.__AUDIT). Outlines clipped text and targets under 32px. */
(function(){
  var on=/[?&]audit/.test(location.search)||window.__AUDIT;
  function run(){
    var bad=[],small=[];
    document.querySelectorAll('.l1,.l2,td,th,.btn,.tag,.lvl,.ctx-name,.status,.field-label,.seg button,.rail-link,.tab,.crumbs,.kv dd,.kv dt,.sod-row p,.trace .tl,.attest-claim,.fit').forEach(function(el){
      if(!el.offsetParent&&getComputedStyle(el).position!=='fixed')return;
      if(el.closest('[data-audit-skip]'))return;
      if(el.scrollWidth>el.clientWidth+1&&getComputedStyle(el).overflow!=='visible'){bad.push(el)}
    });
    document.querySelectorAll('button,a.btn,.btn,input[type=checkbox],input[type=radio],select,.input,.rail-link,.popover-item,.cap:not(.cap--sm)').forEach(function(el){
      if(!el.offsetParent)return; if(el.closest('[data-audit-skip]'))return;
      var t=el.matches('input[type=checkbox],input[type=radio]')?el.parentElement:el;
      var r=t.getBoundingClientRect(); if(r.width===0)return;
      if(r.height<31.5){small.push(t)}
    });
    window.__auditResult={overflow:bad.length,small:small.length};
    if(on){
      bad.concat(small).forEach(function(e){e.classList.add('audit-hit')});
      var b=document.createElement('div');b.className='audit-badge';b.setAttribute('data-audit-skip','');
      b.innerHTML='<b>Layout audit</b> · '+bad.length+' overflow · '+small.length+' small targets<br>'+
        bad.slice(0,16).map(function(e){return 'overflow: '+(e.textContent||'').trim().slice(0,48).replace(/</g,'&lt;')+' ('+e.scrollWidth+'>'+e.clientWidth+')'}).join('<br>')+
        (small.length?'<br>'+small.slice(0,10).map(function(e){return 'small: '+(e.textContent||e.getAttribute('aria-label')||e.tagName).trim().slice(0,40)+' h'+Math.round(e.getBoundingClientRect().height)}).join('<br>'):'');
      document.body.appendChild(b);
    }
  }
  (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(run,400)});
})();
</script>"""


def foot(js=""):
    return f'{TOAST_JS}\n{js}\n{AUDIT_JS}\n</body></html>'
