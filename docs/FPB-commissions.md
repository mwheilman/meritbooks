# Feature Product Brief — Commissions (performance pay → payroll earnings → GL accrual)

**Status:** DRAFT for owner approval (Rule 13). Written 2026-10-20.
**Owner decision (binding, 2026-10-20, decision c):** "Payroll must include a commissions mechanism that works with any
payroll system — the system helps calculate commissions (e.g., HVAC tech commissions on sold/installed jobs, sales
commissions), then hands them to the payroll provider as earnings and accrues them in the GL."
**Canon guard (CANON-ANCHOR §2):** this is an employee **earning** computed from revenue / gross-profit events. It is
**not** the retired chargeback engine, overhead/burden rate, 5 labor classifications or cost allocation, and it must not
grow into them. No labor rates, no burden, no department cost transfers live here.
**Capability IDs:** 09-COMPETITIVE-FEATURE-MATRIX rows 194 (performance pay: tech commissions, spiffs, range bonuses,
split by invoice %) and 195 (commission accrual to GL when the invoice posts, paid when the invoice is paid); §3 #12;
§6 #18. **Cross-references:** docs/FPB-payroll.md §15/§15A (provider-agnostic seam), docs/FPB-workforce-app.md §4.5.1
(statements in Merit Workforce).
**Built with this brief (pure, tested, no I/O):** `apps/web/src/lib/commissions/*` (types, money, evaluate, reconcile,
statement) — 26 unit tests. Persistence, loaders, routes and screens wait on the §16 schema.

---

## 0. The one-paragraph version

A tenant defines **commission plans** (percent of revenue, percent of gross profit, flat per job, tiered accelerators,
spiffs), each with a **basis event** (sold, installed, invoiced, or paid) and a **clawback policy**, and assigns plans to
employees with effective dates. Every close, Books evaluates each commissionable **source** (job, invoice, invoice line)
against the plans the employee held on the basis date, and **reconciles** what the employee should have earned against
what was already recorded — producing EARNED, CLAWBACK and REINSTATED lines idempotently. Lines roll up into a
per-employee **period statement** that a manager **approves** (preparer ≠ approver). The period-end close **accrues** the
commission expense (DR commission expense, COGS for technicians / OPEX for sales; CR Accrued Commissions Payable). The
approved payable is **handed to the payroll provider as COMMISSION earnings** through the provider-agnostic seam — Gusto
by API, any other payroll system by an earnings CSV — and when the payroll run that paid them posts, a **reclass** clears
the accrual so the expense lands once, in the period it was earned. The employee sees every line, with a plain-English
reason, in **Merit Workforce**.

## 1. Job & users

| User | Job | Today |
|---|---|---|
| **Service manager / sales manager** (Kelly Brandt, Heartland Heating & Cooling) | approve each tech's / rep's commissions before payroll; answer "why is mine lower?" | a spreadsheet from ServiceTitan exports, re-keyed into payroll |
| **Payroll runner / bookkeeper** (Sam Kovac) | get approved commissions onto the right payroll as earnings; book the accrual at month end | types amounts into Gusto/ADP; books a manual accrual JE (or none) |
| **Technician / salesperson** (Andre Willis, install lead) | see what he earned, per job, and why; trust the clawbacks | asks the office |
| **Controller / CFO** | commission expense in the right period and class (job cost vs selling); audit trail; no double-payment | month-end true-ups by hand |

## 2. Data captured

- **Plans** (`commission_plans`): name, kind (`PERCENT_REVENUE` | `PERCENT_GROSS_PROFIT` | `FLAT_PER_JOB` | `TIERED` |
  `SPIFF`), basis event (`SOLD` | `INSTALLED` | `INVOICED` | `PAID`), `rate_bps` (integer basis points; 500 = 5%),
  `flat_cents`, tiers (`[{from_cents, rate_bps}]`, first tier from 0), tier mode (`MARGINAL` | `RETROACTIVE`), tier
  measure (`REVENUE` | `GROSS_PROFIT`), spiff item codes, minimum gross margin (bps), cap per line, clawback policy
  (cancellation, refund, unpaid-after-N-days, window days), expense class (`COGS` | `OPEX`), negative-balance policy
  (`CARRY_FORWARD` | `WRITE_OFF`), status, version. Plans are versioned: editing an ACTIVE plan creates a new version;
  history keeps the version a line was earned under.
- **Assignments** (`commission_plan_assignments`): employee × plan × `effective_from` / `effective_to`, optional scope
  (location / department / job type). An employee may hold several plans (e.g. 5% of revenue + maintenance-agreement
  spiff).
- **Splits** (on the source): two techs on one install at 50/50 → `split_bps` 5_000 each; a sales rep and a tech can
  each have their own plan on the same job.
- **Sources** (read, not owned): jobs (`proj.*` via Core ids, sold / installed dates, job cost from job costing),
  invoices and invoice lines (posted date, due date, payments applied, credit memos / refunds, void), and
  **external computed performance pay** (ServiceTitan "Master Pay File", RFMS GP commissions) imported as `EXTERNAL`
  sources whose amount is taken as-is (matrix §6 #18: "ingest where the field system already computes them").
- **Lines** (`commission_lines`): plan + plan version, employee, source type/id, kind (`EARNED` | `CLAWBACK` |
  `REINSTATED` | `ADJUSTMENT`), basis cents, effective rate bps, signed amount cents, recognized date, explanation,
  statement id once assigned. **Append-only**: corrections are new lines, never edits.
- **Statements** (`commission_statements`): employee × period, totals (opening balance, earned, reinstated, clawback,
  adjustment, net, payable, carry-forward, written-off), status, preparer / approver, payout batch id, payroll run id.
- **Payout batches** (`commission_payout_batches`): the hand-off to payroll — provider, mode (`API` | `FILE`), pay date,
  provider payroll id, rendered file reference, accepted / rejected counts, cents.

All money is bigint cents; all rates are integer basis points; no floats anywhere (Rule: money as cents).

## 3. Presentation & documents

- **Desk · Payroll · Commissions** (`/payroll/commissions`): period selector; a table per employee (earned, clawbacks,
  net, payable, status), drill to lines → source (job / invoice) → GL. Filters: plan, location, status. Bulk "Submit for
  approval". Exceptions panel (see §13).
- **Plan editor**: kind-specific form with a **live example** ("A $12,000 install invoiced Oct 6 earns $600; a $15 maintenance
  plan earns $25") computed by the same pure engine, validation from `validatePlan`.
- **Statement** (PDF + Merit Workforce screen): header totals that foot to the cent, then per-job lines with basis,
  rate, amount and the engine's explanation ("5.00% of revenue × 50.00% split"; "Clawback: Cancelled on 2026-11-15").
- **Earnings file** (file-based payroll): provider-neutral CSV (`employee_id, provider_employee_id, employee_name,
  earning_type, amount, pay_date, period_start, period_end, memo, source_ref`), columns and earning codes overridable per
  tenant to match ADP / Paychex / Paylocity import templates; formula-injection safe.

## 4. States

Plans: DRAFT → ACTIVE → RETIRED. Statements: empty (no plan / no commissionable sources: "No commissionable jobs this
period"), computed DRAFT, PENDING_APPROVAL, APPROVED, REJECTED (with reason, back to DRAFT), EXPORTED (handed to
payroll), PAID (the payroll run posted), VOID. Payout: queued, pushed (API) / file downloaded, partially rejected (lines
listed with reasons, e.g. "employee not mapped to a Gusto employee"), confirmed by run post. Loading / error / empty
states on every surface; AI off changes nothing (the engine is deterministic).

## 5. Lifecycle — when a commission is earned, clawed back, reinstated

1. **Basis met** (by plan): SOLD → job signed; INSTALLED → job complete; INVOICED → invoice posted (ServiceTitan
   default); PAID → pro-rata to cash applied (RFMS GP default; flat/spiff kinds earn when paid in full).
2. **Earned** on the basis date if the employee held the plan on that date (assignment effective dating).
3. **Clawback** (plan policy): cancellation/void → full reversal dated on the cancellation; refund / credit memo →
   pro-rata reversal; unpaid N days past due (non-PAID bases) → reversal dated due + N. Only inside `window_days` of the
   first earning; outside the window the employee keeps it.
4. **Reinstated** when the trigger cures (the late invoice is paid) — automatically, as a positive line.
5. **Idempotent close:** the engine computes should-have-earned per (plan, source, employee) and emits only the delta
   versus recorded lines; re-running a close produces nothing new. Clawbacks still flow after an assignment ends.
6. **Tiered accelerators** are measured per (employee, plan, period) over the period's commissionable basis, the tier
   table applied once (marginal or retroactive), and the total allocated back to the source lines with largest-remainder
   (sums exactly); each line stores its effective rate so a later refund re-values at the rate it earned.
7. **Negative balance** (clawbacks exceed earnings): carried forward to the next statement (default) or written off,
   per plan policy. Never deducted from wages outside a payroll provider's lawful earnings/deduction handling (state
   wage-deduction rules — CPA/counsel confirm per state before enabling recovery of carried balances).

## 6. Actions & approvals

- Bookkeeper: compute period (or it runs at close), review exceptions, add ADJUSTMENT lines (reason required), submit.
- **Manager approves** each statement (role with `commissions:approve`); **preparer ≠ approver** enforced in code
  (`assertStatementTransition`) and backstopped by a DB CHECK (§16). Approval freezes the statement's lines.
- Payroll runner: **Send to payroll** for a pay date → payout batch → provider `importEarnings` (Gusto pushes fixed
  compensation "Commission" onto the unprocessed payroll; file adapter renders the CSV). The batch is idempotent on
  `commission-statement:<id>`; a statement already EXPORTED cannot be sent again.
- Void an approved-but-unexported statement (recompute next run); an EXPORTED statement is corrected by an ADJUSTMENT line
  in the next period, never edited.

## 7. Edit & correction model

Lines are append-only; statements are immutable after approval; plan changes are new versions. Posted GL entries are
reversed and reposted, never edited (Master Doc XI). Late facts (a refund after the statement was paid) appear as next
period CLAWBACK lines with a link to the original.

## 8. Delivery

Merit Workforce: Pay · Commissions (FPB-workforce-app §4.5.1), push + email when a statement is approved / paid.
Desk: statement PDF per employee; batch PDF for the manager. Payroll: earnings appear on the stub as "Commission" (Gusto)
or in the outside system's stub.

## 9. Automation

- Close task "Commissions" in the close checklist: compute → exceptions → submit → approve → accrue (auto-proposed JE)
  → send to payroll on the next pay date.
- Sources refresh on posting events (invoice posted / paid / voided, credit memo, job status) so the in-period view is
  live; the close run is the authoritative one (asOf = period end).
- Nothing pays without a human approval (canon VIII.7: no "let the AI run" switch).

## 10. Analytics

Commission expense by plan, location, job type and class (COGS vs OPEX); commission as % of revenue / gross profit per
employee; clawback rate (by rep, by reason); days-to-cash on PAID-basis plans; accrual vs payout reconciliation
(Accrued Commissions Payable should roll forward: opening + accrued − paid = closing).

## 11. Integration & GL

```
Period end (accrual, per period's lines; balanced by construction — an all-clawback period flips sides)
  DR  COMMISSION_EXPENSE_COGS   (direct: technicians / installers; job dimension stamped)   Σ COGS-plan lines
  DR  COMMISSION_EXPENSE_OPEX   (selling: sales reps; department dimension)                 Σ OPEX-plan lines
    CR ACCRUED_COMMISSIONS_PAYABLE                                                          Σ all lines

Payroll run that paid them posts (recordPayrollRun debits WAGES_EXPENSE for the COMMISSION earning)
  DR  ACCRUED_COMMISSIONS_PAYABLE                                                           paid cents
    CR  WAGES_EXPENSE (the account the payroll run debited for the commission earning)      paid cents
```
Net effect: expense recognized once, in the earned period, in the right class; the payable clears on the run.
Written-off negative balances are never booked as expense or receivable. Contractor commissions (1099 payees) go
through AP, not payroll, and count toward the payee's 1099-NEC total under the year's floor (`lib/tax/1099-thresholds`).
Builders: `buildAccrualLines`, `buildPayoutReclassLines`, `isBalanced` (`lib/commissions/statement.ts`); posting goes
through `postJournalEntry` only, entry types proposed in §16.

**Payroll hand-off:** `statementsToEarnings` → `EarningsLine[]` → `PayrollProvider.importEarnings` (lib/payroll/providers).
Works with Gusto (API), the file adapter (any payroll system), and the Mock engine. Check: add commissions as run earning
lines (`commission` earning type) until its earnings endpoint is mapped.

## 12. Permissions / RBAC (report to the lead — `permissions.ts` is reserved)

New feature `commissions` with actions `view`, `create` (compute, adjust, submit), `approve`, `export` (send to payroll),
`configure` (plans). Approve/export follow the payroll-approve set; employees get `comp.my_statements:V (own)` in Merit
Workforce. Per-employee amounts obey the existing `payrollVisibility` dial.

## 13. AI dimension (advisory only, logged to `ai_decisions`)

1. **Exceptions before approval** (deterministic detectors, AI only phrases): commission > N× trailing average; job with
   commission but negative gross margin; split ≠ 100%; source with no assigned plan; duplicate source across two techs at
   100% each; clawback-heavy rep.
2. **Plan import**: read a written comp plan (PDF) into a draft plan + live examples for the manager to confirm.
3. **Explain my statement** in Merit Workforce (phase 2): natural language over the engine's own lines; never computes.

## 14. Benchmark (Rule 14) — named deltas

| Product | Strength | MeritBooks delta |
|---|---|---|
| **ServiceTitan Performance Pay** | item flags, flat/% spiffs, range bonuses, split by invoice %, posted invoices only, Master Pay File to payroll | **Match** plan kinds + splits; **beat**: accrual + clawback + reinstatement in the GL, and ingest ServiceTitan's computed file as `EXTERNAL` sources rather than recompute |
| **RFMS** (flooring) | GP-based commissions paid on invoice payment | **Match** PAID-basis GP plans; **beat**: job-cost GP from the ledger, not a side calc |
| **Gusto / ADP / QBO Payroll** | pay a "Commission" earning | **Match** as the payout rail; **beat**: the number arrives approved, explained and accrued |
| **Spiff / CaptivateIQ / QuotaPath** | SaaS-sales comp plans, statements, disputes | **Match** statements + disputes for SMB trades; no quota/territory planning (out of scope) |

## 15. Data-model proposal

See §16 for SQL (the lead numbers and applies it; `packages/supabase/migrations/*` is reserved).

## 16. Proposed SQL (for the lead)

```sql
-- NNN_commissions.sql — commission plans, assignments, lines, statements, payout batches.
-- RLS org_id = public.get_org_id() on every table; money bigint cents; rates integer bps.

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('COMMISSION_EXPENSE_COGS',     'Commissions — direct (COGS)',  'ORG', '5150'),
  ('COMMISSION_EXPENSE_OPEX',     'Commissions — selling (OPEX)', 'ORG', '6150'),
  ('ACCRUED_COMMISSIONS_PAYABLE', 'Accrued Commissions Payable',  'ORG', '2290')
on conflict (role_key) do nothing;
-- default_account_number values are proposals; confirm against the seeded chart / onboarding role mapping.

create table if not exists public.commission_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid,                                   -- null = all clients
  name text not null,
  version int not null default 1,
  supersedes_id uuid references public.commission_plans(id),
  kind text not null check (kind in ('PERCENT_REVENUE','PERCENT_GROSS_PROFIT','FLAT_PER_JOB','TIERED','SPIFF')),
  basis_event text not null check (basis_event in ('SOLD','INSTALLED','INVOICED','PAID')),
  rate_bps int check (rate_bps between 0 and 10000),
  flat_cents bigint check (flat_cents >= 0),
  tiers jsonb not null default '[]'::jsonb,           -- [{from_cents, rate_bps}], validated in app (validatePlan)
  tier_mode text check (tier_mode in ('MARGINAL','RETROACTIVE')),
  tier_measure text check (tier_measure in ('REVENUE','GROSS_PROFIT')),
  spiff_item_codes text[] not null default '{}',
  min_margin_bps int check (min_margin_bps between -10000 and 10000),
  cap_per_line_cents bigint check (cap_per_line_cents >= 0),
  clawback_on_cancellation boolean not null default true,
  clawback_on_refund boolean not null default true,
  clawback_unpaid_after_days int check (clawback_unpaid_after_days >= 0),
  clawback_window_days int check (clawback_window_days >= 0),
  expense_class text not null check (expense_class in ('COGS','OPEX')),
  negative_balance_policy text not null default 'CARRY_FORWARD' check (negative_balance_policy in ('CARRY_FORWARD','WRITE_OFF')),
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','RETIRED')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_plans_kind_fields check (
    (kind in ('PERCENT_REVENUE','PERCENT_GROSS_PROFIT') and rate_bps is not null) or
    (kind in ('FLAT_PER_JOB','SPIFF') and flat_cents is not null) or
    (kind = 'TIERED' and jsonb_array_length(tiers) > 0 and tier_mode is not null and tier_measure is not null))
);

create table if not exists public.commission_plan_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  plan_id uuid not null references public.commission_plans(id) on delete restrict,
  employee_id uuid not null references core.employees(id) on delete restrict,
  effective_from date not null,
  effective_to date,
  scope_location_id uuid,
  scope_department_id uuid,
  created_by text,
  created_at timestamptz not null default now(),
  constraint commission_assignment_dates check (effective_to is null or effective_to >= effective_from)
);

create table if not exists public.commission_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  employee_id uuid not null references core.employees(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  opening_balance_cents bigint not null default 0,
  earned_cents bigint not null default 0,
  reinstated_cents bigint not null default 0,
  clawback_cents bigint not null default 0,
  adjustment_cents bigint not null default 0,
  net_cents bigint not null default 0,
  payable_cents bigint not null default 0 check (payable_cents >= 0),
  carry_forward_cents bigint not null default 0 check (carry_forward_cents <= 0),
  written_off_cents bigint not null default 0 check (written_off_cents >= 0),
  status text not null default 'DRAFT'
    check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','EXPORTED','PAID','VOID')),
  prepared_by text,
  approved_by text,
  approved_at timestamptz,
  rejection_reason text,
  payout_batch_id uuid,
  payroll_run_id uuid references public.payroll_runs(id) on delete set null,
  accrual_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_statements_period check (period_end >= period_start),
  constraint commission_statements_preparer_ne_approver check (approved_by is null or prepared_by is null or approved_by <> prepared_by),
  constraint commission_statements_foot check (net_cents = opening_balance_cents + earned_cents + reinstated_cents + clawback_cents + adjustment_cents)
);
create unique index if not exists uq_commission_statement_period
  on public.commission_statements (org_id, employee_id, period_start, period_end) where status <> 'VOID';

create table if not exists public.commission_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  plan_id uuid not null references public.commission_plans(id) on delete restrict,
  employee_id uuid not null references core.employees(id) on delete restrict,
  source_type text not null check (source_type in ('JOB','INVOICE','INVOICE_LINE','EXTERNAL')),
  source_id text not null,
  kind text not null check (kind in ('EARNED','CLAWBACK','REINSTATED','ADJUSTMENT')),
  basis_cents bigint not null default 0,
  rate_bps int not null default 0,
  amount_cents bigint not null check (amount_cents <> 0),
  recognized_on date not null,
  explanation text not null,
  adjustment_reason text,
  statement_id uuid references public.commission_statements(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint commission_lines_sign check (
    (kind in ('EARNED','REINSTATED') and amount_cents > 0) or (kind = 'CLAWBACK' and amount_cents < 0) or kind = 'ADJUSTMENT'),
  constraint commission_lines_adjustment_reason check (kind <> 'ADJUSTMENT' or adjustment_reason is not null)
);
create index if not exists idx_commission_lines_source on public.commission_lines (org_id, plan_id, source_type, source_id, employee_id);
create index if not exists idx_commission_lines_period on public.commission_lines (org_id, employee_id, recognized_on);

create table if not exists public.commission_payout_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  provider text not null,                              -- 'gusto' | 'check' | 'file' | 'mock'
  mode text not null check (mode in ('API','FILE')),
  pay_date date not null,
  provider_run_id text,
  file_document_id uuid,                               -- rendered earnings CSV in the documents bucket (FILE mode)
  accepted_count int not null default 0,
  accepted_cents bigint not null default 0,
  rejected jsonb not null default '[]'::jsonb,         -- [{source_ref, reason}]
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','PARTIAL','CONFIRMED','FAILED')),
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.commission_statements
  add constraint commission_statements_payout_fk foreign key (payout_batch_id)
  references public.commission_payout_batches(id) on delete set null;

-- Append-only lines: block UPDATE/DELETE of amount-bearing columns once a statement is APPROVED.
create or replace function public.commission_lines_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.amount_cents is distinct from old.amount_cents
     or new.kind is distinct from old.kind or new.source_id is distinct from old.source_id then
    if exists (select 1 from public.commission_statements s
               where s.id = old.statement_id and s.status in ('APPROVED','EXPORTED','PAID')) then
      raise exception 'commission line % belongs to an approved statement; add an ADJUSTMENT line instead', old.id;
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_commission_lines_immutable before update or delete on public.commission_lines
  for each row execute function public.commission_lines_immutable();

alter table public.commission_plans enable row level security;
alter table public.commission_plan_assignments enable row level security;
alter table public.commission_statements enable row level security;
alter table public.commission_lines enable row level security;
alter table public.commission_payout_batches enable row level security;
create policy org_isolation on public.commission_plans for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.commission_plan_assignments for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.commission_statements for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.commission_lines for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.commission_payout_batches for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());

-- Entry types for the accrual and the payout reclass (schema.test.ts asserts every posted entry_type exists).
alter type entry_type_enum add value if not exists 'COMMISSION_ACCRUAL';
alter type entry_type_enum add value if not exists 'COMMISSION_PAYOUT_RECLASS';
-- (entry_type_enum: 001_foundation; same pattern as 055 adding PAYROLL_RUN)
```

Receipt-chase switches for Merit Workforce (FPB-workforce-app §4.9) ride the next Books migration too:
```sql
alter table public.organizations add column if not exists receipt_chase_enabled boolean not null default true;
alter table public.company_policies add column if not exists receipt_chase_enabled boolean;  -- null = follow tenant
```

## Acceptance criteria

1. A 5%-of-revenue tech plan on INVOICED pays $300 to each of two techs on a $12,000 install split 50/50, on the invoice
   post date; re-running the close creates no new lines.
2. A 10%-of-GP sales plan with a 45% margin floor pays nothing on a 41.7%-margin job and says why.
3. A PAID-basis plan earns pro-rata to cash as payments arrive; a flat or spiff earns only when paid in full.
4. Cancelling a job inside the clawback window posts a CLAWBACK dated on the cancellation; outside the window, nothing;
   an invoice 90 days past due claws back and is REINSTATED automatically when paid.
5. A marginal tiered accelerator on $120,000 period revenue (2% / 3% from $50k / 5% from $100k) pays $3,500, allocated to
   the jobs so the parts sum exactly; retroactive pays $6,000.
6. A statement foots (opening + earned + reinstated + clawbacks + adjustments = net) and the DB CHECK enforces it;
   negative balances carry forward or write off per plan; the preparer cannot approve (code + DB CHECK).
7. Approved statements send to payroll as COMMISSION earnings: Gusto receives a "Commission" fixed compensation on the
   unprocessed payroll; a file-based tenant downloads an earnings CSV; resending the same statement is refused.
8. The period accrual is balanced, split COGS/OPEX, posted through `postJournalEntry` with `COMMISSION_ACCRUAL`; the payout
   reclass clears Accrued Commissions Payable when the run posts; the payable rolls forward to zero for paid periods.
9. The employee sees the same lines and totals in Merit Workforce as the approved statement, to the cent.
10. Nothing here creates labor rates, burden, chargebacks or cost transfers (canon guard; reviewer checks).

## Build sequence

1. (Done) Pure engine + tests: `lib/commissions/*`.
2. Lead: apply §16 SQL; add `commissions` RBAC feature + nav entry (reserved spine).
3. Loaders: sources from invoices / payments / credit memos (Books) and jobs + job cost (Projects via Core ids);
   EXTERNAL import (ServiceTitan pay file CSV).
4. Routes: compute (dry-run + persist), statements CRUD + submit / approve / reject, adjustments, send-to-payroll
   (payout batch via `resolvePayrollProvider().importEarnings`), accrual JE proposal at close, payout reclass on run post.
5. Desk UI (plan editor with live examples, period table, statement drill, exceptions) — designer + chrome-auditor.
6. Merit Workforce Commissions tab; notifications.

## Open decisions for the owner

| # | Decision | Default here |
|---|---|---|
| C1 | Default basis for tech plans: INVOICED (ServiceTitan) or PAID (cash) | INVOICED with 90-day unpaid clawback |
| C2 | Negative balances: carry forward or write off | Carry forward; recovery only via lawful payroll deductions after counsel review per state |
| C3 | Commission expense class for technicians: COGS (job cost) | COGS for tech plans, OPEX for sales plans |
| C4 | Accept ServiceTitan's computed performance pay as-is for tenants on ServiceTitan | Yes (EXTERNAL source), Books adds accrual + clawback + payout |
| C5 | Clawback window default | 180 days |
