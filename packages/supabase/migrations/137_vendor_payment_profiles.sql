-- =============================================================================
-- Migration 137: vendor payment profiles (MASKED bank details + method) +
--                per-payment check-number capture for the AP pay-run.
-- =============================================================================
-- Deepens the AP money-out pay-run WITHOUT a live ACH provider:
--   1. public.vendor_payment_profiles — per-vendor preferred payment METHOD and
--      MASKED bank details. Mirrors public.ach_authorizations' hard rule: this
--      table NEVER stores a full account or routing number — only the last 4
--      digits, masked (e.g. '****1234'). The app masks server-side on capture;
--      the raw number is never persisted and never returned.
--   2. public.disbursement_check_numbers — the check number a human assigns to a
--      CHECK-method disbursement line (the alternative to exporting a bank file).
--      A reference only; it never touches the GL. Release posts DR A/P / CR Cash
--      through the existing recordBillPayment gate, unchanged.
--
-- SAFETY / CANON §3: nothing here moves money, contacts a bank, or posts to the
-- GL. Additive + idempotent. RLS org_isolation via public.get_org_id(); the app
-- degrades SAFE (pay-run works without a profile — the line simply shows "no bank
-- details on file") if these tables are absent. Money is bigint cents elsewhere.
-- =============================================================================

-- 1. vendor_payment_profiles — masked bank details + preferred method per vendor
create table if not exists public.vendor_payment_profiles (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  vendor_id      uuid not null,                 -- core.vendors (stitched in JS; no cross-schema FK)
  payment_method text not null default 'ACH'
                   check (payment_method in ('ACH','CHECK')),
  account_type   text check (account_type in ('checking','savings')),
  account_mask   text,                          -- last 4 ONLY, masked (e.g. '****1234'); never the full number
  routing_mask   text,                          -- last 4 ONLY, masked; never the full routing number
  bank_name      text,
  notes          text,
  captured_by    text,
  captured_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, vendor_id)
);

comment on table public.vendor_payment_profiles is
  'Per-vendor preferred payment method + MASKED bank details for the AP pay-run (task: pay-run depth). NEVER stores full account/routing numbers — last-4 masks only, mirroring public.ach_authorizations. Not a live-ACH origination store; MeritBooks has no live ACH provider.';

create index if not exists ix_vendor_pay_profiles_org_vendor
  on public.vendor_payment_profiles (org_id, vendor_id);

-- 2. disbursement_check_numbers — human-assigned check number per disbursement line
create table if not exists public.disbursement_check_numbers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  approval_id  uuid not null references public.approvals(id) on delete cascade,
  check_number text not null,
  assigned_by  text,
  assigned_at  timestamptz not null default now(),
  unique (org_id, approval_id)
);

comment on table public.disbursement_check_numbers is
  'Check number a human assigns to a CHECK-method AP disbursement line (reference only; never posts to the GL). The alternative to exporting a NACHA/CSV bank file for check payments.';

-- ---- RLS ----
alter table public.vendor_payment_profiles     enable row level security;
alter table public.disbursement_check_numbers  enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vendor_payment_profiles' and policyname='org_isolation')
    then create policy "org_isolation" on public.vendor_payment_profiles for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vendor_payment_profiles' and policyname='service_write')
    then create policy "service_write" on public.vendor_payment_profiles for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_check_numbers' and policyname='org_isolation')
    then create policy "org_isolation" on public.disbursement_check_numbers for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='disbursement_check_numbers' and policyname='service_write')
    then create policy "service_write" on public.disbursement_check_numbers for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.vendor_payment_profiles    to anon, authenticated, service_role;
grant select, insert, update, delete on public.disbursement_check_numbers to anon, authenticated, service_role;
