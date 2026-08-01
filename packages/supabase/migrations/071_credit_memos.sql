-- Migration 071: credit memos (invoice-depth, FPB-invoices Wave B)
-- A customer AR credit that reduces an invoice balance or stands alone. Books owns the
-- credit-memo number. Posts DR contra-revenue/revenue / CR AR on approval (the rev-rec-managed
-- reversal follows the same account resolution as the invoice). Money bigint cents; RLS
-- org_isolation. Applied to Supabase first (2026-08-01), then committed.

create table if not exists public.credit_memos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid,
  customer_id uuid,
  invoice_id uuid references public.invoices(id) on delete set null,
  credit_number text,
  credit_date date not null default current_date,
  memo text,
  reason text,
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  applied_amount_cents bigint not null default 0,
  status text not null default 'DRAFT'
    check (status in ('DRAFT','POSTED','APPLIED','VOIDED')),
  gl_entry_id uuid,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_memo_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  credit_memo_id uuid not null references public.credit_memos(id) on delete cascade,
  account_id uuid,
  description text,
  amount_cents bigint not null default 0,
  department_id uuid,
  class_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_credit_memos_org on public.credit_memos(org_id);
create index if not exists idx_credit_memos_invoice on public.credit_memos(invoice_id) where invoice_id is not null;
create index if not exists idx_credit_memos_customer on public.credit_memos(org_id, customer_id);
create index if not exists idx_credit_memo_lines_memo on public.credit_memo_lines(credit_memo_id);
create index if not exists idx_credit_memo_lines_org on public.credit_memo_lines(org_id);

alter table public.credit_memos enable row level security;
alter table public.credit_memo_lines enable row level security;
create policy org_isolation on public.credit_memos for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
create policy org_isolation on public.credit_memo_lines for all
  using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
