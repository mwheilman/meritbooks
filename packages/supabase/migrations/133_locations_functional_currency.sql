-- =============================================================================
-- Migration 133: per-entity functional currency (GATE 11a — consolidation FX)
-- =============================================================================
-- Activates the (already-built) foreign-currency TRANSLATION path in the
-- consolidation engine. Migration 089 shipped the fx_rates reference table and the
-- pure current-rate translation engine (lib/consolidation/fx.ts), but left a
-- reserved-spine follow-up: core.locations had no `functional_currency`, so every
-- entity was treated as already in the group reporting currency and translation
-- never fired (single-currency only). This adds that column.
--
-- Semantics: `functional_currency` is the currency an entity keeps its books in
-- (ASC 830 functional currency). NULL = "same as the group reporting currency"
-- (core.organizations.home_currency) — the single-currency default, so this change
-- is a pure no-op for existing tenants until a currency is assigned. When an
-- entity's functional currency differs from the reporting currency, the engine
-- translates its trial balance: P&L at the AVERAGE rate, ASSET/LIABILITY at the
-- CLOSING rate, EQUITY at the HISTORICAL rate, with the residual booked to a
-- Cumulative Translation Adjustment (CTA) in equity so the statement still ties.
--
-- Additive + idempotent. RLS already governs core.locations. Generic + tenant-owned:
-- never hardcodes a currency. Requires 019 (core carve). Books band; next: 134.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'locations') then
    raise exception 'core.locations not found — deploy migration 019 (core carve) before 133.';
  end if;
end $$;

alter table core.locations
  add column if not exists functional_currency text;

-- Optional 3-letter ISO-4217-style code; NULL = reporting (home) currency. Kept as
-- free text (like fx_rates.from_currency) so the tenant defines its own currency set.
do $$ begin
  alter table core.locations
    add constraint chk_locations_functional_currency_len
    check (functional_currency is null or char_length(functional_currency) = 3);
exception when duplicate_object then null; end $$;

comment on column core.locations.functional_currency is
  'ASC 830 functional currency (3-letter code) this entity keeps its books in. '
  'NULL = same as the group reporting currency (core.organizations.home_currency). '
  'When it differs, the consolidation engine translates this entity into the reporting '
  'currency (P&L at average, balance sheet at closing, equity at historical) with a CTA plug.';

-- =============================================================================
-- DONE. Entities can now carry a functional currency; the consolidation engine's
-- translation path activates automatically for any entity whose functional currency
-- differs from the reporting currency. Absent an assignment (NULL), behavior is
-- byte-for-byte the prior single-currency consolidation.
-- =============================================================================
