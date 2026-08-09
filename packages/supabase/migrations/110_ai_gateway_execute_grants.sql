-- Migration 110: Grant EXECUTE on the Core AI-gateway RPCs to authenticated
-- =============================================================================
-- Bug: uploading a document (drop-and-parse: W-9/COI, covenants, prepaids, leases,
-- debt, subscriptions, insurance, payroll, fixed-asset invoice, bank statements,
-- contracts) failed with:
--
--     permission denied for function ai_bump_rate
--
-- Root cause: every drop-and-parse route runs its file through the Core AI gateway
-- (`runAiGateway`). The gateway's FIRST runaway guard calls `core.ai_bump_rate(...)`
-- (and later `core.ai_concurrency_acquire/release` + `core.ai_increment_counter`).
-- Those routes build their gateway `deps.supabase` from `requireAuthedContext()`,
-- i.e. the RLS-scoped **authenticated** client (NOT the service-role client the
-- store.ts header comment assumes). Migration 027 *intended* to grant EXECUTE on
-- these four functions to `authenticated`, but on the live database the grant is
-- absent (only `service_role` holds EXECUTE — verified via has_function_privilege).
-- The result: the very first gateway call by an authenticated user is rejected by
-- Postgres before any AI work happens, so the whole upload/parse fails.
--
-- Fix: (re)grant EXECUTE on all four gateway RPCs to `authenticated` (and re-assert
-- `service_role` + `anon` to match 027's intent). These functions are already
-- SECURITY DEFINER with a pinned `search_path = core, public`, so they safely
-- mutate the shared Core counters/buckets regardless of the caller's RLS scope —
-- granting EXECUTE to authenticated is the correct, sufficient, and safe fix.
--
-- Idempotent. `authenticated` already has USAGE on schema `core` (verified), so no
-- schema grant is required.
-- =============================================================================

grant execute on function
  core.ai_bump_rate(uuid, text, text),
  core.ai_increment_counter(uuid, date, text, text, bigint),
  core.ai_concurrency_acquire(uuid, int, int, uuid),
  core.ai_concurrency_release(uuid)
to authenticated, service_role, anon;

-- End migration 110.
