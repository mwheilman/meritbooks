-- =============================================================================
-- Migration 108: core.erp_connections — provider-agnostic ERP connection registry
-- =============================================================================
-- Records the EXISTENCE/STATUS/label of a tenant's link to an operational system
-- (ServiceTitan, Buildertrend, RFMS, Jobber, QuickBooks, etc.) so accounting-relevant
-- data can flow into the book of record. NO raw secrets here — real credentials live
-- in the platform secret store (Supabase Vault preferred); this row holds only a
-- non-secret reference in meta. RLS: org read via get_org_id(); writes service_role
-- (routes use the admin client after app-layer settings_system:edit) — the 106 pattern.
-- Additive + idempotent. App degrades SAFE if absent. core band; next number: 109.
-- =============================================================================

create table if not exists core.erp_connections (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  erp_id                 text not null,
  method                 text not null
                           check (method in ('NATIVE_API','OAUTH','AGGREGATOR','WEBHOOK','CSV','MANUAL')),
  status                 text not null default 'pending'
                           check (status in ('connected','pending','error')),
  external_account_label text,
  meta                   jsonb not null default '{}'::jsonb,
  connected_at           timestamptz,
  last_sync_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_erp_connection_org_erp on core.erp_connections (org_id, erp_id);
create index if not exists idx_erp_connection_org on core.erp_connections (org_id);

alter table core.erp_connections enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='erp_connections' and policyname='org_read') then
    create policy "org_read" on core.erp_connections for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='erp_connections' and policyname='service_all') then
    create policy "service_all" on core.erp_connections for all to service_role using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on core.erp_connections to anon, authenticated, service_role;
