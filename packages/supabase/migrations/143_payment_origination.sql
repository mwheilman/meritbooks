-- =============================================================================
-- Migration 143: payment origination tracking (money-out ACH/wire rail).
-- =============================================================================
-- MeritBooks batches, approves, and exports NACHA/positive-pay files today but has
-- no live rail. This adds the SUBMISSION-TRACKING layer for a provider-agnostic
-- origination adapter (interface + a SANDBOX adapter now; a real ACH/wire provider
-- is a credential swap later). It records that an already-APPROVED, already-POSTED
-- disbursement batch was handed to a rail and tracks its lifecycle
-- (CREATED→SUBMITTED→SETTLED / FAILED / RETURNED).
--
-- SAFETY / CANON §3: additive + idempotent. This does NOT move money or post to the
-- GL — the disbursement RELEASE already posts DR A/P / CR Cash through the existing
-- recordBillPayment gate. This table only records the rail hand-off + status so a
-- return/failure is visible and reconcilable. RLS org_isolation via get_org_id().
-- Money is bigint cents.
-- =============================================================================

create table if not exists public.payment_origination_batches (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid,
  provider           text not null default 'SANDBOX',   -- SANDBOX now; real rail = cred swap
  rail               text not null default 'ACH' check (rail in ('ACH','WIRE')),
  status             text not null default 'CREATED'
                       check (status in ('CREATED','SUBMITTED','SETTLED','FAILED','RETURNED','CANCELED')),
  provider_batch_ref text,                       -- id the rail returns
  total_cents        bigint not null default 0,
  item_count         int not null default 0,
  effective_date     date,
  trace              jsonb,                       -- provider request/response breadcrumbs (no secrets)
  submitted_by       text,
  submitted_at       timestamptz,
  settled_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.payment_origination_batches is
  'Rail hand-off + lifecycle for an already-approved, already-posted AP disbursement batch. Provider-agnostic (SANDBOX adapter now). Does not post to the GL — release already did — only tracks submission/return status.';

create index if not exists ix_pay_orig_batches_org_status on public.payment_origination_batches (org_id, status);

create table if not exists public.payment_origination_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  batch_id         uuid not null references public.payment_origination_batches(id) on delete cascade,
  approval_id      uuid,                          -- public.approvals (AP_DISBURSEMENT) — stitched in JS
  bill_payment_id  uuid,                          -- the posted payment this line settled
  vendor_id        uuid,
  amount_cents     bigint not null check (amount_cents > 0),
  status           text not null default 'PENDING'
                     check (status in ('PENDING','SUBMITTED','SETTLED','FAILED','RETURNED')),
  return_code      text,                          -- ACH return code (e.g. R01) when RETURNED
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.payment_origination_items is
  'Per-payee line within an origination batch; carries the ACH return code on a RETURNED item so failures are traceable back to the posted bill payment.';

create index if not exists ix_pay_orig_items_batch on public.payment_origination_items (batch_id);

alter table public.payment_origination_batches enable row level security;
alter table public.payment_origination_items   enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_origination_batches' and policyname='org_isolation')
    then create policy "org_isolation" on public.payment_origination_batches for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_origination_batches' and policyname='service_write')
    then create policy "service_write" on public.payment_origination_batches for all to service_role using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_origination_items' and policyname='org_isolation')
    then create policy "org_isolation" on public.payment_origination_items for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_origination_items' and policyname='service_write')
    then create policy "service_write" on public.payment_origination_items for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.payment_origination_batches to anon, authenticated, service_role;
grant select, insert, update, delete on public.payment_origination_items   to anon, authenticated, service_role;
