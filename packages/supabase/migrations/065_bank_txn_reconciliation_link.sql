-- Migration 065: per-line bank reconciliation link (FPB-bank-reconciliation Wave A)
-- Today "cleared" is inferred at read-time (status='POSTED' && gl_entry_id). Without an
-- explicit per-line link there is no unreconcile/undo, no line-level reconciliation audit,
-- and no finalize-lock. These additive, nullable columns give each bank line a durable link
-- to the bank_reconciliations run that cleared it, plus when. Applied to Supabase first
-- (2026-08-01), then committed.

alter table public.bank_transactions
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation_id uuid
    references public.bank_reconciliations(id) on delete set null;

create index if not exists idx_bank_transactions_reconciliation
  on public.bank_transactions(reconciliation_id)
  where reconciliation_id is not null;
