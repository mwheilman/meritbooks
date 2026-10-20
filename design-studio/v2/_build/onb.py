"""Shared pieces for the onboarding & integrations boards (08-ONBOARDING-V2-SPEC, 07-INTEGRATIONS-PLAN).
Builds on common.py. Page-local CSS here is layout plus four onboarding marks that every O-screen shares:
  .src   source chip  — a connected system with its health pip (never colour alone: pip shape + word in title/legend)
  .prov  provenance   — "from QuickBooks · Oct 17" beside any prefilled or imported figure (spec P1, P13)
  .tier  how a system connects — Live API / Partner pending / Bridge (temporary) / File drop
  .stg   the migration's eight stages drawn with the slash meter (Plan … Live)
No new colours or fonts: everything resolves to system.css tokens."""
import common
from common import *

common.NAV = [("index.html", "Index"), ("O-control-tower.html", "Tower"), ("O-client-migration.html", "Client"),
              ("O-connect-source.html", "Connect"), ("O-preflight.html", "Preflight"), ("O-mapping.html", "Mapping"),
              ("O-tieout-certificate.html", "Tie-out & certificate"), ("O-buy-in.html", "Buy-in"),
              ("S18-integrations-hub.html", "S18 Hub")]

STAGES = ["Plan", "Connect", "Preflight", "Map", "Tie-out", "Shadow close", "Certified", "Live"]

ONB_CSS = """
/* ---- onboarding marks (shared by O-screens + S18) ---- */
.sheet-top nav a{padding:0 8px}
.src{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--line-2);background:var(--white);
  font:500 12px/16px var(--f-text);color:var(--ink);white-space:nowrap}
.src .pip{width:8px;height:8px}
.src small{font:inherit;color:var(--ink-3)}
.src--bridge{border-style:dashed}
.srcs{display:flex;gap:4px;flex-wrap:nowrap;min-width:0}
.prov{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--ink-3);white-space:nowrap}
.prov::before{content:"";width:6px;height:6px;background:var(--electric);transform:skewX(-45deg);flex:none}
.tier{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;font-weight:500}
.tier--live{color:var(--pos)} .tier--partner{color:var(--warn)} .tier--bridge,.tier--file{color:var(--ink-2)}
.stgw{display:flex;align-items:center;gap:8px;min-width:0}
.stgw .meter{padding:0 4px 0 6px}
.promise{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--sky);box-shadow:inset 3px 0 var(--electric);color:var(--ink)}
.promise b{font-weight:600}
.promise .ico{color:var(--electric)}
.steps{display:flex;border:1px solid var(--line);background:var(--white)}
.steps li{list-style:none;flex:1;display:flex;align-items:center;gap:10px;min-height:48px;padding:0 16px;border-right:1px solid var(--line);color:var(--ink-2)}
.steps li:last-child{border-right:0}
.steps .no{display:inline-grid;place-items:center;width:24px;height:24px;border:1.5px solid var(--grey-400);font:600 12px/1 var(--f-text);color:var(--ink-2);font-variant-numeric:tabular-nums}
.steps li.is-done{color:var(--ink)} .steps li.is-done .no{background:var(--electric);border-color:var(--electric);color:var(--white)}
.steps li[aria-current=step]{background:var(--sky);box-shadow:inset 0 -2px var(--electric);color:var(--ink);font-weight:600}
.steps li[aria-current=step] .no{border-color:var(--electric);color:var(--electric)}
.sec-h{display:flex;align-items:baseline;gap:12px;margin:32px 0 12px}
.sec-h h2,.sec-h h3{font:600 15px/24px var(--f-text);color:var(--ink)}
.sec-h .sp{flex:1}
.card{background:var(--white);border:1px solid var(--line)}
.card-h{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 8px 0 16px;border-bottom:1px solid var(--line)}
.card-h h3{font:600 15px/24px var(--f-text);color:var(--ink);white-space:nowrap}
.card-b{padding:16px}
.card-f{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 8px 0 16px;border-top:1px solid var(--line);color:var(--ink-3);font-size:12px}
.card-f .sp{flex:1}
.states{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;padding:24px 32px 32px}
.state{background:var(--white);border:1px solid var(--line);min-height:248px;display:flex;flex-direction:column}
.state .wg-state{flex:1}
.state-h{display:flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--canvas)}
.state-h .eyebrow{color:var(--ink-2)}
.who{display:flex;flex-direction:column;min-width:0}
.ctx .pip{flex:none}
.bar-l{display:block;height:12px;margin:10px 0;background:linear-gradient(90deg,var(--grey-100),var(--grey-200),var(--grey-100));background-size:200% 100%;animation:mb-shimmer 1.4s linear infinite}
.vsep{width:1px;align-self:stretch;background:var(--line)}
.dl-leader{display:flex;align-items:baseline;gap:8px;line-height:24px}
.dl-leader .dl{flex:1;border-bottom:1px dotted var(--grey-400);transform:translateY(-4px)}
.dl-leader .v{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}
"""

# ---------------------------------------------------------------- people (same cast as S1–S5)
PEOPLE = {"Jordan Smith": "JS", "Dana Lee": "DL", "Sam Kovac": "SK", "Priya Natarajan": "PN", "Luis Ortiz": "LO",
          "Rob Hartley": "RH"}

# ---------------------------------------------------------------- marks

HEALTH = {"ok": ("ready", "connected"), "stale": ("risk", "stale"), "err": ("overdue", "error"),
          "file": ("track", "waiting for file"), "arch": ("closed", "archived"), "plan": ("track", "planned"),
          "bridge": ("soft", "bridge")}


def src(name, health="ok", sub="", bridge=False):
    pk, word = HEALTH[health]
    s = f'<small>{sub}</small>' if sub else ""
    return (f'<span class="src{" src--bridge" if bridge else ""}" title="{E(name)}: {word}"><i class="pip pip--{pk}" aria-hidden="true"></i>'
            f'{name}{s}<span class="sr">, {word}</span></span>')


def prov(text):
    return f'<span class="prov">{text}</span>'


TIERS = {"live": ("ready", "Live API"), "partner": ("risk", "Partner pending"), "bridge": ("soft", "Bridge · temporary"),
         "file": ("track", "File drop"), "request": ("closed", "On request")}


def tier(kind, word=None):
    pk, w = TIERS[kind]
    return f'<span class="tier tier--{kind if kind in ("live","partner","bridge","file") else "file"}"><i class="pip pip--{pk}" aria-hidden="true"></i>{word or w}</span>'


def stage_meter(idx, bad=False, label=None):
    """idx: 0-based current stage. Done strokes before it, current outlined (or red if blocked)."""
    cells = ['<i class="on"></i>'] * idx + ['<i class="bad"></i>' if bad else '<i class="cur"></i>']
    if idx == 7:
        cells = ['<i class="on"></i>'] * 8
    cells += ["<i></i>"] * (8 - len(cells))
    lab = label or f"Stage {idx + 1} of 8, {STAGES[idx]}{', blocked' if bad else ''}"
    return f'<span class="meter" role="img" aria-label="{E(lab)}">{"".join(cells)}</span>'


def promise(system):
    return (f'<div class="promise">{ico("shield")}<span><b>MeritBooks will only read.</b> Nothing in {system} changes. '
            f'Read-only access, and you can disconnect at any time.</span></div>')


def avatar(name, small=False):
    st = ' style="width:24px;height:24px;font-size:11px"' if small else ""
    return f'<span class="avatar"{st} aria-hidden="true">{PEOPLE.get(name, "".join(p[0] for p in name.split()[:2]))}</span>'


# ---------------------------------------------------------------- rails

def rail_manager(current="Onboarding tracker"):
    g = [("Home", [("Home", current == "Home"), ("Inbox", False, 6)]),
         ("Clients", [("Client registry", False, 14), ("Onboarding tracker", current == "Onboarding tracker", 12)]),
         ("Work", [("Close grid", False), ("Review queue", False, 8), ("Requests", False, 11), ("Exceptions", False, 3)]),
         ("Team", [("Staff & capacity", False), ("Assignments", False), ("Access", False)]),
         ("Settings", [("Integrations", current == "Integrations", 5, True), ("Mapping sets", current == "Mapping sets"),
                       ("Approval workflows", False), ("AI autonomy", False)])]
    return rail(g, "Jordan Smith", "Accounting manager")


def rail_client(current="Migration", who="Dana Lee", role="Preparer"):
    g = [("Home", [("Client home", current == "Client home"), ("Migration", current == "Migration"),
                   ("Requests", current == "Requests", 2)]),
         ("Setup", [("Sources & feeds", current == "Sources & feeds"), ("Documents", current == "Documents", 14),
                    ("Chart of accounts", current == "Chart of accounts"), ("Departments & jobs", current == "Departments & jobs")]),
         ("Books · after go-live", [("To review", False), ("Bank feed", False), ("Reconciliation", False), ("Reports", current == "Reports")])]
    return rail(g, who, role)


def ctx_client(name, num, meta="Migrating", pip="soft"):
    return (f'<button class="ctx" type="button" aria-haspopup="dialog" aria-expanded="false"><i class="pip pip--{pip}" aria-hidden="true"></i>'
            f'<span class="ctx-name">{E(name)}</span><span class="ctx-meta tnum">{num} · {meta}</span>{ico("down")}<span class="kbd">⌘J</span></button>')


def frame(inner, cap_l, cap_r="1440 × variable · sample data", style=""):
    st = f' style="{style}"' if style else ""
    return f'<div class="frame"{st}>{inner}</div><div class="frame-cap"><span>{cap_l}</span><span>{cap_r}</span></div>'


def section_h(title, sub="", h="h2", style=""):
    st = f' style="{style}"' if style else ""
    return (f'<div class="pair-h" style="display:flex;align-items:baseline;gap:12px;margin-top:56px"{st}>'
            f'<{h} class="t-section" style="color:var(--ink)">{title}</{h}><span class="t-cap">{sub}</span></div>')


def state(eyebrow, mark, title, para, actions="", extra=""):
    marks = {"empty": '<span class="wg-empty-mark">' + ico("plus") + '</span>',
             "done": '<span class="wg-done-mark">' + ico("check") + '</span>',
             "err": '<span class="wg-empty-mark" style="border:1.5px solid var(--neg);color:var(--neg)">' + ico("alert") + '</span>',
             "none": ""}
    return (f'<div class="state"><div class="state-h"><span class="eyebrow">{eyebrow}</span></div>'
            f'<div class="wg-state">{marks[mark]}<p class="t-head">{title}</p><p>{para}</p>{extra}'
            f'{"<div class=" + chr(34) + "btn-row" + chr(34) + ">" + actions + "</div>" if actions else ""}</div></div>')


def page(title, extra_css, body, current, scripts=""):
    return (head(title, ONB_CSS + extra_css) + sheet_top(current) + f'<main class="sheet" id="main">{body}</main>'
            + TOAST + SCRIPT + scripts + "</body></html>")


EXTRA_SPRITE = """<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-upload" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 11V2.5M4.5 6 8 2.5 11.5 6"/><path d="M2.5 10.5v3h11v-3"/></symbol>
<symbol id="i-link" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.5 9.5l3-3"/><path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8"/></symbol>
<symbol id="i-retry" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3v3.5H9.5"/><path d="M12.6 6.5A5 5 0 1 0 13 9"/></symbol>
<symbol id="i-file" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.5h5.5L12.5 4.5V14.5H4Z"/><path d="M9.5 1.5v3h3"/></symbol>
<symbol id="i-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 8 14 2.5 10.5 14 8 9Z"/><path d="M8 9 14 2.5"/></symbol>
<symbol id="i-download" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2.5V11M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 10.5v3h11v-3"/></symbol>
<symbol id="i-sign" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 13.5h12"/><path d="M3.5 11 10.5 4l2 2-7 7H3.5Z"/></symbol>
<symbol id="i-swap" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5.5h10M10 2.5l3 3-3 3"/><path d="M13 10.5H3M6 7.5l-3 3 3 3"/></symbol>
<symbol id="i-merge" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2.5v3a3 3 0 0 0 3 3h5M4 13.5v-3a3 3 0 0 1 3-3"/><path d="M10 6l2.5 2.5L10 11"/></symbol>
</defs></svg>"""


def head(title, extra_css=""):  # override: add the onboarding icons to the sprite
    return common.head(title, extra_css) + EXTRA_SPRITE


def rail_mini(items, initials, current=0):
    links = "".join(f'<a class="rail-icon" href="#" aria-label="{E(lab)}"{" aria-current=" + chr(34) + "page" + chr(34) if i == current else ""}>{ico(icn)}</a>'
                    for i, (lab, icn) in enumerate(items))
    return ('<aside class="rail" aria-label="Primary"><div class="rail-logo"><img src="assets/merit-icon.png" alt="Merit" width="22" height="20"></div>'
            f'<nav class="rail-nav">{links}</nav><div class="rail-foot" style="padding:16px 0;display:grid;place-items:center"><span class="avatar">{initials}</span></div></aside>')


CLIENT_MINI = [("Client home", "grid"), ("Migration", "layers"), ("Requests", "ask"), ("Documents", "file"), ("Sources & feeds", "plug"), ("Reports", "book")]
