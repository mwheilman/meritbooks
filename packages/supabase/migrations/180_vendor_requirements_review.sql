-- =============================================================================
-- Migration 180: vendor W-9 / COI closed loop — requirement sets, submission review,
--                accepted coverage lines, bank-change call-back (VN-01…VN-04, VN-10).
-- =============================================================================
-- FPB-vendor-compliance-chase §19 (Wave 2A amendment). Builds on 178 (request engine).
--
-- §1  public.vendor_requirements             what a vendor owes, per company (location_id
--                                            null = every company) × vendor type × 1099
--                                            status × work type: W-9, COI minimums (GL each
--                                            occurrence / aggregate, auto, WC each accident,
--                                            umbrella), additional-insured / waiver-of-
--                                            subrogation, certificate holder, expiry lead
--                                            time, block payment yes/no, grace days.
-- §2  public.vendor_compliance_profiles      Books-side vendor classification (vendor_type,
--                                            work_type) — NOT a core.vendors column (§19 A3).
-- §3  public.vendor_document_submissions     review state of a vendor document: received →
--                                            ai_checked → accepted | rejected | superseded,
--                                            extracted facts + per-rule results; fill-here W-9
--                                            data (last 4 only) + tin_ciphertext (masked col).
-- §4  public.vendor_coverages                accepted COI coverage lines (closes the "GL and
--                                            WC only" gap; FPB §15.3).
-- §5  public.vendor_bank_change_verifications VN-10 call-back record; a pending row blocks
--                                            every payment to the vendor (app gate). The DB
--                                            refuses a verification that used the number
--                                            that came with the change request.
--     + trigger on vendor_payment_profiles (INSERT OR UPDATE): new / changed bank
--       details (mask, full-number fingerprint, CHECK→ACH) open one.
-- §6  vendor_compliance_docs: submission_id, verified_by_user (Clerk ids are text).
-- §7  vendor_compliance_events: event vocabulary widened (FPB §10) + submission_id, meta.
-- §8  RLS + grants: members SELECT their org; every write is the service role (the app,
--     after its permission check, org pinned — the 171 pattern); anon nothing.
-- §9  tin_ciphertext registered as a column_revoke tin field; masks re-applied.
-- §10 client-scope RLS re-applied (vendor_requirements carries location_id).
--
-- M1 lesson: every new function EXECUTE-revoked from public/anon/authenticated, then
-- granted explicitly. Idempotent. PGlite-compatible (no subqueries in CHECK). No GL
-- effect. Apply to Supabase FIRST, then commit the code that uses it.
-- =============================================================================

-- ── §1 vendor_requirements ───────────────────────────────────────────────────
create table if not exists public.vendor_requirements (
  id                               uuid primary key default gen_random_uuid(),
  org_id                           uuid not null references core.organizations(id) on delete cascade,
  location_id                      uuid references core.locations(id) on delete cascade,
  name                             text not null,
  vendor_type                      text,
  tax_1099                         text not null default 'any',
  work_type                        text,
  w9_required                      boolean not null default true,
  coi_required                     boolean not null default false,
  min_gl_each_occurrence_cents     bigint,
  min_gl_aggregate_cents           bigint,
  min_auto_cents                   bigint,
  wc_required                      boolean not null default false,
  min_wc_each_accident_cents       bigint,
  min_umbrella_cents               bigint,
  require_additional_insured       boolean not null default false,
  require_waiver_of_subrogation    boolean not null default false,
  certificate_holder_name          text,
  expiry_lead_days                 integer not null default 30,
  block_payment                    boolean not null default true,
  grace_days                       integer not null default 0,
  is_active                        boolean not null default true,
  created_by                       text,
  updated_by                       text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);
comment on table public.vendor_requirements is
  'Mig 180 (FPB-vendor-compliance-chase §19): a requirement set — what a vendor owes for one company (null = all) × vendor type × 1099 status × work type. Most specific set wins. Written only by the service role (lib/vendor-compliance).';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_requirements_values_chk') then
    alter table public.vendor_requirements add constraint vendor_requirements_values_chk
      check (char_length(btrim(name)) between 1 and 120
             and (vendor_type is null or vendor_type in ('service_provider','supplier','subcontractor','professional','exempt','foreign'))
             and tax_1099 in ('any','eligible','not_eligible')
             and (work_type is null or work_type ~ '^[a-z0-9_]{1,40}$')
             and (min_gl_each_occurrence_cents is null or min_gl_each_occurrence_cents >= 0)
             and (min_gl_aggregate_cents is null or min_gl_aggregate_cents >= 0)
             and (min_auto_cents is null or min_auto_cents >= 0)
             and (min_wc_each_accident_cents is null or min_wc_each_accident_cents >= 0)
             and (min_umbrella_cents is null or min_umbrella_cents >= 0)
             and (certificate_holder_name is null or char_length(certificate_holder_name) between 1 and 200)
             and expiry_lead_days between 0 and 180
             and grace_days between 0 and 90);
  end if;
end $$;
-- One ACTIVE set per (company, vendor type, 1099 status, work type).
create unique index if not exists ux_vendor_requirements_scope
  on public.vendor_requirements (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                 coalesce(vendor_type, ''), tax_1099, coalesce(work_type, ''))
  where is_active;
create index if not exists ix_vendor_requirements_org on public.vendor_requirements (org_id, is_active);

-- ── §2 vendor_compliance_profiles ────────────────────────────────────────────
create table if not exists public.vendor_compliance_profiles (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  vendor_id    uuid not null references core.vendors(id) on delete cascade,
  vendor_type  text,
  work_type    text,
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, vendor_id)
);
comment on table public.vendor_compliance_profiles is
  'Mig 180: Books-side vendor classification that picks the requirement set (vendor_type, work_type). Service-role writes.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_compliance_profiles_values_chk') then
    alter table public.vendor_compliance_profiles add constraint vendor_compliance_profiles_values_chk
      check ((vendor_type is null or vendor_type in ('service_provider','supplier','subcontractor','professional','exempt','foreign'))
             and (work_type is null or work_type ~ '^[a-z0-9_]{1,40}$'));
  end if;
end $$;

-- ── §3 vendor_document_submissions ───────────────────────────────────────────
create table if not exists public.vendor_document_submissions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  vendor_id         uuid not null references core.vendors(id) on delete cascade,
  doc_kind          text not null,
  source            text not null,
  document_id       uuid references public.documents(id) on delete set null,
  portal_token_id   uuid references public.vendor_portal_tokens(id) on delete set null,
  request_id        uuid,             -- core.requests id (reference only, no FK: a request is client-scoped, the vendor document is not)
  status            text not null default 'received',
  ai_status         text not null default 'pending',
  ai_note           text,
  ai_model          text,
  ai_decision_id    uuid,
  ai_attempts       integer not null default 0,
  extracted         jsonb not null default '{}'::jsonb,
  rule_results      jsonb not null default '[]'::jsonb,
  rules_passed      boolean,
  w9_form           jsonb,
  tin_ciphertext    text,
  tin_last4         text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  decision_reason   text,
  accepted_doc_ids  uuid[],
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.vendor_document_submissions is
  'Mig 180: one vendor document waiting for (or past) review — portal upload, fill-here W-9 or staff upload. AI proposes facts + rule results; a person accepts or rejects. No raw TIN: w9_form holds last 4; tin_ciphertext is AES-GCM and member-unreadable (column_revoke).';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_document_submissions_values_chk') then
    alter table public.vendor_document_submissions add constraint vendor_document_submissions_values_chk
      check (doc_kind in ('W9','COI')
             and source in ('portal_upload','portal_w9_form','staff_upload')
             and status in ('received','ai_checked','accepted','rejected','superseded')
             and ai_status in ('pending','done','unavailable','failed','skipped')
             and (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$')
             and (status not in ('accepted','rejected') or (reviewed_by is not null and reviewed_at is not null))
             and (status <> 'rejected' or char_length(btrim(coalesce(decision_reason, ''))) >= 3)
             and jsonb_typeof(extracted) = 'object'
             and jsonb_typeof(rule_results) = 'array');
  end if;
end $$;
alter table public.vendor_document_submissions add column if not exists ai_attempts integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_document_submissions_ai_attempts_chk') then
    alter table public.vendor_document_submissions add constraint vendor_document_submissions_ai_attempts_chk check (ai_attempts >= 0);
  end if;
end $$;
create index if not exists ix_vendor_doc_submissions_queue on public.vendor_document_submissions (org_id, status, created_at desc);
create index if not exists ix_vendor_doc_submissions_vendor on public.vendor_document_submissions (org_id, vendor_id, created_at desc);

-- ── §4 vendor_coverages ──────────────────────────────────────────────────────
create table if not exists public.vendor_coverages (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  vendor_id              uuid not null references core.vendors(id) on delete cascade,
  submission_id          uuid references public.vendor_document_submissions(id) on delete cascade,
  coverage_type          text not null,
  carrier                text,
  policy_number          text,
  each_occurrence_cents  bigint,
  aggregate_cents        bigint,
  effective_date         date,
  expiration_date        date,
  additional_insured     boolean,
  waiver_of_subrogation  boolean,
  certificate_holder     text,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now()
);
comment on table public.vendor_coverages is
  'Mig 180 (FPB §15.3): accepted COI coverage lines, one per line per accepted certificate. A newer accepted certificate deactivates the older lines of the same type. Service-role writes.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_coverages_values_chk') then
    alter table public.vendor_coverages add constraint vendor_coverages_values_chk
      check (coverage_type in ('GENERAL_LIABILITY','WORKERS_COMP','AUTO','UMBRELLA','PROFESSIONAL','POLLUTION','OTHER')
             and (each_occurrence_cents is null or each_occurrence_cents >= 0)
             and (aggregate_cents is null or aggregate_cents >= 0)
             and (effective_date is null or expiration_date is null or expiration_date >= effective_date));
  end if;
end $$;
create index if not exists ix_vendor_coverages_vendor on public.vendor_coverages (org_id, vendor_id, coverage_type) where is_active;

-- ── §5 vendor_bank_change_verifications (VN-10) ──────────────────────────────
create table if not exists public.vendor_bank_change_verifications (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  vendor_id             uuid not null references core.vendors(id) on delete cascade,
  source                text not null,
  document_id           uuid references public.documents(id) on delete set null,
  prior_account_mask    text,
  new_account_mask      text,
  new_routing_mask      text,
  new_bank_name         text,
  request_phone         text,
  status                text not null default 'pending',
  opened_by             text,
  opened_at             timestamptz not null default now(),
  called_by             text,
  called_at             timestamptz,
  contact_name          text,
  phone_used            text,
  phone_source          text,
  notes                 text,
  decided_by            text,
  decided_at            timestamptz,
  decision_reason       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.vendor_bank_change_verifications is
  'Mig 180 (VN-10): a vendor bank-detail change waiting for an out-of-band call-back. While pending, no payment to the vendor is released (lib/services/vendor-compliance enforcePaymentAllowed; overrides do not lift it). The call must use a number already on file — never the one that came with the change.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_bank_change_values_chk') then
    alter table public.vendor_bank_change_verifications add constraint vendor_bank_change_values_chk
      check (source in ('vendor_portal','payment_profile','manual')
             and status in ('pending','verified','rejected','cancelled')
             and (phone_source is null or phone_source in ('vendor_master','prior_document','independent_lookup'))
             and (status = 'pending' or (decided_by is not null and decided_at is not null))
             and (status <> 'verified' or (called_by is not null and called_at is not null and phone_used is not null
                                           and phone_source is not null and char_length(btrim(coalesce(contact_name, ''))) >= 2))
             and (status not in ('rejected','cancelled') or char_length(btrim(coalesce(decision_reason, ''))) >= 3));
  end if;
  -- Never the number on the request (BEC: the fraudster supplies it).
  if not exists (select 1 from pg_constraint where conname = 'vendor_bank_change_not_request_phone_chk') then
    alter table public.vendor_bank_change_verifications add constraint vendor_bank_change_not_request_phone_chk
      check (phone_used is null or request_phone is null
             or regexp_replace(request_phone, '[^0-9]', '', 'g') = ''
             or right(regexp_replace(phone_used, '[^0-9]', '', 'g'), 10) <> right(regexp_replace(request_phone, '[^0-9]', '', 'g'), 10));
  end if;
end $$;
create index if not exists ix_vendor_bank_change_pending on public.vendor_bank_change_verifications (org_id, vendor_id) where status = 'pending';
create index if not exists ix_vendor_bank_change_org on public.vendor_bank_change_verifications (org_id, status, opened_at desc);

-- A full-number fingerprint (HMAC-SHA256 of routing + account, keyed server-side; the raw
-- numbers never reach the DB) so a NEW account that shares the old last four is still a
-- change. Written by the app's profile upsert (lib/ap/vendor-payment-details); null on
-- rows captured before it existed (then the masks / method are compared).
do $$ begin
  if to_regclass('public.vendor_payment_profiles') is not null then
    alter table public.vendor_payment_profiles add column if not exists account_fingerprint text;
    comment on column public.vendor_payment_profiles.account_fingerprint is
      'Mig 180: HMAC-SHA256(routing|account) under a server key — not reversible, never the number. A change opens a VN-10 call-back even when the last four match.';
  end if;
end $$;
alter table public.vendor_bank_change_verifications
  add column if not exists new_account_fingerprint text,
  add column if not exists new_payment_method text;

-- ANY new or changed bank detail on a payment profile opens a pending call-back (security
-- review M2): fires on INSERT as well as UPDATE (first capture — "no prior details" counts
-- as different), on a changed account / routing mask, on a changed full-number fingerprint
-- (same last four, different account), and on a CHECK → ACH switch onto details that were
-- never verified for ACH. Nothing opens when the new row carries no bank details at all.
-- An identical change already pending is not stacked (an upsert retry is one call-back).
create or replace function public.vendor_bank_change_on_profile() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as
$$
declare
  v_changed     boolean := false;
  v_prior_mask  text := null;
begin
  if new.account_mask is null and new.routing_mask is null and new.account_fingerprint is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_changed := true;
  else
    v_prior_mask := old.account_mask;
    v_changed := old.account_mask is distinct from new.account_mask
              or old.routing_mask is distinct from new.routing_mask
              or (new.account_fingerprint is not null and old.account_fingerprint is distinct from new.account_fingerprint)
              or (old.payment_method is distinct from new.payment_method and new.payment_method = 'ACH');
  end if;
  if not v_changed then
    return new;
  end if;
  if exists (
    select 1 from public.vendor_bank_change_verifications v
     where v.org_id = new.org_id and v.vendor_id = new.vendor_id
       and v.status = 'pending' and v.source = 'payment_profile'
       and v.new_account_mask is not distinct from new.account_mask
       and v.new_routing_mask is not distinct from new.routing_mask
       and v.new_account_fingerprint is not distinct from new.account_fingerprint
       and v.new_payment_method is not distinct from new.payment_method
  ) then
    return new;
  end if;
  insert into public.vendor_bank_change_verifications
    (org_id, vendor_id, source, prior_account_mask, new_account_mask, new_routing_mask, new_account_fingerprint,
     new_payment_method, new_bank_name, opened_by)
  values (new.org_id, new.vendor_id, 'payment_profile', v_prior_mask, new.account_mask, new.routing_mask,
          new.account_fingerprint, new.payment_method, new.bank_name, coalesce(new.captured_by, 'system:payment_profile'));
  return new;
end;
$$;
revoke all on function public.vendor_bank_change_on_profile() from public, anon, authenticated;
grant execute on function public.vendor_bank_change_on_profile() to service_role;
do $$ begin
  if to_regclass('public.vendor_payment_profiles') is not null then
    drop trigger if exists trg_vendor_bank_change_on_profile on public.vendor_payment_profiles;
    create trigger trg_vendor_bank_change_on_profile
      after insert or update on public.vendor_payment_profiles
      for each row execute function public.vendor_bank_change_on_profile();
  end if;
end $$;

-- ── §6 vendor_compliance_docs: link to the accepted submission ───────────────
alter table public.vendor_compliance_docs
  add column if not exists submission_id uuid references public.vendor_document_submissions(id) on delete set null,
  add column if not exists verified_by_user text;

-- ── §6b vendor_payment_holds.created_by: LIVE BUG FIX ───────────────────────
-- 005 made created_by `uuid NOT NULL`; Clerk ids are text, so grantOverride writes the
-- actor to created_by_user (037) and null here — which the NOT NULL refused: every
-- override grant failed. Canon §2: uuid attribution columns are nullable, write null.
alter table public.vendor_payment_holds alter column created_by drop not null;

-- ── §7 vendor_compliance_events: the closed-loop vocabulary (FPB §10) ────────
alter table public.vendor_compliance_events
  add column if not exists submission_id uuid references public.vendor_document_submissions(id) on delete set null,
  add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.vendor_compliance_events drop constraint if exists vendor_compliance_events_event_type_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_compliance_events_event_type_chk') then
    alter table public.vendor_compliance_events add constraint vendor_compliance_events_event_type_chk
      check (event_type in (
        'PAYMENT_BLOCKED','OVERRIDE_GRANTED','OVERRIDE_CONSUMED','OVERRIDE_RELEASED','DOC_EXPIRED','CHASE_SCHEDULED',
        'REQUEST_CREATED','UPLOAD_RECEIVED','W9_FORM_SUBMITTED','AI_CHECKED','AI_UNAVAILABLE','REQUIREMENT_FAILED',
        'DOC_ACCEPTED','DOC_REJECTED','HOLD_APPLIED','HOLD_LIFTED','BILL_HOLD_RELEASED',
        'BANK_CHANGE_OPENED','BANK_CHANGE_VERIFIED','BANK_CHANGE_REJECTED',
        'PROFILE_CHANGED'));
  end if;
end $$;

-- ── §7b vendor-portal AI-read budget (security review M11) ──────────────────
-- The public upload portal runs an AI read per certificate; cap it per portal link per
-- UTC day in the 178 counter table (core.bump_send_quota) so it holds across instances.
do $$ begin
  if to_regclass('core.outbound_send_counters') is not null then
    alter table core.outbound_send_counters drop constraint if exists outbound_send_counters_chk;
    alter table core.outbound_send_counters add constraint outbound_send_counters_chk
      check (scope in ('user_hour','org_day','portal_ai_day') and count >= 0 and length(scope_key) between 1 and 200);
  end if;
end $$;

-- ── §8 RLS + grants ──────────────────────────────────────────────────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['vendor_requirements','vendor_compliance_profiles','vendor_document_submissions',
                           'vendor_coverages','vendor_bank_change_verifications'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname <> 'client_scope_rls' loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy member_read on public.%I for select to authenticated using (org_id is not null and org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── §9 TIN ciphertext is a column_revoke tin field (167 registry) ────────────
do $$ begin
  if to_regclass('core.field_class_columns') is not null then
    insert into core.field_class_columns (field_class, schema_name, table_name, column_name, enforcement, note) values
      ('tin', 'public', 'vendor_document_submissions', 'tin_ciphertext', 'column_revoke',
       'Fill-here W-9 TIN, AES-256-GCM; read only by the server on accept / 1099')
    on conflict (schema_name, table_name, column_name) do update
      set field_class = excluded.field_class, enforcement = excluded.enforcement, note = excluded.note;
  end if;
  if to_regprocedure('core.apply_field_column_masks()') is not null then
    perform core.apply_field_column_masks();
  end if;
end $$;

-- End migration 180.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
