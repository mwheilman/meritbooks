-- Migration 084: Insurance Policy Register (drop-and-parse — the company's OWN policies)
-- =============================================================
-- Distinct from the vendor-facing COI compliance record (migration 005,
-- `vendor_compliance_docs`): a COI tracks a VENDOR's insurance handed to us; THIS
-- register tracks the tenant's OWN insurance policies — coverage, limits, premium,
-- renewals. Brand-new table (collision-checked: no prior `insurance_polic*` /
-- `create table ... insurance` exists in migrations); nothing recreated.
--
-- The AI drop-and-parse path (feature INSURANCE_EXTRACT) only PROPOSES; a policy row
-- is written solely through the gated create path (RLS + Zod), never by the model.
--
-- Money is bigint cents (coverage_limit_cents, deductible_cents, premium_cents).
-- RLS org_isolation via public.get_org_id(). Degrade-safe, additive, idempotent.
-- Next migration number after this: 085 (Books band).
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — expected from migration 001.';
  end if;
end $$;

create table if not exists public.insurance_policies (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,   -- null = consolidated
  carrier text,                                                        -- issuing insurer
  policy_number text,
  coverage_type text not null default 'OTHER',
  coverage_limit_cents bigint,                                         -- per-occurrence / aggregate limit
  deductible_cents bigint,
  premium_cents bigint,                                                -- premium per `premium_frequency`
  premium_frequency text not null default 'ANNUAL',
  effective_date date,
  expiration_date date,
  status text not null default 'ACTIVE',
  broker text,
  notes text,
  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Constrain the enums (idempotent — skip if already present).
do $$ begin
  alter table public.insurance_policies
    add constraint insurance_policies_coverage_type_chk
    check (coverage_type in ('GL','PROPERTY','AUTO','WC','CYBER','UMBRELLA','PROFESSIONAL','OTHER'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.insurance_policies
    add constraint insurance_policies_premium_freq_chk
    check (premium_frequency in ('ANNUAL','SEMIANNUAL','QUARTERLY','MONTHLY','ONE_TIME'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.insurance_policies
    add constraint insurance_policies_status_chk
    check (status in ('ACTIVE','EXPIRED','CANCELLED','PENDING'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.insurance_policies
    add constraint insurance_policies_amounts_chk
    check (
      (coverage_limit_cents is null or coverage_limit_cents >= 0) and
      (deductible_cents     is null or deductible_cents     >= 0) and
      (premium_cents        is null or premium_cents        >= 0)
    );
exception when duplicate_object then null; end $$;

create index if not exists idx_insurance_policies_org
  on public.insurance_policies(org_id, created_at desc);
create index if not exists idx_insurance_policies_expiration
  on public.insurance_policies(org_id, status, expiration_date);

alter table public.insurance_policies enable row level security;
do $$ begin
  create policy "org_isolation" on public.insurance_policies
    for all using (org_id = public.get_org_id())
    with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.insurance_policies
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. `insurance_policies` is a standalone register of the tenant's OWN policies.
-- Renewals ("expiring in the next N days") are a READ-ONLY compute over
-- expiration_date — no schedule table, no ledger post. Linking a premium to prepaid
-- amortization (migration for prepaids) is an OPTIONAL cross-link, not enforced here.
-- =============================================================
