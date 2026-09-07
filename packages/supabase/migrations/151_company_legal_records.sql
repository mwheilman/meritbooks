-- 151_company_legal_records.sql
-- Wave 3: the company LEGAL / FORMATION record, captured from formation documents
-- (EIN letter, articles of organization / incorporation, operating agreement).
-- Additive new table, org-scoped RLS. AI proposes the fields from the document;
-- a human confirms; this table stores the confirmed legal record. Nothing here
-- touches the ledger or any existing table.

create table if not exists core.company_legal_records (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid references core.locations(id) on delete set null,
  legal_name         text,
  entity_type        text,          -- LLC | C_CORP | S_CORP | PARTNERSHIP | SOLE_PROP | NONPROFIT | OTHER
  ein                text,
  formation_state    text,
  formation_date     date,
  registered_agent   text,
  members            jsonb not null default '[]'::jsonb,   -- [{ name, role, ownership_pct }]
  source_document_id uuid,
  notes              text,
  created_by_user    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, location_id)
);

create index if not exists idx_company_legal_org on core.company_legal_records(org_id);

alter table core.company_legal_records enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'core' and tablename = 'company_legal_records'
      and policyname = 'company_legal_records_rls'
  ) then
    create policy company_legal_records_rls on core.company_legal_records
      using (org_id = get_org_id()) with check (org_id = get_org_id());
  end if;
end $$;

grant select, insert, update, delete on core.company_legal_records to authenticated;
