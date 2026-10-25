-- ============================================================================
-- 1117 · Merit Projects — field-service depth (Wave A, agent A-FS)
--
-- Spec: /home/claude/panel/03-field-service.md (seat 03, Launch rows), docs/projects/WAVE-A-BRIEF.md.
-- Builds on 1104 (work orders, dispatch, agreements, assets, price-book usage) and the 1110 access
-- foundation. Every new table is classified in pm.access_table_classes, every member-executable
-- definer RPC is registered in pm.access_rpc_guards, money columns are masked through
-- pm.access_masked_columns. No GL posting: Books owns invoices, AR, deferred revenue and cash.
--
-- What this migration adds
--   A. Booking spine (FS-02/03/04/09/10/15/16/119)
--        business_units, service_zones (zip lists), arrival_windows, campaigns, booking_job_types
--        (BU, job type, fees, CSR script JSON), capacity_limits (BU × zone × window × weekday | date),
--        service_calls (every call / web request / AI-agent booking; REQUEST rows hold capacity),
--        site_profiles (gate code, pets, do-not-service), fs_settings (time zone, quiet hours, review URL).
--        pm.work_orders gains business_unit_id, campaign_id, zone_id, arrival_window_id, service_day,
--        booking_channel, call_id, site_id (written only by the booking RPCs).
--        pm._fs_book = the ONE capacity-enforced booking path. Callers: pm.fs_book_call (CSR / AI agent,
--        guarded), pm.fs_convert_request, pm.fs_reschedule_booking, pm.fs_bulk_book_visits and the
--        public online-booking widget (public.fs_widget_availability / public.fs_widget_book —
--        token-scoped, anon-executable, REQUEST rows only, never creates a job).
--        Capacity: the most specific limit wins (a date row > a weekday row > an every-day row;
--        a zone row > an all-zones row). No limit row = unlimited for staff, closed for the widget.
--        Over capacity → PM_FS_CAPACITY_FULL (53400). Override: PHONE / WALK_IN / INTERNAL channels only,
--        with projects.dispatch:edit and a written reason; never WEB or AI_AGENT.
--   B. Dispatch depth (FS-14/16/17/18/104)
--        tech_profiles (zones, BUs, photo, dispatchable), tech_events (PTO / training / meeting / shop
--        blocks — a dispatch assignment overlapping one is refused), on_call_shifts, fs_messages
--        (customer text / email outbox: on-my-way, reminders, review requests, dunning; consent,
--        STOP list and quiet hours applied at enqueue). pm.fs_eligible_techs ranks who can take a job
--        (skills + unexpired certifications, zone, BU, availability, on call).
--   C. Flat-rate price book (FS-44/45/46/47)
--        price_book_items gains kind, category, BU, task hours, material/labor cost roll-ups (masked:
--        financials), member and after-hours prices, rounding lock, customer copy, upsells.
--        pricebook_categories, pricebook_settings (burdened rate, target GM, member %, after-hours
--        multiplier, rounding — financials), pricebook_markup_tiers (material markup ladder —
--        financials), pricebook_service_materials (bundled materials), financing_plans (provider stubs;
--        dealer fee masked). Formula (pm.fs_price_* — mirrored exactly by apps/projects
--        lib/fieldservice/pricing.ts, integer half-up arithmetic):
--          service  = rule( hours × rate ÷ (1 − GM) + Σ round(qty × unit cost × (1 + ladder(unit cost))) )
--          material = rule( cost × (1 + ladder(cost)) );  equipment = rule( cost ÷ (1 − equipment GM) )
--          member   = rule( price × (1 − member %) );    after hours = rule( price × multiplier )
--          rule: NONE (cents) | WHOLE (up to $1) | FIVE (up to $5) | NINE (up to the next $…9)
--        RPCs: fs_reprice_pricebook, fs_import_pricebook (CSV/Excel rows, dry run → report),
--        fs_bulk_price_change (preview with margin before/after), fs_seed_field_service (starter
--        HVAC / plumbing / electrical book, BUs, windows, job types with scripts, capacity, plans).
--   D. Good / better / best (FS-32/33/34/52/53/54)
--        fs_estimates, fs_estimate_options, fs_estimate_option_items (regular + member price pinned,
--        cost pinned and masked). fs_build_estimate, fs_present_estimate, fs_sell_estimate (sign,
--        deposit, financing plan, join a membership on site, sold option → APPROVED work-order lines
--        with sold_by; unsold options keep a dismiss reason), fs_decline_estimate.
--        pm.fs_monthly_payment(amount, apr, months) — amortized, half-up cents.
--   E. Agreements end to end (FS-60/61/62/63/64/65)
--        agreement_templates (tiers, perks, discount, revenue policy, renewal uplift, dunning limit),
--        service_agreements gains template_id, revenue_policy, visits_included, site_id, suspension and
--        dunning counters. agreement_billing_schedule (one row per billing period → a DRAFT
--        pm.billing_requests MILESTONE / RECURRING request through the existing Books seam),
--        agreement_revenue_facts (deferred-revenue outbox: BILLED, VISIT_DELIVERED, STRAIGHT_LINE,
--        CANCEL_REFUND, BREAKAGE, OPENING_BALANCE; source_ref pm:agrrev:… — Books recognizes),
--        agreement_imports (reconciliation reports). RPCs: fs_create_agreement_from_template,
--        fs_generate_agreement_billing, fs_recognize_straight_line, fs_import_agreements,
--        fs_bulk_book_visits, fs_run_dunning. Views: v_fs_visits_due, v_fs_renewals,
--        v_fs_agreement_deferred (roll-forward).
--   F. Installed equipment (FS-72/73/75/76)
--        pm.assets gains equipment type, tonnage, BTU, SEER2/HSPF2/AFUE, refrigerant + charge, fuel,
--        voltage/phase, manufactured_on, installer, install work order, parts / labor warranty ends,
--        registration status + deadline + reference, QR code, nameplate document, site. An INSTALL work
--        order cannot close while an asset it installed has a PENDING registration
--        (PM_FS_WARRANTY_REGISTRATION). v_fs_asset_summary: age, visits, repair spend, coverage.
--   G. Scorecards and performance pay inputs (FS-38/40/101/103)
--        fs_pay_plans (commission basis/%, spiffs, TGL bonus, membership spiff, recall chargeback —
--        labor_rates), fs_pay_assignments (P: own row or labor_rates), fs_tgl_leads, work_order_lines
--        gains sold_by / performed_by. pm.fs_tech_scorecard: a tech sees only their own row (with pay);
--        revenue needs contract_value; pay needs labor_rates (or being that tech).
--   H. Marketing (FS-106/107): campaign attribution (pm.fs_campaign_report — booked rate, revenue
--        with contract_value, cost/margin with financials), fs_review_requests (queued after a
--        completed customer-pay visit; never filtered by sentiment — Google policy).
--   I. Caller pop / pre-job brief (FS-02/27/100): pm.fs_caller_pop and pm.fs_prejob_brief. Books AR is
--        read by an internal definer helper; amounts only with contract_value or billing:view at the
--        company, flags (has balance / past due) for everyone else.
--
-- Access (1110 classes)
--   S  business_units, booking_job_types, fs_settings, pricebook_categories (settings; + financials:edit
--      for the book) · service_zones, arrival_windows, capacity_limits (dispatch:edit) · campaigns
--      (leads) · agreement_templates, financing_plans (settings or financials:edit) ·
--      pricebook_service_materials (parent price_book_items)
--   C  service_calls, fs_messages, site_profiles, tech_profiles, tech_events, on_call_shifts,
--      fs_review_requests, booking_widgets (settings), pricebook_settings / pricebook_markup_tiers /
--      agreement_imports (financials), fs_pay_plans (labor_rates)
--   P  fs_pay_assignments (own row or labor_rates)
--   J  fs_estimates, fs_estimate_options, fs_estimate_option_items, fs_tgl_leads
--   M  agreement_billing_schedule (contract_value), agreement_revenue_facts (financials)
--   price_book_items: write also with projects.financials:edit at the company (the GM keeps the book).
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * Deferred-revenue facts are a pm outbox (status PENDING), not core.events: Books rejects unknown
--     Projects event types (UNSUPPORTED_EVENT_TYPE). Books ask: consume pm.agreement_revenue_facts (or a
--     JOB_PROGRESS visits_delivered key). Recurring bills ride the existing JOB_BILLING RECURRING path.
--   * The public widget runs as definer functions in schema public (anon may execute nothing in pm).
--     It only creates REQUEST calls (capacity held); a CSR converts them into a job.
--   * Customer texts are queued in pm.fs_messages; delivery belongs to the notifications service
--     (1114 / Books request engine). Consent = core.contacts.sms_consent / email_consent, the STOP list =
--     core.request_suppressions.
--
-- APPLY RULE: after 1110 / 1111 / 1112. Idempotent: safe twice; 1110 can be re-applied after it.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1117_pm_field_service_depth requires 1110_pm_access';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Helpers
-- ----------------------------------------------------------------------------
-- Integer half-up division for non-negative numerators (exact; no float, no numeric display scale).
create or replace function pm.fs_rdiv(p_n numeric, p_d numeric) returns bigint
language sql immutable
set search_path = pm, public
as $$ select case when p_d = 0 then 0 else div(2 * p_n + p_d, 2 * p_d)::bigint end $$;

-- Apply a rounding rule to a price in cents.
create or replace function pm.fs_round_rule(p_cents bigint, p_rule text) returns bigint
language plpgsql immutable
set search_path = pm, public
as $$
declare d bigint;
begin
  if p_cents is null then return null; end if;
  if p_cents <= 0 then return 0; end if;
  case coalesce(p_rule, 'NONE')
    when 'WHOLE' then return ((p_cents + 99) / 100) * 100;
    when 'FIVE'  then return ((p_cents + 499) / 500) * 500;
    when 'NINE'  then
      d := (p_cents + 99) / 100;
      d := d + ((9 - (d % 10)) + 10) % 10;
      return d * 100;
    else return p_cents;
  end case;
end $$;

-- Markup (fraction, e.g. 1.25 = +125 %) for a unit cost from a ladder [{up_to_cents|null, markup_pct}].
create or replace function pm.fs_ladder_markup(p_cost bigint, p_ladder jsonb) returns numeric
language sql immutable
set search_path = pm, public
as $$
  select coalesce((
    select (t ->> 'markup_pct')::numeric
      from jsonb_array_elements(coalesce(p_ladder, '[]'::jsonb)) t
     where (t ->> 'up_to_cents') is null or (t ->> 'up_to_cents')::bigint >= p_cost
     order by (t ->> 'up_to_cents') is null, (t ->> 'up_to_cents')::bigint
     limit 1), 0)
$$;

-- One bundled material line at sell: round(qty × cost × (1 + markup)).
create or replace function pm.fs_material_sell(p_qty numeric, p_cost bigint, p_ladder jsonb) returns bigint
language sql immutable
set search_path = pm, public
as $$
  select pm.fs_rdiv(coalesce(p_qty, 0) * coalesce(p_cost, 0) * (1 + pm.fs_ladder_markup(coalesce(p_cost, 0), p_ladder)) * 10000, 10000)
$$;

-- The service-task formula before rounding rule: hours × rate ÷ (1 − GM) + material sell.
create or replace function pm.fs_service_price(p_hours numeric, p_rate bigint, p_gm numeric, p_material_sell bigint, p_rule text)
returns bigint
language sql immutable
set search_path = pm, public
as $$
  select pm.fs_round_rule(
    pm.fs_rdiv(coalesce(p_hours, 0) * coalesce(p_rate, 0) * 10000, (1 - least(coalesce(p_gm, 0), 0.95)) * 10000)
    + coalesce(p_material_sell, 0), p_rule)
$$;

-- Amortized monthly payment (cents, half-up). apr as a fraction (0.0999); 0 % = amount ÷ months.
create or replace function pm.fs_monthly_payment(p_amount_cents bigint, p_apr numeric, p_months int) returns bigint
language plpgsql immutable
set search_path = pm, public
as $$
declare r18 numeric; f18 numeric := 1000000000000000000; i int; v_num numeric; v_den numeric;
begin
  if p_amount_cents is null or p_amount_cents <= 0 or p_months is null or p_months <= 0 then return 0; end if;
  if coalesce(p_apr, 0) <= 0 then return pm.fs_rdiv(p_amount_cents, p_months); end if;
  -- fixed point at 1e18, half-up at every step: r = apr / 12, f = (1 + r)^n
  r18 := div(2 * round(p_apr * 100000) * 10000000000000 + 12, 24);
  for i in 1 .. least(p_months, 600) loop
    f18 := div(2 * f18 * (1000000000000000000 + r18) + 1000000000000000000, 2000000000000000000);
  end loop;
  v_num := div(2 * p_amount_cents * r18 * f18 + 1000000000000000000000000000000, 2000000000000000000000000000000);
  v_den := div(2 * (f18 - 1000000000000000000) + 1000000000000, 2000000000000);
  if v_den <= 0 then return pm.fs_rdiv(p_amount_cents, p_months); end if;
  return div(2 * v_num + v_den, 2 * v_den)::bigint;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Booking spine (config)
-- ----------------------------------------------------------------------------
create table if not exists pm.business_units (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  code         text not null check (code ~ '^[A-Z][A-Z0-9_]{1,23}$'),
  name         text not null check (char_length(name) between 1 and 80),
  trade        text not null default 'HVAC' check (trade in ('HVAC','PLUMBING','ELECTRICAL','GENERAL','OTHER')),
  kind         text not null default 'SERVICE' check (kind in ('SERVICE','INSTALL','MAINTENANCE','COMMERCIAL','OTHER')),
  books_class  text,                                 -- the Books class / department this BU posts to
  sort         int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.service_zones (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name         text not null check (char_length(name) between 1 and 80),
  zips         text[] not null default '{}',
  color        text,
  sort         int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (cardinality(zips) <= 2000)
);

create table if not exists pm.arrival_windows (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  label           text not null check (char_length(label) between 1 and 40),
  start_time      time not null,
  end_time        time not null,
  days_of_week    smallint[] not null default '{1,2,3,4,5}',
  is_after_hours  boolean not null default false,
  online          boolean not null default true,      -- offered by the online booking widget
  sort            int not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, label),
  unique (org_id, id),
  check (end_time > start_time),
  check (days_of_week <@ array[1,2,3,4,5,6,7]::smallint[])
);

create table if not exists pm.campaigns (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name            text not null check (char_length(name) between 1 and 120),
  channel         text not null default 'OTHER' check (channel in
                    ('LSA','GOOGLE_ADS','SEO','ANGI','THUMBTACK','YELP','FACEBOOK','DIRECT_MAIL','TV','RADIO','REFERRAL',
                     'REPEAT','TGL','WEBSITE','VEHICLE','OTHER')),
  tracking_phone  text,
  utm_source      text,
  utm_campaign    text,
  starts_on       date,
  ends_on         date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index if not exists pm_campaigns_phone_idx on pm.campaigns (org_id, tracking_phone) where tracking_phone is not null;

-- Job types the CSR / widget / agent can book: BU, the pm.job_types key the job is created with,
-- fees (sell prices — public), and the CSR script (questions, fee disclosures, rebuttals).
create table if not exists pm.booking_job_types (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  key                       text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label                     text not null check (char_length(label) between 1 and 80),
  business_unit_id          uuid,
  job_type_key              text,                    -- pm.job_types.key; null = the company's first active one
  work_order_kind           text not null default 'SERVICE' check (work_order_kind in ('SERVICE','MAINTENANCE_VISIT','INSTALL','INSPECTION','MEASURE')),
  default_priority          smallint not null default 3 check (default_priority between 1 and 5),
  estimated_minutes         int not null default 90 check (estimated_minutes between 1 and 1440),
  required_skills           text[] not null default '{}',
  diagnostic_fee_cents      bigint check (diagnostic_fee_cents is null or diagnostic_fee_cents >= 0),
  after_hours_fee_cents     bigint check (after_hours_fee_cents is null or after_hours_fee_cents >= 0),
  member_waives_diagnostic  boolean not null default true,
  is_recall                 boolean not null default false,
  online                    boolean not null default true,
  script                    jsonb not null default '{}' check (jsonb_typeof(script) = 'object'),
  sort                      int not null default 0,
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id),
  foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate
);

-- Jobs (or minutes) per BU × zone × arrival window, per weekday (1 = Monday … 7) or a date.
create table if not exists pm.capacity_limits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  business_unit_id   uuid not null,
  zone_id            uuid,                            -- null = every zone
  arrival_window_id  uuid not null,
  day_of_week        smallint check (day_of_week is null or day_of_week between 1 and 7),
  on_date            date,
  max_jobs           int check (max_jobs is null or max_jobs between 0 and 500),
  max_minutes        int check (max_minutes is null or max_minutes between 0 and 100000),
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  check (day_of_week is null or on_date is null),
  check (max_jobs is not null or max_minutes is not null),
  foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, zone_id) references pm.service_zones (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, arrival_window_id) references pm.arrival_windows (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_capacity_limits_key_uidx on pm.capacity_limits
  (org_id, business_unit_id, coalesce(zone_id, '00000000-0000-0000-0000-000000000000'::uuid), arrival_window_id,
   coalesce(day_of_week, 0), coalesce(on_date, '1900-01-01'::date));

create table if not exists pm.fs_settings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  time_zone             text not null default 'America/Chicago',
  quiet_start           time not null default '20:00',
  quiet_end             time not null default '08:00',
  on_my_way_enabled     boolean not null default true,
  reminders_enabled     boolean not null default true,
  review_url            text,
  review_delay_minutes  int not null default 120 check (review_delay_minutes between 0 and 10080),
  dunning_grace_days    int not null default 7 check (dunning_grace_days between 1 and 90),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, location_id),
  unique (org_id, id)
);

-- Site-level field notes (FS-27 / FS-02 flags); identity stays on core.sites.
create table if not exists pm.site_profiles (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id            uuid references core.locations(id),
  site_id                uuid not null references core.sites(id) on delete cascade,
  customer_id            uuid references core.customers(id),
  gate_code              text,
  pets                   text,
  access_notes           text,
  do_not_service         boolean not null default false,
  do_not_service_reason  text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, site_id),
  unique (org_id, id)
);

-- Online booking widget (public, token-scoped). The clear token is shown once; only its hash is kept.
create table if not exists pm.booking_widgets (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  name                text not null check (char_length(name) between 1 and 80),
  token_hash          text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  campaign_id         uuid,
  job_type_keys       text[] not null default '{}',   -- booking_job_types.key offered (empty = every online one)
  days_ahead          int not null default 14 check (days_ahead between 1 and 60),
  min_lead_hours      int not null default 2 check (min_lead_hours between 0 and 168),
  max_requests_per_day int not null default 30 check (max_requests_per_day between 1 and 5000),
  per_ip_per_hour     int not null default 5 check (per_ip_per_hour between 1 and 1000),
  per_phone_per_day   int not null default 3 check (per_phone_per_day between 1 and 50),
  max_lookups_per_hour int not null default 600 check (max_lookups_per_hour between 1 and 100000),  -- availability, whole widget
  hold_minutes        int not null default 120 check (hold_minutes between 15 and 10080),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (token_hash),
  unique (org_id, id),
  foreign key (org_id, campaign_id) references pm.campaigns (org_id, id) deferrable initially immediate
);

-- Every inbound / outbound call, web request and agent conversation (booked or not).
create table if not exists pm.service_calls (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id                 uuid not null references core.locations(id),
  number                      text,
  channel                     text not null check (channel in ('PHONE','WALK_IN','INTERNAL','WEB','AI_AGENT','SMS','EMAIL','PORTAL','LSA','ANGI','THUMBTACK')),
  status                      text not null default 'OPEN' check (status in ('OPEN','REQUEST','BOOKED','NOT_BOOKED','CANCELLED')),
  caller_phone                text,
  caller_name                 text,
  caller_email                text,
  customer_id                 uuid references core.customers(id),
  site_id                     uuid references core.sites(id),
  site_zip                    text,
  site_address                text,
  booking_job_type_id         uuid,
  business_unit_id            uuid,
  campaign_id                 uuid,
  zone_id                     uuid,
  arrival_window_id           uuid,
  service_day                 date,
  estimated_minutes           int,
  priority                    smallint check (priority is null or priority between 1 and 5),
  summary                     text check (summary is null or char_length(summary) <= 500),
  tags                        text[] not null default '{}',
  script_answers              jsonb not null default '{}' check (jsonb_typeof(script_answers) = 'object'),
  disclosures_ack             text[] not null default '{}',
  not_booked_reason           text,
  job_id                      uuid,
  work_order_id               uuid,
  duplicate_of_work_order_id  uuid,
  capacity_override           boolean not null default false,
  override_reason             text,
  widget_id                   uuid,
  hold_expires_at             timestamptz,                -- a web REQUEST stops holding capacity after this
  source_ref                  text,
  booked_by                   text,
  booked_at                   timestamptz,
  created_by                  text default pm.current_user_id(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  unique (org_id, source_ref),
  check (status <> 'BOOKED' or (job_id is not null and work_order_id is not null)),
  check (status <> 'REQUEST' or (arrival_window_id is not null and service_day is not null and business_unit_id is not null)),
  check (not capacity_override or override_reason is not null),
  foreign key (org_id, booking_job_type_id) references pm.booking_job_types (org_id, id) deferrable initially immediate,
  foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate,
  foreign key (org_id, campaign_id) references pm.campaigns (org_id, id) deferrable initially immediate,
  foreign key (org_id, zone_id) references pm.service_zones (org_id, id) deferrable initially immediate,
  foreign key (org_id, arrival_window_id) references pm.arrival_windows (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, work_order_id) references pm.work_orders (org_id, id) deferrable initially immediate,
  foreign key (org_id, widget_id) references pm.booking_widgets (org_id, id) deferrable initially immediate
);
create index if not exists pm_service_calls_loc_idx on pm.service_calls (org_id, location_id, created_at desc);
create index if not exists pm_service_calls_hold_idx on pm.service_calls (org_id, business_unit_id, arrival_window_id, service_day)
  where status = 'REQUEST';
create index if not exists pm_service_calls_phone_idx on pm.service_calls (org_id, caller_phone) where caller_phone is not null;

-- work orders: booking dimensions (written only by the booking RPCs)
alter table pm.work_orders add column if not exists business_unit_id  uuid;
alter table pm.work_orders add column if not exists campaign_id       uuid;
alter table pm.work_orders add column if not exists zone_id           uuid;
alter table pm.work_orders add column if not exists arrival_window_id uuid;
alter table pm.work_orders add column if not exists service_day       date;
alter table pm.work_orders add column if not exists booking_channel   text;
alter table pm.work_orders add column if not exists call_id           uuid;
alter table pm.work_orders add column if not exists site_id           uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'work_orders_fs_bu_fk' and conrelid = 'pm.work_orders'::regclass) then
    alter table pm.work_orders add constraint work_orders_fs_bu_fk foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_campaign_fk foreign key (org_id, campaign_id) references pm.campaigns (org_id, id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_zone_fk foreign key (org_id, zone_id) references pm.service_zones (org_id, id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_window_fk foreign key (org_id, arrival_window_id) references pm.arrival_windows (org_id, id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_call_fk foreign key (org_id, call_id) references pm.service_calls (org_id, id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_site_fk foreign key (site_id) references core.sites (id) deferrable initially immediate;
    alter table pm.work_orders add constraint work_orders_fs_channel_chk check (booking_channel is null or booking_channel in
      ('PHONE','WALK_IN','INTERNAL','WEB','AI_AGENT','SMS','EMAIL','PORTAL','LSA','ANGI','THUMBTACK','AGREEMENT'));
  end if;
end $$;
create index if not exists pm_work_orders_capacity_idx on pm.work_orders (org_id, business_unit_id, arrival_window_id, service_day)
  where service_day is not null and status <> 'CANCELLED';
create index if not exists pm_work_orders_site_idx on pm.work_orders (org_id, site_id) where site_id is not null;

-- ----------------------------------------------------------------------------
-- 2. Dispatch depth
-- ----------------------------------------------------------------------------
create table if not exists pm.tech_profiles (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  employee_id         uuid not null references core.employees(id) on delete cascade,
  display_name        text,                      -- the name customers see in texts
  photo_url           text,
  home_zone_id        uuid,
  zone_ids            uuid[] not null default '{}',
  business_unit_ids   uuid[] not null default '{}',
  is_dispatchable     boolean not null default true,
  is_comfort_advisor  boolean not null default false,
  sort                int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, employee_id),
  unique (org_id, id),
  foreign key (org_id, home_zone_id) references pm.service_zones (org_id, id) deferrable initially immediate
);

create table if not exists pm.tech_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  employee_id  uuid not null references core.employees(id) on delete cascade,
  kind         text not null check (kind in ('PTO','TRAINING','MEETING','SHOP','SUPPLY_HOUSE','OTHER')),
  slot         tstzrange not null check (not isempty(slot) and not lower_inf(slot) and not upper_inf(slot)),
  note         text,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  constraint tech_events_no_overlap exclude using gist (org_id with =, employee_id with =, slot with &&)
);
create index if not exists pm_tech_events_emp_idx on pm.tech_events (org_id, employee_id, lower(slot));

create table if not exists pm.on_call_shifts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  business_unit_id  uuid,
  employee_id       uuid not null references core.employees(id) on delete cascade,
  role              text not null default 'PRIMARY' check (role in ('PRIMARY','BACKUP')),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  check (ends_at > starts_at),
  foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate
);
create index if not exists pm_on_call_idx on pm.on_call_shifts (org_id, location_id, starts_at);

-- Customer text / email outbox (delivery = the notifications service).
create table if not exists pm.fs_messages (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  kind              text not null check (kind in ('ON_MY_WAY','REMINDER_24H','REMINDER_2H','CONFIRMATION','REVIEW_REQUEST','DUNNING','FOLLOW_UP','OTHER')),
  channel           text not null default 'SMS' check (channel in ('SMS','EMAIL')),
  customer_id       uuid references core.customers(id),
  contact_id        uuid references core.contacts(id),
  to_address        text,
  work_order_id     uuid,
  agreement_id      uuid,
  body              text not null check (char_length(body) between 1 and 1600),
  status            text not null default 'QUEUED' check (status in ('QUEUED','SUPPRESSED','SENT','FAILED','CANCELLED')),
  suppressed_reason text check (suppressed_reason is null or suppressed_reason in ('NO_CONTACT','NO_CONSENT','OPTED_OUT','DISABLED')),
  send_after        timestamptz not null default now(),
  eta_token         text,
  dedupe_key        text not null,
  sent_at           timestamptz,
  error_text        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, dedupe_key),
  unique (org_id, id),
  foreign key (org_id, work_order_id) references pm.work_orders (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_fs_messages_queue_idx on pm.fs_messages (org_id, status, send_after) where status = 'QUEUED';

-- ----------------------------------------------------------------------------
-- 3. Flat-rate price book
-- ----------------------------------------------------------------------------
create table if not exists pm.pricebook_categories (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name         text not null check (char_length(name) between 1 and 80),
  parent_id    uuid,
  trade        text check (trade is null or trade in ('HVAC','PLUMBING','ELECTRICAL','GENERAL','OTHER')),
  sort         int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (parent_id is null or parent_id <> id),
  foreign key (org_id, parent_id) references pm.pricebook_categories (org_id, id) deferrable initially immediate
);

create table if not exists pm.pricebook_settings (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  burdened_rate_cents     bigint not null default 9500 check (burdened_rate_cents between 0 and 10000000),
  target_gm_pct           numeric(5,4) not null default 0.55 check (target_gm_pct >= 0 and target_gm_pct < 0.95),
  equipment_gm_pct        numeric(5,4) not null default 0.35 check (equipment_gm_pct >= 0 and equipment_gm_pct < 0.95),
  member_discount_pct     numeric(5,4) not null default 0.15 check (member_discount_pct >= 0 and member_discount_pct <= 0.9),
  after_hours_multiplier  numeric(4,2) not null default 1.50 check (after_hours_multiplier between 1 and 5),
  rounding                text not null default 'NINE' check (rounding in ('NONE','WHOLE','FIVE','NINE')),
  price_floor_gm_pct      numeric(5,4) not null default 0.40 check (price_floor_gm_pct >= 0 and price_floor_gm_pct < 0.95),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, location_id),
  unique (org_id, id)
);

create table if not exists pm.pricebook_markup_tiers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  up_to_cents  bigint check (up_to_cents is null or up_to_cents > 0),     -- null = everything above
  markup_pct   numeric(6,4) not null check (markup_pct >= 0 and markup_pct <= 20),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id)
);
create unique index if not exists pm_markup_tiers_uidx on pm.pricebook_markup_tiers (org_id, location_id, coalesce(up_to_cents, 0));

alter table pm.price_book_items add column if not exists kind                  text not null default 'SERVICE';
alter table pm.price_book_items add column if not exists category_id           uuid;
alter table pm.price_book_items add column if not exists business_unit_id      uuid;
alter table pm.price_book_items add column if not exists task_hours            numeric(8,2);
alter table pm.price_book_items add column if not exists target_gm_pct         numeric(5,4);
alter table pm.price_book_items add column if not exists price_locked          boolean not null default false;
alter table pm.price_book_items add column if not exists member_price_cents    bigint;
alter table pm.price_book_items add column if not exists after_hours_price_cents bigint;
alter table pm.price_book_items add column if not exists material_cost_cents   bigint;
alter table pm.price_book_items add column if not exists labor_cost_cents      bigint;
alter table pm.price_book_items add column if not exists customer_description  text;
alter table pm.price_book_items add column if not exists image_url             text;
alter table pm.price_book_items add column if not exists upsell_codes          text[] not null default '{}';
alter table pm.price_book_items add column if not exists gbb_tier              text;
alter table pm.price_book_items add column if not exists is_taxable            boolean not null default true;
alter table pm.price_book_items add column if not exists warranty_note         text;
alter table pm.price_book_items add column if not exists priced_at             timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'price_book_items_fs_kind_chk' and conrelid = 'pm.price_book_items'::regclass) then
    alter table pm.price_book_items add constraint price_book_items_fs_kind_chk check (kind in ('SERVICE','MATERIAL','EQUIPMENT','FEE','MEMBERSHIP'));
    alter table pm.price_book_items add constraint price_book_items_fs_hours_chk check (task_hours is null or (task_hours >= 0 and task_hours <= 999));
    alter table pm.price_book_items add constraint price_book_items_fs_gm_chk check (target_gm_pct is null or (target_gm_pct >= 0 and target_gm_pct < 0.95));
    alter table pm.price_book_items add constraint price_book_items_fs_prices_chk check ((member_price_cents is null or member_price_cents >= 0)
      and (after_hours_price_cents is null or after_hours_price_cents >= 0) and (material_cost_cents is null or material_cost_cents >= 0)
      and (labor_cost_cents is null or labor_cost_cents >= 0));
    alter table pm.price_book_items add constraint price_book_items_fs_tier_chk check (gbb_tier is null or gbb_tier in ('GOOD','BETTER','BEST'));
    alter table pm.price_book_items add constraint price_book_items_fs_cat_fk foreign key (org_id, category_id) references pm.pricebook_categories (org_id, id) deferrable initially immediate;
    alter table pm.price_book_items add constraint price_book_items_fs_bu_fk foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_book_items_org_id_key' and conrelid = 'pm.price_book_items'::regclass)
     and not exists (select 1 from pg_indexes where schemaname = 'pm' and indexname = 'pm_price_book_items_org_id_uidx') then
    create unique index pm_price_book_items_org_id_uidx on pm.price_book_items (org_id, id);
  end if;
end $$;

create table if not exists pm.pricebook_service_materials (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  service_item_id   uuid not null references pm.price_book_items(id) on delete cascade,
  material_item_id  uuid not null references pm.price_book_items(id) on delete cascade,
  qty               numeric(10,3) not null default 1 check (qty > 0 and qty <= 100000),
  created_at        timestamptz not null default now(),
  unique (service_item_id, material_item_id),
  unique (org_id, id),
  check (service_item_id <> material_item_id)
);

create table if not exists pm.financing_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  provider        text not null check (provider in ('GREENSKY','SYNCHRONY','SERVICE_FINANCE','WELLS_FARGO','FOUNDATION','OTHER')),
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name            text not null check (char_length(name) between 1 and 120),
  apr             numeric(6,5) not null default 0 check (apr >= 0 and apr < 1),
  term_months     int not null check (term_months between 1 and 240),
  promo           text,
  dealer_fee_pct  numeric(5,4) not null default 0 check (dealer_fee_pct >= 0 and dealer_fee_pct < 1),
  min_cents       bigint not null default 0 check (min_cents >= 0),
  max_cents       bigint check (max_cents is null or max_cents >= min_cents),
  is_default      boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

-- ----------------------------------------------------------------------------
-- 4. Good / better / best
-- ----------------------------------------------------------------------------
create table if not exists pm.fs_estimates (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  job_id                   uuid not null,
  work_order_id            uuid,
  number                   text,
  title                    text not null check (char_length(title) between 1 and 160),
  status                   text not null default 'DRAFT' check (status in ('DRAFT','PRESENTED','SOLD','DECLINED','EXPIRED')),
  customer_id              uuid references core.customers(id),
  member_pricing           boolean not null default false,
  sold_option_ids          uuid[] not null default '{}',
  signed_name              text,
  signature_document_id    uuid,
  signed_at                timestamptz,
  deposit_cents            bigint not null default 0 check (deposit_cents >= 0),
  deposit_ref              text,
  deposit_request_id       uuid,
  financing_plan_id        uuid,
  agreement_id             uuid,
  sold_by_employee_id      uuid references core.employees(id),
  decline_reason           text,
  presented_at             timestamptz,
  sold_at                  timestamptz,
  valid_until              date,
  created_by               text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check (status <> 'SOLD' or (sold_at is not null and signed_name is not null and cardinality(sold_option_ids) > 0)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, financing_plan_id) references pm.financing_plans (org_id, id) deferrable initially immediate,
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_estimates_wo_idx on pm.fs_estimates (org_id, work_order_id);
create index if not exists pm_fs_estimates_cust_idx on pm.fs_estimates (org_id, customer_id, status);

create table if not exists pm.fs_estimate_options (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  estimate_id        uuid not null,
  tier               text not null default 'OPTION' check (tier in ('GOOD','BETTER','BEST','OPTION')),
  sort               int not null default 0,
  name               text not null check (char_length(name) between 1 and 120),
  description        text,
  image_url          text,
  rebate_cents       bigint not null default 0 check (rebate_cents >= 0),
  rebate_note        text,
  financing_plan_id  uuid,
  recommended        boolean not null default false,
  status             text not null default 'OPEN' check (status in ('OPEN','SOLD','DISMISSED')),
  dismiss_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, financing_plan_id) references pm.financing_plans (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_options_est_idx on pm.fs_estimate_options (org_id, estimate_id, sort);

create table if not exists pm.fs_estimate_option_items (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                   uuid not null,
  option_id                uuid not null,
  sort                     int not null default 0,
  price_book_item_id       uuid references pm.price_book_items(id),
  kind                     text not null default 'SERVICE' check (kind in ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT')),
  description              text not null check (char_length(description) between 1 and 300),
  qty                      numeric(14,4) not null default 1 check (qty > 0),
  unit_price_cents         bigint not null default 0 check (unit_price_cents >= 0),
  member_unit_price_cents  bigint check (member_unit_price_cents is null or member_unit_price_cents >= 0),
  unit_cost_cents          bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  is_optional              boolean not null default false,
  is_selected              boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, option_id) references pm.fs_estimate_options (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_fs_option_items_opt_idx on pm.fs_estimate_option_items (org_id, option_id, sort);

alter table pm.work_order_lines add column if not exists sold_by_employee_id      uuid references core.employees(id);
alter table pm.work_order_lines add column if not exists performed_by_employee_id uuid references core.employees(id);
alter table pm.work_order_lines add column if not exists fs_option_item_id        uuid;

-- ----------------------------------------------------------------------------
-- 5. Agreements end to end
-- ----------------------------------------------------------------------------
create table if not exists pm.agreement_templates (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  key                     text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label                   text not null default 'MEMBERSHIP' check (label in ('MEMBERSHIP','MAINTENANCE_AGREEMENT')),
  plan_name               text not null check (char_length(plan_name) between 1 and 120),
  tier                    text,
  term_months             int not null default 12 check (term_months between 1 and 60),
  cadence                 text not null default 'SEMIANNUAL' check (cadence in ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL','CUSTOM')),
  interval_months         int check (interval_months is null or interval_months between 1 and 60),
  visits_per_term         int not null default 2 check (visits_per_term between 0 and 120),
  visit_minutes           int not null default 60 check (visit_minutes > 0),
  visit_window_days       int not null default 30 check (visit_window_days between 1 and 366),
  seasons                 text[] not null default '{}',              -- e.g. {SPRING,FALL}
  required_skills         text[] not null default '{}',
  price_cents             bigint not null default 0 check (price_cents >= 0),   -- per billing period
  billing_frequency       text not null default 'MONTHLY' check (billing_frequency in ('UPFRONT','MONTHLY','QUARTERLY','ANNUAL')),
  member_discount_pct     numeric(5,4) not null default 0.15 check (member_discount_pct >= 0 and member_discount_pct <= 1),
  perks                   jsonb not null default '{}' check (jsonb_typeof(perks) = 'object'),   -- priority, waive_diagnostic, no_overtime
  covered_equipment_types text[] not null default '{}',
  revenue_policy          text not null default 'PER_VISIT' check (revenue_policy in ('PER_VISIT','STRAIGHT_LINE')),
  auto_renew              boolean not null default true,
  renewal_uplift_pct      numeric(5,4) not null default 0 check (renewal_uplift_pct >= 0 and renewal_uplift_pct <= 1),
  suspend_after_failures  int not null default 3 check (suspend_after_failures between 1 and 12),
  job_type_key            text,
  business_unit_id        uuid,
  is_active               boolean not null default true,
  sort                    int not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, location_id, key),
  unique (org_id, id),
  check (cadence <> 'CUSTOM' or interval_months is not null),
  foreign key (org_id, business_unit_id) references pm.business_units (org_id, id) deferrable initially immediate
);

alter table pm.service_agreements add column if not exists template_id            uuid;
alter table pm.service_agreements add column if not exists revenue_policy         text not null default 'PER_VISIT';
alter table pm.service_agreements add column if not exists visits_included        int;
alter table pm.service_agreements add column if not exists site_id                uuid;
alter table pm.service_agreements add column if not exists entitlements_suspended boolean not null default false;
alter table pm.service_agreements add column if not exists failed_payment_count   int not null default 0;
alter table pm.service_agreements add column if not exists payment_method_label   text;
alter table pm.service_agreements add column if not exists import_ref             text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'service_agreements_fs_policy_chk' and conrelid = 'pm.service_agreements'::regclass) then
    alter table pm.service_agreements add constraint service_agreements_fs_policy_chk check (revenue_policy in ('PER_VISIT','STRAIGHT_LINE'));
    alter table pm.service_agreements add constraint service_agreements_fs_template_fk foreign key (org_id, template_id) references pm.agreement_templates (org_id, id) deferrable initially immediate;
    alter table pm.service_agreements add constraint service_agreements_fs_site_fk foreign key (site_id) references core.sites (id) deferrable initially immediate;
    alter table pm.service_agreements add constraint service_agreements_fs_counts_chk check (failed_payment_count >= 0 and (visits_included is null or visits_included >= 0));
  end if;
end $$;
create unique index if not exists pm_service_agreements_import_uidx on pm.service_agreements (org_id, import_ref) where import_ref is not null;

create table if not exists pm.agreement_billing_schedule (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  agreement_id        uuid not null,
  period_no           int not null check (period_no >= 1),
  period_start        date not null,
  period_end          date not null,
  bill_on             date not null,
  amount_cents        bigint not null check (amount_cents >= 0),
  billing_request_id  uuid,
  status              text not null default 'SCHEDULED' check (status in ('SCHEDULED','REQUESTED','PAID','FAILED','VOID')),
  attempts            int not null default 0 check (attempts >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, agreement_id, period_no),
  unique (org_id, id),
  check (period_end >= period_start),
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) deferrable initially immediate
);
create index if not exists pm_agr_billing_due_idx on pm.agreement_billing_schedule (org_id, bill_on) where status = 'SCHEDULED';

create table if not exists pm.agreement_revenue_facts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  agreement_id        uuid not null,
  kind                text not null check (kind in ('BILLED','VISIT_DELIVERED','STRAIGHT_LINE','CANCEL_REFUND','BREAKAGE','OPENING_BALANCE')),
  occurred_on         date not null default current_date,
  amount_cents        bigint not null,
  visits_delivered    int not null default 0,
  work_order_id       uuid,
  billing_request_id  uuid,
  source_ref          text not null,
  status              text not null default 'PENDING' check (status in ('PENDING','SENT','ACKED','REJECTED')),
  event_id            uuid,
  created_at          timestamptz not null default now(),
  unique (org_id, source_ref),
  unique (org_id, id),
  foreign key (org_id, agreement_id) references pm.service_agreements (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_agr_rev_idx on pm.agreement_revenue_facts (org_id, agreement_id, occurred_on);

create table if not exists pm.agreement_imports (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  source_system     text not null default 'CSV' check (source_system in ('FIELDEDGE','SIMPRO','SERVICETITAN','HOUSECALL_PRO','JOBBER','CSV')),
  dry_run           boolean not null,
  row_count         int not null default 0,
  ok_count          int not null default 0,
  error_count       int not null default 0,
  deferred_cents    bigint not null default 0,
  visits_owed       int not null default 0,
  report            jsonb not null default '{}' check (jsonb_typeof(report) = 'object'),
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  unique (org_id, id)
);

-- ----------------------------------------------------------------------------
-- 6. Installed equipment
-- ----------------------------------------------------------------------------
alter table pm.assets add column if not exists equipment_type          text;
alter table pm.assets add column if not exists tonnage                 numeric(5,2);
alter table pm.assets add column if not exists btu                     int;
alter table pm.assets add column if not exists seer2                   numeric(5,2);
alter table pm.assets add column if not exists hspf2                   numeric(5,2);
alter table pm.assets add column if not exists afue                    numeric(5,2);
alter table pm.assets add column if not exists refrigerant_type        text;
alter table pm.assets add column if not exists refrigerant_charge_oz   numeric(8,2);
alter table pm.assets add column if not exists fuel_type               text;
alter table pm.assets add column if not exists voltage                 int;
alter table pm.assets add column if not exists phase                   smallint;
alter table pm.assets add column if not exists manufactured_on         date;
alter table pm.assets add column if not exists installer_employee_id   uuid references core.employees(id);
alter table pm.assets add column if not exists install_work_order_id   uuid;
alter table pm.assets add column if not exists parts_warranty_ends_on  date;
alter table pm.assets add column if not exists labor_warranty_ends_on  date;
alter table pm.assets add column if not exists registration_status     text not null default 'NOT_REQUIRED';
alter table pm.assets add column if not exists registration_deadline   date;
alter table pm.assets add column if not exists registration_ref        text;
alter table pm.assets add column if not exists qr_code                 text;
alter table pm.assets add column if not exists nameplate_document_id   uuid;
alter table pm.assets add column if not exists site_id                 uuid;
alter table pm.assets add column if not exists location_label          text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_fs_reg_chk' and conrelid = 'pm.assets'::regclass) then
    alter table pm.assets add constraint assets_fs_reg_chk check (registration_status in ('NOT_REQUIRED','PENDING','REGISTERED','MISSED'));
    alter table pm.assets add constraint assets_fs_specs_chk check ((tonnage is null or tonnage between 0 and 500) and (btu is null or btu between 0 and 100000000)
      and (seer2 is null or seer2 between 0 and 60) and (hspf2 is null or hspf2 between 0 and 30) and (afue is null or afue between 0 and 100)
      and (refrigerant_charge_oz is null or refrigerant_charge_oz between 0 and 100000) and (phase is null or phase in (1,3))
      and (voltage is null or voltage between 0 and 100000));
    alter table pm.assets add constraint assets_fs_type_chk check (equipment_type is null or equipment_type in
      ('AC_CONDENSER','HEAT_PUMP','FURNACE','AIR_HANDLER','COIL','BOILER','MINI_SPLIT','PACKAGE_UNIT','THERMOSTAT','WATER_HEATER',
       'TANKLESS_WATER_HEATER','WATER_SOFTENER','SUMP_PUMP','SEWER_LINE','PANEL','GENERATOR','EV_CHARGER','IAQ','OTHER'));
    alter table pm.assets add constraint assets_fs_fuel_chk check (fuel_type is null or fuel_type in ('GAS','PROPANE','ELECTRIC','OIL','DUAL','OTHER'));
    alter table pm.assets add constraint assets_fs_site_fk foreign key (site_id) references core.sites (id) deferrable initially immediate;
    alter table pm.assets add constraint assets_fs_install_wo_fk foreign key (org_id, install_work_order_id) references pm.work_orders (org_id, id) deferrable initially immediate;
  end if;
end $$;
create unique index if not exists pm_assets_qr_uidx on pm.assets (org_id, qr_code) where qr_code is not null;
create index if not exists pm_assets_reg_idx on pm.assets (org_id, registration_deadline) where registration_status = 'PENDING';

-- ----------------------------------------------------------------------------
-- 7. Scorecards + performance pay inputs
-- ----------------------------------------------------------------------------
create table if not exists pm.fs_pay_plans (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  name                     text not null check (char_length(name) between 1 and 80),
  commission_basis         text not null default 'COMPLETED' check (commission_basis in ('SOLD','COMPLETED','PAID')),
  commission_pct           numeric(5,4) not null default 0 check (commission_pct >= 0 and commission_pct <= 1),
  tgl_bonus_cents          bigint not null default 0 check (tgl_bonus_cents >= 0),
  tgl_bonus_pct            numeric(5,4) not null default 0 check (tgl_bonus_pct >= 0 and tgl_bonus_pct <= 1),
  membership_spiff_cents   bigint not null default 0 check (membership_spiff_cents >= 0),
  recall_chargeback_pct    numeric(5,4) not null default 0 check (recall_chargeback_pct >= 0 and recall_chargeback_pct <= 1),
  spiffs                   jsonb not null default '[]' check (jsonb_typeof(spiffs) = 'array'),   -- [{code, cents}]
  sold_split_pct           numeric(5,4) not null default 0.5 check (sold_split_pct >= 0 and sold_split_pct <= 1),
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, location_id, name),
  unique (org_id, id)
);

create table if not exists pm.fs_pay_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  employee_id  uuid not null references core.employees(id) on delete cascade,
  pay_plan_id  uuid not null,
  starts_on    date not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, employee_id),
  unique (org_id, id),
  foreign key (org_id, pay_plan_id) references pm.fs_pay_plans (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.fs_tgl_leads (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid not null,
  work_order_id        uuid not null,
  set_by_employee_id   uuid not null references core.employees(id),
  asset_id             uuid,
  reason               text not null check (char_length(reason) between 1 and 500),
  interest             text not null default 'MEDIUM' check (interest in ('LOW','MEDIUM','HIGH')),
  status               text not null default 'OPEN' check (status in ('OPEN','APPOINTMENT','SOLD','LOST')),
  estimate_id          uuid,
  sold_cents           bigint check (sold_cents is null or sold_cents >= 0),
  lost_reason          text,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.fs_estimates (org_id, id) deferrable initially immediate
);

create table if not exists pm.fs_review_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  work_order_id   uuid not null,
  job_id          uuid not null,
  employee_id     uuid references core.employees(id),
  customer_id     uuid references core.customers(id),
  message_id      uuid,
  status          text not null default 'QUEUED' check (status in ('QUEUED','SENT','SUPPRESSED','REVIEWED')),
  rating          smallint check (rating is null or rating between 1 and 5),
  review_text     text,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, work_order_id),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- 8. Triggers (touch / created_by / company / reference integrity)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['business_units','service_zones','arrival_windows','campaigns','booking_job_types','capacity_limits',
    'fs_settings','site_profiles','booking_widgets','service_calls','tech_profiles','tech_events','on_call_shifts','fs_messages',
    'pricebook_categories','pricebook_settings','pricebook_markup_tiers','financing_plans','fs_estimates','fs_estimate_options',
    'fs_estimate_option_items','agreement_templates','agreement_billing_schedule','fs_pay_plans','fs_pay_assignments','fs_tgl_leads',
    'fs_review_requests'] loop
    execute format('create or replace trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['service_calls','tech_events','fs_estimates','fs_tgl_leads'] loop
    execute format('create or replace trigger trg_stamp_created_by before insert or update on pm.%I for each row execute function pm.tg_stamp_created_by()', t);
  end loop;
  foreach t in array array['business_units','service_zones','arrival_windows','campaigns','booking_job_types','capacity_limits',
    'fs_settings','booking_widgets','service_calls','tech_profiles','tech_events','on_call_shifts','fs_messages','pricebook_categories',
    'pricebook_settings','pricebook_markup_tiers','financing_plans','agreement_templates','agreement_revenue_facts','agreement_imports',
    'fs_pay_plans','fs_pay_assignments','fs_tgl_leads','fs_review_requests'] loop
    execute format('create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
end $$;

-- Company-scoped references on the booking-spine rows must be on the row's company.
create or replace function pm.tg_fs_same_company() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a text; v_col text; v_tbl text; v_id uuid; v_loc uuid; j jsonb := to_jsonb(new); v_row_loc uuid;
begin
  v_row_loc := nullif(j ->> 'location_id', '')::uuid;
  foreach a in array tg_argv loop
    v_col := split_part(a, ':', 1);
    v_tbl := split_part(a, ':', 2);
    if v_tbl not in ('business_units','service_zones','arrival_windows','campaigns','booking_job_types','pricebook_categories','financing_plans','agreement_templates') then
      raise exception 'PM_REF_TABLE_NOT_ALLOWED: %', v_tbl using errcode = '22023';
    end if;
    v_id := nullif(j ->> v_col, '')::uuid;
    continue when v_id is null;
    execute format('select location_id from pm.%I where id = $1 and org_id = $2', v_tbl) into v_loc using v_id, new.org_id;
    if v_loc is null then
      raise exception 'PM_REF_ORG_MISMATCH: % % is not in org', v_col, v_id using errcode = '23503';
    end if;
    if v_row_loc is not null and v_loc <> v_row_loc then
      raise exception 'PM_FS_COMPANY_MISMATCH: % belongs to another company', v_col using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

create or replace trigger trg_fs_same_company before insert or update on pm.booking_job_types
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units');
create or replace trigger trg_fs_same_company before insert or update on pm.capacity_limits
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units', 'zone_id:service_zones', 'arrival_window_id:arrival_windows');
create or replace trigger trg_fs_same_company before insert or update on pm.service_calls
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units', 'zone_id:service_zones', 'arrival_window_id:arrival_windows',
                                                      'campaign_id:campaigns', 'booking_job_type_id:booking_job_types');
create or replace trigger trg_fs_same_company before insert or update of business_unit_id, zone_id, arrival_window_id, campaign_id on pm.work_orders
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units', 'zone_id:service_zones', 'arrival_window_id:arrival_windows', 'campaign_id:campaigns');
create or replace trigger trg_fs_same_company before insert or update of category_id, business_unit_id on pm.price_book_items
  for each row execute function pm.tg_fs_same_company('category_id:pricebook_categories', 'business_unit_id:business_units');
create or replace trigger trg_fs_same_company before insert or update on pm.on_call_shifts
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units');
create or replace trigger trg_fs_same_company before insert or update on pm.agreement_templates
  for each row execute function pm.tg_fs_same_company('business_unit_id:business_units');
create or replace trigger trg_fs_same_company before insert or update on pm.booking_widgets
  for each row execute function pm.tg_fs_same_company('campaign_id:campaigns');
create or replace trigger trg_fs_same_company before insert or update of template_id on pm.service_agreements
  for each row execute function pm.tg_fs_same_company('template_id:agreement_templates');

create or replace trigger trg_refs_in_org before insert or update on pm.tech_profiles
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.tech_events
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.on_call_shifts
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.fs_pay_assignments
  for each row execute function pm.tg_refs_in_org('employee_id:core.employees');
create or replace trigger trg_refs_in_org before insert or update on pm.site_profiles
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers');
create or replace trigger trg_refs_in_org before insert or update on pm.service_calls
  for each row execute function pm.tg_refs_in_org('customer_id:core.customers');

-- Sites are org-scoped core rows (core.sites): the profile's site must be in the row's org.
create or replace function pm.tg_fs_site_in_org() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.site_id is not null and not exists (select 1 from core.sites s where s.id = new.site_id and s.org_id = new.org_id) then
    raise exception 'PM_REF_ORG_MISMATCH: site % is not in org', new.site_id using errcode = '23503';
  end if;
  return new;
end $$;
create or replace trigger trg_fs_site_in_org before insert or update of site_id on pm.site_profiles for each row execute function pm.tg_fs_site_in_org();
create or replace trigger trg_fs_site_in_org before insert or update of site_id on pm.service_calls for each row execute function pm.tg_fs_site_in_org();
create or replace trigger trg_fs_site_in_org before insert or update of site_id on pm.work_orders for each row execute function pm.tg_fs_site_in_org();
create or replace trigger trg_fs_site_in_org before insert or update of site_id on pm.assets for each row execute function pm.tg_fs_site_in_org();
create or replace trigger trg_fs_site_in_org before insert or update of site_id on pm.service_agreements for each row execute function pm.tg_fs_site_in_org();

-- Job-scoped GBB rows take their company from the job.
create or replace trigger trg_job_location before insert or update of job_id, location_id, org_id on pm.fs_estimates
  for each row execute function pm.tg_job_location();
create or replace trigger trg_job_location before insert or update of job_id, location_id, org_id on pm.fs_tgl_leads
  for each row execute function pm.tg_job_location();
create or replace trigger trg_job_location before insert or update of job_id, location_id, org_id on pm.agreement_revenue_facts
  for each row execute function pm.tg_job_location();
create or replace trigger trg_job_location before insert or update of job_id, location_id, org_id on pm.fs_review_requests
  for each row execute function pm.tg_job_location();

create or replace function pm.tg_fs_number() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_period text := to_char(current_date, 'YYYY'); v_kind text := tg_argv[0];
begin
  if new.number is null or btrim(new.number) = '' then
    new.number := pm.fmt_doc_number(v_kind, v_period, pm.next_doc_number(new.org_id, 'org', v_kind, v_period));
  end if;
  return new;
end $$;
create or replace trigger trg_fs_number before insert on pm.service_calls for each row execute function pm.tg_fs_number('CALL');
create or replace trigger trg_fs_number before insert on pm.fs_estimates for each row execute function pm.tg_fs_number('OPT');

-- A dispatch assignment never overlaps the technician's PTO / training / meeting block (FS-18).
create or replace function pm.tg_fs_assignment_vs_events() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_kind text;
begin
  if new.status = 'CANCELLED' or new.employee_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.slot = old.slot and new.employee_id is not distinct from old.employee_id and old.status <> 'CANCELLED' then
    return new;
  end if;
  select e.kind into v_kind from pm.tech_events e
   where e.org_id = new.org_id and e.employee_id = new.employee_id and e.slot && new.slot limit 1;
  if v_kind is not null then
    raise exception 'PM_FS_TECH_UNAVAILABLE: the technician has a % block in that window', lower(v_kind) using errcode = '22023';
  end if;
  return new;
end $$;
create or replace trigger trg_fs_assignment_vs_events before insert or update of slot, employee_id, status on pm.dispatch_assignments
  for each row execute function pm.tg_fs_assignment_vs_events();

-- An INSTALL work order cannot close while an asset it installed waits for OEM registration (FS-75).
create or replace function pm.tg_fs_wo_close_registration() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_serial text;
begin
  if new.status = 'CLOSED' and old.status <> 'CLOSED' then
    select coalesce(a.serial_number, a.model, 'equipment') into v_serial from pm.assets a
     where a.org_id = new.org_id and a.install_work_order_id = new.id and a.registration_status = 'PENDING' limit 1;
    if v_serial is not null then
      raise exception 'PM_FS_WARRANTY_REGISTRATION: register % with the manufacturer before closing %', v_serial, new.number using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create or replace trigger trg_fs_wo_close_registration before update of status on pm.work_orders
  for each row execute function pm.tg_fs_wo_close_registration();

-- Equipment: a registration deadline defaults to 60 days after install when registration is required.
create or replace function pm.tg_fs_asset_registration() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if new.registration_status = 'PENDING' and new.registration_deadline is null then
    new.registration_deadline := coalesce(new.installed_on, current_date) + 60;
  end if;
  if new.registration_status = 'REGISTERED' then new.registered_on := coalesce(new.registered_on, current_date); end if;
  return new;
end $$;
create or replace trigger trg_fs_asset_registration before insert or update of registration_status, installed_on on pm.assets
  for each row execute function pm.tg_fs_asset_registration();

-- ----------------------------------------------------------------------------
-- 9. Messages: consent, STOP list, quiet hours (FS-13 / FS-17 / FS-22)
-- ----------------------------------------------------------------------------
-- Queue one message (idempotent on dedupe_key). Internal: called by triggers and RPCs.
create or replace function pm._fs_queue_message(
  p_org uuid, p_location uuid, p_kind text, p_customer uuid, p_work_order uuid, p_agreement uuid, p_body text,
  p_dedupe text, p_send_after timestamptz default null, p_channel text default 'SMS'
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_id uuid; c record; v_addr text; v_status text := 'QUEUED'; v_reason text; s pm.fs_settings%rowtype;
  v_after timestamptz := coalesce(p_send_after, now()); v_local time; v_token text;
begin
  select * into v_id from (select m.id from pm.fs_messages m where m.org_id = p_org and m.dedupe_key = p_dedupe) x;
  if v_id is not null then return v_id; end if;
  select * into s from pm.fs_settings x where x.org_id = p_org and x.location_id = p_location;
  select ct.id, ct.phone, ct.email, ct.sms_consent, ct.email_consent into c
    from core.contacts ct
   where ct.org_id = p_org and ct.customer_id = p_customer and ct.identity_status = 'active'
   order by ct.is_primary desc, (case when p_channel = 'SMS' then ct.sms_consent else ct.email_consent end) desc, ct.created_at
   limit 1;
  v_addr := case when p_channel = 'SMS' then nullif(core.party_norm_phone(c.phone), '') else lower(nullif(btrim(c.email), '')) end;
  if c.id is null or v_addr is null then v_status := 'SUPPRESSED'; v_reason := 'NO_CONTACT';
  elsif not (case when p_channel = 'SMS' then c.sms_consent else c.email_consent end) then v_status := 'SUPPRESSED'; v_reason := 'NO_CONSENT';
  elsif exists (select 1 from core.request_suppressions r where r.org_id = p_org and r.channel = lower(p_channel)
                 and (r.address = v_addr or core.party_norm_phone(r.address) = v_addr)) then
    v_status := 'SUPPRESSED'; v_reason := 'OPTED_OUT';
  elsif p_kind = 'ON_MY_WAY' and s.id is not null and not s.on_my_way_enabled then v_status := 'SUPPRESSED'; v_reason := 'DISABLED';
  elsif p_kind in ('REMINDER_24H','REMINDER_2H','CONFIRMATION') and s.id is not null and not s.reminders_enabled then v_status := 'SUPPRESSED'; v_reason := 'DISABLED';
  end if;
  -- quiet hours (local time of the company): hold until the quiet window ends
  if v_status = 'QUEUED' then
    v_local := (v_after at time zone coalesce(s.time_zone, 'America/Chicago'))::time;
    if coalesce(s.quiet_start, '20:00') > coalesce(s.quiet_end, '08:00') then
      if v_local >= coalesce(s.quiet_start, '20:00') then
        v_after := ((((v_after at time zone coalesce(s.time_zone, 'America/Chicago'))::date + 1) + coalesce(s.quiet_end, '08:00')) at time zone coalesce(s.time_zone, 'America/Chicago'));
      elsif v_local < coalesce(s.quiet_end, '08:00') then
        v_after := ((((v_after at time zone coalesce(s.time_zone, 'America/Chicago'))::date) + coalesce(s.quiet_end, '08:00')) at time zone coalesce(s.time_zone, 'America/Chicago'));
      end if;
    elsif v_local >= coalesce(s.quiet_start, '20:00') and v_local < coalesce(s.quiet_end, '08:00') then
      v_after := ((((v_after at time zone coalesce(s.time_zone, 'America/Chicago'))::date) + coalesce(s.quiet_end, '08:00')) at time zone coalesce(s.time_zone, 'America/Chicago'));
    end if;
  end if;
  if p_kind = 'ON_MY_WAY' then v_token := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'); end if;
  insert into pm.fs_messages (org_id, location_id, kind, channel, customer_id, contact_id, to_address, work_order_id, agreement_id, body,
                              status, suppressed_reason, send_after, eta_token, dedupe_key)
  values (p_org, p_location, p_kind, p_channel, p_customer, c.id, v_addr, p_work_order, p_agreement, left(p_body, 1600),
          v_status, v_reason, v_after, v_token, p_dedupe)
  on conflict (org_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then select m.id into v_id from pm.fs_messages m where m.org_id = p_org and m.dedupe_key = p_dedupe; end if;
  return v_id;
end $$;

-- "On my way": when the lead technician goes en route, queue the customer text (photo + live ETA link).
create or replace function pm.tg_fs_on_my_way() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cust uuid; v_name text; v_company text;
begin
  if new.status <> 'EN_ROUTE' or old.status = 'EN_ROUTE' or new.employee_id is null then return new; end if;
  select * into w from pm.work_orders x where x.org_id = new.org_id and x.id = new.work_order_id;
  select j.customer_id into v_cust from core.jobs j where j.org_id = new.org_id and j.id = w.job_id;
  if v_cust is null then return new; end if;
  select coalesce(tp.display_name, e.first_name, 'Your technician') into v_name
    from core.employees e left join pm.tech_profiles tp on tp.org_id = e.org_id and tp.employee_id = e.id
   where e.id = new.employee_id;
  select l.name into v_company from core.locations l where l.id = w.location_id;
  perform pm._fs_queue_message(new.org_id, w.location_id, 'ON_MY_WAY', v_cust, w.id, null,
    format('%s from %s is on the way. Track arrival: {eta_link}', coalesce(v_name, 'Your technician'), coalesce(v_company, 'us')),
    format('omw:%s:%s', new.id, coalesce(new.en_route_at, now())::date), now());
  return new;
end $$;
create or replace trigger trg_fs_on_my_way after update of status on pm.dispatch_assignments
  for each row execute function pm.tg_fs_on_my_way();

-- Review request after a completed customer-pay visit (FS-107): one per work order, never filtered.
create or replace function pm.tg_fs_review_on_complete() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_cust uuid; v_tech uuid; s pm.fs_settings%rowtype; v_msg uuid; v_status text := 'QUEUED';
begin
  if new.status <> 'COMPLETE' or old.status = 'COMPLETE' or new.is_callback or new.payer_type <> 'CUSTOMER'
     or new.kind not in ('SERVICE','MAINTENANCE_VISIT','INSTALL') then
    return new;
  end if;
  select j.customer_id into v_cust from core.jobs j where j.org_id = new.org_id and j.id = new.job_id;
  if v_cust is null then return new; end if;
  select * into s from pm.fs_settings x where x.org_id = new.org_id and x.location_id = new.location_id;
  if s.id is null or s.review_url is null then return new; end if;
  select d.employee_id into v_tech from pm.dispatch_assignments d
   where d.org_id = new.org_id and d.work_order_id = new.id and d.status <> 'CANCELLED' order by d.is_lead desc, d.created_at limit 1;
  v_msg := pm._fs_queue_message(new.org_id, new.location_id, 'REVIEW_REQUEST', v_cust, new.id, null,
    format('Thanks for choosing us today. How did we do? %s', s.review_url), format('review:%s', new.id),
    now() + make_interval(mins => s.review_delay_minutes));
  if exists (select 1 from pm.fs_messages m where m.id = v_msg and m.status = 'SUPPRESSED') then v_status := 'SUPPRESSED'; end if;
  insert into pm.fs_review_requests (org_id, location_id, work_order_id, job_id, employee_id, customer_id, message_id, status)
  values (new.org_id, new.location_id, new.id, new.job_id, v_tech, v_cust, v_msg, v_status)
  on conflict (org_id, work_order_id) do nothing;
  return new;
end $$;
create or replace trigger trg_fs_review_on_complete after update of status on pm.work_orders
  for each row execute function pm.tg_fs_review_on_complete();

-- ----------------------------------------------------------------------------
-- 10. Capacity (FS-15) and the one booking path
-- ----------------------------------------------------------------------------
-- The governing limit for a booking: date row > weekday row > every-day row; zone row > all-zones row.
create or replace function pm._fs_capacity_rule(p_org uuid, p_bu uuid, p_zone uuid, p_window uuid, p_day date)
returns pm.capacity_limits
language sql stable security definer
set search_path = pm, core, public
as $$
  select c.* from pm.capacity_limits c
   where c.org_id = p_org and c.business_unit_id = p_bu and c.arrival_window_id = p_window
     and (c.zone_id is null or c.zone_id = p_zone)
     and (c.on_date = p_day or (c.on_date is null and (c.day_of_week is null or c.day_of_week = extract(isodow from p_day)::int)))
   order by (c.on_date is not null) desc, (c.zone_id is not null) desc, (c.day_of_week is not null) desc
   limit 1
$$;

-- Capacity used / left for a BU × zone × window × day (REQUEST holds count). Internal.
create or replace function pm._fs_capacity_state(p_org uuid, p_bu uuid, p_zone uuid, p_window uuid, p_day date,
                                                  p_exclude_wo uuid default null, p_exclude_call uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.capacity_limits%rowtype; v_jobs int := 0; v_min int := 0; c_jobs int := 0; c_min int := 0;
begin
  r := pm._fs_capacity_rule(p_org, p_bu, p_zone, p_window, p_day);
  select count(*)::int, coalesce(sum(coalesce(w.estimated_minutes, 60)), 0)::int into v_jobs, v_min
    from pm.work_orders w
   where w.org_id = p_org and w.business_unit_id = p_bu and w.arrival_window_id = p_window and w.service_day = p_day
     and w.status <> 'CANCELLED' and (r.zone_id is null or w.zone_id = r.zone_id)
     and (p_exclude_wo is null or w.id <> p_exclude_wo);
  select count(*)::int, coalesce(sum(coalesce(c.estimated_minutes, 60)), 0)::int into c_jobs, c_min
    from pm.service_calls c
   where c.org_id = p_org and c.status = 'REQUEST' and c.work_order_id is null and c.business_unit_id = p_bu
     and (c.hold_expires_at is null or c.hold_expires_at > now())
     and c.arrival_window_id = p_window and c.service_day = p_day and (r.zone_id is null or c.zone_id = r.zone_id)
     and (p_exclude_call is null or c.id <> p_exclude_call);
  return jsonb_build_object(
    'limited', r.id is not null, 'rule_id', r.id, 'zone_scoped', r.zone_id is not null,
    'max_jobs', r.max_jobs, 'max_minutes', r.max_minutes,
    'used_jobs', v_jobs + c_jobs, 'used_minutes', v_min + c_min, 'held_requests', c_jobs,
    'jobs_left', case when r.max_jobs is null then null else greatest(r.max_jobs - v_jobs - c_jobs, 0) end,
    'minutes_left', case when r.max_minutes is null then null else greatest(r.max_minutes - v_min - c_min, 0) end);
end $$;

-- Would one more booking of p_minutes fit? (null limit = fits)
create or replace function pm._fs_capacity_fits(p_state jsonb, p_minutes int) returns boolean
language sql immutable
set search_path = pm, public
as $$
  select (p_state ->> 'max_jobs' is null or (p_state ->> 'used_jobs')::int + 1 <= (p_state ->> 'max_jobs')::int)
     and (p_state ->> 'max_minutes' is null or (p_state ->> 'used_minutes')::int + coalesce(p_minutes, 60) <= (p_state ->> 'max_minutes')::int)
$$;

create or replace function pm._fs_capacity_lock(p_org uuid, p_bu uuid, p_window uuid, p_day date) returns void
language sql volatile
set search_path = pm, public
as $$ select pg_advisory_xact_lock(hashtextextended('pm.fs.cap:' || p_org::text || ':' || p_bu::text || ':' || p_window::text || ':' || p_day::text, 0)) $$;

-- Zone of a zip on a company (first active zone listing it).
create or replace function pm._fs_zone_for_zip(p_org uuid, p_location uuid, p_zip text) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select z.id from pm.service_zones z
   where z.org_id = p_org and z.location_id = p_location and z.is_active and nullif(btrim(p_zip), '') is not null
     and left(btrim(p_zip), 5) = any (z.zips)
   order by z.sort, z.code limit 1
$$;

-- The core of every booking channel. Validates the job type / BU / window / day, finds the zone,
-- refuses a duplicate open job at the same site, holds the capacity lock and checks capacity, then
-- either books a work order on a job (members) or records a REQUEST that holds the slot (widget).
-- Raises PM_FS_CAPACITY_FULL (53400), PM_FS_DUPLICATE_OPEN_JOB (23505), PM_FS_DO_NOT_SERVICE (22023).
create or replace function pm._fs_book(
  p_org uuid, p_location uuid, p_channel text, p_booking_job_type uuid, p_business_unit uuid, p_arrival_window uuid,
  p_service_day date, p_customer uuid, p_site uuid, p_site_zip text, p_zone uuid, p_campaign uuid, p_job uuid, p_job_name text,
  p_summary text, p_priority int, p_tags text[], p_answers jsonb, p_disclosures text[], p_asset uuid, p_caller jsonb,
  p_override_reason text, p_can_override boolean, p_allow_duplicate boolean, p_source_ref text, p_create_job boolean,
  p_widget uuid default null, p_call uuid default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  bt pm.booking_job_types%rowtype; aw pm.arrival_windows%rowtype; v_bu uuid; v_zone uuid := p_zone; v_state jsonb;
  v_override boolean := false; v_dup text; v_dup_id uuid; v_job uuid := p_job; v_wo uuid; v_call uuid := p_call; v_number text;
  v_tz text; v_start timestamptz; v_end timestamptz; v_jt text; v_name text; v_zip text := p_site_zip; v_prev pm.service_calls%rowtype;
  v_kind text; v_cust uuid := p_customer;
begin
  if p_source_ref is not null then
    select * into v_prev from pm.service_calls c where c.org_id = p_org and c.source_ref = p_source_ref;
    if found then
      return jsonb_build_object('call_id', v_prev.id, 'job_id', v_prev.job_id, 'work_order_id', v_prev.work_order_id,
                                'status', v_prev.status, 'replayed', true);
    end if;
  end if;
  select * into bt from pm.booking_job_types x where x.org_id = p_org and x.id = p_booking_job_type and x.location_id = p_location and x.is_active;
  if not found then raise exception 'PM_FS_UNKNOWN_JOB_TYPE: pick a job type this company books' using errcode = 'P0002'; end if;
  v_bu := coalesce(p_business_unit, bt.business_unit_id);
  if v_bu is null or not exists (select 1 from pm.business_units b where b.org_id = p_org and b.id = v_bu and b.location_id = p_location and b.is_active) then
    raise exception 'PM_FS_UNKNOWN_BU: pick the business unit' using errcode = 'P0002';
  end if;
  select * into aw from pm.arrival_windows x where x.org_id = p_org and x.id = p_arrival_window and x.location_id = p_location and x.is_active;
  if not found then raise exception 'PM_FS_UNKNOWN_WINDOW: pick an arrival window' using errcode = 'P0002'; end if;
  if p_service_day is null then raise exception 'PM_INVALID: pick the day' using errcode = '22023'; end if;
  if not (extract(isodow from p_service_day)::smallint = any (aw.days_of_week)) then
    raise exception 'PM_FS_WINDOW_CLOSED: % is not offered on that day', aw.label using errcode = '22023';
  end if;
  select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = p_org and s.location_id = p_location;
  v_tz := coalesce(v_tz, 'America/Chicago');
  v_start := (p_service_day + aw.start_time) at time zone v_tz;
  v_end   := (p_service_day + aw.end_time) at time zone v_tz;
  if v_end <= now() and not coalesce(p_can_override, false) then
    raise exception 'PM_FS_WINDOW_PAST: that arrival window has passed' using errcode = '22023';
  end if;

  -- site, zone, flags
  if p_site is not null then
    select s.customer_id, coalesce(v_zip, s.zip) into v_cust, v_zip from core.sites s where s.id = p_site and s.org_id = p_org;
    if not found then raise exception 'PM_REF_ORG_MISMATCH: site % is not in org', p_site using errcode = '23503'; end if;
    v_cust := coalesce(p_customer, v_cust);
    if exists (select 1 from pm.site_profiles sp where sp.org_id = p_org and sp.site_id = p_site and sp.do_not_service) then
      raise exception 'PM_FS_DO_NOT_SERVICE: this site is marked do-not-service — check with a manager' using errcode = '22023';
    end if;
  end if;
  if v_zone is null then v_zone := pm._fs_zone_for_zip(p_org, p_location, v_zip); end if;
  if v_zone is not null and not exists (select 1 from pm.service_zones z where z.org_id = p_org and z.id = v_zone and z.location_id = p_location) then
    raise exception 'PM_FS_COMPANY_MISMATCH: zone belongs to another company' using errcode = '23514';
  end if;

  -- duplicate open job at the same site (FS-03)
  if not coalesce(p_allow_duplicate, false) and (p_site is not null or v_cust is not null) then
    select w.id, w.number into v_dup_id, v_dup from pm.work_orders w
      join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
     where w.org_id = p_org and w.status in ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD')
       and w.kind <> 'MAINTENANCE_VISIT'
       and ((p_site is not null and w.site_id = p_site) or (p_site is null and w.site_id is null and j.customer_id = v_cust))
     order by w.created_at desc limit 1;
    if v_dup is not null then
      raise exception 'PM_FS_DUPLICATE_OPEN_JOB: % is already open at this location — open it, or book anyway with a reason', v_dup using errcode = '23505';
    end if;
  end if;

  -- capacity (serialized per BU × window × day)
  perform pm._fs_capacity_lock(p_org, v_bu, aw.id, p_service_day);
  v_state := pm._fs_capacity_state(p_org, v_bu, v_zone, aw.id, p_service_day, null, p_call);
  if p_channel = 'WEB' and not (v_state ->> 'limited')::boolean then
    raise exception 'PM_FS_CAPACITY_FULL: online booking is not open for this window' using errcode = '53400';
  end if;
  if not pm._fs_capacity_fits(v_state, bt.estimated_minutes) then
    if p_channel in ('PHONE','WALK_IN','INTERNAL') and coalesce(p_can_override, false) and nullif(btrim(coalesce(p_override_reason, '')), '') is not null then
      v_override := true;
    else
      raise exception 'PM_FS_CAPACITY_FULL: % is full for % on % (% of % booked)', aw.label,
        (select b.name from pm.business_units b where b.id = v_bu), p_service_day,
        v_state ->> 'used_jobs', coalesce(v_state ->> 'max_jobs', v_state ->> 'max_minutes') using errcode = '53400';
    end if;
  end if;

  -- the call row
  if v_call is null then
    insert into pm.service_calls (org_id, location_id, channel, status, caller_phone, caller_name, caller_email, customer_id, site_id,
        site_zip, site_address, booking_job_type_id, business_unit_id, campaign_id, zone_id, arrival_window_id, service_day,
        estimated_minutes, priority, summary, tags, script_answers, disclosures_ack, capacity_override, override_reason, widget_id,
        source_ref, created_by)
    values (p_org, p_location, p_channel, 'OPEN', nullif(core.party_norm_phone(p_caller ->> 'phone'), ''), nullif(btrim(p_caller ->> 'name'), ''),
        lower(nullif(btrim(p_caller ->> 'email'), '')), v_cust, p_site, nullif(btrim(v_zip), ''), nullif(btrim(p_caller ->> 'address'), ''),
        bt.id, v_bu, p_campaign, v_zone, aw.id, p_service_day, bt.estimated_minutes, coalesce(p_priority, bt.default_priority),
        nullif(btrim(coalesce(p_summary, '')), ''), coalesce(p_tags, '{}'), coalesce(p_answers, '{}'), coalesce(p_disclosures, '{}'),
        v_override, case when v_override then btrim(p_override_reason) end, p_widget, p_source_ref, pm.current_user_id())
    returning id, number into v_call, v_number;
  else
    select c.number into v_number from pm.service_calls c where c.id = v_call;
  end if;

  if not coalesce(p_create_job, true) then
    update pm.service_calls
       set status = 'REQUEST',
           hold_expires_at = now() + make_interval(mins => coalesce((select g.hold_minutes from pm.booking_widgets g where g.org_id = p_org and g.id = p_widget), 120))
     where id = v_call;
    return jsonb_build_object('call_id', v_call, 'call_number', v_number, 'status', 'REQUEST', 'capacity', v_state,
                              'zone_id', v_zone, 'window_start', v_start, 'window_end', v_end);
  end if;

  -- the job (Jobber-style: one step) and the visit
  if v_job is null then
    v_jt := coalesce(bt.job_type_key, (select jt.key from pm.job_types jt where jt.org_id = p_org and jt.location_id = p_location and jt.is_active
                                         order by (jt.archetype = 'field_service') desc, jt.sort, jt.key limit 1));
    if v_jt is null then raise exception 'PM_FS_NO_JOB_TYPE: the company has no job type to book into' using errcode = 'P0002'; end if;
    v_name := coalesce(nullif(btrim(coalesce(p_job_name, '')), ''), bt.label || coalesce(' · ' || (select c.display_name from core.customers c where c.id = v_cust), ''));
    v_job := pm.create_project(p_location, v_jt, left(v_name, 120), v_cust, null);
  elsif not exists (select 1 from core.jobs j where j.org_id = p_org and j.id = v_job and j.location_id = p_location) then
    raise exception 'PM_FORBIDDEN: job % is not on this company', v_job using errcode = '42501';
  end if;
  v_kind := bt.work_order_kind;
  insert into pm.work_orders (org_id, location_id, job_id, kind, summary, priority, asset_id, requested_start, requested_end,
                              estimated_minutes, required_skills, is_callback, complaint, created_by,
                              business_unit_id, campaign_id, zone_id, arrival_window_id, service_day, booking_channel, call_id, site_id)
  values (p_org, p_location, v_job, v_kind, left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), bt.label), 200),
          coalesce(p_priority, bt.default_priority), p_asset, v_start, v_end, bt.estimated_minutes, bt.required_skills, bt.is_recall,
          nullif(btrim(coalesce(p_summary, '')), ''), pm.current_user_id(), v_bu, p_campaign, v_zone, aw.id, p_service_day, p_channel,
          v_call, p_site)
  returning id into v_wo;
  update pm.service_calls set status = 'BOOKED', job_id = v_job, work_order_id = v_wo, booked_by = pm.current_user_id(),
         booked_at = now(), customer_id = coalesce(customer_id, v_cust), zone_id = coalesce(zone_id, v_zone),
         capacity_override = capacity_override or v_override,
         override_reason = coalesce(override_reason, case when v_override then btrim(p_override_reason) end)
   where id = v_call;
  perform pm.log_activity(p_org, p_location, v_job, 'call.booked', 'service_calls', v_call,
    format('Booked %s for %s %s', bt.label, p_service_day, aw.label),
    jsonb_build_object('channel', p_channel, 'work_order_id', v_wo, 'override', v_override, 'business_unit_id', v_bu, 'zone_id', v_zone));
  return jsonb_build_object('call_id', v_call, 'call_number', v_number, 'status', 'BOOKED', 'job_id', v_job, 'work_order_id', v_wo,
                            'work_order_number', (select w.number from pm.work_orders w where w.id = v_wo), 'override', v_override,
                            'capacity', v_state, 'zone_id', v_zone, 'window_start', v_start, 'window_end', v_end);
end $$;

-- CSR / AI-agent booking (members). Override only for a phone / walk-in / internal booking by a
-- dispatcher (projects.dispatch:edit) with a reason; the AI agent and the widget never override.
create or replace function pm.fs_book_call(
  p_location uuid, p_channel text, p_booking_job_type uuid, p_arrival_window uuid, p_service_day date,
  p_business_unit uuid default null, p_customer uuid default null, p_site uuid default null, p_site_zip text default null,
  p_zone uuid default null, p_campaign uuid default null, p_job uuid default null, p_job_name text default null,
  p_summary text default null, p_priority int default null, p_tags text[] default '{}', p_answers jsonb default '{}',
  p_disclosures text[] default '{}', p_asset uuid default null, p_caller jsonb default '{}', p_override_reason text default null,
  p_allow_duplicate boolean default false, p_source_ref text default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_channel not in ('PHONE','WALK_IN','INTERNAL','AI_AGENT','SMS','EMAIL','PORTAL','LSA','ANGI','THUMBTACK') then
    raise exception 'PM_INVALID: channel %', p_channel using errcode = '22023';
  end if;
  return pm._fs_book(v_org, p_location, p_channel, p_booking_job_type, p_business_unit, p_arrival_window, p_service_day, p_customer,
                     p_site, p_site_zip, p_zone, p_campaign, p_job, p_job_name, p_summary, p_priority, p_tags, p_answers, p_disclosures,
                     p_asset, p_caller, p_override_reason, pm.can('projects.dispatch', 'edit', p_location) and p_channel <> 'AI_AGENT',
                     p_allow_duplicate, p_source_ref, true, null, null);
end $$;

-- A call that did not book (booking rate, second-chance list) or a typed request with no slot.
create or replace function pm.fs_log_call(
  p_location uuid, p_channel text, p_outcome text, p_reason text default null, p_customer uuid default null,
  p_caller jsonb default '{}', p_campaign uuid default null, p_business_unit uuid default null, p_summary text default null,
  p_booking_job_type uuid default null
) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_id uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_outcome not in ('NOT_BOOKED','CANCELLED','OPEN') then raise exception 'PM_INVALID: outcome %', p_outcome using errcode = '22023'; end if;
  if p_outcome = 'NOT_BOOKED' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'PM_INVALID: say why the call did not book' using errcode = '22023';
  end if;
  insert into pm.service_calls (org_id, location_id, channel, status, caller_phone, caller_name, caller_email, customer_id, campaign_id,
                                business_unit_id, booking_job_type_id, summary, not_booked_reason, created_by)
  values (v_org, p_location, p_channel, p_outcome, nullif(core.party_norm_phone(p_caller ->> 'phone'), ''), nullif(btrim(p_caller ->> 'name'), ''),
          lower(nullif(btrim(p_caller ->> 'email'), '')), p_customer, p_campaign, p_business_unit, p_booking_job_type,
          nullif(btrim(coalesce(p_summary, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''), pm.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Turn a held web REQUEST into a job + visit in the same slot (the hold transfers; capacity rechecked).
create or replace function pm.fs_convert_request(p_call uuid, p_customer uuid default null, p_site uuid default null,
                                                 p_job uuid default null, p_job_name text default null, p_allow_duplicate boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.service_calls%rowtype;
begin
  select * into c from pm.service_calls x where x.id = p_call for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: call % not found in the caller''s organization', p_call using errcode = '42501';
  end if;
  if c.status <> 'REQUEST' then raise exception 'PM_FS_NOT_A_REQUEST: % is %', c.number, c.status using errcode = '22023'; end if;
  update pm.service_calls set customer_id = coalesce(p_customer, customer_id), site_id = coalesce(p_site, site_id) where id = c.id;
  return pm._fs_book(c.org_id, c.location_id, c.channel, c.booking_job_type_id, c.business_unit_id, c.arrival_window_id, c.service_day,
                     coalesce(p_customer, c.customer_id), coalesce(p_site, c.site_id), c.site_zip, c.zone_id, c.campaign_id, p_job,
                     p_job_name, c.summary, c.priority, c.tags, c.script_answers, c.disclosures_ack, null, '{}'::jsonb, null,
                     false, p_allow_duplicate, null, true, c.widget_id, c.id);
end $$;

-- Decline / cancel a call or request (frees a held slot).
create or replace function pm.fs_close_call(p_call uuid, p_status text, p_reason text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.service_calls%rowtype;
begin
  select * into c from pm.service_calls x where x.id = p_call for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: call % not found in the caller''s organization', p_call using errcode = '42501';
  end if;
  if p_status not in ('NOT_BOOKED','CANCELLED') then raise exception 'PM_INVALID: status %', p_status using errcode = '22023'; end if;
  if c.status in ('BOOKED','NOT_BOOKED','CANCELLED') then raise exception 'PM_FS_CALL_CLOSED: % is %', c.number, c.status using errcode = '22023'; end if;
  update pm.service_calls set status = p_status, not_booked_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = c.id;
  return c.id;
end $$;

-- Move a booked visit to another day / window (capacity rechecked; dispatch may override with a reason).
create or replace function pm.fs_reschedule_booking(p_wo uuid, p_service_day date, p_arrival_window uuid, p_override_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; aw pm.arrival_windows%rowtype; v_state jsonb; v_tz text; v_override boolean := false;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') then raise exception 'PM_WO_NOT_SCHEDULABLE: % is %', w.number, w.status using errcode = '22023'; end if;
  if w.business_unit_id is null then raise exception 'PM_FS_NOT_BOOKED: % has no business unit (book it from Calls)', w.number using errcode = '22023'; end if;
  select * into aw from pm.arrival_windows x where x.org_id = w.org_id and x.id = p_arrival_window and x.location_id = w.location_id and x.is_active;
  if not found then raise exception 'PM_FS_UNKNOWN_WINDOW: pick an arrival window' using errcode = 'P0002'; end if;
  if not (extract(isodow from p_service_day)::smallint = any (aw.days_of_week)) then
    raise exception 'PM_FS_WINDOW_CLOSED: % is not offered on that day', aw.label using errcode = '22023';
  end if;
  perform pm._fs_capacity_lock(w.org_id, w.business_unit_id, aw.id, p_service_day);
  v_state := pm._fs_capacity_state(w.org_id, w.business_unit_id, w.zone_id, aw.id, p_service_day, w.id, null);
  if not pm._fs_capacity_fits(v_state, w.estimated_minutes) then
    if nullif(btrim(coalesce(p_override_reason, '')), '') is not null and pm.can('projects.dispatch', 'edit', w.location_id) then
      v_override := true;
    else
      raise exception 'PM_FS_CAPACITY_FULL: % is full on %', aw.label, p_service_day using errcode = '53400';
    end if;
  end if;
  select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = w.org_id and s.location_id = w.location_id;
  v_tz := coalesce(v_tz, 'America/Chicago');
  update pm.work_orders set service_day = p_service_day, arrival_window_id = aw.id,
         requested_start = (p_service_day + aw.start_time) at time zone v_tz, requested_end = (p_service_day + aw.end_time) at time zone v_tz
   where id = w.id;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'work_order.rebooked', 'work_orders', w.id,
    format('Moved %s to %s %s', w.number, p_service_day, aw.label), jsonb_build_object('override', v_override, 'reason', p_override_reason));
  return jsonb_build_object('work_order_id', w.id, 'override', v_override, 'capacity', v_state);
end $$;

-- Capacity grid for the booking screen / board: day × BU × zone-rule × window.
create or replace function pm.fs_capacity_grid(p_location uuid, p_from date, p_days int default 7, p_business_unit uuid default null, p_zone uuid default null)
returns table (service_day date, business_unit_id uuid, arrival_window_id uuid, window_label text, start_time time, end_time time,
               is_after_hours boolean, limited boolean, max_jobs int, max_minutes int, used_jobs int, used_minutes int,
               jobs_left int, minutes_left int, is_open boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; d date; b record; w record; s jsonb;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 62 then raise exception 'PM_INVALID: 1..62 days' using errcode = '22023'; end if;
  for d in select generate_series(p_from, p_from + (p_days - 1), interval '1 day')::date loop
    for b in select x.id from pm.business_units x where x.org_id = v_org and x.location_id = p_location and x.is_active
               and (p_business_unit is null or x.id = p_business_unit) order by x.sort, x.code loop
      for w in select x.* from pm.arrival_windows x where x.org_id = v_org and x.location_id = p_location and x.is_active
                 and extract(isodow from d)::smallint = any (x.days_of_week) order by x.sort, x.start_time loop
        s := pm._fs_capacity_state(v_org, b.id, p_zone, w.id, d, null, null);
        service_day := d; business_unit_id := b.id; arrival_window_id := w.id; window_label := w.label; start_time := w.start_time;
        end_time := w.end_time; is_after_hours := w.is_after_hours; limited := (s ->> 'limited')::boolean;
        max_jobs := (s ->> 'max_jobs')::int; max_minutes := (s ->> 'max_minutes')::int; used_jobs := (s ->> 'used_jobs')::int;
        used_minutes := (s ->> 'used_minutes')::int; jobs_left := (s ->> 'jobs_left')::int; minutes_left := (s ->> 'minutes_left')::int;
        is_open := pm._fs_capacity_fits(s, 60);
        return next;
      end loop;
    end loop;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 11. Public online booking widget (anon; token-scoped; REQUEST rows only)
--     Security review (2026-10-25): the token is a public credential, so every limit that matters
--     is enforced here, in the database, where a direct PostgREST caller cannot skip it:
--       * per-widget daily cap (default 30), per-phone daily cap (default 3) and per-IP hourly cap
--         (default 5) — atomic counters (INSERT … ON CONFLICT DO UPDATE takes the row lock, so two
--         concurrent requests can never both pass the last slot); availability lookups 120 / IP / hour;
--       * min_lead_hours on the window start; days_ahead;
--       * a REQUEST hold expires after hold_minutes (default 120) and then stops counting against capacity;
--       * server key (fail closed): only a caller presenting a key whose sha256 is in
--         pm.fs_widget_server_keys (the app route, FS_WIDGET_SERVER_KEY) may book or look up
--         availability. With no key registered the widget answers FS_WIDGET_NOT_SET_UP ("online booking
--         isn't set up yet") — so direct anon PostgREST calls can never skip the route's challenge /
--         honeypot / timing checks or choose their own p_client_ip;
--       * counters never grow past a limit: a bucket at its limit is refused without a write, a new
--         per-IP / per-phone bucket is never created once the widget's own cap is reached, and each
--         call deletes that widget's expired buckets (deterministic cleanup, no random sweep).
--     Capacity itself is checked under the per BU × window × day advisory lock in pm._fs_book.
-- ----------------------------------------------------------------------------
create table if not exists pm.fs_rate_counters (
  widget_id     uuid not null references pm.booking_widgets(id) on delete cascade,
  bucket        text not null check (char_length(bucket) between 3 and 200),
  window_start  timestamptz not null,
  expires_at    timestamptz not null,
  hits          int not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
create index if not exists pm_fs_rate_counters_expiry_idx on pm.fs_rate_counters (widget_id, expires_at);

create table if not exists pm.fs_widget_server_keys (
  key_hash    text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  note        text,
  created_at  timestamptz not null default now()
);

create or replace function pm._fs_widget(p_token text) returns pm.booking_widgets
language sql stable security definer
set search_path = pm, core, public
as $$
  select w.* from pm.booking_widgets w
   where w.is_active and p_token is not null and length(p_token) between 24 and 200
     and w.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- Fail closed: true only for a presented key whose hash is registered.
create or replace function pm._fs_widget_server_ok(p_key text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select p_key is not null and length(p_key) between 16 and 200
     and exists (select 1 from pm.fs_widget_server_keys k where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
$$;

-- Raises unless the caller is the app route. No key registered at all → "not set up yet".
create or replace function pm._fs_widget_assert_server(p_key text) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if pm._fs_widget_server_ok(p_key) then return; end if;
  if not exists (select 1 from pm.fs_widget_server_keys) then
    raise exception 'FS_WIDGET_NOT_SET_UP: online booking isn''t set up yet — please call us' using errcode = '55000';
  end if;
  raise exception 'FS_WIDGET_KEY: online booking must go through the booking page' using errcode = '42501';
end $$;

-- Each call first deletes this widget's expired buckets (deterministic; index on widget_id, expires_at).
create or replace function pm._fs_sweep(p_widget uuid) returns void
language sql volatile security definer
set search_path = pm, core, public
as $$
  delete from pm.fs_rate_counters c where c.widget_id = p_widget and c.expires_at <= now()
$$;

-- One hit on a fixed-window counter; true while the bucket is within its limit. A bucket already at
-- its limit is refused without a write (counters never grow past the limit). Atomic: the conditional
-- update / upsert holds the row lock until the transaction ends, so concurrent hits serialize.
create or replace function pm._fs_hit(p_widget uuid, p_bucket text, p_unit text, p_limit int) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_hits int; v_unit text := case when p_unit = 'day' then 'day' else 'hour' end;
  v_start timestamptz := date_trunc(case when p_unit = 'day' then 'day' else 'hour' end, now());
begin
  if p_limit <= 0 then return false; end if;
  update pm.fs_rate_counters c set hits = c.hits + 1
   where c.bucket = p_bucket and c.window_start = v_start and c.hits < p_limit
  returning c.hits into v_hits;
  if found then return true; end if;
  insert into pm.fs_rate_counters as c (widget_id, bucket, window_start, expires_at, hits)
  values (p_widget, p_bucket, v_start, v_start + ('1 ' || v_unit)::interval, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < p_limit
  returning c.hits into v_hits;
  return found;
end $$;

-- The client IP the app route saw (x-forwarded-for on Vercel), hashed into the bucket name — never stored raw.
create or replace function pm._fs_ip_bucket(p_prefix text, p_widget uuid, p_ip text) returns text
language sql immutable
set search_path = pm, public
as $$
  select p_prefix || ':' || p_widget::text || ':' ||
         case when p_ip is null or btrim(p_ip) = '' then 'unknown'
              else left(encode(sha256(convert_to(lower(btrim(p_ip)), 'UTF8')), 'hex'), 32) end
$$;

create or replace function public.fs_widget_availability(p_token text, p_from date default null, p_days int default null,
                                                         p_client_ip text default null, p_server_key text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare wg pm.booking_widgets%rowtype; v_out jsonb := '[]'::jsonb; d date; w record; b record; s jsonb; v_types jsonb; v_tz text;
  v_from date; v_days int; v_start timestamptz;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  wg := pm._fs_widget(p_token);
  if wg.id is null then raise exception 'FS_WIDGET_UNKNOWN: this booking link is not active' using errcode = '42501'; end if;
  if length(coalesce(p_client_ip, '')) > 64 then raise exception 'FS_WIDGET_INVALID: bad client address' using errcode = '22023'; end if;
  perform pm._fs_sweep(wg.id);
  -- the widget-wide cap first, so no per-IP bucket is created once it is spent
  if not pm._fs_hit(wg.id, 'aw:' || wg.id::text, 'hour', wg.max_lookups_per_hour) then
    raise exception 'FS_WIDGET_BUSY: online booking is busy — please call us' using errcode = '53400';
  end if;
  if not pm._fs_hit(wg.id, pm._fs_ip_bucket('avail', wg.id, p_client_ip), 'hour', 120) then
    raise exception 'FS_WIDGET_LIMIT: too many lookups from this network — please call us' using errcode = '53400';
  end if;
  select coalesce(x.time_zone, 'America/Chicago') into v_tz from pm.fs_settings x where x.org_id = wg.org_id and x.location_id = wg.location_id;
  v_tz := coalesce(v_tz, 'America/Chicago');
  v_from := greatest(coalesce(p_from, (now() at time zone v_tz)::date), (now() at time zone v_tz)::date);
  v_days := least(coalesce(p_days, wg.days_ahead), wg.days_ahead);
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'key', t.key, 'label', t.label,
                                               'diagnostic_fee_cents', t.diagnostic_fee_cents) order by t.sort, t.label), '[]'::jsonb)
    into v_types
    from pm.booking_job_types t
   where t.org_id = wg.org_id and t.location_id = wg.location_id and t.is_active and t.online
     and (cardinality(wg.job_type_keys) = 0 or t.key = any (wg.job_type_keys));
  for d in select generate_series(v_from, v_from + (v_days - 1), interval '1 day')::date loop
    for w in select x.* from pm.arrival_windows x where x.org_id = wg.org_id and x.location_id = wg.location_id and x.is_active and x.online
               and extract(isodow from d)::smallint = any (x.days_of_week) order by x.sort, x.start_time loop
      v_start := (d + w.start_time) at time zone v_tz;
      continue when v_start < now() + make_interval(hours => wg.min_lead_hours);
      for b in select distinct t.business_unit_id as id from pm.booking_job_types t
                where t.org_id = wg.org_id and t.location_id = wg.location_id and t.is_active and t.online and t.business_unit_id is not null
                  and (cardinality(wg.job_type_keys) = 0 or t.key = any (wg.job_type_keys)) loop
        s := pm._fs_capacity_state(wg.org_id, b.id, null, w.id, d, null, null);
        if (s ->> 'limited')::boolean and pm._fs_capacity_fits(s, 60) then
          v_out := v_out || jsonb_build_object('day', d, 'window_id', w.id, 'label', w.label, 'business_unit_id', b.id,
                                               'start', v_start, 'end', (d + w.end_time) at time zone v_tz);
        end if;
      end loop;
    end loop;
  end loop;
  return jsonb_build_object('company', (select l.name from core.locations l where l.id = wg.location_id), 'job_types', v_types, 'slots', v_out);
end $$;

create or replace function public.fs_widget_book(p_token text, p_booking_job_type uuid, p_arrival_window uuid, p_service_day date,
                                                 p_name text, p_phone text, p_email text default null, p_zip text default null,
                                                 p_address text default null, p_summary text default null, p_request_id text default null,
                                                 p_client_ip text default null, p_server_key text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare wg pm.booking_widgets%rowtype; r jsonb; v_tz text; aw pm.arrival_windows%rowtype; v_phone text := core.party_norm_phone(p_phone);
  v_ref text; v_prev pm.service_calls%rowtype;
begin
  perform pm._fs_widget_assert_server(p_server_key);
  wg := pm._fs_widget(p_token);
  if wg.id is null then raise exception 'FS_WIDGET_UNKNOWN: this booking link is not active' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null or length(v_phone) < 10 then
    raise exception 'FS_WIDGET_INVALID: add your name and a 10-digit phone number' using errcode = '22023';
  end if;
  if length(coalesce(p_summary, '')) > 500 or length(coalesce(p_address, '')) > 200 or length(coalesce(p_email, '')) > 254
     or length(coalesce(p_name, '')) > 120 or length(coalesce(p_client_ip, '')) > 64 then
    raise exception 'FS_WIDGET_INVALID: shorten the description' using errcode = '22023';
  end if;
  v_ref := case when p_request_id is not null and p_request_id ~ '^[A-Za-z0-9_-]{8,64}$' then 'widget:' || wg.id::text || ':' || p_request_id end;
  if v_ref is not null then          -- a replayed submit returns the first result and spends no quota
    select * into v_prev from pm.service_calls c where c.org_id = wg.org_id and c.source_ref = v_ref;
    if found then
      return jsonb_build_object('reference', v_prev.number, 'status', v_prev.status, 'window_start', null, 'window_end', null, 'replayed', true);
    end if;
  end if;
  select * into aw from pm.arrival_windows x where x.org_id = wg.org_id and x.id = p_arrival_window and x.location_id = wg.location_id
                                              and x.online and x.is_active;
  if aw.id is null or not exists (select 1 from pm.booking_job_types t where t.org_id = wg.org_id and t.id = p_booking_job_type and t.online and t.is_active
                                    and t.location_id = wg.location_id and (cardinality(wg.job_type_keys) = 0 or t.key = any (wg.job_type_keys))) then
    raise exception 'FS_WIDGET_INVALID: pick a service and a time from the list' using errcode = '22023';
  end if;
  select coalesce(x.time_zone, 'America/Chicago') into v_tz from pm.fs_settings x where x.org_id = wg.org_id and x.location_id = wg.location_id;
  v_tz := coalesce(v_tz, 'America/Chicago');
  if p_service_day is null or p_service_day < (now() at time zone v_tz)::date or p_service_day > (now() at time zone v_tz)::date + wg.days_ahead then
    raise exception 'FS_WIDGET_INVALID: pick a day in the next % days', wg.days_ahead using errcode = '22023';
  end if;
  if (p_service_day + aw.start_time) at time zone v_tz < now() + make_interval(hours => wg.min_lead_hours) then
    raise exception 'FS_WIDGET_TOO_SOON: online booking needs % hours'' notice — pick a later time or call us', wg.min_lead_hours using errcode = '22023';
  end if;
  -- limits (atomic counters; a failure rolls back this request and its counters together). The
  -- widget-wide cap is spent first, so once it is reached no per-IP / per-phone bucket is created.
  perform pm._fs_sweep(wg.id);
  if not pm._fs_hit(wg.id, 'w:' || wg.id::text, 'day', wg.max_requests_per_day) then
    raise exception 'FS_WIDGET_BUSY: online booking is busy — please call us' using errcode = '53400';
  end if;
  if not pm._fs_hit(wg.id, pm._fs_ip_bucket('ip', wg.id, p_client_ip), 'hour', wg.per_ip_per_hour) then
    raise exception 'FS_WIDGET_LIMIT: too many booking requests from this network — please call us' using errcode = '53400';
  end if;
  if not pm._fs_hit(wg.id, 'ph:' || wg.id::text || ':' || left(encode(sha256(convert_to(v_phone, 'UTF8')), 'hex'), 32), 'day', wg.per_phone_per_day) then
    raise exception 'FS_WIDGET_LIMIT: we already have your request — we will call you to confirm' using errcode = '53400';
  end if;
  r := pm._fs_book(wg.org_id, wg.location_id, 'WEB', p_booking_job_type, null, p_arrival_window, p_service_day, null, null, p_zip, null,
                   wg.campaign_id, null, null, p_summary, null, '{}'::text[], '{}'::jsonb, '{}'::text[], null,
                   jsonb_build_object('name', p_name, 'phone', p_phone, 'email', p_email, 'address', p_address), null, false, true,
                   v_ref, false, wg.id, null);
  return jsonb_build_object('reference', (select c.number from pm.service_calls c where c.id = (r ->> 'call_id')::uuid),
                            'status', r ->> 'status', 'window_start', r -> 'window_start', 'window_end', r -> 'window_end',
                            'hold_expires_at', (select c.hold_expires_at from pm.service_calls c where c.id = (r ->> 'call_id')::uuid));
end $$;

-- ----------------------------------------------------------------------------
-- 12. Caller pop + pre-job brief (FS-02 / FS-27 / FS-100)
-- ----------------------------------------------------------------------------
-- Books AR for a customer: open and past-due balances. Internal (definer reads public.invoices).
create or replace function pm._fs_customer_ar(p_org uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_open bigint := 0; v_past bigint := 0; v_days int; v_n int := 0;
begin
  if to_regclass('public.invoices') is null then return jsonb_build_object('available', false); end if;
  execute $q$
    select coalesce(sum(i.balance_cents), 0)::bigint,
           coalesce(sum(i.balance_cents) filter (where i.due_date < current_date), 0)::bigint,
           max(current_date - i.due_date) filter (where i.due_date < current_date),
           count(*)::int
      from public.invoices i
     where i.org_id = $1 and i.customer_id = $2 and i.status in ('SENT','PARTIALLY_PAID','OVERDUE') and i.balance_cents > 0
  $q$ into v_open, v_past, v_days, v_n using p_org, p_customer;
  return jsonb_build_object('available', true, 'open_cents', v_open, 'past_due_cents', v_past, 'oldest_past_due_days', v_days, 'open_invoices', v_n);
end $$;

-- Mask AR for the caller at a company: amounts only with contract_value or billing:view; flags always.
create or replace function pm._fs_masked_ar(p_org uuid, p_location uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare a jsonb := pm._fs_customer_ar(p_org, p_customer); v_see boolean;
begin
  v_see := pm.can('projects.contract_value', 'view', p_location) or pm.can('projects.billing', 'view', p_location);
  return jsonb_build_object('available', coalesce((a ->> 'available')::boolean, false),
    'has_balance', coalesce((a ->> 'open_cents')::bigint, 0) > 0, 'past_due', coalesce((a ->> 'past_due_cents')::bigint, 0) > 0,
    'oldest_past_due_days', a -> 'oldest_past_due_days', 'amounts_visible', v_see,
    'open_cents', case when v_see then a -> 'open_cents' end, 'past_due_cents', case when v_see then a -> 'past_due_cents' end);
end $$;

-- Everything a CSR needs in one pop: matches by phone, then the chosen customer's sites, recent
-- visits, equipment, agreement badge, open options / estimates, open work (duplicate warning), AR.
create or replace function pm.fs_caller_pop(p_location uuid, p_phone text default null, p_customer uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_phone text := nullif(core.party_norm_phone(p_phone), ''); v_matches jsonb := '[]'::jsonb; v_cust uuid := p_customer;
  v_out jsonb; v_campaign jsonb;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_phone is not null and length(v_phone) >= 7 then
    select coalesce(jsonb_agg(m order by m ->> 'name'), '[]'::jsonb) into v_matches from (
      select distinct on (c.id) jsonb_build_object('customer_id', c.id, 'name', coalesce(c.display_name, c.name),
             'matched', case when core.party_norm_phone(c.phone) = v_phone then 'customer phone' else 'contact phone' end) as m
        from core.customers c
        left join core.contacts ct on ct.org_id = c.org_id and ct.customer_id = c.id and ct.identity_status = 'active'
       where c.org_id = v_org and c.merged_into is null
         and (core.party_norm_phone(c.phone) = v_phone or core.party_norm_phone(ct.phone) = v_phone)
       order by c.id limit 10) x;
    if v_cust is null and jsonb_array_length(v_matches) = 1 then v_cust := (v_matches -> 0 ->> 'customer_id')::uuid; end if;
    select jsonb_build_object('id', k.id, 'name', k.name, 'channel', k.channel) into v_campaign
      from pm.campaigns k where k.org_id = v_org and k.location_id = p_location and k.is_active
       and core.party_norm_phone(k.tracking_phone) = v_phone limit 1;
  end if;
  v_out := jsonb_build_object('phone', v_phone, 'matches', v_matches, 'tracking_campaign', v_campaign);
  if v_cust is null then return v_out; end if;
  if not exists (select 1 from core.customers c where c.id = v_cust and c.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: customer % is not in the caller''s organization', v_cust using errcode = '42501';
  end if;
  return v_out || jsonb_build_object(
    'customer', (select jsonb_build_object('id', c.id, 'name', coalesce(c.display_name, c.name), 'phone', c.phone, 'email', c.email,
                                           'address', concat_ws(', ', c.address_line1, c.city, c.state, c.zip))
                   from core.customers c where c.id = v_cust),
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', ct.id, 'name', concat_ws(' ', ct.first_name, ct.last_name), 'phone', ct.phone,
                                                             'email', ct.email, 'roles', ct.roles, 'sms_consent', ct.sms_consent,
                                                             'is_primary', ct.is_primary) order by ct.is_primary desc, ct.created_at), '[]'::jsonb)
                   from core.contacts ct where ct.org_id = v_org and ct.customer_id = v_cust and ct.identity_status = 'active'),
    'sites', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'address', concat_ws(', ', s.address_line1, s.city, s.state),
                                                          'zip', s.zip, 'zone_id', pm._fs_zone_for_zip(v_org, p_location, s.zip),
                                                          'gate_code', sp.gate_code, 'pets', sp.pets, 'access_notes', coalesce(sp.access_notes, s.access_notes),
                                                          'do_not_service', coalesce(sp.do_not_service, false),
                                                          'do_not_service_reason', sp.do_not_service_reason) order by s.created_at), '[]'::jsonb)
                from core.sites s left join pm.site_profiles sp on sp.org_id = s.org_id and sp.site_id = s.id
               where s.org_id = v_org and s.customer_id = v_cust and s.identity_status = 'active'),
    'recent_visits', (select coalesce(jsonb_agg(v order by v ->> 'when' desc), '[]'::jsonb) from (
        select jsonb_build_object('work_order_id', w.id, 'number', w.number, 'summary', w.summary, 'status', w.status, 'outcome', w.outcome,
                                  'when', coalesce(w.completed_at, w.scheduled_start, w.created_at), 'is_callback', w.is_callback,
                                  'resolution', w.resolution) as v
          from pm.work_orders w join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
         where w.org_id = v_org and j.customer_id = v_cust and w.status in ('COMPLETE','CLOSED')
         order by coalesce(w.completed_at, w.created_at) desc limit 5) x),
    'open_work', (select coalesce(jsonb_agg(jsonb_build_object('work_order_id', w.id, 'number', w.number, 'summary', w.summary, 'status', w.status,
                                                              'site_id', w.site_id, 'service_day', w.service_day, 'kind', w.kind)), '[]'::jsonb)
                    from pm.work_orders w join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
                   where w.org_id = v_org and j.customer_id = v_cust and w.status in ('NEW','SCHEDULED','DISPATCHED','IN_PROGRESS','ON_HOLD')),
    'equipment', (select coalesce(jsonb_agg(jsonb_build_object('asset_id', a.id, 'type', a.equipment_type, 'make', a.make, 'model', a.model,
                                                              'serial', a.serial_number, 'installed_on', a.installed_on,
                                                              'age_years', case when coalesce(a.installed_on, a.manufactured_on) is not null
                                                                                then extract(year from age(current_date, coalesce(a.installed_on, a.manufactured_on)))::int end,
                                                              'parts_warranty_ends_on', coalesce(a.parts_warranty_ends_on, a.warranty_expires_on),
                                                              'labor_warranty_ends_on', a.labor_warranty_ends_on, 'refrigerant', a.refrigerant_type,
                                                              'site_id', a.site_id) order by a.installed_on nulls last), '[]'::jsonb)
                    from pm.assets a where a.org_id = v_org and a.customer_id = v_cust and a.status = 'ACTIVE'),
    'agreements', (select coalesce(jsonb_agg(jsonb_build_object('agreement_id', g.id, 'number', g.number, 'plan', g.plan_name, 'tier', g.tier,
                                                               'status', g.status, 'ends_on', g.ends_on, 'suspended', g.entitlements_suspended,
                                                               'discount_pct', g.member_discount_pct,
                                                               'visits_owed', (select count(*) from pm.work_orders v where v.org_id = g.org_id and v.agreement_id = g.id and v.status in ('NEW','ON_HOLD'))) order by g.ends_on desc), '[]'::jsonb)
                     from pm.service_agreements g where g.org_id = v_org and g.customer_id = v_cust and g.status in ('ACTIVE','SUSPENDED')),
    'is_member', exists (select 1 from pm.service_agreements g where g.org_id = v_org and g.customer_id = v_cust and g.status = 'ACTIVE' and not g.entitlements_suspended),
    'open_estimates', (select coalesce(jsonb_agg(jsonb_build_object('estimate_id', e.id, 'number', e.number, 'title', e.title, 'status', e.status,
                                                                   'created_at', e.created_at)), '[]'::jsonb)
                         from pm.fs_estimates e where e.org_id = v_org and e.customer_id = v_cust and e.status in ('DRAFT','PRESENTED')),
    'ar', pm._fs_masked_ar(v_org, p_location, v_cust),
    'summary', (select string_agg(x.line, E'\n') from (
        select format('%s · %s%s', to_char(coalesce(w.completed_at, w.created_at), 'Mon DD'), w.summary,
                      coalesce(' — ' || nullif(w.resolution, ''), '')) as line
          from pm.work_orders w join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
         where w.org_id = v_org and j.customer_id = v_cust and w.status in ('COMPLETE','CLOSED')
         order by coalesce(w.completed_at, w.created_at) desc limit 3) x));
end $$;

-- Pre-job brief for the tech (FS-27): the pop narrowed to the visit's customer and site.
create or replace function pm.fs_prejob_brief(p_wo uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cust uuid; v_pop jsonb;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  select j.customer_id into v_cust from core.jobs j where j.org_id = w.org_id and j.id = w.job_id;
  v_pop := case when v_cust is null then '{}'::jsonb
                else pm.fs_caller_pop(w.location_id, null, v_cust) - 'matches' - 'phone' - 'tracking_campaign' - 'open_work' end;
  return v_pop || jsonb_build_object(
    'work_order', jsonb_build_object('id', w.id, 'number', w.number, 'summary', w.summary, 'complaint', w.complaint, 'kind', w.kind,
                                     'service_day', w.service_day, 'requested_start', w.requested_start, 'requested_end', w.requested_end,
                                     'is_callback', w.is_callback, 'site_id', w.site_id, 'asset_id', w.asset_id),
    'site', (select jsonb_build_object('address', concat_ws(', ', s.address_line1, s.city, s.state, s.zip), 'gate_code', sp.gate_code,
                                       'pets', sp.pets, 'access_notes', coalesce(sp.access_notes, s.access_notes))
               from core.sites s left join pm.site_profiles sp on sp.org_id = s.org_id and sp.site_id = s.id where s.id = w.site_id),
    'call', (select jsonb_build_object('number', c.number, 'answers', c.script_answers, 'channel', c.channel)
               from pm.service_calls c where c.org_id = w.org_id and c.id = w.call_id));
end $$;

-- ----------------------------------------------------------------------------
-- 13. Dispatch eligibility (FS-16 / FS-104 / FS-18)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_eligible_techs(p_wo uuid, p_start timestamptz default null, p_end timestamptz default null)
returns table (employee_id uuid, tech_name text, eligible boolean, reasons text[], in_zone boolean, on_call boolean,
               booked_minutes int, missing_skills text[], expired_skills text[])
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_start timestamptz; v_end timestamptz; e record; v_missing text[]; v_expired text[]; v_r text[];
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  v_start := coalesce(p_start, w.requested_start, w.scheduled_start, now());
  v_end := coalesce(p_end, w.requested_end, w.scheduled_end, v_start + make_interval(mins => coalesce(w.estimated_minutes, 60)));
  for e in
    select ce.id, concat_ws(' ', ce.first_name, ce.last_name) as nm, tp.zone_ids, tp.business_unit_ids, coalesce(tp.is_dispatchable, true) as disp
      from core.employees ce
      left join pm.tech_profiles tp on tp.org_id = ce.org_id and tp.employee_id = ce.id
     where ce.org_id = w.org_id and ce.is_active
       and (tp.location_id = w.location_id
            or exists (select 1 from pm.crew_members m join pm.crews c on c.org_id = m.org_id and c.id = m.crew_id
                        where m.org_id = ce.org_id and m.employee_id = ce.id and c.location_id = w.location_id))
  loop
    v_r := '{}';
    select coalesce(array_agg(r), '{}') into v_missing from unnest(w.required_skills) r
     where not exists (select 1 from pm.employee_skills es join pm.skills s on s.org_id = es.org_id and s.id = es.skill_id
                        where es.org_id = w.org_id and es.employee_id = e.id and s.code = r and s.is_active);
    select coalesce(array_agg(r), '{}') into v_expired from unnest(w.required_skills) r
     where exists (select 1 from pm.employee_skills es join pm.skills s on s.org_id = es.org_id and s.id = es.skill_id
                    where es.org_id = w.org_id and es.employee_id = e.id and s.code = r and es.expires_on is not null and es.expires_on < v_start::date)
       and not exists (select 1 from pm.employee_skills es join pm.skills s on s.org_id = es.org_id and s.id = es.skill_id
                        where es.org_id = w.org_id and es.employee_id = e.id and s.code = r and (es.expires_on is null or es.expires_on >= v_start::date));
    if not e.disp then v_r := v_r || 'not dispatchable'::text; end if;
    if cardinality(v_missing) > 0 then v_r := v_r || ('missing ' || array_to_string(v_missing, ', '))::text; end if;
    if cardinality(v_expired) > 0 then v_r := v_r || ('expired ' || array_to_string(v_expired, ', '))::text; end if;
    if w.business_unit_id is not null and cardinality(coalesce(e.business_unit_ids, '{}')) > 0 and not (w.business_unit_id = any (e.business_unit_ids)) then
      v_r := v_r || 'other business unit'::text;
    end if;
    if exists (select 1 from pm.tech_events te where te.org_id = w.org_id and te.employee_id = e.id and te.slot && tstzrange(v_start, v_end, '[)')) then
      v_r := v_r || 'blocked (PTO / training / meeting)'::text;
    end if;
    if exists (select 1 from pm.dispatch_assignments d where d.org_id = w.org_id and d.employee_id = e.id and d.status <> 'CANCELLED'
                 and d.work_order_id <> w.id and d.slot && tstzrange(v_start, v_end, '[)')) then
      v_r := v_r || 'already booked then'::text;
    end if;
    employee_id := e.id; tech_name := e.nm; reasons := v_r; missing_skills := v_missing; expired_skills := v_expired;
    in_zone := w.zone_id is null or cardinality(coalesce(e.zone_ids, '{}')) = 0 or w.zone_id = any (e.zone_ids);
    on_call := exists (select 1 from pm.on_call_shifts oc where oc.org_id = w.org_id and oc.employee_id = e.id
                         and v_start >= oc.starts_at and v_start < oc.ends_at);
    booked_minutes := coalesce((select (sum(extract(epoch from (upper(d.slot) - lower(d.slot)))) / 60)::int from pm.dispatch_assignments d
                                 where d.org_id = w.org_id and d.employee_id = e.id and d.status <> 'CANCELLED'
                                   and lower(d.slot)::date = v_start::date), 0);
    eligible := cardinality(v_r) = 0;
    return next;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 14. Price book: compute, reprice, import, bulk change, seed
-- ----------------------------------------------------------------------------
-- The ladder of a company as jsonb [{up_to_cents, markup_pct}] (internal).
create or replace function pm._fs_ladder(p_org uuid, p_location uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('up_to_cents', t.up_to_cents, 'markup_pct', t.markup_pct)
                            order by t.up_to_cents nulls last), '[]'::jsonb)
    from pm.pricebook_markup_tiers t where t.org_id = p_org and t.location_id = p_location
$$;

-- Recompute one item (internal). Returns the new row values as jsonb (before → after).
create or replace function pm._fs_price_item(p_item uuid, p_write boolean default true, p_override jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare it pm.price_book_items%rowtype; st pm.pricebook_settings%rowtype; v_ladder jsonb; v_mat_sell bigint := 0; v_mat_cost bigint := 0;
  v_hours numeric; v_gm numeric; v_price bigint; v_member bigint; v_after bigint; v_labor_cost bigint := 0; v_rule text; m record;
  v_cost bigint;
begin
  select * into it from pm.price_book_items x where x.id = p_item;
  if not found then raise exception 'PM_UNKNOWN_ITEM: %', p_item using errcode = 'P0002'; end if;
  select * into st from pm.pricebook_settings x where x.org_id = it.org_id and x.location_id = it.location_id;
  if st.id is null then
    st.burdened_rate_cents := 9500; st.target_gm_pct := 0.55; st.equipment_gm_pct := 0.35; st.member_discount_pct := 0.15;
    st.after_hours_multiplier := 1.5; st.rounding := 'NINE';
  end if;
  v_ladder := pm._fs_ladder(it.org_id, it.location_id);
  v_rule := coalesce(p_override ->> 'rounding', st.rounding);
  v_hours := coalesce((p_override ->> 'task_hours')::numeric, it.task_hours, 0);
  v_gm := coalesce((p_override ->> 'target_gm_pct')::numeric, it.target_gm_pct, st.target_gm_pct);
  v_cost := coalesce((p_override ->> 'cost_cents')::bigint, it.cost_cents, 0);
  if it.kind = 'SERVICE' then
    for m in select sm.qty, coalesce(mi.cost_cents, 0) as cost from pm.pricebook_service_materials sm
               join pm.price_book_items mi on mi.id = sm.material_item_id where sm.service_item_id = it.id loop
      v_mat_sell := v_mat_sell + pm.fs_material_sell(m.qty, m.cost, v_ladder);
      v_mat_cost := v_mat_cost + pm.fs_rdiv(m.qty * m.cost * 1000, 1000);
    end loop;
    v_labor_cost := pm.fs_rdiv(v_hours * st.burdened_rate_cents * 100, 100);
    v_price := pm.fs_service_price(v_hours, st.burdened_rate_cents, v_gm, v_mat_sell, v_rule);
  elsif it.kind = 'MATERIAL' then
    v_mat_cost := v_cost;
    v_price := pm.fs_round_rule(pm.fs_material_sell(1, v_cost, v_ladder), v_rule);
  elsif it.kind = 'EQUIPMENT' then
    v_mat_cost := v_cost;
    v_price := pm.fs_round_rule(pm.fs_rdiv(v_cost * 10000, (1 - coalesce(it.target_gm_pct, st.equipment_gm_pct)) * 10000), v_rule);
  else
    v_mat_cost := v_cost;
    v_price := it.price_cents;
  end if;
  if it.price_locked and not (p_override ? 'unlock') then v_price := it.price_cents; end if;
  if p_override ? 'pct' then v_price := pm.fs_round_rule(pm.fs_rdiv(it.price_cents * (10000 + round((p_override ->> 'pct')::numeric * 10000)), 10000), v_rule); end if;
  v_member := pm.fs_round_rule(pm.fs_rdiv(v_price * (10000 - round(st.member_discount_pct * 10000)), 10000), v_rule);
  if v_member > v_price then v_member := v_price; end if;
  v_after := pm.fs_round_rule(pm.fs_rdiv(v_price * round(st.after_hours_multiplier * 100), 100), v_rule);
  if p_write then
    update pm.price_book_items set price_cents = v_price, member_price_cents = v_member, after_hours_price_cents = v_after,
           material_cost_cents = case when kind = 'SERVICE' then v_mat_cost else material_cost_cents end,
           labor_cost_cents = case when kind = 'SERVICE' then v_labor_cost else labor_cost_cents end,
           cost_cents = case when kind = 'SERVICE' then v_mat_cost + v_labor_cost else cost_cents end,
           task_hours = case when p_override ? 'task_hours' then v_hours else task_hours end,
           target_gm_pct = case when p_override ? 'target_gm_pct' then v_gm else target_gm_pct end,
           priced_at = now()
     where id = it.id;
  end if;
  return jsonb_build_object('id', it.id, 'code', it.code, 'name', it.name, 'kind', it.kind,
    'old_price_cents', it.price_cents, 'price_cents', v_price, 'member_price_cents', v_member, 'after_hours_price_cents', v_after,
    'cost_cents', case when it.kind = 'SERVICE' then v_mat_cost + v_labor_cost else v_mat_cost end,
    'old_cost_cents', coalesce(it.cost_cents, 0),
    'old_margin_pct', case when it.price_cents > 0 then round((it.price_cents - coalesce(it.cost_cents, 0))::numeric / it.price_cents, 4) end,
    'margin_pct', case when v_price > 0 then round((v_price - (case when it.kind = 'SERVICE' then v_mat_cost + v_labor_cost else v_mat_cost end))::numeric / v_price, 4) end);
end $$;

create or replace function pm.fs_reprice_pricebook(p_location uuid, p_item_ids uuid[] default null) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r record; n int := 0;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  -- materials and equipment first (services roll up their materials' cost)
  for r in select x.id from pm.price_book_items x where x.org_id = v_org and x.location_id = p_location and x.is_active
             and (p_item_ids is null or x.id = any (p_item_ids) or x.kind = 'SERVICE')
           order by (x.kind = 'SERVICE'), x.code loop
    perform pm._fs_price_item(r.id, true, '{}'::jsonb);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Bulk change with preview (FS-46). p_filter {category_id, kind, codes[], business_unit_id};
-- p_change {mode: PCT | TARGET_GM | HOURS_PCT | REPRICE, value}. Returns {rows:[…], count, avg_margin_before, avg_margin_after}.
create or replace function pm.fs_bulk_price_change(p_location uuid, p_filter jsonb, p_change jsonb, p_preview boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r record; v_rows jsonb := '[]'::jsonb; v_one jsonb; v_mode text := p_change ->> 'mode'; v_val numeric;
  v_ov jsonb; n int := 0; v_codes text[];
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if v_mode not in ('PCT','TARGET_GM','HOURS_PCT','REPRICE') then raise exception 'PM_INVALID: change mode %', v_mode using errcode = '22023'; end if;
  v_val := nullif(p_change ->> 'value', '')::numeric;
  if v_mode = 'PCT' and (v_val is null or v_val < -0.9 or v_val > 5) then raise exception 'PM_INVALID: percent change between −90%% and +500%%' using errcode = '22023'; end if;
  if v_mode = 'TARGET_GM' and (v_val is null or v_val < 0 or v_val >= 0.95) then raise exception 'PM_INVALID: target margin 0–94%%' using errcode = '22023'; end if;
  if v_mode = 'HOURS_PCT' and (v_val is null or v_val < -0.9 or v_val > 5) then raise exception 'PM_INVALID: hours change between −90%% and +500%%' using errcode = '22023'; end if;
  select coalesce(array_agg(x), null) into v_codes from jsonb_array_elements_text(coalesce(p_filter -> 'codes', '[]'::jsonb)) x;
  for r in select x.* from pm.price_book_items x
            where x.org_id = v_org and x.location_id = p_location and x.is_active
              and (p_filter ->> 'category_id' is null or x.category_id = (p_filter ->> 'category_id')::uuid)
              and (p_filter ->> 'kind' is null or x.kind = p_filter ->> 'kind')
              and (p_filter ->> 'business_unit_id' is null or x.business_unit_id = (p_filter ->> 'business_unit_id')::uuid)
              and (v_codes is null or x.code = any (v_codes))
            order by x.code limit 5000 loop
    v_ov := case v_mode
              when 'PCT' then jsonb_build_object('pct', v_val)
              when 'TARGET_GM' then jsonb_build_object('target_gm_pct', v_val, 'unlock', true)
              when 'HOURS_PCT' then jsonb_build_object('task_hours', round(coalesce(r.task_hours, 0) * (1 + v_val), 2))
              else '{}'::jsonb end;
    v_one := pm._fs_price_item(r.id, not coalesce(p_preview, true), v_ov);
    v_rows := v_rows || v_one;
    n := n + 1;
  end loop;
  return jsonb_build_object('count', n, 'applied', not coalesce(p_preview, true), 'rows', v_rows,
    'avg_margin_before', (select round(avg((x ->> 'old_margin_pct')::numeric), 4) from jsonb_array_elements(v_rows) x),
    'avg_margin_after', (select round(avg((x ->> 'margin_pct')::numeric), 4) from jsonb_array_elements(v_rows) x),
    'below_floor', (select count(*) from jsonb_array_elements(v_rows) x
                     where (x ->> 'margin_pct')::numeric < coalesce((select s.price_floor_gm_pct from pm.pricebook_settings s where s.org_id = v_org and s.location_id = p_location), 0.40)));
end $$;

-- Import rows (Excel / CSV parsed by the app). Upsert by code; dry run returns the report only.
-- Row keys: code, name, kind, category (code), business_unit (code), unit, task_hours, cost_cents,
-- price_cents (FEE / locked), price_locked, target_gm_pct, customer_description, materials ("CODE:qty;CODE:qty"), active.
create or replace function pm.fs_import_pricebook(p_location uuid, p_rows jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r jsonb; i int := 0; v_errs jsonb := '[]'::jsonb; v_ins int := 0; v_upd int := 0; v_same int := 0; v_code text;
  v_kind text; v_cat uuid; v_bu uuid; v_existing pm.price_book_items%rowtype; v_id uuid; v_mat text; v_mcode text; v_mqty numeric;
  v_mid uuid; v_changed boolean; v_ids uuid[] := '{}'; v_err text; rec record;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'PM_INVALID: rows must be a list of at most 10,000' using errcode = '22023';
  end if;
  -- pass 1: items (materials before services so bundles resolve)
  for rec in select t.x, t.n from jsonb_array_elements(p_rows) with ordinality as t(x, n) order by (upper(coalesce(t.x ->> 'kind', 'SERVICE')) = 'SERVICE'), t.n loop
    r := rec.x; i := rec.n;
    v_err := null;
    v_code := upper(btrim(coalesce(r ->> 'code', '')));
    v_kind := upper(coalesce(nullif(btrim(r ->> 'kind'), ''), 'SERVICE'));
    if v_code = '' or length(v_code) > 24 then v_err := 'code is required (24 characters at most)';
    elsif nullif(btrim(coalesce(r ->> 'name', '')), '') is null then v_err := 'name is required';
    elsif v_kind not in ('SERVICE','MATERIAL','EQUIPMENT','FEE','MEMBERSHIP') then v_err := format('kind %s is not SERVICE / MATERIAL / EQUIPMENT / FEE', v_kind);
    elsif coalesce(r ->> 'task_hours', '') <> '' and (r ->> 'task_hours') !~ '^\d{1,3}(\.\d{1,2})?$' then v_err := 'task hours must be a number like 1.5';
    elsif coalesce(r ->> 'cost_cents', '') <> '' and (r ->> 'cost_cents') !~ '^\d{1,12}$' then v_err := 'cost must be whole cents';
    elsif coalesce(r ->> 'price_cents', '') <> '' and (r ->> 'price_cents') !~ '^\d{1,12}$' then v_err := 'price must be whole cents';
    elsif coalesce(r ->> 'target_gm_pct', '') <> '' and ((r ->> 'target_gm_pct') !~ '^0?\.\d{1,4}$' or (r ->> 'target_gm_pct')::numeric >= 0.95) then v_err := 'target margin must be a fraction below 0.95';
    end if;
    v_cat := null; v_bu := null;
    if v_err is null and nullif(btrim(coalesce(r ->> 'category', '')), '') is not null then
      select c.id into v_cat from pm.pricebook_categories c where c.org_id = v_org and c.location_id = p_location and c.code = upper(btrim(r ->> 'category'));
      if v_cat is null then v_err := format('category %s does not exist', r ->> 'category'); end if;
    end if;
    if v_err is null and nullif(btrim(coalesce(r ->> 'business_unit', '')), '') is not null then
      select b.id into v_bu from pm.business_units b where b.org_id = v_org and b.location_id = p_location and b.code = upper(btrim(r ->> 'business_unit'));
      if v_bu is null then v_err := format('business unit %s does not exist', r ->> 'business_unit'); end if;
    end if;
    if v_err is not null then
      v_errs := v_errs || jsonb_build_object('row', i, 'code', v_code, 'error', v_err);
      continue;
    end if;
    select * into v_existing from pm.price_book_items x where x.org_id = v_org and x.location_id = p_location and x.code = v_code;
    if v_existing.id is null then
      v_ins := v_ins + 1;
      if not p_dry_run then
        insert into pm.price_book_items (org_id, location_id, code, name, unit, kind, category_id, business_unit_id, task_hours, cost_cents,
                                         price_cents, price_locked, target_gm_pct, customer_description, is_active)
        values (v_org, p_location, v_code, btrim(r ->> 'name'), coalesce(nullif(btrim(r ->> 'unit'), ''), 'EA'), v_kind, v_cat, v_bu,
                nullif(r ->> 'task_hours', '')::numeric, nullif(r ->> 'cost_cents', '')::bigint, coalesce(nullif(r ->> 'price_cents', '')::bigint, 0),
                coalesce((r ->> 'price_locked')::boolean, v_kind = 'FEE'), nullif(r ->> 'target_gm_pct', '')::numeric,
                nullif(btrim(r ->> 'customer_description'), ''), coalesce((r ->> 'active')::boolean, true))
        returning id into v_id;
        v_ids := v_ids || v_id;
      end if;
    else
      v_changed := v_existing.name is distinct from btrim(r ->> 'name')
        or v_existing.kind is distinct from v_kind
        or v_existing.category_id is distinct from coalesce(v_cat, v_existing.category_id)
        or v_existing.task_hours is distinct from coalesce(nullif(r ->> 'task_hours', '')::numeric, v_existing.task_hours)
        or v_existing.cost_cents is distinct from coalesce(nullif(r ->> 'cost_cents', '')::bigint, v_existing.cost_cents)
        or (coalesce((r ->> 'price_locked')::boolean, v_existing.price_locked) and v_existing.price_cents is distinct from coalesce(nullif(r ->> 'price_cents', '')::bigint, v_existing.price_cents))
        or v_existing.is_active is distinct from coalesce((r ->> 'active')::boolean, v_existing.is_active);
      if v_changed then v_upd := v_upd + 1; else v_same := v_same + 1; end if;
      if not p_dry_run and v_changed then
        update pm.price_book_items set name = btrim(r ->> 'name'), kind = v_kind, category_id = coalesce(v_cat, category_id),
               business_unit_id = coalesce(v_bu, business_unit_id), unit = coalesce(nullif(btrim(r ->> 'unit'), ''), unit),
               task_hours = coalesce(nullif(r ->> 'task_hours', '')::numeric, task_hours), cost_cents = coalesce(nullif(r ->> 'cost_cents', '')::bigint, cost_cents),
               price_locked = coalesce((r ->> 'price_locked')::boolean, price_locked),
               price_cents = case when coalesce((r ->> 'price_locked')::boolean, price_locked) then coalesce(nullif(r ->> 'price_cents', '')::bigint, price_cents) else price_cents end,
               target_gm_pct = coalesce(nullif(r ->> 'target_gm_pct', '')::numeric, target_gm_pct),
               customer_description = coalesce(nullif(btrim(r ->> 'customer_description'), ''), customer_description),
               is_active = coalesce((r ->> 'active')::boolean, is_active)
         where id = v_existing.id;
        v_ids := v_ids || v_existing.id;
      end if;
    end if;
  end loop;
  -- pass 2: bundled materials ("CODE:qty;CODE:qty")
  i := 0;
  for r in select x from jsonb_array_elements(p_rows) x loop
    i := i + 1;
    continue when nullif(btrim(coalesce(r ->> 'materials', '')), '') is null;
    select x.id into v_id from pm.price_book_items x where x.org_id = v_org and x.location_id = p_location and x.code = upper(btrim(coalesce(r ->> 'code', '')));
    foreach v_mat in array string_to_array(r ->> 'materials', ';') loop
      continue when btrim(v_mat) = '';
      v_mcode := upper(btrim(split_part(v_mat, ':', 1)));
      v_mqty := coalesce(nullif(btrim(split_part(v_mat, ':', 2)), '')::numeric, 1);
      select x.id into v_mid from pm.price_book_items x where x.org_id = v_org and x.location_id = p_location and x.code = v_mcode;
      if v_mid is null and not exists (select 1 from jsonb_array_elements(p_rows) y where upper(btrim(y ->> 'code')) = v_mcode) then
        v_errs := v_errs || jsonb_build_object('row', i, 'code', upper(btrim(r ->> 'code')), 'error', format('material %s does not exist', v_mcode));
      elsif not p_dry_run and v_id is not null and v_mid is not null then
        insert into pm.pricebook_service_materials (org_id, service_item_id, material_item_id, qty) values (v_org, v_id, v_mid, v_mqty)
        on conflict (service_item_id, material_item_id) do update set qty = excluded.qty;
      end if;
    end loop;
  end loop;
  if not p_dry_run and cardinality(v_ids) > 0 then perform pm.fs_reprice_pricebook(p_location, v_ids); end if;
  return jsonb_build_object('rows', jsonb_array_length(p_rows), 'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same,
                            'errors', v_errs, 'error_count', jsonb_array_length(v_errs), 'dry_run', p_dry_run);
end $$;

-- ----------------------------------------------------------------------------
-- 15. Good / better / best
-- ----------------------------------------------------------------------------
-- p_options: [{tier, name, description, rebate_cents, rebate_note, financing_plan_id, recommended,
--              items:[{price_book_item_id | description + unit_price_cents, qty, optional, selected}]}]
create or replace function pm.fs_build_estimate(p_wo uuid, p_title text, p_options jsonb, p_member_pricing boolean default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_est uuid; o jsonb; it jsonb; v_opt uuid; pb pm.price_book_items%rowtype; v_cust uuid; k int := 0; j int;
  v_member boolean;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) not between 1 and 5 then
    raise exception 'PM_INVALID: build 1 to 5 options' using errcode = '22023';
  end if;
  select j2.customer_id into v_cust from core.jobs j2 where j2.org_id = w.org_id and j2.id = w.job_id;
  v_member := coalesce(p_member_pricing, exists (select 1 from pm.service_agreements g where g.org_id = w.org_id and g.customer_id = v_cust
                                                   and g.status = 'ACTIVE' and not g.entitlements_suspended));
  insert into pm.fs_estimates (org_id, location_id, job_id, work_order_id, title, customer_id, member_pricing, valid_until, created_by)
  values (w.org_id, w.location_id, w.job_id, w.id, left(coalesce(nullif(btrim(p_title), ''), w.summary), 160), v_cust, v_member,
          current_date + 30, pm.current_user_id())
  returning id into v_est;
  for o in select x from jsonb_array_elements(p_options) x loop
    k := k + 1;
    if jsonb_typeof(o -> 'items') <> 'array' or jsonb_array_length(o -> 'items') = 0 then
      raise exception 'PM_INVALID: option % has no items', k using errcode = '22023';
    end if;
    insert into pm.fs_estimate_options (org_id, job_id, estimate_id, tier, sort, name, description, rebate_cents, rebate_note,
                                        financing_plan_id, recommended)
    values (w.org_id, w.job_id, v_est, coalesce(upper(o ->> 'tier'), 'OPTION'), k,
            left(coalesce(nullif(btrim(o ->> 'name'), ''), 'Option ' || k), 120), nullif(btrim(o ->> 'description'), ''),
            coalesce((o ->> 'rebate_cents')::bigint, 0), nullif(btrim(o ->> 'rebate_note'), ''),
            nullif(o ->> 'financing_plan_id', '')::uuid, coalesce((o ->> 'recommended')::boolean, false))
    returning id into v_opt;
    j := 0;
    for it in select x from jsonb_array_elements(o -> 'items') x loop
      j := j + 1;
      pb := null;
      if nullif(it ->> 'price_book_item_id', '') is not null then
        select * into pb from pm.price_book_items x where x.id = (it ->> 'price_book_item_id')::uuid and x.org_id = w.org_id
                                                       and x.location_id = w.location_id and x.is_active;
        if pb.id is null then raise exception 'PM_PRICE_BOOK_SCOPE: item % is not in this company''s price book', it ->> 'price_book_item_id' using errcode = '23514'; end if;
      elsif nullif(btrim(it ->> 'description'), '') is null then
        raise exception 'PM_INVALID: option % item % needs a price-book item or a description', k, j using errcode = '22023';
      end if;
      insert into pm.fs_estimate_option_items (org_id, job_id, option_id, sort, price_book_item_id, kind, description, qty, unit_price_cents,
                                               member_unit_price_cents, unit_cost_cents, is_optional, is_selected)
      values (w.org_id, w.job_id, v_opt, j, pb.id,
              case pb.kind when 'MATERIAL' then 'PART' when 'EQUIPMENT' then 'EQUIPMENT' when 'FEE' then 'FEE' else 'SERVICE' end,
              left(coalesce(nullif(btrim(it ->> 'description'), ''), pb.name), 300), coalesce((it ->> 'qty')::numeric, 1),
              coalesce(pb.price_cents, (it ->> 'unit_price_cents')::bigint, 0),
              coalesce(pb.member_price_cents, pb.price_cents, (it ->> 'unit_price_cents')::bigint),
              pb.cost_cents, coalesce((it ->> 'optional')::boolean, false),
              coalesce((it ->> 'selected')::boolean, not coalesce((it ->> 'optional')::boolean, false)));
    end loop;
  end loop;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'fs_estimate.built', 'fs_estimates', v_est,
    format('Built %s option(s) on %s', k, w.number), jsonb_build_object('work_order_id', w.id, 'options', k));
  return v_est;
end $$;

-- Option totals (sell only — no cost): regular, member, rebate, net, monthly payment.
create or replace view pm.v_fs_option_totals with (security_invoker = on) as
select o.org_id, o.job_id, o.estimate_id, o.id as option_id, o.tier, o.sort, o.name, o.status, o.rebate_cents, o.financing_plan_id,
       coalesce(sum(round(i.qty * i.unit_price_cents)) filter (where i.is_selected), 0)::bigint as regular_cents,
       coalesce(sum(round(i.qty * coalesce(i.member_unit_price_cents, i.unit_price_cents))) filter (where i.is_selected), 0)::bigint as member_cents,
       count(*) filter (where i.is_optional)::int as optional_count
  from pm.fs_estimate_options o
  left join pm.fs_estimate_option_items i on i.org_id = o.org_id and i.option_id = o.id
 group by o.org_id, o.job_id, o.estimate_id, o.id, o.tier, o.sort, o.name, o.status, o.rebate_cents, o.financing_plan_id;

-- Toggle optional add-ons on an option (customer ticks them on / off — totals update live).
create or replace function pm.fs_toggle_option_item(p_item uuid, p_selected boolean) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.fs_estimate_option_items%rowtype; e pm.fs_estimates%rowtype;
begin
  select * into i from pm.fs_estimate_option_items x where x.id = p_item;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: item % not found in the caller''s organization', p_item using errcode = '42501';
  end if;
  select e2.* into e from pm.fs_estimates e2 join pm.fs_estimate_options o on o.org_id = e2.org_id and o.estimate_id = e2.id where o.id = i.option_id;
  if e.status not in ('DRAFT','PRESENTED') then raise exception 'PM_FS_ESTIMATE_LOCKED: % is %', e.number, e.status using errcode = '55000'; end if;
  if not i.is_optional then raise exception 'PM_INVALID: only optional add-ons can be ticked off' using errcode = '22023'; end if;
  update pm.fs_estimate_option_items set is_selected = coalesce(p_selected, true) where id = i.id;
  return i.id;
end $$;

create or replace function pm.fs_present_estimate(p_estimate uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status not in ('DRAFT','PRESENTED') then raise exception 'PM_FS_ESTIMATE_LOCKED: % is %', e.number, e.status using errcode = '55000'; end if;
  update pm.fs_estimates set status = 'PRESENTED', presented_at = coalesce(presented_at, now()) where id = e.id;
  return e.id;
end $$;

-- Membership on site from a template (FS-34 / FS-60): a recurring-service job, the agreement, active.
create or replace function pm.fs_create_agreement_from_template(p_template uuid, p_customer uuid, p_location uuid, p_job uuid default null,
                                                                p_starts_on date default null, p_site uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.agreement_templates%rowtype; v_org uuid; v_job uuid := p_job; v_id uuid; v_start date := coalesce(p_starts_on, current_date);
  v_jt text; v_name text;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  select * into t from pm.agreement_templates x where x.id = p_template and x.org_id = v_org and x.location_id = p_location and x.is_active;
  if not found then raise exception 'PM_FS_UNKNOWN_TEMPLATE: pick a plan this company sells' using errcode = 'P0002'; end if;
  if not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: customer % is not in the caller''s organization', p_customer using errcode = '42501';
  end if;
  if v_job is null then
    v_jt := coalesce(t.job_type_key, (select jt.key from pm.job_types jt where jt.org_id = v_org and jt.location_id = p_location and jt.is_active
                                       order by (jt.archetype = 'recurring_service') desc, jt.sort, jt.key limit 1));
    v_name := left(t.plan_name || coalesce(' · ' || (select coalesce(c.display_name, c.name) from core.customers c where c.id = p_customer), ''), 120);
    v_job := pm.create_project(p_location, v_jt, v_name, p_customer, null);
  end if;
  insert into pm.service_agreements (org_id, location_id, job_id, customer_id, plan_name, tier, status, starts_on, ends_on, cadence,
      interval_months, visits_per_term, visit_window_days, visit_minutes, required_skills, price_cents, billing_frequency,
      member_discount_pct, auto_renew, template_id, revenue_policy, visits_included, site_id, activated_at, created_by)
  values (v_org, p_location, v_job, p_customer, t.plan_name, t.tier, 'ACTIVE', v_start, (v_start + make_interval(months => t.term_months))::date,
      t.cadence, t.interval_months, t.visits_per_term, t.visit_window_days, t.visit_minutes, t.required_skills, t.price_cents,
      t.billing_frequency, t.member_discount_pct, t.auto_renew, t.id, t.revenue_policy, t.visits_per_term, p_site, now(), pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(v_org, p_location, v_job, 'agreement.sold', 'service_agreements', v_id,
    format('Sold %s', t.plan_name), jsonb_build_object('template_id', t.id));
  return v_id;
end $$;

-- Sell: the customer picks options and signs. Sold options → APPROVED work-order lines (member price
-- when member pricing applies), unsold → DISMISSED with the reason. Optional deposit request and
-- membership on site. Returns {estimate_id, lines, agreement_id, deposit_request_id}.
create or replace function pm.fs_sell_estimate(
  p_estimate uuid, p_option_ids uuid[], p_signed_name text, p_dismiss_reason text default null, p_join_template uuid default null,
  p_deposit_cents bigint default 0, p_request_deposit boolean default false, p_deposit_ref text default null,
  p_financing_plan uuid default null, p_sold_by_employee uuid default null, p_signature_document uuid default null
) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype; w pm.work_orders%rowtype; v_member boolean; v_agr uuid; it record; n int := 0; v_dep uuid; v_sort int;
  v_seller uuid := p_sold_by_employee;
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
  select * into w from pm.work_orders x where x.org_id = e.org_id and x.id = e.work_order_id for update;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if v_seller is null then
    select d.employee_id into v_seller from pm.dispatch_assignments d
     where d.org_id = e.org_id and d.work_order_id = w.id and d.status <> 'CANCELLED' and d.employee_id is not null
     order by (d.employee_id in (select pm.my_employee_ids())) desc, d.is_lead desc, d.created_at limit 1;
  end if;
  v_member := e.member_pricing;
  if p_join_template is not null and e.customer_id is not null then
    v_agr := pm.fs_create_agreement_from_template(p_join_template, e.customer_id, e.location_id, null, current_date, w.site_id);
    v_member := true;
  end if;
  select coalesce(max(l.sort), 0) into v_sort from pm.work_order_lines l where l.org_id = e.org_id and l.work_order_id = w.id;
  for it in select i.* from pm.fs_estimate_option_items i
             where i.org_id = e.org_id and i.option_id = any (p_option_ids) and i.is_selected order by i.option_id, i.sort loop
    v_sort := v_sort + 1;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, price_book_item_id, description, qty, unit_price_cents,
                                     unit_cost_cents, status, decided_at, decided_by_name, sold_by_employee_id, fs_option_item_id, created_by)
    values (e.org_id, e.job_id, w.id, v_sort, case it.kind when 'DISCOUNT' then 'DISCOUNT' else it.kind end, it.price_book_item_id, it.description,
            it.qty, case when v_member then coalesce(it.member_unit_price_cents, it.unit_price_cents) else it.unit_price_cents end,
            it.unit_cost_cents, 'APPROVED', now(), btrim(p_signed_name), v_seller, it.id, pm.current_user_id());
    n := n + 1;
  end loop;
  update pm.fs_estimate_options set status = case when id = any (p_option_ids) then 'SOLD' else 'DISMISSED' end,
         dismiss_reason = case when id = any (p_option_ids) then null else coalesce(nullif(btrim(coalesce(p_dismiss_reason, '')), ''), 'Not chosen') end
   where org_id = e.org_id and estimate_id = e.id;
  if coalesce(p_request_deposit, false) and coalesce(p_deposit_cents, 0) > 0 then
    if not pm.access_can_job('projects.billing', 'create', e.job_id) then
      raise exception 'PM_FORBIDDEN: requesting a deposit from Books requires projects.billing:create on this job' using errcode = '42501';
    end if;
    v_dep := pm.request_deposit(e.job_id, p_deposit_cents, format('Deposit for %s', e.number), current_date);
  end if;
  update pm.fs_estimates set status = 'SOLD', sold_option_ids = p_option_ids, signed_name = btrim(p_signed_name), signed_at = now(),
         sold_at = now(), deposit_cents = coalesce(p_deposit_cents, 0), deposit_ref = p_deposit_ref, deposit_request_id = v_dep,
         financing_plan_id = coalesce(p_financing_plan, financing_plan_id), agreement_id = v_agr, member_pricing = v_member,
         sold_by_employee_id = v_seller, signature_document_id = p_signature_document
   where id = e.id;
  update pm.fs_tgl_leads set status = 'SOLD', estimate_id = e.id,
         sold_cents = (select coalesce(sum(case when v_member then member_cents else regular_cents end), 0) from pm.v_fs_option_totals t where t.option_id = any (p_option_ids))
   where org_id = e.org_id and job_id = e.job_id and status in ('OPEN','APPOINTMENT');
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'fs_estimate.sold', 'fs_estimates', e.id,
    format('Sold %s (%s line(s) to %s)', e.number, n, w.number),
    jsonb_build_object('options', to_jsonb(p_option_ids), 'member', v_member, 'agreement_id', v_agr, 'deposit_request_id', v_dep));
  return jsonb_build_object('estimate_id', e.id, 'lines', n, 'agreement_id', v_agr, 'deposit_request_id', v_dep, 'member_pricing', v_member);
end $$;

create or replace function pm.fs_decline_estimate(p_estimate uuid, p_reason text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.fs_estimates%rowtype;
begin
  select * into e from pm.fs_estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: estimate % not found in the caller''s organization', p_estimate using errcode = '42501';
  end if;
  if e.status not in ('DRAFT','PRESENTED') then raise exception 'PM_FS_ESTIMATE_LOCKED: % is %', e.number, e.status using errcode = '55000'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: say why it was declined' using errcode = '22023'; end if;
  update pm.fs_estimates set status = 'DECLINED', decline_reason = btrim(p_reason) where id = e.id;
  update pm.fs_estimate_options set status = 'DISMISSED', dismiss_reason = btrim(p_reason) where org_id = e.org_id and estimate_id = e.id;
  return e.id;
end $$;

-- Tech-generated lead (FS-38).
create or replace function pm.fs_set_tgl(p_wo uuid, p_reason text, p_interest text default 'MEDIUM', p_asset uuid default null,
                                         p_employee uuid default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_emp uuid := p_employee; v_id uuid;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if v_emp is null then select x into v_emp from pm.my_employee_ids() x limit 1; end if;
  if v_emp is null then
    select d.employee_id into v_emp from pm.dispatch_assignments d where d.org_id = w.org_id and d.work_order_id = w.id
       and d.status <> 'CANCELLED' and d.employee_id is not null order by d.is_lead desc limit 1;
  end if;
  if v_emp is null then raise exception 'PM_INVALID: who set the lead?' using errcode = '22023'; end if;
  insert into pm.fs_tgl_leads (org_id, location_id, job_id, work_order_id, set_by_employee_id, asset_id, reason, interest, created_by)
  values (w.org_id, w.location_id, w.job_id, w.id, v_emp, coalesce(p_asset, w.asset_id), left(btrim(p_reason), 500),
          coalesce(upper(p_interest), 'MEDIUM'), pm.current_user_id())
  returning id into v_id;
  perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'tgl.set', 'fs_tgl_leads', v_id, format('Lead set on %s', w.number),
    jsonb_build_object('employee_id', v_emp, 'interest', p_interest));
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 16. Agreements: billing schedule → billing requests, revenue facts, recognition, dunning, import
-- ----------------------------------------------------------------------------
create or replace function pm._fs_period_months(p_freq text) returns int
language sql immutable
set search_path = pm, public
as $$ select case p_freq when 'MONTHLY' then 1 when 'QUARTERLY' then 3 when 'ANNUAL' then 12 else 0 end $$;

-- Term total (Σ billing periods).
create or replace function pm._fs_term_total(a pm.service_agreements) returns bigint
language sql stable
set search_path = pm, public
as $$
  select case when pm._fs_period_months(a.billing_frequency) = 0 then a.price_cents
              else a.price_cents * greatest(1, ceil(((extract(year from age(a.ends_on, a.starts_on)) * 12 + extract(month from age(a.ends_on, a.starts_on)))
                                                    + case when extract(day from age(a.ends_on, a.starts_on)) > 0 then 1 else 0 end)
                                                   / pm._fs_period_months(a.billing_frequency)::numeric))::bigint end
$$;

-- Build the billing schedule and draft one recurring billing request per period due by p_through
-- (idempotent per agreement × period). Ensures a SERVICE_AGREEMENT contract on the job covers the term.
create or replace function pm.fs_generate_agreement_billing(p_agreement uuid, p_through date default null) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype; v_months int; v_k int := 0; v_start date; v_end date; v_through date := coalesce(p_through, current_date);
  s record; v_req uuid; n int := 0; v_total bigint;
begin
  select * into a from pm.service_agreements x where x.id = p_agreement for update;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: agreement % not found in the caller''s organization', p_agreement using errcode = '42501';
  end if;
  if a.status not in ('ACTIVE','SUSPENDED') then raise exception 'PM_AGREEMENT_NOT_ACTIVE: % is %', a.number, a.status using errcode = '22023'; end if;
  v_months := pm._fs_period_months(a.billing_frequency);
  v_total := pm._fs_term_total(a);
  -- schedule rows (whole term)
  v_start := a.starts_on;
  loop
    v_k := v_k + 1;
    exit when v_k > 240;
    v_end := case when v_months = 0 then a.ends_on - 1 else least((v_start + make_interval(months => v_months))::date - 1, a.ends_on - 1) end;
    insert into pm.agreement_billing_schedule (org_id, job_id, agreement_id, period_no, period_start, period_end, bill_on, amount_cents)
    values (a.org_id, a.job_id, a.id, v_k, v_start, v_end, v_start, a.price_cents)
    on conflict (org_id, agreement_id, period_no) do nothing;
    exit when v_months = 0 or v_end >= a.ends_on - 1;
    v_start := v_end + 1;
  end loop;
  -- the contract Books bills against (one per agreement term)
  if not exists (select 1 from pm.contracts k where k.org_id = a.org_id and k.job_id = a.job_id and k.source_ref = 'pm:agr:' || a.id::text) then
    insert into pm.contracts (org_id, job_id, kind, title, original_cents, billing_mode, status, source_ref, customer_id, created_by)
    values (a.org_id, a.job_id, 'SERVICE_AGREEMENT', a.plan_name || ' ' || a.number, v_total, 'RECURRING', 'ACTIVE', 'pm:agr:' || a.id::text,
            a.customer_id, pm.current_user_id());
  end if;
  -- requests for due periods
  for s in select * from pm.agreement_billing_schedule x
            where x.org_id = a.org_id and x.agreement_id = a.id and x.status = 'SCHEDULED' and x.bill_on <= v_through and x.billing_request_id is null
            order by x.period_no loop
    v_req := gen_random_uuid();
    insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, billing_subtype, status, period_start, period_end,
                                     occurred_on, memo, created_by)
    values (v_req, a.org_id, a.job_id, (select k.id from pm.contracts k where k.org_id = a.org_id and k.source_ref = 'pm:agr:' || a.id::text),
            'MILESTONE', 'RECURRING', 'DRAFT', s.period_start, s.period_end, s.bill_on,
            format('%s %s · period %s (%s – %s)', a.plan_name, a.number, s.period_no, s.period_start, s.period_end), pm.current_user_id());
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents)
    values (a.org_id, v_req, 1, 0, 'STANDARD', format('%s membership · %s to %s', a.plan_name, s.period_start, s.period_end), s.amount_cents);
    update pm.agreement_billing_schedule set billing_request_id = v_req, status = 'REQUESTED' where id = s.id;
    insert into pm.agreement_revenue_facts (org_id, location_id, job_id, agreement_id, kind, occurred_on, amount_cents, billing_request_id, source_ref)
    values (a.org_id, a.location_id, a.job_id, a.id, 'BILLED', s.bill_on, s.amount_cents, v_req, format('pm:agrrev:%s:billed:%s', a.id, s.period_no))
    on conflict (org_id, source_ref) do nothing;
    n := n + 1;
  end loop;
  if n > 0 then
    perform pm.log_activity(a.org_id, a.location_id, a.job_id, 'agreement.billing_requested', 'service_agreements', a.id,
      format('%s: %s billing request(s) drafted', a.number, n), jsonb_build_object('through', v_through));
  end if;
  return n;
end $$;

-- Visit delivered → recognized revenue for a per-visit agreement (allocation; the last visit takes the remainder).
create or replace function pm.tg_fs_visit_delivered() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.service_agreements%rowtype; v_n int; v_total bigint; v_each bigint; v_done int; v_amt bigint;
begin
  if new.agreement_id is null or new.status <> 'COMPLETE' or old.status in ('COMPLETE','CLOSED') then return new; end if;
  select * into a from pm.service_agreements x where x.org_id = new.org_id and x.id = new.agreement_id;
  if a.id is null or a.revenue_policy <> 'PER_VISIT' then return new; end if;
  v_n := greatest(coalesce(a.visits_included, a.visits_per_term, 1), 1);
  v_total := pm._fs_term_total(a);
  v_each := v_total / v_n;
  select count(*)::int into v_done from pm.agreement_revenue_facts f where f.org_id = a.org_id and f.agreement_id = a.id and f.kind = 'VISIT_DELIVERED';
  v_done := v_done + coalesce((select sum(f.visits_delivered) from pm.agreement_revenue_facts f where f.org_id = a.org_id and f.agreement_id = a.id and f.kind = 'OPENING_BALANCE'), 0)::int;
  if v_done >= v_n then return new; end if;
  v_amt := case when v_done + 1 = v_n then v_total - v_each * (v_n - 1) else v_each end;
  insert into pm.agreement_revenue_facts (org_id, location_id, job_id, agreement_id, kind, occurred_on, amount_cents, visits_delivered, work_order_id, source_ref)
  values (a.org_id, a.location_id, a.job_id, a.id, 'VISIT_DELIVERED', current_date, v_amt, 1, new.id, format('pm:agrrev:%s:visit:%s', a.id, new.id))
  on conflict (org_id, source_ref) do nothing;
  return new;
end $$;
create or replace trigger trg_fs_visit_delivered after update of status on pm.work_orders
  for each row execute function pm.tg_fs_visit_delivered();

-- Cancellation → refund / write-down of the unrecognized balance; expiry → breakage of unused visits.
create or replace function pm.tg_fs_agreement_status_facts() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_billed bigint; v_rec bigint; v_kind text;
begin
  if new.status = old.status or new.status not in ('CANCELLED','EXPIRED') then return new; end if;
  v_kind := case new.status when 'CANCELLED' then 'CANCEL_REFUND' else 'BREAKAGE' end;
  select coalesce(sum(f.amount_cents) filter (where f.kind in ('BILLED','OPENING_BALANCE')), 0),
         coalesce(sum(f.amount_cents) filter (where f.kind in ('VISIT_DELIVERED','STRAIGHT_LINE','CANCEL_REFUND','BREAKAGE')), 0)
    into v_billed, v_rec
    from pm.agreement_revenue_facts f where f.org_id = new.org_id and f.agreement_id = new.id;
  if v_billed - v_rec > 0 then
    insert into pm.agreement_revenue_facts (org_id, location_id, job_id, agreement_id, kind, occurred_on, amount_cents, source_ref)
    values (new.org_id, new.location_id, new.job_id, new.id, v_kind, current_date, v_billed - v_rec, format('pm:agrrev:%s:%s', new.id, lower(v_kind)))
    on conflict (org_id, source_ref) do nothing;
  end if;
  return new;
end $$;
create or replace trigger trg_fs_agreement_status_facts after update of status on pm.service_agreements
  for each row execute function pm.tg_fs_agreement_status_facts();

-- Straight-line recognition through a date (monthly facts, idempotent per agreement × month).
create or replace function pm.fs_recognize_straight_line(p_location uuid, p_through date default null) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; a pm.service_agreements%rowtype; v_through date := coalesce(p_through, current_date); v_total bigint; v_months int;
  m int; v_amt bigint; v_month date; n int := 0;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  for a in select x.* from pm.service_agreements x where x.org_id = v_org and x.location_id = p_location
             and x.revenue_policy = 'STRAIGHT_LINE' and x.status in ('ACTIVE','SUSPENDED','RENEWED','EXPIRED') loop
    v_total := pm._fs_term_total(a);
    v_months := greatest(1, (extract(year from age(a.ends_on, a.starts_on)) * 12 + extract(month from age(a.ends_on, a.starts_on)))::int);
    for m in 1 .. v_months loop
      v_month := (a.starts_on + make_interval(months => m))::date - 1;      -- month m ends
      exit when v_month > v_through;
      v_amt := case when m = v_months then v_total - (v_total / v_months) * (v_months - 1) else v_total / v_months end;
      insert into pm.agreement_revenue_facts (org_id, location_id, job_id, agreement_id, kind, occurred_on, amount_cents, source_ref)
      values (a.org_id, a.location_id, a.job_id, a.id, 'STRAIGHT_LINE', v_month, v_amt, format('pm:agrrev:%s:sl:%s', a.id, m))
      on conflict (org_id, source_ref) do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

-- Dunning (FS-62): Books issues and collects; Projects reads the invoice state back, counts
-- failures past the grace days, texts the customer and suspends entitlements after N failures.
create or replace function pm.fs_run_dunning(p_location uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; s record; v_grace int; v_paid boolean; v_late boolean; n_fail int := 0; n_paid int := 0; n_susp int := 0; v_limit int;
  v_inv uuid; v_bal bigint; v_due date;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  select coalesce(x.dunning_grace_days, 7) into v_grace from pm.fs_settings x where x.org_id = v_org and x.location_id = p_location;
  v_grace := coalesce(v_grace, 7);
  for s in select b.*, r.invoice_id, a.customer_id, a.number as agr_number, a.template_id, a.location_id as loc
             from pm.agreement_billing_schedule b
             join pm.service_agreements a on a.org_id = b.org_id and a.id = b.agreement_id
             join pm.billing_requests r on r.org_id = b.org_id and r.id = b.billing_request_id
            where b.org_id = v_org and a.location_id = p_location and b.status in ('REQUESTED','FAILED') and r.invoice_id is not null loop
    v_paid := false; v_late := false;
    if to_regclass('public.invoices') is not null then
      execute 'select i.balance_cents, i.due_date from public.invoices i where i.id = $1 and i.org_id = $2' into v_bal, v_due using s.invoice_id, v_org;
      v_paid := v_bal is not null and v_bal <= 0;
      v_late := v_bal is not null and v_bal > 0 and v_due + v_grace < current_date;
    end if;
    if v_paid then
      update pm.agreement_billing_schedule set status = 'PAID' where id = s.id;
      n_paid := n_paid + 1;
    elsif v_late and s.status <> 'FAILED' then
      update pm.agreement_billing_schedule set status = 'FAILED', attempts = attempts + 1 where id = s.id;
      update pm.service_agreements set failed_payment_count = failed_payment_count + 1 where id = s.agreement_id;
      perform pm._fs_queue_message(v_org, s.loc, 'DUNNING', s.customer_id, null, s.agreement_id,
        format('Your membership payment for %s did not go through. Update your card to keep your benefits.', s.agr_number),
        format('dun:%s:%s', s.id, s.attempts + 1), now());
      n_fail := n_fail + 1;
    end if;
  end loop;
  -- suspend after N failures (template, default 3)
  for s in select a.id, a.failed_payment_count, coalesce(t.suspend_after_failures, 3) as lim from pm.service_agreements a
             left join pm.agreement_templates t on t.org_id = a.org_id and t.id = a.template_id
            where a.org_id = v_org and a.location_id = p_location and a.status = 'ACTIVE' and not a.entitlements_suspended loop
    if s.failed_payment_count >= s.lim then
      update pm.service_agreements set entitlements_suspended = true where id = s.id;
      n_susp := n_susp + 1;
    end if;
  end loop;
  return jsonb_build_object('paid', n_paid, 'failed', n_fail, 'suspended', n_susp);
end $$;

-- Bulk-book owed visits into a day / window (FS-61), capacity checked under the visit's BU.
create or replace function pm.fs_bulk_book_visits(p_wo_ids uuid[], p_service_day date, p_arrival_window uuid, p_business_unit uuid,
                                                  p_override_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare x uuid; w pm.work_orders%rowtype; v_ok jsonb := '[]'::jsonb; v_fail jsonb := '[]'::jsonb; aw pm.arrival_windows%rowtype; v_state jsonb;
  v_tz text;
begin
  if p_wo_ids is null or cardinality(p_wo_ids) = 0 or cardinality(p_wo_ids) > 200 then
    raise exception 'PM_INVALID: pick 1 to 200 visits' using errcode = '22023';
  end if;
  foreach x in array p_wo_ids loop
    select * into w from pm.work_orders y where y.id = x for update;
    if w.org_id is null or w.org_id is distinct from public.get_org_id() then
      raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', x using errcode = '42501';
    end if;
    if w.kind <> 'MAINTENANCE_VISIT' or w.status not in ('NEW','ON_HOLD') then
      v_fail := v_fail || jsonb_build_object('work_order_id', w.id, 'number', w.number, 'error', 'not an owed visit'); continue;
    end if;
    select * into aw from pm.arrival_windows y where y.org_id = w.org_id and y.id = p_arrival_window and y.location_id = w.location_id and y.is_active;
    if aw.id is null or not (extract(isodow from p_service_day)::smallint = any (aw.days_of_week)) then
      v_fail := v_fail || jsonb_build_object('work_order_id', w.id, 'number', w.number, 'error', 'window not offered that day'); continue;
    end if;
    perform pm._fs_capacity_lock(w.org_id, coalesce(w.business_unit_id, p_business_unit), aw.id, p_service_day);
    v_state := pm._fs_capacity_state(w.org_id, coalesce(w.business_unit_id, p_business_unit), w.zone_id, aw.id, p_service_day, w.id, null);
    if not pm._fs_capacity_fits(v_state, w.estimated_minutes)
       and not (nullif(btrim(coalesce(p_override_reason, '')), '') is not null and pm.can('projects.dispatch', 'edit', w.location_id)) then
      v_fail := v_fail || jsonb_build_object('work_order_id', w.id, 'number', w.number, 'error', 'window is full'); continue;
    end if;
    select coalesce(s.time_zone, 'America/Chicago') into v_tz from pm.fs_settings s where s.org_id = w.org_id and s.location_id = w.location_id;
    v_tz := coalesce(v_tz, 'America/Chicago');
    update pm.work_orders set service_day = p_service_day, arrival_window_id = aw.id, business_unit_id = coalesce(business_unit_id, p_business_unit),
           booking_channel = coalesce(booking_channel, 'AGREEMENT'),
           requested_start = (p_service_day + aw.start_time) at time zone v_tz, requested_end = (p_service_day + aw.end_time) at time zone v_tz
     where id = w.id;
    v_ok := v_ok || jsonb_build_object('work_order_id', w.id, 'number', w.number);
  end loop;
  return jsonb_build_object('booked', v_ok, 'failed', v_fail);
end $$;

-- Import agreements with a reconciliation report (FS-65). Rows: customer_id | customer_name, plan_name,
-- tier, starts_on, ends_on, price_cents, billing_frequency, visits_per_term, visits_remaining,
-- deferred_cents, external_ref, revenue_policy. Dry run writes only the report.
create or replace function pm.fs_import_agreements(p_location uuid, p_job_type_key text, p_rows jsonb, p_dry_run boolean default true,
                                                   p_source_system text default 'CSV')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r jsonb; i int := 0; v_err text; v_errs jsonb := '[]'::jsonb; v_cust uuid; v_ok int := 0; v_def bigint := 0;
  v_owed int := 0; v_job uuid; v_agr uuid; v_rem int; v_per int; v_done int; v_start date; v_end date; k int; v_due date;
  v_no_billing jsonb := '[]'::jsonb; v_no_visits jsonb := '[]'::jsonb; v_tiers jsonb := '{}'::jsonb; v_report jsonb; v_tier text;
  v_import uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then
    raise exception 'PM_INVALID: rows must be a list of at most 20,000' using errcode = '22023';
  end if;
  if not p_dry_run and not exists (select 1 from pm.job_types jt where jt.org_id = v_org and jt.location_id = p_location and jt.key = p_job_type_key) then
    raise exception 'PM_FS_NO_JOB_TYPE: job type % does not exist on this company', p_job_type_key using errcode = 'P0002';
  end if;
  for r in select x from jsonb_array_elements(p_rows) x loop
    i := i + 1; v_err := null; v_cust := null;
    if nullif(r ->> 'customer_id', '') is not null then
      select c.id into v_cust from core.customers c where c.org_id = v_org and c.id = pm.access_try_uuid(r ->> 'customer_id');
    elsif nullif(btrim(coalesce(r ->> 'customer_name', '')), '') is not null then
      select c.id into v_cust from core.customers c where c.org_id = v_org and c.merged_into is null
         and lower(coalesce(c.display_name, c.name)) = lower(btrim(r ->> 'customer_name')) order by c.created_at limit 1;
    end if;
    if v_cust is null then v_err := 'customer not found — import customers first';
    elsif nullif(btrim(coalesce(r ->> 'plan_name', '')), '') is null then v_err := 'plan name is required';
    elsif coalesce(r ->> 'starts_on', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(r ->> 'ends_on', '') !~ '^\d{4}-\d{2}-\d{2}$' then v_err := 'start and end dates are required (YYYY-MM-DD)';
    elsif (r ->> 'ends_on')::date <= (r ->> 'starts_on')::date then v_err := 'the term ends before it starts';
    elsif coalesce(r ->> 'price_cents', '0') !~ '^\d{1,12}$' then v_err := 'price must be whole cents';
    elsif coalesce(r ->> 'deferred_cents', '0') !~ '^\d{1,12}$' then v_err := 'deferred balance must be whole cents';
    elsif coalesce(r ->> 'visits_per_term', '0') !~ '^\d{1,3}$' or coalesce(r ->> 'visits_remaining', '0') !~ '^\d{1,3}$' then v_err := 'visits must be whole numbers';
    elsif coalesce((r ->> 'visits_remaining')::int, 0) > coalesce((r ->> 'visits_per_term')::int, 0) then v_err := 'more visits remaining than the plan includes';
    elsif upper(coalesce(r ->> 'billing_frequency', 'MONTHLY')) not in ('UPFRONT','MONTHLY','QUARTERLY','ANNUAL') then v_err := 'billing frequency must be MONTHLY / QUARTERLY / ANNUAL / UPFRONT';
    elsif nullif(r ->> 'external_ref', '') is not null and exists (select 1 from pm.service_agreements g where g.org_id = v_org and g.import_ref = r ->> 'external_ref') then
      v_err := 'already imported (external_ref)';
    end if;
    if v_err is not null then
      v_errs := v_errs || jsonb_build_object('row', i, 'ref', r ->> 'external_ref', 'error', v_err);
      continue;
    end if;
    v_ok := v_ok + 1;
    v_rem := coalesce((r ->> 'visits_remaining')::int, 0);
    v_per := coalesce((r ->> 'visits_per_term')::int, 0);
    v_def := v_def + coalesce((r ->> 'deferred_cents')::bigint, 0);
    v_owed := v_owed + v_rem;
    v_tier := coalesce(nullif(btrim(r ->> 'tier'), ''), btrim(r ->> 'plan_name'));
    v_tiers := jsonb_set(v_tiers, array[v_tier], jsonb_build_object(
      'count', coalesce((v_tiers -> v_tier ->> 'count')::int, 0) + 1,
      'deferred_cents', coalesce((v_tiers -> v_tier ->> 'deferred_cents')::bigint, 0) + coalesce((r ->> 'deferred_cents')::bigint, 0),
      'visits_owed', coalesce((v_tiers -> v_tier ->> 'visits_owed')::int, 0) + v_rem));
    if coalesce((r ->> 'price_cents')::bigint, 0) = 0 then
      v_no_billing := v_no_billing || jsonb_build_object('row', i, 'ref', r ->> 'external_ref', 'plan', r ->> 'plan_name');
    end if;
    if v_per = 0 then
      v_no_visits := v_no_visits || jsonb_build_object('row', i, 'ref', r ->> 'external_ref', 'plan', r ->> 'plan_name');
    end if;
    if not p_dry_run then
      v_start := (r ->> 'starts_on')::date; v_end := (r ->> 'ends_on')::date;
      v_job := pm.create_project(p_location, p_job_type_key, left(btrim(r ->> 'plan_name') || ' · ' || coalesce((select coalesce(c.display_name, c.name) from core.customers c where c.id = v_cust), ''), 120), v_cust, null);
      insert into pm.service_agreements (org_id, location_id, job_id, customer_id, plan_name, tier, status, starts_on, ends_on, cadence,
          visits_per_term, price_cents, billing_frequency, revenue_policy, visits_included, import_ref, activated_at, created_by)
      values (v_org, p_location, v_job, v_cust, btrim(r ->> 'plan_name'), nullif(btrim(r ->> 'tier'), ''), case when v_end <= current_date then 'EXPIRED' else 'ACTIVE' end,
          v_start, v_end, 'SEMIANNUAL', v_per, coalesce((r ->> 'price_cents')::bigint, 0), upper(coalesce(r ->> 'billing_frequency', 'MONTHLY')),
          case when upper(coalesce(r ->> 'revenue_policy', '')) = 'STRAIGHT_LINE' then 'STRAIGHT_LINE' else 'PER_VISIT' end, v_per,
          nullif(r ->> 'external_ref', ''), now(), pm.current_user_id())
      returning id into v_agr;
      v_done := v_per - v_rem;
      insert into pm.agreement_revenue_facts (org_id, location_id, job_id, agreement_id, kind, occurred_on, amount_cents, visits_delivered, source_ref)
      values (v_org, p_location, v_job, v_agr, 'OPENING_BALANCE', current_date, coalesce((r ->> 'deferred_cents')::bigint, 0), v_done,
              format('pm:agrrev:%s:opening', v_agr));
      -- remaining visits spread evenly from today to the end of the term
      for k in 1 .. case when v_end > current_date then v_rem else 0 end loop
        v_due := greatest(current_date, v_start) + (((v_end - greatest(current_date, v_start)) * (k - 1)) / greatest(v_rem, 1));
        insert into pm.work_orders (org_id, location_id, job_id, kind, summary, priority, agreement_id, visit_seq, due_on, due_by,
                                    estimated_minutes, payer_type, booking_channel, created_by)
        values (v_org, p_location, v_job, 'MAINTENANCE_VISIT', format('%s visit %s', btrim(r ->> 'plan_name'), v_done + k), 4, v_agr, v_done + k,
                v_due, least(v_due + 29, v_end - 1), 60, 'CUSTOMER', 'AGREEMENT', pm.current_user_id());
      end loop;
    end if;
  end loop;
  v_report := jsonb_build_object('rows', jsonb_array_length(p_rows), 'ok', v_ok, 'errors', v_errs, 'error_count', jsonb_array_length(v_errs),
    'deferred_cents', v_def, 'visits_owed', v_owed, 'by_tier', v_tiers, 'no_billing', v_no_billing, 'no_visits', v_no_visits,
    'dry_run', p_dry_run, 'source_system', upper(coalesce(p_source_system, 'CSV')));
  insert into pm.agreement_imports (org_id, location_id, source_system, dry_run, row_count, ok_count, error_count, deferred_cents, visits_owed, report)
  values (v_org, p_location, upper(coalesce(p_source_system, 'CSV')), p_dry_run, jsonb_array_length(p_rows), v_ok, jsonb_array_length(v_errs), v_def, v_owed, v_report)
  returning id into v_import;
  return v_report || jsonb_build_object('import_id', v_import);
end $$;

-- Visits-due queue (FS-61): owed agreement visits with customer, zone, window, last tech, tier.
create or replace view pm.v_fs_visits_due with (security_invoker = on) as
select w.org_id, w.location_id, w.id as work_order_id, w.job_id, w.number, w.summary, w.status, w.visit_seq, w.due_on, w.due_by,
       w.service_day, w.arrival_window_id, w.zone_id, w.business_unit_id, w.estimated_minutes,
       a.id as agreement_id, a.number as agreement_number, a.plan_name, a.tier, a.customer_id, a.site_id, a.entitlements_suspended,
       (coalesce(w.due_by, w.due_on) < current_date) as is_overdue,
       to_char(coalesce(w.due_on, current_date), 'YYYY-MM') as due_month,
       (select d.employee_id from pm.dispatch_assignments d join pm.work_orders p on p.org_id = d.org_id and p.id = d.work_order_id
         where d.org_id = w.org_id and p.agreement_id = a.id and d.status = 'DONE' order by d.done_at desc nulls last limit 1) as last_tech_id
  from pm.work_orders w
  join pm.service_agreements a on a.org_id = w.org_id and a.id = w.agreement_id
 where w.kind = 'MAINTENANCE_VISIT' and w.status in ('NEW','ON_HOLD') and a.status in ('ACTIVE','SUSPENDED');

-- Renewals pipeline (FS-64): active agreements ending in the next 90 days.
create or replace view pm.v_fs_renewals with (security_invoker = on) as
select a.org_id, a.location_id, a.id as agreement_id, a.number, a.plan_name, a.tier, a.customer_id, a.ends_on, a.auto_renew,
       a.price_cents, coalesce(t.renewal_uplift_pct, 0) as renewal_uplift_pct,
       pm.fs_rdiv(a.price_cents * (10000 + round(coalesce(t.renewal_uplift_pct, 0) * 10000)), 10000) as renewal_price_cents,
       (a.ends_on - current_date) as days_left,
       case when a.ends_on - current_date <= 30 then 30 when a.ends_on - current_date <= 60 then 60 else 90 end as bucket,
       a.entitlements_suspended, a.failed_payment_count
  from pm.service_agreements a
  left join pm.agreement_templates t on t.org_id = a.org_id and t.id = a.template_id
 where a.status = 'ACTIVE' and a.ends_on <= current_date + 90 and a.ends_on >= current_date
   and not exists (select 1 from pm.service_agreements n where n.org_id = a.org_id and n.renewed_from_id = a.id);

-- Deferred-revenue roll-forward per agreement (FS-63) — Projects' operational view; Books is the ledger.
create or replace view pm.v_fs_agreement_deferred with (security_invoker = on) as
select a.org_id, a.location_id, a.job_id, a.id as agreement_id, a.number, a.plan_name, a.tier, a.status, a.revenue_policy,
       coalesce(sum(f.amount_cents) filter (where f.kind = 'OPENING_BALANCE'), 0)::bigint as opening_cents,
       coalesce(sum(f.amount_cents) filter (where f.kind = 'BILLED'), 0)::bigint as billed_cents,
       coalesce(sum(f.amount_cents) filter (where f.kind in ('VISIT_DELIVERED','STRAIGHT_LINE')), 0)::bigint as recognized_cents,
       coalesce(sum(f.amount_cents) filter (where f.kind in ('CANCEL_REFUND','BREAKAGE')), 0)::bigint as released_cents,
       (coalesce(sum(f.amount_cents) filter (where f.kind in ('OPENING_BALANCE','BILLED')), 0)
        - coalesce(sum(f.amount_cents) filter (where f.kind in ('VISIT_DELIVERED','STRAIGHT_LINE','CANCEL_REFUND','BREAKAGE')), 0))::bigint as deferred_cents,
       coalesce(a.visits_included, a.visits_per_term, 0) as visits_included,
       (coalesce(sum(f.visits_delivered), 0))::int as visits_delivered,
       count(*) filter (where f.status = 'PENDING')::int as facts_pending
  from pm.service_agreements a
  left join pm.agreement_revenue_facts f on f.org_id = a.org_id and f.agreement_id = a.id
 where a.status <> 'DRAFT'
 group by a.org_id, a.location_id, a.job_id, a.id, a.number, a.plan_name, a.tier, a.status, a.revenue_policy, a.visits_included, a.visits_per_term;

-- ----------------------------------------------------------------------------
-- 17. Equipment summary (FS-72 / FS-73 / FS-76)
-- ----------------------------------------------------------------------------
create or replace view pm.v_fs_asset_summary with (security_invoker = on) as
select a.org_id, a.location_id, a.id as asset_id, a.customer_id, a.site_id, a.equipment_type, a.make, a.model, a.serial_number,
       a.installed_on, a.manufactured_on,
       case when coalesce(a.installed_on, a.manufactured_on) is not null
            then extract(year from age(current_date, coalesce(a.installed_on, a.manufactured_on)))::int end as age_years,
       coalesce(a.parts_warranty_ends_on, a.warranty_expires_on) as parts_warranty_ends_on, a.labor_warranty_ends_on,
       (coalesce(a.parts_warranty_ends_on, a.warranty_expires_on) >= current_date) as parts_covered,
       (a.labor_warranty_ends_on >= current_date) as labor_covered,
       a.registration_status, a.registration_deadline,
       (a.registration_status = 'PENDING' and a.registration_deadline < current_date) as registration_late,
       a.refrigerant_type, a.status,
       (select count(*) from pm.asset_service_history h where h.org_id = a.org_id and h.asset_id = a.id)::int as service_events,
       (select max(h.performed_on) from pm.asset_service_history h where h.org_id = a.org_id and h.asset_id = a.id) as last_service_on,
       (select count(*) from pm.work_orders w where w.org_id = a.org_id and w.asset_id = a.id and w.is_callback)::int as callbacks,
       (select coalesce(sum(l.amount_cents), 0) from pm.work_order_lines l join pm.work_orders w on w.org_id = l.org_id and w.id = l.work_order_id
         where l.org_id = a.org_id and w.asset_id = a.id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
           and w.status in ('COMPLETE','CLOSED'))::bigint as repair_spend_cents
  from pm.assets a;

-- ----------------------------------------------------------------------------
-- 18. Tech scorecards + performance pay inputs (FS-40 / FS-101 / FS-103)
-- ----------------------------------------------------------------------------
-- One row per technician for the period. Rows: the caller's own row always; every tech at the company
-- with projects.reports:view, projects.dispatch:edit or projects.financials:view. Revenue figures: own
-- row or projects.contract_value at the company. Pay (commission, spiffs, TGL bonus, chargebacks): own
-- row or projects.labor_rates:view at the company.
create or replace function pm.fs_tech_scorecard(p_location uuid, p_from date, p_to date)
returns table (employee_id uuid, tech_name text, is_me boolean, completed_jobs int, opportunities int, sold_jobs int, conversion_pct numeric,
               revenue_cents bigint, sold_cents bigint, avg_ticket_cents bigint, tgl_set int, tgl_sold int, memberships_sold int,
               recalls int, recall_rate_pct numeric, clocked_hours numeric, billable_hours numeric, review_avg numeric, reviews int,
               commission_cents bigint, spiff_cents bigint, tgl_bonus_cents bigint, membership_spiff_cents bigint,
               chargeback_cents bigint, pay_total_cents bigint, pay_visible boolean, revenue_visible boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_all boolean; v_rev boolean; v_pay boolean; e record; p pm.fs_pay_plans%rowtype; v_me uuid[];
  v_rev_cents bigint; v_sold bigint; v_basis bigint; v_spiff bigint; v_cb bigint; v_tgl_b bigint;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'PM_INVALID: pick a period up to 400 days' using errcode = '22023'; end if;
  v_all := pm.can('projects.reports', 'view', p_location) or pm.can('projects.dispatch', 'edit', p_location) or pm.can('projects.financials', 'view', p_location);
  v_rev := pm.can('projects.contract_value', 'view', p_location);
  v_pay := pm.can('projects.labor_rates', 'view', p_location);
  select coalesce(array_agg(x), '{}') into v_me from pm.my_employee_ids() x;
  if not v_all and cardinality(v_me) = 0 then
    raise exception 'PM_FORBIDDEN: scorecards need projects.reports:view (or your own technician seat)' using errcode = '42501';
  end if;
  for e in
    select distinct ce.id, concat_ws(' ', ce.first_name, ce.last_name) as nm
      from core.employees ce
     where ce.org_id = v_org and ce.is_active
       and (ce.id = any (v_me) or v_all)
       and (exists (select 1 from pm.tech_profiles tp where tp.org_id = ce.org_id and tp.employee_id = ce.id and tp.location_id = p_location)
            or exists (select 1 from pm.dispatch_assignments d join pm.work_orders w on w.org_id = d.org_id and w.id = d.work_order_id
                        where d.org_id = ce.org_id and d.employee_id = ce.id and w.location_id = p_location))
  loop
    employee_id := e.id; tech_name := e.nm; is_me := e.id = any (v_me);
    revenue_visible := v_rev or is_me; pay_visible := v_pay or is_me;
    -- completed visits led by the tech in the period
    select count(distinct w.id)::int,
           count(distinct w.id) filter (where w.is_callback)::int
      into completed_jobs, recalls
      from pm.work_orders w join pm.dispatch_assignments d on d.org_id = w.org_id and d.work_order_id = w.id and d.employee_id = e.id and d.status = 'DONE'
     where w.org_id = v_org and w.location_id = p_location and w.status in ('COMPLETE','CLOSED')
       and w.completed_at::date between p_from and p_to;
    select coalesce(sum(l.amount_cents), 0)::bigint into v_rev_cents
      from pm.work_order_lines l join pm.work_orders w on w.org_id = l.org_id and w.id = l.work_order_id
     where l.org_id = v_org and w.location_id = p_location and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'
       and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between p_from and p_to
       and coalesce(l.performed_by_employee_id, (select d.employee_id from pm.dispatch_assignments d where d.org_id = w.org_id and d.work_order_id = w.id
                                                  and d.status = 'DONE' order by d.is_lead desc, d.created_at limit 1)) = e.id;
    select count(*)::int, count(*) filter (where x.status = 'SOLD')::int,
           coalesce(sum(t.sold) filter (where x.status = 'SOLD'), 0)::bigint
      into opportunities, sold_jobs, v_sold
      from pm.fs_estimates x
      left join lateral (select coalesce(sum(case when x.member_pricing then o.member_cents else o.regular_cents end), 0) as sold
                           from pm.v_fs_option_totals o where o.option_id = any (x.sold_option_ids)) t on true
     where x.org_id = v_org and x.location_id = p_location and x.created_at::date between p_from and p_to
       and (x.sold_by_employee_id = e.id or (x.sold_by_employee_id is null and exists (
             select 1 from pm.dispatch_assignments d where d.org_id = x.org_id and d.work_order_id = x.work_order_id and d.employee_id = e.id and d.status <> 'CANCELLED')));
    conversion_pct := case when opportunities > 0 then round(sold_jobs::numeric / opportunities, 4) end;
    select count(*)::int, count(*) filter (where g.status = 'SOLD')::int into tgl_set, tgl_sold
      from pm.fs_tgl_leads g where g.org_id = v_org and g.location_id = p_location and g.set_by_employee_id = e.id and g.created_at::date between p_from and p_to;
    select count(*)::int into memberships_sold from pm.fs_estimates x
     where x.org_id = v_org and x.location_id = p_location and x.agreement_id is not null and x.sold_by_employee_id = e.id and x.sold_at::date between p_from and p_to;
    recall_rate_pct := case when completed_jobs > 0 then round(recalls::numeric / completed_jobs, 4) end;
    select coalesce(sum(t.hours), 0), coalesce(sum(t.hours) filter (where t.billable), 0) into clocked_hours, billable_hours
      from pm.time_entries t join core.jobs j on j.org_id = t.org_id and j.id = t.job_id
     where t.org_id = v_org and t.employee_id = e.id and j.location_id = p_location and t.work_date between p_from and p_to and t.approval_state <> 'VOID';
    select round(avg(r.rating), 2), count(r.rating)::int into review_avg, reviews
      from pm.fs_review_requests r where r.org_id = v_org and r.location_id = p_location and r.employee_id = e.id and r.reviewed_at::date between p_from and p_to;
    -- pay inputs
    p := null;
    select pp.* into p from pm.fs_pay_assignments pa join pm.fs_pay_plans pp on pp.org_id = pa.org_id and pp.id = pa.pay_plan_id
     where pa.org_id = v_org and pa.location_id = p_location and pa.employee_id = e.id and pp.is_active limit 1;
    v_basis := case coalesce(p.commission_basis, 'COMPLETED') when 'SOLD' then v_sold else v_rev_cents end;
    commission_cents := pm.fs_rdiv(v_basis * round(coalesce(p.commission_pct, 0) * 10000), 10000);
    select coalesce(sum(l.qty * (sp ->> 'cents')::bigint), 0)::bigint into v_spiff
      from pm.work_order_lines l join pm.work_orders w on w.org_id = l.org_id and w.id = l.work_order_id
      join pm.price_book_items pb on pb.id = l.price_book_item_id
      cross join lateral jsonb_array_elements(coalesce(p.spiffs, '[]'::jsonb)) sp
     where l.org_id = v_org and w.location_id = p_location and l.status = 'APPROVED' and l.sold_by_employee_id = e.id
       and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between p_from and p_to and upper(sp ->> 'code') = pb.code;
    spiff_cents := coalesce(v_spiff, 0);
    select coalesce(count(*) * coalesce(p.tgl_bonus_cents, 0) + sum(pm.fs_rdiv(coalesce(g.sold_cents, 0) * round(coalesce(p.tgl_bonus_pct, 0) * 10000), 10000)), 0)::bigint
      into v_tgl_b from pm.fs_tgl_leads g
     where g.org_id = v_org and g.location_id = p_location and g.set_by_employee_id = e.id and g.status = 'SOLD' and g.updated_at::date between p_from and p_to;
    tgl_bonus_cents := v_tgl_b;
    membership_spiff_cents := memberships_sold * coalesce(p.membership_spiff_cents, 0);
    -- callbacks in the period charged back against the ORIGINAL visit's tech
    select coalesce(sum(pm.fs_rdiv(t.rev * round(coalesce(p.recall_chargeback_pct, 0) * 10000), 10000)), 0)::bigint into v_cb
      from (select o.id, coalesce((select sum(l.amount_cents) from pm.work_order_lines l where l.org_id = o.org_id and l.work_order_id = o.id
                                     and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'), 0) as rev
              from pm.work_orders cbk join pm.work_orders o on o.org_id = cbk.org_id and o.id = cbk.callback_of_id
             where cbk.org_id = v_org and cbk.location_id = p_location and cbk.is_callback and cbk.completed_at::date between p_from and p_to
               and exists (select 1 from pm.dispatch_assignments d where d.org_id = o.org_id and d.work_order_id = o.id and d.employee_id = e.id and d.status = 'DONE')) t;
    chargeback_cents := v_cb;
    pay_total_cents := commission_cents + spiff_cents + tgl_bonus_cents + membership_spiff_cents - chargeback_cents;
    revenue_cents := v_rev_cents; sold_cents := v_sold;
    avg_ticket_cents := case when completed_jobs - recalls > 0 then v_rev_cents / (completed_jobs - recalls) end;
    if not revenue_visible then revenue_cents := null; sold_cents := null; avg_ticket_cents := null; end if;
    if not pay_visible then
      commission_cents := null; spiff_cents := null; tgl_bonus_cents := null; membership_spiff_cents := null; chargeback_cents := null; pay_total_cents := null;
    end if;
    return next;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 19. Campaign attribution (FS-106)
-- ----------------------------------------------------------------------------
create or replace function pm.fs_campaign_report(p_location uuid, p_from date, p_to date)
returns table (campaign_id uuid, campaign_code text, campaign_name text, campaign_channel text, calls int, booked int, not_booked int, booking_rate_pct numeric,
               completed_jobs int, revenue_cents bigint, cost_cents bigint, margin_cents bigint, revenue_visible boolean, cost_visible boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_rev boolean; v_cost boolean; k record;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'PM_INVALID: pick a period up to 400 days' using errcode = '22023'; end if;
  v_rev := pm.can('projects.contract_value', 'view', p_location);
  v_cost := pm.can('projects.financials', 'view', p_location);
  for k in select c.id, c.code, c.name, c.channel from pm.campaigns c where c.org_id = v_org and c.location_id = p_location
           union all select null::uuid, '(none)'::text, 'Unattributed'::text, 'OTHER'::text
  loop
    campaign_id := k.id; campaign_code := k.code; campaign_name := k.name; campaign_channel := k.channel;
    select count(*)::int, count(*) filter (where s.status = 'BOOKED')::int, count(*) filter (where s.status = 'NOT_BOOKED')::int
      into calls, booked, not_booked
      from pm.service_calls s where s.org_id = v_org and s.location_id = p_location and s.campaign_id is not distinct from k.id
       and s.created_at::date between p_from and p_to;
    booking_rate_pct := case when booked + not_booked > 0 then round(booked::numeric / (booked + not_booked), 4) end;
    select count(distinct w.id)::int,
           coalesce(sum(l.amount_cents) filter (where l.status = 'APPROVED' and l.pay_type = 'CUSTOMER'), 0)::bigint
      into completed_jobs, revenue_cents
      from pm.work_orders w left join pm.work_order_lines l on l.org_id = w.org_id and l.work_order_id = w.id
     where w.org_id = v_org and w.location_id = p_location and w.campaign_id is not distinct from k.id and w.service_day is not null
       and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between p_from and p_to;
    select coalesce(sum(jc.amount_cents), 0)::bigint into cost_cents
      from pm.job_costs jc where jc.org_id = v_org and jc.job_id in (
        select w.job_id from pm.work_orders w where w.org_id = v_org and w.location_id = p_location and w.campaign_id is not distinct from k.id
           and w.service_day is not null and w.status in ('COMPLETE','CLOSED') and w.completed_at::date between p_from and p_to);
    margin_cents := revenue_cents - cost_cents;
    revenue_visible := v_rev; cost_visible := v_cost;
    if not v_rev then revenue_cents := null; margin_cents := null; end if;
    if not v_cost then cost_cents := null; margin_cents := null; end if;
    continue when k.id is null and calls = 0 and completed_jobs = 0;
    return next;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 20. Starter setup (FS-47 / FS-117): BUs, windows, job types with scripts, capacity, price book, plans
-- ----------------------------------------------------------------------------
create or replace function pm.fs_seed_field_service(p_location uuid, p_trades text[] default array['HVAC','PLUMBING','ELECTRICAL'])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_bu record; n_items int := 0; v_cat uuid; r record; v_svc uuid; v_mat uuid; m text; n_types int := 0;
  v_win record; v_hvac uuid; v_plumb uuid; v_elec uuid; v_maint uuid; v_hvac_ins uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  -- settings
  insert into pm.fs_settings (org_id, location_id) values (v_org, p_location) on conflict (org_id, location_id) do nothing;
  insert into pm.pricebook_settings (org_id, location_id) values (v_org, p_location) on conflict (org_id, location_id) do nothing;
  if not exists (select 1 from pm.pricebook_markup_tiers t where t.org_id = v_org and t.location_id = p_location) then
    insert into pm.pricebook_markup_tiers (org_id, location_id, up_to_cents, markup_pct) values
      (v_org, p_location, 1000, 2.0000), (v_org, p_location, 5000, 1.2500), (v_org, p_location, 25000, 0.8000),
      (v_org, p_location, 100000, 0.5500), (v_org, p_location, null, 0.4000);
  end if;
  -- business units
  insert into pm.business_units (org_id, location_id, code, name, trade, kind, sort) values
    (v_org, p_location, 'HVAC_SVC', 'HVAC Service', 'HVAC', 'SERVICE', 10),
    (v_org, p_location, 'HVAC_INS', 'HVAC Install', 'HVAC', 'INSTALL', 20),
    (v_org, p_location, 'PLUMBING', 'Plumbing', 'PLUMBING', 'SERVICE', 30),
    (v_org, p_location, 'ELECTRICAL', 'Electrical', 'ELECTRICAL', 'SERVICE', 40),
    (v_org, p_location, 'MAINT', 'Maintenance', 'HVAC', 'MAINTENANCE', 50),
    (v_org, p_location, 'COMMERCIAL', 'Commercial', 'GENERAL', 'COMMERCIAL', 60)
  on conflict (org_id, location_id, code) do nothing;
  select id into v_hvac from pm.business_units where org_id = v_org and location_id = p_location and code = 'HVAC_SVC';
  select id into v_hvac_ins from pm.business_units where org_id = v_org and location_id = p_location and code = 'HVAC_INS';
  select id into v_plumb from pm.business_units where org_id = v_org and location_id = p_location and code = 'PLUMBING';
  select id into v_elec from pm.business_units where org_id = v_org and location_id = p_location and code = 'ELECTRICAL';
  select id into v_maint from pm.business_units where org_id = v_org and location_id = p_location and code = 'MAINT';
  -- arrival windows
  insert into pm.arrival_windows (org_id, location_id, label, start_time, end_time, days_of_week, is_after_hours, online, sort) values
    (v_org, p_location, '8–10 am', '08:00', '10:00', '{1,2,3,4,5,6}', false, true, 10),
    (v_org, p_location, '10–12 pm', '10:00', '12:00', '{1,2,3,4,5,6}', false, true, 20),
    (v_org, p_location, '12–2 pm', '12:00', '14:00', '{1,2,3,4,5}', false, true, 30),
    (v_org, p_location, '2–4 pm', '14:00', '16:00', '{1,2,3,4,5}', false, true, 40),
    (v_org, p_location, 'After hours 4–8 pm', '16:00', '20:00', '{1,2,3,4,5,6,7}', true, false, 50)
  on conflict (org_id, location_id, label) do nothing;
  -- capacity: 4 jobs per BU per regular window every day; 2 after hours
  for v_bu in select id, kind from pm.business_units where org_id = v_org and location_id = p_location and kind in ('SERVICE','MAINTENANCE') loop
    for v_win in select id, is_after_hours from pm.arrival_windows where org_id = v_org and location_id = p_location loop
      insert into pm.capacity_limits (org_id, location_id, business_unit_id, arrival_window_id, max_jobs, note)
      values (v_org, p_location, v_bu.id, v_win.id, case when v_win.is_after_hours then 2 else 4 end, 'starter capacity — adjust to your board')
      on conflict do nothing;
    end loop;
  end loop;
  -- booking job types with CSR scripts (FS-04 / FS-117)
  for r in select * from (values
      ('no_cool',   'No Cool',              v_hvac,  2, 90,  8900::bigint, 'HVAC',
       '{"questions":[{"id":"unit_age","prompt":"About how old is the system?","kind":"choice","options":["Under 5 years","5–10 years","10–15 years","15+ years","Not sure"],"required":true},{"id":"symptom","prompt":"What is it doing — blowing warm air, not turning on, or freezing up?","kind":"text","required":true},{"id":"thermostat","prompt":"Is the thermostat set to cool and below room temperature?","kind":"yesno"},{"id":"breaker","prompt":"Have you checked the breaker for the outdoor unit?","kind":"yesno"},{"id":"warranty","prompt":"Is the system still under a warranty you know of?","kind":"yesno"}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a diagnostic fee of {fee}, waived if you go ahead with the repair. Members pay no diagnostic fee."},{"id":"after_hours","fee":"after_hours","text":"After 4 pm and on Sundays an after-hours fee of {after_hours_fee} applies."}],"rebuttals":[{"objection":"That fee is too high","answer":"The fee covers a full system check by a licensed technician, and it comes off if you do the repair."},{"objection":"Can you just tell me the price on the phone?","answer":"Every system is different; the technician gives you the exact flat-rate price before any work starts."}]}'),
      ('no_heat',   'No Heat',              v_hvac,  2, 90,  8900, 'HVAC',
       '{"questions":[{"id":"fuel","prompt":"Is it a gas furnace, heat pump or boiler?","kind":"choice","options":["Gas furnace","Heat pump","Boiler","Not sure"],"required":true},{"id":"co_alarm","prompt":"Is a carbon-monoxide alarm sounding? (If yes: leave the home and call 911.)","kind":"yesno","required":true},{"id":"unit_age","prompt":"About how old is the system?","kind":"choice","options":["Under 5 years","5–10 years","10–15 years","15+ years","Not sure"]},{"id":"symptom","prompt":"What is it doing?","kind":"text","required":true}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a diagnostic fee of {fee}, waived if you go ahead with the repair."}],"rebuttals":[]}'),
      ('tune_up',   'Tune-up',              v_maint, 4, 60,  null, 'HVAC',
       '{"questions":[{"id":"member","prompt":"Are you a member of our maintenance plan?","kind":"yesno"},{"id":"systems","prompt":"How many systems (furnace + AC count as one)?","kind":"choice","options":["1","2","3+"],"required":true}],"disclosures":[],"rebuttals":[{"objection":"I will wait until it breaks","answer":"A tune-up catches the small parts that fail on the hottest and coldest days and keeps the manufacturer warranty valid."}]}'),
      ('leak',      'Leak',                 v_plumb, 2, 90,  7900, 'PLUMBING',
       '{"questions":[{"id":"active","prompt":"Is water actively leaking right now?","kind":"yesno","required":true},{"id":"shutoff","prompt":"Do you know where the main water shut-off is?","kind":"yesno"},{"id":"where","prompt":"Where is the leak?","kind":"text","required":true}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a trip and diagnostic fee of {fee}, waived if you do the repair."}],"rebuttals":[]}'),
      ('water_heater','Water Heater',       v_plumb, 3, 120, 7900, 'PLUMBING',
       '{"questions":[{"id":"type","prompt":"Tank or tankless; gas or electric?","kind":"text","required":true},{"id":"age","prompt":"About how old is it?","kind":"choice","options":["Under 6 years","6–10 years","10+ years","Not sure"]},{"id":"symptom","prompt":"No hot water, leaking, or noisy?","kind":"text","required":true}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a diagnostic fee of {fee}, waived if you do the repair."}],"rebuttals":[]}'),
      ('drain',     'Drain',                v_plumb, 3, 90,  7900, 'PLUMBING',
       '{"questions":[{"id":"which","prompt":"Which drain — kitchen, bath, toilet, or main line?","kind":"text","required":true},{"id":"backup","prompt":"Is it backing up into other fixtures?","kind":"yesno"}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a trip fee of {fee}, waived with the repair."}],"rebuttals":[]}'),
      ('panel',     'Electrical Panel',     v_elec,  3, 120, 9900, 'ELECTRICAL',
       '{"questions":[{"id":"symptom","prompt":"Breakers tripping, flickering lights, burning smell, or an upgrade?","kind":"text","required":true},{"id":"burning","prompt":"Is there a burning smell or scorching now? (If yes: turn off the main and call 911 if there is smoke.)","kind":"yesno","required":true},{"id":"age","prompt":"Roughly how old is the home?","kind":"text"}],"disclosures":[{"id":"diagnostic","fee":"diagnostic","text":"There is a diagnostic fee of {fee}, waived with the repair."}],"rebuttals":[]}'),
      ('replacement_estimate','Replacement Estimate', v_hvac_ins, 3, 90, 0, 'HVAC',
       '{"questions":[{"id":"what","prompt":"What are you thinking of replacing?","kind":"text","required":true},{"id":"decision_makers","prompt":"Will everyone who decides be home for the visit?","kind":"yesno","required":true},{"id":"age","prompt":"About how old is the current system?","kind":"text"}],"disclosures":[],"rebuttals":[{"objection":"Can you email a quote?","answer":"A comfort advisor measures the home and shows options with monthly payments and rebates, so the price is exact."}]}'),
      ('recall',    'Recall',               v_hvac,  1, 60,  0, 'HVAC',
       '{"questions":[{"id":"original","prompt":"When was the last visit, and what was done?","kind":"text","required":true},{"id":"same_problem","prompt":"Is it the same problem?","kind":"yesno","required":true}],"disclosures":[],"rebuttals":[]}')
    ) as t(key, label, bu, prio, minutes, fee, trade, script)
    where t.trade = any (p_trades) and t.bu is not null
  loop
    insert into pm.booking_job_types (org_id, location_id, key, label, business_unit_id, work_order_kind, default_priority, estimated_minutes,
                                      diagnostic_fee_cents, after_hours_fee_cents, is_recall, online, script, sort)
    values (v_org, p_location, r.key, r.label, r.bu, case when r.key = 'tune_up' then 'MAINTENANCE_VISIT' else 'SERVICE' end, r.prio, r.minutes,
            nullif(r.fee, 0), case when r.fee > 0 then 9900 end, r.key = 'recall', r.key not in ('recall'), r.script::jsonb, n_types)
    on conflict (org_id, location_id, key) do nothing;
    n_types := n_types + 1;
  end loop;
  -- categories
  insert into pm.pricebook_categories (org_id, location_id, code, name, trade, sort)
  select v_org, p_location, c.code, c.name, c.trade, c.sort from (values
    ('HVAC-REPAIR','HVAC repair','HVAC',10), ('HVAC-MAINT','HVAC maintenance','HVAC',20), ('HVAC-EQUIP','HVAC equipment','HVAC',30),
    ('HVAC-IAQ','Indoor air quality','HVAC',40), ('PLB-REPAIR','Plumbing repair','PLUMBING',50), ('PLB-DRAIN','Drains','PLUMBING',60),
    ('PLB-WH','Water heaters','PLUMBING',70), ('ELE-REPAIR','Electrical repair','ELECTRICAL',80), ('ELE-PANEL','Panels and service','ELECTRICAL',90),
    ('FEES','Fees','GENERAL',100), ('MATERIALS','Materials','GENERAL',110)) as c(code, name, trade, sort)
  where c.trade = 'GENERAL' or c.trade = any (p_trades)
  on conflict (org_id, location_id, code) do nothing;
  -- materials (cost) — costs are typical distributor prices; adjust after the first cost feed
  for r in select * from (values
      ('M-CAP-4505',   'Dual run capacitor 45/5 µF',      1850,  'HVAC'),
      ('M-CAP-3505',   'Dual run capacitor 35/5 µF',      1650,  'HVAC'),
      ('M-CONT-1P30',  'Contactor 1-pole 30 A',           1400,  'HVAC'),
      ('M-IGN-HSI',    'Hot surface igniter (universal)', 2600,  'HVAC'),
      ('M-FLM-SENS',   'Flame sensor',                    1100,  'HVAC'),
      ('M-MTR-CFAN',   'Condenser fan motor 1/4 HP',      9800,  'HVAC'),
      ('M-MTR-BLWR',   'Blower motor ECM 1/2 HP',        32000,  'HVAC'),
      ('M-REF-410A',   'R-410A refrigerant (lb)',         1900,  'HVAC'),
      ('M-REF-454B',   'R-454B refrigerant (lb)',         2600,  'HVAC'),
      ('M-FILTER-1',   'Pleated filter 1 in',              600,  'HVAC'),
      ('M-TSTAT-PRG',  'Programmable thermostat',         5500,  'HVAC'),
      ('M-TSTAT-WIFI', 'Wi-Fi thermostat',               13500,  'HVAC'),
      ('M-SURGE-HVAC', 'HVAC surge protector',            6500,  'HVAC'),
      ('M-UV-LAMP',    'UV air purifier',                29000,  'HVAC'),
      ('M-WAX-RING',   'Toilet wax ring + bolts',          700,  'PLUMBING'),
      ('M-FILL-VALVE', 'Toilet fill valve',               1200,  'PLUMBING'),
      ('M-FLAPPER',    'Toilet flapper',                   500,  'PLUMBING'),
      ('M-PTRAP',      'P-trap kit 1-1/2 in',              900,  'PLUMBING'),
      ('M-FAUCET-KIT', 'Kitchen faucet (builder)',        9500,  'PLUMBING'),
      ('M-SUPPLY',     'Braided supply line',              800,  'PLUMBING'),
      ('M-TPR-VALVE',  'T&P relief valve',                1800,  'PLUMBING'),
      ('M-WH-THERMO',  'Water heater thermocouple',        900,  'PLUMBING'),
      ('M-WH-ELEM',    'Water heater element',            1600,  'PLUMBING'),
      ('M-SUMP-PUMP',  'Sump pump 1/3 HP',               14500,  'PLUMBING'),
      ('M-GFCI',       'GFCI receptacle',                 1700,  'ELECTRICAL'),
      ('M-BRKR-20',    'Breaker 20 A single pole',        1100,  'ELECTRICAL'),
      ('M-BRKR-AFCI',  'AFCI breaker',                    4200,  'ELECTRICAL'),
      ('M-SWITCH',     'Decora switch',                    350,  'ELECTRICAL'),
      ('M-SURGE-WH',   'Whole-home surge protector',      9000,  'ELECTRICAL'),
      ('M-SMOKE',      'Smoke / CO detector',             3800,  'ELECTRICAL')
    ) as t(code, name, cost, trade) where t.trade = any (p_trades)
  loop
    select id into v_cat from pm.pricebook_categories where org_id = v_org and location_id = p_location and code = 'MATERIALS';
    insert into pm.price_book_items (org_id, location_id, code, name, unit, kind, category_id, cost_cents, price_cents)
    values (v_org, p_location, r.code, r.name, case when r.code like 'M-REF%' then 'LB' else 'EA' end, 'MATERIAL', v_cat, r.cost, 0)
    on conflict (org_id, location_id, code) do nothing;
  end loop;
  -- services (task hours + bundled materials), maintenance tasks, GBB tiers
  for r in select * from (values
      ('HV-DIAG',      'HVAC diagnostic',                       'HVAC-REPAIR', 'HVAC', 'FEE',     null::numeric, 8900::bigint, '', null::text, 'HVAC_SVC'),
      ('HV-CAP',       'Replace run capacitor',                 'HVAC-REPAIR', 'HVAC', 'SERVICE', 0.75, null, 'M-CAP-4505:1', 'GOOD', 'HVAC_SVC'),
      ('HV-CAP-SURGE', 'Capacitor + surge protector',           'HVAC-REPAIR', 'HVAC', 'SERVICE', 1.25, null, 'M-CAP-4505:1;M-SURGE-HVAC:1', 'BETTER', 'HVAC_SVC'),
      ('HV-CONT',      'Replace contactor',                     'HVAC-REPAIR', 'HVAC', 'SERVICE', 0.75, null, 'M-CONT-1P30:1', null, 'HVAC_SVC'),
      ('HV-CFAN',      'Replace condenser fan motor',           'HVAC-REPAIR', 'HVAC', 'SERVICE', 1.50, null, 'M-MTR-CFAN:1;M-CAP-3505:1', 'BEST', 'HVAC_SVC'),
      ('HV-BLWR',      'Replace blower motor (ECM)',            'HVAC-REPAIR', 'HVAC', 'SERVICE', 2.50, null, 'M-MTR-BLWR:1', null, 'HVAC_SVC'),
      ('HV-IGN',       'Replace hot surface igniter',           'HVAC-REPAIR', 'HVAC', 'SERVICE', 0.75, null, 'M-IGN-HSI:1', null, 'HVAC_SVC'),
      ('HV-FLAME',     'Clean or replace flame sensor',         'HVAC-REPAIR', 'HVAC', 'SERVICE', 0.50, null, 'M-FLM-SENS:1', null, 'HVAC_SVC'),
      ('HV-REF-410',   'Refrigerant charge R-410A (2 lb)',      'HVAC-REPAIR', 'HVAC', 'SERVICE', 1.00, null, 'M-REF-410A:2', null, 'HVAC_SVC'),
      ('HV-LEAK-SRCH', 'Refrigerant leak search',               'HVAC-REPAIR', 'HVAC', 'SERVICE', 2.00, null, '', null, 'HVAC_SVC'),
      ('HV-TSTAT',     'Install Wi-Fi thermostat',              'HVAC-REPAIR', 'HVAC', 'SERVICE', 1.00, null, 'M-TSTAT-WIFI:1', null, 'HVAC_SVC'),
      ('HV-TUNE-AC',   'AC tune-up',                            'HVAC-MAINT',  'HVAC', 'SERVICE', 1.00, null, 'M-FILTER-1:1', null, 'MAINT'),
      ('HV-TUNE-HEAT', 'Furnace tune-up and safety check',      'HVAC-MAINT',  'HVAC', 'SERVICE', 1.00, null, 'M-FILTER-1:1', null, 'MAINT'),
      ('HV-UV',        'Install UV air purifier',               'HVAC-IAQ',    'HVAC', 'SERVICE', 1.50, null, 'M-UV-LAMP:1', null, 'HVAC_SVC'),
      ('PL-TRIP',      'Plumbing trip and diagnostic',          'PLB-REPAIR',  'PLUMBING', 'FEE', null, 7900, '', null, 'PLUMBING'),
      ('PL-TOILET-RB', 'Rebuild toilet tank',                   'PLB-REPAIR',  'PLUMBING', 'SERVICE', 0.75, null, 'M-FILL-VALVE:1;M-FLAPPER:1', 'GOOD', 'PLUMBING'),
      ('PL-TOILET-RS', 'Reset toilet (new wax ring)',           'PLB-REPAIR',  'PLUMBING', 'SERVICE', 1.00, null, 'M-WAX-RING:1;M-SUPPLY:1', 'BETTER', 'PLUMBING'),
      ('PL-FAUCET',    'Replace kitchen faucet',                'PLB-REPAIR',  'PLUMBING', 'SERVICE', 1.50, null, 'M-FAUCET-KIT:1;M-SUPPLY:2', null, 'PLUMBING'),
      ('PL-PTRAP',     'Replace P-trap',                        'PLB-REPAIR',  'PLUMBING', 'SERVICE', 0.75, null, 'M-PTRAP:1', null, 'PLUMBING'),
      ('PL-DRAIN-SNK', 'Clear sink drain',                      'PLB-DRAIN',   'PLUMBING', 'SERVICE', 1.00, null, '', null, 'PLUMBING'),
      ('PL-DRAIN-MAIN','Clear main line (cleanout)',            'PLB-DRAIN',   'PLUMBING', 'SERVICE', 2.00, null, '', null, 'PLUMBING'),
      ('PL-WH-TPR',    'Replace water heater T&P valve',        'PLB-WH',      'PLUMBING', 'SERVICE', 0.75, null, 'M-TPR-VALVE:1', null, 'PLUMBING'),
      ('PL-WH-ELEM',   'Replace water heater element',          'PLB-WH',      'PLUMBING', 'SERVICE', 1.00, null, 'M-WH-ELEM:1', null, 'PLUMBING'),
      ('PL-WH-FLUSH',  'Flush water heater',                    'PLB-WH',      'PLUMBING', 'SERVICE', 0.75, null, '', null, 'PLUMBING'),
      ('PL-SUMP',      'Replace sump pump',                     'PLB-REPAIR',  'PLUMBING', 'SERVICE', 1.50, null, 'M-SUMP-PUMP:1', null, 'PLUMBING'),
      ('EL-DIAG',      'Electrical diagnostic',                 'ELE-REPAIR',  'ELECTRICAL', 'FEE', null, 9900, '', null, 'ELECTRICAL'),
      ('EL-GFCI',      'Replace GFCI receptacle',               'ELE-REPAIR',  'ELECTRICAL', 'SERVICE', 0.50, null, 'M-GFCI:1', null, 'ELECTRICAL'),
      ('EL-BRKR',      'Replace breaker',                       'ELE-PANEL',   'ELECTRICAL', 'SERVICE', 0.75, null, 'M-BRKR-20:1', 'GOOD', 'ELECTRICAL'),
      ('EL-AFCI',      'Upgrade to AFCI breaker',               'ELE-PANEL',   'ELECTRICAL', 'SERVICE', 0.75, null, 'M-BRKR-AFCI:1', 'BETTER', 'ELECTRICAL'),
      ('EL-SURGE',     'Install whole-home surge protector',    'ELE-PANEL',   'ELECTRICAL', 'SERVICE', 1.00, null, 'M-SURGE-WH:1', 'BEST', 'ELECTRICAL'),
      ('EL-SMOKE',     'Install smoke / CO detector',           'ELE-REPAIR',  'ELECTRICAL', 'SERVICE', 0.50, null, 'M-SMOKE:1', null, 'ELECTRICAL'),
      ('EL-SWITCH',    'Replace switch',                        'ELE-REPAIR',  'ELECTRICAL', 'SERVICE', 0.50, null, 'M-SWITCH:1', null, 'ELECTRICAL'),
      ('FEE-AFTERHRS', 'After-hours fee',                       'FEES',        'GENERAL', 'FEE', null, 9900, '', null, null),
      ('FEE-TRIP',     'Trip charge',                           'FEES',        'GENERAL', 'FEE', null, 4900, '', null, null)
    ) as t(code, name, cat, trade, kind, hours, price, mats, tier, bu)
    where t.trade = 'GENERAL' or t.trade = any (p_trades)
  loop
    select id into v_cat from pm.pricebook_categories where org_id = v_org and location_id = p_location and code = r.cat;
    insert into pm.price_book_items (org_id, location_id, code, name, unit, kind, category_id, business_unit_id, task_hours, price_cents,
                                     price_locked, gbb_tier)
    values (v_org, p_location, r.code, r.name, 'EA', r.kind, v_cat,
            (select b.id from pm.business_units b where b.org_id = v_org and b.location_id = p_location and b.code = r.bu),
            r.hours, coalesce(r.price, 0), r.kind = 'FEE', r.tier)
    on conflict (org_id, location_id, code) do nothing;
    if r.mats <> '' then
      select id into v_svc from pm.price_book_items where org_id = v_org and location_id = p_location and code = r.code;
      foreach m in array string_to_array(r.mats, ';') loop
        select id into v_mat from pm.price_book_items where org_id = v_org and location_id = p_location and code = split_part(m, ':', 1);
        if v_svc is not null and v_mat is not null then
          insert into pm.pricebook_service_materials (org_id, service_item_id, material_item_id, qty)
          values (v_org, v_svc, v_mat, split_part(m, ':', 2)::numeric) on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;
  n_items := pm.fs_reprice_pricebook(p_location, null);
  -- financing plan stubs (provider integrations are stubs until a lender contract exists)
  insert into pm.financing_plans (org_id, location_id, provider, code, name, apr, term_months, promo, dealer_fee_pct, min_cents, is_default) values
    (v_org, p_location, 'GREENSKY', 'GS-12SAC', '12 months same as cash', 0, 12, 'No interest if paid in full in 12 months', 0.0600, 50000, false),
    (v_org, p_location, 'SYNCHRONY', 'SY-60', '9.99% for 60 months', 0.0999, 60, null, 0.0300, 100000, true),
    (v_org, p_location, 'SERVICE_FINANCE', 'SF-120', '7.99% for 120 months', 0.0799, 120, null, 0.0800, 500000, false)
  on conflict (org_id, location_id, code) do nothing;
  -- membership templates
  insert into pm.agreement_templates (org_id, location_id, key, label, plan_name, tier, term_months, cadence, visits_per_term, visit_minutes,
                                      seasons, price_cents, billing_frequency, member_discount_pct, perks, revenue_policy, renewal_uplift_pct,
                                      business_unit_id, sort)
  values
    (v_org, p_location, 'comfort_club', 'MEMBERSHIP', 'Comfort Club', 'Gold', 12, 'SEMIANNUAL', 2, 60, '{SPRING,FALL}', 1995, 'MONTHLY', 0.15,
     '{"priority_service":true,"waive_diagnostic":true,"no_overtime":true}', 'PER_VISIT', 0.05, v_maint, 10),
    (v_org, p_location, 'comfort_club_basic', 'MEMBERSHIP', 'Comfort Club', 'Silver', 12, 'ANNUAL', 1, 60, '{FALL}', 14900, 'ANNUAL', 0.10,
     '{"priority_service":true,"waive_diagnostic":false}', 'PER_VISIT', 0.05, v_maint, 20)
  on conflict (org_id, location_id, key) do nothing;
  return jsonb_build_object('business_units', (select count(*) from pm.business_units where org_id = v_org and location_id = p_location),
                            'arrival_windows', (select count(*) from pm.arrival_windows where org_id = v_org and location_id = p_location),
                            'job_types', (select count(*) from pm.booking_job_types where org_id = v_org and location_id = p_location),
                            'price_book_items', n_items);
end $$;

-- ----------------------------------------------------------------------------
-- 20b. Fix: the 1110 guard on pm.set_assignment_status aliased dispatch_assignments as "d", the
--      name of the function's own record variable, so every member call failed with
--      "column reference d.id is ambiguous" (a tech could never go en route). Re-create the 1104
--      body unguarded (identical) and re-register the guard with a distinct alias; section 21
--      re-injects it.
-- ----------------------------------------------------------------------------
create or replace function pm.set_assignment_status(p_assignment uuid, p_status text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dispatch_assignments%rowtype; w pm.work_orders%rowtype; ok boolean;
begin
  select * into d from pm.dispatch_assignments x where x.id = p_assignment for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: assignment % not found in the caller''s organization', p_assignment using errcode = '42501';
  end if;
  ok := case d.status
          when 'ASSIGNED'   then p_status in ('DISPATCHED','EN_ROUTE','ON_SITE','CANCELLED')
          when 'DISPATCHED' then p_status in ('EN_ROUTE','ON_SITE','CANCELLED')
          when 'EN_ROUTE'   then p_status in ('ON_SITE','CANCELLED')
          when 'ON_SITE'    then p_status = 'DONE'
          else false end;
  if not ok then raise exception 'PM_ASSIGNMENT_TRANSITION_INVALID: % -> %', d.status, p_status using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.org_id = d.org_id and x.id = d.work_order_id for update;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;

  update pm.dispatch_assignments
     set status = p_status,
         dispatched_at = case when p_status = 'DISPATCHED' then now() else dispatched_at end,
         en_route_at   = case when p_status = 'EN_ROUTE' then now() else en_route_at end,
         arrived_at    = case when p_status = 'ON_SITE' then now() else arrived_at end,
         done_at       = case when p_status = 'DONE' then now() else done_at end,
         cancelled_at  = case when p_status = 'CANCELLED' then now() else cancelled_at end
   where id = p_assignment;

  if p_status in ('DISPATCHED','EN_ROUTE') and w.status = 'SCHEDULED' then
    update pm.work_orders set status = 'DISPATCHED' where id = w.id;
  elsif p_status = 'ON_SITE' and w.status in ('NEW','SCHEDULED','DISPATCHED','ON_HOLD') then
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), hold_reason = null where id = w.id;
  end if;

  perform pm.log_activity(d.org_id, w.location_id, w.job_id, 'dispatch.' || lower(p_status), 'dispatch_assignments', p_assignment,
    format('%s: technician %s', w.number, lower(replace(p_status, '_', ' '))),
    jsonb_build_object('work_order_id', w.id, 'employee_id', d.employee_id, 'from', d.status, 'to', p_status));
  return p_assignment;
end $$;

update pm.access_rpc_guards
   set guard_sql = 'if not (exists (select 1 from pm.dispatch_assignments ga where ga.id = p_assignment and ga.org_id = public.get_org_id() and (ga.employee_id in (select pm.my_employee_ids()) or ga.crew_id in (select pm.my_crew_ids()))) or pm.access_can_row(''projects.dispatch'', ''edit'', ''dispatch_assignments'', p_assignment)) then perform pm.access_forbid(''requires your own dispatch or projects.dispatch:edit''); end if;',
       note = 'own dispatch or dispatch:edit (alias fixed in 1117)'
 where function_name = 'set_assignment_status';

-- ----------------------------------------------------------------------------
-- 21. 1110 registries: classes, masked columns, RPC guards, allowlist
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('business_units',            'S','location', '{}', 'projects.settings', null, null, null, null, false, '1117: business units (FS-119)'),
  ('service_zones',             'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1117: dispatch zones by zip'),
  ('arrival_windows',           'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1117: arrival windows'),
  ('capacity_limits',           'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1117: capacity per BU × zone × window'),
  ('campaigns',                 'S','location', '{}', 'projects.leads',    null, null, null, null, false, '1117: marketing campaigns / tracking numbers'),
  ('booking_job_types',         'S','location', '{}', 'projects.settings', null, null, null, null, false, '1117: bookable job types, fees (sell), CSR scripts'),
  ('fs_settings',               'S','location', '{}', 'projects.settings', null, null, null, null, false, '1117: time zone, quiet hours, review link'),
  ('pricebook_categories',      'S','location', '{}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: price-book categories'),
  ('pricebook_service_materials','S','parent',  '{}', 'projects.settings', 'price_book_items', 'service_item_id', null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: materials bundled into a flat-rate task (qty only)'),
  ('financing_plans',           'S','location', '{}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: financing plans; dealer fee masked (financials)'),
  ('agreement_templates',       'S','location', '{}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: membership / maintenance agreement templates'),
  ('pricebook_settings',        'C','location', '{projects.financials}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: burdened rate / target margin — cost side'),
  ('pricebook_markup_tiers',    'C','location', '{projects.financials}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1117: material markup ladder — cost side'),
  ('booking_widgets',           'C','location', '{projects.settings}', 'projects.settings', null, null, null, null, false, '1117: online booking links (token hash)'),
  ('service_calls',             'C','location', '{projects.dispatch,projects.customers,projects.leads}', null, null, null, null, null, false,
     '1117: calls / requests / agent bookings; written only by the booking RPCs'),
  ('site_profiles',             'C','location', '{projects.dispatch,projects.customers}', 'projects.customers', null, null,
     '%1$ssite_id in (select w.site_id from pm.work_orders w where w.org_id = public.get_org_id() and w.site_id is not null and w.job_id in (select pm.my_job_ids()))',
     null, false, '1117: gate codes, pets, do-not-service; techs read the sites of their jobs'),
  ('tech_profiles',             'C','location', '{projects.dispatch,projects.jobs}', 'projects.dispatch', null, null, null, null, false, '1117: technician zones / BUs / display name'),
  ('tech_events',               'C','location', '{projects.dispatch}', 'projects.dispatch', null, null,
     '%1$semployee_id in (select pm.my_employee_ids())', null, false, '1117: PTO / training / meeting blocks; own blocks readable'),
  ('on_call_shifts',            'C','location', '{projects.dispatch,projects.jobs}', 'projects.dispatch', null, null, null, null, false, '1117: on-call rotation'),
  ('fs_messages',               'C','location', '{projects.dispatch,projects.customers}', null, null, null, null, null, false, '1117: customer text / email outbox'),
  ('fs_review_requests',        'C','location', '{projects.dispatch,projects.customers,projects.reports}', null, null, null,
     '%1$semployee_id in (select pm.my_employee_ids())', null, false, '1117: review requests; techs read their own'),
  ('agreement_imports',         'C','location', '{projects.financials}', null, null, null, null, null, false, '1117: agreement import reconciliation reports (deferred $)'),
  ('fs_pay_plans',              'C','location', '{projects.labor_rates}', 'projects.labor_rates', null, null,
     '%1$sid in (select pa.pay_plan_id from pm.fs_pay_assignments pa where pa.org_id = public.get_org_id() and pa.employee_id in (select pm.my_employee_ids()))',
     null, false, '1117: performance pay plans — comp; a tech reads their own plan'),
  ('fs_pay_assignments',        'P','location', '{projects.labor_rates}', 'projects.labor_rates', null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')))',
     '%1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''edit''))', false, '1117: tech ↔ pay plan; own row or labor_rates'),
  ('fs_estimates',              'J','job', '{projects.jobs}', null, null, null, null, null, false, '1117: good/better/best estimates; written by fs_* RPCs'),
  ('fs_estimate_options',       'J','job', '{projects.jobs}', null, null, null, null, null, false, '1117: GBB options (sell prices are public)'),
  ('fs_estimate_option_items',  'J','job', '{projects.jobs}', null, null, null, null, null, false, '1117: option lines; unit_cost_cents masked (financials)'),
  ('fs_tgl_leads',              'J','job', '{projects.jobs}', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.leads'', ''view''))', null, false, '1117: tech-generated leads; sales reads all'),
  ('agreement_billing_schedule','M','job', '{projects.contract_value}', null, null, null, null, null, false, '1117: agreement billing periods → billing requests'),
  ('agreement_revenue_facts',   'M','job', '{projects.financials}', null, null, null, null, null, false, '1117: deferred-revenue outbox for Books'),
  ('fs_rate_counters',          'O','org', '{}', null, null, null, null, null, false, '1117: widget rate-limit counters (no org_id, no member grants; definer functions only)'),
  ('fs_widget_server_keys',     'O','org', '{}', null, null, null, null, null, false, '1117: hashed app-route keys for the public widget (service_role writes only)')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

-- the GM keeps the book: price-book items are also writable with projects.financials:edit at the company
update pm.access_table_classes
   set write_extra = '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))',
       note = 'readable by every company member; cost columns masked; writes: settings:configure or financials:edit (1117)'
 where table_name = 'price_book_items';

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('price_book_items',         'material_cost_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null::text, '1117: bundled material cost'),
  ('price_book_items',         'labor_cost_cents',    't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1117: burdened labor cost'),
  ('financing_plans',          'dealer_fee_pct',      't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1117: lender dealer fee'),
  ('fs_estimate_option_items', 'unit_cost_cents',     't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1117: option cost'),
  ('price_book_items',         'target_gm_pct',       't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1117 (security review L): price × (1 − GM) would reveal cost')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('fs_book_call',         '{p_location}', 'perform pm.access_assert_location(''projects.dispatch'', array[''edit''], p_location);', '1117: CSR / AI-agent booking'),
  ('fs_log_call',          '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''edit'', p_location) or pm.access_can_location(''projects.leads'', ''create'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.leads:create''); end if;', '1117'),
  ('fs_convert_request',   '{p_call}',     'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''service_calls'', p_call);', '1117'),
  ('fs_close_call',        '{p_call}',     'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''service_calls'', p_call);', '1117'),
  ('fs_reschedule_booking','{p_wo}',       'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', p_wo);', '1117'),
  ('fs_capacity_grid',     '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.customers'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch, customers or leads view''); end if;', '1117'),
  ('fs_caller_pop',        '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.customers'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch, customers or leads view''); end if;', '1117: AR amounts masked inside'),
  ('fs_prejob_brief',      '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own dispatch or the job''); end if;', '1117'),
  ('fs_eligible_techs',    '{p_wo}',       'perform pm.access_assert_row(''projects.dispatch'', array[''view''], ''work_orders'', p_wo);', '1117'),
  ('fs_reprice_pricebook', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.financials:edit''); end if;', '1117'),
  ('fs_bulk_price_change', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.financials:edit''); end if;', '1117: margin preview shows cost'),
  ('fs_import_pricebook',  '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.financials:edit''); end if;', '1117'),
  ('fs_seed_field_service','{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1117'),
  ('fs_build_estimate',    '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.estimates'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own dispatch, projects.dispatch:edit or projects.estimates:edit''); end if;', '1117'),
  ('fs_toggle_option_item','{p_item}',     'if not (exists (select 1 from pm.fs_estimate_option_items gi join pm.fs_estimate_options go on go.org_id = gi.org_id and go.id = gi.option_id join pm.fs_estimates ge on ge.org_id = go.org_id and ge.id = go.estimate_id where gi.id = p_item and gi.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimate_option_items'', p_item) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimate_option_items'', p_item)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1117'),
  ('fs_present_estimate',  '{p_estimate}', 'if not (exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1117'),
  ('fs_sell_estimate',     '{p_estimate,p_request_deposit,p_join_template}', 'if not (exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1117: deposit request rides pm.request_deposit; membership via template'),
  ('fs_decline_estimate',  '{p_estimate}', 'if not (exists (select 1 from pm.fs_estimates ge where ge.id = p_estimate and ge.org_id = public.get_org_id() and ge.work_order_id is not null and pm.access_my_work_order(ge.work_order_id)) or pm.access_can_row(''projects.estimates'', ''edit'', ''fs_estimates'', p_estimate) or pm.access_can_row(''projects.dispatch'', ''edit'', ''fs_estimates'', p_estimate)) then perform pm.access_forbid(''requires your own dispatch or projects.estimates:edit''); end if;', '1117'),
  ('fs_set_tgl',           '{p_wo}',       'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own dispatch or projects.dispatch:edit''); end if;', '1117'),
  ('fs_create_agreement_from_template','{p_location}', 'if not (pm.access_can_location(''projects.customers'', ''create'', p_location) or pm.access_can_location(''projects.estimates'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.customers:create''); end if;', '1117: also nested from fs_sell_estimate'),
  ('fs_generate_agreement_billing','{p_agreement}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''service_agreements'', p_agreement);', '1117: drafts recurring billing requests'),
  ('fs_recognize_straight_line','{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''create'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.billing:create or projects.financials:edit''); end if;', '1117'),
  ('fs_run_dunning',       '{p_location}', 'perform pm.access_assert_location(''projects.billing'', array[''edit''], p_location);', '1117'),
  ('fs_bulk_book_visits',  '{p_wo_ids}',   'perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', gx) from unnest(p_wo_ids) as gx;', '1117'),
  ('fs_import_agreements', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.financials'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.financials:edit''); end if;', '1117: opening deferred balances'),
  ('fs_tech_scorecard',    '{p_location}', 'if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1117: rows / revenue / pay narrowed inside'),
  ('fs_campaign_report',   '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.leads'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports:view or projects.leads:view''); end if;', '1117: revenue / cost masked inside')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 22. RLS (permissive org isolation) + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['business_units','service_zones','arrival_windows','campaigns','booking_job_types','capacity_limits','fs_settings',
    'site_profiles','booking_widgets','service_calls','tech_profiles','tech_events','on_call_shifts','fs_messages','pricebook_categories',
    'pricebook_settings','pricebook_markup_tiers','pricebook_service_materials','financing_plans','fs_estimates','fs_estimate_options',
    'fs_estimate_option_items','agreement_templates','agreement_billing_schedule','agreement_revenue_facts','agreement_imports',
    'fs_pay_plans','fs_pay_assignments','fs_tgl_leads','fs_review_requests'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
end $$;

alter table pm.fs_rate_counters enable row level security;
alter table pm.fs_widget_server_keys enable row level security;
revoke all on pm.fs_rate_counters, pm.fs_widget_server_keys from public, anon, authenticated;
grant select, insert, update, delete on pm.fs_rate_counters, pm.fs_widget_server_keys to service_role;

revoke all on pm.business_units, pm.service_zones, pm.arrival_windows, pm.campaigns, pm.booking_job_types, pm.capacity_limits, pm.fs_settings,
              pm.site_profiles, pm.booking_widgets, pm.service_calls, pm.tech_profiles, pm.tech_events, pm.on_call_shifts, pm.fs_messages,
              pm.pricebook_categories, pm.pricebook_settings, pm.pricebook_markup_tiers, pm.pricebook_service_materials, pm.financing_plans,
              pm.fs_estimates, pm.fs_estimate_options, pm.fs_estimate_option_items, pm.agreement_templates, pm.agreement_billing_schedule,
              pm.agreement_revenue_facts, pm.agreement_imports, pm.fs_pay_plans, pm.fs_pay_assignments, pm.fs_tgl_leads, pm.fs_review_requests
  from public, anon, authenticated;
grant select, insert, update, delete on pm.business_units, pm.service_zones, pm.arrival_windows, pm.campaigns, pm.booking_job_types,
              pm.capacity_limits, pm.fs_settings, pm.site_profiles, pm.booking_widgets, pm.service_calls, pm.tech_profiles, pm.tech_events,
              pm.on_call_shifts, pm.fs_messages, pm.pricebook_categories, pm.pricebook_settings, pm.pricebook_markup_tiers,
              pm.pricebook_service_materials, pm.financing_plans, pm.fs_estimates, pm.fs_estimate_options, pm.fs_estimate_option_items,
              pm.agreement_templates, pm.agreement_billing_schedule, pm.agreement_revenue_facts, pm.agreement_imports, pm.fs_pay_plans,
              pm.fs_pay_assignments, pm.fs_tgl_leads, pm.fs_review_requests
  to service_role;
-- config members write through RLS (class write caps)
grant select, insert, update, delete on pm.business_units, pm.service_zones, pm.arrival_windows, pm.campaigns, pm.booking_job_types,
              pm.capacity_limits, pm.fs_settings, pm.site_profiles, pm.tech_profiles, pm.tech_events, pm.on_call_shifts, pm.pricebook_categories,
              pm.pricebook_settings, pm.pricebook_markup_tiers, pm.pricebook_service_materials, pm.financing_plans, pm.agreement_templates,
              pm.fs_pay_plans, pm.fs_pay_assignments
  to authenticated;
grant select, insert, update, delete on pm.booking_widgets to authenticated;
-- workflow rows: read only for members (definer RPCs write)
grant select on pm.service_calls, pm.fs_messages, pm.fs_estimates, pm.fs_estimate_options, pm.fs_estimate_option_items,
              pm.agreement_billing_schedule, pm.agreement_revenue_facts, pm.agreement_imports, pm.fs_tgl_leads, pm.fs_review_requests
  to authenticated;

-- new descriptive columns members may edit on existing tables (state / booking columns stay RPC-only)
grant update (equipment_type, tonnage, btu, seer2, hspf2, afue, refrigerant_type, refrigerant_charge_oz, fuel_type, voltage, phase,
              manufactured_on, installer_employee_id, install_work_order_id, parts_warranty_ends_on, labor_warranty_ends_on,
              registration_status, registration_deadline, registration_ref, qr_code, nameplate_document_id, site_id, location_label)
  on pm.assets to authenticated;
grant update (kind, category_id, business_unit_id, task_hours, target_gm_pct, price_locked, customer_description, image_url, upsell_codes,
              gbb_tier, is_taxable, warranty_note)
  on pm.price_book_items to authenticated;
grant update (payment_method_label, site_id) on pm.service_agreements to authenticated;

grant select on pm.v_fs_option_totals, pm.v_fs_visits_due, pm.v_fs_renewals, pm.v_fs_agreement_deferred, pm.v_fs_asset_summary
  to authenticated, service_role;

-- Policies (every classified table), masked views (price_book_items / assets / work_order_lines gain the
-- new columns; financing_plans + fs_estimate_option_items get masked views), RPC guards.
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon in pm; members get the RPC surface; the widget pair is
-- the only anon surface (schema public, token-scoped).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              'fs_rdiv','fs_round_rule','fs_ladder_markup','fs_material_sell','fs_service_price','fs_monthly_payment',
              'tg_fs_same_company','tg_fs_site_in_org','tg_fs_number','tg_fs_assignment_vs_events','tg_fs_wo_close_registration',
              'tg_fs_asset_registration','_fs_queue_message','tg_fs_on_my_way','tg_fs_review_on_complete','_fs_capacity_rule',
              '_fs_capacity_state','_fs_capacity_fits','_fs_capacity_lock','_fs_zone_for_zip','_fs_book','fs_book_call','fs_log_call',
              '_fs_widget_server_ok','_fs_widget_assert_server','_fs_sweep','_fs_hit','_fs_ip_bucket',
              'fs_convert_request','fs_close_call','fs_reschedule_booking','fs_capacity_grid','_fs_widget','_fs_customer_ar',
              '_fs_masked_ar','fs_caller_pop','fs_prejob_brief','fs_eligible_techs','_fs_ladder','_fs_price_item','fs_reprice_pricebook',
              'fs_bulk_price_change','fs_import_pricebook','fs_build_estimate','fs_toggle_option_item','fs_present_estimate',
              'fs_create_agreement_from_template','fs_sell_estimate','fs_decline_estimate','fs_set_tgl','_fs_period_months',
              '_fs_term_total','fs_generate_agreement_billing','tg_fs_visit_delivered','tg_fs_agreement_status_facts',
              'fs_recognize_straight_line','fs_run_dunning','fs_bulk_book_visits','fs_import_agreements','fs_tech_scorecard',
              'fs_campaign_report','fs_seed_field_service') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('fs_rdiv','fs_round_rule','fs_ladder_markup','fs_material_sell','fs_service_price','fs_monthly_payment',
                     '_fs_capacity_fits','_fs_period_months',
                     'fs_book_call','fs_log_call','fs_convert_request','fs_close_call','fs_reschedule_booking','fs_capacity_grid',
                     'fs_caller_pop','fs_prejob_brief','fs_eligible_techs','fs_reprice_pricebook','fs_bulk_price_change',
                     'fs_import_pricebook','fs_build_estimate','fs_toggle_option_item','fs_present_estimate',
                     'fs_create_agreement_from_template','fs_sell_estimate','fs_decline_estimate','fs_set_tgl',
                     'fs_generate_agreement_billing','fs_recognize_straight_line','fs_run_dunning','fs_bulk_book_visits',
                     'fs_import_agreements','fs_tech_scorecard','fs_campaign_report','fs_seed_field_service') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('fs_widget_availability','fs_widget_book') loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- ============================================================================
-- end 1117_pm_field_service_depth
-- ============================================================================
