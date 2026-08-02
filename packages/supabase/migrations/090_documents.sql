-- =============================================================================
-- Migration 090: Document Management Center + polymorphic attachments
-- =============================================================================
-- The retention layer the product was missing (task #71). Today the drop-and-parse
-- features (receipts, bill/AP intake, covenant / vendor W-9-COI / bank-statement /
-- insurance-policy / lease / debt parsers) read an uploaded file, extract facts, and
-- THROW THE SOURCE AWAY. This table is the durable store for that source document,
-- plus a generic attachments spine so ANY record (bill, invoice, lease, loan, policy,
-- journal entry, vendor, customer, job, …) can retain and surface its supporting docs.
--
-- The FILE BYTES live in Supabase Storage (private bucket `documents`); THIS ROW is
-- only metadata + a `storage_path` pointer + a polymorphic (`entity_type`,`entity_id`)
-- link back to the record it supports. Deleting the row does not by itself delete the
-- object — the application removes the object first, then the row.
--
-- Generic + tenant-owned: NEVER hardcodes a company, entity, or record type.
-- `entity_type` is free text so a new module can link its records without a schema
-- change. `doc_type` is a small controlled vocabulary for filtering/retention.
--
-- Additive + idempotent (create-if-not-exists). RLS org_isolation via get_org_id()
-- (Clerk org claim; never auth.uid()). FKs core.organizations (requires 019 core carve).
-- Books band; next number: 091.
--
-- ⚠️ STORAGE BUCKET NEEDED (reserved spine — REPORTED, not applied here): the lead must
-- create a PRIVATE Supabase Storage bucket named `documents`. Object reads/writes go
-- through the service role (like the existing `branding` bucket), namespaced by orgId
-- in the object path; tenant isolation on the METADATA is enforced by this table's RLS.
-- Degrades safe: with no bucket, uploads fail cleanly and the rest of the app is fine.
-- =============================================================================

-- ---- Guard: the org table this FKs to must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (core carve) before 090.';
  end if;
end $$;

-- =============================================================================
-- 1. DOCUMENTS
-- =============================================================================
-- One row = one retained file. `storage_path` is the object key inside the private
-- `documents` bucket; `entity_type` + `entity_id` optionally link it to the record it
-- supports (both null = an unfiled document that lives only in the Documents center).
create table if not exists public.documents (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Object key within the private `documents` Storage bucket (namespaced by org_id).
  storage_path text not null,
  file_name text not null,
  mime_type text,
  -- File size in bytes (NOT money — a plain count; bigint tolerates large files).
  size_bytes bigint,
  -- Controlled vocabulary for filtering + retention policy. Free-form specifics go in
  -- entity_type; this is the coarse bucket.
  doc_type text not null default 'OTHER'
    check (doc_type in (
      'BILL','RECEIPT','CONTRACT','LEASE','LOAN','POLICY','W9','COI','STATEMENT','OTHER'
    )),
  -- Polymorphic link to the record this document supports. Free text so any module can
  -- attach without a migration; entity_id is the target row's uuid. Both nullable →
  -- an unfiled document.
  entity_type text,
  entity_id uuid,
  -- Human who uploaded it. Clerk user id is TEXT (never a uuid / auth.uid()); human
  -- attribution lives here, not on any gl_* table (see migration 018 convention).
  uploaded_by_user text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique object key per tenant: re-uploading the exact same path upserts rather than
-- orphaning; distinct uploads always get distinct (uuid-prefixed) paths.
create unique index if not exists uq_documents_org_path
  on public.documents(org_id, storage_path);

-- Fast "show me this record's documents" — the attachments-panel query.
create index if not exists idx_documents_entity
  on public.documents(org_id, entity_type, entity_id);

-- Fast "browse the center, filter by type, newest first".
create index if not exists idx_documents_type_created
  on public.documents(org_id, doc_type, created_at desc);

-- =============================================================================
-- 2. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================================
alter table public.documents enable row level security;
do $$ begin
  create policy "org_isolation" on public.documents
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.documents
  to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists (it does post-001).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_documents_updated
        before update on public.documents
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================================
-- DONE. The tenant now has a durable, org-isolated document store. Source files from
-- the drop-and-parse features can be retained and LINKED (entity_type, entity_id) to
-- the record they produced; any record page can list + add its attachments; and the
-- Documents center browses/filters everything. File bytes live in the private
-- `documents` Storage bucket (LEAD: create it) — this row is metadata + a pointer.
-- =============================================================================
