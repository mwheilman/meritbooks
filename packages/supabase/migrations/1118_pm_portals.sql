-- ============================================================================
-- 1118 · Merit Projects — portals: customer / homeowner, sub / vendor, lender / investor
--
-- Spec: panel 06 §2.6 / §2.7 / §2f (BP-86…113), panel 02 RES-56 / 87–92, panel 01 CGC-107 / 109,
-- panel 05 RED-28 / 37 / 39 / 41 (docs/projects/WAVE-B-BRIEF.md).
--
-- IDENTITY (no password, no Clerk account)
--   pm.portal_people     ONE person across every tenant (email and / or E.164 phone, both unique).
--                        "One login across all companies using Merit" = one person row; what they
--                        see in each company is decided by that company's grants.
--   pm.portal_grants     per person × company × audience (customer | vendor | lender | investor) ×
--                        party (core.customers / core.vendors row), role approver | viewer,
--                        can_sign / can_pay (the household "who can sign / who can pay"), expiry,
--                        revocation. Reuses the Books 141 / 142 token model — opaque secret only in
--                        the link, status, expiry, revocation, last use — but per PERSON and scoped
--                        to jobs, and the database keeps only SHA-256 hashes.
--   pm.portal_grant_jobs the jobs a grant reaches (all_jobs = every job of that party at the company).
--   pm.portal_links      magic links + 6-digit codes (sign-in) and phone codes (step-up). Every
--                        secret is bound to the browser that asked for it (nonce cookie hash), so a
--                        staff member who can read the outbound queue cannot redeem a customer's link.
--   pm.portal_sessions   portal sessions (hash only), 30 days, auth method, phone verified at.
--   pm.portal_server_keys  fail-closed server key: only the app route (PORTAL_SERVER_KEY) may mint
--                        links or codes — a direct anon PostgREST caller cannot.
--
-- MESSAGES ARE HELD UNTIL GO-LIVE: every outbound portal message (invites, sign-in links / codes,
--   phone codes, replies) goes through core.notify_customer (1114): held until the company flips
--   customer_messages_live, suppressed without text consent / after STOP. Sign-in links are never
--   minted for a company that is not live (nothing secret ever waits in a held queue); invites carry
--   no secret at all ("sign in with this email at …/portal").
--
-- PORTAL SURFACE (schema portal — like esign: SECURITY DEFINER, search_path pinned, anon-executable,
--   session-token scoped; nothing in pm is executable by anon). Every read starts from the session →
--   person → that company's active, unexpired, unrevoked grants → the granted jobs, and returns only
--   whitelisted columns: never cost, margin, budget, internal notes, other parties or other tenants.
--
-- WRITES the portal makes (each also written to pm.portal_actions, the portal audit trail, and raised
--   to the job team as the in-app event portal.activity):
--   customer  approve / decline estimates, change orders, draws (pm.client_approvals method PORTAL —
--             staff finalize the money step), approve / decline selections (pinned exactly like
--             pm.approve_selection), messages (also crm.activities portal_message — the 360),
--             warranty / service requests with photos, e-sign links for their own envelopes.
--   vendor    confirm / decline / propose a date on assignments, accept a PO / subcontract (or sign
--             its envelope), compliance uploads → public.vendor_document_submissions (Books 180
--             review queue; W-9 / COI) or pm.compliance_docs (lien waivers), pay applications
--             against their commitment's lines (retainage computed here), punch ready-for-review.
--   lender    approve / return a draw (per-line amounts kept in the approval snapshot).
--   Files: portal.upload_begin mints a one-time storage slot (<org>/pm/{photos,docs}/portal-…);
--   portal.file_grant mints a 2-minute read of exactly one object the person may see. The anon storage
--   policies below allow exactly those paths and nothing else.
--
-- STAFF RPCs (pm, guarded through the 1110 registry): portal_invite, portal_update_grant,
--   portal_revoke, portal_share_document, portal_set_client_visible, portal_post_message,
--   portal_update_request, portal_decide_pay_app, portal_resolve_response.
-- New columns: pm.tasks.client_visible, pm.field_logs.client_visible, pm.doc_files.portal_audiences.
--
-- APPLY RULE: after 1110–1117. Idempotent; PGlite-safe. No GL effect. POSTGREST: the lead exposes the
-- `portal` schema in pgrst.db_schemas (like `esign`), then `notify pgrst, 'reload config'`.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then raise exception '1118_pm_portals requires 1110_pm_access'; end if;
  if to_regclass('core.contacts') is null then raise exception '1118_pm_portals requires 1111_shared_records'; end if;
  if to_regclass('core.outbound_messages') is null then raise exception '1118_pm_portals requires 1114_notifications'; end if;
  if to_regclass('pm.esign_tokens') is null then raise exception '1118_pm_portals requires 1115_pm_documents_esign'; end if;
  if to_regclass('public.vendor_document_submissions') is null then raise exception '1118_pm_portals requires 180_vendor_requirements_review'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Identity, grants, links, sessions
-- ----------------------------------------------------------------------------
create table if not exists pm.portal_people (
  id                 uuid primary key default gen_random_uuid(),
  email              text check (email is null or (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254)),
  phone              text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  display_name       text check (display_name is null or char_length(display_name) <= 200),
  locale             text not null default 'en' check (locale in ('en','es')),
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create unique index if not exists pm_portal_people_email_uidx on pm.portal_people (email) where email is not null;
create unique index if not exists pm_portal_people_phone_uidx on pm.portal_people (phone) where phone is not null;
comment on table pm.portal_people is
  '1118: one portal person across every tenant (no password, no Clerk account). No member grants; read and written only by portal.* and pm.portal_* definer functions.';

create table if not exists pm.portal_grants (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id) on delete cascade,
  person_id      uuid not null references pm.portal_people(id) on delete cascade,
  contact_id     uuid references core.contacts(id) on delete set null,
  audience       text not null check (audience in ('customer','vendor','lender','investor')),
  customer_id    uuid references core.customers(id) on delete cascade,
  vendor_id      uuid references core.vendors(id) on delete cascade,
  display_name   text not null check (char_length(btrim(display_name)) between 1 and 200),
  email          text,
  phone          text,
  role           text not null default 'viewer' check (role in ('approver','viewer')),
  can_sign       boolean not null default false,
  can_pay        boolean not null default false,
  all_jobs       boolean not null default false,
  status         text not null default 'active' check (status in ('active','revoked')),
  expires_at     timestamptz,
  invited_by     text,
  invited_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  last_seen_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     text,
  revoke_reason  text check (revoke_reason is null or char_length(revoke_reason) <= 500),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  check (status <> 'revoked' or revoked_at is not null),
  check (audience <> 'customer' or customer_id is not null),
  check (audience <> 'vendor' or vendor_id is not null),
  check (audience not in ('lender','investor') or customer_id is not null),   -- security review: no party-less lender / investor access
  check (audience in ('vendor') or vendor_id is null),
  check (audience not in ('vendor') or customer_id is null),
  check (can_sign = false or role = 'approver')
);
create unique index if not exists pm_portal_grants_party_uidx on pm.portal_grants
  (person_id, org_id, location_id, audience, coalesce(customer_id, vendor_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'active';
create index if not exists pm_portal_grants_person_idx on pm.portal_grants (person_id, org_id) where status = 'active';
create index if not exists pm_portal_grants_loc_idx on pm.portal_grants (org_id, location_id, audience, status);
create index if not exists pm_portal_grants_customer_idx on pm.portal_grants (org_id, customer_id) where customer_id is not null;
create index if not exists pm_portal_grants_vendor_idx on pm.portal_grants (org_id, vendor_id) where vendor_id is not null;
comment on table pm.portal_grants is
  '1118: what one portal person may see at one company, as one party (customer / vendor / lender / investor). Written only by pm.portal_invite / portal_update_grant / portal_revoke.';

create table if not exists pm.portal_grant_jobs (
  org_id    uuid not null references core.organizations(id) on delete cascade,
  grant_id  uuid not null,
  job_id    uuid not null,
  added_at  timestamptz not null default now(),
  primary key (grant_id, job_id),
  foreign key (org_id, grant_id) references pm.portal_grants (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_grant_jobs_job_idx on pm.portal_grant_jobs (org_id, job_id);

create table if not exists pm.portal_links (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references pm.portal_people(id) on delete cascade,
  purpose      text not null check (purpose in ('sign_in','phone_verify')),
  channel      text not null check (channel in ('email','sms')),
  org_id       uuid references core.organizations(id) on delete cascade,
  session_id   uuid,
  token_hash   text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  identifier   text not null check (identifier ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or identifier ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash    text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash   text check (nonce_hash is null or nonce_hash ~ '^[0-9a-f]{64}$'),
  attempts     int not null default 0 check (attempts between 0 and 20),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (purpose <> 'sign_in' or (token_hash is not null and nonce_hash is not null)),
  check (purpose <> 'phone_verify' or session_id is not null)
);
create index if not exists pm_portal_links_person_idx on pm.portal_links (person_id, purpose, created_at desc);
create index if not exists pm_portal_links_identifier_idx on pm.portal_links (identifier, purpose, created_at desc);
comment on table pm.portal_links is '1118: sign-in links / codes and phone codes (sha-256 only; bound to the requesting browser or session). No member grants.';

create table if not exists pm.portal_sessions (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references pm.portal_people(id) on delete cascade,
  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  auth_method        text not null check (auth_method in ('email','sms')),
  org_id             uuid references core.organizations(id) on delete cascade,  -- the ONE company that issued the code
  verified_email     text,                -- the address this session proved control of (sign-in link / code)
  verified_phone     text,                -- the number it proved (SMS sign-in or the phone step-up)
  phone_verified_at  timestamptz,
  ip                 text check (ip is null or char_length(ip) <= 64),
  user_agent         text check (user_agent is null or char_length(user_agent) <= 500),
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index if not exists pm_portal_sessions_person_idx on pm.portal_sessions (person_id, created_at desc);
comment on table pm.portal_sessions is
  '1118: portal sessions (sha-256 of the cookie value only). A session reaches ONLY the grants whose recorded email / phone it proved control of (verified_email / verified_phone) — never a contact point another company attached to the same person. No member grants.';

create table if not exists pm.portal_server_keys (
  key_hash    text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  note        text,
  created_at  timestamptz not null default now()
);
comment on table pm.portal_server_keys is '1118: sha-256 of PORTAL_SERVER_KEY. Registered by the lead (service role). No key → the portal answers "not set up yet".';

create table if not exists pm.portal_rate_counters (
  bucket        text not null check (char_length(bucket) between 3 and 200),
  window_start  timestamptz not null,
  expires_at    timestamptz not null,
  hits          int not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
create index if not exists pm_portal_rate_counters_exp_idx on pm.portal_rate_counters (expires_at);

create table if not exists pm.portal_security_events (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  identifier_hash  text check (identifier_hash is null or identifier_hash ~ '^[0-9a-f]{64}$'),
  org_id           uuid references core.organizations(id) on delete cascade,
  detail           jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  at               timestamptz not null default now()
);
create index if not exists pm_portal_security_events_at_idx on pm.portal_security_events (kind, at desc);
comment on table pm.portal_security_events is
  '1118 (security review): platform alert hook — e.g. one contact point holding live portal sessions at more than one company. Service role only (never shown to a tenant: it would reveal another tenant).';

-- ----------------------------------------------------------------------------
-- 2. Portal records
-- ----------------------------------------------------------------------------
create table if not exists pm.portal_messages (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  audience      text not null check (audience in ('customer','vendor','lender','investor')),
  party_id      uuid,                                -- customer / vendor id of the thread (null = lender / investor thread)
  grant_id      uuid references pm.portal_grants(id) on delete set null,
  author_kind   text not null check (author_kind in ('portal','staff')),
  author_user   text,
  author_name   text not null check (char_length(btrim(author_name)) between 1 and 200),
  body          text not null check (char_length(btrim(body)) between 1 and 4000),
  document_ids  uuid[] not null default '{}' check (cardinality(document_ids) <= 10),
  staff_read_at timestamptz,
  created_at    timestamptz not null default now(),
  check (author_kind <> 'portal' or grant_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_messages_thread_idx on pm.portal_messages (org_id, job_id, audience, party_id, created_at);

create table if not exists pm.portal_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  job_id           uuid,
  grant_id         uuid references pm.portal_grants(id) on delete set null,
  customer_id      uuid references core.customers(id),
  kind             text not null check (kind in ('warranty','service')),
  title            text not null check (char_length(btrim(title)) between 2 and 200),
  description      text check (description is null or char_length(description) <= 4000),
  preferred_window text check (preferred_window is null or char_length(preferred_window) <= 200),
  document_ids     uuid[] not null default '{}' check (cardinality(document_ids) <= 10),
  status           text not null default 'new' check (status in ('new','acknowledged','scheduled','closed','converted')),
  punch_item_id    uuid,
  staff_note       text check (staff_note is null or char_length(staff_note) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_requests_org_idx on pm.portal_requests (org_id, location_id, status, created_at desc);

create table if not exists pm.portal_task_responses (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  task_id          uuid not null,
  grant_id         uuid references pm.portal_grants(id) on delete set null,
  vendor_id        uuid references core.vendors(id),
  response         text not null check (response in ('confirmed','declined','proposed')),
  proposed_start   date check (proposed_start is null or proposed_start between '2000-01-01' and '2200-12-31'),
  note             text check (note is null or char_length(note) <= 2000),
  resolution       text check (resolution is null or resolution in ('accepted','rejected','noted')),
  resolved_by      text,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  check (response <> 'proposed' or proposed_start is not null),
  check ((resolution is null) = (resolved_at is null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_task_responses_task_idx on pm.portal_task_responses (org_id, task_id, created_at desc);

create table if not exists pm.portal_pay_apps (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  commitment_id       uuid not null,
  vendor_id           uuid not null references core.vendors(id),
  grant_id            uuid references pm.portal_grants(id) on delete set null,
  application_no      int not null check (application_no >= 1),
  vendor_invoice_no   text check (vendor_invoice_no is null or char_length(vendor_invoice_no) <= 60),
  period_end          date not null check (period_end between '2000-01-01' and '2200-12-31'),
  gross_cents         bigint not null check (gross_cents > 0),
  retainage_cents     bigint not null default 0 check (retainage_cents >= 0),
  net_cents           bigint not null,
  document_id         uuid references public.documents(id) on delete set null,
  note                text check (note is null or char_length(note) <= 2000),
  status              text not null default 'submitted' check (status in ('submitted','approved','rejected','withdrawn')),
  submitted_at        timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          text,
  decision_note       text check (decision_note is null or char_length(decision_note) <= 2000),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (commitment_id, application_no),
  check (net_cents = gross_cents - retainage_cents),
  check ((status in ('approved','rejected')) = (decided_at is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_pay_apps_commitment_idx on pm.portal_pay_apps (org_id, commitment_id, application_no);

create table if not exists pm.portal_pay_app_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  pay_app_id          uuid not null,
  commitment_line_id  uuid not null,
  pct_complete        numeric(7,4) not null check (pct_complete >= 0 and pct_complete <= 1),
  this_period_cents   bigint not null check (this_period_cents >= 0),
  retainage_cents     bigint not null default 0 check (retainage_cents >= 0),
  unique (pay_app_id, commitment_line_id),
  foreign key (org_id, pay_app_id) references pm.portal_pay_apps (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.portal_uploads (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  person_id     uuid not null references pm.portal_people(id) on delete cascade,
  session_id    uuid not null,
  grant_id      uuid not null references pm.portal_grants(id) on delete cascade,
  purpose       text not null check (purpose in ('photo','compliance','pay_app','message','request')),
  storage_path  text not null unique,
  file_name     text not null check (char_length(file_name) between 1 and 200),
  mime_type     text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp','image/heic')),
  size_bytes    bigint not null check (size_bytes between 1 and 26214400),
  expires_at    timestamptz not null,
  document_id   uuid references public.documents(id) on delete set null,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists pm_portal_uploads_session_idx on pm.portal_uploads (session_id, created_at desc);

create table if not exists pm.portal_file_grants (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null,
  storage_path  text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists pm_portal_file_grants_path_idx on pm.portal_file_grants (storage_path, expires_at);

create table if not exists pm.portal_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid references core.locations(id),
  job_id         uuid,
  grant_id       uuid references pm.portal_grants(id) on delete set null,
  person_id      uuid references pm.portal_people(id) on delete set null,
  actor_name     text,
  action         text not null check (action ~ '^[a-z][a-z0-9_.]{1,63}$'),
  subject_table  text check (subject_table is null or subject_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  subject_id     uuid,
  detail         jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  verified_by    text check (verified_by is null or verified_by in ('email','sms','phone_code')),
  ip             text check (ip is null or char_length(ip) <= 64),
  user_agent     text check (user_agent is null or char_length(user_agent) <= 500),
  at             timestamptz not null default clock_timestamp(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_portal_actions_subject_idx on pm.portal_actions (org_id, subject_table, subject_id, at desc);
create index if not exists pm_portal_actions_job_idx on pm.portal_actions (org_id, job_id, at desc);
comment on table pm.portal_actions is '1118: append-only trail of everything a portal person did (who, what, when, how verified, IP, browser).';

-- ----------------------------------------------------------------------------
-- 3. Visibility columns on existing records (staff choose what the portal shows)
-- ----------------------------------------------------------------------------
alter table pm.tasks add column if not exists client_visible boolean not null default false;
alter table pm.field_logs add column if not exists client_visible boolean not null default false;
alter table pm.doc_files add column if not exists portal_audiences text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'pm.doc_files'::regclass and conname = 'doc_files_portal_audiences_check') then
    alter table pm.doc_files add constraint doc_files_portal_audiences_check
      check (portal_audiences <@ array['customer','vendor','lender','investor']::text[]);
  end if;
end $$;
comment on column pm.tasks.client_visible is '1118: shown on the customer portal schedule (milestones and client-facing tasks only).';
comment on column pm.field_logs.client_visible is '1118: shown on the customer portal (the PM marks the entries a client may read).';
comment on column pm.doc_files.portal_audiences is '1118: portal audiences this document is shared with (pm.portal_share_document).';

-- ----------------------------------------------------------------------------
-- 4. Notification catalog: the customer-facing portal message and the internal portal event
-- ----------------------------------------------------------------------------
insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
  ('customer.portal_access', 'Portal access',        'Portal invitations, sign-in links and codes, and portal message alerts.', 'customer', 'customer', null, false, 0, 'info', false, 260),
  ('portal.activity',        'Portal activity',      'A customer, sub, lender or investor acted in the portal (approved, declined, messaged, uploaded, proposed a date).', 'work', 'internal', null, true, 30, 'attention', false, 130)
on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
  audience = excluded.audience, money_cap = excluded.money_cap, mandatory = excluded.mandatory,
  batch_window_minutes = excluded.batch_window_minutes, severity = excluded.severity, emit_rpc = excluded.emit_rpc, sort = excluded.sort;

-- ----------------------------------------------------------------------------
-- 5. Internal helpers (owner-only)
-- ----------------------------------------------------------------------------
create schema if not exists portal;
comment on schema portal is
  '1118: public portal RPCs (session-token scoped, SECURITY DEFINER). With esign, the only functions anon may execute for Projects.';

create or replace function portal._h(p text) returns text
language sql immutable
set search_path = pm, public
as $$ select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;

create or replace function portal._norm_email(p text) returns text
language sql immutable
set search_path = pm, public
as $$ select case when lower(btrim(p)) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(btrim(p)) <= 254 then lower(btrim(p)) end $$;

create or replace function portal._server_ok(p_key text) returns boolean
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if p_key is not null and length(p_key) between 16 and 200
     and exists (select 1 from pm.portal_server_keys k where k.key_hash = portal._h(p_key)) then
    return true;
  end if;
  if not exists (select 1 from pm.portal_server_keys) then
    raise exception 'PORTAL_NOT_SET_UP: the portal isn''t set up yet' using errcode = '55000';
  end if;
  raise exception 'PORTAL_KEY: sign in through the portal page' using errcode = '42501';
end $$;

-- Fixed-window counter (atomic; a bucket at its limit is refused without a write).
create or replace function portal._hit(p_bucket text, p_unit text, p_limit int) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_start timestamptz := date_trunc(case when p_unit = 'day' then 'day' else 'hour' end, now()); v int;
begin
  delete from pm.portal_rate_counters c where c.expires_at <= now() and c.bucket = p_bucket;
  update pm.portal_rate_counters c set hits = c.hits + 1 where c.bucket = p_bucket and c.window_start = v_start and c.hits < p_limit
  returning c.hits into v;
  if found then return true; end if;
  insert into pm.portal_rate_counters as c (bucket, window_start, expires_at, hits)
  values (p_bucket, v_start, v_start + case when p_unit = 'day' then interval '1 day' else interval '1 hour' end, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < p_limit
  returning c.hits into v;
  return found;
end $$;

-- Active, unexpired grants of a person at one org.
-- Authorization is proof of the contact point each company recorded: a session reaches a grant only
-- when it verified that grant's own email or phone (one company can never attach a phone to someone
-- and reach what another company shared with them).
create or replace function portal._grants(s pm.portal_sessions, p_org uuid) returns setof pm.portal_grants
language sql stable security definer
set search_path = pm, core, public
as $$
  select g.* from pm.portal_grants g
   where g.org_id = p_org and g.status = 'active' and g.revoked_at is null
     and (g.expires_at is null or g.expires_at > now())
     and g.org_id = s.org_id
     and ((s.verified_email is not null and g.email = s.verified_email)
       or (s.verified_phone is not null and g.phone = s.verified_phone))
$$;

-- The jobs one grant reaches (always inside the grant's own company).
create or replace function portal._grant_jobs(p_grant uuid) returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  with g as (select * from pm.portal_grants x where x.id = p_grant)
  select j.id from core.jobs j join g on j.org_id = g.org_id and j.location_id = g.location_id
   where j.id in (select gj.job_id from pm.portal_grant_jobs gj where gj.grant_id = g.id)
      or (g.all_jobs and (
            (g.audience in ('customer','investor') and g.customer_id is not null and j.customer_id = g.customer_id)
         or (g.audience = 'lender' and g.customer_id is not null
             and exists (select 1 from pm.draw_schedules ds where ds.org_id = g.org_id and ds.job_id = j.id and ds.lender_customer_id = g.customer_id))
         or (g.audience = 'vendor' and (
                exists (select 1 from pm.commitments c where c.org_id = g.org_id and c.job_id = j.id and c.vendor_id = g.vendor_id and c.status <> 'DRAFT')
             or exists (select 1 from pm.tasks t where t.org_id = g.org_id and t.job_id = j.id and t.assigned_vendor_id = g.vendor_id)
             or exists (select 1 from pm.punch_items p where p.org_id = g.org_id and p.job_id = j.id and p.responsible_vendor_id = g.vendor_id)
             or exists (select 1 from pm.compliance_docs cd where cd.org_id = g.org_id and cd.job_id = j.id and cd.vendor_id = g.vendor_id)))))
$$;

-- Session → person (raises PORTAL_AUTH). Touches last_seen at most once a minute.
create or replace function portal._session(p_session text) returns pm.portal_sessions
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; p pm.portal_people;
begin
  if p_session is null or char_length(p_session) not between 20 and 200 or p_session !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'PORTAL_AUTH: sign in again' using errcode = '28000';
  end if;
  select * into s from pm.portal_sessions x where x.token_hash = portal._h(p_session);
  if s.id is null or s.revoked_at is not null or s.expires_at <= now() then
    raise exception 'PORTAL_AUTH: sign in again' using errcode = '28000';
  end if;
  select * into p from pm.portal_people x where x.id = s.person_id;
  if p.id is null or p.disabled_at is not null then raise exception 'PORTAL_AUTH: sign in again' using errcode = '28000'; end if;
  if s.last_seen_at < now() - interval '1 minute' then
    update pm.portal_sessions set last_seen_at = now() where id = s.id;
  end if;
  return s;
end $$;

-- The grant (of a set of audiences) through which this person reaches the job; null when none.
create or replace function portal._job_grant(s pm.portal_sessions, p_org uuid, p_job uuid, p_audiences text[]) returns pm.portal_grants
language sql stable security definer
set search_path = pm, core, public
as $$
  select g.* from portal._grants(s, p_org) g
   where g.audience = any (p_audiences) and p_job in (select portal._grant_jobs(g.id))
   order by (g.role = 'approver') desc, g.created_at
   limit 1
$$;

-- How the session is verified for acting through grant g (null = not enough): the grant's phone
-- when the company recorded one (SMS sign-in or the phone step-up), else its email.
create or replace function portal._verified(s pm.portal_sessions, g pm.portal_grants) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select case when g.phone is not null and s.verified_phone = g.phone then case when s.auth_method = 'sms' then 'sms' else 'phone_code' end
              when g.phone is null and s.verified_email is not null and g.email = s.verified_email then 'email'
         end
$$;

create or replace function portal._verified_any(s pm.portal_sessions) returns text
language sql stable security definer
set search_path = pm, core, public
as $$ select case when s.verified_phone is not null then case when s.auth_method = 'sms' then 'sms' else 'phone_code' end end $$;

create or replace function portal._log(p_org uuid, p_location uuid, p_job uuid, g pm.portal_grants, p_action text,
                                       p_table text, p_id uuid, p_detail jsonb, p_verified text, p_ip text, p_ua text) returns uuid
language sql volatile security definer
set search_path = pm, core, public
as $$
  insert into pm.portal_actions (org_id, location_id, job_id, grant_id, person_id, actor_name, action, subject_table, subject_id,
                                 detail, verified_by, ip, user_agent)
  values (p_org, coalesce(p_location, (select j.location_id from core.jobs j where j.id = p_job)), p_job, g.id, g.person_id, g.display_name,
          p_action, p_table, p_id, coalesce(p_detail, '{}'::jsonb) - array(select k from jsonb_object_keys(coalesce(p_detail, '{}'::jsonb)) k where k like '%cents%'),
          p_verified, left(p_ip, 64), left(p_ua, 500))
  returning id
$$;

-- In-app note to the job team (job members + the job's PM / super). Never fails the caller.
create or replace function portal._notify_team(p_org uuid, p_job uuid, p_title text, p_link text, p_dedupe text) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_recipients uuid[];
begin
  select coalesce(array_agg(distinct m), '{}') into v_recipients from (
    select jm.membership_id as m from pm.job_members jm where jm.org_id = p_org and jm.job_id = p_job
    union
    select ms.id from pm.projects pr
      join core.users u on u.clerk_user_id in (pr.pm_user_id, pr.super_user_id)
      join core.memberships ms on ms.user_id = u.id and ms.org_id = p_org and ms.status = 'active'
     where pr.org_id = p_org and pr.job_id = p_job) x;
  if cardinality(v_recipients) = 0 then return; end if;
  perform core.notify_fanout(p_org, 'portal.activity', null, p_job, 'portal_action', null, null, v_recipients,
                             left(p_title, 200), null, null, null, p_link, left(p_dedupe, 200));
exception when others then
  raise warning '[portal] team notification skipped: %', sqlerrm;
end $$;

-- A customer-facing message through the one notifications service (held until go-live).
create or replace function portal._send(p_org uuid, p_location uuid, p_job uuid, p_contact uuid, p_channel text,
                                        p_subject text, p_body text, p_dedupe text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_id uuid; o record;
begin
  if p_contact is null then return jsonb_build_object('status', 'skipped', 'reason', 'No contact on file'); end if;
  v_id := core.notify_customer(p_org, p_location, p_job, 'customer.portal_access', p_channel, p_contact, p_subject, p_body, null, p_dedupe, 'portal');
  select m.status, m.status_reason into o from core.outbound_messages m where m.id = v_id;
  return jsonb_build_object('status', o.status, 'reason', o.status_reason);
exception when others then
  return jsonb_build_object('status', 'skipped', 'reason', left(sqlerrm, 200));
end $$;

create or replace function portal._live(p_org uuid, p_location uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$ select coalesce((core.notify_settings_row(p_org, p_location)).customer_messages_live, false) $$;

create or replace function portal._base(p_url text) returns text
language sql immutable
set search_path = pm, public
as $$
  select case when p_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' or p_url ~ '^http://localhost(:[0-9]+)?(/.*)?$'
              then regexp_replace(p_url, '/+$', '') end
$$;

-- Party name for a grant.
create or replace function portal._party_name(g pm.portal_grants) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select coalesce(c.display_name, c.name) from core.customers c where c.id = g.customer_id),
                  (select coalesce(v.display_name, v.name) from core.vendors v where v.id = g.vendor_id),
                  g.display_name)
$$;

-- ----------------------------------------------------------------------------
-- 6. Staff RPCs (pm; guards in section 11)
-- ----------------------------------------------------------------------------
-- p_attrs: {all_jobs, role, can_sign, can_pay, expires_at, locale, portal_url, send (default true)}
create or replace function pm.portal_invite(p_location uuid, p_audience text, p_contact uuid, p_jobs uuid[] default '{}', p_attrs jsonb default '{}')
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  a jsonb := coalesce(p_attrs, '{}'::jsonb); v_org uuid := public.get_org_id(); c record; v_cap text; v_email text; v_phone text;
  v_person uuid; v_grant uuid; v_party_customer uuid; v_party_vendor uuid; v_job uuid; v_role text; v_sign boolean; v_pay boolean;
  v_exp timestamptz; v_base text; v_msg jsonb := null; v_company text; v_name text; v_first_job uuid; v_locale text; v_body text;
begin
  if p_audience not in ('customer','vendor','lender','investor') then raise exception 'PM_INVALID: unknown portal audience' using errcode = '22023'; end if;
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: company not found' using errcode = '42501';
  end if;
  v_cap := case p_audience when 'customer' then 'projects.customers' when 'vendor' then 'projects.commitments' else 'projects.billing' end;
  if not pm.access_is_service() and not pm.can(v_cap, 'edit', p_location) then
    raise exception 'PM_FORBIDDEN: inviting a % needs %:edit at this company', p_audience, v_cap using errcode = '42501';
  end if;
  select ct.* into c from core.contacts ct where ct.id = p_contact and ct.org_id = v_org and ct.identity_status = 'active';
  if c.id is null then raise exception 'PM_INVALID: contact not found' using errcode = '22023'; end if;
  if p_audience = 'customer' and c.customer_id is null then raise exception 'PM_INVALID: a customer portal needs a customer contact' using errcode = '22023'; end if;
  if p_audience = 'vendor' and c.vendor_id is null then raise exception 'PM_INVALID: a sub / vendor portal needs a vendor contact' using errcode = '22023'; end if;
  if p_audience in ('lender','investor') and c.customer_id is null then
    raise exception 'PM_INVALID: a % portal needs a contact on the %''s customer record (the party whose draws they see)', p_audience, p_audience using errcode = '22023';
  end if;
  v_party_customer := case when p_audience <> 'vendor' then c.customer_id end;
  v_party_vendor := case when p_audience = 'vendor' then c.vendor_id end;
  v_email := portal._norm_email(c.email);
  v_phone := core.notify_e164(c.phone);
  if v_email is null and v_phone is null then raise exception 'PM_INVALID: the contact needs an email address or a mobile number' using errcode = '22023'; end if;
  if coalesce(cardinality(p_jobs), 0) > 200 then raise exception 'PM_INVALID: at most 200 jobs per invitation' using errcode = '22023'; end if;
  if coalesce(cardinality(p_jobs), 0) = 0 and not coalesce((a ->> 'all_jobs')::boolean, false) then
    raise exception 'PM_INVALID: choose the jobs to share (or all of this party''s jobs)' using errcode = '22023';
  end if;
  foreach v_job in array coalesce(p_jobs, '{}'::uuid[]) loop
    if not exists (select 1 from core.jobs j where j.id = v_job and j.org_id = v_org and j.location_id = p_location) then
      raise exception 'PM_INVALID: job % is not at this company', v_job using errcode = '22023';
    end if;
    if not pm.access_is_service() and not pm.access_can_job('projects.jobs', 'view', v_job) then
      raise exception 'PM_FORBIDDEN: you cannot reach job %', v_job using errcode = '42501';
    end if;
    -- never another customer's job (a job with no customer yet is the staff member's call)
    if p_audience = 'customer' and v_party_customer is not null
       and exists (select 1 from core.jobs j where j.id = v_job and j.customer_id is not null and j.customer_id <> v_party_customer) then
      raise exception 'PM_INVALID: job % belongs to another customer', v_job using errcode = '22023';
    end if;
    v_first_job := coalesce(v_first_job, v_job);
  end loop;
  v_role := coalesce(nullif(a ->> 'role', ''), case when p_audience = 'investor' then 'viewer' else 'approver' end);
  if v_role not in ('approver','viewer') then raise exception 'PM_INVALID: role is approver or viewer' using errcode = '22023'; end if;
  if p_audience = 'investor' and v_role = 'approver' then raise exception 'PM_INVALID: investors are read-only' using errcode = '22023'; end if;
  v_sign := v_role = 'approver' and coalesce((a ->> 'can_sign')::boolean, c.can_sign or p_audience <> 'customer');
  v_pay := p_audience = 'customer' and coalesce((a ->> 'can_pay')::boolean, c.can_pay or c.is_primary);
  v_exp := nullif(a ->> 'expires_at', '')::timestamptz;
  if v_exp is not null and v_exp <= now() then raise exception 'PM_INVALID: the expiry is in the past' using errcode = '22023'; end if;
  v_locale := case when a ->> 'locale' = 'es' then 'es' else 'en' end;
  v_name := coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), v_email, v_phone);

  -- the one person (email first, then phone); a phone already used by someone else is not taken over
  select p.id into v_person from pm.portal_people p where v_email is not null and p.email = v_email;
  if v_person is null and v_phone is not null then select p.id into v_person from pm.portal_people p where p.phone = v_phone; end if;
  if v_person is null then
    insert into pm.portal_people (email, phone, display_name, locale)
    values (v_email, case when not exists (select 1 from pm.portal_people x where x.phone = v_phone) then v_phone end, v_name, v_locale)
    returning id into v_person;
  else
    -- an existing person's email / phone are never changed by another company (access follows the
    -- contact point each grant records, proven at sign-in — see portal._grants)
    update pm.portal_people p set display_name = coalesce(p.display_name, v_name), updated_at = now() where p.id = v_person;
  end if;

  select g.id into v_grant from pm.portal_grants g
   where g.person_id = v_person and g.org_id = v_org and g.location_id = p_location and g.audience = p_audience and g.status = 'active'
     and coalesce(g.customer_id, g.vendor_id) is not distinct from coalesce(v_party_customer, v_party_vendor);
  if v_grant is null then
    insert into pm.portal_grants (org_id, location_id, person_id, contact_id, audience, customer_id, vendor_id, display_name, email, phone,
                                  role, can_sign, can_pay, all_jobs, expires_at, invited_by)
    values (v_org, p_location, v_person, c.id, p_audience, v_party_customer, v_party_vendor, v_name, v_email, v_phone,
            v_role, v_sign, v_pay, coalesce((a ->> 'all_jobs')::boolean, false), v_exp, pm.current_user_id())
    returning id into v_grant;
  else
    update pm.portal_grants g set contact_id = c.id, display_name = v_name, email = v_email, phone = v_phone, role = v_role,
           can_sign = v_sign, can_pay = v_pay, all_jobs = g.all_jobs or coalesce((a ->> 'all_jobs')::boolean, false),
           expires_at = coalesce(v_exp, g.expires_at), updated_at = now()
     where g.id = v_grant;
  end if;
  insert into pm.portal_grant_jobs (org_id, grant_id, job_id)
  select v_org, v_grant, x from unnest(coalesce(p_jobs, '{}'::uuid[])) x
  on conflict do nothing;

  perform pm.log_activity(v_org, p_location, v_first_job, 'portal.invited', 'portal_grants', v_grant,
    format('Invited %s to the %s portal', v_name, p_audience), jsonb_build_object('audience', p_audience, 'jobs', coalesce(cardinality(p_jobs), 0)));

  if coalesce((a ->> 'send')::boolean, true) then
    v_base := portal._base(a ->> 'portal_url');
    select l.name into v_company from core.locations l where l.id = p_location;
    v_body := case when v_locale = 'es'
      then format('%s le invitó a su portal de proyectos. Entre con %s en %s/portal/sign-in?org=%s (sin contraseña: le enviaremos un código).',
                  v_company, coalesce(v_email, v_phone), coalesce(v_base, ''), v_org)
      else format('%s invited you to their project portal. Sign in with %s at %s/portal/sign-in?org=%s (no password: we send you a code).',
                  v_company, coalesce(v_email, v_phone), coalesce(v_base, ''), v_org) end;
    v_msg := portal._send(v_org, p_location, v_first_job, c.id, case when v_email is not null then 'email' else 'sms' end,
                          case when v_locale = 'es' then format('Su portal de %s', v_company) else format('Your %s portal', v_company) end,
                          v_body, 'portal-invite:' || v_grant::text || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
  return jsonb_build_object('grant_id', v_grant, 'person_id', v_person, 'message', v_msg);
end $$;

-- p_patch: {role, can_sign, can_pay, all_jobs, expires_at, add_jobs[], remove_jobs[]}
create or replace function pm.portal_update_grant(p_grant uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare g pm.portal_grants; v_cap text; p jsonb := coalesce(p_patch, '{}'::jsonb); v_job uuid; v_role text;
begin
  select * into g from pm.portal_grants x where x.id = p_grant and x.org_id = public.get_org_id() for update;
  if g.id is null then raise exception 'PM_FORBIDDEN: portal access not found' using errcode = '42501'; end if;
  v_cap := case g.audience when 'customer' then 'projects.customers' when 'vendor' then 'projects.commitments' else 'projects.billing' end;
  if not pm.access_is_service() and not pm.can(v_cap, 'edit', g.location_id) then
    raise exception 'PM_FORBIDDEN: requires %:edit at this company', v_cap using errcode = '42501';
  end if;
  if g.status <> 'active' then raise exception 'PM_INVALID: this access was revoked; invite them again' using errcode = '22023'; end if;
  v_role := coalesce(nullif(p ->> 'role', ''), g.role);
  if v_role not in ('approver','viewer') or (g.audience = 'investor' and v_role = 'approver') then
    raise exception 'PM_INVALID: role' using errcode = '22023';
  end if;
  update pm.portal_grants x set
    role = v_role,
    can_sign = case when v_role = 'viewer' then false else coalesce((p ->> 'can_sign')::boolean, x.can_sign) end,
    can_pay = case when g.audience = 'customer' then coalesce((p ->> 'can_pay')::boolean, x.can_pay) else false end,
    all_jobs = coalesce((p ->> 'all_jobs')::boolean, x.all_jobs),
    expires_at = case when p ? 'expires_at' then nullif(p ->> 'expires_at', '')::timestamptz else x.expires_at end,
    updated_at = now()
   where x.id = g.id;
  for v_job in select pm.access_try_uuid(value) from jsonb_array_elements_text(coalesce(p -> 'add_jobs', '[]'::jsonb)) loop
    if v_job is null or not exists (select 1 from core.jobs j where j.id = v_job and j.org_id = g.org_id and j.location_id = g.location_id
                                      and (g.audience <> 'customer' or j.customer_id is null or j.customer_id = g.customer_id)) then
      raise exception 'PM_INVALID: that job cannot be shared with this person' using errcode = '22023';
    end if;
    if not pm.access_is_service() and not pm.access_can_job('projects.jobs', 'view', v_job) then
      raise exception 'PM_FORBIDDEN: you cannot reach that job' using errcode = '42501';
    end if;
    insert into pm.portal_grant_jobs (org_id, grant_id, job_id) values (g.org_id, g.id, v_job) on conflict do nothing;
  end loop;
  delete from pm.portal_grant_jobs gj where gj.grant_id = g.id
     and gj.job_id in (select pm.access_try_uuid(value) from jsonb_array_elements_text(coalesce(p -> 'remove_jobs', '[]'::jsonb)));
  return (select to_jsonb(x) - 'email' - 'phone' from pm.portal_grants x where x.id = g.id);
end $$;

create or replace function pm.portal_revoke(p_grant uuid, p_reason text default null) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare g pm.portal_grants; v_cap text;
begin
  select * into g from pm.portal_grants x where x.id = p_grant and x.org_id = public.get_org_id() for update;
  if g.id is null then raise exception 'PM_FORBIDDEN: portal access not found' using errcode = '42501'; end if;
  v_cap := case g.audience when 'customer' then 'projects.customers' when 'vendor' then 'projects.commitments' else 'projects.billing' end;
  if not pm.access_is_service() and not pm.can(v_cap, 'edit', g.location_id) then
    raise exception 'PM_FORBIDDEN: requires %:edit at this company', v_cap using errcode = '42501';
  end if;
  if g.status = 'revoked' then return; end if;
  update pm.portal_grants set status = 'revoked', revoked_at = now(), revoked_by = pm.current_user_id(),
         revoke_reason = left(nullif(btrim(p_reason), ''), 500), updated_at = now()
   where id = g.id;
  perform pm.log_activity(g.org_id, g.location_id, null, 'portal.revoked', 'portal_grants', g.id,
    format('Removed %s''s %s portal access', g.display_name, g.audience), '{}'::jsonb);
end $$;

-- Share a document with portal audiences ([] = unshare). Cost documents never go to customers /
-- investors; vendor-shared cost documents are read only by the vendor whose record they are.
create or replace function pm.portal_share_document(p_file uuid, p_audiences text[]) returns text[]
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare f pm.doc_files; v text[] := coalesce(p_audiences, '{}'::text[]);
begin
  select * into f from pm.doc_files x where x.id = p_file and x.org_id = public.get_org_id() for update;
  if f.id is null or not pm._doc_can_read(p_file) then raise exception 'PM_FORBIDDEN: document not found' using errcode = '42501'; end if;
  if not (v <@ array['customer','vendor','lender','investor']::text[]) then raise exception 'PM_INVALID: unknown portal audience' using errcode = '22023'; end if;
  if f.money_cap = 'projects.financials' and (v && array['customer','investor']::text[]) then
    raise exception 'PM_INVALID: cost documents (POs, subcontracts, lien waivers) cannot be shared with customers or investors' using errcode = '22023';
  end if;
  if f.status <> 'active' and cardinality(v) > 0 then raise exception 'PM_INVALID: only active documents can be shared' using errcode = '22023'; end if;
  if f.money_cap is not null and not pm.access_is_service()
     and not (case when f.job_id is not null then pm.access_can_job(f.money_cap, 'view', f.job_id) else pm.can(f.money_cap, 'view', f.location_id) end) then
    raise exception 'PM_FORBIDDEN: sharing this document needs %', f.money_cap using errcode = '42501';
  end if;
  update pm.doc_files set portal_audiences = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(v) x), updated_at = now()
   where id = f.id;
  return (select portal_audiences from pm.doc_files where id = f.id);
end $$;

create or replace function pm.portal_set_client_visible(p_table text, p_id uuid, p_visible boolean) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_n int;
begin
  if p_table = 'tasks' then
    update pm.tasks set client_visible = coalesce(p_visible, false), updated_at = now() where id = p_id and org_id = public.get_org_id();
  elsif p_table = 'field_logs' then
    update pm.field_logs set client_visible = coalesce(p_visible, false), updated_at = now() where id = p_id and org_id = public.get_org_id();
  else
    raise exception 'PM_INVALID: tasks or field_logs' using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'PM_FORBIDDEN: record not found' using errcode = '42501'; end if;
  return coalesce(p_visible, false);
end $$;

-- Staff reply into a portal thread. p_party = the customer / vendor of the thread (null for lender / investor).
create or replace function pm.portal_post_message(p_job uuid, p_audience text, p_party uuid, p_body text, p_portal_url text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); j record; v_id uuid; v_name text; g record; v_sent int := 0; v_base text := portal._base(p_portal_url);
begin
  select x.id, x.location_id, x.name, x.job_number into j from core.jobs x where x.id = p_job and x.org_id = v_org;
  if j.id is null then raise exception 'PM_FORBIDDEN: job not found' using errcode = '42501'; end if;
  if p_audience not in ('customer','vendor','lender','investor') then raise exception 'PM_INVALID: audience' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'PM_INVALID: write a message (up to 4,000 characters)' using errcode = '22023'; end if;
  select coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), (select l.name from core.locations l where l.id = j.location_id))
    into v_name from core.users u where u.clerk_user_id = pm.current_user_id() limit 1;
  insert into pm.portal_messages (org_id, job_id, audience, party_id, author_kind, author_user, author_name, body, staff_read_at)
  values (v_org, p_job, p_audience, p_party, 'staff', pm.current_user_id(),
          coalesce(v_name, (select l.name from core.locations l where l.id = j.location_id), 'Team'), btrim(p_body), now())
  returning id into v_id;
  update pm.portal_messages set staff_read_at = now()
   where org_id = v_org and job_id = p_job and audience = p_audience and party_id is not distinct from p_party and staff_read_at is null;
  for g in select x.* from pm.portal_grants x
            where x.org_id = v_org and x.location_id = j.location_id and x.audience = p_audience and x.status = 'active'
              and coalesce(x.customer_id, x.vendor_id) is not distinct from p_party
              and p_job in (select portal._grant_jobs(x.id)) loop
    perform portal._send(v_org, j.location_id, p_job, g.contact_id, case when g.email is not null then 'email' else 'sms' end,
      format('New message on %s', j.name),
      format('You have a new message about %s. Read and reply: %s/portal', j.name, coalesce(v_base, '')),
      'portal-msg:' || v_id::text || ':' || g.id::text);
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('id', v_id, 'notified', v_sent);
end $$;

create or replace function pm.portal_update_request(p_request uuid, p_status text, p_note text default null, p_punch_item uuid default null)
returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare r pm.portal_requests;
begin
  select * into r from pm.portal_requests x where x.id = p_request and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: request not found' using errcode = '42501'; end if;
  if p_status not in ('new','acknowledged','scheduled','closed','converted') then raise exception 'PM_INVALID: status' using errcode = '22023'; end if;
  if p_punch_item is not null and not exists (select 1 from pm.punch_items p where p.id = p_punch_item and p.org_id = r.org_id
                                                and p.job_id is not distinct from r.job_id) then
    raise exception 'PM_INVALID: that punch item is not on this job' using errcode = '22023';
  end if;
  update pm.portal_requests set status = p_status, staff_note = coalesce(left(nullif(btrim(p_note), ''), 2000), staff_note),
         punch_item_id = coalesce(p_punch_item, punch_item_id), updated_at = now()
   where id = r.id;
end $$;

create or replace function pm.portal_decide_pay_app(p_pay_app uuid, p_decision text, p_note text default null) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare a pm.portal_pay_apps;
begin
  select * into a from pm.portal_pay_apps x where x.id = p_pay_app and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: pay application not found' using errcode = '42501'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'PM_INVALID: approved or rejected' using errcode = '22023'; end if;
  if a.status <> 'submitted' then raise exception 'PM_INVALID: this pay application is already %', a.status using errcode = '22023'; end if;
  if p_decision = 'rejected' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'PM_INVALID: tell the sub why (at least 3 characters)' using errcode = '22023';
  end if;
  update pm.portal_pay_apps set status = p_decision, decided_at = now(), decided_by = pm.current_user_id(),
         decision_note = left(nullif(btrim(p_note), ''), 2000)
   where id = a.id;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'portal.pay_app_' || p_decision, 'portal_pay_apps', a.id,
    format('Pay application #%s %s', a.application_no, p_decision), '{}'::jsonb);
end $$;

-- Staff answer to a sub's confirm / decline / proposed date. Accepting a proposed date moves the
-- task's start constraint to it (CPM recalculates on the next schedule run).
create or replace function pm.portal_resolve_response(p_response uuid, p_resolution text) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare r pm.portal_task_responses;
begin
  select * into r from pm.portal_task_responses x where x.id = p_response and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: response not found' using errcode = '42501'; end if;
  if p_resolution not in ('accepted','rejected','noted') then raise exception 'PM_INVALID: accepted, rejected or noted' using errcode = '22023'; end if;
  if r.resolved_at is not null then return; end if;
  update pm.portal_task_responses set resolution = p_resolution, resolved_by = pm.current_user_id(), resolved_at = now() where id = r.id;
  if p_resolution = 'accepted' and r.response = 'proposed' then
    update pm.tasks set constraint_type = 'SNET', constraint_date = r.proposed_start, start_on = r.proposed_start,
           due_on = case when due_on is not null and start_on is not null then r.proposed_start + (due_on - start_on) else due_on end,
           updated_at = now()
     where id = r.task_id and org_id = r.org_id;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Public portal: sign-in, phone verification, session
-- ----------------------------------------------------------------------------
-- Start a sign-in. The app (server key) generates the link token, the 6-digit code and the browser
-- nonce; only hashes are stored, the message is queued through core.notify_customer. The answer never
-- says whether the address has access (no enumeration): {ok, sent} where sent = a message was queued.
-- A message that carries a secret (sign-in / phone code). The notifications service decides (go-live
-- hold, consent, STOP list, suppression) and keeps the audit row — but the STORED body is a fixed
-- sentence with no secret. A queued row is claimed for the portal at once (status sending, attempts
-- at the cap, so the worker never sends the placeholder and a stale claim ends failed); the app
-- sends the real text straight to the provider and reports back through portal.dispatch_result.
create or replace function portal._send_secret(p_org uuid, p_location uuid, p_contact uuid, p_channel text, p_subject text,
                                               p_public_body text, p_dedupe text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_id uuid; o record;
begin
  v_id := core.notify_customer(p_org, p_location, null, 'customer.portal_access', p_channel, p_contact, p_subject, p_public_body, null, p_dedupe, 'portal');
  update core.outbound_messages m set status = 'sending', claimed_at = now(), attempts = 5, not_before = now(),
         status_reason = 'Portal secret: sent directly by the portal; the code is never stored', updated_at = now()
   where m.id = v_id and m.status = 'queued';
  select m.id, m.status, m.status_reason, m.to_address, m.channel into o from core.outbound_messages m where m.id = v_id;
  return jsonb_build_object('outbound_id', o.id, 'status', o.status, 'reason', o.status_reason, 'channel', o.channel,
    'to', case when o.status = 'sending' then o.to_address end,
    'from', case when o.status = 'sending' and o.channel = 'sms' then (core.notify_settings_row(p_org, p_location)).sms_from_number end,
    'subject', p_subject,
    'company', (select l.name from core.locations l where l.id = p_location));
end $$;

-- The app reports the provider outcome for a secret message (server key).
create or replace function portal.dispatch_result(p_server_key text, p_outbound uuid, p_ok boolean, p_provider text default null,
                                                  p_provider_message_id text default null, p_error text default null) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  perform portal._server_ok(p_server_key);
  update core.outbound_messages m set status = case when p_ok then 'sent' else 'failed' end, provider = left(p_provider, 40),
         provider_message_id = left(p_provider_message_id, 200), last_error = case when p_ok then null else left(p_error, 500) end,
         sent_at = case when p_ok then now() end, updated_at = now()
   where m.id = p_outbound and m.status = 'sending' and m.event_type = 'customer.portal_access';
end $$;

-- Slow guessing of 6-digit codes (security review): every wrong code counts against the ADDRESS for
-- the day, across all its links and sessions; at 15 the address is locked for 24 hours (a
-- pm.portal_security_events row is the lock and the platform alert).
create or replace function portal._locked(p_identifier text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select p_identifier is not null and exists (
    select 1 from pm.portal_security_events e
     where e.kind = 'address_locked' and e.identifier_hash = portal._h(p_identifier) and e.at > now() - interval '24 hours')
$$;

create or replace function portal._fail(p_identifier text, p_ip text) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_b text := 'vfail:day:' || portal._h(p_identifier); v_n int;
begin
  perform portal._hit(v_b, 'day', 15);
  select c.hits into v_n from pm.portal_rate_counters c where c.bucket = v_b and c.window_start = date_trunc('day', now());
  if coalesce(v_n, 0) >= 15 and not portal._locked(p_identifier) then
    insert into pm.portal_security_events (kind, identifier_hash, detail)
    values ('address_locked', portal._h(p_identifier), jsonb_build_object('failures_today', v_n, 'until', now() + interval '24 hours',
                                                                         'ip_hash', left(portal._h(coalesce(p_ip, 'unknown')), 32)));
    update pm.portal_links set revoked_at = now() where identifier = p_identifier and used_at is null and revoked_at is null;
    return true;
  end if;
  return false;
end $$;

-- Start a sign-in for one address at ONE company (p_org, else the one used most recently).
create or replace function portal._start(p_identifier text, p_org uuid, p_nonce_hash text, p_token text, p_code text,
                                         p_ip text, p_base_url text, p_locale text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  v_email text; v_phone text; v_channel text; v_id text; g record; v_link uuid; v_base text := portal._base(p_base_url);
  v_es boolean; v_d jsonb;
begin
  if p_nonce_hash !~ '^[0-9a-f]{64}$' or p_token !~ '^[A-Za-z0-9_-]{32,200}$' or p_code !~ '^[0-9]{6}$' then
    raise exception 'PORTAL_INVALID: bad sign-in request' using errcode = '22023';
  end if;
  if v_base is null then raise exception 'PORTAL_INVALID: portal address not configured' using errcode = '22023'; end if;
  v_email := portal._norm_email(p_identifier);
  v_phone := case when v_email is null then core.notify_e164(p_identifier) end;
  if v_email is null and v_phone is null then return jsonb_build_object('ok', false, 'reason', 'invalid_identifier'); end if;
  v_channel := case when v_email is not null then 'email' else 'sms' end;
  v_id := coalesce(v_email, v_phone);
  if portal._locked(v_id) then return jsonb_build_object('ok', true, 'sent', false, 'reason', 'locked'); end if;
  -- request caps (no spamming an address): 5 an hour and 10 a day per address, 30 an hour per client IP
  if not portal._hit('signin:id:' || portal._h(v_id), 'hour', 5)
     or not portal._hit('signin:idday:' || portal._h(v_id), 'day', 10)
     or not portal._hit('signin:ip:' || left(portal._h(coalesce(p_ip, 'unknown')), 32), 'hour', 30) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  -- the company that sends it (and the ONLY one the session will reach): a live company that recorded
  -- exactly this address on an active grant whose contact still carries it
  select gr.* into g from pm.portal_grants gr
    join core.contacts ct on ct.id = gr.contact_id
    join pm.portal_people pp on pp.id = gr.person_id and pp.disabled_at is null
   where gr.status = 'active' and (gr.expires_at is null or gr.expires_at > now())
     and (p_org is null or gr.org_id = p_org)
     and ((v_channel = 'email' and gr.email = v_email and portal._norm_email(ct.email) = v_email)
       or (v_channel = 'sms' and gr.phone = v_phone and core.notify_e164(ct.phone) = v_phone))
     and portal._live(gr.org_id, gr.location_id)
   order by gr.last_seen_at desc nulls last, gr.created_at desc
   limit 1;
  if g.id is null then return jsonb_build_object('ok', true, 'sent', false); end if;

  update pm.portal_links set revoked_at = now() where identifier = v_id and purpose = 'sign_in' and used_at is null and revoked_at is null;
  insert into pm.portal_links (person_id, purpose, channel, org_id, identifier, token_hash, code_hash, nonce_hash, expires_at)
  values (g.person_id, 'sign_in', v_channel, g.org_id, v_id, portal._h(p_token), portal._h(p_code || ':' || p_nonce_hash), p_nonce_hash,
          now() + interval '20 minutes')
  returning id into v_link;
  v_es := coalesce(p_locale, (select pp.locale from pm.portal_people pp where pp.id = g.person_id)) = 'es';
  v_d := portal._send_secret(g.org_id, g.location_id, g.contact_id, v_channel,
    case when v_es then 'Su código para entrar' else 'Your sign-in code' end,
    case when v_es then 'Código para entrar al portal (enviado directamente; el código no se guarda).'
         else 'Portal sign-in code (sent directly; the code is never stored).' end,
    'portal-signin:' || v_link::text);
  return jsonb_build_object('ok', true, 'sent', v_d ->> 'status' = 'sending',
                            'dispatch', case when v_d ->> 'status' = 'sending' then v_d || jsonb_build_object('locale', case when v_es then 'es' else 'en' end) end);
end $$;

drop function if exists portal.auth_start(text, text, text, text, text, text, text, text);
-- p_org: the company of the invitation link (/portal/sign-in?org=…); null = the one used last.
create or replace function portal.auth_start(p_server_key text, p_identifier text, p_nonce_hash text, p_token text, p_code text,
                                             p_ip text default null, p_base_url text default null, p_locale text default 'en',
                                             p_org uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  perform portal._server_ok(p_server_key);
  return portal._start(p_identifier, p_org, p_nonce_hash, p_token, p_code, p_ip, p_base_url, p_locale);
end $$;

-- Switch company: a fresh code FROM that company to the address this session already proved.
create or replace function portal.auth_switch(p_server_key text, p_session text, p_org uuid, p_nonce_hash text, p_token text, p_code text,
                                              p_ip text default null, p_base_url text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; v_id text;
begin
  perform portal._server_ok(p_server_key);
  s := portal._session(p_session);
  v_id := case when s.verified_email is not null and exists (select 1 from pm.portal_grants g where g.org_id = p_org and g.status = 'active' and g.email = s.verified_email)
               then s.verified_email else s.verified_phone end;
  if v_id is null then return jsonb_build_object('ok', true, 'sent', false); end if;
  return portal._start(v_id, p_org, p_nonce_hash, p_token, p_code, p_ip, p_base_url, (select pp.locale from pm.portal_people pp where pp.id = s.person_id))
         || jsonb_build_object('identifier_kind', case when v_id like '%@%' then 'email' else 'phone' end);
end $$;

-- Create a session that proved control of one address at one company (internal). A contact point
-- with live sessions at more than one company is recorded in pm.portal_security_events (alert hook).
create or replace function portal._open_session(p_person uuid, p_method text, p_identifier text, p_org uuid, p_session_hash text, p_ip text, p_ua text)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare p pm.portal_people; v_email text := case when p_method = 'email' then p_identifier end; v_phone text := case when p_method = 'sms' then p_identifier end;
  v_others int;
begin
  if p_session_hash !~ '^[0-9a-f]{64}$' then raise exception 'PORTAL_INVALID: bad session' using errcode = '22023'; end if;
  if p_org is null then raise exception 'PORTAL_INVALID: no company' using errcode = '22023'; end if;
  insert into pm.portal_sessions (person_id, org_id, token_hash, auth_method, verified_email, verified_phone, phone_verified_at, ip, user_agent, expires_at)
  values (p_person, p_org, p_session_hash, p_method, v_email, v_phone, case when p_method = 'sms' then now() end, left(p_ip, 64), left(p_ua, 500),
          now() + interval '30 days');
  select count(distinct x.org_id) into v_others from pm.portal_sessions x
   where x.revoked_at is null and x.expires_at > now() and x.org_id <> p_org
     and ((v_email is not null and x.verified_email = v_email) or (v_phone is not null and x.verified_phone = v_phone));
  if v_others > 0 then
    insert into pm.portal_security_events (kind, identifier_hash, org_id, detail)
    values ('multi_org_sessions', portal._h(p_identifier), p_org, jsonb_build_object('other_orgs', v_others, 'method', p_method, 'ip', left(p_ip, 64)));
  end if;
  update pm.portal_people set email_verified_at = case when p_method = 'email' and email = v_email then now() else email_verified_at end,
         phone_verified_at = case when p_method = 'sms' and phone = v_phone then now() else phone_verified_at end, updated_at = now()
   where id = p_person
  returning * into p;
  update pm.portal_grants set accepted_at = now()
   where accepted_at is null and status = 'active' and org_id = p_org
     and ((v_email is not null and email = v_email) or (v_phone is not null and phone = v_phone));
  return jsonb_build_object('ok', true, 'reason', null, 'locale', p.locale, 'name', p.display_name, 'org_id', p_org);
end $$;

-- Redeem a link. Same browser only (nonce); one use; 20 minutes.
create or replace function portal.auth_redeem(p_token text, p_nonce text, p_session_hash text, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare l pm.portal_links;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,200}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into l from pm.portal_links x where x.token_hash = portal._h(p_token) and x.purpose = 'sign_in' for update;
  if l.id is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if l.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if l.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'replaced'); end if;
  if l.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if p_nonce is null or l.nonce_hash is distinct from portal._h(p_nonce) then
    return jsonb_build_object('ok', false, 'reason', 'other_device');
  end if;
  update pm.portal_links set used_at = now() where id = l.id;
  return portal._open_session(l.person_id, l.channel, l.identifier, l.org_id, p_session_hash, p_ip, p_user_agent);
end $$;

-- Code check (internal): the newest open link for this address bound to THIS browser's nonce.
create or replace function portal._check_code(p_identifier text, p_code text, p_nonce text, p_session_hash text, p_ip text, p_ua text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare l pm.portal_links; v_nh text := portal._h(p_nonce);
begin
  if p_identifier is null or p_code !~ '^[0-9]{6}$' or p_nonce is null or char_length(p_nonce) < 20 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if portal._locked(p_identifier) then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if not portal._hit('verify:ip:' || left(portal._h(coalesce(p_ip, 'unknown')), 32), 'hour', 30)
     or not portal._hit('verify:id:' || portal._h(p_identifier), 'hour', 15) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  select x.* into l from pm.portal_links x
   where x.purpose = 'sign_in' and x.identifier = p_identifier and x.used_at is null and x.revoked_at is null and x.expires_at > now()
     and x.nonce_hash = v_nh
   order by x.created_at desc limit 1
   for update;
  if l.id is null then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if l.code_hash is distinct from portal._h(p_code || ':' || v_nh) then
    update pm.portal_links set attempts = attempts + 1, revoked_at = case when attempts + 1 >= 5 then now() end where id = l.id;
    if portal._fail(p_identifier, p_ip) then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
    return jsonb_build_object('ok', false, 'reason', case when l.attempts + 1 >= 5 then 'too_many' else 'wrong_code' end);
  end if;
  update pm.portal_links set used_at = now() where id = l.id;
  return portal._open_session(l.person_id, l.channel, l.identifier, l.org_id, p_session_hash, p_ip, p_ua);
end $$;

-- The 6-digit code from the same message, typed in the browser that asked. 5 tries per code.
drop function if exists portal.auth_verify_code(text, text, text, text, text, text);
create or replace function portal.auth_verify_code(p_server_key text, p_identifier text, p_code text, p_nonce text, p_session_hash text,
                                                   p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  perform portal._server_ok(p_server_key);   -- code guesses only through the app (trusted client IP, per-IP limit)
  return portal._check_code(coalesce(portal._norm_email(p_identifier), core.notify_e164(p_identifier)), p_code, p_nonce, p_session_hash, p_ip, p_user_agent);
end $$;

-- The code of a company switch (the address comes from the current session, not from the browser).
drop function if exists portal.auth_verify_switch(text, text, text, text, text, text);
create or replace function portal.auth_verify_switch(p_server_key text, p_session text, p_code text, p_nonce text, p_session_hash text,
                                                     p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; r jsonb;
begin
  perform portal._server_ok(p_server_key);
  s := portal._session(p_session);
  if s.verified_email is not null then
    r := portal._check_code(s.verified_email, p_code, p_nonce, p_session_hash, p_ip, p_user_agent);
    if coalesce((r ->> 'ok')::boolean, false) or s.verified_phone is null or r ->> 'reason' <> 'expired' then return r; end if;
  end if;
  return portal._check_code(s.verified_phone, p_code, p_nonce, p_session_hash, p_ip, p_user_agent);
end $$;

create or replace function portal.sign_out(p_session text) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  update pm.portal_sessions set revoked_at = now() where token_hash = portal._h(p_session) and revoked_at is null;
  return found;
end $$;

-- Step-up: text a code to the phone this session's company recorded on one of its grants.
create or replace function portal.phone_start(p_server_key text, p_session text, p_code text, p_org uuid default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g record; v_link uuid; v_d jsonb; v_locale text;
begin
  perform portal._server_ok(p_server_key);
  s := portal._session(p_session);
  if p_code !~ '^[0-9]{6}$' then raise exception 'PORTAL_INVALID: bad code' using errcode = '22023'; end if;
  select gr.* into g from portal._grants(s, s.org_id) gr join core.contacts ct on ct.id = gr.contact_id
   where gr.phone is not null and core.notify_e164(ct.phone) = gr.phone and portal._live(gr.org_id, gr.location_id)
   order by gr.last_seen_at desc nulls last limit 1;
  if g.id is null then
    return jsonb_build_object('ok', false, 'reason', case when exists (select 1 from portal._grants(s, s.org_id) x where x.phone is not null) then 'not_live' else 'no_phone' end);
  end if;
  if s.verified_phone = g.phone then return jsonb_build_object('ok', true, 'reason', 'already_verified'); end if;
  if portal._locked(g.phone) then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if not portal._hit('phone:s:' || s.id::text, 'hour', 4) or not portal._hit('phone:day:' || portal._h(g.phone), 'day', 8) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  update pm.portal_links set revoked_at = now() where session_id = s.id and purpose = 'phone_verify' and used_at is null and revoked_at is null;
  insert into pm.portal_links (person_id, purpose, channel, org_id, session_id, identifier, code_hash, expires_at)
  values (s.person_id, 'phone_verify', 'sms', g.org_id, s.id, g.phone, portal._h(p_code || ':' || s.id::text), now() + interval '10 minutes')
  returning id into v_link;
  select pp.locale into v_locale from pm.portal_people pp where pp.id = s.person_id;
  v_d := portal._send_secret(g.org_id, g.location_id, g.contact_id, 'sms', null,
    case when v_locale = 'es' then 'Código de verificación del portal (enviado directamente; el código no se guarda).'
         else 'Portal verification code (sent directly; the code is never stored).' end, 'portal-phone:' || v_link::text);
  return jsonb_build_object('ok', v_d ->> 'status' = 'sending', 'reason', v_d ->> 'status', 'phone_hint', '•••' || right(g.phone, 4),
                            'dispatch', case when v_d ->> 'status' = 'sending' then v_d || jsonb_build_object('locale', coalesce(v_locale, 'en')) end);
end $$;

drop function if exists portal.phone_verify(text, text);
create or replace function portal.phone_verify(p_server_key text, p_session text, p_code text, p_ip text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; l pm.portal_links;
begin
  perform portal._server_ok(p_server_key);
  s := portal._session(p_session);
  if p_code !~ '^[0-9]{6}$' then return jsonb_build_object('ok', false, 'reason', 'wrong_code'); end if;
  if not portal._hit('verify:ip:' || left(portal._h(coalesce(p_ip, 'unknown')), 32), 'hour', 30) then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  select * into l from pm.portal_links x where x.session_id = s.id and x.purpose = 'phone_verify' and x.used_at is null
     and x.revoked_at is null and x.expires_at > now() order by x.created_at desc limit 1 for update;
  if l.id is null then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if portal._locked(l.identifier) then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if l.code_hash is distinct from portal._h(p_code || ':' || s.id::text) then
    if portal._fail(l.identifier, p_ip) then
      update pm.portal_links set revoked_at = now() where id = l.id;
      return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    update pm.portal_links set attempts = attempts + 1, revoked_at = case when attempts + 1 >= 5 then now() end where id = l.id;
    return jsonb_build_object('ok', false, 'reason', case when l.attempts + 1 >= 5 then 'too_many' else 'wrong_code' end);
  end if;
  update pm.portal_links set used_at = now() where id = l.id;
  update pm.portal_sessions set verified_phone = l.identifier, phone_verified_at = now() where id = s.id;
  update pm.portal_people set phone_verified_at = now(), updated_at = now() where id = s.person_id and phone = l.identifier;
  return jsonb_build_object('ok', true, 'reason', null);
end $$;

create or replace function portal.set_locale(p_session text, p_locale text) returns text
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions;
begin
  s := portal._session(p_session);
  if p_locale not in ('en','es') then raise exception 'PORTAL_INVALID: en or es' using errcode = '22023'; end if;
  update pm.portal_people set locale = p_locale, updated_at = now() where id = s.person_id;
  return p_locale;
end $$;

-- Who am I: the ONE company this session is signed in to, and the other companies where this same
-- address has portal access (switching needs a fresh code from that company — portal.auth_switch).
create or replace function portal.me(p_session text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; p pm.portal_people;
begin
  s := portal._session(p_session);
  select * into p from pm.portal_people x where x.id = s.person_id;
  return jsonb_build_object(
    'person', jsonb_build_object('name', p.display_name, 'locale', p.locale,
                                 'email', s.verified_email, 'phone_hint', case when s.verified_phone is not null then '•••' || right(s.verified_phone, 4) end,
                                 'verified', portal._verified_any(s), 'has_phone', s.verified_phone is not null),
    'orgs', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', o.id, 'org_name', o.name,
               'companies', (select jsonb_agg(distinct l.name) from portal._grants(s, o.id) g2 join core.locations l on l.id = g2.location_id),
               'audiences', (select jsonb_agg(distinct g2.audience) from portal._grants(s, o.id) g2),
               'brand', (select pm._doc_brand(g2.location_id) from portal._grants(s, o.id) g2 order by g2.created_at limit 1),
               'phone_hint', (select '•••' || right(g2.phone, 4) from portal._grants(s, o.id) g2 where g2.phone is not null order by g2.created_at limit 1)))
        from core.organizations o
       where o.id = s.org_id and exists (select 1 from portal._grants(s, o.id))), '[]'::jsonb),
    'other_orgs', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', o.id, 'org_name', coalesce(
               (select l.name from pm.portal_grants g join core.locations l on l.id = g.location_id
                 where g.org_id = o.id and g.status = 'active' and ((s.verified_email is not null and g.email = s.verified_email) or (s.verified_phone is not null and g.phone = s.verified_phone))
                 order by g.created_at limit 1), o.name)) order by o.name)
        from core.organizations o
       where o.id <> s.org_id
         and exists (select 1 from pm.portal_sessions x where x.org_id = o.id and x.revoked_at is null and x.expires_at > now()
                       and ((s.verified_email is not null and x.verified_email = s.verified_email) or (s.verified_phone is not null and x.verified_phone = s.verified_phone)))
         and exists (select 1 from pm.portal_grants g where g.org_id = o.id and g.status = 'active' and (g.expires_at is null or g.expires_at > now())
                       and ((s.verified_email is not null and g.email = s.verified_email) or (s.verified_phone is not null and g.phone = s.verified_phone)))), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- 8. Public portal: reads (whitelisted columns only)
-- ----------------------------------------------------------------------------
-- The open e-sign signer slot on an envelope that belongs to this person (verified email / phone).
create or replace function portal._my_signer(ss pm.portal_sessions, p_env uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select s.id from pm.esign_signers s
    join pm.esign_envelopes e on e.id = s.envelope_id
   where s.envelope_id = p_env and e.status = 'sent' and e.expires_at > now()
     and s.status in ('pending_send','sent','viewed')
     and ((ss.verified_email is not null and lower(s.email) = ss.verified_email)
       or (ss.verified_phone is not null and core.notify_e164(s.phone) = ss.verified_phone))
   order by s.routing_order, s.position limit 1
$$;

-- The open envelope (if any) on a record's own document.
create or replace function portal._open_envelope(p_org uuid, p_table text, p_id uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select e.id from pm.esign_envelopes e join pm.doc_files f on f.id = e.file_id
   where f.org_id = p_org and f.subject_table = p_table and f.subject_id = p_id and e.status = 'sent' and e.expires_at > now()
   order by e.created_at desc limit 1
$$;

-- Decision already sent from the portal (staff not done yet)?
create or replace function portal._decided(p_org uuid, p_table text, p_id uuid, p_since timestamptz) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select a.action from pm.portal_actions a
   where a.org_id = p_org and a.subject_table = p_table and a.subject_id = p_id
     and a.action in ('approved','declined','accepted') and a.at >= coalesce(p_since, '-infinity'::timestamptz)
   order by a.at desc limit 1
$$;

create or replace function portal._job_brief(p_job uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object('id', j.id, 'name', j.name, 'number', j.job_number, 'company', l.name, 'status', j.status,
                            'stage', (select pr.stage_key from pm.projects pr where pr.job_id = j.id))
    from core.jobs j join core.locations l on l.id = j.location_id where j.id = p_job
$$;

-- The customer a change order belongs to: its contract's payer, else the job's customer.
create or replace function portal._co_customer(p_co uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(ct.customer_id, j.customer_id)
    from pm.change_orders c join core.jobs j on j.id = c.job_id
    left join pm.contracts ct on ct.id = c.contract_id
   where c.id = p_co
$$;

-- Everything waiting on this person at this company (customer, vendor, lender), deadline and $ impact.
create or replace function portal._queue(s pm.portal_sessions, p_org uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  with g as (select * from portal._grants(s, p_org)),
  gj as (select g.id as grant_id, g.audience, g.role, g.can_sign, g.can_pay, g.customer_id, g.vendor_id, x as job_id
           from g cross join lateral portal._grant_jobs(g.id) x),
  items as (
    -- estimates / proposals
    select distinct on (e.id) jsonb_build_object('kind', 'estimate', 'id', e.id, 'job', portal._job_brief(e.job_id),
             'title', e.title, 'number', e.number, 'deadline', e.valid_until, 'amount_cents', e.total_cents, 'amount_kind', 'total',
             'state', case when portal._decided(p_org, 'estimates', e.id, e.sent_at) is not null then 'sent' else 'waiting' end,
             'action', case when portal._my_signer(s, portal._open_envelope(p_org, 'estimates', e.id)) is not null then 'sign' else 'approve' end,
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'estimates', e.id)),
             'can_act', gj.role = 'approver', 'grant_id', gj.grant_id) as item, e.valid_until as due
      from gj join pm.estimates e on e.org_id = p_org and e.job_id = gj.job_id
     where gj.audience = 'customer' and e.status = 'SENT' and (e.customer_id is null or e.customer_id = gj.customer_id)
    union all
    -- change orders sent to the customer
    select distinct on (c.id) jsonb_build_object('kind', 'change_order', 'id', c.id, 'job', portal._job_brief(c.job_id),
             'title', c.title, 'number', c.number,
             'deadline', case when c.ext ->> 'respond_by' ~ '^\d{4}-\d{2}-\d{2}$' then c.ext ->> 'respond_by' end,
             'amount_cents', c.amount_cents, 'amount_kind', 'change', 'schedule_days', c.schedule_days,
             'state', case when portal._decided(p_org, 'change_orders', c.id, c.updated_at) is not null then 'sent' else 'waiting' end,
             'action', case when portal._my_signer(s, portal._open_envelope(p_org, 'change_orders', c.id)) is not null then 'sign' else 'approve' end,
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'change_orders', c.id)),
             'can_act', gj.role = 'approver', 'grant_id', gj.grant_id),
           case when c.ext ->> 'respond_by' ~ '^\d{4}-\d{2}-\d{2}$' then (c.ext ->> 'respond_by')::date end
      from gj join pm.change_orders c on c.org_id = p_org and c.job_id = gj.job_id
     where gj.audience = 'customer' and c.stage = 'COR'
       and portal._co_customer(c.id) = gj.customer_id
    union all
    -- selections (allowance delta = the recommended option, else the cheapest)
    select distinct on (s.id) jsonb_build_object('kind', 'selection', 'id', s.id, 'job', portal._job_brief(s.job_id),
             'title', s.category || ': ' || s.title, 'deadline', s.due_on,
             'allowance_cents', coalesce(s.allowance_cents, case when jsonb_typeof(s.ext -> 'allowance_cents') = 'number' then (s.ext ->> 'allowance_cents')::bigint end),
             'amount_cents', (select o.amount_cents - coalesce(s.allowance_cents, case when jsonb_typeof(s.ext -> 'allowance_cents') = 'number' then (s.ext ->> 'allowance_cents')::bigint end, o.amount_cents)
                                from pm.selection_options o where o.selection_id = s.id order by o.is_recommended desc, o.amount_cents limit 1),
             'amount_kind', 'vs_allowance', 'options', (select count(*) from pm.selection_options o where o.selection_id = s.id),
             'state', 'waiting', 'action', 'choose', 'can_act', gj.role = 'approver', 'grant_id', gj.grant_id), s.due_on
      from gj join pm.selections s on s.org_id = p_org and s.job_id = gj.job_id
     where gj.audience = 'customer' and s.status = 'PROPOSED'
    union all
    -- draws the payer / lender reviews
    select distinct on (d.id) jsonb_build_object('kind', 'draw', 'id', d.id, 'job', portal._job_brief(d.job_id),
             'title', format('Draw %s', d.draw_number), 'number', d.draw_number::text, 'deadline', null,
             'amount_cents', d.requested_cents, 'amount_kind', 'requested',
             'state', case when portal._decided(p_org, 'draws', d.id, d.submitted_at) is not null then 'sent' else 'waiting' end,
             'action', 'review', 'can_act', gj.role = 'approver', 'grant_id', gj.grant_id), d.period_end
      from gj join pm.draws d on d.org_id = p_org and d.job_id = gj.job_id
      join pm.draw_schedules ds on ds.id = d.draw_schedule_id
     where gj.audience in ('customer','lender') and d.status in ('SUBMITTED','INSPECTION')
       and ds.lender_customer_id = gj.customer_id
    union all
    -- open invoices (pay where Books has a pay link and this person may pay)
    select distinct on (i.id) jsonb_build_object('kind', 'invoice', 'id', i.id, 'job', case when i.job_id is not null then portal._job_brief(i.job_id) end,
             'title', 'Invoice ' || i.invoice_number, 'number', i.invoice_number, 'deadline', i.due_date,
             'amount_cents', i.balance_cents, 'amount_kind', 'balance', 'state', case when i.status = 'OVERDUE' or i.due_date < current_date then 'overdue' else 'waiting' end,
             'action', case when gr.can_pay then 'pay' else 'review' end,
             'pay_token', case when gr.can_pay then i.public_token end, 'can_act', gr.can_pay, 'grant_id', gr.id), i.due_date
      from g gr join public.invoices i on i.org_id = p_org and i.customer_id = gr.customer_id and i.location_id = gr.location_id
     where gr.audience = 'customer' and i.status in ('SENT','PARTIALLY_PAID','OVERDUE') and i.balance_cents > 0
       and (i.job_id in (select x from portal._grant_jobs(gr.id) x) or (gr.all_jobs and i.job_id is null))
    union all
    -- sub / vendor: assignments in the next 21 days without an answer yet
    select distinct on (t.id) jsonb_build_object('kind', 'assignment', 'id', t.id, 'job', portal._job_brief(t.job_id),
             'title', t.title, 'deadline', coalesce(t.early_start, t.start_on, t.constraint_date),
             'finish', coalesce(t.early_finish, t.due_on), 'state', 'waiting', 'action', 'confirm', 'can_act', true, 'grant_id', gj.grant_id),
           coalesce(t.early_start, t.start_on, t.constraint_date)
      from gj join pm.tasks t on t.org_id = p_org and t.job_id = gj.job_id
     where gj.audience = 'vendor' and t.assigned_vendor_id = gj.vendor_id and t.status in ('TODO','IN_PROGRESS','BLOCKED')
       and coalesce(t.early_start, t.start_on, t.constraint_date, current_date) <= current_date + 21
       and not exists (select 1 from pm.portal_task_responses r where r.task_id = t.id and r.vendor_id = gj.vendor_id
                         and (r.resolved_at is null or r.response = 'confirmed') and r.created_at >= t.updated_at - interval '1 second')
    union all
    -- POs / subcontracts to accept
    select distinct on (c.id) jsonb_build_object('kind', 'commitment', 'id', c.id, 'job', portal._job_brief(c.job_id),
             'title', coalesce(c.title, c.commitment_type), 'number', c.number,
             'amount_cents', (select coalesce(sum(cl.amount_cents), 0) from pm.commitment_lines cl where cl.commitment_id = c.id), 'amount_kind', 'total',
             'state', case when portal._decided(p_org, 'commitments', c.id, c.approved_at) is not null then 'sent' else 'waiting' end,
             'action', case when portal._my_signer(s, portal._open_envelope(p_org, 'commitments', c.id)) is not null then 'sign' else 'accept' end,
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'commitments', c.id)),
             'can_act', gj.role = 'approver', 'grant_id', gj.grant_id), null::date
      from gj join pm.commitments c on c.org_id = p_org and c.job_id = gj.job_id
     where gj.audience = 'vendor' and c.vendor_id = gj.vendor_id and c.status = 'APPROVED' and c.executed_on is null
    union all
    -- compliance owed on a job (COI, lien waivers, W-9) — upload or sign
    select distinct on (cd.id) jsonb_build_object('kind', 'compliance', 'id', cd.id, 'job', portal._job_brief(cd.job_id),
             'title', cd.doc_type, 'deadline', cd.expires_on, 'amount_cents', case when cd.doc_type like 'LIEN_WAIVER%' then cd.amount_cents end,
             'amount_kind', 'waiver', 'state', lower(cd.status),
             'action', case when portal._my_signer(s, portal._open_envelope(p_org, 'compliance_docs', cd.id)) is not null then 'sign' else 'upload' end,
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'compliance_docs', cd.id)),
             'can_act', true, 'grant_id', gj.grant_id), cd.expires_on
      from gj join pm.compliance_docs cd on cd.org_id = p_org and cd.job_id = gj.job_id
     where gj.audience = 'vendor' and cd.vendor_id = gj.vendor_id and cd.required and cd.status in ('MISSING','REJECTED','EXPIRED')
    union all
    -- punch items assigned to the sub
    select distinct on (pi.id) jsonb_build_object('kind', 'punch', 'id', pi.id, 'job', portal._job_brief(pi.job_id),
             'title', pi.title, 'deadline', pi.due_on, 'area', pi.area, 'state', lower(pi.status), 'action', 'complete',
             'can_act', true, 'grant_id', gj.grant_id), pi.due_on
      from gj join pm.punch_items pi on pi.org_id = p_org and pi.job_id = gj.job_id
     where gj.audience = 'vendor' and pi.responsible_vendor_id = gj.vendor_id and pi.status in ('OPEN','IN_PROGRESS')
    union all
    -- any other document waiting for this person's signature on a granted job
    select distinct on (e.id) jsonb_build_object('kind', 'signature', 'id', e.id, 'job', portal._job_brief(e.job_id),
             'title', e.title, 'deadline', e.expires_at::date, 'state', 'waiting', 'action', 'sign',
             'signer_id', portal._my_signer(s, e.id), 'can_act', gj.can_sign, 'grant_id', gj.grant_id), e.expires_at::date
      from gj join pm.esign_envelopes e on e.org_id = p_org and e.job_id = gj.job_id
      join pm.doc_files f on f.id = e.file_id
     where e.status = 'sent' and portal._my_signer(s, e.id) is not null
       and coalesce(f.subject_table, '') not in ('estimates','change_orders','commitments','compliance_docs')
  )
  select coalesce(jsonb_agg(item order by (item ->> 'state') = 'sent', due nulls last), '[]'::jsonb) from items
$$;

-- Home: companies, grants, jobs, the queue.
create or replace function portal.home(p_session text, p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; v_grants jsonb;
begin
  s := portal._session(p_session);
  if not exists (select 1 from portal._grants(s, p_org)) then
    raise exception 'PORTAL_FORBIDDEN: no access at this company' using errcode = '42501';
  end if;
  update pm.portal_grants set last_seen_at = now() where id in (select x.id from portal._grants(s, p_org) x)
     and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  select jsonb_agg(jsonb_build_object('id', g.id, 'audience', g.audience, 'company', l.name, 'party', portal._party_name(g),
                                      'role', g.role, 'can_sign', g.can_sign, 'can_pay', g.can_pay, 'expires_at', g.expires_at,
                                      'brand', pm._doc_brand(g.location_id)) order by l.name, g.audience)
    into v_grants from portal._grants(s, p_org) g join core.locations l on l.id = g.location_id;
  return jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name) from core.organizations o where o.id = p_org),
    'grants', v_grants,
    'verified', portal._verified_any(s),
    'jobs', coalesce((select jsonb_agg(portal._job_brief(x.job_id) || jsonb_build_object('audiences', x.audiences,
                 'next_milestone', (select jsonb_build_object('title', t.title, 'on', coalesce(t.early_start, t.start_on, t.constraint_date))
                                      from pm.tasks t where t.job_id = x.job_id and t.client_visible and t.status in ('TODO','IN_PROGRESS')
                                       and 'customer' = any (x.audiences)
                                     order by coalesce(t.early_start, t.start_on, t.constraint_date) nulls last limit 1))
                 order by x.job_id)
               from (select j as job_id, array_agg(distinct g.audience) as audiences
                       from portal._grants(s, p_org) g cross join lateral portal._grant_jobs(g.id) j group by j) x), '[]'::jsonb),
    'queue', portal._queue(s, p_org));
end $$;

-- One job, as this person may see it.
create or replace function portal.job(p_session text, p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; gc pm.portal_grants; gv pm.portal_grants; gl pm.portal_grants; v_aud text[]; out jsonb;
begin
  s := portal._session(p_session);
  gc := portal._job_grant(s, p_org, p_job, array['customer']);
  gv := portal._job_grant(s, p_org, p_job, array['vendor']);
  gl := portal._job_grant(s, p_org, p_job, array['lender','investor']);
  if gc.id is null and gv.id is null and gl.id is null then
    raise exception 'PORTAL_FORBIDDEN: no access to this job' using errcode = '42501';
  end if;
  v_aud := array_remove(array[case when gc.id is not null then 'customer' end, case when gv.id is not null then 'vendor' end,
                              gl.audience], null);
  out := jsonb_build_object('job', portal._job_brief(p_job), 'audiences', to_jsonb(v_aud),
                            'brand', pm._doc_brand((select j.location_id from core.jobs j where j.id = p_job)));

  if gc.id is not null or gl.id is not null then
    out := out || jsonb_build_object(
      'milestones', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'milestone', t.is_milestone, 'status', t.status,
                                 'start', coalesce(t.actual_start, t.early_start, t.start_on, t.constraint_date),
                                 'finish', coalesce(t.actual_finish, t.early_finish, t.due_on), 'pct', t.pct_complete)
                               order by coalesce(t.actual_start, t.early_start, t.start_on, t.constraint_date) nulls last, t.sort)
                               from pm.tasks t where t.org_id = p_org and t.job_id = p_job and t.client_visible and t.status <> 'CANCELLED'), '[]'::jsonb),
      'documents', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'kind', f.kind, 'updated_at', f.updated_at,
                                 'file_name', v.file_name) order by f.updated_at desc)
                               from pm.doc_files f join pm.doc_versions v on v.id = f.current_version_id
                              where f.org_id = p_org and f.job_id = p_job and f.status = 'active'
                                and ((gc.id is not null and 'customer' = any (f.portal_audiences) and coalesce(f.money_cap, '') <> 'projects.financials')
                                  or (gl.audience = 'investor' and 'investor' = any (f.portal_audiences) and coalesce(f.money_cap, '') <> 'projects.financials')
                                  or (gl.audience = 'lender' and 'lender' = any (f.portal_audiences)
                                      and (coalesce(f.money_cap, '') <> 'projects.financials' or f.kind in ('draw_request','lien_waiver','pay_app'))))), '[]'::jsonb));
  end if;
  if gc.id is not null then
    out := out || jsonb_build_object(
      'photos', coalesce((select jsonb_agg(jsonb_build_object('id', m.document_id, 'taken_at', coalesce(m.taken_at, m.received_at), 'area', m.area)
                            order by coalesce(m.taken_at, m.received_at) desc)
                            from (select * from pm.doc_photo_meta m0 where m0.org_id = p_org and m0.job_id = p_job and m0.share_to_portal
                                   order by coalesce(m0.taken_at, m0.received_at) desc limit 60) m), '[]'::jsonb),
      'logs', coalesce((select jsonb_agg(jsonb_build_object('id', fl.id, 'date', fl.log_date, 'kind', fl.kind, 'body', fl.body,
                          'weather', fl.weather -> 'summary') order by fl.log_date desc, fl.created_at desc)
                          from (select * from pm.field_logs x where x.org_id = p_org and x.job_id = p_job and x.client_visible
                                 order by x.log_date desc limit 30) fl), '[]'::jsonb),
      'household', coalesce((select jsonb_agg(jsonb_build_object('name', h.display_name, 'role', h.role, 'can_sign', h.can_sign, 'can_pay', h.can_pay,
                               'you', h.id in (select x.id from portal._grants(s, p_org) x))
                               order by (h.id in (select x.id from portal._grants(s, p_org) x)) desc, h.display_name)
                               from pm.portal_grants h where h.org_id = p_org and h.location_id = gc.location_id and h.audience = 'customer'
                                and h.customer_id = gc.customer_id and h.status = 'active' and (h.expires_at is null or h.expires_at > now())
                                and p_job in (select portal._grant_jobs(h.id))), '[]'::jsonb),
      'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'status', r.status, 'created_at', r.created_at)
                              order by r.created_at desc)
                              from pm.portal_requests r where r.org_id = p_org and r.job_id = p_job and r.customer_id = gc.customer_id), '[]'::jsonb));
  end if;
  if gv.id is not null then
    out := out || jsonb_build_object(
      'assignments', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status,
                                 'start', coalesce(t.early_start, t.start_on, t.constraint_date), 'finish', coalesce(t.early_finish, t.due_on),
                                 'response', (select jsonb_build_object('response', r.response, 'proposed_start', r.proposed_start, 'resolution', r.resolution)
                                                from pm.portal_task_responses r where r.task_id = t.id and r.vendor_id = gv.vendor_id
                                               order by r.created_at desc limit 1))
                               order by coalesce(t.early_start, t.start_on, t.constraint_date) nulls last)
                               from pm.tasks t where t.org_id = p_org and t.job_id = p_job and t.assigned_vendor_id = gv.vendor_id and t.status <> 'CANCELLED'), '[]'::jsonb),
      'commitments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'number', c.number, 'title', c.title, 'type', c.commitment_type,
                                 'status', c.status, 'executed_on', c.executed_on,
                                 'amount_cents', (select coalesce(sum(cl.amount_cents), 0) from pm.commitment_lines cl where cl.commitment_id = c.id))
                               order by c.number)
                               from pm.commitments c where c.org_id = p_org and c.job_id = p_job and c.vendor_id = gv.vendor_id
                                and c.status in ('APPROVED','EXECUTED','CLOSED')), '[]'::jsonb),
      'punch', coalesce((select jsonb_agg(jsonb_build_object('id', pi.id, 'title', pi.title, 'area', pi.area, 'status', pi.status, 'due_on', pi.due_on)
                           order by pi.status, pi.due_on nulls last)
                           from pm.punch_items pi where pi.org_id = p_org and pi.job_id = p_job and pi.responsible_vendor_id = gv.vendor_id
                            and pi.status <> 'VOID'), '[]'::jsonb),
      'vendor_documents', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'kind', f.kind, 'updated_at', f.updated_at,
                                      'file_name', v.file_name) order by f.updated_at desc)
                                      from pm.doc_files f join pm.doc_versions v on v.id = f.current_version_id
                                     where f.org_id = p_org and f.job_id = p_job and f.status = 'active' and 'vendor' = any (f.portal_audiences)
                                       and (f.money_cap is null
                                         or (f.subject_table = 'commitments' and exists (select 1 from pm.commitments c where c.id = f.subject_id and c.vendor_id = gv.vendor_id))
                                         or (f.subject_table = 'compliance_docs' and exists (select 1 from pm.compliance_docs c where c.id = f.subject_id and c.vendor_id = gv.vendor_id)))), '[]'::jsonb));
  end if;
  if gl.id is not null or gc.id is not null then
    out := out || jsonb_build_object('draws', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.draw_number, 'period_end', d.period_end, 'status', d.status,
               'requested_cents', d.requested_cents, 'approved_cents', d.approved_cents, 'funded_cents', d.funded_cents, 'funded_on', d.funded_on,
               'lender', ds.lender_name) order by d.draw_number desc)
        from pm.draws d join pm.draw_schedules ds on ds.id = d.draw_schedule_id
       where d.org_id = p_org and d.job_id = p_job and d.status <> 'DRAFT' and d.status <> 'CANCELLED'
         and ((gl.id is not null and (gl.audience = 'investor' or ds.lender_customer_id = gl.customer_id))
           or (gc.id is not null and ds.lender_customer_id = gc.customer_id))), '[]'::jsonb));
  end if;
  return out;
end $$;

-- A lender's / payer's draw package: lines against the lender budget, inspector %, prior draws.
create or replace function portal.draw(p_session text, p_org uuid, p_draw uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; d pm.draws; ds pm.draw_schedules; g pm.portal_grants;
begin
  s := portal._session(p_session);
  select * into d from pm.draws x where x.id = p_draw and x.org_id = p_org;
  if d.id is null or d.status in ('DRAFT','CANCELLED') then raise exception 'PORTAL_FORBIDDEN: draw not found' using errcode = '42501'; end if;
  select * into ds from pm.draw_schedules x where x.id = d.draw_schedule_id;
  g := portal._job_grant(s, p_org, d.job_id, array['lender','investor','customer']);
  if g.id is null or not ((g.audience = 'lender' and ds.lender_customer_id = g.customer_id) or g.audience = 'investor'
                          or (g.audience = 'customer' and ds.lender_customer_id = g.customer_id)) then
    raise exception 'PORTAL_FORBIDDEN: draw not found' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'draw', jsonb_build_object('id', d.id, 'number', d.draw_number, 'period_end', d.period_end, 'status', d.status,
              'inspection_status', d.inspection_status, 'inspector_pct', d.inspector_pct_complete, 'inspected_on', d.inspected_on,
              'requested_cents', d.requested_cents, 'approved_cents', d.approved_cents, 'retainage_held_cents', d.retainage_held_cents,
              'funded_cents', d.funded_cents, 'funded_on', d.funded_on, 'submitted_at', d.submitted_at),
    'job', portal._job_brief(d.job_id),
    'loan', jsonb_build_object('lender', ds.lender_name, 'loan_number', ds.loan_number, 'commitment_cents', ds.loan_commitment_cents,
              'retainage_pct', ds.retainage_pct),
    'can_decide', g.role = 'approver' and g.audience in ('lender','customer') and d.status in ('SUBMITTED','INSPECTION'),
    'decided', portal._decided(p_org, 'draws', d.id, d.submitted_at),
    'verified', portal._verified(s, g),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_id', bl.id, 'line_no', bl.line_no, 'description', bl.description,
                         'category', bl.category, 'budget_cents', coalesce(bl.revised_cents, bl.original_cents),
                         'previous_cents', (select coalesce(sum(coalesce(pl.approved_cents, pl.requested_cents)), 0) from pm.draw_lines pl
                                              join pm.draws pd on pd.id = pl.draw_id
                                             where pl.draw_budget_line_id = bl.id and pd.draw_number < d.draw_number and pd.status in ('APPROVED','FUNDED')),
                         'this_period_cents', coalesce(dl.requested_cents, 0), 'approved_cents', dl.approved_cents,
                         'retainage_cents', coalesce(dl.retainage_held_cents, 0)) order by bl.sort, bl.line_no)
                         from pm.draw_budget_lines bl left join pm.draw_lines dl on dl.draw_budget_line_id = bl.id and dl.draw_id = d.id
                        where bl.draw_schedule_id = ds.id), '[]'::jsonb));
end $$;

-- Proposal / change order / selection detail for the decision screen (sell side only).
create or replace function portal.item(p_session text, p_org uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; v_job uuid; g pm.portal_grants; out jsonb; v_allow bigint;
begin
  s := portal._session(p_session);
  v_job := case p_kind
    when 'estimate' then (select x.job_id from pm.estimates x where x.id = p_id and x.org_id = p_org and x.status in ('SENT','ACCEPTED','DECLINED'))
    when 'change_order' then (select x.job_id from pm.change_orders x where x.id = p_id and x.org_id = p_org and x.stage in ('COR','APPROVED','REJECTED'))
    when 'selection' then (select x.job_id from pm.selections x where x.id = p_id and x.org_id = p_org and x.status in ('PROPOSED','APPROVED','REJECTED'))
    when 'commitment' then (select x.job_id from pm.commitments x where x.id = p_id and x.org_id = p_org and x.status in ('APPROVED','EXECUTED','CLOSED'))
  end;
  if v_job is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  g := portal._job_grant(s, p_org, v_job, case when p_kind = 'commitment' then array['vendor'] else array['customer'] end);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  if p_kind = 'estimate' then
    select jsonb_build_object('kind', 'estimate', 'id', e.id, 'title', e.title, 'number', e.number, 'status', e.status,
             'valid_until', e.valid_until, 'total_cents', e.total_cents, 'retainage_pct', e.retainage_pct,
             'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'qty', l.qty, 'uom', l.uom,
                                  'unit_price_cents', l.unit_price_cents, 'amount_cents', l.amount_cents, 'allowance', l.is_allowance) order by l.sort, l.line_no)
                                  from pm.estimate_lines l where l.estimate_id = e.id), '[]'::jsonb),
             'decided', portal._decided(p_org, 'estimates', e.id, e.sent_at),
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'estimates', e.id)))
      into out from pm.estimates e where e.id = p_id
       and (e.customer_id is null or e.customer_id = g.customer_id);
  elsif p_kind = 'change_order' then
    select jsonb_build_object('kind', 'change_order', 'id', c.id, 'title', c.title, 'number', c.number, 'status', c.stage,
             'description', c.description, 'amount_cents', c.amount_cents, 'schedule_days', c.schedule_days,
             'decided', portal._decided(p_org, 'change_orders', c.id, c.updated_at),
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'change_orders', c.id)))
      into out from pm.change_orders c where c.id = p_id
       and portal._co_customer(c.id) = g.customer_id;
  elsif p_kind = 'selection' then
    select coalesce(x.allowance_cents, case when jsonb_typeof(x.ext -> 'allowance_cents') = 'number' then (x.ext ->> 'allowance_cents')::bigint end)
      into v_allow from pm.selections x where x.id = p_id;
    select jsonb_build_object('kind', 'selection', 'id', se.id, 'title', se.title, 'category', se.category, 'description', se.description,
             'status', se.status, 'due_on', se.due_on, 'allowance_cents', v_allow, 'chosen_option_id', se.chosen_option_id,
             'chosen_total_cents', se.chosen_total_cents,
             'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'description', o.description,
                                    'qty', o.qty, 'uom', o.uom, 'amount_cents', o.amount_cents, 'recommended', o.is_recommended,
                                    'lead_time_days', o.lead_time_days, 'delta_cents', case when v_allow is not null then o.amount_cents - v_allow end)
                                    order by o.sort, o.amount_cents)
                                    from pm.selection_options o where o.selection_id = se.id), '[]'::jsonb))
      into out from pm.selections se where se.id = p_id;
  else
    select jsonb_build_object('kind', 'commitment', 'id', c.id, 'title', c.title, 'number', c.number, 'type', c.commitment_type,
             'status', c.status, 'executed_on', c.executed_on, 'retainage_pct', c.retainage_pct, 'description', c.description,
             'payment_hold', c.payment_hold,
             'lines', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'line_no', cl.line_no, 'description', cl.description,
                                  'qty', cl.qty, 'uom', cl.uom, 'amount_cents', cl.amount_cents,
                                  'billed_cents', cl.billed_cents + coalesce((select sum(pl.this_period_cents) from pm.portal_pay_app_lines pl
                                       join pm.portal_pay_apps pa on pa.id = pl.pay_app_id
                                      where pl.commitment_line_id = cl.id and pa.status = 'submitted'), 0)) order by cl.line_no)
                                  from pm.commitment_lines cl where cl.commitment_id = c.id), '[]'::jsonb),
             'pay_apps', coalesce((select jsonb_agg(jsonb_build_object('id', pa.id, 'application_no', pa.application_no, 'period_end', pa.period_end,
                                     'gross_cents', pa.gross_cents, 'retainage_cents', pa.retainage_cents, 'net_cents', pa.net_cents,
                                     'status', pa.status, 'submitted_at', pa.submitted_at, 'decision_note', pa.decision_note) order by pa.application_no desc)
                                     from pm.portal_pay_apps pa where pa.commitment_id = c.id and pa.vendor_id = g.vendor_id), '[]'::jsonb),
             'decided', portal._decided(p_org, 'commitments', c.id, c.approved_at),
             'signer_id', portal._my_signer(s, portal._open_envelope(p_org, 'commitments', c.id)))
      into out from pm.commitments c where c.id = p_id and c.vendor_id = g.vendor_id;
  end if;
  if out is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  return out || jsonb_build_object('job', portal._job_brief(v_job), 'can_act', g.role = 'approver', 'can_sign', g.can_sign,
                                   'verified', portal._verified(s, g));
end $$;

-- Invoices and payments read from Books (pay token only where this person may pay and Books can take it).
create or replace function portal.invoices(p_session text, p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions;
begin
  s := portal._session(p_session);
  if not exists (select 1 from portal._grants(s, p_org) g where g.audience = 'customer') then
    raise exception 'PORTAL_FORBIDDEN: no customer access at this company' using errcode = '42501';
  end if;
  return jsonb_build_object('invoices', coalesce((
    select jsonb_agg(x.v order by x.d desc) from (
      select distinct on (i.id) jsonb_build_object('id', i.id, 'number', i.invoice_number, 'date', i.invoice_date, 'due_date', i.due_date,
               'status', i.status, 'total_cents', i.total_cents, 'paid_cents', i.amount_paid_cents, 'balance_cents', i.balance_cents,
               'retainage_cents', i.retainage_cents, 'job', case when i.job_id is not null then portal._job_brief(i.job_id) end,
               'company', (select l.name from core.locations l where l.id = i.location_id),
               'pay_token', case when g.can_pay and i.status in ('SENT','PARTIALLY_PAID','OVERDUE') and i.balance_cents > 0 then i.public_token end,
               'view_token', case when g.can_pay then i.public_token end,
               'payments', coalesce((select jsonb_agg(jsonb_build_object('date', cp.payment_date, 'amount_cents', pa.amount_cents, 'method', cp.payment_method)
                                       order by cp.payment_date)
                                       from public.payment_applications pa join public.customer_payments cp on cp.id = pa.payment_id
                                      where pa.invoice_id = i.id), '[]'::jsonb)) as v, i.invoice_date as d
        from portal._grants(s, p_org) g
        join public.invoices i on i.org_id = p_org and i.customer_id = g.customer_id and i.location_id = g.location_id
       where g.audience = 'customer' and i.status not in ('DRAFT','VOIDED')
         and (i.job_id in (select portal._grant_jobs(g.id)) or (g.all_jobs and i.job_id is null))
       order by i.id, g.can_pay desc) x), '[]'::jsonb));
end $$;

-- A sub's money and paperwork at this company: bills and payments from Books AP, retainage, compliance.
create or replace function portal.vendor(p_session text, p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions;
begin
  s := portal._session(p_session);
  if not exists (select 1 from portal._grants(s, p_org) g where g.audience = 'vendor') then
    raise exception 'PORTAL_FORBIDDEN: no sub / vendor access at this company' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'bills', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'number', b.bill_number, 'date', b.bill_date, 'due_date', b.due_date,
               'status', b.status, 'total_cents', b.total_cents, 'paid_cents', b.amount_paid_cents, 'balance_cents', b.balance_cents,
               'retainage_cents', coalesce(b.retainage_cents, 0), 'scheduled_on', b.scheduled_payment_date, 'paid_at', b.paid_at,
               'on_hold', b.status = 'ON_HOLD', 'company', (select l.name from core.locations l where l.id = b.location_id),
               'payments', coalesce((select jsonb_agg(jsonb_build_object('date', bp.payment_date, 'amount_cents', bp.amount_cents, 'method', bp.method)
                                       order by bp.payment_date) from public.bill_payments bp where bp.bill_id = b.id and bp.status = 'POSTED'), '[]'::jsonb))
               order by b.bill_date desc)
        from public.bills b
       where b.org_id = p_org and b.status <> 'VOIDED'
         and exists (select 1 from portal._grants(s, p_org) g where g.audience = 'vendor' and g.vendor_id = b.vendor_id and g.location_id = b.location_id)), '[]'::jsonb),
    'requirements', coalesce((select jsonb_agg(distinct jsonb_build_object('name', r.name, 'w9', r.w9_required, 'coi', r.coi_required,
               'min_gl_each_occurrence_cents', r.min_gl_each_occurrence_cents, 'min_gl_aggregate_cents', r.min_gl_aggregate_cents,
               'wc', r.wc_required, 'additional_insured', r.require_additional_insured, 'certificate_holder', r.certificate_holder_name,
               'blocks_payment', r.block_payment))
        from public.vendor_requirements r
       where r.org_id = p_org and r.is_active
         and exists (select 1 from portal._grants(s, p_org) g where g.audience = 'vendor' and (r.location_id is null or r.location_id = g.location_id))), '[]'::jsonb),
    'submissions', coalesce((select jsonb_agg(jsonb_build_object('id', vs.id, 'kind', vs.doc_kind, 'status', vs.status,
               'received_at', vs.created_at, 'decision_reason', case when vs.status = 'rejected' then vs.decision_reason end) order by vs.created_at desc)
        from public.vendor_document_submissions vs
       where vs.org_id = p_org and vs.vendor_id in (select g.vendor_id from portal._grants(s, p_org) g where g.audience = 'vendor')), '[]'::jsonb),
    'coverages', coalesce((select jsonb_agg(jsonb_build_object('type', c.coverage_type, 'carrier', c.carrier, 'expires', c.expiration_date) order by c.expiration_date)
        from public.vendor_coverages c
       where c.org_id = p_org and c.is_active and c.vendor_id in (select g.vendor_id from portal._grants(s, p_org) g where g.audience = 'vendor')), '[]'::jsonb),
    'job_compliance', coalesce((select jsonb_agg(jsonb_build_object('id', cd.id, 'type', cd.doc_type, 'status', cd.status, 'expires_on', cd.expires_on,
               'amount_cents', cd.amount_cents, 'job', portal._job_brief(cd.job_id)) order by cd.status, cd.expires_on nulls last)
        from pm.compliance_docs cd
       where cd.org_id = p_org and exists (select 1 from portal._grants(s, p_org) g
                                            where g.audience = 'vendor' and g.vendor_id = cd.vendor_id and cd.job_id in (select portal._grant_jobs(g.id)))), '[]'::jsonb),
    'lookahead', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'job', portal._job_brief(t.job_id), 'status', t.status,
               'start', coalesce(t.early_start, t.start_on, t.constraint_date), 'finish', coalesce(t.early_finish, t.due_on),
               'response', (select jsonb_build_object('response', r.response, 'proposed_start', r.proposed_start, 'resolution', r.resolution)
                              from pm.portal_task_responses r where r.task_id = t.id and r.vendor_id = t.assigned_vendor_id order by r.created_at desc limit 1))
               order by coalesce(t.early_start, t.start_on, t.constraint_date) nulls last)
        from pm.tasks t
       where t.org_id = p_org and t.status in ('TODO','IN_PROGRESS','BLOCKED')
         and coalesce(t.early_start, t.start_on, t.constraint_date, current_date) <= current_date + 42
         and exists (select 1 from portal._grants(s, p_org) g
                      where g.audience = 'vendor' and g.vendor_id = t.assigned_vendor_id and t.job_id in (select portal._grant_jobs(g.id)))), '[]'::jsonb));
end $$;

-- A job thread for one audience (customer threads are per customer, vendor threads per vendor).
create or replace function portal.messages(p_session text, p_org uuid, p_job uuid, p_audience text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g pm.portal_grants;
begin
  s := portal._session(p_session);
  g := portal._job_grant(s, p_org, p_job, array[p_audience]);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no access to this conversation' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author_name, 'mine', m.grant_id in (select x.id from portal._grants(s, p_org) x),
                     'from_team', m.author_kind = 'staff', 'body', m.body, 'at', m.created_at, 'files', cardinality(m.document_ids)) order by m.created_at)
                     from (select * from pm.portal_messages x where x.org_id = p_org and x.job_id = p_job and x.audience = g.audience
                             and x.party_id is not distinct from coalesce(g.customer_id, g.vendor_id) order by x.created_at desc limit 200) m), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- 9. Public portal: actions
-- ----------------------------------------------------------------------------
-- Approve / decline an estimate, change order or draw (recorded as the client's decision; staff run
-- the money step), or choose / decline a selection (applied here exactly like pm.approve_selection).
-- Needs the approver role and a verified person (portal._verified). p_lines (draws only):
-- [{line_id, approved_cents}] partial approvals, kept in the snapshot.
create or replace function portal.decide(p_session text, p_org uuid, p_kind text, p_id uuid, p_decision text,
                                         p_typed_name text, p_option uuid default null, p_comment text default null,
                                         p_lines jsonb default null, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  s pm.portal_sessions; g pm.portal_grants; v_ver text; v_job uuid; v_table text; v_amount bigint; v_snapshot jsonb := '{}';
  v_appr uuid; v_title text; se pm.selections; o pm.selection_options; v_allow bigint; v_var bigint; v_loc uuid; d pm.draws; ds pm.draw_schedules;
  v_dec text := upper(p_decision);
begin
  s := portal._session(p_session);
  if p_decision not in ('approved','declined') then raise exception 'PORTAL_INVALID: approve or decline' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_typed_name, ''))) not between 2 and 200 then
    raise exception 'PORTAL_INVALID: type your full name' using errcode = '22023';
  end if;
  if p_decision = 'declined' and char_length(btrim(coalesce(p_comment, ''))) < 2 then
    raise exception 'PORTAL_INVALID: tell them why you are declining' using errcode = '22023';
  end if;
  v_table := case p_kind when 'estimate' then 'estimates' when 'change_order' then 'change_orders' when 'selection' then 'selections'
                         when 'draw' then 'draws' end;
  if v_table is null then raise exception 'PORTAL_INVALID: unknown item' using errcode = '22023'; end if;

  if p_kind = 'estimate' then
    select x.job_id, x.total_cents, x.title, jsonb_build_object('number', x.number, 'version', x.version, 'title', x.title, 'total_cents', x.total_cents)
      into v_job, v_amount, v_title, v_snapshot from pm.estimates x where x.id = p_id and x.org_id = p_org and x.status = 'SENT';
  elsif p_kind = 'change_order' then
    select x.job_id, x.amount_cents, x.title, jsonb_build_object('number', x.number, 'title', x.title, 'amount_cents', x.amount_cents, 'schedule_days', x.schedule_days)
      into v_job, v_amount, v_title, v_snapshot from pm.change_orders x where x.id = p_id and x.org_id = p_org and x.stage = 'COR';
  elsif p_kind = 'selection' then
    select * into se from pm.selections x where x.id = p_id and x.org_id = p_org and x.status = 'PROPOSED' for update;
    v_job := se.job_id; v_title := se.category || ': ' || se.title;
  else
    select * into d from pm.draws x where x.id = p_id and x.org_id = p_org and x.status in ('SUBMITTED','INSPECTION');
    v_job := d.job_id; v_amount := d.requested_cents; v_title := format('Draw %s', d.draw_number);
    v_snapshot := jsonb_build_object('draw_number', d.draw_number, 'requested_cents', d.requested_cents, 'period_end', d.period_end);
  end if;
  if v_job is null then raise exception 'PORTAL_INVALID: this is no longer waiting on you' using errcode = '22023'; end if;
  g := portal._job_grant(s, p_org, v_job, case when p_kind = 'draw' then array['lender','customer'] else array['customer'] end);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  if g.role <> 'approver' then raise exception 'PORTAL_FORBIDDEN: you can view this, but someone else in your household approves it' using errcode = '42501'; end if;
  v_ver := portal._verified(s, g);
  if v_ver is null then raise exception 'PORTAL_VERIFY: confirm your phone number first' using errcode = '28000'; end if;
  if p_kind = 'estimate' and not exists (select 1 from pm.estimates x where x.id = p_id and (x.customer_id is null or x.customer_id = g.customer_id)) then
    raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501';
  end if;
  if p_kind = 'change_order' and portal._co_customer(p_id) is distinct from g.customer_id then
    raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501';
  end if;
  if p_kind = 'draw' then
    select * into ds from pm.draw_schedules x where x.id = d.draw_schedule_id;
    if ds.lender_customer_id is distinct from g.customer_id then
      raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501';
    end if;
    if p_lines is not null then
      if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200 then raise exception 'PORTAL_INVALID: lines' using errcode = '22023'; end if;
      -- security review: each draw line at most once
      if (select count(*) from jsonb_array_elements(p_lines)) <> (select count(distinct l ->> 'line_id') from jsonb_array_elements(p_lines) l) then
        raise exception 'PORTAL_INVALID: each draw line can be approved once' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(p_lines) l
                  where jsonb_typeof(l -> 'approved_cents') <> 'number' or (l ->> 'approved_cents')::bigint < 0
                     or not exists (select 1 from pm.draw_lines dl where dl.draw_id = d.id
                                     and dl.draw_budget_line_id = pm.access_try_uuid(l ->> 'line_id')
                                     and (l ->> 'approved_cents')::bigint <= dl.requested_cents)) then
        raise exception 'PORTAL_INVALID: an approved line amount is not on this draw or exceeds what was requested' using errcode = '22023';
      end if;
      v_amount := (select sum((l ->> 'approved_cents')::bigint) from jsonb_array_elements(p_lines) l)
                + coalesce((select sum(dl.requested_cents) from pm.draw_lines dl where dl.draw_id = d.id
                             and dl.draw_budget_line_id not in (select pm.access_try_uuid(l ->> 'line_id') from jsonb_array_elements(p_lines) l)), 0);
      if v_amount > coalesce(d.requested_cents, (select sum(dl.requested_cents) from pm.draw_lines dl where dl.draw_id = d.id), 0) then
        raise exception 'PORTAL_INVALID: the approved total exceeds what was requested' using errcode = '22023';
      end if;
      v_snapshot := v_snapshot || jsonb_build_object('lines', p_lines, 'approved_cents', v_amount);
    end if;
  end if;
  -- one answer per sending: since the estimate was sent / the change order last changed / the draw was submitted
  if p_kind <> 'selection' and portal._decided(p_org, v_table, p_id, case p_kind
       when 'estimate' then (select x.sent_at from pm.estimates x where x.id = p_id)
       when 'change_order' then (select x.updated_at from pm.change_orders x where x.id = p_id)
       else d.submitted_at end) is not null then
    raise exception 'PORTAL_INVALID: your answer was already sent' using errcode = '22023';
  end if;

  if p_kind = 'selection' then
    if p_decision = 'approved' then
      if p_option is not null then
        select * into o from pm.selection_options x where x.selection_id = se.id and x.id = p_option;
      elsif (select count(*) from pm.selection_options x where x.selection_id = se.id) = 1 then
        select * into o from pm.selection_options x where x.selection_id = se.id;
      end if;
      if o.id is null then raise exception 'PORTAL_INVALID: choose one of the options' using errcode = '22023'; end if;
      v_amount := o.amount_cents;
      v_allow := coalesce(se.allowance_cents, case when jsonb_typeof(se.ext -> 'allowance_cents') = 'number' then (se.ext ->> 'allowance_cents')::bigint end);
      v_var := case when v_allow is not null then v_amount - v_allow end;
      v_snapshot := jsonb_build_object('option_id', o.id, 'label', o.label, 'qty', o.qty, 'uom', o.uom, 'unit_price_cents', o.unit_price_cents,
                                       'amount_cents', o.amount_cents, 'category', se.category, 'title', se.title,
                                       'allowance_cents', v_allow, 'variance_cents', v_var, 'due_on', se.due_on);
    else
      v_snapshot := jsonb_build_object('category', se.category, 'title', se.title);
    end if;
  end if;

  insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, approver_email, approver_customer_id,
                                   method, amount_cents, snapshot, comment, recorded_by)
  values (p_org, v_job, v_table, p_id, v_dec, btrim(p_typed_name), coalesce(s.verified_email, g.email),
          g.customer_id, 'PORTAL', v_amount, v_snapshot || jsonb_build_object('portal_grant_id', g.id, 'verified_by', v_ver),
          left(nullif(btrim(p_comment), ''), 2000), 'portal:' || s.person_id::text)
  returning id into v_appr;

  select j.location_id into v_loc from core.jobs j where j.id = v_job;
  if p_kind = 'selection' then
    if p_decision = 'approved' then
      update pm.selections set status = 'APPROVED', chosen_option_id = o.id, chosen_total_cents = v_amount, allowance_applied_cents = v_allow,
             variance_cents = v_var, approved_at = now(), approved_by_name = btrim(p_typed_name), client_approval_id = v_appr,
             proposed_at = coalesce(proposed_at, now())
       where id = se.id;
    else
      update pm.selections set status = 'REJECTED', rejected_at = now() where id = se.id;
    end if;
    perform pm.log_activity(p_org, v_loc, v_job, 'selection.' || case when p_decision = 'approved' then 'approved' else 'rejected' end, 'selections', se.id,
      format('%s %s %s in the portal', btrim(p_typed_name), case when p_decision = 'approved' then 'chose' else 'declined' end, v_title),
      jsonb_build_object('client_approval_id', v_appr, 'method', 'PORTAL', 'on_time', se.due_on is null or current_date <= se.due_on), 'HUMAN');
  end if;

  perform portal._log(p_org, v_loc, v_job, g, p_decision, v_table, p_id,
    jsonb_build_object('client_approval_id', v_appr, 'kind', p_kind, 'option_id', o.id, 'typed_name', btrim(p_typed_name)), v_ver, p_ip, p_user_agent);
  perform portal._notify_team(p_org, v_job,
    format('%s %s %s in the portal', g.display_name, p_decision, v_title),
    case p_kind when 'estimate' then '/estimates/' || p_id when 'change_order' then '/change-orders/' || p_id
                when 'selection' then '/selections/' || p_id else '/draws/' || p_id end,
    'portal:' || v_table || ':' || p_id::text || ':' || p_decision);
  return jsonb_build_object('ok', true, 'client_approval_id', v_appr, 'decision', p_decision);
end $$;

-- A one-time e-sign link for the person's own signer slot (pm.esign_tokens, like pm.esign_issue_token).
-- The app generates the token and passes only its sha-256, then redirects to /sign/<token>.
create or replace function portal.esign_link(p_session text, p_org uuid, p_signer uuid, p_token_hash text,
                                             p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; sg pm.esign_signers; e pm.esign_envelopes; g pm.portal_grants; v_ver text; v_exp timestamptz;
begin
  s := portal._session(p_session);
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PORTAL_INVALID: bad token' using errcode = '22023'; end if;
  select * into sg from pm.esign_signers x where x.id = p_signer and x.org_id = p_org for update;
  select * into e from pm.esign_envelopes x where x.id = sg.envelope_id;
  if sg.id is null or e.job_id is null or portal._my_signer(s, e.id) is distinct from sg.id then
    raise exception 'PORTAL_FORBIDDEN: this signature is not waiting on you' using errcode = '42501';
  end if;
  g := portal._job_grant(s, p_org, e.job_id, array['customer','vendor','lender']);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no access to this job' using errcode = '42501'; end if;
  if not g.can_sign then raise exception 'PORTAL_FORBIDDEN: you can view this, but another person signs it' using errcode = '42501'; end if;
  v_ver := portal._verified(s, g);
  if v_ver is null then raise exception 'PORTAL_VERIFY: confirm your phone number first' using errcode = '28000'; end if;
  v_exp := least(e.expires_at, now() + interval '1 hour');
  update pm.esign_tokens set revoked_at = now() where signer_id = sg.id and revoked_at is null and used_at is null;
  insert into pm.esign_tokens (org_id, envelope_id, signer_id, token_hash, expires_at, issued_by)
  values (sg.org_id, e.id, sg.id, p_token_hash, v_exp, 'portal:' || s.person_id::text);
  update pm.esign_signers set status = case when status = 'pending_send' then 'sent' else status end, sent_at = coalesce(sent_at, now()) where id = sg.id;
  perform pm._esign_event(e.id, sg.id, 'delivered', p_ip, p_user_agent, jsonb_build_object('via', 'portal', 'verified_by', v_ver, 'expires_at', v_exp));
  perform portal._log(p_org, e.location_id, e.job_id, g, 'esign.opened', 'esign_envelopes', e.id, jsonb_build_object('signer_id', sg.id), v_ver, p_ip, p_user_agent);
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end $$;

create or replace function portal.post_message(p_session text, p_org uuid, p_job uuid, p_audience text, p_body text,
                                               p_documents uuid[] default '{}') returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g pm.portal_grants; v_id uuid; j record;
begin
  s := portal._session(p_session);
  g := portal._job_grant(s, p_org, p_job, array[p_audience]);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no access to this conversation' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'PORTAL_INVALID: write a message (up to 4,000 characters)' using errcode = '22023'; end if;
  if not portal._hit('msg:' || s.person_id::text, 'hour', 30) then raise exception 'PORTAL_RATE: too many messages; try again later' using errcode = '54000'; end if;
  if exists (select 1 from unnest(coalesce(p_documents, '{}'::uuid[])) d
              where not exists (select 1 from pm.portal_uploads u where u.document_id = d and u.session_id = s.id and u.org_id = p_org)) then
    raise exception 'PORTAL_INVALID: attach only files you uploaded' using errcode = '22023';
  end if;
  select x.location_id, x.name, x.customer_id into j from core.jobs x where x.id = p_job;
  insert into pm.portal_messages (org_id, job_id, audience, party_id, grant_id, author_kind, author_name, body, document_ids)
  values (p_org, p_job, g.audience, coalesce(g.customer_id, g.vendor_id), g.id, 'portal', g.display_name, btrim(p_body), coalesce(p_documents, '{}'))
  returning id into v_id;
  if g.audience = 'customer' then
    insert into crm.activities (org_id, location_id, customer_id, contact_id, job_id, kind, direction, subject, body, created_by)
    values (p_org, j.location_id, g.customer_id, g.contact_id, p_job, 'portal_message', 'inbound', left('Portal message from ' || g.display_name, 300),
            btrim(p_body), 'portal:' || s.person_id::text);
  end if;
  perform portal._log(p_org, j.location_id, p_job, g, 'message.posted', 'portal_messages', v_id, '{}'::jsonb, null, null, null);
  perform portal._notify_team(p_org, p_job, format('%s sent a message on %s', g.display_name, j.name), '/jobs/' || p_job::text, 'portal:msg:' || v_id::text);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function portal.service_request(p_session text, p_org uuid, p_job uuid, p_kind text, p_title text, p_description text,
                                                  p_window text default null, p_documents uuid[] default '{}') returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g pm.portal_grants; v_id uuid; v_loc uuid;
begin
  s := portal._session(p_session);
  g := portal._job_grant(s, p_org, p_job, array['customer']);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no access to this job' using errcode = '42501'; end if;
  if p_kind not in ('warranty','service') then raise exception 'PORTAL_INVALID: warranty or service' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 2 and 200 then raise exception 'PORTAL_INVALID: say what needs attention' using errcode = '22023'; end if;
  if not portal._hit('req:' || s.person_id::text, 'day', 10) then raise exception 'PORTAL_RATE: too many requests today' using errcode = '54000'; end if;
  if exists (select 1 from unnest(coalesce(p_documents, '{}'::uuid[])) d
              where not exists (select 1 from pm.portal_uploads u where u.document_id = d and u.session_id = s.id and u.org_id = p_org)) then
    raise exception 'PORTAL_INVALID: attach only photos you uploaded' using errcode = '22023';
  end if;
  select j.location_id into v_loc from core.jobs j where j.id = p_job;
  insert into pm.portal_requests (org_id, location_id, job_id, grant_id, customer_id, kind, title, description, preferred_window, document_ids)
  values (p_org, v_loc, p_job, g.id, g.customer_id, p_kind, btrim(p_title), left(nullif(btrim(p_description), ''), 4000),
          left(nullif(btrim(p_window), ''), 200), coalesce(p_documents, '{}'))
  returning id into v_id;
  -- photos become job documents the team can see (Projects-only seats read them through the link)
  insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role, created_by)
  select p_org, d, p_job, 'projects', p_job, 'portal_' || p_kind, 'portal:' || s.person_id::text from unnest(coalesce(p_documents, '{}'::uuid[])) d
  on conflict do nothing;
  perform portal._log(p_org, v_loc, p_job, g, 'request.' || p_kind, 'portal_requests', v_id, jsonb_build_object('title', btrim(p_title)), null, null, null);
  perform portal._notify_team(p_org, p_job, format('%s requested %s: %s', g.display_name, p_kind, btrim(p_title)), '/warranty', 'portal:req:' || v_id::text);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Sub: confirm / decline / propose a new start on an assignment.
create or replace function portal.task_respond(p_session text, p_org uuid, p_task uuid, p_response text, p_proposed_start date default null,
                                               p_note text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; t pm.tasks; g pm.portal_grants; v_id uuid;
begin
  s := portal._session(p_session);
  select * into t from pm.tasks x where x.id = p_task and x.org_id = p_org;
  if t.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  select x.* into g from portal._grants(s, p_org) x
   where x.audience = 'vendor' and x.vendor_id = t.assigned_vendor_id and t.job_id in (select portal._grant_jobs(x.id)) limit 1;
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: this work is not assigned to you' using errcode = '42501'; end if;
  if p_response not in ('confirmed','declined','proposed') then raise exception 'PORTAL_INVALID: confirm, decline or propose a date' using errcode = '22023'; end if;
  if p_response = 'proposed' and (p_proposed_start is null or p_proposed_start < current_date) then
    raise exception 'PORTAL_INVALID: propose a start date from today on' using errcode = '22023';
  end if;
  if p_response = 'declined' and char_length(btrim(coalesce(p_note, ''))) < 2 then
    raise exception 'PORTAL_INVALID: tell them why you cannot make it' using errcode = '22023';
  end if;
  insert into pm.portal_task_responses (org_id, job_id, task_id, grant_id, vendor_id, response, proposed_start, note, resolution, resolved_at, resolved_by)
  values (p_org, t.job_id, t.id, g.id, g.vendor_id, p_response, case when p_response = 'proposed' then p_proposed_start end,
          left(nullif(btrim(p_note), ''), 2000),
          case when p_response = 'confirmed' then 'noted' end, case when p_response = 'confirmed' then now() end,
          case when p_response = 'confirmed' then 'portal' end)
  returning id into v_id;
  perform portal._log(p_org, null, t.job_id, g, 'assignment.' || p_response, 'tasks', t.id,
                      jsonb_build_object('proposed_start', p_proposed_start), null, null, null);
  if p_response <> 'confirmed' then
    perform portal._notify_team(p_org, t.job_id, format('%s %s "%s"%s', g.display_name,
      case when p_response = 'declined' then 'declined' else 'proposed a new date for' end, t.title,
      case when p_response = 'proposed' then ' (' || to_char(p_proposed_start, 'Mon DD') || ')' else '' end),
      '/schedule', 'portal:task:' || v_id::text);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Sub: accept a PO / subcontract (when there is no envelope to sign). Recorded for the PM.
create or replace function portal.accept_commitment(p_session text, p_org uuid, p_commitment uuid, p_typed_name text,
                                                    p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; c pm.commitments; g pm.portal_grants; v_ver text;
begin
  s := portal._session(p_session);
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = p_org and x.status = 'APPROVED';
  if c.id is null then raise exception 'PORTAL_INVALID: this is no longer waiting on you' using errcode = '22023'; end if;
  g := portal._job_grant(s, p_org, c.job_id, array['vendor']);
  if g.id is null or g.vendor_id is distinct from c.vendor_id then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  if g.role <> 'approver' then raise exception 'PORTAL_FORBIDDEN: another person at your company accepts contracts' using errcode = '42501'; end if;
  v_ver := portal._verified(s, g);
  if v_ver is null then raise exception 'PORTAL_VERIFY: confirm your phone number first' using errcode = '28000'; end if;
  if char_length(btrim(coalesce(p_typed_name, ''))) not between 2 and 200 then raise exception 'PORTAL_INVALID: type your full name' using errcode = '22023'; end if;
  if portal._decided(p_org, 'commitments', c.id, c.approved_at) is not null then raise exception 'PORTAL_INVALID: already accepted' using errcode = '22023'; end if;
  perform portal._log(p_org, c.location_id, c.job_id, g, 'accepted', 'commitments', c.id,
    jsonb_build_object('number', c.number, 'version', c.version, 'typed_name', btrim(p_typed_name)), v_ver, p_ip, p_user_agent);
  perform portal._notify_team(p_org, c.job_id, format('%s accepted %s', g.display_name, c.number), '/commitments/' || c.id::text, 'portal:commit:' || c.id::text);
  return jsonb_build_object('ok', true);
end $$;

-- Sub: punch item done → ready for review (with optional photos).
create or replace function portal.punch_ready(p_session text, p_org uuid, p_item uuid, p_note text default null, p_documents uuid[] default '{}')
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; pi pm.punch_items; g pm.portal_grants;
begin
  s := portal._session(p_session);
  select * into pi from pm.punch_items x where x.id = p_item and x.org_id = p_org for update;
  if pi.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  select x.* into g from portal._grants(s, p_org) x
   where x.audience = 'vendor' and x.vendor_id = pi.responsible_vendor_id and pi.job_id in (select portal._grant_jobs(x.id)) limit 1;
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: this item is not assigned to you' using errcode = '42501'; end if;
  if pi.status not in ('OPEN','IN_PROGRESS') then raise exception 'PORTAL_INVALID: this item is %', lower(pi.status) using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_documents, '{}'::uuid[])) d
              where not exists (select 1 from pm.portal_uploads u where u.document_id = d and u.session_id = s.id and u.org_id = p_org)) then
    raise exception 'PORTAL_INVALID: attach only photos you uploaded' using errcode = '22023';
  end if;
  update pm.punch_items set status = 'READY_FOR_REVIEW', updated_at = now(),
         ext = ext || jsonb_build_object('portal_note', left(nullif(btrim(p_note), ''), 1000), 'portal_ready_at', now())
   where id = pi.id;
  insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role, created_by)
  select p_org, d, pi.job_id, 'punch_items', pi.id, 'portal_photo', 'portal:' || s.person_id::text from unnest(coalesce(p_documents, '{}'::uuid[])) d
  on conflict do nothing;
  perform portal._log(p_org, null, pi.job_id, g, 'punch.ready', 'punch_items', pi.id, '{}'::jsonb, null, null, null);
  perform portal._notify_team(p_org, pi.job_id, format('%s finished punch item "%s"', g.display_name, pi.title), '/punch-list', 'portal:punch:' || pi.id::text);
  return jsonb_build_object('ok', true);
end $$;

-- Sub compliance upload. W-9 / COI → Books' review queue (public.vendor_document_submissions, 180);
-- a job compliance doc (lien waiver, certified payroll, job COI) → pm.compliance_docs RECEIVED.
create or replace function portal.compliance_submit(p_session text, p_org uuid, p_kind text, p_document uuid,
                                                    p_compliance_doc uuid default null, p_expires_on date default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g pm.portal_grants; cd pm.compliance_docs; v_id uuid; u pm.portal_uploads;
begin
  s := portal._session(p_session);
  select * into u from pm.portal_uploads x where x.document_id = p_document and x.session_id = s.id and x.org_id = p_org and x.finished_at is not null;
  if u.id is null then raise exception 'PORTAL_INVALID: upload the file first' using errcode = '22023'; end if;
  if p_compliance_doc is not null then
    select * into cd from pm.compliance_docs x where x.id = p_compliance_doc and x.org_id = p_org for update;
    if cd.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
    select x.* into g from portal._grants(s, p_org) x
     where x.audience = 'vendor' and x.vendor_id = cd.vendor_id and cd.job_id in (select portal._grant_jobs(x.id)) limit 1;
    if g.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
    if cd.status = 'VERIFIED' then raise exception 'PORTAL_INVALID: this document is already verified' using errcode = '22023'; end if;
    update pm.compliance_docs set status = 'RECEIVED', document_id = p_document,
           expires_on = coalesce(p_expires_on, expires_on), notes = coalesce(notes || E'\n', '') || 'Uploaded in the portal by ' || g.display_name,
           updated_at = now()
     where id = cd.id;
    perform portal._log(p_org, null, cd.job_id, g, 'compliance.uploaded', 'compliance_docs', cd.id, jsonb_build_object('type', cd.doc_type), null, null, null);
    perform portal._notify_team(p_org, cd.job_id, format('%s uploaded %s', g.display_name, replace(lower(cd.doc_type), '_', ' ')), '/subcontractors', 'portal:cd:' || cd.id::text || ':' || p_document::text);
    return jsonb_build_object('ok', true, 'target', 'job', 'id', cd.id);
  end if;
  if p_kind not in ('W9','COI') then raise exception 'PORTAL_INVALID: W9 or COI (lien waivers go on their job request)' using errcode = '22023'; end if;
  select x.* into g from portal._grants(s, p_org) x where x.audience = 'vendor' and x.id = u.grant_id;
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no sub / vendor access' using errcode = '42501'; end if;
  if not portal._hit('compliance:' || g.vendor_id::text, 'day', 20) then raise exception 'PORTAL_RATE: too many uploads today' using errcode = '54000'; end if;
  update public.documents set doc_type = p_kind, entity_type = 'vendor', entity_id = g.vendor_id, updated_at = now() where id = p_document;
  insert into public.vendor_document_submissions (org_id, vendor_id, doc_kind, source, document_id, status, created_by)
  values (p_org, g.vendor_id, p_kind, 'portal_upload', p_document, 'received', 'portal:' || s.person_id::text)
  returning id into v_id;
  insert into public.vendor_compliance_events (org_id, vendor_id, event_type, detail, created_by_user, submission_id, meta)
  values (p_org, g.vendor_id, 'UPLOAD_RECEIVED', format('%s uploaded in the Projects portal by %s', p_kind, g.display_name),
          'portal:' || s.person_id::text, v_id, jsonb_build_object('source', 'projects_portal', 'grant_id', g.id));
  perform portal._log(p_org, g.location_id, null, g, 'compliance.uploaded', null, null, jsonb_build_object('type', p_kind, 'submission_id', v_id), null, null, null);
  return jsonb_build_object('ok', true, 'target', 'books', 'id', v_id);
end $$;

-- Sub pay application against the commitment's lines: % complete to date per line → this period;
-- retainage at the commitment's rate; never more than the line's open amount (billed in Books +
-- other pending portal pay apps).
create or replace function portal.submit_pay_app(p_session text, p_org uuid, p_commitment uuid, p_lines jsonb, p_period_end date,
                                                 p_invoice_no text default null, p_document uuid default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; c pm.commitments; g pm.portal_grants; l jsonb; cl pm.commitment_lines; v_id uuid; v_no int;
  v_pct numeric; v_to_date bigint; v_prior bigint; v_this bigint; v_ret bigint; v_gross bigint := 0; v_ret_total bigint := 0;
begin
  s := portal._session(p_session);
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = p_org and x.status in ('APPROVED','EXECUTED') for update;
  if c.id is null then raise exception 'PORTAL_INVALID: this contract is not open for billing' using errcode = '22023'; end if;
  g := portal._job_grant(s, p_org, c.job_id, array['vendor']);
  if g.id is null or g.vendor_id is distinct from c.vendor_id then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  if g.role <> 'approver' then raise exception 'PORTAL_FORBIDDEN: another person at your company bills this contract' using errcode = '42501'; end if;
  if p_period_end is null or p_period_end > current_date + 31 then raise exception 'PORTAL_INVALID: choose the billing period end' using errcode = '22023'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 500 then raise exception 'PORTAL_INVALID: add at least one line' using errcode = '22023'; end if;
  if p_document is not null and not exists (select 1 from pm.portal_uploads u where u.document_id = p_document and u.session_id = s.id and u.org_id = p_org) then
    raise exception 'PORTAL_INVALID: attach only files you uploaded' using errcode = '22023';
  end if;
  select coalesce(max(a.application_no), 0) + 1 into v_no from pm.portal_pay_apps a where a.commitment_id = c.id;
  insert into pm.portal_pay_apps (org_id, location_id, job_id, commitment_id, vendor_id, grant_id, application_no, vendor_invoice_no, period_end,
                                  gross_cents, retainage_cents, net_cents, document_id, note)
  values (p_org, c.location_id, c.job_id, c.id, c.vendor_id, g.id, v_no, left(nullif(btrim(p_invoice_no), ''), 60), p_period_end,
          1, 0, 1, p_document, left(nullif(btrim(p_note), ''), 2000))
  returning id into v_id;
  for l in select value from jsonb_array_elements(p_lines) loop
    select * into cl from pm.commitment_lines x where x.id = pm.access_try_uuid(l ->> 'line_id') and x.commitment_id = c.id;
    if cl.id is null then raise exception 'PORTAL_INVALID: a line is not on this contract' using errcode = '22023'; end if;
    if jsonb_typeof(l -> 'pct_complete') <> 'number' then raise exception 'PORTAL_INVALID: %% complete is a number' using errcode = '22023'; end if;
    v_pct := (l ->> 'pct_complete')::numeric;
    if v_pct < 0 or v_pct > 1 then raise exception 'PORTAL_INVALID: %% complete is between 0 and 100' using errcode = '22023'; end if;
    v_to_date := round(cl.amount_cents * v_pct)::bigint;
    v_prior := cl.billed_cents + coalesce((select sum(pl.this_period_cents) from pm.portal_pay_app_lines pl join pm.portal_pay_apps pa on pa.id = pl.pay_app_id
                                            where pl.commitment_line_id = cl.id and pa.status = 'submitted' and pa.id <> v_id), 0);
    v_this := v_to_date - v_prior;
    if v_this < 0 then raise exception 'PORTAL_INVALID: line % is already billed past that %%', cl.line_no using errcode = '22023'; end if;
    continue when v_this = 0;
    v_ret := round(v_this * c.retainage_pct)::bigint;
    insert into pm.portal_pay_app_lines (org_id, pay_app_id, commitment_line_id, pct_complete, this_period_cents, retainage_cents)
    values (p_org, v_id, cl.id, v_pct, v_this, v_ret);
    v_gross := v_gross + v_this; v_ret_total := v_ret_total + v_ret;
  end loop;
  if v_gross <= 0 then raise exception 'PORTAL_INVALID: nothing new to bill — raise the %% complete on at least one line' using errcode = '22023'; end if;
  update pm.portal_pay_apps set gross_cents = v_gross, retainage_cents = v_ret_total, net_cents = v_gross - v_ret_total where id = v_id;
  perform portal._log(p_org, c.location_id, c.job_id, g, 'pay_app.submitted', 'portal_pay_apps', v_id,
                      jsonb_build_object('application_no', v_no, 'commitment', c.number), null, null, null);
  perform portal._notify_team(p_org, c.job_id, format('%s submitted pay application #%s on %s', g.display_name, v_no, c.number),
                              '/commitments/' || c.id::text, 'portal:payapp:' || v_id::text);
  return jsonb_build_object('ok', true, 'id', v_id, 'application_no', v_no, 'gross_cents', v_gross, 'retainage_cents', v_ret_total,
                            'net_cents', v_gross - v_ret_total);
end $$;

-- ----------------------------------------------------------------------------
-- 10. Files: one-time upload slots and 2-minute read grants (the anon storage policies use these)
-- ----------------------------------------------------------------------------
create or replace function portal.upload_begin(p_session text, p_org uuid, p_purpose text, p_file_name text, p_mime text, p_size bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; g pm.portal_grants; v_path text; v_id uuid := gen_random_uuid(); v_ext text; v_name text;
begin
  s := portal._session(p_session);
  select x.* into g from portal._grants(s, p_org) x
   where p_purpose not in ('compliance','pay_app') or x.audience = 'vendor'
   order by (x.audience = 'vendor') desc, x.created_at limit 1;
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: no access for this upload at this company' using errcode = '42501'; end if;
  if p_purpose not in ('photo','compliance','pay_app','message','request') then raise exception 'PORTAL_INVALID: purpose' using errcode = '22023'; end if;
  if p_mime not in ('application/pdf','image/jpeg','image/png','image/webp','image/heic') then
    raise exception 'PORTAL_INVALID: upload a PDF or a photo (JPEG, PNG, WebP, HEIC)' using errcode = '22023';
  end if;
  if p_size is null or p_size < 1 or p_size > 26214400 then raise exception 'PORTAL_INVALID: files up to 25 MB' using errcode = '22023'; end if;
  if not portal._hit('upload:' || s.person_id::text, 'day', 60) then raise exception 'PORTAL_RATE: too many uploads today' using errcode = '54000'; end if;
  v_ext := case p_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else 'heic' end;
  v_name := left(regexp_replace(coalesce(nullif(btrim(p_file_name), ''), 'upload.' || v_ext), '[^A-Za-z0-9 ._()-]+', '_', 'g'), 120);
  v_path := p_org::text || '/pm/' || case when p_mime = 'application/pdf' then 'docs' else 'photos' end || '/portal-' || v_id::text || '.' || v_ext;
  insert into pm.portal_uploads (id, org_id, person_id, session_id, grant_id, purpose, storage_path, file_name, mime_type, size_bytes, expires_at)
  values (v_id, p_org, s.person_id, s.id, g.id, p_purpose, v_path, v_name, p_mime, p_size, now() + interval '15 minutes');
  return jsonb_build_object('upload_id', v_id, 'path', v_path);
end $$;

-- After the bytes are in storage: the public.documents row (one store with Books' Document Center).
create or replace function portal.upload_finish(p_session text, p_upload uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; u pm.portal_uploads; v_doc uuid; v_loc uuid;
begin
  s := portal._session(p_session);
  select * into u from pm.portal_uploads x where x.id = p_upload and x.session_id = s.id for update;
  if u.id is null then raise exception 'PORTAL_FORBIDDEN: upload not found' using errcode = '42501'; end if;
  if u.finished_at is not null then return jsonb_build_object('document_id', u.document_id); end if;
  if u.expires_at <= now() then raise exception 'PORTAL_INVALID: the upload took too long; try again' using errcode = '22023'; end if;
  if to_regclass('storage.objects') is not null
     and not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = u.storage_path) then
    raise exception 'PORTAL_INVALID: the file did not arrive; try again' using errcode = '22023';
  end if;
  select g.location_id into v_loc from pm.portal_grants g where g.id = u.grant_id;
  insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, entity_id, uploaded_by_user, notes)
  values (u.org_id, u.storage_path, u.file_name, u.mime_type, u.size_bytes, 'OTHER', 'pm.portal_uploads', u.id, 'portal:' || u.person_id::text,
          'Uploaded in the Projects portal')
  returning id into v_doc;
  if u.mime_type like 'image/%' then
    insert into pm.doc_photo_meta (document_id, org_id, location_id, taken_at_source, captured_by)
    values (v_doc, u.org_id, v_loc, 'none', 'portal:' || u.person_id::text)
    on conflict do nothing;
  end if;
  update pm.portal_uploads set document_id = v_doc, finished_at = now() where id = u.id;
  return jsonb_build_object('document_id', v_doc);
end $$;

-- A 2-minute read of one object this person may see: a shared document's current version, a shared
-- job photo, or their own upload. Returns the storage key for the app route (never to the browser).
create or replace function portal.file_grant(p_session text, p_org uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; v_path text; v_name text; v_mime text; f pm.doc_files; gc pm.portal_grants; gv pm.portal_grants; gl pm.portal_grants; m pm.doc_photo_meta; v_ok boolean := false;
begin
  s := portal._session(p_session);
  if p_kind = 'document' then
    select * into f from pm.doc_files x where x.id = p_id and x.org_id = p_org and x.status = 'active';
    if f.id is not null and f.job_id is not null then
      gc := portal._job_grant(s, p_org, f.job_id, array['customer']);
      gv := portal._job_grant(s, p_org, f.job_id, array['vendor']);
      gl := portal._job_grant(s, p_org, f.job_id, array['lender','investor']);
      v_ok := (gc.id is not null and 'customer' = any (f.portal_audiences) and coalesce(f.money_cap, '') <> 'projects.financials')
           or (gl.audience = 'investor' and 'investor' = any (f.portal_audiences) and coalesce(f.money_cap, '') <> 'projects.financials')
           or (gl.audience = 'lender' and 'lender' = any (f.portal_audiences)
               and (coalesce(f.money_cap, '') <> 'projects.financials' or f.kind in ('draw_request','lien_waiver','pay_app')))
           or (gv.id is not null and 'vendor' = any (f.portal_audiences)
               and (f.money_cap is null
                 or (f.subject_table = 'commitments' and exists (select 1 from pm.commitments c where c.id = f.subject_id and c.vendor_id = gv.vendor_id))
                 or (f.subject_table = 'compliance_docs' and exists (select 1 from pm.compliance_docs c where c.id = f.subject_id and c.vendor_id = gv.vendor_id))));
      if v_ok then
        select doc.storage_path, v.file_name, coalesce(v.mime_type, doc.mime_type) into v_path, v_name, v_mime
          from pm.doc_versions v join public.documents doc on doc.id = v.document_id where v.id = f.current_version_id;
      end if;
    end if;
  elsif p_kind = 'photo' then
    select * into m from pm.doc_photo_meta x where x.document_id = p_id and x.org_id = p_org and x.share_to_portal and x.job_id is not null;
    if m.document_id is not null then gc := portal._job_grant(s, p_org, m.job_id, array['customer']); end if;
    if gc.id is not null then
      v_ok := true;
      select doc.storage_path, doc.file_name, doc.mime_type into v_path, v_name, v_mime from public.documents doc where doc.id = m.document_id;
    end if;
  elsif p_kind = 'upload' then
    select doc.storage_path, doc.file_name, doc.mime_type into v_path, v_name, v_mime
      from pm.portal_uploads u join public.documents doc on doc.id = u.document_id
     where u.document_id = p_id and u.session_id = s.id and u.org_id = p_org;
    v_ok := v_path is not null;
  end if;
  if not v_ok or v_path is null or v_path not like p_org::text || '/%' or position('..' in v_path) > 0 then
    raise exception 'PORTAL_FORBIDDEN: file not found' using errcode = '42501';
  end if;
  delete from pm.portal_file_grants g where g.expires_at < now() - interval '1 hour';
  insert into pm.portal_file_grants (session_id, storage_path, expires_at) values (s.id, v_path, now() + interval '2 minutes');
  return jsonb_build_object('path', v_path, 'file_name', v_name, 'mime_type', coalesce(v_mime, 'application/octet-stream'));
end $$;

-- Storage policy building blocks (anon): exactly the open slot / the granted object, nothing else.
create or replace function portal.upload_path_ok(p_name text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from pm.portal_uploads u where u.storage_path = p_name and u.finished_at is null and u.expires_at > now())
$$;

create or replace function portal.download_path_ok(p_name text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from pm.portal_file_grants g where g.storage_path = p_name and g.expires_at > now())
$$;

do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  drop policy if exists portal_upload_insert on storage.objects;
  drop policy if exists portal_object_select on storage.objects;
  create policy portal_upload_insert on storage.objects for insert to anon
    with check (bucket_id = 'documents' and portal.upload_path_ok(name));
  create policy portal_object_select on storage.objects for select to anon
    using (bucket_id = 'documents' and (portal.download_path_ok(name) or portal.upload_path_ok(name)));
end $$;

-- ----------------------------------------------------------------------------
-- 11. 1110 registries: classes, RPC guards
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('portal_people',         'O','org',             '{}', null, null, null, null, null, false, '1118: portal identities (no org); no member grants'),
  ('portal_links',          'O','org',             '{}', null, null, null, null, null, false, '1118: sign-in / phone codes (hashes); no member grants'),
  ('portal_sessions',       'O','org',             '{}', null, null, null, null, null, false, '1118: portal sessions (hashes); no member grants'),
  ('portal_server_keys',    'O','org',             '{}', null, null, null, null, null, false, '1118: server key hashes; service role only'),
  ('portal_rate_counters',  'O','org',             '{}', null, null, null, null, null, false, '1118: portal rate limits; no member grants'),
  ('portal_uploads',        'O','org',             '{}', null, null, null, null, null, false, '1118: one-time upload slots; no member grants'),
  ('portal_file_grants',    'O','org',             '{}', null, null, null, null, null, false, '1118: 2-minute object reads; no member grants'),
  ('portal_security_events','O','org',             '{}', null, null, null, null, null, false, '1118: platform alert hook (cross-tenant); service role only'),
  ('portal_grants',         'C','location',        '{projects.customers,projects.commitments,projects.billing}', null, null, null, null, null, false,
     '1118: who has portal access at the company; written by pm.portal_invite / portal_update_grant / portal_revoke'),
  ('portal_grant_jobs',     'C','parent',          '{}', null, 'portal_grants', 'grant_id', null, null, false, '1118: jobs a portal grant reaches'),
  ('portal_messages',       'J','job',             '{projects.jobs}', null, null, null, null, null, false, '1118: portal job threads; written by portal.post_message / pm.portal_post_message'),
  ('portal_requests',       'J','job_or_location', '{projects.jobs}', null, null, null, null, null, false, '1118: warranty / service requests from the portal'),
  ('portal_task_responses', 'J','job',             '{projects.jobs}', null, null, null, null, null, false, '1118: sub confirm / decline / proposed dates'),
  ('portal_actions',        'J','job_or_location', '{projects.jobs}', null, null, null, null, null, false, '1118: portal audit trail (append-only; no amounts in detail)'),
  ('portal_pay_apps',       'M','job',             '{projects.financials}', null, null, null, null, null, false, '1118: sub pay applications against commitments'),
  ('portal_pay_app_lines',  'M','parent',          '{}', null, 'portal_pay_apps', 'pay_app_id', null, null, false, '1118: pay application lines')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('portal_invite',            '{p_location}', 'if not (pm.access_can_location(''projects.customers'', ''edit'', p_location) or pm.access_can_location(''projects.commitments'', ''edit'', p_location) or pm.access_can_location(''projects.billing'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.customers:edit, projects.commitments:edit or projects.billing:edit at this company''); end if;', '1118: + the audience''s own capability (body)'),
  ('portal_update_grant',      '{p_grant}',    'perform pm.access_assert_row_any(array[''projects.customers'', ''projects.commitments'', ''projects.billing''], ''edit'', ''portal_grants'', p_grant);', '1118: + the audience''s own capability (body)'),
  ('portal_revoke',            '{p_grant}',    'perform pm.access_assert_row_any(array[''projects.customers'', ''projects.commitments'', ''projects.billing''], ''edit'', ''portal_grants'', p_grant);', '1118: + the audience''s own capability (body)'),
  ('portal_share_document',    '{p_file}',     'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''doc_files'', p_file);', '1118: + money capability for money documents (body)'),
  ('portal_set_client_visible','{p_table,p_id}', 'if p_table = ''tasks'' then perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_id); elsif p_table = ''field_logs'' then perform pm.access_assert_row(''projects.documents'', array[''edit''], ''field_logs'', p_id); else perform pm.access_forbid(''tasks or field logs only''); end if;', '1118'),
  ('portal_post_message',      '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1118'),
  ('portal_update_request',    '{p_request}',  'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''portal_requests'', p_request);', '1118'),
  ('portal_decide_pay_app',    '{p_pay_app}',  'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''portal_pay_apps'', p_pay_app);', '1118'),
  ('portal_resolve_response',  '{p_response}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''portal_task_responses'', p_response);', '1118')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 12. RLS, grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['portal_people','portal_links','portal_sessions','portal_server_keys','portal_rate_counters','portal_uploads',
                           'portal_file_grants','portal_security_events','portal_grants','portal_grant_jobs','portal_messages','portal_requests','portal_task_responses',
                           'portal_actions','portal_pay_apps','portal_pay_app_lines'] loop
    execute format('alter table pm.%I enable row level security', t);
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
  end loop;
  -- member-readable (staff screens); every write is a definer RPC
  foreach t in array array['portal_grants','portal_grant_jobs','portal_messages','portal_requests','portal_task_responses',
                           'portal_actions','portal_pay_apps','portal_pay_app_lines'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('grant select on pm.%I to authenticated', t);
  end loop;
end $$;

select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants. pm: members get the staff RPCs (guarded); nothing for anon. portal: the public
-- surface only (helpers stay owner-only).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in ('portal_invite','portal_update_grant','portal_revoke','portal_share_document',
              'portal_set_client_visible','portal_post_message','portal_update_request','portal_decide_pay_app','portal_resolve_response') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

revoke all on schema portal from public;
grant usage on schema portal to anon, authenticated, service_role;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'portal' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('auth_start','auth_switch','auth_verify_switch','dispatch_result','auth_redeem','auth_verify_code','sign_out','phone_start','phone_verify','set_locale','me','home','job',
                     'draw','item','invoices','vendor','messages','decide','esign_link','post_message','service_request','task_respond',
                     'accept_commitment','punch_ready','compliance_submit','submit_pay_app','upload_begin','upload_finish','file_grant',
                     'upload_path_ok','download_path_ok') then
      execute format('grant execute on function %s to anon, authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1118_pm_portals
-- ============================================================================
