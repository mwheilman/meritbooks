-- =============================================================================
-- Migration 075: Autonomy & Kill-Switch Control Plane (matrix modality M10)
-- =============================================================================
-- The supervision layer that governs EVERY AI capability in the product. Canon
-- §3: auto-post is OFF by default; autonomy is a per-tenant, per-task DIAL;
-- segregation of duties applies to the AI itself; every AI action -> Decision Log.
--
-- Two tables, both additive + idempotent (create-if-not-exists), both org-isolated
-- via RLS keyed to public.get_org_id() (the same source RLS enforces everywhere):
--
--   1. autonomy_settings      — the per-feature DIAL. One row per (org, feature).
--                               mode ∈ OFF | PROPOSE | AUTO_UNDER_LIMIT with an
--                               optional materiality cap (bigint cents) above which
--                               even AUTO_UNDER_LIMIT falls back to human review.
--   2. autonomy_kill_switch   — one row per org. When engaged, NOTHING auto-applies
--                               across the whole tenant (a global e-stop for the AI).
--
-- The application (lib/autonomy/disposition.ts) degrades SAFE when a row is absent
-- or these tables do not yet exist: it defaults to the most-conservative behavior
-- (PROPOSE → human review), so nothing auto-posts and nothing breaks pre-apply.
-- =============================================================================

-- ── autonomy_settings — the per-feature autonomy dial ────────────────────────
create table if not exists public.autonomy_settings (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  feature                text not null,                      -- ai_decisions.feature key (e.g. 'CATEGORIZATION')
  mode                   text not null default 'PROPOSE'
                           check (mode in ('OFF', 'PROPOSE', 'AUTO_UNDER_LIMIT')),
  materiality_limit_cents bigint,                            -- null = no cap configured (⇒ cannot auto)
  updated_by             text,                               -- clerk user id of the last editor
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, feature)
);
comment on table public.autonomy_settings is
  'Per-tenant, per-feature autonomy dial (M10). mode OFF disables the capability; PROPOSE always routes to a human; AUTO_UNDER_LIMIT auto-applies only high-confidence actions at/under the materiality cap.';

create index if not exists idx_autonomy_settings_org on public.autonomy_settings (org_id);

-- ── autonomy_kill_switch — the global e-stop, one row per org ─────────────────
create table if not exists public.autonomy_kill_switch (
  org_id      uuid primary key references core.organizations(id) on delete cascade,
  engaged     boolean not null default false,
  engaged_by  text,                                          -- clerk user id who last toggled it
  engaged_at  timestamptz,
  reason      text,
  updated_at  timestamptz not null default now()
);
comment on table public.autonomy_kill_switch is
  'Global per-tenant kill switch (M10). When engaged=true, disposition resolves to BLOCKED for every feature — nothing the AI proposes auto-applies until it is disengaged.';

-- ── RLS: org isolation via get_org_id(), plus full service_role access ────────
alter table public.autonomy_settings   enable row level security;
alter table public.autonomy_kill_switch enable row level security;

do $$
begin
  -- autonomy_settings: read + write scoped to the caller's org.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_settings' and policyname='org_select') then
    create policy "org_select" on public.autonomy_settings for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_settings' and policyname='org_insert') then
    create policy "org_insert" on public.autonomy_settings for insert with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_settings' and policyname='org_update') then
    create policy "org_update" on public.autonomy_settings for update
      using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_settings' and policyname='service_all') then
    create policy "service_all" on public.autonomy_settings for all to service_role using (true) with check (true);
  end if;

  -- autonomy_kill_switch: read + write scoped to the caller's org.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_kill_switch' and policyname='org_select') then
    create policy "org_select" on public.autonomy_kill_switch for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_kill_switch' and policyname='org_insert') then
    create policy "org_insert" on public.autonomy_kill_switch for insert with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_kill_switch' and policyname='org_update') then
    create policy "org_update" on public.autonomy_kill_switch for update
      using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='autonomy_kill_switch' and policyname='service_all') then
    create policy "service_all" on public.autonomy_kill_switch for all to service_role using (true) with check (true);
  end if;
end $$;
