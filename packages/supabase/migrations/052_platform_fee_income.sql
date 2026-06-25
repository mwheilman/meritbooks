-- =============================================================================
-- Migration 052: Platform fee income (Merit-as-platform-operator)
-- =============================================================================
-- Registers the PLATFORM_FEE_INCOME role and seeds a "4910 Payment Processing
-- Income" revenue account for every org that has a chart of accounts. The
-- platform operator org books application-fee income here; PAYMENTS_IN_TRANSIT
-- (1096) and MERCHANT_FEE_EXPENSE (6630) from migration 043 are reused for the
-- net-in-transit and Stripe-cost legs. Idempotent.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='account_role_keys') then
    raise exception 'core.account_role_keys not found — deploy migration 029 before 052.';
  end if;
end $$;

-- 1. Role key
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('PLATFORM_FEE_INCOME', 'Payment Processing Income (platform application fees)', 'ORG', '4910')
on conflict (role_key) do nothing;

-- 2. Seed 4910 for every org, cloning classification from an existing REVENUE
--    account so it lands in the right group/type/sub-type. Orgs with no revenue
--    account yet are skipped (they get 4910 when their COA template is seeded).
do $$
declare
  r record;
begin
  for r in
    select distinct on (a.org_id)
      a.org_id, a.account_group_id, a.account_type, a.account_sub_type
    from public.accounts a
    where a.account_type = 'REVENUE'
    order by a.org_id, a.account_number
  loop
    insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active)
    select r.org_id, r.account_group_id, '4910', 'Payment Processing Income', r.account_type, r.account_sub_type, true
    where not exists (select 1 from public.accounts x where x.org_id = r.org_id and x.account_number = '4910');
  end loop;
end $$;

-- 3. Verification
do $$
begin
  raise notice 'Migration 052 OK: PLATFORM_FEE_INCOME role=%, 4910 accounts=%',
    (select count(*) from core.account_role_keys where role_key = 'PLATFORM_FEE_INCOME'),
    (select count(*) from public.accounts where account_number = '4910');
end $$;
