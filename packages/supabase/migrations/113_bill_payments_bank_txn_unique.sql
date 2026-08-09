-- Migration 113: structural duplicate-money-out guarantor on the bank-feed settlement path.
--
-- The bank-feed approve path (apps/web/src/app/api/bank-feed/approve/route.ts) settles a
-- matched bill by calling recordBillPayment with bankTransactionId, guarded ONLY by a
-- non-atomic `if (txn.status === 'POSTED')` check-then-set. Two concurrent approvals of the
-- SAME bank transaction could both pass that check and double-post a bill payment (double
-- money-out), because the settlement link was backed only by a NON-unique partial index
-- (idx_bill_payments_bank_txn).
--
-- This partial UNIQUE index makes the DB the guarantor: a single bank transaction settles
-- AT MOST ONE bill payment. Partial (WHERE bank_transaction_id IS NOT NULL) so manually
-- recorded / AP disbursement-release payments (bank_transaction_id NULL) and legitimate
-- partial payments are unaffected. Additive + idempotent. Applied to Supabase first
-- (2026-08-09), then committed.
--
-- Complements migration 064 (money-IN unique indexes on gl_entries/customer_payments) and
-- the approvals.status compare-and-set (row-lock CAS) that already guards the AP
-- disbursement-release path (task #110). Together these make the database — not an
-- app-level check — the guarantor against duplicate money movement on every settlement path.

create unique index if not exists uq_bill_payments_org_bank_txn
  on public.bill_payments (org_id, bank_transaction_id)
  where bank_transaction_id is not null;

-- Retire the now-redundant non-unique partial index it supersedes (same predicate + column).
drop index if exists public.idx_bill_payments_bank_txn;
