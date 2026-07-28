-- =============================================================================
-- Migration 056: external source reference on gl_entries
-- =============================================================================
-- gl_entries.source_id is uuid, for INTERNAL references (a bill id, an invoice
-- id). The money-movement posting layer (AR/AP/payroll/platform-fee) records the
-- external processor's id — a Stripe PaymentIntent ('pi_...'), a Stripe Payout
-- ('po_...'), a Plaid transaction — which are STRINGS, not uuids. Every one of
-- those postings passed the processor id into the uuid column and failed at the
-- insert with:
--
--   invalid input syntax for type uuid: "pi_3TyA4G38zHdzXKGT1NTIK2bb"
--
-- This was the second latent break in the money-movement layer (the first was
-- the missing entry_type enum values, migration 055). Both were masked until the
-- first real payment completed the webhook chain on 2026-07-28.
--
-- source_ref is the text column for external references. source_id stays uuid for
-- internal ones. gl-posting.ts also now guards: any source_id that is not a valid
-- uuid is rerouted to source_ref rather than crashing, so this bug class cannot
-- recur even if a caller passes the wrong field.
-- =============================================================================

alter table public.gl_entries
  add column if not exists source_ref text;

comment on column public.gl_entries.source_ref is
  'External/string source reference: Stripe PaymentIntent/Payout id, Plaid txn id, etc. source_id (uuid) is for internal references only.';

-- Traceability: find the journal entry for a given processor id.
create index if not exists idx_gl_entries_source_ref
  on public.gl_entries (source_ref)
  where source_ref is not null;
