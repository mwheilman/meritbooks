-- ============================================================================
-- 1111 · Merit Suite — shared records: contacts, sites, the crm lead flow, matching at the
--        door, duplicate review + merge, relationship stage, customer 360, Books tie-outs
--
-- Design: docs/suite/SHARED-RECORDS-CRM-PROJECTS-BOOKS.md (owner-directed; §9 is the fixed
-- build contract — every name below is the §9 name). Access model: 1110_pm_access.sql
-- (pm.can / my_location_ids / my_job_ids, restrictive class policies, the Projects-only-seat
-- deny, guarded definer RPCs). Matching thresholds mirror Books' customer dedupe scorer
-- apps/web/src/lib/customers/dedupe.ts (+ vendorSimilarity / normalizeText of
-- lib/services/reconciliation-match.ts) exactly, so Books and Projects agree on every pair.
--
-- What this migration creates
--   core   contacts, sites, duplicate_reviews (new); customers / vendors gain merged_into,
--          merged_at (soft archive of a merged record).
--          match_parties, merge_parties, dismiss_duplicate, create_contact, create_site (member
--          RPCs); party_* scoring helpers; an AFTER INSERT safety net on customers / vendors /
--          contacts that files strong matches into duplicate_reviews (never blocks an insert).
--          v_customer_relationship (derived stage prospect | customer | former).
--   crm    (new schema; the reserved Merit CRM namespace — Projects is its first screen)
--          pipeline_templates (catalog), pipelines, pipeline_stages, leads, lead_stage_events,
--          activities, followups; create_lead, move_lead, log_activity, complete_followup,
--          convert_lead; ensure_pipelines (seeded per company from its primary pack, for every
--          existing company here and on every pack install).
--   pm     v_customer_360, v_job_tieout, v_company_tieout (definer views, 1110 masking rules).
--
-- ACCESS
--   crm tables: org isolation (permissive) AND one restrictive class policy set per table
--     (crm_access_select | insert | update | delete), registry crm.access_table_classes. A
--     guard test fails for an unclassified crm table (crm.access_unclassified_tables()) or a
--     classified table without its policies (crm.access_policy_gaps()).
--       leads / activities / followups   company-scoped on projects.leads (view / create /
--                                        edit / delete); leads also visible on the caller's
--                                        own converted jobs, activities on reachable jobs,
--                                        followups to their assignee.
--       pipelines / pipeline_stages      read: any Projects member of the company;
--                                        write: projects.settings:configure.
--   core.contacts / core.sites / core.duplicate_reviews: org isolation for every seat (Books
--     staff and every non-Projects-only seat keep full org read — Books is unaffected); a
--     Projects-only seat (core.memberships.projects_only) is narrowed by the 1110
--     projects_only_seat_deny policy in its NARROWED form (pm.access_seat_exceptions):
--       contacts  of customers the seat reaches (projects.customers / leads / estimates / store
--                 / dispatch / jobs_all at the customer's company, or the customer of a
--                 reachable job), vendor contacts with a purchasing / store / settings grant,
--                 prospect contacts on a lead the seat sees;
--       sites     of those customers, or at a company where the seat works customers / leads /
--                 dispatch / all jobs;
--       duplicate_reviews  customer / contact pairs with projects.customers:view, vendor pairs
--                 with projects.commitments or settings:view.
--     Writes: contacts / sites are created only through core.create_contact / create_site
--     (match first); members UPDATE the editable columns through RLS with projects.customers:
--     edit on the customer (or Books mdm.customers:edit / mdm.vendors:edit).
--   Definer functions: org guard first, capability check (pm.can / core.has_capability),
--     search_path pinned. Member-executable definer functions in crm, and the 1111 core
--     functions (comment '1111: …'), must be listed in crm.access_rpc_registry
--     (crm.access_unregistered_rpcs() must be empty — guard test). Nothing is executable by
--     anon. (1110's pm.access_rpc_guards injection is pm-only; 1111 adds no pm definer
--     function — the pm objects here are definer VIEWS, select-only for members.)
--
-- MATCHING (core.match_parties; the same curve as dedupe.ts scoreCustomerDuplicates)
--   name similarity = best over name / display_name of both sides of
--     min(1, containment(tokens ≥ 2 chars) × 0.85 + 0.25 when one normalized name contains
--     the other); normalize = lower, non-[a-z0-9] runs → one space, trim.
--   matching tax ID (alnum upper, ≥ 4 chars)                → 0.96
--   name ≥ 0.90 + shared email / phone / address            → 0.93
--   shared email + name ≥ 0.60                              → 0.90
--   shared phone (last 10 digits, exactly 10) + name ≥ 0.60 → 0.86
--   name ≥ 0.90 alone                                       → 0.82
--   name ≥ 0.85 + shared email / phone / address            → 0.82
--   otherwise no match (nothing below 0.70 is ever surfaced). Address = same ZIP and the same
--   normalized line 1. p_address is free text: line 1 is the text before the first comma,
--   the ZIP is its last 5-digit group (e.g. '12 Oak St, Ames, IA 50010').
--   detail.level: 'exact' when tax ID, email or phone matched, or name + address (the door
--   offers the existing record by default); otherwise 'likely'.
--   Safety net: an insert scoring ≥ 0.86 against an existing record files an open
--   duplicate_reviews row (unless the pair was already reviewed, e.g. dismissed as
--   not-a-duplicate). Never merges, never fails the insert.
--
-- MERGE (core.merge_parties) — repoints EVERY foreign key that references the victim, in every
--   schema, found from pg_constraint at call time (Books, Projects, crm and tables added
--   later). Posted Books rows (invoices, bills, payments) are repointed only — amount and date
--   never change. A reference that cannot move (a unique 1:1 row the survivor already has, an
--   append-only evidence log) stays on the victim, which remains as an archived row
--   (merged_into = survivor) so every FK stays valid; the summary lists it. Field values: the
--   survivor's, unless p_field_choices = {"<column>": "victim"}; blanks on the survivor are
--   filled from the victim for identity fields. Refused: cross-tenant pairs, already-merged
--   records, and Books-owned money settings that differ (customers: payment terms, credit
--   limit, tax exemption / tax ID, payment methods, surcharges, retainage; vendors: terms,
--   retainage, 1099, TIN, W-9 status, GL defaults, auto-approve) unless p_field_choices
--   names every such field AND the caller is an owner / admin seat or holds Books
--   mdm.customers:edit (vendors: mdm.vendors:edit). Audited to core.action_log (the suite
--   action log Books' logAction writes) with the full before / after.
--
-- RELATIONSHIP STAGE (core.v_customer_relationship, the one place it is computed):
--   customer = has a signed contract (pm.contracts ACTIVE / CLOSED, on a job of the
--   customer) or an issued invoice (public.invoices not DRAFT / VOIDED); former = the latest
--   of those is more than 24 months old; prospect otherwise.
--
-- TIE-OUTS (pm.v_job_tieout per job × check; pm.v_company_tieout per company), doc §6:
--   job_cost     pm.job_costs CLEARED vs posted GL lines with the job dimension on COGS / OPEX
--                accounts; exception when |diff| > $1.
--   billing      billing requests EMITTED / ISSUED (net) vs the job's invoices (subtotal, not
--                DRAFT / VOIDED, not DEPOSIT); exception when amounts differ or a request has
--                no invoice after 2 business days.
--   deposits     requested − applied − refunded (requests Books has collected, matched on
--                source_ref) vs held (amount − applied − refunded) of the job's
--                customer_deposits; exception when they differ.
--   commitments  committed value; Books does not match bills to Projects commitments →
--                'pending', cause 'Books does not record this yet'.
--   time         approved hours × 100; Books records no payroll hours by job → 'pending'.
--   events       PROJECTS messages for the job rejected, or pending over 1 hour → exception.
--   customers    (company view) open duplicate reviews → exception.
--   Money columns are null unless the caller holds the money capability on the job
--   (financials for job_cost / commitments, contract_value for billing / deposits) or Books
--   jobs.jobs:view at the company.
--
-- ALSO IN 1111 (follow-ups)
--   * projects_supervisor gains projects.jobs:create (punch items / tasks from the phone app);
--     projects_labor does not. The platform template is republished from code (GENERATED
--     block projects_role_templates — 1110's copy is frozen live history) and the new action is
--     ADDED to every tenant clone (pm.access_sync_role_templates; clones are never narrowed).
--   * The phone app's idempotency key: unique (org_id, ext->>'_client_command_id') on
--     pm.field_logs (daily logs + checklists) and pm.punch_items — the key the
--     apps/projects/src/app/api/field/** routes write (a re-sent command gets 23505 → duplicate).
--   * 1110's masked views are rebuilt (pm.access_apply_masks) so pm.v_core_customers_masked /
--     v_core_vendors_masked expose the new merged_into / merged_at columns.
--
-- SECURITY REVIEW (2026-10-24), fixed here:
--   H1 crm.leads / lead_stage_events / activities are read with projects.leads only; a job team
--      gets lead context from pm.v_leads_masked (money, next step, lost reason, activity text masked unless
--      projects.leads or projects.contract_value on the converted job).
--   H2 create_lead, log_activity and direct lead updates (crm.tg_lead_reach) refuse a customer /
--      contact / site the caller cannot already see (crm.party_visible), so attaching never widens reach.
--   M1 the matcher gate drops dispatch / selections; candidates are scoped to companies with
--      projects.customers:view (Books customer / vendor access matches org-wide); unseen contact
--      details are masked hints; a tax id is used only by an owner seat or a caller whose Books
--      field policy reveals 'tin' (ignored entirely otherwise), never alone for a Projects-only seat.
--   M2 pm.v_customer_360 money is job-scoped (crm.ar_customer_ids) or Books ar.invoices:view.
--   M3 merging a victim with Books money records, or an org-level customer, needs Books
--      mdm.customers:edit / mdm.vendors:edit or an owner seat; when the SURVIVOR is such a record,
--      none of its fields (chosen or blank-filled) changes without that authority; org-level
--      customers are reached for cap:action only with the grant at every company.
--   L1 Projects-only seats see a duplicate pair only when they reach both records.
--   L4 candidates come from indexed key lookups (expression btree + GIN token indexes); the insert
--      safety net uses identifiers only.
--
-- POSTGREST: crm is exposed LIVE by the lead adding it to the authenticator role's
--   pgrst.db_schemas (the way pm is exposed), then `notify pgrst, 'reload config'`.
--   This migration does not alter pgrst.db_schemas.
-- APPLY RULE: after 1110. Idempotent: safe to run twice (and 1110 re-applies after it).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Schema + grant baseline
-- ----------------------------------------------------------------------------
create schema if not exists crm;
comment on schema crm is
  'Merit Suite CRM (shared): leads, pipelines, activities, follow-ups. Owned by the CRM capability (Merit CRM or Merit Projects). 1111.';
revoke all on schema crm from public;
revoke all on schema crm from anon;
grant usage on schema crm to authenticated, service_role;
alter default privileges in schema crm revoke execute on functions from public;
alter default privileges in schema crm revoke execute on functions from anon;

-- ----------------------------------------------------------------------------
-- 1. Soft-archive columns on the shared masters
-- ----------------------------------------------------------------------------
alter table core.customers add column if not exists merged_into uuid references core.customers(id);
alter table core.customers add column if not exists merged_at timestamptz;
alter table core.vendors   add column if not exists merged_into uuid references core.vendors(id);
alter table core.vendors   add column if not exists merged_at timestamptz;
comment on column core.customers.merged_into is '1111: set by core.merge_parties — this record was merged into that one (soft archive; deleted_at is set too).';
comment on column core.vendors.merged_into   is '1111: set by core.merge_parties — this record was merged into that one (soft archive; deleted_at is set too).';

-- ----------------------------------------------------------------------------
-- 2. core.contacts, core.sites, core.duplicate_reviews
-- ----------------------------------------------------------------------------
create table if not exists core.contacts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  customer_id     uuid references core.customers(id),
  vendor_id       uuid references core.vendors(id),
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  title           text,
  roles           text[] not null default '{}',
  is_primary      boolean not null default false,
  can_sign        boolean not null default false,
  can_pay         boolean not null default false,
  sms_consent     boolean not null default false,
  email_consent   boolean not null default false,
  consent_at      timestamptz,
  identity_status text not null default 'active',
  merged_into     uuid references core.contacts(id),
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint contacts_identity_status_chk check (identity_status in ('active','merged','archived')),
  constraint contacts_named_chk check (coalesce(nullif(btrim(first_name), ''), nullif(btrim(last_name), ''), nullif(btrim(email), ''), nullif(btrim(phone), '')) is not null),
  constraint contacts_len_chk check (coalesce(length(first_name), 0) <= 100 and coalesce(length(last_name), 0) <= 100
                                     and coalesce(length(email), 0) <= 254 and coalesce(length(phone), 0) <= 40
                                     and coalesce(length(title), 0) <= 200)
);
create index if not exists core_contacts_customer_idx on core.contacts (org_id, customer_id) where customer_id is not null;
create index if not exists core_contacts_vendor_idx on core.contacts (org_id, vendor_id) where vendor_id is not null;
create index if not exists core_contacts_email_idx on core.contacts (org_id, lower(btrim(email))) where email is not null;
create unique index if not exists core_contacts_one_primary_customer_uidx on core.contacts (customer_id)
  where is_primary and identity_status = 'active' and customer_id is not null;
create unique index if not exists core_contacts_one_primary_vendor_uidx on core.contacts (vendor_id)
  where is_primary and identity_status = 'active' and vendor_id is not null;
comment on table core.contacts is
  '1111 / shared records §9: a person at a customer, vendor or prospect. Created through core.create_contact (match first).';

create table if not exists core.sites (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  customer_id      uuid not null references core.customers(id),
  location_id      uuid references core.locations(id),
  name             text,
  address_line1    text,
  address_line2    text,
  city             text,
  state            text,
  zip              text,
  lat              numeric(9,6),
  lng              numeric(9,6),
  access_notes     text,
  tax_jurisdiction text,
  identity_status  text not null default 'active',
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sites_identity_status_chk check (identity_status in ('active','merged','archived')),
  constraint sites_located_chk check (coalesce(nullif(btrim(address_line1), ''), nullif(btrim(name), '')) is not null),
  constraint sites_geo_chk check ((lat is null or lat between -90 and 90) and (lng is null or lng between -180 and 180))
);
create index if not exists core_sites_customer_idx on core.sites (org_id, customer_id);
comment on table core.sites is
  '1111 / shared records §9: a site / property / service location of a customer. Created through core.create_site (match first).';

create table if not exists core.duplicate_reviews (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  kind                  text not null,
  a_id                  uuid not null,
  b_id                  uuid not null,
  suggested_survivor_id uuid,
  score                 numeric(5,4) not null,
  matched               text[] not null default '{}',
  source                text not null default 'insert_trigger',
  status                text not null default 'open',
  detail                jsonb not null default '{}',
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint duplicate_reviews_kind_chk check (kind in ('customer','vendor','contact')),
  constraint duplicate_reviews_status_chk check (status in ('open','merged','not_duplicate')),
  constraint duplicate_reviews_pair_chk check (a_id < b_id),
  constraint duplicate_reviews_survivor_chk check (suggested_survivor_id is null or suggested_survivor_id in (a_id, b_id)),
  constraint duplicate_reviews_resolved_chk check ((status = 'open') = (resolved_at is null)),
  unique (org_id, kind, a_id, b_id)
);
create index if not exists core_duplicate_reviews_open_idx on core.duplicate_reviews (org_id, kind, status);
comment on table core.duplicate_reviews is
  '1111 / shared records §4: one duplicate queue for Projects and Books. Pairs are stored a_id < b_id; not_duplicate rows are remembered so the pair is never suggested again.';

-- updated_at + same-org references + one primary contact + consent stamp
create or replace function core.tg_shared_record_touch() returns trigger
language plpgsql
set search_path = core, public
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function core.tg_contact_refs() returns trigger
language plpgsql security definer
set search_path = core, public
as $$
begin
  if new.customer_id is not null and not exists (select 1 from core.customers c where c.id = new.customer_id and c.org_id = new.org_id) then
    raise exception 'CORE_REF_ORG_MISMATCH: customer % is not in org %', new.customer_id, new.org_id using errcode = '23503';
  end if;
  if new.vendor_id is not null and not exists (select 1 from core.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'CORE_REF_ORG_MISMATCH: vendor % is not in org %', new.vendor_id, new.org_id using errcode = '23503';
  end if;
  -- one primary per customer / vendor: a new primary demotes the old one
  if new.is_primary and new.identity_status = 'active' and (tg_op = 'INSERT' or not old.is_primary) then
    update core.contacts x set is_primary = false
     where x.id <> new.id and x.is_primary and x.identity_status = 'active'
       and ((new.customer_id is not null and x.customer_id = new.customer_id)
            or (new.vendor_id is not null and x.vendor_id = new.vendor_id));
  end if;
  if (new.sms_consent or new.email_consent)
     and (tg_op = 'INSERT' or new.sms_consent is distinct from old.sms_consent or new.email_consent is distinct from old.email_consent) then
    new.consent_at := now();
  end if;
  return new;
end $$;

create or replace function core.tg_site_refs() returns trigger
language plpgsql security definer
set search_path = core, public
as $$
begin
  if not exists (select 1 from core.customers c where c.id = new.customer_id and c.org_id = new.org_id) then
    raise exception 'CORE_REF_ORG_MISMATCH: customer % is not in org %', new.customer_id, new.org_id using errcode = '23503';
  end if;
  if new.location_id is not null and not exists (select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'CORE_REF_ORG_MISMATCH: company % is not in org %', new.location_id, new.org_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists trg_touch_updated_at on core.contacts;
create trigger trg_touch_updated_at before update on core.contacts for each row execute function core.tg_shared_record_touch();
drop trigger if exists trg_contact_refs on core.contacts;
create trigger trg_contact_refs before insert or update on core.contacts for each row execute function core.tg_contact_refs();
drop trigger if exists trg_touch_updated_at on core.sites;
create trigger trg_touch_updated_at before update on core.sites for each row execute function core.tg_shared_record_touch();
drop trigger if exists trg_site_refs on core.sites;
create trigger trg_site_refs before insert or update of customer_id, location_id, org_id on core.sites for each row execute function core.tg_site_refs();
drop trigger if exists trg_touch_updated_at on core.duplicate_reviews;
create trigger trg_touch_updated_at before update on core.duplicate_reviews for each row execute function core.tg_shared_record_touch();

-- ----------------------------------------------------------------------------
-- 3. Scoring helpers (pure; mirror dedupe.ts / reconciliation-match.ts)
-- ----------------------------------------------------------------------------
create or replace function core.party_norm_text(p text) returns text
language sql immutable
set search_path = core, public
as $$ select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g')) $$;

create or replace function core.party_tokens(p text) returns text[]
language sql immutable
set search_path = core, public
as $$
  select coalesce(array_agg(distinct t), '{}'::text[])
    from unnest(string_to_array(core.party_norm_text(p), ' ')) as t
   where length(t) >= 2
$$;

-- vendorSimilarity: containment × 0.85 + 0.25 substring bonus, clamped to 0..1.
create or replace function core.party_name_similarity(a text, b text) returns numeric
language plpgsql immutable
set search_path = core, public
as $$
declare ta text[] := core.party_tokens(a); tb text[] := core.party_tokens(b); shared int; na text; nb text; v numeric;
begin
  if cardinality(ta) = 0 or cardinality(tb) = 0 then return 0; end if;
  select count(*) into shared from unnest(tb) t where t = any (ta);
  na := core.party_norm_text(a); nb := core.party_norm_text(b);
  v := (shared::numeric / least(cardinality(ta), cardinality(tb))) * 0.85
       + case when strpos(na, nb) > 0 or strpos(nb, na) > 0 then 0.25 else 0 end;
  return greatest(0, least(1, v));
end $$;

create or replace function core.party_norm_phone(p text) returns text
language sql immutable
set search_path = core, public
as $$ select case when length(d) > 10 then right(d, 10) else d end from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x $$;

create or replace function core.party_norm_tax(p text) returns text
language sql immutable
set search_path = core, public
as $$ select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g') $$;

create or replace function core.party_norm_email(p text) returns text
language sql immutable
set search_path = core, public
as $$ select nullif(lower(btrim(coalesce(p, ''))), '') $$;

-- scoreCustomerDuplicates, rule for rule. Null score = no meaningful duplicate signal.
create or replace function core.party_score(
  a_names text[], b_names text[], a_email text, b_email text, a_phone text, b_phone text,
  a_line1 text, b_line1 text, a_zip text, b_zip text, a_tax text, b_tax text,
  out score numeric, out matched text[])
language plpgsql immutable
set search_path = core, public
as $$
declare
  ta text := core.party_norm_tax(a_tax); tb text := core.party_norm_tax(b_tax);
  same_tax boolean; name_sim numeric := 0; x text; y text;
  same_email boolean; same_phone boolean; same_addr boolean; contact text;
begin
  same_tax := length(ta) >= 4 and ta = tb;
  foreach x in array coalesce(a_names, '{}') loop
    continue when x is null or x = '';
    foreach y in array coalesce(b_names, '{}') loop
      continue when y is null or y = '';
      name_sim := greatest(name_sim, core.party_name_similarity(x, y));
    end loop;
  end loop;
  same_email := core.party_norm_email(a_email) is not null and core.party_norm_email(a_email) = core.party_norm_email(b_email);
  same_phone := length(core.party_norm_phone(a_phone)) = 10 and core.party_norm_phone(a_phone) = core.party_norm_phone(b_phone);
  same_addr := nullif(btrim(coalesce(a_zip, '')), '') is not null and btrim(coalesce(a_zip, '')) = btrim(coalesce(b_zip, ''))
               and core.party_norm_text(a_line1) <> '' and core.party_norm_text(a_line1) = core.party_norm_text(b_line1);
  contact := case when same_email then 'email' when same_phone then 'phone' when same_addr then 'address' end;

  if same_tax then
    score := 0.96; matched := array['tax_id'];
    if name_sim >= 0.85 then matched := matched || 'name'::text; end if;
    if contact is not null then matched := matched || contact::text; end if;
  elsif name_sim >= 0.9 and contact is not null then
    score := 0.93; matched := array['name', contact];
  elsif same_email and name_sim >= 0.6 then
    score := 0.90; matched := array['email', 'name'];
  elsif same_phone and name_sim >= 0.6 then
    score := 0.86; matched := array['phone', 'name'];
  elsif name_sim >= 0.9 then
    score := 0.82; matched := array['name'];
  elsif name_sim >= 0.85 and contact is not null then
    score := 0.82; matched := array['name', contact];
  else
    score := null; matched := '{}';
  end if;
end $$;

-- 'exact' identifier (doc §3): tax ID, email or phone, or name + address.
create or replace function core.party_match_level(p_matched text[]) returns text
language sql immutable
set search_path = core, public
as $$
  select case when p_matched && array['tax_id','email','phone'] or p_matched @> array['name','address'] then 'exact' else 'likely' end
$$;

-- Free-text address → (line 1, ZIP).
create or replace function core.party_address_line1(p text) returns text
language sql immutable
set search_path = core, public
as $$ select nullif(btrim(split_part(coalesce(p, ''), ',', 1)), '') $$;
create or replace function core.party_address_zip(p text) returns text
language sql immutable
set search_path = core, public
as $$ select (regexp_match(coalesce(p, ''), '(\d{5})(?:-\d{4})?\D*$'))[1] $$;

-- Contact display name for matching (immutable, so it can back an index; same tokens as concat_ws).
create or replace function core.party_contact_name(p_first text, p_last text) returns text
language sql immutable
set search_path = core, public
as $$ select nullif(btrim(coalesce(p_first, '') || ' ' || coalesce(p_last, '')), '') $$;

-- L4 (security review): candidates come from INDEXED lookups only — normalized email / phone
-- digits / tax id / ZIP + line 1 (btree expression indexes) and, for the interactive door
-- matcher, name tokens (GIN on core.party_tokens). The insert safety net uses identifiers only:
-- every score ≥ 0.86 needs a shared tax id, email, phone or address (name-only rules score 0.82).
create index if not exists core_customers_party_email_idx on core.customers (org_id, core.party_norm_email(email));
create index if not exists core_customers_party_phone_idx on core.customers (org_id, core.party_norm_phone(phone));
create index if not exists core_customers_party_tax_idx   on core.customers (org_id, core.party_norm_tax(tax_id));
create index if not exists core_customers_party_addr_idx  on core.customers (org_id, btrim(zip), core.party_norm_text(address_line1));
create index if not exists core_customers_party_name_gin  on core.customers using gin (core.party_tokens(name));
create index if not exists core_customers_party_dname_gin on core.customers using gin (core.party_tokens(display_name));
create index if not exists core_vendors_party_email_idx   on core.vendors (org_id, core.party_norm_email(email));
create index if not exists core_vendors_party_phone_idx   on core.vendors (org_id, core.party_norm_phone(phone));
create index if not exists core_vendors_party_addr_idx    on core.vendors (org_id, btrim(zip), core.party_norm_text(address_line1));
create index if not exists core_vendors_party_name_gin    on core.vendors using gin (core.party_tokens(name));
create index if not exists core_vendors_party_dname_gin   on core.vendors using gin (core.party_tokens(display_name));
create index if not exists core_contacts_party_email_idx  on core.contacts (org_id, core.party_norm_email(email));
create index if not exists core_contacts_party_phone_idx  on core.contacts (org_id, core.party_norm_phone(phone));
create index if not exists core_contacts_party_name_gin   on core.contacts using gin (core.party_tokens(core.party_contact_name(first_name, last_name)));

-- Candidate ids by indexed key lookups (each branch is its own index probe). p_strong: identifiers
-- only (tax id, email, phone, ZIP + line 1) — the safety net; otherwise also name tokens and ZIP.
create or replace function core.party_candidate_ids(
  p_org uuid, p_kind text, p_tokens text[], p_email text, p_phone text, p_tax text, p_zip text, p_line1 text, p_strong boolean)
returns uuid[]
language plpgsql stable security definer
set search_path = core, public
as $$
declare v uuid[] := '{}'; v_line1 text := core.party_norm_text(p_line1);
begin
  if p_kind = 'customer' then
    if not p_strong and cardinality(p_tokens) > 0 then
      v := v || array(select c.id from core.customers c where c.org_id = p_org and core.party_tokens(c.name) && p_tokens)
             || array(select c.id from core.customers c where c.org_id = p_org and core.party_tokens(c.display_name) && p_tokens);
    end if;
    if p_email is not null then v := v || array(select c.id from core.customers c where c.org_id = p_org and core.party_norm_email(c.email) = p_email); end if;
    if p_phone is not null then v := v || array(select c.id from core.customers c where c.org_id = p_org and core.party_norm_phone(c.phone) = p_phone); end if;
    if p_tax is not null then v := v || array(select c.id from core.customers c where c.org_id = p_org and core.party_norm_tax(c.tax_id) = p_tax); end if;
    if p_zip is not null and (not p_strong or v_line1 <> '') then
      v := v || array(select c.id from core.customers c where c.org_id = p_org and btrim(c.zip) = p_zip
                         and (not p_strong or core.party_norm_text(c.address_line1) = v_line1));
    end if;
  elsif p_kind = 'vendor' then
    if not p_strong and cardinality(p_tokens) > 0 then
      v := v || array(select c.id from core.vendors c where c.org_id = p_org and core.party_tokens(c.name) && p_tokens)
             || array(select c.id from core.vendors c where c.org_id = p_org and core.party_tokens(c.display_name) && p_tokens);
    end if;
    if p_email is not null then v := v || array(select c.id from core.vendors c where c.org_id = p_org and core.party_norm_email(c.email) = p_email); end if;
    if p_phone is not null then v := v || array(select c.id from core.vendors c where c.org_id = p_org and core.party_norm_phone(c.phone) = p_phone); end if;
    if p_zip is not null and (not p_strong or v_line1 <> '') then
      v := v || array(select c.id from core.vendors c where c.org_id = p_org and btrim(c.zip) = p_zip
                         and (not p_strong or core.party_norm_text(c.address_line1) = v_line1));
    end if;
  elsif p_kind = 'contact' then
    if not p_strong and cardinality(p_tokens) > 0 then
      v := v || array(select k.id from core.contacts k where k.org_id = p_org
                         and core.party_tokens(core.party_contact_name(k.first_name, k.last_name)) && p_tokens);
    end if;
    if p_email is not null then v := v || array(select k.id from core.contacts k where k.org_id = p_org and core.party_norm_email(k.email) = p_email); end if;
    if p_phone is not null then v := v || array(select k.id from core.contacts k where k.org_id = p_org and core.party_norm_phone(k.phone) = p_phone); end if;
  end if;
  return array(select distinct x from unnest(v) x);
end $$;

-- Candidates of one kind in one org, scored (internal; no capability check — callers check).
drop function if exists core.party_candidates(uuid, text, text[], text, text, text, text, text, uuid);
create or replace function core.party_candidates(
  p_org uuid, p_kind text, p_names text[], p_email text, p_phone text, p_line1 text, p_zip text, p_tax text,
  p_exclude uuid default null, p_strong boolean default false)
returns table (id uuid, name text, score numeric, matched text[], email text, phone text, city text,
               created_at timestamptz, books_since date, source text, location_id uuid)
language plpgsql stable security definer
set search_path = core, crm, pm, public
as $$
declare
  v_tokens text[] := (select coalesce(array_agg(distinct t), '{}') from unnest(coalesce(p_names, '{}')) n, unnest(core.party_tokens(n)) t);
  v_email text := core.party_norm_email(p_email);
  v_phone text := core.party_norm_phone(p_phone);
  v_tax text := core.party_norm_tax(p_tax);
  v_zip text := nullif(btrim(coalesce(p_zip, '')), '');
  v_ids uuid[];
begin
  if v_phone is not null and length(v_phone) <> 10 then v_phone := null; end if;
  if length(v_tax) < 4 then v_tax := null; end if;
  if p_kind not in ('customer','vendor','contact') then
    raise exception 'CORE_INVALID: kind must be customer, vendor or contact' using errcode = '22023';
  end if;
  v_ids := core.party_candidate_ids(p_org, p_kind, v_tokens, v_email, v_phone, case when p_kind = 'customer' then v_tax end,
                                    v_zip, p_line1, coalesce(p_strong, false));
  if p_exclude is not null then v_ids := array_remove(v_ids, p_exclude); end if;
  if cardinality(v_ids) = 0 then return; end if;
  if p_kind = 'customer' then
    return query
      select c.id, c.name, s.score, s.matched, c.email, c.phone, c.city, c.created_at, b.since,
             case when b.since is not null then 'books'
                  when exists (select 1 from core.jobs j where j.customer_id = c.id) or exists (select 1 from crm.leads l where l.customer_id = c.id) then 'projects'
                  else 'unused' end,
             c.location_id
        from core.customers c
        cross join lateral core.party_score(p_names, array[c.name, c.display_name], p_email, c.email, p_phone, c.phone,
                                            p_line1, c.address_line1, p_zip, c.zip, p_tax, c.tax_id) s
        cross join lateral (select least((select min(i.invoice_date) from public.invoices i where i.customer_id = c.id and i.status <> 'VOIDED'),
                                         (select min(cp.payment_date) from public.customer_payments cp where cp.customer_id = c.id)) as since) b
       where c.id = any (v_ids) and c.org_id = p_org and c.deleted_at is null and c.merged_into is null
         and s.score is not null;
  elsif p_kind = 'vendor' then
    return query
      select v.id, v.name, s.score, s.matched, v.email, v.phone, v.city, v.created_at, b.since,
             case when b.since is not null then 'books'
                  when exists (select 1 from pm.commitments k where k.vendor_id = v.id) then 'projects'
                  else 'unused' end,
             null::uuid
        from core.vendors v
        cross join lateral core.party_score(p_names, array[v.name, v.display_name], p_email, v.email, p_phone, v.phone,
                                            p_line1, v.address_line1, p_zip, v.zip, null, null) s
        cross join lateral (select (select min(x.bill_date) from public.bills x where x.vendor_id = v.id) as since) b
       where v.id = any (v_ids) and v.org_id = p_org and v.deleted_at is null and v.merged_into is null
         and s.score is not null;
  else
    return query
      select k.id, core.party_contact_name(k.first_name, k.last_name), s.score, s.matched, k.email, k.phone,
             null::text, k.created_at, null::date,
             case when exists (select 1 from crm.leads l where l.contact_id = k.id) then 'crm' else 'core' end,
             (select c.location_id from core.customers c where c.id = k.customer_id)
        from core.contacts k
        cross join lateral core.party_score(p_names, array[core.party_contact_name(k.first_name, k.last_name)],
                                            p_email, k.email, p_phone, k.phone, null, null, null, null, null, null) s
       where k.id = any (v_ids) and k.org_id = p_org and k.identity_status = 'active'
         and s.score is not null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. crm tables
-- ----------------------------------------------------------------------------
create table if not exists crm.pipeline_templates (
  pack_key   text not null,
  key        text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name       text not null,
  sort       int not null default 0,
  is_default boolean not null default false,
  stages     jsonb not null,                 -- [{key, name, kind, p}] in board order
  primary key (pack_key, key)
);
comment on table crm.pipeline_templates is '1111: default pipelines per industry pack (catalog; crm.ensure_pipelines copies them per company).';

create table if not exists crm.pipelines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name        text not null check (char_length(name) between 1 and 120),
  pack_key    text,
  is_default  boolean not null default false,
  sort        int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, location_id, key)
);
create unique index if not exists crm_pipelines_one_default_uidx on crm.pipelines (location_id) where is_default;

create table if not exists crm.pipeline_stages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  pipeline_id     uuid not null references crm.pipelines(id) on delete cascade,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name            text not null check (char_length(name) between 1 and 120),
  kind            text not null check (kind in ('open','won','lost')),
  probability_pct int not null default 0 check (probability_pct between 0 and 100),
  sort            int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (pipeline_id, key)
);

create table if not exists crm.leads (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  pipeline_id            uuid not null references crm.pipelines(id),
  stage_id               uuid not null references crm.pipeline_stages(id),
  title                  text not null check (char_length(title) between 1 and 200),
  customer_id            uuid references core.customers(id),
  contact_id             uuid references core.contacts(id),
  site_id                uuid references core.sites(id),
  source                 text check (source is null or char_length(source) <= 80),
  source_detail          text check (source_detail is null or char_length(source_detail) <= 500),
  campaign               text check (campaign is null or char_length(campaign) <= 200),
  owner_membership_id    uuid references core.memberships(id),
  estimated_value_cents  bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  expected_close_on      date,
  next_step              text check (next_step is null or char_length(next_step) <= 500),
  next_step_on           date,
  lost_reason            text check (lost_reason is null or char_length(lost_reason) <= 500),
  won_at                 timestamptz,
  lost_at                timestamptz,
  converted_estimate_id  uuid references pm.estimates(id),
  converted_job_id       uuid references core.jobs(id),
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint leads_won_lost_chk check (won_at is null or lost_at is null),
  constraint leads_lost_reason_chk check (lost_at is null or lost_reason is not null)
);
create index if not exists crm_leads_board_idx on crm.leads (org_id, location_id, pipeline_id, stage_id);
create index if not exists crm_leads_customer_idx on crm.leads (org_id, customer_id) where customer_id is not null;
create index if not exists crm_leads_contact_idx on crm.leads (contact_id) where contact_id is not null;
create index if not exists crm_leads_job_idx on crm.leads (converted_job_id) where converted_job_id is not null;

create table if not exists crm.lead_stage_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  lead_id        uuid not null references crm.leads(id) on delete cascade,
  from_stage_id  uuid references crm.pipeline_stages(id),
  to_stage_id    uuid not null references crm.pipeline_stages(id),
  reason         text,
  actor_id       text default pm.current_user_id(),
  created_at     timestamptz not null default now()
);
create index if not exists crm_lead_stage_events_lead_idx on crm.lead_stage_events (lead_id, created_at);

create table if not exists crm.activities (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  lead_id      uuid references crm.leads(id) on delete set null,
  customer_id  uuid references core.customers(id),
  contact_id   uuid references core.contacts(id),
  job_id       uuid references core.jobs(id),
  kind         text not null check (kind in ('call','sms','email','meeting','site_visit','note','portal_message','signed_document')),
  direction    text check (direction is null or direction in ('inbound','outbound')),
  subject      text check (subject is null or char_length(subject) <= 300),
  body         text check (body is null or char_length(body) <= 20000),
  outcome      text check (outcome is null or char_length(outcome) <= 500),
  occurred_at  timestamptz not null default now(),
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now()
);
create index if not exists crm_activities_lead_idx on crm.activities (lead_id, occurred_at desc) where lead_id is not null;
create index if not exists crm_activities_customer_idx on crm.activities (org_id, customer_id, occurred_at desc) where customer_id is not null;
create index if not exists crm_activities_job_idx on crm.activities (job_id, occurred_at desc) where job_id is not null;

create table if not exists crm.followups (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid references core.locations(id),          -- = the lead's company (trigger)
  lead_id                 uuid not null references crm.leads(id) on delete cascade,
  customer_id             uuid references core.customers(id),
  due_on                  date not null,
  kind                    text not null default 'follow_up' check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  title                   text check (title is null or char_length(title) <= 300),
  notes                   text check (notes is null or char_length(notes) <= 5000),
  assigned_membership_id  uuid references core.memberships(id),
  cadence_key             text check (cadence_key is null or cadence_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  done_at                 timestamptz,
  done_by                 text,
  outcome                 text check (outcome is null or char_length(outcome) <= 500),
  created_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists crm_followups_open_idx on crm.followups (org_id, due_on) where done_at is null;
create index if not exists crm_followups_lead_idx on crm.followups (lead_id);

-- crm triggers: updated_at; lead references in org + stage in pipeline in company;
-- follow-up company / customer from its lead.
create or replace function crm.tg_touch() returns trigger
language plpgsql
set search_path = crm, public
as $$ begin new.updated_at := now(); return new; end $$;

create or replace function crm.tg_lead_guard() returns trigger
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare v_pipe crm.pipelines%rowtype; v_stage_pipe uuid; c core.contacts%rowtype;
begin
  if not exists (select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'CRM_REF_ORG_MISMATCH: company % is not in org %', new.location_id, new.org_id using errcode = '23503';
  end if;
  select * into v_pipe from crm.pipelines p where p.id = new.pipeline_id;
  if v_pipe.id is null or v_pipe.org_id <> new.org_id or v_pipe.location_id <> new.location_id then
    raise exception 'CRM_INVALID: pipeline % is not a pipeline of this company', new.pipeline_id using errcode = '22023';
  end if;
  select s.pipeline_id into v_stage_pipe from crm.pipeline_stages s where s.id = new.stage_id;
  if v_stage_pipe is distinct from new.pipeline_id then
    raise exception 'CRM_INVALID: stage % is not a stage of pipeline %', new.stage_id, new.pipeline_id using errcode = '22023';
  end if;
  if new.customer_id is not null and not exists (select 1 from core.customers x where x.id = new.customer_id and x.org_id = new.org_id) then
    raise exception 'CRM_REF_ORG_MISMATCH: customer % is not in org', new.customer_id using errcode = '23503';
  end if;
  if new.contact_id is not null then
    select * into c from core.contacts x where x.id = new.contact_id;
    if c.id is null or c.org_id <> new.org_id then
      raise exception 'CRM_REF_ORG_MISMATCH: contact % is not in org', new.contact_id using errcode = '23503';
    end if;
  end if;
  if new.site_id is not null and not exists (select 1 from core.sites x where x.id = new.site_id and x.org_id = new.org_id
                                               and (new.customer_id is null or x.customer_id = new.customer_id)) then
    raise exception 'CRM_REF_ORG_MISMATCH: site % is not a site of the lead''s customer', new.site_id using errcode = '23503';
  end if;
  if new.owner_membership_id is not null and not exists (select 1 from core.memberships m where m.id = new.owner_membership_id and m.org_id = new.org_id) then
    raise exception 'CRM_REF_ORG_MISMATCH: owner % is not a seat in org', new.owner_membership_id using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

create or replace function crm.tg_followup_defaults() returns trigger
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare l crm.leads%rowtype;
begin
  select * into l from crm.leads x where x.id = new.lead_id;
  if l.id is null or l.org_id <> new.org_id then
    raise exception 'CRM_REF_ORG_MISMATCH: lead % is not in org %', new.lead_id, new.org_id using errcode = '23503';
  end if;
  new.location_id := l.location_id;
  if tg_op = 'INSERT' then
    new.customer_id := coalesce(new.customer_id, l.customer_id);
    if current_user in ('authenticated', 'anon') then new.created_by := pm.current_user_id(); end if;
  else
    new.updated_at := now();
    if current_user in ('authenticated', 'anon') then new.created_by := old.created_by; end if;
  end if;
  if new.customer_id is not null and not exists (select 1 from core.customers x where x.id = new.customer_id and x.org_id = new.org_id) then
    raise exception 'CRM_REF_ORG_MISMATCH: customer % is not in org', new.customer_id using errcode = '23503';
  end if;
  if new.assigned_membership_id is not null and not exists (select 1 from core.memberships m where m.id = new.assigned_membership_id and m.org_id = new.org_id) then
    raise exception 'CRM_REF_ORG_MISMATCH: assignee % is not a seat in org', new.assigned_membership_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists trg_touch on crm.pipelines;
create trigger trg_touch before update on crm.pipelines for each row execute function crm.tg_touch();
drop trigger if exists trg_touch on crm.pipeline_stages;
create trigger trg_touch before update on crm.pipeline_stages for each row execute function crm.tg_touch();
drop trigger if exists trg_lead_guard on crm.leads;
create trigger trg_lead_guard before insert or update on crm.leads for each row execute function crm.tg_lead_guard();
-- H2: a member's direct write of a lead's customer / contact / site must name records the member
-- already sees. Invoker on purpose: current_user is the member for PostgREST writes and the owner
-- inside definer functions (create_lead / convert_lead / merge_parties check or own their writes).
create or replace function crm.tg_lead_reach() returns trigger
language plpgsql
set search_path = crm, public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if (tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id) and not crm.party_visible('customer', new.customer_id)
     or (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id) and not crm.party_visible('contact', new.contact_id)
     or (tg_op = 'INSERT' or new.site_id is distinct from old.site_id) and not crm.party_visible('site', new.site_id) then
    raise exception 'CRM_FORBIDDEN: the customer, contact or site is not one you can see' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_lead_reach on crm.leads;
create trigger trg_lead_reach before insert or update of customer_id, contact_id, site_id on crm.leads
  for each row execute function crm.tg_lead_reach();
drop trigger if exists trg_followup_defaults on crm.followups;
create trigger trg_followup_defaults before insert or update on crm.followups for each row execute function crm.tg_followup_defaults();

-- ----------------------------------------------------------------------------
-- 5. Pipeline catalog (one default pipeline per pack; field service also has renewals)
-- ----------------------------------------------------------------------------
insert into crm.pipeline_templates as t (pack_key, key, name, sort, is_default, stages) values
  ('residential_remodel', 'remodel_sales', 'Remodel sales', 0, true, $j$[
    {"key":"new","name":"New","kind":"open","p":10},{"key":"contacted","name":"Contacted","kind":"open","p":15},
    {"key":"consult_scheduled","name":"Consult scheduled","kind":"open","p":25},{"key":"consult_done","name":"Consult done","kind":"open","p":35},
    {"key":"design_agreement","name":"Design agreement","kind":"open","p":50},{"key":"proposal_sent","name":"Proposal sent","kind":"open","p":60},
    {"key":"negotiating","name":"Negotiating","kind":"open","p":75},{"key":"won","name":"Won","kind":"won","p":100},
    {"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('home_builder', 'new_home_sales', 'New home sales', 0, true, $j$[
    {"key":"inquiry","name":"Inquiry","kind":"open","p":10},{"key":"lot_plan_fit","name":"Lot and plan fit","kind":"open","p":25},
    {"key":"preconstruction_agreement","name":"Preconstruction agreement","kind":"open","p":45},{"key":"pricing","name":"Pricing","kind":"open","p":65},
    {"key":"contract_signed","name":"Contract signed","kind":"won","p":100},{"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('commercial_gc', 'bid_board', 'Bid board', 0, true, $j$[
    {"key":"itb","name":"ITB","kind":"open","p":5},{"key":"bid_no_bid","name":"Bid/no-bid","kind":"open","p":10},
    {"key":"estimating","name":"Estimating","kind":"open","p":20},{"key":"bid_submitted","name":"Bid submitted","kind":"open","p":30},
    {"key":"shortlisted","name":"Shortlisted","kind":"open","p":50},{"key":"awarded","name":"Awarded","kind":"won","p":100},
    {"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('specialty_trade', 'bid_board', 'Bid board', 0, true, $j$[
    {"key":"itb","name":"ITB","kind":"open","p":5},{"key":"bid_no_bid","name":"Bid/no-bid","kind":"open","p":10},
    {"key":"estimating","name":"Estimating","kind":"open","p":20},{"key":"bid_submitted","name":"Bid submitted","kind":"open","p":30},
    {"key":"shortlisted","name":"Shortlisted","kind":"open","p":50},{"key":"awarded","name":"Awarded","kind":"won","p":100},
    {"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('field_service', 'replacement_sales', 'Replacement sales', 0, true, $j$[
    {"key":"lead_set","name":"Lead set","kind":"open","p":10},{"key":"appointment_booked","name":"Appointment booked","kind":"open","p":30},
    {"key":"options_presented","name":"Options presented","kind":"open","p":50},{"key":"follow_up","name":"Follow-up","kind":"open","p":60},
    {"key":"sold","name":"Sold","kind":"won","p":100},{"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('field_service', 'agreement_renewals', 'Agreement renewals', 1, false, $j$[
    {"key":"due_90","name":"Due 90","kind":"open","p":60},{"key":"due_60","name":"Due 60","kind":"open","p":70},
    {"key":"due_30","name":"Due 30","kind":"open","p":80},{"key":"renewed","name":"Renewed","kind":"won","p":100},
    {"key":"lapsed","name":"Lapsed","kind":"lost","p":0}]$j$::jsonb),
  ('manufacturing_eto', 'rfq', 'RFQs', 0, true, $j$[
    {"key":"rfq","name":"RFQ","kind":"open","p":10},{"key":"qualified","name":"Qualified","kind":"open","p":20},
    {"key":"drawings_takeoff","name":"Drawings and takeoff","kind":"open","p":35},{"key":"quote_sent","name":"Quote sent","kind":"open","p":50},
    {"key":"revision","name":"Revision","kind":"open","p":65},{"key":"po_received","name":"PO received","kind":"won","p":100},
    {"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('flooring', 'flooring_sales', 'Flooring sales', 0, true, $j$[
    {"key":"lead","name":"Lead","kind":"open","p":10},{"key":"measure_scheduled","name":"Measure scheduled","kind":"open","p":30},
    {"key":"measured","name":"Measured","kind":"open","p":45},{"key":"quote_sent","name":"Quote sent","kind":"open","p":60},
    {"key":"sold","name":"Sold","kind":"won","p":100},{"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('interior_design', 'design_clients', 'New clients', 0, true, $j$[
    {"key":"inquiry","name":"Inquiry","kind":"open","p":10},{"key":"discovery_call","name":"Discovery call","kind":"open","p":30},
    {"key":"design_agreement","name":"Design agreement","kind":"open","p":60},{"key":"retainer_paid","name":"Retainer paid","kind":"won","p":100},
    {"key":"declined","name":"Declined","kind":"lost","p":0}]$j$::jsonb),
  ('equipment_dealer', 'unit_sales', 'Unit sales', 0, true, $j$[
    {"key":"lead","name":"Lead","kind":"open","p":10},{"key":"contacted","name":"Contacted","kind":"open","p":20},
    {"key":"demo_quote","name":"Demo/quote","kind":"open","p":35},{"key":"trade_appraisal","name":"Trade appraisal","kind":"open","p":50},
    {"key":"financing","name":"Financing","kind":"open","p":65},{"key":"deal_desk","name":"Deal desk","kind":"open","p":80},
    {"key":"delivered","name":"Delivered","kind":"won","p":100},{"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('real_estate_development', 'acquisitions', 'Acquisitions', 0, true, $j$[
    {"key":"site_identified","name":"Site identified","kind":"open","p":5},{"key":"loi","name":"LOI","kind":"open","p":15},
    {"key":"due_diligence","name":"Due diligence","kind":"open","p":30},{"key":"entitlement","name":"Entitlement","kind":"open","p":50},
    {"key":"financing_committed","name":"Financing committed","kind":"open","p":75},{"key":"closed","name":"Closed","kind":"won","p":100},
    {"key":"dead","name":"Dead","kind":"lost","p":0}]$j$::jsonb),
  ('professional_services', 'engagements', 'Engagements', 0, true, $j$[
    {"key":"inquiry","name":"Inquiry","kind":"open","p":10},{"key":"discovery","name":"Discovery","kind":"open","p":30},
    {"key":"proposal","name":"Proposal","kind":"open","p":60},{"key":"sow_signed","name":"SOW signed","kind":"won","p":100},
    {"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb),
  ('general', 'sales', 'Sales', 0, true, $j$[
    {"key":"new","name":"New","kind":"open","p":10},{"key":"contacted","name":"Contacted","kind":"open","p":25},
    {"key":"qualified","name":"Qualified","kind":"open","p":40},{"key":"proposal_sent","name":"Proposal sent","kind":"open","p":60},
    {"key":"won","name":"Won","kind":"won","p":100},{"key":"lost","name":"Lost","kind":"lost","p":0}]$j$::jsonb)
on conflict (pack_key, key) do update set name = excluded.name, sort = excluded.sort, is_default = excluded.is_default, stages = excluded.stages;

-- Seed the company's pipelines from its installed primary pack ('general' without one).
-- Idempotent: existing pipelines / stages (and a tenant's renames) are never changed; the pack's
-- default pipeline becomes the company default when the default belongs to another pack.
create or replace function crm.ensure_pipelines(p_location uuid) returns integer
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare v_org uuid; v_pack text; t record; v_pid uuid; v_new uuid; n int := 0; v_default text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null then return 0; end if;
  select i.pack_key into v_pack from pm.pack_installs i
   where i.org_id = v_org and i.location_id = p_location and i.role = 'primary' and i.status = 'ACTIVE'
   order by i.installed_at desc limit 1;
  if v_pack is null or not exists (select 1 from crm.pipeline_templates x where x.pack_key = v_pack) then v_pack := 'general'; end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.pipelines:' || p_location::text, 0));
  for t in select * from crm.pipeline_templates x where x.pack_key = v_pack order by x.sort, x.key loop
    v_new := null;
    insert into crm.pipelines (org_id, location_id, key, name, pack_key, is_default, sort)
    values (v_org, p_location, t.key, t.name, v_pack, false, t.sort)
    on conflict (org_id, location_id, key) do nothing
    returning id into v_new;
    if v_new is not null then n := n + 1; end if;
    select p.id into v_pid from crm.pipelines p where p.org_id = v_org and p.location_id = p_location and p.key = t.key;
    insert into crm.pipeline_stages (org_id, pipeline_id, key, name, kind, probability_pct, sort)
    select v_org, v_pid, s ->> 'key', s ->> 'name', s ->> 'kind', (s ->> 'p')::int, (o * 10)::int
      from jsonb_array_elements(t.stages) with ordinality as x(s, o)
    on conflict (pipeline_id, key) do nothing;
  end loop;
  select x.key into v_default from crm.pipeline_templates x where x.pack_key = v_pack and x.is_default order by x.sort limit 1;
  if v_default is not null and not exists (select 1 from crm.pipelines p where p.org_id = v_org and p.location_id = p_location
                                                and p.key = v_default and p.is_default) then
    update crm.pipelines set is_default = false where org_id = v_org and location_id = p_location and is_default;
    update crm.pipelines set is_default = true where org_id = v_org and location_id = p_location and key = v_default;
  end if;
  return n;
end $$;
comment on function crm.ensure_pipelines(uuid) is '1111: seed a company''s pipelines from its primary pack (internal; idempotent).';

create or replace function crm.tg_pack_install_pipelines() returns trigger
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
begin
  begin
    perform crm.ensure_pipelines(new.location_id);
  exception when others then
    raise warning 'crm.ensure_pipelines(%) failed: %', new.location_id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_crm_pipelines on pm.pack_installs;
create trigger trg_crm_pipelines after insert or update of pack_key, role, status on pm.pack_installs
  for each row when (new.role = 'primary' and new.status = 'ACTIVE')
  execute function crm.tg_pack_install_pipelines();

-- ----------------------------------------------------------------------------
-- 6. Access registries + guards
-- ----------------------------------------------------------------------------
create table if not exists crm.access_table_classes (
  table_name text primary key,
  class      text not null check (class in ('C','S','O')),
  note       text
);
comment on table crm.access_table_classes is '1111: the access class of every base table in schema crm (C company / S settings / O catalog). A guard test fails for any unclassified table.';
insert into crm.access_table_classes as t (table_name, class, note) values
  ('pipelines',            'S', 'read: Projects members of the company; write: projects.settings:configure'),
  ('pipeline_stages',      'S', 'parent pipelines'),
  ('leads',                'C', 'projects.leads at the company (+ leads converted to the caller''s own jobs)'),
  ('lead_stage_events',    'C', 'parent leads; written only by crm functions'),
  ('activities',           'C', 'projects.leads at the company, or a reachable job; written only by crm.log_activity'),
  ('followups',            'C', 'projects.leads at the company, or assigned to the caller'),
  ('pipeline_templates',   'O', 'catalog'),
  ('access_table_classes', 'O', 'catalog'),
  ('access_rpc_registry',  'O', 'catalog')
on conflict (table_name) do update set class = excluded.class, note = excluded.note;

create table if not exists crm.access_rpc_registry (
  schema_name   text not null check (schema_name in ('crm','core')),
  function_name text not null,
  kind          text not null check (kind in ('rpc','helper')),
  reason        text not null,
  primary key (schema_name, function_name)
);
comment on table crm.access_rpc_registry is
  '1111: every member-executable SECURITY DEFINER function in crm, and every 1111 core function, with how it is checked. crm.access_unregistered_rpcs() must be empty.';
insert into crm.access_rpc_registry as r (schema_name, function_name, kind, reason) values
  ('core', 'match_parties',     'rpc',    'org guard; projects customer / lead / purchasing grants, or a non-Projects-only (Books) seat'),
  ('core', 'merge_parties',     'rpc',    'org guard; cross-tenant refused; projects.customers:edit at both companies or Books mdm.*:edit; Books money conflicts need owner / mdm.*:edit'),
  ('core', 'dismiss_duplicate', 'rpc',    'org guard; same edit rule as merge_parties'),
  ('core', 'create_contact',    'rpc',    'org guard; projects.customers:create on the customer / leads:create for a prospect / purchasing for a vendor, or Books mdm.*:edit'),
  ('core', 'create_site',       'rpc',    'org guard; projects.customers:create at the company or Books mdm.customers:edit'),
  ('crm',  'create_lead',       'rpc',    'org guard; projects.leads:create at the company'),
  ('crm',  'move_lead',         'rpc',    'org guard; projects.leads:edit at the lead''s company'),
  ('crm',  'log_activity',      'rpc',    'org guard; projects.leads:create at the company, or projects.jobs:edit on the job'),
  ('crm',  'complete_followup', 'rpc',    'org guard; projects.leads:edit at the company, or the assignee'),
  ('crm',  'convert_lead',      'rpc',    'org guard; projects.leads:edit + estimates:create (estimate) or jobs:create (job) at the company'),
  ('crm',  'my_customer_ids',   'helper', 'the caller''s own customer reach (RLS building block)'),
  ('crm',  'my_customer_ids_with', 'helper', 'the caller''s own customer reach for cap:action (RLS building block)'),
  ('crm',  'can_see_vendors',   'helper', 'the caller''s own grants (RLS building block)'),
  ('crm',  'ar_customer_ids',   'helper', 'the caller''s own AR visibility (view masking)'),
  ('crm',  'my_contact_ids',    'helper', 'the caller''s own contact reach (RLS building block)'),
  ('crm',  'my_site_ids',       'helper', 'the caller''s own site reach (RLS building block)'),
  ('crm',  'party_visible',     'helper', 'is a record already visible to the caller (lead / activity attach checks)'),
  ('crm',  'books_job_location_ids', 'helper', 'the caller''s own Books job visibility (view masking)')
on conflict (schema_name, function_name) do update set kind = excluded.kind, reason = excluded.reason;
delete from crm.access_rpc_registry where schema_name = 'crm' and function_name = 'ar_location_ids';

create or replace function crm.access_unclassified_tables() returns setof text
language sql stable
set search_path = crm, public
as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relkind in ('r', 'p')
     and not exists (select 1 from crm.access_table_classes a where a.table_name = c.relname)
   order by 1
$$;

-- Classified C / S tables without RLS or their restrictive class policies (guard: empty).
create or replace function crm.access_policy_gaps() returns setof text
language sql stable
set search_path = crm, public
as $$
  select a.table_name || ':' || p.pol
    from crm.access_table_classes a
    join pg_class c on c.relname = a.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'crm'
    cross join unnest(array['rls','crm_access_select','crm_access_insert','crm_access_update','crm_access_delete']) as p(pol)
   where a.class in ('C','S')
     and case when p.pol = 'rls' then not c.relrowsecurity
              else not exists (select 1 from pg_policy x where x.polrelid = c.oid and x.polname = p.pol and not x.polpermissive) end
  union all
  select a.table_name || ':rls' from crm.access_table_classes a
    join pg_class c on c.relname = a.table_name join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'crm'
   where a.class = 'O' and not c.relrowsecurity
   order by 1
$$;

create or replace function crm.access_unregistered_rpcs() returns setof text
language sql stable
set search_path = crm, public
as $$
  select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef
     and (n.nspname = 'crm' or (n.nspname = 'core' and coalesce(obj_description(p.oid, 'pg_proc'), '') like '1111:%'))
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
     and not exists (select 1 from crm.access_rpc_registry r where r.schema_name = n.nspname and r.function_name = p.proname)
   order by 1
$$;

-- ----------------------------------------------------------------------------
-- 7. Access helpers (STABLE definer; called as uncorrelated subqueries)
-- ----------------------------------------------------------------------------
create or replace function crm.customer_caps() returns text[]
language sql immutable
as $$ select array['projects.customers','projects.leads','projects.estimates','projects.store','projects.dispatch','projects.jobs_all']::text[] $$;

-- Customers the caller reaches through Projects (same rule as 1110's v_core_customers_masked).
create or replace function crm.my_customer_ids() returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select c.id from core.customers c where public.get_org_id() is null or c.org_id = public.get_org_id();
    return;
  end if;
  return query
    select c.id from core.customers c
     where c.org_id = public.get_org_id()
       and ((c.location_id is null and (select pm.can_any(crm.customer_caps(), 'view')))
            or c.location_id in (select pm.my_location_ids_any(crm.customer_caps(), 'view'))
            or c.id in (select j.customer_id from core.jobs j where j.org_id = public.get_org_id() and j.id in (select pm.my_job_ids()))
            or c.id in (select l.customer_id from crm.leads l
                         where l.org_id = public.get_org_id() and l.location_id in (select pm.my_location_ids('projects.leads', 'view'))));
end $$;

-- Customers the caller may do cap:action on (company of the customer; any company when the
-- customer has none; the customer of a reachable job at a company where they hold it).
create or replace function crm.my_customer_ids_with(p_cap text, p_action text) returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
declare v_all boolean;
begin
  if pm.access_is_service() then
    return query select c.id from core.customers c where public.get_org_id() is null or c.org_id = public.get_org_id();
    return;
  end if;
  -- an org-level customer (no company) is reached only with the grant at every company (M3)
  v_all := not exists (select 1 from core.locations l where l.org_id = public.get_org_id()
                         and l.id not in (select pm.my_location_ids(p_cap, p_action)));
  return query
    select c.id from core.customers c
     where c.org_id = public.get_org_id()
       and ((c.location_id is null and v_all)
            or c.location_id in (select pm.my_location_ids(p_cap, p_action))
            or c.id in (select j.customer_id from core.jobs j where j.org_id = public.get_org_id()
                          and j.id in (select pm.my_job_ids_with(p_cap, p_action))));
end $$;

create or replace function crm.can_see_vendors() returns boolean
language sql stable security definer
set search_path = crm, pm, core, public
as $$
  select pm.can_any(array['projects.commitments','projects.store','projects.financials','projects.selections','projects.settings']::text[], 'view')
$$;

-- Customers whose AR / balances the caller may read.
create or replace function crm.ar_customer_ids() returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select c.id from core.customers c where public.get_org_id() is null or c.org_id = public.get_org_id();
    return;
  end if;
  -- M2 (security review): AR is job-scoped for Projects — the customer of a job where the caller
  -- holds projects.contract_value — or Books AR (ar.invoices:view) at the customer's company.
  return query
    select j.customer_id from core.jobs j
     where j.org_id = public.get_org_id() and j.customer_id is not null
       and j.id in (select pm.my_money_job_ids('projects.contract_value'))
    union
    select c.id from core.customers c
     where c.org_id = public.get_org_id()
       and ((c.location_id is not null and c.location_id in (select l.id from core.locations l where l.org_id = public.get_org_id()
                                                                  and core.has_capability('ar.invoices', 'view', l.id)))
            or (c.location_id is null and core.has_capability('ar.invoices', 'view')));
end $$;

-- Contacts the caller reaches through Projects (the narrowing of core.contacts for Projects-only
-- seats): contacts of reachable customers, vendor contacts with a purchasing / store / settings
-- grant, prospect contacts on a lead the caller sees, and prospect contacts the caller added.
create or replace function crm.my_contact_ids() returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select k.id from core.contacts k where public.get_org_id() is null or k.org_id = public.get_org_id();
    return;
  end if;
  return query
    select k.id from core.contacts k
     where k.org_id = public.get_org_id()
       and (k.customer_id in (select crm.my_customer_ids())
            or (k.vendor_id is not null and (select crm.can_see_vendors()))
            or k.id in (select l.contact_id from crm.leads l
                         where l.org_id = public.get_org_id() and l.contact_id is not null
                           and l.location_id in (select pm.my_location_ids('projects.leads', 'view')))
            or (k.customer_id is null and k.vendor_id is null and k.created_by is not null and k.created_by = pm.current_user_id()));
end $$;

-- Sites the caller reaches through Projects.
create or replace function crm.my_site_ids() returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select x.id from core.sites x where public.get_org_id() is null or x.org_id = public.get_org_id();
    return;
  end if;
  return query
    select x.id from core.sites x
     where x.org_id = public.get_org_id()
       and (x.customer_id in (select crm.my_customer_ids())
            or x.location_id in (select pm.my_location_ids_any(array['projects.customers','projects.leads','projects.dispatch','projects.jobs_all']::text[], 'view')));
end $$;

-- Can the caller already see this record? (Every org row for a non-Projects-only seat.) Used to
-- refuse attaching an unreachable customer / contact / site to a lead or activity (H2).
create or replace function crm.party_visible(p_kind text, p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if p_id is null or pm.access_is_service() then return true; end if;
  if p_kind = 'customer' then
    if not exists (select 1 from core.customers c where c.id = p_id and c.org_id = public.get_org_id()) then return false; end if;
    return not core.is_projects_only_seat() or p_id in (select crm.my_customer_ids());
  elsif p_kind = 'contact' then
    if not exists (select 1 from core.contacts c where c.id = p_id and c.org_id = public.get_org_id()) then return false; end if;
    return not core.is_projects_only_seat() or p_id in (select crm.my_contact_ids());
  elsif p_kind = 'site' then
    if not exists (select 1 from core.sites c where c.id = p_id and c.org_id = public.get_org_id()) then return false; end if;
    return not core.is_projects_only_seat() or p_id in (select crm.my_site_ids());
  end if;
  return false;
end $$;

-- Companies where the caller reads Books job money (Books jobs.jobs:view).
create or replace function crm.books_job_location_ids() returns setof uuid
language plpgsql stable security definer
set search_path = crm, pm, core, public
as $$
begin
  if pm.access_is_service() then
    return query select l.id from core.locations l where public.get_org_id() is null or l.org_id = public.get_org_id();
    return;
  end if;
  return query
    select l.id from core.locations l where l.org_id = public.get_org_id() and core.has_capability('jobs.jobs', 'view', l.id);
end $$;

-- Does this customer / vendor carry Merit Books money records? (merge authority, M3)
create or replace function core.party_has_books_money(p_kind text, p_id uuid) returns boolean
language sql stable security definer
set search_path = core, public
as $$
  select case p_kind
    when 'customer' then exists (select 1 from public.invoices i where i.customer_id = p_id)
                      or exists (select 1 from public.customer_payments i where i.customer_id = p_id)
                      or exists (select 1 from public.customer_deposits i where i.customer_id = p_id)
    when 'vendor' then exists (select 1 from public.bills i where i.vendor_id = p_id)
                    or exists (select 1 from public.purchase_orders i where i.vendor_id = p_id)
                    or exists (select 1 from public.ap_checks i where i.payee_vendor_id = p_id)
    else false end
$$;

-- Owner / admin seat of the request org.
create or replace function core.party_caller_is_owner() returns boolean
language sql stable security definer
set search_path = core, public
as $$
  select coalesce((select core.rbac_normalize_legacy_role(ms.role) = 'company_admin'
                     from core.memberships ms where ms.id = core.client_scope_caller_membership()), false)
$$;

-- May the caller use taxpayer ids? Owner seats, or a role / permission set in effect whose Books
-- field policy reveals 'tin' (reveal_logged / visible). Used by the matcher (security re-review).
create or replace function core.party_caller_tin_ok() returns boolean
language sql stable security definer
set search_path = core, pm, public
as $$
  select pm.access_is_service() or core.party_caller_is_owner()
      or exists (
        select 1
          from core.access_assignments a
          left join core.role_definitions rd on a.grant_type = 'role' and rd.id = a.role_id
          left join core.permission_sets ps on a.grant_type = 'permission_set' and ps.id = a.permission_set_id
         where a.membership_id = core.client_scope_caller_membership()
           and a.status = 'active' and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
           and coalesce(rd.field_policy, ps.field_policy, '{}'::jsonb) ->> 'tin' in ('reveal_logged', 'visible'))
$$;


-- ----------------------------------------------------------------------------
-- 8. RLS
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pipelines','pipeline_stages','leads','lead_stage_events','activities','followups',
                           'pipeline_templates','access_table_classes','access_rpc_registry'] loop
    execute format('alter table crm.%I enable row level security', t);
  end loop;
  foreach t in array array['contacts','sites','duplicate_reviews'] loop
    execute format('alter table core.%I enable row level security', t);
  end loop;
end $$;

-- catalogs: read for members
do $$
declare t text;
begin
  foreach t in array array['pipeline_templates','access_table_classes','access_rpc_registry'] loop
    execute format('drop policy if exists catalog_read on crm.%I', t);
    execute format('create policy catalog_read on crm.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- crm: permissive org isolation + restrictive class rule
do $$
declare t text; r record;
begin
  foreach t in array array['pipelines','pipeline_stages','leads','lead_stage_events','activities','followups'] loop
    execute format('drop policy if exists org_isolation on crm.%I', t);
    execute format('create policy org_isolation on crm.%I for all to authenticated using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    for r in select polname from pg_policy where polrelid = format('crm.%I', t)::regclass and polname like 'crm\_access\_%' loop
      execute format('drop policy %I on crm.%I', r.polname, t);
    end loop;
  end loop;
end $$;

-- pipelines (S)
create policy crm_access_select on crm.pipelines as restrictive for select to authenticated
  using (location_id in (select pm.my_member_location_ids()));
create policy crm_access_insert on crm.pipelines as restrictive for insert to authenticated
  with check (location_id in (select pm.my_location_ids('projects.settings', 'configure')));
create policy crm_access_update on crm.pipelines as restrictive for update to authenticated
  using (location_id in (select pm.my_location_ids('projects.settings', 'configure')))
  with check (location_id in (select pm.my_location_ids('projects.settings', 'configure')));
create policy crm_access_delete on crm.pipelines as restrictive for delete to authenticated
  using (location_id in (select pm.my_location_ids('projects.settings', 'configure')));
-- pipeline_stages (S, parent pipelines)
create policy crm_access_select on crm.pipeline_stages as restrictive for select to authenticated
  using (pipeline_id in (select p.id from crm.pipelines p where p.org_id = public.get_org_id() and p.location_id in (select pm.my_member_location_ids())));
create policy crm_access_insert on crm.pipeline_stages as restrictive for insert to authenticated
  with check (pipeline_id in (select p.id from crm.pipelines p where p.org_id = public.get_org_id() and p.location_id in (select pm.my_location_ids('projects.settings', 'configure'))));
create policy crm_access_update on crm.pipeline_stages as restrictive for update to authenticated
  using (pipeline_id in (select p.id from crm.pipelines p where p.org_id = public.get_org_id() and p.location_id in (select pm.my_location_ids('projects.settings', 'configure'))))
  with check (pipeline_id in (select p.id from crm.pipelines p where p.org_id = public.get_org_id() and p.location_id in (select pm.my_location_ids('projects.settings', 'configure'))));
create policy crm_access_delete on crm.pipeline_stages as restrictive for delete to authenticated
  using (pipeline_id in (select p.id from crm.pipelines p where p.org_id = public.get_org_id() and p.location_id in (select pm.my_location_ids('projects.settings', 'configure'))));
-- leads (C)
-- H1 (security review): leads, their stage history and activities are read with projects.leads
-- only — a job team reaches lead context through pm.v_leads_masked (money and notes masked).
create policy crm_access_select on crm.leads as restrictive for select to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'view')));
create policy crm_access_insert on crm.leads as restrictive for insert to authenticated
  with check (location_id in (select pm.my_location_ids('projects.leads', 'create')));
create policy crm_access_update on crm.leads as restrictive for update to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'edit')))
  with check (location_id in (select pm.my_location_ids('projects.leads', 'edit')));
create policy crm_access_delete on crm.leads as restrictive for delete to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'delete')));
-- lead_stage_events (C, parent leads; function-written)
create policy crm_access_select on crm.lead_stage_events as restrictive for select to authenticated
  using (lead_id in (select l.id from crm.leads l where l.org_id = public.get_org_id()
                       and l.location_id in (select pm.my_location_ids('projects.leads', 'view'))));
create policy crm_access_insert on crm.lead_stage_events as restrictive for insert to authenticated with check (false);
create policy crm_access_update on crm.lead_stage_events as restrictive for update to authenticated using (false) with check (false);
create policy crm_access_delete on crm.lead_stage_events as restrictive for delete to authenticated using (false);
-- activities (C; function-written)
create policy crm_access_select on crm.activities as restrictive for select to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'view')));
create policy crm_access_insert on crm.activities as restrictive for insert to authenticated with check (false);
create policy crm_access_update on crm.activities as restrictive for update to authenticated using (false) with check (false);
create policy crm_access_delete on crm.activities as restrictive for delete to authenticated using (false);
-- followups (C)
create policy crm_access_select on crm.followups as restrictive for select to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'view'))
         or assigned_membership_id = (select pm.access_my_membership()));
create policy crm_access_insert on crm.followups as restrictive for insert to authenticated
  with check (location_id in (select pm.my_location_ids('projects.leads', 'create')));
create policy crm_access_update on crm.followups as restrictive for update to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'edit')) or assigned_membership_id = (select pm.access_my_membership()))
  with check (location_id in (select pm.my_location_ids('projects.leads', 'edit')) or assigned_membership_id = (select pm.access_my_membership()));
create policy crm_access_delete on crm.followups as restrictive for delete to authenticated
  using (location_id in (select pm.my_location_ids('projects.leads', 'delete')));

-- core.contacts / core.sites / core.duplicate_reviews: every seat reads its org (Books unchanged);
-- members update contacts / sites they may edit; Projects-only seats narrowed below.
do $$
declare t text;
begin
  foreach t in array array['contacts','sites','duplicate_reviews'] loop
    execute format('drop policy if exists org_isolation on core.%I', t);
    execute format('create policy org_isolation on core.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists member_update on core.contacts;
create policy member_update on core.contacts for update to authenticated
  using (org_id = public.get_org_id()
         and ((customer_id is not null and ((select core.has_capability('mdm.customers', 'edit'))
                                            or customer_id in (select crm.my_customer_ids_with('projects.customers', 'edit'))))
              or (vendor_id is not null and ((select core.has_capability('mdm.vendors', 'edit'))
                                             or (select pm.can_any(array['projects.commitments','projects.settings']::text[], 'edit'))
                                             or (select pm.can('projects.settings', 'configure'))))
              or (customer_id is null and vendor_id is null and (select pm.can_any(array['projects.leads','projects.customers']::text[], 'edit')))))
  with check (org_id = public.get_org_id()
         and ((customer_id is not null and ((select core.has_capability('mdm.customers', 'edit'))
                                            or customer_id in (select crm.my_customer_ids_with('projects.customers', 'edit'))))
              or (vendor_id is not null and ((select core.has_capability('mdm.vendors', 'edit'))
                                             or (select pm.can_any(array['projects.commitments','projects.settings']::text[], 'edit'))
                                             or (select pm.can('projects.settings', 'configure'))))
              or (customer_id is null and vendor_id is null and (select pm.can_any(array['projects.leads','projects.customers']::text[], 'edit')))));
drop policy if exists member_update on core.sites;
create policy member_update on core.sites for update to authenticated
  using (org_id = public.get_org_id()
         and ((select core.has_capability('mdm.customers', 'edit'))
              or customer_id in (select crm.my_customer_ids_with('projects.customers', 'edit'))))
  with check (org_id = public.get_org_id()
         and ((select core.has_capability('mdm.customers', 'edit'))
              or customer_id in (select crm.my_customer_ids_with('projects.customers', 'edit'))));

-- Projects-only seats: the 1110 deny in its narrowed form (registered so a 1110 re-run keeps it).
insert into pm.access_seat_exceptions as e (schema_name, table_name, kind, narrow_pred, reason) values
  ('core', 'contacts', 'narrowed',
   '(id in (select crm.my_contact_ids()))',
   '1111: contacts of reachable customers, vendor contacts with purchasing / store / settings, prospect contacts on visible leads'),
  ('core', 'sites', 'narrowed',
   '(id in (select crm.my_site_ids()))',
   '1111: sites of reachable customers, or at a company the seat works customers / leads / dispatch / all jobs'),
  ('core', 'duplicate_reviews', 'narrowed',
   '((kind = ''customer'' and a_id in (select crm.my_customer_ids()) and b_id in (select crm.my_customer_ids())) or (kind = ''contact'' and a_id in (select crm.my_contact_ids()) and b_id in (select crm.my_contact_ids())) or (kind = ''vendor'' and (select crm.can_see_vendors())))',
   '1111: the shared duplicate queue — only pairs whose two records the seat already reaches (security review L1)')
on conflict (schema_name, table_name) do update set kind = excluded.kind, narrow_pred = excluded.narrow_pred, reason = excluded.reason;

do $$
declare e record;
begin
  for e in select * from pm.access_seat_exceptions x where x.schema_name = 'core' and x.table_name in ('contacts','sites','duplicate_reviews') loop
    execute format('drop policy if exists projects_only_seat_deny on core.%I', e.table_name);
    execute format('create policy projects_only_seat_deny on core.%I as restrictive for all to authenticated '
                   'using ((not (select core.is_projects_only_seat())) or %s) with check ((not (select core.is_projects_only_seat())) or %s)',
                   e.table_name, e.narrow_pred, e.narrow_pred);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 9a. Matching at the door + safety net + duplicate queue
-- ----------------------------------------------------------------------------
-- Hints for a record the caller cannot see yet ('d***@harbor.test', '***-0100').
create or replace function core.party_mask_email(p text) returns text
language sql immutable
set search_path = core, public
as $$ select case when p is null or position('@' in p) = 0 then null else left(p, 1) || '***@' || split_part(p, '@', 2) end $$;
create or replace function core.party_mask_phone(p text) returns text
language sql immutable
set search_path = core, public
as $$ select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) < 4 then null else '***-' || right(regexp_replace(p, '\D', '', 'g'), 4) end $$;

-- May the caller look up / create parties of this kind (the door matcher)?
create or replace function core.party_can_match(p_kind text) returns boolean
language sql stable security definer
set search_path = core, pm, crm, public
as $$
  select pm.access_is_service()
      or not core.is_projects_only_seat()
      or case p_kind
           when 'vendor' then pm.can_any(array['projects.commitments','projects.store','projects.settings']::text[], 'view')
           else pm.can_any(array['projects.customers','projects.leads','projects.estimates','projects.store']::text[], 'view')
         end
$$;

create or replace function core.match_parties(
  p_kind text, p_name text, p_email text default null, p_phone text default null,
  p_address text default null, p_tax_id text default null, p_limit integer default 5)
returns table (id uuid, name text, score numeric, matched text[], detail jsonb)
language plpgsql stable security definer
set search_path = core, crm, pm, public
as $$
declare
  v_org uuid := public.get_org_id(); v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_po boolean; v_books boolean; v_tax_ok boolean; v_cust_any boolean;
begin
  if v_org is null then raise exception 'CORE_FORBIDDEN: no organization for the caller' using errcode = '42501'; end if;
  if v_kind not in ('customer','vendor','contact') then
    raise exception 'CORE_INVALID: kind must be customer, vendor or contact' using errcode = '22023';
  end if;
  if not core.party_can_match(v_kind) then
    raise exception 'CORE_FORBIDDEN: requires a customer (or purchasing) grant to look up %s', v_kind using errcode = '42501';
  end if;
  -- M1 (security review): Books customer / vendor access matches org-wide; everyone else only
  -- inside the companies they work customers at (projects.customers:view) — contact candidates
  -- only among contacts they already reach. A tax id is used only by a caller whose Books field
  -- policy reveals taxpayer ids (or an owner seat) and is ignored entirely otherwise (no oracle);
  -- a Projects-only seat never matches on a tax id alone.
  v_po := not pm.access_is_service() and core.is_projects_only_seat();
  v_books := pm.access_is_service()
          or (not v_po and core.has_capability(case when v_kind = 'vendor' then 'mdm.vendors' else 'mdm.customers' end, 'view'));
  v_cust_any := pm.can('projects.customers', 'view');
  v_tax_ok := v_kind = 'customer' and p_tax_id is not null and core.party_caller_tin_ok();
  return query
    with pick as (
      select * from core.party_candidates(v_org, v_kind, array[p_name], p_email, p_phone, core.party_address_line1(p_address),
                                          core.party_address_zip(p_address), case when v_tax_ok then p_tax_id end)
    ), scoped as (
      select p.*,
             (v_books or not v_po
              or (v_kind = 'customer' and p.id in (select crm.my_customer_ids()))
              or (v_kind = 'contact' and p.id in (select crm.my_contact_ids()))
              or (v_kind = 'vendor' and (select crm.can_see_vendors()))) as visible
        from pick p
       where p.score >= 0.70
         and not (v_po and p.matched = array['tax_id'])
         and (v_books
              or (v_kind = 'customer' and (p.location_id in (select pm.my_location_ids('projects.customers', 'view'))
                                           or (p.location_id is null and v_cust_any)))
              or (v_kind = 'contact' and p.id in (select crm.my_contact_ids()))
              or v_kind = 'vendor')
    )
    select x.id, x.name, x.score, x.matched,
           jsonb_build_object('level', core.party_match_level(x.matched),
                              'email', case when x.visible then x.email else core.party_mask_email(x.email) end,
                              'phone', case when x.visible then x.phone else core.party_mask_phone(x.phone) end,
                              'city', x.city, 'books_since', x.books_since, 'created_at', x.created_at, 'source', x.source,
                              'masked', not x.visible)
      from scoped x
     order by x.score desc, (x.books_since is null), x.created_at, x.id
     limit greatest(1, least(coalesce(p_limit, 5), 25));
end $$;
comment on function core.match_parties(text, text, text, text, text, text, integer) is
  '1111 / shared records §3: ranked candidates for a new customer / vendor / contact (the dedupe.ts curve). detail.level exact = offer the existing record by default.';

-- File strong matches of one record into the duplicate queue (internal). Returns rows filed.
create or replace function core.party_file_reviews(p_kind text, p_id uuid, p_source text) returns integer
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
declare v_org uuid; v_names text[]; v_email text; v_phone text; v_line1 text; v_zip text; v_tax text; v_created timestamptz;
  c record; n int := 0; v_rows int;
begin
  if p_kind = 'customer' then
    select x.org_id, array[x.name, x.display_name], x.email, x.phone, x.address_line1, x.zip, x.tax_id, x.created_at
      into v_org, v_names, v_email, v_phone, v_line1, v_zip, v_tax, v_created from core.customers x where x.id = p_id;
  elsif p_kind = 'vendor' then
    select x.org_id, array[x.name, x.display_name], x.email, x.phone, x.address_line1, x.zip, null, x.created_at
      into v_org, v_names, v_email, v_phone, v_line1, v_zip, v_tax, v_created from core.vendors x where x.id = p_id;
  elsif p_kind = 'contact' then
    select x.org_id, array[core.party_contact_name(x.first_name, x.last_name)], x.email, x.phone, null, null, null, x.created_at
      into v_org, v_names, v_email, v_phone, v_line1, v_zip, v_tax, v_created from core.contacts x where x.id = p_id;
  end if;
  if v_org is null then return 0; end if;
  for c in
    select * from core.party_candidates(v_org, p_kind, v_names, v_email, v_phone, v_line1, v_zip, v_tax, p_id, true) x
     where x.score >= 0.86
  loop
    insert into core.duplicate_reviews (org_id, kind, a_id, b_id, suggested_survivor_id, score, matched, source, detail)
    values (v_org, p_kind, least(p_id, c.id), greatest(p_id, c.id),
            case when c.books_since is not null or c.created_at <= v_created then c.id else p_id end,
            c.score, c.matched, coalesce(p_source, 'insert_trigger'),
            jsonb_build_object('level', core.party_match_level(c.matched), 'new_id', p_id, 'existing_id', c.id))
    on conflict (org_id, kind, a_id, b_id) do nothing;
    get diagnostics v_rows = row_count;
    n := n + v_rows;
  end loop;
  return n;
end $$;

-- Safety net (doc §3): never blocks or fails the insert.
create or replace function core.tg_party_duplicate_net() returns trigger
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
begin
  begin
    perform core.party_file_reviews(case tg_table_name when 'customers' then 'customer' when 'vendors' then 'vendor' else 'contact' end,
                                    new.id, 'insert_trigger');
  exception when others then
    raise warning 'duplicate safety net skipped for %.% %: %', tg_table_schema, tg_table_name, new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_party_duplicate_net on core.customers;
create trigger trg_party_duplicate_net after insert on core.customers for each row execute function core.tg_party_duplicate_net();
drop trigger if exists trg_party_duplicate_net on core.vendors;
create trigger trg_party_duplicate_net after insert on core.vendors for each row execute function core.tg_party_duplicate_net();
drop trigger if exists trg_party_duplicate_net on core.contacts;
create trigger trg_party_duplicate_net after insert on core.contacts for each row execute function core.tg_party_duplicate_net();

-- May the caller resolve (merge / dismiss) a pair of this kind? Books edit, or Projects edit at
-- the company of each record.
create or replace function core.party_can_resolve(p_kind text, p_a uuid, p_b uuid) returns boolean
language plpgsql stable security definer
set search_path = core, crm, pm, public
as $$
declare la uuid; lb uuid;
begin
  if pm.access_is_service() then return true; end if;
  if p_kind in ('customer','contact') and core.has_capability('mdm.customers', 'edit') then return true; end if;
  if p_kind = 'vendor' and core.has_capability('mdm.vendors', 'edit') then return true; end if;
  if p_kind = 'customer' then
    return p_a in (select crm.my_customer_ids_with('projects.customers', 'edit'))
       and p_b in (select crm.my_customer_ids_with('projects.customers', 'edit'));
  elsif p_kind = 'vendor' then
    return pm.can('projects.settings', 'configure') or pm.can('projects.commitments', 'edit');
  else
    select customer_id into la from core.contacts where id = p_a;
    select customer_id into lb from core.contacts where id = p_b;
    return (la is null or la in (select crm.my_customer_ids_with('projects.customers', 'edit')))
       and (lb is null or lb in (select crm.my_customer_ids_with('projects.customers', 'edit')))
       and pm.can('projects.customers', 'edit');
  end if;
end $$;

create or replace function core.dismiss_duplicate(p_review uuid) returns void
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
declare r core.duplicate_reviews%rowtype;
begin
  select * into r from core.duplicate_reviews x where x.id = p_review for update;
  if r.id is null or (not pm.access_is_service() and r.org_id is distinct from public.get_org_id()) then
    raise exception 'CORE_FORBIDDEN: review % not found in the caller''s organization', p_review using errcode = '42501';
  end if;
  if not core.party_can_resolve(r.kind, r.a_id, r.b_id) then
    raise exception 'CORE_FORBIDDEN: requires customer-edit rights on both records' using errcode = '42501';
  end if;
  if r.status <> 'open' then
    raise exception 'CORE_REVIEW_CLOSED: review is already %', r.status using errcode = '22023';
  end if;
  update core.duplicate_reviews set status = 'not_duplicate', resolved_by = pm.current_user_id(), resolved_at = now()
   where id = r.id;
  insert into core.action_log (org_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (r.org_id, case when pm.access_is_service() then 'SYSTEM' else 'HUMAN' end::actor_type,
          (select ms.user_id from core.memberships ms where ms.id = core.client_scope_caller_membership()),
          'parties.not_duplicate', 'duplicate_reviews', r.id::text, format('Not a duplicate (%s pair)', r.kind),
          jsonb_build_object('kind', r.kind, 'a_id', r.a_id, 'b_id', r.b_id, 'score', r.score, 'matched', r.matched));
end $$;
comment on function core.dismiss_duplicate(uuid) is '1111 / shared records §4: remember a pair as not a duplicate (never suggested again).';

-- ----------------------------------------------------------------------------
-- 9b. Merge
-- ----------------------------------------------------------------------------
create or replace function core.merge_parties(p_kind text, p_survivor uuid, p_victim uuid, p_field_choices jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
declare
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_tbl regclass; v_s jsonb; v_v jsonb; v_after jsonb; v_org uuid; v_vorg uuid;
  v_choices jsonb := coalesce(p_field_choices, '{}'::jsonb);
  v_money text[]; v_ident text[]; v_conflicts text[] := '{}'; f text; v_pick text;
  v_changed text[] := '{}'; fk record; v_col text; v_rows int; v_repointed jsonb := '[]'; v_kept jsonb := '[]';
  v_books_ok boolean; v_surv_books boolean := false; r record; v_other uuid; v_reviews uuid[] := '{}'; v_audit uuid; v_strip text[];
begin
  if v_kind not in ('customer','vendor','contact') then
    raise exception 'CORE_INVALID: kind must be customer, vendor or contact' using errcode = '22023';
  end if;
  if p_survivor is null or p_victim is null or p_survivor = p_victim then
    raise exception 'CORE_INVALID: survivor and victim must be two different records' using errcode = '22023';
  end if;
  if jsonb_typeof(v_choices) <> 'object' then
    raise exception 'CORE_INVALID: field_choices must be an object {"column": "survivor" | "victim"}' using errcode = '22023';
  end if;
  v_tbl := case v_kind when 'customer' then 'core.customers' when 'vendor' then 'core.vendors' else 'core.contacts' end::regclass;
  v_strip := array['search_tsv', 'tin_encrypted'];
  execute format('select to_jsonb(t) from %s t where t.id = $1 for update', v_tbl) into v_s using p_survivor;
  execute format('select to_jsonb(t) from %s t where t.id = $1 for update', v_tbl) into v_v using p_victim;
  if v_s is null or v_v is null then
    raise exception 'CORE_FORBIDDEN: % not found', v_kind using errcode = '42501';
  end if;
  v_org := (v_s ->> 'org_id')::uuid; v_vorg := (v_v ->> 'org_id')::uuid;
  if v_org is distinct from v_vorg then
    raise exception 'CORE_MERGE_CROSS_TENANT: the two records belong to different tenants' using errcode = '42501';
  end if;
  if not pm.access_is_service() and v_org is distinct from public.get_org_id() then
    raise exception 'CORE_FORBIDDEN: % not found in the caller''s organization', v_kind using errcode = '42501';
  end if;
  if (v_s ->> 'merged_into') is not null or (v_v ->> 'merged_into') is not null
     or (v_kind <> 'contact' and ((v_s ->> 'deleted_at') is not null or (v_v ->> 'deleted_at') is not null))
     or (v_kind = 'contact' and (v_s ->> 'identity_status' <> 'active' or v_v ->> 'identity_status' <> 'active')) then
    raise exception 'CORE_MERGE_ARCHIVED: one of the records is already merged or archived' using errcode = '22023';
  end if;
  if not core.party_can_resolve(v_kind, p_survivor, p_victim) then
    raise exception 'CORE_FORBIDDEN: requires customer-edit rights on both records' using errcode = '42501';
  end if;

  -- field vocabulary: Books-owned money settings vs identity fields
  if v_kind = 'customer' then
    v_money := array['payment_terms_days','credit_limit_cents','tax_exempt','tax_id','payment_methods_allowed',
                     'card_surcharge_enabled','ach_surcharge_enabled','retainage_enabled','default_retainage_pct'];
    v_ident := array['name','display_name','email','phone','address_line1','address_line2','city','state','zip',
                     'contact_first_name','contact_last_name','website','location_id'];
    v_books_ok := pm.access_is_service() or core.party_caller_is_owner() or core.has_capability('mdm.customers', 'edit');
  elsif v_kind = 'vendor' then
    v_money := array['payment_terms_days','default_retainage_pct','is_1099_eligible','tin_encrypted','w9_status',
                     'default_account_id','default_department_id','default_class_id','auto_approve'];
    v_ident := array['name','display_name','email','phone','address_line1','address_line2','city','state','zip','website'];
    v_books_ok := pm.access_is_service() or core.party_caller_is_owner() or core.has_capability('mdm.vendors', 'edit');
  else
    v_money := '{}';
    v_ident := array['first_name','last_name','email','phone','title','customer_id','vendor_id','is_primary','can_sign','can_pay',
                     'sms_consent','email_consent'];
    v_books_ok := true;
  end if;
  -- M3 (security review): a victim with Books money records (invoices, payments, deposits; bills,
  -- purchase orders, checks for vendors), or an org-level customer (no company), is Books' to
  -- merge: Books customer / vendor edit (mdm.customers:edit / mdm.vendors:edit) or an owner seat.
  v_surv_books := v_kind in ('customer', 'vendor')
                  and ((v_kind = 'customer' and (v_s ->> 'location_id') is null) or core.party_has_books_money(v_kind, p_survivor));
  if not v_books_ok and (
       (v_kind = 'customer' and ((v_v ->> 'location_id') is null or core.party_has_books_money('customer', p_victim)))
       or (v_kind = 'vendor' and core.party_has_books_money('vendor', p_victim))) then
    raise exception 'CORE_MERGE_BOOKS_AUTHORITY: this % has Merit Books money records (or belongs to no company); merging it needs Books % edit or an owner seat',
      v_kind, v_kind using errcode = '42501';
  end if;
  for f in select jsonb_object_keys(v_choices) loop
    if not (f = any (v_money) or f = any (v_ident)) then
      raise exception 'CORE_INVALID: % cannot be chosen in a merge', f using errcode = '22023';
    end if;
    if v_choices ->> f not in ('survivor', 'victim') then
      raise exception 'CORE_INVALID: field_choices.% must be "survivor" or "victim"', f using errcode = '22023';
    end if;
  end loop;
  -- Books money settings: differing values are Books' call (doc §4)
  foreach f in array v_money loop
    if (v_v -> f) is not null and (v_v -> f) <> 'null'::jsonb and (v_s -> f) is distinct from (v_v -> f) then
      if not (v_choices ? f) then
        v_conflicts := v_conflicts || f;
      elsif not v_books_ok then
        raise exception 'CORE_MERGE_BOOKS_AUTHORITY: % differs between the records; only an owner or Books customer-edit can choose it', f
          using errcode = '42501';
      end if;
    end if;
  end loop;
  if cardinality(v_conflicts) > 0 then
    raise exception 'CORE_MERGE_BOOKS_CONFLICT: the records differ on Books settings (%) — Books must choose them in field_choices',
      array_to_string(v_conflicts, ', ') using errcode = '22023';
  end if;

  -- survivor fields: chosen victim values, then blanks filled from the victim (identity only)
  foreach f in array v_money || v_ident loop
    v_pick := v_choices ->> f;
    -- a Books customer / vendor (money records, or no company) keeps its fields unless Books decides
    if v_surv_books and not v_books_ok
       and ((v_pick = 'victim' and (v_s -> f) is distinct from (v_v -> f))
            or (v_pick is null and f = any (v_ident) and ((v_s -> f) is null or (v_s -> f) = 'null'::jsonb or (v_s ->> f) = '')
                and (v_v -> f) is not null and (v_v -> f) <> 'null'::jsonb and (v_v ->> f) <> '' and f <> 'is_primary')) then
      raise exception 'CORE_MERGE_BOOKS_AUTHORITY: the surviving % has Merit Books money records (or belongs to no company); changing its % needs Books % edit or an owner seat',
        v_kind, f, v_kind using errcode = '42501';
    end if;
    if v_pick = 'victim' and (v_s -> f) is distinct from (v_v -> f) then
      execute format('update %s t set %I = v.%I from %s v where t.id = $1 and v.id = $2', v_tbl, f, f, v_tbl) using p_survivor, p_victim;
      v_changed := v_changed || f;
    elsif v_pick is null and f = any (v_ident) and ((v_s -> f) is null or (v_s -> f) = 'null'::jsonb or (v_s ->> f) = '')
          and (v_v -> f) is not null and (v_v -> f) <> 'null'::jsonb and (v_v ->> f) <> ''
          and f not in ('is_primary') then
      execute format('update %s t set %I = v.%I from %s v where t.id = $1 and v.id = $2', v_tbl, f, f, v_tbl) using p_survivor, p_victim;
      v_changed := v_changed || f;
    end if;
  end loop;
  if v_kind = 'contact' and (v_choices ->> 'roles') is null then
    update core.contacts t set roles = array(select distinct x from unnest(t.roles || v.roles) x order by 1)
      from core.contacts v where t.id = p_survivor and v.id = p_victim and not (t.roles @> v.roles);
    if found then v_changed := v_changed || 'roles'::text; end if;
  end if;

  -- archive the victim FIRST (a primary contact flag / unique slot must not collide when its
  -- references move), then repoint every FK that references it, in every schema
  if v_kind = 'contact' then
    update core.contacts set identity_status = 'merged', merged_into = p_survivor, is_primary = false where id = p_victim;
  else
    -- the survivor keeps its primary contact; the victim's contacts arrive as non-primary
    if exists (select 1 from core.contacts k where k.is_primary and k.identity_status = 'active'
                 and ((v_kind = 'customer' and k.customer_id = p_survivor) or (v_kind = 'vendor' and k.vendor_id = p_survivor))) then
      update core.contacts set is_primary = false
       where is_primary and ((v_kind = 'customer' and customer_id = p_victim) or (v_kind = 'vendor' and vendor_id = p_victim));
    end if;
    execute format('update %s set merged_into = $1, merged_at = now(), is_active = false, deleted_at = coalesce(deleted_at, now()) where id = $2', v_tbl)
      using p_survivor, p_victim;
  end if;
  for fk in
    select c.oid, c.conrelid::regclass as tbl, c.conname, (rn.nspname || '.' || rc.relname) as tbl_name,
           (select a.attname from unnest(c.conkey, c.confkey) as k(col, ref)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.col
              join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.ref
             where ra.attname = 'id' limit 1) as col
      from pg_constraint c
      join pg_class rc on rc.oid = c.conrelid
      join pg_namespace rn on rn.oid = rc.relnamespace
     where c.contype = 'f' and c.confrelid = v_tbl
     order by rn.nspname, rc.relname, c.conname
  loop
    v_col := fk.col;
    continue when v_col is null;
    begin
      execute format('update %s set %I = $1 where %I = $2', fk.tbl, v_col, v_col) using p_survivor, p_victim;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        v_repointed := v_repointed || jsonb_build_object('table', fk.tbl_name, 'column', v_col, 'rows', v_rows);
      end if;
    exception when others then
      execute format('select count(*) from %s where %I = $1', fk.tbl, v_col) into v_rows using p_victim;
      v_kept := v_kept || jsonb_build_object('table', fk.tbl_name, 'column', v_col, 'rows', v_rows, 'reason', sqlstate || ' ' || left(sqlerrm, 300));
    end;
  end loop;
  if v_kind = 'customer' then
    update core.jobs j set customer_name = c.name from core.customers c
     where j.customer_id = p_survivor and c.id = p_survivor and j.customer_name is distinct from c.name;
  end if;

  -- the duplicate queue: this pair → merged; the victim's other open pairs move to the survivor
  for r in select * from core.duplicate_reviews x where x.org_id = v_org and x.kind = v_kind and x.status = 'open'
             and p_victim in (x.a_id, x.b_id) for update loop
    v_other := case when r.a_id = p_victim then r.b_id else r.a_id end;
    if v_other = p_survivor
       or exists (select 1 from core.duplicate_reviews y where y.org_id = v_org and y.kind = v_kind
                     and y.a_id = least(p_survivor, v_other) and y.b_id = greatest(p_survivor, v_other)) then
      update core.duplicate_reviews set status = 'merged', resolved_by = pm.current_user_id(), resolved_at = now(),
             detail = detail || jsonb_build_object('merged_into', p_survivor)
       where id = r.id;
      v_reviews := v_reviews || r.id;
    else
      update core.duplicate_reviews set a_id = least(p_survivor, v_other), b_id = greatest(p_survivor, v_other),
             suggested_survivor_id = p_survivor, detail = detail || jsonb_build_object('repointed_from', p_victim)
       where id = r.id;
    end if;
  end loop;
  if not exists (select 1 from core.duplicate_reviews y where y.org_id = v_org and y.kind = v_kind
                    and y.a_id = least(p_survivor, p_victim) and y.b_id = greatest(p_survivor, p_victim)) then
    insert into core.duplicate_reviews (org_id, kind, a_id, b_id, suggested_survivor_id, score, matched, source, status, resolved_by, resolved_at)
    values (v_org, v_kind, least(p_survivor, p_victim), greatest(p_survivor, p_victim), p_survivor, 0, '{}', 'manual_merge',
            'merged', pm.current_user_id(), now());
  end if;

  execute format('select to_jsonb(t) from %s t where t.id = $1', v_tbl) into v_after using p_survivor;
  insert into core.action_log (org_id, actor_type, actor_user_id, action, subject_table, subject_id, summary, metadata)
  values (v_org, case when pm.access_is_service() then 'SYSTEM' else 'HUMAN' end::actor_type,
          (select ms.user_id from core.memberships ms where ms.id = core.client_scope_caller_membership()),
          'parties.merge', case v_kind when 'customer' then 'customers' when 'vendor' then 'vendors' else 'contacts' end, p_survivor::text,
          format('Merged %s "%s" into "%s"', v_kind, coalesce(v_v ->> 'name', concat_ws(' ', v_v ->> 'first_name', v_v ->> 'last_name')),
                 coalesce(v_s ->> 'name', concat_ws(' ', v_s ->> 'first_name', v_s ->> 'last_name'))),
          jsonb_build_object('kind', v_kind, 'survivor_id', p_survivor, 'victim_id', p_victim, 'field_choices', v_choices,
                             'fields_changed', to_jsonb(v_changed), 'repointed', v_repointed, 'kept_on_victim', v_kept,
                             'before', jsonb_build_object('survivor', v_s - v_strip, 'victim', v_v - v_strip),
                             'after', v_after - v_strip))
  returning id into v_audit;

  return jsonb_build_object('kind', v_kind, 'survivor_id', p_survivor, 'victim_id', p_victim,
                            'fields_changed', to_jsonb(v_changed), 'repointed', v_repointed, 'kept_on_victim', v_kept,
                            'reviews_closed', to_jsonb(v_reviews), 'audit_id', v_audit);
end $$;
comment on function core.merge_parties(text, uuid, uuid, jsonb) is
  '1111 / shared records §4: merge two customers / vendors / contacts — every FK repointed (catalog-driven), victim soft-archived (merged_into), Books money conflicts refused, audited to core.action_log.';

-- ----------------------------------------------------------------------------
-- 9c. Contacts and sites (match first; return the existing record on an exact identifier)
-- ----------------------------------------------------------------------------
create or replace function core.create_contact(
  p_customer uuid default null, p_vendor uuid default null, p_first_name text default null, p_last_name text default null,
  p_email text default null, p_phone text default null, p_title text default null, p_roles text[] default '{}',
  p_is_primary boolean default false, p_can_sign boolean default false, p_can_pay boolean default false,
  p_sms_consent boolean default false, p_email_consent boolean default false)
returns uuid
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
declare
  v_org uuid := public.get_org_id(); v_loc uuid; v_id uuid; c record;
  v_first text := nullif(btrim(coalesce(p_first_name, '')), ''); v_last text := nullif(btrim(coalesce(p_last_name, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_org is null then raise exception 'CORE_FORBIDDEN: no organization for the caller' using errcode = '42501'; end if;
  if p_customer is not null then
    select x.location_id into v_loc from core.customers x where x.id = p_customer and x.org_id = v_org and x.deleted_at is null;
    if not found then raise exception 'CORE_FORBIDDEN: customer % not found in the caller''s organization', p_customer using errcode = '42501'; end if;
  end if;
  if p_vendor is not null and not exists (select 1 from core.vendors x where x.id = p_vendor and x.org_id = v_org and x.deleted_at is null) then
    raise exception 'CORE_FORBIDDEN: vendor % not found in the caller''s organization', p_vendor using errcode = '42501';
  end if;
  if not pm.access_is_service() then
    if p_customer is not null and not (core.has_capability('mdm.customers', 'edit')
                                       or p_customer in (select crm.my_customer_ids_with('projects.customers', 'create'))
                                       or p_customer in (select crm.my_customer_ids_with('projects.leads', 'create'))) then
      raise exception 'CORE_FORBIDDEN: requires projects.customers:create on this customer' using errcode = '42501';
    end if;
    if p_vendor is not null and not (core.has_capability('mdm.vendors', 'edit')
                                     or pm.can_any(array['projects.commitments','projects.settings']::text[], 'edit')
                                     or pm.can('projects.settings', 'configure')) then
      raise exception 'CORE_FORBIDDEN: requires vendor-edit rights' using errcode = '42501';
    end if;
    if p_customer is null and p_vendor is null and not (core.has_capability('mdm.customers', 'edit')
                                                        or pm.can_any(array['projects.leads','projects.customers']::text[], 'create')) then
      raise exception 'CORE_FORBIDDEN: requires projects.leads:create or projects.customers:create' using errcode = '42501';
    end if;
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'CORE_INVALID: % is not an email address', v_email using errcode = '22023';
  end if;
  if coalesce(v_first, v_last, v_email, v_phone) is null then
    raise exception 'CORE_INVALID: a contact needs a name, email or phone' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('core.contact:' || v_org::text || ':' || coalesce(lower(v_email), core.party_norm_phone(v_phone), lower(concat_ws(' ', v_first, v_last))), 0));
  for c in
    select x.* from core.party_candidates(v_org, 'contact', array[nullif(concat_ws(' ', v_first, v_last), '')], v_email, v_phone, null, null, null) x
     order by x.score desc, x.created_at
  loop
    if core.party_match_level(c.matched) = 'exact'
       and exists (select 1 from core.contacts k where k.id = c.id
                     and k.customer_id is not distinct from p_customer and k.vendor_id is not distinct from p_vendor)
       and crm.party_visible('contact', c.id) then   -- never hand back a contact the caller cannot see
      return c.id;
    end if;
  end loop;

  insert into core.contacts (org_id, customer_id, vendor_id, first_name, last_name, email, phone, title, roles, is_primary,
                             can_sign, can_pay, sms_consent, email_consent, created_by)
  values (v_org, p_customer, p_vendor, v_first, v_last, v_email, v_phone, nullif(btrim(coalesce(p_title, '')), ''),
          coalesce(p_roles, '{}'), coalesce(p_is_primary, false), coalesce(p_can_sign, false), coalesce(p_can_pay, false),
          coalesce(p_sms_consent, false), coalesce(p_email_consent, false), pm.current_user_id())
  returning id into v_id;
  return v_id;
end $$;
comment on function core.create_contact(uuid, uuid, text, text, text, text, text, text[], boolean, boolean, boolean, boolean, boolean) is
  '1111 / shared records §9: add a contact (match first: the same person on the same customer / vendor is returned, not duplicated).';

create or replace function core.create_site(
  p_customer uuid, p_location uuid default null, p_name text default null, p_address_line1 text default null,
  p_address_line2 text default null, p_city text default null, p_state text default null, p_zip text default null,
  p_access_notes text default null, p_tax_jurisdiction text default null)
returns uuid
language plpgsql security definer
set search_path = core, crm, pm, public
as $$
declare v_org uuid := public.get_org_id(); v_cloc uuid; v_id uuid; v_line1 text := nullif(btrim(coalesce(p_address_line1, '')), '');
  v_zip text := nullif(btrim(coalesce(p_zip, '')), '');
begin
  if v_org is null then raise exception 'CORE_FORBIDDEN: no organization for the caller' using errcode = '42501'; end if;
  select x.location_id into v_cloc from core.customers x where x.id = p_customer and x.org_id = v_org and x.deleted_at is null;
  if not found then raise exception 'CORE_FORBIDDEN: customer % not found in the caller''s organization', p_customer using errcode = '42501'; end if;
  if p_location is not null and not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'CORE_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if not pm.access_is_service()
     and not (core.has_capability('mdm.customers', 'edit')
              or p_customer in (select crm.my_customer_ids_with('projects.customers', 'create'))
              or p_customer in (select crm.my_customer_ids_with('projects.leads', 'create'))
              or (p_location is not null and pm.can('projects.customers', 'create', p_location))) then
    raise exception 'CORE_FORBIDDEN: requires projects.customers:create on this customer' using errcode = '42501';
  end if;
  if v_line1 is null and nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'CORE_INVALID: a site needs an address or a name' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('core.site:' || p_customer::text, 0));
  if v_line1 is not null then
    select s.id into v_id from core.sites s
     where s.customer_id = p_customer and s.identity_status = 'active'
       and core.party_norm_text(s.address_line1) = core.party_norm_text(v_line1)
       and (coalesce(btrim(s.zip), '') = coalesce(v_zip, '')
            or (v_zip is null and core.party_norm_text(s.city) = core.party_norm_text(p_city)))
     order by s.created_at limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  insert into core.sites (org_id, customer_id, location_id, name, address_line1, address_line2, city, state, zip,
                          access_notes, tax_jurisdiction, created_by)
  values (v_org, p_customer, coalesce(p_location, v_cloc), nullif(btrim(coalesce(p_name, '')), ''), v_line1,
          nullif(btrim(coalesce(p_address_line2, '')), ''), nullif(btrim(coalesce(p_city, '')), ''),
          nullif(btrim(coalesce(p_state, '')), ''), v_zip, nullif(btrim(coalesce(p_access_notes, '')), ''),
          nullif(btrim(coalesce(p_tax_jurisdiction, '')), ''), pm.current_user_id())
  returning id into v_id;
  return v_id;
end $$;
comment on function core.create_site(uuid, uuid, text, text, text, text, text, text, text, text) is
  '1111 / shared records §9: add a site of a customer (the same address on the same customer is returned, not duplicated).';

-- ----------------------------------------------------------------------------
-- 9d. crm lead flow
-- ----------------------------------------------------------------------------
create or replace function crm.create_lead(
  p_location uuid, p_title text, p_pipeline uuid default null, p_stage uuid default null,
  p_customer uuid default null, p_contact uuid default null, p_site uuid default null,
  p_source text default null, p_source_detail text default null, p_campaign text default null,
  p_owner uuid default null, p_estimated_value_cents bigint default null, p_expected_close_on date default null,
  p_next_step text default null, p_next_step_on date default null)
returns uuid
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare v_org uuid := public.get_org_id(); v_pipe uuid := p_pipeline; v_stage uuid := p_stage; v_kind text; v_id uuid;
  v_title text := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
begin
  if v_org is null or not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'CRM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if not pm.can('projects.leads', 'create', p_location) then
    raise exception 'CRM_FORBIDDEN: requires projects.leads:create at this company' using errcode = '42501';
  end if;
  if v_title = '' then raise exception 'CRM_INVALID: a lead needs a title' using errcode = '22023'; end if;
  if p_estimated_value_cents is not null and p_estimated_value_cents < 0 then
    raise exception 'CRM_INVALID: estimated value must be ≥ 0' using errcode = '22023';
  end if;
  perform crm.ensure_pipelines(p_location);
  if v_pipe is null then
    select p.id into v_pipe from crm.pipelines p where p.org_id = v_org and p.location_id = p_location and p.is_default;
  elsif not exists (select 1 from crm.pipelines p where p.id = v_pipe and p.org_id = v_org and p.location_id = p_location and p.is_active) then
    raise exception 'CRM_INVALID: pipeline % is not an active pipeline of this company', v_pipe using errcode = '22023';
  end if;
  if v_stage is null then
    select s.id into v_stage from crm.pipeline_stages s where s.pipeline_id = v_pipe and s.kind = 'open' and s.is_active order by s.sort, s.key limit 1;
  else
    select s.kind into v_kind from crm.pipeline_stages s where s.id = v_stage and s.pipeline_id = v_pipe and s.is_active;
    if v_kind is null then raise exception 'CRM_INVALID: stage % is not a stage of the pipeline', v_stage using errcode = '22023'; end if;
    if v_kind <> 'open' then raise exception 'CRM_INVALID: a new lead starts in an open stage' using errcode = '22023'; end if;
  end if;
  -- H2 (security review): only records the caller already sees can be attached (attaching must
  -- never widen what the caller reaches through the lead)
  if not crm.party_visible('customer', p_customer) or not crm.party_visible('contact', p_contact) or not crm.party_visible('site', p_site) then
    raise exception 'CRM_FORBIDDEN: the customer, contact or site is not one you can see' using errcode = '42501';
  end if;
  if p_owner is not null and not exists (select 1 from core.memberships m where m.id = p_owner and m.org_id = v_org and m.status = 'active') then
    raise exception 'CRM_INVALID: owner % is not an active seat of the organization', p_owner using errcode = '22023';
  end if;

  insert into crm.leads (org_id, location_id, pipeline_id, stage_id, title, customer_id, contact_id, site_id, source,
                         source_detail, campaign, owner_membership_id, estimated_value_cents, expected_close_on,
                         next_step, next_step_on, created_by)
  values (v_org, p_location, v_pipe, v_stage, left(v_title, 200), p_customer, p_contact, p_site,
          nullif(btrim(coalesce(p_source, '')), ''), nullif(btrim(coalesce(p_source_detail, '')), ''),
          nullif(btrim(coalesce(p_campaign, '')), ''), p_owner, p_estimated_value_cents, p_expected_close_on,
          nullif(btrim(coalesce(p_next_step, '')), ''), p_next_step_on, pm.current_user_id())
  returning id into v_id;
  insert into crm.lead_stage_events (org_id, lead_id, from_stage_id, to_stage_id, reason)
  values (v_org, v_id, null, v_stage, 'created');
  if p_next_step_on is not null then
    insert into crm.followups (org_id, lead_id, due_on, kind, title, assigned_membership_id, created_by)
    values (v_org, v_id, p_next_step_on, 'next_step', coalesce(nullif(btrim(coalesce(p_next_step, '')), ''), 'Next step'),
            coalesce(p_owner, core.client_scope_caller_membership()), pm.current_user_id());
  end if;
  return v_id;
end $$;

-- Internal: one stage move of a locked lead.
create or replace function crm.apply_stage(p_lead crm.leads, p_stage uuid, p_reason text) returns text
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare v_kind text;
begin
  select s.kind into v_kind from crm.pipeline_stages s where s.id = p_stage and s.pipeline_id = p_lead.pipeline_id and s.is_active;
  if v_kind is null then raise exception 'CRM_INVALID: stage % is not an active stage of the lead''s pipeline', p_stage using errcode = '22023'; end if;
  if v_kind = 'lost' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'CRM_LOST_REASON_REQUIRED: say why the lead was lost' using errcode = '22023';
  end if;
  update crm.leads set stage_id = p_stage,
         won_at = case when v_kind = 'won' then coalesce(won_at, now()) end,
         lost_at = case when v_kind = 'lost' then now() end,
         lost_reason = case when v_kind = 'lost' then left(btrim(p_reason), 500) end
   where id = p_lead.id;
  insert into crm.lead_stage_events (org_id, lead_id, from_stage_id, to_stage_id, reason)
  values (p_lead.org_id, p_lead.id, p_lead.stage_id, p_stage, nullif(btrim(coalesce(p_reason, '')), ''));
  if v_kind in ('won', 'lost') then
    update crm.followups set done_at = now(), done_by = pm.current_user_id(), outcome = coalesce(outcome, 'Lead ' || v_kind)
     where lead_id = p_lead.id and done_at is null;
  end if;
  return v_kind;
end $$;

create or replace function crm.move_lead(p_lead uuid, p_stage uuid, p_reason text default null) returns jsonb
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare l crm.leads%rowtype; v_kind text;
begin
  select * into l from crm.leads x where x.id = p_lead for update;
  if l.id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'CRM_FORBIDDEN: lead % not found in the caller''s organization', p_lead using errcode = '42501';
  end if;
  if not pm.can('projects.leads', 'edit', l.location_id) then
    raise exception 'CRM_FORBIDDEN: requires projects.leads:edit at this company' using errcode = '42501';
  end if;
  if p_stage = l.stage_id then
    return jsonb_build_object('lead_id', l.id, 'from', l.stage_id, 'to', p_stage, 'changed', false);
  end if;
  if l.converted_job_id is not null or l.converted_estimate_id is not null then
    raise exception 'CRM_LEAD_CONVERTED: the lead became a job; its work lives there now' using errcode = '22023';
  end if;
  v_kind := crm.apply_stage(l, p_stage, p_reason);
  return jsonb_build_object('lead_id', l.id, 'from', l.stage_id, 'to', p_stage, 'kind', v_kind, 'changed', true);
end $$;

create or replace function crm.log_activity(
  p_kind text, p_lead uuid default null, p_customer uuid default null, p_contact uuid default null, p_job uuid default null,
  p_direction text default null, p_subject text default null, p_body text default null, p_outcome text default null,
  p_occurred_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare v_org uuid := public.get_org_id(); l crm.leads%rowtype; v_loc uuid; v_cust uuid := p_customer; v_contact uuid := p_contact;
  v_jloc uuid; v_ok boolean := false; v_id uuid; v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_dir text := lower(nullif(btrim(coalesce(p_direction, '')), ''));
begin
  if v_org is null then raise exception 'CRM_FORBIDDEN: no organization for the caller' using errcode = '42501'; end if;
  if p_lead is not null then
    select * into l from crm.leads x where x.id = p_lead and x.org_id = v_org;
    if l.id is null then raise exception 'CRM_FORBIDDEN: lead % not found in the caller''s organization', p_lead using errcode = '42501'; end if;
    v_loc := l.location_id; v_cust := coalesce(v_cust, l.customer_id); v_contact := coalesce(v_contact, l.contact_id);
  end if;
  if p_job is not null then
    select j.location_id into v_jloc from core.jobs j where j.id = p_job and j.org_id = v_org;
    if v_jloc is null then raise exception 'CRM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501'; end if;
    v_loc := coalesce(v_loc, v_jloc);
  end if;
  if v_cust is not null then
    if not exists (select 1 from core.customers c where c.id = v_cust and c.org_id = v_org) then
      raise exception 'CRM_FORBIDDEN: customer % not found in the caller''s organization', v_cust using errcode = '42501';
    end if;
    v_loc := coalesce(v_loc, (select c.location_id from core.customers c where c.id = v_cust),
                      (select x.location_id from crm.leads x where x.org_id = v_org and x.customer_id = v_cust order by x.created_at desc limit 1),
                      (select j.location_id from core.jobs j where j.org_id = v_org and j.customer_id = v_cust order by j.created_at desc limit 1));
  end if;
  if (p_customer is not null and not crm.party_visible('customer', p_customer))
     or (p_contact is not null and not crm.party_visible('contact', p_contact)) then
    raise exception 'CRM_FORBIDDEN: the customer or contact is not one you can see' using errcode = '42501';
  end if;
  if v_contact is not null and not exists (select 1 from core.contacts k where k.id = v_contact and k.org_id = v_org) then
    raise exception 'CRM_FORBIDDEN: contact % not found in the caller''s organization', v_contact using errcode = '42501';
  end if;
  if v_loc is null then
    raise exception 'CRM_INVALID: an activity needs a lead, a job or a customer of a company' using errcode = '22023';
  end if;
  v_ok := pm.can('projects.leads', 'create', v_loc)
          or (p_lead is null and p_job is not null and pm.access_can_job('projects.jobs', 'edit', p_job));
  if not v_ok then raise exception 'CRM_FORBIDDEN: requires projects.leads:create at this company' using errcode = '42501'; end if;
  if v_kind not in ('call','sms','email','meeting','site_visit','note','portal_message','signed_document') then
    raise exception 'CRM_INVALID: unknown activity kind %', p_kind using errcode = '22023';
  end if;
  v_dir := case v_dir when 'in' then 'inbound' when 'out' then 'outbound' else v_dir end;
  if v_dir is not null and v_dir not in ('inbound','outbound') then
    raise exception 'CRM_INVALID: direction must be inbound or outbound' using errcode = '22023';
  end if;
  insert into crm.activities (org_id, location_id, lead_id, customer_id, contact_id, job_id, kind, direction, subject, body, outcome, occurred_at, created_by)
  values (v_org, v_loc, p_lead, v_cust, v_contact, coalesce(p_job, l.converted_job_id), v_kind, v_dir,
          nullif(btrim(coalesce(p_subject, '')), ''), nullif(p_body, ''), nullif(btrim(coalesce(p_outcome, '')), ''),
          coalesce(p_occurred_at, now()), pm.current_user_id())
  returning id into v_id;
  if p_lead is not null then update crm.leads set updated_at = now() where id = p_lead; end if;
  return v_id;
end $$;

create or replace function crm.complete_followup(p_followup uuid, p_outcome text default null) returns void
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare f crm.followups%rowtype;
begin
  select * into f from crm.followups x where x.id = p_followup for update;
  if f.id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'CRM_FORBIDDEN: follow-up % not found in the caller''s organization', p_followup using errcode = '42501';
  end if;
  if not (pm.can('projects.leads', 'edit', f.location_id) or f.assigned_membership_id = core.client_scope_caller_membership()) then
    raise exception 'CRM_FORBIDDEN: requires projects.leads:edit at this company, or being the assignee' using errcode = '42501';
  end if;
  if f.done_at is not null then return; end if;
  update crm.followups set done_at = now(), done_by = pm.current_user_id(), outcome = nullif(btrim(coalesce(p_outcome, '')), '')
   where id = f.id;
end $$;

-- Convert a lead to an estimate (a job in its first stage + a DRAFT estimate) or straight to a
-- job. The customer comes from the lead, or the matcher (an exact match is reused), or is
-- created (identity only — Books owns terms, credit and tax). The lead moves to its won stage.
create or replace function crm.convert_lead(p_lead uuid, p_target text, p_job_type_key text default null) returns jsonb
language plpgsql security definer
set search_path = crm, core, pm, public
as $$
declare
  l crm.leads%rowtype; k core.contacts%rowtype; s core.sites%rowtype; v_target text := lower(btrim(coalesce(p_target, '')));
  v_jt text := nullif(btrim(coalesce(p_job_type_key, '')), ''); v_cust uuid; v_created boolean := false; v_name text;
  v_job uuid; v_est uuid; v_won uuid; v_prev text; c record; v_n int;
begin
  select * into l from crm.leads x where x.id = p_lead for update;
  if l.id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'CRM_FORBIDDEN: lead % not found in the caller''s organization', p_lead using errcode = '42501';
  end if;
  if v_target not in ('estimate', 'job') then
    raise exception 'CRM_INVALID: convert to an estimate or a job' using errcode = '22023';
  end if;
  if not pm.can('projects.leads', 'edit', l.location_id) then
    raise exception 'CRM_FORBIDDEN: requires projects.leads:edit at this company' using errcode = '42501';
  end if;
  if v_target = 'job' and not pm.can('projects.jobs', 'create', l.location_id) then
    raise exception 'CRM_FORBIDDEN: requires projects.jobs:create at this company' using errcode = '42501';
  end if;
  if v_target = 'estimate' and not pm.can('projects.estimates', 'create', l.location_id) then
    raise exception 'CRM_FORBIDDEN: requires projects.estimates:create at this company' using errcode = '42501';
  end if;
  if l.converted_job_id is not null or l.converted_estimate_id is not null then
    raise exception 'CRM_LEAD_CONVERTED: the lead was already converted' using errcode = '22023';
  end if;
  if l.won_at is not null or l.lost_at is not null then
    raise exception 'CRM_LEAD_CLOSED: only an open lead can be converted' using errcode = '22023';
  end if;
  if v_jt is null then
    select count(*) into v_n from pm.job_types t where t.org_id = l.org_id and t.location_id = l.location_id and t.is_active;
    if v_n = 1 then
      select t.key into v_jt from pm.job_types t where t.org_id = l.org_id and t.location_id = l.location_id and t.is_active;
    else
      raise exception 'CRM_JOB_TYPE_REQUIRED: pick the kind of job to create' using errcode = '22023';
    end if;
  end if;
  if l.contact_id is not null then select * into k from core.contacts x where x.id = l.contact_id; end if;
  if l.site_id is not null then select * into s from core.sites x where x.id = l.site_id; end if;

  -- customer: the lead's, an exact match, or a new one (identity only)
  v_cust := l.customer_id;
  if v_cust is null then
    v_name := left(coalesce(nullif(btrim(concat_ws(' ', k.first_name, k.last_name)), ''), l.title), 200);
    perform pg_advisory_xact_lock(hashtextextended('pm.party:customer:' || l.org_id::text || ':' || pm.party_name_key(v_name), 0));
    -- match on the contact's name and the lead title (a business lead is titled with the company)
    for c in select x.* from core.party_candidates(l.org_id, 'customer', array[v_name, l.title], k.email, k.phone,
                                                   s.address_line1, s.zip, null) x
              order by x.score desc, (x.books_since is null), x.created_at loop
      if core.party_match_level(c.matched) = 'exact' then v_cust := c.id; end if;
      exit;
    end loop;
    if v_cust is null then
      v_cust := gen_random_uuid();
      insert into core.customers (id, org_id, name, email, phone, location_id, contact_first_name, contact_last_name, created_by)
      values (v_cust, l.org_id, v_name, k.email, k.phone, l.location_id, k.first_name, k.last_name, pm.current_user_id());
      v_created := true;
    end if;
    update crm.leads set customer_id = v_cust where id = l.id;
    if k.id is not null and k.customer_id is null and k.vendor_id is null then
      update core.contacts set customer_id = v_cust where id = k.id;
    end if;
  end if;

  -- job through the existing Projects function. This RPC already checked the caller's rights,
  -- so nested pm guards are authorized by this entry point (1110 deviation 6 pattern).
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_job := pm.create_project(l.location_id, v_jt, l.title, v_cust, null, false, '{}'::jsonb);
  perform set_config('pm.access_entry', v_prev, true);
  update pm.projects set source_ref = coalesce(source_ref, 'crm:lead:' || l.id::text),
         site_address_line1 = coalesce(site_address_line1, s.address_line1), site_address_line2 = coalesce(site_address_line2, s.address_line2),
         site_city = coalesce(site_city, s.city), site_state = coalesce(site_state, s.state), site_zip = coalesce(site_zip, s.zip),
         site_lat = coalesce(site_lat, s.lat), site_lng = coalesce(site_lng, s.lng)
   where org_id = l.org_id and job_id = v_job;
  if v_target = 'estimate' then
    insert into pm.estimates (org_id, job_id, customer_id, title, status, notes, created_by)
    values (l.org_id, v_job, v_cust, left(l.title, 200), 'DRAFT',
            case when l.estimated_value_cents > 0 then 'Lead estimate: ' || to_char(l.estimated_value_cents / 100.0, 'FM999,999,999,990.00') end,
            pm.current_user_id())
    returning id into v_est;
  end if;

  select st.id into v_won from crm.pipeline_stages st where st.pipeline_id = l.pipeline_id and st.kind = 'won' and st.is_active
   order by st.sort limit 1;
  update crm.leads set converted_job_id = v_job, converted_estimate_id = v_est where id = l.id;
  select * into l from crm.leads x where x.id = p_lead;
  if v_won is not null then perform crm.apply_stage(l, v_won, 'converted_to_' || v_target); end if;
  update crm.activities set customer_id = coalesce(customer_id, v_cust), job_id = coalesce(job_id, v_job) where lead_id = l.id;
  update crm.followups set customer_id = coalesce(customer_id, v_cust) where lead_id = l.id;
  perform pm.log_activity(l.org_id, l.location_id, v_job, 'lead.converted', 'crm.leads', l.id,
    format('Converted lead %s to %s', l.title, case v_target when 'estimate' then 'an estimate' else 'a job' end),
    jsonb_build_object('lead_id', l.id, 'customer_id', v_cust, 'customer_created', v_created, 'estimate_id', v_est));
  return jsonb_build_object('lead_id', l.id, 'target', v_target, 'customer_id', v_cust, 'customer_created', v_created,
                            'job_id', v_job, 'estimate_id', v_est);
end $$;

-- ----------------------------------------------------------------------------
-- 10. Views
-- ----------------------------------------------------------------------------
-- Relationship stage, derived (doc §2). Definer: one answer for every app; rows the caller
-- may see (every org row for non-Projects-only seats, reachable customers otherwise).
create or replace view core.v_customer_relationship with (security_barrier = true) as
with base as (
  select c.id as customer_id, c.org_id, c.location_id, c.created_at,
         (select min(coalesce(k.executed_on, k.created_at::date)) from pm.contracts k join core.jobs j on j.id = k.job_id
           where k.org_id = c.org_id and k.status in ('ACTIVE','CLOSED') and coalesce(k.customer_id, j.customer_id) = c.id) as first_contract_on,
         (select max(coalesce(k.executed_on, k.created_at::date)) from pm.contracts k join core.jobs j on j.id = k.job_id
           where k.org_id = c.org_id and k.status in ('ACTIVE','CLOSED') and coalesce(k.customer_id, j.customer_id) = c.id) as last_contract_on,
         (select min(i.invoice_date) from public.invoices i where i.org_id = c.org_id and i.customer_id = c.id and i.status not in ('DRAFT','VOIDED')) as first_invoice_on,
         (select max(i.invoice_date) from public.invoices i where i.org_id = c.org_id and i.customer_id = c.id and i.status not in ('DRAFT','VOIDED')) as last_invoice_on
    from core.customers c
   where c.deleted_at is null and c.merged_into is null
     and (not (select pm.access_member_role())
          or (c.org_id = public.get_org_id()
              and (not (select core.is_projects_only_seat()) or c.id in (select crm.my_customer_ids()))))
)
select b.customer_id,
       case when coalesce(b.first_contract_on, b.first_invoice_on) is null then 'prospect'
            when greatest(b.last_contract_on, b.last_invoice_on) < (current_date - interval '24 months')::date then 'former'
            else 'customer' end as stage,
       case when coalesce(b.first_contract_on, b.first_invoice_on) is null then b.created_at::date
            when greatest(b.last_contract_on, b.last_invoice_on) < (current_date - interval '24 months')::date
              then (greatest(b.last_contract_on, b.last_invoice_on) + interval '24 months')::date
            else least(b.first_contract_on, b.first_invoice_on) end as since,
       b.org_id, b.location_id,
       greatest(b.last_contract_on, b.last_invoice_on) as last_signed_or_invoiced_on
  from base b;
comment on view core.v_customer_relationship is
  '1111 / shared records §2: derived relationship stage — prospect until a signed contract (Projects) or issued invoice (Books), customer, former after 24 months without either.';

-- Customer 360 (Projects). AR / balances only for the customer of a job where the caller holds
-- projects.contract_value, or with Books AR (ar.invoices:view) at the customer's company; otherwise
-- those columns are null (security review M2).
create or replace view pm.v_customer_360 with (security_barrier = true) as
with c as (
  select c.id, c.org_id, c.location_id, c.name, r.stage, r.since,
         (not (select pm.access_member_role()) or c.id in (select crm.ar_customer_ids())) as see_money
    from core.customers c
    join core.v_customer_relationship r on r.customer_id = c.id
)
select c.id as customer_id, c.location_id, c.name,
       c.stage as relationship_stage, c.since as relationship_since,
       case when c.see_money then ar.open_ar_cents end as open_ar_cents,
       case when c.see_money then ar.overdue_ar_cents end as overdue_ar_cents,
       case when c.see_money then dep.held_cents end as deposits_held_cents,
       case when c.see_money then ar.lifetime_billed_cents end as lifetime_billed_cents,
       case when c.see_money then ar.last_invoice_on end as last_invoice_on,
       case when c.see_money then pay.last_payment_on end as last_payment_on,
       case when c.see_money then inv.items end as invoices,
       case when c.see_money then pay.items end as payments,
       case when c.see_money then dep.items end as deposits,
       (select count(*)::int from core.jobs j where j.org_id = c.org_id and j.customer_id = c.id) as jobs_count,
       (select count(*)::int from crm.leads l where l.org_id = c.org_id and l.customer_id = c.id and l.won_at is null and l.lost_at is null) as open_leads_count,
       (select max(a.occurred_at) from crm.activities a where a.org_id = c.org_id and a.customer_id = c.id) as last_activity_at
  from c
  cross join lateral (
    select coalesce(sum(coalesce(i.balance_cents, i.total_cents - i.amount_paid_cents)) filter (where i.status in ('SENT','PARTIALLY_PAID','OVERDUE')), 0)::bigint as open_ar_cents,
           coalesce(sum(coalesce(i.balance_cents, i.total_cents - i.amount_paid_cents))
                    filter (where i.status in ('SENT','PARTIALLY_PAID','OVERDUE') and i.due_date < current_date), 0)::bigint as overdue_ar_cents,
           coalesce(sum(i.total_cents) filter (where i.status not in ('DRAFT','VOIDED')), 0)::bigint as lifetime_billed_cents,
           max(i.invoice_date) filter (where i.status not in ('DRAFT','VOIDED')) as last_invoice_on
      from public.invoices i where i.org_id = c.org_id and i.customer_id = c.id) ar
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'number', x.invoice_number, 'date', x.invoice_date, 'due_date', x.due_date,
                                                 'total_cents', x.total_cents, 'balance_cents', coalesce(x.balance_cents, x.total_cents - x.amount_paid_cents),
                                                 'status', x.status) order by x.invoice_date desc, x.invoice_number desc), '[]'::jsonb) as items
      from (select * from public.invoices i where i.org_id = c.org_id and i.customer_id = c.id and i.status not in ('DRAFT','VOIDED')
             order by i.invoice_date desc, i.invoice_number desc limit 25) x) inv
  cross join lateral (
    select max(p.payment_date) as last_payment_on,
           coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'date', y.payment_date, 'amount_cents', y.amount_cents, 'method', y.payment_method)
                                      order by y.payment_date desc, y.id)
                       from (select * from public.customer_payments q where q.org_id = c.org_id and q.customer_id = c.id
                              order by q.payment_date desc, q.id limit 25) y), '[]'::jsonb) as items
      from public.customer_payments p where p.org_id = c.org_id and p.customer_id = c.id) pay
  cross join lateral (
    select coalesce(sum(d.amount_cents - d.applied_cents - d.refunded_cents) filter (where d.status in ('HELD','PARTIALLY_APPLIED')), 0)::bigint as held_cents,
           coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'date', y.deposit_date, 'amount_cents', y.amount_cents,
                                                         'applied_cents', y.applied_cents, 'status', y.status) order by y.deposit_date desc, y.id)
                       from (select * from public.customer_deposits q where q.org_id = c.org_id and q.customer_id = c.id
                              order by q.deposit_date desc, q.id limit 25) y), '[]'::jsonb) as items
      from public.customer_deposits d where d.org_id = c.org_id and d.customer_id = c.id) dep;
comment on view pm.v_customer_360 is
  '1111: one row per customer the caller may see — relationship stage, jobs, leads, and (with projects.contract_value or Books AR) AR, deposits, invoices, payments.';

-- Lead context for a job team (H1). Rows: leads at companies where the caller holds
-- projects.leads, or converted to a job the caller reaches. Estimated value, next step, lost reason
-- and activity subject / body / outcome are shown only with projects.leads at the company or
-- projects.contract_value on the converted job.
create or replace view pm.v_leads_masked with (security_barrier = true) as
with l as (
  select l.*,
         (not (select pm.access_member_role())
          or l.location_id in (select pm.my_location_ids('projects.leads', 'view'))
          or (l.converted_job_id is not null and l.converted_job_id in (select pm.my_money_job_ids('projects.contract_value')))) as privileged
    from crm.leads l
   where not (select pm.access_member_role())
      or (l.org_id = public.get_org_id()
          and (l.location_id in (select pm.my_location_ids('projects.leads', 'view'))
               or (l.converted_job_id is not null and l.converted_job_id in (select pm.my_job_ids()))))
)
select l.id, l.org_id, l.location_id, l.pipeline_id, l.stage_id, st.name as stage_name, st.kind as stage_kind, l.title,
       l.customer_id, l.contact_id, l.site_id, l.source, l.owner_membership_id,
       case when l.privileged then l.estimated_value_cents end as estimated_value_cents,
       l.expected_close_on, case when l.privileged then l.next_step end as next_step, l.next_step_on,
       case when l.privileged then l.lost_reason end as lost_reason,
       l.won_at, l.lost_at, l.converted_estimate_id, l.converted_job_id, l.created_at, l.updated_at,
       (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'direction', a.direction, 'occurred_at', a.occurred_at,
                                                     'subject', case when l.privileged then a.subject end,
                                                     'body', case when l.privileged then a.body end,
                                                     'outcome', case when l.privileged then a.outcome end)
                                  order by a.occurred_at desc), '[]'::jsonb)
          from crm.activities a where a.lead_id = l.id) as activities
  from l
  join crm.pipeline_stages st on st.id = l.stage_id;
comment on view pm.v_leads_masked is
  '1111 (security review H1): lead context for job teams — rows via projects.leads or a reachable converted job; money, lost reason and activity text only with projects.leads or projects.contract_value on the job.';

create or replace function pm.tieout_business_days(p_from date, p_to date) returns integer
language sql immutable
set search_path = pm, public
as $$
  select case when p_from is null or p_to is null or p_to <= p_from then 0
              else (select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') d where extract(isodow from d) < 6) end
$$;

-- Per job × check (doc §6). Rows: reachable jobs (pm.my_job_ids) and jobs where the caller
-- reads Books job money. Money columns per the check's capability (see header).
create or replace view pm.v_job_tieout with (security_barrier = true) as
with jobs as (
  select j.id as job_id, j.org_id, j.location_id,
         (not (select pm.access_member_role()) or j.id in (select pm.my_money_job_ids('projects.financials'))
          or j.location_id in (select crm.books_job_location_ids())) as see_cost,
         (not (select pm.access_member_role()) or j.id in (select pm.my_money_job_ids('projects.contract_value'))
          or j.location_id in (select crm.books_job_location_ids())) as see_sell
    from core.jobs j
    join pm.projects p on p.job_id = j.id and p.org_id = j.org_id and not p.is_sample
   where not (select pm.access_member_role())
      or (j.org_id = public.get_org_id()
          and (j.id in (select pm.my_job_ids()) or j.location_id in (select crm.books_job_location_ids())))
), checks as (
  -- job cost
  select jb.job_id, jb.location_id, 'job_cost'::text as check_key, 'cost'::text as money,
         pc.v as projects_cents, bc.v as books_cents,
         case when abs(pc.v - bc.v) > 100 then 'exception' else 'ok' end as status,
         case when abs(pc.v - bc.v) > 100 then 'Job cost in Projects and the GL job lines differ by more than $1 (a cost not yet applied in Projects, or a GL line missing the job)' end as cause,
         case when abs(pc.v - bc.v) > 100 then 'Open the job cost detail' end as action,
         jsonb_build_object('gl_lines', bc.n) as detail
    from jobs jb
    cross join lateral (select coalesce(sum(x.amount_cents), 0)::bigint as v from pm.job_costs x
                         where x.org_id = jb.org_id and x.job_id = jb.job_id and x.lifecycle = 'CLEARED') pc
    cross join lateral (select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint as v, count(*)::int as n
                          from public.gl_entry_lines l
                          join public.gl_entries e on e.id = l.gl_entry_id and e.status = 'POSTED'
                          join public.accounts a on a.id = l.account_id and a.account_type in ('COGS','OPEX')
                         where l.org_id = jb.org_id and l.job_id = jb.job_id) bc
  union all
  -- billing
  select jb.job_id, jb.location_id, 'billing', 'sell', br.v, bi.v,
         case when br.v <> bi.v or br.late > 0 then 'exception' else 'ok' end,
         case when br.late > 0 then format('%s billing request(s) have no invoice after 2 business days', br.late)
              when br.v <> bi.v then 'Billed amounts differ between the billing requests and the job''s invoices' end,
         case when br.late > 0 then 'Resend the billing request' when br.v <> bi.v then 'Open the invoices for this job' end,
         jsonb_build_object('requests', br.n, 'invoices', bi.n, 'late_requests', br.late)
    from jobs jb
    cross join lateral (select coalesce(sum(r.net_cents) filter (where r.status in ('EMITTED','ISSUED')), 0)::bigint as v,
                               count(*) filter (where r.status in ('EMITTED','ISSUED'))::int as n,
                               count(*) filter (where r.status = 'EMITTED' and r.invoice_id is null
                                                  and not exists (select 1 from public.invoices i where i.org_id = r.org_id and i.source_ref = r.source_ref)
                                                  and pm.tieout_business_days(coalesce(r.emitted_at, r.created_at)::date, current_date) > 2)::int as late
                          from pm.billing_requests r where r.org_id = jb.org_id and r.job_id = jb.job_id) br
    cross join lateral (select coalesce(sum(i.subtotal_cents), 0)::bigint as v, count(*)::int as n from public.invoices i
                         where i.org_id = jb.org_id and i.job_id = jb.job_id and i.status not in ('DRAFT','VOIDED')
                           and i.billing_subtype is distinct from 'DEPOSIT') bi
  union all
  -- deposits
  select jb.job_id, jb.location_id, 'deposits', 'sell', dp.v, dh.v,
         case when dp.v <> dh.v then 'exception' else 'ok' end,
         case when dp.v <> dh.v then 'Deposits held in Books differ from deposits requested less applied' end,
         case when dp.v <> dh.v then 'Open the deposit requests' end,
         jsonb_build_object('requested', dp.n, 'awaiting_payment', dp.awaiting, 'held', dh.n)
    from jobs jb
    cross join lateral (select coalesce(sum(r.amount_cents - coalesce(m.applied, 0) - coalesce(m.refunded, 0)) filter (where m.n > 0), 0)::bigint as v,
                               count(*)::int as n, count(*) filter (where coalesce(m.n, 0) = 0)::int as awaiting
                          from pm.deposit_requests r
                          left join lateral (select count(*) as n, sum(d.applied_cents) as applied, sum(d.refunded_cents) as refunded
                                               from public.customer_deposits d where d.org_id = r.org_id and d.source_ref = r.source_ref) m on true
                         where r.org_id = jb.org_id and r.job_id = jb.job_id and r.status in ('EMITTED','ISSUED')) dp
    cross join lateral (select coalesce(sum(d.amount_cents - d.applied_cents - d.refunded_cents), 0)::bigint as v, count(*)::int as n
                          from public.customer_deposits d where d.org_id = jb.org_id and d.job_id = jb.job_id) dh
  union all
  -- commitments (Books does not match bills to Projects commitments)
  select jb.job_id, jb.location_id, 'commitments', 'cost', cm.v, null::bigint, 'pending', 'Books does not record this yet', null::text,
         jsonb_build_object('commitments', cm.n, 'billed_to_date_cents', cm.billed)
    from jobs jb
    cross join lateral (select coalesce(sum(cl.amount_cents), 0)::bigint as v, coalesce(sum(cl.billed_cents), 0)::bigint as billed,
                               count(distinct k.id)::int as n
                          from pm.commitments k join pm.commitment_lines cl on cl.commitment_id = k.id and cl.org_id = k.org_id
                         where k.org_id = jb.org_id and k.job_id = jb.job_id and k.status in ('APPROVED','EXECUTED','CLOSED')) cm
  union all
  -- time (hours × 100; Books records no payroll hours by job)
  select jb.job_id, jb.location_id, 'time', 'none', tm.v, null::bigint, 'pending', 'Books does not record this yet', null::text,
         jsonb_build_object('approved_entries', tm.n)
    from jobs jb
    cross join lateral (select round(coalesce(sum(t.hours), 0) * 100)::bigint as v, count(*)::int as n from pm.time_entries t
                         where t.org_id = jb.org_id and t.job_id = jb.job_id and t.approval_state = 'APPROVED') tm
  union all
  -- events (messages to Books)
  select jb.job_id, jb.location_id, 'events', 'none', null::bigint, null::bigint,
         case when ev.rejected + ev.unanswered > 0 then 'exception' else 'ok' end,
         case when ev.rejected + ev.unanswered > 0 then format('%s message(s) to Books rejected, %s unanswered for over an hour', ev.rejected, ev.unanswered) end,
         case when ev.rejected > 0 then 'Resend the rejected message' when ev.unanswered > 0 then 'Check the Books event drain' end,
         jsonb_build_object('sent', ev.sent, 'rejected', ev.rejected, 'unanswered', ev.unanswered)
    from jobs jb
    cross join lateral (select count(*)::int as sent,
                               count(*) filter (where e.status = 'rejected')::int as rejected,
                               count(*) filter (where e.status = 'pending' and e.created_at < now() - interval '1 hour')::int as unanswered
                          from core.events e
                         where e.org_id = jb.org_id and e.source_module = 'PROJECTS' and e.payload ->> 'job_id' = jb.job_id::text) ev
)
select ch.job_id, ch.location_id, ch.check_key,
       case when ch.money = 'none' or (ch.money = 'cost' and jb.see_cost) or (ch.money = 'sell' and jb.see_sell) then ch.projects_cents end as projects_cents,
       case when ch.money = 'none' or (ch.money = 'cost' and jb.see_cost) or (ch.money = 'sell' and jb.see_sell) then ch.books_cents end as books_cents,
       case when ch.money = 'none' or (ch.money = 'cost' and jb.see_cost) or (ch.money = 'sell' and jb.see_sell) then ch.projects_cents - ch.books_cents end as diff_cents,
       ch.status, ch.cause, ch.action,
       case when ch.money = 'none' or (ch.money = 'cost' and jb.see_cost) or (ch.money = 'sell' and jb.see_sell) then ch.detail
            else ch.detail - array['billed_to_date_cents'] end as detail,
       now() as as_of
  from checks ch join jobs jb on jb.job_id = ch.job_id;
comment on view pm.v_job_tieout is
  '1111 / shared records §6: per job × check (job_cost, billing, deposits, commitments, time [hours × 100], events): projects_cents, books_cents, diff_cents, status ok | exception | pending, cause, action.';

create or replace view pm.v_company_tieout with (security_barrier = true) as
with t as (select * from pm.v_job_tieout),
per as (
  select t.location_id,
         count(distinct t.job_id)::int as jobs_checked,
         count(distinct t.job_id) filter (where t.status = 'exception')::int as jobs_with_exceptions,
         count(*) filter (where t.status = 'exception')::int as exception_count,
         count(*) filter (where t.status = 'pending')::int as pending_checks,
         sum(abs(t.diff_cents)) filter (where t.status = 'exception')::bigint as exception_cents
    from t group by t.location_id
)
select p.location_id, p.jobs_checked, p.jobs_checked - p.jobs_with_exceptions as jobs_tied, p.jobs_with_exceptions,
       p.exception_count, p.exception_cents, p.pending_checks, d.n as open_duplicate_reviews,
       case when p.exception_count > 0 or d.n > 0 then 'exception' else 'ok' end as status,
       case when d.n > 0 then format('%s possible duplicate customer(s) to review', d.n) end as customers_cause,
       now() as as_of
  from per p
  cross join lateral (
    select count(*)::int as n from core.duplicate_reviews r
     where r.status = 'open' and r.kind = 'customer'
       and r.org_id = (select l.org_id from core.locations l where l.id = p.location_id)
       and exists (select 1 from core.customers c where c.id in (r.a_id, r.b_id) and (c.location_id = p.location_id or c.location_id is null))) d;
comment on view pm.v_company_tieout is
  '1111 / shared records §6: per company — jobs checked / tied / with exceptions, exception dollars (when visible), pending checks, open duplicate customer reviews.';

-- ----------------------------------------------------------------------------
-- 11. Seed pipelines for every existing company (idempotent)
-- ----------------------------------------------------------------------------
do $$
declare l record;
begin
  for l in select id from core.locations order by org_id, id loop
    perform crm.ensure_pipelines(l.id);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Grants (nothing for anon / PUBLIC)
-- ----------------------------------------------------------------------------
revoke all on all tables in schema crm from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema crm to service_role;
grant select on all tables in schema crm to authenticated;
grant insert (location_id, key, name, sort, is_active), update (name, sort, is_active, is_default), delete on crm.pipelines to authenticated;
grant insert (pipeline_id, key, name, kind, probability_pct, sort), update (name, probability_pct, sort, is_active), delete on crm.pipeline_stages to authenticated;
grant update (title, customer_id, contact_id, site_id, source, source_detail, campaign, owner_membership_id,
              estimated_value_cents, expected_close_on, next_step, next_step_on), delete on crm.leads to authenticated;
grant insert (lead_id, due_on, kind, title, notes, assigned_membership_id, cadence_key),
      update (due_on, kind, title, notes, assigned_membership_id, cadence_key), delete on crm.followups to authenticated;

revoke all on core.contacts, core.sites, core.duplicate_reviews from public, anon, authenticated;
grant select, insert, update, delete on core.contacts, core.sites, core.duplicate_reviews to service_role;
grant select on core.contacts, core.sites, core.duplicate_reviews to authenticated;
grant update (first_name, last_name, email, phone, title, roles, is_primary, can_sign, can_pay, sms_consent, email_consent)
  on core.contacts to authenticated;
grant update (location_id, name, address_line1, address_line2, city, state, zip, lat, lng, access_notes, tax_jurisdiction)
  on core.sites to authenticated;

-- definer views: select-only for members (M1)
revoke all on core.v_customer_relationship, pm.v_customer_360, pm.v_job_tieout, pm.v_company_tieout, pm.v_leads_masked from public, anon, authenticated;
grant select on core.v_customer_relationship, pm.v_customer_360, pm.v_job_tieout, pm.v_company_tieout, pm.v_leads_masked to authenticated, service_role;
drop function if exists crm.ar_location_ids();  -- replaced by crm.ar_customer_ids (security review M2)

-- functions: revoke everything 1111 created, then grant the member surface
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'crm'
        or (n.nspname = 'core' and (p.proname like 'party\_%' or p.proname in ('match_parties','merge_parties','dismiss_duplicate',
              'create_contact','create_site','tg_shared_record_touch','tg_contact_refs','tg_site_refs','tg_party_duplicate_net')))
        or (n.nspname = 'pm' and p.proname = 'tieout_business_days')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'core' and obj_description(p.oid, 'pg_proc') is null
       and (p.proname like 'party\_%' or p.proname in ('tg_shared_record_touch','tg_contact_refs','tg_site_refs','tg_party_duplicate_net'))
  loop
    execute format('comment on function %s is %L', r.sig, '1111: internal (not member-executable)');
  end loop;
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'pm' and p.proname = 'tieout_business_days')
        or (n.nspname = 'crm' and p.proname in ('create_lead','move_lead','log_activity','complete_followup','convert_lead',
                                               'my_customer_ids','my_customer_ids_with','can_see_vendors','ar_customer_ids',
                                               'my_contact_ids','my_site_ids','party_visible','books_job_location_ids','customer_caps'))
        or (n.nspname = 'core' and p.proname in ('match_parties','merge_parties','dismiss_duplicate','create_contact','create_site'))
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
comment on function crm.my_customer_ids() is '1111: customers the caller reaches through Projects (RLS building block).';

-- ----------------------------------------------------------------------------
-- 13. Role template update (projects_supervisor + projects.jobs:create)
-- ----------------------------------------------------------------------------
-- 'capability:action' keys of a grant list (order-free comparison).
create or replace function pm.access_grant_keys(p_grants jsonb) returns text[]
language sql immutable
set search_path = pm, core, public
as $$
  select coalesce(array_agg(distinct (e ->> 'capability') || ':' || a order by (e ->> 'capability') || ':' || a), '{}'::text[])
    from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) e
    cross join lateral jsonb_array_elements_text(e -> 'actions') a
$$;

-- Seed / update the Projects platform templates from code and roll new actions out: a template
-- whose published grants differ from code gets a new published version; every tenant clone of
-- it gains the ADDED actions (a tenant's own narrowing of other grants is kept; nothing is
-- removed from a clone). Idempotent. Returns the number of templates republished.
create or replace function pm.access_sync_role_templates(p_templates jsonb) returns integer
language plpgsql
set search_path = pm, core, public
as $$
declare t jsonb; v_tpl uuid; v_ver int; v_cur text[]; v_new text[]; v_add text[]; r record; v_clone jsonb; v_merged jsonb; n int := 0;
begin
  perform core.rbac_seed_platform_roles(p_templates);
  for t in select * from jsonb_array_elements(p_templates) loop
    select id into v_tpl from core.role_definitions where owner_level = 'platform' and key = t ->> 'key';
    continue when v_tpl is null;
    v_cur := pm.access_grant_keys(core.rbac_role_current_grants(v_tpl));
    v_new := pm.access_grant_keys(t -> 'grants');
    if v_cur is distinct from v_new then
      perform core.rbac_publish_role_grants(v_tpl, t -> 'grants', '1111: Merit Projects template update from code');
      n := n + 1;
    end if;
    v_add := array(select x from unnest(v_new) x except select y from unnest(v_cur) y);
    select current_version into v_ver from core.role_definitions where id = v_tpl;
    for r in select rd.id from core.role_definitions rd where rd.owner_level = 'tenant' and rd.upstream_template_id = v_tpl loop
      v_clone := core.rbac_role_current_grants(r.id);
      -- clone grants ∪ the actions this sync added to the template
      select coalesce(jsonb_agg(jsonb_build_object('capability', m.cap, 'actions', to_jsonb(m.acts), 'constraints', m.cons) order by m.cap), '[]'::jsonb)
        into v_merged
        from (select coalesce(c.cap, a.cap) as cap,
                     array(select distinct u from unnest(coalesce(c.acts, '{}'::text[]) || coalesce(a.acts, '{}'::text[])) u
                            order by u) as acts,
                     coalesce(c.cons, '{}'::jsonb) as cons
                from (select e ->> 'capability' as cap, array(select jsonb_array_elements_text(e -> 'actions')) as acts,
                             coalesce(e -> 'constraints', '{}'::jsonb) as cons
                        from jsonb_array_elements(v_clone) e) c
                full join (select split_part(k, ':', 1) as cap, array_agg(split_part(k, ':', 2)) as acts
                             from unnest(v_add) k group by 1) a on a.cap = c.cap) m;
      if cardinality(v_add) > 0 and pm.access_grant_keys(v_merged) is distinct from pm.access_grant_keys(v_clone) then
        perform core.rbac_publish_role_grants(r.id, v_merged, '1111: Merit Projects template update (added actions)');
      end if;
      update core.role_definitions set upstream_version = v_ver where id = r.id and upstream_version is distinct from v_ver;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function pm.access_grant_keys(jsonb) from public, anon, authenticated;
revoke all on function pm.access_sync_role_templates(jsonb) from public, anon, authenticated;
grant execute on function pm.access_grant_keys(jsonb), pm.access_sync_role_templates(jsonb) to service_role;

-- BEGIN GENERATED projects_role_templates (packages/projects-access/scripts/generate-seed.ts — do not edit by hand)
select pm.access_sync_role_templates($seed$[
  {"key":"projects_owner","name":"Projects owner","description":"Every job and all money in the companies assigned, including pay rates, approvals, export and settings.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"visible","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.labor_rates","actions":["view","edit"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.settings","actions":["view","configure"],"constraints":{}},{"capability":"projects.store","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_gm","name":"General manager","description":"Every job and all job money; runs operations and approvals. Sees but does not edit pay rates; no settings changes.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"tenant_admin_only","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.labor_rates","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_office_manager","name":"Office manager","description":"Every job and customer; leads, billing requests, dispatch and documents. Contract values only — no cost or margin.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.change_orders","actions":["view"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_project_accountant","name":"Project accountant","description":"Every job and all job money; billing end to end (approve, send to Books), commitment approval, report export.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"grouped","tin":"masked","bank":"masked","personal":"hidden"},"auth_policy":{"mfa_required":true,"step_up_minutes":10},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit","approve","post"],"constraints":{}},{"capability":"projects.change_orders","actions":["view"],"constraints":{}},{"capability":"projects.commitments","actions":["view","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.estimates","actions":["view"],"constraints":{}},{"capability":"projects.financials","actions":["view","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.reports","actions":["view","export"],"constraints":{}},{"capability":"projects.settings","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_dispatcher","name":"Dispatcher","description":"Every job and customer; leads, scheduling and dispatch. No job money (price-book sell prices only).","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.dispatch","actions":["view","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view"],"constraints":{}}]},
  {"key":"projects_purchasing","name":"Purchasing","description":"Every job; writes and approves purchase orders and subcontracts. Sees job cost, not contract value.","audience":"internal_staff","default_scope":"all_clients","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.financials","actions":["view"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.jobs_all","actions":["view"],"constraints":{}},{"capability":"projects.production","actions":["view"],"constraints":{}},{"capability":"projects.store","actions":["view"],"constraints":{}}]},
  {"key":"projects_pm","name":"Project manager","description":"Their own jobs, with full money on those jobs (no individual pay rates); approves change orders, commitments, time and selections.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.billing","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.change_orders","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.commitments","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view"],"constraints":{}},{"capability":"projects.dispatch","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.financials","actions":["view","edit","export"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.production","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.team","actions":["view","edit"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_supervisor","name":"Supervisor","description":"Their own jobs: schedule, logs, crew time approval and change-order requests. Hours and quantities only — no dollars.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.change_orders","actions":["view","create"],"constraints":{}},{"capability":"projects.dispatch","actions":["view"],"constraints":{}},{"capability":"projects.documents","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.jobs","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.production","actions":["view","edit"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}},{"capability":"projects.team","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit","approve"],"constraints":{}}]},
  {"key":"projects_labor","name":"Crew","description":"The jobs they are assigned to: today's work, their own time, photos and field logs. No dollars and nobody's pay.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"any_grantor","grants":[{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.time","actions":["view","create","edit"],"constraints":{}}]},
  {"key":"projects_sales","name":"Sales","description":"All leads; customers and estimates end to end; their own jobs. Contract values; cost only on the estimates they wrote.","audience":"internal_staff","default_scope":"assigned","field_policy":{"comp":"hidden","tin":"hidden","bank":"hidden","personal":"hidden"},"auth_policy":{"mfa_required":false},"max_assignment_days":null,"assignable_band":"managers","grants":[{"capability":"projects.contract_value","actions":["view"],"constraints":{}},{"capability":"projects.customers","actions":["view","create","edit"],"constraints":{}},{"capability":"projects.documents","actions":["view","create"],"constraints":{}},{"capability":"projects.estimates","actions":["view","create","edit","approve"],"constraints":{}},{"capability":"projects.jobs","actions":["view"],"constraints":{}},{"capability":"projects.leads","actions":["view","create","edit","delete"],"constraints":{}},{"capability":"projects.reports","actions":["view"],"constraints":{}},{"capability":"projects.selections","actions":["view"],"constraints":{}}]}
]$seed$::jsonb);
-- END GENERATED projects_role_templates

-- ----------------------------------------------------------------------------
-- 14. Phone app idempotency: one daily log / checklist / punch item per client command id
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['field_logs', 'punch_items'] loop
    execute format($q$
      do $inner$ begin
        if exists (select 1 from pm.%1$I where ext ? '_client_command_id'
                    group by org_id, ext ->> '_client_command_id' having count(*) > 1) then
          raise exception 'PM_DUPLICATE_COMMANDS: pm.%1$I has rows sharing a _client_command_id — dedupe them before applying 1111';
        end if;
      end $inner$;
      create unique index if not exists pm_%1$s_client_command_uidx on pm.%1$I (org_id, (ext ->> '_client_command_id'))
        where ext ? '_client_command_id';
    $q$, t);
  end loop;
end $$;
comment on index pm.pm_field_logs_client_command_uidx is '1111: the phone app''s command id (ext._client_command_id) is the idempotency key of a daily log / checklist.';
comment on index pm.pm_punch_items_client_command_uidx is '1111: the phone app''s command id (ext._client_command_id) is the idempotency key of a punch item.';

-- ----------------------------------------------------------------------------
-- 15. Rebuild 1110's masked views (core masters gained merged_into / merged_at). Idempotent.
-- ----------------------------------------------------------------------------
select pm.access_apply_masks();

-- ============================================================================
-- end 1111_shared_records
-- ============================================================================
