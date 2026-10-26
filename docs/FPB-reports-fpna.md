# Feature Product Brief — Reports & FP&A (report library, AI analysis, budgeting, packs)

**Module:** Books · Planning & reports (IA-SPEC §3.6.1 group "Planning & reports"; consolidated context §3.6.5)
**Extends:** `docs/FPB-financial-reports.md` (GATE 7: statement correctness, dimensions, consolidation, exports). That
brief still owns statement *correctness*; this one owns the **breadth of the library, the analysis layer, budgeting and
delivery**. Where they overlap, the correctness rules in FPB-financial-reports win.
**Author:** FP&A product design pass, 2026-10-20 · **Status:** proposed — needs owner ratification (§10)
**Boards:** `design-studio/v2/R1-reports-home.html`, `R2-report-view.html`, `F1-budget-builder.html`,
`F2-fpna-analysis.html` (built by `design-studio/v2/_build/r1.py`, `r2.py`, `f1.py`, `f2.py` on `rf_common.py` + `rf_data.py`;
every total on the boards asserts).

**Owner asks this brief answers (2026-10, verbatim intent):**
1. "The report and FP&A tab need the most robust and helpful reports, graphs, etc. that AI could conjure up." → §1, §2, §3.
2. "We need the ability to upload budgets." → §4.3 (upload with mapping; builds on the existing `lib/budgets/import.ts`).
3. "We should be able to update budget templates, or you could recommend some under the FP&A tab." → §4.4–4.5.
4. "I have department budgets that we are creating — would like to offer that option to clients." → §4.6–4.7
   (department budgets with owners, submit → review → approve, monthly BvA pushed to department heads). It is a
   tenant-level capability, so any firm can offer it to its clients; nothing is Merit-specific.

---

## §0. Grounding

### 0.1 Canon rules this module must not break
- **Reports read posted ledger only** (`gl_entries.status = 'POSTED'`), through the RLS client (`createServerSupabase()`),
  never the admin client (FPB-financial-reports D15; S41 report-route RLS sweep).
- **Accounts by role, not number.** Seven account types (no `EXPENSE`). Cash-flow and KPI definitions resolve accounts
  by role/subtype/flag; a tenant with a different numbering must get the same answer (FPB-fr AC1.3).
- **AI proposes facts; deterministic code computes; a human approves.** Every number in an AI-written sentence comes from
  a deterministic computation that is shown beside it (the "note" pattern, design README §5 rule 7). With AI off, the
  numbers, bridges and drivers still render; only the prose is replaced by a rule-written sentence labelled
  "Computed (AI unavailable)" (existing `narrative-panel.tsx` behaviour).
- **AI goes through the Core gateway** (`@meritbooks/core-ai`), metered to `core.ai_usage_log`, inside the tenant budget.
- **Money is bigint cents**; budgets, drivers and scenario outputs too. Percentages are stored as basis points.
- **Never "portfolio"** in UI or templates. Clients, companies, consolidation groups, compare sets (IA §1.1).
- **Retired, do not rebuild:** overhead/burden-rate allocation, chargebacks, labor classifications. Department budgets
  here are *plans for a department's own revenue and spend*, never a cost-allocation engine. Shared costs stay where they
  are booked; inter-department services move through internal invoices (CON-05/06) and eliminate in consolidation.

### 0.2 What the code already has (checked against the repo, 2026-10-20)
| Area | In code | Gap that matters here |
|---|---|---|
| Report catalog | `app/(app)/reports/report-viewer.tsx` — 32 report keys in 6 groups (Financial, AR, AP, Jobs, Management, Tax) | Organised by module, not by question; no favourites, owners or status; dept/class pivots can't take their parameter (FPB-fr D4.1) |
| Statements & sub-ledger routes | `app/api/reports/*` — 26 routes (income-statement, balance-sheet, cash-flow, cash-flow-direct, pnl-by-month, consolidated, ar/ap aging, wip, job-cost, job-profitability, debt-schedule, equity-*, gl-detail, transaction-list, open-items, sales/income by customer, expense-by-vendor, customer/vendor balances, narrative, board-package, packs, compile, export, views) | Comparatives defective (D3.1), no BS comparative, consolidated eliminations informational only (D5.1) |
| Variance & narrative | `lib/reports/variance.ts`, `variance-cash.ts`, `api/reports/narrative`, `narrative-panel.tsx` | Variance is account-level only; no driver bridge (price/volume/mix/rate), no department view |
| NL report compiler | `lib/reports/compiler/{parse,spec,run}.ts` — 7 report types, fiscal-period descriptors, abstains when unsure | Can't answer ad-hoc metric questions ("which installs lost money"); no lineage shown to the user |
| Packs | `public.report_packs` (mig 104), `lib/reports/compiler/packs.ts`, `pack-email.ts`, `/api/reports/packs/run-scheduled` | **No scheduler** (INT-01); MONTHLY/QUARTERLY only; no approve-before-send; no delivery log; PDF/XLSX only |
| Board package | `lib/reports/board-package.ts` (1,019 lines: KPI summary, variance lines, trend points), `/board-package` | Fixed sections; no cover/branding editor; no PowerPoint |
| Exports | `lib/reports/export/{csv,xlsx,statement-pdf}.ts` | No PPTX; no branded template |
| Saved views | mig 138 `report_views`, `saved-views.tsx` | Per report only; no shared/role defaults |
| Basis | mig 147 basis adjustments, `lib/reports/basis/derive-{cash,tax}.ts` | — |
| FP&A dashboard | `/fpna`, `lib/fpna/dashboard.ts` (16 KPIs: margins, burn, runway, working capital, current ratio), `kpi-config.ts` (layouts controller/cfo/owner) | No industry KPIs, no operational (non-GL) metrics, no benchmarks |
| Budgets | `public.budgets` (mig 013: org × location × account × department × FY × period, cents), `budget_versions` (013, **not read by BvA**), `/budgets` entry grid, `budget-import.tsx` + `lib/budgets/import.ts` (CSV/XLSX, monthly or annual layout, auto-map, deterministic) | No owners, no submission/approval, no templates, no versions in use, no headcount/capex, no rolling forecast storage |
| Drivers / reforecast / scenarios | `/budgets/drivers`, `/budgets/reforecast`, `/fpna` NL scenarios; **drivers and scenarios persist as rows in `ai_decisions`** | Planning objects stored in the AI audit table; no versioning; scenarios can't be compared side by side or applied to a version |
| Profitability | `/profitability` (by client) | No department/customer/item/segment |
| Covenants, BBC, forecast | `lib/covenants`, `lib/borrowing-base`, `lib/forecast/{driver-forecast,cash-flow-direct}.ts` | Covenant forecast not wired to scenarios |

Migrations in the repo run through **154**; the next Books migration is **155** (CANON-ANCHOR says 149/150 — it is stale;
the lead should update it).

### 0.3 What best-in-class does (research, Oct 2026)
| Product | What we take from it |
|---|---|
| **Fathom** | Central KPI library applied to any company; custom KPI builder incl. non-financial data; 90+ charts; report templates with auto-text placeholders; AI commentary writer where every figure traces to source; admin-managed prompt library; scheduled, branded delivery. |
| **Reach Reporting** | Spreadsheet-like builder with Excel formulas; brandable template library; KPI cards with targets; rolling forecasts and 3-way model; white-label client portal; AI variance narrative (reviews say it needs work). |
| **Spotlight** | Consolidation up to 50 (Multi: 500) entities; rank-and-benchmark entities, highlight underperformers; industry/franchise benchmarking. |
| **Jirav** | Share sections of the budget with department heads, auto-consolidate; workforce planning by named hire or formula with burdened cost; driver-based planning only on higher tiers. No formal approval workflow found. |
| **Cube** | Budget loaded by spreadsheet publish or CSV with on-screen mapping and validation; department owners get permissioned templates and a status tab. |
| **Datarails** | Templates sent to budget owners, controlled submission, consolidation into a master model, version history, comments, approvals — all in Excel. |
| **Mosaic (HiBob)** | Headcount planner modelling payroll by team/region flowing to margin; versioning; approvals lighter than enterprise suites. |
| **Runway (now cfo.ai)** | Branching scenarios (main/upside/downside); every figure traceable through formulas to source rows; unverified figures labelled rather than signed off. |
| **LivePlan** | Budget vs actual "scoreboard"; benchmarks by NAICS, region and revenue size (margins, days to get paid/pay, inventory). |
| **Planful / Syft / Qvinci** | Planful: structured planning and approvals at enterprise depth (overhead is the complaint). Syft and Qvinci: standardized chart mapping across many companies so benchmarks and roll-ups compare like with like. (Their own docs weren't retrievable in this pass; positioning is from secondary sources.) |

**Where MeritBooks wins:** it *is* the ledger. Every one of these tools syncs from QuickBooks/Xero and reports on a copy.
MeritBooks reports, budgets and forecasts on the book of record, so: (a) drill goes from chart → statement line → journal
entry → source document without leaving the product; (b) "committed" can come from signed jobs, POs and agreements in
the same database; (c) department budgets use the same department dimension the bookkeeper posts to; (d) the close
status is known, so every report can say whether its period is final.

Sources: [Fathom management reporting](https://www.fathomhq.com/features/management-reporting) ·
[Fathom features](https://www.fathomhq.com/features) · [Fathom prompt library](https://support.fathomhq.com/en/articles/13909853-prompt-library) ·
[Reach Reporting (ERP Research)](https://erpresearch.com/erp-add-ons/reporting-tools/reach-reporting) ·
[Spotlight consolidation](https://helpdocs.spotlightreporting.com/multi/product-for-consolidation) ·
[Jirav departmental budgeting](https://www.jirav.com/departmental-budgeting) · [Jirav workforce planning](https://help.jirav.com/workforce-planning-guide) ·
[Cube budget loading](https://help.cubesoftware.com/hc/en-us/articles/5439062721044) · [Cube budget best practice](https://help.cubesoftware.com/hc/en-us/articles/19972271857172) ·
[Datarails budgeting](https://www.datarails.com/solutions-budgeting/) · [Mosaic/Conosco case](https://www.casestudies.com/company/hibob/case-study/conosco-uses-mosaic-to-optimize-client-service-profitability) ·
[Runway / cfo.ai](https://www.getaleph.com/answers/runway-alternatives-financial-planning) · [LivePlan (TrustRadius)](https://www.trustradius.com/products/liveplan).

---

## §1. Report library — 175 reports

**How the library is organised.** By the question the reader is asking, not by the module that produced the data
(R1 board). Each family below is one shelf in `/reports`. A report appears to a role only if the role holds its view
capability for the client(s) in scope (05-RBAC; the row is not rendered otherwise).

**Columns.** *Audience*: OW owner · CFO · CTL controller · FD finance director · DH department head · BK bookkeeper ·
AM accounting manager · AU external auditor · LV lender viewer · HR payroll. *Source*: the existing route/lib it reads,
or the engine it needs. *Status*: **Live** = route exists on real data · **Partial** = exists with a named gap ·
**New** = to build. Every report is available per client, per consolidation group (where the IA allows a total), and as a
compare set (side by side, never summed, IA §3.11).

**Every report, without exception:** fiscal-period picker (FPB-fr D2) · compare columns (prior period like-for-like,
prior year, budget/forecast version) · drill to GL detail and source document · basis toggle where meaningful (accrual,
cash, tax) · "period is final / preliminary" stamp from close status · export PDF, XLSX, CSV, and PPTX for chart reports ·
save as view · add to pack · schedule.

### 1.1 How did we do? — Statements & variants (24)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| FS-01 | Income statement (P&L) | Revenue, gross profit, EBITDA, net income for any period | OW CFO CTL FD BK | `api/reports/income-statement` | Live |
| FS-02 | P&L by month | 12 months side by side; trend and seasonality | CFO CTL FD | `api/reports/pnl-by-month` | Live |
| FS-03 | P&L by quarter | Quarters with YTD and full-year columns | OW CFO FD | pnl-by-month, aggregated | New |
| FS-04 | P&L vs prior period | Like-for-like prior period (equal length), variance $ and % | CFO CTL | income-statement compare | Partial (D3.1 computes the wrong prior period) |
| FS-05 | P&L vs same period last year | YoY variance, seasonality-safe | OW CFO FD | income-statement compare | New |
| FS-06 | Common-size P&L | Every line as % of revenue, with prior | CFO FD | income-statement + `lib/reports/percent.ts` | Partial |
| FS-07 | Trailing-12-month P&L | Rolling year; smooths seasonality for lenders and valuation | OW CFO LV | pnl-by-month | New |
| FS-08 | P&L by department (matrix) | Departments as columns, total column, each cell drills | CFO FD DH | income-statement `department_id` | Partial (D4.1/D4.2 no selector, no matrix) |
| FS-09 | P&L by class, location or industry tag | Any dimension as columns | CFO CTL | income-statement `class_id` | Partial |
| FS-10 | Balance sheet | Assets = liabilities + equity at a date | OW CFO CTL BK AU | `api/reports/balance-sheet` | Live |
| FS-11 | Balance sheet comparative | Prior period-end and prior year-end columns, variance | CFO CTL AU | balance-sheet | New (D3.2) |
| FS-12 | Balance sheet by month | 13 month-ends; working-capital trend | CFO CTL | balance-sheet, looped | New |
| FS-13 | Cash flow statement, indirect | Operating, investing, financing from net income | CFO CTL AU LV | `api/reports/cash-flow` | Partial (D1.2 number ranges) |
| FS-14 | Cash flow statement, direct | Cash from customers, to suppliers and employees | CFO OW | `api/reports/cash-flow-direct` | Live |
| FS-15 | Statement of changes in equity | Beginning + activity = ending per equity account | CTL AU | `api/reports/equity-changes` | Live |
| FS-16 | Trial balance | All accounts, debits = credits | CTL BK AU | `api/gl/trial-balance` | Live |
| FS-17 | Adjusted trial balance worksheet | Unadjusted → adjustments → adjusted, by entry | CTL AU | TB + JE by period | New |
| FS-18 | General ledger detail | Every posted line for accounts and dates | CTL BK AU | `api/reports/gl-detail` | Live |
| FS-19 | Transaction list / journal | All transactions by date with source | BK AU | `api/reports/transaction-list` | Live |
| FS-20 | Account roll-forward | Beginning + activity by source + ending for any account | CTL AU | gl-detail | New |
| FS-21 | Cash-basis statements | P&L and BS on cash basis from the accrual ledger | OW CFO | `lib/reports/basis/derive-cash.ts` | Live |
| FS-22 | Tax-basis statements | Book-to-tax adjusted statements | CTL | `lib/reports/basis/derive-tax.ts` | Partial |
| FS-23 | Financial statements with notes | GAAP-presentation set with footnotes, compiled for lenders/CPAs | CFO CTL LV | statements + notes editor | New |
| FS-24 | Equity table | Holders, ownership %, invested, distributions | OW CFO | `api/reports/equity-table` | Live |

### 1.2 What moved, and why? — Management reports (16)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| MG-01 | Monthly management report (flagship, **R2**) | Department P&L vs budget, prior month and prior year, EBITDA bridge, written commentary, drill | OW CFO FD DH | FS-01 + BD-02 + §2 bridge + §3 commentary | New (composes Live parts) |
| MG-02 | Department P&L vs budget — department head edition | One department's revenue, cost and spend vs its own budget, MTD/YTD, top 10 transactions | DH FD | `api/budgets/vs-actual` + department filter | New |
| MG-03 | Flash report | Day-3 preliminary revenue, GP, cash, with "preliminary" stamp | OW CFO | income-statement on soft-closed period | New |
| MG-04 | Weekly operating report | Cash, bookings, billings, collections, AR over 60, payroll this week | OW CFO | cash + ar + payroll | New |
| MG-05 | KPI scorecard | Any KPI set, 13-month trend, target, status | OW CFO FD | `lib/fpna/dashboard.ts` (16 KPIs) + §1.8 | Partial |
| MG-06 | What moved and why (flux) | Top variance drivers, deterministic, worded by AI | CFO CTL FD OW | `lib/reports/variance.ts`, `api/reports/narrative` | Partial (account-level only) |
| MG-07 | Expense trend by account and vendor | Which costs are growing, 13 months | CFO CTL FD | expense-by-vendor + pnl-by-month | Partial |
| MG-08 | Opex run-rate | Monthly recurring spend, annualized, new vs ended | CFO FD | gl-detail + subscriptions | New |
| MG-09 | Headcount & labor cost | Heads, hours, payroll cost by department, vs plan | CFO FD DH HR | payroll register (mig 136) | New |
| MG-10 | Revenue by stream | Service / install / agreements (or any revenue sub-type), trend and mix | OW CFO FD | income-statement by account group | New |
| MG-11 | Customer concentration | Top 10/20 customers, % of revenue, change | OW CFO LV | `api/reports/income-by-customer` | New |
| MG-12 | Vendor concentration & spend cube | Spend by vendor × category × department | CFO CTL | expense-by-vendor | New |
| MG-13 | Price / volume / mix bridge | Revenue change split into price, volume, mix | CFO FD | §2 bridge engine + operational volumes | New |
| MG-14 | Owner one-pager | Cash, profit, AR, the three things to know, on one page | OW | composed | New |
| MG-15 | Subscriptions & recurring spend | Run-rate, price creep, renewals | CTL OW | `/subscriptions` | Live |
| MG-16 | Renewals & obligations | Leases, debt, insurance, contracts due | CFO OW CTL | `/obligations`, `lib/cash/obligations.ts` | Live |

### 1.3 Where do we make money? — Profitability (10)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| PR-01 | Profitability by client | Revenue, GP, EBITDA, margin by client (workspace) | OW CFO AM | `/profitability` | Live |
| PR-02 | Profitability by department | Contribution by department after direct spend | CFO FD DH | income-statement by department | Partial |
| PR-03 | Job profitability | Contract, cost, billed, margin per job | CTL DH | `api/reports/job-profitability` | Live |
| PR-04 | Customer profitability | Revenue − direct cost − cost to serve, by customer | OW CFO | income-by-customer + job cost | New |
| PR-05 | Item / product margin | Margin by item or SKU | CFO DH | invoice lines + inventory | New |
| PR-06 | Contribution margin by service line | Variable margin by line; breakeven volume | CFO FD | department + account roles | New |
| PR-07 | Technician / crew productivity | Revenue and margin per tech, billable % | DH FD | ServiceTitan connector + payroll | New |
| PR-08 | Salesperson / estimator margin | Sold margin vs delivered margin by seller | DH CFO | jobs + estimates | New |
| PR-09 | Segment margin | Residential vs commercial, replacement vs new construction | CFO FD | class/tag dimension | New |
| PR-10 | Location / branch profitability | Branch P&L ranked | CFO FD | location dimension | Partial |

### 1.4 Where is the cash going? — Cash & treasury (12)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| CA-01 | Cash position across clients | Balances vs minimum, per client and group | CFO OW CTL | `/cash`, `api/cash` | Live |
| CA-02 | Daily cash report | Opening, in, out, closing vs minimum | CFO | cash + bank feed | Partial |
| CA-03 | 13-week cash forecast | Weekly direct forecast | CFO OW | `lib/forecast/cash-flow-direct.ts` | Live |
| CA-04 | Forecast with layers | Actual / committed / estimated, confidence band | CFO | `lib/forecast/driver-forecast.ts` | Partial |
| CA-05 | Forecast accuracy | Last 13 weeks forecast vs actual, by line | CFO | forecast snapshots | New (needs snapshot table) |
| CA-06 | Runway & burn | Months of cash at trailing burn | OW CFO | `lib/fpna/dashboard.ts` | Live |
| CA-07 | Cash conversion cycle | DSO + DIO − DPO, trend | CFO LV | AR/AP/inventory | New |
| CA-08 | Bank balance trend | 90-day balance curve, obligations bucketed | CFO | `lib/cash/trend.ts` | Live |
| CA-09 | Min-cash & transfer suggestions | Who drops below minimum, suggested transfer | CFO OW | CASH-03 | New |
| CA-10 | EBITDA-to-cash bridge | Where profit went: working capital, capex, debt, distributions | OW CFO LV | cash-flow + BS | New |
| CA-11 | Capex report | Spend vs plan by asset class and project | CFO CTL | fixed assets + BD-10 | New |
| CA-12 | Seasonal cash curve | Average weekly cash by week-of-year, 3 years | CFO OW | bank history | New |

### 1.5 Who owes us? — Receivables (14)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| AR-01 | AR aging summary | Buckets by customer | BK CFO OW | `api/reports/ar-aging` | Live |
| AR-02 | AR aging detail | Invoice-level aging | BK | ar-aging | Live |
| AR-03 | Open invoices | Unpaid invoices with days overdue | BK AM | `api/reports/open-items` | Live |
| AR-04 | Customer balances | Balance per customer | BK | `api/reports/customer-balances` | Live |
| AR-05 | Income by customer | Revenue and collections per customer | CFO BK | `api/reports/income-by-customer` | Live |
| AR-06 | Sales by customer | Line-item sales per customer | BK DH | `api/reports/sales-by-customer` | Live |
| AR-07 | DSO & collection effectiveness | DSO trend, CEI, best possible DSO | CFO LV | `/collections` | Partial |
| AR-08 | Collections & promises | Worklist, promises due, dunning sent | BK AM | `/collections` | Live |
| AR-09 | Unbilled / contract-asset aging | Earned not billed (1180), by age | CTL CFO | `lib/reports/unbilled-aging.ts` | Live |
| AR-10 | Customer deposits held | Deposits by job and age | CTL BK | `/customer-deposits` | Live |
| AR-11 | Retainage receivable | Held, due for release | CTL CFO | `/retainage` | Live |
| AR-12 | AR collection curve | % collected by days since invoice, by monthly cohort | CFO | invoices + payments | New |
| AR-13 | Bad-debt reserve analysis | Reserve vs aging-based expected loss | CTL AU | ar-aging + history | New |
| AR-14 | Customer statements | Batch statements | BK | customers | Partial |

### 1.6 Whom do we owe? — Payables & spend (14)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| AP-01 | AP aging summary | Buckets by vendor | BK CFO | `api/reports/ap-aging` | Live |
| AP-02 | AP aging detail | Bill-level aging | BK | ap-aging | Live |
| AP-03 | Open bills | Unpaid bills | BK | open-items | Live |
| AP-04 | Vendor balances | Balance per vendor | BK | `api/reports/vendor-balances` | Live |
| AP-05 | Expense by vendor | Spend grouped by vendor | CFO CTL | `api/reports/expense-by-vendor` | Live |
| AP-06 | 1099 summary | 1099-eligible vendors, YTD payments | BK CTL | `/compliance-1099` | Live |
| AP-07 | DPO & payment timing | Paid early / on time / late; discounts captured vs missed | CFO CTL | bills + payments | New |
| AP-08 | Cash requirements | Bills due by week, next 8 weeks | CFO BK | bills | New |
| AP-09 | Open PO commitments | Committed, not received, by department/job | DH CFO | `/purchase-orders` | Partial |
| AP-10 | 3-way match exceptions | PO / receipt / bill variances | BK DH | purchase orders | Partial |
| AP-11 | Check register & outstanding checks | Issued, cleared, stale > 90 days | PC BK | `/checks` | Live |
| AP-12 | Card spend & missing receipts | By cardholder, unsupported $ | BK CTL | `/expenses` | Partial |
| AP-13 | Retainage payable | Held from subs, due for release | CTL | `/retainage` | Live |
| AP-14 | Vendor compliance | W-9/COI missing or expiring, holds | BK AM | `/vendor-compliance` | Live |

### 1.7 How are the jobs doing? — Jobs, WIP & backlog (12)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| JB-01 | WIP schedule | Over/under billing, % complete, earned | CTL CFO LV | `api/reports/wip` | Live |
| JB-02 | Job cost detail | Cost by job, phase, cost code | CTL DH | `api/reports/job-cost` | Live |
| JB-03 | Estimate vs actual by cost code | Where each job is over its estimate | DH CTL | `proj.job_budget_lines` (mig 066) | New |
| JB-04 | Profit fade / gain | EAC margin history per job, month by month | CFO CTL | WIP snapshots | New (needs snapshot) |
| JB-05 | Backlog & burn | Contract value remaining, months of backlog | OW CFO LV | jobs + WIP | New |
| JB-06 | Revenue recognition waterfall | Recognized by month per contract | CTL | `/rev-rec` | Live |
| JB-07 | Deferred revenue roll-forward | 2410 beginning + billed − recognized = ending | CTL AU | `/rev-rec` | Live |
| JB-08 | Change-order log | Pending, approved, unbilled change orders | DH CTL | jobs | Partial |
| JB-09 | Closed-job post-mortem | Estimated vs final margin, cause | DH CFO | jobs + cost | New |
| JB-10 | Surety WIP schedule | Bonding-company format | CFO LV | WIP | New |
| JB-11 | Committed cost by job | Subcontracts and POs committed | CTL DH | `proj` commitments (mig 1003) | Partial |
| JB-12 | Underbilling risk | Cost incurred > 30 days, not billed | CTL BK | WIP + invoices | New |

### 1.8 How do we compare in our trade? — Industry KPI dashboards (13)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| KP-01 | HVAC service | Revenue per call, average ticket, opportunity close rate, first-time fix, tech billable %, callback rate | OW FD DH | ServiceTitan connector + GL | New |
| KP-02 | HVAC agreements | Members, churn, renewal rate, revenue per member, visits due vs done | DH FD | ServiceTitan + GL | New |
| KP-03 | HVAC install | Close rate, average job, equipment % of install, margin per install, backlog days | DH CFO | Buildertrend/ServiceTitan + GL | New |
| KP-04 | Weather-normalized demand | Calls vs degree days, this year vs prior | FD OW | NOAA degree days + calls | New |
| KP-05 | Construction / custom homes | Backlog, WIP fade, billings in excess, margin by home, days to close, change-order % | OW CFO LV | WIP + jobs | New |
| KP-06 | Construction draws | Draws requested vs funded per home and lender | CFO | jobs + debt | New |
| KP-07 | Cabinets & millwork shop | Material yield, shop hours per box, throughput, on-time ship, remakes | DH FD | Innergy connector + GL | New |
| KP-08 | Dealer channel | Sales and margin by dealer, orders in production | OW FD | dealer portal + invoices | New |
| KP-09 | Flooring & interiors | Margin per sq ft (material and install), crew utilization, claims, measure-to-install days | DH FD | RFMS connector + GL | New |
| KP-10 | Kitchen & bath remodel | Lead → design → sale conversion, average project, design-fee capture, deposit coverage, cycle time | OW DH | CRM + estimates + deposits | New |
| KP-11 | Equipment dealer | Unit sales, turns by OEM, floor-plan curtailment exposure, service absorption, aged units > 180 days | OW CFO LV | inventory + debt | New |
| KP-12 | Professional services firm | Fee realization, revenue per FTE, client economics, fee coverage | OW AM | `/insights/economics` (ADM-23) | Partial (planned) |
| KP-13 | Peer benchmark scorecard | Each KPI against opt-in peer quartiles by industry and size | OW CFO | FPA-19 (anonymized cross-tenant) | New (needs consent model) |

### 1.9 How does the group roll up? — Consolidation (9)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| CN-01 | Consolidated income statement | Members, eliminations line, total | CFO OW | `api/reports/consolidated` | Partial (D5.1 eliminations not applied) |
| CN-02 | Consolidated balance sheet | With NCI | CFO AU LV | consolidation engine | New (D5.2) |
| CN-03 | Consolidated cash flow | Group cash flow | CFO LV | consolidation engine | New |
| CN-04 | Consolidating worksheet | Member columns, eliminations column, consolidated | CFO CTL AU | consolidation engine | New |
| CN-05 | Intercompany pair balances | Due-to/due-from that don't match | CTL | `/intercompany` (EC-3) | Live |
| CN-06 | Internal invoices & elimination log | Every eliminating entry with both sides | CTL AU | `/internal-invoices` | Live |
| CN-07 | Compare clients | Side by side, never summed | OW CFO FD | compare sets (M-15) | Partial |
| CN-08 | Ownership & NCI roll-forward | Ownership %, NCI share of income | CFO AU | `entity_ownership` | New |
| CN-09 | Combined group statements | Sister clients summed with eliminations (amendment A2) | CFO | consolidation groups (M-6) | New |

### 1.10 What do lenders and the board see? — Lender, covenant & board (12)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| LD-01 | Covenant compliance | DSCR, FCCR, leverage, headroom | CFO OW LV | `/covenants`, `lib/covenants` | Live |
| LD-02 | Compliance certificate | Signed certificate PDF | CFO LV | `/covenants` | Live |
| LD-03 | Borrowing base certificate | Eligible AR/inventory, availability | CFO LV | `/borrowing-base` | Live |
| LD-04 | Covenant forecast | Projected test results and breach date from the forecast and scenarios | CFO OW | covenants + BD-04/BD-07 | Partial |
| LD-05 | Debt schedule | Balances, rates, maturities, payments | CFO LV | `api/reports/debt-schedule` | Live |
| LD-06 | Maturity & refinance ladder | 24-month ladder | CFO OW | `/debt` | New |
| LD-07 | Lender pack | Financials + certificate + AR aging + BBC, per lender spec | CFO LV | packs + board-package | Partial |
| LD-08 | Board package | MD&A, KPI trend, statements, DSO/DPO | OW CFO | `lib/reports/board-package.ts` | Live |
| LD-09 | Investor update | Quarterly letter tables, distributions | OW CFO | equity + statements | New |
| LD-10 | Normalized EBITDA / QoE bridge | Reported → add-backs → adjusted, each add-back linked to entries | OW CFO | gl-detail + tags | New (FPA-18) |
| LD-11 | Diligence data-room index | The standard request list, generated | OW CFO | composed | New |
| LD-12 | Lender reporting calendar | What is due to which lender, when | CFO CTL | DEBT-08 | New |

### 1.11 Are we on plan? — Budget & forecast (13)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| BD-01 | Budget vs actual | Account-level BvA, MTD/QTD/YTD | CFO FD | `api/budgets/vs-actual` | Live |
| BD-02 | Budget vs actual by department | Department sections, owners, F/U | FD DH CFO | vs-actual + department | Partial |
| BD-03 | Group budget vs actual | Members + eliminations | CFO | FPA-15 | New |
| BD-04 | Reforecast vs budget | 9+3 etc., with layers | CFO FD | `api/budgets/reforecast` | Live |
| BD-05 | Version compare | Budget, forecast v1…vn side by side, changes explained | CFO | `budget_versions` (013, unused today) | New |
| BD-06 | Driver model | Drivers, sources, effect on revenue/EBITDA | CFO FD | `api/budgets/drivers` | Live |
| BD-07 | Scenario compare | Base vs scenarios on revenue, EBITDA, low cash, covenants | CFO OW | `/fpna`, `api/budgets/scenarios` | Live |
| BD-08 | 3-statement pro forma | Projected P&L, BS, CF that balance | CFO LV | FPA-08 | New |
| BD-09 | Headcount plan vs actual | Planned hires, start dates, cost vs payroll actual | CFO FD HR | §4.8 + payroll | New |
| BD-10 | Capex plan vs actual | Projects, spend, timing | CFO | §4.9 + fixed assets | New |
| BD-11 | Budget submission status | Who submitted, overdue, returned | FD CFO | §4.6 | New |
| BD-12 | Rolling 12-month forecast | Next 12 months, refreshed monthly | CFO FD | §4.10 | New |
| BD-13 | Forecast accuracy | Budget and each forecast vs actual, MAPE by line | CFO | version snapshots | New |

### 1.12 What do we owe in tax? — Tax (9)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| TX-01 | Sales tax summary & return worksheet | Collected by jurisdiction, tied to GL | BK CTL | `/sales-tax-return` | Live |
| TX-02 | Sales tax filing calendar | Due, filed, overdue | BK CTL | `/sales-tax-calendar` | Live |
| TX-03 | 1099 readiness | W-9 gaps, file status | BK CTL | `/compliance-1099` | Live |
| TX-04 | Book-to-tax (M-1/M-3) | Differences, permanent vs temporary | CTL | `/book-to-tax` | Live |
| TX-05 | Tax provision (ASC 740) | Current + deferred, roll-forward | CTL AU | `/tax-provision` | Live |
| TX-06 | Return package | 1120-style package for the CPA | CTL AU | `/tax-package` | Live |
| TX-07 | Tax depreciation | Book vs tax, by asset | CTL | `/tax-depreciation` | Live |
| TX-08 | Estimated tax & distribution planning | Quarterly estimates for pass-through owners | OW CFO | tax basis + equity | New |
| TX-09 | Nexus exposure | States approaching thresholds (EC-7) | CTL | compliance detectors | Live |

### 1.13 Are the books right? — Close & controls (10)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| CL-01 | Close status | Checklist, owners, blockers | CTL AM | `/close` | Live |
| CL-02 | Reconciliation summary | Every balance-sheet account, reconciled through | CTL AU | `/reconciliation` | Live |
| CL-03 | Subledger-to-GL tie-out | AR, AP, inventory, payroll liabilities vs GL | CTL AU | S50 tie-out | Live |
| CL-04 | Exceptions | Open EC detector findings | CTL AM | `/exceptions` | Live |
| CL-05 | Manual journal entry log | By preparer, size, posted after close | CTL AU | journal entries | Partial |
| CL-06 | Period lock & reopen log | Who reopened what, why | CTL AU | `/periods` | Live |
| CL-07 | Flux review worksheet | Accounts over threshold, explanation, reviewer sign-off | CTL AU | variance.ts + sign-off | New |
| CL-08 | AI decision log | Proposals, overrides, autonomy settings | CTL AU | `/ai-decisions` | Live |
| CL-09 | Approvals & segregation of duties | Approval chains, self-approval attempts | CTL AU | approvals + RBAC | Partial |
| CL-10 | Schedules | Prepaids, accruals, fixed assets, leases, insurance | CTL BK | `/prepaids` `/fixed-assets` `/leases` `/insurance` | Live |

### 1.14 What will the auditor ask for? — Audit (7)
| ID | Report | Answers / purpose | Audience | Data source | Status |
|---|---|---|---|---|---|
| AU-01 | Audit trail by record | Who did what, when, human/AI/system | CTL AU | `/audit` | Live |
| AU-02 | PBC list | Requested, provided, open | CTL AU | `/pbc` | Live |
| AU-03 | Lead schedules | TB grouped by statement line, prior year, tickmarks | AU CTL | TB | New |
| AU-04 | Journal entry testing extract | Every JE with attributes for sampling | AU | journal entries | New |
| AU-05 | Year-end close package | Year-end entries and roll | CTL AU | `/year-end-close` | Live |
| AU-06 | Inventory valuation & tie-out | Valuation vs GL | CTL AU | `/inventory` | Live |
| AU-07 | Fixed-asset roll-forward | Beginning + additions − disposals − depreciation | CTL AU | `/fixed-assets` | Partial |

**Totals.** 175 reports: **71 Live**, **29 Partial**, **75 New** (counted from the tables above by `_build/rf_catalog.py`,
which R1 reads for its shelf counts).

### 1.15 KPI library (the metrics behind §1.8, MG-05 and the widgets)
Every KPI is a stored definition: `name · formula over account roles and/or operational metrics · unit · direction
(higher/lower is better) · period behaviour (flow/stock/average) · target · industry tags · source of each input`.
The 16 KPIs in `lib/fpna/kpi-config.ts` become the first rows. Tenants add their own with the formula builder (§5.1);
non-GL inputs (calls, members, sq ft, units) come from connectors or a monthly metric upload (`fpa.metrics`, §6).
Recommended sets by industry ship as **KPI packs**: HVAC (KP-01..04), Construction (KP-05..06), Cabinets & millwork
(KP-07..08), Flooring & interiors (KP-09), Kitchen & bath (KP-10), Equipment dealer (KP-11), Services firm (KP-12),
plus a universal finance pack (margins, EBITDA %, DSO, DPO, DIO, CCC, current ratio, debt/EBITDA, DSCR, runway, revenue
per employee, opex % of revenue).

#### 1.15a Registry & analytics contract (Wave 3B amendment, 2026-10-24)
Built as pure, tested TypeScript in `apps/web/src/lib/metrics/**` (registry, expression language, evaluator, data-source
interface) and `apps/web/src/lib/analytics/**` (bridges, variance, growth, seasonality, league, concentration, anomaly,
forecast, flux helper). No migration; storage for tenant-defined KPIs, add-back schedules and `fpa.metrics` uploads is
deferred to the slices that own those tables (Wave 4A/4B).

- **Definition shape.** Each registry entry carries: `key` · plain-English `name` · `definition` sentence · `formula` as a
  **typed expression tree** over named inputs (account *classes* resolved by role/sub-type, GL flows and balances,
  budget flows, operational inputs from sub-ledgers, other metrics, time shifts) · `unit` (money / percent / ratio /
  days / count / times / months / points) · `direction` (higher better / lower better / neutral) · `period` (flow,
  balance or mixed; request basis or a fixed basis such as TTM) · `requires` (gl, budget, headcount, jobs, ar_subledger,
  ap_subledger, inventory, dealer, practice, addbacks, covenants) · optional benchmark `bands` (with source) ·
  `audiences` (owner, cfo, controller, lender, construction, dealer, practice). The human formula string is **generated
  from the tree**, so the (i) tooltip can never disagree with the computation.
- **Unavailable states** (a card says why in words, never a fabricated 0): `not_enough_history` (with months on file),
  `not_on_file`, `not_mapped` (names the missing account role/class), `not_meaningful` (base ≤ 0, sign flip, cash-generating
  for runway), `no_approved_budget`, `no_jobs`, `zero_denominator`. **Preliminary** (period after books-closed-through) is a
  flag on an OK value, not a failure.
- **Evaluation.** `evaluate(metric, {companies, weighting, periodEnd, basis, comparison, sparkline})` returns value,
  comparison value, change ($ and %, or **points** for percent metrics; % is n/m when the base ≤ 0 or the sign flips),
  a verdict word (**improvement / erosion** vs prior period or prior year; **favourable / unfavourable** vs budget;
  higher / lower for neutral metrics; unchanged), a sparkline (12 or 24 month-ends, **null for a gap, never 0**), status,
  and a drill reference (statement line + account ids per input class, or the sub-ledger source).
- **Scope.** One company, any selection (added together), or **ownership-weighted** (each company × its effective
  `entity_ownership.ownership_percent`; companies with no ownership row are assumed 100% and named). Ratios are computed
  on the combined inputs, never by averaging company ratios. A company contributes only when every month the formula
  touches is on file (like-for-like growth); excluded companies are listed with the reason. No figures before a
  company's "in group from" month.
- **Data access** goes through a `MetricDataSource` interface: (a) the current adapter over existing RLS-scoped GL /
  sub-ledger queries, (b) a stub for the 3A period-balances API, switched by the lead. The evaluator itself is I/O-free.

**Acceptance criteria (Wave 3B; each is a unit test in `lib/metrics/*.test.ts` or `lib/analytics/*.test.ts`):**
- AC-K1 The registry holds **≥ 80** metrics; every key is unique; every expression references only defined inputs and
  metrics (no cycles); every entry has a name, definition, unit, direction, ≥ 1 audience and a generated formula string.
- AC-K2 Covered families: revenue / GP / EBITDA / adjusted EBITDA (documented add-backs); gross, operating, net, EBITDA
  margins; MoM / YoY / CAGR 1-3-5y (TTM-to-TTM); current, quick, cash ratio, working capital, burn, runway, days cash,
  CCC; DSO, best-possible DSO, ADD, CEI, DPO, DIO, AR/AP/inventory turnover, revenue and EBITDA per employee, payroll %;
  debt/EBITDA, DSCR, FCCR, interest coverage, covenant headroom; ROA, ROE, contribution margin; aging-bucket %, % current,
  top-customer and vendor concentration, HHI, early-pay discount capture; backlog, months of backlog, under/over billings,
  fade, cost to complete, retainage receivable/payable, GP in backlog; floor-plan days, aged units %, warranty receivable
  days; close-cycle days, items per bookkeeper; Rule of 40; operating leverage.
- AC-K3 Worked examples in cents reproduce exactly (margins, EBITDA = operating income + operating D&A, DSO = AR ÷ revenue
  × days, CEI and BPDSO/ADD against the textbook example, DSCR, FCCR, CCC = DSO + DIO − DPO, runway = cash ÷ 3-month burn).
- AC-K4 Each unavailable reason is produced by a test case with the expected plain-English message.
- AC-K5 Direction wording: a lower-is-better metric that falls reads "improvement"; vs budget reads "favourable /
  unfavourable"; percent metrics change in points; % change is n/m on a base ≤ 0 or a sign flip.
- AC-K6 Sparklines return `null` for months not on file (gaps are never drawn as zero) and flag preliminary months.
- AC-K7 Ownership weighting: two companies at 100% and 60% produce combined inputs = A + 0.6·B; ratios use the weighted
  inputs; an unowned company is reported as assumed-100%.
- AC-K8 Analytics: price + volume + mix effects sum exactly to the revenue change (cents); EBITDA, working-capital and
  cash bridges' steps sum exactly to end − start; budget-vs-actual F/U follows account type; the seasonality index
  averages 1.00 over complete years and ignores incomplete years; league tables rank nulls last; HHI and top-N shares
  match hand calculations; z-score anomalies need a minimum history; forecast bands widen monotonically with horizon;
  the flux helper applies $ and % materiality with AND/OR logic.


All charts are drawn in the v2 system: brand palette only, square geometry, DM Sans tabular figures, no gradients or
3-D, every chart has a table view and a text alternative, and every mark drills. Colour never carries sign alone:
favourable/unfavourable also gets F/U and parentheses.

| Chart | Use it when | Encoding rules | Where it appears |
|---|---|---|---|
| **Variance bridge (waterfall)** | Explaining a change between two numbers (budget → actual, last year → this year, EBITDA → cash) | Anchors solid Midnight; favourable steps Electric; unfavourable steps outlined in Brick with a 45° hatch; running total line; steps sorted by size or by statement order (user choice); every step drills | R2, F2, MG-01, MG-06, CA-10, LD-10 |
| **Price / volume / mix bridge** | Revenue or margin moved and you need to know whether it was rate or units | Three fixed steps + "other"; units and rate shown in the tooltip | MG-13, PR-06 |
| **Plan bar (layers)** | Where a year lands vs plan | Actual solid, committed slash-hatched, estimated outline, budget tick (S23 mark) | F2, BD-04, widgets |
| **Forecast fan** | Forward months with uncertainty | Actual line, committed area, estimated outline with p10–p90 band, budget step line | F2, CA-04, BD-12 |
| **Variance heatmap** | Many lines × many periods; finding where variance clusters | Cells tinted by % variance in 5 steps (Spruce/Brick washes), value printed in each cell, F/U letter | BD-02, CL-07, FS-08 |
| **Small multiples** | Comparing clients, departments or technicians on one measure | Same scale on every panel, sorted by the measure | CN-07, PR-02, KP-* |
| **Trend with target** | One KPI over 13 months | Line, target band, last value labelled, prior-year ghost line | MG-05, KPI tiles |
| **Benchmark ruler** | One value against peer quartiles | Track with p25–p75 band, median tick, own value marker, peers as small ticks | F2, KP-13 |
| **Contribution margin stack** | Which line, department or job carries the fixed cost | Revenue bar split into variable cost and contribution; fixed-cost line across | PR-06, MG-01 |
| **Cash runway** | Months of cash at current burn, with scenarios | Declining cash line to the minimum line; scenarios as dashed lines; crossing date labelled | CA-06, BD-07 |
| **AR aging curve (cohort)** | Are customers paying slower? | Each monthly invoice cohort as a line of % collected by day; latest cohort Electric | AR-12, AR-07 |
| **Aging stack** | AR/AP mix by bucket over time | Stacked buckets, over-90 in Brick hatch | AR-01, AP-01 |
| **WIP fade chart** | Is a job's margin eroding? | Estimated margin at each month-end per job; fading jobs labelled | JB-04, KP-05 |
| **Backlog burn-down** | How many months of work do we have? | Backlog area, monthly burn bars, new awards | JB-05 |
| **Seasonality ribbon** | Normal for this time of year? | 3-year min–max band per month, this year as a line | FS-02, CA-12, KP-04 |
| **Pareto / concentration** | Who matters most | Sorted bars + cumulative % line, 80% marker | MG-11, MG-12 |
| **Scatter: margin vs volume** | Which customers/jobs/techs are big but thin | Size = revenue, quadrant lines at medians | PR-04, PR-07 |
| **Headroom ruler** | Covenant tests | Limit line, breach zone hatched, forecast outlines (S24 mark) | LD-01, LD-04 |
| **Sparklines** | Inside tables and favourites | 13 points, last point dotted, no axis | R1, every KPI table |

**Chart rules the builder enforces:** one question per chart (title is the question or the answer); y-axis starts at
zero for bars; units in the axis title; no more than 7 series (the rest fold into "Other"); totals on a bridge must equal
the two anchors (a guard test asserts it); captions say what ties ("Steps sum to (47,690)").

---

## §3. AI capabilities (all on the gateway; all degrade to deterministic output)

| # | Capability | What the user gets | How it is built (deterministic part → AI part) | Off-switch behaviour |
|---|---|---|---|---|
| A1 | **Ask anything, get a report or chart** | Type "Which installs lost money in September?"; get a table/chart, the metric definition, the accounts and filters used, the row count, and the query — then **Save as report**, **Add to pack**, **Pin** | NL → a typed **report spec** (extend `lib/reports/compiler/spec.ts` from 7 report types to: metric × dimensions × filters × period × compare × chart type) → spec runs through the same RLS report routes → result. The model only produces the spec; it never writes SQL that runs. The **lineage panel** prints the spec, the account roles it resolved, and the generated read-only query for transparency | Parser falls back to the rules parser (`parse.ts`) and the catalog search; abstains with "I can't build that yet — closest reports: …" |
| A2 | **Metric lineage everywhere** | Any figure → "How is this calculated?" → formula, inputs, accounts, ledger rows, last refreshed, period status (final/preliminary) | KPI definitions (§1.15) + report spec; no model | Always on |
| A3 | **Auto-commentary / MD&A** | Draft commentary for MG-01, board pack and lender pack: what moved, why, what we're doing about it | Bridge + driver engine produce ranked, sized causes with evidence (ledger lines, jobs, vendors, operational metrics) → model words them in the tenant's voice from the admin-managed **prompt library** → stays a **draft** until a person marks it reviewed | Rule-written sentences ("Install margin cost 10,410: equipment 49.1% vs 46.0% budget") labelled "Computed (AI unavailable)" |
| A4 | **Anomaly & driver detection** | "Software renewals landed in September (5,822 over)"; "Marketing spend up 21% with flat bookings" | Statistical tests per account × department (z-score vs 13-month history, seasonality-adjusted), joined to the EC detector library → model explains | Flags still raised by rules |
| A5 | **"Explain this variance" drill** | Click any variance → bridge of that line → top contributing entries, vendors, jobs → one-paragraph explanation with evidence → **Ask the owner** creates a request to the department head (M-7) | Variance decomposition (volume/rate/timing/one-off) + entry ranking → model words | Bridge and entry list without prose |
| A6 | **Forecast with layers** | Each forward month split into committed (signed jobs, agreements, POs, recurring bills, payroll), estimated (driver model), and an uncertainty band | Committed from the ledger and jobs; estimated from drivers (`driver-forecast.ts`) + seasonality; band from historical forecast error (BD-13) | Unchanged — it's deterministic |
| A7 | **Scenario agent** | "What if Carrier raises prices 6% in January and we pass half through?" → parsed into driver changes, run against a version, compared on revenue, EBITDA, low cash, DSCR | NL → driver deltas (rules parser exists for `/fpna`) → deterministic re-run → covenant tests | Rules parser handles the common forms |
| A8 | **Board / lender pack builder** | "Build the Q3 Northwest pack" → pack drafted from the lender's spec (statements, certificate, BBC, aging, commentary), cover and branding applied, sent for approval | Pack templates (§5.3) + A3 commentary | Pack builds without commentary |
| A9 | **KPI recommendations by industry** | On setup and quarterly: "HVAC companies track agreement renewal rate; you have the data in ServiceTitan — add it?" | Industry tag on the client + connector inventory + KPI packs | Static recommended list |
| A10 | **Budget co-pilot** | Proposes a department's first draft from history + targets + template; flags lines outside history ("marketing 9.1% of revenue vs 6.0% last 3 years") | Template formulas + trailing actuals; model proposes and explains | Template + trailing actuals only |
| A11 | **Narrative QA** | Before a pack is sent: every number in the commentary is checked against the computed figures; mismatches block sending | Deterministic number extraction and match | Always on |

**Guardrails.** Every AI output is a `ai_decisions` row with inputs, spec and model version (existing audit pattern).
Commentary in an outgoing pack must be marked reviewed by a person with `reports.packs:release`. Lenders never see
unreviewed AI text. Department heads see commentary only for their department.

---

## §4. Budgeting

### 4.1 Objects (proposed data model, migrations 155–160)
| Object | Purpose | Key fields |
|---|---|---|
| `fpa.plans` | One planning cycle for a scope | org, scope (client or consolidation group), fiscal year, kind (`budget`/`forecast`), method (`top_down`/`bottom_up`/`blended`), status, calendar (open, due, review, approve dates) |
| `fpa.plan_versions` | Immutable snapshots: Budget, v1…vn, scenarios | plan, label, basis (`budget`, `reforecast 9+3`, `rolling 12`, `scenario`), parent version, locked_at, approved_by. **Replaces the unused `budget_versions` (013)**; `public.budgets` rows gain `version_id` |
| `fpa.plan_units` | The thing a person owns: a department (or client, location, job) inside a plan | plan, dimension (department/location/class), owner membership, template id, target (cents), stage, due date |
| `fpa.plan_lines` | Line items in a unit | unit, account (by id) or role, driver formula, monthly cents ×12/13, notes, source |
| `fpa.drivers` | Named drivers with values by month and a source | plan version, name, unit, monthly values, source (connector / GL ratio / manual), owner. **Moves drivers out of `ai_decisions`** |
| `fpa.templates` | Template library | scope (`system`/`tenant`/`client`), industry, department kind, lines (account role + driver formula + default), recommended KPIs, version, parent template |
| `fpa.submissions` | Workflow events | unit, from_stage, to_stage, actor, note, created_at (audit) |
| `fpa.headcount_lines` | Positions | unit, role, name or "TBH", start/end month, pay type, rate, burden %, hours |
| `fpa.capex_lines` | Capital projects | unit, asset class, amount by month, useful life, funding (cash/loan) |
| `fpa.metrics` | Operational metrics by month (non-GL) | client, metric key, period, value, source (connector/upload) |

All tables: RLS `org_id = get_org_id()`, cents, capabilities `fpa.budgets`, `fpa.scenarios`, `fpa.templates` (configure),
`fpa.submissions` (submit/approve). Migrations go to Supabase first, then code (CLAUDE.md §0.1).

### 4.2 Methods
- **Top-down:** the CFO sets targets per unit (revenue, margin %, spend cap) — "targets sent Oct 1" on F1.
- **Bottom-up:** each owner builds their unit from a template and drivers.
- **Blended (default):** targets go down, plans come up, the gap is shown per unit (F1 "vs target" column) and must be
  closed or accepted with a note before CFO approval.
- **Seeding:** start from last year's actuals, last year's budget, the current reforecast, or a template; apply growth %
  or drivers; spread by seasonality (last 3 years' monthly shape), evenly, or by working days.

### 4.3 Upload (Excel/CSV) — "we need the ability to upload budgets"
Builds on `lib/budgets/import.ts` (deterministic, monthly or annual layout, bigint cents, auto-map).
1. **Drop a file** on the plan or on one unit (XLSX/CSV; multiple sheets → pick a sheet or map each sheet to a unit).
2. **Detect layout:** monthly columns, annual column, or long format (account, month, amount); header row; units
   (dollars/thousands); sign convention (expenses positive or negative).
3. **Map columns** (auto, then confirm) and **map rows to accounts** by number, then name, then **remembered mapping**
   from the last upload of this file shape, then AI suggestion with confidence (F1 frame 2). Unmapped rows block import.
4. **Map dimensions:** a Department column or one department for the whole sheet; location/class likewise.
5. **Validate:** totals tie to the file (shown as "Imported 9,612,000 = file 9,612,000"); no posting to inactive accounts;
   periods inside the fiscal year; duplicates within a version rejected.
6. **Choose the target:** a draft version only (never an approved one); replace or merge per unit.
7. **Round-trip:** "Download template" produces the same workbook shape (accounts × months, locked header, data validation)
   so owners can work in Excel and re-upload; the import diff shows what changed line by line.

### 4.4 Template library (recommended, shipped as `system` templates)
Templates are editable copies: a tenant can edit any system template into a tenant template, and a firm can publish
tenant templates to its clients; a client can hold its own. Every line is `account role + driver formula + default`.

**By industry (full-company sets):**
| Template | Departments it creates | Signature drivers |
|---|---|---|
| HVAC service & install | Service · Install · Maintenance agreements · Sales & marketing · Admin & office · Executive | calls/month, average ticket, close rate, installs, average job, equipment %, members, renewal %, techs, billable % |
| Construction / custom homes | Construction · Estimating & sales · Warranty · Admin · Executive | homes started/closed, average contract, margin per home, months per build, change-order %, draw timing |
| Cabinets & millwork | Shop / production · Install · Dealer sales · Design · Admin · Executive | boxes/week, material $/box, shop hours/box, yield %, dealer mix, on-time % |
| Flooring & interiors | Install · Retail / showroom · Commercial · Admin · Executive | sq ft sold, material margin/sq ft, install rate/sq ft, crews, claims % |
| Kitchen & bath remodel | Design · Production · Sales · Admin · Executive | leads, design-to-sale %, average project, deposit %, project weeks |
| Equipment dealer | Whole goods · Parts · Service · Rental · Admin | units by OEM, margin/unit, turns, floor-plan interest, absorption % |
| Professional services firm | Delivery teams · Business development · Admin · Executive | FTEs, utilization, rate, realization, fee per client |

**By department (any industry):**
| Template | Recommended line items | Drivers |
|---|---|---|
| **Sales** | Salaries, commissions, payroll taxes & benefits, travel & meals, CRM & tools, samples/demos, training | quota × commission %, reps × fully burdened cost, travel per rep |
| **Marketing** | Paid search & local service ads, SEO/content, print & direct mail, events & home shows, brand & creative, software, agency fees | leads target × cost per lead, % of revenue cap, seasonal weights |
| **Operations / field** | Field labor, overtime, materials, equipment, subcontract, vehicles & fuel, tools, permits, warranty | jobs × hours per job × loaded rate, OT % by month, trucks × monthly cost |
| **Service** | Tech labor, parts, vehicles, dispatch, agreements cost, callbacks | calls × hours/call, parts % of revenue, techs, callback % |
| **Admin & office** | Office salaries, rent & utilities, insurance, software, professional fees, bank fees, office supplies | headcount, lease schedule, renewals from `/obligations` and `/subscriptions` |
| **Executive** | Executive comp, board & governance, travel, recruiting, management fees (as booked, not allocated) | named positions, events calendar |
| **Shop / production** | Production labor, materials, consumables, machine maintenance, freight in | units × material per unit, labor hours per unit |
| **Finance & accounting** | Staff, audit & tax fees, software, bank & card fees, insurance | engagement letters, transaction volumes |
| **IT & software** | Licenses, hardware refresh, support | seats × price, refresh cycle |

Each template also names its **recommended KPIs** (pulled into the unit's BvA page) and **watch thresholds** (e.g.
Marketing: cost per lead, leads, % of revenue; Service: billable %, callbacks).

### 4.5 Editing templates
- Template editor: add/remove lines, set account role or a specific account, set the driver formula and default, set
  required vs optional lines, add notes for owners ("Use the vendor list from last year").
- **Versioned:** editing a template creates a new version; plans keep the version they started from; "Update to v3"
  shows the diff and applies only to draft units.
- **Inheritance mark** (S27 `.ih`): a client's template shows which lines follow the firm's default, which override it,
  and which are client-only.

### 4.6 Department budgets with owners and approval
- **Owner** = the membership assigned to the unit (a department head, role `department_head`, scope "my departments").
  Owners see only their units (`fpa.budgets:edit` constrained `dimension = my departments`, 05-RBAC field scoping).
- **Workflow:** `Draft → Submitted → Controller reviewed → CFO approved`, with **Returned** (back to Draft with a note)
  from either review step. Stages are configurable per tenant (add a "GM approval" step; skip controller review for small
  clients). The approver can't be the submitter (SoD; reuses `permissionDenied` + SoD rules).
- **Finance-owned units** (Admin, Executive) skip submission; the controller drafts them (F1).
- **Gap to target** must be zero or explained before approval; the explanation is shown to the approver.
- **Comments** on any line (threaded, @mention), and **requests** (M-7) for "please justify line X" with reminders.
- **Deadlines & reminders:** due dates per unit; reminders on the M-7 engine (needs INT-01 scheduler); overdue units
  surface on `fpa.budget_cycle` for FD/CFO and on the DH home.
- **Approval locks the unit**; the plan version locks when all units are approved and the CFO **approves the budget**
  (step-up auth). After lock, changes happen only in a new forecast version.

### 4.7 Budget vs actual pushed to department heads monthly
- When the period hard-closes (or on a set day), each owner receives **their** department's MG-02 report: revenue, cost
  and spend vs budget, MTD and YTD, top 10 transactions, the three largest variances with **Explain** links, and any
  AI commentary limited to their department.
- Delivery: in-app (DH home `dh.bva` + Inbox) and email; optional "reply with explanation" that lands on the variance as a
  comment and feeds the CFO's MG-01 commentary.
- The CFO sees delivery and read status per owner (`rpt.packs`), and an "explanations received" count.

### 4.8 Headcount & payroll planning
Positions by department (named or to-be-hired), start/end month, salary or hourly × hours, burden % (taxes, benefits,
workers' comp) by state, raises by month, overtime %, bonus/commission formulas. Rolls into the unit's labor lines and
the cash forecast by pay schedule. Actuals compare from the payroll register (PRL-01) by employee/department (BD-09).
Payroll visibility respects M-3 (grouped/ungrouped/none).

### 4.9 Capex
Projects with asset class, amount by month, useful life and method → depreciation in the P&L forecast and cash out in the
cash forecast; funding by cash or a loan (draw schedule into the debt forecast and covenant tests). BD-10 compares.

### 4.10 Rolling 12-month reforecast
- Monthly after close: the CFO clicks **Reforecast** (existing `/budgets/reforecast`), which creates a new version: actuals
  through the closed month + next 12 months from drivers (committed + estimated layers), keeping the approved budget
  untouched.
- Owners can be asked to update only their drivers (light-touch cycle: due in 3 days, no approval unless the change
  exceeds a threshold).
- Versions are kept and comparable (BD-05); accuracy is tracked (BD-13).

### 4.11 Wave 4B amendment — department budgets, budget bridges (migration 189, 2026-10-24)

Owner (2026-10): *"For departments, I want department budgets and budget bridges for them as well."* This amendment is
the buildable cut of §4.1–4.7 + FP-06…FP-08, FP-21 (audit §3). Where it differs from §4.1 it wins (reason given).

**Data model (189, schema `public`, not `fpa.*`** — PostgREST exposes `public`, every other Books planning table lives
there, and `core` can't be embedded from `public`):

| Table | Purpose |
|---|---|
| `budget_plan_versions` | One version of a company's fiscal-year plan. `kind` BUDGET / REFORECAST; `status` DRAFT → IN_REVIEW → APPROVED → LOCKED (+ SUPERSEDED); `version_number`, `label`, `parent_version_id`, `basis`, due date, materiality ($ + bps), submitted/approved/locked by + at. At most **one current BUDGET version** per company × FY (`is_current`). |
| `budget_version_lines` | company × **department (nullable = company-level)** × account × month (1–12, 13 = adjustments), bigint cents, `source` (MANUAL / IMPORT / TEMPLATE / PRIOR_YEAR / DRIVER / COPY / PASTE / MIGRATED / REFORECAST). |
| `budget_line_drivers` | How a line was built (method + params) so the owner sees and re-runs it. |
| `budget_department_plans` | The unit a person owns inside a version: department, owner, template, status NOT_STARTED → DRAFT → SUBMITTED → APPROVED (or RETURNED with a note), due date, revenue/expense targets, gap note, submitter / reviewer / approver. |
| `budget_department_owners` | The standing owner of each department (carried into every new version). Also the source of "my departments" for department-head scope. |
| `budget_templates` | Tenant templates (immutable rows; editing = a new `version`). System templates ship in code (`lib/budgets/templates/system.ts`). |
| `budget_comments` | Threaded comments on a line, "please justify" requests, and **variance explanations** (owner explains → manager reviews; reviewer ≠ author, DB CHECK). |
| `budget_events` | Append-only audit of every transition, import, generation and owner change. |

`public.budgets` (013) stays the **published budget of record** every reader already uses (BvA, report engine, flux, FP&A,
metrics): it gains `version_id` and is maintained **by trigger** from the current version's lines (publish on approval /
on becoming current; mirror on each line write while current). Readers never see two versions summed. Existing rows are
migrated into a **"FY{year} Budget v1"** DRAFT version per company × FY that is current, and linked (`version_id`). The
old unique key (NULL department never collided → duplicate company-level rows) is replaced by a NULLS NOT DISTINCT key.
Members **read only**; every write is the service role after the route's permission + client-scope check (171 pattern).

**Locks (DB, not just UI).** A line/driver write is refused unless its version is DRAFT and its department plan (if any)
is not SUBMITTED / APPROVED. Version transitions are checked by trigger: APPROVED → LOCKED | SUPERSEDED only; LOCKED →
SUPERSEDED only; SUPERSEDED is terminal; a non-DRAFT version can't be deleted; approver ≠ submitter. Changing an approved
budget means **"New version from this one"** (copies lines, drivers, department plans back to DRAFT).

**Generators (pure, `lib/budgets/generators.ts`, all integer cents, every spread ties to its annual total by
largest-remainder):** fixed monthly · annual amount spread evenly · annual × prior-year seasonality · prior-year actuals
+ growth % (bps; month shape preserved) · % of revenue (bps of the version's budgeted revenue for the same department, or
company) · headcount × monthly rate × (1 + burden %) with start month · units × rate per unit · last year's budget + x%.
"Start from last year's actuals +x%" and "Start from template" act on one department or the whole company.

**Templates (system set, editable into tenant templates):** Sales · Marketing · Operations / Field · Service · Parts ·
Shop / Production · Construction PM · Admin & G&A · Executive · Finance & accounting — each lists line items with an
**account selector by type / sub-type / group / name pattern (never an account number)**, a default driver and the
recommended KPIs. A template line that resolves to no account in the tenant's COA is shown as "not in your chart" and
skipped (never invented).

**Bridges per department (`lib/budgets/bridges.ts` on 3B's `buildBridge`; drawn with 3C's `WaterfallChart`):**
(a) prior-year actual → this-year budget, steps = headcount (payroll-family accounts), rate / price (revenue at PY volume
× growth), volume, new initiatives (lines with no PY actual), one-time items (PY lines with no budget), inflation (the
remaining cost growth), each sized from the lines' driver method — every step sums to end − start exactly or the
residual is named; (b) budget → actual (MTD / QTD / YTD / TTM) by account group, favourable / unfavourable by account
nature; (c) budget → latest forecast (latest REFORECAST version; when none, actuals through the closed month + budget for
the rest, labelled "Latest estimate").

**Department BvA (`/api/budgets/department-bva`):** department P&L actual vs budget vs prior year, $ and %, windows
month / QTD / YTD / TTM; a variance list filtered by the version's materiality; drill to the GL lines posted to that
department (`gl_entry_lines.department_id`); commentary per variance.

**Scope.** View = `fpa.budgets:view` (legacy: `reports:view`, or owning a department). Edit = `fpa.budgets:edit` (legacy:
`close_mgmt:view` — finance staff — or owning the department). Approve = `fpa.budgets:approve` (legacy: `close_mgmt:manage`).
A caller who is not finance staff and can't approve is **department-scoped**: every budget route filters to the
departments they own and refuses others (403), company-level lines included. Client scope (163) applies to every row.

#### Acceptance criteria (Wave 4B)
- **AC-B9 Versions.** Creating a version gives the next `version_number` for company × FY × kind; only one BUDGET
  version is current; approving v2 supersedes the previously current version and `public.budgets` then holds exactly v2's
  lines (no double counting) — PGlite test.
- **AC-B10 Locks.** Inserting / updating / deleting a line of an APPROVED, LOCKED, SUPERSEDED or IN_REVIEW version fails in
  the database; so does a line in a SUBMITTED or APPROVED department plan; APPROVED → DRAFT is refused; a LOCKED version
  can't be superseded by a budget version. Members can't write any 189 table; anon reads nothing — PGlite test.
- **AC-B11 SoD.** A department plan or version approved by its submitter is refused (route 409 + DB CHECK); a variance
  explanation reviewed by its author is refused.
- **AC-B12 Migration.** Pre-189 budget rows land in one "FY{yr} Budget v1" version per company × FY with identical cents,
  `budgets.version_id` set, and re-running 189 changes nothing.
- **AC-B13 Generators.** Each method returns 12 integer-cent months that sum to its annual total exactly; PY +x% keeps the
  PY month shape; seasonality of a zero PY falls back to even; headcount respects the start month; % of revenue uses the
  department's revenue lines.
- **AC-B14 Templates.** Every system template line resolves by type / sub-type / group / name, never by account number;
  an unresolvable line is reported, not invented; saving a tenant template from a system one creates version 1, saving
  again creates version 2 and leaves version 1 intact.
- **AC-B15 Bridges tie.** For every bridge (PY → budget, budget → actual, budget → forecast) start + Σ steps = end to the
  cent (unit tests on random inputs), and the PY → budget steps come from the line drivers.
- **AC-B16 Department BvA ties to the GL.** Department actuals equal a manual sum of POSTED `gl_entry_lines` for that
  department × account × window (natural sign by account type); budget equals the current version's lines for that
  department; PY equals the same window a year earlier.
- **AC-B17 Department-owner scope.** A department-scoped caller sees only their departments in the board, grid, BvA and
  bridges, and a write to another department is a 403.
- **AC-B18 Import.** Uploading to a department targets a DRAFT version only (an approved one is refused with "create a
  new version"), mapping reuses `lib/budgets/import.ts`, and the imported cents equal the file to the cent.
- **AC-B19 Board.** The submission board lists every department with owner, status, due date (overdue flagged), plan
  total, last-year actual and the change, and the version's progress ("3 of 5 approved").
- **AC-B20 Grid.** The grid edits department × account × month with arrow-key navigation, Enter to edit, fill-right,
  apply % growth to a row, and paste a block from Excel (tab / newline separated) — every edit saves as cents and a locked
  version renders read-only with the reason.

### 4.12 Wave 4C amendment — cash workspace: direct 13-week forecast, scenarios, accuracy (migration 192, 2026-10-26)

Audit rows FP-09 (rolling forecast — the cash side), FP-10 (scenarios — the cash side), **FP-11** (13-week cash forecast
with payroll / recurring / debt / tax overlays, AI pay dates, accuracy — P0), **FP-12** (daily cash position + minimum-cash
alerts), R17, R18; benchmark B3–B7, B9, B10, U8, AI5, AI8 (`docs/audit-2026-10/E-REPORTING-BENCHMARK.md`). Replaces the
AR/AP-only `lib/cash/forecast.ts` projection and the back-calculated `lib/cash/trend.ts` curve on `/cash`. CA-02, CA-03,
CA-06, CA-07, CA-08, CA-09 (§1.4) are served by this slice.

**Engine (`lib/cash/forecast/**`, pure, integer cents, no I/O).** Every source becomes a dated `ForecastItem`
(company, direction, category, expected date, probability-weighted cents, gross cents, probability, certainty
COMMITTED / EXPECTED / ESTIMATED, source document, counterparty) and the engine buckets items into 13 Monday-anchored
weeks and 91 days, per company and combined.

| Category | Source (read through the caller's RLS client) | Timing rule |
|---|---|---|
| Opening balance | Canonical **book cash** (`lib/cash/book-cash`, GL cash accounts by flag / role) as of today; the bank-feed balance (`bank_accounts`, non-card, non-LOC) is shown beside it with its freshness. Non-finance readers whose current month isn't released start from the bank-feed balance, labelled. | as of today (org timezone) |
| AR collections | Open invoices (SENT / PARTIALLY_PAID / OVERDUE, balance > 0) | Due date + the customer's **amount-weighted median days-late** from paid history (payment_applications × customer_payments); no history → the org-wide profile; no org history → due date. Past-due items land no earlier than today. Probability by age bucket × customer reliability (1 − written-off share), × 0.5 when disputed. Expected cents = round(balance × p); the remainder is reported as **at risk**, never counted. |
| Recurring billing | Active `recurring_invoice_templates` (`templateRunAmountCents`) | Each future run date (after the last generated run) + the template's terms, then the customer's days-late |
| Deposits & other receipts | Manual items (category DEPOSIT / OTHER_IN) | As entered |
| AP | Open bills (PENDING / APPROVED / SCHEDULED / PARTIALLY_PAID / ON_HOLD, balance > 0) | SCHEDULED → `scheduled_payment_date`; on a waiting pay-run proposal (PAY_RUN agent run, PAUSED) → its pay-by date; else due date (past due → today). ON_HOLD is flagged. |
| Payroll + payroll taxes | Active `pay_schedules` × the mean of the last 3 non-cancelled `payroll_runs` on that schedule | Future runs already on file (DRAFT…PROCESSING, pay date ≥ today) count as COMMITTED; otherwise next pay dates step from the latest run by frequency (weekly 7d, biweekly 14d, semimonthly 15th/last, monthly same day). Net = gross − employee tax; taxes = employee tax + employer tax (or gross × the company's employer-tax bps when runs carry none). |
| Debt service | `debt_schedule_lines` of ACTIVE instruments, not yet posted (`debt:payment:{id}:{period}`) | Scheduled date |
| Leases | ACTIVE `leases` × `lease_schedule_lines` | ARREARS → the line date; ADVANCE → the first day of that period |
| Subscriptions | ACTIVE / KEPT / UNDER_REVIEW `subscriptions` | `next_renewal_date` stepping by cadence |
| Taxes | `sales_tax_filings` history per jurisdiction (next period by frequency, amount = mean of the last 3 remitted) + estimated income tax if configured (company setting, quarterly 15 Apr / 15 Jun / 15 Sep / 15 Jan) | Due date |
| Budgeted opex run-rate | Current published budget (`public.budgets`) for OPEX + COGS accounts, or the trailing-3-month posted actual (setting), **minus what other sources already count** | Spread evenly over the month's days |
| Capex, line draws / paydowns, transfers | Manual items (CAPEX / LINE_DRAW / LINE_PAYDOWN / TRANSFER_IN / TRANSFER_OUT) and scenario adjustments | As entered |

**No double counting (dedupe rules, AC-CF3).** (1) Run-rate excludes accounts whose family another source carries — payroll
(wage / payroll-tax / benefit roles and names) when a pay schedule is active, rent / lease when a lease is active,
interest when debt service is scheduled, depreciation / amortization (non-cash) always, income tax always; (2) for each
month the run-rate for an account is reduced by that month's open-bill lines and manual OUT items coded to the account,
floored at zero; (3) a subscription renewal within ±7 days of an open bill to the same vendor for an amount within 10%
is dropped (the bill wins); (4) a recurring-invoice run is skipped when an invoice for that run already exists
(`recurringSourceRef`); (5) a payroll run on file suppresses the projected run for the same schedule and pay date.

**Intercompany.** In the combined view an item whose counterparty is another company in scope — a customer whose
`related_location_id` is a company in scope, a vendor whose name matches a company in scope, a TRANSFER manual item — is
excluded (it nets to zero for the group) and counted under "Intercompany excluded"; a single-company view keeps it.

**Confidence band.** Per week the closing balance carries an 80% band: ± 1.28 × √(Σ item variance through that week) where
a receipt with probability p has variance p(1−p)·gross², an ESTIMATED item (run-rate, projected payroll, taxes) has a
10% coefficient of variation (5% for payroll), COMMITTED items none; widened by the trailing accuracy MAPE × the cumulative
absolute weekly net flow once four or more weeks have been scored against snapshots.

**Scenarios & overrides (192).** `cash_forecast_scenarios` (BASE / DOWNSIDE / UPSIDE / CUSTOM; per company or all) with
`cash_forecast_adjustments`: DELAY_RECEIPTS (customer or all, ± days), RECEIPT_HAIRCUT (bps), DELAY_DISBURSEMENTS (vendor
or all, ± days), REMOVE_ITEM (item key), PAYROLL_GROWTH (bps on projected — never committed — payroll), LINE_DRAW /
LINE_PAYDOWN (instrument, date, amount; moves liquidity headroom). `cash_forecast_items` holds manual one-offs with a
note, optional weekly / monthly recurrence and an optional scenario (null = every scenario). Presets: Downside = receipts
+14 days and −10%, payroll +3%; Upside = receipts −7 days.

**Thresholds, alerts, recommendations.** `cash_settings` per company: minimum cash (falls back to
`core.locations.minimum_cash_cents`), alerts on / off, employer-tax bps, estimated tax, run-rate basis (BUDGET /
TRAILING_3M / OFF). The first week a company's projected closing falls below its minimum raises a **critical in-app
notification** (lib/notify, deduped per company × week) to the tenant's finance admins, and the forecast shows a
recommendation: a transfer from companies whose projected low point exceeds their own minimum (largest surplus first,
never below the donor's minimum), then a draw on the company's available lines, then the uncovered remainder.
**Liquidity headroom** = cash + available lines: `cash_liquidity_lines` (commitment, borrowing base, drawn override) →
else a LINE_OF_CREDIT bank account's available balance → else LINE_OF_CREDIT instrument original − current balance;
availability = min(commitment, borrowing base) − drawn, floored at zero. Recommendations are advice only — nothing moves
money.

**Accuracy (192).** `cash_forecast_snapshots` (append-only): the weekly job **`cash.forecast_snapshot`** (Mondays) stores,
per company and combined, the base forecast's weekly inflows / outflows by category and closing balance. Accuracy compares
each week's actual cash movement (posted GL cash lines, internal cash-to-cash transfers removed, categorized by
`gl_entries.source_module`) with the snapshot taken at the start of that week (lead 1) and four weeks before (lead 4).
Week accuracy = 1 − |A − F| ÷ |A| (n/m when A = 0); MAPE = mean |A − F| ÷ |A| over meaningful weeks; accuracy % = max(0, 1 −
MAPE). "Snapshot now" is available to editors.

**Runway & metrics.** Trailing burn = mean monthly decline in book cash over the last 3 complete months (a cash-generative
company reads "Cash-generative", never a negative runway); forecast burn = −(13-week net change) ÷ 3; runway months = cash
÷ burn; zero-cash date when the forecast crosses zero; liquidity = cash + available lines; cash conversion cycle trend =
registry metrics DSO + DIO − DPO (12 month-ends, governed). Charts (ChartCard): weekly closing balance with band and
minimum-cash ticks; inflows / outflows stacked by category; opening → closing waterfall by category; top 10 receipts and
disbursements.

**History (fixes the trend).** Daily / weekly historical cash is the posted **book cash** at each date from GL cash
lines (not rewound from today's bank balance); the bank-feed series (rewound from the current feed balance through
`bank_transactions`) is drawn beside it and the **difference is shown per point** as the reconciling gap.

**Governance.** View = `cash.position:view` / `cash.forecast:view` (legacy `cash_position:view`, `forecast:view`);
create / edit scenarios, items, settings, snapshot = `cash.forecast:edit` (legacy `forecast:edit`). Every write is the
service role after the permission check and the client-scope assert (171 / 189 pattern); members read only; every new
table has client-scope RLS (163) and the Projects-only seat deny. GL-derived history (book-cash series, trailing burn,
CCC, accuracy actuals) is governed (Wave 3D): a non-finance reader sees only released months.

#### Acceptance criteria (Wave 4C)
- **AC-CF1 Receipt timing.** A customer who historically pays 10 days late (amount-weighted median) has an open invoice due
  on day D expected on D + 10; a customer with no history uses the org profile; expected cents = balance × probability
  (rounded), and the at-risk remainder is reported, never counted; a disputed invoice halves the probability.
- **AC-CF2 Schedules land in the right weeks.** Biweekly payroll from a last pay date steps 14 days; semimonthly lands on
  the 15th and the month end; a payroll run on file replaces the projection for that date; debt lines already posted are
  skipped; an ADVANCE lease lands on the first of the period and an ARREARS lease on the line date.
- **AC-CF3 No double counting.** With a $10,000 monthly opex budget and a $4,000 open bill coded to that account in the
  month, the run-rate for the month is $6,000; payroll / rent / interest / depreciation accounts contribute nothing to the
  run-rate when their source is active; a subscription matched by a bill is dropped.
- **AC-CF4 Intercompany.** A receivable from a customer linked to another company in scope appears in that company's
  forecast and not in the combined forecast; the combined total equals Σ companies − intercompany items.
- **AC-CF5 Scenario math.** Delaying a customer's receipts by 14 days moves exactly those items 14 days; a 10% haircut
  multiplies receipts by 0.9 (rounded per item); payroll growth changes projected payroll only; removing an item removes
  exactly it; the base scenario is unchanged by any other scenario's adjustments.
- **AC-CF6 Weeks tie.** For every company and the combined view: opening + Σ inflows − Σ outflows = closing for each week,
  week N's opening = week N−1's closing, and the daily drill of a week sums to the week.
- **AC-CF7 Accuracy.** For a snapshot forecasting $100 of receipts in a week that actually received $80, week accuracy is
  75% and the MAPE over weeks is the mean of the absolute percentage errors; a zero-actual week is n/m and excluded.
- **AC-CF8 Minimum cash.** The first week below minimum raises one notification per company × week (re-running is a
  no-op); the transfer recommendation never takes a donor below its own minimum.
- **AC-CF9 Security.** Members can't write any 192 table; anon reads nothing; a company outside the caller's client scope
  is refused (403) on every write; snapshots can't be updated or deleted outside the purge GUC — PGlite test.
- **AC-CF10 History.** The historical book-cash point for a date equals the posted GL cash balance at that date; the
  bank series ends at the current feed balance; the difference per point is book − bank.
- **AC-CF11 UI.** `/cash` (merit-ui) has Position · 13-week forecast · Scenarios · Accuracy · Settings; every panel has
  loading / empty / error states; a week or day click opens its items; ← → walk weeks; CSV export of the forecast.

### 4.13 Wave 4A amendment — FP&A workspace on the metric registry (migration 191, 2026-10-26)

Audit rows **FP-01** (registry on screen), **FP-03** (analytics screens), **FP-04** (group views, league table, share
bars), FP-19 (vertical packs), FP-16 (AI commentary, draft only); partner-portal parity M1–M7, M11, M14 and exceed
X1, X2, X5–X8, X11 (`docs/audit-2026-10/D-PARTNER-PORTAL-REPORTING.md` §3). Replaces `/fpna`'s 16 hand-drawn tiles and
its localStorage layout with the 3B registry (`lib/metrics/**`), the 3B analytics (`lib/analytics/**`), the 3A engine
(`runReport` / `runDrill`), the 3C chart kit (`components/charts/**`) and 3D governance (route-guard). No figure on
`/fpna` is computed anywhere else: every number is a registry evaluation, an analytics function over the same dataset,
or an engine statement.

**Surfaces (`/fpna`, merit-ui; `density-report` for owner / CFO, `density-cockpit` for finance staff).** One header
(scope · period picker with compare · Export PDF · Add to pack · Summarize this view) and eight tabs addressable in the
URL (`?tab=`): **Dashboard** (KPI cards from the catalog) · **Performance** (revenue / GP / EBITDA monthly combo with
prior year dashed, budget ticks, unclosed months hatched; YoY table Month · FYTD · TTM; CAGR 1/3/5-yr TTM-to-TTM;
margins trend; seasonality index) · **Budget vs actual** (variance bars by account group with materiality and F/U;
revenue / EBITDA BvA by month; link to department BvA) · **Bridges** (EBITDA, working-capital and cash waterfalls between
any two windows of the same basis) · **Working capital** (DSO / DPO / DIO / CCC trend, AR and AP aging stacks by company,
top-customer share bars, CEI) · **Profitability** (league table with sparklines by company / department / class / job /
customer; contribution margin) · **Group** (combined and ownership-weighted totals, consolidated with an elimination
bridge, share of revenue / EBITDA, sortable league, Rule-of-40 scatter, client × metric heat grid) · **Leverage &
covenants** (debt / EBITDA, DSCR, interest coverage, FCCR trends; covenant headroom gauges with projected breach).
UI copy never says "portfolio"; it says "clients", "companies" and "group".

**Data model (migration 191).** `public.fpna_dashboards` — one row per dashboard: `scope_kind` (`tenant` = an
administrator-published default for a role, `user` = a person's own), `role_key` (tenant rows; null = every role),
`user_id` (Clerk id, user rows), `name`, `pack_key` (`owner` · `cfo` · `construction` · `dealer` · `practice` · `custom`),
`cards jsonb` (ordered `[{ metric, size }]`, 1–48 cards, keys must be registry metrics), `settings jsonb` (basis,
comparison, sparkline 12 | 24), `lock_level` (`unlocked` · `add_move` · `locked`, IA M-8), `required_metrics text[]`,
`publish_mode` (`new_users` · `override`), `version`, `is_current`, `based_on_id`, `published_by/at`, `note`,
`archived_at`. `public.report_packs.fpna_items jsonb` (dashboards added to a pack). RLS: members read their org's tenant
rows and only their own user rows; **every write is the service role** after the route's permission + lock check
(the 171/187 class-C pattern — no member write grants, so lock levels cannot be bypassed through PostgREST); M1 grants;
`core.apply_projects_only_seat_deny` on the new table; guarded `core.apply_client_scope_rls()`.

**Resolution (pure, `lib/fpna/workspace/dashboard-model.ts`).** Effective dashboard = the user's own current row (when
the role default is not `locked`, and not superseded by an `override` publish after the user's last save) → the tenant
default for the user's role → the tenant default for every role → the built-in pack for the role (owner / company admin →
Owner; CFO / controller / accountant → CFO; tenants with the construction or dealer pack enabled get that pack; a firm
practice role → Practice). `add_move` keeps every required metric on the user's dashboard; `locked` refuses personal
saves (409 `DASHBOARD_LOCKED`).

#### Acceptance criteria (Wave 4A)
- **AC-W1 Catalog.** The card picker lists every registry metric (≥ 120) with name, group, unit, the generated formula
  string and the definition; search matches name, key, group and formula text; each entry states its requirements
  (budget, AR sub-ledger, jobs, headcount…). Five default packs (Owner, CFO, Construction, Dealer, Practice) contain only
  registry keys (guard test).
- **AC-W2 Card.** Each card shows value, a change chip with the semantic word (improvement / erosion; favourable /
  unfavourable vs budget; points for percent metrics), a 12- or 24-month sparkline with gaps as gaps and preliminary
  months flagged, a benchmark status where the registry has bands, and — when it cannot compute — the reason in words
  ("Not enough history: needs 48 closed months; 29 are on file"), never a 0.
- **AC-W3 Persistence.** Saving a personal dashboard round-trips cards, order and settings; a second save bumps
  `version`; publishing a role default creates a new current version and marks the prior one not current (unique index);
  a `locked` default refuses a personal save (409); an `add_move` default refuses a save that drops a required metric
  (409); an `override` publish makes the role default win over older personal rows; publishing needs
  `settings_acct:edit` (403 otherwise) — PGlite + route tests.
- **AC-W4 Security.** Members cannot insert / update / delete `fpna_dashboards` (any row); a member reads tenant rows and
  only their own user rows; anon reads nothing; the seat-deny policy is present — PGlite test.
- **AC-W5 One evaluation per view.** Every tab's request performs exactly one dataset load (`planLoad` over the union of
  its metric requests) and evaluates all cards and series against it; the result is cached per (org, user, scope,
  period, basis, comparison, ledger epoch) for 60 s; the epoch changes when a posting, close or release changes the
  books (unit test with a counting source).
- **AC-W6 Ties to the engine.** For a seeded org, Dashboard revenue, gross profit, net income, cash and total debt equal
  the engine's income statement / balance sheet for the same window and companies to the cent; Profitability by
  department revenue and gross profit equal the engine's department columns; Group consolidated revenue equals the
  engine's Consolidated column and the elimination bridge's steps sum to it.
- **AC-W7 Governance.** Every new route runs number governance: for a non-finance reader no figure from an unreleased
  month is used (metrics via `governDataset`; engine via its hooks; dimension balances and covenants via
  `governRouteMonths`, cumulative for balance-type figures); responses carry `closedThrough` / footnote and the UI footer
  says "Books closed through …"; a finance reader sees preview figures labelled preview.
- **AC-W8 Chart = table.** Every chart's table (View as table / CSV / XLSX) is built from the same arrays the chart draws
  (test: series values equal table cells for every tab's view model).
- **AC-W9 Bridges tie.** EBITDA, working-capital and cash bridges: start + Σ steps = end to the cent for any two windows;
  the cash bridge names its residual "Other balance-sheet movements".
- **AC-W10 AI commentary is a cited draft.** "Summarize this view" sends only a fact sheet built from the computed view
  (refs F1…Fn) through `runAiGateway` (feature `FPNA_SUMMARY`); a draft that cites an unknown ref, cites nothing, or
  quotes any $ / % not in the fact sheet is refused and the deterministic sentences are shown instead; AI down returns
  "AI summary paused" with the deterministic summary; a draft is logged to `ai_decisions` as PROPOSED and never stored as
  commentary without a person.
- **AC-W11 Export & pack.** Export PDF renders on the server from the dashboard id + period (the client sends no
  figures); Add to pack appends the dashboard (id, scope, settings) to a `report_packs` row and scheduled delivery
  attaches the dashboard PDF governed as non-finance (released months only).
- **AC-W12 UI states.** Every tab renders loading / empty (with the next action) / populated / error-with-retry; cards
  drill to the GL (engine drill, governed); the page is keyboard-operable (tabs rove with arrows, cards reorder with
  ←/→ in edit mode as well as drag); `/fpna` contains no legacy-theme vocabulary.

---

## §5. Report builder & packs

### 5.1 Builder
- **Start from:** any catalog report, an AI answer (A1), a template, or blank.
- **Blocks:** statement, table (rows = accounts/roles/dimensions/customers/jobs; columns = periods/versions/dimensions/
  formulas), chart (§2), KPI tiles, text with live placeholders (`{{revenue.var_pct}}`), commentary (A3), image, page break.
- **Formulas:** Excel-style across columns and rows (variance, %, ratio, running total) with lineage.
- **Drag and drop** layout on the v2 grid; keyboard alternatives (move up/down, resize via menu).
- **Saved views** extend mig 138: personal, shared to a role, or the role default.
- **Permissions:** a report built on a client the viewer can't see renders without those rows; the builder warns the
  author when audiences differ.

### 5.2 Scheduling & delivery
- Cadences: after close of period X (event-based — the right default for accounting), monthly on day N, weekly, quarterly,
  custom; time zone; skip if the period isn't final, or send marked "preliminary".
- **Approve before send** (default on for lender and board packs): owner of the pack reviews AI text and figures, then
  **Approve & send**; the toast repeats the verb.
- Recipients: members (in-app + email), external lender viewers (portal + email link, `delivered_to_me`), plain email
  (PDF attachment) with an expiry.
- Delivery log (M-14 `report_deliveries`): sent, opened, downloaded, failed, bounced.

### 5.3 Formats & branding
- **PDF** (existing `statement-pdf.tsx`), **XLSX** with live formulas and one sheet per report, **CSV**, **PPTX** (new:
  one slide per block, charts as native shapes, commentary in speaker notes optional).
- Branding per tenant and per client (white-label): logo, colours from the tenant brand, cover page, headers/footers,
  confidentiality line, page numbers, table-of-contents.
- **Pack templates:** Monthly management pack · Owner one-pager · Board pack · Lender pack (per lender spec: statements,
  certificate, BBC, AR/AP aging, covenant calc) · Department BvA pack · Investor quarterly · Diligence pack.

---

## §6. IA, RBAC and widget wiring

- **Nav (IA §3.6.1, unchanged items, new tabs):** Reports `/reports` (Library · Favourites · Saved · Ask · Builder) ·
  Board & lender packs `/packs` (Packs · Scheduled · Delivery log · Templates) · Budgets `/budgets` (Plan · Drivers ·
  Reforecast · **Cycle** · Budget vs actual · **Templates** · **Headcount** · **Capex**) · FP&A & scenarios `/fpna`
  (Analysis · Scenarios · KPIs · Benchmarks) · Profitability. Consolidated context gets Reports (group), BvA & FP&A
  (read-only), packs.
- **Capabilities (05 vocabulary; reserved spine — the lead adds them to `lib/rbac/permissions.ts`):**
  `reports.financial` V X · `reports.builder` C E · `reports.packs` V C E release X · `fpa.budgets` V C E approve configure ·
  `fpa.templates` V configure · `fpa.scenarios` V C E · `fpa.kpis` V configure · `fpa.benchmarks` V (consent-gated).
  Department heads get `fpa.budgets` V E constrained to their departments; approve stays with CTL/CFO.
- **Widgets (IA §5.6):** `fpa.flux`, `fpa.reforecast`, `fpa.scenarios`, `fpa.budget_cycle`, `rpt.packs`, `fd.bva`, `dh.bva`
  exist in the registry spec; add **`rpt.favourites`** (any role: pinned reports with a sparkline each) and
  **`fpa.kpis_industry`** (OW, FD, DH: the client's industry KPI pack vs target and peers).
- **Scheduler dependency:** INT-01 (`M-12` jobs) runs pack schedules, post-close BvA pushes, reminder cadences and
  forecast snapshots. Until it exists, schedules show "Not running — scheduler not live" (honest done state).

---

## §7. Acceptance criteria

**Library**
- AC-L1 `/reports` shows the 14 shelves with counts; search finds a report by name, synonym ("P&L", "income statement")
  or question; a role sees only reports it can view, and counts reflect that.
- AC-L2 Every Live report has: fiscal-period picker, compare (prior like-for-like, prior year, budget version), drill to
  GL and source, export PDF/XLSX/CSV, save view, add to pack, schedule. Guard test enumerates catalog entries and fails if
  a Live entry lacks any of these flags.
- AC-L3 Each report's footer states period status (final / preliminary · n clients open) from close status.
- AC-L4 Department P&L matrix (FS-08) ties to a manual GL filter per `department_id`, every cell.

**Charts**
- AC-C1 Bridge steps sum to the difference of the anchors (unit test on the bridge engine; caption prints the tie).
- AC-C2 Every chart has a table view, a text alternative, keyboard focus on marks, and drill.

**AI**
- AC-A1 An Ask answer always shows its spec, resolved account roles, row count and query; **Save as report** produces the
  same numbers on re-run.
- AC-A2 With the gateway off, MG-01 renders the bridge and rule-written commentary labelled "Computed (AI unavailable)".
- AC-A3 A pack containing commentary can't be sent until a person with `reports.packs:release` marks it reviewed;
  narrative QA (A11) blocks sends where a number in the text doesn't match its computed source.
- AC-A4 Scenario results include low cash and every covenant test on the borrower; applying a scenario creates a new
  version and never edits an approved one.

**Budgeting**
- AC-B1 Upload: a monthly XLSX, an annual XLSX and a long-format CSV each import to a draft version; totals tie to the
  file to the cent; unmapped rows block; the remembered mapping applies on the next upload of the same shape.
- AC-B2 Templates: a system template can be copied to a tenant template, edited, versioned and published to clients; a
  plan created from v2 is unaffected by v3 until the owner applies the update.
- AC-B3 Department owner sees and edits only their units; submit → controller review → CFO approve works, with return
  and notes; submitter can't approve; every transition is in `fpa.submissions`.
- AC-B4 Gap to target is shown per unit and requires a note to approve when non-zero.
- AC-B5 Approved budget version is immutable (DB trigger); BvA reads the active version (closes FPB-fr D3.3).
- AC-B6 Monthly push: after September hard-closes, each department owner gets MG-02 for their department only; the CFO
  sees delivery and read status.
- AC-B7 Headcount and capex lines roll into the P&L, cash forecast and covenant forecast of the version.
- AC-B8 Drivers and scenarios live in `fpa.*` tables, not `ai_decisions` (migration moves existing rows).
- AC-B9 … AC-B20 (department budgets, versions, locks, generators, templates, bridges, department BvA, owner scope,
  import, board, grid) — §4.11 (Wave 4B, migration 189).
- AC-CF1 … AC-CF11 (cash workspace: receipt timing, schedules, dedupe, intercompany, scenarios, ties, accuracy,
  minimum cash, security, history, UI) — §4.12 (Wave 4C, migration 192).

**KPI registry & analytics (Wave 3B)** — AC-K1…AC-K8 in §1.15a; guard test `lib/metrics/registry.test.ts` enumerates the
registry and fails on any entry missing a field, an undefined input, or a cycle.

**Packs & builder**
- AC-P1 A pack scheduled "after close" sends once per period, after the hard close, to the right audience, and logs it.
- AC-P2 PPTX export opens in PowerPoint and Keynote with native charts and the tenant's branding.
- AC-P3 A lender viewer sees only packs delivered to them, read-only, for ≤ 365 days.

---

## §8. Build slices (dependency-ordered)

| # | Slice | Depends on | Owner agent | Parallel with |
|---|---|---|---|---|
| 1 | **Statement correctness carry-in:** FPB-fr D3.1 comparatives, D4.1/4.2 department pivot + matrix, D5.1 eliminations applied | GATE 7 / 11a | builder ×2 | 2 |
| 2 | **Library shell:** `/reports` shelves, search, favourites, catalog registry with flags (AC-L2 guard), period-status footer | IA shell | builder + designer | 1, 3 |
| 3 | **Migrations 155–157:** `fpa.plans`, `plan_versions`, `plan_units`, `plan_lines`, `drivers`, `submissions`; move drivers/scenarios out of `ai_decisions`; `budgets.version_id` | lead (spine) | lead | 2 |
| 4 | **Upload v2:** sheet picker, long format, row→account memory, dimension mapping, diff, download template | 3 | builder | 5 |
| 5 | **Templates:** `fpa.templates` (mig 158), system seed (7 industry + 9 department), editor, versioning, publish to clients | 3 | builder + designer | 4 |
| 6 | **Cycle & approvals:** units with owners, stages, return, SoD, gap notes, `fpa.budget_cycle` + DH widget | 3, RBAC gate #9 (org resolution), capabilities | builder + security | 7 |
| 7 | **Bridge & variance engine:** budget→actual and period→period bridges, price/volume/mix, by department; guard tests | 1 | builder | 6 |
| 8 | **MG-01 management report + MG-02 department edition** with A3 commentary (deterministic first) | 7 | builder + designer | 9 |
| 9 | **Ask v2 (A1/A2):** report spec extension, lineage panel, save as report | 2 | builder | 8 |
| 10 | **Scheduler INT-01 + delivery log (M-14)**, post-close triggers, approve-before-send | infra | lead + builder | — |
| 11 | **Monthly DH push** (AC-B6), pack templates, PPTX export, branding | 8, 10 | builder | 12 |
| 12 | **Headcount & capex planning** (migs 159–160), roll into forecast and covenants | 3, payroll register | builder | 11 |
| 13 | **KPI library + industry packs + `fpa.metrics` upload/connectors**, F2 KPI view | connectors (07) | builder | 14 |
| 14 | **Forecast layers + rolling 12 + accuracy snapshots** | 3, 10 | builder | 13 |
| 15 | **Benchmarks (KP-13)** — consent model, anonymization, minimum peer counts | owner decision §10 Q3, security | security + builder | last |

Each slice runs the CLAUDE.md wave pipeline: verifier + chrome-auditor after deploy, security on 6, 10, 11, 15
(money/identity/public), reviewer before merge, scribe updates the handoff.

---

## §9. Design boards (this pass)

| Board | Shows | Notes |
|---|---|---|
| **R1 Reports home** | Heartland, CFO. Ask bar with an answered question (lineage: spec, account roles, rows, query); favourites with sparklines; the 14 question shelves with Live/Partial/New counts; recent and scheduled packs | Library counts are read from this brief's tables |
| **R2 Report view** | MG-01 Monthly management report, Heartland, September: department P&L vs budget/Aug/Sep 2025, EBITDA bridge (132,000 → 84,310, seven steps), notes column with draft AI commentary; drill panel into Install cost of revenue | Bridge ties; dept rows tie to S6/S23 figures |
| **F1 Budget builder** | Heartland FY 2027 cycle: six departments, owners, templates, stage meters, targets vs plans; Install template panel; upload mapping state | "3 of 4 departments in" ties to S23's widget |
| **F2 FP&A analysis** | Consolidated group: September EBITDA bridge by client (679,600 → 495,059), FY 2026 revenue forecast fan with layers, FY 2027 scenarios with DSCR, HVAC KPI pack vs peer quartiles | Peer quartiles are sample data until §10 Q3 is decided |

---

## §10. Open questions for the owner

1. **Approval chain default.** Draft → Controller → CFO, with an optional GM step per client — right default for clients?
2. **Department head visibility.** Should department heads see other departments' totals (not detail) for context, or
   only their own?
3. **Benchmarks.** Opt-in anonymized peers across MeritBooks tenants (needs consent terms and a minimum peer count of
   ~10), a licensed data set (e.g. trade association surveys), or both?
4. **PPTX** — required for board packs at launch, or PDF first?
5. **Client-facing templates** — should firms be able to sell/brand their own template sets to clients (marketplace),
   or only publish within their tenant?
6. **Operational metrics** — which connectors first for KPIs: ServiceTitan (HVAC), Buildertrend (construction), Innergy
   (cabinets), RFMS (flooring)?
