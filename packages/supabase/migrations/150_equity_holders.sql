-- =============================================================================
-- Migration 150: equity / cap-table holders (onboarding equity section).
-- =============================================================================
-- Per-entity cap table: owners/members, ownership % or units, capital contributed,
-- class, preferred terms. Captured in onboarding (drop the operating agreement / CSV
-- / manual). Opening equity DOLLAR balances still arrive via the trial-balance
-- conversion; this table holds the OWNERSHIP detail and feeds consolidation
-- (public.entity_ownership, migration 076) for correct NCI.
--
-- SAFETY / CANON §3: additive + idempotent; reference/ownership data — no GL post, no
-- money movement (capital_contributed_cents is a recorded figure, not a posting). RLS
-- org_isolation via public.get_org_id(). Money is bigint cents; ownership_pct numeric.
-- =============================================================================

create table if not exists core.equity_holders (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  entity_id                 uuid not null references core.locations(id) on delete cascade,
  name                      text not null,
  ownership_pct             numeric(9,6),                 -- 0..100 (null when units-based)
  units                     numeric(20,4),                -- null when percent-based
  capital_contributed_cents bigint not null default 0,
  equity_class              text not null default 'COMMON'
                              check (equity_class in ('COMMON','PREFERRED','LLC_UNIT','PARTNER','OTHER')),
  is_preferred              boolean not null default false,
  preferred_terms           jsonb,
  owner_entity_id           uuid references core.locations(id) on delete set null,  -- link to a parent holdco in this tenant
  created_by                text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table core.equity_holders is
  'Per-entity cap table (owners/members, ownership % or units, capital contributed, class, preferred terms). Captured in onboarding; feeds consolidation ownership. Ownership detail only — opening equity dollars come via the trial-balance conversion.';

create index if not exists ix_equity_holders_entity on core.equity_holders (org_id, entity_id);

alter table core.equity_holders enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='equity_holders' and policyname='org_isolation')
    then create policy "org_isolation" on core.equity_holders for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='equity_holders' and policyname='service_write')
    then create policy "service_write" on core.equity_holders for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on core.equity_holders to anon, authenticated, service_role;
