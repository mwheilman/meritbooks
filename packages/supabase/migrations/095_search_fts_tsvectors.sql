-- =============================================================================
-- Migration 095: SEARCH lane (M13) — full-text tsvector columns + GIN indexes
-- =============================================================================
-- Powers lib/search: real lexical retrieval (Postgres FTS — stemming, prefix,
-- phrase) replacing the keyword-only .ilike scan. Each searchable table gets a
-- STORED generated tsvector (kept in lockstep with the row by Postgres) + a GIN
-- index. The app (lib/search/search-service.ts) DEGRADES SAFE: until these columns
-- exist it falls back to .ilike, so there is no window where search breaks.
-- Additive + idempotent. Source columns verified against the live schema (Rule 11).
-- Books band; next number: 096 (already applied: agent_runs).
-- =============================================================================

alter table public.gl_entries
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(entry_number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(memo, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(source_module, '')), 'C')
  ) stored;
create index if not exists idx_gl_entries_search_tsv on public.gl_entries using gin (search_tsv);

alter table public.bank_transactions
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(plaid_transaction_id, '')), 'D')
  ) stored;
create index if not exists idx_bank_txn_search_tsv on public.bank_transactions using gin (search_tsv);

alter table public.invoices
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(invoice_number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(memo, '')), 'B')
  ) stored;
create index if not exists idx_invoices_search_tsv on public.invoices using gin (search_tsv);

alter table public.bills
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(bill_number, '')), 'A')
  ) stored;
create index if not exists idx_bills_search_tsv on public.bills using gin (search_tsv);

alter table public.accounts
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(account_number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) stored;
create index if not exists idx_accounts_search_tsv on public.accounts using gin (search_tsv);

alter table core.vendors
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(email, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(city, '')), 'C')
  ) stored;
create index if not exists idx_vendors_search_tsv on core.vendors using gin (search_tsv);

alter table core.customers
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(email, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(city, '')), 'C')
  ) stored;
create index if not exists idx_customers_search_tsv on core.customers using gin (search_tsv);
