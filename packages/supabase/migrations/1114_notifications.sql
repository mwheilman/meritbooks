-- ============================================================================
-- 1114 · Suite notifications: ONE service for Merit Books and Merit Projects
--
-- Builds on Books 178 (core.notifications, core.notification_prefs, core.request_suppressions)
-- instead of a second inbox. Spec: panel 10 §2.5 (PLT-42…47), panel 06 §2.5 / §2e (handoffs and
-- the notification defaults by role), docs/projects/WAVE-A-BRIEF.md.
--
-- What this migration adds (everything additive; Books keeps working unchanged)
--   core.notifications (Books 178)      + source_app, event_type, job_id, subject_type / subject_id,
--                                        group_key + item_count (batching), actor_membership_id,
--                                        delivery ('instant' | 'digest'), done_at, money_masked, meta.
--                                        Books rows keep the defaults (source_app 'books').
--   core.notification_prefs (Books 178) + sms_phone (the member's own number for texts).
--   core.notification_event_types       catalog of event types (label, audience internal / customer,
--                                        money capability, mandatory, batching window).
--   core.notification_recipes           channel defaults per persona × event (platform rows, org
--                                        overrides). Seeded from panel 06 §2e (P / I / D / —).
--   core.notification_pref_rules        per-person event × channel matrix (instant / digest / off).
--   core.notification_settings          per company (org row = default): customer go-live flag (customer
--                                        messages are HELD until it flips), SMS on/off + from number,
--                                        mandatory events, frequency caps, lead SLA, quiet hours.
--   core.push_devices                   Expo push tokens per device (Merit Workforce app).
--   core.sms_consents                   one consent record per phone (source, text, timestamps, STOP).
--   core.outbound_messages              email / SMS / push queue (internal + customer), idempotent per
--                                        dispatch_key, quiet-hours not_before, held / suppressed states.
--   core.notification_digests           one claimed digest per member × cadence × period (idempotent).
--
-- Engine (service-only definer functions; nothing here is callable by members)
--   core.notify_fanout(…)               event → recipients → per-person channels. Never notifies the
--                                        actor; a job event only reaches people who can reach the job;
--                                        money text only for recipients holding the event's money
--                                        capability on that job / company (else the plain variant —
--                                        a notification never carries money the recipient can't see);
--                                        batching collapses noisy events into one unread row;
--                                        quiet hours defer push / SMS (critical bypasses); frequency
--                                        caps skip push / SMS / email (mandatory bypasses).
--   core.notify_customer(…)             customer-facing message: HELD until the company is live,
--                                        suppressed without SMS consent / on the STOP list.
--   core.notify_inbound_sms(…)          STOP / START / HELP keywords → consent + Books suppression list.
--   core.notify_outbound_claim / _result, notify_revoke_push_token, notify_digest_collect / _done,
--   notify_sweep (speed-to-lead breaches) — the worker surface (apps/projects lib/notify).
--
-- Recipes wired here as triggers (fire whoever writes the row: app, RPC, mobile sync)
--   pm.job_members insert                → job.assigned (the person added)
--   pm.tasks assignee change             → task.assigned;  later finish / start → schedule.changed
--   pm.punch_items assignee change       → punch.assigned
--   pm.change_orders → APPROVED          → change_order.signed (job team + billing approvers; amount
--                                          only with projects.contract_value)
--   pm.time_entries → SUBMITTED          → time.submitted (time approvers on the job, batched per job)
--   crm.leads owner change               → lead.assigned (estimated value only with contract_value)
--   notify_sweep (worker, every run)     → lead.sla_breach (no activity within the company's SLA)
--   Emitted by the app through pm.notify_emit: approval.requested / approval.decided,
--   document.sign_requested, comment.mention.
--
-- Member RPCs (pm schema; 1110 guard registry / allowlist)
--   pm.notify_emit, pm.notify_customer_message, pm.notify_configure, pm.notify_record_sms_consent,
--   pm.notify_set_recipe (guarded);  pm.notify_mark, pm.notify_save_prefs, pm.notify_register_device,
--   pm.notify_unregister_device, pm.notify_held_action (own rows / per-row checks — allowlisted).
--
-- ACCESS
--   Members read their own notifications / prefs / rules / devices / digests; the catalog and recipes;
--   their org's settings; outbound rows of companies where they hold projects.settings:configure (or
--   their own); SMS consents where they hold projects.customers:view. Every write is a definer RPC.
--   Projects-only seats: core.notifications / notification_prefs become NARROWED (own rows) instead
--   of denied (1110's projects_only_seat_deny would hide a Labor user's own inbox); the new tables are
--   exempt (their own policies already narrow them). Client-scope RLS (163) re-applied.
--
-- APPLY RULE: after 178, 1110, 1111, 1112. Idempotent; PGlite-safe. No GL effect.
-- ============================================================================

do $$
begin
  if to_regclass('core.notifications') is null then raise exception '1114_notifications requires 178_request_engine_notifications'; end if;
  if to_regclass('pm.access_table_classes') is null then raise exception '1114_notifications requires 1110_pm_access'; end if;
  if to_regclass('crm.leads') is null then raise exception '1114_notifications requires 1111_shared_records'; end if;
  if to_regprocedure('pm.schedule_org_settings_ok()') is null then raise exception '1114_notifications requires 1112_pm_schedule'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Extend the Books tables
-- ----------------------------------------------------------------------------
alter table core.notifications add column if not exists source_app text not null default 'books';
alter table core.notifications add column if not exists event_type text;
alter table core.notifications add column if not exists job_id uuid references core.jobs(id) on delete cascade;
alter table core.notifications add column if not exists subject_type text;
alter table core.notifications add column if not exists subject_id uuid;
alter table core.notifications add column if not exists group_key text;
alter table core.notifications add column if not exists item_count integer not null default 1;
alter table core.notifications add column if not exists actor_membership_id uuid references core.memberships(id) on delete set null;
alter table core.notifications add column if not exists delivery text not null default 'instant';
alter table core.notifications add column if not exists done_at timestamptz;
alter table core.notifications add column if not exists money_masked boolean not null default false;
alter table core.notifications add column if not exists meta jsonb not null default '{}'::jsonb;
alter table core.notifications add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_suite_chk') then
    alter table core.notifications add constraint notifications_suite_chk
      check (source_app in ('books','projects','suite')
             and delivery in ('instant','digest')
             and item_count >= 1
             and (event_type is null or event_type ~ '^[a-z][a-z0-9_.]{1,63}$')
             and (subject_type is null or subject_type ~ '^[a-z][a-z0-9_]{1,40}$')
             and (group_key is null or length(group_key) <= 200)
             and jsonb_typeof(meta) = 'object');
  end if;
end $$;
create index if not exists ix_notifications_group on core.notifications (membership_id, group_key, created_at desc)
  where group_key is not null and read_at is null;
create index if not exists ix_notifications_digest on core.notifications (membership_id, created_at)
  where delivery = 'digest' and emailed_at is null and read_at is null;
create index if not exists ix_notifications_job on core.notifications (job_id) where job_id is not null;

comment on column core.notifications.delivery is
  '1114: instant = inbox (and push / email when the recipient''s channels say so); digest = inbox, rolled into the daily / weekly digest email, never pushed.';
comment on column core.notifications.money_masked is
  '1114: the event carried money the recipient may not see, so the plain variant was stored. The money text never reaches this row.';

alter table core.notification_prefs add column if not exists sms_phone text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notification_prefs_sms_phone_chk') then
    alter table core.notification_prefs add constraint notification_prefs_sms_phone_chk
      check (sms_phone is null or sms_phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Event catalog
-- ----------------------------------------------------------------------------
create table if not exists core.notification_event_types (
  key                  text primary key,
  label                text not null,
  description          text not null,
  category             text not null,
  audience             text not null default 'internal',
  money_cap            text,
  mandatory            boolean not null default false,
  batch_window_minutes integer not null default 0,
  severity             text not null default 'info',
  emit_rpc             boolean not null default false,
  sort                 integer not null default 100,
  constraint notification_event_types_chk check (
    key ~ '^[a-z][a-z0-9_.]{1,63}$'
    and category in ('work','approvals','sales','schedule','time','documents','comments','customer')
    and audience in ('internal','customer')
    and (money_cap is null or money_cap in ('projects.contract_value','projects.financials'))
    and batch_window_minutes between 0 and 1440
    and severity in ('info','attention','critical'))
);
comment on table core.notification_event_types is
  '1114: notification event catalog (global). emit_rpc = the app may raise it through pm.notify_emit; the others are raised by triggers / the worker only (they cannot be spoofed).';

insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
  ('job.assigned',            'Added to a job',              'Someone put you on a job team.',                                   'work',      'internal', null,                      false, 0,   'info',      false, 10),
  ('task.assigned',           'Task assigned to you',        'A task on a job was assigned to you.',                             'work',      'internal', null,                      false, 0,   'info',      false, 20),
  ('punch.assigned',          'Punch item assigned to you',  'A punch, warranty or callback item was assigned to you.',          'work',      'internal', null,                      false, 0,   'info',      false, 30),
  ('schedule.changed',        'Your schedule changed',       'Work assigned to you moved later.',                                'schedule',  'internal', null,                      false, 60,  'attention', false, 40),
  ('time.submitted',          'Time to approve',             'Crew time was submitted on a job you approve time for.',           'time',      'internal', null,                      false, 240, 'info',      false, 50),
  ('approval.requested',      'Approval needed',             'Something is waiting for your approval.',                          'approvals', 'internal', 'projects.financials',     true,  0,   'attention', true,  60),
  ('approval.decided',        'Approval decided',            'Something you sent for approval was approved or returned.',        'approvals', 'internal', 'projects.financials',     false, 0,   'info',      true,  70),
  ('change_order.signed',     'Change order signed',         'A change order on your job was signed.',                           'approvals', 'internal', 'projects.contract_value', false, 0,   'info',      false, 80),
  ('lead.assigned',           'Lead assigned to you',        'A new lead is yours to contact.',                                  'sales',     'internal', 'projects.contract_value', false, 0,   'attention', false, 90),
  ('lead.sla_breach',         'Lead not contacted in time',  'A lead has had no call, text or email within the company''s speed-to-lead window.', 'sales', 'internal', null,       false, 0,   'attention', false, 100),
  ('document.sign_requested', 'Document to sign',            'A document is waiting for your signature.',                        'documents', 'internal', null,                      false, 0,   'attention', true,  110),
  ('comment.mention',         'Mentioned in a comment',      'Someone mentioned you in a comment.',                              'comments',  'internal', null,                      false, 0,   'info',      true,  120),
  ('customer.on_my_way',          'On my way',               'Tells the customer the crew or technician is on the way.',         'customer',  'customer', null,                      false, 0,   'info',      true,  200),
  ('customer.appointment_reminder','Appointment reminder',   'Confirms or reminds the customer of an appointment.',              'customer',  'customer', null,                      false, 0,   'info',      true,  210),
  ('customer.change_order_ready', 'Change order ready to sign', 'Tells the customer a change order is ready for their signature.', 'customer', 'customer', null,                      false, 0,   'info',      true,  220),
  ('customer.selection_reminder', 'Selection reminder',      'Reminds the customer of a selection that is due.',                 'customer',  'customer', null,                      false, 0,   'info',      true,  230),
  ('customer.job_complete',       'Job complete',            'Tells the customer the work is complete (and asks for a review).', 'customer',  'customer', null,                      false, 0,   'info',      true,  240),
  ('customer.message',            'Message to the customer', 'Any other message to a customer contact (field-service outbox, follow-ups).', 'customer', 'customer', null,               false, 0,   'info',      true,  250)
on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
  audience = excluded.audience, money_cap = excluded.money_cap, mandatory = excluded.mandatory,
  batch_window_minutes = excluded.batch_window_minutes, severity = excluded.severity, emit_rpc = excluded.emit_rpc, sort = excluded.sort;

-- ----------------------------------------------------------------------------
-- 3. Recipes: channel defaults per persona × event (platform rows; org overrides)
-- ----------------------------------------------------------------------------
create table if not exists core.notification_recipes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references core.organizations(id) on delete cascade,     -- null = platform default
  persona_key text not null,
  event_type  text not null references core.notification_event_types(key) on delete cascade,
  in_app      text not null default 'instant',
  push        text not null default 'off',
  email       text not null default 'off',
  sms         text not null default 'off',
  updated_by  text,
  updated_at  timestamptz not null default now(),
  constraint notification_recipes_chk check (
    persona_key ~ '^(projects_[a-z_]+|default)$'
    and in_app in ('instant','off') and push in ('instant','off')
    and email in ('instant','digest','off') and sms in ('instant','off'))
);
create unique index if not exists ux_notification_recipes_platform on core.notification_recipes (persona_key, event_type) where org_id is null;
create unique index if not exists ux_notification_recipes_org on core.notification_recipes (org_id, persona_key, event_type) where org_id is not null;
comment on table core.notification_recipes is
  '1114: who gets which event on which channel by default (panel 06 §2e: P = inbox + push, I = inbox, D = inbox + daily/weekly digest email, — = never). Persona = the recipient''s highest Projects role at the company; ''default'' = everyone else. Mirrored in apps/projects/src/lib/notify/recipes.ts (parity-tested).';

-- GENERATED-BY-HAND mirror of RECIPE_DEFAULTS (apps/projects/src/lib/notify/recipes.ts) — keep in sync.
do $$
declare
  v_personas text[] := array['projects_owner','projects_gm','projects_office_manager','projects_project_accountant',
                             'projects_dispatcher','projects_purchasing','projects_pm','projects_supervisor',
                             'projects_labor','projects_sales','default'];
  r record; i int; c text;
begin
  for r in select * from (values
    -- event                    owner gm  om  pa  disp pur pm  sup lab sal default
    ('job.assigned',            array['I','P','I','I','I','I','P','P','P','I','I']),
    ('task.assigned',           array['I','I','I','I','I','I','I','P','P','I','I']),
    ('punch.assigned',          array['I','I','I','I','I','I','I','P','P','I','I']),
    ('schedule.changed',        array['-','-','-','-','-','-','I','P','P','I','I']),
    ('time.submitted',          array['D','D','D','D','-','-','I','P','-','-','I']),
    ('approval.requested',      array['P','P','I','I','I','I','P','P','I','I','I']),
    ('approval.decided',        array['I','I','I','I','I','I','P','I','I','P','I']),
    ('change_order.signed',     array['D','P','D','I','-','I','P','D','-','P','I']),
    ('lead.assigned',           array['I','I','I','I','P','I','I','I','I','P','I']),
    ('lead.sla_breach',         array['D','I','I','-','P','-','-','-','-','P','I']),
    ('document.sign_requested', array['P','P','P','P','P','P','P','P','P','P','I']),
    ('comment.mention',         array['I','P','P','P','P','P','P','P','P','P','I'])
  ) as t(event_type, codes) loop
    for i in 1 .. array_length(v_personas, 1) loop
      c := r.codes[i];
      insert into core.notification_recipes as x (org_id, persona_key, event_type, in_app, push, email, sms)
      values (null, v_personas[i], r.event_type,
              case when c = '-' then 'off' else 'instant' end,
              case when c = 'P' then 'instant' else 'off' end,
              case when c = 'D' then 'digest' else 'off' end,
              'off')
      on conflict (persona_key, event_type) where org_id is null
      do update set in_app = excluded.in_app, push = excluded.push, email = excluded.email, sms = excluded.sms, updated_at = now();
    end loop;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Per-person matrix
-- ----------------------------------------------------------------------------
create table if not exists core.notification_pref_rules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  membership_id uuid not null references core.memberships(id) on delete cascade,
  event_type    text not null references core.notification_event_types(key) on delete cascade,
  channel       text not null,
  mode          text not null,
  updated_at    timestamptz not null default now(),
  constraint notification_pref_rules_chk check (
    channel in ('in_app','push','email','sms') and mode in ('instant','digest','off')
    and (mode <> 'digest' or channel = 'email'))
);
create unique index if not exists ux_notification_pref_rules on core.notification_pref_rules (membership_id, event_type, channel);
comment on table core.notification_pref_rules is
  '1114: a person''s own event × channel choices (override the recipe). Mandatory events ignore them (inbox always, role-default push).';

-- ----------------------------------------------------------------------------
-- 5. Company settings (org row = default for every company)
-- ----------------------------------------------------------------------------
create table if not exists core.notification_settings (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid references core.locations(id) on delete cascade,
  customer_messages_live boolean not null default false,
  live_at                timestamptz,
  live_by                text,
  sms_enabled            boolean not null default false,
  sms_from_number        text,
  mandatory_events       text[] not null default '{}'::text[],
  push_per_hour          integer not null default 6,
  sms_per_day            integer not null default 3,
  email_per_hour         integer not null default 12,
  customer_sms_per_day   integer not null default 2,
  lead_sla_minutes       integer not null default 60,
  quiet_start            time,
  quiet_end              time,
  timezone               text,
  updated_by             text,
  updated_at             timestamptz not null default now(),
  constraint notification_settings_chk check (
    (sms_from_number is null or sms_from_number ~ '^\+[1-9][0-9]{7,14}$')
    and push_per_hour between 1 and 120 and sms_per_day between 1 and 50 and email_per_hour between 1 and 200
    and customer_sms_per_day between 1 and 20 and lead_sla_minutes between 5 and 10080
    and ((quiet_start is null) = (quiet_end is null))
    and (timezone is null or timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$')
    and (customer_messages_live = false or live_at is not null))
);
create unique index if not exists ux_notification_settings_org on core.notification_settings (org_id) where location_id is null;
create unique index if not exists ux_notification_settings_company on core.notification_settings (org_id, location_id) where location_id is not null;
comment on table core.notification_settings is
  '1114: per company (location_id) notification settings; the org row (location_id null) is the default. customer_messages_live = false HOLDS every customer-facing message (PLT-47: nothing reaches a customer before go-live).';

-- Texting numbers (security review M): a company sends from — and inbound STOP / START resolves to —
-- only a number VERIFIED with the provider for that tenant. A number is verified for at most one
-- tenant (unique), only by the service role (core.notify_verify_sender, after the provider confirms
-- it), and core.notification_settings.sms_from_number may hold only a verified number of the same org.
create table if not exists core.sms_sender_numbers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid references core.locations(id) on delete cascade,
  phone         text not null,
  status        text not null default 'pending',
  provider      text not null default 'twilio',
  provider_sid  text,
  requested_by  text,
  requested_at  timestamptz not null default now(),
  verified_at   timestamptz,
  revoked_at    timestamptz,
  note          text,
  constraint sms_sender_numbers_chk check (
    phone ~ '^\+[1-9][0-9]{7,14}$' and status in ('pending','verified','revoked') and provider in ('twilio')
    and (status <> 'verified' or (verified_at is not null and provider_sid is not null))
    and coalesce(length(note), 0) <= 300)
);
create unique index if not exists ux_sms_sender_verified on core.sms_sender_numbers (phone) where status = 'verified';
create unique index if not exists ux_sms_sender_pending on core.sms_sender_numbers (org_id, phone) where status = 'pending';
comment on table core.sms_sender_numbers is
  '1114 (security review M): texting numbers per tenant. pending = asked for by a settings holder; verified = the provider confirmed the number belongs to this tenant (service role only); one verified tenant per number.';

create or replace function core.tg_notify_settings_sender() returns trigger
language plpgsql security definer
set search_path = core, public, pg_temp
as $$
begin
  if new.sms_from_number is not null and (tg_op = 'INSERT' or new.sms_from_number is distinct from old.sms_from_number)
     and not exists (select 1 from core.sms_sender_numbers n
                      where n.phone = new.sms_from_number and n.org_id = new.org_id and n.status = 'verified'
                        and (n.location_id is null or n.location_id is not distinct from new.location_id)) then
    raise exception 'PM_INVALID: that texting number is not verified for this company' using errcode = '22023';
  end if;
  if new.sms_enabled and new.sms_from_number is null then
    raise exception 'PM_INVALID: verify a texting number before turning texting on' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_settings_sender on core.notification_settings;
create trigger trg_notify_settings_sender before insert or update of sms_from_number, sms_enabled on core.notification_settings
  for each row execute function core.tg_notify_settings_sender();

-- ----------------------------------------------------------------------------
-- 6. Devices, consents, outbound queue, digests
-- ----------------------------------------------------------------------------
create table if not exists core.push_devices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  membership_id uuid not null references core.memberships(id) on delete cascade,
  token         text not null,
  platform      text not null,
  app           text not null default 'workforce',
  device_name   text,
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  revoke_reason text,
  constraint push_devices_chk check (
    token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'
    and platform in ('ios','android','web') and app in ('workforce','projects')
    and coalesce(length(device_name), 0) <= 120 and coalesce(length(app_version), 0) <= 40)
);
create unique index if not exists ux_push_devices_token on core.push_devices (token);
create index if not exists ix_push_devices_member on core.push_devices (membership_id) where revoked_at is null;
comment on table core.push_devices is
  '1114: Expo push tokens (Merit Workforce). A token belongs to whoever signed in on that phone last; Expo "DeviceNotRegistered" revokes it.';

create table if not exists core.sms_consents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid references core.locations(id) on delete set null,
  phone         text not null,
  membership_id uuid references core.memberships(id) on delete set null,
  contact_id    uuid references core.contacts(id) on delete set null,
  status        text not null,
  source        text not null,
  consent_text  text,
  consented_at  timestamptz,
  opted_out_at  timestamptz,
  last_keyword  text,
  recorded_by   text,
  updated_at    timestamptz not null default now(),
  constraint sms_consents_chk check (
    phone ~ '^\+[1-9][0-9]{7,14}$'
    and status in ('opted_in','opted_out')
    and source in ('web_form','verbal','paper','app_settings','keyword','import','portal')
    and (status <> 'opted_in' or consented_at is not null)
    and coalesce(length(consent_text), 0) <= 1000)
);
create unique index if not exists ux_sms_consents_phone on core.sms_consents (org_id, phone);
comment on table core.sms_consents is
  '1114 (PLT-44): the one SMS consent record per phone and tenant — source, wording, timestamps, STOP. A STOP also lands on core.request_suppressions so Books dunning texts honor it.';

create table if not exists core.outbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid references core.locations(id) on delete cascade,
  channel             text not null,
  audience            text not null,
  event_type          text references core.notification_event_types(key),
  notification_id     uuid references core.notifications(id) on delete set null,
  membership_id       uuid references core.memberships(id) on delete cascade,
  contact_id          uuid references core.contacts(id) on delete set null,
  job_id              uuid references core.jobs(id) on delete set null,
  to_address          text,
  subject             text,
  body                text not null,
  deep_link           text,
  data                jsonb not null default '{}'::jsonb,
  status              text not null default 'queued',
  status_reason       text,
  not_before          timestamptz not null default now(),
  dispatch_key        text,
  attempts            integer not null default 0,
  provider            text,
  provider_message_id text,
  last_error          text,
  created_by          text,
  created_at          timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  updated_at          timestamptz not null default now(),
  constraint outbound_messages_chk check (
    channel in ('email','sms','push') and audience in ('internal','customer')
    and status in ('queued','held','sending','sent','failed','skipped','suppressed','cancelled')
    and (audience <> 'internal' or membership_id is not null)
    and (channel = 'push' or to_address is not null)
    and length(body) between 1 and 4000 and coalesce(length(subject), 0) <= 300
    and (deep_link is null or (left(deep_link, 1) = '/' and left(deep_link, 2) <> '//'))
    and attempts between 0 and 20 and jsonb_typeof(data) = 'object')
);
create unique index if not exists ux_outbound_dispatch on core.outbound_messages (dispatch_key) where dispatch_key is not null;
create index if not exists ix_outbound_due on core.outbound_messages (not_before) where status = 'queued';
create index if not exists ix_outbound_held on core.outbound_messages (org_id, location_id, created_at desc) where status = 'held';
create index if not exists ix_outbound_member_cap on core.outbound_messages (membership_id, channel, created_at desc) where membership_id is not null;
create index if not exists ix_outbound_address_cap on core.outbound_messages (org_id, channel, to_address, created_at desc) where audience = 'customer';
comment on table core.outbound_messages is
  '1114: the email / SMS / push queue. held = customer message waiting for the company''s go-live (or for texting to be set up); suppressed = no consent / STOP / bounce list; skipped = a frequency cap or a channel that is not configured. The worker (apps/projects lib/notify/dispatch.ts) claims queued rows whose not_before has passed.';

create table if not exists core.notification_digests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  membership_id uuid not null references core.memberships(id) on delete cascade,
  cadence       text not null,
  period_key    text not null,
  status        text not null default 'claimed',
  item_ids      uuid[] not null default '{}'::uuid[],
  item_count    integer not null default 0,
  provider_message_id text,
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  constraint notification_digests_chk check (cadence in ('daily','weekly') and status in ('claimed','sent') and length(period_key) between 6 and 12)
);
create unique index if not exists ux_notification_digests on core.notification_digests (membership_id, cadence, period_key);

-- ----------------------------------------------------------------------------
-- 7. Engine helpers (service-only; definer, pinned search_path)
-- ----------------------------------------------------------------------------
create or replace function core.notify_money_text(p_cents bigint) returns text
language sql immutable
set search_path = core, public, pg_temp
as $$
  select case when p_cents is null then null
              else (case when p_cents < 0 then '-' else '' end) || '$' || to_char(abs(p_cents)::numeric / 100, 'FM999,999,999,990.00') end
$$;

create or replace function core.notify_job_label(p_job uuid) returns text
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select nullif(btrim(concat_ws(' ', j.job_number, nullif(j.name, j.job_number))), '') from core.jobs j where j.id = p_job
$$;

create or replace function core.notify_membership_for_clerk(p_org uuid, p_clerk text) returns uuid
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select ms.id from core.memberships ms join core.users u on u.id = ms.user_id
   where ms.org_id = p_org and u.clerk_user_id = p_clerk and ms.status = 'active'
   limit 1
$$;

create or replace function core.notify_membership_for_employee(p_org uuid, p_employee uuid) returns uuid
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select core.notify_membership_for_clerk(p_org, e.clerk_user_id) from core.employees e
   where e.id = p_employee and e.org_id = p_org and e.clerk_user_id is not null
$$;

-- Can this membership reach the job (1110's rule, for a recipient rather than the caller):
-- projects.jobs_all:view at the job's company, or projects.jobs:view there and the job is theirs
-- (job team, PM / super, task or punch assignee, dispatched as employee or crew).
create or replace function core.notify_member_reaches_job(p_m uuid, p_job uuid) returns boolean
language plpgsql stable security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_loc uuid; v_org uuid; v_clerk text;
begin
  select j.location_id, j.org_id into v_loc, v_org from core.jobs j where j.id = p_job;
  if v_loc is null then return false; end if;
  select u.clerk_user_id into v_clerk from core.memberships ms join core.users u on u.id = ms.user_id
   where ms.id = p_m and ms.org_id = v_org and ms.status = 'active';
  if v_clerk is null then return false; end if;
  if core.membership_has_capability(p_m, 'projects.jobs_all', 'view', v_loc) then return true; end if;
  if not core.membership_has_capability(p_m, 'projects.jobs', 'view', v_loc) then return false; end if;
  return exists (select 1 from pm.job_members jm where jm.job_id = p_job and jm.membership_id = p_m)
      or exists (select 1 from pm.projects p where p.job_id = p_job and (p.pm_user_id = v_clerk or p.super_user_id = v_clerk))
      or exists (select 1 from pm.tasks t where t.job_id = p_job and t.assignee_user_id = v_clerk)
      or exists (select 1 from pm.tasks t join core.employees e on e.id = t.assignee_employee_id
                  where t.job_id = p_job and e.org_id = v_org and e.clerk_user_id = v_clerk)
      or exists (select 1 from pm.punch_items pi where pi.job_id = p_job and pi.assignee_user_id = v_clerk)
      or exists (select 1 from pm.dispatch_assignments d join core.employees e on e.id = d.employee_id
                  where d.job_id = p_job and e.org_id = v_org and e.clerk_user_id = v_clerk)
      or exists (select 1 from pm.dispatch_assignments d join pm.crew_members cm on cm.crew_id = d.crew_id
                  join core.employees e on e.id = cm.employee_id
                  where d.job_id = p_job and e.org_id = v_org and e.clerk_user_id = v_clerk);
end $$;

-- May the recipient see this money? Money capability at the company, and (for a job) the job is
-- one they reach. NULL capability = no money in the event.
create or replace function core.notify_member_sees_money(p_m uuid, p_cap text, p_location uuid, p_job uuid) returns boolean
language plpgsql stable security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_loc uuid := p_location;
begin
  if p_cap is null then return true; end if;
  if p_job is not null then
    select j.location_id into v_loc from core.jobs j where j.id = p_job;
    if v_loc is null or not core.notify_member_reaches_job(p_m, p_job) then return false; end if;
  end if;
  if v_loc is null then return false; end if;
  return core.membership_has_capability(p_m, p_cap, 'view', v_loc);
end $$;

-- The recipient's primary Projects persona at a company (highest-ranked template key among their
-- active role assignments covering it; NULL company = any). 'default' when they hold none.
create or replace function core.notify_member_persona(p_m uuid, p_location uuid) returns text
language sql stable security definer
set search_path = core, pm, public, pg_temp
as $$
  select coalesce((
    select coalesce(up.key, rd.key)
      from core.access_assignments a
      join core.role_definitions rd on rd.id = a.role_id
      left join core.role_definitions up on up.id = rd.upstream_template_id and up.owner_level = 'platform'
     where a.membership_id = p_m and a.grant_type = 'role' and a.status = 'active'
       and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
       and coalesce(up.key, rd.key) like 'projects\_%'
       and (p_location is null or a.scope_type = 'all_clients'
            or (a.scope_type = 'client' and a.location_id = p_location)
            or (a.scope_type = 'client_set' and exists (select 1 from core.client_set_members c
                                                        where c.set_id = a.client_set_id and c.location_id = p_location)))
     order by pm.access_persona_rank(coalesce(up.key, rd.key)) desc
     limit 1), 'default')
$$;

-- Effective settings for a company: its own row, else the org row, else built-in defaults.
create or replace function core.notify_settings_row(p_org uuid, p_location uuid) returns core.notification_settings
language plpgsql stable security definer
set search_path = core, public, pg_temp
as $$
declare r core.notification_settings;
begin
  select s.* into r from core.notification_settings s
   where s.org_id = p_org and (s.location_id is null or s.location_id = p_location)
   order by s.location_id nulls last limit 1;
  if not found then
    r.org_id := p_org; r.location_id := p_location; r.customer_messages_live := false; r.sms_enabled := false;
    r.mandatory_events := '{}'; r.push_per_hour := 6; r.sms_per_day := 3; r.email_per_hour := 12;
    r.customer_sms_per_day := 2; r.lead_sla_minutes := 60;
  end if;
  return r;
end $$;

-- When a quiet-hours window [qs, qe) in tz covers p_at, the moment it ends; else p_at.
create or replace function core.notify_quiet_end(p_at timestamptz, p_qs time, p_qe time, p_tz text) returns timestamptz
language plpgsql stable
set search_path = core, public, pg_temp
as $$
declare v_tz text := coalesce(nullif(p_tz, ''), 'UTC'); v_local timestamp; v_t time; v_end timestamp;
begin
  if p_qs is null or p_qe is null or p_qs = p_qe then return p_at; end if;
  begin
    v_local := p_at at time zone v_tz;
  exception when others then
    v_tz := 'UTC';
    v_local := p_at at time zone 'UTC';
  end;
  v_t := v_local::time;
  if p_qs < p_qe then
    if v_t >= p_qs and v_t < p_qe then v_end := v_local::date + p_qe; else return p_at; end if;
  elsif v_t >= p_qs then
    v_end := (v_local::date + 1) + p_qe;
  elsif v_t < p_qe then
    v_end := v_local::date + p_qe;
  else
    return p_at;
  end if;
  return v_end at time zone v_tz;
end $$;

-- The member's time zone: their prefs → the company / org notification settings → the org → UTC.
create or replace function core.notify_member_tz(p_m uuid, p_location uuid) returns text
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select coalesce(nullif(pr.timezone, ''), nullif((core.notify_settings_row(ms.org_id, p_location)).timezone, ''), nullif(o.timezone, ''), 'UTC')
    from core.memberships ms
    join core.organizations o on o.id = ms.org_id
    left join core.notification_prefs pr on pr.membership_id = ms.id
   where ms.id = p_m
$$;

-- Earliest moment a push / text may reach this member (their quiet hours, else the company's).
create or replace function core.notify_next_allowed(p_m uuid, p_location uuid, p_at timestamptz) returns timestamptz
language plpgsql stable security definer
set search_path = core, public, pg_temp
as $$
declare pr record; s core.notification_settings; v_org uuid;
begin
  select ms.org_id into v_org from core.memberships ms where ms.id = p_m;
  select p.quiet_start, p.quiet_end into pr from core.notification_prefs p where p.membership_id = p_m;
  if pr.quiet_start is not null then
    return core.notify_quiet_end(p_at, pr.quiet_start, pr.quiet_end, core.notify_member_tz(p_m, p_location));
  end if;
  s := core.notify_settings_row(v_org, p_location);
  return core.notify_quiet_end(p_at, s.quiet_start, s.quiet_end, core.notify_member_tz(p_m, p_location));
end $$;

-- Over the frequency cap for this member and channel?
create or replace function core.notify_over_cap(p_m uuid, p_channel text, p_location uuid) returns boolean
language plpgsql stable security definer
set search_path = core, public, pg_temp
as $$
declare s core.notification_settings; v_org uuid; v_limit int; v_window interval; v_n int;
begin
  select ms.org_id into v_org from core.memberships ms where ms.id = p_m;
  s := core.notify_settings_row(v_org, p_location);
  if p_channel = 'push' then v_limit := s.push_per_hour; v_window := interval '1 hour';
  elsif p_channel = 'sms' then v_limit := s.sms_per_day; v_window := interval '1 day';
  else v_limit := s.email_per_hour; v_window := interval '1 hour'; end if;
  select count(*) into v_n from core.outbound_messages o
   where o.membership_id = p_m and o.channel = p_channel and o.status in ('queued','sending','sent')
     and o.created_at > now() - v_window;
  return v_n >= v_limit;
end $$;

-- Channels for one recipient and event: recipe (org override → platform; exact persona → default),
-- then the person's matrix, Books prefs (muted kinds, email channel, digest off), mandatory events.
drop function if exists core.notify_modes(uuid, text, uuid);
create or replace function core.notify_modes(p_m uuid, p_event text, p_location uuid, p_honor_mandatory boolean default true,
  out persona text, out in_app text, out push text, out email text, out sms text, out mandatory boolean)
language plpgsql stable security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_org uuid; r record; pr record; s core.notification_settings; ev record;
begin
  select ms.org_id into v_org from core.memberships ms where ms.id = p_m;
  select * into ev from core.notification_event_types e where e.key = p_event;
  persona := core.notify_member_persona(p_m, p_location);
  select x.in_app, x.push, x.email, x.sms into r from core.notification_recipes x
   where x.event_type = p_event and (x.org_id = v_org or x.org_id is null) and x.persona_key in (persona, 'default')
   order by (x.persona_key = persona) desc, (x.org_id is null) asc
   limit 1;
  in_app := coalesce(r.in_app, 'off'); push := coalesce(r.push, 'off'); email := coalesce(r.email, 'off'); sms := coalesce(r.sms, 'off');
  s := core.notify_settings_row(v_org, p_location);
  mandatory := p_honor_mandatory and (coalesce(ev.mandatory, false) or p_event = any (coalesce(s.mandatory_events, '{}'::text[])));
  if mandatory then
    in_app := 'instant';
    return;
  end if;
  in_app := coalesce((select pr2.mode from core.notification_pref_rules pr2 where pr2.membership_id = p_m and pr2.event_type = p_event and pr2.channel = 'in_app'), in_app);
  push   := coalesce((select pr2.mode from core.notification_pref_rules pr2 where pr2.membership_id = p_m and pr2.event_type = p_event and pr2.channel = 'push'), push);
  email  := coalesce((select pr2.mode from core.notification_pref_rules pr2 where pr2.membership_id = p_m and pr2.event_type = p_event and pr2.channel = 'email'), email);
  sms    := coalesce((select pr2.mode from core.notification_pref_rules pr2 where pr2.membership_id = p_m and pr2.event_type = p_event and pr2.channel = 'sms'), sms);
  if in_app = 'digest' then in_app := 'instant'; end if;
  if push = 'digest' then push := 'off'; end if;
  if sms = 'digest' then sms := 'off'; end if;
  select p.channels, p.digest, p.muted_kinds into pr from core.notification_prefs p where p.membership_id = p_m;
  if found then
    if p_event = any (coalesce(pr.muted_kinds, '{}'::text[])) then
      in_app := 'off'; push := 'off'; email := 'off'; sms := 'off';
      return;
    end if;
    -- Books prefs.channels governs email (its UI shows in-app + email); push / text follow the matrix.
    if not ('email' = any (coalesce(pr.channels, array['in_app','email']::text[]))) then email := 'off'; end if;
    if pr.digest = 'off' and email = 'digest' then email := 'off'; end if;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Fan-out: event → recipients → channels (service / trigger / guarded RPC callers only)
-- ----------------------------------------------------------------------------
drop function if exists core.notify_fanout(uuid, text, uuid, uuid, text, uuid, uuid, uuid[], text, text, text, text, text, text, jsonb, text, text);
create or replace function core.notify_fanout(
  p_org uuid, p_event text, p_location uuid, p_job uuid,
  p_subject_type text, p_subject_id uuid, p_actor uuid, p_recipients uuid[],
  p_title text, p_body text, p_title_money text, p_body_money text,
  p_deep_link text, p_dedupe text, p_meta jsonb default '{}'::jsonb,
  p_money_cap text default null, p_severity text default null, p_member_raised boolean default false)
returns integer
language plpgsql volatile security definer
set search_path = core, pm, public, pg_temp
as $$
declare
  ev record; v_loc uuid := p_location; v_cap text; v_m uuid; md record; v_sees boolean; v_has_money boolean;
  v_title text; v_body text; v_masked boolean; v_delivery text; v_group text; v_existing uuid; v_nid uuid;
  v_severity text; v_link text; v_n int := 0; v_email text; v_phone text; v_label text; s core.notification_settings;
  v_meta jsonb;
begin
  select * into ev from core.notification_event_types e where e.key = p_event;
  if ev.key is null or ev.audience <> 'internal' then
    raise exception 'PM_INVALID: unknown internal notification event %', p_event using errcode = '22023';
  end if;
  if p_job is not null then
    select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = p_org;
    if v_loc is null then raise exception 'PM_INVALID: job % is not in this organization', p_job using errcode = '22023'; end if;
    v_label := core.notify_job_label(p_job);
  end if;
  if v_loc is not null and not exists (select 1 from core.locations l where l.id = v_loc and l.org_id = p_org) then
    raise exception 'PM_INVALID: company % is not in this organization', v_loc using errcode = '22023';
  end if;
  v_cap := coalesce(p_money_cap, ev.money_cap);
  v_has_money := p_title_money is not null or p_body_money is not null;
  v_severity := coalesce(p_severity, ev.severity);
  v_link := case when p_deep_link is not null and left(p_deep_link, 1) = '/' and left(p_deep_link, 2) <> '//' and position(E'\\' in p_deep_link) = 0
                 then left(p_deep_link, 500) end;
  v_group := case when ev.batch_window_minutes > 0
                  then left(p_event || ':' || coalesce(p_job::text, p_subject_id::text, 'org'), 200) end;
  v_meta := coalesce(p_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('job_label', v_label));
  -- money never lands in meta (only the masked text decides what the recipient reads)
  v_meta := v_meta - array(select k from jsonb_object_keys(v_meta) k where k like '%\_cents' or k like '%amount%');
  s := core.notify_settings_row(p_org, v_loc);

  for v_m in select distinct x from unnest(coalesce(p_recipients, '{}'::uuid[])) x where x is not null loop
    continue when v_m is not distinct from p_actor;                       -- never notify the actor
    continue when not exists (select 1 from core.memberships ms
                               where ms.id = v_m and ms.org_id = p_org and ms.status = 'active'
                                 and coalesce(ms.audience, 'internal_staff') in ('internal_staff','platform'));
    if p_job is not null then
      continue when not core.notify_member_reaches_job(v_m, p_job);       -- never leak a job
    elsif v_loc is not null then
      continue when core.notify_member_persona(v_m, v_loc) = 'default'
                and not core.membership_has_capability(v_m, 'projects.jobs', 'view', v_loc)
                and not core.membership_has_capability(v_m, 'projects.leads', 'view', v_loc);
    end if;

    -- member-raised notifications (mentions, signing requests) are never mandatory (security review L)
    select * into md from core.notify_modes(v_m, p_event, v_loc, not p_member_raised);
    continue when md.in_app = 'off' and md.push = 'off' and md.email = 'off' and md.sms = 'off';

    v_sees := (not v_has_money) or core.notify_member_sees_money(v_m, v_cap, v_loc, p_job);
    v_masked := v_has_money and not v_sees;
    v_title := left(coalesce(case when v_sees then p_title_money end, p_title), 200);
    v_body := left(coalesce(case when v_sees then coalesce(p_body_money, p_body) end, p_body), 1000);
    v_delivery := case when md.email = 'digest' and md.push = 'off' and md.sms = 'off' then 'digest' else 'instant' end;

    -- batching: one unread row per (member, group) inside the window; no second push
    v_existing := null;
    if v_group is not null then
      select n.id into v_existing from core.notifications n
       where n.membership_id = v_m and n.group_key = v_group and n.read_at is null and n.done_at is null
         and n.created_at > now() - make_interval(mins => ev.batch_window_minutes)
       order by n.created_at desc limit 1;
    end if;
    if v_existing is not null then
      if p_dedupe is not null and exists (select 1 from core.notifications n where n.membership_id = v_m and n.meta -> 'dedupes' ? p_dedupe) then
        continue;
      end if;
      update core.notifications n
         set item_count = n.item_count + 1,
             body = left((n.item_count + 1)::text || ' updates. Latest: ' || coalesce(v_body, v_title), 1000),
             money_masked = n.money_masked or v_masked,
             meta = jsonb_set(n.meta, '{dedupes}', coalesce(n.meta -> 'dedupes', '[]'::jsonb) || to_jsonb(coalesce(p_dedupe, gen_random_uuid()::text))),
             updated_at = now()
       where n.id = v_existing;
      v_n := v_n + 1;
      continue;
    end if;

    v_nid := null;
    insert into core.notifications as n (org_id, location_id, membership_id, kind, severity, title, body, deep_link, dedupe_key,
                                         source_app, event_type, job_id, subject_type, subject_id, group_key, actor_membership_id,
                                         delivery, money_masked, meta)
    values (p_org, v_loc, v_m, p_event, v_severity, coalesce(nullif(v_title, ''), ev.label), v_body, v_link, p_dedupe,
            'projects', p_event, p_job, p_subject_type, p_subject_id, v_group, p_actor,
            v_delivery, v_masked,
            case when v_group is not null and p_dedupe is not null then v_meta || jsonb_build_object('dedupes', jsonb_build_array(p_dedupe)) else v_meta end)
    on conflict (membership_id, dedupe_key) where dedupe_key is not null do nothing
    returning n.id into v_nid;
    continue when v_nid is null;                                           -- already notified (idempotent)
    v_n := v_n + 1;

    -- push (instant only; quiet hours defer unless critical; the cap skips unless mandatory)
    if md.push = 'instant' and exists (select 1 from core.push_devices d where d.membership_id = v_m and d.revoked_at is null) then
      if not md.mandatory and core.notify_over_cap(v_m, 'push', v_loc) then
        insert into core.outbound_messages (org_id, location_id, channel, audience, event_type, notification_id, membership_id, job_id,
                                            subject, body, deep_link, data, status, status_reason, dispatch_key)
        values (p_org, v_loc, 'push', 'internal', p_event, v_nid, v_m, p_job, coalesce(nullif(v_title, ''), ev.label), coalesce(v_body, ev.label), v_link,
                jsonb_build_object('notificationId', v_nid, 'event', p_event), 'skipped', 'frequency cap', 'push:' || v_nid)
        on conflict (dispatch_key) where dispatch_key is not null do nothing;
      else
        insert into core.outbound_messages (org_id, location_id, channel, audience, event_type, notification_id, membership_id, job_id,
                                            subject, body, deep_link, data, not_before, dispatch_key)
        values (p_org, v_loc, 'push', 'internal', p_event, v_nid, v_m, p_job, coalesce(nullif(v_title, ''), ev.label), coalesce(v_body, ev.label), v_link,
                jsonb_build_object('notificationId', v_nid, 'event', p_event, 'deepLink', v_link),
                case when v_severity = 'critical' then now() else core.notify_next_allowed(v_m, v_loc, now()) end,
                'push:' || v_nid)
        on conflict (dispatch_key) where dispatch_key is not null do nothing;
      end if;
    end if;

    -- email (instant)
    if md.email = 'instant' then
      select nullif(btrim(u.email), '') into v_email from core.memberships ms join core.users u on u.id = ms.user_id where ms.id = v_m;
      if v_email is not null and not exists (select 1 from core.request_suppressions rs
                                              where rs.org_id = p_org and rs.channel = 'email' and rs.address = lower(v_email)) then
        insert into core.outbound_messages (org_id, location_id, channel, audience, event_type, notification_id, membership_id, job_id,
                                            to_address, subject, body, deep_link, status, status_reason, dispatch_key)
        values (p_org, v_loc, 'email', 'internal', p_event, v_nid, v_m, p_job, lower(v_email), coalesce(nullif(v_title, ''), ev.label),
                coalesce(v_body, v_title, ev.label), v_link,
                case when not md.mandatory and core.notify_over_cap(v_m, 'email', v_loc) then 'skipped' else 'queued' end,
                case when not md.mandatory and core.notify_over_cap(v_m, 'email', v_loc) then 'frequency cap' end,
                'email:' || v_nid)
        on conflict (dispatch_key) where dispatch_key is not null do nothing;
      end if;
    end if;

    -- text (instant; texting on for the company, the member's number, opted in, not on the STOP list)
    if md.sms = 'instant' and s.sms_enabled then
      select p.sms_phone into v_phone from core.notification_prefs p where p.membership_id = v_m;
      if v_phone is not null
         and exists (select 1 from core.sms_consents c where c.org_id = p_org and c.phone = v_phone and c.status = 'opted_in')
         and not exists (select 1 from core.request_suppressions rs where rs.org_id = p_org and rs.channel = 'sms' and rs.address = lower(v_phone)) then
        insert into core.outbound_messages (org_id, location_id, channel, audience, event_type, notification_id, membership_id, job_id,
                                            to_address, body, deep_link, status, status_reason, not_before, dispatch_key)
        values (p_org, v_loc, 'sms', 'internal', p_event, v_nid, v_m, p_job, v_phone,
                left(coalesce(nullif(v_title, ''), ev.label) || coalesce(' — ' || v_body, ''), 320), v_link,
                case when not md.mandatory and core.notify_over_cap(v_m, 'sms', v_loc) then 'skipped' else 'queued' end,
                case when not md.mandatory and core.notify_over_cap(v_m, 'sms', v_loc) then 'frequency cap' end,
                case when v_severity = 'critical' then now() else core.notify_next_allowed(v_m, v_loc, now()) end,
                'sms:' || v_nid)
        on conflict (dispatch_key) where dispatch_key is not null do nothing;
      end if;
    end if;
  end loop;
  return v_n;
end $$;
comment on function core.notify_fanout(uuid, text, uuid, uuid, text, uuid, uuid, uuid[], text, text, text, text, text, text, jsonb, text, text, boolean) is
  '1114: the one fan-out. Recipients are filtered (active internal seat, reaches the job, not the actor); money text only for recipients holding the money capability on the job; per-person channels; batching; quiet hours; caps. Service / trigger / guarded RPC callers only.';

-- Active members of the org holding cap:action at the company (candidate recipients by grant).
create or replace function core.notify_members_with(p_org uuid, p_location uuid, p_cap text, p_action text) returns uuid[]
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select coalesce(array_agg(ms.id), '{}'::uuid[]) from core.memberships ms
   where ms.org_id = p_org and ms.status = 'active'
     and core.membership_has_capability(ms.id, p_cap, p_action, p_location)
$$;

-- ----------------------------------------------------------------------------
-- 9. Customer-facing messages (HELD until go-live; consent; STOP list)
-- ----------------------------------------------------------------------------
-- A phone in E.164, or null (US / Canada 10-digit numbers get +1).
create or replace function core.notify_e164(p_phone text) returns text
language plpgsql immutable
set search_path = core, public, pg_temp
as $$
declare v text;
begin
  if p_phone is null then return null; end if;
  v := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if v ~ '^\+[1-9][0-9]{7,14}$' then return v; end if;
  v := regexp_replace(v, '[^0-9]', '', 'g');
  if length(v) = 10 then return '+1' || v; end if;
  if length(v) = 11 and left(v, 1) = '1' then return '+' || v; end if;
  return null;
end $$;

-- Text consent for a number: the core.sms_consents record decides (opted_in / opted_out); with no
-- record, a contact in the tenant with that number and core.contacts.sms_consent = true counts
-- (the 1111 / 1117 consent flag). The STOP list always wins.
create or replace function core.notify_sms_consented(p_org uuid, p_phone text) returns boolean
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select p_phone is not null
     and not exists (select 1 from core.request_suppressions rs where rs.org_id = p_org and rs.channel = 'sms' and rs.address = lower(p_phone))
     and coalesce((select c.status = 'opted_in' from core.sms_consents c where c.org_id = p_org and c.phone = p_phone),
                  exists (select 1 from core.contacts ct where ct.org_id = p_org and ct.sms_consent and core.notify_e164(ct.phone) = p_phone))
$$;

create or replace function core.notify_customer(
  p_org uuid, p_location uuid, p_job uuid, p_event text, p_channel text, p_contact uuid,
  p_subject text, p_body text, p_deep_link text, p_dedupe text, p_created_by text)
returns uuid
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare
  ev record; c record; s core.notification_settings; v_to text; v_status text := 'queued'; v_reason text; v_id uuid;
  v_not_before timestamptz := now(); v_qs time; v_qe time; v_tz text;
begin
  select * into ev from core.notification_event_types e where e.key = p_event;
  if ev.key is null or ev.audience <> 'customer' then
    raise exception 'PM_INVALID: % is not a customer message', p_event using errcode = '22023';
  end if;
  if p_channel not in ('email','sms') then raise exception 'PM_INVALID: customer messages go by email or text' using errcode = '22023'; end if;
  select ct.id, ct.email, ct.phone, ct.customer_id into c from core.contacts ct where ct.id = p_contact and ct.org_id = p_org;
  if c.id is null then raise exception 'PM_INVALID: contact not found' using errcode = '22023'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'PM_INVALID: the message is empty' using errcode = '22023'; end if;
  s := core.notify_settings_row(p_org, p_location);

  if p_channel = 'email' then
    v_to := lower(nullif(btrim(c.email), ''));
    if v_to is null or v_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'PM_INVALID: this contact has no email address' using errcode = '22023'; end if;
  else
    v_to := core.notify_e164(c.phone);
    if v_to is null then raise exception 'PM_INVALID: this contact has no mobile number' using errcode = '22023'; end if;
  end if;

  if exists (select 1 from core.request_suppressions rs where rs.org_id = p_org and rs.channel = p_channel and rs.address = lower(v_to)) then
    v_status := 'suppressed'; v_reason := case when p_channel = 'sms' then 'The customer replied STOP' else 'This address unsubscribed or bounced' end;
  elsif p_channel = 'sms' and not core.notify_sms_consented(p_org, v_to) then
    v_status := 'suppressed'; v_reason := 'No text-message consent on file for this number';
  elsif not s.customer_messages_live then
    v_status := 'held'; v_reason := 'Customer messages are held until this company goes live';
  elsif p_channel = 'sms' and not s.sms_enabled then
    v_status := 'held'; v_reason := 'Texting is not set up for this company yet';
  elsif p_channel = 'sms' and (select count(*) from core.outbound_messages o where o.org_id = p_org and o.channel = 'sms' and o.to_address = v_to
                                  and o.audience = 'customer' and o.status in ('queued','sending','sent') and o.created_at > now() - interval '1 day') >= s.customer_sms_per_day then
    v_status := 'skipped'; v_reason := 'Daily text limit for this customer reached';
  end if;

  if p_channel = 'sms' then
    -- customer texts: the company's quiet hours, else 9 p.m.–8 a.m. in the company's time zone
    v_qs := coalesce(s.quiet_start, time '21:00'); v_qe := case when s.quiet_start is null then time '08:00' else s.quiet_end end;
    v_tz := coalesce(nullif(s.timezone, ''), (select nullif(o.timezone, '') from core.organizations o where o.id = p_org), 'UTC');
    v_not_before := core.notify_quiet_end(now(), v_qs, v_qe, v_tz);
  end if;

  insert into core.outbound_messages as o (org_id, location_id, channel, audience, event_type, contact_id, job_id, to_address, subject, body,
                                           deep_link, status, status_reason, not_before, dispatch_key, created_by)
  values (p_org, p_location, p_channel, 'customer', p_event, p_contact, p_job, v_to, left(p_subject, 300), left(p_body, case when p_channel = 'sms' then 640 else 4000 end),
          case when p_deep_link is not null and left(p_deep_link, 1) = '/' and left(p_deep_link, 2) <> '//' then left(p_deep_link, 500) end,
          v_status, v_reason, v_not_before, p_dedupe, p_created_by)
  on conflict (dispatch_key) where dispatch_key is not null do nothing
  returning o.id into v_id;
  if v_id is null then select o.id into v_id from core.outbound_messages o where o.dispatch_key = p_dedupe; end if;
  return v_id;
end $$;


-- ----------------------------------------------------------------------------
-- 10. Inbound SMS keywords (Twilio webhook → service role)
-- ----------------------------------------------------------------------------
create or replace function core.notify_inbound_sms(p_from text, p_to text, p_body text) returns jsonb
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare v_from text := core.notify_e164(p_from); v_to text := core.notify_e164(p_to); v_word text; v_action text; v_org record; v_n int := 0; v_names text;
begin
  if v_from is null then return jsonb_build_object('action', 'ignored', 'reply', null); end if;
  v_word := upper(split_part(btrim(coalesce(p_body, '')), ' ', 1));
  v_word := regexp_replace(v_word, '[^A-Z]', '', 'g');
  v_action := case
    when v_word in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT') then 'opt_out'
    when v_word in ('START','UNSTOP','YES','SUBSCRIBE') then 'opt_in'
    when v_word in ('HELP','INFO') then 'help'
    else 'message' end;
  -- exactly one tenant: the one the number is verified for (unique); unknown numbers change nothing
  for v_org in
    select n.org_id, o.name from core.sms_sender_numbers n join core.organizations o on o.id = n.org_id
     where n.phone = v_to and n.status = 'verified'
     limit 1
  loop
    v_n := v_n + 1;
    v_names := coalesce(v_names || ', ', '') || v_org.name;
    if v_action = 'opt_out' then
      insert into core.sms_consents as c (org_id, phone, status, source, opted_out_at, last_keyword, recorded_by)
      values (v_org.org_id, v_from, 'opted_out', 'keyword', now(), v_word, 'sms:' || v_from)
      on conflict (org_id, phone) do update set status = 'opted_out', opted_out_at = now(), last_keyword = excluded.last_keyword, updated_at = now();
      insert into core.request_suppressions (org_id, channel, address, reason)
      values (v_org.org_id, 'sms', lower(v_from), 'stop')
      on conflict (org_id, channel, address) do update set reason = 'stop';
      update core.contacts ct set sms_consent = false, updated_at = now()
       where ct.org_id = v_org.org_id and core.notify_e164(ct.phone) = v_from and ct.sms_consent;
      update core.outbound_messages o set status = 'suppressed', status_reason = 'The recipient replied STOP', updated_at = now()
       where o.org_id = v_org.org_id and o.channel = 'sms' and o.to_address = v_from and o.status in ('queued','held');
    elsif v_action = 'opt_in' then
      insert into core.sms_consents as c (org_id, phone, status, source, consented_at, consent_text, last_keyword, recorded_by)
      values (v_org.org_id, v_from, 'opted_in', 'keyword', now(), 'Replied ' || v_word || ' to resubscribe', v_word, 'sms:' || v_from)
      on conflict (org_id, phone) do update set status = 'opted_in', consented_at = now(), opted_out_at = null, source = 'keyword',
        consent_text = excluded.consent_text, last_keyword = excluded.last_keyword, updated_at = now();
      delete from core.request_suppressions rs where rs.org_id = v_org.org_id and rs.channel = 'sms' and rs.address = lower(v_from) and rs.reason = 'stop';
    end if;
  end loop;
  if v_n = 0 then return jsonb_build_object('action', 'ignored', 'orgs', 0, 'reply', null); end if;
  return jsonb_build_object(
    'action', v_action,
    'orgs', v_n,
    'reply', case v_action
      when 'opt_out' then 'You are unsubscribed from ' || coalesce(v_names, 'these') || ' texts. No more messages will be sent. Reply START to resubscribe.'
      when 'opt_in' then 'You are subscribed to ' || coalesce(v_names, 'these') || ' texts again. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.'
      when 'help' then coalesce(v_names, 'This number') || ': job updates and appointment texts. Reply STOP to unsubscribe. Msg & data rates may apply.'
      else null end);
end $$;

-- ----------------------------------------------------------------------------
-- 11. Worker surface (service role only)
-- ----------------------------------------------------------------------------
-- Claim due queued rows (push rows carry the member's live Expo tokens). Re-checks SMS consent
-- and the STOP list at claim time; returns stale 'sending' rows (worker crashed) to the queue.
create or replace function core.notify_outbound_claim(p_limit integer default 50)
returns table (id uuid, org_id uuid, channel text, audience text, membership_id uuid, to_address text, subject text,
               body text, deep_link text, data jsonb, attempts integer, push_tokens text[], sms_from text)
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
#variable_conflict use_column
begin
  update core.outbound_messages o set status = case when o.attempts >= 5 then 'failed' else 'queued' end,
         last_error = coalesce(o.last_error, 'worker did not finish'), updated_at = now()
   where o.status = 'sending' and o.claimed_at < now() - interval '15 minutes';
  update core.outbound_messages o set status = 'suppressed', status_reason = 'No text-message consent / STOP', updated_at = now()
   where o.status = 'queued' and o.channel = 'sms' and not core.notify_sms_consented(o.org_id, o.to_address);
  return query
  with due as (
    select q.id from core.outbound_messages q
     where q.status = 'queued' and q.not_before <= now()
     order by q.not_before, q.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     for update skip locked
  ), claimed as (
    update core.outbound_messages o set status = 'sending', attempts = o.attempts + 1, claimed_at = now(), updated_at = now()
      from due where o.id = due.id
    returning o.*
  )
  select c.id, c.org_id, c.channel, c.audience, c.membership_id, c.to_address, c.subject, c.body, c.deep_link, c.data, c.attempts,
         case when c.channel = 'push' then
           coalesce((select array_agg(d.token order by d.last_seen_at desc) from core.push_devices d
                      where d.membership_id = c.membership_id and d.revoked_at is null), '{}'::text[]) end,
         case when c.channel = 'sms' then (core.notify_settings_row(c.org_id, c.location_id)).sms_from_number end
    from claimed c;
end $$;

-- Record a provider outcome. failed + p_retry → back to the queue with backoff (2^attempts minutes,
-- at most 5 attempts); sent stamps the notification (emailed_at so the digest never repeats it).
create or replace function core.notify_outbound_result(p_id uuid, p_status text, p_provider text, p_provider_message_id text,
                                                       p_error text, p_retry boolean default false) returns void
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare o record;
begin
  if p_status not in ('sent','failed','skipped') then raise exception 'PM_INVALID: bad outbound status %', p_status using errcode = '22023'; end if;
  select * into o from core.outbound_messages m where m.id = p_id;
  if o.id is null then return; end if;
  if p_status = 'failed' and p_retry and o.attempts < 5 then
    update core.outbound_messages m set status = 'queued', last_error = left(p_error, 500), provider = p_provider,
           not_before = now() + make_interval(mins => power(2, o.attempts)::int), updated_at = now()
     where m.id = p_id;
    return;
  end if;
  update core.outbound_messages m set status = p_status, provider = p_provider, provider_message_id = p_provider_message_id,
         last_error = case when p_status = 'sent' then null else left(p_error, 500) end,
         status_reason = case when p_status = 'skipped' then left(p_error, 300) else m.status_reason end,
         sent_at = case when p_status = 'sent' then now() end, updated_at = now()
   where m.id = p_id;
  if p_status = 'sent' and o.notification_id is not null and o.channel = 'email' then
    update core.notifications n set emailed_at = coalesce(n.emailed_at, now()) where n.id = o.notification_id;
  end if;
end $$;

create or replace function core.notify_revoke_push_token(p_token text, p_reason text) returns void
language sql volatile security definer
set search_path = core, public, pg_temp
as $$
  update core.push_devices set revoked_at = now(), revoke_reason = left(p_reason, 200) where token = p_token and revoked_at is null
$$;

-- Digests due now: 08:00 local (Mondays for weekly), not inside quiet hours, cadence from Books
-- prefs.digest (daily / weekly) else the persona default (owner weekly, everyone else daily).
-- Members whose Books prefs chose a digest in a tenant WITH Merit Books get Books' own digest job
-- (it reads the same core.notifications), so they are skipped here — one digest email, never two.
-- Each returned digest is CLAIMED (unique per member × cadence × period); notify_digest_done
-- stamps emailed_at on its items after the provider accepts it.
create or replace function core.notify_digest_collect(p_now timestamptz default now(), p_hour integer default 8)
returns table (digest_id uuid, org_id uuid, org_name text, membership_id uuid, email text, first_name text, cadence text, items jsonb)
language plpgsql volatile security definer
set search_path = core, pm, public, pg_temp
as $$
#variable_conflict use_column
declare
  m record; v_cadence text; v_tz text; v_local timestamp; v_key text; v_id uuid; v_items jsonb; v_ids uuid[]; v_all boolean;
begin
  for m in
    select ms.id, ms.org_id, o.name as org_name, u.email, u.first_name, pr.digest as pref_digest,
           coalesce((o.entitlements ->> 'books') = 'true', false) as has_books
      from core.memberships ms
      join core.organizations o on o.id = ms.org_id
      join core.users u on u.id = ms.user_id
      left join core.notification_prefs pr on pr.membership_id = ms.id
     where ms.status = 'active' and nullif(btrim(u.email), '') is not null
       and exists (select 1 from core.notifications n
                    where n.membership_id = ms.id and n.read_at is null and n.done_at is null and n.emailed_at is null
                      and n.created_at > p_now - interval '8 days'
                      and (n.delivery = 'digest' or pr.digest in ('daily','weekly')))
  loop
    continue when m.pref_digest = 'off';
    continue when m.has_books and m.pref_digest in ('daily','weekly');
    v_all := coalesce(m.pref_digest in ('daily','weekly'), false);
    v_cadence := case when v_all then m.pref_digest
                      when core.notify_member_persona(m.id, null) = 'projects_owner' then 'weekly' else 'daily' end;
    v_tz := core.notify_member_tz(m.id, null);
    begin
      v_local := p_now at time zone v_tz;
    exception when others then
      v_local := p_now at time zone 'UTC';
    end;
    continue when extract(hour from v_local)::int <> p_hour;
    continue when v_cadence = 'weekly' and extract(isodow from v_local)::int <> 1;
    continue when core.notify_next_allowed(m.id, null, p_now) > p_now;
    v_key := case when v_cadence = 'daily' then to_char(v_local, 'YYYY-MM-DD') else to_char(v_local, 'IYYY-"W"IW') end;

    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'body', x.body, 'deepLink', x.deep_link,
                                                 'severity', x.severity, 'eventType', coalesce(x.event_type, x.kind),
                                                 'jobId', x.job_id, 'jobLabel', x.meta ->> 'job_label', 'itemCount', x.item_count,
                                                 'createdAt', x.created_at) order by x.rank, x.created_at desc), '[]'::jsonb),
           coalesce(array_agg(x.id), '{}'::uuid[])
      into v_items, v_ids
      from (select n.*, case n.severity when 'critical' then 0 when 'attention' then 1 else 2 end as rank
              from core.notifications n
             where n.membership_id = m.id and n.read_at is null and n.done_at is null and n.emailed_at is null
               and n.created_at > p_now - interval '8 days'
               and (v_all or n.delivery = 'digest')
             order by rank, n.created_at desc
             limit 60) x;
    continue when jsonb_array_length(v_items) = 0;

    insert into core.notification_digests as d (org_id, membership_id, cadence, period_key, item_ids, item_count)
    values (m.org_id, m.id, v_cadence, v_key, v_ids, jsonb_array_length(v_items))
    on conflict (membership_id, cadence, period_key) do nothing
    returning d.id into v_id;
    continue when v_id is null;

    digest_id := v_id; org_id := m.org_id; org_name := m.org_name; membership_id := m.id; email := lower(btrim(m.email));
    first_name := m.first_name; cadence := v_cadence; items := v_items;
    return next;
  end loop;
end $$;

create or replace function core.notify_digest_done(p_digest uuid, p_ok boolean, p_provider_message_id text, p_error text) returns void
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare d record;
begin
  select * into d from core.notification_digests x where x.id = p_digest;
  if d.id is null then return; end if;
  if p_ok then
    update core.notification_digests x set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id where x.id = p_digest;
    update core.notifications n set emailed_at = coalesce(n.emailed_at, now()) where n.id = any (d.item_ids) and n.membership_id = d.membership_id;
  else
    -- the claim goes away so the next run may retry; the items roll into the next digest
    delete from core.notification_digests x where x.id = p_digest and x.status = 'claimed';
  end if;
end $$;

-- Sweeps the worker runs each pass: speed-to-lead breaches (open lead, no activity since it came in,
-- older than the company SLA). Notifies the lead owner and the company's sales managers once per lead.
create or replace function core.notify_sweep(p_now timestamptz default now()) returns integer
language plpgsql volatile security definer
set search_path = core, crm, public, pg_temp
as $$
declare l record; v_n int := 0; v_rcpt uuid[]; v_mgrs uuid[]; v_sla int; v_age int;
begin
  for l in
    select ld.id, ld.org_id, ld.location_id, ld.title, ld.owner_membership_id, ld.created_at
      from crm.leads ld
     where ld.won_at is null and ld.lost_at is null
       and ld.created_at > p_now - interval '7 days'
       and ld.created_at < p_now - interval '5 minutes'
       and not exists (select 1 from crm.activities a where a.lead_id = ld.id and a.occurred_at >= ld.created_at)
       and not exists (select 1 from core.notifications n where n.dedupe_key like 'lead.sla_breach:' || ld.id::text || '%')
  loop
    v_sla := (core.notify_settings_row(l.org_id, l.location_id)).lead_sla_minutes;
    continue when l.created_at > p_now - make_interval(mins => v_sla);
    v_age := (extract(epoch from (p_now - l.created_at)) / 60)::int;
    select coalesce(array_agg(ms.id), '{}'::uuid[]) into v_mgrs
      from core.memberships ms
     where ms.org_id = l.org_id and ms.status = 'active'
       and core.notify_member_persona(ms.id, l.location_id) in ('projects_owner','projects_gm','projects_office_manager')
       and core.membership_has_capability(ms.id, 'projects.leads', 'edit', l.location_id);
    v_rcpt := v_mgrs || case when l.owner_membership_id is not null then array[l.owner_membership_id] else '{}'::uuid[] end;
    v_n := v_n + core.notify_fanout(l.org_id, 'lead.sla_breach', l.location_id, null, 'lead', l.id, null, v_rcpt,
             'Lead waiting ' || case when v_age >= 120 then (v_age / 60)::text || ' h' else v_age::text || ' min' end || ': ' || left(l.title, 120),
             case when l.owner_membership_id is null then 'Nobody owns this lead yet. Assign it and call.' else 'No call, text or email logged yet.' end,
             null, null, '/leads/' || l.id, 'lead.sla_breach:' || l.id, '{}'::jsonb, null, 'attention');
  end loop;
  return v_n;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Recipes as triggers (never fail the business write)
-- ----------------------------------------------------------------------------
create or replace function core.tg_notify_job_member() returns trigger
language plpgsql security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_label text;
begin
  begin
    v_label := coalesce(core.notify_job_label(new.job_id), 'a job');
    perform core.notify_fanout(new.org_id, 'job.assigned', null, new.job_id, 'job', new.job_id, core.client_scope_caller_membership(),
      array[new.membership_id], 'You were added to ' || v_label, 'Role on the job: ' || replace(new.slot, '_', ' ') || '.',
      null, null, '/jobs/' || new.job_id, 'job.assigned:' || new.job_id || ':' || new.membership_id, jsonb_build_object('slot', new.slot));
  exception when others then
    raise warning 'notify job.assigned failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_job_member on pm.job_members;
create trigger trg_notify_job_member after insert on pm.job_members for each row execute function core.tg_notify_job_member();

create or replace function core.tg_notify_task() returns trigger
language plpgsql security definer
set search_path = core, pm, public, pg_temp
as $$
declare
  v_rcpt uuid[] := '{}'; v_label text; v_old_finish date; v_new_finish date; v_old_start date; v_new_start date; v_moved boolean;
  v_actor uuid;
begin
  -- cheap exit first: CPM rewrites many rows; only assigned, open tasks can notify anyone
  if new.assignee_user_id is null and new.assignee_employee_id is null then return null; end if;
  if new.status in ('DONE','CANCELLED') then return null; end if;
  if tg_op = 'UPDATE'
     and new.assignee_user_id is not distinct from old.assignee_user_id
     and new.assignee_employee_id is not distinct from old.assignee_employee_id
     and not (coalesce(new.early_finish, new.due_on) > coalesce(old.early_finish, old.due_on)
              or coalesce(new.early_start, new.start_on) > coalesce(old.early_start, old.start_on)) then
    return null;
  end if;
  begin
    v_actor := core.client_scope_caller_membership();
    v_label := coalesce(core.notify_job_label(new.job_id), 'a job');
    -- task.assigned: the person (or employee's seat) newly on the task
    if tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id
       or new.assignee_employee_id is distinct from old.assignee_employee_id then
      if new.assignee_user_id is not null and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id) then
        v_rcpt := v_rcpt || core.notify_membership_for_clerk(new.org_id, new.assignee_user_id);
      end if;
      if new.assignee_employee_id is not null and (tg_op = 'INSERT' or new.assignee_employee_id is distinct from old.assignee_employee_id) then
        v_rcpt := v_rcpt || core.notify_membership_for_employee(new.org_id, new.assignee_employee_id);
      end if;
      if cardinality(v_rcpt) > 0 and new.status not in ('DONE','CANCELLED') then
        perform core.notify_fanout(new.org_id, 'task.assigned', null, new.job_id, 'task', new.id, v_actor, v_rcpt,
          'New task: ' || left(new.title, 150),
          v_label || coalesce(' · due ' || to_char(new.due_on, 'Mon FMDD'), ''),
          null, null, '/jobs/' || new.job_id, 'task.assigned:' || new.id || ':' || coalesce(new.assignee_user_id, new.assignee_employee_id::text, ''),
          '{}'::jsonb);
      end if;
    end if;
    -- schedule.changed: an open, assigned task now starts or finishes later
    if tg_op = 'UPDATE' and new.status not in ('DONE','CANCELLED') then
      v_old_finish := coalesce(old.early_finish, old.due_on); v_new_finish := coalesce(new.early_finish, new.due_on);
      v_old_start := coalesce(old.early_start, old.start_on); v_new_start := coalesce(new.early_start, new.start_on);
      v_moved := (v_new_finish > v_old_finish) or (v_new_start > v_old_start);
      if v_moved then
        v_rcpt := '{}';
        if new.assignee_user_id is not null and new.assignee_user_id is not distinct from old.assignee_user_id then
          v_rcpt := v_rcpt || core.notify_membership_for_clerk(new.org_id, new.assignee_user_id);
        end if;
        if new.assignee_employee_id is not null and new.assignee_employee_id is not distinct from old.assignee_employee_id then
          v_rcpt := v_rcpt || core.notify_membership_for_employee(new.org_id, new.assignee_employee_id);
        end if;
        if cardinality(v_rcpt) > 0 then
          perform core.notify_fanout(new.org_id, 'schedule.changed', null, new.job_id, 'task', new.id, v_actor, v_rcpt,
            'Schedule changed on ' || v_label,
            left(new.title, 150) || ' now ' || coalesce(to_char(v_new_start, 'Mon FMDD'), '?') || '–' || coalesce(to_char(v_new_finish, 'Mon FMDD'), '?')
              || coalesce(' (was ' || to_char(v_old_finish, 'Mon FMDD') || ')', ''),
            null, null, '/jobs/' || new.job_id, 'schedule.changed:' || new.id || ':' || coalesce(v_new_start::text, '') || ':' || coalesce(v_new_finish::text, ''),
            '{}'::jsonb);
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'notify task failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_task on pm.tasks;
create trigger trg_notify_task after insert or update of assignee_user_id, assignee_employee_id, start_on, due_on, early_start, early_finish
  on pm.tasks for each row execute function core.tg_notify_task();

create or replace function core.tg_notify_punch() returns trigger
language plpgsql security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_m uuid;
begin
  begin
    if new.assignee_user_id is null or new.status in ('CLOSED','VOID') then return null; end if;
    if tg_op = 'UPDATE' and new.assignee_user_id is not distinct from old.assignee_user_id then return null; end if;
    v_m := core.notify_membership_for_clerk(new.org_id, new.assignee_user_id);
    if v_m is null then return null; end if;
    perform core.notify_fanout(new.org_id, 'punch.assigned', null, new.job_id, 'punch_item', new.id, core.client_scope_caller_membership(),
      array[v_m], initcap(lower(new.kind)) || ' item: ' || left(new.title, 150),
      coalesce(core.notify_job_label(new.job_id), '') || coalesce(' · ' || new.area, '') || coalesce(' · due ' || to_char(new.due_on, 'Mon FMDD'), ''),
      null, null, '/punch-list', 'punch.assigned:' || new.id || ':' || new.assignee_user_id, '{}'::jsonb);
  exception when others then
    raise warning 'notify punch.assigned failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_punch on pm.punch_items;
create trigger trg_notify_punch after insert or update of assignee_user_id on pm.punch_items for each row execute function core.tg_notify_punch();

create or replace function core.tg_notify_change_order() returns trigger
language plpgsql security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_loc uuid; v_rcpt uuid[]; v_label text; v_num text;
begin
  begin
    if new.stage <> 'APPROVED' or old.stage = 'APPROVED' then return null; end if;
    select j.location_id into v_loc from core.jobs j where j.id = new.job_id;
    v_label := coalesce(core.notify_job_label(new.job_id), 'a job');
    v_num := coalesce(new.number, 'Change order');
    select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_rcpt from (
      select jm.membership_id as x from pm.job_members jm where jm.job_id = new.job_id
      union select core.notify_membership_for_clerk(new.org_id, p.pm_user_id) from pm.projects p where p.job_id = new.job_id
      union select core.notify_membership_for_clerk(new.org_id, p.super_user_id) from pm.projects p where p.job_id = new.job_id
      union select unnest(core.notify_members_with(new.org_id, v_loc, 'projects.billing', 'approve'))
    ) s where x is not null;
    perform core.notify_fanout(new.org_id, 'change_order.signed', null, new.job_id, 'change_order', new.id, core.client_scope_caller_membership(),
      v_rcpt,
      v_num || ' signed on ' || v_label,
      left(new.title, 150) || '. Bill it and order any added material.',
      v_num || ' signed on ' || v_label || ' (' || case when new.amount_cents >= 0 then '+' else '' end || core.notify_money_text(new.amount_cents) || ')',
      null,
      '/change-orders', 'change_order.signed:' || new.id, '{}'::jsonb);
  exception when others then
    raise warning 'notify change_order.signed failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_change_order on pm.change_orders;
create trigger trg_notify_change_order after update of stage on pm.change_orders for each row execute function core.tg_notify_change_order();

create or replace function core.tg_notify_time_entry() returns trigger
language plpgsql security definer
set search_path = core, pm, public, pg_temp
as $$
declare v_loc uuid; v_rcpt uuid[]; v_who text; v_submitter uuid;
begin
  begin
    if new.approval_state <> 'SUBMITTED' or (tg_op = 'UPDATE' and old.approval_state = 'SUBMITTED') then return null; end if;
    select j.location_id into v_loc from core.jobs j where j.id = new.job_id;
    v_rcpt := core.notify_members_with(new.org_id, v_loc, 'projects.time', 'approve');
    select nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), '') into v_who from core.employees e where e.id = new.employee_id;
    v_submitter := coalesce(core.client_scope_caller_membership(),
                            case when new.employee_id is not null then core.notify_membership_for_employee(new.org_id, new.employee_id) end);
    perform core.notify_fanout(new.org_id, 'time.submitted', null, new.job_id, 'time_entry', new.id, v_submitter, v_rcpt,
      'Time to approve on ' || coalesce(core.notify_job_label(new.job_id), 'a job'),
      coalesce(v_who, 'A crew member') || ' · ' || trim(to_char(new.hours, 'FM990.0#')) || ' h on ' || to_char(new.work_date, 'Mon FMDD'),
      null, null, '/time', 'time.submitted:' || new.id, '{}'::jsonb);
  exception when others then
    raise warning 'notify time.submitted failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_time_entry on pm.time_entries;
create trigger trg_notify_time_entry after insert or update of approval_state on pm.time_entries for each row execute function core.tg_notify_time_entry();

create or replace function core.tg_notify_lead() returns trigger
language plpgsql security definer
set search_path = core, crm, public, pg_temp
as $$
declare v_company text;
begin
  begin
    if new.owner_membership_id is null or new.won_at is not null or new.lost_at is not null then return null; end if;
    if tg_op = 'UPDATE' and new.owner_membership_id is not distinct from old.owner_membership_id then return null; end if;
    select l.name into v_company from core.locations l where l.id = new.location_id;
    perform core.notify_fanout(new.org_id, 'lead.assigned', new.location_id, null, 'lead', new.id, core.client_scope_caller_membership(),
      array[new.owner_membership_id], 'New lead: ' || left(new.title, 150),
      concat_ws(' · ', v_company, nullif(new.source, '')) || '. Call within the hour.',
      null,
      case when new.estimated_value_cents is not null
           then concat_ws(' · ', v_company, nullif(new.source, ''), 'est. ' || core.notify_money_text(new.estimated_value_cents)) || '. Call within the hour.' end,
      '/leads/' || new.id, 'lead.assigned:' || new.id || ':' || new.owner_membership_id, '{}'::jsonb);
  exception when others then
    raise warning 'notify lead.assigned failed: %', sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_notify_lead on crm.leads;
create trigger trg_notify_lead after insert or update of owner_membership_id on crm.leads for each row execute function core.tg_notify_lead();

-- ----------------------------------------------------------------------------
-- 13. Member RPCs (pm schema; guarded through pm.access_rpc_guards or allowlisted)
-- ----------------------------------------------------------------------------
-- Display name of a seat (templated member-raised text).
create or replace function core.notify_member_name(p_m uuid) returns text
language sql stable security definer
set search_path = core, public, pg_temp
as $$
  select coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), split_part(u.email, '@', 1))
    from core.memberships ms join core.users u on u.id = ms.user_id where ms.id = p_m
$$;

-- May this seat act on the approval request's current step (1113's rule, for a recipient)?
-- Step capability / roles at the company, reaches the job, not a preparer — or an active delegate.
create or replace function core.notify_approval_eligible(p_req uuid, p_m uuid) returns boolean
language plpgsql stable security definer
set search_path = core, pm, public, pg_temp
as $$
declare r record; v_clerk text;
begin
  select q.org_id, q.location_id, q.job_id, q.object_type, q.amount_cents, q.preparers, st.approver_roles, st.approver_capability
    into r
    from pm.approval_requests q
    join pm.approval_request_steps st on st.request_id = q.id and st.step_order = q.current_step
   where q.id = p_req and q.status = 'PENDING';
  if r.org_id is null then return false; end if;
  select u.clerk_user_id into v_clerk from core.memberships ms join core.users u on u.id = ms.user_id
   where ms.id = p_m and ms.org_id = r.org_id and ms.status = 'active';
  if v_clerk is null or v_clerk = any (r.preparers) then return false; end if;
  if r.job_id is not null and not core.notify_member_reaches_job(p_m, r.job_id) then return false; end if;
  if (r.approver_capability is null
        or core.membership_has_capability(p_m, split_part(r.approver_capability, ':', 1), split_part(r.approver_capability, ':', 2), r.location_id))
     and (cardinality(r.approver_roles) = 0
        or exists (select 1 from pm._approval_member_grants(p_m) g where g.location_id = r.location_id and g.role_key = any (r.approver_roles))) then
    return true;
  end if;
  return exists (select 1 from pm.approval_delegations d
                  where d.org_id = r.org_id and d.delegate_membership_id = p_m and d.revoked_at is null
                    and d.starts_at <= now() and d.ends_at > now()
                    and (cardinality(d.object_types) = 0 or r.object_type = any (d.object_types))
                    and (d.max_amount_cents is null or r.amount_cents <= d.max_amount_cents));
end $$;

-- App-raised events. Security review L: the app never chooses the text of an approval
-- notification or makes anything mandatory —
--   approval.requested / approval.decided: subject = a real pm.approval_requests row the caller is
--     part of (submitter, preparer, decider or an actor on it); the text, link, amount and money
--     capability come from the request; requested → recipients are the current step's eligible
--     approvers (p_recipients narrows; empty = all of them); decided → the submitter / preparers.
--   comment.mention / document.sign_requested: templated titles ("Dana Lee mentioned you on J-1001"),
--     the caller's text only as a bounded quote / document name, no money, never mandatory, at most
--     20 recipients a call and 100 a member per hour.
create or replace function pm.notify_emit(
  p_event text, p_job uuid, p_location uuid, p_subject_type text, p_subject_id uuid, p_recipients uuid[],
  p_title text, p_body text default null, p_title_money text default null, p_body_money text default null,
  p_deep_link text default null, p_dedupe text default null, p_money_cap text default null)
returns integer
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid := public.get_org_id(); ev record; v_loc uuid := p_location; v_me uuid := core.client_scope_caller_membership();
  v_uid text := pm.current_user_id(); r record; v_step text; v_rcpt uuid[]; v_cap text; v_title text; v_body text; v_tm text;
  v_name text; v_label text; v_recent int; v_plan jsonb;
begin
  select * into ev from core.notification_event_types e where e.key = p_event;
  if ev.key is null or not ev.emit_rpc or ev.audience <> 'internal' then
    raise exception 'PM_INVALID: % cannot be sent from the app', p_event using errcode = '22023';
  end if;
  if coalesce(cardinality(p_recipients), 0) > 50 then raise exception 'PM_INVALID: at most 50 recipients' using errcode = '22023'; end if;

  if p_event in ('approval.requested', 'approval.decided') then
    if to_regclass('pm.approval_requests') is null then raise exception 'PM_INVALID: approvals are not installed' using errcode = '22023'; end if;
    -- subject: the request (approval_request, id) or the approved object (its type, id) — the
    -- latest request for it, as pm.approval_notify_plan (1113) hands it over
    if p_subject_id is null or p_subject_type is null then
      raise exception 'PM_INVALID: name the approval request (subject approval_request)' using errcode = '22023';
    end if;
    if p_subject_type = 'approval_request' then
      select q.* into r from pm.approval_requests q where q.id = p_subject_id and q.org_id = v_org;
    else
      select q.* into r from pm.approval_requests q
       where q.org_id = v_org and q.object_type = p_subject_type and q.object_id = p_subject_id
       order by (q.status = 'PENDING') = (p_event = 'approval.requested') desc, q.created_at desc
       limit 1;
    end if;
    if r.id is null then raise exception 'PM_INVALID: approval request not found' using errcode = '22023'; end if;
    if not coalesce(pm.access_is_service() or v_uid = r.submitted_by or v_uid = any (r.preparers) or v_uid = r.decided_by
                    or exists (select 1 from pm.approval_actions a where a.request_id = r.id and (a.actor_user = v_uid or a.actor_membership = v_me)), false)
       or (v_uid is null and not pm.access_is_service()) then
      raise exception 'PM_FORBIDDEN: only the people on this approval can notify about it' using errcode = '42501';
    end if;
    v_cap := case when r.money_cap in ('projects.contract_value', 'projects.financials') then r.money_cap
                  else coalesce(pm.approval_money_cap(r.object_type), 'projects.financials') end;
    if p_event = 'approval.requested' then
      if r.status <> 'PENDING' then raise exception 'PM_INVALID: this approval is no longer waiting' using errcode = '22023'; end if;
      select st.label into v_step from pm.approval_request_steps st where st.request_id = r.id and st.step_order = r.current_step;
      v_plan := case when to_regprocedure('pm.approval_notify_plan(uuid)') is not null then pm.approval_notify_plan(r.id) end;
      if v_plan ->> 'event' = 'approval.requested' then
        -- 1113's own approver set and wording (server-built); the app can only narrow the set
        select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_rcpt from jsonb_array_elements_text(v_plan -> 'recipients') x
         where coalesce(cardinality(p_recipients), 0) = 0 or x::uuid = any (p_recipients);
        v_title := left(v_plan ->> 'title', 200);
        v_body := left(v_plan ->> 'body', 1000);
      else
        select coalesce(array_agg(ms.id), '{}'::uuid[]) into v_rcpt
          from core.memberships ms
         where ms.org_id = v_org and ms.status = 'active'
           and (coalesce(cardinality(p_recipients), 0) = 0 or ms.id = any (p_recipients))
           and core.notify_approval_eligible(r.id, ms.id);
        v_title := left('Approval needed: ' || r.title, 200);
        v_body := left(concat_ws(' · ', v_step, nullif(btrim(coalesce(r.summary, '')), '')), 1000);
      end if;
      v_tm := case when r.amount_cents <> 0 then left(v_title || ' (' || core.notify_money_text(r.amount_cents) || ')', 200) end;
      return core.notify_fanout(v_org, p_event, r.location_id, r.job_id, 'approval_request', r.id, v_me, v_rcpt,
        v_title, v_body, v_tm, null, '/approvals?tab=mine',
        'approval.requested:' || r.id || ':' || r.round || ':' || r.current_step, '{}'::jsonb, v_cap, null, false);
    end if;
    if r.status not in ('APPROVED', 'REJECTED', 'CANCELLED') then raise exception 'PM_INVALID: this approval is not decided yet' using errcode = '22023'; end if;
    v_plan := case when to_regprocedure('pm.approval_notify_plan(uuid)') is not null then pm.approval_notify_plan(r.id) end;
    if v_plan ->> 'event' = 'approval.decided' then
      select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_rcpt from jsonb_array_elements_text(v_plan -> 'recipients') x;
      v_title := left(v_plan ->> 'title', 200);
      v_body := left(v_plan ->> 'body', 1000);
    else
      select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_rcpt
        from (select core.notify_membership_for_clerk(v_org, u) x from unnest(array_append(r.preparers, r.submitted_by)) u where u is not null) z
       where x is not null;
      v_title := left(case r.status when 'APPROVED' then 'Approved: ' when 'REJECTED' then 'Returned: ' else 'Cancelled: ' end || r.title, 200);
      v_body := case when r.status = 'REJECTED' then left(nullif(btrim(coalesce(r.reject_reason, '')), ''), 500) end;
    end if;
    v_tm := case when r.amount_cents <> 0 then left(v_title || ' (' || core.notify_money_text(r.amount_cents) || ')', 200) end;
    return core.notify_fanout(v_org, p_event, r.location_id, r.job_id, 'approval_request', r.id, v_me, v_rcpt,
      v_title, v_body, v_tm, null, coalesce(case when left(r.href, 1) = '/' and left(r.href, 2) <> '//' then r.href end, '/approvals?tab=decided'),
      'approval.decided:' || r.id || ':' || r.round || ':' || r.status, '{}'::jsonb, v_cap, null, false);
  end if;

  -- member-raised: mentions and signing requests
  if p_job is not null then
    select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  end if;
  if v_loc is null or not exists (select 1 from core.locations l where l.id = v_loc and l.org_id = v_org) then
    raise exception 'PM_INVALID: name a job or a company' using errcode = '22023';
  end if;
  v_rcpt := array(select distinct x from unnest(coalesce(p_recipients, '{}'::uuid[])) x where x is not null);
  if cardinality(v_rcpt) = 0 or cardinality(v_rcpt) > 20 then
    raise exception 'PM_INVALID: between 1 and 20 people' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_title, '')), '') is null then raise exception 'PM_INVALID: a title is required' using errcode = '22023'; end if;
  select count(*) into v_recent from core.notifications n
   where n.org_id = v_org and n.actor_membership_id = v_me and n.event_type in ('comment.mention', 'document.sign_requested')
     and n.created_at > now() - interval '1 hour';
  if v_recent >= 100 then
    raise exception 'PM_INVALID: you sent too many notifications in the last hour. Try again later' using errcode = '22023';
  end if;
  v_name := coalesce(core.notify_member_name(v_me), 'Someone');
  v_label := case when p_job is not null then core.notify_job_label(p_job) end;
  if p_event = 'comment.mention' then
    v_title := left(v_name || ' mentioned you' || coalesce(' on ' || v_label, ''), 200);
    v_body := '“' || left(regexp_replace(btrim(coalesce(p_body, p_title)), '\s+', ' ', 'g'), 280) || '”';
  else
    v_title := left(v_name || ' sent you a document to sign', 200);
    v_body := left(regexp_replace(btrim(p_title), '\s+', ' ', 'g'), 120) || coalesce(' · ' || v_label, '');
  end if;
  if p_dedupe is not null and length(p_dedupe) > 200 then raise exception 'PM_INVALID: dedupe key too long' using errcode = '22023'; end if;
  return core.notify_fanout(v_org, p_event, v_loc, p_job, p_subject_type, p_subject_id, v_me,
    v_rcpt, v_title, v_body, null, null, p_deep_link,
    case when p_dedupe is not null then p_event || ':' || p_dedupe end, '{}'::jsonb, null, null, true);
end $$;
comment on function pm.notify_emit(text, uuid, uuid, text, uuid, uuid[], text, text, text, text, text, text, text) is
  '1114: raise an app event. approval.* = server-built from a pm.approval_requests row the caller is on (recipients = eligible approvers / the submitter); comment.mention / document.sign_requested = templated, never mandatory, rate-limited. Recipients are filtered by the fan-out (reach the job, active internal seats, never the actor).';

create or replace function pm.notify_customer_message(
  p_event text, p_channel text, p_job uuid, p_location uuid, p_contact uuid, p_subject text, p_body text,
  p_deep_link text default null, p_dedupe text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid := p_location; v_cust uuid; v_ct_cust uuid; v_id uuid; o record;
begin
  if p_job is not null then
    select j.location_id, j.customer_id into v_loc, v_cust from core.jobs j where j.id = p_job and j.org_id = v_org;
  end if;
  if v_loc is null then raise exception 'PM_INVALID: name a job or a company' using errcode = '22023'; end if;
  select c.customer_id into v_ct_cust from core.contacts c where c.id = p_contact and c.org_id = v_org;
  if not found then raise exception 'PM_INVALID: contact not found' using errcode = '22023'; end if;
  if v_cust is not null and v_ct_cust is distinct from v_cust then
    raise exception 'PM_INVALID: that contact is not on this job''s customer' using errcode = '22023';
  end if;
  v_id := core.notify_customer(v_org, v_loc, p_job, p_event, p_channel, p_contact, p_subject, p_body, p_deep_link,
                               case when p_dedupe is not null then 'customer:' || p_event || ':' || left(p_dedupe, 150) end, pm.current_user_id());
  select m.id, m.status, m.status_reason, m.not_before into o from core.outbound_messages m where m.id = v_id;
  return jsonb_build_object('id', o.id, 'status', o.status, 'reason', o.status_reason, 'notBefore', o.not_before);
end $$;

create or replace function pm.notify_configure(p_location uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); s core.notification_settings; v_live boolean; k text;
begin
  if p_location is null or not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_INVALID: company not found' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then raise exception 'PM_INVALID: patch must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if k = 'sms_from_number' then
      raise exception 'PM_INVALID: the texting number is set by verifying it with the provider (pm.notify_request_sender)' using errcode = '22023';
    end if;
    if k not in ('customer_messages_live','sms_enabled','mandatory_events','push_per_hour','sms_per_day','email_per_hour',
                 'customer_sms_per_day','lead_sla_minutes','quiet_start','quiet_end','timezone') then
      raise exception 'PM_INVALID: unknown setting %', k using errcode = '22023';
    end if;
  end loop;
  if p_patch ? 'mandatory_events' and exists (
       select 1 from jsonb_array_elements_text(p_patch -> 'mandatory_events') x
        where not exists (select 1 from core.notification_event_types e where e.key = x and e.audience = 'internal')) then
    raise exception 'PM_INVALID: unknown event in mandatory_events' using errcode = '22023';
  end if;
  s := core.notify_settings_row(v_org, p_location);
  insert into core.notification_settings as t (org_id, location_id, customer_messages_live, live_at, live_by, sms_enabled, sms_from_number,
       mandatory_events, push_per_hour, sms_per_day, email_per_hour, customer_sms_per_day, lead_sla_minutes, quiet_start, quiet_end, timezone, updated_by)
  values (v_org, p_location, false, null, null, s.sms_enabled, s.sms_from_number, s.mandatory_events, s.push_per_hour, s.sms_per_day,
          s.email_per_hour, s.customer_sms_per_day, s.lead_sla_minutes, s.quiet_start, s.quiet_end, s.timezone, pm.current_user_id())
  on conflict (org_id, location_id) where location_id is not null do nothing;

  v_live := case when p_patch ? 'customer_messages_live' then (p_patch ->> 'customer_messages_live')::boolean end;
  update core.notification_settings t set
    customer_messages_live = coalesce(v_live, t.customer_messages_live),
    live_at = case when v_live is true and not t.customer_messages_live then now() when v_live is false then null else t.live_at end,
    live_by = case when v_live is true and not t.customer_messages_live then pm.current_user_id() when v_live is false then null else t.live_by end,
    sms_enabled = coalesce((p_patch ->> 'sms_enabled')::boolean, t.sms_enabled),
    mandatory_events = case when p_patch ? 'mandatory_events' then array(select jsonb_array_elements_text(p_patch -> 'mandatory_events')) else t.mandatory_events end,
    push_per_hour = coalesce((p_patch ->> 'push_per_hour')::int, t.push_per_hour),
    sms_per_day = coalesce((p_patch ->> 'sms_per_day')::int, t.sms_per_day),
    email_per_hour = coalesce((p_patch ->> 'email_per_hour')::int, t.email_per_hour),
    customer_sms_per_day = coalesce((p_patch ->> 'customer_sms_per_day')::int, t.customer_sms_per_day),
    lead_sla_minutes = coalesce((p_patch ->> 'lead_sla_minutes')::int, t.lead_sla_minutes),
    quiet_start = case when p_patch ? 'quiet_start' then (p_patch ->> 'quiet_start')::time else t.quiet_start end,
    quiet_end = case when p_patch ? 'quiet_end' then (p_patch ->> 'quiet_end')::time else t.quiet_end end,
    timezone = case when p_patch ? 'timezone' then nullif(p_patch ->> 'timezone', '') else t.timezone end,
    updated_by = pm.current_user_id(), updated_at = now()
   where t.org_id = v_org and t.location_id = p_location
  returning t.* into s;
  return to_jsonb(s) - 'id';
end $$;

create or replace function pm.notify_record_sms_consent(p_location uuid, p_phone text, p_contact uuid, p_status text, p_source text, p_consent_text text)
returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_phone text := core.notify_e164(p_phone); v_id uuid;
begin
  if v_phone is null then raise exception 'PM_INVALID: enter a mobile number' using errcode = '22023'; end if;
  if p_status not in ('opted_in','opted_out') then raise exception 'PM_INVALID: bad consent status' using errcode = '22023'; end if;
  if p_status = 'opted_in' and (p_consent_text is null or length(btrim(p_consent_text)) < 10) then
    raise exception 'PM_INVALID: record the consent wording the customer agreed to' using errcode = '22023';
  end if;
  if p_contact is not null and not exists (select 1 from core.contacts c where c.id = p_contact and c.org_id = v_org) then
    raise exception 'PM_INVALID: contact not found' using errcode = '22023';
  end if;
  insert into core.sms_consents as c (org_id, location_id, phone, contact_id, status, source, consent_text, consented_at, opted_out_at, recorded_by)
  values (v_org, p_location, v_phone, p_contact, p_status, p_source, left(p_consent_text, 1000),
          case when p_status = 'opted_in' then now() end, case when p_status = 'opted_out' then now() end, pm.current_user_id())
  on conflict (org_id, phone) do update set
    status = excluded.status, source = excluded.source, consent_text = coalesce(excluded.consent_text, c.consent_text),
    consented_at = case when excluded.status = 'opted_in' then now() else c.consented_at end,
    opted_out_at = case when excluded.status = 'opted_out' then now() else null end,
    contact_id = coalesce(excluded.contact_id, c.contact_id), location_id = coalesce(excluded.location_id, c.location_id),
    recorded_by = excluded.recorded_by, updated_at = now()
  returning c.id into v_id;
  if p_status = 'opted_out' then
    insert into core.request_suppressions (org_id, channel, address, reason) values (v_org, 'sms', lower(v_phone), 'manual')
    on conflict (org_id, channel, address) do nothing;
  else
    -- a STOP stays until the customer texts START (carrier rule); a manual opt-out may be lifted
    delete from core.request_suppressions rs where rs.org_id = v_org and rs.channel = 'sms' and rs.address = lower(v_phone) and rs.reason = 'manual';
  end if;
  if p_contact is not null then
    update core.contacts c set sms_consent = (p_status = 'opted_in'), consent_at = now(), updated_at = now() where c.id = p_contact;
  end if;
  return v_id;
end $$;

create or replace function pm.notify_set_recipe(p_persona text, p_event text, p_in_app text, p_push text, p_email text, p_sms text)
returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id();
begin
  if not exists (select 1 from core.notification_event_types e where e.key = p_event and e.audience = 'internal') then
    raise exception 'PM_INVALID: unknown event %', p_event using errcode = '22023';
  end if;
  insert into core.notification_recipes as r (org_id, persona_key, event_type, in_app, push, email, sms, updated_by)
  values (v_org, p_persona, p_event, p_in_app, p_push, p_email, p_sms, pm.current_user_id())
  on conflict (org_id, persona_key, event_type) where org_id is not null
  do update set in_app = excluded.in_app, push = excluded.push, email = excluded.email, sms = excluded.sms,
                updated_by = excluded.updated_by, updated_at = now();
end $$;

-- Own rows only: read / unread / done / undone / read_all / done_all.
create or replace function pm.notify_mark(p_ids uuid[], p_state text) returns integer
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_m uuid := core.notify_caller_membership(); v_n int;
begin
  if v_m is null then raise exception 'PM_FORBIDDEN: no active seat in this organization' using errcode = '42501'; end if;
  if p_state not in ('read','unread','done','undone','read_all','done_all') then raise exception 'PM_INVALID: bad state %', p_state using errcode = '22023'; end if;
  if p_state not in ('read_all','done_all') and coalesce(cardinality(p_ids), 0) = 0 then return 0; end if;
  if coalesce(cardinality(p_ids), 0) > 500 then raise exception 'PM_INVALID: at most 500 at a time' using errcode = '22023'; end if;
  update core.notifications n set
    read_at = case when p_state in ('read','read_all','done','done_all') then coalesce(n.read_at, now()) when p_state = 'unread' then null else n.read_at end,
    done_at = case when p_state in ('done','done_all') then coalesce(n.done_at, now()) when p_state = 'undone' then null else n.done_at end,
    updated_at = now()
   where n.membership_id = v_m and n.org_id = public.get_org_id()
     and (p_state in ('read_all','done_all') or n.id = any (p_ids))
     and (p_state <> 'read_all' or n.read_at is null)
     and (p_state <> 'done_all' or n.done_at is null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Own prefs: Books prefs columns (digest, quiet hours, time zone, SMS number) + the event × channel matrix.
-- p_rules: [{event_type, channel, mode}] — mode null removes the override (back to the role default).
create or replace function pm.notify_save_prefs(p_rules jsonb, p_digest text, p_quiet_start time, p_quiet_end time, p_timezone text,
                                                p_sms_phone text, p_sms_consent boolean default false) returns void
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_m uuid := core.notify_caller_membership(); v_org uuid := public.get_org_id(); r jsonb; v_phone text;
begin
  if v_m is null then raise exception 'PM_FORBIDDEN: no active seat in this organization' using errcode = '42501'; end if;
  if p_digest is not null and p_digest not in ('instant','daily','weekly','off') then raise exception 'PM_INVALID: bad digest' using errcode = '22023'; end if;
  if (p_quiet_start is null) <> (p_quiet_end is null) then raise exception 'PM_INVALID: quiet hours need a start and an end' using errcode = '22023'; end if;
  if p_timezone is not null and p_timezone !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' then raise exception 'PM_INVALID: bad time zone' using errcode = '22023'; end if;
  v_phone := case when nullif(btrim(coalesce(p_sms_phone, '')), '') is null then null else core.notify_e164(p_sms_phone) end;
  if p_sms_phone is not null and nullif(btrim(p_sms_phone), '') is not null and v_phone is null then
    raise exception 'PM_INVALID: enter a mobile number' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_rules, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rules, '[]'::jsonb)) > 200 then
    raise exception 'PM_INVALID: rules must be a list' using errcode = '22023';
  end if;

  insert into core.notification_prefs as p (org_id, membership_id, digest, quiet_start, quiet_end, timezone, sms_phone)
  values (v_org, v_m, coalesce(p_digest, 'instant'), p_quiet_start, p_quiet_end, p_timezone, v_phone)
  on conflict (membership_id) do update set
    digest = coalesce(p_digest, p.digest), quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
    timezone = excluded.timezone, sms_phone = excluded.sms_phone, updated_at = now();

  if v_phone is not null and p_sms_consent then
    insert into core.sms_consents as c (org_id, phone, membership_id, status, source, consent_text, consented_at, recorded_by)
    values (v_org, v_phone, v_m, 'opted_in', 'app_settings', 'Turned on work texts in notification settings', now(), pm.current_user_id())
    on conflict (org_id, phone) do update set
      status = case when exists (select 1 from core.request_suppressions rs where rs.org_id = v_org and rs.channel = 'sms'
                                  and rs.address = lower(v_phone) and rs.reason = 'stop') then c.status else 'opted_in' end,
      membership_id = v_m, consented_at = now(), updated_at = now();
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    if not exists (select 1 from core.notification_event_types e where e.key = r ->> 'event_type' and e.audience = 'internal') then
      raise exception 'PM_INVALID: unknown event %', r ->> 'event_type' using errcode = '22023';
    end if;
    if (r ->> 'mode') is null then
      delete from core.notification_pref_rules x where x.membership_id = v_m and x.event_type = r ->> 'event_type' and x.channel = r ->> 'channel';
    else
      insert into core.notification_pref_rules as x (org_id, membership_id, event_type, channel, mode)
      values (v_org, v_m, r ->> 'event_type', r ->> 'channel', r ->> 'mode')
      on conflict (membership_id, event_type, channel) do update set mode = excluded.mode, updated_at = now();
    end if;
  end loop;
end $$;

create or replace function pm.notify_register_device(p_token text, p_platform text, p_device_name text, p_app_version text) returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_m uuid := core.notify_caller_membership(); v_id uuid;
begin
  if v_m is null then raise exception 'PM_FORBIDDEN: no active seat in this organization' using errcode = '42501'; end if;
  if (select count(*) from core.push_devices d where d.membership_id = v_m and d.revoked_at is null and d.token <> coalesce(p_token, '')) >= 10 then
    -- keep the 10 most recent phones; the oldest is retired
    update core.push_devices d set revoked_at = now(), revoke_reason = 'replaced by a newer device'
     where d.id = (select x.id from core.push_devices x where x.membership_id = v_m and x.revoked_at is null order by x.last_seen_at limit 1);
  end if;
  insert into core.push_devices as d (org_id, membership_id, token, platform, device_name, app_version)
  values (public.get_org_id(), v_m, p_token, p_platform, left(p_device_name, 120), left(p_app_version, 40))
  on conflict (token) do update set org_id = excluded.org_id, membership_id = excluded.membership_id, platform = excluded.platform,
    device_name = excluded.device_name, app_version = excluded.app_version, last_seen_at = now(), revoked_at = null, revoke_reason = null
  returning d.id into v_id;
  return v_id;
end $$;

create or replace function pm.notify_unregister_device(p_token text) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_m uuid := core.notify_caller_membership(); v_n int;
begin
  if v_m is null then raise exception 'PM_FORBIDDEN: no active seat in this organization' using errcode = '42501'; end if;
  update core.push_devices d set revoked_at = now(), revoke_reason = 'signed out' where d.token = p_token and d.membership_id = v_m and d.revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- Held customer messages: release (company must be live; consent re-checked) or discard. Each row
-- needs projects.settings:configure at its company.
create or replace function pm.notify_held_action(p_ids uuid[], p_action text) returns integer
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare o record; v_n int := 0; s core.notification_settings;
begin
  if p_action not in ('release','discard') then raise exception 'PM_INVALID: release or discard' using errcode = '22023'; end if;
  if coalesce(cardinality(p_ids), 0) > 200 then raise exception 'PM_INVALID: at most 200 at a time' using errcode = '22023'; end if;
  for o in select m.* from core.outbound_messages m where m.id = any (coalesce(p_ids, '{}'::uuid[])) and m.org_id = public.get_org_id() and m.status = 'held' loop
    if not pm.can('projects.settings', 'configure', o.location_id) then
      raise exception 'PM_FORBIDDEN: requires projects.settings:configure at this company' using errcode = '42501';
    end if;
    if p_action = 'discard' then
      update core.outbound_messages m set status = 'cancelled', status_reason = 'Discarded by ' || coalesce(pm.current_user_id(), 'staff'), updated_at = now() where m.id = o.id;
      v_n := v_n + 1;
      continue;
    end if;
    s := core.notify_settings_row(o.org_id, o.location_id);
    if not s.customer_messages_live then
      raise exception 'PM_INVALID: this company is not live for customer messages yet' using errcode = '22023';
    end if;
    if o.channel = 'sms' and not s.sms_enabled then
      raise exception 'PM_INVALID: texting is not set up for this company yet' using errcode = '22023';
    end if;
    update core.outbound_messages m set status = 'queued', status_reason = null, not_before = greatest(m.not_before, now()), updated_at = now() where m.id = o.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Texting number: a settings holder ASKS for one (pending); only the service role marks it verified,
-- after the provider confirmed it belongs to this tenant (apps/projects lib/notify/worker.ts
-- verifySender). A number verified for another tenant cannot be asked for.
create or replace function pm.notify_request_sender(p_location uuid, p_phone text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_phone text := core.notify_e164(p_phone); n record;
begin
  if v_phone is null then raise exception 'PM_INVALID: enter the texting number in +1 format' using errcode = '22023'; end if;
  select x.* into n from core.sms_sender_numbers x where x.phone = v_phone and x.status = 'verified';
  if n.id is not null and n.org_id <> v_org then
    raise exception 'PM_INVALID: that number is registered to another workspace' using errcode = '22023';
  end if;
  if n.id is not null then
    return jsonb_build_object('id', n.id, 'phone', n.phone, 'status', n.status);
  end if;
  insert into core.sms_sender_numbers as x (org_id, location_id, phone, requested_by)
  values (v_org, p_location, v_phone, pm.current_user_id())
  on conflict (org_id, phone) where status = 'pending' do update set location_id = excluded.location_id, requested_at = now(), requested_by = excluded.requested_by
  returning x.* into n;
  return jsonb_build_object('id', n.id, 'phone', n.phone, 'status', n.status);
end $$;

-- Service only: the provider confirmed (p_ok) or refused the pending number. Verified → the
-- company's settings use it (texting stays off until a settings holder turns it on).
create or replace function core.notify_verify_sender(p_id uuid, p_ok boolean, p_provider_sid text, p_note text) returns jsonb
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare n record;
begin
  select x.* into n from core.sms_sender_numbers x where x.id = p_id;
  if n.id is null or n.status <> 'pending' then raise exception 'PM_INVALID: no pending texting number %', p_id using errcode = '22023'; end if;
  if not p_ok then
    update core.sms_sender_numbers x set status = 'revoked', revoked_at = now(), note = left(p_note, 300) where x.id = p_id;
    return jsonb_build_object('id', p_id, 'status', 'revoked');
  end if;
  if exists (select 1 from core.sms_sender_numbers x where x.phone = n.phone and x.status = 'verified' and x.org_id <> n.org_id) then
    update core.sms_sender_numbers x set status = 'revoked', revoked_at = now(), note = 'registered to another workspace' where x.id = p_id;
    raise exception 'PM_INVALID: that number is registered to another workspace' using errcode = '22023';
  end if;
  update core.sms_sender_numbers x set status = 'verified', verified_at = now(), provider_sid = p_provider_sid, note = left(p_note, 300) where x.id = p_id;
  if n.location_id is null then
    insert into core.notification_settings as t (org_id, location_id, sms_from_number) values (n.org_id, null, n.phone)
    on conflict (org_id) where location_id is null do update set sms_from_number = excluded.sms_from_number, updated_at = now();
  else
    insert into core.notification_settings as t (org_id, location_id, sms_from_number) values (n.org_id, n.location_id, n.phone)
    on conflict (org_id, location_id) where location_id is not null do update set sms_from_number = excluded.sms_from_number, updated_at = now();
  end if;
  return jsonb_build_object('id', p_id, 'status', 'verified', 'phone', n.phone);
end $$;

-- Service only: the number left the tenant (released at the provider). Texting stops there.
create or replace function core.notify_revoke_sender(p_phone text, p_note text) returns integer
language plpgsql volatile security definer
set search_path = core, public, pg_temp
as $$
declare v_n int;
begin
  update core.notification_settings t set sms_enabled = false, sms_from_number = null, updated_at = now() where t.sms_from_number = p_phone;
  update core.sms_sender_numbers x set status = 'revoked', revoked_at = now(), note = left(p_note, 300) where x.phone = p_phone and x.status in ('pending','verified');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Outbound log for settings holders (security review note): delivery metadata for every row of
-- their companies; the message text only for customer messages and only with
-- projects.contract_value there (customer text can quote prices); internal message text never
-- (each person reads their own in the inbox). Members have no column access to the text itself.
create or replace function pm.notify_outbound_messages(p_status text default 'held', p_limit integer default 200)
returns table (id uuid, location_id uuid, channel text, audience text, event_type text, to_address text, subject text, body text,
               body_masked boolean, status text, status_reason text, job_id uuid, created_at timestamptz, sent_at timestamptz)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
begin
  return query
  select o.id, o.location_id, o.channel, o.audience, o.event_type,
         case when o.audience = 'customer' then o.to_address end,
         case when o.audience = 'customer' and pm.can('projects.contract_value', 'view', o.location_id) then o.subject end,
         case when o.audience = 'customer' and pm.can('projects.contract_value', 'view', o.location_id) then o.body end,
         not (o.audience = 'customer' and pm.can('projects.contract_value', 'view', o.location_id)),
         o.status, o.status_reason, o.job_id, o.created_at, o.sent_at
    from core.outbound_messages o
   where o.org_id = public.get_org_id()
     and o.location_id is not null and pm.can('projects.settings', 'configure', o.location_id)
     and (p_status is null or o.status = p_status)
   order by o.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
end $$;

-- ----------------------------------------------------------------------------
-- 14. RLS, grants, seat policies, client scope, registries
-- ----------------------------------------------------------------------------
do $$
declare t text; p record;
begin
  foreach t in array array['notification_event_types','notification_recipes','notification_pref_rules','notification_settings',
                           'push_devices','sms_consents','outbound_messages','notification_digests','sms_sender_numbers'] loop
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'core' and tablename = t
              and policyname not in ('client_scope_rls','projects_only_seat_deny') loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table core.%I from public, anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

create policy member_read on core.notification_event_types for select to authenticated using (true);
create policy member_read on core.notification_recipes for select to authenticated
  using (org_id is null or org_id = public.get_org_id());
create policy member_read on core.notification_pref_rules for select to authenticated
  using (org_id = public.get_org_id() and membership_id = core.notify_caller_membership());
create policy member_read on core.notification_settings for select to authenticated
  using (org_id = public.get_org_id());
create policy member_read on core.push_devices for select to authenticated
  using (org_id = public.get_org_id() and membership_id = core.notify_caller_membership());
create policy member_read on core.notification_digests for select to authenticated
  using (org_id = public.get_org_id() and membership_id = core.notify_caller_membership());
create policy member_read on core.outbound_messages for select to authenticated
  using (org_id = public.get_org_id()
         and (membership_id = core.notify_caller_membership()
              or (location_id is not null and (select pm.can('projects.settings', 'configure', location_id)))));
create policy member_read on core.sms_consents for select to authenticated
  using (org_id = public.get_org_id()
         and (membership_id = core.notify_caller_membership()
              or (select pm.can('projects.customers', 'view', location_id))
              or (location_id is null and (select pm.can('projects.customers', 'view')))));
create policy member_read on core.sms_sender_numbers for select to authenticated
  using (org_id = public.get_org_id() and (location_id is null or (select pm.can('projects.settings', 'configure', location_id))
                                           or (select pm.can('projects.settings', 'configure'))));
-- outbound text is read through pm.notify_outbound_messages (masked); members get delivery metadata only
revoke select on core.outbound_messages from authenticated;
grant select (id, org_id, location_id, channel, audience, event_type, notification_id, membership_id, job_id, status, status_reason,
              not_before, attempts, provider, created_at, claimed_at, sent_at, updated_at) on core.outbound_messages to authenticated;
-- push tokens are a credential to the phone: never column-readable by members
revoke select on core.push_devices from authenticated;
grant select (id, org_id, membership_id, platform, app, device_name, app_version, created_at, last_seen_at, revoked_at) on core.push_devices to authenticated;

-- Projects-only seats: their own inbox / prefs (1110 had denied every Books table), the new tables exempt.
insert into pm.access_seat_exceptions as e (schema_name, table_name, kind, narrow_pred, reason) values
  ('core', 'notifications',            'narrowed', '(membership_id = (select core.notify_caller_membership()))', '1114: own inbox (suite notification service)'),
  ('core', 'notification_prefs',       'narrowed', '(membership_id = (select core.notify_caller_membership()))', '1114: own notification preferences'),
  ('core', 'notification_event_types', 'exempt', null, '1114: event catalog'),
  ('core', 'notification_recipes',     'exempt', null, '1114: role defaults (own org + platform)'),
  ('core', 'notification_pref_rules',  'exempt', null, '1114: own rows only (member_read)'),
  ('core', 'notification_settings',    'exempt', null, '1114: company notification settings (no Books data)'),
  ('core', 'push_devices',             'exempt', null, '1114: own devices only (member_read; token column revoked)'),
  ('core', 'sms_consents',             'exempt', null, '1114: own number, or projects.customers:view at the company'),
  ('core', 'outbound_messages',        'exempt', null, '1114: own, or projects.settings:configure at the company'),
  ('core', 'notification_digests',     'exempt', null, '1114: own rows only'),
  ('core', 'sms_sender_numbers',       'exempt', null, '1114: the org''s texting numbers (settings holders)')
on conflict (schema_name, table_name) do update set kind = excluded.kind, narrow_pred = excluded.narrow_pred, reason = excluded.reason;

select pm.access_apply_seat_policies();

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- 1110 guard registry: guarded member RPCs; allowlisted own-row RPCs.
insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('notify_emit',               '{p_event,p_job,p_location}', 'if p_event like ''approval.%'' then null; elsif p_job is not null then perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job); elsif not exists (select 1 from pm.my_member_location_ids() x where x = p_location) then perform pm.access_forbid(''requires a Projects role at this company''); end if;', '1114'),
  ('notify_customer_message',   '{p_job,p_location}', 'if p_job is not null then perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job); else perform pm.access_assert_location(''projects.customers'', array[''edit''], p_location); end if;', '1114: customer messages from a job need jobs:edit; from a company, customers:edit'),
  ('notify_configure',          '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1114: go-live, texting, caps, mandatory events'),
  ('notify_record_sms_consent', '{p_location}', 'perform pm.access_assert_location(''projects.customers'', array[''edit''], p_location);', '1114'),
  ('notify_request_sender',     '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1114: asks for a texting number (verified by the service role only)'),
  ('notify_outbound_messages',  '{}',           'if not pm.can(''projects.settings'', ''configure'') then perform pm.access_forbid(''requires projects.settings:configure''); end if;', '1114: outbound log; rows limited to companies the caller configures, text masked'),
  ('notify_set_recipe',         '{}',           'if not pm.schedule_org_settings_ok() then perform pm.access_forbid(''requires projects.settings:configure at every company''); end if;', '1114: org-wide role defaults')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('notify_mark',              '1114: the caller''s own notifications only'),
  ('notify_save_prefs',        '1114: the caller''s own preferences only'),
  ('notify_register_device',   '1114: registers a push token to the caller''s own seat'),
  ('notify_unregister_device', '1114: the caller''s own devices only'),
  ('notify_held_action',       '1114: checks projects.settings:configure at each message''s company itself')
on conflict (function_name) do update set reason = excluded.reason;

select pm.access_apply_rpc_guards();

-- 1111 registry (core functions): every 1114 core function is service-only — listed for the record.
insert into crm.access_rpc_registry as r (schema_name, function_name, kind, reason) values
  ('core', 'notify_fanout',            'helper', '1114: service / trigger / guarded-RPC only; filters recipients and masks money itself'),
  ('core', 'notify_customer',          'helper', '1114: service / guarded-RPC only; holds until go-live, checks consent and the STOP list'),
  ('core', 'notify_inbound_sms',       'helper', '1114: service only (signature-verified Twilio webhook)'),
  ('core', 'notify_outbound_claim',    'helper', '1114: service only (worker)'),
  ('core', 'notify_outbound_result',   'helper', '1114: service only (worker)'),
  ('core', 'notify_digest_collect',    'helper', '1114: service only (worker)'),
  ('core', 'notify_digest_done',       'helper', '1114: service only (worker)'),
  ('core', 'notify_sweep',             'helper', '1114: service only (worker)'),
  ('core', 'notify_revoke_push_token', 'helper', '1114: service only (worker)'),
  ('core', 'notify_verify_sender',     'helper', '1114: service only (after the provider confirms the number)'),
  ('core', 'notify_revoke_sender',     'helper', '1114: service only'),
  ('core', 'notify_approval_eligible', 'helper', '1114: service / pm.notify_emit only')
on conflict (schema_name, function_name) do update set kind = excluded.kind, reason = excluded.reason;

-- Function grants: nothing for PUBLIC / anon; core engine service-only; pm RPCs for members.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'core' and (p.proname like 'notify\_%' or p.proname like 'tg\_notify\_%') and p.proname <> 'notify_caller_membership')
               or (n.nspname = 'pm' and p.proname like 'notify\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.nspname = 'pm' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1114_notifications
-- ============================================================================
