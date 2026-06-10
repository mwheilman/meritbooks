-- ============================================================================
-- SEED_FISCAL_PERIODS.sql  (Session 25)
-- Run ONCE in the Supabase SQL editor.
--
-- WHY: posting (postJournalEntry) rejects any entry whose date has no matching
-- fiscal period for that (org, location): "No fiscal period found for date …".
-- Plaid sandbox transactions span many months, so approving a bank-feed item
-- failed for every date without a seeded period — that is the "failed to
-- approve transaction" you hit.
--
-- WHAT IT DOES: seeds OPEN monthly fiscal periods for EVERY active location of
-- the org across Jan 2024 → Dec 2026 (covers the sandbox date range). Idempotent
-- via the (org_id, location_id, period_year, period_month) unique key — re-runs
-- insert nothing new. Does NOT touch existing/closed periods.
--
-- NOTE: in production, period creation is a setup-wizard concern (suite contract
-- Rule F: periods are a product of setup, not auto-created at post time). This
-- seed is the test-tenant equivalent so the post loop works end-to-end now.
-- ============================================================================

do $$
declare
  v_org uuid;
  v_count int := 0;
begin
  select id into v_org from core.organizations order by created_at limit 1;
  if v_org is null then
    raise exception 'No organization found — nothing to seed.';
  end if;

  insert into fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
  select
    v_org,
    l.id,
    extract(year  from m)::int,
    extract(month from m)::int,
    date_trunc('month', m)::date,
    (date_trunc('month', m) + interval '1 month' - interval '1 day')::date,
    'OPEN'
  from core.locations l
  cross join generate_series(date '2024-01-01', date '2026-12-01', interval '1 month') as m
  where l.org_id = v_org
    and l.is_active = true
  on conflict (org_id, location_id, period_year, period_month) do nothing;

  get diagnostics v_count = row_count;
  raise notice 'Seeded % new fiscal period rows for org % (existing periods untouched).', v_count, v_org;
end $$;
