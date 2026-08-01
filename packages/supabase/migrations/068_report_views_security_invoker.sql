-- Migration 066: force security_invoker on all public views (security audit HIGH, 2026-08-01)
-- The reporting views (v_income_statement, v_balance_sheet, v_trial_balance, v_cash_position,
-- v_ap_aging, v_ar_aging, v_gl_detail, v_job_profitability, v_journal_entry_audit, etc.) had
-- security_invoker set only in the live DB, not in migration source. Views are owned by a
-- table-owner role that is RLS-exempt, so a view REBUILT from migrations (db reset / Supabase
-- branch / new-tenant provisioning) would run with DEFINER rights and BYPASS RLS — silently
-- reintroducing the cross-tenant leak the report-route RLS sweep (this session) just closed.
-- This makes the invoker semantics reproducible: every public view runs as the querying user,
-- so org_isolation RLS on the base tables governs. Idempotent; applied to Supabase first.

do $$
declare r record;
begin
  for r in
    select table_name
    from information_schema.views
    where table_schema = 'public'
  loop
    execute format('alter view public.%I set (security_invoker = true)', r.table_name);
  end loop;
end $$;
