"""Shared shell for the vendor-compliance and workforce boards (V1, V2, W1, W2).
Builds on fo_common (S20-S27). Page-local <style> is layout plus each board's one
signature mark. FPBs: docs/FPB-vendor-compliance-chase.md, docs/FPB-workforce-app.md."""
from fo_common import *  # noqa: F401,F403
import fo_common as F
from html import escape as E

PAGES = [("V1-vendor-compliance.html", "V1 Vendor compliance"), ("V2-vendor-portal-mobile.html", "V2 Vendor portal"),
         ("W1-workforce-app-mobile.html", "W1 Workforce app"), ("W2-expense-policy-upload.html", "W2 Policy upload"),
         ("S21-employee-receipts.html", "S21 Receipts"), ("S22-receipt-chase.html", "S22 Chase")]

F.ICONS.update({
    "pin": '<path d="M8 14.5S3.5 10 3.5 6.5a4.5 4.5 0 0 1 9 0C12.5 10 8 14.5 8 14.5Z" stroke-linejoin="round"/><circle cx="8" cy="6.5" r="1.6"/>',
    "play": '<path d="M5 3.5v9l7-4.5Z" stroke-linejoin="round"/>',
    "stop": '<rect x="4" y="4" width="8" height="8"/>',
    "coffee": '<path d="M3 6h8v3.5A3.5 3.5 0 0 1 7.5 13h-1A3.5 3.5 0 0 1 3 9.5Z" stroke-linejoin="round"/><path d="M11 7h1.2a1.6 1.6 0 0 1 0 3.2H11"/><path d="M5.5 2.5v2M8.5 2.5v2"/>',
    "swap": '<path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5"/>',
    "sign": '<path d="M2 12.5c2-3 3-1 4.2-2.6S7 6 8.3 7.4 9.6 11 12 9.5"/><path d="M2 14.5h12"/>',
    "fingerprint": '<path d="M4.5 12.5c-.8-1.3-1-2.7-1-4.5a4.5 4.5 0 0 1 9 0"/><path d="M6.5 13.5c-.6-1.4-.8-3-.8-5.5a2.3 2.3 0 0 1 4.6 0c0 1.5 0 3-.4 4.5"/><path d="M8 8.2c0 2 0 3.8.6 5.3"/>',
    "forward": '<path d="M9 3.5 13.5 8 9 12.5"/><path d="M13.5 8H6a3.5 3.5 0 0 0-3.5 3.5v1"/>',
    "shield-x": '<path d="M8 1.8 13 3.6v4.1c0 3.1-2.1 5.4-5 6.5-2.9-1.1-5-3.4-5-6.5V3.6Z" stroke-linejoin="round"/><path d="M6 6.2l4 4M10 6.2l-4 4"/>',
})
SPRITE = F.sprite()


def head(title, css=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<title>{E(title)} · MeritBooks</title>
{F.CM.FONTS}
<link rel="stylesheet" href="system.css">
<!--BOARD--><style>{F.BOARD_CSS}{OWN_CSS}</style><!--/BOARD-->
<style>{css}</style></head>
<body>
<!--SPRITE-->{SPRITE}<!--/SPRITE-->
<a class="skip" href="#main">Skip to content</a>"""


def sheet_top(current):
    links = '<a href="index.html">Index</a>' + "".join(
        f'<a href="{h}"{" aria-current=page" if h == current else ""}>{E(t)}</a>' for h, t in PAGES)
    return (f'<header class="sheet-top on-dark"><img src="assets/merit-logo-on-dark.png" alt="Merit" width="80" height="24">'
            f'<span class="eyebrow" style="color:var(--slate)">MeritBooks<span class="sl">//</span>Compliance &amp; workforce</span>'
            f'<nav aria-label="Design system pages">{links}</nav></header>')


# The ownership chip: which system owns the data on a card. A structural device that
# encodes something true (FPB-workforce-app §1), shared by W1 and W2.
OWN_CSS = """
.own{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border:1px solid var(--line-2);background:var(--white);font-size:12px;line-height:16px;font-weight:500;color:var(--ink-2);white-space:nowrap}
.own i{display:block;width:3px;height:12px;transform:skewX(-30deg);background:var(--ink-2)}
.own--projects i{background:var(--electric)}
.own--books i{background:var(--midnight)}
.own--provider i{background:var(--white);box-shadow:inset 0 0 0 1px var(--ink-2)}
.own--core i{background:var(--grey-300)}
"""


def own(system, label=None):
    k = {"Projects": "projects", "Books": "books", "Core": "core"}.get(system, "provider")
    return f'<span class="own own--{k}"><i aria-hidden="true"></i>{E(label or system)}</span>'


def phone_grid_cell(no, title, cap, ph):
    return (f'<div><div class="phcap"><span class="no" aria-hidden="true">{no}</span><span><b>{title}</b>'
            f'<span class="t-cap">{cap}</span></span></div>{ph}</div>')


def board_h(code, ref, title, para, pg=""):
    return (f'<div class="board-h"><div><div class="eyebrow">{code}<span class="sl">//</span>{ref}</div>'
            f'<h1 class="t-title" style="margin-top:8px">{title}</h1><p>{para}</p></div>'
            f'<span class="pg"><span class="tag">Sample data</span>{pg}</span></div>')
