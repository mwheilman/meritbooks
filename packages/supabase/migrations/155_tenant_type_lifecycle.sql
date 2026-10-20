-- =============================================================================
-- Migration 155: tenant type & lifecycle (IA-SPEC §1.6 M-1) — wave 1 "access foundations"
-- =============================================================================
-- core.organizations gains:
--   tenant_type            firm | company           (default company)
--   lifecycle_status       invited | signed_up | setting_up | converting | live |
--                          at_risk | suspended | churned   (default signed_up)
--   lifecycle_changed_at   timestamptz
--   provisioned_by         uuid -> core.users (null = self-serve)
--   close_due_business_day int default 10
--
-- ADDITIVE + IDEMPOTENT. No behavior change: nothing reads these columns yet.
-- core.organizations stays write-locked to service_role (migration 154) — this
-- migration adds columns only and touches no policy or grant.
--
-- Data step (first run only, keyed on lifecycle_changed_at IS NULL): existing tenants
-- that finished setup are 'live', the rest 'setting_up'. tenant_type is NOT inferred:
-- whether Merit's tenant is a firm or a company is an owner decision (IA Q1); every
-- existing tenant keeps the 'company' default until the owner sets it.
-- =============================================================================

alter table core.organizations add column if not exists tenant_type text not null default 'company';
alter table core.organizations add column if not exists lifecycle_status text not null default 'signed_up';
alter table core.organizations add column if not exists lifecycle_changed_at timestamptz;
alter table core.organizations add column if not exists provisioned_by uuid;
alter table core.organizations add column if not exists close_due_business_day int default 10;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_tenant_type_chk') then
    alter table core.organizations add constraint organizations_tenant_type_chk
      check (tenant_type in ('firm', 'company'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_lifecycle_status_chk') then
    alter table core.organizations add constraint organizations_lifecycle_status_chk
      check (lifecycle_status in ('invited','signed_up','setting_up','converting','live','at_risk','suspended','churned'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_provisioned_by_fkey') then
    alter table core.organizations add constraint organizations_provisioned_by_fkey
      foreign key (provisioned_by) references core.users(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_close_due_bd_chk') then
    alter table core.organizations add constraint organizations_close_due_bd_chk
      check (close_due_business_day is null or close_due_business_day between 1 and 31);
  end if;
end $$;

comment on column core.organizations.tenant_type is
  'IA M-1: firm = keeps books for others; company = keeps its own books. Drives defaults only (labels, client-role default, SoD defaults).';
comment on column core.organizations.lifecycle_status is
  'IA M-1: tenant lifecycle. Informational until the platform console consumes it.';

-- Data step: first run only.
update core.organizations
   set lifecycle_status = case when setup_complete then 'live' else 'setting_up' end,
       lifecycle_changed_at = now()
 where lifecycle_changed_at is null;
