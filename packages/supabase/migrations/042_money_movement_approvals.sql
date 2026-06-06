-- =============================================================================
-- Migration 042: Money-Movement Approval Engine & Audit (Books-owned — GATE 12)
-- =============================================================================
-- Separation-of-duties + audit for every money movement (AR refunds, AP
-- disbursements, payroll runs). Books-owned per the Core ruling, but built to
-- lift-friendly conventions so a future Core consolidation is clean:
--   * generic approval + approval_step state machine (NOT bespoke per type)
--   * audit columns: actor (clerk_user_id text), timestamp, before, after,
--     provider_correlation_id
--
-- preparer != approver is enforced at the DATABASE level (a CHECK), so it holds
-- regardless of which identity tables exist. The richer "who MAY approve"
-- (role-based) check depends on core.users / core.memberships / core.roles,
-- which are specced but NOT built — the service layer FAILS CLOSED until they
-- ship (see lib/money/approvals.ts). Do not bake a Books-private "who may
-- approve" that won't reconcile to core.memberships.
--
-- REQUIRES public.get_org_id(). Idempotent. Money is bigint cents.
-- =============================================================================

-- =============================================================================
-- 1. approvals — one per approvable money movement
-- =============================================================================
create table if not exists public.approvals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id(),
  kind          text not null
                  check (kind in ('AR_REFUND','AP_DISBURSEMENT','AP_BATCH','PAYROLL_RUN')),
  subject_table text not null,            -- e.g. 'bill_payments', 'payroll_runs'
  subject_id    uuid not null,            -- the row being approved
  amount_cents  bigint,                   -- informational; null where not a single amount
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','RELEASED','SETTLED','REJECTED','RETURNED')),
  prepared_by   text not null,            -- clerk_user_id of the preparer
  approved_by   text,                     -- clerk_user_id of the approver (set on APPROVED)
  released_by   text,                     -- clerk_user_id who triggered the actual money movement
  provider_correlation_id text,           -- ties to the provider transfer/run once originated
  reject_reason text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Separation of duties, enforced in the database:
  constraint approvals_preparer_ne_approver check (approved_by is null or approved_by <> prepared_by)
);

comment on table public.approvals is
  'GATE 12 money-movement approvals (Books-owned, lift-friendly). Generic state machine across AR refunds, AP disbursements/batches, and payroll runs. preparer != approver enforced by CHECK; role-based "who may approve" fails closed in the service until core.memberships/roles exist.';

create unique index if not exists uq_approvals_subject
  on public.approvals (subject_table, subject_id);
create index if not exists ix_approvals_org_status
  on public.approvals (org_id, status);

-- =============================================================================
-- 2. approval_steps — immutable audit trail of every transition
-- =============================================================================
create table if not exists public.approval_steps (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id(),
  approval_id  uuid not null references public.approvals(id) on delete cascade,
  action       text not null
                 check (action in ('PREPARED','SUBMITTED','APPROVED','RELEASED','SETTLED','REJECTED','RETURNED')),
  actor        text not null,             -- clerk_user_id
  at           timestamptz not null default now(),
  before_state text,
  after_state  text,
  provider_correlation_id text,
  note         text,
  metadata     jsonb not null default '{}'::jsonb
);

comment on table public.approval_steps is
  'Append-only audit log of approval transitions: actor, timestamp, before/after state, provider correlation id. One row per action.';

create index if not exists ix_approval_steps_approval
  on public.approval_steps (approval_id, at);

-- updated_at maintenance on approvals
create or replace function public.tg_approvals_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_approvals_touch on public.approvals;
create trigger trg_approvals_touch
  before update on public.approvals
  for each row execute function public.tg_approvals_touch();

-- =============================================================================
-- 3. RLS — tenant isolation (Books pattern: org_id = get_org_id())
-- =============================================================================
alter table public.approvals      enable row level security;
alter table public.approval_steps enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='approvals' and policyname='org_isolation') then
    create policy "org_isolation" on public.approvals for all using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='approvals' and policyname='service_write') then
    create policy "service_write" on public.approvals for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='approval_steps' and policyname='org_isolation') then
    create policy "org_isolation" on public.approval_steps for all using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='approval_steps' and policyname='service_write') then
    create policy "service_write" on public.approval_steps for all to service_role using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- 4. Verification
-- =============================================================================
do $$
begin
  raise notice 'Migration 042 OK: approvals=%, approval_steps=%, SoD check present=%',
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approvals'),
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approval_steps'),
    exists (select 1 from pg_constraint where conname='approvals_preparer_ne_approver');
end $$;
