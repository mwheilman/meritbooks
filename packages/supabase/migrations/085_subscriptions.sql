-- Migration 085: Subscription Catcher — recurring-vendor subscription register + creep guard
-- =============================================================
-- Detects recurring subscription/SaaS payments from the owned bank-feed + AP history,
-- tracks each subscription's terms + renewal date, flags "creep" (new spend, price
-- hikes, category overlap, stale/zombie subscriptions), and drives a human keep/cancel
-- workflow. This is the tenant's OWN outbound subscription spend — distinct from the
-- recurring-INVOICE templates it bills TO customers (migration 073) and from insurance
-- (084). Collision-checked: `grep -rin subscription packages/supabase/migrations/`
-- returns only enum VALUES ('SUBSCRIPTION' rev-rec method / pricing model in 012/023) —
-- no `subscriptions` / `subscription_*` TABLE exists. Nothing recreated; additive only.
--
-- Canon boundaries honored:
--   • RLS org_isolation via public.get_org_id() (never auth.uid()); references
--     core.organizations / core.locations (NOT bare `organizations`).
--   • Money is bigint cents (amount_cents, prior_amount_cents, annualized_cents).
--   • The AI/detector only PROPOSES — a detected row lands in status DETECTED (a review
--     state), never ACTIVE/KEPT. NOTHING auto-cancels or auto-pays: a CANCEL decision
--     DRAFTS a cancellation request and sets status CANCELLING for a human to send.
-- Degrade-safe, additive, idempotent. Next migration number after this: 086 (Books band).
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — expected from migration 001.';
  end if;
end $$;

create table if not exists public.subscriptions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,   -- null = consolidated

  -- Who / what
  vendor_id uuid,                                                      -- FK added conditionally below
  vendor_name text not null,                                          -- normalized display name
  product text,                                                        -- specific plan/product, if known
  category text,                                                       -- SaaS category (for overlap creep)

  -- Economics (bigint cents)
  amount_cents bigint not null default 0,                             -- typical per-charge amount
  prior_amount_cents bigint,                                          -- last-known amount before a price change
  billing_cadence text not null default 'MONTHLY',                   -- MONTHLY/QUARTERLY/ANNUAL/OTHER

  -- Lifecycle dates
  first_seen_date date,
  last_charged_date date,
  next_renewal_date date,

  -- Status + terms
  status text not null default 'DETECTED',
  auto_renews boolean not null default true,
  notice_period_days int,                                             -- days' notice required to cancel
  cancellation_terms text,
  cancellation_method text,                                           -- portal / email / phone / written
  notes text,

  -- Provenance + creep evidence
  source text not null default 'DETECTED',                           -- DETECTED / MANUAL / PARSED
  creep_flags jsonb not null default '[]'::jsonb,                     -- ['NEW','PRICE_INCREASE','DUPLICATE_CATEGORY','STALE']
  charge_count int not null default 0,                               -- observed charges informing the cadence
  charge_txn_ids jsonb not null default '[]'::jsonb,                 -- bank_transactions ids (link-back, no join table)

  -- Idempotent detection key (org, dedup_key) — a re-scan UPSERTS the same subscription
  dedup_key text,

  -- Human keep/cancel audit
  reviewed_at timestamptz,
  reviewed_by_user text,
  cancellation_draft text,                                            -- the DRAFTED cancellation message (human sends)

  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- vendor_id FK only if public.vendors exists (degrade-safe across environments).
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'vendors') then
    begin
      alter table public.subscriptions
        add constraint subscriptions_vendor_fk
        foreign key (vendor_id) references public.vendors(id) on delete set null;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- Constrain the enums (idempotent — skip if already present).
do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_cadence_chk
    check (billing_cadence in ('MONTHLY','QUARTERLY','ANNUAL','OTHER'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_status_chk
    check (status in ('DETECTED','ACTIVE','UNDER_REVIEW','CANCELLING','CANCELLED','KEPT'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_source_chk
    check (source in ('DETECTED','MANUAL','PARSED'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_amounts_chk
    check (
      (amount_cents        is null or amount_cents        >= 0) and
      (prior_amount_cents  is null or prior_amount_cents  >= 0)
    );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_notice_chk
    check (notice_period_days is null or notice_period_days >= 0);
exception when duplicate_object then null; end $$;

-- Idempotent detection: at most one subscription per (org, dedup_key).
create unique index if not exists uq_subscriptions_org_dedup
  on public.subscriptions(org_id, dedup_key)
  where dedup_key is not null;

create index if not exists idx_subscriptions_org
  on public.subscriptions(org_id, created_at desc);
create index if not exists idx_subscriptions_renewal
  on public.subscriptions(org_id, status, next_renewal_date);

alter table public.subscriptions enable row level security;
do $$ begin
  create policy "org_isolation" on public.subscriptions
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.subscriptions
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. `subscriptions` is a standalone register of the tenant's OWN recurring
-- subscription spend. Renewals ("due in the next N days", notice-period-aware) are a
-- READ-ONLY compute over next_renewal_date / notice_period_days — no schedule table,
-- no ledger post. A CANCEL decision only DRAFTS a cancellation message and sets status
-- CANCELLING; a human sends it. Nothing here moves money or touches the GL.
-- =============================================================
