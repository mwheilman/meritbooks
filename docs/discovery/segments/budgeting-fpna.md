# Budgeting & FP&A — Segment Deep-Dive (Operational Reality + AI Capability Catalog)

**Authors' frame:** a Corporate FP&A / budgeting leader (25+ yrs across multi-entity holdcos and PE
portfolios) paired with a senior AI engineer. This is an *analysis/spec only* discovery doc — nothing
here is a build authorization. Every capability must earn a Rule-13 FPB (16 dimensions + a QBO/Sage/
best-in-class benchmark) and land behind its `Prereq:` gate before any build.

**Grounding (read first):** `docs/canon/CANON-ANCHOR.md` (MeritBooks OWNS the GL; AI proposes *facts*
→ the deterministic engine posts → a human with the right Core role approves → every action writes to
`core.action_log`; auto-post is OFF by default and is a per-tenant/per-task dial; SoD binds the AI too;
the Core AI gateway `@meritbooks/core-ai` is the only path to a model). `docs/discovery/books/
controller-cfo.md` (the multi-entity finance reality this segment sits inside). `docs/discovery/books/
AI-CAPABILITY-CATALOG.md` (the whole-Books union; this doc is the FP&A *depth* under its group E).

**The moat this segment exists to exploit (state it once, it governs everything below):** because
MeritBooks owns the ledger, the budget and the forecast are built **natively on real, live actuals** —
not on a nightly CSV export into a disconnected FP&A tool (Adaptive/Planful/Vena/Cube) or a spreadsheet
that drifts from the GL the moment it's saved. Actuals *are* the plan's baseline; a reforecast is a
query, not an export/import/reconcile ritual; a variance is a drill-through to the driving journal line,
not a tie-out project. Every FP&A tool on the market fights the "is this number current / does it tie to
the GL?" problem. An owned-ledger system deletes that problem. **That is the whole reason FP&A is Pillar
3 of the product and not a bolt-on.**

**Scope tags:** `[common-core]` ships to every tenant in the base product; `[segment]` applies only to
certain tenant shapes (multi-entity, leveraged/bank-financed, contract/subscription revenue, headcount-
heavy, capex-heavy), named inline. Per canon, Merit Management Group is just the first tenant — nothing
below is Merit-specific.

---

## Part 1 — How the FP&A function actually runs (end-to-end), and where value leaks

FP&A is the forward-looking half of finance. Where the controller's close (see `controller-cfo.md`)
answers *"what happened,"* FP&A answers *"what will happen, what should happen, and why is it off."* It
runs on five overlapping cycles. For each: the real process, then **where time, accuracy, and insight
leak** — the leak is the build target.

### 1.1 The annual budget build (the Q3–Q4 marathon)

**Process.** A 6–12 week cross-functional slog, typically Aug–Nov for a calendar-year company:
1. **Set the frame** — leadership hands down targets (revenue growth, EBITDA margin, headcount envelope,
   capex ceiling, a bonus-pool assumption). CFO cascades to department owners.
2. **Seed the baseline** — pull trailing-12-month actuals per account × department × entity, annualize
   the current run-rate, strip out one-timers. This "prior-year-actuals-as-starting-point" is 80% of a
   real budget and today is a manual export-and-massage.
3. **Layer assumptions** — apply growth/inflation/merit-increase %, price changes, new-hire plans, new
   locations/products, known contract wins/losses, contractual step-ups (rent, SaaS, insurance).
4. **Departmental collaboration** — push templates to 10–40 budget owners, collect their line-item
   inputs, chase the stragglers, reconcile bottom-up department asks against top-down targets. This
   negotiation loop (the "gap to target") is where the calendar goes.
5. **Build the driver models** — revenue (units × price, pipeline × win-rate, headcount × quota, ARR +
   net-revenue-retention), COGS (as % of rev or per-unit), comp (roster × fully-loaded cost), capex →
   depreciation, financing → interest.
6. **Assemble the three-statement plan** — a budgeted P&L that *flows into* a budgeted balance sheet and
   a budgeted cash flow (working-capital assumptions: DSO/DPO/DIO). Most SMB budgets stop at a P&L and
   are silently wrong on cash because of it.
7. **Iterate scenarios** — base / upside / downside; sensitize the 2–3 drivers that actually move EBITDA.
8. **Board approval** — present, defend, revise, ratify. Lock the approved version as the plan of record.
9. **Seasonalize & phase** — spread the approved annual number into 12 monthly periods on a real seasonal
   curve (retail Q4 skew, construction weather, SaaS ratable), not 1/12 flat, so monthly BvA is meaningful.

**Where it leaks.**
- **The baseline pull is manual archaeology.** Days spent exporting TB history, annualizing, and cleaning
  one-timers — the single biggest, most automatable time sink. *(Owned ledger: this is a query.)*
- **Version chaos.** "Budget_v7_final_FINAL_dept-edits.xlsx." No single source of truth; broken links;
  a fat-fingered cell in a hidden tab that nobody catches until the board meeting.
- **Top-down vs bottom-up never reconciles cleanly** — the gap-to-target loop is all email and re-keying.
- **Flat 1/12 spreading** makes every monthly variance a false alarm and destroys early-warning value.
- **P&L-only budgets** leave cash and the balance sheet unplanned — the number that actually breaks a
  company (liquidity) isn't in the plan.
- **Drivers live in formulas, not in a model** — nobody can answer "what if price is +3% and churn +1pt?"
  without rebuilding the workbook.

### 1.2 Monthly reforecasting & the variance review

**Process.** After each close: (a) actuals land; (b) compute budget-vs-actual and prior-forecast-vs-
actual per account/dept/entity; (c) explain every material variance (the **flux/variance narrative** — the
CFO's monthly ritual); (d) **reforecast the remainder of the year** — actuals-to-date + a refreshed
forecast for open periods = a live "where we'll land" (the rolling/latest-estimate view); (e) update the
scenario set and the cash forecast; (f) decide corrective action (freeze hiring, cut discretionary spend,
pull forward a price increase).

**Where it leaks.**
- **Variance explanation is manual and repetitive** — the controller hand-writes "OPEX +18% due to a
  one-time legal accrual in Dept X" every month, re-deriving the *why* the ledger already knows.
- **Reforecasting is a full workbook rebuild** each month instead of an incremental "actualize the closed
  month, re-run the drivers forward."
- **No trigger discipline** — a department blows 30% over in month 2 and nobody reforecasts until the
  quarter, by which point the year is lost. There's no *automatic* "this variance is material and
  persistent → the full-year estimate needs to move."
- **The budget goes stale by March** — a static annual budget nobody refreshes; BvA against a plan that
  stopped being believed in Q1.

### 1.3 The monthly management review & board/lender package

**Process.** Package the month: KPI dashboard, consolidated + entity P&L/BS/CF with BvA and variance
commentary, cash & liquidity (often a 13-week forecast), the reforecast/latest-estimate, covenant
compliance (DSCR, FCCR, leverage/net-debt-to-EBITDA, current ratio, minimum liquidity, TNW), a borrowing-
base certificate where applicable, and a forward look. Deliver to the board and to lenders on the credit-
agreement deadline.

**Where it leaks.**
- **Package assembly is days of copy-paste** from the GL into decks/PDFs — high-effort, error-prone, and
  stale by the time it's bound.
- **Covenants are computed quarterly in a spreadsheet** — the CFO discovers a breach *after* the quarter,
  when it's too late to cure. This is the CFO's career risk (waiver fees $25k–$250k, acceleration, cross-
  default). *(Owned ledger: covenants can be computed continuously on actuals+forecast.)*
- **Inconsistent packages across entities** — 20 entities, 20 slightly different templates; no comparability.
- **The narrative is written under deadline** — the "story" is thin because there's no time to dig.

### 1.4 Long-range / strategic planning (LRP) & special models

**Process.** A 3–5 year top-down model for the board/investors/lenders: growth trajectory, margin ramp,
capex program, financing/debt schedule, covenant runway, and — for PE-backed tenants — an equity value-
creation bridge and a returns (MOIC/IRR) view. Plus ad-hoc deal models: acquisition/integration, new-
location pro formas, financing scenarios, hiring-plan affordability, pricing changes.

**Where it leaks.**
- **The LRP is disconnected from the actuals** — a standalone workbook that never gets refreshed against
  reality, so the "5-year plan" is fiction by year 2.
- **Every ad-hoc model is built from scratch** — no reusable driver model to fork.
- **Unit economics (CAC/LTV, cohort retention, contribution margin, payback)** are computed in yet another
  one-off spreadsheet, disconnected from the GL and the billing/AR data that could feed them natively.

### 1.5 The through-line

Most of FP&A's *calendar* is **mechanical labor** — pulling baselines, spreading, collecting inputs,
computing variances, reforecasting, assembling packages — and only a thin slice is **judgment** (setting
targets, sizing drivers, deciding corrective action, defending the plan). An owned-ledger AI system's job
is exactly the same as on the close side: **collapse the labor to near-zero and surface the judgment early**,
with the human owning every number that gets *signed* (the budget the board ratifies, the covenant
certificate the CFO files, the forecast the lender relies on). AI proposes the draft and the narrative;
the human owns the assumptions and the sign-off.

---

## Part 2 — Comprehensive AI + non-AI capability catalog (grouped)

**Format per capability:** *what it does* · **Trigger/data it reads** · **Gateway bucket** (EXTRACT /
CLASSIFY / MATCH / DETECT / FORECAST / RECONCILE / DRAFT — from the AI Capability Catalog §0; non-AI items
marked **[deterministic]**) · **HITL posture** · **rough value** · **build-state** (none / partial / built).

**Build-state ground truth (verified against the repo, session 41):**
- **Built (thin):** a per-company/per-department **budget entry grid** (migration `013_budgets.sql`;
  `budgets` table; `/api/budgets`) with dollar cells, *copy-prior-year*, and *even 1/12 annual spread*; a
  **Budget-vs-Actual** view (`/api/budgets/vs-actual`) with variance, %, favorability, per-period or full-
  year, and consolidated-across-locations; a **13-week direct cash forecast** (`lib/cash/forecast.ts`,
  `/forecast`) — pure, deterministic, AR/AP-due-date + bank-balance driven.
- **Spec'd but not built:** `FPB-financial-reports.md` **Dimension 8** (native budgeting), **Dimension 9**
  (scenario modeling & rolling forecast), **Dimension 14** (AI variance narrative + forecast proposals);
  these are GATE 7 and *acknowledged missing*.
- **Not present at all:** any P&L/three-statement forecast, driver model, scenario engine, rolling
  forecast, seasonality curve, headcount/comp plan, capex plan, covenant engine, board-package generator,
  or NL query. The `budget_versions` table exists (013) but is **unused** — no version/approval workflow.

Capabilities are grouped A–K. There are **40** below (target was 30+).

---

### Group A — Budget construction & authoring (the annual build)

**A1 — AI budget draft from prior actuals + growth/driver assumptions** ★ marquee
*What:* One click produces a full-year draft budget per account × dept × entity by pulling trailing-12
actuals, annualizing the clean run-rate (stripping detected one-timers), and applying tenant-set
assumptions (revenue growth %, inflation, merit %, price change) — the 80% first draft a planner today
builds by hand.
*Trigger/data:* Planner starts a budget cycle. Reads posted GL history by account/dimension/period,
one-time-item flags, prior budgets. Writes a draft `budget_versions` row + `budgets` cells.
*Bucket:* FORECAST + CLASSIFY (one-timer detection). *HITL:* AI proposes the full grid with its basis per
line; planner reviews/edits every number; nothing is "the plan" until a human ratifies the version.
*Value:* Very high — deletes the biggest annual time sink (days→minutes) and the owned-ledger baseline is
always current. *Build-state:* **none** (only manual copy-prior-year + even spread exist).

**A2 — Seasonality-aware spreading** ★
*What:* Spread an approved annual amount into 12 periods on the account's *own historical seasonal curve*
(and/or a chosen profile: flat, linear ramp, custom), not naive 1/12 — so monthly BvA is meaningful.
*Trigger/data:* Planner enters an annual target or accepts A1. Reads 2–3 years of monthly actuals per
account to derive the seasonal index. Writes period cells.
*Bucket:* FORECAST (seasonal decomposition). *HITL:* AI proposes the curve; planner can override any
month or pick a profile. *Value:* High — kills false monthly variance alarms; preserves early warning.
*Build-state:* **partial** — only *even* 1/12 spread exists (`spreadAnnual` in `budget-entry-grid.tsx`).

**A3 — Driver-based budgeting** ★
*What:* Model accounts as `driver × rate` (revenue = units × price, or pipeline × win-rate, or heads ×
quota; COGS = % of rev or per-unit; comp = roster × loaded cost) so the budget is a live model, not
static cells — change the driver, the dependent lines recompute.
*Trigger/data:* Planner defines drivers + linkages. Reads actuals to seed rates. Writes a driver model +
derived budget cells. *Bucket:* [deterministic] calc engine; FORECAST to *suggest* driver rates from
history. *HITL:* human owns the driver values and structure; AI can propose starting rates. *Value:* Very
high — the core of modern FP&A; the difference between a budget and a spreadsheet. *Build-state:* **none**.

**A4 — Zero-based budgeting (ZBB) mode**
*What:* An alternate authoring mode where every line starts at zero and must be *justified* (activity/
cost-driver build-up) rather than grown off prior year — with AI surfacing prior-year detail and peer/
benchmark ranges to inform the justification.
*Trigger/data:* Cost owner opens a ZBB line. Reads prior detail, vendor-level spend, benchmarks. Writes
justification + built-up amount. *Bucket:* DRAFT (justification scaffold) + DETECT (outlier spend).
*HITL:* human justifies and owns every number. *Value:* Medium-high for cost-discipline cycles / PE-owned
turnarounds. *Build-state:* **none**. `[segment: cost-transformation]`.

**A5 — Budget version management & plan-of-record locking** [deterministic]
*What:* Named, immutable-once-locked budget versions (working / submitted / board-approved / reforecast-1…)
with the *active* plan-of-record flagged; full diff between versions.
*Trigger/data:* Planner creates/locks a version. Reads/writes `budget_versions` (table exists, unused).
*Bucket:* [deterministic]. *HITL:* human locks; lock is an audited config change. *Value:* High — kills the
"which spreadsheet is real" chaos; prerequisite for trustworthy BvA. *Build-state:* **none** (table exists,
no workflow — confirmed by FPB D3.3).

**A6 — Top-down target vs bottom-up build reconciliation ("gap to target")**
*What:* Show, live, the delta between leadership's handed-down target and the sum of department bottom-up
asks, per line and in total, with an AI-proposed allocation of the gap across departments to close it.
*Trigger/data:* Targets + collected departmental budgets. *Bucket:* DETECT (gap) + DRAFT (proposed cuts/
adds). *HITL:* CFO decides the allocation; AI proposes. *Value:* High — compresses the negotiation loop
that eats the calendar. *Build-state:* **none**.

**A7 — Assumption library & inflation/step-up auto-application** [deterministic + CLASSIFY]
*What:* A reusable, auditable set of named assumptions (merit %, inflation, tax rates, benefit loads) and
detection of *contractual step-ups* already in the ledger (rent escalators, SaaS renewals, insurance) that
should flow into next year automatically.
*Trigger/data:* Assumption set + recurring-contract/AP history. *Bucket:* CLASSIFY (identify step-up
contracts) + [deterministic] apply. *HITL:* planner confirms each detected step-up. *Value:* Medium-high —
the "we forgot the 5% rent bump" class of error. *Build-state:* **none**.

---

### Group B — Forecasting & reforecasting (the living plan)

**B1 — Rolling forecast (actuals-to-date + forecast-remaining)** ★ marquee
*What:* Blend closed-period actuals with a refreshed forecast for open periods into a single continuously-
updated full-year (or rolling-12/18-month) latest-estimate that reconciles to the annual budget.
*Trigger/data:* Each close. Reads posted actuals + the driver model / prior forecast. Writes a
`forecast_scenario` series. *Bucket:* FORECAST. *HITL:* AI proposes the refreshed forward path; planner
adjusts assumptions; human owns the published estimate. *Value:* Very high — the plan stays believed all
year instead of going stale by March. *Build-state:* **none** (FPB D9.2 confirms). `[common-core]`.

**B2 — Continuous forecast auto-tuning from actuals** ★
*What:* As each month actualizes, the model self-corrects its forward drivers (e.g. observed run-rate,
seasonality, trend) and reports *how much and why* it moved the estimate — a forecast that learns.
*Trigger/data:* New posted actuals. Reads history + prior forecast error. Writes an updated forecast +
a change-attribution. *Bucket:* FORECAST (backtested). *HITL:* proposal only; human accepts the re-tune;
every change logged with rationale. *Value:* High — turns reforecasting from a monthly rebuild into a
reviewed diff. *Build-state:* **none**.

**B3 — Reforecast triggers on variance** ★
*What:* Automatic detection that a variance is *material and persistent* (not noise) and therefore the
full-year estimate should move — raising a "reforecast recommended: Dept X trending +$240k/yr" exception,
not waiting for the quarter.
*Trigger/data:* Post-close BvA + prior-forecast-vs-actual by account/dept/entity, with materiality +
persistence thresholds. *Bucket:* DETECT + FORECAST. *HITL:* raises to a review queue with the projected
full-year impact; human decides whether to reforecast. *Value:* High — converts variance from hindsight
into a forward trigger; a natural Financial-Control-Exception-Library class. *Build-state:* **none**.

**B4 — Three-statement (integrated) forecast** ★
*What:* A budgeted/forecast P&L that *flows into* a budgeted balance sheet and cash flow via working-
capital drivers (DSO/DPO/DIO), a debt schedule, and a capex→depreciation link — so cash is planned, not
assumed. *Trigger/data:* P&L forecast + working-capital + debt/capex assumptions + opening balance sheet
(from the owned GL). *Bucket:* [deterministic] model; FORECAST for WC-driver suggestion. *HITL:* human
owns the WC/debt assumptions. *Value:* Very high — the difference between a real plan and a P&L that lies
about liquidity; the thing SMB tools never do. *Build-state:* **none**. `[common-core]`.

**B5 — Revenue / pipeline-driven revenue forecast**
*What:* Forecast revenue from operational drivers — sales pipeline × stage-weighted win-rate, backlog/
bookings burn-down, subscription ARR + net revenue retention + churn, or units × price — rather than a
flat growth %. *Trigger/data:* Pipeline/bookings/subscription data (via seam or import) + billing/AR
history from the owned ledger. *Bucket:* FORECAST. *HITL:* human owns win-rate/churn assumptions; AI
proposes from history. *Value:* High — revenue is the driver that moves everything downstream.
*Build-state:* **none**. `[segment: sales-led / subscription / project-backlog tenants]`.

**B6 — Cohort & unit-economics modeling (CAC / LTV / retention / contribution margin / payback)**
*What:* Native cohort retention curves and unit economics computed off the owned billing/AR/GL data —
CAC from S&M spend ÷ new logos, LTV from cohort revenue × margin × retention, payback period, contribution
margin per unit/customer. *Trigger/data:* Customer/invoice/cohort data + S&M expense from GL. *Bucket:*
[deterministic] + FORECAST (retention curve). *HITL:* advisory; human owns definitions. *Value:* High for
recurring-revenue tenants; a metric set every board asks for and nobody has natively. *Build-state:*
**none**. `[segment: subscription / recurring-revenue]`.

**B7 — Cash-flow / liquidity budget (indirect, monthly) + integration with the 13-week direct forecast**
*What:* A monthly forward cash projection (indirect method off the forecast P&L + balance-sheet drivers)
for the full budget horizon, that *ties into* the existing near-term 13-week direct cash forecast — the
long lens and the short lens reconciled. *Trigger/data:* Three-statement forecast (B4) + the live 13-week
engine (`lib/cash/forecast.ts`). *Bucket:* FORECAST. *HITL:* treasury owns funding decisions; AI never
moves money (money-movement is preparer≠approver + explicit release). *Value:* High — liquidity is the
number that breaks companies. *Build-state:* **partial** — 13-week direct forecast is **built**; the
monthly/indirect long-horizon budget and the reconciliation are **none**.

---

### Group C — Workforce, comp & capex planning (the two biggest line items)

**C1 — Headcount / roster / comp planning** ★
*What:* Plan people, not just a payroll number: a roster of current + planned hires by role/dept/entity
with start dates, base, bonus %, commission, and fully-loaded cost (taxes + benefits load), rolling up to
the comp budget and phasing correctly by start month. *Trigger/data:* Current roster (payroll/HR data via
seam), benefit-load rates, planned-hire inputs. Writes a headcount plan feeding comp budget cells.
*Bucket:* [deterministic] roster math; FORECAST for attrition/ramp. *HITL:* human owns the hiring plan;
AI can flag comp vs benchmark. *Value:* Very high — comp is usually the largest controllable cost and the
first lever pulled; per-head planning is what QBO/spreadsheets can't do. *Build-state:* **none**.
`[common-core; deeper for headcount-heavy tenants]`.

**C2 — Compensation & merit-cycle modeling**
*What:* Model merit increases, promotions, bonus-pool funding (as % of a plan metric), and commission
plans against attainment — with affordability checked against the EBITDA target. *Trigger/data:* Roster +
comp policy + plan metric. *Bucket:* [deterministic] + FORECAST. *HITL:* human owns policy. *Value:*
Medium-high. *Build-state:* **none**.

**C3 — Capex budgeting & the capex→depreciation→cash bridge**
*What:* Plan capital projects (asset, in-service date, amount, useful life, method) and auto-derive the
resulting depreciation schedule (into the P&L) and cash outflow (into the cash plan) — closing the loop
capex programs usually leave open. *Trigger/data:* Capex project list + depreciation policy; ties to the
fixed-asset subledger. *Bucket:* [deterministic]; CLASSIFY to suggest life/method. *HITL:* human owns the
program; the capitalize-vs-expense and §179/bonus *elections* stay human (see AI-Catalog B5). *Value:*
High for capex-heavy tenants; the depreciation and cash impacts are routinely forgotten. *Build-state:*
**none**. `[segment: capex-intensive]` (`[common-core]` at the light tier).

**C4 — Debt / financing schedule & interest forecast**
*What:* Model each facility (balance, rate, amortization, draws/paydowns, revolver) to forecast interest
expense and principal cash flows into the three-statement plan, and to feed the covenant engine.
*Trigger/data:* Debt terms + forecast cash. *Bucket:* [deterministic]. *HITL:* human owns terms. *Value:*
High for leveraged tenants; interest and mandatory amortization are large, contractual, and often mis-
modeled. *Build-state:* **none**. `[segment: leveraged/bank-financed]`.

---

### Group D — Variance, BvA & flux analysis (the monthly review)

**D1 — Budget-vs-actual auto-variance (versioned, dimensional, drill-through)**
*What:* BvA per account × dept × entity against the *active budget version* (and prior-year, and prior-
forecast), with % variance, favorability, materiality heat, and one-click drill from any variance to the
driving journal lines. *Trigger/data:* Active budget version + posted actuals. *Bucket:* [deterministic].
*HITL:* read/analysis surface. *Value:* High. *Build-state:* **partial** — BvA exists but is
*single-scenario* (ignores versions), lacks variance-to-transaction drill and heat thresholds (FPB D3.3).

**D2 — AI flux / variance narrative** ★ marquee
*What:* Auto-draft the "why" behind each material variance, citing the actual driving entries — "OPEX +18%
vs budget driven by a $92k one-time legal accrual in Legal (JE #4471) and 3 new hires in Sales starting
March." *Trigger/data:* BvA rows + the underlying GL detail + accrual/one-timer flags. *Bucket:* DETECT
(material moves) + DRAFT (prose). *HITL:* human owns and publishes the explanation; AI proposes candidate
drivers + draft narrative, never fabricates figures. *Value:* Very high — deletes the CFO's monthly manual
narrative; the owned ledger makes the citation exact. *Build-state:* **none** (FPB D14 spec'd, unbuilt).

**D3 — Missing-variance-explanation detector**
*What:* Flag any material variance that has *no* story yet (the negative signal — "this moved 40% and
nobody explained it") so nothing reaches the board unexplained. *Trigger/data:* BvA + narrative coverage.
*Bucket:* DETECT. *HITL:* raises to reviewer. *Value:* Medium-high — mirrors the controller's "always
report what's *missing*." *Build-state:* **none**.

**D4 — Budget alerts: approaching / over budget (real-time, not month-end)**
*What:* As actuals post through the month, alert a budget owner when a line is trending toward or past its
budget ("Marketing at 82% of the monthly budget on the 18th; projected 118% at run-rate"). *Trigger/data:*
Posted actuals vs budget-to-date + run-rate projection. *Bucket:* DETECT + FORECAST. *HITL:* notification;
optional soft/hard commitment gate at PO/bill time. *Value:* High — turns the budget from a hindsight
report into a live guardrail. *Build-state:* **none**. `[common-core]`.

**D5 — Commitment-aware budget consumption (encumbrance)**
*What:* Count *committed* spend (open POs, approved-unpaid bills, contracted recurring) against budget, not
just posted actuals — so "remaining budget" is real. *Trigger/data:* Open POs/commitments + bills + budget.
*Bucket:* [deterministic]. *HITL:* read surface + optional gate. *Value:* Medium-high; prevents the "we had
budget left" surprise when commitments land. *Build-state:* **none** (needs the PO/commitment model, GATE
11b). `[segment: PO-driven]`.

---

### Group E — Scenario, what-if & sensitivity (the judgment surface)

**E1 — Scenario modeling (base / upside / downside)** ★
*What:* Named scenarios over the same driver model, each with its own assumption set, viewable side-by-side
as full projected P&L (and, with B4, BS/CF). *Trigger/data:* Driver model + per-scenario assumptions.
*Bucket:* [deterministic] over the model; FORECAST for assumption suggestions. *HITL:* human owns
scenarios. *Value:* Very high — the core FP&A judgment tool; QBO/Sage lack it natively. *Build-state:*
**none** (FPB D9.1; needs `forecast_scenarios` + `forecast_assumptions`, FPB D13.6).

**E2 — Sensitivity analysis / tornado**
*What:* Auto-sensitize the 2–3 drivers that most move a target metric (EBITDA, ending cash, covenant
headroom) and show the swing — "±3% price = ±$1.4M EBITDA; ±1pt churn = ±$600k." *Trigger/data:* Driver
model + target. *Bucket:* [deterministic]. *HITL:* analysis surface. *Value:* High — focuses the board
conversation on the levers that matter. *Build-state:* **none**.

**E3 — Natural-language "what if" query** ★
*What:* Ask in plain language — "what if we hire 5 reps in Q2 and raise price 4%?" — and get a modeled
projected P&L/cash impact with the assumptions it used, fully cited, never fabricated. *Trigger/data:* NL
prompt → mapped to real drivers/scenario config. *Bucket:* DRAFT (parse intent) → [deterministic] model.
*HITL:* human reviews the mapped assumptions before trusting; every run logged (FPB AC14.1 — maps to a real
config, never fabricates figures). *Value:* Very high — the "BEAT QBO" AI-native FP&A surface. *Build-state:*
**none** (a decorative NL box exists in reports per FPB D14; no real mapping).

**E4 — Goal-seek / target-driven planning**
*What:* Work backwards — "what revenue growth and headcount freeze get us to 22% EBITDA margin?" — solving
for the driver values that hit a target. *Trigger/data:* Target + solvable drivers. *Bucket:* [deterministic]
solve. *HITL:* human picks which levers are solvable. *Value:* Medium-high. *Build-state:* **none**.

**E5 — Monte-Carlo / probabilistic ranges (advanced)**
*What:* Instead of three point-scenarios, distribute key drivers and produce a probability range for the
outcome (P10/P50/P90 EBITDA or ending cash). *Trigger/data:* Driver distributions. *Bucket:* [deterministic]
simulation. *HITL:* analysis. *Value:* Medium — sophisticated tenants/boards. *Build-state:* **none**.
`[segment: sophisticated FP&A]`.

---

### Group F — Collaboration, workflow & approvals (the human process)

**F1 — Department budget collaboration & submission workflow**
*What:* Push a scoped template to each budget owner, collect line-item inputs in-app (no spreadsheets
emailed around), track submission status, and consolidate bottom-up automatically. *Trigger/data:* Budget
cycle + owner assignments (Core identity/RBAC). *Bucket:* [deterministic] workflow. *HITL:* the workflow
*is* the human process. *Value:* High — kills version chaos and the chase. *Build-state:* **none** (needs
RBAC/identity gate #9 to scope owners). `[common-core]`.

**F2 — Budget approval / ratification workflow (SoD-bound)**
*What:* Route a submitted budget version through defined approvers (dept head → FP&A → CFO → board-ratified)
keyed to Core roles, with preparer≠approver and an immutable trail; ratification locks the plan-of-record.
*Trigger/data:* Submitted version + approval chain. *Bucket:* [deterministic]. *HITL:* the control *is* HITL;
approvals logged to `core.action_log`. *Value:* High — makes the budget an auditable book artifact, not a
file. *Build-state:* **none**. `[common-core]`. *Prereq:* identity/RBAC gate #9.

**F3 — Budget change log & audit trail**
*What:* Every cell change, who/when/why, diff between versions, full history — the budget held to the same
attribution standard as the ledger. *Trigger/data:* All budget writes. *Bucket:* [deterministic]. *HITL:*
audit surface. *Value:* Medium-high — trust + board defensibility. *Build-state:* **none** (`created_by`
exists on `budgets` but no change log).

**F4 — Budget owner nudge / deadline chase orchestration**
*What:* Auto-remind stragglers, escalate as the deadline nears, maintain a live "waiting on" board for the
budget cycle. *Trigger/data:* Submission status + deadlines. *Bucket:* DRAFT (the nudge). *HITL:* review or
auto-send trusted categories. *Value:* Medium — removes pure chase labor. *Build-state:* **none**.

---

### Group G — Board, lender & external reporting (the deliverable)

**G1 — Board / management package auto-generation** ★
*What:* One-click assemble the monthly package — KPI dashboard, consolidated + entity P&L/BS/CF with BvA
and variance commentary (D2), reforecast, cash/liquidity, forward look — from live ledger data into a
branded, exportable (PDF/XLSX/deck) deliverable. *Trigger/data:* Close complete + report configs + AI
narrative. *Bucket:* DRAFT (narrative + layout) over [deterministic] statements. *HITL:* human reviews
before it leaves the building. *Value:* Very high — deletes days of copy-paste; consistent across entities.
*Build-state:* **none** (statements + export partly exist per reports FPB D7; assembly/narrative unbuilt).
`[common-core]`.

**G2 — Covenant-aware forecasting & continuous covenant monitor** ★ marquee (from AI-Catalog E1)
*What:* Machine-readable covenant definitions per credit agreement (DSCR, FCCR, leverage/net-debt-to-EBITDA,
current ratio, min liquidity, TNW) computed *continuously* on actuals + forecast, with graduated green/
amber/red headroom and a projected breach date; drafts the compliance certificate. *Trigger/data:* Covenant
defs + live/forecast GL + borrowing-base feed. *Bucket:* FORECAST + DRAFT. *HITL:* CFO reviews and signs —
**never auto-file a certification**; bias conservative (a false amber is cheap, a false green is
catastrophic). *Value:* Very high / existential — waiver fees $25k–$250k, acceleration, cross-default;
discovering a breach after quarter-close is too late to cure. The owned-ledger + native-forecast moat is
exactly what makes *continuous* (not quarterly) covenant testing possible. *Build-state:* **none** (cataloged
E1, GATE 7). `[segment: leveraged/bank-financed — the Merit tenant needs it now]`.

**G3 — Borrowing-base certificate & eligible-collateral forecast**
*What:* Compute the borrowing base (eligible AR/inventory with advance rates and ineligibility rules) and
forecast availability, feeding G2 and the cash plan. *Trigger/data:* AR aging + inventory + advance-rate/
eligibility rules. *Bucket:* [deterministic] + DETECT (ineligibility). *HITL:* CFO signs the certificate.
*Value:* High — lending against ineligible/aged AR is itself a covenant violation. *Build-state:* **none**.
`[segment: asset-based-lending]`.

**G4 — Lender/investor package & data-tape generation**
*What:* Produce the lender-specific compliance package and the recurring investor update (KPIs, entity
roll-ups, cash, variance narrative, forward look) on the credit-agreement/LPA cadence. *Trigger/data:*
Statements + covenants + narrative. *Bucket:* DRAFT. *HITL:* human sign-off before send. *Value:* High.
*Build-state:* **none**. `[segment: financed / investor-backed]`.

**G5 — Benchmark vs peers / industry**
*What:* Compare the tenant's ratios and cost structure (gross margin, OPEX %, DSO/DPO, comp/revenue) to
industry benchmarks to sanity-check the budget and inform ZBB/targets. *Trigger/data:* Tenant financials +
a benchmark dataset (external). *Bucket:* DETECT (outliers). *HITL:* advisory. *Value:* Medium — good
target-setting input; depends on a benchmark data source. *Build-state:* **none**. `[segment]`.

---

### Group H — Long-range & strategic planning

**H1 — Long-range plan (3–5 yr) that stays connected to actuals** ★
*What:* A multi-year top-down three-statement model that *refreshes its base* each close from the owned
actuals — growth trajectory, margin ramp, capex program, debt/covenant runway — so the LRP never becomes
fiction. *Trigger/data:* Driver model extended to years + actual refresh. *Bucket:* [deterministic] +
FORECAST. *HITL:* leadership owns the strategy. *Value:* High — the owned-ledger fixes the LRP's fatal flaw
(disconnection from reality). *Build-state:* **none**. `[segment: PE-backed / strategic]`.

**H2 — Value-creation / equity-bridge & returns (MOIC/IRR) model**
*What:* For PE-backed tenants, a value-creation bridge (EBITDA growth × multiple ± debt paydown) and a
returns view across the hold period. *Trigger/data:* LRP + cap structure + entry/exit assumptions.
*Bucket:* [deterministic]. *HITL:* deal team owns. *Value:* Medium-high for the PE segment. *Build-state:*
**none**. `[segment: PE portfolio]`.

**H3 — Reusable deal/ad-hoc model templates (new location, acquisition, pricing, financing)**
*What:* Fork the tenant's driver model into a scoped ad-hoc model (new-location pro forma, tuck-in
acquisition + integration, price-change impact, financing scenario) instead of building from scratch.
*Trigger/data:* Base model + scenario deltas. *Bucket:* [deterministic]. *HITL:* human owns. *Value:*
Medium-high — every ad-hoc model today is a from-scratch spreadsheet. *Build-state:* **none**.

---

### Group K — AI-native cross-cutting (the supervision & intelligence layer)

**K1 — NL report/plan composer ("ask for any budget/forecast view")**
*What:* Plain-language requests mapped to a real report/plan configuration — "show me FY26 budget vs actual
for the East region, OPEX only, by month" — never fabricating figures. *Bucket:* DRAFT→[deterministic].
*HITL:* human trusts the rendered config. *Value:* High. *Build-state:* **none** (decorative box only,
FPB D14). *Overlaps E3* (what-if) — same NL surface, different verbs.

**K2 — Forecast accuracy / bias tracking (backtest the machine)**
*What:* Track forecast-vs-actual error over time by account/dept/driver, surface systematic bias, and feed
it into auto-tuning (B2) and the autonomy dial — so the machine's forecasting is *measured*, not trusted
blindly. *Trigger/data:* Historical forecasts + actuals. *Bucket:* DETECT. *HITL:* analysis; governs how
much autonomy the forecast earns. *Value:* Medium-high — trust is earned with a track record. *Build-state:*
**none**.

**K3 — Decision-Log for every AI-proposed budget/forecast/narrative**
*What:* Every AI draft (A1, B1/B2, D2, E3, G1/G2) writes to `public.ai_decisions` / `core.action_log` with
inputs, assumptions, confidence, and the approving human. *Bucket:* [control primitive]. *HITL:* the control
*is* HITL. *Value:* High — non-negotiable for a signed plan/covenant. *Build-state:* **none** for FP&A
(the log infra exists; no FP&A writers). *Prereq:* identity/RBAC gate #9.

**K4 — Autonomy dial for FP&A tasks**
*What:* Per-tenant/per-task thresholds governing what an AI forecast/narrative can do unattended (e.g.
auto-refresh a rolling forecast within tolerance vs stop-and-ask), defaulting OFF, loosened only as K2
accuracy earns it. *Bucket:* [routing over `scoreToTier`]. *HITL:* thresholds are the supervisor's dials.
*Value:* Medium-high. *Build-state:* **none** for FP&A. *Prereq:* GATE 5.

---

## Part 3 — Ranked "build-first" shortlist (mapped to gates; each needs an FPB)

Ranked by *(owned-ledger leverage × operator value × trust-to-sign × build-ease on existing primitives)*,
respecting the canon rule that **no gate starts until its `Prereq:` gates are DONE** and that the standing
identity/RBAC NO-GO gate (#9) underwrites every approval/attribution story. **Each item needs its own
approved Rule-13 FPB before any build.** Most of Group A/B/D/E belong to **GATE 7 (reporting/FP&A depth —
`FPB-financial-reports.md` already frames D8/D9/D14)**; consolidation-scoped views ride **GATE 11a**;
covenant/borrowing-base are `[segment]` but the Merit tenant needs them.

1. **A5 Budget version management + A1 AI budget draft + A2 seasonality spreading** → **GATE 7.** The
   foundational triad: a real plan-of-record (the `budget_versions` table already exists, unused), the
   one-click draft off owned actuals (the biggest annual time-sink, and pure owned-ledger moat), and
   meaningful monthly phasing. Turns the thin built grid into an actual budgeting product. *Needs an FPB*
   (extends `FPB-financial-reports.md` D8).

2. **D1 versioned dimensional BvA + D2 AI flux narrative** → **GATE 7.** Highest-frequency FP&A ritual
   (monthly), directly reuses the existing BvA route + the owned GL for exact citations; D2 is a marquee
   "BEAT QBO" AI surface. Fixes the acknowledged BvA defects (single-scenario, no drill, no narrative).
   *Needs an FPB* (extends D3.3/D14).

3. **B1 rolling forecast + B3 reforecast-on-variance trigger** → **GATE 7.** Makes the plan *live* instead
   of stale-by-March; B3 is a natural Financial-Control-Exception-Library class (reuses the trust spine).
   The owned ledger makes "actualize the closed month, roll the rest forward" a query, not a rebuild.
   *Needs an FPB* (D9.2).

4. **A3 driver-based budgeting + E1 scenarios + E3 NL what-if** → **GATE 7.** The core modern-FP&A engine
   and the AI-native differentiator (`forecast_scenarios`/`forecast_assumptions` model, FPB D9/D13). Highest
   product-differentiation value; larger build (new model). *Needs an FPB* (D9.1/D9.3/D14).

5. **G2 covenant-aware continuous monitor (+ G1 board-package generation)** → **GATE 7, `[segment]`.**
   Existential value (waiver fees $25k–$250k; the CFO's career risk) and the purest expression of the moat:
   *continuous* covenant testing on actuals+forecast is impossible without an owned, live ledger. G1 deletes
   days of package assembly. The Merit tenant (leveraged multi-entity) needs the covenant monitor now.
   *Cataloged as E1; needs its own FPB.*

**Deferred/dependent (still valued, but gated behind prereqs):** B4 three-statement forecast & B7 monthly
cash budget (need the balance-sheet/WC driver model), C1 headcount/comp plan (needs the payroll/HR roster
seam), C3 capex plan (needs the fixed-asset subledger), D5 commitment-aware consumption (needs the PO model,
GATE 11b), F1/F2 collaboration & approval workflow (need identity/RBAC gate #9), H1–H3 long-range/deal
models (build on the driver engine). All fold into GATE 7 or its downstream gates behind their own FPBs.

**The owned-ledger moat, restated for the build:** every item above is *worse* in every competing FP&A
tool for one structural reason — their plan is divorced from the ledger and spends its life fighting to
reconcile. MeritBooks builds the budget and the forecast **on the book of record itself**: the baseline is
a query, the reforecast is incremental, the variance drills to the journal line, the covenant tests
continuously, and the narrative cites the exact entry. Build FP&A as the native third pillar it is — AI
drafts the plan and the story, the deterministic engine does the math, and the human owns every number
that gets signed.
