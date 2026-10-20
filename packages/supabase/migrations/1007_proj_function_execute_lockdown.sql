-- ============================================================================
-- 1007 · SECURITY hotfix — proj function EXECUTE lockdown
--
-- Finding (Oct 20 2026 schema review, verified live): `proj` is exposed through
-- PostgREST (pgrst.db_schemas) and every proj function carried the Postgres
-- default `EXECUTE TO PUBLIC`, so `anon` could call SECURITY DEFINER functions.
-- Several internal helpers have no org guard (emit_job_progress, drain_job_costs,
-- next_doc_number, materialize_time_cost, reconcile_billing_requests,
-- close_eligible, draw_precondition_met, job_cap) — an unauthenticated caller
-- could inject JOB_PROGRESS into another tenant's core.events stream.
--
-- Fix: revoke EXECUTE from PUBLIC/anon on every proj function; re-grant to
-- `authenticated` ONLY the org-scoped mutators the app calls via RPC (1004/1006)
-- and the helpers referenced by security_invoker views. Internal helpers stay
-- callable from inside the SECURITY DEFINER mutators (they run as owner) and by
-- service_role (cron/worker drains). Future proj functions default to no PUBLIC.
-- Idempotent.
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'proj'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;

  -- org-scoped mutators called by apps/projects via supabase.rpc (1004/1006)
  -- + read helpers referenced by security_invoker views (v_commitment_status,
  --   v_job_operational_cost, v_commitment_payment_eligibility)
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'proj'
      and p.proname in (
        'activate_sov_version','advance_external_gate','approve_and_emit_billing',
        'approve_commitment','generate_sov_billing','release_retainage',
        'approve_change_order','set_contract','update_progress',
        'books_present','payment_eligible'
      )
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

alter default privileges in schema proj revoke execute on functions from public;
alter default privileges in schema proj revoke execute on functions from anon;
