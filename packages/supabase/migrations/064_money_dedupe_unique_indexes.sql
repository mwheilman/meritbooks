-- Migration 064: money dedupe unique indexes
-- Structurally close the double-post window on the Stripe money loop (security audit HIGH-1,
-- 2026-08-01). Payment/GL idempotency was check-then-insert against a non-unique source_ref
-- index and an unconstrained customer_payments.reference_number; if Stripe ever emits two
-- distinct event ids for the same PaymentIntent concurrently, both could pass the check-then-
-- insert race and double-post the AR_COLLECTION JE / double-apply the payment. These partial
-- unique indexes make the DB the guarantor: the concurrent loser fails on insert and the
-- retry reuses the existing row. Partial (WHERE NOT NULL) so rows without these keys are
-- unaffected. Applied to Supabase first (2026-08-01), then committed.

create unique index if not exists uq_gl_entries_org_source_type
  on public.gl_entries (org_id, source_ref, entry_type)
  where source_ref is not null;

create unique index if not exists uq_customer_payments_org_reference
  on public.customer_payments (org_id, reference_number)
  where reference_number is not null;
