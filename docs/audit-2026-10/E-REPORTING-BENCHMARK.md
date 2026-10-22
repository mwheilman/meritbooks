# E — Reporting, FP&A & Analytics Benchmark

**Audit series:** 2026-10 · **Track E** · **Author:** product research (CFO lens) · **Date:** 2026-10-22
**Purpose:** The owner described MeritBooks' reporting and FP&A as "bare minimum" and asked for "incredible report information": the strongest reports, analyses and graphs AI can produce. This document is the **build-against benchmark**. It lists every report a world-class book of record plus FP&A layer should ship, what the best competitor does, and the UX and AI patterns that make reporting feel exceptional.

**Not an FPB.** This is research input. Before any of it is built, the auditor agent must turn it into the Financial-Reports FPB and module FPBs (Rule 13). Personas follow the canon: owner, CFO, controller, accounting manager, bookkeeper, plus external lender, surety and board readers.

---

## 0. Method, evidence quality, legend

**Method.** Web research (October 2026) on 30 products: Fathom, Reach Reporting, Spotlight Reporting, Jirav, Mosaic, Runway, Pigment, Cube, Vena, Planful, Abacum, Digits, Puzzle, Rillet, Campfire, Sage Intacct, NetSuite, QuickBooks Online Advanced, Xero, Double, Karbon, Syft, LivePlan, Brex, Ramp, Foundation Software, Procore, Buildertrend and ServiceTitan, plus construction-CFO and surety guidance. Sources are numbered `[S#]` in §7.

**Evidence caveat (read this).** Most feature claims come from **vendor marketing pages, help centres and app-marketplace listings**. Independent verification was limited to a few G2/Capterra/TrustRadius reviews. Where a pattern is standard CPA/CFO practice rather than a cited vendor feature, it is tagged **[practice]**. "Best-in-class" picks are judgement calls based on that evidence, not head-to-head testing.

**Interaction codes** (used in every catalog table)

| Code | Meaning |
|---|---|
| **D** | Drill: number → account → transaction → source document |
| **F** | Filter or pivot by dimension (entity, location, department, class, job, customer, vendor, item, employee) |
| **C** | Compare columns: prior period, prior year, budget, forecast, scenario, with $ and % variance |
| **A** | Annotate: comment on a cell or line, with threaded discussion |
| **S** | Schedule: recurring email or portal delivery |
| **Sh** | Share: live link, client portal or lender portal, with permissions |
| **X** | Export: PDF (branded), XLSX (live formulas where possible), CSV |
| **N** | AI narrative or explanation attached |
| **W** | What-if / scenario overlay |

**Persona codes:** OWN owner · CFO · CTL controller · AM accounting manager · BK bookkeeper · PM project manager / estimator · LND lender or surety · BRD board or investor · FP firm partner (accounting-firm tenant) · SM service manager · DLR dealer principal.

**Existing Merit surface.** Each section has a "Merit surface today" line. It is a **route- and file-name signal only**, taken from `apps/web/src/app/(app)/*` and `apps/web/src/app/api/reports/*` on 2026-10-22. **Depth, correctness and states are unverified.** Treat it as a pointer for the gap audit (task #24), not as a claim that anything is done.

---

## 1. Competitive landscape: who is best at what

| Capability | Best-in-class reference | Why (evidence) |
|---|---|---|
| KPI library + target status | **Fathom**, NetSuite | Fathom: 50+ default KPIs, custom KPIs, targets, a green tick / red cross "on track %" explorer, importance stars, a KPI library shared across companies [S1][S2][S3]. NetSuite: 75+ standard KPIs; scorecards with up to 10 custom KPIs based on saved searches [S18][S19] |
| Management report pack designer | **Fathom**, Reach, Spotlight | Fathom: drag-and-drop report editor mixing commentary, charts and data; templates reusable across companies; embedded images and PDFs; online link or PDF; branded board packs [S4][S5][S6]. Reach: spreadsheet-style builder with Excel formulas, brandable template library, scheduled packs [S8][S9] |
| Multi-entity consolidation (SMB) | **Syft**, Fathom, Spotlight | Syft: unlimited entities, eliminations, acquisitions and disposals, fractional ownership, 170+ currencies [S38]. Fathom: up to 300 entities across platforms [S6] |
| Dimensional GL reporting | **Sage Intacct** | 10 predefined dimensions plus custom ones; Interactive Custom Report Writer with drag-and-drop, calculated columns, rolling sums, pivots, drill to transaction [S15][S16][S17] |
| Ad-hoc report writer for power users | **Sage Intacct** ICRW, NetSuite Financial Report Builder + saved searches, QBO Advanced Custom Report Builder (pivots) | [S15][S20][S23] |
| Two-way spreadsheet sync | **QBO Advanced Spreadsheet Sync**, Cube, Vena | QBO: two-way Excel link, templates, multi-company consolidation [S22][S23]. Cube: patented bi-directional sheet sync [S30]. Vena: Excel-native [S32] |
| Three-way forecast (P&L/BS/CF) | **Fathom**, Reach, Spotlight | Fathom: 3-way, driver-based, rolling, micro-forecasts (hire, asset), up to 36 months, consolidated group forecasts [S3]. Reach and Spotlight also do 3-way [S8][S10] |
| Scenario modelling UX | **Runway** | Draft scenarios; drag a hire date or funding round along a timeline and watch metrics recalculate; plain-language formulas; no model duplication [S13][S14] |
| Headcount / workforce planning | **Jirav** | Roster import, planned hires, reductions, raises, fully burdened cost; driver-based hires (e.g. 1 CSM per 100 customers); salary run-rate and revenue-per-employee reports [S26] |
| Rolling forecast automation | **Jirav** | Plans roll forward automatically; Auto-Forecast on the income statement [S27][S28] |
| Metric library and board dashboards (SaaS) | **Mosaic** | 150+ metrics, 35+ templates, multi-dimension drill-down, Metric Builder [S29] |
| Agentic FP&A | **Pigment** | Analyst, Modeler, Planner and Supervisor agents; scheduled analyses; PDF/PPT output; anomaly detection [S31] |
| AI flux / variance explanation on a live GL | **Rillet**, Campfire | Rillet: MoM/QoQ/YoY/BvA on every account, materiality thresholds by $ and %, Aura writes an explanation per flagged variance automatically during close [S35]. Campfire Ember drafts flux commentary at close and builds custom reports on demand, with human approval and an audit trail [S36] |
| AI executive summary + live reports | **Digits** | Live statements; AI executive summaries; inline "Advertising spend up 13%…" insights; line-level comments [S11][S12] |
| Natural-language Q&A over the books | **Intuit Intelligence** (QBO), Planful AI Analyst, Vena Copilot | QBO: plain-English questions with conversation history linked to the data, proactive anomaly and cash insights, daily briefing (several parts still beta) [S24][S25]. Planful: right-click drill from AI-generated tables and charts [S33] |
| Cash-forecast UX for owners | **Xero Analytics Plus** | 7/30/60/90-day projection; click any day to see cash in and out; manual add/remove; basic scenarios [S39] |
| Industry benchmarks | **LivePlan**, Syft, Spotlight | LivePlan: NAICS peer data (Sageworks) on 6 metrics, narrowed by region and revenue size [S42]. Syft: benchmarks on its higher tier [S38] |
| Firm practice reporting | **Karbon**, Double | Karbon: utilization, output, efficiency, realization, WIP, budget vs actual time, Power BI and Snowflake export [S41]. Double: firm-wide close status, review reports (e.g. Expense Inconsistency), one-page client executive summary [S40] |
| Spend analytics and price benchmarking | **Ramp**, Brex | Ramp: SKU-level price benchmarks, renewal alerts 90 days out, shadow-SaaS detection, PO savings reports [S43]. Brex: widget dashboards by merchant, category, budget, user and department [S44] |
| Construction WIP and job cost | **Foundation**, Buildertrend, Procore | Foundation: real-time job cost and WIP [S45]. Buildertrend: accrual WIP with projected cost (revised budget + committed + pending), % complete by cost, over/under billing [S51]. Procore: editable forecast-to-complete by cost code, projected over/under [S52] |
| Field-service operating KPIs | **ServiceTitan** | Technician scorecards by business-unit division: completed revenue, jobs, sales, opportunities, conversion, memberships, average revenue per opportunity, CSAT [S53] |

**Takeaway.** No single competitor covers more than about 40% of this catalog. Fathom, Reach and Spotlight are reporting add-ons that sit on someone else's ledger. Jirav, Runway, Pigment, Mosaic, Cube, Vena and Planful are FP&A layers. Rillet, Campfire and Digits are AI-native ledgers but thin on management packs and on construction. Foundation, Procore and ServiceTitan are vertical tools. **MeritBooks owns the GL, so it can join all four categories with transaction-level drill-down that the add-ons cannot match.** That is the strategic position.

---

## 2. The report catalog

Every report inherits the **universal report contract** in §3: period selector, comparison columns, dimension filters, drill, export, schedule, share, annotate and saved views. The tables below cover only what is specific to each report.

### 2.A Financial statements, with every variant

Merit surface today: `api/reports/{income-statement,balance-sheet,cash-flow,cash-flow-direct,pnl-by-month,equity-changes,consolidated,gl-detail,transaction-list,compile,packs}`, `(app)/reports`, `(app)/consolidation`.

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| A1 | Income statement, standard | Revenue → COGS → GP → OpEx → EBITDA → net income with subtotals and % of revenue | Stacked bar of revenue vs expense; margin line | D F C A S Sh X N | All | Sage Intacct [S15] |
| A2 | Balance sheet, standard | Assets, liabilities and equity at a date; working-capital subtotal | Composition bars; trend sparkline per line | D F C A S Sh X N | All | Sage Intacct |
| A3 | Comparative (period vs prior period, vs prior year) | Two or more columns with $ and % change; favourability colouring by account type | Variance bars, diverging | D F C A N | CFO CTL OWN | Rillet (auto-flux) [S35] |
| A4 | Common-size | Every line as % of revenue (IS) or % of total assets (BS), side by side across periods | 100% stacked area | D C | CFO OWN LND | [practice] |
| A5 | Multi-period (12 months across, quarters across, years across) | Monthly columns + total; optional YTD column | Line or area per section; heat-map cells | D F C A X | CTL AM CFO | Fathom / Reach [S3][S8] |
| A6 | By dimension (columns by class, department, location, job, entity) | Same statement split into dimension columns + total | Small multiples; treemap | D F C X | CFO dept heads OWN | Sage Intacct dimensions [S16] |
| A7 | Consolidated with eliminations | Entity columns → eliminations column → consolidated; minority interest; FX translation | Waterfall from sum-of-entities to consolidated | D F C A X | CFO CTL LND BRD | Syft [S38], Fathom [S6] |
| A8 | Budget vs actual | Actual, budget, $ var, % var, with favourability; YTD and full-year budget | Bullet charts; BvA bars; variance waterfall | D F C A S N | CFO dept heads OWN | Abacum (owner commentary per variance) [S34] |
| A9 | Actual vs forecast / latest estimate | Actuals to date + forecast remainder = full-year outlook vs budget | Actual-solid / forecast-dashed line with confidence band | D C W N | CFO OWN BRD | Jirav [S27] |
| A10 | Rolling 12 / trailing twelve months (TTM) | TTM revenue, GP and EBITDA each month; smooths seasonality | TTM line vs monthly bars | D C | CFO LND OWN | [practice] |
| A11 | YTD / QTD / MTD with prior-year same-period | Period-to-date vs same period last year | KPI tiles with delta arrows | C | OWN CFO | QBO / Xero standard |
| A12 | % change and growth | MoM, QoQ, YoY growth rates per line; CAGR for multi-year | Growth bars; slope chart | C N | CFO BRD | [practice] |
| A13 | Statement of changes in equity | Opening, contributions, distributions, NI, OCI, closing, per owner or class | Waterfall | D X | CFO LND BRD | [practice] |
| A14 | Trial balance (unadjusted, adjusting, adjusted, worksheet) | TB with AJE/RJE columns and final; tie-out to statements | none | D F X | CTL AM auditors | [practice] |
| A15 | GL detail / account activity | Every posting with running balance and source doc link | none | D F X | BK AM | all |
| A16 | Cash vs accrual toggle and book-to-tax basis | Same statement on cash, accrual or tax basis, with reconciling items | Bridge from book to tax | D C X | CFO tax preparer | QBO (cash/accrual toggle) |
| A17 | Custom statement layouts (row/column designer) | User-defined rows (groups, formulas, ratios) and columns (any period or dimension) | any | all | CTL CFO | Sage Intacct Financial Report Writer, NetSuite Financial Report Builder [S15][S20] |

### 2.B Cash and liquidity

Merit surface today: `(app)/cash` (dashboard, trend, forecast, obligations), `api/forecast/cash`, `cash-flow-direct`.

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| B1 | Cash flow statement, indirect | NI → non-cash → working-capital changes → CFO, CFI, CFF | Waterfall from NI to change in cash | D C X N | CFO CTL LND | Fathom 3-way [S3] |
| B2 | Cash flow statement, direct | Receipts from customers, payments to vendors, payroll, tax, debt service | Inflow/outflow mirrored bars | D C X | OWN CFO | [practice] |
| B3 | 13-week cash forecast | Weekly receipts by source (AR aging × collection curve, deposits) less disbursements (AP due, payroll calendar, debt, tax); ending cash vs minimum-cash line | Weekly bars + ending-cash line + covenant floor | D W A S N | CFO OWN LND | Xero Analytics Plus daily drill [S39]; [practice] for the 13-week format |
| B4 | Daily cash position | Bank balances by account and entity, cleared vs available, float | Stacked bars by bank | D F | CFO AM | NetSuite cash portlet [S18] |
| B5 | Runway and zero-cash date | Months of runway at current and scenario burn; break-even month | Countdown tile + projected cash curve | W N | OWN CFO BRD | Jirav (zero-cash date) [S28], Puzzle (daily burn/runway) [S37] |
| B6 | Burn (gross and net) | Monthly gross and net burn; burn multiple | Bars + 3-mo average line | C N | OWN BRD | Puzzle [S37] |
| B7 | Cash conversion cycle | DSO + DIO − DPO trend; working capital tied up in $ | Stacked component line | D C N | CFO LND | [practice] |
| B8 | Free cash flow and FCF conversion | EBITDA → capex → ΔNWC → taxes → debt service → FCF | Waterfall | D C | CFO BRD LND | [practice] |
| B9 | Cash variance (forecast vs actual) | Last week's forecast vs actual receipts and payments; forecast accuracy % | Variance bars; accuracy trend | D N | CFO | [practice] |
| B10 | Sources and uses / cash bridge | Opening → ops → capex → financing → distributions → closing | Waterfall | D | OWN BRD | [practice] |

### 2.C AR and AP

Merit surface today: `api/reports/{ar-aging,ap-aging,customer-balances,vendor-balances,open-items,expense-by-vendor,sales-by-customer,income-by-customer}`, `(app)/collections`, `(app)/cash-application`.

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| C1 | AR aging, summary and detail | Current / 1-30 / 31-60 / 61-90 / 90+ by customer, entity, job; retainage split out | Stacked aging bars; aging trend over 12 months | D F S X A | AM BK CFO | NetSuite aging by customer/subsidiary/currency [S18] |
| C2 | DSO trend + Best-Possible DSO + Average Days Delinquent | DSO, BPDSO and ADD = DSO − BPDSO per month | Three-line chart | D C N | CFO AM | CRF metric set [S54] |
| C3 | Collection Effectiveness Index (CEI) | (Beg AR + sales − end AR) ÷ (beg AR + sales − end current AR); ≥ 90% excellent, < 70% problem; CRF Q1-2025 median about 79 | Gauge + trend | C N | CFO AM | CRF [S54] |
| C4 | Customer payment behaviour | Average days to pay per customer, trend, promise-kept rate, predicted pay date | Scatter (balance × days late); per-customer sparkline | D N | AM BK | [practice]; AI-native |
| C5 | Customer concentration | Top-N customers' % of revenue and AR; HHI index; any customer over 10% flagged | Pareto | D F N | CFO LND BRD | [practice] (lenders ask for this) |
| C6 | Bad-debt / allowance (CECL-style) | Aging × loss rates = reserve; write-off history | Bars | D | CTL | [practice] |
| C7 | AP aging, summary and detail | Due buckets by vendor; retainage payable | Stacked bars | D F S X | AM BK | standard |
| C8 | DPO trend + payment timing | DPO; % paid early / on time / late; average days early or late | Line + histogram | D C | CFO AM | [practice] |
| C9 | Early-pay discount capture | Discounts offered vs taken vs missed in $; annualized return of each missed discount | Bars; "money left on table" tile | D N | CFO AM | [practice] |
| C10 | Vendor spend analysis | Spend by vendor, category, department and job; YoY; new vendors; vendor count trend | Treemap; Pareto; trend | D F C N | CFO OWN | Ramp / Brex [S43][S44] |
| C11 | Price variance / price intelligence | Unit price paid over time per vendor and item; outliers vs own history and vs PO | Line per SKU with band | D N | CFO purchasing | Ramp Price Intelligence [S43] |
| C12 | Duplicate / anomalous payment exceptions | Detector output (EC-1 duplicate payment, etc.) | List with severity | D A | CTL | Merit's own exception library |
| C13 | 1099 vendor readiness | Reportable spend by vendor, W-9 status, TIN match | none | D X | BK AM | [practice] |
| C14 | Deferred revenue / customer deposits roll-forward | Beginning + billings − recognized = ending | Waterfall | D | CTL CFO | [practice] |

### 2.D Profitability

Merit surface today: `(app)/profitability`, `api/reports/{job-profitability,income-by-customer,sales-by-customer}`, `(app)/jobs/[id]` (job P&L, EAC).

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| D1 | Profitability by customer | Revenue, direct cost, GP, GP%, allocated overhead, net contribution; LTV for recurring | Whale curve (cumulative profit by customer rank) | D F C N | OWN CFO sales | [practice]; whale curve is the standout visual |
| D2 | Profitability by job / project | Contract, cost, GP, GP% vs estimate | Bullet: estimate vs actual GP% | D F N | PM OWN CFO | Foundation, Buildertrend [S45][S51] |
| D3 | Profitability by product / service / item | Units, price, cost, margin, mix % | Scatter (volume × margin); quadrant | D F C | CFO OWN | [practice] |
| D4 | Profitability by department / location / class / business unit | Segment P&L with contribution after direct and allocated costs | Small multiples; ranked bars | D F C | OWN dept heads | Sage Intacct dimensions [S16] |
| D5 | Profitability by salesperson / estimator / technician | Revenue, GP, GP%, close rate, average ticket, callbacks | Ranked bars; scorecard | D F | OWN SM sales mgr | ServiceTitan scorecards [S53] |
| D6 | Gross margin bridge (period to period) | GP change split into price, volume, mix and cost effects | Waterfall | D N | CFO | FTI PVM method [S55] |
| D7 | Contribution margin statement | Revenue − variable costs = CM; CM%; fixed costs; break-even revenue | Break-even chart (CVP) | W | CFO OWN | [practice] |
| D8 | Unit economics | Revenue, cost and margin per job, per call, per unit sold, per labour hour | KPI tiles + trend | C | OWN | [practice] |
| D9 | Customer cohort profitability | Revenue and margin retention by acquisition cohort | Cohort heat map | — | CFO BRD | Mosaic-style metric library [S29] |

### 2.E Construction and project-based (core vertical)

Merit surface today: `(app)/jobs/wip`, `api/jobs/{wip,eac,pl}`, `api/reports/{wip,job-cost,job-profitability}`, `(app)/retainage`, `(app)/estimates`.

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| E1 | WIP schedule (percent-complete) | Per job: revised contract, estimated total cost, cost to date, % complete (cost-to-cost), earned revenue, billed to date, **over/under billing**, estimated GP and GP%, cost to complete, backlog revenue. Ties to GL contract-asset and contract-liability accounts | Over/under diverging bars by job; GP% bullets | D F C A S X N | CFO CTL PM LND | Foundation [S45]; formula per Corpay [S46]; Buildertrend projected-cost logic [S51] |
| E2 | Over/under billings summary + GL tie-out | Total overbillings (liability) and underbillings (asset) vs GL balance; adjusting JE proposal | Two bars + reconciliation tile | D N | CTL | [practice] |
| E3 | Job fade / gain analysis | Original bid GP% → prior-month GP% → current GP%; fade $ and pts by job; cumulative fade by PM | Slope chart per job; fade waterfall | D C N | CFO OWN LND | AAFCPA and HBK describe fade as the key surety signal [S47][S48] |
| E4 | Cost-to-complete / estimate-at-completion by cost code | Budget, committed, actual, pending COs, forecast to complete, projected over/under | Stacked bars per cost code | D A W | PM CFO | Procore forecast-to-complete [S52] |
| E5 | Backlog | Signed, unearned contract revenue; months of coverage (backlog ÷ average monthly revenue); split by type, customer and start date | Backlog burn-down; stacked by start quarter | D F N | OWN CFO LND | JMCO (split by start date) [S49], Phoenix (signed only, months of coverage) [S56] |
| E6 | Retainage receivable and payable | Retainage held by job and customer; release due dates; aged retainage | Aging bars | D F | AM CFO | LiveFlow 6-metric scorecard [S50] |
| E7 | Change-order log impact | Approved, pending and unapproved COs by job; pending CO exposure in $ | Bars | D | PM CFO | JMCO (unapproved COs hide fade) [S49] |
| E8 | Job cost detail (budget vs actual by phase/cost code/type: labour, material, sub, equipment, other) | Line-level variances | Variance bars | D F | PM | Buildertrend Job Costing Budget [S51] |
| E9 | Labour productivity | Budgeted vs actual hours per unit; labour cost per hour; burden | Line | D | PM OWN | [practice] |
| E10 | Equipment utilization and cost | Hours, revenue, cost per hour, owned vs rented | Bars | D | OWN | Foundation equipment module [S45] |
| E11 | Surety / bonding package | WIP + completed-contracts schedule + backlog + working capital + net worth; bonding capacity estimate | Pack | X Sh | LND OWN | QuickBooks construction guidance on surety scrutiny [S57] |
| E12 | Completed-contracts schedule | Closed jobs this year: final GP vs bid GP; fade or gain realized | Bars | D | LND CFO | [practice] |
| E13 | Job cash flow / billing curve | Cumulative billed vs cost vs collected by job (S-curve) | S-curves | D | PM CFO | [practice] |
| E14 | Construction CFO scorecard | 6–8 owned KPIs: job GP, WIP-adjusted margin, underbilling $, retainage outstanding, cash runway, backlog months, bonding working capital | Tile grid with RAG | D N S | OWN CFO | LiveFlow / Phoenix [S50][S56] |

### 2.F Home services, field service and dealers (other core verticals)

Merit surface today: `(app)/dealer/*` (floor plan, SOT, inventory, receivables panels). Field-service operating data mostly lives in the source FSM (ServiceTitan etc.); Books should **join it to the GL**, not re-implement dispatch.

| # | Report | What it shows | Charts | Users | Best ref |
|---|---|---|---|---|---|
| F1 | Revenue and GP by business unit / trade (HVAC, plumbing, electrical; install vs service vs maintenance) | Segment P&L | Small multiples | OWN SM | ServiceTitan BU divisions [S53] |
| F2 | Technician scorecard, financial view | Completed revenue, GP after labour and parts, average ticket, conversion, memberships sold, revenue per paid hour | Ranked bars | SM OWN | ServiceTitan [S53] |
| F3 | Membership / maintenance-agreement economics | Active agreements, deferred revenue, renewal rate, revenue per member | Cohort line | OWN CFO | [practice] |
| F4 | Dealer: floor-plan aging and curtailment exposure | Units by days in stock vs curtailment schedule; interest carry | Aging bars | DLR CFO LND | [practice] |
| F5 | Dealer: unit gross (front/back) and department P&L | Per-unit front gross, F&I back gross; sales, service and parts department contribution | Bars | DLR | [practice] |
| F6 | Dealer: service absorption rate | Fixed-ops GP ÷ total dealership overhead | Gauge + trend | DLR | [practice] |
| F7 | Inventory turns / days supply / aged inventory | By category | Bars | DLR CFO | [practice] |

### 2.G KPIs, ratios and lender metrics

Merit surface today: `(app)/covenants` (parse, compute, certificate), `(app)/borrowing-base`, `(app)/debt`, `api/reports/debt-schedule`.

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| G1 | KPI scorecard (configurable, with targets) | Library of 60+ KPIs; target, actual, status, trend; grouped (profitability, liquidity, efficiency, growth, cash) with importance weighting | Green / amber / red tiles + sparkline | D C A S N | OWN CFO FP | Fathom KPI Explorer [S2]; NetSuite scorecards [S18] |
| G2 | Liquidity ratios | Current, quick, cash ratio, working capital, days cash on hand | Gauges + trend | C | CFO LND | Fathom [S1] |
| G3 | Leverage ratios | Debt/EBITDA, debt/equity, liabilities/net worth (surety), interest coverage | Trend lines with covenant threshold | C N | CFO LND | [practice] |
| G4 | Efficiency ratios | Asset turnover, AR/AP/inventory turns, revenue per employee, OpEx % revenue | Trend | C | CFO | Jirav workforce KPIs [S26] |
| G5 | DSCR and fixed-charge coverage | (EBITDA − unfunded capex − taxes − distributions) ÷ debt service; trailing and projected | Line + threshold | C W N | CFO LND | [practice] |
| G6 | Covenant compliance and headroom | Each covenant: required vs actual vs **headroom $ and %**, projected breach date from forecast; compliance certificate | Bullet chart per covenant; headroom trend | D W S X N | CFO OWN LND | [practice]; Merit already parses covenants |
| G7 | Borrowing-base certificate | Eligible AR and inventory × advance rates − reserves = availability | Waterfall | D X | CFO LND | [practice] |
| G8 | EBITDA and adjusted-EBITDA bridge | NI → interest → taxes → D&A = EBITDA → add-backs (owner comp normalisation, one-time, non-recurring) = adjusted EBITDA; each add-back documented | Waterfall with add-back notes | D A N | OWN CFO BRD buyer | [practice]; QoE-style |
| G9 | Working-capital analysis | NWC, NWC % revenue, normalized NWC peg vs actual (M&A) | Line + peg band | D | CFO | [practice] |
| G10 | Industry benchmarks | Own ratios vs NAICS peers by size and region; percentile | Percentile dot plot | — | OWN CFO FP | LivePlan [S42], Syft [S38] |
| G11 | Multi-company ranking (portfolio / firm) | Same KPI across all entities or clients, ranked | Ranked bars / heat map | D | FP CFO OWN (Merit portfolio) | Fathom company ranking [S3] |

### 2.H Variance analysis

Merit surface today: `budgets/budget-vs-actual`, `api/reports/narrative`, `api/explain`, exception detectors (EC-10 anomalous JE).

| # | Report | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| H1 | Flux analysis (every account, MoM / QoQ / YoY / BvA) | All accounts with change; **materiality filter ($ and/or %)**; flagged lines require an explanation before close sign-off | Sorted variance bars | D A N | CTL AM | Rillet [S35], Campfire Ember [S36] |
| H2 | Price / volume / mix (revenue and COGS) | Revenue change split into price, volume and mix; combined into a GM bridge | Waterfall | D N | CFO | FTI [S55] |
| H3 | Bridge / waterfall: any metric A → B | User picks start and end (e.g. budget EBITDA → actual EBITDA) and drivers (by account group, department or job) | Waterfall | D N | CFO BRD | [practice] |
| H4 | Variance by owner (departmental accountability) | Each budget owner's lines with variance and **owner-supplied commentary** | Table + bullets | A S | dept heads CFO | Abacum [S34] |
| H5 | Balance-sheet flux | BS account changes with roll-forward (beginning + activity − ending) | Roll-forward bars | D N | CTL | Rillet says BS flux is still in progress, so this is a gap competitors haven't closed [S35] |
| H6 | Headcount and payroll variance | Budget vs actual heads, rate, hours, burden | Bars | D | CFO | Jirav [S26] |

### 2.I FP&A: plan, forecast, scenario

Merit surface today: `(app)/budgets` (entry grid, import, drivers, scenario-modeler, NL scenario bar, reforecast), `(app)/forecast`, `(app)/fpna` (dashboard, NL scenario).

| # | Report / tool | What it shows | Charts | Interactions | Users | Best ref |
|---|---|---|---|---|---|---|
| I1 | Driver-based budget | Revenue drivers (jobs × average contract, techs × billable hours × rate, units × price); cost drivers (% of revenue, $ per head, fixed schedule) | Driver tree | W A | CFO dept heads | Jirav [S26], Vena [S32] |
| I2 | Budget templates by department, with workflow | Owner-entered submissions → review → approve → lock; version history | Status board | A | dept heads CFO | Planful / Vena [S32][S33] |
| I3 | Headcount plan | Roster + planned hires and terms, raises, burden (taxes, benefits, bonus), driver-based hires | Heads over time; cost stack | W | CFO OWN | Jirav [S26] |
| I4 | Three-statement forecast | P&L → BS → CF linked; AR/AP days drive working capital; debt schedule; capex | 3-way | W N | CFO LND | Fathom [S3] |
| I5 | Rolling forecast (auto-roll) | Actuals replace forecast each close; horizon stays 12–18 months | Actual + forecast line | W N | CFO | Jirav [S27] |
| I6 | Reforecast / latest estimate | Mid-year re-plan vs original budget, with variance bridge | Bridge | C N | CFO BRD | Abacum [S34] |
| I7 | Scenario / what-if comparison | Base, upside and downside side by side; timeline levers (move a hire, add a truck, win or lose a job, rate change); no model duplication | Scenario fan; delta table | W N | OWN CFO BRD | Runway timeline drag [S13] |
| I8 | Micro-forecast events | Discrete events (buy equipment, new location, loan) layered on base | Event markers on cash line | W | OWN | Fathom micro-forecasts [S3] |
| I9 | Statistical baseline forecast with confidence band | Seasonality-aware projection of revenue and expense lines; P10/P50/P90 | Fan chart | N | CFO | Jirav Auto-Forecast [S27] (no band published); band is the AI upgrade |
| I10 | Capacity / backlog-driven revenue forecast (construction) | Backlog burn schedule + win-rate-weighted pipeline → revenue by month | Stacked area (contracted vs probable) | W | OWN CFO | [practice] |

### 2.J Board, lender and investor packages

Merit surface today: `(app)/board-package`, `api/reports/{board-package,packs,compile,narrative}`.

| # | Package | Contents | Interactions | Users | Best ref |
|---|---|---|---|---|---|
| J1 | Monthly management pack | Cover, AI executive summary, KPI scorecard, IS/BS/CF, BvA, cash and 13-week, AR/AP, top variances with commentary, appendices | Report designer (drag-and-drop sections), templates reusable across clients, branded PDF + live link, schedule | OWN CFO FP | Fathom [S4][S5], Reach [S8] |
| J2 | Board deck | Highlights / lowlights, KPIs vs plan, financials, forecast update, asks; PPT/PDF output | Comment threads; version lock at approval | BRD | Pigment PDF/PPT generation [S31] |
| J3 | Lender package | Statements + compliance certificate + covenant headroom + borrowing base + AR aging + debt schedule | Lender portal share; scheduled monthly / quarterly | LND | [practice] |
| J4 | Surety package | WIP, completed contracts, backlog, working capital, CPA-ready statements | Share | LND | [practice] [S57] |
| J5 | Investor / LP update (holding-company use) | Portfolio KPIs, consolidated and per-company results, distributions | Share | BRD | Fathom company ranking [S3] |
| J6 | Client advisory pack (firm tenant) | One-page executive summary + client-specific KPIs → client portal | Publish to portal | FP clients | Double [S40] |

### 2.K Practice / team reports (accounting-firm and in-house team)

Merit surface today: `(app)/close-status`, `(app)/close`, `api/client-health`, `(app)/team`, `(app)/platform`.

| # | Report | What it shows | Charts | Users | Best ref |
|---|---|---|---|---|---|
| K1 | Close status board (all clients / entities) | Per client: period, % tasks done, blockers, open client questions, reviewer, days to close | Kanban / heat grid | FP AM | Double [S40] |
| K2 | Close cycle time trend | Business days from period end to close, per client and bookkeeper; target vs actual | Line | FP CTL | [practice] |
| K3 | Throughput by bookkeeper | Transactions categorized, JEs, reconciliations, closes completed per week; AI-assisted vs manual share | Stacked bars | FP AM | Karbon output / efficiency [S41] |
| K4 | Backlog by bookkeeper | Uncategorized items, unreconciled accounts, open exceptions, ageing | Stacked bars + ageing | FP AM | Karbon WIP [S41] |
| K5 | Error and rework rates | Reviewer-rejected items, reclasses after close, AI-suggestion override rate, recategorization by reviewer | Line | FP CTL | Double Expense Inconsistency report [S40] |
| K6 | Utilization, realization and client profitability (firm) | Hours vs capacity; fee vs effort; margin per client | Scatter (effort × fee) | FP | Karbon [S41] |
| K7 | AI automation scorecard | Auto-categorized %, auto-approved %, average confidence, touchless close %, time saved | Tiles + trend | FP OWN | Merit-native (extends Bank Feed metrics strip) |
| K8 | Client health | Data freshness, bank-feed breaks, overdue items, KPI red flags | RAG list | FP | [practice] |

### 2.L Controls and audit

Merit surface today: `(app)/controls`, `(app)/exceptions`, `(app)/audit`, `(app)/pbc`, `(app)/reconciliation`, `(app)/periods`.

| # | Report | What it shows | Users |
|---|---|---|---|
| L1 | Reconciliation status (all balance-sheet accounts) | Reconciled-through date, unreconciled difference, preparer / reviewer, ageing of reconciling items | CTL auditors |
| L2 | Manual JE report | All manual entries with preparer, approver, round amounts, weekend or after-hours posting, post-close entries | CTL auditors |
| L3 | Segregation-of-duties conflicts | Users holding incompatible permissions; same-person create-and-approve events | CTL security |
| L4 | User access review | Who can do what, last login, changes in period | CTL |
| L5 | Audit trail / change log | Field-level history on master data and posted transactions; reopened-period log | auditors |
| L6 | Exception library dashboard | Detector hits by type (duplicate payment, anomalous JE, uncategorized leakage, intercompany imbalance) with resolution SLA | CTL CFO |
| L7 | PBC tracker | Auditor request list, status, linked evidence | CTL auditors |
| L8 | Period lock log + subsequent-entry report | Entries dated into closed periods (blocked attempts) | CTL |
| L9 | Benford / statistical anomaly scan | First-digit distribution of disbursements vs Benford; outliers | CTL auditors [practice] |
| L10 | Vendor master change report | Bank-detail changes, new vendors, approver (fraud control) | CTL |

### 2.M Tax

Merit surface today: `(app)/{tax,tax-package,tax-provision,tax-depreciation,book-to-tax,sales-tax-return,sales-tax-calendar,compliance-1099}`.

M1 Book-to-tax reconciliation (M-1/M-3 style) · M2 Tax-basis financial statements · M3 Sales-tax liability by jurisdiction, with filing calendar · M4 1099 summary and filing readiness · M5 Tax depreciation vs book (by method) · M6 Estimated-tax and provision summary · M7 Owner / partner K-1 allocation preview (pass-throughs) · M8 Payroll-tax liability and deposit reconciliation. Users: CFO, tax preparer, CTL. Charts are minimal; X and Sh to the CPA are the key interactions.

### 2.N Payroll and labour

Merit surface today: `(app)/payroll`.

| # | Report | What it shows | Users | Best ref |
|---|---|---|---|---|
| N1 | Labour cost by department, job and location | Wages + burden, % of revenue | CFO OWN | Jirav [S26] |
| N2 | Fully burdened labour rate | Wage + taxes + benefits + WC insurance per hour, by class | PM CFO | [practice] |
| N3 | Headcount and turnover | Starts, terms, turnover %, tenure | OWN | [practice] |
| N4 | Overtime analysis | OT hours and $ by employee and job; trend | OWN PM | [practice] |
| N5 | Revenue and GP per employee / per field tech | Productivity | OWN | Jirav [S26] |
| N6 | Payroll register and GL tie-out | Register ↔ GL clearing-account reconciliation | AM | [practice] |
| N7 | Certified payroll / prevailing wage (construction) | Weekly WH-347 style data | AM PM | [practice] |

### 2.O Spend and expense analytics

Merit surface today: `(app)/expenses`, `(app)/credit-cards`, `(app)/subscriptions`, `api/reports/expense-by-vendor`.

O1 Spend by category, department and vendor with trend (Brex widgets [S44]) · O2 SaaS / subscription inventory and renewal calendar with shadow-IT detection (Ramp [S43]) · O3 Card spend by cardholder vs policy; out-of-policy items · O4 Recurring-charge creep (same vendor, rising amount) · O5 Spend vs budget by department, live · O6 Savings opportunities ranked by $ (Ramp ranks by negotiation potential [S43]) · O7 Receipt and documentation compliance rate.

### 2.P Consolidation and intercompany

Merit surface today: `(app)/consolidation` (rates, match, entity currency, ownership, statements), `(app)/intercompany`, `(app)/internal-invoices`.

P1 Consolidating statements (entity columns → eliminations → consolidated) · P2 Intercompany balance matching (due-to / due-from by pair, mismatches) · P3 Elimination entry detail with audit trail · P4 Minority / non-controlling interest roll-forward · P5 FX translation (CTA) roll-forward · P6 Internal-invoice (inter-department) eliminations report · P7 Entity ranking / portfolio heat map (Merit's 17 portfolio companies are the live use case) · P8 Sub-consolidations (any group of entities, saved). Best reference: Syft [S38], with Fathom at 300 entities [S6].

---

## 3. The universal report contract (what makes 150 reports cheap to build)

Build **one report engine**, not 150 pages. Every catalog item above should be a *definition* rendered by shared infrastructure.

1. **Period engine.** Any date range or fiscal period; MTD, QTD, YTD, TTM and custom; columns across months, quarters or years; comparison presets (PP, PY, budget, forecast, scenario) with $ and % variance and favourability by account type (Planful lets admins set variance sign by account type [S33]).
2. **Dimension engine.** Filter, group or column-split by entity, location, department, class, job, customer, vendor, item or employee, plus custom dimensions (Sage Intacct has 10 predefined plus custom [S16]). Saved dimension groups such as "East region" or "Install BU".
3. **Row-layout designer.** Account groups, subtotals, formula rows (ratios), hide zero rows, collapse and expand (Sage Intacct FRW, NetSuite FRB [S15][S20]).
4. **Drill everywhere.** Statement → account → GL detail → source transaction → attached document, with the filter context preserved and breadcrumbs back (Sage Intacct and Campfire both drill to transaction [S15][S36]).
5. **Saved views and favourites.** Per-user and shared, role-based default report sets (Sage Intacct role-based dashboards [S59]).
6. **Output.** Branded PDF, live-formula XLSX, CSV and live link. Optional two-way spreadsheet sync as a later tier (QBO Spreadsheet Sync, Cube [S22][S30]).
7. **Schedule and distribute.** Recurring email or portal delivery, burst per entity or client, "send when close is signed off" trigger (Reach, Syft scheduled reports [S8][S38]).
8. **Annotations.** Cell- and line-level comments with threads, carried forward period to period and printed in packs (Digits line-level comments [S11]; Abacum variance commentary [S34]).
9. **Basis toggles.** Cash / accrual / tax basis, and draft vs final (soft-close) status watermark.
10. **Every state.** Loading, empty (with a "why empty" explanation), populated, error, and partial-period warnings (Rule 3).
11. **Performance.** Pre-aggregated period balances by dimension (materialized), so a 12-month by 17-entity by department statement renders in under 2 seconds.
12. **Security.** RLS-scoped (security-invoker views per migration 066 lesson); share links carry scoped, expiring tokens; lender and board viewers are read-only external roles.

---

## 4. UX patterns that make reporting feel "incredible"

| # | Pattern | Seen at | Spec for Merit |
|---|---|---|---|
| U1 | **KPI scorecard with status lights** | Fathom: on-track %, green tick / red cross per target, importance stars, drag to order [S2] | Tile grid in merit-ui: value, target, status chip (red / amber / green with an icon as well as colour, for accessibility), 12-period sparkline, click → driver tree |
| U2 | **Report-pack designer** | Fathom drag-and-drop editor, templates reused across companies, images and PDFs embedded [S5]; Reach brandable templates [S8] | Block-based pack builder (statement, chart, KPI grid, commentary, image, page break); template library per vertical; apply to N entities at once |
| U3 | **AI executive summary at the top of every pack** | Digits [S12], Spotlight [S10], Fathom AI Commentary Writer [S5] | 5–7 bullets: what happened, why, what to do; every sentence footnoted to the numbers it cites |
| U4 | **Drill from any number to the transaction** | Sage Intacct, Campfire [S15][S36] | Universal; side-panel drill so context isn't lost |
| U5 | **Commentary and annotations that persist** | Digits line comments [S11], Abacum owner commentary [S34] | @mention a budget owner on a variance; reply threads; resolved state; included in the PDF |
| U6 | **Period-over-period sparklines in every row** | [practice] (Tufte-style) | Optional 12-month sparkline column on IS and BS rows |
| U7 | **Scenario canvas with draggable timeline** | Runway [S13] | Drag hire, equipment purchase or job start along a timeline; cash and covenant lines recompute live; side-by-side scenario columns |
| U8 | **Click a day on the cash chart → see the items** | Xero short-term cash flow [S39] | Day and week bars expand to the AR and AP items composing them; drag an invoice to a new expected date |
| U9 | **Benchmarks vs industry** | LivePlan NAICS by size and region [S42], Syft [S38] | Percentile dot next to each ratio; source and peer set disclosed |
| U10 | **Company and client ranking heat map** | Fathom company ranking [S3] | Entities × KPIs grid, coloured by percentile; the core view for Merit's portfolio and firm tenants |
| U11 | **Materiality-filtered flux list** | Rillet [S35] | Thresholds by $ and %; unexplained flagged variances block close sign-off |
| U12 | **Right-click "explain" on any cell** | Planful AI Analyst drill from AI output [S33] | Right-click or keyboard "?" opens an explanation panel with top contributing transactions |
| U13 | **Live, not month-end** | Digits live reports [S12], Puzzle daily [S37] | Statements update on post, with a "draft / unclosed period" watermark |
| U14 | **Role-based home dashboards** | Sage Intacct role dashboards [S59]; Brex widget dashboard [S44] | Owner (density-report): cash, profit, KPIs, alerts. Controller (cockpit): close, recs, exceptions. PM: WIP and fade |
| U15 | **Waterfalls as the default variance visual** | FTI PVM GM bridge [S55] | One waterfall component for EBITDA, GM, cash and NI→CF bridges |
| U16 | **Portal publishing for clients and lenders** | Double client portal [S40] | Publish pack → client or lender sees a live, permissioned view with a comments channel |
| U17 | **Keyboard-first, dense cockpit tables** | Merit design system (density-cockpit) | Frozen headers, column pinning, j/k row nav, export of the current view |

---

## 5. AI-native ideas (where Merit can lead, since it owns the GL)

Each idea needs guardrails: every number cited is traced to a query, AI text is labelled as draft until a human approves it, and actions are logged to `ai_decisions` (consistent with the Campfire and Intuit "human review before posting" posture [S36][S24]).

| # | Idea | Description | Competitive status |
|---|---|---|---|
| AI1 | **Auto month-end commentary** | At close sign-off, generate the narrative for the pack: headline results, top 5 variances with causes found in the transactions (e.g. "Materials +$42k: three Ferguson invoices on Job 2231 coded to COGS-Materials"), cash story and risks. Footnoted, editable, approval-gated | Digits, Spotlight, Fathom, Campfire all do commentary [S12][S10][S5][S36]. Merit's edge is transaction-level citations across jobs and dimensions |
| AI2 | **"Explain this variance"** on any cell | Decompose the variance by dimension (which job, vendor or department), by driver (price vs volume vs timing vs misclassification) and by one-off vs recurring; link the top transactions | Rillet auto-explains flux [S35]; nobody publicly does driver decomposition plus misclassification detection |
| AI3 | **Anomaly callouts** | Inline flags: unusual account balances, sign flips, sudden vendor price changes, duplicate-looking bills, jobs whose fade accelerates, expense lines outside seasonal bands | Digits, Mosaic Arc, Intuit [S11][S29][S24] |
| AI4 | **Natural-language ad-hoc reports** | "Gross margin by job for Heartland, Q3 vs Q2, only jobs over $50k": generate the report definition (not free text) so it's saved, editable, schedulable and drillable | Intuit Intelligence, Campfire, Pigment [S24][S36][S31]. Generating a saved definition (vs a chat answer) is the differentiator |
| AI5 | **Forecast confidence bands** | P10/P50/P90 on revenue, cash and covenant metrics, from historical volatility, AR payment behaviour and backlog burn; "probability of breaching DSCR covenant in the next 2 quarters = 18%" | No surveyed SMB tool publishes probabilistic bands; Jirav's Auto-Forecast is a point estimate [S27]. **Open lane** |
| AI6 | **Recommended actions** | Ranked by $ impact: collect these five invoices (predicted late), take these early-pay discounts, renegotiate a rising-price vendor, rebill underbilled job 2231, delay a capex event to keep covenant headroom. Each links to the action screen | Ramp ranks savings [S43]; cross-domain action lists are an open lane |
| AI7 | **Fade early-warning (construction)** | Predict GP fade from cost-burn rate vs % complete, CO lag and PM history before it shows up on the WIP | No surveyed tool does this. High value for surety relationships [S47][S48] |
| AI8 | **Predicted customer pay dates** | Per invoice, feeding the 13-week forecast and collections priority | [practice]; adjacent to collections tools |
| AI9 | **Board-question pre-emption** | "Questions your board or lender will likely ask", generated from the variances, with draft answers | Open lane |
| AI10 | **Close-quality guardrail** | Before sign-off, AI checks flux coverage, unreconciled accounts, suspicious reclasses and stale accruals, and produces a close-readiness score | Rillet and Campfire close modules [S35][S36] |
| AI11 | **Adjusted-EBITDA add-back finder** | Suggest normalisation candidates (owner perks, one-time legal, non-recurring repairs) with evidence, for lender and M&A packs | Open lane; highly relevant to a holding company with 17 portfolio companies |
| AI12 | **Scenario from a sentence** | "What if we hire two techs in March and lose the Casey's contract?" → scenario object on the canvas (Merit already has NL-scenario stubs) | Vena agents build plans from prompts [S32]; Pigment Planner [S31] |
| AI13 | **Report Q&A that stays inside the report** | Ask questions about the open report; the answer cites rows and opens drill panels | Planful AI Analyst [S33] |
| AI14 | **Benchmark interpretation** | Explain where the company sits vs peers and which lever closes the gap | Open lane |

---

## 6. Suggested build tiers (for the auditor to turn into FPBs)

**P0: depth on what owners, controllers and lenders look at monthly**
- Report engine contract (§3): period/compare engine, dimension engine, universal drill, saved views, PDF/XLSX, schedule.
- A1–A10 statements with comparatives, multi-period, by-dimension and BvA. A7 consolidated with eliminations.
- B3 13-week cash forecast, B5 runway. C1–C3 aging + DSO/BPDSO/ADD + CEI. C5 concentration.
- E1 WIP with GL tie-out (E2), E3 fade, E5 backlog, E6 retainage, E14 construction scorecard.
- G1 KPI scorecard with targets and status, G5 DSCR, G6 covenant headroom, G8 adjusted-EBITDA bridge.
- H1 flux with materiality + AI1 auto-commentary + AI2 explain-variance.
- J1 management pack designer + J3 lender pack.

**P1: FP&A and advisory**
- I1–I7 driver budget, headcount, 3-way forecast, rolling forecast, scenario canvas (U7).
- D1 customer profitability with whale curve, D6 GM bridge (PVM), H2/H3 waterfalls.
- K1–K7 practice reports. G10/G11 benchmarks and portfolio ranking. AI4 NL→saved report, AI5 confidence bands, AI6 recommended actions.

**P2: specialist depth**
- E4/E7–E13 deeper construction, F1–F7 vertical packs, L-series controls dashboards, M tax, N labour, O spend analytics, two-way spreadsheet sync, AI7 fade early-warning, AI9, AI11, AI14.

---

## 7. Sources

Vendor sources are self-reported. Review-site and aggregator sources are third party but often repeat vendor copy.

- [S1] Fathom, KPI tracking: https://fathomhq.com/features/kpi-tracking
- [S2] Fathom, KPI Explorer (help): https://support.fathomhq.com/en/articles/999198-kpi-explorer
- [S3] Fathom, Features: https://www.fathomhq.com/features
- [S4] Fathom, Management reporting: https://www.fathomhq.com/features/management-reporting
- [S5] Fathom, Using the report editor: https://support.fathomhq.com/en/articles/1406050-using-the-report-editor ; webinar (images/PDFs): https://www.fathomhq.com/webinars/new-in-fathom-more-powerful-management-reporting-with-images-and-pdfs
- [S6] ERP Research, Fathom profile: https://erpresearch.com/erp-add-ons/reporting-tools/fathom
- [S7] Reach Reporting AI press release: https://www.pr.com/press-release/917480
- [S8] ERP Research, Reach Reporting: https://erpresearch.com/erp-add-ons/reporting-tools/reach-reporting
- [S9] FitGap, Reach Reporting: https://us.fitgap.com/products/051448/reach-reporting
- [S10] Xero App Store, Spotlight Reporting: https://apps.xero.com/uk/app/spotlight-reporting ; https://apps.xero.com/us/app/spotlight-reporting
- [S11] Digits, AI Financials / Reports: https://digits.com/product/reports
- [S12] Digits, Month-end close: https://digits.com/product/month-end-close
- [S13] Runway, A new way to plan scenarios: https://runway.com/blog/a-new-way-to-plan-scenarios
- [S14] Runway, llms.txt product summary: https://runway.com/llms.txt
- [S15] Sage Intacct, Financial reporting capabilities: https://www.sage.com/en-ca/sage-business-cloud/intacct/product-capabilities/extended-capabilities/financial-reporting/
- [S16] Percipient, Sage Intacct Dashboards & Reporting datasheet: https://percipient.co.uk/wp-content/uploads/2023/10/Sage-Intacct-Dashboards-Reporting-Datasheet-FINAL.pdf
- [S17] Vision33, Sage Intacct reporting and dashboards: https://blog.vision33.com/become-a-true-champion-in-your-organization-with-powerful-reporting-and-dashboards
- [S18] Oracle NetSuite, KPI Scorecards: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1521390306.html
- [S19] Oracle NetSuite, Key Performance Indicators: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N595760.html
- [S20] Oracle NetSuite, SuiteAnalytics documentation summary: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4347514288.html
- [S21] Oracle NetSuite Analytics Warehouse: https://docs.oracle.com/en/cloud/saas/netsuite-analytics-warehouse/nsawa/oracle-netsuite-analytics-warehouse.html
- [S22] Intuit, QBO Advanced custom insights: https://quickbooks.intuit.com/au/blog/product-update/quickbooks-online-advanced-custom-insights
- [S23] Certum Solutions, QBO Advanced reporting features: https://www.certumsolutions.com/library/welcome-new-qbo-advanced-reporting-features-as-the-sun-sets-on-fathom
- [S24] The Retail Exec, QBO Intuit Intelligence deep dive: https://theretailexec.com/partner-spotlight/intuit-quickbooks-online_133411/quickbooks-online-intuit-intelligence-feature-deep-dive-how-it-works/
- [S25] Fit Small Business, Intuit Assist explained: https://fitsmallbusiness.com/intuit-assist-explained/
- [S26] Jirav, Workforce planning guide: https://help.jirav.com/workforce-planning-guide
- [S27] Jirav, Rolling forecasts: https://www.jirav.com/rolling-forecasts
- [S28] Jirav, Budgeting & forecasting: https://jirav.com/business-planning-budgeting-forecasting
- [S29] Mosaic, Financial analysis: https://mosaic.tech/workflow/financial-analysis ; Cube review of Mosaic: https://www.cubesoftware.com/blog/mosaic-fpa
- [S30] Cube, Platform: https://www.cubesoftware.com/platform ; Spreadsheet-native: https://www.cubesoftware.com/blog/spreadsheet-native
- [S31] Pigment, AI agents: https://www.pigment.com/ai ; https://pigment.com/blog/ai-agents-announcement
- [S32] Vena, AI for FP&A demo: https://get.venasolutions.com/vena-ai-demo/
- [S33] Planful, AI Analyst: https://help.planful.com/docs/planful-ai-analyst
- [S34] Abacum, Variance analysis: https://www.abacum.io/?p=3502 ; CFO Shortlist, Abacum: https://www.cfoshortlist.com/vendors/abacum
- [S35] Rillet, AI flux analysis: https://www.rillet.com/blog/ai-flux-analysis-variance-investigation-that-does-the-work-for-you
- [S36] Campfire, Ember: https://campfire.ai/ember ; CPA Practice Advisor, Ember agents (2026-03-20): https://www.cpapracticeadvisor.com/2026/03/20/campfire-introduces-ember-agents-for-accounting-teams/180023/
- [S37] Puzzle, Puzzle vs Campfire: https://puzzle.io/blog/puzzle-vs-campfire
- [S38] Sage Marketplace, Syft Analytics: https://us-marketplace.sage.com/en-US/apps/53231/syft-analytics ; Xero, Syft: https://www.xero.com/my/syft-from-xero/
- [S39] Xero blog, Xero Analytics Plus: https://blog.xero.com/product-updates/xero-analytics-plus
- [S40] Double: https://www.doublehq.com ; Getting started: https://help.doublehq.com/en/articles/6623897-getting-started-guide
- [S41] Karbon, Insights: https://karbonhq.com/product/insights ; Business analytics: https://karbonhq.com/business-analytics
- [S42] Retail TouchPoints, LivePlan financial benchmarks: https://www.retailtouchpoints.com/features/solution-spotlight/liveplan-adds-new-financial-benchmarks-feature-to-business-planning-solution
- [S43] Ramp, Price Intelligence: https://support.ramp.com/hc/en-us/articles/17522214341523-Price-Intelligence-on-Ramp ; Spend analysis: https://ramp.com/spend-analysis-software
- [S44] Brex, Reporting: https://www.brex.com/platform/reporting ; Brex support: https://brex.com/support/brex-reporting
- [S45] Foundation Software, WIP over/under billing: https://www.foundationsoft.com/?p=11218 ; Construction accounting: https://www.foundationsoft.com/construction-accounting-software
- [S46] Corpay, The construction WIP report: https://www.corpay.com/resources/blog/construction-wip-report
- [S47] AAFCPA, WIP is a strategic tool: https://aafcpa.com/2015/07/29/the-construction-work-in-process-wip-is-a-strategic-tool-not-simply-a-compliance-schedule/
- [S48] HBK CPAs, KPIs for contractors: https://hbkcpa.com/insights/building-success-essential-key-performance-indicators-kpis-for-contractors/
- [S49] JMCO, Construction KPIs: https://www.jmco.com/articles/construction/construction-kpis-for-business-growth/
- [S50] LiveFlow, Construction CFO 6-metric scorecard: https://liveflow.com/blog/construction-cfo-kpis-the-6-metric-scorecard-every-gc-and-specialty-trade-should-track
- [S51] Buildertrend, WIP report FAQs: https://buildertrend.com/help-article/work-in-progress-report-faqs/ ; Job costing budget: https://buildertrend.com/?p=110287
- [S52] Procore, Budget Forecast report: https://support.procore.com/faq/how-does-the-budget-forecast-report?mt-view=f1 ; Forecast to complete: https://support.procore.com/products/online/user-guide/project-level/budget/tutorials/use-the-forecast-to-complete-feature
- [S53] ServiceTitan, Technician scorecards: https://help.servicetitan.com/docs/technician-scorecards ; Mobile scorecard: https://help.servicetitan.com/docs/use-mobile-scorecard
- [S54] Wise, AR metrics (BPDSO/ADD/CEI): https://wise.com/gb/blog/accounts-receivable-performance-metrics ; Credit Research Foundation summary: https://www.crfonline.org/?p=1827
- [S55] FTI Consulting, A quantifiable approach to price-volume-mix analysis: https://www.fticonsulting.com/insights/white-papers/quantifiable-approach-price-volume-mix-analysis
- [S56] Phoenix Strategy Group, Construction KPI dashboard guide: https://phoenixstrategy.group/blog/construction-kpi-dashboard-guide
- [S57] QuickBooks, Construction reporting (midsize): https://quickbooks.intuit.com/r/midsize-business/construction-reporting/
- [S58] Spotlight Reporting, Features: https://www.spotlightreporting.com/additional-blog-tags/features
- [S59] Sage Intacct, Financial reporting dashboards: https://www.sage.com/en-ca/sage-business-cloud/intacct/financial-reporting-dashboards/

**Gaps in this research.** No primary documentation was found for Reach Reporting's pack designer internals, Procore WIP specifically, or Spotlight's traffic-light formatting. A full list of Foundation's standard reports was not found. All competitor claims should be validated in demos before being cited externally.
