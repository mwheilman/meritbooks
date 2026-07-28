-- =============================================================================
-- Migration 059: enable RLS on core.merchant_fee_schedules
-- =============================================================================
-- Migration 057 shipped this table WITHOUT enabling row-level security. A table
-- in a PostgREST-exposed schema (core) with RLS off is reachable directly via the
-- public anon key, bypassing the app entirely. Supabase's security advisor flagged
-- it (rls_disabled_in_public). The table was empty at the time, so nothing was
-- exposed — but it held Layer-1 pricing (what MeritBooks charges each merchant),
-- which is sensitive commercial data.
--
-- Policy per the Payments/Fees FPB:
--   * org_read    — a merchant may SELECT its own schedule (know what it's charged)
--   * service_all — writes are service_role only; a merchant must NEVER price
--                   itself (Layer 1 is platform-admin config, set server-side)
--   * anon        — no access (RLS on, no matching policy, get_org_id() is null)
--
-- 057 has also been corrected in place so a fresh replay enables RLS. A schema
-- test now asserts every base table in public/core has RLS enabled, so this class
-- of miss fails the build instead of reaching production.
-- =============================================================================

alter table core.merchant_fee_schedules enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='merchant_fee_schedules' and policyname='org_read') then
    create policy "org_read" on core.merchant_fee_schedules
      for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='merchant_fee_schedules' and policyname='service_all') then
    create policy "service_all" on core.merchant_fee_schedules
      for all to service_role using (true) with check (true);
  end if;
end $$;
