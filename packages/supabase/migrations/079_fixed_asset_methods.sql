-- Migration 079: Fixed-asset depreciation methods + disposal account roles
-- =============================================================
-- The pure depreciation engine (lib/posting/depreciation-methods) already
-- implements 150% declining-balance, sum-of-years-digits, and units-of-production,
-- but they were NOT SELECTABLE: the shared `depreciation_method_enum` only carried
-- STRAIGHT_LINE / DOUBLE_DECLINING / MACRS_*. This migration:
--   1. adds the three missing BOOK methods to the enum so the UI + poster can use
--      them (the pure schedule is unchanged and already unit-tested);
--   2. adds the units-of-production tracking columns (total expected units + units
--      used-to-date) so a usage-based schedule can post;
--   3. registers the disposal gain/loss account ROLES so asset-disposal resolves
--      those accounts by role (like every other posting path) instead of the
--      hard-coded 7010/8010.
--
-- ADDITIVE + idempotent. Books band (next after 078). Requires 001 (enum),
-- 008 (fixed_assets), 029 (account_role_keys). DO NOT reorder. Apply to Supabase
-- FIRST, then the code that depends on it ships.
-- =============================================================

-- 1. New BOOK depreciation methods on the shared enum. ADD VALUE IF NOT EXISTS is
--    idempotent (precedent: migration 012). The new values are NOT used elsewhere
--    in this migration, so this is safe inside the migration's implicit txn.
alter type depreciation_method_enum add value if not exists 'DECLINING_150';
alter type depreciation_method_enum add value if not exists 'SUM_OF_YEARS_DIGITS';
alter type depreciation_method_enum add value if not exists 'UNITS_OF_PRODUCTION';

-- 2. Units-of-production tracking on fixed_assets. Units may be fractional (hours,
--    miles, cycles) so numeric — money stays bigint cents everywhere else.
--    total_expected_units is the lifetime usage estimate (the denominator);
--    units_used is the cumulative usage meter (the numerator, updated as the asset
--    is used). Both NULL/0 by default so existing time-based assets are unaffected.
alter table public.fixed_assets
  add column if not exists total_expected_units numeric(18,4),
  add column if not exists units_used numeric(18,4) not null default 0;

-- 3. Disposal gain/loss account roles (controlled vocabulary). Gain on disposal is
--    OTHER income, loss is OTHER expense. ORG-scoped (shared control accounts). The
--    default numbers match the values disposal previously hard-coded (7010 / 8010),
--    so tenants that already have those accounts resolve unchanged; a tenant can
--    remap either role on the Account Roles screen.
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('GAIN_ON_DISPOSAL', 'Gain on asset disposal', 'ORG', '7010'),
  ('LOSS_ON_DISPOSAL', 'Loss on asset disposal', 'ORG', '8010')
on conflict (role_key) do update
  set label = excluded.label,
      scope = excluded.scope,
      default_account_number = excluded.default_account_number;

-- =============================================================
-- DONE. 150%-DB / SYD / units-of-production are now selectable book methods;
-- fixed_assets carries the units-of-production meter; and GAIN_ON_DISPOSAL /
-- LOSS_ON_DISPOSAL are first-class roles resolvable per tenant/location.
-- NOTE for the COA seed template: ensure OTHER-type accounts 7010 (gain) and 8010
-- (loss) exist, or map the two roles explicitly, or disposal with a gain/loss will
-- refuse to post (by design — it never guesses an account).
-- =============================================================
