# Feature Product Brief — Payroll (GATE 12.3)

**Status:** Draft for Mike's sign-off (Rule 13)
**Module:** Embedded payroll — run, post, remit, file, and reconcile payroll against a licensed provider
**Author:** Auditor (Session 40 wave)
**Governing principle (canon, non-negotiable):** *MeritBooks is NEVER the regulated party.* A licensed provider (Check or Gusto Embedded) calculates taxes, moves money, remits to agencies, and files returns behind a Books-owned `PayrollEngine` capability interface. MeritBooks owns the GL posting, reconciliation, approval + audit, the data model, and the UI — **not** the tax engine, the bank movement, or the filing.
**Grounds against what is already built:** migrations `041_provider_connections` (Core secret vault), `042_money_movement_approvals` (preparer≠approver CHECK), `043_money_movement_posting` (1095/1096 clearing accounts, `ach_authorizations`), `044_payroll_posting` (2270 Garnishments Payable + 9 payroll role keys), `045_employer_benefit_roles` (6020/6030/6040 employer-benefit expense roles), `055_money_movement_entry_types` (`PAYROLL_RUN` entry_type enum value), `061/062` identity + action_log; and `apps/web/src/lib/posting/payroll.ts` (`recordPayrollRun` / `recordPayrollRemittance`).

---

## 0. The one-paragraph version

A tenant runs payroll every pay period: it tells the system who is being paid and for what (hours, salary, bonus, reimbursements), a **licensed provider** computes gross-to-net (all federal/state/local tax withholding and employer tax), a human at the tenant **reviews and approves** the run under separation of duties, a second human **releases** the money (no automated transfers — ever), the provider debits the tenant's bank and pays employees, the agencies, and the garnishment recipients, and MeritBooks **posts the whole thing to the double-entry GL with department / job / class dimensions** and then **reconciles the single provider debit against the bank feed**. The GL posting layer for this already exists and balances (`recordPayrollRun`); everything *around* it — the employee/comp data model, the pay-schedule engine, the earnings/deduction model, the run workflow UI, the provider adapter, PTO accrual, the 1099-NEC contractor path, filing status surfacing, and reconciliation — is what this brief specs. The single differentiator versus every incumbent is that payroll is **ledger-native and job-costed at the line level inside the same book of record** — labor lands on the job and the department P&L with no export, no sync, no reconciliation boundary.

---

## 1. Job & user

**Primary user — the payroll runner** (bookkeeper / accounting specialist / controller). Every pay period they need to: confirm the roster and hours, see the provider's computed gross-to-net *before* committing, catch anomalies (a $40k paycheck, a terminated employee still on the run), route it for approval, and know the money and the taxes went out and were filed. Today they do this in a *separate* payroll app (Gusto, QBO Payroll, ADP) and then re-key or import a summary journal entry into the ledger — the exact reconciliation boundary MeritBooks exists to erase.

**Second user — the approver** (CFO / merit_controller / company_admin). Under separation of duties they must be a *different* human than the preparer (DB-enforced, §12). They approve the dollar amount and the funding, not the keystrokes.

**Third user — the releaser.** The person who authorizes the actual bank debit. Can be folded into the approver role by policy but is a distinct *action* (explicit human release; there is no "auto-run payroll" switch — canon VIII.7: "there is never a global 'let the AI run' switch").

**Fourth user — the employee / contractor** (self-service, read-only): views and downloads pay stubs, year-end W-2 / 1099-NEC, and PTO balance. Delivered by the provider's employee portal in v1 (link out), surfaced natively later.

**What they use today:** Gusto / QuickBooks Payroll / ADP Run / Rippling. All are *separate systems* whose output has to be journaled back into the books. None post to a real job-costed GL at the line level; all require a downstream mapping/import step. That gap is the product.

## 2. Data captured

The organizing rule from the ownership matrix (FILE 2) and CANON §2: **payroll PII never lives in an app table.** `core.employees` stays THIN identity + the one Books-owned field it already has. SSN, bank account, routing number, and withholding elections (W-4 / state) live **only at the provider and in the Core secret path** — never in `public` or `core` columns.

**Thin identity (already exists — `core.employees`, migration 019):** `id`, `name`, `status`, `clerk_user_id` (nullable — the canonical suite user link; "a user logs in, an employee is a labor resource; they may link but need not"), `default_labor_rate`, `default_billing_rate`, `payroll_account_id` (FK → `public.accounts`, Books-owned). No new PII columns are added here.

**New Books-owned comp/mapping layer (net-new, non-PII):**
- `payroll.employee_comp` — per (org, employee): pay basis (`HOURLY` | `SALARY`), base rate or annual salary (bigint cents), standard hours, default `department_id`, default `location_id` (entity), default `class_id`, default `job_id` (nullable — for direct labor), `provider_employee_id` (opaque handle, not PII), `is_contractor` (drives 1099 vs W-2 path), status. *No SSN, no bank data.*
- `payroll.pay_schedules` — per (org, location): frequency (`WEEKLY` | `BIWEEKLY` | `SEMIMONTHLY` | `MONTHLY`), period anchor, pay-date offset, next period boundaries. Pay dates are a *product of setup*, mirroring how fiscal periods are generated at onboarding (identity FILE 4), never invented at run time.
- `payroll.runs` — one row per pay run: `pay_schedule_id`, `period_start`, `period_end`, `pay_date`, `status` (see §5), `provider_run_id`, `approval_id` (FK → `public.approvals`), `gl_entry_id` (FK, set on post), totals (gross/net/employer-tax/employee-withholding), `bank_txn_id` (FK → bank feed, set on reconcile).
- `payroll.run_lines` — one row per employee per run: `employee_id`, `gross_cents`, `net_cents`, and the **dimension stamp** (`department_id`, `job_id`, `class_id`, `location_id`) that makes the GL job-costed; plus a jsonb `earnings` / `deductions` / `employer_contributions` breakdown returned by the provider (amounts only — never account/routing numbers).
- Provider secrets: registered in `core.provider_connections` (capability `PAYROLL`, provider `check` | `gusto`), secret in Vault via `core.store_provider_secret` (migration 041). The row holds `account_handle` + `secret_ref` only.

**Earnings types (captured on `run_lines.earnings`, all bigint cents):** hourly, salary, overtime (1.5×), double-time, bonus, commission, reimbursement (non-taxable, does not hit wage expense — posts to the expense/clearing account it reimburses), tips (reported + paid). Provider computes tax on the taxable subset; Books posts the amounts.

**Deductions & contributions (`run_lines.deductions` / `employer_contributions`):** pre-tax (traditional 401(k), HSA, FSA, pre-tax health premium — reduce taxable wages, provider handles), post-tax (Roth 401(k), post-tax deductions), and **garnishments** (child support, tax levy, creditor) which post to **2270 Garnishments Payable** (seeded by migration 044) and are remitted by the provider. Employer contributions (employer 401(k) match, employer health, workers comp) post to expense (6020/6030/6040 per migration 045) and to their matching payables.

## 3. Presentation & document output

**Payroll dashboard (`/payroll`):** next pay date, run status, an anomaly panel (§13 AI), YTD payroll cost by department and by job, and a "Run payroll" CTA. States per §4.

**Run wizard (the core surface):**
1. *Roster & inputs* — employees on this schedule, hours pulled from the PM module time module where entitled (`entitlements.projects`), else keyed; salary auto-filled; add bonus/commission/reimbursement lines; each line shows its department/job/class dimension (editable, defaulted from comp).
2. *Preview (provider-computed)* — the returned gross-to-net per employee and in total: gross, each employee withholding, net, each employer tax, total employer cost. **This is a read-back of the provider's calculation, never a Books calculation.** Shows the funding total (net pay + taxes + garnishments) that will debit the bank.
3. *Review & submit for approval* — routes to the approver.
4. *Approve* (different user) → *Release* (explicit) → provider executes → *Posted* → *Reconciled*.

**Documents:** pay stubs and W-2 / 1099-NEC are **provider-generated** in v1 (the provider is the filer of record); MeritBooks links to the provider's employee portal and stores the provider document reference. A native branded pay-stub PDF is a v2 enhancement (Rule 2), not a v1 gate — the provider is authoritative for the filed figures.

## 4. States

Empty (no pay schedule / no provider connected → onboarding CTA, not a crash), configured-but-no-runs, draft-in-progress, awaiting-approval, approved-awaiting-release, released-provider-processing, posted, reconciled, failed/returned (provider debit returned — NSF), and **provider-not-connected** (roster and preview disabled; the ledger and everything upstream still function — "never make a core capability depend on a provider being installed"). First run with no historical YTD must still compute correctly (provider holds YTD).

## 5. Lifecycle & status model

`payroll.runs.status`: `DRAFT` → `PENDING_APPROVAL` → `APPROVED` → `RELEASED` → `PROCESSING` → `POSTED` → `RECONCILED`; plus `REJECTED`, `RETURNED` (bank return), `VOID`. This maps 1:1 onto the existing generic `public.approvals` state machine (`kind='PAYROLL_RUN'`, statuses `DRAFT|PENDING_APPROVAL|APPROVED|RELEASED|SETTLED|REJECTED|RETURNED` — migration 042) and each transition writes an `approval_steps` row (`PREPARED|SUBMITTED|APPROVED|RELEASED|SETTLED|REJECTED|RETURNED`) and a `core.action_log` entry (migration 062). **A run may only post to an OPEN fiscal period** (`enforce_period_lock`); landing on a CLOSED/LOCKED period is rejected with reason (matrix Rule F). GL posts at `RELEASED→POSTED`; reconcile at `POSTED→RECONCILED` when the provider debit matches a bank-feed line.

## 6. Actions & options

- Runner: create/edit a draft run, pull hours, add off-cycle earnings, run preview, submit for approval, void a draft.
- Approver (distinct user): approve or reject with reason.
- Releaser: release funding (explicit, logged) or hold.
- Anyone with view: inspect a posted run, drill from the GL entry to the run to the employee lines.
- Off-cycle / bonus run, correction run, and **void/reissue** (a posted run is immutable; a correction is a new reversing run — never an in-place edit, mirroring the posted-invoice rule).
- Contractor payment (1099-NEC path, §11) as a distinct run kind that skips tax withholding.

## 7. Edit & correction model

Draft runs edit freely. Once `POSTED`, a run is immutable: corrections are a **reversing/adjustment run** (DR/CR reverse of the original, then a fresh correct run), producing a clean audit trail, consistent with the "posted financial change reverses+reposts GL, never edits in place" rule (Master Doc XI). Any post-approval change to a draft resets it to `DRAFT` and voids the prior approval (SoD integrity — you cannot approve figures then change them).

## 8. Delivery & sharing

Pay stubs and year-end forms delivered via the provider's employee self-service portal in v1 (email + portal link), with the provider as filer of record. MeritBooks stores document references and exposes an employee-facing read-only view later. No new outbound delivery surface is built by Books in v1 beyond the provider link and internal notifications (run approved / released / posted / returned).

## 9. Automation

- Hours auto-pull from the PM time module when `entitlements.projects` is set (labor already carries `job_id` → straight to job cost).
- Provider computes all tax math, remittance, and filing automatically — Books never computes a tax.
- **Payroll accrual at close:** for a pay period spanning a period-end, auto-propose an accrual JE (DR wage expense / CR Accrued Payroll) reversing next period — an AI/close automation (§13), advisory, human-approved.
- Recurring pay schedule advances automatically (next period boundaries), but **a run never executes without explicit human approval + release** — automation prepares, humans commit. No auto-run switch (canon VIII.7).
- Auto-reconcile the provider debit against the bank feed (§13).

## 10. Analytics & insight

Payroll cost by department, by job (the differentiator), by class, and by pay period; effective labor burden rate per department (employer taxes + benefits ÷ gross) as an *analytic read-out*, explicitly **NOT** the retired overhead/burden-rate posting engine (CANON §2 — do not rebuild that; this is reporting only); overtime trend; headcount cost trend; employer-tax and benefit run-rate for the 13-week forecast. The FPB's job is to guarantee the *data* is captured at line + dimension granularity to support these — it is, via `run_lines` and the dimensioned GL.

## 11. Integration & GL — the money flow

**The GL posting already exists and balances** (`recordPayrollRun`, `apps/web/src/lib/posting/payroll.ts`). Per run, from the provider's computed figures:

```
DR  6000  Salaries & Wages (gross)                 [+ job_id/department_id/class/location dims per line]
DR  6010  Employer Payroll Taxes (expense)
DR  6020/6030/6040 Employer health / 401(k) match / workers comp (employer contributions)
  CR 1096 Payments in Transit (net pay funding float)          net pay
  CR 2200/2210/2220 Federal / State / FICA payable             employee tax withholding
  CR 2230/2240 Health / 401(k) payable                         employee deductions
  CR 2270 Garnishments Payable                                 garnishments
  CR 2200/2210/2220/2250 employer-tax + workers-comp payables  employer liabilities
```

Balance identity enforced before post: `net = gross − Σ withholdings` and `Σ employer-tax expense = Σ employer-tax liability`; the whole entry ties via `check_journal_balance()`. Net pay clears through **1096 Payments in Transit** (migration 043); the single provider bank debit (net + taxes + garnishments) later clears the payables + 1096 via `recordPayrollRemittance` — or, when the provider makes one consolidated debit, that debit reconciles against the bank feed and clears the transit/payable balances. **Every line carries department / job / class / location dimensions** — this is the job-costing differentiator and the reason payroll must post inside the book of record, not import a summary JE.

**Known wiring gap to close (Rule 11 honesty):** `recordPayrollRun` currently posts `entry_type: 'STANDARD'`, but migration 055 added a dedicated `PAYROLL_RUN` enum value — the builder should be switched to `PAYROLL_RUN` so the schema-drift guard (`schema.test.ts`) and reporting can distinguish payroll entries. Small, in-scope.

**Contractor (1099-NEC):** a contractor payment is an **AP disbursement, not payroll** — no tax withholding, no employer tax. It runs through the bills/AP path (DR contractor expense / CR Payments in Transit), tagged `is_1099`, and the provider (or a year-end job) files 1099-NEC. Kept in this brief because it shares the run UI and the "pay people" mental model, but it must post as AP, not wages.

**Remittance & filing:** the provider remits withheld taxes and garnishments to agencies/recipients and files (941/940, state, W-2/1099). Books posts the liability at run time and clears it when the provider's remittance debit hits the bank feed. Books never touches an agency.

## 12. Permissions / RBAC

Roles come from `lib/rbac/permissions.ts` (`ROLE_DEFINITIONS`, 9 roles). The `payroll` feature already exists (`{ id: 'payroll', actions: ['view','create','approve'], internalOnly: true }`) with a `payrollVisibility` dial (`ungrouped` / `grouped` / `none`) per role.

- **Run (prepare):** any role with `payroll: create` (accounting specialist and up).
- **Approve:** `payroll: approve` — CFO / merit_controller / company_admin. **Must be a different `clerk_user_id` than the preparer** — enforced by the DB CHECK `approvals_preparer_ne_approver` (migration 042), not just UI.
- **Release funding:** the approve-and-above set; a distinct logged action.
- **Authorization must reconcile to Core identity** (`core.users` / `core.memberships` / `core.roles`, migration 061). The interim `canApprove` reads `core.employees.role` as a stopgap (flagged in CANON §3 and the identity FPB); payroll approval must resolve on the canonical membership spine as that lands — **do not bake a Books-private "who may approve payroll" that won't reconcile to `core.memberships`** (suite contract FILE 1). Payroll visibility (`grouped` hides individual amounts) gates *who can see individual pay*, orthogonal to who can approve the run total.

## 13. AI dimension

Advisory only, human-approved, every action logged to the Decision Log (`public.ai_decisions`, migration 039) — the AI never writes debits/credits and never releases money (SoD applies to the AI itself, canon VIII.7):
1. **Run anomaly review** — before submit, the AI flags outliers (paycheck N× the employee's trailing average, a terminated employee on the roster, missing hours, a duplicate off-cycle, a garnishment that changed) with a one-line reason. The single highest-value payroll AI feature.
2. **Labor → job attribution** — propose the `job_id` / `department_id` for each line from the employee's recent time entries or history when a dimension is blank, so labor lands on the right job without manual tagging.
3. **Auto-reconcile** — match the provider's consolidated bank debit to the posted run + payable clearings automatically (extends the reconciliation autopilot already built), accept high-confidence, queue the rest.
4. **Payroll accrual at close** — auto-propose the period-spanning accrual JE (§9) with a documented basis.

All four route through the Core-owned AI gateway (`@meritbooks/core-ai`), metered to `core.ai_usage_log` against the tenant's combined-suite budget — no module-local Anthropic key (CANON §2).

## 14. Comparative benchmark (Rule 14) — NAMED DELTAS

| Capability | QBO Payroll | Gusto | ADP Run | **MeritBooks target** |
|---|---|---|---|---|
| GL posting | Summary JE into QBO; class-level at best | Export / generic JE mapping | Export / GL interface file | **Line-level, job + department + class dimensions, native in the book of record — no import** |
| Job costing labor | Weak; class hack | Add-on, limited | Add-on | **Every payroll line lands on the job P&L and WIP automatically — the core differentiator** |
| Tax calc/remit/file | Intuit (regulated) | Gusto (regulated) | ADP (regulated) | Provider (Check/Gusto Embedded) — parity by design; Books never the filer |
| Anomaly review | None / basic | Basic | Basic | **AI run anomaly review with reasons, pre-submit** |
| Separation of duties on the run | None (single approver) | None | Limited | **DB-enforced preparer≠approver + explicit release + full audit** |
| Child-support garnishment remittance | Manual by employer | Supported | Supported | **Automated garnishment remittance via provider + 2270 tracked in-ledger (canon win #1)** |
| New-hire state reporting | Manual | Supported | Supported | **Automated new-hire report filing via provider (canon win #2)** |
| Reconciliation of the payroll debit | Manual | Manual | Manual | **AI auto-reconcile the provider debit against the bank feed** |

**The two canon wins to call out explicitly:** (1) **automated child-support / garnishment remittance** (tracked through 2270 Garnishments Payable and remitted by the provider — most SMB payroll leaves this as a manual employer chore), and (2) **automated new-hire report filing** (state new-hire reporting handled by the provider automatically). These are the differentiators to lead with beyond the ledger-native job-costing.

## 15. Provider make-vs-buy (Check vs Gusto Embedded) — HUMAN/COMMERCIAL DECISION

MeritBooks builds the **provider-agnostic `PayrollEngine` interface** and one adapter. Two realistic providers:

| | **Check** (payroll infrastructure API) | **Gusto Embedded** |
|---|---|---|
| Model | Pure API/infrastructure — you own the whole UX, they are the engine of record + tax/filing | Embedded product — more of the UX/onboarding comes prebuilt |
| Fit for "we own the book of record" | **Strong** — Check expects the platform to own product surface and GL; cleanest for our ledger-native posture | Good, but more opinionated UX to fit around |
| Tax calc / remit / file / garnishments / new-hire | Yes (regulated party) | Yes (regulated party) |
| Employee onboarding / PII custody | Provider-hosted flows + API; PII stays with provider | Provider-hosted; PII stays with provider |
| Commercial | Per-employee/per-run pricing; contract + underwriting | Rev-share / per-employee; partner program |

**This choice is explicitly a HUMAN / COMMERCIAL decision (blocker):** pricing, contract terms, underwriting, go-live sandbox access, and the white-label resale story (Module 1 of 12, resellable) all sit outside engineering judgment. The engineering recommendation is to **build to the interface first and defer provider selection** — nothing about the run workflow, GL wiring, dimensions, approvals, or reconciliation depends on which provider is chosen. **Mike selects the provider; engineering does not.** The tentative engineering lean, for the ledger-native/white-label posture, is **Check** (infrastructure-first) — to be confirmed commercially.

## 16. Data-model changes needed

New Books-owned schema `payroll.*` (or `public.payroll_*` if a schema carve is deferred): `pay_schedules`, `employee_comp`, `runs`, `run_lines` (all per §2, all `org_id` + RLS `org_id = get_org_id()`, all money bigint cents, no PII). Extend `core.provider_connections` usage for capability `PAYROLL` (table already exists). Switch `recordPayrollRun` to `entry_type='PAYROLL_RUN'` (enum value already exists, migration 055). Add a `PAYROLL_RUN`-kind path already present in `public.approvals` (migration 042). **No new PII columns anywhere** — that is a hard review gate. `schema.test.ts` and `tenant-isolation.test.ts` must stay green; add a guard asserting no `ssn`/`bank_account`/`routing` column exists in any `payroll.*` or `core.*` table.

## Acceptance criteria (these define "done," not "it renders")

1. A tenant can define a pay schedule and per-employee comp with department/job/class defaults, storing **zero PII** (verified by a schema guard test).
2. A run can be drafted, hours pulled/keyed, off-cycle earnings added, and a **provider-computed** gross-to-net preview shown (mocked provider acceptable pre-sandbox).
3. The run routes through `public.approvals` with **preparer ≠ approver DB-enforced**, then an explicit release step, each writing `approval_steps` + `core.action_log`.
4. On release the run posts a **balanced** GL entry via `recordPayrollRun` with `entry_type='PAYROLL_RUN'`, every line carrying department/job/class/location dimensions, and it ties through `check_journal_balance()`.
5. Posting to a CLOSED/LOCKED period is rejected with a reason.
6. Garnishments post to **2270**; employer contributions post to 6020/6030/6040 and their payables; net pay clears through **1096**.
7. A contractor run posts as **AP disbursement (no withholding)**, tagged 1099-NEC — not as wages.
8. The provider's consolidated bank debit reconciles against the bank feed and clears the transit/payable balances (AI-assisted match, human-confirmable).
9. AI run anomaly review flags at least the N×-average and terminated-employee cases with reasons, logged to `ai_decisions`, writing no GL.
10. RBAC: only `payroll: create` roles prepare, only `payroll: approve` roles approve, `grouped` visibility hides individual amounts; authorization resolves on `core.memberships` (or the interim employees fallback until identity lands).
11. Provider secrets live only in Vault via `core.provider_connections` (capability `PAYROLL`); no credential in any app table.
12. Everything above works **without a provider connected** up to the preview step (graceful degrade), proving no core capability depends on the provider.

---

## Strictly-ordered build sequence

**Phase A — provider-agnostic, buildable NOW (no provider, no commercial decision):**
1. `payroll.*` data model (schedules, comp, runs, run_lines) + RLS + no-PII schema guard.
2. Switch `recordPayrollRun` to `entry_type='PAYROLL_RUN'`; add unit tests asserting the balanced dimensioned post and the garnishment/1096 routing.
3. The **run workflow** end-to-end against a **mock `PayrollEngine`** returning fixed gross-to-net: draft → preview → submit → approve (SoD) → release → post → reconcile stub.
4. Wire `public.approvals` (`kind='PAYROLL_RUN'`) + `approval_steps` + `action_log`; enforce preparer≠approver and period lock.
5. GL reconciliation against the bank feed (match the debit; clear transit/payables).
6. RBAC gating on the payroll feature + payroll-visibility; resolve authorization on the identity spine.
7. Pay-schedule engine + PTO accrual model (accrual is a Books calc; balances are informational until the provider owns them).
8. AI: run anomaly review + labor→job attribution + close accrual proposal (all advisory, logged).

**Phase B — needs the provider sandbox (gated on the commercial decision):**
9. Provider selection (**Mike — commercial/human blocker**): Check vs Gusto Embedded — pricing, contract, underwriting, sandbox access, white-label terms.
10. Concrete `PayrollEngine` adapter for the chosen provider (real gross-to-net, tax remittance, filing, garnishment + new-hire reporting), secrets in Vault.
11. Real employee onboarding flow (PII captured **by the provider**, never in Books).
12. Provider webhooks (run processed, debit settled, return/NSF) via the Core verify-and-route path; drive `PROCESSING→POSTED→RECONCILED` and the returned/NSF path.
13. Employee self-service (provider portal link) → later native pay-stub PDF + W-2/1099 surfacing.

**Explicit human / commercial blockers (cannot be resolved by engineering):**
- **Provider selection (Check vs Gusto Embedded)** — pricing, contract, underwriting, sandbox credentials, white-label resale terms. All of Phase B is gated on this.
- **Identity gate** — payroll approval should resolve on `core.memberships/roles`; until that lands (open NO-GO gate, task #9) approval runs on the interim `core.employees.role` fallback. Not a hard blocker for Phase A, but the interim must be reconciled before go-live.
- Money-movement legal consent (ACH/NACHA authorization for the provider debit) — captured in `public.ach_authorizations` (migration 043); the tenant's bank authorization is a human sign-off, not code.
