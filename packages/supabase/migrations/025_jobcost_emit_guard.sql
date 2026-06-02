-- Migration 025: emit-side idempotency guard for JOB_COST events (Session 15)
--
-- Defense-in-depth on top of the Projects consumer's existing protections
-- (event_id dedupe + source_ref cost identity via proj.job_cost_applied_events):
-- prevent more than one PENDING JOB_COST event for the same logical cost +
-- lifecycle from ever existing on the queue.
--
-- Why now: today nothing auto-fires JOB_COST (only the sandbox round-trip, which
-- uses a distinct source_ref per run). Once AUTOMATIC cost emission is wired
-- (AP / bank-feed / payroll), a double-fire becomes a live risk rather than a
-- theoretical one, so the guard belongs in place before that.
--
-- Identity = (org_id, source_ref, lifecycle), scoped to status='pending' and
-- event_type='JOB_COST'. The scope to 'pending' is deliberate: a cleared /
-- processed / rejected row must NOT block a later, legitimately new pending
-- event that happens to share a source_ref + lifecycle.
--
-- source_ref and lifecycle live inside the payload jsonb, so the index keys on
-- the extracted expressions. Under a unique index NULLs are distinct, which is
-- safe here: only JOB_COST carries a lifecycle, and the partial WHERE already
-- restricts the index to JOB_COST rows, so JOB_PROGRESS / JOB_BILLING events are
-- entirely unaffected.
--
-- Additive and non-destructive: creates one partial unique index, no data change.

create unique index if not exists uq_core_events_pending_jobcost_identity
  on core.events (
    org_id,
    (payload->>'source_ref'),
    (payload->>'lifecycle')
  )
  where status = 'pending' and event_type = 'JOB_COST';
