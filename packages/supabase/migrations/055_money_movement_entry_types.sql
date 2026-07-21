-- =============================================================================
-- Migration 055: money-movement entry types
-- =============================================================================
-- GATE 12 (migrations 043-045, 052) built AR collection, AP disbursement,
-- payroll, and platform-fee posting. Every one of those builders sets
-- gl_entries.entry_type to a domain-specific value:
--
--   AR_COLLECTION, AR_PAYOUT, AR_REFUND, PLATFORM_FEE, PAYROLL_RUN,
--   AP_DISBURSEMENT_RELEASE / _SETTLE / _RETURN / _VOID
--
-- entry_type is entry_type_enum, which contained only the six generic values:
--   STANDARD, ADJUSTING, CLOSING, REVERSING, RECURRING, SYSTEM
--
-- So EVERY money-movement post failed at the insert with
--   invalid input value for enum entry_type_enum: "AR_COLLECTION"
-- and the whole GATE 12 posting layer has never written a journal entry.
--
-- It went unnoticed because those modules were verified with DB-free balance
-- harnesses that exercise the pure entry builders. The arithmetic was correct;
-- the insert was impossible. Nothing tested the two together against a real
-- database until the first live card payment.
--
-- Found in production via the Stripe webhook error on 2026-07-20.
-- apps/web/src/test/schema.test.ts now asserts that every entry_type the code
-- posts exists in this enum, so a new posting module cannot reintroduce it.
-- =============================================================================

alter type entry_type_enum add value if not exists 'AR_COLLECTION';
alter type entry_type_enum add value if not exists 'AR_PAYOUT';
alter type entry_type_enum add value if not exists 'AR_REFUND';
alter type entry_type_enum add value if not exists 'PLATFORM_FEE';
alter type entry_type_enum add value if not exists 'PAYROLL_RUN';
alter type entry_type_enum add value if not exists 'AP_DISBURSEMENT_RELEASE';
alter type entry_type_enum add value if not exists 'AP_DISBURSEMENT_SETTLE';
alter type entry_type_enum add value if not exists 'AP_DISBURSEMENT_RETURN';
alter type entry_type_enum add value if not exists 'AP_DISBURSEMENT_VOID';
