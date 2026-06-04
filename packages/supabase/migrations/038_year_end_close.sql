-- Migration 038: Year-end close (temporary accounts -> retained earnings) — Session 22
-- =============================================================
-- The last Step-2 gap. At fiscal year-end, every temporary (P&L) account —
-- REVENUE, COGS, OPEX, OTHER — is zeroed and its balance rolled into Retained
-- Earnings (role RETAINED_EARNINGS / 3020), so the new year starts the P&L at
-- zero and prior-year profit lands in equity. Closing is PER ENTITY (each
-- core.locations row keeps its own books + periods + retained earnings), dated
-- the last day of the fiscal year, as a single entry_type = 'CLOSING' entry.
--
-- The closing entry math (net = Σdebit − Σcredit per P&L account over the year):
--   revenue accounts (credit-normal, net < 0)  -> DR to zero
--   expense accounts (debit-normal,  net > 0)  -> CR to zero
--   offset:  CR Retained Earnings (net income)  /  DR Retained Earnings (net loss)
-- which balances and moves net income to equity.
--
-- This table records each close so it is idempotent (one active close per
-- entity-year), auditable, and reversible (void the entry, mark REVERSED, re-run
-- after late adjustments). The closing JE itself lives in gl_entries.
--
-- Additive + idempotent. Requires 004 (GL + fiscal_periods), 019 (core carve),
-- 029 (account roles). Next migration number: 039.
-- =============================================================

-- ---- Guard ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'locations') then
    raise exception 'core.locations not found — deploy migration 019 before 038.';
  end if;
end $$;

create table if not exists public.year_end_closes (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  fiscal_year int not null,
  close_date date not null,                          -- last day of the fiscal year
  gl_entry_id uuid references public.gl_entries(id), -- the CLOSING entry
  revenue_cents bigint not null default 0,
  expense_cents bigint not null default 0,
  net_income_cents bigint not null default 0,        -- revenue − expense
  status text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  created_by_user text,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by_user text,
  reverse_reason text
);

-- One ACTIVE close per entity-year (a reversed close frees the slot to re-run).
create unique index if not exists uq_year_end_close_active
  on public.year_end_closes(org_id, location_id, fiscal_year)
  where status = 'POSTED';

create index if not exists idx_year_end_closes_lookup
  on public.year_end_closes(org_id, fiscal_year);

alter table public.year_end_closes enable row level security;
do $$ begin
  create policy "org_isolation" on public.year_end_closes
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.year_end_closes
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Year-end close is recorded here; the closing entry lives in gl_entries
-- with entry_type = 'CLOSING'.
-- =============================================================
