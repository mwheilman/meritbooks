# Feature Product Brief — Financial Reporting & FP&A

**Module:** Financial Reports & FP&A (Books, Module 1 of 12) — **GATE 7**
**Author:** Auditor (Rule 13 FPB authorship)
**Date:** 2026-08-01 (Session 40 canon)
**Status of module today:** Functional — partial (Feature Completeness Ledger, Master Doc Part V.0). ZERO modules are Complete.
**Completion standard (Rule 13):** "Complete" ≠ renders/works/real-data. That is the *functional minimum*. Complete = **meets every dimension of this approved brief**, benchmarked against QBO/Sage Intacct with named deltas closed or explicitly deferred with reason, and every acceptance criterion below passing.

**Gate dependencies:** GATE 7 is OPEN. It consumes GATE 2 (deterministic posting engine, DONE) and overlaps **GATE 11a multi-entity consolidation (MANDATORY, top priority)**. Per CANON-ANCHOR §5, "no gate may start until its Prereq gates are DONE." Consolidation-with-eliminations (Dimension 5) is jointly owned by GATE 7 and GATE 11a and is spec'd fresh here under Rule 13.

---

## §0. Scope, grounding, and canon reconciliation

**What this module owns (canon-bound):**
- Books **owns the GL and every statement derived from it.** Reports are computed from `gl_entry_lines` joined to `gl_entries` where `status = 'POSTED'` — never from a cached rollup that can drift (CANON-ANCHOR §1, §3).
- **Account types are ASSET, LIABILITY, EQUITY, REVENUE, COGS, OPEX, OTHER — there is NO `EXPENSE` type** (CANON-ANCHOR §2). Cost is resolved by COGS/OPEX. Every statement section config must use these seven.
- **Debit/credit direction is derived mechanically from account TYPE / `normal_balance`** — never hard-coded per account (CANON-ANCHOR §3). The views do this correctly (`at2.normal_balance`); any route that keys off account-number *ranges* violates the "reference accounts by role, not number" rule (CANON-ANCHOR §2 — the COA template is 137 accounts, per-tenant, numbers not guaranteed).
- **Master data lives in `core`; the ledger in `public`. PostgREST CANNOT embed `core` from `public`** — stitch entity/dimension names in JS via `fetchCoreMap` (CANON-ANCHOR §2). `core.locations` is the entity list.
- RLS `org_id = get_org_id()` on every base table; **reports must run through the RLS-scoped `createServerSupabase()` client, not `createAdminSupabase()`**, or a report becomes a cross-tenant leak (this is a live defect — see Dimension 15).
- **Multi-entity consolidation is GATE 11a and MANDATORY:** consolidated statements must **net `is_eliminating` accounts to zero at the group roll-up** and apply ownership-% (CANON-ANCHOR §5; migration 015 `accounts.is_eliminating`; migration 035 intercompany; `lib/services/internal-invoices.ts` flags interdepartmental legs `is_eliminating = true`). **Canon amendment A2 (`PROPOSED-MASTER-DOC-AMENDMENTS.md`):** consolidation must also support **arbitrary tenant-defined grouping sets** (by industry, by ad-hoc selection), with the ownership tree as one built-in grouping — the generic-platform thesis, not just legal parent/subsidiary.
- All money is **bigint cents** (`formatMoney/dollarsToCents/centsToDollars`).

**Out of scope here (separate briefs):** AR aging / AP aging *analytics depth* (covered by the Invoices FPB Dimension 7 and a future AP FPB — the aging *views* `v_ar_aging`/`v_ap_aging` are referenced only as report surfaces); job profitability / WIP depth (GATE 6); sales-tax reporting (GATE 11d, deferrable). The internal-invoice elimination *engine* is built (migration 015, `internal-invoices.ts`); this brief owns how those eliminations **surface in consolidated statements**.

**Retired — do not touch:** chargeback/overhead/labor reporting (Cat 10 RETIRED). Not relevant; noted to prevent drift.

---

## §1. Sixteen-dimension brief

Each dimension states: **Purpose · What best-in-class does · Current MeritBooks state (built / partial / missing, cited to real files) · Named deltas · Testable acceptance criteria.**

---

### Dimension 1 — Statement coverage & correctness (P&L, Balance Sheet, Cash Flow, Trial Balance)

**Purpose:** The four core statements are the product. They must tie to the GL exactly, in every state, for any period and entity selection.

**Current state — BUILT (partial):**
- **Views exist** (migration 009): `v_trial_balance`, `v_income_statement`, `v_balance_sheet`, `v_gl_detail`, `v_cash_position`, `v_ar_aging`, `v_ap_aging`, `v_job_profitability`, `v_journal_entry_audit`. All derive sign from `account_types.normal_balance` — correct.
- **P&L:** `/api/reports/income-statement` re-aggregates from `gl_entry_lines` in JS (does NOT use `v_income_statement`), sections REVENUE/COGS/OPEX/OTHER, computes gross profit / EBITDA / net income + margins; UI `PnlReport` renders with drill-down and a group/account hierarchy. Multi-location filter honored.
- **Balance Sheet:** `/api/reports/balance-sheet` aggregates ASSET/LIABILITY/EQUITY as-of a date, subtype→group→account hierarchy, and returns `isBalanced` + `varianceCents`; UI shows a Balanced ✓ / Off-by badge.
- **Cash Flow:** `/api/reports/cash-flow` indirect method (operating/investing/financing, D&A add-back, working-capital changes), beginning/ending cash.
- **Trial Balance:** `/api/gl/trial-balance` + `TbReport`, debits/credits/net per account, Balanced ✓ badge, totals foot.
- **P&L by Month** (12-column), Changes in Equity, Equity Table, Debt Schedule also built.

**Named deltas / gaps:**
- **D1.1 — Dual source of truth.** The statement **views** (009) are largely **unused** by the API routes, which re-implement aggregation in JS. Two code paths that must agree can silently diverge (e.g. a view fix won't reach the report). Pick one authority (recommend: routes select from the views, or the views are dropped and the JS aggregation is the tested authority) and add a guard test that the two produce identical numbers on the harness dataset.
- **D1.2 — Cash Flow classifies by hard-coded account-number ranges** (`num >= '12000' && num < '13000'` for AR, `'15000'..'20000'` for fixed assets, etc.). This **violates CANON-ANCHOR §2** ("reference accounts by role, not hard-coded number"; COA is a 137-account per-tenant template with no guaranteed numbering). On any tenant whose COA doesn't match Merit's numbering, the cash-flow statement is silently wrong. Must resolve via account roles / `account_sub_type` / a cash-flow classification flag on the account.
- **D1.3 — Cash Flow is indirect-only.** No direct method; no reconciliation of the CF ending-cash to the Balance Sheet cash line or to `v_cash_position` (a controller expects CF ending cash to tie to the BS).
- **D1.4 — No statement-level tie-out assertions in tests.** BS balances and TB balances are shown in the UI but there is no guard test asserting Assets = L + E and Σdebits = Σcredits on posted data.
- **D1.5 — Retained earnings / current-year-earnings roll.** Confirm the Balance Sheet equity section includes current-period net income as an implicit Retained Earnings/CYE line; if net income is not rolled into equity, the BS will only "balance" by coincidence.

**Acceptance criteria:**
- AC1.1 For the harness dataset, P&L, BS, CF, and TB each render in loading / empty / populated / error states and tie to the GL: TB Σdebits = Σcredits; BS Assets = Liabilities + Equity (including CYE); CF ending cash = BS cash as-of the same date.
- AC1.2 A single authority produces each statement (view OR tested JS aggregator); a guard test asserts the two historical paths agree (or the redundant one is removed).
- AC1.3 Cash Flow classifies lines by account **role/subtype/flag**, not by number range; a tenant with non-Merit account numbers produces a correct CF (regression test with a re-numbered COA fixture).
- AC1.4 Every statement respects `status = 'POSTED'` only; draft/void entries never appear.

---

### Dimension 2 — Period selectors & fiscal calendar

**Purpose:** Every statement is meaningless without an explicit, correct period; a controller closes on a fiscal calendar, not a rolling window.

**Current state — BUILT:**
- `report-viewer.tsx` `PERIODS` presets: This/Last Month, This/Last Quarter, YTD, YTD-through-last-month, Last Year, Last 12 Months, Custom Range. Custom uses date inputs. P&L needs dates; BS/TB use as-of / no-date.

**Named deltas / gaps:**
- **D2.1 — Presets are calendar-based, not fiscal-period-based.** The org has real `fiscal_periods` (per location per month, with OPEN/SOFT_CLOSE/HARD_CLOSE). The report period picker does not let you pick "FY2026 P07" or "the last hard-closed period"; it computes ranges off `new Date()`. A book of record should report on fiscal periods.
- **D2.2 — No non-calendar fiscal year.** Assumes Jan–Dec; a tenant on a July FY start cannot get a correct "YTD" or "Last Year."
- **D2.3 — Comparative prior-period math is wrong (see Dimension 3).**

**Acceptance criteria:**
- AC2.1 The period picker offers fiscal-period selection (year + period) sourced from `fiscal_periods`, alongside the calendar presets, and honors a tenant fiscal-year-start setting.
- AC2.2 "Prior period" and "prior year" resolve from the selected period's fiscal calendar, not from `Date` arithmetic on today.
- AC2.3 An as-of report (BS, TB) defaults to the end of the most recent closed period and can target any historical period-end.

---

### Dimension 3 — Comparatives (period-over-period, prior year, budget-vs-actual)

**Purpose:** A number without a comparison is not FP&A. Controllers read variance, not absolutes.

**Current state — PARTIAL:**
- **P&L compare: BUILT but DEFECTIVE.** `PnlReport` has a `compare` toggle that fetches a prior period — but the prior period is hard-computed as **the calendar month before `start_date`** (`pe.setDate(pe.getDate()-1)` → first-of-that-month), regardless of the selected range. Comparing a *quarter* shows the quarter vs a *single prior month*. Wrong.
- **Budget vs Actual: BUILT.** `/api/budgets/vs-actual` merges `budgets` (013) with GL actuals, computes variance + favorable/unfavorable by type, totals by type.
- **BS compare:** the report catalog declares `hasCompare: true` for Balance Sheet, but `BsReport` implements no comparative column.

**Named deltas / gaps:**
- **D3.1 — Prior-period comparative is mis-computed** (always prior single month). Must compare like-for-like (prior period of equal length, or same period last year).
- **D3.2 — No prior-year (YoY) column** on P&L/BS.
- **D3.3 — Budget vs Actual is single-scenario** — ignores `budget_versions` (013), has no location roll-up beyond a single `location_id`, no % variance thresholds/heat, no drill from variance to the driving transactions.
- **D3.4 — No "% of revenue" common-size** column on the BS (P&L has a rough % column; BS has none).

**Acceptance criteria:**
- AC3.1 P&L comparative compares an equal-length prior period AND offers same-period-prior-year; the variance column math is unit-tested for month/quarter/year selections.
- AC3.2 Balance Sheet renders a prior-period-end comparative column with variance.
- AC3.3 Budget vs Actual honors an active `budget_version`, rolls up multiple locations, flags variances beyond a configurable threshold, and each variance row drills to the GL detail behind it.

---

### Dimension 4 — Department / dimension drill-down

**Purpose:** The canonical hierarchy is **Company → Department → Job**; each department owns a P&L/budget/FP&A (CANON-ANCHOR; Master Doc). Reports must filter and pivot by dimension.

**Current state — PARTIAL (schema-capable, UI-missing):**
- The income-statement route **accepts** `department_id` and `class_id` single filters; `gl_entry_lines` carries `department_id`, `class_id`, `item_id`, `location_id`; `v_gl_detail` exposes department/class/item names.
- The report catalog lists **P&L by Department** and **P&L by Class** report keys — but they route to the same `PnlReport` and the controls bar exposes **only Companies (locations) and Industries** multiselects. **There is no department or class selector in the UI**, so the dept/class P&L reports cannot actually scope by department.

**Named deltas / gaps:**
- **D4.1 — No department/class selector control** in `report-viewer.tsx` — the dimension P&L reports are non-functional as pivots (Rule 4: a report that can't take its defining parameter is a skeleton).
- **D4.2 — No departmental P&L matrix** (departments as columns, like P&L-by-Month is months-as-columns). QBO Classes / Intacct Dimensions produce a department-column P&L.
- **D4.3 — Dimension names not stitched from `core`** in the report layer (departments/classes live in `core`/`public` per migration 015/028 — confirm the source schema and stitch, not embed).

**Acceptance criteria:**
- AC4.1 The controls bar offers Department and Class multiselects (sourced from the dimension tables), wired to `department_id`/`class_id` on every P&L route.
- AC4.2 A "P&L by Department" matrix renders departments as columns with a Total column, each cell drilling to GL detail filtered by that department.
- AC4.3 Selecting a department filters P&L, and the numbers tie to a manual GL filter on that `department_id`.

---

### Dimension 5 — Multi-entity consolidation & eliminations (GATE 11a — MANDATORY)

**Purpose:** The defining enterprise feature: roll up multiple entities into one statement, **eliminating intercompany/interdepartmental activity so the group isn't double-counted**, with ownership-% and arbitrary groupings. This is the single most important delta vs QBO and the reason a PE operator chooses MeritBooks.

**Canon rule (binding):** Consolidated statements must **net `is_eliminating` accounts to zero at the group roll-up** (CANON-ANCHOR §5; migration 015). Eliminate the reciprocal Intercompany AR/AP (balance-sheet) positions and the interdepartmental services revenue/cost legs (both flagged `is_eliminating`), while **preserving genuine third-party costs** (an "expense paid on behalf" books a real expense on the receiving entity and must remain). Apply **ownership-%** for partial ownership. Support **arbitrary tenant-defined grouping sets**, with the ownership tree as one built-in grouping (amendment A2).

**Current state — PARTIAL / INCORRECT for GATE 11a:**
- `/api/reports/consolidated` returns a consolidated P&L (account × location matrix) and an `intercompany` block — but the **elimination is informational only**: it computes net Intercompany AR vs AP via `INTERCOMPANY_AR`/`INTERCOMPANY_AP` roles and reports `eliminatedCents`, explicitly **not reducing the P&L** (see the route's own comment). So the consolidated P&L still contains interdepartmental services revenue/cost that should net to zero.
- **No use of `is_eliminating`** in the consolidated route — the flag exists on accounts (015) and is set by `internal-invoices.ts`, but the report never nets those accounts out.
- **No ownership-% roll-up** (`parent_entity_id` / `ownership_pct` are GATE-2 seams, inert).
- **No consolidated Balance Sheet or Cash Flow** — only P&L.
- **No arbitrary grouping sets** (amendment A2) — consolidation is "all active locations" only; no industry group, no ad-hoc selection persisted as a reusable consolidation group.
- **No consolidation of the elimination/parent entity as its own column** and no eliminations column shown alongside entity columns (the standard Intacct layout: Entity A | Entity B | Eliminations | Consolidated).

**Named deltas / gaps:**
- **D5.1 — Eliminations are not applied to the statement.** `is_eliminating` accounts must net to zero in the consolidated P&L and BS; the current route leaves them in. This is a correctness gate for 11a.
- **D5.2 — No consolidated Balance Sheet / Cash Flow.**
- **D5.3 — No ownership-% (minority interest) roll-up.**
- **D5.4 — No Entity | Entity | Eliminations | Consolidated column layout** with an explicit eliminations column the auditor can inspect.
- **D5.5 — No arbitrary/user-defined consolidation groups** (amendment A2) — needs a `consolidation_groups` concept (group + member entities), with the ownership tree as one system group.
- **D5.6 — Consolidation toggle is a report, not a mode.** Best-in-class lets you flip *any* statement (P&L, BS, CF) into consolidated for a chosen group; here it's a single "Consolidated Statements" report.

**Acceptance criteria:**
- AC5.1 A consolidated P&L for a group nets every `is_eliminating` account to zero across the group (guard test: Σ of eliminating-account balances in the consolidated output = 0), while genuine third-party costs remain.
- AC5.2 A consolidated Balance Sheet eliminates reciprocal Intercompany AR/AP so they don't both appear, and the consolidated BS balances (Assets = L + E).
- AC5.3 The consolidated view renders an explicit **Eliminations column** between entity columns and the Consolidated total, and each elimination is traceable to its source entries.
- AC5.4 Ownership-% is applied for partially owned entities (minority interest surfaced).
- AC5.5 A tenant can define a consolidation group by arbitrary selection (and by industry), save it, and run any of P&L/BS/CF for that group; the built-in ownership-tree group is available without setup.
- AC5.6 Consolidation runs through the RLS-scoped client and never leaks entities outside the org.

---

### Dimension 6 — Drill-down to source (GL detail)

**Purpose:** Every reported number must be defensible to the transaction. A controller clicks a line and sees the entries.

**Current state — BUILT:**
- P&L, BS, and TB rows are clickable → `GlDrillDown` (`gl-drill-down.tsx`) with account + date range + location. `v_gl_detail` exposes entry number/date/type/memo, debit/credit, location/department/class/item names, attribution.

**Named deltas / gaps:**
- **D6.1 — Drill-down passes only `selectedLocs[0]`** ("first location"), so a multi-entity P&L drill shows only one entity's detail. Must pass the full location selection.
- **D6.2 — No drill from a *consolidated* or *budget-variance* figure** to its constituents.
- **D6.3 — No drill from GL detail down to the source document** (bill/invoice/payment) — `gl_entries.source_ref` exists (migration 056); the drill should link to the originating object.

**Acceptance criteria:**
- AC6.1 Drilling any statement line respects the full company/department/period selection and lists every contributing GL line.
- AC6.2 A GL-detail line links to its source document via `source_ref` where present.
- AC6.3 Consolidated and budget-variance figures drill to their constituent entries.

---

### Dimension 7 — Export (PDF / XLSX / scheduled delivery)

**Purpose:** Statements leave the app — to a board deck, a lender, a tax preparer. Export is table stakes.

**Current state — MISSING:**
- The Reports page header renders **Export** and **Schedule** buttons with **no `onClick`** and no handler; the per-report Export button likewise does nothing. No `xlsx`/`exceljs`/`@react-pdf` usage anywhere in the reports tree (grep-confirmed). Export is a **skeleton** (Rule 4/Rule 10 violation to call it built).

**Named deltas / gaps:**
- **D7.1 — No PDF export** of any statement (the invoice module has `@react-pdf/renderer` — reuse the pattern).
- **D7.2 — No XLSX export** (QBO/Sage export every report to Excel; controllers live in Excel).
- **D7.3 — No scheduled/emailed reports** despite a "Schedule" button.
- **D7.4 — No CSV** even as a minimum.

**Acceptance criteria:**
- AC7.1 Every statement exports to a branded PDF (tenant logo/accent, period, entity, generated-at, prepared-by) that matches the on-screen figures exactly.
- AC7.2 Every tabular report exports to XLSX with real cells (not an HTML dump), money as numbers, and a totals row; a controller can pivot it.
- AC7.3 The Schedule button configures a recurring report delivery (period + recipients) or is removed until built (no dead buttons — Rule 4).

---

### Dimension 8 — Native budgeting

**Purpose:** FP&A is a pillar. Budgets must be entered, versioned, and compared natively — not imported from a spreadsheet each month.

**Current state — PARTIAL (schema + read, no authoring UI):**
- `budgets` + `budget_versions` tables (013), unique on (org, location, account, department, fiscal_year, period_number), 13 periods. `/api/budgets/vs-actual` reads them.
- **No budget-entry UI** found (no `/budgets` authoring page located); budgets appear to be seed/manual-SQL only, so "native budgeting" is not usable by a tenant.

**Named deltas / gaps:**
- **D8.1 — No budget authoring screen** (enter/import per account × period × department; copy-last-year; spread-annual-evenly; growth-% seed).
- **D8.2 — `budget_versions` unused** — no create/activate/compare-versions workflow (original vs revised vs forecast).
- **D8.3 — No budget import** (paste/CSV from Excel).
- **D8.4 — No department/job budgets surfaced** even though the schema supports `department_id`.

**Acceptance criteria:**
- AC8.1 A budget-entry grid lets a tenant enter/edit budget by account × period (× department), with copy-prior-year, even-spread, and growth-seed helpers; writes to `budgets` under the active `budget_version`.
- AC8.2 A tenant can create, name, and activate budget versions and compare two versions.
- AC8.3 Budget import accepts a CSV/paste and validates account/period before commit.
- AC8.4 Budget-vs-actual (Dimension 3) reads the active version and supports department scope.

---

### Dimension 9 — Scenario modeling & forecasting (FP&A depth)

**Purpose:** The FP&A pillar and a "BEAT QBO" surface: driver-based scenarios, rolling forecasts, what-ifs — the reason a CFO doesn't need a separate FP&A tool.

**Current state — MISSING:**
- No scenario engine, no rolling forecast, no driver model. The 13-Week Cash Forecast (session 40) exists as a **separate cash pipeline** (`/forecast`), not integrated into the statements/FP&A reporting surface.

**Named deltas / gaps:**
- **D9.1 — No scenario modeling** (base/upside/downside; assumption drivers; sensitivity).
- **D9.2 — No rolling forecast** (actuals-to-date + forecast-remaining = full-year view).
- **D9.3 — The 13-week cash forecast is siloed** from the P&L/BS forecast and from budgeting.
- **D9.4 — No AI-assisted forecast** (the AI pillar — propose a forecast from trend + drivers, human approves).

**Acceptance criteria:**
- AC9.1 A tenant can create named scenarios with adjustable drivers (revenue growth %, headcount, margin) and view a full-year projected P&L per scenario.
- AC9.2 A rolling forecast blends closed-period actuals with forecast for open periods and reconciles to the annual budget.
- AC9.3 The cash forecast integrates with the P&L/BS forecast (one FP&A model, consistent assumptions).
- AC9.4 AI proposes a forecast (with rationale, logged to the Decision Log) that a human accepts/edits; AI never commits a forecast unreviewed (CANON-ANCHOR §3).

---

### Dimension 10 — Cash-basis vs accrual & report-basis correctness

**Purpose:** Small businesses file cash-basis; the same book must produce both. Correctness here is a compliance matter.

**Current state — PARTIAL:**
- P&L route supports `basis=cash` by filtering to GL entries that have a matched cleared `bank_transactions` row (APPROVED/CATEGORIZED/RECONCILED). UI exposes Accrual/Cash toggle on reports flagged `hasBasis`.

**Named deltas / gaps:**
- **D10.1 — Cash basis only on P&L** — no cash-basis Balance Sheet (AR/AP should drop out on a cash-basis BS).
- **D10.2 — Cash-basis logic is heuristic** (depends on bank-txn match state) rather than a defined cash-basis conversion; unverified against a hand-built expectation.
- **D10.3 — Basis is a per-report toggle, not a tenant default** — a cash-basis tenant must flip it every time.

**Acceptance criteria:**
- AC10.1 Cash basis is offered on P&L and BS, with a documented, tested conversion (AR/AP and other accruals removed) verified against a hand-computed fixture.
- AC10.2 A tenant reporting-basis default drives the initial toggle state.
- AC10.3 A guard test asserts accrual and cash bases reconcile by exactly the accrual adjustments on the fixture.

---

### Dimension 11 — QBO / Sage Intacct / best-in-class benchmark (Rule 14, NAMED DELTAS)

**Purpose (Rule 14, mandatory):** Itemize what the market leaders do that MeritBooks must **match** or **beat**. QBO is the SMB bar; **Sage Intacct is the multi-entity/FP&A bar** and the real competitor for MeritBooks' target operator. MeritBooks' differentiation is native consolidation-with-eliminations + AI FP&A on a true book of record.

| # | Capability | QuickBooks Online | Sage Intacct | MeritBooks today | Verdict |
|---|---|---|---|---|---|
| B1 | Core statements (P&L, BS, CF, TB) | Yes | Yes (deep) | Yes — 4 statements built (D1.1 dual-source, D1.2 CF number-range bug) | **MATCH** (fix correctness) |
| B2 | Fiscal-period reporting & custom FY | Yes | Yes | Calendar presets only, Jan–Dec assumed (D2.1/D2.2) | **MATCH** |
| B3 | Period-over-period & prior-year comparatives | Yes | Yes | P&L compare defective; no YoY; BS none (D3.1/D3.2) | **MATCH** |
| B4 | Budget vs Actual w/ versions | Yes | Yes (strong) | Single-scenario, no version workflow, no authoring UI (D3.3/D8) | **MATCH** |
| B5 | Departmental / dimensional P&L | Classes (basic) | Dimensions (best-in-class) | Schema-capable, **no UI selector** (D4.1) | **BEAT** (dimensions native) |
| B6 | **Multi-entity consolidation w/ eliminations** | Weak (no true consolidation) | **Yes — the flagship** | Informational only, no `is_eliminating` netting, P&L-only (D5) | **BEAT** — the moat, once correct |
| B7 | Ownership-% / minority interest roll-up | No | Yes | No (D5.3) | **BEAT** |
| B8 | Arbitrary/user-defined consolidation groups | No | Partial (entity groups) | No (D5.5, amendment A2) | **BEAT** |
| B9 | Export to PDF / Excel | Yes | Yes | **None — dead buttons** (D7) | **MATCH** (build) |
| B10 | Scheduled/emailed reports | Yes | Yes | No (D7.3) | **MATCH** |
| B11 | Drill-down to transaction & source doc | Yes | Yes | Statement→GL yes; source-doc + multi-entity drill gaps (D6) | **MATCH** |
| B12 | Cash vs accrual basis | Yes | Yes | P&L only, heuristic (D10) | **MATCH** |
| B13 | Rolling forecast / scenario FP&A | Add-on (weak) | Add-on (Intacct Planning) | None (D9) | **BEAT** — native AI FP&A |
| B14 | Custom report builder / saved reports | Yes (custom) | Yes | Fixed catalog + NL search box (non-functional) | **MATCH** (defer-able) |
| B15 | AI narrative / variance explanation | Emerging | Emerging | NL "Ask for any report" box is decorative (D14) | **BEAT** — AI variance narrative |
| B16 | Report-level access control | Yes (roles) | Yes (roles) | **Reports bypass RLS via admin client** (D15) | **MATCH** (must fix — security) |

**Where MeritBooks must BEAT (the moat):** native **consolidation-with-eliminations + ownership-% + arbitrary groups** (B6/B7/B8 — Intacct's flagship, absent in QBO); **native dimensional reporting** (B5); **AI-native FP&A** — scenario/rolling forecast + a plain-language report composer and variance narratives, all human-approved and audited (B13/B15). Parity items (B1–B4, B9–B12, B16) are table stakes to reach "Complete." **B16 is also a security defect**, not just a parity gap.

---

### Dimension 12 — Roll-up module-level acceptance gates

Beyond the per-dimension ACs, Financial Reporting is **Complete** only when:
- **AC-M1** Guard tests assert, on the PGlite migration-replay harness, that TB balances, BS balances (incl. CYE), and CF ending cash ties to BS cash — on posted data.
- **AC-M2** A guard test asserts consolidated `is_eliminating` accounts net to zero (AC5.1) and that consolidation runs RLS-scoped (no admin client).
- **AC-M3** A guard test asserts the Cash Flow classifier works on a re-numbered COA fixture (no account-number-range dependence).
- **AC-M4** Every report renders loading / empty / populated / error; no dead buttons (Export/Schedule either work or are removed) (Rules 3–5).
- **AC-M5** Every report route runs through `createServerSupabase()` (RLS), verified by a tenant-isolation test across reports (AC15).
- **AC-M6** No route classifies or signs by hard-coded account number (Rule 11 / CANON-ANCHOR §2) — verified by review + the D1.2 regression test.

---

### Dimension 13 — Data model changes required to reach Complete

Spec, not code — migrations serialize through the lead (Supabase first):
1. **Cash-flow classification** on accounts — a `cash_flow_category` (OPERATING/INVESTING/FINANCING/CASH) column or a role mapping, replacing number-range logic (D1.2). Seed the template COA.
2. **`consolidation_groups`** + **`consolidation_group_members`** (`public`, org-scoped, RLS) — user-defined groups; the ownership tree is a system group (D5.5, amendment A2). Touches the FROZEN entity contract at the read layer only — REPORT to the lead; do not mutate the entity shape.
3. **Ownership-% surfacing** — read `ownership_pct`/`parent_entity_id` seams (already on the entity record) into consolidation (D5.3).
4. **`budget_versions` activation** flag usage + a budget-authoring path (no new table needed; wire 013).
5. **Report-basis / fiscal-year-start** tenant settings (D2.2, D10.3).
6. **Scenarios** — a `forecast_scenarios` + `forecast_assumptions` model (D9) if scenario modeling is in the first Complete (else defer with reason).
7. **Decision-Log rows** (`public.ai_decisions`) for any AI-proposed forecast/narrative (Dimension 14).

All new tables: `org_id` + RLS `org_id = get_org_id()`, cents = bigint, idempotent migration, guard tests. Reference accounts **by role, not number**.

---

### Dimension 14 — AI behavior (the FP&A pillar, all human-approved)

**Purpose:** AI does the analytical labor; staff supervise; leaders verify (CANON-ANCHOR §1).
- **Plain-language report composer:** the "Ask for any report…" box (currently decorative) should resolve a natural-language request to a report + period + entity/dimension selection — **proposing the query, not inventing numbers**.
- **Variance narratives:** AI drafts the "why" behind a P&L/budget variance ("OPEX +18% driven by a one-time legal accrual in Dept X"), citing the driving entries — advisory, human-published.
- **Forecast proposals:** AI proposes a rolling forecast/scenario from trend + drivers (Dimension 9), human accepts/edits.
- **Guardrails (VIII.7):** advisory by default; every AI action → Decision Log (`public.ai_decisions`); AI **never writes GL and never alters a reported figure**; ask ONE disambiguating question when ambiguous; non-standard GAAP flagged. AI routes only through `@meritbooks/core-ai` (metered to `core.ai_usage_log`; tenant budget enforced across the suite — CANON-ANCHOR §2).

**Acceptance:** AC14.1 the NL composer maps a request to a real report configuration and never fabricates figures; AC14.2 every AI narrative/forecast is logged with inputs + rationale and is human-approved before publish; AC14.3 no AI path holds an Anthropic key or calls the API directly.

---

### Dimension 15 — RBAC & data-access security (RLS integrity)

**Purpose:** Financial statements are the most sensitive surface in the product; a report that bypasses tenant isolation is a fintech-grade breach.

**Current state — DEFECT:**
- `/api/reports/cash-flow`, `/api/budgets/vs-actual`, `/api/close`, `/api/reports/consolidated` (via patterns) use **`createAdminSupabase()` (RLS bypass)** with only best-effort `auth().catch(() => null)`. On a book of record this is a **cross-tenant leak risk** — a report could return another org's numbers if `org_id` isn't hand-filtered on every query (several of these rely on hand-filtering, which is exactly the fragile pattern RLS exists to remove).
- Report **RBAC is not enforced** — no permission gate on who can view financials; nav shows all (consistent with the standing NO-GO RBAC gate, task #9).

**Named deltas / gaps:**
- **D15.1 — Reports must use `createServerSupabase()` (RLS)**, not the admin client (CANON-ANCHOR §2; the reconciliation routes already do this correctly and are the reference).
- **D15.2 — No `reports:view` / `financials:view` permission gate** (`lib/rbac/permissions.ts`) — sensitive statements should be role-gated; consolidation/entity-wide views to elevated roles.
- **D15.3 — `canApprove`/identity still on the `core.employees.role` stopgap** — any report authorization must reconcile to `core.users/memberships/roles` (CANON-ANCHOR §3, task #27), not a Books-private rule.

**Acceptance criteria:**
- AC15.1 Every report route runs through the RLS-scoped client; a tenant-isolation test proves org B never sees org A's statements (extend `tenant-isolation.test.ts` to the report routes).
- AC15.2 Report/financial visibility is permission-gated and reconciled to `core` identity; denied requests return the standard `permissionDenied`.
- AC15.3 No report path uses `createAdminSupabase()` except where intentional and documented (and then never returns cross-tenant data).

---

### Dimension 16 — Current-state ledger row (Rule 15)

| Dimension | State | Evidence |
|---|---|---|
| 1 Statement coverage | 🔶 Partial | 009 views + P&L/BS/CF/TB routes; dual-source + CF number-range defects |
| 2 Period selectors | 🔶 Partial | `PERIODS` presets; no fiscal-period/custom-FY selection |
| 3 Comparatives | 🔶 Partial | P&L compare defective; BVA single-scenario; BS none |
| 4 Dept drill-down | 🔶 Partial | routes accept `department_id`; **no UI selector** |
| 5 Consolidation/eliminations | ❌ Defect | informational only; no `is_eliminating` netting; P&L-only (GATE 11a) |
| 6 Source drill-down | 🔶 Partial | statement→GL built; multi-entity + source-doc gaps |
| 7 Export | ❌ Missing | dead Export/Schedule buttons, no PDF/XLSX |
| 8 Native budgeting | 🔶 Partial | tables + read; no authoring UI; versions unused |
| 9 Scenario/forecast | ❌ Missing | no scenarios/rolling forecast; 13-wk cash siloed |
| 10 Cash vs accrual | 🔶 Partial | P&L only, heuristic |
| 11 Benchmark | — | see Dimension 11 |
| 15 RBAC/RLS | ❌ Defect | reports use admin client; no report RBAC |

Overall: **Functional — partial.** Not Complete. The two red items — **consolidation eliminations (D5, GATE 11a)** and **RLS-bypassing report routes (D15)** — are the highest-severity.

---

## §2. Build sequence — Functional-partial → Complete

Strictly ordered; each slice behind the wave pipeline (FPB → disjoint slices → builder wave → verifier + chrome-auditor + security for money/identity → reviewer → integrate → scribe). Migrations to Supabase first.

**Wave A — Correctness & security (blockers, do first):**
1. **Move every report route to the RLS-scoped client** (`createServerSupabase()`), drop `createAdminSupabase()` from cash-flow/budgets/close/consolidated; add the tenant-isolation test across reports (D15, AC15/AC-M5). *Highest priority — a leaking statement is a breach.*
2. **Fix the Cash Flow number-range classifier** → account role/subtype/`cash_flow_category`; re-numbered-COA regression test (D1.2, AC1.3/AC-M3).
3. **Resolve the dual-source ambiguity** (views vs JS) and add the tie-out guard tests: TB balances, BS balances incl. CYE, CF↔BS cash (D1.1, AC1.1/AC-M1).

**Wave B — Consolidation & eliminations (GATE 11a, MANDATORY, the moat):**
4. **Apply `is_eliminating` netting** to the consolidated P&L and add a **consolidated Balance Sheet**; render the **Eliminations column** (D5.1/D5.2/D5.4, AC5.1–AC5.3/AC-M2).
5. **Ownership-% roll-up** (minority interest) (D5.3, AC5.4).
6. **`consolidation_groups`** (arbitrary + industry + built-in ownership tree); make consolidation a *mode* on any statement (D5.5/D5.6, AC5.5, amendment A2).

**Wave C — Comparatives, dimensions, drill-down:**
7. **Fix P&L comparatives** (equal-length prior period + YoY) and add a **BS comparative column** (D3.1/D3.2).
8. **Department/Class selector + P&L-by-Department matrix** (D4.1/D4.2, AC4).
9. **Drill-down**: full multi-entity selection + source-document links via `source_ref` (D6).

**Wave D — Export & budgeting (table stakes):**
10. **PDF + XLSX export** on every statement; wire or remove Schedule (D7, AC7).
11. **Budget authoring UI + versions** (grid entry, copy/seed/import, activate versions); wire BVA to the active version + department scope (D8/D3.3).

**Wave E — FP&A depth & AI (the pillar / BEAT):**
12. **Cash-basis Balance Sheet + tenant basis default + fiscal-period/custom-FY reporting** (D10, D2).
13. **Scenario modeling + rolling forecast**, integrating the 13-week cash forecast into one FP&A model (D9).
14. **AI: NL report composer (make it real) + variance narratives + forecast proposals**, human-approved, Decision-Logged (D14).

**Deferred with reason (not required for first Complete):** custom report builder / saved custom reports (B14 — fixed catalog is sufficient); sales-tax reporting (GATE 11d); direct-method cash flow (indirect is standard). State each deferral in the Ledger.

---

## §3. Definition of Complete for this module

Financial Reporting & FP&A is **Complete** when: every Wave A–D slice ships and passes its acceptance criteria; the module-level gates AC-M1…AC-M6 are green; **GATE 11a consolidation-with-eliminations (Wave B) is demonstrated, not asserted** (eliminating accounts net to zero, consolidated BS balances, RLS-scoped); every Rule-14 benchmark row is MATCH-or-better (or explicitly deferred with reason in the Ledger); and the verifier + security agents confirm TRUTH against the deployed app and live Supabase (no admin-client report routes, tenant isolation proven). Wave E raises it toward **Verified**. Until then the Ledger row stays **Functional — partial**.

---

## §4. Amendment A-3A (2026-10-24) — Wave 3A: shared report engine + core statements

**Source:** `docs/audit-2026-10/FEATURE-GAP-AUDIT.md` §4.1–4.2, §3 RP-01…RP-08/RP-10/RP-16, §6.3 Wave 3;
`E-REPORTING-BENCHMARK.md` §1 (A1–A17), §3 (universal contract), §4 (U4, U13, U17);
`D-PARTNER-PORTAL-REPORTING.md` M2, M6, X1, X2, X3, X11. Migration **185**. Engine contract:
`docs/report-engine-api.md` (consumed by 3B metrics, 3C charts, 3D governance, 3E flux).

**What changes.** Every core statement is a *definition* rendered by one engine
(`apps/web/src/lib/reports/engine/**`) over one maintained balances store
(`public.period_balances`). §0's "never from a cached rollup that can drift" is honoured by
construction: the store is maintained **inside the posting transaction** by triggers on
`gl_entries` / `gl_entry_lines` (not refreshed later), it can be rebuilt from the GL at any time,
and a tie-out guard (test + admin endpoint) proves `Σ period_balances = Σ POSTED gl_entry_lines`
per org × company × month × account. If the guard ever fails the report says so (it never
silently serves a drifted figure).

### A-3A acceptance criteria (testable; each maps to a test or a visible behaviour)

**Balances store (185)**
- **AC3A.1** Posting an entry (header POSTED, then its lines) adds exactly its debits/credits to
  `period_balances` for (company = line `location_id`, account, month of `entry_date`, department,
  class, job, item, counterparty company, entry kind). *Test:* `period-balances.test.ts`.
- **AC3A.2** Voiding (POSTED → VOIDED) removes the entry's contribution; re-dating a POSTED entry
  moves it between months; a header delete in the purge path removes it; a PENDING/DRAFT entry never
  contributes. *Test:* same file.
- **AC3A.3** `public.period_balances_tieout()` returns zero rows after post / void / re-date /
  backfill; `public.rebuild_period_balances(org)` reproduces the incremental store exactly.
  *Test + endpoint:* `GET /api/reports/engine/tie-out` (reports:view).
- **AC3A.4** Members can SELECT only their org's rows (RLS) and only their clients' rows when
  client-scope is enforced (163 restrictive policy applies — the table carries `location_id`);
  no member can INSERT/UPDATE/DELETE the store (service-role / trigger only).
- **AC3A.5** Backfill: the migration populates the store from every existing POSTED line.

**Engine (pure core + DB adapter)**
- **AC3A.6** Period engine: month, quarter, year, MTD, QTD, YTD, TTM and custom ranges, fiscal-year
  aware (org/company `fiscal_year_start_month`); columns single / by month / by quarter / by year.
- **AC3A.7** Comparisons: prior period (equal length), prior year (same span shifted 12 months),
  budget (`budgets`), forecast (closed months actual + open months budget), several at once; each
  with $ variance, % variance and F/U by account type (revenue up = F, cost up = U); margins compare
  in points.
- **AC3A.8** Column splits by company, department, class, job, location (company), each with
  Unassigned + Total; Total column = Σ split columns exactly.
- **AC3A.9** Subtotals tie: every subtotal = Σ of its rows in cents, in every column (asserted by
  the engine — a non-tying total throws in tests).
- **AC3A.10** Rounding ($ / $K / $M) is presentation-only and **drift-free**: displayed subtotals are
  computed from unrounded cents then rounded (documented in the API doc; the footer states
  "Rounded; totals computed before rounding"). The CSV/XLSX export carries full cents.
- **AC3A.11** Common-size: every P&L line as % of revenue, every BS line as % of total assets.
- **AC3A.12** Basis: ACCRUAL from the store; TAX/CUSTOM layer `reporting_basis_adjustments`
  (signed natural deltas, mig 147); CASH reuses the proven cash conversion for P&L-type statements.
  The basis is stated on every report.
- **AC3A.13** Consolidation: companies → combined → **Eliminations column** → consolidated, using
  the existing pure engine (`lib/consolidation/consolidate.ts`; `is_eliminating` accounts + the
  INTERCOMPANY_AR/AP roles with counterparty inside the group). Eliminations are explicit lines;
  consolidated BS balances. *Test.*
- **AC3A.14** Drill: every account cell carries a drill key; `POST /api/reports/engine/drill`
  returns the GL lines for exactly that key and **their sum equals the cell amount to the cent**
  (*test*), paginated, each line linking to its journal entry and source document.
- **AC3A.15** Client scope: a request that names an out-of-scope company is refused (403) under
  `enforce` and logged under `shadow`; "all companies" resolves to the caller's scope. *Test.*
- **AC3A.16** Performance: 24 months × 10 companies of activity in PGlite computes an income
  statement by month in < 3 s and a balance sheet by company in < 3 s. *Test.*

**Statements on the engine (R1–R14 of the gap audit §4.2)**
- **AC3A.17** Income statement (standard, % of revenue, PP/PY/budget); P&L by month (12/24 +
  total + TTM column); P&L by quarter / year; P&L by department / class / job / location (real
  dimension columns — fixes the mislabelled stubs); P&L by company side by side (+ eliminations +
  consolidated); comparative with $/% change; common-size P&L/BS; budget vs actual with F/U.
- **AC3A.18** Balance sheet (as of; comparative; by company; consolidated) always balances:
  A = L + E including "Retained earnings — prior years (not yet closed)" and "Net income (current
  year)". *Test.*
- **AC3A.19** Cash flow (indirect) for **any set of companies** — fixes "first company only".
  Classification by type / sub-type / role / bank flag (never number ranges); Δ cash on the
  statement = Δ cash on the balance sheet across multiple companies. *Test.* Direct method stays on
  the existing route.
- **AC3A.20** Statement of changes in equity (opening + activity by account + net income = closing,
  ties to BS equity); trial balance worksheet (unadjusted / adjusting / adjusted, debits = credits);
  GL detail (paginated, no 200-row cap, running balance, drill to source).
- **AC3A.21** Closing entries (entry_type CLOSING) are excluded from P&L activity and included in
  balance-sheet balances, so a closed year's P&L is not zeroed.

**Viewer (merit-ui v2.3)**
- **AC3A.22** Report library: search, categories, favourites, recently run (server-side,
  per user). Old `/reports?report=<key>` URLs keep working.
- **AC3A.23** One viewer for every engine statement: period picker, compare picker (multi),
  columns/dimension picker, basis, rounding, show-zero-rows, collapse/expand groups, sticky header +
  first column, row drill to a GL side panel → journal entry → source, export CSV/XLSX/PDF, save view
  (`report_views`), schedule to a pack (existing packs), print layout. Loading / empty (with why) /
  populated / error-with-retry / partial-period warning. Keyboard: `j/k` row, `Enter` drill, `[`/`]`
  collapse/expand all, `Esc` close panel. Density by role (cockpit for staff, report for owners).
- **AC3A.24** Custom row designer (MVP): tenant layouts with header / account-range / group / role /
  subtotal / formula (row refs) / spacer rows and per-row sign; saved per tenant
  (`report_layouts`, 185); usable as the layout of any P&L or BS statement. Formula rows evaluate
  deterministically; a circular reference is rejected on save.

**Governance hook (3D)** — the engine calls `applyGovernance(view, ctx)` on every result before it
is returned; Wave 3A ships an identity implementation; 3D replaces it (release cut-off, books closed
through, restatement snapshot, draft watermark).

**Wave 3 integration (A-3A.1, 2026-10-24)**
- **AC3A.25 Pre-acquisition exclusion before aggregation.** Governance decides each company's
  in-group window for the caller and scope before any figure is summed; the income statement,
  balance sheet, cash flow and changes in equity leave months outside the window out (flows by
  month; balances by the as-of month), the balance sheet still balances, current-year net income
  equals the group P&L (pre-joining earnings sit in prior equity), the cash flow shows "Cash of
  companies joining (leaving) the group" and still ties to balance-sheet cash, changes in equity
  carries a joining column and still ties per row, and every drill reproduces its cell.
  TB / GL summary stay unwindowed. *Test:* `report-engine.test.ts` "in-group windows";
  `governance/engine-adapter.test.ts` "windowsFromDecision".
- **AC3A.26 Subtotals drill.** Gross profit, operating income, net income, total assets and total
  liabilities open their GL lines; the drill sums to the cell. *Test:* "drill reproduces the cell".
- **AC3A.27 One source of numbers.** 3B metrics (`createMetricSource`) and 3E flux ending balances
  (`periodBalanceFluxSource`) read the same store as the statements, with a ledger fallback only
  when the store is not deployed. *Test:* "Wave 3 consumers read the balances store".
- **AC3A.28 Governance is visible.** The viewer shows "Books closed through …", Preview /
  Preliminary, "N columns not released" and the governance banner; the period picker offers This
  month, Last month, QTD, Last quarter, YTD, Last fiscal year, TTM, custom (and "End of …" for
  point-in-time statements), isolated as `PeriodControl` for the shared picker swap.

**Deferred (with reason):** ownership-weighted (look-through %) scope → 4A; saved dimension groups
→ 4A; standard-lines EBITDA bucket mapping UI → the row designer covers it; live-formula XLSX →
existing exporter (values) until 4D; share links → 4D.

---

## §5. Amendment A-3E (2026-10-24) — Wave 3E: flux analysis with materiality + the close gate

**Audit rows:** CL-05 (flux / variance analysis with materiality + required explanations before
sign-off — MISSING, P0) and CL-03 (period close gate + manager override — PARTIAL, P0)
(`docs/audit-2026-10/FEATURE-GAP-AUDIT.md` §3, §6.3 Wave 3E). Benchmark: `E-REPORTING-BENCHMARK.md`
H1 / U11 / AI2 / AI10 — Rillet (materiality by $ and %, AI explanation per flagged variance) and
Campfire (drafted flux commentary with human approval + audit trail). **Our delta past both:** the
explanation is a *gate* on HARD_CLOSE (not a report), preparer ≠ reviewer is enforced by the database,
every figure in an AI draft must trace to a supplied line or the draft is refused, and balance-sheet
flux is first-class (Rillet lists BS flux as in progress).

**Migration 187** (`187_flux_review.sql`): `flux_materiality_policies`, `flux_explanations`,
`flux_reviews`. Members read their org; the service role writes after the route's permission check
(the 184 pattern). Client-scope RLS re-applied. No GL effect — flux never writes the ledger and never
changes `fiscal_periods`; the period lock (`enforce_period_lock`) is untouched.

### A-3E.1 Materiality policy (per company, tenant default)
- Row per company (`location_id`) or a tenant default (`location_id` NULL); company row wins; no row ⇒
  built-in default **$5,000 OR 10%, prior month, review required**.
- `threshold_mode`: `EITHER` (breach on $ or %), `BOTH` ($ and %), `ABS_ONLY`, `PCT_ONLY`.
  `abs_threshold_cents` (bigint) and `pct_threshold_bps` (1000 = 10%).
- `comparison_basis`: `PRIOR_MONTH` · `PRIOR_YEAR_MONTH` (same month last year) · `BUDGET` (P&L lines
  vs `budgets` for the month; balance-sheet lines fall back to prior month and say so) ·
  `TRAILING_3_AVG` (mean of the prior three months, integer cents, half-away-from-zero).
- `overrides` (≤ 100): `{scope: TYPE|GROUP|ACCOUNT, key, absThresholdCents?, pctThresholdBps?, mode?,
  excluded?}`. Precedence **ACCOUNT > GROUP > TYPE > policy**; an override may exclude.
  `excluded_account_ids` excludes accounts outright. `include_balance_sheet` / `include_pnl` toggles.
- `dimension`: `ACCOUNT` (default) · `ACCOUNT_DEPARTMENT` · `ACCOUNT_CLASS` — flux lines per account
  or per account × department / class.
- `review_required = false` ⇒ the flux close task passes as "No flux review for this company".
- **Amounts:** P&L lines compare period *activity*; balance-sheet lines compare *ending balances*. All
  figures are signed in the account's normal balance (`normalBalanceFor`), bigint cents. The % change is
  `change / |comparison|` in basis points, and **null when the comparison is 0** (a %-only test can't
  breach on a zero base; `EITHER` still breaches on $; `BOTH` falls back to the $ test alone).

### A-3E.2 Flux list (Close → Flux review)
Every in-scope account (or account × dept/class) for the closing month with: current, comparison,
change $ / %, the threshold that applied (and where it came from), a 6-month trailing series
(sparkline-ready), status (`UNEXPLAINED` · `DRAFT` · `EXPLAINED` · `REVIEWED` · `STALE`), and
**drivers** for every material line: the largest lines, **new counterparties** (a vendor/customer with
activity this month and none in the comparison window), **one-offs** (counterparty/memo not seen in
the trailing three months), **reclasses** (manual/adjusting entries whose every leg is on the same
statement and touches no cash account), and the counterparty decomposition of the change. Each driver
drills to its journal entry (`/journal-entries?id=`); the panel drills to the account's GL detail.

### A-3E.3 Explanations + review (SoD)
- An explanation = text (≥ 10 chars), category (`TIMING` · `ONE_TIME` · `VOLUME` · `PRICE` ·
  `RECLASS` · `ERROR_CORRECTED` · `EXPECTED`), optional attachment (`documents` row), preparer.
- The server **re-computes the line and snapshots** current / comparison / change at submit — the
  client never supplies a figure.
- Reviewer sign-off: **preparer ≠ reviewer** (route check AND a DB CHECK). Reviewer may send back with
  a note (→ `DRAFT`).
- **Staleness:** a submitted/reviewed explanation is `STALE` when the live change moved by
  ≥ max($100, 5% of the explained change) since the snapshot — it no longer counts toward the gate
  and must be re-submitted and re-reviewed.
- **AI draft:** "Draft with AI" sends ONLY the deterministic driver facts through `runAiGateway`
  (feature `FLUX_EXPLAIN`). The draft must cite driver ids from the supplied list; **every $ amount in
  the text must equal a supplied figure** or the draft is refused and the driver summary is returned.
  The draft is never saved by itself — it becomes an explanation only when a person edits/accepts and
  submits (`drafted_by_ai`, `ai_decision_id` recorded; the decision is marked APPROVED on accept). AI
  down (no key / org disabled / budget blocked) ⇒ the panel says "AI assist paused" and offers the
  deterministic driver summary as a starting point. Decision rows are org-level (no `location_id`) so
  they never block `exceptions_cleared`.
- **Carry-forward:** for each line the prior three months' submitted explanations are offered as a
  suggestion ("Last month: …") when the category is recurring (`TIMING`, `EXPECTED`, `VOLUME`, `PRICE`)
  or the same category was used in two of the last three months. A suggestion is never auto-saved.
- Edits are refused once the period is `HARD_CLOSE` (the documentation is frozen with the books).

### A-3E.4 Close gate
- New blocking AUTO task **`flux_reviewed` "Flux review"** (FINAL phase, after accruals / prepaids /
  depreciation / WIP; `reviewed` now depends on it). Passes when: not applicable (review not required,
  or no material lines), or every material line is `REVIEWED` and not stale, or a **waiver** is on file.
- **Waiver (override):** `close_mgmt:manage` (controller / CFO / accounting manager / admin), reason
  ≥ 10 chars, stored in `flux_reviews` and logged to `core.action_log`; revocable (logged).
- A load failure fails CLOSED (status `UNKNOWN` blocks); the existing whole-gate override on
  `PATCH /api/periods` still works and still records the named blockers.

### A-3E.5 Export
`GET /api/close/flux/export?format=csv` and the pure `buildFluxPackageSection(board)` (for the close
package / board pack slice): lines, explanations, categories, preparer/reviewer, waiver.

### A-3E acceptance criteria (testable)
- **AC-3E.1** materiality: `EITHER`/`BOTH`/`ABS_ONLY`/`PCT_ONLY`, null % on a zero base, override
  precedence ACCOUNT > GROUP > TYPE, exclusions (`flux/materiality.test.ts`).
- **AC-3E.2** comparison bases incl. trailing-3 rounding and BUDGET → BS fallback; BS = ending balance,
  P&L = activity; normal-balance signing (`flux/compute.test.ts`).
- **AC-3E.3** driver ranking: largest first, new counterparty, one-off, reclass detection
  (`flux/drivers.test.ts`).
- **AC-3E.4** SoD: preparer cannot review own; DB CHECK refuses `reviewed_by = prepared_by`; send-back;
  staleness (`flux/explanations.test.ts`, `test/flux-schema.test.ts`).
- **AC-3E.5** the gate blocks HARD_CLOSE with an unexplained/unreviewed/stale material line, passes when
  reviewed, waived, not required, or nothing material; UNKNOWN fails closed (`flux/gate.test.ts`,
  `close/flux-close-task.test.ts`).
- **AC-3E.6** AI-down fallback returns the driver summary; an AI draft with an untraceable $ figure or
  an unknown citation is refused (`flux/ai-draft.test.ts`).
- **AC-3E.7** carry-forward suggestions (`flux/explanations.test.ts`).
- **AC-3E.8** migration 187: members can't write, read only their org, client-scope policy present,
  vocabularies hold; flux writes never touch `gl_entries` / `fiscal_periods` (`test/flux-schema.test.ts`).

**Deferred (with reason):** QoQ/YoY-cumulative bases (monthly close is the gate; quarterly flux → 3A
engine); budget versions (the `budgets` table carries no version column — sums the month's rows);
dimension-level materiality overrides; flux on consolidated groups (per company first).
