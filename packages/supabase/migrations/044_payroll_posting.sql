-- =============================================================================
-- Migration 044: Payroll posting roles + Garnishments Payable (GATE 12.3 prep)
-- =============================================================================
-- Ledger-side foundation for posting a payroll run from a provider receipt. No
-- provider needed: roles + the one missing liability account.
--
--   1. Payroll posting role keys in core.account_role_keys
--   2. Garnishments Payable (2270) — the child-support / garnishment withholding
--      liability the standard COA lacks — seeded into each existing org's Payroll
--      Liabilities group (cloned from that org's 2200 Federal Payroll Tax Payable
--      account, guaranteed present and correctly classified). New tenants get it
--      from the COA template (packages/shared chart-of-accounts.ts).
--
-- Net pay clears through PAYMENTS_IN_TRANSIT (migration 043). Tax/benefit
-- liabilities reuse existing COA accounts: 2200/2210/2220 (taxes), 2230 (health),
-- 2240 (401k), 2250 (workers comp); wage expense 6000; employer payroll tax
-- expense 6010. Idempotent. Money is bigint cents.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='account_role_keys') then
    raise exception 'core.account_role_keys not found — deploy migration 029 before 044.';
  end if;
end $$;

-- =============================================================================
-- 1. Payroll role keys
-- =============================================================================
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('WAGES_EXPENSE',            'Salaries & Wages (gross)',          'ORG', '6000'),
  ('PAYROLL_TAX_EXPENSE',      'Employer Payroll Taxes (expense)',  'ORG', '6010'),
  ('FEDERAL_TAX_PAYABLE',      'Federal Payroll Tax Payable',       'ORG', '2200'),
  ('STATE_TAX_PAYABLE',        'State Payroll Tax Payable',         'ORG', '2210'),
  ('FICA_PAYABLE',             'FICA Payable',                      'ORG', '2220'),
  ('HEALTH_INSURANCE_PAYABLE', 'Health Insurance Payable',          'ORG', '2230'),
  ('RETIREMENT_PAYABLE',       '401(k) Payable',                    'ORG', '2240'),
  ('WORKERS_COMP_PAYABLE',     'Workers Comp Payable',              'ORG', '2250'),
  ('GARNISHMENT_PAYABLE',      'Garnishments Payable',              'ORG', '2270')
on conflict (role_key) do nothing;

-- =============================================================================
-- 2. Seed Garnishments Payable (2270) for existing orgs (clone from 2200)
-- =============================================================================
do $$
declare
  r record;
begin
  for r in
    select a.org_id, a.account_group_id, a.account_type, a.account_sub_type
    from public.accounts a
    where a.account_number = '2200'
  loop
    insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active)
    select r.org_id, r.account_group_id, '2270', 'Garnishments Payable', r.account_type, r.account_sub_type, true
    where not exists (select 1 from public.accounts x where x.org_id = r.org_id and x.account_number = '2270');
  end loop;
end $$;

-- =============================================================================
-- 3. Verification
-- =============================================================================
do $$
begin
  raise notice 'Migration 044 OK: payroll roles +%, garnishments-payable seeded for % orgs',
    (select count(*) from core.account_role_keys where role_key in
      ('WAGES_EXPENSE','PAYROLL_TAX_EXPENSE','FEDERAL_TAX_PAYABLE','STATE_TAX_PAYABLE','FICA_PAYABLE',
       'HEALTH_INSURANCE_PAYABLE','RETIREMENT_PAYABLE','WORKERS_COMP_PAYABLE','GARNISHMENT_PAYABLE')),
    (select count(*) from public.accounts where account_number = '2270');
end $$;
