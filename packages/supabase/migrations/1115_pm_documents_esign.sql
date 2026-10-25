-- ============================================================================
-- 1115 · Merit Projects — documents & built-in e-signature
--        versioned job documents · folders from pack templates · photo metadata ·
--        drawing sets / sheets / revisions / markups · retention + legal hold ·
--        e-sign envelopes, signers, one-time tokens, audit trail, webhook-style outbox
--
-- Spec: expert-panel PLT-48..52, CGC-60/62/63, RES-26/40/57/89 (docs/projects/WAVE-A-BRIEF.md).
-- Access model: 1110_pm_access.sql (policy classes, guarded definer RPCs).
--
-- REUSE (nothing duplicated)
--   * File bytes stay in the private `documents` Storage bucket (112) under `<org_id>/…`; every file
--     version is ONE public.documents row (090: metadata + storage_path, entity_type 'pm.doc_files').
--     Books' Document Center therefore lists Projects files too (one store, both apps).
--   * public.document_intelligence (188) keeps the content hash for Books; this migration stores the
--     SHA-256 per version (content_sha256, same format check as 188).
--   * pm.document_links (1100) links every version / sheet file to its pm record, which is what makes
--     the bytes visible to Projects-only seats (1110 narrowed seat exception on public.documents).
--     subject_table gains 'doc_files' and 'drawing_sheets'.
--   * Branding: public.brand_profiles (190) read through pm.doc_brand() (Projects-only seats cannot
--     read Books tables directly) — company row unless it uses the tenant brand, then the tenant row.
--
-- WHAT THIS CREATES (schema pm)
--   doc_folder_templates  catalog (no org): folders per pack (CGC-63 "01 Contract … 12 Closeout", etc.)
--   doc_folders           folders per job (pm.doc_ensure_job_folders from the job's pack template)
--   doc_files             one logical document: kind, folder, money_cap, retention class / until,
--                         legal hold, linked record (subject_table / subject_id), soft delete
--   doc_versions          its versions (version_no 1…n, exactly one current; superseded keep history);
--                         locked = signed / immutable
--   doc_photo_meta        per photo (public.documents id): EXIF taken_at, GPS, device; received_at is
--                         the server's time (never client-settable)
--   drawing_sets          an uploaded PDF set (bid / permit / IFC / ASI …) — review → published
--   drawing_sheets        one per job × sheet number; current_revision_id = the current set's sheet
--   drawing_revisions     one page of a set = one revision of a sheet (its own single-page PDF);
--                         extraction text | manual | none; is_current only for published sets
--   drawing_markups       pins, rectangles, clouds, arrows, freehand, text — personal or published
--   doc_template_settings company overrides for the rendered templates (terms, footer, notices)
--   esign_envelopes       one signature request on one exact version (sha-256 pinned)
--   esign_signers         signers in routing order; typed name, drawn signature, consent, IP / UA / time
--   esign_tokens          one-time link tokens (sha-256 only — the raw token never reaches the DB);
--                         NO member grants at all
--   esign_events          the audit trail (append-only; definer-written)
--   esign_outbox          webhook-style events (envelope.completed / envelope.declined / signer.turn)
--                         that the app consumes as an authorized member (lib/esign/callbacks.ts):
--                         stamp the signed PDF + audit certificate as a new version, then react
--                         (accept estimate, approve change order, receive lien waiver, accept buyer's
--                         order quote)
--
-- PUBLIC SIGNING (schema esign — the only anon-executable surface)
--   esign.open(token, ip, ua) / esign.sign(token, typed_name, signature_png, consent, ip, ua) /
--   esign.decline(token, reason, ip, ua) / esign.document(token) (the file route's re-check) — SECURITY DEFINER, search_path pinned, every call starts
--   by matching sha256(token) to an unrevoked, unused, unexpired esign_tokens row; nothing else is
--   reachable. Nothing in pm is executable by anon (1110 invariant kept). The app calls these with the
--   anon key and no session — never the service role.
--   POSTGREST: the lead exposes `esign` (and keeps pm) in pgrst.db_schemas, then
--   `notify pgrst, 'reload config'`. This migration does not alter pgrst.db_schemas.
--
-- ACCESS (1110 classes; all registered in pm.access_table_classes)
--   J job / job_or_location, read projects.documents:view on a reachable job (or at the company for
--     company-level files): doc_folders, doc_files, doc_photo_meta, drawing_sets, drawing_sheets,
--     drawing_revisions, drawing_markups, esign_envelopes; children through their parent
--     (doc_versions → doc_files; esign_signers / tokens / events / outbox → esign_envelopes).
--   S doc_folder_templates (catalog), doc_template_settings (write projects.settings:configure).
--   Money documents: doc_files.money_cap ∈ {projects.contract_value, projects.financials} (contracts,
--     proposals, change orders, pay apps, draws, buyer's orders → contract_value; POs, subcontracts,
--     lien waivers → financials). An extra RESTRICTIVE policy hides the row unless the caller holds
--     that money capability on the job (company for company-level files); doc_versions, envelopes and
--     their children, and the pm.document_links rows of doc_files, follow the file's visibility, so
--     the bytes of a contract never reach Labor / Supervisor / Dispatcher even through Books' table.
--   Markups: personal markups are visible to their author only; published ones to the job.
--     Publishing (or editing a published markup) needs projects.documents:edit on the job.
--   Writes to versions, drawings, envelopes go through definer RPCs (guards in pm.access_rpc_guards);
--     members may rename / move / tag files, add folders, add photo metadata and markups directly.
--   Retention: legal hold blocks new versions, restore and removal; retain_until in the future and any
--     signed (locked) version block removal. Removal is a soft delete (status 'deleted', who / when).
--
-- SECURITY REVIEW (2026-10-25), fixed here
--   H1 storage: RESTRICTIVE storage.objects policies for <org>/pm/… (section 16) — read only what the
--      caller sees through Projects (job reach, money, Projects-only seats), insert only an own pending
--      upload (metadata row first), never update, delete only an own never-filed upload through
--      pm.doc_discard_upload. Only the caller's own <org>/pm/ upload can become a version or sheet.
--   H2 e-sign callbacks: esign_create requires the document to BE the record's document
--      (doc_files.subject_table / subject_id; doc_create checks the subject is on the job and readable)
--      and the sender to hold the action's authority (estimates:edit, change_orders:approve,
--      commitments:edit, store:edit). The record callback runs only as the sender
--      (pm.esign_outbox_settle refuses anyone else) — the action's own guard re-checks the sender's
--      authority then; the trail records who triggered it. Nothing drains on page load.
--   M  public surface: a link that cannot act gets {ok, reason} only. No URL is stored and anon has
--      NO storage access at all: the document bytes are served by the app route
--      /api/sign/public/<token>/file, which re-validates the token on every request
--      (esign.document) and streams that one object; a voided / declined / expired / used link gets
--      410 at once.
--
-- APPLY RULE: after 1110 / 1111 / 1112. Idempotent: safe twice.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1115_pm_documents_esign requires 1110_pm_access';
  end if;
  if to_regclass('public.documents') is null then
    raise exception '1115_pm_documents_esign requires 090_documents';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Folder templates (catalog) + job folders
-- ----------------------------------------------------------------------------
create table if not exists pm.doc_folder_templates (
  pack_key    text primary key check (pack_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  folders     jsonb not null check (jsonb_typeof(folders) = 'array'),
  version     int not null default 1,
  updated_at  timestamptz not null default now()
);
comment on table pm.doc_folder_templates is
  '1115: job folder tree per industry pack: [{key, name, sort, money_cap?, kinds[]}] (kinds auto-file uploads). Merit-published; service_role writes.';

create table if not exists pm.doc_folders (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id       uuid not null,
  parent_id    uuid,
  key          text check (key is null or key ~ '^[a-z0-9][a-z0-9_]{0,47}$'),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  sort         int not null default 0,
  money_cap    text check (money_cap is null or money_cap in ('projects.contract_value','projects.financials')),
  kinds        text[] not null default '{}',
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, parent_id) references pm.doc_folders (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_doc_folders_key_uidx on pm.doc_folders (org_id, job_id, key) where key is not null;
create unique index if not exists pm_doc_folders_name_uidx
  on pm.doc_folders (org_id, job_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
comment on table pm.doc_folders is '1115: folders of a job (from the pack template, plus any a member adds).';

-- ----------------------------------------------------------------------------
-- 2. Logical documents + versions
-- ----------------------------------------------------------------------------
create table if not exists pm.doc_files (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid,
  folder_id           uuid,
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  kind                text not null default 'file' check (kind in (
                        'file','photo','drawing_set','spec','contract','proposal','change_order','pay_app',
                        'draw_request','lien_waiver','work_order','daily_report','install_ticket','po',
                        'subcontract','buyers_order','permit','submittal','rfi','warranty','manual','form',
                        'inspection','closeout','correspondence','other')),
  money_cap           text check (money_cap is null or money_cap in ('projects.contract_value','projects.financials')),
  description         text check (description is null or char_length(description) <= 2000),
  tags                text[] not null default '{}' check (cardinality(tags) <= 20),
  subject_table       text check (subject_table is null or subject_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  subject_id          uuid,
  current_version_id  uuid,
  version_count       int not null default 0,
  retention_class     text not null default 'standard'
                        check (retention_class in ('standard','project_record','contract','financial','safety','permanent')),
  retain_until        date,
  legal_hold          boolean not null default false,
  legal_hold_reason   text check (legal_hold_reason is null or char_length(legal_hold_reason) <= 500),
  legal_hold_by       text,
  legal_hold_at       timestamptz,
  status              text not null default 'active' check (status in ('active','archived','deleted')),
  deleted_at          timestamptz,
  deleted_by          text,
  delete_reason       text,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  check (legal_hold = false or legal_hold_at is not null),
  check (status <> 'deleted' or deleted_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, folder_id) references pm.doc_folders (org_id, id) on delete set null (folder_id) deferrable initially immediate
);
create index if not exists pm_doc_files_job_idx on pm.doc_files (org_id, job_id, folder_id, updated_at desc);
create index if not exists pm_doc_files_loc_idx on pm.doc_files (org_id, location_id, updated_at desc);
create index if not exists pm_doc_files_subject_idx on pm.doc_files (org_id, subject_table, subject_id) where subject_id is not null;
comment on table pm.doc_files is
  '1115: one logical document (many versions). money_cap hides it from callers without that money capability on the job. Retention + legal hold block removal.';

create table if not exists pm.doc_versions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  file_id         uuid not null,
  version_no      int not null check (version_no >= 1),
  document_id     uuid not null references public.documents(id) on delete restrict,
  file_name       text not null check (char_length(file_name) between 1 and 255),
  mime_type       text,
  size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  content_sha256  text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  page_count      int check (page_count is null or page_count >= 0),
  label           text check (label is null or char_length(label) <= 40),
  note            text check (note is null or char_length(note) <= 1000),
  source          text not null default 'upload' check (source in ('upload','template','esign','drawing_split','restore','import')),
  is_current      boolean not null default true,
  superseded_at   timestamptz,
  locked          boolean not null default false,
  meta            jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (file_id, version_no),
  check (is_current or superseded_at is not null),
  foreign key (org_id, file_id) references pm.doc_files (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_doc_versions_current_uidx on pm.doc_versions (file_id) where is_current;
create index if not exists pm_doc_versions_doc_idx on pm.doc_versions (org_id, document_id);
comment on table pm.doc_versions is
  '1115: versions of a document (exactly one current). Written only by the doc_* / esign_* RPCs; locked = signed (immutable).';

-- ----------------------------------------------------------------------------
-- 3. Photo metadata (any public.documents photo: field logs, punch, unit photos, doc_files photos)
-- ----------------------------------------------------------------------------
create table if not exists pm.doc_photo_meta (
  document_id      uuid primary key references public.documents(id) on delete cascade,
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid references core.locations(id),
  job_id           uuid,
  taken_at         timestamptz,                  -- EXIF DateTimeOriginal (+ offset when present)
  taken_at_source  text not null default 'none' check (taken_at_source in ('exif','device','none')),
  gps_lat          numeric(9,6) check (gps_lat is null or gps_lat between -90 and 90),
  gps_lng          numeric(9,6) check (gps_lng is null or gps_lng between -180 and 180),
  gps_alt_m        numeric(8,1),
  device_make      text check (device_make is null or char_length(device_make) <= 80),
  device_model     text check (device_model is null or char_length(device_model) <= 80),
  width_px         int,
  height_px        int,
  area             text check (area is null or char_length(area) <= 80),
  tags             text[] not null default '{}' check (cardinality(tags) <= 20),
  share_to_portal  boolean not null default false,
  received_at      timestamptz not null default now(),   -- server time (not member-settable)
  captured_by      text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  check (job_id is not null or location_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_doc_photo_meta_job_idx on pm.doc_photo_meta (org_id, job_id, taken_at desc);
comment on table pm.doc_photo_meta is
  '1115: photo capture metadata (EXIF time / GPS / device) next to the server receive time. One row per public.documents photo.';

-- ----------------------------------------------------------------------------
-- 4. Drawings: sets, sheets, revisions, markups
-- ----------------------------------------------------------------------------
create table if not exists pm.drawing_sets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  set_kind        text not null default 'ifc' check (set_kind in ('bid','permit','ifc','asi','bulletin','addendum','record','shop','other')),
  issued_on       date check (issued_on is null or issued_on between '1900-01-01' and '2200-12-31'),
  source_file_id  uuid,
  page_count      int not null default 0 check (page_count >= 0),
  sheet_count     int not null default 0,
  status          text not null default 'review' check (status in ('review','published')),
  published_at    timestamptz,
  published_by    text,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  check (status <> 'published' or published_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, source_file_id) references pm.doc_files (org_id, id) on delete set null (source_file_id) deferrable initially immediate
);
create index if not exists pm_drawing_sets_job_idx on pm.drawing_sets (org_id, job_id, issued_on desc);

create table if not exists pm.drawing_sheets (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  sheet_number         text not null check (char_length(sheet_number) between 1 and 40),
  title                text check (title is null or char_length(title) <= 200),
  discipline           text check (discipline is null or char_length(discipline) <= 40),
  current_revision_id  uuid,
  revision_count       int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, sheet_number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.drawing_revisions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  sheet_id         uuid not null,
  set_id           uuid not null,
  document_id      uuid not null references public.documents(id) on delete restrict,
  page_index       int not null check (page_index >= 0),
  title            text check (title is null or char_length(title) <= 200),
  revision_label   text check (revision_label is null or char_length(revision_label) <= 20),
  content_sha256   text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  width_pt         numeric(8,2) check (width_pt is null or width_pt > 0),
  height_pt        numeric(8,2) check (height_pt is null or height_pt > 0),
  extraction       text not null default 'none' check (extraction in ('text','manual','none')),
  confidence       numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status           text not null default 'review' check (status in ('review','published')),
  is_current       boolean not null default false,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (set_id, page_index),
  unique (set_id, sheet_id),
  check (not is_current or status = 'published'),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, sheet_id) references pm.drawing_sheets (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, set_id) references pm.drawing_sets (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_drawing_revisions_current_uidx on pm.drawing_revisions (sheet_id) where is_current;
create index if not exists pm_drawing_revisions_sheet_idx on pm.drawing_revisions (org_id, sheet_id, created_at desc);

create table if not exists pm.drawing_markups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  sheet_id      uuid not null,
  revision_id   uuid not null,
  author_user   text not null default pm.current_user_id(),
  visibility    text not null default 'personal' check (visibility in ('personal','published')),
  kind          text not null check (kind in ('pin','rect','cloud','arrow','freehand','text')),
  geometry      jsonb not null check (jsonb_typeof(geometry) = 'object' and octet_length(geometry::text) <= 100000),
  style         jsonb not null default '{}'::jsonb check (jsonb_typeof(style) = 'object' and octet_length(style::text) <= 2000),
  body          text check (body is null or char_length(body) <= 2000),
  link_table    text check (link_table is null or link_table in ('punch_items','tasks','rfis','photos','doc_files','change_orders')),
  link_id       uuid,
  published_at  timestamptz,
  published_by  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  check (visibility <> 'published' or published_at is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, revision_id) references pm.drawing_revisions (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_drawing_markups_rev_idx on pm.drawing_markups (org_id, revision_id, visibility);
comment on table pm.drawing_markups is
  '1115: markups on a sheet revision. Geometry is normalized to the page (0…1, origin top-left). personal = author only; published = everyone on the job.';

-- ----------------------------------------------------------------------------
-- 5. Template settings (company overrides for rendered documents)
-- ----------------------------------------------------------------------------
create table if not exists pm.doc_template_settings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  template_key  text not null check (template_key in ('proposal','contract','change_order','pay_app_cover','work_order',
                  'daily_report','install_ticket','purchase_order','buyers_order','draw_request','lien_waiver')),
  body          jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 40000),
  updated_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, location_id, template_key)
);
comment on table pm.doc_template_settings is '1115: per-company template text (terms, footer, notices, title) for lib/templates.';

-- ----------------------------------------------------------------------------
-- 6. E-signature
-- ----------------------------------------------------------------------------
create table if not exists pm.esign_envelopes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid,
  file_id             uuid not null,
  version_id          uuid not null,
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  message             text check (message is null or char_length(message) <= 2000),
  status              text not null default 'draft' check (status in ('draft','sent','completed','declined','voided','expired')),
  routing             text not null default 'sequential' check (routing in ('sequential','parallel')),
  expires_at          timestamptz not null,
  on_completed_kind   text not null default 'none' check (on_completed_kind in ('none','estimate','change_order','lien_waiver','dealer_quote')),
  on_completed_id     uuid,
  sender_user         text not null default pm.current_user_id(),
  sent_at             timestamptz,
  completed_at        timestamptz,
  declined_at         timestamptz,
  decline_reason      text,
  voided_at           timestamptz,
  voided_by           text,
  void_reason         text,
  original_sha256     text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  finalize_state      text not null default 'not_ready' check (finalize_state in ('not_ready','pending','done','failed')),
  finalize_error      text,
  signed_version_id   uuid,
  signed_document_id  uuid references public.documents(id) on delete set null,
  signed_sha256       text check (signed_sha256 is null or signed_sha256 ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  check ((on_completed_kind = 'none') = (on_completed_id is null)),
  check (status <> 'completed' or completed_at is not null),
  check (finalize_state <> 'done' or signed_version_id is not null),
  foreign key (org_id, file_id) references pm.doc_files (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, version_id) references pm.doc_versions (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_esign_envelopes_file_idx on pm.esign_envelopes (org_id, file_id, created_at desc);
create index if not exists pm_esign_envelopes_status_idx on pm.esign_envelopes (org_id, status, created_at desc);
create unique index if not exists pm_esign_envelopes_open_uidx on pm.esign_envelopes (file_id) where status in ('draft','sent');

create table if not exists pm.esign_signers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  envelope_id      uuid not null,
  routing_order    int not null default 1 check (routing_order between 1 and 20),
  position         int not null default 1 check (position between 1 and 20),
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  email            text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text check (phone is null or phone ~ '^\+?[0-9 ().-]{7,20}$'),
  role_label       text check (role_label is null or char_length(role_label) <= 60),
  channel          text not null default 'email' check (channel in ('email','sms','both','link')),
  status           text not null default 'waiting' check (status in ('waiting','pending_send','sent','viewed','signed','declined')),
  sent_at          timestamptz,
  viewed_at        timestamptz,
  consented_at     timestamptz,
  consent_version  text,
  signed_at        timestamptz,
  typed_name       text check (typed_name is null or char_length(typed_name) between 2 and 120),
  signature_png    text check (signature_png is null or (char_length(signature_png) <= 400000 and signature_png ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$')),
  sign_ip          text check (sign_ip is null or char_length(sign_ip) <= 64),
  sign_user_agent  text check (sign_user_agent is null or char_length(sign_user_agent) <= 500),
  gateway_ip       text check (gateway_ip is null or char_length(gateway_ip) <= 200),
  declined_at      timestamptz,
  decline_reason   text check (decline_reason is null or char_length(decline_reason) <= 1000),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (envelope_id, position),
  check (status <> 'signed' or (signed_at is not null and typed_name is not null and signature_png is not null and consented_at is not null)),
  check (status <> 'declined' or declined_at is not null),
  check (channel = 'link' or (channel = 'email' and email is not null) or (channel = 'sms' and phone is not null)
         or (channel = 'both' and email is not null and phone is not null)),
  foreign key (org_id, envelope_id) references pm.esign_envelopes (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.esign_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  envelope_id  uuid not null,
  signer_id    uuid not null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by    text default pm.current_user_id(),
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  revoked_at   timestamptz,
  foreign key (org_id, envelope_id) references pm.esign_envelopes (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, signer_id) references pm.esign_signers (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_esign_tokens_signer_idx on pm.esign_tokens (signer_id, issued_at desc);
comment on table pm.esign_tokens is '1115: one-time signing link tokens (sha-256 of the raw token only). No member grants.';

create table if not exists pm.esign_events (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,   -- audit order (clock ties never reorder the trail)
  org_id       uuid not null references core.organizations(id) on delete cascade,
  envelope_id  uuid not null,
  signer_id    uuid,
  event        text not null check (event in ('created','sent','delivered','resent','viewed','consented','signed','declined',
                 'completed','voided','expired','finalized','finalize_failed','callback_done','callback_failed','token_rejected')),
  at           timestamptz not null default clock_timestamp(),
  ip           text,
  user_agent   text,
  actor_user   text,
  detail       jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  foreign key (org_id, envelope_id) references pm.esign_envelopes (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_esign_events_env_idx on pm.esign_events (org_id, envelope_id, seq);

create table if not exists pm.esign_outbox (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  envelope_id   uuid not null,
  signer_id     uuid,
  kind          text not null check (kind in ('envelope.completed','envelope.declined','signer.turn')),
  subject_kind  text not null default 'none',
  subject_id    uuid,
  status        text not null default 'pending' check (status in ('pending','done','failed','skipped')),
  attempts      int not null default 0,
  last_error    text,
  outcome       jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome) = 'object'),
  created_at    timestamptz not null default now(),
  handled_at    timestamptz,
  handled_by    text,
  foreign key (org_id, envelope_id) references pm.esign_envelopes (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_esign_outbox_pending_idx on pm.esign_outbox (org_id, status, created_at) where status = 'pending';

-- Deleting a Projects object (<org>/pm/…) from storage needs a grant minted by pm.doc_discard_upload
-- (own, never-filed uploads only — retention, legal hold and signed locks can never be bypassed).
create table if not exists pm.storage_delete_grants (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  user_id       text not null,
  storage_path  text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists pm_storage_delete_grants_user_idx on pm.storage_delete_grants (user_id, expires_at);
comment on table pm.storage_delete_grants is '1115 (security review H1): one-time permission to remove an unfiled upload from storage. No member grants.';

comment on table pm.esign_outbox is
  '1115: webhook-style e-sign events, consumed at-least-once by lib/esign/callbacks.ts as an authorized member (signed PDF + certificate, then the record''s own action).';

-- ----------------------------------------------------------------------------
-- 7. pm.document_links: doc_files + drawing_sheets subjects
-- ----------------------------------------------------------------------------
do $$
begin
  alter table pm.document_links drop constraint if exists document_links_subject_table_check;
  alter table pm.document_links add constraint document_links_subject_table_check check (subject_table in
    ('projects','tasks','wbs_nodes','change_orders','contracts','budgets','field_logs','punch_items','time_entries',
     'assets','dealer_deals','dealer_trades','rental_contracts','parts','parts_tickets','doc_files','drawing_sheets'));
  alter table pm.document_links drop constraint if exists document_links_job_scope_check;
  alter table pm.document_links add constraint document_links_job_scope_check
    check (job_id is not null or subject_table in ('assets','dealer_deals','dealer_trades','rental_contracts','parts','parts_tickets','doc_files'));
end $$;

-- ----------------------------------------------------------------------------
-- 8. Catalogs + small helpers (internal unless stated)
-- ----------------------------------------------------------------------------
create or replace function pm.doc_kind_money_cap(p_kind text) returns text
language sql immutable
as $$
  select case
    when p_kind in ('contract','proposal','change_order','pay_app','draw_request','buyers_order') then 'projects.contract_value'
    when p_kind in ('po','subcontract','lien_waiver') then 'projects.financials'
    else null end
$$;

create or replace function pm.doc_kind_retention(p_kind text) returns text
language sql immutable
as $$
  select case
    when p_kind in ('contract','proposal','change_order','buyers_order','subcontract','warranty') then 'contract'
    when p_kind in ('pay_app','draw_request','po','lien_waiver') then 'financial'
    when p_kind in ('drawing_set','spec','photo','daily_report','permit','submittal','rfi','inspection','closeout','install_ticket','work_order') then 'project_record'
    else 'standard' end
$$;

-- Years a record is kept after it becomes final (signed / closed); null = forever.
create or replace function pm.doc_retention_years(p_class text) returns int
language sql immutable
as $$
  select case p_class when 'standard' then 3 when 'project_record' then 10 when 'contract' then 10
                      when 'financial' then 7 when 'safety' then 30 else null end
$$;

-- The consent text every signer agrees to (version-stamped; printed on the audit certificate).
create or replace function pm.esign_consent_text() returns text
language sql immutable
as $$
  select 'I agree to use electronic records and signatures for this document. I understand that my typed name and '
      || 'drawn signature are my legal signature, with the same effect as a handwritten signature (U.S. ESIGN Act and '
      || 'UETA). I can ask for a paper copy, and I can withdraw consent before I sign by closing this page or declining. '
      || 'I have reviewed the document shown above.'
$$;
create or replace function pm.esign_consent_version() returns text language sql immutable as $$ select 'esign-consent-v1' $$;

-- The caller may READ this file (the money rule; RLS equivalent for definer code). Internal.
create or replace function pm._doc_can_read(p_file uuid) returns boolean
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id();
  if f.id is null then return pm.access_is_service(); end if;
  if pm.access_is_service() then return true; end if;
  if f.job_id is not null then
    if not pm.access_can_job('projects.documents', 'view', f.job_id) then return false; end if;
    return f.money_cap is null or exists (select 1 from pm.my_money_job_ids(f.money_cap) x where x = f.job_id);
  end if;
  if not pm.can('projects.documents', 'view', f.location_id) then return false; end if;
  return f.money_cap is null or pm.can(f.money_cap, 'view', f.location_id);
end $$;

-- The caller may manage an envelope: its sender, or projects.documents:edit where the file lives. Internal.
create or replace function pm._esign_can_manage(p_envelope uuid) returns boolean
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare e pm.esign_envelopes%rowtype;
begin
  if pm.access_is_service() then return true; end if;
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = public.get_org_id();
  if e.id is null or not pm._doc_can_read(e.file_id) then return false; end if;
  if e.sender_user = pm.current_user_id() then return true; end if;
  if e.job_id is not null then return pm.access_can_job('projects.documents', 'edit', e.job_id); end if;
  return pm.can('projects.documents', 'edit', e.location_id);
end $$;

create or replace function pm._esign_event(p_env uuid, p_signer uuid, p_event text, p_ip text default null,
                                           p_ua text default null, p_detail jsonb default '{}')
returns void
language sql security definer
set search_path = pm, core, public
as $$
  insert into pm.esign_events (org_id, envelope_id, signer_id, event, ip, user_agent, actor_user, detail)
  select e.org_id, e.id, p_signer, p_event, left(p_ip, 64), left(p_ua, 500), pm.current_user_id(), coalesce(p_detail, '{}'::jsonb)
    from pm.esign_envelopes e where e.id = p_env
$$;

-- Insert a version (locks the file row; supersedes the current one). Internal.
create or replace function pm._doc_insert_version(p_file uuid, p_document uuid, p_attrs jsonb, p_source text, p_locked boolean default false)
returns pm.doc_versions
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype; d public.documents%rowtype; v pm.doc_versions%rowtype; v_no int; a jsonb := coalesce(p_attrs, '{}'::jsonb);
begin
  select * into f from pm.doc_files x where x.id = p_file for update;
  if f.id is null then raise exception 'PM_NOT_FOUND: document % not found', p_file using errcode = 'P0002'; end if;
  select * into d from public.documents x where x.id = p_document;
  if d.id is null or d.org_id <> f.org_id then
    raise exception 'PM_DOCUMENT_ORG_MISMATCH: file % is not in this organization', p_document using errcode = '23503';
  end if;
  -- only the caller's own Projects upload (<org>/pm/…) becomes a version: never a Books file (bill, W-9 …)
  if p_source <> 'restore' and not pm.access_is_service()
     and (d.uploaded_by_user is distinct from pm.current_user_id() or d.storage_path not like d.org_id::text || '/pm/%') then
    raise exception 'PM_FORBIDDEN: upload the file to Projects first' using errcode = '42501';
  end if;
  if exists (select 1 from pm.doc_versions x where x.document_id = p_document and x.file_id <> p_file) then
    raise exception 'PM_DOC_FILE_IN_USE: that upload already belongs to another document' using errcode = '23505';
  end if;
  if exists (select 1 from pm.drawing_revisions r where r.document_id = p_document) then
    raise exception 'PM_DOC_FILE_IN_USE: that upload is a drawing sheet' using errcode = '23505';
  end if;
  v_no := f.version_count + 1;
  update pm.doc_versions x set is_current = false, superseded_at = now() where x.file_id = p_file and x.is_current;
  insert into pm.doc_versions (org_id, file_id, version_no, document_id, file_name, mime_type, size_bytes, content_sha256,
                               page_count, label, note, source, is_current, locked, meta, created_by)
  values (f.org_id, f.id, v_no, d.id,
          left(coalesce(nullif(btrim(a ->> 'file_name'), ''), d.file_name), 255),
          coalesce(a ->> 'mime_type', d.mime_type),
          coalesce((a ->> 'size_bytes')::bigint, d.size_bytes),
          nullif(lower(a ->> 'content_sha256'), ''),
          (a ->> 'page_count')::int,
          nullif(btrim(a ->> 'label'), ''),
          nullif(btrim(a ->> 'note'), ''),
          p_source, true, coalesce(p_locked, false),
          coalesce(case when jsonb_typeof(a -> 'meta') = 'object' then a -> 'meta' end, '{}'::jsonb),
          pm.current_user_id())
  returning * into v;
  update pm.doc_files x set current_version_id = v.id, version_count = v_no, updated_at = now() where x.id = f.id;
  insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role)
  values (f.org_id, d.id, f.job_id, 'doc_files', f.id, 'version')
  on conflict (document_id, subject_table, subject_id) do nothing;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Member RPCs — documents (guards in section 14)
-- ----------------------------------------------------------------------------
-- Branding for rendered documents and the signing page (company brand unless it uses the tenant's).
-- Internal (no guard): also used by the public signing page through esign._state.
create or replace function pm._doc_brand(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_name text; b record;
begin
  select l.org_id, l.name into v_org, v_name from core.locations l where l.id = p_location;
  if v_org is null then return null; end if;
  select bp.* into b from public.brand_profiles bp
   where bp.org_id = v_org and bp.location_id = p_location and not bp.use_tenant_brand;
  if b.id is null then
    select bp.* into b from public.brand_profiles bp where bp.org_id = v_org and bp.location_id is null;
  end if;
  return jsonb_build_object(
    'company_name', v_name,
    'org_name', (select o.name from core.organizations o where o.id = v_org),
    'logo_url', b.logo_url, 'mark_url', b.mark_url,
    'primary_color', coalesce(b.primary_color, '#2563EB'), 'secondary_color', coalesce(b.secondary_color, '#0A1628'),
    'accent_color', coalesce(b.accent_color, '#3B82F6'), 'ink_color', coalesce(b.ink_color, '#0A1628'),
    'surface_color', coalesce(b.surface_color, '#EBF2FE'), 'on_primary_color', coalesce(b.on_primary_color, '#FFFFFF'),
    'font', coalesce(b.font, 'DM_SANS'));
end $$;

create or replace function pm.doc_brand(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from core.locations l where l.id = p_location and (public.get_org_id() is null or l.org_id = public.get_org_id())) then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  return pm._doc_brand(p_location);
end $$;

-- Create the job's folders from its pack's template (idempotent; returns folders created).
create or replace function pm.doc_ensure_job_folders(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_pack text; v_tpl jsonb; n int;
begin
  select j.org_id into v_org from core.jobs j where j.id = p_job;
  if v_org is null or (public.get_org_id() is not null and v_org <> public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: job % is not in the caller''s organization', p_job using errcode = '42501';
  end if;
  select i.pack_key into v_pack
    from pm.projects p join pm.job_types jt on jt.id = p.job_type_id join pm.pack_installs i on i.id = jt.install_id
   where p.job_id = p_job;
  select t.folders into v_tpl from pm.doc_folder_templates t where t.pack_key = coalesce(v_pack, 'general');
  if v_tpl is null then select t.folders into v_tpl from pm.doc_folder_templates t where t.pack_key = 'general'; end if;
  if v_tpl is null then return 0; end if;
  insert into pm.doc_folders (org_id, job_id, key, name, sort, money_cap, kinds, created_by)
  select v_org, p_job, x.value ->> 'key', x.value ->> 'name', coalesce((x.value ->> 'sort')::int, x.o::int * 10),
         nullif(x.value ->> 'money_cap', ''),
         coalesce(array(select jsonb_array_elements_text(x.value -> 'kinds')), '{}'), pm.current_user_id()
    from jsonb_array_elements(v_tpl) with ordinality as x(value, o)
   where not exists (select 1 from pm.doc_folders f where f.org_id = v_org and f.job_id = p_job
                        and (f.key = x.value ->> 'key' or (f.parent_id is null and lower(f.name) = lower(x.value ->> 'name'))));
  get diagnostics n = row_count;
  return n;
end $$;

-- New document (first version). p_attrs: title, kind, folder_id, money_cap, description, tags[],
-- subject_table, subject_id, retention_class, file_name, mime_type, size_bytes, content_sha256,
-- page_count, label, note, source (upload | template | import), meta {anchors …}.
create or replace function pm.doc_create(p_job uuid, p_location uuid, p_document uuid, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  a jsonb := coalesce(p_attrs, '{}'::jsonb);
  v_org uuid := public.get_org_id(); v_loc uuid; v_kind text; v_folder uuid; v_money text; v_fmoney text;
  v_file uuid; ver pm.doc_versions%rowtype; v_source text;
begin
  if p_job is not null then
    select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
    if v_org is null or (public.get_org_id() is not null and v_org <> public.get_org_id()) then
      raise exception 'PM_FORBIDDEN: job % is not in the caller''s organization', p_job using errcode = '42501';
    end if;
    if p_location is not null and p_location <> v_loc then
      raise exception 'PM_INVALID: the job belongs to another company' using errcode = '22023';
    end if;
  else
    select l.org_id, l.id into v_org, v_loc from core.locations l where l.id = p_location;
    if v_loc is null or (public.get_org_id() is not null and v_org <> public.get_org_id()) then
      raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
    end if;
  end if;
  v_kind := coalesce(nullif(a ->> 'kind', ''), 'file');
  v_source := coalesce(nullif(a ->> 'source', ''), 'upload');
  if v_source not in ('upload', 'template', 'import') then
    raise exception 'PM_INVALID: source must be upload, template or import' using errcode = '22023';
  end if;

  v_folder := pm.access_try_uuid(a ->> 'folder_id');
  if v_folder is not null then
    select f.money_cap into v_fmoney from pm.doc_folders f where f.id = v_folder and f.org_id = v_org and f.job_id = p_job;
    if not found then raise exception 'PM_INVALID: that folder is not on this job' using errcode = '22023'; end if;
  elsif p_job is not null then
    perform pm.doc_ensure_job_folders(p_job);
    select f.id, f.money_cap into v_folder, v_fmoney from pm.doc_folders f
     where f.org_id = v_org and f.job_id = p_job and v_kind = any (f.kinds) order by f.sort limit 1;
  end if;
  v_money := coalesce(nullif(a ->> 'money_cap', ''), v_fmoney, pm.doc_kind_money_cap(v_kind));
  if v_money is not null and v_money not in ('projects.contract_value', 'projects.financials') then
    raise exception 'PM_INVALID: money_cap must be projects.contract_value or projects.financials' using errcode = '22023';
  end if;
  -- A money document is created only by someone who may read it.
  if v_money is not null and not pm.access_is_service() then
    if (p_job is not null and not exists (select 1 from pm.my_money_job_ids(v_money) x where x = p_job))
       or (p_job is null and not pm.can(v_money, 'view', v_loc)) then
      raise exception 'PM_FORBIDDEN: this is a money document — it requires %:view', v_money using errcode = '42501';
    end if;
  end if;

  -- the linked record (subject) must exist on this job / company and be readable by the caller
  if nullif(a ->> 'subject_table', '') is not null then
    perform pm._doc_assert_subject(a ->> 'subject_table', pm.access_try_uuid(a ->> 'subject_id'), v_org, p_job, v_loc);
  end if;

  insert into pm.doc_files (org_id, location_id, job_id, folder_id, title, kind, money_cap, description, tags,
                            subject_table, subject_id, retention_class, created_by)
  values (v_org, v_loc, p_job, v_folder,
          left(coalesce(nullif(btrim(a ->> 'title'), ''), (select d.file_name from public.documents d where d.id = p_document), 'Document'), 200),
          v_kind, v_money, nullif(btrim(a ->> 'description'), ''),
          coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(a -> 'tags') = 'array' then a -> 'tags' else '[]'::jsonb end)), '{}'),
          nullif(a ->> 'subject_table', ''), pm.access_try_uuid(a ->> 'subject_id'),
          coalesce(nullif(a ->> 'retention_class', ''), pm.doc_kind_retention(v_kind)),
          pm.current_user_id())
  returning id into v_file;
  ver := pm._doc_insert_version(v_file, p_document, a, v_source, false);
  perform pm.log_activity(v_org, v_loc, p_job, 'document.added', 'doc_files', v_file,
    format('Added %s', left(coalesce(nullif(btrim(a ->> 'title'), ''), ver.file_name), 120)), jsonb_build_object('kind', v_kind));
  return jsonb_build_object('file_id', v_file, 'version_id', ver.id, 'version_no', ver.version_no, 'folder_id', v_folder, 'money_cap', v_money);
end $$;

-- A document's linked record: known table, same org, same job (dealer quotes: same company),
-- readable by the caller. Internal.
create or replace function pm._doc_assert_subject(p_table text, p_id uuid, p_org uuid, p_job uuid, p_loc uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_cap text; v_ok boolean;
begin
  v_cap := case p_table
    when 'estimates' then 'projects.estimates' when 'change_orders' then 'projects.change_orders'
    when 'compliance_docs' then 'projects.commitments' when 'commitments' then 'projects.commitments'
    when 'dealer_quotes' then 'projects.store' when 'billing_requests' then 'projects.billing' when 'draws' then 'projects.billing'
    when 'work_orders' then 'projects.jobs' when 'field_logs' then 'projects.jobs' end;
  if v_cap is null or p_id is null then
    raise exception 'PM_INVALID: a document can be linked to an estimate, change order, waiver, quote, billing request, draw, work order, daily log or commitment' using errcode = '22023';
  end if;
  if p_table = 'dealer_quotes' then
    select exists (select 1 from pm.dealer_quotes x where x.id = p_id and x.org_id = p_org and x.location_id = p_loc) into v_ok;
  else
    execute format('select exists (select 1 from pm.%I x where x.id = $1 and x.org_id = $2 and x.job_id is not distinct from $3)', p_table)
      into v_ok using p_id, p_org, p_job;
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'PM_INVALID: the linked record is not on this document''s job' using errcode = '22023';
  end if;
  if not pm.access_can_row(v_cap, 'view', p_table, p_id) then
    raise exception 'PM_FORBIDDEN: you cannot see the linked record' using errcode = '42501';
  end if;
end $$;

-- Refuse changes to a held / signing / signed document. Internal.
create or replace function pm._doc_assert_changeable(f pm.doc_files) returns void
language plpgsql stable
set search_path = pm, core, public
as $$
begin
  if f.status = 'deleted' then raise exception 'PM_DOC_DELETED: this document was removed' using errcode = '22023'; end if;
  if f.legal_hold then raise exception 'PM_DOC_LEGAL_HOLD: this document is on legal hold' using errcode = '22023'; end if;
  if exists (select 1 from pm.doc_versions v where v.file_id = f.id and v.is_current and v.locked) then
    raise exception 'PM_DOC_LOCKED: the current version is signed and cannot be replaced; add a new document' using errcode = '22023';
  end if;
  if exists (select 1 from pm.esign_envelopes e where e.file_id = f.id and e.status in ('draft', 'sent')) then
    raise exception 'PM_DOC_OUT_FOR_SIGNATURE: void the open signature request first' using errcode = '22023';
  end if;
end $$;

create or replace function pm.doc_add_version(p_file uuid, p_document uuid, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype; v pm.doc_versions%rowtype;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id() for update;
  if f.id is null then raise exception 'PM_FORBIDDEN: document % not found in the caller''s organization', p_file using errcode = '42501'; end if;
  if not pm._doc_can_read(f.id) then raise exception 'PM_FORBIDDEN: requires %:view for this document', f.money_cap using errcode = '42501'; end if;
  perform pm._doc_assert_changeable(f);
  v := pm._doc_insert_version(f.id, p_document, p_attrs, case when coalesce(p_attrs ->> 'source', '') in ('template', 'import') then p_attrs ->> 'source' else 'upload' end, false);
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'document.version_added', 'doc_files', f.id,
    format('%s — version %s', left(f.title, 120), v.version_no), jsonb_build_object('version_id', v.id));
  return jsonb_build_object('file_id', f.id, 'version_id', v.id, 'version_no', v.version_no);
end $$;

-- Make an earlier version current again (recorded as a new version that points at the same bytes).
create or replace function pm.doc_restore_version(p_version uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.doc_versions%rowtype; f pm.doc_files%rowtype; v pm.doc_versions%rowtype;
begin
  select * into o from pm.doc_versions x where x.id = p_version and x.org_id = public.get_org_id();
  if o.id is null then raise exception 'PM_FORBIDDEN: version % not found in the caller''s organization', p_version using errcode = '42501'; end if;
  select * into f from pm.doc_files x where x.id = o.file_id for update;
  if not pm._doc_can_read(f.id) then raise exception 'PM_FORBIDDEN: requires %:view for this document', f.money_cap using errcode = '42501'; end if;
  if o.is_current then raise exception 'PM_INVALID: that version is already current' using errcode = '22023'; end if;
  perform pm._doc_assert_changeable(f);
  v := pm._doc_insert_version(f.id, o.document_id,
         jsonb_build_object('file_name', o.file_name, 'mime_type', o.mime_type, 'size_bytes', o.size_bytes,
                            'content_sha256', o.content_sha256, 'page_count', o.page_count, 'label', o.label,
                            'note', format('Restored version %s', o.version_no), 'meta', o.meta || jsonb_build_object('restored_from', o.id)),
         'restore', false);
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'document.version_restored', 'doc_files', f.id,
    format('%s — restored version %s', left(f.title, 120), o.version_no), jsonb_build_object('version_id', v.id, 'from', o.id));
  return jsonb_build_object('file_id', f.id, 'version_id', v.id, 'version_no', v.version_no);
end $$;

create or replace function pm.doc_set_retention(p_file uuid, p_class text, p_until date default null) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id() for update;
  if f.id is null or not pm._doc_can_read(p_file) then raise exception 'PM_FORBIDDEN: document % not found', p_file using errcode = '42501'; end if;
  if p_class not in ('standard','project_record','contract','financial','safety','permanent') then
    raise exception 'PM_INVALID: unknown retention class %', p_class using errcode = '22023';
  end if;
  if f.legal_hold and (p_until is null or p_until < coalesce(f.retain_until, p_until)) then
    raise exception 'PM_DOC_LEGAL_HOLD: retention cannot be shortened while on legal hold' using errcode = '22023';
  end if;
  if f.retain_until is not null and (p_until is null or p_until < f.retain_until)
     and exists (select 1 from pm.doc_versions v where v.file_id = f.id and v.locked) then
    raise exception 'PM_DOC_LOCKED: a signed record''s retention cannot be shortened' using errcode = '22023';
  end if;
  update pm.doc_files set retention_class = p_class, retain_until = p_until, updated_at = now() where id = f.id;
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'document.retention_set', 'doc_files', f.id,
    format('Retention %s%s', p_class, coalesce(' until ' || p_until::text, '')), '{}'::jsonb);
end $$;

create or replace function pm.doc_set_legal_hold(p_file uuid, p_hold boolean, p_reason text default null) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id() for update;
  if f.id is null or not pm._doc_can_read(p_file) then raise exception 'PM_FORBIDDEN: document % not found', p_file using errcode = '42501'; end if;
  if p_hold and coalesce(btrim(p_reason), '') = '' then
    raise exception 'PM_INVALID: say why the document is on hold' using errcode = '22023';
  end if;
  update pm.doc_files set legal_hold = p_hold,
         legal_hold_reason = case when p_hold then left(btrim(p_reason), 500) end,
         legal_hold_by = case when p_hold then pm.current_user_id() end,
         legal_hold_at = case when p_hold then now() end,
         updated_at = now()
   where id = f.id;
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, case when p_hold then 'document.hold_set' else 'document.hold_released' end,
    'doc_files', f.id, case when p_hold then 'Legal hold: ' || left(btrim(p_reason), 200) else 'Legal hold released' end,
    jsonb_build_object('previous', f.legal_hold));
end $$;

-- Soft delete (kept for audit). Refused on legal hold, retention not yet met, or a signed version.
create or replace function pm.doc_remove(p_file uuid, p_reason text default null) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files%rowtype;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id() for update;
  if f.id is null or not pm._doc_can_read(p_file) then raise exception 'PM_FORBIDDEN: document % not found', p_file using errcode = '42501'; end if;
  if f.status = 'deleted' then return; end if;
  if f.legal_hold then raise exception 'PM_DOC_LEGAL_HOLD: this document is on legal hold' using errcode = '22023'; end if;
  if f.retain_until is not null and f.retain_until > current_date then
    raise exception 'PM_DOC_RETAINED: this record must be kept until %', f.retain_until using errcode = '22023';
  end if;
  if exists (select 1 from pm.doc_versions v where v.file_id = f.id and v.locked) then
    raise exception 'PM_DOC_LOCKED: signed records cannot be removed' using errcode = '22023';
  end if;
  if exists (select 1 from pm.esign_envelopes e where e.file_id = f.id and e.status in ('draft', 'sent')) then
    raise exception 'PM_DOC_OUT_FOR_SIGNATURE: void the open signature request first' using errcode = '22023';
  end if;
  update pm.doc_files set status = 'deleted', deleted_at = now(), deleted_by = pm.current_user_id(),
         delete_reason = left(nullif(btrim(p_reason), ''), 500), updated_at = now()
   where id = f.id;
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'document.removed', 'doc_files', f.id,
    format('Removed %s', left(f.title, 120)), jsonb_build_object('reason', p_reason));
end $$;

-- ----------------------------------------------------------------------------
-- 10. Member RPCs — drawings
-- ----------------------------------------------------------------------------
create or replace function pm._drawing_norm_number(p text) returns text
language sql immutable
as $$ select nullif(upper(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))), '') $$;

-- Current revision of a sheet = the latest published one (set issue date, then upload time). Internal.
create or replace function pm._drawing_recompute(p_sheet uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_cur uuid; r pm.drawing_revisions%rowtype;
begin
  select dr.id into v_cur
    from pm.drawing_revisions dr join pm.drawing_sets s on s.id = dr.set_id
   where dr.sheet_id = p_sheet and dr.status = 'published'
   order by s.issued_on desc nulls last, s.published_at desc nulls last, dr.created_at desc, dr.id
   limit 1;
  update pm.drawing_revisions set is_current = false where sheet_id = p_sheet and is_current and id is distinct from v_cur;
  if v_cur is not null then
    update pm.drawing_revisions set is_current = true where id = v_cur and not is_current;
    select * into r from pm.drawing_revisions where id = v_cur;
  end if;
  update pm.drawing_sheets sh set
         current_revision_id = v_cur,
         revision_count = (select count(*) from pm.drawing_revisions x where x.sheet_id = p_sheet),
         title = coalesce(r.title, sh.title),
         updated_at = now()
   where sh.id = p_sheet;
end $$;

-- p_attrs: name, set_kind, issued_on, source_file_id, page_count.
create or replace function pm.drawing_set_create(p_job uuid, p_attrs jsonb default '{}') returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a jsonb := coalesce(p_attrs, '{}'::jsonb); v_org uuid; v_loc uuid; v_id uuid; v_src uuid;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or (public.get_org_id() is not null and v_org <> public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: job % is not in the caller''s organization', p_job using errcode = '42501';
  end if;
  v_src := pm.access_try_uuid(a ->> 'source_file_id');
  if v_src is not null and not exists (select 1 from pm.doc_files f where f.id = v_src and f.org_id = v_org and f.job_id = p_job) then
    raise exception 'PM_INVALID: the source file is not on this job' using errcode = '22023';
  end if;
  insert into pm.drawing_sets (org_id, job_id, name, set_kind, issued_on, source_file_id, page_count, created_by)
  values (v_org, p_job, left(coalesce(nullif(btrim(a ->> 'name'), ''), 'Drawing set'), 120),
          coalesce(nullif(a ->> 'set_kind', ''), 'ifc'), (a ->> 'issued_on')::date, v_src,
          greatest(coalesce((a ->> 'page_count')::int, 0), 0), pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(v_org, v_loc, p_job, 'drawing.set_uploaded', 'drawing_sets', v_id,
    format('Drawing set %s', left(coalesce(a ->> 'name', ''), 100)), jsonb_build_object('pages', a -> 'page_count'));
  return v_id;
end $$;

-- One page of a set → a revision of its sheet. p_document = the single-page PDF (public.documents).
-- p_attrs: page_index, sheet_number, title, discipline, revision_label, extraction, confidence,
-- width_pt, height_pt, content_sha256.
create or replace function pm.drawing_add_sheet(p_set uuid, p_document uuid, p_attrs jsonb default '{}') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a jsonb := coalesce(p_attrs, '{}'::jsonb); s pm.drawing_sets%rowtype; v_num text; v_sheet uuid; v_rev uuid; d public.documents%rowtype;
begin
  select * into s from pm.drawing_sets x where x.id = p_set and x.org_id = public.get_org_id() for update;
  if s.id is null then raise exception 'PM_FORBIDDEN: drawing set % not found', p_set using errcode = '42501'; end if;
  select * into d from public.documents x where x.id = p_document;
  if d.id is null or d.org_id <> s.org_id then
    raise exception 'PM_DOCUMENT_ORG_MISMATCH: file % is not in this organization', p_document using errcode = '23503';
  end if;
  if not pm.access_is_service() and (d.uploaded_by_user is distinct from pm.current_user_id() or d.storage_path not like d.org_id::text || '/pm/%') then
    raise exception 'PM_FORBIDDEN: upload the file to Projects first' using errcode = '42501';
  end if;
  if exists (select 1 from pm.drawing_revisions r where r.document_id = p_document)
     or exists (select 1 from pm.doc_versions v where v.document_id = p_document) then
    raise exception 'PM_DOC_FILE_IN_USE: that upload is already used' using errcode = '23505';
  end if;
  v_num := pm._drawing_norm_number(a ->> 'sheet_number');
  if v_num is null then raise exception 'PM_INVALID: every sheet needs a sheet number' using errcode = '22023'; end if;
  if char_length(v_num) > 40 then raise exception 'PM_INVALID: sheet numbers are at most 40 characters' using errcode = '22023'; end if;

  insert into pm.drawing_sheets as sh (org_id, job_id, sheet_number, title, discipline)
  values (s.org_id, s.job_id, v_num, left(nullif(btrim(a ->> 'title'), ''), 200), left(nullif(btrim(a ->> 'discipline'), ''), 40))
  on conflict (org_id, job_id, sheet_number) do update set
    title = coalesce(sh.title, excluded.title), discipline = coalesce(sh.discipline, excluded.discipline), updated_at = now()
  returning id into v_sheet;
  if exists (select 1 from pm.drawing_revisions r where r.set_id = s.id and r.sheet_id = v_sheet) then
    raise exception 'PM_DRAWING_DUPLICATE_SHEET: sheet % appears twice in this set', v_num using errcode = '23505';
  end if;
  insert into pm.drawing_revisions (org_id, job_id, sheet_id, set_id, document_id, page_index, title, revision_label,
                                    content_sha256, width_pt, height_pt, extraction, confidence, status, created_by)
  values (s.org_id, s.job_id, v_sheet, s.id, d.id, coalesce((a ->> 'page_index')::int, 0),
          left(nullif(btrim(a ->> 'title'), ''), 200), left(nullif(btrim(a ->> 'revision_label'), ''), 20),
          nullif(lower(a ->> 'content_sha256'), ''), (a ->> 'width_pt')::numeric, (a ->> 'height_pt')::numeric,
          coalesce(nullif(a ->> 'extraction', ''), 'none'), (a ->> 'confidence')::numeric,
          case when s.status = 'published' then 'published' else 'review' end, pm.current_user_id())
  returning id into v_rev;
  insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role)
  values (s.org_id, d.id, s.job_id, 'drawing_sheets', v_sheet, 'revision')
  on conflict (document_id, subject_table, subject_id) do nothing;
  update pm.drawing_sets set sheet_count = (select count(*) from pm.drawing_revisions r where r.set_id = s.id) where id = s.id;
  perform pm._drawing_recompute(v_sheet);
  return jsonb_build_object('sheet_id', v_sheet, 'revision_id', v_rev, 'sheet_number', v_num);
end $$;

-- Correct a page's sheet number / title / discipline / revision (before or after publishing).
create or replace function pm.drawing_update_revision(p_revision uuid, p_attrs jsonb default '{}') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a jsonb := coalesce(p_attrs, '{}'::jsonb); r pm.drawing_revisions%rowtype; v_num text; v_old_sheet uuid; v_sheet uuid; v_cur_num text;
begin
  select * into r from pm.drawing_revisions x where x.id = p_revision and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: revision % not found', p_revision using errcode = '42501'; end if;
  v_old_sheet := r.sheet_id; v_sheet := r.sheet_id;
  select sh.sheet_number into v_cur_num from pm.drawing_sheets sh where sh.id = r.sheet_id;
  v_num := pm._drawing_norm_number(a ->> 'sheet_number');
  if v_num is not null and v_num <> v_cur_num then
    insert into pm.drawing_sheets as sh (org_id, job_id, sheet_number)
    values (r.org_id, r.job_id, v_num)
    on conflict (org_id, job_id, sheet_number) do update set updated_at = now()
    returning id into v_sheet;
    if exists (select 1 from pm.drawing_revisions x where x.set_id = r.set_id and x.sheet_id = v_sheet and x.id <> r.id) then
      raise exception 'PM_DRAWING_DUPLICATE_SHEET: sheet % is already in this set', v_num using errcode = '23505';
    end if;
    update pm.drawing_markups set sheet_id = v_sheet where revision_id = r.id;
    update pm.document_links set subject_id = v_sheet
     where document_id = r.document_id and subject_table = 'drawing_sheets' and subject_id = v_old_sheet;
  end if;
  update pm.drawing_revisions set
         sheet_id = v_sheet, is_current = case when v_sheet <> v_old_sheet then false else is_current end,
         title = case when a ? 'title' then left(nullif(btrim(a ->> 'title'), ''), 200) else title end,
         revision_label = case when a ? 'revision_label' then left(nullif(btrim(a ->> 'revision_label'), ''), 20) else revision_label end,
         extraction = 'manual'
   where id = r.id;
  if a ? 'discipline' then
    update pm.drawing_sheets set discipline = left(nullif(btrim(a ->> 'discipline'), ''), 40), updated_at = now() where id = v_sheet;
  end if;
  if a ? 'title' then
    update pm.drawing_sheets set title = left(nullif(btrim(a ->> 'title'), ''), 200), updated_at = now() where id = v_sheet;
  end if;
  perform pm._drawing_recompute(v_sheet);
  if v_old_sheet <> v_sheet then
    perform pm._drawing_recompute(v_old_sheet);
    delete from pm.drawing_sheets sh where sh.id = v_old_sheet and not exists (select 1 from pm.drawing_revisions x where x.sheet_id = v_old_sheet);
  end if;
  return jsonb_build_object('revision_id', r.id, 'sheet_id', v_sheet);
end $$;

create or replace function pm.drawing_publish_set(p_set uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.drawing_sets%rowtype; v_sheet uuid; n int := 0; v_loc uuid;
begin
  select * into s from pm.drawing_sets x where x.id = p_set and x.org_id = public.get_org_id() for update;
  if s.id is null then raise exception 'PM_FORBIDDEN: drawing set % not found', p_set using errcode = '42501'; end if;
  if not exists (select 1 from pm.drawing_revisions r where r.set_id = s.id) then
    raise exception 'PM_INVALID: the set has no sheets yet' using errcode = '22023';
  end if;
  update pm.drawing_sets set status = 'published', published_at = coalesce(published_at, now()), published_by = coalesce(published_by, pm.current_user_id())
   where id = s.id;
  update pm.drawing_revisions set status = 'published' where set_id = s.id and status <> 'published';
  for v_sheet in select r.sheet_id from pm.drawing_revisions r where r.set_id = s.id loop
    perform pm._drawing_recompute(v_sheet);
    n := n + 1;
  end loop;
  select j.location_id into v_loc from core.jobs j where j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'drawing.set_published', 'drawing_sets', s.id,
    format('Published %s (%s sheets)', left(s.name, 100), n), '{}'::jsonb);
  return jsonb_build_object('set_id', s.id, 'sheets', n,
    'current', (select count(*) from pm.drawing_revisions r where r.set_id = s.id and r.is_current),
    'superseded', (select count(*) from pm.drawing_revisions r where r.set_id = s.id and not r.is_current));
end $$;

create or replace function pm.drawing_markup_publish(p_markup uuid, p_publish boolean default true) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.drawing_markups%rowtype;
begin
  select * into m from pm.drawing_markups x where x.id = p_markup and x.org_id = public.get_org_id() for update;
  if m.id is null or (m.visibility = 'personal' and m.author_user is distinct from pm.current_user_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: markup % not found', p_markup using errcode = '42501';
  end if;
  update pm.drawing_markups set visibility = case when p_publish then 'published' else 'personal' end,
         published_at = case when p_publish then coalesce(published_at, now()) end,
         published_by = case when p_publish then coalesce(published_by, pm.current_user_id()) end,
         updated_at = now()
   where id = m.id;
end $$;

-- Markup rows: job / sheet follow the revision; members always write as themselves.
-- Invoker on purpose: current_user tells a member write from a definer one.
create or replace function pm.tg_drawing_markup() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare r pm.drawing_revisions%rowtype; v_member boolean := current_user in ('authenticated', 'anon');
begin
  select * into r from pm.drawing_revisions x where x.id = new.revision_id and x.org_id = new.org_id;
  if r.id is null then raise exception 'PM_INVALID: revision % not found', new.revision_id using errcode = '23503'; end if;
  new.job_id := r.job_id;
  new.sheet_id := r.sheet_id;
  if tg_op = 'INSERT' then
    if v_member then new.author_user := pm.current_user_id(); end if;
    if new.author_user is null then raise exception 'PM_NO_ACTOR: a markup needs an author' using errcode = '42501'; end if;
    if new.visibility = 'published' then
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, new.author_user);
    end if;
  else
    if v_member and new.author_user is distinct from old.author_user then
      raise exception 'PM_FORBIDDEN: a markup''s author cannot change' using errcode = '42501';
    end if;
    if new.visibility = 'published' and old.visibility = 'personal' then
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, pm.current_user_id());
    elsif new.visibility = 'personal' then
      new.published_at := null; new.published_by := null;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_drawing_markup on pm.drawing_markups;
create trigger trg_drawing_markup before insert or update on pm.drawing_markups
  for each row execute function pm.tg_drawing_markup();

-- ----------------------------------------------------------------------------
-- 11. Member RPCs — e-signature
-- ----------------------------------------------------------------------------
-- p_signers: [{name, email, phone, role_label, channel, order}] (1–10)
-- p_attrs:   {title, message, expires_days 1–90 (14), routing sequential | parallel,
--             version_id (default current), on_completed {kind, id}}
create or replace function pm.esign_create(p_file uuid, p_signers jsonb, p_attrs jsonb default '{}') returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  a jsonb := coalesce(p_attrs, '{}'::jsonb); f pm.doc_files%rowtype; v pm.doc_versions%rowtype;
  v_env uuid; v_kind text; v_subject uuid; v_days int; v_routing text; s jsonb; i int := 0; v_ok boolean;
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id();
  if f.id is null or not pm._doc_can_read(p_file) then raise exception 'PM_FORBIDDEN: document % not found', p_file using errcode = '42501'; end if;
  if f.status <> 'active' then raise exception 'PM_INVALID: only active documents can be sent for signature' using errcode = '22023'; end if;
  select * into v from pm.doc_versions x where x.file_id = f.id
     and x.id = coalesce(pm.access_try_uuid(a ->> 'version_id'), f.current_version_id);
  if v.id is null then raise exception 'PM_INVALID: that version is not part of this document' using errcode = '22023'; end if;
  if not v.is_current then raise exception 'PM_INVALID: only the current version can be signed' using errcode = '22023'; end if;
  if v.locked then raise exception 'PM_DOC_LOCKED: this version is already signed' using errcode = '22023'; end if;
  if v.content_sha256 is null then raise exception 'PM_INVALID: the file has no content hash; upload it again' using errcode = '22023'; end if;
  if coalesce(v.mime_type, '') <> 'application/pdf' then raise exception 'PM_INVALID: only PDF files can be signed' using errcode = '22023'; end if;
  if exists (select 1 from pm.esign_envelopes e where e.file_id = f.id and e.status in ('draft', 'sent')) then
    raise exception 'PM_ESIGN_OPEN: this document already has an open signature request' using errcode = '23505';
  end if;
  if jsonb_typeof(p_signers) <> 'array' or jsonb_array_length(p_signers) not between 1 and 10 then
    raise exception 'PM_INVALID: add between 1 and 10 signers' using errcode = '22023';
  end if;

  v_kind := coalesce(nullif(a #>> '{on_completed,kind}', ''), 'none');
  v_subject := pm.access_try_uuid(a #>> '{on_completed,id}');
  if v_kind <> 'none' then
    v_ok := case v_kind
      when 'estimate' then exists (select 1 from pm.estimates x where x.id = v_subject and x.org_id = f.org_id and x.job_id is not distinct from f.job_id)
      when 'change_order' then exists (select 1 from pm.change_orders x where x.id = v_subject and x.org_id = f.org_id and x.job_id is not distinct from f.job_id)
      when 'lien_waiver' then exists (select 1 from pm.compliance_docs x where x.id = v_subject and x.org_id = f.org_id and x.job_id is not distinct from f.job_id
                                      and x.doc_type like 'LIEN_WAIVER%')
      when 'dealer_quote' then exists (select 1 from pm.dealer_quotes x where x.id = v_subject and x.org_id = f.org_id and x.location_id = f.location_id)
      else false end;
    if not coalesce(v_ok, false) then
      raise exception 'PM_INVALID: the % to update on completion is not on this document''s job', v_kind using errcode = '22023';
    end if;
    -- security review H2: the document must BE that record's document …
    if f.subject_table is distinct from (case v_kind when 'estimate' then 'estimates' when 'change_order' then 'change_orders'
                                                    when 'lien_waiver' then 'compliance_docs' when 'dealer_quote' then 'dealer_quotes' end)
       or f.subject_id is distinct from v_subject then
      raise exception 'PM_INVALID: only the % document itself can update the % when signed', replace(v_kind, '_', ' '), replace(v_kind, '_', ' ') using errcode = '22023';
    end if;
    -- … and the sender must hold the authority the completion action uses (re-checked as the sender when it runs)
    v_ok := case v_kind
        when 'estimate' then pm.access_can_row('projects.estimates', 'edit', 'estimates', v_subject)
        when 'change_order' then pm.access_can_row('projects.change_orders', 'approve', 'change_orders', v_subject)
        when 'lien_waiver' then pm.access_can_row('projects.commitments', 'edit', 'compliance_docs', v_subject)
        when 'dealer_quote' then pm.access_can_row('projects.store', 'edit', 'dealer_quotes', v_subject)
        else false end;
    if not coalesce(v_ok, false) then
      raise exception 'PM_FORBIDDEN: you cannot % this %, so a signature cannot do it for you',
        (case v_kind when 'estimate' then 'accept' when 'change_order' then 'approve' when 'lien_waiver' then 'receive' else 'accept' end),
        replace(v_kind, '_', ' ') using errcode = '42501';
    end if;
  end if;
  v_days := least(greatest(coalesce((a ->> 'expires_days')::int, 14), 1), 90);
  v_routing := coalesce(nullif(a ->> 'routing', ''), 'sequential');

  insert into pm.esign_envelopes (org_id, location_id, job_id, file_id, version_id, title, message, routing, expires_at,
                                  on_completed_kind, on_completed_id, sender_user, original_sha256)
  values (f.org_id, f.location_id, f.job_id, f.id, v.id,
          left(coalesce(nullif(btrim(a ->> 'title'), ''), f.title), 200), left(nullif(btrim(a ->> 'message'), ''), 2000),
          v_routing, now() + make_interval(days => v_days),
          v_kind, case when v_kind = 'none' then null else v_subject end, coalesce(pm.current_user_id(), 'system'), v.content_sha256)
  returning id into v_env;

  for s in select value from jsonb_array_elements(p_signers) loop
    i := i + 1;
    insert into pm.esign_signers (org_id, envelope_id, routing_order, position, name, email, phone, role_label, channel)
    values (f.org_id, v_env,
            case when v_routing = 'parallel' then 1 else coalesce((s ->> 'order')::int, i) end, i,
            btrim(s ->> 'name'), nullif(lower(btrim(s ->> 'email')), ''), nullif(btrim(s ->> 'phone'), ''),
            nullif(btrim(s ->> 'role_label'), ''),
            coalesce(nullif(s ->> 'channel', ''), case when nullif(btrim(s ->> 'email'), '') is not null then 'email'
                                                         when nullif(btrim(s ->> 'phone'), '') is not null then 'sms' else 'link' end));
  end loop;
  perform pm._esign_event(v_env, null, 'created', null, null, jsonb_build_object('signers', i, 'version_no', v.version_no, 'sha256', v.content_sha256));
  return v_env;
end $$;

-- Send: the first routing order becomes pending_send (the app then issues each a token and delivers).
create or replace function pm.esign_send(p_envelope uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.esign_envelopes%rowtype; v_first int;
begin
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = public.get_org_id() for update;
  if e.id is null or not pm._esign_can_manage(e.id) then raise exception 'PM_FORBIDDEN: signature request % not found', p_envelope using errcode = '42501'; end if;
  if e.status <> 'draft' then raise exception 'PM_ESIGN_STATE: the request is %', e.status using errcode = '22023'; end if;
  select min(s.routing_order) into v_first from pm.esign_signers s where s.envelope_id = e.id;
  update pm.esign_envelopes set status = 'sent', sent_at = now(), updated_at = now()
   where id = e.id;
  update pm.esign_signers set status = 'pending_send' where envelope_id = e.id and routing_order = v_first;
  perform pm._esign_event(e.id, null, 'sent', null, null, jsonb_build_object('first_order', v_first));
  return jsonb_build_object('envelope_id', e.id,
    'pending', coalesce((select jsonb_agg(s.id order by s.position) from pm.esign_signers s where s.envelope_id = e.id and s.status = 'pending_send'), '[]'::jsonb));
end $$;

-- Issue (or re-issue) a signer's one-time link: the app generates the token, sends only its sha-256.
-- Any earlier token of the signer is revoked. Returns the contact details for delivery.
create or replace function pm.esign_issue_token(p_signer uuid, p_token_hash text, p_expires timestamptz default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.esign_signers%rowtype; e pm.esign_envelopes%rowtype; v_exp timestamptz; v_resend boolean;
begin
  select * into s from pm.esign_signers x where x.id = p_signer and x.org_id = public.get_org_id() for update;
  if s.id is null then raise exception 'PM_FORBIDDEN: signer % not found', p_signer using errcode = '42501'; end if;
  select * into e from pm.esign_envelopes x where x.id = s.envelope_id for update;
  if not pm._esign_can_manage(e.id) then raise exception 'PM_FORBIDDEN: only the sender or a document editor can send links' using errcode = '42501'; end if;
  if e.status <> 'sent' then raise exception 'PM_ESIGN_STATE: the request is %', e.status using errcode = '22023'; end if;
  if e.expires_at <= now() then raise exception 'PM_ESIGN_EXPIRED: the request expired' using errcode = '22023'; end if;
  if s.status not in ('pending_send', 'sent', 'viewed') then
    raise exception 'PM_ESIGN_STATE: this signer is %', s.status using errcode = '22023';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash must be sha-256 hex' using errcode = '22023'; end if;
  v_resend := s.status <> 'pending_send';
  v_exp := least(coalesce(p_expires, e.expires_at), e.expires_at);
  update pm.esign_tokens set revoked_at = now() where signer_id = s.id and revoked_at is null and used_at is null;
  insert into pm.esign_tokens (org_id, envelope_id, signer_id, token_hash, expires_at, issued_by)
  values (s.org_id, e.id, s.id, p_token_hash, v_exp, pm.current_user_id());
  update pm.esign_signers set status = case when status = 'pending_send' then 'sent' else status end, sent_at = coalesce(sent_at, now())
   where id = s.id;
  perform pm._esign_event(e.id, s.id, case when v_resend then 'resent' else 'delivered' end, null, null,
    jsonb_build_object('channel', s.channel, 'expires_at', v_exp));
  return jsonb_build_object('signer_id', s.id, 'name', s.name, 'email', s.email, 'phone', s.phone, 'channel', s.channel,
    'envelope_id', e.id, 'title', e.title, 'message', e.message, 'expires_at', v_exp, 'resend', v_resend);
end $$;

create or replace function pm.esign_void(p_envelope uuid, p_reason text) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.esign_envelopes%rowtype;
begin
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = public.get_org_id() for update;
  if e.id is null or not pm._esign_can_manage(e.id) then raise exception 'PM_FORBIDDEN: signature request % not found', p_envelope using errcode = '42501'; end if;
  if e.status not in ('draft', 'sent') then raise exception 'PM_ESIGN_STATE: the request is %', e.status using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'PM_INVALID: say why the request is voided' using errcode = '22023'; end if;
  update pm.esign_envelopes set status = 'voided', voided_at = now(), voided_by = pm.current_user_id(),
         void_reason = left(btrim(p_reason), 500), updated_at = now() where id = e.id;
  update pm.esign_tokens set revoked_at = now() where envelope_id = e.id and revoked_at is null and used_at is null;
  perform pm._esign_event(e.id, null, 'voided', null, null, jsonb_build_object('reason', left(btrim(p_reason), 500)));
end $$;

-- The app stamped the signed PDF + audit certificate (from the exact signed version) and uploaded it:
-- record it as the new, locked, current version and start the retention clock.
create or replace function pm.esign_finalize(p_envelope uuid, p_document uuid, p_sha256 text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.esign_envelopes%rowtype; f pm.doc_files%rowtype; o pm.doc_versions%rowtype; v pm.doc_versions%rowtype; v_years int;
begin
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = public.get_org_id() for update;
  if e.id is null or not pm._esign_can_manage(e.id) then raise exception 'PM_FORBIDDEN: signature request % not found', p_envelope using errcode = '42501'; end if;
  if e.status <> 'completed' then raise exception 'PM_ESIGN_STATE: the request is %', e.status using errcode = '22023'; end if;
  if e.finalize_state = 'done' then
    return jsonb_build_object('envelope_id', e.id, 'version_id', e.signed_version_id, 'already', true);
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: sha-256 required' using errcode = '22023'; end if;
  select * into f from pm.doc_files x where x.id = e.file_id for update;
  select * into o from pm.doc_versions x where x.id = e.version_id;
  if f.current_version_id is distinct from e.version_id then
    raise exception 'PM_ESIGN_STALE: the document changed after it was sent' using errcode = '22023';
  end if;
  v := pm._doc_insert_version(f.id, p_document,
         jsonb_build_object('file_name', regexp_replace(o.file_name, '(\.pdf)?$', ' (signed).pdf', 'i'), 'mime_type', 'application/pdf',
                            'content_sha256', p_sha256, 'label', 'Signed',
                            'note', format('Signed by %s', (select string_agg(s.name, ', ' order by s.position) from pm.esign_signers s where s.envelope_id = e.id)),
                            'meta', jsonb_build_object('envelope_id', e.id, 'signed_from', o.id, 'original_sha256', e.original_sha256)),
         'esign', true);
  v_years := pm.doc_retention_years(f.retention_class);
  update pm.doc_files set retain_until = greatest(coalesce(retain_until, current_date),
           case when v_years is null then date '9999-12-31' else (current_date + make_interval(years => v_years))::date end),
         updated_at = now()
   where id = f.id;
  update pm.esign_envelopes set finalize_state = 'done', finalize_error = null, signed_version_id = v.id, signed_document_id = p_document,
         signed_sha256 = p_sha256, updated_at = now()
   where id = e.id;
  perform pm._esign_event(e.id, null, 'finalized', null, null, jsonb_build_object('version_id', v.id, 'sha256', p_sha256));
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'document.signed', 'doc_files', f.id,
    format('%s signed', left(e.title, 120)), jsonb_build_object('envelope_id', e.id, 'version_id', v.id));
  return jsonb_build_object('envelope_id', e.id, 'version_id', v.id, 'version_no', v.version_no);
end $$;

create or replace function pm.esign_finalize_failed(p_envelope uuid, p_error text) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.esign_envelopes%rowtype;
begin
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = public.get_org_id() for update;
  if e.id is null or not pm._esign_can_manage(e.id) then raise exception 'PM_FORBIDDEN: signature request % not found', p_envelope using errcode = '42501'; end if;
  if e.finalize_state = 'done' then return; end if;
  update pm.esign_envelopes set finalize_state = 'failed', finalize_error = left(p_error, 1000), updated_at = now() where id = e.id;
  perform pm._esign_event(e.id, null, 'finalize_failed', null, null, jsonb_build_object('error', left(p_error, 500)));
end $$;

-- Settle an outbox event the app handled. A failure retries up to 5 times, then stays failed.
create or replace function pm.esign_outbox_settle(p_id uuid, p_ok boolean, p_outcome jsonb default '{}', p_error text default null) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.esign_outbox%rowtype; v_status text;
begin
  select * into o from pm.esign_outbox x where x.id = p_id and x.org_id = public.get_org_id() for update;
  if o.id is null or not pm._esign_can_manage(o.envelope_id) then raise exception 'PM_FORBIDDEN: event % not found', p_id using errcode = '42501'; end if;
  if o.status <> 'pending' then return o.status; end if;
  -- security review H2: a record callback runs only under the sender's own authority
  if o.kind <> 'signer.turn' and o.subject_kind <> 'none' and not pm.access_is_service()
     and (select e.sender_user from pm.esign_envelopes e where e.id = o.envelope_id) is distinct from pm.current_user_id() then
    raise exception 'PM_FORBIDDEN: only the person who sent the request can complete what its signature does' using errcode = '42501';
  end if;
  v_status := case when p_ok then 'done' when o.attempts + 1 >= 5 then 'failed' else 'pending' end;
  update pm.esign_outbox set status = v_status, attempts = attempts + 1,
         last_error = case when p_ok then null else left(p_error, 1000) end,
         outcome = case when jsonb_typeof(p_outcome) = 'object' then p_outcome else '{}'::jsonb end,
         handled_at = case when v_status <> 'pending' then now() end,
         handled_by = pm.current_user_id()
   where id = o.id;
  if o.kind <> 'signer.turn' then
    perform pm._esign_event(o.envelope_id, o.signer_id, case when p_ok then 'callback_done' else 'callback_failed' end, null, null,
      jsonb_build_object('kind', o.kind, 'subject_kind', o.subject_kind, 'subject_id', o.subject_id, 'triggered_by', pm.current_user_id(),
                         'outcome', p_outcome, 'error', left(p_error, 300)));
  end if;
  return v_status;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Public signing surface (schema esign; anon-executable; token-scoped)
-- ----------------------------------------------------------------------------
create schema if not exists esign;
comment on schema esign is
  '1115: public e-signature RPCs (token-scoped, SECURITY DEFINER). The only functions anon may execute for Projects.';

-- Resolve a raw token (internal to esign; not executable by anyone but the owner).
create or replace function esign._resolve(p_token text, out t pm.esign_tokens, out reason text)
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_hash text;
begin
  reason := null;
  if p_token is null or char_length(p_token) not between 20 and 200 or p_token !~ '^[A-Za-z0-9_-]+$' then
    reason := 'invalid'; return;
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into t from pm.esign_tokens x where x.token_hash = v_hash;
  if t.id is null then reason := 'invalid'; return; end if;
  if t.revoked_at is not null then reason := 'revoked';
  elsif t.used_at is not null then reason := 'used';
  elsif t.expires_at <= now() then reason := 'expired';
  end if;
end $$;

create or replace function esign._gateway_ip() returns text
language plpgsql stable
as $$
begin
  return left(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', 200);
exception when others then
  return null;
end $$;

-- Envelope state shared by open / sign / decline (internal).
create or replace function esign._state(p_env uuid, p_signer uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'envelope', jsonb_build_object('id', e.id, 'title', e.title, 'message', e.message, 'status', e.status,
                                   'expires_at', e.expires_at, 'sent_at', e.sent_at, 'completed_at', e.completed_at,
                                   'sha256', e.original_sha256),
    'document', jsonb_build_object('title', f.title, 'file_name', v.file_name, 'page_count', v.page_count, 'kind', f.kind),
    'company', pm._doc_brand(e.location_id),
    'signer', (select jsonb_build_object('id', s.id, 'name', s.name, 'email', s.email, 'role_label', s.role_label,
                                         'status', s.status, 'signed_at', s.signed_at, 'routing_order', s.routing_order)
                 from pm.esign_signers s where s.id = p_signer),
    'signers', (select jsonb_agg(jsonb_build_object('name', s.name, 'role_label', s.role_label, 'routing_order', s.routing_order,
                                                    'status', s.status, 'signed_at', s.signed_at, 'you', s.id = p_signer)
                                 order by s.routing_order, s.position)
                  from pm.esign_signers s where s.envelope_id = e.id),
    'consent', jsonb_build_object('version', pm.esign_consent_version(), 'text', pm.esign_consent_text()))
  from pm.esign_envelopes e
  join pm.doc_files f on f.id = e.file_id
  join pm.doc_versions v on v.id = e.version_id
  where e.id = p_env
$$;

create or replace function esign.open(p_token text, p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; e pm.esign_envelopes%rowtype; s pm.esign_signers%rowtype; v_reason text; v_can boolean := false;
begin
  select * into r from esign._resolve(p_token);
  if r.reason = 'invalid' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into e from pm.esign_envelopes x where x.id = (r.t).envelope_id for update;
  select * into s from pm.esign_signers x where x.id = (r.t).signer_id for update;
  v_reason := r.reason;
  if e.status = 'sent' and e.expires_at <= now() then
    update pm.esign_envelopes set status = 'expired', updated_at = now() where id = e.id;
    perform pm._esign_event(e.id, null, 'expired', null, null, '{}');
    e.status := 'expired';
  end if;
  if v_reason is null then
    v_reason := case
      when e.status = 'voided' then 'voided'
      when e.status = 'expired' then 'expired'
      when e.status = 'declined' then 'declined'
      when e.status = 'completed' or s.status = 'signed' then 'signed'
      when s.status = 'waiting' then 'waiting'
      when s.status = 'declined' then 'declined'
      else null end;
  end if;
  if v_reason is null and s.status in ('sent', 'viewed') then
    v_can := true;
    if s.viewed_at is null then
      update pm.esign_signers set status = 'viewed', viewed_at = now() where id = s.id;
      perform pm._esign_event(e.id, s.id, 'viewed', p_ip, p_user_agent, jsonb_build_object('gateway_ip', esign._gateway_ip()));
    end if;
  elsif v_reason in ('used', 'expired', 'revoked') then
    perform pm._esign_event(e.id, s.id, 'token_rejected', p_ip, p_user_agent, jsonb_build_object('reason', v_reason, 'action', 'open'));
  end if;
  -- security review M: a link that cannot act learns nothing but why
  if not v_can then return jsonb_build_object('ok', false, 'reason', v_reason); end if;
  return esign._state(e.id, s.id) || jsonb_build_object('ok', true, 'reason', null, 'can_act', true);
end $$;

-- The file route's re-check (every request): the storage key of the exact version being signed,
-- only while this link may still act — unrevoked, unused, unexpired, the request still out and the
-- signer's turn. No side effects. Anything else → {ok:false, reason}; the route answers 410.
create or replace function esign.document(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r record; e pm.esign_envelopes%rowtype; s pm.esign_signers%rowtype; v_path text; v_name text; v_mime text;
begin
  select * into r from esign._resolve(p_token);
  if r.reason is not null then return jsonb_build_object('ok', false, 'reason', r.reason); end if;
  select * into e from pm.esign_envelopes x where x.id = (r.t).envelope_id;
  select * into s from pm.esign_signers x where x.id = (r.t).signer_id;
  if e.status <> 'sent' then return jsonb_build_object('ok', false, 'reason', e.status); end if;
  if e.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if s.status not in ('sent', 'viewed') then return jsonb_build_object('ok', false, 'reason', s.status); end if;
  select d.storage_path, v.file_name, coalesce(v.mime_type, d.mime_type) into v_path, v_name, v_mime
    from pm.doc_versions v join public.documents d on d.id = v.document_id
   where v.id = e.version_id and d.org_id = e.org_id;
  if v_path is null or v_path not like e.org_id::text || '/pm/%' then return jsonb_build_object('ok', false, 'reason', 'unavailable'); end if;
  return jsonb_build_object('ok', true, 'reason', null, 'path', v_path, 'file_name', v_name, 'mime_type', v_mime);
end $$;

-- What a signer sees after acting: statuses only (no document, no contact details). Internal.
create or replace function esign._result(p_env uuid, p_signer uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'envelope', jsonb_build_object('id', e.id, 'title', e.title, 'status', e.status, 'completed_at', e.completed_at),
    'company', pm._doc_brand(e.location_id),
    'signer', (select jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'signed_at', s.signed_at, 'routing_order', s.routing_order)
                 from pm.esign_signers s where s.id = p_signer),
    'signers', (select jsonb_agg(jsonb_build_object('name', s.name, 'role_label', s.role_label, 'routing_order', s.routing_order,
                                                    'status', s.status, 'signed_at', s.signed_at, 'you', s.id = p_signer)
                                 order by s.routing_order, s.position)
                  from pm.esign_signers s where s.envelope_id = e.id))
  from pm.esign_envelopes e where e.id = p_env
$$;

create or replace function esign.sign(p_token text, p_typed_name text, p_signature_png text, p_consent boolean,
                                      p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; e pm.esign_envelopes%rowtype; s pm.esign_signers%rowtype; v_next int; v_left int;
begin
  select * into r from esign._resolve(p_token);
  if r.reason = 'invalid' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into e from pm.esign_envelopes x where x.id = (r.t).envelope_id for update;
  select * into s from pm.esign_signers x where x.id = (r.t).signer_id for update;
  if r.reason is not null or e.status <> 'sent' or e.expires_at <= now() or s.status not in ('sent', 'viewed') then
    perform pm._esign_event(e.id, s.id, 'token_rejected', p_ip, p_user_agent,
      jsonb_build_object('reason', coalesce(r.reason, e.status, s.status), 'action', 'sign'));
    return jsonb_build_object('ok', false, 'reason', coalesce(r.reason,
      case when e.status = 'sent' and e.expires_at <= now() then 'expired' when e.status <> 'sent' then e.status else s.status end));
  end if;
  if not coalesce(p_consent, false) then return jsonb_build_object('ok', false, 'reason', 'consent_required'); end if;
  if char_length(btrim(coalesce(p_typed_name, ''))) not between 2 and 120 then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if p_signature_png is null or char_length(p_signature_png) > 400000 or p_signature_png !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$'
     or char_length(p_signature_png) < 200 then
    return jsonb_build_object('ok', false, 'reason', 'signature_required');
  end if;

  update pm.esign_tokens set used_at = now() where id = (r.t).id;
  update pm.esign_signers set status = 'signed', signed_at = clock_timestamp(), consented_at = coalesce(consented_at, clock_timestamp()),
         consent_version = pm.esign_consent_version(), typed_name = btrim(p_typed_name), signature_png = p_signature_png,
         sign_ip = left(p_ip, 64), sign_user_agent = left(p_user_agent, 500), gateway_ip = esign._gateway_ip(),
         viewed_at = coalesce(viewed_at, now())
   where id = s.id;
  perform pm._esign_event(e.id, s.id, 'consented', p_ip, p_user_agent, jsonb_build_object('version', pm.esign_consent_version()));
  perform pm._esign_event(e.id, s.id, 'signed', p_ip, p_user_agent,
    jsonb_build_object('typed_name', btrim(p_typed_name), 'gateway_ip', esign._gateway_ip(),
                       'signature_sha256', encode(sha256(convert_to(p_signature_png, 'UTF8')), 'hex')));

  select count(*) into v_left from pm.esign_signers x where x.envelope_id = e.id and x.status <> 'signed';
  if v_left = 0 then
    update pm.esign_envelopes set status = 'completed', completed_at = clock_timestamp(), finalize_state = 'pending', updated_at = now()
     where id = e.id;
    perform pm._esign_event(e.id, null, 'completed', null, null, '{}');
    insert into pm.esign_outbox (org_id, envelope_id, kind, subject_kind, subject_id)
    values (e.org_id, e.id, 'envelope.completed', e.on_completed_kind, e.on_completed_id);
  elsif not exists (select 1 from pm.esign_signers x where x.envelope_id = e.id and x.routing_order = s.routing_order and x.status <> 'signed') then
    select min(x.routing_order) into v_next from pm.esign_signers x where x.envelope_id = e.id and x.status = 'waiting';
    if v_next is not null then
      update pm.esign_signers set status = 'pending_send' where envelope_id = e.id and routing_order = v_next and status = 'waiting';
      insert into pm.esign_outbox (org_id, envelope_id, signer_id, kind, subject_kind, subject_id)
      select e.org_id, e.id, x.id, 'signer.turn', 'none', null from pm.esign_signers x
       where x.envelope_id = e.id and x.routing_order = v_next and x.status = 'pending_send';
    end if;
  end if;
  return esign._result(e.id, s.id) || jsonb_build_object('ok', true, 'reason', null, 'can_act', false);
end $$;

create or replace function esign.decline(p_token text, p_reason text, p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record; e pm.esign_envelopes%rowtype; s pm.esign_signers%rowtype;
begin
  select * into r from esign._resolve(p_token);
  if r.reason = 'invalid' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into e from pm.esign_envelopes x where x.id = (r.t).envelope_id for update;
  select * into s from pm.esign_signers x where x.id = (r.t).signer_id for update;
  if r.reason is not null or e.status <> 'sent' or e.expires_at <= now() or s.status not in ('sent', 'viewed') then
    perform pm._esign_event(e.id, s.id, 'token_rejected', p_ip, p_user_agent,
      jsonb_build_object('reason', coalesce(r.reason, e.status, s.status), 'action', 'decline'));
    return jsonb_build_object('ok', false, 'reason', coalesce(r.reason,
      case when e.status = 'sent' and e.expires_at <= now() then 'expired' when e.status <> 'sent' then e.status else s.status end));
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 1000 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  update pm.esign_tokens set used_at = now() where id = (r.t).id;
  update pm.esign_tokens set revoked_at = now() where envelope_id = e.id and revoked_at is null and used_at is null;
  update pm.esign_signers set status = 'declined', declined_at = now(), decline_reason = btrim(p_reason),
         sign_ip = left(p_ip, 64), sign_user_agent = left(p_user_agent, 500), gateway_ip = esign._gateway_ip()
   where id = s.id;
  update pm.esign_envelopes set status = 'declined', declined_at = now(), decline_reason = left(btrim(p_reason), 1000), updated_at = now()
   where id = e.id;
  perform pm._esign_event(e.id, s.id, 'declined', p_ip, p_user_agent, jsonb_build_object('reason', left(btrim(p_reason), 1000)));
  insert into pm.esign_outbox (org_id, envelope_id, signer_id, kind, subject_kind, subject_id)
  values (e.org_id, e.id, s.id, 'envelope.declined', e.on_completed_kind, e.on_completed_id);
  return esign._result(e.id, s.id) || jsonb_build_object('ok', true, 'reason', null, 'can_act', false);
end $$;

revoke all on schema esign from public;
grant usage on schema esign to anon, authenticated, service_role;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'esign' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('open', 'sign', 'decline', 'document') then
      execute format('grant execute on function %s to anon, authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 13. Folder template catalog (per pack)
-- ----------------------------------------------------------------------------
insert into pm.doc_folder_templates as t (pack_key, folders) values
  ('general', '[
    {"key":"contract","name":"Contract and proposals","money_cap":"projects.contract_value","kinds":["contract","proposal"]},
    {"key":"change_orders","name":"Change orders","money_cap":"projects.contract_value","kinds":["change_order"]},
    {"key":"billing","name":"Billing","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"purchasing","name":"Purchase orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"drawings","name":"Plans and drawings","kinds":["drawing_set","spec"]},
    {"key":"permits","name":"Permits and inspections","kinds":["permit","inspection"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"field","name":"Daily reports and work orders","kinds":["daily_report","work_order","install_ticket"]},
    {"key":"closeout","name":"Warranty and closeout","kinds":["warranty","manual","closeout"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other","rfi","submittal"]}]'),
  ('commercial_gc', '[
    {"key":"c01_contract","name":"01 Contract","money_cap":"projects.contract_value","kinds":["contract","proposal"]},
    {"key":"c02_insurance","name":"02 Insurance and bonds","kinds":["form"]},
    {"key":"c03_drawings","name":"03 Drawings","kinds":["drawing_set"]},
    {"key":"c04_specifications","name":"04 Specifications","kinds":["spec"]},
    {"key":"c05_submittals","name":"05 Submittals","kinds":["submittal"]},
    {"key":"c06_rfis","name":"06 RFIs","kinds":["rfi"]},
    {"key":"c07_change_orders","name":"07 Change orders","money_cap":"projects.contract_value","kinds":["change_order"]},
    {"key":"c08_pay_applications","name":"08 Pay applications","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"c09_subcontracts","name":"09 Subcontracts and POs","money_cap":"projects.financials","kinds":["subcontract","po","lien_waiver"]},
    {"key":"c10_field","name":"10 Daily reports and photos","kinds":["daily_report","photo","work_order","install_ticket"]},
    {"key":"c11_permits","name":"11 Permits and inspections","kinds":["permit","inspection"]},
    {"key":"c12_closeout","name":"12 Closeout","kinds":["closeout","warranty","manual"]},
    {"key":"general","name":"Correspondence","kinds":["file","form","correspondence","other"]}]'),
  ('specialty_trade', '[
    {"key":"contract","name":"Subcontract and proposals","money_cap":"projects.contract_value","kinds":["contract","proposal"]},
    {"key":"drawings","name":"Drawings and specs","kinds":["drawing_set","spec"]},
    {"key":"submittals","name":"Submittals and RFIs","kinds":["submittal","rfi"]},
    {"key":"change_orders","name":"Change orders","money_cap":"projects.contract_value","kinds":["change_order"]},
    {"key":"billing","name":"Pay applications and lien waivers","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"purchasing","name":"Purchase orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"field","name":"Daily reports and photos","kinds":["daily_report","photo","work_order","install_ticket"]},
    {"key":"closeout","name":"Closeout and warranty","kinds":["closeout","warranty","manual","inspection","permit"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other"]}]'),
  ('residential_remodel', '[
    {"key":"contract","name":"Proposal and contract","money_cap":"projects.contract_value","kinds":["proposal","contract"]},
    {"key":"design","name":"Design and selections","kinds":["spec","drawing_set"]},
    {"key":"change_orders","name":"Change orders","money_cap":"projects.contract_value","kinds":["change_order"]},
    {"key":"billing","name":"Invoices and draws","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"purchasing","name":"Orders and trade agreements","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"permits","name":"Permits and inspections","kinds":["permit","inspection"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"field","name":"Daily logs","kinds":["daily_report","work_order","install_ticket"]},
    {"key":"closeout","name":"Warranty and care","kinds":["warranty","manual","closeout"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other","rfi","submittal"]}]'),
  ('home_builder', '[
    {"key":"contract","name":"Purchase agreement and addenda","money_cap":"projects.contract_value","kinds":["contract","proposal","change_order"]},
    {"key":"plans","name":"Plans and options","kinds":["drawing_set","spec"]},
    {"key":"selections","name":"Design center","kinds":["form"]},
    {"key":"purchasing","name":"Start package and VPOs","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"draws","name":"Draws","money_cap":"projects.contract_value","kinds":["draw_request","pay_app"]},
    {"key":"permits","name":"Permits and inspections","kinds":["permit","inspection"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"field","name":"Field reports","kinds":["daily_report","work_order","install_ticket"]},
    {"key":"closeout","name":"Closing and warranty","kinds":["closeout","warranty","manual"]},
    {"key":"general","name":"General","kinds":["file","correspondence","other","rfi","submittal"]}]'),
  ('field_service', '[
    {"key":"work_orders","name":"Work orders and tickets","kinds":["work_order","install_ticket","daily_report"]},
    {"key":"agreements","name":"Agreements and proposals","money_cap":"projects.contract_value","kinds":["proposal","contract","change_order"]},
    {"key":"billing","name":"Invoices","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"purchasing","name":"Parts orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"equipment","name":"Equipment manuals and warranty","kinds":["manual","warranty"]},
    {"key":"permits","name":"Permits and inspections","kinds":["permit","inspection"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other","drawing_set","spec","closeout","rfi","submittal"]}]'),
  ('manufacturing_eto', '[
    {"key":"contract","name":"Quote and order","money_cap":"projects.contract_value","kinds":["proposal","contract","change_order"]},
    {"key":"drawings","name":"Shop drawings and approvals","kinds":["drawing_set","spec","submittal"]},
    {"key":"purchasing","name":"Purchase orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"production","name":"Work orders and travelers","kinds":["work_order","daily_report"]},
    {"key":"install","name":"Install tickets and photos","kinds":["install_ticket","photo"]},
    {"key":"billing","name":"Invoices","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"closeout","name":"Warranty and care","kinds":["warranty","manual","closeout","inspection","permit"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other","rfi"]}]'),
  ('flooring', '[
    {"key":"contract","name":"Quote and contract","money_cap":"projects.contract_value","kinds":["proposal","contract","change_order"]},
    {"key":"measure","name":"Measures and layouts","kinds":["drawing_set","spec","form"]},
    {"key":"purchasing","name":"Material orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"install","name":"Install tickets","kinds":["install_ticket","work_order","daily_report"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"billing","name":"Invoices","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"closeout","name":"Warranty and care","kinds":["warranty","manual","closeout","inspection","permit"]},
    {"key":"general","name":"General","kinds":["file","correspondence","other","rfi","submittal"]}]'),
  ('interior_design', '[
    {"key":"contract","name":"Design agreement and proposals","money_cap":"projects.contract_value","kinds":["contract","proposal","change_order"]},
    {"key":"design","name":"Concepts and specifications","kinds":["spec","drawing_set","form"]},
    {"key":"purchasing","name":"Purchase orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"receiving","name":"Receiving and install","kinds":["install_ticket","work_order","daily_report"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"billing","name":"Invoices","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"general","name":"General","kinds":["file","correspondence","other","manual","warranty","closeout","permit","inspection","rfi","submittal"]}]'),
  ('equipment_dealer', '[
    {"key":"deal","name":"Buyer''s orders and quotes","money_cap":"projects.contract_value","kinds":["buyers_order","proposal","contract"]},
    {"key":"service","name":"Repair orders","kinds":["work_order","install_ticket","daily_report"]},
    {"key":"purchasing","name":"Parts and unit orders","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"photos","name":"Photos","kinds":["photo"]},
    {"key":"warranty","name":"Warranty and manuals","kinds":["warranty","manual"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other","change_order","pay_app","draw_request","drawing_set","spec","permit","inspection","closeout","rfi","submittal"]}]'),
  ('real_estate_development', '[
    {"key":"acquisition","name":"Acquisition and title","money_cap":"projects.contract_value","kinds":["contract"]},
    {"key":"entitlements","name":"Entitlements and permits","kinds":["permit","inspection"]},
    {"key":"design","name":"Design and drawings","kinds":["drawing_set","spec","submittal","rfi"]},
    {"key":"financing","name":"Financing and draws","money_cap":"projects.contract_value","kinds":["draw_request","pay_app"]},
    {"key":"construction","name":"Construction contracts and COs","money_cap":"projects.contract_value","kinds":["proposal","change_order"]},
    {"key":"purchasing","name":"Commitments and lien waivers","money_cap":"projects.financials","kinds":["po","subcontract","lien_waiver"]},
    {"key":"field","name":"Field reports and photos","kinds":["daily_report","photo","work_order","install_ticket"]},
    {"key":"closeout","name":"Sales, leasing and closeout","kinds":["closeout","warranty","manual"]},
    {"key":"general","name":"General","kinds":["file","form","correspondence","other"]}]'),
  ('professional_services', '[
    {"key":"engagement","name":"Engagement letter and proposals","money_cap":"projects.contract_value","kinds":["contract","proposal","change_order"]},
    {"key":"deliverables","name":"Deliverables","kinds":["file","spec","drawing_set","form"]},
    {"key":"billing","name":"Invoices","money_cap":"projects.contract_value","kinds":["pay_app","draw_request"]},
    {"key":"general","name":"Correspondence","kinds":["correspondence","other","photo","daily_report","work_order","po","subcontract","lien_waiver","permit","inspection","manual","warranty","closeout","install_ticket","rfi","submittal"]}]')
on conflict (pack_key) do update set folders = excluded.folders, updated_at = now(),
  version = t.version + case when t.folders is distinct from excluded.folders then 1 else 0 end;

-- ----------------------------------------------------------------------------
-- 14. 1110 registries: classes, RPC guards, allowlist
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('doc_folder_templates',  'S','org',             '{}',                     null,                 null, null, null, null, false, '1115: global catalog (no org_id); service_role writes'),
  ('doc_folders',           'J','job',             '{projects.documents}',   'projects.documents', null, null, null, null, false, '1115: job folders'),
  ('doc_files',             'J','job_or_location', '{projects.documents}',   'projects.documents', null, null, null, null, false, '1115: + RESTRICTIVE pm_docs_money (money_cap)'),
  ('doc_versions',          'J','parent',          '{}',                     null,                 'doc_files', 'file_id', null, null, false, '1115: written only by the doc_* / esign_* RPCs; follows doc_files visibility'),
  ('doc_photo_meta',        'J','job_or_location', '{projects.documents}',   'projects.documents', null, null, null, null, false, '1115: photo metadata; received_at is server time'),
  ('drawing_sets',          'J','job',             '{projects.documents}',   null,                 null, null, null, null, false, '1115: written by drawing_* RPCs'),
  ('drawing_sheets',        'J','job',             '{projects.documents}',   null,                 null, null, null, null, false, '1115: written by drawing_* RPCs'),
  ('drawing_revisions',     'J','job',             '{projects.documents}',   null,                 null, null, null, null, false, '1115: written by drawing_* RPCs'),
  ('drawing_markups',       'J','job',             '{projects.documents}',   'projects.documents', null, null, null,
     '(%1$sauthor_user = (select pm.current_user_id()) and %1$svisibility = ''personal'' and %1$sjob_id in (select pm.my_job_ids_with(''projects.documents'', ''create'')))',
     false, '1115: own personal markups with documents:create; published ones with documents:edit; + RESTRICTIVE visibility'),
  ('doc_template_settings', 'S','location',        '{}',                     'projects.settings',  null, null, null, null, false, '1115: company template text'),
  ('esign_envelopes',       'J','job_or_location', '{projects.documents}',   null,                 null, null, null, null, false, '1115: written by esign_* RPCs; follows doc_files visibility'),
  ('esign_signers',         'J','parent',          '{}',                     null,                 'esign_envelopes', 'envelope_id', null, null, false, '1115: written by esign RPCs'),
  ('esign_tokens',          'J','parent',          '{}',                     null,                 'esign_envelopes', 'envelope_id', null, null, false, '1115: no member grants (token hashes)'),
  ('esign_events',          'J','parent',          '{}',                     null,                 'esign_envelopes', 'envelope_id', null, null, false, '1115: audit trail (append-only, definer-written)'),
  ('esign_outbox',          'J','parent',          '{}',                     null,                 'esign_envelopes', 'envelope_id', null, null, false, '1115: webhook-style events; settled by pm.esign_outbox_settle'),
  ('storage_delete_grants', 'O','org',             '{}',                     null,                 null, null, null, null, false, '1115: one-time storage delete permission minted by pm.doc_discard_upload; no member grants')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('doc_brand',              '{p_location}', 'if not pm.access_can_location(''projects.documents'', ''view'', p_location) then perform pm.access_forbid(''requires projects.documents:view''); end if;', '1115'),
  ('doc_ensure_job_folders', '{p_job}',      'perform pm.access_assert_job(''projects.documents'', array[''create''], p_job);', '1115'),
  ('doc_create',             '{p_job,p_location}', 'if p_job is not null then perform pm.access_assert_job(''projects.documents'', array[''create''], p_job); else perform pm.access_assert_location(''projects.documents'', array[''create''], p_location); end if;', '1115: money documents also need the money capability (in the body)'),
  ('doc_add_version',        '{p_file}',     'if not (pm.access_can_row(''projects.documents'', ''edit'', ''doc_files'', p_file) or (pm.access_can_row(''projects.documents'', ''create'', ''doc_files'', p_file) and exists (select 1 from pm.doc_files df where df.id = p_file and df.org_id = public.get_org_id() and df.created_by = pm.current_user_id()))) then perform pm.access_forbid(''requires projects.documents:edit (or your own document)''); end if;', '1115'),
  ('doc_restore_version',    '{p_version}',  'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''doc_versions'', p_version);', '1115'),
  ('doc_set_retention',      '{p_file}',     'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''doc_files'', p_file);', '1115'),
  ('doc_set_legal_hold',     '{p_file}',     'perform pm.access_assert_row(''projects.documents'', array[''delete''], ''doc_files'', p_file);', '1115: legal hold is a records decision'),
  ('doc_remove',             '{p_file}',     'perform pm.access_assert_row(''projects.documents'', array[''delete''], ''doc_files'', p_file);', '1115: soft delete'),
  ('drawing_set_create',     '{p_job}',      'perform pm.access_assert_job(''projects.documents'', array[''create''], p_job);', '1115'),
  ('drawing_add_sheet',      '{p_set}',      'perform pm.access_assert_row(''projects.documents'', array[''create''], ''drawing_sets'', p_set);', '1115'),
  ('drawing_update_revision','{p_revision}', 'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''drawing_revisions'', p_revision);', '1115'),
  ('drawing_publish_set',    '{p_set}',      'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''drawing_sets'', p_set);', '1115'),
  ('drawing_markup_publish', '{p_markup}',   'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''drawing_markups'', p_markup);', '1115'),
  ('esign_create',           '{p_file}',     'perform pm.access_assert_row(''projects.documents'', array[''create''], ''doc_files'', p_file);', '1115: money documents also need the money capability (in the body)'),
  ('esign_send',             '{p_envelope}', 'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_envelopes'', p_envelope);', '1115: + sender or documents:edit (body)'),
  ('esign_issue_token',      '{p_signer}',   'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_signers'', p_signer);', '1115: + sender or documents:edit (body)'),
  ('esign_void',             '{p_envelope}', 'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_envelopes'', p_envelope);', '1115: + sender or documents:edit (body)'),
  ('esign_finalize',         '{p_envelope}', 'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_envelopes'', p_envelope);', '1115: + sender or documents:edit (body)'),
  ('esign_finalize_failed',  '{p_envelope}', 'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_envelopes'', p_envelope);', '1115'),
  ('esign_outbox_settle',    '{p_id}',       'perform pm.access_assert_row(''projects.documents'', array[''create''], ''esign_outbox'', p_id);', '1115: + sender or documents:edit (body)')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 15. RLS (org isolation, permissive) + extra restrictive policies + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['doc_folders','doc_files','doc_versions','doc_photo_meta','drawing_sets','drawing_sheets',
                           'drawing_revisions','drawing_markups','doc_template_settings','esign_envelopes','esign_signers',
                           'esign_tokens','esign_events','esign_outbox','storage_delete_grants'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
  alter table pm.doc_folder_templates enable row level security;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'doc_folder_templates' and policyname = 'catalog_read') then
    create policy catalog_read on pm.doc_folder_templates for select using (true);
  end if;
end $$;

-- Money documents: the row (and everything hanging off it) needs the money capability on the job /
-- at the company. Markups: personal ones are the author's. (1110 re-applies only pm_access_*.)
do $$
declare
  v_money text := '(money_cap is null'
    || ' or (money_cap = ''projects.contract_value'' and ((job_id is not null and job_id in (select pm.my_money_job_ids(''projects.contract_value'')))'
    || '      or (job_id is null and location_id in (select pm.my_location_ids(''projects.contract_value'', ''view'')))))'
    || ' or (money_cap = ''projects.financials'' and ((job_id is not null and job_id in (select pm.my_money_job_ids(''projects.financials'')))'
    || '      or (job_id is null and location_id in (select pm.my_location_ids(''projects.financials'', ''view''))))))';
  t text;
begin
  drop policy if exists pm_docs_money on pm.doc_files;
  execute format('create policy pm_docs_money on pm.doc_files as restrictive for all to authenticated using %s with check %s', v_money, v_money);

  foreach t in array array['doc_versions'] loop
    execute format('drop policy if exists pm_docs_file_visible on pm.%I', t);
    execute format('create policy pm_docs_file_visible on pm.%I as restrictive for all to authenticated using (file_id in (select f.id from pm.doc_files f)) with check (file_id in (select f.id from pm.doc_files f))', t);
  end loop;
  drop policy if exists pm_docs_file_visible on pm.esign_envelopes;
  create policy pm_docs_file_visible on pm.esign_envelopes as restrictive for all to authenticated
    using (file_id in (select f.id from pm.doc_files f)) with check (file_id in (select f.id from pm.doc_files f));
  foreach t in array array['esign_signers','esign_tokens','esign_events','esign_outbox'] loop
    execute format('drop policy if exists pm_docs_envelope_visible on pm.%I', t);
    execute format('create policy pm_docs_envelope_visible on pm.%I as restrictive for all to authenticated using (envelope_id in (select e.id from pm.esign_envelopes e)) with check (envelope_id in (select e.id from pm.esign_envelopes e))', t);
  end loop;

  -- document_links of doc_files follow the file (so a contract's bytes stay hidden in public.documents too)
  drop policy if exists pm_docs_link_visible on pm.document_links;
  create policy pm_docs_link_visible on pm.document_links as restrictive for all to authenticated
    using (subject_table <> 'doc_files' or subject_id in (select f.id from pm.doc_files f))
    with check (subject_table <> 'doc_files' or subject_id in (select f.id from pm.doc_files f));

  drop policy if exists pm_markup_visibility on pm.drawing_markups;
  create policy pm_markup_visibility on pm.drawing_markups as restrictive for select to authenticated
    using (visibility = 'published' or author_user = (select pm.current_user_id()));
  drop policy if exists pm_markup_publish_insert on pm.drawing_markups;
  create policy pm_markup_publish_insert on pm.drawing_markups as restrictive for insert to authenticated
    with check (visibility = 'personal' or job_id in (select pm.my_job_ids_with('projects.documents', 'edit')));
  drop policy if exists pm_markup_publish_update on pm.drawing_markups;
  create policy pm_markup_publish_update on pm.drawing_markups as restrictive for update to authenticated
    using ((author_user = (select pm.current_user_id()) and visibility = 'personal') or job_id in (select pm.my_job_ids_with('projects.documents', 'edit')))
    with check ((author_user = (select pm.current_user_id()) and visibility = 'personal') or job_id in (select pm.my_job_ids_with('projects.documents', 'edit')));
  drop policy if exists pm_markup_publish_delete on pm.drawing_markups;
  create policy pm_markup_publish_delete on pm.drawing_markups as restrictive for delete to authenticated
    using ((author_user = (select pm.current_user_id()) and visibility = 'personal') or job_id in (select pm.my_job_ids_with('projects.documents', 'edit')));
end $$;

do $$
begin
  create or replace trigger trg_touch_updated_at before update on pm.doc_files for each row execute function pm.tg_touch_updated_at();
  create or replace trigger trg_touch_updated_at before update on pm.doc_template_settings for each row execute function pm.tg_touch_updated_at();
  create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.doc_files for each row execute function pm.tg_location_in_org();
  create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.doc_photo_meta for each row execute function pm.tg_location_in_org();
  create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.doc_template_settings for each row execute function pm.tg_location_in_org();
  create or replace trigger trg_document_in_org before insert or update of document_id, org_id on pm.doc_photo_meta for each row execute function pm.tg_document_in_org();
end $$;

revoke all on pm.doc_folder_templates, pm.doc_folders, pm.doc_files, pm.doc_versions, pm.doc_photo_meta, pm.drawing_sets,
              pm.drawing_sheets, pm.drawing_revisions, pm.drawing_markups, pm.doc_template_settings, pm.esign_envelopes,
              pm.esign_signers, pm.esign_tokens, pm.esign_events, pm.esign_outbox, pm.storage_delete_grants
         from public, anon, authenticated;
grant select, insert, update, delete on pm.doc_folder_templates, pm.doc_folders, pm.doc_files, pm.doc_versions, pm.doc_photo_meta,
              pm.drawing_sets, pm.drawing_sheets, pm.drawing_revisions, pm.drawing_markups, pm.doc_template_settings,
              pm.esign_envelopes, pm.esign_signers, pm.esign_tokens, pm.esign_events, pm.esign_outbox,
              pm.storage_delete_grants to service_role;
grant select on pm.doc_folder_templates, pm.doc_folders, pm.doc_files, pm.doc_versions, pm.doc_photo_meta, pm.drawing_sets,
              pm.drawing_sheets, pm.drawing_revisions, pm.drawing_markups, pm.doc_template_settings, pm.esign_envelopes,
              pm.esign_signers, pm.esign_events, pm.esign_outbox to authenticated;
grant insert (job_id, parent_id, name, sort) on pm.doc_folders to authenticated;
grant update (name, sort, parent_id) on pm.doc_folders to authenticated;
grant delete on pm.doc_folders to authenticated;
grant update (title, folder_id, description, tags, status) on pm.doc_files to authenticated;
grant insert (document_id, location_id, job_id, taken_at, taken_at_source, gps_lat, gps_lng, gps_alt_m, device_make, device_model,
              width_px, height_px, area, tags, share_to_portal) on pm.doc_photo_meta to authenticated;
grant update (area, tags, share_to_portal) on pm.doc_photo_meta to authenticated;
grant insert (revision_id, visibility, kind, geometry, style, body, link_table, link_id) on pm.drawing_markups to authenticated;
grant update (visibility, geometry, style, body, link_table, link_id) on pm.drawing_markups to authenticated;
grant delete on pm.drawing_markups to authenticated;
grant insert (location_id, template_key, body) on pm.doc_template_settings to authenticated;
grant update (body) on pm.doc_template_settings to authenticated;
grant delete on pm.doc_template_settings to authenticated;

-- doc_files: members may archive / un-archive (status active | archived); 'deleted' only via pm.doc_remove.
create or replace function pm.tg_doc_file_member_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.status is distinct from old.status and (new.status = 'deleted' or old.status = 'deleted') then
    raise exception 'PM_INVALID: remove or restore a document through its Remove action' using errcode = '22023';
  end if;
  if new.folder_id is distinct from old.folder_id and new.folder_id is not null
     and not exists (select 1 from pm.doc_folders f where f.id = new.folder_id and f.job_id is not distinct from new.job_id) then
    raise exception 'PM_INVALID: that folder is not on this job' using errcode = '22023';
  end if;
  if old.legal_hold and (new.title is distinct from old.title) then
    raise exception 'PM_DOC_LEGAL_HOLD: this document is on legal hold' using errcode = '22023';
  end if;
  return new;
end $$;
create or replace trigger trg_doc_file_member_guard before update on pm.doc_files
  for each row execute function pm.tg_doc_file_member_guard();

-- re-review (2026-10-25): the anon storage grant of an earlier draft is gone for good
drop function if exists esign.path_viewable(text);
drop table if exists pm.esign_view_grants;
delete from pm.access_table_classes where table_name = 'esign_view_grants';

-- ----------------------------------------------------------------------------
-- 16. Storage objects under <org>/pm/ (security review H1)
-- ----------------------------------------------------------------------------
-- Books migration 112 lets any member of an org read / write / delete every object under the org's
-- folder. For Projects files (<org>/pm/…) these RESTRICTIVE policies narrow that to the documents the
-- caller can actually see through Projects (job reach, money capability, Projects-only seat rules —
-- all through public.documents + pm.document_links RLS as the caller):
--   select  the object belongs to a document the caller sees linked to a Projects record, or is the
--           caller's own upload not filed yet (metadata row first, bytes second)
--   insert  only for the caller's own pending upload rows, under pm/{docs,drawings,esign,photos}/
--   update  never (no overwrite of a stored version)
--   delete  only a path pm.doc_discard_upload granted (an own, never-filed upload) — retention, legal
--           hold and signed locks cannot be bypassed because filed documents are never deletable
-- Every other path (Books' <org>/<entity>/…, <org>/projects/field/…, other buckets) is unaffected.
-- anon: NO storage access (the signer's document is streamed by the token-checked app route).

-- The caller's own uploads that are not filed into any Projects record yet (≤ 1 day old). Definer:
-- it must see unfiled rows irrespective of the link RLS; it only ever returns the caller's own.
create or replace function pm.storage_own_pending_paths() returns setof text
language sql stable security definer
set search_path = pm, core, public
as $$
  select d.storage_path from public.documents d
   where d.org_id = public.get_org_id()
     and d.uploaded_by_user is not null and d.uploaded_by_user = pm.current_user_id()
     and d.storage_path like d.org_id::text || '/pm/%'
     and d.created_at > now() - interval '1 day'
     and not exists (select 1 from pm.document_links l where l.document_id = d.id)
$$;

-- Paths the caller may remove right now (minted by pm.doc_discard_upload, 10 minutes).
create or replace function pm.storage_deletable_paths() returns setof text
language sql stable security definer
set search_path = pm, core, public
as $$
  select g.storage_path from pm.storage_delete_grants g
   where g.org_id = public.get_org_id() and g.user_id = pm.current_user_id() and g.expires_at > now()
$$;

-- Invoker on purpose: public.documents and pm.document_links RLS (incl. the money rule on
-- doc_files links and the Projects-only seat narrowing) decide what the caller sees.
create or replace function pm.storage_visible_paths() returns setof text
language sql stable
set search_path = pm, core, public
as $$
  select d.storage_path from public.documents d join pm.document_links l on l.document_id = d.id
  union
  select p from pm.storage_own_pending_paths() p
  union
  select p from pm.storage_deletable_paths() p        -- a granted delete must also see its row
$$;

-- Remove an upload that never became a version / sheet / signed copy (failed or abandoned upload):
-- deletes its metadata row and grants the caller 10 minutes to remove the bytes. Returns the path.
create or replace function pm.doc_discard_upload(p_document uuid) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d public.documents%rowtype;
begin
  select * into d from public.documents x where x.id = p_document and x.org_id = public.get_org_id();
  if d.id is null or d.uploaded_by_user is null or d.uploaded_by_user is distinct from pm.current_user_id() then
    raise exception 'PM_FORBIDDEN: only your own unfiled upload can be discarded' using errcode = '42501';
  end if;
  if d.storage_path not like d.org_id::text || '/pm/%' then
    raise exception 'PM_INVALID: that file is not a Projects upload' using errcode = '22023';
  end if;
  if exists (select 1 from pm.document_links l where l.document_id = d.id)
     or exists (select 1 from pm.doc_versions v where v.document_id = d.id)
     or exists (select 1 from pm.drawing_revisions r where r.document_id = d.id)
     or exists (select 1 from pm.esign_envelopes e where e.signed_document_id = d.id) then
    raise exception 'PM_DOC_FILE_IN_USE: filed documents are removed with Remove and kept for the record' using errcode = '22023';
  end if;
  delete from pm.storage_delete_grants g where g.expires_at < now();
  delete from public.documents x where x.id = d.id;
  insert into pm.storage_delete_grants (org_id, user_id, storage_path, expires_at)
  values (d.org_id, pm.current_user_id(), d.storage_path, now() + interval '10 minutes');
  return d.storage_path;
end $$;

insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('storage_own_pending_paths', '1115: the caller''s own unfiled uploads (storage policy building block)'),
  ('storage_deletable_paths',   '1115: the caller''s own delete grants (storage policy building block)'),
  ('doc_discard_upload',        '1115: self-checking — only the caller''s own upload that was never filed')
on conflict (function_name) do update set reason = excluded.reason;

do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  drop policy if exists pm_docs_obj_select on storage.objects;
  drop policy if exists pm_docs_obj_insert on storage.objects;
  drop policy if exists pm_docs_obj_update on storage.objects;
  drop policy if exists pm_docs_obj_delete on storage.objects;
  drop policy if exists esign_view_grant on storage.objects;
  create policy pm_docs_obj_select on storage.objects as restrictive for select to authenticated
    using (bucket_id is distinct from 'documents' or (storage.foldername(name))[2] is distinct from 'pm'
           or name in (select pm.storage_visible_paths()));
  create policy pm_docs_obj_insert on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'documents' or (storage.foldername(name))[2] is distinct from 'pm'
                or ((storage.foldername(name))[3] in ('docs', 'drawings', 'esign', 'photos')
                    and name in (select pm.storage_own_pending_paths())));
  create policy pm_docs_obj_update on storage.objects as restrictive for update to authenticated
    using (bucket_id is distinct from 'documents' or (storage.foldername(name))[2] is distinct from 'pm')
    with check (bucket_id is distinct from 'documents' or (storage.foldername(name))[2] is distinct from 'pm');
  create policy pm_docs_obj_delete on storage.objects as restrictive for delete to authenticated
    using (bucket_id is distinct from 'documents' or (storage.foldername(name))[2] is distinct from 'pm'
           or name in (select pm.storage_deletable_paths()));
end $$;

-- Policies (every classified table), masks, RPC guards (injected into the 1115 RPC bodies).
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon in pm; members get the RPC surface and the immutable helpers.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              'doc_kind_money_cap','doc_kind_retention','doc_retention_years','esign_consent_text','esign_consent_version',
              '_doc_brand','_doc_can_read','_esign_can_manage','_doc_assert_subject',
              'storage_own_pending_paths','storage_deletable_paths','storage_visible_paths','doc_discard_upload','_esign_event','_doc_insert_version','_doc_assert_changeable',
              '_drawing_norm_number','_drawing_recompute','tg_drawing_markup','tg_doc_file_member_guard',
              'doc_brand','doc_ensure_job_folders','doc_create','doc_add_version','doc_restore_version','doc_set_retention',
              'doc_set_legal_hold','doc_remove','drawing_set_create','drawing_add_sheet','drawing_update_revision',
              'drawing_publish_set','drawing_markup_publish','esign_create','esign_send','esign_issue_token','esign_void',
              'esign_finalize','esign_finalize_failed','esign_outbox_settle') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('doc_kind_money_cap','doc_kind_retention','doc_retention_years','esign_consent_text','esign_consent_version',
                     'doc_brand','doc_ensure_job_folders','doc_create','doc_add_version','doc_restore_version','doc_set_retention',
                     'doc_set_legal_hold','doc_remove','drawing_set_create','drawing_add_sheet','drawing_update_revision',
                     'drawing_publish_set','drawing_markup_publish','esign_create','esign_send','esign_issue_token','esign_void',
                     'esign_finalize','esign_finalize_failed','esign_outbox_settle',
                     'storage_own_pending_paths','storage_deletable_paths','storage_visible_paths','doc_discard_upload') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1115_pm_documents_esign
-- ============================================================================
