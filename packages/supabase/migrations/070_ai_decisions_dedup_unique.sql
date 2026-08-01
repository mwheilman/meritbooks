-- Migration 070: dedup unique index on open Financial-Control exceptions (security audit LOW)
-- The detectors (EC-1/EC-3/EC-4/EC-10) dedupe in-app (read-then-insert), so two concurrent
-- scans could double-insert the same open exception. This partial unique index makes the DB the
-- guarantor: at most one OPEN (PROPOSED) exception per (org, feature, dedup_key). Resolved
-- (APPROVED/REJECTED) rows are exempt so a dismissed exception can legitimately recur later.
-- Applied to Supabase first (2026-08-01), then committed.
create unique index if not exists uq_ai_decisions_open_dedup
  on public.ai_decisions (org_id, feature, (proposed_output->>'dedup_key'))
  where status = 'PROPOSED' and (proposed_output->>'dedup_key') is not null;
