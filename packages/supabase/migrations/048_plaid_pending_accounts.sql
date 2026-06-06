-- =============================================================================
-- Migration 048: Plaid account staging for the connect-and-map flow (GATE 12.0)
-- =============================================================================
-- Per the setup model: when an entity's bank login is connected, each returned
-- account must be reviewed by the user, who assigns it a LABEL and a GL cash
-- account before it becomes a real bank account. Until then it can't live in
-- bank_accounts (which requires NOT NULL location_id + account_id/GL).
--
-- So connecting now stages the returned accounts here. The mapping step promotes
-- a staged row into bank_accounts (location + chosen GL account + label), then
-- marks the staged row mapped. Non-cash accounts (loans/investments) can be
-- ignored. This replaces the old behavior that dumped every account onto the
-- first entity + GL 1000.
--
-- REQUIRES 005 (bank_accounts), 041 (provider_connections), 046 (plaid_items).
-- Idempotent.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='plaid_items') then
    raise exception 'plaid_items not found — deploy migration 046 before 048.';
  end if;
end $$;

create table if not exists plaid_pending_accounts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  plaid_item_pk     uuid not null references plaid_items(id) on delete cascade,
  connection_id     uuid not null,

  -- The entity this connection belongs to — resolved BEFORE Plaid opens
  -- (presumed when scoped to a company, picked once from the consolidated view).
  location_id       uuid not null references core.locations(id) on delete cascade,

  -- Straight from Plaid (not secrets):
  plaid_account_id  text not null,
  account_name      text not null,
  account_mask      text,
  account_type      text not null,         -- normalized: CHECKING/SAVINGS/CREDIT_CARD/LINE_OF_CREDIT/OTHER
  current_balance_cents   bigint,
  available_balance_cents bigint,

  -- Mapping state set by the user (GL account + label only; entity already known):
  status            text not null default 'PENDING'
                      check (status in ('PENDING','MAPPED','IGNORED')),
  mapped_bank_account_id uuid references bank_accounts(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table plaid_pending_accounts is
  'GATE 12.0: accounts returned from a Plaid connect, awaiting user mapping (label + GL account + entity) before promotion into bank_accounts. PENDING -> MAPPED/IGNORED.';

create unique index if not exists uq_plaid_pending_acct
  on plaid_pending_accounts (org_id, plaid_account_id);
create index if not exists ix_plaid_pending_org_status
  on plaid_pending_accounts (org_id, status);
create index if not exists ix_plaid_pending_item
  on plaid_pending_accounts (plaid_item_pk);

create or replace function tg_plaid_pending_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_plaid_pending_touch on plaid_pending_accounts;
create trigger trg_plaid_pending_touch
  before update on plaid_pending_accounts
  for each row execute function tg_plaid_pending_touch();

alter table plaid_pending_accounts enable row level security;

drop policy if exists plaid_pending_select on plaid_pending_accounts;
create policy plaid_pending_select on plaid_pending_accounts
  for select using (org_id = get_org_id());

drop policy if exists plaid_pending_all on plaid_pending_accounts;
create policy plaid_pending_all on plaid_pending_accounts
  for all using (org_id = get_org_id()) with check (org_id = get_org_id());

grant select, insert, update, delete on plaid_pending_accounts to authenticated, service_role;

do $$ begin raise notice '048 OK: plaid_pending_accounts ready (connect-and-map staging).'; end $$;
