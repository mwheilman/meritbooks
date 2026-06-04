-- Migration 030: Payment lifecycle — AP settlement sub-ledger (GATE 2 — Session 21)
-- =============================================================
-- Closes Session-20 audit gaps 1–3 on the AP side:
--   gap 1: paying a bill posted NO GL entry (AP never cleared, cash never reduced)
--   gap 2: voiding an approved bill did NOT reverse its GL entry
--   gap 3: a bank-feed line that pays an existing bill was re-expensed (double count)
--
-- The fix needs a place to record each payment against a bill (partial payments,
-- multiple payments, each its own reversible GL entry, optional link to the bank
-- line that settled it). `bill_payments` is that sub-ledger. The AR side already
-- has customer_payments + payment_applications (migration 008); this migration
-- only adds the AP-side table and the matched-bill FK.
--
-- ADDITIVE + idempotent. Requires 005 (bills, bank_transactions), 019 (core carve).
-- Next migration number after this: 031.
-- =============================================================

-- ---- Guard ----
do $$ begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'bills') then
    raise exception 'public.bills not found — deploy migration 005 before 030.';
  end if;
end $$;

-- =============================================================
-- 1. BILL PAYMENTS (AP settlement sub-ledger)
-- =============================================================
create table if not exists public.bill_payments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  location_id uuid not null references core.locations(id),

  amount_cents bigint not null check (amount_cents > 0),
  payment_date date not null,
  method text,                        -- CHECK / ACH / WIRE / CREDIT_CARD / CASH / OTHER
  rail text,                          -- the payment rail used (posting engine vocab)

  -- the GL cash-side account credited (bank) or liability increased (credit card)
  cash_account_id uuid references public.accounts(id),
  -- when the payment was identified from the bank feed, the line that settled it
  bank_transaction_id uuid references public.bank_transactions(id),

  -- the DR AP / CR cash entry this payment posted
  gl_entry_id uuid references public.gl_entries(id),

  status text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  -- actor captured as TEXT here (Clerk ids don't cast to the uuid GL author cols)
  created_by text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bill_payments_org on public.bill_payments(org_id);
create index if not exists idx_bill_payments_bill on public.bill_payments(bill_id);
create index if not exists idx_bill_payments_bank_txn on public.bill_payments(bank_transaction_id)
  where bank_transaction_id is not null;

alter table public.bill_payments enable row level security;
do $$ begin
  create policy "org_isolation" on public.bill_payments
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_bill_payments_updated before update on public.bill_payments
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================
-- 2. Ensure bank_transactions.matched_bill_id references bills
-- =============================================================
-- migration 005 created the column with the FK deferred ("FK added after bills
-- table"). Add it now if it isn't already present.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'bank_transactions'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%matched_bill_id%references%bills%'
  ) then
    begin
      alter table public.bank_transactions
        add constraint bank_transactions_matched_bill_fk
        foreign key (matched_bill_id) references public.bills(id);
    exception when others then
      raise notice 'Skipped matched_bill_id FK (%).', sqlerrm;
    end;
  end if;
end $$;

-- =============================================================
-- DONE. AP settlement sub-ledger in place. The lifecycle service posts the
-- DR AP / CR cash entry, records the payment here, and clears the bill balance.
-- =============================================================
