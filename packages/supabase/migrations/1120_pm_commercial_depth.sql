-- ============================================================================
-- 1120 · Merit Projects — commercial depth (commercial_gc + specialty_trade)
--
-- Spec: expert panel seat 01 (CGC-01…CGC-118, the Launch rows) and seat 07 (FIN-34…FIN-82,
-- FIN-49…FIN-58, FIN-79…FIN-82, FIN-131). Wave B brief: docs/projects/WAVE-B-BRIEF.md.
-- Builds on 1100–1117 (never edits them): pm.change_orders / commitments / commitment_changes /
-- compliance_docs / sov_* / billing_requests / retainage_ledger (1100 / 1102), the cost drain
-- (1103), access classes, masks and RPC guards (1110), the approvals engine (1113: prime CO,
-- commitment change and pay-app finalization still route through pm.approval_decide), the
-- notification fan-out (1114: core.notify_fanout) and e-sign (1115: lien waivers complete through
-- the existing 'lien_waiver' completion kind on pm.compliance_docs).
--
-- AREAS (every table is pm.cm_*; classified in pm.access_table_classes; RPCs registered in
-- pm.access_rpc_guards; money columns of field-visible tables masked through pm.access_masked_columns)
--   1  Change chain        cm_contract_settings, cm_markup_rules, cm_retainage_steps, cm_change_events
--                          (+ lines), cm_rfqs (sub pricing; portal hook = token hash), cm_pcos (+ lines;
--                          1/2/3 tiers), cm_change_event_cost_links (CCD cost to date), cm_sov_co_links.
--                          A PCO / COR submitted to the owner becomes a pm.change_orders row (stage COR);
--                          the owner's approval is the existing CO approval (engine / e-sign), and a
--                          trigger carries it back to the PCO and its change events. Approved prime COs
--                          propose commitment COs (pm.commitment_changes, owner_co_id) for the subs.
--   2  Pay apps            cm_pay_app_status (+ revisions): pencil → sent → certified → final on top of
--                          pm.generate_sov_billing (carry-forward, stored materials, line retainage);
--                          approved COs added to the SOV before every draft; retainage step-downs
--                          (NEW_WORK_ONLY | REDUCE_TO_DATE) and a separate stored-materials rate;
--                          revise / resubmit keeps the application number with a revision history;
--                          finalization still goes through approve_and_emit_billing (JOB_BILLING SOV).
--                          Sub pay apps (cm_sub_pay_apps + lines + actions): commitment SOV,
--                          PM → project accountant → executive-over-threshold chain, preparer ≠ approver,
--                          field opinion check; approval queues a JOB_PAYABLE_REQUEST in
--                          cm_payable_outbox (reserved event — Books consumes the outbox; see below).
--                          cm_payable_retainage = retainage payable (release gated on a final waiver).
--   3  Compliance          cm_lien_waiver_forms (state statutory forms, global catalog), cm_lien_waivers
--                          (4 types, inbound tier 1/2 and outbound), cm_compliance_requirements,
--                          cm_coi_certificates (limits + endorsements CG 20 10 / 20 37 / 24 04, AI, WoS,
--                          PNC), cm_compliance_chases (30/15/0). Every requirement is mirrored into
--                          pm.compliance_docs, so the existing hold logic (pm.commitment_snapshot) puts
--                          payment_hold on JOB_COMMITMENT the moment a waiver is missing or a COI is
--                          deficient / expired — the Books payment run honours it.
--   4  T&M                 cm_rate_sheets, cm_tm_tickets (+ lines; GC signature on device or remote),
--                          cm_tm_billing_links (a ticket is billed once) → T&M billing request or a
--                          change event at contract rates.
--   5  Money control       cm_billing_audit (rules-only billing integrity auditor), cm_wip_snapshots +
--                          cm_wip_schedule (CFMA format; Books' POSTED public.rev_rec_wip_run_lines win
--                          when present), cm_eac_forecasts (+ lines; PM prepares, executive approves,
--                          JOB_PROGRESS PROGRESS_UPDATE with prepared_by / approved_by / commentary),
--                          cm_buyout_packages, cm_review_packages, cm_executive_summary, job cost detail.
--   6  Document control    cm_rfis (+ responses), cm_spec_sections, cm_submittals (+ reviews; register
--                          generated from spec sections; submit-by = on-site − lead − review; fab release
--                          gated on approval), cm_transmittals, cm_correspondence, cm_meetings
--                          (+ attendees, items, item notes: open items carry forward).
--   7  Field / quality     cm_daily_logs (companion of pm.field_logs: sign + lock, amendments only),
--                          cm_log_entries (manpower by company, equipment, deliveries, delays,
--                          visitors, inspections, quantities), cm_daily_log_voice (voice hook),
--                          cm_observations, cm_checklist_templates, cm_inspections (+ items; a failed
--                          item opens an observation), cm_toolbox_talks (+ attendance), cm_jhas,
--                          cm_incidents + OSHA 300 / 300A (cm_safety_hours), cm_closeout_items,
--                          cm_job_closeouts (job close gate).
--   8  Specialty trade     cm_cost_code_units, cm_installed_quantities, cm_fade_alerts (labor
--                          productivity, earned vs actual hours), cm_workforce_requests /
--                          _assignments, cm_proposals (trade proposals → job), billing calendar view.
--   9  Platform            cm_project_templates (+ cm_template_applications; global update),
--                          cm_company_profiles (trade data on the shared vendor/customer master),
--                          cm_project_directory, cm_ball_in_court (the action inbox), notification
--                          event types + triggers (core.notify_fanout).
--
-- SEAM / BOOKS (nothing here posts to the GL)
--   * JOB_COMMITMENT payment_hold: unchanged producer (pm.commitment_snapshot); 1120 only adds
--     requirements (waivers, COI) to pm.compliance_docs and re-emits when the effective hold flips.
--   * JOB_PROGRESS PROGRESS_UPDATE from an approved EAC: same frozen key set as pm.emit_job_progress
--     with cost_estimate_cents = the approved EAC, plus additive keys prepared_by, approved_by,
--     approved_at, eac_commentary, eac_reason_code, uninstalled_materials_cents,
--     inefficiency_excluded_cents, eac_by_cost_type (Books ignores unknown keys until it reads them).
--   * JOB_PAYABLE_REQUEST is RESERVED (Books rejects unknown event types): sub pay-app approvals and
--     retainage releases are queued in pm.cm_payable_outbox (status PENDING) for Books to consume.
--   * WIP: Books' POSTED rev_rec_wip_run_lines are read (definer, guarded) and shown as BOOKS_PINNED;
--     otherwise the Projects live computation is shown and can be pinned in cm_wip_snapshots.
--
-- Idempotent, PGlite-safe. Every definer function: org guard first, search_path pinned
-- (pm, core, public), never executable by anon / PUBLIC.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1120_pm_commercial_depth requires 1110_pm_access';
  end if;
  if to_regclass('pm.billing_requests') is null or to_regclass('pm.change_orders') is null then
    raise exception '1120_pm_commercial_depth requires 1100 / 1102';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Helpers (internal; never granted to members)
-- ----------------------------------------------------------------------------

-- The job's org / company, refusing a job outside the caller's organization (service callers pass).
create or replace function pm._cm_job(p_job uuid, out org_id uuid, out location_id uuid)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  select j.org_id, j.location_id into org_id, location_id from core.jobs j where j.id = p_job;
  if org_id is null or (org_id is distinct from public.get_org_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
end $$;

-- Half-away-from-zero rounding of a numeric to bigint cents (the same rule as lib/commercial/round.ts).
create or replace function pm._cm_round(p numeric) returns bigint
language sql immutable
set search_path = pm, public
as $$ select round(p)::bigint $$;

-- Add a person to a preparer list (separation of duties: nobody who prepared or revised a
-- record may approve it). Null actors (service paths) are not recorded.
create or replace function pm._cm_with(p_list text[], p_who text) returns text[]
language sql immutable
set search_path = pm, public
as $$ select case when p_who is null or p_who = any (coalesce(p_list, '{}'::text[])) then coalesce(p_list, '{}'::text[])
                  else coalesce(p_list, '{}'::text[]) || p_who end $$;

-- The caller is an executive (projects_gm / projects_owner) at the company, or a service path.
create or replace function pm._cm_is_executive(p_location uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from pm.my_access() a
                  where (a.location_id = p_location or p_location is null)
                    and pm.access_persona_rank(a.role_key) >= 90)
$$;

-- Fire an internal notification (1114 fan-out). Never raises: a failed notification must never
-- fail the action that raised it. No-op when the notification service is not installed.
create or replace function pm._cm_notify(
  p_org uuid, p_event text, p_job uuid, p_subject_type text, p_subject_id uuid,
  p_recipients uuid[], p_title text, p_body text, p_link text, p_dedupe text
) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then return; end if;
  if to_regprocedure('core.notify_fanout(uuid, text, uuid, uuid, text, uuid, uuid, uuid[], text, text, text, text, text, text, jsonb, text, text, boolean)') is null then
    return;
  end if;
  if not exists (select 1 from core.notification_event_types e where e.key = p_event) then return; end if;
  begin
    perform core.notify_fanout(p_org, p_event, null, p_job, p_subject_type, p_subject_id,
      core.client_scope_caller_membership(), p_recipients, left(p_title, 200), left(p_body, 500), null, null,
      p_link, p_dedupe, '{}'::jsonb, null, null, false);
  exception when others then
    raise warning 'cm notify % failed: %', p_event, sqlerrm;
  end;
end $$;

-- Members (memberships) holding cap:action at a company — recipients for queue notifications.
create or replace function pm._cm_members_with(p_org uuid, p_location uuid, p_cap text, p_action text) returns uuid[]
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if to_regprocedure('core.notify_members_with(uuid, uuid, text, text)') is null then return '{}'::uuid[]; end if;
  return coalesce(core.notify_members_with(p_org, p_location, p_cap, p_action), '{}'::uuid[]);
exception when others then
  return '{}'::uuid[];
end $$;

-- Retainage on one SOV / commitment line (owner side and sub side share it; mirrored in
-- apps/projects/src/lib/commercial/retainage.ts — a parity test fails when they drift).
--   D previous work, E this period work, F stored now, Fp stored before, prev = retainage held to date.
--   NEW_WORK_ONLY:  stored_td = round(srate × F); work_td = (prev − round(srate × Fp)) + round(rate × E)
--   REDUCE_TO_DATE: stored_td = round(srate × F); work_td = round(rate × (D + E))
--   this period = work_td + stored_td − prev (negative = retainage released by a step-down / install)
create or replace function pm._cm_ret_line(
  p_mode text, p_rate numeric, p_srate numeric, p_d bigint, p_e bigint, p_f bigint, p_fp bigint, p_prev bigint,
  out work_td bigint, out stored_td bigint, out this_period bigint)
language plpgsql immutable
set search_path = pm, public
as $$
begin
  stored_td := round(coalesce(p_srate, p_rate, 0) * coalesce(p_f, 0))::bigint;
  if p_mode = 'REDUCE_TO_DATE' then
    work_td := round(coalesce(p_rate, 0) * (coalesce(p_d, 0) + coalesce(p_e, 0)))::bigint;
  else
    work_td := (coalesce(p_prev, 0) - round(coalesce(p_srate, p_rate, 0) * coalesce(p_fp, 0))::bigint)
               + round(coalesce(p_rate, 0) * coalesce(p_e, 0))::bigint;
  end if;
  this_period := work_td + stored_td - coalesce(p_prev, 0);
end $$;


-- ----------------------------------------------------------------------------
-- 0b. Generic row triggers
-- ----------------------------------------------------------------------------

-- A child row takes its job (and org check) from its parent: tg_argv[0] = parent table,
-- tg_argv[1] = the FK column on the child.
create or replace function pm.tg_cm_child_job() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_job uuid; v_parent uuid;
begin
  v_parent := (to_jsonb(new) ->> tg_argv[1])::uuid;
  if v_parent is null then
    if new.job_id is null then raise exception 'PM_CM_PARENT: % is required', tg_argv[1] using errcode = '23502'; end if;
    return new;
  end if;
  execute format('select org_id, job_id from pm.%I where id = $1', tg_argv[0]) into v_org, v_job using v_parent;
  if v_job is null or v_org is distinct from new.org_id then
    raise exception 'PM_CM_PARENT: % % not found', tg_argv[0], v_parent using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id and old.job_id is not null and v_job <> old.job_id then
    raise exception 'PM_CM_JOB_FIXED: a row cannot move between jobs' using errcode = '42501';
  end if;
  new.job_id := v_job;
  return new;
end $$;

-- Mint a per-job document number when none was given: tg_argv[0] = counter kind, tg_argv[1] =
-- prefix, tg_argv[2] = zero-pad width.
create or replace function pm.tg_cm_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v text; n bigint;
begin
  if coalesce(btrim(to_jsonb(new) ->> 'number'), '') <> '' then return new; end if;
  n := pm.next_doc_number(new.org_id, new.job_id::text, tg_argv[0], 'all');
  v := tg_argv[1] || lpad(n::text, coalesce(tg_argv[2], '3')::int, '0');
  new := jsonb_populate_record(new, jsonb_build_object('number', v));
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Contract settings, markup rules, retainage step-downs
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_contract_settings (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                  uuid not null,
  contract_id             uuid,
  change_tiers            int not null default 2 check (change_tiers between 1 and 3),
  billing_cutoff_day      int not null default 25 check (billing_cutoff_day between 1 and 31),
  pencil_lead_days        int not null default 5 check (pencil_lead_days between 0 and 30),
  billing_form            text not null default 'AIA' check (billing_form in ('AIA','GC_FORM','OWNER_FORM','TEXTURA','GCPAY','PROCORE_PAY','OTHER')),
  billing_portal_url      text check (billing_portal_url is null or char_length(billing_portal_url) <= 500),
  retainage_step_mode     text not null default 'NEW_WORK_ONLY' check (retainage_step_mode in ('NEW_WORK_ONLY','REDUCE_TO_DATE')),
  stored_retainage_pct    numeric(5,4) check (stored_retainage_pct is null or (stored_retainage_pct >= 0 and stored_retainage_pct <= 1)),
  project_state           text check (project_state is null or project_state ~ '^[A-Z]{2}$'),
  pay_when_paid           boolean not null default false,
  architect_certification boolean not null default true,
  notarization_required   boolean not null default false,
  px_threshold_cents      bigint not null default 2500000 check (px_threshold_cents >= 0),
  eac_commentary_pct      numeric(6,4) not null default 0.02 check (eac_commentary_pct >= 0),
  eac_commentary_cents    bigint not null default 1000000 check (eac_commentary_cents >= 0),
  rfi_default_days        int not null default 7 check (rfi_default_days between 1 and 90),
  submittal_review_days   int not null default 10 check (submittal_review_days between 1 and 90),
  substantial_completion_on date,
  final_completion_on     date,
  bonded                  boolean not null default false,
  prevailing_wage         boolean not null default false,
  apprentice_ratio        numeric(5,2) not null default 1 check (apprentice_ratio > 0),
  ext                     jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, job_id),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, contract_id) references pm.contracts (org_id, id) deferrable initially immediate
);

-- Markup rules per contract (CGC-34): OH&P, bond, insurance, labor burden, fee. Tiers: a family
-- (kind × applies_to × cost_type) may have several rows; the one with the smallest tier_max_cents
-- ≥ the base applies (null = no upper bound). compounding = applied on cost + earlier markups.
create table if not exists pm.cm_markup_rules (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  kind                text not null check (kind in ('OHP','OVERHEAD','PROFIT','FEE','BOND','INSURANCE','LABOR_BURDEN','OTHER')),
  label               text check (label is null or char_length(label) <= 80),
  applies_to          text not null default 'ALL' check (applies_to in ('ALL','SELF_PERFORM','SUBCONTRACT')),
  cost_type           text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  pct                 numeric(7,5) not null check (pct >= 0 and pct <= 1),
  compounding         boolean not null default false,
  tier_max_cents      bigint check (tier_max_cents is null or tier_max_cents > 0),
  min_cents           bigint check (min_cents is null or min_cents >= 0),
  max_cents           bigint check (max_cents is null or max_cents >= 0),
  sort                int not null default 0,
  is_active           boolean not null default true,
  source_template_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_markup_rules_job_idx on pm.cm_markup_rules (org_id, job_id, sort);

-- Retainage step-downs (FIN-58 / FIN-80): from_pct = completion (prior to-date / scheduled) at or
-- above which `rate` applies. side RECEIVABLE = owner pay apps; PAYABLE = sub pay apps (per
-- commitment, or job-wide when commitment_id is null).
create table if not exists pm.cm_retainage_steps (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  side                text not null default 'RECEIVABLE' check (side in ('RECEIVABLE','PAYABLE')),
  commitment_id       uuid,
  from_pct            numeric(5,4) not null check (from_pct >= 0 and from_pct <= 1),
  rate                numeric(5,4) not null check (rate >= 0 and rate <= 1),
  note                text,
  source_template_id  uuid,
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  unique nulls not distinct (org_id, job_id, side, commitment_id, from_pct),
  check (side = 'PAYABLE' or commitment_id is null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm._cm_step_rate(p_org uuid, p_job uuid, p_side text, p_commitment uuid, p_completion numeric, p_base numeric)
returns numeric
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((
    select s.rate from pm.cm_retainage_steps s
     where s.org_id = p_org and s.job_id = p_job and s.side = p_side
       and (s.commitment_id = p_commitment or s.commitment_id is null)
       and s.from_pct <= coalesce(p_completion, 0)
     order by (s.commitment_id is not null) desc, s.from_pct desc limit 1), p_base)
$$;

-- ----------------------------------------------------------------------------
-- 2. Change events → RFQs → PCO / COR → prime CO
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_change_events (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  number             text,
  title              text not null check (char_length(title) between 1 and 200),
  description        text,
  source_type        text not null default 'FIELD' check (source_type in ('RFI','ASI','BULLETIN','CCD','FIELD','OWNER_REQUEST','DESIGN','BACKCHARGE','TM','ALLOWANCE','DRAWING_REVISION','OTHER')),
  source_table       text check (source_table is null or source_table in ('cm_rfis','cm_tm_tickets','cm_meeting_items','cm_daily_logs','drawing_revisions','cm_correspondence')),
  source_id          uuid,
  scope              text not null default 'TBD' check (scope in ('IN','OUT','TBD')),
  reason_code        text check (reason_code is null or reason_code in ('OWNER_CHANGE','DESIGN_ERROR','UNFORESEEN','CODE','VALUE_ENGINEERING','SCHEDULE','CONTRACTOR','ALLOWANCE','OTHER')),
  status             text not null default 'OPEN' check (status in ('OPEN','PRICING','PRICED','SUBMITTED','APPROVED','REJECTED','NO_COST','VOID')),
  proceeding         boolean not null default false,
  directive_ref      text check (directive_ref is null or char_length(directive_ref) <= 60),
  proceeding_since   date,
  rom_revenue_cents  bigint,
  rom_cost_cents     bigint,
  schedule_days      int,
  pco_id             uuid,
  change_order_id    uuid,
  due_on             date,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  check (not proceeding or proceeding_since is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_order_id) references pm.change_orders (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_change_events_job_idx on pm.cm_change_events (org_id, job_id, status);

create table if not exists pm.cm_change_event_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid,
  change_event_id    uuid not null,
  line_no            int not null default 0,
  cost_code_id       uuid,
  cost_type          text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  description        text not null default '',
  commitment_id      uuid,
  vendor_id          uuid references core.vendors(id),
  qty                numeric(14,4),
  uom                text,
  rom_cost_cents     bigint,
  rom_revenue_cents  bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, change_event_id) references pm.cm_change_events (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_ce_lines_ce_idx on pm.cm_change_event_lines (org_id, change_event_id, line_no);

create table if not exists pm.cm_rfqs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  change_event_id    uuid not null,
  number             text not null,
  vendor_id          uuid not null references core.vendors(id),
  commitment_id      uuid,
  status             text not null default 'SENT' check (status in ('DRAFT','SENT','RESPONDED','ACCEPTED','DECLINED','VOID')),
  scope_text         text,
  due_on             date,
  sent_at            timestamptz,
  responded_at       timestamptz,
  response_channel   text check (response_channel is null or response_channel in ('PORTAL','INTERNAL','EMAIL')),
  responder_name     text,
  labor_cents        bigint not null default 0,
  material_cents     bigint not null default 0,
  equipment_cents    bigint not null default 0,
  subcontract_cents  bigint not null default 0,
  other_cents        bigint not null default 0,
  markup_cents       bigint not null default 0,
  total_cents        bigint not null default 0,
  schedule_days      int,
  exclusions         text,
  response_notes     text,
  portal_token_hash  text,
  portal_token_expires timestamptz,
  accepted_at        timestamptz,
  accepted_by        text,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_event_id) references pm.cm_change_events (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_cm_rfqs_token_uidx on pm.cm_rfqs (portal_token_hash) where portal_token_hash is not null;
create index if not exists pm_cm_rfqs_ce_idx on pm.cm_rfqs (org_id, change_event_id);

create table if not exists pm.cm_pcos (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  contract_id        uuid,
  number             text,
  tier               text not null default 'PCO' check (tier in ('PCO','COR')),
  parent_cor_id      uuid,
  title              text not null check (char_length(title) between 1 and 200),
  narrative          text,
  status             text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','REVISE','APPROVED','REJECTED','VOID','ROLLED_UP')),
  cost_cents         bigint not null default 0,
  markup_cents       bigint not null default 0,
  amount_cents       bigint not null default 0,
  markup_detail      jsonb not null default '[]' check (jsonb_typeof(markup_detail) = 'array'),
  schedule_days      int,
  change_order_id    uuid,
  submitted_at       timestamptz,
  due_on             date,
  decided_at         timestamptz,
  decision_note      text,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_order_id) references pm.change_orders (org_id, id) deferrable initially immediate,
  foreign key (org_id, parent_cor_id) references pm.cm_pcos (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_pcos_job_idx on pm.cm_pcos (org_id, job_id, status);
create index if not exists pm_cm_pcos_co_idx on pm.cm_pcos (org_id, change_order_id) where change_order_id is not null;

create table if not exists pm.cm_pco_lines (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid,
  pco_id               uuid not null,
  change_event_id      uuid,
  change_event_line_id uuid,
  rfq_id               uuid,
  commitment_id        uuid,
  vendor_id            uuid,
  cost_code_id         uuid,
  cost_type            text check (cost_type is null or cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  source               text not null default 'SELF' check (source in ('SELF','SUB')),
  description          text not null default '',
  cost_cents           bigint not null default 0,
  markup_cents         bigint not null default 0,
  amount_cents         bigint not null default 0,
  sort                 int not null default 0,
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, pco_id) references pm.cm_pcos (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_pco_lines_pco_idx on pm.cm_pco_lines (org_id, pco_id, sort);

-- CCD / work-proceeding cost to date: costs tagged to a change event (FIN / CGC-36).
create table if not exists pm.cm_change_event_cost_links (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid,
  change_event_id  uuid not null,
  source_table     text not null check (source_table in ('job_costs','time_entries')),
  source_id        uuid not null,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, source_table, source_id),
  foreign key (org_id, change_event_id) references pm.cm_change_events (org_id, id) on delete cascade deferrable initially immediate
);

-- Approved prime COs carried onto the schedule of values (one row per CO; the auditor's ground truth).
create table if not exists pm.cm_sov_co_links (
  org_id           uuid not null references core.organizations(id) on delete cascade,
  change_order_id  uuid not null,
  job_id           uuid not null,
  sov_version_id   uuid not null,
  sov_lineage_id   uuid,
  amount_cents     bigint not null,
  mode             text not null check (mode in ('NEW_LINE','REDUCED_LINE')),
  synced_at        timestamptz not null default now(),
  primary key (org_id, change_order_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_order_id) references pm.change_orders (org_id, id) on delete cascade deferrable initially immediate
);

-- ---- triggers --------------------------------------------------------------
-- Field roles create change events without a price (CGC-32): a member without the money capability
-- on the job may not set or change ROM figures.
create or replace function pm.tg_cm_change_event_money() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_rev boolean; v_cost boolean;
begin
  if not pm.access_member_role() then return new; end if;
  v_rev := tg_op = 'INSERT' and new.rom_revenue_cents is not null
        or tg_op = 'UPDATE' and new.rom_revenue_cents is distinct from old.rom_revenue_cents;
  v_cost := tg_op = 'INSERT' and new.rom_cost_cents is not null
         or tg_op = 'UPDATE' and new.rom_cost_cents is distinct from old.rom_cost_cents;
  if v_rev and not exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = new.job_id) then
    raise exception 'PM_MONEY_FORBIDDEN: pricing a change needs Contract value on this job' using errcode = '42501';
  end if;
  if v_cost and not exists (select 1 from pm.my_money_job_ids('projects.financials') x where x = new.job_id) then
    raise exception 'PM_MONEY_FORBIDDEN: costing a change needs Job financials on this job' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status in ('SUBMITTED','APPROVED','REJECTED','VOID','NO_COST')
     and (new.rom_revenue_cents is distinct from old.rom_revenue_cents or new.rom_cost_cents is distinct from old.rom_cost_cents) then
    raise exception 'PM_CHANGE_EVENT_LOCKED: % is %; reprice through its PCO', old.number, old.status using errcode = '42501';
  end if;
  return new;
end $$;

-- Change-event ROM = the sum of its lines when it has lines.
create or replace function pm.tg_cm_ce_line_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_ce uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_ce := old.change_event_id; else v_org := new.org_id; v_ce := new.change_event_id; end if;
  update pm.cm_change_events e
     set rom_cost_cents = t.cost, rom_revenue_cents = t.rev
    from (select sum(l.rom_cost_cents)::bigint as cost, sum(l.rom_revenue_cents)::bigint as rev
            from pm.cm_change_event_lines l where l.org_id = v_org and l.change_event_id = v_ce) t
   where e.org_id = v_org and e.id = v_ce
     and (e.rom_cost_cents, e.rom_revenue_cents) is distinct from (t.cost, t.rev);
  return null;
end $$;

create or replace function pm.tg_cm_ce_line_money() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text;
begin
  if not pm.access_member_role() then return coalesce(new, old); end if;
  select e.status into v_status from pm.cm_change_events e where e.id = coalesce(new.change_event_id, old.change_event_id);
  if v_status in ('SUBMITTED','APPROVED','REJECTED','VOID','NO_COST') then
    raise exception 'PM_CHANGE_EVENT_LOCKED: the change event is %', v_status using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if (tg_op = 'INSERT' and new.rom_revenue_cents is not null or tg_op = 'UPDATE' and new.rom_revenue_cents is distinct from old.rom_revenue_cents)
     and not exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = new.job_id) then
    raise exception 'PM_MONEY_FORBIDDEN: pricing a change needs Contract value on this job' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and new.rom_cost_cents is not null or tg_op = 'UPDATE' and new.rom_cost_cents is distinct from old.rom_cost_cents)
     and not exists (select 1 from pm.my_money_job_ids('projects.financials') x where x = new.job_id) then
    raise exception 'PM_MONEY_FORBIDDEN: costing a change needs Job financials on this job' using errcode = '42501';
  end if;
  return new;
end $$;

-- Members edit PCO lines only while the PCO is a DRAFT / REVISE; totals follow the lines.
create or replace function pm.tg_cm_pco_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text;
begin
  select p.status into v_status from pm.cm_pcos p where p.id = coalesce(new.pco_id, old.pco_id);
  if pm.access_member_role() and v_status not in ('DRAFT','REVISE') then
    raise exception 'PM_PCO_LOCKED: PCO lines change only while DRAFT or REVISE (is %)', v_status using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create or replace function pm.tg_cm_pco_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if pm.access_member_role() then
    if tg_op = 'INSERT' and new.status <> 'DRAFT' then
      raise exception 'PM_PCO_STATE: a PCO starts as DRAFT' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.change_order_id is distinct from old.change_order_id
        or new.cost_cents is distinct from old.cost_cents or new.markup_cents is distinct from old.markup_cents
        or new.amount_cents is distinct from old.amount_cents) then
      raise exception 'PM_PCO_STATE: status and totals move only through the PCO actions' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.status not in ('DRAFT','REVISE') then
      raise exception 'PM_PCO_LOCKED: % is %', old.number, old.status using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cm_contract_settings','cm_markup_rules','cm_change_events','cm_change_event_lines','cm_rfqs','cm_pcos'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['cm_change_events','cm_rfqs','cm_pcos','cm_change_event_cost_links'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;

create or replace trigger trg_cm_number before insert on pm.cm_change_events
  for each row execute function pm.tg_cm_number('CM_CE', 'CE-', '3');
create or replace trigger trg_cm_money before insert or update on pm.cm_change_events
  for each row execute function pm.tg_cm_change_event_money();
create or replace trigger trg_cm_child_job before insert or update of change_event_id on pm.cm_change_event_lines
  for each row execute function pm.tg_cm_child_job('cm_change_events', 'change_event_id');
create or replace trigger trg_cm_money before insert or update or delete on pm.cm_change_event_lines
  for each row execute function pm.tg_cm_ce_line_money();
create or replace trigger trg_cm_totals after insert or update of rom_cost_cents, rom_revenue_cents or delete on pm.cm_change_event_lines
  for each row execute function pm.tg_cm_ce_line_totals();
create or replace trigger trg_cm_number before insert on pm.cm_pcos
  for each row execute function pm.tg_cm_number('CM_PCO', 'PCO-', '3');
create or replace trigger trg_cm_pco_guard before insert or update on pm.cm_pcos
  for each row execute function pm.tg_cm_pco_guard();
create or replace trigger trg_cm_child_job before insert or update of pco_id on pm.cm_pco_lines
  for each row execute function pm.tg_cm_child_job('cm_pcos', 'pco_id');
create or replace trigger trg_cm_line_guard before insert or update or delete on pm.cm_pco_lines
  for each row execute function pm.tg_cm_pco_line_guard();
create or replace trigger trg_cm_child_job before insert or update of change_event_id on pm.cm_change_event_cost_links
  for each row execute function pm.tg_cm_child_job('cm_change_events', 'change_event_id');

-- ---- markup engine (mirrored by lib/commercial/markup.ts) ------------------
-- p_lines: [{cost_cents, cost_type, source: SELF|SUB}] → {cost_cents, markup_cents, amount_cents,
-- detail: [{kind, label, pct, base_cents, amount_cents}]}.
create or replace function pm._cm_markup(p_org uuid, p_job uuid, p_lines jsonb) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  fam record; r pm.cm_markup_rules%rowtype; v_cost bigint := 0; v_running bigint; v_base bigint; v_amt bigint;
  v_detail jsonb := '[]'::jsonb; v_markup bigint := 0;
begin
  select coalesce(sum((x ->> 'cost_cents')::bigint), 0) into v_cost from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x;
  v_running := v_cost;
  for fam in
    select m.kind, m.applies_to, m.cost_type, min(m.sort) as s
      from pm.cm_markup_rules m
     where m.org_id = p_org and m.job_id = p_job and m.is_active
     group by m.kind, m.applies_to, m.cost_type
     order by min(m.sort), m.kind, m.applies_to, m.cost_type nulls first
  loop
    select coalesce(sum((x ->> 'cost_cents')::bigint), 0) into v_base
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
     where (fam.applies_to = 'ALL'
            or (fam.applies_to = 'SUBCONTRACT' and coalesce(x ->> 'source', 'SELF') = 'SUB')
            or (fam.applies_to = 'SELF_PERFORM' and coalesce(x ->> 'source', 'SELF') <> 'SUB'))
       and (fam.cost_type is null or x ->> 'cost_type' = fam.cost_type);
    select * into r from pm.cm_markup_rules m
     where m.org_id = p_org and m.job_id = p_job and m.is_active and m.kind = fam.kind and m.applies_to = fam.applies_to
       and m.cost_type is not distinct from fam.cost_type
     order by (m.compounding) desc, m.tier_max_cents nulls last limit 1;   -- compounding is a family property
    if r.compounding then v_base := v_running; end if;
    select * into r from pm.cm_markup_rules m
     where m.org_id = p_org and m.job_id = p_job and m.is_active and m.kind = fam.kind and m.applies_to = fam.applies_to
       and m.cost_type is not distinct from fam.cost_type and (m.tier_max_cents is null or m.tier_max_cents >= abs(v_base))
     order by m.tier_max_cents nulls last, m.sort, m.id limit 1;
    continue when r.id is null or v_base = 0;
    v_amt := round(v_base * r.pct)::bigint;
    if r.min_cents is not null and v_amt > 0 and v_amt < r.min_cents then v_amt := r.min_cents; end if;
    if r.max_cents is not null and v_amt > r.max_cents then v_amt := r.max_cents; end if;
    v_markup := v_markup + v_amt;
    v_running := v_running + v_amt;
    v_detail := v_detail || jsonb_build_object('kind', r.kind, 'label', coalesce(r.label, r.kind), 'pct', r.pct,
                                               'base_cents', v_base, 'amount_cents', v_amt);
  end loop;
  return jsonb_build_object('cost_cents', v_cost, 'markup_cents', v_markup, 'amount_cents', v_cost + v_markup, 'detail', v_detail);
end $$;

-- Re-total a PCO: line markups are allocated pro rata to line cost (largest-remainder on the last line).
create or replace function pm._cm_pco_retotal(p_pco uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_pcos%rowtype; v_m jsonb; v_total_cost bigint; v_left bigint; l record; v_alloc bigint; v_n int; i int := 0;
begin
  select * into p from pm.cm_pcos where id = p_pco;
  select jsonb_agg(jsonb_build_object('cost_cents', x.cost_cents, 'cost_type', x.cost_type, 'source', x.source)) into v_m
    from pm.cm_pco_lines x where x.org_id = p.org_id and x.pco_id = p.id;
  v_m := pm._cm_markup(p.org_id, p.job_id, coalesce(v_m, '[]'::jsonb));
  select coalesce(sum(x.cost_cents), 0), count(*) into v_total_cost, v_n from pm.cm_pco_lines x where x.org_id = p.org_id and x.pco_id = p.id;
  v_left := (v_m ->> 'markup_cents')::bigint;
  for l in select x.id, x.cost_cents from pm.cm_pco_lines x where x.org_id = p.org_id and x.pco_id = p.id order by x.sort, x.id loop
    i := i + 1;
    v_alloc := case when i = v_n then v_left when v_total_cost = 0 then 0
                    else round((v_m ->> 'markup_cents')::numeric * l.cost_cents / v_total_cost)::bigint end;
    update pm.cm_pco_lines set markup_cents = v_alloc, amount_cents = l.cost_cents + v_alloc where id = l.id;
    v_left := v_left - v_alloc;
  end loop;
  update pm.cm_pcos set cost_cents = (v_m ->> 'cost_cents')::bigint, markup_cents = (v_m ->> 'markup_cents')::bigint,
         amount_cents = (v_m ->> 'amount_cents')::bigint, markup_detail = v_m -> 'detail'
   where id = p.id;
end $$;

-- ---- change event actions ----------------------------------------------------
create or replace function pm.cm_change_event_set_status(p_change_event uuid, p_status text, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.cm_change_events%rowtype; ok boolean; v_loc uuid;
begin
  select * into e from pm.cm_change_events where id = p_change_event for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change event % not found in the caller''s organization', p_change_event using errcode = '42501';
  end if;
  ok := case e.status
          when 'OPEN' then p_status in ('PRICING','NO_COST','VOID')
          when 'PRICING' then p_status in ('OPEN','NO_COST','VOID')
          when 'PRICED' then p_status in ('PRICING','NO_COST','VOID')
          when 'REJECTED' then p_status in ('OPEN','VOID')
          when 'NO_COST' then p_status in ('OPEN')
          else false end;
  if not ok then raise exception 'PM_CHANGE_EVENT_TRANSITION: % -> %', e.status, p_status using errcode = '22023'; end if;
  update pm.cm_change_events set status = p_status, proceeding = case when p_status in ('VOID','NO_COST') then false else proceeding end where id = e.id;
  select j.location_id into v_loc from core.jobs j where j.id = e.job_id;
  perform pm.log_activity(e.org_id, v_loc, e.job_id, 'change_event.' || lower(p_status), 'cm_change_events', e.id,
    format('%s %s → %s', e.number, e.status, p_status), jsonb_build_object('note', p_note));
  return e.id;
end $$;

-- CCD / directive: work proceeds before pricing (flagged until priced and approved).
create or replace function pm.cm_change_event_proceed(p_change_event uuid, p_proceeding boolean, p_directive text default null, p_since date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.cm_change_events%rowtype; v_loc uuid;
begin
  select * into e from pm.cm_change_events where id = p_change_event for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change event % not found in the caller''s organization', p_change_event using errcode = '42501';
  end if;
  if e.status in ('VOID','NO_COST','REJECTED') and p_proceeding then
    raise exception 'PM_CHANGE_EVENT_CLOSED: % is %', e.number, e.status using errcode = '22023';
  end if;
  update pm.cm_change_events
     set proceeding = coalesce(p_proceeding, false),
         proceeding_since = case when coalesce(p_proceeding, false) then coalesce(p_since, proceeding_since, current_date) end,
         directive_ref = coalesce(p_directive, directive_ref),
         source_type = case when coalesce(p_proceeding, false) and p_directive is not null and source_type = 'FIELD' then 'CCD' else source_type end
   where id = e.id;
  select j.location_id into v_loc from core.jobs j where j.id = e.job_id;
  perform pm.log_activity(e.org_id, v_loc, e.job_id, case when p_proceeding then 'change_event.proceeding' else 'change_event.proceeding_cleared' end,
    'cm_change_events', e.id, format('%s %s', e.number, case when p_proceeding then 'proceeding before pricing' else 'no longer proceeding' end),
    jsonb_build_object('directive', p_directive, 'since', p_since));
  return e.id;
end $$;

-- Tag a cost (Books job cost row or a time entry) to a change event (CCD cost to date).
create or replace function pm.cm_link_change_cost(p_change_event uuid, p_source_table text, p_source_id uuid, p_link boolean default true)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.cm_change_events%rowtype; v_job uuid; v_id uuid;
begin
  select * into e from pm.cm_change_events where id = p_change_event;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change event % not found in the caller''s organization', p_change_event using errcode = '42501';
  end if;
  if p_source_table = 'job_costs' then
    select c.job_id into v_job from pm.job_costs c where c.org_id = e.org_id and c.id = p_source_id;
  elsif p_source_table = 'time_entries' then
    select t.job_id into v_job from pm.time_entries t where t.org_id = e.org_id and t.id = p_source_id;
  else
    raise exception 'PM_INVALID: link job_costs or time_entries' using errcode = '22023';
  end if;
  if v_job is distinct from e.job_id then raise exception 'PM_CM_LINK_JOB: the cost is not on this job' using errcode = '22023'; end if;
  if not coalesce(p_link, true) then
    delete from pm.cm_change_event_cost_links where org_id = e.org_id and source_table = p_source_table and source_id = p_source_id;
    return null;
  end if;
  insert into pm.cm_change_event_cost_links (org_id, job_id, change_event_id, source_table, source_id, created_by)
  values (e.org_id, e.job_id, e.id, p_source_table, p_source_id, pm.current_user_id())
  on conflict (org_id, source_table, source_id) do update set change_event_id = excluded.change_event_id
  returning id into v_id;
  return v_id;
end $$;

-- ---- RFQs ----------------------------------------------------------------------
create or replace function pm.cm_send_rfq(p_change_event uuid, p_vendor uuid, p_commitment uuid default null, p_due date default null,
                                          p_scope text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.cm_change_events%rowtype; v_id uuid; n bigint; v_loc uuid;
begin
  select * into e from pm.cm_change_events where id = p_change_event for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change event % not found in the caller''s organization', p_change_event using errcode = '42501';
  end if;
  if e.status not in ('OPEN','PRICING','PRICED') then raise exception 'PM_CHANGE_EVENT_CLOSED: % is %', e.number, e.status using errcode = '22023'; end if;
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = e.org_id) then
    raise exception 'PM_UNKNOWN_VENDOR: %', p_vendor using errcode = '23503';
  end if;
  if p_commitment is not null and not exists (select 1 from pm.commitments c where c.id = p_commitment and c.org_id = e.org_id
                                                 and c.job_id = e.job_id and c.vendor_id = p_vendor) then
    raise exception 'PM_RFQ_COMMITMENT: the commitment is not this vendor''s on this job' using errcode = '23514';
  end if;
  n := pm.next_doc_number(e.org_id, e.id::text, 'CM_RFQ', 'all');
  insert into pm.cm_rfqs (org_id, job_id, change_event_id, number, vendor_id, commitment_id, status, scope_text, due_on, sent_at, created_by)
  values (e.org_id, e.job_id, e.id, e.number || '-Q' || n, p_vendor, p_commitment, 'SENT', coalesce(p_scope, e.description, e.title),
          coalesce(p_due, current_date + 7), now(), pm.current_user_id())
  returning id into v_id;
  if e.status = 'OPEN' then update pm.cm_change_events set status = 'PRICING' where id = e.id; end if;
  select j.location_id into v_loc from core.jobs j where j.id = e.job_id;
  perform pm.log_activity(e.org_id, v_loc, e.job_id, 'rfq.sent', 'cm_rfqs', v_id, format('RFQ sent for %s', e.number),
    jsonb_build_object('vendor_id', p_vendor, 'due_on', coalesce(p_due, current_date + 7)));
  return v_id;
end $$;

-- Store the hash of the sub portal's one-time pricing link (the 1118 portal sends the link).
create or replace function pm.cm_rfq_set_portal_token(p_rfq uuid, p_token_hash text, p_expires timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.cm_rfqs%rowtype;
begin
  select * into q from pm.cm_rfqs where id = p_rfq for update;
  if q.org_id is null or q.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFQ % not found in the caller''s organization', p_rfq using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash must be sha-256 hex' using errcode = '22023'; end if;
  update pm.cm_rfqs set portal_token_hash = p_token_hash, portal_token_expires = coalesce(p_expires, now() + interval '21 days') where id = q.id;
  return q.id;
end $$;

-- Record a sub's price (internal entry or portal). Shared core.
create or replace function pm._cm_rfq_apply_response(p_rfq uuid, p_response jsonb, p_channel text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.cm_rfqs%rowtype; v_l bigint; v_m bigint; v_e bigint; v_s bigint; v_o bigint; v_mk bigint; v_total bigint;
begin
  select * into q from pm.cm_rfqs where id = p_rfq for update;
  if q.status not in ('SENT','RESPONDED') then raise exception 'PM_RFQ_CLOSED: % is %', q.number, q.status using errcode = '22023'; end if;
  v_l := coalesce((p_response ->> 'labor_cents')::bigint, 0);
  v_m := coalesce((p_response ->> 'material_cents')::bigint, 0);
  v_e := coalesce((p_response ->> 'equipment_cents')::bigint, 0);
  v_s := coalesce((p_response ->> 'subcontract_cents')::bigint, 0);
  v_o := coalesce((p_response ->> 'other_cents')::bigint, 0);
  v_mk := coalesce((p_response ->> 'markup_cents')::bigint, 0);
  v_total := coalesce((p_response ->> 'total_cents')::bigint, v_l + v_m + v_e + v_s + v_o + v_mk);
  if v_total <> v_l + v_m + v_e + v_s + v_o + v_mk and (v_l + v_m + v_e + v_s + v_o + v_mk) <> 0 then
    raise exception 'PM_RFQ_TOTAL: the breakdown (% cents) does not add up to the total (% cents)', v_l + v_m + v_e + v_s + v_o + v_mk, v_total using errcode = '22023';
  end if;
  update pm.cm_rfqs
     set status = 'RESPONDED', responded_at = now(), response_channel = p_channel,
         responder_name = left(p_response ->> 'responder_name', 120),
         labor_cents = v_l, material_cents = v_m, equipment_cents = v_e, subcontract_cents = v_s, other_cents = v_o,
         markup_cents = v_mk, total_cents = v_total,
         schedule_days = (p_response ->> 'schedule_days')::int,
         exclusions = left(p_response ->> 'exclusions', 4000), response_notes = left(p_response ->> 'notes', 4000)
   where id = q.id;
  perform pm.log_activity(q.org_id, (select location_id from core.jobs where id = q.job_id), q.job_id, 'rfq.responded', 'cm_rfqs', q.id,
    format('%s priced (%s)', q.number, lower(p_channel)), jsonb_build_object('channel', p_channel), case when p_channel = 'PORTAL' then 'SYSTEM' else 'HUMAN' end);
  return q.id;
end $$;

create or replace function pm.cm_rfq_respond(p_rfq uuid, p_response jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.cm_rfqs%rowtype;
begin
  select * into q from pm.cm_rfqs where id = p_rfq;
  if q.org_id is null or q.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFQ % not found in the caller''s organization', p_rfq using errcode = '42501';
  end if;
  return pm._cm_rfq_apply_response(p_rfq, coalesce(p_response, '{}'::jsonb), 'INTERNAL');
end $$;

-- Sub portal pricing hook (service_role only; the portal resolves the token, never a member).
create or replace function pm.cm_rfq_portal_respond(p_token_hash text, p_response jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.cm_rfqs%rowtype;
begin
  if not pm.access_is_service() then raise exception 'PM_FORBIDDEN: the portal hook runs on the service path only' using errcode = '42501'; end if;
  select * into q from pm.cm_rfqs where portal_token_hash = p_token_hash;
  if q.id is null or q.portal_token_expires < now() then
    raise exception 'PM_RFQ_TOKEN: this pricing link is not valid any more' using errcode = '42501';
  end if;
  return pm._cm_rfq_apply_response(q.id, coalesce(p_response, '{}'::jsonb), 'PORTAL');
end $$;

create or replace function pm.cm_rfq_decide(p_rfq uuid, p_accept boolean)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare q pm.cm_rfqs%rowtype;
begin
  select * into q from pm.cm_rfqs where id = p_rfq for update;
  if q.org_id is null or q.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFQ % not found in the caller''s organization', p_rfq using errcode = '42501';
  end if;
  if p_accept and q.status <> 'RESPONDED' then raise exception 'PM_RFQ_NOT_PRICED: % is %', q.number, q.status using errcode = '22023'; end if;
  if q.status in ('VOID') then raise exception 'PM_RFQ_CLOSED: %', q.number using errcode = '22023'; end if;
  if p_accept then
    -- one accepted price per vendor per change event
    update pm.cm_rfqs set status = 'DECLINED' where org_id = q.org_id and change_event_id = q.change_event_id
       and vendor_id = q.vendor_id and status = 'ACCEPTED' and id <> q.id;
  end if;
  update pm.cm_rfqs set status = case when p_accept then 'ACCEPTED' else 'DECLINED' end,
         accepted_at = case when p_accept then now() end, accepted_by = case when p_accept then pm.current_user_id() end
   where id = q.id;
  return q.id;
end $$;

-- ---- PCO / COR -------------------------------------------------------------------
-- Price change events into a PCO (or a COR when the contract runs one tier). Sub lines use the
-- accepted RFQ price (else the line's ROM cost); self-performed lines use ROM cost. Markups per rules.
create or replace function pm.cm_build_pco(p_job uuid, p_change_events uuid[], p_title text default null, p_tier text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  j record; v_tiers int; v_tier text; v_id uuid := gen_random_uuid(); e record; l record; q record; v_sort int := 0;
  v_title text; v_days int;
begin
  select * into j from pm._cm_job(p_job);
  if p_change_events is null or cardinality(p_change_events) = 0 then raise exception 'PM_INVALID: pick at least one change event' using errcode = '22023'; end if;
  select coalesce(s.change_tiers, 2) into v_tiers from pm.cm_contract_settings s where s.org_id = j.org_id and s.job_id = p_job;
  v_tiers := coalesce(v_tiers, 2);
  v_tier := coalesce(p_tier, case when v_tiers = 1 then 'COR' else 'PCO' end);
  if v_tier not in ('PCO','COR') then raise exception 'PM_INVALID: tier PCO or COR' using errcode = '22023'; end if;
  if exists (select 1 from pm.cm_change_events x where x.id = any (p_change_events)
               and (x.org_id <> j.org_id or x.job_id <> p_job or x.status not in ('OPEN','PRICING','PRICED','REJECTED'))) then
    raise exception 'PM_PCO_EVENTS: every change event must be open on this job (not already submitted, approved or closed)' using errcode = '22023';
  end if;
  select string_agg(x.title, '; ' order by x.number), max(x.schedule_days) into v_title, v_days
    from pm.cm_change_events x where x.id = any (p_change_events);
  insert into pm.cm_pcos (id, org_id, job_id, contract_id, tier, title, narrative, status, schedule_days, created_by)
  values (v_id, j.org_id, p_job, pm.primary_contract_id(j.org_id, p_job), v_tier, left(coalesce(p_title, v_title, 'Change'), 200),
          (select string_agg(coalesce(x.number || ': ' || x.description, x.number || ': ' || x.title), E'\n' order by x.number)
             from pm.cm_change_events x where x.id = any (p_change_events)),
          'DRAFT', v_days, pm.current_user_id());
  for e in select * from pm.cm_change_events x where x.id = any (p_change_events) order by x.number loop
    -- sub prices first: one line per accepted RFQ (else per sub line at ROM)
    for q in select r.* from pm.cm_rfqs r where r.org_id = j.org_id and r.change_event_id = e.id and r.status = 'ACCEPTED' order by r.number loop
      insert into pm.cm_pco_lines (org_id, job_id, pco_id, change_event_id, rfq_id, commitment_id, vendor_id, cost_code_id, cost_type, source, description, cost_cents, sort)
      values (j.org_id, p_job, v_id, e.id, q.id, q.commitment_id, q.vendor_id,
              (select cl.cost_code_id from pm.cm_change_event_lines cl where cl.change_event_id = e.id and cl.vendor_id = q.vendor_id order by cl.line_no limit 1),
              'SUBCONTRACTOR', 'SUB', format('%s — %s', e.number, q.number), q.total_cents, v_sort);
      v_sort := v_sort + 1;
    end loop;
    for l in select cl.* from pm.cm_change_event_lines cl where cl.org_id = j.org_id and cl.change_event_id = e.id order by cl.line_no, cl.id loop
      continue when l.vendor_id is not null and exists (select 1 from pm.cm_rfqs r where r.change_event_id = e.id and r.vendor_id = l.vendor_id and r.status = 'ACCEPTED');
      insert into pm.cm_pco_lines (org_id, job_id, pco_id, change_event_id, change_event_line_id, commitment_id, vendor_id, cost_code_id, cost_type, source, description, cost_cents, sort)
      values (j.org_id, p_job, v_id, e.id, l.id, l.commitment_id, l.vendor_id, l.cost_code_id, l.cost_type,
              case when l.vendor_id is not null or l.commitment_id is not null or l.cost_type = 'SUBCONTRACTOR' then 'SUB' else 'SELF' end,
              coalesce(nullif(l.description, ''), e.title), coalesce(l.rom_cost_cents, 0), v_sort);
      v_sort := v_sort + 1;
    end loop;
    if not exists (select 1 from pm.cm_pco_lines x where x.pco_id = v_id and x.change_event_id = e.id) then
      insert into pm.cm_pco_lines (org_id, job_id, pco_id, change_event_id, source, description, cost_cents, sort)
      values (j.org_id, p_job, v_id, e.id, 'SELF', e.title, coalesce(e.rom_cost_cents, 0), v_sort);
      v_sort := v_sort + 1;
    end if;
  end loop;
  perform pm._cm_pco_retotal(v_id);
  update pm.cm_change_events set status = 'PRICED', pco_id = v_id where id = any (p_change_events);
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'pco.drafted', 'cm_pcos', v_id,
    format('Priced %s change event(s) into a %s', cardinality(p_change_events), v_tier), jsonb_build_object('change_events', to_jsonb(p_change_events)));
  return v_id;
end $$;

create or replace function pm.cm_reprice_pco(p_pco uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_pcos%rowtype;
begin
  select * into p from pm.cm_pcos where id = p_pco for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: PCO % not found in the caller''s organization', p_pco using errcode = '42501';
  end if;
  if p.status not in ('DRAFT','REVISE') then raise exception 'PM_PCO_LOCKED: % is %', p.number, p.status using errcode = '22023'; end if;
  perform pm._cm_pco_retotal(p.id);
  return p.id;
end $$;

-- Three-tier: roll PCOs (internal pricing) into one COR for the owner.
create or replace function pm.cm_roll_to_cor(p_pcos uuid[], p_title text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_org uuid; v_n int; v_id uuid := gen_random_uuid(); v_loc uuid;
begin
  select min(p.job_id::text)::uuid, min(p.org_id::text)::uuid, count(distinct p.job_id) into v_job, v_org, v_n
    from pm.cm_pcos p where p.id = any (p_pcos);
  if v_org is null or v_org is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: PCOs not found in the caller''s organization' using errcode = '42501'; end if;
  if v_n <> 1 then raise exception 'PM_COR_JOBS: PCOs must be on one job' using errcode = '22023'; end if;
  if exists (select 1 from pm.cm_pcos p where p.id = any (p_pcos) and (p.tier <> 'PCO' or p.status not in ('DRAFT','REVISE'))) then
    raise exception 'PM_COR_PCOS: only DRAFT / REVISE PCOs roll into a COR' using errcode = '22023';
  end if;
  insert into pm.cm_pcos (id, org_id, job_id, contract_id, tier, title, narrative, status, schedule_days, created_by)
  select v_id, v_org, v_job, pm.primary_contract_id(v_org, v_job), 'COR',
         left(coalesce(p_title, string_agg(p.title, '; ' order by p.number)), 200),
         string_agg(p.number || ': ' || coalesce(p.narrative, p.title), E'\n' order by p.number), 'DRAFT', max(p.schedule_days), pm.current_user_id()
    from pm.cm_pcos p where p.id = any (p_pcos);
  insert into pm.cm_pco_lines (org_id, job_id, pco_id, change_event_id, change_event_line_id, rfq_id, commitment_id, vendor_id, cost_code_id, cost_type, source, description, cost_cents, sort)
  select l.org_id, l.job_id, v_id, l.change_event_id, l.change_event_line_id, l.rfq_id, l.commitment_id, l.vendor_id, l.cost_code_id, l.cost_type, l.source,
         p.number || ' · ' || l.description, l.cost_cents, row_number() over (order by p.number, l.sort)
    from pm.cm_pco_lines l join pm.cm_pcos p on p.id = l.pco_id where l.pco_id = any (p_pcos);
  perform pm._cm_pco_retotal(v_id);
  update pm.cm_pcos set status = 'ROLLED_UP', parent_cor_id = v_id where id = any (p_pcos);
  update pm.cm_change_events set pco_id = v_id where org_id = v_org and pco_id = any (p_pcos);
  select j.location_id into v_loc from core.jobs j where j.id = v_job;
  perform pm.log_activity(v_org, v_loc, v_job, 'cor.drafted', 'cm_pcos', v_id, format('Rolled %s PCO(s) into a COR', cardinality(p_pcos)), '{}'::jsonb);
  return v_id;
end $$;

-- Submit to the owner: becomes the prime change order (pm.change_orders, stage COR) that the
-- owner approves (approvals engine / e-sign / owner portal). Three-tier contracts submit CORs only.
create or replace function pm.cm_submit_pco(p_pco uuid, p_due date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_pcos%rowtype; v_tiers int; v_co uuid; v_loc uuid; v_reason text;
begin
  select * into p from pm.cm_pcos where id = p_pco for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: PCO % not found in the caller''s organization', p_pco using errcode = '42501';
  end if;
  if p.status not in ('DRAFT','REVISE') then raise exception 'PM_PCO_NOT_DRAFT: % is %', p.number, p.status using errcode = '22023'; end if;
  select coalesce(s.change_tiers, 2) into v_tiers from pm.cm_contract_settings s where s.org_id = p.org_id and s.job_id = p.job_id;
  if coalesce(v_tiers, 2) = 3 and p.tier <> 'COR' then
    raise exception 'PM_PCO_TIER: this contract runs three tiers — roll PCOs into a COR first' using errcode = '22023';
  end if;
  perform pm._cm_pco_retotal(p.id);
  select * into p from pm.cm_pcos where id = p.id;
  if p.amount_cents = 0 then raise exception 'PM_PCO_EMPTY: % has no price', p.number using errcode = '22023'; end if;
  select string_agg(distinct e.reason_code, ', ') into v_reason from pm.cm_change_events e where e.pco_id = p.id;
  if p.change_order_id is not null then
    select c.id into v_co from pm.change_orders c where c.id = p.change_order_id and c.stage in ('PCO','COR','REJECTED');
  end if;
  if v_co is null then
    insert into pm.change_orders (org_id, job_id, contract_id, title, description, reason, stage, amount_cents, cost_impact_cents, schedule_days, ext, created_by)
    values (p.org_id, p.job_id, p.contract_id, p.title, p.narrative, coalesce(v_reason, 'OWNER_CHANGE'), 'COR', p.amount_cents, p.cost_cents, p.schedule_days,
            jsonb_build_object('_cm_pco_id', p.id::text, '_cm_pco_number', p.number), coalesce(p.created_by, pm.current_user_id()))
    returning id into v_co;
  else
    update pm.change_orders set stage = 'COR', amount_cents = p.amount_cents, cost_impact_cents = p.cost_cents, schedule_days = p.schedule_days,
           title = p.title, description = p.narrative where id = v_co;
  end if;
  update pm.cm_pcos set status = 'SUBMITTED', submitted_at = now(), due_on = coalesce(p_due, current_date + 14), change_order_id = v_co where id = p.id;
  update pm.cm_change_events set status = 'SUBMITTED', change_order_id = v_co where org_id = p.org_id and pco_id = p.id;
  select j.location_id into v_loc from core.jobs j where j.id = p.job_id;
  perform pm.log_activity(p.org_id, v_loc, p.job_id, 'pco.submitted', 'cm_pcos', p.id,
    format('%s submitted to the owner (%s cents)', p.number, p.amount_cents), jsonb_build_object('change_order_id', v_co, 'amount_cents', p.amount_cents));
  return v_co;
end $$;

-- Owner asked for changes: back to REVISE (the prime CO waits as COR).
create or replace function pm.cm_revise_pco(p_pco uuid, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_pcos%rowtype;
begin
  select * into p from pm.cm_pcos where id = p_pco for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: PCO % not found in the caller''s organization', p_pco using errcode = '42501';
  end if;
  if p.status <> 'SUBMITTED' then raise exception 'PM_PCO_NOT_SUBMITTED: % is %', p.number, p.status using errcode = '22023'; end if;
  update pm.cm_pcos set status = 'REVISE', decision_note = p_note where id = p.id;
  update pm.cm_change_events set status = 'PRICED' where org_id = p.org_id and pco_id = p.id and status = 'SUBMITTED';
  return p.id;
end $$;

-- The owner's decision lands on pm.change_orders (engine / e-sign / portal); carry it back.
create or replace function pm.tg_cm_change_order_sync() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.stage is not distinct from old.stage then return null; end if;
  if new.stage = 'APPROVED' then
    update pm.cm_pcos set status = 'APPROVED', decided_at = now() where org_id = new.org_id and change_order_id = new.id and status in ('SUBMITTED','REVISE');
    update pm.cm_change_events set status = 'APPROVED', proceeding = false where org_id = new.org_id and change_order_id = new.id and status in ('SUBMITTED','PRICED');
  elsif new.stage = 'REJECTED' then
    update pm.cm_pcos set status = 'REJECTED', decided_at = now() where org_id = new.org_id and change_order_id = new.id and status in ('SUBMITTED','REVISE');
    update pm.cm_change_events set status = 'REJECTED' where org_id = new.org_id and change_order_id = new.id and status in ('SUBMITTED','PRICED');
  elsif new.stage = 'VOID' then
    update pm.cm_pcos set status = 'VOID', decided_at = now() where org_id = new.org_id and change_order_id = new.id and status not in ('VOID');
    update pm.cm_change_events set status = 'PRICED', change_order_id = null where org_id = new.org_id and change_order_id = new.id and status in ('SUBMITTED','APPROVED');
  end if;
  return null;
end $$;
drop trigger if exists trg_cm_change_order_sync on pm.change_orders;
create trigger trg_cm_change_order_sync after update of stage on pm.change_orders
  for each row execute function pm.tg_cm_change_order_sync();

-- Approved prime CO → draft commitment COs for the subs that price it (CGC-35). Idempotent: a sub
-- line already proposed (commitment_changes with this owner_co_id + cost code) is skipped.
create or replace function pm.cm_propose_ccos(p_change_order uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; l record; n int := 0; v_line uuid; v_cc uuid;
begin
  select * into co from pm.change_orders where id = p_change_order;
  if co.org_id is null or co.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: change order % not found in the caller''s organization', p_change_order using errcode = '42501';
  end if;
  if co.stage <> 'APPROVED' then raise exception 'PM_CO_NOT_APPROVED: % is %', co.number, co.stage using errcode = '22023'; end if;
  for l in
    select pl.commitment_id, pl.cost_code_id, sum(pl.cost_cents)::bigint as cost, string_agg(pl.description, '; ') as descr
      from pm.cm_pco_lines pl join pm.cm_pcos p on p.id = pl.pco_id
     where p.org_id = co.org_id and p.change_order_id = co.id and p.status = 'APPROVED' and pl.source = 'SUB' and pl.commitment_id is not null
     group by pl.commitment_id, pl.cost_code_id
  loop
    continue when l.cost = 0;
    continue when exists (select 1 from pm.commitment_changes x where x.org_id = co.org_id and x.owner_co_id = co.id
                            and x.commitment_id = l.commitment_id and x.status <> 'VOID' and x.status <> 'REJECTED'
                            and coalesce(x.cost_code_id, (select cl.cost_code_id from pm.commitment_lines cl where cl.id = x.commitment_line_id)) is not distinct from l.cost_code_id);
    continue when not exists (select 1 from pm.commitments c where c.id = l.commitment_id and c.status in ('APPROVED','EXECUTED'));
    select cl.id into v_line from pm.commitment_lines cl where cl.org_id = co.org_id and cl.commitment_id = l.commitment_id
       and cl.cost_code_id is not distinct from l.cost_code_id order by cl.line_no limit 1;
    v_cc := l.cost_code_id;
    if v_line is null and v_cc is null then
      select cl.cost_code_id into v_cc from pm.commitment_lines cl where cl.org_id = co.org_id and cl.commitment_id = l.commitment_id order by cl.line_no limit 1;
    end if;
    if v_line is null and l.cost < 0 then
      select cl.id into v_line from pm.commitment_lines cl where cl.org_id = co.org_id and cl.commitment_id = l.commitment_id order by cl.amount_cents desc limit 1;
    end if;
    insert into pm.commitment_changes (org_id, job_id, commitment_id, commitment_line_id, cost_code_id, description, reason, amount_cents, owner_co_id, created_by)
    values (co.org_id, co.job_id, l.commitment_id, v_line, case when v_line is null then v_cc end,
            left(format('%s: %s', co.number, l.descr), 500), 'Owner change order ' || co.number, l.cost, co.id, pm.current_user_id());
    n := n + 1;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Owner pay apps: pencil → sent → certified → final, revisions, CO → SOV, step-downs
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_pay_app_status (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                  uuid not null,
  billing_request_id      uuid not null,
  application_no          int not null,
  revision                int not null default 1 check (revision >= 1),
  stage                   text not null default 'PENCIL' check (stage in ('PENCIL','PENCIL_SENT','REVISE','CERTIFIED','FINAL','VOID')),
  pencil_sent_at          timestamptz,
  pencil_sent_to          text,
  returned_note           text,
  architect_name          text,
  certified_at            timestamptz,
  certified_amount_cents  bigint,
  contractor_signed_at    timestamptz,
  notarized_at            timestamptz,
  owner_approved_at       timestamptz,
  esign_envelope_id       uuid,
  portal                  text check (portal is null or portal in ('TEXTURA','GCPAY','PROCORE_PAY','OWNER_PORTAL','EMAIL','OTHER')),
  portal_status           text check (portal_status is null or portal_status in ('NOT_SUBMITTED','SUBMITTED','ACCEPTED','REJECTED','PAID')),
  portal_submitted_at     timestamptz,
  superseded_by           uuid,
  created_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, billing_request_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_cm_pay_app_status_job_idx on pm.cm_pay_app_status (org_id, job_id, application_no);

create table if not exists pm.cm_pay_app_revisions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  application_no      int not null,
  revision            int not null,
  billing_request_id  uuid not null,
  reason              text,
  lines               jsonb not null default '[]',
  totals              jsonb not null default '{}',
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, job_id, application_no, revision),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Approved COs onto the ACTIVE SOV (CGC-41 "approved COs auto-added"). A positive CO adds a line;
-- a deductive CO reduces the line with the most unbilled balance that can absorb it (else it is left
-- for the auditor). Runs only when no DRAFT SOV version or DRAFT SOV pay app exists.
create or replace function pm._cm_sync_cos_to_sov(p_org uuid, p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_active pm.sov_versions%rowtype; v_draft uuid; co record; n int := 0; v_old_total bigint; v_added bigint := 0;
  v_contract bigint; v_line uuid; v_lineage uuid; v_no int; v_sort int; v_links jsonb := '[]'::jsonb; x jsonb;
begin
  select * into v_active from pm.sov_versions where org_id = p_org and job_id = p_job and status = 'ACTIVE';
  if not found then return 0; end if;
  if not exists (select 1 from pm.change_orders c where c.org_id = p_org and c.job_id = p_job and c.stage = 'APPROVED' and c.amount_cents <> 0
                   and not exists (select 1 from pm.cm_sov_co_links k where k.org_id = c.org_id and k.change_order_id = c.id)
                   and not exists (select 1 from pm.sov_lines s where s.org_id = c.org_id and s.sov_version_id = v_active.id and s.change_order_id = c.id)) then
    return 0;
  end if;
  if exists (select 1 from pm.sov_versions v where v.org_id = p_org and v.job_id = p_job and v.status = 'DRAFT')
     or exists (select 1 from pm.billing_requests r where r.org_id = p_org and r.job_id = p_job and r.billing_subtype = 'SOV' and r.status = 'DRAFT') then
    return 0;
  end if;
  select coalesce(sum(s.scheduled_value_cents), 0) into v_old_total from pm.sov_lines s where s.org_id = p_org and s.sov_version_id = v_active.id;
  v_draft := pm.revise_sov(v_active.id);
  for co in
    select c.* from pm.change_orders c
     where c.org_id = p_org and c.job_id = p_job and c.stage = 'APPROVED' and c.amount_cents <> 0
       and not exists (select 1 from pm.cm_sov_co_links k where k.org_id = c.org_id and k.change_order_id = c.id)
       and not exists (select 1 from pm.sov_lines s where s.org_id = c.org_id and s.sov_version_id = v_active.id and s.change_order_id = c.id)
     order by c.approved_at, c.number
  loop
    if co.amount_cents > 0 then
      select coalesce(max(s.line_no), 0) + 1, coalesce(max(s.sort), 0) + 1 into v_no, v_sort from pm.sov_lines s where s.org_id = p_org and s.sov_version_id = v_draft;
      insert into pm.sov_lines (org_id, sov_version_id, line_no, description, scheduled_value_cents, change_order_id, sort)
      values (p_org, v_draft, v_no, left(format('CO %s — %s', co.number, co.title), 500), co.amount_cents, co.id, v_sort)
      returning id, lineage_id into v_line, v_lineage;
      v_links := v_links || jsonb_build_object('co', co.id, 'lineage', v_lineage, 'amount', co.amount_cents, 'mode', 'NEW_LINE');
    else
      select s.id, s.lineage_id into v_line, v_lineage
        from pm.sov_lines s
        left join lateral (
          select coalesce(sum(bl.this_period_work_cents), 0)
                 + coalesce((array_agg(bl.stored_materials_cents order by r.application_no desc nulls last))[1], 0) as billed
            from pm.billing_request_lines bl join pm.billing_requests r on r.org_id = bl.org_id and r.id = bl.billing_request_id
           where bl.org_id = s.org_id and bl.sov_lineage_id = s.lineage_id and bl.line_type = 'STANDARD'
             and r.status in ('EMITTED','ISSUED','UNISSUED','REJECTED')) b on true
       where s.org_id = p_org and s.sov_version_id = v_draft
         and s.scheduled_value_cents - coalesce(b.billed, 0) >= -co.amount_cents
       order by (s.change_order_id is null) desc, s.scheduled_value_cents - coalesce(b.billed, 0) desc, s.line_no
       limit 1;
      continue when v_line is null;
      update pm.sov_lines set scheduled_value_cents = scheduled_value_cents + co.amount_cents where id = v_line;
      v_links := v_links || jsonb_build_object('co', co.id, 'lineage', v_lineage, 'amount', co.amount_cents, 'mode', 'REDUCED_LINE');
    end if;
    v_added := v_added + co.amount_cents;
    n := n + 1;
    v_line := null;
  end loop;
  if n = 0 then
    delete from pm.sov_versions where id = v_draft and status = 'DRAFT';
    return 0;
  end if;
  select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = p_org and m.job_id = p_job;
  -- keep a pre-existing (forced) mismatch rather than refuse; a matching SOV stays matching
  perform pm.activate_sov_version(v_draft, (v_old_total + v_added) is distinct from coalesce(v_contract, 0));
  for x in select value from jsonb_array_elements(v_links) loop
    insert into pm.cm_sov_co_links (org_id, change_order_id, job_id, sov_version_id, sov_lineage_id, amount_cents, mode)
    values (p_org, (x ->> 'co')::uuid, p_job, v_draft, (x ->> 'lineage')::uuid, (x ->> 'amount')::bigint, x ->> 'mode')
    on conflict (org_id, change_order_id) do nothing;
  end loop;
  perform pm.log_activity(p_org, (select location_id from core.jobs where id = p_job), p_job, 'sov.change_orders_added', 'sov_versions', v_draft,
    format('%s approved change order(s) added to the schedule of values', n), jsonb_build_object('added_cents', v_added));
  return n;
end $$;

-- Retainage step-downs and the stored-materials rate, applied to a freshly generated SOV request.
create or replace function pm._cm_apply_retainage_steps(p_request uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  r pm.billing_requests%rowtype; s pm.cm_contract_settings%rowtype; l record; v_completion numeric; v_sched bigint; v_prev_done bigint;
  v_rate numeric; v_srate numeric; v_prev bigint; res record; v_mode text;
begin
  select * into r from pm.billing_requests where id = p_request;
  select * into s from pm.cm_contract_settings where org_id = r.org_id and job_id = r.job_id;
  if not exists (select 1 from pm.cm_retainage_steps x where x.org_id = r.org_id and x.job_id = r.job_id and x.side = 'RECEIVABLE')
     and s.stored_retainage_pct is null then
    return;
  end if;
  v_mode := coalesce(s.retainage_step_mode, 'NEW_WORK_ONLY');
  select coalesce(sum(x.scheduled_value_cents), 0), coalesce(sum(coalesce(x.previous_work_cents, 0) + coalesce(x.previous_stored_cents, 0)), 0)
    into v_sched, v_prev_done
    from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD';
  v_completion := case when v_sched > 0 then v_prev_done::numeric / v_sched else 0 end;
  for l in select x.* from pm.billing_request_lines x where x.org_id = r.org_id and x.billing_request_id = r.id and x.line_type = 'STANDARD' loop
    v_rate := pm._cm_step_rate(r.org_id, r.job_id, 'RECEIVABLE', null, v_completion, coalesce(l.retainage_rate, 0));
    v_srate := coalesce(s.stored_retainage_pct, v_rate);
    v_prev := coalesce(l.retainage_work_to_date_cents, 0) + coalesce(l.retainage_stored_to_date_cents, 0) - coalesce(l.retainage_this_period_cents, 0);
    select * into res from pm._cm_ret_line(v_mode, v_rate, v_srate, l.previous_work_cents, l.this_period_work_cents,
                                           l.stored_materials_cents, l.previous_stored_cents, v_prev);
    update pm.billing_request_lines
       set retainage_rate = v_rate, retainage_work_to_date_cents = res.work_td, retainage_stored_to_date_cents = res.stored_td,
           retainage_this_period_cents = res.this_period
     where id = l.id;
  end loop;
  perform pm.finalize_billing_retainage(r.id);
end $$;

create or replace function pm._cm_draft_pay_app(p_job uuid, p_period_end date, p_lines jsonb, p_sync boolean, p_revision int, p_sent_to text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_sov uuid; v_req uuid; v_app int;
begin
  select * into j from pm._cm_job(p_job);
  if coalesce(p_sync, true) then perform pm._cm_sync_cos_to_sov(j.org_id, p_job); end if;
  select v.id into v_sov from pm.sov_versions v where v.org_id = j.org_id and v.job_id = p_job and v.status = 'ACTIVE';
  if v_sov is null then raise exception 'PRECONDITION_SOV_NOT_ACTIVE: job % has no ACTIVE schedule of values', p_job using errcode = 'P0001'; end if;
  v_req := pm.generate_sov_billing(p_job, v_sov, p_period_end, coalesce(p_lines, '[]'::jsonb));
  perform pm._cm_apply_retainage_steps(v_req);
  select r.application_no into v_app from pm.billing_requests r where r.id = v_req;
  insert into pm.cm_pay_app_status (org_id, job_id, billing_request_id, application_no, revision, stage, pencil_sent_to, created_by)
  values (j.org_id, p_job, v_req, v_app, coalesce(p_revision, 1), 'PENCIL', p_sent_to, pm.current_user_id());
  return v_req;
end $$;

-- Member action: carry approved change orders onto the ACTIVE schedule of values now.
create or replace function pm.cm_sync_cos_to_sov(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._cm_job(p_job);
  return pm._cm_sync_cos_to_sov(j.org_id, p_job);
end $$;

create or replace function pm.cm_draft_pay_app(p_job uuid, p_period_end date, p_lines jsonb default '[]', p_sync_cos boolean default true)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  perform pm._cm_job(p_job);
  return pm._cm_draft_pay_app(p_job, p_period_end, p_lines, p_sync_cos, 1, null);
end $$;

-- Owner / architect returned the pencil, or the PM corrects it: same application number, revision+1.
create or replace function pm.cm_revise_pay_app(p_request uuid, p_lines jsonb default null, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype; s pm.cm_pay_app_status%rowtype; v_inputs jsonb; v_active uuid; v_new uuid; v_snap jsonb;
begin
  select * into r from pm.billing_requests where id = p_request for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_request using errcode = '42501';
  end if;
  if r.billing_subtype is distinct from 'SOV' or r.status not in ('DRAFT','REJECTED') then
    raise exception 'PM_PAYAPP_NOT_REVISABLE: only a pencil (DRAFT) or a Books-rejected pay application can be revised (is %)', r.status using errcode = '22023';
  end if;
  select * into s from pm.cm_pay_app_status where org_id = r.org_id and billing_request_id = r.id;
  select v.id into v_active from pm.sov_versions v where v.org_id = r.org_id and v.job_id = r.job_id and v.status = 'ACTIVE';
  select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'scheduled', l.scheduled_value_cents,
           'previous', l.previous_work_cents, 'this_period', l.this_period_work_cents, 'stored', l.stored_materials_cents,
           'retainage', l.retainage_this_period_cents, 'amount', l.amount_cents) order by l.sort, l.line_no)
    into v_snap from pm.billing_request_lines l where l.org_id = r.org_id and l.billing_request_id = r.id;
  insert into pm.cm_pay_app_revisions (org_id, job_id, application_no, revision, billing_request_id, reason, lines, totals, created_by)
  values (r.org_id, r.job_id, r.application_no, coalesce(s.revision, 1), r.id, p_reason, coalesce(v_snap, '[]'::jsonb),
          jsonb_build_object('gross_earned_cents', r.gross_earned_cents, 'retainage_cents', r.retainage_cents, 'net_cents', r.net_cents),
          pm.current_user_id())
  on conflict (org_id, job_id, application_no, revision) do nothing;
  v_inputs := coalesce(p_lines, (
    select jsonb_agg(jsonb_build_object('sov_line_id', cur.id,
             'work_to_date_cents', coalesce(bl.previous_work_cents, 0) + coalesce(bl.this_period_work_cents, 0),
             'stored_materials_cents', coalesce(bl.stored_materials_cents, 0)))
      from pm.billing_request_lines bl
      join pm.sov_lines cur on cur.org_id = bl.org_id and cur.sov_version_id = v_active and cur.lineage_id = bl.sov_lineage_id
     where bl.org_id = r.org_id and bl.billing_request_id = r.id and bl.line_type = 'STANDARD'));
  perform pm.void_billing_request(r.id, left('Revised: ' || coalesce(p_reason, 'pay application corrected'), 500));
  v_new := pm._cm_draft_pay_app(r.job_id, r.period_end, coalesce(v_inputs, '[]'::jsonb), false, coalesce(s.revision, 1) + 1, s.pencil_sent_to);
  update pm.cm_pay_app_status set stage = 'VOID', superseded_by = v_new where org_id = r.org_id and billing_request_id = r.id;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'payapp.revised', 'billing_requests', v_new,
    format('Pay application #%s revised (revision %s)', r.application_no, coalesce(s.revision, 1) + 1), jsonb_build_object('reason', p_reason, 'replaces', r.id));
  return v_new;
end $$;

create or replace function pm._cm_pay_app_row(p_request uuid) returns pm.cm_pay_app_status
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.billing_requests%rowtype; s pm.cm_pay_app_status%rowtype;
begin
  select * into r from pm.billing_requests where id = p_request;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_request using errcode = '42501';
  end if;
  if r.billing_subtype is distinct from 'SOV' then raise exception 'PM_NOT_A_PAY_APP: billing request is not an SOV pay application' using errcode = '22023'; end if;
  select * into s from pm.cm_pay_app_status where org_id = r.org_id and billing_request_id = r.id for update;
  if s.id is null then
    insert into pm.cm_pay_app_status (org_id, job_id, billing_request_id, application_no, stage, created_by)
    values (r.org_id, r.job_id, r.id, r.application_no, case when r.status in ('EMITTED','ISSUED','UNISSUED') then 'FINAL' else 'PENCIL' end, r.created_by)
    returning * into s;
  end if;
  return s;
end $$;

create or replace function pm.cm_send_pencil(p_request uuid, p_to text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_pay_app_status%rowtype;
begin
  s := pm._cm_pay_app_row(p_request);
  if s.stage not in ('PENCIL','REVISE','PENCIL_SENT') then raise exception 'PM_PAYAPP_STAGE: pay application is %', s.stage using errcode = '22023'; end if;
  update pm.cm_pay_app_status set stage = 'PENCIL_SENT', pencil_sent_at = now(), pencil_sent_to = coalesce(p_to, pencil_sent_to) where id = s.id;
  return s.id;
end $$;

create or replace function pm.cm_return_pencil(p_request uuid, p_note text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_pay_app_status%rowtype;
begin
  s := pm._cm_pay_app_row(p_request);
  if s.stage not in ('PENCIL_SENT','CERTIFIED') then raise exception 'PM_PAYAPP_STAGE: pay application is %', s.stage using errcode = '22023'; end if;
  update pm.cm_pay_app_status set stage = 'REVISE', returned_note = p_note where id = s.id;
  return s.id;
end $$;

-- Architect certification (CGC-44): the certified amount must equal the application's net due.
create or replace function pm.cm_certify_pay_app(p_request uuid, p_architect text, p_certified_cents bigint, p_notarized boolean default false)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_pay_app_status%rowtype; r pm.billing_requests%rowtype;
begin
  s := pm._cm_pay_app_row(p_request);
  select * into r from pm.billing_requests where id = p_request;
  if r.status not in ('DRAFT','REJECTED') then raise exception 'PM_PAYAPP_STAGE: the pay application is already %', r.status using errcode = '22023'; end if;
  if s.stage not in ('PENCIL','PENCIL_SENT') then raise exception 'PM_PAYAPP_STAGE: pay application is %', s.stage using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_architect, '')), '') is null then raise exception 'PM_INVALID: name the certifying architect / owner rep' using errcode = '22023'; end if;
  if p_certified_cents is distinct from r.net_cents then
    raise exception 'PM_PAYAPP_CERT_MISMATCH: certified % cents ≠ the application''s % cents due — revise the pay application to the certified figures first', p_certified_cents, r.net_cents
      using errcode = '22023';
  end if;
  update pm.cm_pay_app_status set stage = 'CERTIFIED', architect_name = p_architect, certified_at = now(), certified_amount_cents = p_certified_cents,
         notarized_at = case when coalesce(p_notarized, false) then now() else notarized_at end, contractor_signed_at = coalesce(contractor_signed_at, now())
   where id = s.id;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'payapp.certified', 'billing_requests', r.id,
    format('Pay application #%s certified by %s', r.application_no, p_architect), jsonb_build_object('certified_cents', p_certified_cents));
  return s.id;
end $$;

create or replace function pm.cm_pay_app_portal(p_request uuid, p_portal text, p_status text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_pay_app_status%rowtype;
begin
  s := pm._cm_pay_app_row(p_request);
  update pm.cm_pay_app_status set portal = p_portal, portal_status = p_status,
         portal_submitted_at = case when p_status = 'SUBMITTED' then now() else portal_submitted_at end
   where id = s.id;
  return s.id;
end $$;

-- Pencil → final: a pay application drafted here is finalized (sent to Books) only once certified
-- when the contract requires architect certification.
create or replace function pm.tg_cm_billing_finalize() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_pay_app_status%rowtype; v_cert boolean;
begin
  if new.billing_subtype is distinct from 'SOV' then return new; end if;
  if not (new.status in ('EMITTED','UNISSUED','ISSUED') and old.status in ('DRAFT','REJECTED')) then return new; end if;
  select * into s from pm.cm_pay_app_status where org_id = new.org_id and billing_request_id = new.id;
  if s.id is null or s.stage in ('CERTIFIED','FINAL') then return new; end if;
  select coalesce(x.architect_certification, true) into v_cert from pm.cm_contract_settings x where x.org_id = new.org_id and x.job_id = new.job_id;
  if coalesce(v_cert, true) then
    raise exception 'PM_PAYAPP_NOT_CERTIFIED: pay application #% is still a pencil (%); record the architect''s certification first', new.application_no, lower(s.stage)
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_cm_billing_finalize on pm.billing_requests;
create trigger trg_cm_billing_finalize before update of status on pm.billing_requests
  for each row execute function pm.tg_cm_billing_finalize();

create or replace function pm.tg_cm_billing_sync() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status in ('EMITTED','UNISSUED','ISSUED') and old.status in ('DRAFT','REJECTED') then
    update pm.cm_pay_app_status set stage = 'FINAL', owner_approved_at = coalesce(owner_approved_at, now())
     where org_id = new.org_id and billing_request_id = new.id and stage <> 'FINAL';
  elsif new.status = 'VOID' then
    update pm.cm_pay_app_status set stage = 'VOID' where org_id = new.org_id and billing_request_id = new.id and stage <> 'VOID';
    -- T&M tickets billed on a voided request are billable again
    update pm.cm_tm_tickets set status = 'SIGNED', billed_request_id = null where org_id = new.org_id and billed_request_id = new.id and status = 'BILLED';
    delete from pm.cm_tm_billing_links where org_id = new.org_id and billing_request_id = new.id;
  end if;
  return null;
end $$;

-- Over / under billing preview before sending (FIN-50), as the caller sees it.
create or replace function pm.cm_pay_app_preview(p_request uuid) returns jsonb
language plpgsql stable security invoker
set search_path = pm, core, public
as $$
declare r record; f record; v_after bigint; v_pending bigint; w jsonb := '[]'::jsonb; v_fail text[];
begin
  select b.id, b.job_id, b.status, b.gross_earned_cents, b.retainage_cents, b.net_cents, b.application_no
    into r from pm.billing_requests b where b.id = p_request;
  if r.id is null then return null; end if;
  select x.revised_contract_cents, x.billed_to_date_cents, x.earned_revenue_cents, x.over_under_billing_cents into f
    from pm.v_job_financials x where x.job_id = r.job_id;
  v_pending := case when r.status in ('DRAFT','REJECTED') then r.gross_earned_cents else 0 end;
  v_after := case when f.earned_revenue_cents is null then null else coalesce(f.billed_to_date_cents, 0) + v_pending - f.earned_revenue_cents end;
  if v_after is not null and f.revised_contract_cents > 0 and v_after > f.revised_contract_cents / 20 then
    w := w || jsonb_build_object('code', 'OVERBILLED_AFTER', 'text', 'This bill puts billing well ahead of earned revenue (more than 5% of the contract).');
  end if;
  if exists (select 1 from pm.v_change_orders_masked c where c.job_id = r.job_id and c.stage = 'APPROVED' and c.amount_cents <> 0
               and not exists (select 1 from pm.cm_sov_co_links k where k.change_order_id = c.id)
               and not exists (select 1 from pm.sov_lines s join pm.sov_versions v on v.id = s.sov_version_id and v.status = 'ACTIVE' where s.change_order_id = c.id)) then
    w := w || jsonb_build_object('code', 'APPROVED_CO_NOT_ON_SOV', 'text', 'An approved change order is not on the schedule of values yet.');
  end if;
  v_fail := case when r.status in ('DRAFT','REJECTED') then pm.billing_preconditions(r.id) else '{}'::text[] end;
  return jsonb_build_object('billing_request_id', r.id, 'application_no', r.application_no,
    'gross_earned_cents', r.gross_earned_cents, 'retainage_cents', r.retainage_cents, 'net_cents', r.net_cents,
    'billed_to_date_cents', f.billed_to_date_cents, 'earned_revenue_cents', f.earned_revenue_cents,
    'over_under_before_cents', f.over_under_billing_cents, 'over_under_after_cents', v_after,
    'preconditions', to_jsonb(coalesce(v_fail, '{}'::text[])), 'warnings', w);
end $$;

-- ----------------------------------------------------------------------------
-- 4. Sub pay apps (commitment SOV) + approval chain + retainage payable + payable outbox
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_sub_pay_apps (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                      uuid not null,
  location_id                 uuid not null references core.locations(id),
  commitment_id               uuid not null,
  vendor_id                   uuid references core.vendors(id),
  application_no              int not null check (application_no >= 1),
  period_end                  date not null,
  status                      text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','IN_REVIEW','REVISE','APPROVED','REJECTED','VOID')),
  submitted_via               text not null default 'INTERNAL' check (submitted_via in ('PORTAL','INTERNAL')),
  submitted_by                text,
  submitted_at                timestamptz,
  scheduled_value_cents       bigint not null default 0,
  gross_this_period_cents     bigint not null default 0,
  work_to_date_cents          bigint not null default 0,
  stored_to_date_cents        bigint not null default 0,
  retainage_this_period_cents bigint not null default 0,
  retainage_to_date_cents     bigint not null default 0,
  net_due_cents               bigint not null default 0,
  current_step                int not null default 0,
  chain                       jsonb not null default '[]' check (jsonb_typeof(chain) = 'array'),
  approved_by                 text,
  approved_at                 timestamptz,
  rejected_reason             text,
  outbox_id                   uuid,
  -- everyone who created, revised or submitted it (security review 2026-10): none of them may approve
  preparers                   text[] not null default '{}',
  created_by                  text default pm.current_user_id(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
alter table pm.cm_sub_pay_apps add column if not exists preparers text[] not null default '{}';
create unique index if not exists pm_cm_sub_pay_apps_no_uidx on pm.cm_sub_pay_apps (org_id, commitment_id, application_no) where status <> 'VOID';
create index if not exists pm_cm_sub_pay_apps_job_idx on pm.cm_sub_pay_apps (org_id, job_id, status);

create table if not exists pm.cm_sub_pay_app_lines (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                      uuid,
  sub_pay_app_id              uuid not null,
  commitment_line_id          uuid not null,
  line_no                     int not null default 0,
  cost_code_id                uuid,
  description                 text not null default '',
  scheduled_value_cents       bigint not null default 0,
  previous_work_cents         bigint not null default 0,
  this_period_work_cents      bigint not null default 0,
  previous_stored_cents       bigint not null default 0,
  stored_materials_cents      bigint not null default 0,
  total_completed_cents       bigint not null default 0,
  pct_complete                numeric(9,6),
  balance_to_finish_cents     bigint not null default 0,
  retainage_rate              numeric(5,4),
  retainage_this_period_cents bigint not null default 0,
  retainage_to_date_cents     bigint not null default 0,
  stored_backup_document_id   uuid,
  unique (org_id, id),
  unique (org_id, sub_pay_app_id, commitment_line_id),
  foreign key (org_id, sub_pay_app_id) references pm.cm_sub_pay_apps (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_sub_pay_app_actions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  sub_pay_app_id  uuid not null,
  step            int not null default 0,
  action          text not null check (action in ('SUBMIT','APPROVE','REJECT','REVISE','VOID')),
  actor           text,
  note            text,
  created_at      timestamptz not null default now(),
  foreign key (org_id, sub_pay_app_id) references pm.cm_sub_pay_apps (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_cm_sub_actions_app_idx on pm.cm_sub_pay_app_actions (org_id, sub_pay_app_id, created_at);

-- The superintendent's opinion of a sub's progress (no money): read next to the sub's claim.
create table if not exists pm.cm_sub_progress_opinions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  vendor_id      uuid not null references core.vendors(id),
  period_end     date not null,
  pct_complete   numeric(5,4) not null check (pct_complete >= 0 and pct_complete <= 1),
  note           text,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, job_id, vendor_id, period_end),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_payable_retainage (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  commitment_id   uuid not null,
  sub_pay_app_id  uuid,
  entry_type      text not null check (entry_type in ('HELD','RELEASED')),
  amount_cents    bigint not null check (entry_type = 'HELD' or amount_cents > 0),
  memo            text,
  outbox_id       uuid,
  created_at      timestamptz not null default now(),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_payable_ret_cmt_idx on pm.cm_payable_retainage (org_id, commitment_id);

-- JOB_PAYABLE_REQUEST is a RESERVED seam event: approvals queue here for Books (no core.events row).
create table if not exists pm.cm_payable_outbox (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  location_id      uuid not null references core.locations(id),
  commitment_id    uuid not null,
  sub_pay_app_id   uuid,
  kind             text not null check (kind in ('PAYABLE_REQUEST','RETAINAGE_RELEASE')),
  source_ref       text not null,
  payload          jsonb not null,
  status           text not null default 'PENDING' check (status in ('PENDING','PROCESSED','REJECTED','VOID')),
  books_bill_id    uuid,
  error            text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz,
  unique (org_id, source_ref),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.tg_cm_sub_pay_app_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if pm.access_member_role() then
    raise exception 'PM_SUB_PAY_APP_RPC: sub pay applications change only through their actions' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

-- Fill / refill a sub pay app's lines from the commitment SOV. p_lines:
-- [{commitment_line_id, pct_complete? | work_to_date_cents? | this_period_cents?, stored_materials_cents?, stored_backup_document_id?}]
create or replace function pm._cm_fill_sub_pay_app(p_app uuid, p_lines jsonb) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  a pm.cm_sub_pay_apps%rowtype; c pm.commitments%rowtype; s pm.cm_contract_settings%rowtype; l record; inp jsonb;
  d_ bigint; e_ bigint; f_ bigint; fp bigint; prev bigint; g_ bigint; c_ bigint; v_rate numeric; v_srate numeric; res record;
  v_sched bigint; v_done bigint; v_completion numeric; v_bad text;
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app;
  select * into c from pm.commitments where id = a.commitment_id;
  select * into s from pm.cm_contract_settings where org_id = a.org_id and job_id = a.job_id;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: lines must be an array' using errcode = '22023'; end if;
  select string_agg(coalesce(x ->> 'commitment_line_id', '(missing)'), ', ') into v_bad
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where not exists (select 1 from pm.commitment_lines cl where cl.org_id = a.org_id and cl.commitment_id = c.id and cl.id::text = x ->> 'commitment_line_id');
  if v_bad is not null then raise exception 'PM_SUB_PAY_APP_LINE: % is not a line of %', v_bad, c.number using errcode = '22023'; end if;
  delete from pm.cm_sub_pay_app_lines where org_id = a.org_id and sub_pay_app_id = a.id;
  -- completion before this application (step-downs read it)
  select coalesce(sum(cl.amount_cents), 0) into v_sched from pm.commitment_lines cl where cl.org_id = a.org_id and cl.commitment_id = c.id;
  select coalesce(sum(x.this_period_work_cents), 0) into v_done
    from pm.cm_sub_pay_app_lines x join pm.cm_sub_pay_apps p on p.id = x.sub_pay_app_id
   where p.org_id = a.org_id and p.commitment_id = c.id and p.status = 'APPROVED' and p.id <> a.id;
  v_completion := case when v_sched > 0 then v_done::numeric / v_sched else 0 end;
  for l in select cl.* from pm.commitment_lines cl where cl.org_id = a.org_id and cl.commitment_id = c.id order by cl.line_no, cl.id loop
    inp := null;
    select x into inp from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x where x ->> 'commitment_line_id' = l.id::text;
    c_ := l.amount_cents;
    select coalesce(sum(x.this_period_work_cents), 0), coalesce(sum(x.retainage_this_period_cents), 0) into d_, prev
      from pm.cm_sub_pay_app_lines x join pm.cm_sub_pay_apps p on p.id = x.sub_pay_app_id
     where p.org_id = a.org_id and x.commitment_line_id = l.id and p.status = 'APPROVED' and p.id <> a.id;
    select coalesce((select x.stored_materials_cents from pm.cm_sub_pay_app_lines x join pm.cm_sub_pay_apps p on p.id = x.sub_pay_app_id
                      where p.org_id = a.org_id and x.commitment_line_id = l.id and p.status = 'APPROVED' and p.id <> a.id
                      order by p.application_no desc limit 1), 0) into fp;
    if inp is null then e_ := 0;
    elsif inp ? 'pct_complete' then
      if (inp ->> 'pct_complete')::numeric < 0 or (inp ->> 'pct_complete')::numeric > 1 then
        raise exception 'PM_SUB_PAY_APP_PCT: line % pct_complete must be 0..1', l.line_no using errcode = '22023';
      end if;
      e_ := round(c_ * (inp ->> 'pct_complete')::numeric)::bigint - d_;
    elsif inp ? 'work_to_date_cents' then e_ := (inp ->> 'work_to_date_cents')::bigint - d_;
    else e_ := coalesce((inp ->> 'this_period_cents')::bigint, 0);
    end if;
    f_ := coalesce((inp ->> 'stored_materials_cents')::bigint, fp);
    if d_ + e_ < 0 or f_ < 0 then raise exception 'PM_SUB_PAY_APP_NEGATIVE: line % would go below zero', l.line_no using errcode = '22023'; end if;
    g_ := d_ + e_ + f_;
    if g_ > c_ then
      raise exception 'PM_SUB_PAY_APP_OVER_SCHEDULED: line % completed + stored % exceeds the commitment line %', l.line_no, g_, c_ using errcode = '22023';
    end if;
    v_rate := pm._cm_step_rate(a.org_id, a.job_id, 'PAYABLE', c.id, v_completion, c.retainage_pct);
    v_srate := coalesce(s.stored_retainage_pct, v_rate);
    select * into res from pm._cm_ret_line(coalesce(s.retainage_step_mode, 'NEW_WORK_ONLY'), v_rate, v_srate, d_, e_, f_, fp, prev);
    insert into pm.cm_sub_pay_app_lines (org_id, job_id, sub_pay_app_id, commitment_line_id, line_no, cost_code_id, description,
      scheduled_value_cents, previous_work_cents, this_period_work_cents, previous_stored_cents, stored_materials_cents,
      total_completed_cents, pct_complete, balance_to_finish_cents, retainage_rate, retainage_this_period_cents, retainage_to_date_cents,
      stored_backup_document_id)
    values (a.org_id, a.job_id, a.id, l.id, l.line_no, l.cost_code_id, l.description, c_, d_, e_, fp, f_, g_,
            case when c_ > 0 then round(g_::numeric / c_, 6) end, c_ - g_, v_rate, res.this_period, prev + res.this_period,
            pm.access_try_uuid(inp ->> 'stored_backup_document_id'));
  end loop;
  update pm.cm_sub_pay_apps p
     set scheduled_value_cents = t.sched, gross_this_period_cents = t.gross, work_to_date_cents = t.work, stored_to_date_cents = t.stored,
         retainage_this_period_cents = t.ret, retainage_to_date_cents = t.ret_td, net_due_cents = t.gross - t.ret
    from (select coalesce(sum(x.scheduled_value_cents), 0)::bigint as sched,
                 coalesce(sum(x.this_period_work_cents + x.stored_materials_cents - x.previous_stored_cents), 0)::bigint as gross,
                 coalesce(sum(x.previous_work_cents + x.this_period_work_cents), 0)::bigint as work,
                 coalesce(sum(x.stored_materials_cents), 0)::bigint as stored,
                 coalesce(sum(x.retainage_this_period_cents), 0)::bigint as ret,
                 coalesce(sum(x.retainage_to_date_cents), 0)::bigint as ret_td
            from pm.cm_sub_pay_app_lines x where x.org_id = a.org_id and x.sub_pay_app_id = a.id) t
   where p.id = a.id;
end $$;

create or replace function pm._cm_create_sub_pay_app(p_commitment uuid, p_period_end date, p_lines jsonb, p_via text, p_actor text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_id uuid := gen_random_uuid(); v_no int; v_gross bigint;
begin
  select * into c from pm.commitments where id = p_commitment for update;
  if c.status not in ('APPROVED','EXECUTED') then raise exception 'PM_SUB_PAY_APP_COMMITMENT: % is %', c.number, c.status using errcode = '22023'; end if;
  if p_period_end is null then raise exception 'PM_INVALID: period_end is required' using errcode = '22023'; end if;
  if exists (select 1 from pm.cm_sub_pay_apps a where a.org_id = c.org_id and a.commitment_id = c.id and a.status in ('DRAFT','SUBMITTED','IN_REVIEW','REVISE')) then
    raise exception 'PM_SUB_PAY_APP_OPEN: % already has a pay application in progress', c.number using errcode = '22023';
  end if;
  select coalesce(max(a.application_no), 0) + 1 into v_no from pm.cm_sub_pay_apps a where a.org_id = c.org_id and a.commitment_id = c.id and a.status <> 'VOID';
  insert into pm.cm_sub_pay_apps (id, org_id, job_id, location_id, commitment_id, vendor_id, application_no, period_end, status, submitted_via, created_by, preparers)
  values (v_id, c.org_id, c.job_id, c.location_id, c.id, c.vendor_id, v_no, p_period_end, 'DRAFT', coalesce(p_via, 'INTERNAL'), p_actor,
          pm._cm_with('{}'::text[], p_actor));
  perform pm._cm_fill_sub_pay_app(v_id, p_lines);
  select a.gross_this_period_cents into v_gross from pm.cm_sub_pay_apps a where a.id = v_id;
  if coalesce(v_gross, 0) = 0 and not exists (select 1 from pm.cm_sub_pay_app_lines x where x.sub_pay_app_id = v_id and x.this_period_work_cents <> 0) then
    raise exception 'PRECONDITION_NOTHING_TO_BILL: no work or stored materials claimed this period' using errcode = 'P0001';
  end if;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'sub_pay_app.drafted', 'cm_sub_pay_apps', v_id,
    format('Pay application #%s drafted on %s', v_no, c.number), jsonb_build_object('via', p_via));
  return v_id;
end $$;

create or replace function pm.cm_create_sub_pay_app(p_commitment uuid, p_period_end date, p_lines jsonb default '[]')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype;
begin
  select * into c from pm.commitments where id = p_commitment;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  return pm._cm_create_sub_pay_app(p_commitment, p_period_end, p_lines, 'INTERNAL', pm.current_user_id());
end $$;

create or replace function pm.cm_revise_sub_pay_app(p_app uuid, p_lines jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_sub_pay_apps%rowtype;
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_app using errcode = '42501';
  end if;
  if a.status not in ('DRAFT','REVISE') then raise exception 'PM_SUB_PAY_APP_LOCKED: pay application is %', a.status using errcode = '22023'; end if;
  perform pm._cm_fill_sub_pay_app(a.id, p_lines);
  -- the reviser becomes a preparer: they can never approve this application (any round)
  update pm.cm_sub_pay_apps set status = 'DRAFT', current_step = 0, chain = '[]'::jsonb, preparers = pm._cm_with(preparers, pm.current_user_id())
   where id = a.id;
  return a.id;
end $$;

-- Internal request of a lien waiver + its compliance requirement (holds payment until verified).
create or replace function pm._cm_request_waiver(p_commitment uuid, p_type text, p_amount bigint, p_through date, p_sub_pay_app uuid,
                                                  p_tier int, p_claimant text, p_actor text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_state text; v_form text; v_doc uuid; v_id uuid; v_doc_type text; v_vendor text;
begin
  select * into c from pm.commitments where id = p_commitment;
  if p_type not in ('CONDITIONAL_PROGRESS','UNCONDITIONAL_PROGRESS','CONDITIONAL_FINAL','UNCONDITIONAL_FINAL') then
    raise exception 'PM_INVALID: waiver type %', p_type using errcode = '22023';
  end if;
  select s.project_state into v_state from pm.cm_contract_settings s where s.org_id = c.org_id and s.job_id = c.job_id;
  select f.key into v_form from pm.cm_lien_waiver_forms f where f.state_code = v_state and f.waiver_type = p_type and f.is_active order by f.version desc limit 1;
  v_form := coalesce(v_form, 'GENERIC_' || p_type);
  v_doc_type := case p_type when 'CONDITIONAL_PROGRESS' then 'LIEN_WAIVER_CONDITIONAL'
                            when 'UNCONDITIONAL_PROGRESS' then 'LIEN_WAIVER_UNCONDITIONAL' else 'LIEN_WAIVER_FINAL' end;
  select coalesce(v.display_name, v.name) into v_vendor from core.vendors v where v.id = c.vendor_id;
  insert into pm.compliance_docs (org_id, job_id, commitment_id, vendor_id, doc_type, status, required, covers_through, amount_cents, notes, created_by)
  values (c.org_id, c.job_id, c.id, c.vendor_id, v_doc_type, 'MISSING', true, p_through, p_amount,
          format('%s lien waiver (%s) requested by Merit Projects', replace(lower(p_type), '_', ' '), v_form), p_actor)
  returning id into v_doc;
  insert into pm.cm_lien_waivers (org_id, job_id, commitment_id, vendor_id, sub_pay_app_id, direction, tier, claimant_name, waiver_type,
                                  state_code, form_key, amount_cents, through_date, status, compliance_doc_id, requested_by, requested_at)
  values (c.org_id, c.job_id, c.id, c.vendor_id, p_sub_pay_app, 'INBOUND', coalesce(p_tier, 1), coalesce(p_claimant, v_vendor), p_type,
          v_state, v_form, p_amount, p_through, 'REQUESTED', v_doc, p_actor, now())
  returning id into v_id;
  perform pm._cm_refresh_hold(c.id);
  return v_id;
end $$;

-- Re-emit JOB_COMMITMENT when the effective hold (manual or compliance) changed.
create or replace function pm._cm_refresh_hold(p_commitment uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype;
begin
  select * into c from pm.commitments where id = p_commitment;
  if c.status in ('APPROVED','EXECUTED')
     and (c.payment_hold or not pm.commitment_payment_eligible(c.id)) is distinct from c.last_emitted_hold then
    return pm.commitment_snapshot(c.id, 'COMPLIANCE');
  end if;
  return null;
end $$;

create or replace function pm.cm_submit_sub_pay_app(p_app uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_sub_pay_apps%rowtype; v_thr bigint; v_chain jsonb; v_me text := pm.current_user_id();
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app for update;
  if a.org_id is null or (a.org_id is distinct from public.get_org_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_app using errcode = '42501';
  end if;
  if a.status not in ('DRAFT','REVISE') then raise exception 'PM_SUB_PAY_APP_STATE: pay application is %', a.status using errcode = '22023'; end if;
  select coalesce(s.px_threshold_cents, 2500000) into v_thr from pm.cm_contract_settings s where s.org_id = a.org_id and s.job_id = a.job_id;
  v_chain := jsonb_build_array(
    jsonb_build_object('step', 1, 'label', 'Project manager', 'cap', 'projects.commitments', 'action', 'approve', 'executive', false),
    jsonb_build_object('step', 2, 'label', 'Project accountant', 'cap', 'projects.billing', 'action', 'approve', 'executive', false));
  if a.net_due_cents >= coalesce(v_thr, 2500000) then
    v_chain := v_chain || jsonb_build_object('step', 3, 'label', 'Project executive', 'cap', 'projects.financials', 'action', 'edit', 'executive', true);
  end if;
  update pm.cm_sub_pay_apps set status = 'SUBMITTED', chain = v_chain, current_step = 1, submitted_at = now(), preparers = pm._cm_with(preparers, v_me),
         submitted_by = coalesce(v_me, submitted_by, created_by) where id = a.id;
  insert into pm.cm_sub_pay_app_actions (org_id, job_id, sub_pay_app_id, step, action, actor) values (a.org_id, a.job_id, a.id, 0, 'SUBMIT', coalesce(v_me, a.created_by));
  -- the conditional waiver for this application (CGC-46: conditional with the pay app)
  if a.net_due_cents > 0 and not exists (select 1 from pm.cm_lien_waivers w where w.org_id = a.org_id and w.sub_pay_app_id = a.id
                                           and w.waiver_type = 'CONDITIONAL_PROGRESS' and w.status not in ('VOID','REJECTED')) then
    perform pm._cm_request_waiver(a.commitment_id, 'CONDITIONAL_PROGRESS', a.net_due_cents, a.period_end, a.id, 1, null, coalesce(v_me, a.created_by));
  end if;
  perform pm._cm_notify(a.org_id, 'sub_pay_app.review', a.job_id, 'cm_sub_pay_apps', a.id,
    pm._cm_members_with(a.org_id, a.location_id, 'projects.commitments', 'approve'),
    format('Sub pay application #%s to review', a.application_no), 'Waiting on the project manager', '/compliance?tab=sub-pay-apps&item=' || a.id,
    'subpay:' || a.id || ':1');
  return a.id;
end $$;

create or replace function pm._cm_sub_pay_app_approved(p_app uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_sub_pay_apps%rowtype; c pm.commitments%rowtype; v_out uuid := gen_random_uuid(); v_lines jsonb; v_waivers jsonb; v_hold boolean;
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app;
  select * into c from pm.commitments where id = a.commitment_id;
  if a.retainage_this_period_cents <> 0 then
    insert into pm.cm_payable_retainage (org_id, job_id, commitment_id, sub_pay_app_id, entry_type, amount_cents, memo)
    values (a.org_id, a.job_id, a.commitment_id, a.id, 'HELD', a.retainage_this_period_cents, format('Pay application #%s', a.application_no));
  end if;
  select jsonb_agg(jsonb_build_object('commitment_line_id', x.commitment_line_id, 'cost_code_id', x.cost_code_id, 'description', x.description,
           'this_period_work_cents', x.this_period_work_cents, 'stored_change_cents', x.stored_materials_cents - x.previous_stored_cents,
           'retainage_cents', x.retainage_this_period_cents) order by x.line_no)
    into v_lines from pm.cm_sub_pay_app_lines x where x.sub_pay_app_id = a.id;
  select jsonb_agg(jsonb_build_object('waiver_type', w.waiver_type, 'status', w.status, 'through_date', w.through_date)) into v_waivers
    from pm.cm_lien_waivers w where w.org_id = a.org_id and w.commitment_id = a.commitment_id and w.status not in ('VOID');
  v_hold := c.payment_hold or not pm.commitment_payment_eligible(c.id);
  insert into pm.cm_payable_outbox (id, org_id, job_id, location_id, commitment_id, sub_pay_app_id, kind, source_ref, payload)
  values (v_out, a.org_id, a.job_id, a.location_id, a.commitment_id, a.id, 'PAYABLE_REQUEST', 'pm:subpay:' || a.id,
    jsonb_build_object('event_type', 'JOB_PAYABLE_REQUEST', 'source_module', 'PROJECTS', 'schema_version', 1,
      'org_id', a.org_id, 'location_id', a.location_id, 'job_id', a.job_id, 'commitment_id', a.commitment_id,
      'commitment_version', c.version, 'vendor_id', a.vendor_id, 'sub_pay_app_id', a.id, 'application_no', a.application_no,
      'period_end', to_char(a.period_end, 'YYYY-MM-DD'), 'source_ref', 'pm:subpay:' || a.id,
      'gross_cents', a.gross_this_period_cents, 'stored_materials_cents', a.stored_to_date_cents,
      'retainage_cents', a.retainage_this_period_cents, 'net_cents', a.net_due_cents, 'release', false,
      'prepared_by', a.submitted_by, 'approved_by', a.approved_by, 'approved_at', a.approved_at,
      'payment_hold', v_hold, 'waivers', coalesce(v_waivers, '[]'::jsonb), 'lines', coalesce(v_lines, '[]'::jsonb)))
  on conflict (org_id, source_ref) do nothing;
  update pm.cm_sub_pay_apps set outbox_id = v_out where id = a.id;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'sub_pay_app.approved', 'cm_sub_pay_apps', a.id,
    format('Pay application #%s on %s approved (%s cents due)', a.application_no, c.number, a.net_due_cents),
    jsonb_build_object('outbox_id', v_out, 'payment_hold', v_hold));
  return v_out;
end $$;

-- One decision at the current step: PM → project accountant → executive over the threshold.
-- Preparer ≠ approver; one person never approves two steps.
create or replace function pm.cm_act_sub_pay_app(p_app uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_sub_pay_apps%rowtype; v_me text := pm.current_user_id(); v_step jsonb; v_n int; v_next jsonb;
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_app using errcode = '42501';
  end if;
  if a.status not in ('SUBMITTED','IN_REVIEW') then raise exception 'PM_SUB_PAY_APP_STATE: pay application is %', a.status using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if p_decision not in ('APPROVE','REJECT','REVISE') then raise exception 'PM_INVALID: decide APPROVE, REJECT or REVISE' using errcode = '22023'; end if;
  v_step := a.chain -> (a.current_step - 1);
  v_n := jsonb_array_length(a.chain);
  if not pm.access_can_job(v_step ->> 'cap', v_step ->> 'action', a.job_id) then
    raise exception 'PM_FORBIDDEN: step % (%) needs %:%', a.current_step, v_step ->> 'label', v_step ->> 'cap', v_step ->> 'action' using errcode = '42501';
  end if;
  if coalesce((v_step ->> 'executive')::boolean, false) and not pm._cm_is_executive(a.location_id) then
    raise exception 'PM_FORBIDDEN: step % needs a project executive (general manager or owner)', a.current_step using errcode = '42501';
  end if;
  if p_decision = 'APPROVE' then
    if v_me = a.created_by or v_me = a.submitted_by or v_me = any (a.preparers) then
      raise exception 'PM_SOD_VIOLATION: you prepared or revised this pay application, so someone else approves it' using errcode = '42501';
    end if;
    if exists (select 1 from pm.cm_sub_pay_app_actions x where x.sub_pay_app_id = a.id and x.action = 'APPROVE' and x.actor = v_me) then
      raise exception 'PM_SOD_DISTINCT: you approved an earlier step of this pay application; another person approves this one' using errcode = '42501';
    end if;
    insert into pm.cm_sub_pay_app_actions (org_id, job_id, sub_pay_app_id, step, action, actor, note) values (a.org_id, a.job_id, a.id, a.current_step, 'APPROVE', v_me, p_note);
    if a.current_step < v_n then
      update pm.cm_sub_pay_apps set current_step = a.current_step + 1, status = 'IN_REVIEW' where id = a.id;
      v_next := a.chain -> a.current_step;
      perform pm._cm_notify(a.org_id, 'sub_pay_app.review', a.job_id, 'cm_sub_pay_apps', a.id,
        pm._cm_members_with(a.org_id, a.location_id, v_next ->> 'cap', v_next ->> 'action'),
        format('Sub pay application #%s to review', a.application_no), 'Waiting on the ' || lower(v_next ->> 'label'),
        '/compliance?tab=sub-pay-apps&item=' || a.id, 'subpay:' || a.id || ':' || (a.current_step + 1));
      return jsonb_build_object('status', 'IN_REVIEW', 'step', a.current_step + 1, 'waiting_on', v_next ->> 'label');
    end if;
    update pm.cm_sub_pay_apps set status = 'APPROVED', approved_by = v_me, approved_at = now() where id = a.id;
    return jsonb_build_object('status', 'APPROVED', 'outbox_id', pm._cm_sub_pay_app_approved(a.id));
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'PM_INVALID: say why' using errcode = '22023'; end if;
  insert into pm.cm_sub_pay_app_actions (org_id, job_id, sub_pay_app_id, step, action, actor, note) values (a.org_id, a.job_id, a.id, a.current_step, p_decision, v_me, p_note);
  update pm.cm_sub_pay_apps set status = case p_decision when 'REJECT' then 'REJECTED' else 'REVISE' end,
         rejected_reason = p_note, current_step = case p_decision when 'REVISE' then 0 else current_step end
   where id = a.id;
  return jsonb_build_object('status', case p_decision when 'REJECT' then 'REJECTED' else 'REVISE' end);
end $$;

create or replace function pm.cm_void_sub_pay_app(p_app uuid, p_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_sub_pay_apps%rowtype;
begin
  select * into a from pm.cm_sub_pay_apps where id = p_app for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay application % not found in the caller''s organization', p_app using errcode = '42501';
  end if;
  if a.status in ('APPROVED','VOID') then raise exception 'PM_SUB_PAY_APP_STATE: pay application is %', a.status using errcode = '22023'; end if;
  update pm.cm_sub_pay_apps set status = 'VOID', rejected_reason = p_reason where id = a.id;
  insert into pm.cm_sub_pay_app_actions (org_id, job_id, sub_pay_app_id, step, action, actor, note) values (a.org_id, a.job_id, a.id, a.current_step, 'VOID', pm.current_user_id(), p_reason);
  -- the conditional waiver requested for it is no longer needed
  update pm.compliance_docs d set required = false
    from pm.cm_lien_waivers w where w.org_id = a.org_id and w.sub_pay_app_id = a.id and w.status in ('REQUESTED','SENT') and d.id = w.compliance_doc_id;
  update pm.cm_lien_waivers set status = 'VOID' where org_id = a.org_id and sub_pay_app_id = a.id and status in ('REQUESTED','SENT');
  perform pm._cm_refresh_hold(a.commitment_id);
  return a.id;
end $$;

-- Portal hook (service_role only): the sub bills in the 1118 portal against its commitment SOV.
create or replace function pm.cm_portal_submit_sub_pay_app(p_commitment uuid, p_vendor uuid, p_period_end date, p_lines jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_id uuid;
begin
  if not pm.access_is_service() then raise exception 'PM_FORBIDDEN: the portal hook runs on the service path only' using errcode = '42501'; end if;
  select * into c from pm.commitments where id = p_commitment;
  if c.id is null or c.vendor_id is distinct from p_vendor then raise exception 'PM_FORBIDDEN: not this vendor''s commitment' using errcode = '42501'; end if;
  v_id := pm._cm_create_sub_pay_app(p_commitment, p_period_end, p_lines, 'PORTAL', 'portal:' || p_vendor::text);
  perform pm.cm_submit_sub_pay_app(v_id);
  return v_id;
end $$;

-- Retainage payable release to a sub: needs a verified FINAL waiver and current compliance.
create or replace function pm.cm_release_sub_retainage(p_commitment uuid, p_amount_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_out bigint; v_amt bigint; v_id uuid := gen_random_uuid(); v_n int;
begin
  select * into c from pm.commitments where id = p_commitment for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  select coalesce(sum(case r.entry_type when 'HELD' then r.amount_cents else -r.amount_cents end), 0) into v_out
    from pm.cm_payable_retainage r where r.org_id = c.org_id and r.commitment_id = c.id;
  if v_out <= 0 then raise exception 'PRECONDITION_NO_RETAINAGE: % holds no retainage', c.number using errcode = 'P0001'; end if;
  v_amt := coalesce(p_amount_cents, v_out);
  if v_amt <= 0 or v_amt > v_out then raise exception 'PRECONDITION_RETAINAGE_EXCEEDS_HELD: release % exceeds held %', v_amt, v_out using errcode = 'P0001'; end if;
  if not exists (select 1 from pm.cm_lien_waivers w where w.org_id = c.org_id and w.commitment_id = c.id
                   and w.waiver_type in ('CONDITIONAL_FINAL','UNCONDITIONAL_FINAL') and w.status = 'VERIFIED') then
    raise exception 'PRECONDITION_FINAL_WAIVER: % has no verified final lien waiver; request one first', c.number using errcode = 'P0001';
  end if;
  if not pm.commitment_payment_eligible(c.id) or c.payment_hold then
    raise exception 'PRECONDITION_COMPLIANCE: % is on payment hold', c.number using errcode = 'P0001';
  end if;
  select count(*) into v_n from pm.cm_payable_outbox o where o.org_id = c.org_id and o.commitment_id = c.id and o.kind = 'RETAINAGE_RELEASE';
  insert into pm.cm_payable_outbox (id, org_id, job_id, location_id, commitment_id, kind, source_ref, payload)
  values (v_id, c.org_id, c.job_id, c.location_id, c.id, 'RETAINAGE_RELEASE', 'pm:subret:' || c.id || ':' || (v_n + 1),
          jsonb_build_object('event_type', 'JOB_PAYABLE_REQUEST', 'source_module', 'PROJECTS', 'schema_version', 1, 'release', true,
            'org_id', c.org_id, 'location_id', c.location_id, 'job_id', c.job_id, 'commitment_id', c.id, 'vendor_id', c.vendor_id,
            'retainage_released_cents', v_amt, 'source_ref', 'pm:subret:' || c.id || ':' || (v_n + 1), 'prepared_by', pm.current_user_id()));
  insert into pm.cm_payable_retainage (org_id, job_id, commitment_id, entry_type, amount_cents, memo, outbox_id)
  values (c.org_id, c.job_id, c.id, 'RELEASED', v_amt, 'Retainage release', v_id);
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'sub_retainage.released', 'commitments', c.id,
    format('Released %s cents of retainage on %s', v_amt, c.number), jsonb_build_object('outbox_id', v_id));
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Lien waivers (state forms) + COI verification + chasing
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_lien_waiver_forms (
  key            text primary key check (key ~ '^[A-Z0-9_]{3,60}$'),
  state_code     text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  waiver_type    text not null check (waiver_type in ('CONDITIONAL_PROGRESS','UNCONDITIONAL_PROGRESS','CONDITIONAL_FINAL','UNCONDITIONAL_FINAL')),
  title          text not null,
  statute        text,
  statutory      boolean not null default false,
  notarize       boolean not null default false,
  body_template  text not null,
  version        int not null default 1,
  is_active      boolean not null default true
);

create table if not exists pm.cm_lien_waivers (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  commitment_id      uuid,
  vendor_id          uuid references core.vendors(id),
  sub_pay_app_id     uuid,
  billing_request_id uuid,
  direction          text not null default 'INBOUND' check (direction in ('INBOUND','OUTBOUND')),
  tier               int not null default 1 check (tier between 1 and 3),
  claimant_name      text,
  customer_name      text,
  waiver_type        text not null check (waiver_type in ('CONDITIONAL_PROGRESS','UNCONDITIONAL_PROGRESS','CONDITIONAL_FINAL','UNCONDITIONAL_FINAL')),
  state_code         text,
  form_key           text not null,
  amount_cents       bigint,
  through_date       date,
  exceptions_text    text,
  status             text not null default 'REQUESTED' check (status in ('REQUESTED','SENT','SIGNED','RECEIVED','VERIFIED','REJECTED','VOID')),
  compliance_doc_id  uuid,
  esign_envelope_id  uuid,
  document_id        uuid,
  signed_amount_cents bigint,
  signed_through_date date,
  signed_form_key    text,
  payment_ref        text,
  paid_on            date,
  verification       jsonb not null default '[]',
  rejected_reason    text,
  requested_by       text,
  requested_at       timestamptz,
  received_by        text,
  received_at        timestamptz,
  verified_by        text,
  verified_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  check (direction = 'OUTBOUND' or commitment_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
alter table pm.cm_lien_waivers add column if not exists received_by text;
create index if not exists pm_cm_lien_waivers_cmt_idx on pm.cm_lien_waivers (org_id, commitment_id, status);
create unique index if not exists pm_cm_lien_waivers_doc_uidx on pm.cm_lien_waivers (compliance_doc_id) where compliance_doc_id is not null;

create table if not exists pm.cm_compliance_requirements (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid references core.locations(id),
  job_id              uuid,
  commitment_id       uuid,
  requirement         text not null check (requirement in ('GL_EACH_OCCURRENCE','GL_AGGREGATE','AUTO_COMBINED','UMBRELLA','WORKERS_COMP',
                        'EMPLOYERS_LIABILITY','PROFESSIONAL','POLLUTION','ADDITIONAL_INSURED_ONGOING','ADDITIONAL_INSURED_COMPLETED',
                        'WAIVER_OF_SUBROGATION','PRIMARY_NONCONTRIBUTORY','W9','LICENSE','PAYMENT_BOND','PERFORMANCE_BOND','EMR','CERTIFIED_PAYROLL')),
  min_limit_cents     bigint check (min_limit_cents is null or min_limit_cents >= 0),
  max_value           numeric(6,2),
  endorsement_forms   text[] not null default '{}',
  required            boolean not null default true,
  note                text,
  source_template_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  check (location_id is not null or job_id is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_cm_compliance_req_idx on pm.cm_compliance_requirements (org_id, job_id, commitment_id);

create table if not exists pm.cm_coi_certificates (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  job_id                  uuid,
  commitment_id           uuid,
  vendor_id               uuid not null references core.vendors(id),
  document_id             uuid,
  carrier                 text,
  producer                text,
  certificate_date        date,
  policies                jsonb not null default '[]' check (jsonb_typeof(policies) = 'array'),
  endorsements            text[] not null default '{}',
  additional_insured      boolean not null default false,
  waiver_of_subrogation   boolean not null default false,
  primary_noncontributory boolean not null default false,
  emr                     numeric(5,2),
  w9_on_file              boolean not null default false,
  license_no              text,
  license_expires         date,
  earliest_expiry         date,
  status                  text not null default 'RECEIVED' check (status in ('RECEIVED','VERIFIED','DEFICIENT','EXPIRED','SUPERSEDED')),
  verification            jsonb not null default '[]',
  verified_by             text,
  verified_at             timestamptz,
  created_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_coi_vendor_idx on pm.cm_coi_certificates (org_id, vendor_id, status);

create table if not exists pm.cm_compliance_chases (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  job_id       uuid,
  vendor_id    uuid references core.vendors(id),
  coi_id       uuid,
  waiver_id    uuid,
  kind         text not null check (kind in ('COI_RENEWAL','LIEN_WAIVER','W9','CERTIFIED_PAYROLL')),
  tier         int not null,
  due_on       date,
  message      text,
  sent_at      timestamptz not null default now(),
  unique nulls not distinct (org_id, coi_id, waiver_id, kind, tier)
);

-- Seed: state statutory forms (the rendered document must carry the statute's verbatim text — the
-- template here is the field layout; statutory = true marks forms whose wording is fixed by law).
insert into pm.cm_lien_waiver_forms as f (key, state_code, waiver_type, title, statute, statutory, notarize, body_template) values
  ('GENERIC_CONDITIONAL_PROGRESS', null, 'CONDITIONAL_PROGRESS', 'Conditional waiver and release on progress payment', null, false, false,
   'Upon receipt of {{amount}} by {{claimant}} for labor, services, equipment or material furnished to {{job}} through {{through_date}}, {{claimant}} waives and releases its lien and payment-bond rights for that work, except disputed claims and retention: {{exceptions}}.'),
  ('GENERIC_UNCONDITIONAL_PROGRESS', null, 'UNCONDITIONAL_PROGRESS', 'Unconditional waiver and release on progress payment', null, false, false,
   '{{claimant}} has been paid {{amount}} for labor, services, equipment or material furnished to {{job}} through {{through_date}} and waives and releases its lien and payment-bond rights for that work, except disputed claims and retention: {{exceptions}}.'),
  ('GENERIC_CONDITIONAL_FINAL', null, 'CONDITIONAL_FINAL', 'Conditional waiver and release on final payment', null, false, false,
   'Upon receipt of {{amount}}, {{claimant}} waives and releases all lien and payment-bond rights for labor, services, equipment or material furnished to {{job}}, except disputed claims: {{exceptions}}.'),
  ('GENERIC_UNCONDITIONAL_FINAL', null, 'UNCONDITIONAL_FINAL', 'Unconditional waiver and release on final payment', null, false, false,
   '{{claimant}} has been paid in full and waives and releases all lien and payment-bond rights for labor, services, equipment or material furnished to {{job}}, except disputed claims: {{exceptions}}.')
on conflict (key) do update set state_code = excluded.state_code, waiver_type = excluded.waiver_type, title = excluded.title,
  statute = excluded.statute, statutory = excluded.statutory, notarize = excluded.notarize, body_template = excluded.body_template;

do $$
declare s record; t record;
begin
  for s in select * from (values
      ('CA', 'Cal. Civ. Code §§ 8132, 8134, 8136, 8138'), ('TX', 'Tex. Prop. Code § 53.284'), ('AZ', 'A.R.S. § 33-1008'),
      ('GA', 'O.C.G.A. § 44-14-366'), ('NV', 'NRS 108.2457'), ('UT', 'Utah Code § 38-1a-802'), ('MI', 'MCL 570.1115'),
      ('MS', 'Miss. Code § 85-7-433'), ('MA', 'M.G.L. c. 254 § 32')) as v(st, statute) loop
    for t in select * from (values
        ('CONDITIONAL_PROGRESS', 'Conditional waiver and release on progress payment'),
        ('UNCONDITIONAL_PROGRESS', 'Unconditional waiver and release on progress payment'),
        ('CONDITIONAL_FINAL', 'Conditional waiver and release on final payment'),
        ('UNCONDITIONAL_FINAL', 'Unconditional waiver and release on final payment')) as w(wt, title) loop
      insert into pm.cm_lien_waiver_forms as f (key, state_code, waiver_type, title, statute, statutory, notarize, body_template)
      values (s.st || '_' || t.wt, s.st, t.wt, t.title || ' (' || s.st || ')', s.statute, true, s.st = 'MS',
              'Statutory form — render the verbatim text of ' || s.statute || ' with: claimant {{claimant}}, customer {{customer}}, job {{job}}, owner {{owner}}, amount {{amount}}, through {{through_date}}, exceptions {{exceptions}}.')
      on conflict (key) do update set state_code = excluded.state_code, waiver_type = excluded.waiver_type, title = excluded.title,
        statute = excluded.statute, statutory = excluded.statutory, notarize = excluded.notarize, body_template = excluded.body_template;
    end loop;
  end loop;
  -- Florida's statutory forms are progress and final releases upon payment (Fla. Stat. § 713.20)
  insert into pm.cm_lien_waiver_forms as f (key, state_code, waiver_type, title, statute, statutory, notarize, body_template) values
    ('FL_UNCONDITIONAL_PROGRESS', 'FL', 'UNCONDITIONAL_PROGRESS', 'Waiver and release of lien upon progress payment (FL)', 'Fla. Stat. § 713.20(4)', true, false,
     'Statutory form — render the verbatim text of Fla. Stat. § 713.20(4) with: claimant {{claimant}}, customer {{customer}}, job {{job}}, amount {{amount}}, through {{through_date}}.'),
    ('FL_UNCONDITIONAL_FINAL', 'FL', 'UNCONDITIONAL_FINAL', 'Waiver and release of lien upon final payment (FL)', 'Fla. Stat. § 713.20(5)', true, false,
     'Statutory form — render the verbatim text of Fla. Stat. § 713.20(5) with: claimant {{claimant}}, customer {{customer}}, job {{job}}, amount {{amount}}.')
  on conflict (key) do update set statute = excluded.statute, title = excluded.title, body_template = excluded.body_template;
end $$;

create or replace function pm.cm_request_lien_waiver(p_commitment uuid, p_type text, p_amount_cents bigint default null, p_through date default null,
                                                     p_sub_pay_app uuid default null, p_tier int default 1, p_claimant text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_id uuid;
begin
  select * into c from pm.commitments where id = p_commitment;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if c.status = 'VOID' then raise exception 'PM_COMMITMENT_VOID: %', c.number using errcode = '22023'; end if;
  if p_sub_pay_app is not null and not exists (select 1 from pm.cm_sub_pay_apps a where a.id = p_sub_pay_app and a.commitment_id = c.id) then
    raise exception 'PM_INVALID: that pay application is not on %', c.number using errcode = '22023';
  end if;
  v_id := pm._cm_request_waiver(c.id, p_type, p_amount_cents, coalesce(p_through, current_date), p_sub_pay_app, p_tier, p_claimant, pm.current_user_id());
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'lien_waiver.requested', 'cm_lien_waivers', v_id,
    format('%s lien waiver requested on %s', replace(initcap(p_type), '_', ' '), c.number), jsonb_build_object('tier', p_tier));
  return v_id;
end $$;

create or replace function pm.cm_lien_waiver_sent(p_waiver uuid, p_envelope uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.cm_lien_waivers%rowtype;
begin
  select * into w from pm.cm_lien_waivers where id = p_waiver for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: lien waiver % not found in the caller''s organization', p_waiver using errcode = '42501';
  end if;
  if w.status not in ('REQUESTED','SENT') then raise exception 'PM_WAIVER_STATE: waiver is %', w.status using errcode = '22023'; end if;
  update pm.cm_lien_waivers set status = 'SENT', esign_envelope_id = coalesce(p_envelope, esign_envelope_id) where id = w.id;
  return w.id;
end $$;

-- A signed waiver came back (upload, e-sign, portal). p_signed: {amount_cents, through_date, form_key}.
create or replace function pm.cm_receive_lien_waiver(p_waiver uuid, p_document uuid default null, p_signed jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.cm_lien_waivers%rowtype;
begin
  select * into w from pm.cm_lien_waivers where id = p_waiver for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: lien waiver % not found in the caller''s organization', p_waiver using errcode = '42501';
  end if;
  if w.status not in ('REQUESTED','SENT','SIGNED','RECEIVED','REJECTED') then raise exception 'PM_WAIVER_STATE: waiver is %', w.status using errcode = '22023'; end if;
  if p_document is not null and not exists (select 1 from public.documents d where d.id = p_document and d.org_id = w.org_id) then
    raise exception 'PM_DOCUMENT_ORG_MISMATCH: %', p_document using errcode = '23503';
  end if;
  update pm.cm_lien_waivers
     set status = 'RECEIVED', received_at = now(), received_by = pm.current_user_id(), document_id = coalesce(p_document, document_id),
         signed_amount_cents = coalesce((p_signed ->> 'amount_cents')::bigint, signed_amount_cents, amount_cents),
         signed_through_date = coalesce((p_signed ->> 'through_date')::date, signed_through_date, through_date),
         signed_form_key = coalesce(p_signed ->> 'form_key', signed_form_key, form_key)
   where id = w.id;
  if w.compliance_doc_id is not null then
    update pm.compliance_docs set status = 'RECEIVED', document_id = coalesce(p_document, document_id), verified_at = null, verified_by = null
     where id = w.compliance_doc_id and status <> 'VERIFIED';
  end if;
  return w.id;
end $$;

-- Check the returned waiver (amount, through-date, statutory form) and release the hold when it ties.
create or replace function pm.cm_verify_lien_waiver(p_waiver uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.cm_lien_waivers%rowtype; v_problems jsonb := '[]'::jsonb; v_ok boolean; v_me text := pm.current_user_id();
begin
  select * into w from pm.cm_lien_waivers where id = p_waiver for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: lien waiver % not found in the caller''s organization', p_waiver using errcode = '42501';
  end if;
  if w.status not in ('RECEIVED','SIGNED') then raise exception 'PM_WAIVER_NOT_RECEIVED: waiver is %', w.status using errcode = '22023'; end if;
  -- security review 2026-10: a named verifier, never the person who logged it as received,
  -- and evidence on file (the signed document, or a completed e-sign envelope)
  if v_me is null then raise exception 'PM_NO_ACTOR: verifying a waiver requires an identified user' using errcode = '42501'; end if;
  if w.received_by is not null and w.received_by = v_me then
    raise exception 'PM_SOD_VIOLATION: you logged this waiver as received, so someone else verifies it' using errcode = '42501';
  end if;
  -- the evidence must BE a lien waiver: a filed lien-waiver document (the upload route files it as
  -- kind lien_waiver), or a completed e-sign envelope for a lien waiver — never any other file
  if not exists (select 1 from pm.doc_versions v join pm.doc_files f on f.id = v.file_id and f.org_id = v.org_id
                  where v.org_id = w.org_id and v.document_id = w.document_id and f.kind = 'lien_waiver')
     and not exists (select 1 from pm.esign_envelopes e left join pm.doc_files f on f.id = e.file_id and f.org_id = e.org_id
                      where e.org_id = w.org_id and e.status = 'completed'
                        and (e.on_completed_kind = 'lien_waiver' or f.kind = 'lien_waiver')
                        and (e.id = w.esign_envelope_id or (e.on_completed_kind = 'lien_waiver' and e.on_completed_id = w.compliance_doc_id))) then
    raise exception 'PRECONDITION_WAIVER_DOCUMENT: attach the signed lien waiver (filed as a lien waiver, or completed by e-sign) before verifying' using errcode = 'P0001';
  end if;
  if w.amount_cents is not null and coalesce(w.signed_amount_cents, w.amount_cents) <> w.amount_cents then
    v_problems := v_problems || jsonb_build_object('code', 'AMOUNT', 'text', format('Signed for %s cents; requested %s cents.', w.signed_amount_cents, w.amount_cents));
  end if;
  if w.through_date is not null and coalesce(w.signed_through_date, w.through_date) < w.through_date then
    v_problems := v_problems || jsonb_build_object('code', 'THROUGH_DATE', 'text', format('Covers through %s; needs %s.', w.signed_through_date, w.through_date));
  end if;
  if coalesce(w.signed_form_key, w.form_key) <> w.form_key then
    v_problems := v_problems || jsonb_build_object('code', 'FORM', 'text', format('Signed on form %s; this job needs %s.', w.signed_form_key, w.form_key));
  end if;
  v_ok := jsonb_array_length(v_problems) = 0;
  update pm.cm_lien_waivers set status = case when v_ok then 'VERIFIED' else 'REJECTED' end, verification = v_problems,
         verified_by = case when v_ok then pm.current_user_id() end, verified_at = case when v_ok then now() end,
         rejected_reason = case when v_ok then null else (select string_agg(x ->> 'text', ' ') from jsonb_array_elements(v_problems) x) end
   where id = w.id;
  if w.compliance_doc_id is not null then
    if v_ok then
      perform pm.verify_compliance_doc(w.compliance_doc_id, null);
    else
      update pm.compliance_docs set status = 'REJECTED', notes = left('Waiver rejected: ' || (select string_agg(x ->> 'text', ' ') from jsonb_array_elements(v_problems) x), 2000)
       where id = w.compliance_doc_id;
      perform pm._cm_refresh_hold(w.commitment_id);
    end if;
  end if;
  return jsonb_build_object('ok', v_ok, 'problems', v_problems);
end $$;

-- Books paid the sub (AP payment status): ask for the unconditional waiver for that payment.
create or replace function pm.cm_record_sub_payment(p_commitment uuid, p_amount_cents bigint, p_paid_on date, p_payment_ref text default null,
                                                    p_final boolean default false)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_id uuid;
begin
  select * into c from pm.commitments where id = p_commitment;
  if c.org_id is null or (c.org_id is distinct from public.get_org_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: commitment % not found in the caller''s organization', p_commitment using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PM_INVALID: payment must be > 0' using errcode = '22023'; end if;
  v_id := pm._cm_request_waiver(c.id, case when p_final then 'UNCONDITIONAL_FINAL' else 'UNCONDITIONAL_PROGRESS' end, p_amount_cents,
                                coalesce(p_paid_on, current_date), null, 1, null, coalesce(pm.current_user_id(), 'system'));
  update pm.cm_lien_waivers set payment_ref = p_payment_ref, paid_on = coalesce(p_paid_on, current_date) where id = v_id;
  return v_id;
end $$;

-- The sub's own outbound waiver to its GC / owner (specialty trade side; no hold).
create or replace function pm.cm_outbound_lien_waiver(p_job uuid, p_type text, p_amount_cents bigint, p_through date, p_billing_request uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_state text; v_form text; v_id uuid; v_company text; v_customer text;
begin
  select * into j from pm._cm_job(p_job);
  if p_type not in ('CONDITIONAL_PROGRESS','UNCONDITIONAL_PROGRESS','CONDITIONAL_FINAL','UNCONDITIONAL_FINAL') then
    raise exception 'PM_INVALID: waiver type %', p_type using errcode = '22023';
  end if;
  select s.project_state into v_state from pm.cm_contract_settings s where s.org_id = j.org_id and s.job_id = p_job;
  select f.key into v_form from pm.cm_lien_waiver_forms f where f.state_code = v_state and f.waiver_type = p_type and f.is_active order by f.version desc limit 1;
  select l.name into v_company from core.locations l where l.id = j.location_id;
  select coalesce(c.display_name, c.name, jb.customer_name) into v_customer from core.jobs jb left join core.customers c on c.id = jb.customer_id where jb.id = p_job;
  insert into pm.cm_lien_waivers (org_id, job_id, billing_request_id, direction, tier, claimant_name, customer_name, waiver_type, state_code, form_key,
                                  amount_cents, through_date, status, requested_by, requested_at)
  values (j.org_id, p_job, p_billing_request, 'OUTBOUND', 1, v_company, v_customer, p_type, v_state, coalesce(v_form, 'GENERIC_' || p_type),
          p_amount_cents, p_through, 'REQUESTED', pm.current_user_id(), now())
  returning id into v_id;
  return v_id;
end $$;

-- E-sign completion (lib/esign 'lien_waiver' kind) sets the compliance doc RECEIVED: carry it to the waiver.
create or replace function pm.tg_cm_compliance_waiver_sync() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status is not distinct from old.status and new.document_id is not distinct from old.document_id then return null; end if;
  if new.status = 'RECEIVED' then
    update pm.cm_lien_waivers set status = 'RECEIVED', received_at = coalesce(received_at, now())
     where org_id = new.org_id and compliance_doc_id = new.id and status in ('REQUESTED','SENT','SIGNED');
  elsif new.status = 'VERIFIED' then
    update pm.cm_lien_waivers set status = 'VERIFIED', verified_at = coalesce(verified_at, now()), verified_by = coalesce(verified_by, new.verified_by)
     where org_id = new.org_id and compliance_doc_id = new.id and status in ('REQUESTED','SENT','SIGNED','RECEIVED');
  end if;
  return null;
end $$;
-- A waiver's compliance document is verified only through pm.cm_verify_lien_waiver (which checks
-- the evidence, the amount / through-date / form and separation of duties) — never directly by a
-- person through the 1102 compliance path. Service paths (no signed-in user) are unaffected.
create or replace function pm.tg_cm_waiver_doc_verify_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status = 'VERIFIED' and old.status is distinct from 'VERIFIED' and pm.current_user_id() is not null
     and exists (select 1 from pm.cm_lien_waivers w where w.org_id = new.org_id and w.compliance_doc_id = new.id and w.status <> 'VERIFIED') then
    raise exception 'PM_WAIVER_VERIFY_HERE: verify the lien waiver from Compliance; it checks the signed form first' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_cm_waiver_doc_verify_gate on pm.compliance_docs;
create trigger trg_cm_waiver_doc_verify_gate before update of status on pm.compliance_docs
  for each row execute function pm.tg_cm_waiver_doc_verify_gate();
drop trigger if exists trg_cm_compliance_waiver_sync on pm.compliance_docs;
create trigger trg_cm_compliance_waiver_sync after update of status, document_id on pm.compliance_docs
  for each row execute function pm.tg_cm_compliance_waiver_sync();

-- COI verification against the contract's requirements (limits, endorsements, flags, expiry).
create or replace function pm._cm_verify_coi(p_coi uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  c pm.cm_coi_certificates%rowtype; q record; v_ok boolean; v_detail text; v_results jsonb := '[]'::jsonb; v_all boolean := true;
  v_pol jsonb; v_lim bigint; v_exp date; v_forms text[]; v_status text; v_earliest date; v_cmts uuid[]; v_cmt uuid; v_doc uuid; v_def text;
  v_type text;
begin
  select * into c from pm.cm_coi_certificates where id = p_coi for update;
  select min((p ->> 'expires')::date) into v_earliest from jsonb_array_elements(c.policies) p where p ->> 'expires' is not null;
  for q in
    select r.* from pm.cm_compliance_requirements r
     where r.org_id = c.org_id
       and ((r.commitment_id is not null and r.commitment_id = c.commitment_id)
            or (r.commitment_id is null and r.job_id is not null and r.job_id = c.job_id)
            or (r.commitment_id is null and r.job_id is null and r.location_id = c.location_id))
     order by r.requirement
  loop
    v_ok := null; v_detail := null; v_pol := null;
    v_type := case q.requirement
                when 'GL_EACH_OCCURRENCE' then 'GL' when 'GL_AGGREGATE' then 'GL' when 'AUTO_COMBINED' then 'AUTO'
                when 'UMBRELLA' then 'UMBRELLA' when 'WORKERS_COMP' then 'WC' when 'EMPLOYERS_LIABILITY' then 'EL'
                when 'PROFESSIONAL' then 'PROFESSIONAL' when 'POLLUTION' then 'POLLUTION' end;
    if v_type is not null then
      select p into v_pol from jsonb_array_elements(c.policies) p where upper(p ->> 'type') = v_type
        order by (p ->> 'expires')::date desc nulls last limit 1;
      if v_pol is null and q.requirement = 'EMPLOYERS_LIABILITY' then
        select p into v_pol from jsonb_array_elements(c.policies) p where upper(p ->> 'type') = 'WC' limit 1;
      end if;
      v_lim := case q.requirement when 'GL_AGGREGATE' then (v_pol ->> 'aggregate_cents')::bigint
                                  when 'GL_EACH_OCCURRENCE' then (v_pol ->> 'each_occurrence_cents')::bigint
                                  else coalesce((v_pol ->> 'limit_cents')::bigint, (v_pol ->> 'each_occurrence_cents')::bigint) end;
      v_exp := (v_pol ->> 'expires')::date;
      if v_pol is null then v_ok := false; v_detail := format('No %s policy on the certificate.', v_type);
      elsif v_exp is not null and v_exp < current_date then v_ok := false; v_detail := format('%s policy expired %s.', v_type, v_exp);
      elsif q.min_limit_cents is not null and coalesce(v_lim, 0) < q.min_limit_cents then
        v_ok := false; v_detail := format('%s limit %s below the required %s.', v_type, coalesce(v_lim, 0) / 100, q.min_limit_cents / 100);
      else v_ok := true; end if;
    elsif q.requirement in ('ADDITIONAL_INSURED_ONGOING','ADDITIONAL_INSURED_COMPLETED') then
      v_forms := case when cardinality(q.endorsement_forms) > 0 then array(select upper(btrim(x)) from unnest(q.endorsement_forms) x)
                      when q.requirement = 'ADDITIONAL_INSURED_ONGOING' then array['CG 20 10'] else array['CG 20 37'] end;
      if not c.additional_insured then v_ok := false; v_detail := 'Additional insured not shown.';
      elsif not (v_forms <@ c.endorsements
                 or (q.requirement = 'ADDITIONAL_INSURED_ONGOING' and 'CG 20 38' = any (c.endorsements) and cardinality(q.endorsement_forms) = 0)
                 or (q.requirement = 'ADDITIONAL_INSURED_COMPLETED' and 'CG 20 40' = any (c.endorsements) and cardinality(q.endorsement_forms) = 0)) then
        v_ok := false; v_detail := format('Missing endorsement %s.', array_to_string(array(select x from unnest(v_forms) x where not (x = any (c.endorsements))), ', '));
      else v_ok := true; end if;
    elsif q.requirement = 'WAIVER_OF_SUBROGATION' then
      v_ok := c.waiver_of_subrogation and array(select upper(btrim(x)) from unnest(q.endorsement_forms) x) <@ c.endorsements;
      v_detail := case when not c.waiver_of_subrogation then 'Waiver of subrogation not shown.'
                       when not v_ok then format('Missing endorsement %s.', array_to_string(q.endorsement_forms, ', ')) end;
    elsif q.requirement = 'PRIMARY_NONCONTRIBUTORY' then
      v_ok := c.primary_noncontributory and array(select upper(btrim(x)) from unnest(q.endorsement_forms) x) <@ c.endorsements;
      v_detail := case when not v_ok then 'Primary and non-contributory wording not shown.' end;
    elsif q.requirement = 'W9' then
      v_ok := c.w9_on_file; v_detail := case when not v_ok then 'No W-9 on file.' end;
    elsif q.requirement = 'LICENSE' then
      v_ok := c.license_no is not null and (c.license_expires is null or c.license_expires >= current_date);
      v_detail := case when c.license_no is null then 'No license number.' when not v_ok then format('License expired %s.', c.license_expires) end;
    elsif q.requirement = 'EMR' then
      v_ok := c.emr is not null and c.emr <= coalesce(q.max_value, 1.0);
      v_detail := case when c.emr is null then 'No EMR given.' when not v_ok then format('EMR %s above %s.', c.emr, coalesce(q.max_value, 1.0)) end;
    end if;
    if v_ok is not null then
      v_results := v_results || jsonb_build_object('requirement', q.requirement, 'ok', v_ok, 'required', q.required, 'detail', v_detail);
      if q.required and not v_ok then v_all := false; end if;
    end if;
  end loop;
  v_status := case when v_earliest is not null and v_earliest < current_date then 'EXPIRED' when v_all then 'VERIFIED' else 'DEFICIENT' end;
  update pm.cm_coi_certificates set verification = v_results, status = v_status, earliest_expiry = v_earliest,
         verified_by = pm.current_user_id(), verified_at = now() where id = c.id;
  update pm.cm_coi_certificates x set status = 'SUPERSEDED'
   where x.org_id = c.org_id and x.vendor_id = c.vendor_id and x.id <> c.id and x.status <> 'SUPERSEDED'
     and x.job_id is not distinct from c.job_id and x.commitment_id is not distinct from c.commitment_id and x.created_at <= c.created_at;
  -- mirror into pm.compliance_docs (COI) on every commitment it covers → payment hold follows
  select array_agg(m.id) into v_cmts from pm.commitments m
   where m.org_id = c.org_id and m.vendor_id = c.vendor_id and m.status in ('DRAFT','APPROVED','EXECUTED')
     and ((c.commitment_id is not null and m.id = c.commitment_id)
          or (c.commitment_id is null and c.job_id is not null and m.job_id = c.job_id)
          or (c.commitment_id is null and c.job_id is null and m.location_id = c.location_id));
  select string_agg(x ->> 'detail', ' ') into v_def from jsonb_array_elements(v_results) x where not (x ->> 'ok')::boolean and (x ->> 'required')::boolean;
  foreach v_cmt in array coalesce(v_cmts, '{}'::uuid[]) loop
    select d.id into v_doc from pm.compliance_docs d where d.org_id = c.org_id and d.commitment_id = v_cmt and d.doc_type = 'COI'
      order by d.created_at desc limit 1;
    if v_doc is null then
      insert into pm.compliance_docs (org_id, job_id, commitment_id, vendor_id, doc_type, status, required, created_by)
      select c.org_id, m.job_id, m.id, m.vendor_id, 'COI', 'RECEIVED', true, pm.current_user_id() from pm.commitments m where m.id = v_cmt
      returning id into v_doc;
    end if;
    if v_status = 'VERIFIED' then
      update pm.compliance_docs set status = 'VERIFIED', verified_by = coalesce(pm.current_user_id(), 'system'), verified_at = now(),
             expires_on = v_earliest, notes = 'Certificate verified (Merit Projects COI check)' where id = v_doc;
    elsif v_status = 'EXPIRED' then
      update pm.compliance_docs set status = 'EXPIRED', expires_on = v_earliest, notes = 'Certificate expired' where id = v_doc;
    else
      update pm.compliance_docs set status = 'REJECTED', verified_by = null, verified_at = null, expires_on = v_earliest,
             notes = left('COI deficient: ' || coalesce(v_def, 'requirements not met'), 2000) where id = v_doc;
    end if;
    perform pm._cm_refresh_hold(v_cmt);
    v_doc := null;
  end loop;
  return jsonb_build_object('status', v_status, 'results', v_results, 'earliest_expiry', v_earliest, 'commitments', to_jsonb(coalesce(v_cmts, '{}'::uuid[])));
end $$;

create or replace function pm.cm_record_coi(p_vendor uuid, p_location uuid, p_job uuid default null, p_commitment uuid default null, p_doc jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid := p_location; v_id uuid;
begin
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: vendor % not found in the caller''s organization', p_vendor using errcode = '42501';
  end if;
  if p_job is not null then
    select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
    if v_loc is null then raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501'; end if;
  end if;
  if v_loc is null or not exists (select 1 from core.locations l where l.id = v_loc and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: company not in the caller''s organization' using errcode = '42501';
  end if;
  if p_commitment is not null and not exists (select 1 from pm.commitments c where c.id = p_commitment and c.org_id = v_org and c.vendor_id = p_vendor) then
    raise exception 'PM_INVALID: that commitment is not this vendor''s' using errcode = '22023';
  end if;
  insert into pm.cm_coi_certificates (org_id, location_id, job_id, commitment_id, vendor_id, document_id, carrier, producer, certificate_date,
    policies, endorsements, additional_insured, waiver_of_subrogation, primary_noncontributory, emr, w9_on_file, license_no, license_expires, created_by)
  values (v_org, v_loc, p_job, p_commitment, p_vendor, pm.access_try_uuid(p_doc ->> 'document_id'), left(p_doc ->> 'carrier', 200), left(p_doc ->> 'producer', 200),
    (p_doc ->> 'certificate_date')::date, coalesce(p_doc -> 'policies', '[]'::jsonb),
    coalesce(array(select upper(btrim(x)) from jsonb_array_elements_text(coalesce(p_doc -> 'endorsements', '[]'::jsonb)) x), '{}'),
    coalesce((p_doc ->> 'additional_insured')::boolean, false), coalesce((p_doc ->> 'waiver_of_subrogation')::boolean, false),
    coalesce((p_doc ->> 'primary_noncontributory')::boolean, false), (p_doc ->> 'emr')::numeric, coalesce((p_doc ->> 'w9_on_file')::boolean, false),
    left(p_doc ->> 'license_no', 60), (p_doc ->> 'license_expires')::date, pm.current_user_id())
  returning id into v_id;
  perform pm._cm_verify_coi(v_id);
  return v_id;
end $$;

create or replace function pm.cm_verify_coi(p_coi uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.cm_coi_certificates%rowtype;
begin
  select * into c from pm.cm_coi_certificates where id = p_coi;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: certificate % not found in the caller''s organization', p_coi using errcode = '42501';
  end if;
  if c.status = 'SUPERSEDED' then raise exception 'PM_COI_SUPERSEDED: a newer certificate replaced this one' using errcode = '22023'; end if;
  return pm._cm_verify_coi(c.id);
end $$;

-- Renewal chasing at 30 / 15 / 0 days; expiry flips the certificate and its compliance docs (hold).
-- p_location null = every company the caller can chase at (service: every org).
create or replace function pm.cm_compliance_chase_run(p_location uuid default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c record; v_days int; v_tier int; n int := 0; w record; v_org uuid := public.get_org_id(); v_svc boolean := pm.access_is_service(); d record;
begin
  for c in
    select x.* from pm.cm_coi_certificates x
     where x.status in ('VERIFIED','DEFICIENT','EXPIRED') and x.earliest_expiry is not null
       and (v_svc or x.org_id = v_org) and (p_location is null or x.location_id = p_location)
       and (v_svc or x.location_id in (select pm.my_location_ids('projects.commitments', 'edit')))
  loop
    v_days := c.earliest_expiry - current_date;
    v_tier := case when v_days <= 0 then 0 when v_days <= 15 then 15 when v_days <= 30 then 30 end;
    if v_tier is not null and not exists (select 1 from pm.cm_compliance_chases h where h.org_id = c.org_id and h.coi_id = c.id and h.kind = 'COI_RENEWAL' and h.tier = v_tier) then
      insert into pm.cm_compliance_chases (org_id, location_id, job_id, vendor_id, coi_id, kind, tier, due_on, message)
      values (c.org_id, c.location_id, c.job_id, c.vendor_id, c.id, 'COI_RENEWAL', v_tier, c.earliest_expiry,
              case when v_tier = 0 then 'Certificate of insurance expired — payment is on hold until a renewal is verified.'
                   else format('Certificate of insurance expires in %s days (%s). Send the renewal.', v_days, c.earliest_expiry) end)
      on conflict do nothing;
      n := n + 1;
      perform pm._cm_notify(c.org_id, 'compliance.expiring', c.job_id, 'cm_coi_certificates', c.id,
        pm._cm_members_with(c.org_id, c.location_id, 'projects.commitments', 'approve'),
        case when v_tier = 0 then 'A certificate of insurance expired' else format('A certificate of insurance expires in %s days', v_days) end,
        (select coalesce(v.display_name, v.name) from core.vendors v where v.id = c.vendor_id), '/compliance?tab=coi&item=' || c.id,
        'coi:' || c.id || ':' || v_tier);
    end if;
    if v_days < 0 and c.status <> 'EXPIRED' then
      update pm.cm_coi_certificates set status = 'EXPIRED' where id = c.id;
      for d in select x.id, x.commitment_id from pm.compliance_docs x
                where x.org_id = c.org_id and x.vendor_id = c.vendor_id and x.doc_type = 'COI' and x.status = 'VERIFIED' and x.expires_on = c.earliest_expiry loop
        update pm.compliance_docs set status = 'EXPIRED' where id = d.id;
        if d.commitment_id is not null then perform pm._cm_refresh_hold(d.commitment_id); end if;
      end loop;
    end if;
  end loop;
  for w in
    select x.*, m.location_id from pm.cm_lien_waivers x join pm.commitments m on m.id = x.commitment_id
     where x.direction = 'INBOUND' and x.status in ('REQUESTED','SENT') and x.requested_at < now() - interval '7 days'
       and (v_svc or x.org_id = v_org) and (p_location is null or m.location_id = p_location)
       and (v_svc or m.location_id in (select pm.my_location_ids('projects.commitments', 'edit')))
  loop
    if not exists (select 1 from pm.cm_compliance_chases h where h.org_id = w.org_id and h.waiver_id = w.id and h.kind = 'LIEN_WAIVER' and h.tier = 7) then
      insert into pm.cm_compliance_chases (org_id, location_id, job_id, vendor_id, waiver_id, kind, tier, due_on, message)
      values (w.org_id, w.location_id, w.job_id, w.vendor_id, w.id, 'LIEN_WAIVER', 7, w.through_date,
              'Lien waiver requested more than a week ago — payment stays on hold until it is returned and verified.')
      on conflict do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 6. T&M tickets → GC signature → T&M billing (or a change event at contract rates)
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_rate_sheets (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid not null,
  name                  text not null default 'Contract rates',
  labor_rates           jsonb not null default '[]' check (jsonb_typeof(labor_rates) = 'array'),   -- [{class, st_cents, ot_cents, dt_cents}]
  material_markup_pct   numeric(6,4) not null default 0.15 check (material_markup_pct >= 0 and material_markup_pct <= 5),
  equipment_rates       jsonb not null default '[]' check (jsonb_typeof(equipment_rates) = 'array'), -- [{equipment, hourly_cents}]
  equipment_markup_pct  numeric(6,4) not null default 0 check (equipment_markup_pct >= 0 and equipment_markup_pct <= 5),
  sub_markup_pct        numeric(6,4) not null default 0.10 check (sub_markup_pct >= 0 and sub_markup_pct <= 5),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_tm_tickets (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  number              text,
  work_date           date not null default current_date,
  description         text not null check (char_length(description) between 1 and 4000),
  area                text,
  change_event_id     uuid,
  gc_reference        text,
  crew_id             uuid,
  foreman_employee_id uuid references core.employees(id),
  status              text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','SIGNED','DISPUTED','BILLED','VOID')),
  signer_name         text,
  signer_title        text,
  signer_company      text,
  signed_at           timestamptz,
  signature_png       text check (signature_png is null or char_length(signature_png) <= 400000),
  sign_method         text check (sign_method is null or sign_method in ('DEVICE','REMOTE','PAPER')),
  esign_envelope_id   uuid,
  disputed_reason     text,
  disputed_at         timestamptz,
  billed_request_id   uuid,
  photo_ids           uuid[] not null default '{}',
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_event_id) references pm.cm_change_events (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_tm_job_idx on pm.cm_tm_tickets (org_id, job_id, status, work_date);

create table if not exists pm.cm_tm_ticket_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid,
  ticket_id        uuid not null,
  kind             text not null default 'LABOR' check (kind in ('LABOR','MATERIAL','EQUIPMENT','SUBCONTRACT','OTHER')),
  labor_class      text,
  employee_id      uuid references core.employees(id),
  worker_name      text,
  hours_st         numeric(6,2) not null default 0 check (hours_st >= 0),
  hours_ot         numeric(6,2) not null default 0 check (hours_ot >= 0),
  hours_dt         numeric(6,2) not null default 0 check (hours_dt >= 0),
  qty              numeric(14,4),
  uom              text,
  description      text not null default '',
  unit_cost_cents  bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  equipment_hours  numeric(8,2),
  time_entry_id    uuid,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ticket_id) references pm.cm_tm_tickets (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_cm_tm_lines_time_uidx on pm.cm_tm_ticket_lines (org_id, time_entry_id) where time_entry_id is not null;

create table if not exists pm.cm_tm_billing_links (
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  ticket_id               uuid not null,
  job_id                  uuid not null,
  billing_request_id      uuid not null,
  billing_request_line_id uuid not null,
  amount_cents            bigint not null,
  created_at              timestamptz not null default now(),
  primary key (org_id, ticket_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.tg_cm_tm_ticket_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if not pm.access_member_role() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' or new.signed_at is not null or new.billed_request_id is not null then
      raise exception 'PM_TM_STATE: a ticket starts as DRAFT' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status in ('SIGNED','BILLED','VOID') then
    raise exception 'PM_TM_LOCKED: % is % — signed tickets change only by dispute', old.number, old.status using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.signed_at is distinct from old.signed_at or new.billed_request_id is distinct from old.billed_request_id
     or new.signer_name is distinct from old.signer_name or new.signature_png is distinct from old.signature_png then
    raise exception 'PM_TM_STATE: status and signature move only through the ticket actions' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function pm.tg_cm_tm_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text;
begin
  if not pm.access_member_role() then return coalesce(new, old); end if;
  select t.status into v_status from pm.cm_tm_tickets t where t.id = coalesce(new.ticket_id, old.ticket_id);
  if v_status not in ('DRAFT','SUBMITTED','DISPUTED') then
    raise exception 'PM_TM_LOCKED: the ticket is % — its lines are locked', v_status using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' and new.unit_cost_cents is not null and (tg_op = 'INSERT' or new.unit_cost_cents is distinct from old.unit_cost_cents)
     and not exists (select 1 from pm.my_money_job_ids('projects.financials') x where x = new.job_id) then
    raise exception 'PM_MONEY_FORBIDDEN: material cost needs Job financials on this job (record the quantity only)' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['cm_pay_app_status','cm_sub_pay_apps','cm_sub_progress_opinions','cm_lien_waivers','cm_compliance_requirements',
                           'cm_coi_certificates','cm_rate_sheets','cm_tm_tickets'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['cm_sub_progress_opinions','cm_coi_certificates','cm_tm_tickets'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;
create or replace trigger trg_cm_child_job before insert or update of sub_pay_app_id on pm.cm_sub_pay_app_lines
  for each row execute function pm.tg_cm_child_job('cm_sub_pay_apps', 'sub_pay_app_id');
create or replace trigger trg_cm_rpc_only before insert or update or delete on pm.cm_sub_pay_apps
  for each row execute function pm.tg_cm_sub_pay_app_guard();
create or replace trigger trg_cm_rpc_only before insert or update or delete on pm.cm_sub_pay_app_lines
  for each row execute function pm.tg_cm_sub_pay_app_guard();
create or replace trigger trg_cm_number before insert on pm.cm_tm_tickets
  for each row execute function pm.tg_cm_number('CM_TM', 'TM-', '3');
create or replace trigger trg_cm_tm_guard before insert or update on pm.cm_tm_tickets
  for each row execute function pm.tg_cm_tm_ticket_guard();
create or replace trigger trg_cm_child_job before insert or update of ticket_id on pm.cm_tm_ticket_lines
  for each row execute function pm.tg_cm_child_job('cm_tm_tickets', 'ticket_id');
create or replace trigger trg_cm_tm_line_guard before insert or update or delete on pm.cm_tm_ticket_lines
  for each row execute function pm.tg_cm_tm_line_guard();
drop trigger if exists trg_cm_billing_sync on pm.billing_requests;
create trigger trg_cm_billing_sync after update of status on pm.billing_requests
  for each row execute function pm.tg_cm_billing_sync();

-- Price one ticket at the job's active rate sheet (sell, contract rates).
create or replace function pm._cm_tm_price(p_ticket uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype; rs pm.cm_rate_sheets%rowtype; l record; r jsonb; v_labor bigint := 0; v_mat bigint := 0; v_eq bigint := 0;
        v_sub bigint := 0; v_other bigint := 0; v_hours numeric := 0;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket;
  select * into rs from pm.cm_rate_sheets x where x.org_id = t.org_id and x.job_id = t.job_id and x.is_active order by x.created_at desc limit 1;
  for l in select x.* from pm.cm_tm_ticket_lines x where x.org_id = t.org_id and x.ticket_id = t.id loop
    if l.kind = 'LABOR' then
      select e into r from jsonb_array_elements(coalesce(rs.labor_rates, '[]'::jsonb)) e
       where lower(e ->> 'class') = lower(coalesce(l.labor_class, 'default')) limit 1;
      if r is null then select e into r from jsonb_array_elements(coalesce(rs.labor_rates, '[]'::jsonb)) e where lower(e ->> 'class') = 'default' limit 1; end if;
      if r is null then select e into r from jsonb_array_elements(coalesce(rs.labor_rates, '[]'::jsonb)) e limit 1; end if;
      v_labor := v_labor + round(l.hours_st * coalesce((r ->> 'st_cents')::bigint, 0)
                               + l.hours_ot * coalesce((r ->> 'ot_cents')::bigint, round(coalesce((r ->> 'st_cents')::bigint, 0) * 1.5))
                               + l.hours_dt * coalesce((r ->> 'dt_cents')::bigint, coalesce((r ->> 'st_cents')::bigint, 0) * 2))::bigint;
      v_hours := v_hours + l.hours_st + l.hours_ot + l.hours_dt;
      r := null;
    elsif l.kind = 'MATERIAL' then
      v_mat := v_mat + round(coalesce(l.qty, 0) * coalesce(l.unit_cost_cents, 0) * (1 + coalesce(rs.material_markup_pct, 0)))::bigint;
    elsif l.kind = 'EQUIPMENT' then
      select e into r from jsonb_array_elements(coalesce(rs.equipment_rates, '[]'::jsonb)) e where lower(e ->> 'equipment') = lower(l.description) limit 1;
      v_eq := v_eq + round(coalesce(l.equipment_hours, l.qty, 0) * coalesce((r ->> 'hourly_cents')::bigint, coalesce(l.unit_cost_cents, 0))
                           * (1 + coalesce(rs.equipment_markup_pct, 0)))::bigint;
      r := null;
    elsif l.kind = 'SUBCONTRACT' then
      v_sub := v_sub + round(coalesce(l.qty, 1) * coalesce(l.unit_cost_cents, 0) * (1 + coalesce(rs.sub_markup_pct, 0)))::bigint;
    else
      v_other := v_other + round(coalesce(l.qty, 1) * coalesce(l.unit_cost_cents, 0))::bigint;
    end if;
  end loop;
  return jsonb_build_object('rate_sheet_id', rs.id, 'labor_cents', v_labor, 'labor_hours', v_hours, 'material_cents', v_mat,
    'equipment_cents', v_eq, 'subcontract_cents', v_sub, 'other_cents', v_other, 'total_cents', v_labor + v_mat + v_eq + v_sub + v_other);
end $$;

create or replace function pm.cm_tm_price(p_ticket uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  return pm._cm_tm_price(t.id);
end $$;

create or replace function pm.cm_tm_submit(p_ticket uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status not in ('DRAFT','DISPUTED') then raise exception 'PM_TM_STATE: % is %', t.number, t.status using errcode = '22023'; end if;
  if not exists (select 1 from pm.cm_tm_ticket_lines l where l.ticket_id = t.id) then
    raise exception 'PM_TM_EMPTY: add labor, material or equipment to % first', t.number using errcode = '22023';
  end if;
  update pm.cm_tm_tickets set status = 'SUBMITTED' where id = t.id;
  return t.id;
end $$;

-- GC superintendent signs on the device (or remotely through e-sign, then the callback records it).
create or replace function pm.cm_tm_sign(p_ticket uuid, p_signer_name text, p_signer_title text default null, p_signer_company text default null,
                                         p_signature_png text default null, p_method text default 'DEVICE')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status not in ('DRAFT','SUBMITTED','DISPUTED') then raise exception 'PM_TM_STATE: % is %', t.number, t.status using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_signer_name, '')), '') is null then raise exception 'PM_INVALID: the signer''s name is required' using errcode = '22023'; end if;
  if coalesce(p_method, 'DEVICE') = 'DEVICE' and nullif(p_signature_png, '') is null then
    raise exception 'PM_INVALID: capture the signature on the device' using errcode = '22023';
  end if;
  if not exists (select 1 from pm.cm_tm_ticket_lines l where l.ticket_id = t.id) then
    raise exception 'PM_TM_EMPTY: % has nothing to sign for', t.number using errcode = '22023';
  end if;
  update pm.cm_tm_tickets set status = 'SIGNED', signer_name = left(p_signer_name, 120), signer_title = left(p_signer_title, 120),
         signer_company = left(p_signer_company, 120), signature_png = p_signature_png, sign_method = coalesce(p_method, 'DEVICE'), signed_at = now(),
         disputed_reason = null where id = t.id;
  perform pm.log_activity(t.org_id, (select location_id from core.jobs where id = t.job_id), t.job_id, 'tm.signed', 'cm_tm_tickets', t.id,
    format('%s signed by %s', t.number, p_signer_name), jsonb_build_object('method', p_method));
  return t.id;
end $$;

create or replace function pm.cm_tm_dispute(p_ticket uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status not in ('SUBMITTED','SIGNED') then raise exception 'PM_TM_STATE: % is %', t.number, t.status using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: say what is disputed' using errcode = '22023'; end if;
  update pm.cm_tm_tickets set status = 'DISPUTED', disputed_reason = p_reason, disputed_at = now() where id = t.id;
  return t.id;
end $$;

-- Enter once: copy the day's crew time on this job into labor lines (time entries the ticket names).
create or replace function pm.cm_tm_pull_hours(p_ticket uuid, p_employees uuid[] default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype; e record; n int := 0; v_loc uuid; v_sort int;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status not in ('DRAFT','SUBMITTED','DISPUTED') then raise exception 'PM_TM_LOCKED: % is %', t.number, t.status using errcode = '22023'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = t.job_id;
  select coalesce(max(l.sort), 0) into v_sort from pm.cm_tm_ticket_lines l where l.ticket_id = t.id;
  for e in
    select te.id, te.employee_id, te.hours, te.pay_type,
           (select rc.key from pm.employee_rate_cards erc join pm.labor_rate_cards rc on rc.org_id = erc.org_id and rc.id = erc.rate_card_id
             where erc.org_id = te.org_id and erc.employee_id = te.employee_id and erc.location_id = v_loc limit 1) as klass,
           (select concat_ws(' ', em.first_name, em.last_name) from core.employees em where em.id = te.employee_id) as worker
      from pm.time_entries te
     where te.org_id = t.org_id and te.job_id = t.job_id and te.work_date = t.work_date and te.approval_state in ('DRAFT','SUBMITTED','APPROVED')
       and te.pay_type in ('REG','OT','DT')
       and (p_employees is null or te.employee_id = any (p_employees))
       and (p_employees is not null or t.crew_id is null or te.employee_id in (select cm.employee_id from pm.crew_members cm where cm.crew_id = t.crew_id))
       and not exists (select 1 from pm.cm_tm_ticket_lines x where x.org_id = te.org_id and x.time_entry_id = te.id)
     order by te.employee_id, te.pay_type
  loop
    v_sort := v_sort + 1;
    insert into pm.cm_tm_ticket_lines (org_id, job_id, ticket_id, kind, labor_class, employee_id, worker_name, hours_st, hours_ot, hours_dt, description, time_entry_id, sort)
    values (t.org_id, t.job_id, t.id, 'LABOR', coalesce(e.klass, 'default'), e.employee_id, e.worker,
            case when e.pay_type = 'REG' then e.hours else 0 end, case when e.pay_type = 'OT' then e.hours else 0 end,
            case when e.pay_type = 'DT' then e.hours else 0 end, 'Labor', e.id, v_sort);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Signed tickets → one T&M billing request (each ticket billed once; signed tickets are the backup).
create or replace function pm.cm_bill_tm_tickets(p_job uuid, p_tickets uuid[], p_occurred_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_req uuid := gen_random_uuid(); v_contract uuid; v_rate numeric := 0; t record; v_price jsonb; v_amt bigint; v_line uuid; v_sort int := 0;
        v_from date; v_to date;
begin
  select * into j from pm._cm_job(p_job);
  if p_tickets is null or cardinality(p_tickets) = 0 then raise exception 'PM_INVALID: pick signed tickets' using errcode = '22023'; end if;
  if not exists (select 1 from pm.cm_rate_sheets r where r.org_id = j.org_id and r.job_id = p_job and r.is_active) then
    raise exception 'PRECONDITION_NO_RATE_SHEET: set the contract rate sheet for T&M first' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if exists (select 1 from pm.cm_tm_tickets x where x.id = any (p_tickets)
               and (x.org_id <> j.org_id or x.job_id <> p_job or x.status <> 'SIGNED'
                    or exists (select 1 from pm.cm_tm_billing_links k where k.org_id = x.org_id and k.ticket_id = x.id))) then
    raise exception 'PRECONDITION_TM_NOT_BILLABLE: every ticket must be signed, on this job and not billed yet' using errcode = 'P0001';
  end if;
  v_contract := pm.primary_contract_id(j.org_id, p_job);
  if v_contract is not null then select coalesce(k.retention_pct, 0) into v_rate from pm.contracts k where k.id = v_contract; end if;
  select min(x.work_date), max(x.work_date) into v_from, v_to from pm.cm_tm_tickets x where x.id = any (p_tickets);
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, period_start, period_end, occurred_on, memo, created_by)
  values (v_req, j.org_id, p_job, v_contract, 'TIME_MATERIALS', 'DRAFT', 'tm', v_from, v_to, coalesce(p_occurred_on, current_date),
          format('T&M tickets %s – %s (%s signed)', to_char(v_from, 'YYYY-MM-DD'), to_char(v_to, 'YYYY-MM-DD'), cardinality(p_tickets)), pm.current_user_id());
  for t in select x.* from pm.cm_tm_tickets x where x.id = any (p_tickets) order by x.work_date, x.number loop
    v_price := pm._cm_tm_price(t.id);
    v_amt := (v_price ->> 'total_cents')::bigint;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents,
                                          this_period_work_cents, retainage_rate, retainage_this_period_cents)
    values (j.org_id, v_req, v_sort + 1, v_sort, 'STANDARD',
            left(format('T&M %s (%s): %s', t.number, to_char(t.work_date, 'YYYY-MM-DD'), t.description), 500), v_amt, v_amt, v_rate, round(v_amt * v_rate)::bigint)
    returning id into v_line;
    insert into pm.cm_tm_billing_links (org_id, ticket_id, job_id, billing_request_id, billing_request_line_id, amount_cents)
    values (j.org_id, t.id, p_job, v_req, v_line, v_amt);
    update pm.cm_tm_tickets set status = 'BILLED', billed_request_id = v_req where id = t.id;
    v_sort := v_sort + 1;
  end loop;
  perform pm.finalize_billing_retainage(v_req);
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted T&M billing from %s signed ticket(s)', cardinality(p_tickets)), jsonb_build_object('mode', 'TM_TICKETS', 'tickets', to_jsonb(p_tickets)));
  return v_req;
end $$;

-- A ticket priced as a change (ROM at contract rates; work already done = proceeding).
create or replace function pm.cm_tm_to_change_event(p_ticket uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_tm_tickets%rowtype; v_id uuid; v_price jsonb;
begin
  select * into t from pm.cm_tm_tickets where id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.change_event_id is not null then return t.change_event_id; end if;
  v_price := pm._cm_tm_price(t.id);
  insert into pm.cm_change_events (org_id, job_id, title, description, source_type, source_table, source_id, scope, status, proceeding, proceeding_since,
                                   rom_revenue_cents, created_by)
  values (t.org_id, t.job_id, left('T&M ' || coalesce(t.number, '') || ': ' || t.description, 200), t.description, 'TM', 'cm_tm_tickets', t.id, 'OUT', 'OPEN',
          true, t.work_date, nullif((v_price ->> 'total_cents')::bigint, 0), pm.current_user_id())
  returning id into v_id;
  update pm.cm_tm_tickets set change_event_id = v_id where id = t.id;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Monthly EAC by cost code (PM prepares, executive approves) → JOB_PROGRESS
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_eac_forecasts (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                      uuid not null,
  location_id                 uuid not null references core.locations(id),
  period_end                  date not null,
  version                     int not null default 1 check (version >= 1),
  status                      text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','SUPERSEDED')),
  due_on                      date,
  prepared_by                 text,
  submitted_at                timestamptz,
  approved_by                 text,
  approved_at                 timestamptz,
  rejected_reason             text,
  prior_forecast_id           uuid,
  contract_cents              bigint not null default 0,
  total_budget_cents          bigint not null default 0,
  total_committed_cents       bigint not null default 0,
  total_actual_cents          bigint not null default 0,
  total_pending_cents         bigint not null default 0,
  total_ctc_cents             bigint not null default 0,
  total_eac_cents             bigint not null default 0,
  prior_eac_cents             bigint,
  uninstalled_materials_cents bigint not null default 0 check (uninstalled_materials_cents >= 0),
  inefficiency_excluded_cents bigint not null default 0 check (inefficiency_excluded_cents >= 0),
  reason_code                 text check (reason_code is null or reason_code in ('BUYOUT','PRODUCTIVITY','SCOPE_GAP','CO_PENDING','ESCALATION','ERROR','OTHER')),
  commentary                  text,
  loss_flag                   boolean not null default false,
  progress_event_id           uuid,
  snapshot_version            int,
  -- everyone who started, edited or submitted it (security review 2026-10): none of them may approve
  preparers                   text[] not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, period_end, version),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_eac_job_idx on pm.cm_eac_forecasts (org_id, job_id, period_end desc, version desc);

create table if not exists pm.cm_eac_lines (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid,
  forecast_id           uuid not null,
  cost_code_id          uuid,
  cost_code             text,
  cost_code_name        text,
  cost_type             text,
  budget_cents          bigint not null default 0,
  committed_cents       bigint not null default 0,
  committed_open_cents  bigint not null default 0,
  actual_cents          bigint not null default 0,
  pending_cents         bigint not null default 0,
  ctc_cents             bigint not null default 0,
  eac_cents             bigint not null default 0,
  prior_eac_cents       bigint,
  method                text not null default 'MANUAL' check (method in ('MANUAL','BUDGET_REMAINING','COMMITTED','PRODUCTIVITY','BURN_RATE')),
  commentary            text,
  sort                  int not null default 0,
  unique (org_id, id),
  unique nulls not distinct (org_id, forecast_id, cost_code_id),
  foreign key (org_id, forecast_id) references pm.cm_eac_forecasts (org_id, id) on delete cascade deferrable initially immediate
);

alter table pm.cm_eac_forecasts add column if not exists preparers text[] not null default '{}';

create or replace function pm.tg_cm_eac_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if pm.access_member_role() then
    raise exception 'PM_EAC_RPC: forecasts move only through their actions (edit lines while DRAFT)' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create or replace function pm.tg_cm_eac_line_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text;
begin
  if pm.access_member_role() then
    if tg_op <> 'UPDATE' then raise exception 'PM_EAC_LINES: lines come from the cost codes; edit the cost to complete' using errcode = '42501'; end if;
    select f.status into v_status from pm.cm_eac_forecasts f where f.id = new.forecast_id;
    if v_status not in ('DRAFT','REJECTED') then raise exception 'PM_EAC_LOCKED: the forecast is %', v_status using errcode = '42501'; end if;
    if (new.budget_cents, new.committed_cents, new.committed_open_cents, new.actual_cents, new.pending_cents, new.cost_code_id, new.forecast_id)
       is distinct from (old.budget_cents, old.committed_cents, old.committed_open_cents, old.actual_cents, old.pending_cents, old.cost_code_id, old.forecast_id) then
      raise exception 'PM_EAC_LINES: budget, committed and actual come from the ledger' using errcode = '42501';
    end if;
    if new.ctc_cents is distinct from old.ctc_cents and new.method = old.method then new.method := 'MANUAL'; end if;
  end if;
  if tg_op <> 'DELETE' then new.eac_cents := new.actual_cents + new.pending_cents + new.ctc_cents; end if;
  return coalesce(new, old);
end $$;

create or replace function pm.tg_cm_eac_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_f uuid; v_org uuid; v_who text;
begin
  if tg_op = 'DELETE' then v_f := old.forecast_id; v_org := old.org_id; else v_f := new.forecast_id; v_org := new.org_id; end if;
  -- whoever sets a line's cost to complete (RPC or direct edit) is a preparer of the forecast
  v_who := case when tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.ctc_cents is distinct from old.ctc_cents) then pm.current_user_id() end;
  update pm.cm_eac_forecasts f
     set preparers = pm._cm_with(f.preparers, v_who),
         total_budget_cents = t.b, total_committed_cents = t.c, total_actual_cents = t.a, total_pending_cents = t.p,
         total_ctc_cents = t.ctc, total_eac_cents = t.eac, loss_flag = t.eac > f.contract_cents and f.contract_cents > 0
    from (select coalesce(sum(l.budget_cents), 0)::bigint b, coalesce(sum(l.committed_cents), 0)::bigint c, coalesce(sum(l.actual_cents), 0)::bigint a,
                 coalesce(sum(l.pending_cents), 0)::bigint p, coalesce(sum(l.ctc_cents), 0)::bigint ctc, coalesce(sum(l.eac_cents), 0)::bigint eac
            from pm.cm_eac_lines l where l.org_id = v_org and l.forecast_id = v_f) t
   where f.id = v_f;
  return null;
end $$;

create or replace trigger trg_touch_updated_at before update on pm.cm_eac_forecasts for each row execute function pm.tg_touch_updated_at();
create or replace trigger trg_cm_rpc_only before insert or update or delete on pm.cm_eac_forecasts for each row execute function pm.tg_cm_eac_guard();
create or replace trigger trg_cm_child_job before insert or update of forecast_id on pm.cm_eac_lines
  for each row execute function pm.tg_cm_child_job('cm_eac_forecasts', 'forecast_id');
create or replace trigger trg_cm_line_guard before insert or update or delete on pm.cm_eac_lines for each row execute function pm.tg_cm_eac_line_guard();
create or replace trigger trg_cm_totals after insert or update or delete on pm.cm_eac_lines for each row execute function pm.tg_cm_eac_totals();

-- Start (or reopen) the month's forecast, prefilled per cost code (FIN-34): cost to complete =
-- max(budget remaining, committed open); labor codes with field quantities project from % complete.
create or replace function pm.cm_start_eac(p_job uuid, p_period_end date)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; v_prior pm.cm_eac_forecasts%rowtype; v_ver int; v_contract bigint; l record; v_ctc bigint; v_method text;
        v_pct numeric; v_sort int := 0; v_open pm.cm_eac_forecasts%rowtype;
begin
  select * into j from pm._cm_job(p_job);
  if p_period_end is null then raise exception 'PM_INVALID: period_end is required' using errcode = '22023'; end if;
  select * into v_open from pm.cm_eac_forecasts f where f.org_id = j.org_id and f.job_id = p_job and f.period_end = p_period_end
     and f.status in ('DRAFT','SUBMITTED','REJECTED') order by f.version desc limit 1;
  if v_open.id is not null then return v_open.id; end if;
  select * into v_prior from pm.cm_eac_forecasts f where f.org_id = j.org_id and f.job_id = p_job and f.status = 'APPROVED' and f.period_end <= p_period_end
   order by f.period_end desc, f.version desc limit 1;
  select coalesce(max(f.version), 0) + 1 into v_ver from pm.cm_eac_forecasts f where f.org_id = j.org_id and f.job_id = p_job and f.period_end = p_period_end;
  select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = j.org_id and m.job_id = p_job;
  insert into pm.cm_eac_forecasts (org_id, job_id, location_id, period_end, version, status, due_on, prepared_by, prior_forecast_id, contract_cents, prior_eac_cents, preparers)
  values (j.org_id, p_job, j.location_id, p_period_end, v_ver, 'DRAFT', p_period_end + 5, pm.current_user_id(), v_prior.id, coalesce(v_contract, 0),
          coalesce(v_prior.total_eac_cents, (select x.projected_final_cost_cents from pm.v_job_financials x where x.job_id = p_job)),
          pm._cm_with('{}'::text[], pm.current_user_id()))
  returning id into v_id;
  for l in select s.* from pm.v_cost_code_status s where s.org_id = j.org_id and s.job_id = p_job order by s.cost_code nulls last loop
    v_ctc := greatest(l.budget_cents - l.actual_cents - l.pending_cents, l.committed_open_cents, 0);
    v_method := case when l.committed_open_cents > l.budget_cents - l.actual_cents - l.pending_cents then 'COMMITTED' else 'BUDGET_REMAINING' end;
    if l.cost_type = 'LABOR' and l.cost_code_id is not null then
      select p.pct_complete into v_pct from pm._cm_productivity(j.org_id, p_job, current_date) p where p.cost_code_id = l.cost_code_id;
      if v_pct is not null and v_pct > 0.05 and v_pct < 1 and l.actual_cents > 0 then
        v_ctc := greatest(round(l.actual_cents * (1 - v_pct) / v_pct)::bigint - l.pending_cents, 0);
        v_method := 'PRODUCTIVITY';
      elsif v_pct >= 1 then
        v_ctc := 0; v_method := 'PRODUCTIVITY';
      end if;
      v_pct := null;
    end if;
    insert into pm.cm_eac_lines (org_id, job_id, forecast_id, cost_code_id, cost_code, cost_code_name, cost_type, budget_cents, committed_cents,
                                 committed_open_cents, actual_cents, pending_cents, ctc_cents, prior_eac_cents, method, sort)
    values (j.org_id, p_job, v_id, l.cost_code_id, l.cost_code, l.cost_code_name, l.cost_type, l.budget_cents, l.committed_cents, l.committed_open_cents,
            l.actual_cents, l.pending_cents, v_ctc,
            (select pl.eac_cents from pm.cm_eac_lines pl where pl.forecast_id = v_prior.id and pl.cost_code_id is not distinct from l.cost_code_id),
            v_method, v_sort);
    v_sort := v_sort + 1;
  end loop;
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'eac.started', 'cm_eac_forecasts', v_id,
    format('Cost forecast started for %s', to_char(p_period_end, 'YYYY-MM')), jsonb_build_object('version', v_ver));
  return v_id;
end $$;

create or replace function pm.cm_set_eac_line(p_line uuid, p_ctc_cents bigint, p_commentary text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.cm_eac_lines%rowtype; v_status text;
begin
  select * into l from pm.cm_eac_lines where id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: forecast line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select f.status into v_status from pm.cm_eac_forecasts f where f.id = l.forecast_id;
  if v_status not in ('DRAFT','REJECTED') then raise exception 'PM_EAC_LOCKED: the forecast is %', v_status using errcode = '22023'; end if;
  if p_ctc_cents is null or p_ctc_cents < 0 then raise exception 'PM_INVALID: cost to complete must be ≥ 0' using errcode = '22023'; end if;
  update pm.cm_eac_lines set ctc_cents = p_ctc_cents, method = 'MANUAL', commentary = coalesce(p_commentary, commentary) where id = l.id;
  return l.id;
end $$;

create or replace function pm.cm_submit_eac(p_forecast uuid, p_reason_code text default null, p_commentary text default null,
                                            p_uninstalled_cents bigint default null, p_inefficiency_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.cm_eac_forecasts%rowtype; s pm.cm_contract_settings%rowtype; v_delta bigint; v_need boolean;
begin
  select * into f from pm.cm_eac_forecasts where id = p_forecast for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: forecast % not found in the caller''s organization', p_forecast using errcode = '42501';
  end if;
  if f.status not in ('DRAFT','REJECTED') then raise exception 'PM_EAC_STATE: forecast is %', f.status using errcode = '22023'; end if;
  select * into s from pm.cm_contract_settings where org_id = f.org_id and job_id = f.job_id;
  v_delta := abs(f.total_eac_cents - coalesce(f.prior_eac_cents, f.total_eac_cents));
  v_need := v_delta > greatest(coalesce(s.eac_commentary_cents, 1000000), round(coalesce(f.prior_eac_cents, 0) * coalesce(s.eac_commentary_pct, 0.02))::bigint);
  if v_need and (nullif(btrim(coalesce(p_commentary, f.commentary, '')), '') is null or coalesce(p_reason_code, f.reason_code) is null) then
    raise exception 'PM_EAC_COMMENTARY: the forecast moved % cents since last month — give a reason code and commentary', v_delta using errcode = '22023';
  end if;
  update pm.cm_eac_forecasts set status = 'SUBMITTED', submitted_at = now(), prepared_by = coalesce(pm.current_user_id(), prepared_by),
         preparers = pm._cm_with(preparers, pm.current_user_id()),
         reason_code = coalesce(p_reason_code, reason_code), commentary = coalesce(p_commentary, commentary),
         uninstalled_materials_cents = coalesce(p_uninstalled_cents, uninstalled_materials_cents),
         inefficiency_excluded_cents = coalesce(p_inefficiency_cents, inefficiency_excluded_cents), rejected_reason = null
   where id = f.id;
  perform pm._cm_notify(f.org_id, 'eac.submitted', f.job_id, 'cm_eac_forecasts', f.id,
    pm._cm_members_with(f.org_id, f.location_id, 'projects.financials', 'edit'),
    format('Cost forecast for %s to approve', to_char(f.period_end, 'YYYY-MM')), coalesce(p_commentary, f.commentary),
    '/wip?tab=eac&item=' || f.id, 'eac:' || f.id);
  return f.id;
end $$;

-- JOB_PROGRESS from an approved EAC: the frozen key set of pm.emit_job_progress with the approved
-- EAC as cost_estimate_cents, plus additive approval / commentary keys (FIN-37, FIN-38, FIN-42/43).
create or replace function pm._cm_emit_eac_progress(p_forecast uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.cm_eac_forecasts%rowtype; v_proj pm.projects%rowtype; m pm.v_job_money%rowtype; v_basis text; v_pct numeric(5,4); v_ver int;
        v_reason text; v_event uuid; v_payload jsonb; v_srcref text; v_by_type jsonb;
begin
  select * into f from pm.cm_eac_forecasts where id = p_forecast;
  select * into v_proj from pm.projects p where p.org_id = f.org_id and p.job_id = f.job_id for update;
  select * into m from pm.v_job_money x where x.org_id = f.org_id and x.job_id = f.job_id;
  if v_proj.job_id is null or coalesce(m.active_contract_count, 0) = 0 then return null; end if;
  select k.progress_basis into v_basis from pm.contracts k where k.org_id = f.org_id and k.job_id = f.job_id and k.status = 'ACTIVE'
   order by (k.kind = 'PRIME') desc, k.created_at, k.id limit 1;
  if v_basis in ('PHYSICAL_PCT','UNITS') then
    select max(k.pct_complete) into v_pct from pm.contracts k where k.org_id = f.org_id and k.job_id = f.job_id and k.status = 'ACTIVE';
  end if;
  select coalesce(max(s.snapshot_version), 0) + 1 into v_ver from pm.progress_snapshots s where s.org_id = f.org_id and s.job_id = f.job_id;
  v_reason := case when v_proj.is_sample then 'SAMPLE' when not pm.books_present(f.org_id) then 'STANDALONE' end;
  v_srcref := 'pm:progress:' || f.job_id::text || ':v' || v_ver;
  select coalesce(jsonb_object_agg(t.cost_type, t.eac), '{}'::jsonb) into v_by_type
    from (select coalesce(l.cost_type, 'OTHER') as cost_type, sum(l.eac_cents)::bigint as eac from pm.cm_eac_lines l where l.forecast_id = f.id group by 1) t;
  if v_reason is null then
    v_event := gen_random_uuid();
    v_payload := jsonb_build_object(
      'event_id', v_event, 'event_type', 'JOB_PROGRESS', 'source_module', 'PROJECTS', 'org_id', f.org_id, 'location_id', f.location_id,
      'job_id', f.job_id, 'trigger', 'PROGRESS_UPDATE', 'contract_value_cents', m.revised_contract_cents, 'cost_estimate_cents', f.total_eac_cents,
      'pct_complete', v_pct, 'occurred_on', to_char(f.period_end, 'YYYY-MM-DD'), 'source_ref', v_srcref,
      'memo', format('Merit Projects approved EAC %s v%s (snapshot v%s)', to_char(f.period_end, 'YYYY-MM'), f.version, v_ver),
      'as_of_date', to_char(f.period_end, 'YYYY-MM-DD'), 'snapshot_version', v_ver, 'pending_co_value_cents', m.pending_co_cents, 'schema_version', 2,
      'prepared_by', f.prepared_by, 'approved_by', f.approved_by, 'approved_at', f.approved_at, 'eac_commentary', f.commentary,
      'eac_reason_code', f.reason_code, 'uninstalled_materials_cents', f.uninstalled_materials_cents,
      'inefficiency_excluded_cents', f.inefficiency_excluded_cents, 'eac_by_cost_type', v_by_type, 'eac_forecast_id', f.id);
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (f.org_id, v_event, 'JOB_PROGRESS', 'PROJECTS', v_payload, f.period_end, 'pending');
  end if;
  insert into pm.progress_snapshots (org_id, job_id, snapshot_version, as_of_date, trigger_name, progress_basis, original_contract_cents,
    approved_co_cents, contract_value_cents, cost_estimate_cents, pct_complete, pending_co_value_cents, emitted, suppressed_reason, event_id, payload, created_by)
  values (f.org_id, f.job_id, v_ver, f.period_end, 'PROGRESS_UPDATE', coalesce(v_basis, 'NONE'), m.original_contract_cents, m.approved_co_cents,
    m.revised_contract_cents, f.total_eac_cents, v_pct, m.pending_co_cents, v_reason is null, v_reason, v_event, v_payload, f.approved_by);
  update pm.cm_eac_forecasts set progress_event_id = v_event, snapshot_version = v_ver where id = f.id;
  return v_event;
end $$;

-- Executive (PX) approval; preparer ≠ approver. Approving pins the month's EAC and sends it to Books.
-- pm.emit_job_progress (1100) re-created here so every later JOB_PROGRESS (contract set, change
-- order, budget revision) carries the latest APPROVED monthly forecast as cost_estimate_cents
-- instead of the budget-based estimate, which would silently undo the PM/executive EAC in Books.
-- Same signature, same frozen v3 keys; additive key cost_estimate_source = APPROVED_EAC | BUDGET.
-- The 1110 capability guard is re-injected by pm.access_apply_rpc_guards() at the end of 1120.
create or replace function pm.emit_job_progress(p_job uuid, p_trigger text, p_as_of date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org     uuid;
  v_loc     uuid;
  v_proj    pm.projects%rowtype;
  m         pm.v_job_money%rowtype;
  v_basis   text;
  v_pct     numeric(5,4);
  v_ver     int;
  v_asof    date := coalesce(p_as_of, current_date);
  v_event   uuid;
  v_books   boolean;
  v_reason  text;
  v_srcref  text;
  v_payload jsonb;
  v_eac     bigint;
  v_cost    bigint;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_trigger is null or p_trigger not in ('CONTRACT_SET','CHANGE_ORDER','PROGRESS_UPDATE','BUDGET_REVISED') then
    raise exception 'Invalid JOB_PROGRESS trigger: %', p_trigger using errcode = '22023';
  end if;

  select * into v_proj from pm.projects p where p.org_id = v_org and p.job_id = p_job for update;
  if not found then raise exception 'PM_NOT_A_PROJECT: job % has no pm.projects row', p_job using errcode = 'P0002'; end if;

  select * into m from pm.v_job_money x where x.org_id = v_org and x.job_id = p_job;
  if coalesce(m.active_contract_count, 0) = 0 then
    raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract; set the contract before emitting progress', p_job
      using errcode = 'P0001';
  end if;

  select k.progress_basis into v_basis from pm.contracts k
  where k.org_id = v_org and k.job_id = p_job and k.status = 'ACTIVE'
  order by (k.kind = 'PRIME') desc, k.created_at, k.id limit 1;

  v_pct := case
    when v_basis in ('PHYSICAL_PCT','UNITS') then
      (select case when sum(k.original_cents) filter (where k.pct_complete is not null) > 0
                   then round(sum(k.original_cents * k.pct_complete) filter (where k.pct_complete is not null)
                              / sum(k.original_cents) filter (where k.pct_complete is not null), 4)
                   else max(k.pct_complete) end
       from pm.contracts k where k.org_id = v_org and k.job_id = p_job and k.status = 'ACTIVE')
    when v_basis = 'MILESTONES' then
      (select case when count(*) > 0 then round(count(*) filter (where t.status = 'DONE')::numeric / count(*), 4) end
       from pm.tasks t where t.org_id = v_org and t.job_id = p_job and t.is_milestone and t.status <> 'CANCELLED')
    else null end;

  -- the latest approved monthly forecast wins over the budget-based estimate
  select f.total_eac_cents into v_eac from pm.cm_eac_forecasts f
   where f.org_id = v_org and f.job_id = p_job and f.status = 'APPROVED'
   order by f.period_end desc, f.approved_at desc nulls last limit 1;
  v_cost := coalesce(v_eac, m.cost_estimate_cents);

  select coalesce(max(s.snapshot_version), 0) + 1 into v_ver
  from pm.progress_snapshots s where s.org_id = v_org and s.job_id = p_job;

  v_books := pm.books_present(v_org);
  v_reason := case when v_proj.is_sample then 'SAMPLE' when not v_books then 'STANDALONE' end;
  v_srcref := 'pm:progress:' || p_job::text || ':v' || v_ver;

  if v_reason is null then
    v_event := gen_random_uuid();
    v_payload := jsonb_build_object(
      'event_id',               v_event,
      'event_type',             'JOB_PROGRESS',
      'source_module',          'PROJECTS',
      'org_id',                 v_org,
      'location_id',            v_loc,
      'job_id',                 p_job,
      'trigger',                p_trigger,
      'contract_value_cents',   m.revised_contract_cents,
      'cost_estimate_cents',    v_cost,
      'pct_complete',           v_pct,
      'occurred_on',            to_char(v_asof, 'YYYY-MM-DD'),
      'source_ref',             v_srcref,
      'memo',                   format('Merit Projects snapshot v%s (%s)', v_ver, p_trigger),
      'as_of_date',             to_char(v_asof, 'YYYY-MM-DD'),
      'snapshot_version',       v_ver,
      'pending_co_value_cents', m.pending_co_cents,
      'schema_version',         2,
      'cost_estimate_source',   case when v_eac is not null then 'APPROVED_EAC' else 'BUDGET' end
    );
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (v_org, v_event, 'JOB_PROGRESS', 'PROJECTS', v_payload, v_asof, 'pending');
  end if;

  insert into pm.progress_snapshots
    (org_id, job_id, snapshot_version, as_of_date, trigger_name, progress_basis, original_contract_cents,
     approved_co_cents, contract_value_cents, cost_estimate_cents, pct_complete, pending_co_value_cents,
     emitted, suppressed_reason, event_id, payload, created_by)
  values (v_org, p_job, v_ver, v_asof, p_trigger, coalesce(v_basis, 'NONE'), m.original_contract_cents,
     m.approved_co_cents, m.revised_contract_cents, v_cost, v_pct, m.pending_co_cents,
     v_reason is null, v_reason, v_event, v_payload, pm.current_user_id());

  perform pm.log_activity(v_org, v_loc, p_job, 'progress.snapshot', 'progress_snapshots', null,
    format('Progress snapshot v%s (%s)%s', v_ver, p_trigger,
           case when v_reason is null then ' sent to Books' else ' recorded (' || lower(v_reason) || ')' end),
    jsonb_build_object('snapshot_version', v_ver, 'event_id', v_event, 'as_of_date', v_asof,
                       'contract_value_cents', m.revised_contract_cents, 'cost_estimate_cents', v_cost));
  return v_event;
end $$;

create or replace function pm.cm_decide_eac(p_forecast uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.cm_eac_forecasts%rowtype; v_me text := pm.current_user_id(); v_event uuid;
begin
  select * into f from pm.cm_eac_forecasts where id = p_forecast for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: forecast % not found in the caller''s organization', p_forecast using errcode = '42501';
  end if;
  if f.status <> 'SUBMITTED' then raise exception 'PM_EAC_STATE: forecast is %', f.status using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  if not pm._cm_is_executive(f.location_id) then
    raise exception 'PM_FORBIDDEN: a project executive (general manager or owner) approves the cost forecast' using errcode = '42501';
  end if;
  if not coalesce(p_approve, false) then
    if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'PM_INVALID: say what to fix' using errcode = '22023'; end if;
    update pm.cm_eac_forecasts set status = 'REJECTED', rejected_reason = p_note where id = f.id;
    return jsonb_build_object('status', 'REJECTED');
  end if;
  if v_me = f.prepared_by or v_me = any (f.preparers) then
    raise exception 'PM_SOD_VIOLATION: you prepared or edited this forecast, so another executive approves it' using errcode = '42501';
  end if;
  update pm.cm_eac_forecasts set status = 'SUPERSEDED' where org_id = f.org_id and job_id = f.job_id and period_end = f.period_end and status = 'APPROVED' and id <> f.id;
  update pm.cm_eac_forecasts set status = 'APPROVED', approved_by = v_me, approved_at = now() where id = f.id;
  v_event := pm._cm_emit_eac_progress(f.id);
  perform pm.log_activity(f.org_id, f.location_id, f.job_id, 'eac.approved', 'cm_eac_forecasts', f.id,
    format('Cost forecast %s approved (%s cents)%s', to_char(f.period_end, 'YYYY-MM'), f.total_eac_cents, case when f.loss_flag then ' — LOSS JOB' end),
    jsonb_build_object('event_id', v_event, 'loss', f.loss_flag));
  return jsonb_build_object('status', 'APPROVED', 'event_id', v_event, 'loss', f.loss_flag);
end $$;

-- ----------------------------------------------------------------------------
-- 8. WIP schedule (CFMA) — Books' POSTED run first, else the live Projects computation; pinned at close
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_wip_snapshots (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references core.organizations(id) on delete cascade,
  location_id                 uuid not null references core.locations(id),
  job_id                      uuid not null,
  period_end                  date not null,
  revision                    int not null default 1,
  source                      text not null check (source in ('BOOKS_PINNED','PROJECTS')),
  status                      text not null default 'PINNED' check (status in ('PINNED','SUPERSEDED')),
  contract_original_cents     bigint not null default 0,
  approved_co_cents           bigint not null default 0,
  contract_cents              bigint not null default 0,
  eac_cents                   bigint not null default 0,
  cost_to_date_cents          bigint not null default 0,
  uninstalled_materials_cents bigint not null default 0,
  pct_complete                numeric(9,6) not null default 0,
  earned_cents                bigint not null default 0,
  billed_cents                bigint not null default 0,
  over_billed_cents           bigint not null default 0,
  under_billed_cents          bigint not null default 0,
  gp_cents                    bigint not null default 0,
  gp_pct                      numeric(9,6),
  prior_gp_pct                numeric(9,6),
  bid_gp_pct                  numeric(9,6),
  fade_gain_pts               numeric(9,4),
  backlog_cents               bigint not null default 0,
  loss_provision_cents        bigint not null default 0,
  pending_co_cents            bigint not null default 0,
  eac_forecast_id             uuid,
  books_run_id                uuid,
  pinned_by                   text,
  pinned_at                   timestamptz not null default now(),
  unique (org_id, job_id, period_end, revision),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_wip_loc_idx on pm.cm_wip_snapshots (org_id, location_id, period_end, status);

create or replace function pm.tg_cm_immutable() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if pm.access_member_role() then raise exception 'PM_IMMUTABLE: % rows are written by the system only', tg_table_name using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and tg_table_name = 'cm_wip_snapshots' and (new.contract_cents, new.eac_cents, new.cost_to_date_cents, new.earned_cents, new.billed_cents)
     is distinct from (old.contract_cents, old.eac_cents, old.cost_to_date_cents, old.earned_cents, old.billed_cents) then
    raise exception 'PM_IMMUTABLE: a pinned WIP row re-prints identically; pin a new revision instead' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create or replace trigger trg_cm_immutable before insert or update or delete on pm.cm_wip_snapshots for each row execute function pm.tg_cm_immutable();

create or replace function pm._cm_wip_rows(p_org uuid, p_location uuid, p_period_end date)
returns table (
  job_id uuid, job_number text, job_name text, source text, contract_original_cents bigint, approved_co_cents bigint, contract_cents bigint,
  eac_cents bigint, cost_to_date_cents bigint, uninstalled_materials_cents bigint, pct_complete numeric, earned_cents bigint, billed_cents bigint,
  over_billed_cents bigint, under_billed_cents bigint, gp_cents bigint, gp_pct numeric, prior_gp_pct numeric, bid_gp_pct numeric,
  fade_gain_pts numeric, backlog_cents bigint, loss_provision_cents bigint, pending_co_cents bigint, eac_forecast_id uuid, eac_status text,
  books_run_id uuid, pinned boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_run uuid; j record; m pm.v_job_money%rowtype; f pm.cm_eac_forecasts%rowtype; b record; v_ctd bigint; v_unins bigint; v_eac bigint;
        v_pct numeric; v_earned bigint; v_billed bigint; v_gp bigint; v_prior numeric; v_bid numeric; v_loss bigint; v_orig_budget bigint; e record;
        v_has boolean; v_n int;
begin
  if to_regclass('public.rev_rec_wip_runs') is not null then
    execute $q$select r.id from public.rev_rec_wip_runs r where r.org_id = $1 and r.location_id = $2 and r.as_of_date = $3 and r.status = 'POSTED'
               order by r.revision desc limit 1$q$ into v_run using p_org, p_location, p_period_end;
  end if;
  for j in
    select p.job_id, cj.job_number, cj.name from pm.projects p join core.jobs cj on cj.org_id = p.org_id and cj.id = p.job_id
     where p.org_id = p_org and p.location_id = p_location and not p.is_sample
       and exists (select 1 from pm.contracts k where k.org_id = p.org_id and k.job_id = p.job_id and k.status in ('ACTIVE','CLOSED'))
     order by cj.job_number
  loop
    select * into m from pm.v_job_money x where x.org_id = p_org and x.job_id = j.job_id;
    select * into f from pm.cm_eac_forecasts x where x.org_id = p_org and x.job_id = j.job_id and x.period_end <= p_period_end and x.status = 'APPROVED'
     order by x.period_end desc, x.version desc limit 1;
    select x.status into eac_status from pm.cm_eac_forecasts x where x.org_id = p_org and x.job_id = j.job_id and x.period_end = p_period_end
     order by x.version desc limit 1;
    select (s.gp_pct) into v_prior from pm.cm_wip_snapshots s where s.org_id = p_org and s.job_id = j.job_id and s.status = 'PINNED' and s.period_end < p_period_end
     order by s.period_end desc, s.revision desc limit 1;
    select e2.* into e from pm.estimates e2 where e2.org_id = p_org and e2.job_id = j.job_id and e2.status = 'ACCEPTED' order by e2.accepted_at desc limit 1;
    select (select coalesce(sum(l.amount_cents), 0) from pm.budget_lines l where l.org_id = bo.org_id and l.budget_id = bo.id) into v_orig_budget
      from pm.budgets bo where bo.org_id = p_org and bo.job_id = j.job_id and bo.kind = 'ORIGINAL' order by bo.version limit 1;
    v_bid := case when e.id is not null and e.total_cents > 0 then round((e.total_cents - e.cost_total_cents)::numeric / e.total_cents, 6)
                  when m.original_contract_cents > 0 and v_orig_budget is not null then round((m.original_contract_cents - v_orig_budget)::numeric / m.original_contract_cents, 6) end;
    v_has := false;
    if v_run is not null then
      execute $q$select l.contract_cents, l.eac_cents, l.cost_to_date_cents, l.pct_complete, l.earned_cents, l.billed_cents, l.under_cents, l.over_cents,
                        l.loss_provision_cents, l.est_gross_profit_cents, l.prior_est_gross_profit_cents
                   from public.rev_rec_wip_run_lines l where l.run_id = $1 and l.job_id = $2 limit 1$q$ into b using v_run, j.job_id;
      get diagnostics v_n = row_count;
      v_has := v_n > 0;
    end if;
    job_id := j.job_id; job_number := j.job_number; job_name := j.name;
    contract_original_cents := m.original_contract_cents; approved_co_cents := m.approved_co_cents; pending_co_cents := m.pending_co_cents;
    eac_forecast_id := f.id; bid_gp_pct := v_bid; pinned := false;
    if v_has then
      source := 'BOOKS_PINNED'; books_run_id := v_run;
      contract_cents := b.contract_cents; eac_cents := b.eac_cents; cost_to_date_cents := b.cost_to_date_cents; uninstalled_materials_cents := 0;
      pct_complete := b.pct_complete; earned_cents := b.earned_cents; billed_cents := b.billed_cents;
      over_billed_cents := b.over_cents; under_billed_cents := b.under_cents; loss_provision_cents := b.loss_provision_cents;
      gp_cents := b.est_gross_profit_cents;
      gp_pct := case when b.contract_cents > 0 then round(b.est_gross_profit_cents::numeric / b.contract_cents, 6) end;
      prior_gp_pct := coalesce(v_prior, case when b.prior_est_gross_profit_cents is not null and b.contract_cents > 0
                                             then round(b.prior_est_gross_profit_cents::numeric / b.contract_cents, 6) end);
    else
      source := 'PROJECTS'; books_run_id := null;
      select coalesce(sum(c.amount_cents), 0) into v_ctd from pm.job_costs c
       where c.org_id = p_org and c.job_id = j.job_id and c.lifecycle = 'CLEARED' and (c.occurred_on is null or c.occurred_on <= p_period_end);
      v_unins := coalesce(f.uninstalled_materials_cents, 0) + coalesce(f.inefficiency_excluded_cents, 0);
      v_eac := coalesce(f.total_eac_cents, (select x.projected_final_cost_cents from pm.v_job_financials x where x.job_id = j.job_id), 0);
      v_pct := case when v_eac > 0 then least(greatest(v_ctd - v_unins, 0)::numeric / v_eac, 1) else 0 end;
      v_earned := round(m.revised_contract_cents * v_pct)::bigint;
      select coalesce(sum(r.gross_earned_cents), 0) into v_billed from pm.billing_requests r
       where r.org_id = p_org and r.job_id = j.job_id and r.status in ('EMITTED','ISSUED','UNISSUED')
         and r.billing_subtype is distinct from 'RETAINAGE_RELEASE' and r.occurred_on <= p_period_end;
      v_gp := m.revised_contract_cents - v_eac;
      v_loss := case when v_gp < 0 then round(-v_gp * (1 - v_pct))::bigint else 0 end;
      contract_cents := m.revised_contract_cents; eac_cents := v_eac; cost_to_date_cents := v_ctd; uninstalled_materials_cents := v_unins;
      pct_complete := round(v_pct, 6); earned_cents := v_earned; billed_cents := v_billed;
      over_billed_cents := greatest(v_billed - v_earned, 0); under_billed_cents := greatest(v_earned - v_billed, 0);
      gp_cents := v_gp; gp_pct := case when m.revised_contract_cents > 0 then round(v_gp::numeric / m.revised_contract_cents, 6) end;
      loss_provision_cents := v_loss; prior_gp_pct := v_prior;
    end if;
    fade_gain_pts := case when gp_pct is not null and prior_gp_pct is not null then round((gp_pct - prior_gp_pct) * 100, 4) end;
    backlog_cents := greatest(contract_cents - earned_cents, 0);
    pinned := exists (select 1 from pm.cm_wip_snapshots s where s.org_id = p_org and s.job_id = j.job_id and s.period_end = p_period_end and s.status = 'PINNED');
    return next;
  end loop;
end $$;

-- Member read (financials:view at the company — guarded). Books' figures are read on the definer
-- path (Projects-only seats cannot read Books tables directly).
create or replace function pm.cm_wip_schedule(p_location uuid, p_period_end date)
returns table (
  job_id uuid, job_number text, job_name text, source text, contract_original_cents bigint, approved_co_cents bigint, contract_cents bigint,
  eac_cents bigint, cost_to_date_cents bigint, uninstalled_materials_cents bigint, pct_complete numeric, earned_cents bigint, billed_cents bigint,
  over_billed_cents bigint, under_billed_cents bigint, gp_cents bigint, gp_pct numeric, prior_gp_pct numeric, bid_gp_pct numeric,
  fade_gain_pts numeric, backlog_cents bigint, loss_provision_cents bigint, pending_co_cents bigint, eac_forecast_id uuid, eac_status text,
  books_run_id uuid, pinned boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  return query select * from pm._cm_wip_rows(v_org, p_location, p_period_end) w
                where pm.access_is_service() or w.job_id in (select pm.my_money_job_ids('projects.financials'));
end $$;

-- Pin the month's WIP (re-prints identically afterwards; a re-pin is a new revision).
create or replace function pm.cm_pin_wip(p_location uuid, p_period_end date)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; n int := 0; w record; v_rev int;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  for w in select * from pm._cm_wip_rows(v_org, p_location, p_period_end) loop
    select coalesce(max(s.revision), 0) + 1 into v_rev from pm.cm_wip_snapshots s where s.org_id = v_org and s.job_id = w.job_id and s.period_end = p_period_end;
    update pm.cm_wip_snapshots set status = 'SUPERSEDED' where org_id = v_org and job_id = w.job_id and period_end = p_period_end and status = 'PINNED';
    insert into pm.cm_wip_snapshots (org_id, location_id, job_id, period_end, revision, source, status, contract_original_cents, approved_co_cents,
      contract_cents, eac_cents, cost_to_date_cents, uninstalled_materials_cents, pct_complete, earned_cents, billed_cents, over_billed_cents,
      under_billed_cents, gp_cents, gp_pct, prior_gp_pct, bid_gp_pct, fade_gain_pts, backlog_cents, loss_provision_cents, pending_co_cents,
      eac_forecast_id, books_run_id, pinned_by)
    values (v_org, p_location, w.job_id, p_period_end, v_rev, w.source, 'PINNED', w.contract_original_cents, w.approved_co_cents, w.contract_cents,
      w.eac_cents, w.cost_to_date_cents, w.uninstalled_materials_cents, w.pct_complete, w.earned_cents, w.billed_cents, w.over_billed_cents,
      w.under_billed_cents, w.gp_cents, w.gp_pct, w.prior_gp_pct, w.bid_gp_pct, w.fade_gain_pts, w.backlog_cents, w.loss_provision_cents,
      w.pending_co_cents, w.eac_forecast_id, w.books_run_id, pm.current_user_id());
    n := n + 1;
  end loop;
  perform pm.log_activity(v_org, p_location, null, 'wip.pinned', 'cm_wip_snapshots', null,
    format('WIP pinned for %s (%s jobs)', to_char(p_period_end, 'YYYY-MM'), n), jsonb_build_object('period_end', p_period_end));
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Buyout log, monthly project review package, job cost drill-down
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_buyout_packages (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  name              text not null check (char_length(name) between 1 and 120),
  csi_division      text,
  cost_code_ids     uuid[] not null default '{}',
  budget_override_cents bigint,
  commitment_ids    uuid[] not null default '{}',
  status            text not null default 'OPEN' check (status in ('OPEN','BIDDING','AWARDED','NOT_NEEDED')),
  need_by           date,
  schedule_task_id  uuid,
  lead_time_days    int not null default 30 check (lead_time_days >= 0),
  notes             text,
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, name),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create or replace trigger trg_touch_updated_at before update on pm.cm_buyout_packages for each row execute function pm.tg_touch_updated_at();

-- One package per CSI division of the budget's cost codes (first two digits of the code).
create or replace function pm.cm_seed_buyout(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; d record; n int := 0;
begin
  select * into j from pm._cm_job(p_job);
  for d in
    select left(regexp_replace(cc.code, '[^0-9]', '', 'g'), 2) as div, array_agg(distinct b.cost_code_id) as ccs, min(cc.name) as nm
      from pm.v_job_current_budget_lines b join pm.cost_codes cc on cc.id = b.cost_code_id
     where b.org_id = j.org_id and b.job_id = p_job and b.cost_code_id is not null
     group by 1 having left(regexp_replace(min(cc.code), '[^0-9]', '', 'g'), 2) <> ''
  loop
    insert into pm.cm_buyout_packages (org_id, job_id, name, csi_division, cost_code_ids, sort)
    values (j.org_id, p_job, 'Division ' || d.div || coalesce(' — ' || d.nm, ''), d.div, d.ccs, coalesce(nullif(d.div, '')::int, 99))
    on conflict (org_id, job_id, name) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create table if not exists pm.cm_review_packages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  location_id     uuid not null references core.locations(id),
  period_end      date not null,
  status          text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','SIGNED')),
  content         jsonb not null default '{}',
  pm_commentary   text,
  built_by        text,
  built_at        timestamptz,
  submitted_by    text,
  submitted_at    timestamptz,
  signed_by       text,
  signed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, period_end),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create or replace trigger trg_touch_updated_at before update on pm.cm_review_packages for each row execute function pm.tg_touch_updated_at();
create or replace trigger trg_cm_rpc_only before insert or update or delete on pm.cm_review_packages for each row execute function pm.tg_cm_eac_guard();

-- Build / rebuild the month's review package (CGC-111): job cost, EAC + commentary, CO log,
-- exposure, buyout, billing, retainage, schedule, document control and safety counts.
create or replace function pm.cm_build_review_package(p_job uuid, p_period_end date, p_commentary text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; v_content jsonb; v_status text;
begin
  select * into j from pm._cm_job(p_job);
  select r.status into v_status from pm.cm_review_packages r where r.org_id = j.org_id and r.job_id = p_job and r.period_end = p_period_end;
  if v_status = 'SIGNED' then raise exception 'PM_REVIEW_SIGNED: the % package is signed off' , to_char(p_period_end, 'YYYY-MM') using errcode = '22023'; end if;
  v_content := jsonb_build_object(
    'financials', (select to_jsonb(x) from pm.v_job_financials x where x.job_id = p_job),
    'cost_codes', coalesce((select jsonb_agg(to_jsonb(s) order by s.cost_code) from pm.v_cost_code_status s where s.org_id = j.org_id and s.job_id = p_job), '[]'::jsonb),
    'eac', (select jsonb_build_object('id', f.id, 'period_end', f.period_end, 'status', f.status, 'total_eac_cents', f.total_eac_cents,
                                      'prior_eac_cents', f.prior_eac_cents, 'commentary', f.commentary, 'reason_code', f.reason_code, 'loss', f.loss_flag)
              from pm.cm_eac_forecasts f where f.org_id = j.org_id and f.job_id = p_job and f.period_end <= p_period_end order by f.period_end desc, f.version desc limit 1),
    'change_orders', coalesce((select jsonb_agg(jsonb_build_object('number', c.number, 'title', c.title, 'stage', c.stage, 'amount_cents', c.amount_cents,
                                      'cost_impact_cents', c.cost_impact_cents, 'approved_at', c.approved_at) order by c.number)
                                 from pm.change_orders c where c.org_id = j.org_id and c.job_id = p_job), '[]'::jsonb),
    'exposure', (select to_jsonb(x) from pm.cm_v_change_exposure x where x.job_id = p_job),
    'buyout', coalesce((select jsonb_agg(to_jsonb(b) order by b.sort, b.name) from pm.cm_v_buyout b where b.job_id = p_job), '[]'::jsonb),
    'billing', coalesce((select jsonb_agg(jsonb_build_object('application_no', r.application_no, 'status', r.status, 'period_end', r.period_end,
                                      'gross_earned_cents', r.gross_earned_cents, 'retainage_cents', r.retainage_cents, 'net_cents', r.net_cents,
                                      'invoice_number', r.invoice_number) order by r.created_at)
                           from pm.billing_requests r where r.org_id = j.org_id and r.job_id = p_job and r.status <> 'VOID'
                            and coalesce(r.period_end, r.occurred_on) between date_trunc('month', p_period_end)::date and p_period_end), '[]'::jsonb),
    'retainage', (select to_jsonb(x) from pm.cm_v_retainage_both x where x.job_id = p_job),
    'schedule', (select jsonb_build_object('tasks', count(*), 'done', count(*) filter (where t.status = 'DONE'),
                                           'late', count(*) filter (where t.status not in ('DONE','CANCELLED') and t.due_on < p_period_end))
                   from pm.tasks t where t.org_id = j.org_id and t.job_id = p_job),
    'documents', jsonb_build_object(
       'rfis_open', (select count(*) from pm.cm_rfis r where r.org_id = j.org_id and r.job_id = p_job and r.status = 'OPEN'),
       'rfis_overdue', (select count(*) from pm.cm_rfis r where r.org_id = j.org_id and r.job_id = p_job and r.status = 'OPEN' and r.due_on < current_date),
       'submittals_open', (select count(*) from pm.cm_submittals s where s.org_id = j.org_id and s.job_id = p_job and s.status in ('REQUESTED','SUBMITTED','IN_REVIEW')),
       'submittals_late', (select count(*) from pm.cm_submittals s where s.org_id = j.org_id and s.job_id = p_job and s.status in ('NOT_STARTED','REQUESTED') and s.submit_by < current_date)),
    'safety', jsonb_build_object(
       'incidents', (select count(*) from pm.cm_incidents i where i.org_id = j.org_id and i.job_id = p_job and i.occurred_at::date between date_trunc('month', p_period_end)::date and p_period_end),
       'recordables', (select count(*) from pm.cm_incidents i where i.org_id = j.org_id and i.job_id = p_job and i.osha_recordable
                         and i.occurred_at::date between date_trunc('month', p_period_end)::date and p_period_end)),
    'period_end', p_period_end, 'built_at', now());
  insert into pm.cm_review_packages (org_id, job_id, location_id, period_end, status, content, pm_commentary, built_by, built_at)
  values (j.org_id, p_job, j.location_id, p_period_end, 'DRAFT', v_content, p_commentary, pm.current_user_id(), now())
  on conflict (org_id, job_id, period_end) do update set content = excluded.content, built_by = excluded.built_by, built_at = excluded.built_at,
     pm_commentary = coalesce(excluded.pm_commentary, pm.cm_review_packages.pm_commentary), status = 'DRAFT'
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm.cm_submit_review_package(p_package uuid, p_commentary text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_review_packages%rowtype;
begin
  select * into r from pm.cm_review_packages where id = p_package for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: review package % not found in the caller''s organization', p_package using errcode = '42501';
  end if;
  if r.status <> 'DRAFT' then raise exception 'PM_REVIEW_STATE: package is %', r.status using errcode = '22023'; end if;
  update pm.cm_review_packages set status = 'SUBMITTED', submitted_by = pm.current_user_id(), submitted_at = now(),
         pm_commentary = coalesce(p_commentary, pm_commentary) where id = r.id;
  return r.id;
end $$;

-- PX sign-off; the submitter cannot sign their own package.
create or replace function pm.cm_sign_review_package(p_package uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_review_packages%rowtype; v_me text := pm.current_user_id();
begin
  select * into r from pm.cm_review_packages where id = p_package for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: review package % not found in the caller''s organization', p_package using errcode = '42501';
  end if;
  if r.status <> 'SUBMITTED' then raise exception 'PM_REVIEW_STATE: package is %', r.status using errcode = '22023'; end if;
  if not pm._cm_is_executive(r.location_id) then raise exception 'PM_FORBIDDEN: a project executive signs the review package' using errcode = '42501'; end if;
  if v_me is null or v_me = r.submitted_by then raise exception 'PM_SOD_VIOLATION: the PM who submitted the package cannot sign it off' using errcode = '42501'; end if;
  update pm.cm_review_packages set status = 'SIGNED', signed_by = v_me, signed_at = now() where id = r.id;
  return r.id;
end $$;

-- Job cost detail with drill to the Books source (CGC-55), as the caller sees it (RLS: financials).
create or replace function pm.cm_job_cost_detail(p_job uuid, p_from date default null, p_to date default null)
returns table (id uuid, occurred_on date, cost_code_id uuid, cost_code text, cost_type text, amount_cents bigint, lifecycle text, gate text,
               source_ref text, gl_entry_id uuid, vendor_id uuid, description text, commitment_line_id uuid, commitment_number text)
language sql stable security invoker
set search_path = pm, core, public
as $$
  select c.id, c.occurred_on, c.cost_code_id, cc.code, c.cost_type, c.amount_cents, c.lifecycle, c.gate, c.source_ref, c.gl_entry_id, c.vendor_id,
         coalesce(c.description, c.memo), c.commitment_line_id, cm.number
    from pm.job_costs c
    left join pm.cost_codes cc on cc.id = c.cost_code_id
    left join pm.commitment_lines cl on cl.id = c.commitment_line_id
    left join pm.commitments cm on cm.id = cl.commitment_id
   where c.job_id = p_job and c.lifecycle <> 'VOIDED'
     and (p_from is null or c.occurred_on >= p_from) and (p_to is null or c.occurred_on <= p_to)
   order by c.occurred_on desc nulls last, c.id
$$;

-- ----------------------------------------------------------------------------
-- 10. RFIs (ball in court, due dates, official response, change-event link)
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_rfis (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  number                    text,
  subject                   text not null check (char_length(subject) between 1 and 200),
  question                  text,
  suggested_answer          text,
  discipline                text,
  spec_section              text,
  spec_section_id           uuid,
  drawing_ref               text,
  drawing_sheet_id          uuid,
  location_text             text,
  priority                  text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  status                    text not null default 'DRAFT' check (status in ('DRAFT','OPEN','ANSWERED','CLOSED','VOID')),
  is_private                boolean not null default false,
  ball_in_court_kind        text not null default 'INTERNAL' check (ball_in_court_kind in ('INTERNAL','ARCHITECT','ENGINEER','OWNER','SUB','OTHER')),
  ball_in_court_membership  uuid,
  ball_in_court_contact     uuid,
  ball_in_court_name        text,
  ball_in_court_email       text,
  assigned_vendor_id        uuid references core.vendors(id),
  due_on                    date,
  opened_at                 timestamptz,
  answered_at               timestamptz,
  closed_at                 timestamptz,
  official_response         text,
  responded_by_name         text,
  cost_impact               text not null default 'TBD' check (cost_impact in ('YES','NO','TBD')),
  schedule_impact           text not null default 'TBD' check (schedule_impact in ('YES','NO','TBD')),
  impact_days               int,
  change_event_id           uuid,
  distribution              jsonb not null default '[]' check (jsonb_typeof(distribution) = 'array'),
  legacy_id                 uuid,
  created_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, change_event_id) references pm.cm_change_events (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_rfis_job_idx on pm.cm_rfis (org_id, job_id, status, due_on);
create index if not exists pm_cm_rfis_bic_idx on pm.cm_rfis (org_id, ball_in_court_membership) where status = 'OPEN';
create unique index if not exists pm_cm_rfis_legacy_uidx on pm.cm_rfis (org_id, legacy_id) where legacy_id is not null;

create table if not exists pm.cm_rfi_responses (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid,
  rfi_id             uuid not null,
  body               text not null check (char_length(body) between 1 and 20000),
  is_official        boolean not null default false,
  author_name        text,
  author_membership  uuid,
  via                text not null default 'APP' check (via in ('APP','EMAIL','PORTAL')),
  document_ids       uuid[] not null default '{}',
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, rfi_id) references pm.cm_rfis (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.tg_cm_rfi_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if not pm.access_member_role() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then raise exception 'PM_RFI_STATE: an RFI starts as a draft' using errcode = '42501'; end if;
    return new;
  end if;
  if (new.status, new.official_response, new.answered_at, new.closed_at, new.opened_at)
     is distinct from (old.status, old.official_response, old.answered_at, old.closed_at, old.opened_at) then
    raise exception 'PM_RFI_STATE: open, answer and close an RFI through its actions' using errcode = '42501';
  end if;
  if old.status in ('CLOSED','VOID') then raise exception 'PM_RFI_LOCKED: % is %', old.number, old.status using errcode = '42501'; end if;
  return new;
end $$;

create or replace function pm.cm_rfi_open(p_rfi uuid, p_due date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype; v_days int;
begin
  select * into r from pm.cm_rfis where id = p_rfi for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFI % not found in the caller''s organization', p_rfi using errcode = '42501';
  end if;
  if r.status <> 'DRAFT' then raise exception 'PM_RFI_STATE: % is %', r.number, r.status using errcode = '22023'; end if;
  if nullif(btrim(coalesce(r.question, '')), '') is null then raise exception 'PM_INVALID: write the question first' using errcode = '22023'; end if;
  select s.rfi_default_days into v_days from pm.cm_contract_settings s where s.org_id = r.org_id and s.job_id = r.job_id;
  update pm.cm_rfis set status = 'OPEN', opened_at = now(), due_on = coalesce(p_due, due_on, current_date + coalesce(v_days, 7)),
         ball_in_court_kind = case when ball_in_court_kind = 'INTERNAL' and ball_in_court_membership is null then 'ARCHITECT' else ball_in_court_kind end
   where id = r.id;
  perform pm.log_activity(r.org_id, (select location_id from core.jobs where id = r.job_id), r.job_id, 'rfi.opened', 'cm_rfis', r.id,
    format('%s issued: %s', r.number, r.subject), jsonb_build_object('due_on', coalesce(p_due, r.due_on, current_date + coalesce(v_days, 7))));
  return r.id;
end $$;

create or replace function pm.cm_rfi_set_ball(p_rfi uuid, p_kind text, p_membership uuid default null, p_contact uuid default null,
                                              p_name text default null, p_email text default null, p_due date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype;
begin
  select * into r from pm.cm_rfis where id = p_rfi for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFI % not found in the caller''s organization', p_rfi using errcode = '42501';
  end if;
  if r.status in ('CLOSED','VOID') then raise exception 'PM_RFI_LOCKED: % is %', r.number, r.status using errcode = '22023'; end if;
  if p_membership is not null and not exists (select 1 from core.memberships m where m.id = p_membership and m.org_id = r.org_id and m.status = 'active') then
    raise exception 'PM_FORBIDDEN: that person is not in this organization' using errcode = '42501';
  end if;
  update pm.cm_rfis set ball_in_court_kind = p_kind, ball_in_court_membership = p_membership, ball_in_court_contact = p_contact,
         ball_in_court_name = p_name, ball_in_court_email = p_email, due_on = coalesce(p_due, due_on) where id = r.id;
  return r.id;
end $$;

-- A response (official = the answer of record; the ball returns to the RFI's author).
create or replace function pm.cm_rfi_respond(p_rfi uuid, p_body text, p_official boolean default false, p_author_name text default null,
                                             p_via text default 'APP')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype; v_id uuid; v_author uuid;
begin
  select * into r from pm.cm_rfis where id = p_rfi for update;
  if r.org_id is null or (r.org_id is distinct from public.get_org_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: RFI % not found in the caller''s organization', p_rfi using errcode = '42501';
  end if;
  if r.status not in ('OPEN','ANSWERED') then raise exception 'PM_RFI_STATE: % is %', r.number, r.status using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then raise exception 'PM_INVALID: the response is empty' using errcode = '22023'; end if;
  insert into pm.cm_rfi_responses (org_id, job_id, rfi_id, body, is_official, author_name, author_membership, via, created_by)
  values (r.org_id, r.job_id, r.id, p_body, coalesce(p_official, false), p_author_name, core.client_scope_caller_membership(), coalesce(p_via, 'APP'), pm.current_user_id())
  returning id into v_id;
  if coalesce(p_official, false) then
    select ms.id into v_author from core.memberships ms join core.users u on u.id = ms.user_id
     where u.clerk_user_id = r.created_by and ms.org_id = r.org_id and ms.status = 'active' limit 1;
    update pm.cm_rfis set status = 'ANSWERED', official_response = p_body, answered_at = now(), responded_by_name = coalesce(p_author_name, responded_by_name),
           ball_in_court_kind = 'INTERNAL', ball_in_court_membership = v_author, ball_in_court_contact = null, ball_in_court_name = null
     where id = r.id;
    perform pm.log_activity(r.org_id, (select location_id from core.jobs where id = r.job_id), r.job_id, 'rfi.answered', 'cm_rfis', r.id,
      format('%s answered', r.number), jsonb_build_object('via', p_via), case when pm.access_is_service() then 'SYSTEM' else 'HUMAN' end);
  end if;
  return v_id;
end $$;

-- Email-in (service path only): a reply parsed from the RFI's ball-in-court contact becomes the answer.
create or replace function pm.cm_rfi_email_reply(p_rfi uuid, p_from_email text, p_body text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype;
begin
  if not pm.access_is_service() then raise exception 'PM_FORBIDDEN: email-in runs on the service path only' using errcode = '42501'; end if;
  select * into r from pm.cm_rfis where id = p_rfi;
  return pm.cm_rfi_respond(p_rfi, p_body, lower(coalesce(r.ball_in_court_email, '')) = lower(coalesce(p_from_email, '')), p_from_email, 'EMAIL');
end $$;

create or replace function pm.cm_rfi_close(p_rfi uuid, p_reopen boolean default false)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype;
begin
  select * into r from pm.cm_rfis where id = p_rfi for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFI % not found in the caller''s organization', p_rfi using errcode = '42501';
  end if;
  if coalesce(p_reopen, false) then
    if r.status not in ('ANSWERED','CLOSED') then raise exception 'PM_RFI_STATE: % is %', r.number, r.status using errcode = '22023'; end if;
    update pm.cm_rfis set status = 'OPEN', closed_at = null where id = r.id;
  else
    if r.status not in ('OPEN','ANSWERED','DRAFT') then raise exception 'PM_RFI_STATE: % is %', r.number, r.status using errcode = '22023'; end if;
    update pm.cm_rfis set status = case when r.status = 'DRAFT' then 'VOID' else 'CLOSED' end, closed_at = now() where id = r.id;
  end if;
  return r.id;
end $$;

-- RFI answer with cost impact → change event (CGC-64 → CGC-32).
create or replace function pm.cm_rfi_to_change_event(p_rfi uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_rfis%rowtype; v_id uuid;
begin
  select * into r from pm.cm_rfis where id = p_rfi for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RFI % not found in the caller''s organization', p_rfi using errcode = '42501';
  end if;
  if r.change_event_id is not null then return r.change_event_id; end if;
  insert into pm.cm_change_events (org_id, job_id, title, description, source_type, source_table, source_id, scope, status, schedule_days, created_by)
  values (r.org_id, r.job_id, left(coalesce(r.number, 'RFI') || ': ' || r.subject, 200), coalesce(r.official_response, r.question), 'RFI', 'cm_rfis', r.id,
          'TBD', 'OPEN', r.impact_days, pm.current_user_id())
  returning id into v_id;
  update pm.cm_rfis set change_event_id = v_id, cost_impact = 'YES' where id = r.id;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 11. Specs, submittal register + review workflow + submittal schedule / procurement log
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_spec_sections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id      uuid not null,
  number      text not null check (char_length(number) between 2 and 20),
  title       text not null check (char_length(title) between 1 and 200),
  division    text,
  revision    int not null default 0,
  addendum    text,
  document_id uuid,
  page_start  int,
  page_end    int,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_submittals (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  number                    text not null,
  revision                  int not null default 0,
  spec_section_id           uuid,
  spec_section              text,
  title                     text not null check (char_length(title) between 1 and 200),
  submittal_type            text not null default 'PRODUCT_DATA' check (submittal_type in ('SHOP_DRAWING','PRODUCT_DATA','SAMPLE','MOCKUP','OM_MANUAL',
                              'WARRANTY','CERTIFICATE','TEST_REPORT','CALCULATIONS','SUSTAINABILITY','OTHER')),
  package                   text,
  status                    text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','REQUESTED','SUBMITTED','IN_REVIEW','APPROVED',
                              'APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED','FOR_RECORD','CLOSED','VOID')),
  responsible_vendor_id     uuid references core.vendors(id),
  commitment_id             uuid,
  ball_in_court_kind        text not null default 'SUB' check (ball_in_court_kind in ('INTERNAL','SUB','ARCHITECT','ENGINEER','CONSULTANT','OWNER')),
  ball_in_court_membership  uuid,
  ball_in_court_name        text,
  required_on_site          date,
  lead_time_days            int not null default 0 check (lead_time_days >= 0),
  review_days               int not null default 10 check (review_days >= 0),
  submit_by                 date,
  schedule_task_id          uuid,
  long_lead                 boolean not null default false,
  requested_at              timestamptz,
  submitted_at              timestamptz,
  returned_at               timestamptz,
  final_code                text,
  final_comments            text,
  released_for_fab_on       date,
  fab_start_on              date,
  ship_on                   date,
  delivered_on              date,
  procurement_status        text not null default 'NOT_RELEASED' check (procurement_status in ('NOT_RELEASED','RELEASED','IN_FABRICATION','SHIPPED','DELIVERED')),
  generated                 boolean not null default false,
  previous_revision_id      uuid,
  legacy_id                 uuid,
  created_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number, revision),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, spec_section_id) references pm.cm_spec_sections (org_id, id) on delete set null (spec_section_id) deferrable initially immediate
);
create index if not exists pm_cm_submittals_job_idx on pm.cm_submittals (org_id, job_id, status, submit_by);
create unique index if not exists pm_cm_submittals_legacy_uidx on pm.cm_submittals (org_id, legacy_id) where legacy_id is not null;

create table if not exists pm.cm_submittal_reviews (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid,
  submittal_id         uuid not null,
  revision             int not null default 0,
  step                 int not null check (step >= 1),
  reviewer_kind        text not null check (reviewer_kind in ('SUB','GC','ARCHITECT','ENGINEER','CONSULTANT','OWNER')),
  reviewer_membership  uuid,
  reviewer_contact     uuid,
  reviewer_name        text,
  status               text not null default 'PENDING' check (status in ('PENDING','ACTIVE','RETURNED','SKIPPED')),
  due_on               date,
  response_code        text check (response_code is null or response_code in ('NO_EXCEPTIONS','APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED','FOR_RECORD')),
  comments             text,
  stamp                text,
  returned_at          timestamptz,
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, submittal_id) references pm.cm_submittals (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_cm_sub_reviews_idx on pm.cm_submittal_reviews (org_id, submittal_id, revision, step);

-- submit-by = required on site − lead time − review time (CGC-66); on-site defaults to the linked activity start.
create or replace function pm.tg_cm_submittal_dates() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_start date;
begin
  if new.schedule_task_id is not null and new.required_on_site is null then
    select t.start_on into v_start from pm.tasks t where t.id = new.schedule_task_id and t.job_id = new.job_id;
    new.required_on_site := v_start;
  end if;
  new.submit_by := case when new.required_on_site is not null then new.required_on_site - new.lead_time_days - new.review_days end;
  if pm.access_member_role() then
    if tg_op = 'INSERT' and new.status not in ('NOT_STARTED','REQUESTED') then
      raise exception 'PM_SUBMITTAL_STATE: a submittal starts as not started or requested' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and ((new.status, new.final_code, new.released_for_fab_on) is distinct from (old.status, old.final_code, old.released_for_fab_on)) then
      raise exception 'PM_SUBMITTAL_STATE: submit, review and release fabrication through the submittal actions' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.procurement_status is distinct from old.procurement_status and new.released_for_fab_on is null then
      raise exception 'PM_SUBMITTAL_FAB_GATE: fabrication waits for the approved submittal' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function pm.cm_import_spec_sections(p_job uuid, p_sections jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; x jsonb; n int := 0; v_num text;
begin
  select * into j from pm._cm_job(p_job);
  if jsonb_typeof(coalesce(p_sections, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: sections must be an array' using errcode = '22023'; end if;
  for x in select value from jsonb_array_elements(p_sections) loop
    v_num := btrim(regexp_replace(coalesce(x ->> 'number', ''), '\s+', ' ', 'g'));
    continue when v_num = '' or coalesce(btrim(x ->> 'title'), '') = '';
    insert into pm.cm_spec_sections (org_id, job_id, number, title, division, revision, addendum, document_id, page_start, page_end)
    values (j.org_id, p_job, v_num, left(x ->> 'title', 200), left(regexp_replace(v_num, '[^0-9]', '', 'g'), 2), coalesce((x ->> 'revision')::int, 0),
            x ->> 'addendum', pm.access_try_uuid(x ->> 'document_id'), (x ->> 'page_start')::int, (x ->> 'page_end')::int)
    on conflict (org_id, job_id, number) do update set title = excluded.title, revision = greatest(pm.cm_spec_sections.revision, excluded.revision),
       addendum = coalesce(excluded.addendum, pm.cm_spec_sections.addendum), document_id = coalesce(excluded.document_id, pm.cm_spec_sections.document_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Register from the spec book (CGC-65): MasterFormat division rules → expected submittals per section.
-- Idempotent (an existing type on a section is skipped). Long-lead equipment flagged with lead times.
create or replace function pm.cm_generate_submittal_register(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; s record; t text; v_types text[]; n int := 0; v_seq int; v_lead int; v_long boolean; v_review int; v_num text;
begin
  select * into j from pm._cm_job(p_job);
  select coalesce(x.submittal_review_days, 10) into v_review from pm.cm_contract_settings x where x.org_id = j.org_id and x.job_id = p_job;
  for s in select * from pm.cm_spec_sections x where x.org_id = j.org_id and x.job_id = p_job order by x.number loop
    v_types := case s.division
      when '03' then array['PRODUCT_DATA','SHOP_DRAWING','TEST_REPORT']
      when '04' then array['PRODUCT_DATA','SAMPLE']
      when '05' then array['SHOP_DRAWING','PRODUCT_DATA','CERTIFICATE']
      when '06' then array['PRODUCT_DATA','SHOP_DRAWING']
      when '07' then array['PRODUCT_DATA','SAMPLE','WARRANTY']
      when '08' then array['SHOP_DRAWING','PRODUCT_DATA','SAMPLE','WARRANTY']
      when '09' then array['PRODUCT_DATA','SAMPLE']
      when '10' then array['PRODUCT_DATA','SHOP_DRAWING']
      when '11' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL','WARRANTY']
      when '12' then array['PRODUCT_DATA','SAMPLE']
      when '13' then array['SHOP_DRAWING','CALCULATIONS']
      when '14' then array['SHOP_DRAWING','PRODUCT_DATA','OM_MANUAL','WARRANTY']
      when '21' then array['SHOP_DRAWING','PRODUCT_DATA','CALCULATIONS','OM_MANUAL','TEST_REPORT']
      when '22' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL','WARRANTY','TEST_REPORT']
      when '23' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL','WARRANTY','TEST_REPORT']
      when '25' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL']
      when '26' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL','WARRANTY','TEST_REPORT']
      when '27' then array['PRODUCT_DATA','SHOP_DRAWING','TEST_REPORT']
      when '28' then array['PRODUCT_DATA','SHOP_DRAWING','OM_MANUAL','TEST_REPORT']
      when '31' then array['PRODUCT_DATA','TEST_REPORT']
      when '32' then array['PRODUCT_DATA','SAMPLE']
      when '33' then array['PRODUCT_DATA','TEST_REPORT']
      else array[]::text[] end;
    -- long-lead equipment (switchgear, AHUs / RTUs, elevators, curtain wall / storefront, generators)
    v_long := s.number ~ '^(26 ?2[34]|26 ?32|23 ?7[34]|23 ?64|14 ?2|08 ?4[1-4]|23 ?81|22 ?34)';
    v_lead := case when s.number ~ '^(26 ?2[34]|26 ?32)' then 120 when s.number ~ '^(23 ?7[34]|23 ?64|23 ?81)' then 90
                   when s.number ~ '^14 ?2' then 140 when s.number ~ '^08 ?4[1-4]' then 70 when s.number ~ '^22 ?34' then 60 else 21 end;
    foreach t in array v_types loop
      continue when exists (select 1 from pm.cm_submittals x where x.org_id = j.org_id and x.job_id = p_job and x.spec_section_id = s.id and x.submittal_type = t);
      select count(*) + 1 into v_seq from pm.cm_submittals x where x.org_id = j.org_id and x.job_id = p_job and x.spec_section_id = s.id;
      v_num := regexp_replace(s.number, '\s', '', 'g') || '-' || lpad(v_seq::text, 3, '0');
      insert into pm.cm_submittals (org_id, job_id, number, spec_section_id, spec_section, title, submittal_type, status, lead_time_days, review_days,
                                    long_lead, generated, created_by)
      values (j.org_id, p_job, v_num, s.id, s.number, left(s.title || ' — ' || initcap(replace(lower(t), '_', ' ')), 200), t, 'NOT_STARTED',
              case when t in ('SHOP_DRAWING','PRODUCT_DATA') then v_lead else 0 end, coalesce(v_review, 10),
              v_long and t in ('SHOP_DRAWING','PRODUCT_DATA'), true, pm.current_user_id());
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- Submit for review with the review chain: [{kind, membership?, contact?, name?, step?, due_days?}] (same step = parallel).
create or replace function pm.cm_submittal_submit(p_submittal uuid, p_reviewers jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_submittals%rowtype; x jsonb; i int := 0; v_first int; v_days int;
begin
  select * into s from pm.cm_submittals where id = p_submittal for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: submittal % not found in the caller''s organization', p_submittal using errcode = '42501';
  end if;
  if s.status not in ('NOT_STARTED','REQUESTED','REVISE_RESUBMIT') then raise exception 'PM_SUBMITTAL_STATE: % is %', s.number, s.status using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_reviewers, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_reviewers, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: name at least one reviewer' using errcode = '22023';
  end if;
  delete from pm.cm_submittal_reviews where org_id = s.org_id and submittal_id = s.id and revision = s.revision and status in ('PENDING','ACTIVE');
  for x in select value from jsonb_array_elements(p_reviewers) loop
    i := i + 1;
    v_days := coalesce((x ->> 'due_days')::int, s.review_days, 10);
    insert into pm.cm_submittal_reviews (org_id, job_id, submittal_id, revision, step, reviewer_kind, reviewer_membership, reviewer_contact, reviewer_name, status, due_on)
    values (s.org_id, s.job_id, s.id, s.revision, coalesce((x ->> 'step')::int, i), upper(coalesce(x ->> 'kind', 'ARCHITECT')),
            pm.access_try_uuid(x ->> 'membership'), pm.access_try_uuid(x ->> 'contact'), left(x ->> 'name', 120), 'PENDING', current_date + v_days);
  end loop;
  select min(r.step) into v_first from pm.cm_submittal_reviews r where r.org_id = s.org_id and r.submittal_id = s.id and r.revision = s.revision and r.status = 'PENDING';
  update pm.cm_submittal_reviews set status = 'ACTIVE' where org_id = s.org_id and submittal_id = s.id and revision = s.revision and step = v_first and status = 'PENDING';
  update pm.cm_submittals set status = 'IN_REVIEW', submitted_at = now(),
         ball_in_court_kind = (select case r.reviewer_kind when 'GC' then 'INTERNAL' else r.reviewer_kind end from pm.cm_submittal_reviews r
                                where r.submittal_id = s.id and r.revision = s.revision and r.status = 'ACTIVE' order by r.created_at limit 1),
         ball_in_court_membership = (select r.reviewer_membership from pm.cm_submittal_reviews r where r.submittal_id = s.id and r.revision = s.revision and r.status = 'ACTIVE' order by r.created_at limit 1),
         ball_in_court_name = (select r.reviewer_name from pm.cm_submittal_reviews r where r.submittal_id = s.id and r.revision = s.revision and r.status = 'ACTIVE' order by r.created_at limit 1)
   where id = s.id;
  return s.id;
end $$;

-- A reviewer returns their step. When every reviewer of the step has returned, the next step opens;
-- after the last step the most restrictive code becomes the submittal's status.
create or replace function pm.cm_submittal_respond(p_review uuid, p_code text, p_comments text default null, p_stamp text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.cm_submittal_reviews%rowtype; s pm.cm_submittals%rowtype; v_next int; v_final text;
begin
  select * into r from pm.cm_submittal_reviews where id = p_review for update;
  if r.org_id is null or (r.org_id is distinct from public.get_org_id() and not pm.access_is_service()) then
    raise exception 'PM_FORBIDDEN: review % not found in the caller''s organization', p_review using errcode = '42501';
  end if;
  if r.status <> 'ACTIVE' then raise exception 'PM_SUBMITTAL_REVIEW_STATE: this review step is %', lower(r.status) using errcode = '22023'; end if;
  if p_code not in ('NO_EXCEPTIONS','APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED','FOR_RECORD') then
    raise exception 'PM_INVALID: response code %', p_code using errcode = '22023';
  end if;
  select * into s from pm.cm_submittals where id = r.submittal_id for update;
  update pm.cm_submittal_reviews set status = 'RETURNED', response_code = p_code, comments = p_comments, stamp = p_stamp, returned_at = now() where id = r.id;
  if p_code in ('REVISE_RESUBMIT','REJECTED') then
    update pm.cm_submittal_reviews set status = 'SKIPPED' where submittal_id = s.id and revision = s.revision and status in ('PENDING','ACTIVE');
    update pm.cm_submittals set status = p_code, final_code = p_code, final_comments = p_comments, returned_at = now(),
           ball_in_court_kind = 'SUB', ball_in_court_membership = null, ball_in_court_name = null where id = s.id;
    return s.id;
  end if;
  if exists (select 1 from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.step = r.step and x.status = 'ACTIVE') then
    return s.id;  -- parallel reviewers still out
  end if;
  select min(x.step) into v_next from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.status = 'PENDING';
  if v_next is not null then
    update pm.cm_submittal_reviews set status = 'ACTIVE', due_on = current_date + coalesce(s.review_days, 10)
     where submittal_id = s.id and revision = s.revision and step = v_next and status = 'PENDING';
    update pm.cm_submittals set
           ball_in_court_kind = (select case x.reviewer_kind when 'GC' then 'INTERNAL' else x.reviewer_kind end from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.status = 'ACTIVE' order by x.created_at limit 1),
           ball_in_court_membership = (select x.reviewer_membership from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.status = 'ACTIVE' order by x.created_at limit 1),
           ball_in_court_name = (select x.reviewer_name from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.status = 'ACTIVE' order by x.created_at limit 1)
     where id = s.id;
    return s.id;
  end if;
  select case when bool_or(x.response_code = 'APPROVED_AS_NOTED') then 'APPROVED_AS_NOTED'
              when bool_and(x.response_code = 'FOR_RECORD') then 'FOR_RECORD' else 'APPROVED' end
    into v_final from pm.cm_submittal_reviews x where x.submittal_id = s.id and x.revision = s.revision and x.status = 'RETURNED';
  update pm.cm_submittals set status = v_final, final_code = v_final, final_comments = coalesce(p_comments, final_comments), returned_at = now(),
         ball_in_court_kind = 'INTERNAL', ball_in_court_membership = null, ball_in_court_name = null where id = s.id;
  return s.id;
end $$;

-- Resubmittal: a new revision row (the returned one closes).
create or replace function pm.cm_submittal_revise(p_submittal uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_submittals%rowtype; v_id uuid;
begin
  select * into s from pm.cm_submittals where id = p_submittal for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: submittal % not found in the caller''s organization', p_submittal using errcode = '42501';
  end if;
  if s.status not in ('REVISE_RESUBMIT','REJECTED') then raise exception 'PM_SUBMITTAL_STATE: % is %', s.number, s.status using errcode = '22023'; end if;
  insert into pm.cm_submittals (org_id, job_id, number, revision, spec_section_id, spec_section, title, submittal_type, package, status, responsible_vendor_id,
    commitment_id, required_on_site, lead_time_days, review_days, schedule_task_id, long_lead, previous_revision_id, created_by)
  values (s.org_id, s.job_id, s.number, s.revision + 1, s.spec_section_id, s.spec_section, s.title, s.submittal_type, s.package, 'REQUESTED',
    s.responsible_vendor_id, s.commitment_id, s.required_on_site, s.lead_time_days, s.review_days, s.schedule_task_id, s.long_lead, s.id, pm.current_user_id())
  returning id into v_id;
  update pm.cm_submittals set status = 'CLOSED' where id = s.id;
  return v_id;
end $$;

-- Fabrication release is gated on the approved submittal (CGC-66).
create or replace function pm.cm_submittal_release_fab(p_submittal uuid, p_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_submittals%rowtype;
begin
  select * into s from pm.cm_submittals where id = p_submittal for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: submittal % not found in the caller''s organization', p_submittal using errcode = '42501';
  end if;
  if s.status not in ('APPROVED','APPROVED_AS_NOTED') then
    raise exception 'PM_SUBMITTAL_FAB_GATE: % is % — fabrication waits for approval', s.number, lower(replace(s.status, '_', ' ')) using errcode = '22023';
  end if;
  update pm.cm_submittals set released_for_fab_on = coalesce(p_on, current_date), procurement_status = 'RELEASED' where id = s.id;
  return s.id;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Transmittals, correspondence, meetings (items carry forward)
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_transmittals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  number           text,
  subject          text not null check (char_length(subject) between 1 and 200),
  to_name          text,
  to_company       text,
  to_email         text,
  to_contact_id    uuid,
  purpose          text not null default 'FOR_REVIEW' check (purpose in ('FOR_APPROVAL','FOR_REVIEW','FOR_INFORMATION','FOR_CONSTRUCTION','AS_REQUESTED','FOR_RECORD')),
  items            jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  notes            text,
  status           text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACKNOWLEDGED','VOID')),
  sent_at          timestamptz,
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_correspondence (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  corr_type              text not null default 'LETTER' check (corr_type in ('LETTER','NOTICE_OF_DELAY','NOTICE_OF_CLAIM','BACKCHARGE_NOTICE','NOTICE_OF_DEFAULT',
                           'NOTICE_TO_PROCEED','NOTICE_OF_DISPUTE','MEMO','EMAIL','OTHER')),
  number                 text,
  direction              text not null default 'OUTGOING' check (direction in ('OUTGOING','INCOMING')),
  subject                text not null check (char_length(subject) between 1 and 200),
  body                   text,
  from_name              text,
  to_name                text,
  to_company             text,
  sent_on                date,
  response_required_by   date,
  responded_on           date,
  status                 text not null default 'DRAFT' check (status in ('DRAFT','SENT','RECEIVED','RESPONDED','CLOSED','VOID')),
  change_event_id        uuid,
  related_table          text,
  related_id             uuid,
  document_id            uuid,
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Correspondence numbers per type: NOD-001, LTR-001 …; timestamps follow the status.
create or replace function pm.tg_cm_correspondence() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_prefix text; n bigint;
begin
  if tg_op = 'INSERT' and coalesce(btrim(new.number), '') = '' then
    v_prefix := case new.corr_type when 'NOTICE_OF_DELAY' then 'NOD' when 'NOTICE_OF_CLAIM' then 'NOC' when 'BACKCHARGE_NOTICE' then 'BCN'
                  when 'NOTICE_OF_DEFAULT' then 'NDF' when 'NOTICE_TO_PROCEED' then 'NTP' when 'NOTICE_OF_DISPUTE' then 'NDS'
                  when 'MEMO' then 'MEM' when 'EMAIL' then 'EML' when 'LETTER' then 'LTR' else 'COR' end;
    n := pm.next_doc_number(new.org_id, new.job_id::text, 'CM_CORR_' || v_prefix, 'all');
    new.number := v_prefix || '-' || lpad(n::text, 3, '0');
  end if;
  if new.status in ('SENT','RECEIVED') and new.sent_on is null then new.sent_on := current_date; end if;
  if new.status = 'RESPONDED' and new.responded_on is null then new.responded_on := current_date; end if;
  return new;
end $$;

create or replace function pm.tg_cm_transmittal() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if new.status = 'SENT' and (tg_op = 'INSERT' or old.status is distinct from 'SENT') then new.sent_at := coalesce(new.sent_at, now()); end if;
  if new.status = 'ACKNOWLEDGED' and new.acknowledged_at is null then new.acknowledged_at := now(); end if;
  if tg_op = 'UPDATE' and old.status in ('ACKNOWLEDGED','VOID') and pm.access_member_role() and (new.items, new.subject) is distinct from (old.items, old.subject) then
    raise exception 'PM_TRANSMITTAL_LOCKED: % is %', old.number, old.status using errcode = '42501';
  end if;
  return new;
end $$;

create table if not exists pm.cm_meetings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  meeting_type        text not null default 'OAC' check (meeting_type in ('OAC','SUB_COORDINATION','PRECONSTRUCTION','PREINSTALLATION','SAFETY','CLOSEOUT','OTHER')),
  series_key          text not null default 'OAC',
  number              int not null default 1,
  title               text not null check (char_length(title) between 1 and 200),
  scheduled_at        timestamptz,
  location_text       text,
  status              text not null default 'SCHEDULED' check (status in ('SCHEDULED','IN_PROGRESS','MINUTES_DRAFT','DISTRIBUTED','CLOSED','CANCELLED')),
  agenda              text,
  minutes             text,
  transcript          text,
  previous_meeting_id uuid,
  distributed_at      timestamptz,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, series_key, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_meeting_attendees (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid,
  meeting_id           uuid not null,
  name                 text not null check (char_length(name) between 1 and 120),
  company              text,
  email                text,
  membership_id        uuid,
  contact_id           uuid,
  role                 text,
  attended             boolean,
  accepted_minutes_at  timestamptz,
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, meeting_id) references pm.cm_meetings (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.cm_meeting_items (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid,
  origin_meeting_id     uuid not null,
  series_key            text,
  item_no               text,
  topic                 text not null check (char_length(topic) between 1 and 200),
  description           text,
  owner_name            text,
  owner_membership      uuid,
  owner_company         text,
  due_on                date,
  status                text not null default 'OPEN' check (status in ('OPEN','CLOSED','DEFERRED')),
  closed_in_meeting_id  uuid,
  closed_at             timestamptz,
  related_table         text check (related_table is null or related_table in ('cm_rfis','change_orders','cm_submittals','cm_change_events','tasks','punch_items')),
  related_id            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, origin_meeting_id) references pm.cm_meetings (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.cm_meeting_item_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id      uuid,
  item_id     uuid not null,
  meeting_id  uuid not null,
  note        text not null,
  carried     boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, item_id) references pm.cm_meeting_items (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, meeting_id) references pm.cm_meetings (org_id, id) on delete cascade deferrable initially immediate
);

-- Items number per meeting (1.01, 1.02 …) and remember their series.
create or replace function pm.tg_cm_meeting_item() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.cm_meetings%rowtype; n int;
begin
  select * into m from pm.cm_meetings where id = new.origin_meeting_id;
  new.series_key := m.series_key;
  if tg_op = 'INSERT' and coalesce(btrim(new.item_no), '') = '' then
    select count(*) + 1 into n from pm.cm_meeting_items x where x.org_id = new.org_id and x.origin_meeting_id = new.origin_meeting_id;
    new.item_no := m.number || '.' || lpad(n::text, 2, '0');
  end if;
  if new.status = 'CLOSED' and new.closed_at is null then new.closed_at := now(); end if;
  return new;
end $$;

-- The next meeting of the series; every open item carries forward with a note (CGC-68).
create or replace function pm.cm_meeting_next(p_meeting uuid, p_scheduled_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.cm_meetings%rowtype; v_id uuid; v_no int;
begin
  select * into m from pm.cm_meetings where id = p_meeting;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: meeting % not found in the caller''s organization', p_meeting using errcode = '42501';
  end if;
  select coalesce(max(x.number), 0) + 1 into v_no from pm.cm_meetings x where x.org_id = m.org_id and x.job_id = m.job_id and x.series_key = m.series_key;
  insert into pm.cm_meetings (org_id, job_id, meeting_type, series_key, number, title, scheduled_at, location_text, status, agenda, previous_meeting_id, created_by)
  values (m.org_id, m.job_id, m.meeting_type, m.series_key, v_no, regexp_replace(m.title, '#\d+', '#' || v_no), coalesce(p_scheduled_at, m.scheduled_at + interval '7 days'),
          m.location_text, 'SCHEDULED', m.agenda, m.id, pm.current_user_id())
  returning id into v_id;
  insert into pm.cm_meeting_item_notes (org_id, job_id, item_id, meeting_id, note, carried)
  select i.org_id, i.job_id, i.id, v_id, format('Carried forward from meeting #%s', m.number), true
    from pm.cm_meeting_items i where i.org_id = m.org_id and i.job_id = m.job_id and i.series_key = m.series_key and i.status = 'OPEN';
  insert into pm.cm_meeting_attendees (org_id, job_id, meeting_id, name, company, email, membership_id, contact_id, role)
  select a.org_id, a.job_id, v_id, a.name, a.company, a.email, a.membership_id, a.contact_id, a.role from pm.cm_meeting_attendees a where a.meeting_id = m.id;
  return v_id;
end $$;

create or replace function pm.cm_meeting_distribute(p_meeting uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.cm_meetings%rowtype;
begin
  select * into m from pm.cm_meetings where id = p_meeting for update;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: meeting % not found in the caller''s organization', p_meeting using errcode = '42501';
  end if;
  if m.status in ('CANCELLED') then raise exception 'PM_MEETING_STATE: the meeting was cancelled' using errcode = '22023'; end if;
  update pm.cm_meetings set status = 'DISTRIBUTED', distributed_at = now() where id = m.id;
  perform pm._cm_notify(m.org_id, 'meeting.minutes', m.job_id, 'cm_meetings', m.id,
    array(select a.membership_id from pm.cm_meeting_attendees a where a.meeting_id = m.id and a.membership_id is not null),
    format('Minutes: %s', m.title), 'Review and accept the minutes', '/meetings?item=' || m.id, 'minutes:' || m.id);
  return m.id;
end $$;

create or replace function pm.cm_meeting_accept(p_attendee uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.cm_meeting_attendees%rowtype;
begin
  select * into a from pm.cm_meeting_attendees where id = p_attendee for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: attendee % not found in the caller''s organization', p_attendee using errcode = '42501';
  end if;
  if a.membership_id is distinct from core.client_scope_caller_membership() and not pm.access_can_job('projects.jobs', 'edit', a.job_id) then
    raise exception 'PM_FORBIDDEN: only the attendee (or the job''s editor) accepts the minutes' using errcode = '42501';
  end if;
  update pm.cm_meeting_attendees set accepted_minutes_at = now() where id = a.id;
  return a.id;
end $$;

-- ----------------------------------------------------------------------------
-- 13. Daily log depth (companion of pm.field_logs): manpower, deliveries, delays, sign + lock, voice
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_daily_logs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  field_log_id      uuid not null unique references pm.field_logs(id) on delete cascade,
  log_date          date not null,
  status            text not null default 'DRAFT' check (status in ('DRAFT','SIGNED','AMENDED')),
  weather_summary   text,
  temp_high_f       int,
  temp_low_f        int,
  precipitation     text,
  wind              text,
  site_conditions   text,
  work_performed    text,
  safety_notes      text,
  signed_by         text,
  signed_by_name    text,
  signed_at         timestamptz,
  amended_count     int not null default 0,
  copied_from       uuid,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, log_date),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_log_entries (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid,
  daily_log_id       uuid not null,
  kind               text not null check (kind in ('MANPOWER','EQUIPMENT','DELIVERY','DELAY','VISITOR','INSPECTION','WORK','NOTE','SAFETY')),
  vendor_id          uuid references core.vendors(id),
  company_name       text,
  trade              text,
  headcount          int check (headcount is null or headcount >= 0),
  hours              numeric(8,2) check (hours is null or hours >= 0),
  equipment          text,
  equipment_hours    numeric(8,2),
  idle               boolean,
  supplier           text,
  po_ref             text,
  received_by        text,
  description        text,
  cause              text check (cause is null or cause in ('WEATHER','OWNER','DESIGN','SUB','MATERIAL','INSPECTION','LABOR','ACCESS','OTHER')),
  duration_hours     numeric(8,2),
  responsible_party  text,
  notice_sent        boolean,
  inspector          text,
  result             text check (result is null or result in ('PASS','FAIL','PARTIAL')),
  area               text,
  cost_code_id       uuid,
  qty                numeric(14,4),
  uom                text,
  is_amendment       boolean not null default false,
  amendment_reason   text,
  sort               int not null default 0,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, daily_log_id) references pm.cm_daily_logs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_cm_log_entries_log_idx on pm.cm_log_entries (org_id, daily_log_id, kind);
create index if not exists pm_cm_log_entries_vendor_idx on pm.cm_log_entries (org_id, vendor_id) where vendor_id is not null;

create table if not exists pm.cm_daily_log_voice (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid,
  daily_log_id  uuid not null,
  transcript    text not null check (char_length(transcript) between 1 and 20000),
  language      text not null default 'en' check (language in ('en','es')),
  proposed      jsonb not null default '[]' check (jsonb_typeof(proposed) = 'array'),
  status        text not null default 'PROPOSED' check (status in ('PROPOSED','APPLIED','DISMISSED')),
  applied_at    timestamptz,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, daily_log_id) references pm.cm_daily_logs (org_id, id) on delete cascade deferrable initially immediate
);

-- Signed logs are locked: members change them only by amendment (CGC-12, CGC-70).
create or replace function pm.tg_cm_daily_log_lock() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text;
begin
  if not pm.access_member_role() then return coalesce(new, old); end if;
  if tg_table_name = 'cm_daily_logs' then
    if tg_op = 'INSERT' then
      if new.status <> 'DRAFT' then raise exception 'PM_DAILY_LOG_STATE: a log starts as a draft' using errcode = '42501'; end if;
      return new;
    end if;
    if old.status <> 'DRAFT' then raise exception 'PM_DAILY_LOG_LOCKED: the % log is signed — add an amendment', old.log_date using errcode = '42501'; end if;
    if tg_op = 'UPDATE' and (new.status, new.signed_at, new.signed_by) is distinct from (old.status, old.signed_at, old.signed_by) then
      raise exception 'PM_DAILY_LOG_STATE: sign the log through its action' using errcode = '42501';
    end if;
    return coalesce(new, old);
  elsif tg_table_name = 'field_logs' then
    select d.status into v_status from pm.cm_daily_logs d where d.field_log_id = old.id;
  else
    select d.status into v_status from pm.cm_daily_logs d where d.id = coalesce(new.daily_log_id, old.daily_log_id);
  end if;
  if v_status in ('SIGNED','AMENDED') then
    raise exception 'PM_DAILY_LOG_LOCKED: the log is signed — add an amendment' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create or replace function pm.cm_daily_log_open(p_job uuid, p_date date default null, p_copy_forward boolean default true)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_date date := coalesce(p_date, current_date); v_id uuid; v_fl uuid; v_prev pm.cm_daily_logs%rowtype;
begin
  select * into j from pm._cm_job(p_job);
  select d.id into v_id from pm.cm_daily_logs d where d.org_id = j.org_id and d.job_id = p_job and d.log_date = v_date;
  if v_id is not null then return v_id; end if;
  select f.id into v_fl from pm.field_logs f where f.org_id = j.org_id and f.job_id = p_job and f.kind = 'DAILY' and f.log_date = v_date
    and not exists (select 1 from pm.cm_daily_logs d where d.field_log_id = f.id) order by f.created_at limit 1;
  if v_fl is null then
    insert into pm.field_logs (org_id, job_id, kind, log_date, created_by) values (j.org_id, p_job, 'DAILY', v_date, pm.current_user_id()) returning id into v_fl;
  end if;
  select * into v_prev from pm.cm_daily_logs d where d.org_id = j.org_id and d.job_id = p_job and d.log_date < v_date order by d.log_date desc limit 1;
  insert into pm.cm_daily_logs (org_id, job_id, field_log_id, log_date, status, copied_from, created_by)
  values (j.org_id, p_job, v_fl, v_date, 'DRAFT', case when coalesce(p_copy_forward, true) then v_prev.id end, pm.current_user_id())
  returning id into v_id;
  if coalesce(p_copy_forward, true) and v_prev.id is not null then
    insert into pm.cm_log_entries (org_id, job_id, daily_log_id, kind, vendor_id, company_name, trade, headcount, hours, equipment, equipment_hours, sort, created_by)
    select e.org_id, e.job_id, v_id, e.kind, e.vendor_id, e.company_name, e.trade, e.headcount, e.hours, e.equipment, e.equipment_hours, e.sort, pm.current_user_id()
      from pm.cm_log_entries e where e.daily_log_id = v_prev.id and e.kind in ('MANPOWER','EQUIPMENT') and not e.is_amendment;
  end if;
  return v_id;
end $$;

create or replace function pm.cm_daily_log_sign(p_log uuid, p_signer_name text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.cm_daily_logs%rowtype; v_heads int; v_hours numeric;
begin
  select * into d from pm.cm_daily_logs where id = p_log for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: daily log % not found in the caller''s organization', p_log using errcode = '42501';
  end if;
  if d.status <> 'DRAFT' then raise exception 'PM_DAILY_LOG_STATE: the log is already %', lower(d.status) using errcode = '22023'; end if;
  select coalesce(sum(e.headcount), 0), coalesce(sum(e.hours), 0) into v_heads, v_hours from pm.cm_log_entries e where e.daily_log_id = d.id and e.kind = 'MANPOWER';
  update pm.field_logs set crew_count = v_heads, hours = v_hours,
         body = left(concat_ws(E'\n', d.work_performed, case when d.safety_notes is not null then 'Safety: ' || d.safety_notes end), 20000),
         weather = coalesce(weather, jsonb_strip_nulls(jsonb_build_object('summary', d.weather_summary, 'high_f', d.temp_high_f, 'low_f', d.temp_low_f,
                                                                          'precipitation', d.precipitation, 'wind', d.wind)))
   where id = d.field_log_id;
  update pm.cm_daily_logs set status = 'SIGNED', signed_by = pm.current_user_id(), signed_by_name = p_signer_name, signed_at = now() where id = d.id;
  perform pm.log_activity(d.org_id, (select location_id from core.jobs where id = d.job_id), d.job_id, 'daily_log.signed', 'cm_daily_logs', d.id,
    format('Daily log %s signed (%s on site)', d.log_date, v_heads), jsonb_build_object('headcount', v_heads, 'hours', v_hours));
  return d.id;
end $$;

-- After signing, the record changes only by amendment (who, when, why — kept with the log).
create or replace function pm.cm_daily_log_amend(p_log uuid, p_reason text, p_entry jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.cm_daily_logs%rowtype; v_id uuid;
begin
  select * into d from pm.cm_daily_logs where id = p_log for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: daily log % not found in the caller''s organization', p_log using errcode = '42501';
  end if;
  if d.status = 'DRAFT' then raise exception 'PM_DAILY_LOG_STATE: the log is still a draft — edit it directly' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: say why the signed log is amended' using errcode = '22023'; end if;
  insert into pm.cm_log_entries (org_id, job_id, daily_log_id, kind, vendor_id, company_name, trade, headcount, hours, description, cause, duration_hours,
                                 responsible_party, notice_sent, qty, uom, cost_code_id, is_amendment, amendment_reason, created_by)
  values (d.org_id, d.job_id, d.id, coalesce(upper(p_entry ->> 'kind'), 'NOTE'), pm.access_try_uuid(p_entry ->> 'vendor_id'), p_entry ->> 'company_name',
          p_entry ->> 'trade', (p_entry ->> 'headcount')::int, (p_entry ->> 'hours')::numeric, p_entry ->> 'description', p_entry ->> 'cause',
          (p_entry ->> 'duration_hours')::numeric, p_entry ->> 'responsible_party', (p_entry ->> 'notice_sent')::boolean, (p_entry ->> 'qty')::numeric,
          p_entry ->> 'uom', pm.access_try_uuid(p_entry ->> 'cost_code_id'), true, p_reason, pm.current_user_id())
  returning id into v_id;
  update pm.cm_daily_logs set status = 'AMENDED', amended_count = amended_count + 1 where id = d.id;
  return v_id;
end $$;

-- Apply reviewed voice-extracted entries (the app parses the transcript; the super confirms).
create or replace function pm.cm_daily_log_apply_voice(p_voice uuid, p_entries jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v pm.cm_daily_log_voice%rowtype; d pm.cm_daily_logs%rowtype; x jsonb; n int := 0;
begin
  select * into v from pm.cm_daily_log_voice where id = p_voice for update;
  if v.org_id is null or v.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: voice note % not found in the caller''s organization', p_voice using errcode = '42501';
  end if;
  select * into d from pm.cm_daily_logs where id = v.daily_log_id;
  if d.status <> 'DRAFT' then raise exception 'PM_DAILY_LOG_LOCKED: the log is signed — add an amendment' using errcode = '22023'; end if;
  if v.status <> 'PROPOSED' then raise exception 'PM_VOICE_STATE: already %', lower(v.status) using errcode = '22023'; end if;
  for x in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    continue when upper(coalesce(x ->> 'kind', '')) not in ('MANPOWER','EQUIPMENT','DELIVERY','DELAY','VISITOR','INSPECTION','WORK','NOTE','SAFETY');
    insert into pm.cm_log_entries (org_id, job_id, daily_log_id, kind, vendor_id, company_name, trade, headcount, hours, equipment, supplier, description, cause,
                                   duration_hours, area, cost_code_id, qty, uom, created_by)
    values (d.org_id, d.job_id, d.id, upper(x ->> 'kind'), pm.access_try_uuid(x ->> 'vendor_id'), left(x ->> 'company_name', 120), left(x ->> 'trade', 80),
            (x ->> 'headcount')::int, (x ->> 'hours')::numeric, left(x ->> 'equipment', 120), left(x ->> 'supplier', 120), left(x ->> 'description', 4000),
            case when upper(x ->> 'cause') in ('WEATHER','OWNER','DESIGN','SUB','MATERIAL','INSPECTION','LABOR','ACCESS','OTHER') then upper(x ->> 'cause') end,
            (x ->> 'duration_hours')::numeric, left(x ->> 'area', 120), pm.access_try_uuid(x ->> 'cost_code_id'), (x ->> 'qty')::numeric, left(x ->> 'uom', 20),
            pm.current_user_id());
    n := n + 1;
  end loop;
  if (select count(*) from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e(val) where e.val ->> 'kind' = 'WORK_SUMMARY') > 0 then
    update pm.cm_daily_logs set work_performed = coalesce(work_performed || E'\n', '') ||
           (select string_agg(e.val ->> 'description', E'\n') from jsonb_array_elements(p_entries) e(val) where e.val ->> 'kind' = 'WORK_SUMMARY') where id = d.id;
  end if;
  update pm.cm_daily_log_voice set status = 'APPLIED', applied_at = now() where id = v.id;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 14. Observations, inspections / QA checklists, safety (toolbox talks, JHA, incidents, OSHA)
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_observations (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                  uuid not null,
  number                  text,
  obs_type                text not null default 'QUALITY' check (obs_type in ('QUALITY','SAFETY','COMMISSIONING','ENVIRONMENTAL','WARRANTY')),
  priority                text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','CRITICAL')),
  title                   text not null check (char_length(title) between 1 and 200),
  description             text,
  hazard                  text,
  contributing_condition  text,
  assignee_vendor_id      uuid references core.vendors(id),
  assignee_membership     uuid,
  assignee_name           text,
  due_on                  date,
  status                  text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','READY_FOR_REVIEW','CLOSED','VOID')),
  closed_at               timestamptz,
  drawing_sheet_id        uuid,
  pin_x                   numeric(7,4),
  pin_y                   numeric(7,4),
  photo_ids               uuid[] not null default '{}',
  inspection_item_id      uuid,
  created_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_checklist_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid references core.locations(id),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name        text not null check (char_length(name) between 1 and 120),
  category    text not null default 'OTHER' check (category in ('PRE_POUR','FRAMING','MEP_ROUGH_IN','ABOVE_CEILING','FIRESTOPPING','ENVELOPE','FINAL',
                'SAFETY_AUDIT','TRADE_QA','OTHER')),
  items       jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  is_active   boolean not null default true,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique nulls not distinct (org_id, location_id, key)
);

create table if not exists pm.cm_inspections (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  template_id          uuid,
  number               text,
  title                text not null check (char_length(title) between 1 and 200),
  category             text,
  area                 text,
  inspected_on         date not null default current_date,
  inspector_name       text,
  inspector_membership uuid,
  status               text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','COMPLETE','VOID')),
  result               text check (result is null or result in ('PASS','FAIL','PARTIAL')),
  signed_by_name       text,
  signed_at            timestamptz,
  signature_png        text check (signature_png is null or char_length(signature_png) <= 400000),
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_inspection_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid,
  inspection_id   uuid not null,
  sort            int not null default 0,
  section         text,
  label           text not null,
  requires_photo  boolean not null default false,
  response        text check (response is null or response in ('PASS','FAIL','NA')),
  value           text,
  note            text,
  photo_ids       uuid[] not null default '{}',
  observation_id  uuid,
  unique (org_id, id),
  foreign key (org_id, inspection_id) references pm.cm_inspections (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.cm_toolbox_talks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  held_on         date not null default current_date,
  topic           text not null check (char_length(topic) between 1 and 200),
  language        text not null default 'en' check (language in ('en','es')),
  presenter_name  text,
  notes           text,
  document_id     uuid,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_toolbox_attendance (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid,
  talk_id        uuid not null,
  worker_name    text not null check (char_length(worker_name) between 1 and 120),
  employee_id    uuid references core.employees(id),
  company        text,
  method         text not null default 'SIGNATURE' check (method in ('SIGNATURE','QR','FACE','PAPER')),
  signature_png  text check (signature_png is null or char_length(signature_png) <= 200000),
  signed_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, talk_id) references pm.cm_toolbox_talks (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.cm_jhas (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  work_date            date not null default current_date,
  crew_id              uuid,
  foreman_employee_id  uuid references core.employees(id),
  task_description     text not null check (char_length(task_description) between 1 and 500),
  area                 text,
  steps                jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),   -- [{step, hazards[], controls[]}]
  ppe                  text[] not null default '{}',
  permits              text[] not null default '{}',
  status               text not null default 'DRAFT' check (status in ('DRAFT','SIGNED')),
  signoffs             jsonb not null default '[]' check (jsonb_typeof(signoffs) = 'array'),
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_incidents (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  location_id         uuid,
  number              text,
  incident_type       text not null check (incident_type in ('INJURY','ILLNESS','PROPERTY_DAMAGE','NEAR_MISS','ENVIRONMENTAL','VEHICLE')),
  occurred_at         timestamptz not null,
  reported_at         timestamptz not null default now(),
  employee_id         uuid references core.employees(id),
  person_name         text,
  job_title           text,
  company             text,
  is_employee         boolean not null default true,
  description         text not null check (char_length(description) between 1 and 20000),
  where_occurred      text,
  body_part           text,
  injury_nature       text,
  object_substance    text,
  witnesses           jsonb not null default '[]' check (jsonb_typeof(witnesses) = 'array'),
  root_cause          text,
  corrective_actions  jsonb not null default '[]' check (jsonb_typeof(corrective_actions) = 'array'),
  osha_recordable     boolean,
  osha_classification text check (osha_classification is null or osha_classification in ('DEATH','DAYS_AWAY','RESTRICTED_OR_TRANSFER','OTHER_RECORDABLE')),
  injury_or_illness   text check (injury_or_illness is null or injury_or_illness in ('INJURY','SKIN_DISORDER','RESPIRATORY','POISONING','HEARING_LOSS','OTHER_ILLNESS')),
  days_away           int not null default 0 check (days_away >= 0),
  days_restricted     int not null default 0 check (days_restricted >= 0),
  privacy_case        boolean not null default false,
  case_number         text,
  wc_claim_ref        text,
  status              text not null default 'OPEN' check (status in ('OPEN','UNDER_REVIEW','CLOSED')),
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  check (osha_recordable is not true or osha_classification is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_incidents_loc_idx on pm.cm_incidents (org_id, location_id, occurred_at);

-- Manual hours for OSHA rates (subs' hours, or before payroll lands); payroll hours come from time entries.
create table if not exists pm.cm_safety_hours (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  period_month  date not null check (extract(day from period_month) = 1),
  hours         numeric(12,2) not null check (hours >= 0),
  note          text,
  created_at    timestamptz not null default now(),
  unique (org_id, location_id, period_month)
);

create or replace function pm.tg_cm_incident() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n bigint;
begin
  select j.location_id into new.location_id from core.jobs j where j.id = new.job_id;
  if tg_op = 'INSERT' and coalesce(btrim(new.number), '') = '' then
    n := pm.next_doc_number(new.org_id, coalesce(new.location_id::text, 'org'), 'CM_INC', to_char(new.occurred_at, 'YYYY'));
    new.number := to_char(new.occurred_at, 'YYYY') || '-' || lpad(n::text, 3, '0');
  end if;
  if new.case_number is null and new.osha_recordable then new.case_number := new.number; end if;
  return new;
end $$;

-- Start an inspection from a template (items copied, so later template edits never rewrite history).
create or replace function pm.cm_start_inspection(p_job uuid, p_template uuid, p_title text default null, p_area text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; t pm.cm_checklist_templates%rowtype; v_id uuid; x jsonb; i int := 0;
begin
  select * into j from pm._cm_job(p_job);
  select * into t from pm.cm_checklist_templates c where c.id = p_template and c.org_id = j.org_id and (c.location_id is null or c.location_id = j.location_id);
  if t.id is null then raise exception 'PM_UNKNOWN_CHECKLIST: %', p_template using errcode = 'P0002'; end if;
  insert into pm.cm_inspections (org_id, job_id, template_id, title, category, area, inspector_name, inspector_membership, status, created_by)
  values (j.org_id, p_job, t.id, coalesce(p_title, t.name), t.category, p_area,
          (select concat_ws(' ', u.first_name, u.last_name) from core.users u where u.clerk_user_id = pm.current_user_id() limit 1),
          core.client_scope_caller_membership(), 'IN_PROGRESS', pm.current_user_id())
  returning id into v_id;
  for x in select value from jsonb_array_elements(t.items) loop
    i := i + 1;
    insert into pm.cm_inspection_items (org_id, job_id, inspection_id, sort, section, label, requires_photo)
    values (j.org_id, p_job, v_id, i, x ->> 'section', coalesce(x ->> 'label', 'Item ' || i), coalesce((x ->> 'requires_photo')::boolean, false));
  end loop;
  return v_id;
end $$;

-- Complete: every item answered; each failure opens an observation (CGC-75 → CGC-76).
create or replace function pm.cm_complete_inspection(p_inspection uuid, p_signer_name text default null, p_signature_png text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.cm_inspections%rowtype; it record; v_obs uuid; v_fail int; v_pass int; v_open int; v_result text; n int := 0;
begin
  select * into s from pm.cm_inspections where id = p_inspection for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: inspection % not found in the caller''s organization', p_inspection using errcode = '42501';
  end if;
  if s.status <> 'IN_PROGRESS' then raise exception 'PM_INSPECTION_STATE: inspection is %', lower(s.status) using errcode = '22023'; end if;
  select count(*) filter (where i.response is null), count(*) filter (where i.response = 'FAIL'), count(*) filter (where i.response = 'PASS')
    into v_open, v_fail, v_pass from pm.cm_inspection_items i where i.inspection_id = s.id;
  if v_open > 0 then raise exception 'PM_INSPECTION_OPEN_ITEMS: % item(s) have no answer yet', v_open using errcode = '22023'; end if;
  if exists (select 1 from pm.cm_inspection_items i where i.inspection_id = s.id and i.requires_photo and i.response <> 'NA' and cardinality(i.photo_ids) = 0) then
    raise exception 'PM_INSPECTION_PHOTO: some items need a photo' using errcode = '22023';
  end if;
  for it in select i.* from pm.cm_inspection_items i where i.inspection_id = s.id and i.response = 'FAIL' and i.observation_id is null order by i.sort loop
    insert into pm.cm_observations (org_id, job_id, obs_type, priority, title, description, status, photo_ids, inspection_item_id, due_on, created_by)
    values (s.org_id, s.job_id, case when s.category = 'SAFETY_AUDIT' then 'SAFETY' else 'QUALITY' end, 'HIGH', left(s.title || ': ' || it.label, 200),
            coalesce(it.note, 'Failed during inspection ' || coalesce(s.number, '')), 'OPEN', it.photo_ids, it.id, current_date + 7, pm.current_user_id())
    returning id into v_obs;
    update pm.cm_inspection_items set observation_id = v_obs where id = it.id;
    n := n + 1;
  end loop;
  v_result := case when v_fail = 0 then 'PASS' when v_pass = 0 then 'FAIL' else 'PARTIAL' end;
  update pm.cm_inspections set status = 'COMPLETE', result = v_result, signed_by_name = p_signer_name, signature_png = p_signature_png,
         signed_at = case when p_signer_name is not null then now() end where id = s.id;
  return jsonb_build_object('result', v_result, 'observations', n);
end $$;

create or replace function pm.cm_sign_jha(p_jha uuid, p_signoffs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare h pm.cm_jhas%rowtype;
begin
  select * into h from pm.cm_jhas where id = p_jha for update;
  if h.org_id is null or h.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: JHA % not found in the caller''s organization', p_jha using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_signoffs, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_signoffs, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: the crew signs the JHA' using errcode = '22023';
  end if;
  update pm.cm_jhas set status = 'SIGNED', signoffs = signoffs || (select jsonb_agg(x || jsonb_build_object('signed_at', now())) from jsonb_array_elements(p_signoffs) x)
   where id = h.id;
  return h.id;
end $$;

-- OSHA 300 log rows (privacy cases masked) and the 300A summary with TRIR / DART from hours.
create or replace function pm.cm_osha_300(p_location uuid, p_year int)
returns table (case_number text, person_name text, job_title text, occurred_on date, where_occurred text, description text, classification text,
               days_away int, days_restricted int, injury_or_illness text, job_id uuid, incident_id uuid)
language sql stable security invoker
set search_path = pm, core, public
as $$
  select i.case_number, case when i.privacy_case then 'Privacy case' else coalesce(i.person_name, '') end, i.job_title, i.occurred_at::date,
         i.where_occurred, left(concat_ws(', ', i.injury_nature, i.body_part, i.object_substance), 500), i.osha_classification,
         i.days_away, i.days_restricted, i.injury_or_illness, i.job_id, i.id
    from pm.cm_incidents i
   where i.location_id = p_location and i.osha_recordable and i.is_employee and extract(year from i.occurred_at) = p_year
   order by i.occurred_at, i.case_number
$$;

create or replace function pm.cm_osha_300a(p_location uuid, p_year int)
returns jsonb
language plpgsql stable security invoker
set search_path = pm, core, public
as $$
declare v jsonb; v_hours numeric; v_manual numeric; v_rec int; v_dart int;
begin
  select coalesce(sum(t.hours), 0) into v_hours from pm.time_entries t join core.jobs j on j.id = t.job_id
   where j.location_id = p_location and t.approval_state = 'APPROVED' and extract(year from t.work_date) = p_year;
  select coalesce(sum(h.hours), 0) into v_manual from pm.cm_safety_hours h where h.location_id = p_location and extract(year from h.period_month) = p_year;
  select count(*), count(*) filter (where i.osha_classification in ('DAYS_AWAY','RESTRICTED_OR_TRANSFER')) into v_rec, v_dart
    from pm.cm_incidents i where i.location_id = p_location and i.osha_recordable and i.is_employee and extract(year from i.occurred_at) = p_year;
  select jsonb_build_object(
    'year', p_year, 'deaths', count(*) filter (where i.osha_classification = 'DEATH'),
    'days_away_cases', count(*) filter (where i.osha_classification = 'DAYS_AWAY'),
    'restricted_cases', count(*) filter (where i.osha_classification = 'RESTRICTED_OR_TRANSFER'),
    'other_recordable_cases', count(*) filter (where i.osha_classification = 'OTHER_RECORDABLE'),
    'total_days_away', coalesce(sum(i.days_away), 0), 'total_days_restricted', coalesce(sum(i.days_restricted), 0),
    'injuries', count(*) filter (where coalesce(i.injury_or_illness, 'INJURY') = 'INJURY'),
    'skin_disorders', count(*) filter (where i.injury_or_illness = 'SKIN_DISORDER'),
    'respiratory', count(*) filter (where i.injury_or_illness = 'RESPIRATORY'),
    'poisonings', count(*) filter (where i.injury_or_illness = 'POISONING'),
    'hearing_loss', count(*) filter (where i.injury_or_illness = 'HEARING_LOSS'),
    'other_illnesses', count(*) filter (where i.injury_or_illness = 'OTHER_ILLNESS'))
    into v from pm.cm_incidents i where i.location_id = p_location and i.osha_recordable and i.is_employee and extract(year from i.occurred_at) = p_year;
  return v || jsonb_build_object('hours_worked', v_hours + v_manual, 'hours_from_time', v_hours, 'hours_manual', v_manual,
    'near_misses', (select count(*) from pm.cm_incidents i where i.location_id = p_location and i.incident_type = 'NEAR_MISS' and extract(year from i.occurred_at) = p_year),
    'trir', case when v_hours + v_manual > 0 then round(v_rec * 200000 / (v_hours + v_manual), 2) end,
    'dart', case when v_hours + v_manual > 0 then round(v_dart * 200000 / (v_hours + v_manual), 2) end);
end $$;

-- ----------------------------------------------------------------------------
-- 15. Closeout package + job close gate
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_closeout_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  category           text not null check (category in ('OM_MANUAL','WARRANTY','AS_BUILT','ATTIC_STOCK','TRAINING','FINAL_INSPECTION','CERTIFICATE_OF_OCCUPANCY',
                       'SUBSTANTIAL_COMPLETION','AFFIDAVIT_OF_PAYMENT','RELEASE_OF_LIENS','CONSENT_OF_SURETY','FINAL_LIEN_WAIVER','PUNCH_COMPLETE','KEYS',
                       'COMMISSIONING','OTHER')),
  title              text not null check (char_length(title) between 1 and 200),
  form_ref           text,
  commitment_id      uuid,
  vendor_id          uuid references core.vendors(id),
  spec_section       text,
  required           boolean not null default true,
  status             text not null default 'REQUIRED' check (status in ('REQUIRED','REQUESTED','SUBMITTED','ACCEPTED','REJECTED','WAIVED')),
  due_on             date,
  document_id        uuid,
  warranty_starts_on date,
  warranty_years     numeric(4,1),
  warranty_ends_on   date,
  accepted_by        text,
  accepted_at        timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  constraint cm_closeout_items_key unique nulls not distinct (org_id, job_id, category, commitment_id, title),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.tg_cm_closeout_item() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if new.warranty_starts_on is not null and new.warranty_years is not null then
    new.warranty_ends_on := (new.warranty_starts_on + make_interval(months => round(new.warranty_years * 12)::int))::date;
  end if;
  if new.status = 'ACCEPTED' and (tg_op = 'INSERT' or old.status is distinct from 'ACCEPTED') then
    new.accepted_at := now(); new.accepted_by := pm.current_user_id();
  end if;
  return new;
end $$;

create table if not exists pm.cm_job_closeouts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.organizations(id) on delete cascade,
  job_id      uuid not null,
  checked_at  timestamptz not null default now(),
  checked_by  text,
  blockers    jsonb not null default '[]',
  closed      boolean not null default false,
  closed_by   text,
  note        text,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Standard closeout checklist + one set per subcontract (CGC-103). Idempotent.
create or replace function pm.cm_generate_closeout(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; s pm.cm_contract_settings%rowtype; n int := 0; c record; x record;
begin
  select * into j from pm._cm_job(p_job);
  select * into s from pm.cm_contract_settings where org_id = j.org_id and job_id = p_job;
  for x in select * from (values
      ('SUBSTANTIAL_COMPLETION', 'Certificate of substantial completion', 'G704-equivalent', true),
      ('PUNCH_COMPLETE', 'Punch list complete and accepted', null, true),
      ('FINAL_INSPECTION', 'Final inspection passed', null, true),
      ('CERTIFICATE_OF_OCCUPANCY', 'Certificate of occupancy', null, true),
      ('AS_BUILT', 'Record drawings (as-builts)', null, true),
      ('AFFIDAVIT_OF_PAYMENT', 'Contractor''s affidavit of payment of debts and claims', 'G706-equivalent', true),
      ('RELEASE_OF_LIENS', 'Contractor''s affidavit of release of liens', 'G706A-equivalent', true),
      ('CONSENT_OF_SURETY', 'Consent of surety to final payment', 'G707-equivalent', coalesce(s.bonded, false)),
      ('TRAINING', 'Owner training sign-offs', null, true),
      ('KEYS', 'Keys, attic stock and spare parts turned over', null, true)) as v(cat, title, form, req) loop
    insert into pm.cm_closeout_items (org_id, job_id, category, title, form_ref, required, warranty_starts_on)
    values (j.org_id, p_job, x.cat, x.title, x.form, x.req, null)
    on conflict on constraint cm_closeout_items_key do nothing;
    if found then n := n + 1; end if;
  end loop;
  for c in select m.id, m.vendor_id, coalesce(v.display_name, v.name, m.number) as vname from pm.commitments m left join core.vendors v on v.id = m.vendor_id
            where m.org_id = j.org_id and m.job_id = p_job and m.commitment_type = 'SUBCONTRACT' and m.status in ('APPROVED','EXECUTED','CLOSED') loop
    for x in select * from (values ('FINAL_LIEN_WAIVER', 'Final lien waiver'), ('WARRANTY', 'Warranty letter'), ('OM_MANUAL', 'Operation and maintenance manuals'),
                                   ('AS_BUILT', 'As-built markups')) as v(cat, title) loop
      insert into pm.cm_closeout_items (org_id, job_id, category, title, commitment_id, vendor_id, required, warranty_starts_on, warranty_years)
      values (j.org_id, p_job, x.cat, x.title || ' — ' || c.vname, c.id, c.vendor_id, true,
              case when x.cat = 'WARRANTY' then s.substantial_completion_on end, case when x.cat = 'WARRANTY' then 1 end)
      on conflict on constraint cm_closeout_items_key do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

-- What stops the job from closing for posting (CGC-106 / FIN-73 / FIN-131). Counts only — no amounts —
-- so field roles can see what is open; the money truth is read on the definer path.
create or replace function pm.cm_job_close_gate(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; b jsonb := '[]'::jsonb; v_n int;
begin
  select * into j from pm._cm_job(p_job);
  if not pm.guard_final_billed(p_job) then
    b := b || jsonb_build_object('code', 'FINAL_BILLING', 'label', 'Final billing (and retainage release) not billed', 'count', 1);
  end if;
  select count(*) into v_n from pm.billing_requests r where r.org_id = j.org_id and r.job_id = p_job and r.status in ('DRAFT','REJECTED','EMITTED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'BILLING_IN_FLIGHT', 'label', 'Billing requests not yet issued by Merit Books', 'count', v_n); end if;
  select count(*) into v_n from pm.commitments c where c.org_id = j.org_id and c.job_id = p_job and c.status in ('APPROVED','EXECUTED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'COMMITMENTS_OPEN', 'label', 'Commitments still open', 'count', v_n); end if;
  select count(*) into v_n from pm.commitments c where c.org_id = j.org_id and c.job_id = p_job and c.commitment_type = 'SUBCONTRACT' and c.status <> 'VOID'
     and not exists (select 1 from pm.cm_lien_waivers w where w.commitment_id = c.id and w.waiver_type in ('CONDITIONAL_FINAL','UNCONDITIONAL_FINAL') and w.status = 'VERIFIED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'FINAL_WAIVERS', 'label', 'Subcontracts without a verified final lien waiver', 'count', v_n); end if;
  select count(*) into v_n from pm.v_commitment_status s where s.org_id = j.org_id and s.job_id = p_job and s.received_not_billed_cents > 0;
  if v_n > 0 then b := b || jsonb_build_object('code', 'RECEIVED_NOT_BILLED', 'label', 'Receipts not yet invoiced (accruals to clear)', 'count', v_n); end if;
  select count(*) into v_n from (select r.commitment_id from pm.cm_payable_retainage r where r.org_id = j.org_id and r.job_id = p_job
   group by r.commitment_id having sum(case r.entry_type when 'HELD' then r.amount_cents else -r.amount_cents end) > 0) x;
  if coalesce(v_n, 0) > 0 then b := b || jsonb_build_object('code', 'PAYABLE_RETAINAGE', 'label', 'Sub retainage not released', 'count', v_n); end if;
  select count(*) into v_n from pm.cm_sub_pay_apps a where a.org_id = j.org_id and a.job_id = p_job and a.status in ('DRAFT','SUBMITTED','IN_REVIEW','REVISE');
  if v_n > 0 then b := b || jsonb_build_object('code', 'SUB_PAY_APPS', 'label', 'Sub pay applications in review', 'count', v_n); end if;
  select count(*) into v_n from pm.cm_tm_tickets t where t.org_id = j.org_id and t.job_id = p_job and t.status in ('SIGNED','SUBMITTED','DISPUTED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'TM_UNBILLED', 'label', 'T&M tickets not billed', 'count', v_n); end if;
  select count(*) into v_n from pm.cm_change_events e where e.org_id = j.org_id and e.job_id = p_job and e.status in ('OPEN','PRICING','PRICED','SUBMITTED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'CHANGES_OPEN', 'label', 'Change events not resolved', 'count', v_n); end if;
  select count(*) into v_n from pm.punch_items p where p.org_id = j.org_id and p.job_id = p_job and p.status in ('OPEN','IN_PROGRESS','READY_FOR_REVIEW');
  if v_n > 0 then b := b || jsonb_build_object('code', 'PUNCH_OPEN', 'label', 'Punch items open', 'count', v_n); end if;
  select count(*) into v_n from pm.cm_closeout_items c where c.org_id = j.org_id and c.job_id = p_job and c.required and c.status not in ('ACCEPTED','WAIVED');
  if v_n > 0 then b := b || jsonb_build_object('code', 'CLOSEOUT_ITEMS', 'label', 'Closeout documents outstanding', 'count', v_n); end if;
  return jsonb_build_object('job_id', p_job, 'ready', jsonb_array_length(b) = 0, 'blockers', b);
end $$;

create or replace function pm.cm_close_job(p_job uuid, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; g jsonb;
begin
  select * into j from pm._cm_job(p_job);
  g := pm.cm_job_close_gate(p_job);
  insert into pm.cm_job_closeouts (org_id, job_id, checked_by, blockers, closed, closed_by, note)
  values (j.org_id, p_job, pm.current_user_id(), g -> 'blockers', (g ->> 'ready')::boolean, case when (g ->> 'ready')::boolean then pm.current_user_id() end, p_note);
  if not (g ->> 'ready')::boolean then
    raise exception 'PM_CLOSE_BLOCKED: %', (select string_agg(x ->> 'label' || ' (' || (x ->> 'count') || ')', '; ') from jsonb_array_elements(g -> 'blockers') x)
      using errcode = 'P0001';
  end if;
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'job.close_gate_passed', 'cm_job_closeouts', null, 'Job close gate passed — ready to close for posting', '{}'::jsonb);
  return g;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cm_rfis','cm_spec_sections','cm_submittals','cm_transmittals','cm_correspondence','cm_meetings','cm_meeting_items',
                           'cm_daily_logs','cm_log_entries','cm_observations','cm_checklist_templates','cm_inspections','cm_toolbox_talks','cm_jhas',
                           'cm_incidents','cm_closeout_items'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['cm_rfis','cm_rfi_responses','cm_submittals','cm_transmittals','cm_correspondence','cm_meetings','cm_daily_logs',
                           'cm_log_entries','cm_daily_log_voice','cm_observations','cm_inspections','cm_toolbox_talks','cm_jhas','cm_incidents'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;
create or replace trigger trg_cm_number before insert on pm.cm_rfis for each row execute function pm.tg_cm_number('CM_RFI', 'RFI-', '3');
create or replace trigger trg_cm_rfi_guard before insert or update on pm.cm_rfis for each row execute function pm.tg_cm_rfi_guard();
create or replace trigger trg_cm_child_job before insert or update of rfi_id on pm.cm_rfi_responses for each row execute function pm.tg_cm_child_job('cm_rfis', 'rfi_id');
create or replace trigger trg_cm_dates before insert or update on pm.cm_submittals for each row execute function pm.tg_cm_submittal_dates();
create or replace trigger trg_cm_child_job before insert or update of submittal_id on pm.cm_submittal_reviews for each row execute function pm.tg_cm_child_job('cm_submittals', 'submittal_id');
create or replace trigger trg_cm_number before insert on pm.cm_transmittals for each row execute function pm.tg_cm_number('CM_TR', 'TR-', '3');
create or replace trigger trg_cm_transmittal before insert or update on pm.cm_transmittals for each row execute function pm.tg_cm_transmittal();
create or replace trigger trg_cm_correspondence before insert or update on pm.cm_correspondence for each row execute function pm.tg_cm_correspondence();
create or replace trigger trg_cm_child_job before insert or update of meeting_id on pm.cm_meeting_attendees for each row execute function pm.tg_cm_child_job('cm_meetings', 'meeting_id');
create or replace trigger trg_cm_child_job before insert or update of origin_meeting_id on pm.cm_meeting_items for each row execute function pm.tg_cm_child_job('cm_meetings', 'origin_meeting_id');
create or replace trigger trg_cm_meeting_item before insert or update on pm.cm_meeting_items for each row execute function pm.tg_cm_meeting_item();
create or replace trigger trg_cm_child_job before insert or update of item_id on pm.cm_meeting_item_notes for each row execute function pm.tg_cm_child_job('cm_meeting_items', 'item_id');
create or replace trigger trg_cm_lock before insert or update or delete on pm.cm_daily_logs for each row execute function pm.tg_cm_daily_log_lock();
create or replace trigger trg_cm_child_job before insert or update of daily_log_id on pm.cm_log_entries for each row execute function pm.tg_cm_child_job('cm_daily_logs', 'daily_log_id');
create or replace trigger trg_cm_lock before insert or update or delete on pm.cm_log_entries for each row execute function pm.tg_cm_daily_log_lock();
create or replace trigger trg_cm_child_job before insert or update of daily_log_id on pm.cm_daily_log_voice for each row execute function pm.tg_cm_child_job('cm_daily_logs', 'daily_log_id');
drop trigger if exists trg_cm_lock on pm.field_logs;
create trigger trg_cm_lock before update or delete on pm.field_logs for each row execute function pm.tg_cm_daily_log_lock();
create or replace trigger trg_cm_number before insert on pm.cm_observations for each row execute function pm.tg_cm_number('CM_OBS', 'OBS-', '3');
create or replace trigger trg_cm_number before insert on pm.cm_inspections for each row execute function pm.tg_cm_number('CM_INSP', 'INS-', '3');
create or replace trigger trg_cm_child_job before insert or update of inspection_id on pm.cm_inspection_items for each row execute function pm.tg_cm_child_job('cm_inspections', 'inspection_id');
create or replace trigger trg_cm_child_job before insert or update of talk_id on pm.cm_toolbox_attendance for each row execute function pm.tg_cm_child_job('cm_toolbox_talks', 'talk_id');
create or replace trigger trg_cm_incident before insert or update on pm.cm_incidents for each row execute function pm.tg_cm_incident();
create or replace trigger trg_cm_closeout before insert or update on pm.cm_closeout_items for each row execute function pm.tg_cm_closeout_item();

-- ----------------------------------------------------------------------------
-- 16. Specialty trade: units, installed quantities, labor productivity + fade alerts
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_cost_code_units (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  cost_code_id        uuid not null,
  budget_qty          numeric(14,4) check (budget_qty is null or budget_qty >= 0),
  uom                 text,
  budget_hours        numeric(12,2) not null default 0 check (budget_hours >= 0),
  unit_hours          numeric(12,6),
  pct_complete_entry  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, cost_code_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_installed_quantities (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  cost_code_id         uuid not null,
  work_date            date not null default current_date,
  qty                  numeric(14,4) check (qty is null or qty >= 0),
  pct_complete         numeric(5,4) check (pct_complete is null or (pct_complete >= 0 and pct_complete <= 1)),
  uom                  text,
  foreman_employee_id  uuid references core.employees(id),
  crew_id              uuid,
  daily_log_id         uuid,
  area                 text,
  note                 text,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  check (qty is not null or pct_complete is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_installed_job_idx on pm.cm_installed_quantities (org_id, job_id, cost_code_id, work_date);

create table if not exists pm.cm_fade_alerts (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  cost_code_id         uuid not null,
  week_start           date not null,
  budget_hours         numeric(12,2),
  earned_hours         numeric(12,2),
  actual_hours         numeric(12,2),
  week_earned_hours    numeric(12,2),
  week_actual_hours    numeric(12,2),
  productivity_factor  numeric(8,4),
  pct_hours_used       numeric(8,4),
  pct_complete         numeric(8,4),
  projected_hours      numeric(12,2),
  severity             text not null check (severity in ('WATCH','FADE','CRITICAL')),
  cause_hint           text,
  status               text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','RESOLVED')),
  acknowledged_by      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, job_id, cost_code_id, week_start),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Earned vs actual hours by cost code (CGC-90). Hours only — never dollars.
create or replace function pm._cm_productivity(p_org uuid, p_job uuid, p_as_of date)
returns table (cost_code_id uuid, cost_code text, cost_code_name text, uom text, budget_qty numeric, budget_hours numeric, unit_hours numeric,
               installed_qty numeric, pct_complete numeric, earned_hours numeric, actual_hours numeric, productivity_factor numeric,
               pct_hours_used numeric, projected_hours numeric, variance_hours numeric)
language sql stable security definer
set search_path = pm, core, public
as $$
  with u as (
    select x.* from pm.cm_cost_code_units x where x.org_id = p_org and x.job_id = p_job
  ), q as (
    select iq.cost_code_id, coalesce(sum(iq.qty), 0) as qty,
           (array_agg(iq.pct_complete order by iq.work_date desc, iq.created_at desc) filter (where iq.pct_complete is not null))[1] as last_pct
      from pm.cm_installed_quantities iq
     where iq.org_id = p_org and iq.job_id = p_job and iq.work_date <= p_as_of
     group by iq.cost_code_id
  ), h as (
    select t.cost_code_id, coalesce(sum(t.hours), 0) as hours
      from pm.time_entries t
     where t.org_id = p_org and t.job_id = p_job and t.work_date <= p_as_of and t.approval_state in ('SUBMITTED','APPROVED') and t.cost_code_id is not null
     group by t.cost_code_id
  ), base as (
    select u.cost_code_id, cc.code, cc.name, u.uom, u.budget_qty, u.budget_hours,
           coalesce(u.unit_hours, case when coalesce(u.budget_qty, 0) > 0 then u.budget_hours / u.budget_qty end) as unit_hours,
           coalesce(q.qty, 0) as installed,
           least(case when u.pct_complete_entry or coalesce(u.budget_qty, 0) = 0 then coalesce(q.last_pct, 0)
                      else coalesce(q.qty, 0) / u.budget_qty end, 1) as pct,
           coalesce(h.hours, 0) as actual
      from u join pm.cost_codes cc on cc.id = u.cost_code_id
      left join q on q.cost_code_id = u.cost_code_id
      left join h on h.cost_code_id = u.cost_code_id
  )
  select b.cost_code_id, b.code, b.name, b.uom, b.budget_qty, b.budget_hours, round(b.unit_hours, 6), b.installed, round(b.pct, 4),
         round(b.pct * b.budget_hours, 2), b.actual,
         case when b.actual > 0 then round(b.pct * b.budget_hours / b.actual, 4) end,
         case when b.budget_hours > 0 then round(b.actual / b.budget_hours, 4) end,
         case when b.pct > 0 then round(b.actual / b.pct, 2) end,
         case when b.pct > 0 then round(b.actual / b.pct - b.budget_hours, 2) end
    from base b
   order by b.code
$$;

create or replace function pm.cm_labor_productivity(p_job uuid, p_as_of date default null)
returns table (cost_code_id uuid, cost_code text, cost_code_name text, uom text, budget_qty numeric, budget_hours numeric, unit_hours numeric,
               installed_qty numeric, pct_complete numeric, earned_hours numeric, actual_hours numeric, productivity_factor numeric,
               pct_hours_used numeric, projected_hours numeric, variance_hours numeric)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._cm_job(p_job);
  return query select * from pm._cm_productivity(j.org_id, p_job, coalesce(p_as_of, current_date));
end $$;

-- Weekly fade check (run Monday for last week): earned vs actual this week and to date per cost code.
create or replace function pm.cm_run_fade_alerts(p_job uuid, p_week_start date default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_ws date := coalesce(p_week_start, (date_trunc('week', current_date) - interval '7 days')::date); p record;
        v_wh numeric; v_ot numeric; v_wq numeric; v_wpct numeric; v_we numeric; v_sev text; v_hint text; n int := 0; v_delays text;
begin
  select * into j from pm._cm_job(p_job);
  for p in select * from pm._cm_productivity(j.org_id, p_job, v_ws + 6) x where x.budget_hours > 0 loop
    select coalesce(sum(t.hours), 0), coalesce(sum(t.hours) filter (where t.pay_type in ('OT','DT')), 0) into v_wh, v_ot
      from pm.time_entries t where t.org_id = j.org_id and t.job_id = p_job and t.cost_code_id = p.cost_code_id
       and t.work_date between v_ws and v_ws + 6 and t.approval_state in ('SUBMITTED','APPROVED');
    select coalesce(sum(iq.qty), 0), max(iq.pct_complete) into v_wq, v_wpct from pm.cm_installed_quantities iq
     where iq.org_id = j.org_id and iq.job_id = p_job and iq.cost_code_id = p.cost_code_id and iq.work_date between v_ws and v_ws + 6;
    v_we := case when p.unit_hours is not null and v_wq > 0 then v_wq * p.unit_hours else 0 end;
    v_sev := case when coalesce(p.pct_hours_used, 0) - coalesce(p.pct_complete, 0) >= 0.15 then 'CRITICAL'
                  when coalesce(p.pct_hours_used, 0) - coalesce(p.pct_complete, 0) >= 0.05 then 'FADE'
                  when v_wh > 0 and v_we / v_wh < 0.9 then 'WATCH' end;
    continue when v_sev is null;
    select string_agg(distinct lower(e.cause), ', ') into v_delays from pm.cm_log_entries e join pm.cm_daily_logs d on d.id = e.daily_log_id
     where d.org_id = j.org_id and d.job_id = p_job and e.kind = 'DELAY' and d.log_date between v_ws and v_ws + 6;
    v_hint := concat_ws('; ',
      case when v_wh > 0 and v_ot / v_wh > 0.2 then format('overtime %s%% of the week''s hours', round(v_ot * 100 / v_wh)) end,
      case when v_wh > 0 and v_wq = 0 and v_wpct is null then 'hours with no installed quantity (waiting on material, rework or not logged)' end,
      case when v_delays is not null then 'delays logged: ' || v_delays end);
    insert into pm.cm_fade_alerts (org_id, job_id, cost_code_id, week_start, budget_hours, earned_hours, actual_hours, week_earned_hours, week_actual_hours,
      productivity_factor, pct_hours_used, pct_complete, projected_hours, severity, cause_hint)
    values (j.org_id, p_job, p.cost_code_id, v_ws, p.budget_hours, p.earned_hours, p.actual_hours, round(v_we, 2), v_wh, p.productivity_factor,
            p.pct_hours_used, p.pct_complete, p.projected_hours, v_sev, nullif(v_hint, ''))
    on conflict (org_id, job_id, cost_code_id, week_start) do update set
      earned_hours = excluded.earned_hours, actual_hours = excluded.actual_hours, week_earned_hours = excluded.week_earned_hours,
      week_actual_hours = excluded.week_actual_hours, productivity_factor = excluded.productivity_factor, pct_hours_used = excluded.pct_hours_used,
      pct_complete = excluded.pct_complete, projected_hours = excluded.projected_hours, severity = excluded.severity, cause_hint = excluded.cause_hint,
      updated_at = now();
    n := n + 1;
  end loop;
  if n > 0 then
    perform pm._cm_notify(j.org_id, 'productivity.fade', p_job, 'cm_fade_alerts', null,
      pm._cm_members_with(j.org_id, j.location_id, 'projects.time', 'approve'),
      format('%s cost code(s) fading on %s', n, (select cj.job_number from core.jobs cj where cj.id = p_job)), 'Earned hours are behind hours used',
      '/jobs/' || p_job || '?tab=productivity', 'fade:' || p_job || ':' || v_ws);
  end if;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- 17. Workforce planning across jobs + foreman daily plan
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_workforce_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  job_id        uuid not null,
  trade         text,
  skill_key     text,
  role          text not null default 'JOURNEYMAN' check (role in ('FOREMAN','JOURNEYMAN','APPRENTICE','HELPER','OPERATOR','OTHER')),
  headcount     int not null default 1 check (headcount between 1 and 500),
  start_week    date not null,
  end_week      date not null,
  status        text not null default 'OPEN' check (status in ('OPEN','PARTIAL','FILLED','CANCELLED')),
  note          text,
  requested_by  text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  check (end_week >= start_week),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.cm_workforce_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  job_id       uuid not null,
  employee_id  uuid not null references core.employees(id),
  request_id   uuid,
  role         text not null default 'JOURNEYMAN' check (role in ('FOREMAN','JOURNEYMAN','APPRENTICE','HELPER','OPERATOR','OTHER')),
  week_start   date not null,
  days         int not null default 5 check (days between 0 and 7),
  per_diem     boolean not null default false,
  travel       boolean not null default false,
  status       text not null default 'PLANNED' check (status in ('PLANNED','CONFIRMED','RELEASED')),
  note         text,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, employee_id, job_id, week_start),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_cm_wf_assign_week_idx on pm.cm_workforce_assignments (org_id, location_id, week_start);

-- Workforce rows carry the job's company; weeks are Mondays.
create or replace function pm.tg_cm_workforce() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  select j.location_id into new.location_id from core.jobs j where j.id = new.job_id and j.org_id = new.org_id;
  if new.location_id is null then raise exception 'PM_UNKNOWN_JOB: %', new.job_id using errcode = '23503'; end if;
  if tg_table_name = 'cm_workforce_assignments' then
    new.week_start := date_trunc('week', new.week_start)::date;
  else
    new.start_week := date_trunc('week', new.start_week)::date;
    new.end_week := date_trunc('week', new.end_week)::date;
  end if;
  return new;
end $$;

-- The foreman's morning screen (CGC-93): crew, today's tasks, deliveries, JHA, hazards, recent sheets,
-- yesterday's productivity. Hours and quantities only.
create or replace function pm.cm_foreman_plan(p_job uuid, p_date date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_d date := coalesce(p_date, current_date); v_ws date;
begin
  select * into j from pm._cm_job(p_job);
  v_ws := date_trunc('week', v_d)::date;
  return jsonb_build_object(
    'date', v_d,
    'crew', coalesce((select jsonb_agg(jsonb_build_object('employee_id', a.employee_id, 'role', a.role,
                        'name', (select concat_ws(' ', e.first_name, e.last_name) from core.employees e where e.id = a.employee_id)) order by a.role, a.employee_id)
                       from pm.cm_workforce_assignments a where a.org_id = j.org_id and a.job_id = p_job and a.week_start = v_ws and a.status <> 'RELEASED'), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'start_on', t.start_on, 'due_on', t.due_on,
                         'cost_code_id', t.cost_code_id, 'pct_complete', t.pct_complete) order by t.start_on nulls last, t.sort)
                        from pm.tasks t where t.org_id = j.org_id and t.job_id = p_job and t.status not in ('DONE','CANCELLED')
                         and coalesce(t.start_on, v_d) <= v_d + 1 and coalesce(t.due_on, v_d) >= v_d), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('title', s.title, 'number', s.number, 'status', s.procurement_status, 'delivered_on', s.delivered_on,
                              'ship_on', s.ship_on) order by s.ship_on)
                             from pm.cm_submittals s where s.org_id = j.org_id and s.job_id = p_job
                              and (s.delivered_on = v_d or (s.ship_on between v_d - 2 and v_d + 1 and s.delivered_on is null))), '[]'::jsonb),
    'jha', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'task', h.task_description, 'status', h.status, 'steps', h.steps, 'ppe', to_jsonb(h.ppe)))
                      from pm.cm_jhas h where h.org_id = j.org_id and h.job_id = p_job and h.work_date = v_d), '[]'::jsonb),
    'hazards', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'title', o.title, 'priority', o.priority) order by o.priority desc)
                          from pm.cm_observations o where o.org_id = j.org_id and o.job_id = p_job and o.obs_type = 'SAFETY' and o.status in ('OPEN','IN_PROGRESS')), '[]'::jsonb),
    'sheets', coalesce((select jsonb_agg(jsonb_build_object('id', ds.id, 'sheet_number', ds.sheet_number, 'title', ds.title) order by ds.updated_at desc)
                         from (select x.* from pm.drawing_sheets x where x.org_id = j.org_id and x.job_id = p_job order by x.updated_at desc limit 10) ds), '[]'::jsonb),
    'yesterday', coalesce((select jsonb_agg(jsonb_build_object('cost_code', p.cost_code, 'earned_hours', p.earned_hours, 'actual_hours', p.actual_hours,
                             'productivity_factor', p.productivity_factor, 'pct_complete', p.pct_complete))
                            from pm._cm_productivity(j.org_id, p_job, v_d - 1) p where p.actual_hours > 0), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- 18. Trade proposals (sub → GC), project templates (global update), directory with trade data
-- ----------------------------------------------------------------------------
create table if not exists pm.cm_proposals (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  customer_id           uuid references core.customers(id),
  lead_id               uuid,
  number                text,
  project_name          text not null check (char_length(project_name) between 1 and 200),
  base_bid_cents        bigint not null default 0 check (base_bid_cents >= 0),
  alternates            jsonb not null default '[]' check (jsonb_typeof(alternates) = 'array'),   -- [{label, amount_cents, accepted}]
  unit_prices           jsonb not null default '[]' check (jsonb_typeof(unit_prices) = 'array'),  -- [{item, uom, unit_cents}]
  inclusions            text[] not null default '{}',
  exclusions            text[] not null default '{}',
  qualifications        text[] not null default '{}',
  schedule_assumptions  text,
  valid_until           date,
  status                text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','EXPIRED','VOID')),
  sent_at               timestamptz,
  accepted_at           timestamptz,
  declined_reason       text,
  esign_envelope_id     uuid,
  document_id           uuid,
  job_id                uuid,
  estimate_id           uuid,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number)
);

create or replace function pm.tg_cm_proposal_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n bigint; v_short text;
begin
  if coalesce(btrim(new.number), '') = '' then
    select l.short_code into v_short from core.locations l where l.id = new.location_id;
    n := pm.next_doc_number(new.org_id, new.location_id::text, 'CM_PROP', to_char(current_date, 'YYYY'));
    new.number := 'PR-' || coalesce(v_short, 'X') || '-' || to_char(current_date, 'YYYY') || '-' || lpad(n::text, 3, '0');
  end if;
  return new;
end $$;

create or replace function pm.tg_cm_proposal() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if pm.access_member_role() and tg_op = 'UPDATE' and old.status not in ('DRAFT') and
     (new.base_bid_cents, new.alternates, new.exclusions, new.inclusions) is distinct from (old.base_bid_cents, old.alternates, old.exclusions, old.inclusions) then
    raise exception 'PM_PROPOSAL_LOCKED: % was sent — revise by a new proposal', old.number using errcode = '42501';
  end if;
  if pm.access_member_role() and (tg_op = 'INSERT' and new.status <> 'DRAFT' or tg_op = 'UPDATE' and new.status is distinct from old.status) then
    raise exception 'PM_PROPOSAL_STATE: send and accept through the proposal actions' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function pm.cm_proposal_send(p_proposal uuid, p_envelope uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_proposals%rowtype;
begin
  select * into p from pm.cm_proposals where id = p_proposal for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: proposal % not found in the caller''s organization', p_proposal using errcode = '42501';
  end if;
  if p.status not in ('DRAFT','SENT') then raise exception 'PM_PROPOSAL_STATE: % is %', p.number, p.status using errcode = '22023'; end if;
  if p.base_bid_cents <= 0 then raise exception 'PM_INVALID: the base bid is empty' using errcode = '22023'; end if;
  update pm.cm_proposals set status = 'SENT', sent_at = coalesce(sent_at, now()), esign_envelope_id = coalesce(p_envelope, esign_envelope_id),
         valid_until = coalesce(valid_until, current_date + 30) where id = p.id;
  return p.id;
end $$;

-- Accepted proposal → the job (Projects job + prime contract = base bid + accepted alternates).
create or replace function pm.cm_proposal_accept(p_proposal uuid, p_job_type_key text, p_alternates int[] default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.cm_proposals%rowtype; v_amt bigint; v_job uuid; v_alts jsonb;
begin
  select * into p from pm.cm_proposals where id = p_proposal for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: proposal % not found in the caller''s organization', p_proposal using errcode = '42501';
  end if;
  if p.status not in ('SENT','DRAFT') then raise exception 'PM_PROPOSAL_STATE: % is %', p.number, p.status using errcode = '22023'; end if;
  if p.valid_until is not null and p.valid_until < current_date then raise exception 'PM_PROPOSAL_EXPIRED: % expired %', p.number, p.valid_until using errcode = '22023'; end if;
  select coalesce(jsonb_agg(case when (ord - 1) = any (coalesce(p_alternates, '{}')) then a || '{"accepted": true}'::jsonb else a || '{"accepted": false}'::jsonb end order by ord), '[]'::jsonb),
         p.base_bid_cents + coalesce(sum((a ->> 'amount_cents')::bigint) filter (where (ord - 1) = any (coalesce(p_alternates, '{}'))), 0)
    into v_alts, v_amt from jsonb_array_elements(p.alternates) with ordinality as t(a, ord);
  v_amt := coalesce(v_amt, p.base_bid_cents);
  v_job := pm.create_project(p.location_id, p_job_type_key, p.project_name, p.customer_id, v_amt, false, jsonb_build_object('_cm_proposal_id', p.id::text));
  insert into pm.cm_contract_settings (org_id, job_id) values (p.org_id, v_job) on conflict (org_id, job_id) do nothing;
  update pm.cm_proposals set status = 'ACCEPTED', accepted_at = now(), job_id = v_job, alternates = v_alts where id = p.id;
  return v_job;
end $$;

create table if not exists pm.cm_project_templates (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid references core.locations(id),
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name         text not null check (char_length(name) between 1 and 120),
  kind         text not null default 'CUSTOM' check (kind in ('GROUND_UP','TENANT_IMPROVEMENT','OCCUPIED_RENOVATION','HEALTHCARE_ICRA','PUBLIC_PREVAILING_WAGE',
                 'INSTALL_ONLY','FURNISH_AND_INSTALL','SERVICE_TO_PROJECT','CUSTOM')),
  description  text,
  version      int not null default 1 check (version >= 1),
  payload      jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  constraint cm_project_templates_key unique nulls not distinct (org_id, location_id, key)
);

create table if not exists pm.cm_template_applications (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  job_id       uuid not null,
  template_id  uuid not null,
  version      int not null,
  applied_by   text,
  applied_at   timestamptz not null default now(),
  result       jsonb not null default '{}',
  unique (org_id, job_id, template_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- A template payload bumps its version on every change (the global-update trigger compares versions).
create or replace function pm.tg_cm_template_version() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if tg_op = 'UPDATE' and new.payload is distinct from old.payload then new.version := old.version + 1; end if;
  return new;
end $$;

create or replace function pm._cm_apply_template(p_job uuid, p_template uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_project_templates%rowtype; j record; v_cs jsonb; x jsonb; n_markup int := 0; n_steps int := 0; n_req int := 0; n_close int := 0; n_meet int := 0;
begin
  select * into t from pm.cm_project_templates where id = p_template;
  select cj.org_id, cj.location_id into j from core.jobs cj where cj.id = p_job;
  v_cs := coalesce(t.payload -> 'contract_settings', '{}'::jsonb);
  insert into pm.cm_contract_settings (org_id, job_id) values (j.org_id, p_job) on conflict (org_id, job_id) do nothing;
  update pm.cm_contract_settings set
    change_tiers = coalesce((v_cs ->> 'change_tiers')::int, change_tiers),
    billing_cutoff_day = coalesce((v_cs ->> 'billing_cutoff_day')::int, billing_cutoff_day),
    billing_form = coalesce(v_cs ->> 'billing_form', billing_form),
    retainage_step_mode = coalesce(v_cs ->> 'retainage_step_mode', retainage_step_mode),
    stored_retainage_pct = coalesce((v_cs ->> 'stored_retainage_pct')::numeric, stored_retainage_pct),
    architect_certification = coalesce((v_cs ->> 'architect_certification')::boolean, architect_certification),
    rfi_default_days = coalesce((v_cs ->> 'rfi_default_days')::int, rfi_default_days),
    submittal_review_days = coalesce((v_cs ->> 'submittal_review_days')::int, submittal_review_days),
    bonded = coalesce((v_cs ->> 'bonded')::boolean, bonded),
    prevailing_wage = coalesce((v_cs ->> 'prevailing_wage')::boolean, prevailing_wage),
    px_threshold_cents = coalesce((v_cs ->> 'px_threshold_cents')::bigint, px_threshold_cents)
   where org_id = j.org_id and job_id = p_job;
  -- template-sourced rows are replaced on re-apply; hand-made rows are kept
  if t.payload ? 'markup_rules' then
    delete from pm.cm_markup_rules where org_id = j.org_id and job_id = p_job and source_template_id = t.id;
    for x in select value from jsonb_array_elements(t.payload -> 'markup_rules') loop
      insert into pm.cm_markup_rules (org_id, job_id, kind, label, applies_to, cost_type, pct, compounding, tier_max_cents, sort, source_template_id)
      values (j.org_id, p_job, x ->> 'kind', x ->> 'label', coalesce(x ->> 'applies_to', 'ALL'), x ->> 'cost_type', (x ->> 'pct')::numeric,
              coalesce((x ->> 'compounding')::boolean, false), (x ->> 'tier_max_cents')::bigint, coalesce((x ->> 'sort')::int, n_markup), t.id);
      n_markup := n_markup + 1;
    end loop;
  end if;
  if t.payload ? 'retainage_steps' then
    delete from pm.cm_retainage_steps where org_id = j.org_id and job_id = p_job and source_template_id = t.id;
    for x in select value from jsonb_array_elements(t.payload -> 'retainage_steps') loop
      insert into pm.cm_retainage_steps (org_id, job_id, side, from_pct, rate, note, source_template_id)
      values (j.org_id, p_job, coalesce(x ->> 'side', 'RECEIVABLE'), (x ->> 'from_pct')::numeric, (x ->> 'rate')::numeric, x ->> 'note', t.id)
      on conflict do nothing;
      n_steps := n_steps + 1;
    end loop;
  end if;
  if t.payload ? 'compliance_requirements' then
    delete from pm.cm_compliance_requirements where org_id = j.org_id and job_id = p_job and source_template_id = t.id;
    for x in select value from jsonb_array_elements(t.payload -> 'compliance_requirements') loop
      insert into pm.cm_compliance_requirements (org_id, location_id, job_id, requirement, min_limit_cents, max_value, endorsement_forms, required, source_template_id)
      values (j.org_id, j.location_id, p_job, x ->> 'requirement', (x ->> 'min_limit_cents')::bigint, (x ->> 'max_value')::numeric,
              coalesce(array(select jsonb_array_elements_text(x -> 'endorsement_forms')), '{}'), coalesce((x ->> 'required')::boolean, true), t.id);
      n_req := n_req + 1;
    end loop;
  end if;
  if t.payload ? 'closeout' then
    for x in select value from jsonb_array_elements(t.payload -> 'closeout') loop
      insert into pm.cm_closeout_items (org_id, job_id, category, title, form_ref, required)
      values (j.org_id, p_job, x ->> 'category', x ->> 'title', x ->> 'form_ref', coalesce((x ->> 'required')::boolean, true))
      on conflict on constraint cm_closeout_items_key do nothing;
      if found then n_close := n_close + 1; end if;
    end loop;
  end if;
  if t.payload ? 'meetings' then
    for x in select value from jsonb_array_elements(t.payload -> 'meetings') loop
      if not exists (select 1 from pm.cm_meetings m where m.org_id = j.org_id and m.job_id = p_job and m.series_key = coalesce(x ->> 'series_key', x ->> 'type')) then
        insert into pm.cm_meetings (org_id, job_id, meeting_type, series_key, number, title, status, agenda, created_by)
        values (j.org_id, p_job, coalesce(x ->> 'type', 'OAC'), coalesce(x ->> 'series_key', x ->> 'type', 'OAC'), 1,
                coalesce(x ->> 'title', 'Meeting') || ' #1', 'SCHEDULED', x ->> 'agenda', pm.current_user_id());
        n_meet := n_meet + 1;
      end if;
    end loop;
  end if;
  insert into pm.cm_template_applications (org_id, job_id, template_id, version, applied_by, result)
  values (j.org_id, p_job, t.id, t.version, pm.current_user_id(),
          jsonb_build_object('markup_rules', n_markup, 'retainage_steps', n_steps, 'compliance_requirements', n_req, 'closeout_items', n_close, 'meetings', n_meet))
  on conflict (org_id, job_id, template_id) do update set version = excluded.version, applied_by = excluded.applied_by, applied_at = now(), result = excluded.result;
  return jsonb_build_object('template', t.key, 'version', t.version, 'markup_rules', n_markup, 'retainage_steps', n_steps,
                            'compliance_requirements', n_req, 'closeout_items', n_close, 'meetings', n_meet);
end $$;

create or replace function pm.cm_apply_project_template(p_job uuid, p_template uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._cm_job(p_job);
  if not exists (select 1 from pm.cm_project_templates t where t.id = p_template and t.org_id = j.org_id and t.is_active
                   and (t.location_id is null or t.location_id = j.location_id)) then
    raise exception 'PM_UNKNOWN_TEMPLATE: %', p_template using errcode = 'P0002';
  end if;
  return pm._cm_apply_template(p_job, p_template);
end $$;

-- Global update (CGC-06): push a changed template to every open job that applied an older version.
create or replace function pm.cm_push_project_template(p_template uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.cm_project_templates%rowtype; a record; n int := 0;
begin
  select * into t from pm.cm_project_templates where id = p_template;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: template % not found in the caller''s organization', p_template using errcode = '42501';
  end if;
  for a in select x.job_id from pm.cm_template_applications x join core.jobs j on j.id = x.job_id
            where x.org_id = t.org_id and x.template_id = t.id and x.version < t.version and j.status not in ('CLOSED','CANCELLED','VOID') loop
    perform pm._cm_apply_template(a.job_id, t.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Standard templates + QA / safety checklists for a company (idempotent; edits survive a re-seed).
create or replace function pm.cm_seed_commercial(p_location uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; n int := 0; v_common jsonb; v_closeout jsonb; v_coi jsonb;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  v_coi := '[{"requirement":"GL_EACH_OCCURRENCE","min_limit_cents":100000000},{"requirement":"GL_AGGREGATE","min_limit_cents":200000000},
             {"requirement":"AUTO_COMBINED","min_limit_cents":100000000},{"requirement":"UMBRELLA","min_limit_cents":500000000},
             {"requirement":"WORKERS_COMP"},{"requirement":"ADDITIONAL_INSURED_ONGOING","endorsement_forms":["CG 20 10"]},
             {"requirement":"ADDITIONAL_INSURED_COMPLETED","endorsement_forms":["CG 20 37"]},{"requirement":"WAIVER_OF_SUBROGATION"},
             {"requirement":"PRIMARY_NONCONTRIBUTORY"},{"requirement":"W9"}]'::jsonb;
  v_closeout := '[{"category":"COMMISSIONING","title":"Commissioning report"},{"category":"ATTIC_STOCK","title":"Attic stock delivered"}]'::jsonb;
  v_common := jsonb_build_object(
    'markup_rules', '[{"kind":"OHP","label":"Overhead and profit — self-performed","applies_to":"SELF_PERFORM","pct":0.15,"sort":1},
                      {"kind":"OHP","label":"Markup on subcontracted work","applies_to":"SUBCONTRACT","pct":0.05,"sort":2},
                      {"kind":"BOND","label":"Bond","pct":0.01,"compounding":true,"sort":3},
                      {"kind":"INSURANCE","label":"Insurance","pct":0.01,"compounding":true,"sort":4}]'::jsonb,
    'retainage_steps', '[{"from_pct":0.5,"rate":0.05,"note":"Retainage to 5% at 50% complete"}]'::jsonb,
    'compliance_requirements', v_coi, 'closeout', v_closeout,
    'meetings', '[{"type":"OAC","title":"Owner–architect–contractor meeting"},{"type":"SUB_COORDINATION","title":"Subcontractor coordination"}]'::jsonb);
  insert into pm.cm_project_templates as t (org_id, location_id, key, name, kind, description, payload) values
    (v_org, p_location, 'ground_up', 'Ground-up construction', 'GROUND_UP', 'New building: three-tier changes, AIA billing, 10% retainage to 5% at 50%.',
     v_common || '{"contract_settings":{"change_tiers":3,"billing_cutoff_day":25,"architect_certification":true,"bonded":true}}'::jsonb),
    (v_org, p_location, 'tenant_improvement', 'Tenant improvement', 'TENANT_IMPROVEMENT', 'Interior fit-out: two-tier changes, AIA billing.',
     v_common || '{"contract_settings":{"change_tiers":2,"billing_cutoff_day":25,"architect_certification":true}}'::jsonb),
    (v_org, p_location, 'occupied_renovation', 'Occupied renovation', 'OCCUPIED_RENOVATION', 'Phased work in an occupied building: two-tier changes, safety meetings.',
     v_common || '{"contract_settings":{"change_tiers":2},"meetings":[{"type":"OAC","title":"Owner–architect–contractor meeting"},{"type":"SAFETY","title":"Occupant safety and phasing"}]}'::jsonb),
    (v_org, p_location, 'healthcare_icra', 'Healthcare (ICRA)', 'HEALTHCARE_ICRA', 'Infection-control risk assessment, above-ceiling inspections, three-tier changes.',
     v_common || '{"contract_settings":{"change_tiers":3,"architect_certification":true},"closeout":[{"category":"COMMISSIONING","title":"Commissioning report"},{"category":"FINAL_INSPECTION","title":"ICRA close-out inspection"}]}'::jsonb),
    (v_org, p_location, 'public_prevailing_wage', 'Public / prevailing wage', 'PUBLIC_PREVAILING_WAGE', 'Public owner: bonded, prevailing wage, certified payroll gates payment.',
     v_common || jsonb_build_object('contract_settings', '{"change_tiers":3,"bonded":true,"prevailing_wage":true}'::jsonb,
                                    'compliance_requirements', v_coi || '[{"requirement":"CERTIFIED_PAYROLL"},{"requirement":"PAYMENT_BOND"},{"requirement":"PERFORMANCE_BOND"}]'::jsonb)),
    (v_org, p_location, 'install_only', 'Install only (trade)', 'INSTALL_ONLY', 'Specialty sub, labor only: one-tier CORs to the GC, GC billing form.',
     jsonb_build_object('contract_settings', '{"change_tiers":1,"billing_form":"GC_FORM","architect_certification":false}'::jsonb,
                        'markup_rules', '[{"kind":"OHP","label":"Overhead and profit","pct":0.15,"sort":1}]'::jsonb,
                        'retainage_steps', '[]'::jsonb)),
    (v_org, p_location, 'furnish_and_install', 'Furnish and install (trade)', 'FURNISH_AND_INSTALL', 'Specialty sub with material: stored materials billed with backup.',
     jsonb_build_object('contract_settings', '{"change_tiers":1,"billing_form":"GC_FORM","architect_certification":false}'::jsonb,
                        'markup_rules', '[{"kind":"OHP","label":"Labor overhead and profit","cost_type":"LABOR","pct":0.20,"sort":1},{"kind":"OHP","label":"Material markup","cost_type":"MATERIALS","pct":0.10,"sort":2}]'::jsonb)),
    (v_org, p_location, 'service_to_project', 'Service to project (trade)', 'SERVICE_TO_PROJECT', 'Small trade project billed T&M or lump sum; no certification.',
     jsonb_build_object('contract_settings', '{"change_tiers":1,"architect_certification":false}'::jsonb))
  on conflict on constraint cm_project_templates_key do nothing;
  get diagnostics n = row_count;
  insert into pm.cm_checklist_templates (org_id, location_id, key, name, category, items) values
    (v_org, p_location, 'pre_pour', 'Pre-pour', 'PRE_POUR', '[{"label":"Forms aligned, braced and oiled"},{"label":"Rebar size, spacing and clear cover per drawings","requires_photo":true},{"label":"Embeds, sleeves and blockouts in place"},{"label":"Vapor barrier lapped and taped"},{"label":"Special inspector sign-off"}]'),
    (v_org, p_location, 'mep_rough_in', 'MEP rough-in', 'MEP_ROUGH_IN', '[{"label":"Penetrations sleeved and labeled"},{"label":"Conduit / pipe supported per spec","requires_photo":true},{"label":"Pressure / megger test recorded"},{"label":"Inspector cover sign-off"}]'),
    (v_org, p_location, 'above_ceiling', 'Above-ceiling', 'ABOVE_CEILING', '[{"label":"Firestopping complete at rated walls","requires_photo":true},{"label":"Ductwork sealed, insulated and labeled"},{"label":"Cable tray / J-hooks supported"},{"label":"Access panels at valves and dampers"},{"label":"Ceiling grid supported independently"}]'),
    (v_org, p_location, 'firestopping', 'Firestopping', 'FIRESTOPPING', '[{"label":"UL system number posted"},{"label":"Annular space within listing"},{"label":"Labels at each penetration","requires_photo":true}]'),
    (v_org, p_location, 'envelope', 'Building envelope', 'ENVELOPE', '[{"label":"Air / water barrier continuous and lapped"},{"label":"Window flashing sequence per detail","requires_photo":true},{"label":"Water test results recorded"}]'),
    (v_org, p_location, 'final', 'Final walk', 'FINAL', '[{"label":"Punch items closed"},{"label":"Systems commissioned"},{"label":"Spaces clean"},{"label":"Attic stock delivered"}]'),
    (v_org, p_location, 'safety_audit', 'Weekly site safety audit', 'SAFETY_AUDIT', '[{"label":"Fall protection at edges and openings"},{"label":"Ladders and scaffolds tagged"},{"label":"Housekeeping and access"},{"label":"Fire extinguishers and exits"},{"label":"PPE worn"},{"label":"Electrical cords and GFCI"}]'),
    (v_org, p_location, 'trade_qa_electrical', 'Electrical trade QA', 'TRADE_QA', '[{"label":"Megger test on feeders","requires_photo":true},{"label":"Torque log on terminations"},{"label":"Panel schedules typed and posted"},{"label":"Grounding / bonding verified"}]')
  on conflict do nothing;
  return n;
end $$;

create table if not exists pm.cm_company_profiles (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid references core.locations(id),
  vendor_id                uuid references core.vendors(id),
  customer_id              uuid references core.customers(id),
  csi_divisions            text[] not null default '{}',
  trades                   text[] not null default '{}',
  licenses                 jsonb not null default '[]' check (jsonb_typeof(licenses) = 'array'),
  union_local              text,
  dbe                      boolean not null default false,
  mbe                      boolean not null default false,
  wbe                      boolean not null default false,
  sdvob                    boolean not null default false,
  emr                      numeric(5,2),
  emr_year                 int,
  bonding_single_cents     bigint,
  bonding_aggregate_cents  bigint,
  prequal_status           text not null default 'NONE' check (prequal_status in ('NONE','PENDING','QUALIFIED','EXPIRED','DISQUALIFIED')),
  prequal_expires          date,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, id),
  constraint cm_company_profiles_party unique nulls not distinct (org_id, vendor_id, customer_id),
  check (vendor_id is not null or customer_id is not null)
);

create table if not exists pm.cm_project_directory (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  party_role           text not null check (party_role in ('OWNER','OWNERS_REP','ARCHITECT','ENGINEER','CONSULTANT','GC','SUBCONTRACTOR','SUPPLIER',
                         'INSPECTOR','LENDER','SURETY','OTHER')),
  vendor_id            uuid references core.vendors(id),
  customer_id          uuid references core.customers(id),
  contact_id           uuid,
  membership_id        uuid,
  company_name         text,
  contact_name         text,
  email                text,
  phone                text,
  trade                text,
  csi_divisions        text[] not null default '{}',
  distribution_groups  text[] not null default '{}',
  is_primary           boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  constraint cm_project_directory_party unique nulls not distinct (org_id, job_id, party_role, vendor_id, customer_id, contact_name),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Directory from the shared masters: the job's customer (owner / GC by pack) and every vendor on a commitment.
create or replace function pm.cm_seed_project_directory(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; n int := 0; v_role text; c record;
begin
  select * into j from pm._cm_job(p_job);
  v_role := case when exists (select 1 from pm.pack_installs i where i.org_id = j.org_id and i.location_id = j.location_id and i.role = 'primary'
                                  and i.status = 'ACTIVE' and i.pack_key = 'specialty_trade') then 'GC' else 'OWNER' end;
  insert into pm.cm_project_directory (org_id, job_id, party_role, customer_id, company_name, is_primary)
  select j.org_id, p_job, v_role, cu.id, coalesce(cu.display_name, cu.name), true
    from core.jobs cj join core.customers cu on cu.id = cj.customer_id where cj.id = p_job
  on conflict on constraint cm_project_directory_party do nothing;
  get diagnostics n = row_count;
  for c in select distinct m.vendor_id, m.commitment_type, coalesce(v.display_name, v.name) as vname,
                  (select p.trades[1] from pm.cm_company_profiles p where p.org_id = j.org_id and p.vendor_id = m.vendor_id) as trade,
                  (select p.csi_divisions from pm.cm_company_profiles p where p.org_id = j.org_id and p.vendor_id = m.vendor_id) as divs
             from pm.commitments m join core.vendors v on v.id = m.vendor_id
            where m.org_id = j.org_id and m.job_id = p_job and m.status <> 'VOID' and m.vendor_id is not null loop
    insert into pm.cm_project_directory (org_id, job_id, party_role, vendor_id, company_name, trade, csi_divisions, distribution_groups)
    values (j.org_id, p_job, case when c.commitment_type = 'SUBCONTRACT' then 'SUBCONTRACTOR' else 'SUPPLIER' end, c.vendor_id, c.vname, c.trade,
            coalesce(c.divs, '{}'), array['subs'])
    on conflict on constraint cm_project_directory_party do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cm_cost_code_units','cm_installed_quantities','cm_fade_alerts','cm_workforce_requests','cm_workforce_assignments','cm_proposals',
                           'cm_project_templates','cm_company_profiles','cm_project_directory','cm_safety_hours'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['cm_installed_quantities','cm_workforce_assignments','cm_proposals'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
end $$;
create or replace trigger trg_cm_workforce before insert or update of job_id, week_start on pm.cm_workforce_assignments for each row execute function pm.tg_cm_workforce();
create or replace trigger trg_cm_workforce before insert or update of job_id, start_week, end_week on pm.cm_workforce_requests for each row execute function pm.tg_cm_workforce();
create or replace trigger trg_cm_number before insert on pm.cm_proposals for each row execute function pm.tg_cm_proposal_number();
create or replace trigger trg_cm_proposal before insert or update on pm.cm_proposals for each row execute function pm.tg_cm_proposal();
create or replace trigger trg_cm_template_version before update on pm.cm_project_templates for each row execute function pm.tg_cm_template_version();

-- ----------------------------------------------------------------------------
-- 19. RLS (permissive org isolation), 1110 classes, masked money columns, table grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'cm_contract_settings','cm_markup_rules','cm_retainage_steps','cm_change_events','cm_change_event_lines','cm_rfqs','cm_pcos','cm_pco_lines',
    'cm_change_event_cost_links','cm_sov_co_links','cm_pay_app_status','cm_pay_app_revisions','cm_sub_pay_apps','cm_sub_pay_app_lines',
    'cm_sub_pay_app_actions','cm_sub_progress_opinions','cm_payable_retainage','cm_payable_outbox','cm_lien_waivers','cm_compliance_requirements',
    'cm_coi_certificates','cm_compliance_chases','cm_rate_sheets','cm_tm_tickets','cm_tm_ticket_lines','cm_tm_billing_links','cm_eac_forecasts',
    'cm_eac_lines','cm_wip_snapshots','cm_buyout_packages','cm_review_packages','cm_rfis','cm_rfi_responses','cm_spec_sections','cm_submittals',
    'cm_submittal_reviews','cm_transmittals','cm_correspondence','cm_meetings','cm_meeting_attendees','cm_meeting_items','cm_meeting_item_notes',
    'cm_daily_logs','cm_log_entries','cm_daily_log_voice','cm_observations','cm_checklist_templates','cm_inspections','cm_inspection_items',
    'cm_toolbox_talks','cm_toolbox_attendance','cm_jhas','cm_incidents','cm_safety_hours','cm_closeout_items','cm_job_closeouts',
    'cm_cost_code_units','cm_installed_quantities','cm_fade_alerts','cm_workforce_requests','cm_workforce_assignments','cm_proposals',
    'cm_project_templates','cm_template_applications','cm_company_profiles','cm_project_directory'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
  -- the statutory form catalog has no org (global, read-only for members)
  alter table pm.cm_lien_waiver_forms enable row level security;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'cm_lien_waiver_forms' and policyname = 'catalog_read') then
    create policy catalog_read on pm.cm_lien_waiver_forms for select using (true);
  end if;
end $$;

insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  -- change chain
  ('cm_contract_settings',      'M','job', '{projects.contract_value}', 'projects.billing',       null, null, null, null, false, '1120: tiers, cutoff, retainage mode, project state, PX threshold'),
  ('cm_markup_rules',           'M','job', '{projects.contract_value}', 'projects.change_orders', null, null, null, null, false, '1120: CO markup rules and tiers'),
  ('cm_retainage_steps',        'M','job', '{projects.contract_value}', 'projects.billing',       null, null, null, null, false, '1120: retainage step-downs (receivable / payable)'),
  ('cm_change_events',          'J','job', '{projects.change_orders}',  'projects.change_orders', null, null, null, null, false, '1120: change events; ROM masked (contract_value / financials)'),
  ('cm_change_event_lines',     'J','job', '{projects.change_orders}',  'projects.change_orders', null, null, null, null, false, '1120: change event lines; ROM masked'),
  ('cm_rfqs',                   'M','job', '{projects.financials}',     'projects.change_orders', null, null, null, null, false, '1120: sub pricing requests (cost)'),
  ('cm_pcos',                   'M','job', '{projects.contract_value}', 'projects.change_orders', null, null, null, null, false, '1120: PCO / COR; cost + markup masked (financials)'),
  ('cm_pco_lines',              'M','job', '{projects.contract_value}', 'projects.change_orders', null, null, null, null, false, '1120: PCO lines; cost masked'),
  ('cm_change_event_cost_links','M','job', '{projects.financials}',     'projects.change_orders', null, null, null, null, false, '1120: CCD cost-to-date links'),
  ('cm_sov_co_links',           'M','job', '{projects.contract_value}', null,                     null, null, null, null, false, '1120: approved COs carried onto the SOV (system)'),
  -- pay apps / subs / compliance
  ('cm_pay_app_status',         'M','job', '{projects.contract_value}', null,                     null, null, null, null, false, '1120: pencil / certified / final stage (RPC only)'),
  ('cm_pay_app_revisions',      'M','job', '{projects.contract_value}', null,                     null, null, null, null, false, '1120: pay app revision history'),
  ('cm_sub_pay_apps',           'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: sub pay apps (RPC only)'),
  ('cm_sub_pay_app_lines',      'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: sub pay app lines'),
  ('cm_sub_pay_app_actions',    'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: sub pay app approval history'),
  ('cm_sub_progress_opinions',  'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: superintendent % opinion per sub (no money)'),
  ('cm_payable_retainage',      'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: retainage payable ledger'),
  ('cm_payable_outbox',         'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: JOB_PAYABLE_REQUEST outbox for Books'),
  ('cm_lien_waiver_forms',      'O','org', '{}',                        null,                     null, null, null, null, false, '1120: statutory lien waiver forms (global catalog, no org_id)'),
  ('cm_lien_waivers',           'J','job', '{projects.commitments}',    null,                     null, null, null, null, false, '1120: lien waivers; amounts masked (financials)'),
  ('cm_compliance_requirements','J','job_or_location', '{projects.commitments}', 'projects.commitments', null, null, null, null, false, '1120: COI / W-9 / license / EMR requirements'),
  ('cm_coi_certificates',       'J','job_or_location', '{projects.commitments}', null,          null, null, null, null, false, '1120: certificates of insurance + verification'),
  ('cm_compliance_chases',      'J','job_or_location', '{projects.commitments}', null,          null, null, null, null, false, '1120: renewal / waiver chase log'),
  -- T&M
  ('cm_rate_sheets',            'M','job', '{projects.contract_value}', 'projects.billing',       null, null, null, null, false, '1120: T&M contract rate sheets (sell)'),
  ('cm_tm_tickets',             'J','job', '{projects.jobs}',           'projects.time',          null, null, null, null, false, '1120: T&M tickets (hours / quantities, no money)'),
  ('cm_tm_ticket_lines',        'J','job', '{projects.jobs}',           'projects.time',          null, null, null, null, false, '1120: T&M lines; material cost masked (financials)'),
  ('cm_tm_billing_links',       'M','job', '{projects.contract_value}', null,                     null, null, null, null, false, '1120: a ticket is billed once'),
  -- money control
  ('cm_eac_forecasts',          'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: monthly EAC (RPC only)'),
  ('cm_eac_lines',              'M','job', '{projects.financials}',     'projects.financials',    null, null, null, null, false, '1120: EAC by cost code (PM edits cost to complete)'),
  ('cm_wip_snapshots',          'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: pinned WIP rows'),
  ('cm_buyout_packages',        'M','job', '{projects.financials}',     'projects.commitments',   null, null, null, null, false, '1120: buyout log'),
  ('cm_review_packages',        'M','job', '{projects.financials}',     null,                     null, null, null, null, false, '1120: monthly project review packages'),
  -- document control
  ('cm_rfis',                   'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: RFIs (private RFIs narrowed by cm_rfi_private)'),
  ('cm_rfi_responses',          'J','job', '{projects.jobs}',           null,                     null, null, null, null, false, '1120: RFI responses (RPC only)'),
  ('cm_spec_sections',          'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: spec sections'),
  ('cm_submittals',             'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: submittal register + procurement log'),
  ('cm_submittal_reviews',      'J','job', '{projects.jobs}',           null,                     null, null, null, null, false, '1120: submittal review chain (RPC only)'),
  ('cm_transmittals',           'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: transmittals'),
  ('cm_correspondence',         'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: correspondence and notices'),
  ('cm_meetings',               'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: meetings'),
  ('cm_meeting_attendees',      'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: attendees'),
  ('cm_meeting_items',          'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: action items (carry forward)'),
  ('cm_meeting_item_notes',     'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: per-meeting notes on items'),
  -- field / quality / safety
  ('cm_daily_logs',             'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: daily log (sign + lock)'),
  ('cm_log_entries',            'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: manpower, deliveries, delays, equipment …'),
  ('cm_daily_log_voice',        'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: voice transcripts + proposed entries'),
  ('cm_observations',           'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: quality / safety observations'),
  ('cm_checklist_templates',    'S','location', '{}',                   'projects.settings',      null, null, null, null, false, '1120: inspection / QA checklist templates'),
  ('cm_inspections',            'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: inspections'),
  ('cm_inspection_items',       'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: inspection items'),
  ('cm_toolbox_talks',          'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: toolbox talks'),
  ('cm_toolbox_attendance',     'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: toolbox talk sign-in'),
  ('cm_jhas',                   'J','job', '{projects.jobs}',           'projects.documents',     null, null, null, null, false, '1120: JHA / pre-task plans'),
  ('cm_incidents',              'J','job', '{projects.team}',           'projects.jobs',          null, null,
     '%1$screated_by = (select pm.current_user_id())', null, false, '1120: incidents (injury detail): team:view on the job, or the reporter'),
  ('cm_safety_hours',           'C','location', '{projects.reports}',   'projects.settings',      null, null, null, null, false, '1120: manual hours for OSHA rates'),
  ('cm_closeout_items',         'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: closeout package'),
  ('cm_job_closeouts',          'J','job', '{projects.jobs}',           null,                     null, null, null, null, false, '1120: job close gate runs'),
  -- specialty trade
  ('cm_cost_code_units',        'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: budget units / labor hours (no money)'),
  ('cm_installed_quantities',   'J','job', '{projects.jobs}',           'projects.time',          null, null, null, null, false, '1120: installed quantities by cost code'),
  ('cm_fade_alerts',            'J','job', '{projects.jobs}',           'projects.time',          null, null, null, null, false, '1120: labor productivity fade alerts'),
  ('cm_workforce_requests',     'C','location', '{projects.dispatch,projects.jobs}', 'projects.jobs', null, null, null, null, false, '1120: crew requests'),
  ('cm_workforce_assignments',  'C','location', '{projects.dispatch,projects.team}', 'projects.dispatch', null, null,
     '%1$semployee_id in (select pm.my_employee_ids())', null, false, '1120: workforce board; a worker reads their own weeks'),
  ('cm_proposals',              'C','location', '{projects.estimates}', 'projects.estimates',     null, null, null, null, false, '1120: trade proposals to GCs'),
  -- platform
  ('cm_project_templates',      'S','location', '{}',                   'projects.settings',      null, null, null, null, false, '1120: project templates (global update)'),
  ('cm_template_applications',  'J','job', '{projects.jobs}',           null,                     null, null, null, null, false, '1120: which template version a job runs'),
  ('cm_company_profiles',       'S','location', '{}',                   'projects.commitments',   null, null, null, null, false, '1120: trade data on the shared vendor / customer master'),
  ('cm_project_directory',      'J','job', '{projects.jobs}',           'projects.jobs',          null, null, null, null, false, '1120: project directory + distribution groups')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('cm_change_events',      'rom_revenue_cents',   't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null::text, '1120: change ROM sell'),
  ('cm_change_events',      'rom_cost_cents',      't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: change ROM cost'),
  ('cm_change_event_lines', 'rom_revenue_cents',   't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1120: change line ROM sell'),
  ('cm_change_event_lines', 'rom_cost_cents',      't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: change line ROM cost'),
  ('cm_pcos',               'cost_cents',          't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: PCO cost'),
  ('cm_pcos',               'markup_cents',        't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: PCO markup reveals cost'),
  ('cm_pcos',               'markup_detail',       't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     '''[]''::jsonb', '1120: markup bases'),
  ('cm_pco_lines',          'cost_cents',          't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: PCO line cost'),
  ('cm_pco_lines',          'markup_cents',        't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: PCO line markup'),
  ('cm_lien_waivers',       'amount_cents',        't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: waiver amount (payment to the sub)'),
  ('cm_lien_waivers',       'signed_amount_cents', 't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: signed waiver amount'),
  ('cm_tm_ticket_lines',    'unit_cost_cents',     't.job_id in (select pm.my_money_job_ids(''projects.financials''))',     null, '1120: T&M material cost')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

-- table grants: nothing for anon / PUBLIC; service_role everything; members by column where state
-- moves only through the RPCs (masks then narrow SELECT to the plain columns)
do $$
declare t text;
begin
  foreach t in array array[
    'cm_contract_settings','cm_markup_rules','cm_retainage_steps','cm_change_events','cm_change_event_lines','cm_rfqs','cm_pcos','cm_pco_lines',
    'cm_change_event_cost_links','cm_sov_co_links','cm_pay_app_status','cm_pay_app_revisions','cm_sub_pay_apps','cm_sub_pay_app_lines',
    'cm_sub_pay_app_actions','cm_sub_progress_opinions','cm_payable_retainage','cm_payable_outbox','cm_lien_waiver_forms','cm_lien_waivers',
    'cm_compliance_requirements','cm_coi_certificates','cm_compliance_chases','cm_rate_sheets','cm_tm_tickets','cm_tm_ticket_lines',
    'cm_tm_billing_links','cm_eac_forecasts','cm_eac_lines','cm_wip_snapshots','cm_buyout_packages','cm_review_packages','cm_rfis',
    'cm_rfi_responses','cm_spec_sections','cm_submittals','cm_submittal_reviews','cm_transmittals','cm_correspondence','cm_meetings',
    'cm_meeting_attendees','cm_meeting_items','cm_meeting_item_notes','cm_daily_logs','cm_log_entries','cm_daily_log_voice','cm_observations',
    'cm_checklist_templates','cm_inspections','cm_inspection_items','cm_toolbox_talks','cm_toolbox_attendance','cm_jhas','cm_incidents',
    'cm_safety_hours','cm_closeout_items','cm_job_closeouts','cm_cost_code_units','cm_installed_quantities','cm_fade_alerts',
    'cm_workforce_requests','cm_workforce_assignments','cm_proposals','cm_project_templates','cm_template_applications','cm_company_profiles',
    'cm_project_directory'] loop
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
    execute format('grant select on pm.%I to authenticated', t);
  end loop;
  -- full member DML (RLS write caps + row guards govern)
  foreach t in array array['cm_markup_rules','cm_retainage_steps','cm_change_event_lines','cm_pco_lines','cm_sub_progress_opinions',
    'cm_compliance_requirements','cm_rate_sheets','cm_tm_ticket_lines','cm_buyout_packages','cm_spec_sections','cm_transmittals','cm_correspondence',
    'cm_meetings','cm_meeting_attendees','cm_meeting_items','cm_meeting_item_notes','cm_log_entries','cm_observations','cm_checklist_templates',
    'cm_toolbox_talks','cm_toolbox_attendance','cm_safety_hours','cm_closeout_items','cm_cost_code_units','cm_installed_quantities',
    'cm_workforce_requests','cm_workforce_assignments','cm_project_templates','cm_company_profiles','cm_project_directory'] loop
    execute format('grant insert, update, delete on pm.%I to authenticated', t);
  end loop;
end $$;

grant insert, update on pm.cm_contract_settings to authenticated;
grant insert (job_id, title, description, source_type, source_table, source_id, scope, reason_code, rom_revenue_cents, rom_cost_cents, schedule_days, due_on)
  on pm.cm_change_events to authenticated;
grant update (title, description, scope, reason_code, rom_revenue_cents, rom_cost_cents, schedule_days, due_on) on pm.cm_change_events to authenticated;
grant update (title, narrative, schedule_days, due_on) on pm.cm_pcos to authenticated;
grant insert (job_id, work_date, description, area, change_event_id, gc_reference, crew_id, foreman_employee_id, photo_ids) on pm.cm_tm_tickets to authenticated;
grant update (work_date, description, area, change_event_id, gc_reference, crew_id, foreman_employee_id, photo_ids) on pm.cm_tm_tickets to authenticated;
grant update (ctc_cents, commentary, method) on pm.cm_eac_lines to authenticated;
grant insert (job_id, subject, question, suggested_answer, discipline, spec_section, spec_section_id, drawing_ref, drawing_sheet_id, location_text, priority,
              is_private, ball_in_court_kind, ball_in_court_membership, ball_in_court_contact, ball_in_court_name, ball_in_court_email, assigned_vendor_id,
              due_on, cost_impact, schedule_impact, impact_days, distribution)
  on pm.cm_rfis to authenticated;
grant update (subject, question, suggested_answer, discipline, spec_section, spec_section_id, drawing_ref, drawing_sheet_id, location_text, priority,
              is_private, assigned_vendor_id, due_on, cost_impact, schedule_impact, impact_days, distribution)
  on pm.cm_rfis to authenticated;
grant insert (job_id, number, spec_section_id, spec_section, title, submittal_type, package, status, responsible_vendor_id, commitment_id, required_on_site,
              lead_time_days, review_days, schedule_task_id, long_lead)
  on pm.cm_submittals to authenticated;
grant update (title, submittal_type, package, responsible_vendor_id, commitment_id, required_on_site, lead_time_days, review_days, schedule_task_id,
              long_lead, fab_start_on, ship_on, delivered_on, procurement_status)
  on pm.cm_submittals to authenticated;
grant insert (job_id, log_date, weather_summary, temp_high_f, temp_low_f, precipitation, wind, site_conditions, work_performed, safety_notes)
  on pm.cm_daily_logs to authenticated;
grant update (weather_summary, temp_high_f, temp_low_f, precipitation, wind, site_conditions, work_performed, safety_notes) on pm.cm_daily_logs to authenticated;
grant insert (daily_log_id, transcript, language, proposed) on pm.cm_daily_log_voice to authenticated;
grant update (status) on pm.cm_daily_log_voice to authenticated;
grant insert (job_id, template_id, title, category, area, inspected_on, inspector_name) on pm.cm_inspections to authenticated;
grant update (title, area, inspected_on, inspector_name) on pm.cm_inspections to authenticated;
grant insert (inspection_id, sort, section, label, requires_photo) on pm.cm_inspection_items to authenticated;
grant update (response, value, note, photo_ids) on pm.cm_inspection_items to authenticated;
grant insert (job_id, work_date, crew_id, foreman_employee_id, task_description, area, steps, ppe, permits) on pm.cm_jhas to authenticated;
grant update (work_date, crew_id, foreman_employee_id, task_description, area, steps, ppe, permits) on pm.cm_jhas to authenticated;
grant insert (job_id, incident_type, occurred_at, employee_id, person_name, job_title, company, is_employee, description, where_occurred, body_part,
              injury_nature, object_substance, witnesses, root_cause, corrective_actions, osha_recordable, osha_classification, injury_or_illness,
              days_away, days_restricted, privacy_case, wc_claim_ref, status)
  on pm.cm_incidents to authenticated;
grant update (incident_type, occurred_at, employee_id, person_name, job_title, company, is_employee, description, where_occurred, body_part,
              injury_nature, object_substance, witnesses, root_cause, corrective_actions, osha_recordable, osha_classification, injury_or_illness,
              days_away, days_restricted, privacy_case, wc_claim_ref, status)
  on pm.cm_incidents to authenticated;
grant update (status, acknowledged_by) on pm.cm_fade_alerts to authenticated;
grant insert (location_id, customer_id, lead_id, project_name, base_bid_cents, alternates, unit_prices, inclusions, exclusions, qualifications,
              schedule_assumptions, valid_until, estimate_id)
  on pm.cm_proposals to authenticated;
grant update (customer_id, project_name, base_bid_cents, alternates, unit_prices, inclusions, exclusions, qualifications, schedule_assumptions,
              valid_until, declined_reason)
  on pm.cm_proposals to authenticated;

-- Policies (every classified table), then the masked views
select pm.access_apply_policies();
select pm.access_apply_masks();

-- Private RFIs (CGC-03): the author, the person holding the ball, and the job's change approvers.
do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'cm_rfis' and policyname = 'cm_rfi_private') then
    drop policy cm_rfi_private on pm.cm_rfis;
  end if;
  create policy cm_rfi_private on pm.cm_rfis as restrictive for select to authenticated
    using (not is_private or created_by = (select pm.current_user_id()) or ball_in_court_membership = (select pm.access_my_membership())
           or job_id in (select pm.my_job_ids_with('projects.change_orders', 'approve')));
end $$;

-- ----------------------------------------------------------------------------
-- 20. Read models (security_invoker: every member sees them through their own RLS; field-visible
--     money comes through the 1110 masked views)
-- ----------------------------------------------------------------------------

-- Change exposure by job (CGC-37): approved / pending / unpriced / rejected / proceeding, owner
-- response time and the owner CO ↔ sub CCO gap.
create or replace view pm.cm_v_change_exposure with (security_invoker = on) as
select p.org_id, p.job_id, p.location_id,
  coalesce(co.approved_cents, 0)::bigint                     as approved_cents,
  coalesce(co.pending_cents, 0)::bigint                      as pending_cents,
  coalesce(co.pending_count, 0)::int                         as pending_count,
  coalesce(co.pending_over_30_cents, 0)::bigint              as pending_over_30_cents,
  coalesce(co.rejected_cents, 0)::bigint                     as rejected_cents,
  coalesce(ce.unpriced_count, 0)::int                        as unpriced_count,
  ce.unpriced_rom_cents::bigint                              as unpriced_rom_cents,
  coalesce(ce.proceeding_count, 0)::int                      as proceeding_count,
  ce.proceeding_oldest_days::int                             as proceeding_oldest_days,
  rs.avg_owner_response_days                                 as avg_owner_response_days,
  coalesce(gap.owner_unmatched_cents, 0)::bigint             as owner_co_without_sub_co_cents,
  coalesce(gap.sub_unmatched_cents, 0)::bigint               as sub_co_without_owner_co_cents
from pm.projects p
left join lateral (
  select sum(c.amount_cents) filter (where c.stage = 'APPROVED')                                         as approved_cents,
         sum(c.amount_cents) filter (where c.stage in ('PCO','COR'))                                     as pending_cents,
         count(*) filter (where c.stage in ('PCO','COR'))                                                as pending_count,
         sum(c.amount_cents) filter (where c.stage in ('PCO','COR') and c.created_at < now() - interval '30 days') as pending_over_30_cents,
         sum(c.amount_cents) filter (where c.stage = 'REJECTED')                                         as rejected_cents
    from pm.v_change_orders_masked c where c.org_id = p.org_id and c.job_id = p.job_id
) co on true
left join lateral (
  select count(*) filter (where e.status in ('OPEN','PRICING','PRICED'))                                  as unpriced_count,
         sum(e.rom_revenue_cents) filter (where e.status in ('OPEN','PRICING','PRICED'))                  as unpriced_rom_cents,
         count(*) filter (where e.proceeding and e.status not in ('APPROVED','VOID','NO_COST','REJECTED'))  as proceeding_count,
         max(current_date - e.proceeding_since) filter (where e.proceeding and e.status not in ('APPROVED','VOID','NO_COST','REJECTED')) as proceeding_oldest_days
    from pm.v_cm_change_events_masked e where e.org_id = p.org_id and e.job_id = p.job_id
) ce on true
left join lateral (
  select round(avg(extract(epoch from (x.decided_at - x.submitted_at)) / 86400)::numeric, 1) as avg_owner_response_days
    from pm.cm_pcos x where x.org_id = p.org_id and x.job_id = p.job_id and x.decided_at is not null and x.submitted_at is not null
) rs on true
left join lateral (
  select sum(greatest(s.sub_cost - coalesce(s.cco_cents, 0), 0)) as owner_unmatched_cents,
         (select sum(x.amount_cents) from pm.commitment_changes x where x.org_id = p.org_id and x.job_id = p.job_id
            and x.status = 'APPROVED' and x.owner_co_id is null) as sub_unmatched_cents
    from (select c.id, (select sum(pl.cost_cents) from pm.v_cm_pco_lines_masked pl join pm.cm_pcos pc on pc.id = pl.pco_id
                         where pc.change_order_id = c.id and pl.source = 'SUB') as sub_cost,
                 (select sum(x.amount_cents) from pm.commitment_changes x where x.owner_co_id = c.id and x.status = 'APPROVED') as cco_cents
            from pm.v_change_orders_masked c where c.org_id = p.org_id and c.job_id = p.job_id and c.stage = 'APPROVED') s
) gap on true;

create or replace view pm.cm_v_owner_sub_gap with (security_invoker = on) as
select c.org_id, c.job_id, c.id as change_order_id, c.number, c.title, c.amount_cents, c.cost_impact_cents, c.approved_at,
  coalesce((select sum(pl.cost_cents) from pm.v_cm_pco_lines_masked pl join pm.cm_pcos pc on pc.id = pl.pco_id where pc.change_order_id = c.id and pl.source = 'SUB'), 0)::bigint as sub_cost_cents,
  coalesce((select sum(x.amount_cents) from pm.commitment_changes x where x.owner_co_id = c.id and x.status = 'APPROVED'), 0)::bigint as cco_approved_cents,
  coalesce((select sum(x.amount_cents) from pm.commitment_changes x where x.owner_co_id = c.id and x.status = 'DRAFT'), 0)::bigint as cco_draft_cents
from pm.v_change_orders_masked c
where c.stage = 'APPROVED';

create or replace view pm.cm_v_buyout with (security_invoker = on) as
select b.org_id, b.job_id, b.id as package_id, b.name, b.csi_division, b.status, b.sort, b.lead_time_days, b.schedule_task_id,
  coalesce(b.budget_override_cents, (select sum(l.amount_cents) from pm.v_job_current_budget_lines l where l.org_id = b.org_id and l.job_id = b.job_id
                                       and l.cost_code_id = any (b.cost_code_ids)), 0)::bigint as budget_cents,
  coalesce((select sum(cl.amount_cents) from pm.commitment_lines cl join pm.commitments c on c.id = cl.commitment_id
             where c.org_id = b.org_id and c.job_id = b.job_id and c.status in ('APPROVED','EXECUTED','CLOSED')
               and (cl.cost_code_id = any (b.cost_code_ids) or c.id = any (b.commitment_ids))), 0)::bigint as committed_cents,
  coalesce(b.need_by, (select t.start_on - b.lead_time_days from pm.tasks t where t.id = b.schedule_task_id)) as need_by,
  coalesce(b.need_by, (select t.start_on - b.lead_time_days from pm.tasks t where t.id = b.schedule_task_id)) - current_date as days_to_need
from pm.cm_buyout_packages b;

-- Retainage both sides (CGC-49): receivable from the owner / GC, payable to subs.
create or replace view pm.cm_v_retainage_both with (security_invoker = on) as
select p.org_id, p.job_id, p.location_id,
  coalesce(r.held_cents, 0)::bigint        as receivable_held_cents,
  coalesce(r.released_cents, 0)::bigint    as receivable_released_cents,
  coalesce(r.outstanding_cents, 0)::bigint as receivable_outstanding_cents,
  coalesce(pay.held, 0)::bigint            as payable_held_cents,
  coalesce(pay.released, 0)::bigint        as payable_released_cents,
  (coalesce(pay.held, 0) - coalesce(pay.released, 0))::bigint as payable_outstanding_cents,
  s.substantial_completion_on,
  (s.substantial_completion_on is not null and s.substantial_completion_on <= current_date and coalesce(r.outstanding_cents, 0) > 0) as receivable_release_eligible
from pm.projects p
left join pm.v_job_retainage r on r.org_id = p.org_id and r.job_id = p.job_id
left join lateral (
  select sum(x.amount_cents) filter (where x.entry_type = 'HELD') as held, sum(x.amount_cents) filter (where x.entry_type = 'RELEASED') as released
    from pm.cm_payable_retainage x where x.org_id = p.org_id and x.job_id = p.job_id
) pay on true
left join pm.cm_contract_settings s on s.org_id = p.org_id and s.job_id = p.job_id;

create or replace view pm.cm_v_payable_retainage with (security_invoker = on) as
select c.org_id, c.job_id, c.id as commitment_id, c.number, c.vendor_id,
  coalesce(sum(x.amount_cents) filter (where x.entry_type = 'HELD'), 0)::bigint as held_cents,
  coalesce(sum(x.amount_cents) filter (where x.entry_type = 'RELEASED'), 0)::bigint as released_cents,
  (coalesce(sum(x.amount_cents) filter (where x.entry_type = 'HELD'), 0) - coalesce(sum(x.amount_cents) filter (where x.entry_type = 'RELEASED'), 0))::bigint as outstanding_cents,
  bool_or(w.id is not null) as final_waiver_verified
from pm.commitments c
left join pm.cm_payable_retainage x on x.org_id = c.org_id and x.commitment_id = c.id
left join pm.cm_lien_waivers w on w.org_id = c.org_id and w.commitment_id = c.id and w.status = 'VERIFIED' and w.waiver_type in ('CONDITIONAL_FINAL','UNCONDITIONAL_FINAL')
group by c.org_id, c.job_id, c.id, c.number, c.vendor_id;

-- Compliance queue per commitment (what blocks payment and why).
create or replace view pm.cm_v_compliance_queue with (security_invoker = on) as
select c.org_id, c.job_id, c.location_id, c.id as commitment_id, c.number, c.commitment_type, c.status as commitment_status, c.vendor_id,
  v.name as vendor_name, c.payment_hold as manual_hold, c.hold_reason,
  (c.payment_hold or not pm.commitment_payment_eligible(c.id)) as payment_hold_effective,
  coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'status', d.status, 'expires_on', d.expires_on,
              'covers_through', d.covers_through, 'notes', d.notes) order by d.doc_type, d.created_at)
              from pm.compliance_docs d where d.org_id = c.org_id and d.commitment_id = c.id and d.required
               and not (d.status = 'VERIFIED' and (d.expires_on is null or d.expires_on >= current_date))), '[]'::jsonb) as blocking_docs,
  (select x.status from pm.cm_coi_certificates x where x.org_id = c.org_id and x.vendor_id = c.vendor_id and x.status <> 'SUPERSEDED'
     and (x.commitment_id = c.id or (x.commitment_id is null and (x.job_id = c.job_id or x.job_id is null))) order by x.created_at desc limit 1) as coi_status,
  (select x.earliest_expiry from pm.cm_coi_certificates x where x.org_id = c.org_id and x.vendor_id = c.vendor_id and x.status <> 'SUPERSEDED'
     and (x.commitment_id = c.id or (x.commitment_id is null and (x.job_id = c.job_id or x.job_id is null))) order by x.created_at desc limit 1) as coi_expires_on,
  (select count(*) from pm.cm_lien_waivers w where w.org_id = c.org_id and w.commitment_id = c.id and w.status in ('REQUESTED','SENT','RECEIVED','REJECTED'))::int as waivers_outstanding
from pm.commitments c
left join pm.v_core_vendors_masked v on v.id = c.vendor_id
where c.status in ('APPROVED','EXECUTED','CLOSED');

-- Submittal schedule / procurement log (CGC-66).
create or replace view pm.cm_v_submittal_schedule with (security_invoker = on) as
select s.org_id, s.job_id, s.id as submittal_id, s.number, s.revision, s.title, s.spec_section, s.submittal_type, s.status, s.long_lead,
  s.required_on_site, s.lead_time_days, s.review_days, s.submit_by, s.schedule_task_id, t.title as activity_title, t.start_on as activity_start,
  s.released_for_fab_on, s.fab_start_on, s.ship_on, s.delivered_on, s.procurement_status, s.ball_in_court_kind, s.ball_in_court_name,
  (s.status in ('NOT_STARTED','REQUESTED') and s.submit_by is not null and s.submit_by < current_date) as late_to_submit,
  (s.status in ('SUBMITTED','IN_REVIEW','REVISE_RESUBMIT','REQUESTED','NOT_STARTED') and s.required_on_site is not null
     and s.required_on_site - s.lead_time_days <= current_date + 7) as approval_on_critical_path,
  (s.required_on_site is not null and s.delivered_on is null and s.required_on_site < current_date) as delivery_late
from pm.cm_submittals s
left join pm.tasks t on t.id = s.schedule_task_id
where s.status not in ('VOID','CLOSED');

-- Delay register from the daily logs (CGC-82 input; notice tracking).
create or replace view pm.cm_v_delay_register with (security_invoker = on) as
select e.org_id, e.job_id, d.log_date, e.id as entry_id, e.daily_log_id, e.cause, e.duration_hours, round(coalesce(e.duration_hours, 0) / 8, 2) as days,
  e.responsible_party, e.notice_sent, e.description, e.area
from pm.cm_log_entries e join pm.cm_daily_logs d on d.id = e.daily_log_id
where e.kind = 'DELAY';

-- Manpower by company per day (sub manpower vs plan reads it).
create or replace view pm.cm_v_manpower with (security_invoker = on) as
select e.org_id, e.job_id, d.log_date, e.vendor_id, coalesce(e.company_name, 'Own forces') as company, e.trade,
  sum(coalesce(e.headcount, 0))::int as headcount, sum(coalesce(e.hours, 0)) as hours
from pm.cm_log_entries e join pm.cm_daily_logs d on d.id = e.daily_log_id
where e.kind = 'MANPOWER'
group by e.org_id, e.job_id, d.log_date, e.vendor_id, coalesce(e.company_name, 'Own forces'), e.trade;

-- Multi-GC billing calendar (CGC-102): next cutoff, pencil due, current period status, retainage held.
create or replace view pm.cm_v_billing_calendar with (security_invoker = on) as
select s.org_id, s.job_id, j.location_id, j.job_number, j.name as job_name, cu.name as customer_name, s.billing_form, s.billing_portal_url,
  s.billing_cutoff_day,
  make_date(extract(year from nc.d)::int, extract(month from nc.d)::int,
            least(s.billing_cutoff_day, extract(day from (date_trunc('month', nc.d) + interval '1 month - 1 day'))::int)) as next_cutoff,
  make_date(extract(year from nc.d)::int, extract(month from nc.d)::int,
            least(s.billing_cutoff_day, extract(day from (date_trunc('month', nc.d) + interval '1 month - 1 day'))::int)) - s.pencil_lead_days as pencil_due,
  (select r.status from pm.billing_requests r where r.org_id = s.org_id and r.job_id = s.job_id and r.billing_subtype = 'SOV' and r.status <> 'VOID'
     and r.period_end >= date_trunc('month', current_date)::date order by r.application_no desc limit 1) as current_status,
  (select ps.stage from pm.cm_pay_app_status ps join pm.billing_requests r on r.id = ps.billing_request_id
    where ps.org_id = s.org_id and ps.job_id = s.job_id and ps.stage <> 'VOID' and r.period_end >= date_trunc('month', current_date)::date
    order by ps.application_no desc, ps.revision desc limit 1) as current_stage,
  (select ps.portal_status from pm.cm_pay_app_status ps where ps.org_id = s.org_id and ps.job_id = s.job_id and ps.stage <> 'VOID'
    order by ps.application_no desc, ps.revision desc limit 1) as portal_status,
  coalesce((select v.outstanding_cents from pm.v_job_retainage v where v.org_id = s.org_id and v.job_id = s.job_id), 0)::bigint as retainage_outstanding_cents
from pm.cm_contract_settings s
join pm.v_core_jobs_masked j on j.id = s.job_id
left join pm.v_core_customers_masked cu on cu.id = j.customer_id
cross join lateral (select case when extract(day from current_date) <= s.billing_cutoff_day then current_date else (current_date + interval '1 month')::date end as d) nc
where j.status is distinct from 'CLOSED';

-- Workforce board conflicts: double-booked people, apprentice ratio over the job's allowed ratio.
create or replace view pm.cm_v_workforce_conflicts with (security_invoker = on) as
select a.org_id, a.location_id, a.week_start, a.employee_id, null::uuid as job_id, 'DOUBLE_BOOKED'::text as conflict,
       format('%s days booked across %s jobs', sum(a.days), count(distinct a.job_id)) as detail
  from pm.cm_workforce_assignments a where a.status <> 'RELEASED'
 group by a.org_id, a.location_id, a.week_start, a.employee_id having sum(a.days) > 5
union all
select a.org_id, a.location_id, a.week_start, null::uuid, a.job_id, 'APPRENTICE_RATIO',
       format('%s apprentices to %s journeymen / foremen (ratio %s)', count(*) filter (where a.role = 'APPRENTICE'),
              count(*) filter (where a.role in ('JOURNEYMAN','FOREMAN')), coalesce(max(s.apprentice_ratio), 1))
  from pm.cm_workforce_assignments a left join pm.cm_contract_settings s on s.org_id = a.org_id and s.job_id = a.job_id
 where a.status <> 'RELEASED'
 group by a.org_id, a.location_id, a.week_start, a.job_id
having count(*) filter (where a.role = 'APPRENTICE') > coalesce(max(s.apprentice_ratio), 1) * greatest(count(*) filter (where a.role in ('JOURNEYMAN','FOREMAN')), 0);

-- Sub pay app vs the field: claimed % against the superintendent's opinion and the manpower logged.
create or replace view pm.cm_v_sub_pay_app_check with (security_invoker = on) as
select a.org_id, a.job_id, a.id as sub_pay_app_id, a.commitment_id, a.vendor_id, a.application_no, a.period_end, a.status,
  case when a.scheduled_value_cents > 0 then round((a.work_to_date_cents + a.stored_to_date_cents)::numeric / a.scheduled_value_cents, 4) end as claimed_pct,
  o.pct_complete as field_opinion_pct, o.note as field_note,
  (select coalesce(sum(m.headcount), 0) from pm.cm_v_manpower m where m.org_id = a.org_id and m.job_id = a.job_id and m.vendor_id = a.vendor_id
     and m.log_date between a.period_end - 31 and a.period_end)::int as manpower_days_in_period,
  (o.pct_complete is not null and a.scheduled_value_cents > 0
     and (a.work_to_date_cents + a.stored_to_date_cents)::numeric / a.scheduled_value_cents - o.pct_complete > 0.10) as over_claim
from pm.cm_sub_pay_apps a
left join lateral (
  select x.pct_complete, x.note from pm.cm_sub_progress_opinions x
   where x.org_id = a.org_id and x.job_id = a.job_id and x.vendor_id = a.vendor_id and x.period_end <= a.period_end + 7
   order by x.period_end desc limit 1
) o on true;

create or replace view pm.cm_v_project_directory with (security_invoker = on) as
select d.org_id, d.job_id, d.id as directory_id, d.party_role, d.vendor_id, d.customer_id, d.contact_id, d.membership_id,
  coalesce(d.company_name, v.name, cu.name) as company_name, d.contact_name, d.email, d.phone,
  coalesce(d.trade, p.trades[1]) as trade, case when cardinality(d.csi_divisions) > 0 then d.csi_divisions else coalesce(p.csi_divisions, '{}') end as csi_divisions,
  d.distribution_groups, d.is_primary, p.union_local, p.dbe, p.mbe, p.wbe, p.emr, p.licenses, p.prequal_status, p.prequal_expires
from pm.cm_project_directory d
left join pm.v_core_vendors_masked v on v.id = d.vendor_id
left join pm.v_core_customers_masked cu on cu.id = d.customer_id
left join pm.cm_company_profiles p on p.org_id = d.org_id and ((d.vendor_id is not null and p.vendor_id = d.vendor_id) or (d.customer_id is not null and p.customer_id = d.customer_id));

-- ----------------------------------------------------------------------------
-- 21. Billing Integrity Auditor (CGC-53, rules only) — run before each cutoff
-- ----------------------------------------------------------------------------
create or replace function pm.cm_billing_audit(p_job uuid)
returns table (rule text, severity text, amount_cents bigint, title text, detail text, fix text, ref_table text, ref_id uuid)
language plpgsql stable security invoker
set search_path = pm, core, public
as $$
declare f record; s record; v_cut date; v_last date; r record;
begin
  select x.revised_contract_cents, x.over_under_billing_cents, x.billed_to_date_cents, x.earned_revenue_cents into f from pm.v_job_financials x where x.job_id = p_job;
  select x.* into s from pm.cm_contract_settings x where x.job_id = p_job;
  -- 1 approved prime COs not on the schedule of values
  for r in select c.id, c.number, c.title, c.amount_cents from pm.v_change_orders_masked c
            where c.job_id = p_job and c.stage = 'APPROVED' and c.amount_cents <> 0
              and not exists (select 1 from pm.cm_sov_co_links k where k.change_order_id = c.id)
              and not exists (select 1 from pm.sov_lines sl join pm.sov_versions v on v.id = sl.sov_version_id
                               where v.job_id = p_job and v.status = 'ACTIVE' and sl.change_order_id = c.id)
              and exists (select 1 from pm.sov_versions v where v.job_id = p_job and v.status = 'ACTIVE') loop
    rule := 'APPROVED_CO_NOT_ON_SOV'; severity := 'HIGH'; amount_cents := r.amount_cents; title := format('%s is approved but not on the SOV', r.number);
    detail := r.title; fix := 'Draft the next pay application: approved change orders are added to the schedule of values.'; ref_table := 'change_orders'; ref_id := r.id;
    return next;
  end loop;
  -- 2 signed T&M not billed
  for r in select t.id, t.number, t.work_date, t.description from pm.cm_tm_tickets t where t.job_id = p_job and t.status = 'SIGNED' loop
    rule := 'SIGNED_TM_UNBILLED'; severity := 'HIGH';
    amount_cents := (select (pm._cm_tm_price_safe(r.id) ->> 'total_cents')::bigint);
    title := format('%s signed %s, not billed', r.number, to_char(r.work_date, 'Mon FMDD')); detail := left(r.description, 200);
    fix := 'Bill the signed tickets (T&M billing) or convert them to a change.'; ref_table := 'cm_tm_tickets'; ref_id := r.id;
    return next;
  end loop;
  -- 3 materials received but not billed as stored or installed (by cost code)
  for r in
    select cl.cost_code_id, cc.code, sum(rc.amount_cents)::bigint as received,
           coalesce((select sum(coalesce(st.work_completed_cents, 0) + coalesce(st.stored_materials_cents, 0)) from pm.v_sov_status st
                      where st.job_id = p_job and st.sov_status = 'ACTIVE' and st.cost_code_id = cl.cost_code_id), 0)::bigint as billed
      from pm.receipts rc join pm.commitment_lines cl on cl.id = rc.commitment_line_id left join pm.cost_codes cc on cc.id = cl.cost_code_id
     where rc.job_id = p_job and rc.status = 'RECEIVED' and coalesce(cl.cost_type, 'MATERIALS') in ('MATERIALS','EQUIPMENT')
     group by cl.cost_code_id, cc.code
  loop
    continue when r.received <= r.billed or r.cost_code_id is null
               or not exists (select 1 from pm.v_sov_status st where st.job_id = p_job and st.sov_status = 'ACTIVE' and st.cost_code_id = r.cost_code_id);
    rule := 'STORED_NOT_BILLED'; severity := 'MEDIUM'; amount_cents := r.received - r.billed;
    title := format('Material received on %s not billed', coalesce(r.code, 'a cost code')); detail := 'Delivered material exceeds work + stored billed on the SOV line.';
    fix := 'Bill it as stored materials (with backup) on the next pay application.'; ref_table := 'cost_codes'; ref_id := r.cost_code_id;
    return next;
  end loop;
  -- 4 retainage eligible for release
  select x.* into r from pm.cm_v_retainage_both x where x.job_id = p_job;
  if r.receivable_release_eligible and not exists (select 1 from pm.billing_requests b where b.job_id = p_job and b.billing_subtype = 'RETAINAGE_RELEASE' and b.status in ('DRAFT','EMITTED','REJECTED')) then
    rule := 'RETAINAGE_RELEASE_ELIGIBLE'; severity := 'HIGH'; amount_cents := r.receivable_outstanding_cents;
    title := 'Retainage can be billed for release'; detail := format('Substantial completion %s.', r.substantial_completion_on);
    fix := 'Draft the retainage release billing.'; ref_table := 'projects'; ref_id := p_job;
    return next;
  end if;
  -- 5 / 6 under- and over-billing against cost-to-cost earned
  if f.over_under_billing_cents is not null and f.revised_contract_cents > 0 then
    if -f.over_under_billing_cents > greatest(500000, f.revised_contract_cents / 100) then
      rule := 'UNDERBILLED'; severity := 'HIGH'; amount_cents := -f.over_under_billing_cents; title := 'Earned revenue is ahead of billing';
      detail := 'Cost-to-cost earned exceeds billed to date.'; fix := 'Bill the work in place (or check the forecast).'; ref_table := 'projects'; ref_id := p_job;
      return next;
    elsif f.over_under_billing_cents > f.revised_contract_cents / 20 then
      rule := 'OVERBILLED'; severity := 'MEDIUM'; amount_cents := f.over_under_billing_cents; title := 'Billing is well ahead of earned revenue';
      detail := 'More than 5% of the contract billed in excess of earnings — the WIP will show a liability.'; fix := 'Hold back the next bill or update the forecast.';
      ref_table := 'projects'; ref_id := p_job;
      return next;
    end if;
  end if;
  -- 7 sub pay apps approved over owner billing (by cost code)
  for r in
    select x.cost_code_id, cc.code, sum(x.previous_work_cents + x.this_period_work_cents + x.stored_materials_cents)::bigint as sub_td,
           coalesce((select sum(coalesce(st.work_completed_cents, 0) + coalesce(st.stored_materials_cents, 0)) from pm.v_sov_status st
                      where st.job_id = p_job and st.sov_status = 'ACTIVE' and st.cost_code_id = x.cost_code_id), 0)::bigint as owner_td
      from pm.cm_sub_pay_app_lines x join pm.cm_sub_pay_apps a on a.id = x.sub_pay_app_id left join pm.cost_codes cc on cc.id = x.cost_code_id
     where a.job_id = p_job and a.status = 'APPROVED'
       and a.application_no = (select max(a2.application_no) from pm.cm_sub_pay_apps a2 where a2.commitment_id = a.commitment_id and a2.status = 'APPROVED')
     group by x.cost_code_id, cc.code
  loop
    continue when r.sub_td <= r.owner_td or r.cost_code_id is null
               or not exists (select 1 from pm.v_sov_status st where st.job_id = p_job and st.sov_status = 'ACTIVE' and st.cost_code_id = r.cost_code_id);
    rule := 'SUB_BILLED_OVER_OWNER'; severity := 'HIGH'; amount_cents := r.sub_td - r.owner_td;
    title := format('Subs approved past the owner billing on %s', coalesce(r.code, 'a cost code')); detail := 'Approved sub pay apps to date exceed what was billed to the owner on that SOV line.';
    fix := 'Bill the owner for the work the subs were approved for.'; ref_table := 'cost_codes'; ref_id := r.cost_code_id;
    return next;
  end loop;
  -- 8 work proceeding without a priced change
  for r in select e.id, e.number, e.title, e.proceeding_since, e.rom_revenue_cents from pm.v_cm_change_events_masked e
            where e.job_id = p_job and e.proceeding and e.status in ('OPEN','PRICING') loop
    rule := 'PROCEEDING_UNPRICED'; severity := 'HIGH'; amount_cents := r.rom_revenue_cents;
    title := format('%s proceeding since %s with no price', r.number, to_char(r.proceeding_since, 'Mon FMDD')); detail := r.title;
    fix := 'Price it (RFQs → PCO) and submit to the owner.'; ref_table := 'cm_change_events'; ref_id := r.id;
    return next;
  end loop;
  -- 9 owner response overdue
  for r in select p.id, p.number, p.title, p.amount_cents, p.due_on from pm.cm_pcos p where p.job_id = p_job and p.status = 'SUBMITTED' and p.due_on < current_date loop
    rule := 'CO_RESPONSE_OVERDUE'; severity := 'MEDIUM'; amount_cents := r.amount_cents;
    title := format('%s past the owner''s response date (%s)', r.number, to_char(r.due_on, 'Mon FMDD')); detail := r.title;
    fix := 'Chase the owner; record the decision.'; ref_table := 'cm_pcos'; ref_id := r.id;
    return next;
  end loop;
  -- 10 cutoff passed with no pay application drafted this month
  if s.billing_cutoff_day is not null and exists (select 1 from pm.sov_versions v where v.job_id = p_job and v.status = 'ACTIVE') then
    v_cut := make_date(extract(year from current_date)::int, extract(month from current_date)::int,
                       least(s.billing_cutoff_day, extract(day from (date_trunc('month', current_date) + interval '1 month - 1 day'))::int));
    select max(b.period_end) into v_last from pm.billing_requests b where b.job_id = p_job and b.billing_subtype = 'SOV' and b.status <> 'VOID';
    if current_date >= v_cut and (v_last is null or v_last < date_trunc('month', current_date)::date) then
      rule := 'NO_PAY_APP_THIS_PERIOD'; severity := 'HIGH'; amount_cents := null;
      title := format('Billing cutoff %s passed without a pay application', to_char(v_cut, 'Mon FMDD')); detail := 'No pay application for this month.';
      fix := 'Draft the pay application.'; ref_table := 'projects'; ref_id := p_job;
      return next;
    end if;
  end if;
end $$;

create or replace function pm.cm_billing_audit_company(p_location uuid)
returns table (job_id uuid, rule text, severity text, amount_cents bigint, title text, detail text, fix text, ref_table text, ref_id uuid)
language sql stable security invoker
set search_path = pm, core, public
as $$
  select p.job_id, a.rule, a.severity, a.amount_cents, a.title, a.detail, a.fix, a.ref_table, a.ref_id
    from pm.projects p cross join lateral pm.cm_billing_audit(p.job_id) a
   where p.location_id = p_location and not p.is_sample
   order by a.amount_cents desc nulls last, a.severity
$$;

-- ----------------------------------------------------------------------------
-- 22. Ball-in-court action inbox (CGC-10): everything waiting on the caller, oldest / overdue first
-- ----------------------------------------------------------------------------
create or replace function pm.cm_ball_in_court(p_location uuid default null)
returns table (kind text, item_id uuid, job_id uuid, ref text, title text, status text, due_on date, days_overdue int, age_days int,
               waiting_on text, mine boolean, link text)
language plpgsql stable security invoker
set search_path = pm, core, public
as $$
declare v_me uuid := pm.access_my_membership(); v_user text := pm.current_user_id(); r record;
begin
  -- RFIs whose ball is with me (or mine to chase when overdue outside)
  for r in select x.* from pm.cm_rfis x join pm.projects p on p.job_id = x.job_id
            where x.status in ('OPEN','ANSWERED') and (p_location is null or p.location_id = p_location)
              and ((x.ball_in_court_kind = 'INTERNAL' and (x.ball_in_court_membership = v_me or (x.ball_in_court_membership is null and x.created_by = v_user)))
                   or (x.created_by = v_user and x.due_on < current_date and x.status = 'OPEN')) loop
    kind := 'RFI'; item_id := r.id; job_id := r.job_id; ref := r.number; title := r.subject; status := r.status; due_on := r.due_on;
    days_overdue := greatest(current_date - r.due_on, 0); age_days := current_date - coalesce(r.opened_at, r.created_at)::date;
    waiting_on := case when r.ball_in_court_kind = 'INTERNAL' then 'You' else coalesce(r.ball_in_court_name, initcap(lower(r.ball_in_court_kind))) end;
    mine := r.ball_in_court_kind = 'INTERNAL'; link := '/rfis?item=' || r.id;
    return next;
  end loop;
  -- submittal review steps assigned to me (or the GC step on my jobs)
  for r in select v.id, v.submittal_id, v.due_on, v.created_at, s.number, s.title, s.job_id, v.reviewer_kind, v.reviewer_membership
             from pm.cm_submittal_reviews v join pm.cm_submittals s on s.id = v.submittal_id join pm.projects p on p.job_id = s.job_id
            where v.status = 'ACTIVE' and (p_location is null or p.location_id = p_location)
              and (v.reviewer_membership = v_me or (v.reviewer_kind = 'GC' and v.reviewer_membership is null
                    and s.job_id in (select pm.my_job_ids_with('projects.jobs', 'edit')))) loop
    kind := 'SUBMITTAL_REVIEW'; item_id := r.submittal_id; job_id := r.job_id; ref := r.number; title := r.title; status := 'IN_REVIEW'; due_on := r.due_on;
    days_overdue := greatest(current_date - r.due_on, 0); age_days := current_date - r.created_at::date; waiting_on := 'You'; mine := true;
    link := '/submittals?item=' || r.submittal_id;
    return next;
  end loop;
  -- sub pay apps at a step I can act on
  for r in select a.* from pm.cm_sub_pay_apps a
            where a.status in ('SUBMITTED','IN_REVIEW') and (p_location is null or a.location_id = p_location)
              and exists (select 1 from pm.my_job_ids_with(a.chain -> (a.current_step - 1) ->> 'cap', a.chain -> (a.current_step - 1) ->> 'action') mj where mj = a.job_id)
              and coalesce(a.submitted_by, '') <> coalesce(v_user, '-') loop
    kind := 'SUB_PAY_APP'; item_id := r.id; job_id := r.job_id; ref := 'Pay app #' || r.application_no;
    title := 'Sub pay application to review'; status := r.status; due_on := r.period_end + 10;
    days_overdue := greatest(current_date - (r.period_end + 10), 0); age_days := current_date - coalesce(r.submitted_at, r.created_at)::date;
    waiting_on := coalesce(r.chain -> (r.current_step - 1) ->> 'label', 'Reviewer'); mine := true; link := '/compliance?tab=sub-pay-apps&item=' || r.id;
    return next;
  end loop;
  -- PCOs with the owner past due, and drafts I prepared
  for r in select x.id, x.job_id, x.number, x.title, x.status, x.due_on, x.created_at from pm.cm_pcos x join pm.projects p on p.job_id = x.job_id
            where (p_location is null or p.location_id = p_location) and x.created_by = v_user
              and (x.status in ('DRAFT','REVISE') or (x.status = 'SUBMITTED' and x.due_on < current_date)) loop
    kind := 'PCO'; item_id := r.id; job_id := r.job_id; ref := r.number; title := r.title; status := r.status; due_on := r.due_on;
    days_overdue := greatest(current_date - coalesce(r.due_on, current_date), 0); age_days := current_date - r.created_at::date;
    waiting_on := case when r.status = 'SUBMITTED' then 'Owner' else 'You' end; mine := r.status <> 'SUBMITTED'; link := '/change-events?pco=' || r.id;
    return next;
  end loop;
  -- unsigned T&M older than 48 hours on my jobs
  for r in select t.* from pm.cm_tm_tickets t join pm.projects p on p.job_id = t.job_id
            where t.status in ('SUBMITTED','DISPUTED') and t.created_at < now() - interval '48 hours' and (p_location is null or p.location_id = p_location)
              and t.job_id in (select pm.my_job_ids_with('projects.time', 'approve')) loop
    kind := 'TM_SIGNATURE'; item_id := r.id; job_id := r.job_id; ref := r.number; title := left(r.description, 120); status := r.status; due_on := r.work_date + 2;
    days_overdue := greatest(current_date - (r.work_date + 2), 0); age_days := current_date - r.created_at::date; waiting_on := 'GC signature'; mine := true;
    link := '/daily-logs?tab=tm&item=' || r.id;
    return next;
  end loop;
  -- cost forecasts: mine to prepare, or submitted and mine to approve
  for r in select f.* from pm.cm_eac_forecasts f
            where (p_location is null or f.location_id = p_location)
              and ((f.status in ('DRAFT','REJECTED') and f.prepared_by = v_user)
                   or (f.status = 'SUBMITTED' and coalesce(f.prepared_by, '') <> coalesce(v_user, '-') and pm._cm_is_executive(f.location_id))) loop
    kind := 'EAC'; item_id := r.id; job_id := r.job_id; ref := to_char(r.period_end, 'YYYY-MM'); title := 'Cost forecast'; status := r.status; due_on := r.due_on;
    days_overdue := greatest(current_date - coalesce(r.due_on, current_date), 0); age_days := current_date - r.created_at::date;
    waiting_on := case when r.status = 'SUBMITTED' then 'Approver' else 'You' end; mine := true; link := '/wip?tab=eac&item=' || r.id;
    return next;
  end loop;
  -- meeting action items and observations assigned to me
  for r in select i.* from pm.cm_meeting_items i join pm.projects p on p.job_id = i.job_id
            where i.status = 'OPEN' and i.owner_membership = v_me and (p_location is null or p.location_id = p_location) loop
    kind := 'MEETING_ITEM'; item_id := r.id; job_id := r.job_id; ref := r.item_no; title := r.topic; status := r.status; due_on := r.due_on;
    days_overdue := greatest(current_date - coalesce(r.due_on, current_date), 0); age_days := current_date - r.created_at::date; waiting_on := 'You'; mine := true;
    link := '/meetings?item=' || r.origin_meeting_id;
    return next;
  end loop;
  for r in select o.* from pm.cm_observations o join pm.projects p on p.job_id = o.job_id
            where o.status in ('OPEN','IN_PROGRESS','READY_FOR_REVIEW') and (o.assignee_membership = v_me or (o.status = 'READY_FOR_REVIEW' and o.created_by = v_user))
              and (p_location is null or p.location_id = p_location) loop
    kind := 'OBSERVATION'; item_id := r.id; job_id := r.job_id; ref := r.number; title := r.title; status := r.status; due_on := r.due_on;
    days_overdue := greatest(current_date - coalesce(r.due_on, current_date), 0); age_days := current_date - r.created_at::date;
    waiting_on := case when r.status = 'READY_FOR_REVIEW' then 'You (review)' else 'You' end; mine := true; link := '/daily-logs?tab=observations&item=' || r.id;
    return next;
  end loop;
  -- compliance blocking payment at companies I chase compliance for
  for r in select q.* from pm.cm_v_compliance_queue q
            where q.payment_hold_effective and q.commitment_status in ('APPROVED','EXECUTED') and (p_location is null or q.location_id = p_location)
              and q.location_id in (select pm.my_location_ids('projects.commitments', 'edit')) loop
    kind := 'COMPLIANCE_HOLD'; item_id := r.commitment_id; job_id := r.job_id; ref := r.number; title := coalesce(r.vendor_name, 'Vendor') || ' — payment on hold';
    status := coalesce(r.coi_status, 'HOLD'); due_on := r.coi_expires_on; days_overdue := greatest(current_date - coalesce(r.coi_expires_on, current_date), 0);
    age_days := 0; waiting_on := coalesce(r.vendor_name, 'Vendor'); mine := false; link := '/compliance?item=' || r.commitment_id;
    return next;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 23. Executive dashboard (CGC-110) — what the caller can see, rolled up
-- ----------------------------------------------------------------------------
create or replace function pm.cm_executive_summary(p_location uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = pm, core, public
as $$
declare v jsonb; v_year int := extract(year from current_date)::int;
begin
  select jsonb_build_object(
    'jobs', count(*),
    'contract_cents', coalesce(sum(f.revised_contract_cents), 0),
    'billed_cents', coalesce(sum(f.billed_to_date_cents), 0),
    'earned_cents', coalesce(sum(f.earned_revenue_cents), 0),
    'backlog_cents', coalesce(sum(greatest(f.revised_contract_cents - coalesce(f.earned_revenue_cents, 0), 0)), 0),
    'over_billed_cents', coalesce(sum(greatest(f.over_under_billing_cents, 0)), 0),
    'under_billed_cents', coalesce(sum(greatest(-f.over_under_billing_cents, 0)), 0),
    'projected_margin_cents', coalesce(sum(f.projected_margin_cents), 0),
    'retainage_receivable_cents', coalesce(sum(f.retainage_outstanding_cents), 0))
    into v from pm.v_job_financials f where (p_location is null or f.location_id = p_location);
  v := v || jsonb_build_object(
    'exposure', (select jsonb_build_object('approved_cents', coalesce(sum(x.approved_cents), 0), 'pending_cents', coalesce(sum(x.pending_cents), 0),
                   'pending_over_30_cents', coalesce(sum(x.pending_over_30_cents), 0), 'unpriced_count', coalesce(sum(x.unpriced_count), 0),
                   'unpriced_rom_cents', sum(x.unpriced_rom_cents), 'proceeding_count', coalesce(sum(x.proceeding_count), 0),
                   'owner_co_without_sub_co_cents', coalesce(sum(x.owner_co_without_sub_co_cents), 0))
                   from pm.cm_v_change_exposure x where (p_location is null or x.location_id = p_location)),
    'retainage_payable_cents', (select coalesce(sum(x.payable_outstanding_cents), 0) from pm.cm_v_retainage_both x where (p_location is null or x.location_id = p_location)),
    'fades', coalesce((select jsonb_agg(z order by (z ->> 'fade_gain_pts')::numeric) from (
                select jsonb_build_object('job_id', s.job_id, 'period_end', s.period_end, 'gp_pct', s.gp_pct, 'fade_gain_pts', s.fade_gain_pts,
                                          'contract_cents', s.contract_cents) as z
                  from pm.cm_wip_snapshots s
                 where s.status = 'PINNED' and (p_location is null or s.location_id = p_location) and s.fade_gain_pts < -1
                   and s.period_end = (select max(s2.period_end) from pm.cm_wip_snapshots s2 where s2.job_id = s.job_id and s2.status = 'PINNED')
                 limit 10) q), '[]'::jsonb),
    'document_control', jsonb_build_object(
       'rfis_overdue', (select count(*) from pm.cm_rfis r join pm.projects p on p.job_id = r.job_id where r.status = 'OPEN' and r.due_on < current_date and (p_location is null or p.location_id = p_location)),
       'submittals_late', (select count(*) from pm.cm_v_submittal_schedule s join pm.projects p on p.job_id = s.job_id where s.late_to_submit and (p_location is null or p.location_id = p_location))),
    'billing', jsonb_build_object(
       'pencils', (select count(*) from pm.billing_requests b where b.billing_subtype = 'SOV' and b.status = 'DRAFT' and (p_location is null or b.location_id = p_location)),
       'sub_pay_apps_in_review', (select count(*) from pm.cm_sub_pay_apps a where a.status in ('SUBMITTED','IN_REVIEW') and (p_location is null or a.location_id = p_location)),
       'compliance_holds', (select count(*) from pm.cm_v_compliance_queue q where q.payment_hold_effective and q.commitment_status in ('APPROVED','EXECUTED')
                             and (p_location is null or q.location_id = p_location))),
    'forecasts', jsonb_build_object(
       'submitted', (select count(*) from pm.cm_eac_forecasts e where e.status = 'SUBMITTED' and (p_location is null or e.location_id = p_location)),
       'late', (select count(*) from pm.cm_eac_forecasts e where e.status in ('DRAFT','REJECTED') and e.due_on < current_date and (p_location is null or e.location_id = p_location)),
       'loss_jobs', (select count(distinct e.job_id) from pm.cm_eac_forecasts e where e.status = 'APPROVED' and e.loss_flag and (p_location is null or e.location_id = p_location))),
    'proposals', (select jsonb_build_object('open', count(*), 'base_bid_cents', coalesce(sum(x.base_bid_cents), 0)) from pm.cm_proposals x
                   where x.status in ('DRAFT','SENT') and (p_location is null or x.location_id = p_location)),
    'safety', case when p_location is not null then pm.cm_osha_300a(p_location, v_year) end);
  return v;
end $$;

-- CCD / proceeding cost to date per change event (CGC-36): linked Books job cost + linked and T&M
-- labor at the pinned operational rate (aggregate only — no individual pay rate leaves) + T&M material.
create or replace function pm.cm_change_event_costs(p_job uuid)
returns table (change_event_id uuid, linked_cost_cents bigint, labor_hours numeric, labor_cost_cents bigint, tm_material_cents bigint, cost_to_date_cents bigint)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._cm_job(p_job);
  return query
  with ev as (select e.id from pm.cm_change_events e where e.org_id = j.org_id and e.job_id = p_job),
  jc as (select l.change_event_id, sum(c.amount_cents)::bigint as amt from pm.cm_change_event_cost_links l join pm.job_costs c on c.id = l.source_id
          where l.org_id = j.org_id and l.source_table = 'job_costs' and c.lifecycle in ('PENDING','CLEARED') group by 1),
  te as (select x.ce, sum(x.hours) as hrs, sum(round(x.hours * coalesce(x.rate, 0)))::bigint as amt from (
           select l.change_event_id as ce, t.hours, t.cost_rate_cents as rate from pm.cm_change_event_cost_links l join pm.time_entries t on t.id = l.source_id
            where l.org_id = j.org_id and l.source_table = 'time_entries'
           union all
           select tk.change_event_id, t.hours, t.cost_rate_cents from pm.cm_tm_ticket_lines tl join pm.cm_tm_tickets tk on tk.id = tl.ticket_id
             join pm.time_entries t on t.id = tl.time_entry_id
            where tk.org_id = j.org_id and tk.job_id = p_job and tk.change_event_id is not null and tk.status <> 'VOID'
              and not exists (select 1 from pm.cm_change_event_cost_links l2 where l2.source_table = 'time_entries' and l2.source_id = t.id)) x group by 1),
  tm as (select tk.change_event_id as ce, sum(round(coalesce(tl.qty, 0) * coalesce(tl.unit_cost_cents, 0)))::bigint as amt
           from pm.cm_tm_ticket_lines tl join pm.cm_tm_tickets tk on tk.id = tl.ticket_id
          where tk.org_id = j.org_id and tk.job_id = p_job and tk.change_event_id is not null and tk.status <> 'VOID' and tl.kind in ('MATERIAL','OTHER')
          group by 1)
  select ev.id, coalesce(jc.amt, 0), coalesce(te.hrs, 0), coalesce(te.amt, 0), coalesce(tm.amt, 0),
         coalesce(jc.amt, 0) + coalesce(te.amt, 0) + coalesce(tm.amt, 0)
    from ev left join jc on jc.change_event_id = ev.id left join te on te.ce = ev.id left join tm on tm.ce = ev.id;
end $$;

-- A safe pricing wrapper for invoker callers (the auditor): null when the caller cannot see the job's contract value.
create or replace function pm._cm_tm_price_safe(p_ticket uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_job uuid;
begin
  select t.job_id into v_job from pm.cm_tm_tickets t where t.id = p_ticket and t.org_id = public.get_org_id();
  if v_job is null then return null; end if;
  if not pm.access_is_service() and not exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = v_job) then return null; end if;
  return pm._cm_tm_price(p_ticket);
end $$;

-- ----------------------------------------------------------------------------
-- 24. Notifications (1114 catalog): ball-in-court events, raised by triggers only
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('core.notification_event_types') is not null then
    insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
      ('rfi.assigned',               'RFI waiting on you',          'An RFI''s ball in court moved to you.',                              'work',      'internal', null, true, 0,   'attention', false, 300),
      ('submittal.review_requested', 'Submittal to review',         'A submittal review step is waiting on you.',                         'documents', 'internal', null, true, 0,   'attention', false, 310),
      ('sub_pay_app.review',         'Sub pay application to review','A subcontractor pay application is at a step you approve.',         'approvals', 'internal', null, true, 0,   'attention', false, 320),
      ('compliance.expiring',        'Insurance expiring',          'A subcontractor certificate of insurance is expiring or expired.',    'approvals', 'internal', null, true, 0,   'attention', false, 330),
      ('eac.submitted',              'Cost forecast to approve',    'A project manager submitted the month''s cost forecast.',            'approvals', 'internal', null, true, 0,   'attention', false, 340),
      ('meeting.minutes',            'Meeting minutes',             'Minutes of a meeting you attended were distributed.',                 'work',      'internal', null, true, 240, 'info',      false, 350),
      ('meeting.item_assigned',      'Meeting action item',         'An action item from a meeting is yours.',                             'work',      'internal', null, true, 0,   'info',      false, 360),
      ('observation.assigned',       'Observation assigned to you', 'A quality or safety observation was assigned to you.',                'work',      'internal', null, true, 0,   'attention', false, 370),
      ('productivity.fade',          'Labor productivity fading',   'Earned hours fell behind hours used on a cost code.',                 'time',      'internal', null, true, 0,   'attention', false, 380),
      ('tm.signature_needed',        'T&M ticket to sign',          'A T&M ticket is waiting for the GC''s signature.',                    'work',      'internal', null, true, 0,   'info',      false, 390)
    on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
      mandatory = excluded.mandatory, batch_window_minutes = excluded.batch_window_minutes, severity = excluded.severity, sort = excluded.sort;
  end if;
end $$;

create or replace function pm.tg_cm_notify_assignment() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_m uuid; v_title text; v_link text; v_event text; v_subject text; v_job uuid;
begin
  if tg_table_name = 'cm_rfis' then
    if new.status not in ('OPEN','ANSWERED') or new.ball_in_court_kind <> 'INTERNAL' or new.ball_in_court_membership is null then return null; end if;
    if tg_op = 'UPDATE' and new.ball_in_court_membership is not distinct from old.ball_in_court_membership and new.status is not distinct from old.status then return null; end if;
    v_m := new.ball_in_court_membership; v_event := 'rfi.assigned'; v_title := coalesce(new.number, 'RFI') || ': ' || new.subject; v_link := '/rfis?item=' || new.id;
  elsif tg_table_name = 'cm_submittal_reviews' then
    if new.status <> 'ACTIVE' or new.reviewer_membership is null then return null; end if;
    if tg_op = 'UPDATE' and old.status = 'ACTIVE' then return null; end if;
    v_m := new.reviewer_membership; v_event := 'submittal.review_requested';
    v_title := 'Submittal to review: ' || coalesce((select s.number || ' ' || s.title from pm.cm_submittals s where s.id = new.submittal_id), '');
    v_link := '/submittals?item=' || new.submittal_id;
  elsif tg_table_name = 'cm_meeting_items' then
    if new.owner_membership is null or new.status <> 'OPEN' then return null; end if;
    if tg_op = 'UPDATE' and new.owner_membership is not distinct from old.owner_membership then return null; end if;
    v_m := new.owner_membership; v_event := 'meeting.item_assigned'; v_title := 'Action item ' || coalesce(new.item_no, '') || ': ' || new.topic;
    v_link := '/meetings?item=' || new.origin_meeting_id;
  elsif tg_table_name = 'cm_observations' then
    if new.assignee_membership is null or new.status not in ('OPEN','IN_PROGRESS') then return null; end if;
    if tg_op = 'UPDATE' and new.assignee_membership is not distinct from old.assignee_membership then return null; end if;
    v_m := new.assignee_membership; v_event := 'observation.assigned'; v_title := coalesce(new.number, 'Observation') || ': ' || new.title;
    v_link := '/daily-logs?tab=observations&item=' || new.id;
  else
    return null;
  end if;
  perform pm._cm_notify(new.org_id, v_event, new.job_id, tg_table_name, new.id, array[v_m], v_title,
    case when new.job_id is not null then core.notify_job_label(new.job_id) end, v_link, v_event || ':' || new.id || ':' || v_m);
  return null;
exception when others then
  raise warning 'cm assignment notify failed: %', sqlerrm;
  return null;
end $$;

create or replace function pm.tg_cm_notify_tm() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid;
begin
  if new.status <> 'SUBMITTED' or (tg_op = 'UPDATE' and old.status = 'SUBMITTED') then return null; end if;
  select j.location_id into v_loc from core.jobs j where j.id = new.job_id;
  perform pm._cm_notify(new.org_id, 'tm.signature_needed', new.job_id, 'cm_tm_tickets', new.id,
    pm._cm_members_with(new.org_id, v_loc, 'projects.time', 'approve'), coalesce(new.number, 'T&M ticket') || ' needs the GC''s signature',
    left(new.description, 200), '/daily-logs?tab=tm&item=' || new.id, 'tm:' || new.id);
  return null;
exception when others then
  raise warning 'cm T&M notify failed: %', sqlerrm;
  return null;
end $$;

drop trigger if exists trg_cm_notify on pm.cm_rfis;
create trigger trg_cm_notify after insert or update of ball_in_court_membership, status on pm.cm_rfis for each row execute function pm.tg_cm_notify_assignment();
drop trigger if exists trg_cm_notify on pm.cm_submittal_reviews;
create trigger trg_cm_notify after insert or update of status on pm.cm_submittal_reviews for each row execute function pm.tg_cm_notify_assignment();
drop trigger if exists trg_cm_notify on pm.cm_meeting_items;
create trigger trg_cm_notify after insert or update of owner_membership on pm.cm_meeting_items for each row execute function pm.tg_cm_notify_assignment();
drop trigger if exists trg_cm_notify on pm.cm_observations;
create trigger trg_cm_notify after insert or update of assignee_membership on pm.cm_observations for each row execute function pm.tg_cm_notify_assignment();
drop trigger if exists trg_cm_notify on pm.cm_tm_tickets;
create trigger trg_cm_notify after insert or update of status on pm.cm_tm_tickets for each row execute function pm.tg_cm_notify_tm();

-- ----------------------------------------------------------------------------
-- 25. Legacy register (proj.rfis / proj.submittals, 1005) → the pm registers (idempotent, by legacy id)
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('proj.rfis') is not null then
    execute $x$
      insert into pm.cm_rfis (org_id, job_id, number, subject, question, official_response, status, priority, discipline, spec_section, ball_in_court_name,
                              due_on, opened_at, answered_at, cost_impact, schedule_impact, legacy_id, created_at)
      select r.org_id, r.job_id, r.number, left(r.subject, 200), r.question, r.answer, r.status, r.priority, r.discipline, r.spec_section,
             coalesce(r.ball_in_court, r.assigned_to), r.due_date, r.submitted_on::timestamptz, r.answered_on::timestamptz,
             case when r.cost_impact then 'YES' else 'TBD' end, case when r.schedule_impact then 'YES' else 'TBD' end, r.id, r.created_at
        from proj.rfis r
       where exists (select 1 from pm.projects p where p.org_id = r.org_id and p.job_id = r.job_id)
      on conflict do nothing$x$;
  end if;
  if to_regclass('proj.submittals') is not null then
    execute $x$
      insert into pm.cm_submittals (org_id, job_id, number, revision, spec_section, title, submittal_type, status, ball_in_court_name, submitted_at, returned_at,
                                    legacy_id, created_at)
      select s.org_id, s.job_id, s.number, s.revision, s.spec_section, left(s.title, 200), s.submittal_type,
             case s.status when 'DRAFT' then 'NOT_STARTED' when 'UNDER_REVIEW' then 'IN_REVIEW' else s.status end,
             coalesce(s.ball_in_court, s.assigned_to), s.submitted_on::timestamptz, s.returned_on::timestamptz, s.id, s.created_at
        from proj.submittals s
       where exists (select 1 from pm.projects p where p.org_id = s.org_id and p.job_id = s.job_id)
      on conflict do nothing$x$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 26. RPC guards (1110 injection), allowlist, function + view grants
-- ----------------------------------------------------------------------------
insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  -- change chain
  ('cm_change_event_set_status','{p_change_event}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_change_events'', p_change_event);', '1120'),
  ('cm_change_event_proceed',   '{p_change_event}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_change_events'', p_change_event);', '1120: CCD / proceeding flag'),
  ('cm_link_change_cost',       '{p_change_event}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_change_events'', p_change_event); perform pm.access_assert_row(''projects.financials'', array[''view''], ''cm_change_events'', p_change_event);', '1120: cost tagging is cost'),
  ('cm_send_rfq',               '{p_change_event}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_change_events'', p_change_event); perform pm.access_assert_row(''projects.financials'', array[''view''], ''cm_change_events'', p_change_event);', '1120'),
  ('cm_rfq_set_portal_token',   '{p_rfq}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_rfqs'', p_rfq);', '1120: sub portal pricing link'),
  ('cm_rfq_respond',            '{p_rfq}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_rfqs'', p_rfq); perform pm.access_assert_row(''projects.financials'', array[''view''], ''cm_rfqs'', p_rfq);', '1120'),
  ('cm_rfq_decide',             '{p_rfq}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_rfqs'', p_rfq); perform pm.access_assert_row(''projects.financials'', array[''view''], ''cm_rfqs'', p_rfq);', '1120'),
  ('cm_build_pco',              '{p_job}',          'perform pm.access_assert_job(''projects.change_orders'', array[''edit''], p_job); perform pm.access_assert_job(''projects.contract_value'', array[''view''], p_job);', '1120'),
  ('cm_reprice_pco',            '{p_pco}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_pcos'', p_pco);', '1120'),
  ('cm_roll_to_cor',            '{p_pcos}',         'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_pcos'', gx) from unnest(p_pcos) as gx;', '1120: three-tier'),
  ('cm_submit_pco',             '{p_pco}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_pcos'', p_pco); perform pm.access_assert_row(''projects.contract_value'', array[''view''], ''cm_pcos'', p_pco);', '1120: creates the prime CO'),
  ('cm_revise_pco',             '{p_pco}',          'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''cm_pcos'', p_pco);', '1120'),
  ('cm_propose_ccos',           '{p_change_order}', 'perform pm.access_assert_row(''projects.commitments'', array[''create''], ''change_orders'', p_change_order);', '1120: drafts commitment COs'),
  -- pay apps
  ('cm_sync_cos_to_sov',        '{p_job}',          'perform pm.access_assert_job(''projects.billing'', array[''edit''], p_job);', '1120: approved COs → SOV'),
  ('cm_draft_pay_app',          '{p_job}',          'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1120'),
  ('cm_revise_pay_app',         '{p_request}',      'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', '1120'),
  ('cm_send_pencil',            '{p_request}',      'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', '1120'),
  ('cm_return_pencil',          '{p_request}',      'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', '1120'),
  ('cm_certify_pay_app',        '{p_request}',      'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', '1120'),
  ('cm_pay_app_portal',         '{p_request}',      'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''billing_requests'', p_request);', '1120'),
  -- sub pay apps / compliance
  ('cm_create_sub_pay_app',     '{p_commitment}',   'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', '1120'),
  ('cm_revise_sub_pay_app',     '{p_app}',          'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_sub_pay_apps'', p_app);', '1120'),
  ('cm_submit_sub_pay_app',     '{p_app}',          'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_sub_pay_apps'', p_app);', '1120'),
  ('cm_act_sub_pay_app',        '{p_app}',          'perform pm.access_assert_row(''projects.commitments'', array[''view''], ''cm_sub_pay_apps'', p_app);', '1120: the step capability is checked inside'),
  ('cm_void_sub_pay_app',       '{p_app}',          'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_sub_pay_apps'', p_app);', '1120'),
  ('cm_release_sub_retainage',  '{p_commitment}',   'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''commitments'', p_commitment); perform pm.access_assert_row(''projects.financials'', array[''view''], ''commitments'', p_commitment);', '1120'),
  ('cm_request_lien_waiver',    '{p_commitment}',   'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', '1120'),
  ('cm_lien_waiver_sent',       '{p_waiver}',       'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_lien_waivers'', p_waiver);', '1120'),
  ('cm_receive_lien_waiver',    '{p_waiver}',       'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_lien_waivers'', p_waiver);', '1120'),
  ('cm_verify_lien_waiver',     '{p_waiver}',       'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''cm_lien_waivers'', p_waiver);', '1120: releases a payment hold'),
  ('cm_record_sub_payment',     '{p_commitment}',   'if not (pm.access_can_row(''projects.commitments'', ''approve'', ''commitments'', p_commitment) or pm.access_can_row(''projects.billing'', ''post'', ''commitments'', p_commitment)) then perform pm.access_forbid(''requires projects.commitments:approve or projects.billing:post''); end if;', '1120: AP payment → unconditional waiver request'),
  ('cm_outbound_lien_waiver',   '{p_job}',          'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1120: the trade''s waiver to its GC'),
  ('cm_record_coi',             '{p_location,p_job}', 'if p_job is not null then perform pm.access_assert_job(''projects.commitments'', array[''edit''], p_job); else perform pm.access_assert_location(''projects.commitments'', array[''edit''], p_location); end if;', '1120'),
  ('cm_verify_coi',             '{p_coi}',          'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''cm_coi_certificates'', p_coi);', '1120'),
  ('cm_compliance_chase_run',   '{p_location}',     'if p_location is not null then perform pm.access_assert_location(''projects.commitments'', array[''edit''], p_location); elsif not pm.can(''projects.commitments'', ''edit'') then perform pm.access_forbid(''requires projects.commitments:edit''); end if;', '1120: also the cron (service)'),
  -- T&M
  ('cm_tm_price',               '{p_ticket}',       'perform pm.access_assert_row(''projects.contract_value'', array[''view''], ''cm_tm_tickets'', p_ticket);', '1120: sell at contract rates'),
  ('cm_tm_submit',              '{p_ticket}',       'perform pm.access_assert_row(''projects.time'', array[''create''], ''cm_tm_tickets'', p_ticket);', '1120'),
  ('cm_tm_sign',                '{p_ticket}',       'perform pm.access_assert_row(''projects.time'', array[''create''], ''cm_tm_tickets'', p_ticket);', '1120: GC signs on the foreman''s device'),
  ('cm_tm_dispute',             '{p_ticket}',       'perform pm.access_assert_row(''projects.time'', array[''edit''], ''cm_tm_tickets'', p_ticket);', '1120'),
  ('cm_tm_pull_hours',          '{p_ticket}',       'perform pm.access_assert_row(''projects.time'', array[''create''], ''cm_tm_tickets'', p_ticket);', '1120: hours only'),
  ('cm_bill_tm_tickets',        '{p_job}',          'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job); perform pm.access_assert_job(''projects.contract_value'', array[''view''], p_job);', '1120'),
  ('cm_tm_to_change_event',     '{p_ticket}',       'perform pm.access_assert_row(''projects.change_orders'', array[''create''], ''cm_tm_tickets'', p_ticket);', '1120'),
  -- EAC / WIP / reviews
  ('cm_start_eac',              '{p_job}',          'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1120'),
  ('cm_set_eac_line',           '{p_line}',         'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''cm_eac_lines'', p_line);', '1120'),
  ('cm_submit_eac',             '{p_forecast}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''cm_eac_forecasts'', p_forecast);', '1120'),
  ('cm_decide_eac',             '{p_forecast}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''cm_eac_forecasts'', p_forecast);', '1120: executive + SoD inside'),
  ('cm_wip_schedule',           '{p_location}',     'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1120: reads Books'' pinned WIP on the definer path'),
  ('cm_pin_wip',                '{p_location}',     'perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location);', '1120'),
  ('cm_seed_buyout',            '{p_job}',          'perform pm.access_assert_job(''projects.commitments'', array[''edit''], p_job); perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1120'),
  ('cm_build_review_package',   '{p_job}',          'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1120'),
  ('cm_submit_review_package',  '{p_package}',      'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''cm_review_packages'', p_package);', '1120'),
  ('cm_sign_review_package',    '{p_package}',      'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''cm_review_packages'', p_package);', '1120: executive + SoD inside'),
  ('cm_change_event_costs',     '{p_job}',          'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1120: aggregate labor cost, no individual rate'),
  -- document control
  ('cm_rfi_open',               '{p_rfi}',          'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_rfis'', p_rfi);', '1120'),
  ('cm_rfi_set_ball',           '{p_rfi}',          'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_rfis'', p_rfi);', '1120'),
  ('cm_rfi_respond',            '{p_rfi}',          'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_rfis'', p_rfi);', '1120'),
  ('cm_rfi_close',              '{p_rfi}',          'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_rfis'', p_rfi);', '1120'),
  ('cm_rfi_to_change_event',    '{p_rfi}',          'perform pm.access_assert_row(''projects.change_orders'', array[''create''], ''cm_rfis'', p_rfi);', '1120'),
  ('cm_import_spec_sections',   '{p_job}',          'perform pm.access_assert_job(''projects.documents'', array[''create''], p_job);', '1120'),
  ('cm_generate_submittal_register','{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1120'),
  ('cm_submittal_submit',       '{p_submittal}',    'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_submittals'', p_submittal);', '1120'),
  ('cm_submittal_respond',      '{p_review}',       'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_submittal_reviews'', p_review);', '1120: external reviewers answer through the portal (service)'),
  ('cm_submittal_revise',       '{p_submittal}',    'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_submittals'', p_submittal);', '1120'),
  ('cm_submittal_release_fab',  '{p_submittal}',    'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_submittals'', p_submittal);', '1120'),
  ('cm_meeting_next',           '{p_meeting}',      'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_meetings'', p_meeting);', '1120'),
  ('cm_meeting_distribute',     '{p_meeting}',      'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_meetings'', p_meeting);', '1120'),
  ('cm_meeting_accept',         '{p_attendee}',     'perform pm.access_assert_row(''projects.jobs'', array[''view''], ''cm_meeting_attendees'', p_attendee);', '1120: the attendee or the job editor (checked inside)'),
  -- field
  ('cm_daily_log_open',         '{p_job}',          'perform pm.access_assert_job(''projects.documents'', array[''create''], p_job);', '1120'),
  ('cm_daily_log_sign',         '{p_log}',          'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''cm_daily_logs'', p_log);', '1120'),
  ('cm_daily_log_amend',        '{p_log}',          'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''cm_daily_logs'', p_log);', '1120'),
  ('cm_daily_log_apply_voice',  '{p_voice}',        'perform pm.access_assert_row(''projects.documents'', array[''create''], ''cm_daily_log_voice'', p_voice);', '1120'),
  ('cm_start_inspection',       '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1120'),
  ('cm_complete_inspection',    '{p_inspection}',   'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''cm_inspections'', p_inspection);', '1120'),
  ('cm_sign_jha',               '{p_jha}',          'perform pm.access_assert_row(''projects.documents'', array[''create''], ''cm_jhas'', p_jha);', '1120'),
  ('cm_generate_closeout',      '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1120'),
  ('cm_job_close_gate',         '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1120: counts only, no amounts'),
  ('cm_close_job',              '{p_job}',          'if not (pm.access_can_job(''projects.billing'', ''post'', p_job) or pm.access_can_job(''projects.settings'', ''configure'', p_job)) then perform pm.access_forbid(''requires projects.billing:post or projects.settings:configure''); end if;', '1120'),
  -- specialty trade + platform
  ('cm_labor_productivity',     '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1120: hours only'),
  ('cm_run_fade_alerts',        '{p_job}',          'perform pm.access_assert_job(''projects.time'', array[''approve''], p_job);', '1120'),
  ('cm_foreman_plan',           '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1120: no dollars'),
  ('cm_proposal_send',          '{p_proposal}',     'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''cm_proposals'', p_proposal);', '1120'),
  ('cm_proposal_accept',        '{p_proposal}',     'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''cm_proposals'', p_proposal); perform pm.access_assert_row(''projects.jobs'', array[''create''], ''cm_proposals'', p_proposal);', '1120: creates the job'),
  ('cm_apply_project_template', '{p_job}',          'if not (pm.access_can_job(''projects.settings'', ''configure'', p_job) or pm.access_can_job(''projects.billing'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.settings:configure or projects.billing:edit''); end if;', '1120: sets contract terms'),
  ('cm_push_project_template',  '{p_template}',     'perform pm.access_assert_row(''projects.settings'', array[''configure''], ''cm_project_templates'', p_template);', '1120: global update'),
  ('cm_seed_commercial',        '{p_location}',     'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1120'),
  ('cm_seed_project_directory', '{p_job}',          'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1120')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('_cm_is_executive',  '1120: describes the caller''s own persona at a company (invoker inbox reads it)'),
  ('_cm_tm_price_safe', '1120: returns null unless the caller holds contract_value on the ticket''s job')
on conflict (function_name) do update set reason = excluded.reason;

select pm.access_apply_rpc_guards();

do $$
declare r record;
  v_member text[] := array[
    'cm_change_event_set_status','cm_change_event_proceed','cm_link_change_cost','cm_send_rfq','cm_rfq_set_portal_token','cm_rfq_respond','cm_rfq_decide',
    'cm_build_pco','cm_reprice_pco','cm_roll_to_cor','cm_submit_pco','cm_revise_pco','cm_propose_ccos',
    'cm_sync_cos_to_sov','cm_draft_pay_app','cm_revise_pay_app','cm_send_pencil','cm_return_pencil','cm_certify_pay_app','cm_pay_app_portal','cm_pay_app_preview',
    'cm_create_sub_pay_app','cm_revise_sub_pay_app','cm_submit_sub_pay_app','cm_act_sub_pay_app','cm_void_sub_pay_app','cm_release_sub_retainage',
    'cm_request_lien_waiver','cm_lien_waiver_sent','cm_receive_lien_waiver','cm_verify_lien_waiver','cm_record_sub_payment','cm_outbound_lien_waiver',
    'cm_record_coi','cm_verify_coi','cm_compliance_chase_run',
    'cm_tm_price','cm_tm_submit','cm_tm_sign','cm_tm_dispute','cm_tm_pull_hours','cm_bill_tm_tickets','cm_tm_to_change_event',
    'cm_start_eac','cm_set_eac_line','cm_submit_eac','cm_decide_eac','cm_wip_schedule','cm_pin_wip','cm_seed_buyout','cm_build_review_package',
    'cm_submit_review_package','cm_sign_review_package','cm_job_cost_detail','cm_change_event_costs',
    'cm_rfi_open','cm_rfi_set_ball','cm_rfi_respond','cm_rfi_close','cm_rfi_to_change_event','cm_import_spec_sections','cm_generate_submittal_register',
    'cm_submittal_submit','cm_submittal_respond','cm_submittal_revise','cm_submittal_release_fab','cm_meeting_next','cm_meeting_distribute','cm_meeting_accept',
    'cm_daily_log_open','cm_daily_log_sign','cm_daily_log_amend','cm_daily_log_apply_voice','cm_start_inspection','cm_complete_inspection','cm_sign_jha',
    'cm_osha_300','cm_osha_300a','cm_generate_closeout','cm_job_close_gate','cm_close_job',
    'cm_labor_productivity','cm_run_fade_alerts','cm_foreman_plan','cm_proposal_send','cm_proposal_accept','cm_apply_project_template',
    'cm_push_project_template','cm_seed_commercial','cm_seed_project_directory',
    'cm_billing_audit','cm_billing_audit_company','cm_ball_in_court','cm_executive_summary',
    '_cm_is_executive','_cm_tm_price_safe'];
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and (p.proname like 'cm\_%' or p.proname like '\_cm\_%' or p.proname like 'tg\_cm\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_member) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- views: members read through their own RLS (security_invoker) — never anon
do $$
declare v text;
begin
  foreach v in array array['cm_v_change_exposure','cm_v_owner_sub_gap','cm_v_buyout','cm_v_retainage_both','cm_v_payable_retainage','cm_v_compliance_queue',
    'cm_v_submittal_schedule','cm_v_delay_register','cm_v_manpower','cm_v_billing_calendar','cm_v_workforce_conflicts','cm_v_sub_pay_app_check',
    'cm_v_project_directory'] loop
    execute format('revoke all on pm.%I from public, anon', v);
    execute format('grant select on pm.%I to authenticated, service_role', v);
  end loop;
end $$;

-- ============================================================================
-- end 1120_pm_commercial_depth
-- ============================================================================
