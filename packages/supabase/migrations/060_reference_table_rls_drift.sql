-- =============================================================================
-- Migration 060: capture RLS on global reference tables (file drift fix)
-- =============================================================================
-- core.account_role_keys and core.transaction_types are global reference catalogs
-- (no org_id — the standard COA role-key set and the transaction-type definitions,
-- shared across all tenants). Production has RLS enabled on both with the correct
-- policies, but the MIGRATION FILES never captured it — the RLS was applied to
-- prod out-of-band, so a fresh replay (or a new environment) would come up INSECURE.
-- The RLS schema test caught this drift.
--
-- This migration records the production posture in code so files == prod and any
-- new environment is secure by default. Idempotent (IF NOT EXISTS) — a no-op
-- against production, which already has these.
--
-- Policy (matches prod): read_all (SELECT, public — non-sensitive catalog data)
-- + service_write (ALL, service_role only).
-- =============================================================================

alter table core.account_role_keys  enable row level security;
alter table core.transaction_types  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='account_role_keys' and policyname='read_all') then
    create policy "read_all" on core.account_role_keys for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='account_role_keys' and policyname='service_write') then
    create policy "service_write" on core.account_role_keys for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='transaction_types' and policyname='read_all') then
    create policy "read_all" on core.transaction_types for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='transaction_types' and policyname='service_write') then
    create policy "service_write" on core.transaction_types for all to service_role using (true) with check (true);
  end if;
end $$;
