# MeritBooks Design System v2

One stylesheet, two densities. **A "Annual Report"** sets the owner and executive screens: editorial Syne
titles, statement rules, notes to the figures. **B "Operator Cockpit"** sets the work screens: the
Midnight frame, 48px rows, keys printed beside the verbs, the slash meter. Same tokens and components.
Only the density class changes.

| File | What it is |
|---|---|
| `system.css` | Tokens and every component. The only CSS a screen needs (plus page-local layout). |
| `components.html` | Component sheet. Every class below, with Merit content. |
| `S7-switcher-and-contexts.html` | IA-SPEC S7: the open ⌘J switcher, the four shell states, the decision record. |
| `S8-dashboard-edit.html` | IA-SPEC S8: user edit mode, then admin "Edit role layout" + Publish. |
| `assets/` | Real logo files only: `merit-logo-on-dark.png`, `merit-logo-on-light.png`, `merit-icon.png`. |

Binding inputs: `design-studio/BRIEF.md`, the Merit Brand Guidelines 2026 (`design-studio/assets/guide-*.png`),
`docs/ia/IA-SPEC.md`. Where this file and IA-SPEC disagree on *behaviour*, IA-SPEC wins. Where they disagree on
*visual treatment* (see §6, context states), this file wins. The owner approved directions A and B on visuals.

> **Conflict to reconcile:** `docs/DESIGN-SYSTEM.md` and `CLAUDE.md` still describe 16px card radii, 10px
> button radii and JetBrains Mono figures. The approved directions and the brief replace these: square
> geometry (2px on keycaps only), and figures in DM Sans tabular. The lead should update those docs before
> the system is ported to `apps/web`.

---

## 1. Setup

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Syne:wght@700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="system.css">
```

Put the density on the page root, and the context on `.app`:

```html
<div class="app density-cockpit" data-context="client">…</div>   <!-- bookkeeper, manager, controller, payroll, clerk, platform -->
<div class="app density-report"  data-context="workspace">…</div> <!-- owner, CFO, finance director, dept head, auditor -->
```

Icons are inline SVG, 16px, 1.5px stroke, square caps, drawn from a `<symbol>` sprite at the top of each page
(`<svg class="ico" width="16" height="16"><use href="#i-search"/></svg>`). No icon fonts, no stock icons
as decoration.

---

## 2. Tokens

**Colour. Brand hexes are exact. Nothing outside these enters a screen.**

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--electric` | #2563EB | titles, rules, primary buttons, links, focus, active | 5.2:1 on white |
| `--signal` | #3B82F6 | accent **on Midnight only** (active nav bar, focus on dark) | 4.9:1 on Midnight |
| `--midnight` | #0A1628 | shell, body copy (`--ink`), total rules | 17.7:1 on Warm |
| `--steel` | #3D4F65 | secondary text (`--ink-2`), consolidated bar | 8.2:1 |
| `--slate` | #8494A7 | labels **on Midnight only**. 3.1:1 on white, so never text on light | 5.9:1 on Midnight |
| `--warm` | #FDFCFA | page | |
| `--canvas` | #F5F3EF | insets, notes column, queue group rows, dialog foot | |
| `--sky` | #EBF2FE | selection, AI, info | |
| `--ink-3` | #536A82 | captions; the AA floor for text on light | 5.5:1 · 5.0:1 on Canvas/Sky |
| ramps | `--blue-100…300`, `--grey-100…400`, `--night-500…800` | sampled from the guide's Usage page (p.14) | |
| `--pos` / `--neg` / `--warn` | #1F6E50 / #B42318 / #8A5A00 | status only. Each has a `-wash` | 6.2 / 6.6 / 5.9:1 on white; ≥ 5.2:1 on wash |

Green is never a call to action. Amounts are not coloured by debit/credit. Negatives use parentheses.

**Type. Syne 700 and DM Sans 400/500/600/700, nothing else. At most five sizes per screen.**

| Class | Spec | Use |
|---|---|---|
| `.t-display` | Syne 40/48 | a statement's bottom line, once per screen |
| `.t-title` | Syne 28/32, Electric Blue | page title |
| `.t-section` | Syne 20/28 | report-density section and widget titles; dialog titles (Midnight) |
| `.t-head` | DM Sans 15/24 600 | cockpit widget titles, note claims |
| `.t-body` | DM Sans 15/24 | reading copy |
| `.t-ui` (default) | DM Sans 13/20 | tables, controls |
| `.t-cap` | DM Sans 12/16, Ink 3 | captions |
| `.eyebrow` + `.sl` | DM Sans 12/16 500, +14% caps | the guide's `02 // Label`. `.sl` is the blue `//` |
| `.tnum` / `.n` | tabular lining numerals (`.n` also right-aligns) | every figure |

Syne never goes in a table cell, never on a button, and never on a number that has a decimal.

**Space.** `--s-half 4` (optical only) · `--s1 8` · `--s2 16` · `--s3 24` · `--s4 32` · `--s5 40` · `--s6 48` · `--s8 64`.
**Shell.** `--rail 232` (64 collapsed) · `--bar 48` · `--ctxline 32` · `--gutter 24` · `--margin 32`.
**Grid.** 12 columns. Dashboard rows `--row 136px` (h2 = 296, h4 = 616).
**Shape.** Square everywhere. The one exception is `.kbd` (2px), so keys read as keys.
**Elevation.** Hairlines first (`--line`, `--line-2`). Only floating things get a shadow: `--float` (popover, dialog), `--lift` (a dragged widget).

---

## 3. Class reference

| Area | Classes |
|---|---|
| Shell | `.app` `[data-context]` `.app--mini` · `.rail` `.rail-logo` `.rail-nav` `.rail-group` `.rail-link[aria-current]` (`.count`, `.count--alert`, `.keys`) `.rail-foot` `.rail-user` `.rail-icon` `.avatar` · `.bar` `.ctx` `.ctx-name` `.ctx-meta` `.ctx-tag--own` `.ctx-tag--ro` `.crumbs` `.cmdk` `.sync` · `.support-band` (`.clock`) · `.main` `.ctxline` `.page` `.page-head` |
| Actions | `.btn` `--primary` `--quiet` `--danger` `--dark` `--lg` `--icon` · `.btn-row` · `.kbd` `.kbd--dark` · `.keys` `.keyhints` `.keybar` · `.link` |
| Inputs | `.field` `.field-label` `.field-help` `.field-error` · `.input` (`.is-error`, `--money`) `.select` `.textarea` `.search` · `.check` `.radio` `.switch` (markup: `<label class="check"><input type="checkbox"><i></i>Label</label>`) |
| Navigation | `.tabs` `.tab[aria-selected]` · `.seg button[aria-pressed]` · `.bands` `.band-tab` (Decide / Check / Ready) |
| Tables | `.tbl` + `.tbl-fs` (statement: `.fs-head` `.fs-line` `.fs-elim` `.fs-sub` `.fs-grand` `.fs-gap`, `.cur`, `.nt`, `.hp`, `.fu--f/--u`) · `.tbl` + `.tbl-q` (queue: `.q-group` `.q-group-t` `.q-row` `.is-selected` `.is-cursor` `.is-done` `.is-attn`, `--compact`, `--flush`) · `.l1` `.l2` `.code` `.th-sort` · `.bulk` |
| Status | `.status--{ready,track,risk,overdue,blocked}` + `.pip--{ready,track,risk,overdue,blocked,open,soft,closed}` · `.tag` `--ai` `--pos` `--neg` `--warn` `--solid` · `.match` `--none` `--partial` · `.inline-notice` `--warn` `--neg` `--info` |
| Slash meter | `.meter` (`--lg`) › `i.on` `i.part` `i.cur` `i.bad` · `.conf` (`--lo`) › `.meter` + `b` |
| Notes & evidence | `.nref[data-note]` · `.notes` `.notes-head` · `.note[data-note]` `.note-top` `.note-no` `.note-kind` `.note-title` · `.ev` (`.dl`, `.v`, `.ev-total`) · `.basis` · `.note-acts` · `.why` (`li.against`) · `.note--panel` · `.is-lit` `.is-lit-fig` |
| Overlays | `.toast` `.toast-mark` `--neg` `.toast-region` · `.popover` `-head` `-list` `-group` `-item[aria-selected]` `-foot` · `.tooltip` · `.panel` `-head` `-body` `-sec` `-sec-h` `-foot` · `.scrim` `.dialog` `-head` `-body` `-foot` |
| Figures | `.fig` `.fig-l` `.fig-v` (`--dense`) `.fig-vs` · `.kv` |
| Dashboard | `.dash` · `.wg` (place with `--w` `--h`, optional `--x` `--y`) `.wg--primary` · `.wg-head` `.wg-title` `.wg-count` `.wg-meta` `.wg-act` `.wg-body` (`--pad`) `.wg-foot` · `.wg-state` `.wg-done-mark` `.wg-empty-mark` · `.wg-loading` |
| Edit mode | `.editbar` (`--admin`) · `.dash-wrap` `.dash-guides` `.dash.is-editing` · `.wg-handle` `.wg-tool` `.wg-lock` `.wg-resize` · `.wg.is-required` `.is-lifted` `.is-resizing` · `.wg-drop` · `.size-chips` `.size-chip` · `.catalog` `-head` `-body` `-foot` `.cat-group` `.cat-card` (`.is-placed`) `.cat-thumb` · `.opt-cards` `.opt-card` · `.versions` |
| Utilities | `.row` `.row--between` `.sp` `.stack` `.grid-12` `.surface` `.inset` `.hairline` `.ink` `.ink-2` `.ink-3` `.pos` `.neg` `.warn` `.blue` `.b` `.sr` `.skip` |

Naming: block, `block-element`, `block--modifier`, `is-state`. Don't add a new block without adding it to `components.html`.

---

## 4. Layout recipes

### 4.1 A home dashboard (any role)

```html
<div class="app density-cockpit" data-context="workspace">
  <aside class="rail">…</aside>
  <header class="bar">
    <button class="ctx" aria-haspopup="dialog">…Merit Management Group <span class="ctx-meta">Workspace</span> <span class="kbd">⌘J</span></button>
    <span class="crumbs"><b>Home</b></span>
    <button class="cmdk">…<span class="kbd">⌘K</span></button>
  </header>
  <main class="main">
    <div class="ctxline">
      <span>Mon Oct 19</span><span class="sl">//</span><span>September close</span><span class="sl">//</span>
      <span>Day 12 of 15</span><span class="sl">//</span><b>1 of 6 clients ready for review</b>
      <span class="sp"></span><button class="btn btn--quiet">Customize</button>
    </div>
    <div class="page">
      <div class="dash">
        <section class="wg wg--primary" style="--w:8;--h:4">…bk.my_clients…</section>   <!-- always top-left, 8 of 12 -->
        <section class="wg" style="--w:4;--h:4">…bk.agenda…</section>
        <section class="wg" style="--w:6;--h:2">…bk.ai_judgment…</section>
        <section class="wg" style="--w:6;--h:2">…bk.requests_out…</section>
      </div>
    </div>
  </main>
</div>
```

- Order is the IA-SPEC §4 module order for the role. Module 1 is the primary module: `wg--primary`, top-left, 8 columns, rendered first from one query. The rest lazy-load below the fold.
- Report-density homes (owner, CFO) use the same grid. `.density-report` turns widget headers into Syne section titles over a blue rule and drops the widget box.
- Sizes: S 3×2 · M 6×2 · L 6×4 · W 12×2 · XL 12×4, plus 4 and 8 wide for primary pairs. Snap only to sizes the registry declares.

### 4.2 A queue screen (inside a client)

```html
<main class="main">
  <div class="ctxline">…Due Oct 21 · at risk…</div>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;height:calc(100vh - 80px)">
    <section style="display:flex;flex-direction:column;min-height:0">
      <div class="page-head">…<h1 class="t-title">To review</h1>…</div>
      <div class="bands">…Decide 6 · Check 12 · Ready 23…</div>
      <div class="bulk">3 selected // Ready band // (15,461.30) … Approve 3</div>   <!-- only when selected -->
      <div style="flex:1;overflow:auto"><table class="tbl tbl-q">…tr.q-group / tr.q-row…</table></div>
      <div class="keybar">J K move · X select · A approve · F flag · E edit · Q ask client</div>
    </section>
    <aside class="panel">…note--panel (AI reasoning) · posting preview (tbl-fs) · panel-foot actions…</aside>
  </div>
</main>
```

- Group by band, lowest confidence first. The cursor (`is-cursor`) and the selection (`is-selected`) must never look the same.
- Every action has a key, printed next to it. The panel never covers the row it describes.

### 4.3 A statement

```html
<div class="app density-report" data-context="consolidated">
  …
  <div class="page" style="display:grid;grid-template-columns:minmax(0,1fr) 352px;column-gap:24px">
    <div>
      <div class="page-head"><div><div class="eyebrow">…</div><h1 class="t-title">Consolidated income statement</h1></div>…</div>
      <table class="tbl tbl-fs">
        <thead><tr><th>In US dollars</th><th class="nt">Note</th><th class="n cur">Sep 2026</th>…</tr></thead>
        <tbody>
          <tr class="fs-head"><td colspan="8">Revenue</td></tr>
          <tr class="fs-line" data-note="2"><td>HVAC</td><td class="nt"><a class="nref" data-note="2" href="#n2">2</a></td><td class="n cur">3,503,500<span class="hp">)</span></td>…</tr>
          <tr class="fs-line fs-elim">…Intercompany eliminations (312,000)…</tr>
          <tr class="fs-sub">…Total revenue…</tr>
          …
          <tr class="fs-grand">…Operating income…</tr>
        </tbody>
      </table>
    </div>
    <aside class="notes">…article.note[data-note]…</aside>
  </div>
</div>
```

- Blue rule under the header, single Midnight rule over a subtotal, blue double rule under the total.
- Positive figures carry `<span class="hp">)</span>` so the digits line up with parenthesised negatives.
- Eliminations are always explicit lines (`fs-elim`), never netted silently.
- Linking: anything with `data-note="n"` lights with its note on hover/focus (see the script in `components.html`).

---

## 5. Rules

1. **No banner heroes.** Above the fold on 1440×900: the bar, the 32px context line, then the primary module. No greeting, no welcome copy, no full-bleed Midnight or blue block of big words. The owner rejected it; this is binding.
2. **Every number has a comparison and a destination.** Use `.fig` (value + `.fig-vs` + link) or a table row that drills. A number with no "vs" and nowhere to go is cut.
3. **Every module has one primary action**: a verb button, or a row click into a filtered queue.
4. **Every module defines an empty state and a done state.** Empty = nothing configured, tell them what to do. Done = configured and nothing to do, say what's next ("Nothing due until Oct 26"). Never "No data".
5. **Never a blank widget for missing rights.** Don't render it; the grid reflows. The catalog only lists permitted widgets.
6. **AI-down honesty.** When the gateway is off, say "AI paused — rules and vendor memory still coding" inline (`.inline-notice` or `.wg-state`). Never a dead tile.
7. **The AI speaks as a note**, never as a chat bubble or sparkle. Claim, evidence (`.ev` that sums to the claim), basis/confidence, action.
8. **Status is never colour alone.** Pip shape + word. Confidence is meter + number.
9. **Totals tie.** Every subtotal equals the sum of its rows on the page. Captions say so when it matters.
10. **Words.** Use IA-SPEC §1.1 terms: client / company, workspace, consolidation group, own books. Banned in UI copy: "portfolio", "portco", "holding company", "entities" (meaning books), "synergy", "leverage", "best in class", "world-class", "revolutionize", "solutions". Verbs on buttons; the toast repeats the verb ("Approve 3" → "Approved 3").
11. **Accessibility.** AA contrast (ratios in §2), visible `:focus-visible` (Electric Blue on light, Signal Blue on dark, white on the own-books bar), 32px minimum hit targets, `prefers-reduced-motion` respected.
12. **Motion.** 120ms colour/background transitions on hover and selection, 200ms on lifts and note lighting. Nothing ambient.

---

## 6. Context states (decision)

IA-SPEC §3.1 asked for a 4px amber / steel / red band under the bar. Amber isn't in the Merit palette, a 4px
line stops being noticed within a week, and amber says "something's wrong" when posting to the firm's own
books is legitimate work. v2 changes the bar itself and gives each state one meaningful mark:

| `data-context` | Bar | Mark | Chip |
|---|---|---|---|
| `client` | Midnight | none (the quiet default) | period pip · name · C-number · "Sep open" |
| `own` | **Electric Blue** (white text 5.2:1). White-label: the tenant's brand primary | the bar's colour | Midnight chip + Warm White "Own books" tag |
| `consolidated` | **Steel** (white 8.2:1) | **blue double rule** under the bar, the annual-report rule that closes a total | layered mark · group name · "Read-only" tag. Processing nav removed, not disabled |
| support session | unchanged, so it overlays any state | **32px brick band above the shell**, hatched with the monogram's 45° slash across the rail, countdown + End always visible | unchanged; the agent appears in the rail foot |
| `workspace`, `platform` | Midnight | none | grid mark · tenant name · "Workspace" / "MeritBooks Platform" |

Add `<div class="support-band">` as the first child of `.app`; the grid reserves its row.

---

## 7. Before you hand a screen over

- [ ] Five type sizes or fewer; Syne only on titles and a bottom line.
- [ ] Every figure tabular, right-aligned, consistent decimals; negatives in parentheses; totals tie.
- [ ] Primary module top-left, 8 of 12; context line 32px; no banner.
- [ ] Each module: one primary action, empty state, done state.
- [ ] Hover, selected, focus-visible, a keyboard hint and an AI note are visible somewhere in the mock.
- [ ] Contrast checked against the table in §2; no Slate text on light.
- [ ] Real Merit-shaped content; no lorem ipsum, no "portfolio".
