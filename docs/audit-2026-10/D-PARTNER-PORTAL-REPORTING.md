# D. Merit Partner Portal: reporting inventory (to match and exceed in MeritBooks FP&A)

**Date:** 2026-10-22. **Status:** read-only audit. Nothing in `/Users/mike/Projects` was modified.

**Source.** The portal exists only as git bundles. All `mpp-*` and `portal-*` bundles from 0029 onward were fetched into one repo. History is linear, and **`mpp-minutes.bundle` (commit `7703eeb`, 2026-10-20) is the tip**, so every earlier bundle is an ancestor of it. Stack: Next.js 16, React 19, Supabase, **Recharts 3.10**, pdf-lib (server PDFs), a home-grown xlsx writer, and the same Merit brand tokens as merit-ui. Reporting code is about 40k lines across `src/features/financials`, `src/features/capital`, `src/features/debt`, `src/components/charts`, `src/components/holdings`, `src/features/pdf` and `src/features/dashboard`. Specs: `docs/SPEC.md` and `docs/WORKFLOW.md` in the bundle.

**Audience.** The partners of the management company: Board seats (managers), Common Members, officers, the Corporate Secretary and the administrator. They are investors and governors, not accountants. The administrator curates what partners see.

**Data sources.** Every financial figure comes from:
- the **QuickBooks Online sync** (daily at 7:00 CT, plus on demand);
- **uploaded QuickBooks statement exports** (P&L and balance sheet);
- **summary CSV imports** or **hand-entered months**.

All of these land as `financial_lines` (one row per account per month) and are derived into **standard lines** on `financial_periods` through an account mapping. Other inputs: approved budget versions, headcount by month, the debt schedule (instruments and month-end balances), and the cap table and capital ledger. **There is no general ledger.** The portal reports on statements produced elsewhere. MeritBooks owns the GL, which is the structural advantage to exploit.

---

## 1. Catalog of reporting surfaces

### 1.1 Financials workspace (`/financials/**`), the core FP&A surface

**Navigation model.** Four top tabs, which the administrator orders and renames. Under each, the same sub-tabs, with each view addressable in the URL so it can be bookmarked or shared.

| Top tab | Scope | Notes |
|---|---|---|
| **MMG** | The management company alone | `/financials/<id>` |
| **Portfolio** | Every portfolio company the reader may see, added together, without MMG | "Combined, not consolidated" badge |
| **Companies** | The directory → one company → **any multi-select** (`?ids=a,b,c` added together) | The selection is re-validated against reader access on every request |
| **Consolidated** | MMG plus every company | Offered to partners only if the administrator turns it on. Heading: "intercompany balances are not eliminated" |

**Sub-tabs** (`?view=`): Dashboard · Performance · P&L by month · Balance sheet · Budget · Debt · Equity · Holdings (Consolidated only) · Data and mapping (administrator only).

**Global controls on every view:**
- **Months shown:** YTD / 12M / 24M / 3Y / 5Y / All, with the administrator's per-dashboard default. The label reads "Through Aug 2026".
- **Count the month in progress** (`open=1`).
- **Reporting-cutoff banner** ("Showing through August 2026", plus the day the next month releases). For administrators: "Confirm September closed" and an **"Include months not yet released"** preview toggle, which turns the banner amber.
- **Ownership-weighted ↔ 100% each** toggle on combined views. It multiplies each entity by the look-through ownership share and names any entity assumed at 100%.
- **"Set the month Merit acquired X"** prompt. Before that month, nothing is shown anywhere: dashboards, charts, growth rates, exports, packet.
- **Gaps callout.** "N months are not on file". A missing month is a gap, never a zero.
- **Customize dashboard** and **Arrange** (in place, drag, keyboard arrows) for administrators, plus personal **Customize** on Performance.

#### A. Dashboard sub-tab: metric cards and sections chosen by the administrator

**Metric card anatomy** (`metric-card.tsx`):
- label, with an (i) tooltip giving the exact formula;
- a period chip ("YTD TO AUG ’26", "AT AUG ’26", "TTM TO …");
- the big figure (Syne, 26px);
- a delta arrow with a sign word: **"improvement / erosion"**, or **"favorable / unfavorable"** against budget;
- the comparison label ("vs same months last year");
- extra detail lines (for example "Change in dollars", "Adjusted, with add-backs");
- a sparkline or mini-bars.

When a card cannot state a figure, it says why in words instead: **Not enough history** (with years on file), **Not on file**, **Not mapped**, **Not meaningful** (base ≤ 0), **No approved budget**. The grid is 4 / 2 / 1 across. Trend cards span two columns.

**Period basis (administrator, per dashboard kind):** YTD (default), TTM, QTD, latest month, full prior year. **Comparison:** same period last year (default), approved budget, prior period, none.

**The 37-card metric catalogue** (`dashboard/metrics.ts`, a pure typed registry, each with a formula string):

| Group | Cards |
|---|---|
| Growth | Revenue; Revenue growth YoY (YTD and latest month vs the same month a year earlier); Revenue CAGR 1/3/5y; EBITDA CAGR 1/3/5y; Rule of 40 (growth + EBITDA margin, with points above or below 40) |
| Profitability | Gross profit; Gross margin (Δ in points); EBITDA (= QuickBooks Net Operating Income, Δ % and $); EBITDA margin; Adjusted EBITDA (plus add-backs flagged in the mapping); Net income (+ net margin); SG&A; Opex % of revenue |
| Budget | Budget variance (revenue and EBITDA, $ and % of budget, favorable/unfavorable) |
| Balance sheet and cash | Cash; Working capital; Current ratio; Debt (balance sheet, with "On the debt schedule" under it); Net debt; Debt / TTM EBITDA (off by default, with the reason stated) |
| Efficiency | Revenue per employee and EBITDA per employee (TTM ÷ average headcount, at least 6 months of headcount); DSO; DPO |
| Shape of the year | Best and worst month (FYTD); Seasonality (each quarter's share, averaged over 3 complete years) |
| Trends (wide charts) | Sales by month; Gross margin by month; Opex by month; Opex % of sales by month; EBITDA by month; EBITDA margin by month; Sales vs prior year % by month. Each shows bars or a line plus the **same month a year earlier dashed**, **hatched preliminary months** (after the books' closing date), and blank months named where an entity is missing |

Default set: Revenue, Revenue CAGR 3y, Gross margin, EBITDA, EBITDA margin, Net income, Budget variance, Cash.

**Dashboard sections** (each a `ChartCard`, chosen and ordered by the administrator; `dashboard/config.ts`):

| Section | Shown on | What the user sees |
|---|---|---|
| Metric cards | all | the grid above |
| **Reporting deadlines** (locked on combined views) | combined | Three tiles under OA §8.05: monthly package to the Board within 45 days of month-end; quarterly statements to Members within 60 days; reviewed annual within 90 days. Each tile has the due date, "Due in N days", and a data-on-file chip (complete / partial "8 of 12 months on file" / missing) |
| **Combined roll-up** | combined | A "Not consolidated" explainer panel listing the entities added. **Combined revenue** and **Combined EBITDA** as MonthlyCombo charts (bars, dashed prior year, TTM sub-panel). **"Where the revenue comes from"** and **"Where the EBITDA comes from"** as share bars by entity, linking to each entity, with a loss drawn hatched |
| Revenue, gross profit, EBITDA by month | single entity | Three MonthlyCombo charts: bars by month, dashed prior-year line, approved-budget tick marks, a separate TTM panel underneath (synced cursor), hatched preliminary months. The tooltip shows value, prior year, YoY, budget, variance $ and % with favorable/unfavorable, and TTM |
| **Companies compared** (league table) | combined | Sortable on every column: Revenue, Growth, Gross margin, EBITDA, EBITDA margin, Share of EBITDA, Rule of 40. Rows carry a kind badge and a stale "as of" flag. Sticky first column. Export |
| **Year over year** | all | Table of lines × (Month, FYTD, TTM) × (current / year earlier / change). Δ is % for dollars and **points for margins**, with an n/m rule |
| **Budget against actual** | all | YTD variance sentence plus **VarianceBars** by month for Revenue and EBITDA. Carries the prior year's budget forward if none is approved (OA §6.02(c)) |
| **Margins** | all | Gross, EBITDA and SG&A % lines with a **basis switch (YTD / TTM / each month)**. A month with revenue under 5% of a typical month is n/m |
| **EBITDA bridge** | all | A **waterfall** from prior to current EBITDA (**YTD or TTM switch**). Steps: Revenue (volume at the prior margin), Gross margin (rate effect), Operating expenses. The steps sum exactly. "Adjusted EBITDA bridge" when add-backs exist |
| **Rule of 40** | combined | A **scatter** of growth against EBITDA margin, one dot per company, with a 40 diagonal and a "not placed" footnote |
| **Growth rates** | all | CAGR tiles for 1/3/5y, revenue and EBITDA, on a **TTM-to-TTM** basis, with a "books start in…" footnote |
| **Seasonality** | all | Calendar-month index (1.00 = average month) from complete years, plus the current year against it. Revenue / Gross profit switch |
| **Working capital** | all | DSO, DPO, DIO (if inventory) and **cash conversion cycle** lines by month, plus a current ratio column |
| Revenue per employee | single, if headcount exists | A big figure with average headcount |
| **Where the figures come from** (freshness) | combined | Per entity: status dot (Current / Behind / Needs attention / Nothing on file), source (QBO sync time / upload / manual), latest month, **books closed through**, and an administrator-written Notes column |

#### B. Performance sub-tab
The same analytic cards, laid out through the personal **Customize** (show, hide and reorder, saved per user). The administrator sets defaults per role and may lock cards.

#### C. P&L by month / Balance sheet
- Months across, with sticky account column and month headings.
- Opens scrolled to the **latest months, with the Total in view**, and says "scroll left for earlier ones".
- **$ / $K switch** (defaults to $K below 1536px).
- Accounting style with parentheses. A figure that rounds to zero prints as 0.
- **Two layouts:**
  - **As reported**: QuickBooks' own sections and accounts, with collapsible sections.
  - **Standard lines, EBITDA**: Revenue → COGS → Gross profit → seven opex buckets (Payroll and benefits, Sales and marketing, Occupancy, Vehicles and equipment, Insurance, Professional fees, G&A) → **EBITDA** → Adjusted EBITDA → other income/expense, D&A, interest, taxes → Net income. **Each standard line opens to the accounts mapped to it.** This is the drill-down.
- Markers: (P) preliminary month, (S) summary-only month.
- Accrual or cash basis stated.
- Combined views show standard lines summed, with each line opening to every entity's contribution.
- Every statement exports to CSV and xlsx.

#### D. Budget sub-tab
- Budget **versions** per fiscal year (draft / approved / superseded). Approval is linked to a resolution. Only an **approved** budget is ever compared.
- Budget-vs-actual summary table: budget to date, actual to date, variance, variance %, F/U, full-year budget.
- Monthly grid: budget, actual and variance rows per line.
- In-app budget editor. **Download or upload an xlsx template** (`/api/financials/budget-template`), which round-trips.
- On a combined view, budgets are summed only over budgeted entities, and the page names who is left out.

#### E. Debt sub-tab (and `/debt`, `/debt/[id]`)
- Stat tiles: **Outstanding, Undrawn availability (of committed), Weighted average rate, Next maturity**.
- **Schedule table**: instrument, entity, lender, type, balance, commitment, rate, rate terms, repayment, scheduled payment, paid, originated, matures, covenants (status badge), status, approving resolution. Grouped with per-entity subtotals on combined views.
- **Coming due** (the next 24 months).
- **Maturity ladder** (bars by year).
- **Balance by month** (TrendLine, top 5 instruments).
- Instrument page: balance history chart, terms, documents, cross-collateral warning.
- Administrator only: books-vs-schedule reconciliation, "Pull from balance sheet", and **AI extraction of loan terms from a dropped PDF or DOCX note**. The AI result is a proposal a person confirms.

#### F. Equity sub-tab (and `/cap-table`)
- Holders × unit classes (common / preferred / carry), ownership %, voting power, paid in, accrued unpaid preferred return.
- **Look-through ultimate ownership**: fund-held stakes are passed through to the fund's own holders.
- Cap table page:
  - an **as-of date** control;
  - stat tiles: unit classes, holders of record, voting units, capital contributed, preferred stated value, accrued unpaid preferred;
  - a **Voting power donut**;
  - **Equity ledger**;
  - **Preferred return accruals** (unreturned stated value, accruing on, per day, paid to date, accrued unpaid);
  - **Capital activity**;
  - a **print view** (`/cap-table/print`).

#### G. Holdings (`/holdings`, and Consolidated → Holdings)
- An **org chart** of the entity tree with zoom in/out, fit and print. Each box shows trade name, kind, "% held by X", and **revenue, margin and YoY (YTD or TTM)** with tone.
- Phone layout: an indented list.
- Summary tiles: portfolio companies, entities, debt on the schedule.
- Entity table: legal name, held by, ownership, formed, acquired, threshold treatment, status, and "figures through".
- The administrator can hide the cards and figures.

#### H. Data and mapping (administrator only)
- Source and sync status, with Remove connection.
- Upload QuickBooks exports, or import a summary CSV.
- **Account mapping and add-backs**, each add-back with its reason. "Below EBITDA" is flagged.
- Headcount.
- Months manager: lock a month, confirm it closed.
- **Restatements list**: months changed in the books after being reported, detected by a statement hash.
- "Before Merit ownership" months kept for reference.

### 1.2 Other reporting surfaces

| Surface | Audience | What it shows | Interactions | Source |
|---|---|---|---|---|
| **Home → Company snapshot** | all partners | The first four metric cards of the tab Financials opens on (trend cards skipped) | Customize show/hide | Same metric registry |
| **Waterfall calculator** (`/waterfall`) | finance and partners | Inputs: cash available, as-of date, event (operating / sale / liquidity), loan paid first, Net Sale Profit, tax-distribution credits, **up to N comparison amounts**. Outputs: stat tiles (cash, loan paid, distributed, tiers reached), **"Who receives what" stacked bars by holder × tier**, Checks, **Tier by tier**, **By holder**, **What clears each tier**, **Left outstanding after this distribution**, **Scenario comparison** (the same date at each amount) | Live recalculation as you type, then a 2-step "record distribution" that writes ledger entries | Cap table, capital ledger, preferred accrual engine (integer cents, largest-remainder rounding) |
| **Controls** (`/controls`) | partners | Debt, Transaction, Capex and Litigation **Thresholds** per entity, with a **used-vs-limit gauge** and linked resolutions. Related-party arrangements register with tiles (active, carved out, approved by disinterested vote) | Change threshold (step-up, audit) | Thresholds plus the debt schedule |
| **Board packet → Financial summary** (PDF and on screen) | Board | One page per company: "Data through", source and last sync, headline figures for the dashboard's period and comparison (with a budget column when approved), **Revenue and EBITDA by month (T12M)**, **balance sheet vs a year earlier**. **Frozen at notice**, so the packet of record never changes | Include or exclude companies per meeting, move the section | Metric registry (`periodFigure`) |
| **Board packet PDF** | Board | Server-rendered pdf-lib output: cover, contents with page numbers, bookmarks, running header, "Confidential. Partners only. Page X of Y", repeated table headers, keep-with-next | Download | Records |
| **Financials CSV export** (`/api/financials/export`) | insiders | Monthly figures, one row per entity per month, scope and range parameters, RLS-scoped, rate-limited, cutoff-respecting | Download | `financial_periods` |
| **Any chart → table / CSV / xlsx** | all | Every `ChartCard` has **View as table**, **Export CSV**, **Export Excel** | Toggle, download | The same `TableData` the chart drew |
| Calendar / compliance | Secretary | Reporting and compliance deadlines | n/a | OA rules |

**Narrative and AI.** There is **no AI commentary on the financials**. Every chart and card instead carries a **deterministic one-to-two sentence summary**, for example "Revenue was $X in Aug 2026, up 13.1% on Aug 2025. The trailing twelve months total $Y." or "EBITDA rose $X from … The largest step is gross margin (+$Y).". The sentence doubles as the chart's text alternative. AI in the portal is limited to loan-document term extraction, minutes and agenda drafting, and edit instructions.

**What the portal does not have** (openings for MeritBooks):
- no cash-flow statement;
- no forecast, projection or what-if on the P&L (only waterfall scenarios);
- no transaction-level drill below the account;
- no intercompany elimination (explicitly "combined, not consolidated");
- no AR/AP detail;
- no peer or industry benchmarks;
- no AI variance narrative;
- no scheduled or emailed report delivery.

---

## 2. What makes it feel rich (design patterns to copy)

1. **Every chart sits in one frame (`ChartCard`).** Title, basis line ("By month, Sep ’24 to Aug ’26, with the same month a year earlier and the TTM"), a plain-English summary sentence, an (i) definition the administrator can edit, **View as table**, **CSV/xlsx**, and a footer naming gaps or preliminary months. The table always prints under the chart.
2. **Context is always on the chart:**
   - the prior-year same month as a dashed line;
   - the budget as tick marks;
   - TTM in a synced sub-panel, never on a second axis;
   - preliminary months hatched;
   - unfavorable variance hatched;
   - one y-axis only, so dollars and percents are never mixed;
   - bars start at zero;
   - the series is Electric Blue and the comparison is Midnight;
   - every chart reads without colour (dash, hatch, direction).
3. **Refuses to invent.** Explicit states replace bad numbers:
   - Not enough history / Not on file / Not mapped / Not meaningful / No approved budget;
   - n/m rules (base ≤ 0, sign flip, base under 5% of current);
   - a start-up month under 5% of a typical month is excluded from margins;
   - a missing month is a gap, never zero.
4. **Semantic deltas:** "improvement / erosion", "favorable / unfavorable", margins in **points**, and arrow plus word plus colour.
5. **Period discipline:** one administrator-chosen basis and comparison per dashboard kind, a chip on every card, a fiscal-year-aware YTD/QTD, the TTM-to-TTM CAGR to remove seasonality, and a range switcher on every page.
6. **Governance of numbers:**
   - a release cutoff (the 20th rule) with administrator preview;
   - a "books closed through" date;
   - a restatement log;
   - EBITDA pinned to the reported Net Operating Income, so mapping never moves it;
   - "in portfolio from" gating;
   - packet figures frozen at notice.
7. **Curated, not configurable-by-everyone:** the administrator picks cards and order, renames tabs and sections, and edits definitions (page-text registry). Partners see a calm, finished product. Personal layout is allowed only on Performance and Home.
8. **Scope agility:** one server component renders any scope (entity, multi-select, portfolio, consolidated) with identical sub-tabs, ownership-weighted toggle, and shareable URLs.
9. **Investor-native analytics:** Rule of 40, CAGR ladders, EBITDA bridge, league table with sortable ranks, share-of-EBITDA bars, seasonality index, cash conversion cycle, look-through ownership, waterfall scenarios, maturity ladder.
10. **Craft:**
    - tabular numerals everywhere;
    - $K auto-scaling;
    - sticky columns;
    - "opens on latest month";
    - designed empty states with next action;
    - mobile layouts at 390px (screenshots for each feature at 1440 and 390);
    - print CSS (`data-print="hide"`);
    - aria tables behind every chart.

---

## 3. What MeritBooks must match or exceed

**Must match** (parity: partners will compare side by side):

| # | Item |
|---|---|
| M1 | A **metric-card catalogue** with at least the 37 portal cards (§1.1A), each with formula tooltip, period chip, semantic delta, sparkline, and explicit unavailable states. Administrator-curated per view kind; defaults as listed |
| M2 | **Period basis** (YTD / TTM / QTD / Month / Prior FY) and **comparison** (PY / Budget / Prior period / None) per dashboard, plus a **range switcher** (YTD / 12M / 24M / 3Y / 5Y / All) on every view, fiscal-year aware |
| M3 | **MonthlyCombo**-class charts: bars, dashed PY line, budget ticks, synced TTM panel, hatched preliminary months, rich tooltip with variance F/U |
| M4 | Analytic cards: **YoY table** (Month / FYTD / TTM, points for margins), **CAGR 1/3/5 (TTM-based)**, **Budget vs actual with VarianceBars**, **Margins (YTD / TTM / monthly switch)**, **EBITDA bridge waterfall (YTD / TTM)**, **Seasonality index**, **Working-capital days plus CCC**, **Revenue per employee** |
| M5 | Portfolio views: **combined roll-up**, **ownership-weighted toggle** (look-through), **share-of-revenue and share-of-EBITDA bars**, **sortable league table**, **Rule of 40 scatter**, **arbitrary multi-entity selection** via URL |
| M6 | **Statements by month**: as-reported and standard-line layouts, line → account drill, $ / $K, sticky columns, opens on latest months with Total, (P)/(S) markers, collapse |
| M7 | **ChartCard contract** on every chart: summary sentence, definition, View as table, CSV and **xlsx** export, printed table |
| M8 | **Debt**: tiles (outstanding, undrawn, WAR, next maturity), schedule, coming due, **maturity ladder**, balance trend, covenant status, AI term extraction with human confirm |
| M9 | **Equity and cap table**: classes × holders, ownership, voting donut, preferred accrual table, capital ledger, look-through ownership, as-of date, print. **Waterfall calculator with scenario comparison** (this belongs to Suite governance, but partners expect it beside FP&A) |
| M10 | **Holdings org chart** with per-entity figures, zoom, fit and print |
| M11 | **Governance of numbers**: release cutoff with administrator preview, books-closed-through, **restatement log**, "in portfolio from" gating, freshness card per entity, reporting-deadline tiles, packet figures frozen at notice |
| M12 | **Board-packet financial summary** (PDF): per company, headline vs comparison vs budget, T12M revenue and EBITDA, balance sheet vs a year earlier |
| M13 | **Approved-budget-only** comparison, budget versions, xlsx template round-trip, prior-year carry-forward |
| M14 | Design craft: one y-axis, colour-independent encodings, n/m rules, designed empty states, 390px layouts, print CSS. All in merit-ui (Syne / DM Sans, Electric Blue / Midnight) |

**Must exceed** (where owning the GL lets MeritBooks win):

| # | Item |
|---|---|
| X1 | **True consolidation with intercompany eliminations.** The portal can only say "combined, not consolidated". MeritBooks already has eliminations. Offer Combined, Consolidated (eliminated) and Ownership-weighted, with an elimination bridge |
| X2 | **Drill to the transaction.** Card → standard line → account → journal entry → source document (bill, invoice, bank txn). The portal stops at the account |
| X3 | **Cash-flow statement** (indirect and direct) and **13-week cash forecast**, both absent in the portal |
| X4 | **Forecast and scenarios**: rolling forecast, Actual + Forecast vs Budget, driver-based what-if (MeritBooks has `forecast/` and `fpna-nl-scenario`). Show forecast months as a distinct encoding beside the portal's hatched preliminary months |
| X5 | **AI variance narrative** grounded in GL facts, cited and checkable, layered on (not replacing) the deterministic summary sentences. The portal has none |
| X6 | **Live close status instead of a release-day rule**: period locks are real in MeritBooks, so "books closed through" is a fact, not a QuickBooks closing date |
| X7 | **AR/AP and working-capital detail** (aging, DSO by customer, collections), beyond the portal's ratio-only DSO and DPO |
| X8 | **Covenant compliance computed from the GL** (MeritBooks `covenants/`), with headroom trend and breach forecasting, where the portal shows a manually recorded status |
| X9 | **Scheduled report packs**: saved views and packs (MeritBooks has `saved-packs`, `report-compiler`) emailed monthly on close, rather than only on-demand PDFs |
| X10 | **Benchmarks**: peer or industry percentiles on margin, growth and DSO cards. The portal has internal comparison only |
| X11 | **Department, location and class dimensions**: profitability by dimension, which the portal cannot do because it has only entity-level statements |
| X12 | **Partner-safe audience mode**: a curated, read-only investor view of MeritBooks FP&A (administrator-picked cards, renamed sections, frozen packets), so the portal's reporting can be retired onto MeritBooks as the book of record |

**Orientation, not an audit.** A quick scan of MeritBooks today:
- `apps/web/src/app/(app)/fpna` has about 15 KPIs (including burn and runway), a gross-margin trend, a plan variance, NL scenarios and hand-drawn SVG charts;
- no Recharts-class chart system;
- no metric registry with formulas or unavailable states;
- no ChartCard table/xlsx contract.

The largest parity gaps are M1–M7 and M11. The suggested build order is: **metric registry → ChartCard plus chart kit → portfolio scope model → statements drill → governance (cutoff, restatements, freshness)**. Then layer X1–X5.

**Pointers into the bundle** (for builders; clone `mpp-minutes.bundle`):
- `src/features/financials/dashboard/metrics.ts` (catalogue)
- `src/features/financials/analytics.ts` (TTM, YoY, CAGR, bridge, seasonality, working capital, league, ownership)
- `src/components/charts/financial.tsx` and `static.tsx` and `chart-card.tsx`
- `src/features/financials/workspace/scope-page.tsx`, `model.ts`, `statement-grid.ts`
- `src/features/capital/waterfall.ts`
- `src/features/pdf/financial-summary.ts`
- `docs/WORKFLOW.md` §"Metric cards", §"EBITDA…trend cards"
- `docs/SPEC.md` §0026, §0027, §0032
- Screenshots: `docs/screenshots/{metric-cards,0034,financials,financial-summary}`
