# MeritBooks — Design Studio Brief (round 1)

## The client's verdict so far
Two prior attempts were rejected: "doesn't follow Merit brand style guidelines in any way, shape or form"
and "can't look like what basic AI would do." The bar is: indistinguishable from work by the best product
design studios in the market (the teams behind Linear, Stripe Dashboard, Mercury, Ramp, Vercel, Arc, Attio,
Rillet). If a screen could be mistaken for a generic AI-generated SaaS dashboard, it fails.

## The product
MeritBooks is an AI-native accounting **book of record** (it owns the general ledger) for holding companies
that run many operating businesses. Tenant #1: **Merit Management Group** (Johnston, Iowa), ~15 entities:
Heritage Interiors, Clive Power Equipment, Heartland Heating & Cooling, Crystal Kitchen & Bath, Dorrian HVAC,
Metro Heating & Cooling, Swan Creek, Iowa Custom Cabinets, Revived Interiors, Artistry Homes, AIM, Wild Rose,
plus funds (Merit Fund III, Handbuilt Capital) and SPEs. Trades businesses: HVAC, cabinets, kitchen & bath,
homebuilding, power equipment. Money is real: bank covenants (DSCR), lines of credit, WIP schedules, lenders.

Core loop: bank/card transactions (Plaid + Ramp) arrive -> AI codes them to accounts/entities/jobs with a
confidence score -> a person approves (keyboard-fast) -> the engine posts double-entry -> month-end close per
entity -> consolidated financials, covenant tests, board/lender packs. AI proposes, a human approves, the
engine posts. Nothing posts without approval.

Users: Mike (owner/partner — wants the whole portfolio in 10 seconds), the controller (runs close across
15 entities), bookkeepers (code 300+ transactions a day; keyboard, density, speed).

## Brand — NON-NEGOTIABLE (Merit Brand Guidelines 2026; pages in design-studio/assets/guide-01..20.png —
## LOOK AT THEM before designing; contact sheet: assets/brand-guide-pages.png)
- Logo: use the real files only — assets/merit-logo-on-dark.png (white "Merit" + blue M, for navy),
  assets/merit-logo-on-light.png, assets/merit-icon.png. Never redraw, recolor, stretch, or add effects.
  Clear space = monogram height. Min 24px tall.
- Color (exact hex): Electric Blue #2563EB (MAIN color: logo, headlines/titles, buttons, hover, strokes/rules),
  Midnight #0A1628 (body copy, logo wordmark, full-bleed dark sections), Signal Blue #3B82F6 (accent on dark,
  hover), Warm White #FDFCFA, Steel #3D4F65, Slate #8494A7, Canvas #F5F3EF, Sky #EBF2FE. The guide's
  "Usage" page shows tint ramps of blue, of steel/grey, and of midnight — use ramps derived from these hues only.
  Functional status colors (positive/negative/warning) are allowed but must be tuned to sit inside this palette.
- Type: **Syne** (primary/display — titles, big numerals; Bold) and **DM Sans** (secondary — everything
  else; 400/500/600/700). Only these two. Load from Google Fonts. Figures use DM Sans `font-variant-numeric:
  tabular-nums` (no monospace font).
- The guide's visual language: big Syne headlines in Electric Blue on white; full-bleed Midnight section
  pages with huge white Syne; outlined (stroked) Syne numerals; thin Electric Blue horizontal rules; small
  tracked all-caps labels in the "02 // THE LOGO" pattern; page numbers; generous whitespace; flat color
  blocks; sharp, square geometry. Voice: confident, direct, operator language — no "synergy, leverage,
  best in class, world-class, revolutionize, solutions".

## What "world class" means here (checklist — the critic will grade against this)
1. A distinctive, ownable concept — not a template. One signature idea executed with precision.
2. Typographic craft: a deliberate scale (<=5 sizes per screen), tight optical alignment, real hierarchy,
   Syne used with restraint where it has impact, DM Sans doing the work.
3. Data craft: right-aligned tabular figures, negatives in parentheses for accounting, consistent decimal
   precision, units, sparklines/bars only where they carry information, realistic numbers that tie
   (totals = sum of rows), dates in a consistent format.
4. Density appropriate to the user: bookkeeper screens are dense and keyboard-first (shortcut hints, focus
   states, row selection, bulk actions); owner screens are calm and scannable.
5. Interaction design visible in the static mock: hover, selected, focus-visible, keyboard hint chips,
   an open detail panel or popover, an AI suggestion with its reasoning and confidence, an empty or done state.
6. Layout grid: a real 8-pt spacing system and column grid; nothing floats; consistent gutters.
7. NO AI-default tells: no gradient blobs, glassmorphism, emoji, rainbow charts, generic "card grid of 4 KPIs
   with icon + number + green delta", no lorem ipsum, no 3 identical feature cards, no random rounded pills
   everywhere, no centered hero on an app screen, no stock icons as decoration.
8. Accessibility: WCAG AA contrast, visible focus, hit targets >= 32px.
9. Motion (light): purposeful CSS transitions on hover/selection; respect prefers-reduced-motion.

## Deliverable per designer
Three static, high-fidelity HTML screens at 1512px wide desktop (self-contained HTML + CSS, inline SVG for any
icons — no icon fonts, no external JS libraries), realistic Merit content:
1. `portfolio.html` — owner's home across all entities (cash, receivables/payables, covenant headroom, close
   progress per entity, what needs attention, AI-surfaced insight with evidence).
2. `bank-feed.html` — the bookkeeper's review queue: AI-coded transactions with confidence, entity, account,
   job, match status (matched to bill/receipt/unmatched), bulk select ">=90% confident", vendor batch,
   keyboard shortcuts (j/k/a/f/e), an open edit/detail panel with AI reasoning and vendor history.
3. `statement.html` — consolidated income statement (October 2026, with prior month, budget, variance),
   entity column toggles or a drill-down into one line, plus the AI variance commentary.
Plus `index.html` linking the three with a one-paragraph rationale of your concept and your signature idea.
Files go in /Users/mike/Projects/meritbooks/design-studio/<letter>/ with assets copied in (relative paths).
