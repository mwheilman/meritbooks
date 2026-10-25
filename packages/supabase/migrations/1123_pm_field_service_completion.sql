-- ============================================================================
-- 1123 · Merit Projects — field-service completion (Wave C, agent C-FS)
--
-- Spec: /home/claude/panel/03-field-service.md (seat 03, the Launch rows 1117 left open) and
-- docs/projects/WAVE-C-BRIEF.md (binding rules). Builds on 1104 (work orders, dispatch, assets,
-- stock), 1102 (commitments, receipts, billing requests, deposits, SOV), 1110 (access), 1113
-- (approvals: commitments, billing requests, time entries stay gated there), 1114 (notifications:
-- every customer message goes through core.notify_customer), 1117 (field-service depth), 1118
-- (portals: portal.* session functions), 1119 (res_permits / res_inspections, reused for installs).
-- Nothing in 1100–1122 is modified: additive columns, new tables, new definer RPCs, and additive
-- triggers that only act on rows they create or that are exception-safe.
-- One exception (§19b): pm.fs_sell_estimate (1117) is redefined with a trailing p_signed_at (default
-- null keeps every caller's behaviour) so the phone's sale carries the signing time; same guard.
--
-- MONEY RULES (1110): bigint cents, fractions for percents, integer half-up rounding (pm.fs_rdiv).
-- Cost columns are masked (financials), sell / contract columns are masked (contract_value) where a
-- CSR or tech must not see them; every definer RPC that returns money strips it unless the caller
-- holds the capability at that company / job. NO GL: Books owns invoices, AR, deposits, sales tax
-- posting, lender receivables and payroll. Projects keeps facts, states and documents.
--
-- WHAT THIS ADDS (panel row → objects)
--   FS-05  telephony / call tracking: fs_phone_providers (RINGCENTRAL | DIALPAD | TWILIO_VOICE, DISABLED
--          until the app holds the provider credentials), fs_call_log (one row per provider call id,
--          tracking number → campaign, caller → customer, linked to the call / job / visit),
--          public.fs_voice_event (server-key webhook ingest), fs_link_call, fs_call_report.
--   FS-12  two-way messaging: fs_message_templates, fs_threads, fs_thread_messages; fs_send_message
--          (core.notify_customer — consent, STOP, quiet hours, go-live hold all apply);
--          public.fs_inbound_sms (STOP / START / HELP through core.notify_inbound_sms, then the text is
--          routed to the customer's thread — the open job's thread first).
--   FS-22  reminders 24 h / 2 h with reply-to-confirm: fs_appointment_reminders; work_orders gains
--          customer_confirmation / customer_confirmed_at (the board reads them). Replies C / YES /
--          CONFIRM confirm, R / RESCHEDULE asks for a new time, CANCEL asks to cancel.
--          Outbox bridge: 1117 queued pm.fs_messages that nothing delivered — _fs_deliver_outbox now
--          hands each due row to core.notify_customer. public.fs_cron_tick (server key) runs reminders,
--          follow-ups and the bridge for every company; pm.fs_run_automations does one company now.
--   FS-26  offline tech app parity: fs_field_commands (idempotency ledger, one row per phone command
--          id); fs_upsert_equipment, fs_forms_for_wo, fs_my_will_calls; every new phone-facing RPC
--          takes the client command id and applies it at most once (app/api/field/service/**).
--   FS-29  forms with required readings: fs_form_templates (seeded tune-up / combustion safety /
--          commissioning), fs_form_submissions; fs_submit_form refuses a form missing a required
--          reading, flags out-of-range readings and requires a signature on a red tag.
--   FS-30/31 photos + voice notes → structured notes: fs_visit_notes (transcript, diagnosis, work
--          performed, recommendations, customer summary, photo tags; structured by the app's rules);
--          fs_save_visit_note writes cause / resolution onto the visit when empty.
--   FS-56  unsold-estimate follow-up: fs_followup_cadences (seeded 1 / 3 / 7 / 14 days), fs_estimate_followups
--          (started when an estimate is presented, stopped when sold / declined), fs_followup_queue.
--   FS-57  comfort-advisor pipeline: fs_opportunities (TGL / marketing / call source, stage LEAD →
--          APPOINTMENT → PROPOSAL → SOLD | LOST), fed by TGLs and estimates; fs_advisor_pipeline.
--   FS-59  online estimate approval: portal.fs_estimate / portal.fs_estimate_accept (session scoped,
--          sell prices only), fs_online_acceptances; staff finalize with fs_finalize_online_acceptance
--          (the deposit then rides pm.request_deposit → a Books deposit invoice the portal pays).
--   FS-79–86 install projects: fs_install_projects (stage board SOLD → … → CLOSED), fs_install_items,
--          fs_handoff_install (signed proposal → project, items, INSTALL visit, contract value),
--          fs_install_po (job PO from the sold equipment, will-call / delivery; approval stays in 1113),
--          fs_receive_po (receipts through pm.record_receipt + serials), fs_serial_units,
--          fs_permit_templates + fs_apply_permit / fs_update_permit (pm.res_permits / res_inspections),
--          fs_install_capacity + fs_install_crew_days + fs_schedule_install + fs_install_earliest,
--          fs_commission_install (commissioning form + walkthrough → equipment records, registration
--          deadlines), fs_install_costing (estimated vs actual from Books job cost), fs_install_bill
--          (deposit / progress / final, SOV for light commercial via pm.generate_sov_billing),
--          fs_install_setup_sov, fs_install_board, fs_set_install_stage.
--   FS-90  purchasing / will-call: fs_po_details (fulfillment, pickup code), fs_my_will_calls,
--          fs_receive_po with the pickup code from the counter.
--   FS-94  invoice review queue: fs_invoice_reviews (a completed customer-pay visit waits here; rules
--          flag missing items, parts used but not billed, below-floor prices, member pricing errors,
--          missing photos / forms, undecided options); fs_decide_review → a DRAFT billing request the
--          app sends through the 1113 approval engine.
--   FS-95  sales tax by line: fs_tax_rules (line kind × state taxability), fs_tax_rate (Books'
--          public.sales_tax_rates, most specific wins), fs_tax_lines, fs_tax_snapshots (rate pinned at
--          quote; the review reuses it so quote tax = invoice tax), fs_quote_tax.
--   FS-96  text-to-pay / auto-pay: fs_text_to_pay (the Books invoice pay link, by text / email, no
--          amount in the message), fs_autopay_enrollments + fs_request_autopay (consent recorded;
--          charging a stored card is a Books request).
--   FS-97  financing funding reconciliation: fs_financed_sales (from a sold estimate with a plan; dealer
--          fee pinned, masked), fs_update_financing, fs_financing_recon (days outstanding, chase flag).
--   FS-102 timesheet review: fs_timesheet_exceptions (long drive, unexplained gap, daily / weekly
--          overtime, missing clock-out, done visit with no time) with a proposed fix per flag.
--   FS-109 role dashboards: fs_dashboard (gm | dispatcher | service_manager | install_pm), money stripped.
--   FS-110 plain-language Q&A (rules-only until AI is on): fs_metric over a fixed metric catalog the
--          app's parser maps questions onto (apps/projects lib/fieldservice/qa.ts).
--   FS-112 billing integrity auditor: fs_integrity_findings, fs_run_integrity, fs_task_finding,
--          fs_dismiss_finding.
--   FS-115 client hub: portal.fs_hub (visits with live tech status, estimates, agreements, equipment and
--          warranty, history), portal.fs_confirm_visit.
--   FS-117 guided setup + shadow run: fs_setup_status, fs_shadow_runs, fs_record_shadow_day,
--          fs_shadow_report, fs_seed_completion (templates, forms, cadence, permit template, tax rules).
--
-- ACCESS (1110 classes)
--   S  fs_message_templates, fs_form_templates, fs_followup_cadences (settings) · fs_permit_templates
--      (settings; fee masked financials) · fs_install_capacity (dispatch) · fs_tax_rules (settings)
--   C  fs_phone_providers (settings) · fs_call_log (dispatch / customers / leads) · fs_threads,
--      fs_thread_messages (dispatch / customers; job team reads its job's thread) ·
--      fs_appointment_reminders (dispatch / customers) · fs_autopay_enrollments (billing / customers)
--      · fs_integrity_findings (billing / reports / financials; amount masked financials) ·
--      fs_shadow_runs (reports / settings; totals masked contract_value)
--   J  fs_form_submissions, fs_visit_notes, fs_online_acceptances, fs_install_projects, fs_install_items,
--      fs_po_details, fs_serial_units, fs_install_crew_days, fs_tax_snapshots, fs_estimate_followups
--      (jobs) · fs_opportunities (job_or_location: leads / estimates) · fs_invoice_reviews (billing /
--      dispatch)
--   M  fs_financed_sales (contract_value; dealer fee masked financials)
--   P  fs_field_commands (own rows)
--   Every write is a definer RPC except the S config tables (class write caps). Every member RPC is in
--   pm.access_rpc_guards; helpers (pm._fs_*) and triggers are service-only; nothing in pm is executable
--   by anon. The anon surface is public.fs_voice_event / fs_inbound_sms / fs_cron_tick (server key,
--   fail closed: pm.fs_widget_server_keys from 1117) and portal.fs_* (portal session).
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * Sales tax: Books computes tax at the invoice level from the customer address. Projects computes
--     the same rate per line from Books' own rate table and pins it at quote; the JOB_BILLING wire has
--     no per-line tax field yet → documented Books request (taxable flag + tax_cents + jurisdiction per
--     line). Until then the review stores the line tax and the billing request memo carries the total.
--   * Auto-pay: Books has no stored-card charge yet. Enrollment + consent are recorded here (REQUESTED);
--     charging is a Books request. Text-to-pay uses the existing Books pay link (public.invoices.public_token).
--   * Financing: the lender receivable and dealer-fee posting stay in Books; Projects tracks funding.
--   * Stock POs: pm.commitments always belong to a job, so FS-90 covers job POs and will-call; stock
--     (warehouse) POs need a Books / commitments change (reported).
--   * Webhooks and the client hub are public routes under /api/fieldservice/public/** (middleware
--     matcher requested from the integration owner).
--
-- APPLY RULE: after 1100–1122. Idempotent (safe twice); PGlite-safe.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then raise exception '1123 requires 1110_pm_access'; end if;
  if to_regclass('pm.fs_estimates') is null then raise exception '1123 requires 1117_pm_field_service_depth'; end if;
  if to_regclass('core.outbound_messages') is null then raise exception '1123 requires 1114_notifications'; end if;
  if to_regclass('pm.approval_requests') is null then raise exception '1123 requires 1113_pm_approvals'; end if;
  if to_regclass('pm.portal_sessions') is null then raise exception '1123 requires 1118_pm_portals'; end if;
  if to_regclass('pm.res_permits') is null then raise exception '1123 requires 1119_pm_residential'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Helpers
-- ----------------------------------------------------------------------------
-- E.164 (US default) for matching caller ids, senders and contacts.
create or replace function pm._fs_e164(p text) returns text
language sql immutable
set search_path = pm, core, public
as $$ select core.notify_e164(p) $$;

-- Reply intent of an inbound text (mirrored by apps/projects lib/fieldservice/replies.ts).
create or replace function pm._fs_reply_intent(p_body text) returns text
language sql immutable
set search_path = pm, public
as $$
  select case
    when w in ('C','Y','YES','CONFIRM','CONFIRMED','OK','OKAY','1') then 'CONFIRM'
    when w in ('R','RESCHEDULE','RESCHED','CHANGE','2') then 'RESCHEDULE'
    when w in ('CANCEL','CANCELLED','3') then 'CANCEL'
    when w in ('STOP','STOPALL','UNSUBSCRIBE','END','QUIT','REVOKE','OPTOUT') then 'STOP'
    else 'OTHER' end
  from (select upper(regexp_replace(split_part(btrim(coalesce(p_body, '')), ' ', 1), '[^A-Za-z0-9]', '', 'g')) as w) x
$$;

-- Fill {placeholders} in a message template from a jsonb of values (unknown keys stay as typed).
create or replace function pm._fs_fill(p_body text, p_vals jsonb) returns text
language plpgsql immutable
set search_path = pm, public
as $$
declare k text; v text; r text := coalesce(p_body, '');
begin
  for k, v in select key, value from jsonb_each_text(coalesce(p_vals, '{}'::jsonb)) loop
    r := replace(r, '{' || k || '}', coalesce(v, ''));
  end loop;
  return r;
end $$;


-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
create table if not exists pm.fs_field_commands (
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  command_id  uuid not null,
  kind        text not null check (char_length(kind) between 1 and 60),
  user_id     text,
  subject_id  uuid,
  result      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (org_id, command_id)
);

-- Idempotency ledger reads / writes for phone commands (same transaction as the work).
-- Claim up front (security review L1): a transaction advisory lock on (org, command id) makes a
-- concurrent re-send wait until the first one commits and then answer with its result — never a
-- second application. A command id already used for another kind, or by another user, is refused.
drop function if exists pm._fs_cmd_seen(uuid, uuid);
create or replace function pm._fs_cmd_seen(p_org uuid, p_command uuid, p_kind text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare c pm.fs_field_commands%rowtype;
begin
  if p_command is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.fs_cmd:' || p_org::text || ':' || p_command::text, 0));
  select * into c from pm.fs_field_commands x where x.org_id = p_org and x.command_id = p_command;
  if c.command_id is null then return null; end if;
  if c.kind is distinct from p_kind or c.user_id is distinct from pm.current_user_id() then
    raise exception 'PM_FS_COMMAND_MISMATCH: that command id was already used for another action' using errcode = '22023';
  end if;
  return c.result;
end $$;

create or replace function pm._fs_cmd_done(p_org uuid, p_command uuid, p_kind text, p_subject uuid, p_result jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  if p_command is null then return p_result; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.fs_cmd:' || p_org::text || ':' || p_command::text, 0));
  insert into pm.fs_field_commands (org_id, command_id, kind, user_id, subject_id, result)
  values (p_org, p_command, p_kind, pm.current_user_id(), p_subject, coalesce(p_result, '{}'::jsonb))
  on conflict (org_id, command_id) do nothing;
  if not found then
    raise exception 'PM_FS_COMMAND_MISMATCH: that command id was already used' using errcode = '22023';
  end if;
  return p_result;
end $$;

-- Platform configuration (service_role only; security review M1): the Books / Projects base URLs used
-- in links sent to customers. Never taken from a caller; the check constraint is the allowlist.
create table if not exists pm.fs_platform_settings (
  key         text primary key check (key in ('books_base_url','projects_base_url')),
  value       text not null check (value ~ '^https://(books|projects)\.meritmgt\.com$'),
  updated_at  timestamptz not null default now()
);

create or replace function pm._fs_app_url(p_app text) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select s.value from pm.fs_platform_settings s where s.key = p_app || '_base_url'),
                  case p_app when 'books' then 'https://books.meritmgt.com' when 'projects' then 'https://projects.meritmgt.com' end)
$$;


-- FS-05 ---------------------------------------------------------------------
create table if not exists pm.fs_phone_providers (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  provider                 text not null check (provider in ('RINGCENTRAL','DIALPAD','TWILIO_VOICE')),
  status                   text not null default 'DISABLED' check (status in ('DISABLED','ACTIVE')),
  account_label            text check (account_label is null or char_length(account_label) <= 120),
  main_numbers             text[] not null default '{}',
  record_calls             boolean not null default true,
  recording_disclosure     text check (recording_disclosure is null or char_length(recording_disclosure) <= 500),
  activated_at             timestamptz,
  activated_by             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, location_id, provider),
  unique (org_id, id),
  check (status <> 'ACTIVE' or activated_at is not null)
);

create table if not exists pm.fs_call_log (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  provider           text not null check (provider in ('RINGCENTRAL','DIALPAD','TWILIO_VOICE')),
  provider_call_id   text not null check (char_length(provider_call_id) between 1 and 120),
  direction          text not null default 'INBOUND' check (direction in ('INBOUND','OUTBOUND')),
  from_number        text,
  to_number          text,
  tracking_number    text,
  campaign_id        uuid,
  customer_id        uuid references core.customers(id),
  contact_id         uuid references core.contacts(id),
  service_call_id    uuid,
  work_order_id      uuid,
  job_id             uuid,
  started_at         timestamptz not null default now(),
  answered_at        timestamptz,
  ended_at           timestamptz,
  duration_seconds   int check (duration_seconds is null or duration_seconds >= 0),
  outcome            text not null default 'IN_PROGRESS' check (outcome in ('IN_PROGRESS','ANSWERED','MISSED','VOICEMAIL','ABANDONED','BUSY','FAILED')),
  agent_name         text check (agent_name is null or char_length(agent_name) <= 120),
  agent_employee_id  uuid references core.employees(id),
  recording_ref      text check (recording_ref is null or char_length(recording_ref) <= 500),
  recording_seconds  int check (recording_seconds is null or recording_seconds >= 0),
  transcript         text,
  linked_by          text,
  linked_at          timestamptz,
  last_event_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, provider, provider_call_id),
  unique (org_id, id),
  foreign key (org_id, campaign_id) references pm.campaigns (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_call_log_loc_idx on pm.fs_call_log (org_id, location_id, started_at desc);
create index if not exists pm_fs_call_log_from_idx on pm.fs_call_log (org_id, from_number);

-- Platform registry of provider phone numbers (security review H1). A provider webhook names only
-- the dialled number; the company it belongs to comes from here and nowhere else. Rows are written by
-- the platform (service_role) after the provider account is verified to own the number — never by a
-- member, so no company can claim another company's number. Main and tracking numbers alike.
create table if not exists pm.fs_voice_numbers (
  phone        text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  provider     text not null check (provider in ('RINGCENTRAL','DIALPAD','TWILIO_VOICE')),
  verified_at  timestamptz,
  note         text check (note is null or char_length(note) <= 300),
  created_at   timestamptz not null default now()
);
create index if not exists pm_fs_voice_numbers_org_idx on pm.fs_voice_numbers (org_id, location_id, provider);

-- Events the ingest ignored or found ambiguous (service_role only; for the platform to review).
create table if not exists pm.fs_voice_event_log (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references core.organizations(id) on delete cascade,
  location_id       uuid references core.locations(id),
  provider          text not null,
  provider_call_id  text,
  number            text,
  reason            text not null check (char_length(reason) between 1 and 200),
  created_at        timestamptz not null default now()
);
create index if not exists pm_fs_voice_event_log_at_idx on pm.fs_voice_event_log (created_at desc);

-- FS-12 ---------------------------------------------------------------------
create table if not exists pm.fs_message_templates (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label        text not null check (char_length(label) between 1 and 80),
  kind         text not null default 'GENERAL' check (kind in ('GENERAL','REMINDER_24H','REMINDER_2H','FOLLOW_UP','PAY','CONFIRM_ACK','RESCHEDULE_ACK')),
  channel      text not null default 'SMS' check (channel in ('SMS','EMAIL')),
  subject      text check (subject is null or char_length(subject) <= 200),
  body         text not null check (char_length(body) between 1 and 1600),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id)
);

create table if not exists pm.fs_threads (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  customer_id       uuid references core.customers(id),
  unknown_from      text,
  contact_id        uuid references core.contacts(id),
  job_id            uuid,
  work_order_id     uuid,
  subject           text check (subject is null or char_length(subject) <= 200),
  status            text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  last_message_at   timestamptz not null default now(),
  last_direction    text check (last_direction is null or last_direction in ('IN','OUT','NOTE')),
  unread_count      int not null default 0 check (unread_count >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  check (customer_id is not null or unknown_from is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_threads_open_uidx on pm.fs_threads
  (org_id, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(job_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(unknown_from, '')) where status = 'OPEN';
create index if not exists pm_fs_threads_loc_idx on pm.fs_threads (org_id, location_id, last_message_at desc);

create table if not exists pm.fs_thread_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  thread_id       uuid not null,
  job_id          uuid,
  direction       text not null check (direction in ('IN','OUT','NOTE')),
  channel         text not null check (channel in ('SMS','EMAIL','NOTE','PORTAL')),
  body            text not null check (char_length(body) between 1 and 4000),
  from_address    text,
  to_address      text,
  contact_id      uuid references core.contacts(id),
  outbound_id     uuid,
  provider_sid    text check (provider_sid is null or char_length(provider_sid) <= 120),
  status          text not null default 'QUEUED' check (status in ('QUEUED','HELD','SENT','SUPPRESSED','SKIPPED','FAILED','RECEIVED','NOTE')),
  status_reason   text,
  intent          text check (intent is null or intent in ('CONFIRM','RESCHEDULE','CANCEL','STOP','OTHER')),
  template_key    text,
  author_user_id  text,
  author_name     text,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, thread_id) references pm.fs_threads (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_fs_thread_messages_thread_idx on pm.fs_thread_messages (org_id, thread_id, created_at);
create unique index if not exists pm_fs_thread_messages_sid_uidx on pm.fs_thread_messages (org_id, provider_sid) where provider_sid is not null;

-- FS-22 ---------------------------------------------------------------------
alter table pm.work_orders add column if not exists customer_confirmation text;
alter table pm.work_orders add column if not exists customer_confirmed_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'work_orders_fs_confirm_chk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_fs_confirm_chk
      check (customer_confirmation is null or customer_confirmation in ('CONFIRMED','RESCHEDULE_REQUESTED','CANCEL_REQUESTED'));
  end if;
end $$;

alter table pm.fs_messages add column if not exists outbound_id uuid;
alter table pm.fs_messages add column if not exists delivered_at timestamptz;

create table if not exists pm.fs_appointment_reminders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  work_order_id    uuid not null,
  job_id           uuid not null,
  kind             text not null check (kind in ('REMINDER_24H','REMINDER_2H')),
  visit_start      timestamptz not null,
  due_at           timestamptz not null,
  status           text not null default 'SCHEDULED' check (status in ('SCHEDULED','SENT','SUPPRESSED','SKIPPED','CANCELLED')),
  fs_message_id    uuid,
  contact_id       uuid references core.contacts(id),
  phone            text,
  awaiting_reply   boolean not null default false,
  reply_intent     text check (reply_intent is null or reply_intent in ('CONFIRM','RESCHEDULE','CANCEL','STOP','OTHER')),
  replied_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, work_order_id, kind, visit_start),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_fs_reminders_due_idx on pm.fs_appointment_reminders (status, due_at) where status = 'SCHEDULED';
create index if not exists pm_fs_reminders_reply_idx on pm.fs_appointment_reminders (org_id, phone) where awaiting_reply;

-- FS-29 ---------------------------------------------------------------------
create table if not exists pm.fs_form_templates (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  key                 text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name                text not null check (char_length(name) between 1 and 120),
  kind                text not null default 'OTHER' check (kind in ('TUNE_UP','SAFETY','COMMISSIONING','INSPECTION','OTHER')),
  job_type_keys       text[] not null default '{}',
  wo_kinds            text[] not null default '{}',
  fields              jsonb not null default '[]' check (jsonb_typeof(fields) = 'array'),
  requires_signature  boolean not null default false,
  version             int not null default 1 check (version >= 1),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id)
);

create table if not exists pm.fs_form_submissions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  work_order_id       uuid not null,
  template_id         uuid not null,
  template_key        text not null,
  template_kind       text not null,
  template_version    int not null,
  answers             jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  out_of_range        jsonb not null default '[]' check (jsonb_typeof(out_of_range) = 'array'),
  failed_items        text[] not null default '{}',
  red_tag             boolean not null default false,
  red_tag_reason      text,
  signed_name         text check (signed_name is null or char_length(signed_name) <= 120),
  signed_at           timestamptz,
  signature_path      text check (signature_path is null or char_length(signature_path) <= 20000),
  photo_command_ids   uuid[] not null default '{}',
  client_command_id   uuid,
  submitted_by        text default pm.current_user_id(),
  submitted_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, template_id) references pm.fs_form_templates (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_form_sub_cmd_uidx on pm.fs_form_submissions (org_id, client_command_id) where client_command_id is not null;
create index if not exists pm_fs_form_sub_wo_idx on pm.fs_form_submissions (org_id, work_order_id);

-- FS-30 / FS-31 -------------------------------------------------------------
create table if not exists pm.fs_visit_notes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  work_order_id       uuid not null,
  source              text not null default 'TYPED' check (source in ('VOICE','TYPED')),
  transcript          text check (transcript is null or char_length(transcript) <= 20000),
  diagnosis           text check (diagnosis is null or char_length(diagnosis) <= 4000),
  work_performed      text check (work_performed is null or char_length(work_performed) <= 4000),
  recommendations     text check (recommendations is null or char_length(recommendations) <= 4000),
  customer_summary    text check (customer_summary is null or char_length(customer_summary) <= 4000),
  structured_by       text not null default 'RULES' check (structured_by in ('RULES','AI','PERSON')),
  photo_command_ids   uuid[] not null default '{}',
  photo_tags          jsonb not null default '{}' check (jsonb_typeof(photo_tags) = 'object'),
  client_command_id   uuid,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_fs_visit_notes_cmd_uidx on pm.fs_visit_notes (org_id, client_command_id) where client_command_id is not null;

-- FS-56 ---------------------------------------------------------------------
create table if not exists pm.fs_followup_cadences (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name         text not null check (char_length(name) between 1 and 120),
  steps        jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),
  is_default   boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id)
);

create table if not exists pm.fs_estimate_followups (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  job_id             uuid not null,
  estimate_id        uuid not null,
  cadence_id         uuid,
  step_no            int not null check (step_no >= 1),
  channel            text not null check (channel in ('SMS','EMAIL','CALL_TASK')),
  body               text,
  due_at             timestamptz not null,
  status             text not null default 'SCHEDULED' check (status in ('SCHEDULED','DUE','SENT','DONE','SKIPPED','SUPPRESSED','CANCELLED')),
  owner_employee_id  uuid references core.employees(id),
  fs_message_id      uuid,
  outcome            text check (outcome is null or char_length(outcome) <= 500),
  completed_at       timestamptz,
  completed_by       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, estimate_id, step_no),
  unique (org_id, id),
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_followups_due_idx on pm.fs_estimate_followups (status, due_at) where status = 'SCHEDULED';

-- FS-57 ---------------------------------------------------------------------
create table if not exists pm.fs_opportunities (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid,
  customer_id          uuid references core.customers(id),
  site_id              uuid references core.sites(id),
  title                text not null check (char_length(title) between 1 and 200),
  source               text not null default 'MARKETING' check (source in ('TGL','MARKETING','CALL','WEB','REFERRAL','AGREEMENT','OTHER')),
  tgl_id               uuid,
  campaign_id          uuid,
  business_unit_id     uuid,
  advisor_employee_id  uuid references core.employees(id),
  set_by_employee_id   uuid references core.employees(id),
  stage                text not null default 'LEAD' check (stage in ('LEAD','APPOINTMENT','PROPOSAL','SOLD','LOST')),
  lost_reason          text check (lost_reason is null or char_length(lost_reason) <= 500),
  appointment_at       timestamptz,
  estimate_id          uuid,
  sold_cents           bigint check (sold_cents is null or sold_cents >= 0),
  install_project_id   uuid,
  stage_changed_at     timestamptz not null default now(),
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  check (stage <> 'LOST' or lost_reason is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, tgl_id) references pm.fs_tgl_leads (org_id, id) deferrable initially immediate,
  foreign key (org_id, campaign_id) references pm.campaigns (org_id, id) deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_opp_tgl_uidx on pm.fs_opportunities (org_id, tgl_id) where tgl_id is not null;
create unique index if not exists pm_fs_opp_est_uidx on pm.fs_opportunities (org_id, estimate_id) where estimate_id is not null;

-- FS-59 ---------------------------------------------------------------------
create table if not exists pm.fs_online_acceptances (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null,
  estimate_id          uuid not null,
  option_id            uuid not null,
  selected_item_ids    uuid[] not null default '{}',
  deselected_item_ids  uuid[] not null default '{}',
  typed_name           text not null check (char_length(typed_name) between 2 and 200),
  portal_grant_id      uuid,
  person_id            uuid,
  ip                   text check (ip is null or char_length(ip) <= 64),
  user_agent           text check (user_agent is null or char_length(user_agent) <= 500),
  accepted_at          timestamptz not null default now(),
  status               text not null default 'PENDING' check (status in ('PENDING','FINALIZED','SUPERSEDED','REJECTED')),
  finalized_by         text,
  finalized_at         timestamptz,
  reject_reason        text,
  unique (org_id, id),
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, option_id) references pm.fs_estimate_options (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_fs_online_acc_pending_uidx on pm.fs_online_acceptances (org_id, estimate_id) where status = 'PENDING';

-- FS-79 … FS-86 --------------------------------------------------------------
create table if not exists pm.fs_install_projects (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  job_id                 uuid not null,
  number                 text,
  title                  text not null check (char_length(title) between 1 and 200),
  estimate_id            uuid,
  opportunity_id         uuid,
  customer_id            uuid references core.customers(id),
  site_id                uuid references core.sites(id),
  stage                  text not null default 'SOLD' check (stage in ('SOLD','ORDERED','PERMITTED','SCHEDULED','INSTALLED','INSPECTED','CLOSED','CANCELLED')),
  stage_changed_at       timestamptz not null default now(),
  is_commercial          boolean not null default false,
  crew_size              int not null default 2 check (crew_size between 1 and 50),
  est_hours              numeric(8,2) check (est_hours is null or est_hours >= 0),
  install_days           int not null default 1 check (install_days between 1 and 120),
  scope                  text check (scope is null or char_length(scope) <= 8000),
  brief                  text check (brief is null or char_length(brief) <= 8000),
  customer_notes         text check (customer_notes is null or char_length(customer_notes) <= 4000),
  site_photo_ids         uuid[] not null default '{}',
  permit_required        boolean not null default false,
  contract_cents         bigint not null default 0 check (contract_cents >= 0),
  est_cost_cents         bigint not null default 0 check (est_cost_cents >= 0),
  install_work_order_id  uuid,
  sov_version_id         uuid,
  contract_note          text,
  sold_by_employee_id    uuid references core.employees(id),
  closed_at              timestamptz,
  cancel_reason          text,
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) deferrable initially immediate,
  foreign key (org_id, sov_version_id) references pm.sov_versions (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_install_est_uidx on pm.fs_install_projects (org_id, estimate_id) where estimate_id is not null and stage <> 'CANCELLED';
create index if not exists pm_fs_install_board_idx on pm.fs_install_projects (org_id, location_id, stage);

create table if not exists pm.fs_install_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  project_id          uuid not null,
  sort                int not null default 0,
  kind                text not null default 'EQUIPMENT' check (kind in ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT')),
  description         text not null check (char_length(description) between 1 and 300),
  qty                 numeric(14,4) not null default 1 check (qty > 0),
  unit_price_cents    bigint not null default 0,
  unit_cost_cents     bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  price_book_item_id  uuid,
  option_item_id      uuid,
  commitment_line_id  uuid,
  received_qty        numeric(14,4) not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, project_id) references pm.fs_install_projects (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_install_items_proj_idx on pm.fs_install_items (org_id, project_id, sort);

create table if not exists pm.fs_po_details (
  commitment_id          uuid primary key,
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  job_id                 uuid not null,
  project_id             uuid,
  fulfillment            text not null default 'DELIVERY' check (fulfillment in ('WILL_CALL','DELIVERY')),
  expected_on            date,
  pickup_code            text check (pickup_code is null or pickup_code ~ '^[0-9]{6}$'),
  supply_house_note      text check (supply_house_note is null or char_length(supply_house_note) <= 500),
  to_stock_location_id   uuid,
  picked_up_at           timestamptz,
  picked_up_by           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, project_id) references pm.fs_install_projects (org_id, id) on delete set null deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.fs_serial_units (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  project_id          uuid,
  commitment_line_id  uuid,
  install_item_id     uuid,
  serial              text not null check (char_length(btrim(serial)) between 1 and 80),
  make                text,
  model               text,
  status              text not null default 'RECEIVED' check (status in ('RECEIVED','ON_TRUCK','INSTALLED','RETURNED')),
  stock_location_id   uuid,
  asset_id            uuid,
  received_at         timestamptz not null default now(),
  installed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_serial_uidx on pm.fs_serial_units (org_id, lower(btrim(serial)), coalesce(lower(model), ''));

create table if not exists pm.fs_permit_templates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  jurisdiction    text not null check (char_length(jurisdiction) between 1 and 200),
  permit_kind     text not null default 'MECHANICAL' check (permit_kind in ('BUILDING','ELECTRICAL','PLUMBING','MECHANICAL','OTHER')),
  inspections     text[] not null default '{FINAL}',
  fee_cents       bigint check (fee_cents is null or fee_cents >= 0),
  lead_days       int not null default 5 check (lead_days between 0 and 180),
  is_default      boolean not null default false,
  notes           text check (notes is null or char_length(notes) <= 2000),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id)
);

create table if not exists pm.fs_install_capacity (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  week_start   date,
  crew_days    int not null check (crew_days between 0 and 1000),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  check (week_start is null or extract(isodow from week_start) = 1)
);
create unique index if not exists pm_fs_install_cap_uidx on pm.fs_install_capacity (org_id, location_id, coalesce(week_start, '1900-01-01'::date));

create table if not exists pm.fs_install_crew_days (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null,
  project_id           uuid not null,
  work_date            date not null,
  crew_id              uuid,
  lead_employee_id     uuid references core.employees(id),
  helper_employee_ids  uuid[] not null default '{}',
  hours                numeric(5,2) not null default 8 check (hours > 0 and hours <= 24),
  status               text not null default 'PLANNED' check (status in ('PLANNED','DONE','CANCELLED')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, project_id) references pm.fs_install_projects (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_fs_crew_days_uidx on pm.fs_install_crew_days (org_id, project_id, work_date) where status <> 'CANCELLED';
create index if not exists pm_fs_crew_days_loc_idx on pm.fs_install_crew_days (org_id, location_id, work_date) where status <> 'CANCELLED';

-- FS-95 ---------------------------------------------------------------------
create table if not exists pm.fs_tax_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  state        text not null check (state ~ '^[A-Z]{2}$'),
  line_kind    text not null check (line_kind in ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT','SUBLET','FREIGHT')),
  taxable      boolean not null,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, state, line_kind),
  unique (org_id, id)
);

create table if not exists pm.fs_tax_snapshots (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  job_id         uuid not null,
  subject_type   text not null check (subject_type in ('FS_ESTIMATE','INVOICE_REVIEW')),
  subject_id     uuid not null,
  rate_pct       numeric(7,4) not null default 0,
  jurisdiction   text,
  rate_id        uuid,
  state          text,
  lines          jsonb not null default '[]' check (jsonb_typeof(lines) = 'array'),
  tax_cents      bigint not null default 0,
  computed_at    timestamptz not null default now(),
  unique (org_id, subject_type, subject_id),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- FS-94 ---------------------------------------------------------------------
create table if not exists pm.fs_invoice_reviews (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  work_order_id       uuid not null,
  customer_id         uuid references core.customers(id),
  status              text not null default 'PENDING' check (status in ('PENDING','FLAGGED','APPROVED','RETURNED','VOID')),
  flags               jsonb not null default '[]' check (jsonb_typeof(flags) = 'array'),
  flag_count          int not null default 0,
  blocking_count      int not null default 0,
  subtotal_cents      bigint not null default 0,
  tax_cents           bigint not null default 0,
  total_cents         bigint not null default 0,
  tax_snapshot_id     uuid,
  billing_request_id  uuid,
  override_reason     text,
  return_reason       text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  refreshed_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, work_order_id),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_reviews_queue_idx on pm.fs_invoice_reviews (org_id, location_id, status);

-- FS-96 ---------------------------------------------------------------------
create table if not exists pm.fs_autopay_enrollments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  agreement_id       uuid not null,
  customer_id        uuid not null references core.customers(id),
  contact_id         uuid references core.contacts(id),
  method_label       text not null check (char_length(method_label) between 1 and 60),
  consent_text       text not null check (char_length(consent_text) between 10 and 1000),
  consented_by_name  text not null check (char_length(consented_by_name) between 2 and 120),
  consented_at       timestamptz not null default now(),
  status             text not null default 'REQUESTED' check (status in ('REQUESTED','ACTIVE','CANCELLED')),
  books_ref          text,
  cancelled_at       timestamptz,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_fs_autopay_live_uidx on pm.fs_autopay_enrollments (org_id, agreement_id) where status <> 'CANCELLED';

-- FS-97 ---------------------------------------------------------------------
create table if not exists pm.fs_financed_sales (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  job_id                 uuid not null,
  estimate_id            uuid not null,
  plan_id                uuid,
  provider               text not null,
  application_ref        text check (application_ref is null or char_length(application_ref) <= 80),
  amount_financed_cents  bigint not null check (amount_financed_cents >= 0),
  dealer_fee_pct         numeric(5,4) not null default 0,
  dealer_fee_cents       bigint not null default 0,
  expected_net_cents     bigint not null default 0,
  status                 text not null default 'APPLIED' check (status in ('APPLIED','APPROVED','DOCS_SIGNED','FUNDING_REQUESTED','FUNDED','SHORT_FUNDED','CANCELLED')),
  sold_on                date not null default current_date,
  approved_at            timestamptz,
  funding_requested_at   timestamptz,
  funded_cents           bigint check (funded_cents is null or funded_cents >= 0),
  funded_on              date,
  chase_after_days       int not null default 7 check (chase_after_days between 1 and 180),
  notes                  text check (notes is null or char_length(notes) <= 2000),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, estimate_id),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) deferrable initially immediate
);

-- FS-112 --------------------------------------------------------------------
create table if not exists pm.fs_integrity_findings (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  job_id           uuid,
  kind             text not null check (kind in ('COMPLETED_NOT_INVOICED','COST_NO_BILLING','PARTS_NOT_BILLED','MEMBER_DISCOUNT',
                                                 'CALLBACK_NO_CHARGEBACK','INSTALL_NOT_BILLED','REVIEW_STUCK')),
  subject_table    text not null,
  subject_id       uuid not null,
  detail           text not null check (char_length(detail) between 1 and 1000),
  amount_cents     bigint,
  status           text not null default 'OPEN' check (status in ('OPEN','TASKED','RESOLVED','DISMISSED')),
  task_id          uuid,
  dismissed_reason text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, kind, subject_id),
  unique (org_id, id)
);
create index if not exists pm_fs_findings_loc_idx on pm.fs_integrity_findings (org_id, location_id, status);

-- FS-117 --------------------------------------------------------------------
create table if not exists pm.fs_shadow_runs (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  run_day                  date not null,
  legacy_system            text not null default 'OTHER',
  legacy_jobs              int not null default 0,
  legacy_revenue_cents     bigint not null default 0,
  legacy_payments_cents    bigint not null default 0,
  legacy_memberships       int not null default 0,
  legacy_estimates_sold    int not null default 0,
  merit_jobs               int not null default 0,
  merit_revenue_cents      bigint not null default 0,
  merit_payments_cents     bigint not null default 0,
  merit_memberships        int not null default 0,
  merit_estimates_sold     int not null default 0,
  status                   text not null default 'VARIANCE' check (status in ('MATCH','VARIANCE')),
  notes                    text check (notes is null or char_length(notes) <= 2000),
  recorded_by              text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, location_id, run_day),
  unique (org_id, id)
);

-- touch / company triggers
do $$
declare t text;
begin
  foreach t in array array['fs_phone_providers','fs_call_log','fs_message_templates','fs_threads','fs_appointment_reminders',
    'fs_form_templates','fs_visit_notes','fs_followup_cadences','fs_estimate_followups','fs_opportunities','fs_install_projects',
    'fs_install_items','fs_po_details','fs_serial_units','fs_permit_templates','fs_install_capacity','fs_install_crew_days',
    'fs_tax_rules','fs_invoice_reviews','fs_autopay_enrollments','fs_financed_sales','fs_integrity_findings','fs_shadow_runs'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['fs_phone_providers','fs_call_log','fs_message_templates','fs_threads','fs_thread_messages','fs_form_templates',
    'fs_followup_cadences','fs_opportunities','fs_permit_templates','fs_install_capacity','fs_tax_rules','fs_autopay_enrollments',
    'fs_integrity_findings','fs_shadow_runs'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
  foreach t in array array['fs_appointment_reminders','fs_form_submissions','fs_visit_notes','fs_estimate_followups','fs_online_acceptances',
    'fs_install_projects','fs_install_items','fs_po_details','fs_serial_units','fs_install_crew_days','fs_tax_snapshots','fs_invoice_reviews',
    'fs_financed_sales'] loop
    execute format('create or replace trigger trg_job_location before insert or update of job_id, location_id on pm.%I for each row execute function pm.tg_job_location()', t);
  end loop;
end $$;

-- install project numbers: IP-YYYY-NNNNN per org
create or replace function pm.tg_fs_install_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.number is null then
    new.number := 'IP-' || to_char(current_date, 'YYYY') || '-' ||
      lpad(pm.next_doc_number(new.org_id, 'org', 'fs_install', to_char(current_date, 'YYYY'))::text, 5, '0');
  end if;
  return new;
end $$;
create or replace trigger trg_fs_install_number before insert on pm.fs_install_projects for each row execute function pm.tg_fs_install_number();

-- ----------------------------------------------------------------------------
-- 2. Telephony and call tracking (FS-05)
-- ----------------------------------------------------------------------------
-- The customer (and contact) a phone number belongs to, in one org.
create or replace function pm._fs_party_by_phone(p_org uuid, p_phone text, out customer_id uuid, out contact_id uuid)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v text := core.party_norm_phone(p_phone);
begin
  if v is null or length(v) < 7 then return; end if;
  select ct.customer_id, ct.id into customer_id, contact_id
    from core.contacts ct
   where ct.org_id = p_org and ct.customer_id is not null and ct.identity_status = 'active' and core.party_norm_phone(ct.phone) = v
   order by ct.is_primary desc, ct.created_at
   limit 1;
  if customer_id is null then
    select c.id into customer_id from core.customers c where c.org_id = p_org and core.party_norm_phone(c.phone) = v order by c.created_at limit 1;
  end if;
end $$;

-- Office: switch a provider on or off for a company (security review H1). Nothing the caller says
-- turns it on: activation needs at least one VERIFIED number for this company and provider in the
-- platform registry (pm.fs_voice_numbers — the platform verified the provider account), and every main
-- number listed must be one of those. The app's credential check is a second, UI-only gate.
drop function if exists pm.fs_set_phone_provider(uuid, text, boolean, boolean, text[], text, boolean, text);
create or replace function pm.fs_set_phone_provider(
  p_location uuid, p_provider text, p_active boolean,
  p_main_numbers text[] default null, p_label text default null, p_record_calls boolean default null, p_disclosure text default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); r pm.fs_phone_providers%rowtype; v_nums text[]; v_bad text;
begin
  if p_provider not in ('RINGCENTRAL','DIALPAD','TWILIO_VOICE') then raise exception 'PM_INVALID: unknown phone provider' using errcode = '22023'; end if;
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: company not in the caller''s organization' using errcode = '42501';
  end if;
  if coalesce(p_active, false) and not exists (select 1 from pm.fs_voice_numbers n where n.org_id = v_org and n.location_id = p_location
                                                  and n.provider = p_provider and n.verified_at is not null) then
    raise exception 'PM_FS_PROVIDER_CREDENTIALS: % is not connected yet — Merit support connects the account and verifies its numbers first', initcap(replace(lower(p_provider), '_', ' '))
      using errcode = '55000';
  end if;
  select coalesce(array_agg(distinct pm._fs_e164(x)) filter (where pm._fs_e164(x) is not null), '{}') into v_nums from unnest(coalesce(p_main_numbers, '{}')) x;
  select x into v_bad from unnest(v_nums) x
   where not exists (select 1 from pm.fs_voice_numbers n where n.phone = x and n.org_id = v_org and n.location_id = p_location
                       and n.provider = p_provider and n.verified_at is not null) limit 1;
  if v_bad is not null then
    raise exception 'PM_FS_NUMBER_NOT_REGISTERED: % is not a verified % number for this company', v_bad, initcap(replace(lower(p_provider), '_', ' ')) using errcode = '22023';
  end if;
  insert into pm.fs_phone_providers as t (org_id, location_id, provider, status, account_label, main_numbers, record_calls, recording_disclosure,
                                          activated_at, activated_by)
  values (v_org, p_location, p_provider, case when p_active then 'ACTIVE' else 'DISABLED' end, left(p_label, 120), v_nums,
          coalesce(p_record_calls, true), left(p_disclosure, 500), case when p_active then now() end, case when p_active then pm.current_user_id() end)
  on conflict (org_id, location_id, provider) do update set
    status = excluded.status,
    account_label = coalesce(excluded.account_label, t.account_label),
    main_numbers = case when p_main_numbers is null then t.main_numbers else excluded.main_numbers end,
    record_calls = coalesce(p_record_calls, t.record_calls),
    recording_disclosure = coalesce(excluded.recording_disclosure, t.recording_disclosure),
    activated_at = case when excluded.status = 'ACTIVE' then coalesce(t.activated_at, now()) else t.activated_at end,
    activated_by = case when excluded.status = 'ACTIVE' then coalesce(t.activated_by, pm.current_user_id()) else t.activated_by end
  returning * into r;
  return to_jsonb(r);
end $$;

-- A campaign's tracking number must be a verified registry number of the same company (H1). Covers
-- every write path (RLS table writes and RPCs).
create or replace function pm.tg_fs_campaign_tracking_phone() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v text;
begin
  if new.tracking_phone is null or btrim(new.tracking_phone) = '' then new.tracking_phone := null; return new; end if;
  if tg_op = 'UPDATE' and new.tracking_phone is not distinct from old.tracking_phone and new.org_id = old.org_id and new.location_id = old.location_id then
    return new;
  end if;
  v := pm._fs_e164(new.tracking_phone);
  if v is null or not exists (select 1 from pm.fs_voice_numbers n where n.phone = v and n.org_id = new.org_id and n.location_id = new.location_id
                                and n.verified_at is not null) then
    raise exception 'PM_FS_NUMBER_NOT_REGISTERED: % is not a verified tracking number for this company', new.tracking_phone using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_fs_campaign_tracking_phone on pm.campaigns;
create trigger trg_fs_campaign_tracking_phone before insert or update of tracking_phone, org_id, location_id on pm.campaigns
  for each row execute function pm.tg_fs_campaign_tracking_phone();

-- Provider webhook ingest (normalized by apps/projects lib/fieldservice/telephony.ts). Anon-executable,
-- fail closed on the server key; idempotent per provider call id (later events update the same row).
create or replace function public.fs_voice_event(p_server_key text, p_provider text, p_event jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  v_call text := left(nullif(btrim(p_event ->> 'call_id'), ''), 120); v_dir text := upper(coalesce(p_event ->> 'direction', 'INBOUND'));
  v_from text := pm._fs_e164(p_event ->> 'from'); v_to text := pm._fs_e164(p_event ->> 'to'); v_ours text; v_theirs text;
  v_org uuid; v_loc uuid; v_campaign uuid; v_party record; v_id uuid; v_outcome text := upper(coalesce(p_event ->> 'outcome', 'IN_PROGRESS'));
  v_started timestamptz; v_sc uuid; v_n int; v_at timestamptz;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  if p_provider not in ('RINGCENTRAL','DIALPAD','TWILIO_VOICE') then raise exception 'FS_VOICE_INVALID: unknown provider' using errcode = '22023'; end if;
  if v_call is null then raise exception 'FS_VOICE_INVALID: the event has no call id' using errcode = '22023'; end if;
  if v_dir not in ('INBOUND','OUTBOUND') then v_dir := 'INBOUND'; end if;
  if v_outcome not in ('IN_PROGRESS','ANSWERED','MISSED','VOICEMAIL','ABANDONED','BUSY','FAILED') then v_outcome := 'IN_PROGRESS'; end if;
  v_ours := case when v_dir = 'INBOUND' then v_to else v_from end;
  v_theirs := case when v_dir = 'INBOUND' then v_from else v_to end;
  if v_ours is null then
    insert into pm.fs_voice_event_log (provider, provider_call_id, number, reason) values (p_provider, v_call, null, 'no company number on the event');
    return jsonb_build_object('status', 'ignored', 'reason', 'no company number on the event');
  end if;
  -- The company comes ONLY from the platform registry of verified numbers (H1); a number on more
  -- than one row (cannot happen with the primary key, checked anyway) is ignored, never guessed.
  select count(*) into v_n from pm.fs_voice_numbers n where n.phone = v_ours and n.provider = p_provider and n.verified_at is not null;
  if v_n <> 1 then
    insert into pm.fs_voice_event_log (provider, provider_call_id, number, reason)
    values (p_provider, v_call, v_ours, case when v_n = 0 then 'number not registered for this provider' else 'number registered more than once' end);
    return jsonb_build_object('status', 'ignored', 'reason', case when v_n = 0 then 'number not set up for any company' else 'number is ambiguous' end);
  end if;
  select n.org_id, n.location_id into v_org, v_loc from pm.fs_voice_numbers n where n.phone = v_ours and n.provider = p_provider and n.verified_at is not null;
  if not exists (select 1 from pm.fs_phone_providers p where p.org_id = v_org and p.location_id = v_loc and p.provider = p_provider and p.status = 'ACTIVE') then
    insert into pm.fs_voice_event_log (org_id, location_id, provider, provider_call_id, number, reason)
    values (v_org, v_loc, p_provider, v_call, v_ours, 'provider not switched on for this company');
    return jsonb_build_object('status', 'ignored', 'reason', 'the phone provider is not switched on for this company');
  end if;
  -- the campaign: the one active campaign of THIS company with that tracking number (two → none, logged)
  select count(*), min(c.id::text)::uuid into v_n, v_campaign from pm.campaigns c
   where c.org_id = v_org and c.location_id = v_loc and c.is_active and pm._fs_e164(c.tracking_phone) = v_ours;
  if v_n > 1 then
    v_campaign := null;
    insert into pm.fs_voice_event_log (org_id, location_id, provider, provider_call_id, number, reason)
    values (v_org, v_loc, p_provider, v_call, v_ours, 'tracking number on more than one active campaign');
  end if;
  -- event time for ordering (L3): later provider events must not be overwritten by a late retry
  v_at := coalesce(nullif(p_event ->> 'event_at', '')::timestamptz, now());
  select * into v_party from pm._fs_party_by_phone(v_org, v_theirs);
  v_started := coalesce(nullif(p_event ->> 'started_at', '')::timestamptz, now());
  insert into pm.fs_call_log as t (org_id, location_id, provider, provider_call_id, direction, from_number, to_number, tracking_number, campaign_id,
                                   customer_id, contact_id, started_at, answered_at, ended_at, duration_seconds, outcome, agent_name,
                                   recording_ref, recording_seconds, last_event_at)
  values (v_org, v_loc, p_provider, v_call, v_dir, v_from, v_to, case when v_campaign is not null then v_ours end, v_campaign,
          v_party.customer_id, v_party.contact_id, v_started, nullif(p_event ->> 'answered_at', '')::timestamptz,
          nullif(p_event ->> 'ended_at', '')::timestamptz, nullif(p_event ->> 'duration_seconds', '')::int, v_outcome,
          left(nullif(p_event ->> 'agent_name', ''), 120), left(nullif(p_event ->> 'recording_ref', ''), 500),
          nullif(p_event ->> 'recording_seconds', '')::int, v_at)
  on conflict (org_id, provider, provider_call_id) do update set
    answered_at = coalesce(t.answered_at, excluded.answered_at),
    ended_at = coalesce(t.ended_at, excluded.ended_at),
    duration_seconds = case when excluded.last_event_at >= coalesce(t.last_event_at, '-infinity') then coalesce(excluded.duration_seconds, t.duration_seconds)
                            else coalesce(t.duration_seconds, excluded.duration_seconds) end,
    outcome = case when excluded.outcome = 'IN_PROGRESS' or excluded.last_event_at < coalesce(t.last_event_at, '-infinity') then t.outcome
                   else excluded.outcome end,
    last_event_at = greatest(coalesce(t.last_event_at, '-infinity'), excluded.last_event_at),
    agent_name = coalesce(excluded.agent_name, t.agent_name),
    recording_ref = coalesce(excluded.recording_ref, t.recording_ref),
    recording_seconds = coalesce(excluded.recording_seconds, t.recording_seconds)
  returning t.id into v_id;
  -- link to the call the CSR logged / booked from this number within the call's window
  select sc.id into v_sc from pm.service_calls sc
   where sc.org_id = v_org and sc.location_id = v_loc and v_theirs is not null and pm._fs_e164(sc.caller_phone) = v_theirs
     and sc.created_at between v_started - interval '10 minutes' and v_started + interval '2 hours'
     and not exists (select 1 from pm.fs_call_log l where l.org_id = v_org and l.service_call_id = sc.id and l.id <> v_id)
   order by sc.created_at limit 1;
  if v_sc is not null then
    update pm.fs_call_log l set service_call_id = coalesce(l.service_call_id, v_sc),
           job_id = coalesce(l.job_id, (select s.job_id from pm.service_calls s where s.id = v_sc)),
           work_order_id = coalesce(l.work_order_id, (select s.work_order_id from pm.service_calls s where s.id = v_sc))
     where l.id = v_id;
  end if;
  return jsonb_build_object('status', 'recorded', 'id', v_id, 'location_id', v_loc, 'campaign_id', v_campaign, 'customer_id', v_party.customer_id);
end $$;

-- The CSR links a recorded call to the call they logged or the visit it booked.
create or replace function pm.fs_link_call(p_call uuid, p_service_call uuid default null, p_work_order uuid default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.fs_call_log%rowtype; v_job uuid; v_wo uuid := p_work_order;
begin
  select * into l from pm.fs_call_log x where x.id = p_call and x.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: call not found in the caller''s organization' using errcode = '42501'; end if;
  if p_service_call is not null then
    select s.job_id, coalesce(v_wo, s.work_order_id) into v_job, v_wo from pm.service_calls s
     where s.id = p_service_call and s.org_id = l.org_id and s.location_id = l.location_id;
    if not found then raise exception 'PM_INVALID: that call record is not at this company' using errcode = '22023'; end if;
  end if;
  if v_wo is not null then
    select w.job_id into v_job from pm.work_orders w where w.id = v_wo and w.org_id = l.org_id and w.location_id = l.location_id;
    if not found then raise exception 'PM_INVALID: that visit is not at this company' using errcode = '22023'; end if;
  end if;
  update pm.fs_call_log set service_call_id = coalesce(p_service_call, service_call_id), work_order_id = coalesce(v_wo, work_order_id),
         job_id = coalesce(v_job, job_id), linked_by = pm.current_user_id(), linked_at = now()
   where id = l.id;
  return l.id;
end $$;

-- Calls by campaign: answered, missed, booked, booked rate (FS-05 / FS-106).
create or replace function pm.fs_call_report(p_location uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(x order by x.calls desc) from (
      select l.campaign_id, coalesce(c.name, 'No tracking number') as campaign, count(*)::int as calls,
             count(*) filter (where l.outcome = 'ANSWERED')::int as answered,
             count(*) filter (where l.outcome in ('MISSED','ABANDONED','VOICEMAIL','BUSY'))::int as missed,
             count(*) filter (where l.work_order_id is not null or s.status = 'BOOKED')::int as booked,
             case when count(*) filter (where l.outcome = 'ANSWERED') > 0
                  then round(count(*) filter (where l.work_order_id is not null or s.status = 'BOOKED')::numeric
                             / count(*) filter (where l.outcome = 'ANSWERED'), 4) end as booked_rate,
             coalesce(sum(l.duration_seconds), 0)::int as talk_seconds
        from pm.fs_call_log l
        left join pm.campaigns c on c.org_id = l.org_id and c.id = l.campaign_id
        left join pm.service_calls s on s.org_id = l.org_id and s.id = l.service_call_id
       where l.org_id = v_org and l.location_id = p_location and l.direction = 'INBOUND'
         and l.started_at >= coalesce(p_from, current_date - 30)::timestamptz and l.started_at < (coalesce(p_to, current_date) + 1)::timestamptz
       group by l.campaign_id, c.name) x), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- 3. Two-way customer messaging (FS-12)
-- ----------------------------------------------------------------------------
create or replace function pm._fs_thread_for(p_org uuid, p_location uuid, p_customer uuid, p_job uuid, p_contact uuid, p_wo uuid,
                                             p_unknown text default null) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_id uuid;
begin
  select t.id into v_id from pm.fs_threads t
   where t.org_id = p_org and t.status = 'OPEN' and t.customer_id is not distinct from p_customer and t.job_id is not distinct from p_job
     and coalesce(t.unknown_from, '') = coalesce(case when p_customer is null then p_unknown end, '')
   limit 1;
  if v_id is not null then
    if p_contact is not null or p_wo is not null then
      update pm.fs_threads set contact_id = coalesce(p_contact, contact_id), work_order_id = coalesce(p_wo, work_order_id) where id = v_id;
    end if;
    return v_id;
  end if;
  insert into pm.fs_threads (org_id, location_id, customer_id, unknown_from, contact_id, job_id, work_order_id, subject)
  values (p_org, p_location, p_customer, case when p_customer is null then p_unknown end, p_contact, p_job, p_wo,
          case when p_job is not null then (select left(coalesce(j.name, j.job_number), 200) from core.jobs j where j.id = p_job) end)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select t.id into v_id from pm.fs_threads t
     where t.org_id = p_org and t.status = 'OPEN' and t.customer_id is not distinct from p_customer and t.job_id is not distinct from p_job
       and coalesce(t.unknown_from, '') = coalesce(case when p_customer is null then p_unknown end, '')
     limit 1;
  end if;
  return v_id;
end $$;

-- Template values every message can use.
create or replace function pm._fs_msg_vals(p_org uuid, p_location uuid, p_contact uuid, p_wo uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v jsonb := '{}'::jsonb; w record; s pm.fs_settings%rowtype; v_start timestamptz; v_tz text;
begin
  select * into s from pm.fs_settings x where x.org_id = p_org and x.location_id = p_location;
  v_tz := coalesce(s.time_zone, 'America/Chicago');
  v := v || jsonb_build_object('company', coalesce((select l.name from core.locations l where l.id = p_location), 'us'));
  v := v || jsonb_build_object('first_name', coalesce((select nullif(btrim(c.first_name), '') from core.contacts c where c.id = p_contact), 'there'));
  if p_wo is not null then
    select x.number, x.requested_start, x.scheduled_start, aw.label as window_label into w
      from pm.work_orders x left join pm.arrival_windows aw on aw.org_id = x.org_id and aw.id = x.arrival_window_id
     where x.id = p_wo and x.org_id = p_org;
    v_start := coalesce(w.requested_start, w.scheduled_start);
    v := v || jsonb_build_object('visit', coalesce(w.number, ''),
                                 'day', case when v_start is not null then trim(to_char(v_start at time zone v_tz, 'Dy Mon FMDD')) else 'soon' end,
                                 'window', coalesce(w.window_label, case when v_start is not null then trim(to_char(v_start at time zone v_tz, 'FMHH12:MI am')) else '' end));
  end if;
  return v;
end $$;

-- Send a text or email to a customer from the thread (CSR, dispatcher, the tech on the visit).
create or replace function pm.fs_send_message(
  p_location uuid, p_customer uuid, p_job uuid, p_channel text, p_body text, p_contact uuid default null,
  p_template text default null, p_work_order uuid default null, p_vals jsonb default null, p_command uuid default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id(); v_seen jsonb; v_contact uuid := p_contact; v_body text := p_body; v_subject text; t pm.fs_message_templates%rowtype;
  v_thread uuid; v_out uuid; o record; v_status text; v_msg uuid; v_ch text := upper(coalesce(p_channel, 'SMS')); v_name text; v_job uuid := p_job;
begin
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(v_org, p_command, 'fs.message.send');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  if v_ch not in ('SMS','EMAIL') then raise exception 'PM_INVALID: send by SMS or EMAIL' using errcode = '22023'; end if;
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then raise exception 'PM_INVALID: company not found' using errcode = '22023'; end if;
  if not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org) then raise exception 'PM_INVALID: customer not found' using errcode = '22023'; end if;
  if p_work_order is not null then
    select w.job_id into v_job from pm.work_orders w where w.id = p_work_order and w.org_id = v_org and w.location_id = p_location;
    if v_job is null then raise exception 'PM_INVALID: that visit is not at this company' using errcode = '22023'; end if;
  end if;
  if v_job is not null and not exists (select 1 from core.jobs j where j.id = v_job and j.org_id = v_org and j.location_id = p_location
                                         and (j.customer_id is null or j.customer_id = p_customer)) then
    raise exception 'PM_INVALID: that job is not this customer''s job at this company' using errcode = '22023';
  end if;
  if v_contact is null then
    select ct.id into v_contact from core.contacts ct
     where ct.org_id = v_org and ct.customer_id = p_customer and ct.identity_status = 'active'
       and (case when v_ch = 'SMS' then nullif(btrim(ct.phone), '') else nullif(btrim(ct.email), '') end) is not null
     order by ct.is_primary desc, (case when v_ch = 'SMS' then ct.sms_consent else ct.email_consent end) desc, ct.created_at limit 1;
  elsif not exists (select 1 from core.contacts ct where ct.id = v_contact and ct.org_id = v_org and ct.customer_id = p_customer) then
    raise exception 'PM_INVALID: that contact is not on this customer' using errcode = '22023';
  end if;
  if v_contact is null then raise exception 'PM_FS_NO_CONTACT: this customer has no % on file', case when v_ch = 'SMS' then 'mobile number' else 'email address' end using errcode = '22023'; end if;
  if p_template is not null then
    select * into t from pm.fs_message_templates x where x.org_id = v_org and x.location_id = p_location and x.key = p_template and x.is_active;
    if t.id is null then raise exception 'PM_INVALID: unknown message template %', p_template using errcode = '22023'; end if;
    v_body := pm._fs_fill(t.body, pm._fs_msg_vals(v_org, p_location, v_contact, p_work_order) || coalesce(p_vals, '{}'::jsonb));
    v_subject := t.subject;
  else
    v_body := pm._fs_fill(v_body, pm._fs_msg_vals(v_org, p_location, v_contact, p_work_order) || coalesce(p_vals, '{}'::jsonb));
  end if;
  if v_body is null or length(btrim(v_body)) = 0 then raise exception 'PM_INVALID: the message is empty' using errcode = '22023'; end if;
  v_out := core.notify_customer(v_org, p_location, v_job, 'customer.message', lower(v_ch), v_contact, coalesce(v_subject, 'Message'),
                                v_body, null, 'fsmsg:' || coalesce(p_command::text, gen_random_uuid()::text), pm.current_user_id());
  select m.status, m.status_reason, m.to_address into o from core.outbound_messages m where m.id = v_out;
  v_status := case o.status when 'queued' then 'QUEUED' when 'held' then 'HELD' when 'suppressed' then 'SUPPRESSED' when 'skipped' then 'SKIPPED'
                            when 'sent' then 'SENT' when 'failed' then 'FAILED' else 'QUEUED' end;
  v_thread := pm._fs_thread_for(v_org, p_location, p_customer, v_job, v_contact, p_work_order);
  select coalesce(nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), 'Office') into v_name
    from core.employees e where e.org_id = v_org and e.clerk_user_id = pm.current_user_id() limit 1;
  insert into pm.fs_thread_messages (org_id, location_id, thread_id, job_id, direction, channel, body, to_address, contact_id, outbound_id,
                                     status, status_reason, template_key, author_user_id, author_name)
  values (v_org, p_location, v_thread, v_job, 'OUT', v_ch, left(v_body, 4000), o.to_address, v_contact, v_out, v_status, o.status_reason,
          p_template, pm.current_user_id(), coalesce(v_name, 'Office'))
  returning id into v_msg;
  update pm.fs_threads set last_message_at = now(), last_direction = 'OUT', unread_count = 0 where id = v_thread;
  return pm._fs_cmd_done(v_org, p_command, 'fs.message.send', v_msg,
    jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'status', v_status, 'reason', o.status_reason));
end $$;

-- An internal note on a thread (never sent).
create or replace function pm.fs_add_thread_note(p_thread uuid, p_body text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.fs_threads%rowtype; v_id uuid;
begin
  select * into t from pm.fs_threads x where x.id = p_thread and x.org_id = public.get_org_id();
  if t.id is null then raise exception 'PM_FORBIDDEN: thread not found' using errcode = '42501'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'PM_INVALID: the note is empty' using errcode = '22023'; end if;
  insert into pm.fs_thread_messages (org_id, location_id, thread_id, job_id, direction, channel, body, status, author_user_id, author_name)
  values (t.org_id, t.location_id, t.id, t.job_id, 'NOTE', 'NOTE', left(btrim(p_body), 4000), 'NOTE', pm.current_user_id(), 'Office')
  returning id into v_id;
  update pm.fs_threads set last_message_at = now(), last_direction = 'NOTE' where id = t.id;
  return v_id;
end $$;

-- Mark read / close / reopen.
create or replace function pm.fs_mark_thread(p_thread uuid, p_action text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.fs_threads%rowtype;
begin
  select * into t from pm.fs_threads x where x.id = p_thread and x.org_id = public.get_org_id() for update;
  if t.id is null then raise exception 'PM_FORBIDDEN: thread not found' using errcode = '42501'; end if;
  case upper(coalesce(p_action, ''))
    when 'READ' then update pm.fs_threads set unread_count = 0 where id = t.id;
    when 'CLOSE' then update pm.fs_threads set status = 'CLOSED', unread_count = 0 where id = t.id;
    when 'REOPEN' then
      if exists (select 1 from pm.fs_threads x where x.org_id = t.org_id and x.status = 'OPEN' and x.id <> t.id
                   and x.customer_id is not distinct from t.customer_id and x.job_id is not distinct from t.job_id
                   and coalesce(x.unknown_from, '') = coalesce(t.unknown_from, '')) then
        raise exception 'PM_INVALID: this customer already has an open thread for that job' using errcode = '22023';
      end if;
      update pm.fs_threads set status = 'OPEN' where id = t.id;
    else raise exception 'PM_INVALID: READ, CLOSE or REOPEN' using errcode = '22023';
  end case;
  return t.id;
end $$;

-- Route one inbound text to its thread; apply a reply to the reminder that asked for it.
create or replace function pm._fs_route_inbound(p_org uuid, p_location uuid, p_from text, p_body text, p_sid text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  v_from text := pm._fs_e164(p_from); v_party record; v_wo pm.work_orders%rowtype; v_loc uuid := p_location; v_thread uuid; v_msg uuid;
  v_intent text := pm._fs_reply_intent(p_body); rem pm.fs_appointment_reminders%rowtype; v_reply text; v_tpl text; v_job uuid;
begin
  if p_sid is not null then
    select m.id, m.thread_id, m.intent into rem.id, rem.work_order_id, rem.reply_intent from pm.fs_thread_messages m where m.org_id = p_org and m.provider_sid = p_sid;
    if rem.id is not null then return jsonb_build_object('thread_id', rem.work_order_id, 'message_id', rem.id, 'intent', rem.reply_intent, 'duplicate', true); end if;
    rem := null;
  end if;
  select * into v_party from pm._fs_party_by_phone(p_org, v_from);
  -- a reminder waiting for this number's reply wins; else the customer's next open visit
  select r.* into rem from pm.fs_appointment_reminders r
   where r.org_id = p_org and r.awaiting_reply and r.phone = v_from and r.visit_start > now() - interval '12 hours'
   order by r.updated_at desc limit 1;
  if rem.id is not null then
    select * into v_wo from pm.work_orders w where w.org_id = p_org and w.id = rem.work_order_id;
  elsif v_party.customer_id is not null then
    select w.* into v_wo from pm.work_orders w join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
     where w.org_id = p_org and j.customer_id = v_party.customer_id and w.status in ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD')
     order by coalesce(w.requested_start, w.scheduled_start, w.created_at) limit 1;
  end if;
  v_job := v_wo.job_id;
  v_loc := coalesce(v_wo.location_id, v_loc,
                    (select j.location_id from core.jobs j where j.org_id = p_org and j.customer_id = v_party.customer_id order by j.created_at desc limit 1),
                    (select s.location_id from pm.fs_settings s where s.org_id = p_org order by s.created_at limit 1),
                    (select l.id from core.locations l where l.org_id = p_org order by l.created_at limit 1));
  v_thread := pm._fs_thread_for(p_org, v_loc, v_party.customer_id, v_job, v_party.contact_id, v_wo.id, v_from);
  insert into pm.fs_thread_messages (org_id, location_id, thread_id, job_id, direction, channel, body, from_address, contact_id, provider_sid,
                                     status, intent)
  values (p_org, v_loc, v_thread, v_job, 'IN', 'SMS', left(coalesce(nullif(btrim(p_body), ''), '(empty)'), 4000), v_from, v_party.contact_id,
          left(p_sid, 120), 'RECEIVED', v_intent)
  returning id into v_msg;
  update pm.fs_threads set last_message_at = now(), last_direction = 'IN', unread_count = unread_count + 1, status = 'OPEN' where id = v_thread;

  if rem.id is not null and v_intent in ('CONFIRM','RESCHEDULE','CANCEL') then
    update pm.fs_appointment_reminders set reply_intent = v_intent, replied_at = now(), awaiting_reply = false
     where org_id = p_org and work_order_id = rem.work_order_id and awaiting_reply;
    update pm.work_orders set customer_confirmation = case v_intent when 'CONFIRM' then 'CONFIRMED' when 'RESCHEDULE' then 'RESCHEDULE_REQUESTED' else 'CANCEL_REQUESTED' end,
           customer_confirmed_at = now()
     where org_id = p_org and id = rem.work_order_id;
    v_tpl := case v_intent when 'CONFIRM' then 'CONFIRM_ACK' else 'RESCHEDULE_ACK' end;
    select pm._fs_fill(t.body, pm._fs_msg_vals(p_org, v_loc, v_party.contact_id, rem.work_order_id)) into v_reply
      from pm.fs_message_templates t where t.org_id = p_org and t.location_id = v_loc and t.kind = v_tpl and t.is_active order by t.created_at limit 1;
    v_reply := coalesce(v_reply, case v_intent
      when 'CONFIRM' then pm._fs_fill('Thanks, you''re confirmed for {day}, {window}. See you then.', pm._fs_msg_vals(p_org, v_loc, v_party.contact_id, rem.work_order_id))
      when 'RESCHEDULE' then 'Got it. Our office will text you shortly to find a new time.'
      else 'Got it. Our office will reach out to confirm the cancellation.' end);
    perform pm.log_activity(p_org, v_loc, v_wo.job_id, 'work_order.customer_' || lower(v_intent), 'work_orders', rem.work_order_id,
      format('%s: the customer replied %s', v_wo.number, lower(v_intent)), jsonb_build_object('reminder_id', rem.id));
  end if;
  if v_job is not null then
    perform portal._notify_team(p_org, v_job, left(format('Customer text: %s', coalesce(p_body, '')), 200),
                                format('/calls/messages?thread=%s', v_thread), format('fs_in:%s', v_msg));
  end if;
  return jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'intent', v_intent, 'reply', v_reply,
                            'work_order_id', v_wo.id, 'customer_id', v_party.customer_id);
end $$;

-- Twilio inbound text (server-key route): STOP / START / HELP through 1114, then the thread.
create or replace function public.fs_inbound_sms(p_server_key text, p_from text, p_to text, p_body text, p_sid text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_kw jsonb; v_to text := pm._fs_e164(p_to); v_org uuid; v_loc uuid; v_route jsonb; v_reply text;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  v_kw := core.notify_inbound_sms(p_from, p_to, p_body);
  -- the company only from the verified sender registry (1114); a number verified for more than one
  -- company is ambiguous and is not routed (security review H1, same rule as voice)
  if (select count(*) from core.sms_sender_numbers s where s.phone = v_to and s.status = 'verified') = 1 then
    select s.org_id, s.location_id into v_org, v_loc from core.sms_sender_numbers s where s.phone = v_to and s.status = 'verified';
  end if;
  if v_org is null then return jsonb_build_object('action', coalesce(v_kw ->> 'action', 'ignored'), 'reply', v_kw ->> 'reply', 'routed', false); end if;
  v_route := pm._fs_route_inbound(v_org, v_loc, p_from, p_body, p_sid);
  v_reply := case when v_route ->> 'reply' is not null and v_route ->> 'intent' = 'CONFIRM' then v_route ->> 'reply'
                  when coalesce(v_kw ->> 'action', 'message') <> 'message' then v_kw ->> 'reply'
                  else v_route ->> 'reply' end;
  return jsonb_build_object('action', coalesce(v_kw ->> 'action', 'message'), 'reply', v_reply, 'routed', true,
                            'thread_id', v_route ->> 'thread_id', 'intent', v_route ->> 'intent');
end $$;

-- ----------------------------------------------------------------------------
-- 4. Confirmations and reminders 24 h / 2 h (FS-22) + the outbox bridge
-- ----------------------------------------------------------------------------
create or replace function pm._fs_plan_reminders(p_org uuid, p_location uuid, p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare w record; r pm.fs_appointment_reminders%rowtype; v_body text; v_msg uuid; m record; n int := 0; v_tpl text;
begin
  -- visits that moved or ended: their scheduled reminders no longer apply
  update pm.fs_appointment_reminders ar set status = 'CANCELLED', awaiting_reply = false
    from pm.work_orders wo
   where ar.org_id = p_org and ar.location_id = p_location and ar.status = 'SCHEDULED' and wo.org_id = ar.org_id and wo.id = ar.work_order_id
     and (wo.status in ('CANCELLED','COMPLETE','CLOSED') or coalesce(wo.requested_start, wo.scheduled_start) is distinct from ar.visit_start);
  for w in
    select wo.id, wo.job_id, coalesce(wo.requested_start, wo.scheduled_start) as start_at
      from pm.work_orders wo join core.jobs j on j.org_id = wo.org_id and j.id = wo.job_id
     where wo.org_id = p_org and wo.location_id = p_location and wo.status in ('NEW','SCHEDULED','DISPATCHED')
       and wo.kind in ('SERVICE','MAINTENANCE_VISIT','INSTALL') and j.customer_id is not null
       and coalesce(wo.requested_start, wo.scheduled_start) between p_now and p_now + interval '26 hours'
  loop
    insert into pm.fs_appointment_reminders (org_id, location_id, work_order_id, job_id, kind, visit_start, due_at, status)
    values (p_org, p_location, w.id, w.job_id, 'REMINDER_24H', w.start_at, w.start_at - interval '24 hours',
            case when w.start_at - p_now < interval '20 hours' then 'SKIPPED' else 'SCHEDULED' end),
           (p_org, p_location, w.id, w.job_id, 'REMINDER_2H', w.start_at, w.start_at - interval '2 hours',
            case when w.start_at - p_now < interval '90 minutes' then 'SKIPPED' else 'SCHEDULED' end)
    on conflict (org_id, work_order_id, kind, visit_start) do nothing;
  end loop;
  for r in select * from pm.fs_appointment_reminders x
            where x.org_id = p_org and x.location_id = p_location and x.status = 'SCHEDULED' and x.due_at <= p_now and x.visit_start > p_now
            order by x.due_at for update skip locked loop
    select * into w from (select wo.number, wo.job_id, j.customer_id from pm.work_orders wo join core.jobs j on j.org_id = wo.org_id and j.id = wo.job_id
                           where wo.org_id = p_org and wo.id = r.work_order_id) z;
    select t.body into v_tpl from pm.fs_message_templates t
     where t.org_id = p_org and t.location_id = p_location and t.kind = r.kind and t.is_active order by t.created_at limit 1;
    v_body := pm._fs_fill(coalesce(v_tpl, case r.kind
                when 'REMINDER_24H' then 'Reminder from {company}: your visit is {day}, {window}. Reply C to confirm or R to reschedule.'
                else '{company}: we''ll see you today, {window}. Reply C to confirm or R if you need a new time.' end),
              pm._fs_msg_vals(p_org, p_location, null, r.work_order_id));
    v_msg := pm._fs_queue_message(p_org, p_location, r.kind, w.customer_id, r.work_order_id, null, v_body,
                                  format('rem:%s:%s:%s', r.work_order_id, r.kind, extract(epoch from r.visit_start)::bigint), p_now);
    select fm.status, fm.contact_id, fm.to_address into m from pm.fs_messages fm where fm.id = v_msg;
    update pm.fs_appointment_reminders set fs_message_id = v_msg, contact_id = m.contact_id, phone = pm._fs_e164(m.to_address),
           status = case when m.status = 'SUPPRESSED' then 'SUPPRESSED' else 'SENT' end, awaiting_reply = (m.status <> 'SUPPRESSED')
     where id = r.id;
    if m.status <> 'SUPPRESSED' then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Hand every due 1117 outbox row (on my way, reminders, review requests, dunning, follow-ups) to the
-- one notifications service. {eta_link} becomes the customer's portal (live tech status, FS-115).
drop function if exists pm._fs_deliver_outbox(uuid, uuid, int, text);
create or replace function pm._fs_deliver_outbox(p_org uuid default null, p_location uuid default null, p_limit int default 200) returns int
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare m pm.fs_messages%rowtype; v_out uuid; v_event text; v_job uuid; n int := 0; v_base text := pm._fs_app_url('projects');
begin
  for m in select * from pm.fs_messages x
            where x.status = 'QUEUED' and x.outbound_id is null and x.send_after <= now()
              and (p_org is null or x.org_id = p_org) and (p_location is null or x.location_id = p_location)
            order by x.send_after limit greatest(coalesce(p_limit, 200), 1) for update skip locked loop
    v_event := case m.kind when 'ON_MY_WAY' then 'customer.on_my_way' when 'REMINDER_24H' then 'customer.appointment_reminder'
                           when 'REMINDER_2H' then 'customer.appointment_reminder' when 'CONFIRMATION' then 'customer.appointment_reminder'
                           when 'REVIEW_REQUEST' then 'customer.job_complete' else 'customer.message' end;
    select w.job_id into v_job from pm.work_orders w where w.org_id = m.org_id and w.id = m.work_order_id;
    if m.contact_id is null then
      update pm.fs_messages set status = 'FAILED', error_text = 'No contact to send to' where id = m.id;
      continue;
    end if;
    begin
      v_out := core.notify_customer(m.org_id, m.location_id, v_job, v_event, lower(m.channel), m.contact_id, null,
                                    replace(m.body, '{eta_link}', coalesce(v_base, '') || '/portal'), null, 'fsmsg:' || m.id::text, 'fs-outbox');
      update pm.fs_messages set status = 'SENT', outbound_id = v_out, delivered_at = now(), sent_at = coalesce(sent_at, now()) where id = m.id;
      n := n + 1;
    exception when others then
      update pm.fs_messages set status = 'FAILED', error_text = left(sqlerrm, 300) where id = m.id;
    end;
  end loop;
  return n;
end $$;

-- One company, now (office "Run now"; also what the cron does per company). Links in the texts use the
-- platform base URL (pm._fs_app_url — service-only config, allowlisted), never one the caller passes.
drop function if exists pm.fs_run_automations(uuid, text);
create or replace function pm.fs_run_automations(p_location uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_rem int; v_fu int; v_out int;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: company not in the caller''s organization' using errcode = '42501';
  end if;
  v_rem := pm._fs_plan_reminders(v_org, p_location, now());
  v_fu := pm._fs_run_followups(v_org, p_location, now());
  v_out := pm._fs_deliver_outbox(v_org, p_location, 500);
  return jsonb_build_object('reminders', v_rem, 'followups', v_fu, 'delivered', v_out);
end $$;

-- The cron (server key): every company with field-service settings.
drop function if exists public.fs_cron_tick(text, text);
create or replace function public.fs_cron_tick(p_server_key text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s record; v_rem int := 0; v_fu int := 0; v_out int;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  for s in select x.org_id, x.location_id from pm.fs_settings x loop
    v_rem := v_rem + pm._fs_plan_reminders(s.org_id, s.location_id, now());
    v_fu := v_fu + pm._fs_run_followups(s.org_id, s.location_id, now());
  end loop;
  v_out := pm._fs_deliver_outbox(null, null, 1000);
  return jsonb_build_object('reminders', v_rem, 'followups', v_fu, 'delivered', v_out);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Forms and checklists with required readings (FS-29)
-- ----------------------------------------------------------------------------
-- Validate answers against a template's fields (mirrored by apps/projects lib/fieldservice/forms.ts so
-- the phone can check offline). Field: {key, label, type reading|number|pass_fail|check|choice|text|photo,
-- unit, min, max, required, options[], red_tag_on_fail, red_tag_above, red_tag_below}.
create or replace function pm._fs_validate_form(p_fields jsonb, p_answers jsonb) returns jsonb
language plpgsql immutable
set search_path = pm, public
as $$
declare f jsonb; a jsonb; k text; t text; v numeric; v_missing jsonb := '[]'; v_oor jsonb := '[]'; v_failed text[] := '{}';
  v_red boolean := false; v_reason text; v_label text;
begin
  for f in select x from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) x loop
    k := f ->> 'key'; t := coalesce(f ->> 'type', 'text'); v_label := coalesce(f ->> 'label', k);
    a := coalesce(p_answers, '{}'::jsonb) -> k;
    if a is null or a = 'null'::jsonb or (jsonb_typeof(a) = 'string' and btrim(a #>> '{}') = '')
       or (jsonb_typeof(a) = 'array' and jsonb_array_length(a) = 0) then
      if coalesce((f ->> 'required')::boolean, false) then v_missing := v_missing || to_jsonb(v_label); end if;
      continue;
    end if;
    if t in ('reading','number') then
      begin
        v := (a #>> '{}')::numeric;
      exception when others then
        v_missing := v_missing || to_jsonb(v_label || ' (not a number)');
        continue;
      end;
      if (f ? 'min' and v < (f ->> 'min')::numeric) or (f ? 'max' and v > (f ->> 'max')::numeric) then
        v_oor := v_oor || jsonb_build_object('key', k, 'label', v_label, 'value', v, 'min', f -> 'min', 'max', f -> 'max', 'unit', f -> 'unit');
      end if;
      if (f ? 'red_tag_above' and v > (f ->> 'red_tag_above')::numeric) or (f ? 'red_tag_below' and v < (f ->> 'red_tag_below')::numeric) then
        v_red := true; v_reason := coalesce(v_reason, format('%s reading %s%s', v_label, v, coalesce(' ' || (f ->> 'unit'), '')));
      end if;
    elsif t = 'pass_fail' then
      if upper(a #>> '{}') not in ('PASS','FAIL','NA') then v_missing := v_missing || to_jsonb(v_label || ' (pass, fail or n/a)'); continue; end if;
      if upper(a #>> '{}') = 'FAIL' then
        v_failed := v_failed || k;
        if coalesce((f ->> 'red_tag_on_fail')::boolean, false) then v_red := true; v_reason := coalesce(v_reason, v_label || ' failed'); end if;
      end if;
    elsif t = 'choice' then
      if f ? 'options' and not exists (select 1 from jsonb_array_elements_text(f -> 'options') o where o = a #>> '{}') then
        v_missing := v_missing || to_jsonb(v_label || ' (pick one of the choices)');
      end if;
    end if;
  end loop;
  return jsonb_build_object('missing', v_missing, 'out_of_range', v_oor, 'failed', to_jsonb(v_failed), 'red_tag', v_red, 'red_tag_reason', v_reason);
end $$;

-- The forms a visit should use (by booked job type and visit kind) and which are done.
create or replace function pm.fs_forms_for_wo(p_wo uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_jt text;
begin
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = public.get_org_id();
  if w.id is null then raise exception 'PM_FORBIDDEN: visit not found' using errcode = '42501'; end if;
  select bj.key into v_jt from pm.service_calls sc join pm.booking_job_types bj on bj.org_id = sc.org_id and bj.id = sc.booking_job_type_id
   where sc.org_id = w.org_id and sc.id = w.call_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name, 'kind', t.kind, 'fields', t.fields, 'version', t.version,
                                        'requires_signature', t.requires_signature,
                                        'suggested', (v_jt is not null and v_jt = any (t.job_type_keys)) or w.kind = any (t.wo_kinds),
                                        'submitted', exists (select 1 from pm.fs_form_submissions s where s.org_id = w.org_id and s.work_order_id = w.id and s.template_id = t.id))
                     order by ((v_jt is not null and v_jt = any (t.job_type_keys)) or w.kind = any (t.wo_kinds)) desc, t.name)
      from pm.fs_form_templates t
     where t.org_id = w.org_id and t.location_id = w.location_id and t.is_active), '[]'::jsonb);
end $$;

create or replace function pm.fs_submit_form(
  p_wo uuid, p_template uuid, p_answers jsonb, p_signed_name text default null, p_signature_path text default null,
  p_photos uuid[] default '{}', p_command uuid default null, p_red_tag_reason text default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; t pm.fs_form_templates%rowtype; v jsonb; v_id uuid; v_seen jsonb; v_name text := nullif(btrim(coalesce(p_signed_name, '')), '');
begin
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = public.get_org_id();
  if w.id is null then raise exception 'PM_FORBIDDEN: visit not found' using errcode = '42501'; end if;
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(w.org_id, p_command, 'fs.form.submit');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  if w.status = 'CANCELLED' then raise exception 'PM_WO_LOCKED: % is cancelled', w.number using errcode = '55000'; end if;
  select * into t from pm.fs_form_templates x where x.id = p_template and x.org_id = w.org_id and x.location_id = w.location_id and x.is_active;
  if t.id is null then raise exception 'PM_INVALID: that form is not used at this company' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then raise exception 'PM_INVALID: answers must be an object' using errcode = '22023'; end if;
  v := pm._fs_validate_form(t.fields, p_answers);
  if jsonb_array_length(v -> 'missing') > 0 then
    raise exception 'PM_FS_FORM_INCOMPLETE: required — %', (select string_agg(x, ', ') from jsonb_array_elements_text(v -> 'missing') x) using errcode = '22023';
  end if;
  if (v ->> 'red_tag')::boolean and v_name is null then
    raise exception 'PM_FS_RED_TAG_SIGNATURE: an unsafe-equipment red tag needs the customer''s signature (%)', v ->> 'red_tag_reason' using errcode = '22023';
  end if;
  if t.requires_signature and v_name is null then
    raise exception 'PM_FS_FORM_SIGNATURE: % needs a signature', t.name using errcode = '22023';
  end if;
  insert into pm.fs_form_submissions (org_id, location_id, job_id, work_order_id, template_id, template_key, template_kind, template_version,
                                      answers, out_of_range, failed_items, red_tag, red_tag_reason, signed_name, signed_at, signature_path,
                                      photo_command_ids, client_command_id)
  values (w.org_id, w.location_id, w.job_id, w.id, t.id, t.key, t.kind, t.version, coalesce(p_answers, '{}'::jsonb), v -> 'out_of_range',
          array(select jsonb_array_elements_text(v -> 'failed')), (v ->> 'red_tag')::boolean,
          coalesce(nullif(btrim(coalesce(p_red_tag_reason, '')), ''), v ->> 'red_tag_reason'), left(v_name, 120),
          case when v_name is not null then now() end, p_signature_path, coalesce(p_photos, '{}'), p_command)
  returning id into v_id;
  if (v ->> 'red_tag')::boolean then
    update pm.work_orders set follow_up_required = true where id = w.id;
  end if;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'fs_form.submitted', 'work_orders', w.id,
    format('%s: %s%s', w.number, t.name, case when (v ->> 'red_tag')::boolean then ' — RED TAG' else '' end),
    jsonb_build_object('form_id', v_id, 'out_of_range', jsonb_array_length(v -> 'out_of_range'), 'red_tag', (v ->> 'red_tag')::boolean));
  return pm._fs_cmd_done(w.org_id, p_command, 'fs.form.submit', v_id,
    jsonb_build_object('id', v_id, 'out_of_range', v -> 'out_of_range', 'failed', v -> 'failed', 'red_tag', (v ->> 'red_tag')::boolean));
end $$;

-- ----------------------------------------------------------------------------
-- 6. Photos and voice notes → structured notes (FS-30 / FS-31)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_save_visit_note(
  p_wo uuid, p_source text, p_transcript text, p_fields jsonb, p_photos uuid[] default '{}', p_photo_tags jsonb default '{}',
  p_command uuid default null, p_structured_by text default 'RULES'
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_id uuid; v_seen jsonb; f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = public.get_org_id();
  if w.id is null then raise exception 'PM_FORBIDDEN: visit not found' using errcode = '42501'; end if;
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(w.org_id, p_command, 'fs.note.save');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if coalesce(nullif(btrim(coalesce(p_transcript, '')), ''), nullif(btrim(coalesce(f ->> 'diagnosis', '')), ''),
              nullif(btrim(coalesce(f ->> 'work_performed', '')), ''), nullif(btrim(coalesce(f ->> 'recommendations', '')), '')) is null then
    raise exception 'PM_INVALID: the note is empty' using errcode = '22023';
  end if;
  insert into pm.fs_visit_notes (org_id, location_id, job_id, work_order_id, source, transcript, diagnosis, work_performed, recommendations,
                                 customer_summary, structured_by, photo_command_ids, photo_tags, client_command_id)
  values (w.org_id, w.location_id, w.job_id, w.id, case when upper(p_source) = 'VOICE' then 'VOICE' else 'TYPED' end, left(p_transcript, 20000),
          left(nullif(btrim(coalesce(f ->> 'diagnosis', '')), ''), 4000), left(nullif(btrim(coalesce(f ->> 'work_performed', '')), ''), 4000),
          left(nullif(btrim(coalesce(f ->> 'recommendations', '')), ''), 4000), left(nullif(btrim(coalesce(f ->> 'customer_summary', '')), ''), 4000),
          case when upper(coalesce(p_structured_by, 'RULES')) in ('RULES','AI','PERSON') then upper(coalesce(p_structured_by, 'RULES')) else 'RULES' end,
          coalesce(p_photos, '{}'), case when jsonb_typeof(coalesce(p_photo_tags, '{}'::jsonb)) = 'object' then coalesce(p_photo_tags, '{}'::jsonb) else '{}'::jsonb end,
          p_command)
  returning id into v_id;
  update pm.work_orders set cause = coalesce(cause, left(nullif(btrim(coalesce(f ->> 'diagnosis', '')), ''), 4000)),
         resolution = coalesce(resolution, left(nullif(btrim(coalesce(f ->> 'work_performed', '')), ''), 4000))
   where id = w.id;
  return pm._fs_cmd_done(w.org_id, p_command, 'fs.note.save', v_id, jsonb_build_object('id', v_id));
end $$;

-- ----------------------------------------------------------------------------
-- 7. Unsold-estimate follow-up cadences (FS-56)
-- ----------------------------------------------------------------------------
create or replace function pm._fs_start_followups(p_estimate uuid) returns int
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; c pm.fs_followup_cadences%rowtype; st jsonb; i int := 0; v_owner uuid; n int := 0;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate;
  if e.id is null or e.status <> 'PRESENTED' then return 0; end if;
  select * into c from pm.fs_followup_cadences x where x.org_id = e.org_id and x.location_id = e.location_id and x.is_active
   order by x.is_default desc, x.created_at limit 1;
  if c.id is null then return 0; end if;
  v_owner := e.sold_by_employee_id;
  if v_owner is null and e.work_order_id is not null then
    select d.employee_id into v_owner from pm.dispatch_assignments d
     where d.org_id = e.org_id and d.work_order_id = e.work_order_id and d.status <> 'CANCELLED' and d.employee_id is not null
     order by d.is_lead desc, d.created_at limit 1;
  end if;
  for st in select x from jsonb_array_elements(c.steps) x loop
    i := i + 1;
    insert into pm.fs_estimate_followups (org_id, location_id, job_id, estimate_id, cadence_id, step_no, channel, body, due_at, owner_employee_id)
    values (e.org_id, e.location_id, e.job_id, e.id, c.id, i, upper(coalesce(st ->> 'channel', 'SMS')), st ->> 'body',
            coalesce(e.presented_at, now()) + make_interval(days => coalesce((st ->> 'day')::int, i)), v_owner)
    on conflict (org_id, estimate_id, step_no) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function pm._fs_run_followups(p_org uuid, p_location uuid, p_now timestamptz default now()) returns int
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare f pm.fs_estimate_followups%rowtype; e pm.fs_estimates%rowtype; v_msg uuid; v_st text; n int := 0; v_body text;
begin
  for f in select * from pm.fs_estimate_followups x
            where x.org_id = p_org and x.location_id = p_location and x.status = 'SCHEDULED' and x.due_at <= p_now
            order by x.due_at for update skip locked loop
    select * into e from pm.fs_estimates x where x.id = f.estimate_id;
    if e.status <> 'PRESENTED' or e.customer_id is null then
      update pm.fs_estimate_followups set status = 'CANCELLED' where id = f.id;
      continue;
    end if;
    if f.channel = 'CALL_TASK' then
      update pm.fs_estimate_followups set status = 'DUE' where id = f.id;
      n := n + 1;
      continue;
    end if;
    v_body := pm._fs_fill(coalesce(nullif(btrim(coalesce(f.body, '')), ''),
                'Hi {first_name}, it''s {company}. Any questions about the options we went over? Reply here or call us — your quote is good until {valid_until}.'),
              pm._fs_msg_vals(p_org, p_location, null, e.work_order_id)
              || jsonb_build_object('valid_until', coalesce(trim(to_char(e.valid_until, 'Mon FMDD')), 'the end of the month'), 'estimate', coalesce(e.number, '')));
    v_msg := pm._fs_queue_message(p_org, p_location, 'FOLLOW_UP', e.customer_id, e.work_order_id, null, v_body,
                                  format('fu:%s:%s', e.id, f.step_no), p_now, case when f.channel = 'EMAIL' then 'EMAIL' else 'SMS' end);
    select m.status into v_st from pm.fs_messages m where m.id = v_msg;
    update pm.fs_estimate_followups set fs_message_id = v_msg, status = case when v_st = 'SUPPRESSED' then 'SUPPRESSED' else 'SENT' end,
           completed_at = now()
     where id = f.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Open estimates with aging, owner and the next step (the follow-up queue).
create or replace function pm.fs_followup_queue(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  return coalesce((
    select jsonb_agg(x order by x.age_days desc) from (
      select e.id, e.number, e.title, e.job_id, e.customer_id, (select c.name from core.customers c where c.id = e.customer_id) as customer,
             e.presented_at, (current_date - coalesce(e.presented_at, e.created_at)::date) as age_days, e.valid_until,
             coalesce(e.sold_by_employee_id, (select f2.owner_employee_id from pm.fs_estimate_followups f2 where f2.org_id = e.org_id and f2.estimate_id = e.id limit 1)) as owner_employee_id,
             (select min(t.regular_cents) from pm.v_fs_option_totals t where t.estimate_id = e.id) as from_cents,
             (select max(t.regular_cents) from pm.v_fs_option_totals t where t.estimate_id = e.id) as to_cents,
             (select jsonb_build_object('id', f.id, 'step', f.step_no, 'channel', f.channel, 'due_at', f.due_at, 'status', f.status)
                from pm.fs_estimate_followups f where f.org_id = e.org_id and f.estimate_id = e.id and f.status in ('SCHEDULED','DUE')
               order by f.due_at limit 1) as next_step,
             (select count(*)::int from pm.fs_estimate_followups f where f.org_id = e.org_id and f.estimate_id = e.id and f.status = 'DUE') as calls_due,
             (select count(*)::int from pm.fs_estimate_followups f where f.org_id = e.org_id and f.estimate_id = e.id and f.status in ('SENT','DONE')) as touches
        from pm.fs_estimates e
       where e.org_id = v_org and e.location_id = p_location and e.status = 'PRESENTED') x), '[]'::jsonb);
end $$;

create or replace function pm.fs_complete_followup(p_followup uuid, p_outcome text, p_status text default 'DONE') returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.fs_estimate_followups%rowtype;
begin
  select * into f from pm.fs_estimate_followups x where x.id = p_followup and x.org_id = public.get_org_id() for update;
  if f.id is null then raise exception 'PM_FORBIDDEN: follow-up not found' using errcode = '42501'; end if;
  if upper(coalesce(p_status, 'DONE')) not in ('DONE','SKIPPED') then raise exception 'PM_INVALID: DONE or SKIPPED' using errcode = '22023'; end if;
  if f.status not in ('SCHEDULED','DUE') then raise exception 'PM_INVALID: this step is already %', lower(f.status) using errcode = '22023'; end if;
  update pm.fs_estimate_followups set status = upper(coalesce(p_status, 'DONE')), outcome = left(p_outcome, 500), completed_at = now(),
         completed_by = pm.current_user_id()
   where id = f.id;
  return f.id;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Comfort-advisor sales pipeline (FS-57)
-- ----------------------------------------------------------------------------
create or replace function pm.tg_fs_tgl_opportunity() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  begin
    insert into pm.fs_opportunities (org_id, location_id, job_id, customer_id, site_id, title, source, tgl_id, set_by_employee_id, business_unit_id, created_by)
    select new.org_id, new.location_id, new.job_id, j.customer_id, w.site_id, left('Replacement lead: ' || new.reason, 200), 'TGL', new.id,
           new.set_by_employee_id, w.business_unit_id, new.created_by
      from core.jobs j left join pm.work_orders w on w.org_id = new.org_id and w.id = new.work_order_id
     where j.org_id = new.org_id and j.id = new.job_id
    on conflict do nothing;
  exception when others then
    raise warning '[1123] TGL opportunity skipped: %', sqlerrm;
  end;
  return new;
end $$;
create or replace trigger trg_fs_tgl_opportunity after insert on pm.fs_tgl_leads for each row execute function pm.tg_fs_tgl_opportunity();

create or replace function pm.fs_open_opportunity(
  p_location uuid, p_customer uuid, p_title text, p_source text default 'MARKETING', p_campaign uuid default null, p_advisor uuid default null,
  p_appointment_at timestamptz default null, p_job uuid default null, p_site uuid default null, p_business_unit uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then raise exception 'PM_INVALID: company not found' using errcode = '22023'; end if;
  if p_customer is not null and not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org) then
    raise exception 'PM_INVALID: customer not found' using errcode = '22023';
  end if;
  if p_job is not null and not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org and j.location_id = p_location) then
    raise exception 'PM_INVALID: that job is not at this company' using errcode = '22023';
  end if;
  if upper(coalesce(p_source, 'MARKETING')) not in ('TGL','MARKETING','CALL','WEB','REFERRAL','AGREEMENT','OTHER') then
    raise exception 'PM_INVALID: unknown lead source' using errcode = '22023';
  end if;
  if p_advisor is not null and not exists (select 1 from core.employees e where e.id = p_advisor and e.org_id = v_org) then
    raise exception 'PM_INVALID: that advisor is not in this organization' using errcode = '22023';
  end if;
  if p_site is not null and not exists (select 1 from core.sites x where x.id = p_site and x.org_id = v_org
                                          and (p_customer is null or x.customer_id is null or x.customer_id = p_customer)) then
    raise exception 'PM_INVALID: that site is not this customer''s' using errcode = '22023';
  end if;
  if p_business_unit is not null and not exists (select 1 from pm.business_units b where b.id = p_business_unit and b.org_id = v_org and b.location_id = p_location) then
    raise exception 'PM_INVALID: that business unit is not at this company' using errcode = '22023';
  end if;
  if p_campaign is not null and not exists (select 1 from pm.campaigns c where c.id = p_campaign and c.org_id = v_org and c.location_id = p_location) then
    raise exception 'PM_INVALID: that campaign is not at this company' using errcode = '22023';
  end if;
  insert into pm.fs_opportunities (org_id, location_id, job_id, customer_id, site_id, title, source, campaign_id, business_unit_id,
                                   advisor_employee_id, stage, appointment_at)
  values (v_org, p_location, p_job, p_customer, p_site, left(coalesce(nullif(btrim(p_title), ''), 'Replacement estimate'), 200),
          upper(coalesce(p_source, 'MARKETING')), p_campaign, p_business_unit, p_advisor,
          case when p_appointment_at is not null then 'APPOINTMENT' else 'LEAD' end, p_appointment_at)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm.fs_advance_opportunity(
  p_opportunity uuid, p_stage text, p_reason text default null, p_appointment_at timestamptz default null,
  p_advisor uuid default null, p_estimate uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.fs_opportunities%rowtype; v_stage text := upper(coalesce(p_stage, '')); e pm.fs_estimates%rowtype;
begin
  select * into o from pm.fs_opportunities x where x.id = p_opportunity and x.org_id = public.get_org_id() for update;
  if o.id is null then raise exception 'PM_FORBIDDEN: opportunity not found' using errcode = '42501'; end if;
  if v_stage not in ('LEAD','APPOINTMENT','PROPOSAL','SOLD','LOST') then raise exception 'PM_INVALID: unknown stage' using errcode = '22023'; end if;
  if o.stage in ('SOLD','LOST') and v_stage <> o.stage then raise exception 'PM_INVALID: this opportunity is already %', lower(o.stage) using errcode = '22023'; end if;
  if v_stage = 'LOST' and char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PM_INVALID: say why it was lost' using errcode = '22023'; end if;
  if p_advisor is not null and not exists (select 1 from core.employees x where x.id = p_advisor and x.org_id = o.org_id) then
    raise exception 'PM_INVALID: that advisor is not in this organization' using errcode = '22023';
  end if;
  if p_estimate is not null then
    select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = o.org_id and x.location_id = o.location_id;
    if e.id is null then raise exception 'PM_INVALID: that estimate is not at this company' using errcode = '22023'; end if;
  end if;
  if v_stage = 'SOLD' and coalesce(e.status, (select x.status from pm.fs_estimates x where x.id = o.estimate_id)) is distinct from 'SOLD' then
    raise exception 'PM_INVALID: an opportunity is sold when its estimate is signed' using errcode = '22023';
  end if;
  update pm.fs_opportunities set stage = v_stage, stage_changed_at = case when v_stage <> o.stage then now() else stage_changed_at end,
         lost_reason = case when v_stage = 'LOST' then left(btrim(p_reason), 500) else lost_reason end,
         appointment_at = coalesce(p_appointment_at, appointment_at), advisor_employee_id = coalesce(p_advisor, advisor_employee_id),
         estimate_id = coalesce(p_estimate, estimate_id), job_id = coalesce(e.job_id, job_id)
   where id = o.id;
  if o.tgl_id is not null and v_stage in ('APPOINTMENT','LOST') then
    update pm.fs_tgl_leads set status = v_stage, lost_reason = case when v_stage = 'LOST' then left(btrim(p_reason), 500) else lost_reason end
     where org_id = o.org_id and id = o.tgl_id and status not in ('SOLD');
  end if;
  return o.id;
end $$;

-- Close rate by advisor and by source (TGL vs marketing), stalled deals (FS-57).
create or replace function pm.fs_advisor_pipeline(p_location uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_money boolean := pm.can('projects.contract_value', 'view', p_location);
  v_from date := coalesce(p_from, current_date - 90); v_to date := coalesce(p_to, current_date);
begin
  return jsonb_build_object(
    'by_advisor', coalesce((select jsonb_agg(x order by x.sold desc, x.advisor) from (
       select o.advisor_employee_id as advisor_id,
              coalesce((select nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), '') from core.employees e where e.id = o.advisor_employee_id), 'Unassigned') as advisor,
              count(*)::int as opportunities, count(*) filter (where o.stage = 'APPOINTMENT')::int as appointments,
              count(*) filter (where o.stage = 'PROPOSAL')::int as proposals, count(*) filter (where o.stage = 'SOLD')::int as sold,
              count(*) filter (where o.stage = 'LOST')::int as lost,
              case when count(*) filter (where o.stage in ('SOLD','LOST')) > 0
                   then round(count(*) filter (where o.stage = 'SOLD')::numeric / count(*) filter (where o.stage in ('SOLD','LOST')), 4) end as close_rate,
              case when v_money then coalesce(sum(o.sold_cents) filter (where o.stage = 'SOLD'), 0) end as sold_cents
         from pm.fs_opportunities o
        where o.org_id = v_org and o.location_id = p_location and o.created_at::date between v_from and v_to
        group by o.advisor_employee_id) x), '[]'::jsonb),
    'by_source', coalesce((select jsonb_agg(x order by x.source) from (
       select o.source, count(*)::int as opportunities, count(*) filter (where o.stage = 'SOLD')::int as sold,
              count(*) filter (where o.stage = 'LOST')::int as lost,
              case when count(*) filter (where o.stage in ('SOLD','LOST')) > 0
                   then round(count(*) filter (where o.stage = 'SOLD')::numeric / count(*) filter (where o.stage in ('SOLD','LOST')), 4) end as close_rate,
              case when v_money then coalesce(sum(o.sold_cents) filter (where o.stage = 'SOLD'), 0) end as sold_cents
         from pm.fs_opportunities o
        where o.org_id = v_org and o.location_id = p_location and o.created_at::date between v_from and v_to
        group by o.source) x), '[]'::jsonb),
    'open', coalesce((select jsonb_agg(x order by x.days_in_stage desc) from (
       select o.id, o.title, o.stage, o.source, o.customer_id, (select c.name from core.customers c where c.id = o.customer_id) as customer,
              o.advisor_employee_id, o.appointment_at, o.estimate_id, o.job_id,
              (current_date - o.stage_changed_at::date) as days_in_stage,
              ((current_date - o.stage_changed_at::date) > case o.stage when 'LEAD' then 2 when 'APPOINTMENT' then 3 else 7 end) as stalled,
              case o.stage when 'LEAD' then 'Book the in-home appointment' when 'APPOINTMENT' then 'Run the appointment and present options'
                           else 'Follow up on the proposal' end as next_step
         from pm.fs_opportunities o
        where o.org_id = v_org and o.location_id = p_location and o.stage not in ('SOLD','LOST')) x), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- 9. Estimate lifecycle hooks (follow-ups, pipeline, tax pin, financing, install handoff)
-- ----------------------------------------------------------------------------
create or replace function pm.tg_fs_estimate_lifecycle() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_opp uuid; v_has_equipment boolean; v_sold bigint;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'PRESENTED' then
    begin perform pm._fs_start_followups(new.id); exception when others then raise warning '[1123] follow-ups skipped: %', sqlerrm; end;
    begin perform pm._fs_pin_estimate_tax(new.id); exception when others then raise warning '[1123] tax pin skipped: %', sqlerrm; end;
    begin
      select o.id into v_opp from pm.fs_opportunities o where o.org_id = new.org_id and o.estimate_id = new.id;
      if v_opp is null then
        select o.id into v_opp from pm.fs_opportunities o
         where o.org_id = new.org_id and o.job_id = new.job_id and o.estimate_id is null and o.stage in ('LEAD','APPOINTMENT')
         order by o.created_at limit 1;
      end if;
      v_has_equipment := exists (select 1 from pm.fs_estimate_option_items i join pm.fs_estimate_options op on op.org_id = i.org_id and op.id = i.option_id
                                  where op.org_id = new.org_id and op.estimate_id = new.id and i.kind = 'EQUIPMENT');
      if v_opp is not null then
        update pm.fs_opportunities set stage = 'PROPOSAL', estimate_id = new.id, stage_changed_at = now() where id = v_opp and stage not in ('SOLD','LOST');
      elsif v_has_equipment then
        insert into pm.fs_opportunities (org_id, location_id, job_id, customer_id, site_id, title, source, campaign_id, business_unit_id,
                                         advisor_employee_id, stage, estimate_id)
        select new.org_id, new.location_id, new.job_id, new.customer_id, w.site_id, left(new.title, 200),
               case when w.booking_channel in ('WEB') then 'WEB' when w.campaign_id is not null then 'MARKETING' else 'CALL' end,
               w.campaign_id, w.business_unit_id, new.sold_by_employee_id, 'PROPOSAL', new.id
          from (select 1) one left join pm.work_orders w on w.org_id = new.org_id and w.id = new.work_order_id
        on conflict do nothing;
      end if;
    exception when others then raise warning '[1123] pipeline update skipped: %', sqlerrm; end;
  elsif new.status in ('SOLD','DECLINED','EXPIRED') then
    update pm.fs_estimate_followups set status = 'CANCELLED' where org_id = new.org_id and estimate_id = new.id and status in ('SCHEDULED','DUE');
    begin
      if new.status = 'SOLD' then
        select coalesce(sum(case when new.member_pricing then t.member_cents else t.regular_cents end), 0) into v_sold
          from pm.v_fs_option_totals t where t.option_id = any (new.sold_option_ids);
        update pm.fs_opportunities set stage = 'SOLD', sold_cents = v_sold, stage_changed_at = now()
         where org_id = new.org_id and estimate_id = new.id and stage <> 'SOLD';
      else
        update pm.fs_opportunities set stage = 'LOST', lost_reason = coalesce(new.decline_reason, 'Estimate ' || lower(new.status)), stage_changed_at = now()
         where org_id = new.org_id and estimate_id = new.id and stage not in ('SOLD','LOST');
      end if;
    exception when others then raise warning '[1123] pipeline close skipped: %', sqlerrm; end;
    if new.status = 'SOLD' then
      begin perform pm._fs_record_financing(new.id); exception when others then raise warning '[1123] financing record skipped: %', sqlerrm; end;
      begin perform pm._fs_handoff_install(new.id, false); exception when others then raise warning '[1123] install handoff skipped: %', sqlerrm; end;
    end if;
  end if;
  return new;
end $$;
create or replace trigger trg_fs_estimate_lifecycle after update of status on pm.fs_estimates
  for each row execute function pm.tg_fs_estimate_lifecycle();

-- ----------------------------------------------------------------------------
-- 10. Online estimate approval (FS-59) and the client hub (FS-115) — portal session scoped
-- ----------------------------------------------------------------------------
create or replace function portal._fs_option_json(p_option uuid, p_member boolean) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'id', o.id, 'tier', o.tier, 'name', o.name, 'description', o.description, 'image_url', o.image_url, 'recommended', o.recommended,
    'status', o.status, 'rebate_cents', o.rebate_cents, 'rebate_note', o.rebate_note,
    'regular_cents', t.regular_cents, 'member_cents', t.member_cents,
    'price_cents', case when p_member then t.member_cents else t.regular_cents end,
    'financing', case when fp.id is not null then jsonb_build_object('name', fp.name, 'provider', fp.provider, 'term_months', fp.term_months, 'apr', fp.apr,
       'monthly_cents', pm.fs_monthly_payment(greatest((case when p_member then t.member_cents else t.regular_cents end) - o.rebate_cents, 0), fp.apr, fp.term_months)) end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'description', i.description, 'qty', i.qty,
                                                           'unit_price_cents', case when p_member then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end,
                                                           'regular_unit_price_cents', i.unit_price_cents, 'optional', i.is_optional, 'selected', i.is_selected)
                                        order by i.sort)
                         from pm.fs_estimate_option_items i where i.org_id = o.org_id and i.option_id = o.id), '[]'::jsonb))
    from pm.fs_estimate_options o
    left join pm.v_fs_option_totals t on t.option_id = o.id
    left join pm.financing_plans fp on fp.org_id = o.org_id and fp.id = o.financing_plan_id and fp.is_active
   where o.id = p_option
$$;

create or replace function portal.fs_estimate(p_session text, p_org uuid, p_estimate uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; e pm.fs_estimates%rowtype; g pm.portal_grants;
begin
  s := portal._session(p_session);
  select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = p_org and x.status in ('PRESENTED','SOLD');
  if e.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  g := portal._job_grant(s, p_org, e.job_id, array['customer']);
  if g.id is null or (e.customer_id is not null and e.customer_id is distinct from g.customer_id) then
    raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', e.id, 'number', e.number, 'title', e.title, 'status', e.status, 'valid_until', e.valid_until, 'member_pricing', e.member_pricing,
    'company', (select l.name from core.locations l where l.id = e.location_id), 'brand', pm._doc_brand(e.location_id),
    'expired', e.valid_until is not null and e.valid_until < current_date,
    'can_accept', e.status = 'PRESENTED' and g.role = 'approver' and g.can_sign and (e.valid_until is null or e.valid_until >= current_date),
    'options', coalesce((select jsonb_agg(portal._fs_option_json(o.id, e.member_pricing) order by o.sort)
                           from pm.fs_estimate_options o where o.org_id = e.org_id and o.estimate_id = e.id), '[]'::jsonb),
    'pending', (select jsonb_build_object('option_id', a.option_id, 'accepted_at', a.accepted_at, 'typed_name', a.typed_name)
                  from pm.fs_online_acceptances a where a.org_id = e.org_id and a.estimate_id = e.id and a.status = 'PENDING'));
end $$;

create or replace function portal.fs_estimate_accept(
  p_session text, p_org uuid, p_estimate uuid, p_option uuid, p_optional_on uuid[], p_typed_name text, p_consent boolean,
  p_ip text default null, p_user_agent text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; e pm.fs_estimates%rowtype; g pm.portal_grants; v_ver text; v_id uuid; v_sel uuid[]; v_desel uuid[]; v_total bigint;
begin
  s := portal._session(p_session);
  if not coalesce(p_consent, false) then raise exception 'PORTAL_INVALID: agree to sign electronically' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_typed_name, ''))) not between 2 and 200 then raise exception 'PORTAL_INVALID: type your full name' using errcode = '22023'; end if;
  select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = p_org and x.status = 'PRESENTED' for update;
  if e.id is null then raise exception 'PORTAL_INVALID: this is no longer waiting on you' using errcode = '22023'; end if;
  if e.valid_until is not null and e.valid_until < current_date then raise exception 'PORTAL_INVALID: this estimate has expired — ask for an updated one' using errcode = '22023'; end if;
  g := portal._job_grant(s, p_org, e.job_id, array['customer']);
  if g.id is null or (e.customer_id is not null and e.customer_id is distinct from g.customer_id) then
    raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501';
  end if;
  if g.role <> 'approver' or not g.can_sign then
    raise exception 'PORTAL_FORBIDDEN: you can view this, but someone else in your household signs it' using errcode = '42501';
  end if;
  v_ver := portal._verified(s, g);
  if v_ver is null then raise exception 'PORTAL_VERIFY: confirm your phone number first' using errcode = '28000'; end if;
  if not exists (select 1 from pm.fs_estimate_options o where o.id = p_option and o.org_id = e.org_id and o.estimate_id = e.id and o.status = 'OPEN') then
    raise exception 'PORTAL_INVALID: pick one of the options' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_optional_on, '{}')) x
              where not exists (select 1 from pm.fs_estimate_option_items i where i.org_id = e.org_id and i.option_id = p_option and i.id = x and i.is_optional)) then
    raise exception 'PORTAL_INVALID: only this option''s add-ons can be ticked' using errcode = '22023';
  end if;
  select coalesce(array_agg(i.id) filter (where not i.is_optional or i.id = any (coalesce(p_optional_on, '{}'))), '{}'),
         coalesce(array_agg(i.id) filter (where i.is_optional and not (i.id = any (coalesce(p_optional_on, '{}')))), '{}'),
         coalesce(sum(round(i.qty * case when e.member_pricing then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end))
                  filter (where not i.is_optional or i.id = any (coalesce(p_optional_on, '{}'))), 0)::bigint
    into v_sel, v_desel, v_total
    from pm.fs_estimate_option_items i where i.org_id = e.org_id and i.option_id = p_option;
  update pm.fs_online_acceptances set status = 'SUPERSEDED' where org_id = e.org_id and estimate_id = e.id and status = 'PENDING';
  insert into pm.fs_online_acceptances (org_id, location_id, job_id, estimate_id, option_id, selected_item_ids, deselected_item_ids, typed_name,
                                        portal_grant_id, person_id, ip, user_agent)
  values (e.org_id, e.location_id, e.job_id, e.id, p_option, v_sel, v_desel, left(btrim(p_typed_name), 200), g.id, g.person_id, left(p_ip, 64), left(p_user_agent, 500))
  returning id into v_id;
  perform portal._log(e.org_id, e.location_id, e.job_id, g, 'fs_estimate.accepted', 'fs_estimates', e.id,
                      jsonb_build_object('option_id', p_option, 'add_ons', to_jsonb(coalesce(p_optional_on, '{}'))), v_ver, p_ip, p_user_agent);
  perform portal._notify_team(e.org_id, e.job_id, left(format('%s accepted %s online', g.display_name, coalesce(e.number, 'an estimate')), 200),
                              format('/dispatch/visit/%s', e.work_order_id), format('fs_acc:%s', v_id));
  return jsonb_build_object('status', 'received', 'acceptance_id', v_id, 'total_cents', v_total);
end $$;

-- Staff: turn an online acceptance into the sale (the same pm.fs_sell_estimate the tablet uses).
create or replace function pm.fs_finalize_online_acceptance(p_acceptance uuid, p_deposit_cents bigint default 0, p_request_deposit boolean default false,
                                                            p_financing_plan uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.fs_online_acceptances%rowtype; e pm.fs_estimates%rowtype; r jsonb;
begin
  select * into a from pm.fs_online_acceptances x where x.id = p_acceptance and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: acceptance not found' using errcode = '42501'; end if;
  if a.status <> 'PENDING' then raise exception 'PM_INVALID: this acceptance was already %', lower(a.status) using errcode = '22023'; end if;
  select * into e from pm.fs_estimates x where x.id = a.estimate_id for update;
  if e.status <> 'PRESENTED' then raise exception 'PM_FS_ESTIMATE_LOCKED: % is %', e.number, e.status using errcode = '55000'; end if;
  update pm.fs_estimate_option_items set is_selected = true where org_id = a.org_id and option_id = a.option_id and id = any (a.selected_item_ids);
  update pm.fs_estimate_option_items set is_selected = false where org_id = a.org_id and option_id = a.option_id and id = any (a.deselected_item_ids);
  r := pm.fs_sell_estimate(e.id, array[a.option_id], a.typed_name, 'Not chosen online', null, coalesce(p_deposit_cents, 0),
                           coalesce(p_request_deposit, false), 'portal:' || a.id::text, p_financing_plan, null, null);
  update pm.fs_online_acceptances set status = 'FINALIZED', finalized_by = pm.current_user_id(), finalized_at = now() where id = a.id;
  return r || jsonb_build_object('acceptance_id', a.id);
end $$;

create or replace function pm.fs_reject_online_acceptance(p_acceptance uuid, p_reason text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.fs_online_acceptances%rowtype;
begin
  select * into a from pm.fs_online_acceptances x where x.id = p_acceptance and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: acceptance not found' using errcode = '42501'; end if;
  if a.status <> 'PENDING' then raise exception 'PM_INVALID: this acceptance was already %', lower(a.status) using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PM_INVALID: say why' using errcode = '22023'; end if;
  update pm.fs_online_acceptances set status = 'REJECTED', reject_reason = left(btrim(p_reason), 500), finalized_by = pm.current_user_id(), finalized_at = now()
   where id = a.id;
  return a.id;
end $$;

-- The customer's home in the portal: visits with live tech status, estimates waiting, agreements,
-- equipment and warranty, recent history. Sell / own-invoice figures only — never cost.
create or replace function portal.fs_hub(p_session text, p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; v_jobs uuid[]; v_custs uuid[]; v_locs uuid[];
begin
  s := portal._session(p_session);
  select coalesce(array_agg(distinct j), '{}'), coalesce(array_agg(distinct g.customer_id), '{}'), coalesce(array_agg(distinct g.location_id), '{}')
    into v_jobs, v_custs, v_locs
    from portal._grants(s, p_org) g left join lateral portal._grant_jobs(g.id) j on true
   where g.audience = 'customer';
  if cardinality(v_custs) = 0 then raise exception 'PORTAL_FORBIDDEN: no customer access at this company' using errcode = '42501'; end if;
  return jsonb_build_object(
    'visits', coalesce((select jsonb_agg(x order by x.start_at nulls last) from (
      select w.id, w.number, w.summary, w.status, w.job_id, coalesce(w.requested_start, w.scheduled_start) as start_at,
             aw.label as arrival_window, w.customer_confirmation as confirmation,
             (select coalesce(tp.display_name, e.first_name) from pm.dispatch_assignments d join core.employees e on e.id = d.employee_id
                left join pm.tech_profiles tp on tp.org_id = d.org_id and tp.employee_id = d.employee_id
               where d.org_id = w.org_id and d.work_order_id = w.id and d.status <> 'CANCELLED' order by d.is_lead desc, d.created_at limit 1) as technician,
             (select d.status from pm.dispatch_assignments d where d.org_id = w.org_id and d.work_order_id = w.id and d.status <> 'CANCELLED'
               order by d.is_lead desc, d.created_at limit 1) as technician_status,
             (w.status in ('NEW','SCHEDULED','DISPATCHED') and coalesce(w.requested_start, w.scheduled_start) > now()) as can_confirm
        from pm.work_orders w left join pm.arrival_windows aw on aw.org_id = w.org_id and aw.id = w.arrival_window_id
       where w.org_id = p_org and w.job_id = any (v_jobs) and w.status in ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD')) x), '[]'::jsonb),
    'estimates', coalesce((select jsonb_agg(x order by x.presented_at desc) from (
      select e.id, e.number, e.title, e.status, e.valid_until, e.presented_at, e.job_id,
             (select count(*)::int from pm.fs_estimate_options o where o.org_id = e.org_id and o.estimate_id = e.id) as options,
             (select min(case when e.member_pricing then t.member_cents else t.regular_cents end) from pm.v_fs_option_totals t where t.estimate_id = e.id) as from_cents,
             exists (select 1 from pm.fs_online_acceptances a where a.org_id = e.org_id and a.estimate_id = e.id and a.status = 'PENDING') as accepted_pending
        from pm.fs_estimates e
       where e.org_id = p_org and e.job_id = any (v_jobs) and e.status = 'PRESENTED' and (e.customer_id is null or e.customer_id = any (v_custs))) x), '[]'::jsonb),
    'agreements', coalesce((select jsonb_agg(x order by x.ends_on) from (
      select a.id, a.number, a.plan_name, a.tier, a.status, a.starts_on, a.ends_on, a.auto_renew, a.price_cents, a.billing_frequency,
             a.payment_method_label, coalesce(a.visits_included, a.visits_per_term) as visits_included,
             (select count(*)::int from pm.work_orders v where v.org_id = a.org_id and v.agreement_id = a.id and v.status in ('COMPLETE','CLOSED')) as visits_done,
             (select min(coalesce(v.due_on, v.due_by)) from pm.work_orders v where v.org_id = a.org_id and v.agreement_id = a.id and v.status in ('NEW','SCHEDULED','DISPATCHED')) as next_visit_due,
             exists (select 1 from pm.fs_autopay_enrollments ap where ap.org_id = a.org_id and ap.agreement_id = a.id and ap.status <> 'CANCELLED') as autopay
        from pm.service_agreements a
       where a.org_id = p_org and a.customer_id = any (v_custs) and a.location_id = any (v_locs) and a.status in ('ACTIVE','SUSPENDED','EXPIRED')) x), '[]'::jsonb),
    'equipment', coalesce((select jsonb_agg(x order by x.equipment_type, x.make) from (
      select a.id, a.equipment_type, a.make, a.model, right(a.serial_number, 4) as serial_last4, a.installed_on,
             case when coalesce(a.installed_on, a.manufactured_on) is not null then extract(year from age(current_date, coalesce(a.installed_on, a.manufactured_on)))::int end as age_years,
             coalesce(a.parts_warranty_ends_on, a.warranty_expires_on) as parts_warranty_ends_on, a.labor_warranty_ends_on, a.registration_status,
             a.last_service_on
        from pm.assets a
       where a.org_id = p_org and a.customer_id = any (v_custs) and a.location_id = any (v_locs) and a.status = 'ACTIVE' and a.kind = 'CUSTOMER_EQUIPMENT') x), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(x order by x.completed_at desc) from (
      select w.id, w.number, w.summary, w.completed_at, w.job_id,
             (select n.customer_summary from pm.fs_visit_notes n where n.org_id = w.org_id and n.work_order_id = w.id and n.customer_summary is not null
               order by n.created_at desc limit 1) as summary_for_customer
        from pm.work_orders w
       where w.org_id = p_org and w.job_id = any (v_jobs) and w.status in ('COMPLETE','CLOSED')
       order by w.completed_at desc nulls last limit 10) x), '[]'::jsonb));
end $$;

-- Confirm or ask to reschedule a visit from the hub (same effect as replying C / R to the reminder).
create or replace function portal.fs_confirm_visit(p_session text, p_org uuid, p_wo uuid, p_response text, p_note text default null,
                                                   p_ip text default null, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare s pm.portal_sessions; w pm.work_orders%rowtype; g pm.portal_grants; v_resp text := upper(coalesce(p_response, '')); v_thread uuid; v_cust uuid;
begin
  s := portal._session(p_session);
  if v_resp not in ('CONFIRM','RESCHEDULE') then raise exception 'PORTAL_INVALID: confirm or ask for a new time' using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = p_org for update;
  if w.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  g := portal._job_grant(s, p_org, w.job_id, array['customer']);
  if g.id is null then raise exception 'PORTAL_FORBIDDEN: not found' using errcode = '42501'; end if;
  if w.status not in ('NEW','SCHEDULED','DISPATCHED') then raise exception 'PORTAL_INVALID: this visit can no longer be changed here — call us' using errcode = '22023'; end if;
  if v_resp = 'RESCHEDULE' and portal._verified(s, g) is null and g.role is distinct from 'approver' then
    raise exception 'PORTAL_VERIFY: confirm your phone or email first to ask for a new time' using errcode = '42501';
  end if;
  update pm.work_orders set customer_confirmation = case when v_resp = 'CONFIRM' then 'CONFIRMED' else 'RESCHEDULE_REQUESTED' end, customer_confirmed_at = now()
   where id = w.id;
  update pm.fs_appointment_reminders set awaiting_reply = false, reply_intent = v_resp, replied_at = now() where org_id = p_org and work_order_id = w.id and awaiting_reply;
  select j.customer_id into v_cust from core.jobs j where j.id = w.job_id;
  if v_cust is not null then
    v_thread := pm._fs_thread_for(p_org, w.location_id, v_cust, w.job_id, g.contact_id, w.id);
    insert into pm.fs_thread_messages (org_id, location_id, thread_id, job_id, direction, channel, body, contact_id, status, intent, author_name)
    values (p_org, w.location_id, v_thread, w.job_id, 'IN', 'PORTAL',
            left(case when v_resp = 'CONFIRM' then 'Confirmed the visit in the portal.' else 'Asked for a new time in the portal.' end
                 || coalesce(' ' || nullif(btrim(p_note), ''), ''), 4000), g.contact_id, 'RECEIVED', v_resp, g.display_name);
    update pm.fs_threads set last_message_at = now(), last_direction = 'IN', unread_count = unread_count + 1 where id = v_thread;
  end if;
  perform portal._log(p_org, w.location_id, w.job_id, g, 'fs_visit.' || lower(v_resp), 'work_orders', w.id, jsonb_build_object('response', v_resp), null, p_ip, p_user_agent);
  perform portal._notify_team(p_org, w.job_id, left(format('%s %s %s', g.display_name, case when v_resp = 'CONFIRM' then 'confirmed' else 'asked to reschedule' end, w.number), 200),
                              '/dispatch', format('fs_conf:%s:%s', w.id, v_resp));
  return jsonb_build_object('status', case when v_resp = 'CONFIRM' then 'confirmed' else 'reschedule_requested' end);
end $$;

-- ----------------------------------------------------------------------------
-- 11. Install projects (FS-79 … FS-86) and purchasing / will-call (FS-90)
-- ----------------------------------------------------------------------------
insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
  ('install.contract_needed', 'Install waiting for its contract value', 'A sold install project needs someone with financials edit to set the contract value.', 'work', 'internal', null, true, 0, 'attention', false, 135)
on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
  audience = excluded.audience, mandatory = excluded.mandatory, severity = excluded.severity, sort = excluded.sort;
alter table pm.fs_install_projects add column if not exists billing_request_ids uuid[] not null default '{}';
alter table pm.fs_install_projects add column if not exists deposit_request_ids uuid[] not null default '{}';
alter table pm.fs_install_projects add column if not exists final_billing_request_id uuid;

-- Signed proposal → install project (FS-80). Called by the estimate trigger (equipment sold) and by
-- the office (pm.fs_handoff_install). Nothing is re-keyed: items, scope, hours, photos, notes.
create or replace function pm._fs_handoff_install(p_estimate uuid, p_force boolean default false) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  e pm.fs_estimates%rowtype; w pm.work_orders%rowtype; v_id uuid; v_total bigint; v_cost bigint; v_hours numeric; v_days int;
  v_scope text; v_brief text; v_wo uuid; v_bu uuid; v_note text; v_photos uuid[]; v_permit boolean; v_n int;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate;
  if e.id is null or e.status <> 'SOLD' then return null; end if;
  select p.id into v_id from pm.fs_install_projects p where p.org_id = e.org_id and p.estimate_id = e.id and p.stage <> 'CANCELLED';
  if v_id is not null then return v_id; end if;
  select count(*) into v_n from pm.fs_estimate_option_items i
   where i.org_id = e.org_id and i.option_id = any (e.sold_option_ids) and i.is_selected and i.kind = 'EQUIPMENT';
  if v_n = 0 and not p_force then return null; end if;
  select * into w from pm.work_orders x where x.org_id = e.org_id and x.id = e.work_order_id;
  select coalesce(sum(round(i.qty * case when e.member_pricing then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end)), 0)::bigint,
         coalesce(sum(round(i.qty * coalesce(i.unit_cost_cents, 0))), 0)::bigint,
         coalesce(sum(i.qty * coalesce(pb.task_hours, 0)) filter (where i.kind in ('SERVICE','LABOR')), 0)
    into v_total, v_cost, v_hours
    from pm.fs_estimate_option_items i left join pm.price_book_items pb on pb.id = i.price_book_item_id
   where i.org_id = e.org_id and i.option_id = any (e.sold_option_ids) and i.is_selected;
  v_days := greatest(1, ceil(coalesce(v_hours, 0) / 16.0)::int);
  select string_agg(o.name || coalesce(': ' || o.description, ''), E'\n' order by o.sort) into v_scope
    from pm.fs_estimate_options o where o.org_id = e.org_id and o.id = any (e.sold_option_ids);
  select string_agg(n.recommendations, E'\n' order by n.created_at) into v_note
    from pm.fs_visit_notes n where n.org_id = e.org_id and n.work_order_id = e.work_order_id and n.recommendations is not null;
  v_brief := concat_ws(E'\n\n', 'Sold: ' || e.title, 'Scope: ' || v_scope, case when v_note is not null then 'From the sales visit: ' || v_note end,
                       case when w.cause is not null then 'Diagnosis: ' || w.cause end);
  select coalesce(array_agg(dl.document_id), '{}') into v_photos from pm.document_links dl where dl.org_id = e.org_id and dl.job_id = e.job_id;
  select bu.id into v_bu from pm.business_units bu where bu.org_id = e.org_id and bu.location_id = e.location_id and bu.kind = 'INSTALL'
   order by bu.code limit 1;
  v_permit := exists (select 1 from pm.fs_permit_templates t where t.org_id = e.org_id and t.location_id = e.location_id and t.is_default and t.is_active);
  insert into pm.fs_install_projects (org_id, location_id, job_id, title, estimate_id, customer_id, site_id, est_hours, install_days, scope, brief,
                                      site_photo_ids, permit_required, contract_cents, est_cost_cents, sold_by_employee_id)
  values (e.org_id, e.location_id, e.job_id, left(e.title, 200), e.id, e.customer_id, w.site_id, v_hours, v_days, left(v_scope, 8000), left(v_brief, 8000),
          v_photos, v_permit, v_total, v_cost, e.sold_by_employee_id)
  returning id into v_id;
  insert into pm.fs_install_items (org_id, location_id, job_id, project_id, sort, kind, description, qty, unit_price_cents, unit_cost_cents,
                                   price_book_item_id, option_item_id)
  select e.org_id, e.location_id, e.job_id, v_id, row_number() over (order by i.option_id, i.sort), i.kind, i.description, i.qty,
         case when e.member_pricing then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end, i.unit_cost_cents,
         i.price_book_item_id, i.id
    from pm.fs_estimate_option_items i
   where i.org_id = e.org_id and i.option_id = any (e.sold_option_ids) and i.is_selected;
  insert into pm.work_orders (org_id, location_id, job_id, kind, status, priority, summary, description, site_id, business_unit_id, estimated_minutes)
  values (e.org_id, e.location_id, e.job_id, 'INSTALL', 'NEW', 3, left('Install: ' || e.title, 200), left(v_brief, 4000), w.site_id,
          coalesce(v_bu, w.business_unit_id), greatest(60, round(coalesce(v_hours, 8) * 60)::int))
  returning id into v_wo;
  update pm.fs_install_projects set install_work_order_id = v_wo where id = v_id;
  -- contract value (JOB_PROGRESS CONTRACT_SET) only when the job has no contract yet AND the caller
  -- may set it (security review round 2): pm.set_contract is guarded by projects.financials:edit and
  -- runs nested here (a technician's phone sale reaches this through the estimate trigger), so the
  -- right is checked explicitly. Otherwise the office is told the sold total awaits a contract.
  if pm.primary_contract_id(e.org_id, e.job_id) is null and v_total > 0
     and not (pm.access_is_service() or pm.access_can_job('projects.financials', 'edit', e.job_id)) then
    update pm.fs_install_projects set contract_note = 'Sold total awaiting the office to set the contract value' where id = v_id;
    begin
      perform core.notify_fanout(e.org_id, 'install.contract_needed', e.location_id, e.job_id, 'fs_install_projects', v_id, null,
                                 core.notify_members_with(e.org_id, e.location_id, 'projects.financials', 'edit'),
                                 left(format('Set the contract value for %s', coalesce(e.number, e.title)), 200),
                                 'A sold install is waiting for its contract value.', null, null, '/installs', format('fs_contract:%s', v_id));
    exception when others then
      raise warning '[1123] contract notice not sent: %', sqlerrm;
    end;
  elsif pm.primary_contract_id(e.org_id, e.job_id) is null and v_total > 0 then
    begin
      perform pm.set_contract(e.job_id, v_total);
    exception when others then
      update pm.fs_install_projects set contract_note = left('Contract value not set: ' || sqlerrm, 500) where id = v_id;
    end;
  else
    update pm.fs_install_projects set contract_note = 'The job already had a contract; check that it matches the sold total.' where id = v_id;
  end if;
  update pm.fs_opportunities set install_project_id = v_id where org_id = e.org_id and estimate_id = e.id;
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'fs_install.created', 'fs_install_projects', v_id,
    format('Install project from %s', coalesce(e.number, e.title)), jsonb_build_object('estimate_id', e.id, 'install_work_order_id', v_wo));
  return v_id;
end $$;

create or replace function pm.fs_handoff_install(p_estimate uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = public.get_org_id();
  if e.id is null then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if e.status <> 'SOLD' then raise exception 'PM_INVALID: only a signed estimate becomes an install project' using errcode = '22023'; end if;
  return pm._fs_handoff_install(e.id, true);
end $$;

-- Stage board moves with the gates that matter (FS-79 / FS-75 / FS-86).
create or replace function pm.fs_set_install_stage(p_project uuid, p_stage text, p_note text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_stage text := upper(coalesce(p_stage, '')); v_serial text;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if v_stage not in ('SOLD','ORDERED','PERMITTED','SCHEDULED','INSTALLED','INSPECTED','CLOSED','CANCELLED') then
    raise exception 'PM_INVALID: unknown stage' using errcode = '22023';
  end if;
  if p.stage in ('CLOSED','CANCELLED') then raise exception 'PM_INVALID: this install is already %', lower(p.stage) using errcode = '22023'; end if;
  if v_stage = 'CANCELLED' and char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'PM_INVALID: say why the install is cancelled' using errcode = '22023'; end if;
  if v_stage = 'CLOSED' then
    if exists (select 1 from pm.fs_install_items i where i.org_id = p.org_id and i.project_id = p.id and i.kind = 'EQUIPMENT')
       and not exists (select 1 from pm.fs_form_submissions s where s.org_id = p.org_id and s.work_order_id = p.install_work_order_id and s.template_kind = 'COMMISSIONING') then
      raise exception 'PM_FS_INSTALL_GATE: submit the commissioning checklist and walkthrough before closing' using errcode = '22023';
    end if;
    select coalesce(a.serial_number, a.model, 'equipment') into v_serial from pm.assets a
     where a.org_id = p.org_id and a.install_work_order_id = p.install_work_order_id and a.registration_status = 'PENDING' limit 1;
    if v_serial is not null then
      raise exception 'PM_FS_INSTALL_GATE: register % with the manufacturer before closing', v_serial using errcode = '22023';
    end if;
    if p.contract_cents > 0 and p.final_billing_request_id is null
       and not exists (select 1 from pm.fs_financed_sales f where f.org_id = p.org_id and f.estimate_id = p.estimate_id and f.status = 'FUNDED'
                        and f.amount_financed_cents >= p.contract_cents) then
      raise exception 'PM_FS_INSTALL_GATE: request the final invoice (or record the financing funding) before closing' using errcode = '22023';
    end if;
  end if;
  update pm.fs_install_projects set stage = v_stage, stage_changed_at = now(),
         closed_at = case when v_stage = 'CLOSED' then now() else closed_at end,
         cancel_reason = case when v_stage = 'CANCELLED' then left(btrim(p_note), 500) else cancel_reason end
   where id = p.id;
  if v_stage = 'CANCELLED' then
    update pm.fs_install_crew_days set status = 'CANCELLED' where org_id = p.org_id and project_id = p.id and status = 'PLANNED';
  end if;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'fs_install.stage', 'fs_install_projects', p.id,
    format('%s: %s → %s', p.number, lower(p.stage), lower(v_stage)), jsonb_build_object('from', p.stage, 'to', v_stage, 'note', p_note));
  return jsonb_build_object('id', p.id, 'stage', v_stage);
end $$;

-- Equipment PO from the sold option (FS-81). Approval stays in the 1113 engine (commitment).
create or replace function pm.fs_install_po(p_project uuid, p_vendor uuid, p_fulfillment text default 'DELIVERY', p_expected_on date default null,
                                            p_item_ids uuid[] default null, p_title text default null, p_note text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_c uuid; v_cc uuid; it record; n int := 0; v_line uuid; v_ful text := upper(coalesce(p_fulfillment, 'DELIVERY'));
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if p.stage in ('CLOSED','CANCELLED') then raise exception 'PM_INVALID: this install is %', lower(p.stage) using errcode = '22023'; end if;
  if v_ful not in ('WILL_CALL','DELIVERY') then raise exception 'PM_INVALID: will-call or delivery' using errcode = '22023'; end if;
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = p.org_id) then raise exception 'PM_INVALID: pick the distributor' using errcode = '22023'; end if;
  select c.id into v_cc from pm.cost_codes c where c.org_id = p.org_id and c.location_id = p.location_id
   order by (c.cost_type = 'EQUIPMENT') desc, (c.cost_type = 'MATERIALS') desc, c.code limit 1;
  insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, description, status, retainage_pct)
  values (p.org_id, p.location_id, p.job_id, p_vendor, 'PO', left(coalesce(nullif(btrim(p_title), ''), 'Equipment — ' || p.title), 200),
          left(p_note, 2000), 'DRAFT', 0)
  returning id into v_c;
  for it in select i.* from pm.fs_install_items i
             where i.org_id = p.org_id and i.project_id = p.id and i.commitment_line_id is null and i.kind in ('EQUIPMENT','PART')
               and (p_item_ids is null or i.id = any (p_item_ids))
             order by i.sort loop
    n := n + 1;
    insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, unit_cost_cents, amount_cents)
    values (p.org_id, v_c, n, v_cc, case when it.kind = 'EQUIPMENT' then 'EQUIPMENT' else 'MATERIALS' end, it.description, it.qty, 'EA',
            coalesce(it.unit_cost_cents, 0), round(it.qty * coalesce(it.unit_cost_cents, 0))::bigint)
    returning id into v_line;
    update pm.fs_install_items set commitment_line_id = v_line where id = it.id;
  end loop;
  if n = 0 then raise exception 'PM_INVALID: every item on this install is already on a PO' using errcode = '22023'; end if;
  insert into pm.fs_po_details (commitment_id, org_id, location_id, job_id, project_id, fulfillment, expected_on, pickup_code, supply_house_note)
  values (v_c, p.org_id, p.location_id, p.job_id, p.id, v_ful, p_expected_on,
          case when v_ful = 'WILL_CALL' then lpad((floor(random() * 1000000))::int::text, 6, '0') end, left(p_note, 500));
  if p.stage = 'SOLD' then update pm.fs_install_projects set stage = 'ORDERED', stage_changed_at = now() where id = p.id; end if;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'fs_install.po', 'commitments', v_c,
    format('%s: equipment PO drafted (%s line(s), %s)', p.number, n, lower(replace(v_ful, '_', '-'))), jsonb_build_object('project_id', p.id));
  return v_c;
end $$;

-- Receive a PO (office) or pick it up at the supply-house counter (tech, with the pickup code) —
-- receipts through pm.record_receipt (received-not-invoiced in Books), serials captured (FS-81/90/93).
create or replace function pm.fs_receive_po(p_commitment uuid, p_lines jsonb, p_pickup_code text default null, p_received_on date default null,
                                            p_command uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  c pm.commitments%rowtype; d pm.fs_po_details%rowtype; ln jsonb; l pm.commitment_lines%rowtype; v_r uuid; v_rs uuid[] := '{}'; v_n int := 0;
  sn text; v_item uuid; v_seen jsonb; v_res jsonb; v_qty numeric; v_full boolean;
begin
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: purchase order not found' using errcode = '42501'; end if;
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(c.org_id, p_command, 'fs.po.receive');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  select * into d from pm.fs_po_details x where x.commitment_id = c.id;
  if p_pickup_code is not null and (d.commitment_id is null or d.pickup_code is distinct from btrim(p_pickup_code)) then
    raise exception 'PM_FS_PICKUP_CODE: that pickup code does not match this PO' using errcode = '22023';
  end if;
  if c.status not in ('APPROVED','EXECUTED') then
    raise exception 'PM_FS_PO_NOT_APPROVED: % has to be approved before it is received', c.number using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: say what was received' using errcode = '22023';
  end if;
  -- record_receipt is guarded by projects.commitments:edit; nested its guard is skipped (audit). A
  -- technician with only the pickup code may pick up a WILL_CALL order once, today, no more than ordered.
  v_full := pm.access_can_row('projects.commitments', 'edit', 'commitments', c.id);
  if not v_full then
    if p_pickup_code is null or d.fulfillment is distinct from 'WILL_CALL' then
      raise exception 'PM_FORBIDDEN: receiving requires projects.commitments:edit, or the pickup code on a will-call order' using errcode = '42501';
    end if;
    if d.picked_up_at is not null then raise exception 'PM_INVALID: % was already picked up', c.number using errcode = '22023'; end if;
  end if;
  for ln in select x from jsonb_array_elements(p_lines) x loop
    select * into l from pm.commitment_lines x where x.id = (ln ->> 'line_id')::uuid and x.org_id = c.org_id and x.commitment_id = c.id;
    if l.id is null then raise exception 'PM_INVALID: a line is not on %', c.number using errcode = '22023'; end if;
    v_qty := coalesce((ln ->> 'qty')::numeric, l.qty, 1);
    if v_qty <= 0 then raise exception 'PM_INVALID: quantity must be more than zero' using errcode = '22023'; end if;
    if not v_full and l.qty is not null and l.received_qty + v_qty > l.qty then
      raise exception 'PM_INVALID: that is more than was ordered on %', c.number using errcode = '22023';
    end if;
    v_r := pm.record_receipt(l.id, v_qty, case when v_full then coalesce(p_received_on, current_date) else current_date end,
                             case when p_pickup_code is not null then 'Will-call pickup' else 'Received' end, null, null, null);
    v_rs := v_rs || v_r;
    select i.id into v_item from pm.fs_install_items i where i.org_id = c.org_id and i.commitment_line_id = l.id;
    if v_item is not null then update pm.fs_install_items set received_qty = received_qty + v_qty where id = v_item; end if;
    for sn in select jsonb_array_elements_text(coalesce(ln -> 'serials', '[]'::jsonb)) loop
      continue when nullif(btrim(sn), '') is null;
      insert into pm.fs_serial_units (org_id, location_id, job_id, project_id, commitment_line_id, install_item_id, serial, make, model, status,
                                      stock_location_id)
      values (c.org_id, c.location_id, c.job_id, d.project_id, l.id, v_item, left(btrim(sn), 80), nullif(btrim(coalesce(ln ->> 'make', '')), ''),
              nullif(btrim(coalesce(ln ->> 'model', '')), ''), case when p_pickup_code is not null then 'ON_TRUCK' else 'RECEIVED' end,
              coalesce(d.to_stock_location_id, case when v_full then nullif(ln ->> 'stock_location_id', '')::uuid end))
      on conflict do nothing;
      v_n := v_n + 1;
    end loop;
  end loop;
  if p_pickup_code is not null then
    update pm.fs_po_details set picked_up_at = now(), picked_up_by = pm.current_user_id() where commitment_id = c.id;
  end if;
  v_res := jsonb_build_object('receipts', to_jsonb(v_rs), 'serials', v_n, 'commitment_id', c.id);
  return pm._fs_cmd_done(c.org_id, p_command, 'fs.po.receive', c.id, v_res);
end $$;

-- The will-call POs waiting for the signed-in tech (jobs they are on). No money.
create or replace function pm.fs_my_will_calls() returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'commitment_id', c.id, 'number', c.number, 'title', c.title, 'status', c.status, 'job_id', c.job_id,
             'vendor', (select v.name from core.vendors v where v.id = c.vendor_id), 'pickup_code', d.pickup_code, 'expected_on', d.expected_on,
             'note', d.supply_house_note, 'ready', c.status in ('APPROVED','EXECUTED'),
             'lines', coalesce((select jsonb_agg(jsonb_build_object('line_id', l.id, 'description', l.description, 'qty', l.qty, 'received_qty', l.received_qty)
                                                 order by l.line_no) from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id), '[]'::jsonb))
           order by d.expected_on nulls last, c.number)
      from pm.fs_po_details d join pm.commitments c on c.org_id = d.org_id and c.id = d.commitment_id
     where d.org_id = v_org and d.fulfillment = 'WILL_CALL' and d.picked_up_at is null and c.status not in ('VOID','CLOSED')
       and d.job_id in (select pm.my_job_ids())), '[]'::jsonb);
end $$;

-- Permits and inspections (FS-82): jurisdiction template → pm.res_permits + pm.res_inspections (1119).
create or replace function pm.fs_apply_permit(p_project uuid, p_template uuid default null, p_number text default null, p_applied_on date default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; t pm.fs_permit_templates%rowtype; v_id uuid; k text;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  select * into t from pm.fs_permit_templates x
   where x.org_id = p.org_id and x.location_id = p.location_id and x.is_active and (p_template is null or x.id = p_template)
   order by (x.id = p_template) desc nulls last, x.is_default desc, x.created_at limit 1;
  if t.id is null then raise exception 'PM_INVALID: add a permit template for this jurisdiction first' using errcode = '22023'; end if;
  insert into pm.res_permits (org_id, job_id, kind, number, authority, status, applied_on, fee_cents, notes)
  values (p.org_id, p.job_id, t.permit_kind, left(nullif(btrim(coalesce(p_number, '')), ''), 60), t.jurisdiction,
          case when p_applied_on is not null or nullif(btrim(coalesce(p_number, '')), '') is not null then 'APPLIED' else 'NOT_STARTED' end,
          p_applied_on, t.fee_cents, left(format('%s (%s)', p.number, t.jurisdiction), 2000))
  returning id into v_id;
  foreach k in array t.inspections loop
    insert into pm.res_inspections (org_id, job_id, permit_id, kind, requested_on)
    values (p.org_id, p.job_id, v_id, case when k in ('FOOTING','FOUNDATION','FRAMING','MEP_ROUGH','INSULATION','DRYWALL','FINAL') then k else 'OTHER' end, current_date);
  end loop;
  update pm.fs_install_projects set permit_required = true where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'fs_install.permit', 'res_permits', v_id,
    format('%s: %s permit (%s)', p.number, lower(t.permit_kind), t.jurisdiction), jsonb_build_object('template_id', t.id));
  return v_id;
end $$;

create or replace function pm.fs_update_permit(p_permit uuid, p_status text, p_number text default null, p_on date default null,
                                               p_document uuid default null, p_fee_cents bigint default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.res_permits%rowtype; v_status text := upper(coalesce(p_status, '')); p pm.fs_install_projects%rowtype;
begin
  select * into r from pm.res_permits x where x.id = p_permit and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: permit not found' using errcode = '42501'; end if;
  if v_status not in ('NOT_STARTED','APPLIED','ISSUED','APPROVED','DENIED','EXPIRED','CLOSED') then raise exception 'PM_INVALID: unknown permit status' using errcode = '22023'; end if;
  update pm.res_permits set status = v_status, number = coalesce(left(nullif(btrim(coalesce(p_number, '')), ''), 60), number),
         applied_on = case when v_status = 'APPLIED' then coalesce(p_on, applied_on, current_date) else applied_on end,
         issued_on = case when v_status in ('ISSUED','APPROVED') then coalesce(p_on, issued_on, current_date) else issued_on end,
         document_id = coalesce(p_document, document_id), fee_cents = coalesce(p_fee_cents, fee_cents)
   where id = r.id;
  if v_status in ('ISSUED','APPROVED') then
    select * into p from pm.fs_install_projects x where x.org_id = r.org_id and x.job_id = r.job_id and x.stage in ('SOLD','ORDERED') limit 1;
    if p.id is not null then update pm.fs_install_projects set stage = 'PERMITTED', stage_changed_at = now() where id = p.id; end if;
  end if;
  return jsonb_build_object('id', r.id, 'status', v_status);
end $$;

-- Install crew capacity (crew-days per week): a dated row wins over the default row; none = 10.
create or replace function pm._fs_install_week_capacity(p_org uuid, p_location uuid, p_week date) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(
    (select c.crew_days from pm.fs_install_capacity c where c.org_id = p_org and c.location_id = p_location and c.week_start = p_week),
    (select c.crew_days from pm.fs_install_capacity c where c.org_id = p_org and c.location_id = p_location and c.week_start is null),
    10)
$$;

create or replace function pm._fs_install_week_booked(p_org uuid, p_location uuid, p_week date, p_except uuid default null) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select count(*)::int from pm.fs_install_crew_days d
   where d.org_id = p_org and d.location_id = p_location and d.status <> 'CANCELLED'
     and d.work_date >= p_week and d.work_date < p_week + 7 and (p_except is null or d.project_id <> p_except)
$$;

-- Readiness of an install: what still blocks the crew (equipment, permit).
create or replace function pm._fs_install_readiness(p_project uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v jsonb := '[]'; v_open int; v_unordered int; v_exp date;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project;
  select count(*) filter (where i.received_qty < i.qty), count(*) filter (where i.commitment_line_id is null)
    into v_open, v_unordered from pm.fs_install_items i where i.org_id = p.org_id and i.project_id = p.id and i.kind = 'EQUIPMENT';
  select max(d.expected_on) into v_exp from pm.fs_po_details d where d.org_id = p.org_id and d.project_id = p.id;
  if v_unordered > 0 then v := v || jsonb_build_object('code', 'EQUIPMENT_NOT_ORDERED', 'message', format('%s equipment line(s) are not on a PO yet', v_unordered)); end if;
  if v_open > 0 and v_unordered = 0 then
    v := v || jsonb_build_object('code', 'EQUIPMENT_NOT_RECEIVED', 'message',
      format('%s equipment line(s) not received yet%s', v_open, coalesce(' — expected ' || to_char(v_exp, 'Mon FMDD'), '')));
  end if;
  if p.permit_required and not exists (select 1 from pm.res_permits r where r.org_id = p.org_id and r.job_id = p.job_id and r.status in ('ISSUED','APPROVED')) then
    v := v || jsonb_build_object('code', 'PERMIT_NOT_ISSUED', 'message', 'The permit is not issued yet');
  end if;
  return v;
end $$;

-- Earliest install date given equipment, permit and crew capacity (FS-83).
create or replace function pm.fs_install_earliest(p_project uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_day date := current_date + 1; v_exp date; v_lead int; v_applied date; v_reasons jsonb := '[]'; v_week date; i int := 0;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id();
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if exists (select 1 from pm.fs_install_items it where it.org_id = p.org_id and it.project_id = p.id and it.kind = 'EQUIPMENT' and it.commitment_line_id is null) then
    v_day := greatest(v_day, current_date + 7);
    v_reasons := v_reasons || to_jsonb('Equipment is not ordered yet (allow about a week)'::text);
  else
    select max(d.expected_on) into v_exp from pm.fs_po_details d where d.org_id = p.org_id and d.project_id = p.id;
    if v_exp is not null and exists (select 1 from pm.fs_install_items it where it.org_id = p.org_id and it.project_id = p.id and it.kind = 'EQUIPMENT' and it.received_qty < it.qty) then
      v_day := greatest(v_day, v_exp + 1);
      v_reasons := v_reasons || to_jsonb(format('Equipment arrives %s', to_char(v_exp, 'Mon FMDD')));
    end if;
  end if;
  if p.permit_required and not exists (select 1 from pm.res_permits r where r.org_id = p.org_id and r.job_id = p.job_id and r.status in ('ISSUED','APPROVED')) then
    select t.lead_days into v_lead from pm.fs_permit_templates t where t.org_id = p.org_id and t.location_id = p.location_id and t.is_active order by t.is_default desc limit 1;
    select min(r.applied_on) into v_applied from pm.res_permits r where r.org_id = p.org_id and r.job_id = p.job_id;
    v_day := greatest(v_day, coalesce(v_applied, current_date) + coalesce(v_lead, 5));
    v_reasons := v_reasons || to_jsonb(format('Permit takes about %s days', coalesce(v_lead, 5)));
  end if;
  loop
    i := i + 1;
    exit when i > 120;
    if extract(isodow from v_day) in (6, 7) then v_day := v_day + 1; continue; end if;
    v_week := v_day - (extract(isodow from v_day)::int - 1);
    exit when pm._fs_install_week_booked(p.org_id, p.location_id, v_week, p.id) + 1 <= pm._fs_install_week_capacity(p.org_id, p.location_id, v_week);
    v_day := v_week + 7;
    if i = 1 or jsonb_array_length(v_reasons) = 0 or v_reasons ->> (jsonb_array_length(v_reasons) - 1) not like 'Crew%' then
      v_reasons := v_reasons || to_jsonb('Crew capacity is full that week'::text);
    end if;
  end loop;
  return jsonb_build_object('date', v_day, 'reasons', v_reasons, 'readiness', pm._fs_install_readiness(p.id));
end $$;

-- Book install-days for a crew lead and helpers (FS-83): weekly crew-day capacity, a dispatch on the
-- install visit per person per day (the phone shows it), readiness warnings.
create or replace function pm.fs_schedule_install(p_project uuid, p_start date, p_days int default null, p_crew uuid default null,
                                                  p_lead uuid default null, p_helpers uuid[] default '{}', p_override_reason text default null,
                                                  p_hours numeric default 8) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  p pm.fs_install_projects%rowtype; v_days int; v_dates date[] := '{}'; d date := p_start; v_week date; v_need int; v_cap int; v_booked int;
  v_tz text; v_emp uuid; v_people uuid[]; v_start timestamptz; i int := 0;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if p.stage in ('CLOSED','CANCELLED','INSTALLED','INSPECTED') then raise exception 'PM_INVALID: this install is %', lower(p.stage) using errcode = '22023'; end if;
  if p_start is null or p_start < current_date then raise exception 'PM_INVALID: pick a start date from today on' using errcode = '22023'; end if;
  if p_lead is null and p_crew is null then raise exception 'PM_INVALID: pick the crew lead' using errcode = '22023'; end if;
  v_days := coalesce(p_days, p.install_days);
  if v_days not between 1 and 60 then raise exception 'PM_INVALID: 1 to 60 install days' using errcode = '22023'; end if;
  while cardinality(v_dates) < v_days and i < 200 loop
    i := i + 1;
    if extract(isodow from d) not in (6, 7) then v_dates := v_dates || d; end if;
    d := d + 1;
  end loop;
  -- capacity per week (crew-days)
  for v_week in select distinct x - (extract(isodow from x)::int - 1) from unnest(v_dates) x loop
    v_need := (select count(*) from unnest(v_dates) x where x >= v_week and x < v_week + 7);
    v_cap := pm._fs_install_week_capacity(p.org_id, p.location_id, v_week);
    v_booked := pm._fs_install_week_booked(p.org_id, p.location_id, v_week, p.id);
    if v_booked + v_need > v_cap and char_length(btrim(coalesce(p_override_reason, ''))) < 5 then
      raise exception 'PM_FS_INSTALL_CAPACITY: the week of % is full (% of % crew-days booked)', to_char(v_week, 'Mon FMDD'), v_booked, v_cap using errcode = '53400';
    end if;
  end loop;
  select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = p.org_id and s.location_id = p.location_id;
  v_tz := coalesce(v_tz, 'America/Chicago');
  -- a reschedule replaces the planned days and their future dispatches
  update pm.fs_install_crew_days set status = 'CANCELLED' where org_id = p.org_id and project_id = p.id and status = 'PLANNED';
  update pm.dispatch_assignments set status = 'CANCELLED', cancelled_at = now()
   where org_id = p.org_id and work_order_id = p.install_work_order_id and status in ('ASSIGNED','DISPATCHED') and lower(slot) >= now();
  v_people := array_remove(array[p_lead] || coalesce(p_helpers, '{}'), null);
  foreach d in array v_dates loop
    insert into pm.fs_install_crew_days (org_id, location_id, job_id, project_id, work_date, crew_id, lead_employee_id, helper_employee_ids, hours)
    values (p.org_id, p.location_id, p.job_id, p.id, d, p_crew, p_lead, coalesce(p_helpers, '{}'), coalesce(p_hours, 8));
    v_start := (d + time '08:00') at time zone v_tz;
    if p.install_work_order_id is not null then
      if cardinality(v_people) = 0 then
        insert into pm.dispatch_assignments (org_id, job_id, work_order_id, crew_id, slot, status, is_lead, assigned_by)
        values (p.org_id, p.job_id, p.install_work_order_id, p_crew, tstzrange(v_start, v_start + make_interval(mins => round(coalesce(p_hours, 8) * 60)::int)),
                'ASSIGNED', true, pm.current_user_id());
      else
        foreach v_emp in array v_people loop
          begin
            insert into pm.dispatch_assignments (org_id, job_id, work_order_id, employee_id, slot, status, is_lead, assigned_by)
            values (p.org_id, p.job_id, p.install_work_order_id, v_emp, tstzrange(v_start, v_start + make_interval(mins => round(coalesce(p_hours, 8) * 60)::int)),
                    'ASSIGNED', v_emp = p_lead, pm.current_user_id());
          exception when exclusion_violation then
            raise exception 'PM_FS_TECH_UNAVAILABLE: % is already booked on %', coalesce((select e.first_name from core.employees e where e.id = v_emp), 'a crew member'),
              to_char(d, 'Dy Mon FMDD') using errcode = '23P01';
          end;
        end loop;
      end if;
    end if;
  end loop;
  update pm.fs_install_projects set stage = case when stage in ('SOLD','ORDERED','PERMITTED') then 'SCHEDULED' else stage end,
         stage_changed_at = case when stage in ('SOLD','ORDERED','PERMITTED') then now() else stage_changed_at end,
         install_days = v_days
   where id = p.id;
  update pm.work_orders set status = case when status = 'NEW' then 'SCHEDULED' else status end where org_id = p.org_id and id = p.install_work_order_id;
  return jsonb_build_object('project_id', p.id, 'dates', to_jsonb(v_dates), 'readiness', pm._fs_install_readiness(p.id),
                            'override', char_length(btrim(coalesce(p_override_reason, ''))) >= 5);
end $$;

-- Commissioning + walkthrough → equipment records with warranty and registration deadlines (FS-84 / FS-75).
create or replace function pm.fs_commission_install(p_project uuid, p_submission uuid, p_equipment jsonb, p_walkthrough_name text,
                                                    p_command uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  p pm.fs_install_projects%rowtype; s pm.fs_form_submissions%rowtype; q jsonb; v_asset uuid; v_assets uuid[] := '{}'; v_site core.sites%rowtype;
  v_installer uuid; v_seen jsonb; v_res jsonb;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(p.org_id, p_command, 'fs.install.commission');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  if p.stage in ('CLOSED','CANCELLED') then raise exception 'PM_INVALID: this install is %', lower(p.stage) using errcode = '22023'; end if;
  select * into s from pm.fs_form_submissions x where x.id = p_submission and x.org_id = p.org_id;
  if s.id is null or s.work_order_id is distinct from p.install_work_order_id or s.template_kind <> 'COMMISSIONING' then
    raise exception 'PM_INVALID: attach the commissioning checklist submitted on this install' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_walkthrough_name, s.signed_name, ''))) < 2 then
    raise exception 'PM_FS_FORM_SIGNATURE: the customer signs the walkthrough' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_equipment, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: equipment must be a list' using errcode = '22023'; end if;
  select * into v_site from core.sites x where x.id = p.site_id;
  select d.employee_id into v_installer from pm.dispatch_assignments d
   where d.org_id = p.org_id and d.work_order_id = p.install_work_order_id and d.status <> 'CANCELLED' and d.employee_id is not null
   order by d.is_lead desc, d.created_at limit 1;
  for q in select x from jsonb_array_elements(coalesce(p_equipment, '[]'::jsonb)) x loop
    if nullif(btrim(coalesce(q ->> 'serial', '')), '') is null or nullif(btrim(coalesce(q ->> 'make', '')), '') is null then
      raise exception 'PM_INVALID: every piece of equipment needs its make and serial number' using errcode = '22023';
    end if;
    insert into pm.assets (org_id, location_id, kind, customer_id, serial_number, make, model, description, equipment_type, tonnage, seer2, afue,
                           refrigerant_type, refrigerant_charge_oz, fuel_type, installed_on, installer_employee_id, install_work_order_id,
                           parts_warranty_ends_on, labor_warranty_ends_on, registration_status, registration_deadline, site_id,
                           site_address_line1, site_city, site_state, site_zip)
    values (p.org_id, p.location_id, 'CUSTOMER_EQUIPMENT', p.customer_id, left(btrim(q ->> 'serial'), 80), left(btrim(q ->> 'make'), 80),
            left(nullif(btrim(coalesce(q ->> 'model', '')), ''), 80), left(coalesce(q ->> 'description', q ->> 'equipment_type'), 300),
            nullif(q ->> 'equipment_type', ''), nullif(q ->> 'tonnage', '')::numeric, nullif(q ->> 'seer2', '')::numeric, nullif(q ->> 'afue', '')::numeric,
            nullif(q ->> 'refrigerant_type', ''), nullif(q ->> 'refrigerant_charge_oz', '')::numeric, nullif(q ->> 'fuel_type', ''),
            current_date, v_installer, p.install_work_order_id,
            current_date + make_interval(years => coalesce((q ->> 'parts_warranty_years')::int, 10)),
            current_date + make_interval(years => coalesce((q ->> 'labor_warranty_years')::int, 1)),
            case when coalesce((q ->> 'registration_required')::boolean, true) then 'PENDING' else 'NOT_REQUIRED' end,
            case when coalesce((q ->> 'registration_required')::boolean, true) then current_date + coalesce((q ->> 'registration_days')::int, 60) end,
            p.site_id, v_site.address_line1, v_site.city, v_site.state, v_site.zip)
    returning id into v_asset;
    v_assets := v_assets || v_asset;
    update pm.fs_serial_units set status = 'INSTALLED', asset_id = v_asset, installed_at = now()
     where org_id = p.org_id and job_id = p.job_id and lower(btrim(serial)) = lower(btrim(q ->> 'serial'));
  end loop;
  if s.signed_name is null then
    update pm.fs_form_submissions set signed_name = left(btrim(p_walkthrough_name), 120), signed_at = now() where id = s.id;
  end if;
  update pm.fs_install_projects set stage = case when stage in ('SOLD','ORDERED','PERMITTED','SCHEDULED') then 'INSTALLED' else stage end,
         stage_changed_at = case when stage in ('SOLD','ORDERED','PERMITTED','SCHEDULED') then now() else stage_changed_at end
   where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'fs_install.commissioned', 'fs_install_projects', p.id,
    format('%s: commissioned, %s equipment record(s)', p.number, cardinality(v_assets)), jsonb_build_object('assets', to_jsonb(v_assets)));
  v_res := jsonb_build_object('assets', to_jsonb(v_assets), 'project_id', p.id);
  return pm._fs_cmd_done(p.org_id, p_command, 'fs.install.commission', p.id, v_res);
end $$;

-- Estimated vs actual (FS-85): estimate cost by category vs Books job cost (pending + cleared).
create or replace function pm.fs_install_costing(p_project uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_est jsonb; v_act jsonb; v_lines jsonb := '[]'; k text; v_e bigint; v_a bigint; v_te bigint := 0; v_ta bigint := 0;
  v_comm bigint; v_permit bigint; v_committed bigint; v_billed bigint; v_rates boolean;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id();
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  v_rates := pm.can('projects.labor_rates', 'view', p.location_id);
  select coalesce(sum(r.fee_cents), 0) into v_permit from pm.res_permits r where r.org_id = p.org_id and r.job_id = p.job_id;
  select round(p.contract_cents * pl.commission_pct)::bigint into v_comm
    from pm.fs_pay_assignments pa join pm.fs_pay_plans pl on pl.org_id = pa.org_id and pl.id = pa.pay_plan_id
   where pa.org_id = p.org_id and pa.location_id = p.location_id and pa.employee_id = p.sold_by_employee_id;
  select jsonb_build_object(
           'equipment', coalesce(sum(round(i.qty * coalesce(i.unit_cost_cents, 0))) filter (where i.kind = 'EQUIPMENT'), 0),
           'materials', coalesce(sum(round(i.qty * coalesce(i.unit_cost_cents, 0))) filter (where i.kind = 'PART'), 0),
           'labor', coalesce(sum(round(i.qty * coalesce(i.unit_cost_cents, 0))) filter (where i.kind in ('SERVICE','LABOR')), 0),
           'subs', 0, 'permits', v_permit, 'commissions', coalesce(v_comm, 0),
           'other', coalesce(sum(round(i.qty * coalesce(i.unit_cost_cents, 0))) filter (where i.kind in ('FEE','DISCOUNT')), 0))
    into v_est from pm.fs_install_items i where i.org_id = p.org_id and i.project_id = p.id;
  select jsonb_build_object(
           'equipment', coalesce(sum(c.amount_cents) filter (where c.cost_type = 'EQUIPMENT'), 0),
           'materials', coalesce(sum(c.amount_cents) filter (where c.cost_type = 'MATERIALS'), 0),
           'labor', coalesce(sum(c.amount_cents) filter (where c.cost_type = 'LABOR'), 0),
           'subs', coalesce(sum(c.amount_cents) filter (where c.cost_type = 'SUBCONTRACTOR'), 0),
           'permits', coalesce(sum(c.amount_cents) filter (where c.cost_type = 'OTHER' and coalesce(c.description, '') ~* 'permit'), 0),
           'commissions', 0,
           'other', coalesce(sum(c.amount_cents) filter (where (c.cost_type = 'OTHER' and coalesce(c.description, '') !~* 'permit') or c.cost_type is null), 0))
    into v_act from pm.job_costs c where c.org_id = p.org_id and c.job_id = p.job_id and c.lifecycle in ('PENDING','CLEARED');
  if not v_rates then v_est := v_est || jsonb_build_object('commissions', null); end if;
  foreach k in array array['equipment','materials','labor','subs','permits','commissions','other'] loop
    v_e := coalesce((v_est ->> k)::bigint, 0); v_a := coalesce((v_act ->> k)::bigint, 0);
    v_te := v_te + v_e; v_ta := v_ta + v_a;
    if abs(v_a - v_e) > greatest(10000, v_e / 20) and (k <> 'commissions') then
      v_lines := v_lines || jsonb_build_object('category', k, 'estimated_cents', v_e, 'actual_cents', v_a, 'variance_cents', v_a - v_e,
        'explanation', format('%s ran %s the estimate by $%s (actual $%s vs estimated $%s)', initcap(k), case when v_a > v_e then 'over' else 'under' end,
                              to_char(abs(v_a - v_e) / 100.0, 'FM999,999,990.00'), to_char(v_a / 100.0, 'FM999,999,990.00'), to_char(v_e / 100.0, 'FM999,999,990.00')));
    end if;
  end loop;
  select coalesce(sum(l.amount_cents), 0) into v_committed from pm.commitment_lines l join pm.commitments c on c.org_id = l.org_id and c.id = l.commitment_id
   where c.org_id = p.org_id and c.job_id = p.job_id and c.status in ('APPROVED','EXECUTED','CLOSED');
  select coalesce(sum(b.gross_earned_cents), 0) into v_billed from pm.billing_requests b
   where b.org_id = p.org_id and b.job_id = p.job_id and b.status not in ('VOID','REJECTED');
  return jsonb_build_object('project_id', p.id, 'contract_cents', p.contract_cents, 'estimated', v_est, 'actual', v_act,
    'estimated_total_cents', v_te, 'actual_total_cents', v_ta, 'committed_cents', v_committed, 'billed_cents', v_billed,
    'estimated_margin_cents', p.contract_cents - v_te, 'actual_margin_cents', p.contract_cents - v_ta,
    'estimated_margin_pct', case when p.contract_cents > 0 then round((p.contract_cents - v_te)::numeric / p.contract_cents, 4) end,
    'actual_margin_pct', case when p.contract_cents > 0 then round((p.contract_cents - v_ta)::numeric / p.contract_cents, 4) end,
    'variances', v_lines, 'complete', p.stage in ('INSTALLED','INSPECTED','CLOSED'));
end $$;

-- SOV for light-commercial installs (pm.sov_versions / pm.sov_lines; activated through 1102).
create or replace function pm.fs_install_setup_sov(p_project uuid, p_lines jsonb, p_retainage_pct numeric default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_sov uuid; q jsonb; n int := 0; v_ver int;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: add the schedule-of-values lines' using errcode = '22023';
  end if;
  select coalesce(max(v.version), 0) + 1 into v_ver from pm.sov_versions v where v.org_id = p.org_id and v.job_id = p.job_id;
  insert into pm.sov_versions (org_id, job_id, contract_id, version, status, retainage_pct, memo)
  values (p.org_id, p.job_id, pm.primary_contract_id(p.org_id, p.job_id), v_ver, 'DRAFT', p_retainage_pct, format('Install %s', p.number))
  returning id into v_sov;
  for q in select x from jsonb_array_elements(p_lines) x loop
    n := n + 1;
    if nullif(btrim(coalesce(q ->> 'description', '')), '') is null or coalesce((q ->> 'scheduled_value_cents')::bigint, -1) < 0 then
      raise exception 'PM_INVALID: each line needs a description and a value' using errcode = '22023';
    end if;
    insert into pm.sov_lines (org_id, sov_version_id, line_no, description, scheduled_value_cents, sort)
    values (p.org_id, v_sov, n, left(btrim(q ->> 'description'), 300), (q ->> 'scheduled_value_cents')::bigint, n);
  end loop;
  -- activate_sov_version is guarded by projects.billing:edit; nested its guard is skipped (audit)
  if not pm.access_can_job('projects.billing', 'edit', p.job_id) then
    raise exception 'PM_FORBIDDEN: activating a schedule of values requires projects.billing:edit on this job' using errcode = '42501';
  end if;
  perform pm.activate_sov_version(v_sov, false);
  update pm.fs_install_projects set sov_version_id = v_sov, is_commercial = true where id = p.id;
  return v_sov;
end $$;

-- Install billing (FS-86): deposit, progress, final, or an SOV pay application (light commercial).
-- Billing requests are DRAFT; the app sends them through the 1113 approval engine to Books.
create or replace function pm.fs_install_bill(p_project uuid, p_kind text, p_amount_cents bigint default null, p_pct numeric default null,
                                              p_memo text default null, p_period_end date default null, p_sov_lines jsonb default '[]') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.fs_install_projects%rowtype; v_kind text := upper(coalesce(p_kind, '')); v_amt bigint; v_req uuid := gen_random_uuid(); v_prior bigint; v_dep uuid;
  v_desc text;
begin
  select * into p from pm.fs_install_projects x where x.id = p_project and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: install project not found' using errcode = '42501'; end if;
  if p.stage = 'CANCELLED' then raise exception 'PM_INVALID: this install is cancelled' using errcode = '22023'; end if;
  if v_kind = 'DEPOSIT' then
    v_amt := coalesce(p_amount_cents, case when p_pct is not null then pm.fs_rdiv(p.contract_cents * p_pct * 10000, 10000) end);
    if coalesce(v_amt, 0) <= 0 then raise exception 'PM_INVALID: enter the deposit amount' using errcode = '22023'; end if;
    if v_amt > greatest(p.contract_cents, 0) then raise exception 'PM_INVALID: the deposit is more than the sold total' using errcode = '22023'; end if;
    v_dep := pm.request_deposit(p.job_id, v_amt, coalesce(p_memo, format('Deposit — %s', p.number)), current_date);
    update pm.fs_install_projects set deposit_request_ids = deposit_request_ids || v_dep where id = p.id;
    return jsonb_build_object('kind', 'DEPOSIT', 'deposit_request_id', v_dep, 'amount_cents', v_amt);
  elsif v_kind = 'SOV' then
    if p.sov_version_id is null then raise exception 'PM_INVALID: set up the schedule of values first' using errcode = '22023'; end if;
    v_req := pm.generate_sov_billing(p.job_id, p.sov_version_id, coalesce(p_period_end, current_date), coalesce(p_sov_lines, '[]'::jsonb));
    update pm.fs_install_projects set billing_request_ids = billing_request_ids || v_req where id = p.id;
    return jsonb_build_object('kind', 'SOV', 'billing_request_id', v_req);
  elsif v_kind not in ('PROGRESS','FINAL') then
    raise exception 'PM_INVALID: deposit, progress, final or SOV' using errcode = '22023';
  end if;
  if p.contract_cents <= 0 then raise exception 'PRECONDITION_NO_CONTRACT: this install has no sold total' using errcode = 'P0001'; end if;
  select coalesce(sum(b.gross_earned_cents), 0) into v_prior from pm.billing_requests b
   where b.org_id = p.org_id and b.id = any (p.billing_request_ids) and b.status not in ('VOID','REJECTED');
  if v_kind = 'FINAL' then
    if p.final_billing_request_id is not null and exists (select 1 from pm.billing_requests b where b.id = p.final_billing_request_id and b.status not in ('VOID','REJECTED')) then
      raise exception 'PM_INVALID: the final invoice was already requested' using errcode = '22023';
    end if;
    v_amt := p.contract_cents - v_prior;
    v_desc := format('Final — %s', p.title);
  else
    v_amt := coalesce(p_amount_cents, case when p_pct is not null then pm.fs_rdiv(p.contract_cents * p_pct * 10000, 10000) end);
    v_desc := format('Progress — %s', p.title);
    if coalesce(v_amt, 0) <= 0 then raise exception 'PM_INVALID: enter the amount or percent to bill' using errcode = '22023'; end if;
    if v_prior + v_amt > p.contract_cents then raise exception 'PM_INVALID: that bills more than the sold total' using errcode = '22023'; end if;
  end if;
  if v_amt <= 0 then raise exception 'PRECONDITION_NOTHING_TO_BILL: the sold total is already billed' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p.job_id::text, 0));
  insert into pm.billing_requests (id, org_id, job_id, billing_type, billing_subtype, status, occurred_on, memo, created_by)
  values (v_req, p.org_id, p.job_id, 'MILESTONE', 'FIXED', 'DRAFT', current_date, left(coalesce(p_memo, v_desc || ' (' || p.number || ')'), 500), pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents,
                                        retainage_rate, retainage_this_period_cents)
  values (p.org_id, v_req, 1, 0, 'STANDARD', left(v_desc, 300), v_amt, v_amt, 0, 0);
  perform pm.finalize_billing_retainage(v_req);
  update pm.fs_install_projects set billing_request_ids = billing_request_ids || v_req,
         final_billing_request_id = case when v_kind = 'FINAL' then v_req else final_billing_request_id end
   where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'billing.drafted', 'billing_requests', v_req,
    format('%s: %s invoice drafted', p.number, lower(v_kind)), jsonb_build_object('project_id', p.id, 'kind', v_kind));
  return jsonb_build_object('kind', v_kind, 'billing_request_id', v_req, 'amount_cents', v_amt);
end $$;

-- The install stage board (FS-79): stage, days in stage, stuck flag, readiness, billing state.
create or replace function pm.fs_install_board(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_money boolean := pm.can('projects.contract_value', 'view', p_location);
begin
  return coalesce((
    select jsonb_agg(x order by x.stage_rank, x.days_in_stage desc) from (
      select p.id, p.number, p.title, p.stage, p.job_id, p.customer_id, (select c.name from core.customers c where c.id = p.customer_id) as customer,
             p.install_work_order_id, p.permit_required, p.is_commercial, p.install_days, p.crew_size,
             (current_date - p.stage_changed_at::date) as days_in_stage,
             array_position(array['SOLD','ORDERED','PERMITTED','SCHEDULED','INSTALLED','INSPECTED','CLOSED'], p.stage) as stage_rank,
             ((current_date - p.stage_changed_at::date) > case p.stage when 'SOLD' then 3 when 'ORDERED' then 10 when 'PERMITTED' then 7
                                                                     when 'SCHEDULED' then 21 when 'INSTALLED' then 3 when 'INSPECTED' then 5 else 9999 end) as stuck,
             (select min(d.work_date) from pm.fs_install_crew_days d where d.org_id = p.org_id and d.project_id = p.id and d.status <> 'CANCELLED') as install_on,
             (select r.status from pm.res_permits r where r.org_id = p.org_id and r.job_id = p.job_id order by r.created_at desc limit 1) as permit_status,
             pm._fs_install_readiness(p.id) as readiness,
             p.final_billing_request_id is not null as final_billed,
             case when v_money then p.contract_cents end as contract_cents
        from pm.fs_install_projects p
       where p.org_id = v_org and p.location_id = p_location and p.stage <> 'CANCELLED'
         and (p.stage <> 'CLOSED' or p.closed_at > now() - interval '30 days')
         and p.job_id in (select pm.my_job_ids())) x), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- 12. Sales tax by line (FS-95) — Books' public.sales_tax_rates, most specific wins
-- ----------------------------------------------------------------------------
-- Rate for a sale address (site, else the customer's address) on a date: postal > city > county > state.
create or replace function pm._fs_tax_rate(p_org uuid, p_site uuid, p_customer uuid, p_on date) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_state text; v_city text; v_zip text; r record;
begin
  select upper(btrim(s.state)), lower(btrim(s.city)), left(btrim(s.zip), 5) into v_state, v_city, v_zip from core.sites s where s.id = p_site and s.org_id = p_org;
  if v_state is null then
    select upper(btrim(c.state)), lower(btrim(c.city)), left(btrim(c.zip), 5) into v_state, v_city, v_zip from core.customers c where c.id = p_customer and c.org_id = p_org;
  end if;
  if v_state is null or length(v_state) <> 2 then return jsonb_build_object('rate_pct', 0, 'jurisdiction', null, 'rate_id', null, 'state', v_state, 'resolved', false); end if;
  select t.id, t.combined_rate_pct, t.jurisdiction_label into r
    from public.sales_tax_rates t
   where t.org_id = p_org and t.is_active and upper(btrim(t.state)) = v_state
     and t.effective_date <= coalesce(p_on, current_date) and (t.end_date is null or t.end_date >= coalesce(p_on, current_date))
     and t.category is null
     and (t.postal_code is null or left(btrim(t.postal_code), 5) = v_zip)
     and (t.city is null or lower(btrim(t.city)) = v_city)
     and (t.county is null or t.postal_code is not null or t.city is not null)
   order by (t.postal_code is not null) desc, (t.city is not null) desc, (t.county is not null) desc, t.effective_date desc
   limit 1;
  return jsonb_build_object('rate_pct', coalesce(r.combined_rate_pct, 0), 'jurisdiction', r.jurisdiction_label, 'rate_id', r.id, 'state', v_state,
                            'resolved', r.id is not null);
end $$;

-- Is a line kind taxable in a state at this company (rule row, else the default: parts, equipment, freight).
create or replace function pm._fs_line_taxable(p_org uuid, p_location uuid, p_state text, p_kind text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select r.taxable from pm.fs_tax_rules r where r.org_id = p_org and r.location_id = p_location and r.state = upper(p_state) and r.line_kind = p_kind),
                  p_kind in ('PART','EQUIPMENT','FREIGHT'))
$$;

-- Tax per line: [{key, kind, amount_cents}] → taxable flag and tax cents per line (half-up), total = Σ lines.
create or replace function pm._fs_tax_lines(p_org uuid, p_location uuid, p_rate jsonb, p_lines jsonb) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare l jsonb; v_rate numeric := coalesce((p_rate ->> 'rate_pct')::numeric, 0); v_out jsonb := '[]'; v_tax bigint; v_amt bigint; v_tx boolean;
  v_total bigint := 0; v_taxable bigint := 0;
begin
  for l in select x from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x loop
    v_amt := coalesce((l ->> 'amount_cents')::bigint, 0);
    v_tx := v_rate > 0 and pm._fs_line_taxable(p_org, p_location, p_rate ->> 'state', coalesce(l ->> 'kind', 'SERVICE'));
    v_tax := case when v_tx then sign(v_amt)::bigint * pm.fs_rdiv(abs(v_amt) * v_rate * 10000, 100 * 10000) else 0 end;
    v_total := v_total + v_tax;
    if v_tx then v_taxable := v_taxable + v_amt; end if;
    v_out := v_out || (l || jsonb_build_object('taxable', v_tx, 'tax_cents', v_tax));
  end loop;
  return jsonb_build_object('rate_pct', v_rate, 'jurisdiction', p_rate ->> 'jurisdiction', 'rate_id', p_rate ->> 'rate_id', 'state', p_rate ->> 'state',
                            'lines', v_out, 'taxable_cents', v_taxable, 'tax_cents', v_total);
end $$;

-- Pin the rate on an estimate when it is presented (quote tax = invoice tax). Re-pins while DRAFT.
create or replace function pm._fs_pin_estimate_tax(p_estimate uuid) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; v_site uuid; v_rate jsonb; v_lines jsonb; v_res jsonb; v_id uuid;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate;
  if e.id is null then return null; end if;
  select s.id into v_id from pm.fs_tax_snapshots s where s.org_id = e.org_id and s.subject_type = 'FS_ESTIMATE' and s.subject_id = e.id;
  if v_id is not null and e.status <> 'DRAFT' then return v_id; end if;
  select w.site_id into v_site from pm.work_orders w where w.org_id = e.org_id and w.id = e.work_order_id;
  v_rate := pm._fs_tax_rate(e.org_id, v_site, e.customer_id, current_date);
  select coalesce(jsonb_agg(jsonb_build_object('key', i.id, 'option_id', i.option_id, 'kind', i.kind,
                   'amount_cents', round(i.qty * case when e.member_pricing then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end)::bigint)
                   order by i.option_id, i.sort), '[]'::jsonb)
    into v_lines
    from pm.fs_estimate_option_items i join pm.fs_estimate_options o on o.org_id = i.org_id and o.id = i.option_id
   where o.org_id = e.org_id and o.estimate_id = e.id;
  v_res := pm._fs_tax_lines(e.org_id, e.location_id, v_rate, v_lines);
  insert into pm.fs_tax_snapshots as t (org_id, location_id, job_id, subject_type, subject_id, rate_pct, jurisdiction, rate_id, state, lines, tax_cents)
  values (e.org_id, e.location_id, e.job_id, 'FS_ESTIMATE', e.id, (v_res ->> 'rate_pct')::numeric, v_res ->> 'jurisdiction',
          nullif(v_res ->> 'rate_id', '')::uuid, v_res ->> 'state', v_res -> 'lines', 0)
  on conflict (org_id, subject_type, subject_id) do update set rate_pct = excluded.rate_pct, jurisdiction = excluded.jurisdiction, rate_id = excluded.rate_id,
    state = excluded.state, lines = excluded.lines, computed_at = now()
  returning t.id into v_id;
  return v_id;
end $$;

-- Tax per option of an estimate (what the tablet / portal shows next to each total).
create or replace function pm.fs_quote_tax(p_estimate uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; s pm.fs_tax_snapshots%rowtype; v_res jsonb;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = public.get_org_id();
  if e.id is null then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  perform pm._fs_pin_estimate_tax(e.id);
  select * into s from pm.fs_tax_snapshots x where x.org_id = e.org_id and x.subject_type = 'FS_ESTIMATE' and x.subject_id = e.id;
  -- current item selection, pinned rate
  v_res := pm._fs_tax_lines(e.org_id, e.location_id, jsonb_build_object('rate_pct', s.rate_pct, 'jurisdiction', s.jurisdiction, 'rate_id', s.rate_id, 'state', s.state),
    (select coalesce(jsonb_agg(jsonb_build_object('key', i.id, 'option_id', i.option_id, 'kind', i.kind,
              'amount_cents', round(i.qty * case when e.member_pricing then coalesce(i.member_unit_price_cents, i.unit_price_cents) else i.unit_price_cents end)::bigint)), '[]'::jsonb)
       from pm.fs_estimate_option_items i join pm.fs_estimate_options o on o.org_id = i.org_id and o.id = i.option_id
      where o.org_id = e.org_id and o.estimate_id = e.id and i.is_selected));
  return jsonb_build_object('rate_pct', s.rate_pct, 'jurisdiction', s.jurisdiction, 'pinned_at', s.computed_at,
    'options', coalesce((select jsonb_agg(jsonb_build_object('option_id', g.option_id, 'tax_cents', g.tax, 'taxable_cents', g.taxable))
                           from (select (l ->> 'option_id')::uuid as option_id, sum((l ->> 'tax_cents')::bigint) as tax,
                                        sum(case when (l ->> 'taxable')::boolean then (l ->> 'amount_cents')::bigint else 0 end) as taxable
                                   from jsonb_array_elements(v_res -> 'lines') l group by 1) g), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- 13. Invoice review queue (FS-94) — rules-only flags before anything goes to Books
-- ----------------------------------------------------------------------------
create or replace function pm._fs_review_flags(p_wo uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v jsonb := '[]'; r record; v_member boolean; v_cust uuid; v_lines int; v_jt text; v_has_photo boolean;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  select j.customer_id into v_cust from core.jobs j where j.id = w.job_id;
  v_member := exists (select 1 from pm.service_agreements g where g.org_id = w.org_id and g.customer_id = v_cust and g.status = 'ACTIVE' and not g.entitlements_suspended);
  select count(*) into v_lines from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER';
  if v_lines = 0 and w.agreement_id is null and not w.is_callback then
    v := v || jsonb_build_object('code', 'NO_LINES', 'severity', 'BLOCK', 'message', 'Nothing is on the invoice — add the work performed');
  end if;
  if exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'PROPOSED') then
    v := v || jsonb_build_object('code', 'UNDECIDED_OPTIONS', 'severity', 'BLOCK', 'message', 'Options are still waiting on the customer''s decision');
  end if;
  for r in select mm.item_id, max(coalesce(mm.description, 'A part')) as what, sum(mm.qty) as qty
             from pm.material_moves mm
            where mm.org_id = w.org_id and mm.work_order_id = w.id and mm.kind = 'ISSUE'
              and not exists (select 1 from pm.work_order_lines l left join pm.price_book_items pb on pb.id = l.price_book_item_id
                               where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED'
                                 and (l.item_id = mm.item_id or pb.item_id = mm.item_id))
            group by mm.item_id loop
    v := v || jsonb_build_object('code', 'PARTS_NOT_BILLED', 'severity', 'BLOCK', 'message', format('%s (×%s) came off the truck but is not billed', r.what, r.qty::numeric(14,2)));
  end loop;
  for r in select l.id, l.description, l.unit_price_cents, l.discount_pct, pb.price_cents, pb.member_price_cents
             from pm.work_order_lines l join pm.price_book_items pb on pb.id = l.price_book_item_id
            where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER' and l.kind <> 'DISCOUNT' loop
    if pm.fs_rdiv(coalesce(r.unit_price_cents, 0) * (1 - r.discount_pct) * 10000, 10000) + 1 < coalesce(r.member_price_cents, r.price_cents, 0) then
      v := v || jsonb_build_object('code', 'BELOW_FLOOR', 'severity', 'BLOCK', 'line_id', r.id,
        'message', format('%s is priced below the price-book floor', r.description));
    elsif v_member and r.member_price_cents is not null and r.member_price_cents < coalesce(r.price_cents, 0) and r.unit_price_cents >= r.price_cents then
      v := v || jsonb_build_object('code', 'MEMBER_DISCOUNT', 'severity', 'WARN', 'line_id', r.id,
        'message', format('%s: the customer is a member but was charged the regular price', r.description));
    elsif not v_member and r.member_price_cents is not null and r.member_price_cents < coalesce(r.price_cents, 0) and r.unit_price_cents < r.price_cents then
      v := v || jsonb_build_object('code', 'MEMBER_DISCOUNT', 'severity', 'WARN', 'line_id', r.id,
        'message', format('%s: member price given to a customer with no active membership', r.description));
    end if;
  end loop;
  if exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind = 'FEE'
               and l.description ~* 'diagnos' and coalesce(l.unit_price_cents, 0) > 0)
     and exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind = 'SERVICE'
                   and coalesce(l.unit_price_cents, 0) > 0) then
    v := v || jsonb_build_object('code', 'DIAG_FEE_NOT_WAIVED', 'severity', 'WARN', 'message', 'A repair was sold, so the diagnostic fee is usually waived');
  end if;
  if w.is_callback and exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED'
                                 and l.pay_type = 'CUSTOMER' and l.amount_cents > 0) then
    v := v || jsonb_build_object('code', 'CALLBACK_CHARGED', 'severity', 'WARN', 'message', 'This is a recall — recall visits are normally no-charge');
  end if;
  v_has_photo := exists (select 1 from pm.document_links dl where dl.org_id = w.org_id and dl.job_id = w.job_id)
              or exists (select 1 from pm.fs_visit_notes n where n.org_id = w.org_id and n.work_order_id = w.id and cardinality(n.photo_command_ids) > 0)
              or exists (select 1 from pm.fs_form_submissions s where s.org_id = w.org_id and s.work_order_id = w.id and cardinality(s.photo_command_ids) > 0);
  if not v_has_photo then
    v := v || jsonb_build_object('code', 'MISSING_PHOTOS', 'severity', 'WARN', 'message', 'No photos on this visit');
  end if;
  select bj.key into v_jt from pm.service_calls sc join pm.booking_job_types bj on bj.org_id = sc.org_id and bj.id = sc.booking_job_type_id
   where sc.org_id = w.org_id and sc.id = w.call_id;
  for r in select t.name from pm.fs_form_templates t
            where t.org_id = w.org_id and t.location_id = w.location_id and t.is_active
              and ((v_jt is not null and v_jt = any (t.job_type_keys)) or w.kind = any (t.wo_kinds))
              and not exists (select 1 from pm.fs_form_submissions s where s.org_id = w.org_id and s.work_order_id = w.id and s.template_id = t.id) loop
    v := v || jsonb_build_object('code', 'MISSING_FORM', 'severity', 'WARN', 'message', format('%s was not filled in', r.name));
  end loop;
  return v;
end $$;

create or replace function pm._fs_refresh_review(p_wo uuid) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cust uuid; v_flags jsonb; v_sub bigint; v_rate jsonb; v_tax jsonb; v_snap uuid; v_id uuid; v_est uuid; s pm.fs_tax_snapshots%rowtype;
  v_status text;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.id is null then return null; end if;
  select r.id, r.status into v_id, v_status from pm.fs_invoice_reviews r where r.org_id = w.org_id and r.work_order_id = w.id;
  if v_status in ('APPROVED','VOID') then return v_id; end if;
  select j.customer_id into v_cust from core.jobs j where j.id = w.job_id;
  v_flags := pm._fs_review_flags(w.id);
  select coalesce(sum(l.amount_cents), 0) into v_sub from pm.work_order_lines l
   where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER';
  -- the rate pinned when the options were presented, else today's rate
  select e.id into v_est from pm.fs_estimates e where e.org_id = w.org_id and e.work_order_id = w.id and e.status = 'SOLD' order by e.sold_at desc limit 1;
  select * into s from pm.fs_tax_snapshots x where x.org_id = w.org_id and x.subject_type = 'FS_ESTIMATE' and x.subject_id = v_est;
  v_rate := case when s.id is not null then jsonb_build_object('rate_pct', s.rate_pct, 'jurisdiction', s.jurisdiction, 'rate_id', s.rate_id, 'state', s.state, 'resolved', s.rate_id is not null)
                 else pm._fs_tax_rate(w.org_id, w.site_id, v_cust, current_date) end;
  v_tax := pm._fs_tax_lines(w.org_id, w.location_id, v_rate,
    (select coalesce(jsonb_agg(jsonb_build_object('key', l.id, 'kind', l.kind, 'description', l.description, 'amount_cents', l.amount_cents) order by l.sort), '[]'::jsonb)
       from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'));
  if not coalesce((v_rate ->> 'resolved')::boolean, false)
     and exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.kind in ('PART','EQUIPMENT')) then
    v_flags := v_flags || jsonb_build_object('code', 'TAX_RATE_MISSING', 'severity', 'WARN', 'message', 'No sales-tax rate is set up in Books for this address');
  end if;
  insert into pm.fs_invoice_reviews as r (org_id, location_id, job_id, work_order_id, customer_id, status, flags, flag_count, blocking_count,
                                          subtotal_cents, tax_cents, total_cents, refreshed_at)
  values (w.org_id, w.location_id, w.job_id, w.id, v_cust, case when jsonb_array_length(v_flags) > 0 then 'FLAGGED' else 'PENDING' end, v_flags,
          jsonb_array_length(v_flags), (select count(*) from jsonb_array_elements(v_flags) f where f ->> 'severity' = 'BLOCK'),
          v_sub, (v_tax ->> 'tax_cents')::bigint, v_sub + (v_tax ->> 'tax_cents')::bigint, now())
  on conflict (org_id, work_order_id) do update set
    status = case when r.status = 'RETURNED' then 'RETURNED' else excluded.status end, flags = excluded.flags, flag_count = excluded.flag_count,
    blocking_count = excluded.blocking_count, subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents,
    total_cents = excluded.total_cents, refreshed_at = now(), customer_id = excluded.customer_id
  returning r.id into v_id;
  insert into pm.fs_tax_snapshots as t (org_id, location_id, job_id, subject_type, subject_id, rate_pct, jurisdiction, rate_id, state, lines, tax_cents)
  values (w.org_id, w.location_id, w.job_id, 'INVOICE_REVIEW', v_id, (v_tax ->> 'rate_pct')::numeric, v_tax ->> 'jurisdiction', nullif(v_tax ->> 'rate_id', '')::uuid,
          v_tax ->> 'state', v_tax -> 'lines', (v_tax ->> 'tax_cents')::bigint)
  on conflict (org_id, subject_type, subject_id) do update set rate_pct = excluded.rate_pct, jurisdiction = excluded.jurisdiction, rate_id = excluded.rate_id,
    state = excluded.state, lines = excluded.lines, tax_cents = excluded.tax_cents, computed_at = now()
  returning t.id into v_snap;
  update pm.fs_invoice_reviews set tax_snapshot_id = v_snap where id = v_id;
  return v_id;
end $$;

-- A completed customer visit enters the queue (field-service companies only).
create or replace function pm.tg_fs_review_queue() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status = 'COMPLETE' and old.status is distinct from 'COMPLETE' and new.kind in ('SERVICE','MAINTENANCE_VISIT','INSTALL')
     and new.payer_type = 'CUSTOMER' and exists (select 1 from pm.fs_settings s where s.org_id = new.org_id and s.location_id = new.location_id) then
    begin
      perform pm._fs_refresh_review(new.id);
    exception when others then
      raise warning '[1123] invoice review skipped: %', sqlerrm;
    end;
  end if;
  return new;
end $$;
create or replace trigger trg_fs_review_queue after update of status on pm.work_orders for each row execute function pm.tg_fs_review_queue();

create or replace function pm.fs_refresh_review(p_review uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.fs_invoice_reviews%rowtype;
begin
  select * into r from pm.fs_invoice_reviews x where x.id = p_review and x.org_id = public.get_org_id();
  if r.id is null then raise exception 'PM_FORBIDDEN: review not found' using errcode = '42501'; end if;
  if r.status = 'RETURNED' then update pm.fs_invoice_reviews set status = 'PENDING' where id = r.id; end if;
  perform pm._fs_refresh_review(r.work_order_id);
  select * into r from pm.fs_invoice_reviews x where x.id = p_review;
  -- totals only with contract value on the job (security review H2) — same rule as the masked view
  if r.job_id in (select pm.my_money_job_ids('projects.contract_value')) then return to_jsonb(r); end if;
  return to_jsonb(r) || jsonb_build_object('subtotal_cents', null, 'tax_cents', null, 'total_cents', null);
end $$;

-- Approve (→ a DRAFT billing request the app routes through the 1113 approval engine) or return.
create or replace function pm.fs_decide_review(p_review uuid, p_decision text, p_reason text default null, p_override_reason text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.fs_invoice_reviews%rowtype; w pm.work_orders%rowtype; v_dec text := upper(coalesce(p_decision, '')); v_req uuid; l record; n int := 0;
  v_tax text;
begin
  select * into r from pm.fs_invoice_reviews x where x.id = p_review and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: review not found' using errcode = '42501'; end if;
  if r.status in ('APPROVED','VOID') then raise exception 'PM_INVALID: this invoice was already %', lower(r.status) using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.id = r.work_order_id;
  if v_dec = 'RETURN' then
    if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PM_INVALID: say what needs fixing' using errcode = '22023'; end if;
    update pm.fs_invoice_reviews set status = 'RETURNED', return_reason = left(btrim(p_reason), 1000), reviewed_by = pm.current_user_id(), reviewed_at = now()
     where id = r.id;
    perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'fs_review.returned', 'work_orders', r.work_order_id,
      format('%s: invoice returned — %s', w.number, btrim(p_reason)), '{}'::jsonb);
    return jsonb_build_object('status', 'RETURNED');
  elsif v_dec <> 'APPROVE' then
    raise exception 'PM_INVALID: APPROVE or RETURN' using errcode = '22023';
  end if;
  if not pm.access_can_row('projects.billing', 'create', 'fs_invoice_reviews', r.id) then
    raise exception 'PM_FORBIDDEN: approving an invoice for Books requires projects.billing:create' using errcode = '42501';
  end if;
  perform pm._fs_refresh_review(r.work_order_id);
  select * into r from pm.fs_invoice_reviews x where x.id = p_review;
  if r.blocking_count > 0 then
    if char_length(btrim(coalesce(p_override_reason, ''))) < 5 or not pm.access_can_row('projects.billing', 'approve', 'fs_invoice_reviews', r.id) then
      raise exception 'PM_FS_REVIEW_BLOCKED: % — fix it, or a billing approver overrides with a reason',
        (select string_agg(f ->> 'message', '; ') from jsonb_array_elements(r.flags) f where f ->> 'severity' = 'BLOCK') using errcode = '22023';
    end if;
  end if;
  if r.subtotal_cents <> 0 then
    v_req := gen_random_uuid();
    select case when s.tax_cents <> 0 then format(' · sales tax %s (%s%% %s, per line in Projects)', to_char(s.tax_cents / 100.0, 'FM999,999,990.00'), s.rate_pct, coalesce(s.jurisdiction, ''))
           else '' end into v_tax
      from pm.fs_tax_snapshots s where s.id = r.tax_snapshot_id;
    perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || r.job_id::text, 0));
    insert into pm.billing_requests (id, org_id, job_id, billing_type, billing_subtype, status, occurred_on, memo, created_by)
    values (v_req, r.org_id, r.job_id, 'MILESTONE', 'FIXED', 'DRAFT', coalesce(w.completed_at::date, current_date),
            left(format('Service invoice %s%s', w.number, coalesce(v_tax, '')), 500), pm.current_user_id());
    for l in select x.* from pm.work_order_lines x where x.org_id = r.org_id and x.work_order_id = r.work_order_id and x.status = 'APPROVED'
                                                    and x.pay_type = 'CUSTOMER' order by x.sort, x.created_at loop
      n := n + 1;
      insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, item_id, cost_code_id,
                                            this_period_work_cents, retainage_rate, retainage_this_period_cents)
      values (r.org_id, v_req, n, n, 'STANDARD', left(l.description, 300), l.amount_cents, l.item_id, l.cost_code_id, l.amount_cents, 0, 0);
    end loop;
    perform pm.finalize_billing_retainage(v_req);
  end if;
  update pm.fs_invoice_reviews set status = 'APPROVED', billing_request_id = v_req, override_reason = nullif(btrim(coalesce(p_override_reason, '')), ''),
         reviewed_by = pm.current_user_id(), reviewed_at = now()
   where id = r.id;
  -- close_work_order is guarded by projects.dispatch:edit; nested here its guard is skipped, so the
  -- caller's right is checked explicitly (nested-guard audit). Without it the visit stays COMPLETE.
  if w.status = 'COMPLETE' and pm.access_can_row('projects.dispatch', 'edit', 'work_orders', w.id) then
    begin
      perform pm.close_work_order(w.id);
    exception when others then
      raise warning '[1123] visit left open after review: %', sqlerrm;
    end;
  end if;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'fs_review.approved', 'work_orders', r.work_order_id,
    format('%s: invoice reviewed%s', w.number, case when v_req is not null then ' — billing request drafted' else ' (nothing to bill)' end),
    jsonb_build_object('billing_request_id', v_req, 'override', p_override_reason is not null));
  return jsonb_build_object('status', 'APPROVED', 'billing_request_id', v_req, 'lines', n);
end $$;

create or replace function pm.fs_review_queue(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_money boolean := pm.can('projects.contract_value', 'view', p_location);
begin
  return coalesce((
    select jsonb_agg(x order by x.blocking_count desc, x.completed_at) from (
      select r.id, r.status, r.work_order_id, w.number, w.summary, r.job_id, r.customer_id, (select c.name from core.customers c where c.id = r.customer_id) as customer,
             w.completed_at, (current_date - coalesce(w.completed_at, r.created_at)::date) as age_days, r.flags, r.flag_count, r.blocking_count,
             r.billing_request_id, (select b.status from pm.billing_requests b where b.id = r.billing_request_id) as billing_status,
             (select b.invoice_number from pm.billing_requests b where b.id = r.billing_request_id) as invoice_number,
             r.return_reason,
             (select coalesce(tp.display_name, e.first_name) from pm.dispatch_assignments d join core.employees e on e.id = d.employee_id
                left join pm.tech_profiles tp on tp.org_id = d.org_id and tp.employee_id = d.employee_id
               where d.org_id = r.org_id and d.work_order_id = r.work_order_id and d.status <> 'CANCELLED' order by d.is_lead desc limit 1) as technician,
             case when v_money then r.subtotal_cents end as subtotal_cents, case when v_money then r.tax_cents end as tax_cents,
             case when v_money then r.total_cents end as total_cents
        from pm.fs_invoice_reviews r join pm.work_orders w on w.org_id = r.org_id and w.id = r.work_order_id
       where r.org_id = v_org and r.location_id = p_location
         and (r.status in ('PENDING','FLAGGED','RETURNED') or (r.status = 'APPROVED' and r.reviewed_at > now() - interval '7 days'))
         and r.job_id in (select pm.my_job_ids())) x), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- 14. Text-to-pay and auto-pay (FS-96)
-- ----------------------------------------------------------------------------
drop function if exists pm.fs_text_to_pay(uuid, uuid, text, uuid, text, uuid);
create or replace function pm.fs_text_to_pay(p_review uuid default null, p_billing_request uuid default null, p_channel text default 'SMS',
                                             p_contact uuid default null, p_command uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_br uuid := p_billing_request; b pm.billing_requests%rowtype; i record; v_link text; v_res jsonb; v_seen jsonb;
begin
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(v_org, p_command, 'fs.pay.link');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  if v_br is null then select r.billing_request_id into v_br from pm.fs_invoice_reviews r where r.id = p_review and r.org_id = v_org; end if;
  select * into b from pm.billing_requests x where x.id = v_br and x.org_id = v_org;
  if b.id is null then raise exception 'PM_FS_NOT_INVOICED: approve the invoice review first' using errcode = '22023'; end if;
  if b.invoice_id is null then raise exception 'PM_FS_NOT_INVOICED: Books has not issued this invoice yet' using errcode = '22023'; end if;
  select x.id, x.invoice_number, x.public_token, x.status, x.balance_cents, x.customer_id, x.location_id, x.job_id into i
    from public.invoices x where x.id = b.invoice_id and x.org_id = v_org;
  if i.id is null then raise exception 'PM_FS_NOT_INVOICED: the Books invoice was not found' using errcode = '22023'; end if;
  if i.status not in ('SENT','PARTIALLY_PAID','OVERDUE') or coalesce(i.balance_cents, 0) <= 0 then
    raise exception 'PM_FS_NOTHING_DUE: this invoice has nothing to pay (%)', lower(i.status) using errcode = '22023';
  end if;
  v_link := pm._fs_app_url('books') || '/pay/' || i.public_token::text;
  v_res := pm.fs_send_message(b.location_id, i.customer_id, b.job_id, p_channel,
             'Hi {first_name}, your invoice {invoice} from {company} is ready. View and pay securely: {link}', p_contact, null, null,
             jsonb_build_object('invoice', i.invoice_number, 'link', v_link), null);
  v_res := v_res || jsonb_build_object('link', v_link, 'invoice_number', i.invoice_number);
  return pm._fs_cmd_done(v_org, p_command, 'fs.pay.link', b.id, v_res);
end $$;

create or replace function pm.fs_request_autopay(p_agreement uuid, p_contact uuid, p_method_label text, p_consented_by_name text,
                                                 p_consent_text text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype; v_id uuid; v_text text;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: agreement not found' using errcode = '42501'; end if;
  if a.status not in ('ACTIVE','SUSPENDED','DRAFT') then raise exception 'PM_INVALID: the agreement is %', lower(a.status) using errcode = '22023'; end if;
  if p_contact is not null and not exists (select 1 from core.contacts c where c.id = p_contact and c.org_id = a.org_id and c.customer_id = a.customer_id) then
    raise exception 'PM_INVALID: that contact is not on this customer' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_method_label, ''))) not between 1 and 60 then raise exception 'PM_INVALID: name the card or account (e.g. Visa ending 4242)' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_consented_by_name, ''))) < 2 then raise exception 'PM_INVALID: the customer agrees with their name' using errcode = '22023'; end if;
  v_text := coalesce(nullif(btrim(coalesce(p_consent_text, '')), ''),
    format('I authorize %s to charge my %s for my %s each billing period until I cancel.',
           (select l.name from core.locations l where l.id = a.location_id), btrim(p_method_label), a.plan_name));
  update pm.fs_autopay_enrollments set status = 'CANCELLED', cancelled_at = now() where org_id = a.org_id and agreement_id = a.id and status <> 'CANCELLED';
  insert into pm.fs_autopay_enrollments (org_id, location_id, agreement_id, customer_id, contact_id, method_label, consent_text, consented_by_name)
  values (a.org_id, a.location_id, a.id, a.customer_id, p_contact, left(btrim(p_method_label), 60), left(v_text, 1000), left(btrim(p_consented_by_name), 120))
  returning id into v_id;
  update pm.service_agreements set payment_method_label = left(btrim(p_method_label), 60) where id = a.id;
  perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'fs_agreement.autopay_requested', 'service_agreements', a.id,
    format('%s: auto-pay requested on %s', coalesce(a.number, a.plan_name), btrim(p_method_label)), jsonb_build_object('enrollment_id', v_id));
  return v_id;
end $$;

create or replace function pm.fs_cancel_autopay(p_enrollment uuid, p_reason text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_autopay_enrollments%rowtype;
begin
  select * into e from pm.fs_autopay_enrollments x where x.id = p_enrollment and x.org_id = public.get_org_id() for update;
  if e.id is null then raise exception 'PM_FORBIDDEN: enrollment not found' using errcode = '42501'; end if;
  update pm.fs_autopay_enrollments set status = 'CANCELLED', cancelled_at = now() where id = e.id;
  return e.id;
end $$;

-- ----------------------------------------------------------------------------
-- 15. Financing funding reconciliation (FS-97)
-- ----------------------------------------------------------------------------
create or replace function pm._fs_record_financing(p_estimate uuid) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; pl pm.financing_plans%rowtype; v_total bigint; v_amt bigint; v_fee bigint; v_id uuid;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate;
  if e.id is null or e.status <> 'SOLD' or e.financing_plan_id is null then return null; end if;
  select * into pl from pm.financing_plans x where x.org_id = e.org_id and x.id = e.financing_plan_id;
  select coalesce(sum(case when e.member_pricing then t.member_cents else t.regular_cents end - coalesce(t.rebate_cents, 0)), 0) into v_total
    from pm.v_fs_option_totals t where t.option_id = any (e.sold_option_ids);
  v_amt := greatest(v_total - coalesce(e.deposit_cents, 0), 0);
  v_fee := pm.fs_rdiv(v_amt * coalesce(pl.dealer_fee_pct, 0) * 10000, 10000);
  insert into pm.fs_financed_sales (org_id, location_id, job_id, estimate_id, plan_id, provider, amount_financed_cents, dealer_fee_pct, dealer_fee_cents,
                                    expected_net_cents, sold_on)
  values (e.org_id, e.location_id, e.job_id, e.id, pl.id, coalesce(pl.provider, 'OTHER'), v_amt, coalesce(pl.dealer_fee_pct, 0), v_fee, v_amt - v_fee,
          coalesce(e.sold_at::date, current_date))
  on conflict (org_id, estimate_id) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm.fs_update_financing(p_financed uuid, p_status text, p_application_ref text default null, p_funded_cents bigint default null,
                                                  p_funded_on date default null, p_note text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.fs_financed_sales%rowtype; v_status text := upper(coalesce(p_status, ''));
begin
  select * into f from pm.fs_financed_sales x where x.id = p_financed and x.org_id = public.get_org_id() for update;
  if f.id is null then raise exception 'PM_FORBIDDEN: financed sale not found' using errcode = '42501'; end if;
  if v_status not in ('APPLIED','APPROVED','DOCS_SIGNED','FUNDING_REQUESTED','FUNDED','SHORT_FUNDED','CANCELLED') then
    raise exception 'PM_INVALID: unknown financing status' using errcode = '22023';
  end if;
  if f.status in ('FUNDED','CANCELLED') and v_status <> f.status then raise exception 'PM_INVALID: this loan is already %', lower(f.status) using errcode = '22023'; end if;
  if v_status in ('FUNDED','SHORT_FUNDED') and p_funded_cents is null then raise exception 'PM_INVALID: enter the amount the lender funded' using errcode = '22023'; end if;
  if v_status = 'FUNDED' and p_funded_cents < f.expected_net_cents then v_status := 'SHORT_FUNDED'; end if;
  update pm.fs_financed_sales set status = v_status, application_ref = coalesce(left(nullif(btrim(coalesce(p_application_ref, '')), ''), 80), application_ref),
         funded_cents = coalesce(p_funded_cents, funded_cents), funded_on = case when v_status in ('FUNDED','SHORT_FUNDED') then coalesce(p_funded_on, current_date) else funded_on end,
         approved_at = case when v_status = 'APPROVED' then now() else approved_at end,
         funding_requested_at = case when v_status = 'FUNDING_REQUESTED' then now() else funding_requested_at end,
         notes = coalesce(left(p_note, 2000), notes)
   where id = f.id;
  return jsonb_build_object('id', f.id, 'status', v_status);
end $$;

create or replace function pm.fs_financing_recon(p_location uuid, p_as_of date default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_c boolean := pm.can('projects.contract_value', 'view', p_location); v_f boolean := pm.can('projects.financials', 'view', p_location);
  v_day date := coalesce(p_as_of, current_date); v_rows jsonb;
begin
  select coalesce(jsonb_agg(x order by x.days_outstanding desc), '[]'::jsonb) into v_rows from (
    select f.id, f.estimate_id, (select e.number from pm.fs_estimates e where e.id = f.estimate_id) as estimate_number, f.job_id,
           (select c.name from core.customers c join pm.fs_estimates e on e.customer_id = c.id where e.id = f.estimate_id) as customer,
           f.provider, f.application_ref, f.status, f.sold_on, f.funded_on, f.funding_requested_at,
           (coalesce(f.funded_on, v_day) - f.sold_on) as days_outstanding,
           (f.status not in ('FUNDED','CANCELLED') and (v_day - f.sold_on) > f.chase_after_days) as chase,
           case when v_c then f.amount_financed_cents end as amount_financed_cents,
           case when v_c then f.funded_cents end as funded_cents,
           case when v_f then f.dealer_fee_pct end as dealer_fee_pct, case when v_f then f.dealer_fee_cents end as dealer_fee_cents,
           case when v_f then f.expected_net_cents end as expected_net_cents,
           case when v_f and f.funded_cents is not null then f.expected_net_cents - f.funded_cents end as short_cents
      from pm.fs_financed_sales f
     where f.org_id = v_org and f.location_id = p_location and f.job_id in (select pm.my_job_ids())) x;
  return jsonb_build_object('rows', v_rows,
    'unfunded', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'status' not in ('FUNDED','CANCELLED')),
    'chase', (select count(*) from jsonb_array_elements(v_rows) r where (r ->> 'chase')::boolean),
    'unfunded_cents', case when v_c then (select coalesce(sum((r ->> 'amount_financed_cents')::bigint), 0) from jsonb_array_elements(v_rows) r
                                          where r ->> 'status' not in ('FUNDED','CANCELLED')) end);
end $$;

-- ----------------------------------------------------------------------------
-- 16. Timesheet review with exception flags (FS-102)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_timesheet_exceptions(p_location uuid, p_from date, p_to date, p_long_drive_minutes int default 60,
                                                      p_gap_minutes int default 45) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id(); v_from date := coalesce(p_from, current_date - 6); v_to date := coalesce(p_to, current_date);
  emp record; v_day date; v_rows jsonb := '[]'; v_flags jsonb; v_hours numeric; v_week numeric; a record; v_prev record; v_mins int;
  v_entries jsonb; v_submitted uuid[]; v_has_prev boolean; v_tz text;
begin
  if v_to < v_from or v_to - v_from > 31 then raise exception 'PM_INVALID: pick up to 31 days' using errcode = '22023'; end if;
  select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = v_org and s.location_id = p_location;
  v_tz := coalesce(v_tz, 'America/Chicago');
  for emp in
    select distinct e.id, coalesce(nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), 'Technician') as name
      from core.employees e
     where e.org_id = v_org and (
       exists (select 1 from pm.time_entries te join core.jobs j on j.org_id = te.org_id and j.id = te.job_id
                where te.org_id = v_org and te.employee_id = e.id and j.location_id = p_location and te.work_date between v_from and v_to)
       or exists (select 1 from pm.dispatch_assignments d join core.jobs j on j.org_id = d.org_id and j.id = d.job_id
                   where d.org_id = v_org and d.employee_id = e.id and j.location_id = p_location
                     and (lower(d.slot) at time zone v_tz)::date between v_from and v_to and d.status <> 'CANCELLED'))
     order by 2
  loop
    v_day := v_from;
    while v_day <= v_to loop
      v_flags := '[]';
      select coalesce(sum(te.hours), 0),
             coalesce(jsonb_agg(jsonb_build_object('id', te.id, 'job_id', te.job_id, 'hours', te.hours, 'state', te.approval_state, 'pay_type', te.pay_type)
                                order by te.created_at) filter (where te.id is not null), '[]'::jsonb),
             coalesce(array_agg(te.id) filter (where te.approval_state = 'SUBMITTED'), '{}')
        into v_hours, v_entries, v_submitted
        from pm.time_entries te join core.jobs j on j.org_id = te.org_id and j.id = te.job_id
       where te.org_id = v_org and te.employee_id = emp.id and j.location_id = p_location and te.work_date = v_day
         and te.approval_state not in ('VOID','REJECTED') and te.job_id in (select pm.my_job_ids());
      v_has_prev := false;
      for a in select d.*, w.number from pm.dispatch_assignments d join pm.work_orders w on w.org_id = d.org_id and w.id = d.work_order_id
                where d.org_id = v_org and d.employee_id = emp.id and w.location_id = p_location and d.status <> 'CANCELLED'
                  and (lower(d.slot) at time zone v_tz)::date = v_day
                order by coalesce(d.arrived_at, lower(d.slot)) loop
        if a.en_route_at is not null and a.arrived_at is not null then
          v_mins := (extract(epoch from (a.arrived_at - a.en_route_at)) / 60)::int;
          if v_mins > p_long_drive_minutes then
            v_flags := v_flags || jsonb_build_object('code', 'LONG_DRIVE', 'minutes', v_mins, 'work_order', a.number,
              'message', format('%s min drive to %s', v_mins, a.number), 'fix', 'Confirm the route, or move the extra time to shop / supply-house');
          end if;
        end if;
        if a.arrived_at is not null and a.done_at is null and v_day < current_date then
          v_flags := v_flags || jsonb_build_object('code', 'MISSING_CLOCK_OUT', 'work_order', a.number,
            'message', format('On site at %s with no finish', a.number),
            'fix', format('Set the finish to the end of the booked slot (%s)', to_char(upper(a.slot) at time zone v_tz, 'FMHH12:MI am')));
        end if;
        if v_has_prev then
          if v_prev.done_at is not null and coalesce(a.en_route_at, a.arrived_at) is not null then
            v_mins := (extract(epoch from (coalesce(a.en_route_at, a.arrived_at) - v_prev.done_at)) / 60)::int;
            if v_mins > p_gap_minutes and not exists (
                 select 1 from pm.tech_events te where te.org_id = v_org and te.employee_id = emp.id
                    and te.slot && tstzrange(v_prev.done_at, coalesce(a.en_route_at, a.arrived_at))) then
              v_flags := v_flags || jsonb_build_object('code', 'GAP', 'minutes', v_mins,
                'message', format('%s min unexplained between %s and %s', v_mins, v_prev.number, a.number), 'fix', 'Ask the tech what the time was (shop, supply house, lunch)');
            end if;
          end if;
        end if;
        v_prev := a; v_has_prev := true;
      end loop;
      if v_hours > 8 then
        v_flags := v_flags || jsonb_build_object('code', 'OVERTIME_DAY', 'hours', v_hours, 'message', format('%s h — %s h over 8', v_hours, v_hours - 8),
                                                 'fix', 'Split the hours over 8 into overtime (OT) when they are approved');
      end if;
      select coalesce(sum(te.hours), 0) into v_week from pm.time_entries te join core.jobs j on j.org_id = te.org_id and j.id = te.job_id
       where te.org_id = v_org and te.employee_id = emp.id and j.location_id = p_location and te.approval_state not in ('VOID','REJECTED')
         and te.work_date between v_day - (extract(isodow from v_day)::int - 1) and v_day;
      if v_week > 40 and v_week - v_hours <= 40 then
        v_flags := v_flags || jsonb_build_object('code', 'OVERTIME_WEEK', 'hours', v_week, 'message', format('Week reaches %s h on this day', v_week),
                                                 'fix', 'Hours over 40 this week are overtime');
      end if;
      if v_hours = 0 and exists (select 1 from pm.dispatch_assignments d join pm.work_orders w on w.org_id = d.org_id and w.id = d.work_order_id
                                  where d.org_id = v_org and d.employee_id = emp.id and w.location_id = p_location and d.status = 'DONE'
                                    and (lower(d.slot) at time zone v_tz)::date = v_day) then
        v_flags := v_flags || jsonb_build_object('code', 'NO_TIME', 'message', 'Visits were finished but no time was recorded', 'fix', 'Ask the tech to submit the day');
      end if;
      if v_day < current_date and exists (select 1 from jsonb_array_elements(v_entries) x where x ->> 'state' = 'DRAFT') then
        v_flags := v_flags || jsonb_build_object('code', 'NOT_SUBMITTED', 'message', 'Time is still in draft', 'fix', 'Remind the tech to submit the day');
      end if;
      if jsonb_array_length(v_entries) > 0 or jsonb_array_length(v_flags) > 0 then
        v_rows := v_rows || jsonb_build_object('employee_id', emp.id, 'employee', emp.name, 'day', v_day, 'hours', v_hours, 'entries', v_entries,
                                               'submitted_ids', to_jsonb(v_submitted), 'flags', v_flags, 'clean', jsonb_array_length(v_flags) = 0);
      end if;
      v_day := v_day + 1;
    end loop;
  end loop;
  return v_rows;
end $$;

-- ----------------------------------------------------------------------------
-- 17. Billing integrity auditor (FS-112)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_run_integrity(p_location uuid, p_since date default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_since date := coalesce(p_since, current_date - 90); v_run timestamptz := clock_timestamp(); r record;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then raise exception 'PM_FORBIDDEN: company not found' using errcode = '42501'; end if;
  -- completed visits not invoiced (customer pay, sold work, not a recall / agreement no-charge)
  for r in select w.id, w.job_id, w.number, coalesce(sum(l.amount_cents), 0) as amt
             from pm.work_orders w join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
            where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.payer_type = 'CUSTOMER' and not w.is_callback
              and w.completed_at < now() - interval '2 days' and w.completed_at::date >= v_since
              and not exists (select 1 from pm.fs_invoice_reviews rv where rv.org_id = w.org_id and rv.work_order_id = w.id and rv.billing_request_id is not null)
            group by w.id, w.job_id, w.number having coalesce(sum(l.amount_cents), 0) > 0 loop
    insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, amount_cents, last_seen_at)
    values (v_org, p_location, r.job_id, 'COMPLETED_NOT_INVOICED', 'work_orders', r.id, format('%s was completed but never invoiced', r.number), r.amt, v_run)
    on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run, amount_cents = excluded.amount_cents, detail = excluded.detail,
      status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
  end loop;
  -- cost with no billing at all (jobs with Books job cost and no invoice / deposit / agreement)
  for r in select j.id, coalesce(j.job_number, j.name) as ref, sum(c.amount_cents) as amt
             from core.jobs j join pm.job_costs c on c.org_id = j.org_id and c.job_id = j.id and c.lifecycle in ('PENDING','CLEARED')
            where j.org_id = v_org and j.location_id = p_location and c.occurred_on >= v_since and c.occurred_on < current_date - 7
              and not exists (select 1 from pm.billing_requests b where b.org_id = j.org_id and b.job_id = j.id and b.status <> 'VOID')
              and not exists (select 1 from pm.deposit_requests d where d.org_id = j.org_id and d.job_id = j.id and d.status <> 'VOID')
              and not exists (select 1 from pm.service_agreements a where a.org_id = j.org_id and a.job_id = j.id)
            group by j.id, j.job_number, j.name having sum(c.amount_cents) > 0 loop
    insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, amount_cents, last_seen_at)
    values (v_org, p_location, r.id, 'COST_NO_BILLING', 'jobs', r.id, format('Job %s has cost in Books but nothing billed', r.ref), r.amt, v_run)
    on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run, amount_cents = excluded.amount_cents,
      status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
  end loop;
  -- parts used but not billed, member pricing errors: the review rules, on every completed visit in range
  for r in select w.id, w.job_id, w.number, pm._fs_review_flags(w.id) as flags
             from pm.work_orders w
            where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.completed_at::date >= v_since loop
    if exists (select 1 from jsonb_array_elements(r.flags) x where x ->> 'code' = 'PARTS_NOT_BILLED') then
      insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, last_seen_at)
      values (v_org, p_location, r.job_id, 'PARTS_NOT_BILLED', 'work_orders', r.id,
              left(format('%s: %s', r.number, (select string_agg(x ->> 'message', '; ') from jsonb_array_elements(r.flags) x where x ->> 'code' = 'PARTS_NOT_BILLED')), 1000), v_run)
      on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run, detail = excluded.detail,
        status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
    end if;
    if exists (select 1 from jsonb_array_elements(r.flags) x where x ->> 'code' = 'MEMBER_DISCOUNT') then
      insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, last_seen_at)
      values (v_org, p_location, r.job_id, 'MEMBER_DISCOUNT', 'work_orders', r.id,
              left(format('%s: %s', r.number, (select string_agg(x ->> 'message', '; ') from jsonb_array_elements(r.flags) x where x ->> 'code' = 'MEMBER_DISCOUNT')), 1000), v_run)
      on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run, detail = excluded.detail,
        status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
    end if;
  end loop;
  -- recalls whose original tech's plan charges back (payroll must carry the chargeback)
  for r in select w.id, w.job_id, w.number, o.number as orig, coalesce(e.first_name, 'the tech') as tech
             from pm.work_orders w join pm.work_orders o on o.org_id = w.org_id and o.id = w.callback_of_id
             join pm.dispatch_assignments d on d.org_id = o.org_id and d.work_order_id = o.id and d.status <> 'CANCELLED' and d.is_lead
             join core.employees e on e.id = d.employee_id
             join pm.fs_pay_assignments pa on pa.org_id = w.org_id and pa.employee_id = d.employee_id and pa.location_id = w.location_id
             join pm.fs_pay_plans pl on pl.org_id = pa.org_id and pl.id = pa.pay_plan_id and pl.recall_chargeback_pct > 0
            where w.org_id = v_org and w.location_id = p_location and w.is_callback and w.created_at::date >= v_since loop
    insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, last_seen_at)
    values (v_org, p_location, r.job_id, 'CALLBACK_NO_CHARGEBACK', 'work_orders', r.id,
            format('Recall %s of %s: confirm %s''s callback chargeback is in this pay run', r.number, r.orig, r.tech), v_run)
    on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run;
  end loop;
  -- installs complete but not billed
  for r in select p.id, p.job_id, p.number, p.contract_cents from pm.fs_install_projects p
            where p.org_id = v_org and p.location_id = p_location and p.stage in ('INSTALLED','INSPECTED','CLOSED') and p.final_billing_request_id is null
              and not exists (select 1 from pm.fs_financed_sales f where f.org_id = p.org_id and f.estimate_id = p.estimate_id and f.status = 'FUNDED') loop
    insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, amount_cents, last_seen_at)
    values (v_org, p_location, r.job_id, 'INSTALL_NOT_BILLED', 'fs_install_projects', r.id, format('%s is installed but the final invoice was not requested', r.number),
            r.contract_cents, v_run)
    on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run, amount_cents = excluded.amount_cents,
      status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
  end loop;
  -- reviews sitting more than 3 days
  for r in select rv.id, rv.job_id, w.number from pm.fs_invoice_reviews rv join pm.work_orders w on w.id = rv.work_order_id
            where rv.org_id = v_org and rv.location_id = p_location and rv.status in ('PENDING','FLAGGED','RETURNED') and rv.created_at < now() - interval '3 days' loop
    insert into pm.fs_integrity_findings as f (org_id, location_id, job_id, kind, subject_table, subject_id, detail, last_seen_at)
    values (v_org, p_location, r.job_id, 'REVIEW_STUCK', 'fs_invoice_reviews', r.id, format('The invoice for %s has waited in review for more than 3 days', r.number), v_run)
    on conflict (org_id, kind, subject_id) do update set last_seen_at = v_run,
      status = case when f.status = 'RESOLVED' then 'OPEN' else f.status end, resolved_at = null;
  end loop;
  -- what is no longer found is resolved
  update pm.fs_integrity_findings set status = 'RESOLVED', resolved_at = now()
   where org_id = v_org and location_id = p_location and status in ('OPEN','TASKED') and last_seen_at < v_run;
  return coalesce((select jsonb_object_agg(k.kind, k.n) from (select f.kind, count(*) as n from pm.fs_integrity_findings f
                     where f.org_id = v_org and f.location_id = p_location and f.status in ('OPEN','TASKED') group by f.kind) k), '{}'::jsonb);
end $$;

create or replace function pm.fs_task_finding(p_finding uuid, p_assignee_user text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.fs_integrity_findings%rowtype; v_task uuid;
begin
  select * into f from pm.fs_integrity_findings x where x.id = p_finding and x.org_id = public.get_org_id() for update;
  if f.id is null then raise exception 'PM_FORBIDDEN: finding not found' using errcode = '42501'; end if;
  if f.job_id is null then raise exception 'PM_INVALID: this finding is not on a job' using errcode = '22023'; end if;
  if f.task_id is not null then return f.task_id; end if;
  insert into pm.tasks (org_id, job_id, title, description, assignee_user_id, due_on, ext)
  values (f.org_id, f.job_id, left('Billing fix: ' || f.detail, 200), f.detail, p_assignee_user, current_date + 2,
          jsonb_build_object('_fs_finding_id', f.id))
  returning id into v_task;
  update pm.fs_integrity_findings set status = 'TASKED', task_id = v_task where id = f.id;
  return v_task;
end $$;

create or replace function pm.fs_dismiss_finding(p_finding uuid, p_reason text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.fs_integrity_findings%rowtype;
begin
  select * into f from pm.fs_integrity_findings x where x.id = p_finding and x.org_id = public.get_org_id() for update;
  if f.id is null then raise exception 'PM_FORBIDDEN: finding not found' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PM_INVALID: say why it is not a leak' using errcode = '22023'; end if;
  update pm.fs_integrity_findings set status = 'DISMISSED', dismissed_reason = left(btrim(p_reason), 500) where id = f.id;
  return f.id;
end $$;

-- ----------------------------------------------------------------------------
-- 18. Role dashboards (FS-109) and the metric catalog for plain-language Q&A (FS-110)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_metric(p_location uuid, p_metric text, p_from date default null, p_to date default null, p_threshold numeric default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id(); v_from date := coalesce(p_from, date_trunc('month', current_date)::date); v_to date := coalesce(p_to, current_date);
  v_c boolean := pm.can('projects.contract_value', 'view', p_location); v_f boolean := pm.can('projects.financials', 'view', p_location);
  v_rows jsonb := '[]'; v_value numeric; v_label text; v_unit text := 'count'; v_money_cap text;
begin
  case p_metric
  when 'unbilled_jobs' then
    v_label := 'Completed visits not invoiced';
    select coalesce(jsonb_agg(jsonb_build_object('label', w.number || ' · ' || w.summary, 'ref_table', 'work_orders', 'ref_id', w.id, 'job_id', w.job_id)), '[]'::jsonb)
      into v_rows from pm.work_orders w
     where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.payer_type = 'CUSTOMER' and not w.is_callback
       and w.completed_at::date between v_from and v_to and w.job_id in (select pm.my_job_ids())
       and exists (select 1 from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.amount_cents > 0)
       and not exists (select 1 from pm.fs_invoice_reviews rv where rv.org_id = w.org_id and rv.work_order_id = w.id and rv.billing_request_id is not null);
  when 'open_estimates' then
    v_label := format('Open estimates older than %s days', coalesce(p_threshold, 3));
    select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(e.number, '') || ' · ' || e.title, 'ref_table', 'fs_estimates', 'ref_id', e.id, 'job_id', e.job_id,
                                                 'value', current_date - e.presented_at::date)), '[]'::jsonb)
      into v_rows from pm.fs_estimates e
     where e.org_id = v_org and e.location_id = p_location and e.status = 'PRESENTED' and e.presented_at::date <= current_date - coalesce(p_threshold, 3)::int
       and e.job_id in (select pm.my_job_ids());
  when 'close_rate_by_advisor' then
    -- nested report RPCs skip their own guard: check the caller's read right here (audit)
    if not (pm.can('projects.leads', 'view', p_location) or pm.can('projects.reports', 'view', p_location) or pm.can('projects.estimates', 'view', p_location)) then
      raise exception 'PM_FORBIDDEN: close rates require projects.leads, reports or estimates view' using errcode = '42501';
    end if;
    v_label := 'Close rate by comfort advisor'; v_unit := 'ratio';
    v_rows := pm.fs_advisor_pipeline(p_location, v_from, v_to) -> 'by_advisor';
  when 'recalls_by_tech' then
    v_label := 'Recalls by original technician';
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
      select coalesce(e.first_name || ' ' || coalesce(e.last_name, ''), 'Unassigned') as label, count(*)::int as value, 'employees' as ref_table, e.id as ref_id
        from pm.work_orders w join pm.work_orders o on o.org_id = w.org_id and o.id = w.callback_of_id
        left join pm.dispatch_assignments d on d.org_id = o.org_id and d.work_order_id = o.id and d.is_lead and d.status <> 'CANCELLED'
        left join core.employees e on e.id = d.employee_id
       where w.org_id = v_org and w.location_id = p_location and w.is_callback and w.created_at::date between v_from and v_to
       group by e.id, e.first_name, e.last_name order by 2 desc) x;
  when 'deferred_revenue' then
    v_label := 'Agreement deferred revenue'; v_unit := 'cents'; v_money_cap := 'projects.financials';
    if v_f then
      select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(d.number, '') || ' · ' || d.plan_name, 'ref_table', 'service_agreements', 'ref_id', d.agreement_id,
                                                   'value', d.deferred_cents, 'visits_owed', greatest(d.visits_included - d.visits_delivered, 0))), '[]'::jsonb)
        into v_rows from pm.v_fs_agreement_deferred d where d.org_id = v_org and d.location_id = p_location and d.deferred_cents <> 0;
    end if;
  when 'unfunded_financing' then
    if not (pm.can('projects.billing', 'view', p_location) or pm.can('projects.financials', 'view', p_location) or pm.can('projects.reports', 'view', p_location)) then
      raise exception 'PM_FORBIDDEN: financing requires projects.billing, financials or reports view' using errcode = '42501';
    end if;
    v_label := 'Financed sales not funded yet';
    v_rows := coalesce((select jsonb_agg(jsonb_build_object('label', coalesce(r ->> 'estimate_number', '') || ' · ' || coalesce(r ->> 'provider', ''), 'ref_table', 'fs_financed_sales',
                                                       'ref_id', r ->> 'id', 'value', (r ->> 'days_outstanding')::int, 'chase', (r ->> 'chase')::boolean))
                          from jsonb_array_elements(pm.fs_financing_recon(p_location, v_to) -> 'rows') r where r ->> 'status' not in ('FUNDED','CANCELLED')), '[]'::jsonb);
  when 'low_margin_jobs' then
    v_label := format('Sold jobs under %s%% margin', round(coalesce(p_threshold, 0.40) * 100)); v_unit := 'ratio'; v_money_cap := 'projects.financials';
    if v_f then
      select coalesce(jsonb_agg(x order by x.value), '[]'::jsonb) into v_rows from (
        select w.number || ' · ' || w.summary as label, 'work_orders' as ref_table, w.id as ref_id, w.job_id,
               round((sum(l.amount_cents) - sum(round(l.qty * coalesce(l.unit_cost_cents, 0))))::numeric / nullif(sum(l.amount_cents), 0), 4) as value
          from pm.work_orders w join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
         where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between v_from and v_to
         group by w.id, w.number, w.summary, w.job_id
        having sum(l.amount_cents) > 0
           and (sum(l.amount_cents) - sum(round(l.qty * coalesce(l.unit_cost_cents, 0))))::numeric / sum(l.amount_cents) < coalesce(p_threshold, 0.40)) x;
    end if;
  when 'revenue_by_bu' then
    v_label := 'Revenue by business unit'; v_unit := 'cents'; v_money_cap := 'projects.contract_value';
    if v_c then
      select coalesce(jsonb_agg(x order by x.value desc), '[]'::jsonb) into v_rows from (
        select coalesce(bu.name, 'No business unit') as label, 'business_units' as ref_table, bu.id as ref_id, sum(l.amount_cents)::bigint as value
          from pm.work_orders w join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
          left join pm.business_units bu on bu.org_id = w.org_id and bu.id = w.business_unit_id
         where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between v_from and v_to
         group by bu.id, bu.name) x;
    end if;
  when 'memberships_expiring' then
    v_label := 'Memberships expiring in 60 days';
    select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(a.number, '') || ' · ' || a.plan_name, 'ref_table', 'service_agreements', 'ref_id', a.id,
                                                 'value', a.ends_on - current_date, 'auto_renew', a.auto_renew)), '[]'::jsonb)
      into v_rows from pm.service_agreements a
     where a.org_id = v_org and a.location_id = p_location and a.status = 'ACTIVE' and a.ends_on between current_date and current_date + 60;
  when 'installs_stuck' then
    if not (pm.can('projects.dispatch', 'view', p_location) or pm.can('projects.jobs', 'view', p_location)) then
      raise exception 'PM_FORBIDDEN: installs require projects.dispatch or jobs view' using errcode = '42501';
    end if;
    v_label := 'Installs stuck in a stage';
    v_rows := coalesce((select jsonb_agg(jsonb_build_object('label', (b ->> 'number') || ' · ' || (b ->> 'stage'), 'ref_table', 'fs_install_projects', 'ref_id', b ->> 'id',
                                                       'value', (b ->> 'days_in_stage')::int))
                          from jsonb_array_elements(pm.fs_install_board(p_location)) b where (b ->> 'stuck')::boolean), '[]'::jsonb);
  when 'permits_pending' then
    v_label := 'Install permits not issued';
    select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(p.number, '') || ' · ' || coalesce(r.authority, r.kind) || ' · ' || lower(r.status),
                                                 'ref_table', 'res_permits', 'ref_id', r.id, 'job_id', r.job_id)), '[]'::jsonb)
      into v_rows from pm.res_permits r join pm.fs_install_projects p on p.org_id = r.org_id and p.job_id = r.job_id
     where r.org_id = v_org and p.location_id = p_location and r.status in ('NOT_STARTED','APPLIED') and p.stage not in ('CLOSED','CANCELLED');
  when 'unconfirmed_visits' then
    v_label := 'Visits tomorrow not confirmed';
    select coalesce(jsonb_agg(jsonb_build_object('label', w.number || ' · ' || w.summary, 'ref_table', 'work_orders', 'ref_id', w.id, 'job_id', w.job_id,
                                                 'confirmation', w.customer_confirmation)), '[]'::jsonb)
      into v_rows from pm.work_orders w
     where w.org_id = v_org and w.location_id = p_location and w.status in ('NEW','SCHEDULED','DISPATCHED')
       and coalesce(w.service_day, (coalesce(w.requested_start, w.scheduled_start))::date) = current_date + 1
       and coalesce(w.customer_confirmation, '') <> 'CONFIRMED';
  when 'missed_calls' then
    v_label := 'Missed calls';
    select coalesce(jsonb_agg(jsonb_build_object('label', coalesce(l.from_number, 'Unknown') || ' · ' || to_char(l.started_at, 'Mon FMDD HH12:MI am'),
                                                 'ref_table', 'fs_call_log', 'ref_id', l.id, 'customer_id', l.customer_id)), '[]'::jsonb)
      into v_rows from pm.fs_call_log l
     where l.org_id = v_org and l.location_id = p_location and l.outcome in ('MISSED','ABANDONED','VOICEMAIL') and l.started_at::date between v_from and v_to;
  when 'timesheet_exceptions' then
    v_label := 'Timesheet exceptions';
    if pm.can('projects.time', 'approve', p_location) then
      v_rows := coalesce((select jsonb_agg(jsonb_build_object('label', (t ->> 'employee') || ' · ' || (t ->> 'day'), 'ref_table', 'employees', 'ref_id', t ->> 'employee_id',
                                                         'value', jsonb_array_length(t -> 'flags')))
                            from jsonb_array_elements(pm.fs_timesheet_exceptions(p_location, greatest(v_from, v_to - 13), v_to)) t
                           where jsonb_array_length(t -> 'flags') > 0), '[]'::jsonb);
    end if;
  else
    raise exception 'PM_INVALID: unknown metric %', p_metric using errcode = '22023';
  end case;
  v_value := case when v_unit = 'cents' then (select coalesce(sum((r ->> 'value')::numeric), 0) from jsonb_array_elements(v_rows) r)
                  else jsonb_array_length(v_rows) end;
  return jsonb_build_object('metric', p_metric, 'label', v_label, 'unit', v_unit, 'from', v_from, 'to', v_to, 'value', v_value, 'rows', v_rows,
                            'masked', v_money_cap is not null and not pm.can(v_money_cap, 'view', p_location));
end $$;

create or replace function pm.fs_dashboard(p_location uuid, p_role text, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id(); v_from date := coalesce(p_from, date_trunc('month', current_date)::date); v_to date := coalesce(p_to, current_date);
  v_c boolean := pm.can('projects.contract_value', 'view', p_location); v_f boolean := pm.can('projects.financials', 'view', p_location);
  v jsonb := '{}'; v_role text := lower(coalesce(p_role, 'gm')); v_n bigint; v_m bigint; v_rev bigint; v_cost bigint;
begin
  if v_role not in ('gm','dispatcher','service_manager','install_pm') then raise exception 'PM_INVALID: unknown dashboard' using errcode = '22023'; end if;
  v := jsonb_build_object('role', v_role, 'from', v_from, 'to', v_to);
  if v_role = 'gm' then
    select coalesce(sum(l.amount_cents), 0), coalesce(sum(round(l.qty * coalesce(l.unit_cost_cents, 0))), 0) into v_rev, v_cost
      from pm.work_orders w join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
     where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between v_from and v_to;
    v := v || jsonb_build_object(
      'revenue_cents', case when v_c then v_rev end,
      'gross_margin_cents', case when v_c and v_f then v_rev - v_cost end,
      'gross_margin_pct', case when v_c and v_f and v_rev > 0 then round((v_rev - v_cost)::numeric / v_rev, 4) end,
      'revenue_by_bu', case when v_c then pm.fs_metric(p_location, 'revenue_by_bu', v_from, v_to) -> 'rows' end,
      'memberships_active', (select count(*) from pm.service_agreements a where a.org_id = v_org and a.location_id = p_location and a.status = 'ACTIVE'),
      'memberships_new', (select count(*) from pm.service_agreements a where a.org_id = v_org and a.location_id = p_location and a.activated_at::date between v_from and v_to),
      'memberships_lost', (select count(*) from pm.service_agreements a where a.org_id = v_org and a.location_id = p_location
                             and ((a.status = 'CANCELLED' and a.cancelled_at::date between v_from and v_to) or (a.status = 'EXPIRED' and a.ends_on between v_from and v_to))),
      'unbilled_visits', (pm.fs_metric(p_location, 'unbilled_jobs', v_from - 60, v_to) ->> 'value')::int,
      'unfunded_financing', case when pm.can('projects.billing', 'view', p_location) or pm.can('projects.financials', 'view', p_location)
                                   or pm.can('projects.reports', 'view', p_location) then (pm.fs_financing_recon(p_location, v_to) ->> 'unfunded')::int end,
      'open_findings', (select count(*) from pm.fs_integrity_findings f where f.org_id = v_org and f.location_id = p_location and f.status in ('OPEN','TASKED')));
  elsif v_role = 'dispatcher' then
    v := v || jsonb_build_object(
      'unassigned_today', (select count(*) from pm.work_orders w where w.org_id = v_org and w.location_id = p_location and w.status in ('NEW','SCHEDULED')
                             and coalesce(w.service_day, w.requested_start::date) = current_date
                             and not exists (select 1 from pm.dispatch_assignments d where d.org_id = w.org_id and d.work_order_id = w.id and d.status <> 'CANCELLED')),
      'booked_today', (select count(*) from pm.work_orders w where w.org_id = v_org and w.location_id = p_location and coalesce(w.service_day, w.requested_start::date) = current_date
                         and w.status not in ('CANCELLED')),
      'capacity_today', (select coalesce(sum(c.max_jobs), 0) from pm.capacity_limits c where c.org_id = v_org and c.location_id = p_location and c.zone_id is null
                           and (c.on_date = current_date or (c.on_date is null and (c.day_of_week is null or c.day_of_week = extract(isodow from current_date)::int)))),
      'late_techs', coalesce((select jsonb_agg(jsonb_build_object('work_order', w.number, 'employee_id', d.employee_id, 'since', lower(d.slot)))
                                from pm.dispatch_assignments d join pm.work_orders w on w.org_id = d.org_id and w.id = d.work_order_id
                               where d.org_id = v_org and w.location_id = p_location and d.status in ('ASSIGNED','DISPATCHED','EN_ROUTE')
                                 and lower(d.slot) < now() - interval '15 minutes' and lower(d.slot)::date = current_date), '[]'::jsonb),
      'unconfirmed_tomorrow', (pm.fs_metric(p_location, 'unconfirmed_visits') ->> 'value')::int,
      'reschedule_requests', (select count(*) from pm.work_orders w where w.org_id = v_org and w.location_id = p_location
                                and w.customer_confirmation in ('RESCHEDULE_REQUESTED','CANCEL_REQUESTED') and w.status in ('NEW','SCHEDULED','DISPATCHED')),
      'unread_threads', (select count(*) from pm.fs_threads t where t.org_id = v_org and t.location_id = p_location and t.status = 'OPEN' and t.unread_count > 0),
      'missed_calls_today', (pm.fs_metric(p_location, 'missed_calls', current_date, current_date) ->> 'value')::int,
      'requests_waiting', (select count(*) from pm.service_calls s where s.org_id = v_org and s.location_id = p_location and s.status = 'REQUEST'));
  elsif v_role = 'service_manager' then
    select count(*) filter (where e.status = 'SOLD'), count(*) filter (where e.status in ('SOLD','DECLINED','PRESENTED','EXPIRED')) into v_n, v_m
      from pm.fs_estimates e where e.org_id = v_org and e.location_id = p_location and coalesce(e.presented_at, e.created_at)::date between v_from and v_to;
    select coalesce(sum(l.amount_cents), 0), count(distinct w.id) into v_rev, v_cost
      from pm.work_orders w join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
     where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between v_from and v_to;
    v := v || jsonb_build_object(
      'conversion', case when v_m > 0 then round(v_n::numeric / v_m, 4) end, 'estimates_sold', v_n, 'estimates_presented', v_m,
      'average_ticket_cents', case when v_c and v_cost > 0 then (v_rev / v_cost) end,
      'recalls', (select count(*) from pm.work_orders w where w.org_id = v_org and w.location_id = p_location and w.is_callback and w.created_at::date between v_from and v_to),
      'open_estimates_over_3_days', (pm.fs_metric(p_location, 'open_estimates', null, null, 3) ->> 'value')::int,
      'followup_calls_due', (select count(*) from pm.fs_estimate_followups f where f.org_id = v_org and f.location_id = p_location and f.status = 'DUE'),
      'timesheet_exceptions', (pm.fs_metric(p_location, 'timesheet_exceptions', current_date - 6, current_date) ->> 'value')::int,
      'reviews_waiting', (select count(*) from pm.fs_invoice_reviews r where r.org_id = v_org and r.location_id = p_location and r.status in ('PENDING','FLAGGED','RETURNED')));
  else
    v := v || jsonb_build_object(
      'by_stage', coalesce((select jsonb_object_agg(x.stage, x.n) from (select p.stage, count(*) as n from pm.fs_install_projects p
                             where p.org_id = v_org and p.location_id = p_location and p.stage not in ('CLOSED','CANCELLED') group by p.stage) x), '{}'::jsonb),
      'stuck', case when pm.can('projects.dispatch', 'view', p_location) or pm.can('projects.jobs', 'view', p_location)
                    then (pm.fs_metric(p_location, 'installs_stuck') ->> 'value')::int end,
      'permits_pending', (pm.fs_metric(p_location, 'permits_pending') ->> 'value')::int,
      'installs_next_7_days', (select count(distinct d.project_id) from pm.fs_install_crew_days d where d.org_id = v_org and d.location_id = p_location
                                 and d.status = 'PLANNED' and d.work_date between current_date and current_date + 7),
      'pipeline_cents', case when v_c then (select coalesce(sum(p.contract_cents), 0) from pm.fs_install_projects p where p.org_id = v_org and p.location_id = p_location
                                             and p.stage not in ('CLOSED','CANCELLED')) end,
      'closed_margin_pct', case when v_f and v_c then (select round(avg((p.contract_cents - p.est_cost_cents)::numeric / nullif(p.contract_cents, 0)), 4)
                                                        from pm.fs_install_projects p where p.org_id = v_org and p.location_id = p_location and p.stage = 'CLOSED'
                                                         and p.closed_at::date between v_from and v_to) end);
  end if;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- 19. Guided setup, shadow run (FS-117) and the completion seed
-- ----------------------------------------------------------------------------
create or replace function pm.fs_setup_status(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
  function_rows jsonb;
begin
  function_rows := jsonb_build_array(
    jsonb_build_object('key', 'business_units', 'label', 'Business units', 'href', '/pricebook', 'count', (select count(*) from pm.business_units x where x.org_id = v_org and x.location_id = p_location)),
    jsonb_build_object('key', 'job_types', 'label', 'Bookable job types with scripts', 'href', '/calls', 'count', (select count(*) from pm.booking_job_types x where x.org_id = v_org and x.location_id = p_location and x.is_active)),
    jsonb_build_object('key', 'zones', 'label', 'Service zones', 'href', '/dispatch/capacity', 'count', (select count(*) from pm.service_zones x where x.org_id = v_org and x.location_id = p_location)),
    jsonb_build_object('key', 'windows', 'label', 'Arrival windows', 'href', '/dispatch/capacity', 'count', (select count(*) from pm.arrival_windows x where x.org_id = v_org and x.location_id = p_location and x.is_active)),
    jsonb_build_object('key', 'capacity', 'label', 'Capacity per window', 'href', '/dispatch/capacity', 'count', (select count(*) from pm.capacity_limits x where x.org_id = v_org and x.location_id = p_location)),
    jsonb_build_object('key', 'pricebook', 'label', 'Priced price book', 'href', '/pricebook', 'count', (select count(*) from pm.price_book_items x where x.org_id = v_org and x.location_id = p_location and x.is_active and x.price_cents > 0)),
    jsonb_build_object('key', 'techs', 'label', 'Technicians on the board', 'href', '/dispatch', 'count', (select count(*) from pm.tech_profiles x where x.org_id = v_org and x.location_id = p_location)),
    jsonb_build_object('key', 'pay_plans', 'label', 'Pay plans', 'href', '/dispatch/scorecards', 'count', (select count(*) from pm.fs_pay_plans x where x.org_id = v_org and x.location_id = p_location and x.is_active)),
    jsonb_build_object('key', 'agreements', 'label', 'Membership plans', 'href', '/agreements', 'count', (select count(*) from pm.agreement_templates x where x.org_id = v_org and x.location_id = p_location)),
    jsonb_build_object('key', 'forms', 'label', 'Checklists with readings', 'href', '/pricebook/forms', 'count', (select count(*) from pm.fs_form_templates x where x.org_id = v_org and x.location_id = p_location and x.is_active)),
    jsonb_build_object('key', 'texting', 'label', 'Texting number verified', 'href', '/settings', 'count', (select count(*) from core.sms_sender_numbers x where x.org_id = v_org and x.status = 'verified' and (x.location_id is null or x.location_id = p_location))),
    jsonb_build_object('key', 'phones', 'label', 'Phone system connected', 'href', '/calls/log', 'count', (select count(*) from pm.fs_phone_providers x where x.org_id = v_org and x.location_id = p_location and x.status = 'ACTIVE')),
    jsonb_build_object('key', 'imports', 'label', 'Customers, equipment and agreements imported', 'href', '/setup', 'count', (select count(*) from pm.import_batches x where x.org_id = v_org and x.location_id = p_location and x.status = 'COMMITTED')),
    jsonb_build_object('key', 'first_job', 'label', 'First job booked', 'href', '/calls', 'count', (select count(*) from pm.service_calls x where x.org_id = v_org and x.location_id = p_location and x.status = 'BOOKED')),
    jsonb_build_object('key', 'go_live', 'label', 'Customer messages live', 'href', '/settings', 'count', case when coalesce((core.notify_settings_row(v_org, p_location)).customer_messages_live, false) then 1 else 0 end),
    jsonb_build_object('key', 'shadow_run', 'label', 'Shadow-run days matched', 'href', '/dispatch/go-live', 'count', (select count(*) from pm.fs_shadow_runs x where x.org_id = v_org and x.location_id = p_location and x.status = 'MATCH')));
  return jsonb_build_object('steps', (select jsonb_agg(s || jsonb_build_object('done', (s ->> 'count')::int > 0)) from jsonb_array_elements(function_rows) s),
                            'done', (select count(*) from jsonb_array_elements(function_rows) s where (s ->> 'count')::int > 0),
                            'total', jsonb_array_length(function_rows));
end $$;

-- One shadow-run day: what the old system said vs what Merit recorded (FS-117).
create or replace function pm.fs_record_shadow_day(p_location uuid, p_day date, p_legacy jsonb, p_system text default 'OTHER', p_notes text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_jobs int; v_rev bigint; v_pay bigint; v_mem int; v_est int; v_id uuid; v_status text; l jsonb := coalesce(p_legacy, '{}'::jsonb);
  v_tz text;
begin
  if not exists (select 1 from core.locations x where x.id = p_location and x.org_id = v_org) then raise exception 'PM_INVALID: company not found' using errcode = '22023'; end if;
  if p_day is null or p_day > current_date then raise exception 'PM_INVALID: pick a day that has happened' using errcode = '22023'; end if;
  select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = v_org and s.location_id = p_location;
  v_tz := coalesce(v_tz, 'America/Chicago');
  select count(*) into v_jobs from pm.work_orders w where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED')
     and (w.completed_at at time zone v_tz)::date = p_day;
  select coalesce(sum(l2.amount_cents), 0) into v_rev from pm.work_orders w join pm.work_order_lines l2 on l2.org_id = w.org_id and l2.work_order_id = w.id
   where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED') and l2.status = 'APPROVED' and l2.pay_type = 'CUSTOMER'
     and (w.completed_at at time zone v_tz)::date = p_day;
  select coalesce(sum(pa.amount_cents), 0) into v_pay from public.payment_applications pa join public.customer_payments cp on cp.id = pa.payment_id
    join public.invoices i on i.id = pa.invoice_id
   where i.org_id = v_org and i.location_id = p_location and cp.payment_date = p_day;
  select count(*) into v_mem from pm.service_agreements a where a.org_id = v_org and a.location_id = p_location and (a.activated_at at time zone v_tz)::date = p_day;
  select count(*) into v_est from pm.fs_estimates e where e.org_id = v_org and e.location_id = p_location and (e.sold_at at time zone v_tz)::date = p_day;
  v_status := case when coalesce((l ->> 'jobs')::int, 0) = v_jobs and abs(coalesce((l ->> 'revenue_cents')::bigint, 0) - v_rev) <= 100
                         and abs(coalesce((l ->> 'payments_cents')::bigint, 0) - v_pay) <= 100 and coalesce((l ->> 'memberships')::int, 0) = v_mem
                         and coalesce((l ->> 'estimates_sold')::int, 0) = v_est then 'MATCH' else 'VARIANCE' end;
  insert into pm.fs_shadow_runs as s (org_id, location_id, run_day, legacy_system, legacy_jobs, legacy_revenue_cents, legacy_payments_cents, legacy_memberships,
                                      legacy_estimates_sold, merit_jobs, merit_revenue_cents, merit_payments_cents, merit_memberships, merit_estimates_sold, status, notes)
  values (v_org, p_location, p_day, left(upper(coalesce(p_system, 'OTHER')), 40), coalesce((l ->> 'jobs')::int, 0), coalesce((l ->> 'revenue_cents')::bigint, 0),
          coalesce((l ->> 'payments_cents')::bigint, 0), coalesce((l ->> 'memberships')::int, 0), coalesce((l ->> 'estimates_sold')::int, 0),
          v_jobs, v_rev, v_pay, v_mem, v_est, v_status, left(p_notes, 2000))
  on conflict (org_id, location_id, run_day) do update set legacy_system = excluded.legacy_system, legacy_jobs = excluded.legacy_jobs,
    legacy_revenue_cents = excluded.legacy_revenue_cents, legacy_payments_cents = excluded.legacy_payments_cents, legacy_memberships = excluded.legacy_memberships,
    legacy_estimates_sold = excluded.legacy_estimates_sold, merit_jobs = excluded.merit_jobs, merit_revenue_cents = excluded.merit_revenue_cents,
    merit_payments_cents = excluded.merit_payments_cents, merit_memberships = excluded.merit_memberships, merit_estimates_sold = excluded.merit_estimates_sold,
    status = excluded.status, notes = coalesce(excluded.notes, s.notes), recorded_by = pm.current_user_id()
  returning s.id into v_id;
  return jsonb_build_object('id', v_id, 'status', v_status, 'merit', jsonb_build_object('jobs', v_jobs, 'revenue_cents', v_rev, 'payments_cents', v_pay,
                            'memberships', v_mem, 'estimates_sold', v_est));
end $$;

create or replace function pm.fs_shadow_report(p_location uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_c boolean := pm.can('projects.contract_value', 'view', p_location);
begin
  return jsonb_build_object('days', coalesce((select jsonb_agg(jsonb_build_object(
      'day', s.run_day, 'system', s.legacy_system, 'status', s.status, 'notes', s.notes,
      'legacy', jsonb_build_object('jobs', s.legacy_jobs, 'memberships', s.legacy_memberships, 'estimates_sold', s.legacy_estimates_sold,
                                   'revenue_cents', case when v_c then s.legacy_revenue_cents end, 'payments_cents', case when v_c then s.legacy_payments_cents end),
      'merit', jsonb_build_object('jobs', s.merit_jobs, 'memberships', s.merit_memberships, 'estimates_sold', s.merit_estimates_sold,
                                  'revenue_cents', case when v_c then s.merit_revenue_cents end, 'payments_cents', case when v_c then s.merit_payments_cents end),
      'diff', jsonb_build_object('jobs', s.merit_jobs - s.legacy_jobs, 'memberships', s.merit_memberships - s.legacy_memberships,
                                 'estimates_sold', s.merit_estimates_sold - s.legacy_estimates_sold,
                                 'revenue_cents', case when v_c then s.merit_revenue_cents - s.legacy_revenue_cents end,
                                 'payments_cents', case when v_c then s.merit_payments_cents - s.legacy_payments_cents end))
      order by s.run_day)
      from pm.fs_shadow_runs s where s.org_id = v_org and s.location_id = p_location
       and s.run_day between coalesce(p_from, current_date - 14) and coalesce(p_to, current_date)), '[]'::jsonb),
    'matched_days', (select count(*) from pm.fs_shadow_runs s where s.org_id = v_org and s.location_id = p_location and s.status = 'MATCH'
                       and s.run_day between coalesce(p_from, current_date - 14) and coalesce(p_to, current_date)));
end $$;

-- Equipment from the field (nameplate photo → make / model / serial / manufacture date; FS-36 parity on the phone).
create or replace function pm.fs_upsert_equipment(p_wo uuid, p_asset uuid, p_fields jsonb, p_nameplate_document uuid default null, p_command uuid default null,
                                                   p_nameplate_photo uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cust uuid; v_id uuid := p_asset; f jsonb := coalesce(p_fields, '{}'::jsonb); a pm.assets%rowtype; v_seen jsonb; s core.sites%rowtype;
  v_doc uuid; v_plate text;
begin
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = public.get_org_id();
  if w.id is null then raise exception 'PM_FORBIDDEN: visit not found' using errcode = '42501'; end if;
  if p_command is not null then
    v_seen := pm._fs_cmd_seen(w.org_id, p_command, 'fs.equipment.upsert');
    if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  end if;
  -- The nameplate photo: a document of this org on this job (or a job at this site). A document id
  -- that fails the check is refused; a photo command whose upload has not arrived yet is PENDING.
  if p_nameplate_document is not null then
    v_doc := pm._fs_field_photo_doc(w.org_id, w.job_id, w.site_id, null, p_nameplate_document);
    if v_doc is null then raise exception 'PM_INVALID: that nameplate photo is not on this job' using errcode = '22023'; end if;
    v_plate := 'ATTACHED';
  elsif p_nameplate_photo is not null then
    v_doc := pm._fs_field_photo_doc(w.org_id, w.job_id, w.site_id, p_nameplate_photo, null);
    v_plate := case when v_doc is null then 'PENDING' else 'ATTACHED' end;
  end if;
  select j.customer_id into v_cust from core.jobs j where j.id = w.job_id;
  if v_id is not null then
    select * into a from pm.assets x where x.id = v_id and x.org_id = w.org_id and x.location_id = w.location_id
       and ((v_cust is not null and x.customer_id = v_cust) or (w.site_id is not null and x.site_id = w.site_id));
    if a.id is null then raise exception 'PM_INVALID: that equipment is not at this customer or site' using errcode = '22023'; end if;
    update pm.assets set make = coalesce(nullif(btrim(coalesce(f ->> 'make', '')), ''), make), model = coalesce(nullif(btrim(coalesce(f ->> 'model', '')), ''), model),
           serial_number = coalesce(nullif(btrim(coalesce(f ->> 'serial', '')), ''), serial_number),
           equipment_type = coalesce(nullif(f ->> 'equipment_type', ''), equipment_type), manufactured_on = coalesce(nullif(f ->> 'manufactured_on', '')::date, manufactured_on),
           tonnage = coalesce(nullif(f ->> 'tonnage', '')::numeric, tonnage), refrigerant_type = coalesce(nullif(f ->> 'refrigerant_type', ''), refrigerant_type),
           fuel_type = coalesce(nullif(f ->> 'fuel_type', ''), fuel_type), nameplate_document_id = coalesce(v_doc, nameplate_document_id),
           last_service_on = current_date
     where id = v_id;
  else
    if nullif(btrim(coalesce(f ->> 'make', '')), '') is null and nullif(btrim(coalesce(f ->> 'serial', '')), '') is null then
      raise exception 'PM_INVALID: read at least the make or serial from the nameplate' using errcode = '22023';
    end if;
    select * into s from core.sites x where x.id = w.site_id;
    insert into pm.assets (org_id, location_id, kind, customer_id, make, model, serial_number, equipment_type, manufactured_on, tonnage, refrigerant_type, fuel_type,
                           nameplate_document_id, site_id, site_address_line1, site_city, site_state, site_zip, last_service_on, description)
    values (w.org_id, w.location_id, 'CUSTOMER_EQUIPMENT', v_cust, left(nullif(btrim(coalesce(f ->> 'make', '')), ''), 80), left(nullif(btrim(coalesce(f ->> 'model', '')), ''), 80),
            left(nullif(btrim(coalesce(f ->> 'serial', '')), ''), 80), nullif(f ->> 'equipment_type', ''), nullif(f ->> 'manufactured_on', '')::date,
            nullif(f ->> 'tonnage', '')::numeric, nullif(f ->> 'refrigerant_type', ''), nullif(f ->> 'fuel_type', ''), v_doc, w.site_id,
            s.address_line1, s.city, s.state, s.zip, current_date, left(coalesce(f ->> 'equipment_type', 'Equipment'), 300))
    returning id into v_id;
  end if;
  select * into a from pm.assets x where x.id = v_id;
  return pm._fs_cmd_done(w.org_id, p_command, 'fs.equipment.upsert', v_id, jsonb_build_object(
    'asset_id', v_id,
    'age_years', case when coalesce(a.installed_on, a.manufactured_on) is not null then extract(year from age(current_date, coalesce(a.installed_on, a.manufactured_on)))::int end,
    'parts_covered', coalesce(a.parts_warranty_ends_on, a.warranty_expires_on) >= current_date,
    'labor_covered', a.labor_warranty_ends_on >= current_date,
    'registration_status', a.registration_status, 'nameplate', v_plate, 'nameplate_document_id', v_doc));
end $$;

-- Completion seed (idempotent): message templates, checklists with readings, follow-up cadence,
-- a default permit template, install capacity default and parts / equipment taxability (FS-117).
create or replace function pm.fs_seed_completion(p_location uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); n int := 0; k int;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then raise exception 'PM_INVALID: company not found' using errcode = '22023'; end if;
  insert into pm.fs_message_templates (org_id, location_id, key, label, kind, channel, body) values
    (v_org, p_location, 'reminder_24h', 'Reminder — day before', 'REMINDER_24H', 'SMS', 'Reminder from {company}: your visit is {day}, {window}. Reply C to confirm or R to reschedule.'),
    (v_org, p_location, 'reminder_2h', 'Reminder — 2 hours', 'REMINDER_2H', 'SMS', '{company}: we''ll see you today, {window}. Reply C to confirm or R if you need a new time.'),
    (v_org, p_location, 'confirm_ack', 'Confirmed reply', 'CONFIRM_ACK', 'SMS', 'Thanks, you''re confirmed for {day}, {window}. See you then.'),
    (v_org, p_location, 'reschedule_ack', 'Reschedule reply', 'RESCHEDULE_ACK', 'SMS', 'Got it. Our office will text you shortly to find a new time.'),
    (v_org, p_location, 'running_late', 'Running late', 'GENERAL', 'SMS', 'Hi {first_name}, it''s {company}. Your technician is running about 30 minutes behind. Sorry for the wait.'),
    (v_org, p_location, 'estimate_follow_up', 'Estimate follow-up', 'FOLLOW_UP', 'SMS', 'Hi {first_name}, it''s {company}. Any questions about the options we went over? Reply here or call us.'),
    (v_org, p_location, 'parts_arrived', 'Parts arrived', 'GENERAL', 'SMS', 'Hi {first_name}, the parts for your repair are in. Reply with a day that works and we''ll book the return visit.')
  on conflict (org_id, location_id, key) do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into pm.fs_form_templates (org_id, location_id, key, name, kind, job_type_keys, wo_kinds, fields, requires_signature) values
    (v_org, p_location, 'ac_tune_up', 'AC tune-up', 'TUNE_UP', '{tune_up}', '{MAINTENANCE_VISIT}', '[
       {"key":"superheat","label":"Superheat","type":"reading","unit":"°F","min":5,"max":25,"required":true},
       {"key":"subcool","label":"Subcool","type":"reading","unit":"°F","min":6,"max":16,"required":true},
       {"key":"static_pressure","label":"Total external static pressure","type":"reading","unit":"in. w.c.","min":0.2,"max":0.9,"required":true},
       {"key":"temp_split","label":"Temperature split","type":"reading","unit":"°F","min":14,"max":22,"required":true},
       {"key":"compressor_amps","label":"Compressor amp draw","type":"reading","unit":"A","min":0,"max":60,"required":true},
       {"key":"capacitor","label":"Run capacitor within rating","type":"pass_fail","required":true},
       {"key":"filter","label":"Filter replaced or clean","type":"pass_fail","required":true},
       {"key":"coil_photo","label":"Outdoor coil photo","type":"photo"},
       {"key":"notes_for_customer","label":"What we found","type":"text"}]'::jsonb, false),
    (v_org, p_location, 'combustion_safety', 'Furnace combustion safety', 'SAFETY', '{no_heat,tune_up}', '{}', '[
       {"key":"co_flue_ppm","label":"CO in the flue (air-free)","type":"reading","unit":"ppm","min":0,"max":100,"required":true,"red_tag_above":400},
       {"key":"co_ambient_ppm","label":"CO in the living space","type":"reading","unit":"ppm","min":0,"max":9,"required":true,"red_tag_above":35},
       {"key":"heat_exchanger","label":"Heat exchanger (no cracks)","type":"pass_fail","required":true,"red_tag_on_fail":true},
       {"key":"venting","label":"Venting and draft","type":"pass_fail","required":true,"red_tag_on_fail":true},
       {"key":"gas_pressure","label":"Manifold gas pressure","type":"reading","unit":"in. w.c.","min":3.2,"max":3.8},
       {"key":"temp_rise","label":"Temperature rise","type":"reading","unit":"°F","min":30,"max":70,"required":true}]'::jsonb, false),
    (v_org, p_location, 'hvac_commissioning', 'HVAC commissioning and walkthrough', 'COMMISSIONING', '{}', '{INSTALL}', '[
       {"key":"charge_verified","label":"Refrigerant charge verified","type":"pass_fail","required":true},
       {"key":"superheat","label":"Superheat","type":"reading","unit":"°F","min":5,"max":25,"required":true},
       {"key":"subcool","label":"Subcool","type":"reading","unit":"°F","min":6,"max":16,"required":true},
       {"key":"airflow_cfm","label":"Airflow","type":"reading","unit":"CFM","min":300,"max":3000,"required":true},
       {"key":"static_pressure","label":"Total external static pressure","type":"reading","unit":"in. w.c.","min":0.2,"max":0.9,"required":true},
       {"key":"thermostat","label":"Thermostat set up and explained","type":"pass_fail","required":true},
       {"key":"condensate","label":"Condensate drains and safety switch","type":"pass_fail","required":true},
       {"key":"install_photos","label":"Finished install photos","type":"photo","required":true},
       {"key":"walkthrough","label":"Customer walkthrough done","type":"pass_fail","required":true}]'::jsonb, true)
  on conflict (org_id, location_id, key) do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into pm.fs_followup_cadences (org_id, location_id, key, name, steps, is_default) values
    (v_org, p_location, 'standard', 'Standard follow-up (1 / 3 / 7 / 14 days)', '[
       {"day":1,"channel":"SMS","body":"Hi {first_name}, it''s {company}. Any questions about the options we went over yesterday? Reply here anytime."},
       {"day":3,"channel":"CALL_TASK"},
       {"day":7,"channel":"EMAIL","body":"Hi {first_name}, just checking in on your estimate from {company}. Your pricing is held until {valid_until}."},
       {"day":14,"channel":"SMS","body":"Hi {first_name}, {company} here. Your quote is good until {valid_until} — reply YES and we''ll get you on the schedule."}]'::jsonb, true)
  on conflict (org_id, location_id, key) do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into pm.fs_permit_templates (org_id, location_id, key, jurisdiction, permit_kind, inspections, lead_days, is_default, notes)
  values (v_org, p_location, 'mechanical_default', 'Local building department', 'MECHANICAL', '{FINAL}', 5, true, 'Edit for each city or county you work in.')
  on conflict (org_id, location_id, key) do nothing;
  get diagnostics k = row_count; n := n + k;
  if not exists (select 1 from pm.fs_install_capacity c where c.org_id = v_org and c.location_id = p_location and c.week_start is null) then
    insert into pm.fs_install_capacity (org_id, location_id, week_start, crew_days, note) values (v_org, p_location, null, 10, 'Two install crews, five days');
    n := n + 1;
  end if;
  return jsonb_build_object('created', n);
end $$;

-- ----------------------------------------------------------------------------
-- 19b. Phone sale time + photo documents (FS-26 follow-up from the phone app)
-- ----------------------------------------------------------------------------
-- The kitchen-table sale is recorded at the moment the customer signed (the phone's time), not when
-- the queued command reached the server: fs_estimates keeps signed_at (device, bounded) and
-- received_at (server); sold_at — the period every report and scorecard uses — is the server time. pm.fs_sell_estimate (1117) is redefined here with p_signed_at appended
-- (default null = now(), so every existing caller — the tablet route, the phone store, 1123's online
-- acceptance — keeps working); the old 11-argument signature is dropped so PostgREST named calls stay
-- unambiguous. Bounds: not more than 10 minutes in the future (clock skew, clamped to now), not more
-- than 35 days old (the field commands' age limit, app/api/field/_lib/rules.ts) and not before the
-- later of presented / created and the visit's first dispatch (minus the same skew). pm.fs_field_sell is the phone entry point: idempotent by
-- the client command id, applies add-on toggles of THIS estimate, resolves the drawn signature photo
-- to its document (org + job/site checked) and calls fs_sell_estimate in the same transaction.
alter table pm.fs_estimates add column if not exists received_at timestamptz;

-- A phone photo's document: the caller's org, stored under <org>/projects/field/<job>/<photo command
-- id>.<ext> (app/api/field photo upload), linked to this job or to a job at the same site. A
-- document id passed directly gets the same org + job/site check. Null when not (yet) there.
create or replace function pm._fs_field_photo_doc(p_org uuid, p_job uuid, p_site uuid, p_photo uuid, p_document uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select d.id
    from public.documents d
   where d.org_id = p_org
     and (d.id = p_document
          or (p_photo is not null and d.storage_path like p_org::text || '/projects/field/%/' || p_photo::text || '.%'))
     and exists (select 1 from pm.document_links dl
                  where dl.org_id = p_org and dl.document_id = d.id
                    and (dl.job_id = p_job
                         or (p_site is not null and dl.job_id in (select w2.job_id from pm.work_orders w2 where w2.org_id = p_org and w2.site_id = p_site))))
   order by coalesce(d.id = p_document, false) desc
   limit 1
$$;

drop function if exists pm.fs_sell_estimate(uuid, uuid[], text, text, uuid, bigint, boolean, text, uuid, uuid, uuid);

create or replace function pm.fs_sell_estimate(
  p_estimate uuid, p_option_ids uuid[], p_signed_name text, p_dismiss_reason text default null, p_join_template uuid default null,
  p_deposit_cents bigint default 0, p_request_deposit boolean default false, p_deposit_ref text default null,
  p_financing_plan uuid default null, p_sold_by_employee uuid default null, p_signature_document uuid default null,
  p_signed_at timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; w pm.work_orders%rowtype; v_member boolean; v_agr uuid; it record; n int := 0; v_dep uuid; v_sort int;
  v_seller uuid := p_sold_by_employee; v_signed timestamptz; v_floor timestamptz; v_total bigint := 0; v_price bigint;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status not in ('DRAFT','PRESENTED') then raise exception 'PM_FS_ESTIMATE_LOCKED: % is %', e.number, e.status using errcode = '55000'; end if;
  if p_option_ids is null or cardinality(p_option_ids) = 0 then raise exception 'PM_INVALID: pick at least one option' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_signed_name, '')), '') is null then raise exception 'PM_INVALID: the customer signs with their name' using errcode = '22023'; end if;
  if exists (select 1 from unnest(p_option_ids) x where not exists (select 1 from pm.fs_estimate_options o where o.org_id = e.org_id and o.estimate_id = e.id and o.id = x)) then
    raise exception 'PM_INVALID: every option must be on %', e.number using errcode = '22023';
  end if;
  if coalesce(p_deposit_cents, 0) < 0 then raise exception 'PM_INVALID: deposit must be ≥ 0' using errcode = '22023'; end if;
  if e.work_order_id is null then raise exception 'PM_FS_NO_VISIT: % is not on a visit', e.number using errcode = '22023'; end if;
  -- Signing time (security review M2): not ahead of the clock (10 min skew), not older than 35 days,
  -- and not before the later of when the options were presented (or written) and when the visit was
  -- first dispatched, less the same skew. PERIOD ATTRIBUTION: sold_at (what scorecards, commissions
  -- and every period report read) is the SERVER receipt time, never the device time — a late or
  -- back-dated sale can never land in a period already reviewed. signed_at keeps the device time.
  if p_signed_at is not null then
    if p_signed_at > now() + interval '10 minutes' then
      raise exception 'PM_FS_SIGNED_AT: the signing time is in the future; the phone clock is ahead' using errcode = '22023';
    end if;
    if p_signed_at < now() - interval '35 days' then
      raise exception 'PM_FS_SIGNED_AT: the signature is more than 35 days old; the office must enter this sale' using errcode = '22023';
    end if;
    select greatest(coalesce(e.presented_at, e.created_at), coalesce(min(d.created_at), '-infinity'::timestamptz)) - interval '10 minutes' into v_floor
      from pm.dispatch_assignments d where d.org_id = e.org_id and d.work_order_id = e.work_order_id and d.status <> 'CANCELLED';
    if p_signed_at < v_floor then
      raise exception 'PM_FS_SIGNED_AT: the signing time is before % was presented or the visit was dispatched', e.number using errcode = '22023';
    end if;
  end if;
  v_signed := least(coalesce(p_signed_at, now()), now());
  -- The seller (M2): an employee of this org on this visit, unless the caller may edit the estimate.
  if p_sold_by_employee is not null then
    if not exists (select 1 from core.employees x where x.id = p_sold_by_employee and x.org_id = e.org_id) then
      raise exception 'PM_INVALID: that seller is not in this organization' using errcode = '22023';
    end if;
    if not exists (select 1 from pm.dispatch_assignments d where d.org_id = e.org_id and d.work_order_id = e.work_order_id
                     and d.employee_id = p_sold_by_employee and d.status <> 'CANCELLED')
       and not pm.access_can_row('projects.estimates', 'edit', 'fs_estimates', e.id) then
      raise exception 'PM_FORBIDDEN: credit the sale to someone on this visit, or have projects.estimates:edit' using errcode = '42501';
    end if;
  end if;
  -- The signature image (M2): a document of this org on this job (or a job at this site).
  if p_signature_document is not null then
    if pm._fs_field_photo_doc(e.org_id, e.job_id, (select x.site_id from pm.work_orders x where x.org_id = e.org_id and x.id = e.work_order_id), null, p_signature_document) is null then
      raise exception 'PM_INVALID: that signature is not a document on this job' using errcode = '22023';
    end if;
  end if;
  select * into w from pm.work_orders x where x.org_id = e.org_id and x.id = e.work_order_id for update;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if v_seller is null then
    select d.employee_id into v_seller from pm.dispatch_assignments d
     where d.org_id = e.org_id and d.work_order_id = w.id and d.status <> 'CANCELLED' and d.employee_id is not null
     order by (d.employee_id in (select pm.my_employee_ids())) desc, d.is_lead desc, d.created_at limit 1;
  end if;
  v_member := e.member_pricing;
  -- Nested fs_create_agreement_from_template skips its guard (audit): it is the sale's own membership,
  -- from an ACTIVE template of THIS company (checked inside) for the estimate's customer, at the
  -- template price — nothing caller-priced. Starts on the server date (period by receipt).
  if p_join_template is not null and e.customer_id is not null then
    v_agr := pm.fs_create_agreement_from_template(p_join_template, e.customer_id, e.location_id, null, current_date, w.site_id);
    v_member := true;
  end if;
  select coalesce(max(l.sort), 0) into v_sort from pm.work_order_lines l where l.org_id = e.org_id and l.work_order_id = w.id;
  for it in select i.* from pm.fs_estimate_option_items i
             where i.org_id = e.org_id and i.option_id = any (p_option_ids) and i.is_selected order by i.option_id, i.sort loop
    v_sort := v_sort + 1;
    v_price := case when v_member then coalesce(it.member_unit_price_cents, it.unit_price_cents) else it.unit_price_cents end;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, price_book_item_id, description, qty, unit_price_cents,
                                     unit_cost_cents, status, decided_at, decided_by_name, sold_by_employee_id, fs_option_item_id, created_by)
    values (e.org_id, e.job_id, w.id, v_sort, case it.kind when 'DISCOUNT' then 'DISCOUNT' else it.kind end, it.price_book_item_id, it.description,
            it.qty, v_price, it.unit_cost_cents, 'APPROVED', now(), btrim(p_signed_name), v_seller, it.id, pm.current_user_id());
    v_total := v_total + round(it.qty * v_price)::bigint;
    n := n + 1;
  end loop;
  -- A deposit (cash, check or a pay-link request) is never more than the sold total, before tax (M2).
  if coalesce(p_deposit_cents, 0) > greatest(v_total, 0) then
    raise exception 'PM_INVALID: the deposit is more than the sold total' using errcode = '22023';
  end if;
  update pm.fs_estimate_options set status = case when id = any (p_option_ids) then 'SOLD' else 'DISMISSED' end,
         dismiss_reason = case when id = any (p_option_ids) then null else coalesce(nullif(btrim(coalesce(p_dismiss_reason, '')), ''), 'Not chosen') end
   where org_id = e.org_id and estimate_id = e.id;
  if coalesce(p_request_deposit, false) and coalesce(p_deposit_cents, 0) > 0 then
    if not pm.access_can_job('projects.billing', 'create', e.job_id) then
      raise exception 'PM_FORBIDDEN: requesting a deposit from Books requires projects.billing:create on this job' using errcode = '42501';
    end if;
    v_dep := pm.request_deposit(e.job_id, p_deposit_cents, format('Deposit for %s', e.number), current_date);
  end if;
  update pm.fs_estimates set status = 'SOLD', sold_option_ids = p_option_ids, signed_name = btrim(p_signed_name), signed_at = v_signed,
         received_at = now(), sold_at = now(), deposit_cents = coalesce(p_deposit_cents, 0), deposit_ref = p_deposit_ref, deposit_request_id = v_dep,
         financing_plan_id = coalesce(p_financing_plan, financing_plan_id), agreement_id = v_agr, member_pricing = v_member,
         sold_by_employee_id = v_seller, signature_document_id = p_signature_document
   where id = e.id;
  update pm.fs_tgl_leads set status = 'SOLD', estimate_id = e.id,
         sold_cents = (select coalesce(sum(case when v_member then member_cents else regular_cents end), 0) from pm.v_fs_option_totals t where t.option_id = any (p_option_ids))
   where org_id = e.org_id and job_id = e.job_id and status in ('OPEN','APPOINTMENT');
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'fs_estimate.sold', 'fs_estimates', e.id,
    format('Sold %s (%s line(s) to %s)', e.number, n, w.number),
    jsonb_build_object('options', to_jsonb(p_option_ids), 'member', v_member, 'agreement_id', v_agr, 'deposit_request_id', v_dep,
                       'signed_at', v_signed, 'received_at', now()));
  return jsonb_build_object('estimate_id', e.id, 'lines', n, 'agreement_id', v_agr, 'deposit_request_id', v_dep, 'member_pricing', v_member,
                            'signed_at', v_signed, 'received_at', now());
end $$;

-- The phone's sale (fs.sell over /api/field/fs-commands). At most once per client command id; a
-- re-send after the same options were already sold (another path) is answered as a duplicate.
create or replace function pm.fs_field_sell(
  p_estimate uuid, p_command uuid, p_option_ids uuid[], p_signed_name text, p_signed_at timestamptz,
  p_toggles jsonb default '[]'::jsonb, p_signature_photo uuid default null, p_financing_plan uuid default null,
  p_join_template uuid default null, p_deposit_cents bigint default 0, p_request_deposit boolean default false,
  p_deposit_ref text default null, p_dismiss_reason text default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; w pm.work_orders%rowtype; v_seen jsonb; t jsonb; v_item uuid; v_doc uuid; r jsonb;
begin
  if p_command is null then raise exception 'PM_INVALID: the phone command id is required' using errcode = '22023'; end if;
  if p_signed_at is null then raise exception 'PM_FS_SIGNED_AT: the phone must send when the customer signed' using errcode = '22023'; end if;
  select * into e from pm.fs_estimates x where x.id = p_estimate and x.org_id = public.get_org_id();
  if e.id is null then raise exception 'PM_FORBIDDEN: estimate not found in the caller''s organization' using errcode = '42501'; end if;
  v_seen := pm._fs_cmd_seen(e.org_id, p_command, 'fs.sell');
  if v_seen is not null then return v_seen || jsonb_build_object('duplicate', true); end if;
  if e.status = 'SOLD' and p_option_ids is not null
     and (select array_agg(distinct x order by x) from unnest(e.sold_option_ids) x) = (select array_agg(distinct x order by x) from unnest(p_option_ids) x) then
    return pm._fs_cmd_done(e.org_id, p_command, 'fs.sell', e.id, jsonb_build_object('estimate_id', e.id, 'already_sold', true,
             'signed_at', e.signed_at, 'received_at', e.received_at)) || jsonb_build_object('duplicate', true);
  end if;
  select * into w from pm.work_orders x where x.org_id = e.org_id and x.id = e.work_order_id;
  for t in select value from jsonb_array_elements(case when jsonb_typeof(p_toggles) = 'array' then p_toggles else '[]'::jsonb end) loop
    v_item := (t ->> 'item_id')::uuid;
    if not exists (select 1 from pm.fs_estimate_option_items i join pm.fs_estimate_options o on o.org_id = i.org_id and o.id = i.option_id
                    where i.org_id = e.org_id and i.id = v_item and o.estimate_id = e.id) then
      raise exception 'PM_INVALID: an add-on is not on %', e.number using errcode = '22023';
    end if;
    perform pm.fs_toggle_option_item(v_item, coalesce((t ->> 'selected')::boolean, true));
  end loop;
  if p_signature_photo is not null then
    v_doc := pm._fs_field_photo_doc(e.org_id, e.job_id, w.site_id, p_signature_photo, null);
  end if;
  r := pm.fs_sell_estimate(e.id, p_option_ids, p_signed_name, p_dismiss_reason, p_join_template, coalesce(p_deposit_cents, 0),
                           coalesce(p_request_deposit, false), p_deposit_ref, p_financing_plan, null, v_doc, p_signed_at);
  r := r || jsonb_build_object('signature', case when p_signature_photo is null then null when v_doc is null then 'PENDING' else 'ATTACHED' end);
  return pm._fs_cmd_done(e.org_id, p_command, 'fs.sell', e.id, r);
end $$;

-- What the phone needs about its visit beyond the visit itself (GET /api/field/fs-tools): the
-- customer, and the visit's invoice review (not void) ONLY for a caller who may read the review
-- (projects.billing or projects.dispatch view — the same read caps as the table): id, state, whether
-- Books has issued the invoice, whether this caller may send the pay link (fs_text_to_pay's guard:
-- billing:create on the billing request or dispatch:edit on the review),
-- and the total only with contract value on the job. A technician without those grants gets null.
create or replace function pm.fs_visit_context(p_wo uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; r pm.fs_invoice_reviews%rowtype; v_cust uuid; v_money boolean; v_invoiced boolean; v_pay boolean;
begin
  select * into w from pm.work_orders x where x.id = p_wo and x.org_id = public.get_org_id();
  if w.id is null then raise exception 'PM_FORBIDDEN: visit not found' using errcode = '42501'; end if;
  select j.customer_id into v_cust from core.jobs j where j.org_id = w.org_id and j.id = w.job_id;
  select * into r from pm.fs_invoice_reviews x where x.org_id = w.org_id and x.work_order_id = w.id and x.status <> 'VOID';
  if r.id is not null and not (pm.access_can_row('projects.billing', 'view', 'fs_invoice_reviews', r.id)
                               or pm.access_can_row('projects.dispatch', 'view', 'fs_invoice_reviews', r.id)) then
    r := null;
  end if;
  v_money := w.job_id in (select pm.my_money_job_ids('projects.contract_value'));
  if r.id is not null then
    select b.invoice_id is not null into v_invoiced from pm.billing_requests b where b.org_id = w.org_id and b.id = r.billing_request_id;
    v_pay := (r.billing_request_id is not null and pm.access_can_row('projects.billing', 'create', 'billing_requests', r.billing_request_id))
             or pm.access_can_row('projects.dispatch', 'edit', 'fs_invoice_reviews', r.id);
  end if;
  return jsonb_build_object(
    'work_order_id', w.id, 'job_id', w.job_id, 'customer_id', v_cust,
    'invoice_review', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'status', r.status, 'flag_count', r.flag_count, 'blocking_count', r.blocking_count,
      'invoiced', coalesce(v_invoiced, false), 'can_send_pay_link', coalesce(v_pay, false),
      'total_cents', case when v_money then r.total_cents end) end);
end $$;

-- ----------------------------------------------------------------------------
-- 20. 1110 registries: classes, masked columns, RPC guards
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('fs_message_templates',     'S','location', '{}', 'projects.settings', null, null, null, null, false, '1123: customer message templates (FS-12 / FS-22)'),
  ('fs_form_templates',        'S','location', '{}', 'projects.settings', null, null, null, null, false, '1123: checklists with required readings (FS-29)'),
  ('fs_followup_cadences',     'S','location', '{}', 'projects.settings', null, null, null, null, false, '1123: unsold-estimate cadences (FS-56)'),
  ('fs_permit_templates',      'S','location', '{}', 'projects.settings', null, null, null, null, false, '1123: permit jurisdiction templates (FS-82); fee masked'),
  ('fs_install_capacity',      'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1123: install crew-days per week (FS-83)'),
  ('fs_tax_rules',             'S','location', '{}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1123: line taxability by state (FS-95)'),
  ('fs_phone_providers',       'C','location', '{projects.settings}', null, null, null, null, null, false, '1123: telephony providers (FS-05); switched on by RPC only'),
  ('fs_call_log',              'C','location', '{projects.dispatch,projects.customers,projects.leads}', null, null, null, null, null, false, '1123: provider call log (FS-05)'),
  ('fs_threads',               'C','location', '{projects.dispatch,projects.customers}', null, null, null,
     '%1$sjob_id in (select pm.my_job_ids())', null, false, '1123: customer message threads (FS-12); the job team reads its job''s thread'),
  ('fs_thread_messages',       'C','location', '{projects.dispatch,projects.customers}', null, null, null,
     '%1$sjob_id in (select pm.my_job_ids())', null, false, '1123: thread messages (FS-12)'),
  ('fs_appointment_reminders', 'C','location', '{projects.dispatch,projects.customers}', null, null, null, null, null, false, '1123: 24 h / 2 h reminders + replies (FS-22)'),
  ('fs_autopay_enrollments',   'C','location', '{projects.billing,projects.customers}', null, null, null, null, null, false, '1123: auto-pay consent (FS-96)'),
  ('fs_integrity_findings',    'C','location', '{projects.billing,projects.reports,projects.financials}', null, null, null, null, null, false, '1123: billing integrity findings (FS-112); amount masked'),
  ('fs_shadow_runs',           'C','location', '{projects.reports,projects.settings}', null, null, null, null, null, false, '1123: shadow-run comparison (FS-117); totals masked'),
  ('fs_form_submissions',      'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: checklist submissions with readings (FS-29)'),
  ('fs_visit_notes',           'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: structured visit notes (FS-30 / FS-31)'),
  ('fs_online_acceptances',    'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: online estimate acceptances (FS-59)'),
  ('fs_install_projects',      'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: install projects (FS-79); contract / cost masked'),
  ('fs_install_items',         'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: install equipment list (FS-80); price / cost masked'),
  ('fs_po_details',            'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: PO fulfillment / will-call (FS-81 / FS-90); no money'),
  ('fs_serial_units',          'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: serialized equipment (FS-93)'),
  ('fs_install_crew_days',     'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: install crew days (FS-83)'),
  ('fs_tax_snapshots',         'J','job', '{projects.jobs}', null, null, null, null, null, false, '1123: pinned sales-tax per line (FS-95); amounts masked'),
  ('fs_estimate_followups',    'J','job', '{projects.jobs}', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.leads'', ''view''))', null, false, '1123: estimate follow-up steps (FS-56)'),
  ('fs_opportunities',         'J','job_or_location', '{projects.leads,projects.estimates}', null, null, null, null, null, false, '1123: comfort-advisor pipeline (FS-57); sold value masked'),
  ('fs_invoice_reviews',       'J','job', '{projects.billing,projects.dispatch}', null, null, null, null, null, false, '1123: invoice review queue (FS-94); totals masked'),
  ('fs_financed_sales',        'M','job', '{projects.contract_value}', null, null, null, null, null, false, '1123: financing funding reconciliation (FS-97); dealer fee masked'),
  ('fs_field_commands',        'P','org', '{}', null, null, null, '%1$suser_id = pm.current_user_id()', 'false', false, '1123: phone command idempotency ledger (own rows)'),
  ('fs_voice_numbers',         'O','org', '{}', null, null, null, null, null, false, '1123: platform registry of verified provider numbers (service_role only; H1)'),
  ('fs_voice_event_log',       'O','org', '{}', null, null, null, null, null, false, '1123: ignored / ambiguous voice events (service_role only)'),
  ('fs_platform_settings',     'O','org', '{}', null, null, null, null, null, false, '1123: allowlisted Books / Projects base URLs (service_role only; M1)')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('fs_install_projects', 'contract_cents',   't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null::text, '1123: sold total'),
  ('fs_install_projects', 'est_cost_cents',   't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1123: estimated cost'),
  ('fs_install_items',    'unit_price_cents', 't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1123: sell'),
  ('fs_install_items',    'unit_cost_cents',  't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1123: cost'),
  ('fs_permit_templates', 'fee_cents',        't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1123: permit fee (job cost)'),
  ('fs_invoice_reviews',  'subtotal_cents',   't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1123'),
  ('fs_invoice_reviews',  'tax_cents',        't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1123'),
  ('fs_invoice_reviews',  'total_cents',      't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1123'),
  ('fs_tax_snapshots',    'tax_cents',        't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1123'),
  ('fs_tax_snapshots',    'lines',            't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', '''[]''::jsonb', '1123: per-line amounts'),
  ('fs_opportunities',    'sold_cents',       '((t.job_id is not null and t.job_id in (select pm.my_money_job_ids(''projects.contract_value''))) or (t.job_id is null and t.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))))', null, '1123'),
  ('fs_financed_sales',   'dealer_fee_pct',   't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1123: lender dealer fee'),
  ('fs_financed_sales',   'dealer_fee_cents', 't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1123'),
  ('fs_financed_sales',   'expected_net_cents','t.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1123'),
  ('fs_integrity_findings','amount_cents',    't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1123'),
  ('fs_shadow_runs',      'legacy_revenue_cents',  't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null, '1123'),
  ('fs_shadow_runs',      'legacy_payments_cents', 't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null, '1123'),
  ('fs_shadow_runs',      'merit_revenue_cents',   't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null, '1123'),
  ('fs_shadow_runs',      'merit_payments_cents',  't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null, '1123')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('fs_set_phone_provider', '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1123: FS-05'),
  ('fs_link_call',          '{p_call}', 'if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_call_log'', p_call) or pm.access_can_row(''projects.leads'', ''create'', ''fs_call_log'', p_call)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.leads:create''); end if;', '1123'),
  ('fs_call_report',        '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports, leads or dispatch view''); end if;', '1123'),
  ('fs_send_message',       '{p_location,p_job,p_work_order}', 'if not (pm.access_can_location(''projects.dispatch'', ''edit'', p_location) or pm.access_can_location(''projects.customers'', ''edit'', p_location) or (p_work_order is not null and pm.access_my_work_order(p_work_order)) or (p_job is not null and pm.access_can_job(''projects.jobs'', ''edit'', p_job))) then perform pm.access_forbid(''requires projects.dispatch:edit, projects.customers:edit or your own visit''); end if;', '1123: FS-12'),
  ('fs_add_thread_note',    '{p_thread}', 'if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_threads'', p_thread) or pm.access_can_row(''projects.customers'', ''edit'', ''fs_threads'', p_thread)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.customers:edit''); end if;', '1123'),
  ('fs_mark_thread',        '{p_thread}', 'if not (pm.access_can_row(''projects.dispatch'', ''view'', ''fs_threads'', p_thread) or pm.access_can_row(''projects.customers'', ''view'', ''fs_threads'', p_thread)) then perform pm.access_forbid(''requires projects.dispatch or customers view''); end if;', '1123'),
  ('fs_run_automations',    '{p_location}', 'perform pm.access_assert_location(''projects.dispatch'', array[''edit''], p_location);', '1123: FS-22 / FS-56 run now'),
  ('fs_forms_for_wo',       '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own visit or the job''); end if;', '1123: FS-29'),
  ('fs_submit_form',        '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own visit, projects.dispatch:edit or projects.jobs:edit''); end if;', '1123: FS-29'),
  ('fs_save_visit_note',    '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own visit, projects.dispatch:edit or projects.jobs:edit''); end if;', '1123: FS-30/31'),
  ('fs_upsert_equipment',   '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own visit, projects.dispatch:edit or projects.jobs:edit''); end if;', '1123: FS-26 / FS-36'),
  ('fs_followup_queue',     '{p_location}', 'if not (pm.access_can_location(''projects.estimates'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.estimates, dispatch or leads view''); end if;', '1123: FS-56'),
  ('fs_complete_followup',  '{p_followup}', 'if not (pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimate_followups'', p_followup) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimate_followups'', p_followup) or exists (select 1 from pm.fs_estimate_followups gf where gf.id = p_followup and gf.org_id = public.get_org_id() and (pm.access_can_location(''projects.leads'', ''edit'', gf.location_id) or gf.owner_employee_id in (select pm.my_employee_ids())))) then perform pm.access_forbid(''requires projects.estimates:edit, projects.leads:edit or your own follow-up''); end if;', '1123'),
  ('fs_open_opportunity',   '{p_location}', 'if not (pm.access_can_location(''projects.leads'', ''create'', p_location) or pm.access_can_location(''projects.estimates'', ''create'', p_location)) then perform pm.access_forbid(''requires projects.leads:create''); end if;', '1123: FS-57'),
  ('fs_advance_opportunity','{p_opportunity}', 'if not (pm.access_can_row(''projects.leads'', ''edit'', ''fs_opportunities'', p_opportunity) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_opportunities'', p_opportunity)) then perform pm.access_forbid(''requires projects.leads:edit or projects.estimates:edit''); end if;', '1123'),
  ('fs_advisor_pipeline',   '{p_location}', 'if not (pm.access_can_location(''projects.leads'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.estimates'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.leads, reports or estimates view''); end if;', '1123: money stripped inside'),
  ('fs_finalize_online_acceptance','{p_acceptance}', 'if not (pm.access_can_row(''projects.estimates'', ''edit'', ''fs_online_acceptances'', p_acceptance) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_online_acceptances'', p_acceptance)) then perform pm.access_forbid(''requires projects.estimates:edit or projects.dispatch:edit''); end if;', '1123: FS-59'),
  ('fs_reject_online_acceptance','{p_acceptance}', 'if not (pm.access_can_row(''projects.estimates'', ''edit'', ''fs_online_acceptances'', p_acceptance) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_online_acceptances'', p_acceptance)) then perform pm.access_forbid(''requires projects.estimates:edit or projects.dispatch:edit''); end if;', '1123'),
  ('fs_handoff_install',    '{p_estimate}', 'if not (pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.jobs'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires projects.estimates:edit or projects.jobs:edit''); end if;', '1123: FS-80'),
  ('fs_set_install_stage',  '{p_project}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''fs_install_projects'', p_project) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_install_projects'', p_project)) then perform pm.access_forbid(''requires projects.jobs:edit or projects.dispatch:edit''); end if;', '1123: FS-79'),
  ('fs_install_po',         '{p_project}', 'perform pm.access_assert_row(''projects.commitments'', array[''create''], ''fs_install_projects'', p_project);', '1123: FS-81; approval stays in 1113'),
  ('fs_receive_po',         '{p_commitment,p_pickup_code}', 'if not (pm.access_can_row(''projects.commitments'', ''edit'', ''commitments'', p_commitment) or (p_pickup_code is not null and exists (select 1 from pm.fs_po_details gd where gd.commitment_id = p_commitment and gd.org_id = public.get_org_id() and gd.job_id in (select pm.my_job_ids())))) then perform pm.access_forbid(''requires projects.commitments:edit, or the pickup code on a job you are on''); end if;', '1123: FS-90'),
  ('fs_my_will_calls',      '{}', 'if not pm.is_projects_member() then perform pm.access_forbid(''requires a Merit Projects seat''); end if;', '1123: own jobs only inside'),
  ('fs_apply_permit',       '{p_project}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''fs_install_projects'', p_project);', '1123: FS-82'),
  ('fs_update_permit',      '{p_permit}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_permits'', p_permit);', '1123: FS-82'),
  ('fs_install_earliest',   '{p_project}', 'if not (pm.access_can_row(''projects.dispatch'', ''view'', ''fs_install_projects'', p_project) or pm.access_can_row(''projects.jobs'', ''view'', ''fs_install_projects'', p_project)) then perform pm.access_forbid(''requires projects.dispatch or jobs view''); end if;', '1123: FS-83'),
  ('fs_schedule_install',   '{p_project}', 'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''fs_install_projects'', p_project);', '1123: FS-83'),
  ('fs_commission_install', '{p_project}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''fs_install_projects'', p_project) or pm.access_my_work_order((select gp.install_work_order_id from pm.fs_install_projects gp where gp.id = p_project and gp.org_id = public.get_org_id()))) then perform pm.access_forbid(''requires projects.jobs:edit or the install on your schedule''); end if;', '1123: FS-84'),
  ('fs_install_costing',    '{p_project}', 'perform pm.access_assert_row(''projects.financials'', array[''view''], ''fs_install_projects'', p_project);', '1123: FS-85'),
  ('fs_install_setup_sov',  '{p_project}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''fs_install_projects'', p_project);', '1123: FS-86'),
  ('fs_install_bill',       '{p_project}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''fs_install_projects'', p_project);', '1123: FS-86'),
  ('fs_install_board',      '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.jobs'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch or jobs view''); end if;', '1123: rows narrowed to reachable jobs'),
  ('fs_quote_tax',          '{p_estimate}', 'if not (pm.access_can_row(''projects.jobs'', ''view'', ''fs_estimates'', p_estimate) or exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id))) then perform pm.access_forbid(''requires the job or your own visit''); end if;', '1123: FS-95'),
  ('fs_refresh_review',     '{p_review}', 'if not (pm.access_can_row(''projects.billing'', ''view'', ''fs_invoice_reviews'', p_review) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_invoice_reviews'', p_review)) then perform pm.access_forbid(''requires projects.billing:view or projects.dispatch:edit''); end if;', '1123: FS-94'),
  ('fs_decide_review',      '{p_review}', 'if not (pm.access_can_row(''projects.billing'', ''create'', ''fs_invoice_reviews'', p_review) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_invoice_reviews'', p_review)) then perform pm.access_forbid(''requires projects.billing:create or projects.dispatch:edit''); end if;', '1123: approve needs billing:create inside'),
  ('fs_review_queue',       '{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.billing or dispatch view''); end if;', '1123: totals stripped inside'),
  ('fs_text_to_pay',        '{p_review,p_billing_request}', 'if not (pm.access_can_row(''projects.billing'', ''create'', ''billing_requests'', coalesce(p_billing_request, (select gr.billing_request_id from pm.fs_invoice_reviews gr where gr.id = p_review and gr.org_id = public.get_org_id()))) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_invoice_reviews'', p_review)) then perform pm.access_forbid(''requires projects.billing:create or projects.dispatch:edit''); end if;', '1123: FS-96; nested fs_send_message sends only the fixed pay-link text to the invoice customer'),
  ('fs_request_autopay',    '{p_agreement}', 'if not (pm.access_can_row(''projects.billing'', ''create'', ''service_agreements'', p_agreement) or pm.access_can_row(''projects.customers'', ''edit'', ''service_agreements'', p_agreement)) then perform pm.access_forbid(''requires projects.billing:create or projects.customers:edit''); end if;', '1123: FS-96'),
  ('fs_cancel_autopay',     '{p_enrollment}', 'if not (pm.access_can_row(''projects.billing'', ''edit'', ''fs_autopay_enrollments'', p_enrollment) or pm.access_can_row(''projects.customers'', ''edit'', ''fs_autopay_enrollments'', p_enrollment)) then perform pm.access_forbid(''requires projects.billing:edit or projects.customers:edit''); end if;', '1123'),
  ('fs_update_financing',   '{p_financed}', 'if not (pm.access_can_row(''projects.billing'', ''edit'', ''fs_financed_sales'', p_financed) or pm.access_can_row(''projects.financials'', ''edit'', ''fs_financed_sales'', p_financed)) then perform pm.access_forbid(''requires projects.billing:edit or projects.financials:edit''); end if;', '1123: FS-97'),
  ('fs_financing_recon',    '{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''view'', p_location) or pm.access_can_location(''projects.financials'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.billing, financials or reports view''); end if;', '1123: money stripped inside'),
  ('fs_timesheet_exceptions','{p_location}', 'perform pm.access_assert_location(''projects.time'', array[''approve''], p_location);', '1123: FS-102'),
  ('fs_run_integrity',      '{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.financials'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.billing, reports or financials view''); end if;', '1123: FS-112'),
  ('fs_task_finding',       '{p_finding}', 'if not (pm.access_can_row(''projects.billing'', ''edit'', ''fs_integrity_findings'', p_finding) or pm.access_can_row(''projects.jobs'', ''edit'', ''fs_integrity_findings'', p_finding)) then perform pm.access_forbid(''requires projects.billing:edit or projects.jobs:edit''); end if;', '1123'),
  ('fs_dismiss_finding',    '{p_finding}', 'if not (pm.access_can_row(''projects.billing'', ''approve'', ''fs_integrity_findings'', p_finding) or pm.access_can_row(''projects.financials'', ''edit'', ''fs_integrity_findings'', p_finding)) then perform pm.access_forbid(''requires projects.billing:approve or projects.financials:edit''); end if;', '1123'),
  ('fs_metric',             '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports, dispatch or leads view''); end if;', '1123: FS-110; money stripped inside'),
  ('fs_dashboard',          '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports or dispatch view''); end if;', '1123: FS-109; money stripped inside'),
  ('fs_setup_status',       '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.settings or reports view''); end if;', '1123: FS-117'),
  ('fs_record_shadow_day',  '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.financials:edit''); end if;', '1123: FS-117'),
  ('fs_shadow_report',      '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.settings or reports view''); end if;', '1123: totals stripped inside'),
  ('fs_sell_estimate',      '{p_estimate,p_request_deposit,p_join_template}', 'if not (exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1117, redefined in 1123 with p_signed_at: deposit request rides pm.request_deposit; membership via template'),
  ('fs_field_sell',         '{p_estimate,p_command}', 'if not (exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1123: phone sale (FS-26); toggles + sale nested, deposit request still needs billing:create inside'),
  ('fs_visit_context',      '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own visit or projects.jobs / dispatch view''); end if;', '1123: FS-26 phone visit context; total only with contract value'),
  ('fs_seed_completion',    '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1123: FS-117')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 21. RLS (permissive org isolation) + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['fs_field_commands','fs_phone_providers','fs_call_log','fs_message_templates','fs_threads','fs_thread_messages',
    'fs_appointment_reminders','fs_form_templates','fs_form_submissions','fs_visit_notes','fs_followup_cadences','fs_estimate_followups',
    'fs_opportunities','fs_online_acceptances','fs_install_projects','fs_install_items','fs_po_details','fs_serial_units','fs_permit_templates',
    'fs_install_capacity','fs_install_crew_days','fs_tax_rules','fs_tax_snapshots','fs_invoice_reviews','fs_autopay_enrollments',
    'fs_financed_sales','fs_integrity_findings','fs_shadow_runs'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
    execute format('grant select on pm.%I to authenticated', t);
  end loop;
  -- config rows members write through RLS (class write caps)
  foreach t in array array['fs_message_templates','fs_form_templates','fs_followup_cadences','fs_permit_templates','fs_install_capacity','fs_tax_rules'] loop
    execute format('grant insert, update, delete on pm.%I to authenticated', t);
  end loop;
end $$;

-- Service-only platform tables: RLS on, no member grants (like 1117's fs_widget_server_keys).
alter table pm.fs_voice_numbers enable row level security;
alter table pm.fs_voice_event_log enable row level security;
alter table pm.fs_platform_settings enable row level security;
revoke all on pm.fs_voice_numbers, pm.fs_voice_event_log, pm.fs_platform_settings from public, anon, authenticated;
grant select, insert, update, delete on pm.fs_voice_numbers, pm.fs_voice_event_log, pm.fs_platform_settings to service_role;
-- Class O gets the generated restrictive pm_access_* policies (using true). There is no permissive
-- member policy on these tables; this restrictive deny-all for anon / authenticated makes that
-- explicit, so a later grant or permissive policy still cannot expose them (security review round 2).
do $$
declare t text;
begin
  foreach t in array array['fs_voice_numbers','fs_voice_event_log','fs_platform_settings'] loop
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'fs_service_only') then
      execute format('create policy fs_service_only on pm.%I as restrictive for all to anon, authenticated using (false) with check (false)', t);
    end if;
  end loop;
end $$;
-- a registry row's company must belong to its organization (round 2)
drop trigger if exists trg_location_in_org on pm.fs_voice_numbers;
create trigger trg_location_in_org before insert or update of location_id, org_id on pm.fs_voice_numbers
  for each row execute function pm.tg_location_in_org();

-- Policies (every classified table), masked views, RPC guards.
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon in pm; members get the guarded RPC surface; helpers and
-- triggers are service-only. The anon surface is public.fs_voice_event / fs_inbound_sms / fs_cron_tick
-- (server key, fail closed) and portal.fs_* (portal session).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              '_fs_e164','_fs_reply_intent','_fs_fill','_fs_cmd_seen','_fs_cmd_done','tg_fs_install_number','_fs_party_by_phone',
              'fs_set_phone_provider','fs_link_call','fs_call_report','_fs_thread_for','_fs_msg_vals','fs_send_message','fs_add_thread_note',
              'fs_mark_thread','_fs_route_inbound','_fs_plan_reminders','_fs_deliver_outbox','fs_run_automations','_fs_validate_form',
              'fs_forms_for_wo','fs_submit_form','fs_save_visit_note','_fs_start_followups','_fs_run_followups','fs_followup_queue',
              'fs_complete_followup','tg_fs_tgl_opportunity','fs_open_opportunity','fs_advance_opportunity','fs_advisor_pipeline',
              'tg_fs_estimate_lifecycle','fs_finalize_online_acceptance','fs_reject_online_acceptance','_fs_handoff_install','fs_handoff_install',
              'fs_set_install_stage','fs_install_po','fs_receive_po','fs_my_will_calls','fs_apply_permit','fs_update_permit',
              '_fs_install_week_capacity','_fs_install_week_booked','_fs_install_readiness','fs_install_earliest','fs_schedule_install',
              'fs_commission_install','fs_install_costing','fs_install_setup_sov','fs_install_bill','fs_install_board','_fs_tax_rate',
              '_fs_line_taxable','_fs_tax_lines','_fs_pin_estimate_tax','fs_quote_tax','_fs_review_flags','_fs_refresh_review','tg_fs_review_queue',
              'fs_refresh_review','fs_decide_review','fs_review_queue','fs_text_to_pay','fs_request_autopay','fs_cancel_autopay',
              '_fs_record_financing','fs_update_financing','fs_financing_recon','fs_timesheet_exceptions','fs_run_integrity','fs_task_finding',
              'fs_dismiss_finding','fs_metric','fs_dashboard','fs_setup_status','fs_record_shadow_day','fs_shadow_report','fs_upsert_equipment',
              'fs_seed_completion','_fs_field_photo_doc','fs_sell_estimate','fs_field_sell','fs_visit_context',
              'tg_fs_campaign_tracking_phone','_fs_app_url') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('_fs_e164','_fs_reply_intent','_fs_fill','_fs_validate_form',
                     'fs_set_phone_provider','fs_link_call','fs_call_report','fs_send_message','fs_add_thread_note','fs_mark_thread',
                     'fs_run_automations','fs_forms_for_wo','fs_submit_form','fs_save_visit_note','fs_followup_queue','fs_complete_followup',
                     'fs_open_opportunity','fs_advance_opportunity','fs_advisor_pipeline','fs_finalize_online_acceptance','fs_reject_online_acceptance',
                     'fs_handoff_install','fs_set_install_stage','fs_install_po','fs_receive_po','fs_my_will_calls','fs_apply_permit','fs_update_permit',
                     'fs_install_earliest','fs_schedule_install','fs_commission_install','fs_install_costing','fs_install_setup_sov','fs_install_bill',
                     'fs_install_board','fs_quote_tax','fs_refresh_review','fs_decide_review','fs_review_queue','fs_text_to_pay','fs_request_autopay',
                     'fs_cancel_autopay','fs_update_financing','fs_financing_recon','fs_timesheet_exceptions','fs_run_integrity','fs_task_finding',
                     'fs_dismiss_finding','fs_metric','fs_dashboard','fs_setup_status','fs_record_shadow_day','fs_shadow_report','fs_upsert_equipment',
                     'fs_seed_completion','fs_sell_estimate','fs_field_sell','fs_visit_context') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('fs_voice_event','fs_inbound_sms','fs_cron_tick') loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'portal' and p.proname in ('_fs_option_json','fs_estimate','fs_estimate_accept','fs_hub','fs_confirm_visit') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname <> '_fs_option_json' then
      execute format('grant execute on function %s to anon, authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1123_pm_field_service_completion
-- ============================================================================
