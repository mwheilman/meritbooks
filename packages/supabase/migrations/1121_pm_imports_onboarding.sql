-- ============================================================================
-- 1121 · Merit Projects — imports & onboarding: the import engine's batches, source-system
--        adapters' staged rows, saved column mappings, idempotent commit through the shared
--        records' match-at-the-door, mid-stream opening facts handed to Books with a tie-out,
--        crew invites (pack titles → Projects roles + the Projects-only flag) and the go-live
--        switch that releases held customer messages.
--
-- Panel rows: PLT-67 import framework, PLT-68 source adapters, PLT-69 QuickBooks (via Books),
-- PLT-70 opening-state loader per open job, CGC-08 mid-stream job import, RES-05 Buildertrend /
-- CoConstruct / JobTread, FS-65 agreement import with reconciliation, FS-116 migration importers,
-- FS-117 guided setup, DLR-81 c-Systems migration (unit-by-unit tie-out), RED-44 development
-- migration; UX seat §(a) setup steps 4–9.
--
-- WHAT THIS MIGRATION CREATES (schema pm only; no new public / core table)
--   import_batches     one uploaded file × entity. STAGED → COMMITTED (idempotent: committing a
--                      committed batch returns the stored result) or DISCARDED (undo of an
--                      uncommitted batch). One live batch per company × source × entity × file hash,
--                      so re-dropping the same file re-stages it instead of duplicating.
--   import_rows        the parsed, normalized rows (the app's adapters map and validate; the DB
--                      re-checks), each with its outcome after commit and the record it created or
--                      matched. Rows carry the batch id (provenance) and so does every created job
--                      (pm.projects.ext._import_batch_id).
--   import_mappings    saved column mapping per company × source × entity (header signature).
--   import_refs        external id ledger (source × entity × external ref → record): a re-import of
--                      the same record in ANY later batch is skipped, never duplicated.
--   opening_handoffs   the opening position for Books per company × kind (JOB_WIP, AGREEMENT_DEFERRED,
--                      DEALER_UNITS, OPEN_AR, CUSTOMER_DEPOSITS, PARTS_INVENTORY, WARRANTY_RECEIVABLE):
--                      a validated, Books-shaped payload + totals + blockers + the last tie-out.
--                      Projects NEVER writes the GL: Books reads SUBMITTED handoffs and records its own
--                      opening entries through its own import path, then answers through
--                      pm.opening_books_decision (service role only).
--   opening_job_facts  one row per imported mid-stream job: contract, approved COs, billed to date,
--                      cost to date, EAC, retainage held / payable, deposits, open commitments, SOV
--                      lines with billed to date, earned / over / under (computed by the app with the
--                      same arithmetic as Books' WIP engine).
--   crew_invites       people to bring on (from imported employees, Books' team or typed), each with a
--                      pack role title, the Projects role template it maps to and the Projects-only
--                      flag. Claimed automatically when the person's membership appears (trigger on
--                      core.memberships): the role is assigned at the company and the seat flagged.
--
-- RPCs (member, guarded through pm.access_rpc_guards — 1110 H2)
--   import_stage(location, source, entity, file_name, file_hash, mapping, rows, report)  settings:configure
--   import_commit(batch)            settings:configure on the batch's company. Every customer / vendor /
--                                   contact goes through core.match_parties first (match at the door):
--                                   an exact match (or score ≥ 0.90) links the existing record, anything
--                                   else is created through pm.create_customer / pm.create_vendor /
--                                   core.create_contact / core.create_site (1111's safety net files
--                                   strong-but-not-exact pairs into the duplicate queue).
--   import_discard(batch)           undo an uncommitted batch (rows deleted, batch DISCARDED).
--   import_save_mapping(...)        settings:configure.
--   opening_stage_handoff(...)      settings:configure; re-foots the totals in SQL and refuses a payload
--                                   whose totals don't equal the sum of its facts.
--   opening_tieout(handoff)         financials:view or settings:configure; compares every fact to what
--                                   Books holds (posted GL lines by job / by account role, core.jobs
--                                   opening columns Books owns, Books dealer units + floor-plan notes,
--                                   open invoices, customer deposits) and stores the result.
--   opening_submit_handoff(handoff) settings:configure; VALIDATED → SUBMITTED (Books picks it up).
--   onboarding_invite_crew(location, people)  projects.team:edit.
--   onboarding_cancel_invite(invite)          projects.team:edit.
--   onboarding_go_live(location, release, discard)  settings:configure: flips the company's customer
--                                   messages live (pm.notify_configure) and releases / discards the
--                                   held ones (pm.notify_held_action).
-- Service only: opening_books_decision(handoff, status, books_ref, reason) — Books' answer.
--
-- ACCESS (1110 classes)
--   import_batches C/location read projects.settings · import_rows C/parent of import_batches ·
--   import_mappings C/location read projects.settings · import_refs C/location read projects.settings ·
--   opening_handoffs C/location read projects.financials · opening_job_facts M/job read
--   projects.financials · crew_invites C/location read projects.team. Members read through RLS;
--   every write goes through the definer RPCs above (no member insert / update / delete grants).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
create table if not exists pm.import_batches (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  source_system   text not null,
  entity          text not null,
  file_name       text check (file_name is null or char_length(file_name) <= 255),
  file_hash       text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  status          text not null default 'STAGED',
  mapping         jsonb not null default '{}' check (jsonb_typeof(mapping) = 'object'),
  report          jsonb not null default '{}' check (jsonb_typeof(report) = 'object'),
  result          jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),
  row_count       int not null default 0 check (row_count >= 0),
  valid_count     int not null default 0 check (valid_count >= 0),
  invalid_count   int not null default 0 check (invalid_count >= 0),
  created_count   int not null default 0 check (created_count >= 0),
  matched_count   int not null default 0 check (matched_count >= 0),
  skipped_count   int not null default 0 check (skipped_count >= 0),
  error_count     int not null default 0 check (error_count >= 0),
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  committed_at    timestamptz,
  committed_by    text,
  discarded_at    timestamptz,
  discarded_by    text,
  unique (org_id, id),
  constraint import_batches_source_chk check (source_system in ('BUILDERTREND','JOBTREAD','COCONSTRUCT','SERVICETITAN','FIELDEDGE',
    'SIMPRO','HOUSECALL_PRO','JOBBER','CSYSTEMS','PROCORE','EXCEL','QUICKBOOKS','CSV')),
  constraint import_batches_entity_chk check (entity in ('customer','vendor','contact','site','employee','cost_item','job','budget',
    'sov_line','commitment','change_order','selection','file','equipment','service_history','open_ar','agreement','unit',
    'rental_unit','part','repair_order','special_order','warranty_claim','rental_contract','deposit')),
  constraint import_batches_status_chk check (status in ('STAGED','COMMITTING','COMMITTED','DISCARDED','FAILED')),
  constraint import_batches_commit_chk check (status <> 'COMMITTED' or committed_at is not null),
  constraint import_batches_discard_chk check (status <> 'DISCARDED' or discarded_at is not null)
);
create unique index if not exists pm_import_batches_live_uidx
  on pm.import_batches (org_id, location_id, source_system, entity, file_hash) where status in ('STAGED','COMMITTING','COMMITTED');
create index if not exists pm_import_batches_loc_idx on pm.import_batches (org_id, location_id, created_at desc);

create table if not exists pm.import_rows (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  batch_id        uuid not null,
  row_number      int not null check (row_number >= 1),
  entity          text not null,
  external_ref    text check (external_ref is null or char_length(external_ref) between 1 and 200),
  data            jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  issues          jsonb not null default '[]' check (jsonb_typeof(issues) = 'array'),
  validation      text not null default 'VALID' check (validation in ('VALID','WARN','INVALID')),
  outcome         text not null default 'PENDING' check (outcome in ('PENDING','CREATED','MATCHED','SKIPPED','ERROR','REFERENCE','ROSTER','FACT')),
  target_table    text,
  target_id       uuid,
  match           jsonb,
  message         text check (message is null or char_length(message) <= 500),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, batch_id, row_number),
  foreign key (org_id, batch_id) references pm.import_batches (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_import_rows_target_idx on pm.import_rows (org_id, target_table, target_id) where target_id is not null;

create table if not exists pm.import_mappings (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  source_system     text not null,
  entity            text not null,
  header_signature  text not null check (char_length(header_signature) between 1 and 128),
  mapping           jsonb not null check (jsonb_typeof(mapping) = 'object'),
  use_count         int not null default 1 check (use_count >= 1),
  updated_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, source_system, entity)
);

create table if not exists pm.import_refs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  source_system  text not null,
  entity         text not null,
  external_ref   text not null check (char_length(external_ref) between 1 and 200),
  target_table   text not null,
  target_id      uuid not null,
  batch_id       uuid,
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, source_system, entity, external_ref)
);
create index if not exists pm_import_refs_target_idx on pm.import_refs (org_id, target_table, target_id);

create table if not exists pm.opening_handoffs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  kind              text not null,
  as_of_date        date not null,
  status            text not null default 'DRAFT',
  source_batch_ids  uuid[] not null default '{}',
  payload           jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  totals            jsonb not null default '{}' check (jsonb_typeof(totals) = 'object'),
  blockers          jsonb not null default '[]' check (jsonb_typeof(blockers) = 'array'),
  tieout            jsonb,
  tied_at           timestamptz,
  books_ref         text,
  books_reason      text check (books_reason is null or char_length(books_reason) <= 1000),
  submitted_at      timestamptz,
  submitted_by      text,
  decided_at        timestamptz,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  constraint opening_handoffs_kind_chk check (kind in ('JOB_WIP','AGREEMENT_DEFERRED','DEALER_UNITS','OPEN_AR','CUSTOMER_DEPOSITS',
    'PARTS_INVENTORY','WARRANTY_RECEIVABLE')),
  constraint opening_handoffs_status_chk check (status in ('DRAFT','VALIDATED','SUBMITTED','ACCEPTED','REJECTED','SUPERSEDED')),
  constraint opening_handoffs_submit_chk check (status not in ('SUBMITTED','ACCEPTED','REJECTED') or submitted_at is not null)
);
create unique index if not exists pm_opening_handoffs_live_uidx
  on pm.opening_handoffs (org_id, location_id, kind) where status in ('DRAFT','VALIDATED','SUBMITTED','ACCEPTED');

create table if not exists pm.opening_job_facts (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  handoff_id                  uuid not null,
  location_id                 uuid not null references core.locations(id),
  job_id                      uuid not null,
  external_ref                text,
  original_contract_cents     bigint not null default 0 check (original_contract_cents >= 0),
  approved_co_cents           bigint not null default 0,
  revised_contract_cents      bigint not null default 0 check (revised_contract_cents >= 0),
  estimated_cost_cents        bigint not null default 0 check (estimated_cost_cents >= 0),
  cost_to_date_cents          bigint not null default 0 check (cost_to_date_cents >= 0),
  billed_to_date_cents        bigint not null default 0 check (billed_to_date_cents >= 0),
  retainage_receivable_cents  bigint not null default 0 check (retainage_receivable_cents >= 0),
  retainage_payable_cents     bigint not null default 0 check (retainage_payable_cents >= 0),
  customer_deposits_cents     bigint not null default 0 check (customer_deposits_cents >= 0),
  open_commitments_cents      bigint not null default 0 check (open_commitments_cents >= 0),
  commitments_billed_cents    bigint not null default 0 check (commitments_billed_cents >= 0),
  earned_revenue_cents        bigint not null default 0 check (earned_revenue_cents >= 0),
  over_billing_cents          bigint not null default 0 check (over_billing_cents >= 0),
  under_billing_cents         bigint not null default 0 check (under_billing_cents >= 0),
  pct_complete                numeric(9,6) check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  last_pay_app_number         int check (last_pay_app_number is null or last_pay_app_number >= 0),
  sov                         jsonb not null default '[]' check (jsonb_typeof(sov) = 'array'),
  cost_codes                  jsonb not null default '[]' check (jsonb_typeof(cost_codes) = 'array'),
  created_at                  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, handoff_id, job_id),
  foreign key (org_id, handoff_id) references pm.opening_handoffs (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_opening_job_facts_job_idx on pm.opening_job_facts (org_id, job_id);

create table if not exists pm.crew_invites (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  email           text check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone           text check (phone is null or char_length(phone) <= 40),
  title           text check (title is null or char_length(title) <= 80),
  role_key        text not null check (role_key ~ '^projects_[a-z_]+$' and role_key <> 'projects_owner'),
  projects_only   boolean not null default false,
  status          text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','CANCELLED')),
  source          text not null default 'manual' check (source in ('import','books_team','manual')),
  import_row_id   uuid,
  employee_id     uuid references core.employees(id) on delete set null,
  membership_id   uuid references core.memberships(id) on delete set null,
  invited_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  unique (org_id, id),
  check (email is not null or phone is not null),
  check (status <> 'ACCEPTED' or (membership_id is not null and accepted_at is not null))
);
create unique index if not exists pm_crew_invites_email_uidx on pm.crew_invites (org_id, location_id, lower(email))
  where status = 'PENDING' and email is not null;

-- ----------------------------------------------------------------------------
-- 2. Internal helpers (definer; not executable by members)
-- ----------------------------------------------------------------------------
-- What committing an entity does: RECORD creates / links a live record, ROSTER feeds the crew
-- step, FACT feeds an opening handoff for Books, REFERENCE is kept on the batch (linked to its job /
-- customer) for history, attachments and reports.
create or replace function pm.import_entity_disposition(p_entity text) returns text
language sql immutable
set search_path = pm, public
as $$
  select case
    when p_entity in ('customer','vendor','contact','site','job','budget','sov_line','cost_item','equipment','agreement','unit',
                      'rental_unit','part') then 'RECORD'
    when p_entity = 'employee' then 'ROSTER'
    when p_entity in ('open_ar','deposit') then 'FACT'
    when p_entity in ('commitment','change_order','selection','file','service_history','repair_order','special_order',
                      'warranty_claim','rental_contract') then 'REFERENCE'
  end
$$;

create or replace function pm._import_txt(p jsonb, k text) returns text
language sql immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), '') $$;

create or replace function pm._import_cents(p jsonb, k text) returns bigint
language plpgsql immutable
as $$
declare v text := nullif(btrim(coalesce(p ->> k, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^-?\d{1,15}$' then raise exception 'PM_INVALID: % must be whole cents (got %)', k, v using errcode = '22023'; end if;
  return v::bigint;
end $$;

create or replace function pm._import_date(p jsonb, k text) returns date
language plpgsql immutable
as $$
declare v text := nullif(btrim(coalesce(p ->> k, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'PM_INVALID: % must be a date (YYYY-MM-DD)', k using errcode = '22023'; end if;
  return v::date;
end $$;

create or replace function pm._import_ref(p_org uuid, p_loc uuid, p_src text, p_entity text, p_ref text) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select r.target_id from pm.import_refs r
   where r.org_id = p_org and r.location_id = p_loc and r.source_system = p_src and r.entity = p_entity
     and r.external_ref = btrim(p_ref)
$$;

create or replace function pm._import_put_ref(p_org uuid, p_loc uuid, p_src text, p_entity text, p_ref text, p_table text,
                                              p_target uuid, p_batch uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if nullif(btrim(coalesce(p_ref, '')), '') is null or p_target is null then return; end if;
  insert into pm.import_refs (org_id, location_id, source_system, entity, external_ref, target_table, target_id, batch_id)
  values (p_org, p_loc, p_src, p_entity, left(btrim(p_ref), 200), p_table, p_target, p_batch)
  on conflict (org_id, location_id, source_system, entity, external_ref)
  do update set target_table = excluded.target_table, target_id = excluded.target_id, batch_id = excluded.batch_id;
end $$;

-- The best match-at-the-door candidate (core.match_parties, 1111) as {id, name, score, level, matched, candidates}.
create or replace function pm._import_find_party(p_kind text, p_name text, p_email text, p_phone text, p_address text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare c record; v_n int := 0; v_best jsonb;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null and p_email is null and p_phone is null then return '{}'::jsonb; end if;
  for c in select * from core.match_parties(p_kind, coalesce(p_name, ''), p_email, p_phone, p_address, null, 5) loop
    v_n := v_n + 1;
    if v_best is null then
      v_best := jsonb_build_object('id', c.id, 'name', c.name, 'score', c.score, 'matched', to_jsonb(c.matched),
                                   'level', c.detail ->> 'level');
    end if;
  end loop;
  return coalesce(v_best, '{}'::jsonb) || jsonb_build_object('candidates', v_n);
end $$;

-- A match strong enough to link instead of creating: exact identifiers, or a near-certain score.
create or replace function pm._import_links(p_match jsonb) returns boolean
language sql immutable
as $$ select p_match ? 'id' and (p_match ->> 'level' = 'exact' or coalesce((p_match ->> 'score')::numeric, 0) >= 0.90) $$;

-- Resolve (and optionally create) the customer a dependent row points at: by external ref from an
-- earlier customer file, by exact name, by match at the door, else create (job / equipment rows).
create or replace function pm._import_customer_for(b pm.import_batches, d jsonb, p_create boolean) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare v_ref text := pm._import_txt(d, 'customer_ref'); v_name text := pm._import_txt(d, 'customer_name'); v_id uuid; m jsonb;
begin
  if v_ref is not null then
    v_id := pm._import_ref(b.org_id, b.location_id, b.source_system, 'customer', v_ref);
    if v_id is not null then return jsonb_build_object('id', v_id, 'how', 'ref'); end if;
  end if;
  if v_name is null then return '{}'::jsonb; end if;
  -- the name as the old system knows it: a customer row an earlier import of this source linked
  select x.target_id into v_id from pm.import_rows x join pm.import_batches y on y.org_id = x.org_id and y.id = x.batch_id
   where y.org_id = b.org_id and y.location_id = b.location_id and y.entity = 'customer' and x.target_id is not null
     and x.outcome in ('CREATED','MATCHED','SKIPPED') and pm.party_name_key(x.data ->> 'name') = pm.party_name_key(v_name)
   order by (y.source_system = b.source_system) desc, y.committed_at desc nulls last limit 1;
  if v_id is not null then return jsonb_build_object('id', v_id, 'how', 'import'); end if;
  select c.id into v_id from core.customers c
   where c.org_id = b.org_id and c.deleted_at is null and c.merged_into is null and pm.party_name_key(c.name) = pm.party_name_key(v_name)
   order by c.is_active desc, c.created_at limit 1;
  if v_id is not null then return jsonb_build_object('id', v_id, 'how', 'name'); end if;
  m := pm._import_find_party('customer', v_name, pm._import_txt(d, 'customer_email'), pm._import_txt(d, 'customer_phone'),
                             pm._import_txt(d, 'customer_address'));
  if pm._import_links(m) then return jsonb_build_object('id', (m ->> 'id')::uuid, 'how', 'match', 'match', m); end if;
  if not p_create then return '{}'::jsonb; end if;
  v_id := pm.create_customer(v_name, pm._import_txt(d, 'customer_email'), pm._import_txt(d, 'customer_phone'), b.location_id, null, null);
  if v_ref is not null then perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'customer', v_ref, 'customers', v_id, b.id); end if;
  return jsonb_build_object('id', v_id, 'how', 'created');
end $$;

create or replace function pm._import_vendor_for(b pm.import_batches, p_name text, p_kind text, p_create boolean) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare v_id uuid; m jsonb;
begin
  if nullif(btrim(coalesce(p_name, '')), '') is null then return '{}'::jsonb; end if;
  select v.id into v_id from core.vendors v
   where v.org_id = b.org_id and v.deleted_at is null and v.merged_into is null and pm.party_name_key(v.name) = pm.party_name_key(p_name)
   order by v.is_active desc, v.created_at limit 1;
  if v_id is not null then return jsonb_build_object('id', v_id, 'how', 'name'); end if;
  m := pm._import_find_party('vendor', p_name, null, null, null);
  if pm._import_links(m) then return jsonb_build_object('id', (m ->> 'id')::uuid, 'how', 'match', 'match', m); end if;
  if not p_create then return '{}'::jsonb; end if;
  v_id := pm.create_vendor(p_name, null, null, coalesce(p_kind, 'SUPPLIER'), b.location_id);
  return jsonb_build_object('id', v_id, 'how', 'created');
end $$;

-- A job on the batch's company by external ref (import ledger, Books job number, or the external id
-- an earlier import stamped on pm.projects.ext).
create or replace function pm._import_job_for(b pm.import_batches, p_ref text) returns uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_id uuid; v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
begin
  if v_ref is null then return null; end if;
  v_id := pm._import_ref(b.org_id, b.location_id, b.source_system, 'job', v_ref);
  if v_id is not null then return v_id; end if;
  select j.id into v_id from core.jobs j where j.org_id = b.org_id and j.location_id = b.location_id and upper(j.job_number) = upper(v_ref) limit 1;
  if v_id is not null then return v_id; end if;
  select p.job_id into v_id from pm.projects p
   where p.org_id = b.org_id and p.location_id = b.location_id and upper(p.ext ->> '_external_id') = upper(v_ref) limit 1;
  return v_id;
end $$;

create or replace function pm._import_cost_code_for(b pm.import_batches, p_code text, p_cost_type text) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(
    (select c.id from pm.cost_codes c where c.org_id = b.org_id and c.location_id = b.location_id and c.job_id is null
        and nullif(btrim(coalesce(p_code, '')), '') is not null
        and (upper(c.code) = upper(btrim(p_code)) or lower(c.name) = lower(btrim(p_code))) order by c.code limit 1),
    (select c.id from pm.cost_codes c where c.org_id = b.org_id and c.location_id = b.location_id and c.job_id is null
        and nullif(btrim(coalesce(p_cost_type, '')), '') is not null and c.cost_type = upper(btrim(p_cost_type)) order by c.code limit 1))
$$;

-- The company's Books control balance for an account role, debit-positive (posted GL only).
create or replace function pm.import_books_role_net(p_org uuid, p_location uuid, p_role text) returns bigint
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
    from public.gl_entry_lines l
    join public.gl_entries e on e.id = l.gl_entry_id and e.status = 'POSTED'
   where l.org_id = p_org and l.location_id = p_location
     and l.account_id in (select r.account_id from public.account_roles r
                           where r.org_id = p_org and r.role_key = p_role and (r.location_id is null or r.location_id = p_location))
$$;

create or replace function pm._import_tie_line(p_key text, p_label text, p_source bigint, p_books bigint, p_extra jsonb default '{}')
returns jsonb
language sql immutable
as $$
  select jsonb_build_object('key', p_key, 'label', p_label, 'source_cents', p_source, 'books_cents', p_books,
           'diff_cents', coalesce(p_source, 0) - coalesce(p_books, 0),
           'status', case when p_books is null then 'pending'
                          when abs(coalesce(p_source, 0) - p_books) <= 100 then 'ok'
                          when p_books = 0 then 'pending'
                          else 'exception' end) || coalesce(p_extra, '{}'::jsonb)
$$;

-- ----------------------------------------------------------------------------
-- 3. Stage, discard, save mapping
-- ----------------------------------------------------------------------------
create or replace function pm.import_stage(p_location uuid, p_source_system text, p_entity text, p_file_name text, p_file_hash text,
                                           p_mapping jsonb, p_rows jsonb, p_report jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; b pm.import_batches%rowtype; r jsonb; v_valid int := 0; v_invalid int := 0; v_n int := 0; v_val text;
  v_src text := upper(btrim(coalesce(p_source_system, ''))); v_entity text := lower(btrim(coalesce(p_entity, ''))); v_reused boolean := false;
  v_report jsonb := coalesce(p_report, '{}'::jsonb); v_dry jsonb; v_jt text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if pm.import_entity_disposition(v_entity) is null then raise exception 'PM_INVALID: unknown import entity %', p_entity using errcode = '22023'; end if;
  if coalesce(p_file_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: file hash must be a sha-256 hex digest' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'PM_INVALID: rows must be a list of 1 to 5,000' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_mapping, '{}'::jsonb)) <> 'object' or jsonb_typeof(v_report) <> 'object' then
    raise exception 'PM_INVALID: mapping and report must be objects' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.import:' || v_org::text || ':' || p_location::text || ':' || v_src || ':' || v_entity || ':' || p_file_hash, 0));

  select * into b from pm.import_batches x
   where x.org_id = v_org and x.location_id = p_location and x.source_system = v_src and x.entity = v_entity and x.file_hash = p_file_hash
     and x.status in ('STAGED','COMMITTING','COMMITTED')
   for update;
  if b.id is not null and b.status <> 'STAGED' then
    return jsonb_build_object('batch_id', b.id, 'status', b.status, 'reused', true, 'row_count', b.row_count,
                              'valid_count', b.valid_count, 'invalid_count', b.invalid_count, 'result', b.result);
  end if;
  if b.id is not null then
    delete from pm.import_rows x where x.org_id = v_org and x.batch_id = b.id;
    v_reused := true;
  else
    insert into pm.import_batches (org_id, location_id, source_system, entity, file_name, file_hash, mapping)
    values (v_org, p_location, v_src, v_entity, left(p_file_name, 255), p_file_hash, coalesce(p_mapping, '{}'::jsonb))
    returning * into b;
  end if;

  for r in select x from jsonb_array_elements(p_rows) x loop
    v_n := v_n + 1;
    if jsonb_typeof(r) <> 'object' or coalesce(r ->> 'row_number', '') !~ '^\d{1,7}$' or jsonb_typeof(coalesce(r -> 'data', 'null'::jsonb)) <> 'object' then
      raise exception 'PM_INVALID: row % must be {row_number, data, issues, validation}', v_n using errcode = '22023';
    end if;
    v_val := upper(coalesce(nullif(r ->> 'validation', ''), 'VALID'));
    if v_val not in ('VALID','WARN','INVALID') then raise exception 'PM_INVALID: row % validation %', v_n, v_val using errcode = '22023'; end if;
    if v_val = 'INVALID' then v_invalid := v_invalid + 1; else v_valid := v_valid + 1; end if;
    insert into pm.import_rows (org_id, batch_id, row_number, entity, external_ref, data, issues, validation)
    values (v_org, b.id, (r ->> 'row_number')::int, v_entity, left(nullif(btrim(coalesce(r ->> 'external_ref', '')), ''), 200),
            r -> 'data', case when jsonb_typeof(r -> 'issues') = 'array' then r -> 'issues' else '[]'::jsonb end, v_val);
  end loop;

  -- Agreements: the field-service importer's own dry run is the deferred-balance reconciliation
  -- (count, deferred $, visits owed, no billing, no visits — FS-65), recorded in pm.agreement_imports.
  if v_entity = 'agreement' then
    select jt.key into v_jt from pm.job_types jt where jt.org_id = v_org and jt.location_id = p_location and jt.is_active
     order by (jt.archetype = 'recurring_service') desc, jt.sort limit 1;
    v_dry := pm.fs_import_agreements(p_location, coalesce(v_jt, 'maintenance'),
      (select coalesce(jsonb_agg(jsonb_strip_nulls(x.data || jsonb_build_object('external_ref', x.external_ref,
                 'customer_id', pm._import_customer_for(b, x.data, false) ->> 'id')) order by x.row_number), '[]'::jsonb)
         from pm.import_rows x where x.org_id = v_org and x.batch_id = b.id and x.validation <> 'INVALID'),
      true, case when v_src in ('FIELDEDGE','SIMPRO','SERVICETITAN','HOUSECALL_PRO','JOBBER') then v_src else 'CSV' end);
    v_report := v_report || jsonb_build_object('agreements', v_dry);
  end if;

  update pm.import_batches set file_name = left(p_file_name, 255), mapping = coalesce(p_mapping, '{}'::jsonb), report = v_report,
         row_count = v_n, valid_count = v_valid, invalid_count = v_invalid, updated_at = now()
   where id = b.id;
  return jsonb_build_object('batch_id', b.id, 'status', 'STAGED', 'reused', v_reused, 'row_count', v_n,
                            'valid_count', v_valid, 'invalid_count', v_invalid, 'report', v_report);
end $$;

create or replace function pm.import_discard(p_batch uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.import_batches%rowtype; v_n int;
begin
  select * into b from pm.import_batches x where x.id = p_batch and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: import % not found in the caller''s organization', p_batch using errcode = '42501'; end if;
  if b.status = 'DISCARDED' then return jsonb_build_object('batch_id', b.id, 'status', 'DISCARDED', 'rows_removed', 0); end if;
  if b.status <> 'STAGED' then
    raise exception 'PM_IMPORT_COMMITTED: this import was already brought in; change the records themselves instead' using errcode = '55000';
  end if;
  delete from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id;
  get diagnostics v_n = row_count;
  update pm.import_batches set status = 'DISCARDED', discarded_at = now(), discarded_by = pm.current_user_id(), updated_at = now()
   where id = b.id;
  return jsonb_build_object('batch_id', b.id, 'status', 'DISCARDED', 'rows_removed', v_n);
end $$;

create or replace function pm.import_save_mapping(p_location uuid, p_source_system text, p_entity text, p_header_signature text, p_mapping jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_id uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if pm.import_entity_disposition(lower(p_entity)) is null then raise exception 'PM_INVALID: unknown import entity %', p_entity using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_mapping, 'null'::jsonb)) <> 'object' then raise exception 'PM_INVALID: mapping must be an object' using errcode = '22023'; end if;
  if (select count(*) from jsonb_object_keys(p_mapping)) > 80 then raise exception 'PM_INVALID: too many mapped columns' using errcode = '22023'; end if;
  insert into pm.import_mappings as m (org_id, location_id, source_system, entity, header_signature, mapping)
  values (v_org, p_location, upper(btrim(p_source_system)), lower(btrim(p_entity)), left(p_header_signature, 128), p_mapping)
  on conflict (org_id, location_id, source_system, entity) do update
    set header_signature = excluded.header_signature, mapping = excluded.mapping, use_count = m.use_count + 1,
        updated_by = pm.current_user_id(), updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Commit — one row at a time (each in its own subtransaction), match at the door first
-- ----------------------------------------------------------------------------
-- Each returns {outcome, target_table, target_id, message, match, data}.
create or replace function pm._import_commit_customer(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_name text := pm._import_txt(d, 'name'); v_id uuid; v_existing uuid; m jsonb; v_outcome text; v_msg text[] := '{}';
  v_email text := pm._import_txt(d, 'email'); v_phone text := pm._import_txt(d, 'phone'); v_site uuid; v_contact uuid;
  v_addr text := concat_ws(', ', pm._import_txt(d, 'address_line1'), pm._import_txt(d, 'city'), concat_ws(' ', pm._import_txt(d, 'state'), pm._import_txt(d, 'zip')));
begin
  if v_name is null then raise exception 'PM_INVALID: a customer needs a name' using errcode = '22023'; end if;
  v_existing := pm._import_ref(b.org_id, b.location_id, b.source_system, 'customer', r.external_ref);
  if v_existing is not null and exists (select 1 from core.customers c where c.id = v_existing and c.deleted_at is null) then
    return jsonb_build_object('outcome', 'SKIPPED', 'target_table', 'customers', 'target_id', v_existing, 'message', 'Already brought in');
  end if;
  m := pm._import_find_party('customer', v_name, v_email, v_phone, nullif(v_addr, ''));
  if pm._import_links(m) then
    v_id := (m ->> 'id')::uuid; v_outcome := 'MATCHED';
    v_msg := v_msg || format('Linked to your existing customer %s', m ->> 'name');
  else
    select c.id into v_existing from core.customers c
     where c.org_id = b.org_id and c.deleted_at is null and pm.party_name_key(c.name) = pm.party_name_key(v_name) limit 1;
    v_id := pm.create_customer(v_name, v_email, v_phone, b.location_id, pm._import_txt(d, 'contact_first'), pm._import_txt(d, 'contact_last'));
    v_outcome := case when v_existing is not null and v_existing = v_id then 'MATCHED' else 'CREATED' end;
    if v_outcome = 'MATCHED' then v_msg := v_msg || 'Same name as an existing customer; linked'::text; end if;
    if (m ->> 'level') = 'likely' then v_msg := v_msg || format('Looks like %s; queued for duplicate review', m ->> 'name'); end if;
  end if;
  if pm._import_txt(d, 'address_line1') is not null then
    v_site := core.create_site(v_id, b.location_id, pm._import_txt(d, 'site_name'), pm._import_txt(d, 'address_line1'),
                               pm._import_txt(d, 'address_line2'), pm._import_txt(d, 'city'), pm._import_txt(d, 'state'), pm._import_txt(d, 'zip'),
                               pm._import_txt(d, 'access_notes'), null);
  end if;
  if coalesce(pm._import_txt(d, 'contact_first'), pm._import_txt(d, 'contact_last'), pm._import_txt(d, 'contact_email'),
              pm._import_txt(d, 'contact_phone'), v_email, v_phone) is not null then
    v_contact := core.create_contact(v_id, null,
      coalesce(pm._import_txt(d, 'contact_first'), case when pm._import_txt(d, 'contact_last') is null then left(v_name, 100) end),
      pm._import_txt(d, 'contact_last'), coalesce(pm._import_txt(d, 'contact_email'), v_email),
      coalesce(pm._import_txt(d, 'contact_phone'), v_phone), null, '{}'::text[], true, false, false, false, false);
  end if;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'customer', r.external_ref, 'customers', v_id, b.id);
  return jsonb_build_object('outcome', v_outcome, 'target_table', 'customers', 'target_id', v_id, 'match', m,
                            'message', nullif(array_to_string(v_msg, '; '), ''),
                            'data', jsonb_build_object('_site_id', v_site, '_contact_id', v_contact));
end $$;

create or replace function pm._import_commit_vendor(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_name text := pm._import_txt(d, 'name'); v_id uuid; v_existing uuid; m jsonb; v_outcome text; v_msg text;
  v_kind text := upper(coalesce(pm._import_txt(d, 'kind'), 'SUBCONTRACTOR'));
begin
  if v_name is null then raise exception 'PM_INVALID: a vendor needs a name' using errcode = '22023'; end if;
  if v_kind not in ('SUBCONTRACTOR','SUPPLIER','OTHER') then v_kind := 'OTHER'; end if;
  v_existing := pm._import_ref(b.org_id, b.location_id, b.source_system, 'vendor', r.external_ref);
  if v_existing is not null and exists (select 1 from core.vendors v where v.id = v_existing and v.deleted_at is null) then
    return jsonb_build_object('outcome', 'SKIPPED', 'target_table', 'vendors', 'target_id', v_existing, 'message', 'Already brought in');
  end if;
  m := pm._import_find_party('vendor', v_name, pm._import_txt(d, 'email'), pm._import_txt(d, 'phone'), null);
  if pm._import_links(m) then
    v_id := (m ->> 'id')::uuid; v_outcome := 'MATCHED'; v_msg := format('Linked to your existing vendor %s', m ->> 'name');
    insert into pm.vendor_profiles (org_id, vendor_id, kind, location_id, created_by)
    values (b.org_id, v_id, v_kind, b.location_id, pm.current_user_id()) on conflict (org_id, vendor_id) do nothing;
  else
    select v.id into v_existing from core.vendors v
     where v.org_id = b.org_id and v.deleted_at is null and pm.party_name_key(v.name) = pm.party_name_key(v_name) limit 1;
    v_id := pm.create_vendor(v_name, pm._import_txt(d, 'email'), pm._import_txt(d, 'phone'), v_kind, b.location_id);
    v_outcome := case when v_existing is not null and v_existing = v_id then 'MATCHED' else 'CREATED' end;
    if (m ->> 'level') = 'likely' then v_msg := format('Looks like %s; queued for duplicate review', m ->> 'name'); end if;
  end if;
  if coalesce(pm._import_txt(d, 'contact_first'), pm._import_txt(d, 'contact_last')) is not null then
    perform core.create_contact(null, v_id, pm._import_txt(d, 'contact_first'), pm._import_txt(d, 'contact_last'),
      pm._import_txt(d, 'email'), pm._import_txt(d, 'phone'), null, '{}'::text[], true, false, false, false, false);
  end if;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'vendor', r.external_ref, 'vendors', v_id, b.id);
  return jsonb_build_object('outcome', v_outcome, 'target_table', 'vendors', 'target_id', v_id, 'match', m, 'message', v_msg);
end $$;

create or replace function pm._import_commit_contact(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; c jsonb; v_vendor uuid; v_cust uuid; v_id uuid; v_before boolean;
begin
  if pm._import_txt(d, 'vendor_name') is not null then
    v_vendor := (pm._import_vendor_for(b, pm._import_txt(d, 'vendor_name'), null, false) ->> 'id')::uuid;
    if v_vendor is null then raise exception 'PM_INVALID: vendor % is not in this import or your vendors', pm._import_txt(d, 'vendor_name') using errcode = '22023'; end if;
  else
    c := pm._import_customer_for(b, d, false);
    v_cust := (c ->> 'id')::uuid;
    if v_cust is null then
      raise exception 'PM_INVALID: customer % is not in this import or your customers — bring the customer file in first',
        coalesce(pm._import_txt(d, 'customer_name'), pm._import_txt(d, 'customer_ref'), '(blank)') using errcode = '22023';
    end if;
  end if;
  select count(*) > 0 into v_before from core.contacts k where k.org_id = b.org_id and k.customer_id is not distinct from v_cust and k.vendor_id is not distinct from v_vendor;
  v_id := core.create_contact(v_cust, v_vendor, pm._import_txt(d, 'first_name'), pm._import_txt(d, 'last_name'), pm._import_txt(d, 'email'),
    pm._import_txt(d, 'phone'), pm._import_txt(d, 'title'),
    coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(d -> 'roles') = 'array' then d -> 'roles' else '[]'::jsonb end)), '{}'::text[]),
    coalesce((d ->> 'is_primary')::boolean, false), false, false, false, false);
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'contact', r.external_ref, 'contacts', v_id, b.id);
  return jsonb_build_object('outcome', case when v_before and exists (select 1 from core.contacts k where k.id = v_id and k.created_at < now()) then 'MATCHED' else 'CREATED' end,
                            'target_table', 'contacts', 'target_id', v_id);
end $$;

create or replace function pm._import_commit_site(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_cust uuid; v_id uuid; v_existed boolean;
begin
  v_cust := (pm._import_customer_for(b, d, pm._import_txt(d, 'customer_name') is not null) ->> 'id')::uuid;
  if v_cust is null then raise exception 'PM_INVALID: this location has no customer we can find — bring the customer file in first' using errcode = '22023'; end if;
  select exists (select 1 from core.sites s where s.customer_id = v_cust and core.party_norm_text(s.address_line1) = core.party_norm_text(pm._import_txt(d, 'address_line1'))) into v_existed;
  v_id := core.create_site(v_cust, b.location_id, pm._import_txt(d, 'name'), pm._import_txt(d, 'address_line1'), pm._import_txt(d, 'address_line2'),
    pm._import_txt(d, 'city'), pm._import_txt(d, 'state'), pm._import_txt(d, 'zip'), pm._import_txt(d, 'access_notes'), null);
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'site', r.external_ref, 'sites', v_id, b.id);
  return jsonb_build_object('outcome', case when v_existed then 'MATCHED' else 'CREATED' end, 'target_table', 'sites', 'target_id', v_id,
                            'data', jsonb_build_object('_customer_id', v_cust));
end $$;

create or replace function pm._import_commit_job(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_name text := pm._import_txt(d, 'name'); v_existing uuid; c jsonb; v_cust uuid; v_jt text; v_job uuid;
  v_contract bigint; v_orig bigint := coalesce(pm._import_cents(d, 'original_contract_cents'), 0); v_co bigint := coalesce(pm._import_cents(d, 'approved_co_cents'), 0);
  v_status text := lower(coalesce(pm._import_txt(d, 'status'), 'active')); v_stage text; v_core text; v_msg text[] := '{}'; v_machine text;
begin
  if v_name is null then raise exception 'PM_INVALID: a job needs a name' using errcode = '22023'; end if;
  v_existing := pm._import_job_for(b, r.external_ref);
  if v_existing is not null then
    return jsonb_build_object('outcome', 'SKIPPED', 'target_table', 'jobs', 'target_id', v_existing, 'message', 'Already here (same job number)');
  end if;
  c := pm._import_customer_for(b, d, true);
  v_cust := (c ->> 'id')::uuid;
  if c ->> 'how' = 'created' then v_msg := v_msg || 'added the customer'::text; end if;
  select jt.key, jt.stage_machine_key into v_jt, v_machine from pm.job_types jt
   where jt.org_id = b.org_id and jt.location_id = b.location_id and jt.is_active and jt.key = pm._import_txt(d, 'job_type_key');
  if v_jt is null then
    select jt.key, jt.stage_machine_key into v_jt, v_machine from pm.job_types jt
     where jt.org_id = b.org_id and jt.location_id = b.location_id and jt.is_active order by jt.sort, jt.key limit 1;
    if v_jt is null then raise exception 'PM_NO_PACK: set this company up first, then bring its jobs in' using errcode = 'P0002'; end if;
    if pm._import_txt(d, 'job_type_key') is not null then v_msg := v_msg || format('job type %s not found; used %s', d ->> 'job_type_key', v_jt); end if;
  end if;
  v_contract := coalesce(pm._import_cents(d, 'contract_cents'), nullif(v_orig + v_co, 0));
  v_job := pm.create_project(b.location_id, v_jt, left(v_name, 200), v_cust, case when coalesce(v_contract, 0) > 0 then v_contract end, false,
    jsonb_strip_nulls(jsonb_build_object('_source', 'import', '_source_system', b.source_system, '_source_ref', 'import:' || lower(b.source_system) || ':' || coalesce(r.external_ref, 'row' || r.row_number),
      '_import_batch_id', b.id, '_import_row', r.row_number, '_external_id', r.external_ref, '_source_status', pm._import_txt(d, 'status_raw'),
      '_opening_original_contract_cents', nullif(v_orig, 0), '_opening_approved_co_cents', nullif(v_co, 0))));
  if pm._import_txt(d, 'start_date') is not null or pm._import_txt(d, 'site_address') is not null then
    update pm.projects set planned_start = coalesce(pm._import_date(d, 'start_date'), planned_start),
                           site_address_line1 = coalesce(pm._import_txt(d, 'site_address'), site_address_line1)
     where job_id = v_job;
  end if;
  -- a job already under way does not sit in the pack's first (bid) stage
  if v_status in ('active','on_hold') then
    select s.stage_key, s.core_status into v_stage, v_core from pm.stage_defs s
     where s.org_id = b.org_id and s.location_id = b.location_id and s.machine_key = v_machine and s.is_active and not s.is_terminal
       and s.core_status = case when v_status = 'on_hold' then 'ON_HOLD' else 'ACTIVE' end
     order by s.sort, s.stage_key limit 1;
    if v_stage is not null then
      begin
        update pm.projects set stage_key = v_stage where job_id = v_job and stage_key is distinct from v_stage;
        update core.jobs set status = v_core where id = v_job and status is distinct from v_core;
      exception when others then
        v_msg := v_msg || 'left in the first stage'::text;
      end;
    end if;
  end if;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'job', r.external_ref, 'jobs', v_job, b.id);
  return jsonb_build_object('outcome', 'CREATED', 'target_table', 'jobs', 'target_id', v_job, 'match', c -> 'match',
                            'message', nullif(array_to_string(v_msg, '; '), ''), 'data', jsonb_build_object('_customer_id', v_cust, '_job_type_key', v_jt));
end $$;

create or replace function pm._import_commit_budget(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d jsonb := r.data; v_job uuid; v_cc uuid; v_budget uuid; v_line uuid; v_amount bigint := pm._import_cents(d, 'amount_cents');
begin
  if pm._import_ref(b.org_id, b.location_id, b.source_system, 'budget', r.external_ref) is not null then
    return jsonb_build_object('outcome', 'SKIPPED', 'message', 'Already brought in');
  end if;
  v_job := pm._import_job_for(b, pm._import_txt(d, 'job_ref'));
  if v_job is null then raise exception 'PM_INVALID: job % is not here yet — bring the jobs file in first', coalesce(d ->> 'job_ref', '(blank)') using errcode = '22023'; end if;
  if v_amount is null or v_amount < 0 then raise exception 'PM_INVALID: budget amount must be zero or more' using errcode = '22023'; end if;
  v_cc := pm._import_cost_code_for(b, pm._import_txt(d, 'cost_code'), coalesce(pm._import_txt(d, 'cost_type'), 'OTHER'));
  if v_cc is null then raise exception 'PM_INVALID: cost code % is not in your cost codes', coalesce(d ->> 'cost_code', '(blank)') using errcode = '22023'; end if;
  select x.id into v_budget from pm.budgets x where x.org_id = b.org_id and x.job_id = v_job and x.kind = 'ORIGINAL' order by x.version limit 1;
  if v_budget is null then
    insert into pm.budgets (org_id, job_id, kind, version, status, label, as_of)
    values (b.org_id, v_job, 'ORIGINAL', 1, 'DRAFT', 'Imported budget', current_date) returning id into v_budget;
  end if;
  insert into pm.budget_lines (org_id, budget_id, cost_code_id, description, amount_cents, sort)
  values (b.org_id, v_budget, v_cc, left(coalesce(pm._import_txt(d, 'description'), pm._import_txt(d, 'cost_code')), 200), v_amount, r.row_number)
  returning id into v_line;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'budget', r.external_ref, 'budget_lines', v_line, b.id);
  return jsonb_build_object('outcome', 'CREATED', 'target_table', 'budget_lines', 'target_id', v_line, 'data', jsonb_build_object('_job_id', v_job));
end $$;

create or replace function pm._import_commit_sov_line(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d jsonb := r.data; v_job uuid; v_ver uuid; v_contract uuid; v_line uuid; v_no int; v_sched bigint := coalesce(pm._import_cents(d, 'scheduled_value_cents'), 0);
begin
  v_job := pm._import_job_for(b, pm._import_txt(d, 'job_ref'));
  if v_job is null then raise exception 'PM_INVALID: job % is not here yet — bring the jobs file in first', coalesce(d ->> 'job_ref', '(blank)') using errcode = '22023'; end if;
  if v_sched < 0 then raise exception 'PM_INVALID: scheduled value must be zero or more' using errcode = '22023'; end if;
  select k.id into v_contract from pm.contracts k where k.org_id = b.org_id and k.job_id = v_job and k.status = 'ACTIVE' order by k.created_at limit 1;
  select v.id into v_ver from pm.sov_versions v where v.org_id = b.org_id and v.job_id = v_job and v.status = 'DRAFT' order by v.version desc limit 1;
  if v_ver is null then
    if exists (select 1 from pm.sov_versions v where v.org_id = b.org_id and v.job_id = v_job and v.status = 'ACTIVE') then
      return jsonb_build_object('outcome', 'REFERENCE', 'message', 'The job already has an active schedule of values; kept for the opening position only',
                                'data', jsonb_build_object('_job_id', v_job));
    end if;
    insert into pm.sov_versions (org_id, job_id, contract_id, version, status, memo)
    values (b.org_id, v_job, v_contract, null, 'DRAFT', 'Imported schedule of values (billed to date kept with the opening position)')
    returning id into v_ver;
  end if;
  v_no := coalesce(nullif(d ->> 'line_no', '')::int, (select coalesce(max(l.line_no), 0) + 1 from pm.sov_lines l where l.org_id = b.org_id and l.sov_version_id = v_ver));
  insert into pm.sov_lines (org_id, sov_version_id, line_no, cost_code_id, description, scheduled_value_cents, sort)
  values (b.org_id, v_ver, v_no, pm._import_cost_code_for(b, pm._import_txt(d, 'cost_code'), null),
          left(coalesce(pm._import_txt(d, 'description'), 'Line ' || v_no), 200), v_sched, v_no)
  on conflict (org_id, sov_version_id, line_no) do nothing
  returning id into v_line;
  if v_line is null then
    return jsonb_build_object('outcome', 'SKIPPED', 'message', format('Line %s is already on the schedule of values', v_no), 'data', jsonb_build_object('_job_id', v_job));
  end if;
  return jsonb_build_object('outcome', 'CREATED', 'target_table', 'sov_lines', 'target_id', v_line, 'data', jsonb_build_object('_job_id', v_job));
end $$;

create or replace function pm._import_commit_equipment(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_cust uuid; v_id uuid; v_serial text := pm._import_txt(d, 'serial_number'); v_make text := pm._import_txt(d, 'make');
  v_type text := upper(coalesce(pm._import_txt(d, 'equipment_type'), ''));
begin
  if v_serial is not null then
    select a.id into v_id from pm.assets a where a.org_id = b.org_id and lower(a.serial_number) = lower(v_serial) and lower(coalesce(a.make, '')) = lower(coalesce(v_make, ''));
    if v_id is not null then return jsonb_build_object('outcome', 'MATCHED', 'target_table', 'assets', 'target_id', v_id, 'message', 'Same serial already recorded'); end if;
  end if;
  v_cust := (pm._import_customer_for(b, d, true) ->> 'id')::uuid;
  if v_cust is null then raise exception 'PM_INVALID: equipment needs the customer who owns it' using errcode = '22023'; end if;
  insert into pm.assets (org_id, location_id, kind, customer_id, serial_number, make, model, model_year, description, site_address_line1, site_city,
                         site_state, site_zip, installed_on, warranty_expires_on, equipment_type, ext, created_by)
  values (b.org_id, b.location_id, 'CUSTOMER_EQUIPMENT', v_cust, v_serial, v_make, pm._import_txt(d, 'model'), nullif(d ->> 'model_year', '')::int,
          left(pm._import_txt(d, 'description'), 500), pm._import_txt(d, 'site_address'), pm._import_txt(d, 'city'), pm._import_txt(d, 'state'),
          pm._import_txt(d, 'zip'), pm._import_date(d, 'installed_on'), pm._import_date(d, 'warranty_expires_on'),
          case when v_type in ('AC_CONDENSER','HEAT_PUMP','FURNACE','AIR_HANDLER','COIL','BOILER','MINI_SPLIT','PACKAGE_UNIT','THERMOSTAT','WATER_HEATER',
                               'TANKLESS_WATER_HEATER','WATER_SOFTENER','SUMP_PUMP','SEWER_LINE','PANEL','GENERATOR','EV_CHARGER','IAQ','OTHER') then v_type end,
          jsonb_strip_nulls(jsonb_build_object('_import_batch_id', b.id, '_source_system', b.source_system, '_external_id', r.external_ref,
                                               '_source_type', nullif(v_type, ''))), pm.current_user_id())
  returning id into v_id;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'equipment', r.external_ref, 'assets', v_id, b.id);
  return jsonb_build_object('outcome', 'CREATED', 'target_table', 'assets', 'target_id', v_id, 'data', jsonb_build_object('_customer_id', v_cust));
end $$;

-- Opening dealer unit (no DEALER_UNIT_RECEIVED to Books: Books loads the unit's cost basis and floor-plan
-- note from the DEALER_UNITS opening handoff through its own OPENING import).
create or replace function pm._import_commit_unit(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; a pm.assets%rowtype; v_serial text := pm._import_txt(d, 'serial_number'); v_make text := pm._import_txt(d, 'make');
  v_cond text := upper(coalesce(pm._import_txt(d, 'condition'), case when r.entity = 'rental_unit' then 'RENTAL' else 'NEW' end));
  v_status text; v_mfr uuid; v_lender uuid; v_stock text := pm._import_txt(d, 'stock_number'); v_cost bigint := coalesce(pm._import_cents(d, 'cost_cents'), 0);
  v_floor bigint := coalesce(pm._import_cents(d, 'floor_balance_cents'), 0); s pm.dealer_settings%rowtype;
begin
  if v_serial is null then raise exception 'PM_INVALID: a unit needs a serial number' using errcode = '22023'; end if;
  if v_cond not in ('NEW','USED','DEMO','RENTAL') then raise exception 'PM_INVALID: condition % is not NEW / USED / DEMO / RENTAL', v_cond using errcode = '22023'; end if;
  if v_cost < 0 or v_floor < 0 then raise exception 'PM_INVALID: cost and floor-plan balance must be zero or more' using errcode = '22023'; end if;
  select * into a from pm.assets x where x.org_id = b.org_id and lower(x.serial_number) = lower(v_serial) and lower(coalesce(x.make, '')) = lower(coalesce(v_make, ''));
  if a.id is not null then
    return jsonb_build_object('outcome', 'MATCHED', 'target_table', 'assets', 'target_id', a.id, 'message', 'Same serial already recorded',
                              'data', jsonb_build_object('_asset_id', a.id));
  end if;
  v_status := case when upper(coalesce(pm._import_txt(d, 'unit_status'), '')) in ('ON_ORDER','IN_TRANSIT','IN_STOCK','DEMO','RENTAL','ON_HOLD')
                   then upper(pm._import_txt(d, 'unit_status'))
                   else case v_cond when 'DEMO' then 'DEMO' when 'RENTAL' then 'RENTAL' else 'IN_STOCK' end end;
  if v_make is not null then v_mfr := (pm._import_vendor_for(b, v_make, 'SUPPLIER', true) ->> 'id')::uuid; end if;
  if pm._import_txt(d, 'floor_lender') is not null then v_lender := (pm._import_vendor_for(b, pm._import_txt(d, 'floor_lender'), 'OTHER', true) ->> 'id')::uuid; end if;
  if v_stock is not null and exists (select 1 from pm.assets x where x.org_id = b.org_id and upper(x.stock_number) = upper(v_stock)) then
    raise exception 'PM_STOCK_NUMBER_TAKEN: stock number % is already used', v_stock using errcode = '23505';
  end if;
  s := pm.dealer_settings_row(b.org_id, b.location_id);
  insert into pm.assets (org_id, location_id, kind, serial_number, make, model, model_year, description, ext, created_by)
  values (b.org_id, b.location_id, case v_cond when 'RENTAL' then 'RENTAL_UNIT' else 'DEALER_UNIT' end, v_serial, v_make, pm._import_txt(d, 'model'),
          nullif(d ->> 'model_year', '')::int, left(pm._import_txt(d, 'description'), 500),
          jsonb_strip_nulls(jsonb_build_object('_import_batch_id', b.id, '_source_system', b.source_system, '_external_id', r.external_ref,
                                               '_opening_floor_balance_cents', nullif(v_floor, 0))), pm.current_user_id())
  returning * into a;
  update pm.assets x set
    vin = pm._import_txt(d, 'vin'), category = pm._import_txt(d, 'category'), mfr_vendor_id = v_mfr, condition = v_cond, unit_status = v_status,
    unit_life = 1, stock_number = coalesce(v_stock, pm.dealer_mint_stock_number(b.org_id, v_cond)), stock_location_id = s.unit_stock_location_id,
    received_on = coalesce(pm._import_date(d, 'received_on'), current_date), retail_price_cents = pm._import_cents(d, 'list_price_cents'),
    floored = v_floor > 0, floor_lender_vendor_id = case when v_floor > 0 then v_lender end, floor_note_ref = case when v_floor > 0 then pm._import_txt(d, 'floor_note_ref') end,
    meter_reading = nullif(d ->> 'hours', '')::numeric
  where x.id = a.id;
  if v_cost > 0 then
    insert into pm.dealer_unit_costs (org_id, location_id, asset_id, unit_life, cost_type, amount_cents, source, vendor_id, memo, source_ref, created_by)
    values (b.org_id, b.location_id, a.id, 1, 'BASE_INVOICE', v_cost, 'MANUAL', v_mfr, 'Opening balance (import; Books loads the GL basis)',
            'pm:import:' || b.id::text || ':' || r.row_number, pm.current_user_id());
  end if;
  perform pm.dealer_refresh_unit_cost(a.id);
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, r.entity, coalesce(r.external_ref, v_serial), 'assets', a.id, b.id);
  return jsonb_build_object('outcome', 'CREATED', 'target_table', 'assets', 'target_id', a.id,
                            'data', jsonb_build_object('_asset_id', a.id, '_mfr_vendor_id', v_mfr, '_lender_vendor_id', v_lender));
end $$;

create or replace function pm._import_commit_part(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d jsonb := r.data; v_pn text := upper(pm._import_txt(d, 'part_number')); v_mfr text := upper(pm._import_txt(d, 'manufacturer'));
  v_existed uuid; v_id uuid; v_item uuid; v_uom text; v_sl uuid; v_qty numeric := coalesce(nullif(d ->> 'on_hand', '')::numeric, 0);
  s pm.dealer_settings%rowtype;
begin
  if v_pn is null then raise exception 'PM_INVALID: a part needs a part number' using errcode = '22023'; end if;
  if v_qty < 0 then raise exception 'PM_INVALID: on hand can''t be negative' using errcode = '22023'; end if;
  select p.id into v_existed from pm.parts p where p.org_id = b.org_id and p.location_id = b.location_id
     and upper(coalesce(p.manufacturer, '')) = coalesce(v_mfr, '') and upper(btrim(p.part_number)) = v_pn;
  v_id := pm.upsert_part(b.location_id, v_pn, coalesce(pm._import_txt(d, 'description'), v_pn),
    jsonb_strip_nulls(jsonb_build_object('manufacturer', v_mfr, 'uom', pm._import_txt(d, 'uom'), 'category', pm._import_txt(d, 'category'),
      'cost_cents', pm._import_cents(d, 'cost_cents'), 'price_cents', pm._import_cents(d, 'price_cents'),
      'list_price_cents', pm._import_cents(d, 'list_price_cents'))));
  select p.item_id, p.uom into v_item, v_uom from pm.parts p where p.id = v_id;
  if pm._import_txt(d, 'bin') is not null or v_qty > 0 then
    s := pm.dealer_settings_row(b.org_id, b.location_id);
    v_sl := s.parts_stock_location_id;
    if v_sl is null then
      select x.id into v_sl from pm.stock_locations x where x.org_id = b.org_id and x.location_id = b.location_id and x.code = 'PARTS';
      if v_sl is null then
        insert into pm.stock_locations (org_id, location_id, code, name, kind) values (b.org_id, b.location_id, 'PARTS', 'Parts room', 'WAREHOUSE')
        returning id into v_sl;
      end if;
    end if;
    insert into pm.stock_targets (org_id, stock_location_id, item_id, min_qty, uom, bin)
    values (b.org_id, v_sl, v_item, 0, v_uom, pm._import_txt(d, 'bin'))
    on conflict (stock_location_id, item_id) do update set bin = coalesce(excluded.bin, pm.stock_targets.bin);
    if v_qty > 0 then
      insert into pm.material_moves (org_id, location_id, kind, item_id, description, qty, uom, to_stock_location_id, moved_by, source_ref, notes)
      values (b.org_id, b.location_id, 'ADJUST', v_item, 'Opening on hand (import)', v_qty, v_uom, v_sl, pm.current_user_id(),
              'pm:import:opening-on-hand:' || v_sl::text || ':' || v_item::text, 'Opening quantity (once per part and stock location; later changes are counts); Books values parts inventory from the PARTS_INVENTORY handoff')
      on conflict (org_id, source_ref) do nothing;
    end if;
  end if;
  perform pm._import_put_ref(b.org_id, b.location_id, b.source_system, 'part', coalesce(r.external_ref, coalesce(v_mfr || '-', '') || v_pn), 'parts', v_id, b.id);
  return jsonb_build_object('outcome', case when v_existed is not null then 'MATCHED' else 'CREATED' end, 'target_table', 'parts', 'target_id', v_id,
                            'data', jsonb_build_object('_stock_location_id', v_sl));
end $$;

-- Reference / fact rows: link them to the job / customer / vendor they talk about (no live record).
create or replace function pm._import_commit_reference(b pm.import_batches, r pm.import_rows) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare d jsonb := r.data; v_job uuid; v_cust uuid; v_vendor uuid; v_asset uuid; v_out text := pm.import_entity_disposition(r.entity);
begin
  if pm._import_txt(d, 'job_ref') is not null then v_job := pm._import_job_for(b, pm._import_txt(d, 'job_ref')); end if;
  if coalesce(pm._import_txt(d, 'customer_ref'), pm._import_txt(d, 'customer_name')) is not null then
    v_cust := (pm._import_customer_for(b, d, false) ->> 'id')::uuid;
  end if;
  -- subs / suppliers on commitments are vendor masters: match at the door, create when new
  if r.entity = 'commitment' and pm._import_txt(d, 'vendor_name') is not null then
    v_vendor := (pm._import_vendor_for(b, pm._import_txt(d, 'vendor_name'), case when upper(coalesce(d ->> 'commitment_type', '')) = 'PO' then 'SUPPLIER' else 'SUBCONTRACTOR' end, true) ->> 'id')::uuid;
  end if;
  if pm._import_txt(d, 'unit_serial') is not null then
    select a.id into v_asset from pm.assets a where a.org_id = b.org_id and lower(a.serial_number) = lower(pm._import_txt(d, 'unit_serial')) limit 1;
  end if;
  return jsonb_build_object('outcome', case v_out when 'FACT' then 'FACT' else 'REFERENCE' end,
                            'target_table', case when v_job is not null then 'jobs' end, 'target_id', v_job,
                            'data', jsonb_strip_nulls(jsonb_build_object('_job_id', v_job, '_customer_id', v_cust, '_vendor_id', v_vendor, '_asset_id', v_asset)),
                            'message', case when pm._import_txt(d, 'job_ref') is not null and v_job is null then 'Job not found; kept unlinked' end);
end $$;

create or replace function pm.import_commit(p_batch uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare b pm.import_batches%rowtype; r pm.import_rows%rowtype; res jsonb; v_disp text; v_rows jsonb; v_rep jsonb; v_jt text; e jsonb;
  v_counts jsonb; v_result jsonb; v_msg text; v_idx int; v_src text; v_before uuid[];
begin
  select * into b from pm.import_batches x where x.id = p_batch and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: import % not found in the caller''s organization', p_batch using errcode = '42501'; end if;
  if b.status = 'COMMITTED' then return b.result || jsonb_build_object('batch_id', b.id, 'status', 'COMMITTED', 'replayed', true); end if;
  if b.status <> 'STAGED' then raise exception 'PM_IMPORT_STATE: this import is % and can''t be brought in', lower(b.status) using errcode = '55000'; end if;
  update pm.import_batches set status = 'COMMITTING', updated_at = now() where id = b.id;
  v_disp := pm.import_entity_disposition(b.entity);

  update pm.import_rows x set outcome = 'SKIPPED',
         message = left('Not brought in: ' || coalesce((select string_agg(i ->> 'message', '; ') from jsonb_array_elements(x.issues) i where i ->> 'level' = 'error'), 'invalid row'), 500)
   where x.org_id = b.org_id and x.batch_id = b.id and x.validation = 'INVALID' and x.outcome = 'PENDING';

  if b.entity = 'agreement' then
    -- the 1117 agreement importer, for real this time (customers must already be here)
    select jt.key into v_jt from pm.job_types jt where jt.org_id = b.org_id and jt.location_id = b.location_id and jt.is_active
     order by (jt.archetype = 'recurring_service') desc, jt.sort limit 1;
    select coalesce(jsonb_agg(jsonb_strip_nulls(x.data || jsonb_build_object('external_ref', coalesce(x.external_ref, 'import:' || b.id::text || ':' || x.row_number),
             'customer_id', pm._import_customer_for(b, x.data, false) ->> 'id')) order by x.row_number), '[]'::jsonb)
      into v_rows from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'PENDING';
    if jsonb_array_length(v_rows) > 0 then
      v_src := case when b.source_system in ('FIELDEDGE','SIMPRO','SERVICETITAN','HOUSECALL_PRO','JOBBER') then b.source_system else 'CSV' end;
      v_rep := pm.fs_import_agreements(b.location_id, coalesce(v_jt, 'maintenance'), v_rows, false, v_src);
      v_idx := 0;
      for r in select * from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'PENDING' order by x.row_number loop
        v_idx := v_idx + 1;
        select el into e from jsonb_array_elements(v_rep -> 'errors') el where (el ->> 'row')::int = v_idx limit 1;
        if e is null then
          update pm.import_rows set outcome = 'CREATED', target_table = 'service_agreements',
                 target_id = (select g.id from pm.service_agreements g where g.org_id = b.org_id
                                and g.import_ref = coalesce(r.external_ref, 'import:' || b.id::text || ':' || r.row_number) limit 1)
           where id = r.id;
        else
          update pm.import_rows set outcome = case when e ->> 'error' like 'already imported%' then 'SKIPPED' else 'ERROR' end,
                 message = left(e ->> 'error', 500) where id = r.id;
        end if;
        e := null;
      end loop;
    end if;
  elsif b.entity = 'cost_item' then
    -- the 1117 price-book importer (upsert by code; imported prices kept as locked prices)
    select coalesce(array_agg(p.id), '{}') into v_before from pm.price_book_items p where p.org_id = b.org_id and p.location_id = b.location_id;
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('code', x.data ->> 'code', 'name', x.data ->> 'name',
             'kind', coalesce(x.data ->> 'kind', 'SERVICE'), 'unit', x.data ->> 'unit', 'task_hours', x.data ->> 'task_hours',
             'cost_cents', x.data ->> 'cost_cents', 'price_cents', x.data ->> 'price_cents', 'price_locked', true,
             'customer_description', x.data ->> 'description')) order by x.row_number), '[]'::jsonb)
      into v_rows from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'PENDING';
    if jsonb_array_length(v_rows) > 0 then
      v_rep := pm.fs_import_pricebook(b.location_id, v_rows, false);
      v_idx := 0;
      for r in select * from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'PENDING' order by x.row_number loop
        v_idx := v_idx + 1;
        select el into e from jsonb_array_elements(v_rep -> 'errors') el where (el ->> 'row')::int = v_idx limit 1;
        if e is null then
          update pm.import_rows x set target_table = 'price_book_items',
                 target_id = (select p.id from pm.price_book_items p where p.org_id = b.org_id and p.location_id = b.location_id and p.code = upper(btrim(r.data ->> 'code'))),
                 outcome = case when exists (select 1 from pm.price_book_items p where p.org_id = b.org_id and p.location_id = b.location_id
                                               and p.code = upper(btrim(r.data ->> 'code')) and p.id = any (v_before)) then 'MATCHED' else 'CREATED' end
           where x.id = r.id;
        else
          update pm.import_rows set outcome = 'ERROR', message = left(e ->> 'error', 500) where id = r.id;
        end if;
        e := null;
      end loop;
    end if;
  else
    for r in select * from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'PENDING' order by x.row_number loop
      begin
        res := case
          when v_disp = 'ROSTER' then jsonb_build_object('outcome', 'ROSTER')
          when v_disp in ('FACT','REFERENCE') then pm._import_commit_reference(b, r)
          when b.entity = 'customer' then pm._import_commit_customer(b, r)
          when b.entity = 'vendor' then pm._import_commit_vendor(b, r)
          when b.entity = 'contact' then pm._import_commit_contact(b, r)
          when b.entity = 'site' then pm._import_commit_site(b, r)
          when b.entity = 'job' then pm._import_commit_job(b, r)
          when b.entity = 'budget' then pm._import_commit_budget(b, r)
          when b.entity = 'sov_line' then pm._import_commit_sov_line(b, r)
          when b.entity = 'equipment' then pm._import_commit_equipment(b, r)
          when b.entity in ('unit','rental_unit') then pm._import_commit_unit(b, r)
          when b.entity = 'part' then pm._import_commit_part(b, r)
        end;
        update pm.import_rows x set outcome = res ->> 'outcome', target_table = res ->> 'target_table', target_id = nullif(res ->> 'target_id', '')::uuid,
               match = case when jsonb_typeof(res -> 'match') = 'object' and res -> 'match' <> '{}'::jsonb then res -> 'match' end,
               message = left(res ->> 'message', 500),
               data = x.data || coalesce(case when jsonb_typeof(res -> 'data') = 'object' then jsonb_strip_nulls(res -> 'data') end, '{}'::jsonb)
         where x.id = r.id;
      exception when others then
        get stacked diagnostics v_msg = message_text;
        update pm.import_rows set outcome = 'ERROR', message = left(regexp_replace(v_msg, '^[A-Z_]+: ', ''), 500) where id = r.id;
      end;
    end loop;
  end if;

  select jsonb_object_agg(o, n) into v_counts from (
    select x.outcome as o, count(*)::int as n from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id group by x.outcome) t;
  v_counts := coalesce(v_counts, '{}'::jsonb);
  v_result := jsonb_build_object('batch_id', b.id, 'entity', b.entity, 'disposition', v_disp, 'counts', v_counts,
    'errors', (select coalesce(jsonb_agg(jsonb_build_object('row', x.row_number, 'ref', x.external_ref, 'message', x.message) order by x.row_number), '[]'::jsonb)
                 from (select * from pm.import_rows y where y.org_id = b.org_id and y.batch_id = b.id and y.outcome = 'ERROR' order by y.row_number limit 200) x),
    'matched', (select coalesce(jsonb_agg(jsonb_build_object('row', x.row_number, 'name', x.data ->> 'name', 'linked_to', x.match ->> 'name', 'score', x.match -> 'score') order by x.row_number), '[]'::jsonb)
                  from (select * from pm.import_rows y where y.org_id = b.org_id and y.batch_id = b.id and y.outcome = 'MATCHED' and y.match is not null order by y.row_number limit 200) x),
    'first_job_id', (select x.target_id from pm.import_rows x where x.org_id = b.org_id and x.batch_id = b.id and x.outcome = 'CREATED'
                      and x.target_table = 'jobs' order by x.row_number limit 1));
  if v_rep is not null then v_result := v_result || jsonb_build_object('importer_report', v_rep); end if;
  update pm.import_batches set status = 'COMMITTED', committed_at = now(), committed_by = pm.current_user_id(), result = v_result,
         created_count = coalesce((v_counts ->> 'CREATED')::int, 0), matched_count = coalesce((v_counts ->> 'MATCHED')::int, 0),
         skipped_count = coalesce((v_counts ->> 'SKIPPED')::int, 0), error_count = coalesce((v_counts ->> 'ERROR')::int, 0), updated_at = now()
   where id = b.id;
  perform pm.log_activity(b.org_id, b.location_id, null, 'import.committed', 'import_batches', b.id,
    format('Brought in %s %s rows from %s', coalesce((v_counts ->> 'CREATED')::int, 0) + coalesce((v_counts ->> 'MATCHED')::int, 0), b.entity, coalesce(b.file_name, lower(b.source_system))),
    jsonb_build_object('source_system', b.source_system, 'entity', b.entity, 'counts', v_counts));
  return v_result || jsonb_build_object('status', 'COMMITTED', 'replayed', false);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Opening handoffs to Books + tie-out
-- ----------------------------------------------------------------------------
create or replace function pm.opening_stage_handoff(p_location uuid, p_kind text, p_as_of date, p_payload jsonb, p_facts jsonb,
                                                    p_batch_ids uuid[] default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_kind text := upper(btrim(coalesce(p_kind, ''))); v_id uuid; f jsonb; v_blockers jsonb := '[]'::jsonb; v_totals jsonb;
  v_sum jsonb; k text; v_status text; v_job uuid; v_list text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_kind not in ('JOB_WIP','AGREEMENT_DEFERRED','DEALER_UNITS','OPEN_AR','CUSTOMER_DEPOSITS','PARTS_INVENTORY','WARRANTY_RECEIVABLE') then
    raise exception 'PM_INVALID: unknown opening kind %', p_kind using errcode = '22023';
  end if;
  if p_as_of is null or p_as_of > current_date then raise exception 'PM_INVALID: the opening date must be today or earlier' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_payload -> 'totals', 'null'::jsonb)) <> 'object' then
    raise exception 'PM_INVALID: payload must be an object with totals' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_facts, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_facts, '[]'::jsonb)) > 10000 then
    raise exception 'PM_INVALID: facts must be a list of at most 10,000' using errcode = '22023';
  end if;
  if exists (select 1 from pm.opening_handoffs h where h.org_id = v_org and h.location_id = p_location and h.kind = v_kind and h.status = 'ACCEPTED') then
    raise exception 'PM_OPENING_ACCEPTED: Merit Books already recorded this opening position; reopen it in Books to change it' using errcode = '55000';
  end if;
  v_totals := p_payload -> 'totals';

  if v_kind = 'JOB_WIP' then
    -- every fact is a job on this company; re-foot each total from the facts
    for f in select x from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) x loop
      v_job := pm.access_try_uuid(f ->> 'job_id');
      if v_job is null or not exists (select 1 from pm.projects p where p.org_id = v_org and p.job_id = v_job and p.location_id = p_location) then
        raise exception 'PM_INVALID: job % is not a Projects job on this company', f ->> 'job_id' using errcode = '22023';
      end if;
      if coalesce((f ->> 'revised_contract_cents')::bigint, 0) <= 0 then
        v_blockers := v_blockers || jsonb_build_object('job_id', v_job, 'ref', f ->> 'external_ref', 'message', 'No contract value');
      end if;
      -- the same gate as Books' WIP importer (wipImportBlockers): earned revenue needs an EAC
      if coalesce((f ->> 'estimated_cost_cents')::bigint, 0) <= 0 then
        v_blockers := v_blockers || jsonb_build_object('job_id', v_job, 'ref', f ->> 'external_ref', 'message', 'No estimated cost at completion (EAC)');
      end if;
    end loop;
    select jsonb_build_object(
      'jobs', count(*),
      'revised_contract_cents', coalesce(sum((x ->> 'revised_contract_cents')::bigint), 0),
      'estimated_cost_cents', coalesce(sum((x ->> 'estimated_cost_cents')::bigint), 0),
      'cost_to_date_cents', coalesce(sum((x ->> 'cost_to_date_cents')::bigint), 0),
      'billed_to_date_cents', coalesce(sum((x ->> 'billed_to_date_cents')::bigint), 0),
      'earned_revenue_cents', coalesce(sum((x ->> 'earned_revenue_cents')::bigint), 0),
      'under_billing_cents', coalesce(sum((x ->> 'under_billing_cents')::bigint), 0),
      'over_billing_cents', coalesce(sum((x ->> 'over_billing_cents')::bigint), 0),
      'retainage_receivable_cents', coalesce(sum((x ->> 'retainage_receivable_cents')::bigint), 0),
      'retainage_payable_cents', coalesce(sum((x ->> 'retainage_payable_cents')::bigint), 0),
      'customer_deposits_cents', coalesce(sum((x ->> 'customer_deposits_cents')::bigint), 0),
      'open_commitments_cents', coalesce(sum((x ->> 'open_commitments_cents')::bigint), 0))
      into v_sum from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) x;
    for k in select jsonb_object_keys(v_sum) loop
      if v_totals ? k and (v_totals ->> k)::bigint is distinct from (v_sum ->> k)::bigint then
        raise exception 'PM_INVALID: the % total (%) does not equal the sum of the jobs (%)', k, v_totals ->> k, v_sum ->> k using errcode = '22023';
      end if;
    end loop;
    v_totals := v_sum;
  end if;
  -- Every other kind: the facts are the payload's own list; totals and blockers are computed here from
  -- that list (security review: payload totals / blockers sent by the client are ignored).
  if v_kind <> 'JOB_WIP' then
    v_list := case v_kind when 'DEALER_UNITS' then 'units' when 'OPEN_AR' then 'customers' when 'CUSTOMER_DEPOSITS' then 'deposits'
                          when 'AGREEMENT_DEFERRED' then 'agreements' when 'PARTS_INVENTORY' then 'parts' else 'claims' end;
    if jsonb_typeof(coalesce(p_payload -> v_list, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_payload -> v_list, '[]'::jsonb)) > 20000 then
      raise exception 'PM_INVALID: % must be a list of at most 20,000', v_list using errcode = '22023';
    end if;
    for f in select x from jsonb_array_elements(coalesce(p_payload -> v_list, '[]'::jsonb)) x loop
      if jsonb_typeof(f) <> 'object' then raise exception 'PM_INVALID: every % entry must be an object', v_list using errcode = '22023'; end if;
      foreach k in array array['cost_cents','floor_balance_cents','open_cents','amount_cents','deferred_cents','claims_cents'] loop
        if f ? k and (f ->> k) is not null and (pm._import_cents(f, k) < 0) then
          raise exception 'PM_INVALID: % can''t be negative', k using errcode = '22023';
        end if;
      end loop;
      if v_kind = 'DEALER_UNITS' then
        if nullif(btrim(coalesce(f ->> 'serial_number', '')), '') is null then raise exception 'PM_INVALID: a unit needs a serial number' using errcode = '22023'; end if;
        if coalesce(pm._import_cents(f, 'floor_balance_cents'), 0) > 0 and nullif(btrim(coalesce(f ->> 'floor_lender', '')), '') is null then
          v_blockers := v_blockers || jsonb_build_object('ref', f ->> 'serial_number', 'message', format('%s owes the lender but no lender is named', f ->> 'serial_number'));
        end if;
      elsif v_kind = 'OPEN_AR' and pm.access_try_uuid(f ->> 'customer_id') is not null
            and not exists (select 1 from core.customers c where c.id = pm.access_try_uuid(f ->> 'customer_id') and c.org_id = v_org) then
        raise exception 'PM_INVALID: customer % is not in the caller''s organization', f ->> 'customer_id' using errcode = '22023';
      elsif v_kind = 'PARTS_INVENTORY' and coalesce(nullif(f ->> 'on_hand', '')::numeric, 0) < 0 then
        raise exception 'PM_INVALID: on hand can''t be negative' using errcode = '22023';
      end if;
    end loop;
    select case v_kind
      when 'DEALER_UNITS' then jsonb_build_object('units', count(*),
          'cost_cents', coalesce(sum(coalesce(pm._import_cents(x, 'cost_cents'), 0)), 0),
          'floor_cents', coalesce(sum(coalesce(pm._import_cents(x, 'floor_balance_cents'), 0)), 0),
          'floored_units', count(*) filter (where coalesce(pm._import_cents(x, 'floor_balance_cents'), 0) > 0))
      when 'OPEN_AR' then jsonb_build_object('customers', count(*), 'invoices', coalesce(sum(coalesce(nullif(x ->> 'invoices', '')::int, 0)), 0),
          'open_ar_cents', coalesce(sum(coalesce(pm._import_cents(x, 'open_cents'), 0)), 0))
      when 'CUSTOMER_DEPOSITS' then jsonb_build_object('deposits', count(*), 'deposits_cents', coalesce(sum(coalesce(pm._import_cents(x, 'amount_cents'), 0)), 0))
      when 'AGREEMENT_DEFERRED' then jsonb_build_object('agreements', count(*), 'deferred_cents', coalesce(sum(coalesce(pm._import_cents(x, 'deferred_cents'), 0)), 0),
          'visits_owed', coalesce(sum(coalesce(nullif(x ->> 'visits_remaining', '')::int, 0)), 0))
      when 'PARTS_INVENTORY' then jsonb_build_object('parts', count(*), 'units_on_hand', coalesce(sum(coalesce(nullif(x ->> 'on_hand', '')::numeric, 0)), 0),
          'value_cents', coalesce(sum(round(coalesce(nullif(x ->> 'on_hand', '')::numeric, 0) * coalesce(pm._import_cents(x, 'cost_cents'), 0))), 0)::bigint)
      else jsonb_build_object('claims', count(*), 'claims_cents', coalesce(sum(coalesce(pm._import_cents(x, 'amount_cents'), 0)), 0))
    end into v_totals
    from jsonb_array_elements(coalesce(p_payload -> v_list, '[]'::jsonb)) x;
  end if;

  update pm.opening_handoffs set status = 'SUPERSEDED', updated_at = now()
   where org_id = v_org and location_id = p_location and kind = v_kind and status in ('DRAFT','VALIDATED','SUBMITTED');
  v_status := case when jsonb_array_length(v_blockers) = 0 then 'VALIDATED' else 'DRAFT' end;
  insert into pm.opening_handoffs (org_id, location_id, kind, as_of_date, status, source_batch_ids, payload, totals, blockers)
  values (v_org, p_location, v_kind, p_as_of, v_status, coalesce(p_batch_ids, '{}'), (p_payload - 'blockers') || jsonb_build_object('totals', v_totals), v_totals, v_blockers)
  returning id into v_id;

  if v_kind = 'JOB_WIP' then
    insert into pm.opening_job_facts (org_id, handoff_id, location_id, job_id, external_ref, original_contract_cents, approved_co_cents,
        revised_contract_cents, estimated_cost_cents, cost_to_date_cents, billed_to_date_cents, retainage_receivable_cents, retainage_payable_cents,
        customer_deposits_cents, open_commitments_cents, commitments_billed_cents, earned_revenue_cents, over_billing_cents, under_billing_cents,
        pct_complete, last_pay_app_number, sov, cost_codes)
    select v_org, v_id, p_location, (x ->> 'job_id')::uuid, left(x ->> 'external_ref', 200),
           coalesce((x ->> 'original_contract_cents')::bigint, 0), coalesce((x ->> 'approved_co_cents')::bigint, 0),
           coalesce((x ->> 'revised_contract_cents')::bigint, 0), coalesce((x ->> 'estimated_cost_cents')::bigint, 0),
           coalesce((x ->> 'cost_to_date_cents')::bigint, 0), coalesce((x ->> 'billed_to_date_cents')::bigint, 0),
           coalesce((x ->> 'retainage_receivable_cents')::bigint, 0), coalesce((x ->> 'retainage_payable_cents')::bigint, 0),
           coalesce((x ->> 'customer_deposits_cents')::bigint, 0), coalesce((x ->> 'open_commitments_cents')::bigint, 0),
           coalesce((x ->> 'commitments_billed_cents')::bigint, 0), coalesce((x ->> 'earned_revenue_cents')::bigint, 0),
           coalesce((x ->> 'over_billing_cents')::bigint, 0), coalesce((x ->> 'under_billing_cents')::bigint, 0),
           nullif(x ->> 'pct_complete', '')::numeric, nullif(x ->> 'last_pay_app_number', '')::int,
           case when jsonb_typeof(x -> 'sov') = 'array' then x -> 'sov' else '[]'::jsonb end,
           case when jsonb_typeof(x -> 'cost_codes') = 'array' then x -> 'cost_codes' else '[]'::jsonb end
      from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) x;
  end if;
  return jsonb_build_object('handoff_id', v_id, 'status', v_status, 'totals', v_totals, 'blockers', v_blockers);
end $$;

create or replace function pm.opening_tieout(p_handoff uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare h pm.opening_handoffs%rowtype; v_lines jsonb := '[]'::jsonb; v_controls jsonb := '[]'::jsonb; f record; u jsonb; v_out jsonb;
  v_books bigint; v_books2 bigint; v_rec record; v_gl bigint; v_glcount int; v_seen text[] := '{}'; dl record; v_cost_sum bigint := 0; v_floor_sum bigint := 0;
begin
  select * into h from pm.opening_handoffs x where x.id = p_handoff and x.org_id = public.get_org_id();
  if h.id is null then raise exception 'PM_FORBIDDEN: opening position % not found in the caller''s organization', p_handoff using errcode = '42501'; end if;

  if h.kind = 'JOB_WIP' then
    for f in select x.*, j.job_number, j.name as job_name from pm.opening_job_facts x join core.jobs j on j.id = x.job_id
              where x.org_id = h.org_id and x.handoff_id = h.id order by j.job_number loop
      select coalesce(j.actual_cost_cents, 0)::bigint as cost, coalesce(j.billed_to_date_cents, 0)::bigint as billed,
             coalesce(j.retainage_held_cents, 0)::bigint as ret
        into v_rec from core.jobs j where j.id = f.job_id;
      select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint, count(*)::int into v_gl, v_glcount
        from public.gl_entry_lines l
        join public.gl_entries e on e.id = l.gl_entry_id and e.status = 'POSTED'
        join public.accounts a on a.id = l.account_id
       where l.org_id = h.org_id and l.job_id = f.job_id
         and (a.account_type in ('COGS','OPEX')
              or l.account_id in (select r.account_id from public.account_roles r where r.org_id = h.org_id and r.role_key = 'JOB_WIP'));
      v_lines := v_lines
        || pm._import_tie_line('cost_to_date', format('%s cost to date', f.job_number), f.cost_to_date_cents,
             case when v_glcount > 0 then v_gl when v_rec.cost > 0 then v_rec.cost else 0 end,
             jsonb_build_object('job_id', f.job_id, 'job_number', f.job_number, 'books_source', case when v_glcount > 0 then 'gl_job_lines' else 'books_job_record' end))
        || pm._import_tie_line('billed_to_date', format('%s billed to date', f.job_number), f.billed_to_date_cents,
             coalesce(nullif(v_rec.billed, 0), (select coalesce(sum(i.subtotal_cents), 0)::bigint from public.invoices i
                                                  where i.org_id = h.org_id and i.job_id = f.job_id and i.status not in ('DRAFT','VOIDED'))),
             jsonb_build_object('job_id', f.job_id, 'job_number', f.job_number))
        || case when f.retainage_receivable_cents > 0 or v_rec.ret > 0 then
             pm._import_tie_line('retainage_receivable', format('%s retainage held by the owner', f.job_number), f.retainage_receivable_cents, v_rec.ret,
               jsonb_build_object('job_id', f.job_id, 'job_number', f.job_number)) else '[]'::jsonb end;
    end loop;
    v_controls := jsonb_build_array(
      pm._import_tie_line('JOB_WIP', 'Σ cost to date → work in progress', (h.totals ->> 'cost_to_date_cents')::bigint,
                          pm.import_books_role_net(h.org_id, h.location_id, 'JOB_WIP'), jsonb_build_object('role', 'JOB_WIP')),
      pm._import_tie_line('UNBILLED_RECEIVABLE', 'Σ under-billings → contract asset', (h.totals ->> 'under_billing_cents')::bigint,
                          pm.import_books_role_net(h.org_id, h.location_id, 'UNBILLED_RECEIVABLE'), jsonb_build_object('role', 'UNBILLED_RECEIVABLE')),
      pm._import_tie_line('DEFERRED_REVENUE', 'Σ billings in excess → contract liability', (h.totals ->> 'over_billing_cents')::bigint,
                          -pm.import_books_role_net(h.org_id, h.location_id, 'DEFERRED_REVENUE'), jsonb_build_object('role', 'DEFERRED_REVENUE')),
      pm._import_tie_line('RETAINAGE_RECEIVABLE', 'Σ retainage held by owners', (h.totals ->> 'retainage_receivable_cents')::bigint,
                          pm.import_books_role_net(h.org_id, h.location_id, 'RETAINAGE_RECEIVABLE'), jsonb_build_object('role', 'RETAINAGE_RECEIVABLE')),
      pm._import_tie_line('RETAINAGE_PAYABLE', 'Σ retainage held from subs', (h.totals ->> 'retainage_payable_cents')::bigint,
                          -pm.import_books_role_net(h.org_id, h.location_id, 'RETAINAGE_PAYABLE'), jsonb_build_object('role', 'RETAINAGE_PAYABLE')),
      pm._import_tie_line('CUSTOMER_DEPOSITS', 'Σ customer deposits held (a liability, never revenue)', (h.totals ->> 'customer_deposits_cents')::bigint,
                          -pm.import_books_role_net(h.org_id, h.location_id, 'CUSTOMER_DEPOSITS'), jsonb_build_object('role', 'CUSTOMER_DEPOSITS')));

  elsif h.kind = 'DEALER_UNITS' then
    -- unit by unit: the import vs Books' dealer units + open floor-plan notes (DLR-81)
    for u in select x from jsonb_array_elements(coalesce(h.payload -> 'units', '[]'::jsonb)) x loop
      v_seen := v_seen || upper(btrim(u ->> 'serial_number'));
      v_cost_sum := v_cost_sum + coalesce((u ->> 'cost_cents')::bigint, 0);
      v_floor_sum := v_floor_sum + coalesce((u ->> 'floor_balance_cents')::bigint, 0);
      select du.id, du.cost_cents, du.status,
             (select coalesce(sum(n.principal_balance_cents), 0) from public.floor_plan_notes n where n.unit_id = du.id and n.status in ('OPEN','SOLD_UNPAID','IN_DEFAULT')) as floor,
             (select v.name from public.floor_plan_notes n join public.floor_plan_lines fl on fl.id = n.line_id join core.vendors v on v.id = fl.lender_vendor_id
               where n.unit_id = du.id and n.status in ('OPEN','SOLD_UNPAID','IN_DEFAULT') limit 1) as lender
        into dl from public.dealer_units du
       where du.org_id = h.org_id and du.location_id = h.location_id and upper(btrim(du.serial_number)) = upper(btrim(u ->> 'serial_number')) and du.status <> 'VOID'
       limit 1;
      v_lines := v_lines || jsonb_build_object(
        'key', 'unit', 'serial_number', u ->> 'serial_number', 'stock_number', u ->> 'stock_number', 'label', concat_ws(' ', u ->> 'make', u ->> 'model', u ->> 'serial_number'),
        'source_cost_cents', coalesce((u ->> 'cost_cents')::bigint, 0), 'books_cost_cents', dl.cost_cents,
        'source_floor_cents', coalesce((u ->> 'floor_balance_cents')::bigint, 0), 'books_floor_cents', dl.floor,
        'source_lender', u ->> 'floor_lender', 'books_lender', dl.lender,
        'status', case when dl.id is null then 'missing_in_books'
                       when abs(coalesce(dl.cost_cents, 0) - coalesce((u ->> 'cost_cents')::bigint, 0)) > 100 then 'cost_differs'
                       when abs(coalesce(dl.floor, 0) - coalesce((u ->> 'floor_balance_cents')::bigint, 0)) > 100 then 'floor_differs'
                       when coalesce((u ->> 'floor_balance_cents')::bigint, 0) > 0 and dl.lender is not null and u ->> 'floor_lender' is not null
                            and pm.party_name_key(dl.lender) <> pm.party_name_key(u ->> 'floor_lender') then 'lender_differs'
                       else 'ok' end);
      dl := null;
    end loop;
    for dl in select du.serial_number, du.cost_cents, du.model from public.dealer_units du
               where du.org_id = h.org_id and du.location_id = h.location_id and du.status in ('IN_STOCK','IN_TRANSIT','ON_ORDER','RENTAL')
                 and not (upper(btrim(du.serial_number)) = any (v_seen)) loop
      v_lines := v_lines || jsonb_build_object('key', 'unit', 'serial_number', dl.serial_number, 'label', concat_ws(' ', dl.model, dl.serial_number),
        'source_cost_cents', null, 'books_cost_cents', dl.cost_cents, 'status', 'missing_in_import');
    end loop;
    v_controls := jsonb_build_array(
      pm._import_tie_line('WHOLE_GOODS_INVENTORY', 'Σ unit cost → whole-goods inventory', v_cost_sum,
        pm.import_books_role_net(h.org_id, h.location_id, 'WHOLE_GOODS_INVENTORY') + pm.import_books_role_net(h.org_id, h.location_id, 'USED_WHOLE_GOODS_INVENTORY')
        + pm.import_books_role_net(h.org_id, h.location_id, 'RENTAL_INVENTORY'), jsonb_build_object('role', 'WHOLE_GOODS_INVENTORY')),
      pm._import_tie_line('FLOOR_PLAN_PAYABLE', 'Σ floor-plan balance → floor plan payable', v_floor_sum,
        -pm.import_books_role_net(h.org_id, h.location_id, 'FLOOR_PLAN_PAYABLE'), jsonb_build_object('role', 'FLOOR_PLAN_PAYABLE')));

  elsif h.kind = 'OPEN_AR' then
    for u in select x from jsonb_array_elements(coalesce(h.payload -> 'customers', '[]'::jsonb)) x loop
      select coalesce(sum(i.balance_cents), 0)::bigint into v_books from public.invoices i
       where i.org_id = h.org_id and i.location_id = h.location_id and i.customer_id = pm.access_try_uuid(u ->> 'customer_id')
         and i.status not in ('DRAFT','VOIDED','PAID','WRITTEN_OFF');
      v_lines := v_lines || pm._import_tie_line('customer_open_ar', coalesce(u ->> 'name', 'Customer'), (u ->> 'open_cents')::bigint,
                                                case when u ->> 'customer_id' is null then null else v_books end, jsonb_build_object('customer_id', u ->> 'customer_id'));
    end loop;
    v_controls := jsonb_build_array(pm._import_tie_line('AR_CONTROL', 'Σ open AR → accounts receivable', (h.totals ->> 'open_ar_cents')::bigint,
      pm.import_books_role_net(h.org_id, h.location_id, 'AR_CONTROL'), jsonb_build_object('role', 'AR_CONTROL')));

  elsif h.kind = 'CUSTOMER_DEPOSITS' then
    select coalesce(sum(d.amount_cents - d.applied_cents - d.refunded_cents), 0)::bigint into v_books
      from public.customer_deposits d where d.org_id = h.org_id and d.location_id = h.location_id;
    v_controls := jsonb_build_array(
      pm._import_tie_line('DEPOSITS_HELD', 'Σ deposits held → Books customer deposits', (h.totals ->> 'deposits_cents')::bigint, v_books),
      pm._import_tie_line('CUSTOMER_DEPOSITS', 'Σ deposits → customer deposits liability', (h.totals ->> 'deposits_cents')::bigint,
        -pm.import_books_role_net(h.org_id, h.location_id, 'CUSTOMER_DEPOSITS'), jsonb_build_object('role', 'CUSTOMER_DEPOSITS')));

  elsif h.kind = 'AGREEMENT_DEFERRED' then
    select coalesce(sum(x.amount_cents), 0)::bigint into v_books from pm.agreement_revenue_facts x
     where x.org_id = h.org_id and x.location_id = h.location_id and x.kind = 'OPENING_BALANCE';
    v_controls := jsonb_build_array(
      pm._import_tie_line('SOURCE_REPORT', 'Σ deferred per agreement vs the old system''s deferred report', (h.totals ->> 'deferred_cents')::bigint,
        nullif(h.payload ->> 'source_reported_deferred_cents', '')::bigint),
      pm._import_tie_line('PROJECTS_AGREEMENTS', 'Σ deferred on the imported agreements (Projects)', (h.totals ->> 'deferred_cents')::bigint, v_books),
      pm._import_tie_line('DEFERRED_REVENUE', 'Σ deferred → Books deferred revenue (shared with billings in excess)', (h.totals ->> 'deferred_cents')::bigint,
        -pm.import_books_role_net(h.org_id, h.location_id, 'DEFERRED_REVENUE'), jsonb_build_object('role', 'DEFERRED_REVENUE', 'informational', true)));

  elsif h.kind = 'PARTS_INVENTORY' then
    v_controls := jsonb_build_array(pm._import_tie_line('INVENTORY_ASSET', 'Σ parts on hand × cost → parts inventory', (h.totals ->> 'value_cents')::bigint,
      pm.import_books_role_net(h.org_id, h.location_id, 'INVENTORY_ASSET'), jsonb_build_object('role', 'INVENTORY_ASSET')));

  else -- WARRANTY_RECEIVABLE: Books books the receivable when it loads the claims
    v_controls := jsonb_build_array(pm._import_tie_line('WARRANTY_RECEIVABLE', 'Σ open warranty claims → warranty receivable', (h.totals ->> 'claims_cents')::bigint, null));
  end if;

  v_out := jsonb_build_object('handoff_id', h.id, 'kind', h.kind, 'as_of_date', h.as_of_date, 'lines', v_lines, 'controls', v_controls,
    'summary', jsonb_build_object(
      'ok', (select count(*) from jsonb_array_elements(v_lines || v_controls) z where z ->> 'status' = 'ok'),
      'pending', (select count(*) from jsonb_array_elements(v_lines || v_controls) z where z ->> 'status' = 'pending'),
      'exceptions', (select count(*) from jsonb_array_elements(v_lines || v_controls) z where z ->> 'status' not in ('ok','pending'))),
    'generated_at', now());
  update pm.opening_handoffs set tieout = v_out, tied_at = now(), updated_at = now() where id = h.id;
  return v_out;
end $$;

create or replace function pm.opening_submit_handoff(p_handoff uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare h pm.opening_handoffs%rowtype;
begin
  select * into h from pm.opening_handoffs x where x.id = p_handoff and x.org_id = public.get_org_id() for update;
  if h.id is null then raise exception 'PM_FORBIDDEN: opening position % not found in the caller''s organization', p_handoff using errcode = '42501'; end if;
  if h.status = 'SUBMITTED' then return jsonb_build_object('handoff_id', h.id, 'status', h.status); end if;
  if h.status <> 'VALIDATED' then
    raise exception 'PM_OPENING_NOT_READY: fix the % open item(s) first (the position is %)', jsonb_array_length(h.blockers), lower(h.status) using errcode = '55000';
  end if;
  update pm.opening_handoffs set status = 'SUBMITTED', submitted_at = now(), submitted_by = pm.current_user_id(), updated_at = now() where id = h.id;
  perform pm.log_activity(h.org_id, h.location_id, null, 'opening.submitted', 'opening_handoffs', h.id,
    format('Sent the opening %s position (as of %s) to Merit Books', lower(replace(h.kind, '_', ' ')), h.as_of_date), jsonb_build_object('totals', h.totals));
  return jsonb_build_object('handoff_id', h.id, 'status', 'SUBMITTED');
end $$;

-- Books' answer (service role only): ACCEPTED with its reference (opening JE / import batch id) or REJECTED with a reason.
create or replace function pm.opening_books_decision(p_handoff uuid, p_status text, p_books_ref text, p_reason text default null) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_is_service() then raise exception 'PM_FORBIDDEN: only Merit Books records its decision' using errcode = '42501'; end if;
  if p_status not in ('ACCEPTED','REJECTED') then raise exception 'PM_INVALID: ACCEPTED or REJECTED' using errcode = '22023'; end if;
  update pm.opening_handoffs set status = p_status, books_ref = left(p_books_ref, 200), books_reason = left(p_reason, 1000), decided_at = now(), updated_at = now()
   where id = p_handoff and status = 'SUBMITTED';
  if not found then raise exception 'PM_INVALID: opening position % is not waiting on Books', p_handoff using errcode = '22023'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Crew invites (pack role titles → Projects role templates + Projects-only) and go-live
-- ----------------------------------------------------------------------------
create or replace function pm._crew_invite_apply(i pm.crew_invites, p_membership uuid) returns boolean
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_role uuid; m core.memberships%rowtype;
begin
  select * into m from core.memberships x where x.id = p_membership;
  if m.id is null or m.org_id <> i.org_id then return false; end if;
  perform pm.access_provision_tenant(i.org_id);
  select d.id into v_role from core.role_definitions d where d.owner_level = 'tenant' and d.org_id = i.org_id and d.key = i.role_key;
  if v_role is null then return false; end if;
  if not exists (select 1 from core.access_assignments a where a.membership_id = m.id and a.role_id = v_role and a.scope_type = 'client'
                   and a.location_id = i.location_id and a.status in ('active','pending_approval')) then
    insert into core.access_assignments (org_id, membership_id, grant_type, role_id, scope_type, location_id, source, reason)
    values (i.org_id, m.id, 'role', v_role, 'client', i.location_id, 'invite',
            format('Projects onboarding: %s (%s)', coalesce(i.title, i.role_key), i.name));
  end if;
  if i.projects_only and core.rbac_normalize_legacy_role(m.role) is distinct from 'company_admin' and not m.projects_only then
    update core.memberships set projects_only = true where id = m.id;
  end if;
  update pm.crew_invites set status = 'ACCEPTED', membership_id = m.id, accepted_at = now(), updated_at = now() where id = i.id;
  return true;
end $$;

create or replace function pm.onboarding_invite_crew(p_location uuid, p_people jsonb) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; p jsonb; i pm.crew_invites%rowtype; v_out jsonb := '[]'::jsonb; v_role text; v_email text; v_m uuid; v_po boolean;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_people, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_people) > 200 then
    raise exception 'PM_INVALID: people must be a list of at most 200' using errcode = '22023';
  end if;
  perform pm.access_provision_tenant(v_org);
  for p in select x from jsonb_array_elements(p_people) x loop
    v_role := lower(btrim(coalesce(p ->> 'role_key', '')));
    if v_role = 'projects_owner' or not exists (select 1 from core.role_definitions d where d.owner_level = 'tenant' and d.org_id = v_org and d.key = v_role) then
      raise exception 'PM_INVALID: % is not a Projects role you can invite into', v_role using errcode = '22023';
    end if;
    v_email := lower(nullif(btrim(coalesce(p ->> 'email', '')), ''));
    -- crew (field) roles are Projects-only seats unless the caller says otherwise; office roles are not
    v_po := coalesce((p ->> 'projects_only')::boolean, v_role in ('projects_labor','projects_supervisor'));
    select * into i from pm.crew_invites x where x.org_id = v_org and x.location_id = p_location and x.status = 'PENDING' and v_email is not null and lower(x.email) = v_email;
    if i.id is not null then
      update pm.crew_invites set name = left(coalesce(nullif(btrim(p ->> 'name'), ''), name), 200), phone = coalesce(nullif(btrim(p ->> 'phone'), ''), phone),
             title = left(coalesce(nullif(btrim(p ->> 'title'), ''), title), 80), role_key = v_role, projects_only = v_po, updated_at = now()
       where id = i.id returning * into i;
    else
      insert into pm.crew_invites (org_id, location_id, name, email, phone, title, role_key, projects_only, source, import_row_id, employee_id)
      values (v_org, p_location, left(btrim(coalesce(p ->> 'name', '')), 200), v_email, nullif(btrim(coalesce(p ->> 'phone', '')), ''),
              left(nullif(btrim(coalesce(p ->> 'title', '')), ''), 80), v_role, v_po,
              coalesce(nullif(p ->> 'source', ''), 'manual'), pm.access_try_uuid(p ->> 'import_row_id'), pm.access_try_uuid(p ->> 'employee_id'))
      returning * into i;
    end if;
    -- already a member of the workspace: apply now
    v_m := null;
    if v_email is not null then
      select ms.id into v_m from core.memberships ms join core.users u on u.id = ms.user_id
       where ms.org_id = v_org and lower(u.email) = v_email and coalesce(ms.status, 'active') in ('active','invited') limit 1;
    end if;
    if v_m is not null then perform pm._crew_invite_apply(i, v_m); select * into i from pm.crew_invites x where x.id = i.id; end if;
    v_out := v_out || jsonb_build_object('id', i.id, 'name', i.name, 'email', i.email, 'role_key', i.role_key, 'projects_only', i.projects_only, 'status', i.status);
    i := null;
  end loop;
  return v_out;
end $$;

create or replace function pm.onboarding_cancel_invite(p_invite uuid) returns boolean
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  update pm.crew_invites set status = 'CANCELLED', updated_at = now()
   where id = p_invite and org_id = public.get_org_id() and status = 'PENDING';
  return found;
end $$;

-- A membership that appears (or turns active) claims its pending invites.
create or replace function pm.tg_crew_invite_claim() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_email text; i pm.crew_invites%rowtype;
begin
  if coalesce(new.status, 'active') not in ('active','invited') then return null; end if;
  select lower(u.email) into v_email from core.users u where u.id = new.user_id;
  if v_email is null then return null; end if;
  for i in select * from pm.crew_invites x where x.org_id = new.org_id and x.status = 'PENDING' and lower(x.email) = v_email loop
    perform pm._crew_invite_apply(i, new.id);
  end loop;
  return null;
end $$;
drop trigger if exists trg_membership_crew_invite on core.memberships;
create trigger trg_membership_crew_invite after insert or update of status, user_id on core.memberships
  for each row execute function pm.tg_crew_invite_claim();

-- The go-live switch (step 9): customer messages go live for the company; the held ones the owner
-- reviewed are released (consent re-checked by pm.notify_held_action) or discarded.
create or replace function pm.onboarding_go_live(p_location uuid, p_release uuid[] default '{}', p_discard uuid[] default '{}') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_rel int := 0; v_dis int := 0; v_left int;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if exists (select 1 from core.outbound_messages o where o.id = any (coalesce(p_release, '{}') || coalesce(p_discard, '{}'))
               and (o.org_id <> v_org or o.location_id is distinct from p_location)) then
    raise exception 'PM_INVALID: those messages are not this company''s' using errcode = '22023';
  end if;
  perform pm.notify_configure(p_location, jsonb_build_object('customer_messages_live', true));
  if coalesce(cardinality(p_discard), 0) > 0 then v_dis := pm.notify_held_action(p_discard, 'discard'); end if;
  if coalesce(cardinality(p_release), 0) > 0 then v_rel := pm.notify_held_action(p_release, 'release'); end if;
  select count(*) into v_left from core.outbound_messages o where o.org_id = v_org and o.location_id = p_location and o.status = 'held';
  perform pm.log_activity(v_org, p_location, null, 'company.went_live', 'locations', p_location,
    'Customer messages are live', jsonb_build_object('released', v_rel, 'discarded', v_dis, 'still_held', v_left));
  return jsonb_build_object('live', true, 'released', v_rel, 'discarded', v_dis, 'still_held', v_left);
end $$;

-- ----------------------------------------------------------------------------
-- 7. Access registry, RLS, grants
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('import_batches',    'C','location', '{projects.settings}',   null, null, null, null, null, false, '1121: one uploaded file × entity; written only by pm.import_* RPCs'),
  ('import_rows',       'C','parent',   '{}',                    null, 'import_batches', 'batch_id', null, null, false, '1121: staged rows + outcomes'),
  ('import_mappings',   'C','location', '{projects.settings}',   null, null, null, null, null, false, '1121: saved column mapping per source'),
  ('import_refs',       'C','location', '{projects.settings}',   null, null, null, null, null, false, '1121: external id ledger (idempotent re-imports)'),
  ('opening_handoffs',  'C','location', '{projects.financials}', null, null, null, null, null, false, '1121: opening position handed to Books (money)'),
  ('opening_job_facts', 'M','job',      '{projects.financials}', null, null, null, null, null, false, '1121: mid-stream job opening facts (money)'),
  ('crew_invites',      'C','location', '{projects.team}',       null, null, null, null, null, false, '1121: onboarding crew invites; written only by the invite RPCs')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('import_stage',            '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1121'),
  ('import_save_mapping',     '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1121'),
  ('import_commit',           '{p_batch}',    'perform pm.access_assert_row(''projects.settings'', array[''configure''], ''import_batches'', p_batch);', '1121: nested party / job / agreement / price-book RPCs run under this check'),
  ('import_discard',          '{p_batch}',    'perform pm.access_assert_row(''projects.settings'', array[''configure''], ''import_batches'', p_batch);', '1121'),
  ('opening_stage_handoff',   '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1121'),
  ('opening_submit_handoff',  '{p_handoff}',  'perform pm.access_assert_row(''projects.settings'', array[''configure''], ''opening_handoffs'', p_handoff);', '1121'),
  ('opening_tieout',          '{p_handoff}',  'if not (pm.access_can_row(''projects.financials'', ''view'', ''opening_handoffs'', p_handoff) or pm.access_can_row(''projects.settings'', ''configure'', ''opening_handoffs'', p_handoff)) then perform pm.access_forbid(''requires projects.financials:view or projects.settings:configure''); end if;', '1121: Books balances (money)'),
  ('onboarding_invite_crew',  '{p_location}', 'perform pm.access_assert_location(''projects.team'', array[''edit''], p_location);', '1121'),
  ('onboarding_cancel_invite','{p_invite}',   'perform pm.access_assert_row(''projects.team'', array[''edit''], ''crew_invites'', p_invite);', '1121'),
  ('onboarding_go_live',      '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1121: releases held customer messages')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

do $$
declare t text;
begin
  foreach t in array array['import_batches','import_rows','import_mappings','import_refs','opening_handoffs','opening_job_facts','crew_invites'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select on pm.%I to authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
  end loop;
end $$;

select pm.access_apply_policies();
select pm.access_apply_rpc_guards();

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              'import_entity_disposition','_import_txt','_import_cents','_import_date','_import_ref','_import_put_ref','_import_find_party',
              '_import_links','_import_customer_for','_import_vendor_for','_import_job_for','_import_cost_code_for','import_books_role_net',
              '_import_tie_line','import_stage','import_discard','import_save_mapping','_import_commit_customer','_import_commit_vendor',
              '_import_commit_contact','_import_commit_site','_import_commit_job','_import_commit_budget','_import_commit_sov_line',
              '_import_commit_equipment','_import_commit_unit','_import_commit_part','_import_commit_reference','import_commit',
              'opening_stage_handoff','opening_tieout','opening_submit_handoff','opening_books_decision','_crew_invite_apply',
              'onboarding_invite_crew','onboarding_cancel_invite','tg_crew_invite_claim','onboarding_go_live') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('import_stage','import_discard','import_save_mapping','import_commit','opening_stage_handoff','opening_tieout',
                     'opening_submit_handoff','onboarding_invite_crew','onboarding_cancel_invite','onboarding_go_live',
                     'import_entity_disposition') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1121_pm_imports_onboarding
-- ============================================================================
