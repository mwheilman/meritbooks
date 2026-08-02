-- =============================================================================
-- Migration 092: Configurable Multi-Step Approval Workflows (Books-owned)
-- =============================================================================
-- N-step, amount-tiered approval CHAINS defined per document type. A tenant defines,
-- for a doc_type (BILL / JOURNAL_ENTRY / PAYMENT / EXPENSE / PAYROLL), an ordered set
-- of STEPS — each with an amount band (min/max cents), a required approver ROLE, and a
-- `require_distinct` flag (a distinct human per distinct-required step). The document's
-- AMOUNT selects which steps apply (the tier); the chain is walked in `step_order`.
--
-- This ADDS a configurable chain ON TOP OF the existing single-approval primitives —
-- it does NOT recreate public.approvals (migration 042, money-movement SoD). Those two
-- coexist: the workflow's FINAL step can drive the existing gated single-approval
-- action via approval_requests.link_approval_id, so posting is never forked.
--
-- DEGRADE-SAFE: a doc_type with NO active workflow (or whose bands exclude the amount)
-- has NO applicable steps → the caller keeps the existing single-approver behavior
-- unchanged. Absent this migration the feature is simply unavailable; nothing breaks.
--
-- Canon: preparer != approver is enforced in the pure engine + service (and, for the
-- linked single-approval, by the migration-042 CHECK). Every action is audited in
-- approval_request_actions (append-only). RLS org_isolation via public.get_org_id()
-- (Clerk org_id claim; never auth.uid()). Master data referenced by FK into `core`.
-- Money is bigint cents. ADDITIVE + idempotent (safe to re-run). Books band; after 089.
-- Apply to Supabase FIRST, then ship the dependent code.
-- =============================================================================

-- ---- Guard: the FK target we depend on must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (core carve) before 092.';
  end if;
end $$;

-- =============================================================================
-- 1. approval_workflows — one chain definition per (org, doc_type[, version])
-- =============================================================================
-- At most ONE ACTIVE workflow per (org_id, doc_type) — the partial unique index is the
-- guarantor (the resolver picks the single active one). Inactive rows are retained as
-- history / drafts.
create table if not exists public.approval_workflows (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id()
                  references core.organizations(id) on delete cascade,
  name          text not null default 'Approval Workflow',
  doc_type      text not null
                  check (doc_type in ('BILL','JOURNAL_ENTRY','PAYMENT','EXPENSE','PAYROLL')),
  active        boolean not null default true,
  description   text,
  created_by_user text,               -- clerk_user_id of the author
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.approval_workflows is
  'Configurable multi-step approval chain definitions, one active per (org, doc_type). Steps live in approval_workflow_steps. Additive to the single-approval primitives (migration 042); a doc_type with no active workflow keeps existing single-approver behavior.';

create index if not exists ix_approval_workflows_org_type
  on public.approval_workflows (org_id, doc_type, active);

-- Exactly one ACTIVE workflow per (org, doc_type) — DB is the guarantor.
create unique index if not exists uq_approval_workflows_one_active
  on public.approval_workflows (org_id, doc_type) where active;

-- =============================================================================
-- 2. approval_workflow_steps — the ordered, amount-banded, role-gated steps
-- =============================================================================
create table if not exists public.approval_workflow_steps (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id()
                     references core.organizations(id) on delete cascade,
  workflow_id      uuid not null references public.approval_workflows(id) on delete cascade,
  step_order       int not null check (step_order >= 1),
  min_amount_cents bigint not null default 0 check (min_amount_cents >= 0),
  max_amount_cents bigint check (max_amount_cents is null or max_amount_cents >= 0),
  approver_role    text not null,     -- a lib/rbac UserRole; validated in app code
  require_distinct boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint approval_workflow_steps_band_ok
    check (max_amount_cents is null or max_amount_cents >= min_amount_cents),
  constraint approval_workflow_steps_uq_order
    unique (workflow_id, step_order)
);

comment on table public.approval_workflow_steps is
  'Ordered steps of an approval chain. A document AMOUNT selects steps whose [min,max] band covers it; the chain walks by step_order. approver_role is a lib/rbac UserRole (validated in app code, not by a DB enum, so the role vocabulary can evolve without a migration). require_distinct forces a distinct human vs prior approvers.';

create index if not exists ix_approval_workflow_steps_wf
  on public.approval_workflow_steps (workflow_id, step_order);

-- =============================================================================
-- 3. approval_requests — one per document routed through a workflow
-- =============================================================================
-- current_step is the `step_order` currently awaiting a decision. link_approval_id ties
-- the chain to an existing single-approval (migration 042) so the FINAL step can drive
-- the already-gated money-movement action without forking posting.
create table if not exists public.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id()
                  references core.organizations(id) on delete cascade,
  workflow_id   uuid not null references public.approval_workflows(id) on delete restrict,
  doc_type      text not null
                  check (doc_type in ('BILL','JOURNAL_ENTRY','PAYMENT','EXPENSE','PAYROLL')),
  doc_id        uuid not null,          -- the subject document row
  amount_cents  bigint not null default 0 check (amount_cents >= 0),
  current_step  int not null,           -- step_order awaiting a decision
  status        text not null default 'PENDING'
                  check (status in ('PENDING','APPROVED','REJECTED')),
  prepared_by   text not null,          -- clerk_user_id of the submitter (may not approve)
  link_approval_id uuid references public.approvals(id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.approval_requests is
  'One approval-chain instance per document routed through a workflow. current_step = step_order awaiting a decision; status PENDING/APPROVED/REJECTED. link_approval_id bridges the final step to the existing single-approval gated action (migration 042) so posting is not forked.';

-- One live (PENDING) request per document — prevents double-routing the same doc.
create unique index if not exists uq_approval_requests_one_open
  on public.approval_requests (doc_type, doc_id) where status = 'PENDING';
create index if not exists ix_approval_requests_org_status
  on public.approval_requests (org_id, status, doc_type);

-- =============================================================================
-- 4. approval_request_actions — append-only audit of every decision
-- =============================================================================
create table if not exists public.approval_request_actions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id()
                references core.organizations(id) on delete cascade,
  request_id  uuid not null references public.approval_requests(id) on delete cascade,
  step_order  int not null,
  actor_user  text not null,            -- clerk_user_id of the approver/rejecter
  decision    text not null check (decision in ('APPROVE','REJECT')),
  reason      text,
  acted_at    timestamptz not null default now()
);

comment on table public.approval_request_actions is
  'Append-only audit trail of every approval-chain decision: which step, which actor (clerk_user_id), approve/reject, reason, when. One row per action.';

create index if not exists ix_approval_request_actions_request
  on public.approval_request_actions (request_id, acted_at);

-- =============================================================================
-- 5. updated_at maintenance
-- =============================================================================
create or replace function public.tg_approval_workflows_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_approval_workflows_touch on public.approval_workflows;
create trigger trg_approval_workflows_touch
  before update on public.approval_workflows
  for each row execute function public.tg_approval_workflows_touch();

drop trigger if exists trg_approval_requests_touch on public.approval_requests;
create trigger trg_approval_requests_touch
  before update on public.approval_requests
  for each row execute function public.tg_approval_workflows_touch();

-- =============================================================================
-- 6. RLS — tenant isolation (Books pattern: org_id = get_org_id()) + service role
-- =============================================================================
alter table public.approval_workflows       enable row level security;
alter table public.approval_workflow_steps  enable row level security;
alter table public.approval_requests         enable row level security;
alter table public.approval_request_actions  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'approval_workflows','approval_workflow_steps','approval_requests','approval_request_actions'
  ] loop
    if not exists (select 1 from pg_policies
                   where schemaname='public' and tablename=t and policyname='org_isolation') then
      execute format(
        'create policy "org_isolation" on public.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())',
        t);
    end if;
    if not exists (select 1 from pg_policies
                   where schemaname='public' and tablename=t and policyname='service_write') then
      execute format(
        'create policy "service_write" on public.%I for all to service_role using (true) with check (true)',
        t);
    end if;
  end loop;
end $$;

grant select, insert, update, delete on public.approval_workflows       to anon, authenticated, service_role;
grant select, insert, update, delete on public.approval_workflow_steps  to anon, authenticated, service_role;
grant select, insert, update, delete on public.approval_requests         to anon, authenticated, service_role;
grant select, insert, update, delete on public.approval_request_actions  to anon, authenticated, service_role;

-- =============================================================================
-- 7. Verification
-- =============================================================================
do $$
begin
  raise notice 'Migration 092 OK: workflows=%, steps=%, requests=%, actions=%',
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approval_workflows'),
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approval_workflow_steps'),
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approval_requests'),
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='approval_request_actions');
end $$;
