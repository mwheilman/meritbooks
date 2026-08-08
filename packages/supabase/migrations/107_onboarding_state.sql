-- =============================================================================
-- Migration 107: core.organizations.onboarding_state — first-run wizard memory
-- =============================================================================
-- Per-step memory for the unified onboarding wizard: { currentStep, complete,
-- updatedAt }. Completion also writes the durable existing setup_complete flag, so
-- "finished onboarding" survives without this column; this just lets the wizard
-- REMEMBER which step to resume instead of re-deriving it from live GL counts.
-- Additive + idempotent. Degrade-safe (absent => step re-derived). core band.
-- =============================================================================

alter table core.organizations
  add column if not exists onboarding_state jsonb not null default '{}'::jsonb;
