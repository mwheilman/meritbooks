# MeritBooks Design System

**Status: BINDING.** This is the single source of visual truth. It is the visual equivalent of an FPB — build every screen to it. Where a screen disagrees with this document, the screen is wrong. When you extend the system, extend this document in the same commit.

Companion docs: `CLAUDE.md` → "Design System (BINDING)" (the short brief this expands on) and `docs/DESIGN-ELEVATION-PLAN.md` (the ranked backlog of specific screen upgrades).

Tokens live in `apps/web/tailwind.config.ts` and `apps/web/src/styles/globals.css`. Primitives live in `apps/web/src/components/ui/`.

---

## 1. Point of view

MeritBooks is the **book of record for a private-equity holding company** — 17 operating companies, real cash, a real audit trail. The person on the other side of the screen is a controller or CFO who has to trust a number at a glance and be able to drill to its source. So the product feels like **a terminal for private capital: dense, quiet, and authoritative** — closer to a Bloomberg terminal's seriousness than a consumer app's whitespace, but never cramped and never cold.

Three commitments follow from that:

- **The number is the hero.** Money and identifiers are the content; chrome recedes. Figures are monospaced, tabular, and right-aligned so columns read like a ledger, not a webpage.
- **Calm over cheerful.** Color is scarce and meaningful. A screen is mostly graphite and slate; emerald appears for the one thing that matters. Nothing pulses, bounces, or celebrates.
- **Density with air.** We show a lot at once — but on a strict spacing grid with clear hierarchy, so density reads as command, not clutter.

If a screen could be mistaken for a generic SaaS starter or an AI mock, it has failed this POV. The tells are catalogued in §9.

---

## 2. Typography

Two families, one job each. **Plus Jakarta Sans** for everything human-readable; **JetBrains Mono** for everything countable.

**The rule that matters most: money and identifiers are ALWAYS JetBrains Mono, `tabular-nums`, and right-aligned in tables.** Amounts, account numbers, invoice numbers, journal IDs, dates in tables, percentages, confidence values — all mono. A dollar figure set in the sans face is a bug.

### Type scale (named tokens — use these, not raw `text-2xl`)

Defined in `tailwind.config.ts › fontSize`. Each token carries its own line-height, tracking, and default weight.

| Token | Size | Weight / tracking | Use |
|---|---|---|---|
| `text-display` | 32px | 700 · -0.02em | The single hero figure on a screen — the primary KPI, the balance due. One per screen, max. |
| `text-title` | 24px | 600 · -0.015em | Page H1 (`PageHeader`). |
| `text-heading` | 18px | 600 · -0.01em | Section / card header. |
| `text-subheading` | 16px | 600 | Dialog title, sub-section. |
| `text-body` | 14px | 400 | Default UI text and table cells. |
| `text-body-sm` | 13px | 400 | Dense secondary text, drawer metadata. |
| `text-label` | 12px | 500 | Form labels, inline metadata. |
| `text-caption` | 11px | 400 · +0.04em | Overlines. Pair with `uppercase tracking-caps` for column headers and eyebrows. |
| `text-2xs` | 10px | — | Micro-labels, badge text. Use sparingly. |

Weights in use: 400 body, 500 labels/emphasis, 600 headings, 700 hero figures. **Never 800** in the app shell (the hosted invoice/PDF surface is the one exception — a printed document may go heavier). No italics except genuine citation.

Text color tiers (dark surfaces):
- **Primary** — `text-white`: the number, the row's subject, headings.
- **Secondary** — `text-slate-300`: supporting values, active labels.
- **Tertiary** — `text-slate-400`: descriptions, inactive metadata.
- **Quaternary** — `text-slate-500`: column headers, placeholders, timestamps.

Four tiers, no more. If everything is `slate-400`, nothing has hierarchy — assign each piece of text a tier deliberately.

---

## 3. Spacing

**Base unit: 4px.** This is Tailwind's default scale, and it is the law here — every margin, padding, and gap is a multiple of 4 (`1`=4, `2`=8, `3`=12, `4`=16, `6`=24, `8`=32). Never eyeball a `13px` gap or a `margin-top: 22px`; snap to the grid.

Standing rhythm:
- **Page gutter:** `p-6` (24px) around a page body.
- **Card padding:** `p-5` (20px) for metric cards, `p-6` for content cards and dialogs.
- **Section separation:** `mb-6` (24px) between a header and its content, between stacked sections.
- **Table cell:** `px-4 py-3`. Dense tables may use `py-2.5`; never below `py-2`.
- **Related controls:** `gap-2` (8px). Distinct control groups: `gap-3`/`gap-4`.
- **Label → field:** `mb-1` (4px). Field → next field: `space-y-4`.

Inline (`style={{ padding: 13 }}`) values are only acceptable on the hosted invoice / PDF surface, which is a self-contained printed document with its own metrics. Everywhere inside the app shell, use Tailwind spacing utilities.

---

## 4. Color

Dark-dominant. The canvas is graphite; color is a scarce signal.

### Surfaces (depth by layering, see §5)

| Token | Hex | Role |
|---|---|---|
| `surface-950` | `#020617` | App background (`body`). The floor. |
| `surface-900` | `#0f172a` | Cards, panels — the default raised surface (`.card`). |
| `surface-850` | `#172033` | Nested surface inside a card (a sub-panel, a selected row shade). |
| `surface-800` | `#1e293b` | Inputs, secondary buttons, hover fills. |

Borders: `border-slate-800` (default hairline), `border-slate-700` (interactive / hovered). These do more structural work than any shadow.

### Accent — emerald, used once per screen

`brand-500 #10b981` is the product's one accent. **Spend it on the single most important action or value on a screen** — the primary button, the active tab, the KPI that matters, a debit. Text tint on dark is `brand-400 #34d399`. When emerald is everywhere it stops meaning anything; discipline here is most of what separates this from a template.

### Semantic roles (named tokens — meaning, not decoration)

Defined in `tailwind.config.ts › colors`. Each is `DEFAULT` (solid/on-color) + `fg` (bright on-dark text). Soft fills use the alpha modifier.

| Token | Hex | Meaning |
|---|---|---|
| `success` | `#10b981` / fg `#34d399` | Debit, posted, paid, healthy. |
| `danger` | `#ef4444` / fg `#f87171` | Credit, overdue, error, destructive. |
| `warning` | `#f59e0b` / fg `#fbbf24` | Needs review, soft-close, expiring. |
| `info` | `#3b82f6` / fg `#60a5fa` | Neutral status, in-progress, sent. |
| `ai` | `#6366f1` / fg `#818cf8` | AI-generated, suggested, auto-categorized. Indigo signals "the machine did this." |

Usage: text `text-danger-fg`, soft fill `bg-danger/10`, dot/bar `bg-danger`. Prefer these over raw `text-red-400` so intent is legible in the markup and a future palette change is one edit. Accounting convention is load-bearing: **debits and positive/healthy states are emerald; credits and negatives are red.** Do not invert for visual variety.

---

## 5. Surface & elevation

**Depth comes from layering, borders, and contrast — not drop shadows.** The stack is `surface-950` floor → `surface-900` card → `surface-850` nested → `surface-800` control, each step separated by a `slate-800` hairline. That's the whole elevation model.

- The `.card` primitive (`bg-surface-900 border border-slate-800 rounded-xl`) is the standard raised container. `.card-hover` adds a `slate-700` border on hover — border, not shadow.
- Drop shadows are reserved for genuinely floating layers (drawers, popovers, toasts) and even there stay soft and dark. The emerald `glow` shadows exist for rare deliberate emphasis (a live/primary state) — not general decoration.
- Radii: `rounded-lg` (8px) controls and inputs, `rounded-xl` (12px) cards and dialogs, `rounded-full` pills/dots. Keep it consistent; don't mix `rounded` and `rounded-md` within one component.

Avoid the "everything floating in its own rounded card" look (§9). Group related content in **one** card with internal dividers (`divide-slate-800/50`), not five stacked cards.

---

## 6. Component patterns

Primitives live in `components/ui/`. Two grades below: **on-standard** (use as-is) and **needs elevation** (upgrade per the plan). The largest single inconsistency in the app today is that flagship screens (invoices, bank-feed) re-implement tables, badges, and cards inline with `gray-*` utilities instead of using these `slate-*` primitives — closing that gap is the top elevation move.

### Tables — the core surface (`ui/data-table.tsx`, on-standard)
Tables are where this product lives; treat them as the hero, not a fallback.
- Header row: `text-caption uppercase tracking-caps text-slate-500`, `border-b border-slate-800`.
- Body rows: `divide-y divide-slate-800/50`, hover via `.table-row-hover` (targets `<td>` for Safari). Clickable rows use `.row-clickable` (emerald left-accent + chevron on hover) — a strong, discoverable affordance already built; reuse it.
- **Money columns:** `text-right font-mono tabular-nums`, primary figure `text-white`, secondary (paid, prior) `text-slate-400`. Align the decimal by keeping consistent precision.
- Empty cell: em dash `—` in `text-slate-500`, never blank.
- Zebra striping is unnecessary and adds noise; the hairline divider is enough.

### Metric cards (`ui/metric-card.tsx`, NEEDS ELEVATION)
The KPI number must be **mono + tabular** (`font-mono tabular-nums`), which it currently is not — a money figure in the sans face violates §2. Give the one primary KPI on a screen `text-display`; keep peers at their current size so hierarchy exists rather than four identical tiles. The trend delta belongs in a colored pill (`bg-success/10 text-success-fg`), not loose text.

### Badges (`ui/status-badge.tsx`, on-standard)
Soft-fill pill: `bg-{role}/10 text-{role}-fg`, `text-2xs font-medium`, optional leading dot. The `variantMap` is the canonical status→color mapping — extend it there, never hand-roll a second badge component per screen (invoices currently does; delete that duplicate and use `StatusBadge`).

### Buttons (globals.css, on-standard)
- `.btn-primary` (emerald) — one per view, the main action. Reserve emerald for it.
- `.btn-secondary` (slate) — everything else.
- `.btn-ghost` — tertiary / icon actions in toolbars and rows.
- `.btn-danger` — destructive, and destructive actions always confirm.
- Sizes `.btn-sm` / `.btn-lg`. Every button has a visible `focus:ring`; don't strip it.

### Inputs (globals.css, on-standard)
`.input` / `.input-error`. Label above field (`text-label text-slate-400 mb-1`). Focus is emerald ring + border. Selects get a chevron affordance. Money inputs are `font-mono text-right`. Every form validates before submit and shows a single error region (`bg-danger/10 border-danger/30 text-danger-fg`).

### Drawers & dialogs (NEEDS ELEVATION → shared primitive)
Detail drawers slide from the right (`animate-slide-up`/fade), overlay `bg-black/60`, panel `bg-surface-900 border-l border-slate-800`. Dialogs center with the same panel treatment. These are re-implemented per screen today with divergent `gray-*` values — extract a shared `Drawer`/`Modal` primitive so header/footer/scroll behavior and escape-to-close are identical everywhere.

### States — every screen renders four
1. **Loading:** skeletons that mirror the real layout (`ui/skeleton.tsx`, `MetricCardSkeleton`), **never a bare centered spinner.** A spinner alone is a §9 tell; invoices uses one today and should move to skeleton rows.
2. **Empty:** `ui/empty-state.tsx` — icon, one-line title, a sentence of direction, and a primary action. An empty screen is an invitation to act, not a dead end. Copy is directive ("Create your first invoice"), never a shrug ("No data").
3. **Error:** inline, in the product's voice, stating what failed and the retry path — not a raw exception string.
4. **Populated:** the real thing, from real Supabase queries.

### Confidence bar (`ui/confidence-bar.tsx`, on-standard)
AI certainty as a thin bar + mono percentage, thresholded emerald ≥85 / amber ≥70 / red below. This is a signature element (§8) — keep its thresholds consistent with the auto-approve business rule.

---

## 7. Iconography

Lucide, `size={16}` inline / `size={14}` in dense rows, stroke default. Icons are `text-slate-400` unless they carry a semantic color. **No emoji, anywhere in the app shell** — a 🔒 or ✓ in the UI is an instant AI tell (§9). The hosted invoice page currently uses emoji (🔒 ✓ ⏳ ⚠️); replace with Lucide (`Lock`, `Check`, `Clock`, `AlertTriangle`). Icons support text; they rarely stand alone without a label.

---

## 8. Signature elements

The things a controller should remember MeritBooks by — protect these, don't dilute them:

1. **The ledger row.** Mono tabular figures, emerald debits / red credits, hairline dividers, a hover state that reveals a drill-to-source chevron. The table *is* the product.
2. **The confidence bar + AI indigo.** Anything the machine decided is marked in indigo with a confidence bar; the human always sees how sure the AI was before approving.
3. **Balance-forward hero.** On money surfaces (invoice, pay page, account), the outstanding figure is set in `text-display` mono — the first thing the eye lands on.

Spend boldness here and keep everything around them quiet.

---

## 9. Anti-AI-tells — never ship these

A running checklist. If a screen does any of these, fix it before calling it done:

- **Everything-in-a-card:** five floating rounded cards where one card with dividers belongs. Group, don't scatter.
- **Centered marketing layouts** for what is a data tool. Content is left-aligned and dense; hero-centered columns are for the landing page, not the ledger.
- **Emoji as icons** (🔒 ✓ 📊). Use Lucide.
- **Gradient soup** — decorative gradients, glows on everything, neon. Emerald is a signal, not a wash.
- **No hierarchy** — every text at `slate-400`, every card identical weight. Assign tiers (§2) and give one element the `text-display` moment.
- **Blank empty states** ("No data to display" and nothing else). Always icon + direction + action.
- **Spinner-only loading.** Skeletons that mirror the layout.
- **Sans-serif money.** Figures are mono tabular, always.
- **Two design languages in one app** — `gray-*` here, `slate-*` there; a bespoke badge on one screen and the primitive on another. Consolidate on the primitives and the `slate` palette.
- **Eyeballed spacing** (`mt-[13px]`). Snap to the 4px grid.
- **Rainbow accenting** — using emerald, blue, indigo, amber decoratively. Semantic colors carry meaning; if it doesn't mean something, it's slate.

---

## 10. Motion

Restrained and purposeful. Three speeds, named tokens (`tailwind.config.ts › transitionDuration`): `duration-fast` (120ms) for state feedback (hover, press, focus), `duration-base` (200ms) for entrances (drawer, toast, dialog), `duration-slow` (500ms) for data transitions (a confidence/progress bar filling). Standard easing is `ease-standard` (`cubic-bezier(0.2,0,0,1)` — quick out, settled in).

- Animate opacity and transform only; never animate layout (width/height/top) on interaction.
- Entrances use `animate-slide-up` / `animate-fade-in` (already defined). One orchestrated entrance beats scattered effects.
- **Respect `prefers-reduced-motion`:** motion is enhancement; the UI is fully usable and legible with all of it off. Nothing important is conveyed by animation alone.
- No looping/ambient animation in the app shell. A spinner is the only continuous motion, and only while genuinely fetching.

---

## 11. Accessibility floor (non-negotiable)

- Visible keyboard focus on every interactive element (`focus:ring`, already in the button/input primitives — don't remove it).
- Semantic color is never the *only* signal — pair it with an icon, label, or position (a red badge also says "Overdue").
- Text contrast meets WCAG AA on `surface-900`/`surface-950`; that's why tertiary text bottoms out at `slate-500`, not lower.
- Hit targets ≥ 32px; icon-only buttons carry a `title`/`aria-label`.
- Tables are real `<table>` semantics; drawers trap focus and close on `Esc`.
