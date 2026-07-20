-- =============================================================================
-- Migration 054: PAY_PROCESSING invoice event
-- =============================================================================
-- ACH payments do not confirm instantly. Stripe holds them in `processing` for
-- 1-2 business days before emitting payment_intent.succeeded. Until now the
-- issuer had no way to see that a payment was in flight: the invoice sat at SENT
-- exactly as if the customer had done nothing, so "did they pay?" was
-- unanswerable from inside the product.
--
-- payment_intent.processing gives us that signal, but invoice_events.event_type
-- is a CHECK-constrained vocabulary (migration 050) that has no value for it, so
-- recording one would be rejected. This widens the vocabulary by exactly one
-- value.
--
-- PAY_PROCESSING sits between PAY_INITIATED (customer pressed pay) and
-- PAY_SUCCEEDED (funds confirmed). It is informational only: it does NOT change
-- invoice status or post to the GL, because the money has not settled. The
-- ledger still moves only on payment_intent.succeeded.
-- =============================================================================

alter table public.invoice_events
  drop constraint if exists invoice_events_event_type_check;

alter table public.invoice_events
  add constraint invoice_events_event_type_check
  check (event_type in (
    'CREATED','POSTED','EDITED','SENT','DELIVERED','VIEWED',
    'PAY_INITIATED','PAY_PROCESSING','PAY_SUCCEEDED','PAY_FAILED','FUNDS_SETTLED',
    'PAYMENT_APPLIED','REMINDER_SENT','MARKED_PAID','REFUNDED',
    'VOIDED','CREDITED','WRITTEN_OFF'));
