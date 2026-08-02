-- =============================================================================
-- Migration 093: Recurring Journal Entry templates + per-period run ledger
-- =============================================================================
-- Standing/standard recurring journal entries (monthly & quarterly accruals,
-- allocations, standard reversing entries) that the existing `posting_schedules`
-- rail cannot express: that rail carries a SINGLE debit/credit account pair with no
-- room for a multi-line balanced allocation and no recurring-JE schedule type. So a
-- recurring JE runs on its own two tables:
--
--   1. recurring_je_templates — the definition: cadence (MONTHLY/QUARTERLY), an
--      effective window, and the BALANCED line set stored as `lines` jsonb (bigint
--      cents per line). Lifecycle ACTIVE/PAUSED/COMPLETED/CANCELLED.
--   2. recurring_je_runs — one row per (template, period). The generator proposes a
--      balanced entry per due period as a PROPOSED run (it NEVER posts); a human
--      approves and the deterministic postJournalEntry posts it (debits=credits or it
--      does not post), stamping gl_entry_id + posted_at and flipping status to POSTED.
--      `unique (template_id, period_year, period_month)` is the double-generate /
--      double-post guarantor — the exact role posting_schedule_runs plays for prepaid
--      amortization.
--
-- Canon §3: AI/automation PROPOSES, a human APPROVES, the deterministic engine POSTS.
-- Nothing here auto-posts. Money is bigint cents (inside `lines`/`proposed_lines` and
-- `amount_cents`). RLS org_isolation via public.get_org_id() (Clerk org_id claim;
-- never auth.uid()). Master data referenced by FK into `core`. ADDITIVE + idempotent
-- (create-if-not-exists). Books band; next number: 094. Requires 019 (core carve) +
-- 004 (gl_entries). Apply to Supabase FIRST, then ship the dependent code.
--
-- DEGRADE-SAFE: with no templates nothing generates and nothing posts; absent this
-- migration the feature is simply unavailable and the rest of the app is unaffected.
-- =============================================================================

-- ---- Guard: the tables this references must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (core carve) before 093.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'gl_entries') then
    raise exception 'public.gl_entries not found — deploy migration 004 before 093.';
  end if;
end $$;

-- =============================================================================
-- 1. recurring_je_templates — the recurring definition + its balanced line set
-- =============================================================================
create table if not exists public.recurring_je_templates (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Entity the generated JE posts to (a single location per entry).
  location_id uuid not null,
  name text not null,
  cadence text not null default 'MONTHLY'
    check (cadence in ('MONTHLY', 'QUARTERLY')),
  start_date date not null,
  end_date date,                                   -- null = open-ended
  entry_type text not null default 'STANDARD',
  memo text,
  -- The balanced line set: [{account_id, debit_cents, credit_cents, location_id?,
  -- department_id?, class_id?, memo?}, ...]. Balance is validated in app code on
  -- write and re-validated at post; bigint cents inside the JSON.
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  periods_generated int not null default 0,
  last_period text,                                -- 'YYYY-MM' of the latest generated run
  created_by uuid,                                 -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_recurring_je_templates_org
  on public.recurring_je_templates(org_id, status);
create index if not exists idx_recurring_je_templates_active
  on public.recurring_je_templates(org_id, status, start_date);

-- =============================================================================
-- 2. recurring_je_runs — one PROPOSED-then-POSTED run per (template, period)
-- =============================================================================
create table if not exists public.recurring_je_runs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  template_id uuid not null references public.recurring_je_templates(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  entry_date date not null,
  -- Snapshot of the balanced lines for this period (bigint cents).
  proposed_lines jsonb not null default '[]'::jsonb,
  amount_cents bigint not null default 0,
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED', 'POSTED', 'SKIPPED')),
  gl_entry_id uuid references public.gl_entries(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One run per (template, period) — the double-generate / double-post guarantor.
create unique index if not exists uq_recurring_je_runs_period
  on public.recurring_je_runs(template_id, period_year, period_month);
create index if not exists idx_recurring_je_runs_org_status
  on public.recurring_je_runs(org_id, status);
create index if not exists idx_recurring_je_runs_template
  on public.recurring_je_runs(template_id, period_year desc, period_month desc);

-- =============================================================================
-- 3. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================================
alter table public.recurring_je_templates enable row level security;
alter table public.recurring_je_runs      enable row level security;

do $$ begin
  create policy "org_isolation" on public.recurring_je_templates
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on public.recurring_je_runs
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.recurring_je_templates to anon, authenticated, service_role;
grant select, insert, update, delete on public.recurring_je_runs      to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_recurring_je_templates_updated
        before update on public.recurring_je_templates
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
    begin
      create trigger trg_recurring_je_runs_updated
        before update on public.recurring_je_runs
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================================
-- DONE. The tenant can define recurring JE templates (balanced multi-line, monthly/
-- quarterly), generate a PROPOSED balanced entry per due period (never auto-posted),
-- and on human approval post it through the deterministic engine — with a unique
-- (template, period) guard preventing any double-generate/double-post. Org-isolated
-- by RLS. Apply this FIRST, then ship the dependent code.
-- =============================================================================
