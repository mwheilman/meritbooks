-- =============================================================================
-- Migration 043: Money-Movement GL plumbing (GATE 12 — AR/AP posting layer)
-- =============================================================================
-- Ledger-side foundation for money movement. No provider needed: this is the
-- accounts, role keys, and sub-ledger columns the AR/AP posting builders use.
--
--   1. New account-role keys in core.account_role_keys (so they can be mapped)
--   2. Two new clearing accounts (1095 Payment Processor Clearing, 1096 Payments
--      in Transit) seeded into each existing org's Cash & Cash Equivalents group
--      (copied from that org's 1090 Undeposited Funds account — guaranteed to
--      exist and to be in the right group/type/sub-type). New tenants get them
--      from the COA template (packages/shared chart-of-accounts.ts).
--   3. AR settlement columns on customer_payments
--   4. AP disbursement-lifecycle columns on bill_payments (a SEPARATE
--      disbursement_status column — the existing POSTED/VOIDED status is left
--      untouched so current logic is unaffected)
--   5. public.ach_authorizations — durable NACHA/ACH authorization records that
--      outlive any single transfer (Core flag #4)
--
-- MERCHANT_FEE_EXPENSE reuses the existing 6630 Bank Fees account (no new acct).
-- Idempotent. Money is bigint cents.
-- =============================================================================

-- ---- Guard ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='account_role_keys') then
    raise exception 'core.account_role_keys not found — deploy migration 029 (posting engine foundation) before 043.';
  end if;
end $$;

-- =============================================================================
-- 1. Role keys
-- =============================================================================
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('SETTLEMENT_CLEARING', 'Payment Processor Clearing (AR settlement float)', 'LOCATION', '1095'),
  ('PAYMENTS_IN_TRANSIT', 'Payments in Transit (AP disbursement float)',      'LOCATION', '1096'),
  ('MERCHANT_FEE_EXPENSE','Merchant / Processing Fees',                        'ORG',      '6630')
on conflict (role_key) do nothing;

-- =============================================================================
-- 2. Seed 1095 / 1096 for existing orgs (copy group/type/sub-type from 1090)
-- =============================================================================
-- Each org's "Undeposited Funds" (1090) lives in Cash & Cash Equivalents with
-- the correct account_group_id / account_type / account_sub_type. We clone those
-- classification fields so the new clearing accounts land in the right place
-- without fragile name lookups. Skipped for any org missing 1090 (will arrive
-- via the COA template re-seed instead).
do $$
declare
  r record;
begin
  for r in
    select a.org_id, a.account_group_id, a.account_type, a.account_sub_type
    from public.accounts a
    where a.account_number = '1090'
  loop
    insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active)
    select r.org_id, r.account_group_id, '1095', 'Payment Processor Clearing', r.account_type, r.account_sub_type, true
    where not exists (select 1 from public.accounts x where x.org_id = r.org_id and x.account_number = '1095');

    insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active)
    select r.org_id, r.account_group_id, '1096', 'Payments in Transit', r.account_type, r.account_sub_type, true
    where not exists (select 1 from public.accounts x where x.org_id = r.org_id and x.account_number = '1096');
  end loop;
end $$;

-- =============================================================================
-- 3. AR settlement columns on customer_payments
-- =============================================================================
alter table public.customer_payments add column if not exists provider           text;
alter table public.customer_payments add column if not exists provider_payment_id text;
alter table public.customer_payments add column if not exists fee_cents           bigint not null default 0;
alter table public.customer_payments add column if not exists settlement_status   text not null default 'NONE'
  check (settlement_status in ('NONE','PENDING','SETTLED','DISPUTED','REFUNDED'));
alter table public.customer_payments add column if not exists settlement_date     date;
alter table public.customer_payments add column if not exists payout_id           text;
alter table public.customer_payments add column if not exists clearing_account_id uuid references public.accounts(id);
alter table public.customer_payments add column if not exists approval_id         uuid references public.approvals(id);

-- =============================================================================
-- 4. AP disbursement-lifecycle columns on bill_payments (existing status kept)
-- =============================================================================
alter table public.bill_payments add column if not exists provider             text;
alter table public.bill_payments add column if not exists provider_transfer_id text;
alter table public.bill_payments add column if not exists disbursement_status  text not null default 'NONE'
  check (disbursement_status in ('NONE','DRAFT','APPROVED','SENT','SETTLED','RETURNED','VOID'));
alter table public.bill_payments add column if not exists scheduled_date       date;
alter table public.bill_payments add column if not exists settled_at           timestamptz;
alter table public.bill_payments add column if not exists return_code          text;
alter table public.bill_payments add column if not exists clearing_account_id  uuid references public.accounts(id);
alter table public.bill_payments add column if not exists approval_id          uuid references public.approvals(id);

-- =============================================================================
-- 5. ach_authorizations — durable compliance records
-- =============================================================================
create table if not exists public.ach_authorizations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id(),
  vendor_id       uuid,                       -- core.vendors (stitched in JS; no cross-schema FK)
  location_id     uuid,
  authorization_type text not null default 'RECURRING'
                    check (authorization_type in ('SINGLE','RECURRING')),
  account_mask    text,                        -- last 4 only; never the full account number
  routing_mask    text,
  signed_by       text,                        -- who authorized (name/title captured at signing)
  signed_at       timestamptz not null default now(),
  document_ref    text,                        -- pointer to the stored authorization document
  revoked_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
comment on table public.ach_authorizations is
  'Durable NACHA/ACH authorization records (GATE 12). Retained as legal/compliance evidence independent of any single transfer. Never stores full bank account numbers — masks only.';
create index if not exists ix_ach_auth_org_vendor on public.ach_authorizations (org_id, vendor_id);

alter table public.ach_authorizations enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ach_authorizations' and policyname='org_isolation') then
    create policy "org_isolation" on public.ach_authorizations for all using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ach_authorizations' and policyname='service_write') then
    create policy "service_write" on public.ach_authorizations for all to service_role using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- 6. Verification
-- =============================================================================
do $$
begin
  raise notice 'Migration 043 OK: roles +%, clearing accts seeded for % orgs, ach_authorizations=%',
    (select count(*) from core.account_role_keys where role_key in ('SETTLEMENT_CLEARING','PAYMENTS_IN_TRANSIT','MERCHANT_FEE_EXPENSE')),
    (select count(*) from public.accounts where account_number = '1096'),
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='ach_authorizations');
end $$;
