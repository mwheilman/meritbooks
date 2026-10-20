"""Shared shell for the finance-operations boards (S20-S27). Builds on
system.css v2 (incl. section 17) and common.py. Page-local <style> is layout
only: grid placement, widths, and the one signature mark each board owns."""
from html import escape as E
import common as CM
from common import f0, f2, status, meter, wg, ctxline, customize_btn, TOAST, SCRIPT, HP
from acc_common import ICONS as _ACC_ICONS

PAGES = [("S20-pay-runs.html", "S20 Pay runs"), ("S21-employee-receipts.html", "S21 Receipts"),
         ("S22-receipt-chase.html", "S22 Chase"), ("S23-fpna.html", "S23 FP&A"),
         ("S24-debt-lender.html", "S24 Debt"), ("S26-rev-rec.html", "S26 Rev rec"),
         ("S27-settings.html", "S27 Settings")]

ICONS = dict(_ACC_ICONS)
ICONS.update({
    "camera": '<path d="M2 5h3l1.2-2h3.6L11 5h3v8H2Z" stroke-linejoin="round"/><circle cx="8" cy="9" r="2.3"/>',
    "card": '<rect x="1.5" y="3.5" width="13" height="9"/><path d="M1.5 6.5h13M4 10h3"/>',
    "print": '<path d="M4.5 6V2.5h7V6"/><rect x="2" y="6" width="12" height="5.5"/><path d="M4.5 9.5h7v4h-7Z"/>',
    "bank": '<path d="M2 6 8 2.5 14 6Z" stroke-linejoin="round"/><path d="M3.5 6.5v5M6.5 6.5v5M9.5 6.5v5M12.5 6.5v5M2 13.5h12"/>',
    "bell": '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11Z" stroke-linejoin="round"/><path d="M6.5 14h3"/>',
    "upload": '<path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6"/><path d="M2.5 13.5h11"/>',
    "void": '<circle cx="8" cy="8" r="5.8"/><path d="M3.9 12.1 12.1 3.9"/>',
    "moon": '<path d="M12.5 10A5.5 5.5 0 0 1 6 3.5 5.5 5.5 0 1 0 12.5 10Z" stroke-linejoin="round"/>',
    "sms": '<path d="M2.5 3h11v8H7l-3 2.5V11H2.5Z" stroke-linejoin="round"/><path d="M5 7h.1M8 7h.1M11 7h.1" stroke-width="2"/>',
    "branch": '<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="6" r="1.5"/><path d="M4 5v6M12 7.5c0 2.5-3 3-8 3.5"/>',
    "inherit": '<path d="M3 2.5v6.5h9"/><path d="M9 6l3 3-3 3"/>',
    "image": '<rect x="2" y="2.5" width="12" height="11"/><path d="M2 11l3.5-3.5 3 3 2-2 3.5 3.5"/><circle cx="10.5" cy="5.5" r="1"/>',
    "list": '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.5 4h1M2.5 8h1M2.5 12h1"/>',
    "flag": '<path d="M3.5 14V2.5h8l-1.5 3 1.5 3h-8" stroke-linejoin="round"/>',
    "pause": '<path d="M6 3.5v9M10 3.5v9"/>',
    "sliders": '<path d="M2 5h12M2 11h12"/><rect x="9" y="3" width="2.5" height="4" fill="#fff"/><rect x="4.5" y="9" width="2.5" height="4" fill="#fff"/>',
    "repeat": '<path d="M2.5 6.5A4.5 4.5 0 0 1 12 5"/><path d="M12.5 2v3.2H9.3"/><path d="M13.5 9.5A4.5 4.5 0 0 1 4 11"/><path d="M3.5 14v-3.2h3.2"/>',
})


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


BOARD_CSS = CM.BOARD_CSS + """
.sheet-top .eyebrow{white-space:nowrap}
.board-h .pg{display:flex;align-items:center;gap:12px}
.pair-h{display:flex;align-items:baseline;gap:16px;margin-top:56px;padding-bottom:12px;border-bottom:1px solid var(--line-2)}
.pair-h .t-section{color:var(--ink);white-space:nowrap}
.pair-h p{color:var(--ink-2)}
.app--frame{min-height:0}
.app--frame .rail{min-height:0}
.bar .ctx{flex:none}
.page-head .t-title{white-space:nowrap}
.toast-region{bottom:32px}
.subtabs{display:flex;gap:24px;border-bottom:1px solid var(--line);padding:0 var(--margin);background:var(--warm)}
.ph-k{display:inline-flex;align-items:center;gap:8px}
.rail-link.more{color:var(--slate)}
.rail-link.more::after{content:"";margin-left:auto}
"""

RAIL_JS = """<script>
(function(){document.querySelectorAll('.rail-nav').forEach(function(n){var c=n.querySelector('[aria-current=page]');if(c){n.scrollTop=Math.max(0,c.offsetTop-n.clientHeight/2);}});
var t=document.getElementById('toast'),tm;document.querySelectorAll('[data-say]').forEach(function(b){b.addEventListener('click',function(){if(!t)return;t.querySelector('[data-msg]').textContent=b.getAttribute('data-say');t.hidden=false;clearTimeout(tm);tm=setTimeout(function(){t.hidden=true},4000);});});})();
</script>"""


def head(title, css=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<title>{E(title)} · MeritBooks</title>
{CM.FONTS}
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
            f'<span class="eyebrow" style="color:var(--slate)">MeritBooks<span class="sl">//</span>Finance operations</span>'
            f'<nav aria-label="Design system pages">{links}</nav></header>')


def board_h(code, ref, title, para, pg=""):
    return (f'<div class="board-h"><div><div class="eyebrow">{code}<span class="sl">//</span>{ref}</div>'
            f'<h1 class="t-title" style="margin-top:8px">{title}</h1><p>{para}</p></div>'
            f'<span class="pg"><span class="tag">Sample data</span>{pg}</span></div>')


def pair_h(title, para, hid=""):
    i = f' id="{hid}"' if hid else ""
    return f'<div class="pair-h"{i}><h2 class="t-section">{title}</h2><p>{para}</p></div>'


def frame(inner, cap_l, cap_r="", fid=""):
    i = f' id="{fid}"' if fid else ""
    return (f'<div class="frame"{i}>{inner}</div>'
            f'<div class="frame-cap"><span>{cap_l}</span><span>{cap_r}</span></div>')


anno = CM.anno


def foot():
    return "</main>" + TOAST + SCRIPT + RAIL_JS + "</body></html>"


# ------------------------------------------------------------------ shell
def rail(groups, user, role, foot_extra=""):
    """groups: [(name, [(label, current?, count?, alert?, more?)])]"""
    out = ['<aside class="rail" aria-label="Primary">',
           '<div class="rail-logo"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24"><span class="prod">BOOKS</span></div>',
           '<nav class="rail-nav">']
    for g, links in groups:
        if g:
            out.append(f'<div class="rail-group">{E(g)}</div>')
        for l in links:
            label = l[0]
            cur = len(l) > 1 and l[1]
            count = l[2] if len(l) > 2 and l[2] is not None else ""
            alert = len(l) > 3 and l[3]
            c = f'<span class="count{" count--alert" if alert else ""}">{count}</span>' if count != "" else ""
            more = label.startswith("More")
            cls = "rail-link more" if more else "rail-link"
            AC = ' aria-current="page"' if cur else ""
            out.append(f'<a class="{cls}" href="#"{AC}>{E(label)}{c}</a>')
    out.append("</nav>")
    initials = "".join(p[0] for p in user.split()[:2])
    out.append(f'<div class="rail-foot">{foot_extra}<div class="rail-user"><span class="avatar">{initials}</span><span>{E(user)}<small>{E(role)}</small></span></div></div></aside>')
    return "".join(out)


def ctx_client(name, num, period="Sep open", pip="open"):
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false"><i class="pip pip--{pip}" aria-hidden="true"></i>'
            f'<span class="ctx-name">{E(name)}</span><span class="ctx-meta tnum">{E(num)} · {E(period)}</span>{ico("down")}<span class="kbd">⌘J</span></button>')


def ctx_workspace(name="Merit Management Group", meta="Workspace"):
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false">{ico("grid")}<span class="ctx-name">{E(name)}</span>'
            f'<span class="ctx-meta">{E(meta)}</span>{ico("down")}<span class="kbd">⌘J</span></button>')


def bar(ctx_html, crumbs, cmd="Jump to client, report, bill…", sync="Synced 7:42 AM"):
    return (f'<header class="bar">{ctx_html}<span class="crumbs">{crumbs}</span>'
            f'<button class="cmdk" type="button">{ico("search")}<span>{E(cmd)}</span><kbd class="kbd">⌘K</kbd></button>'
            f'<span class="sync"><i aria-hidden="true"></i>{E(sync)}</span></header>')


def app(context, density, rail_html, bar_html, main_html, height, extra_cls="", live=False):
    xc = (" " + extra_cls) if extra_cls else ""
    lv = " data-live" if live else ""
    return (f'<div class="app app--frame {density}{xc}" data-context="{context}" style="height:{height}px"{lv}>'
            f'{rail_html}{bar_html}<div class="main">{main_html}</div></div>')


# Client nav per IA-SPEC 3.6.1, filtered by role (3.6.3) and activation (3.6.2).
CLIENT_TREE = [
    ("Home", ["Client home", "Inbox", "To review", "Requests", "Close"]),
    ("Banking", ["Bank & card transactions", "Reconciliation"]),
    ("Payables", ["Bills", "Purchase orders", "Pay runs & checks", "Expenses & receipts", "Payroll", "Vendors", "Vendor compliance"]),
    ("Receivables", ["Invoices", "Estimates", "Customer deposits", "Collections", "Cash application", "Customers"]),
    ("Revenue & jobs", ["Revenue recognition", "Jobs", "WIP", "Retainage", "Inventory"]),
    ("Cash & debt", ["Cash position & forecast", "Renewals & obligations", "Debt & covenants", "More · Subscriptions"]),
    ("Accounting", ["Journal entries", "Chart of accounts", "Assets & schedules", "Intercompany", "Tax", "Documents", "More · Equity"]),
    ("Planning & reports", ["Reports", "Board & lender packs", "Budgets", "FP&A & scenarios", "More · 2"]),
    ("Controls", ["Exceptions", "Approvals", "Compliance & SOX", "Audit trail", "AI decision log", "More · Agents"]),
]
ACTIVATED = {"Purchase orders", "Payroll", "Estimates", "Customer deposits", "Revenue recognition", "Jobs", "WIP",
             "Retainage", "Inventory", "Debt & covenants", "Intercompany"}


def client_nav(uses, current, counts=None, keep=None, settings=True):
    """uses: set of activated items this client uses. keep: optional role filter (set of labels)."""
    counts = counts or {}
    groups = []
    for g, items in CLIENT_TREE:
        links = []
        for it in items:
            if it in ACTIVATED and it not in uses:
                continue
            if keep is not None and it not in keep:
                continue
            c = counts.get(it)
            alert = isinstance(c, str) and c.startswith("!")
            cv = c[1:] if alert else c
            links.append((it, it == current, cv, alert))
        if links:
            groups.append((g, links))
    if settings:
        groups.append(("Client settings", [("Client settings", current == "Client settings")]))
    return groups


WORKSPACE_TREE = [
    ("Home", ["Home", "Inbox"]),
    ("Clients", ["Client registry", "Add clients", "Onboarding tracker"]),
    ("Work", ["Close grid", "Review queue", "Requests & chases", "Exceptions", "Agents & gates", "Practice tasks"]),
    ("Team", ["Staff & capacity", "Capacity assignments", "Access", "Access requests", "Access reviews"]),
    ("Consolidations", ["Groups", "Merit Management Group — Consolidated"]),
    ("Insights", ["Books health", "Cash across clients", "Compare clients", "Profitability by client", "Team performance", "Client economics"]),
    ("Integrations", ["Integrations hub"]),
    ("Settings", ["Settings"]),
]


def workspace_nav(current, keep=None, counts=None, extra=None):
    counts = counts or {}
    groups = []
    for g, items in WORKSPACE_TREE:
        links = [(it, it == current, counts.get(it)) for it in items if keep is None or it in keep]
        if extra and g in extra:
            links += [(it, it == current, counts.get(it)) for it in extra[g]]
        if links:
            groups.append((g, links))
    return groups


def btn(label, kind="", key="", icon="", attrs=""):
    k = f'<span class="kbd">{key}</span>' if key else ""
    i = ico(icon) if icon else ""
    cls = "btn" + (f" btn--{kind}" if kind else "")
    return f'<button class="{cls}" type="button"{(" " + attrs) if attrs else ""}>{i}{label}{k}</button>'


def money(x, dec=2, paren_neg=True):
    return f2(x) if dec else f0(x)


def n(x, dec=2):
    """table cell figure with hanging paren on positives"""
    s = f2(x) if dec else f0(x)
    return s + (HP if x >= 0 else "")
