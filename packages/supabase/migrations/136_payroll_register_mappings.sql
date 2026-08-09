-- =============================================================================
-- Migration 136: saved per-provider payroll-register column mappings
-- =============================================================================
-- The DETERMINISTIC (no-AI) payroll-register importer lets a tenant map their
-- processor's CSV/XLSX columns (employee, gross, each withholding, employer taxes,
-- deductions, net pay) to payroll fields. This table lets them SAVE that mapping
-- under a provider name (e.g. "ADP", "Gusto") and re-apply it to every future
-- export — so a recurring import is one click, not a re-map.
--
-- The mapping itself is a small JSON array of { header, target, label? } rows; the
-- `header_signature` is a stable, sorted digest of the file's header set used to
-- auto-suggest the right saved template when a file is dropped. Nothing here posts
-- to the ledger — it is UI convenience state, org-isolated by RLS.
--
-- Additive + idempotent. Requires 019 (core carve → core.organizations).
-- Next migration number: 137 (already taken — 139 is the next free slot).
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — expected from migration 019.';
  end if;
end $$;

create table if not exists public.payroll_register_mappings (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Human label for the source system this mapping is for (unique per tenant).
  provider_name text not null check (length(btrim(provider_name)) > 0),
  -- The column mapping: [{ "header": "...", "target": "gross", "label": "..." }, ...]
  mapping jsonb not null,
  -- Sorted, lowercased digest of the header set, for auto-suggesting a template.
  header_signature text,
  created_by_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider_name)
);

create index if not exists idx_payroll_register_mappings_org
  on public.payroll_register_mappings(org_id, provider_name);
create index if not exists idx_payroll_register_mappings_signature
  on public.payroll_register_mappings(org_id, header_signature)
  where header_signature is not null;

alter table public.payroll_register_mappings enable row level security;

do $$ begin
  create policy "org_isolation" on public.payroll_register_mappings
    for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.payroll_register_mappings
  to anon, authenticated, service_role;

do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create trigger trg_payroll_register_mappings_updated
      before update on public.payroll_register_mappings
      for each row execute function set_updated_at();
  end if;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- DONE. Tenants can save/reuse a per-provider payroll-register column mapping for
-- the deterministic CSV/XLSX importer. RLS org-isolates the templates; no GL impact.
-- =============================================================================
