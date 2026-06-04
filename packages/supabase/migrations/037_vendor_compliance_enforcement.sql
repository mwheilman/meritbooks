-- Migration 037: Vendor-compliance payment-hold enforcement (Session 22)
-- =============================================================
-- A vendor with a MISSING or EXPIRED compliance document (W-9 / GL COI / WC COI /
-- WC exemption) is automatically on payment hold: bills to that vendor cannot be
-- PAID until the docs are cured or a documented override is granted. The hold is
-- COMPUTED from document state (no stored "hold" flag to drift); what IS stored
-- is the OVERRIDE — a vendor_payment_holds row that lifts the hold:
--   ONE_TIME    lifts the hold for a single payment, then is consumed
--   TEMPORARY   lifts it until end_date
--   PERMANENT   lifts it indefinitely
-- Every grant / consumption / release / auto-expiry / chase is audit-logged.
--
-- vendor_payment_holds (ONE_TIME/TEMPORARY/PERMANENT + reason + start/end +
-- created_by) already exists (migration 005). This migration adds the override
-- lifecycle columns and the audit-event table.
--
-- Additive + idempotent. Requires 005 (vendor_compliance_docs, vendor_payment_holds),
-- 019 (core carve), 022 (bills lifecycle). Next migration number: 038.
-- =============================================================

-- ---- Guard ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'vendor_payment_holds') then
    raise exception 'vendor_payment_holds not found — deploy migration 005 before 037.';
  end if;
end $$;

-- =============================================================
-- 1. OVERRIDE LIFECYCLE on vendor_payment_holds (a row = an override)
-- =============================================================
alter table public.vendor_payment_holds
  add column if not exists created_by_user text,                 -- Clerk actor who granted it
  add column if not exists consumed_at timestamptz,              -- ONE_TIME: when used
  add column if not exists consumed_bill_id uuid references public.bills(id),
  add column if not exists released_at timestamptz,              -- manual early release
  add column if not exists released_by_user text,
  add column if not exists released_reason text;

-- Fast lookup of a vendor's overrides.
create index if not exists idx_vendor_holds_vendor
  on public.vendor_payment_holds(org_id, vendor_id);

-- =============================================================
-- 2. COMPLIANCE AUDIT EVENTS (the audit trail the policy requires)
-- =============================================================
create table if not exists public.vendor_compliance_events (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  vendor_id uuid not null references core.vendors(id) on delete cascade,
  event_type text not null check (event_type in (
    'PAYMENT_BLOCKED',     -- a payment was refused on compliance grounds
    'OVERRIDE_GRANTED',    -- an override was created
    'OVERRIDE_CONSUMED',   -- a ONE_TIME override was used by a payment
    'OVERRIDE_RELEASED',   -- an override was manually ended
    'DOC_EXPIRED',         -- maintenance flipped a doc VALID -> EXPIRED
    'CHASE_SCHEDULED'      -- maintenance advanced a doc's chase reminder
  )),
  detail text,
  bill_id uuid references public.bills(id),
  override_id uuid references public.vendor_payment_holds(id),
  doc_id uuid references public.vendor_compliance_docs(id),
  created_by_user text,
  created_at timestamptz not null default now()
);

create index if not exists idx_compliance_events_vendor on public.vendor_compliance_events(org_id, vendor_id, created_at desc);

alter table public.vendor_compliance_events enable row level security;
do $$ begin
  create policy "org_isolation" on public.vendor_compliance_events
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.vendor_compliance_events
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Payment-hold enforcement reads doc state + overrides; every action logs
-- to vendor_compliance_events.
-- =============================================================
