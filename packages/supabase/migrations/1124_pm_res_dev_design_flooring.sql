-- ============================================================================
-- 1124 · Merit Projects — residential, real-estate development, interior design and flooring
--        completion (Wave C, agent C-RDDF)
--
-- Spec: expert-panel seats 02 (RES Launch rows still open after 1119), 05 (RED Launch rows still
-- open after 1122) and 04 (FLR / ID Launch rows still open after 1122); docs/projects/WAVE-C-BRIEF.md
-- (binding rules). Builds on 1100–1122; nothing earlier is modified: new tables, new definer RPCs,
-- additive columns on 1119 / 1122 settings rows, and three additive triggers that act only on rows
-- this migration links (client-visible task date changes, the lender-consent gate on a development
-- change order, the installer-compliance gate on a flooring install booking).
--
-- MONEY RULES (1110): bigint cents, fractions for percents, integer half-up rounding (pm.res_round /
-- pm.fs_rdiv). Money columns are masked through pm.access_masked_columns; every definer RPC that
-- returns money strips it unless the caller holds the capability at that company / job. NO GL:
-- Books owns invoices, payments, AR / AP, deposits, payroll, CIP and the trial balance. Whatever
-- Books has to act on is held in pm.wc_books_requests (payload ready) for the Books consumers named
-- in the hand-off — Books rejects unknown Projects event types, so no new core.events types.
--
-- WHAT THIS ADDS
--   W  shared
--        wc_setup_runs + wc_apply_setup (RES-01 / FLR-01 / ID-01: the setup interview's plan, built
--          by lib/{residential,flooring,design}/setup.ts, validated and applied here)
--        wc_books_requests (held hand-offs to Books: account map, dead-deal write-off, intercompany
--          fee invoice, affiliate payable, receipt / card coding, counter sale, product invoice tax)
--        wc_reps + wc_appointments + wc_booking_links (RES-10 in-home sales appointments, FLR-07
--          measure appointments, ID-03 discovery calls): drive-time-aware slots (pm.wc_drive_minutes,
--          mirrored by lib/residential/routing.ts), booking, confirmations, reminders, "on my way",
--          the lead brief to the rep, and token-scoped homeowner self-booking (public.wc_booking_slots,
--          public.wc_self_book — anon, sha-256 token first)
--   R  residential (res_)
--        res_job_templates + res_job_setups (RES-03 builder job types; spec / production flagged
--          capitalize-to-inventory), res_site_captures (RES-11 → pm.measures, home profile, RRP),
--        res_kb_imports / _lines / res_kb_sku_map (RES-23 2020 / Cabinet Vision / ProKitchen lists →
--          catalog SKUs → proposal lines), res_resource_capacity + res_crew_capacity (RES-49),
--        res_client_date_changes + client schedule filter (RES-52), res_receipt_captures (RES-62),
--        res_field_sites (RES-68 "Today" site cards for /api/field), res_job_cash_position (RES-84),
--        res_client_updates (RES-90 rules-only weekly draft → portal), res_closeout_packages / _items
--        (RES-97), res_watch_settings + res_margin_alerts + res_margin_fade (RES-122),
--        res_owner_dashboard (RES-123), res_export_tables (RES-127 export manifest)
--   D  development (dev_)
--        dev_pursuits + dev_dd_items (RED-03/04), dev_entitlement_conditions + dev_incentives (RED-05),
--        dev_covenants + dev_calendar (RED-06), dev_pro_forma import map (RED-08 via dev_imports),
--        dev_interest_reserve + dev_capitalized_interest (RED-15), dev_fee_schedules / dev_fee_draws
--        (RED-16), dev_co_funding + consent gate (RED-19), dev_compliance (RED-20),
--        dev_invoice_inbox (RED-21), dev_pay_app_reviews (RED-22), dev_invoice_routes /
--        dev_invoice_approvals (RED-23), dev_draw_fundings / dev_disbursements (RED-29),
--        dev_seed_milestones (RED-30), dev_status_events (RED-31), dev_seed_doc_room (RED-41),
--        dev_affiliate_bills (RED-42), dev_imports + dev_tieout (RED-44)
--   F  flooring (flr_)
--        flr_lead_rotation (FLR-03), measure fee credit (FLR-07), flr_price_imports / _lines (FLR-14),
--        flr_deposit_terms (FLR-17), flr_counter_sales / _lines (FLR-19), flr_field_changes (FLR-20),
--        special orders on pm.procurement_items + tracker (FLR-21/23), flr_lots / flr_lot_moves
--        (FLR-26), flr_receipts / flr_unmatched_receipts (FLR-28), install confirmations (FLR-31),
--        flr_installers + dispatch gate (FLR-32), flr_signoffs + installer day (FLR-33),
--        completion invoice (FLR-36), flr_callbacks (FLR-37), flr_reports (FLR-44)
--   I  interior design (dsn_)
--        dsn_settings (ID-01), dsn_discovery (ID-03), dsn_agreements (ID-04), dsn_rooms + room budget
--        alerts (ID-05/06), dsn_products / dsn_vendor_terms + clipper (ID-07/08), dsn_boards / _items
--        (ID-11), dsn_ffe_schedule (ID-13), dsn_pricing_rules + dsn_price_item (ID-14),
--        dsn_item_changes (ID-24), dsn_freight_claims (ID-25), dsn_install_checklists (ID-28),
--        dsn_draft_product_invoice + dsn_deposit_statement (ID-33), dsn_reimbursables (ID-34),
--        dsn_reports (ID-36)
--
-- ACCESS: every new table classified, money columns masked, every member-executable definer RPC
--   guarded; helpers and triggers are service-only; nothing in pm is executable by anon. The two
--   public anon functions need the app route's server key (pm._fs_widget_assert_server) and are
--   token-scoped (sha-256 match first). No new public / core tables.
--
-- APPLY RULE: after 1100–1122. Idempotent (safe twice); PGlite-safe.
--
-- SECURITY NOTE (review round 2): "the caller's own upload" evidence — a field change-order
--   signature image (flr_field_change), a lender consent letter (dev_record_co_consent), a receipt
--   photo — is self-attested: it proves the caller uploaded a file for this org / job, not that the
--   customer signed or the lender agreed. The approver still reviews the document itself.
-- ============================================================================

do $$
begin
  if to_regclass('pm.res_settings') is null then raise exception '1124 requires 1119_pm_residential'; end if;
  if to_regclass('pm.dev_projects') is null then raise exception '1124 requires 1122_pm_industry_depth'; end if;
  if to_regclass('pm.portal_messages') is null then raise exception '1124 requires 1118_pm_portals'; end if;
  if to_regprocedure('pm._x_job(uuid)') is null then raise exception '1124 requires 1122 helpers (pm._x_job)'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Helpers (service-only)
-- ----------------------------------------------------------------------------
-- Org of a row's company, or PM_FORBIDDEN (the caller's org only).
create or replace function pm._wc_loc(p_location uuid) returns uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if p_location is null or not exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  return public.get_org_id();
end $$;

-- Strip money keys from a jsonb object unless p_keep (keys ending in _cents, plus the named ones).
create or replace function pm._wc_strip(p jsonb, p_keep boolean, p_extra text[] default '{}') returns jsonb
language sql immutable
set search_path = pm, public
as $$
  select case when p_keep or p is null or jsonb_typeof(p) <> 'object' then p
              else (select coalesce(jsonb_object_agg(k, case when k like '%\_cents' or k = any (p_extra) then 'null'::jsonb else v end), '{}'::jsonb)
                      from jsonb_each(p) as e(k, v)) end
$$;

-- Great-circle distance (km) and the deterministic drive-time model the slot finder uses:
-- road factor 1.3 at 50 km/h + 5 minutes to park; 30 minutes when either point has no coordinates.
-- Mirrored by lib/residential/routing.ts (parity-tested).
create or replace function pm.wc_distance_km(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns numeric
language sql immutable
set search_path = pm, public
as $$
  select case when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null else
    round((2 * 6371.0088 * asin(sqrt(
      power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
      + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2))))::numeric, 3) end
$$;

create or replace function pm.wc_drive_minutes(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns int
language sql immutable
set search_path = pm, public
as $$
  select case when pm.wc_distance_km(p_lat1, p_lng1, p_lat2, p_lng2) is null then 30
              else ceil(pm.wc_distance_km(p_lat1, p_lng1, p_lat2, p_lng2) * 1.3 / 50.0 * 60.0)::int + 5 end
$$;

-- The company's time zone (notification settings → organization → America/Chicago).
create or replace function pm._wc_tz(p_org uuid, p_location uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(nullif((core.notify_settings_row(p_org, p_location)).timezone, ''),
                  (select nullif(o.timezone, '') from core.organizations o where o.id = p_org), 'America/Chicago')
$$;

-- Fan-out that never breaks the business write (a notification failure is logged, not raised).
create or replace function pm._wc_fanout(p_org uuid, p_event text, p_location uuid, p_job uuid, p_subject_type text, p_subject uuid,
                                          p_recipients uuid[], p_title text, p_body text, p_link text, p_dedupe text,
                                          p_money_cap text default null, p_title_money text default null, p_body_money text default null)
returns int
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare n int := 0;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then return 0; end if;
  begin
    n := core.notify_fanout(p_org, p_event, p_location, p_job, p_subject_type, p_subject, null, p_recipients, left(p_title, 200), left(p_body, 1000),
                            p_title_money, p_body_money, p_link, p_dedupe, '{}'::jsonb, p_money_cap, null, false);
  exception when others then n := 0;
  end;
  return coalesce(n, 0);
end $$;

-- Customer message that never breaks the business write; returns the outbound id or null.
create or replace function pm._wc_customer_msg(p_org uuid, p_location uuid, p_job uuid, p_event text, p_contact uuid, p_subject text, p_body text,
                                                p_dedupe text, p_prefer text default 'sms')
returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare c record; v uuid; v_ch text;
begin
  if p_contact is null then return null; end if;
  select ct.email, ct.phone into c from core.contacts ct where ct.id = p_contact and ct.org_id = p_org;
  v_ch := case when p_prefer = 'sms' and nullif(btrim(coalesce(c.phone, '')), '') is not null then 'sms'
               when nullif(btrim(coalesce(c.email, '')), '') is not null then 'email'
               when nullif(btrim(coalesce(c.phone, '')), '') is not null then 'sms' end;
  if v_ch is null then return null; end if;
  begin
    v := core.notify_customer(p_org, p_location, p_job, p_event, v_ch, p_contact, p_subject, p_body, null, p_dedupe, pm.current_user_id());
  exception when others then v := null;
  end;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- W1. Notification event types (seven internal, all mandatory; three customer). Recipes in W1b.
-- ----------------------------------------------------------------------------
insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
  ('sales.appointment_booked', 'Appointment booked for you', 'A sales or measure appointment was booked on your calendar, with the lead brief.', 'sales', 'internal', null, true, 0, 'info', false, 120),
  ('job.margin_fade',          'Margin fading on a job', 'Projected margin dropped below what was sold by more than the company''s alert threshold.', 'work', 'internal', 'projects.financials', true, 0, 'attention', false, 140),
  ('job.cash_negative',        'Job went cash-negative', 'Cost incurred on a job is ahead of the cash collected on it.', 'work', 'internal', 'projects.financials', true, 0, 'attention', false, 141),
  ('client_update.ready',      'Weekly client update ready', 'This week''s client update was drafted from the logs, photos and schedule. Edit and send it.', 'work', 'internal', null, true, 0, 'info', false, 142),
  ('development.key_date_due', 'Development date coming due', 'A PSA, loan, covenant, entitlement or due-diligence date is inside its reminder window.', 'schedule', 'internal', null, true, 0, 'attention', false, 143),
  ('flooring.goods_received',  'Special-order goods received', 'Material for one of your orders was received and inspected (damage or shortage noted).', 'work', 'internal', null, true, 0, 'info', false, 144),
  ('design.room_over_budget',  'Room over budget', 'The items specified for a room total more than the room budget.', 'work', 'internal', 'projects.contract_value', true, 0, 'attention', false, 145),
  ('customer.appointment_booked', 'Appointment confirmation to a customer', 'Confirms the date, time and who is coming, with what to have ready.', 'customer', 'customer', null, false, 0, 'info', false, 290),
  ('customer.order_update',    'Order update to a customer', 'Tells the customer their special-order material arrived (or is delayed).', 'customer', 'customer', null, false, 0, 'info', false, 291),
  ('customer.install_confirmation', 'Install confirmation to a customer', 'Confirms the install date with prep instructions (move furniture, HVAC off) and a reschedule link.', 'customer', 'customer', null, false, 0, 'info', false, 292)
on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
  audience = excluded.audience, money_cap = excluded.money_cap, mandatory = excluded.mandatory,
  batch_window_minutes = excluded.batch_window_minutes, severity = excluded.severity, emit_rpc = excluded.emit_rpc, sort = excluded.sort;

-- W1b. Role defaults for the seven internal events (platform rows, same shape and codes as 1114 §3;
-- mirrored by RECIPE_CODES in apps/projects/src/lib/notify/recipes.ts). Mandatory, so the floor is I.
do $$
declare
  v_personas text[] := array['projects_owner','projects_gm','projects_office_manager','projects_project_accountant',
                             'projects_dispatcher','projects_purchasing','projects_pm','projects_supervisor',
                             'projects_labor','projects_sales','default'];
  r record; i int; c text;
begin
  for r in select * from (values
    -- event                     owner gm  om  pa  disp pur pm  sup lab sal default
    ('sales.appointment_booked', array['I','I','I','I','I','I','I','I','I','P','I']),
    ('job.margin_fade',          array['P','P','I','I','I','I','P','I','I','I','I']),
    ('job.cash_negative',        array['P','P','I','P','I','I','P','I','I','I','I']),
    ('client_update.ready',      array['I','I','I','I','I','I','P','I','I','I','I']),
    ('development.key_date_due', array['P','P','I','I','I','I','P','I','I','I','I']),
    ('flooring.goods_received',  array['I','I','I','I','P','P','P','I','I','P','I']),
    ('design.room_over_budget',  array['I','I','I','I','I','P','P','I','I','I','I'])
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
-- W2. Setup interview runs (RES-01 / FLR-01 / ID-01)
-- ----------------------------------------------------------------------------
create table if not exists pm.wc_setup_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  industry     text not null check (industry in ('RESIDENTIAL','FLOORING','DESIGN')),
  answers      jsonb not null check (jsonb_typeof(answers) = 'object'),
  plan         jsonb not null check (jsonb_typeof(plan) = 'object'),
  result       jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),
  applied_by   text default pm.current_user_id(),
  applied_at   timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists pm_wc_setup_runs_idx on pm.wc_setup_runs (org_id, location_id, industry, applied_at desc);

-- Held hand-offs to Books (one row per business fact; payload is what the Books consumer reads).
create table if not exists pm.wc_books_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  job_id       uuid,
  kind         text not null check (kind in ('ACCOUNT_MAP','DEAD_DEAL_WRITE_OFF','INTERCOMPANY_FEE_INVOICE','AFFILIATE_PAYABLE','RECEIPT_CODING',
                                             'CARD_CODING','COUNTER_SALE','PRODUCT_INVOICE','REIMBURSABLE_BILLING','INSTALLER_CHARGE')),
  source_table text not null check (source_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  source_id    uuid not null,
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),
  status       text not null default 'HELD' check (status in ('HELD','SENT','DONE','CANCELLED')),
  books_ref    text,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, kind, source_table, source_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_wc_books_requests_idx on pm.wc_books_requests (org_id, location_id, status, created_at desc);
comment on table pm.wc_books_requests is '1124: hand-offs Books acts on (payload ready). Books has no consumer for these yet — listed in the hand-off as seam asks.';

create or replace function pm._wc_books_request(p_org uuid, p_location uuid, p_job uuid, p_kind text, p_table text, p_id uuid, p_payload jsonb)
returns uuid
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  insert into pm.wc_books_requests (org_id, location_id, job_id, kind, source_table, source_id, payload)
  values (p_org, p_location, p_job, p_kind, p_table, p_id, p_payload || jsonb_build_object('request', p_kind, 'schema_version', 1))
  on conflict (org_id, kind, source_table, source_id) do update set payload = excluded.payload, updated_at = now()
     where pm.wc_books_requests.status = 'HELD'
  returning id into v;
  if v is null then select r.id into v from pm.wc_books_requests r where r.org_id = p_org and r.kind = p_kind and r.source_table = p_table and r.source_id = p_id; end if;
  return v;
end $$;

-- Phone command ledger (1124's own; same idea as 1123's pm.fs_field_commands, kept separate so
-- 1124 does not depend on 1123). One row per (org, command id), claimed in the same transaction
-- as the work: a re-send of the same command returns the first answer, never a second record.
create table if not exists pm.wc_field_commands (
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  command_id  uuid not null,
  kind        text not null check (char_length(kind) between 1 and 60),
  user_id     text default pm.current_user_id(),
  subject_id  uuid,
  result      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (org_id, command_id)
);
alter table pm.wc_field_commands add column if not exists job_id uuid;

-- Claim a command id. Null = first time (do the work, then _wc_cmd_done); otherwise the stored
-- answer. A concurrent duplicate waits on the first insert, then reads its committed answer.
drop function if exists pm._wc_cmd_claim(uuid, uuid, text);
create or replace function pm._wc_cmd_claim(p_org uuid, p_command uuid, p_kind text, p_job uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v uuid; r pm.wc_field_commands%rowtype;
begin
  if p_command is null then return null; end if;
  insert into pm.wc_field_commands (org_id, command_id, kind, job_id) values (p_org, p_command, p_kind, p_job)
  on conflict (org_id, command_id) do nothing returning command_id into v;
  if v is not null then return null; end if;
  select * into r from pm.wc_field_commands c where c.org_id = p_org and c.command_id = p_command;
  -- a replay is only the same person's same command on the same job (security review L1)
  if r.kind <> p_kind or r.user_id is distinct from pm.current_user_id() or r.job_id is distinct from p_job then
    raise exception 'PM_INVALID: that command id was already used for something else' using errcode = '22023';
  end if;
  return r.result || jsonb_build_object('replayed', true);
end $$;

create or replace function pm._wc_cmd_done(p_org uuid, p_command uuid, p_subject uuid, p_result jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
begin
  if p_command is not null then
    update pm.wc_field_commands set subject_id = p_subject, result = p_result where org_id = p_org and command_id = p_command;
  end if;
  return p_result || jsonb_build_object('replayed', false);
end $$;

-- Explicit caller checks before a nested guarded call (security review: a guarded entry RPC sets
-- pm.access_entry, so every guarded RPC it calls skips its own guard — the caller re-checks the
-- inner requirement itself, on the object the inner call touches).
create or replace function pm._wc_require_job(p_cap text, p_action text, p_job uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_can_job(p_cap, p_action, p_job) then perform pm.access_forbid(format('requires %s:%s on that job', p_cap, p_action)); end if;
end $$;

create or replace function pm._wc_require_row(p_cap text, p_action text, p_table text, p_id uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_can_row(p_cap, p_action, p_table, p_id) then perform pm.access_forbid(format('requires %s:%s', p_cap, p_action)); end if;
end $$;

create or replace function pm._wc_require_location(p_cap text, p_action text, p_location uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not pm.access_can_location(p_cap, p_action, p_location) then perform pm.access_forbid(format('requires %s:%s at that company', p_cap, p_action)); end if;
end $$;

-- A document a caller attaches: in this org, and (when a job is given) linked to that job or
-- uploaded by the caller. Raises PM_INVALID otherwise.
create or replace function pm._wc_check_document(p_org uuid, p_job uuid, p_document uuid, p_what text default 'that document') returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if p_document is null then return; end if;
  if not exists (select 1 from public.documents d where d.id = p_document and d.org_id = p_org
                   and (p_job is null
                        or d.uploaded_by_user = pm.current_user_id()
                        or (d.entity_type in ('job', 'jobs', 'projects') and d.entity_id = p_job)
                        or exists (select 1 from pm.document_links dl where dl.org_id = p_org and dl.document_id = d.id and dl.job_id = p_job)
                        or exists (select 1 from pm.doc_versions v join pm.doc_files f on f.id = v.file_id where v.org_id = p_org and v.document_id = d.id and f.job_id = p_job))) then
    raise exception 'PM_INVALID: % is not on this job', p_what using errcode = '22023';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- W3. Reps, appointments, booking links (RES-10, FLR-07, ID-03)
-- ----------------------------------------------------------------------------
create table if not exists pm.wc_reps (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  membership_id    uuid not null references core.memberships(id) on delete cascade,
  display_name     text not null check (char_length(btrim(display_name)) between 1 and 120),
  kinds            text[] not null default array['SALES'] check (kinds <@ array['SALES','MEASURE','DISCOVERY','DESIGN']::text[]),
  skills           text[] not null default '{}' check (cardinality(skills) <= 20),
  zip_prefixes     text[] not null default '{}' check (cardinality(zip_prefixes) <= 100),
  home_lat         numeric(9,6) check (home_lat is null or home_lat between -90 and 90),
  home_lng         numeric(9,6) check (home_lng is null or home_lng between -180 and 180),
  work_days        int[] not null default array[1,2,3,4,5] check (work_days <@ array[0,1,2,3,4,5,6]),
  work_start       time not null default '08:00',
  work_end         time not null default '18:00',
  max_per_day      int not null default 4 check (max_per_day between 1 and 20),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, membership_id),
  check (work_end > work_start)
);

create table if not exists pm.wc_appointments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  kind             text not null default 'SALES' check (kind in ('SALES','MEASURE','DISCOVERY','DESIGN')),
  status           text not null default 'BOOKED' check (status in ('REQUESTED','BOOKED','CONFIRMED','ON_MY_WAY','ARRIVED','DONE','NO_SHOW','CANCELLED')),
  lead_id          uuid references crm.leads(id) on delete set null,
  job_id           uuid,
  rep_id           uuid,
  contact_id       uuid references core.contacts(id) on delete set null,
  requester_name   text check (requester_name is null or char_length(requester_name) <= 200),
  requester_phone  text check (requester_phone is null or char_length(requester_phone) <= 40),
  requester_email  text check (requester_email is null or char_length(requester_email) <= 254),
  starts_at        timestamptz not null,
  minutes          int not null default 90 check (minutes between 15 and 600),
  ends_at          timestamptz,
  address          text check (address is null or char_length(address) <= 500),
  zip              text check (zip is null or char_length(zip) <= 12),
  lat              numeric(9,6) check (lat is null or lat between -90 and 90),
  lng              numeric(9,6) check (lng is null or lng between -180 and 180),
  skill            text check (skill is null or char_length(skill) <= 40),
  notes            text check (notes is null or char_length(notes) <= 4000),
  self_booked      boolean not null default false,
  booking_link_id  uuid,
  measure_fee_cents bigint check (measure_fee_cents is null or measure_fee_cents >= 0),
  fee_credited_at  timestamptz,
  confirmed_at     timestamptz,
  reminded_at      timestamptz,
  on_my_way_at     timestamptz,
  done_at          timestamptz,
  outcome_note     text check (outcome_note is null or char_length(outcome_note) <= 2000),
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, rep_id) references pm.wc_reps (org_id, id) deferrable initially immediate,
  check (status = 'REQUESTED' or rep_id is not null)
);
create index if not exists pm_wc_appointments_rep_idx on pm.wc_appointments (org_id, rep_id, starts_at) where status not in ('CANCELLED','NO_SHOW');
create index if not exists pm_wc_appointments_loc_idx on pm.wc_appointments (org_id, location_id, starts_at);

create or replace function pm.tg_wc_appointment_ends() returns trigger
language plpgsql
set search_path = pm, public
as $$ begin new.ends_at := new.starts_at + make_interval(mins => new.minutes); return new; end $$;
drop trigger if exists trg_wc_appointment_ends on pm.wc_appointments;
create trigger trg_wc_appointment_ends before insert or update of starts_at, minutes on pm.wc_appointments
  for each row execute function pm.tg_wc_appointment_ends();

create table if not exists pm.wc_booking_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  kind          text not null default 'SALES' check (kind in ('SALES','MEASURE','DISCOVERY')),
  label         text not null default 'Book a visit' check (char_length(label) between 1 and 120),
  token_hash    text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  minutes       int not null default 90 check (minutes between 15 and 600),
  days_ahead    int not null default 21 check (days_ahead between 1 and 90),
  is_active     boolean not null default true,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  unique (token_hash)
);
-- security review M1: links expire and can be revoked
alter table pm.wc_booking_links add column if not exists expires_at timestamptz;
alter table pm.wc_booking_links add column if not exists revoked_at timestamptz;
alter table pm.wc_booking_links add column if not exists revoked_by text;
update pm.wc_booking_links set expires_at = created_at + interval '180 days' where expires_at is null;

-- Self-bookings by client (sha-256 of the platform-vouched client IP, never the IP itself) for the per-IP limit.
create table if not exists pm.wc_booking_hits (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  link_id       uuid not null references pm.wc_booking_links(id) on delete cascade,
  ip_hash       text not null check (ip_hash = 'unknown' or ip_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now()
);
create index if not exists pm_wc_booking_hits_ip_idx on pm.wc_booking_hits (ip_hash, created_at desc);

-- Open slots for one day: every active rep of the kind at the company, 30-minute steps inside the
-- rep's hours, no overlap with their booked visits once the drive from the visit before and to the
-- visit after is added, at most max_per_day. Ranked: skill match, territory (zip prefix), fewest
-- added drive minutes. Rep names and drive times only for members (the public form gets times).
create or replace function pm._wc_slots(p_org uuid, p_location uuid, p_day date, p_kind text, p_skill text, p_lat numeric, p_lng numeric, p_zip text,
                                         p_minutes int, p_limit int, p_rep uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.wc_reps%rowtype; v_tz text := pm._wc_tz(p_org, p_location); t timestamptz; v_end timestamptz; prev record; nxt record;
  v_from_lat numeric; v_from_lng numeric; d_in int; d_out int; v_out jsonb := '[]'; v_n int; ok boolean; v_score numeric;
  v_dow int := extract(dow from p_day)::int;
begin
  for r in select * from pm.wc_reps x where x.org_id = p_org and x.location_id = p_location and x.is_active and p_kind = any (x.kinds)
             and v_dow = any (x.work_days) and (p_rep is null or x.id = p_rep) loop
    select count(*) into v_n from pm.wc_appointments a where a.org_id = p_org and a.rep_id = r.id and a.status not in ('CANCELLED','NO_SHOW','REQUESTED')
       and (a.starts_at at time zone v_tz)::date = p_day;
    continue when v_n >= r.max_per_day;
    t := (p_day + r.work_start) at time zone v_tz;
    v_end := (p_day + r.work_end) at time zone v_tz;
    while t + make_interval(mins => p_minutes) <= v_end loop
      select a.starts_at, a.ends_at, a.lat, a.lng into prev from pm.wc_appointments a
       where a.org_id = p_org and a.rep_id = r.id and a.status not in ('CANCELLED','NO_SHOW','REQUESTED') and a.starts_at < t
         and (a.starts_at at time zone v_tz)::date = p_day order by a.starts_at desc limit 1;
      select a.starts_at, a.ends_at, a.lat, a.lng into nxt from pm.wc_appointments a
       where a.org_id = p_org and a.rep_id = r.id and a.status not in ('CANCELLED','NO_SHOW','REQUESTED') and a.starts_at >= t
         and (a.starts_at at time zone v_tz)::date = p_day order by a.starts_at limit 1;
      v_from_lat := coalesce(prev.lat, r.home_lat); v_from_lng := coalesce(prev.lng, r.home_lng);
      d_in := pm.wc_drive_minutes(v_from_lat, v_from_lng, p_lat, p_lng);
      d_out := case when nxt.starts_at is null then 0 else pm.wc_drive_minutes(p_lat, p_lng, nxt.lat, nxt.lng) end;
      ok := (prev.ends_at is null or prev.ends_at + make_interval(mins => d_in) <= t)
            and (nxt.starts_at is null or t + make_interval(mins => p_minutes + d_out) <= nxt.starts_at)
            and (prev.ends_at is not null or r.home_lat is null or p_lat is null
                 or t >= ((p_day + r.work_start) at time zone v_tz) + make_interval(mins => least(d_in, 60)));
      if ok and t > now() then
        v_score := (case when p_skill is null or p_skill = any (r.skills) then 0 else 1000 end)
                 + (case when p_zip is null or cardinality(r.zip_prefixes) = 0 or exists (select 1 from unnest(r.zip_prefixes) z where p_zip like z || '%') then 0 else 500 end)
                 + d_in + d_out;
        v_out := v_out || jsonb_build_object('rep_id', r.id, 'rep', r.display_name, 'starts_at', t, 'ends_at', t + make_interval(mins => p_minutes),
                                             'drive_in_minutes', d_in, 'drive_out_minutes', d_out, 'skill_match', p_skill is null or p_skill = any (r.skills),
                                             'in_territory', p_zip is null or cardinality(r.zip_prefixes) = 0 or exists (select 1 from unnest(r.zip_prefixes) z where p_zip like z || '%'),
                                             'score', v_score);
      end if;
      t := t + interval '30 minutes';
    end loop;
  end loop;
  return coalesce((select jsonb_agg(x order by (x ->> 'score')::numeric, x ->> 'starts_at') from (
                    select x from jsonb_array_elements(v_out) x order by (x ->> 'score')::numeric, x ->> 'starts_at' limit greatest(coalesce(p_limit, 12), 1)) s), '[]'::jsonb);
end $$;

create or replace function pm.wc_appointment_slots(p_location uuid, p_day date, p_kind text default 'SALES', p_skill text default null, p_lat numeric default null,
                                                   p_lng numeric default null, p_zip text default null, p_minutes int default 90, p_limit int default 12)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location);
begin
  if p_kind not in ('SALES','MEASURE','DISCOVERY','DESIGN') then raise exception 'PM_INVALID: appointment kind %', p_kind using errcode = '22023'; end if;
  return jsonb_build_object('day', p_day, 'slots', pm._wc_slots(v_org, p_location, p_day, p_kind, p_skill, p_lat, p_lng, p_zip, greatest(coalesce(p_minutes, 90), 15), p_limit));
end $$;

-- Book (or confirm a self-booked request onto a rep). The rep gets the lead brief; the customer a confirmation.
create or replace function pm.wc_book_appointment(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); a jsonb := coalesce(p_attrs, '{}'); r pm.wc_reps%rowtype; v_id uuid; v_start timestamptz; v_min int;
  l record; v_brief text; v_tz text; v_lat numeric; v_lng numeric; v_existing uuid := pm.access_try_uuid(a ->> 'appointment_id');
  v_kind text := coalesce(nullif(a ->> 'kind', ''), 'SALES'); v_contact uuid; v_job uuid := pm.access_try_uuid(a ->> 'job_id');
begin
  select * into r from pm.wc_reps x where x.org_id = v_org and x.id = pm.access_try_uuid(a ->> 'rep_id') and x.location_id = p_location and x.is_active;
  if r.id is null then raise exception 'PM_INVALID: pick a rep at this company' using errcode = '22023'; end if;
  if not (v_kind = any (r.kinds)) then raise exception 'PM_INVALID: % does not take % appointments', r.display_name, lower(v_kind) using errcode = '22023'; end if;
  v_start := (a ->> 'starts_at')::timestamptz;
  v_min := coalesce((a ->> 'minutes')::int, 90);
  if v_start is null then raise exception 'PM_INVALID: pick a start time' using errcode = '22023'; end if;
  v_lat := pm._x_try_num(a ->> 'lat'); v_lng := pm._x_try_num(a ->> 'lng');
  if exists (select 1 from pm.wc_appointments x where x.org_id = v_org and x.rep_id = r.id and x.status not in ('CANCELLED','NO_SHOW','REQUESTED')
               and (v_existing is null or x.id <> v_existing)
               and tstzrange(x.starts_at, x.ends_at) && tstzrange(v_start, v_start + make_interval(mins => v_min))) then
    raise exception 'PM_WC_DOUBLE_BOOKED: % already has a visit then' , r.display_name using errcode = '23P01';
  end if;
  if v_job is not null and not exists (select 1 from core.jobs j where j.id = v_job and j.org_id = v_org and j.location_id = p_location) then
    raise exception 'PM_FORBIDDEN: job not at this company' using errcode = '42501';
  end if;
  select ld.id, ld.title, ld.contact_id, ld.source, ld.next_step, ld.customer_id into l from crm.leads ld
   where ld.org_id = v_org and ld.id = pm.access_try_uuid(a ->> 'lead_id') and ld.location_id = p_location;
  v_contact := coalesce(pm.access_try_uuid(a ->> 'contact_id'), l.contact_id);
  if v_contact is not null and not exists (select 1 from core.contacts c where c.id = v_contact and c.org_id = v_org) then v_contact := null; end if;
  if v_existing is not null then
    update pm.wc_appointments set rep_id = r.id, status = 'BOOKED', starts_at = v_start, minutes = v_min, lead_id = coalesce(l.id, lead_id),
           contact_id = coalesce(v_contact, contact_id), updated_at = now()
     where org_id = v_org and id = v_existing and location_id = p_location and status in ('REQUESTED','BOOKED','CONFIRMED')
     returning id into v_id;
    if v_id is null then raise exception 'PM_INVALID: that request is no longer open' using errcode = '22023'; end if;
  else
    insert into pm.wc_appointments (org_id, location_id, kind, status, lead_id, job_id, rep_id, contact_id, starts_at, minutes, address, zip, lat, lng, skill, notes,
                                    measure_fee_cents)
    values (v_org, p_location, v_kind, 'BOOKED', l.id, v_job, r.id, v_contact, v_start, v_min, left(a ->> 'address', 500), left(a ->> 'zip', 12), v_lat, v_lng,
            left(a ->> 'skill', 40), left(a ->> 'notes', 4000), pm._x_try_bigint(a ->> 'measure_fee_cents'))
    returning id into v_id;
  end if;
  v_tz := pm._wc_tz(v_org, p_location);
  v_brief := left(concat_ws(' · ', coalesce(l.title, (select requester_name from pm.wc_appointments where id = v_id), 'Visit'),
                            to_char(v_start at time zone v_tz, 'Dy Mon DD HH12:MI AM'), a ->> 'address',
                            case when l.source is not null then 'source: ' || l.source end, nullif(a ->> 'notes', '')), 900);
  perform pm._wc_fanout(v_org, 'sales.appointment_booked', p_location, v_job, 'wc_appointments', v_id, array[r.membership_id],
                        format('%s visit booked: %s', initcap(lower(v_kind)), coalesce(l.title, 'new visit')), v_brief,
                        '/leads?appointment=' || v_id::text, 'appt.booked:' || v_id::text || ':' || extract(epoch from v_start)::bigint::text);
  perform pm._wc_customer_msg(v_org, p_location, v_job, 'customer.appointment_booked', v_contact, 'Your appointment is booked',
    left(format('You''re booked for %s with %s. Reply here to change it.', to_char(v_start at time zone v_tz, 'Dy Mon DD at HH12:MI AM'), r.display_name), 600),
    'appt.confirm:' || v_id::text || ':' || extract(epoch from v_start)::bigint::text);
  return v_id;
end $$;

create or replace function pm.wc_set_appointment_status(p_appointment uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.wc_appointments%rowtype; r pm.wc_reps%rowtype; v_tz text;
begin
  select * into a from pm.wc_appointments x where x.id = p_appointment and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: appointment not found' using errcode = '42501'; end if;
  if p_status not in ('CONFIRMED','ON_MY_WAY','ARRIVED','DONE','NO_SHOW','CANCELLED') then raise exception 'PM_INVALID: status %', p_status using errcode = '22023'; end if;
  if a.status in ('DONE','CANCELLED','NO_SHOW') then raise exception 'PM_INVALID: this visit is already %', lower(a.status) using errcode = '22023'; end if;
  if a.status = 'REQUESTED' and p_status <> 'CANCELLED' then raise exception 'PM_INVALID: book the request onto a rep first' using errcode = '22023'; end if;
  select * into r from pm.wc_reps x where x.id = a.rep_id;
  update pm.wc_appointments set status = p_status, updated_at = now(),
         confirmed_at = case when p_status = 'CONFIRMED' then now() else confirmed_at end,
         on_my_way_at = case when p_status = 'ON_MY_WAY' then now() else on_my_way_at end,
         done_at = case when p_status in ('DONE','NO_SHOW') then now() else done_at end,
         outcome_note = coalesce(left(p_note, 2000), outcome_note)
   where id = a.id;
  if p_status = 'ON_MY_WAY' then
    v_tz := pm._wc_tz(a.org_id, a.location_id);
    perform pm._wc_customer_msg(a.org_id, a.location_id, a.job_id, 'customer.on_my_way', a.contact_id, 'On the way',
      left(format('%s is on the way for your %s appointment.', coalesce(r.display_name, 'Your rep'), to_char(a.starts_at at time zone v_tz, 'HH12:MI AM')), 300),
      'appt.omw:' || a.id::text);
  end if;
  return jsonb_build_object('id', a.id, 'status', p_status);
end $$;

-- Reminders for tomorrow's visits (the sweep, or a member who works the calendar). Once per visit.
create or replace function pm.wc_send_appointment_reminders(p_location uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); a record; v_tz text := pm._wc_tz(v_org, p_location); n int := 0;
begin
  for a in select x.*, r.display_name from pm.wc_appointments x join pm.wc_reps r on r.id = x.rep_id
            where x.org_id = v_org and x.location_id = p_location and x.status in ('BOOKED','CONFIRMED') and x.reminded_at is null
              and (x.starts_at at time zone v_tz)::date = (now() at time zone v_tz)::date + 1 for update of x loop
    if pm._wc_customer_msg(v_org, p_location, a.job_id, 'customer.appointment_reminder', a.contact_id, 'Reminder: your appointment tomorrow',
         left(format('Reminder: %s is coming %s. Reply C to confirm or call us to change it.', a.display_name, to_char(a.starts_at at time zone v_tz, 'Dy at HH12:MI AM')), 300),
         'appt.remind:' || a.id::text) is not null then
      n := n + 1;
    end if;
    update pm.wc_appointments set reminded_at = now() where id = a.id;
  end loop;
  return n;
end $$;

drop function if exists pm.wc_create_booking_link(uuid, text, text, text, int);
create or replace function pm.wc_create_booking_link(p_location uuid, p_token_hash text, p_kind text default 'SALES', p_label text default null,
                                                     p_minutes int default 90, p_expires_days int default 180)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash' using errcode = '22023'; end if;
  if coalesce(p_expires_days, 180) not between 1 and 366 then raise exception 'PM_INVALID: a link lasts 1 to 366 days' using errcode = '22023'; end if;
  insert into pm.wc_booking_links (org_id, location_id, kind, label, token_hash, minutes, expires_at)
  values (v_org, p_location, coalesce(p_kind, 'SALES'), coalesce(nullif(btrim(p_label), ''), 'Book a visit'), p_token_hash, coalesce(p_minutes, 90),
          now() + make_interval(days => coalesce(p_expires_days, 180)))
  returning id into v;
  return v;
end $$;

-- Turn a booking link off now (guarded: projects.settings:configure at the link's company).
create or replace function pm.wc_revoke_booking_link(p_link uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare k pm.wc_booking_links%rowtype;
begin
  select * into k from pm.wc_booking_links x where x.id = p_link and x.org_id = public.get_org_id() for update;
  if k.id is null then raise exception 'PM_FORBIDDEN: link not found' using errcode = '42501'; end if;
  update pm.wc_booking_links set is_active = false, revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, pm.current_user_id()) where id = k.id;
  return jsonb_build_object('link_id', k.id, 'revoked', true);
end $$;

-- Public (anon) self-booking: token → link; open start times only (no rep names, no addresses).
drop function if exists public.wc_booking_slots(text, date);
-- Both public RPCs take the app route's server key first (security review round 2): the anon key
-- alone cannot reach them, so the route's Turnstile check and keyed IP hash cannot be skipped.
-- pm._fs_widget_assert_server (1117) fails closed when no key is registered.
drop function if exists public.wc_booking_slots(text, date);
create or replace function public.wc_booking_slots(p_server_key text, p_token text, p_day date)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare k pm.wc_booking_links%rowtype; v jsonb; v_tz text;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  select * into k from pm.wc_booking_links x where x.token_hash = pm._x_sha256(p_token) and x.is_active and x.revoked_at is null
     and (x.expires_at is null or x.expires_at > now());
  if k.id is null then raise exception 'PORTAL_FORBIDDEN: this booking link is not valid' using errcode = '42501'; end if;
  v_tz := pm._wc_tz(k.org_id, k.location_id);
  if p_day < (now() at time zone v_tz)::date or p_day > (now() at time zone v_tz)::date + k.days_ahead then
    return jsonb_build_object('label', k.label, 'day', p_day, 'times', '[]'::jsonb);
  end if;
  v := pm._wc_slots(k.org_id, k.location_id, p_day, k.kind, null, null, null, null, k.minutes, 200);
  return jsonb_build_object('label', k.label, 'company', (select l.name from core.locations l where l.id = k.location_id), 'day', p_day, 'minutes', k.minutes,
    'times', coalesce((select jsonb_agg(distinct s ->> 'starts_at') from jsonb_array_elements(v) s), '[]'::jsonb));
end $$;

drop function if exists public.wc_self_book(text, timestamptz, text, text, text, text, text, text);
drop function if exists public.wc_self_book(text, timestamptz, text, text, text, text, text, text);
drop function if exists public.wc_self_book(text, timestamptz, text, text, text, text, text, text, text);
create or replace function public.wc_self_book(p_server_key text, p_token text, p_starts_at timestamptz, p_name text, p_phone text default null, p_email text default null,
                                               p_address text default null, p_zip text default null, p_notes text default null, p_ip_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare k pm.wc_booking_links%rowtype; v_id uuid; v_recent int; v_ip text; v_tz text; v_day date; v_slots jsonb;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  delete from pm.wc_booking_hits where created_at < now() - interval '2 days';   -- the counter keeps two days only
  select * into k from pm.wc_booking_links x where x.token_hash = pm._x_sha256(p_token) and x.is_active and x.revoked_at is null
     and (x.expires_at is null or x.expires_at > now());
  if k.id is null then raise exception 'PORTAL_FORBIDDEN: this booking link is not valid' using errcode = '42501'; end if;
  v_ip := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash else 'unknown' end;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 200 then raise exception 'PM_INVALID: tell us your name' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is null and nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'PM_INVALID: leave a phone number or an email so we can confirm' using errcode = '22023';
  end if;
  if p_starts_at is null or p_starts_at < now() or p_starts_at > now() + make_interval(days => k.days_ahead + 1) then
    raise exception 'PM_INVALID: pick one of the open times' using errcode = '22023';
  end if;
  -- the time must be one the slot finder offers right now (security review M1)
  v_tz := pm._wc_tz(k.org_id, k.location_id);
  v_day := (p_starts_at at time zone v_tz)::date;
  v_slots := pm._wc_slots(k.org_id, k.location_id, v_day, k.kind, null, null, null, null, k.minutes, 500);
  if not exists (select 1 from jsonb_array_elements(v_slots) x where (x ->> 'starts_at')::timestamptz = p_starts_at) then
    raise exception 'PM_INVALID: that time is no longer open; pick one of the open times' using errcode = '22023';
  end if;
  -- limits: per link (20 / hour), per client (3 / hour, 10 / day across every link)
  select count(*) into v_recent from pm.wc_appointments a where a.booking_link_id = k.id and a.created_at > now() - interval '1 hour';
  if v_recent >= 20 then raise exception 'PORTAL_RATE_LIMITED: too many requests; try again later' using errcode = '42501'; end if;
  if v_ip <> 'unknown' then
    if (select count(*) from pm.wc_booking_hits h where h.ip_hash = v_ip and h.created_at > now() - interval '1 hour') >= 3
       or (select count(*) from pm.wc_booking_hits h where h.ip_hash = v_ip and h.created_at > now() - interval '1 day') >= 10 then
      raise exception 'PORTAL_RATE_LIMITED: too many requests; try again later' using errcode = '42501';
    end if;
  elsif (select count(*) from pm.wc_booking_hits h where h.link_id = k.id and h.ip_hash = 'unknown' and h.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'PORTAL_RATE_LIMITED: too many requests; try again later' using errcode = '42501';
  end if;
  insert into pm.wc_booking_hits (org_id, link_id, ip_hash) values (k.org_id, k.id, v_ip);
  insert into pm.wc_appointments (org_id, location_id, kind, status, requester_name, requester_phone, requester_email, starts_at, minutes, address, zip, notes,
                                  self_booked, booking_link_id, created_by)
  values (k.org_id, k.location_id, k.kind, 'REQUESTED', left(btrim(p_name), 200), left(btrim(p_phone), 40), left(lower(btrim(p_email)), 254), p_starts_at, k.minutes,
          left(p_address, 500), left(p_zip, 12), left(p_notes, 4000), true, k.id, 'self-booking')
  returning id into v_id;
  -- one digest notice per link per hour (the dedupe key), not one per request; no requester text in it
  perform pm._wc_fanout(k.org_id, 'sales.appointment_booked', k.location_id, null, 'wc_booking_links', k.id,
                        core.notify_members_with(k.org_id, k.location_id, 'projects.leads', 'edit'),
                        'Online visit requests waiting',
                        'Homeowners picked times on the booking page. Open the calendar to put each request on a rep''s schedule.',
                        '/homes/appointments', 'appt.requested:' || k.id::text || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24'));
  return jsonb_build_object('ok', true, 'requested', true, 'starts_at', p_starts_at);
end $$;

-- ============================================================================
-- R. Residential completion
-- ============================================================================
-- R1. Setup interview additions on res_settings (RES-01) ----------------------------------------
alter table pm.res_settings add column if not exists billing_method text not null default 'MILESTONE';
alter table pm.res_settings add column if not exists self_perform_mix text not null default 'MIXED';
alter table pm.res_settings add column if not exists payment_template jsonb not null default '[]';
alter table pm.res_settings add column if not exists selection_library jsonb not null default '[]';
alter table pm.res_settings add column if not exists portal_defaults jsonb not null default '{}';
alter table pm.res_settings add column if not exists setup_completed_at timestamptz;
do $$ begin
  alter table pm.res_settings add constraint res_settings_1124_chk check (
    billing_method in ('MILESTONE','PROGRESS','DRAW','COST_PLUS','MIXED') and self_perform_mix in ('SELF_PERFORM','SUBCONTRACT','MIXED')
    and jsonb_typeof(payment_template) = 'array' and jsonb_typeof(selection_library) = 'array' and jsonb_typeof(portal_defaults) = 'object');
exception when duplicate_object then null; end $$;

-- R2. Builder job-type templates (RES-03) -------------------------------------------------------
create table if not exists pm.res_job_templates (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  key                      text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label                    text not null check (char_length(btrim(label)) between 1 and 120),
  description              text check (description is null or char_length(description) <= 1000),
  contract_type            text not null default 'FIXED_PRICE' check (contract_type in
                             ('FIXED_PRICE','COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS','DESIGN_AGREEMENT','PURCHASE_AGREEMENT')),
  schedule_template_key    text check (schedule_template_key is null or schedule_template_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  selection_list           jsonb not null default '[]' check (jsonb_typeof(selection_list) = 'array'),
  capitalize_to_inventory  boolean not null default false,
  deposit_pct              numeric(6,4) check (deposit_pct is null or (deposit_pct >= 0 and deposit_pct <= 1)),
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, key)
);

create table if not exists pm.res_job_setups (
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  template_id              uuid,
  template_key             text not null,
  gl_disposition           text not null default 'EXPENSE' check (gl_disposition in ('EXPENSE','CAPITALIZE_INVENTORY')),
  selections_created       int not null default 0,
  schedule_result          jsonb not null default '{}' check (jsonb_typeof(schedule_result) = 'object'),
  applied_by               text default pm.current_user_id(),
  applied_at               timestamptz not null default now(),
  primary key (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, template_id) references pm.res_job_templates (org_id, id) on delete set null (template_id) deferrable initially immediate
);

-- The five builder job types with their standard selection lists (categories × rooms). Idempotent.
create or replace function pm.res_seed_builder_templates(p_location uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); n int := 0; v_full jsonb; v_spec jsonb; v_reno jsonb; r record;
begin
  select coalesce(jsonb_agg(jsonb_build_object('category', c, 'title', t, 'room', rm) order by o), '[]') into v_full from (values
    (1,'Exterior','Siding and trim color','Exterior'), (2,'Exterior','Roofing shingle','Exterior'), (3,'Exterior','Front door','Exterior'), (4,'Exterior','Garage door','Exterior'),
    (5,'Exterior','Exterior light fixtures','Exterior'), (6,'Windows','Window style and grille','Whole house'), (7,'Flooring','Main level flooring','Main level'),
    (8,'Flooring','Bedroom carpet and pad','Bedrooms'), (9,'Flooring','Bathroom tile','Bathrooms'), (10,'Cabinets','Kitchen cabinets','Kitchen'),
    (11,'Cabinets','Bath vanities','Bathrooms'), (12,'Countertops','Kitchen countertops','Kitchen'), (13,'Countertops','Bath countertops','Bathrooms'),
    (14,'Tile','Kitchen backsplash','Kitchen'), (15,'Tile','Shower surround','Primary bath'), (16,'Plumbing','Kitchen sink and faucet','Kitchen'),
    (17,'Plumbing','Bath faucets and fixtures','Bathrooms'), (18,'Plumbing','Water heater','Mechanical'), (19,'Appliances','Appliance package','Kitchen'),
    (20,'Electrical','Lighting package','Whole house'), (21,'Electrical','Ceiling fans','Whole house'), (22,'Electrical','Low voltage and data','Whole house'),
    (23,'Paint','Interior paint colors','Whole house'), (24,'Trim','Interior doors and trim style','Whole house'), (25,'Hardware','Door hardware','Whole house'),
    (26,'Hardware','Cabinet hardware','Kitchen'), (27,'Fireplace','Fireplace surround','Living room'), (28,'Stairs','Stair rail and treads','Main level'),
    (29,'Mirrors','Bath mirrors and accessories','Bathrooms'), (30,'Closets','Closet systems','Bedrooms'), (31,'HVAC','Thermostat and zoning','Mechanical'),
    (32,'Landscape','Landscape package','Exterior')) v(o, c, t, rm);
  select coalesce(jsonb_agg(x), '[]') into v_spec from jsonb_array_elements(v_full) x
   where x ->> 'category' in ('Exterior','Flooring','Cabinets','Countertops','Plumbing','Appliances','Paint','Hardware');
  select coalesce(jsonb_agg(x), '[]') into v_reno from jsonb_array_elements(v_full) x
   where x ->> 'category' in ('Flooring','Cabinets','Countertops','Tile','Plumbing','Electrical','Paint','Trim','Hardware');
  for r in select * from (values
      ('custom_on_lot', 'Custom home on client lot', 'COST_PLUS_PCT', 'custom_home', v_full, false, 0.10),
      ('semi_custom_plan', 'Semi-custom from plan', 'FIXED_PRICE', 'custom_home', v_full, false, 0.10),
      ('spec_home', 'Spec home', 'FIXED_PRICE', 'custom_home', v_spec, true, null::numeric),
      ('production_lot', 'Production home on a community lot', 'PURCHASE_AGREEMENT', 'custom_home', v_spec, true, 0.05),
      ('major_renovation', 'Major renovation', 'FIXED_PRICE', null, v_reno, false, 0.25)) t(k, lbl, ct, sch, lst, cap, dep) loop
    insert into pm.res_job_templates (org_id, location_id, key, label, contract_type, schedule_template_key, selection_list, capitalize_to_inventory, deposit_pct)
    values (v_org, p_location, r.k, r.lbl, r.ct,
            case when r.sch is not null and exists (select 1 from pm.schedule_template_catalog c where c.key = r.sch) then r.sch end, r.lst, r.cap, r.dep)
    on conflict (org_id, location_id, key) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Apply a job type to a job: selections from its list (titles already there are skipped), the
-- schedule template when the job has no tasks yet, the GL disposition (Books: spec / production
-- capitalize to inventory — held as an account-map hand-off).
create or replace function pm.res_apply_job_template(p_job uuid, p_key text, p_start date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; t pm.res_job_templates%rowtype; s jsonb; n int := 0; v_sched jsonb := '{}'; v_sort int;
begin
  select * into j from pm._x_job(p_job);
  select * into t from pm.res_job_templates x where x.org_id = j.org_id and x.location_id = j.location_id and x.key = p_key and x.is_active;
  if t.id is null then raise exception 'PM_INVALID: no job type % at this company (seed the builder job types first)', p_key using errcode = '22023'; end if;
  select coalesce(max(sort), 0) into v_sort from pm.selections where org_id = j.org_id and job_id = p_job;
  for s in select x from jsonb_array_elements(t.selection_list) x loop
    continue when nullif(btrim(coalesce(s ->> 'title', '')), '') is null;
    if not exists (select 1 from pm.selections x where x.org_id = j.org_id and x.job_id = p_job and lower(x.title) = lower(btrim(s ->> 'title')) and x.status <> 'VOID') then
      v_sort := v_sort + 1;
      insert into pm.selections (org_id, job_id, category, title, room, sort, description)
      values (j.org_id, p_job, left(coalesce(nullif(btrim(s ->> 'category'), ''), 'General'), 80), left(btrim(s ->> 'title'), 200), left(s ->> 'room', 80), v_sort,
              'From the ' || t.label || ' job type');
      n := n + 1;
    end if;
  end loop;
  if t.schedule_template_key is not null and not exists (select 1 from pm.tasks x where x.org_id = j.org_id and x.job_id = p_job) then
    begin
      perform pm._wc_require_job('projects.jobs', 'edit', p_job);
      v_sched := pm.apply_schedule_template(p_job, t.schedule_template_key, coalesce(p_start, current_date));
    exception when others then
      v_sched := jsonb_build_object('error', sqlerrm);
    end;
  end if;
  insert into pm.res_job_setups (org_id, job_id, template_id, template_key, gl_disposition, selections_created, schedule_result)
  values (j.org_id, p_job, t.id, t.key, case when t.capitalize_to_inventory then 'CAPITALIZE_INVENTORY' else 'EXPENSE' end, n, coalesce(v_sched, '{}'))
  on conflict (org_id, job_id) do update set template_id = excluded.template_id, template_key = excluded.template_key, gl_disposition = excluded.gl_disposition,
     selections_created = pm.res_job_setups.selections_created + excluded.selections_created, schedule_result = excluded.schedule_result,
     applied_by = pm.current_user_id(), applied_at = now();
  if t.capitalize_to_inventory then
    perform pm._wc_books_request(j.org_id, j.location_id, p_job, 'ACCOUNT_MAP', 'res_job_setups', p_job,
      jsonb_build_object('job_id', p_job, 'gl_disposition', 'CAPITALIZE', 'inventory_kind', case when t.key = 'spec_home' then 'SPEC_HOME' else 'PRODUCTION_HOME' end));
  end if;
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'job.template_applied', 'res_job_setups', p_job, format('Job type applied: %s', t.label),
    jsonb_build_object('selections', n, 'capitalize', t.capitalize_to_inventory));
  return jsonb_build_object('template', t.key, 'selections_created', n, 'schedule', v_sched, 'gl_disposition', case when t.capitalize_to_inventory then 'CAPITALIZE_INVENTORY' else 'EXPENSE' end);
end $$;

-- R3. In-home measure and site capture (RES-11) -------------------------------------------------
create table if not exists pm.res_site_captures (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  appointment_id       uuid,
  status               text not null default 'DRAFT' check (status in ('DRAFT','FINAL')),
  rooms                jsonb not null default '[]' check (jsonb_typeof(rooms) = 'array'),       -- [{name, length_in, width_in, height_in, notes}]
  utilities            jsonb not null default '{}' check (jsonb_typeof(utilities) = 'object'),   -- {water_shutoff, gas_shutoff, panel_location, ...}
  conditions           jsonb not null default '{}' check (jsonb_typeof(conditions) = 'object'),  -- {year_built, panel_amps, water_heater_age, asbestos_risk, ...}
  photo_document_ids   uuid[] not null default '{}' check (cardinality(photo_document_ids) <= 200),
  video_document_ids   uuid[] not null default '{}' check (cardinality(video_document_ids) <= 20),
  lidar_document_id    uuid references public.documents(id) on delete set null,
  voice_document_id    uuid references public.documents(id) on delete set null,
  transcript           text check (transcript is null or char_length(transcript) <= 20000),
  measure_id           uuid,
  captured_by          text default pm.current_user_id(),
  finalized_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, appointment_id) references pm.wc_appointments (org_id, id) on delete set null (appointment_id) deferrable initially immediate
);
create index if not exists pm_res_site_captures_job_idx on pm.res_site_captures (org_id, job_id, created_at desc);

create or replace function pm.res_save_site_capture(p_job uuid, p_capture uuid default null, p_data jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; d jsonb := coalesce(p_data, '{}'); v uuid; r jsonb;
begin
  select * into j from pm._x_job(p_job);
  -- every attached document is in this org and the caller's upload or already on this job (L4)
  for r in select to_jsonb(x) from (select jsonb_array_elements_text(coalesce(d -> 'photo_document_ids', '[]')) union all select jsonb_array_elements_text(coalesce(d -> 'video_document_ids', '[]'))
                                    union all select d ->> 'lidar_document_id' union all select d ->> 'voice_document_id') s(x) where x is not null loop
    if pm.access_try_uuid(r #>> '{}') is null then raise exception 'PM_INVALID: a document id is not valid' using errcode = '22023'; end if;
    perform pm._wc_check_document(j.org_id, p_job, pm.access_try_uuid(r #>> '{}'));
  end loop;
  if d ? 'rooms' then
    if jsonb_typeof(d -> 'rooms') <> 'array' or jsonb_array_length(d -> 'rooms') > 100 then raise exception 'PM_INVALID: rooms must be a list (up to 100)' using errcode = '22023'; end if;
    for r in select x from jsonb_array_elements(d -> 'rooms') x loop
      if nullif(btrim(coalesce(r ->> 'name', '')), '') is null then raise exception 'PM_INVALID: every room needs a name' using errcode = '22023'; end if;
      if coalesce(pm._x_try_num(r ->> 'length_in'), 0) < 0 or coalesce(pm._x_try_num(r ->> 'width_in'), 0) < 0 then raise exception 'PM_INVALID: dimensions cannot be negative' using errcode = '22023'; end if;
    end loop;
  end if;
  if p_capture is null then
    insert into pm.res_site_captures (org_id, job_id, appointment_id, rooms, utilities, conditions, photo_document_ids, video_document_ids, lidar_document_id,
                                      voice_document_id, transcript)
    values (j.org_id, p_job, pm.access_try_uuid(d ->> 'appointment_id'), coalesce(d -> 'rooms', '[]'), coalesce(d -> 'utilities', '{}'), coalesce(d -> 'conditions', '{}'),
            coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'photo_document_ids') x), '{}'),
            coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'video_document_ids') x), '{}'),
            pm.access_try_uuid(d ->> 'lidar_document_id'), pm.access_try_uuid(d ->> 'voice_document_id'), left(d ->> 'transcript', 20000))
    returning id into v;
  else
    update pm.res_site_captures set
      rooms = case when d ? 'rooms' then d -> 'rooms' else rooms end,
      utilities = case when d ? 'utilities' then d -> 'utilities' else utilities end,
      conditions = case when d ? 'conditions' then d -> 'conditions' else conditions end,
      photo_document_ids = case when d ? 'photo_document_ids' then coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'photo_document_ids') x), '{}') else photo_document_ids end,
      video_document_ids = case when d ? 'video_document_ids' then coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'video_document_ids') x), '{}') else video_document_ids end,
      lidar_document_id = case when d ? 'lidar_document_id' then pm.access_try_uuid(d ->> 'lidar_document_id') else lidar_document_id end,
      voice_document_id = case when d ? 'voice_document_id' then pm.access_try_uuid(d ->> 'voice_document_id') else voice_document_id end,
      transcript = case when d ? 'transcript' then left(d ->> 'transcript', 20000) else transcript end,
      updated_at = now()
    where org_id = j.org_id and id = p_capture and job_id = p_job and status = 'DRAFT'
    returning id into v;
    if v is null then raise exception 'PM_INVALID: that capture is final or not on this job' using errcode = '22023'; end if;
  end if;
  return v;
end $$;

-- Final: rooms become a DRAFT measure (rooms × floor area), the home profile picks up the year
-- built and hazards, and a pre-1978 home gets its RRP record (EPA renovation rule).
create or replace function pm.res_finalize_site_capture(p_capture uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.res_site_captures%rowtype; v_measure uuid; v_ver int; r jsonb; n int := 0; v_year int; v_sf numeric; v_rrp boolean := false;
begin
  select * into c from pm.res_site_captures x where x.id = p_capture and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: capture not found' using errcode = '42501'; end if;
  if c.status = 'FINAL' then raise exception 'PM_INVALID: this capture is already final' using errcode = '22023'; end if;
  if jsonb_array_length(c.rooms) > 0 then
    select coalesce(max(version), 0) + 1 into v_ver from pm.measures where org_id = c.org_id and job_id = c.job_id;
    insert into pm.measures (org_id, job_id, version, source, source_ref, status, notes)
    values (c.org_id, c.job_id, v_ver, 'MANUAL', 'site_capture:' || c.id::text, 'DRAFT', 'From the in-home site capture')
    returning id into v_measure;
    for r in select x from jsonb_array_elements(c.rooms) x loop
      v_sf := round(coalesce(pm._x_try_num(r ->> 'length_in'), 0) * coalesce(pm._x_try_num(r ->> 'width_in'), 0) / 144.0, 2);
      insert into pm.measure_areas (org_id, measure_id, job_id, room_name, area_kind, length_ft, width_ft, sqft)
      values (c.org_id, v_measure, c.job_id, left(btrim(r ->> 'name'), 120), 'FLOOR',
              nullif(round(coalesce(pm._x_try_num(r ->> 'length_in'), 0) / 12.0, 2), 0), nullif(round(coalesce(pm._x_try_num(r ->> 'width_in'), 0) / 12.0, 2), 0), v_sf);
      n := n + 1;
    end loop;
  end if;
  v_year := pm._x_try_num(c.conditions ->> 'year_built')::int;
  insert into pm.res_home_profiles (org_id, job_id, year_built, asbestos_suspect, mold_suspect)
  values (c.org_id, c.job_id, v_year, coalesce(pm._x_try_bool(c.conditions ->> 'asbestos_risk'), false), coalesce(pm._x_try_bool(c.conditions ->> 'mold_risk'), false))
  on conflict (org_id, job_id) do update set year_built = coalesce(excluded.year_built, pm.res_home_profiles.year_built),
     asbestos_suspect = pm.res_home_profiles.asbestos_suspect or excluded.asbestos_suspect, mold_suspect = pm.res_home_profiles.mold_suspect or excluded.mold_suspect;
  if v_year is not null and v_year < 1978 then
    insert into pm.res_rrp_records (org_id, job_id, required) values (c.org_id, c.job_id, true) on conflict (org_id, job_id) do nothing;
    v_rrp := true;
  end if;
  update pm.res_site_captures set status = 'FINAL', finalized_at = now(), measure_id = v_measure, updated_at = now() where id = c.id;
  return jsonb_build_object('capture_id', c.id, 'measure_id', v_measure, 'rooms', n, 'rrp_required', v_rrp);
end $$;

-- R4. K&B design-software import (RES-23) --------------------------------------------------------
create table if not exists pm.res_kb_imports (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  proposal_id      uuid not null,
  source           text not null check (source in ('TWENTY_TWENTY','CABINET_VISION','PROKITCHEN','CSV')),
  file_name        text check (file_name is null or char_length(file_name) <= 255),
  room             text check (room is null or char_length(room) <= 80),
  status           text not null default 'STAGED' check (status in ('STAGED','APPLIED','DISCARDED')),
  line_count       int not null default 0,
  matched_count    int not null default 0,
  list_total_cents bigint not null default 0,
  applied_lines    int not null default 0,
  applied_at       timestamptz,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, proposal_id) references pm.res_proposals (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_kb_import_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  import_id         uuid not null,
  line_no           int not null check (line_no >= 1),
  sku               text not null check (char_length(btrim(sku)) between 1 and 80),
  description       text not null default '' check (char_length(description) <= 500),
  qty               numeric(14,4) not null default 1 check (qty > 0),
  uom               text not null default 'EA' check (char_length(uom) between 1 and 12),
  width_in          numeric(8,2),
  height_in         numeric(8,2),
  depth_in          numeric(8,2),
  finish            text check (finish is null or char_length(finish) <= 120),
  room              text check (room is null or char_length(room) <= 80),
  list_price_cents  bigint check (list_price_cents is null or list_price_cents >= 0),
  unit_cost_cents   bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  catalog_item_id   uuid,
  match_kind        text not null default 'NONE' check (match_kind in ('MAPPED','EXACT','NONE','SKIPPED')),
  proposal_line_id  uuid,
  unique (org_id, id),
  unique (org_id, import_id, line_no),
  foreign key (org_id, import_id) references pm.res_kb_imports (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, catalog_item_id) references pm.res_catalog_items (org_id, id) on delete set null (catalog_item_id) deferrable initially immediate
);

create table if not exists pm.res_kb_sku_map (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  source           text not null check (source in ('TWENTY_TWENTY','CABINET_VISION','PROKITCHEN','CSV')),
  vendor_sku       text not null check (char_length(btrim(vendor_sku)) between 1 and 80),
  catalog_item_id  uuid not null,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, source, vendor_sku),
  foreign key (org_id, catalog_item_id) references pm.res_catalog_items (org_id, id) on delete cascade deferrable initially immediate
);

-- Stage a parsed cabinet list (lib/residential/kb-import.ts) against a DRAFT proposal: SKUs map
-- through the learned map first, then the catalog's supplier SKU / code.
create or replace function pm.res_stage_kb_import(p_proposal uuid, p_source text, p_file_name text, p_lines jsonb, p_room text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_id uuid; l jsonb; i int := 0; v_cat uuid; v_kind text; v_sku text; m int := 0; v_list bigint := 0;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id();
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal not found' using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_RES_PROPOSAL_LOCKED: revise the proposal to import into it' using errcode = '55000'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: the file has no cabinet lines' using errcode = '22023'; end if;
  if jsonb_array_length(p_lines) > 2000 then raise exception 'PM_INVALID: more than 2,000 lines; split the file' using errcode = '22023'; end if;
  insert into pm.res_kb_imports (org_id, job_id, proposal_id, source, file_name, room)
  values (p.org_id, p.job_id, p.id, p_source, left(p_file_name, 255), left(p_room, 80)) returning id into v_id;
  for l in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    v_sku := left(btrim(coalesce(l ->> 'sku', '')), 80);
    if v_sku = '' then raise exception 'PM_INVALID: line % has no SKU', i using errcode = '22023'; end if;
    v_cat := null; v_kind := 'NONE';
    select mp.catalog_item_id into v_cat from pm.res_kb_sku_map mp
     where mp.org_id = p.org_id and mp.location_id = p.location_id and mp.source = p_source and mp.vendor_sku = v_sku;
    if v_cat is not null then v_kind := 'MAPPED';
    else
      select c.id into v_cat from pm.res_catalog_items c
       where c.org_id = p.org_id and c.location_id = p.location_id and c.is_active and (upper(c.supplier_sku) = upper(v_sku) or upper(c.code) = upper(v_sku))
       order by (upper(c.supplier_sku) = upper(v_sku)) desc nulls last limit 1;
      if v_cat is not null then v_kind := 'EXACT'; end if;
    end if;
    if v_cat is not null then m := m + 1; end if;
    insert into pm.res_kb_import_lines (org_id, import_id, line_no, sku, description, qty, uom, width_in, height_in, depth_in, finish, room,
                                        list_price_cents, unit_cost_cents, catalog_item_id, match_kind)
    values (p.org_id, v_id, i, v_sku, left(coalesce(l ->> 'description', ''), 500), greatest(coalesce(pm._x_try_num(l ->> 'qty'), 1), 0.0001),
            left(coalesce(nullif(l ->> 'uom', ''), 'EA'), 12), pm._x_try_num(l ->> 'width_in'), pm._x_try_num(l ->> 'height_in'), pm._x_try_num(l ->> 'depth_in'),
            left(l ->> 'finish', 120), left(coalesce(l ->> 'room', p_room), 80), pm._x_try_bigint(l ->> 'list_price_cents'), pm._x_try_bigint(l ->> 'unit_cost_cents'),
            v_cat, v_kind);
    v_list := v_list + pm.res_round(greatest(coalesce(pm._x_try_num(l ->> 'qty'), 1), 0) * coalesce(pm._x_try_bigint(l ->> 'list_price_cents'), 0));
  end loop;
  update pm.res_kb_imports set line_count = i, matched_count = m, list_total_cents = v_list where id = v_id;
  return jsonb_build_object('import_id', v_id, 'lines', i, 'matched', m, 'unmatched', i - m);
end $$;

-- Map one unknown SKU to a catalog item (optionally remember it for the next file).
create or replace function pm.res_map_kb_line(p_line uuid, p_catalog_item uuid, p_remember boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.res_kb_import_lines%rowtype; im pm.res_kb_imports%rowtype; v_loc uuid;
begin
  select * into l from pm.res_kb_import_lines x where x.id = p_line and x.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: import line not found' using errcode = '42501'; end if;
  select * into im from pm.res_kb_imports x where x.org_id = l.org_id and x.id = l.import_id;
  if im.status <> 'STAGED' then raise exception 'PM_INVALID: this import is %', lower(im.status) using errcode = '22023'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = im.job_id;
  if p_catalog_item is null then
    update pm.res_kb_import_lines set catalog_item_id = null, match_kind = 'SKIPPED' where id = l.id;
  else
    if not exists (select 1 from pm.res_catalog_items c where c.org_id = l.org_id and c.id = p_catalog_item and c.location_id = v_loc) then
      raise exception 'PM_INVALID: that item is not in this company''s catalog' using errcode = '22023';
    end if;
    update pm.res_kb_import_lines set catalog_item_id = p_catalog_item, match_kind = 'MAPPED' where id = l.id;
    if coalesce(p_remember, true) then
      insert into pm.res_kb_sku_map (org_id, location_id, source, vendor_sku, catalog_item_id) values (l.org_id, v_loc, im.source, l.sku, p_catalog_item)
      on conflict (org_id, location_id, source, vendor_sku) do update set catalog_item_id = excluded.catalog_item_id;
    end if;
  end if;
  update pm.res_kb_imports set matched_count = (select count(*) from pm.res_kb_import_lines x where x.org_id = l.org_id and x.import_id = im.id and x.catalog_item_id is not null)
   where id = im.id;
  return jsonb_build_object('line_id', l.id, 'catalog_item_id', p_catalog_item);
end $$;

-- Apply: every line not skipped becomes a proposal line (catalog-priced when mapped; else at the
-- file's cost with the markup given). Cabinet order totals land in the proposal / estimate.
create or replace function pm.res_apply_kb_import(p_import uuid, p_option uuid default null, p_markup numeric default null, p_cost_code uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare im pm.res_kb_imports%rowtype; l record; v_line uuid; n int := 0; v_sort int; v_unmatched int;
begin
  select * into im from pm.res_kb_imports x where x.id = p_import and x.org_id = public.get_org_id() for update;
  if im.id is null then raise exception 'PM_FORBIDDEN: import not found' using errcode = '42501'; end if;
  if im.status <> 'STAGED' then raise exception 'PM_INVALID: this import is %', lower(im.status) using errcode = '22023'; end if;
  select count(*) into v_unmatched from pm.res_kb_import_lines x where x.org_id = im.org_id and x.import_id = im.id and x.match_kind = 'NONE' and x.unit_cost_cents is null;
  if v_unmatched > 0 then
    raise exception 'PM_RES_KB_UNMAPPED: % line(s) have no catalog item and no cost in the file — map them or skip them', v_unmatched using errcode = '22023';
  end if;
  if p_markup is not null and (p_markup < 0 or p_markup > 10) then raise exception 'PM_INVALID: markup between 0 and 1000%%' using errcode = '22023'; end if;
  select coalesce(max(sort), 0) into v_sort from pm.res_proposal_lines where org_id = im.org_id and proposal_id = im.proposal_id;
  for l in select * from pm.res_kb_import_lines x where x.org_id = im.org_id and x.import_id = im.id and x.match_kind <> 'SKIPPED' order by x.line_no loop
    v_sort := v_sort + 1;
    insert into pm.res_proposal_lines (org_id, proposal_id, option_id, catalog_item_id, cost_code_id, room, description, qty, uom, unit_cost_cents, markup_pct, sort, ext)
    values (im.org_id, im.proposal_id, p_option, l.catalog_item_id, p_cost_code, coalesce(l.room, im.room),
            left(concat_ws(' · ', nullif(l.description, ''), l.sku, l.finish, case when l.width_in is not null then l.width_in::text || '"W' end), 500),
            l.qty, case when l.catalog_item_id is null then l.uom else 'EA' end,
            case when l.catalog_item_id is null then coalesce(l.unit_cost_cents, 0) else 0 end,
            case when l.catalog_item_id is null then coalesce(p_markup, (select s.default_markup_pct from pm.res_settings s join core.jobs j on j.location_id = s.location_id and j.org_id = s.org_id where j.id = im.job_id)) else p_markup end,
            v_sort, jsonb_build_object('kb_import_id', im.id, 'kb_sku', l.sku, 'list_price_cents', l.list_price_cents))
    returning id into v_line;
    update pm.res_kb_import_lines set proposal_line_id = v_line where id = l.id;
    n := n + 1;
  end loop;
  update pm.res_kb_imports set status = 'APPLIED', applied_lines = n, applied_at = now() where id = im.id;
  return jsonb_build_object('import_id', im.id, 'lines_added', n, 'proposal_id', im.proposal_id);
end $$;

create or replace function pm.res_discard_kb_import(p_import uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.res_kb_imports set status = 'DISCARDED' where id = p_import and org_id = public.get_org_id() and status = 'STAGED' returning id into v;
  if v is null then raise exception 'PM_INVALID: only a staged import can be discarded' using errcode = '22023'; end if;
  return v;
end $$;

-- R5. Multi-job crew and trade capacity (RES-49) -------------------------------------------------
create table if not exists pm.res_resource_capacity (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  resource_kind      text not null check (resource_kind in ('CREW','VENDOR','EMPLOYEE')),
  resource_id        uuid not null,
  label              text,
  days_per_week      int not null default 5 check (days_per_week between 1 and 7),
  max_jobs_per_day   int not null default 1 check (max_jobs_per_day between 1 and 20),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, resource_kind, resource_id)
);

-- Per resource per week: task-days booked across every open job at the company vs capacity, with the
-- days two jobs claim the same resource (double-booked) and weeks over capacity (overload).
create or replace function pm.res_crew_capacity(p_location uuid, p_from date default null, p_weeks int default 8)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v_from date := date_trunc('week', coalesce(p_from, current_date))::date; v_to date;
  v_rows jsonb; v_double jsonb;
begin
  v_to := v_from + greatest(least(coalesce(p_weeks, 8), 26), 1) * 7 - 1;
  with t as (
    select tk.id, tk.job_id, tk.title, coalesce(tk.actual_start, tk.early_start, tk.start_on) as s, coalesce(tk.actual_finish, tk.early_finish, tk.due_on, tk.early_start, tk.start_on) as f,
           case when tk.assigned_crew_id is not null then 'CREW' when tk.assigned_vendor_id is not null then 'VENDOR' when tk.assignee_employee_id is not null then 'EMPLOYEE' end as rk,
           coalesce(tk.assigned_crew_id, tk.assigned_vendor_id, tk.assignee_employee_id) as rid
      from pm.tasks tk join core.jobs j on j.org_id = tk.org_id and j.id = tk.job_id
     where tk.org_id = v_org and j.location_id = p_location and tk.status not in ('DONE','CANCELLED') and not tk.is_summary
       and coalesce(tk.assigned_crew_id, tk.assigned_vendor_id, tk.assignee_employee_id) is not null
       and coalesce(tk.actual_start, tk.early_start, tk.start_on) is not null
  ), d as (
    select t.rk, t.rid, t.job_id, gs::date as day from t
     cross join lateral generate_series(greatest(t.s, v_from), least(greatest(t.f, t.s), v_to), interval '1 day') gs
     where extract(isodow from gs) <= 6
  ), daily as (
    select rk, rid, day, count(distinct job_id) as jobs from d group by 1, 2, 3
  ), wk as (
    select dl.rk, dl.rid, date_trunc('week', dl.day)::date as week, count(*) as busy_days, max(dl.jobs) as max_jobs,
           count(*) filter (where dl.jobs > coalesce(c.max_jobs_per_day, 1)) as double_days, coalesce(c.days_per_week, 5) as cap_days
      from daily dl left join pm.res_resource_capacity c on c.org_id = v_org and c.location_id = p_location and c.resource_kind = dl.rk and c.resource_id = dl.rid
     group by 1, 2, 3, c.days_per_week
  )
  select coalesce(jsonb_agg(jsonb_build_object('resource_kind', w.rk, 'resource_id', w.rid,
            'resource', coalesce((select c.label from pm.res_resource_capacity c where c.org_id = v_org and c.location_id = p_location and c.resource_kind = w.rk and c.resource_id = w.rid),
                                 case w.rk when 'VENDOR' then (select v.name from core.vendors v where v.id = w.rid)
                                           when 'EMPLOYEE' then (select concat_ws(' ', e.first_name, e.last_name) from core.employees e where e.id = w.rid)
                                           else (select cr.name from pm.crews cr where cr.id = w.rid) end, w.rid::text),
            'week', w.week, 'busy_days', w.busy_days, 'capacity_days', w.cap_days, 'max_jobs_in_a_day', w.max_jobs,
            'double_booked_days', w.double_days, 'overloaded', w.busy_days > w.cap_days or w.double_days > 0)
          order by w.rk, w.rid, w.week), '[]') into v_rows
    from wk w;
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows,
    'flags', (select count(*) from jsonb_array_elements(v_rows) x where (x ->> 'overloaded')::boolean));
end $$;

-- R6. Client-visible schedule filter (RES-52) ---------------------------------------------------
create table if not exists pm.res_client_date_changes (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  task_id          uuid not null,
  task_title       text not null,
  old_start        date,
  new_start        date,
  old_finish       date,
  new_finish       date,
  shift_days       int not null default 0,
  reason_code      text check (reason_code is null or reason_code in ('WEATHER','INSPECTION','MATERIAL','SELECTION','TRADE','CHANGE_ORDER','HOMEOWNER','OTHER')),
  explanation      text check (explanation is null or char_length(explanation) <= 2000),
  status           text not null default 'PENDING' check (status in ('PENDING','POSTED','DISMISSED')),
  portal_message_id uuid,
  created_at       timestamptz not null default now(),
  posted_at        timestamptz,
  posted_by        text,
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_res_client_date_changes_idx on pm.res_client_date_changes (org_id, job_id, status, created_at desc);

-- A client-visible task moving by a day or more queues a homeowner explanation (one pending row per task).
create or replace function pm.tg_res_client_date_change() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_os date := coalesce(old.actual_start, old.early_start, old.start_on); v_ns date := coalesce(new.actual_start, new.early_start, new.start_on);
  v_of date := coalesce(old.actual_finish, old.early_finish, old.due_on); v_nf date := coalesce(new.actual_finish, new.early_finish, new.due_on); v_shift int;
begin
  if v_os is null and v_of is null then return null; end if;
  v_shift := coalesce(v_nf - v_of, v_ns - v_os, 0);
  if v_os is not distinct from v_ns and v_of is not distinct from v_nf then return null; end if;
  if abs(coalesce(v_ns - v_os, 0)) < 1 and abs(coalesce(v_nf - v_of, 0)) < 1 then return null; end if;
  update pm.res_client_date_changes set new_start = v_ns, new_finish = v_nf, shift_days = coalesce(v_nf - old_finish, v_ns - old_start, v_shift)
   where org_id = new.org_id and task_id = new.id and status = 'PENDING';
  if not found then
    insert into pm.res_client_date_changes (org_id, job_id, task_id, task_title, old_start, new_start, old_finish, new_finish, shift_days)
    values (new.org_id, new.job_id, new.id, new.title, v_os, v_ns, v_of, v_nf, v_shift);
  end if;
  return null;
end $$;
drop trigger if exists trg_res_client_date_change on pm.tasks;
create trigger trg_res_client_date_change after update of start_on, due_on, early_start, early_finish, actual_start, actual_finish on pm.tasks
  for each row when (new.client_visible and old.client_visible and new.status <> 'CANCELLED')
  execute function pm.tg_res_client_date_change();

-- The homeowner sees milestones and the items they care about, not 300 tasks: milestones, payment
-- milestones, cabinet / counter chain steps, inspections, and the company's keywords.
create or replace function pm.res_apply_client_schedule_filter(p_job uuid, p_keywords text[] default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_kw text[] := coalesce(p_keywords, array['delivered','delivery','template','install','inspection','walkthrough','demo','final','cabinet','countertop','start','complete']);
  n_on int; n_off int;
begin
  select * into j from pm._x_job(p_job);
  with pick as (
    select tk.id, (tk.is_milestone
                   or exists (select 1 from pm.res_chain_steps cs where cs.org_id = tk.org_id and cs.task_id = tk.id and cs.homeowner_visible)
                   or exists (select 1 from unnest(v_kw) k where tk.title ilike '%' || k || '%')) as vis
      from pm.tasks tk where tk.org_id = j.org_id and tk.job_id = p_job and tk.status <> 'CANCELLED' and not tk.is_summary
  )
  update pm.tasks t set client_visible = p.vis, updated_at = now() from pick p
   where t.id = p.id and t.client_visible is distinct from p.vis;
  select count(*) filter (where client_visible), count(*) filter (where not client_visible) into n_on, n_off
    from pm.tasks where org_id = j.org_id and job_id = p_job and status <> 'CANCELLED';
  return jsonb_build_object('visible', n_on, 'hidden', n_off);
end $$;

-- Rules-only explanation (until AI is on) → posted to the customer's portal thread.
create or replace function pm.res_post_date_change(p_change uuid, p_reason text, p_explanation text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.res_client_date_changes%rowtype; v_cust uuid; v_text text; v_msg jsonb;
begin
  select * into c from pm.res_client_date_changes x where x.id = p_change and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: date change not found' using errcode = '42501'; end if;
  if c.status <> 'PENDING' then raise exception 'PM_INVALID: already %', lower(c.status) using errcode = '22023'; end if;
  if p_reason not in ('WEATHER','INSPECTION','MATERIAL','SELECTION','TRADE','CHANGE_ORDER','HOMEOWNER','OTHER') then raise exception 'PM_INVALID: reason' using errcode = '22023'; end if;
  v_text := coalesce(nullif(btrim(p_explanation), ''), format('%s moved %s %s day(s)%s: %s.', c.task_title,
              case when c.shift_days >= 0 then 'out' else 'up' end, abs(c.shift_days),
              case when c.new_finish is not null then ' to ' || to_char(c.new_finish, 'Dy Mon DD') when c.new_start is not null then ' to ' || to_char(c.new_start, 'Dy Mon DD') else '' end,
              case p_reason when 'WEATHER' then 'weather kept the crew off the site' when 'INSPECTION' then 'we are waiting on the city inspection'
                            when 'MATERIAL' then 'material is arriving later than promised' when 'SELECTION' then 'we are waiting on a selection decision'
                            when 'TRADE' then 'a trade partner had to reschedule' when 'CHANGE_ORDER' then 'the change order added work'
                            when 'HOMEOWNER' then 'you asked us to adjust the date' else 'the schedule needed adjusting' end));
  select j.customer_id into v_cust from core.jobs j where j.id = c.job_id;
  perform pm._wc_require_job('projects.jobs', 'edit', c.job_id);
  v_msg := pm.portal_post_message(c.job_id, 'customer', v_cust, left(v_text, 2000), null);
  update pm.res_client_date_changes set status = 'POSTED', reason_code = p_reason, explanation = left(v_text, 2000), portal_message_id = pm.access_try_uuid(v_msg ->> 'id'),
         posted_at = now(), posted_by = pm.current_user_id() where id = c.id;
  return jsonb_build_object('id', c.id, 'explanation', v_text, 'notified', v_msg -> 'notified');
end $$;

create or replace function pm.res_dismiss_date_change(p_change uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.res_client_date_changes set status = 'DISMISSED' where id = p_change and org_id = public.get_org_id() and status = 'PENDING' returning id into v;
  if v is null then raise exception 'PM_INVALID: nothing pending to dismiss' using errcode = '22023'; end if;
  return v;
end $$;

-- R7. Receipt and card capture (RES-62) ---------------------------------------------------------
create table if not exists pm.res_receipt_captures (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  cost_code_id      uuid,
  document_id       uuid references public.documents(id) on delete set null,
  vendor_id         uuid references core.vendors(id),
  vendor_name       text check (vendor_name is null or char_length(vendor_name) <= 200),
  amount_cents      bigint check (amount_cents is null or amount_cents >= 0),
  tax_cents         bigint check (tax_cents is null or tax_cents >= 0),
  purchased_on      date,
  card_last4        text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  books_txn_ref     text check (books_txn_ref is null or char_length(books_txn_ref) <= 120),
  memo              text check (memo is null or char_length(memo) <= 500),
  status            text not null default 'CAPTURED' check (status in ('CAPTURED','CODED','SENT','VOID')),
  captured_by       text default pm.current_user_id(),
  coded_by          text,
  coded_at          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_receipts_job_idx on pm.res_receipt_captures (org_id, job_id, status, created_at desc);
-- offline capture: the phone's own id for the capture (lasting dedupe per org) and the photo
-- command the receipt image was sent under (the photo may land after the receipt)
alter table pm.res_receipt_captures add column if not exists client_id text check (client_id is null or char_length(client_id) between 8 and 80);
alter table pm.res_receipt_captures add column if not exists photo_command_id uuid;
alter table pm.res_receipt_captures add column if not exists suggested_cost_code_id uuid;
drop index if exists pm.ux_res_receipts_client;
create unique index if not exists ux_res_receipts_client_user on pm.res_receipt_captures (org_id, captured_by, client_id) where client_id is not null;

-- The document a phone photo command produced (lib field photos: <org>/projects/field/<job>/<command>.<ext>).
drop function if exists pm._res_photo_document(uuid, uuid, uuid);
create or replace function pm._res_photo_document(p_org uuid, p_job uuid, p_command uuid, p_user text)
returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select d.id from public.documents d
   where p_command is not null and d.org_id = p_org and d.uploaded_by_user = p_user
     and lower(d.storage_path) like lower(p_org::text || '/projects/field/' || p_job::text || '/' || p_command::text) || '.%'
   order by d.created_at limit 1
$$;

-- Anyone on the job snaps the receipt (field, offline-queued by the phone); a job + cost code makes it CODED.
drop function if exists pm.res_capture_receipt(uuid, uuid, jsonb);
create or replace function pm.res_capture_receipt(p_job uuid, p_document uuid, p_fields jsonb default '{}', p_client_id text default null, p_photo_command uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; f jsonb := coalesce(p_fields, '{}'); v uuid; v_cc uuid := pm.access_try_uuid(f ->> 'cost_code_id'); v_doc uuid := p_document;
  v_client text := nullif(btrim(coalesce(p_client_id, '')), ''); rc pm.res_receipt_captures%rowtype; v_uid text := pm.current_user_id(); v_code boolean;
begin
  select * into j from pm._x_job(p_job);
  if v_client is not null and char_length(v_client) not between 8 and 80 then raise exception 'PM_INVALID: the capture id must be 8 to 80 characters' using errcode = '22023'; end if;
  if v_doc is null then v_doc := pm._res_photo_document(j.org_id, p_job, p_photo_command, v_uid); end if;
  -- security review M5: the photo is the caller's own upload, or a document already on this job
  if v_doc is not null and not exists (select 1 from public.documents d where d.id = v_doc and d.org_id = j.org_id
                                         and (d.uploaded_by_user = v_uid
                                              or exists (select 1 from pm.document_links dl where dl.org_id = j.org_id and dl.document_id = d.id and dl.job_id = p_job))) then
    raise exception 'PM_INVALID: that receipt photo was not found' using errcode = '22023';
  end if;
  if v_doc is null and p_photo_command is null then raise exception 'PM_INVALID: attach the receipt photo' using errcode = '22023'; end if;
  -- a re-send of the caller's own capture returns the first receipt (and picks up the photo if it has landed since)
  if v_client is not null then
    select * into rc from pm.res_receipt_captures x where x.org_id = j.org_id and x.captured_by = v_uid and x.client_id = v_client;
    if rc.id is not null then
      if rc.job_id <> p_job then raise exception 'PM_INVALID: that capture id was already used on another job' using errcode = '22023'; end if;
      if rc.document_id is null and v_doc is not null then
        update pm.res_receipt_captures set document_id = v_doc, updated_at = now() where id = rc.id;
      end if;
      return jsonb_build_object('receipt_id', rc.id, 'status', rc.status, 'photo_pending', coalesce(rc.document_id, v_doc) is null, 'replayed', true);
    end if;
  end if;
  if v_cc is not null and not exists (select 1 from pm.cost_codes c where c.org_id = j.org_id and c.id = v_cc and c.location_id = j.location_id and (c.job_id is null or c.job_id = p_job)) then
    raise exception 'PM_INVALID: that cost code is not on this job' using errcode = '22023';
  end if;
  -- coding (and the Books hand-off) needs the office's capability; a crew member's cost code is a suggestion
  v_code := v_cc is not null and (pm.access_can_job('projects.financials', 'edit', p_job) or pm.access_can_job('projects.commitments', 'edit', p_job));
  insert into pm.res_receipt_captures (org_id, job_id, cost_code_id, suggested_cost_code_id, document_id, vendor_name, amount_cents, tax_cents, purchased_on, card_last4, memo, status,
                                       coded_by, coded_at, client_id, photo_command_id)
  values (j.org_id, p_job, case when v_code then v_cc end, case when v_code then null else v_cc end, v_doc, left(f ->> 'vendor_name', 200), pm._x_try_bigint(f ->> 'amount_cents'),
          pm._x_try_bigint(f ->> 'tax_cents'), pm._x_try_date(f ->> 'purchased_on'), nullif(f ->> 'card_last4', ''), left(f ->> 'memo', 500),
          case when v_code then 'CODED' else 'CAPTURED' end, case when v_code then v_uid end, case when v_code then now() end,
          v_client, p_photo_command)
  on conflict (org_id, captured_by, client_id) where client_id is not null do nothing
  returning id into v;
  if v is null then   -- lost a race with the same capture id: return the winner
    select * into rc from pm.res_receipt_captures x where x.org_id = j.org_id and x.captured_by = v_uid and x.client_id = v_client;
    return jsonb_build_object('receipt_id', rc.id, 'status', rc.status, 'photo_pending', rc.document_id is null, 'replayed', true);
  end if;
  if v_code then
    perform pm._wc_books_request(j.org_id, j.location_id, p_job, 'RECEIPT_CODING', 'res_receipt_captures', v,
      jsonb_build_object('receipt_id', v, 'job_id', p_job, 'cost_code_id', v_cc, 'document_id', v_doc, 'vendor_name', f ->> 'vendor_name',
                         'amount_cents', pm._x_try_bigint(f ->> 'amount_cents'), 'tax_cents', pm._x_try_bigint(f ->> 'tax_cents'),
                         'purchased_on', f ->> 'purchased_on', 'card_last4', f ->> 'card_last4'));
  end if;
  return jsonb_build_object('receipt_id', v, 'status', case when v_code then 'CODED' else 'CAPTURED' end, 'photo_pending', v_doc is null, 'replayed', false,
                            'suggested_cost_code_id', case when v_code then null else v_cc end);
end $$;

-- The office codes it (job may move to another job at the same company; card charge reference from Books).
create or replace function pm.res_code_receipt(p_receipt uuid, p_cost_code uuid, p_fields jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.res_receipt_captures%rowtype; f jsonb := coalesce(p_fields, '{}'); v_loc uuid; v_vendor uuid := pm.access_try_uuid(f ->> 'vendor_id');
begin
  select * into r from pm.res_receipt_captures x where x.id = p_receipt and x.org_id = public.get_org_id() for update;
  if r.id is null then raise exception 'PM_FORBIDDEN: receipt not found' using errcode = '42501'; end if;
  if r.status in ('SENT','VOID') then raise exception 'PM_INVALID: this receipt is %', lower(r.status) using errcode = '22023'; end if;
  select location_id into v_loc from core.jobs where id = r.job_id;
  if r.document_id is null and r.photo_command_id is not null then
    update pm.res_receipt_captures set document_id = pm._res_photo_document(r.org_id, r.job_id, r.photo_command_id, r.captured_by) where id = r.id returning * into r;
  end if;
  if not exists (select 1 from pm.cost_codes c where c.org_id = r.org_id and c.id = p_cost_code and c.location_id = v_loc and (c.job_id is null or c.job_id = r.job_id)) then
    raise exception 'PM_INVALID: that cost code is not on this job' using errcode = '22023';
  end if;
  if v_vendor is not null and not exists (select 1 from core.vendors v where v.id = v_vendor and v.org_id = r.org_id) then v_vendor := null; end if;
  update pm.res_receipt_captures set cost_code_id = p_cost_code, vendor_id = coalesce(v_vendor, vendor_id),
         vendor_name = coalesce(left(f ->> 'vendor_name', 200), vendor_name), amount_cents = coalesce(pm._x_try_bigint(f ->> 'amount_cents'), amount_cents),
         tax_cents = coalesce(pm._x_try_bigint(f ->> 'tax_cents'), tax_cents), purchased_on = coalesce(pm._x_try_date(f ->> 'purchased_on'), purchased_on),
         books_txn_ref = coalesce(left(f ->> 'books_txn_ref', 120), books_txn_ref), memo = coalesce(left(f ->> 'memo', 500), memo),
         status = 'CODED', coded_by = pm.current_user_id(), coded_at = now(), updated_at = now()
   where id = r.id returning * into r;
  perform pm._wc_books_request(r.org_id, v_loc, r.job_id, case when r.books_txn_ref is not null then 'CARD_CODING' else 'RECEIPT_CODING' end, 'res_receipt_captures', r.id,
    jsonb_build_object('receipt_id', r.id, 'job_id', r.job_id, 'cost_code_id', r.cost_code_id, 'document_id', r.document_id, 'vendor_id', r.vendor_id,
                       'vendor_name', r.vendor_name, 'amount_cents', r.amount_cents, 'tax_cents', r.tax_cents, 'purchased_on', r.purchased_on,
                       'card_last4', r.card_last4, 'books_txn_ref', r.books_txn_ref));
  return jsonb_build_object('id', r.id, 'status', r.status);
end $$;

-- R8. "Today" site cards for the field app (RES-68): address, codes, homeowner notes, occupied-home
-- rules, deliveries today / tomorrow, protection checks open, today's tasks. No money. Jobs the
-- caller reaches only (pm.my_job_ids).
create or replace function pm.res_field_sites(p_jobs uuid[], p_day date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_day date := coalesce(p_day, current_date); v_out jsonb := '[]'; r record;
begin
  if p_jobs is null or cardinality(p_jobs) = 0 then return '[]'::jsonb; end if;
  if cardinality(p_jobs) > 50 then raise exception 'PM_INVALID: up to 50 jobs at a time' using errcode = '22023'; end if;
  for r in select j.id, j.job_number, j.name, j.location_id, p.site_address_line1, p.site_city, p.site_state, p.site_zip, p.site_lat, p.site_lng, h.*
             from core.jobs j join pm.projects p on p.org_id = j.org_id and p.job_id = j.id
             left join pm.res_home_profiles h on h.org_id = j.org_id and h.job_id = j.id
            where j.org_id = v_org and j.id = any (p_jobs)
              and (pm.access_is_service() or j.id in (select pm.my_job_ids())) loop
    v_out := v_out || jsonb_build_object(
      'job_id', r.id, 'job_number', r.job_number, 'name', r.name,
      'address', nullif(concat_ws(', ', r.site_address_line1, r.site_city, concat_ws(' ', r.site_state, r.site_zip)), ''), 'lat', r.site_lat, 'lng', r.site_lng,
      -- entry codes only for the job team or a crew / person scheduled on the job (L10)
      'codes', case when pm.access_is_service()
                       or exists (select 1 from pm.job_members jm where jm.org_id = v_org and jm.job_id = r.id and jm.membership_id = pm.access_my_membership())
                       or exists (select 1 from pm.tasks t where t.org_id = v_org and t.job_id = r.id and t.status in ('TODO','IN_PROGRESS','BLOCKED')
                                    and (t.assigned_crew_id in (select pm.my_crew_ids()) or t.assignee_employee_id in (select pm.my_employee_ids()) or t.assignee_user_id = pm.current_user_id()))
                    then jsonb_strip_nulls(jsonb_build_object('lockbox', r.lockbox_code, 'gate', r.gate_code, 'garage', r.garage_code, 'alarm', r.alarm_code))
                    else '{}'::jsonb end,
      'home', jsonb_strip_nulls(jsonb_build_object('occupied', r.occupied, 'pets', r.pets, 'children', r.children, 'work_hours', r.work_hours, 'parking', r.parking,
                                                   'off_limits', r.off_limits, 'bathroom_for_crew', r.bathroom_for_crew, 'temp_kitchen', r.temp_kitchen,
                                                   'notes', r.notes, 'utility_notice', r.utility_notice)),
      'rrp', exists (select 1 from pm.res_rrp_records x where x.org_id = v_org and x.job_id = r.id and x.required and x.status = 'OPEN'),
      'deliveries', coalesce((select jsonb_agg(jsonb_build_object('description', pi.description, 'expected_on', pi.expected_on, 'status', pi.status, 'tracking', pi.tracking_ref)
                                               order by pi.expected_on)
                                from pm.procurement_items pi where pi.org_id = v_org and pi.job_id = r.id and pi.expected_on between v_day and v_day + 1
                                 and pi.status in ('ORDERED','ACKNOWLEDGED','SHIPPED','STORED')), '[]'),
      'checks_open', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'date', c.check_date)) from pm.res_protection_checks c
                                where c.org_id = v_org and c.job_id = r.id and c.status = 'OPEN' and c.check_date <= v_day), '[]'),
      'tasks_today', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status) order by t.sort)
                                from pm.tasks t where t.org_id = v_org and t.job_id = r.id and t.status in ('TODO','IN_PROGRESS','BLOCKED') and not t.is_summary
                                 and coalesce(t.actual_start, t.early_start, t.start_on) <= v_day and coalesce(t.actual_finish, t.early_finish, t.due_on, t.start_on) >= v_day), '[]'));
  end loop;
  return v_out;
end $$;

-- R9. Job cash position (RES-84) and margin-fade warning (RES-122) --------------------------------
create table if not exists pm.res_watch_settings (
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  fade_points               numeric(6,4) not null default 0.03 check (fade_points > 0 and fade_points < 1),
  cash_negative_alert       boolean not null default true,
  annual_sales_target_cents bigint check (annual_sales_target_cents is null or annual_sales_target_cents >= 0),
  updated_by                text default pm.current_user_id(),
  updated_at                timestamptz not null default now(),
  primary key (org_id, location_id)
);

create table if not exists pm.res_margin_alerts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  kind                text not null check (kind in ('MARGIN_FADE','CASH_NEGATIVE')),
  sold_margin_pct     numeric(8,4),
  projected_margin_pct numeric(8,4),
  fade_points         numeric(8,4),
  cash_position_cents bigint,
  detail              jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  status              text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','CLEARED')),
  raised_at           timestamptz not null default now(),
  acknowledged_by     text,
  acknowledged_at     timestamptz,
  cleared_at          timestamptz,
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_res_margin_alerts_open_uidx on pm.res_margin_alerts (org_id, job_id, kind) where status <> 'CLEARED';

-- Books AR read through a definer (Projects-only seats cannot read Books tables): collected =
-- invoice payments on the job + deposits received; open AR = invoice balances.
create or replace function pm._wc_books_ar(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_paid bigint := 0; v_open bigint := 0; v_dep bigint := 0; v_avail boolean := to_regclass('public.invoices') is not null;
begin
  if v_avail then
    execute 'select coalesce(sum(i.amount_paid_cents), 0)::bigint, coalesce(sum(i.total_cents - i.amount_paid_cents) filter (where i.status not in (''PAID'',''VOIDED'',''WRITTEN_OFF'',''DRAFT'')), 0)::bigint
               from public.invoices i where i.org_id = $1 and i.job_id = $2 and i.status not in (''VOIDED'',''DRAFT'')'
      into v_paid, v_open using p_org, p_job;
  end if;
  if to_regclass('public.customer_deposits') is not null then
    execute 'select coalesce(sum(d.amount_cents), 0)::bigint from public.customer_deposits d where d.org_id = $1 and d.job_id = $2' into v_dep using p_org, p_job;
  end if;
  return jsonb_build_object('available', v_avail, 'invoice_paid_cents', v_paid, 'open_ar_cents', v_open, 'deposits_received_cents', v_dep);
end $$;

create or replace function pm._res_cash_position(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare f record; ar jsonb; v_collected bigint; v_incurred bigint; v_committed bigint; v_next record; v_dep_req bigint;
begin
  select * into f from pm.v_job_financials x where x.org_id = p_org and x.job_id = p_job;
  ar := pm._wc_books_ar(p_org, p_job);
  v_collected := (ar ->> 'invoice_paid_cents')::bigint + (ar ->> 'deposits_received_cents')::bigint;
  select coalesce(sum(c.amount_cents), 0)::bigint into v_incurred from pm.job_costs c where c.org_id = p_org and c.job_id = p_job and c.lifecycle in ('CLEARED','PENDING');
  v_committed := coalesce(f.committed_open_cents, 0);
  select d.draw_number, d.period_end, d.status into v_next from pm.draws d where d.org_id = p_org and d.job_id = p_job and d.status in ('DRAFT','SUBMITTED','INSPECTION','APPROVED')
   order by d.period_end nulls last limit 1;
  select coalesce(sum(d.amount_cents), 0)::bigint into v_dep_req from pm.deposit_requests d where d.org_id = p_org and d.job_id = p_job and d.status in ('EMITTED','ISSUED');
  return jsonb_build_object('job_id', p_job, 'books_available', ar -> 'available',
    'cash_collected_cents', v_collected, 'cost_incurred_cents', v_incurred, 'committed_open_cents', v_committed,
    'cash_position_cents', v_collected - v_incurred, 'cash_after_commitments_cents', v_collected - v_incurred - v_committed,
    'open_ar_cents', (ar ->> 'open_ar_cents')::bigint, 'billed_to_date_cents', coalesce(f.billed_to_date_cents, 0),
    'deposits_requested_cents', v_dep_req, 'deposits_received_cents', (ar ->> 'deposits_received_cents')::bigint,
    'deposit_coverage_pct', case when coalesce(v_committed, 0) > 0 then round((ar ->> 'deposits_received_cents')::numeric / v_committed, 4) end,
    'next_draw', case when v_next.draw_number is not null then jsonb_build_object('draw_number', v_next.draw_number, 'period_end', v_next.period_end, 'status', v_next.status) end,
    'negative', v_collected - v_incurred < 0,
    'why', case when v_collected - v_incurred < 0 then
                  format('Cost incurred (%s) is ahead of cash collected (%s)%s.', core.notify_money_text(v_incurred), core.notify_money_text(v_collected),
                         case when coalesce(f.billed_to_date_cents, 0) < coalesce(f.earned_revenue_cents, 0) then format('; %s of earned work is not billed yet', core.notify_money_text(coalesce(f.earned_revenue_cents, 0) - coalesce(f.billed_to_date_cents, 0)))
                              when (ar ->> 'open_ar_cents')::bigint > 0 then format('; %s is billed but not paid', core.notify_money_text((ar ->> 'open_ar_cents')::bigint)) else '' end) end);
end $$;

create or replace function pm.res_job_cash_position(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return pm._res_cash_position(j.org_id, p_job);
end $$;

-- Every active job at the company (financials holders), negative-cash jobs first.
create or replace function pm.res_cash_positions(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v jsonb;
begin
  select coalesce(jsonb_agg(x order by (x ->> 'cash_position_cents')::bigint), '[]') into v from (
    select pm._res_cash_position(v_org, j.id) || jsonb_build_object('job_number', j.job_number, 'name', j.name) as x
      from core.jobs j join pm.projects p on p.org_id = j.org_id and p.job_id = j.id and not p.is_sample
     where j.org_id = v_org and j.location_id = p_location and j.status in ('ACTIVE','ON_HOLD')
       and (pm.access_is_service() or j.id in (select pm.my_money_job_ids('projects.financials')))) s;
  return jsonb_build_object('jobs', v, 'negative', (select count(*) from jsonb_array_elements(v) x where (x ->> 'negative')::boolean));
end $$;

-- Margin fade: sold margin (original contract vs original budget) against projected margin now;
-- which cost codes moved (forecast over budget) and whether a change order looks missing (a code
-- over budget with no change order touching it).
create or replace function pm._res_margin_fade(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare f record; v_sold numeric; v_fade numeric; v_codes jsonb; v_threshold numeric; v_loc uuid;
begin
  select * into f from pm.v_job_financials x where x.org_id = p_org and x.job_id = p_job;
  if f.job_id is null then return jsonb_build_object('job_id', p_job, 'available', false); end if;
  v_loc := f.location_id;
  select coalesce(w.fade_points, 0.03) into v_threshold from pm.res_watch_settings w where w.org_id = p_org and w.location_id = v_loc;
  v_threshold := coalesce(v_threshold, 0.03);
  v_sold := case when coalesce(f.original_contract_cents, 0) > 0 and f.budget_original_cents is not null
                 then round((f.original_contract_cents - f.budget_original_cents)::numeric / f.original_contract_cents, 4) end;
  v_fade := case when v_sold is not null and f.projected_margin_pct is not null then round(v_sold - f.projected_margin_pct, 4) end;
  select coalesce(jsonb_agg(jsonb_build_object('cost_code_id', s.cost_code_id, 'code', s.cost_code, 'name', s.cost_code_name, 'budget_cents', s.budget_cents,
            'forecast_cents', s.forecast_cents, 'over_cents', s.forecast_cents - s.budget_cents, 'actual_cents', s.actual_cents,
            'change_order_on_code', exists (select 1 from pm.change_orders co where co.org_id = p_org and co.job_id = p_job and co.stage <> 'VOID'
                                             and (co.ext ->> 'cost_code_id' = s.cost_code_id::text
                                                  or exists (select 1 from pm.res_change_order_lines cl where cl.org_id = p_org and cl.change_order_id = co.id and cl.cost_code_id = s.cost_code_id))))
          order by s.forecast_cents - s.budget_cents desc), '[]') into v_codes
    from pm.v_cost_code_status s where s.org_id = p_org and s.job_id = p_job and s.forecast_cents > s.budget_cents;
  return jsonb_build_object('job_id', p_job, 'available', true, 'sold_margin_pct', v_sold, 'projected_margin_pct', f.projected_margin_pct, 'fade_points', v_fade,
    'threshold_points', v_threshold, 'fading', v_fade is not null and v_fade >= v_threshold,
    'revised_contract_cents', f.revised_contract_cents, 'projected_final_cost_cents', f.projected_final_cost_cents, 'pending_co_cents', f.pending_co_cents,
    'moved_codes', v_codes,
    'missing_change_orders', (select count(*) from jsonb_array_elements(v_codes) x where not (x ->> 'change_order_on_code')::boolean),
    'field_cos_unpriced', (select count(*) from pm.change_orders co where co.org_id = p_org and co.job_id = p_job and co.stage = 'PCO' and coalesce(co.amount_cents, 0) = 0),
    'why', case when v_fade is not null and v_fade >= v_threshold then
                  format('Projected margin is %s points under the %s%% sold%s.', round(v_fade * 100, 1), round(v_sold * 100, 1),
                         case when jsonb_array_length(v_codes) > 0 then format('; %s cost code(s) forecast over budget, led by %s', jsonb_array_length(v_codes), v_codes -> 0 ->> 'name') else '' end) end);
end $$;

create or replace function pm.res_margin_fade(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return pm._res_margin_fade(j.org_id, p_job);
end $$;

-- The daily scan (service sweep or a manager): opens / refreshes / clears alerts and tells the PM
-- team plus everyone with financials:view at the company.
create or replace function pm.res_scan_job_health(p_location uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); j record; m jsonb; c jsonb; n_fade int := 0; n_cash int := 0; v_to uuid[]; v_cash_alert boolean;
begin
  select coalesce(w.cash_negative_alert, true) into v_cash_alert from pm.res_watch_settings w where w.org_id = v_org and w.location_id = p_location;
  v_cash_alert := coalesce(v_cash_alert, true);
  for j in select x.id, x.job_number, x.name from core.jobs x join pm.projects p on p.org_id = x.org_id and p.job_id = x.id and not p.is_sample
            where x.org_id = v_org and x.location_id = p_location and x.status in ('ACTIVE','ON_HOLD') loop
    v_to := array(select distinct u from unnest(coalesce((select array_agg(jm.membership_id) from pm.job_members jm where jm.org_id = v_org and jm.job_id = j.id and jm.slot in ('pm','apm')), '{}')
                                              || core.notify_members_with(v_org, p_location, 'projects.financials', 'view')) u);
    m := pm._res_margin_fade(v_org, j.id);
    if coalesce((m ->> 'fading')::boolean, false) then
      insert into pm.res_margin_alerts (org_id, job_id, kind, sold_margin_pct, projected_margin_pct, fade_points, detail)
      values (v_org, j.id, 'MARGIN_FADE', (m ->> 'sold_margin_pct')::numeric, (m ->> 'projected_margin_pct')::numeric, (m ->> 'fade_points')::numeric, m)
      on conflict (org_id, job_id, kind) where status <> 'CLEARED' do update set projected_margin_pct = excluded.projected_margin_pct, fade_points = excluded.fade_points, detail = excluded.detail;
      n_fade := n_fade + 1;
      perform pm._wc_fanout(v_org, 'job.margin_fade', p_location, j.id, 'res_margin_alerts', j.id, v_to, format('Margin fading: %s', j.name),
        'Projected margin dropped below what was sold. Open the job to see which cost codes moved.', '/job-cost?job=' || j.id::text,
        'margin_fade:' || j.id::text || ':' || to_char(current_date, 'YYYY-MM-DD'), 'projects.financials', format('Margin fading: %s', j.name), m ->> 'why');
    else
      update pm.res_margin_alerts set status = 'CLEARED', cleared_at = now() where org_id = v_org and job_id = j.id and kind = 'MARGIN_FADE' and status <> 'CLEARED';
    end if;
    c := pm._res_cash_position(v_org, j.id);
    if v_cash_alert and coalesce((c ->> 'negative')::boolean, false) then
      insert into pm.res_margin_alerts (org_id, job_id, kind, cash_position_cents, detail) values (v_org, j.id, 'CASH_NEGATIVE', (c ->> 'cash_position_cents')::bigint, c)
      on conflict (org_id, job_id, kind) where status <> 'CLEARED' do update set cash_position_cents = excluded.cash_position_cents, detail = excluded.detail;
      n_cash := n_cash + 1;
      perform pm._wc_fanout(v_org, 'job.cash_negative', p_location, j.id, 'res_margin_alerts', j.id, v_to, format('Cash-negative: %s', j.name),
        'Cost on this job is ahead of the cash collected.', '/job-cost?job=' || j.id::text,
        'cash_negative:' || j.id::text || ':' || to_char(current_date, 'YYYY-MM-DD'), 'projects.financials', format('Cash-negative: %s', j.name), c ->> 'why');
    else
      update pm.res_margin_alerts set status = 'CLEARED', cleared_at = now() where org_id = v_org and job_id = j.id and kind = 'CASH_NEGATIVE' and status <> 'CLEARED';
    end if;
  end loop;
  return jsonb_build_object('margin_fade', n_fade, 'cash_negative', n_cash);
end $$;

create or replace function pm.res_acknowledge_alert(p_alert uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.res_margin_alerts set status = 'ACKNOWLEDGED', acknowledged_by = pm.current_user_id(), acknowledged_at = now()
   where id = p_alert and org_id = public.get_org_id() and status = 'OPEN' returning id into v;
  if v is null then raise exception 'PM_INVALID: no open alert to acknowledge' using errcode = '22023'; end if;
  return v;
end $$;

-- R10. Weekly client update (RES-90): rules-only draft from the week's logs, photos, schedule, change
-- orders and billing; the PM edits and approves; it goes to the portal thread (and the portal sends
-- the email / text). AI drafting replaces the template when AI is on.
create table if not exists pm.res_client_updates (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  week_of              date not null,
  status               text not null default 'DRAFT' check (status in ('DRAFT','SENT','DISCARDED')),
  body                 text not null check (char_length(body) between 1 and 4000),
  sections             jsonb not null default '{}' check (jsonb_typeof(sections) = 'object'),
  photo_document_ids   uuid[] not null default '{}' check (cardinality(photo_document_ids) <= 10),
  drafted_by           text not null default 'RULES' check (drafted_by in ('RULES','AI','PERSON')),
  edited               boolean not null default false,
  portal_message_id    uuid,
  sent_by              text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_res_client_updates_week_uidx on pm.res_client_updates (org_id, job_id, week_of) where status <> 'DISCARDED';

create or replace function pm._res_draft_update(p_org uuid, p_job uuid, p_week date) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_from date := p_week; v_to date := p_week + 6; v_done jsonb; v_next jsonb; v_logs jsonb; v_cos jsonb; v_photos uuid[]; v_body text; v_name text; v_sel int;
begin
  select coalesce(j.name, 'your project') into v_name from core.jobs j where j.id = p_job;
  select coalesce(jsonb_agg(t.title order by coalesce(t.actual_finish, t.due_on)), '[]') into v_done from pm.tasks t
   where t.org_id = p_org and t.job_id = p_job and t.status = 'DONE' and coalesce(t.actual_finish, t.completed_at::date, t.due_on) between v_from and v_to and not t.is_summary;
  select coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'on', coalesce(t.early_start, t.start_on)) order by coalesce(t.early_start, t.start_on)), '[]') into v_next from pm.tasks t
   where t.org_id = p_org and t.job_id = p_job and t.client_visible and t.status in ('TODO','IN_PROGRESS') and coalesce(t.early_start, t.start_on) between v_to + 1 and v_to + 14;
  select coalesce(jsonb_agg(left(fl.body, 300) order by fl.log_date), '[]') into v_logs from pm.field_logs fl
   where fl.org_id = p_org and fl.job_id = p_job and fl.log_date between v_from and v_to and fl.client_visible and nullif(btrim(coalesce(fl.body, '')), '') is not null;
  select coalesce(jsonb_agg(jsonb_build_object('number', co.number, 'title', co.title, 'stage', co.stage)), '[]') into v_cos from pm.change_orders co
   where co.org_id = p_org and co.job_id = p_job and co.stage in ('PCO','COR') ;
  select count(*) into v_sel from pm.selections s where s.org_id = p_org and s.job_id = p_job and s.status in ('OPEN','PROPOSED') and s.due_on <= v_to + 14;
  v_photos := array(select m.document_id from pm.doc_photo_meta m where m.org_id = p_org and m.job_id = p_job
                      and coalesce(m.taken_at, m.received_at)::date between v_from and v_to order by coalesce(m.taken_at, m.received_at) desc limit 6);
  v_body := concat_ws(E'\n\n',
    format('Here is this week''s update on %s.', v_name),
    case when jsonb_array_length(v_done) > 0 then 'Finished this week: ' || (select string_agg(x, '; ') from jsonb_array_elements_text(v_done) x) || '.' else 'Work continued this week.' end,
    case when jsonb_array_length(v_logs) > 0 then (select string_agg(x, ' ') from jsonb_array_elements_text(v_logs) x) end,
    case when jsonb_array_length(v_next) > 0 then 'Coming up: ' || (select string_agg(format('%s (%s)', x ->> 'title', to_char((x ->> 'on')::date, 'Dy Mon DD')), '; ') from jsonb_array_elements(v_next) x) || '.' end,
    case when v_sel > 0 then format('We need %s selection decision(s) from you in the next two weeks — they are waiting in your portal.', v_sel) end,
    case when jsonb_array_length(v_cos) > 0 then format('%s change order(s) are being priced or waiting on your signature.', jsonb_array_length(v_cos)) end,
    'Questions? Reply here.');
  return jsonb_build_object('body', left(v_body, 4000), 'photos', to_jsonb(v_photos),
    'sections', jsonb_build_object('done', v_done, 'next', v_next, 'logs', v_logs, 'change_orders', v_cos, 'selections_due', v_sel));
end $$;

create or replace function pm.res_draft_client_update(p_job uuid, p_week_of date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_week date := date_trunc('week', coalesce(p_week_of, current_date))::date; d jsonb; v uuid;
begin
  select * into j from pm._x_job(p_job);
  select id into v from pm.res_client_updates where org_id = j.org_id and job_id = p_job and week_of = v_week and status <> 'DISCARDED';
  d := pm._res_draft_update(j.org_id, p_job, v_week);
  if v is null then
    insert into pm.res_client_updates (org_id, job_id, week_of, body, sections, photo_document_ids)
    values (j.org_id, p_job, v_week, d ->> 'body', d -> 'sections', coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'photos') x), '{}'))
    returning id into v;
  else
    update pm.res_client_updates set body = d ->> 'body', sections = d -> 'sections',
           photo_document_ids = coalesce(array(select x::uuid from jsonb_array_elements_text(d -> 'photos') x), '{}'), updated_at = now()
     where id = v and status = 'DRAFT' and not edited;
  end if;
  return v;
end $$;

-- Friday sweep: a draft for every active job with a customer; the PM team hears it is ready.
create or replace function pm.res_draft_weekly_updates(p_location uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); j record; v uuid; n int := 0;
begin
  for j in select x.id, x.name from core.jobs x join pm.projects p on p.org_id = x.org_id and p.job_id = x.id and not p.is_sample
            where x.org_id = v_org and x.location_id = p_location and x.status = 'ACTIVE' and x.customer_id is not null
              and pm.access_can_job('projects.jobs', 'edit', x.id) loop   -- only jobs the caller may edit (the nested draft skips its guard)
    v := pm.res_draft_client_update(j.id, current_date);
    n := n + 1;
    perform pm._wc_fanout(v_org, 'client_update.ready', p_location, j.id, 'res_client_updates', v,
      coalesce((select array_agg(jm.membership_id) from pm.job_members jm where jm.org_id = v_org and jm.job_id = j.id and jm.slot in ('pm','apm')), '{}'),
      format('Client update ready: %s', j.name), 'This week''s update is drafted. Edit it and send it to the homeowner.',
      '/homes/' || j.id::text || '?tab=updates', 'client_update:' || v::text);
  end loop;
  return n;
end $$;

create or replace function pm.res_edit_client_update(p_update uuid, p_body text, p_photos uuid[] default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'PM_INVALID: write the update (up to 4,000 characters)' using errcode = '22023'; end if;
  if p_photos is not null and cardinality(p_photos) > 10 then raise exception 'PM_INVALID: up to 10 photos' using errcode = '22023'; end if;
  update pm.res_client_updates set body = btrim(p_body), photo_document_ids = coalesce(p_photos, photo_document_ids), edited = true, drafted_by = case when drafted_by = 'RULES' then 'RULES' else drafted_by end,
         updated_at = now()
   where id = p_update and org_id = public.get_org_id() and status = 'DRAFT' returning id into v;
  if v is null then raise exception 'PM_INVALID: only a draft can be edited' using errcode = '22023'; end if;
  return v;
end $$;

-- Send: the chosen photos are shared to the customer portal, the text posts to the customer thread.
create or replace function pm.res_send_client_update(p_update uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare u pm.res_client_updates%rowtype; v_cust uuid; v_msg jsonb;
begin
  select * into u from pm.res_client_updates x where x.id = p_update and x.org_id = public.get_org_id() for update;
  if u.id is null then raise exception 'PM_FORBIDDEN: update not found' using errcode = '42501'; end if;
  if u.status <> 'DRAFT' then raise exception 'PM_INVALID: already %', lower(u.status) using errcode = '22023'; end if;
  select j.customer_id into v_cust from core.jobs j where j.id = u.job_id;
  if v_cust is null then raise exception 'PM_INVALID: the job has no customer to send to' using errcode = '22023'; end if;
  perform pm._wc_require_job('projects.jobs', 'edit', u.job_id);
  update pm.doc_photo_meta set share_to_portal = true where org_id = u.org_id and job_id = u.job_id and document_id = any (u.photo_document_ids);
  v_msg := pm.portal_post_message(u.job_id, 'customer', v_cust, u.body, null);
  update pm.res_client_updates set status = 'SENT', sent_at = now(), sent_by = pm.current_user_id(), portal_message_id = pm.access_try_uuid(v_msg ->> 'id'), updated_at = now()
   where id = u.id;
  return jsonb_build_object('id', u.id, 'notified', v_msg -> 'notified', 'photos_shared', cardinality(u.photo_document_ids));
end $$;

-- R11. Closeout package (RES-97) -----------------------------------------------------------------
create table if not exists pm.res_closeout_packages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  status          text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED')),
  title           text not null default 'Your home''s closeout package',
  published_at    timestamptz,
  published_by    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_closeout_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  package_id      uuid not null,
  kind            text not null check (kind in ('WARRANTY','MANUAL','PAINT_COLOR','PRODUCT','SPEC_BOOK','ROUGH_IN_PHOTO','LIEN_RELEASE','OTHER')),
  title           text not null check (char_length(btrim(title)) between 1 and 200),
  detail          jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  doc_file_id     uuid,
  document_id     uuid references public.documents(id) on delete set null,
  source          text not null default 'AUTO' check (source in ('AUTO','PERSON')),
  source_ref      text,
  included        boolean not null default true,
  sort            int not null default 0,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, package_id) references pm.res_closeout_packages (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_res_closeout_items_src_uidx on pm.res_closeout_items (org_id, package_id, source_ref) where source_ref is not null;

-- Assemble from what the job already holds: approved selections (product list + paint colors),
-- warranty / manual / spec / closeout documents, rough-in photos (tagged or area "rough"), and
-- unconditional / final lien waivers. Re-running adds only what is new.
create or replace function pm.res_assemble_closeout(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_pkg uuid; n int := 0; v_missing text[] := '{}';
begin
  select * into j from pm._x_job(p_job);
  insert into pm.res_closeout_packages (org_id, job_id) values (j.org_id, p_job) on conflict (org_id, job_id) do nothing;
  select id into v_pkg from pm.res_closeout_packages where org_id = j.org_id and job_id = p_job;
  insert into pm.res_closeout_items (org_id, package_id, kind, title, detail, source_ref, sort)
  select j.org_id, v_pkg, case when s.category ilike '%paint%' then 'PAINT_COLOR' else 'PRODUCT' end,
         left(concat_ws(': ', s.title, o.label), 200),
         jsonb_strip_nulls(jsonb_build_object('category', s.category, 'room', s.room, 'option', o.label, 'vendor_url', o.vendor_url, 'finish', o.finish, 'sku', o.vendor_sku)),
         'selection:' || s.id::text, 100 + s.sort
    from pm.selections s left join pm.selection_options o on o.org_id = s.org_id and o.id = s.chosen_option_id
   where s.org_id = j.org_id and s.job_id = p_job and s.status = 'APPROVED'
  on conflict (org_id, package_id, source_ref) where source_ref is not null do nothing;
  get diagnostics n = row_count;
  insert into pm.res_closeout_items (org_id, package_id, kind, title, doc_file_id, source_ref, sort)
  select j.org_id, v_pkg, case f.kind when 'warranty' then 'WARRANTY' when 'manual' then 'MANUAL' when 'spec' then 'SPEC_BOOK' else 'OTHER' end, f.title, f.id,
         'doc:' || f.id::text, case f.kind when 'warranty' then 10 when 'manual' then 20 when 'spec' then 30 else 60 end
    from pm.doc_files f where f.org_id = j.org_id and f.job_id = p_job and f.status = 'active' and f.kind in ('warranty','manual','spec','closeout')
  on conflict (org_id, package_id, source_ref) where source_ref is not null do nothing;
  insert into pm.res_closeout_items (org_id, package_id, kind, title, document_id, detail, source_ref, sort)
  select j.org_id, v_pkg, 'ROUGH_IN_PHOTO', left(coalesce('Rough-in: ' || m.area, 'Rough-in photo'), 200), m.document_id,
         jsonb_build_object('taken_at', coalesce(m.taken_at, m.received_at)), 'photo:' || m.document_id::text, 300
    from pm.doc_photo_meta m where m.org_id = j.org_id and m.job_id = p_job and ('rough_in' = any (m.tags) or m.area ilike '%rough%')
  on conflict (org_id, package_id, source_ref) where source_ref is not null do nothing;
  insert into pm.res_closeout_items (org_id, package_id, kind, title, document_id, detail, source_ref, sort)
  select j.org_id, v_pkg, 'LIEN_RELEASE', left(concat_ws(' · ', 'Lien release', v.name, replace(lower(c.doc_type), '_', ' ')), 200), c.document_id,
         jsonb_build_object('vendor', v.name, 'type', c.doc_type, 'through', c.covers_through), 'waiver:' || c.id::text, 400
    from pm.compliance_docs c left join core.vendors v on v.id = c.vendor_id
   where c.org_id = j.org_id and c.job_id = p_job and c.doc_type in ('LIEN_WAIVER_UNCONDITIONAL','LIEN_WAIVER_FINAL') and c.status in ('RECEIVED','VERIFIED')
  on conflict (org_id, package_id, source_ref) where source_ref is not null do nothing;
  if not exists (select 1 from pm.res_closeout_items i where i.package_id = v_pkg and i.kind = 'WARRANTY') then v_missing := v_missing || 'warranty'::text; end if;
  if not exists (select 1 from pm.res_closeout_items i where i.package_id = v_pkg and i.kind in ('PRODUCT','PAINT_COLOR')) then v_missing := v_missing || 'product list'::text; end if;
  if not exists (select 1 from pm.res_closeout_items i where i.package_id = v_pkg and i.kind = 'LIEN_RELEASE') then v_missing := v_missing || 'lien releases'::text; end if;
  if not exists (select 1 from pm.res_closeout_items i where i.package_id = v_pkg and i.kind = 'ROUGH_IN_PHOTO') then v_missing := v_missing || 'rough-in photos'::text; end if;
  return jsonb_build_object('package_id', v_pkg, 'items', (select count(*) from pm.res_closeout_items i where i.package_id = v_pkg), 'missing', to_jsonb(v_missing));
end $$;

create or replace function pm.res_add_closeout_item(p_job uuid, p_kind text, p_title text, p_detail jsonb default '{}', p_doc_file uuid default null, p_document uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_pkg uuid; v uuid;
begin
  select * into j from pm._x_job(p_job);
  insert into pm.res_closeout_packages (org_id, job_id) values (j.org_id, p_job) on conflict (org_id, job_id) do nothing;
  select id into v_pkg from pm.res_closeout_packages where org_id = j.org_id and job_id = p_job;
  if p_doc_file is not null and not exists (select 1 from pm.doc_files f where f.org_id = j.org_id and f.id = p_doc_file and f.job_id = p_job) then
    raise exception 'PM_INVALID: that document is not on this job' using errcode = '22023';
  end if;
  perform pm._wc_check_document(j.org_id, p_job, p_document);
  insert into pm.res_closeout_items (org_id, package_id, kind, title, detail, doc_file_id, document_id, source, sort)
  values (j.org_id, v_pkg, p_kind, left(btrim(p_title), 200), coalesce(p_detail, '{}'), p_doc_file, p_document, 'PERSON', 500) returning id into v;
  return v;
end $$;

create or replace function pm.res_set_closeout_item(p_item uuid, p_included boolean)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.res_closeout_items i set included = coalesce(p_included, true)
    from pm.res_closeout_packages k
   where i.id = p_item and i.org_id = public.get_org_id() and k.id = i.package_id and k.status = 'DRAFT'
  returning i.id into v;
  if v is null then raise exception 'PM_INVALID: only items of a draft package can be included or left out' using errcode = '22023'; end if;
  return v;
end $$;

-- Publish: included documents are shared to the customer portal (cost documents never), included
-- photos too; the package is kept for life (closeout retention on the files).
create or replace function pm.res_publish_closeout(p_package uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare k pm.res_closeout_packages%rowtype; i record; n int := 0; v_skipped int := 0; v_cust uuid;
begin
  select * into k from pm.res_closeout_packages x where x.id = p_package and x.org_id = public.get_org_id() for update;
  if k.id is null then raise exception 'PM_FORBIDDEN: package not found' using errcode = '42501'; end if;
  perform pm._wc_require_job('projects.documents', 'edit', k.job_id);
  -- only files on this package's job (a file id from another job is skipped, never shared)
  for i in select ci.*, f.money_cap, f.job_id as file_job_id from pm.res_closeout_items ci left join pm.doc_files f on f.org_id = ci.org_id and f.id = ci.doc_file_id
            where ci.org_id = k.org_id and ci.package_id = k.id and ci.included loop
    if i.doc_file_id is not null then
      if i.file_job_id is distinct from k.job_id then v_skipped := v_skipped + 1; continue; end if;
      if coalesce(i.money_cap, '') = 'projects.financials' and i.kind <> 'LIEN_RELEASE' then v_skipped := v_skipped + 1; continue; end if;
      if coalesce(i.money_cap, '') <> 'projects.financials' then
        perform pm._wc_require_row('projects.documents', 'edit', 'doc_files', i.doc_file_id);
        perform pm.portal_share_document(i.doc_file_id, array(select distinct x from unnest(coalesce((select portal_audiences from pm.doc_files where id = i.doc_file_id), '{}') || array['customer']) x));
        update pm.doc_files set retention_class = 'permanent' where id = i.doc_file_id and retention_class <> 'permanent';
        n := n + 1;
      end if;
    elsif i.document_id is not null and i.kind = 'ROUGH_IN_PHOTO' then
      update pm.doc_photo_meta set share_to_portal = true where org_id = k.org_id and job_id = k.job_id and document_id = i.document_id;
      n := n + 1;
    end if;
  end loop;
  update pm.res_closeout_packages set status = 'PUBLISHED', published_at = now(), published_by = pm.current_user_id(), updated_at = now() where id = k.id;
  select customer_id into v_cust from core.jobs where id = k.job_id;
  if v_cust is not null and pm.access_can_job('projects.jobs', 'edit', k.job_id) then
    begin
      perform pm.portal_post_message(k.job_id, 'customer', v_cust, 'Your closeout package is ready in your portal: warranties, manuals, product list, paint colors and rough-in photos. It stays there for as long as you own the home.', null);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('package_id', k.id, 'shared', n, 'skipped_cost_documents', v_skipped);
end $$;

-- R12. Owner dashboard (RES-123): one company or every company the caller holds financials at.
-- Books bank balances are Books data: only for callers holding a Books cash / banking / financial
-- report view at that company (core.sod_effective_grants reads every module's grants).
create or replace function pm._wc_books_cash_visible(p_location uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from core.sod_effective_grants(core.client_scope_caller_membership(), p_location) g
                  where g.action = 'view' and g.capability in ('cash.position', 'bank.transactions', 'bank.reconciliations', 'reports.financial'))
$$;

create or replace function pm._res_company_kpis(p_org uuid, p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_backlog bigint; v_billed90 bigint; v_won int; v_lost int; v_sold12 bigint; v_target bigint; v_unbilled bigint; v_ar bigint := 0; v_cash bigint := 0;
  v_risk int; v_by_pm jsonb; v_by_type jsonb; v_warranty int; v_warranty_cost bigint; v_cash_reason text;
begin
  select coalesce(sum(greatest(f.revised_contract_cents - f.billed_to_date_cents, 0)), 0)::bigint,
         coalesce(sum(greatest(coalesce(f.earned_revenue_cents, 0) - f.billed_to_date_cents, 0)), 0)::bigint
    into v_backlog, v_unbilled
    from pm.v_job_financials f join core.jobs j on j.id = f.job_id where f.org_id = p_org and f.location_id = p_location and j.status in ('ACTIVE','ON_HOLD','BID');
  select coalesce(sum(r.gross_earned_cents), 0)::bigint into v_billed90 from pm.billing_requests r
   where r.org_id = p_org and r.location_id = p_location and r.status in ('EMITTED','ISSUED') and r.occurred_on >= current_date - 90;
  select count(*) filter (where l.won_at is not null), count(*) filter (where l.lost_at is not null) into v_won, v_lost from crm.leads l
   where l.org_id = p_org and l.location_id = p_location and coalesce(l.won_at, l.lost_at) >= now() - interval '12 months';
  select coalesce(sum(c.original_cents), 0)::bigint into v_sold12 from pm.contracts c join core.jobs j on j.id = c.job_id
   where c.org_id = p_org and j.location_id = p_location and c.status = 'ACTIVE' and c.created_at >= now() - interval '12 months';
  select w.annual_sales_target_cents into v_target from pm.res_watch_settings w where w.org_id = p_org and w.location_id = p_location;
  if to_regclass('public.invoices') is not null then
    execute 'select coalesce(sum(i.total_cents - i.amount_paid_cents), 0)::bigint from public.invoices i where i.org_id = $1 and i.location_id = $2 and i.status in (''SENT'',''PARTIALLY_PAID'',''OVERDUE'')'
      into v_ar using p_org, p_location;
  end if;
  if not pm._wc_books_cash_visible(p_location) then
    v_cash := null; v_cash_reason := 'needs_books_cash_view';
  elsif to_regclass('public.bank_accounts') is not null then
    begin
      execute 'select coalesce(sum(b.current_balance_cents), 0)::bigint from public.bank_accounts b where b.org_id = $1 and b.location_id = $2' into v_cash using p_org, p_location;
    exception when others then v_cash := null; v_cash_reason := 'books_read_failed';
    end;
  else v_cash := null; v_cash_reason := 'books_not_connected';
  end if;
  select count(distinct a.job_id) into v_risk from pm.res_margin_alerts a join core.jobs j on j.id = a.job_id where a.org_id = p_org and j.location_id = p_location and a.status <> 'CLEARED';
  select coalesce(jsonb_agg(x order by x ->> 'pm'), '[]') into v_by_pm from (
    select jsonb_build_object('pm', coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), p.pm_user_id, 'Unassigned'), 'jobs', count(*),
             'revised_contract_cents', sum(f.revised_contract_cents), 'projected_margin_cents', sum(f.projected_margin_cents),
             'projected_margin_pct', case when sum(f.revised_contract_cents) > 0 then round(sum(f.projected_margin_cents)::numeric / sum(f.revised_contract_cents), 4) end) as x
      from pm.v_job_financials f join pm.projects p on p.org_id = f.org_id and p.job_id = f.job_id left join core.users u on u.clerk_user_id = p.pm_user_id
      join core.jobs j on j.id = f.job_id
     where f.org_id = p_org and f.location_id = p_location and j.status in ('ACTIVE','ON_HOLD','COMPLETE') and not p.is_sample
     group by coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), p.pm_user_id, 'Unassigned')) s;
  select coalesce(jsonb_agg(x order by x ->> 'job_type'), '[]') into v_by_type from (
    select jsonb_build_object('job_type', jt.label, 'jobs', count(*), 'revised_contract_cents', sum(f.revised_contract_cents), 'projected_margin_cents', sum(f.projected_margin_cents),
             'projected_margin_pct', case when sum(f.revised_contract_cents) > 0 then round(sum(f.projected_margin_cents)::numeric / sum(f.revised_contract_cents), 4) end) as x
      from pm.v_job_financials f join pm.projects p on p.org_id = f.org_id and p.job_id = f.job_id join pm.job_types jt on jt.id = p.job_type_id
      join core.jobs j on j.id = f.job_id
     where f.org_id = p_org and f.location_id = p_location and j.status in ('ACTIVE','ON_HOLD','COMPLETE') and not p.is_sample
     group by jt.label) s;
  select count(*) into v_warranty from pm.punch_items pi join core.jobs j on j.id = pi.job_id
   where pi.org_id = p_org and j.location_id = p_location and pi.kind in ('WARRANTY','CALLBACK') and pi.status not in ('CLOSED','VOID');
  select coalesce(sum(c.amount_cents), 0)::bigint into v_warranty_cost from pm.job_costs c join core.jobs j on j.id = c.job_id
   where c.org_id = p_org and j.location_id = p_location and c.lifecycle = 'CLEARED' and c.created_at >= now() - interval '12 months'
     and exists (select 1 from pm.punch_items pi where pi.org_id = c.org_id and pi.job_id = c.job_id and pi.kind = 'WARRANTY');
  return jsonb_build_object('location_id', p_location, 'company', (select l.name from core.locations l where l.id = p_location),
    'backlog_cents', v_backlog, 'backlog_months', case when v_billed90 > 0 then round(v_backlog::numeric / (v_billed90 / 3.0), 1) end,
    'sold_12m_cents', v_sold12, 'sales_target_cents', v_target, 'sold_vs_target_pct', case when coalesce(v_target, 0) > 0 then round(v_sold12::numeric / v_target, 4) end,
    'close_rate', case when v_won + v_lost > 0 then round(v_won::numeric / (v_won + v_lost), 4) end, 'won_12m', v_won, 'lost_12m', v_lost,
    'open_ar_cents', v_ar, 'cash_cents', v_cash, 'cash_unavailable_reason', v_cash_reason, 'jobs_at_risk', v_risk, 'unbilled_work_cents', v_unbilled,
    'margin_by_pm', v_by_pm, 'margin_by_job_type', v_by_type, 'open_warranty_items', v_warranty, 'warranty_cost_12m_cents', v_warranty_cost);
end $$;

create or replace function pm.res_owner_dashboard(p_location uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_locs uuid[]; v_rows jsonb := '[]'; l uuid; k jsonb; t jsonb;
begin
  if p_location is not null then perform pm._wc_loc(p_location); v_locs := array[p_location];
  else v_locs := array(select x from pm.my_location_ids('projects.financials', 'view') x);
       if pm.access_is_service() then v_locs := array(select id from core.locations where org_id = v_org); end if;
  end if;
  foreach l in array coalesce(v_locs, '{}') loop
    continue when not (pm.access_is_service() or pm.access_can_location('projects.financials', 'view', l));
    v_rows := v_rows || pm._res_company_kpis(v_org, l);
  end loop;
  select jsonb_build_object('backlog_cents', sum((x ->> 'backlog_cents')::bigint), 'sold_12m_cents', sum((x ->> 'sold_12m_cents')::bigint),
           'sales_target_cents', sum((x ->> 'sales_target_cents')::bigint), 'open_ar_cents', sum((x ->> 'open_ar_cents')::bigint),
           'cash_cents', sum((x ->> 'cash_cents')::bigint), 'jobs_at_risk', sum((x ->> 'jobs_at_risk')::int), 'unbilled_work_cents', sum((x ->> 'unbilled_work_cents')::bigint),
           'won_12m', sum((x ->> 'won_12m')::int), 'lost_12m', sum((x ->> 'lost_12m')::int), 'open_warranty_items', sum((x ->> 'open_warranty_items')::int),
           'warranty_cost_12m_cents', sum((x ->> 'warranty_cost_12m_cents')::bigint))
    into t from jsonb_array_elements(v_rows) x;
  t := coalesce(t, '{}'::jsonb) || jsonb_build_object('close_rate', case when coalesce((t ->> 'won_12m')::int, 0) + coalesce((t ->> 'lost_12m')::int, 0) > 0
                                       then round((t ->> 'won_12m')::numeric / ((t ->> 'won_12m')::int + (t ->> 'lost_12m')::int), 4) end);
  return jsonb_build_object('companies', v_rows, 'total', t, 'as_of', now());
end $$;

-- R13. Full data export manifest (RES-127): every object family the caller can read, by table and
-- view (the route streams each through the caller's RLS client), plus the file list.
create or replace function pm.res_export_tables()
returns jsonb
language sql stable
set search_path = pm, core, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('schema', 'pm', 'table', case when exists (select 1 from pm.access_masked_columns m where m.schema_name = 'pm' and m.table_name = a.table_name)
                                                                        then 'v_' || a.table_name || '_masked' else a.table_name end, 'source', a.table_name, 'class', a.class,
                                                 'scope', a.scope, 'parent_table', a.parent_table, 'parent_column', a.parent_column)
                            order by a.table_name), '[]')
    from pm.access_table_classes a
   where a.class in ('J','M','C','S','P') and to_regclass('pm.' || a.table_name) is not null
     and a.table_name not like 'access\_%' and a.table_name not like 'portal\_%' and a.table_name not like 'mfg\_kiosk%' and a.table_name not like 'esign\_%'
$$;

-- ============================================================================
-- D. Real-estate development completion
-- ============================================================================
alter table pm.dev_projects add column if not exists lender_consent_threshold_cents bigint;
alter table pm.dev_projects add column if not exists cap_interest_start_on date;
alter table pm.dev_projects add column if not exists cap_interest_stop_on date;
alter table pm.dev_projects add column if not exists pursuit_id uuid;
alter table pm.dev_projects add column if not exists construction_status text not null default 'NOT_STARTED';
do $$ begin
  alter table pm.dev_projects add constraint dev_projects_1124_chk check (
    construction_status in ('NOT_STARTED','ACTIVE','SUSPENDED','SUBSTANTIALLY_COMPLETE','COMPLETE')
    and (lender_consent_threshold_cents is null or lender_consent_threshold_cents >= 0));
exception when duplicate_object then null; end $$;

-- D1. Pursuit pipeline + due diligence (RED-03/04) ----------------------------------------------
create table if not exists pm.dev_pursuits (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),          -- the sponsor
  name                  text not null check (char_length(btrim(name)) between 1 and 200),
  address               text check (address is null or char_length(address) <= 500),
  parcels               text[] not null default '{}',
  product_type          text not null default 'FOR_RENT' check (product_type in ('FOR_RENT','FOR_SALE','MIXED')),
  stage                 text not null default 'IDENTIFIED' check (stage in ('IDENTIFIED','LOI','UNDER_CONTRACT','GO_NO_GO','GO','DEAD')),
  asking_price_cents    bigint check (asking_price_cents is null or asking_price_cents >= 0),
  contract_price_cents  bigint check (contract_price_cents is null or contract_price_cents >= 0),
  pursuit_budget_cents  bigint check (pursuit_budget_cents is null or pursuit_budget_cents >= 0),
  earnest_money_cents   bigint check (earnest_money_cents is null or earnest_money_cents >= 0),
  earnest_refundable    boolean not null default true,
  loi_on                date,
  contract_on           date,
  dd_expires_on         date,
  earnest_hard_on       date,
  closing_on            date,
  pursuit_job_id        uuid,              -- sponsor job that carries pursuit costs (optional)
  job_id                uuid,              -- the development project once GO
  owner_membership_id   uuid references core.memberships(id) on delete set null,
  dead_reason           text check (dead_reason is null or char_length(dead_reason) <= 1000),
  dead_at               timestamptz,
  notes                 text check (notes is null or char_length(notes) <= 4000),
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (stage <> 'DEAD' or dead_at is not null),
  foreign key (org_id, pursuit_job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_dev_pursuits_idx on pm.dev_pursuits (org_id, location_id, stage);

create table if not exists pm.dev_dd_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  pursuit_id    uuid not null,
  kind          text not null check (kind in ('TITLE','SURVEY','PHASE_I','GEOTECH','ZONING','UTILITIES','TRAFFIC','APPRAISAL','OTHER')),
  title         text not null check (char_length(btrim(title)) between 1 and 200),
  owner_name    text check (owner_name is null or char_length(owner_name) <= 200),
  vendor_id     uuid references core.vendors(id),
  due_on        date,
  status        text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','ORDERED','RECEIVED','REVIEWED','ISSUE','WAIVED')),
  finding       text check (finding is null or char_length(finding) <= 4000),
  document_id   uuid references public.documents(id) on delete set null,
  sort          int not null default 0,
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, pursuit_id) references pm.dev_pursuits (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dev_save_pursuit(p_location uuid, p_pursuit uuid default null, p_fields jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); f jsonb := coalesce(p_fields, '{}'); k text; v uuid; v_pj uuid := pm.access_try_uuid(f ->> 'pursuit_job_id');
begin
  for k in select jsonb_object_keys(f) loop
    if k not in ('name','address','parcels','product_type','asking_price_cents','contract_price_cents','pursuit_budget_cents','earnest_money_cents','earnest_refundable',
                 'loi_on','contract_on','dd_expires_on','earnest_hard_on','closing_on','pursuit_job_id','owner_membership_id','notes') then
      raise exception 'PM_INVALID: % is not a pursuit field', k using errcode = '22023';
    end if;
  end loop;
  -- security review M6: the pursuit job (where pursuit cost lands) is at this sponsor company and the caller edits its financials
  if v_pj is not null then
    if not exists (select 1 from core.jobs j where j.id = v_pj and j.org_id = v_org and j.location_id = p_location) then
      raise exception 'PM_INVALID: the pursuit job must be at this company' using errcode = '22023';
    end if;
    perform pm._wc_require_job('projects.financials', 'edit', v_pj);
  end if;
  if p_pursuit is null then
    if nullif(btrim(coalesce(f ->> 'name', '')), '') is null then raise exception 'PM_INVALID: name the site' using errcode = '22023'; end if;
    insert into pm.dev_pursuits (org_id, location_id, name) values (v_org, p_location, left(btrim(f ->> 'name'), 200)) returning id into v;
  else
    select id into v from pm.dev_pursuits where id = p_pursuit and org_id = v_org and location_id = p_location and stage not in ('GO','DEAD') for update;
    if v is null then raise exception 'PM_INVALID: that pursuit is closed or at another company' using errcode = '22023'; end if;
  end if;
  update pm.dev_pursuits set
    name = case when f ? 'name' then coalesce(nullif(left(btrim(f ->> 'name'), 200), ''), name) else name end,
    address = case when f ? 'address' then left(f ->> 'address', 500) else address end,
    parcels = case when f ? 'parcels' then array(select left(x, 60) from jsonb_array_elements_text(f -> 'parcels') x limit 50) else parcels end,
    product_type = case when f ? 'product_type' then coalesce(nullif(f ->> 'product_type', ''), product_type) else product_type end,
    asking_price_cents = case when f ? 'asking_price_cents' then pm._x_try_bigint(f ->> 'asking_price_cents') else asking_price_cents end,
    contract_price_cents = case when f ? 'contract_price_cents' then pm._x_try_bigint(f ->> 'contract_price_cents') else contract_price_cents end,
    pursuit_budget_cents = case when f ? 'pursuit_budget_cents' then pm._x_try_bigint(f ->> 'pursuit_budget_cents') else pursuit_budget_cents end,
    earnest_money_cents = case when f ? 'earnest_money_cents' then pm._x_try_bigint(f ->> 'earnest_money_cents') else earnest_money_cents end,
    earnest_refundable = case when f ? 'earnest_refundable' then coalesce(pm._x_try_bool(f ->> 'earnest_refundable'), earnest_refundable) else earnest_refundable end,
    loi_on = case when f ? 'loi_on' then pm._x_try_date(f ->> 'loi_on') else loi_on end,
    contract_on = case when f ? 'contract_on' then pm._x_try_date(f ->> 'contract_on') else contract_on end,
    dd_expires_on = case when f ? 'dd_expires_on' then pm._x_try_date(f ->> 'dd_expires_on') else dd_expires_on end,
    earnest_hard_on = case when f ? 'earnest_hard_on' then pm._x_try_date(f ->> 'earnest_hard_on') else earnest_hard_on end,
    closing_on = case when f ? 'closing_on' then pm._x_try_date(f ->> 'closing_on') else closing_on end,
    pursuit_job_id = case when f ? 'pursuit_job_id' then v_pj else pursuit_job_id end,
    owner_membership_id = case when f ? 'owner_membership_id' then pm.access_try_uuid(f ->> 'owner_membership_id') else owner_membership_id end,
    notes = case when f ? 'notes' then left(f ->> 'notes', 4000) else notes end,
    updated_at = now()
  where id = v;
  return v;
end $$;

create or replace function pm.dev_advance_pursuit(p_pursuit uuid, p_stage text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dev_pursuits%rowtype; v_rank int; v_now int;
begin
  select * into p from pm.dev_pursuits x where x.id = p_pursuit and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: pursuit not found' using errcode = '42501'; end if;
  if p.stage in ('GO','DEAD') then raise exception 'PM_INVALID: this pursuit is closed (%)', lower(p.stage) using errcode = '22023'; end if;
  if p_stage not in ('IDENTIFIED','LOI','UNDER_CONTRACT','GO_NO_GO') then raise exception 'PM_INVALID: move to identified, LOI, under contract or go / no-go (use Go or Dead deal to close it)' using errcode = '22023'; end if;
  update pm.dev_pursuits set stage = p_stage, updated_at = now(),
         loi_on = case when p_stage = 'LOI' then coalesce(loi_on, current_date) else loi_on end,
         contract_on = case when p_stage = 'UNDER_CONTRACT' then coalesce(contract_on, current_date) else contract_on end
   where id = p.id;
  return jsonb_build_object('id', p.id, 'stage', p_stage);
end $$;

-- The standard DD checklist (title commitment, ALTA survey, Phase I ESA, geotech, zoning letter,
-- utilities, traffic, appraisal), due by the DD expiry when it is known.
create or replace function pm.dev_seed_dd(p_pursuit uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dev_pursuits%rowtype; n int := 0; r record;
begin
  select * into p from pm.dev_pursuits x where x.id = p_pursuit and x.org_id = public.get_org_id();
  if p.id is null then raise exception 'PM_FORBIDDEN: pursuit not found' using errcode = '42501'; end if;
  for r in select * from (values (1,'TITLE','Title commitment and exceptions'), (2,'SURVEY','ALTA survey'), (3,'PHASE_I','Phase I environmental site assessment'),
                                 (4,'GEOTECH','Geotechnical report'), (5,'ZONING','Zoning verification letter'), (6,'UTILITIES','Utility availability letters'),
                                 (7,'TRAFFIC','Traffic study'), (8,'APPRAISAL','Appraisal')) t(o, k, ttl) loop
    if not exists (select 1 from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.kind = r.k) then
      insert into pm.dev_dd_items (org_id, pursuit_id, kind, title, due_on, sort) values (p.org_id, p.id, r.k, r.ttl, coalesce(p.dd_expires_on - 7, null), r.o);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function pm.dev_update_dd_item(p_item uuid, p_fields jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dev_dd_items%rowtype; f jsonb := coalesce(p_fields, '{}');
begin
  select * into d from pm.dev_dd_items x where x.id = p_item and x.org_id = public.get_org_id() for update;
  if d.id is null then raise exception 'PM_FORBIDDEN: item not found' using errcode = '42501'; end if;
  update pm.dev_dd_items set
    status = case when f ? 'status' then coalesce(nullif(f ->> 'status', ''), status) else status end,
    owner_name = case when f ? 'owner_name' then left(f ->> 'owner_name', 200) else owner_name end,
    vendor_id = case when f ? 'vendor_id' then (select v.id from core.vendors v where v.id = pm.access_try_uuid(f ->> 'vendor_id') and v.org_id = d.org_id) else vendor_id end,
    due_on = case when f ? 'due_on' then pm._x_try_date(f ->> 'due_on') else due_on end,
    finding = case when f ? 'finding' then left(f ->> 'finding', 4000) else finding end,
    document_id = case when f ? 'document_id' then (select x.id from public.documents x where x.id = pm.access_try_uuid(f ->> 'document_id') and x.org_id = d.org_id) else document_id end,
    updated_at = now()
  where id = d.id;
  return d.id;
end $$;

-- Dead deal: closes the pursuit and hands Books the write-off of the pursuit costs carried on the
-- sponsor's pursuit job (Books owns the GL; this is the documented request).
create or replace function pm.dev_kill_pursuit(p_pursuit uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dev_pursuits%rowtype; v_cost bigint := 0; v_req uuid;
begin
  select * into p from pm.dev_pursuits x where x.id = p_pursuit and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: pursuit not found' using errcode = '42501'; end if;
  if p.stage in ('GO','DEAD') then raise exception 'PM_INVALID: this pursuit is already %', lower(p.stage) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: say why the deal died' using errcode = '22023'; end if;
  if p.pursuit_job_id is not null then
    select coalesce(sum(c.amount_cents), 0)::bigint into v_cost from pm.job_costs c where c.org_id = p.org_id and c.job_id = p.pursuit_job_id and c.lifecycle = 'CLEARED';
  end if;
  update pm.dev_pursuits set stage = 'DEAD', dead_reason = left(btrim(p_reason), 1000), dead_at = now(), updated_at = now() where id = p.id;
  v_req := pm._wc_books_request(p.org_id, p.location_id, p.pursuit_job_id, 'DEAD_DEAL_WRITE_OFF', 'dev_pursuits', p.id,
    jsonb_build_object('pursuit_id', p.id, 'site', p.name, 'pursuit_job_id', p.pursuit_job_id, 'pursuit_cost_cents', v_cost,
                       'earnest_money_cents', p.earnest_money_cents, 'earnest_refundable', p.earnest_refundable,
                       'earnest_at_risk', not p.earnest_refundable or (p.earnest_hard_on is not null and p.earnest_hard_on <= current_date), 'reason', btrim(p_reason)));
  return jsonb_build_object('id', p.id, 'stage', 'DEAD', 'books_request_id', v_req, 'pursuit_cost_cents', v_cost);
end $$;

-- Go: the pursuit becomes the development project (an existing job), its dates become key dates.
create or replace function pm.dev_go_pursuit(p_pursuit uuid, p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dev_pursuits%rowtype; j record; n int := 0;
begin
  select * into p from pm.dev_pursuits x where x.id = p_pursuit and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: pursuit not found' using errcode = '42501'; end if;
  if p.stage in ('GO','DEAD') then raise exception 'PM_INVALID: this pursuit is already %', lower(p.stage) using errcode = '22023'; end if;
  select * into j from pm._x_job(p_job);
  if not (pm.access_is_service() or pm.access_can_job('projects.financials', 'edit', p_job)) then
    raise exception 'PM_FORBIDDEN: requires projects.financials:edit on the development job' using errcode = '42501';
  end if;
  insert into pm.dev_projects (org_id, job_id) values (p.org_id, p_job) on conflict do nothing;
  update pm.dev_projects set stage = case when stage = 'PURSUIT' then 'UNDER_CONTRACT' else stage end, address = coalesce(address, p.address),
         parcels = case when cardinality(parcels) = 0 then p.parcels else parcels end, product_type = p.product_type, pursuit_id = p.id,
         sponsor_location_id = coalesce(sponsor_location_id, p.location_id), updated_at = now()
   where org_id = p.org_id and job_id = p_job;
  insert into pm.dev_key_dates (org_id, job_id, kind, label, due_on)
  select p.org_id, p_job, k, lbl, d from (values ('DD_EXPIRY', 'Due diligence expires', p.dd_expires_on), ('EARNEST_HARD_DATE', 'Earnest money goes hard', p.earnest_hard_on),
                                                ('PSA_CLOSING', 'Land closing', p.closing_on)) v(k, lbl, d)
   where d is not null and not exists (select 1 from pm.dev_key_dates x where x.org_id = p.org_id and x.job_id = p_job and x.kind = v.k and x.due_on = v.d);
  get diagnostics n = row_count;
  update pm.dev_pursuits set stage = 'GO', job_id = p_job, updated_at = now() where id = p.id;
  return jsonb_build_object('id', p.id, 'job_id', p_job, 'key_dates_added', n);
end $$;

create or replace function pm.dev_pursuit_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v jsonb;
begin
  select coalesce(jsonb_agg(x order by x ->> 'stage_rank', x ->> 'name'), '[]') into v from (
    select jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'stage', p.stage,
             'stage_rank', array_position(array['IDENTIFIED','LOI','UNDER_CONTRACT','GO_NO_GO','GO','DEAD'], p.stage),
             'product_type', p.product_type, 'contract_price_cents', p.contract_price_cents, 'pursuit_budget_cents', p.pursuit_budget_cents,
             'earnest_money_cents', p.earnest_money_cents, 'earnest_refundable', p.earnest_refundable,
             'pursuit_spent_cents', (select coalesce(sum(c.amount_cents), 0)::bigint from pm.job_costs c where c.org_id = p.org_id and c.job_id = p.pursuit_job_id and c.lifecycle in ('CLEARED','PENDING')),
             'dd_expires_on', p.dd_expires_on, 'earnest_hard_on', p.earnest_hard_on, 'closing_on', p.closing_on,
             'days_to_hard_date', case when p.earnest_hard_on is not null then p.earnest_hard_on - current_date end,
             'dd_total', (select count(*) from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id),
             'dd_done', (select count(*) from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status in ('REVIEWED','WAIVED')),
             'job_id', p.job_id,
             'open_risks', to_jsonb(array_remove(array[
                case when exists (select 1 from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status = 'ISSUE')
                     then format('%s due-diligence issue(s): %s', (select count(*) from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status = 'ISSUE'),
                                 (select string_agg(d.title, ', ') from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status = 'ISSUE')) end,
                case when exists (select 1 from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status not in ('REVIEWED','WAIVED') and d.due_on < current_date)
                     then format('%s overdue due-diligence item(s)', (select count(*) from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id and d.status not in ('REVIEWED','WAIVED') and d.due_on < current_date)) end,
                case when p.earnest_hard_on is not null and p.earnest_hard_on - current_date between 0 and 14 and p.stage not in ('GO','DEAD')
                     then format('Earnest money goes hard in %s day(s)', p.earnest_hard_on - current_date) end,
                case when p.pursuit_budget_cents is not null and p.pursuit_job_id is not null
                          and (select coalesce(sum(c.amount_cents), 0) from pm.job_costs c where c.org_id = p.org_id and c.job_id = p.pursuit_job_id and c.lifecycle in ('CLEARED','PENDING')) > p.pursuit_budget_cents
                     then 'Pursuit spend is over its budget' end], null)),
             'dd', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'status', d.status, 'due_on', d.due_on, 'owner', d.owner_name) order by d.sort)
                               from pm.dev_dd_items d where d.org_id = p.org_id and d.pursuit_id = p.id), '[]')) as x
      from pm.dev_pursuits p where p.org_id = v_org and p.location_id = p_location and (p.stage <> 'DEAD' or p.dead_at > now() - interval '90 days')) s;
  return jsonb_build_object('pursuits', v);
end $$;

-- D2. Entitlements depth (RED-05): conditions of approval and incentive agreements ---------------
create table if not exists pm.dev_entitlement_conditions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  entitlement_id  uuid not null,
  condition       text not null check (char_length(btrim(condition)) between 1 and 2000),
  due_on          date,
  owner_name      text check (owner_name is null or char_length(owner_name) <= 200),
  status          text not null default 'OPEN' check (status in ('OPEN','MET','WAIVED')),
  met_on          date,
  document_id     uuid references public.documents(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, entitlement_id) references pm.entitlements (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dev_incentives (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  kind            text not null check (kind in ('TIF','ABATEMENT','GRANT','TAX_CREDIT','OTHER')),
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  authority       text,
  amount_cents    bigint check (amount_cents is null or amount_cents >= 0),
  term_years      int check (term_years is null or term_years between 0 and 50),
  status          text not null default 'PURSUING' check (status in ('PURSUING','APPLIED','APPROVED','EXECUTED','DENIED','EXPIRED')),
  approved_on     date,
  conditions      text check (conditions is null or char_length(conditions) <= 4000),
  document_id     uuid references public.documents(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dev_add_entitlement_condition(p_entitlement uuid, p_condition text, p_due_on date default null, p_owner text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e record; v uuid;
begin
  select x.org_id, x.id into e from pm.entitlements x where x.id = p_entitlement and x.org_id = public.get_org_id();
  if e.id is null then raise exception 'PM_FORBIDDEN: entitlement not found' using errcode = '42501'; end if;
  insert into pm.dev_entitlement_conditions (org_id, entitlement_id, condition, due_on, owner_name)
  values (e.org_id, e.id, left(btrim(p_condition), 2000), p_due_on, left(p_owner, 200)) returning id into v;
  return v;
end $$;

create or replace function pm.dev_set_condition_status(p_condition uuid, p_status text, p_document uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  if p_status not in ('OPEN','MET','WAIVED') then raise exception 'PM_INVALID: status' using errcode = '22023'; end if;
  if p_document is not null then
    perform pm._wc_check_document(public.get_org_id(), (select e.job_id from pm.dev_entitlement_conditions c join pm.entitlements e on e.id = c.entitlement_id
                                                         where c.id = p_condition and c.org_id = public.get_org_id()), p_document);
  end if;
  update pm.dev_entitlement_conditions set status = p_status, met_on = case when p_status = 'MET' then current_date end, document_id = coalesce(p_document, document_id)
   where id = p_condition and org_id = public.get_org_id() returning id into v;
  if v is null then raise exception 'PM_FORBIDDEN: condition not found' using errcode = '42501'; end if;
  return v;
end $$;

-- Rezoning, site plan, plat, variances, hearings, conditions, permits through TCO / CO, and
-- incentive agreements (amounts only for job financials).
create or replace function pm.dev_entitlement_board(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_money boolean;
begin
  select * into j from pm._x_job(p_job);
  v_money := pm._x_sees('projects.financials', 'view', j.location_id, p_job);
  return jsonb_build_object(
    'entitlements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'name', e.name, 'authority', e.authority, 'reference', e.reference_number,
                                 'status', e.status, 'target_on', e.target_on, 'submitted_on', e.submitted_on, 'hearing_on', e.hearing_on, 'approved_on', e.approved_on,
                                 'expires_on', e.expires_on,
                                 'conditions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'condition', c.condition, 'due_on', c.due_on, 'status', c.status, 'owner', c.owner_name) order by c.due_on nulls last)
                                                          from pm.dev_entitlement_conditions c where c.org_id = e.org_id and c.entitlement_id = e.id), '[]'))
                               order by e.sort, e.target_on nulls last) from pm.entitlements e where e.org_id = j.org_id and e.job_id = p_job), '[]'),
    'incentives', coalesce((select jsonb_agg(pm._wc_strip(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name, 'authority', i.authority, 'amount_cents', i.amount_cents,
                                 'term_years', i.term_years, 'status', i.status, 'approved_on', i.approved_on, 'conditions', i.conditions), v_money) order by i.created_at)
                             from pm.dev_incentives i where i.org_id = j.org_id and i.job_id = p_job), '[]'),
    'open_conditions', (select count(*) from pm.dev_entitlement_conditions c join pm.entitlements e on e.id = c.entitlement_id
                         where e.org_id = j.org_id and e.job_id = p_job and c.status = 'OPEN'));
end $$;

-- D3. Covenants + the key-dates calendar (RED-06) ----------------------------------------------
create table if not exists pm.dev_covenants (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  kind           text not null check (kind in ('DSCR','LTV','DEBT_YIELD','MIN_LIQUIDITY','NET_WORTH','REPORTING','INSURANCE','OTHER')),
  name           text not null check (char_length(btrim(name)) between 1 and 200),
  party          text not null default 'LENDER' check (party in ('LENDER','INVESTOR','AUTHORITY')),
  frequency      text not null default 'QUARTERLY' check (frequency in ('MONTHLY','QUARTERLY','ANNUAL','ONCE')),
  comparator     text check (comparator is null or comparator in ('>=','<=')),
  threshold      numeric(16,4),
  next_due_on    date not null,
  reminder_days  int not null default 14 check (reminder_days between 0 and 365),
  last_value     numeric(16,4),
  last_tested_on date,
  status         text not null default 'OK' check (status in ('OK','BREACH','WAIVED','ENDED')),
  notes          text check (notes is null or char_length(notes) <= 2000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dev_save_covenant(p_job uuid, p_covenant uuid default null, p_fields jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; f jsonb := coalesce(p_fields, '{}'); v uuid;
begin
  select * into j from pm._x_job(p_job);
  if p_covenant is null then
    insert into pm.dev_covenants (org_id, job_id, kind, name, party, frequency, comparator, threshold, next_due_on, reminder_days, notes)
    values (j.org_id, p_job, coalesce(f ->> 'kind', 'REPORTING'), left(btrim(coalesce(f ->> 'name', '')), 200), coalesce(f ->> 'party', 'LENDER'),
            coalesce(f ->> 'frequency', 'QUARTERLY'), nullif(f ->> 'comparator', ''), pm._x_try_num(f ->> 'threshold'),
            coalesce(pm._x_try_date(f ->> 'next_due_on'), current_date + 90), coalesce(pm._x_try_num(f ->> 'reminder_days')::int, 14), left(f ->> 'notes', 2000))
    returning id into v;
  else
    update pm.dev_covenants set
      name = coalesce(nullif(left(btrim(f ->> 'name'), 200), ''), name), frequency = coalesce(nullif(f ->> 'frequency', ''), frequency),
      comparator = case when f ? 'comparator' then nullif(f ->> 'comparator', '') else comparator end,
      threshold = case when f ? 'threshold' then pm._x_try_num(f ->> 'threshold') else threshold end,
      next_due_on = coalesce(pm._x_try_date(f ->> 'next_due_on'), next_due_on), reminder_days = coalesce(pm._x_try_num(f ->> 'reminder_days')::int, reminder_days),
      status = coalesce(nullif(f ->> 'status', ''), status), notes = case when f ? 'notes' then left(f ->> 'notes', 2000) else notes end, updated_at = now()
    where id = p_covenant and org_id = j.org_id and job_id = p_job returning id into v;
    if v is null then raise exception 'PM_FORBIDDEN: covenant not found' using errcode = '42501'; end if;
  end if;
  return v;
end $$;

-- Record a test result (value vs threshold) and roll the next due date by the frequency.
create or replace function pm.dev_test_covenant(p_covenant uuid, p_value numeric default null, p_on date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.dev_covenants%rowtype; v_ok boolean; v_next date;
begin
  select * into c from pm.dev_covenants x where x.id = p_covenant and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: covenant not found' using errcode = '42501'; end if;
  v_ok := case when c.comparator is null or c.threshold is null or p_value is null then true
               when c.comparator = '>=' then p_value >= c.threshold else p_value <= c.threshold end;
  v_next := case c.frequency when 'MONTHLY' then c.next_due_on + interval '1 month' when 'QUARTERLY' then c.next_due_on + interval '3 months'
                             when 'ANNUAL' then c.next_due_on + interval '1 year' else c.next_due_on end;
  update pm.dev_covenants set last_value = p_value, last_tested_on = coalesce(p_on, current_date), status = case when c.frequency = 'ONCE' and v_ok then 'ENDED' when v_ok then 'OK' else 'BREACH' end,
         next_due_on = v_next, updated_at = now() where id = c.id;
  return jsonb_build_object('id', c.id, 'passed', v_ok, 'next_due_on', v_next);
end $$;

-- Every date that matters across the company's development projects and pursuits, in one list.
create or replace function pm.dev_calendar(p_location uuid default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_from date := coalesce(p_from, current_date - 7); v_to date := coalesce(p_to, current_date + 120); v jsonb;
begin
  if p_location is not null then perform pm._wc_loc(p_location); end if;
  with jobs as (
    select j.id, j.job_number, j.name, j.location_id from core.jobs j join pm.dev_projects d on d.org_id = j.org_id and d.job_id = j.id
     where j.org_id = v_org and (p_location is null or j.location_id = p_location) and (pm.access_is_service() or j.id in (select pm.my_job_ids()))
  ), items as (
    select k.job_id, 'KEY_DATE' as source, k.kind, coalesce(k.label, initcap(replace(lower(k.kind), '_', ' '))) as label, k.due_on, k.status, k.reminder_days, k.id
      from pm.dev_key_dates k join jobs on jobs.id = k.job_id where k.org_id = v_org and k.status = 'OPEN'
    union all
    select c.job_id, 'COVENANT', c.kind, c.name, c.next_due_on, c.status, c.reminder_days, c.id
      from pm.dev_covenants c join jobs on jobs.id = c.job_id where c.org_id = v_org and c.status in ('OK','BREACH')
       and (pm.access_is_service() or c.job_id in (select pm.my_money_job_ids('projects.financials')))
    union all
    select e.job_id, 'ENTITLEMENT', e.kind, e.name || ' hearing', e.hearing_on, e.status, 14, e.id
      from pm.entitlements e join jobs on jobs.id = e.job_id where e.org_id = v_org and e.hearing_on is not null and e.status in ('SUBMITTED','UNDER_REVIEW','HEARING_SCHEDULED')
    union all
    select e.job_id, 'ENTITLEMENT', e.kind, e.name || ' expires', e.expires_on, e.status, 60, e.id
      from pm.entitlements e join jobs on jobs.id = e.job_id where e.org_id = v_org and e.expires_on is not null and e.status in ('APPROVED','APPROVED_WITH_CONDITIONS')
    union all
    select ec.entitlement_id, 'CONDITION', 'CONDITION', left(ec.condition, 120), ec.due_on, ec.status, 14, ec.id
      from pm.dev_entitlement_conditions ec join pm.entitlements e on e.id = ec.entitlement_id join jobs on jobs.id = e.job_id
     where ec.org_id = v_org and ec.status = 'OPEN' and ec.due_on is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'job_id', coalesce(jb.id, (select e.job_id from pm.entitlements e where e.id = i.job_id)),
            'job_number', coalesce(jb.job_number, (select j2.job_number from pm.entitlements e join core.jobs j2 on j2.id = e.job_id where e.id = i.job_id)),
            'source', i.source, 'kind', i.kind, 'label', i.label, 'due_on', i.due_on, 'status', i.status,
            'in_window', i.due_on - current_date <= i.reminder_days, 'overdue', i.due_on < current_date) order by i.due_on), '[]') into v
    from items i left join jobs jb on jb.id = i.job_id
   where i.due_on between v_from and v_to;
  -- pursuit dates (sponsor company; financials holders)
  v := v || coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'pursuit_id', p.id, 'source', 'PURSUIT', 'kind', k, 'label', p.name || ': ' || lbl, 'due_on', d,
                                                            'status', p.stage, 'in_window', d - current_date <= 14, 'overdue', d < current_date) order by d)
                        from pm.dev_pursuits p cross join lateral (values ('DD_EXPIRY', 'due diligence expires', p.dd_expires_on), ('EARNEST_HARD_DATE', 'earnest goes hard', p.earnest_hard_on),
                                                                           ('PSA_CLOSING', 'closing', p.closing_on)) v(k, lbl, d)
                       where p.org_id = v_org and (p_location is null or p.location_id = p_location) and p.stage not in ('GO','DEAD') and d between v_from and v_to
                         and (pm.access_is_service() or p.location_id in (select pm.my_location_ids('projects.financials', 'view')))), '[]');
  return jsonb_build_object('from', v_from, 'to', v_to, 'items', v);
end $$;

-- The reminder sweep: anything inside its window is announced once per day to the job team and the
-- company's financials holders.
create or replace function pm.dev_send_date_reminders(p_location uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); c jsonb; i jsonb; n int := 0; v_to uuid[];
begin
  perform pm._wc_require_location('projects.jobs', 'view', p_location);
  c := pm.dev_calendar(p_location, current_date - 3, current_date + 365);
  for i in select x from jsonb_array_elements(c -> 'items') x where (x ->> 'in_window')::boolean loop
    v_to := array(select distinct u from unnest(coalesce((select array_agg(jm.membership_id) from pm.job_members jm where jm.org_id = v_org and jm.job_id = pm.access_try_uuid(i ->> 'job_id')), '{}')
                                              || core.notify_members_with(v_org, p_location, 'projects.financials', 'view')) u);
    -- neutral text for everyone; the date's label (loan, covenant, PSA terms) only for financials (L7)
    n := n + pm._wc_fanout(v_org, 'development.key_date_due', p_location, pm.access_try_uuid(i ->> 'job_id'), 'dev_key_dates', pm.access_try_uuid(i ->> 'id'), v_to,
      left(format('%s %s: a development date', case when (i ->> 'overdue')::boolean then 'Overdue' else 'Due' end, to_char((i ->> 'due_on')::date, 'Mon DD')), 200),
      left(concat_ws(' · ', i ->> 'job_number', 'open the calendar'), 300), '/development/calendar',
      'devdate:' || (i ->> 'id') || ':' || (i ->> 'kind') || ':' || to_char(current_date, 'YYYY-MM-DD'),
      'projects.financials',
      left(format('%s %s: %s', case when (i ->> 'overdue')::boolean then 'Overdue' else 'Due' end, to_char((i ->> 'due_on')::date, 'Mon DD'), i ->> 'label'), 200),
      left(concat_ws(' · ', i ->> 'job_number', lower(i ->> 'source')), 300));
  end loop;
  return n;
end $$;

-- D4. Interest reserve + capitalized interest (RED-15) ----------------------------------------
create table if not exists pm.dev_capitalized_interest (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  month          date not null check (month = date_trunc('month', month)::date),
  interest_cents bigint not null check (interest_cents >= 0),
  source         text not null default 'ESTIMATE' check (source in ('ESTIMATE','LENDER_STATEMENT','BOOKS')),
  note           text,
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, month, source),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dev_record_interest(p_job uuid, p_month date, p_interest_cents bigint, p_source text default 'LENDER_STATEMENT', p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v uuid;
begin
  select * into j from pm._x_job(p_job);
  if p_interest_cents is null or p_interest_cents < 0 then raise exception 'PM_INVALID: interest must be zero or more' using errcode = '22023'; end if;
  insert into pm.dev_capitalized_interest (org_id, job_id, month, interest_cents, source, note)
  values (j.org_id, p_job, date_trunc('month', p_month)::date, p_interest_cents, coalesce(p_source, 'LENDER_STATEMENT'), left(p_note, 500))
  on conflict (org_id, job_id, month, source) do update set interest_cents = excluded.interest_cents, note = excluded.note
  returning id into v;
  return v;
end $$;

-- Reserve remaining vs projected burn to completion; capitalized interest by month (lender
-- statements win over estimates); capitalization start / stop dates.
create or replace function pm.dev_interest_reserve(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; s pm.draw_schedules%rowtype; d pm.dev_projects%rowtype; v_reserve bigint := 0; v_used bigint := 0; v_monthly bigint; v_months_left int; v_by jsonb;
  v_finish date;
begin
  select * into j from pm._x_job(p_job);
  select * into s from pm.draw_schedules x where x.org_id = j.org_id and x.job_id = p_job and x.status in ('ACTIVE','DRAFT') order by (x.status = 'ACTIVE') desc, x.created_at limit 1;
  select * into d from pm.dev_projects x where x.org_id = j.org_id and x.job_id = p_job;
  if s.id is not null then
    select coalesce(sum(coalesce(l.revised_cents, l.original_cents)), 0)::bigint into v_reserve from pm.draw_budget_lines l
     where l.org_id = j.org_id and l.draw_schedule_id = s.id and l.category = 'INTEREST_RESERVE';
    if v_reserve = 0 then v_reserve := s.interest_reserve_cents; end if;
    select coalesce(sum(coalesce(dl.approved_cents, dl.requested_cents)), 0)::bigint into v_used from pm.draw_lines dl
      join pm.draw_budget_lines l on l.id = dl.draw_budget_line_id join pm.draws dr on dr.id = dl.draw_id
     where dl.org_id = j.org_id and dl.draw_schedule_id = s.id and l.category = 'INTEREST_RESERVE' and dr.status in ('APPROVED','FUNDED');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'interest_cents', m.interest_cents, 'source', m.source) order by m.month), '[]') into v_by
    from (select distinct on (ci.month) ci.month, ci.interest_cents, ci.source from pm.dev_capitalized_interest ci where ci.org_id = j.org_id and ci.job_id = p_job
           order by ci.month, array_position(array['BOOKS','LENDER_STATEMENT','ESTIMATE'], ci.source)) m;
  v_monthly := coalesce(s.projected_monthly_interest_cents,
                        (select (x ->> 'interest_cents')::bigint from jsonb_array_elements(v_by) x order by x ->> 'month' desc limit 1));
  select coalesce(max(coalesce(t.early_finish, t.due_on)), (select k.due_on from pm.dev_key_dates k where k.org_id = j.org_id and k.job_id = p_job and k.kind = 'OUTSIDE_COMPLETION' order by k.due_on limit 1))
    into v_finish from pm.tasks t where t.org_id = j.org_id and t.job_id = p_job and t.is_milestone and t.title ilike '%stabiliz%';
  v_finish := coalesce(v_finish, (select k.due_on from pm.dev_key_dates k where k.org_id = j.org_id and k.job_id = p_job and k.kind in ('OUTSIDE_COMPLETION','LOAN_MATURITY') order by k.due_on limit 1));
  v_months_left := case when v_finish is not null then greatest((extract(year from age(v_finish, current_date)) * 12 + extract(month from age(v_finish, current_date)))::int, 0) end;
  return jsonb_build_object('reserve_cents', v_reserve, 'used_cents', v_used, 'remaining_cents', v_reserve - v_used,
    'projected_monthly_cents', v_monthly, 'months_to_completion', v_months_left,
    'projected_burn_cents', case when v_monthly is not null and v_months_left is not null then v_monthly * v_months_left end,
    'shortfall_cents', case when v_monthly is not null and v_months_left is not null then greatest(v_monthly * v_months_left - (v_reserve - v_used), 0) end,
    'runway_months', case when coalesce(v_monthly, 0) > 0 then round((v_reserve - v_used)::numeric / v_monthly, 1) end,
    'capitalized_by_month', v_by, 'capitalized_total_cents', (select coalesce(sum((x ->> 'interest_cents')::bigint), 0) from jsonb_array_elements(v_by) x),
    'capitalization_start_on', d.cap_interest_start_on, 'capitalization_stop_on', d.cap_interest_stop_on, 'completion_basis_on', v_finish);
end $$;

-- D5. Developer fee and CM fee schedule (RED-16) -------------------------------------------------
create table if not exists pm.dev_fee_schedules (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  kind              text not null check (kind in ('DEVELOPER_FEE','CM_FEE','ASSET_MGMT_FEE')),
  total_cents       bigint not null check (total_cents >= 0),
  earn_basis        text not null default 'PCT_COMPLETE' check (earn_basis in ('PCT_COMPLETE','MILESTONE','MONTHLY','AT_CLOSING')),
  schedule          jsonb not null default '[]' check (jsonb_typeof(schedule) = 'array'),   -- MILESTONE: [{label, pct, earned_on}]; MONTHLY: [{month, cents}]
  draw_budget_line_id uuid,
  payee_location_id uuid references core.locations(id),     -- the sponsor entity that invoices the SPE
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, kind),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.dev_fee_draws (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  fee_id          uuid not null,
  draw_id         uuid,
  amount_cents    bigint not null check (amount_cents > 0),
  status          text not null default 'REQUESTED' check (status in ('REQUESTED','INVOICED','VOID')),
  books_request_id uuid,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, fee_id) references pm.dev_fee_schedules (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dev_set_fee_schedule(p_job uuid, p_kind text, p_total_cents bigint, p_earn_basis text default 'PCT_COMPLETE', p_schedule jsonb default '[]',
                                                   p_draw_budget_line uuid default null, p_payee_location uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v uuid;
begin
  select * into j from pm._x_job(p_job);
  if p_payee_location is not null then perform pm._wc_loc(p_payee_location); end if;
  insert into pm.dev_fee_schedules (org_id, job_id, kind, total_cents, earn_basis, schedule, draw_budget_line_id, payee_location_id)
  values (j.org_id, p_job, p_kind, p_total_cents, coalesce(p_earn_basis, 'PCT_COMPLETE'), coalesce(p_schedule, '[]'), p_draw_budget_line, p_payee_location)
  on conflict (org_id, job_id, kind) do update set total_cents = excluded.total_cents, earn_basis = excluded.earn_basis, schedule = excluded.schedule,
     draw_budget_line_id = excluded.draw_budget_line_id, payee_location_id = excluded.payee_location_id, updated_at = now()
  returning id into v;
  return v;
end $$;

-- Earned to date by the basis, drawn to date, available to draw; per fee.
create or replace function pm.dev_fee_position(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; f record; v_out jsonb := '[]'; v_pct numeric; v_earned bigint; v_drawn bigint; fin record;
begin
  select * into j from pm._x_job(p_job);
  select * into fin from pm.v_job_financials x where x.org_id = j.org_id and x.job_id = p_job;
  for f in select * from pm.dev_fee_schedules x where x.org_id = j.org_id and x.job_id = p_job order by x.kind loop
    v_pct := case f.earn_basis
               when 'PCT_COMPLETE' then coalesce(fin.pct_complete_cost, 0)
               when 'MILESTONE' then least(coalesce((select sum(pm._x_try_num(m ->> 'pct')) from jsonb_array_elements(f.schedule) m where pm._x_try_date(m ->> 'earned_on') <= current_date), 0), 1)
               when 'AT_CLOSING' then case when exists (select 1 from pm.dev_projects d where d.org_id = j.org_id and d.job_id = p_job and d.stage not in ('PURSUIT','UNDER_CONTRACT','PRE_DEVELOPMENT')) then 1 else 0 end
               else null end;
    v_earned := case when f.earn_basis = 'MONTHLY'
                     then (select coalesce(sum(pm._x_try_bigint(m ->> 'cents')), 0) from jsonb_array_elements(f.schedule) m where pm._x_try_date(m ->> 'month') <= current_date)
                     else pm.res_round(f.total_cents * coalesce(v_pct, 0)) end;
    v_earned := least(v_earned, f.total_cents);
    select coalesce(sum(d.amount_cents), 0)::bigint into v_drawn from pm.dev_fee_draws d where d.org_id = j.org_id and d.fee_id = f.id and d.status <> 'VOID';
    v_out := v_out || jsonb_build_object('fee_id', f.id, 'kind', f.kind, 'earn_basis', f.earn_basis, 'total_cents', f.total_cents, 'earned_pct', v_pct,
                                         'earned_cents', v_earned, 'drawn_cents', v_drawn, 'available_cents', greatest(v_earned - v_drawn, 0), 'remaining_cents', f.total_cents - v_drawn);
  end loop;
  return jsonb_build_object('fees', v_out);
end $$;

-- Draw part of a fee: limited to earned − drawn; the sponsor's intercompany invoice to the SPE is
-- handed to Books (it invoices from the payee entity).
create or replace function pm.dev_request_fee_draw(p_fee uuid, p_amount_cents bigint, p_draw uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dev_fee_schedules%rowtype; pos jsonb; v_avail bigint; v uuid; v_req uuid; v_loc uuid;
begin
  select * into f from pm.dev_fee_schedules x where x.id = p_fee and x.org_id = public.get_org_id();
  if f.id is null then raise exception 'PM_FORBIDDEN: fee not found' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PM_INVALID: amount must be more than zero' using errcode = '22023'; end if;
  if p_draw is not null and not exists (select 1 from pm.draws d where d.org_id = f.org_id and d.id = p_draw and d.job_id = f.job_id) then
    raise exception 'PM_INVALID: that draw is not on this project' using errcode = '22023';
  end if;
  perform pm._wc_require_job('projects.financials', 'view', f.job_id);
  pos := pm.dev_fee_position(f.job_id);
  select (x ->> 'available_cents')::bigint into v_avail from jsonb_array_elements(pos -> 'fees') x where x ->> 'fee_id' = f.id::text;
  if p_amount_cents > coalesce(v_avail, 0) then
    raise exception 'PM_DEV_FEE_NOT_EARNED: only % cents of the % is earned and not yet drawn', coalesce(v_avail, 0), lower(replace(f.kind, '_', ' ')) using errcode = '22023';
  end if;
  insert into pm.dev_fee_draws (org_id, job_id, fee_id, draw_id, amount_cents) values (f.org_id, f.job_id, f.id, p_draw, p_amount_cents) returning id into v;
  select location_id into v_loc from core.jobs where id = f.job_id;
  v_req := pm._wc_books_request(f.org_id, coalesce(f.payee_location_id, v_loc), f.job_id, 'INTERCOMPANY_FEE_INVOICE', 'dev_fee_draws', v,
    jsonb_build_object('fee_draw_id', v, 'kind', f.kind, 'amount_cents', p_amount_cents, 'from_location_id', coalesce(f.payee_location_id, v_loc),
                       'to_job_id', f.job_id, 'to_location_id', v_loc, 'draw_id', p_draw, 'draw_budget_line_id', f.draw_budget_line_id));
  update pm.dev_fee_draws set books_request_id = v_req where id = v;
  return jsonb_build_object('fee_draw_id', v, 'books_request_id', v_req);
end $$;

-- D6. Change orders: funding line + lender consent (RED-19) --------------------------------------
create table if not exists pm.dev_co_funding (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  change_order_id          uuid not null,
  funding                  text not null check (funding in ('CONTINGENCY','BUDGET_LINE','OWNER_EQUITY','GC_CONTINGENCY')),
  contingency_pool         text check (contingency_pool is null or contingency_pool in ('HARD','SOFT','OWNER')),
  cost_code_id             uuid,
  draw_budget_line_id      uuid,
  lender_consent_required  boolean not null default false,
  lender_consent_note      text,
  lender_consented_at      timestamptz,
  lender_consented_by      text,
  lender_consent_document_id uuid references public.documents(id) on delete set null,
  consented_amount_cents   bigint,
  created_by               text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, change_order_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

alter table pm.dev_co_funding add column if not exists lender_consent_document_id uuid references public.documents(id) on delete set null;
alter table pm.dev_co_funding add column if not exists consented_amount_cents bigint;

create or replace function pm.dev_set_co_funding(p_change_order uuid, p_funding text, p_pool text default null, p_cost_code uuid default null, p_draw_budget_line uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co record; v_thr bigint; v_req boolean; v uuid; v_amt bigint;
begin
  select x.id, x.org_id, x.job_id, x.stage, coalesce(x.cost_impact_cents, x.amount_cents, 0) as amt into co from pm.change_orders x where x.id = p_change_order and x.org_id = public.get_org_id();
  if co.id is null then raise exception 'PM_FORBIDDEN: change order not found' using errcode = '42501'; end if;
  if co.stage in ('APPROVED','VOID') then raise exception 'PM_INVALID: the change order is already %', lower(co.stage) using errcode = '22023'; end if;
  select lender_consent_threshold_cents into v_thr from pm.dev_projects d where d.org_id = co.org_id and d.job_id = co.job_id;
  v_amt := abs(co.amt);
  v_req := (v_thr is not null and v_amt >= v_thr) or (p_funding = 'CONTINGENCY' and v_thr is not null and v_amt >= v_thr);
  insert into pm.dev_co_funding (org_id, job_id, change_order_id, funding, contingency_pool, cost_code_id, draw_budget_line_id, lender_consent_required)
  values (co.org_id, co.job_id, co.id, p_funding, p_pool, p_cost_code, p_draw_budget_line, coalesce(v_req, false))
  on conflict (org_id, change_order_id) do update set funding = excluded.funding, contingency_pool = excluded.contingency_pool, cost_code_id = excluded.cost_code_id,
     draw_budget_line_id = excluded.draw_budget_line_id,
     lender_consent_required = excluded.lender_consent_required or pm.dev_co_funding.lender_consented_at is not null
  returning id into v;
  return jsonb_build_object('funding_id', v, 'lender_consent_required', coalesce(v_req, false), 'threshold_cents', v_thr);
end $$;

drop function if exists pm.dev_record_co_consent(uuid, text);
create or replace function pm.dev_record_co_consent(p_change_order uuid, p_note text, p_document uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid; co record;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'PM_INVALID: record who at the lender consented and how' using errcode = '22023'; end if;
  select x.id, x.org_id, x.job_id, greatest(abs(coalesce(x.amount_cents, 0)), abs(coalesce(x.cost_impact_cents, 0))) as amt into co from pm.change_orders x where x.id = p_change_order and x.org_id = public.get_org_id();
  if co.id is null then raise exception 'PM_FORBIDDEN: change order not found' using errcode = '42501'; end if;
  perform pm._wc_check_document(co.org_id, co.job_id, p_document, 'the consent letter');
  -- consent can be recorded before (or without) a funding line: the gate reads the CO's amount
  insert into pm.dev_co_funding (org_id, job_id, change_order_id, funding, lender_consent_required)
  values (co.org_id, co.job_id, co.id, 'BUDGET_LINE', true)
  on conflict (org_id, change_order_id) do nothing;
  update pm.dev_co_funding set lender_consent_note = left(btrim(p_note), 1000), lender_consented_at = now(), lender_consented_by = pm.current_user_id(),
         lender_consent_document_id = coalesce(p_document, lender_consent_document_id), consented_amount_cents = co.amt
   where org_id = co.org_id and change_order_id = co.id returning id into v;
  return v;
end $$;

-- The gate: a development change order with a consent-required funding row cannot be approved
-- until the lender consented (acts only on change orders this migration's funding rows link).
create or replace function pm.tg_dev_co_consent_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_thr bigint; v_amt bigint; f pm.dev_co_funding%rowtype;
begin
  if not (new.stage = 'APPROVED' and old.stage is distinct from 'APPROVED') then return new; end if;
  select d.lender_consent_threshold_cents into v_thr from pm.dev_projects d where d.org_id = new.org_id and d.job_id = new.job_id;
  v_amt := greatest(abs(coalesce(new.amount_cents, 0)), abs(coalesce(new.cost_impact_cents, 0)));
  select * into f from pm.dev_co_funding x where x.org_id = new.org_id and x.change_order_id = new.id;
  -- security review M4: the CO's amount now, whether or not anyone set a funding line
  if (v_thr is not null and v_amt >= v_thr) or coalesce(f.lender_consent_required, false) then
    if f.lender_consented_at is null then
      raise exception 'PM_DEV_LENDER_CONSENT_REQUIRED: this change order is over the lender''s consent threshold; record the lender''s consent first' using errcode = '55000';
    end if;
    -- consent covers the amount it was given for; a larger change order needs it again
    if f.consented_amount_cents is null or v_amt > f.consented_amount_cents then
      raise exception 'PM_DEV_LENDER_CONSENT_REQUIRED: the change order grew past the amount the lender consented to; record consent for the new amount' using errcode = '55000';
    end if;
    -- the person who typed the consent does not also approve on it, unless the lender's letter is attached
    if f.lender_consent_document_id is null and f.lender_consented_by is not null and f.lender_consented_by = pm.current_user_id() and not pm.access_is_service() then
      raise exception 'PM_SOD_VIOLATION: you recorded the lender''s consent; attach the lender''s letter or have someone else approve' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists a00_dev_co_consent_gate on pm.change_orders;
create trigger a00_dev_co_consent_gate before update of stage on pm.change_orders for each row execute function pm.tg_dev_co_consent_gate();

-- D7. Vendor compliance on the project (RED-20) --------------------------------------------------
create or replace function pm.dev_compliance(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v jsonb;
begin
  select * into j from pm._x_job(p_job);
  select coalesce(jsonb_agg(x order by x ->> 'vendor'), '[]') into v from (
    select jsonb_build_object('vendor_id', vd.id, 'vendor', vd.name,
             'commitments', (select count(*) from pm.commitments c where c.org_id = j.org_id and c.job_id = p_job and c.vendor_id = vd.id and c.status in ('APPROVED','EXECUTED')),
             'coi', (select jsonb_build_object('status', cd.status, 'expires_on', cd.expires_on, 'additional_insured', coalesce((cd.notes ilike '%additional insured%'), false))
                       from pm.compliance_docs cd where cd.org_id = j.org_id and cd.job_id = p_job and cd.vendor_id = vd.id and cd.doc_type = 'COI' order by cd.expires_on desc nulls last limit 1),
             'w9', exists (select 1 from pm.compliance_docs cd where cd.org_id = j.org_id and cd.vendor_id = vd.id and cd.doc_type = 'W9' and cd.status in ('RECEIVED','VERIFIED')),
             'hold', not exists (select 1 from pm.compliance_docs cd where cd.org_id = j.org_id and cd.job_id = p_job and cd.vendor_id = vd.id and cd.doc_type = 'COI'
                                    and cd.status in ('RECEIVED','VERIFIED') and (cd.expires_on is null or cd.expires_on >= current_date))
                     or not exists (select 1 from pm.compliance_docs cd where cd.org_id = j.org_id and cd.vendor_id = vd.id and cd.doc_type = 'W9' and cd.status in ('RECEIVED','VERIFIED')),
             'expiring_in_30', exists (select 1 from pm.compliance_docs cd where cd.org_id = j.org_id and cd.job_id = p_job and cd.vendor_id = vd.id and cd.doc_type = 'COI'
                                          and cd.expires_on between current_date and current_date + 30)) as x
      from core.vendors vd
     where vd.org_id = j.org_id and vd.id in (select c.vendor_id from pm.commitments c where c.org_id = j.org_id and c.job_id = p_job and c.vendor_id is not null
                                              union select i.vendor_id from pm.dev_draw_invoices i where i.org_id = j.org_id and i.job_id = p_job and i.vendor_id is not null)) s;
  return jsonb_build_object('vendors', v, 'on_hold', (select count(*) from jsonb_array_elements(v) x where (x ->> 'hold')::boolean));
end $$;

-- D8. Central invoice inbox (RED-21) ------------------------------------------------------------
create table if not exists pm.dev_invoice_inbox (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),     -- the sponsor inbox
  received_at         timestamptz not null default now(),
  from_address        text check (from_address is null or char_length(from_address) <= 254),
  subject             text check (subject is null or char_length(subject) <= 300),
  document_id         uuid references public.documents(id) on delete set null,
  vendor_id           uuid references core.vendors(id),
  vendor_name         text check (vendor_name is null or char_length(vendor_name) <= 200),
  invoice_number      text check (invoice_number is null or char_length(invoice_number) <= 60),
  invoice_on          date,
  amount_cents        bigint check (amount_cents is null or amount_cents >= 0),
  reference_text      text check (reference_text is null or char_length(reference_text) <= 2000),
  suggested           jsonb not null default '{}' check (jsonb_typeof(suggested) = 'object'),
  duplicate_of        uuid,
  status              text not null default 'NEW' check (status in ('NEW','CONFIRMED','DISMISSED')),
  draw_invoice_id     uuid,
  decided_by          text,
  decided_at          timestamptz,
  unique (org_id, id)
);
create index if not exists pm_dev_invoice_inbox_idx on pm.dev_invoice_inbox (org_id, location_id, status, received_at desc);

-- Rules-only suggestion: the vendor's open commitments on development jobs (one → that job / line /
-- the job's open draw); duplicates = same vendor + invoice number, or same vendor + amount + date.
create or replace function pm.dev_inbox_ingest(p_location uuid, p_item jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); i jsonb := coalesce(p_item, '{}'); v uuid; v_vendor uuid; v_sug jsonb := '{}'; c record; v_n int; v_dup uuid;
  v_amt bigint := pm._x_try_bigint(i ->> 'amount_cents'); v_no text := left(btrim(i ->> 'invoice_number'), 60); v_on date := pm._x_try_date(i ->> 'invoice_on');
begin
  v_vendor := (select vd.id from core.vendors vd where vd.org_id = v_org and (vd.id = pm.access_try_uuid(i ->> 'vendor_id') or lower(vd.name) = lower(btrim(i ->> 'vendor_name'))) limit 1);
  if v_vendor is not null then
    select count(*) into v_n from pm.commitments cm join pm.dev_projects dp on dp.org_id = cm.org_id and dp.job_id = cm.job_id
     where cm.org_id = v_org and cm.vendor_id = v_vendor and cm.status in ('APPROVED','EXECUTED');
    for c in select cm.id, cm.job_id, cm.number, (select l.cost_code_id from pm.commitment_lines l where l.org_id = cm.org_id and l.commitment_id = cm.id order by l.line_no limit 1) as cc
               from pm.commitments cm join pm.dev_projects dp on dp.org_id = cm.org_id and dp.job_id = cm.job_id
              where cm.org_id = v_org and cm.vendor_id = v_vendor and cm.status in ('APPROVED','EXECUTED')
                and (v_n = 1 or (cm.number is not null and coalesce(i ->> 'reference_text', '') || ' ' || coalesce(i ->> 'subject', '') ilike '%' || cm.number || '%'))
              order by cm.created_at limit 1 loop
      v_sug := jsonb_build_object('job_id', c.job_id, 'commitment_id', c.id, 'cost_code_id', c.cc, 'confidence', case when v_n = 1 then 'ONE_OPEN_COMMITMENT' else 'COMMITMENT_NUMBER' end,
        'draw_id', (select d.id from pm.draws d where d.org_id = v_org and d.job_id = c.job_id and d.status in ('DRAFT','RETURNED') order by d.draw_number desc limit 1));
    end loop;
  end if;
  select x.id into v_dup from (
    select ii.id from pm.dev_invoice_inbox ii where ii.org_id = v_org and ii.status <> 'DISMISSED' and ii.vendor_id = v_vendor and v_vendor is not null
       and ((v_no is not null and ii.invoice_number = v_no) or (v_amt is not null and ii.amount_cents = v_amt and ii.invoice_on is not distinct from v_on))
    union all
    select di.id from pm.dev_draw_invoices di where di.org_id = v_org and di.vendor_id = v_vendor and v_vendor is not null and v_no is not null and di.invoice_number = v_no) x limit 1;
  insert into pm.dev_invoice_inbox (org_id, location_id, from_address, subject, document_id, vendor_id, vendor_name, invoice_number, invoice_on, amount_cents, reference_text, suggested, duplicate_of)
  values (v_org, p_location, left(i ->> 'from_address', 254), left(i ->> 'subject', 300),
          (select d.id from public.documents d where d.id = pm.access_try_uuid(i ->> 'document_id') and d.org_id = v_org), v_vendor, left(i ->> 'vendor_name', 200), v_no, v_on, v_amt,
          left(i ->> 'reference_text', 2000), v_sug, v_dup)
  returning id into v;
  return jsonb_build_object('id', v, 'suggested', v_sug, 'duplicate_of', v_dup);
end $$;

-- A person confirms (job / line / commitment / draw may differ from the suggestion) → the invoice is
-- added to the draw for approval routing.
create or replace function pm.dev_inbox_confirm(p_item uuid, p_draw uuid, p_cost_code uuid default null, p_commitment uuid default null, p_allow_duplicate boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare it pm.dev_invoice_inbox%rowtype; d pm.draws%rowtype; v_inv uuid;
begin
  select * into it from pm.dev_invoice_inbox x where x.id = p_item and x.org_id = public.get_org_id() for update;
  if it.id is null then raise exception 'PM_FORBIDDEN: inbox item not found' using errcode = '42501'; end if;
  if it.status <> 'NEW' then raise exception 'PM_INVALID: already %', lower(it.status) using errcode = '22023'; end if;
  if it.duplicate_of is not null and not coalesce(p_allow_duplicate, false) then raise exception 'PM_DEV_DUPLICATE_INVOICE: this looks like an invoice already received' using errcode = '23505'; end if;
  if it.amount_cents is null or it.invoice_number is null then raise exception 'PM_INVALID: fill in the invoice number and amount first' using errcode = '22023'; end if;
  select * into d from pm.draws x where x.id = p_draw and x.org_id = it.org_id;
  if d.id is null then raise exception 'PM_INVALID: pick the draw' using errcode = '22023'; end if;
  if not (pm.access_is_service() or pm.access_can_job('projects.billing', 'edit', d.job_id)) then raise exception 'PM_FORBIDDEN: requires projects.billing:edit on that project' using errcode = '42501'; end if;
  v_inv := pm.dev_add_draw_invoice(d.id, it.vendor_id, it.invoice_number, it.amount_cents, it.invoice_on, coalesce(p_commitment, pm.access_try_uuid(it.suggested ->> 'commitment_id')),
                                   coalesce(p_cost_code, pm.access_try_uuid(it.suggested ->> 'cost_code_id')), null, 0, it.document_id);
  update pm.dev_invoice_inbox set status = 'CONFIRMED', draw_invoice_id = v_inv, decided_by = pm.current_user_id(), decided_at = now() where id = it.id;
  return jsonb_build_object('id', it.id, 'draw_invoice_id', v_inv);
end $$;

create or replace function pm.dev_inbox_dismiss(p_item uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.dev_invoice_inbox set status = 'DISMISSED', decided_by = pm.current_user_id(), decided_at = now()
   where id = p_item and org_id = public.get_org_id() and status = 'NEW' returning id into v;
  if v is null then raise exception 'PM_INVALID: nothing to dismiss' using errcode = '22023'; end if;
  return v;
end $$;

-- D9. GC pay app review (RED-22) ----------------------------------------------------------------
create table if not exists pm.dev_pay_app_reviews (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  commitment_id    uuid not null,
  application_no   int not null check (application_no >= 1),
  period_to        date,
  lines            jsonb not null check (jsonb_typeof(lines) = 'array'),
  issues           jsonb not null default '[]' check (jsonb_typeof(issues) = 'array'),
  totals           jsonb not null default '{}' check (jsonb_typeof(totals) = 'object'),
  status           text not null default 'REVIEWED' check (status in ('REVIEWED','ACCEPTED','RETURNED')),
  reviewed_by      text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Lines: [{line_no, description, scheduled_value_cents, previous_cents, this_period_cents, stored_cents, retainage_cents}]
-- Checks: scheduled value vs the SOV, prior billed tie-out, cumulative over-billing cap, retainage
-- math at the contract %, % complete against the inspector, duplicate lines, stored material.
create or replace function pm.dev_review_pay_app(p_commitment uuid, p_application_no int, p_lines jsonb, p_period_to date default null, p_inspector_pct numeric default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c record; l jsonb; sl record; v_issues jsonb := '[]'; v_ret numeric; v_cum bigint; v_exp bigint; t_sched bigint := 0; t_prev bigint := 0; t_this bigint := 0; t_store bigint := 0;
  t_ret bigint := 0; v_id uuid; v_insp numeric := p_inspector_pct; v_pct numeric; v_prior jsonb; d record;
begin
  select x.* into c from pm.commitments x where x.id = p_commitment and x.org_id = public.get_org_id();
  if c.id is null then raise exception 'PM_FORBIDDEN: commitment not found' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: add the G703 lines' using errcode = '22023'; end if;
  v_ret := coalesce(c.retainage_pct, 0);
  if v_insp is null then
    select dr.inspector_pct_complete into v_insp from pm.draws dr where dr.org_id = c.org_id and dr.job_id = c.job_id and dr.inspector_pct_complete is not null
     order by dr.draw_number desc limit 1;
  end if;
  select r.lines into v_prior from pm.dev_pay_app_reviews r where r.org_id = c.org_id and r.commitment_id = c.id and r.application_no = p_application_no - 1
   order by r.created_at desc limit 1;
  for l in select x from jsonb_array_elements(p_lines) x loop
    select * into sl from pm.commitment_lines x where x.org_id = c.org_id and x.commitment_id = c.id and x.line_no = (l ->> 'line_no')::int;
    v_cum := coalesce(pm._x_try_bigint(l ->> 'previous_cents'), 0) + coalesce(pm._x_try_bigint(l ->> 'this_period_cents'), 0) + coalesce(pm._x_try_bigint(l ->> 'stored_cents'), 0);
    t_sched := t_sched + coalesce(pm._x_try_bigint(l ->> 'scheduled_value_cents'), 0); t_prev := t_prev + coalesce(pm._x_try_bigint(l ->> 'previous_cents'), 0);
    t_this := t_this + coalesce(pm._x_try_bigint(l ->> 'this_period_cents'), 0); t_store := t_store + coalesce(pm._x_try_bigint(l ->> 'stored_cents'), 0);
    t_ret := t_ret + coalesce(pm._x_try_bigint(l ->> 'retainage_cents'), 0);
    if sl.id is null then
      v_issues := v_issues || jsonb_build_object('line_no', l ->> 'line_no', 'check', 'NOT_ON_SOV', 'message', format('Line %s is not on the contract''s schedule of values', l ->> 'line_no'));
      continue;
    end if;
    if coalesce(pm._x_try_bigint(l ->> 'scheduled_value_cents'), 0) <> sl.amount_cents then
      v_issues := v_issues || jsonb_build_object('line_no', sl.line_no, 'check', 'SCHEDULED_VALUE', 'message', format('Line %s scheduled value %s ≠ SOV %s (an unapproved change?)', sl.line_no, core.notify_money_text(pm._x_try_bigint(l ->> 'scheduled_value_cents')), core.notify_money_text(sl.amount_cents)));
    end if;
    v_exp := coalesce((select (p ->> 'previous_cents')::bigint + (p ->> 'this_period_cents')::bigint + coalesce((p ->> 'stored_cents')::bigint, 0)
                         from jsonb_array_elements(v_prior) p where (p ->> 'line_no')::int = sl.line_no), sl.billed_cents);
    if coalesce(pm._x_try_bigint(l ->> 'previous_cents'), 0) <> coalesce(v_exp, 0) then
      v_issues := v_issues || jsonb_build_object('line_no', sl.line_no, 'check', 'PRIOR_TIE_OUT', 'message', format('Line %s previous billed %s ≠ %s billed through the last application', sl.line_no, core.notify_money_text(pm._x_try_bigint(l ->> 'previous_cents')), core.notify_money_text(coalesce(v_exp, 0))));
    end if;
    if v_cum > sl.amount_cents then
      v_issues := v_issues || jsonb_build_object('line_no', sl.line_no, 'check', 'OVER_BILLED', 'message', format('Line %s bills %s to date against a %s scheduled value', sl.line_no, core.notify_money_text(v_cum), core.notify_money_text(sl.amount_cents)));
    end if;
    if abs(coalesce(pm._x_try_bigint(l ->> 'retainage_cents'), 0) - pm.res_round(v_cum * v_ret)) > 100 then
      v_issues := v_issues || jsonb_build_object('line_no', sl.line_no, 'check', 'RETAINAGE', 'message', format('Line %s retainage %s; %s%% of %s is %s', sl.line_no, core.notify_money_text(coalesce(pm._x_try_bigint(l ->> 'retainage_cents'), 0)), round(v_ret * 100, 2), core.notify_money_text(v_cum), core.notify_money_text(pm.res_round(v_cum * v_ret))));
    end if;
    if coalesce(pm._x_try_bigint(l ->> 'stored_cents'), 0) > 0 then
      v_issues := v_issues || jsonb_build_object('line_no', sl.line_no, 'check', 'STORED_MATERIAL', 'severity', 'info', 'message', format('Line %s claims %s stored material — get the invoice, insurance and a photo', sl.line_no, core.notify_money_text(pm._x_try_bigint(l ->> 'stored_cents'))));
    end if;
  end loop;
  for d in select x ->> 'description' as ds, x ->> 'this_period_cents' as amt, count(*) as n from jsonb_array_elements(p_lines) x
            where coalesce(pm._x_try_bigint(x ->> 'this_period_cents'), 0) > 0 group by 1, 2 having count(*) > 1 loop
    v_issues := v_issues || jsonb_build_object('check', 'DUPLICATE', 'message', format('"%s" bills %s on %s lines', d.ds, core.notify_money_text(d.amt::bigint), d.n));
  end loop;
  v_pct := case when t_sched > 0 then round((t_prev + t_this + t_store)::numeric / t_sched, 4) end;
  if v_insp is not null and v_pct is not null and v_pct > v_insp + 0.05 then
    v_issues := v_issues || jsonb_build_object('check', 'INSPECTOR', 'message', format('The pay app claims %s%% complete; the inspector saw %s%%', round(v_pct * 100, 1), round(v_insp * 100, 1)));
  end if;
  -- a viewer gets the check; only financials / commitments edit keeps a review record (L6)
  if not (pm.access_can_job('projects.financials', 'edit', c.job_id) or pm.access_can_job('projects.commitments', 'edit', c.job_id)) then
    return jsonb_build_object('review_id', null, 'saved', false, 'issues', v_issues,
                              'clean', jsonb_array_length(v_issues) = (select count(*) from jsonb_array_elements(v_issues) x where x ->> 'severity' = 'info'), 'pct_complete', v_pct);
  end if;
  insert into pm.dev_pay_app_reviews (org_id, job_id, commitment_id, application_no, period_to, lines, issues, totals)
  values (c.org_id, c.job_id, c.id, p_application_no, p_period_to, p_lines, v_issues,
          jsonb_build_object('scheduled_cents', t_sched, 'previous_cents', t_prev, 'this_period_cents', t_this, 'stored_cents', t_store, 'retainage_cents', t_ret,
                             'pct_complete', v_pct, 'inspector_pct', v_insp, 'net_due_cents', t_prev + t_this + t_store - t_ret - (t_prev - pm.res_round(t_prev * v_ret))))
  returning id into v_id;
  return jsonb_build_object('review_id', v_id, 'issues', v_issues, 'clean', jsonb_array_length(v_issues) = (select count(*) from jsonb_array_elements(v_issues) x where x ->> 'severity' = 'info'),
                            'pct_complete', v_pct);
end $$;

-- D10. Invoice approval routing (RED-23) -------------------------------------------------------
create table if not exists pm.dev_invoice_routes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  min_cents     bigint not null default 0 check (min_cents >= 0),
  max_cents     bigint check (max_cents is null or max_cents > min_cents),
  steps         text[] not null check (cardinality(steps) between 1 and 4 and steps <@ array['DEV_MANAGER','PRINCIPAL','ASSET_MANAGER']::text[]),
  created_at    timestamptz not null default now(),
  unique (org_id, id)
);
-- every chain includes the dev manager (security review round 2)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dev_invoice_routes_dev_manager_chk') then
    alter table pm.dev_invoice_routes add constraint dev_invoice_routes_dev_manager_chk check ('DEV_MANAGER' = any (steps));
  end if;
end $$;

create table if not exists pm.dev_invoice_approvals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  invoice_id    uuid not null,
  step_no       int not null check (step_no between 1 and 4),
  step_role     text not null check (step_role in ('DEV_MANAGER','PRINCIPAL','ASSET_MANAGER')),
  decision      text check (decision is null or decision in ('APPROVE','REJECT')),
  decided_by    text,
  decided_at    timestamptz,
  note          text check (note is null or char_length(note) <= 1000),
  channel       text not null default 'web' check (channel in ('web','mobile','email')),
  unique (org_id, id),
  unique (org_id, invoice_id, step_no)
);

-- Who may act at a step (on the invoice's job): dev manager = billing:approve; principal and asset
-- manager = financials:edit (the money owner).
create or replace function pm._dev_step_ok(p_role text, p_job uuid) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service() or case p_role when 'DEV_MANAGER' then pm.access_can_job('projects.billing', 'approve', p_job)
                                               else pm.access_can_job('projects.financials', 'edit', p_job) end
$$;

-- 1122's dev_decide_draw_invoice is still callable on its own; an invoice becomes APPROVED only
-- when every step of its chain approved it (security review round 2). Excluding stays direct.
create or replace function pm.tg_dev_invoice_chain() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status = 'APPROVED' and old.status is distinct from 'APPROVED' and not pm.access_is_service() then
    if not exists (select 1 from pm.dev_invoice_approvals a where a.org_id = new.org_id and a.invoice_id = new.id)
       or exists (select 1 from pm.dev_invoice_approvals a where a.org_id = new.org_id and a.invoice_id = new.id and a.decision is distinct from 'APPROVE') then
      raise exception 'PM_DEV_INVOICE_CHAIN: approve this invoice through its approval steps' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_dev_invoice_chain on pm.dev_draw_invoices;
create trigger trg_dev_invoice_chain before update of status on pm.dev_draw_invoices for each row execute function pm.tg_dev_invoice_chain();

-- Route an invoice: the company's chain for its amount (default: under $25,000 the dev manager;
-- $25,000 and up the dev manager then a principal).
create or replace function pm.dev_route_invoice(p_invoice uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.dev_draw_invoices%rowtype; v_loc uuid; v_steps text[]; n int := 0; s text;
begin
  select * into i from pm.dev_draw_invoices x where x.id = p_invoice and x.org_id = public.get_org_id();
  if i.id is null then raise exception 'PM_FORBIDDEN: invoice not found' using errcode = '42501'; end if;
  if i.status <> 'PENDING' then raise exception 'PM_INVALID: the invoice is already %', lower(i.status) using errcode = '22023'; end if;
  if exists (select 1 from pm.dev_invoice_approvals a where a.org_id = i.org_id and a.invoice_id = i.id) then
    return jsonb_build_object('invoice_id', i.id, 'steps', (select jsonb_agg(jsonb_build_object('step', a.step_no, 'role', a.step_role, 'decision', a.decision) order by a.step_no)
                                                            from pm.dev_invoice_approvals a where a.org_id = i.org_id and a.invoice_id = i.id));
  end if;
  select location_id into v_loc from core.jobs where id = i.job_id;
  select r.steps into v_steps from pm.dev_invoice_routes r where r.org_id = i.org_id and r.location_id = v_loc and i.amount_cents >= r.min_cents
     and (r.max_cents is null or i.amount_cents < r.max_cents) order by r.min_cents desc limit 1;
  v_steps := coalesce(v_steps, case when i.amount_cents >= 2500000 then array['DEV_MANAGER','PRINCIPAL'] else array['DEV_MANAGER'] end);
  foreach s in array v_steps loop
    n := n + 1;
    insert into pm.dev_invoice_approvals (org_id, job_id, invoice_id, step_no, step_role) values (i.org_id, i.job_id, i.id, n, s);
  end loop;
  return jsonb_build_object('invoice_id', i.id, 'steps', to_jsonb(v_steps));
end $$;

-- Act at the current step (phone or web). Preparer ≠ approver; one person acts on one step only.
-- The last approval approves the invoice for the draw; any rejection excludes it.
create or replace function pm.dev_decide_invoice_step(p_invoice uuid, p_approve boolean, p_note text default null, p_channel text default 'web')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.dev_draw_invoices%rowtype; a pm.dev_invoice_approvals%rowtype; v_uid text := pm.current_user_id(); v_left int;
begin
  select * into i from pm.dev_draw_invoices x where x.id = p_invoice and x.org_id = public.get_org_id() for update;
  if i.id is null then raise exception 'PM_FORBIDDEN: invoice not found' using errcode = '42501'; end if;
  if i.status <> 'PENDING' then raise exception 'PM_INVALID: the invoice is already %', lower(i.status) using errcode = '22023'; end if;
  if not (pm.access_can_row('projects.billing', 'approve', 'dev_draw_invoices', i.id) or pm.access_can_row('projects.financials', 'edit', 'dev_draw_invoices', i.id)) then
    perform pm.access_forbid('requires projects.billing:approve or projects.financials:edit on that invoice');
  end if;
  if not exists (select 1 from pm.dev_invoice_approvals x where x.org_id = i.org_id and x.invoice_id = i.id) then perform pm.dev_route_invoice(i.id); end if;
  select * into a from pm.dev_invoice_approvals x where x.org_id = i.org_id and x.invoice_id = i.id and x.decision is null order by x.step_no limit 1 for update;
  if not pm._dev_step_ok(a.step_role, i.job_id) then
    raise exception 'PM_FORBIDDEN: step % is for the %', a.step_no, lower(replace(a.step_role, '_', ' ')) using errcode = '42501';
  end if;
  -- the preparer: whoever added it, else whoever confirmed it out of the inbox
  if coalesce(i.created_by, (select x.decided_by from pm.dev_invoice_inbox x where x.org_id = i.org_id and x.draw_invoice_id = i.id order by x.decided_at desc limit 1)) = v_uid then
    raise exception 'PM_SOD_VIOLATION: the person who added an invoice does not approve it' using errcode = '42501';
  end if;
  if exists (select 1 from pm.dev_invoice_approvals x where x.org_id = i.org_id and x.invoice_id = i.id and x.decided_by = v_uid) then
    raise exception 'PM_SOD_VIOLATION: you already approved an earlier step of this invoice' using errcode = '42501';
  end if;
  update pm.dev_invoice_approvals set decision = case when p_approve then 'APPROVE' else 'REJECT' end, decided_by = v_uid, decided_at = now(), note = left(p_note, 1000),
         channel = case when p_channel in ('web','mobile','email') then p_channel else 'web' end
   where id = a.id;
  select count(*) into v_left from pm.dev_invoice_approvals x where x.org_id = i.org_id and x.invoice_id = i.id and x.decision is null;
  if not p_approve then
    perform pm.dev_decide_draw_invoice(i.id, false);
  elsif v_left = 0 then
    perform pm.dev_decide_draw_invoice(i.id, true);
  end if;
  return jsonb_build_object('invoice_id', i.id, 'step', a.step_no, 'decision', case when p_approve then 'APPROVE' else 'REJECT' end, 'steps_left', case when p_approve then v_left else 0 end,
                            'status', (select status from pm.dev_draw_invoices where id = i.id));
end $$;

-- D11. Draw funding + disbursement tracking (RED-29) ---------------------------------------------
create table if not exists pm.dev_draw_fundings (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  draw_id            uuid not null,
  source_id          uuid,
  source_name        text,
  approved_cents     bigint check (approved_cents is null or approved_cents >= 0),
  funded_cents       bigint check (funded_cents is null or funded_cents >= 0),
  adjustment_reason  text check (adjustment_reason is null or char_length(adjustment_reason) <= 500),
  title_date_down_on date,
  funded_on          date,
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, draw_id, source_id)
);

create table if not exists pm.dev_disbursements (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  draw_id          uuid not null,
  draw_invoice_id  uuid,
  vendor_id        uuid references core.vendors(id),
  amount_cents     bigint not null check (amount_cents > 0),
  method           text not null default 'SPONSOR_PAYMENT' check (method in ('DIRECT_VIA_TITLE','SPONSOR_PAYMENT','ACH','WIRE','CHECK')),
  paid_on          date,
  reference        text check (reference is null or char_length(reference) <= 120),
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id)
);

create or replace function pm.dev_record_funding(p_draw uuid, p_source uuid, p_approved_cents bigint, p_funded_cents bigint, p_funded_on date default null,
                                                 p_title_date_down_on date default null, p_adjustment_reason text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; s record; v uuid;
begin
  select * into d from pm.draws x where x.id = p_draw and x.org_id = public.get_org_id();
  if d.id is null then raise exception 'PM_FORBIDDEN: draw not found' using errcode = '42501'; end if;
  if d.status not in ('SUBMITTED','INSPECTION','APPROVED','FUNDED') then raise exception 'PM_INVALID: record funding once the draw is submitted' using errcode = '22023'; end if;
  select x.id, x.name into s from pm.dev_sources x where x.id = p_source and x.org_id = d.org_id and x.job_id = d.job_id;
  if p_source is not null and s.id is null then raise exception 'PM_INVALID: that source is not on this project' using errcode = '22023'; end if;
  if coalesce(p_funded_cents, 0) <> coalesce(p_approved_cents, p_funded_cents, 0) and nullif(btrim(coalesce(p_adjustment_reason, '')), '') is null then
    raise exception 'PM_INVALID: say why the funded amount differs from the approved amount' using errcode = '22023';
  end if;
  insert into pm.dev_draw_fundings (org_id, job_id, draw_id, source_id, source_name, approved_cents, funded_cents, adjustment_reason, title_date_down_on, funded_on)
  values (d.org_id, d.job_id, d.id, p_source, s.name, p_approved_cents, p_funded_cents, left(p_adjustment_reason, 500), p_title_date_down_on, p_funded_on)
  on conflict (org_id, draw_id, source_id) do update set approved_cents = excluded.approved_cents, funded_cents = excluded.funded_cents,
     adjustment_reason = excluded.adjustment_reason, title_date_down_on = excluded.title_date_down_on, funded_on = excluded.funded_on
  returning id into v;
  return v;
end $$;

create or replace function pm.dev_record_disbursement(p_draw uuid, p_vendor uuid, p_amount_cents bigint, p_method text default 'SPONSOR_PAYMENT', p_paid_on date default null,
                                                      p_reference text default null, p_draw_invoice uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v uuid;
begin
  select * into d from pm.draws x where x.id = p_draw and x.org_id = public.get_org_id();
  if d.id is null then raise exception 'PM_FORBIDDEN: draw not found' using errcode = '42501'; end if;
  if p_vendor is not null and not exists (select 1 from core.vendors x where x.id = p_vendor and x.org_id = d.org_id) then raise exception 'PM_UNKNOWN_VENDOR' using errcode = '23503'; end if;
  if p_draw_invoice is not null and not exists (select 1 from pm.dev_draw_invoices x where x.id = p_draw_invoice and x.org_id = d.org_id and x.draw_id = d.id) then
    raise exception 'PM_INVALID: that invoice is not in this draw' using errcode = '22023';
  end if;
  insert into pm.dev_disbursements (org_id, job_id, draw_id, draw_invoice_id, vendor_id, amount_cents, method, paid_on, reference)
  values (d.org_id, d.job_id, d.id, p_draw_invoice, p_vendor, p_amount_cents, coalesce(p_method, 'SPONSOR_PAYMENT'), p_paid_on, left(p_reference, 120)) returning id into v;
  return v;
end $$;

-- Submitted → approved → title date-down → funded (per source) → disbursed; cycle days and first-pass.
create or replace function pm.dev_draw_tracking(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v jsonb;
begin
  select * into j from pm._x_job(p_job);
  select coalesce(jsonb_agg(jsonb_build_object('draw_id', d.id, 'draw_number', d.draw_number, 'status', d.status, 'period_end', d.period_end,
           'submitted_at', d.submitted_at, 'approved_at', d.approved_at, 'funded_on', d.funded_on, 'requested_cents', d.requested_cents, 'approved_cents', d.approved_cents,
           'funded_cents', d.funded_cents,
           'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', f.source_name, 'approved_cents', f.approved_cents, 'funded_cents', f.funded_cents,
                                                        'adjustment_reason', f.adjustment_reason, 'title_date_down_on', f.title_date_down_on, 'funded_on', f.funded_on))
                                   from pm.dev_draw_fundings f where f.org_id = d.org_id and f.draw_id = d.id), '[]'),
           'disbursed_cents', (select coalesce(sum(x.amount_cents), 0) from pm.dev_disbursements x where x.org_id = d.org_id and x.draw_id = d.id),
           'direct_via_title_cents', (select coalesce(sum(x.amount_cents), 0) from pm.dev_disbursements x where x.org_id = d.org_id and x.draw_id = d.id and x.method = 'DIRECT_VIA_TITLE'),
           'cycle_days', case when d.submitted_at is not null and coalesce(d.funded_on, d.funded_at::date) is not null then coalesce(d.funded_on, d.funded_at::date) - d.submitted_at::date end,
           'first_pass', d.returned_at is null) order by d.draw_number), '[]') into v
    from pm.draws d where d.org_id = j.org_id and d.job_id = p_job and d.status <> 'CANCELLED';
  return jsonb_build_object('draws', v,
    'avg_cycle_days', (select round(avg((x ->> 'cycle_days')::numeric), 1) from jsonb_array_elements(v) x where x ->> 'cycle_days' is not null),
    'first_pass_rate', (select round(avg(case when (x ->> 'first_pass')::boolean then 1 else 0 end), 4) from jsonb_array_elements(v) x where x ->> 'status' in ('APPROVED','FUNDED')));
end $$;

-- D12. Development milestones (RED-30) and construction status events (RED-31) --------------------
create or replace function pm.dev_seed_milestones(p_job uuid, p_dates jsonb default '{}')
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; n int := 0; r record; v_on date; v_sort int;
begin
  select * into j from pm._x_job(p_job);
  select coalesce(max(sort), 0) into v_sort from pm.tasks where org_id = j.org_id and job_id = p_job;
  for r in select * from (values ('dd_complete','Due diligence complete','DD_EXPIRY'), ('land_closing','Land closing','PSA_CLOSING'), ('loan_closing','Construction loan closing','LOAN_CLOSING'),
                                 ('permits_issued','Building permits issued',null), ('ntp','Notice to proceed',null), ('substantial_completion','Substantial completion','OUTSIDE_COMPLETION'),
                                 ('tco','Temporary certificate of occupancy',null), ('lease_up','Lease-up / sales start',null), ('stabilization','Stabilization',null),
                                 ('refi','Refinance / disposition','LOAN_MATURITY')) t(k, ttl, kd) loop
    continue when exists (select 1 from pm.tasks x where x.org_id = j.org_id and x.job_id = p_job and x.ext ->> '_dev_milestone' = r.k);
    v_on := coalesce(pm._x_try_date(p_dates ->> r.k), (select k.due_on from pm.dev_key_dates k where k.org_id = j.org_id and k.job_id = p_job and k.kind = r.kd order by k.due_on limit 1));
    v_sort := v_sort + 1;
    insert into pm.tasks (org_id, job_id, title, is_milestone, start_on, due_on, duration_days, sort, ext)
    values (j.org_id, p_job, r.ttl, true, v_on, v_on, 0, v_sort, jsonb_build_object('_dev_milestone', r.k));
    n := n + 1;
  end loop;
  return n;
end $$;

create table if not exists pm.dev_status_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  kind          text not null check (kind in ('START','SUSPEND','RESUME','SUBSTANTIAL_COMPLETION','FINAL_COMPLETION')),
  effective_on  date not null,
  note          text check (note is null or char_length(note) <= 2000),
  recorded_by   text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Start, suspend, resume, substantial and final completion with effective dates, in order.
-- Start opens interest capitalization; substantial completion stops it and moves the stage.
create or replace function pm.dev_record_status_event(p_job uuid, p_kind text, p_effective_on date, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; d pm.dev_projects%rowtype; v_to text; v uuid;
begin
  select * into j from pm._x_job(p_job);
  insert into pm.dev_projects (org_id, job_id) values (j.org_id, p_job) on conflict do nothing;
  select * into d from pm.dev_projects x where x.org_id = j.org_id and x.job_id = p_job for update;
  if p_effective_on is null then raise exception 'PM_INVALID: give the effective date' using errcode = '22023'; end if;
  v_to := case
    when p_kind = 'START' and d.construction_status = 'NOT_STARTED' then 'ACTIVE'
    when p_kind = 'SUSPEND' and d.construction_status = 'ACTIVE' then 'SUSPENDED'
    when p_kind = 'RESUME' and d.construction_status = 'SUSPENDED' then 'ACTIVE'
    when p_kind = 'SUBSTANTIAL_COMPLETION' and d.construction_status = 'ACTIVE' then 'SUBSTANTIALLY_COMPLETE'
    when p_kind = 'FINAL_COMPLETION' and d.construction_status = 'SUBSTANTIALLY_COMPLETE' then 'COMPLETE' end;
  if v_to is null then
    raise exception 'PM_INVALID: % cannot follow % construction', lower(replace(p_kind, '_', ' ')), lower(replace(d.construction_status, '_', ' ')) using errcode = '22023';
  end if;
  if exists (select 1 from pm.dev_status_events e where e.org_id = j.org_id and e.job_id = p_job and e.effective_on > p_effective_on) then
    raise exception 'PM_INVALID: the effective date is before the last status event' using errcode = '22023';
  end if;
  insert into pm.dev_status_events (org_id, job_id, kind, effective_on, note) values (j.org_id, p_job, p_kind, p_effective_on, left(p_note, 2000)) returning id into v;
  update pm.dev_projects set construction_status = v_to,
         stage = case when p_kind = 'START' and stage in ('PURSUIT','UNDER_CONTRACT','PRE_DEVELOPMENT','SPE_FORMED','CAPITALIZED') then 'CONSTRUCTION'
                      when p_kind = 'SUBSTANTIAL_COMPLETION' then 'SUBSTANTIAL_COMPLETION' else stage end,
         cap_interest_start_on = case when p_kind = 'START' then coalesce(cap_interest_start_on, p_effective_on) else cap_interest_start_on end,
         cap_interest_stop_on = case when p_kind = 'SUBSTANTIAL_COMPLETION' then coalesce(cap_interest_stop_on, p_effective_on) else cap_interest_stop_on end,
         updated_at = now()
   where org_id = j.org_id and job_id = p_job;
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'development.status_event', 'dev_status_events', v,
    format('Construction %s effective %s', lower(replace(p_kind, '_', ' ')), p_effective_on), jsonb_build_object('kind', p_kind));
  return jsonb_build_object('id', v, 'construction_status', v_to);
end $$;

-- D13. Document room per SPE (RED-41) ----------------------------------------------------------
create or replace function pm.dev_seed_doc_room(p_job uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; n int := 0; r record;
begin
  select * into j from pm._x_job(p_job);
  for r in select * from (values (1,'psa','Purchase agreement (PSA)',null::text), (2,'operating_agreement','Operating agreement','projects.financials'),
                                 (3,'loan_docs','Loan documents','projects.financials'), (4,'title','Title',null), (5,'survey','Survey',null),
                                 (6,'contracts','Contracts','projects.financials'), (7,'permits','Permits and entitlements',null), (8,'plans','Plans and specifications',null),
                                 (9,'insurance','Insurance',null), (10,'investor_reports','Investor reports','projects.financials')) t(o, k, nm, cap) loop
    if not exists (select 1 from pm.doc_folders f where f.org_id = j.org_id and f.job_id = p_job and (f.key = r.k or lower(f.name) = lower(r.nm))) then
      insert into pm.doc_folders (org_id, job_id, key, name, sort, money_cap) values (j.org_id, p_job, r.k, r.nm, 100 + r.o, r.cap);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Share a folder's active files with the lender / investor / GC portals. pm.portal_share_document
-- applies the money rules per file (cost documents never go to investors); refusals are counted.
create or replace function pm.dev_share_folder(p_folder uuid, p_audiences text[])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare fo pm.doc_folders%rowtype; f record; n int := 0; v_skip int := 0;
begin
  select * into fo from pm.doc_folders x where x.id = p_folder and x.org_id = public.get_org_id();
  if fo.id is null then raise exception 'PM_FORBIDDEN: folder not found' using errcode = '42501'; end if;
  for f in select x.id from pm.doc_files x where x.org_id = fo.org_id and x.folder_id = fo.id and x.status = 'active' loop
    begin
      perform pm._wc_require_row('projects.documents', 'edit', 'doc_files', f.id);
      perform pm.portal_share_document(f.id, coalesce(p_audiences, '{}'));
      n := n + 1;
    exception when others then v_skip := v_skip + 1;
    end;
  end loop;
  return jsonb_build_object('folder_id', fo.id, 'shared', n, 'skipped', v_skip);
end $$;

-- D14. Affiliated GC billing to the SPE (RED-42) ------------------------------------------------
create table if not exists pm.dev_affiliate_bills (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,             -- the SPE development project
  gc_job_id            uuid not null,             -- the affiliated GC's job
  billing_request_id   uuid not null,
  amount_cents         bigint not null check (amount_cents > 0),
  memo                 text,
  cost_code_id         uuid,
  status               text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','VOID')),
  books_request_id     uuid,
  approved_by          text,
  approved_at          timestamptz,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, gc_job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dev_affiliate_bill(p_job uuid, p_gc_job uuid, p_amount_cents bigint, p_memo text default null, p_cost_code uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; g record; v_contract uuid; v_br uuid := gen_random_uuid(); v uuid;
begin
  select * into j from pm._x_job(p_job);
  select * into g from pm._x_job(p_gc_job);
  if p_job = p_gc_job then raise exception 'PM_INVALID: the GC job and the SPE project must differ' using errcode = '22023'; end if;
  if not (pm.access_is_service() or pm.access_can_job('projects.billing', 'create', p_gc_job)) then raise exception 'PM_FORBIDDEN: requires projects.billing:create on the GC job' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PM_INVALID: amount must be more than zero' using errcode = '22023'; end if;
  v_contract := pm.primary_contract_id(g.org_id, p_gc_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the GC job has no active contract with the SPE' using errcode = 'P0001'; end if;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_br, g.org_id, p_gc_job, v_contract, 'PROGRESS', 'DRAFT', 'progress', current_date, left(coalesce(p_memo, 'Affiliated GC billing to the SPE'), 500), pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents, retainage_rate)
  values (g.org_id, v_br, 1, 0, 'STANDARD', left(coalesce(p_memo, 'Construction services'), 300), p_amount_cents, p_amount_cents, 0);
  perform pm._wc_require_row('projects.billing', 'edit', 'billing_requests', v_br);
  perform pm.finalize_billing_retainage(v_br);
  insert into pm.dev_affiliate_bills (org_id, job_id, gc_job_id, billing_request_id, amount_cents, memo, cost_code_id)
  values (j.org_id, p_job, p_gc_job, v_br, p_amount_cents, left(p_memo, 500), p_cost_code) returning id into v;
  return jsonb_build_object('affiliate_bill_id', v, 'billing_request_id', v_br);
end $$;

-- One approval: the GC's billing request goes through the approvals engine (emitted to Books when
-- approved); the SPE's matching payable is handed to Books in the same step.
create or replace function pm.dev_approve_affiliate_bill(p_bill uuid, p_self_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.dev_affiliate_bills%rowtype; d jsonb; v_status text; v_req uuid; v_spe_loc uuid; v_gc_loc uuid;
begin
  select * into b from pm.dev_affiliate_bills x where x.id = p_bill and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: bill not found' using errcode = '42501'; end if;
  if b.status <> 'DRAFT' then raise exception 'PM_INVALID: already %', lower(b.status) using errcode = '22023'; end if;
  if not (pm.access_is_service() or pm.access_can_job('projects.financials', 'edit', b.job_id)) then raise exception 'PM_FORBIDDEN: requires projects.financials:edit on the SPE project' using errcode = '42501'; end if;
  d := pm.approval_decide('billing_request', b.billing_request_id, 'approve', null, p_self_reason, null, 'web');
  v_status := d ->> 'status';
  if v_status = 'not_needed' then
    -- No approval chain: approve_and_emit_billing's own guard is skipped when nested (security
    -- review H1), so the caller must hold billing approve + post on the GC job's request, and the
    -- person who prepared the bill does not approve it (solo companies only, with a typed reason).
    if not (pm.access_is_service() or (pm.access_can_row('projects.billing', 'approve', 'billing_requests', b.billing_request_id)
                                       and pm.access_can_row('projects.billing', 'post', 'billing_requests', b.billing_request_id))) then
      raise exception 'PM_FORBIDDEN: requires projects.billing:approve and post on the GC job' using errcode = '42501';
    end if;
    select location_id into v_gc_loc from core.jobs where id = b.gc_job_id;
    if not pm.access_is_service() and pm.current_user_id() in (b.created_by, (select r.created_by from pm.billing_requests r where r.id = b.billing_request_id)) then
      if not pm._approval_solo(b.org_id, v_gc_loc) then
        raise exception 'PM_SOD_VIOLATION: the person who prepared the GC bill does not approve it' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(p_self_reason, ''))) < 5 then
        raise exception 'PM_APPROVAL_SELF_REASON: you prepared this bill; in a one- or two-person company you may approve it yourself — type why' using errcode = '22023';
      end if;
    end if;
    perform pm.approve_and_emit_billing(b.billing_request_id);
    v_status := 'approved';
  end if;
  if v_status <> 'approved' then return jsonb_build_object('affiliate_bill_id', b.id, 'status', v_status, 'approval', d); end if;
  select location_id into v_spe_loc from core.jobs where id = b.job_id;
  select location_id into v_gc_loc from core.jobs where id = b.gc_job_id;
  v_req := pm._wc_books_request(b.org_id, v_spe_loc, b.job_id, 'AFFILIATE_PAYABLE', 'dev_affiliate_bills', b.id,
    jsonb_build_object('affiliate_bill_id', b.id, 'payable_location_id', v_spe_loc, 'payee_location_id', v_gc_loc, 'job_id', b.job_id, 'gc_job_id', b.gc_job_id,
                       'billing_request_id', b.billing_request_id, 'amount_cents', b.amount_cents, 'cost_code_id', b.cost_code_id, 'gl_disposition', 'CAPITALIZE'));
  update pm.dev_affiliate_bills set status = 'APPROVED', books_request_id = v_req, approved_by = pm.current_user_id(), approved_at = now() where id = b.id;
  return jsonb_build_object('affiliate_bill_id', b.id, 'status', 'approved', 'books_request_id', v_req);
end $$;

-- D15. Development migration + pro forma import (RED-08 / RED-44) --------------------------------
create table if not exists pm.dev_imports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  kind          text not null check (kind in ('PRO_FORMA','BUDGET','DRAWS','WAIVERS')),
  file_name     text check (file_name is null or char_length(file_name) <= 255),
  rows          jsonb not null check (jsonb_typeof(rows) = 'array'),
  mapping       jsonb not null default '[]' check (jsonb_typeof(mapping) = 'array'),
  status        text not null default 'STAGED' check (status in ('STAGED','APPLIED','DISCARDED')),
  result        jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  applied_at    timestamptz,
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Stage rows and suggest the map (rules: cost code by code or name, lender line by description,
-- CIP account by category). A person confirms the map (dev_set_import_map) before applying.
--   PRO_FORMA / BUDGET rows: {name, code?, category LAND|HARD|SOFT|FINANCING|CONTINGENCY|DEVELOPER_FEE|INTEREST_RESERVE|OTHER, amount_cents}
--   DRAWS rows: {draw_number, period_end, requested_cents, approved_cents, funded_cents, funded_on, lines:[{line_no, approved_cents}]}
--   WAIVERS rows: {vendor_name, doc_type, status, covers_through, amount_cents}
create or replace function pm.dev_stage_import(p_job uuid, p_kind text, p_file_name text, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v uuid; r jsonb; i int := 0; v_map jsonb := '[]'; v_cc uuid; v_line uuid; v_sched uuid;
begin
  select * into j from pm._x_job(p_job);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'PM_INVALID: the file has no rows' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'PM_INVALID: more than 2,000 rows' using errcode = '22023'; end if;
  select id into v_sched from pm.draw_schedules s where s.org_id = j.org_id and s.job_id = p_job order by (s.status = 'ACTIVE') desc, s.created_at limit 1;
  if p_kind in ('PRO_FORMA','BUDGET') then
    for r in select x from jsonb_array_elements(p_rows) x loop
      i := i + 1;
      select c.id into v_cc from pm.cost_codes c where c.org_id = j.org_id and c.location_id = j.location_id and (c.job_id is null or c.job_id = p_job)
         and (lower(c.code) = lower(coalesce(r ->> 'code', '#')) or lower(c.name) = lower(btrim(coalesce(r ->> 'name', '')))
              or (char_length(btrim(coalesce(r ->> 'name', ''))) >= 4 and lower(c.name) like '%' || lower(btrim(r ->> 'name')) || '%'))
       order by (lower(c.code) = lower(coalesce(r ->> 'code', '#'))) desc, (lower(c.name) = lower(btrim(coalesce(r ->> 'name', '')))) desc limit 1;
      select l.id into v_line from pm.draw_budget_lines l where l.org_id = j.org_id and l.draw_schedule_id = v_sched
         and (l.cost_code_id = v_cc or lower(l.description) like '%' || lower(left(btrim(coalesce(r ->> 'name', '')), 20)) || '%' or l.category = upper(coalesce(r ->> 'category', '')))
       order by (l.cost_code_id = v_cc) desc nulls last, (l.category = upper(coalesce(r ->> 'category', ''))) desc limit 1;
      v_map := v_map || jsonb_build_object('row', i, 'name', r ->> 'name', 'cost_code_id', v_cc, 'draw_budget_line_id', v_line,
                                           'category', coalesce(nullif(upper(r ->> 'category'), ''), 'OTHER'),
                                           'cip_account_ref', '1500-' || coalesce(nullif(upper(r ->> 'category'), ''), 'OTHER'), 'confirmed', false);
    end loop;
  elsif p_kind not in ('DRAWS','WAIVERS') then
    raise exception 'PM_INVALID: import kind %', p_kind using errcode = '22023';
  end if;
  insert into pm.dev_imports (org_id, job_id, kind, file_name, rows, mapping) values (j.org_id, p_job, p_kind, left(p_file_name, 255), p_rows, v_map) returning id into v;
  return jsonb_build_object('import_id', v, 'rows', jsonb_array_length(p_rows), 'mapping', v_map,
                            'unmapped', (select count(*) from jsonb_array_elements(v_map) x where x ->> 'cost_code_id' is null));
end $$;

create or replace function pm.dev_set_import_map(p_import uuid, p_mapping jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare im pm.dev_imports%rowtype;
begin
  select * into im from pm.dev_imports x where x.id = p_import and x.org_id = public.get_org_id() for update;
  if im.id is null then raise exception 'PM_FORBIDDEN: import not found' using errcode = '42501'; end if;
  if im.status <> 'STAGED' then raise exception 'PM_INVALID: this import is %', lower(im.status) using errcode = '22023'; end if;
  if jsonb_typeof(p_mapping) <> 'array' then raise exception 'PM_INVALID: mapping must be a list' using errcode = '22023'; end if;
  update pm.dev_imports set mapping = (select coalesce(jsonb_agg(x || jsonb_build_object('confirmed', true)), '[]') from jsonb_array_elements(p_mapping) x) where id = im.id;
  return jsonb_build_object('import_id', im.id, 'rows', jsonb_array_length(p_mapping));
end $$;

create or replace function pm.dev_apply_import(p_import uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare im pm.dev_imports%rowtype; j record; m jsonb; r jsonb; n int := 0; v_bud uuid; v_sched uuid; v_draw uuid; v_vendor uuid; l jsonb; v_status text;
begin
  select * into im from pm.dev_imports x where x.id = p_import and x.org_id = public.get_org_id() for update;
  if im.id is null then raise exception 'PM_FORBIDDEN: import not found' using errcode = '42501'; end if;
  if im.status <> 'STAGED' then raise exception 'PM_INVALID: this import is %', lower(im.status) using errcode = '22023'; end if;
  select * into j from pm._x_job(im.job_id);
  if im.kind in ('PRO_FORMA','BUDGET') then
    if exists (select 1 from jsonb_array_elements(im.mapping) x where not coalesce((x ->> 'confirmed')::boolean, false) or x ->> 'cost_code_id' is null) then
      raise exception 'PM_DEV_IMPORT_UNCONFIRMED: confirm the cost code of every row first' using errcode = '22023';
    end if;
    select id into v_bud from pm.budgets b where b.org_id = j.org_id and b.job_id = im.job_id and b.kind = 'ORIGINAL';
    if v_bud is null then insert into pm.budgets (org_id, job_id, kind) values (j.org_id, im.job_id, 'ORIGINAL') returning id into v_bud; end if;
    if im.kind = 'BUDGET' and exists (select 1 from pm.budgets b where b.id = v_bud and b.status = 'APPROVED') and exists (select 1 from pm.budget_lines bl where bl.budget_id = v_bud) then
      raise exception 'PM_DEV_BUDGET_APPROVED: the original budget is approved; move money with a reallocation instead' using errcode = '55000';
    end if;
    for m in select x from jsonb_array_elements(im.mapping) x loop
      r := im.rows -> ((m ->> 'row')::int - 1);
      if im.kind = 'BUDGET' then
        insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values (j.org_id, v_bud, (m ->> 'cost_code_id')::uuid, coalesce(pm._x_try_bigint(r ->> 'amount_cents'), 0));
      end if;
      perform pm._wc_require_job('projects.financials', 'edit', im.job_id);
      perform pm.dev_map_budget_line(im.job_id, (m ->> 'cost_code_id')::uuid, coalesce(m ->> 'category', 'OTHER'), case when m ->> 'category' = 'CONTINGENCY' then coalesce(m ->> 'pool', 'HARD') end,
                                     pm.access_try_uuid(m ->> 'draw_budget_line_id'), m ->> 'cip_account_ref', n);
      n := n + 1;
    end loop;
  elsif im.kind = 'DRAWS' then
    select id into v_sched from pm.draw_schedules s where s.org_id = j.org_id and s.job_id = im.job_id order by (s.status = 'ACTIVE') desc, s.created_at limit 1;
    if v_sched is null then raise exception 'PM_INVALID: set up the lender draw schedule first' using errcode = '22023'; end if;
    for r in select x from jsonb_array_elements(im.rows) x order by (x ->> 'draw_number')::int loop
      continue when exists (select 1 from pm.draws d where d.draw_schedule_id = v_sched and d.draw_number = (r ->> 'draw_number')::int);
      insert into pm.draws (org_id, job_id, draw_schedule_id, draw_number, period_end, status, inspection_status, requested_cents, approved_cents, retainage_held_cents,
                            retainage_released_cents, equity_applied_cents, loan_expected_cents, funded_cents, submitted_at, submitted_by, approved_at, approved_by, funded_at, funded_on, notes)
      values (j.org_id, im.job_id, v_sched, (r ->> 'draw_number')::int, coalesce(pm._x_try_date(r ->> 'period_end'), current_date), 'FUNDED', 'NOT_REQUIRED',
              coalesce(pm._x_try_bigint(r ->> 'requested_cents'), pm._x_try_bigint(r ->> 'approved_cents'), 0), coalesce(pm._x_try_bigint(r ->> 'approved_cents'), 0),
              coalesce(pm._x_try_bigint(r ->> 'retainage_held_cents'), 0), 0, coalesce(pm._x_try_bigint(r ->> 'equity_applied_cents'), 0),
              coalesce(pm._x_try_bigint(r ->> 'funded_cents'), pm._x_try_bigint(r ->> 'approved_cents'), 0), coalesce(pm._x_try_bigint(r ->> 'funded_cents'), 0),
              coalesce(pm._x_try_date(r ->> 'period_end'), current_date)::timestamptz, 'import', coalesce(pm._x_try_date(r ->> 'funded_on'), pm._x_try_date(r ->> 'period_end'), current_date)::timestamptz, 'import',
              coalesce(pm._x_try_date(r ->> 'funded_on'), pm._x_try_date(r ->> 'period_end'), current_date)::timestamptz, coalesce(pm._x_try_date(r ->> 'funded_on'), pm._x_try_date(r ->> 'period_end')),
              'Imported prior draw (G702) — ' || coalesce(im.file_name, 'migration'))
      returning id into v_draw;
      for l in select x from jsonb_array_elements(coalesce(r -> 'lines', '[]')) x loop
        insert into pm.draw_lines (org_id, job_id, draw_schedule_id, draw_id, draw_budget_line_id, requested_cents, approved_cents)
        select j.org_id, im.job_id, v_sched, v_draw, bl.id, coalesce(pm._x_try_bigint(l ->> 'approved_cents'), 0), coalesce(pm._x_try_bigint(l ->> 'approved_cents'), 0)
          from pm.draw_budget_lines bl where bl.org_id = j.org_id and bl.draw_schedule_id = v_sched and bl.line_no = (l ->> 'line_no')::int;
      end loop;
      n := n + 1;
    end loop;
  elsif im.kind = 'WAIVERS' then
    for r in select x from jsonb_array_elements(im.rows) x loop
      v_vendor := (select vd.id from core.vendors vd where vd.org_id = j.org_id and lower(vd.name) = lower(btrim(coalesce(r ->> 'vendor_name', ''))) limit 1);
      continue when v_vendor is null;
      v_status := coalesce(nullif(upper(r ->> 'status'), ''), 'RECEIVED');
      if v_status not in ('MISSING','RECEIVED','VERIFIED','EXPIRED','REJECTED') then v_status := 'RECEIVED'; end if;
      insert into pm.compliance_docs (org_id, job_id, vendor_id, doc_type, status, covers_through, amount_cents, notes, verified_by, verified_at)
      values (j.org_id, im.job_id, v_vendor, coalesce(nullif(upper(r ->> 'doc_type'), ''), 'LIEN_WAIVER_UNCONDITIONAL'), v_status, pm._x_try_date(r ->> 'covers_through'),
              pm._x_try_bigint(r ->> 'amount_cents'), 'Imported waiver status', case when v_status = 'VERIFIED' then 'import' end, case when v_status = 'VERIFIED' then now() end);
      n := n + 1;
    end loop;
  end if;
  update pm.dev_imports set status = 'APPLIED', applied_at = now(), result = jsonb_build_object('applied', n) where id = im.id;
  perform pm._wc_require_job('projects.financials', 'view', im.job_id);
  return jsonb_build_object('import_id', im.id, 'applied', n, 'tieout', pm.dev_tieout(im.job_id));
end $$;

-- Tie-out: Projects' paid-to-date and drawn-to-date against the SPE's Books balances (CIP accounts
-- named in the budget map; loan balance from the draws). available = false without Books' GL.
create or replace function pm.dev_tieout(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; d pm.dev_projects%rowtype; v_paid bigint; v_drawn bigint; v_cip bigint; v_entity uuid; v_refs text[]; v_used text[];
begin
  select * into j from pm._x_job(p_job);
  select * into d from pm.dev_projects x where x.org_id = j.org_id and x.job_id = p_job;
  v_entity := coalesce(d.spe_location_id, j.location_id);
  -- security review H2: the Books side is read only for an entity the caller may see financials at
  perform pm._wc_require_location('projects.financials', 'view', v_entity);
  select coalesce(sum(c.amount_cents), 0)::bigint into v_paid from pm.job_costs c where c.org_id = j.org_id and c.job_id = p_job and c.lifecycle = 'CLEARED';
  select coalesce(sum(coalesce(dr.funded_cents, 0)), 0)::bigint into v_drawn from pm.draws dr where dr.org_id = j.org_id and dr.job_id = p_job and dr.status = 'FUNDED';
  v_refs := array(select distinct m.cip_account_ref from pm.dev_budget_lines m where m.org_id = j.org_id and m.job_id = p_job and m.cip_account_ref is not null);
  if to_regclass('public.gl_entry_lines') is null or to_regclass('public.accounts') is null then
    return jsonb_build_object('available', false, 'reason', 'books_not_connected', 'projects_cost_cents', v_paid, 'projects_drawn_cents', v_drawn, 'entity_id', v_entity);
  end if;
  -- Only construction-in-progress accounts count: ASSET, not a bank or card account, named as CIP
  -- (Books has no CIP flag yet), and either company-wide or the SPE entity's own. A user-typed
  -- cip_account_ref selects among those; it can never pull in another account.
  execute $q$ select array(select a.account_number from public.accounts a
                             where a.org_id = $1 and a.account_type = 'ASSET' and not a.is_bank_account and not a.is_credit_card
                               and (a.company_location_id is null or a.company_location_id = $2)
                               and (a.name ~* '(construction|work)[ -]in[ -]progress|\mCIP\M')
                               and (cardinality($3) = 0 or a.account_number = any ($3))) $q$
    into v_used using j.org_id, v_entity, v_refs;
  execute $q$ select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint from public.gl_entry_lines l
                join public.gl_entries e on e.id = l.gl_entry_id and e.status = 'POSTED'
                join public.accounts a on a.id = l.account_id
               where l.org_id = $1 and e.location_id = $2 and a.org_id = $1 and a.account_number = any ($3) $q$
    into v_cip using j.org_id, v_entity, v_used;
  return jsonb_build_object('available', true, 'entity_id', v_entity, 'projects_cost_cents', v_paid, 'books_cip_cents', v_cip, 'difference_cents', v_paid - coalesce(v_cip, 0),
                            'ties', abs(v_paid - coalesce(v_cip, 0)) <= 100, 'projects_drawn_cents', v_drawn, 'cip_accounts', to_jsonb(v_used),
                            'ignored_refs', to_jsonb(array(select r from unnest(v_refs) r where not (r = any (v_used)))));
exception
  when insufficient_privilege then raise;
  when others then
    -- no error text back to the caller (it can name Books tables / columns)
    return jsonb_build_object('available', false, 'reason', 'books_read_failed', 'projects_cost_cents', v_paid, 'projects_drawn_cents', v_drawn, 'entity_id', v_entity);
end $$;

-- The SPE's Books entity (dev_projects.spe_location_id, set by 1122's dev_save_project) must be a
-- company of this org the caller is a member of (security review H2).
create or replace function pm.tg_dev_spe_entity() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.spe_location_id is null or pm.access_is_service() then return new; end if;
  if tg_op = 'UPDATE' and new.spe_location_id is not distinct from old.spe_location_id then return new; end if;
  if not exists (select 1 from core.locations l where l.id = new.spe_location_id and l.org_id = new.org_id)
     or not (new.spe_location_id in (select pm.my_member_location_ids())) then
    raise exception 'PM_FORBIDDEN: the SPE entity must be one of your companies' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_dev_spe_entity on pm.dev_projects;
create trigger trg_dev_spe_entity before insert or update of spe_location_id on pm.dev_projects for each row execute function pm.tg_dev_spe_entity();

-- ============================================================================
-- F. Flooring completion
-- ============================================================================
alter table pm.flr_settings add column if not exists business_mix text[] not null default array['RETAIL_INSTALLED'];
alter table pm.flr_settings add column if not exists installer_pay_basis text not null default 'PIECE_RATE';
alter table pm.flr_settings add column if not exists tax_states text[] not null default '{}';
alter table pm.flr_settings add column if not exists replacing_system text;
alter table pm.flr_settings add column if not exists measure_fee_cents bigint not null default 0;
alter table pm.flr_settings add column if not exists confirm_days_before int not null default 2;
alter table pm.flr_settings add column if not exists prep_instructions text not null default 'Please clear the rooms of small items and breakables, and turn the HVAC on so the floor and the room are at living temperature.';
do $$ begin
  alter table pm.flr_settings add constraint flr_settings_1124_chk check (
    business_mix <@ array['RETAIL_INSTALLED','CASH_AND_CARRY','BUILDER','MULTI_FAMILY','COMMERCIAL','INSURANCE']::text[]
    and installer_pay_basis in ('PIECE_RATE','HOURLY','MIXED') and measure_fee_cents >= 0 and confirm_days_before between 0 and 14
    and char_length(prep_instructions) <= 1000);
exception when duplicate_object then null; end $$;

create or replace function pm._flr_customer_contact(p_org uuid, p_job uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select c.id from core.contacts c join core.jobs j on j.customer_id = c.customer_id and j.org_id = c.org_id
   where j.id = p_job and c.org_id = p_org and c.merged_into is null order by c.is_primary desc nulls last, c.created_at limit 1
$$;

-- F1. Lead capture & rotation (FLR-03) ------------------------------------------------------------
create table if not exists pm.flr_lead_rotation (
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  members        uuid[] not null default '{}' check (cardinality(members) <= 50),
  next_index     int not null default 0 check (next_index >= 0),
  followup_hours int not null default 2 check (followup_hours between 0 and 72),
  updated_at     timestamptz not null default now(),
  primary key (org_id, location_id)
);

-- The "up" system: the next salesperson in the rotation owns the lead and gets a follow-up due now.
create or replace function pm.flr_assign_lead(p_lead uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l record; r pm.flr_lead_rotation%rowtype; v_m uuid; v_fu uuid;
begin
  select x.id, x.org_id, x.location_id, x.owner_membership_id, x.customer_id, x.title into l from crm.leads x where x.id = p_lead and x.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: lead not found' using errcode = '42501'; end if;
  if l.owner_membership_id is not null then return jsonb_build_object('lead_id', l.id, 'owner_membership_id', l.owner_membership_id, 'rotated', false); end if;
  select * into r from pm.flr_lead_rotation x where x.org_id = l.org_id and x.location_id = l.location_id for update;
  if r.location_id is null or cardinality(r.members) = 0 then raise exception 'PM_INVALID: set up the salesperson rotation first' using errcode = '22023'; end if;
  v_m := r.members[(r.next_index % cardinality(r.members)) + 1];
  update pm.flr_lead_rotation set next_index = (r.next_index + 1) % cardinality(r.members), updated_at = now() where org_id = r.org_id and location_id = r.location_id;
  update crm.leads set owner_membership_id = v_m, updated_at = now() where id = l.id;
  insert into crm.followups (org_id, location_id, lead_id, customer_id, due_on, kind, title, assigned_membership_id)
  values (l.org_id, l.location_id, l.id, l.customer_id, (now() + make_interval(hours => r.followup_hours))::date, 'follow_up', left('First contact: ' || l.title, 300), v_m)
  returning id into v_fu;
  return jsonb_build_object('lead_id', l.id, 'owner_membership_id', v_m, 'followup_id', v_fu, 'rotated', true);
end $$;

-- F2. Measure fee credited when the customer orders (FLR-07) ------------------------------------
create or replace function pm.flr_credit_measure_fee(p_estimate uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e record; a pm.wc_appointments%rowtype; v_line uuid;
begin
  select x.id, x.org_id, x.job_id, x.status into e from pm.estimates x where x.id = p_estimate and x.org_id = public.get_org_id();
  if e.id is null then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if e.status <> 'DRAFT' then raise exception 'PM_INVALID: credit the measure fee while the quote is a draft' using errcode = '22023'; end if;
  select * into a from pm.wc_appointments x where x.org_id = e.org_id and x.job_id = e.job_id and x.kind = 'MEASURE' and x.status = 'DONE'
     and coalesce(x.measure_fee_cents, 0) > 0 and x.fee_credited_at is null order by x.starts_at desc limit 1 for update;
  if a.id is null then return jsonb_build_object('credited', false, 'reason', 'No paid measure visit to credit on this job'); end if;
  insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, amount_cents, sort, ext)
  values (e.org_id, e.id, 9999, 'Measure fee credit', 1, -a.measure_fee_cents, 9999, jsonb_build_object('measure_fee_credit', a.id))
  returning id into v_line;
  update pm.wc_appointments set fee_credited_at = now() where id = a.id;
  return jsonb_build_object('credited', true, 'estimate_line_id', v_line, 'credit_cents', a.measure_fee_cents);
end $$;

-- F3. Price file ingestion (FLR-14): fcB2B 832 and mill spreadsheets (parsed by lib/flooring/price-file.ts) --
create table if not exists pm.flr_price_imports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  vendor_id      uuid references core.vendors(id),
  source         text not null check (source in ('FCB2B_832','MILL_SHEET')),
  file_name      text check (file_name is null or char_length(file_name) <= 255),
  effective_on   date,
  status         text not null default 'STAGED' check (status in ('STAGED','APPLIED','DISCARDED')),
  summary        jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  applied_at     timestamptz,
  unique (org_id, id)
);

create table if not exists pm.flr_price_import_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  import_id        uuid not null,
  line_no          int not null,
  sku              text not null,
  style            text,
  color            text,
  uom              text,
  new_cost_cents   bigint check (new_cost_cents is null or new_cost_cents >= 0),
  old_cost_cents   bigint,
  new_retail_cents bigint check (new_retail_cents is null or new_retail_cents >= 0),
  product_id       uuid,
  change           text not null check (change in ('NEW','CHANGED','UNCHANGED')),
  open_quote_lines int not null default 0,
  margin_impact_cents bigint not null default 0,
  unique (org_id, id),
  unique (org_id, import_id, line_no),
  foreign key (org_id, import_id) references pm.flr_price_imports (org_id, id) on delete cascade deferrable initially immediate
);

-- Stage: match SKUs to the product file (this vendor), diff costs, and the margin impact on open
-- quotes (draft / sent estimates whose flooring lines use the product): Σ qty × (old − new) cost.
create or replace function pm.flr_stage_price_import(p_location uuid, p_vendor uuid, p_source text, p_file_name text, p_lines jsonb, p_effective_on date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v uuid; l jsonb; i int := 0; pr record; v_change text; v_qty numeric; v_n int; n_new int := 0; n_chg int := 0; v_impact bigint := 0; v_li bigint;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: the price file has no lines' using errcode = '22023'; end if;
  if jsonb_array_length(p_lines) > 20000 then raise exception 'PM_INVALID: more than 20,000 lines; split the file' using errcode = '22023'; end if;
  if p_vendor is not null and not exists (select 1 from core.vendors x where x.id = p_vendor and x.org_id = v_org) then raise exception 'PM_UNKNOWN_VENDOR' using errcode = '23503'; end if;
  insert into pm.flr_price_imports (org_id, location_id, vendor_id, source, file_name, effective_on) values (v_org, p_location, p_vendor, p_source, left(p_file_name, 255), p_effective_on)
  returning id into v;
  for l in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    select p.id, p.cost_cents into pr from pm.flr_products p
     where p.org_id = v_org and p.location_id = p_location and upper(p.sku) = upper(btrim(l ->> 'sku')) and (p_vendor is null or p.vendor_id is not distinct from p_vendor) limit 1;
    v_change := case when pr.id is null then 'NEW' when pr.cost_cents is distinct from pm._x_try_bigint(l ->> 'cost_cents') then 'CHANGED' else 'UNCHANGED' end;
    v_n := 0; v_li := 0;
    if v_change = 'CHANGED' then
      select count(*), coalesce(sum(coalesce(ql.measured_qty, el.qty, 0)), 0) into v_n, v_qty
        from pm.flr_quote_lines ql join pm.estimates e on e.id = ql.estimate_id and e.org_id = ql.org_id join pm.estimate_lines el on el.id = ql.estimate_line_id
       where ql.org_id = v_org and ql.product_id = pr.id and e.status in ('DRAFT','SENT');
      v_li := pm.res_round(coalesce(v_qty, 0) * (coalesce(pr.cost_cents, 0) - coalesce(pm._x_try_bigint(l ->> 'cost_cents'), 0)));
      n_chg := n_chg + 1; v_impact := v_impact + v_li;
    elsif v_change = 'NEW' then n_new := n_new + 1;
    end if;
    insert into pm.flr_price_import_lines (org_id, import_id, line_no, sku, style, color, uom, new_cost_cents, old_cost_cents, new_retail_cents, product_id, change, open_quote_lines, margin_impact_cents)
    values (v_org, v, i, left(btrim(l ->> 'sku'), 80), left(l ->> 'style', 120), left(l ->> 'color', 120), left(l ->> 'uom', 12), pm._x_try_bigint(l ->> 'cost_cents'), pr.cost_cents,
            pm._x_try_bigint(l ->> 'retail_cents'), pr.id, v_change, v_n, v_li);
  end loop;
  update pm.flr_price_imports set summary = jsonb_build_object('lines', i, 'new', n_new, 'changed', n_chg, 'unchanged', i - n_new - n_chg, 'open_quote_margin_impact_cents', v_impact)
   where id = v;
  return jsonb_build_object('import_id', v, 'lines', i, 'new', n_new, 'changed', n_chg, 'open_quote_margin_impact_cents', v_impact);
end $$;

-- Apply: changed costs (and retail when the file carries it) update the product file; new SKUs are
-- listed for a person to add (style / category need a decision).
create or replace function pm.flr_apply_price_import(p_import uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare im pm.flr_price_imports%rowtype; n int;
begin
  select * into im from pm.flr_price_imports x where x.id = p_import and x.org_id = public.get_org_id() for update;
  if im.id is null then raise exception 'PM_FORBIDDEN: price import not found' using errcode = '42501'; end if;
  if im.status <> 'STAGED' then raise exception 'PM_INVALID: this import is %', lower(im.status) using errcode = '22023'; end if;
  update pm.flr_products p set cost_cents = l.new_cost_cents, price_retail_cents = coalesce(l.new_retail_cents, p.price_retail_cents), updated_at = now()
    from pm.flr_price_import_lines l where l.org_id = im.org_id and l.import_id = im.id and l.change = 'CHANGED' and p.id = l.product_id;
  get diagnostics n = row_count;
  update pm.flr_price_imports set status = 'APPLIED', applied_at = now(), summary = summary || jsonb_build_object('applied', n) where id = im.id;
  return jsonb_build_object('import_id', im.id, 'updated', n, 'new_skus', (select count(*) from pm.flr_price_import_lines l where l.org_id = im.org_id and l.import_id = im.id and l.change = 'NEW'));
end $$;

-- F4. Deposit terms (FLR-17): percent or fixed, refundable flag; Books mints the invoice + pay link.
create table if not exists pm.flr_deposit_terms (
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  pct                 numeric(5,4) check (pct is null or (pct > 0 and pct <= 1)),
  amount_cents        bigint not null check (amount_cents > 0),
  refundable          boolean not null default false,
  deposit_request_id  uuid,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  primary key (org_id, job_id, created_at),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.flr_request_deposit(p_job uuid, p_pct numeric default null, p_amount_cents bigint default null, p_refundable boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_base bigint; v_amt bigint; v_dep uuid; s pm.flr_settings%rowtype;
begin
  select * into j from pm._x_job(p_job);
  select * into s from pm.flr_settings x where x.org_id = j.org_id and x.location_id = j.location_id;
  if p_amount_cents is null then
    select coalesce(nullif(m.revised_contract_cents, 0), (select e.total_cents from pm.estimates e where e.org_id = j.org_id and e.job_id = p_job and e.status in ('ACCEPTED','SENT','DRAFT')
                                                          order by (e.status = 'ACCEPTED') desc, e.updated_at desc limit 1), 0)
      into v_base from pm.v_job_money m where m.org_id = j.org_id and m.job_id = p_job;
    v_amt := pm.res_round(coalesce(v_base, 0) * coalesce(p_pct, s.default_deposit_pct, 0.5));
  else v_amt := p_amount_cents;
  end if;
  if coalesce(v_amt, 0) <= 0 then raise exception 'PM_INVALID: nothing to collect — price the quote first or give an amount' using errcode = '22023'; end if;
  perform pm._wc_require_job('projects.billing', 'create', p_job);
  v_dep := pm.request_deposit(p_job, v_amt, case when coalesce(p_refundable, false) then 'Deposit (refundable)' else 'Deposit (non-refundable once material is ordered)' end, null);
  insert into pm.flr_deposit_terms (org_id, job_id, pct, amount_cents, refundable, deposit_request_id)
  values (j.org_id, p_job, case when p_amount_cents is null then coalesce(p_pct, s.default_deposit_pct, 0.5) end, v_amt, coalesce(p_refundable, false), v_dep);
  return jsonb_build_object('deposit_request_id', v_dep, 'amount_cents', v_amt, 'refundable', coalesce(p_refundable, false));
end $$;

-- F5. Counter sale (FLR-19): remnants, sundries, boxed goods; retail tax; remnant relief. Books
-- receives the sale (invoice + payment) through the held hand-off.
create table if not exists pm.flr_counter_sales (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  number           text not null,
  customer_id      uuid references core.customers(id),
  customer_name    text check (customer_name is null or char_length(customer_name) <= 200),
  subtotal_cents   bigint not null default 0 check (subtotal_cents >= 0),
  tax_rate         numeric(7,6) not null default 0 check (tax_rate >= 0 and tax_rate < 0.5),
  tax_cents        bigint not null default 0 check (tax_cents >= 0),
  total_cents      bigint not null default 0 check (total_cents >= 0),
  payment_method   text not null default 'CARD' check (payment_method in ('CARD','CASH','CHECK','ON_ACCOUNT')),
  status           text not null default 'COMPLETED' check (status in ('COMPLETED','VOID')),
  books_request_id uuid,
  sold_by          text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number)
);

create table if not exists pm.flr_counter_sale_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  sale_id          uuid not null,
  line_no          int not null,
  kind             text not null check (kind in ('PRODUCT','REMNANT','SUNDRY')),
  product_id       uuid,
  roll_id          uuid,
  lot_id           uuid,
  description      text not null check (char_length(btrim(description)) between 1 and 300),
  qty              numeric(14,4) not null check (qty > 0),
  uom              text not null default 'EA',
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  amount_cents     bigint not null check (amount_cents >= 0),
  taxable          boolean not null default true,
  unique (org_id, id),
  foreign key (org_id, sale_id) references pm.flr_counter_sales (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.flr_counter_sale(p_location uuid, p_lines jsonb, p_tax_rate numeric default 0, p_customer uuid default null, p_customer_name text default null,
                                               p_payment_method text default 'CARD')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v uuid; l jsonb; i int := 0; v_sub bigint := 0; v_taxable bigint := 0; v_amt bigint; v_tax bigint; v_num text; r record;
  v_roll uuid; v_lot uuid; v_taxed boolean;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: add what is being sold' using errcode = '22023'; end if;
  if p_customer is not null and not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org) then raise exception 'PM_FORBIDDEN: customer not found' using errcode = '42501'; end if;
  if coalesce(p_payment_method, 'CARD') = 'ON_ACCOUNT' and p_customer is null then raise exception 'PM_INVALID: on-account sales need a customer' using errcode = '22023'; end if;
  if coalesce(p_payment_method, 'CARD') = 'ON_ACCOUNT'
     and not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org and (c.location_id is null or c.location_id = p_location)) then
    raise exception 'PM_INVALID: that customer has no account at this store' using errcode = '22023';
  end if;
  v_num := 'CS-' || to_char(now(), 'YYMMDD') || '-' || lpad(((select count(*) from pm.flr_counter_sales s where s.org_id = v_org and s.created_at::date = current_date) + 1)::text, 3, '0');
  insert into pm.flr_counter_sales (org_id, location_id, number, customer_id, customer_name, tax_rate, payment_method)
  values (v_org, p_location, v_num, p_customer, left(p_customer_name, 200), coalesce(p_tax_rate, 0), coalesce(p_payment_method, 'CARD')) returning id into v;
  for l in select x from jsonb_array_elements(p_lines) x loop
    i := i + 1;
    v_roll := null; v_lot := null;
    if l ->> 'kind' = 'REMNANT' then
      select x.id, x.status into r from pm.flr_rolls x where x.id = pm.access_try_uuid(l ->> 'roll_id') and x.org_id = v_org and x.location_id = p_location for update;
      if r.id is null or r.status not in ('REMNANT','AVAILABLE') then raise exception 'PM_INVALID: line % — that remnant is not available', i using errcode = '22023'; end if;
      update pm.flr_rolls set status = 'DEPLETED', remaining_len_in = 0, updated_at = now(), notes = concat_ws(' · ', notes, 'Sold at the counter ' || v_num) where id = r.id;
      v_roll := r.id;
    elsif l ->> 'kind' = 'PRODUCT' and pm.access_try_uuid(l ->> 'lot_id') is not null then
      select x.id, x.cartons_on_hand, x.cartons_reserved into r from pm.flr_lots x where x.id = pm.access_try_uuid(l ->> 'lot_id') and x.org_id = v_org and x.location_id = p_location for update;
      if r.id is null or r.cartons_on_hand - r.cartons_reserved < ceil(coalesce(pm._x_try_num(l ->> 'qty'), 0)) then raise exception 'PM_INVALID: line % — not enough cartons in that lot', i using errcode = '22023'; end if;
      update pm.flr_lots set cartons_on_hand = cartons_on_hand - ceil(pm._x_try_num(l ->> 'qty'))::int, updated_at = now() where id = r.id;
      insert into pm.flr_lot_moves (org_id, lot_id, kind, cartons, note) values (v_org, r.id, 'ISSUE', -ceil(pm._x_try_num(l ->> 'qty'))::int, 'Counter sale ' || v_num);
      v_lot := r.id;
    end if;
    v_amt := pm.res_round(coalesce(pm._x_try_num(l ->> 'qty'), 0) * coalesce(pm._x_try_bigint(l ->> 'unit_price_cents'), 0));
    v_taxed := coalesce(pm._x_try_bool(l ->> 'taxable'), true);
    insert into pm.flr_counter_sale_lines (org_id, sale_id, line_no, kind, product_id, roll_id, lot_id, description, qty, uom, unit_price_cents, amount_cents, taxable)
    values (v_org, v, i, coalesce(l ->> 'kind', 'SUNDRY'), (select p.id from pm.flr_products p where p.id = pm.access_try_uuid(l ->> 'product_id') and p.org_id = v_org), v_roll, v_lot,
            left(coalesce(nullif(btrim(l ->> 'description'), ''), 'Item'), 300), coalesce(pm._x_try_num(l ->> 'qty'), 0), left(coalesce(l ->> 'uom', 'EA'), 12),
            coalesce(pm._x_try_bigint(l ->> 'unit_price_cents'), 0), v_amt, v_taxed);
    v_sub := v_sub + v_amt;
    if v_taxed then v_taxable := v_taxable + v_amt; end if;
  end loop;
  v_tax := pm.res_round(v_taxable * coalesce(p_tax_rate, 0));
  update pm.flr_counter_sales set subtotal_cents = v_sub, tax_cents = v_tax, total_cents = v_sub + v_tax,
         books_request_id = pm._wc_books_request(v_org, p_location, null, 'COUNTER_SALE', 'flr_counter_sales', v,
           jsonb_build_object('sale_id', v, 'number', v_num, 'customer_id', p_customer, 'subtotal_cents', v_sub, 'tax_cents', v_tax, 'total_cents', v_sub + v_tax,
                              'tax_rate', coalesce(p_tax_rate, 0), 'payment_method', coalesce(p_payment_method, 'CARD'),
                              'lines', (select jsonb_agg(jsonb_build_object('description', x.description, 'qty', x.qty, 'unit_price_cents', x.unit_price_cents, 'amount_cents', x.amount_cents, 'taxable', x.taxable) order by x.line_no)
                                          from pm.flr_counter_sale_lines x where x.sale_id = v)))
   where id = v;
  return jsonb_build_object('sale_id', v, 'number', v_num, 'subtotal_cents', v_sub, 'tax_cents', v_tax, 'total_cents', v_sub + v_tax);
end $$;

-- F6. On-site change orders (FLR-20): the installer adds prep / moisture remediation / extra steps
-- from the labor price list; the customer signs on the device; the change flows to the invoice
-- (an approved change order) and to installer pay (added to the next pay ticket).
create table if not exists pm.flr_field_changes (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  change_order_id  uuid not null,
  lines            jsonb not null check (jsonb_typeof(lines) = 'array'),
  sell_cents       bigint not null default 0 check (sell_cents >= 0),
  pay_cents        bigint not null default 0 check (pay_cents >= 0),
  signer_name      text,
  pay_ticket_id    uuid,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

drop function if exists pm.flr_field_change(uuid, jsonb, text, uuid, text);
create or replace function pm.flr_field_change(p_job uuid, p_lines jsonb, p_signer_name text default null, p_signature_document uuid default null, p_note text default null,
                                               p_command uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; l jsonb; r pm.flr_labor_rates%rowtype; v_sell bigint := 0; v_pay bigint := 0; v_lines jsonb := '[]'; v_co uuid; v_qty numeric; v uuid; v_sig jsonb; v_prev jsonb;
begin
  select * into j from pm._x_job(p_job);
  -- a re-sent phone command returns the change order it already made
  v_prev := pm._wc_cmd_claim(j.org_id, p_command, 'flr.field_change', p_job);
  if v_prev is not null then return v_prev; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: add what was done' using errcode = '22023'; end if;
  for l in select x from jsonb_array_elements(p_lines) x loop
    select * into r from pm.flr_labor_rates x where x.org_id = j.org_id and x.location_id = j.location_id and x.code = upper(l ->> 'labor_code') and x.is_active;
    if r.id is null then raise exception 'PM_INVALID: % is not on the labor price list', l ->> 'labor_code' using errcode = '22023'; end if;
    v_qty := coalesce(pm._x_try_num(l ->> 'qty'), 0);
    if v_qty <= 0 then raise exception 'PM_INVALID: quantity must be more than zero' using errcode = '22023'; end if;
    v_sell := v_sell + pm.res_round(v_qty * r.sell_cents);
    v_pay := v_pay + pm.res_round(v_qty * r.pay_cents);
    v_lines := v_lines || jsonb_build_object('labor_code', r.code, 'description', coalesce(nullif(btrim(l ->> 'description'), ''), r.description), 'unit', r.unit, 'qty', v_qty,
                                             'sell_cents', pm.res_round(v_qty * r.sell_cents), 'pay_rate_cents', r.pay_cents, 'pay_cents', pm.res_round(v_qty * r.pay_cents));
  end loop;
  insert into pm.change_orders (org_id, job_id, title, stage, amount_cents, cost_impact_cents, co_type, initiated_by, requested_at, priced_at, ext)
  values (j.org_id, p_job, left(coalesce(nullif(btrim(p_note), ''), 'On-site change: ' || (select string_agg(x ->> 'description', ', ') from jsonb_array_elements(v_lines) x)), 200),
          'PCO', v_sell, v_pay, 'FIELD_REQUEST', 'FIELD', now(), now(), jsonb_build_object('flooring_field_change', true))
  returning id into v_co;
  insert into pm.flr_field_changes (org_id, job_id, change_order_id, lines, sell_cents, pay_cents, signer_name)
  values (j.org_id, p_job, v_co, v_lines, v_sell, v_pay, left(btrim(p_signer_name), 200)) returning id into v;
  if nullif(btrim(coalesce(p_signer_name, '')), '') is not null then
    -- security review M3: res_record_co_signature's guard (change_orders:edit) is skipped when
    -- nested. An installer without that capability records a signature only with the signature
    -- image they uploaded themselves for this job; otherwise the change waits for the office.
    if not pm.access_can_job('projects.change_orders', 'edit', p_job) then
      if p_signature_document is null
         or not exists (select 1 from public.documents d where d.id = p_signature_document and d.org_id = j.org_id and d.uploaded_by_user = pm.current_user_id()) then
        raise exception 'PM_INVALID: capture the customer''s signature on the device (your signature image for this job)' using errcode = '22023';
      end if;
    end if;
    perform pm._wc_check_document(j.org_id, p_job, p_signature_document, 'the signature');
    v_sig := pm.res_record_co_signature(v_co, p_signer_name, 'IN_PERSON', p_signature_document);
  end if;
  return pm._wc_cmd_done(j.org_id, p_command, v_co,
    jsonb_build_object('field_change_id', v, 'change_order_id', v_co, 'sell_cents', v_sell, 'pay_cents', v_pay, 'signature', v_sig));
end $$;

-- Add the job's signed field changes not yet paid to a DRAFT pay ticket.
create or replace function pm.flr_add_field_changes_to_ticket(p_ticket uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.flr_pay_tickets%rowtype; fc record; l jsonb; v_no int; n int := 0; v_add bigint := 0; v_amt bigint;
begin
  select * into t from pm.flr_pay_tickets x where x.id = p_ticket and x.org_id = public.get_org_id() for update;
  if t.id is null then raise exception 'PM_FORBIDDEN: pay ticket not found' using errcode = '42501'; end if;
  if t.status <> 'DRAFT' then raise exception 'PM_INVALID: only a draft ticket takes more lines' using errcode = '22023'; end if;
  select coalesce(max(line_no), 0) into v_no from pm.flr_pay_ticket_lines where org_id = t.org_id and ticket_id = t.id;
  for fc in select f.* from pm.flr_field_changes f join pm.change_orders co on co.id = f.change_order_id
             where f.org_id = t.org_id and f.job_id = t.job_id and f.pay_ticket_id is null and co.stage = 'APPROVED' for update of f loop   -- only approved changes pay (M3)
    for l in select x from jsonb_array_elements(fc.lines) x loop
      v_no := v_no + 1;
      v_amt := pm.res_round((l ->> 'pay_cents')::numeric * coalesce(t.split_pct, 1));
      insert into pm.flr_pay_ticket_lines (org_id, ticket_id, line_no, labor_code, description, unit, qty, rate_cents, amount_cents)
      values (t.org_id, t.id, v_no, l ->> 'labor_code', left('Field change: ' || (l ->> 'description'), 300), l ->> 'unit', (l ->> 'qty')::numeric, (l ->> 'pay_rate_cents')::bigint, v_amt);
      v_add := v_add + v_amt; n := n + 1;
    end loop;
    update pm.flr_field_changes set pay_ticket_id = t.id where id = fc.id;
  end loop;
  if n > 0 then update pm.flr_pay_tickets set gross_cents = gross_cents + v_add, updated_at = now() where id = t.id; end if;
  return jsonb_build_object('ticket_id', t.id, 'lines_added', n, 'added_cents', v_add);
end $$;

-- F7. Special orders + tracker (FLR-21/23) on pm.procurement_items ------------------------------
create or replace function pm.flr_special_order(p_job uuid, p_product uuid, p_qty numeric, p_ship_to text default 'STORE', p_sidemark text default null, p_vendor uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; p pm.flr_products%rowtype; v uuid; v_vendor uuid;
begin
  select * into j from pm._x_job(p_job);
  select * into p from pm.flr_products x where x.id = p_product and x.org_id = j.org_id and x.location_id = j.location_id;
  if p.id is null then raise exception 'PM_INVALID: product is not in this store''s product file' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PM_INVALID: quantity must be more than zero' using errcode = '22023'; end if;
  if p_ship_to not in ('STORE','JOBSITE') then raise exception 'PM_INVALID: ship to the store or the job site' using errcode = '22023'; end if;
  v_vendor := coalesce(p_vendor, p.vendor_id);
  if v_vendor is null then raise exception 'PM_INVALID: the product has no vendor; pick one' using errcode = '22023'; end if;
  insert into pm.procurement_items (org_id, job_id, vendor_id, description, vendor_sku, sidemark, qty, uom, unit_cost_cents, status, approved_at, approved_by_name, notes)
  values (j.org_id, p_job, v_vendor, left(concat_ws(' ', p.style, p.color), 300), p.sku,
          left(coalesce(nullif(btrim(p_sidemark), ''), (select j2.job_number || ' ' || coalesce(c.name, j2.name) from core.jobs j2 left join core.customers c on c.id = j2.customer_id where j2.id = p_job)), 120),
          p_qty, p.sell_uom, p.cost_cents, 'APPROVED', now(), 'special order', case when p_ship_to = 'JOBSITE' then 'Drop-ship to the job site' else 'Ship to store' end)
  returning id into v;
  return v;
end $$;

create or replace function pm.flr_create_special_order_pos(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r jsonb; x jsonb;
begin
  perform pm._x_job(p_job);
  perform pm._wc_require_job('projects.commitments', 'create', p_job);
  r := pm.dsn_create_pos(p_job, null);
  for x in select e from jsonb_array_elements(r -> 'purchase_orders') e loop
    update pm.commitments set title = 'Special order' where id = (x ->> 'commitment_id')::uuid and title = 'Design order';
  end loop;
  return r;
end $$;

-- Overdue ETAs, arriving this week, received and not staged, and goods received with no job.
create or replace function pm.flr_special_order_tracker(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', pi.id, 'job_id', pi.job_id, 'job_number', j.job_number, 'job', j.name, 'description', pi.description, 'sku', pi.vendor_sku,
           'vendor', vd.name, 'po_number', pi.po_number, 'status', pi.status, 'ordered_on', pi.ordered_on, 'expected_on', pi.expected_on, 'received_on', pi.received_on,
           'received_condition', pi.received_condition, 'sidemark', pi.sidemark,
           'bucket', case when pi.status in ('RECEIVED','DAMAGED') then 'RECEIVED_NOT_STAGED'
                          when pi.expected_on < current_date then 'OVERDUE'
                          when pi.expected_on <= current_date + 7 then 'THIS_WEEK' else 'LATER' end)
           order by pi.expected_on nulls last), '[]') into v
    from pm.procurement_items pi join core.jobs j on j.id = pi.job_id and j.org_id = pi.org_id left join core.vendors vd on vd.id = pi.vendor_id
   where pi.org_id = v_org and j.location_id = p_location and pi.status in ('APPROVED','ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED','RECEIVED','DAMAGED')
     and (pm.access_is_service() or j.id in (select pm.my_job_ids()));
  return jsonb_build_object('items', v,
    'overdue', (select count(*) from jsonb_array_elements(v) x where x ->> 'bucket' = 'OVERDUE'),
    'unmatched', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'vendor', u.vendor_name, 'description', u.description, 'po_number', u.po_number, 'qty', u.qty, 'received_on', u.received_on) order by u.received_on desc)
                             from pm.flr_unmatched_receipts u where u.org_id = v_org and u.location_id = p_location and u.status = 'OPEN'), '[]'));
end $$;

-- F8. Carton / shade-lot stock (FLR-26) -----------------------------------------------------------
create table if not exists pm.flr_lots (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  product_id         uuid not null,
  lot_code           text not null check (char_length(btrim(lot_code)) between 1 and 40),
  stock_location_id  uuid,
  pallet             text check (pallet is null or char_length(pallet) <= 40),
  barcode            text not null,
  cartons_on_hand    int not null default 0 check (cartons_on_hand >= 0),
  cartons_reserved   int not null default 0 check (cartons_reserved >= 0),
  reserved_job_id    uuid,
  received_on        date not null default current_date,
  last_counted_on    date,
  procurement_item_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, barcode),
  check (cartons_reserved <= cartons_on_hand),
  foreign key (org_id, product_id) references pm.flr_products (org_id, id) deferrable initially immediate,
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);

create table if not exists pm.flr_lot_moves (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  lot_id             uuid not null,
  kind               text not null check (kind in ('RECEIVE','TRANSFER','COUNT','RESERVE','RELEASE','ISSUE','RETURN')),
  cartons            int not null,
  from_stock_location_id uuid,
  to_stock_location_id   uuid,
  job_id             uuid,
  note               text,
  moved_by           text default pm.current_user_id(),
  moved_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, lot_id) references pm.flr_lots (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.flr_receive_lot(p_location uuid, p_product uuid, p_lot_code text, p_cartons int, p_stock_location uuid default null, p_pallet text default null,
                                              p_procurement_item uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v uuid; v_bc text;
begin
  if not exists (select 1 from pm.flr_products p where p.id = p_product and p.org_id = v_org and p.location_id = p_location) then raise exception 'PM_INVALID: product not in this store' using errcode = '22023'; end if;
  if p_cartons is null or p_cartons <= 0 then raise exception 'PM_INVALID: cartons must be more than zero' using errcode = '22023'; end if;
  if p_stock_location is not null and not exists (select 1 from pm.stock_locations s where s.id = p_stock_location and s.org_id = v_org and s.location_id = p_location) then
    raise exception 'PM_INVALID: stock location not at this store' using errcode = '22023';
  end if;
  v_bc := 'FL' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into pm.flr_lots (org_id, location_id, product_id, lot_code, stock_location_id, pallet, barcode, cartons_on_hand, procurement_item_id)
  values (v_org, p_location, p_product, upper(btrim(p_lot_code)), p_stock_location, left(p_pallet, 40), v_bc, p_cartons, p_procurement_item) returning id into v;
  insert into pm.flr_lot_moves (org_id, lot_id, kind, cartons, to_stock_location_id, note) values (v_org, v, 'RECEIVE', p_cartons, p_stock_location, 'Received');
  return jsonb_build_object('lot_id', v, 'barcode', v_bc, 'label', jsonb_build_object('barcode', v_bc, 'lot', upper(btrim(p_lot_code)), 'cartons', p_cartons,
                            'product', (select concat_ws(' ', p.style, p.color, p.sku) from pm.flr_products p where p.id = p_product)));
end $$;

-- Transfer, physical count, reserve / release to a job, issue, return. Reserving a second shade lot
-- of the same product for one job warns (lot mixing).
create or replace function pm.flr_move_lot(p_lot uuid, p_kind text, p_cartons int default null, p_to_stock_location uuid default null, p_job uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.flr_lots%rowtype; v_warn text; v_delta int;
begin
  select * into l from pm.flr_lots x where x.id = p_lot and x.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: lot not found' using errcode = '42501'; end if;
  if p_kind not in ('TRANSFER','COUNT','RESERVE','RELEASE','ISSUE','RETURN') then raise exception 'PM_INVALID: move kind' using errcode = '22023'; end if;
  if p_kind <> 'TRANSFER' and (p_cartons is null or p_cartons < 0) then raise exception 'PM_INVALID: cartons' using errcode = '22023'; end if;
  if p_job is not null and not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = l.org_id and j.location_id = l.location_id) then
    raise exception 'PM_INVALID: job not at this store' using errcode = '22023';
  end if;
  if p_kind = 'TRANSFER' then
    if p_to_stock_location is null or not exists (select 1 from pm.stock_locations s where s.id = p_to_stock_location and s.org_id = l.org_id and s.location_id = l.location_id) then
      raise exception 'PM_INVALID: pick where it goes (a stock location at this store)' using errcode = '22023';
    end if;
    update pm.flr_lots set stock_location_id = p_to_stock_location, updated_at = now() where id = l.id;
    v_delta := 0;
  elsif p_kind = 'COUNT' then
    if p_cartons < l.cartons_reserved then raise exception 'PM_INVALID: the count is below what is reserved (%)', l.cartons_reserved using errcode = '22023'; end if;
    v_delta := p_cartons - l.cartons_on_hand;
    update pm.flr_lots set cartons_on_hand = p_cartons, last_counted_on = current_date, updated_at = now() where id = l.id;
  elsif p_kind = 'RESERVE' then
    if p_job is null then raise exception 'PM_INVALID: reserve to a job' using errcode = '22023'; end if;
    if l.cartons_on_hand - l.cartons_reserved < p_cartons then raise exception 'PM_INVALID: only % carton(s) free in this lot', l.cartons_on_hand - l.cartons_reserved using errcode = '22023'; end if;
    if exists (select 1 from pm.flr_lots o where o.org_id = l.org_id and o.product_id = l.product_id and o.reserved_job_id = p_job and o.id <> l.id and o.lot_code <> l.lot_code and o.cartons_reserved > 0) then
      v_warn := 'This job already has another shade lot of this product reserved — install from one lot or get the customer''s OK';
    end if;
    update pm.flr_lots set cartons_reserved = cartons_reserved + p_cartons, reserved_job_id = p_job, updated_at = now() where id = l.id;
    v_delta := 0;
  elsif p_kind = 'RELEASE' then
    update pm.flr_lots set cartons_reserved = greatest(cartons_reserved - p_cartons, 0), reserved_job_id = case when cartons_reserved - p_cartons <= 0 then null else reserved_job_id end, updated_at = now() where id = l.id;
    v_delta := 0;
  elsif p_kind = 'ISSUE' then
    if l.cartons_on_hand < p_cartons then raise exception 'PM_INVALID: only % carton(s) on hand', l.cartons_on_hand using errcode = '22023'; end if;
    update pm.flr_lots set cartons_on_hand = cartons_on_hand - p_cartons, cartons_reserved = greatest(cartons_reserved - p_cartons, 0), updated_at = now() where id = l.id;
    v_delta := -p_cartons;
  else
    update pm.flr_lots set cartons_on_hand = cartons_on_hand + p_cartons, updated_at = now() where id = l.id;
    v_delta := p_cartons;
  end if;
  insert into pm.flr_lot_moves (org_id, lot_id, kind, cartons, from_stock_location_id, to_stock_location_id, job_id, note)
  values (l.org_id, l.id, p_kind, coalesce(case when p_kind in ('RESERVE','RELEASE') then p_cartons else v_delta end, 0), l.stock_location_id, coalesce(p_to_stock_location, l.stock_location_id), p_job, left(p_note, 500));
  return jsonb_build_object('lot_id', l.id, 'warning', v_warn);
end $$;

-- F9. Receiving & inspection (FLR-28) -------------------------------------------------------------
create table if not exists pm.flr_receipts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  procurement_item_id uuid not null,
  qty_received        numeric(14,4) not null check (qty_received >= 0),
  condition           text not null check (condition in ('GOOD','DAMAGED','PARTIAL','WRONG_ITEM')),
  lot_code            text,
  freight_in_cents    bigint not null default 0 check (freight_in_cents >= 0),
  landed_cost_cents   bigint,
  photo_document_ids  uuid[] not null default '{}',
  notes               text check (notes is null or char_length(notes) <= 2000),
  received_by         text default pm.current_user_id(),
  received_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.flr_unmatched_receipts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  vendor_name         text,
  description         text not null check (char_length(btrim(description)) between 1 and 300),
  po_number           text,
  qty                 numeric(14,4),
  photo_document_ids  uuid[] not null default '{}',
  status              text not null default 'OPEN' check (status in ('OPEN','MATCHED','RETURNED')),
  matched_item_id     uuid,
  received_on         date not null default current_date,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id)
);

-- Receive a special-order line: quantity and condition with photos; damage or shortage is noted;
-- landed cost includes freight-in; the salesperson (estimate author / PM) and the customer hear it.
create or replace function pm.flr_receive_special_order(p_item uuid, p_qty numeric, p_condition text, p_photos uuid[] default '{}', p_freight_in_cents bigint default 0,
                                                        p_lot_code text default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare pi pm.procurement_items%rowtype; v uuid; v_loc uuid; v_to uuid[]; v_contact uuid; v_landed bigint; v_short boolean;
begin
  select * into pi from pm.procurement_items x where x.id = p_item and x.org_id = public.get_org_id() for update;
  if pi.id is null then raise exception 'PM_FORBIDDEN: order line not found' using errcode = '42501'; end if;
  if pi.status not in ('APPROVED','ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED') then raise exception 'PM_INVALID: this line is %', lower(pi.status) using errcode = '22023'; end if;
  if p_condition not in ('GOOD','DAMAGED','PARTIAL','WRONG_ITEM') then raise exception 'PM_INVALID: condition' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'PM_INVALID: quantity received' using errcode = '22023'; end if;
  if p_condition <> 'GOOD' and coalesce(cardinality(p_photos), 0) = 0 then raise exception 'PM_INVALID: photograph the damage or shortage' using errcode = '22023'; end if;
  v_short := p_qty < pi.qty;
  v_landed := pm.res_round(pi.qty * coalesce(pi.unit_cost_cents, 0)) + pi.freight_cents + coalesce(p_freight_in_cents, 0);
  update pm.procurement_items set status = case when p_condition in ('DAMAGED','WRONG_ITEM') then 'DAMAGED' else 'RECEIVED' end, received_on = current_date,
         received_qty = p_qty, received_condition = case when v_short and p_condition = 'GOOD' then 'PARTIAL' else p_condition end,
         freight_cents = freight_cents + coalesce(p_freight_in_cents, 0), updated_at = now(),
         ordered_on = coalesce(ordered_on, current_date)
   where id = pi.id;
  insert into pm.flr_receipts (org_id, job_id, procurement_item_id, qty_received, condition, lot_code, freight_in_cents, landed_cost_cents, photo_document_ids, notes)
  values (pi.org_id, pi.job_id, pi.id, p_qty, case when v_short and p_condition = 'GOOD' then 'PARTIAL' else p_condition end, upper(nullif(btrim(p_lot_code), '')),
          coalesce(p_freight_in_cents, 0), v_landed, coalesce(p_photos, '{}'), left(p_notes, 2000))
  returning id into v;
  select location_id into v_loc from core.jobs where id = pi.job_id;
  v_to := array(select distinct m from (
            select jm.membership_id as m from pm.job_members jm where jm.org_id = pi.org_id and jm.job_id = pi.job_id and jm.slot in ('pm','apm','sales')
            union select core.notify_membership_for_clerk(pi.org_id, e.created_by) from pm.estimates e where e.org_id = pi.org_id and e.job_id = pi.job_id and e.created_by is not null) s where m is not null);
  perform pm._wc_fanout(pi.org_id, 'flooring.goods_received', v_loc, pi.job_id, 'procurement_items', pi.id, v_to,
    left(format('%s received: %s', case when p_condition = 'GOOD' and not v_short then 'Material' else 'Problem — material' end, pi.description), 200),
    left(format('%s of %s received%s.', p_qty, pi.qty, case when p_condition <> 'GOOD' then ', ' || lower(replace(p_condition, '_', ' ')) when v_short then ', short' else '' end), 300),
    '/flooring/jobs/' || pi.job_id::text, 'flr.received:' || v::text);
  if p_condition = 'GOOD' and not v_short then
    v_contact := pm._flr_customer_contact(pi.org_id, pi.job_id);
    perform pm._wc_customer_msg(pi.org_id, v_loc, pi.job_id, 'customer.order_update', v_contact, 'Your flooring arrived',
      left(format('Good news: your %s arrived and passed inspection. We will call to set the install date.', pi.description), 300), 'flr.arrived:' || pi.id::text);
  end if;
  return jsonb_build_object('receipt_id', v, 'condition', case when v_short and p_condition = 'GOOD' then 'PARTIAL' else p_condition end, 'landed_cost_cents', v_landed);
end $$;

create or replace function pm.flr_log_unmatched_receipt(p_location uuid, p_description text, p_vendor_name text default null, p_po_number text default null, p_qty numeric default null,
                                                        p_photos uuid[] default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v uuid;
begin
  insert into pm.flr_unmatched_receipts (org_id, location_id, vendor_name, description, po_number, qty, photo_document_ids)
  values (v_org, p_location, left(p_vendor_name, 200), left(btrim(p_description), 300), left(p_po_number, 60), p_qty, coalesce(p_photos, '{}')) returning id into v;
  return v;
end $$;

create or replace function pm.flr_match_receipt(p_unmatched uuid, p_item uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare u pm.flr_unmatched_receipts%rowtype; r jsonb;
begin
  select * into u from pm.flr_unmatched_receipts x where x.id = p_unmatched and x.org_id = public.get_org_id() and x.status = 'OPEN' for update;
  if u.id is null then raise exception 'PM_INVALID: nothing open to match' using errcode = '22023'; end if;
  -- security review M2: the nested receive skips its guard — check the order line itself
  if not (pm.access_can_row('projects.store', 'edit', 'procurement_items', p_item) or pm.access_can_row('projects.selections', 'edit', 'procurement_items', p_item)) then
    perform pm.access_forbid('requires projects.store:edit or projects.selections:edit on that order line');
  end if;
  if not exists (select 1 from pm.procurement_items pi join core.jobs j on j.id = pi.job_id and j.org_id = pi.org_id
                  where pi.id = p_item and pi.org_id = u.org_id and j.location_id = u.location_id) then
    raise exception 'PM_INVALID: that order line is at another store' using errcode = '22023';
  end if;
  r := pm.flr_receive_special_order(p_item, coalesce(u.qty, (select qty from pm.procurement_items where id = p_item)), 'GOOD', u.photo_document_ids, 0, null, 'Matched from unmatched receiving');
  update pm.flr_unmatched_receipts set status = 'MATCHED', matched_item_id = p_item where id = u.id;
  return r;
end $$;

-- F10. Customer confirmations (FLR-31) ----------------------------------------------------------
create or replace function pm.flr_send_install_confirmations(p_location uuid, p_days_ahead int default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); s pm.flr_settings%rowtype; b record; n int := 0; v_day date;
begin
  select * into s from pm.flr_settings x where x.org_id = v_org and x.location_id = p_location;
  v_day := current_date + coalesce(p_days_ahead, s.confirm_days_before, 2);
  for b in select x.*, j.name as job_name from pm.flr_install_bookings x join core.jobs j on j.id = x.job_id
            where x.org_id = v_org and j.location_id = p_location and x.status = 'BOOKED' and x.install_on = v_day loop
    if pm._wc_customer_msg(v_org, p_location, b.job_id, 'customer.install_confirmation', pm._flr_customer_contact(v_org, b.job_id), 'Your flooring install',
         left(format('Your install is set for %s. %s Reply C to confirm or R to reschedule.', to_char(b.install_on, 'Dy Mon DD'),
                     coalesce(s.prep_instructions, 'Please clear the rooms of small items.')), 600),
         'flr.confirm:' || b.id::text || ':' || b.install_on::text) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function pm.flr_booking_status(p_booking uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.flr_install_bookings%rowtype; v_loc uuid;
begin
  select * into b from pm.flr_install_bookings x where x.id = p_booking and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: booking not found' using errcode = '42501'; end if;
  if p_status not in ('CONFIRMED','ON_MY_WAY') then raise exception 'PM_INVALID: confirm or on my way' using errcode = '22023'; end if;
  if b.status in ('DONE','CANCELLED') then raise exception 'PM_INVALID: the booking is %', lower(b.status) using errcode = '22023'; end if;
  select location_id into v_loc from core.jobs where id = b.job_id;
  if p_status = 'CONFIRMED' then
    update pm.flr_install_bookings set status = 'CONFIRMED', updated_at = now() where id = b.id;
  else
    perform pm._wc_customer_msg(b.org_id, v_loc, b.job_id, 'customer.on_my_way', pm._flr_customer_contact(b.org_id, b.job_id), 'Installer on the way',
      'Your flooring installer is on the way.', 'flr.omw:' || b.id::text || ':' || current_date::text);
  end if;
  return jsonb_build_object('booking_id', b.id, 'status', p_status);
end $$;

-- F11. Installer records & compliance (FLR-32); an expired document blocks dispatch ---------------
create table if not exists pm.flr_installers (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  name                      text not null check (char_length(btrim(name)) between 1 and 200),
  worker_type               text not null check (worker_type in ('W2','1099')),
  employee_id               uuid references core.employees(id),
  vendor_id                 uuid references core.vendors(id),
  crew_id                   uuid,
  skills                    text[] not null default '{}',
  coi_expires_on            date,
  workers_comp_expires_on   date,
  w9_on_file                boolean not null default false,
  license_expires_on        date,
  direct_deposit_on_file    boolean not null default false,
  status                    text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  notes                     text check (notes is null or char_length(notes) <= 2000),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  check (worker_type <> '1099' or vendor_id is not null),
  check (worker_type <> 'W2' or employee_id is not null),
  foreign key (org_id, crew_id) references pm.crews (org_id, id) deferrable initially immediate
);

-- What blocks an installer on a day: 1099 needs a current COI, a W-9 and workers' comp (or exemption
-- in notes is a person's call — not automatic); everyone needs an unexpired licence when one is recorded.
create or replace function pm._flr_installer_blockers(i pm.flr_installers, p_on date) returns text[]
language sql stable
set search_path = pm, public
as $$
  select array_remove(array[
    case when i.worker_type = '1099' and (i.coi_expires_on is null or i.coi_expires_on < p_on) then 'Certificate of insurance missing or expired' end,
    case when i.worker_type = '1099' and not i.w9_on_file then 'No W-9 on file' end,
    case when i.worker_type = '1099' and (i.workers_comp_expires_on is null or i.workers_comp_expires_on < p_on) then 'Workers'' comp missing or expired' end,
    case when i.license_expires_on is not null and i.license_expires_on < p_on then 'Licence expired' end], null)
$$;

create or replace function pm.flr_save_installer(p_location uuid, p_installer uuid default null, p_fields jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); f jsonb := coalesce(p_fields, '{}'); v uuid;
begin
  if p_installer is null then
    insert into pm.flr_installers (org_id, location_id, name, worker_type, employee_id, vendor_id, crew_id)
    values (v_org, p_location, left(btrim(coalesce(f ->> 'name', '')), 200), coalesce(f ->> 'worker_type', '1099'),
            (select e.id from core.employees e where e.id = pm.access_try_uuid(f ->> 'employee_id') and e.org_id = v_org),
            (select x.id from core.vendors x where x.id = pm.access_try_uuid(f ->> 'vendor_id') and x.org_id = v_org),
            (select c.id from pm.crews c where c.id = pm.access_try_uuid(f ->> 'crew_id') and c.org_id = v_org and c.location_id = p_location))
    returning id into v;
  else
    select id into v from pm.flr_installers where id = p_installer and org_id = v_org and location_id = p_location;
    if v is null then raise exception 'PM_FORBIDDEN: installer not found' using errcode = '42501'; end if;
  end if;
  update pm.flr_installers set
    name = coalesce(nullif(left(btrim(f ->> 'name'), 200), ''), name),
    crew_id = case when f ? 'crew_id' then (select c.id from pm.crews c where c.id = pm.access_try_uuid(f ->> 'crew_id') and c.org_id = v_org and c.location_id = p_location) else crew_id end,
    skills = case when f ? 'skills' then array(select left(x, 40) from jsonb_array_elements_text(f -> 'skills') x limit 20) else skills end,
    coi_expires_on = case when f ? 'coi_expires_on' then pm._x_try_date(f ->> 'coi_expires_on') else coi_expires_on end,
    workers_comp_expires_on = case when f ? 'workers_comp_expires_on' then pm._x_try_date(f ->> 'workers_comp_expires_on') else workers_comp_expires_on end,
    w9_on_file = case when f ? 'w9_on_file' then coalesce(pm._x_try_bool(f ->> 'w9_on_file'), w9_on_file) else w9_on_file end,
    license_expires_on = case when f ? 'license_expires_on' then pm._x_try_date(f ->> 'license_expires_on') else license_expires_on end,
    direct_deposit_on_file = case when f ? 'direct_deposit_on_file' then coalesce(pm._x_try_bool(f ->> 'direct_deposit_on_file'), direct_deposit_on_file) else direct_deposit_on_file end,
    status = coalesce(nullif(f ->> 'status', ''), status), notes = case when f ? 'notes' then left(f ->> 'notes', 2000) else notes end, updated_at = now()
  where id = v;
  return v;
end $$;

create or replace function pm.flr_installer_compliance(p_location uuid, p_on date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v_on date := coalesce(p_on, current_date);
begin
  return jsonb_build_object('installers', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'worker_type', i.worker_type, 'crew_id', i.crew_id, 'skills', i.skills,
           'coi_expires_on', i.coi_expires_on, 'workers_comp_expires_on', i.workers_comp_expires_on, 'w9_on_file', i.w9_on_file, 'license_expires_on', i.license_expires_on,
           'status', i.status, 'blockers', to_jsonb(pm._flr_installer_blockers(i, v_on)),
           'expiring_in_30', least(i.coi_expires_on, i.workers_comp_expires_on, i.license_expires_on) between v_on and v_on + 30) order by i.name)
         from pm.flr_installers i where i.org_id = v_org and i.location_id = p_location and i.status = 'ACTIVE'), '[]'));
end $$;

create or replace function pm.tg_flr_booking_compliance() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_b text[];
begin
  if new.crew_id is null or new.status = 'CANCELLED' then return new; end if;
  select array_agg(i.name || ': ' || b) into v_b
    from pm.flr_installers i cross join lateral unnest(pm._flr_installer_blockers(i, new.install_on)) b
   where i.org_id = new.org_id and i.crew_id = new.crew_id and i.status = 'ACTIVE';
  if v_b is not null and cardinality(v_b) > 0 then
    raise exception 'PM_FLR_INSTALLER_NONCOMPLIANT: % — update the installer''s documents before dispatching', array_to_string(v_b, '; ') using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists trg_flr_booking_compliance on pm.flr_install_bookings;
create trigger trg_flr_booking_compliance before insert or update of crew_id, install_on on pm.flr_install_bookings
  for each row execute function pm.tg_flr_booking_compliance();

-- F12. Installer day + sign-off (FLR-33) ----------------------------------------------------------
create table if not exists pm.flr_signoffs (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  booking_id             uuid,
  signer_name            text not null check (char_length(btrim(signer_name)) between 1 and 200),
  signature_document_id  uuid references public.documents(id) on delete set null,
  photo_document_ids     uuid[] not null default '{}',
  leftover               jsonb not null default '[]' check (jsonb_typeof(leftover) = 'array'),
  notes                  text check (notes is null or char_length(notes) <= 2000),
  signed_at              timestamptz not null default now(),
  recorded_by            text default pm.current_user_id(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- The installer's day (their crew's bookings): address, rooms and areas, the cut list, the site
-- checks still needed, and their own pay this week. No other money.
create or replace function pm.flr_installer_day(p_day date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_day date := coalesce(p_day, current_date); v jsonb; v_pay bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'job_id', b.job_id, 'job_number', j.job_number, 'job', j.name, 'status', b.status, 'sf', b.sf, 'days', b.days,
           'address', nullif(concat_ws(', ', p.site_address_line1, p.site_city, p.site_state), ''), 'lat', p.site_lat, 'lng', p.site_lng, 'notes', b.notes,
           'areas', coalesce((select jsonb_agg(jsonb_build_object('room', a.room_name, 'kind', a.area_kind, 'sqft', a.sqft, 'category', a.product_category) order by a.room_name)
                                from pm.measures m join pm.measure_areas a on a.measure_id = m.id where m.org_id = b.org_id and m.job_id = b.job_id and m.status in ('FINAL','DRAFT')
                                 and m.version = (select max(m2.version) from pm.measures m2 where m2.org_id = b.org_id and m2.job_id = b.job_id)), '[]'),
           'cuts', coalesce((select jsonb_agg(jsonb_build_object('cut_id', c.id, 'roll_id', c.roll_id, 'roll', r.roll_number, 'dye_lot', r.dye_lot, 'room', c.room,
                                                         'planned_len_in', c.planned_len_in, 'status', c.status) order by c.seq)
                               from pm.flr_cut_tickets t join pm.flr_cuts c on c.ticket_id = t.id join pm.flr_rolls r on r.id = c.roll_id where t.org_id = b.org_id and t.job_id = b.job_id), '[]'),
           -- the labor codes an on-site change may use (no sell or pay rates: the phone shows these as a pick list)
           'labor_codes', coalesce((select jsonb_agg(jsonb_build_object('code', lr.code, 'description', lr.description, 'unit', lr.unit, 'applies_to', lr.applies_to) order by lr.applies_to, lr.code)
                                      from pm.flr_labor_rates lr where lr.org_id = b.org_id and lr.location_id = j.location_id and lr.is_active), '[]'),
           'site_checks_needed', to_jsonb(array(select k from unnest(coalesce((select s.required_site_checks from pm.flr_settings s where s.org_id = b.org_id and s.location_id = j.location_id), array['MOISTURE'])) k
                                                where not exists (select 1 from pm.flr_site_checks sc where sc.org_id = b.org_id and sc.job_id = b.job_id and sc.check_key = k and sc.passed))))
           order by b.install_on), '[]') into v
    from pm.flr_install_bookings b join core.jobs j on j.id = b.job_id join pm.projects p on p.job_id = b.job_id
   where b.org_id = v_org and b.status in ('BOOKED','CONFIRMED') and v_day between b.install_on and b.install_on + b.days - 1
     and (pm.access_is_service() or b.crew_id in (select pm.my_crew_ids()) or b.job_id in (select pm.my_job_ids_with('projects.dispatch', 'edit')));
  select coalesce(sum(t.net_cents), 0)::bigint into v_pay from pm.flr_pay_tickets t
   where t.org_id = v_org and t.employee_id in (select pm.my_employee_ids()) and t.status <> 'VOID' and t.completed_on >= date_trunc('week', v_day)::date and t.completed_on < date_trunc('week', v_day)::date + 7;
  return jsonb_build_object('day', v_day, 'bookings', v, 'my_pay_this_week_cents', v_pay);
end $$;

create or replace function pm.flr_record_signoff(p_booking uuid, p_signer_name text, p_signature_document uuid default null, p_photos uuid[] default '{}',
                                                 p_leftover jsonb default '[]', p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.flr_install_bookings%rowtype; v uuid; l jsonb; v_cap numeric; v_ph uuid; v_len numeric; v_applied jsonb := '[]';
begin
  select * into b from pm.flr_install_bookings x where x.id = p_booking and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: booking not found' using errcode = '42501'; end if;
  if b.status in ('DONE','CANCELLED') then raise exception 'PM_INVALID: the booking is %', lower(b.status) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_signer_name, '')), '') is null then raise exception 'PM_INVALID: the customer''s name is required' using errcode = '22023'; end if;
  perform pm._wc_check_document(b.org_id, b.job_id, p_signature_document, 'the signature');
  foreach v_ph in array coalesce(p_photos, '{}') loop perform pm._wc_check_document(b.org_id, b.job_id, v_ph, 'a sign-off photo'); end loop;
  insert into pm.flr_signoffs (org_id, job_id, booking_id, signer_name, signature_document_id, photo_document_ids, leftover, notes)
  values (b.org_id, b.job_id, b.id, left(btrim(p_signer_name), 200), p_signature_document, coalesce(p_photos, '{}'), coalesce(p_leftover, '[]'), left(p_notes, 2000)) returning id into v;
  -- leftover roll goods back to the warehouse (remaining length up, a remnant when short)
  if jsonb_typeof(coalesce(p_leftover, '[]')) <> 'array' or jsonb_array_length(coalesce(p_leftover, '[]')) > 20 then
    raise exception 'PM_INVALID: up to 20 leftover rolls' using errcode = '22023';
  end if;
  -- only rolls cut for this job, and never more back than was planned off them (security review L2)
  for l in select x from jsonb_array_elements(coalesce(p_leftover, '[]')) x where pm.access_try_uuid(x ->> 'roll_id') is not null loop
    select coalesce(sum(c.planned_len_in), 0) into v_cap from pm.flr_cut_tickets t join pm.flr_cuts c on c.ticket_id = t.id
     where t.org_id = b.org_id and t.job_id = b.job_id and c.roll_id = pm.access_try_uuid(l ->> 'roll_id') and c.status <> 'VOID';
    if v_cap = 0 then raise exception 'PM_INVALID: that roll was not cut for this job' using errcode = '22023'; end if;
    -- the cap is cumulative: earlier sign-offs on this job already returned some of it
    v_cap := greatest(v_cap - coalesce((select sum(least(greatest(coalesce(pm._x_try_num(x ->> 'len_in'), 0), 0), 1e9))
                                          from pm.flr_signoffs so cross join lateral jsonb_array_elements(so.leftover) x
                                         where so.org_id = b.org_id and so.job_id = b.job_id and so.id <> v
                                           and pm.access_try_uuid(x ->> 'roll_id') = pm.access_try_uuid(l ->> 'roll_id')), 0), 0);
    v_len := least(greatest(coalesce(pm._x_try_num(l ->> 'len_in'), 0), 0), v_cap);
    update pm.flr_rolls set remaining_len_in = remaining_len_in + v_len,
           status = case when status = 'DEPLETED' and v_len > 0 then 'REMNANT' else status end, updated_at = now()
     where id = pm.access_try_uuid(l ->> 'roll_id') and org_id = b.org_id;
    v_applied := v_applied || jsonb_build_object('roll_id', pm.access_try_uuid(l ->> 'roll_id'), 'len_in', v_len, 'asked_len_in', pm._x_try_num(l ->> 'len_in'));
  end loop;
  update pm.flr_signoffs set leftover = v_applied where id = v;   -- what actually went back (the cumulative cap reads this)
  update pm.flr_install_bookings set status = 'DONE', updated_at = now() where id = b.id;
  return jsonb_build_object('signoff_id', v, 'booking_id', b.id);
end $$;

-- F13. Completion invoice & collect (FLR-36): the balance after deposits, as a DRAFT billing request
-- for approval; Books applies the deposits and mints the pay link.
create or replace function pm.flr_completion_invoice(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; m record; v_billed bigint; v_bal bigint; v_contract uuid; v_br uuid := gen_random_uuid(); v_dep bigint;
begin
  select * into j from pm._x_job(p_job);
  select * into m from pm.v_job_money x where x.org_id = j.org_id and x.job_id = p_job;
  select coalesce(sum(r.gross_earned_cents), 0)::bigint into v_billed from pm.billing_requests r where r.org_id = j.org_id and r.job_id = p_job and r.status in ('DRAFT','EMITTED','ISSUED','UNISSUED');
  v_bal := coalesce(m.revised_contract_cents, 0) - v_billed;
  if v_bal <= 0 then raise exception 'PM_INVALID: nothing left to bill on this job' using errcode = '22023'; end if;
  v_contract := pm.primary_contract_id(j.org_id, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: accept the quote first' using errcode = 'P0001'; end if;
  select coalesce(sum(d.amount_cents), 0)::bigint into v_dep from pm.deposit_requests d where d.org_id = j.org_id and d.job_id = p_job and d.status in ('EMITTED','ISSUED');
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_br, j.org_id, p_job, v_contract, 'MILESTONE', 'DRAFT', 'milestone', current_date, 'Completion invoice — deposits on file are applied by Books', pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents, retainage_rate)
  values (j.org_id, v_br, 1, 0, 'STANDARD', 'Flooring installed — balance of contract', v_bal, v_bal, 0);
  perform pm._wc_require_row('projects.billing', 'edit', 'billing_requests', v_br);
  perform pm.finalize_billing_retainage(v_br);
  return jsonb_build_object('billing_request_id', v_br, 'balance_cents', v_bal, 'deposits_on_file_cents', v_dep, 'due_after_deposits_cents', greatest(v_bal - v_dep, 0));
end $$;

-- F14. Callbacks & warranty (FLR-37) -------------------------------------------------------------
create table if not exists pm.flr_callbacks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  punch_item_id  uuid,
  booking_id     uuid,
  roll_id        uuid,
  lot_code       text,
  product_id     uuid,
  installer_id   uuid,
  mill_vendor_id uuid references core.vendors(id),
  reason         text not null check (reason in ('SEAM','GAP','PEAKING','STAIN','DEFECT','DAMAGE','SQUEAK','OTHER')),
  description    text check (description is null or char_length(description) <= 2000),
  cost_cents     bigint not null default 0 check (cost_cents >= 0),
  status         text not null default 'OPEN' check (status in ('OPEN','SCHEDULED','CLOSED')),
  fault          text check (fault is null or fault in ('INSTALLER','MILL','CUSTOMER','SITE','UNKNOWN')),
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.flr_open_callback(p_job uuid, p_reason text, p_description text default null, p_roll uuid default null, p_installer uuid default null,
                                                p_product uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_punch uuid; v uuid; r record; v_prod uuid := p_product;
begin
  select * into j from pm._x_job(p_job);
  select x.id, x.dye_lot, x.product_id into r from pm.flr_rolls x where x.id = p_roll and x.org_id = j.org_id;
  v_prod := coalesce(v_prod, r.product_id);
  insert into pm.punch_items (org_id, job_id, kind, title, description)
  values (j.org_id, p_job, 'CALLBACK', left('Callback: ' || lower(p_reason), 200), left(p_description, 2000)) returning id into v_punch;
  insert into pm.flr_callbacks (org_id, job_id, punch_item_id, roll_id, lot_code, product_id, installer_id, mill_vendor_id, reason, description)
  values (j.org_id, p_job, v_punch, r.id, r.dye_lot, v_prod, (select i.id from pm.flr_installers i where i.id = p_installer and i.org_id = j.org_id),
          (select p.vendor_id from pm.flr_products p where p.id = v_prod), p_reason, left(p_description, 2000))
  returning id into v;
  return jsonb_build_object('callback_id', v, 'punch_item_id', v_punch);
end $$;

create or replace function pm.flr_close_callback(p_callback uuid, p_fault text, p_cost_cents bigint default 0)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.flr_callbacks%rowtype;
begin
  select * into c from pm.flr_callbacks x where x.id = p_callback and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: callback not found' using errcode = '42501'; end if;
  if c.status = 'CLOSED' then raise exception 'PM_INVALID: already closed' using errcode = '22023'; end if;
  update pm.flr_callbacks set status = 'CLOSED', fault = coalesce(p_fault, 'UNKNOWN'), cost_cents = greatest(coalesce(p_cost_cents, 0), 0), closed_at = now() where id = c.id;
  update pm.punch_items set status = 'CLOSED' where id = c.punch_item_id and org_id = c.org_id and status not in ('CLOSED','VOID');
  return c.id;
end $$;

-- F15. Flooring reports (FLR-44) ----------------------------------------------------------------
create or replace function pm.flr_reports(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v_from date := coalesce(p_from, date_trunc('month', current_date)::date); v_to date := coalesce(p_to, current_date);
  v_money boolean := pm._x_sees('projects.financials', 'view', p_location); v_sell boolean := pm._x_sees('projects.contract_value', 'view', p_location);
  v_sales jsonb; v_mix jsonb; v_close jsonb; v_dep jsonb; v_unbilled jsonb; v_crew jsonb; v_waste jsonb; v_cb jsonb;
begin
  select coalesce(jsonb_agg(x order by (x ->> 'sold_cents')::bigint desc nulls last), '[]') into v_sales from (
    select jsonb_build_object('salesperson', sp, 'quotes', count(*), 'sold', count(*) filter (where st = 'ACCEPTED'),
             'sold_cents', case when v_sell then sum(tc) filter (where st = 'ACCEPTED') end) as x
      from (select coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), e.created_by, 'Unknown') as sp, e.status as st, e.total_cents as tc
              from pm.estimates e left join core.users u on u.clerk_user_id = e.created_by
             where e.org_id = v_org and e.location_id = p_location and e.created_at::date between v_from and v_to
               and exists (select 1 from pm.flr_quote_lines q where q.org_id = e.org_id and q.estimate_id = e.id)) e2
     group by sp) s;
  select coalesce(jsonb_object_agg(cls, jsonb_build_object('sell_cents', case when v_sell then sell end, 'cost_cents', case when v_money then cost end,
                                                           'margin_pct', case when v_money and v_sell and sell > 0 then round((sell - cost)::numeric / sell, 4) end)), '{}') into v_mix from (
    select case when q.line_class in ('LABOR','PREP','DEMO','MOVING') then 'LABOR' else 'MATERIAL' end as cls, sum(el.amount_cents)::bigint as sell, sum(coalesce(el.cost_cents, 0))::bigint as cost
      from pm.flr_quote_lines q join pm.estimates e on e.id = q.estimate_id join pm.estimate_lines el on el.id = q.estimate_line_id
     where q.org_id = v_org and e.location_id = p_location and e.status = 'ACCEPTED' and coalesce(e.accepted_at, e.created_at)::date between v_from and v_to
     group by 1) s;
  select jsonb_build_object('won', count(*) filter (where l.won_at is not null), 'lost', count(*) filter (where l.lost_at is not null),
           'close_rate', case when count(*) filter (where l.won_at is not null or l.lost_at is not null) > 0
                              then round(count(*) filter (where l.won_at is not null)::numeric / count(*) filter (where l.won_at is not null or l.lost_at is not null), 4) end)
    into v_close
    from crm.leads l
   where l.org_id = v_org and l.location_id = p_location and coalesce(l.won_at, l.lost_at, l.created_at)::date between v_from and v_to;
  v_close := coalesce(v_close, '{}'::jsonb) || jsonb_build_object('by_source', coalesce((select jsonb_object_agg(src, n) from (
               select coalesce(l2.source, 'unknown') as src, count(*) as n from crm.leads l2
                where l2.org_id = v_org and l2.location_id = p_location and l2.created_at::date between v_from and v_to group by 1) z), '{}'::jsonb));
  select jsonb_build_object('under_30_cents', sum(d.amount_cents) filter (where d.occurred_on >= current_date - 30), '30_60_cents', sum(d.amount_cents) filter (where d.occurred_on between current_date - 60 and current_date - 31),
           'over_60_cents', sum(d.amount_cents) filter (where d.occurred_on < current_date - 60), 'requests', count(*)) into v_dep
    from pm.deposit_requests d join core.jobs j on j.id = d.job_id
   where d.org_id = v_org and j.location_id = p_location and d.status in ('EMITTED','ISSUED') and j.status in ('ACTIVE','ON_HOLD');
  select coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'job_number', j.job_number, 'name', j.name, 'installed_on', b.install_on)), '[]') into v_unbilled
    from pm.flr_install_bookings b join core.jobs j on j.id = b.job_id
   where b.org_id = v_org and j.location_id = p_location and b.status = 'DONE' and b.install_on between v_from and v_to
     and not exists (select 1 from pm.billing_requests r where r.org_id = b.org_id and r.job_id = b.job_id and r.status <> 'VOID' and r.created_at::date >= b.install_on);
  select coalesce(jsonb_agg(jsonb_build_object('crew_id', b.crew_id, 'crew', cr.name, 'sf', sum_sf, 'crew_days', days, 'sf_per_crew_day', case when days > 0 then round(sum_sf / days, 1) end)), '[]') into v_crew
    from (select b.crew_id, sum(b.sf) as sum_sf, sum(b.days) as days from pm.flr_install_bookings b join core.jobs j on j.id = b.job_id
           where b.org_id = v_org and j.location_id = p_location and b.status = 'DONE' and b.install_on between v_from and v_to and b.crew_id is not null group by b.crew_id) b
    left join pm.crews cr on cr.id = b.crew_id;
  select jsonb_build_object('planned_in', sum(c.planned_len_in), 'actual_in', sum(c.actual_len_in),
           'over_pct', case when sum(c.planned_len_in) > 0 then round((sum(c.actual_len_in) - sum(c.planned_len_in)) / sum(c.planned_len_in), 4) end) into v_waste
    from pm.flr_cuts c join pm.flr_cut_tickets t on t.id = c.ticket_id join core.jobs j on j.id = t.job_id
   where c.org_id = v_org and j.location_id = p_location and c.actual_len_in is not null and c.cut_at::date between v_from and v_to;
  select jsonb_build_object(
           'by_installer', coalesce((select jsonb_agg(jsonb_build_object('installer', i.name, 'callbacks', n)) from (select cb.installer_id, count(*) as n from pm.flr_callbacks cb join core.jobs j on j.id = cb.job_id
                                       where cb.org_id = v_org and j.location_id = p_location and cb.created_at::date between v_from and v_to and cb.installer_id is not null group by 1) z
                                     join pm.flr_installers i on i.id = z.installer_id), '[]'),
           'by_mill', coalesce((select jsonb_agg(jsonb_build_object('mill', v.name, 'callbacks', n)) from (select cb.mill_vendor_id, count(*) as n from pm.flr_callbacks cb join core.jobs j on j.id = cb.job_id
                                  where cb.org_id = v_org and j.location_id = p_location and cb.created_at::date between v_from and v_to and cb.mill_vendor_id is not null group by 1) z
                                join core.vendors v on v.id = z.mill_vendor_id), '[]'),
           'jobs_installed', (select count(distinct b.job_id) from pm.flr_install_bookings b join core.jobs j on j.id = b.job_id
                               where b.org_id = v_org and j.location_id = p_location and b.status = 'DONE' and b.install_on between v_from and v_to),
           'callbacks', (select count(*) from pm.flr_callbacks cb join core.jobs j on j.id = cb.job_id where cb.org_id = v_org and j.location_id = p_location and cb.created_at::date between v_from and v_to)) into v_cb;
  return jsonb_build_object('from', v_from, 'to', v_to, 'sales_by_salesperson', v_sales, 'material_vs_labor', v_mix, 'close_rate', coalesce(v_close, '{}'),
                            'deposit_aging', case when v_sell then v_dep end, 'completed_unbilled', v_unbilled, 'installer_productivity', v_crew,
                            'waste', v_waste, 'callbacks', v_cb);
end $$;

-- ============================================================================
-- I. Interior design completion
-- ============================================================================
-- I1. Firm setup (ID-01) ------------------------------------------------------------------------
create table if not exists pm.dsn_settings (
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  firm_type             text not null default 'RESIDENTIAL_FULL_SERVICE' check (firm_type in ('RESIDENTIAL_FULL_SERVICE','E_DESIGN','COMMERCIAL_FFE','DESIGN_BUILD')),
  fee_models            text[] not null default array['HOURLY'] check (fee_models <@ array['HOURLY','FLAT_BY_PHASE','PCT_OF_BUDGET','COST_PLUS','PROCUREMENT_FEE','HYBRID']::text[]),
  default_markup_pct    numeric(7,4) not null default 0.35 check (default_markup_pct >= 0 and default_markup_pct <= 10),
  product_deposit_pct   numeric(5,4) not null default 0.50 check (product_deposit_pct >= 0 and product_deposit_pct <= 1),
  retainer_cents        bigint not null default 0 check (retainer_cents >= 0),
  retainer_evergreen    boolean not null default false,
  show_cost_default     boolean not null default false,
  receivers             jsonb not null default '[]' check (jsonb_typeof(receivers) = 'array'),
  tax_states            text[] not null default '{}',
  replacing_system      text,
  updated_by            text default pm.current_user_id(),
  updated_at            timestamptz not null default now(),
  primary key (org_id, location_id)
);

-- I2. Inquiry & discovery (ID-03) ---------------------------------------------------------------
create table if not exists pm.dsn_discovery (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  lead_id            uuid not null references crm.leads(id) on delete cascade,
  rooms              text[] not null default '{}',
  scope              text check (scope is null or char_length(scope) <= 4000),
  style_notes        text check (style_notes is null or char_length(style_notes) <= 4000),
  budget_low_cents   bigint check (budget_low_cents is null or budget_low_cents >= 0),
  budget_high_cents  bigint check (budget_high_cents is null or budget_high_cents >= 0),
  timeline           text check (timeline is null or char_length(timeline) <= 200),
  call_notes         text check (call_notes is null or char_length(call_notes) <= 8000),
  fit                text check (fit is null or fit in ('GOOD','MAYBE','NOT_A_FIT')),
  appointment_id     uuid,
  updated_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, lead_id)
);

create or replace function pm.dsn_save_discovery(p_lead uuid, p_fields jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l record; f jsonb := coalesce(p_fields, '{}'); v uuid;
begin
  select x.id, x.org_id, x.location_id into l from crm.leads x where x.id = p_lead and x.org_id = public.get_org_id();
  if l.id is null then raise exception 'PM_FORBIDDEN: lead not found' using errcode = '42501'; end if;
  insert into pm.dsn_discovery (org_id, location_id, lead_id) values (l.org_id, l.location_id, l.id) on conflict (org_id, lead_id) do nothing;
  update pm.dsn_discovery set
    rooms = case when f ? 'rooms' then array(select left(x, 80) from jsonb_array_elements_text(f -> 'rooms') x limit 40) else rooms end,
    scope = case when f ? 'scope' then left(f ->> 'scope', 4000) else scope end,
    style_notes = case when f ? 'style_notes' then left(f ->> 'style_notes', 4000) else style_notes end,
    budget_low_cents = case when f ? 'budget_low_cents' then pm._x_try_bigint(f ->> 'budget_low_cents') else budget_low_cents end,
    budget_high_cents = case when f ? 'budget_high_cents' then pm._x_try_bigint(f ->> 'budget_high_cents') else budget_high_cents end,
    timeline = case when f ? 'timeline' then left(f ->> 'timeline', 200) else timeline end,
    call_notes = case when f ? 'call_notes' then left(f ->> 'call_notes', 8000) else call_notes end,
    fit = case when f ? 'fit' then nullif(f ->> 'fit', '') else fit end,
    appointment_id = case when f ? 'appointment_id' then (select a.id from pm.wc_appointments a where a.id = pm.access_try_uuid(f ->> 'appointment_id') and a.org_id = l.org_id) else appointment_id end,
    updated_by = pm.current_user_id(), updated_at = now()
  where org_id = l.org_id and lead_id = l.id returning id into v;
  return v;
end $$;

-- I3. Design agreement (ID-04): letter on the fee agreement, e-sign link, retainer invoice -------
create table if not exists pm.dsn_agreements (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  version              int not null default 1,
  status               text not null default 'DRAFT' check (status in ('DRAFT','SENT','SIGNED','VOID')),
  letter               text not null check (char_length(letter) between 1 and 20000),
  terms                jsonb not null default '{}' check (jsonb_typeof(terms) = 'object'),
  envelope_id          uuid,
  signer_name          text,
  signed_at            timestamptz,
  retainer_cents       bigint not null default 0 check (retainer_cents >= 0),
  retainer_deposit_id  uuid,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_dsn_agreements_live_uidx on pm.dsn_agreements (org_id, job_id) where status in ('DRAFT','SENT');

-- Draft the letter of agreement from the job's fee agreement (fee model, rates, markup policy,
-- deposit %, retainer terms).
create or replace function pm.dsn_draft_agreement(p_job uuid, p_extra_terms text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; fa pm.dsn_fee_agreements%rowtype; s pm.dsn_settings%rowtype; v uuid; v_letter text; v_ver int; v_name text;
begin
  select * into j from pm._x_job(p_job);
  select * into fa from pm.dsn_fee_agreements x where x.org_id = j.org_id and x.job_id = p_job;
  if fa.job_id is null then raise exception 'PM_INVALID: set the fee agreement first' using errcode = '22023'; end if;
  select * into s from pm.dsn_settings x where x.org_id = j.org_id and x.location_id = j.location_id;
  select coalesce(c.name, jb.name) into v_name from core.jobs jb left join core.customers c on c.id = jb.customer_id where jb.id = p_job;
  v_letter := concat_ws(E'\n\n',
    format('Letter of agreement — design services for %s.', v_name),
    case fa.fee_model
      when 'HOURLY' then format('Design time is billed hourly at %s per hour, against the retainer.', core.notify_money_text(fa.hourly_rate_cents))
      when 'FLAT_BY_PHASE' then 'Design fees are billed as a flat fee per phase: ' || coalesce((select string_agg(format('%s %s', x ->> 'name', core.notify_money_text((x ->> 'cents')::bigint)), '; ') from jsonb_array_elements(fa.phases) x), 'see the schedule') || '.'
      when 'PCT_OF_BUDGET' then format('Design fees are %s%% of the project budget of %s.', round(coalesce(fa.pct_of_budget, 0) * 100, 2), core.notify_money_text(fa.budget_cents))
      else 'Design fees follow the fee schedule attached.' end,
    case when fa.procurement_fee_pct is not null then format('Purchasing: furnishings are sold at our price; a procurement fee of %s%% applies.', round(fa.procurement_fee_pct * 100, 2))
         else format('Purchasing: furnishings are sold at our net cost plus %s%%.', round(coalesce(s.default_markup_pct, 0.35) * 100, 1)) end,
    format('Each approved item needs a %s%% deposit before it is ordered; the balance is due before delivery.', round(coalesce(s.product_deposit_pct, 0.5) * 100)),
    case when fa.retainer_cents > 0 then format('A retainer of %s is due at signing%s.', core.notify_money_text(fa.retainer_cents),
                                                  case when fa.retainer_evergreen then ' and is replenished as it is applied' else ' and is applied to the final invoice' end) end,
    case when fa.reimbursable_markup_pct is not null then format('Reimbursable expenses (samples, travel, printing) are billed at cost plus %s%%.', round(fa.reimbursable_markup_pct * 100, 1)) end,
    nullif(btrim(coalesce(p_extra_terms, '')), ''));
  select coalesce(max(version), 0) + 1 into v_ver from pm.dsn_agreements where org_id = j.org_id and job_id = p_job;
  update pm.dsn_agreements set status = 'VOID', updated_at = now() where org_id = j.org_id and job_id = p_job and status in ('DRAFT','SENT');
  insert into pm.dsn_agreements (org_id, job_id, version, letter, terms, retainer_cents)
  values (j.org_id, p_job, v_ver, left(v_letter, 20000), to_jsonb(fa) - 'org_id' - 'updated_by', fa.retainer_cents) returning id into v;
  return v;
end $$;

create or replace function pm.dsn_mark_agreement_sent(p_agreement uuid, p_envelope uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v uuid;
begin
  update pm.dsn_agreements set status = 'SENT', envelope_id = coalesce(p_envelope, envelope_id), updated_at = now()
   where id = p_agreement and org_id = public.get_org_id() and status = 'DRAFT' returning id into v;
  if v is null then raise exception 'PM_INVALID: only a draft agreement can be sent' using errcode = '22023'; end if;
  return v;
end $$;

-- Signed (in person, or the e-sign completion): the retainer invoice is requested from Books.
create or replace function pm.dsn_mark_agreement_signed(p_agreement uuid, p_signer_name text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.dsn_agreements%rowtype; v_dep uuid;
begin
  select * into a from pm.dsn_agreements x where x.id = p_agreement and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: agreement not found' using errcode = '42501'; end if;
  if a.status not in ('DRAFT','SENT') then raise exception 'PM_INVALID: the agreement is %', lower(a.status) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_signer_name, '')), '') is null then raise exception 'PM_INVALID: the client''s name is required' using errcode = '22023'; end if;
  if a.retainer_cents > 0 then
    perform pm._wc_require_job('projects.billing', 'create', a.job_id);
    v_dep := pm.request_deposit(a.job_id, a.retainer_cents, 'Design retainer', null);
  end if;
  update pm.dsn_agreements set status = 'SIGNED', signer_name = left(btrim(p_signer_name), 200), signed_at = now(), retainer_deposit_id = v_dep, updated_at = now() where id = a.id;
  return jsonb_build_object('agreement_id', a.id, 'retainer_deposit_id', v_dep, 'retainer_cents', a.retainer_cents);
end $$;

-- I4. Rooms, phases and room budgets (ID-05/06) --------------------------------------------------
create table if not exists pm.dsn_rooms (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  phase         text not null default 'PROGRAMMING' check (phase in ('PROGRAMMING','CONCEPT','DESIGN_DEVELOPMENT','PROCUREMENT','INSTALL','COMPLETE')),
  budget_cents  bigint check (budget_cents is null or budget_cents >= 0),
  sort          int not null default 0,
  over_notified_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_dsn_rooms_name_uidx on pm.dsn_rooms (org_id, job_id, lower(name));

create or replace function pm.dsn_save_room(p_job uuid, p_name text, p_phase text default null, p_budget_cents bigint default null, p_room uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v uuid;
begin
  select * into j from pm._x_job(p_job);
  if p_room is null then
    insert into pm.dsn_rooms (org_id, job_id, name, phase, budget_cents, sort)
    values (j.org_id, p_job, left(btrim(p_name), 120), coalesce(p_phase, 'PROGRAMMING'), p_budget_cents,
            (select coalesce(max(sort), 0) + 1 from pm.dsn_rooms where org_id = j.org_id and job_id = p_job))
    on conflict (org_id, job_id, lower(name)) do update set phase = coalesce(p_phase, pm.dsn_rooms.phase), budget_cents = coalesce(p_budget_cents, pm.dsn_rooms.budget_cents), updated_at = now()
    returning id into v;
  else
    update pm.dsn_rooms set name = coalesce(nullif(left(btrim(p_name), 120), ''), name), phase = coalesce(p_phase, phase),
           budget_cents = case when p_budget_cents is not null then p_budget_cents else budget_cents end, updated_at = now()
     where id = p_room and org_id = j.org_id and job_id = p_job returning id into v;
    if v is null then raise exception 'PM_FORBIDDEN: room not found' using errcode = '42501'; end if;
  end if;
  return v;
end $$;

-- Per room: budget vs specified (client price of every live item in the room), placeholders, over.
create or replace function pm._dsn_room_rows(p_org uuid, p_job uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('room_id', r.id, 'room', r.name, 'phase', r.phase, 'budget_cents', r.budget_cents,
           'specified_cents', coalesce(s.total, 0), 'placeholders', coalesce(s.ph, 0), 'items', coalesce(s.n, 0),
           'remaining_cents', case when r.budget_cents is not null then r.budget_cents - coalesce(s.total, 0) end,
           'over', r.budget_cents is not null and coalesce(s.total, 0) > r.budget_cents) order by r.sort, r.name), '[]')
    from pm.dsn_rooms r
    left join lateral (select sum(coalesce(i.client_total_cents, 0) + case when i.is_placeholder then coalesce(i.budget_cents, 0) else 0 end) as total,
                              count(*) filter (where i.is_placeholder) as ph, count(*) as n
                         from pm.dsn_items i where i.org_id = r.org_id and i.job_id = r.job_id and lower(i.room) = lower(r.name) and i.status not in ('CANCELLED','REJECTED')) s on true
   where r.org_id = p_org and r.job_id = p_job
$$;

create or replace function pm.dsn_room_budgets(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v jsonb; x jsonb; v_money boolean;
begin
  select * into j from pm._x_job(p_job);
  v := pm._dsn_room_rows(j.org_id, p_job);
  -- alert once per room crossing (reset when it comes back under); a read-only caller writes nothing (L6)
  for x in select e from jsonb_array_elements(v) e where pm.access_can_job('projects.selections', 'edit', p_job) loop
    if (x ->> 'over')::boolean then
      if exists (select 1 from pm.dsn_rooms r where r.id = (x ->> 'room_id')::uuid and r.over_notified_at is null) then
        perform pm._wc_fanout(j.org_id, 'design.room_over_budget', j.location_id, p_job, 'dsn_rooms', (x ->> 'room_id')::uuid,
          coalesce((select array_agg(jm.membership_id) from pm.job_members jm where jm.org_id = j.org_id and jm.job_id = p_job), '{}'),
          format('Over budget: %s', x ->> 'room'), 'The items specified for this room total more than its budget.', '/design/' || p_job::text,
          'dsn.over:' || (x ->> 'room_id'), 'projects.contract_value', format('Over budget: %s', x ->> 'room'),
          format('Specified %s against a %s budget.', core.notify_money_text((x ->> 'specified_cents')::bigint), core.notify_money_text((x ->> 'budget_cents')::bigint)));
        update pm.dsn_rooms set over_notified_at = now() where id = (x ->> 'room_id')::uuid;
      end if;
    else
      update pm.dsn_rooms set over_notified_at = null where id = (x ->> 'room_id')::uuid and over_notified_at is not null;
    end if;
  end loop;
  v_money := pm._x_sees('projects.contract_value', 'view', j.location_id, p_job);
  return jsonb_build_object('rooms', (select coalesce(jsonb_agg(pm._wc_strip(e, v_money)), '[]') from jsonb_array_elements(v) e));
end $$;

-- I5. Product library, vendor terms, clipper (ID-07/08) ------------------------------------------
create table if not exists pm.dsn_products (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  vendor_id        uuid references core.vendors(id),
  vendor_name      text,
  sku              text check (sku is null or char_length(sku) <= 80),
  category         text check (category is null or char_length(category) <= 80),
  width_in         numeric(8,2),
  depth_in         numeric(8,2),
  height_in        numeric(8,2),
  finish           text check (finish is null or char_length(finish) <= 200),
  com_yards        numeric(8,2) check (com_yards is null or com_yards >= 0),
  lead_time_days   int check (lead_time_days is null or lead_time_days between 0 and 730),
  trade_cost_cents bigint check (trade_cost_cents is null or trade_cost_cents >= 0),
  retail_cents     bigint check (retail_cents is null or retail_cents >= 0),
  image_url        text check (image_url is null or image_url ~ '^https://'),
  vendor_url       text check (vendor_url is null or vendor_url ~ '^https://'),
  source           text not null default 'MANUAL' check (source in ('MANUAL','CLIPPER','QR','IMPORT')),
  notes            text check (notes is null or char_length(notes) <= 2000),
  is_active        boolean not null default true,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists pm_dsn_products_idx on pm.dsn_products (org_id, location_id, lower(name));

create table if not exists pm.dsn_vendor_terms (
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  vendor_id                uuid not null references core.vendors(id) on delete cascade,
  trade_discount_pct       numeric(5,4) check (trade_discount_pct is null or (trade_discount_pct >= 0 and trade_discount_pct < 1)),
  deposit_pct              numeric(5,4) check (deposit_pct is null or (deposit_pct >= 0 and deposit_pct <= 1)),
  freight_terms            text check (freight_terms is null or char_length(freight_terms) <= 200),
  resale_cert_on_file      boolean not null default false,
  resale_cert_expires_on   date,
  rep_name                 text,
  rep_email                text,
  avg_lead_days            int check (avg_lead_days is null or avg_lead_days between 0 and 730),
  cancellation_policy      text check (cancellation_policy is null or char_length(cancellation_policy) <= 2000),
  restocking_fee_pct       numeric(5,4) check (restocking_fee_pct is null or (restocking_fee_pct >= 0 and restocking_fee_pct <= 1)),
  updated_at               timestamptz not null default now(),
  primary key (org_id, location_id, vendor_id)
);

-- The web / mobile clipper (or a showroom QR code) posts what it read off the page.
create or replace function pm.dsn_clip(p_location uuid, p_clip jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); c jsonb := coalesce(p_clip, '{}'); v uuid; v_vendor uuid; v_dup uuid;
begin
  if nullif(btrim(coalesce(c ->> 'name', '')), '') is null then raise exception 'PM_INVALID: the clip has no product name' using errcode = '22023'; end if;
  v_vendor := (select x.id from core.vendors x where x.org_id = v_org and (x.id = pm.access_try_uuid(c ->> 'vendor_id') or lower(x.name) = lower(btrim(coalesce(c ->> 'vendor_name', ''))))
                order by (x.id = pm.access_try_uuid(c ->> 'vendor_id')) desc limit 1);
  select p.id into v_dup from pm.dsn_products p where p.org_id = v_org and p.location_id = p_location and p.is_active
     and ((nullif(c ->> 'sku', '') is not null and p.sku = c ->> 'sku' and p.vendor_id is not distinct from v_vendor) or (nullif(c ->> 'vendor_url', '') is not null and p.vendor_url = c ->> 'vendor_url'));
  if v_dup is not null then return jsonb_build_object('product_id', v_dup, 'duplicate', true); end if;
  insert into pm.dsn_products (org_id, location_id, name, vendor_id, vendor_name, sku, category, width_in, depth_in, height_in, finish, com_yards, lead_time_days,
                               trade_cost_cents, retail_cents, image_url, vendor_url, source, notes)
  values (v_org, p_location, left(btrim(c ->> 'name'), 200), v_vendor, left(c ->> 'vendor_name', 200), left(c ->> 'sku', 80), left(c ->> 'category', 80),
          pm._x_try_num(c ->> 'width_in'), pm._x_try_num(c ->> 'depth_in'), pm._x_try_num(c ->> 'height_in'), left(c ->> 'finish', 200), pm._x_try_num(c ->> 'com_yards'),
          pm._x_try_num(c ->> 'lead_time_days')::int, pm._x_try_bigint(c ->> 'trade_cost_cents'), pm._x_try_bigint(c ->> 'retail_cents'),
          case when c ->> 'image_url' ~ '^https://' then left(c ->> 'image_url', 1000) end, case when c ->> 'vendor_url' ~ '^https://' then left(c ->> 'vendor_url', 1000) end,
          case when c ->> 'source' in ('CLIPPER','QR') then c ->> 'source' else 'CLIPPER' end, left(c ->> 'notes', 2000))
  returning id into v;
  return jsonb_build_object('product_id', v, 'duplicate', false, 'vendor_matched', v_vendor is not null);
end $$;

-- I6. Pricing rules (ID-14) -----------------------------------------------------------------------
create table if not exists pm.dsn_pricing_rules (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  name                 text not null check (char_length(btrim(name)) between 1 and 120),
  vendor_id            uuid references core.vendors(id) on delete cascade,
  category             text,
  customer_id          uuid references core.customers(id) on delete cascade,
  method               text not null check (method in ('COST_PLUS','DISCOUNT_FROM_RETAIL','TIERED')),
  pct                  numeric(7,4) check (pct is null or (pct >= 0 and pct <= 10)),
  tiers                jsonb not null default '[]' check (jsonb_typeof(tiers) = 'array'),   -- [{up_to_cents, pct}] on unit cost, last tier open
  freight_pct          numeric(5,4) check (freight_pct is null or (freight_pct >= 0 and freight_pct <= 1)),
  procurement_fee_pct  numeric(5,4) check (procurement_fee_pct is null or (procurement_fee_pct >= 0 and procurement_fee_pct <= 1)),
  show_cost            boolean not null default false,
  priority             int not null default 100,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (org_id, id)
);

-- Price one unit: the most specific active rule (client > vendor > category > company default;
-- ties by priority), else the firm's default markup. Mirrored by lib/design/pricing.ts.
--   COST_PLUS: cost × (1 + pct)   DISCOUNT_FROM_RETAIL: retail × (1 − pct)   TIERED: cost × (1 + tier pct)
create or replace function pm.dsn_price(p_location uuid, p_cost_cents bigint, p_retail_cents bigint, p_vendor uuid default null, p_category text default null,
                                        p_customer uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); r pm.dsn_pricing_rules%rowtype; v_unit bigint; v_pct numeric; s pm.dsn_settings%rowtype; t jsonb;
begin
  select * into r from pm.dsn_pricing_rules x
   where x.org_id = v_org and x.location_id = p_location and x.is_active
     and (x.customer_id is null or x.customer_id = p_customer) and (x.vendor_id is null or x.vendor_id = p_vendor)
     and (x.category is null or lower(x.category) = lower(coalesce(p_category, '')))
   order by (x.customer_id is not null) desc, (x.vendor_id is not null) desc, (x.category is not null) desc, x.priority, x.created_at limit 1;
  select * into s from pm.dsn_settings x where x.org_id = v_org and x.location_id = p_location;
  if r.id is null then
    v_unit := pm.res_round(coalesce(p_cost_cents, 0) * (1 + coalesce(s.default_markup_pct, 0.35)));
  elsif r.method = 'COST_PLUS' then
    v_unit := pm.res_round(coalesce(p_cost_cents, 0) * (1 + coalesce(r.pct, 0)));
  elsif r.method = 'DISCOUNT_FROM_RETAIL' then
    if p_retail_cents is null then raise exception 'PM_INVALID: this rule prices from retail; the item has no retail price' using errcode = '22023'; end if;
    v_unit := pm.res_round(p_retail_cents * (1 - coalesce(r.pct, 0)));
  else
    v_pct := null;
    for t in select x from jsonb_array_elements(r.tiers) x order by coalesce(pm._x_try_bigint(x ->> 'up_to_cents'), 9223372036854775807) loop
      if pm._x_try_bigint(t ->> 'up_to_cents') is null or coalesce(p_cost_cents, 0) <= pm._x_try_bigint(t ->> 'up_to_cents') then v_pct := pm._x_try_num(t ->> 'pct'); exit; end if;
    end loop;
    v_unit := pm.res_round(coalesce(p_cost_cents, 0) * (1 + coalesce(v_pct, r.pct, 0)));
  end if;
  return jsonb_build_object('client_unit_price_cents', v_unit, 'rule_id', r.id, 'rule', coalesce(r.name, 'Firm default markup'),
    'freight_cents', case when r.freight_pct is not null then pm.res_round(coalesce(p_cost_cents, 0) * r.freight_pct) end,
    'procurement_fee_cents', case when r.procurement_fee_pct is not null then pm.res_round(v_unit * r.procurement_fee_pct) end,
    'show_cost', coalesce(r.show_cost, s.show_cost_default, false));
end $$;

-- Add a library product to a room (or replace a placeholder: quantity and budget carry over).
create or replace function pm.dsn_add_product_item(p_job uuid, p_product uuid, p_room text, p_qty numeric default 1, p_replace_item uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; p pm.dsn_products%rowtype; pr jsonb; v uuid; v_cust uuid; old pm.dsn_items%rowtype;
begin
  select * into j from pm._x_job(p_job);
  select * into p from pm.dsn_products x where x.id = p_product and x.org_id = j.org_id and x.location_id = j.location_id;
  if p.id is null then raise exception 'PM_INVALID: product is not in this firm''s library' using errcode = '22023'; end if;
  select customer_id into v_cust from core.jobs where id = p_job;
  perform pm._wc_require_location('projects.selections', 'view', j.location_id);
  pr := pm.dsn_price(j.location_id, p.trade_cost_cents, p.retail_cents, p.vendor_id, p.category, v_cust);
  if p_replace_item is not null then
    select * into old from pm.dsn_items x where x.id = p_replace_item and x.org_id = j.org_id and x.job_id = p_job for update;
    if old.id is null or not old.is_placeholder then raise exception 'PM_INVALID: only a placeholder can be replaced' using errcode = '22023'; end if;
    update pm.dsn_items set name = p.name, category = coalesce(p.category, category), description = concat_ws(' · ', p.vendor_name, p.sku, p.finish,
             case when p.width_in is not null then format('%s"W × %s"D × %s"H', p.width_in, p.depth_in, p.height_in) end),
           image_url = coalesce(p.image_url, image_url), vendor_url = coalesce(p.vendor_url, vendor_url), is_placeholder = false, status = 'SPECIFIED',
           client_unit_price_cents = (pr ->> 'client_unit_price_cents')::bigint, show_cost_to_client = coalesce((pr ->> 'show_cost')::boolean, false), updated_at = now()
     where id = old.id;
    return old.id;
  end if;
  insert into pm.dsn_items (org_id, job_id, room, name, category, description, image_url, vendor_url, qty, client_unit_price_cents, show_cost_to_client, status)
  values (j.org_id, p_job, left(btrim(coalesce(p_room, 'General')), 120), p.name, p.category,
          concat_ws(' · ', p.vendor_name, p.sku, p.finish, case when p.width_in is not null then format('%s"W × %s"D × %s"H', p.width_in, p.depth_in, p.height_in) end),
          p.image_url, p.vendor_url, greatest(coalesce(p_qty, 1), 0.0001), (pr ->> 'client_unit_price_cents')::bigint, coalesce((pr ->> 'show_cost')::boolean, false), 'SPECIFIED')
  returning id into v;
  return v;
end $$;

-- I7. Mood boards & presentations (ID-11) ----------------------------------------------------------
create table if not exists pm.dsn_boards (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  room          text,
  title         text not null check (char_length(btrim(title)) between 1 and 200),
  status        text not null default 'DRAFT' check (status in ('DRAFT','PRESENTED','ARCHIVED')),
  presented_at  timestamptz,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dsn_board_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  board_id      uuid not null,
  kind          text not null check (kind in ('ITEM','SWATCH','RENDERING','IMAGE','NOTE')),
  dsn_item_id   uuid,
  document_id   uuid references public.documents(id) on delete set null,
  image_url     text check (image_url is null or image_url ~ '^https://'),
  caption       text check (caption is null or char_length(caption) <= 500),
  x             numeric(6,2) not null default 0,
  y             numeric(6,2) not null default 0,
  w             numeric(6,2) not null default 25,
  h             numeric(6,2) not null default 25,
  sort          int not null default 0,
  unique (org_id, id),
  foreign key (org_id, board_id) references pm.dsn_boards (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dsn_save_board(p_job uuid, p_title text, p_room text default null, p_items jsonb default '[]', p_board uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v uuid; it jsonb; n int := 0;
begin
  select * into j from pm._x_job(p_job);
  if p_board is null then
    insert into pm.dsn_boards (org_id, job_id, room, title) values (j.org_id, p_job, left(p_room, 120), left(btrim(p_title), 200)) returning id into v;
  else
    update pm.dsn_boards set title = coalesce(nullif(left(btrim(p_title), 200), ''), title), room = coalesce(left(p_room, 120), room), updated_at = now()
     where id = p_board and org_id = j.org_id and job_id = p_job and status <> 'ARCHIVED' returning id into v;
    if v is null then raise exception 'PM_FORBIDDEN: board not found' using errcode = '42501'; end if;
    delete from pm.dsn_board_items where org_id = j.org_id and board_id = v;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then raise exception 'PM_INVALID: up to 200 things on a board' using errcode = '22023'; end if;
  for it in select x from jsonb_array_elements(p_items) x loop
    n := n + 1;
    insert into pm.dsn_board_items (org_id, board_id, kind, dsn_item_id, document_id, image_url, caption, x, y, w, h, sort)
    values (j.org_id, v, coalesce(it ->> 'kind', 'IMAGE'),
            (select i.id from pm.dsn_items i where i.id = pm.access_try_uuid(it ->> 'dsn_item_id') and i.org_id = j.org_id and i.job_id = p_job),
            (select d.id from public.documents d where d.id = pm.access_try_uuid(it ->> 'document_id') and d.org_id = j.org_id),
            case when it ->> 'image_url' ~ '^https://' then left(it ->> 'image_url', 1000) end, left(it ->> 'caption', 500),
            least(greatest(coalesce(pm._x_try_num(it ->> 'x'), 0), 0), 100), least(greatest(coalesce(pm._x_try_num(it ->> 'y'), 0), 0), 100),
            least(greatest(coalesce(pm._x_try_num(it ->> 'w'), 25), 1), 100), least(greatest(coalesce(pm._x_try_num(it ->> 'h'), 25), 1), 100), n);
  end loop;
  return v;
end $$;

-- Present: the board's items become client-visible; the client hears it in the portal thread.
create or replace function pm.dsn_present_board(p_board uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.dsn_boards%rowtype; v_cust uuid; v_msg jsonb;
begin
  select * into b from pm.dsn_boards x where x.id = p_board and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: board not found' using errcode = '42501'; end if;
  update pm.dsn_items set client_visible = true where org_id = b.org_id and id in (select bi.dsn_item_id from pm.dsn_board_items bi where bi.board_id = b.id and bi.dsn_item_id is not null);
  update pm.dsn_boards set status = 'PRESENTED', presented_at = now(), updated_at = now() where id = b.id;
  select customer_id into v_cust from core.jobs where id = b.job_id;
  if v_cust is not null and pm.access_can_job('projects.jobs', 'edit', b.job_id) then   -- the portal post needs jobs:edit (its guard is skipped when nested)
    begin
      v_msg := pm.portal_post_message(b.job_id, 'customer', v_cust, format('A new design board is ready for you: %s. Open your portal to see it and tell us what you think.', b.title), null);
    exception when others then v_msg := null;
    end;
  end if;
  return jsonb_build_object('board_id', b.id, 'status', 'PRESENTED', 'notified', v_msg -> 'notified');
end $$;

-- I8. FF&E schedule & spec book (ID-13): one row per item with doc codes and the eight dates;
-- financial columns only for contract-value holders (the route hides them per export).
create or replace function pm.dsn_ffe_schedule(p_job uuid, p_room text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_sell boolean; v_cost boolean; v jsonb;
begin
  select * into j from pm._x_job(p_job);
  v_sell := pm._x_sees('projects.contract_value', 'view', j.location_id, p_job);
  v_cost := pm._x_sees('projects.financials', 'view', j.location_id, p_job);
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'doc_code', i.doc_code, 'room', i.room, 'name', i.name, 'category', i.category, 'description', i.description,
           'qty', i.qty, 'status', i.status, 'image_url', i.image_url, 'vendor_url', i.vendor_url, 'placeholder', i.is_placeholder,
           'client_unit_price_cents', case when v_sell then i.client_unit_price_cents end, 'client_total_cents', case when v_sell then i.client_total_cents end,
           'net_cost_cents', case when v_cost then (select sum(pi.cost_total_cents) from pm.procurement_items pi where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status <> 'CANCELLED') end,
           'components', coalesce((select jsonb_agg(jsonb_build_object('id', pi.id, 'kind', pi.component_kind, 'vendor', vd.name, 'sku', pi.vendor_sku, 'po_number', pi.po_number, 'status', pi.status,
                                       'ordered_on', pi.ordered_on, 'shipped_on', pi.shipped_on, 'expected_on', pi.expected_on, 'install_on', pi.install_on) order by pi.created_at)
                                     from pm.procurement_items pi left join core.vendors vd on vd.id = pi.vendor_id where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status <> 'CANCELLED'), '[]'),
           'tear_sheet_ref', 'item:' || i.id::text)
           order by i.room, coalesce(i.doc_code, ''), i.sort), '[]') into v
    from pm.dsn_items i where i.org_id = j.org_id and i.job_id = p_job and (p_room is null or lower(i.room) = lower(p_room)) and i.status <> 'CANCELLED';
  return jsonb_build_object('items', v, 'financial_columns', v_sell or v_cost);
end $$;

-- I9. Changes, cancellations, returns (ID-24) -----------------------------------------------------
create table if not exists pm.dsn_item_changes (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  item_id             uuid not null,
  kind                text not null check (kind in ('CANCEL','RETURN','CHANGE')),
  reason              text not null check (char_length(btrim(reason)) between 1 and 1000),
  components_affected int not null default 0,
  restocking_fee_cents bigint not null default 0 check (restocking_fee_cents >= 0),
  deposit_moved_cents bigint not null default 0,
  to_item_id          uuid,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Cancel / return an item: components not yet ordered are cancelled; ordered ones follow the
-- vendor's restocking rule (fee on the net cost); the item's deposit moves to another item or is
-- held as credit through pm.dsn_reallocate_deposit (1122).
create or replace function pm.dsn_change_item(p_item uuid, p_kind text, p_reason text, p_to_item uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.dsn_items%rowtype; c record; n int := 0; v_fee bigint := 0; v_loc uuid; v_dep bigint; v uuid; v_moved bigint := 0; v_terms record;
begin
  select * into i from pm.dsn_items x where x.id = p_item and x.org_id = public.get_org_id() for update;
  if i.id is null then raise exception 'PM_FORBIDDEN: item not found' using errcode = '42501'; end if;
  if p_kind not in ('CANCEL','RETURN','CHANGE') then raise exception 'PM_INVALID: cancel, return or change' using errcode = '22023'; end if;
  if i.status = 'CANCELLED' then raise exception 'PM_INVALID: already cancelled' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: give the reason' using errcode = '22023'; end if;
  select location_id into v_loc from core.jobs where id = i.job_id;
  if p_kind in ('CANCEL','RETURN') then
    for c in select pi.* from pm.procurement_items pi where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status not in ('CANCELLED','RETURNED') for update loop
      if c.status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED','RECEIVED','STORED','DELIVERED','DAMAGED') then
        select t.restocking_fee_pct into v_terms from pm.dsn_vendor_terms t where t.org_id = i.org_id and t.location_id = v_loc and t.vendor_id = c.vendor_id;
        v_fee := v_fee + pm.res_round(c.cost_total_cents * coalesce(v_terms.restocking_fee_pct, 0.25));
        update pm.procurement_items set status = 'RETURNED', cancelled_at = now(), notes = concat_ws(' · ', notes, 'Returned: ' || btrim(p_reason)), updated_at = now() where id = c.id;
      else
        update pm.procurement_items set status = 'CANCELLED', cancelled_at = now(), updated_at = now() where id = c.id;
      end if;
      n := n + 1;
    end loop;
    update pm.dsn_items set status = 'CANCELLED', internal_notes = concat_ws(E'\n', internal_notes, initcap(lower(p_kind)) || ': ' || btrim(p_reason)), updated_at = now() where id = i.id;
    select coalesce(sum(d.allocated_cents), 0)::bigint into v_dep from pm.dsn_item_deposits d where d.org_id = i.org_id and d.item_id = i.id;
    if v_dep > 0 then
      perform pm._wc_require_row('projects.billing', 'edit', 'dsn_items', i.id);
      perform pm.dsn_reallocate_deposit(i.id, p_to_item, v_dep, left(initcap(lower(p_kind)) || ': ' || btrim(p_reason), 500));
      v_moved := v_dep;
    end if;
  end if;
  insert into pm.dsn_item_changes (org_id, job_id, item_id, kind, reason, components_affected, restocking_fee_cents, deposit_moved_cents, to_item_id)
  values (i.org_id, i.job_id, i.id, p_kind, left(btrim(p_reason), 1000), n, v_fee, v_moved, p_to_item) returning id into v;
  return jsonb_build_object('change_id', v, 'components', n, 'restocking_fee_cents', v_fee, 'deposit_moved_cents', v_moved);
end $$;

-- I10. Freight claims from receiving (ID-25) -----------------------------------------------------
create table if not exists pm.dsn_freight_claims (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  procurement_item_id uuid not null,
  carrier             text check (carrier is null or char_length(carrier) <= 120),
  tracking_ref        text check (tracking_ref is null or char_length(tracking_ref) <= 120),
  damage              text not null check (char_length(btrim(damage)) between 1 and 2000),
  photo_document_ids  uuid[] not null default '{}',
  claim_cents         bigint check (claim_cents is null or claim_cents >= 0),
  status              text not null default 'OPEN' check (status in ('OPEN','FILED','PAID','DENIED','WITHDRAWN')),
  filed_on            date,
  settled_cents       bigint,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dsn_open_freight_claim(p_component uuid, p_damage text, p_carrier text default null, p_tracking text default null, p_photos uuid[] default '{}',
                                                     p_claim_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.procurement_items%rowtype; v uuid;
begin
  select * into c from pm.procurement_items x where x.id = p_component and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: component not found' using errcode = '42501'; end if;
  insert into pm.dsn_freight_claims (org_id, job_id, procurement_item_id, carrier, tracking_ref, damage, photo_document_ids, claim_cents)
  values (c.org_id, c.job_id, c.id, left(p_carrier, 120), left(coalesce(p_tracking, c.tracking_ref), 120), left(btrim(p_damage), 2000),
          coalesce(nullif(p_photos, '{}'), c.receive_photo_ids, '{}'), coalesce(p_claim_cents, c.cost_total_cents))
  returning id into v;
  update pm.procurement_items set freight_claim_open = true, updated_at = now() where id = c.id;
  return v;
end $$;

create or replace function pm.dsn_update_freight_claim(p_claim uuid, p_status text, p_settled_cents bigint default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare fc pm.dsn_freight_claims%rowtype;
begin
  select * into fc from pm.dsn_freight_claims x where x.id = p_claim and x.org_id = public.get_org_id() for update;
  if fc.id is null then raise exception 'PM_FORBIDDEN: claim not found' using errcode = '42501'; end if;
  if p_status not in ('FILED','PAID','DENIED','WITHDRAWN') then raise exception 'PM_INVALID: status' using errcode = '22023'; end if;
  update pm.dsn_freight_claims set status = p_status, filed_on = case when p_status = 'FILED' then current_date else filed_on end,
         settled_cents = case when p_status = 'PAID' then coalesce(p_settled_cents, claim_cents) else settled_cents end, updated_at = now() where id = fc.id;
  if p_status in ('PAID','DENIED','WITHDRAWN') then update pm.procurement_items set freight_claim_open = false where id = fc.procurement_item_id; end if;
  return fc.id;
end $$;

-- I11. Install day (ID-28) -----------------------------------------------------------------------
create table if not exists pm.dsn_install_checklists (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  install_on          date not null,
  room                text,
  crew                text check (crew is null or char_length(crew) <= 200),
  items               jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),    -- [{key, label, done}]
  delivery_document_ids uuid[] not null default '{}',
  styling_photo_ids   uuid[] not null default '{}',
  punch_created       int not null default 0,
  status              text not null default 'PLANNED' check (status in ('PLANNED','DONE')),
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- The install sheet: every item for the room / project with where it is now, and the checklist.
create or replace function pm.dsn_install_day(p_job uuid, p_on date, p_room text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_cl uuid;
begin
  select * into j from pm._x_job(p_job);
  select id into v_cl from pm.dsn_install_checklists where org_id = j.org_id and job_id = p_job and install_on = p_on and room is not distinct from p_room;
  if v_cl is null then
    insert into pm.dsn_install_checklists (org_id, job_id, install_on, room, items)
    values (j.org_id, p_job, p_on, p_room, '[{"key":"walk","label":"Walk the rooms with the client before unloading","done":false},
      {"key":"protect","label":"Floors and door frames protected","done":false},{"key":"unpack","label":"Every item unpacked and inspected; debris removed","done":false},
      {"key":"place","label":"Furniture placed per the plan","done":false},{"key":"hang","label":"Art, mirrors and drapery hung","done":false},
      {"key":"style","label":"Styling done and photographed","done":false},{"key":"punch","label":"Punch list written with the client","done":false}]'::jsonb)
    returning id into v_cl;
  end if;
  return jsonb_build_object('checklist', (select to_jsonb(c) - 'org_id' from pm.dsn_install_checklists c where c.id = v_cl),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'room', i.room, 'doc_code', i.doc_code, 'name', i.name, 'qty', i.qty, 'status', i.status,
               'components', (select jsonb_agg(jsonb_build_object('id', pi.id, 'kind', pi.component_kind, 'status', pi.status, 'storage_location_id', pi.storage_location_id,
                                              'received_condition', pi.received_condition, 'freight_claim_open', pi.freight_claim_open)) from pm.procurement_items pi
                               where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status <> 'CANCELLED'),
               'ready', not exists (select 1 from pm.procurement_items pi where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status not in ('RECEIVED','STORED','DELIVERED','INSTALLED','CANCELLED')))
             order by i.room, i.sort) from pm.dsn_items i
            where i.org_id = j.org_id and i.job_id = p_job and i.status in ('APPROVED','ORDERED','RECEIVED','DELIVERED','INSTALLED') and (p_room is null or lower(i.room) = lower(p_room))), '[]'));
end $$;

create or replace function pm.dsn_complete_install(p_checklist uuid, p_done_keys text[], p_styling_photos uuid[] default '{}', p_punch jsonb default '[]', p_installed_items uuid[] default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.dsn_install_checklists%rowtype; p jsonb; n int := 0;
begin
  select * into c from pm.dsn_install_checklists x where x.id = p_checklist and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: checklist not found' using errcode = '42501'; end if;
  for p in select x from jsonb_array_elements(coalesce(p_punch, '[]')) x loop
    continue when nullif(btrim(coalesce(p ->> 'title', '')), '') is null;
    insert into pm.punch_items (org_id, job_id, kind, title, description) values (c.org_id, c.job_id, 'PUNCH', left(btrim(p ->> 'title'), 200), left(p ->> 'description', 2000));
    n := n + 1;
  end loop;
  update pm.dsn_items set status = 'INSTALLED', updated_at = now() where org_id = c.org_id and job_id = c.job_id and id = any (coalesce(p_installed_items, '{}'));
  update pm.procurement_items set status = 'INSTALLED', installed_on = c.install_on, updated_at = now()
   where org_id = c.org_id and job_id = c.job_id and dsn_item_id = any (coalesce(p_installed_items, '{}')) and status in ('RECEIVED','STORED','DELIVERED');
  update pm.dsn_install_checklists set items = (select coalesce(jsonb_agg(x || jsonb_build_object('done', (x ->> 'key') = any (coalesce(p_done_keys, '{}')))), '[]') from jsonb_array_elements(items) x),
         styling_photo_ids = array(select x from unnest(coalesce(p_styling_photos, '{}')) x
                                    where exists (select 1 from public.documents d where d.id = x and d.org_id = c.org_id
                                                    and (d.uploaded_by_user = pm.current_user_id()
                                                         or exists (select 1 from pm.document_links dl where dl.org_id = c.org_id and dl.document_id = d.id and dl.job_id = c.job_id)))),
         punch_created = punch_created + n, status = 'DONE', completed_at = now()
   where id = c.id;
  return jsonb_build_object('checklist_id', c.id, 'punch_created', n, 'installed', coalesce(cardinality(p_installed_items), 0));
end $$;

-- I12. Product invoicing (ID-33): deposit / progress / final-on-delivery invoices by item; tax per
-- line by class and ship-to jurisdiction goes to Books with the request (frozen JOB_BILLING carries
-- no tax — seam ask); statements show deposits held, applied and remaining.
create or replace function pm.dsn_draft_product_invoice(p_job uuid, p_kind text, p_item_ids uuid[], p_tax_rate numeric default 0, p_ship_to_state text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_contract uuid; v_br uuid := gen_random_uuid(); i record; n int := 0; v_amt bigint; v_total bigint := 0; v_tax bigint := 0; v_lines jsonb := '[]';
begin
  select * into j from pm._x_job(p_job);
  if p_kind not in ('DEPOSIT','PROGRESS','FINAL') then raise exception 'PM_INVALID: deposit, progress or final' using errcode = '22023'; end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then raise exception 'PM_INVALID: pick the items to invoice' using errcode = '22023'; end if;
  v_contract := pm.primary_contract_id(j.org_id, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the design project has no active contract' using errcode = 'P0001'; end if;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_br, j.org_id, p_job, v_contract, 'MILESTONE', 'DRAFT', 'milestone', current_date, initcap(lower(p_kind)) || ' invoice — furnishings', pm.current_user_id());
  for i in select x.* from pm.dsn_items x where x.org_id = j.org_id and x.job_id = p_job and x.id = any (p_item_ids) and x.status in ('APPROVED','ORDERED','RECEIVED','DELIVERED','INSTALLED') order by x.room, x.sort loop
    v_amt := case p_kind when 'DEPOSIT' then pm.res_round(i.client_total_cents * i.deposit_pct)
                         when 'FINAL' then i.client_total_cents - coalesce((select sum(d.allocated_cents) from pm.dsn_item_deposits d where d.org_id = i.org_id and d.item_id = i.id), 0)
                         else i.client_total_cents end;
    continue when coalesce(v_amt, 0) <= 0;
    n := n + 1;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents, retainage_rate)
    values (j.org_id, v_br, n, n, 'STANDARD', left(concat_ws(' · ', i.doc_code, i.room, i.name, case when p_kind = 'DEPOSIT' then round(i.deposit_pct * 100) || '% deposit' end), 300), v_amt, v_amt, 0);
    v_total := v_total + v_amt;
    v_tax := v_tax + pm.res_round(v_amt * coalesce(p_tax_rate, 0));
    v_lines := v_lines || jsonb_build_object('item_id', i.id, 'amount_cents', v_amt, 'tax_class', 'PRODUCT', 'tax_cents', pm.res_round(v_amt * coalesce(p_tax_rate, 0)));
  end loop;
  if n = 0 then raise exception 'PM_INVALID: nothing to invoice on those items' using errcode = '22023'; end if;
  perform pm._wc_require_row('projects.billing', 'edit', 'billing_requests', v_br);
  perform pm.finalize_billing_retainage(v_br);
  perform pm._wc_books_request(j.org_id, j.location_id, p_job, 'PRODUCT_INVOICE', 'billing_requests', v_br,
    jsonb_build_object('billing_request_id', v_br, 'kind', p_kind, 'tax_rate', coalesce(p_tax_rate, 0), 'ship_to_state', p_ship_to_state, 'lines', v_lines, 'tax_cents', v_tax));
  return jsonb_build_object('billing_request_id', v_br, 'lines', n, 'amount_cents', v_total, 'tax_cents', v_tax);
end $$;

create or replace function pm.dsn_deposit_statement(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v jsonb; v_sell boolean;
begin
  select * into j from pm._x_job(p_job);
  v_sell := pm._x_sees('projects.contract_value', 'view', j.location_id, p_job);
  if not v_sell then raise exception 'PM_FORBIDDEN: requires projects.contract_value:view' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.id, 'item', x.name, 'room', x.room, 'status', x.status, 'client_total_cents', x.client_total_cents,
           'deposit_required_cents', x.req, 'deposit_held_cents', x.held,
           'applied_cents', case when x.status in ('DELIVERED','INSTALLED') then x.held else 0 end,
           'remaining_cents', x.client_total_cents - x.held) order by x.room, x.name), '[]') into v
    from (select i.id, i.name, i.room, i.status, i.client_total_cents,
                 coalesce((select sum(d.required_cents) from pm.dsn_item_deposits d where d.org_id = i.org_id and d.item_id = i.id), 0)::bigint as req,
                 coalesce((select sum(d.allocated_cents) from pm.dsn_item_deposits d where d.org_id = i.org_id and d.item_id = i.id), 0)::bigint as held
            from pm.dsn_items i
           where i.org_id = j.org_id and i.job_id = p_job and i.status not in ('SPECIFIED','PLACEHOLDER','PROPOSED','REJECTED')) x;
  return jsonb_build_object('items', v, 'held_cents', (select coalesce(sum((x ->> 'deposit_held_cents')::bigint), 0) from jsonb_array_elements(v) x),
    'applied_cents', (select coalesce(sum((x ->> 'applied_cents')::bigint), 0) from jsonb_array_elements(v) x),
    'remaining_cents', (select coalesce(sum((x ->> 'remaining_cents')::bigint), 0) from jsonb_array_elements(v) x));
end $$;

-- I13. Reimbursables (ID-34) ---------------------------------------------------------------------
create table if not exists pm.dsn_reimbursables (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  kind                text not null check (kind in ('SAMPLES','TRAVEL','PRINTING','FREIGHT','STORAGE','OTHER')),
  description         text not null check (char_length(btrim(description)) between 1 and 300),
  incurred_on         date not null default current_date,
  cost_cents          bigint not null check (cost_cents > 0),
  markup_pct          numeric(6,4) not null default 0 check (markup_pct >= 0 and markup_pct <= 5),
  billable            boolean not null default true,
  receipt_document_id uuid references public.documents(id) on delete set null,
  receipt_capture_id  uuid,
  books_txn_ref       text,
  status              text not null default 'OPEN' check (status in ('OPEN','BILLED','WRITTEN_OFF')),
  billing_request_id  uuid,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.dsn_add_reimbursable(p_job uuid, p_fields jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; f jsonb := coalesce(p_fields, '{}'); v uuid; v_mk numeric;
begin
  select * into j from pm._x_job(p_job);
  select fa.reimbursable_markup_pct into v_mk from pm.dsn_fee_agreements fa where fa.org_id = j.org_id and fa.job_id = p_job;
  insert into pm.dsn_reimbursables (org_id, job_id, kind, description, incurred_on, cost_cents, markup_pct, billable, receipt_document_id, books_txn_ref)
  values (j.org_id, p_job, coalesce(f ->> 'kind', 'OTHER'), left(btrim(coalesce(f ->> 'description', '')), 300), coalesce(pm._x_try_date(f ->> 'incurred_on'), current_date),
          pm._x_try_bigint(f ->> 'cost_cents'), coalesce(pm._x_try_num(f ->> 'markup_pct'), v_mk, 0), coalesce(pm._x_try_bool(f ->> 'billable'), true),
          (select d.id from public.documents d where d.id = pm.access_try_uuid(f ->> 'receipt_document_id') and d.org_id = j.org_id), left(f ->> 'books_txn_ref', 120))
  returning id into v;
  return v;
end $$;

create or replace function pm.dsn_bill_reimbursables(p_job uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_contract uuid; v_br uuid := gen_random_uuid(); r record; n int := 0; v_amt bigint; v_total bigint := 0;
begin
  select * into j from pm._x_job(p_job);
  if not exists (select 1 from pm.dsn_reimbursables x where x.org_id = j.org_id and x.job_id = p_job and x.status = 'OPEN' and x.billable) then
    raise exception 'PM_INVALID: no open billable reimbursables' using errcode = '22023';
  end if;
  v_contract := pm.primary_contract_id(j.org_id, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the design project has no active contract' using errcode = 'P0001'; end if;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_br, j.org_id, p_job, v_contract, 'TIME_MATERIALS', 'DRAFT', 'tm', current_date, 'Reimbursable expenses', pm.current_user_id());
  for r in select * from pm.dsn_reimbursables x where x.org_id = j.org_id and x.job_id = p_job and x.status = 'OPEN' and x.billable order by x.incurred_on for update loop
    n := n + 1;
    v_amt := pm.res_round(r.cost_cents * (1 + r.markup_pct));
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents, retainage_rate)
    values (j.org_id, v_br, n, n, 'STANDARD', left(format('%s: %s (%s)', initcap(lower(r.kind)), r.description, to_char(r.incurred_on, 'Mon DD')), 300), v_amt, v_amt, 0);
    update pm.dsn_reimbursables set status = 'BILLED', billing_request_id = v_br where id = r.id;
    v_total := v_total + v_amt;
  end loop;
  perform pm._wc_require_row('projects.billing', 'edit', 'billing_requests', v_br);
  perform pm.finalize_billing_retainage(v_br);
  return jsonb_build_object('billing_request_id', v_br, 'lines', n, 'amount_cents', v_total);
end $$;

-- I14. Design reports (ID-36) --------------------------------------------------------------------
create or replace function pm.dsn_reports(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); v_from date := coalesce(p_from, date_trunc('year', current_date)::date); v_to date := coalesce(p_to, current_date);
  v_cost boolean := pm._x_sees('projects.financials', 'view', p_location); v_sell boolean := pm._x_sees('projects.contract_value', 'view', p_location);
  v_target numeric; v_margin jsonb; v_fees jsonb; v_util jsonb; v_dep jsonb; v_status jsonb; v_unbilled jsonb;
begin
  select coalesce(s.default_markup_pct, 0.35) into v_target from pm.dsn_settings s where s.org_id = v_org and s.location_id = p_location;
  v_target := coalesce(v_target, 0.35);
  select jsonb_build_object('sell_cents', sum(i.client_total_cents), 'cost_cents', sum(c.cost),
           'realized_markup_pct', case when sum(c.cost) > 0 then round((sum(i.client_total_cents) - sum(c.cost))::numeric / sum(c.cost), 4) end, 'target_markup_pct', v_target) into v_margin
    from pm.dsn_items i join core.jobs j on j.id = i.job_id
    cross join lateral (select coalesce(sum(pi.cost_total_cents), 0) as cost from pm.procurement_items pi where pi.org_id = i.org_id and pi.dsn_item_id = i.id and pi.status not in ('CANCELLED')) c
   where i.org_id = v_org and j.location_id = p_location and i.status in ('ORDERED','RECEIVED','DELIVERED','INSTALLED') and i.updated_at::date between v_from and v_to;
  select jsonb_build_object('billed_cents', coalesce(sum(l.cents), 0), 'by_kind', coalesce(jsonb_object_agg(l.kind, l.cents) filter (where l.kind is not null), '{}')) into v_fees
    from (select fl.kind, sum(fl.cents)::bigint as cents from pm.dsn_fee_ledger fl join core.jobs j on j.id = fl.job_id
           where fl.org_id = v_org and j.location_id = p_location and fl.created_at::date between v_from and v_to group by fl.kind) l;
  select jsonb_build_object('hours', coalesce(sum(t.hours), 0), 'billed_hours', coalesce(sum(t.hours) filter (where exists (select 1 from pm.dsn_billed_time b where b.time_entry_id = t.id)), 0),
           'utilization', case when sum(t.hours) > 0 then round(coalesce(sum(t.hours) filter (where exists (select 1 from pm.dsn_billed_time b where b.time_entry_id = t.id)), 0) / sum(t.hours), 4) end) into v_util
    from pm.time_entries t join core.jobs j on j.id = t.job_id
   where t.org_id = v_org and j.location_id = p_location and t.work_date between v_from and v_to
     and exists (select 1 from pm.dsn_fee_agreements fa where fa.org_id = t.org_id and fa.job_id = t.job_id);
  select jsonb_build_object('client_deposits_held_cents', (select coalesce(sum(d.allocated_cents), 0) from pm.dsn_item_deposits d join core.jobs j on j.id = d.job_id
                                                             join pm.dsn_items i on i.id = d.item_id where d.org_id = v_org and j.location_id = p_location and i.status not in ('DELIVERED','INSTALLED','CANCELLED')),
           'vendor_deposits_open_cents', (select coalesce(sum(pm.res_round(pi.cost_total_cents * coalesce(pi.vendor_deposit_pct, 0))), 0) from pm.procurement_items pi join core.jobs j on j.id = pi.job_id
                                            where pi.org_id = v_org and j.location_id = p_location and pi.dsn_item_id is not null and pi.vendor_deposit_on is not null
                                              and pi.status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED'))) into v_dep;
  select coalesce(jsonb_object_agg(status, n), '{}') into v_status from (select i.status, count(*) as n from pm.dsn_items i join core.jobs j on j.id = i.job_id
                                                                        where i.org_id = v_org and j.location_id = p_location group by i.status) s;
  select jsonb_build_object('freight_cents', (select coalesce(sum(pi.freight_cents), 0) from pm.procurement_items pi join core.jobs j on j.id = pi.job_id
                                                 where pi.org_id = v_org and j.location_id = p_location and pi.dsn_item_id is not null and pi.status in ('RECEIVED','STORED','DELIVERED','INSTALLED')
                                                   and not exists (select 1 from pm.dsn_reimbursables r where r.org_id = pi.org_id and r.job_id = pi.job_id and r.kind = 'FREIGHT' and r.status = 'BILLED')),
           'open_reimbursables_cents', (select coalesce(sum(r.cost_cents), 0) from pm.dsn_reimbursables r join core.jobs j on j.id = r.job_id
                                         where r.org_id = v_org and j.location_id = p_location and r.status = 'OPEN' and r.billable),
           'storage_open_cents', (select coalesce(sum(r.cost_cents), 0) from pm.dsn_reimbursables r join core.jobs j on j.id = r.job_id
                                   where r.org_id = v_org and j.location_id = p_location and r.status = 'OPEN' and r.kind = 'STORAGE')) into v_unbilled;
  return jsonb_build_object('from', v_from, 'to', v_to,
    'product_margin', case when v_cost and v_sell then v_margin else jsonb_build_object('target_markup_pct', v_target) end,
    'fee_realization', case when v_sell then v_fees end, 'utilization', v_util,
    'deposits', case when v_sell and v_cost then v_dep end, 'items_by_status', v_status, 'unbilled', case when v_cost then v_unbilled end);
end $$;

-- ============================================================================
-- W4. Apply a setup-interview plan (RES-01 / FLR-01 / ID-01)
--   The plan is built by lib/{residential,flooring,design}/setup.ts from the answers (pure,
--   unit-tested) and shown to the person before it is applied. Here it is validated and written:
--   settings, cost codes (missing ones only), job types / templates, and the Books account map.
-- ============================================================================
create or replace function pm.wc_apply_setup(p_location uuid, p_industry text, p_answers jsonb, p_plan jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._wc_loc(p_location); s jsonb := coalesce(p_plan -> 'settings', '{}'); c jsonb; n_codes int := 0; n_tpl int := 0; v_run uuid; v_res jsonb;
begin
  if p_industry not in ('RESIDENTIAL','FLOORING','DESIGN') then raise exception 'PM_INVALID: industry %', p_industry using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_answers, 'null')) <> 'object' or jsonb_typeof(coalesce(p_plan, 'null')) <> 'object' then raise exception 'PM_INVALID: answers and plan are objects' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_plan -> 'cost_codes', '[]')) <> 'array' then raise exception 'PM_INVALID: cost_codes must be a list' using errcode = '22023'; end if;
  for c in select x from jsonb_array_elements(coalesce(p_plan -> 'cost_codes', '[]')) x loop
    if coalesce(c ->> 'code', '') !~ '^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$' or nullif(btrim(coalesce(c ->> 'name', '')), '') is null
       or coalesce(c ->> 'cost_type', '') not in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER') then
      raise exception 'PM_INVALID: cost code % is not valid', c ->> 'code' using errcode = '22023';
    end if;
    insert into pm.cost_codes (org_id, location_id, code, name, cost_type) values (v_org, p_location, c ->> 'code', left(btrim(c ->> 'name'), 120), c ->> 'cost_type')
    on conflict do nothing;
    if found then n_codes := n_codes + 1; end if;
  end loop;
  if p_industry = 'RESIDENTIAL' then
    insert into pm.res_settings (org_id, location_id) values (v_org, p_location) on conflict (org_id, location_id) do nothing;
    update pm.res_settings set
      business_kind = coalesce(nullif(s ->> 'business_kind', ''), business_kind),
      default_contract_type = coalesce(nullif(s ->> 'default_contract_type', ''), default_contract_type),
      default_tax_form = coalesce(nullif(s ->> 'default_tax_form', ''), default_tax_form),
      state_code = coalesce(nullif(s ->> 'state_code', ''), state_code),
      default_deposit_pct = coalesce(pm._x_try_num(s ->> 'default_deposit_pct'), default_deposit_pct),
      default_markup_pct = coalesce(pm._x_try_num(s ->> 'default_markup_pct'), default_markup_pct),
      billing_method = coalesce(nullif(s ->> 'billing_method', ''), billing_method),
      self_perform_mix = coalesce(nullif(s ->> 'self_perform_mix', ''), self_perform_mix),
      structural_warranty_years = coalesce(pm._x_try_num(s ->> 'structural_warranty_years')::int, structural_warranty_years),
      warranty_walk_days = case when s ? 'warranty_walk_days' then array(select x::int from jsonb_array_elements_text(s -> 'warranty_walk_days') x) else warranty_walk_days end,
      payment_template = coalesce(p_plan -> 'payment_template', payment_template),
      selection_library = coalesce(p_plan -> 'selection_library', selection_library),
      portal_defaults = coalesce(p_plan -> 'portal_defaults', portal_defaults),
      setup_completed_at = now(), updated_by = pm.current_user_id(), updated_at = now()
    where org_id = v_org and location_id = p_location;
    if coalesce((p_plan ->> 'builder_job_types')::boolean, false) then
      perform pm._wc_require_location('projects.settings', 'configure', p_location);
      n_tpl := pm.res_seed_builder_templates(p_location);
    end if;
  elsif p_industry = 'FLOORING' then
    insert into pm.flr_settings (org_id, location_id) values (v_org, p_location) on conflict (org_id, location_id) do nothing;
    update pm.flr_settings set
      business_mix = case when s ? 'business_mix' then array(select x from jsonb_array_elements_text(s -> 'business_mix') x) else business_mix end,
      installer_pay_basis = coalesce(nullif(s ->> 'installer_pay_basis', ''), installer_pay_basis),
      default_deposit_pct = coalesce(pm._x_try_num(s ->> 'default_deposit_pct'), default_deposit_pct),
      tax_states = case when s ? 'tax_states' then array(select upper(x) from jsonb_array_elements_text(s -> 'tax_states') x) else tax_states end,
      replacing_system = coalesce(nullif(s ->> 'replacing_system', ''), replacing_system),
      measure_fee_cents = coalesce(pm._x_try_bigint(s ->> 'measure_fee_cents'), measure_fee_cents),
      updated_by = pm.current_user_id(), updated_at = now()
    where org_id = v_org and location_id = p_location;
    if jsonb_typeof(p_plan -> 'labor_rates') = 'array' then
      insert into pm.flr_labor_rates (org_id, location_id, code, description, unit, applies_to, sell_cents, pay_cents)
      select v_org, p_location, upper(x ->> 'code'), left(x ->> 'description', 160), x ->> 'unit', coalesce(x ->> 'applies_to', 'FLOOR'),
             coalesce(pm._x_try_bigint(x ->> 'sell_cents'), 0), coalesce(pm._x_try_bigint(x ->> 'pay_cents'), 0)
        from jsonb_array_elements(p_plan -> 'labor_rates') x
      on conflict (org_id, location_id, code) do nothing;
    end if;
  else
    insert into pm.dsn_settings (org_id, location_id) values (v_org, p_location) on conflict (org_id, location_id) do nothing;
    update pm.dsn_settings set
      firm_type = coalesce(nullif(s ->> 'firm_type', ''), firm_type),
      fee_models = case when s ? 'fee_models' then array(select x from jsonb_array_elements_text(s -> 'fee_models') x) else fee_models end,
      default_markup_pct = coalesce(pm._x_try_num(s ->> 'default_markup_pct'), default_markup_pct),
      product_deposit_pct = coalesce(pm._x_try_num(s ->> 'product_deposit_pct'), product_deposit_pct),
      retainer_cents = coalesce(pm._x_try_bigint(s ->> 'retainer_cents'), retainer_cents),
      retainer_evergreen = coalesce(pm._x_try_bool(s ->> 'retainer_evergreen'), retainer_evergreen),
      show_cost_default = coalesce(pm._x_try_bool(s ->> 'show_cost_default'), show_cost_default),
      receivers = coalesce(p_plan -> 'receivers', receivers),
      tax_states = case when s ? 'tax_states' then array(select upper(x) from jsonb_array_elements_text(s -> 'tax_states') x) else tax_states end,
      replacing_system = coalesce(nullif(s ->> 'replacing_system', ''), replacing_system),
      updated_by = pm.current_user_id(), updated_at = now()
    where org_id = v_org and location_id = p_location;
  end if;
  v_res := jsonb_build_object('cost_codes_added', n_codes, 'job_types_added', n_tpl);
  insert into pm.wc_setup_runs (org_id, location_id, industry, answers, plan, result) values (v_org, p_location, p_industry, p_answers, p_plan, v_res) returning id into v_run;
  if jsonb_typeof(p_plan -> 'books_accounts') = 'object' then
    perform pm._wc_books_request(v_org, p_location, null, 'ACCOUNT_MAP', 'wc_setup_runs', v_run,
      jsonb_build_object('location_id', p_location, 'industry', p_industry, 'accounts', p_plan -> 'books_accounts', 'cost_codes', coalesce(p_plan -> 'cost_codes', '[]')));
  end if;
  return v_res || jsonb_build_object('run_id', v_run);
end $$;

-- ============================================================================
-- Z. 1110 registries: classes, masked columns, RPC guards; RLS; grants
-- ============================================================================
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('wc_setup_runs',            'C','location', '{projects.settings}', null, null, null, null, null, false, '1124: setup interview runs (answers + applied plan)'),
  ('wc_books_requests',        'C','location', '{projects.financials,projects.billing}', null, null, null, null, null, false, '1124: held hand-offs to Books'),
  ('wc_field_commands',        'P','org', '{}', null, null, null, '%1$suser_id = pm.current_user_id()', 'false', false, '1124: phone command idempotency ledger (own rows; written only by definer RPCs)'),
  ('wc_reps',                  'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124: sales / measure / design reps and their calendars'),
  ('wc_appointments',          'C','location', '{projects.leads,projects.dispatch,projects.estimates}', null, null, null,
     '%1$srep_id in (select r.id from pm.wc_reps r where r.org_id = public.get_org_id() and r.membership_id = (select pm.access_my_membership()))', null, false, '1124: in-home / measure / discovery appointments; the rep reads their own'),
  ('wc_booking_links',         'C','location', '{projects.settings}', null, null, null, null, null, false, '1124: self-booking links (token hash only)'),
  ('wc_booking_hits',          'P','org', '{}', null, null, null, 'false', 'false', false, '1124: self-booking per-client counter (written by the anon RPC only)'),
  ('res_job_templates',        'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (RES-03): builder job types'),
  ('res_job_setups',           'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-03): job type applied to a job'),
  ('res_site_captures',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-11): in-home measure / site capture'),
  ('res_kb_imports',           'J','job',      '{projects.estimates}', null, null, null, null, null, false, '1124 (RES-23): K&B design-software imports'),
  ('res_kb_import_lines',      'J','parent',   '{}', null, 'res_kb_imports', 'import_id', null, null, false, '1124 (RES-23): imported cabinet lines; cost masked'),
  ('res_kb_sku_map',           'S','location', '{}', 'projects.estimates', null, null, null, null, false, '1124 (RES-23): learned SKU → catalog map'),
  ('res_resource_capacity',    'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1124 (RES-49): crew / trade capacity'),
  ('res_client_date_changes',  'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-52): homeowner date-change explanations'),
  ('res_receipt_captures',     'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-62): receipts; amount masked except to the person who captured it'),
  ('res_watch_settings',       'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (RES-122/123): alert threshold, sales target (masked)'),
  ('res_margin_alerts',        'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RES-84/122): margin-fade / cash-negative alerts'),
  ('res_client_updates',       'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-90): weekly client updates'),
  ('res_closeout_packages',    'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RES-97): closeout package'),
  ('res_closeout_items',       'J','parent',   '{}', null, 'res_closeout_packages', 'package_id', null, null, false, '1124 (RES-97): closeout package items'),
  ('dev_pursuits',             'C','location', '{projects.financials}', null, null, null, null, null, false, '1124 (RED-03): pursuit pipeline at the sponsor'),
  ('dev_dd_items',             'C','parent',   '{}', null, 'dev_pursuits', 'pursuit_id', null, null, false, '1124 (RED-04): due diligence checklist'),
  ('dev_entitlement_conditions','J','parent',  '{}', null, 'entitlements', 'entitlement_id', null, null, false, '1124 (RED-05): conditions of approval'),
  ('dev_incentives',           'M','job',      '{projects.financials}', 'projects.financials', null, null, null, null, false, '1124 (RED-05): TIF / abatement / grant agreements'),
  ('dev_covenants',            'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-06): loan / investor covenants'),
  ('dev_capitalized_interest', 'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-15): capitalized interest by month'),
  ('dev_fee_schedules',        'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-16): developer / CM fee schedules'),
  ('dev_fee_draws',            'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-16): fee draws'),
  ('dev_co_funding',           'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-19): change-order funding + lender consent'),
  ('dev_invoice_inbox',        'C','location', '{projects.financials,projects.billing}', null, null, null, null, null, false, '1124 (RED-21): central invoice inbox'),
  ('dev_pay_app_reviews',      'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-22): GC pay app reviews'),
  ('dev_invoice_routes',       'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (RED-23): invoice approval chains'),
  ('dev_invoice_approvals',    'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-23): invoice approval steps'),
  ('dev_draw_fundings',        'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-29): funding per source'),
  ('dev_disbursements',        'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-29): disbursements'),
  ('dev_status_events',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (RED-31): construction status events'),
  ('dev_affiliate_bills',      'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-42): affiliated GC billing'),
  ('dev_imports',              'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (RED-08/44): development migration + pro forma import'),
  ('flr_lead_rotation',        'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (FLR-03): salesperson rotation'),
  ('flr_price_imports',        'C','location', '{projects.store,projects.estimates,projects.settings}', null, null, null, null, null, false, '1124 (FLR-14): staged price files'),
  ('flr_price_import_lines',   'C','parent',   '{}', null, 'flr_price_imports', 'import_id', null, null, false, '1124 (FLR-14): price file lines; cost masked'),
  ('flr_deposit_terms',        'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1124 (FLR-17): deposit terms'),
  ('flr_counter_sales',        'C','location', '{projects.store}', null, null, null, null, null, false, '1124 (FLR-19): counter sales'),
  ('flr_counter_sale_lines',   'C','parent',   '{}', null, 'flr_counter_sales', 'sale_id', null, null, false, '1124 (FLR-19): counter sale lines'),
  ('flr_field_changes',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (FLR-20): on-site changes; installer pay masked'),
  ('flr_lots',                 'C','location', '{projects.store,projects.production,projects.estimates,projects.dispatch}', null, null, null, null, null, false, '1124 (FLR-26): carton / shade lots'),
  ('flr_lot_moves',            'C','parent',   '{}', null, 'flr_lots', 'lot_id', null, null, false, '1124 (FLR-26): lot moves'),
  ('flr_receipts',             'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (FLR-28): receiving inspections; landed cost masked'),
  ('flr_unmatched_receipts',   'C','location', '{projects.store,projects.selections,projects.dispatch}', null, null, null, null, null, false, '1124 (FLR-28): goods received with no job'),
  ('flr_installers',           'C','location', '{projects.dispatch,projects.labor_rates,projects.settings}', null, null, null,
     '%1$semployee_id in (select pm.my_employee_ids())', null, false, '1124 (FLR-32): installer records + compliance; installers read their own'),
  ('flr_signoffs',             'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (FLR-33): customer sign-off on the device'),
  ('flr_callbacks',            'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (FLR-37): callbacks; cost masked'),
  ('dsn_settings',             'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (ID-01): firm setup'),
  ('dsn_discovery',            'C','location', '{projects.leads}', null, null, null, null, null, false, '1124 (ID-03): discovery notes per inquiry'),
  ('dsn_agreements',           'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1124 (ID-04): letters of agreement'),
  ('dsn_rooms',                'J','job',      '{projects.selections}', null, null, null, null, null, false, '1124 (ID-05/06): rooms, phases, budgets (masked)'),
  ('dsn_products',             'S','location', '{}', 'projects.selections', null, null, null, null, false, '1124 (ID-07/08): product library; trade cost masked'),
  ('dsn_vendor_terms',         'S','location', '{}', 'projects.selections', null, null, null, null, false, '1124 (ID-08): vendor terms; trade discount masked'),
  ('dsn_pricing_rules',        'S','location', '{}', 'projects.settings', null, null, null, null, false, '1124 (ID-14): pricing rules'),
  ('dsn_boards',               'J','job',      '{projects.selections}', null, null, null, null, null, false, '1124 (ID-11): mood boards'),
  ('dsn_board_items',          'J','parent',   '{}', null, 'dsn_boards', 'board_id', null, null, false, '1124 (ID-11): board items'),
  ('dsn_item_changes',         'J','job',      '{projects.selections}', null, null, null, null, null, false, '1124 (ID-24): changes / cancellations / returns'),
  ('dsn_freight_claims',       'J','job',      '{projects.selections}', null, null, null, null, null, false, '1124 (ID-25): freight claims'),
  ('dsn_install_checklists',   'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1124 (ID-28): install day'),
  ('dsn_reimbursables',        'M','job',      '{projects.financials}', null, null, null, null, null, false, '1124 (ID-34): reimbursable expenses')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('res_kb_imports',        'list_total_cents', '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.created_by = (select pm.current_user_id()))', null::text, '1124: supplier list total'),
  ('res_kb_import_lines',   'list_price_cents', 't.import_id in (select x.id from pm.res_kb_imports x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1124'),
  ('res_kb_import_lines',   'unit_cost_cents',  't.import_id in (select x.id from pm.res_kb_imports x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1124'),
  ('res_receipt_captures',  'amount_cents',     '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.captured_by = (select pm.current_user_id()))', null, '1124: receipt total (the capturer sees their own)'),
  ('res_receipt_captures',  'tax_cents',        '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.captured_by = (select pm.current_user_id()))', null, '1124'),
  ('res_watch_settings',    'annual_sales_target_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1124'),
  ('flr_price_import_lines','new_cost_cents',   't.import_id in (select x.id from pm.flr_price_imports x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, '1124'),
  ('flr_price_import_lines','old_cost_cents',   't.import_id in (select x.id from pm.flr_price_imports x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, '1124'),
  ('flr_price_import_lines','margin_impact_cents','t.import_id in (select x.id from pm.flr_price_imports x where x.org_id = public.get_org_id() and x.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, '1124'),
  ('flr_field_changes',     'pay_cents',        't.job_id in (select pm.my_money_job_ids(''projects.labor_rates''))', null, '1124: installer pay'),
  ('flr_field_changes',     'sell_cents',       't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1124 (L9): the price of the change'),
  ('wc_setup_runs',         'plan',             't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))',
     '(coalesce(t.plan, ''{}''::jsonb) - ''labor_rates'') || jsonb_build_object(''settings'', coalesce(t.plan -> ''settings'', ''{}''::jsonb) - ''retainer_cents'' - ''measure_fee_cents'' - ''default_markup_pct'')', '1124 (L9): setup plan rates / fees'),
  ('wc_books_requests',     'payload',          't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))',
     'jsonb_build_object(''request'', t.payload ->> ''request'')', '1124 (L9): the Books hand-off body'),
  ('flr_field_changes',     'lines',            '(t.job_id in (select pm.my_money_job_ids(''projects.labor_rates'')) and t.job_id in (select pm.my_money_job_ids(''projects.contract_value'')))', '(select coalesce(jsonb_agg(x - ''pay_rate_cents'' - ''pay_cents'' - ''sell_cents''), ''[]''::jsonb) from jsonb_array_elements(t.lines) x)', '1124: lines without pay or price'),
  ('flr_receipts',          'landed_cost_cents','t.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124'),
  ('flr_receipts',          'freight_in_cents', 't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124'),
  ('flr_callbacks',         'cost_cents',       't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124'),
  ('dsn_rooms',             'budget_cents',     't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1124'),
  ('dsn_products',          'trade_cost_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1124: net trade cost'),
  ('dsn_vendor_terms',      'trade_discount_pct','t.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1124'),
  ('dsn_vendor_terms',      'restocking_fee_pct','t.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1124'),
  ('dsn_item_changes',      'restocking_fee_cents','t.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124'),
  ('dsn_item_changes',      'deposit_moved_cents','t.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1124'),
  ('dsn_freight_claims',    'claim_cents',      't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124'),
  ('dsn_freight_claims',    'settled_cents',    't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1124')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  -- shared
  ('wc_appointment_slots',      '{p_location}', 'if not (pm.access_can_location(''projects.leads'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.leads:view or projects.dispatch:view''); end if;', '1124'),
  ('wc_book_appointment',       '{p_location}', 'if not (pm.access_can_location(''projects.leads'', ''create'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.leads:create or projects.dispatch:edit''); end if;', '1124'),
  ('wc_set_appointment_status', '{p_appointment}', 'if not (exists (select 1 from pm.wc_appointments ap join pm.wc_reps rp on rp.id = ap.rep_id where ap.id = p_appointment and ap.org_id = public.get_org_id() and rp.membership_id = pm.access_my_membership()) or pm.access_can_row(''projects.leads'', ''edit'', ''wc_appointments'', p_appointment) or pm.access_can_row(''projects.dispatch'', ''edit'', ''wc_appointments'', p_appointment)) then perform pm.access_forbid(''requires your own appointment, projects.leads:edit or projects.dispatch:edit''); end if;', '1124'),
  ('wc_send_appointment_reminders','{p_location}', 'if not (pm.access_can_location(''projects.leads'', ''edit'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.leads:edit or projects.dispatch:edit''); end if;', '1124'),
  ('wc_create_booking_link',    '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1124'),
  ('wc_revoke_booking_link',    '{p_link}',     'perform pm.access_assert_row(''projects.settings'', array[''configure''], ''wc_booking_links'', p_link);', '1124 (M1)'),
  ('wc_apply_setup',            '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1124'),
  -- residential
  ('res_seed_builder_templates','{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1124'),
  ('res_apply_job_template',    '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('res_save_site_capture',     '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('res_finalize_site_capture', '{p_capture}',  'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_site_captures'', p_capture);', '1124'),
  ('res_stage_kb_import',       '{p_proposal}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''res_proposals'', p_proposal);', '1124'),
  ('res_map_kb_line',           '{p_line}',     'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''res_kb_import_lines'', p_line);', '1124'),
  ('res_apply_kb_import',       '{p_import}',   'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''res_kb_imports'', p_import);', '1124'),
  ('res_discard_kb_import',     '{p_import}',   'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''res_kb_imports'', p_import);', '1124'),
  ('res_crew_capacity',         '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:view or projects.reports:view''); end if;', '1124'),
  ('res_apply_client_schedule_filter','{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('res_post_date_change',      '{p_change}',   'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_client_date_changes'', p_change);', '1124'),
  ('res_dismiss_date_change',   '{p_change}',   'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_client_date_changes'', p_change);', '1124'),
  ('res_capture_receipt',       '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1124: anyone on the job snaps a receipt'),
  ('res_code_receipt',          '{p_receipt}',  'if not (pm.access_can_row(''projects.financials'', ''edit'', ''res_receipt_captures'', p_receipt) or pm.access_can_row(''projects.commitments'', ''edit'', ''res_receipt_captures'', p_receipt)) then perform pm.access_forbid(''requires projects.financials:edit or projects.commitments:edit''); end if;', '1124'),
  ('res_field_sites',           '{p_jobs}',     'if not pm.can_any(array[''projects.jobs'']::text[], ''view'') then perform pm.access_forbid(''requires projects.jobs:view''); end if;', '1124: rows limited to the caller''s jobs inside'),
  ('res_job_cash_position',     '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  ('res_cash_positions',        '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1124'),
  ('res_margin_fade',           '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  ('res_scan_job_health',       '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1124'),
  ('res_acknowledge_alert',     '{p_alert}',    'perform pm.access_assert_row(''projects.financials'', array[''view''], ''res_margin_alerts'', p_alert);', '1124'),
  ('res_draft_client_update',   '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('res_draft_weekly_updates',  '{p_location}', 'perform pm.access_assert_location(''projects.jobs'', array[''edit''], p_location);', '1124'),
  ('res_edit_client_update',    '{p_update}',   'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_client_updates'', p_update);', '1124'),
  ('res_send_client_update',    '{p_update}',   'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_client_updates'', p_update);', '1124'),
  ('res_assemble_closeout',     '{p_job}',      'perform pm.access_assert_job(''projects.documents'', array[''edit''], p_job);', '1124'),
  ('res_add_closeout_item',     '{p_job}',      'perform pm.access_assert_job(''projects.documents'', array[''edit''], p_job);', '1124'),
  ('res_set_closeout_item',     '{p_item}',     'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''res_closeout_items'', p_item);', '1124'),
  ('res_publish_closeout',      '{p_package}',  'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''res_closeout_packages'', p_package);', '1124'),
  ('res_owner_dashboard',       '{p_location}', 'if p_location is not null then perform pm.access_assert_location(''projects.financials'', array[''view''], p_location); elsif not pm.can(''projects.financials'', ''view'') then perform pm.access_forbid(''requires projects.financials:view''); end if;', '1124'),
  -- development
  ('dev_save_pursuit',          '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location);', '1124'),
  ('dev_advance_pursuit',       '{p_pursuit}',  'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pursuits'', p_pursuit);', '1124'),
  ('dev_seed_dd',               '{p_pursuit}',  'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pursuits'', p_pursuit);', '1124'),
  ('dev_update_dd_item',        '{p_item}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_dd_items'', p_item);', '1124'),
  ('dev_kill_pursuit',          '{p_pursuit}',  'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pursuits'', p_pursuit);', '1124'),
  ('dev_go_pursuit',            '{p_pursuit}',  'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pursuits'', p_pursuit);', '1124'),
  ('dev_pursuit_board',         '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1124'),
  ('dev_add_entitlement_condition','{p_entitlement}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''entitlements'', p_entitlement);', '1124'),
  ('dev_set_condition_status',  '{p_condition}','perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''dev_entitlement_conditions'', p_condition);', '1124'),
  ('dev_entitlement_board',     '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1124'),
  ('dev_save_covenant',         '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1124'),
  ('dev_test_covenant',         '{p_covenant}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_covenants'', p_covenant);', '1124'),
  ('dev_calendar',              '{p_location}', 'if p_location is not null then perform pm.access_assert_location(''projects.jobs'', array[''view''], p_location); elsif not pm.can(''projects.jobs'', ''view'') then perform pm.access_forbid(''requires projects.jobs:view''); end if;', '1124: rows limited inside'),
  ('dev_send_date_reminders',   '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1124'),
  ('dev_record_interest',       '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1124'),
  ('dev_interest_reserve',      '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  ('dev_set_fee_schedule',      '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1124'),
  ('dev_fee_position',          '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  ('dev_request_fee_draw',      '{p_fee}',      'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_fee_schedules'', p_fee);', '1124'),
  ('dev_set_co_funding',        '{p_change_order}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''change_orders'', p_change_order);', '1124'),
  ('dev_record_co_consent',     '{p_change_order}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''change_orders'', p_change_order);', '1124'),
  ('dev_compliance',            '{p_job}',      'perform pm.access_assert_job(''projects.commitments'', array[''view''], p_job);', '1124'),
  ('dev_inbox_ingest',          '{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''edit'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.billing:edit or projects.financials:edit''); end if;', '1124'),
  ('dev_inbox_confirm',         '{p_item}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''dev_invoice_inbox'', p_item);', '1124'),
  ('dev_inbox_dismiss',         '{p_item}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''dev_invoice_inbox'', p_item);', '1124'),
  ('dev_review_pay_app',        '{p_commitment}', 'perform pm.access_assert_row(''projects.financials'', array[''view''], ''commitments'', p_commitment);', '1124'),
  ('dev_route_invoice',         '{p_invoice}',  'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''dev_draw_invoices'', p_invoice);', '1124'),
  ('dev_decide_invoice_step',   '{p_invoice}',  'if not (pm.access_can_row(''projects.billing'', ''approve'', ''dev_draw_invoices'', p_invoice) or pm.access_can_row(''projects.financials'', ''edit'', ''dev_draw_invoices'', p_invoice)) then perform pm.access_forbid(''requires projects.billing:approve or projects.financials:edit''); end if;', '1124: the step role is checked inside'),
  ('dev_record_funding',        '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1124'),
  ('dev_record_disbursement',   '{p_draw}',     'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1124'),
  ('dev_draw_tracking',         '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  ('dev_seed_milestones',       '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('dev_record_status_event',   '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('dev_seed_doc_room',         '{p_job}',      'perform pm.access_assert_job(''projects.documents'', array[''edit''], p_job);', '1124'),
  ('dev_share_folder',          '{p_folder}',   'perform pm.access_assert_row(''projects.documents'', array[''edit''], ''doc_folders'', p_folder);', '1124'),
  ('dev_affiliate_bill',        '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1124: the GC job is checked inside'),
  ('dev_approve_affiliate_bill','{p_bill}',     'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_affiliate_bills'', p_bill);', '1124'),
  ('dev_stage_import',          '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1124'),
  ('dev_set_import_map',        '{p_import}',   'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_imports'', p_import);', '1124'),
  ('dev_apply_import',          '{p_import}',   'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_imports'', p_import);', '1124'),
  ('dev_tieout',                '{p_job}',      'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1124'),
  -- flooring
  ('flr_assign_lead',           '{p_lead}',     'if not exists (select 1 from crm.leads ld where ld.id = p_lead and ld.org_id = public.get_org_id() and pm.access_can_location(''projects.leads'', ''edit'', ld.location_id)) then perform pm.access_forbid(''requires projects.leads:edit at the lead''''s company''); end if;', '1124'),
  ('flr_credit_measure_fee',    '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', '1124'),
  ('flr_stage_price_import',    '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.store'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.store:edit''); end if;', '1124'),
  ('flr_apply_price_import',    '{p_import}',   'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''flr_price_imports'', p_import);', '1124: cost changes'),
  ('flr_request_deposit',       '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1124'),
  ('flr_counter_sale',          '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', '1124'),
  ('flr_field_change',          '{p_job}',      'if not (pm.access_can_job(''projects.change_orders'', ''create'', p_job) or exists (select 1 from pm.flr_install_bookings bk where bk.job_id = p_job and bk.org_id = public.get_org_id() and bk.crew_id in (select pm.my_crew_ids()))) then perform pm.access_forbid(''requires projects.change_orders:create or an install booked to your crew''); end if;', '1124'),
  ('flr_add_field_changes_to_ticket','{p_ticket}', 'perform pm.access_assert_row(''projects.labor_rates'', array[''edit''], ''flr_pay_tickets'', p_ticket);', '1124'),
  ('flr_special_order',         '{p_job}',      'if not (pm.access_can_job(''projects.selections'', ''edit'', p_job) or pm.access_can_job(''projects.store'', ''edit'', p_job) or pm.access_can_job(''projects.commitments'', ''create'', p_job)) then perform pm.access_forbid(''requires projects.selections:edit, projects.store:edit or projects.commitments:create''); end if;', '1124'),
  ('flr_create_special_order_pos','{p_job}',    'perform pm.access_assert_job(''projects.commitments'', array[''create''], p_job);', '1124'),
  ('flr_special_order_tracker', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.selections'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.store, selections or dispatch view''); end if;', '1124'),
  ('flr_receive_lot',           '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.production'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store:edit or projects.production:edit''); end if;', '1124'),
  ('flr_move_lot',              '{p_lot}',      'if not (pm.access_can_row(''projects.store'', ''edit'', ''flr_lots'', p_lot) or pm.access_can_row(''projects.production'', ''edit'', ''flr_lots'', p_lot)) then perform pm.access_forbid(''requires projects.store:edit or projects.production:edit''); end if;', '1124'),
  ('flr_receive_special_order', '{p_item}',     'if not (pm.access_can_row(''projects.selections'', ''edit'', ''procurement_items'', p_item) or pm.access_can_row(''projects.store'', ''edit'', ''procurement_items'', p_item)) then perform pm.access_forbid(''requires projects.selections:edit or projects.store:edit''); end if;', '1124'),
  ('flr_log_unmatched_receipt', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.selections'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store:edit or projects.selections:edit''); end if;', '1124'),
  ('flr_match_receipt',         '{p_unmatched}','if not (pm.access_can_row(''projects.store'', ''edit'', ''flr_unmatched_receipts'', p_unmatched) or pm.access_can_row(''projects.selections'', ''edit'', ''flr_unmatched_receipts'', p_unmatched)) then perform pm.access_forbid(''requires projects.store:edit or projects.selections:edit''); end if;', '1124'),
  ('flr_send_install_confirmations','{p_location}', 'perform pm.access_assert_location(''projects.dispatch'', array[''edit''], p_location);', '1124'),
  ('flr_booking_status',        '{p_booking}',  'if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''flr_install_bookings'', p_booking) or exists (select 1 from pm.flr_install_bookings bk where bk.id = p_booking and bk.org_id = public.get_org_id() and bk.crew_id in (select pm.my_crew_ids()))) then perform pm.access_forbid(''requires projects.dispatch:edit or the booking on your crew''); end if;', '1124'),
  ('flr_save_installer',        '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''edit'', p_location) or pm.access_can_location(''projects.settings'', ''configure'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.settings:configure''); end if;', '1124'),
  ('flr_installer_compliance',  '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.labor_rates'', ''view'', p_location) or pm.access_can_location(''projects.settings'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:view''); end if;', '1124'),
  ('flr_installer_day',         '{}',           'if not pm.can_any(array[''projects.jobs'']::text[], ''view'') then perform pm.access_forbid(''requires projects.jobs:view''); end if;', '1124: own crew / own pay inside'),
  ('flr_record_signoff',        '{p_booking}',  'if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''flr_install_bookings'', p_booking) or exists (select 1 from pm.flr_install_bookings bk where bk.id = p_booking and bk.org_id = public.get_org_id() and bk.crew_id in (select pm.my_crew_ids()))) then perform pm.access_forbid(''requires projects.dispatch:edit or the booking on your crew''); end if;', '1124'),
  ('flr_completion_invoice',    '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1124'),
  ('flr_open_callback',         '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('flr_close_callback',        '{p_callback}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''flr_callbacks'', p_callback);', '1124'),
  ('flr_reports',               '{p_location}', 'perform pm.access_assert_location(''projects.reports'', array[''view''], p_location);', '1124'),
  -- design
  ('dsn_save_discovery',        '{p_lead}',     'if not exists (select 1 from crm.leads ld where ld.id = p_lead and ld.org_id = public.get_org_id() and pm.access_can_location(''projects.leads'', ''edit'', ld.location_id)) then perform pm.access_forbid(''requires projects.leads:edit at the lead''''s company''); end if;', '1124'),
  ('dsn_draft_agreement',       '{p_job}',      'perform pm.access_assert_job(''projects.estimates'', array[''edit''], p_job); perform pm.access_assert_job(''projects.contract_value'', array[''view''], p_job);', '1124'),
  ('dsn_mark_agreement_sent',   '{p_agreement}','perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''dsn_agreements'', p_agreement);', '1124'),
  ('dsn_mark_agreement_signed', '{p_agreement}','perform pm.access_assert_row(''projects.billing'', array[''create''], ''dsn_agreements'', p_agreement);', '1124: requests the retainer invoice'),
  ('dsn_save_room',             '{p_job}',      'perform pm.access_assert_job(''projects.selections'', array[''edit''], p_job);', '1124'),
  ('dsn_room_budgets',          '{p_job}',      'perform pm.access_assert_job(''projects.selections'', array[''view''], p_job);', '1124'),
  ('dsn_clip',                  '{p_location}', 'perform pm.access_assert_location(''projects.selections'', array[''edit''], p_location);', '1124'),
  ('dsn_price',                 '{p_location}', 'perform pm.access_assert_location(''projects.selections'', array[''view''], p_location);', '1124'),
  ('dsn_add_product_item',      '{p_job}',      'perform pm.access_assert_job(''projects.selections'', array[''edit''], p_job);', '1124'),
  ('dsn_save_board',            '{p_job}',      'perform pm.access_assert_job(''projects.selections'', array[''edit''], p_job);', '1124'),
  ('dsn_present_board',         '{p_board}',    'perform pm.access_assert_row(''projects.selections'', array[''edit''], ''dsn_boards'', p_board);', '1124'),
  ('dsn_ffe_schedule',          '{p_job}',      'perform pm.access_assert_job(''projects.selections'', array[''view''], p_job);', '1124'),
  ('dsn_change_item',           '{p_item}',     'perform pm.access_assert_row(''projects.selections'', array[''edit''], ''dsn_items'', p_item);', '1124'),
  ('dsn_open_freight_claim',    '{p_component}','perform pm.access_assert_row(''projects.selections'', array[''edit''], ''procurement_items'', p_component);', '1124'),
  ('dsn_update_freight_claim',  '{p_claim}',    'perform pm.access_assert_row(''projects.selections'', array[''edit''], ''dsn_freight_claims'', p_claim);', '1124'),
  ('dsn_install_day',           '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1124'),
  ('dsn_complete_install',      '{p_checklist}','perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''dsn_install_checklists'', p_checklist);', '1124'),
  ('dsn_draft_product_invoice', '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1124'),
  ('dsn_deposit_statement',     '{p_job}',      'perform pm.access_assert_job(''projects.contract_value'', array[''view''], p_job);', '1124'),
  ('dsn_add_reimbursable',      '{p_job}',      'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1124'),
  ('dsn_bill_reimbursables',    '{p_job}',      'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1124'),
  ('dsn_reports',               '{p_location}', 'perform pm.access_assert_location(''projects.reports'', array[''view''], p_location);', '1124')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- RLS: permissive org isolation on every new table (the class policies narrow it)
do $$
declare t text;
begin
  foreach t in array array['wc_setup_runs','wc_books_requests','wc_field_commands','wc_booking_hits','wc_reps','wc_appointments','wc_booking_links','res_job_templates','res_job_setups','res_site_captures',
              'res_kb_imports','res_kb_import_lines','res_kb_sku_map','res_resource_capacity','res_client_date_changes','res_receipt_captures','res_watch_settings',
              'res_margin_alerts','res_client_updates','res_closeout_packages','res_closeout_items','dev_pursuits','dev_dd_items','dev_entitlement_conditions',
              'dev_incentives','dev_covenants','dev_capitalized_interest','dev_fee_schedules','dev_fee_draws','dev_co_funding','dev_invoice_inbox','dev_pay_app_reviews',
              'dev_invoice_routes','dev_invoice_approvals','dev_draw_fundings','dev_disbursements','dev_status_events','dev_affiliate_bills','dev_imports',
              'flr_lead_rotation','flr_price_imports','flr_price_import_lines','flr_deposit_terms','flr_counter_sales','flr_counter_sale_lines','flr_field_changes',
              'flr_lots','flr_lot_moves','flr_receipts','flr_unmatched_receipts','flr_installers','flr_signoffs','flr_callbacks','dsn_settings','dsn_discovery',
              'dsn_agreements','dsn_rooms','dsn_products','dsn_vendor_terms','dsn_pricing_rules','dsn_boards','dsn_board_items','dsn_item_changes',
              'dsn_freight_claims','dsn_install_checklists','dsn_reimbursables'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
    execute format('grant select on pm.%I to authenticated', t);
  end loop;
end $$;

-- config / catalog tables are member-writable through their class write cap
grant insert, update, delete on pm.wc_reps, pm.res_job_templates, pm.res_kb_sku_map, pm.res_resource_capacity, pm.res_watch_settings, pm.dev_incentives,
                pm.dev_invoice_routes, pm.flr_lead_rotation, pm.dsn_settings, pm.dsn_products, pm.dsn_vendor_terms, pm.dsn_pricing_rules
  to authenticated;

-- Policies (every classified table), masked views, RPC guards.
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon in pm; members get the guarded RPC surface and the pure helpers.
do $$
declare r record;
  v_member text[] := array[
    'wc_appointment_slots','wc_book_appointment','wc_set_appointment_status','wc_send_appointment_reminders','wc_create_booking_link','wc_revoke_booking_link','wc_apply_setup',
    'res_seed_builder_templates','res_apply_job_template','res_save_site_capture','res_finalize_site_capture','res_stage_kb_import','res_map_kb_line',
    'res_apply_kb_import','res_discard_kb_import','res_crew_capacity','res_apply_client_schedule_filter','res_post_date_change','res_dismiss_date_change',
    'res_capture_receipt','res_code_receipt','res_field_sites','res_job_cash_position','res_cash_positions','res_margin_fade','res_scan_job_health',
    'res_acknowledge_alert','res_draft_client_update','res_draft_weekly_updates','res_edit_client_update','res_send_client_update','res_assemble_closeout',
    'res_add_closeout_item','res_set_closeout_item','res_publish_closeout','res_owner_dashboard',
    'dev_save_pursuit','dev_advance_pursuit','dev_seed_dd','dev_update_dd_item','dev_kill_pursuit','dev_go_pursuit','dev_pursuit_board',
    'dev_add_entitlement_condition','dev_set_condition_status','dev_entitlement_board','dev_save_covenant','dev_test_covenant','dev_calendar',
    'dev_send_date_reminders','dev_record_interest','dev_interest_reserve','dev_set_fee_schedule','dev_fee_position','dev_request_fee_draw',
    'dev_set_co_funding','dev_record_co_consent','dev_compliance','dev_inbox_ingest','dev_inbox_confirm','dev_inbox_dismiss','dev_review_pay_app',
    'dev_route_invoice','dev_decide_invoice_step','dev_record_funding','dev_record_disbursement','dev_draw_tracking','dev_seed_milestones',
    'dev_record_status_event','dev_seed_doc_room','dev_share_folder','dev_affiliate_bill','dev_approve_affiliate_bill','dev_stage_import',
    'dev_set_import_map','dev_apply_import','dev_tieout',
    'flr_assign_lead','flr_credit_measure_fee','flr_stage_price_import','flr_apply_price_import','flr_request_deposit','flr_counter_sale',
    'flr_field_change','flr_add_field_changes_to_ticket','flr_special_order','flr_create_special_order_pos','flr_special_order_tracker',
    'flr_receive_lot','flr_move_lot','flr_receive_special_order','flr_log_unmatched_receipt','flr_match_receipt','flr_send_install_confirmations',
    'flr_booking_status','flr_save_installer','flr_installer_compliance','flr_installer_day','flr_record_signoff','flr_completion_invoice',
    'flr_open_callback','flr_close_callback','flr_reports',
    'dsn_save_discovery','dsn_draft_agreement','dsn_mark_agreement_sent','dsn_mark_agreement_signed','dsn_save_room','dsn_room_budgets','dsn_clip',
    'dsn_price','dsn_add_product_item','dsn_save_board','dsn_present_board','dsn_ffe_schedule','dsn_change_item','dsn_open_freight_claim',
    'dsn_update_freight_claim','dsn_install_day','dsn_complete_install','dsn_draft_product_invoice','dsn_deposit_statement','dsn_add_reimbursable',
    'dsn_bill_reimbursables','dsn_reports',
    'wc_distance_km','wc_drive_minutes','res_export_tables'];
  v_service text[] := array['_wc_loc','_wc_strip','_wc_tz','_wc_fanout','_wc_customer_msg','_wc_books_request','_wc_slots','tg_wc_appointment_ends',
    '_wc_books_ar','_res_cash_position','_res_margin_fade','_res_draft_update','_res_company_kpis','tg_res_client_date_change','_dev_step_ok',
    'tg_dev_co_consent_gate','tg_dev_spe_entity','tg_dev_invoice_chain','_wc_require_job','_wc_require_row','_wc_require_location','_wc_check_document','_wc_books_cash_visible','_flr_customer_contact','_flr_installer_blockers','tg_flr_booking_compliance','_dsn_room_rows',
    '_wc_cmd_claim','_wc_cmd_done','_res_photo_document'];
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname = any (v_member || v_service) loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname = any (v_member) then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
  -- public token-scoped self-booking (anon)
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('wc_booking_slots','wc_self_book') loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- ============================================================================
-- end 1124_pm_wave_c_residential_development_design_flooring
-- ============================================================================
