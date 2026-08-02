-- =============================================================================
-- Migration 094: seed account-role vocabulary + accounts for tax / prepaid / intangible
-- =============================================================================
-- Completes the account-role registry so the ASC 740 provision, prepaid amortization,
-- intangible amortization, and (already-mapped) lease + disposal engines resolve their
-- GL accounts BY ROLE (canon §2/§3), not by hardcoded number. The app-side registry
-- (apps/web/src/lib/posting/account-roles.ts) declares these keys; this migration puts
-- them in the controlled vocabulary (core.account_role_keys), creates the four tax
-- accounts that the standard COA lacks, and re-seeds the per-tenant role→account map.
--
-- WHY NEW NON-COLLIDING NUMBERS: the provision service's old number fallbacks 2260 and
-- 1700 collide with real standard-COA accounts (2260 = Accrued Wages, 1700 = Goodwill).
-- Income-taxes-payable and the deferred-tax-asset therefore get fresh numbers 2280 /
-- 1750 so a role miss can never silently post income tax to Accrued Wages or the DTA to
-- Goodwill. 1330 (Prepaid), 1710 (Intangible cost) and 1720 (Accum amortization) already
-- exist in the standard COA and only need the role mapping.
--
-- ADDITIVE + idempotent (on conflict / not exists / re-seed). Roles ROU_ASSET,
-- LEASE_LIABILITY (mig 082) and GAIN_ON_DISPOSAL, LOSS_ON_DISPOSAL (mig 079) are already
-- in the vocab and unaffected. Books band; next number: 095.
-- =============================================================================

-- 1) Register the new role keys (controlled vocabulary).
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('INCOME_TAX_EXPENSE',       'Income tax expense (ASC 740)',      'ORG', '8100'),
  ('INCOME_TAXES_PAYABLE',     'Income taxes payable',              'ORG', '2280'),
  ('DEFERRED_TAX_ASSET',       'Deferred tax asset',                'ORG', '1750'),
  ('DEFERRED_TAX_LIABILITY',   'Deferred tax liability',            'ORG', '2700'),
  ('PREPAID_ASSET',            'Prepaid expenses (asset)',          'ORG', '1330'),
  ('INTANGIBLE_ASSET',         'Finite-lived intangible (cost)',    'ORG', '1710'),
  ('ACCUMULATED_AMORTIZATION', 'Accumulated amortization (contra)', 'ORG', '1720')
on conflict (role_key) do update
  set label = excluded.label, scope = excluded.scope,
      default_account_number = excluded.default_account_number;

-- 2) Create the 4 tax accounts that DON'T exist in the standard COA (per org, borrowing
--    an existing sibling account's group). 1330/1710/1720 already exist.
insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '8100', 'Income Tax Expense', 'OTHER', 'OTHER_EXPENSE', true, 'APPROVED', 10
from public.accounts a where a.account_number = '8030'
  and not exists (select 1 from public.accounts x where x.org_id = a.org_id and x.account_number = '8100');

insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '2280', 'Income Taxes Payable', 'LIABILITY', 'CURRENT_LIABILITY', true, 'APPROVED', 10
from public.accounts a where a.account_number = '2400'
  and not exists (select 1 from public.accounts x where x.org_id = a.org_id and x.account_number = '2280');

insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '1750', 'Deferred Tax Asset', 'ASSET', 'OTHER_ASSET', true, 'APPROVED', 10
from public.accounts a where a.account_number = '1700'
  and not exists (select 1 from public.accounts x where x.org_id = a.org_id and x.account_number = '1750');

insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '2700', 'Deferred Tax Liability', 'LIABILITY', 'LONG_TERM_LIABILITY', true, 'APPROVED', 10
from public.accounts a where a.account_number = '2540'
  and not exists (select 1 from public.accounts x where x.org_id = a.org_id and x.account_number = '2700');

-- 3) Re-seed the role→account mapping for every org (idempotent; preserves overrides).
do $$ declare o record; begin
  for o in select id from core.organizations loop perform public.seed_account_roles(o.id); end loop;
end $$;
