-- =============================================================================
-- Migration 057: per-merchant fee schedules (FPB Payments & Fees, Layer 1)
-- =============================================================================
-- What MeritBooks charges each merchant for payment processing. Set by the
-- platform admin (Mike) when onboarding/pricing a merchant — a negotiable deal
-- point per merchant, which is why this is per-org config, not a global constant.
--
-- Replaces the hardcoded ACH_PCT = 0.01 / CARD_PCT = 0.03 in the intent route.
--
-- Rates are basis points (100 bps = 1.00%) and caps/floors are integer cents —
-- never floats, per the money rules. The cap is NULLABLE: null = uncapped,
-- a value = the maximum fee (e.g. 1000 = $10). Mike chooses "1% capped at $X" or
-- "1% no cap" per merchant.
--
-- Versioned: a rate change closes the current row (effective_to = now) and opens
-- a new one, so every payment is explainable against the rate in force when it
-- happened. Exactly one active (effective_to IS NULL) row per merchant.
-- =============================================================================

create table if not exists core.merchant_fee_schedules (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,

  -- ACH: MeritBooks' charge to the merchant for a bank-transfer payment.
  ach_fee_bps         integer not null default 100 check (ach_fee_bps >= 0 and ach_fee_bps <= 10000),
  ach_fee_cap_cents   bigint check (ach_fee_cap_cents is null or ach_fee_cap_cents >= 0),
  ach_fee_min_cents   bigint check (ach_fee_min_cents is null or ach_fee_min_cents >= 0),

  -- Card: MeritBooks' charge to the merchant for a card payment.
  card_fee_bps        integer not null default 300 check (card_fee_bps >= 0 and card_fee_bps <= 10000),
  card_fee_cap_cents  bigint check (card_fee_cap_cents is null or card_fee_cap_cents >= 0),
  card_fee_min_cents  bigint check (card_fee_min_cents is null or card_fee_min_cents >= 0),

  effective_from      timestamptz not null default now(),
  effective_to        timestamptz,               -- null = the active schedule
  set_by              text,                       -- platform-admin clerk id (audit)
  note                text,                       -- optional deal note
  created_at          timestamptz not null default now(),

  -- A cap below its floor is a misconfiguration.
  constraint ach_cap_ge_min  check (ach_fee_cap_cents  is null or ach_fee_min_cents  is null or ach_fee_cap_cents  >= ach_fee_min_cents),
  constraint card_cap_ge_min check (card_fee_cap_cents is null or card_fee_min_cents is null or card_fee_cap_cents >= card_fee_min_cents)
);

comment on table core.merchant_fee_schedules is
  'Layer-1 fee model: what MeritBooks charges each merchant for payment processing. Per-org, versioned; the active row has effective_to IS NULL. Rates in bps, caps/floors in integer cents (cap nullable = uncapped).';

-- Exactly one active schedule per merchant.
create unique index if not exists uq_merchant_fee_schedule_active
  on core.merchant_fee_schedules (org_id)
  where effective_to is null;

-- Fast lookup of a merchant's history.
create index if not exists idx_merchant_fee_schedule_org
  on core.merchant_fee_schedules (org_id, effective_from desc);

-- RLS (added in 059 after the advisor flagged this table shipped without it).
-- A merchant may read its own schedule; writes are service_role only — a merchant
-- must never price itself. Included here so a fresh replay is secure by default.
alter table core.merchant_fee_schedules enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='merchant_fee_schedules' and policyname='org_read') then
    create policy "org_read" on core.merchant_fee_schedules
      for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='merchant_fee_schedules' and policyname='service_all') then
    create policy "service_all" on core.merchant_fee_schedules
      for all to service_role using (true) with check (true);
  end if;
end $$;
