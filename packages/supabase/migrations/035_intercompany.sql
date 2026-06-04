-- Migration 035: Intercompany due-to/due-from + consolidation pairing (Session 22)
-- =============================================================
-- Cross-ENTITY intercompany at the legal-entity (core.locations) level — the
-- top gap from the Session 21 audit (master XI.8 §2) and the core PE/holding-
-- company value. This is the entity-level analogue of the inter-DEPARTMENT
-- elimination already built (migration 015): there, counterparty_department_id
-- + is_eliminating accounts net at the company roll-up; here, an intercompany
-- transaction between two entities books a balanced entry ON EACH ENTITY'S BOOKS
-- (each respects its own fiscal period), tagged with counterparty_location_id,
-- using the Intercompany Receivable (role INTERCOMPANY_AR / 1160) and
-- Intercompany Payable (role INTERCOMPANY_AP / 2020) accounts seeded in 029.
-- The two sides always net to zero across the consolidation group.
--
-- Additive + idempotent. Requires 019 (core carve), 029 (entity hierarchy +
-- account roles + transaction-type catalog). Next migration number: 036.
-- =============================================================

-- ---- Guard ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'locations') then
    raise exception 'core.locations not found — deploy migration 019 before 035.';
  end if;
end $$;

-- =============================================================
-- 1. COUNTERPARTY ENTITY on GL lines (elimination pairing)
-- =============================================================
-- Mirrors counterparty_department_id (015) at the entity level. An intercompany
-- line records which other entity it faces, so consolidation can pair and
-- eliminate reciprocal balances at any node of the entity tree.
alter table public.gl_entry_lines
  add column if not exists counterparty_location_id uuid references core.locations(id);

create index if not exists idx_gl_lines_counterparty_loc
  on public.gl_entry_lines(counterparty_location_id)
  where counterparty_location_id is not null;

-- =============================================================
-- 2. REGISTER the intercompany transaction type
-- =============================================================
insert into core.transaction_types (code, label, category, lifecycle, is_reserved, display_order)
values ('intercompany_transfer', 'Intercompany transfer (due-to/due-from)', 'INTERNAL', 'SYSTEM', false, 111)
on conflict (code) do update
  set label = excluded.label,
      category = excluded.category,
      lifecycle = excluded.lifecycle,
      is_reserved = excluded.is_reserved,
      display_order = excluded.display_order;

-- =============================================================
-- 3. INTERCOMPANY TRANSACTIONS (parent linking the two per-entity entries)
-- =============================================================
-- nature:
--   FUNDING            from entity sends cash to the to entity (a loan/advance)
--   EXPENSE_ON_BEHALF  from entity pays a third-party cost belonging to the to entity
--   REPAYMENT          to entity repays the from entity (relieves the due-to/due-from)
create table if not exists public.intercompany_transactions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  ic_number text not null,
  nature text not null check (nature in ('FUNDING', 'EXPENSE_ON_BEHALF', 'REPAYMENT')),
  transaction_date date not null,
  from_location_id uuid not null references core.locations(id),
  to_location_id uuid not null references core.locations(id),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD',
  -- EXPENSE_ON_BEHALF only: the expense account booked on the receiving entity.
  expense_account_id uuid references public.accounts(id),
  memo text,
  -- The two posted GL entries (one per entity). Null only mid-creation.
  from_entry_id uuid references public.gl_entries(id),
  to_entry_id uuid references public.gl_entries(id),
  status text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  created_by uuid,                      -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  constraint chk_ic_distinct_entities check (from_location_id <> to_location_id),
  unique (org_id, ic_number)
);

create index if not exists idx_ic_txn_org  on public.intercompany_transactions(org_id, status);
create index if not exists idx_ic_txn_pair on public.intercompany_transactions(org_id, from_location_id, to_location_id);
create index if not exists idx_ic_txn_date on public.intercompany_transactions(org_id, transaction_date);

alter table public.intercompany_transactions enable row level security;
do $$ begin
  create policy "org_isolation" on public.intercompany_transactions
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.intercompany_transactions
  to anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    -- table has no updated_at; skip. (Left as a guard for future-proofing.)
    null;
  end if;
end $$;

-- =============================================================
-- DONE. Entities can now record intercompany due-to/due-from positions that
-- net to zero on consolidation. Posting service + API + UI ship with this.
-- =============================================================
