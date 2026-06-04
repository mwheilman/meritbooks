-- Migration 028: Move job_phases + change_orders into the `core` schema (Session 20)
-- =============================================================
-- Reconstruction note (committed Session 22): this migration was applied
-- directly to Supabase in Session 20 but never committed to the repo. The
-- tables exist live only in `core`. This file reproduces that exact end-state
-- so a from-scratch rebuild (001 -> 034) lands identically to production.
--
-- WHY: jobs moved into `core` in migration 019. The operational child tables
-- job_phases and change_orders stayed Books-owned in `public` and FK'd across
-- the schema boundary into core.jobs. The Jobs API (/api/jobs) embeds these as
-- PostgREST nested relations off core.jobs:
--     core.jobs -> job_phases(...), change_orders(...)
-- PostgREST cannot resolve an embed across schemas, so the Jobs page 500'd with
-- a "could not find a relationship" schema-cache error. Co-locating these two
-- tables in `core` (same schema as jobs) makes the embed resolve. Operational
-- ownership of these tables transfers to MeritProjects (Module 2) later; until
-- then they live in core alongside core.jobs.
--
-- MECHANICS: SET SCHEMA preserves the table OID, so RLS policies, indexes, and
-- all inbound/outbound foreign keys travel with the table untouched (same
-- guarantee relied on in migration 019). The org_isolation policies reference
-- public.get_org_id() fully-qualified, so they keep working across the boundary.
--
-- Idempotent: guarded so a re-run (or running against the live DB where the move
-- already happened) is a harmless no-op.
--
-- No dashboard step required: `core` was already added to the PostgREST
-- "Exposed schemas" list in migration 019, and these tables inherit the schema
-- grants + default privileges set there.
-- =============================================================

-- 1. MOVE THE TWO TABLES INTO `core` (guarded, OID-preserving)
do $$
declare
  t text;
  move_tables text[] := array['job_phases','change_orders'];
begin
  foreach t in array move_tables loop
    if exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      execute format('alter table public.%I set schema core', t);
      raise notice 'Moved public.% -> core.%', t, t;
    else
      raise notice 'Skipped % (not in public; already in core or absent)', t;
    end if;
  end loop;
end $$;

-- 2. RE-ASSERT RLS (policies travelled with the tables; enablement is defensive)
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'core' and tablename = 'job_phases') then
    execute 'alter table core.job_phases enable row level security';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'core' and tablename = 'change_orders') then
    execute 'alter table core.change_orders enable row level security';
  end if;
end $$;

-- 3. RE-ASSERT GRANTS (covered by core default privileges from 019; defensive
--    so a clean from-scratch rebuild is correct even if ordering changes)
do $$ begin
  begin
    execute 'grant select, insert, update, delete on core.job_phases to anon, authenticated, service_role';
    execute 'grant select, insert, update, delete on core.change_orders to anon, authenticated, service_role';
  exception when others then
    raise notice 'Grant re-assert skipped (default privileges already cover core).';
  end;
  -- Nudge PostgREST to reload its schema cache so the new relationships resolve.
  perform pg_notify('pgrst', 'reload schema');
end $$;

-- =============================================================
-- DONE. job_phases + change_orders now live in core alongside core.jobs;
-- the Jobs API embed resolves. Books is otherwise unchanged.
-- =============================================================
