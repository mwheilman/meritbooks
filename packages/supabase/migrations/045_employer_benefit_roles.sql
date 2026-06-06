-- =============================================================================
-- Migration 045: Employer-benefit expense roles (GATE 12.3 refinement)
-- =============================================================================
-- Lets a payroll run post employer benefit *contributions* (employer health,
-- 401(k) match, workers comp) to their expense accounts. No new accounts: these
-- map to existing COA expense accounts 6020 / 6030 / 6040. Idempotent.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='account_role_keys') then
    raise exception 'core.account_role_keys not found — deploy migration 029 before 045.';
  end if;
end $$;

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('HEALTH_INSURANCE_EXPENSE', 'Employer Health Insurance (expense)', 'ORG', '6020'),
  ('RETIREMENT_MATCH_EXPENSE', 'Employer 401(k) Match (expense)',     'ORG', '6030'),
  ('WORKERS_COMP_EXPENSE',     'Workers Compensation (expense)',      'ORG', '6040')
on conflict (role_key) do nothing;

do $$
begin
  raise notice 'Migration 045 OK: employer-benefit expense roles +%',
    (select count(*) from core.account_role_keys where role_key in
      ('HEALTH_INSURANCE_EXPENSE','RETIREMENT_MATCH_EXPENSE','WORKERS_COMP_EXPENSE'));
end $$;
