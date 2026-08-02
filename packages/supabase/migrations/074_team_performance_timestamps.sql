-- Migration 074: Team Performance KPI enablers (FPB-team-performance)
-- Timestamps that make cycle-time metrics computable (upload->categorized->approved; bill
-- received->paid; days-to-close), plus a per-tenant performance-config for difficulty weights +
-- targets (fairness: difficulty-weighted, not raw volume). Additive + nullable; historical rows
-- stay null (metrics accrue going forward). Applied to Supabase first (2026-08-01), then committed.

alter table public.bank_transactions add column if not exists categorized_at timestamptz;
alter table public.bills add column if not exists received_at timestamptz;
alter table public.fiscal_periods add column if not exists close_started_at timestamptz;
alter table public.fiscal_periods add column if not exists closed_at timestamptz;

create table if not exists public.performance_config (
  org_id uuid primary key,
  action_weights jsonb not null default '{}'::jsonb,
  targets jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.performance_config enable row level security;
create policy org_isolation on public.performance_config for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
