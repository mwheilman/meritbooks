-- =============================================================================
-- Migration 191: FP&A workspace — saved KPI dashboards (tenant role defaults +
--                personal dashboards, IA M-8 lock levels) and dashboards in report packs.
-- =============================================================================
--
-- FPB : docs/FPB-reports-fpna.md §4.13 (Wave 4A, AC-W3 / AC-W4 / AC-W11).
-- Audit: FP-01, FP-03, FP-04, FP-19 (docs/audit-2026-10/STATUS-2026-10-25.md §3.2).
--
-- §1 public.fpna_dashboards — one row per dashboard version.
--      scope_kind 'tenant' : an administrator-published default for a role (role_key; NULL = every
--                            role). Publishing inserts a NEW version and clears is_current on the
--                            previous one — the version chain is the audit of who published what.
--      scope_kind 'user'   : a person's own dashboard (user_id = Clerk id, text per canon).
--      cards               : ordered [{ "metric": <registry key>, "size": "s"|"m"|"l" }], 1–48 cards.
--                            Keys are validated against lib/metrics/registry.ts by the app.
--      settings            : { basis, comparison, sparkline } — the dashboard's period basis.
--      lock_level          : IA M-8 — unlocked (free) · add_move (add / reorder, required metrics
--                            stay) · locked (no personal copy).
--      publish_mode        : new_users (keep personal copies) · override (the new default wins over
--                            personal copies saved before it).
-- §2 public.report_packs.fpna_items — dashboards added to a pack (Add to pack); scheduled delivery
--      renders each one server-side, governed as non-finance (released months only).
-- §3 Write lock (171 / 187 / 190 pattern): members SELECT only — tenant rows of their org and
--      their OWN user rows; every write is the service role after the route's permission + lock
--      check (lib/fpna/workspace/dashboards-store.ts). Personal dashboards are deliberately NOT
--      member-writable: the lock level is a tenant control, and a member write grant would let a
--      user bypass a `locked` / `add_move` default through PostgREST.
-- §4 M1: no functions are created. Grants: anon nothing; authenticated SELECT; service_role all.
-- §5 core.apply_projects_only_seat_deny on the new table + guarded core.apply_client_scope_rls()
--      (the table has no location_id, so client scope leaves it as an org-level table).
--
-- SAFETY: additive. No GL effect. Idempotent. PGlite-compatible (no subqueries in CHECKs).
-- Apply to Supabase FIRST, then commit the code that depends on it.
-- =============================================================================

do $$
begin
  if to_regclass('core.organizations') is null then
    raise exception 'core.organizations not found — deploy 001 before 191.';
  end if;
  if to_regprocedure('public.get_org_id()') is null then
    raise exception 'public.get_org_id() not found — deploy the foundation before 191.';
  end if;
end $$;

-- =============================================================================
-- §1 fpna_dashboards
-- =============================================================================
create table if not exists public.fpna_dashboards (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  scope_kind        text not null,
  role_key          text,
  user_id           text,
  name              text not null,
  pack_key          text not null default 'custom',
  cards             jsonb not null,
  settings          jsonb not null default '{}'::jsonb,
  lock_level        text not null default 'unlocked',
  required_metrics  text[] not null default '{}'::text[],
  publish_mode      text not null default 'new_users',
  version           integer not null default 1,
  is_current        boolean not null default true,
  based_on_id       uuid references public.fpna_dashboards(id) on delete set null,
  published_by      text,
  published_at      timestamptz,
  note              text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_scope_kind_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_scope_kind_chk
      check (scope_kind in ('tenant', 'user'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_owner_chk') then
    -- tenant rows belong to a role (or every role) and never to a person; user rows to exactly one person
    alter table public.fpna_dashboards add constraint fpna_dashboards_owner_chk
      check ((scope_kind = 'tenant' and user_id is null)
          or (scope_kind = 'user' and user_id is not null and btrim(user_id) <> '' and role_key is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_role_key_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_role_key_chk
      check (role_key is null or role_key ~ '^[a-z][a-z0-9_]{1,63}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_name_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_name_chk
      check (char_length(btrim(name)) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_pack_key_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_pack_key_chk
      check (pack_key in ('owner', 'cfo', 'construction', 'dealer', 'practice', 'custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_cards_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_cards_chk
      check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) between 1 and 48);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_settings_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_settings_chk
      check (jsonb_typeof(settings) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_lock_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_lock_chk
      check (lock_level in ('unlocked', 'add_move', 'locked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_publish_mode_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_publish_mode_chk
      check (publish_mode in ('new_users', 'override'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_version_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_version_chk check (version >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_published_chk') then
    -- a tenant default is only ever stored as a publication (who + when)
    alter table public.fpna_dashboards add constraint fpna_dashboards_published_chk
      check (scope_kind = 'user' or (published_by is not null and published_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fpna_dashboards_note_chk') then
    alter table public.fpna_dashboards add constraint fpna_dashboards_note_chk
      check (note is null or char_length(note) <= 500);
  end if;
end $$;

-- One current default per role (NULL role = every role) …
create unique index if not exists uq_fpna_dashboards_tenant_current
  on public.fpna_dashboards (org_id, coalesce(role_key, '*'))
  where scope_kind = 'tenant' and is_current and archived_at is null;
-- … and one current dashboard per person per name.
create unique index if not exists uq_fpna_dashboards_user_current
  on public.fpna_dashboards (org_id, user_id, lower(name))
  where scope_kind = 'user' and is_current and archived_at is null;
create index if not exists idx_fpna_dashboards_user
  on public.fpna_dashboards (org_id, user_id, updated_at desc) where scope_kind = 'user';
create index if not exists idx_fpna_dashboards_tenant
  on public.fpna_dashboards (org_id, role_key, version desc) where scope_kind = 'tenant';

comment on table public.fpna_dashboards is
  'Mig 191 (FPB-reports-fpna §4.13): FP&A KPI dashboards — tenant role defaults (versioned publications, IA M-8 lock levels) and personal dashboards. Members read tenant rows + their own; service-role writes only.';

-- =============================================================================
-- §2 report_packs.fpna_items (dashboards added to a pack)
-- =============================================================================
do $$
begin
  if to_regclass('public.report_packs') is not null then
    alter table public.report_packs add column if not exists fpna_items jsonb not null default '[]'::jsonb;
    if not exists (select 1 from pg_constraint where conname = 'report_packs_fpna_items_chk') then
      alter table public.report_packs add constraint report_packs_fpna_items_chk
        check (jsonb_typeof(fpna_items) = 'array' and jsonb_array_length(fpna_items) <= 12);
    end if;
  end if;
end $$;

-- §2b Security review H3: report_packs becomes SELECT-only for members (171 pattern). A pack is
-- scheduled, server-rendered with a SYSTEM tenant client and emailed to outside recipients, so its
-- location_ids / fpna_items[].companies decide what leaves the building. 104 granted members full
-- writes under the org policy, which let a client-scoped member PATCH location_ids (or add a
-- dashboard for another client) over PostgREST and have the scheduler email it. Every write is now
-- the service role from /api/reports/packs* and /api/fpna/workspace/add-to-pack, after
-- requirePermission(reports:export) + assertWriteScope(location_ids ∪ every fpna_items[].companies)
-- — an empty set (all companies) needs all-clients scope (lib/reports/compiler/pack-scope.ts).
do $$
declare p record;
begin
  if to_regclass('public.report_packs') is not null then
    -- 104's org_isolation was FOR ALL; members now get a SELECT-only policy (writes: service_write).
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'report_packs'
                and policyname not in ('service_write', 'service_all', 'member_read', 'client_scope_rls', 'projects_only_seat_deny') loop
      execute format('drop policy if exists %I on public.report_packs', p.policyname);
    end loop;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_packs' and policyname = 'member_read') then
      create policy member_read on public.report_packs for select to authenticated using (org_id = public.get_org_id());
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_packs' and policyname = 'service_all') then
      create policy service_all on public.report_packs for all to service_role using (true) with check (true);
    end if;
    revoke insert, update, delete, truncate on table public.report_packs from authenticated;
    revoke all on table public.report_packs from anon;
    grant select on table public.report_packs to authenticated;
    grant select, insert, update, delete on table public.report_packs to service_role;
  end if;
end $$;

-- =============================================================================
-- §3 RLS + grants (members read; service role writes)
-- =============================================================================
do $$
declare
  p record;
begin
  alter table public.fpna_dashboards enable row level security;
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'fpna_dashboards'
              and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
    execute format('drop policy if exists %I on public.fpna_dashboards', p.policyname);
  end loop;
  -- tenant defaults are visible to every member of the org; a personal dashboard only to its owner
  create policy member_read on public.fpna_dashboards for select to authenticated
    using (org_id = public.get_org_id()
           and (scope_kind = 'tenant'
                or user_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')));
  create policy service_all on public.fpna_dashboards for all to service_role using (true) with check (true);
end $$;

revoke all on table public.fpna_dashboards from anon;
revoke insert, update, delete, truncate on table public.fpna_dashboards from authenticated;
grant select on table public.fpna_dashboards to authenticated;
grant select, insert, update, delete on table public.fpna_dashboards to service_role;

-- =============================================================================
-- §5 client scope + Projects-only seat deny (guarded: absent in the replay)
-- =============================================================================
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- Every RLS table this migration creates gets the RESTRICTIVE projects_only_seat_deny policy.
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['fpna_dashboards'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;

-- End migration 191.
