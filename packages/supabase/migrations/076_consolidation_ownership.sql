-- Migration 076: Consolidation ownership structure (GATE 11a — the multi-entity moat)
-- =============================================================
-- Effective-dated ownership / consolidation-method structure between two legal
-- entities (both `core.locations`) inside one tenant. This is what turns a pile of
-- per-entity trial balances into a real CONSOLIDATED financial statement: it tells
-- the consolidation engine, for each subsidiary, (a) the group's ownership %, and
-- (b) how to consolidate it — FULL (line-by-line + non-controlling interest for the
-- minority), EQUITY (one-line investment + equity in earnings), or NONE (excluded).
--
-- Migration 029 already put a single `parent_entity_id` + `ownership_pct` on
-- core.locations as the FOUNDATION. This table is the richer, effective-dated,
-- method-carrying overlay the consolidation gate consumes: ownership changes over
-- time (a buy-up from 60% to 100%, a step-down to equity method) are first-class,
-- and the same child can be re-parented historically without losing the prior fact.
--
-- Generic: NEVER hardcodes an entity. parent/child are FKs to core.locations; the
-- tenant maintains its own structure. The engine DEGRADES SAFE — an entity with no
-- row here is treated as 100%-owned / FULL (a single standalone company consolidates
-- to itself), so nothing breaks before or without this structure being populated.
--
-- Additive + idempotent (create-if-not-exists). RLS org_isolation via get_org_id().
-- Requires 019 (core carve) + 029 (entity hierarchy). Books band; next number: 077.
-- =============================================================

-- ---- Guard: the entity table this FKs to must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'locations') then
    raise exception 'core.locations not found — deploy migration 019 (core carve) before 076.';
  end if;
end $$;

-- =============================================================
-- 1. ENTITY OWNERSHIP / CONSOLIDATION STRUCTURE
-- =============================================================
-- One row = "the parent entity owns ownership_percent of the child entity, and the
-- group consolidates the child by consolidation_method, effective [start, end)."
create table if not exists public.entity_ownership (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Both sides are legal entities (companies) = core.locations.
  parent_entity_id uuid not null references core.locations(id) on delete cascade,
  child_entity_id  uuid not null references core.locations(id) on delete cascade,
  -- The group's ownership of the child, 0..100 (percent, up to 4 dp for step-ups).
  ownership_percent numeric(7,4) not null default 100
    check (ownership_percent >= 0 and ownership_percent <= 100),
  -- FULL   → consolidate line-by-line; carve out non-controlling interest (NCI).
  -- EQUITY → one-line investment + equity in earnings (20–50% influence).
  -- NONE   → excluded from the consolidation (e.g. held-for-sale, <20%).
  consolidation_method text not null default 'FULL'
    check (consolidation_method in ('FULL', 'EQUITY', 'NONE')),
  -- Effective-dated so ownership history is preserved (buy-ups, step-downs).
  effective_start date not null default current_date,
  effective_end   date,                     -- NULL = still in effect
  notes text,
  created_by uuid,                           -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_entity_ownership_distinct check (parent_entity_id <> child_entity_id),
  constraint chk_entity_ownership_dates
    check (effective_end is null or effective_end >= effective_start)
);

-- A child can have at most ONE structure row per (parent, effective_start): re-run
-- the same edit and it upserts rather than duplicating; different start dates keep
-- the historical chain.
create unique index if not exists uq_entity_ownership_edge_start
  on public.entity_ownership(org_id, parent_entity_id, child_entity_id, effective_start);

create index if not exists idx_entity_ownership_child
  on public.entity_ownership(org_id, child_entity_id);
create index if not exists idx_entity_ownership_parent
  on public.entity_ownership(org_id, parent_entity_id);

-- =============================================================
-- 2. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
alter table public.entity_ownership enable row level security;
do $$ begin
  create policy "org_isolation" on public.entity_ownership
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.entity_ownership
  to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists (it does post-029).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_entity_ownership_updated
        before update on public.entity_ownership
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================
-- DONE. The tenant can now describe its consolidation group (ownership % + method
-- per subsidiary, effective-dated). The consolidation engine reads this to produce
-- consolidated statements with an eliminations column and a non-controlling-interest
-- line; absent any row, every entity consolidates FULL at 100% (single-entity safe).
-- =============================================================
