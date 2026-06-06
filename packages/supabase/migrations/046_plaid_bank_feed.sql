-- =============================================================================
-- Migration 046: Plaid Bank Feed Liveness (GATE 12.0 — Books)
-- =============================================================================
-- Makes the bank feed LIVE. Today the app only shows "Connect via Plaid"
-- placeholder text; this migration adds the durable state the Plaid integration
-- needs so transactions and balances actually flow in and stay current.
--
-- What Plaid gives us, and where each piece lives:
--   * Platform credentials (client_id + sandbox/production secret) — these are
--     OUR app credentials, identical for every tenant. The secret is stored once
--     in Supabase Vault (see lib/money/providers/plaid.ts → resolvePlaidPlatform);
--     the client_id is a public-ish env var.
--   * A per-tenant "Item" — one per bank login a tenant connects. Plaid returns
--     an access_token (per Item) which IS a secret and is stored in Vault, with
--     its reference held on core.provider_connections.secret_ref (capability
--     'BANK_FEED'). The Item id + sync cursor are NOT secrets and live here.
--
-- This table tracks Plaid Items per connection so we can: dedupe transactions by
-- Plaid's cursor (incremental /transactions/sync), detect re-auth needs
-- (ITEM_LOGIN_REQUIRED), and map a Plaid account back to our bank_accounts row.
--
-- REQUIRES: 005 (bank_accounts/bank_transactions), 019 (core carve),
-- 023 (entitlements), 041 (provider_connections + Vault). Idempotent.
-- =============================================================================

-- ---- Guards ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='provider_connections') then
    raise exception 'core.provider_connections not found — deploy migration 041 before 046.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='bank_accounts') then
    raise exception 'bank_accounts not found — deploy migration 005 before 046.';
  end if;
end $$;

-- =============================================================================
-- 1. plaid_items — one row per connected bank login (Plaid "Item"), per tenant
-- =============================================================================
create table if not exists plaid_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,

  -- Link to the Core connection registry row (capability='BANK_FEED', provider='plaid').
  -- The Vault access_token lives behind that row's secret_ref; we never store it here.
  connection_id   uuid not null,

  plaid_item_id   text not null,                 -- Plaid's Item id (not a secret)
  institution_id  text,                          -- Plaid institution id (ins_xxx)
  institution_name text,

  -- Incremental sync state for /transactions/sync. NULL = never synced (full pull).
  sync_cursor     text,
  last_synced_at  timestamptz,

  -- Health: 'active' | 'login_required' | 'error'. Drives the re-auth banner.
  status          text not null default 'active'
                    check (status in ('active','login_required','error')),
  status_detail   text,

  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table plaid_items is
  'GATE 12.0: one row per Plaid Item (a tenant bank login). Holds the sync cursor + health; the access_token secret lives in Vault via core.provider_connections.secret_ref. Not a secret store.';

create unique index if not exists uq_plaid_items_item on plaid_items (org_id, plaid_item_id);
create index if not exists ix_plaid_items_org on plaid_items (org_id);
create index if not exists ix_plaid_items_connection on plaid_items (connection_id);

-- updated_at maintenance
create or replace function tg_plaid_items_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_plaid_items_touch on plaid_items;
create trigger trg_plaid_items_touch
  before update on plaid_items
  for each row execute function tg_plaid_items_touch();

-- RLS (standard pattern: org_id = get_org_id()) ------------------------------
alter table plaid_items enable row level security;

drop policy if exists plaid_items_select on plaid_items;
create policy plaid_items_select on plaid_items
  for select using (org_id = get_org_id());

drop policy if exists plaid_items_all on plaid_items;
create policy plaid_items_all on plaid_items
  for all using (org_id = get_org_id()) with check (org_id = get_org_id());

-- service_role (admin client) bypasses RLS; grant base privileges anyway.
grant select, insert, update, delete on plaid_items to authenticated, service_role;

-- =============================================================================
-- 2. Map a Plaid account to our bank_accounts row
-- =============================================================================
-- bank_accounts.plaid_account_id already exists (migration 005). Add the Item
-- link + a uniqueness guard so the same Plaid account can't be registered twice.
alter table bank_accounts add column if not exists plaid_item_pk uuid references plaid_items(id) on delete set null;

create unique index if not exists uq_bank_accounts_plaid_acct
  on bank_accounts (org_id, plaid_account_id)
  where plaid_account_id is not null;

-- bank_transactions.plaid_transaction_id already exists (migration 005). Add a
-- dedupe guard so /transactions/sync replays never double-insert.
create unique index if not exists uq_bank_txns_plaid_id
  on bank_transactions (org_id, plaid_transaction_id)
  where plaid_transaction_id is not null;

-- =============================================================================
-- 3. Entitle the BANK_FEED capability for existing tenants
-- =============================================================================
-- Capability is offered from entitlements, not from connection presence (Core
-- ruling). Bank feed is a baseline capability every tenant should have, so set
-- it on all existing orgs. (New-tenant setup should set this too.)
update core.organizations
   set entitlements = coalesce(entitlements, '{}'::jsonb) || jsonb_build_object('bank_feed', true)
 where coalesce((entitlements->>'bank_feed')::boolean, false) is distinct from true;

-- =============================================================================
-- Verification (read-only; safe to run)
-- =============================================================================
do $$
declare
  n_orgs int;
begin
  select count(*) into n_orgs from core.organizations where (entitlements->>'bank_feed')::boolean = true;
  raise notice '046 OK: plaid_items ready; bank_feed entitled for % org(s).', n_orgs;
end $$;
