-- Migration 040: Vendor-pattern learning loop support (GATE 3 — Session 22)
-- =============================================================
-- vendor_patterns (from migration 005) is the deterministic tier-1 cache the AI
-- categorizer checks before spending a gateway call. Its FKs followed the moved
-- master tables to the core schema in 019 (SET SCHEMA preserves FKs), so it is
-- structurally sound. This migration makes it ready to LEARN:
--   1. allow description-only patterns (vendor_id nullable) — we can learn a
--      description→account mapping even when no vendor is identified.
--   2. a unique index on (org_id, normalized_description) so confirmed codings
--      upsert (increment match_count) instead of fragmenting into duplicates.
--   3. standardize RLS to the org_id = get_org_id() pattern used everywhere else.
--
-- Additive + idempotent. Next migration number: 041.
-- =============================================================

do $$
begin
  if to_regclass('public.vendor_patterns') is null then
    raise exception 'public.vendor_patterns not found — deploy migration 005 before 040.';
  end if;
end $$;

-- 1. Allow description-only patterns (no-op if already nullable).
alter table public.vendor_patterns alter column vendor_id drop not null;

-- 2. Upsert key. (Table is effectively empty in a fresh tenant; if duplicates
--    ever existed this would surface them rather than silently merge.)
create unique index if not exists uq_vendor_patterns_norm
  on public.vendor_patterns(org_id, normalized_description);

create index if not exists idx_vendor_patterns_lookup
  on public.vendor_patterns(org_id, match_count desc);

-- 3. Standardize RLS.
alter table public.vendor_patterns enable row level security;
do $$ begin
  create policy "org_isolation" on public.vendor_patterns
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.vendor_patterns
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. The categorizer can now learn from every confirmed coding.
-- =============================================================
