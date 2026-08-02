-- =============================================================================
-- Migration 096: Supervised Agent Orchestration (M9) — agent_runs + agent_run_steps
-- =============================================================================
-- Persistence for the supervised agent runner (lib/agents/runner.ts): a multi-step
-- run with per-step audit. Steps are AUTO / PROPOSE / HUMAN_GATE; the runner honors
-- the tenant autonomy dial + kill switch and NEVER posts money/GL directly — money
-- steps flow through the existing deterministic engines + human approval gates.
-- Additive + idempotent. RLS org_isolation via public.get_org_id(). The app degrades
-- SAFE (ephemeral run) if these tables are absent. Books band; next number: 097.
-- =============================================================================

create table if not exists public.agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid references core.locations(id) on delete set null,
  recipe             text not null,
  feature            text,
  title              text not null,
  status             text not null default 'RUNNING'
                       check (status in ('RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  current_step_index int  not null default 0,
  subject_table      text,
  subject_id         uuid,
  context            jsonb not null default '{}'::jsonb,
  paused_reason      text,
  error              text,
  created_by_user    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_agent_runs_org    on public.agent_runs (org_id, created_at desc);
create index if not exists idx_agent_runs_status on public.agent_runs (org_id, status, created_at desc);

create table if not exists public.agent_run_steps (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  run_id         uuid not null references public.agent_runs(id) on delete cascade,
  step_index     int  not null,
  name           text not null,
  label          text not null,
  kind           text not null check (kind in ('AUTO','PROPOSE','HUMAN_GATE')),
  status         text not null default 'PENDING'
                   check (status in ('PENDING','RUNNING','WAITING','DONE','REJECTED','FAILED','SKIPPED')),
  disposition    text,
  input          jsonb not null default '{}'::jsonb,
  output         jsonb not null default '{}'::jsonb,
  ai_decision_id uuid references public.ai_decisions(id) on delete set null,
  summary        text,
  acted_by_user  text,
  started_at     timestamptz,
  ended_at       timestamptz,
  created_at     timestamptz not null default now(),
  unique (run_id, step_index)
);
create index if not exists idx_agent_run_steps_run on public.agent_run_steps (run_id, step_index);

alter table public.agent_runs      enable row level security;
alter table public.agent_run_steps enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_runs' and policyname='org_select') then
    create policy "org_select" on public.agent_runs for select using (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_runs' and policyname='org_insert') then
    create policy "org_insert" on public.agent_runs for insert with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_runs' and policyname='org_update') then
    create policy "org_update" on public.agent_runs for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_runs' and policyname='org_delete') then
    create policy "org_delete" on public.agent_runs for delete using (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_runs' and policyname='service_all') then
    create policy "service_all" on public.agent_runs for all to service_role using (true) with check (true); end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_run_steps' and policyname='org_select') then
    create policy "org_select" on public.agent_run_steps for select using (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_run_steps' and policyname='org_insert') then
    create policy "org_insert" on public.agent_run_steps for insert with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_run_steps' and policyname='org_update') then
    create policy "org_update" on public.agent_run_steps for update using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='agent_run_steps' and policyname='service_all') then
    create policy "service_all" on public.agent_run_steps for all to service_role using (true) with check (true); end if;
end $$;
