-- =============================================================================
-- Migration 178: the request & chase engine + in-app notifications (Wave 1D)
-- =============================================================================
-- FPB: docs/FPB-request-engine-notifications.md (IA M-7, M-13; audit PL-01, PL-02).
--
-- ONE engine for every follow-up the product makes: receipt chase, vendor W-9 / COI
-- chase, client questions, document asks, approval nudges and dunning.
--
-- §1  core.requests              one ask: kind, subject, recipient, channels, cadence,
--                                quiet hours, escalation, status, due date
-- §2  core.request_events        append-only timeline; dispatch_key UNIQUE makes a send
--                                idempotent per (request, step, channel)
-- §3  core.request_tokens        hashed (sha256) magic links — the clear token is only
--                                ever in the email
-- §4  core.request_policies      tenant cadence defaults per policy key (receipt is NOT
--                                stored here: it reads organizations.chase_*)
-- §5  core.request_suppressions  unsubscribe / STOP / hard-bounce list per address
-- §6  core.notifications         in-app notifications per membership
-- §7  core.notification_prefs    per-membership channels, digest, quiet hours
-- §8  RLS + grants               members SELECT their org (notifications / prefs: their
--                                OWN rows; request_tokens: nobody but the service role);
--                                every write is the service role (the app, after its
--                                permission check, org pinned — the 171 pattern)
-- §9  client-scope RLS re-applied (163) — every table above carries location_id so the
--     restrictive client-scope policy covers it.
-- §10 core.outbound_send_counters + core.bump_send_quota — per-user / per-org outbound
--     email quotas for free-text recipients (security review). Service role only.
--
-- M1 lesson: every new function is EXECUTE-revoked from public/anon, then granted
-- explicitly. Idempotent. PGlite-compatible (no subqueries in CHECK). No GL effect.
-- Apply to Supabase FIRST, then commit the code that uses it.
-- =============================================================================

-- ── §1 requests ───────────────────────────────────────────────────────────────
create table if not exists core.requests (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null references core.organizations(id) on delete cascade,
  location_id                uuid references core.locations(id) on delete cascade,
  kind                       text not null,
  subject_type               text not null default 'none',
  subject_id                 uuid,
  dedupe_key                 text,
  title                      text not null,
  message                    text,
  deep_link                  text,
  recipient_type             text not null,
  recipient_membership_id    uuid references core.memberships(id) on delete set null,
  recipient_vendor_id        uuid,
  recipient_customer_id      uuid,
  recipient_employee_id      uuid,
  recipient_name             text,
  recipient_email            text,
  recipient_phone            text,
  recipient_timezone         text,
  channels                   text[] not null default array['email','in_app']::text[],
  cadence_anchor             text not null default 'created',
  cadence_offsets_minutes    integer[] not null default array[0]::integer[],
  repeat_every_minutes       integer,
  max_sends                  integer not null default 6,
  cadence_slot               integer not null default 1,
  quiet_start                time,
  quiet_end                  time,
  escalate_after             integer,
  escalate_to_membership_id  uuid references core.memberships(id) on delete set null,
  owner_membership_id        uuid references core.memberships(id) on delete set null,
  escalated_at               timestamptz,
  status                     text not null default 'open',
  due_date                   date,
  next_send_at               timestamptz,
  snoozed_until              timestamptz,
  sends_count                integer not null default 0,
  last_sent_at               timestamptz,
  bounced_at                 timestamptz,
  unsubscribed_at            timestamptz,
  fulfilled_at               timestamptz,
  fulfilled_by               text,
  fulfilled_via              text,
  fulfilled_note             text,
  cancelled_at               timestamptz,
  cancelled_by               text,
  cancel_reason              text,
  source                     text not null default 'manual',
  meta                       jsonb not null default '{}'::jsonb,
  created_by                 text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on table core.requests is
  'Mig 178 (IA M-7): one ask the product is chasing — receipt, W-9, COI, client question, document, approval nudge, dunning. Cadence + quiet hours + escalation live on the row (copied from the tenant policy at creation). Written only by the service role (lib/requests).';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_kind_chk') then
    alter table core.requests add constraint requests_kind_chk
      check (kind in ('receipt','w9','coi','client_question','document','approval_nudge','dunning'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_subject_type_chk') then
    alter table core.requests add constraint requests_subject_type_chk
      check (subject_type in ('none','vendor','vendor_compliance_doc','bank_transaction','card_transaction','bill',
                              'invoice','customer','expense_line','approval','period','job'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_recipient_type_chk') then
    alter table core.requests add constraint requests_recipient_type_chk
      check (recipient_type in ('member','vendor_contact','customer_contact','employee','email'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_channels_chk') then
    alter table core.requests add constraint requests_channels_chk
      check (cardinality(channels) >= 1 and channels <@ array['email','sms','push','in_app']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_cadence_chk') then
    alter table core.requests add constraint requests_cadence_chk
      check (cadence_anchor in ('created','due')
             and cardinality(cadence_offsets_minutes) between 1 and 12
             and (repeat_every_minutes is null or repeat_every_minutes between 15 and 525600)
             and max_sends between 1 and 100
             and cadence_slot >= 1
             and sends_count >= 0
             and (escalate_after is null or escalate_after between 1 and 100)
             and (cadence_anchor = 'created' or due_date is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_status_chk') then
    alter table core.requests add constraint requests_status_chk
      check (status in ('open','sent','snoozed','fulfilled','cancelled','expired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_fulfilled_via_chk') then
    alter table core.requests add constraint requests_fulfilled_via_chk
      check (fulfilled_via is null or fulfilled_via in ('app','resolver','magic_link','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_source_chk') then
    alter table core.requests add constraint requests_source_chk
      check (source in ('manual','rule','detector','scheduler'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_deep_link_chk') then
    -- internal links only (no scheme, no protocol-relative //host) — never an open redirect
    alter table core.requests add constraint requests_deep_link_chk
      check (deep_link is null or (left(deep_link, 1) = '/' and left(deep_link, 2) <> '//'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_quiet_pair_chk') then
    alter table core.requests add constraint requests_quiet_pair_chk
      check ((quiet_start is null) = (quiet_end is null));
  end if;
end $$;

-- One LIVE request per subject (a rerun of the vendor sync can never open a second one).
create unique index if not exists ux_requests_live_dedupe
  on core.requests (org_id, dedupe_key)
  where dedupe_key is not null and status in ('open','sent','snoozed');
create index if not exists ix_requests_due
  on core.requests (org_id, next_send_at)
  where status in ('open','sent','snoozed');
create index if not exists ix_requests_org_kind_status on core.requests (org_id, kind, status, created_at desc);
create index if not exists ix_requests_subject on core.requests (org_id, subject_type, subject_id);

-- ── §2 request_events ─────────────────────────────────────────────────────────
create table if not exists core.request_events (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid references core.locations(id) on delete cascade,
  request_id          uuid not null references core.requests(id) on delete cascade,
  event_type          text not null,
  step                integer,
  channel             text,
  delivery_status     text,
  dispatch_key        text,
  provider            text,
  provider_message_id text,
  detail              text,
  meta                jsonb not null default '{}'::jsonb,
  actor               text,
  occurred_at         timestamptz not null default now()
);

comment on table core.request_events is
  'Mig 178: the request timeline. A send first CLAIMS dispatch_key (request:step:channel, unique) and only then calls the provider, so a rerun never double-sends; a failed send frees the key for retry.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'request_events_type_chk') then
    alter table core.request_events add constraint request_events_type_chk
      check (event_type in ('created','sent','delivered','opened','clicked','replied','fulfilled','bounced','complained',
                            'unsubscribed','failed','skipped','escalated','snoozed','cancelled','reopened','expired',
                            'deferred','updated'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'request_events_channel_chk') then
    alter table core.request_events add constraint request_events_channel_chk
      check (channel is null or channel in ('email','sms','push','in_app'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'request_events_delivery_chk') then
    alter table core.request_events add constraint request_events_delivery_chk
      check (delivery_status is null or delivery_status in ('claimed','sent','failed','skipped'));
  end if;
end $$;

create unique index if not exists ux_request_events_dispatch on core.request_events (dispatch_key) where dispatch_key is not null;
create index if not exists ix_request_events_request on core.request_events (request_id, occurred_at);
create index if not exists ix_request_events_provider on core.request_events (provider_message_id) where provider_message_id is not null;

-- ── §3 request_tokens ─────────────────────────────────────────────────────────
create table if not exists core.request_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid references core.locations(id) on delete cascade,
  request_id    uuid not null references core.requests(id) on delete cascade,
  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
comment on table core.request_tokens is
  'Mig 178: magic-link tokens for external recipients, stored ONLY as sha256 hex. One per send; all valid until expiry, revocation or the request closing. No member access at all.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'request_tokens_hash_chk') then
    alter table core.request_tokens add constraint request_tokens_hash_chk check (token_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;
create unique index if not exists ux_request_tokens_hash on core.request_tokens (token_hash);
create index if not exists ix_request_tokens_request on core.request_tokens (request_id);

-- ── §4 request_policies ───────────────────────────────────────────────────────
create table if not exists core.request_policies (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid references core.locations(id) on delete cascade,
  policy_key               text not null,
  auto_create              boolean not null default false,
  cadence_anchor           text,
  cadence_offsets_minutes  integer[],
  repeat_every_minutes     integer,
  max_sends                integer,
  escalate_after           integer,
  channels                 text[],
  quiet_start              time,
  quiet_end                time,
  timezone                 text,
  updated_by               text,
  updated_at               timestamptz not null default now()
);
comment on table core.request_policies is
  'Mig 178: tenant (location_id null) cadence defaults per policy key. Null columns inherit the code default. Receipt chase is NOT here — it reads organizations.chase_* (Settings → Receipt chase).';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'request_policies_key_chk') then
    alter table core.request_policies add constraint request_policies_key_chk
      check (policy_key in ('default','w9','coi','coi_renewal','client_question','document','approval_nudge','dunning'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'request_policies_values_chk') then
    alter table core.request_policies add constraint request_policies_values_chk
      check ((cadence_anchor is null or cadence_anchor in ('created','due'))
             and (cadence_offsets_minutes is null or cardinality(cadence_offsets_minutes) between 1 and 12)
             and (repeat_every_minutes is null or repeat_every_minutes between 15 and 525600)
             and (max_sends is null or max_sends between 1 and 100)
             and (escalate_after is null or escalate_after between 1 and 100)
             and (channels is null or (cardinality(channels) >= 1 and channels <@ array['email','sms','push','in_app']::text[]))
             and ((quiet_start is null) = (quiet_end is null)));
  end if;
end $$;
create unique index if not exists ux_request_policies_tenant on core.request_policies (org_id, policy_key) where location_id is null;
create unique index if not exists ux_request_policies_client on core.request_policies (org_id, location_id, policy_key) where location_id is not null;

-- ── §5 request_suppressions ───────────────────────────────────────────────────
create table if not exists core.request_suppressions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid references core.locations(id) on delete cascade,
  channel            text not null,
  address            text not null,
  reason             text not null,
  source_request_id  uuid,
  created_at         timestamptz not null default now()
);
comment on table core.request_suppressions is
  'Mig 178: addresses the engine must never message again for this tenant (unsubscribe, STOP, hard bounce, complaint). address is lower-cased.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'request_suppressions_chk') then
    alter table core.request_suppressions add constraint request_suppressions_chk
      check (channel in ('email','sms','push') and reason in ('unsubscribe','stop','bounce','complaint','manual')
             and address = lower(address) and length(address) between 3 and 320);
  end if;
end $$;
create unique index if not exists ux_request_suppressions on core.request_suppressions (org_id, channel, address);

-- ── §6 notifications ──────────────────────────────────────────────────────────
create table if not exists core.notifications (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid references core.locations(id) on delete cascade,
  membership_id   uuid not null references core.memberships(id) on delete cascade,
  kind            text not null,
  severity        text not null default 'info',
  title           text not null,
  body            text,
  deep_link       text,
  request_id      uuid references core.requests(id) on delete set null,
  dedupe_key      text,
  read_at         timestamptz,
  emailed_at      timestamptz,
  created_at      timestamptz not null default now()
);
comment on table core.notifications is
  'Mig 178 (IA M-13): in-app notifications. A member reads only their own (membership_id = caller). Written by the service role.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_chk') then
    alter table core.notifications add constraint notifications_chk
      check (kind ~ '^[a-z][a-z0-9_.]{1,63}$'
             and severity in ('info','attention','critical')
             and length(title) between 1 and 200
             and (deep_link is null or (left(deep_link, 1) = '/' and left(deep_link, 2) <> '//')));
  end if;
end $$;
create unique index if not exists ux_notifications_dedupe on core.notifications (membership_id, dedupe_key) where dedupe_key is not null;
create index if not exists ix_notifications_member on core.notifications (membership_id, created_at desc);
create index if not exists ix_notifications_unread on core.notifications (membership_id) where read_at is null;

-- ── §7 notification_prefs ─────────────────────────────────────────────────────
create table if not exists core.notification_prefs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid references core.locations(id) on delete cascade,
  membership_id   uuid not null references core.memberships(id) on delete cascade,
  channels        text[] not null default array['in_app','email']::text[],
  digest          text not null default 'instant',
  quiet_start     time,
  quiet_end       time,
  timezone        text,
  muted_kinds     text[] not null default array[]::text[],
  updated_at      timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notification_prefs_chk') then
    alter table core.notification_prefs add constraint notification_prefs_chk
      check (digest in ('instant','daily','weekly','off')
             and channels <@ array['email','sms','push','in_app']::text[]
             and ((quiet_start is null) = (quiet_end is null)));
  end if;
end $$;
create unique index if not exists ux_notification_prefs_member on core.notification_prefs (membership_id);

-- ── the caller's membership (for "own rows" policies) ────────────────────────
create or replace function core.notify_caller_membership() returns uuid
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select ms.id
    from core.memberships ms
    join core.users u on u.id = ms.user_id
   where u.clerk_user_id = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
     and ms.org_id = public.get_org_id()
     and ms.status = 'active'
   limit 1
$$;
revoke all on function core.notify_caller_membership() from public, anon;
grant execute on function core.notify_caller_membership() to authenticated, service_role;

-- ── §8 RLS + grants ───────────────────────────────────────────────────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['requests','request_events','request_tokens','request_policies','request_suppressions',
                           'notifications','notification_prefs'] loop
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'core' and tablename = t and policyname <> 'client_scope_rls' loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    if t in ('notifications', 'notification_prefs') then
      execute format(
        'create policy member_read on core.%I for select to authenticated using (org_id = public.get_org_id() and membership_id = core.notify_caller_membership())', t);
    elsif t <> 'request_tokens' then
      -- request_tokens: no member read at all (only the server resolves a hash)
      execute format(
        'create policy member_read on core.%I for select to authenticated using (org_id is not null and org_id = public.get_org_id())', t);
    end if;
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table core.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from authenticated', t);
    if t = 'request_tokens' then
      execute format('revoke select on table core.%I from authenticated', t);
    else
      execute format('grant select on table core.%I to authenticated', t);
    end if;
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- ── §10 outbound send quotas (security review: free-text recipients) ─────────
-- Fixed-window counters for outbound email the app sends on a member's behalf to
-- addresses they typed (request emails, invoice send / remind). The app bumps BOTH the
-- per-user hourly and the per-org daily window before handing a message to the provider
-- and refuses when either is over its limit (lib/email/send-quota.ts holds the limits).
-- Org-level table (no location_id): it meters the tenant, not a client. Service role only.
create table if not exists core.outbound_send_counters (
  org_id        uuid not null references core.organizations(id) on delete cascade,
  scope         text not null,
  scope_key     text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (org_id, scope, scope_key, window_start)
);
comment on table core.outbound_send_counters is
  'Mig 178 §10: per-user (hour) / per-org (day) outbound email counters. Bumped only through core.bump_send_quota by the service role.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outbound_send_counters_chk') then
    alter table core.outbound_send_counters add constraint outbound_send_counters_chk
      check (scope in ('user_hour','org_day') and count >= 0 and length(scope_key) between 1 and 200);
  end if;
end $$;
create index if not exists ix_outbound_send_counters_window on core.outbound_send_counters (window_start);

alter table core.outbound_send_counters enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'core' and tablename = 'outbound_send_counters' loop
    execute format('drop policy if exists %I on core.outbound_send_counters', p.policyname);
  end loop;
end $$;
create policy service_all on core.outbound_send_counters for all to service_role using (true) with check (true);
revoke all on table core.outbound_send_counters from anon, authenticated;
grant select, insert, update, delete on table core.outbound_send_counters to service_role;

-- Atomically add p_inc to the (org, scope, key, window) counter and return the new total.
-- Windows older than two days are swept opportunistically.
create or replace function core.bump_send_quota(
  p_org uuid, p_scope text, p_key text, p_window_start timestamptz, p_inc integer
) returns integer
  language plpgsql security invoker set search_path = core, public, pg_temp as
$$
declare
  v_count integer;
begin
  insert into core.outbound_send_counters (org_id, scope, scope_key, window_start, count, updated_at)
  values (p_org, p_scope, p_key, p_window_start, greatest(p_inc, 0), now())
  on conflict (org_id, scope, scope_key, window_start)
  do update set count = core.outbound_send_counters.count + greatest(p_inc, 0), updated_at = now()
  returning count into v_count;
  delete from core.outbound_send_counters where window_start < now() - interval '2 days';
  return v_count;
end;
$$;
revoke all on function core.bump_send_quota(uuid, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function core.bump_send_quota(uuid, text, text, timestamptz, integer) to service_role;

-- End migration 178.

do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
