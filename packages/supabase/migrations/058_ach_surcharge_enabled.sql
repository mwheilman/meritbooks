-- =============================================================================
-- Migration 058: ACH surcharge posture (Layer 2, symmetric with card)
-- =============================================================================
-- Layer 2 of the fee model: whether the MERCHANT passes the processing fee to
-- their own customer, or absorbs it. Migration 050 added card_surcharge_enabled
-- at every cascade level (entity/customer/job/invoice). ACH had no equivalent —
-- the intent route always absorbed ACH. This adds the symmetric ACH column so a
-- merchant can choose per customer and per invoice, exactly as they can for card.
--
-- Tri-state (boolean, nullable): true = pass to customer, false = absorb,
-- null = inherit from the next level up. Defaults (when nothing is set):
--   ACH  → absorbed  (null resolves to absorb)
--   card → pass-through (existing behaviour, unchanged)
-- The default asymmetry is intentional and lives in the resolver, not the column.
-- =============================================================================

alter table core.locations add column if not exists ach_surcharge_enabled boolean;
alter table core.customers add column if not exists ach_surcharge_enabled boolean;
alter table core.jobs      add column if not exists ach_surcharge_enabled boolean;
alter table public.invoices add column if not exists ach_surcharge_enabled boolean;
