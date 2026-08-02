-- =============================================================================
-- Migration 099: Bank Reconciliation Wave B — authorized must-tie override columns
-- =============================================================================
-- Wave B lets a money-authorized human finalize a reconciliation that does not tie
-- to $0 by recording an explicit, audited override + the accepted variance (the
-- "plug" is DOCUMENTED, never posted to the GL). Additive to migration 007's
-- bank_reconciliations (which already has is_reconciled/reconciled_at/reconciled_by).
-- The app probes for these columns and degrades SAFE (override UI unavailable, normal
-- must-tie finalize unaffected) until applied. Books band; next number: 100.
-- =============================================================================

alter table public.bank_reconciliations
  add column if not exists finalized_via_override            boolean not null default false,
  add column if not exists finalize_override_reason          text,
  add column if not exists finalize_override_variance_cents  bigint;
