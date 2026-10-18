"""Shared markup for the v2 screen boards. Pages link system.css; page-local
<style> is layout only (grid placement, widths). No new colours or fonts."""
from html import escape as E

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Syne:wght@700&display=swap" rel="stylesheet">')

NAV = [("index.html", "Index"), ("components.html", "Components"), ("S6-owner-home.html", "S6 Owner"),
       ("S6b-cfo-home.html", "S6b CFO"), ("S6c-controller-home.html", "S6c Controller"),
       ("S7-switcher-and-contexts.html", "S7 Switcher"), ("S8-dashboard-edit.html", "S8 Edit"),
       ("S9-platform-console-home.html", "S9 Platform")]

BOARD_CSS = """
/* Board layout only — not part of the system */
body{min-width:1440px}
.sheet-top{display:flex;align-items:center;gap:24px;height:48px;padding:0 48px;background:var(--midnight);color:var(--grey-300)}
.sheet-top img{height:24px;width:auto}
.sheet-top nav{margin-left:auto;display:flex;gap:4px}
.sheet-top nav a{height:32px;display:inline-flex;align-items:center;padding:0 10px;color:var(--grey-300);font-weight:500;white-space:nowrap}
.sheet-top nav a:hover,.sheet-top nav a[aria-current=page]{background:var(--night-800);color:var(--warm)}
.sheet{padding:0 48px 96px}
.board-h{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding:40px 0 16px;border-bottom:1px solid var(--electric)}
.board-h p{margin-top:8px;color:var(--ink-2);max-width:80ch}
.board-h .pg{font-variant-numeric:tabular-nums;white-space:nowrap}
.frame{border:1px solid var(--line-2);border-left:0;border-right:0;overflow:hidden;position:relative;margin:24px -48px 0;background:var(--warm)}
.frame-cap{display:flex;justify-content:space-between;gap:24px;margin-top:8px;font-size:12px;line-height:16px;color:var(--ink-3)}
.anno{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:24px}
.anno div{border-top:1px solid var(--line-2);padding-top:12px}
.anno b{display:block;font-weight:600;margin-bottom:4px}
.anno p{color:var(--ink-2)}
.app--frame .rail{min-height:100%}
[hidden]{display:none!important}
.sample{margin-left:16px;color:var(--ink-3);font-size:12px}
/* Privacy: figures become redaction bars of their own width, so nothing reflows */
.is-private .pv{color:transparent!important;background:var(--grey-300);box-decoration-break:clone;-webkit-box-decoration-break:clone}
.is-private .pv *{visibility:hidden}
.btn--primary .pv{background:transparent}
.is-private .btn--primary .pv{background:var(--blue-300)}
"""

SPRITE = """<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></symbol>
<symbol id="i-down" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></symbol>
<symbol id="i-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8h10M9 4l4 4-4 4"/></symbol>
<symbol id="i-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5 10.5 8 6 12.5"/></symbol>
<symbol id="i-layers" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 14 5 8 8 2 5Z"/><path d="M2 8.2l6 3 6-3"/><path d="M2 11.2l6 3 6-3"/></symbol>
<symbol id="i-grid" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/></symbol>
<symbol id="i-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="7" width="9" height="6.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></symbol>
<symbol id="i-sliders" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5h12M2 11h12"/><rect x="9" y="3" width="2.5" height="4" fill="#fff"/><rect x="4.5" y="9" width="2.5" height="4" fill="#fff"/></symbol>
<symbol id="i-x" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></symbol>
<symbol id="i-bill" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 2h5.5L12 4.5V14H4Z"/><path d="M6 7.5h4M6 10.5h3"/></symbol>
<symbol id="i-eye" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></symbol>
<symbol id="i-eye-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5 13.5 2.5"/></symbol>
<symbol id="i-undo" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/></symbol>
<symbol id="i-plug" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2v3.5M10 2v3.5M4 5.5h8v2a4 4 0 0 1-8 0Z"/><path d="M8 11.5V14"/></symbol>
<symbol id="i-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></symbol>
<symbol id="i-flag" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.5 14V2.5h8l-1.5 3 1.5 3h-8"/></symbol>
<symbol id="i-ask" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3h11v8H7l-3 2.5V11H2.5Z"/></symbol>
<symbol id="i-book" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 2.5h7.5L13 5v8.5H3Z"/><path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3"/></symbol>
<symbol id="i-pause" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5v9M10 3.5v9"/></symbol>
<symbol id="i-shield" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.8 13 3.6v4c0 3-2.2 5.3-5 6.6-2.8-1.3-5-3.6-5-6.6v-4Z"/></symbol>
<symbol id="i-alert" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 14.5 13.5h-13Z"/><path d="M8 6.5v3.5M8 11.4v.1"/></symbol>
</defs></svg>"""


def ico(name, size=16, cls="ico"):
    return f'<svg class="{cls}" width="{size}" height="{size}" aria-hidden="true"><use href="#i-{name}"/></svg>'


def head(title, extra_css=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<title>{title} · MeritBooks</title>
{FONTS}
<link rel="stylesheet" href="system.css">
<style>{BOARD_CSS}{extra_css}</style></head>
<body>
{SPRITE}
<a class="skip" href="#main">Skip to content</a>"""


def sheet_top(current):
    AC = ' aria-current="page"'
    links = "".join(f'<a href="{h}"{AC if h == current else ""}>{E(t)}</a>' for h, t in NAV)
    return (f'<header class="sheet-top on-dark"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="eyebrow" style="color:var(--slate)">MeritBooks<span class="sl">//</span>Design System v2</span>'
            f'<nav aria-label="Design system pages">{links}</nav></header>')


def board_h(eyebrow, title, para, pg, h="h1", style=""):
    return (f'<div class="board-h"{style}><div><div class="eyebrow">{eyebrow}</div><{h} class="t-title" style="margin-top:8px">{title}</{h}>'
            f'<p>{para}</p></div><span class="pg">{pg}</span></div>')


def anno(items):
    return '<div class="anno">' + "".join(f"<div><b>{b}</b><p>{p}</p></div>" for b, p in items) + "</div>"


# ---------------------------------------------------------------- numbers
def f0(x):
    """Whole dollars, negatives in parentheses."""
    return f"({abs(x):,.0f})" if x < 0 else f"{x:,.0f}"


def f2(x):
    return f"({abs(x):,.2f})" if x < 0 else f"{x:,.2f}"


def sgn0(x):
    """Signed change for captions: +612,034 / (63,765)."""
    return f"({abs(x):,.0f})" if x < 0 else f"+{x:,.0f}"


def pts(x):
    return f"{'+' if x >= 0 else '−'}{abs(x):.1f} pts"


def pv(s):
    return f'<span class="pv">{s}</span>'


def cell(x, dec=0, cls="", private=True):
    """Statement cell: hanging paren on positives so digits align."""
    s = f2(x) if dec else f0(x)
    if x >= 0:
        s = s + '<span class="hp">)</span>'
    inner = pv(s) if private else s
    return f'<td class="n{(" " + cls) if cls else ""}">{inner}</td>'


HP = '<span class="hp">)</span>'


def pct_cell(p, cls=""):
    s = f"{p:.1f}%" + HP
    c = (" " + cls) if cls else ""
    return f'<td class="n{c}">{pv(s)}</td>'


STATUS = {"closed": ("ready", "Closed"), "ready": ("ready", "Ready for review"), "track": ("track", "On track"),
          "risk": ("risk", "At risk"), "overdue": ("overdue", "Overdue"), "blocked": ("blocked", "Blocked")}


def status(kind, word=None):
    k, w = STATUS.get(kind, (kind, kind))
    return f'<span class="status status--{k}"><i class="pip pip--{k}" aria-hidden="true"></i>{E(word or w)}</span>'


def meter(on, part=0, total=13, bad=0, label=""):
    cells = ['<i class="on"></i>'] * on + ['<i class="part"></i>'] * part + ['<i class="bad"></i>'] * bad
    cells += ["<i></i>"] * (total - len(cells))
    return f'<span class="meter" role="img" aria-label="{E(label)}">{"".join(cells)}</span>'


# ---------------------------------------------------------------- shell
def rail(groups, user, role, foot_extra="", logo_alt="Merit"):
    out = ['<aside class="rail" aria-label="Primary">',
           f'<div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="{logo_alt}" width="80" height="24"><span class="prod">BOOKS</span></div>',
           '<nav class="rail-nav">']
    for g, links in groups:
        if g:
            out.append(f'<div class="rail-group">{E(g)}</div>')
        for l in links:
            label, cur = l[0], (len(l) > 1 and l[1])
            count = l[2] if len(l) > 2 else ""
            alert = len(l) > 3 and l[3]
            c = f'<span class="count{" count--alert" if alert else ""}">{count}</span>' if count != "" else ""
            AC = ' aria-current="page"'
            out.append(f'<a class="rail-link" href="#"{AC if cur else ""}>{E(label)}{c}</a>')
    out.append("</nav>")
    initials = "".join(p[0] for p in user.split()[:2])
    out.append(f'<div class="rail-foot">{foot_extra}<div class="rail-user"><span class="avatar">{initials}</span><span>{E(user)}<small>{E(role)}</small></span></div></div></aside>')
    return "".join(out)


def bar(ctx_html, crumbs, cmd="Jump to client, report, bill…", sync="Synced 7:42 AM"):
    return (f'<header class="bar">{ctx_html}<span class="crumbs"><b>{E(crumbs)}</b></span>'
            f'<button class="cmdk" type="button">{ico("search")}<span>{E(cmd)}</span><kbd class="kbd">⌘K</kbd></button>'
            f'<span class="sync"><i aria-hidden="true"></i>{E(sync)}</span></header>')


def ctx_workspace(name="Merit Management Group", meta="Workspace"):
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false">{ico("grid")}<span class="ctx-name">{E(name)}</span>'
            f'<span class="ctx-meta">{E(meta)}</span>{ico("down")}<span class="kbd">⌘J</span></button>')


def ctxline(parts, right=""):
    segs = '<span class="sl">//</span>'.join(parts)
    return f'<div class="ctxline">{segs}<span class="sp"></span>{right}</div>'


def customize_btn():
    return f'<button class="btn btn--quiet" type="button">{ico("sliders")}Customize</button>'


def privacy_btn(pressed=False):
    return (f'<button class="btn btn--quiet" type="button" data-privacy aria-pressed="{"true" if pressed else "false"}" style="margin-right:4px">'
            f'{ico("eye-off" if pressed else "eye")}<span>{"Show figures" if pressed else "Hide figures"}</span><span class="kbd">⇧H</span></button>')


def app(context, density, rail_html, bar_html, main_html, extra_cls="", style=""):
    xc = (" " + extra_cls) if extra_cls else ""
    st = f' style="{style}"' if style else ""
    return (f'<div class="app app--frame {density}{xc}" data-context="{context}"{st}>'
            f'{rail_html}{bar_html}<div class="main">{main_html}</div></div>')


def wg(wid, title, body, x, y, w, h, count="", meta="", act="", foot="", primary=False, extra_cls="", label_id=None):
    lid = label_id or f"h-{wid}"
    c = f'<span class="wg-count">{count}</span>' if count != "" else ""
    m = f'<span class="wg-meta">{meta}</span>' if meta else ""
    a = f'<div class="wg-act">{act}</div>' if act else ""
    f = f'<div class="wg-foot">{foot}</div>' if foot else ""
    cls = "wg" + (" wg--primary" if primary else "") + ((" " + extra_cls) if extra_cls else "")
    return (f'<section class="{cls}" style="--x:{x};--y:{y};--w:{w};--h:{h}" aria-labelledby="{lid}" data-widget="{wid}">'
            f'<div class="wg-head"><h2 class="wg-title" id="{lid}">{title}</h2>{c}{m}{a}</div>'
            f'<div class="wg-body">{body}</div>{f}</section>')


SCRIPT = """<script>
(function(){
  /* privacy toggle — per frame; ⇧H toggles the first frame */
  function setPriv(appEl,on){appEl.classList.toggle('is-private',on);
    appEl.querySelectorAll('[data-privacy]').forEach(function(b){b.setAttribute('aria-pressed',on?'true':'false');
      b.querySelector('span').textContent=on?'Show figures':'Hide figures';
      b.querySelector('use').setAttribute('href',on?'#i-eye-off':'#i-eye');});}
  document.querySelectorAll('[data-privacy]').forEach(function(b){b.addEventListener('click',function(){var a=b.closest('.app');setPriv(a,!a.classList.contains('is-private'));});});
  document.addEventListener('keydown',function(e){if(e.shiftKey&&(e.key==='H'||e.key==='h')&&!/input|textarea|select/i.test(e.target.tagName)){var a=document.querySelector('.app[data-live]');if(a)setPriv(a,!a.classList.contains('is-private'));}});
  /* decisions: the button's verb is repeated by the toast and the done line */
  var toast=document.getElementById('toast'),tt;
  function say(msg,undo){if(!toast)return;toast.querySelector('[data-msg]').textContent=msg;toast.hidden=false;clearTimeout(tt);tt=setTimeout(function(){toast.hidden=true},5000);toast._undo=undo;}
  if(toast){toast.querySelector('[data-undo]').addEventListener('click',function(){if(toast._undo)toast._undo();toast.hidden=true;});}
  document.querySelectorAll('[data-done]').forEach(function(btn){btn.addEventListener('click',function(){
    var item=btn.closest('[data-dec]'),wgEl=btn.closest('.wg'),cnt=wgEl.querySelector('.wg-count');
    var line=item.querySelector('[data-doneline]');
    item.classList.add('is-resolved');line.querySelector('[data-what]').textContent=btn.getAttribute('data-done');
    var n=parseInt(cnt.textContent,10)-1;cnt.textContent=n;
    var all=wgEl.querySelector('[data-alldone]');if(n===0&&all){all.hidden=false;var mt=wgEl.querySelector('.wg-meta');if(mt){mt.dataset.was=mt.textContent;mt.textContent='All done';}}
    say(btn.getAttribute('data-done'),function(){item.classList.remove('is-resolved');cnt.textContent=parseInt(cnt.textContent,10)+1;if(all)all.hidden=true;});
    line.querySelector('[data-undo-line]').onclick=function(){item.classList.remove('is-resolved');cnt.textContent=parseInt(cnt.textContent,10)+1;if(all)all.hidden=true;};
  });});
  /* drill rows: Enter or click */
  document.querySelectorAll('tr[data-drill]').forEach(function(r){r.addEventListener('keydown',function(e){if(e.key==='Enter'){say('Opening '+r.getAttribute('data-drill'));}});r.addEventListener('click',function(e){if(!e.target.closest('a,button'))say('Opening '+r.getAttribute('data-drill'));});});
  /* seg buttons */
  document.querySelectorAll('.seg').forEach(function(g){g.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;g.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed','false')});b.setAttribute('aria-pressed','true');});});
  /* tabs */
  document.querySelectorAll('[role=tablist]').forEach(function(g){g.addEventListener('click',function(e){var b=e.target.closest('[role=tab]');if(!b)return;g.querySelectorAll('[role=tab]').forEach(function(x){x.setAttribute('aria-selected','false')});b.setAttribute('aria-selected','true');});});
})();
</script>"""

TOAST = ('<div class="toast-region" aria-live="polite"><div class="toast" id="toast" hidden><span class="toast-mark" aria-hidden="true"></span>'
         '<span data-msg>Approved</span><button class="btn btn--quiet" type="button" data-undo>Undo</button></div></div>')
