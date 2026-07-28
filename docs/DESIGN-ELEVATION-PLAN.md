# MeritBooks Design Elevation Plan

Ranked, specific upgrades to bring the top surfaces to the Stripe / Linear / Ramp bar. Each item names what falls short **today** and the concrete change — not "make it nicer." This is a human-in-the-loop backlog: the Builder executes with the screen open, the human judges the rendered result. Ordered by impact × how customer-facing the surface is.

Reference: `docs/DESIGN-SYSTEM.md`. Tokens (`text-display`, `text-danger-fg`, `bg-success/10`, `duration-fast`, `tracking-caps`, semantic colors) already exist in `tailwind.config.ts` — these changes are wiring screens to them, not inventing new tokens.

---

## 0. Cross-cutting: collapse the two design languages (do this first — highest impact)

**Short of the bar:** The app runs two parallel visual systems. The `ui/*` primitives are `slate`-based and on-standard, but the flagship screens (`invoices/invoice-manager.tsx`, and the create/payment dialogs, plus parts of bank-feed) re-implement tables, summary cards, badges, and modals inline with `gray-*` utilities and a **second, private `StatusBadge`**. Two languages in one app is the single loudest AI tell (§9) and the first thing a discerning eye catches.

**Concrete change:**
1. Replace every `gray-*` utility on app-shell screens with the `slate-*`/`surface-*` equivalent (`bg-gray-800/50` → `bg-surface-900` or `.card`; `border-gray-700/50` → `border-slate-800`; `text-gray-400` → `text-slate-400`). ~5 files use `gray-`; sweep them.
2. Delete the local `StatusBadge` in `invoice-manager.tsx` (lines ~277–288) and import `StatusBadge` from `components/ui` — extend its `variantMap` for `SENT` if needed.
3. Route the invoice summary cards, table, create form, and payment dialog through `MetricCard`, `DataTable` (or the standard table classes), and a shared `Modal`/`Drawer` primitive.

**Definition of done:** `grep -r "gray-" apps/web/src/app apps/web/src/components` returns only intentional non-UI matches; one `StatusBadge` exists.

---

## 1. Dashboard (`app/(app)/dashboard`) — the daily first impression

**Short of the bar:** Four `MetricCard`s of identical weight in a uniform grid = the generic "big number + label + gradient accent" template the skill warns against. Worse, the KPI values render in **Plus Jakarta Sans, not mono** — a §2 violation on the most-seen numbers in the product. There's no primary focal figure and no trend visualization; every tile competes equally.

**Concrete change:**
- Make `MetricCard` values `font-mono tabular-nums` (fix the primitive once, all callers benefit).
- Promote **one** card to a hero: give "Cash Position" (or the day's most decision-relevant KPI) `text-display` and a full-width or 2-col span; keep the other three at current size. Hierarchy replaces uniformity.
- Move the trend/`change` line into a colored pill: `bg-success/10 text-success-fg` for up, `bg-danger/10 text-danger-fg` for down, with the arrow inside the pill — not loose text beside an icon.
- Add a compact sparkline or last-30-day delta to the hero card so the number has motion of meaning, not just a static figure.

---

## 2. Invoices & AR (`app/(app)/invoices`) — flagship internal workflow

**Short of the bar:** Beyond the §0 language split: the list uses a **bare centered spinner** for loading (`Loader2 animate-spin`, §9 tell) and a **plain-text empty state** ("No invoices"), neither matching the `skeleton`/`empty-state` primitives. Summary cards restate `formatMoney` but with no hierarchy between "Overdue" (the number that should alarm) and "Draft" (background info). The overdue day-count is a tiny `text-[10px]` afterthought.

**Concrete change:**
- Loading → skeleton rows that mirror the table (reuse `Skeleton`); empty → `EmptyState` with icon + "Create your first invoice" + primary action.
- In the four summary cards, make **Overdue** the emphasized one — `text-display`, `text-danger-fg` when non-zero — and demote Draft to tertiary. Emerald/red carry the meaning; don't color all four.
- Elevate the overdue affordance: replace `text-[10px] {n}d late` with a `bg-danger/10 text-danger-fg` pill at `text-2xs`, aligned with the due date.
- The AIA/progress-bill marker should use the `ai`/`info` token consistently, not a one-off `indigo-500/20`.

---

## 3. Hosted pay page + Pay Now (`app/pay/[token]`) — the most customer-facing surface

**Short of the bar:** This is the one screen a *customer* (not a controller) sees, and it's strong overall — but it ships **emoji as icons** (🔒 in `pay-now.tsx`; ✓ ⏳ ⚠️ in `page.tsx`), the clearest AI tell on the most brand-critical surface. The Pay Now card and method selectors use a wholly separate inline `W` style object with eyeballed values (`fontSize: 13.5`, `padding: '12px 14px'`) that don't derive from any scale. The light-theme document is deliberate and fine; the ad-hoc metrics are not.

**Concrete change:**
- Replace all emoji with Lucide (`Lock`, `Check`, `Clock`, `AlertTriangle`) sized to the text. This one change most raises perceived quality per unit effort.
- Snap the `W`/`S` style objects to the 4px grid and the type scale (13.5→13/14, 12.5→12, 22→24) so the printed document reads as typeset, not hand-tuned.
- The method-selector cards: on select, use a 2px accent border + faint accent tint (already close) but standardize the selected/hover/disabled states so they feel like one control, and ensure the fee-acceptance state change animates at `duration-fast`.
- Confirm the balance-due hero is the `text-display` mono moment (§8) — it nearly is; lock it in.

---

## 4. Reports (`app/(app)/reports`) — where CFO trust is won or lost

**Short of the bar:** Financial statements are the surface a CFO scrutinizes hardest, so typographic precision is the whole game. Risk areas to verify against the system: number columns must be **mono, tabular, decimal-aligned** with consistent precision; totals/subtotals need a clear weight and rule hierarchy (hairline above subtotal, double/heavier rule above grand total); negative numbers follow one convention (parentheses *or* red, not both randomly). Period selection and drill-to-GL must be present and obvious (Rule 7).

**Concrete change:**
- Audit `report-viewer.tsx` and each report for mono tabular alignment; fix any sans figures.
- Establish the total hierarchy: line items `text-slate-300`, subtotal `text-white` with `border-t border-slate-800`, grand total `text-white font-semibold` with a heavier top border and slightly larger size — so the eye finds the bottom line instantly.
- Make the period selector a persistent, prominent control in the report header, and ensure every figure drills to its GL source (the `gl-drill-down` surface) with the standard clickable-row affordance.

---

## 5. Bank Feed (`app/(app)/bank-feed`) — the AI showcase

**Short of the bar:** This is the screen that proves the "AI-native" claim, so the AI signature elements (§8) must be pristine. Verify: confidence bars use the `ConfidenceBar` primitive with thresholds matching the auto-approve rule (≥85 emerald / ≥70 amber / below red); AI-touched rows are marked in the `ai` indigo token consistently; the sort defaults to lowest-confidence-first (needs-attention-first) per spec. Batch-approve, vendor-batch-select, and the edit slide-out must feel like one coherent surface, not assembled parts.

**Concrete change:**
- Ensure every AI decision carries the indigo `ai` token + a `ConfidenceBar`; no raw percentage text without the bar.
- The processing-metrics strip (processed X/Y, auto-approved count, avg confidence) should use one emphasized figure (`text-display` on the completion %) rather than three equal numbers.
- The edit slide-out should share the extracted `Drawer` primitive (§0/§6) so its entrance, focus-trap, and Esc-close match the invoice drawer exactly.
- Confirm keyboard shortcuts (j/k/a/f/Space/Esc) have a visible affordance (a `?` legend or inline hints) — power-user polish that reads as Linear-grade.

---

### Sequencing

Do **0 → 1 → 3** first: item 0 removes the loudest tell app-wide, item 1 fixes the mono-money violation in the primitive (cheap, high-visibility), and item 3 lifts the one customer-facing surface. Items 2, 4, 5 are per-screen depth passes to run with the page open and the human's eye on the result.
