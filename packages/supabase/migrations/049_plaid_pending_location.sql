-- Migration 049: plaid_pending_accounts.location_id
--
-- WHY: the entity-first connect model resolves the owning company (location)
-- BEFORE Plaid opens, so a staged pending account already knows its entity. The
-- per-account mapping step then only needs the GL account + label. This column
-- carries that resolved entity from connect time through to promotion into
-- bank_accounts.
--
-- NOTE (Session 25): applied directly in the Supabase SQL editor during
-- Session 24 but never committed as a file. Committing it now makes the repo the
-- source of truth. Idempotent — `add column if not exists`.

alter table plaid_pending_accounts
  add column if not exists location_id uuid;

-- FK to core.locations (entity). Added separately so re-running is safe even if
-- the column already exists.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'plaid_pending_accounts_location_id_fkey'
      and table_name = 'plaid_pending_accounts'
  ) then
    alter table plaid_pending_accounts
      add constraint plaid_pending_accounts_location_id_fkey
      foreign key (location_id) references core.locations(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_plaid_pending_location
  on plaid_pending_accounts (org_id, location_id);
