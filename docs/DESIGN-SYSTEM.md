# MeritBooks Design System

**Status: BINDING.** This is the single source of visual truth. It is the visual equivalent of an FPB — build every screen to it. Where a screen disagrees with this document, the screen is wrong. When you extend the system, extend this document in the same commit.

Companion docs: `CLAUDE.md` → "Design System (BINDING)" (the short brief this expands on) and `docs/DESIGN-ELEVATION-PLAN.md` (the ranked backlog of specific screen upgrades).

Tokens live in `apps/web/src/styles/globals.css` (`:root` CSS variables — the single source of color) and `apps/web/tailwind.config.ts` (maps Tailwind utilities onto those variables). Tenant identity lives in `apps/web/src/lib/brand/tenant-brand.ts`; the monogram/wordmark in `apps/web/src/components/brand/brand-mark.tsx`. Primitives live in `apps/web/src/components/ui/`.

---

## 0. Brand source & white-label rule

The default theme is the **Merit Management Group brand (February 2026 Style Guide; hex identical in the 2026 guide)**. Merit is the first tenant; MeritBooks is resold white-label. Therefore:

- **Nothing in a component names a tenant or a brand hex.** Identity (product name, monogram, optional logo file) comes from `getTenantBrand()`; color comes from CSS variables (`--brand-navy`, `--brand-accent`, `--bg`, `--canvas`, `--ink*`, …) consumed through Tailwind tokens.
- **To re-skin a tenant, change only the token layer:** supply a `TenantBrand` and render `brandCssVars(brand)` on `<html>` (already wired in `app/layout.tsx`); swap font families in `app/layout.tsx` (next/font). Status colors (success/danger/warning/info/AI) are system-owned and are *not* tenant-swappable — they carry accounting meaning.
- Favicon / app icon: `app/icon.svg` (a static file, so it uses literal hex — regenerate it per tenant). Static logo files in `public/brand/` mirror the component for non-React consumers.

---

## 1. Point of view

MeritBooks is the **book of record for a multi-entity holding company** — many operating companies, real cash, a real audit trail. The person on the other side of the screen is a controller or CFO who has to trust a number at a glance and drill to its source. The product reads as **an operator's ledger: confident, direct, quiet** — warm-white paper, navy ink, one blue accent. Dense where the data is, calm everywhere else.

Three commitments:

- **The number is the hero.** Figures in tables, ledgers, and forms are JetBrains Mono, tabular, right-aligned. Chrome recedes.
- **Restraint with the accent.** Electric Blue is ~5% of any screen: the primary action, links, the active nav item, focus, the selected row. If blue is everywhere it means nothing.
- **Density with air.** A strict 4px grid and clear hierarchy, so density reads as command, not clutter.

Voice (all UI copy): confident, direct, operator language. Never "synergy", "leverage" (as a verb/marketing word — the covenant ratio is fine), "best in class", "world-class", "revolutionize", or a standalone "solutions".

---

## 2. Typography

Three families, one job each — loaded with `next/font/google` in `app/layout.tsx` and exposed as CSS variables:

| Family | Variable / utility | Job |
|---|---|---|
| **Syne** (600/700) | `--font-display` · `font-display` | Page titles, section titles (`h1`–`h3` get it automatically), standalone big stats (KPI tiles, `MetricCard`). Headings 700. Never body or table text — it is wide. |
| **DM Sans** (400–700) | `--font-sans` · `font-sans` (default) | Body, nav, labels, buttons, table text. |
| **JetBrains Mono** (400–600) | `--font-mono` · `font-mono` | **Every figure, id, and code in tables/ledgers/forms**; eyebrows, section labels, column headers, tags (uppercase, tracked). |

**The money rule:** amounts, account numbers, invoice/JE numbers, dates in tables, percentages, confidence values are `font-mono tabular-nums`, right-aligned in tables. The one sanctioned exception is the **standalone KPI tile** (a single hero figure not in a column), which uses Syne 700 per the brand's "big stat numbers" rule.

**Eyebrows / section labels:** `.eyebrow` utility (JetBrains Mono, 11px, 500, uppercase, `letter-spacing: 0.16em` ≈ 1.8px, `text-ink-mid`). Column headers: `font-mono text-2xs font-medium uppercase tracking-eyebrow text-slate-500`. Tracking token: `tracking-eyebrow` (0.16em; brand range 1.5–2.5px).

### Type scale (named tokens — use these, not raw `text-2xl`)

| Token | Size | Weight / tracking | Use |
|---|---|---|---|
| `text-display` | 32px | 700 · -0.02em | The single hero figure on a screen. One per screen, max. |
| `text-title` | 24px | 700 · -0.015em | Page H1 (`PageHeader`, with `font-display`). |
| `text-heading` | 18px | 600 · -0.01em | Section / card header. |
| `text-subheading` | 16px | 600 | Dialog title, sub-section. |
| `text-body` | 14px | 400 | Default UI text and table cells. |
| `text-body-sm` | 13px | 400 | Dense secondary text, drawer metadata. |
| `text-label` | 12px | 500 | Form labels, inline metadata. |
| `text-caption` | 11px | 400 · +0.04em | Overlines. |
| `text-2xs` | 10px | — | Micro-labels, badge text. Sparingly. |

### Text color tiers (on the light canvas)

| Tier | Token (preferred) | Legacy class that resolves to it | Hex | On white |
|---|---|---|---|---|
| Primary — the number, headings | `text-ink-hi` | `text-slate-50/100`, (was `text-white`) | `#0A1628` Navy | 18.1:1 |
| Strong body / input text | `text-ink-strong` | `text-slate-200` | `#1B2A40` | 14.5:1 |
| Body | `text-ink` | `text-slate-300` | `#3D4F65` Steel | 8.4:1 |
| Secondary | `text-ink-soft` | `text-slate-400` | `#4B5C72` | 6.8:1 |
| Labels, column headers — **AA floor** | `text-ink-mid` | `text-slate-500` | `#55657A` | 6.0:1 (5.4 on canvas) |
| Captions / meta / placeholder only | `text-ink-dim` | `text-slate-600` | `#8494A7` Slate | 3.1:1 — never for content a user must read |
| Decorative (separators, disabled glyphs) | `text-ink-faint` | `text-slate-700` | `#B4BDC8` | 1.9:1 |

`text-white` is **only** for text on a solid fill (accent button, solid status pill, navy shell). On the canvas it is a bug.

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

---

## 4. Color

Light, warm, and disciplined. **Ratios: 60% Warm White + Canvas backgrounds · 25% Navy (shell, dark sections, headlines, text) · 10% Steel body text · 5% Electric Blue accent.**

### Merit brand palette (CSS variables in `globals.css :root`)

| Name (guide) | Hex | Variable | Tailwind | Role |
|---|---|---|---|---|
| Navy / Midnight | `#0A1628` | `--brand-navy`, `--ink-hi` | `bg-navy`, `bg-shell`, `text-ink-hi` | Shell (sidebar + top bar), dark sections, headlines, primary text |
| Electric Blue | `#2563EB` | `--brand-accent` | `brand-400/500`, `accent`, `em` | Primary buttons, links, active nav rail, focus rings, selection |
| Signal Blue | `#3B82F6` | `--brand-accent-bright` | `accent-bright`, `shell-accent` | Accent **on navy** (icons, active tint) — 4.9:1 on navy |
| (pressed) | `#1D4ED8` | `--brand-accent-strong` | `brand-300/600`, `accent-strong` | Button hover/pressed on light; accent text on blue tints |
| (deep) | `#1E40AF` | `--brand-accent-deep` | `brand-200/700` | Emphasized accent text |
| Blue Wash / Sky | `#EBF2FE` | `--brand-wash` | `brand-50`, `accent-wash`, `.tag` | Tags, badges, selection wash |
| Warm White | `#FDFCFA` | `--bg` | `bg-page` (body) | Page background |
| Surface / Canvas | `#F5F3EF` | `--canvas` | `bg-canvas`, `bg-surface-950`, `bg-slate-950` | Alt background: insets, wells, table heads |
| Body Text / Steel | `#3D4F65` | `--ink` | `text-ink`, `text-slate-300` | Body copy |
| Muted / Slate | `#8494A7` | `--ink-dim` | `text-ink-dim`, `text-slate-600` | Captions, metadata |

**Hover decision:** the guide gives Signal Blue as the hover. White text on `#3B82F6` is 3.7:1 (fails AA), so on light surfaces a filled button hovers **darker** (`#1D4ED8`, 6.7:1); Signal Blue is the hover/active accent on navy, where it passes.

### Surfaces & hairlines

| Token | Hex | Role |
|---|---|---|
| `bg-page` / `--bg` | `#FDFCFA` | Page (body) |
| `bg-surface-900` / `bg-slate-900` / `--surface` | `#FFFFFF` | Cards, panels, dialogs, menus |
| `bg-surface-850` / `--inset-soft` | `#FAF9F6` | Nested well inside a card |
| `bg-surface-950` / `bg-slate-950` / `--canvas` | `#F5F3EF` | Insets, inputs-in-wells, table heads, full-page wrappers |
| `bg-slate-800` / `--fill` | `#F1EEE8` | Control fill: secondary chips, tracks, kbd, segmented-control active |
| `bg-slate-700` / `--fill-strong` | `#E7E3DB` | Control hover fill |
| `border-slate-800` / `hairline` | `#E7E3DB` | Default card border / divider |
| `border-slate-700` / `hairline-strong` | `#D9D4CA` | Inputs, interactive borders |
| `border-slate-600` | `#B4BDC8` | Hover border |

Overlays that used to be white-on-dark (`bg-white/[0.03]`) are now **navy-on-light** (`bg-navy/[0.03]`). On the navy shell, `bg-white/[0.06]` is correct.

### App shell (navy chrome)

`bg-shell` (`#0A1628`) with `border-shell-line` (`#21314A`). Text: `text-shell-fg` (white, 18:1), `text-shell-mid` (`#A3B1C2`, 8.3:1) for nav labels, `text-shell-dim` (`#8494A7`, 5.9:1) for group eyebrows. Active nav = `bg-accent-bright/[0.16]` + white label + Signal Blue icon + a 3px Electric Blue rail. Dropdown menus that open *from* the shell are light (`bg-surface-900`). Use `.section-navy` + `.grid-mesh` for an occasional navy hero band (never behind dense data).

### Semantic roles (meaning, not decoration)

Status colors are kept from the previous system and **tuned for light backgrounds**: each palette's text shades (`text-*-100…600`) are remapped to an "fg" that clears **4.5:1 on white and on the palette's own 500@20% soft fill**; dark-tinted fills (`bg-*-800/900/950`) are flipped to light tints.

| Token | Fill / fg | Meaning |
|---|---|---|
| `success` / `emerald` | `#059669` / `#04714F` | Debit, posted, paid, healthy, balanced |
| `danger` / `red` | `#DC2626` / `#B91C1C` | Credit, overdue, error, destructive |
| `warning` / `amber` | `#D97706` / `#A14B08` | Needs review, soft-close, expiring |
| `info` / `blue` | `#3B82F6` / `#1D4ED8` | Neutral status, in-progress, sent |
| `ai` / `indigo` | `#6366F1` / `#4338CA` | AI-generated, suggested, auto-categorized |

**Emerald decision.** In the old theme emerald was *both* the brand accent and "success". Under Merit, emerald keeps only its **meaning** (success, debits, positive figures, healthy/balanced states, paid). Every *accent* use — primary buttons, links, focus rings/borders, checkbox accent, spinners, active tabs, selected rows/cards — was moved to `brand-*` (Electric Blue). Accounting convention is load-bearing: **debits / positive are green; credits / negative are red.** Do not invert for variety, and do not use green as a CTA color.

Usage: text `text-danger-fg`, soft fill `bg-danger/10`, dot/bar `bg-danger`. Prefer the role tokens in new code.

### How the re-skin works (for maintainers)

The app was authored dark (~6k `slate-*`/`surface-*`/`emerald-*` utilities). `tailwind.config.ts` remaps those palettes **per utility** — `textColor`, `backgroundColor`, `borderColor`, `divideColor`, `ringColor` each get the ramp that preserves the original *intent* on a light canvas (low numbers = emphatic text; high numbers = surfaces/hairlines). `gray`/`zinc`/`neutral`/`stone` share the slate ramps. New code should prefer the semantic names (`text-ink-*`, `bg-surface-*`, `border-hairline`, `bg-canvas`, `accent`, `shell-*`) over raw slate numbers.

---

## 5. Surface & elevation

**Depth comes from layering and hairlines, not drop shadows.** Page (warm white) → card (white, 1px `#E7E3DB`, 16px radius) → nested well (`surface-850`) / inset (`canvas`).

- `.card` = `bg-surface-900 border border-slate-800 rounded-brand-lg shadow-card` (`shadow-card` is a 1px navy-4% lift — the only resting shadow).
- Floating layers (menus, popovers, toasts, drawers) use `shadow-pop`.
- **Radii (Merit digital spec):** buttons/inputs **10px** (`rounded-lg` is remapped to 10px; `rounded-brand`), cards/dialogs/menus **16px** (`rounded-xl` remapped to 16px; `rounded-brand-lg`), large modals `rounded-2xl` 20px, pills `rounded-full`.

Group related content in **one** card with internal dividers (`divide-slate-800/50`), not five stacked cards.

---

## 6. Component patterns

Primitives live in `components/ui/`.

### Tables — the core surface (`ui/data-table.tsx`)
- Header row: `bg-canvas/60`, `font-mono text-2xs font-medium uppercase tracking-eyebrow text-slate-500`, `border-b border-slate-800`.
- Body rows: `divide-y divide-slate-800/50`; hover `.table-row-hover` (navy 2.5% wash on `<td>` for Safari). Clickable rows `.row-clickable` (blue 5% wash + 2px Electric Blue left rail + chevron on hover).
- **Money columns:** `text-right font-mono tabular-nums`; primary figure `text-ink-hi`, secondary `text-slate-400`; debits `text-emerald-400`, credits/negatives `text-red-400` (or `.fig-pos` / `.fig-neg`). Grand total `.ledger-total` (navy single rule above, double rule below).
- Empty cell: em dash `—` in `text-slate-500`, never blank.

### Metric cards (`ui/metric-card.tsx`)
Label `.eyebrow`; value Syne 700 ~28px, `text-ink-hi`, `tabular-nums` (the brand big-stat). Trend in semantic color.

### Badges & tags
`ui/status-badge.tsx` and `.badge-*`: soft fill `bg-{role}-500/10` + `text-{role}-400` (remapped to AA fg). `.tag` = Blue Wash fill, mono uppercase, `text-accent-strong` — for neutral categorization tags.

### Buttons (`globals.css`)
- `.btn-primary` — **Electric Blue fill, white text (5.2:1), 10px radius**, hover `#1D4ED8`. One per view.
- `.btn-secondary` — white, `border-slate-700`, `text-slate-200`; hover canvas fill.
- `.btn-ghost` — text-only, navy 4% hover. `.btn-danger` — red soft fill.
- Every button has a visible `focus-visible` ring in the accent.

### Inputs (`globals.css`)
`.input`: white, `border-slate-700` (`#D9D4CA`), 10px radius, `text-ink-hi`, placeholder `text-slate-600`; focus = Electric Blue border + 25% ring. Money inputs `font-mono text-right`. Error region `bg-danger/10 border-danger/30 text-danger-fg`.

### Toasts (`ui/toast.tsx`)
White, `shadow-pop`, 3px left rule in the status color.

### Drawers & dialogs
Overlay `bg-black/60`; panel `bg-surface-900 border-slate-800`, 16–20px radius, `shadow-pop`.

### Brand mark (`components/brand/brand-mark.tsx`)
`<BrandMonogram />` — original geometric "M" (two square-cut stems + centred V) in Signal Blue on a navy tile, with a single Electric Blue rule beneath (the underline under a total). `<BrandLockup tone="onDark" />` = monogram + white Syne wordmark (navy shell); `tone="onLight"` = navy wordmark (auth pages). If the tenant config supplies `logoSrc`, it replaces the generated monogram.

### States — every screen renders four
1. **Loading:** skeletons that mirror the layout (`ui/skeleton.tsx`), never a bare centered spinner.
2. **Empty:** `ui/empty-state.tsx` — icon, one-line title, a directive sentence, a primary action.
3. **Error:** inline, in the product's voice, stating what failed and the retry path.
4. **Populated:** real data from real Supabase queries.

### Confidence bar (`ui/confidence-bar.tsx`)
AI certainty as a thin bar + mono percentage: emerald ≥85 / amber ≥70 / red below — consistent with the auto-approve rule.

---

## 7. Iconography

Lucide, `size={16}` inline / `size={14}` in dense rows, stroke default. Icons are `text-slate-400` unless they carry a semantic color. **No emoji, anywhere in the app shell** — a 🔒 or ✓ in the UI is an instant AI tell (§9). The hosted invoice page currently uses emoji (🔒 ✓ ⏳ ⚠️); replace with Lucide (`Lock`, `Check`, `Clock`, `AlertTriangle`). Icons support text; they rarely stand alone without a label.

---

## 8. Signature elements

1. **The ledger row.** Mono tabular figures, green debits / red credits, warm hairline dividers, a blue left rail + drill chevron on hover. The table *is* the product.
2. **The navy frame.** A navy sidebar + top bar (the brand's 25%) around a warm-white work surface; the active nav item is the brightest blue on screen.
3. **The confidence bar + AI indigo.** Anything the machine decided is marked in indigo with a confidence bar.
4. **Balance-forward hero.** On money surfaces the outstanding figure is the first thing the eye lands on.

---

## 9. Anti-AI-tells — never ship these

- **Everything-in-a-card.** Group, don't scatter.
- **Centered marketing layouts** for a data tool.
- **Emoji as icons.** Use Lucide.
- **Gradient soup** — decorative gradients, glows. Blue is a signal, not a wash.
- **No hierarchy** — assign text tiers (§2) deliberately.
- **Blank empty states / spinner-only loading.**
- **Sans-serif money in a table.** Figures are mono tabular.
- **Raw hex or a tenant name in a component.** Use tokens and `getTenantBrand()`.
- **`text-white` on the light canvas**, or green as a CTA color.
- **Two design languages** — prefer the semantic tokens; don't hand-roll a second badge.
- **Eyeballed spacing** — snap to the 4px grid.
- **Rainbow accenting** — if it doesn't mean something, it's navy/steel.

---

## 10. Motion

Restrained and purposeful. Three speeds, named tokens (`tailwind.config.ts › transitionDuration`): `duration-fast` (120ms) for state feedback (hover, press, focus), `duration-base` (200ms) for entrances (drawer, toast, dialog), `duration-slow` (500ms) for data transitions (a confidence/progress bar filling). Standard easing is `ease-standard` (`cubic-bezier(0.2,0,0,1)` — quick out, settled in).

- Animate opacity and transform only; never animate layout (width/height/top) on interaction.
- Entrances use `animate-slide-up` / `animate-fade-in` (already defined). One orchestrated entrance beats scattered effects.
- **Respect `prefers-reduced-motion`:** motion is enhancement; the UI is fully usable and legible with all of it off. Nothing important is conveyed by animation alone.
- No looping/ambient animation in the app shell. A spinner is the only continuous motion, and only while genuinely fetching.

---

---

## 11. Accessibility floor (non-negotiable)

- Visible keyboard focus on every interactive element (global `:focus-visible` outline in the accent, plus the ring utilities in primitives).
- Semantic color is never the *only* signal — pair it with an icon, label, or position.
- **Contrast (WCAG AA ≥ 4.5:1 for body text), measured:** navy 18.1, steel body 8.4, `slate-400` 6.8, `slate-500` 6.0 on white / 5.4 on canvas; status fg on white ≥ 5.7 and on their own 500@20% tint ≥ 4.7 (emerald 4.99, red 4.99, amber 5.12, blue 5.32, indigo 6.11; all 17 status palettes verified); Electric Blue text on white 5.2; white on Electric Blue 5.2. Below the floor by design (meta/decorative only): `slate-600` 3.1, `slate-700` 1.9. Known near-misses: `text-brand-400` on `bg-brand-500/10` is 4.49 (use `text-brand-300`, 5.8 — the codebase was swept to do so).
- Hit targets ≥ 32px; icon-only buttons carry a `title`/`aria-label`.
- Tables are real `<table>` semantics; drawers trap focus and close on `Esc`.
