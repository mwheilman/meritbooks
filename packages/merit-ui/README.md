# @meritbooks/merit-ui

The Merit Suite design system — **Style Guide v2.3** — as a shared package for Next.js 14, React 18,
TypeScript (strict) and Tailwind 3.4. Merit Projects (`apps/projects`) is the first, strict consumer;
Merit Books adopts it at its port.

- **Values:** `styles/system.css` is the kit's `reference/system.css`, **verbatim** (sha256 pinned in
  `KIT_VERSION`, enforced by `test/tokens.test.ts`). If anything here and `system.css` disagree, `system.css` wins.
  Never hand-edit it; re-copy it from the kit and update the hash.
- **Components use the kit's class names** (`.btn`, `.rail-link`, `.tbl-q`, `.wg`, `.note` …). They are thin,
  typed, accessible React wrappers — not a re-styling in Tailwind utilities.
- Shipped as TypeScript source (like `@meritbooks/shared`); the app compiles it via `transpilePackages`.

Binding source: `Merit-Suite-Style-Kit/MERIT-SUITE-STYLE-GUIDE.md` (v2.3), `reference/system.css`,
`reference/components.html`, the `S*`/`O-*` boards, `logos/lockups/`.

---

## Wiring an app (Merit Projects)

### 1. Dependency, transpile, brand files

```jsonc
// apps/projects/package.json
"dependencies": { "@meritbooks/merit-ui": "*" }   // then `npm install` at the root to link the workspace
```

```js
// apps/projects/next.config.js
transpilePackages: ['@meritbooks/merit-ui', '@meritbooks/shared', '@meritbooks/core-ai'],
```

```bash
# copies merit-projects-*.svg (all forms × variants), merit-icon-*.svg and merit-icon.png
# into apps/projects/public/brand/ — byte-for-byte kit files, never re-typeset
node packages/merit-ui/scripts/sync-brand.mjs apps/projects
node packages/merit-ui/scripts/sync-brand.mjs apps/projects --module books --module projects   # + Books, for the Products switcher
node packages/merit-ui/scripts/sync-brand.mjs apps/projects --check                            # CI: exit 1 if stale
```

Drop `lucide-react`, Plus Jakarta Sans, JetBrains Mono, `darkMode` and `<html class="dark">` from the app.
Do **not** add `@tailwindcss/forms`.

### 2. PostCSS — `postcss-import` first

```js
// apps/projects/postcss.config.js
module.exports = { plugins: { 'postcss-import': {}, tailwindcss: {}, autoprefixer: {} } };
```

### 3. `globals.css` — the cascade order (exactly this, nothing else above it)

```css
/* apps/projects/src/app/globals.css */
@import "tailwindcss/base";                               /* 1. preflight                         */
@import "@meritbooks/merit-ui/styles/system.css";         /* 2. kit v2.3, verbatim                 */
@import "@meritbooks/merit-ui/styles/marks.css";          /* 3. promoted board marks               */
@import "@meritbooks/merit-ui/styles/next-adapter.css";   /* 4. Next/Tailwind fixes                */
@import "tailwindcss/components";                         /* 5.                                    */
@import "tailwindcss/utilities";                          /* 6. page-local layout utilities only   */
```

Why this order: if `system.css` loads before preflight, preflight's `html{line-height:1.5}` /
`body{line-height:inherit}` override the 13/20 body type, and button resets fight `.btn--primary`.
Preflight → system → components → utilities makes the kit win over preflight and lets layout utilities
(`grid-cols-12`, `gap-3`) still apply last.

`next-adapter.css` contains only these fixes (review 01 §1.4):

| # | Fix | Why |
|---|---|---|
| 1 | `--f-text` / `--f-display` → `var(--font-dm-sans)` / `var(--font-syne)` (literal names as fallback) | next/font hashes family names |
| 2 | `code,kbd,samp,pre{font-family:var(--f-text)}` | preflight gives them a mono stack; the suite has no mono |
| 3 | `::placeholder{color:var(--ink-3)}` | preflight's gray-400 is off-palette |
| 4 | `.app--viewport{height:100dvh;min-height:0}` | the shell must not scroll away; `.main` scrolls |
| 5 | `.scrim--fixed`, `.popover--fixed` `{position:fixed}` | overlays render through a portal on `<body>` |
| 6 | queue cursor / selection / hover repainted on `td` (identical values), row shadow dropped | Safari doesn't reliably paint `<tr>` background/box-shadow |

### 4. `tailwind.config.ts` — strict preset

```ts
import type { Config } from 'tailwindcss';
import meritPreset from '@meritbooks/merit-ui/preset';

export default {
  presets: [meritPreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/merit-ui/src/**/*.{ts,tsx}'],
} satisfies Config;
```

The preset **replaces** colors, spacing, type sizes, radius and shadows — off-palette utilities
(`bg-emerald-500`, `rounded-lg`, `font-mono`, `text-sm`) simply don't exist.
**Spacing is the kit's 8-pt scale: `1` = 8px, `2` = 16px, `3` = 24px, `4` = 32px, `5` = 40px, `6` = 48px,
`8` = 64px, `half` = 4px** (so `p-4` is 32px). Plus `w-rail`, `h-bar`, `h-ctxline`, `h-row`.
Colors: `bg-electric text-ink-2 border-line bg-sky text-pos` …; `font-display` (Syne) / `font-sans` (DM Sans);
`text-cap|ui|body|section|title|display`; `tracking-caps|table`; `shadow-float|lift|cursor`; `rounded-kbd`.

### 5. Root layout

```tsx
// apps/projects/src/app/layout.tsx
import type { Metadata } from 'next';
import { fontVariables } from '@meritbooks/merit-ui/fonts';
import { IconSprite, titleTemplate } from '@meritbooks/merit-ui';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { template: titleTemplate('projects'), default: 'Merit Projects' },   // "To review · Merit Projects"
  icons: { icon: '/brand/lockups/merit-icon-full-color.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>{/* on <html>: the tokens live on :root */}
      <body>
        <IconSprite />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

```tsx
// apps/projects/src/app/providers.tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MeritProvider, ScopeParamsProvider, ToastRegion } from '@meritbooks/merit-ui';

export function Providers({ children, companyId }: { children: React.ReactNode; companyId?: string }) {
  const router = useRouter();
  return (
    <MeritProvider link={Link} navigate={router.push}>        {/* the ONE hotkey registry */}
      <ScopeParamsProvider params={{ company_id: companyId }}>{children}</ScopeParamsProvider>
      <ToastRegion />
    </MeritProvider>
  );
}
```

```tsx
// apps/projects/src/components/shell.tsx ('use client') — rendered by (app)/layout.tsx; the S1 grammar
<AppShell
  context="client"            // client | own | consolidated | workspace | platform  (a job is a page, not a context)
  density="cockpit"           // by ROLE: cockpit for PMs/estimators/schedulers, report for owners/ops leaders
  rail={
    <Rail module="projects" foot={<RailFoot eyebrow="Week 43" user={{ initials: 'DL', name: 'Dana Lee', role: 'Project manager · 6 jobs' }} />}>
      <RailNav groups={filterNav(NAV, { context, can, modulesInUse })} pathname={usePathname()} />
    </Rail>
  }
  bar={
    <Bar>
      <ContextChip ref={chipRef} name="Heartland Heating & Cooling" meta="C-103" pip="track" expanded={open} onOpen={() => setOpen((o) => !o)} />
      <Crumbs items={[{ label: 'Jobs', href: '/jobs' }, { label: 'Budget' }]} />
      <CmdkTrigger onOpen={openCommandBar} />
      <SyncStatus>Synced 9:38 AM</SyncStatus>
    </Bar>
  }
>
  <ContextLine items={['Mon Oct 19', 'Week 43', { label: '3 jobs over budget', strong: true }, '2 draws due Fri']} />
  <Page>{children}</Page>
</AppShell>
<ContextSwitcher open={open} onClose={() => setOpen(false)} anchorRef={chipRef} groups={[...groups, productsGroup('projects', products)]} onSelect={go} />
```

### Fonts fallback

`src/fonts.ts` calls `next/font/google` (`Syne` 700, `DM_Sans` variable with the `opsz` axis) from inside the
package. That works when the package is in `transpilePackages`. If a Next upgrade stops resolving font loaders in
transpiled packages, copy the two calls verbatim into `apps/<app>/src/app/fonts.ts` (next/font requires literal
options at the call site, so they can't be passed as a config object) and keep the variable names
`--font-syne` / `--font-dm-sans` (`FONT_VARIABLES` exports them):

```ts
import { DM_Sans, Syne } from 'next/font/google';
export const syne = Syne({ subsets: ['latin'], weight: '700', display: 'swap', variable: '--font-syne' });
export const dmSans = DM_Sans({ subsets: ['latin'], axes: ['opsz'], display: 'swap', variable: '--font-dm-sans' });
export const fontVariables = `${syne.variable} ${dmSans.variable}`;
```

`fonts.ts` is deliberately **not** re-exported from the package root (next/font only runs inside Next).

---

## The binding rules (the code enforces most of them)

1. **Palette only.** The §2 hexes; nothing else enters a screen. Electric is the only call-to-action colour;
   green is never a CTA; amounts are never coloured by debit/credit. (`tokens.test.ts` fails on any off-palette hex in `src/`.)
2. **Square everywhere — radius 0** on buttons, inputs, cards, panels, dialogs, tags. **The one exception is `.kbd`
   (2px).** Radios are circles. No pills.
3. **Syne 700 + DM Sans 400–700 only. No monospace** — figures are DM Sans tabular (`.tnum` / `.n`).
4. **Syne never in a table cell, never on a button, never on a number with a decimal.** Titles, section titles, a
   statement's bottom line, note numerals only.
5. **≤ 5 type sizes per screen** (12 · 13 · 15 · 20 · 28, or 40 once for a bottom line).
6. **Every figure tabular, right-aligned, consistent decimals per column; negatives in parentheses** `(4,454.42)`;
   **totals tie** (`Evidence` and `StatementTable` assert it in development). Money is **integer cents**.
7. **Status is never colour alone** — pip shape + word (`<Status>`); confidence is meter + number (`<Conf>`).
8. **A number is never alone** — value + comparison + destination (`<Figure vs href>`); no 4-KPI icon strip.
9. **The shell:** rail lockup · 48px bar (⌘J chip, crumbs, ⌘K, sync) · 32px context line · the primary module
   top-left at 8 of 12. **No banner hero, no greeting, no full-bleed blue/Midnight block of big words.**
10. **The logo is the product lockup file** (`<Lockup module="projects"/>`) — never the bare logo plus a product
    word, never live text. Written name: two words, "Merit Projects".
11. **AI is a note, never a chat bubble or sparkle** — claim, evidence that sums, basis/confidence, one or two
    actions. AI-down: say so plainly (`<AiPaused/>`), never a dead tile.
12. **States:** loading (skeleton), empty (dashed mark + what to do), done (spruce check + what's next), error
    (what happened + what to do + retry). No permission → don't render the widget. **Never "No data".**
13. **Banned words in UI copy:** "portfolio", "portco", "holding company", "entities" (meaning books), synergy,
    leverage, best in class, world-class, revolutionize, solutions, "No data". Use client/company, workspace,
    consolidation group, own books. Verbs on buttons; the toast repeats the verb ("Approve 3" → "Approved 3").
14. **No gradients, glows, glass, shimmer (except the loading skeleton), emoji, stock icons.** Icons come from the
    sprite: 16px, 1.5px stroke, `currentColor`, always `class="ico"`.
15. **Keyboard everywhere, through one registry.** Every action has a key printed beside it. Visible
    `:focus-visible` (Electric on light, Signal on dark, white on the own-books bar). `prefers-reduced-motion`
    honoured globally (kit).

`test/lint-banned.test.ts` scans `src/` for `rounded-*`, `font-mono`, `emerald`, `lucide`, "portfolio",
"No data", Tailwind default-palette utilities, gradient/blur/shadow utilities and emoji.

---

## Public API

| Area | Exports |
|---|---|
| Provider | `MeritProvider` (`link`, `navigate`, `hotkeys`), `AppLink`, `useMeritUI` |
| Brand | `Lockup` (`module`, `form` horizontal·vertical·icon, `variant` on-dark·midnight·white·full-color, `height`, `basePath`), `lockupSize`, `lockupFile`, `PRODUCT_NAMES`, `pageTitle(page, module)`, `titleTemplate(module)` |
| Icons | `IconSprite` (23 kit symbols + calendar, clock, truck, wrench, hammer, clipboard, users, map-pin, camera, box, factory, home, building, file-text, dollar, more, upload, up, left), `Icon` (`name`, `label?`), `IconName` |
| Shell | `AppShell` (`context`, `density`, `mini`, `viewport`, `band`, `rail`, `bar`), `SupportBand`, `ViewAsBand`, `Rail` (`module`, `foot`, `mini`), `RailGroup`, `RailLink` (`count`, `alert`, `keys`, `active`), `RailNav`, `RailFoot`, `Bar`, `ContextChip` (⌘J), `Crumbs`, `CmdkTrigger` (⌘K), `SyncStatus`, `ContextLine` (`items` joined by `//`), `Page`, `PageHead`, `ContextSwitcher` (+ `productsGroup`), `filterNav`, `activeHref`, `navChords` |
| Hotkeys | `useHotkey(chord, handler, opts)`, `HotkeyProvider`, `createHotkeyRegistry`, `HotkeyConflictError`, `chordKeys`, `normalizeChord` |
| Primitives | `Button` / `ButtonLink` (`variant` default·primary·quiet·danger·dark, `size` md·lg, `icon`, `iconAfter`, `iconOnly`, `chord`, `bindChord`), `Kbd`, `Keys`, `Keyhints`, `Keybar`, `Field`, `Input`, `MoneyInput` (`valueCents`, `onChangeCents`), `Select`, `Textarea`, `Search` (`slashToFocus`), `Check`, `Radio`, `Switch`, `Tabs`, `Seg`, `Bands`, `Pip`, `Status`, `Tag`, `InlineNotice`, `Meter` / `Conf` / `StageMeter` (+ `stepStrokes`, `scoreStrokes`, `countStrokes`), `Eyebrow`, `Sl`, `Figure`, `KV`, `Ledger` |
| AI | `Note`, `Notes`, `NoteRef`, `NoteLinkProvider`, `Evidence` (asserts the sum; renders the total), `Basis`, `Why`, `NotePanel`, `AiPaused`, `assertEvidenceTies` |
| Overlays | `toast()` / `toast.error()` (verb + optional `undo`, ⌘Z), `ToastRegion`, `Panel`, `PanelSection`, `Drawer`, `Dialog`, `ConfirmDialog` (verb label, typed `reason`), `Popover` (+ Head/List/Group/Item/Foot), `useHoverPeek` + `HoverPeekCard`, `Scrim`, `useFocusTrap` |
| Tables | `QueueTable` (groups/bands, cursor ≠ selection, bulk bar, J/K/X/↵/Esc + action keys), `BulkBar`, `StatementTable` (statement rows, `sumOf` tie checks, parentheses + hanging paren), `StatementFigure`, `ListPager`, `pagerState` |
| Dash | `Dash`, `Widget` (`w`, `h`, `primary`, `state`), `WidgetState` (loading·empty·done·error), `WIDGET_SIZES` |
| Hooks | `useQuery` / `useMutation` + `ScopeParamsProvider`, `api` / `createApiClient`, `useDebounce`, `useEscapeKey`, `useListKeynav` |
| Format | `money` (cents → `3,184.62` / `(4,454.42)`), `compactMoney`, `parseMoneyToCents`, `pct`, `pts`, `count`, `shortDate`, `dayDate`, `longDate`, `monthYear`, `clockTime`, `isoWeek`, `daysBetween`, `countdown`, `sumCents` |

### Hotkeys — one registry, no double binding

Everything (⌘K, ⌘J, `/`, `G`-then-`X` go-to, `J K X A E Esc ↵` in a queue, ⌘Z undo) registers through
`useHotkey`. Registering a chord that is already live — or `g` while `g h` exists — **throws in development**
(`HotkeyConflictError`) and is refused with a console error in production. Plain keys are ignored while typing;
⌘ chords still work in fields (opt out per binding). Keys inside `[aria-modal="true"]` or `[data-hotkeys="off"]`
(dialogs, drawers, popovers) belong to that surface. One live `QueueTable` per page (`hotkeys={false}` on a second).

### Marks (`styles/marks.css`)

Promoted verbatim from the boards (README §6a/§6b): `.src` `.src--bridge` `.srcs` (source chip) · `.prov`
(provenance) · `.tier--live|partner|bridge|file` · `.stgw` + 8-stroke `.meter` (migration stage; `<StageMeter>`) ·
`.pipe` (run pipeline) · `.seq` (sequence strip) · `.trk` (cadence track) · `.pb` + `.lgd` (plan bar) · `.ru`
(headroom ruler) · `.ih` / `.cell` (inheritance). Collisions resolved: S23's caption `.src` is dropped (use
`.t-cap`); S22's legend is renamed `.trk-lg`; `.who` is scoped to `.stgw .who`; `.cell` is un-scoped from `.lin`.

---

## Tests

```bash
cd packages/merit-ui
npx tsc --noEmit -p .
npx vitest run
```

`tokens` (preset ≡ system.css `:root`, kit hash, palette-only code) · `format` · `evidence` (sums + statement
ties) · `nav` (`filterNav`) · `hotkeys` (registry, no duplicates, sequences, typing/modal isolation) · `brand`
(lockup ratios vs SVG viewBoxes, sprite = kit paths) · `render` (SSR smoke of shell/primitives/states) ·
`toast` · `lint-banned` · `link-compat` (next/link fits `LinkComponent`).
