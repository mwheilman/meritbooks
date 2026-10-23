-- =============================================================================
-- Migration 184: scheduler automation policies (Wave 2E — "make automatic true").
-- =============================================================================
-- Audit rows PL-03, AR-07, AR-08, SC-06, AP-13 (docs/audit-2026-10/FEATURE-GAP-AUDIT.md
-- §6.3 Wave 2E); FPB-invoices D6.1–D6.3; docs/SCHEDULER.md.
--
-- §1  public.dunning_policies       the reminder ladder per tenant (location_id NULL) or
--                                   per company (a company row overrides the tenant row):
--                                   steps (days from due date, stage, subject + body
--                                   template), DRAFT vs AUTO send, stop on promise-to-pay /
--                                   dispute, excluded customers, minimum balance.
-- §2  public.late_fee_policies      finance-charge policy per tenant / company: FLAT or
--                                   PERCENT_MONTHLY (basis points), grace days, ONCE or
--                                   MONTHLY, min / max per assessment, lifetime cap per
--                                   invoice, minimum balance, which customers, income account.
-- §3  public.late_fee_assessments   one PROPOSED fee per (invoice, period) — the UNIQUE
--                                   (org_id, invoice_id, period_key) makes the nightly job
--                                   idempotent; a person approves (→ a finance-charge
--                                   invoice) or rejects (never re-proposed for that period).
--                                   The base is the ORIGINAL invoice's open balance only —
--                                   finance-charge invoices are never assessed (no
--                                   compounding by accident).
-- §4  public.recurring_invoice_templates.generate_mode   DRAFT · POST · POST_AND_SEND
--                                   (NULL = legacy: auto_send ? POST_AND_SEND : POST).
--                                   The scheduled run only posts/sends when the tenant's
--                                   "Scheduled recurring invoices" autonomy dial allows.
-- §5  public.invoices dispute marker (disputed_at / dispute_note / disputed_by) — dunning
--                                   and late fees stop while an invoice is disputed.
-- §6  public.bills early-pay discount (early_pay_discount_bps / _date) — the weekly
--                                   pay-run proposal pulls a bill forward to its discount date.
-- §7  RLS + grants: members SELECT their org only; every write is the service role (the
--     app, after its permission check, org pinned — the 171/179 pattern). No member write
--     grants at all. M1 lesson: no new functions.
-- §8  core.apply_client_scope_rls() re-run (every new table carries location_id).
--
-- No GL effect. Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to Supabase
-- FIRST, then commit the code that depends on it.
-- =============================================================================

-- ── §1 dunning policies ──────────────────────────────────────────────────────
create table if not exists public.dunning_policies (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid references core.locations(id) on delete cascade,
  enabled               boolean not null default false,
  send_mode             text not null default 'DRAFT',
  steps                 jsonb not null default '[]'::jsonb,
  stop_on_promise       boolean not null default true,
  stop_on_dispute       boolean not null default true,
  excluded_customer_ids uuid[] not null default array[]::uuid[],
  min_balance_cents     bigint not null default 0,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dunning_policies_chk') then
    alter table public.dunning_policies add constraint dunning_policies_chk
      check (send_mode in ('DRAFT', 'AUTO')
             and jsonb_typeof(steps) = 'array'
             and jsonb_array_length(steps) <= 8
             and min_balance_cents >= 0
             and cardinality(excluded_customer_ids) <= 500);
  end if;
end $$;
create unique index if not exists uq_dunning_policies_scope
  on public.dunning_policies (org_id, location_id) nulls not distinct;
comment on table public.dunning_policies is
  'Mig 184: the dunning ladder per tenant (location_id NULL) or company. steps = [{stage, days, subject, body}] (days from the due date; negative = before due). DRAFT = the scheduler prepares each reminder for a person to send; AUTO = it sends through the request engine (quiet hours, unsubscribe, quotas) when the Scheduled dunning dial allows. Written only by the service role.';

-- ── §2 late-fee policies ─────────────────────────────────────────────────────
create table if not exists public.late_fee_policies (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references core.organizations(id) on delete cascade,
  location_id                  uuid references core.locations(id) on delete cascade,
  enabled                      boolean not null default false,
  method                       text not null default 'PERCENT_MONTHLY',
  flat_fee_cents               bigint not null default 0,
  rate_bps                     integer not null default 150,
  grace_days                   integer not null default 0,
  frequency                    text not null default 'MONTHLY',
  min_fee_cents                bigint not null default 0,
  max_fee_cents                bigint,
  max_total_per_invoice_cents  bigint,
  min_balance_cents            bigint not null default 0,
  apply_to                     text not null default 'ALL',
  customer_ids                 uuid[] not null default array[]::uuid[],
  income_account_id            uuid references public.accounts(id) on delete set null,
  updated_by                   text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'late_fee_policies_chk') then
    alter table public.late_fee_policies add constraint late_fee_policies_chk
      check (method in ('FLAT', 'PERCENT_MONTHLY')
             and frequency in ('ONCE', 'MONTHLY')
             and apply_to in ('ALL', 'INCLUDE', 'EXCLUDE')
             and flat_fee_cents >= 0
             and rate_bps between 0 and 1000          -- at most 10% a month
             and grace_days between 0 and 365
             and min_fee_cents >= 0
             and (max_fee_cents is null or max_fee_cents >= min_fee_cents)
             and (max_total_per_invoice_cents is null or max_total_per_invoice_cents > 0)
             and min_balance_cents >= 0
             and cardinality(customer_ids) <= 500
             and (method <> 'FLAT' or flat_fee_cents > 0 or not enabled)
             and (method <> 'PERCENT_MONTHLY' or rate_bps > 0 or not enabled));
  end if;
end $$;
create unique index if not exists uq_late_fee_policies_scope
  on public.late_fee_policies (org_id, location_id) nulls not distinct;
comment on table public.late_fee_policies is
  'Mig 184: finance-charge policy per tenant (location_id NULL) or company. Fees are PROPOSED (late_fee_assessments) and only become a finance-charge invoice when a person approves. Written only by the service role.';

-- ── §3 late-fee assessments ──────────────────────────────────────────────────
create table if not exists public.late_fee_assessments (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references core.organizations(id) on delete cascade,
  location_id                 uuid not null references core.locations(id) on delete cascade,
  invoice_id                  uuid not null references public.invoices(id) on delete cascade,
  customer_id                 uuid,
  period_key                  text not null,
  as_of                       date not null,
  days_past_due               integer not null,
  base_cents                  bigint not null,
  fee_cents                   bigint not null,
  method                      text not null,
  rate_bps                    integer,
  status                      text not null default 'PROPOSED',
  finance_charge_invoice_id   uuid references public.invoices(id) on delete set null,
  decided_by                  text,
  decided_at                  timestamptz,
  decision_note               text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'late_fee_assessments_chk') then
    alter table public.late_fee_assessments add constraint late_fee_assessments_chk
      check (status in ('PROPOSED', 'APPROVED', 'REJECTED')
             and method in ('FLAT', 'PERCENT_MONTHLY')
             and (period_key = 'ONCE' or period_key ~ '^[0-9]{4}-[0-9]{2}$')
             and base_cents >= 0
             and fee_cents > 0
             and days_past_due >= 0
             and (status = 'PROPOSED' or decided_at is not null));
  end if;
end $$;
create unique index if not exists uq_late_fee_assessments_period
  on public.late_fee_assessments (org_id, invoice_id, period_key);
create index if not exists ix_late_fee_assessments_status
  on public.late_fee_assessments (org_id, status, created_at desc);
comment on table public.late_fee_assessments is
  'Mig 184: one proposed late fee per (invoice, period). UNIQUE (org_id, invoice_id, period_key) = the scheduled job can never double-assess. APPROVED rows point at the finance-charge invoice that carries the fee; REJECTED rows are never re-proposed for that period. Written only by the service role.';

-- ── §4 recurring invoice generate mode ───────────────────────────────────────
alter table public.recurring_invoice_templates add column if not exists generate_mode text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recurring_invoice_templates_generate_mode_chk') then
    alter table public.recurring_invoice_templates add constraint recurring_invoice_templates_generate_mode_chk
      check (generate_mode is null or generate_mode in ('DRAFT', 'POST', 'POST_AND_SEND'));
  end if;
end $$;
comment on column public.recurring_invoice_templates.generate_mode is
  'Mig 184: DRAFT = generate for review (no GL, no email); POST = post AR; POST_AND_SEND = post AR and email the customer. NULL = legacy (auto_send ? POST_AND_SEND : POST). The scheduled run posts / sends only when the Scheduled recurring invoices dial allows; otherwise it drafts.';

-- ── §5 invoice dispute marker ────────────────────────────────────────────────
alter table public.invoices add column if not exists disputed_at timestamptz;
alter table public.invoices add column if not exists dispute_note text;
alter table public.invoices add column if not exists disputed_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_dispute_note_chk') then
    alter table public.invoices add constraint invoices_dispute_note_chk
      check (dispute_note is null or length(dispute_note) <= 1000);
  end if;
end $$;
comment on column public.invoices.disputed_at is
  'Mig 184: set while the customer disputes the invoice — the dunning ladder and late fees hold it (policy stop_on_dispute).';

-- ── §6 early-pay discount on bills ───────────────────────────────────────────
alter table public.bills add column if not exists early_pay_discount_bps integer;
alter table public.bills add column if not exists early_pay_discount_date date;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_early_pay_discount_chk') then
    alter table public.bills add constraint bills_early_pay_discount_chk
      check ((early_pay_discount_bps is null or early_pay_discount_bps between 1 and 10000)
             and ((early_pay_discount_bps is null) = (early_pay_discount_date is null)));
  end if;
end $$;
comment on column public.bills.early_pay_discount_bps is
  'Mig 184: early-pay discount (basis points of the balance, e.g. 200 = 2% for "2/10 net 30") available when paid on or before early_pay_discount_date. The weekly pay-run proposal pulls such bills forward.';

-- ── §7 RLS + grants (members read their org; service role writes) ─────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['dunning_policies', 'late_fee_policies', 'late_fee_assessments'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname <> 'client_scope_rls' loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- End migration 184.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
