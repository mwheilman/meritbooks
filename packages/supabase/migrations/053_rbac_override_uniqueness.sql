-- =============================================================================
-- Migration 053: Restore the RBAC override uniqueness guarantees
-- =============================================================================
-- Migration 014 intended two uniqueness rules on role_permission_overrides but
-- expressed them as partial UNIQUE *constraints*:
--
--   CONSTRAINT unique_tier_override UNIQUE (org_id, role, feature_id)
--     WHERE employee_id IS NULL
--
-- Postgres has no such syntax — partial uniqueness must be a unique INDEX. That
-- statement is invalid in every Postgres version, so 014 never applied cleanly
-- and production ended up with the table but WITHOUT either uniqueness rule
-- (only the primary key on id, plus two non-unique lookup indexes named
-- idx_rpo_role / idx_rpo_employee rather than the names in the migration file).
--
-- Impact if left unfixed: nothing prevents two override rows with the same
-- (org_id, role, feature_id) — e.g. one granting action_approve and one denying
-- it. Permission resolution would then depend on row order, i.e. be
-- non-deterministic. RBAC enforcement is not yet built, and the table is
-- currently empty, so this is the moment to close the gap: before anything is
-- built on top of an unguaranteed key.
--
-- 014 has also been corrected in place so a fresh replay produces this same
-- shape. This migration brings the already-deployed database into line.
-- =============================================================================

-- Tier-level override: one per (org, role, feature) where no employee is set.
CREATE UNIQUE INDEX IF NOT EXISTS unique_tier_override
  ON public.role_permission_overrides (org_id, role, feature_id)
  WHERE employee_id IS NULL;

-- Individual-level override: one per (org, employee, feature).
CREATE UNIQUE INDEX IF NOT EXISTS unique_individual_override
  ON public.role_permission_overrides (org_id, employee_id, feature_id)
  WHERE employee_id IS NOT NULL;

-- The lookup indexes 014 specified. Production has equivalents under different
-- names (idx_rpo_role / idx_rpo_employee) created outside the migration; these
-- are the partial forms the file actually calls for. IF NOT EXISTS keeps this
-- safe to run repeatedly.
CREATE INDEX IF NOT EXISTS idx_role_perm_overrides_role
  ON public.role_permission_overrides (org_id, role)
  WHERE employee_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_role_perm_overrides_employee
  ON public.role_permission_overrides (org_id, employee_id)
  WHERE employee_id IS NOT NULL;
