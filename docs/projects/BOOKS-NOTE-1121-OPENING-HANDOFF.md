# Note for the Books session — migration 1121 (imports & opening balances from Projects)

Migration `1121_pm_imports_onboarding.sql` lets a company bring its records in from the tool it used before
(Buildertrend, JobTread, CoConstruct, ServiceTitan, FieldEdge, simPRO, Housecall Pro, Jobber, c-Systems, Procore,
Excel, QuickBooks exports). Projects creates only operational records (customers / vendors / contacts / sites
through `core.match_parties` + `pm.create_customer` / `pm.create_vendor` / `core.create_contact` / `core.create_site`,
jobs through `pm.create_project`, agreements through `pm.fs_import_agreements`, units / parts in `pm`). It never
writes the GL. Opening balances are handed to Books as **validated opening positions**:

- `pm.opening_handoffs` — one live row per company × kind (`JOB_WIP`, `AGREEMENT_DEFERRED`, `DEALER_UNITS`,
  `OPEN_AR`, `CUSTOMER_DEPOSITS`, `PARTS_INVENTORY`, `WARRANTY_RECEIVABLE`); `status` DRAFT → VALIDATED → SUBMITTED
  (owner sends it) → ACCEPTED / REJECTED (Books answers). Totals are re-footed in SQL; `blockers` must be empty to send.
- `pm.opening_job_facts` — per mid-stream job: original contract, approved COs, revised contract, EAC, cost to date,
  billed to date, retainage held / payable, deposits, open commitments, earned / over / under (Books' own
  `computeWipJob` arithmetic, parity-tested), last pay app, SOV lines with billed to date, budget by cost code.
- `pm.opening_tieout(handoff)` compares each fact with Books (posted GL lines by job and by account role,
  `core.jobs` opening columns, `public.dealer_units` + open `floor_plan_notes`, open invoices, customer deposits).

## What Books must accept (none of this exists in Books today)

1. **A reader for SUBMITTED handoffs** (service role): `select * from pm.opening_handoffs where status = 'SUBMITTED'`,
   then answer with `select pm.opening_books_decision(id, 'ACCEPTED' | 'REJECTED', books_ref, reason)` (service-only).
2. **JOB_WIP — a job-dimension opening entry.** `payload.job_dimension_lines` = one line per job × account role
   (`JOB_WIP` Dr cost to date, `UNBILLED_RECEIVABLE` Dr under-billing, `DEFERRED_REVENUE` Cr over-billing,
   `RETAINAGE_RECEIVABLE` Dr, `RETAINAGE_PAYABLE` Cr, `CUSTOMER_DEPOSITS` Cr), each with `job_id` (the Projects job =
   `core.jobs.id`). Books' conversion `buildOpeningEntryLines` has no job dimension: these lines must either carry
   `gl_entry_lines.job_id` on the opening JE, or post as a reclass of the untagged opening TB balance of the same role
   (net zero per role). `payload.subledger_detail` uses the `ImportedSubledgerDetail` keys so the go-live tie
   (`buildGateSubledgerTies`) can fire.
3. **JOB_WIP — the jobs already exist.** `payload.books_wip_jobs` is Books' `ProposedJob[]` with `projectsJobId`.
   Books' `createOpeningJobs` INSERTS `core.jobs` (job-number unique → every row errors). Books must UPDATE the
   existing job by `projectsJobId` instead (`actual_cost_cents`, `billed_to_date_cents`, `retainage_held_cents`,
   `original_contract_cents`, `approved_co_cents`, `estimated_cost_cents`, `pct_complete`); the Projects tie-out
   reads those columns until the GL lines exist.
4. **DEALER_UNITS — unit cost basis + one file per lender.** `payload.books_opening_files[]` = Dealer Pack OPENING
   rows grouped by floor-plan lender (Books' OPENING import floors a whole file onto one line). Books' OPENING fields
   have no unit cost: the rows add `unitCostCents` (dollars text); Books must accept it as `dealer_units.cost_cents`
   (source `OPENING`). With Projects on, Books' unit import is switched off for the client (one master) — these files
   are the only unit load. The units already exist in Projects as `pm.assets` (no `DEALER_UNIT_RECEIVED` was emitted).
5. **AGREEMENT_DEFERRED** — the deferred balance per agreement already rides `pm.agreement_revenue_facts` kind
   `OPENING_BALANCE` (1117); Books must book it to `DEFERRED_REVENUE` by agreement (today nothing consumes it).
6. **OPEN_AR / CUSTOMER_DEPOSITS / PARTS_INVENTORY / WARRANTY_RECEIVABLE** — informational positions for Books' own
   QBO / CSV conversion (AR stays Books' import; deposits are a liability on `CUSTOMER_DEPOSITS`; parts value on
   `INVENTORY_ASSET`; open claims as warranty receivable).

No Books table or migration was changed. Nothing in 1121 is executable by anon; the handoff tables are class C / M
(`projects.financials`), and `pm.opening_books_decision` is service-role only.
