-- ============================================================================
-- 1125 · Merit Projects — dealer & manufacturing completion (Wave C)
--
-- Spec: expert-panel seat 05 (DLR Launch rows) and seat 04 (MFG Launch rows); docs/projects/WAVE-C-BRIEF.md
-- (binding rules). Builds on 1104 (work orders, assets, stock), 1105 (production), 1106 (selections,
-- measures), 1109 (dealer store), 1110 (access), 1113 (approvals), 1114 (notifications), 1115 (documents,
-- drawings, e-sign), 1118 (portals) and 1122 (industry depth). Nothing in 1100–1122 is modified: additive
-- columns on two 1104 / 1105 tables (work_order_lines internal routing, bom_lines edge banding), new
-- tables, new definer RPCs, and additive triggers that act only on rows this migration links (or that a
-- company opts into through its own settings row).
--
-- MONEY RULES (1110): bigint cents, fractions for percents, integer half-up rounding (pm.fs_rdiv, 1117).
-- Definer RPCs that return money strip it unless the caller holds the capability (pm._x_sees, 1122).
-- NO GL: Books owns AR, AP, deposits, the bank, inventory value, floor plan, OEM receivables and WIP.
-- Projects keeps quantities, states, documents and the facts Books needs (payload-ready rows where a
-- Books consumer does not exist yet — no new core.events types; Books rejects unknown Projects events).
--
-- WHAT THIS ADDS
--   D  equipment dealer (dlr_ — seat 05 §2a)
--      settings       dlr_store_settings + pm.dlr_set_store_settings (lot GPS, texts, storage, opt-in gates)
--      DLR-03         dlr_shipments / _lines: OEM shipment (EDI 856 / CSV / manual) → scan serials →
--                     receive (pm.receive_unit with the floor-plan lender + program), shortages, damage, extras
--      DLR-09         dlr_lot_audits / dlr_lot_scans: phone lot scan, count vs system, lender audit list
--                     (missing, sold-not-paid, demo, GPS off the lot)
--      DLR-10         dlr_recons: a received trade-in opens a recon RO; the unit cannot be listed or put on
--                     a deal until recon is done (trigger on deal lines + advertised price)
--      DLR-13         pm.dlr_payment_menu (scenarios × down payments, cash-rebate vs low-APR, best customer
--                     payment / dealer net) + dlr_quote_payment_options (menu pinned on a quote)
--      DLR-14         dlr_incentives (dealer cash, spiffs, volume, co-op, demo programs with claim deadline),
--                     dlr_deal_incentives, dlr_incentive_claims (opened at delivery, tracked to receipt)
--      DLR-24/25      dlr_deal_stips + dlr_deal_funding (contracts in transit), dlr_unwinds (deposit refund /
--                     hold choice around pm.unwind_deal)
--      DLR-32/33/34/39 special-order auto-text (trigger), pm.dlr_stock_suggestions (min/max from demand,
--                     seasonality, lost sales, lead time), dlr_order_transmissions + dlr_backorders (adapters
--                     live in lib/dealer/parts-ordering.ts; file-based X12 850 / 855), dlr_part_transfers +
--                     pm.dlr_part_locator
--      DLR-41/42/45/50/51/52/53/57 service: capacity + appointments + pickup / delivery stops, RO check-in
--                     (signature at the counter or by text through 1115 e-sign), findings → PROPOSED lines →
--                     text approval (e-sign) or per-line decisions, sublets + shop-fee rules, RO stage +
--                     customer status texts (1114 core.notify_customer), close check / QC / close / Books
--                     pay link text / pickup / storage, internal routing tags, WIP + cutoff
--      DLR-63..68     rate extensions (hour / half-day / minimums / accessories), availability + blocks
--                     (maintenance / down), paperwork (license, COI, card hold, waiver, briefing, signature),
--                     damage RO, cycle billing, fleet PM rules / due list / schedule into gaps, re-rent holds
--      DLR-70/71/77/80 customer 360, registers + drawer sessions + deposit batches (facts for Books),
--                     price limits + overrides + manager PIN, store day / month close checklist
--   M  manufacturing ETO (mfg_ — seat 04 §2a)
--      MFG-03 opportunities + bids (one estimate to several GCs, award converts it) · MFG-05 drawing takeoff
--      on 1115 sheet revisions (scale, linear / area / count) · MFG-07 parametric product library
--      (linear coefficient formulas) · MFG-11 proposals (alternates, allowances, clarifications, exclusions,
--      deposit schedule, e-sign) · MFG-14 site measure gate · MFG-15 cabinet selections → upcharge CO ·
--      MFG-16 shop-drawing submittal log with GC / architect stamps (hard gate on drawings approval) ·
--      MFG-17 current-set enforcement (restrictive policy on drawing_revisions for shop / field seats,
--      opt-out per company) · MFG-18 engineering queue + drafter load · MFG-20 cut list (edge banding per
--      edge, label, UOM) · MFG-22 CO re-engineering · MFG-25 family routings · MFG-32 traveler ·
--      MFG-40 sheet specs, allocations, counts · MFG-42 issue from nests · MFG-43 outside processing ·
--      MFG-44 shipping tickets + proof of delivery · MFG-46 installer app · MFG-47 punch / back-charge /
--      warranty · MFG-48 job cost est vs committed vs actual by area · MFG-50 stored materials + bill on
--      ship · MFG-52 WIP view · MFG-53 owner dashboard · MFG-55 portal feed hook
--
-- ACCESS: every new table classified (pm.access_table_classes), every member-executable definer RPC
--   guarded (pm.access_rpc_guards); helpers / triggers are service-only; nothing for anon. No new public /
--   core tables (projects_only_seat_deny not needed).
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * Approvals: the 1113 object list is closed. Price overrides are their own queue (limits by role,
--     preparer ≠ approver, manager PIN) and notify approvers through core.notify_fanout('approval.requested');
--     the approvals owner can add a 'dealer_price_override' object type later.
--   * Customer text approval of RO findings and check-in signatures ride 1115 e-sign envelopes with no
--     completion kind ('none'): a trigger on pm.esign_envelopes settles only envelopes linked from 1125 rows.
--   * Opt-in gates (default OFF so existing stores keep working): rental paperwork, re-rent inspection.
--     Default ON but non-blocking: recon on trade-ins (opens the RO; listing lock applies to that unit only).
--   * Drawer close produces deposit-batch facts (dlr_deposit_batches, READY); Books owns the deposit.
--   * Two-way inbound customer texting needs a 1114 inbound route (seam) — status replies are drafted here.
--
-- APPLY RULE: after 1100–1122. Idempotent (safe twice); PGlite-safe.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then raise exception '1125 requires 1110_pm_access'; end if;
  if to_regprocedure('pm._x_org_of_location(uuid)') is null then raise exception '1125 requires 1122_pm_industry_depth'; end if;
  if to_regclass('pm.esign_envelopes') is null then raise exception '1125 requires 1115_pm_documents_esign'; end if;
  if to_regprocedure('core.notify_customer(uuid,uuid,uuid,text,text,uuid,text,text,text,text,text)') is null then
    raise exception '1125 requires 1114_notifications';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Shared helpers (service-only)
-- ----------------------------------------------------------------------------
-- A store's 1125 settings as jsonb (saved row over the defaults).
create or replace function pm._d5_defaults() returns jsonb
language sql immutable
as $$ select jsonb_build_object(
  'lot_lat', null, 'lot_lng', null, 'lot_radius_m', 400, 'service_job_type_key', 'customer_repair',
  'recon_required', true, 'internal_route_required', true, 'qc_required', true,
  'status_texts', jsonb_build_object('CHECKED_IN', true, 'WAITING_APPROVAL', true, 'WAITING_PARTS', true, 'READY', true),
  'special_order_text', true, 'special_order_stale_days', 14, 'storage_free_days', 3, 'storage_daily_cents', 0,
  'lien_notice_days', 30, 'rerent_inspection_required', false, 'rental_out_requires', '[]'::jsonb, 'cit_stale_days', 10,
  'default_stips', jsonb_build_array(
     jsonb_build_object('key', 'signed_contract', 'label', 'Signed retail installment contract'),
     jsonb_build_object('key', 'drivers_license', 'label', 'Driver''s license copy'),
     jsonb_build_object('key', 'proof_of_insurance', 'label', 'Proof of insurance'),
     jsonb_build_object('key', 'credit_app', 'label', 'Signed credit application')),
  'daily_tech_hours', 32, 'cycle_days', 28, 'drawer_variance_cents', 500,
  -- security review H3: the store's posted shop labor rate (null = none posted: labor is not checked)
  'labor_rate_cents', null) $$;

create table if not exists pm.dlr_store_settings (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  settings     jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (org_id, location_id)
);
comment on table pm.dlr_store_settings is '1125: per-store settings for the dealer completion screens (keys validated by pm.dlr_set_store_settings).';

create or replace function pm._d5_set(p_org uuid, p_location uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm._d5_defaults() || coalesce((select s.settings from pm.dlr_store_settings s where s.org_id = p_org and s.location_id = p_location), '{}'::jsonb)
$$;

create or replace function pm.dlr_set_store_settings(p_location uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); k text; v_cur jsonb;
begin
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then raise exception 'PM_INVALID: settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (pm._d5_defaults() ? k) then raise exception 'PM_INVALID: unknown store setting %', k using errcode = '22023'; end if;
  end loop;
  if p_patch ? 'lot_radius_m' and coalesce((p_patch ->> 'lot_radius_m')::int, 0) not between 25 and 20000 then
    raise exception 'PM_INVALID: the lot radius is 25 to 20,000 meters' using errcode = '22023';
  end if;
  if p_patch ? 'lot_lat' and p_patch ->> 'lot_lat' is not null and abs((p_patch ->> 'lot_lat')::numeric) > 90 then
    raise exception 'PM_INVALID: latitude is between -90 and 90' using errcode = '22023';
  end if;
  if p_patch ? 'lot_lng' and p_patch ->> 'lot_lng' is not null and abs((p_patch ->> 'lot_lng')::numeric) > 180 then
    raise exception 'PM_INVALID: longitude is between -180 and 180' using errcode = '22023';
  end if;
  if p_patch ? 'status_texts' and jsonb_typeof(p_patch -> 'status_texts') <> 'object' then
    raise exception 'PM_INVALID: status_texts maps an RO stage to on / off' using errcode = '22023';
  end if;
  if p_patch ? 'rental_out_requires' and (jsonb_typeof(p_patch -> 'rental_out_requires') <> 'array' or exists (
       select 1 from jsonb_array_elements_text(p_patch -> 'rental_out_requires') x where x not in ('license','coi','card_hold','waiver','safety_briefing','signature'))) then
    raise exception 'PM_INVALID: rental paperwork items are license, coi, card_hold, waiver, safety_briefing, signature' using errcode = '22023';
  end if;
  if p_patch ? 'labor_rate_cents' and p_patch ->> 'labor_rate_cents' is not null
     and coalesce(pm._x_try_bigint(p_patch ->> 'labor_rate_cents'), -1) not between 1 and 10000000 then
    raise exception 'PM_INVALID: the posted labor rate is a positive amount in cents per hour' using errcode = '22023';
  end if;
  -- security review R8: a variance threshold has a ceiling ($500) so a store cannot switch the flag off
  if p_patch ? 'drawer_variance_cents' and coalesce(pm._x_try_bigint(p_patch ->> 'drawer_variance_cents'), -1) not between 0 and 50000 then
    raise exception 'PM_INVALID: the drawer variance flag is $0 to $500' using errcode = '22023';
  end if;
  if p_patch ? 'default_stips' and jsonb_typeof(p_patch -> 'default_stips') <> 'array' then
    raise exception 'PM_INVALID: default_stips is a list of {key, label}' using errcode = '22023';
  end if;
  select s.settings into v_cur from pm.dlr_store_settings s where s.org_id = v_org and s.location_id = p_location;
  insert into pm.dlr_store_settings as s (org_id, location_id, settings, updated_by)
  values (v_org, p_location, coalesce(v_cur, '{}'::jsonb) || p_patch, pm.current_user_id())
  on conflict (org_id, location_id) do update set settings = s.settings || excluded.settings, updated_by = excluded.updated_by, updated_at = now();
  perform pm.log_activity(v_org, p_location, null, 'store.settings', 'dlr_store_settings', null, 'Store settings updated', jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x)));
  return pm._d5_set(v_org, p_location);
end $$;

create or replace function pm.dlr_store_settings_get(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  return pm._d5_set(pm._x_org_of_location(p_location), p_location);
end $$;

-- Great-circle distance in meters (lot GPS check).
create or replace function pm._d5_meters(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns numeric
language sql immutable
as $$
  select case when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null else
    round((2 * 6371000 * asin(sqrt(power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
      + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2))))::numeric, 1) end
$$;

-- The customer's best texting contact (primary first, a mobile number on file).
create or replace function pm._d5_contact(p_org uuid, p_customer uuid) returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select c.id from core.contacts c
   where c.org_id = p_org and c.customer_id = p_customer and c.merged_into is null and nullif(btrim(coalesce(c.phone, '')), '') is not null
   order by c.is_primary desc, c.sms_consent desc, c.created_at
   limit 1
$$;

create table if not exists pm.dlr_customer_texts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  job_id        uuid,
  work_order_id uuid,
  customer_id   uuid references core.customers(id),
  contact_id    uuid,
  kind          text not null check (kind in ('STATUS','ESTIMATE','PAY_LINK','SPECIAL_ORDER','RENTAL','PICKUP','MANUAL','REPLY')),
  subject_table text,
  subject_id    uuid,
  body          text not null check (char_length(body) between 1 and 640),
  outbound_id   uuid,
  status        text not null check (status in ('queued','held','suppressed','skipped','no_contact','failed')),
  reason        text,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists pm_dlr_customer_texts_cust_idx on pm.dlr_customer_texts (org_id, customer_id, created_at desc);
create index if not exists pm_dlr_customer_texts_subject_idx on pm.dlr_customer_texts (org_id, subject_table, subject_id, created_at desc);
comment on table pm.dlr_customer_texts is '1125: every customer text the store screens queue (through core.notify_customer: held until go-live, consent, STOP).';

-- Text a customer through 1114. Never raises: a failed text never fails the action that raised it.
create or replace function pm._d5_text(p_org uuid, p_location uuid, p_job uuid, p_customer uuid, p_kind text, p_subject_table text,
                                        p_subject uuid, p_body text, p_dedupe text, p_wo uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_ct uuid; v_out uuid; o record; v_status text; v_reason text; v_id uuid := gen_random_uuid();
begin
  v_ct := case when p_customer is null then null else pm._d5_contact(p_org, p_customer) end;
  if v_ct is null then
    v_status := 'no_contact'; v_reason := 'No mobile number on file for this customer';
  else
    begin
      v_out := core.notify_customer(p_org, p_location, p_job, 'customer.message', 'sms', v_ct, null, left(p_body, 640), null,
                                    case when p_dedupe is not null then 'customer:customer.message:' || left(p_dedupe, 150) end, pm.current_user_id());
      select m.status, m.status_reason into o from core.outbound_messages m where m.id = v_out;
      v_status := case when o.status in ('queued','held','suppressed','skipped') then o.status when o.status in ('sending','sent','delivered') then 'queued' else 'queued' end;
      v_reason := o.status_reason;
    exception when others then
      v_status := 'failed'; v_reason := left(sqlerrm, 300);
    end;
  end if;
  insert into pm.dlr_customer_texts (id, org_id, location_id, job_id, work_order_id, customer_id, contact_id, kind, subject_table, subject_id, body, outbound_id, status, reason)
  values (v_id, p_org, p_location, p_job, p_wo, p_customer, v_ct, p_kind, p_subject_table, p_subject, left(p_body, 640), v_out, v_status, v_reason);
  return jsonb_build_object('text_id', v_id, 'status', v_status, 'reason', v_reason, 'outbound_id', v_out);
end $$;

-- Raise an internal notification (1114 fan-out). Never raises.
create or replace function pm._d5_notify(p_org uuid, p_location uuid, p_job uuid, p_event text, p_subject_type text, p_subject uuid,
                                          p_recipients uuid[], p_title text, p_body text, p_link text, p_dedupe text)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n int := 0;
begin
  if coalesce(cardinality(p_recipients), 0) = 0 then return 0; end if;
  begin
    n := core.notify_fanout(p_org, p_event, p_location, p_job, p_subject_type, p_subject, core.client_scope_caller_membership(),
                            p_recipients, left(p_title, 200), left(p_body, 500), null, null, p_link, p_dedupe, '{}'::jsonb);
  exception when others then
    raise warning '1125 notify % failed: %', p_event, sqlerrm;
  end;
  return coalesce(n, 0);
end $$;

-- A unit's short label ("STK-104 Kubota Z421").
create or replace function pm._d5_unit_label(p_asset uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select btrim(concat_ws(' ', a.stock_number, a.make, a.model, case when a.stock_number is null then a.serial_number end))
    from pm.assets a where a.id = p_asset
$$;

create or replace function pm._d5_company_name(p_location uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$ select coalesce((select l.name from core.locations l where l.id = p_location), 'the store') $$;

-- A file id a screen hands an RPC (signature image, photo, license, POD) must belong to the caller's
-- organization AND the record's job (security review M5): already linked to that job, or uploaded by
-- the caller and not linked to any other job — then it is linked to this job (subject = the job).
-- With no job (rental contracts) the file must be the caller's own unlinked upload. Raises otherwise.
create or replace function pm._d5_claim_doc(p_org uuid, p_job uuid, p_doc uuid, p_what text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if p_doc is null then return null; end if;
  if p_job is not null and exists (select 1 from pm.document_links dl where dl.org_id = p_org and dl.document_id = p_doc and dl.job_id = p_job) then
    return p_doc;
  end if;
  if exists (select 1 from public.documents d where d.id = p_doc and d.org_id = p_org and d.uploaded_by_user is not distinct from pm.current_user_id()
                and d.uploaded_by_user is not null)
     and not exists (select 1 from pm.document_links dl where dl.document_id = p_doc and dl.job_id is distinct from p_job) then
    if p_job is not null then
      insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role)
      values (p_org, p_doc, p_job, 'projects', p_job, left(p_what, 60)) on conflict do nothing;
    end if;
    return p_doc;
  end if;
  raise exception 'PM_INVALID: that % is not a file on this record''s job', p_what using errcode = '22023';
end $$;

create or replace function pm._d5_claim_docs(p_org uuid, p_job uuid, p_docs uuid[], p_what text) returns uuid[]
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d uuid;
begin
  foreach d in array coalesce(p_docs, '{}'::uuid[]) loop perform pm._d5_claim_doc(p_org, p_job, d, p_what); end loop;
  return coalesce(p_docs, '{}');
end $$;

-- An e-sign envelope an RPC links must be in the organization and on the record's job (M5).
create or replace function pm._d5_assert_envelope(p_org uuid, p_job uuid, p_env uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if p_env is null then return; end if;
  if not exists (select 1 from pm.esign_envelopes e where e.id = p_env and e.org_id = p_org and e.job_id is not distinct from p_job) then
    raise exception 'PM_INVALID: that signature request is not on this record''s job' using errcode = '22023';
  end if;
end $$;

-- Rental paperwork files (security review R11): tied to the CONTRACT — already linked to it
-- (subject rental_contracts), or the caller's own upload not linked anywhere, which is then linked to it.
create or replace function pm._d5_claim_rental_doc(p_org uuid, p_contract uuid, p_doc uuid, p_what text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if p_doc is null then return null; end if;
  if exists (select 1 from pm.document_links dl where dl.org_id = p_org and dl.document_id = p_doc and dl.subject_table = 'rental_contracts' and dl.subject_id = p_contract) then
    return p_doc;
  end if;
  if exists (select 1 from public.documents d where d.id = p_doc and d.org_id = p_org and d.uploaded_by_user is not null and d.uploaded_by_user = pm.current_user_id())
     and not exists (select 1 from pm.document_links dl where dl.document_id = p_doc) then
    insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role)
    values (p_org, p_doc, null, 'rental_contracts', p_contract, left(p_what, 60)) on conflict do nothing;
    return p_doc;
  end if;
  raise exception 'PM_INVALID: that % is not a file on this rental contract', p_what using errcode = '22023';
end $$;

-- A rental envelope must be this org's and sent on a document filed against this contract (R11).
create or replace function pm._d5_assert_rental_envelope(p_org uuid, p_contract uuid, p_env uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if p_env is null then return; end if;
  if not exists (select 1 from pm.esign_envelopes e join pm.doc_files f on f.org_id = e.org_id and f.id = e.file_id
                  where e.id = p_env and e.org_id = p_org and f.subject_table = 'rental_contracts' and f.subject_id = p_contract) then
    raise exception 'PM_INVALID: that signature request is not for this rental contract' using errcode = '22023';
  end if;
end $$;

-- Business key numbers per kind (DLR-SHP-2026-00001).
create or replace function pm._d5_number(p_org uuid, p_location uuid, p_prefix text) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n bigint; v_year text := to_char(current_date, 'YYYY');
begin
  n := pm.next_doc_number(p_org, p_location::text, '1125:' || p_prefix, v_year);
  return p_prefix || '-' || v_year || '-' || lpad(n::text, 5, '0');
end $$;

-- ============================================================================
-- D. EQUIPMENT DEALER
-- ============================================================================

-- ----------------------------------------------------------------------------
-- D1. DLR-03 Unit receiving from an OEM shipment (scan serials against the ASN / invoice)
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_shipments (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  number                  text not null,
  vendor_id               uuid references core.vendors(id),
  invoice_ref             text check (invoice_ref is null or char_length(invoice_ref) <= 80),
  ship_ref                text check (ship_ref is null or char_length(ship_ref) <= 80),
  source                  text not null default 'MANUAL' check (source in ('EDI_856','CSV','PDF','MANUAL')),
  source_file_name        text,
  status                  text not null default 'OPEN' check (status in ('OPEN','RECEIVED','CANCELLED')),
  stock_location_id       uuid,
  floor_lender_vendor_id  uuid references core.vendors(id),
  floor_program           text check (floor_program is null or char_length(floor_program) <= 80),
  expected_on             date,
  received_at             timestamptz,
  received_by             text,
  summary                 jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  notes                   text,
  created_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number),
  check (status <> 'RECEIVED' or received_at is not null),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_shipments_loc_idx on pm.dlr_shipments (org_id, location_id, status, created_at desc);

create table if not exists pm.dlr_shipment_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  shipment_id         uuid not null,
  line_no             int not null check (line_no >= 1),
  make                text,
  model               text,
  model_year          int check (model_year is null or model_year between 1900 and 2200),
  serial_number       text check (serial_number is null or char_length(serial_number) between 1 and 80),
  description         text,
  category            text,
  cost_cents          bigint check (cost_cents is null or cost_cents >= 0),
  order_unit_id       uuid,
  status              text not null default 'EXPECTED' check (status in ('EXPECTED','SCANNED','DAMAGED','RECEIVED','SHORT','EXTRA','FAILED')),
  scanned_at          timestamptz,
  scanned_by          text,
  damage_note         text,
  photo_document_ids  uuid[] not null default '{}',
  unit_id             uuid,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (shipment_id, line_no),
  foreign key (org_id, shipment_id) references pm.dlr_shipments (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, order_unit_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, unit_id) references pm.assets (org_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_shipment_lines_serial_idx on pm.dlr_shipment_lines (org_id, upper(serial_number));

-- Create a shipment from parsed lines (lib/dealer/oem-shipment.ts reads EDI 856 / CSV; the counter can
-- also key it). Lines: [{make, model, model_year, serial_number, description, category, cost_cents}].
-- A line without a serial matches an ON_ORDER / IN_TRANSIT unit of the same make + model when there is one.
create or replace function pm.dlr_create_shipment(p_location uuid, p_attrs jsonb, p_lines jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid := gen_random_uuid();
        v_vendor uuid := pm.access_try_uuid(a ->> 'vendor_id'); v_lender uuid := pm.access_try_uuid(a ->> 'floor_lender_vendor_id');
        v_sl uuid := pm.access_try_uuid(a ->> 'stock_location_id'); l jsonb; n int := 0; v_ser text; v_order uuid; v_src text;
begin
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: a shipment needs at least one unit line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 500 then raise exception 'PM_INVALID: at most 500 units per shipment' using errcode = '22023'; end if;
  if v_vendor is not null and not exists (select 1 from core.vendors v where v.id = v_vendor and v.org_id = v_org) then
    raise exception 'PM_UNKNOWN_VENDOR: the manufacturer is not a vendor in this organization' using errcode = '22023';
  end if;
  if v_lender is not null and not exists (select 1 from core.vendors v where v.id = v_lender and v.org_id = v_org) then
    raise exception 'PM_UNKNOWN_VENDOR: the floor-plan lender is not a vendor in this organization' using errcode = '22023';
  end if;
  if v_sl is not null and not exists (select 1 from pm.stock_locations s where s.org_id = v_org and s.id = v_sl and s.location_id = p_location) then
    raise exception 'PM_INVALID: that yard / stock location is not on this company' using errcode = '22023';
  end if;
  v_src := upper(coalesce(nullif(a ->> 'source', ''), 'MANUAL'));
  if v_src not in ('EDI_856','CSV','PDF','MANUAL') then raise exception 'PM_INVALID: source %', v_src using errcode = '22023'; end if;
  insert into pm.dlr_shipments (id, org_id, location_id, number, vendor_id, invoice_ref, ship_ref, source, source_file_name, stock_location_id,
                                floor_lender_vendor_id, floor_program, expected_on, notes)
  values (v_id, v_org, p_location, pm._d5_number(v_org, p_location, 'SHP'), v_vendor, nullif(btrim(a ->> 'invoice_ref'), ''),
          nullif(btrim(a ->> 'ship_ref'), ''), v_src, left(nullif(a ->> 'source_file_name', ''), 200), v_sl, v_lender,
          nullif(btrim(a ->> 'floor_program'), ''), pm._x_try_date(a ->> 'expected_on'), nullif(a ->> 'notes', ''));
  for l in select value from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_ser := nullif(upper(btrim(coalesce(l ->> 'serial_number', ''))), '');
    v_order := null;
    if v_ser is null then
      select x.id into v_order from pm.assets x
       where x.org_id = v_org and x.location_id = p_location and x.unit_status in ('ON_ORDER','IN_TRANSIT')
         and lower(coalesce(x.make, '')) = lower(coalesce(l ->> 'make', '')) and lower(coalesce(x.model, '')) = lower(coalesce(l ->> 'model', ''))
         and not exists (select 1 from pm.dlr_shipment_lines sl join pm.dlr_shipments s on s.org_id = sl.org_id and s.id = sl.shipment_id
                          where sl.org_id = v_org and sl.order_unit_id = x.id and s.status = 'OPEN')
       order by x.created_at limit 1;
    end if;
    insert into pm.dlr_shipment_lines (org_id, shipment_id, line_no, make, model, model_year, serial_number, description, category, cost_cents, order_unit_id)
    values (v_org, v_id, n, nullif(btrim(l ->> 'make'), ''), nullif(btrim(l ->> 'model'), ''), pm._x_try_num(l ->> 'model_year')::int,
            v_ser, left(nullif(l ->> 'description', ''), 300), nullif(l ->> 'category', ''), pm._x_try_bigint(l ->> 'cost_cents'), v_order);
  end loop;
  perform pm.log_activity(v_org, p_location, null, 'dealer_shipment.created', 'dlr_shipments', v_id, format('OEM shipment with %s unit(s)', n), jsonb_build_object('source', v_src));
  return jsonb_build_object('shipment_id', v_id, 'lines', n);
end $$;

-- One scan on the yard: the serial matches an expected line (SCANNED / DAMAGED), fills a serial-less
-- line of the same model, or is recorded as an EXTRA unit that was not on the paperwork.
create or replace function pm.dlr_scan_shipment(p_shipment uuid, p_code text, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_shipments%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_code text := upper(btrim(coalesce(p_code, ''))); l pm.dlr_shipment_lines%rowtype;
        v_result text; v_damaged boolean := coalesce(pm._x_try_bool(a ->> 'damaged'), false); v_n int;
begin
  select * into s from pm.dlr_shipments x where x.id = p_shipment for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  if s.status <> 'OPEN' then raise exception 'PM_INVALID: shipment % is %', s.number, s.status using errcode = '22023'; end if;
  if v_code = '' or char_length(v_code) > 80 then raise exception 'PM_INVALID: scan a serial number' using errcode = '22023'; end if;
  select * into l from pm.dlr_shipment_lines x where x.org_id = s.org_id and x.shipment_id = s.id and upper(x.serial_number) = v_code limit 1;
  if l.id is not null then
    if l.status in ('SCANNED','DAMAGED','EXTRA') then
      v_result := 'DUPLICATE';
    else
      update pm.dlr_shipment_lines set status = case when v_damaged then 'DAMAGED' else 'SCANNED' end, scanned_at = now(), scanned_by = pm.current_user_id(),
             damage_note = case when v_damaged then nullif(a ->> 'damage_note', '') else damage_note end,
             photo_document_ids = coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x), '{}'), updated_at = now()
       where id = l.id returning * into l;
      v_result := case when v_damaged then 'DAMAGED' else 'MATCHED' end;
    end if;
  else
    select * into l from pm.dlr_shipment_lines x
     where x.org_id = s.org_id and x.shipment_id = s.id and x.serial_number is null and x.status = 'EXPECTED'
       and (nullif(a ->> 'model', '') is null or lower(coalesce(x.model, '')) = lower(a ->> 'model'))
     order by x.line_no limit 1;
    if l.id is not null and nullif(a ->> 'model', '') is not null then
      update pm.dlr_shipment_lines set serial_number = v_code, status = case when v_damaged then 'DAMAGED' else 'SCANNED' end, scanned_at = now(),
             scanned_by = pm.current_user_id(), damage_note = case when v_damaged then nullif(a ->> 'damage_note', '') end, updated_at = now()
       where id = l.id returning * into l;
      v_result := 'FILLED';
    else
      select coalesce(max(x.line_no), 0) + 1 into v_n from pm.dlr_shipment_lines x where x.org_id = s.org_id and x.shipment_id = s.id;
      insert into pm.dlr_shipment_lines (org_id, shipment_id, line_no, make, model, serial_number, status, scanned_at, scanned_by, damage_note)
      values (s.org_id, s.id, v_n, coalesce(nullif(a ->> 'make', ''), (select v.name from core.vendors v where v.id = s.vendor_id)), nullif(a ->> 'model', ''),
              v_code, 'EXTRA', now(), pm.current_user_id(), case when v_damaged then nullif(a ->> 'damage_note', '') end)
      returning * into l;
      v_result := 'EXTRA';
    end if;
  end if;
  return jsonb_build_object('result', v_result, 'line_id', l.id, 'line_no', l.line_no, 'serial_number', l.serial_number, 'model', l.model, 'status', l.status,
    'remaining', (select count(*) from pm.dlr_shipment_lines x where x.org_id = s.org_id and x.shipment_id = s.id and x.status = 'EXPECTED'));
end $$;

-- Mark a line by hand (damaged with a note / photos, short, or back to expected).
create or replace function pm.dlr_mark_shipment_line(p_line uuid, p_status text, p_note text default null, p_photos uuid[] default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.dlr_shipment_lines%rowtype; s pm.dlr_shipments%rowtype; v_to text := upper(coalesce(p_status, ''));
begin
  select * into l from pm.dlr_shipment_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment line not found' using errcode = '42501'; end if;
  select * into s from pm.dlr_shipments x where x.org_id = l.org_id and x.id = l.shipment_id;
  if s.status <> 'OPEN' then raise exception 'PM_INVALID: shipment % is %', s.number, s.status using errcode = '22023'; end if;
  if v_to not in ('DAMAGED','SHORT','EXPECTED','SCANNED') then raise exception 'PM_INVALID: mark a line damaged, short, scanned or expected' using errcode = '22023'; end if;
  if v_to = 'DAMAGED' and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'PM_INVALID: describe the damage' using errcode = '22023'; end if;
  if v_to = 'SCANNED' and l.serial_number is null then raise exception 'PM_INVALID: scan the serial number first' using errcode = '22023'; end if;
  update pm.dlr_shipment_lines set status = v_to, damage_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), damage_note),
         photo_document_ids = coalesce(p_photos, photo_document_ids),
         scanned_at = case when v_to in ('SCANNED','DAMAGED') then coalesce(scanned_at, now()) when v_to = 'EXPECTED' then null else scanned_at end,
         updated_at = now()
   where id = l.id returning * into l;
  return jsonb_build_object('line_id', l.id, 'status', l.status);
end $$;

-- Receive every scanned / damaged / extra line (each through pm.receive_unit: unit created, cost line,
-- DEALER_UNIT_RECEIVED with the floor-plan lender + program hint); lines still EXPECTED become SHORT.
-- A line that cannot be received (serial already in stock, a customer's machine) is FAILED with the
-- reason; the rest still receive.
create or replace function pm.dlr_receive_shipment(p_shipment uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_shipments%rowtype; l pm.dlr_shipment_lines%rowtype; v_unit uuid; v_rec int := 0; v_short int := 0; v_fail int := 0; v_dmg int := 0; v_extra int := 0;
        v_attrs jsonb;
begin
  select * into s from pm.dlr_shipments x where x.id = p_shipment for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  if s.status <> 'OPEN' then raise exception 'PM_INVALID: shipment % is %', s.number, s.status using errcode = '22023'; end if;
  if exists (select 1 from pm.dlr_shipment_lines x where x.org_id = s.org_id and x.shipment_id = s.id and coalesce(x.cost_cents, 0) > 0)
     and not pm._x_sees('projects.financials', 'edit', s.location_id) then
    raise exception 'PM_FORBIDDEN: receiving units with their invoice cost needs Job financials edit (the office can receive this shipment)' using errcode = '42501';
  end if;
  for l in select * from pm.dlr_shipment_lines x where x.org_id = s.org_id and x.shipment_id = s.id order by x.line_no for update loop
    if l.status = 'EXPECTED' then
      update pm.dlr_shipment_lines set status = 'SHORT', updated_at = now() where id = l.id;
      v_short := v_short + 1;
      continue;
    end if;
    continue when l.status not in ('SCANNED','DAMAGED','EXTRA') or l.serial_number is null;
    v_attrs := jsonb_strip_nulls(jsonb_build_object('stock_location_id', s.stock_location_id, 'mfr_vendor_id', s.vendor_id,
      'mfr_invoice_ref', coalesce(s.invoice_ref, s.ship_ref), 'model_year', l.model_year, 'category', l.category, 'description', l.description,
      'floor_plan', jsonb_strip_nulls(jsonb_build_object('lender_vendor_id', s.floor_lender_vendor_id, 'program', s.floor_program, 'shipment', s.number)),
      'condition', 'NEW'));
    begin
      v_unit := pm.receive_unit(s.location_id, l.serial_number, coalesce(l.make, (select v.name from core.vendors v where v.id = s.vendor_id)), l.model,
                                coalesce(l.cost_cents, 0), v_attrs, l.order_unit_id);
      if l.status = 'DAMAGED' then
        v_dmg := v_dmg + 1;
        perform pm.set_dealer_unit_status(v_unit, 'ON_HOLD', left('Damaged on receipt: ' || coalesce(l.damage_note, ''), 200));
      end if;
      if l.status = 'EXTRA' then v_extra := v_extra + 1; end if;
      update pm.dlr_shipment_lines set unit_id = v_unit, status = 'RECEIVED', error = null, updated_at = now() where id = l.id;
      v_rec := v_rec + 1;
    exception when others then
      update pm.dlr_shipment_lines set status = 'FAILED', error = left(sqlerrm, 300), updated_at = now() where id = l.id;
      v_fail := v_fail + 1;
    end;
  end loop;
  update pm.dlr_shipments set status = 'RECEIVED', received_at = now(), received_by = pm.current_user_id(), updated_at = now(),
         summary = jsonb_build_object('received', v_rec, 'short', v_short, 'damaged', v_dmg, 'extra', v_extra, 'failed', v_fail)
   where id = s.id;
  perform pm.log_activity(s.org_id, s.location_id, null, 'dealer_shipment.received', 'dlr_shipments', s.id,
    format('Shipment %s received: %s in, %s short, %s damaged, %s failed', s.number, v_rec, v_short, v_dmg, v_fail), '{}'::jsonb);
  return jsonb_build_object('shipment_id', s.id, 'received', v_rec, 'short', v_short, 'damaged', v_dmg, 'extra', v_extra, 'failed', v_fail);
end $$;

create or replace function pm.dlr_shipment_detail(p_shipment uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_shipments%rowtype; v_fin boolean;
begin
  select * into s from pm.dlr_shipments x where x.id = p_shipment;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', s.location_id);
  return jsonb_build_object('shipment', to_jsonb(s) || jsonb_build_object('vendor', (select v.name from core.vendors v where v.id = s.vendor_id),
      'lender', (select v.name from core.vendors v where v.id = s.floor_lender_vendor_id)),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'line_no', l.line_no, 'make', l.make, 'model', l.model, 'model_year', l.model_year,
       'serial_number', l.serial_number, 'description', l.description, 'status', l.status, 'damage_note', l.damage_note, 'error', l.error,
       'unit_id', l.unit_id, 'order_unit_id', l.order_unit_id, 'photos', cardinality(l.photo_document_ids),
       'cost_cents', case when v_fin then l.cost_cents end) order by l.line_no)
       from pm.dlr_shipment_lines l where l.org_id = s.org_id and l.shipment_id = s.id), '[]'::jsonb),
    'amounts_visible', v_fin);
end $$;

-- ----------------------------------------------------------------------------
-- D2. DLR-09 Lot app + floor-plan audit
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_lot_audits (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  number            text not null,
  purpose           text not null default 'ROUTINE' check (purpose in ('ROUTINE','LENDER_AUDIT')),
  lender_vendor_id  uuid references core.vendors(id),
  status            text not null default 'OPEN' check (status in ('OPEN','CLOSED','CANCELLED')),
  started_by        text default pm.current_user_id(),
  started_at        timestamptz not null default now(),
  closed_by         text,
  closed_at         timestamptz,
  summary           jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  unique (org_id, id),
  unique (org_id, number)
);
create unique index if not exists pm_dlr_lot_audits_open_uidx on pm.dlr_lot_audits (org_id, location_id) where status = 'OPEN';

create table if not exists pm.dlr_lot_scans (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  audit_id           uuid not null,
  code               text not null check (char_length(code) between 1 and 80),
  unit_id            uuid,
  result             text not null check (result in ('FOUND','UNKNOWN','WRONG_STORE','NOT_IN_STOCK','DUPLICATE')),
  lat                numeric(9,6),
  lng                numeric(9,6),
  distance_m         numeric(12,1),
  gps_flag           boolean not null default false,
  photo_document_id  uuid,
  note               text,
  scanned_by         text default pm.current_user_id(),
  scanned_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, audit_id) references pm.dlr_lot_audits (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_lot_scans_audit_idx on pm.dlr_lot_scans (org_id, audit_id, unit_id);

create or replace function pm.dlr_start_lot_audit(p_location uuid, p_purpose text default 'ROUTINE', p_lender uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid;
begin
  if upper(coalesce(p_purpose, 'ROUTINE')) not in ('ROUTINE','LENDER_AUDIT') then raise exception 'PM_INVALID: purpose %', p_purpose using errcode = '22023'; end if;
  if p_lender is not null and not exists (select 1 from core.vendors v where v.id = p_lender and v.org_id = v_org) then
    raise exception 'PM_UNKNOWN_VENDOR: the lender is not a vendor in this organization' using errcode = '22023';
  end if;
  if exists (select 1 from pm.dlr_lot_audits a where a.org_id = v_org and a.location_id = p_location and a.status = 'OPEN') then
    raise exception 'PM_DUPLICATE: a lot count is already open at this store; finish or cancel it first' using errcode = '23505';
  end if;
  insert into pm.dlr_lot_audits (org_id, location_id, number, purpose, lender_vendor_id)
  values (v_org, p_location, pm._d5_number(v_org, p_location, 'LOT'), upper(coalesce(p_purpose, 'ROUTINE')), p_lender) returning id into v_id;
  return v_id;
end $$;

create or replace function pm.dlr_lot_scan(p_audit uuid, p_code text, p_lat numeric default null, p_lng numeric default null,
                                            p_photo uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare au pm.dlr_lot_audits%rowtype; v_code text := upper(btrim(coalesce(p_code, ''))); u pm.assets%rowtype; v_res text; v_set jsonb; v_dist numeric; v_flag boolean := false;
        v_id uuid;
begin
  select * into au from pm.dlr_lot_audits x where x.id = p_audit;
  if au.org_id is null or au.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: lot count not found' using errcode = '42501'; end if;
  if au.status <> 'OPEN' then raise exception 'PM_INVALID: lot count % is %', au.number, au.status using errcode = '22023'; end if;
  if v_code = '' or char_length(v_code) > 80 then raise exception 'PM_INVALID: scan a stock number, serial or VIN' using errcode = '22023'; end if;
  select * into u from pm.assets a
   where a.org_id = au.org_id and a.unit_status is not null
     and (upper(a.stock_number) = v_code or upper(a.serial_number) = v_code or upper(a.vin) = v_code)
   order by (a.location_id = au.location_id) desc, a.updated_at desc limit 1;
  if u.id is null then v_res := 'UNKNOWN';
  elsif u.location_id <> au.location_id then v_res := 'WRONG_STORE';
  elsif u.unit_status in ('DELIVERED','RETURNED_TO_MFR','TRANSFERRED','ON_ORDER') then v_res := 'NOT_IN_STOCK';
  elsif exists (select 1 from pm.dlr_lot_scans s where s.org_id = au.org_id and s.audit_id = au.id and s.unit_id = u.id and s.result = 'FOUND') then v_res := 'DUPLICATE';
  else v_res := 'FOUND'; end if;
  v_set := pm._d5_set(au.org_id, au.location_id);
  v_dist := pm._d5_meters(p_lat, p_lng, pm._x_try_num(v_set ->> 'lot_lat'), pm._x_try_num(v_set ->> 'lot_lng'));
  v_flag := v_dist is not null and v_dist > coalesce(pm._x_try_num(v_set ->> 'lot_radius_m'), 400);
  insert into pm.dlr_lot_scans (org_id, audit_id, code, unit_id, result, lat, lng, distance_m, gps_flag, photo_document_id, note)
  values (au.org_id, au.id, v_code, u.id, v_res, p_lat, p_lng, v_dist, v_flag, p_photo, nullif(btrim(coalesce(p_note, '')), '')) returning id into v_id;
  return jsonb_build_object('scan_id', v_id, 'result', v_res, 'gps_flag', v_flag, 'distance_m', v_dist,
    'unit', case when u.id is null then null else jsonb_build_object('id', u.id, 'stock_number', u.stock_number, 'serial_number', u.serial_number,
      'make', u.make, 'model', u.model, 'unit_status', u.unit_status, 'store', (select l.name from core.locations l where l.id = u.location_id)) end);
end $$;

-- Count vs system and the lender's list. Expected on the lot: stock, PDI, demo, hold, sold-not-delivered and
-- rental units not out on a contract. Floor-plan money only with Job financials.
create or replace function pm.dlr_lot_audit_report(p_audit uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare au pm.dlr_lot_audits%rowtype; v_fin boolean; v_exp jsonb; v_missing jsonb; v_sold jsonb; v_demo jsonb; v_gps jsonb; v_unknown jsonb; v_n_exp int; v_n_found int;
begin
  select * into au from pm.dlr_lot_audits x where x.id = p_audit;
  if au.org_id is null or au.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: lot count not found' using errcode = '42501'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', au.location_id);
  with exp as (
    select a.* from pm.assets a
     where a.org_id = au.org_id and a.location_id = au.location_id
       and a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD','SOLD','RENTAL')
       and (au.lender_vendor_id is null or a.floor_lender_vendor_id = au.lender_vendor_id)
       and not exists (select 1 from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id and r.status = 'OUT')
  ), found as (select distinct s.unit_id from pm.dlr_lot_scans s where s.org_id = au.org_id and s.audit_id = au.id and s.result = 'FOUND')
  select count(*), count(*) filter (where e.id in (select unit_id from found)),
         coalesce(jsonb_agg(jsonb_build_object('unit_id', e.id, 'stock_number', e.stock_number, 'serial_number', e.serial_number, 'make', e.make, 'model', e.model,
                  'unit_status', e.unit_status, 'floored', e.floored, 'payoff_cents', case when v_fin then e.payoff_cents end)
                  order by e.stock_number) filter (where e.id not in (select unit_id from found)), '[]'::jsonb)
    into v_n_exp, v_n_found, v_missing from exp e;
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'serial_number', a.serial_number, 'make', a.make, 'model', a.model,
           'unit_status', a.unit_status, 'sold_on', a.unit_sold_on, 'delivered_on', a.unit_delivered_on, 'payoff_due_on', a.payoff_due_on,
           'payoff_cents', case when v_fin then a.payoff_cents end) order by a.unit_sold_on), '[]'::jsonb)
    into v_sold from pm.assets a
   where a.org_id = au.org_id and a.location_id = au.location_id and a.floored and not a.payoff_scheduled
     and (a.unit_status in ('SOLD','DELIVERED') or a.floor_status = 'SOLD_UNPAID')
     and (au.lender_vendor_id is null or a.floor_lender_vendor_id = au.lender_vendor_id);
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'make', a.make, 'model', a.model, 'meter', a.meter_reading)), '[]'::jsonb)
    into v_demo from pm.assets a where a.org_id = au.org_id and a.location_id = au.location_id and a.unit_status = 'DEMO';
  select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'unit_id', s.unit_id, 'distance_m', s.distance_m, 'scanned_at', s.scanned_at) order by s.scanned_at), '[]'::jsonb)
    into v_gps from pm.dlr_lot_scans s where s.org_id = au.org_id and s.audit_id = au.id and s.gps_flag;
  select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'result', s.result, 'unit_id', s.unit_id, 'note', s.note) order by s.scanned_at), '[]'::jsonb)
    into v_unknown from pm.dlr_lot_scans s where s.org_id = au.org_id and s.audit_id = au.id and s.result in ('UNKNOWN','WRONG_STORE','NOT_IN_STOCK');
  return jsonb_build_object('audit', to_jsonb(au) - 'summary', 'expected', v_n_exp, 'found', v_n_found, 'missing', v_missing, 'sold_not_paid', v_sold,
    'on_demo', v_demo, 'gps_flags', v_gps, 'exceptions', v_unknown,
    'scans', (select count(*) from pm.dlr_lot_scans s where s.org_id = au.org_id and s.audit_id = au.id), 'amounts_visible', v_fin);
end $$;

create or replace function pm.dlr_close_lot_audit(p_audit uuid, p_cancel boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare au pm.dlr_lot_audits%rowtype; r jsonb;
begin
  select * into au from pm.dlr_lot_audits x where x.id = p_audit for update;
  if au.org_id is null or au.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: lot count not found' using errcode = '42501'; end if;
  if au.status <> 'OPEN' then raise exception 'PM_INVALID: lot count % is %', au.number, au.status using errcode = '22023'; end if;
  r := pm.dlr_lot_audit_report(au.id);
  update pm.dlr_lot_audits set status = case when p_cancel then 'CANCELLED' else 'CLOSED' end, closed_at = now(), closed_by = pm.current_user_id(),
         summary = jsonb_build_object('expected', r -> 'expected', 'found', r -> 'found', 'missing', jsonb_array_length(r -> 'missing'),
                                      'sold_not_paid', jsonb_array_length(r -> 'sold_not_paid'), 'gps_flags', jsonb_array_length(r -> 'gps_flags'),
                                      'exceptions', jsonb_array_length(r -> 'exceptions'))
   where id = au.id;
  perform pm.log_activity(au.org_id, au.location_id, null, 'lot_audit.closed', 'dlr_lot_audits', au.id,
    format('Lot count %s: %s of %s found', au.number, r ->> 'found', r ->> 'expected'), '{}'::jsonb);
  return r;
end $$;

-- ----------------------------------------------------------------------------
-- D3. DLR-10 Used / trade-in recon
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_recons (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  asset_id       uuid not null,
  unit_life      int not null,
  trade_id       uuid,
  job_id         uuid,
  work_order_id  uuid,
  status         text not null default 'OPEN' check (status in ('OPEN','DONE','WAIVED')),
  checklist      jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  note           text,
  opened_by      text default pm.current_user_id(),
  opened_at      timestamptz not null default now(),
  done_by        text,
  done_at        timestamptz,
  waive_reason   text,
  unique (org_id, id),
  unique (org_id, asset_id, unit_life),
  check (status = 'OPEN' or done_at is not null),
  check (status <> 'WAIVED' or waive_reason is not null),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_recons_open_idx on pm.dlr_recons (org_id, location_id) where status = 'OPEN';

-- Open the recon RO on a used unit (internal pay, routed RECON so its cost capitalizes to the serial).
create or replace function pm._d5_open_recon(p_org uuid, p_unit uuid, p_trade uuid, p_job uuid, p_checklist jsonb) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_job uuid := p_job; v_wo uuid; v_id uuid; v_set jsonb; i jsonb; n int := 0;
begin
  select * into a from pm.assets x where x.org_id = p_org and x.id = p_unit;
  if a.id is null then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  select r.id into v_id from pm.dlr_recons r where r.org_id = p_org and r.asset_id = a.id and r.unit_life = a.unit_life;
  if v_id is not null then return v_id; end if;
  -- nested-guard audit: create_project's guard is skipped here — without Jobs create the recon opens
  -- with no RO (opened later from the recon board by someone who has it); a passed job must be this store's.
  if v_job is not null and (select jx.location_id from core.jobs jx where jx.id = v_job) is distinct from a.location_id then
    raise exception 'PM_INVALID: that job is at another company' using errcode = '22023';
  end if;
  if v_job is null and pm._x_sees('projects.jobs', 'create', a.location_id) then
    v_set := pm._d5_set(p_org, a.location_id);
    begin
      v_job := pm.create_project(a.location_id, 'pdi_setup', format('Recon %s %s %s', coalesce(a.stock_number, ''), coalesce(a.make, ''), coalesce(a.model, '')),
                                 null, null, a.is_sample, '{}'::jsonb);
    exception when others then
      begin
        v_job := pm.create_project(a.location_id, coalesce(v_set ->> 'service_job_type_key', 'customer_repair'),
                                   format('Recon %s', coalesce(a.stock_number, a.serial_number)), null, null, a.is_sample, '{}'::jsonb);
      exception when others then v_job := null; end;
    end;
  end if;
  if v_job is not null then
    v_wo := pm.create_work_order(v_job, 'REPAIR_ORDER', left(format('Recon %s', coalesce(pm._d5_unit_label(a.id), '')), 200), 3, a.id, null, null, null, '{}', 'INTERNAL');
    for i in select value from jsonb_array_elements(coalesce(p_checklist, '[]'::jsonb)) loop
      n := n + 1;
      insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, pay_type, internal_route, internal_asset_id, flag_hours)
      values (p_org, v_job, v_wo, n, 'LABOR', left(coalesce(i ->> 'label', i #>> '{}', 'Recon item'), 300), 1, 'INTERNAL', 'RECON', a.id, pm._x_try_num(i ->> 'hours'));
    end loop;
  end if;
  insert into pm.dlr_recons (org_id, location_id, asset_id, unit_life, trade_id, job_id, work_order_id, checklist)
  values (p_org, a.location_id, a.id, a.unit_life, p_trade, case when v_wo is null then null else v_job end, v_wo, coalesce(p_checklist, '[]'::jsonb))
  returning id into v_id;
  perform pm.log_activity(p_org, a.location_id, v_job, 'recon.opened', 'dlr_recons', v_id,
    format('Recon opened on %s%s', coalesce(a.stock_number, a.serial_number), case when v_wo is null then ' (no RO: open one from the recon board)' else '' end),
    jsonb_build_object('work_order_id', v_wo));
  return v_id;
end $$;

create or replace function pm.dlr_open_recon(p_unit uuid, p_job uuid default null, p_checklist jsonb default '[]')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype;
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  if a.unit_status is null or a.unit_status not in ('IN_STOCK','ON_HOLD','DEMO','RENTAL') then
    raise exception 'PM_UNIT_TRANSITION_INVALID: recon needs a unit in stock (this one is %)', coalesce(a.unit_status, 'not dealer stock') using errcode = '22023';
  end if;
  if p_job is not null then perform pm._x_job(p_job); end if;
  if jsonb_typeof(coalesce(p_checklist, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: the recon list is a list' using errcode = '22023'; end if;
  return pm._d5_open_recon(a.org_id, a.id, null, p_job, coalesce(p_checklist, '[]'::jsonb));
end $$;

-- Done when the recon RO is complete or closed; a waiver needs a reason and Dealer store approve.
create or replace function pm.dlr_complete_recon(p_recon uuid, p_waive_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dlr_recons%rowtype; v_st text;
begin
  select * into r from pm.dlr_recons x where x.id = p_recon for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: recon not found' using errcode = '42501'; end if;
  if r.status <> 'OPEN' then raise exception 'PM_INVALID: this recon is already %', lower(r.status) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_waive_reason, '')), '') is not null then
    if not pm._x_sees('projects.store', 'approve', r.location_id) then
      raise exception 'PM_FORBIDDEN: waiving recon needs Dealer store approve' using errcode = '42501';
    end if;
    update pm.dlr_recons set status = 'WAIVED', waive_reason = btrim(p_waive_reason), done_at = now(), done_by = pm.current_user_id() where id = r.id;
  else
    select w.status into v_st from pm.work_orders w where w.org_id = r.org_id and w.id = r.work_order_id;
    if r.work_order_id is null or v_st not in ('COMPLETE','CLOSED') then
      raise exception 'PM_RECON_OPEN: finish the recon RO first (it is %)', coalesce(lower(v_st), 'not opened') using errcode = '22023';
    end if;
    update pm.dlr_recons set status = 'DONE', done_at = now(), done_by = pm.current_user_id() where id = r.id;
  end if;
  perform pm.log_activity(r.org_id, r.location_id, r.job_id, 'recon.done', 'dlr_recons', r.id, 'Recon finished; the unit can be listed', '{}'::jsonb);
  return jsonb_build_object('recon_id', r.id, 'status', (select status from pm.dlr_recons where id = r.id));
end $$;

create or replace function pm.dlr_recon_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('recon_id', r.id, 'status', r.status, 'unit_id', r.asset_id, 'unit', pm._d5_unit_label(r.asset_id),
      'work_order_id', r.work_order_id, 'ro_number', w.number, 'ro_status', w.status, 'opened_at', r.opened_at, 'done_at', r.done_at,
      'days_open', (current_date - r.opened_at::date), 'checklist', r.checklist, 'waive_reason', r.waive_reason)
      order by (r.status = 'OPEN') desc, r.opened_at)
    from pm.dlr_recons r left join pm.work_orders w on w.org_id = r.org_id and w.id = r.work_order_id
   where r.org_id = v_org and r.location_id = p_location and (r.status = 'OPEN' or r.done_at > now() - interval '30 days')), '[]'::jsonb);
end $$;

-- A trade received into stock opens recon (store setting recon_required, default on). Never fails the trade.
create or replace function pm.tg_d5_trade_recon() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid;
begin
  if new.status = 'RECEIVED' and old.status is distinct from 'RECEIVED' and new.received_asset_id is not null then
    select a.location_id into v_loc from pm.assets a where a.org_id = new.org_id and a.id = new.received_asset_id;
    if v_loc is not null and coalesce((pm._d5_set(new.org_id, v_loc) ->> 'recon_required')::boolean, true) then
      begin
        perform pm._d5_open_recon(new.org_id, new.received_asset_id, new.id, null, '[]'::jsonb);
      exception when others then
        raise warning '1125 recon on trade % failed: %', new.id, sqlerrm;
      end;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_d5_trade_recon on pm.dealer_trades;
create trigger trg_d5_trade_recon after update of status on pm.dealer_trades for each row execute function pm.tg_d5_trade_recon();

-- Listing lock: no deal line and no advertised price on a unit whose recon is open.
create or replace function pm.tg_d5_recon_lock_deal_line() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.asset_id is not null and new.line_type = 'UNIT' and exists (
       select 1 from pm.dlr_recons r join pm.assets a on a.org_id = r.org_id and a.id = r.asset_id and a.unit_life = r.unit_life
        where r.org_id = new.org_id and r.asset_id = new.asset_id and r.status = 'OPEN') then
    raise exception 'PM_RECON_OPEN: this unit is in recon; finish (or waive) recon before it goes on a deal' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_recon_lock_deal_line on pm.dealer_deal_lines;
create trigger trg_d5_recon_lock_deal_line before insert or update of asset_id on pm.dealer_deal_lines for each row execute function pm.tg_d5_recon_lock_deal_line();

create or replace function pm.tg_d5_recon_lock_listing() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.advertised_price_cents is not null and new.advertised_price_cents is distinct from old.advertised_price_cents and exists (
       select 1 from pm.dlr_recons r where r.org_id = new.org_id and r.asset_id = new.id and r.unit_life = new.unit_life and r.status = 'OPEN') then
    raise exception 'PM_RECON_OPEN: this unit is in recon; it can be listed for sale once recon is done' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_recon_lock_listing on pm.assets;
create trigger trg_d5_recon_lock_listing before update of advertised_price_cents on pm.assets for each row execute function pm.tg_d5_recon_lock_listing();

-- ----------------------------------------------------------------------------
-- D4. DLR-13 Payment-scenario quoting (the menu the customer sees)
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_quote_payment_options (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  quote_id     uuid not null,
  deal_id      uuid not null,
  menu         jsonb not null check (jsonb_typeof(menu) = 'object'),
  chosen_code  text,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, quote_id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

-- Every scenario at each down payment, side by side, with the picks: lowest customer payment and
-- (financials only) best dealer net after subvention; a rebate-vs-low-APR comparison per down payment
-- (total the customer pays either way). Deterministic: the math is 1122's pm.dlr_payment_scenarios.
create or replace function pm.dlr_payment_menu(p_deal uuid, p_downs bigint[] default '{0}')
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_dn bigint; v_s jsonb; v_rows jsonb := '[]'; v_fin boolean; v_low text; v_best text; v_cmp jsonb; x jsonb;
        v_rebate_total bigint; v_promo_total bigint; v_rebate_code text; v_promo_code text;
begin
  select * into d from pm.dealer_deals q where q.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  if coalesce(cardinality(p_downs), 0) = 0 or cardinality(p_downs) > 4 then raise exception 'PM_INVALID: one to four down payments' using errcode = '22023'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', d.location_id);
  foreach v_dn in array p_downs loop
    if v_dn < 0 then raise exception 'PM_INVALID: a down payment is ≥ 0' using errcode = '22023'; end if;
    v_s := pm.dlr_payment_scenarios(d.id, v_dn);
    select x2 ->> 'code' into v_low from jsonb_array_elements(v_s -> 'scenarios') x2
     where (x2 ->> 'monthly_cents') is not null order by (x2 ->> 'monthly_cents')::bigint, x2 ->> 'code' limit 1;
    v_best := null;
    if v_fin then
      select x2 ->> 'code' into v_best from jsonb_array_elements(v_s -> 'scenarios') x2
       where (x2 ->> 'dealer_net_front_cents') is not null order by (x2 ->> 'dealer_net_front_cents')::bigint desc, x2 ->> 'code' limit 1;
    end if;
    -- rebate + standard rate vs the promo rate: total of payments + down (− rebate already in the financed amount)
    v_rebate_total := null; v_promo_total := null; v_rebate_code := null; v_promo_code := null;
    for x in select value from jsonb_array_elements(v_s -> 'scenarios') loop
      if x ->> 'kind' = 'CASH_REBATE' and (x ->> 'monthly_cents') is not null then
        if v_rebate_total is null or (x ->> 'monthly_cents')::bigint * (x ->> 'term_months')::int + v_dn < v_rebate_total then
          v_rebate_total := (x ->> 'monthly_cents')::bigint * (x ->> 'term_months')::int + v_dn; v_rebate_code := x ->> 'code';
        end if;
      elsif x ->> 'kind' = 'PROMO_RATE' then
        if v_promo_total is null or (x ->> 'total_of_payments_cents')::bigint + v_dn < v_promo_total then
          v_promo_total := (x ->> 'total_of_payments_cents')::bigint + v_dn; v_promo_code := x ->> 'code';
        end if;
      end if;
    end loop;
    v_cmp := case when v_rebate_total is not null and v_promo_total is not null then jsonb_build_object(
               'rebate_code', v_rebate_code, 'rebate_total_cents', v_rebate_total, 'promo_code', v_promo_code, 'promo_total_cents', v_promo_total,
               'better', case when v_rebate_total < v_promo_total then 'REBATE' when v_promo_total < v_rebate_total then 'PROMO_RATE' else 'EVEN' end,
               'difference_cents', abs(v_rebate_total - v_promo_total)) end;
    v_rows := v_rows || jsonb_build_object('down_cents', v_dn, 'balance_due_cents', v_s -> 'balance_due_cents', 'scenarios', v_s -> 'scenarios',
                                           'lowest_monthly_code', v_low, 'best_dealer_net_code', v_best, 'rebate_vs_rate', v_cmp);
  end loop;
  return jsonb_build_object('deal_id', d.id, 'downs', v_rows, 'amounts_visible', v_fin);
end $$;

-- Pin the menu on an issued quote (what the customer was shown); dealer-net keys never stored.
create or replace function pm.dlr_attach_payment_menu(p_quote uuid, p_downs bigint[] default '{0}', p_chosen text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare qt pm.dealer_quotes%rowtype; v_menu jsonb;
begin
  select * into qt from pm.dealer_quotes x where x.id = p_quote;
  if qt.org_id is null or qt.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: quote not found' using errcode = '42501'; end if;
  v_menu := pm.dlr_payment_menu(qt.deal_id, p_downs);
  -- strip dealer-side figures: the pinned menu is customer-facing
  v_menu := jsonb_set(v_menu, '{downs}', coalesce((select jsonb_agg((r - 'best_dealer_net_code') || jsonb_build_object('scenarios',
              coalesce((select jsonb_agg(s - 'subvention_cents' - 'dealer_net_front_cents') from jsonb_array_elements(r -> 'scenarios') s), '[]'::jsonb)))
              from jsonb_array_elements(v_menu -> 'downs') r), '[]'::jsonb)) - 'amounts_visible';
  insert into pm.dlr_quote_payment_options (org_id, location_id, quote_id, deal_id, menu, chosen_code)
  values (qt.org_id, qt.location_id, qt.id, qt.deal_id, v_menu, nullif(btrim(coalesce(p_chosen, '')), ''))
  on conflict (org_id, quote_id) do update set menu = excluded.menu, chosen_code = excluded.chosen_code, created_at = now(), created_by = pm.current_user_id();
  return v_menu || jsonb_build_object('quote_id', qt.id, 'chosen_code', p_chosen);
end $$;

-- ----------------------------------------------------------------------------
-- D5. DLR-14 OEM program + incentive library, claims tracked to receipt
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_incentives (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  code                  text not null check (code ~ '^[A-Za-z0-9_.-]{2,40}$'),
  name                  text not null check (char_length(name) between 1 and 160),
  kind                  text not null check (kind in ('RETAIL_REBATE','DEALER_CASH','SPIFF','VOLUME','COOP','DEMO_ALLOWANCE','OTHER')),
  brand                 text,
  oem_vendor_id         uuid references core.vendors(id),
  model_pattern         text,
  categories            text[] not null default '{}',
  new_only              boolean not null default true,
  starts_on             date,
  ends_on               date,
  amount_cents          bigint not null default 0 check (amount_cents >= 0),
  pct_of_price          numeric(6,5) not null default 0 check (pct_of_price >= 0 and pct_of_price <= 1),
  payee                 text not null default 'DEALER' check (payee in ('DEALER','SALESPERSON','CUSTOMER')),
  claim_deadline_days   int check (claim_deadline_days is null or claim_deadline_days between 0 and 730),
  volume_target_units   int check (volume_target_units is null or volume_target_units > 0),
  bulletin_ref          text,
  bulletin_document_id  uuid,
  notes                 text,
  is_active             boolean not null default true,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, code),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (amount_cents > 0 or pct_of_price > 0)
);

create table if not exists pm.dlr_deal_incentives (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  deal_id       uuid not null,
  incentive_id  uuid not null,
  amount_cents  bigint not null check (amount_cents >= 0),
  added_by      text default pm.current_user_id(),
  added_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, deal_id, incentive_id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, incentive_id) references pm.dlr_incentives (org_id, id) deferrable initially immediate
);

create table if not exists pm.dlr_incentive_claims (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  deal_id          uuid not null,
  incentive_id     uuid,
  program_code     text not null,
  source           text not null check (source in ('FINANCE_PROGRAM','INCENTIVE')),
  kind             text not null,
  payee            text not null default 'DEALER',
  oem_vendor_id    uuid references core.vendors(id),
  amount_cents     bigint not null check (amount_cents >= 0),
  earned_on        date not null,
  claim_by         date,
  status           text not null default 'DUE' check (status in ('DUE','SUBMITTED','PAID','DENIED','VOID')),
  claim_ref        text,
  submitted_at     timestamptz,
  paid_on          date,
  paid_cents       bigint check (paid_cents is null or paid_cents >= 0),
  denied_reason    text,
  notes            text,
  updated_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, deal_id, program_code),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_incentive_claims_due_idx on pm.dlr_incentive_claims (org_id, location_id, status, claim_by);

-- Incentives eligible for a deal today (brand = unit make, model pattern, category, new-only, dates).
create or replace function pm.dlr_eligible_incentives(p_deal uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_fin boolean;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', d.location_id);
  return coalesce((select jsonb_agg(jsonb_build_object('incentive_id', i.id, 'code', i.code, 'name', i.name, 'kind', i.kind, 'payee', i.payee,
      'claim_deadline_days', i.claim_deadline_days, 'ends_on', i.ends_on, 'unit_id', u.asset_id,
      'applied', exists (select 1 from pm.dlr_deal_incentives di where di.org_id = d.org_id and di.deal_id = d.id and di.incentive_id = i.id),
      'amount_cents', case when v_fin then i.amount_cents + round(u.unit_price_cents * i.pct_of_price)::bigint end) order by i.code)
    from pm.dlr_incentives i
    join lateral (select l.asset_id, l.unit_price_cents, a.make, a.model, a.category, a.condition
                    from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
                   where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
                     and (i.brand is null or upper(a.make) = upper(i.brand))
                     and (i.model_pattern is null or a.model ilike replace(i.model_pattern, '*', '%'))
                     and (cardinality(i.categories) = 0 or a.category = any (i.categories))
                     and (not i.new_only or a.condition = 'NEW')
                   order by l.line_no limit 1) u on true
   where i.org_id = d.org_id and i.location_id = d.location_id and i.is_active
     and (i.starts_on is null or i.starts_on <= current_date) and (i.ends_on is null or i.ends_on >= current_date)), '[]'::jsonb);
end $$;

-- Put a dealer-side incentive on a deal (QUOTE / WRITTEN). Customer-facing rebates stay 1122 finance
-- programs (they change the price); these never change the customer's numbers.
create or replace function pm.dlr_apply_incentive(p_deal uuid, p_incentive uuid, p_remove boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; e jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  if d.stage not in ('QUOTE','WRITTEN','APPROVED','FUNDED') then raise exception 'PM_DEAL_LOCKED: deal % is %', d.number, d.stage using errcode = '55000'; end if;
  if p_remove then
    delete from pm.dlr_deal_incentives where org_id = d.org_id and deal_id = d.id and incentive_id = p_incentive;
    return jsonb_build_object('deal_id', d.id, 'removed', true);
  end if;
  select x into e from jsonb_array_elements(pm.dlr_eligible_incentives(d.id)) x where x ->> 'incentive_id' = p_incentive::text;
  if e is null then raise exception 'PM_PROGRAM_NOT_ELIGIBLE: that incentive does not apply to this deal today' using errcode = '22023'; end if;
  insert into pm.dlr_deal_incentives (org_id, deal_id, incentive_id, amount_cents)
  select d.org_id, d.id, i.id, i.amount_cents + round(coalesce((select l.unit_price_cents from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id
            and l.asset_id = (e ->> 'unit_id')::uuid limit 1), 0) * i.pct_of_price)::bigint
    from pm.dlr_incentives i where i.id = p_incentive
  on conflict (org_id, deal_id, incentive_id) do nothing;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.incentive', 'dealer_deals', d.id, format('Incentive %s on %s', e ->> 'code', d.number), '{}'::jsonb);
  return jsonb_build_object('deal_id', d.id, 'code', e ->> 'code');
end $$;

-- At delivery: one claim per OEM rebate line (1122 cash-rebate program code) and per dealer incentive,
-- claim-by = delivered + the program's claim deadline. An unwind voids open claims.
create or replace function pm.tg_d5_deal_claims() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.stage = 'DELIVERED' and old.stage is distinct from 'DELIVERED' then
    insert into pm.dlr_incentive_claims (org_id, location_id, deal_id, program_code, source, kind, payee, oem_vendor_id, amount_cents, earned_on, claim_by)
    select new.org_id, new.location_id, new.id, l.program_ref, 'FINANCE_PROGRAM', 'RETAIL_REBATE', 'DEALER', coalesce(l.oem_vendor_id, f.oem_vendor_id),
           abs(coalesce(l.amount_cents, l.unit_price_cents)), coalesce(new.delivered_on, current_date),
           case when f.claim_deadline_days is not null then coalesce(new.delivered_on, current_date) + f.claim_deadline_days end
      from pm.dealer_deal_lines l
      left join pm.dlr_finance_programs f on f.org_id = l.org_id and f.location_id = new.location_id and f.code = l.program_ref
     where l.org_id = new.org_id and l.deal_id = new.id and l.line_type = 'REBATE' and l.program_ref is not null
    on conflict (org_id, deal_id, program_code) do nothing;
    insert into pm.dlr_incentive_claims (org_id, location_id, deal_id, incentive_id, program_code, source, kind, payee, oem_vendor_id, amount_cents, earned_on, claim_by)
    select new.org_id, new.location_id, new.id, i.id, i.code, 'INCENTIVE', i.kind, i.payee, i.oem_vendor_id, di.amount_cents, coalesce(new.delivered_on, current_date),
           case when i.claim_deadline_days is not null then coalesce(new.delivered_on, current_date) + i.claim_deadline_days end
      from pm.dlr_deal_incentives di join pm.dlr_incentives i on i.org_id = di.org_id and i.id = di.incentive_id
     where di.org_id = new.org_id and di.deal_id = new.id
    on conflict (org_id, deal_id, program_code) do nothing;
  elsif new.stage = 'UNWOUND' and old.stage is distinct from 'UNWOUND' then
    update pm.dlr_incentive_claims set status = 'VOID', notes = coalesce(notes || ' · ', '') || 'Deal unwound', updated_at = now()
     where org_id = new.org_id and deal_id = new.id and status in ('DUE','SUBMITTED');
  end if;
  return null;
end $$;
drop trigger if exists trg_d5_deal_claims on pm.dealer_deals;
create trigger trg_d5_deal_claims after update of stage on pm.dealer_deals for each row execute function pm.tg_d5_deal_claims();

create or replace function pm.dlr_update_incentive_claim(p_claim uuid, p_status text, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.dlr_incentive_claims%rowtype; v_to text := upper(coalesce(p_status, '')); a jsonb := coalesce(p_attrs, '{}'); ok boolean;
begin
  select * into c from pm.dlr_incentive_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: claim not found' using errcode = '42501'; end if;
  ok := case c.status when 'DUE' then v_to in ('SUBMITTED','VOID','DENIED') when 'SUBMITTED' then v_to in ('PAID','DENIED','DUE')
                      when 'DENIED' then v_to in ('SUBMITTED') else false end;
  if not ok then raise exception 'PM_CLAIM_TRANSITION_INVALID: % → %', c.status, v_to using errcode = '22023'; end if;
  -- security review M1: money in (PAID) or written off (VOID) is a manager's or accounting's call,
  -- never the deal's salesperson; PAID names the OEM claim reference and 0 ≤ paid ≤ claimed.
  if v_to in ('PAID','VOID') then
    if not (pm.access_can_location('projects.store', 'approve', c.location_id) or pm.access_can_location('projects.financials', 'edit', c.location_id)) then
      raise exception 'PM_FORBIDDEN: marking a claim % needs Dealer store approve or Financials edit', lower(v_to) using errcode = '42501';
    end if;
    if exists (select 1 from pm.dealer_deals d where d.org_id = c.org_id and d.id = c.deal_id and d.salesperson_user_id = pm.current_user_id()) then
      raise exception 'PM_SOD_VIOLATION: the deal''s salesperson cannot mark its claim %', lower(v_to) using errcode = '42501';
    end if;
  end if;
  if v_to = 'PAID' then
    if coalesce(nullif(btrim(a ->> 'claim_ref'), ''), c.claim_ref) is null then
      raise exception 'PM_INVALID: a paid claim needs the OEM claim reference' using errcode = '22023';
    end if;
    if coalesce(pm._x_try_bigint(a ->> 'paid_cents'), c.amount_cents) not between 0 and c.amount_cents then
      raise exception 'PM_INVALID: the amount paid is between 0 and the % cents claimed', c.amount_cents using errcode = '22023';
    end if;
  end if;
  if v_to = 'DENIED' and nullif(btrim(coalesce(a ->> 'reason', '')), '') is null then raise exception 'PM_INVALID: a denial needs the OEM''s reason' using errcode = '22023'; end if;
  update pm.dlr_incentive_claims set status = v_to, updated_at = now(), updated_by = pm.current_user_id(),
         claim_ref = coalesce(nullif(btrim(a ->> 'claim_ref'), ''), claim_ref),
         submitted_at = case when v_to = 'SUBMITTED' then now() else submitted_at end,
         paid_on = case when v_to = 'PAID' then coalesce(pm._x_try_date(a ->> 'paid_on'), current_date) else paid_on end,
         paid_cents = case when v_to = 'PAID' then coalesce(pm._x_try_bigint(a ->> 'paid_cents'), amount_cents) else paid_cents end,
         denied_reason = case when v_to = 'DENIED' then btrim(a ->> 'reason') else denied_reason end,
         notes = coalesce(nullif(a ->> 'notes', ''), notes)
   where id = c.id returning * into c;
  return jsonb_build_object('claim_id', c.id, 'status', c.status);
end $$;

-- The library and the claim board: deadlines (overdue, due in 7 / 30 days), outstanding by OEM.
create or replace function pm.dlr_incentive_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean := pm._x_sees('projects.financials', 'view', p_location);
begin
  return jsonb_build_object(
    'library', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'name', i.name, 'kind', i.kind, 'brand', i.brand, 'model_pattern', i.model_pattern,
        'starts_on', i.starts_on, 'ends_on', i.ends_on, 'payee', i.payee, 'claim_deadline_days', i.claim_deadline_days, 'is_active', i.is_active,
        'bulletin_ref', i.bulletin_ref, 'new_only', i.new_only, 'pct_of_price', case when v_fin then i.pct_of_price end,
        'amount_cents', case when v_fin then i.amount_cents end) order by i.is_active desc, i.ends_on nulls last, i.code)
        from pm.dlr_incentives i where i.org_id = v_org and i.location_id = p_location), '[]'::jsonb),
    'programs', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'name', f.name, 'kind', f.kind, 'brand', f.brand, 'ends_on', f.ends_on,
        'claim_deadline_days', f.claim_deadline_days) order by f.code)
        from pm.dlr_finance_programs f where f.org_id = v_org and f.location_id = p_location and f.is_active), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'deal_id', c.deal_id, 'deal_number', d.number, 'program_code', c.program_code, 'kind', c.kind,
        'payee', c.payee, 'status', c.status, 'earned_on', c.earned_on, 'claim_by', c.claim_by, 'claim_ref', c.claim_ref, 'paid_on', c.paid_on,
        'oem', (select v.name from core.vendors v where v.id = c.oem_vendor_id), 'denied_reason', c.denied_reason,
        'due', case when c.status = 'DUE' and c.claim_by < current_date then 'OVERDUE' when c.status = 'DUE' and c.claim_by <= current_date + 7 then 'DUE_7'
                    when c.status = 'DUE' and c.claim_by <= current_date + 30 then 'DUE_30' end,
        'amount_cents', case when v_fin then c.amount_cents end, 'paid_cents', case when v_fin then c.paid_cents end)
        order by (c.status in ('DUE','SUBMITTED')) desc, c.claim_by nulls last)
        from pm.dlr_incentive_claims c join pm.dealer_deals d on d.org_id = c.org_id and d.id = c.deal_id
       where c.org_id = v_org and c.location_id = p_location and (c.status in ('DUE','SUBMITTED','DENIED') or c.updated_at > now() - interval '90 days')), '[]'::jsonb),
    'outstanding_by_oem', case when v_fin then coalesce((select jsonb_agg(jsonb_build_object('oem', coalesce(v.name, 'Unassigned'), 'claims', x.n, 'amount_cents', x.amt) order by x.amt desc)
        from (select c.oem_vendor_id, count(*) as n, sum(c.amount_cents)::bigint as amt from pm.dlr_incentive_claims c
               where c.org_id = v_org and c.location_id = p_location and c.status in ('DUE','SUBMITTED') group by 1) x
        left join core.vendors v on v.id = x.oem_vendor_id), '[]'::jsonb) end,
    'amounts_visible', v_fin);
end $$;

-- Bulletin rows → library (the PDF reading is app-side; rows arrive structured). Upsert by code.
create or replace function pm.dlr_save_incentives(p_location uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); r jsonb; n int := 0; v_kind text;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 300 then
    raise exception 'PM_INVALID: up to 300 program rows' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_kind := upper(coalesce(r ->> 'kind', 'DEALER_CASH'));
    insert into pm.dlr_incentives as i (org_id, location_id, code, name, kind, brand, oem_vendor_id, model_pattern, categories, new_only, starts_on, ends_on,
                                        amount_cents, pct_of_price, payee, claim_deadline_days, volume_target_units, bulletin_ref, notes, is_active)
    values (v_org, p_location, btrim(r ->> 'code'), btrim(r ->> 'name'), v_kind, nullif(r ->> 'brand', ''), pm.access_try_uuid(r ->> 'oem_vendor_id'),
            nullif(r ->> 'model_pattern', ''), coalesce(array(select jsonb_array_elements_text(coalesce(r -> 'categories', '[]'::jsonb))), '{}'),
            coalesce(pm._x_try_bool(r ->> 'new_only'), true), pm._x_try_date(r ->> 'starts_on'), pm._x_try_date(r ->> 'ends_on'),
            coalesce(pm._x_try_bigint(r ->> 'amount_cents'), 0), coalesce(pm._x_try_num(r ->> 'pct_of_price'), 0),
            upper(coalesce(nullif(r ->> 'payee', ''), 'DEALER')), pm._x_try_num(r ->> 'claim_deadline_days')::int, pm._x_try_num(r ->> 'volume_target_units')::int,
            nullif(r ->> 'bulletin_ref', ''), nullif(r ->> 'notes', ''), coalesce(pm._x_try_bool(r ->> 'is_active'), true))
    on conflict (org_id, location_id, code) do update set name = excluded.name, kind = excluded.kind, brand = excluded.brand, oem_vendor_id = excluded.oem_vendor_id,
      model_pattern = excluded.model_pattern, categories = excluded.categories, new_only = excluded.new_only, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      amount_cents = excluded.amount_cents, pct_of_price = excluded.pct_of_price, payee = excluded.payee, claim_deadline_days = excluded.claim_deadline_days,
      volume_target_units = excluded.volume_target_units, bulletin_ref = excluded.bulletin_ref, notes = excluded.notes, is_active = excluded.is_active, updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- ----------------------------------------------------------------------------
-- D6. DLR-24 Contracts in transit + DLR-25 deal unwind choices
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_deal_stips (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  deal_id      uuid not null,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label        text not null check (char_length(label) between 1 and 120),
  required     boolean not null default true,
  received_at  timestamptz,
  received_by  text,
  document_id  uuid,
  note         text,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, deal_id, key),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dlr_deal_funding (
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  deal_id                 uuid not null,
  location_id             uuid not null references core.locations(id),
  lender_status           text not null default 'NOT_SUBMITTED' check (lender_status in ('NOT_SUBMITTED','SUBMITTED','CONDITIONED','APPROVED','FUNDED','REJECTED')),
  submitted_at            timestamptz,
  conditions              text,
  funded_on               date,
  funded_cents            bigint check (funded_cents is null or funded_cents >= 0),
  books_receipt_ref       text,
  updated_by              text,
  updated_at              timestamptz not null default now(),
  primary key (org_id, deal_id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_set_stip(p_deal uuid, p_key text, p_received boolean, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_key text := lower(btrim(coalesce(p_key, ''))); v_label text; v_def jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  if v_key !~ '^[a-z][a-z0-9_]{1,40}$' then raise exception 'PM_INVALID: stip keys are lower-case words' using errcode = '22023'; end if;
  select x ->> 'label' into v_label from jsonb_array_elements(pm._d5_set(d.org_id, d.location_id) -> 'default_stips') x where x ->> 'key' = v_key;
  v_label := coalesce(nullif(btrim(a ->> 'label'), ''), v_label, initcap(replace(v_key, '_', ' ')));
  insert into pm.dlr_deal_stips as s (org_id, deal_id, key, label, required, received_at, received_by, document_id, note)
  values (d.org_id, d.id, v_key, left(v_label, 120), coalesce(pm._x_try_bool(a ->> 'required'), true),
          case when p_received then now() end, case when p_received then pm.current_user_id() end, pm.access_try_uuid(a ->> 'document_id'), nullif(a ->> 'note', ''))
  on conflict (org_id, deal_id, key) do update set
    received_at = case when p_received then coalesce(s.received_at, now()) else null end,
    received_by = case when p_received then coalesce(s.received_by, pm.current_user_id()) else null end,
    document_id = coalesce(excluded.document_id, s.document_id), note = coalesce(excluded.note, s.note), label = excluded.label,
    required = coalesce(pm._x_try_bool(a ->> 'required'), s.required);
  return jsonb_build_object('deal_id', d.id, 'key', v_key, 'received', p_received);
end $$;

create or replace function pm.dlr_set_lender_status(p_deal uuid, p_status text, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_to text := upper(coalesce(p_status, ''));
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  if d.finance_type not in ('RETAIL_FINANCE','LEASE') then raise exception 'PM_INVALID: deal % is not financed by a lender', d.number using errcode = '22023'; end if;
  if v_to not in ('NOT_SUBMITTED','SUBMITTED','CONDITIONED','APPROVED','FUNDED','REJECTED') then raise exception 'PM_INVALID: lender status %', v_to using errcode = '22023'; end if;
  -- security review M1: FUNDED (and moving a funded deal back) is a manager's or accounting's call,
  -- never the deal's salesperson; it names the Books receipt and 0 ≤ funded ≤ amount financed.
  if v_to = 'FUNDED' or exists (select 1 from pm.dlr_deal_funding f0 where f0.org_id = d.org_id and f0.deal_id = d.id and f0.lender_status = 'FUNDED') then
    if not (pm.access_can_location('projects.store', 'approve', d.location_id) or pm.access_can_location('projects.financials', 'edit', d.location_id)) then
      raise exception 'PM_FORBIDDEN: recording lender funding needs Dealer store approve or Financials edit' using errcode = '42501';
    end if;
    if d.salesperson_user_id is not null and d.salesperson_user_id = pm.current_user_id() then
      raise exception 'PM_SOD_VIOLATION: the deal''s salesperson cannot record its funding' using errcode = '42501';
    end if;
  end if;
  if v_to = 'FUNDED' then
    if coalesce(nullif(btrim(a ->> 'books_receipt_ref'), ''), (select f0.books_receipt_ref from pm.dlr_deal_funding f0 where f0.org_id = d.org_id and f0.deal_id = d.id)) is null then
      raise exception 'PM_INVALID: funding needs the Books receipt reference for the lender''s payment' using errcode = '22023';
    end if;
    if coalesce(pm._x_try_bigint(a ->> 'funded_cents'), d.amount_financed_cents, 0) < 0
       or (d.amount_financed_cents is not null and coalesce(pm._x_try_bigint(a ->> 'funded_cents'), d.amount_financed_cents) > d.amount_financed_cents) then
      raise exception 'PM_INVALID: the amount funded is between 0 and the amount financed' using errcode = '22023';
    end if;
  end if;
  insert into pm.dlr_deal_funding as f (org_id, deal_id, location_id, lender_status, submitted_at, conditions, funded_on, funded_cents, books_receipt_ref, updated_by)
  values (d.org_id, d.id, d.location_id, v_to, case when v_to = 'SUBMITTED' then now() end, nullif(a ->> 'conditions', ''),
          case when v_to = 'FUNDED' then coalesce(pm._x_try_date(a ->> 'funded_on'), current_date) end,
          case when v_to = 'FUNDED' then coalesce(pm._x_try_bigint(a ->> 'funded_cents'), d.amount_financed_cents) end,
          nullif(a ->> 'books_receipt_ref', ''), pm.current_user_id())
  on conflict (org_id, deal_id) do update set lender_status = excluded.lender_status,
    submitted_at = coalesce(f.submitted_at, excluded.submitted_at), conditions = coalesce(excluded.conditions, f.conditions),
    funded_on = coalesce(excluded.funded_on, f.funded_on), funded_cents = coalesce(excluded.funded_cents, f.funded_cents),
    books_receipt_ref = coalesce(excluded.books_receipt_ref, f.books_receipt_ref), updated_by = excluded.updated_by, updated_at = now();
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.lender_status', 'dealer_deals', d.id, format('%s: lender %s', d.number, lower(v_to)), '{}'::jsonb);
  return jsonb_build_object('deal_id', d.id, 'lender_status', v_to);
end $$;

-- Financed deals the lender has not funded yet: days outstanding, missing stips, stale flag.
create or replace function pm.dlr_cit_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_set jsonb; v_cv boolean := pm._x_sees('projects.contract_value', 'view', p_location);
begin
  v_set := pm._d5_set(v_org, p_location);
  return coalesce((select jsonb_agg(row order by (row ->> 'days_out')::int desc) from (
    select jsonb_build_object('deal_id', d.id, 'number', d.number, 'customer', (select c.name from core.customers c where c.id = d.customer_id),
      'stage', d.stage, 'lender', (select v.name from core.vendors v where v.id = d.finance_vendor_id), 'lender_status', coalesce(f.lender_status, 'NOT_SUBMITTED'),
      'conditions', f.conditions, 'since', coalesce(d.delivered_at, d.approved_at, d.created_at),
      'days_out', (current_date - coalesce(d.delivered_at, d.approved_at, d.created_at)::date),
      'stale', (current_date - coalesce(d.delivered_at, d.approved_at, d.created_at)::date) >= coalesce((v_set ->> 'cit_stale_days')::int, 10),
      'missing_stips', coalesce((select jsonb_agg(jsonb_build_object('key', k.key, 'label', k.label) order by k.label) from (
          select x ->> 'key' as key, x ->> 'label' as label from jsonb_array_elements(v_set -> 'default_stips') x
           where not exists (select 1 from pm.dlr_deal_stips s where s.org_id = d.org_id and s.deal_id = d.id and s.key = x ->> 'key' and (s.received_at is not null or not s.required))
          union
          select s.key, s.label from pm.dlr_deal_stips s where s.org_id = d.org_id and s.deal_id = d.id and s.required and s.received_at is null
        ) k), '[]'::jsonb),
      'amount_financed_cents', case when v_cv then d.amount_financed_cents end) as row
      from pm.dealer_deals d
      left join pm.dlr_deal_funding f on f.org_id = d.org_id and f.deal_id = d.id
     where d.org_id = v_org and d.location_id = p_location and d.finance_type in ('RETAIL_FINANCE','LEASE')
       and d.stage in ('APPROVED','FUNDED','DELIVERED') and coalesce(f.lender_status, 'NOT_SUBMITTED') <> 'FUNDED') q), '[]'::jsonb);
end $$;

create table if not exists pm.dlr_unwinds (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  deal_id          uuid not null,
  reason_code      text not null check (reason_code in ('FINANCING_DECLINED','BUYER_REMORSE','UNIT_DEFECT','PAPERWORK','OTHER')),
  reason           text not null,
  deposit_action   text not null check (deposit_action in ('REFUND','HOLD','APPLY_TO_NEW_DEAL','NONE')),
  deposit_payload  jsonb not null default '[]',
  outbox_id        uuid,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, deal_id) references pm.dealer_deals (org_id, id) deferrable initially immediate
);

-- Unwind with the deposit choice: pm.unwind_deal (1109) reverses the deal (units back to stock, trades
-- returned, DEALER_DEAL_UNWOUND with lineage); the refund / hold instruction is kept here for Books.
create or replace function pm.dlr_unwind_deal(p_deal uuid, p_reason text, p_reason_code text default 'OTHER', p_deposit_action text default 'HOLD')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; v_out uuid; v_dep jsonb; v_code text := upper(coalesce(p_reason_code, 'OTHER')); v_act text := upper(coalesce(p_deposit_action, 'HOLD'));
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: deal not found' using errcode = '42501'; end if;
  if v_code not in ('FINANCING_DECLINED','BUYER_REMORSE','UNIT_DEFECT','PAPERWORK','OTHER') then raise exception 'PM_INVALID: reason %', v_code using errcode = '22023'; end if;
  if v_act not in ('REFUND','HOLD','APPLY_TO_NEW_DEAL','NONE') then raise exception 'PM_INVALID: deposit action %', v_act using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('deposit_id', x.id, 'source_ref', x.source_ref, 'amount_cents', x.amount_cents, 'invoice_id', x.invoice_id,
                                               'action', v_act)), '[]'::jsonb)
    into v_dep from pm.dealer_deposits x where x.org_id = d.org_id and x.deal_id = d.id and x.status <> 'VOID';
  if jsonb_array_length(v_dep) > 0 and v_act = 'NONE' then raise exception 'PM_INVALID: this deal holds deposits; refund, hold or apply them' using errcode = '22023'; end if;
  v_out := pm.unwind_deal(d.id, p_reason);
  insert into pm.dlr_unwinds (org_id, location_id, deal_id, reason_code, reason, deposit_action, deposit_payload, outbox_id)
  values (d.org_id, d.location_id, d.id, v_code, btrim(p_reason), v_act, v_dep, v_out);
  return jsonb_build_object('deal_id', d.id, 'outbox_id', v_out, 'deposit_action', v_act, 'deposits', jsonb_array_length(v_dep));
end $$;

-- ----------------------------------------------------------------------------
-- D7. Parts: special-order auto-text (DLR-32), stock suggestions (DLR-33), electronic ordering
--     records (DLR-34), inter-store transfer + locator (DLR-39)
-- ----------------------------------------------------------------------------

-- DLR-32: when a customer's special order is received, text the customer and mark it notified.
create or replace function pm.tg_d5_special_order_text() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.parts%rowtype; v_set jsonb; v_r jsonb;
begin
  if new.status = 'RECEIVED' and old.status is distinct from 'RECEIVED' and new.customer_id is not null then
    v_set := pm._d5_set(new.org_id, new.location_id);
    if coalesce((v_set ->> 'special_order_text')::boolean, true) then
      select * into p from pm.parts x where x.org_id = new.org_id and x.id = new.part_id;
      v_r := pm._d5_text(new.org_id, new.location_id, new.job_id, new.customer_id, 'SPECIAL_ORDER', 'parts_special_orders', new.id,
        format('%s: your special-order part is in (%s %s, order %s). Pick it up at the parts counter.', pm._d5_company_name(new.location_id),
               p.part_number, left(p.description, 60), new.number),
        'so:' || new.id::text || ':received', new.work_order_id);
      if v_r ->> 'status' in ('queued','held') then
        update pm.parts_special_orders set status = 'NOTIFIED', notified_at = now() where id = new.id and status = 'RECEIVED';
      end if;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_d5_special_order_text on pm.parts_special_orders;
create trigger trg_d5_special_order_text after update of status on pm.parts_special_orders for each row execute function pm.tg_d5_special_order_text();

-- Re-text by hand (no mobile number on file the first time, or the customer asked again).
create or replace function pm.dlr_text_special_order(p_so uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts_special_orders%rowtype; p pm.parts%rowtype; v_r jsonb;
begin
  select * into o from pm.parts_special_orders x where x.id = p_so;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: special order not found' using errcode = '42501'; end if;
  if o.status not in ('RECEIVED','NOTIFIED') then raise exception 'PM_INVALID: special order % is % (text when it is in)', o.number, o.status using errcode = '22023'; end if;
  select * into p from pm.parts x where x.org_id = o.org_id and x.id = o.part_id;
  v_r := pm._d5_text(o.org_id, o.location_id, o.job_id, o.customer_id, 'SPECIAL_ORDER', 'parts_special_orders', o.id,
    format('%s: reminder, your part %s (order %s) is ready at the parts counter.', pm._d5_company_name(o.location_id), p.part_number, o.number),
    'so:' || o.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), o.work_order_id);
  if v_r ->> 'status' in ('queued','held') and o.status = 'RECEIVED' then
    perform pm.advance_special_order(o.id, 'NOTIFIED', '{}'::jsonb);
  end if;
  return v_r;
end $$;

-- Open special orders with age; received but not picked up past the store's stale days are flagged.
create or replace function pm.dlr_special_order_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_stale int;
begin
  v_stale := coalesce((pm._d5_set(v_org, p_location) ->> 'special_order_stale_days')::int, 14);
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'qty', o.qty, 'part_number', p.part_number,
      'description', p.description, 'customer', (select c.name from core.customers c where c.id = o.customer_id), 'customer_id', o.customer_id,
      'work_order_id', o.work_order_id, 'needed_by', o.needed_by, 'ordered_at', o.ordered_at, 'received_at', o.received_at, 'notified_at', o.notified_at,
      'age_days', current_date - o.created_at::date,
      'waiting_days', case when o.received_at is not null then current_date - o.received_at::date end,
      'stale', o.status in ('RECEIVED','NOTIFIED') and o.received_at < now() - make_interval(days => v_stale),
      'last_text', (select jsonb_build_object('status', t.status, 'at', t.created_at, 'reason', t.reason) from pm.dlr_customer_texts t
                     where t.org_id = o.org_id and t.subject_table = 'parts_special_orders' and t.subject_id = o.id order by t.created_at desc limit 1))
      order by (o.status in ('RECEIVED','NOTIFIED')) desc, o.created_at)
    from pm.parts_special_orders o join pm.parts p on p.org_id = o.org_id and p.id = o.part_id
   where o.org_id = v_org and o.location_id = p_location and o.status in ('REQUESTED','ORDERED','RECEIVED','NOTIFIED')), '[]'::jsonb);
end $$;

-- DLR-33: suggested stock levels and order quantities per part at one stock location, from 12 months of
-- counter / RO demand (ISSUE moves) plus lost sales, a seasonal index for the coverage window, lead time
-- and a review period. Mirrored by lib/dealer/stocking.ts (parity test).
--   avg  = demand(12 mo) / 12;  season = demand in the same coverage months last year / (avg × months), 0.25–4 (1 when no history)
--   rate = avg × season / 30 per day;  safety = z × σ(monthly) × √(coverage / 30)
--   min  = ceil(rate × lead + safety);  max = ceil(rate × (lead + review) + safety);  order = max − on hand − on order (≥ 0)
create or replace function pm._d5_stocking(p_avg numeric, p_sd numeric, p_season numeric, p_lead int, p_review int, p_z numeric,
                                            p_on_hand numeric, p_on_order numeric, out min_qty numeric, out max_qty numeric, out order_qty numeric)
language plpgsql immutable
as $$
declare v_rate numeric; v_safety numeric; v_s numeric := least(greatest(coalesce(p_season, 1), 0.25), 4);
begin
  v_rate := coalesce(p_avg, 0) * v_s / 30.0;
  v_safety := coalesce(p_z, 0) * coalesce(p_sd, 0) * sqrt(greatest(coalesce(p_lead, 0) + coalesce(p_review, 0), 0) / 30.0);
  min_qty := ceil(round(v_rate * coalesce(p_lead, 0) + v_safety, 6));
  max_qty := greatest(ceil(round(v_rate * (coalesce(p_lead, 0) + coalesce(p_review, 0)) + v_safety, 6)), min_qty);
  order_qty := greatest(max_qty - coalesce(p_on_hand, 0) - coalesce(p_on_order, 0), 0);
end $$;

create or replace function pm.dlr_stock_suggestions(p_stock_location uuid, p_opts jsonb default '{}')
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; o jsonb := coalesce(p_opts, '{}'); v_lead int; v_review int; v_z numeric; v_vendor uuid; v_months int; v_start date; v_out jsonb;
begin
  select s.org_id, s.location_id into v_org, v_loc from pm.stock_locations s where s.id = p_stock_location;
  if v_org is null or v_org is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: stock location not found' using errcode = '42501'; end if;
  v_lead := least(greatest(coalesce(pm._x_try_num(o ->> 'lead_days')::int, 7), 0), 180);
  v_review := least(greatest(coalesce(pm._x_try_num(o ->> 'review_days')::int, 14), 1), 180);
  v_z := least(greatest(coalesce(pm._x_try_num(o ->> 'service_z'), 1.28), 0), 3.5);
  v_vendor := pm.access_try_uuid(o ->> 'vendor_id');
  v_months := greatest(1, ceil((v_lead + v_review) / 30.0)::int);
  v_start := (date_trunc('month', current_date) - interval '12 months')::date;
  with parts as (
    select p.* from pm.parts p
     where p.org_id = v_org and p.location_id = v_loc and p.status = 'ACTIVE' and p.is_active
       and (v_vendor is null or p.mfr_vendor_id = v_vendor)
  ), months as (select generate_series(0, 11) as k),
  dem as (
    select p.id as part_id, mo.k,
           coalesce((select sum(m.qty) from pm.material_moves m
                      where m.org_id = v_org and m.item_id = p.item_id and m.kind = 'ISSUE' and m.from_stock_location_id = p_stock_location
                        and m.moved_at >= (v_start + make_interval(months => mo.k)) and m.moved_at < (v_start + make_interval(months => mo.k + 1))), 0)
         + coalesce((select sum(ls.qty) from pm.dlr_lost_sales ls
                      where ls.org_id = v_org and ls.location_id = v_loc and (ls.part_id = p.id or upper(ls.part_number) = upper(p.part_number))
                        and ls.created_at >= (v_start + make_interval(months => mo.k)) and ls.created_at < (v_start + make_interval(months => mo.k + 1))), 0) as qty
      from parts p cross join months mo
  ), stats as (
    select d.part_id, sum(d.qty) as total, avg(d.qty) as avg_m, coalesce(stddev_pop(d.qty), 0) as sd_m,
           -- the coverage months starting next month, one year back (k = 12 − 11 … = months 1..v_months of last year relative to now)
           sum(d.qty) filter (where d.k between 1 and v_months) as season_qty
      from dem d group by 1
  ), lost as (
    select p.id as part_id, coalesce(sum(ls.qty), 0) as lost_qty from parts p
      left join pm.dlr_lost_sales ls on ls.org_id = v_org and ls.location_id = v_loc and (ls.part_id = p.id or upper(ls.part_number) = upper(p.part_number))
                                     and ls.created_at >= now() - interval '12 months'
     group by 1
  ), cur as (
    select p.id as part_id, p.part_number, p.description, p.mfr_vendor_id, t.min_qty as cur_min, t.max_qty as cur_max, t.bin,
           pm.part_on_hand(v_org, p_stock_location, p.item_id) as oh,
           coalesce((select sum(l.qty_ordered - l.qty_received) from pm.parts_order_lines l join pm.parts_orders po on po.org_id = l.org_id and po.id = l.order_id
                      where l.org_id = v_org and l.part_id = p.id and po.stock_location_id = p_stock_location and po.status in ('DRAFT','SUBMITTED','PARTIAL')), 0) as oo
      from parts p left join pm.stock_targets t on t.org_id = v_org and t.stock_location_id = p_stock_location and t.item_id = p.item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('part_id', c.part_id, 'part_number', c.part_number, 'description', c.description, 'vendor_id', c.mfr_vendor_id,
           'bin', c.bin, 'on_hand', c.oh, 'on_order', c.oo, 'demand_12m', s.total, 'avg_monthly', round(s.avg_m, 3), 'sd_monthly', round(s.sd_m, 3),
           'season_index', round(x.season, 3), 'lost_12m', l.lost_qty, 'current_min', c.cur_min, 'current_max', c.cur_max,
           'min_qty', k.min_qty, 'max_qty', k.max_qty, 'order_qty', k.order_qty) order by k.order_qty desc, c.part_number), '[]'::jsonb)
    into v_out
    from cur c join stats s on s.part_id = c.part_id join lost l on l.part_id = c.part_id
    cross join lateral (select case when coalesce(s.avg_m, 0) = 0 then 1 else coalesce(s.season_qty, 0) / (s.avg_m * v_months) end as season) x
    cross join lateral pm._d5_stocking(s.avg_m, s.sd_m, x.season, v_lead, v_review, v_z, c.oh, c.oo) k
   where s.total > 0 or c.cur_min is not null;
  return jsonb_build_object('stock_location_id', p_stock_location, 'lead_days', v_lead, 'review_days', v_review, 'service_z', v_z, 'coverage_months', v_months,
                            'rows', v_out);
end $$;

-- Save edited min / max back to the stocking table.
create or replace function pm.dlr_apply_stocking(p_stock_location uuid, p_rows jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; r jsonb; n int := 0; v_bin text;
begin
  select s.org_id into v_org from pm.stock_locations s where s.id = p_stock_location;
  if v_org is null or v_org is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: stock location not found' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'PM_INVALID: up to 2,000 rows' using errcode = '22023'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    select t.bin into v_bin from pm.stock_targets t join pm.parts p on p.org_id = t.org_id and p.item_id = t.item_id
     where t.org_id = v_org and t.stock_location_id = p_stock_location and p.id = (r ->> 'part_id')::uuid;
    perform pm.set_part_stocking((r ->> 'part_id')::uuid, p_stock_location, coalesce(nullif(r ->> 'bin', ''), v_bin),
                                 greatest(coalesce(pm._x_try_num(r ->> 'min_qty'), 0), 0), pm._x_try_num(r ->> 'max_qty'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Turn suggestion rows into a draft parts order (lines added at the part's cost).
create or replace function pm.dlr_create_stock_order(p_stock_location uuid, p_vendor uuid, p_lines jsonb, p_kind text default 'STOCK')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_order uuid; r jsonb; n int := 0; p pm.parts%rowtype;
begin
  select s.org_id, s.location_id into v_org, v_loc from pm.stock_locations s where s.id = p_stock_location;
  if v_org is null or v_org is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: stock location not found' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: pick at least one part to order' using errcode = '22023';
  end if;
  v_order := pm.create_parts_order(v_loc, p_vendor, p_stock_location, coalesce(p_kind, 'STOCK'), null);
  for r in select value from jsonb_array_elements(p_lines) loop
    continue when coalesce(pm._x_try_num(r ->> 'qty'), 0) <= 0;
    select * into p from pm.parts x where x.org_id = v_org and x.id = pm.access_try_uuid(r ->> 'part_id') and x.location_id = v_loc;
    if p.id is null then raise exception 'PM_INVALID: part % is not on this company', r ->> 'part_id' using errcode = '22023'; end if;
    n := n + 1;
    insert into pm.parts_order_lines (org_id, order_id, line_no, part_id, qty_ordered, unit_cost_cents)
    values (v_org, v_order, n, p.id, (r ->> 'qty')::numeric, p.cost_cents);
  end loop;
  if n = 0 then raise exception 'PM_INVALID: every quantity was zero' using errcode = '22023'; end if;
  return jsonb_build_object('order_id', v_order, 'lines', n);
end $$;

-- DLR-34: what was sent to an OEM / distributor and what came back (the adapters build the file / call).
create table if not exists pm.dlr_order_transmissions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  order_id     uuid not null,
  provider     text not null check (provider ~ '^[A-Z0-9_]{2,30}$'),
  channel      text not null check (channel in ('EDI_FILE','API','PORTAL','EMAIL')),
  format       text not null check (format in ('X12_850','CSV','JSON','PDF')),
  file_name    text,
  payload      text check (payload is null or length(payload) <= 500000),
  status       text not null default 'PREPARED' check (status in ('PREPARED','SENT','ACKNOWLEDGED','PARTIAL','REJECTED','FAILED')),
  ack          jsonb not null default '{}' check (jsonb_typeof(ack) = 'object'),
  error        text,
  sent_at      timestamptz,
  ack_at       timestamptz,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, order_id) references pm.parts_orders (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_order_tx_order_idx on pm.dlr_order_transmissions (org_id, order_id, created_at desc);

create table if not exists pm.dlr_backorders (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  order_id       uuid not null,
  order_line_id  uuid not null,
  part_id        uuid not null,
  qty            numeric(12,4) not null check (qty > 0),
  eta            date,
  vendor_ref     text,
  status         text not null default 'OPEN' check (status in ('OPEN','CLOSED','CANCELLED')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, order_line_id),
  foreign key (org_id, order_id) references pm.parts_orders (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, order_line_id) references pm.parts_order_lines (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_record_order_transmission(p_order uuid, p_provider text, p_channel text, p_format text, p_file_name text,
                                                              p_payload text, p_sent boolean default true, p_error text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.parts_orders%rowtype; v_id uuid; v_status text;
begin
  select * into o from pm.parts_orders x where x.id = p_order;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: parts order not found' using errcode = '42501'; end if;
  if o.status in ('RECEIVED','CANCELLED') then raise exception 'PM_INVALID: order % is %', o.number, o.status using errcode = '22023'; end if;
  v_status := case when p_error is not null then 'FAILED' when p_sent then 'SENT' else 'PREPARED' end;
  insert into pm.dlr_order_transmissions (org_id, location_id, order_id, provider, channel, format, file_name, payload, status, error, sent_at)
  values (o.org_id, o.location_id, o.id, upper(btrim(p_provider)), upper(p_channel), upper(p_format), left(p_file_name, 200), p_payload, v_status, left(p_error, 500),
          case when v_status = 'SENT' then now() end)
  returning id into v_id;
  if v_status = 'SENT' and o.status = 'DRAFT' then perform pm.submit_parts_order(o.id); end if;
  return jsonb_build_object('transmission_id', v_id, 'status', v_status, 'order_status', (select status from pm.parts_orders where id = o.id));
end $$;

-- An acknowledgment (855 / portal / email): per line acknowledged vs backordered qty + ETA.
-- p_ack: {status?, vendor_ref?, lines: [{line_no | part_number, qty_ack, qty_backorder, eta}]}
create or replace function pm.dlr_record_order_ack(p_transmission uuid, p_ack jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.dlr_order_transmissions%rowtype; a jsonb := coalesce(p_ack, '{}'); r jsonb; l pm.parts_order_lines%rowtype; n_bo int := 0; v_status text;
begin
  select * into t from pm.dlr_order_transmissions x where x.id = p_transmission for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: transmission not found' using errcode = '42501'; end if;
  for r in select value from jsonb_array_elements(coalesce(a -> 'lines', '[]'::jsonb)) loop
    select ol.* into l from pm.parts_order_lines ol join pm.parts p on p.org_id = ol.org_id and p.id = ol.part_id
     where ol.org_id = t.org_id and ol.order_id = t.order_id
       and (ol.line_no = pm._x_try_num(r ->> 'line_no')::int or (r ->> 'line_no' is null and upper(p.part_number) = upper(r ->> 'part_number')))
     limit 1;
    continue when l.id is null;
    if coalesce(pm._x_try_num(r ->> 'qty_backorder'), 0) > 0 then
      insert into pm.dlr_backorders as b (org_id, location_id, order_id, order_line_id, part_id, qty, eta, vendor_ref)
      values (t.org_id, t.location_id, t.order_id, l.id, l.part_id, (r ->> 'qty_backorder')::numeric, pm._x_try_date(r ->> 'eta'), nullif(a ->> 'vendor_ref', ''))
      on conflict (org_id, order_line_id) do update set qty = excluded.qty, eta = excluded.eta, status = 'OPEN', updated_at = now();
      n_bo := n_bo + 1;
    else
      update pm.dlr_backorders set status = 'CLOSED', updated_at = now() where org_id = t.org_id and order_line_id = l.id and status = 'OPEN';
    end if;
  end loop;
  v_status := coalesce(upper(nullif(a ->> 'status', '')), case when n_bo > 0 then 'PARTIAL' else 'ACKNOWLEDGED' end);
  if v_status not in ('ACKNOWLEDGED','PARTIAL','REJECTED') then v_status := 'ACKNOWLEDGED'; end if;
  update pm.dlr_order_transmissions set status = v_status, ack = a, ack_at = now() where id = t.id;
  if nullif(a ->> 'vendor_ref', '') is not null then
    update pm.parts_orders set vendor_ref = coalesce(vendor_ref, a ->> 'vendor_ref') where org_id = t.org_id and id = t.order_id;
  end if;
  return jsonb_build_object('transmission_id', t.id, 'status', v_status, 'backorders', n_bo);
end $$;

create or replace function pm.dlr_backorder_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return jsonb_build_object(
    'backorders', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'order_id', b.order_id, 'order_number', o.number, 'vendor', v.name, 'part_number', p.part_number,
        'description', p.description, 'qty', b.qty, 'eta', b.eta, 'late', b.eta < current_date, 'vendor_ref', b.vendor_ref,
        'special_orders', (select count(*) from pm.parts_special_orders so where so.org_id = b.org_id and so.part_id = b.part_id and so.status in ('REQUESTED','ORDERED')))
        order by b.eta nulls last)
      from pm.dlr_backorders b join pm.parts_orders o on o.org_id = b.org_id and o.id = b.order_id join pm.parts p on p.org_id = b.org_id and p.id = b.part_id
      left join core.vendors v on v.id = o.vendor_id
     where b.org_id = v_org and b.location_id = p_location and b.status = 'OPEN'), '[]'::jsonb),
    'transmissions', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'order_id', t.order_id, 'order_number', o.number, 'provider', t.provider, 'channel', t.channel,
        'format', t.format, 'status', t.status, 'sent_at', t.sent_at, 'ack_at', t.ack_at, 'error', t.error, 'file_name', t.file_name) order by t.created_at desc)
      from pm.dlr_order_transmissions t join pm.parts_orders o on o.org_id = t.org_id and o.id = t.order_id
     where t.org_id = v_org and t.location_id = p_location and t.created_at > now() - interval '60 days'), '[]'::jsonb));
end $$;

-- DLR-39: on hand for one part number across every store in the group the caller can see.
create or replace function pm.dlr_part_locator(p_part_number text, p_manufacturer text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_pn text := upper(btrim(coalesce(p_part_number, '')));
begin
  if v_org is null then raise exception 'PM_FORBIDDEN: no organization' using errcode = '42501'; end if;
  if v_pn = '' then raise exception 'PM_INVALID: enter a part number' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('location_id', p.location_id, 'store', l.name, 'part_id', p.id, 'part_number', p.part_number,
      'manufacturer', p.manufacturer, 'description', p.description, 'stock_location_id', s.id, 'stock_location', s.name, 'bin', t.bin,
      'on_hand', pm.part_on_hand(v_org, s.id, p.item_id)) order by l.name, s.name)
    from pm.parts p join core.locations l on l.id = p.location_id
    join pm.stock_locations s on s.org_id = p.org_id and s.location_id = p.location_id and s.is_active and s.kind in ('WAREHOUSE','SHOP','TRUCK','STAGING')
    left join pm.stock_targets t on t.org_id = p.org_id and t.stock_location_id = s.id and t.item_id = p.item_id
   where p.org_id = v_org and upper(p.part_number) = v_pn and (p_manufacturer is null or upper(p.manufacturer) = upper(p_manufacturer))
     and p.location_id in (select pm.my_location_ids('projects.store', 'view'))
     and pm.part_on_hand(v_org, s.id, p.item_id) > 0), '[]'::jsonb);
end $$;

create table if not exists pm.dlr_part_transfers (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  number                  text not null,
  location_id             uuid not null references core.locations(id),   -- the requesting (receiving) store
  from_location_id        uuid not null references core.locations(id),
  from_stock_location_id  uuid not null,
  from_part_id            uuid not null,
  to_location_id          uuid not null references core.locations(id),
  to_stock_location_id    uuid not null,
  to_part_id              uuid,
  qty                     numeric(12,4) not null check (qty > 0),
  status                  text not null default 'REQUESTED' check (status in ('REQUESTED','SHIPPED','RECEIVED','CANCELLED')),
  special_order_id        uuid,
  note                    text,
  requested_by            text default pm.current_user_id(),
  requested_at            timestamptz not null default now(),
  shipped_by              text,
  shipped_at              timestamptz,
  received_by             text,
  received_at             timestamptz,
  out_move_id             uuid,
  in_move_id              uuid,
  unique (org_id, id),
  unique (org_id, number),
  foreign key (org_id, from_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, to_stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, from_part_id) references pm.parts (org_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_part_transfers_to_idx on pm.dlr_part_transfers (org_id, to_location_id, status);
create index if not exists pm_dlr_part_transfers_from_idx on pm.dlr_part_transfers (org_id, from_location_id, status);

create or replace function pm.dlr_request_transfer(p_from_part uuid, p_from_stock_location uuid, p_to_stock_location uuid, p_qty numeric, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.parts%rowtype; v_from_loc uuid; v_to_loc uuid; v_id uuid; v_org uuid := public.get_org_id();
begin
  select * into p from pm.parts x where x.id = p_from_part and x.org_id = v_org;
  if p.id is null then raise exception 'PM_FORBIDDEN: part not found' using errcode = '42501'; end if;
  select s.location_id into v_from_loc from pm.stock_locations s where s.id = p_from_stock_location and s.org_id = v_org;
  select s.location_id into v_to_loc from pm.stock_locations s where s.id = p_to_stock_location and s.org_id = v_org;
  if v_from_loc is null or v_to_loc is null then raise exception 'PM_FORBIDDEN: stock location not found' using errcode = '42501'; end if;
  if v_from_loc <> p.location_id then raise exception 'PM_INVALID: the part is not stocked at the sending store' using errcode = '22023'; end if;
  if p_from_stock_location = p_to_stock_location then raise exception 'PM_INVALID: pick a different receiving location' using errcode = '22023'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;
  if not pm._x_sees('projects.store', 'edit', v_to_loc) then raise exception 'PM_FORBIDDEN: you cannot request stock for that store' using errcode = '42501'; end if;
  -- security review L7: you ask for stock you can see (the locator is limited to stores you view).
  if not pm._x_sees('projects.store', 'view', v_from_loc) then raise exception 'PM_FORBIDDEN: you cannot see stock at the sending store' using errcode = '42501'; end if;
  insert into pm.dlr_part_transfers (org_id, number, location_id, from_location_id, from_stock_location_id, from_part_id, to_location_id, to_stock_location_id, qty, note)
  values (v_org, pm._d5_number(v_org, v_to_loc, 'XFR'), v_to_loc, v_from_loc, p_from_stock_location, p.id, v_to_loc, p_to_stock_location, p_qty, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  perform pm._d5_notify(v_org, v_from_loc, null, 'portal.activity', 'dlr_part_transfers', v_id,
    core.notify_members_with(v_org, v_from_loc, 'projects.store', 'edit'), format('Parts transfer requested: %s × %s', p_qty, p.part_number),
    format('From %s to %s', pm._d5_company_name(v_from_loc), pm._d5_company_name(v_to_loc)), '/parts/transfers', 'xfer:' || v_id);
  return v_id;
end $$;

-- Ship (sending store) / receive (receiving store) / cancel. Same company: one TRANSFER move on ship.
-- Two companies: an ADJUST out at the sender on ship and an ADJUST in at the receiver on receipt, both keyed
-- pm:xfer:<id> so Books can treat them as a transfer at cost (inter-company moves are Books').
create or replace function pm.dlr_advance_transfer(p_transfer uuid, p_to text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.dlr_part_transfers%rowtype; v_to text := upper(coalesce(p_to, '')); p pm.parts%rowtype; v_dest uuid; v_oh numeric; v_move uuid;
begin
  select * into t from pm.dlr_part_transfers x where x.id = p_transfer for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: transfer not found' using errcode = '42501'; end if;
  select * into p from pm.parts x where x.org_id = t.org_id and x.id = t.from_part_id;
  if v_to = 'SHIPPED' then
    if t.status <> 'REQUESTED' then raise exception 'PM_INVALID: transfer % is %', t.number, t.status using errcode = '22023'; end if;
    if not pm._x_sees('projects.store', 'edit', t.from_location_id) then raise exception 'PM_FORBIDDEN: only the sending store ships' using errcode = '42501'; end if;
    v_oh := pm.part_on_hand(t.org_id, t.from_stock_location_id, p.item_id);
    if v_oh < t.qty then raise exception 'PM_INVALID: only % on hand at the sending location', v_oh using errcode = '22023'; end if;
    if t.from_location_id = t.to_location_id then
      v_move := pm.record_material_move('TRANSFER', p.item_id, t.qty, t.from_stock_location_id, t.to_stock_location_id, null, null, p.uom, null,
                                        'pm:xfer:' || t.id::text, null, 'Transfer ' || t.number);
      update pm.dlr_part_transfers set status = 'SHIPPED', shipped_at = now(), shipped_by = pm.current_user_id(), out_move_id = v_move, to_part_id = p.id where id = t.id;
    else
      v_move := pm.record_material_move('ADJUST', p.item_id, t.qty, t.from_stock_location_id, null, null, null, p.uom, null,
                                        'pm:xfer:' || t.id::text || ':out', null, 'Inter-store transfer out ' || t.number);
      update pm.dlr_part_transfers set status = 'SHIPPED', shipped_at = now(), shipped_by = pm.current_user_id(), out_move_id = v_move where id = t.id;
    end if;
  elsif v_to = 'RECEIVED' then
    if t.status <> 'SHIPPED' then raise exception 'PM_INVALID: transfer % is %', t.number, t.status using errcode = '22023'; end if;
    if not pm._x_sees('projects.store', 'edit', t.to_location_id) then raise exception 'PM_FORBIDDEN: only the receiving store receives' using errcode = '42501'; end if;
    if t.from_location_id <> t.to_location_id then
      select x.id into v_dest from pm.parts x where x.org_id = t.org_id and x.location_id = t.to_location_id and upper(x.part_number) = upper(p.part_number)
         and coalesce(upper(x.manufacturer), '') = coalesce(upper(p.manufacturer), '') limit 1;
      if v_dest is null then
        v_dest := pm.upsert_part(t.to_location_id, p.part_number, p.description,
          jsonb_strip_nulls(jsonb_build_object('manufacturer', p.manufacturer, 'list_price_cents', p.list_price_cents, 'cost_cents', p.cost_cents, 'uom', p.uom, 'category', p.category)));
      end if;
      v_move := pm.record_material_move('ADJUST', (select item_id from pm.parts where id = v_dest), t.qty, null, t.to_stock_location_id, null, null, p.uom, null,
                                        'pm:xfer:' || t.id::text || ':in', null, 'Inter-store transfer in ' || t.number);
      update pm.dlr_part_transfers set status = 'RECEIVED', received_at = now(), received_by = pm.current_user_id(), in_move_id = v_move, to_part_id = v_dest where id = t.id;
    else
      update pm.dlr_part_transfers set status = 'RECEIVED', received_at = now(), received_by = pm.current_user_id() where id = t.id;
    end if;
  elsif v_to = 'CANCELLED' then
    if t.status <> 'REQUESTED' then raise exception 'PM_INVALID: only a requested transfer can be cancelled' using errcode = '22023'; end if;
    update pm.dlr_part_transfers set status = 'CANCELLED' where id = t.id;
  else
    raise exception 'PM_INVALID: ship, receive or cancel' using errcode = '22023';
  end if;
  return jsonb_build_object('transfer_id', t.id, 'status', (select status from pm.dlr_part_transfers where id = t.id));
end $$;

create or replace function pm.dlr_transfer_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'status', t.status, 'qty', t.qty, 'part_number', p.part_number,
      'description', p.description, 'from_store', lf.name, 'to_store', lt.name, 'from_location_id', t.from_location_id, 'to_location_id', t.to_location_id,
      'direction', case when t.to_location_id = p_location and t.from_location_id = p_location then 'INTERNAL' when t.to_location_id = p_location then 'INBOUND' else 'OUTBOUND' end,
      'requested_at', t.requested_at, 'shipped_at', t.shipped_at, 'received_at', t.received_at, 'note', t.note) order by t.requested_at desc)
    from pm.dlr_part_transfers t join pm.parts p on p.org_id = t.org_id and p.id = t.from_part_id
    join core.locations lf on lf.id = t.from_location_id join core.locations lt on lt.id = t.to_location_id
   where t.org_id = v_org and (t.from_location_id = p_location or t.to_location_id = p_location)
     and (t.status in ('REQUESTED','SHIPPED') or t.requested_at > now() - interval '30 days')), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- D8. Service: capacity + appointments + pickup / delivery (DLR-41), check-in (DLR-42), findings +
--     text approval (DLR-45), sublets + shop fees (DLR-50), RO stage + status texts (DLR-51), close /
--     QC / pay link / pickup / storage (DLR-52), internal routing (DLR-53), WIP + cutoff (DLR-57)
-- ----------------------------------------------------------------------------

-- DLR-53: internal lines carry where their cost goes (PDI → new unit, RECON → used unit, RENTAL → rental
-- department, SHOP → overhead, POLICY → goodwill). Additive on 1104's table; set through the RPC below
-- or inferred on insert from the RO (PDI kind, a recon RO, a rental unit).
alter table pm.work_order_lines add column if not exists internal_route text;
alter table pm.work_order_lines add column if not exists internal_asset_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wo_lines_internal_route_check' and conrelid = 'pm.work_order_lines'::regclass) then
    alter table pm.work_order_lines add constraint wo_lines_internal_route_check
      check (internal_route is null or internal_route in ('PDI','RECON','RENTAL','SHOP','POLICY'));
  end if;
end $$;

create or replace function pm.tg_d5_wo_line_route() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; a pm.assets%rowtype;
begin
  if new.pay_type in ('INTERNAL','POLICY') and new.internal_route is null then
    select * into w from pm.work_orders x where x.org_id = new.org_id and x.id = new.work_order_id;
    if w.asset_id is not null then select * into a from pm.assets x where x.org_id = w.org_id and x.id = w.asset_id; end if;
    new.internal_route := case
      when new.pay_type = 'POLICY' then 'POLICY'
      when w.kind = 'PDI' then 'PDI'
      when exists (select 1 from pm.dlr_recons r where r.org_id = new.org_id and r.work_order_id = new.work_order_id) then 'RECON'
      when a.kind = 'RENTAL_UNIT' or a.unit_status = 'RENTAL' then 'RENTAL'
      else null end;
    if new.internal_route in ('PDI','RECON','RENTAL') then new.internal_asset_id := coalesce(new.internal_asset_id, w.asset_id); end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_wo_line_route on pm.work_order_lines;
create trigger trg_d5_wo_line_route before insert on pm.work_order_lines for each row execute function pm.tg_d5_wo_line_route();

create or replace function pm.dlr_set_internal_route(p_line uuid, p_route text, p_asset uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype; v_route text := upper(coalesce(p_route, ''));
begin
  select * into l from pm.work_order_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO line not found' using errcode = '42501'; end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if l.pay_type not in ('INTERNAL','POLICY') then raise exception 'PM_INVALID: only internal and policy lines are routed' using errcode = '22023'; end if;
  if v_route not in ('PDI','RECON','RENTAL','SHOP','POLICY') then raise exception 'PM_INVALID: route is PDI, RECON, RENTAL, SHOP or POLICY' using errcode = '22023'; end if;
  if v_route in ('PDI','RECON','RENTAL') and coalesce(p_asset, w.asset_id) is null then
    raise exception 'PM_INVALID: a % line needs the unit it belongs to', v_route using errcode = '22023';
  end if;
  if p_asset is not null and not exists (select 1 from pm.assets a where a.org_id = l.org_id and a.id = p_asset) then
    raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501';
  end if;
  update pm.work_order_lines set internal_route = v_route,
         internal_asset_id = case when v_route in ('PDI','RECON','RENTAL') then coalesce(p_asset, w.asset_id) end, updated_at = now()
   where id = l.id;
  return jsonb_build_object('line_id', l.id, 'internal_route', v_route);
end $$;

-- DLR-41: daily tech-hour capacity (weekday pattern + day overrides) and the appointment book.
create table if not exists pm.dlr_service_capacity (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  weekday      int not null check (weekday between 0 and 6),
  tech_hours   numeric(7,2) not null check (tech_hours >= 0 and tech_hours <= 2000),
  primary key (org_id, location_id, weekday)
);
create table if not exists pm.dlr_capacity_overrides (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  day          date not null,
  tech_hours   numeric(7,2) not null check (tech_hours >= 0 and tech_hours <= 2000),
  note         text,
  primary key (org_id, location_id, day)
);

create table if not exists pm.dlr_service_appointments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  number           text not null,
  customer_id      uuid references core.customers(id),
  asset_id         uuid,
  contact_id       uuid,
  appt_on          date not null,
  window_start     time,
  window_end       time,
  est_hours        numeric(6,2) not null default 1 check (est_hours > 0 and est_hours <= 200),
  complaint        text,
  pickup           boolean not null default false,
  delivery         boolean not null default false,
  address_line1    text,
  city             text,
  state            text,
  zip              text,
  lat              numeric(9,6),
  lng              numeric(9,6),
  status           text not null default 'BOOKED' check (status in ('BOOKED','CONFIRMED','ARRIVED','CHECKED_IN','NO_SHOW','CANCELLED')),
  quoted_ready_on  date,
  work_order_id    uuid,
  job_id           uuid,
  notes            text,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number),
  check (window_end is null or window_start is null or window_end > window_start),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_appts_day_idx on pm.dlr_service_appointments (org_id, location_id, appt_on, status);

-- Pickup / delivery stops for the store's truck (service pickups, finished-unit deliveries, rental drops).
create table if not exists pm.dlr_stops (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  kind                text not null check (kind in ('PICKUP','DELIVERY')),
  purpose             text not null default 'SERVICE' check (purpose in ('SERVICE','RENTAL','SALE')),
  stop_on             date not null,
  window_start        time,
  window_end          time,
  appointment_id      uuid,
  work_order_id       uuid,
  rental_contract_id  uuid,
  deal_id             uuid,
  customer_id         uuid references core.customers(id),
  asset_id            uuid,
  address_line1       text,
  city                text,
  state               text,
  zip                 text,
  lat                 numeric(9,6),
  lng                 numeric(9,6),
  seq                 int,
  driver_employee_id  uuid references core.employees(id),
  status              text not null default 'PLANNED' check (status in ('PLANNED','DONE','CANCELLED')),
  done_at             timestamptz,
  notes               text,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, appointment_id) references pm.dlr_service_appointments (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_stops_day_idx on pm.dlr_stops (org_id, location_id, stop_on, status);

create or replace function pm.dlr_set_service_capacity(p_location uuid, p_weekdays jsonb default null, p_overrides jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); k text; r jsonb;
begin
  if p_weekdays is not null then
    if jsonb_typeof(p_weekdays) <> 'object' then raise exception 'PM_INVALID: weekdays map 0 (Sunday) … 6 to tech hours' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(p_weekdays) loop
      if k !~ '^[0-6]$' then raise exception 'PM_INVALID: weekday % (0 = Sunday … 6)', k using errcode = '22023'; end if;
      insert into pm.dlr_service_capacity as c (org_id, location_id, weekday, tech_hours) values (v_org, p_location, k::int, (p_weekdays ->> k)::numeric)
      on conflict (org_id, location_id, weekday) do update set tech_hours = excluded.tech_hours;
    end loop;
  end if;
  for r in select value from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) loop
    if r ->> 'tech_hours' is null then
      delete from pm.dlr_capacity_overrides where org_id = v_org and location_id = p_location and day = (r ->> 'day')::date;
    else
      insert into pm.dlr_capacity_overrides as o (org_id, location_id, day, tech_hours, note)
      values (v_org, p_location, (r ->> 'day')::date, (r ->> 'tech_hours')::numeric, nullif(r ->> 'note', ''))
      on conflict (org_id, location_id, day) do update set tech_hours = excluded.tech_hours, note = excluded.note;
    end if;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

create or replace function pm._d5_day_capacity(p_org uuid, p_location uuid, p_day date) returns numeric
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(
    (select o.tech_hours from pm.dlr_capacity_overrides o where o.org_id = p_org and o.location_id = p_location and o.day = p_day),
    (select c.tech_hours from pm.dlr_service_capacity c where c.org_id = p_org and c.location_id = p_location and c.weekday = extract(dow from p_day)::int),
    case when extract(dow from p_day)::int in (0, 6) then 0 else coalesce((pm._d5_set(p_org, p_location) ->> 'daily_tech_hours')::numeric, 32) end)
$$;

-- Open shop work in hours (flagged hours on open dealer ROs, less what is clocked) — the backlog.
create or replace function pm._d5_backlog_hours(p_org uuid, p_location uuid) returns numeric
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(sum(greatest(coalesce(l.flag_hours, 1) - coalesce((select sum(extract(epoch from (coalesce(p.ended_at, now()) - p.started_at)) / 3600.0)
                                                                   from pm.dlr_tech_punches p where p.org_id = l.org_id and p.work_order_line_id = l.id), 0), 0)), 0)::numeric(10,2)
    from pm.work_order_lines l join pm.work_orders w on w.org_id = l.org_id and w.id = l.work_order_id
   where l.org_id = p_org and w.location_id = p_location and w.kind in ('REPAIR_ORDER','PDI') and w.status not in ('COMPLETE','CLOSED','CANCELLED')
     and l.kind = 'LABOR' and l.status = 'APPROVED'
$$;

-- First day the shop can finish `p_hours` more hours after today's backlog and the booked appointments.
create or replace function pm._d5_ready_date(p_org uuid, p_location uuid, p_from date, p_hours numeric) returns date
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_need numeric := pm._d5_backlog_hours(p_org, p_location) + coalesce(p_hours, 0); d date := p_from; k int := 0; v_cap numeric; v_booked numeric;
begin
  loop
    v_cap := pm._d5_day_capacity(p_org, p_location, d);
    select coalesce(sum(a.est_hours), 0) into v_booked from pm.dlr_service_appointments a
     where a.org_id = p_org and a.location_id = p_location and a.appt_on = d and a.status in ('BOOKED','CONFIRMED','ARRIVED') and d > p_from;
    v_need := v_need - greatest(v_cap - v_booked, 0);
    exit when v_need <= 0 or k > 120;
    d := d + 1; k := k + 1;
  end loop;
  return d;
end $$;

create or replace function pm.dlr_service_calendar(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_from date := coalesce(p_from, current_date); v_to date := coalesce(p_to, coalesce(p_from, current_date) + 13);
        v_days jsonb; v_back numeric;
begin
  if v_to < v_from or v_to - v_from > 62 then raise exception 'PM_INVALID: up to 62 days at a time' using errcode = '22023'; end if;
  v_back := pm._d5_backlog_hours(v_org, p_location);
  select coalesce(jsonb_agg(jsonb_build_object('day', g.d, 'capacity_hours', pm._d5_day_capacity(v_org, p_location, g.d),
           'booked_hours', coalesce(b.hrs, 0), 'appointments', coalesce(b.n, 0), 'pickups', coalesce(s.pk, 0), 'deliveries', coalesce(s.dl, 0),
           'free_hours', greatest(pm._d5_day_capacity(v_org, p_location, g.d) - coalesce(b.hrs, 0), 0)) order by g.d), '[]'::jsonb)
    into v_days
    from (select generate_series(v_from, v_to, interval '1 day')::date as d) g
    left join (select a.appt_on, sum(a.est_hours) as hrs, count(*) as n from pm.dlr_service_appointments a
                where a.org_id = v_org and a.location_id = p_location and a.status in ('BOOKED','CONFIRMED','ARRIVED') group by 1) b on b.appt_on = g.d
    left join (select x.stop_on, count(*) filter (where x.kind = 'PICKUP') as pk, count(*) filter (where x.kind = 'DELIVERY') as dl from pm.dlr_stops x
                where x.org_id = v_org and x.location_id = p_location and x.status = 'PLANNED' group by 1) s on s.stop_on = g.d;
  return jsonb_build_object('from', v_from, 'to', v_to, 'days', v_days, 'backlog_hours', v_back,
    'backlog_days', round(v_back / nullif(greatest(pm._d5_day_capacity(v_org, p_location, current_date), 1), 0), 1),
    'next_ready_on', pm._d5_ready_date(v_org, p_location, current_date, 1),
    'appointments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'number', a.number, 'appt_on', a.appt_on, 'window_start', a.window_start,
        'window_end', a.window_end, 'est_hours', a.est_hours, 'status', a.status, 'customer', (select c.name from core.customers c where c.id = a.customer_id),
        'unit', pm._d5_unit_label(a.asset_id), 'complaint', a.complaint, 'pickup', a.pickup, 'delivery', a.delivery, 'quoted_ready_on', a.quoted_ready_on,
        'work_order_id', a.work_order_id) order by a.appt_on, a.window_start nulls last)
      from pm.dlr_service_appointments a where a.org_id = v_org and a.location_id = p_location and a.appt_on between v_from and v_to), '[]'::jsonb));
end $$;

-- Book a drop-off. Over capacity is allowed (returned, so the writer can offer another day); a pickup
-- adds a truck stop on the appointment day.
create or replace function pm.dlr_book_service(p_location uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_day date := pm._x_try_date(a ->> 'appt_on');
        v_hours numeric := coalesce(pm._x_try_num(a ->> 'est_hours'), 1); v_cust uuid := pm.access_try_uuid(a ->> 'customer_id'); v_unit uuid := pm.access_try_uuid(a ->> 'asset_id');
        v_id uuid; v_cap numeric; v_booked numeric; v_ready date; c core.customers%rowtype;
begin
  if v_day is null or v_day < current_date then raise exception 'PM_INVALID: pick a day from today on' using errcode = '22023'; end if;
  if v_cust is not null then
    select * into c from core.customers x where x.id = v_cust and x.org_id = v_org;
    if c.id is null then raise exception 'PM_UNKNOWN_CUSTOMER: customer not found' using errcode = '22023'; end if;
  end if;
  if v_unit is not null and not exists (select 1 from pm.assets x where x.org_id = v_org and x.id = v_unit) then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  v_cap := pm._d5_day_capacity(v_org, p_location, v_day);
  select coalesce(sum(x.est_hours), 0) into v_booked from pm.dlr_service_appointments x
   where x.org_id = v_org and x.location_id = p_location and x.appt_on = v_day and x.status in ('BOOKED','CONFIRMED','ARRIVED');
  v_ready := pm._d5_ready_date(v_org, p_location, v_day, v_hours);
  insert into pm.dlr_service_appointments (org_id, location_id, number, customer_id, asset_id, contact_id, appt_on, window_start, window_end, est_hours, complaint,
                                           pickup, delivery, address_line1, city, state, zip, lat, lng, quoted_ready_on, notes)
  values (v_org, p_location, pm._d5_number(v_org, p_location, 'APT'), v_cust, v_unit, pm.access_try_uuid(a ->> 'contact_id'), v_day,
          nullif(a ->> 'window_start', '')::time, nullif(a ->> 'window_end', '')::time, v_hours, left(nullif(a ->> 'complaint', ''), 1000),
          coalesce(pm._x_try_bool(a ->> 'pickup'), false), coalesce(pm._x_try_bool(a ->> 'delivery'), false),
          coalesce(nullif(a ->> 'address_line1', ''), c.address_line1), coalesce(nullif(a ->> 'city', ''), c.city), coalesce(nullif(a ->> 'state', ''), c.state),
          coalesce(nullif(a ->> 'zip', ''), c.zip), pm._x_try_num(a ->> 'lat'), pm._x_try_num(a ->> 'lng'), v_ready, nullif(a ->> 'notes', ''))
  returning id into v_id;
  if coalesce(pm._x_try_bool(a ->> 'pickup'), false) then
    insert into pm.dlr_stops (org_id, location_id, kind, purpose, stop_on, window_start, window_end, appointment_id, customer_id, asset_id, address_line1, city, state, zip, lat, lng)
    select org_id, location_id, 'PICKUP', 'SERVICE', appt_on, window_start, window_end, id, customer_id, asset_id, address_line1, city, state, zip, lat, lng
      from pm.dlr_service_appointments where id = v_id;
  end if;
  return jsonb_build_object('appointment_id', v_id, 'over_capacity', v_booked + v_hours > v_cap, 'capacity_hours', v_cap, 'booked_hours', v_booked + v_hours,
                            'quoted_ready_on', v_ready);
end $$;

create or replace function pm.dlr_update_appointment(p_appointment uuid, p_status text, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare ap pm.dlr_service_appointments%rowtype; v_to text := upper(coalesce(p_status, '')); a jsonb := coalesce(p_attrs, '{}');
begin
  select * into ap from pm.dlr_service_appointments x where x.id = p_appointment for update;
  if ap.org_id is null or ap.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: appointment not found' using errcode = '42501'; end if;
  if v_to not in ('BOOKED','CONFIRMED','ARRIVED','NO_SHOW','CANCELLED') then raise exception 'PM_INVALID: status %', v_to using errcode = '22023'; end if;
  if ap.status in ('CHECKED_IN','CANCELLED') then raise exception 'PM_INVALID: appointment % is %', ap.number, ap.status using errcode = '22023'; end if;
  update pm.dlr_service_appointments set status = v_to, appt_on = coalesce(pm._x_try_date(a ->> 'appt_on'), appt_on),
         est_hours = coalesce(pm._x_try_num(a ->> 'est_hours'), est_hours), notes = coalesce(nullif(a ->> 'notes', ''), notes), updated_at = now()
   where id = ap.id;
  if v_to in ('CANCELLED','NO_SHOW') then update pm.dlr_stops set status = 'CANCELLED' where org_id = ap.org_id and appointment_id = ap.id and status = 'PLANNED'; end if;
  return jsonb_build_object('appointment_id', ap.id, 'status', v_to);
end $$;

-- A truck stop by hand (finished unit going home, rental drop / pickup, sold unit delivery).
create or replace function pm.dlr_add_stop(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid; v_kind text := upper(coalesce(a ->> 'kind', 'DELIVERY'));
        v_cust uuid := pm.access_try_uuid(a ->> 'customer_id'); c core.customers%rowtype; v_wo uuid := pm.access_try_uuid(a ->> 'work_order_id');
        v_rc uuid := pm.access_try_uuid(a ->> 'rental_contract_id');
begin
  if v_kind not in ('PICKUP','DELIVERY') then raise exception 'PM_INVALID: a stop is a pickup or a delivery' using errcode = '22023'; end if;
  if pm._x_try_date(a ->> 'stop_on') is null then raise exception 'PM_INVALID: pick the day' using errcode = '22023'; end if;
  if v_wo is not null and not exists (select 1 from pm.work_orders w where w.org_id = v_org and w.id = v_wo and w.location_id = p_location) then
    raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501';
  end if;
  if v_rc is not null then
    select r.customer_id into v_cust from pm.rental_contracts r where r.org_id = v_org and r.id = v_rc and r.location_id = p_location;
    if v_cust is null then raise exception 'PM_FORBIDDEN: rental contract not found' using errcode = '42501'; end if;
  end if;
  if v_wo is not null and v_cust is null then
    select coalesce(j.customer_id, a2.customer_id) into v_cust from pm.work_orders w join core.jobs j on j.id = w.job_id
      left join pm.assets a2 on a2.org_id = w.org_id and a2.id = w.asset_id where w.id = v_wo;
  end if;
  if v_cust is not null then select * into c from core.customers x where x.id = v_cust and x.org_id = v_org; end if;
  insert into pm.dlr_stops (org_id, location_id, kind, purpose, stop_on, window_start, window_end, work_order_id, rental_contract_id, deal_id, customer_id, asset_id,
                            address_line1, city, state, zip, lat, lng, notes, driver_employee_id)
  values (v_org, p_location, v_kind, upper(coalesce(nullif(a ->> 'purpose', ''), case when v_rc is not null then 'RENTAL' else 'SERVICE' end)),
          (a ->> 'stop_on')::date, nullif(a ->> 'window_start', '')::time, nullif(a ->> 'window_end', '')::time, v_wo, v_rc,
          pm.access_try_uuid(a ->> 'deal_id'), v_cust, pm.access_try_uuid(a ->> 'asset_id'),
          coalesce(nullif(a ->> 'address_line1', ''), c.address_line1), coalesce(nullif(a ->> 'city', ''), c.city), coalesce(nullif(a ->> 'state', ''), c.state),
          coalesce(nullif(a ->> 'zip', ''), c.zip), pm._x_try_num(a ->> 'lat'), pm._x_try_num(a ->> 'lng'), nullif(a ->> 'notes', ''),
          pm.access_try_uuid(a ->> 'driver_employee_id'))
  returning id into v_id;
  return v_id;
end $$;

-- The day's route (stops in the saved order; lib/dealer/routing.ts proposes a nearest-neighbor order).
create or replace function pm.dlr_route_plan(p_location uuid, p_day date)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_set jsonb := pm._d5_set(pm._x_org_of_location(p_location), p_location);
begin
  return jsonb_build_object('day', p_day, 'origin', jsonb_build_object('lat', v_set -> 'lot_lat', 'lng', v_set -> 'lot_lng'),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'purpose', s.purpose, 'seq', s.seq, 'status', s.status,
        'customer', (select c.name from core.customers c where c.id = s.customer_id), 'unit', pm._d5_unit_label(s.asset_id),
        'address_line1', s.address_line1, 'city', s.city, 'state', s.state, 'zip', s.zip, 'lat', s.lat, 'lng', s.lng,
        'window_start', s.window_start, 'window_end', s.window_end, 'work_order_id', s.work_order_id, 'rental_contract_id', s.rental_contract_id,
        'appointment_id', s.appointment_id, 'notes', s.notes) order by s.seq nulls last, s.window_start nulls last, s.created_at)
      from pm.dlr_stops s where s.org_id = v_org and s.location_id = p_location and s.stop_on = p_day and s.status <> 'CANCELLED'), '[]'::jsonb));
end $$;

create or replace function pm.dlr_set_route_order(p_location uuid, p_day date, p_stops uuid[])
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); i int := 0; s uuid;
begin
  foreach s in array coalesce(p_stops, '{}') loop
    i := i + 1;
    update pm.dlr_stops set seq = i where org_id = v_org and location_id = p_location and stop_on = p_day and id = s;
  end loop;
  return i;
end $$;

create or replace function pm.dlr_finish_stop(p_stop uuid, p_status text default 'DONE')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_stops%rowtype; v_to text := upper(coalesce(p_status, 'DONE'));
begin
  select * into s from pm.dlr_stops x where x.id = p_stop for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: stop not found' using errcode = '42501'; end if;
  if v_to not in ('DONE','CANCELLED','PLANNED') then raise exception 'PM_INVALID: status %', v_to using errcode = '22023'; end if;
  update pm.dlr_stops set status = v_to, done_at = case when v_to = 'DONE' then now() end where id = s.id;
  if v_to = 'DONE' and s.kind = 'PICKUP' and s.appointment_id is not null then
    update pm.dlr_service_appointments set status = 'ARRIVED', updated_at = now() where id = s.appointment_id and status in ('BOOKED','CONFIRMED');
  end if;
  return jsonb_build_object('stop_id', s.id, 'status', v_to);
end $$;

-- DLR-51: the RO's stage (the shop's words) and its customer texts.
create table if not exists pm.dlr_ro_state (
  org_id          uuid not null references core.organizations(id) on delete cascade,
  work_order_id   uuid not null,
  job_id          uuid not null,
  location_id     uuid not null references core.locations(id),
  stage           text not null default 'CHECKED_IN' check (stage in ('CHECKED_IN','DIAGNOSING','WAITING_APPROVAL','WAITING_PARTS','IN_PROGRESS','QC','READY','PICKED_UP')),
  stage_at        timestamptz not null default now(),
  ready_at        timestamptz,
  qc_passed_at    timestamptz,
  qc_by           text,
  qc_checklist    jsonb not null default '[]' check (jsonb_typeof(qc_checklist) = 'array'),
  picked_up_at    timestamptz,
  pickup_signer   text,
  pickup_document_id uuid,
  updated_by      text,
  primary key (org_id, work_order_id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_ro_state_loc_idx on pm.dlr_ro_state (org_id, location_id, stage);

create or replace function pm._d5_stage_text(p_stage text, p_unit text, p_number text, p_company text) returns text
language sql immutable
as $$
  select case p_stage
    when 'CHECKED_IN'       then format('%s: we checked in your %s (RO %s). We''ll text you as it moves along.', p_company, p_unit, p_number)
    when 'WAITING_APPROVAL' then format('%s: your %s (RO %s) needs your OK on added work. Look for the estimate link we just sent.', p_company, p_unit, p_number)
    when 'WAITING_PARTS'    then format('%s: we''re waiting on parts for your %s (RO %s). We''ll text you when they arrive.', p_company, p_unit, p_number)
    when 'IN_PROGRESS'      then format('%s: a technician is working on your %s (RO %s).', p_company, p_unit, p_number)
    when 'READY'            then format('%s: your %s is ready for pickup (RO %s).', p_company, p_unit, p_number)
    when 'PICKED_UP'        then format('%s: thanks for picking up your %s. Reply if anything is not right.', p_company, p_unit)
    else format('%s: an update on your %s (RO %s).', p_company, p_unit, p_number) end
$$;

-- Move the RO's stage; texts the customer when the store has that stage switched on.
create or replace function pm._d5_set_stage(p_wo uuid, p_stage text, p_text boolean default true) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; st pm.dlr_ro_state%rowtype; v_set jsonb; v_cust uuid; v_r jsonb;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  insert into pm.dlr_ro_state as s (org_id, work_order_id, job_id, location_id, stage, ready_at, updated_by)
  values (w.org_id, w.id, w.job_id, w.location_id, p_stage, case when p_stage = 'READY' then now() end, pm.current_user_id())
  on conflict (org_id, work_order_id) do update set stage = excluded.stage, stage_at = case when s.stage is distinct from excluded.stage then now() else s.stage_at end,
    ready_at = case when excluded.stage = 'READY' then coalesce(s.ready_at, now()) else s.ready_at end, updated_by = excluded.updated_by
  returning * into st;
  if p_text then
    v_set := pm._d5_set(w.org_id, w.location_id);
    if coalesce((v_set -> 'status_texts' ->> p_stage)::boolean, false) then
      select coalesce(j.customer_id, a.customer_id) into v_cust from core.jobs j left join pm.assets a on a.org_id = w.org_id and a.id = w.asset_id where j.id = w.job_id;
      v_r := pm._d5_text(w.org_id, w.location_id, w.job_id, v_cust, case when p_stage = 'READY' then 'PICKUP' else 'STATUS' end, 'work_orders', w.id,
        pm._d5_stage_text(p_stage, coalesce(btrim(concat_ws(' ', (select a.make from pm.assets a where a.id = w.asset_id), (select a.model from pm.assets a where a.id = w.asset_id))), 'equipment'),
                          coalesce(w.number, ''), pm._d5_company_name(w.location_id)),
        'ro:' || w.id::text || ':' || p_stage, w.id);
    end if;
  end if;
  return jsonb_build_object('work_order_id', w.id, 'stage', st.stage, 'text', v_r);
end $$;

create or replace function pm.dlr_set_ro_stage(p_wo uuid, p_stage text, p_text boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_stage text := upper(coalesce(p_stage, ''));
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if v_stage not in ('CHECKED_IN','DIAGNOSING','WAITING_APPROVAL','WAITING_PARTS','IN_PROGRESS','QC','READY','PICKED_UP') then
    raise exception 'PM_INVALID: stage %', v_stage using errcode = '22023';
  end if;
  if v_stage = 'READY' and coalesce((pm._d5_set(w.org_id, w.location_id) ->> 'qc_required')::boolean, true) and w.kind = 'REPAIR_ORDER'
     and not exists (select 1 from pm.dlr_ro_state s where s.org_id = w.org_id and s.work_order_id = w.id and s.qc_passed_at is not null) then
    raise exception 'PM_QC_REQUIRED: pass the QC check before the unit is ready' using errcode = '22023';
  end if;
  return pm._d5_set_stage(w.id, v_stage, coalesce(p_text, true));
end $$;

-- A free-form text to the RO's customer (two-way replies arrive in the 1114 inbound route).
create or replace function pm.dlr_text_ro_customer(p_wo uuid, p_body text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_cust uuid;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null or char_length(p_body) > 600 then raise exception 'PM_INVALID: write a text up to 600 characters' using errcode = '22023'; end if;
  select coalesce(j.customer_id, a.customer_id) into v_cust from core.jobs j left join pm.assets a on a.org_id = w.org_id and a.id = w.asset_id where j.id = w.job_id;
  return pm._d5_text(w.org_id, w.location_id, w.job_id, v_cust, 'MANUAL', 'work_orders', w.id, btrim(p_body), null, w.id);
end $$;

-- "Is my mower ready?": the answer drafted from RO data (the writer sends it, or the inbound route will).
create or replace function pm.dlr_ro_status_reply(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; st pm.dlr_ro_state%rowtype; v_unit text; v_ready date; v_txt text; v_pend int;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  select * into st from pm.dlr_ro_state s where s.org_id = w.org_id and s.work_order_id = w.id;
  v_unit := coalesce(btrim(concat_ws(' ', (select a.make from pm.assets a where a.id = w.asset_id), (select a.model from pm.assets a where a.id = w.asset_id))), 'equipment');
  select count(*) into v_pend from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'PROPOSED';
  v_ready := coalesce(w.promised_on, (select a.quoted_ready_on from pm.dlr_service_appointments a where a.org_id = w.org_id and a.work_order_id = w.id limit 1));
  v_txt := case
    when w.status = 'CLOSED' or st.stage in ('READY') then format('Yes, your %s is ready for pickup (RO %s).', v_unit, w.number)
    when st.stage = 'PICKED_UP' then format('Our records show your %s was picked up. Reply if that is not right.', v_unit)
    when v_pend > 0 or st.stage = 'WAITING_APPROVAL' then format('Your %s is waiting on your OK for %s added item(s). Check the estimate link we sent.', v_unit, greatest(v_pend, 1))
    when st.stage = 'WAITING_PARTS' then format('Your %s is waiting on parts.%s', v_unit, case when v_ready is not null then format(' We expect it ready by %s.', to_char(v_ready, 'FMMon FMDD')) else '' end)
    else format('Your %s is in the shop (RO %s).%s', v_unit, w.number, case when v_ready is not null then format(' We expect it ready by %s.', to_char(v_ready, 'FMMon FMDD')) else '' end) end;
  return jsonb_build_object('work_order_id', w.id, 'stage', coalesce(st.stage, 'CHECKED_IN'), 'reply', v_txt, 'confident', st.stage is not null);
end $$;

-- DLR-42: check-in. One call creates the RO (and the RO's job when none is given), the complaint lines,
-- meter, tag, authorization limit, photos, the deposit request (Books customer deposit), the stage.
create table if not exists pm.dlr_ro_checkins (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  job_id              uuid not null,
  work_order_id       uuid not null,
  asset_id            uuid not null,
  customer_id         uuid references core.customers(id),
  contact_id          uuid,
  appointment_id      uuid,
  tag_number          text,
  meter               numeric(12,2),
  auth_limit_cents    bigint check (auth_limit_cents is null or auth_limit_cents >= 0),
  complaints          jsonb not null default '[]' check (jsonb_typeof(complaints) = 'array'),
  photo_document_ids  uuid[] not null default '{}',
  deposit_cents       bigint check (deposit_cents is null or deposit_cents >= 0),
  deposit_request_id  uuid,
  signature_method    text check (signature_method is null or signature_method in ('COUNTER','TEXT')),
  envelope_id         uuid,
  signer_name         text,
  signature_document_id uuid,
  signed_at           timestamptz,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, work_order_id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_check_in(p_location uuid, p_unit uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); u pm.assets%rowtype; v_job uuid := pm.access_try_uuid(a ->> 'job_id');
        v_cust uuid; v_wo uuid; c jsonb; n int := 0; v_first text; v_set jsonb; v_dep uuid; v_id uuid; v_meter numeric := pm._x_try_num(a ->> 'meter');
        v_appt uuid := pm.access_try_uuid(a ->> 'appointment_id'); v_pay text; v_payer uuid; v_stage jsonb;
begin
  select * into u from pm.assets x where x.id = p_unit and x.org_id = v_org;
  if u.id is null then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(a -> 'complaints', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(a -> 'complaints', '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: write at least one complaint line' using errcode = '22023';
  end if;
  v_cust := coalesce(pm.access_try_uuid(a ->> 'customer_id'), u.customer_id);
  v_set := pm._d5_set(v_org, p_location);
  select coalesce(nullif(btrim(x ->> 'text'), ''), x #>> '{}') into v_first from jsonb_array_elements(a -> 'complaints') x limit 1;
  if v_job is null then
    if not pm._x_sees('projects.jobs', 'create', p_location) then raise exception 'PM_FORBIDDEN: opening a new RO job needs Jobs create' using errcode = '42501'; end if;
    v_job := pm.create_project(p_location, coalesce(nullif(a ->> 'job_type_key', ''), v_set ->> 'service_job_type_key', 'customer_repair'),
                               left(format('RO %s %s', coalesce(u.make, ''), coalesce(u.model, u.serial_number, '')), 200), v_cust, null, u.is_sample, '{}'::jsonb);
  else
    perform pm._x_job(v_job);
    if (select jx.location_id from core.jobs jx where jx.id = v_job) is distinct from p_location then
      raise exception 'PM_INVALID: that job is at another company' using errcode = '22023';
    end if;
  end if;
  v_pay := upper(coalesce(nullif(a ->> 'payer_type', ''), 'CUSTOMER'));
  v_payer := pm.access_try_uuid(a ->> 'payer_customer_id');
  v_wo := pm.create_work_order(v_job, 'REPAIR_ORDER', left(coalesce(v_first, 'Repair order'), 200), coalesce(pm._x_try_num(a ->> 'priority')::int, 3), u.id,
                               null, null, null, '{}', v_pay, v_payer, false, null, left(v_first, 2000), '{}'::jsonb, pm._x_try_date(a ->> 'promised_on'));
  update pm.work_orders set checked_in_at = now(), meter_in = coalesce(v_meter, meter_in) where id = v_wo;
  if v_meter is not null and (u.meter_reading is null or v_meter >= u.meter_reading) then
    update pm.assets set meter_reading = v_meter, meter_read_on = current_date where id = u.id;
  end if;
  for c in select value from jsonb_array_elements(a -> 'complaints') loop
    n := n + 1;
    -- security review H3: a complaint priced on the screen below flag hours x the posted rate needs the limit
    if pm._x_try_bigint(c ->> 'unit_price_cents') is not null and coalesce(pm._x_try_num(c ->> 'flag_hours'), 0) > 0 and pm._d5_posted_labor_rate(v_org, p_location) is not null then
      perform pm._d5_assert_price(p_location, pm.fs_rdiv(pm._x_try_num(c ->> 'flag_hours') * pm._d5_posted_labor_rate(v_org, p_location), 1),
                                  pm._x_try_bigint(c ->> 'unit_price_cents'), null, 'that labor price');
    end if;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, pay_type, flag_hours, labor_op, unit_price_cents)
    values (v_org, v_job, v_wo, n, 'LABOR', left(coalesce(nullif(btrim(c ->> 'text'), ''), c #>> '{}'), 300), 1,
            upper(coalesce(nullif(c ->> 'pay_type', ''), case when v_pay = 'OEM' then 'WARRANTY' when v_pay = 'INTERNAL' then 'INTERNAL' else 'CUSTOMER' end)),
            pm._x_try_num(c ->> 'flag_hours'), nullif(c ->> 'labor_op', ''), pm._x_try_bigint(c ->> 'unit_price_cents'));
  end loop;
  if coalesce(pm._x_try_bigint(a ->> 'deposit_cents'), 0) > 0 then
    if not pm._x_sees('projects.billing', 'create', p_location) then raise exception 'PM_FORBIDDEN: taking an RO deposit needs Billing create' using errcode = '42501'; end if;
    v_dep := pm.request_deposit(v_job, (a ->> 'deposit_cents')::bigint, 'RO deposit', current_date);
  end if;
  insert into pm.dlr_ro_checkins (org_id, location_id, job_id, work_order_id, asset_id, customer_id, contact_id, appointment_id, tag_number, meter,
                                  auth_limit_cents, complaints, photo_document_ids, deposit_cents, deposit_request_id)
  values (v_org, p_location, v_job, v_wo, u.id, v_cust, coalesce(pm.access_try_uuid(a ->> 'contact_id'), case when v_cust is not null then pm._d5_contact(v_org, v_cust) end),
          v_appt, nullif(btrim(a ->> 'tag_number'), ''), v_meter, pm._x_try_bigint(a ->> 'auth_limit_cents'), a -> 'complaints',
          pm._d5_claim_docs(v_org, v_job, coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x
                                                          where pm.access_try_uuid(x) is not null), '{}'), 'check-in photo'),
          pm._x_try_bigint(a ->> 'deposit_cents'), v_dep)
  returning id into v_id;
  if v_appt is not null then
    update pm.dlr_service_appointments set status = 'CHECKED_IN', work_order_id = v_wo, job_id = v_job, updated_at = now()
     where org_id = v_org and id = v_appt and location_id = p_location;
  end if;
  v_stage := pm._d5_set_stage(v_wo, 'CHECKED_IN', true);
  perform pm.log_activity(v_org, p_location, v_job, 'ro.checked_in', 'work_orders', v_wo, format('Checked in %s with %s line(s)', pm._d5_unit_label(u.id), n),
    jsonb_build_object('tag', a ->> 'tag_number', 'meter', v_meter));
  return jsonb_build_object('checkin_id', v_id, 'work_order_id', v_wo, 'job_id', v_job, 'lines', n, 'deposit_request_id', v_dep, 'text', v_stage -> 'text');
end $$;

-- Signature at the counter (typed name + drawn signature filed as a document by the app), or the
-- envelope the app sent by text (settled by pm.tg_d5_envelope when the customer signs).
create or replace function pm.dlr_record_checkin_signature(p_checkin uuid, p_method text, p_signer text default null, p_document uuid default null,
                                                            p_envelope uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare ck pm.dlr_ro_checkins%rowtype; v_m text := upper(coalesce(p_method, ''));
begin
  select * into ck from pm.dlr_ro_checkins x where x.id = p_checkin for update;
  if ck.org_id is null or ck.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: check-in not found' using errcode = '42501'; end if;
  if v_m = 'COUNTER' then
    if nullif(btrim(coalesce(p_signer, '')), '') is null then raise exception 'PM_INVALID: the signer''s name is required' using errcode = '22023'; end if;
    update pm.dlr_ro_checkins set signature_method = 'COUNTER', signer_name = btrim(p_signer),
           signature_document_id = pm._d5_claim_doc(ck.org_id, ck.job_id, p_document, 'signature'), signed_at = now() where id = ck.id;
  elsif v_m = 'TEXT' then
    if p_envelope is null then raise exception 'PM_INVALID: the signature request was not found' using errcode = '22023'; end if;
    perform pm._d5_assert_envelope(ck.org_id, ck.job_id, p_envelope);
    update pm.dlr_ro_checkins set signature_method = 'TEXT', envelope_id = p_envelope where id = ck.id;
  else
    raise exception 'PM_INVALID: sign at the counter or by text' using errcode = '22023';
  end if;
  return jsonb_build_object('checkin_id', ck.id, 'method', v_m);
end $$;

-- DLR-45: findings (tech adds work with photos) → an estimate batch → PROPOSED RO lines → approval by
-- text (e-sign: signing approves the batch, declining declines it) or per line (phone / in person).
create table if not exists pm.dlr_ro_estimates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  job_id         uuid not null,
  work_order_id  uuid not null,
  number         text not null,
  status         text not null default 'SENT' check (status in ('SENT','APPROVED','DECLINED','PARTIAL','VOID')),
  total_cents    bigint not null default 0,
  message        text,
  envelope_id    uuid,
  sent_at        timestamptz not null default now(),
  decided_at     timestamptz,
  created_by     text default pm.current_user_id(),
  unique (org_id, id),
  unique (org_id, number),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dlr_ro_findings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  work_order_id       uuid not null,
  description         text not null check (char_length(description) between 1 and 300),
  tech_note           text,
  labor_hours         numeric(7,2) not null default 0 check (labor_hours >= 0),
  labor_rate_cents    bigint not null default 0 check (labor_rate_cents >= 0),
  parts               jsonb not null default '[]' check (jsonb_typeof(parts) = 'array'),
  amount_cents        bigint not null default 0,
  photo_document_ids  uuid[] not null default '{}',
  video_document_id   uuid,
  status              text not null default 'DRAFT' check (status in ('DRAFT','SENT','APPROVED','DECLINED','VOID')),
  estimate_id         uuid,
  line_ids            uuid[] not null default '{}',
  decided_at          timestamptz,
  decided_by_name     text,
  decision_method     text check (decision_method is null or decision_method in ('TEXT_LINK','PHONE','IN_PERSON','PORTAL')),
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.dlr_ro_estimates (org_id, id) deferrable initially immediate
);
create index if not exists pm_dlr_ro_findings_wo_idx on pm.dlr_ro_findings (org_id, work_order_id, status);

create or replace function pm.dlr_add_finding(p_wo uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_parts jsonb := coalesce(a -> 'parts', '[]'::jsonb); x jsonb; v_amt bigint; v_id uuid;
        v_hrs numeric := coalesce(pm._x_try_num(a ->> 'labor_hours'), 0); v_rate bigint := coalesce(pm._x_try_bigint(a ->> 'labor_rate_cents'), 0); p pm.parts%rowtype;
        v_clean jsonb := '[]';
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if nullif(btrim(coalesce(a ->> 'description', '')), '') is null then raise exception 'PM_INVALID: describe what you found' using errcode = '22023'; end if;
  if jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) > 30 then raise exception 'PM_INVALID: up to 30 parts on a finding' using errcode = '22023'; end if;
  if v_hrs > 0 and v_rate = 0 then raise exception 'PM_INVALID: labor needs a rate' using errcode = '22023'; end if;
  -- security review H3: the labor rate is checked against the store's posted rate (below it needs the
  -- member's discount limit), each part's price against the part's price and cost.
  if v_hrs > 0 and pm._d5_posted_labor_rate(w.org_id, w.location_id) is not null and v_rate < pm._d5_posted_labor_rate(w.org_id, w.location_id) then
    perform pm._d5_assert_price(w.location_id, pm.fs_rdiv(v_hrs * pm._d5_posted_labor_rate(w.org_id, w.location_id), 1), pm.fs_rdiv(v_hrs * v_rate, 1), null,
                                'a labor rate under the posted rate');
  end if;
  v_amt := pm.fs_rdiv(v_hrs * v_rate, 1);
  for x in select value from jsonb_array_elements(v_parts) loop
    p := null;
    if pm.access_try_uuid(x ->> 'part_id') is not null then
      select * into p from pm.parts q where q.org_id = w.org_id and q.id = (x ->> 'part_id')::uuid;
      if p.id is null then raise exception 'PM_INVALID: part not found' using errcode = '22023'; end if;
    end if;
    if coalesce(pm._x_try_num(x ->> 'qty'), 0) <= 0 then raise exception 'PM_INVALID: each part needs a quantity' using errcode = '22023'; end if;
    if p.id is not null and pm._x_try_bigint(x ->> 'unit_price_cents') is not null then
      perform pm._d5_assert_price(w.location_id, coalesce(p.price_cents, p.list_price_cents), pm._x_try_bigint(x ->> 'unit_price_cents'), p.cost_cents,
                                  coalesce(p.part_number, 'that part'));
    end if;
    v_clean := v_clean || jsonb_build_object('part_id', p.id, 'part_number', coalesce(p.part_number, x ->> 'part_number'),
      'description', coalesce(nullif(x ->> 'description', ''), p.description, 'Part'), 'qty', (x ->> 'qty')::numeric,
      'unit_price_cents', coalesce(pm._x_try_bigint(x ->> 'unit_price_cents'), p.price_cents, p.list_price_cents, 0));
    v_amt := v_amt + pm.fs_rdiv((x ->> 'qty')::numeric * coalesce(pm._x_try_bigint(x ->> 'unit_price_cents'), p.price_cents, p.list_price_cents, 0), 1);
  end loop;
  insert into pm.dlr_ro_findings (org_id, job_id, work_order_id, description, tech_note, labor_hours, labor_rate_cents, parts, amount_cents, photo_document_ids, video_document_id)
  values (w.org_id, w.job_id, w.id, btrim(a ->> 'description'), nullif(a ->> 'tech_note', ''), v_hrs, v_rate, v_clean, v_amt,
          pm._d5_claim_docs(w.org_id, w.job_id, coalesce(array(select pm.access_try_uuid(y) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) y
                                                              where pm.access_try_uuid(y) is not null), '{}'), 'finding photo'),
          pm._d5_claim_doc(w.org_id, w.job_id, pm.access_try_uuid(a ->> 'video_document_id'), 'finding video'))
  returning id into v_id;
  return jsonb_build_object('finding_id', v_id, 'amount_cents', v_amt);
end $$;

-- Send draft findings: each becomes PROPOSED lines (labor + parts, option group = the finding) on the RO,
-- the batch is numbered, the stage moves to WAITING_APPROVAL (text). The app then sends the RO document
-- for e-signature by text and links the envelope (pm.dlr_link_estimate_envelope).
create or replace function pm.dlr_send_estimate(p_wo uuid, p_findings uuid[], p_message text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; f pm.dlr_ro_findings%rowtype; v_est uuid; v_total bigint := 0; v_lines uuid[]; v_l uuid; x jsonb; n int := 0; v_sort int; v_limit bigint;
        v_stage jsonb;
begin
  select * into w from pm.work_orders q where q.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('COMPLETE','CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if coalesce(cardinality(p_findings), 0) = 0 then raise exception 'PM_INVALID: pick the findings to send' using errcode = '22023'; end if;
  insert into pm.dlr_ro_estimates (org_id, location_id, job_id, work_order_id, number, message)
  values (w.org_id, w.location_id, w.job_id, w.id, pm._d5_number(w.org_id, w.location_id, 'EST'), nullif(btrim(coalesce(p_message, '')), ''))
  returning id into v_est;
  select coalesce(max(l.sort), 0) into v_sort from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id;
  for f in select * from pm.dlr_ro_findings q where q.org_id = w.org_id and q.work_order_id = w.id and q.id = any (p_findings) for update loop
    if f.status <> 'DRAFT' then raise exception 'PM_INVALID: "%" was already sent', f.description using errcode = '22023'; end if;
    v_lines := '{}';
    if f.labor_hours > 0 then
      v_sort := v_sort + 1;
      insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, flag_hours, pay_type, option_group, status)
      values (w.org_id, w.job_id, w.id, v_sort, 'LABOR', f.description, 1, pm.fs_rdiv(f.labor_hours * f.labor_rate_cents, 1), f.labor_hours, 'CUSTOMER', f.id::text, 'PROPOSED')
      returning id into v_l;
      v_lines := v_lines || v_l;
    end if;
    for x in select value from jsonb_array_elements(f.parts) loop
      v_sort := v_sort + 1;
      insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, part_id, pay_type, option_group, status)
      values (w.org_id, w.job_id, w.id, v_sort, 'PART', left(coalesce(x ->> 'part_number' || ' ', '') || coalesce(x ->> 'description', 'Part'), 300), (x ->> 'qty')::numeric,
              (x ->> 'unit_price_cents')::bigint, pm.access_try_uuid(x ->> 'part_id'), 'CUSTOMER', f.id::text, 'PROPOSED')
      returning id into v_l;
      v_lines := v_lines || v_l;
    end loop;
    update pm.dlr_ro_findings set status = 'SENT', estimate_id = v_est, line_ids = v_lines where id = f.id;
    v_total := v_total + f.amount_cents;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'PM_INVALID: none of those findings are on this RO' using errcode = '22023'; end if;
  update pm.dlr_ro_estimates set total_cents = v_total where id = v_est;
  select c.auth_limit_cents into v_limit from pm.dlr_ro_checkins c where c.org_id = w.org_id and c.work_order_id = w.id;
  v_stage := pm._d5_set_stage(w.id, 'WAITING_APPROVAL', true);
  return jsonb_build_object('estimate_id', v_est, 'findings', n, 'total_cents', v_total, 'over_auth_limit', v_limit is not null and v_total > v_limit, 'text', v_stage -> 'text');
end $$;

create or replace function pm.dlr_link_estimate_envelope(p_estimate uuid, p_envelope uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.dlr_ro_estimates%rowtype;
begin
  select * into e from pm.dlr_ro_estimates x where x.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if not exists (select 1 from pm.esign_envelopes v where v.id = p_envelope and v.org_id = e.org_id and v.job_id = e.job_id) then
    raise exception 'PM_INVALID: that signature request is not on this RO''s job' using errcode = '22023';
  end if;
  update pm.dlr_ro_estimates set envelope_id = p_envelope where id = e.id;
  return jsonb_build_object('estimate_id', e.id, 'envelope_id', p_envelope);
end $$;

-- Per-line decisions (phone / in person / portal): decisions [{finding_id, decision APPROVED | DECLINED}].
create or replace function pm._d5_decide_findings(p_estimate uuid, p_decisions jsonb, p_name text, p_method text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.dlr_ro_estimates%rowtype; d jsonb; f pm.dlr_ro_findings%rowtype; v_appr uuid[] := '{}'; v_decl uuid[] := '{}'; v_left int; v_ok int; v_status text;
begin
  select * into e from pm.dlr_ro_estimates x where x.id = p_estimate for update;
  for d in select value from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) loop
    select * into f from pm.dlr_ro_findings x where x.org_id = e.org_id and x.estimate_id = e.id and x.id = pm.access_try_uuid(d ->> 'finding_id') for update;
    continue when f.id is null or f.status <> 'SENT';
    if upper(d ->> 'decision') = 'APPROVED' then
      v_appr := v_appr || f.line_ids;
      update pm.dlr_ro_findings set status = 'APPROVED', decided_at = now(), decided_by_name = p_name, decision_method = p_method where id = f.id;
    elsif upper(d ->> 'decision') = 'DECLINED' then
      v_decl := v_decl || f.line_ids;
      update pm.dlr_ro_findings set status = 'DECLINED', decided_at = now(), decided_by_name = p_name, decision_method = p_method where id = f.id;
    end if;
  end loop;
  -- the 1104 option decision, in place (this also runs from the e-sign settle trigger, where there is no member)
  update pm.work_order_lines set status = 'APPROVED', decided_at = now(), decided_by_name = left(p_name, 200)
   where org_id = e.org_id and work_order_id = e.work_order_id and status = 'PROPOSED' and id = any (v_appr);
  update pm.work_order_lines set status = 'DECLINED', decided_at = now(), decided_by_name = left(p_name, 200)
   where org_id = e.org_id and work_order_id = e.work_order_id and status = 'PROPOSED' and id = any (v_decl);
  select count(*) filter (where status = 'SENT'), count(*) filter (where status = 'APPROVED') into v_left, v_ok from pm.dlr_ro_findings where org_id = e.org_id and estimate_id = e.id;
  v_status := case when v_left > 0 then 'SENT' when v_ok = 0 then 'DECLINED'
                   when exists (select 1 from pm.dlr_ro_findings where org_id = e.org_id and estimate_id = e.id and status = 'DECLINED') then 'PARTIAL' else 'APPROVED' end;
  update pm.dlr_ro_estimates set status = v_status, decided_at = case when v_left = 0 then now() end where id = e.id;
  if v_left = 0 and exists (select 1 from pm.dlr_ro_state s where s.org_id = e.org_id and s.work_order_id = e.work_order_id and s.stage = 'WAITING_APPROVAL') then
    perform pm._d5_set_stage(e.work_order_id, 'IN_PROGRESS', false);
  end if;
  perform pm.log_activity(e.org_id, e.location_id, e.job_id, 'ro.estimate_decided', 'dlr_ro_estimates', e.id,
    format('Estimate %s: %s approved, %s declined (%s)', e.number, cardinality(v_appr), cardinality(v_decl), lower(p_method)), jsonb_build_object('by', p_name));
  return jsonb_build_object('estimate_id', e.id, 'status', v_status, 'approved_lines', cardinality(v_appr), 'declined_lines', cardinality(v_decl));
end $$;

create or replace function pm.dlr_decide_findings(p_estimate uuid, p_decisions jsonb, p_name text, p_method text default 'PHONE')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.dlr_ro_estimates%rowtype; v_m text := upper(coalesce(p_method, 'PHONE'));
begin
  select * into e from pm.dlr_ro_estimates x where x.id = p_estimate;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if v_m not in ('PHONE','IN_PERSON','PORTAL') then raise exception 'PM_INVALID: recorded decisions come by phone, in person or the portal' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'PM_INVALID: who approved?' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_decisions, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: decisions are a list' using errcode = '22023'; end if;
  return pm._d5_decide_findings(e.id, p_decisions, btrim(p_name), v_m);
end $$;

-- DLR-50: sublet work and rule-based shop supplies / environmental / disposal fees.
create table if not exists pm.dlr_shop_fee_rules (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  code             text not null check (code ~ '^[A-Z0-9_]{2,24}$'),
  label            text not null check (char_length(label) between 1 and 80),
  kind             text not null check (kind in ('SHOP_SUPPLIES','ENVIRONMENTAL','DISPOSAL','OTHER')),
  basis            text not null check (basis in ('PCT_LABOR','PCT_PARTS','FLAT')),
  pct              numeric(6,5) not null default 0 check (pct >= 0 and pct <= 1),
  amount_cents     bigint not null default 0 check (amount_cents >= 0),
  min_cents        bigint not null default 0 check (min_cents >= 0),
  cap_cents        bigint check (cap_cents is null or cap_cents >= 0),
  pay_types        text[] not null default '{CUSTOMER}',
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, code)
);

create table if not exists pm.dlr_ro_fee_lines (
  org_id         uuid not null references core.organizations(id) on delete cascade,
  work_order_id  uuid not null,
  rule_id        uuid not null,
  line_id        uuid not null,
  primary key (org_id, work_order_id, rule_id)
);

create table if not exists pm.dlr_ro_sublets (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  work_order_id    uuid not null,
  vendor_id        uuid not null references core.vendors(id),
  description      text not null check (char_length(description) between 1 and 300),
  po_ref           text,
  cost_cents       bigint not null check (cost_cents >= 0),
  price_cents      bigint not null check (price_cents >= 0),
  pay_type         text not null default 'CUSTOMER' check (pay_type in ('CUSTOMER','WARRANTY','INTERNAL','POLICY')),
  status           text not null default 'OPEN' check (status in ('OPEN','RECEIVED','BILLED','CANCELLED')),
  vendor_bill_ref  text,
  line_id          uuid,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_add_sublet(p_wo uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_vendor uuid := pm.access_try_uuid(a ->> 'vendor_id'); v_line uuid; v_id uuid; v_sort int;
        v_pay text := upper(coalesce(nullif(a ->> 'pay_type', ''), 'CUSTOMER'));
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  if v_vendor is null or not exists (select 1 from core.vendors v where v.id = v_vendor and v.org_id = w.org_id) then
    raise exception 'PM_UNKNOWN_VENDOR: pick the sublet vendor' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(a ->> 'description', '')), '') is null then raise exception 'PM_INVALID: describe the outside work' using errcode = '22023'; end if;
  if coalesce(pm._x_try_bigint(a ->> 'cost_cents'), -1) < 0 or coalesce(pm._x_try_bigint(a ->> 'price_cents'), -1) < 0 then
    raise exception 'PM_INVALID: sublet cost and price are ≥ 0' using errcode = '22023';
  end if;
  -- security review H3: selling outside work under its cost needs the member's below-cost allowance
  perform pm._d5_assert_price(w.location_id, (a ->> 'cost_cents')::bigint, (a ->> 'price_cents')::bigint, (a ->> 'cost_cents')::bigint, 'that sublet');
  select coalesce(max(l.sort), 0) + 1 into v_sort from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id;
  insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, unit_cost_cents, pay_type)
  values (w.org_id, w.job_id, w.id, v_sort, 'SUBLET', left('Sublet: ' || btrim(a ->> 'description'), 300), 1, (a ->> 'price_cents')::bigint, (a ->> 'cost_cents')::bigint, v_pay)
  returning id into v_line;
  insert into pm.dlr_ro_sublets (org_id, job_id, work_order_id, vendor_id, description, po_ref, cost_cents, price_cents, pay_type, line_id)
  values (w.org_id, w.job_id, w.id, v_vendor, btrim(a ->> 'description'), nullif(a ->> 'po_ref', ''), (a ->> 'cost_cents')::bigint, (a ->> 'price_cents')::bigint, v_pay, v_line)
  returning id into v_id;
  return jsonb_build_object('sublet_id', v_id, 'line_id', v_line);
end $$;

create or replace function pm.dlr_update_sublet(p_sublet uuid, p_status text, p_vendor_bill_ref text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_ro_sublets%rowtype; v_to text := upper(coalesce(p_status, ''));
begin
  select * into s from pm.dlr_ro_sublets x where x.id = p_sublet for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: sublet not found' using errcode = '42501'; end if;
  if v_to not in ('OPEN','RECEIVED','BILLED','CANCELLED') then raise exception 'PM_INVALID: status %', v_to using errcode = '22023'; end if;
  update pm.dlr_ro_sublets set status = v_to, vendor_bill_ref = coalesce(nullif(btrim(coalesce(p_vendor_bill_ref, '')), ''), vendor_bill_ref), updated_at = now() where id = s.id;
  if v_to = 'CANCELLED' and s.line_id is not null then
    delete from pm.work_order_lines where org_id = s.org_id and id = s.line_id
       and exists (select 1 from pm.work_orders w where w.id = s.work_order_id and w.status not in ('CLOSED','CANCELLED'));
  end if;
  return jsonb_build_object('sublet_id', s.id, 'status', v_to);
end $$;

-- Shop fees on one RO: % of labor / % of parts / flat, min and cap; one FEE line per rule, kept current.
create or replace function pm.dlr_apply_shop_fees(p_wo uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; r pm.dlr_shop_fee_rules%rowtype; v_base bigint; v_amt bigint; v_line uuid; v_out jsonb := '[]'; v_sort int;
begin
  select * into w from pm.work_orders q where q.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  -- rule-priced fee lines are a trusted pricer (the price guard's flag), never a member's discount
  perform set_config('pm.d5_price_trusted', 'on', true);
  for r in select * from pm.dlr_shop_fee_rules x where x.org_id = w.org_id and x.location_id = w.location_id and x.is_active order by x.code loop
    select coalesce(sum(l.amount_cents), 0) into v_base from pm.work_order_lines l
     where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED' and l.pay_type = any (r.pay_types)
       and l.kind = case r.basis when 'PCT_LABOR' then 'LABOR' when 'PCT_PARTS' then 'PART' else l.kind end
       and not exists (select 1 from pm.dlr_ro_fee_lines f where f.org_id = w.org_id and f.work_order_id = w.id and f.line_id = l.id);
    v_amt := case r.basis when 'FLAT' then r.amount_cents else pm.fs_rdiv(v_base * r.pct, 1) end;
    if r.basis <> 'FLAT' and v_base = 0 then v_amt := 0; else v_amt := greatest(v_amt, r.min_cents); end if;
    if r.cap_cents is not null then v_amt := least(v_amt, r.cap_cents); end if;
    select f.line_id into v_line from pm.dlr_ro_fee_lines f where f.org_id = w.org_id and f.work_order_id = w.id and f.rule_id = r.id;
    if v_amt = 0 then
      if v_line is not null then
        delete from pm.work_order_lines where org_id = w.org_id and id = v_line;
        delete from pm.dlr_ro_fee_lines where org_id = w.org_id and work_order_id = w.id and rule_id = r.id;
      end if;
      continue;
    end if;
    if v_line is null then
      select coalesce(max(l.sort), 0) + 1 into v_sort from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id;
      insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, pay_type)
      values (w.org_id, w.job_id, w.id, v_sort, 'FEE', r.label, 1, v_amt, r.pay_types[1]) returning id into v_line;
      insert into pm.dlr_ro_fee_lines (org_id, work_order_id, rule_id, line_id) values (w.org_id, w.id, r.id, v_line);
    else
      update pm.work_order_lines set unit_price_cents = v_amt, updated_at = now() where org_id = w.org_id and id = v_line;
    end if;
    v_out := v_out || jsonb_build_object('code', r.code, 'label', r.label, 'amount_cents', v_amt, 'line_id', v_line);
  end loop;
  perform set_config('pm.d5_price_trusted', '', true);
  return jsonb_build_object('work_order_id', w.id, 'fees', v_out);
end $$;

-- DLR-52: what blocks or warns before close.
create or replace function pm.dlr_ro_close_check(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_set jsonb; v_block jsonb := '[]'; v_warn jsonb := '[]'; n int; v_txt text;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  v_set := pm._d5_set(w.org_id, w.location_id);
  if coalesce((v_set ->> 'internal_route_required')::boolean, true) then
    select count(*) into n from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.pay_type in ('INTERNAL','POLICY') and l.internal_route is null and l.status = 'APPROVED';
    if n > 0 then v_block := v_block || jsonb_build_object('code', 'INTERNAL_ROUTE', 'message', format('%s internal line(s) need a route (PDI, recon, rental, shop or policy)', n)); end if;
  end if;
  if coalesce((v_set ->> 'qc_required')::boolean, true) and w.kind = 'REPAIR_ORDER'
     and not exists (select 1 from pm.dlr_ro_state s where s.org_id = w.org_id and s.work_order_id = w.id and s.qc_passed_at is not null) then
    v_block := v_block || jsonb_build_object('code', 'QC', 'message', 'The QC check has not been passed');
  end if;
  select count(*) into n from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'PROPOSED';
  if n > 0 then v_block := v_block || jsonb_build_object('code', 'UNDECIDED', 'message', format('%s proposed line(s) are waiting on the customer', n)); end if;
  select count(*) into n from pm.dlr_tech_punches p where p.org_id = w.org_id and p.work_order_id = w.id and p.ended_at is null;
  if n > 0 then v_block := v_block || jsonb_build_object('code', 'CLOCKED_ON', 'message', format('%s technician(s) are still clocked on', n)); end if;
  -- parts pulled to the RO but not on a billed line
  select string_agg(format('%s × %s', x.missing, x.part_number), ', ') into v_txt from (
    select p.part_number, sum(m.qty) - coalesce((select sum(l.qty) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id
                                                  and l.kind = 'PART' and l.status = 'APPROVED' and l.part_id = p.id), 0) as missing
      from pm.material_moves m join pm.parts p on p.org_id = m.org_id and p.item_id = m.item_id and p.location_id = w.location_id
     where m.org_id = w.org_id and m.work_order_id = w.id and m.kind = 'ISSUE'
     group by p.id, p.part_number) x where x.missing > 0;
  if v_txt is not null then v_warn := v_warn || jsonb_build_object('code', 'PARTS_NOT_BILLED', 'message', 'Parts pulled but not on the RO: ' || v_txt); end if;
  select count(*) into n from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.kind = 'LABOR' and l.status = 'APPROVED'
     and l.pay_type = 'CUSTOMER' and coalesce(l.flag_hours, 0) = 0 and coalesce(l.unit_price_cents, 0) = 0;
  if n > 0 then v_warn := v_warn || jsonb_build_object('code', 'LABOR_UNPRICED', 'message', format('%s customer labor line(s) have no hours or price', n)); end if;
  select count(*) into n from pm.dlr_tech_punches p where p.org_id = w.org_id and p.work_order_id = w.id and p.kind = 'LINE'
     and not exists (select 1 from pm.work_order_lines l where l.id = p.work_order_line_id and l.kind = 'LABOR');
  if n > 0 then v_warn := v_warn || jsonb_build_object('code', 'TIME_NO_LABOR', 'message', 'Clocked time on lines with no labor charge'); end if;
  select count(*) into n from pm.dlr_ro_sublets s where s.org_id = w.org_id and s.work_order_id = w.id and s.status = 'OPEN';
  if n > 0 then v_warn := v_warn || jsonb_build_object('code', 'SUBLET_OPEN', 'message', format('%s sublet job(s) not back from the vendor', n)); end if;
  return jsonb_build_object('work_order_id', w.id, 'status', w.status, 'blockers', v_block, 'warnings', v_warn, 'can_close', jsonb_array_length(v_block) = 0 and w.status not in ('CLOSED','CANCELLED'));
end $$;

create or replace function pm.dlr_qc_signoff(p_wo uuid, p_checklist jsonb, p_passed boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; r jsonb;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_checklist, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: the QC list is a list' using errcode = '22023'; end if;
  if p_passed and exists (select 1 from jsonb_array_elements(coalesce(p_checklist, '[]'::jsonb)) x where coalesce((x ->> 'ok')::boolean, true) = false) then
    raise exception 'PM_INVALID: an item failed QC; fix it or record QC as failed' using errcode = '22023';
  end if;
  insert into pm.dlr_ro_state as s (org_id, work_order_id, job_id, location_id, stage, qc_passed_at, qc_by, qc_checklist, updated_by)
  values (w.org_id, w.id, w.job_id, w.location_id, case when p_passed then 'QC' else 'IN_PROGRESS' end, case when p_passed then now() end,
          pm.current_user_id(), coalesce(p_checklist, '[]'::jsonb), pm.current_user_id())
  on conflict (org_id, work_order_id) do update set qc_passed_at = case when p_passed then now() end, qc_by = excluded.qc_by,
    qc_checklist = excluded.qc_checklist, stage = case when p_passed then s.stage else 'IN_PROGRESS' end, updated_by = excluded.updated_by;
  if p_passed then r := pm._d5_set_stage(w.id, 'READY', true); end if;
  return jsonb_build_object('work_order_id', w.id, 'passed', p_passed, 'text', r -> 'text');
end $$;

-- Close: blockers stop it; the RO completes (when it is not yet) and closes (1109's trigger emits
-- DEALER_RO_CLOSED with the split by pay type; Books invoices each payer).
create or replace function pm.dlr_close_ro(p_wo uuid, p_outcome text default 'FIXED')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; chk jsonb;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  chk := pm.dlr_ro_close_check(w.id);
  if jsonb_array_length(chk -> 'blockers') > 0 then
    raise exception 'PM_RO_NOT_READY: %', (select string_agg(x ->> 'message', '; ') from jsonb_array_elements(chk -> 'blockers') x) using errcode = '22023';
  end if;
  if w.status not in ('COMPLETE','CLOSED') then
    perform pm.complete_work_order(w.id, upper(coalesce(p_outcome, 'FIXED')));
  end if;
  if (select status from pm.work_orders where id = w.id) <> 'CLOSED' then perform pm.close_work_order(w.id); end if;
  return jsonb_build_object('work_order_id', w.id, 'status', (select status from pm.work_orders where id = w.id), 'warnings', chk -> 'warnings');
end $$;

-- The Books invoice behind a closed RO (DEALER_RO_CLOSED ack) and its public pay token (Books 176).
create or replace function pm.dlr_ro_invoice(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; o pm.dealer_outbox%rowtype; v_tok text; v_bal bigint; v_num text; v_status text;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  select * into o from pm.dealer_outbox x where x.org_id = w.org_id and x.event_type = 'DEALER_RO_CLOSED' and x.subject_table = 'work_orders' and x.subject_id = w.id
   order by x.created_at desc limit 1;
  if o.id is null then return jsonb_build_object('available', false, 'reason', case when w.status = 'CLOSED' then 'Books has not received this RO yet' else 'Close the RO first' end); end if;
  if o.invoice_id is null or to_regclass('public.invoices') is null then
    return jsonb_build_object('available', false, 'reason', case o.status when 'HELD' then 'Held until Books is connected for the store' when 'REJECTED' then coalesce(o.error_text, 'Books rejected the RO')
                                                                          else 'Books has not issued the invoice yet' end, 'seam_status', o.status);
  end if;
  execute 'select i.public_token::text, i.balance_cents, i.invoice_number, i.status from public.invoices i where i.org_id = $1 and i.id = $2'
    into v_tok, v_bal, v_num, v_status using w.org_id, o.invoice_id;
  return jsonb_build_object('available', v_tok is not null, 'invoice_id', o.invoice_id, 'invoice_number', coalesce(v_num, o.invoice_number), 'status', v_status,
                            'balance_cents', v_bal, 'pay_token', v_tok);
end $$;

-- Text-to-pay: the link is <Books origin>/pay/<token>. Security review L1 / R8: the origin is the
-- platform's allowlisted Books URL (pm._fs_app_url, service-only pm.fs_platform_settings whose check
-- constraint is the allowlist https://(books|projects).meritmgt.com) — never a parameter or store setting.
drop function if exists pm.dlr_text_pay_link(uuid, text);
create or replace function pm.dlr_text_pay_link(p_wo uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; inv jsonb; v_cust uuid; p_books_origin text;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  p_books_origin := pm._fs_app_url('books');
  if coalesce(p_books_origin, '') !~ '^https://(books|projects)\.meritmgt\.com$' then
    raise exception 'PM_INVALID: the Books payment address is not configured' using errcode = '22023';
  end if;
  inv := pm.dlr_ro_invoice(w.id);
  if not coalesce((inv ->> 'available')::boolean, false) then raise exception 'PM_INVALID: %', coalesce(inv ->> 'reason', 'no invoice yet') using errcode = '22023'; end if;
  select coalesce(j.customer_id, a.customer_id) into v_cust from core.jobs j left join pm.assets a on a.org_id = w.org_id and a.id = w.asset_id where j.id = w.job_id;
  return pm._d5_text(w.org_id, w.location_id, w.job_id, v_cust, 'PAY_LINK', 'work_orders', w.id,
    format('%s: invoice %s for RO %s is %s. Pay securely here: %s/pay/%s', pm._d5_company_name(w.location_id), inv ->> 'invoice_number', w.number,
           '$' || to_char(coalesce((inv ->> 'balance_cents')::bigint, 0) / 100.0, 'FM999,999,990.00'), p_books_origin, inv ->> 'pay_token'),
    'ro:' || w.id::text || ':pay:' || (inv ->> 'invoice_id'), w.id);
end $$;

create or replace function pm.dlr_record_pickup(p_wo uuid, p_signer text, p_document uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_signer, '')), '') is null then raise exception 'PM_INVALID: who picked it up?' using errcode = '22023'; end if;
  perform pm._d5_set_stage(w.id, 'PICKED_UP', false);
  update pm.dlr_ro_state set picked_up_at = now(), pickup_signer = btrim(p_signer), pickup_document_id = pm._d5_claim_doc(w.org_id, w.job_id, p_document, 'pickup signature')
   where org_id = w.org_id and work_order_id = w.id;
  return jsonb_build_object('work_order_id', w.id, 'picked_up', true);
end $$;

-- Units ready but not picked up: storage accrues after the free days; lien-notice date per store rule.
create or replace function pm.dlr_storage_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_set jsonb; v_free int; v_daily bigint; v_lien int;
begin
  v_set := pm._d5_set(v_org, p_location);
  v_free := coalesce((v_set ->> 'storage_free_days')::int, 3); v_daily := coalesce((v_set ->> 'storage_daily_cents')::bigint, 0); v_lien := coalesce((v_set ->> 'lien_notice_days')::int, 30);
  return coalesce((select jsonb_agg(jsonb_build_object('work_order_id', w.id, 'number', w.number, 'unit', pm._d5_unit_label(w.asset_id),
      'customer', (select c.name from core.customers c where c.id = j.customer_id), 'ready_at', s.ready_at, 'days_waiting', current_date - s.ready_at::date,
      'billable_days', greatest(current_date - s.ready_at::date - v_free, 0), 'storage_cents', greatest(current_date - s.ready_at::date - v_free, 0) * v_daily,
      'lien_notice_on', (s.ready_at::date + v_lien), 'lien_notice_due', current_date >= s.ready_at::date + v_lien, 'ro_status', w.status) order by s.ready_at)
    from pm.dlr_ro_state s join pm.work_orders w on w.org_id = s.org_id and w.id = s.work_order_id join core.jobs j on j.id = w.job_id
   where s.org_id = v_org and s.location_id = p_location and s.stage = 'READY' and s.ready_at < now() - make_interval(days => v_free)), '[]'::jsonb);
end $$;

-- Put the accrued storage on the RO as a FEE line before it closes.
create or replace function pm.dlr_add_storage_fee(p_wo uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_row jsonb; v_amt bigint; v_line uuid; v_sort int;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, w.status using errcode = '55000'; end if;
  select x into v_row from jsonb_array_elements(pm.dlr_storage_board(w.location_id)) x where x ->> 'work_order_id' = w.id::text;
  v_amt := coalesce((v_row ->> 'storage_cents')::bigint, 0);
  if v_amt <= 0 then raise exception 'PM_INVALID: no storage has accrued on this RO' using errcode = '22023'; end if;
  select l.id into v_line from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.kind = 'FEE' and l.description like 'Storage%' limit 1;
  if v_line is null then
    select coalesce(max(l.sort), 0) + 1 into v_sort from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, pay_type)
    values (w.org_id, w.job_id, w.id, v_sort, 'FEE', format('Storage (%s day(s))', v_row ->> 'billable_days'), 1, v_amt, 'CUSTOMER') returning id into v_line;
  else
    update pm.work_order_lines set unit_price_cents = v_amt, description = format('Storage (%s day(s))', v_row ->> 'billable_days'), updated_at = now() where id = v_line;
  end if;
  return jsonb_build_object('line_id', v_line, 'amount_cents', v_amt);
end $$;

-- DLR-57: open ROs with labor (hours; cost with financials) and parts at cost, days open, and the ROs
-- that must close before the month-end cutoff (ready / complete, or promised by the cutoff).
create or replace function pm.dlr_wip_report(p_location uuid, p_cutoff date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean := pm._x_sees('projects.financials', 'view', p_location);
        v_cut date := coalesce(p_cutoff, (date_trunc('month', current_date) + interval '1 month - 1 day')::date); v_rows jsonb;
begin
  select coalesce(jsonb_agg(r order by (r ->> 'days_open')::int desc), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('work_order_id', w.id, 'number', w.number, 'kind', w.kind, 'status', w.status, 'stage', s.stage, 'payer_type', w.payer_type,
      'unit', pm._d5_unit_label(w.asset_id), 'customer', (select c.name from core.customers c where c.id = j.customer_id),
      'opened', coalesce(w.checked_in_at, w.created_at), 'days_open', current_date - coalesce(w.checked_in_at, w.created_at)::date, 'promised_on', w.promised_on,
      'clocked_hours', round(coalesce((select sum(extract(epoch from (coalesce(p.ended_at, now()) - p.started_at)) / 3600.0) from pm.dlr_tech_punches p
                                        where p.org_id = w.org_id and p.work_order_id = w.id and p.kind = 'LINE'), 0)::numeric, 2),
      'flag_hours', (select coalesce(sum(l.flag_hours), 0) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED'),
      'labor_cost_cents', case when v_fin then (select coalesce(sum(round(t.hours * coalesce(t.cost_rate_cents, 0))), 0)::bigint from pm.time_entries t
                                                 where t.org_id = w.org_id and t.work_order_id = w.id) end,
      'parts_cost_cents', case when v_fin then (select coalesce(sum(round(m.qty * coalesce(p.cost_cents, 0))), 0)::bigint from pm.material_moves m
                                                 join pm.parts p on p.org_id = m.org_id and p.item_id = m.item_id and p.location_id = w.location_id
                                                 where m.org_id = w.org_id and m.work_order_id = w.id and m.kind = 'ISSUE') end,
      'sublet_cost_cents', case when v_fin then (select coalesce(sum(x.cost_cents), 0) from pm.dlr_ro_sublets x where x.org_id = w.org_id and x.work_order_id = w.id and x.status <> 'CANCELLED') end,
      'sell_cents', (select coalesce(sum(l.amount_cents), 0) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.status = 'APPROVED'),
      'must_close', w.status = 'COMPLETE' or s.stage in ('READY','QC','PICKED_UP') or (w.promised_on is not null and w.promised_on <= v_cut)) as r
      from pm.work_orders w join core.jobs j on j.id = w.job_id
      left join pm.dlr_ro_state s on s.org_id = w.org_id and s.work_order_id = w.id
     where w.org_id = v_org and w.location_id = p_location and w.kind in ('REPAIR_ORDER','PDI') and w.status not in ('CLOSED','CANCELLED')) q;
  return jsonb_build_object('cutoff', v_cut, 'rows', v_rows, 'open', jsonb_array_length(v_rows),
    'must_close', (select count(*) from jsonb_array_elements(v_rows) x where (x ->> 'must_close')::boolean),
    'labor_cost_cents', case when v_fin then (select coalesce(sum((x ->> 'labor_cost_cents')::bigint), 0) from jsonb_array_elements(v_rows) x) end,
    'parts_cost_cents', case when v_fin then (select coalesce(sum((x ->> 'parts_cost_cents')::bigint), 0) from jsonb_array_elements(v_rows) x) end,
    'amounts_visible', v_fin);
end $$;

-- The service desk: one board of open ROs with stage, check-in, findings, estimate state, texts.
create or replace function pm.dlr_service_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('work_order_id', w.id, 'number', w.number, 'status', w.status, 'stage', coalesce(s.stage, 'CHECKED_IN'),
      'stage_at', s.stage_at, 'unit', pm._d5_unit_label(w.asset_id), 'asset_id', w.asset_id, 'customer', (select c.name from core.customers c where c.id = j.customer_id),
      'customer_id', j.customer_id, 'summary', w.summary, 'promised_on', w.promised_on, 'checked_in_at', w.checked_in_at, 'qc_passed', s.qc_passed_at is not null,
      'tag', ck.tag_number, 'signed', ck.signed_at is not null, 'signature_method', ck.signature_method,
      'findings_draft', (select count(*) from pm.dlr_ro_findings f where f.org_id = w.org_id and f.work_order_id = w.id and f.status = 'DRAFT'),
      'awaiting_approval', (select count(*) from pm.dlr_ro_findings f where f.org_id = w.org_id and f.work_order_id = w.id and f.status = 'SENT'),
      'last_text', (select jsonb_build_object('status', t.status, 'at', t.created_at, 'kind', t.kind) from pm.dlr_customer_texts t
                     where t.org_id = w.org_id and t.work_order_id = w.id order by t.created_at desc limit 1),
      'days_open', current_date - coalesce(w.checked_in_at, w.created_at)::date) order by w.promised_on nulls last, w.created_at)
    from pm.work_orders w join core.jobs j on j.id = w.job_id
    left join pm.dlr_ro_state s on s.org_id = w.org_id and s.work_order_id = w.id
    left join pm.dlr_ro_checkins ck on ck.org_id = w.org_id and ck.work_order_id = w.id
   where w.org_id = v_org and w.location_id = p_location and w.kind = 'REPAIR_ORDER'
     and (w.status not in ('CLOSED','CANCELLED') or (s.stage = 'READY' and s.picked_up_at is null))), '[]'::jsonb);
end $$;

-- One RO's desk detail (check-in, findings, estimates, stage, sublets, fee lines, close check).
create or replace function pm.dlr_ro_desk(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_fin boolean;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: RO not found' using errcode = '42501'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', w.location_id, w.job_id);
  return jsonb_build_object('work_order_id', w.id, 'number', w.number, 'status', w.status, 'job_id', w.job_id, 'location_id', w.location_id, 'unit', pm._d5_unit_label(w.asset_id),
    'state', (select to_jsonb(s) - 'org_id' from pm.dlr_ro_state s where s.org_id = w.org_id and s.work_order_id = w.id),
    'checkin', (select to_jsonb(c) - 'org_id' - 'photo_document_ids' || jsonb_build_object('photos', cardinality(c.photo_document_ids)) from pm.dlr_ro_checkins c where c.org_id = w.org_id and c.work_order_id = w.id),
    'findings', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'description', f.description, 'tech_note', f.tech_note, 'labor_hours', f.labor_hours,
        'amount_cents', f.amount_cents, 'parts', f.parts, 'status', f.status, 'estimate_id', f.estimate_id, 'photos', cardinality(f.photo_document_ids),
        'photo_document_ids', to_jsonb(f.photo_document_ids), 'decided_at', f.decided_at, 'decided_by_name', f.decided_by_name, 'decision_method', f.decision_method) order by f.created_at)
      from pm.dlr_ro_findings f where f.org_id = w.org_id and f.work_order_id = w.id and f.status <> 'VOID'), '[]'::jsonb),
    'estimates', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'number', e.number, 'status', e.status, 'total_cents', e.total_cents, 'envelope_id', e.envelope_id,
        'sent_at', e.sent_at, 'decided_at', e.decided_at) order by e.sent_at desc) from pm.dlr_ro_estimates e where e.org_id = w.org_id and e.work_order_id = w.id), '[]'::jsonb),
    'sublets', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'vendor', (select v.name from core.vendors v where v.id = s.vendor_id), 'description', s.description,
        'status', s.status, 'price_cents', s.price_cents, 'cost_cents', case when v_fin then s.cost_cents end, 'vendor_bill_ref', s.vendor_bill_ref) order by s.created_at)
      from pm.dlr_ro_sublets s where s.org_id = w.org_id and s.work_order_id = w.id), '[]'::jsonb),
    'internal_lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'description', l.description, 'pay_type', l.pay_type, 'internal_route', l.internal_route,
        'internal_asset_id', l.internal_asset_id) order by l.sort) from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id and l.pay_type in ('INTERNAL','POLICY')), '[]'::jsonb),
    'texts', coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'status', t.status, 'reason', t.reason, 'body', t.body, 'at', t.created_at) order by t.created_at desc)
      from pm.dlr_customer_texts t where t.org_id = w.org_id and t.work_order_id = w.id), '[]'::jsonb),
    'close_check', pm.dlr_ro_close_check(w.id), 'amounts_visible', v_fin);
end $$;

-- ----------------------------------------------------------------------------
-- D9. Rentals: rate cards (DLR-63), availability + blocks (DLR-64), paperwork (DLR-65), damage RO
--     (DLR-66), cycle billing (DLR-67), fleet maintenance + re-rent holds (DLR-68)
-- ----------------------------------------------------------------------------
create table if not exists pm.dlr_rental_rate_ext (
  rate_id           uuid primary key,
  org_id            uuid not null references core.organizations(id) on delete cascade,
  hour_cents        bigint check (hour_cents is null or hour_cents >= 0),
  half_day_cents    bigint check (half_day_cents is null or half_day_cents >= 0),   -- up to 4 hours
  min_hours         numeric(6,2) check (min_hours is null or min_hours >= 0),
  min_charge_cents  bigint check (min_charge_cents is null or min_charge_cents >= 0),
  accessories       jsonb not null default '[]' check (jsonb_typeof(accessories) = 'array'),   -- [{code, label, day_cents}]
  fuel_rule         text not null default 'FULL_TO_FULL' check (fuel_rule in ('FULL_TO_FULL','PREPAID','METERED')),
  cleaning_cents    bigint check (cleaning_cents is null or cleaning_cents >= 0),
  rental_class      text,
  notes             text,
  updated_at        timestamptz not null default now(),
  unique (org_id, rate_id),
  foreign key (org_id, rate_id) references pm.rental_rates (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_set_rate_ext(p_rate uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.rental_rates%rowtype; a jsonb := coalesce(p_attrs, '{}');
begin
  select * into r from pm.rental_rates x where x.id = p_rate;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: rate not found' using errcode = '42501'; end if;
  if a ? 'accessories' and jsonb_typeof(a -> 'accessories') <> 'array' then raise exception 'PM_INVALID: accessories are a list' using errcode = '22023'; end if;
  insert into pm.dlr_rental_rate_ext as e (rate_id, org_id, hour_cents, half_day_cents, min_hours, min_charge_cents, accessories, fuel_rule, cleaning_cents, rental_class, notes)
  values (r.id, r.org_id, pm._x_try_bigint(a ->> 'hour_cents'), pm._x_try_bigint(a ->> 'half_day_cents'), pm._x_try_num(a ->> 'min_hours'),
          pm._x_try_bigint(a ->> 'min_charge_cents'), coalesce(a -> 'accessories', '[]'::jsonb), upper(coalesce(nullif(a ->> 'fuel_rule', ''), 'FULL_TO_FULL')),
          pm._x_try_bigint(a ->> 'cleaning_cents'), nullif(a ->> 'rental_class', ''), nullif(a ->> 'notes', ''))
  on conflict (rate_id) do update set hour_cents = excluded.hour_cents, half_day_cents = excluded.half_day_cents, min_hours = excluded.min_hours,
    min_charge_cents = excluded.min_charge_cents, accessories = excluded.accessories, fuel_rule = excluded.fuel_rule, cleaning_cents = excluded.cleaning_cents,
    rental_class = excluded.rental_class, notes = excluded.notes, updated_at = now();
  return jsonb_build_object('rate_id', r.id);
end $$;

-- The charge for a window: under a day it is the best of hours (min hours), half-day (≤ 4 h) and a day;
-- a day or more is 1109's pm.rental_charge (months / weeks / days, best combination). Accessories at their
-- day rate × billed days; the minimum charge applies last. Mirrored by lib/dealer/rental.ts (parity test).
create or replace function pm._d5_rental_quote(p_day bigint, p_week bigint, p_month bigint, p_hour bigint, p_half bigint, p_min_hours numeric,
                                                p_min_charge bigint, p_acc_day bigint, p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql immutable
as $$
declare v_hrs numeric; v_rent bigint; v_basis text; v_days int; v_ch jsonb; v_hourly bigint; v_cands bigint[];
begin
  if p_end <= p_start then return jsonb_build_object('rental_cents', 0, 'accessories_cents', 0, 'total_cents', 0, 'basis', 'NONE'); end if;
  v_hrs := ceil(extract(epoch from (p_end - p_start)) / 3600.0 - 0.0001);
  if v_hrs <= 24 and (p_hour is not null or p_half is not null) then
    v_hourly := case when p_hour is not null then greatest(v_hrs, coalesce(p_min_hours, 0))::bigint * p_hour end;
    v_rent := null; v_basis := null;
    if v_hourly is not null then v_rent := v_hourly; v_basis := 'HOURS'; end if;
    if p_half is not null and v_hrs <= 4 and (v_rent is null or p_half < v_rent) then v_rent := p_half; v_basis := 'HALF_DAY'; end if;
    if p_day is not null and (v_rent is null or p_day < v_rent) then v_rent := p_day; v_basis := 'DAY'; end if;
    v_days := 1;
  else
    v_ch := pm.rental_charge(p_day, p_week, p_month, p_start, p_end);
    v_rent := (v_ch ->> 'rental_cents')::bigint; v_basis := 'DAYS'; v_days := (v_ch ->> 'days')::int;
  end if;
  v_rent := greatest(coalesce(v_rent, 0), coalesce(p_min_charge, 0));
  return jsonb_build_object('hours', v_hrs, 'days', v_days, 'basis', v_basis, 'rental_cents', v_rent, 'accessories_cents', coalesce(p_acc_day, 0) * v_days,
                            'total_cents', v_rent + coalesce(p_acc_day, 0) * v_days, 'breakdown', v_ch);
end $$;

create or replace function pm.dlr_rental_quote(p_unit uuid, p_start timestamptz, p_end timestamptz, p_accessories text[] default '{}')
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; rt pm.rental_rates%rowtype; e pm.dlr_rental_rate_ext%rowtype; v_acc bigint := 0;
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  rt := pm.dealer_rental_rate(a.id);
  if rt.id is null then raise exception 'PM_NO_RENTAL_RATE: no rental rate covers this unit' using errcode = 'P0002'; end if;
  select * into e from pm.dlr_rental_rate_ext x where x.org_id = a.org_id and x.rate_id = rt.id;
  select coalesce(sum((x ->> 'day_cents')::bigint), 0) into v_acc from jsonb_array_elements(coalesce(e.accessories, '[]'::jsonb)) x where x ->> 'code' = any (coalesce(p_accessories, '{}'));
  return pm._d5_rental_quote(rt.day_cents, rt.week_cents, rt.month_cents, e.hour_cents, e.half_day_cents, e.min_hours, e.min_charge_cents, v_acc, p_start, p_end)
         || jsonb_build_object('rate_id', rt.id, 'rate_label', rt.label, 'damage_waiver_pct', rt.damage_waiver_pct, 'fuel_rule', coalesce(e.fuel_rule, 'FULL_TO_FULL'),
                               'accessories', coalesce(e.accessories, '[]'::jsonb));
end $$;

-- Maintenance / down / hold blocks. A block refuses any reservation or check-out that overlaps it.
create table if not exists pm.dlr_rental_blocks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  asset_id       uuid not null,
  kind           text not null check (kind in ('MAINTENANCE','DOWN','HOLD')),
  period         tstzrange not null check (not isempty(period) and not lower_inf(period) and not upper_inf(period)),
  reason         text,
  work_order_id  uuid,
  rule_id        uuid,
  released_at    timestamptz,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate,
  constraint dlr_rental_blocks_no_overlap exclude using gist (org_id with =, asset_id with =, period with &&) where (released_at is null)
);

create or replace function pm.tg_d5_rental_block_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.dlr_rental_blocks%rowtype;
begin
  if new.status in ('RESERVED','OUT') then
    select * into b from pm.dlr_rental_blocks x
     where x.org_id = new.org_id and x.asset_id = new.asset_id and x.released_at is null and x.period && new.reserved limit 1;
    if b.id is not null then
      raise exception 'PM_RENTAL_BLOCKED: the unit is blocked for % from % to %', lower(b.kind), to_char(lower(b.period), 'YYYY-MM-DD HH24:MI'),
        to_char(upper(b.period), 'YYYY-MM-DD HH24:MI') using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_rental_block_guard on pm.rental_contracts;
create trigger trg_d5_rental_block_guard before insert or update of reserved, status on pm.rental_contracts for each row execute function pm.tg_d5_rental_block_guard();

create or replace function pm.dlr_block_rental_unit(p_unit uuid, p_kind text, p_from timestamptz, p_to timestamptz, p_reason text default null, p_wo uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_id uuid; v_kind text := upper(coalesce(p_kind, 'MAINTENANCE'));
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  if v_kind not in ('MAINTENANCE','DOWN','HOLD') then raise exception 'PM_INVALID: block kind %', v_kind using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_to <= p_from then raise exception 'PM_INVALID: the block needs a start before its end' using errcode = '22023'; end if;
  if exists (select 1 from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id and r.status in ('RESERVED','OUT') and r.reserved && tstzrange(p_from, p_to, '[)')) then
    raise exception 'PM_RENTAL_OVERLAP: the unit is reserved or out in that window; move the reservation first' using errcode = '23P01';
  end if;
  begin
    insert into pm.dlr_rental_blocks (org_id, location_id, asset_id, kind, period, reason, work_order_id)
    values (a.org_id, a.location_id, a.id, v_kind, tstzrange(p_from, p_to, '[)'), nullif(btrim(coalesce(p_reason, '')), ''), p_wo) returning id into v_id;
  exception when exclusion_violation then
    raise exception 'PM_RENTAL_OVERLAP: the unit is already blocked in that window' using errcode = '23P01';
  end;
  return v_id;
end $$;

create or replace function pm.dlr_release_block(p_block uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.dlr_rental_blocks%rowtype;
begin
  select * into b from pm.dlr_rental_blocks x where x.id = p_block for update;
  if b.org_id is null or b.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: block not found' using errcode = '42501'; end if;
  update pm.dlr_rental_blocks set released_at = now() where id = b.id and released_at is null;
  return jsonb_build_object('block_id', b.id, 'released', true);
end $$;

-- Availability by class across the stores the caller can see: each fleet unit, its conflicts in the
-- window, and whether it is free. Overbooking shows as a class with more wanted than free.
create or replace function pm.dlr_rental_availability(p_location uuid, p_category text, p_from timestamptz, p_to timestamptz, p_all_stores boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_win tstzrange; v_units jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from then raise exception 'PM_INVALID: pick a start before the end' using errcode = '22023'; end if;
  v_win := tstzrange(p_from, p_to, '[)');
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', a.id, 'unit', pm._d5_unit_label(a.id), 'category', a.category, 'model', a.model, 'store', l.name, 'location_id', a.location_id,
           'meter', a.meter_reading, 'free', c.n = 0 and b.n = 0 and h.n = 0, 'contracts', c.list, 'blocks', b.list, 're_rent_hold', h.n > 0)
           order by (c.n = 0 and b.n = 0 and h.n = 0) desc, (a.location_id = p_location) desc, a.stock_number), '[]'::jsonb)
    into v_units
    from pm.assets a join core.locations l on l.id = a.location_id
    cross join lateral (select count(*) as n, coalesce(jsonb_agg(jsonb_build_object('number', r.number, 'status', r.status, 'from', lower(r.reserved), 'to', upper(r.reserved))), '[]'::jsonb) as list
                          from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id and r.status in ('RESERVED','OUT') and r.reserved && v_win) c
    cross join lateral (select count(*) as n, coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'from', lower(x.period), 'to', upper(x.period), 'reason', x.reason)), '[]'::jsonb) as list
                          from pm.dlr_rental_blocks x where x.org_id = a.org_id and x.asset_id = a.id and x.released_at is null and x.period && v_win) b
    cross join lateral (select count(*) as n from pm.dlr_rerent_holds hh where hh.org_id = a.org_id and hh.asset_id = a.id and hh.status = 'OPEN') h
   where a.org_id = v_org and a.unit_status = 'RENTAL'
     and (p_category is null or a.category = p_category)
     and (a.location_id = p_location or (p_all_stores and a.location_id in (select pm.my_location_ids('projects.store', 'view'))));
  return jsonb_build_object('from', p_from, 'to', p_to, 'category', p_category, 'units', v_units,
    'free', (select count(*) from jsonb_array_elements(v_units) x where (x ->> 'free')::boolean),
    'total', jsonb_array_length(v_units));
end $$;

-- A booked unit that went down: free units of the same class at this or another store for the contract's window.
create or replace function pm.dlr_rental_substitutes(p_contract uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; a pm.assets%rowtype; v jsonb;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: rental contract not found' using errcode = '42501'; end if;
  select * into a from pm.assets x where x.id = c.asset_id;
  v := pm.dlr_rental_availability(c.location_id, a.category, lower(c.reserved), upper(c.reserved), true);
  return jsonb_build_object('contract_id', c.id, 'category', a.category,
    'substitutes', coalesce((select jsonb_agg(x) from jsonb_array_elements(v -> 'units') x where (x ->> 'free')::boolean and x ->> 'unit_id' <> c.asset_id::text), '[]'::jsonb));
end $$;

-- DLR-65 contract-out paperwork. The store chooses which items are required (rental_out_requires).
create table if not exists pm.dlr_rental_paperwork (
  contract_id            uuid primary key,
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  license_document_id    uuid,
  license_last4          text check (license_last4 is null or license_last4 ~ '^[A-Za-z0-9]{2,4}$'),
  license_state          text check (license_state is null or license_state ~ '^[A-Z]{2}$'),
  license_expires_on     date,
  coi_document_id        uuid,
  coi_expires_on         date,
  card_hold_ref          text,
  card_hold_cents        bigint check (card_hold_cents is null or card_hold_cents >= 0),
  waiver_choice          text check (waiver_choice is null or waiver_choice in ('ACCEPTED','DECLINED')),
  safety_briefed_at      timestamptz,
  safety_briefed_by      text,
  signer_name            text,
  signature_document_id  uuid,
  envelope_id            uuid,
  signed_at              timestamptz,
  updated_by             text,
  updated_at             timestamptz not null default now(),
  unique (org_id, contract_id),
  foreign key (org_id, contract_id) references pm.rental_contracts (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_set_rental_paperwork(p_contract uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; a jsonb := coalesce(p_attrs, '{}');
begin
  select * into c from pm.rental_contracts x where x.id = p_contract;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: rental contract not found' using errcode = '42501'; end if;
  if c.status not in ('RESERVED','OUT') then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  if pm._x_try_date(a ->> 'license_expires_on') < current_date then raise exception 'PM_INVALID: that license is expired' using errcode = '22023'; end if;
  if pm._x_try_date(a ->> 'coi_expires_on') < current_date then raise exception 'PM_INVALID: that insurance certificate is expired' using errcode = '22023'; end if;
  -- security review M5 / R11: every file is tied to THIS contract (already filed on it, or the caller's own
  -- unfiled upload, then filed on it); an envelope must be sent on a document of this contract.
  perform pm._d5_claim_rental_doc(c.org_id, c.id, pm.access_try_uuid(a ->> 'license_document_id'), 'license photo');
  perform pm._d5_claim_rental_doc(c.org_id, c.id, pm.access_try_uuid(a ->> 'coi_document_id'), 'insurance certificate');
  perform pm._d5_claim_rental_doc(c.org_id, c.id, pm.access_try_uuid(a ->> 'signature_document_id'), 'signature');
  perform pm._d5_assert_rental_envelope(c.org_id, c.id, pm.access_try_uuid(a ->> 'envelope_id'));
  insert into pm.dlr_rental_paperwork as p (contract_id, org_id, license_document_id, license_last4, license_state, license_expires_on, coi_document_id, coi_expires_on,
                                            card_hold_ref, card_hold_cents, waiver_choice, safety_briefed_at, safety_briefed_by, signer_name, signature_document_id, envelope_id,
                                            signed_at, updated_by)
  values (c.id, c.org_id, pm.access_try_uuid(a ->> 'license_document_id'), nullif(a ->> 'license_last4', ''), upper(nullif(a ->> 'license_state', '')),
          pm._x_try_date(a ->> 'license_expires_on'), pm.access_try_uuid(a ->> 'coi_document_id'), pm._x_try_date(a ->> 'coi_expires_on'),
          nullif(a ->> 'card_hold_ref', ''), pm._x_try_bigint(a ->> 'card_hold_cents'), upper(nullif(a ->> 'waiver_choice', '')),
          case when coalesce(pm._x_try_bool(a ->> 'safety_briefed'), false) then now() end,
          case when coalesce(pm._x_try_bool(a ->> 'safety_briefed'), false) then pm.current_user_id() end,
          nullif(btrim(a ->> 'signer_name'), ''), pm.access_try_uuid(a ->> 'signature_document_id'), pm.access_try_uuid(a ->> 'envelope_id'),
          case when nullif(btrim(a ->> 'signer_name'), '') is not null and pm.access_try_uuid(a ->> 'signature_document_id') is not null then now() end, pm.current_user_id())
  on conflict (contract_id) do update set
    license_document_id = coalesce(excluded.license_document_id, p.license_document_id), license_last4 = coalesce(excluded.license_last4, p.license_last4),
    license_state = coalesce(excluded.license_state, p.license_state), license_expires_on = coalesce(excluded.license_expires_on, p.license_expires_on),
    coi_document_id = coalesce(excluded.coi_document_id, p.coi_document_id), coi_expires_on = coalesce(excluded.coi_expires_on, p.coi_expires_on),
    card_hold_ref = coalesce(excluded.card_hold_ref, p.card_hold_ref), card_hold_cents = coalesce(excluded.card_hold_cents, p.card_hold_cents),
    waiver_choice = coalesce(excluded.waiver_choice, p.waiver_choice), safety_briefed_at = coalesce(excluded.safety_briefed_at, p.safety_briefed_at),
    safety_briefed_by = coalesce(excluded.safety_briefed_by, p.safety_briefed_by), signer_name = coalesce(excluded.signer_name, p.signer_name),
    signature_document_id = coalesce(excluded.signature_document_id, p.signature_document_id), envelope_id = coalesce(excluded.envelope_id, p.envelope_id),
    signed_at = coalesce(excluded.signed_at, p.signed_at), updated_by = excluded.updated_by, updated_at = now();
  if upper(coalesce(a ->> 'waiver_choice', '')) in ('ACCEPTED','DECLINED') and c.status = 'RESERVED' then
    update pm.rental_contracts set damage_waiver = upper(a ->> 'waiver_choice') = 'ACCEPTED' where id = c.id;
  end if;
  return pm.dlr_rental_out_check(c.id);
end $$;

create or replace function pm.dlr_rental_out_check(p_contract uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; p pm.dlr_rental_paperwork%rowtype; v_req jsonb; v_missing jsonb := '[]'; k text; v_hold boolean;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: rental contract not found' using errcode = '42501'; end if;
  select * into p from pm.dlr_rental_paperwork x where x.contract_id = c.id;
  v_req := coalesce(pm._d5_set(c.org_id, c.location_id) -> 'rental_out_requires', '[]'::jsonb);
  for k in select jsonb_array_elements_text(v_req) loop
    if (k = 'license' and (p.license_last4 is null or coalesce(p.license_expires_on, current_date) < current_date))
       or (k = 'coi' and (p.coi_document_id is null or coalesce(p.coi_expires_on, current_date) < current_date))
       or (k = 'card_hold' and p.card_hold_ref is null)
       or (k = 'waiver' and p.waiver_choice is null)
       or (k = 'safety_briefing' and p.safety_briefed_at is null)
       or (k = 'signature' and p.signed_at is null) then
      v_missing := v_missing || to_jsonb(k);
    end if;
  end loop;
  v_hold := exists (select 1 from pm.dlr_rerent_holds h where h.org_id = c.org_id and h.asset_id = c.asset_id and h.status = 'OPEN');
  return jsonb_build_object('contract_id', c.id, 'required', v_req, 'missing', v_missing, 're_rent_hold', v_hold,
                            'ready', jsonb_array_length(v_missing) = 0 and not v_hold,
                            'paperwork', case when p.contract_id is null then null else to_jsonb(p) - 'org_id' end);
end $$;

-- Contract out through the checklist (paperwork + re-rent inspection), then 1109's check-out.
create or replace function pm.dlr_check_out_rental(p_contract uuid, p_meter_out numeric, p_condition_out text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare chk jsonb;
begin
  chk := pm.dlr_rental_out_check(p_contract);
  if (chk ->> 're_rent_hold')::boolean then raise exception 'PM_RERENT_INSPECTION: inspect the unit and clear it for re-rent first' using errcode = '22023'; end if;
  if jsonb_array_length(chk -> 'missing') > 0 then
    raise exception 'PM_RENTAL_PAPERWORK: still needed: %', (select string_agg(replace(x, '_', ' '), ', ') from jsonb_array_elements_text(chk -> 'missing') x) using errcode = '22023';
  end if;
  perform pm.check_out_rental(p_contract, p_meter_out, p_condition_out, null);
  return jsonb_build_object('contract_id', p_contract, 'status', 'OUT');
end $$;

-- The store's opt-in gate on 1109's own check-out path too (re-rent holds and required paperwork).
create or replace function pm.tg_d5_rental_out_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_set jsonb; chk jsonb;
begin
  if new.status = 'OUT' and old.status = 'RESERVED' then
    v_set := pm._d5_set(new.org_id, new.location_id);
    if coalesce((v_set ->> 'rerent_inspection_required')::boolean, false)
       and exists (select 1 from pm.dlr_rerent_holds h where h.org_id = new.org_id and h.asset_id = new.asset_id and h.status = 'OPEN') then
      raise exception 'PM_RERENT_INSPECTION: inspect the unit and clear it for re-rent first' using errcode = '22023';
    end if;
    if jsonb_array_length(coalesce(v_set -> 'rental_out_requires', '[]'::jsonb)) > 0 then
      chk := pm.dlr_rental_out_check(new.id);
      if jsonb_array_length(chk -> 'missing') > 0 then
        raise exception 'PM_RENTAL_PAPERWORK: still needed: %', (select string_agg(replace(x, '_', ' '), ', ') from jsonb_array_elements_text(chk -> 'missing') x) using errcode = '22023';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_rental_out_gate on pm.rental_contracts;
create trigger trg_d5_rental_out_gate before update of status on pm.rental_contracts for each row execute function pm.tg_d5_rental_out_gate();

-- DLR-68: re-rent holds (opened on return when the store requires the inspection), PM rules and log.
create table if not exists pm.dlr_rerent_holds (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  asset_id     uuid not null,
  contract_id  uuid,
  status       text not null default 'OPEN' check (status in ('OPEN','CLEARED')),
  checklist    jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  cleared_at   timestamptz,
  cleared_by   text,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, asset_id) references pm.assets (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_dlr_rerent_open_uidx on pm.dlr_rerent_holds (org_id, asset_id) where status = 'OPEN';

create or replace function pm.tg_d5_rental_returned() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status = 'RETURNED' and old.status = 'OUT' and coalesce((pm._d5_set(new.org_id, new.location_id) ->> 'rerent_inspection_required')::boolean, false) then
    insert into pm.dlr_rerent_holds (org_id, location_id, asset_id, contract_id) values (new.org_id, new.location_id, new.asset_id, new.id)
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists trg_d5_rental_returned on pm.rental_contracts;
create trigger trg_d5_rental_returned after update of status on pm.rental_contracts for each row execute function pm.tg_d5_rental_returned();

create or replace function pm.dlr_clear_rerent(p_hold uuid, p_checklist jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare h pm.dlr_rerent_holds%rowtype;
begin
  select * into h from pm.dlr_rerent_holds x where x.id = p_hold for update;
  if h.org_id is null or h.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: hold not found' using errcode = '42501'; end if;
  if h.status <> 'OPEN' then raise exception 'PM_INVALID: already cleared' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_checklist, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_checklist, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: record the inspection checklist' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_checklist) x where coalesce((x ->> 'ok')::boolean, true) = false) then
    raise exception 'PM_INVALID: an item failed; fix it (or open a repair) before re-renting' using errcode = '22023';
  end if;
  update pm.dlr_rerent_holds set status = 'CLEARED', checklist = p_checklist, cleared_at = now(), cleared_by = pm.current_user_id() where id = h.id;
  return jsonb_build_object('hold_id', h.id, 'status', 'CLEARED');
end $$;

create table if not exists pm.dlr_fleet_pm_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  asset_id     uuid,
  model        text,
  category     text,
  label        text not null check (char_length(label) between 1 and 120),
  every_hours  numeric(10,2) check (every_hours is null or every_hours > 0),
  every_days   int check (every_days is null or every_days > 0),
  est_hours    numeric(6,2) not null default 2 check (est_hours > 0),
  checklist    jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  check (every_hours is not null or every_days is not null)
);

create table if not exists pm.dlr_fleet_pm_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  asset_id       uuid not null,
  rule_id        uuid not null,
  done_at        timestamptz not null default now(),
  meter          numeric(12,2),
  work_order_id  uuid,
  notes          text,
  done_by        text default pm.current_user_id(),
  unique (org_id, id),
  foreign key (org_id, rule_id) references pm.dlr_fleet_pm_rules (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_fleet_pm_log_idx on pm.dlr_fleet_pm_log (org_id, asset_id, rule_id, done_at desc);

create or replace function pm.dlr_save_fleet_pm_rule(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid := pm.access_try_uuid(a ->> 'id');
begin
  if v_id is null then
    insert into pm.dlr_fleet_pm_rules (org_id, location_id, asset_id, model, category, label, every_hours, every_days, est_hours, checklist)
    values (v_org, p_location, pm.access_try_uuid(a ->> 'asset_id'), nullif(a ->> 'model', ''), nullif(a ->> 'category', ''), btrim(a ->> 'label'),
            pm._x_try_num(a ->> 'every_hours'), pm._x_try_num(a ->> 'every_days')::int, coalesce(pm._x_try_num(a ->> 'est_hours'), 2), coalesce(a -> 'checklist', '[]'::jsonb))
    returning id into v_id;
  else
    update pm.dlr_fleet_pm_rules set label = coalesce(nullif(btrim(a ->> 'label'), ''), label), every_hours = pm._x_try_num(a ->> 'every_hours'),
           every_days = pm._x_try_num(a ->> 'every_days')::int, est_hours = coalesce(pm._x_try_num(a ->> 'est_hours'), est_hours),
           checklist = coalesce(a -> 'checklist', checklist), is_active = coalesce(pm._x_try_bool(a ->> 'is_active'), is_active)
     where org_id = v_org and location_id = p_location and id = v_id;
    if not found then raise exception 'PM_FORBIDDEN: rule not found' using errcode = '42501'; end if;
  end if;
  return v_id;
end $$;

-- Fleet units with a PM coming due: hours since the last PM (meter) and days rented since it; the next
-- free gap between bookings long enough for the job.
create or replace function pm.dlr_fleet_due(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(r order by (r ->> 'due_pct')::numeric desc) from (
    select jsonb_build_object('unit_id', a.id, 'unit', pm._d5_unit_label(a.id), 'rule_id', ru.id, 'rule', ru.label, 'every_hours', ru.every_hours, 'every_days', ru.every_days,
      'meter', a.meter_reading, 'last_done', lg.done_at, 'last_meter', lg.meter,
      'hours_since', case when ru.every_hours is not null then coalesce(a.meter_reading, 0) - coalesce(lg.meter, 0) end,
      'days_rented_since', rd.days,
      'due_pct', greatest(coalesce((coalesce(a.meter_reading, 0) - coalesce(lg.meter, 0)) / nullif(ru.every_hours, 0), 0), coalesce(rd.days / nullif(ru.every_days, 0)::numeric, 0)),
      'due', greatest(coalesce((coalesce(a.meter_reading, 0) - coalesce(lg.meter, 0)) / nullif(ru.every_hours, 0), 0), coalesce(rd.days / nullif(ru.every_days, 0)::numeric, 0)) >= 0.9,
      'est_hours', ru.est_hours, 'next_gap', gap.g,
      'blocked', exists (select 1 from pm.dlr_rental_blocks b where b.org_id = a.org_id and b.asset_id = a.id and b.released_at is null and b.kind = 'MAINTENANCE' and upper(b.period) > now())) as r
      from pm.assets a
      join lateral (select x.* from pm.dlr_fleet_pm_rules x where x.org_id = a.org_id and x.location_id = a.location_id and x.is_active
                       and (x.asset_id = a.id or (x.asset_id is null and (x.model is null or lower(x.model) = lower(coalesce(a.model, '')))
                                                   and (x.category is null or x.category = a.category)))) ru on true
      left join lateral (select l.done_at, l.meter from pm.dlr_fleet_pm_log l where l.org_id = a.org_id and l.asset_id = a.id and l.rule_id = ru.id order by l.done_at desc limit 1) lg on true
      cross join lateral (select coalesce(sum(greatest(extract(epoch from (least(coalesce(c.checked_in_at, now()), now()) - greatest(c.checked_out_at, coalesce(lg.done_at, '-infinity'::timestamptz)))), 0)) / 86400.0, 0)::numeric(10,1) as days
                            from pm.rental_contracts c where c.org_id = a.org_id and c.asset_id = a.id and c.checked_out_at is not null
                              and coalesce(c.checked_in_at, now()) > coalesce(lg.done_at, '-infinity'::timestamptz)) rd
      left join lateral (
          select jsonb_build_object('from', cand.t, 'to', cand.t + make_interval(secs => (ru.est_hours * 3600)::int)) as g
            from (select now() as t
                  union all select upper(c.reserved) from pm.rental_contracts c
                             where c.org_id = a.org_id and c.asset_id = a.id and c.status in ('RESERVED','OUT') and upper(c.reserved) > now()
                  union all select upper(b.period) from pm.dlr_rental_blocks b
                             where b.org_id = a.org_id and b.asset_id = a.id and b.released_at is null and upper(b.period) > now()) cand
           where not exists (select 1 from pm.rental_contracts c2 where c2.org_id = a.org_id and c2.asset_id = a.id and c2.status in ('RESERVED','OUT')
                               and c2.reserved && tstzrange(cand.t, cand.t + make_interval(secs => (ru.est_hours * 3600)::int), '[)'))
             and not exists (select 1 from pm.dlr_rental_blocks b2 where b2.org_id = a.org_id and b2.asset_id = a.id and b2.released_at is null
                               and b2.period && tstzrange(cand.t, cand.t + make_interval(secs => (ru.est_hours * 3600)::int), '[)'))
           order by cand.t limit 1) gap on true
     where a.org_id = v_org and a.location_id = p_location and a.unit_status = 'RENTAL') q), '[]'::jsonb);
end $$;

-- Schedule a PM into a gap: block the unit + an internal RO routed RENTAL (the rental department's cost).
create or replace function pm.dlr_schedule_fleet_pm(p_unit uuid, p_rule uuid, p_from timestamptz, p_to timestamptz, p_job uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; ru pm.dlr_fleet_pm_rules%rowtype; v_job uuid := p_job; v_wo uuid; v_block uuid; i jsonb; n int := 0; v_set jsonb;
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  select * into ru from pm.dlr_fleet_pm_rules x where x.id = p_rule and x.org_id = a.org_id;
  if ru.id is null then raise exception 'PM_FORBIDDEN: PM rule not found' using errcode = '42501'; end if;
  -- nested-guard audit: pm.create_project's own guard (Jobs create) is skipped inside this RPC, so it is checked here;
  -- a job passed in must be this unit's company (create_work_order's guard is skipped too).
  if v_job is null then
    if not pm._x_sees('projects.jobs', 'create', a.location_id) then raise exception 'PM_FORBIDDEN: opening a new job for the PM needs Jobs create' using errcode = '42501'; end if;
    v_set := pm._d5_set(a.org_id, a.location_id);
    v_job := pm.create_project(a.location_id, coalesce(v_set ->> 'service_job_type_key', 'customer_repair'), left(format('Fleet PM %s', coalesce(a.stock_number, a.serial_number)), 200),
                               null, null, a.is_sample, '{}'::jsonb);
  else
    perform pm._x_job(v_job);
    if (select jx.location_id from core.jobs jx where jx.id = v_job) is distinct from a.location_id then
      raise exception 'PM_INVALID: that job is at another company' using errcode = '22023';
    end if;
  end if;
  v_wo := pm.create_work_order(v_job, 'REPAIR_ORDER', left(ru.label || ' — ' || coalesce(a.stock_number, a.serial_number), 200), 3, a.id, p_from, p_to,
                               (ru.est_hours * 60)::int, '{}', 'INTERNAL');
  for i in select value from jsonb_array_elements(ru.checklist) loop
    n := n + 1;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, pay_type, internal_route, internal_asset_id)
    values (a.org_id, v_job, v_wo, n, 'LABOR', left(coalesce(i ->> 'label', i #>> '{}', 'PM item'), 300), 1, 'INTERNAL', 'RENTAL', a.id);
  end loop;
  if n = 0 then
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, flag_hours, pay_type, internal_route, internal_asset_id)
    values (a.org_id, v_job, v_wo, 1, 'LABOR', left(ru.label, 300), 1, ru.est_hours, 'INTERNAL', 'RENTAL', a.id);
  end if;
  v_block := pm.dlr_block_rental_unit(a.id, 'MAINTENANCE', p_from, p_to, ru.label, v_wo);
  update pm.dlr_rental_blocks set rule_id = ru.id where id = v_block;
  return jsonb_build_object('work_order_id', v_wo, 'job_id', v_job, 'block_id', v_block);
end $$;

create or replace function pm.dlr_complete_fleet_pm(p_unit uuid, p_rule uuid, p_meter numeric default null, p_wo uuid default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_id uuid;
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: unit not found' using errcode = '42501'; end if;
  if not exists (select 1 from pm.dlr_fleet_pm_rules r where r.id = p_rule and r.org_id = a.org_id) then raise exception 'PM_FORBIDDEN: PM rule not found' using errcode = '42501'; end if;
  insert into pm.dlr_fleet_pm_log (org_id, location_id, asset_id, rule_id, meter, work_order_id, notes)
  values (a.org_id, a.location_id, a.id, p_rule, coalesce(p_meter, a.meter_reading), p_wo, nullif(btrim(coalesce(p_notes, '')), '')) returning id into v_id;
  update pm.dlr_rental_blocks set released_at = now()
   where org_id = a.org_id and asset_id = a.id and kind = 'MAINTENANCE' and released_at is null and (rule_id = p_rule or work_order_id = p_wo);
  return jsonb_build_object('log_id', v_id);
end $$;

-- DLR-66: a damage RO from a returned rental (the renter pays, or internal to the rental department).
create or replace function pm.dlr_rental_damage_ro(p_contract uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_job uuid := pm.access_try_uuid(a ->> 'job_id'); v_wo uuid; v_pay text; i jsonb; n int := 0; v_set jsonb;
        v_inspect jsonb;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: rental contract not found' using errcode = '42501'; end if;
  if c.status not in ('RETURNED','CLOSED') then raise exception 'PM_RENTAL_TRANSITION_INVALID: check the unit in first' using errcode = '22023'; end if;
  v_pay := case when coalesce(pm._x_try_bool(a ->> 'charge_renter'), true) then 'CUSTOMER' else 'INTERNAL' end;
  if v_job is null then
    if not pm._x_sees('projects.jobs', 'create', c.location_id) then raise exception 'PM_FORBIDDEN: opening a new job for the damage RO needs Jobs create' using errcode = '42501'; end if;
    v_set := pm._d5_set(c.org_id, c.location_id);
    v_job := pm.create_project(c.location_id, coalesce(v_set ->> 'service_job_type_key', 'customer_repair'), left('Rental damage ' || c.number, 200),
                               case when v_pay = 'CUSTOMER' then c.customer_id end, null, c.is_sample, '{}'::jsonb);
  else
    perform pm._x_job(v_job);
    if (select jx.location_id from core.jobs jx where jx.id = v_job) is distinct from c.location_id then
      raise exception 'PM_INVALID: that job is at another company' using errcode = '22023';
    end if;
  end if;
  v_wo := pm.create_work_order(v_job, 'REPAIR_ORDER', left(coalesce(nullif(a ->> 'summary', ''), 'Rental damage ' || c.number), 200), 3, c.asset_id, null, null, null, '{}', 'INTERNAL');
  v_inspect := pm.dlr_rental_damage_compare(c.id);
  for i in select value from jsonb_array_elements(coalesce(a -> 'lines', '[]'::jsonb)) loop
    n := n + 1;
    insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, description, qty, unit_price_cents, flag_hours, pay_type, internal_route, internal_asset_id)
    values (c.org_id, v_job, v_wo, n, upper(coalesce(nullif(i ->> 'kind', ''), 'LABOR')), left(coalesce(i ->> 'description', 'Damage repair'), 300), coalesce(pm._x_try_num(i ->> 'qty'), 1),
            pm._x_try_bigint(i ->> 'unit_price_cents'), pm._x_try_num(i ->> 'flag_hours'), v_pay,
            case when v_pay = 'INTERNAL' then 'RENTAL' end, case when v_pay = 'INTERNAL' then c.asset_id end);
  end loop;
  perform pm.log_activity(c.org_id, c.location_id, v_job, 'rental.damage_ro', 'rental_contracts', c.id, format('Damage RO opened from %s', c.number),
    jsonb_build_object('work_order_id', v_wo, 'compare', v_inspect -> 'summary'));
  return jsonb_build_object('work_order_id', v_wo, 'job_id', v_job, 'lines', n);
end $$;

-- DLR-67: long-term cycle billing (every store cycle, default 28 days) for every contract still out.
create or replace function pm.dlr_run_cycle_billing(p_location uuid, p_through timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_cycle int; c pm.rental_contracts%rowtype; v_upto timestamptz := coalesce(p_through, now()); v_out jsonb := '[]';
        v_from timestamptz; v_bill uuid;
begin
  v_cycle := coalesce((pm._d5_set(v_org, p_location) ->> 'cycle_days')::int, 28);
  for c in select * from pm.rental_contracts x where x.org_id = v_org and x.location_id = p_location and x.status = 'OUT' order by x.checked_out_at for update loop
    v_from := coalesce(c.billed_through, c.checked_out_at);
    continue when v_from + make_interval(days => v_cycle) > v_upto;
    begin
      v_bill := pm.bill_rental(c.id, v_from + make_interval(days => v_cycle));
      v_out := v_out || jsonb_build_object('contract_id', c.id, 'number', c.number, 'billing_id', v_bill, 'through', v_from + make_interval(days => v_cycle));
    exception when others then
      v_out := v_out || jsonb_build_object('contract_id', c.id, 'number', c.number, 'error', left(sqlerrm, 200));
    end;
  end loop;
  return jsonb_build_object('cycle_days', v_cycle, 'billed', v_out);
end $$;

-- What is due for cycle billing today (the close checklist reads it).
create or replace function pm._d5_cycle_due(p_org uuid, p_location uuid) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select count(*)::int from pm.rental_contracts x
   where x.org_id = p_org and x.location_id = p_location and x.status = 'OUT'
     and coalesce(x.billed_through, x.checked_out_at) + make_interval(days => coalesce((pm._d5_set(p_org, p_location) ->> 'cycle_days')::int, 28)) <= now()
$$;

-- ----------------------------------------------------------------------------
-- D10. Customer 360 (DLR-70), registers + drawer close (DLR-71), price controls (DLR-77),
--      day-end / month-end store close (DLR-80)
-- ----------------------------------------------------------------------------

-- DLR-70: one customer at one store — units, ROs, deals, rentals, special orders, texts, contacts, and
-- AR / aging / credit hold read from Books (amounts with Contract value; the hold flag for everyone).
create or replace function pm.dlr_customer_360(p_location uuid, p_customer uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); c core.customers%rowtype; v_cv boolean := pm._x_sees('projects.contract_value', 'view', p_location);
        v_ar jsonb := jsonb_build_object('available', false); v_open bigint; b0 bigint; b30 bigint; b60 bigint; b90 bigint; v_n int;
begin
  select * into c from core.customers x where x.id = p_customer and x.org_id = v_org and x.deleted_at is null;
  if c.id is null then raise exception 'PM_UNKNOWN_CUSTOMER: customer not found' using errcode = 'P0002'; end if;
  if to_regclass('public.invoices') is not null then
    execute $q$ select coalesce(sum(i.balance_cents), 0), count(*),
                       coalesce(sum(i.balance_cents) filter (where current_date - i.due_date <= 30), 0),
                       coalesce(sum(i.balance_cents) filter (where current_date - i.due_date between 31 and 60), 0),
                       coalesce(sum(i.balance_cents) filter (where current_date - i.due_date between 61 and 90), 0),
                       coalesce(sum(i.balance_cents) filter (where current_date - i.due_date > 90), 0)
                  from public.invoices i where i.org_id = $1 and i.customer_id = $2 and coalesce(i.balance_cents, 0) > 0 and i.status not in ('VOID','DRAFT','PAID') $q$
      into v_open, v_n, b0, b30, b60, b90 using v_org, c.id;
    v_ar := jsonb_build_object('available', true, 'open_invoices', v_n,
      'credit_hold', c.credit_limit_cents is not null and v_open > c.credit_limit_cents, 'past_due_90', b90 > 0,
      'balance_cents', case when v_cv then v_open end, 'credit_limit_cents', case when v_cv then c.credit_limit_cents end,
      'aging', case when v_cv then jsonb_build_object('current_30', b0, 'd31_60', b30, 'd61_90', b60, 'over_90', b90) end);
  end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', coalesce(c.display_name, c.name), 'email', c.email, 'phone', c.phone, 'address_line1', c.address_line1,
      'city', c.city, 'state', c.state, 'zip', c.zip, 'tax_exempt', coalesce(c.tax_exempt, false), 'has_tax_id', c.tax_id is not null, 'terms_days', c.payment_terms_days),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', btrim(concat_ws(' ', k.first_name, k.last_name)), 'title', k.title, 'phone', k.phone, 'email', k.email,
        'is_primary', k.is_primary, 'sms_consent', k.sms_consent, 'roles', to_jsonb(k.roles)) order by k.is_primary desc, k.last_name)
      from core.contacts k where k.org_id = v_org and k.customer_id = c.id and k.merged_into is null), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'make', a.make, 'model', a.model, 'serial_number', a.serial_number, 'meter', a.meter_reading,
        'warranty_expires_on', a.warranty_expires_on, 'last_service_on', a.last_service_on, 'registered_on', a.registered_on) order by a.created_at desc)
      from pm.assets a where a.org_id = v_org and a.customer_id = c.id and a.status = 'ACTIVE'), '[]'::jsonb),
    'repair_orders', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'number', w.number, 'status', w.status, 'stage', s.stage, 'summary', w.summary,
        'unit', pm._d5_unit_label(w.asset_id), 'opened', coalesce(w.checked_in_at, w.created_at), 'closed_at', w.closed_at) order by w.created_at desc)
      from pm.work_orders w join core.jobs j on j.id = w.job_id left join pm.dlr_ro_state s on s.org_id = w.org_id and s.work_order_id = w.id
     where w.org_id = v_org and w.location_id = p_location and w.kind = 'REPAIR_ORDER' and (j.customer_id = c.id or w.payer_customer_id = c.id)
       and (w.status not in ('CLOSED','CANCELLED') or w.closed_at > now() - interval '18 months')), '[]'::jsonb),
    'deals', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'stage', d.stage, 'delivered_on', d.delivered_on, 'created_at', d.created_at) order by d.created_at desc)
      from pm.dealer_deals d where d.org_id = v_org and d.location_id = p_location and d.customer_id = c.id), '[]'::jsonb),
    'rentals', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number, 'status', r.status, 'unit', pm._d5_unit_label(r.asset_id),
        'from', lower(r.reserved), 'to', upper(r.reserved)) order by lower(r.reserved) desc)
      from pm.rental_contracts r where r.org_id = v_org and r.location_id = p_location and r.customer_id = c.id), '[]'::jsonb),
    'special_orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'part_number', p.part_number, 'qty', o.qty) order by o.created_at desc)
      from pm.parts_special_orders o join pm.parts p on p.org_id = o.org_id and p.id = o.part_id
     where o.org_id = v_org and o.location_id = p_location and o.customer_id = c.id and o.status not in ('PICKED_UP','CANCELLED')), '[]'::jsonb),
    'texts', coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'status', t.status, 'body', t.body, 'at', t.created_at) order by t.created_at desc)
      from (select * from pm.dlr_customer_texts t2 where t2.org_id = v_org and t2.customer_id = c.id order by t2.created_at desc limit 25) t), '[]'::jsonb),
    'ar', v_ar, 'amounts_visible', v_cv);
end $$;

-- DLR-71: registers, drawer sessions, entries, and the deposit-batch facts for Books.
create table if not exists pm.dlr_registers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  code         text not null check (code ~ '^[A-Z0-9_-]{1,16}$'),
  name         text not null check (char_length(name) between 1 and 60),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, code)
);

create table if not exists pm.dlr_drawer_sessions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  register_id         uuid not null,
  business_date       date not null default current_date,
  opened_by           text default pm.current_user_id(),
  opened_at           timestamptz not null default now(),
  opening_cash_cents  bigint not null default 0 check (opening_cash_cents >= 0),
  status              text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  closed_by           text,
  closed_at           timestamptz,
  counted             jsonb,
  expected            jsonb,
  variance_cents      bigint,
  variance_flag       boolean not null default false,
  variance_note       text,
  variance_by_tender  jsonb,
  unique (org_id, id),
  foreign key (org_id, register_id) references pm.dlr_registers (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_dlr_drawer_open_uidx on pm.dlr_drawer_sessions (org_id, register_id) where status = 'OPEN';
alter table pm.dlr_drawer_sessions add column if not exists variance_by_tender jsonb;

create table if not exists pm.dlr_drawer_entries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  session_id    uuid not null,
  source_kind   text not null check (source_kind in ('PARTS_TICKET','REPAIR_ORDER','DEAL_DEPOSIT','RENTAL','SPECIAL_ORDER','PAYOUT','OTHER')),
  source_id     uuid,
  tender        text not null check (tender in ('CASH','CHECK','CARD','OTHER')),
  amount_cents  bigint not null check (amount_cents <> 0),
  reference     text,
  note          text,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, session_id) references pm.dlr_drawer_sessions (org_id, id) on delete cascade deferrable initially immediate
);
-- Security review R5: a source may be paid in several entries (partial payments, split tenders) up to
-- what it owes (pm.dlr_record_payment); a counter ticket lands once per tender (the ticket trigger).
drop index if exists pm.pm_dlr_drawer_entry_src_uidx;
create unique index if not exists pm_dlr_drawer_ticket_uidx on pm.dlr_drawer_entries (org_id, source_id, tender) where source_kind = 'PARTS_TICKET';
create index if not exists pm_dlr_drawer_entry_source_idx on pm.dlr_drawer_entries (org_id, source_kind, source_id) where source_id is not null;

create table if not exists pm.dlr_deposit_batches (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  session_id     uuid not null,
  business_date  date not null,
  cash_cents     bigint not null default 0,
  check_cents    bigint not null default 0,
  card_cents     bigint not null default 0,
  items          jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  status         text not null default 'READY' check (status in ('READY','SENT_TO_BOOKS','ACKED')),
  books_ref      text,
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, session_id),
  foreign key (org_id, session_id) references pm.dlr_drawer_sessions (org_id, id) deferrable initially immediate
);

create or replace function pm.dlr_save_register(p_location uuid, p_code text, p_name text, p_active boolean default true)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid;
begin
  insert into pm.dlr_registers as r (org_id, location_id, code, name, is_active) values (v_org, p_location, upper(btrim(p_code)), btrim(p_name), coalesce(p_active, true))
  on conflict (org_id, location_id, code) do update set name = excluded.name, is_active = excluded.is_active returning id into v_id;
  return v_id;
end $$;

create or replace function pm.dlr_open_drawer(p_register uuid, p_opening_cash_cents bigint default 0)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dlr_registers%rowtype; v_id uuid;
begin
  select * into r from pm.dlr_registers x where x.id = p_register;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: register not found' using errcode = '42501'; end if;
  if not r.is_active then raise exception 'PM_INVALID: that register is retired' using errcode = '22023'; end if;
  if coalesce(p_opening_cash_cents, -1) < 0 then raise exception 'PM_INVALID: count the starting cash' using errcode = '22023'; end if;
  begin
    insert into pm.dlr_drawer_sessions (org_id, location_id, register_id, opening_cash_cents) values (r.org_id, r.location_id, r.id, p_opening_cash_cents) returning id into v_id;
  exception when unique_violation then
    raise exception 'PM_DUPLICATE: register % is already open; close it first', r.code using errcode = '23505';
  end;
  return v_id;
end $$;

-- What a payment source owes, in cents (null = not known: no cap). RO: the approved customer lines plus
-- the store's tax estimate; deal: its cash price (dealer_deal_totals); rental: the rental charge for the
-- reserved window plus return charges; special order: quantity x the part price plus tax.
create or replace function pm._d5_source_due(p_org uuid, p_kind text, p_id uuid) returns bigint
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v bigint; v_tax numeric; r pm.rental_contracts%rowtype; v_loc uuid;
begin
  if p_kind = 'REPAIR_ORDER' then
    select w.location_id into v_loc from pm.work_orders w where w.org_id = p_org and w.id = p_id;
    select s.default_tax_rate into v_tax from pm.dealer_settings s where s.org_id = p_org and s.location_id = v_loc;
    select round(coalesce(sum(l.amount_cents), 0) * (1 + coalesce(v_tax, 0)))::bigint into v from pm.work_order_lines l
     where l.org_id = p_org and l.work_order_id = p_id and l.status = 'APPROVED' and l.pay_type = 'CUSTOMER';
    return v;
  elsif p_kind = 'DEAL_DEPOSIT' then
    return pm._x_try_bigint(pm.dealer_deal_totals(p_id) ->> 'cash_price_cents');
  elsif p_kind = 'RENTAL' then
    select * into r from pm.rental_contracts x where x.org_id = p_org and x.id = p_id;
    return coalesce(pm._x_try_bigint(pm.rental_charge(r.rate_day_cents, r.rate_week_cents, r.rate_month_cents, lower(r.reserved), upper(r.reserved)) ->> 'rental_cents'), 0)
         + coalesce(r.damage_cents, 0) + coalesce(r.fuel_cents, 0) + coalesce(r.cleaning_cents, 0) + coalesce(r.delivery_cents, 0);
  elsif p_kind = 'SPECIAL_ORDER' then
    select round(o.qty * coalesce(p.price_cents, p.list_price_cents, 0) * (1 + coalesce(s.default_tax_rate, 0)))::bigint into v
      from pm.parts_special_orders o join pm.parts p on p.org_id = o.org_id and p.id = o.part_id
      left join pm.dealer_settings s on s.org_id = o.org_id and s.location_id = o.location_id
     where o.org_id = p_org and o.id = p_id;
    return v;
  end if;
  return null;
end $$;

-- A payment into the drawer (security review H2): counter tickets land through the ticket trigger only;
-- RO / deal deposit / rental / special-order payments name their source, which must be a record of
-- this organization AT THIS STORE; a negative amount is only a cash PAYOUT with a note.
create or replace function pm.dlr_record_payment(p_session uuid, p_source_kind text, p_source uuid, p_tender text, p_amount_cents bigint,
                                                  p_reference text default null, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_drawer_sessions%rowtype; v_id uuid; v_kind text := upper(coalesce(p_source_kind, 'OTHER')); v_t text := upper(coalesce(p_tender, '')); v_ok boolean; v_due bigint;
begin
  select * into s from pm.dlr_drawer_sessions x where x.id = p_session;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawer not found' using errcode = '42501'; end if;
  if s.status <> 'OPEN' then raise exception 'PM_INVALID: that drawer is closed' using errcode = '22023'; end if;
  if v_t not in ('CASH','CHECK','CARD','OTHER') then raise exception 'PM_INVALID: tender is cash, check, card or other' using errcode = '22023'; end if;
  if v_kind not in ('REPAIR_ORDER','DEAL_DEPOSIT','RENTAL','SPECIAL_ORDER','PAYOUT','OTHER') then
    raise exception 'PM_INVALID: counter tickets land in the drawer when the ticket closes; record a repair order, deal deposit, rental, special order, payout or other payment' using errcode = '22023';
  end if;
  if coalesce(p_amount_cents, 0) = 0 then raise exception 'PM_INVALID: enter the amount' using errcode = '22023'; end if;
  if p_amount_cents < 0 and v_kind <> 'PAYOUT' then raise exception 'PM_INVALID: money out of the drawer is a payout with a note' using errcode = '22023'; end if;
  if v_kind = 'PAYOUT' and p_amount_cents > 0 then raise exception 'PM_INVALID: a payout is a negative amount' using errcode = '22023'; end if;
  if v_kind = 'PAYOUT' and v_t <> 'CASH' then raise exception 'PM_INVALID: a payout comes out of the cash' using errcode = '22023'; end if;
  if v_kind in ('PAYOUT','OTHER') and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'PM_INVALID: say what the % was for', case when v_kind = 'PAYOUT' then 'payout' else 'payment' end using errcode = '22023';
  end if;
  if v_kind in ('REPAIR_ORDER','DEAL_DEPOSIT','RENTAL','SPECIAL_ORDER') then
    if p_source is null then raise exception 'PM_INVALID: pick the % this payment is for', lower(replace(v_kind, '_', ' ')) using errcode = '22023'; end if;
    v_ok := case v_kind
      when 'REPAIR_ORDER'  then exists (select 1 from pm.work_orders x where x.id = p_source and x.org_id = s.org_id and x.location_id = s.location_id)
      when 'DEAL_DEPOSIT'  then exists (select 1 from pm.dealer_deals x where x.id = p_source and x.org_id = s.org_id and x.location_id = s.location_id)
      when 'RENTAL'        then exists (select 1 from pm.rental_contracts x where x.id = p_source and x.org_id = s.org_id and x.location_id = s.location_id)
      when 'SPECIAL_ORDER' then exists (select 1 from pm.parts_special_orders x where x.id = p_source and x.org_id = s.org_id and x.location_id = s.location_id)
    end;
    if not v_ok then raise exception 'PM_INVALID: that % is not at this store', lower(replace(v_kind, '_', ' ')) using errcode = '22023'; end if;
    -- security review R5: several payments may go to one record, never more in total than it owes
    v_due := pm._d5_source_due(s.org_id, v_kind, p_source);
    if v_due is not null and coalesce((select sum(e.amount_cents) from pm.dlr_drawer_entries e
                                        where e.org_id = s.org_id and e.source_kind = v_kind and e.source_id = p_source), 0) + p_amount_cents > v_due then
      raise exception 'PM_INVALID: that is more than the balance due on this %; check the amount', lower(replace(v_kind, '_', ' ')) using errcode = '22023';
    end if;
  elsif p_source is not null then
    raise exception 'PM_INVALID: a payout or other payment has no source record' using errcode = '22023';
  end if;
  begin
    insert into pm.dlr_drawer_entries (org_id, session_id, source_kind, source_id, tender, amount_cents, reference, note)
    values (s.org_id, s.id, v_kind, p_source, v_t, p_amount_cents, nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_note, '')), '')) returning id into v_id;
  exception when unique_violation then
    raise exception 'PM_DUPLICATE: that payment is already in a drawer' using errcode = '23505';
  end;
  return v_id;
end $$;

-- A counter ticket closed with cash / check / card lands in the closer's open drawer at that store
-- (security review H2): cash or a check closed at a store with active registers and no open drawer
-- for the closer is refused; a ticket already in a drawer at a different amount is refused (never
-- silently kept at the old amount); the same amount again is a no-op.
create or replace function pm.tg_d5_ticket_drawer() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s uuid; v_amt bigint; e pm.dlr_drawer_entries%rowtype;
begin
  if new.status = 'CLOSED' and old.status = 'OPEN' and new.payment_method in ('CASH','CHECK','CARD') then
    select x.id into s from pm.dlr_drawer_sessions x where x.org_id = new.org_id and x.location_id = new.location_id and x.status = 'OPEN' and x.opened_by = new.closed_by
     order by x.opened_at desc limit 1;
    if s is null and new.payment_method in ('CASH','CHECK')
       and exists (select 1 from pm.dlr_registers r where r.org_id = new.org_id and r.location_id = new.location_id and r.is_active) then
      raise exception 'PM_DRAWER_REQUIRED: open your drawer before taking % on %', lower(new.payment_method), new.number using errcode = '55000';
    end if;
    if s is not null then
      v_amt := coalesce((new.totals ->> 'parts_cents')::bigint, 0) + coalesce((new.totals ->> 'core_charges_cents')::bigint, 0) + coalesce((new.totals ->> 'tax_estimate_cents')::bigint, 0);
      if v_amt <> 0 then
        select * into e from pm.dlr_drawer_entries x where x.org_id = new.org_id and x.source_kind = 'PARTS_TICKET' and x.source_id = new.id and x.tender = new.payment_method;
        if e.id is null then
          insert into pm.dlr_drawer_entries (org_id, session_id, source_kind, source_id, tender, amount_cents, reference, created_by)
          values (new.org_id, s, 'PARTS_TICKET', new.id, new.payment_method, v_amt, new.number, new.closed_by);
        elsif e.amount_cents <> v_amt then
          raise exception 'PM_DRAWER_MISMATCH: % is already in a drawer at % cents, not % cents; record the difference as its own payment', new.number, e.amount_cents, v_amt
            using errcode = '55000';
        end if;
      end if;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_d5_ticket_drawer on pm.parts_tickets;
create trigger trg_d5_ticket_drawer after update of status on pm.parts_tickets for each row execute function pm.tg_d5_ticket_drawer();

create or replace function pm._d5_drawer_expected(p_session uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'cash_cents', s.opening_cash_cents + coalesce((select sum(e.amount_cents) from pm.dlr_drawer_entries e where e.org_id = s.org_id and e.session_id = s.id and e.tender = 'CASH'), 0),
    'check_cents', coalesce((select sum(e.amount_cents) from pm.dlr_drawer_entries e where e.org_id = s.org_id and e.session_id = s.id and e.tender = 'CHECK'), 0),
    'card_cents', coalesce((select sum(e.amount_cents) from pm.dlr_drawer_entries e where e.org_id = s.org_id and e.session_id = s.id and e.tender = 'CARD'), 0),
    'other_cents', coalesce((select sum(e.amount_cents) from pm.dlr_drawer_entries e where e.org_id = s.org_id and e.session_id = s.id and e.tender = 'OTHER'), 0),
    'entries', (select count(*) from pm.dlr_drawer_entries e where e.org_id = s.org_id and e.session_id = s.id))
  from pm.dlr_drawer_sessions s where s.id = p_session
$$;

-- Close the drawer (security review H2): counts by tender vs expected; each tender's variance is
-- checked on its own (a cash short cannot hide behind a check over) against the LOWER of the store
-- threshold and 3x this register's typical variance — a register with a history of large variances
-- never earns a looser threshold. A flagged close needs a note; flagged closes are on the store close
-- checklist. The deposit batch (cash beyond the float you keep + checks; cards settle through the
-- processor) is produced for Books.
create or replace function pm.dlr_close_drawer(p_session uuid, p_counts jsonb, p_keep_float_cents bigint default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_drawer_sessions%rowtype; e jsonb; c jsonb := coalesce(p_counts, '{}'); v_var bigint; v_thr bigint; v_typ numeric; v_flag boolean; v_keep bigint; v_batch uuid;
        v_cash bigint; v_check bigint; v_card bigint; v_lim bigint; v_vc bigint; v_vk bigint; v_vd bigint; v_by jsonb;
begin
  select * into s from pm.dlr_drawer_sessions x where x.id = p_session for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawer not found' using errcode = '42501'; end if;
  if s.status <> 'OPEN' then raise exception 'PM_INVALID: that drawer is already closed' using errcode = '22023'; end if;
  v_cash := pm._x_try_bigint(c ->> 'cash_cents'); v_check := coalesce(pm._x_try_bigint(c ->> 'check_cents'), 0); v_card := coalesce(pm._x_try_bigint(c ->> 'card_cents'), 0);
  if v_cash is null or v_cash < 0 or v_check < 0 or v_card < 0 then raise exception 'PM_INVALID: count the cash (and checks / card slips)' using errcode = '22023'; end if;
  e := pm._d5_drawer_expected(s.id);
  v_vc := v_cash - (e ->> 'cash_cents')::bigint; v_vk := v_check - (e ->> 'check_cents')::bigint; v_vd := v_card - (e ->> 'card_cents')::bigint;
  v_var := v_vc + v_vk + v_vd;
  v_thr := coalesce((pm._d5_set(s.org_id, s.location_id) ->> 'drawer_variance_cents')::bigint, 500);
  select percentile_cont(0.5) within group (order by abs(x.variance_cents)) into v_typ from (
    select d.variance_cents from pm.dlr_drawer_sessions d where d.org_id = s.org_id and d.register_id = s.register_id and d.status = 'CLOSED' order by d.closed_at desc limit 20) x;
  v_lim := least(v_thr, coalesce(nullif(round(v_typ * 3)::bigint, 0), v_thr));
  v_by := jsonb_build_object(
    'cash',  jsonb_build_object('variance_cents', v_vc, 'flagged', abs(v_vc) > v_lim),
    'check', jsonb_build_object('variance_cents', v_vk, 'flagged', abs(v_vk) > v_lim),
    'card',  jsonb_build_object('variance_cents', v_vd, 'flagged', abs(v_vd) > v_lim),
    'threshold_cents', v_lim);
  v_flag := abs(v_vc) > v_lim or abs(v_vk) > v_lim or abs(v_vd) > v_lim;
  -- security review R4: the first count is binding — a flagged drawer closes anyway (no recount until it
  -- balances) and the variance must be explained afterwards (pm.dlr_note_drawer_variance) before the
  -- store close can be signed. Nothing about the expected amounts is ever put in an error.
  v_keep := least(greatest(coalesce(p_keep_float_cents, s.opening_cash_cents), 0), v_cash);
  update pm.dlr_drawer_sessions set status = 'CLOSED', closed_at = now(), closed_by = pm.current_user_id(), counted = c, expected = e, variance_cents = v_var,
         variance_flag = v_flag, variance_by_tender = v_by, variance_note = nullif(btrim(coalesce(p_note, '')), '') where id = s.id;
  insert into pm.dlr_deposit_batches (org_id, location_id, session_id, business_date, cash_cents, check_cents, card_cents, items)
  values (s.org_id, s.location_id, s.id, s.business_date, v_cash - v_keep, v_check, v_card,
          coalesce((select jsonb_agg(jsonb_build_object('source_kind', x.source_kind, 'source_id', x.source_id, 'tender', x.tender, 'amount_cents', x.amount_cents,
                                                       'reference', x.reference) order by x.created_at)
                      from pm.dlr_drawer_entries x where x.org_id = s.org_id and x.session_id = s.id), '[]'::jsonb))
  returning id into v_batch;
  perform pm.log_activity(s.org_id, s.location_id, null, 'drawer.closed', 'dlr_drawer_sessions', s.id,
    format('Drawer closed: variance %s cents%s', v_var, case when v_flag then ' (flagged)' else '' end), jsonb_build_object('batch_id', v_batch, 'by_tender', v_by));
  return jsonb_build_object('session_id', s.id, 'expected', e, 'counted', c, 'variance_cents', v_var, 'flagged', v_flag, 'by_tender', v_by, 'deposit_batch_id', v_batch,
                            'deposit_cash_cents', v_cash - v_keep, 'deposit_check_cents', v_check, 'kept_float_cents', v_keep,
                            'note_required', v_flag and nullif(btrim(coalesce(p_note, '')), '') is null);
end $$;

-- The explanation of a flagged variance, after the (binding) close.
create or replace function pm.dlr_note_drawer_variance(p_session uuid, p_note text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_drawer_sessions%rowtype;
begin
  select * into s from pm.dlr_drawer_sessions x where x.id = p_session for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawer not found' using errcode = '42501'; end if;
  if s.status <> 'CLOSED' or not s.variance_flag then raise exception 'PM_INVALID: only a closed drawer with a flagged variance takes an explanation' using errcode = '22023'; end if;
  if s.variance_note is not null then raise exception 'PM_INVALID: that variance is already explained' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'PM_INVALID: explain the variance' using errcode = '22023'; end if;
  update pm.dlr_drawer_sessions set variance_note = left(btrim(p_note), 500) where id = s.id;
  perform pm.log_activity(s.org_id, s.location_id, null, 'drawer.variance_explained', 'dlr_drawer_sessions', s.id, 'Drawer variance explained', '{}'::jsonb);
  return jsonb_build_object('session_id', s.id, 'explained', true);
end $$;

create or replace function pm.dlr_drawer_board(p_location uuid, p_day date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_day date := coalesce(p_day, current_date);
begin
  return jsonb_build_object('day', v_day,
    'registers', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'is_active', r.is_active,
        'open_session', (select jsonb_build_object('id', s.id, 'opened_at', s.opened_at, 'opened_by', s.opened_by, 'opening_cash_cents', s.opening_cash_cents,
                                                   'entries', (select count(*) from pm.dlr_drawer_entries e2 where e2.org_id = s.org_id and e2.session_id = s.id))
                           from pm.dlr_drawer_sessions s where s.org_id = r.org_id and s.register_id = r.id and s.status = 'OPEN' limit 1)) order by r.code)
      from pm.dlr_registers r where r.org_id = v_org and r.location_id = p_location), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'register', r.code, 'closed_at', s.closed_at, 'variance_cents', s.variance_cents,
        'flagged', s.variance_flag, 'by_tender', s.variance_by_tender, 'note', s.variance_note, 'expected', s.expected, 'counted', s.counted,
        'batch', (select jsonb_build_object('id', b.id, 'cash_cents', b.cash_cents, 'check_cents', b.check_cents, 'card_cents', b.card_cents, 'status', b.status)
                    from pm.dlr_deposit_batches b where b.org_id = s.org_id and b.session_id = s.id)) order by s.closed_at desc)
      from pm.dlr_drawer_sessions s join pm.dlr_registers r on r.org_id = s.org_id and r.id = s.register_id
     where s.org_id = v_org and s.location_id = p_location and s.status = 'CLOSED' and s.business_date = v_day), '[]'::jsonb),
    -- Blind count (security review H2): while a drawer is open nobody sees what it should hold — no
    -- expected totals and no amounts on its entries; they appear once it is closed.
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'session_id', e.session_id, 'source_kind', e.source_kind, 'tender', e.tender,
        'amount_cents', case when s.status = 'CLOSED' then e.amount_cents end, 'reference', e.reference, 'note', e.note, 'at', e.created_at,
        'blind', s.status = 'OPEN') order by e.created_at desc)
      from pm.dlr_drawer_entries e join pm.dlr_drawer_sessions s on s.org_id = e.org_id and s.id = e.session_id
     where s.org_id = v_org and s.location_id = p_location and s.business_date = v_day), '[]'::jsonb),
    'blind_count', true);
end $$;

-- DLR-77: discount limits by role, overrides with a reason, approval by another person (queue) or a
-- manager PIN at the counter. No limits configured at a store = controls off.
create table if not exists pm.dlr_price_limits (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  role_key          text not null check (role_key ~ '^(default|projects_[a-z_]+)$'),
  max_discount_pct  numeric(5,4) not null default 0 check (max_discount_pct >= 0 and max_discount_pct <= 1),
  allow_below_cost  boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, role_key)
);

create table if not exists pm.dlr_manager_pins (
  org_id         uuid not null references core.organizations(id) on delete cascade,
  membership_id  uuid not null references core.memberships(id) on delete cascade,
  pin_hash       text not null,
  failed_count   int not null default 0,
  locked_until   timestamptz,
  set_at         timestamptz not null default now(),
  primary key (org_id, membership_id)
);

create table if not exists pm.dlr_price_overrides (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  source_kind            text not null check (source_kind in ('PARTS_TICKET_LINE','RO_LINE')),
  source_id              uuid not null,
  parent_id              uuid not null,
  part_id                uuid,
  description            text,
  base_price_cents       bigint not null check (base_price_cents >= 0),
  requested_price_cents  bigint not null check (requested_price_cents >= 0),
  cost_cents             bigint,
  discount_pct           numeric(6,5) not null,
  below_cost             boolean not null default false,
  reason                 text not null check (char_length(btrim(reason)) between 3 and 300),
  status                 text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','AUTO_APPROVED','CANCELLED')),
  method                 text check (method is null or method in ('LIMIT','QUEUE','PIN')),
  requested_by           text default pm.current_user_id(),
  requested_membership   uuid,
  decided_by             text,
  decided_membership     uuid,
  decided_at             timestamptz,
  decision_note          text,
  created_at             timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists pm_dlr_price_overrides_pending_idx on pm.dlr_price_overrides (org_id, location_id, status, created_at desc);

-- The caller's (or a member's) persona keys at a company.
create or replace function pm._d5_role_keys(p_org uuid, p_location uuid, p_membership uuid) returns text[]
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(array_agg(distinct rd.key), '{}') from core.access_assignments aa join core.role_definitions rd on rd.id = aa.role_id
   where aa.org_id = p_org and aa.membership_id = p_membership and aa.status = 'active' and aa.grant_type = 'role'
     and (aa.scope_type = 'all_clients' or aa.location_id = p_location)
     and (aa.effective_to is null or aa.effective_to > now())
$$;

-- Allowed discount for a member at a company: the best limit among their roles (null = controls off).
create or replace function pm._d5_limit(p_org uuid, p_location uuid, p_membership uuid, out max_discount_pct numeric, out allow_below_cost boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from pm.dlr_price_limits l where l.org_id = p_org and l.location_id = p_location) then
    max_discount_pct := null; allow_below_cost := true; return;
  end if;
  select max(l.max_discount_pct), bool_or(l.allow_below_cost) into max_discount_pct, allow_below_cost
    from pm.dlr_price_limits l
   where l.org_id = p_org and l.location_id = p_location and (l.role_key = 'default' or l.role_key = any (pm._d5_role_keys(p_org, p_location, p_membership)));
  max_discount_pct := coalesce(max_discount_pct, 0); allow_below_cost := coalesce(allow_below_cost, false);
end $$;

create or replace function pm.dlr_set_price_limits(p_location uuid, p_rows jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); r jsonb; n int := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: limits are a list' using errcode = '22023'; end if;
  delete from pm.dlr_price_limits where org_id = v_org and location_id = p_location;
  for r in select value from jsonb_array_elements(p_rows) loop
    insert into pm.dlr_price_limits (org_id, location_id, role_key, max_discount_pct, allow_below_cost)
    values (v_org, p_location, btrim(r ->> 'role_key'), coalesce(pm._x_try_num(r ->> 'max_discount_pct'), 0), coalesce(pm._x_try_bool(r ->> 'allow_below_cost'), false));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Is this price within the caller's limit? (the screens ask before showing "needs a manager").
create or replace function pm._d5_price_allowed(p_location uuid, p_base_cents bigint, p_price_cents bigint, p_cost_cents bigint default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := (select l.org_id from core.locations l where l.id = p_location); lim record; v_disc numeric;
begin
  select * into lim from pm._d5_limit(v_org, p_location, core.client_scope_caller_membership());
  v_disc := case when coalesce(p_base_cents, 0) <= 0 then 0 else greatest(1 - p_price_cents::numeric / p_base_cents, 0) end;
  return jsonb_build_object('controls', lim.max_discount_pct is not null, 'max_discount_pct', lim.max_discount_pct, 'discount_pct', round(v_disc, 5),
    'below_cost', p_cost_cents is not null and p_price_cents < p_cost_cents,
    'allowed', lim.max_discount_pct is null or (v_disc <= lim.max_discount_pct + 0.00001 and (lim.allow_below_cost or p_cost_cents is null or p_price_cents >= p_cost_cents)));
end $$;

create or replace function pm.dlr_price_check(p_location uuid, p_base_cents bigint, p_price_cents bigint, p_cost_cents bigint default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  perform pm._x_org_of_location(p_location);
  return pm._d5_price_allowed(p_location, p_base_cents, p_price_cents, p_cost_cents);
end $$;

-- Refuse a client-supplied price below the member's own limit (security review H3): the definer RPCs
-- that take prices from the screen (findings, estimates, sublets, check-in) call this; over the limit
-- the member requests a price override instead.
create or replace function pm._d5_assert_price(p_location uuid, p_base bigint, p_price bigint, p_cost bigint, p_what text) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare chk jsonb;
begin
  if p_price is null or ((p_base is null or p_price >= p_base) and (p_cost is null or p_price >= p_cost)) then return; end if;
  if coalesce(current_setting('pm.d5_price_trusted', true), '') = 'on' then return; end if;
  chk := pm._d5_price_allowed(p_location, coalesce(p_base, p_cost), p_price, p_cost);
  if not coalesce((chk ->> 'allowed')::boolean, true) then
    raise exception 'PM_PRICE_OVERRIDE_REQUIRED: % at % off% is over your limit of %; request a price override', p_what,
      round(((chk ->> 'discount_pct')::numeric) * 100, 1) || '%', case when (chk ->> 'below_cost')::boolean then ' (below cost)' else '' end,
      coalesce(round(((chk ->> 'max_discount_pct')::numeric) * 100, 1) || '%', 'none') using errcode = '42501';
  end if;
end $$;

-- The store's posted labor rate (store setting labor_rate_cents; null = none posted).
create or replace function pm._d5_posted_labor_rate(p_org uuid, p_location uuid) returns bigint
language sql stable security definer
set search_path = pm, core, public
as $$ select pm._x_try_bigint(pm._d5_set(p_org, p_location) ->> 'labor_rate_cents') $$;

-- The line an override is about: (org, company, parent, part, base price, cost, current price, description).
create or replace function pm._d5_override_line(p_kind text, p_line uuid, out org_id uuid, out location_id uuid, out parent_id uuid, out part_id uuid,
                                                 out base_cents bigint, out cost_cents bigint, out price_cents bigint, out description text, out open boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare tl pm.parts_ticket_lines%rowtype; t pm.parts_tickets%rowtype; p pm.parts%rowtype; wl pm.work_order_lines%rowtype; w pm.work_orders%rowtype; pb pm.price_book_items%rowtype;
begin
  if p_kind = 'PARTS_TICKET_LINE' then
    select * into tl from pm.parts_ticket_lines x where x.id = p_line;
    select * into t from pm.parts_tickets x where x.org_id = tl.org_id and x.id = tl.ticket_id;
    select * into p from pm.parts x where x.org_id = tl.org_id and x.id = tl.part_id;
    org_id := tl.org_id; location_id := t.location_id; parent_id := t.id; part_id := p.id; base_cents := coalesce(p.price_cents, p.list_price_cents, tl.unit_price_cents);
    cost_cents := coalesce(tl.unit_cost_cents, p.cost_cents); price_cents := tl.unit_price_cents; description := coalesce(tl.description, p.description); open := t.status = 'OPEN';
  elsif p_kind = 'RO_LINE' then
    select * into wl from pm.work_order_lines x where x.id = p_line;
    select * into w from pm.work_orders x where x.org_id = wl.org_id and x.id = wl.work_order_id;
    if wl.part_id is not null then select * into p from pm.parts x where x.org_id = wl.org_id and x.id = wl.part_id; end if;
    if wl.price_book_item_id is not null then select * into pb from pm.price_book_items x where x.id = wl.price_book_item_id; end if;
    org_id := wl.org_id; location_id := w.location_id; parent_id := w.id; part_id := p.id;
    base_cents := coalesce(p.price_cents, p.list_price_cents, pb.price_cents, wl.unit_price_cents); cost_cents := coalesce(wl.unit_cost_cents, p.cost_cents, pb.cost_cents);
    price_cents := wl.unit_price_cents; description := wl.description; open := w.status not in ('CLOSED','CANCELLED');
  end if;
end $$;

create or replace function pm._d5_apply_override(o pm.dlr_price_overrides) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  perform set_config('pm.d5_price_override', o.id::text, true);
  perform set_config('pm.d5_price_trusted', 'on', true);
  if o.source_kind = 'PARTS_TICKET_LINE' then
    update pm.parts_ticket_lines set unit_price_cents = o.requested_price_cents, updated_at = now() where org_id = o.org_id and id = o.source_id;
  else
    update pm.work_order_lines set unit_price_cents = o.requested_price_cents, price_overridden = true, updated_at = now() where org_id = o.org_id and id = o.source_id;
  end if;
  perform set_config('pm.d5_price_override', '', true);
  perform set_config('pm.d5_price_trusted', '', true);
end $$;

create or replace function pm.dlr_request_price_override(p_kind text, p_line uuid, p_price_cents bigint, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_kind text := upper(coalesce(p_kind, '')); l record; lim record; v_disc numeric; v_below boolean; v_ok boolean; o pm.dlr_price_overrides%rowtype; v_me uuid := core.client_scope_caller_membership();
        v_rcpt uuid[];
begin
  if v_kind not in ('PARTS_TICKET_LINE','RO_LINE') then raise exception 'PM_INVALID: override a counter ticket line or an RO line' using errcode = '22023'; end if;
  select * into l from pm._d5_override_line(v_kind, p_line);
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: line not found' using errcode = '42501'; end if;
  if not l.open then raise exception 'PM_INVALID: that ticket / RO is closed' using errcode = '22023'; end if;
  if p_price_cents is null or p_price_cents < 0 then raise exception 'PM_INVALID: the price is ≥ 0' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or char_length(btrim(p_reason)) < 3 then raise exception 'PM_INVALID: give a reason for the price' using errcode = '22023'; end if;
  select * into lim from pm._d5_limit(l.org_id, l.location_id, v_me);
  v_disc := case when coalesce(l.base_cents, 0) <= 0 then 0 else greatest(1 - p_price_cents::numeric / l.base_cents, 0) end;
  v_below := l.cost_cents is not null and p_price_cents < l.cost_cents;
  v_ok := lim.max_discount_pct is null or (v_disc <= lim.max_discount_pct + 0.00001 and (lim.allow_below_cost or not v_below));
  insert into pm.dlr_price_overrides (org_id, location_id, source_kind, source_id, parent_id, part_id, description, base_price_cents, requested_price_cents, cost_cents,
                                      discount_pct, below_cost, reason, status, method, requested_membership, decided_by, decided_membership, decided_at)
  values (l.org_id, l.location_id, v_kind, p_line, l.parent_id, l.part_id, left(l.description, 300), coalesce(l.base_cents, 0), p_price_cents, l.cost_cents, round(v_disc, 5),
          v_below, btrim(p_reason), case when v_ok then 'AUTO_APPROVED' else 'PENDING' end, case when v_ok then 'LIMIT' end, v_me,
          case when v_ok then pm.current_user_id() end, case when v_ok then v_me end, case when v_ok then now() end)
  returning * into o;
  if v_ok then
    perform pm._d5_apply_override(o);
  else
    v_rcpt := array(select x from unnest(core.notify_members_with(l.org_id, l.location_id, 'projects.store', 'approve')) x where x is distinct from v_me);
    perform pm._d5_notify(l.org_id, l.location_id, null, 'approval.requested', 'dlr_price_override', o.id, v_rcpt,
      format('Price override to approve: %s', left(coalesce(l.description, 'line'), 80)), format('%s%% off. Reason: %s', round(v_disc * 100, 1), left(btrim(p_reason), 200)),
      '/stock/pricing', 'price_override:' || o.id::text);
  end if;
  return jsonb_build_object('override_id', o.id, 'status', o.status, 'discount_pct', o.discount_pct, 'below_cost', v_below, 'max_discount_pct', lim.max_discount_pct);
end $$;

create or replace function pm._d5_decide_override(o pm.dlr_price_overrides, p_approver uuid, p_decision text, p_note text, p_method text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare lim record; l record;
begin
  if o.status <> 'PENDING' then raise exception 'PM_INVALID: this override was already %', lower(o.status) using errcode = '22023'; end if;
  if p_approver is not distinct from o.requested_membership then
    raise exception 'PM_SOD_VIOLATION: the person who asked for the price cannot approve it' using errcode = '42501';
  end if;
  if not core.membership_has_capability(p_approver, 'projects.store', 'approve', o.location_id) then
    raise exception 'PM_FORBIDDEN: approving a price needs Dealer store approve' using errcode = '42501';
  end if;
  select * into l from pm._d5_override_line(o.source_kind, o.source_id);
  if not l.open then raise exception 'PM_INVALID: that ticket / RO is closed' using errcode = '22023'; end if;
  if upper(p_decision) = 'APPROVE' then
    select * into lim from pm._d5_limit(o.org_id, o.location_id, p_approver);
    if lim.max_discount_pct is not null and not ('projects_owner' = any (pm._d5_role_keys(o.org_id, o.location_id, p_approver)) or 'projects_gm' = any (pm._d5_role_keys(o.org_id, o.location_id, p_approver)))
       and (o.discount_pct > lim.max_discount_pct + 0.00001 or (o.below_cost and not lim.allow_below_cost)) then
      raise exception 'PM_FORBIDDEN: that discount is above your own limit; the GM or owner approves it' using errcode = '42501';
    end if;
    update pm.dlr_price_overrides set status = 'APPROVED', method = p_method, decided_by = pm.current_user_id(), decided_membership = p_approver, decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = o.id returning * into o;
    perform pm._d5_apply_override(o);
  else
    if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'PM_INVALID: say why the price was refused' using errcode = '22023'; end if;
    update pm.dlr_price_overrides set status = 'REJECTED', method = p_method, decided_by = pm.current_user_id(), decided_membership = p_approver, decided_at = now(),
           decision_note = btrim(p_note) where id = o.id returning * into o;
  end if;
  perform pm.log_activity(o.org_id, o.location_id, null, 'price_override.' || lower(o.status), 'dlr_price_overrides', o.id,
    format('Price override %s (%s%% off)', lower(o.status), round(o.discount_pct * 100, 1)), jsonb_build_object('method', p_method));
  return jsonb_build_object('override_id', o.id, 'status', o.status);
end $$;

create or replace function pm.dlr_decide_price_override(p_override uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.dlr_price_overrides%rowtype;
begin
  select * into o from pm.dlr_price_overrides x where x.id = p_override for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: override not found' using errcode = '42501'; end if;
  if upper(coalesce(p_decision, '')) not in ('APPROVE','REJECT') then raise exception 'PM_INVALID: approve or reject' using errcode = '22023'; end if;
  return pm._d5_decide_override(o, core.client_scope_caller_membership(), p_decision, p_note, 'QUEUE');
end $$;

-- Manager PINs (security review M2): 6 to 12 digits, stored as bcrypt (pgcrypto crypt + gen_salt('bf', 10),
-- resolved in the extensions or public schema). Wrong PINs count per manager (5 then 15 minutes) AND per
-- caller at the store (10 an hour, then that counter device's person is locked for an hour); every
-- miss notifies the manager whose PIN was tried.
create table if not exists pm.dlr_pin_attempts (
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  caller_membership  uuid not null,
  window_start       timestamptz not null default now(),
  failures           int not null default 0,
  locked_until       timestamptz,
  primary key (org_id, location_id, caller_membership)
);

-- Security review R9: legacy (pre-bcrypt) hashes are dropped; those managers set their PIN again.
delete from pm.dlr_manager_pins where pin_hash not like '$2%';

create or replace function pm._d5_crypt(p_text text, p_salt text) returns text
language plpgsql stable
set search_path = pm, public
as $$
declare v text;
begin
  if to_regprocedure('extensions.crypt(text,text)') is not null then
    execute 'select extensions.crypt($1, $2)' into v using p_text, p_salt;
  else
    execute 'select public.crypt($1, $2)' into v using p_text, p_salt;
  end if;
  return v;
end $$;

create or replace function pm._d5_bf_salt() returns text
language plpgsql volatile
set search_path = pm, public
as $$
declare v text;
begin
  if to_regprocedure('extensions.gen_salt(text,integer)') is not null then
    execute 'select extensions.gen_salt(''bf'', 10)' into v;
  else
    execute 'select public.gen_salt(''bf'', 10)' into v;
  end if;
  return v;
end $$;

create or replace function pm.dlr_set_manager_pin(p_pin text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_me uuid := core.client_scope_caller_membership(); v_org uuid := public.get_org_id();
begin
  if v_me is null or v_org is null then raise exception 'PM_FORBIDDEN: no membership' using errcode = '42501'; end if;
  if coalesce(p_pin, '') !~ '^[0-9]{6,12}$' then raise exception 'PM_INVALID: a manager PIN is 6 to 12 digits' using errcode = '22023'; end if;
  if p_pin ~ '^(.)\1+$' or position(p_pin in '0123456789012') > 0 or position(p_pin in '9876543210987') > 0 then
    raise exception 'PM_INVALID: pick a PIN that is not a run or a repeat' using errcode = '22023';
  end if;
  if not exists (select 1 from pm.my_location_ids('projects.store', 'approve')) then
    raise exception 'PM_FORBIDDEN: only people who approve store prices set a manager PIN' using errcode = '42501';
  end if;
  insert into pm.dlr_manager_pins as p (org_id, membership_id, pin_hash) values (v_org, v_me, pm._d5_crypt(p_pin, pm._d5_bf_salt()))
  on conflict (org_id, membership_id) do update set pin_hash = excluded.pin_hash, failed_count = 0, locked_until = null, set_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- The manager walks to the counter and types their PIN on this device: approves as that manager.
create or replace function pm.dlr_approve_override_pin(p_override uuid, p_manager uuid, p_pin text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.dlr_price_overrides%rowtype; pn pm.dlr_manager_pins%rowtype; at pm.dlr_pin_attempts%rowtype; v_me uuid := core.client_scope_caller_membership(); v_ok boolean;
begin
  select * into o from pm.dlr_price_overrides x where x.id = p_override for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: override not found' using errcode = '42501'; end if;
  if v_me is null then raise exception 'PM_FORBIDDEN: no membership' using errcode = '42501'; end if;
  insert into pm.dlr_pin_attempts (org_id, location_id, caller_membership) values (o.org_id, o.location_id, v_me) on conflict do nothing;
  select * into at from pm.dlr_pin_attempts x where x.org_id = o.org_id and x.location_id = o.location_id and x.caller_membership = v_me for update;
  if at.locked_until is not null and at.locked_until > now() then
    raise exception 'PM_KIOSK_LOCKED: too many wrong PINs from your seat at this store; wait an hour or ask the manager to approve in the queue' using errcode = '42501';
  end if;
  select * into pn from pm.dlr_manager_pins x where x.org_id = o.org_id and x.membership_id = p_manager for update;
  if pn.membership_id is null then raise exception 'PM_KIOSK_PIN: that manager has no PIN set' using errcode = '42501'; end if;
  if pn.locked_until is not null and pn.locked_until > now() then raise exception 'PM_KIOSK_LOCKED: too many tries; wait 15 minutes' using errcode = '42501'; end if;
  v_ok := pn.pin_hash like '$2%' and pn.pin_hash = pm._d5_crypt(coalesce(p_pin, ''), pn.pin_hash);
  if not v_ok then
    update pm.dlr_manager_pins set failed_count = failed_count + 1, locked_until = case when failed_count + 1 >= 5 then now() + interval '15 minutes' end
     where org_id = pn.org_id and membership_id = pn.membership_id;
    update pm.dlr_pin_attempts set
           failures = case when window_start < now() - interval '1 hour' then 1 else failures + 1 end,
           window_start = case when window_start < now() - interval '1 hour' then now() else window_start end,
           locked_until = case when (case when window_start < now() - interval '1 hour' then 1 else failures + 1 end) >= 10 then now() + interval '1 hour' end
     where org_id = at.org_id and location_id = at.location_id and caller_membership = at.caller_membership;
    perform pm._d5_notify(o.org_id, o.location_id, null, 'approval.requested', 'dlr_price_override', o.id, array[p_manager],
      'Wrong manager PIN at the counter',
      format('%s typed your PIN wrong approving a price override (%s). If that was not you, change your PIN.', coalesce(core.notify_member_name(v_me), 'Someone'),
             left(coalesce(o.description, 'a line'), 80)),
      '/stock/pricing', null);
    return jsonb_build_object('override_id', o.id, 'status', o.status, 'error', 'PIN_MISMATCH');
  end if;
  update pm.dlr_manager_pins set failed_count = 0, locked_until = null where org_id = pn.org_id and membership_id = pn.membership_id;
  return pm._d5_decide_override(o, p_manager, 'APPROVE', 'Manager PIN at the counter', 'PIN');
end $$;

-- Pending + recent overrides; discount pattern per person (z-score of average discount vs the store).
create or replace function pm.dlr_price_override_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean := pm._x_sees('projects.financials', 'view', p_location);
begin
  return jsonb_build_object(
    'limits', coalesce((select jsonb_agg(jsonb_build_object('role_key', l.role_key, 'max_discount_pct', l.max_discount_pct, 'allow_below_cost', l.allow_below_cost) order by l.role_key)
      from pm.dlr_price_limits l where l.org_id = v_org and l.location_id = p_location), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'source_kind', o.source_kind, 'parent_id', o.parent_id, 'description', o.description,
        'base_price_cents', o.base_price_cents, 'requested_price_cents', o.requested_price_cents, 'discount_pct', o.discount_pct, 'below_cost', o.below_cost,
        'cost_cents', case when v_fin then o.cost_cents end, 'reason', o.reason, 'requested_by', o.requested_by, 'requested_membership', o.requested_membership,
        'requester', core.notify_member_name(o.requested_membership), 'decided_by', core.notify_member_name(o.decided_membership), 'method', o.method,
        'decided_at', o.decided_at, 'decision_note', o.decision_note, 'created_at', o.created_at) order by (o.status = 'PENDING') desc, o.created_at desc)
      from pm.dlr_price_overrides o where o.org_id = v_org and o.location_id = p_location and (o.status = 'PENDING' or o.created_at > now() - interval '30 days')), '[]'::jsonb),
    'patterns', coalesce((with per as (
        select o.requested_membership m, count(*) n, avg(o.discount_pct) a from pm.dlr_price_overrides o
         where o.org_id = v_org and o.location_id = p_location and o.created_at > now() - interval '30 days' and o.status in ('APPROVED','AUTO_APPROVED') group by 1),
      st as (select avg(a) mu, coalesce(stddev_pop(a), 0) sd from per)
      select jsonb_agg(jsonb_build_object('person', core.notify_member_name(per.m), 'overrides', per.n, 'avg_discount_pct', round(per.a, 4),
                                          'unusual', st.sd > 0 and (per.a - st.mu) / st.sd > 2 and per.n >= 3) order by per.a desc)
        from per, st), '[]'::jsonb),
    'amounts_visible', v_fin);
end $$;

-- The price guard (security review H3 + R2). With limits configured at the store, every line write —
-- a member's own table write and every definer RPC acting for that member alike — is checked on its
-- EFFECTIVE amount (qty x unit price x (1 - discount)) against its base: the part's price, the price
-- book item's price, or for labor the store's posted rate x flag hours (qty when no flag hours). On an
-- update that changes the line's part / price book item, the base comes from the OLD reference (a line
-- cannot be re-pointed at a cheaper item). DISCOUNT lines are checked as their sum against the RO's
-- customer subtotal. Moving a customer line to warranty / internal — or adding a non-customer line to a
-- customer-paid RO — needs Dealer store approve (program-priced lines are not discounts, so they then
-- pass). Only trusted pricers skip it, by the transaction flag pm.d5_price_trusted (an approved override,
-- pm._d5_apply_override) and the backend (service role). Members cannot write the price columns directly
-- anyway (grants below): lines go through pm.add_work_order_line / pm.update_work_order_line.
drop function if exists pm._d5_line_base(uuid, uuid, text, uuid, uuid, numeric, numeric);
create or replace function pm._d5_line_base(p_org uuid, p_loc uuid, p_kind text, p_part uuid, p_pb uuid, p_qty numeric, p_flag numeric, p_uom text default null) returns bigint
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v bigint; v_rate bigint;
begin
  if p_part is not null then
    select coalesce(p.price_cents, p.list_price_cents) into v from pm.parts p where p.org_id = p_org and p.id = p_part;
    return case when v is null then null else round(coalesce(p_qty, 1) * v)::bigint end;
  elsif p_pb is not null then
    select b.price_cents into v from pm.price_book_items b where b.id = p_pb;
    return case when v is null then null else round(coalesce(p_qty, 1) * v)::bigint end;
  elsif p_kind = 'LABOR' or upper(coalesce(p_uom, '')) in ('HR','HOUR','HOURS') then
    v_rate := pm._d5_posted_labor_rate(p_org, p_loc);
    if v_rate is null then return null; end if;
    return pm.fs_rdiv(coalesce(nullif(p_flag, 0), p_qty, 1) * v_rate, 1);
  end if;
  return null;
end $$;

create or replace function pm.tg_d5_price_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_base bigint; v_amt bigint; chk jsonb; w pm.work_orders%rowtype; v_disc bigint; v_sub bigint;
begin
  if pm.access_is_service() or coalesce(current_setting('pm.d5_price_trusted', true), '') = 'on' then return new; end if;
  if public.get_org_id() is null then return new; end if;   -- no caller (migrations, maintenance)
  if tg_table_name = 'parts_ticket_lines' then
    if tg_op = 'UPDATE' and new.unit_price_cents is not distinct from old.unit_price_cents and new.part_id is not distinct from old.part_id then return new; end if;
    select t.location_id into v_loc from pm.parts_tickets t where t.org_id = new.org_id and t.id = new.ticket_id;
    if not exists (select 1 from pm.dlr_price_limits l where l.org_id = new.org_id and l.location_id = v_loc) then return new; end if;
    v_base := pm._d5_line_base(new.org_id, v_loc, 'PART', case when tg_op = 'UPDATE' and new.part_id is distinct from old.part_id then old.part_id else new.part_id end, null, 1, null);
    if v_base is null or new.unit_price_cents >= v_base then return new; end if;
    chk := pm._d5_price_allowed(v_loc, v_base, new.unit_price_cents, null);
  else
    if tg_op = 'UPDATE' and new.unit_price_cents is not distinct from old.unit_price_cents and new.discount_pct is not distinct from old.discount_pct
       and new.qty is not distinct from old.qty and new.pay_type is not distinct from old.pay_type and new.kind is not distinct from old.kind
       and new.flag_hours is not distinct from old.flag_hours and new.part_id is not distinct from old.part_id
       and new.price_book_item_id is not distinct from old.price_book_item_id and new.status is not distinct from old.status then
      return new;
    end if;
    select * into w from pm.work_orders x where x.org_id = new.org_id and x.id = new.work_order_id;
    v_loc := w.location_id;
    if not exists (select 1 from pm.dlr_price_limits l where l.org_id = new.org_id and l.location_id = v_loc) then return new; end if;
    -- pay type: a customer line moved off the customer, or a non-customer line on a customer-paid RO
    if coalesce(new.pay_type, 'CUSTOMER') <> 'CUSTOMER'
       and ((tg_op = 'UPDATE' and coalesce(old.pay_type, 'CUSTOMER') = 'CUSTOMER') or (tg_op = 'INSERT' and coalesce(w.payer_type, 'CUSTOMER') = 'CUSTOMER'))
       and not pm.access_can_location('projects.store', 'approve', v_loc) then
      raise exception 'PM_PRICE_OVERRIDE_REQUIRED: moving a customer line to % needs Dealer store approve', lower(new.pay_type) using errcode = '42501';
    end if;
    if coalesce(new.pay_type, 'CUSTOMER') <> 'CUSTOMER' then return new; end if;
    if new.kind = 'DISCOUNT' or exists (select 1 from pm.work_order_lines l where l.org_id = new.org_id and l.work_order_id = new.work_order_id and l.kind = 'DISCOUNT'
                                          and l.pay_type = 'CUSTOMER' and l.status = 'APPROVED' and l.id <> new.id) then
      select coalesce(sum(-l.amount_cents) filter (where l.kind = 'DISCOUNT'), 0), coalesce(sum(l.amount_cents) filter (where l.kind <> 'DISCOUNT'), 0) into v_disc, v_sub
        from pm.work_order_lines l where l.org_id = new.org_id and l.work_order_id = new.work_order_id and l.pay_type = 'CUSTOMER' and l.status = 'APPROVED' and l.id <> new.id;
      if new.status = 'APPROVED' then
        v_amt := round(new.qty * coalesce(new.unit_price_cents, 0) * (1 - coalesce(new.discount_pct, 0)))::bigint;
        if new.kind = 'DISCOUNT' then v_disc := v_disc - v_amt; else v_sub := v_sub + v_amt; end if;
      end if;
      if v_disc > 0 then
        chk := pm._d5_price_allowed(v_loc, greatest(v_sub, 0), greatest(v_sub - v_disc, 0), null);
        if not coalesce((chk ->> 'allowed')::boolean, true) then
          raise exception 'PM_PRICE_OVERRIDE_REQUIRED: the RO''s discounts are % of the customer total, over your limit of %; request a price override',
            round(((chk ->> 'discount_pct')::numeric) * 100, 1) || '%', round(((chk ->> 'max_discount_pct')::numeric) * 100, 1) || '%' using errcode = '42501';
        end if;
      end if;
      if new.kind = 'DISCOUNT' then return new; end if;
    end if;
    if new.unit_price_cents is null then return new; end if;
    if tg_op = 'UPDATE' and (new.part_id is distinct from old.part_id or new.price_book_item_id is distinct from old.price_book_item_id) then
      v_base := pm._d5_line_base(new.org_id, v_loc, old.kind, old.part_id, old.price_book_item_id, new.qty, new.flag_hours, old.uom);
    else
      v_base := pm._d5_line_base(new.org_id, v_loc, new.kind, new.part_id, new.price_book_item_id, new.qty, new.flag_hours, new.uom);
    end if;
    v_amt := round(new.qty * new.unit_price_cents * (1 - coalesce(new.discount_pct, 0)))::bigint;
    if v_base is null or v_amt >= v_base then return new; end if;
    chk := pm._d5_price_allowed(v_loc, v_base, v_amt, null);
  end if;
  if not coalesce((chk ->> 'allowed')::boolean, true) then
    raise exception 'PM_PRICE_OVERRIDE_REQUIRED: % off is over your limit of %; request a price override', round(((chk ->> 'discount_pct')::numeric) * 100, 1) || '%',
      round(((chk ->> 'max_discount_pct')::numeric) * 100, 1) || '%' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_price_guard on pm.parts_ticket_lines;
create trigger trg_d5_price_guard before insert or update on pm.parts_ticket_lines for each row execute function pm.tg_d5_price_guard();
drop trigger if exists trg_d5_price_guard on pm.work_order_lines;
create trigger trg_d5_price_guard before insert or update on pm.work_order_lines for each row execute function pm.tg_d5_price_guard();

-- Security review R2: members write RO / work-order lines only through the guarded RPCs below (the
-- descriptive columns stay member-editable; delete stays as 1104 granted it).
revoke insert, delete on pm.work_order_lines from authenticated;
revoke update (kind, price_book_item_id, item_id, qty, unit_price_cents, unit_cost_cents, discount_pct, labor_minutes, flag_hours, pay_type, part_id)
  on pm.work_order_lines from authenticated;

-- Parts already issued to the RO from stock (1109 issue_ro_parts sets issued_move_id): the line cannot be
-- deleted or its quantity cut below what was issued — return the parts first (security review R2-b).
create or replace function pm.tg_d5_issued_line_lock() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_issued numeric;
begin
  if old.issued_move_id is null or pm.access_is_service() then return case when tg_op = 'DELETE' then old else new end; end if;
  if tg_op = 'UPDATE' and new.issued_move_id is not distinct from old.issued_move_id then
    select m.qty into v_issued from pm.material_moves m where m.org_id = old.org_id and m.id = old.issued_move_id;
    if new.qty < coalesce(v_issued, old.qty) then
      raise exception 'PM_PARTS_ISSUED: % were issued from stock to this line; return the parts first', coalesce(v_issued, old.qty) using errcode = '55000';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'PM_PARTS_ISSUED: parts on this line were issued from stock; return the parts first' using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_issued_line_lock on pm.work_order_lines;
create trigger trg_d5_issued_line_lock before update or delete on pm.work_order_lines for each row execute function pm.tg_d5_issued_line_lock();

-- Remove a line (security review R2-b): deleting an approved customer line is a 100% discount, so at a store
-- with discount limits it needs Dealer store approve or an approved price override on that line.
create or replace function pm.remove_work_order_line(p_line uuid, p_wo uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype;
begin
  select * into l from pm.work_order_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: line not found' using errcode = '42501'; end if;
  if p_wo is not null and l.work_order_id is distinct from p_wo then raise exception 'PM_NOT_FOUND: that line is not on this work order' using errcode = 'P0002'; end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if l.issued_move_id is not null then raise exception 'PM_PARTS_ISSUED: parts on this line were issued from stock; return the parts first' using errcode = '55000'; end if;
  if l.status = 'APPROVED' and l.pay_type = 'CUSTOMER' and l.kind <> 'DISCOUNT' and coalesce(l.amount_cents, 0) > 0
     and exists (select 1 from pm.dlr_price_limits x where x.org_id = l.org_id and x.location_id = w.location_id)
     and not pm.access_can_location('projects.store', 'approve', w.location_id)
     and not exists (select 1 from pm.dlr_price_overrides o where o.org_id = l.org_id and o.source_kind = 'RO_LINE' and o.source_id = l.id
                       and o.status in ('APPROVED','AUTO_APPROVED') and o.requested_price_cents = 0) then
    raise exception 'PM_PRICE_OVERRIDE_REQUIRED: removing a charged line needs Dealer store approve (or an approved override to $0)' using errcode = '42501';
  end if;
  delete from pm.work_order_lines where id = l.id;
  return l.id;
end $$;

-- Add a line to a work order / RO (the line editors of /work-orders and the dealer RO screen). The price
-- guard trigger checks it as the caller; the price book fills price + cost when no price is given (1104).
create or replace function pm.add_work_order_line(p_wo uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_kind text := upper(coalesce(nullif(a ->> 'kind', ''), 'SERVICE')); v_id uuid; v_sort int;
        v_part uuid := pm.access_try_uuid(a ->> 'part_id'); v_pb uuid := pm.access_try_uuid(a ->> 'price_book_item_id'); v_sl uuid := pm.access_try_uuid(a ->> 'stock_location_id');
        v_qty numeric := coalesce(pm._x_try_num(a ->> 'qty'), 1); v_price bigint := pm._x_try_bigint(a ->> 'unit_price_cents'); v_status text := upper(coalesce(nullif(a ->> 'status', ''), 'APPROVED'));
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: work order not found' using errcode = '42501'; end if;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if v_kind not in ('SERVICE','PART','LABOR','EQUIPMENT','FEE','DISCOUNT','SUBLET','FREIGHT','MISC') then raise exception 'PM_INVALID: line kind %', v_kind using errcode = '22023'; end if;
  if v_status not in ('APPROVED','PROPOSED') then raise exception 'PM_INVALID: a new line is approved or proposed' using errcode = '22023'; end if;
  if v_qty <= 0 then raise exception 'PM_INVALID: quantity must be above zero' using errcode = '22023'; end if;
  if v_kind <> 'DISCOUNT' and v_price is not null and v_price < 0 then raise exception 'PM_INVALID: only a discount line can be negative' using errcode = '22023'; end if;
  if v_part is not null and not exists (select 1 from pm.parts p where p.org_id = w.org_id and p.id = v_part and p.location_id = w.location_id) then
    raise exception 'PM_INVALID: that part is not stocked at this company' using errcode = '22023';
  end if;
  if v_pb is not null and not exists (select 1 from pm.price_book_items b where b.org_id = w.org_id and b.id = v_pb) then
    raise exception 'PM_INVALID: that price book item is not in this organization' using errcode = '22023';
  end if;
  if v_sl is not null and not exists (select 1 from pm.stock_locations s where s.org_id = w.org_id and s.id = v_sl and s.location_id = w.location_id) then
    raise exception 'PM_INVALID: that stock location is not at this company' using errcode = '22023';
  end if;
  if v_pb is null and nullif(btrim(coalesce(a ->> 'description', '')), '') is null then raise exception 'PM_INVALID: describe the line' using errcode = '22023'; end if;
  -- round 3 (Low): at a store with discount limits a customer SERVICE line is priced from the price book
  -- (a free-typed service price has no base to check against)
  if v_kind = 'SERVICE' and v_pb is null and upper(coalesce(nullif(a ->> 'pay_type', ''), 'CUSTOMER')) = 'CUSTOMER'
     and exists (select 1 from pm.dlr_price_limits l where l.org_id = w.org_id and l.location_id = w.location_id) then
    raise exception 'PM_INVALID: pick the service from the price book at this store' using errcode = '22023';
  end if;
  if pm._x_try_bigint(a ->> 'unit_cost_cents') is not null and not pm._x_sees('projects.financials', 'edit', w.location_id, w.job_id) then
    raise exception 'PM_FORBIDDEN: entering a line cost needs Job financials edit' using errcode = '42501';
  end if;
  select coalesce(max(l.sort), -1) + 1 into v_sort from pm.work_order_lines l where l.org_id = w.org_id and l.work_order_id = w.id;
  insert into pm.work_order_lines (org_id, job_id, work_order_id, sort, kind, price_book_item_id, description, qty, uom, unit_price_cents, unit_cost_cents,
                                   discount_pct, pay_type, option_group, status, flag_hours, labor_op, part_id, stock_location_id, created_by)
  values (w.org_id, w.job_id, w.id, v_sort, v_kind, v_pb, coalesce(nullif(btrim(a ->> 'description'), ''), (select b.name from pm.price_book_items b where b.id = v_pb), 'Line'),
          v_qty, coalesce(nullif(a ->> 'uom', ''), case when v_kind = 'LABOR' then 'HR' else 'EA' end), v_price, pm._x_try_bigint(a ->> 'unit_cost_cents'),
          coalesce(pm._x_try_num(a ->> 'discount_pct'), 0), upper(coalesce(nullif(a ->> 'pay_type', ''), 'CUSTOMER')), nullif(a ->> 'option_group', ''), v_status,
          pm._x_try_num(a ->> 'flag_hours'), nullif(a ->> 'labor_op', ''), v_part, v_sl, pm.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Change a line's money fields (qty, price, discount, pay type, flag hours, cost) and description / labor op.
create or replace function pm.update_work_order_line(p_line uuid, p_patch jsonb, p_wo uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype; p jsonb := coalesce(p_patch, '{}'); k text;
begin
  select * into l from pm.work_order_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: line not found' using errcode = '42501'; end if;
  if p_wo is not null and l.work_order_id is distinct from p_wo then raise exception 'PM_NOT_FOUND: that line is not on this work order' using errcode = 'P0002'; end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('qty','unit_price_cents','discount_pct','pay_type','description','flag_hours','labor_op','unit_cost_cents') then
      raise exception 'PM_INVALID: % is not changed here', k using errcode = '22023';
    end if;
  end loop;
  if p ? 'unit_cost_cents' and not pm._x_sees('projects.financials', 'edit', w.location_id, w.job_id) then
    raise exception 'PM_FORBIDDEN: changing a line cost needs Job financials edit' using errcode = '42501';
  end if;
  if p ? 'unit_price_cents' and l.kind <> 'DISCOUNT' and pm._x_try_bigint(p ->> 'unit_price_cents') < 0 then
    raise exception 'PM_INVALID: only a discount line can be negative' using errcode = '22023';
  end if;
  update pm.work_order_lines set
    qty              = case when p ? 'qty' then coalesce(pm._x_try_num(p ->> 'qty'), qty) else qty end,
    unit_price_cents = case when p ? 'unit_price_cents' then pm._x_try_bigint(p ->> 'unit_price_cents') else unit_price_cents end,
    discount_pct     = case when p ? 'discount_pct' then coalesce(pm._x_try_num(p ->> 'discount_pct'), 0) else discount_pct end,
    pay_type         = case when p ? 'pay_type' then upper(p ->> 'pay_type') else pay_type end,
    description      = case when nullif(btrim(coalesce(p ->> 'description', '')), '') is not null then left(btrim(p ->> 'description'), 300) else description end,
    flag_hours       = case when p ? 'flag_hours' then pm._x_try_num(p ->> 'flag_hours') else flag_hours end,
    labor_op         = case when p ? 'labor_op' then nullif(p ->> 'labor_op', '') else labor_op end,
    unit_cost_cents  = case when p ? 'unit_cost_cents' then pm._x_try_bigint(p ->> 'unit_cost_cents') else unit_cost_cents end,
    updated_at       = now()
  where id = l.id;
  return l.id;
end $$;

-- DLR-80: day-end / month-end close checklist and the sign-off.
create table if not exists pm.dlr_close_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  kind         text not null check (kind in ('DAY','MONTH')),
  period       date not null,
  items        jsonb not null check (jsonb_typeof(items) = 'array'),
  open_count   int not null default 0,
  note         text,
  signed_by    text default pm.current_user_id(),
  signed_at    timestamptz not null default now(),
  unique (org_id, id)
);
-- Every sign-off is kept (security review L7): a re-sign adds a row; the checklist shows the latest.
alter table pm.dlr_close_runs drop constraint if exists dlr_close_runs_org_id_location_id_kind_period_key;
create index if not exists pm_dlr_close_runs_period_idx on pm.dlr_close_runs (org_id, location_id, kind, period, signed_at desc);

create or replace function pm.dlr_store_close_checklist(p_location uuid, p_kind text default 'DAY', p_date date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_kind text := upper(coalesce(p_kind, 'DAY')); v_day date := coalesce(p_date, current_date);
        v_items jsonb := '[]'; n int; v_period jsonb; v_status text; v_mstart date; v_mend date; v_partials jsonb := '[]';
begin
  if v_kind not in ('DAY','MONTH') then raise exception 'PM_INVALID: close a day or a month' using errcode = '22023'; end if;
  v_mstart := date_trunc('month', v_day)::date; v_mend := (date_trunc('month', v_day) + interval '1 month - 1 day')::date;
  select count(*) into n from pm.parts_tickets t where t.org_id = v_org and t.location_id = p_location and t.status = 'OPEN' and t.created_at::date <= v_day;
  v_items := v_items || jsonb_build_object('key', 'open_tickets', 'label', 'Open counter tickets', 'count', n, 'ok', n = 0, 'link', '/parts/counter');
  select count(*) into n from pm.dlr_drawer_sessions s where s.org_id = v_org and s.location_id = p_location and s.status = 'OPEN';
  v_items := v_items || jsonb_build_object('key', 'drawers_open', 'label', 'Drawers still open', 'count', n, 'ok', n = 0, 'link', '/stock/drawer');
  select count(*) into n from pm.dlr_drawer_sessions s where s.org_id = v_org and s.location_id = p_location and s.status = 'CLOSED' and s.variance_flag
     and s.business_date between case when v_kind = 'MONTH' then v_mstart else v_day end and case when v_kind = 'MONTH' then v_mend else v_day end;
  v_items := v_items || jsonb_build_object('key', 'drawer_variances', 'label', 'Drawers closed with a flagged variance', 'count', n, 'ok', n = 0, 'link', '/stock/drawer');
  select count(*) into n from pm.dlr_drawer_sessions s where s.org_id = v_org and s.location_id = p_location and s.status = 'CLOSED' and s.variance_flag and s.variance_note is null
     and s.business_date between case when v_kind = 'MONTH' then v_mstart else v_day end and case when v_kind = 'MONTH' then v_mend else v_day end;
  v_items := v_items || jsonb_build_object('key', 'drawer_variances_unexplained', 'label', 'Flagged drawer variances not explained yet', 'count', n, 'ok', n = 0, 'link', '/stock/drawer');
  select coalesce(jsonb_agg(p order by p ->> 'source_kind', p ->> 'number'), '[]'::jsonb) into v_partials from (
    select jsonb_build_object('source_kind', x.source_kind, 'source_id', x.source_id,
             'number', coalesce((select w.number from pm.work_orders w where w.id = x.source_id), (select d.number from pm.dealer_deals d where d.id = x.source_id),
                                (select r.number from pm.rental_contracts r where r.id = x.source_id), (select o.number from pm.parts_special_orders o where o.id = x.source_id)),
             'paid_cents', x.paid, 'due_cents', x.due, 'balance_cents', x.due - x.paid) p
      from (select e.source_kind, e.source_id, sum(e.amount_cents)::bigint paid, pm._d5_source_due(v_org, e.source_kind, e.source_id) due
              from pm.dlr_drawer_entries e join pm.dlr_drawer_sessions s on s.org_id = e.org_id and s.id = e.session_id
             where e.org_id = v_org and s.location_id = p_location and e.source_kind in ('REPAIR_ORDER','DEAL_DEPOSIT','RENTAL','SPECIAL_ORDER') and e.source_id is not null
               and s.business_date between case when v_kind = 'MONTH' then v_mstart else v_day end and case when v_kind = 'MONTH' then v_mend else v_day end
             group by 1, 2) x
     where x.due is not null and x.paid < x.due) q;
  v_items := v_items || jsonb_build_object('key', 'partial_payments', 'label', 'Records paid in part (balance still due)', 'count', jsonb_array_length(v_partials),
                                           'ok', jsonb_array_length(v_partials) = 0, 'link', '/stock/drawer');
  select count(*) into n from pm.parts_tickets t
   where t.org_id = v_org and t.location_id = p_location and t.status = 'CLOSED' and t.payment_method in ('CASH','CHECK')
     and t.closed_at::date between case when v_kind = 'MONTH' then v_mstart else v_day end and case when v_kind = 'MONTH' then v_mend else v_day end
     and not exists (select 1 from pm.dlr_drawer_entries e where e.org_id = t.org_id and e.source_kind = 'PARTS_TICKET' and e.source_id = t.id);
  v_items := v_items || jsonb_build_object('key', 'cash_outside_drawer', 'label', 'Cash / check tickets not in a drawer', 'count', n, 'ok', n = 0, 'link', '/stock/drawer');
  select count(*) into n from pm.dealer_deals d left join pm.dealer_outbox o on o.org_id = d.org_id and o.id = d.finalized_outbox_id
   where d.org_id = v_org and d.location_id = p_location and d.stage = 'DELIVERED' and (o.id is null or o.status in ('HELD','REJECTED'));
  v_items := v_items || jsonb_build_object('key', 'unposted_deals', 'label', 'Delivered deals not posted to Books', 'count', n, 'ok', n = 0, 'link', '/deals');
  select count(*) into n from pm.dealer_outbox o where o.org_id = v_org and o.location_id = p_location and o.status = 'REJECTED';
  v_items := v_items || jsonb_build_object('key', 'rejected_events', 'label', 'Store events Books rejected', 'count', n, 'ok', n = 0, 'link', '/stock/settings');
  select count(*) into n from pm.work_orders w left join pm.dlr_ro_state s on s.org_id = w.org_id and s.work_order_id = w.id
   where w.org_id = v_org and w.location_id = p_location and w.kind in ('REPAIR_ORDER','PDI') and w.status not in ('CLOSED','CANCELLED')
     and (w.status = 'COMPLETE' or s.stage in ('READY','QC','PICKED_UP') or (v_kind = 'MONTH' and w.promised_on <= v_mend));
  v_items := v_items || jsonb_build_object('key', 'ros_to_close', 'label', case when v_kind = 'MONTH' then 'ROs to close before the cutoff' else 'Finished ROs not closed' end,
                                           'count', n, 'ok', n = 0, 'link', '/work-orders/service');
  select count(*) into n from pm.warranty_claims c join core.jobs j on j.id = c.job_id
   where c.org_id = v_org and j.location_id = p_location and c.status in ('DRAFT','RETURNED') and coalesce(c.submit_by, c.filing_deadline) <= v_day + 7;
  v_items := v_items || jsonb_build_object('key', 'claims_due', 'label', 'Warranty claims due within 7 days', 'count', n, 'ok', n = 0, 'link', '/warranty');
  select count(*) into n from pm.dlr_incentive_claims c where c.org_id = v_org and c.location_id = p_location and c.status = 'DUE' and c.claim_by <= v_day + 7;
  v_items := v_items || jsonb_build_object('key', 'incentives_due', 'label', 'OEM program claims due within 7 days', 'count', n, 'ok', n = 0, 'link', '/stock/incentives');
  select count(*) into n from jsonb_array_elements(pm.dlr_cit_board(p_location)) x where (x ->> 'stale')::boolean;
  v_items := v_items || jsonb_build_object('key', 'contracts_in_transit', 'label', 'Contracts in transit past the store''s limit', 'count', n, 'ok', n = 0, 'link', '/deals/funding');
  n := pm._d5_cycle_due(v_org, p_location);
  v_items := v_items || jsonb_build_object('key', 'rental_cycle_billing', 'label', 'Rentals due for cycle billing', 'count', n, 'ok', n = 0, 'link', '/rentals');
  select count(*) into n from jsonb_array_elements(pm.dlr_special_order_board(p_location)) x where (x ->> 'stale')::boolean;
  v_items := v_items || jsonb_build_object('key', 'special_orders_stale', 'label', 'Special orders waiting too long for pickup', 'count', n, 'ok', n = 0, 'link', '/parts/special-orders');
  select count(*) into n from pm.dlr_price_overrides o where o.org_id = v_org and o.location_id = p_location and o.status = 'PENDING';
  v_items := v_items || jsonb_build_object('key', 'price_overrides', 'label', 'Price overrides waiting for a manager', 'count', n, 'ok', n = 0, 'link', '/stock/pricing');
  -- Books period status (read-only; Books blocks back-dating into a closed period)
  v_status := null;
  if to_regclass('public.fiscal_periods') is not null then
    execute 'select f.status::text from public.fiscal_periods f where f.org_id = $1 and f.location_id = $2 and $3 between f.start_date and f.end_date limit 1'
      into v_status using v_org, p_location, v_day;
  end if;
  v_period := jsonb_build_object('available', to_regclass('public.fiscal_periods') is not null, 'status', coalesce(v_status, 'NOT_SET_UP'), 'month_start', v_mstart, 'month_end', v_mend);
  return jsonb_build_object('kind', v_kind, 'date', v_day, 'items', v_items, 'open', (select count(*) from jsonb_array_elements(v_items) x where not (x ->> 'ok')::boolean),
    'books_period', v_period, 'partials', v_partials,
    'signed', (select jsonb_build_object('by', r.signed_by, 'at', r.signed_at, 'note', r.note, 'open_count', r.open_count) from pm.dlr_close_runs r
                where r.org_id = v_org and r.location_id = p_location and r.kind = v_kind and r.period = case when v_kind = 'MONTH' then v_mstart else v_day end
                order by r.signed_at desc limit 1),
    'history', coalesce((select jsonb_agg(jsonb_build_object('by', r.signed_by, 'at', r.signed_at, 'note', r.note, 'open_count', r.open_count) order by r.signed_at desc)
                from pm.dlr_close_runs r where r.org_id = v_org and r.location_id = p_location and r.kind = v_kind
                 and r.period = case when v_kind = 'MONTH' then v_mstart else v_day end), '[]'::jsonb));
end $$;

create or replace function pm.dlr_sign_store_close(p_location uuid, p_kind text, p_date date default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); chk jsonb; v_kind text := upper(coalesce(p_kind, 'DAY')); v_period date; v_open int;
begin
  chk := pm.dlr_store_close_checklist(p_location, v_kind, p_date);
  v_open := (chk ->> 'open')::int;
  if exists (select 1 from jsonb_array_elements(chk -> 'items') x where x ->> 'key' = 'drawers_open' and not (x ->> 'ok')::boolean) then
    raise exception 'PM_INVALID: close every drawer before signing the store close' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(chk -> 'items') x where x ->> 'key' = 'drawer_variances_unexplained' and not (x ->> 'ok')::boolean) then
    raise exception 'PM_INVALID: explain every flagged drawer variance before signing the store close' using errcode = '22023';
  end if;
  if v_open > 0 and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'PM_INVALID: % item(s) are still open; add a note to sign anyway', v_open using errcode = '22023';
  end if;
  v_period := case when v_kind = 'MONTH' then date_trunc('month', coalesce(p_date, current_date))::date else coalesce(p_date, current_date) end;
  insert into pm.dlr_close_runs (org_id, location_id, kind, period, items, open_count, note)
  values (v_org, p_location, v_kind, v_period, chk -> 'items', v_open, nullif(btrim(coalesce(p_note, '')), ''));
  return pm.dlr_store_close_checklist(p_location, v_kind, p_date);
end $$;

-- ----------------------------------------------------------------------------
-- D11. Store configuration reads / writes for the completion screens
-- ----------------------------------------------------------------------------
create or replace function pm.dlr_save_shop_fee_rule(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid;
begin
  insert into pm.dlr_shop_fee_rules as r (org_id, location_id, code, label, kind, basis, pct, amount_cents, min_cents, cap_cents, pay_types, is_active)
  values (v_org, p_location, upper(btrim(a ->> 'code')), btrim(a ->> 'label'), upper(coalesce(a ->> 'kind', 'SHOP_SUPPLIES')), upper(coalesce(a ->> 'basis', 'PCT_LABOR')),
          coalesce(pm._x_try_num(a ->> 'pct'), 0), coalesce(pm._x_try_bigint(a ->> 'amount_cents'), 0), coalesce(pm._x_try_bigint(a ->> 'min_cents'), 0),
          pm._x_try_bigint(a ->> 'cap_cents'), coalesce(array(select upper(x) from jsonb_array_elements_text(coalesce(a -> 'pay_types', '["CUSTOMER"]'::jsonb)) x), '{CUSTOMER}'),
          coalesce(pm._x_try_bool(a ->> 'is_active'), true))
  on conflict (org_id, location_id, code) do update set label = excluded.label, kind = excluded.kind, basis = excluded.basis, pct = excluded.pct,
    amount_cents = excluded.amount_cents, min_cents = excluded.min_cents, cap_cents = excluded.cap_cents, pay_types = excluded.pay_types, is_active = excluded.is_active
  returning id into v_id;
  return v_id;
end $$;

-- Everything the store settings screen of the completion work shows, in one read.
create or replace function pm.dlr_store_config(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return jsonb_build_object('settings', pm._d5_set(v_org, p_location),
    'capacity', coalesce((select jsonb_object_agg(c.weekday::text, c.tech_hours) from pm.dlr_service_capacity c where c.org_id = v_org and c.location_id = p_location), '{}'::jsonb),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('day', o.day, 'tech_hours', o.tech_hours, 'note', o.note) order by o.day) from pm.dlr_capacity_overrides o
                            where o.org_id = v_org and o.location_id = p_location and o.day >= current_date), '[]'::jsonb),
    'fee_rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'label', r.label, 'kind', r.kind, 'basis', r.basis, 'pct', r.pct, 'amount_cents', r.amount_cents,
        'min_cents', r.min_cents, 'cap_cents', r.cap_cents, 'pay_types', to_jsonb(r.pay_types), 'is_active', r.is_active) order by r.code)
      from pm.dlr_shop_fee_rules r where r.org_id = v_org and r.location_id = p_location), '[]'::jsonb),
    'registers', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'is_active', r.is_active) order by r.code)
      from pm.dlr_registers r where r.org_id = v_org and r.location_id = p_location), '[]'::jsonb),
    'price_limits', coalesce((select jsonb_agg(jsonb_build_object('role_key', l.role_key, 'max_discount_pct', l.max_discount_pct, 'allow_below_cost', l.allow_below_cost) order by l.role_key)
      from pm.dlr_price_limits l where l.org_id = v_org and l.location_id = p_location), '[]'::jsonb),
    'fleet_pm_rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label, 'model', r.model, 'category', r.category, 'asset_id', r.asset_id,
        'every_hours', r.every_hours, 'every_days', r.every_days, 'est_hours', r.est_hours, 'checklist', r.checklist, 'is_active', r.is_active) order by r.label)
      from pm.dlr_fleet_pm_rules r where r.org_id = v_org and r.location_id = p_location), '[]'::jsonb),
    'rental_rates', coalesce((select jsonb_agg(jsonb_build_object('id', rt.id, 'label', rt.label, 'model', rt.model, 'category', rt.category, 'day_cents', rt.day_cents,
        'week_cents', rt.week_cents, 'month_cents', rt.month_cents, 'ext', (select to_jsonb(e) - 'org_id' - 'rate_id' from pm.dlr_rental_rate_ext e where e.rate_id = rt.id)) order by rt.label nulls last)
      from pm.rental_rates rt where rt.org_id = v_org and rt.location_id = p_location and rt.is_active), '[]'::jsonb),
    'my_pin_set', exists (select 1 from pm.dlr_manager_pins p where p.org_id = v_org and p.membership_id = core.client_scope_caller_membership()));
end $$;

-- The yard board: open shipments, the open lot count, open recons, re-rent holds.
create or replace function pm.dlr_yard_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return jsonb_build_object(
    'shipments', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'number', s.number, 'status', s.status, 'vendor', (select v.name from core.vendors v where v.id = s.vendor_id),
        'invoice_ref', s.invoice_ref, 'ship_ref', s.ship_ref, 'source', s.source, 'expected_on', s.expected_on, 'received_at', s.received_at, 'summary', s.summary,
        'lines', (select count(*) from pm.dlr_shipment_lines l where l.org_id = s.org_id and l.shipment_id = s.id),
        'scanned', (select count(*) from pm.dlr_shipment_lines l where l.org_id = s.org_id and l.shipment_id = s.id and l.status in ('SCANNED','DAMAGED','EXTRA','RECEIVED'))) order by s.created_at desc)
      from pm.dlr_shipments s where s.org_id = v_org and s.location_id = p_location and (s.status = 'OPEN' or s.created_at > now() - interval '30 days')), '[]'::jsonb),
    'lot_audit', (select jsonb_build_object('id', a.id, 'number', a.number, 'purpose', a.purpose, 'started_at', a.started_at,
        'scans', (select count(*) from pm.dlr_lot_scans s where s.org_id = a.org_id and s.audit_id = a.id)) from pm.dlr_lot_audits a
       where a.org_id = v_org and a.location_id = p_location and a.status = 'OPEN' limit 1),
    'past_audits', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'number', a.number, 'purpose', a.purpose, 'closed_at', a.closed_at, 'summary', a.summary) order by a.closed_at desc)
      from (select * from pm.dlr_lot_audits x where x.org_id = v_org and x.location_id = p_location and x.status = 'CLOSED' order by x.closed_at desc limit 10) a), '[]'::jsonb),
    'recons', pm.dlr_recon_board(p_location),
    'rerent_holds', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'unit_id', h.asset_id, 'unit', pm._d5_unit_label(h.asset_id), 'since', h.created_at) order by h.created_at)
      from pm.dlr_rerent_holds h where h.org_id = v_org and h.location_id = p_location and h.status = 'OPEN'), '[]'::jsonb));
end $$;

-- ============================================================================
-- 17. Phone follow-ups: device-time tech punches + the 3C story on RO lines
-- ============================================================================
-- The technician phone queues taps offline, so a punch can reach the server minutes or days after
-- the tech tapped it. pm.dlr_clock_on / dlr_clock_indirect (1122) take p_at (the tap time) and
-- dlr_clock_off takes p_end_at. Bounds (security review H1):
--   * up to 10 minutes ahead of the server is clock skew and is clamped to now; more is refused
--     (PM_CLOCK_AHEAD);
--   * the tech's OWN tap may be at most 72 hours old (PM_PUNCH_STALE beyond: the service manager
--     enters it); ANY tap older than 15 minutes (own or manager-entered, R7) is a LATE TAP: ADJUSTED (never
--     restored to PHONE / KIOSK), flagged late_tap with the minutes it was late, and so is the time
--     entry it produces; approving that entry needs an individual acknowledgment
--     (pm.dlr_ack_late_time, then the approval path); a late tap into a week that already has approved time for the
--     tech is refused (PM_TIME_WEEK_LOCKED);
--   * a manager entering ANOTHER tech's time (projects.dispatch:edit / time:approve) may go back 35
--     days; a corrected end time on someone else's punch still needs projects.dispatch:edit (1122
--     security review L1) — the 1122 rule is relaxed for the tech's own punch only inside the 72 h
--     late-flagged window;
--   * a tap that would overlap a punch already recorded later for the same tech is refused
--     (PM_PUNCH_OVERLAP) instead of rewriting the timeline.
-- The punch keeps the effective time (started_at / ended_at), the raw device time (start_device_at
-- / end_device_at) and when it arrived (start_received_at / end_received_at).
-- The 2-argument dlr_clock_on / 3-argument dlr_clock_indirect are dropped so PostgREST named calls
-- stay unambiguous; every existing caller (no p_at) keeps working through the default.
alter table pm.dlr_tech_punches add column if not exists start_device_at   timestamptz;
alter table pm.dlr_tech_punches add column if not exists start_received_at timestamptz;
alter table pm.dlr_tech_punches add column if not exists end_device_at     timestamptz;
alter table pm.dlr_tech_punches add column if not exists end_received_at   timestamptz;
alter table pm.dlr_tech_punches add column if not exists late_tap          boolean not null default false;
alter table pm.dlr_tech_punches add column if not exists late_minutes      int;
alter table pm.time_entries add column if not exists late_tap          boolean not null default false;
alter table pm.time_entries add column if not exists late_tap_minutes  int;
alter table pm.time_entries add column if not exists late_ack_by       text;
alter table pm.time_entries add column if not exists late_ack_at       timestamptz;

-- The effective time of a tap: now() when none; clamped to now inside the skew; refused outside.
drop function if exists pm._d5_tap_time(timestamptz, text);
create or replace function pm._d5_tap_time(p_at timestamptz, p_what text, p_own boolean) returns timestamptz
language plpgsql stable
set search_path = pm, core, public
as $$
begin
  if p_at is null then return now(); end if;
  if p_at > now() + interval '10 minutes' then
    raise exception 'PM_CLOCK_AHEAD: the % time is in the future; turn on the phone''s automatic date and time', p_what using errcode = '22023';
  end if;
  if p_own and p_at < now() - interval '72 hours' then
    raise exception 'PM_PUNCH_STALE: the % was tapped more than 72 hours ago; the service manager enters it', p_what using errcode = '22023';
  end if;
  if p_at < now() - interval '35 days' then
    raise exception 'PM_PUNCH_STALE: the % is more than 35 days old; enter it on the time sheet', p_what using errcode = '22023';
  end if;
  return least(p_at, now());
end $$;

-- Minutes a tap arrived late (null when on time: within 15 minutes). Security review R7: every tap
-- older than 15 minutes is late — the tech's own or one a manager enters for them.
drop function if exists pm._d5_late_minutes(timestamptz, boolean);
create or replace function pm._d5_late_minutes(p_at timestamptz) returns int
language sql stable
as $$ select case when p_at is not null and p_at < now() - interval '15 minutes'
                  then greatest(round(extract(epoch from (now() - p_at)) / 60.0)::int, 15) end $$;

-- A late tap must not land in a week that already has approved time for the tech.
create or replace function pm._d5_week_open(p_org uuid, p_emp uuid, p_at timestamptz) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if exists (select 1 from pm.time_entries t
              where t.org_id = p_org and t.employee_id = p_emp and t.approval_state = 'APPROVED'
                and date_trunc('week', t.work_date) = date_trunc('week', p_at::date)) then
    raise exception 'PM_TIME_WEEK_LOCKED: the week of % already has approved time; the service manager enters this punch', to_char(p_at::date, 'FMMon FMDD')
      using errcode = '55000';
  end if;
end $$;

-- A new punch starting at p_at must not overlap what is already recorded later for the tech.
create or replace function pm._d5_punch_fits(p_org uuid, p_emp uuid, p_at timestamptz) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  if exists (select 1 from pm.dlr_tech_punches x
              where x.org_id = p_org and x.employee_id = p_emp
                and (x.ended_at > p_at + interval '1 second' or (x.ended_at is null and x.started_at > p_at + interval '1 second'))) then
    raise exception 'PM_PUNCH_OVERLAP: a later punch is already on this technician''s time; the service manager fixes the time sheet' using errcode = '55000';
  end if;
end $$;

-- Close a punch at an effective end time: 1122 _dlr_close_punch does the hours + time entry; this
-- records the device time and arrival, keeps the source honest (own on-time tap: as it was; own late
-- tap: ADJUSTED; manager: what 1122 decided) and carries the late flag to the time entry.
drop function if exists pm._d5_close_punch_at(uuid, timestamptz, timestamptz, boolean);
create or replace function pm._d5_close_punch_at(p_punch uuid, p_end timestamptz, p_device timestamptz, p_own boolean, p_late int) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dlr_tech_punches%rowtype; r jsonb; v_late int; v_te uuid;
begin
  select * into p from pm.dlr_tech_punches x where x.id = p_punch for update;
  if p.ended_at is not null then return jsonb_build_object('punch_id', p.id, 'already_closed', true); end if;
  v_late := case when p.late_tap or p_late is not null then greatest(coalesce(p.late_minutes, 0), coalesce(p_late, 0)) end;
  if p_late is not null and p.kind = 'LINE' then perform pm._d5_week_open(p.org_id, p.employee_id, p.started_at); end if;
  r := pm._dlr_close_punch(p_punch, p_end);
  update pm.dlr_tech_punches set end_device_at = p_device, end_received_at = now(),
         late_tap = v_late is not null, late_minutes = v_late,
         source = case when v_late is not null then 'ADJUSTED' when p_own then p.source else source end
   where id = p_punch;
  v_te := pm.access_try_uuid(r ->> 'time_entry_id');
  if v_te is not null and v_late is not null then
    update pm.time_entries set late_tap = true, late_tap_minutes = v_late where id = v_te;
  end if;
  return r || jsonb_build_object('ended_at', p_end, 'late_tap', v_late is not null, 'late_minutes', v_late);
end $$;

drop function if exists pm.dlr_clock_on(uuid, uuid);
create or replace function pm.dlr_clock_on(p_line uuid, p_employee uuid default null, p_at timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype; v_emp uuid; v_open uuid; v_closed jsonb; v_id uuid; v_at timestamptz;
        v_own boolean; v_late int;
begin
  select * into l from pm.work_order_lines x where x.id = p_line;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RO line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if l.kind not in ('LABOR','SERVICE','SUBLET','MISC') then raise exception 'PM_INVALID: clock on to a labor line, not a % line', lower(l.kind) using errcode = '22023'; end if;
  v_emp := pm._dlr_punch_employee(w.location_id, p_employee);
  v_own := v_emp in (select pm.my_employee_ids());
  v_at := pm._d5_tap_time(p_at, 'clock-on', v_own);
  v_late := pm._d5_late_minutes(p_at);
  if v_at < l.created_at - interval '10 minutes' then
    raise exception 'PM_INVALID: the clock-on time is before this RO line was written' using errcode = '22023';
  end if;
  if v_late is not null then perform pm._d5_week_open(l.org_id, v_emp, v_at); end if;
  perform pm._d5_punch_fits(l.org_id, v_emp, v_at);
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = l.org_id and x.employee_id = v_emp and x.ended_at is null for update;
  if v_open is not null then v_closed := pm._d5_close_punch_at(v_open, v_at, p_at, v_own, v_late); end if;
  insert into pm.dlr_tech_punches (org_id, location_id, employee_id, kind, job_id, work_order_id, work_order_line_id, source,
                                   started_at, start_device_at, start_received_at, late_tap, late_minutes)
  values (l.org_id, w.location_id, v_emp, 'LINE', w.job_id, w.id, l.id,
          case when v_late is not null then 'ADJUSTED' when p_employee is null then 'PHONE' else 'KIOSK' end,
          v_at, p_at, now(), v_late is not null, v_late)
  returning id into v_id;
  if w.status in ('NEW','SCHEDULED','DISPATCHED','ON_HOLD') then
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, v_at), hold_reason = null where id = w.id;
  end if;
  return jsonb_build_object('punch_id', v_id, 'closed', v_closed, 'work_order', w.number, 'started_at', v_at, 'received_at', now(),
                            'late_tap', v_late is not null, 'late_minutes', v_late);
end $$;

create or replace function pm.dlr_clock_off(p_location uuid, p_employee uuid default null, p_end_at timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_emp uuid; v_open uuid; v_own boolean; v_end timestamptz; v_late int;
begin
  v_emp := pm._dlr_punch_employee(p_location, p_employee);
  v_own := v_emp in (select pm.my_employee_ids());
  -- The tech's own tap time is field-owned inside the 72 h late window (bounded + flagged below); a
  -- corrected end time on SOMEONE ELSE's punch is a manager's correction (1122 security review L1).
  if p_end_at is not null and not v_own and not pm.access_can_location('projects.dispatch', 'edit', p_location) then
    raise exception 'PM_FORBIDDEN: a corrected end time on another technician''s punch needs projects.dispatch:edit' using errcode = '42501';
  end if;
  v_end := pm._d5_tap_time(p_end_at, 'clock-off', v_own);
  v_late := pm._d5_late_minutes(p_end_at);
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = v_org and x.employee_id = v_emp and x.ended_at is null for update;
  if v_open is null then return jsonb_build_object('open', false); end if;
  return pm._d5_close_punch_at(v_open, v_end, p_end_at, v_own, v_late) || jsonb_build_object('open', true, 'received_at', now());
end $$;

drop function if exists pm.dlr_clock_indirect(uuid, text, uuid);
create or replace function pm.dlr_clock_indirect(p_location uuid, p_kind text, p_employee uuid default null, p_at timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_emp uuid; v_open uuid; v_closed jsonb; v_id uuid; v_at timestamptz; v_own boolean; v_late int;
begin
  if p_kind not in ('SHOP','WAITING_PARTS','TRAINING','CLEANUP','IDLE') then raise exception 'PM_INVALID: kind %', p_kind using errcode = '22023'; end if;
  v_emp := pm._dlr_punch_employee(p_location, p_employee);
  v_own := v_emp in (select pm.my_employee_ids());
  v_at := pm._d5_tap_time(p_at, 'clock-on', v_own);
  v_late := pm._d5_late_minutes(p_at);
  perform pm._d5_punch_fits(v_org, v_emp, v_at);
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = v_org and x.employee_id = v_emp and x.ended_at is null for update;
  if v_open is not null then v_closed := pm._d5_close_punch_at(v_open, v_at, p_at, v_own, v_late); end if;
  insert into pm.dlr_tech_punches (org_id, location_id, employee_id, kind, source, started_at, start_device_at, start_received_at, late_tap, late_minutes)
  values (v_org, p_location, v_emp, p_kind,
          case when v_late is not null then 'ADJUSTED' when p_employee is null then 'PHONE' else 'KIOSK' end,
          v_at, p_at, now(), v_late is not null, v_late)
  returning id into v_id;
  return jsonb_build_object('punch_id', v_id, 'closed', v_closed, 'started_at', v_at, 'received_at', now(), 'late_tap', v_late is not null, 'late_minutes', v_late);
end $$;

-- Minutes since the end of p_date in the company's own time zone (null when p_date is today or later
-- there): the field-service time zone of the job's company, else the organization's, else UTC — so a
-- late-evening entry is never mistaken for yesterday's by UTC (security review R3-b).
create or replace function pm._d5_late_since(p_org uuid, p_job uuid, p_date date) returns int
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare tz text; v_today date;
begin
  if p_date is null then return null; end if;
  if to_regclass('pm.fs_settings') is not null then
    execute 'select fs.time_zone from pm.fs_settings fs join core.jobs j on j.org_id = fs.org_id and j.location_id = fs.location_id where j.id = $1 limit 1' into tz using p_job;
  end if;
  if tz is null then
    begin
      execute 'select o.timezone from core.organizations o where o.id = $1' into tz using p_org;
    exception when others then tz := null;
    end;
  end if;
  begin
    v_today := (now() at time zone coalesce(tz, 'UTC'))::date;
  exception when others then tz := 'UTC'; v_today := (now() at time zone 'UTC')::date;
  end;
  if p_date >= v_today then return null; end if;
  return greatest(round(extract(epoch from (now() - ((p_date + 1)::timestamp at time zone coalesce(tz, 'UTC')))) / 60.0)::int, 15);
end $$;

-- The time-entry gate (security review H1 / R3 / R3-b). pm.approve_time_entries (1108) is unchanged:
--   * approval of a late_tap entry is refused until an approver acknowledged it individually
--     (pm.dlr_ack_late_time stamps late_ack_at; the pm.late_ack transaction flag is honoured too);
--   * members (direct table writes as authenticated) cannot insert clock- or field-sync-origin rows
--     (source_ref ^(pm|wf): — those come only from the definer clock / field-sync RPCs), cannot pre-stamp
--     an acknowledgment, and a row they insert for a past day (the company's local day) is flagged late;
--   * any member change to hours / job / employee / work date clears an acknowledgment, and if the
--     earlier of the old and new dates is before the company's today, the row is (re)flagged late;
--   * members cannot change hours / work date / employee / job on a clock or field-sync row
--     (^(pm:(punch|mfg_install)|wf:seg):) and cannot delete such a row or a late-flagged one (void it).
-- Definer code (the clock, pm.field_time_insert / update, approvals) is not a member write and passes.
create or replace function pm.tg_d5_late_time_gate() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_member boolean := current_user in ('authenticated','anon'); v_late int;
begin
  if tg_op = 'DELETE' then
    if v_member and (old.late_tap or coalesce(old.source_ref, '') ~ '^(pm:(punch|mfg_install)|wf:seg):') then
      raise exception 'PM_FORBIDDEN: clock, field and late time is voided, not deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.late_ack_by := null; new.late_ack_at := null;
    if v_member then
      if coalesce(new.source_ref, '') ~ '^(pm|wf):' then
        raise exception 'PM_FORBIDDEN: clock and field time comes from the clock / phone sync, not a direct entry' using errcode = '42501';
      end if;
      v_late := pm._d5_late_since(new.org_id, new.job_id, new.work_date);
      new.late_tap := v_late is not null; new.late_tap_minutes := v_late;
    end if;
    return new;
  end if;
  if v_member and (new.hours is distinct from old.hours or new.work_date is distinct from old.work_date
                   or new.employee_id is distinct from old.employee_id or new.job_id is distinct from old.job_id) then
    if coalesce(old.source_ref, '') ~ '^(pm:(punch|mfg_install)|wf:seg):' then
      raise exception 'PM_FORBIDDEN: clock and field time is corrected by the service manager (void it and re-enter it)' using errcode = '42501';
    end if;
    new.late_ack_by := null; new.late_ack_at := null;
    v_late := pm._d5_late_since(new.org_id, new.job_id, least(old.work_date, new.work_date));
    if v_late is not null then
      new.late_tap := true; new.late_tap_minutes := greatest(coalesce(old.late_tap_minutes, 0), v_late);
    end if;
  end if;
  if new.approval_state = 'APPROVED' and old.approval_state is distinct from 'APPROVED' and new.late_tap and new.late_ack_at is null then
    if new.id::text = any (string_to_array(coalesce(current_setting('pm.late_ack', true), ''), ',')) then
      new.late_ack_by := pm.current_user_id(); new.late_ack_at := now();
    else
      raise exception 'PM_LATE_TAP: this time was entered % h late; acknowledge it individually to approve',
        trim(to_char(coalesce(new.late_tap_minutes, 0) / 60.0, 'FM9990.0')) using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_d5_late_time_gate on pm.time_entries;
create trigger trg_d5_late_time_gate before insert or update or delete on pm.time_entries for each row execute function pm.tg_d5_late_time_gate();

-- The phone's field sync (apps/projects/src/app/api/field/_lib/store.ts) writes its wf:seg time through
-- these definer RPCs (R3-b): the same write rule as the 1110 time-entry class (your own entry with Time
-- create / edit on the job, or Time approve on the job), DRAFT rows only, idempotent by source_ref
-- (unique per org: a replay raises 23505, which the sync treats as a duplicate), and a past local day is
-- flagged late like any other entry.
create or replace function pm.field_time_insert(p_job uuid, p_employee uuid, p_user text, p_work_date date, p_hours numeric,
                                                p_cost_code uuid default null, p_notes text default null, p_source_ref text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid; v_late int;
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org) then raise exception 'PM_FORBIDDEN: job not found' using errcode = '42501'; end if;
  if coalesce(p_source_ref, '') !~ '^wf:seg:[0-9a-f-]{36}(:[0-9a-f-]{36})?$' then raise exception 'PM_INVALID: field time needs its wf:seg key' using errcode = '22023'; end if;
  if not (((p_employee is not null and p_employee in (select pm.my_employee_ids())) or (p_employee is null and p_user is not distinct from pm.current_user_id()))
          and p_job in (select pm.my_job_ids_with('projects.time', 'create')))
     and not (p_job in (select pm.my_job_ids_with('projects.time', 'approve'))) then
    raise exception 'PM_FORBIDDEN: you enter your own time (or approve time on the job)' using errcode = '42501';
  end if;
  if p_employee is not null and not exists (select 1 from core.employees e where e.id = p_employee and e.org_id = v_org) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: %', p_employee using errcode = 'P0002';
  end if;
  v_late := pm._d5_late_since(v_org, p_job, p_work_date);
  insert into pm.time_entries (org_id, job_id, employee_id, user_id, work_date, hours, pay_type, cost_code_id, notes, approval_state, source_ref, late_tap, late_tap_minutes, created_by)
  values (v_org, p_job, p_employee, case when p_employee is null then p_user end, p_work_date, p_hours, 'REG', p_cost_code, left(p_notes, 1000), 'DRAFT', p_source_ref,
          v_late is not null, v_late, pm.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Update a field-sync row's field-owned columns (hours, work date, cost code, notes); null when the row
-- is no longer editable from the phone (approved / rejected / void), so the sync reports it.
create or replace function pm.field_time_update(p_id uuid, p_patch jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.time_entries%rowtype; p jsonb := coalesce(p_patch, '{}'); k text; v_date date; v_late int;
begin
  select * into t from pm.time_entries x where x.id = p_id for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: time entry not found' using errcode = '42501'; end if;
  if coalesce(t.source_ref, '') !~ '^wf:seg:' then raise exception 'PM_INVALID: only phone time is updated here' using errcode = '22023'; end if;
  if not (((t.employee_id in (select pm.my_employee_ids())) or t.user_id = pm.current_user_id()) and t.job_id in (select pm.my_job_ids_with('projects.time', 'edit')))
     and not (t.job_id in (select pm.my_job_ids_with('projects.time', 'approve'))) then
    raise exception 'PM_FORBIDDEN: you change your own time (or approve time on the job)' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('hours','work_date','cost_code_id','notes') then raise exception 'PM_INVALID: % is not changed from the phone', k using errcode = '22023'; end if;
  end loop;
  if t.approval_state not in ('DRAFT','SUBMITTED') then return null; end if;
  v_date := case when p ? 'work_date' then (p ->> 'work_date')::date else t.work_date end;
  v_late := case when (p ? 'hours' and (p ->> 'hours')::numeric is distinct from t.hours) or v_date is distinct from t.work_date
                 then pm._d5_late_since(t.org_id, t.job_id, least(t.work_date, v_date)) end;
  update pm.time_entries set
    hours        = case when p ? 'hours' then (p ->> 'hours')::numeric else hours end,
    work_date    = v_date,
    cost_code_id = case when p ? 'cost_code_id' then pm.access_try_uuid(p ->> 'cost_code_id') else cost_code_id end,
    notes        = case when p ? 'notes' then left(p ->> 'notes', 1000) else notes end,
    late_ack_by  = case when v_late is not null or v_date is distinct from t.work_date or (p ? 'hours' and (p ->> 'hours')::numeric is distinct from t.hours) then null else late_ack_by end,
    late_ack_at  = case when v_late is not null or v_date is distinct from t.work_date or (p ? 'hours' and (p ->> 'hours')::numeric is distinct from t.hours) then null else late_ack_at end,
    late_tap     = late_tap or v_late is not null,
    late_tap_minutes = case when v_late is not null then greatest(coalesce(late_tap_minutes, 0), v_late) else late_tap_minutes end,
    updated_at   = now()
  where id = t.id;
  return t.id;
end $$;

-- (security review round 2: the one-call approve-with-acknowledgment wrapper is removed — companies that
-- route time through Approvals (1113) acknowledge with pm.dlr_ack_late_time, then approve there.)
drop function if exists pm.approve_time_entries_ack(uuid[], uuid[]);
delete from pm.access_rpc_guards where function_name = 'approve_time_entries_ack';

-- Acknowledge late-tap entries one by one ahead of approval (so the normal approval chain — 1113 —
-- can then approve them): an approver who is not the worker stamps each entry.
create or replace function pm.dlr_ack_late_time(p_ids uuid[])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_me text := pm.current_user_id(); t record; n int := 0;
begin
  if v_me is null then raise exception 'PM_NO_ACTOR: acknowledging time needs an identified user' using errcode = '42501'; end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 200 then raise exception 'PM_INVALID: acknowledge 1 to 200 entries' using errcode = '22023'; end if;
  for t in select x.*, e.clerk_user_id as worker from pm.time_entries x left join core.employees e on e.id = x.employee_id
            where x.org_id = v_org and x.id = any (p_ids) for update of x loop
    if not t.late_tap then raise exception 'PM_INVALID: that entry was not a late tap' using errcode = '22023'; end if;
    if t.approval_state in ('APPROVED','VOID') then raise exception 'PM_INVALID: that entry is already %', lower(t.approval_state) using errcode = '22023'; end if;
    if t.worker = v_me or t.user_id = v_me or t.created_by = v_me
       or exists (select 1 from pm.dlr_tech_punches p where p.org_id = v_org and p.time_entry_id = t.id and p.created_by = v_me) then
      raise exception 'PM_SOD_VIOLATION: someone other than the worker or whoever entered the punch acknowledges late time' using errcode = '42501';
    end if;
    update pm.time_entries set late_ack_by = v_me, late_ack_at = now() where id = t.id and late_ack_at is null;
    n := n + 1;
  end loop;
  if n <> cardinality(p_ids) then raise exception 'PM_FORBIDDEN: % of % entries were not found', cardinality(p_ids) - n, cardinality(p_ids) using errcode = '42501'; end if;
  return jsonb_build_object('acknowledged', n);
end $$;

-- Late-tap time to review at a company (the approver's list): "entered N h late".
create or replace function pm.dlr_late_time(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'job_id', t.job_id, 'employee_id', t.employee_id,
      'employee', btrim(concat_ws(' ', e.first_name, e.last_name)), 'work_date', t.work_date, 'hours', t.hours, 'approval_state', t.approval_state,
      'late_tap_minutes', t.late_tap_minutes, 'late_label', format('entered %s h late', trim(to_char(coalesce(t.late_tap_minutes, 0) / 60.0, 'FM9990.0'))),
      'acknowledged_at', t.late_ack_at, 'acknowledged_by', t.late_ack_by, 'notes', t.notes) order by t.work_date desc, t.created_at desc)
    from pm.time_entries t join core.jobs j on j.org_id = t.org_id and j.id = t.job_id left join core.employees e on e.id = t.employee_id
   where t.org_id = v_org and j.location_id = p_location and t.late_tap and t.approval_state <> 'VOID'
     and t.work_date between coalesce(p_from, current_date - 35) and coalesce(p_to, current_date)), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- The 3C story (complaint / cause / correction) per RO line, from the tech's phone or the desk.
-- One current story per line; every phone command is logged once (idempotent by command id: a
-- replay returns the first result with replayed = true; the same id on another line is refused).
-- null leaves a part unchanged, '' clears it. The tech must be on the RO (dispatched, assigned
-- operation, performed-by, or punched on the line) or hold projects.store:edit /
-- projects.dispatch:edit on it (the guard). Text only: no money on either table.
create table if not exists pm.dlr_line_stories (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  work_order_id          uuid not null,
  work_order_line_id     uuid not null,
  complaint              text check (complaint is null or length(complaint) <= 2000),
  cause                  text check (cause is null or length(cause) <= 2000),
  correction             text check (correction is null or length(correction) <= 2000),
  updated_by_employee_id uuid references core.employees(id),
  updated_by             text default pm.current_user_id(),
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, work_order_line_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, work_order_line_id) references pm.work_order_lines (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_line_stories_wo_idx on pm.dlr_line_stories (org_id, work_order_id);

create table if not exists pm.dlr_line_story_commands (
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  command_id         uuid not null,
  job_id             uuid not null,
  work_order_line_id uuid not null,
  employee_id        uuid references core.employees(id),
  result             jsonb not null,
  created_by         text default pm.current_user_id(),
  received_at        timestamptz not null default now(),
  primary key (org_id, command_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, work_order_line_id) references pm.work_order_lines (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dlr_set_line_story(p_line uuid, p_complaint text default null, p_cause text default null,
                                                 p_correction text default null, p_command uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype; c pm.dlr_line_story_commands%rowtype; s pm.dlr_line_stories%rowtype;
  v_emp uuid; v_res jsonb;
begin
  select * into l from pm.work_order_lines x where x.id = p_line;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RO line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  if p_command is not null then
    select * into c from pm.dlr_line_story_commands x where x.org_id = l.org_id and x.command_id = p_command;
    if found then
      if c.work_order_line_id is distinct from l.id then
        raise exception 'PM_DUPLICATE: that command was already used on another RO line' using errcode = '23505';
      end if;
      return c.result || jsonb_build_object('replayed', true);
    end if;
  end if;
  if p_complaint is null and p_cause is null and p_correction is null then
    raise exception 'PM_INVALID: say the complaint, the cause or the correction' using errcode = '22023';
  end if;
  if greatest(length(coalesce(p_complaint, '')), length(coalesce(p_cause, '')), length(coalesce(p_correction, ''))) > 2000 then
    raise exception 'PM_INVALID: keep each part of the story under 2000 characters' using errcode = '22023';
  end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if l.kind not in ('LABOR','SERVICE','SUBLET','MISC') then
    raise exception 'PM_INVALID: the story goes on a labor line, not a % line', lower(l.kind) using errcode = '22023';
  end if;
  select x into v_emp from pm.my_employee_ids() x limit 1;
  insert into pm.dlr_line_stories as t (org_id, job_id, work_order_id, work_order_line_id, complaint, cause, correction, updated_by_employee_id)
  values (l.org_id, w.job_id, w.id, l.id, nullif(btrim(p_complaint), ''), nullif(btrim(p_cause), ''), nullif(btrim(p_correction), ''), v_emp)
  on conflict (org_id, work_order_line_id) do update set
    complaint  = case when p_complaint  is null then t.complaint  else excluded.complaint  end,
    cause      = case when p_cause      is null then t.cause      else excluded.cause      end,
    correction = case when p_correction is null then t.correction else excluded.correction end,
    updated_by_employee_id = excluded.updated_by_employee_id, updated_by = pm.current_user_id(), updated_at = now()
  returning * into s;
  v_res := jsonb_build_object('story_id', s.id, 'line_id', l.id, 'work_order_id', w.id, 'work_order', w.number,
    'complaint', s.complaint, 'cause', s.cause, 'correction', s.correction, 'updated_at', s.updated_at, 'replayed', false);
  if p_command is not null then
    insert into pm.dlr_line_story_commands (org_id, command_id, job_id, work_order_line_id, employee_id, result)
    values (l.org_id, p_command, w.job_id, l.id, v_emp, v_res);
  end if;
  perform pm.log_activity(l.org_id, w.location_id, w.job_id, 'ro.story', 'work_order_lines', l.id,
    left(format('Story on %s: %s', w.number, coalesce(s.correction, s.cause, s.complaint)), 300), jsonb_build_object('command_id', p_command));
  return v_res;
end $$;

-- ============================================================================
-- M. MANUFACTURING (ETO cabinetry / millwork)
-- ============================================================================
create table if not exists pm.mfg_ops_settings (
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  current_set_only        boolean not null default true,
  measure_required        boolean not null default true,
  selections_gate         boolean not null default true,
  eng_buffer_days         int not null default 5 check (eng_buffer_days between 0 and 120),
  drafter_hours_per_week  numeric(6,2) not null default 32 check (drafter_hours_per_week > 0),
  stored_materials_billing boolean not null default true,
  updated_by              text,
  updated_at              timestamptz not null default now(),
  primary key (org_id, location_id)
);
comment on table pm.mfg_ops_settings is '1125: manufacturing completion settings (gates, engineering buffer, drafter capacity, current-set rule).';

create or replace function pm._mfg5_set(p_org uuid, p_location uuid) returns pm.mfg_ops_settings
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_ops_settings;
begin
  select * into s from pm.mfg_ops_settings x where x.org_id = p_org and x.location_id = p_location;
  if s.org_id is null then
    s.org_id := p_org; s.location_id := p_location; s.current_set_only := true; s.measure_required := true; s.selections_gate := true;
    s.eng_buffer_days := 5; s.drafter_hours_per_week := 32; s.stored_materials_billing := true;
  end if;
  return s;
end $$;

create or replace function pm.mfg_set_ops_settings(p_location uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); s pm.mfg_ops_settings; a jsonb := coalesce(p_patch, '{}');
begin
  s := pm._mfg5_set(v_org, p_location);
  insert into pm.mfg_ops_settings as t (org_id, location_id, current_set_only, measure_required, selections_gate, eng_buffer_days, drafter_hours_per_week, stored_materials_billing, updated_by)
  values (v_org, p_location, coalesce(pm._x_try_bool(a ->> 'current_set_only'), s.current_set_only), coalesce(pm._x_try_bool(a ->> 'measure_required'), s.measure_required),
          coalesce(pm._x_try_bool(a ->> 'selections_gate'), s.selections_gate), coalesce(pm._x_try_num(a ->> 'eng_buffer_days')::int, s.eng_buffer_days),
          coalesce(pm._x_try_num(a ->> 'drafter_hours_per_week'), s.drafter_hours_per_week), coalesce(pm._x_try_bool(a ->> 'stored_materials_billing'), s.stored_materials_billing),
          pm.current_user_id())
  on conflict (org_id, location_id) do update set current_set_only = excluded.current_set_only, measure_required = excluded.measure_required,
    selections_gate = excluded.selections_gate, eng_buffer_days = excluded.eng_buffer_days, drafter_hours_per_week = excluded.drafter_hours_per_week,
    stored_materials_billing = excluded.stored_materials_billing, updated_by = excluded.updated_by, updated_at = now()
  returning * into s;
  return to_jsonb(s) - 'org_id';
end $$;

create or replace function pm.mfg_ops_settings_get(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  return to_jsonb(pm._mfg5_set(pm._x_org_of_location(p_location), p_location)) - 'org_id';
end $$;

-- ----------------------------------------------------------------------------
-- M1. MFG-03 Opportunity / bid board
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_opportunities (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  number            text not null,
  name              text not null check (char_length(name) between 1 and 200),
  customer_id       uuid references core.customers(id),
  job_id            uuid,
  stage             text not null default 'LEAD' check (stage in ('LEAD','QUALIFIED','BIDDING','SUBMITTED','WON','LOST','NO_BID')),
  bid_due_on        date,
  est_value_cents   bigint check (est_value_cents is null or est_value_cents >= 0),
  probability       numeric(4,3) check (probability is null or (probability >= 0 and probability <= 1)),
  source            text,
  project_address   text,
  architect         text,
  spec_document_id  uuid,
  reason_code       text check (reason_code is null or reason_code in ('PRICE','SCHEDULE','SCOPE','RELATIONSHIP','CAPACITY','NO_DECISION','OTHER')),
  reason            text,
  owner_user        text,
  decided_at        timestamptz,
  notes             text,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number),
  check (stage not in ('LOST','NO_BID') or reason_code is not null)
);
create index if not exists pm_mfg_opps_stage_idx on pm.mfg_opportunities (org_id, location_id, stage, bid_due_on);

create table if not exists pm.mfg_opportunity_bids (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  opportunity_id  uuid not null,
  customer_id     uuid not null references core.customers(id),
  estimate_id     uuid,
  amount_cents    bigint check (amount_cents is null or amount_cents >= 0),
  submitted_on    date,
  status          text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','AWARDED','LOST','WITHDRAWN')),
  notes           text,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, opportunity_id, customer_id),
  foreign key (org_id, opportunity_id) references pm.mfg_opportunities (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.mfg_save_opportunity(p_location uuid, p_id uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid := p_id; v_cust uuid := pm.access_try_uuid(a ->> 'customer_id');
begin
  if v_cust is not null and not exists (select 1 from core.customers c where c.id = v_cust and c.org_id = v_org) then raise exception 'PM_UNKNOWN_CUSTOMER: customer not found' using errcode = 'P0002'; end if;
  if v_id is null then
    if nullif(btrim(coalesce(a ->> 'name', '')), '') is null then raise exception 'PM_INVALID: name the opportunity' using errcode = '22023'; end if;
    insert into pm.mfg_opportunities (org_id, location_id, number, name, customer_id, stage, bid_due_on, est_value_cents, probability, source, project_address, architect,
                                      spec_document_id, owner_user, notes)
    values (v_org, p_location, pm._d5_number(v_org, p_location, 'OPP'), btrim(a ->> 'name'), v_cust, 'LEAD', pm._x_try_date(a ->> 'bid_due_on'),
            pm._x_try_bigint(a ->> 'est_value_cents'), pm._x_try_num(a ->> 'probability'), nullif(a ->> 'source', ''), nullif(a ->> 'project_address', ''),
            nullif(a ->> 'architect', ''), pm.access_try_uuid(a ->> 'spec_document_id'), coalesce(nullif(a ->> 'owner_user', ''), pm.current_user_id()), nullif(a ->> 'notes', ''))
    returning id into v_id;
  else
    update pm.mfg_opportunities set name = coalesce(nullif(btrim(a ->> 'name'), ''), name), customer_id = coalesce(v_cust, customer_id),
           bid_due_on = coalesce(pm._x_try_date(a ->> 'bid_due_on'), bid_due_on), est_value_cents = coalesce(pm._x_try_bigint(a ->> 'est_value_cents'), est_value_cents),
           probability = coalesce(pm._x_try_num(a ->> 'probability'), probability), source = coalesce(nullif(a ->> 'source', ''), source),
           project_address = coalesce(nullif(a ->> 'project_address', ''), project_address), architect = coalesce(nullif(a ->> 'architect', ''), architect),
           notes = coalesce(nullif(a ->> 'notes', ''), notes), updated_at = now()
     where org_id = v_org and location_id = p_location and id = v_id;
    if not found then raise exception 'PM_FORBIDDEN: opportunity not found' using errcode = '42501'; end if;
  end if;
  return v_id;
end $$;

create or replace function pm.mfg_move_opportunity(p_id uuid, p_stage text, p_reason_code text default null, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.mfg_opportunities%rowtype; v_to text := upper(coalesce(p_stage, ''));
begin
  select * into o from pm.mfg_opportunities x where x.id = p_id for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: opportunity not found' using errcode = '42501'; end if;
  if v_to not in ('LEAD','QUALIFIED','BIDDING','SUBMITTED','LOST','NO_BID') then
    raise exception 'PM_INVALID: % (a win comes from awarding a bid)', v_to using errcode = '22023';
  end if;
  if o.stage = 'WON' then raise exception 'PM_INVALID: this opportunity was won' using errcode = '22023'; end if;
  if v_to in ('LOST','NO_BID') and upper(coalesce(p_reason_code, '')) not in ('PRICE','SCHEDULE','SCOPE','RELATIONSHIP','CAPACITY','NO_DECISION','OTHER') then
    raise exception 'PM_INVALID: pick the % reason', lower(replace(v_to, '_', ' ')) using errcode = '22023';
  end if;
  update pm.mfg_opportunities set stage = v_to, reason_code = case when v_to in ('LOST','NO_BID') then upper(p_reason_code) else null end,
         reason = case when v_to in ('LOST','NO_BID') then nullif(btrim(coalesce(p_reason, '')), '') else null end,
         decided_at = case when v_to in ('LOST','NO_BID') then now() end, updated_at = now() where id = o.id;
  if v_to in ('LOST','NO_BID') then update pm.mfg_opportunity_bids set status = 'LOST' where org_id = o.org_id and opportunity_id = o.id and status in ('DRAFT','SUBMITTED'); end if;
  return jsonb_build_object('opportunity_id', o.id, 'stage', v_to);
end $$;

-- One estimate can go to several GCs: a bid per GC.
create or replace function pm.mfg_save_bid(p_opportunity uuid, p_customer uuid, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.mfg_opportunities%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_id uuid; v_est uuid := pm.access_try_uuid(a ->> 'estimate_id'); v_status text;
begin
  select * into o from pm.mfg_opportunities x where x.id = p_opportunity for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: opportunity not found' using errcode = '42501'; end if;
  if o.stage in ('WON','LOST','NO_BID') then raise exception 'PM_INVALID: this opportunity is %', lower(o.stage) using errcode = '22023'; end if;
  if not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = o.org_id) then raise exception 'PM_UNKNOWN_CUSTOMER: GC not found' using errcode = 'P0002'; end if;
  if v_est is not null and not exists (select 1 from pm.estimates e where e.id = v_est and e.org_id = o.org_id and e.location_id = o.location_id) then
    raise exception 'PM_INVALID: that estimate is not on this company' using errcode = '22023';
  end if;
  v_status := upper(coalesce(nullif(a ->> 'status', ''), case when pm._x_try_date(a ->> 'submitted_on') is not null then 'SUBMITTED' else 'DRAFT' end));
  if v_status not in ('DRAFT','SUBMITTED','WITHDRAWN') then raise exception 'PM_INVALID: bid status %', v_status using errcode = '22023'; end if;
  insert into pm.mfg_opportunity_bids as b (org_id, opportunity_id, customer_id, estimate_id, amount_cents, submitted_on, status, notes)
  values (o.org_id, o.id, p_customer, v_est, pm._x_try_bigint(a ->> 'amount_cents'), pm._x_try_date(a ->> 'submitted_on'), v_status, nullif(a ->> 'notes', ''))
  on conflict (org_id, opportunity_id, customer_id) do update set estimate_id = coalesce(excluded.estimate_id, b.estimate_id),
    amount_cents = coalesce(excluded.amount_cents, b.amount_cents), submitted_on = coalesce(excluded.submitted_on, b.submitted_on), status = excluded.status,
    notes = coalesce(excluded.notes, b.notes)
  returning id into v_id;
  if v_status = 'SUBMITTED' and o.stage in ('LEAD','QUALIFIED','BIDDING') then update pm.mfg_opportunities set stage = 'SUBMITTED', updated_at = now() where id = o.id; end if;
  return v_id;
end $$;

-- Award one GC's bid: the others are lost, the opportunity is won, the estimate's job takes the GC as its
-- customer (quote-to-job keeps the estimate version: MFG-12), and a SENT estimate is accepted.
create or replace function pm.mfg_award_bid(p_bid uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.mfg_opportunity_bids%rowtype; o pm.mfg_opportunities%rowtype; e pm.estimates%rowtype; v_acc jsonb;
begin
  select * into b from pm.mfg_opportunity_bids x where x.id = p_bid for update;
  if b.org_id is null or b.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: bid not found' using errcode = '42501'; end if;
  select * into o from pm.mfg_opportunities x where x.org_id = b.org_id and x.id = b.opportunity_id for update;
  if o.stage in ('WON','LOST','NO_BID') then raise exception 'PM_INVALID: this opportunity is %', lower(o.stage) using errcode = '22023'; end if;
  update pm.mfg_opportunity_bids set status = 'AWARDED' where id = b.id;
  update pm.mfg_opportunity_bids set status = 'LOST' where org_id = b.org_id and opportunity_id = o.id and id <> b.id and status in ('DRAFT','SUBMITTED');
  if b.estimate_id is not null then
    select * into e from pm.estimates x where x.org_id = b.org_id and x.id = b.estimate_id;
    update core.jobs set customer_id = coalesce(customer_id, b.customer_id) where org_id = b.org_id and id = e.job_id;
    if e.status = 'SENT' then v_acc := pm.accept_estimate(e.id); end if;
  end if;
  update pm.mfg_opportunities set stage = 'WON', job_id = coalesce(e.job_id, job_id), decided_at = now(), customer_id = coalesce(customer_id, b.customer_id), updated_at = now()
   where id = o.id;
  perform pm.log_activity(o.org_id, o.location_id, e.job_id, 'opportunity.won', 'mfg_opportunities', o.id, format('%s won', o.name), jsonb_build_object('bid_id', b.id));
  return jsonb_build_object('opportunity_id', o.id, 'job_id', e.job_id, 'estimate_accepted', v_acc is not null);
end $$;

create or replace function pm.mfg_bid_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_cv boolean := pm._x_sees('projects.contract_value', 'view', p_location); v_won int; v_dec int;
begin
  select count(*) filter (where o.stage = 'WON'), count(*) filter (where o.stage in ('WON','LOST')) into v_won, v_dec
    from pm.mfg_opportunities o where o.org_id = v_org and o.location_id = p_location and o.decided_at > now() - interval '12 months';
  return jsonb_build_object(
    'opportunities', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'name', o.name, 'stage', o.stage, 'bid_due_on', o.bid_due_on,
        'overdue', o.bid_due_on < current_date and o.stage in ('LEAD','QUALIFIED','BIDDING'), 'customer', (select c.name from core.customers c where c.id = o.customer_id),
        'probability', o.probability, 'architect', o.architect, 'job_id', o.job_id, 'reason_code', o.reason_code, 'reason', o.reason,
        'est_value_cents', case when v_cv then o.est_value_cents end,
        'bids', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'customer', c.name, 'customer_id', b.customer_id, 'status', b.status, 'submitted_on', b.submitted_on,
            'estimate_id', b.estimate_id, 'amount_cents', case when v_cv then b.amount_cents end) order by c.name)
          from pm.mfg_opportunity_bids b join core.customers c on c.id = b.customer_id where b.org_id = o.org_id and b.opportunity_id = o.id), '[]'::jsonb))
        order by o.bid_due_on nulls last, o.created_at)
      from pm.mfg_opportunities o where o.org_id = v_org and o.location_id = p_location and (o.stage not in ('WON','LOST','NO_BID') or o.decided_at > now() - interval '90 days')), '[]'::jsonb),
    'win_rate', case when v_dec > 0 then round(v_won::numeric / v_dec, 3) end, 'decided_12m', v_dec,
    'loss_reasons', coalesce((select jsonb_object_agg(x.reason_code, x.n) from (select o.reason_code, count(*) n from pm.mfg_opportunities o
        where o.org_id = v_org and o.location_id = p_location and o.stage in ('LOST','NO_BID') and o.decided_at > now() - interval '12 months' group by 1) x), '{}'::jsonb),
    'amounts_visible', v_cv);
end $$;

-- ----------------------------------------------------------------------------
-- M2. MFG-05 On-screen takeoff on 1115 drawing sheets (points normalized 0–1 of the page; the database
--     measures in PDF points from the revision's page size and a calibrated scale)
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_takeoff_scales (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  revision_id    uuid not null,
  unit           text not null check (unit in ('IN','FT','MM','M')),
  pts_per_unit   numeric(14,6) not null check (pts_per_unit > 0),
  p1             jsonb not null,
  p2             jsonb not null,
  known_length   numeric(12,4) not null check (known_length > 0),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, revision_id)
);

create table if not exists pm.mfg_takeoffs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  revision_id      uuid not null,
  sheet_id         uuid,
  wbs_id           uuid,
  room             text,
  elevation        text,
  kind             text not null check (kind in ('LINEAR','AREA','COUNT')),
  label            text not null check (char_length(label) between 1 and 120),
  points           jsonb not null check (jsonb_typeof(points) = 'array'),
  qty              numeric(14,4) not null default 0,
  uom              text not null,
  product_id       uuid,
  estimate_line_id uuid,
  color            text,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_takeoffs_job_idx on pm.mfg_takeoffs (org_id, job_id, revision_id);

-- Polyline length / polygon area of normalized points on a page of w × h points.
create or replace function pm._mfg5_len(p_points jsonb, p_w numeric, p_h numeric) returns numeric
language sql immutable
as $$
  select coalesce(sum(sqrt(power((b.x - a.x) * p_w, 2) + power((b.y - a.y) * p_h, 2))), 0)
    from (select ord, (e ->> 0)::numeric as x, (e ->> 1)::numeric as y from jsonb_array_elements(p_points) with ordinality t(e, ord)) a
    join (select ord, (e ->> 0)::numeric as x, (e ->> 1)::numeric as y from jsonb_array_elements(p_points) with ordinality t(e, ord)) b on b.ord = a.ord + 1
$$;
create or replace function pm._mfg5_area(p_points jsonb, p_w numeric, p_h numeric) returns numeric
language sql immutable
as $$
  with p as (select ord, (e ->> 0)::numeric * p_w as x, (e ->> 1)::numeric * p_h as y, count(*) over () as n from jsonb_array_elements(p_points) with ordinality t(e, ord))
  select coalesce(abs(sum(a.x * b.y - b.x * a.y)) / 2, 0)
    from p a join p b on b.ord = case when a.ord = a.n then 1 else a.ord + 1 end
$$;

-- Unit conversions: measured length in the scale's unit → LF (imperial) or M (metric).
create or replace function pm._mfg5_to_base(p_len numeric, p_unit text) returns numeric
language sql immutable
as $$ select case p_unit when 'IN' then p_len / 12.0 when 'FT' then p_len when 'MM' then p_len / 1000.0 when 'M' then p_len end $$;

create or replace function pm.mfg_set_takeoff_scale(p_revision uuid, p_p1 jsonb, p_p2 jsonb, p_known_length numeric, p_unit text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.drawing_revisions%rowtype; v_dist numeric; v_unit text := upper(coalesce(p_unit, 'FT')); v_id uuid;
begin
  select * into r from pm.drawing_revisions x where x.id = p_revision;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawing not found' using errcode = '42501'; end if;
  if r.width_pt is null or r.height_pt is null then raise exception 'PM_INVALID: this sheet has no page size; open it once in the viewer' using errcode = '22023'; end if;
  if v_unit not in ('IN','FT','MM','M') then raise exception 'PM_INVALID: scale unit is in, ft, mm or m' using errcode = '22023'; end if;
  if coalesce(p_known_length, 0) <= 0 then raise exception 'PM_INVALID: enter the real length between the two points' using errcode = '22023'; end if;
  v_dist := pm._mfg5_len(jsonb_build_array(p_p1, p_p2), r.width_pt, r.height_pt);
  if v_dist <= 0 then raise exception 'PM_INVALID: pick two different points' using errcode = '22023'; end if;
  insert into pm.mfg_takeoff_scales as s (org_id, job_id, revision_id, unit, pts_per_unit, p1, p2, known_length)
  values (r.org_id, r.job_id, r.id, v_unit, v_dist / p_known_length, p_p1, p_p2, p_known_length)
  on conflict (org_id, revision_id) do update set unit = excluded.unit, pts_per_unit = excluded.pts_per_unit, p1 = excluded.p1, p2 = excluded.p2,
    known_length = excluded.known_length, created_by = pm.current_user_id(), created_at = now()
  returning id into v_id;
  -- re-measure every takeoff on the sheet at the new scale
  update pm.mfg_takeoffs t set qty = pm._mfg5_takeoff_qty(t.kind, t.points, r.width_pt, r.height_pt, v_dist / p_known_length, v_unit),
         uom = pm._mfg5_takeoff_uom(t.kind, v_unit), updated_at = now()
   where t.org_id = r.org_id and t.revision_id = r.id;
  return jsonb_build_object('scale_id', v_id, 'pts_per_unit', round(v_dist / p_known_length, 6), 'unit', v_unit);
end $$;

create or replace function pm._mfg5_takeoff_uom(p_kind text, p_unit text) returns text
language sql immutable
as $$ select case p_kind when 'COUNT' then 'EA' when 'LINEAR' then case when p_unit in ('MM','M') then 'M' else 'LF' end
                   else case when p_unit in ('MM','M') then 'M2' else 'SF' end end $$;

create or replace function pm._mfg5_takeoff_qty(p_kind text, p_points jsonb, p_w numeric, p_h numeric, p_ppu numeric, p_unit text) returns numeric
language sql immutable
as $$
  select round(case p_kind
    when 'COUNT' then jsonb_array_length(p_points)::numeric
    when 'LINEAR' then pm._mfg5_to_base(pm._mfg5_len(p_points, p_w, p_h) / p_ppu, p_unit)
    else pm._mfg5_to_base(1, p_unit) * pm._mfg5_to_base(1, p_unit) * (pm._mfg5_area(p_points, p_w, p_h) / (p_ppu * p_ppu)) end, 4)
$$;

create or replace function pm.mfg_save_takeoff(p_revision uuid, p_id uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.drawing_revisions%rowtype; a jsonb := coalesce(p_attrs, '{}'); s pm.mfg_takeoff_scales%rowtype; v_kind text := upper(coalesce(a ->> 'kind', 'LINEAR'));
        v_pts jsonb := coalesce(a -> 'points', '[]'::jsonb); v_qty numeric; v_uom text; v_id uuid := p_id; x jsonb;
begin
  select * into r from pm.drawing_revisions q where q.id = p_revision;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawing not found' using errcode = '42501'; end if;
  if v_kind not in ('LINEAR','AREA','COUNT') then raise exception 'PM_INVALID: takeoff kind %', v_kind using errcode = '22023'; end if;
  if jsonb_typeof(v_pts) <> 'array' or jsonb_array_length(v_pts) = 0 or jsonb_array_length(v_pts) > 500 then raise exception 'PM_INVALID: 1 to 500 points' using errcode = '22023'; end if;
  for x in select value from jsonb_array_elements(v_pts) loop
    if jsonb_typeof(x) <> 'array' or jsonb_array_length(x) <> 2 or (x ->> 0)::numeric not between 0 and 1 or (x ->> 1)::numeric not between 0 and 1 then
      raise exception 'PM_INVALID: points are [x, y] fractions of the page' using errcode = '22023';
    end if;
  end loop;
  if v_kind = 'LINEAR' and jsonb_array_length(v_pts) < 2 then raise exception 'PM_INVALID: a run needs two points' using errcode = '22023'; end if;
  if v_kind = 'AREA' and jsonb_array_length(v_pts) < 3 then raise exception 'PM_INVALID: an area needs three points' using errcode = '22023'; end if;
  select * into s from pm.mfg_takeoff_scales q where q.org_id = r.org_id and q.revision_id = r.id;
  if v_kind <> 'COUNT' and s.id is null then raise exception 'PM_INVALID: set the sheet''s scale first (two points and a known length)' using errcode = '22023'; end if;
  v_qty := case when v_kind = 'COUNT' then jsonb_array_length(v_pts) else pm._mfg5_takeoff_qty(v_kind, v_pts, r.width_pt, r.height_pt, s.pts_per_unit, s.unit) end;
  v_uom := pm._mfg5_takeoff_uom(v_kind, coalesce(s.unit, 'FT'));
  if v_id is null then
    insert into pm.mfg_takeoffs (org_id, job_id, revision_id, sheet_id, wbs_id, room, elevation, kind, label, points, qty, uom, product_id, color)
    values (r.org_id, r.job_id, r.id, r.sheet_id, pm.access_try_uuid(a ->> 'wbs_id'), nullif(a ->> 'room', ''), nullif(a ->> 'elevation', ''), v_kind,
            coalesce(nullif(btrim(a ->> 'label'), ''), initcap(lower(v_kind))), v_pts, v_qty, v_uom, pm.access_try_uuid(a ->> 'product_id'), nullif(a ->> 'color', ''))
    returning id into v_id;
  else
    update pm.mfg_takeoffs set kind = v_kind, label = coalesce(nullif(btrim(a ->> 'label'), ''), label), points = v_pts, qty = v_qty, uom = v_uom,
           room = coalesce(nullif(a ->> 'room', ''), room), elevation = coalesce(nullif(a ->> 'elevation', ''), elevation),
           wbs_id = coalesce(pm.access_try_uuid(a ->> 'wbs_id'), wbs_id), product_id = coalesce(pm.access_try_uuid(a ->> 'product_id'), product_id), updated_at = now()
     where org_id = r.org_id and revision_id = r.id and id = v_id;
    if not found then raise exception 'PM_FORBIDDEN: takeoff not found' using errcode = '42501'; end if;
  end if;
  return jsonb_build_object('takeoff_id', v_id, 'qty', v_qty, 'uom', v_uom);
end $$;

create or replace function pm.mfg_delete_takeoff(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.mfg_takeoffs%rowtype;
begin
  select * into t from pm.mfg_takeoffs x where x.id = p_id;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: takeoff not found' using errcode = '42501'; end if;
  delete from pm.mfg_takeoffs where id = t.id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function pm.mfg_takeoff_sheet(p_revision uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.drawing_revisions%rowtype;
begin
  select * into r from pm.drawing_revisions x where x.id = p_revision;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawing not found' using errcode = '42501'; end if;
  return jsonb_build_object('revision_id', r.id, 'job_id', r.job_id, 'sheet_id', r.sheet_id, 'width_pt', r.width_pt, 'height_pt', r.height_pt, 'is_current', r.is_current,
    'scale', (select jsonb_build_object('unit', s.unit, 'pts_per_unit', s.pts_per_unit, 'p1', s.p1, 'p2', s.p2, 'known_length', s.known_length)
               from pm.mfg_takeoff_scales s where s.org_id = r.org_id and s.revision_id = r.id),
    'takeoffs', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'label', t.label, 'room', t.room, 'elevation', t.elevation, 'points', t.points,
        'qty', t.qty, 'uom', t.uom, 'product_id', t.product_id, 'estimate_line_id', t.estimate_line_id, 'color', t.color, 'wbs_id', t.wbs_id) order by t.created_at)
      from pm.mfg_takeoffs t where t.org_id = r.org_id and t.revision_id = r.id), '[]'::jsonb));
end $$;

create or replace function pm.mfg_takeoff_summary(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return coalesce((select jsonb_agg(jsonb_build_object('room', x.room, 'kind', x.kind, 'label', x.label, 'uom', x.uom, 'qty', x.qty, 'count', x.n, 'product_id', x.product_id,
      'product', (select p.name from pm.mfg_products p where p.id = x.product_id), 'in_estimate', x.priced) order by x.room nulls last, x.label)
    from (select t.room, t.kind, t.label, t.uom, t.product_id, sum(t.qty) as qty, count(*) as n, bool_and(t.estimate_line_id is not null) as priced
            from pm.mfg_takeoffs t where t.org_id = j.org_id and t.job_id = p_job group by 1, 2, 3, 4, 5) x), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- M3. MFG-07 Parametric product library. Each component quantity is a linear formula of the
--     parameters (coefficients on W, H, D inches, W×H, W×D, H×D, doors, drawers, shelves, plus a
--     constant), times the unit count. Deterministic in SQL and in lib/mfg/products.ts (parity test).
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_products (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  code           text not null check (code ~ '^[A-Z0-9_-]{2,30}$'),
  name           text not null check (char_length(name) between 1 and 120),
  family         text not null check (family in ('BASE','WALL','TALL','VANITY','CLOSET','PANEL','FILLER','COUNTERTOP','DESK','FEATURE_WALL','OTHER')),
  params         jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),     -- {w:{default,min,max}, …}
  components     jsonb not null default '[]' check (jsonb_typeof(components) = 'array'),  -- [{kind, key, description, uom, coef:{…}, unit_cost_cents?, work_center?}]
  price_coef     jsonb not null default '{}' check (jsonb_typeof(price_coef) = 'object'), -- sell per unit in cents (same formula)
  markup_pct     numeric(6,4) check (markup_pct is null or (markup_pct >= 0 and markup_pct <= 5)),
  routing_id     uuid,
  is_active      boolean not null default true,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, code)
);

create or replace function pm._mfg5_eval(p_coef jsonb, p jsonb) returns numeric
language sql immutable
as $$
  select coalesce((p_coef ->> 'const')::numeric, 0)
       + coalesce((p_coef ->> 'w')::numeric, 0) * coalesce((p ->> 'w')::numeric, 0)
       + coalesce((p_coef ->> 'h')::numeric, 0) * coalesce((p ->> 'h')::numeric, 0)
       + coalesce((p_coef ->> 'd')::numeric, 0) * coalesce((p ->> 'd')::numeric, 0)
       + coalesce((p_coef ->> 'wh')::numeric, 0) * coalesce((p ->> 'w')::numeric, 0) * coalesce((p ->> 'h')::numeric, 0)
       + coalesce((p_coef ->> 'wd')::numeric, 0) * coalesce((p ->> 'w')::numeric, 0) * coalesce((p ->> 'd')::numeric, 0)
       + coalesce((p_coef ->> 'hd')::numeric, 0) * coalesce((p ->> 'h')::numeric, 0) * coalesce((p ->> 'd')::numeric, 0)
       + coalesce((p_coef ->> 'doors')::numeric, 0) * coalesce((p ->> 'doors')::numeric, 0)
       + coalesce((p_coef ->> 'drawers')::numeric, 0) * coalesce((p ->> 'drawers')::numeric, 0)
       + coalesce((p_coef ->> 'shelves')::numeric, 0) * coalesce((p ->> 'shelves')::numeric, 0)
$$;

create or replace function pm.mfg_save_product(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_id uuid; c jsonb;
begin
  if jsonb_typeof(coalesce(a -> 'components', '[]'::jsonb)) <> 'array' then raise exception 'PM_INVALID: components are a list' using errcode = '22023'; end if;
  for c in select value from jsonb_array_elements(coalesce(a -> 'components', '[]'::jsonb)) loop
    if upper(coalesce(c ->> 'kind', '')) not in ('SHEET','EDGEBAND','HARDWARE','LUMBER','FINISH','BUYOUT','LABOR','INSTALL','FREIGHT') then
      raise exception 'PM_INVALID: component kind %', c ->> 'kind' using errcode = '22023';
    end if;
    if jsonb_typeof(coalesce(c -> 'coef', '{}'::jsonb)) <> 'object' then raise exception 'PM_INVALID: component formula must be coefficients' using errcode = '22023'; end if;
  end loop;
  insert into pm.mfg_products as p (org_id, location_id, code, name, family, params, components, price_coef, markup_pct, routing_id, is_active)
  values (v_org, p_location, upper(btrim(a ->> 'code')), btrim(a ->> 'name'), upper(coalesce(a ->> 'family', 'OTHER')), coalesce(a -> 'params', '{}'::jsonb),
          coalesce(a -> 'components', '[]'::jsonb), coalesce(a -> 'price_coef', '{}'::jsonb), pm._x_try_num(a ->> 'markup_pct'), pm.access_try_uuid(a ->> 'routing_id'),
          coalesce(pm._x_try_bool(a ->> 'is_active'), true))
  on conflict (org_id, location_id, code) do update set name = excluded.name, family = excluded.family, params = excluded.params, components = excluded.components,
    price_coef = excluded.price_coef, markup_pct = excluded.markup_pct, routing_id = excluded.routing_id, is_active = excluded.is_active, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Expand one product at the given parameters: components with quantities (× units), labor minutes by work
-- center, install hours, freight; cost from the component cost / material settings / the work center's
-- estimating rate; sell from the price formula (or cost × (1 + markup)). Internal: p_cost decides whether
-- cost figures are returned.
create or replace function pm._mfg5_expand(p_product uuid, p_params jsonb, p_cost boolean) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare pr pm.mfg_products%rowtype; v_p jsonb; k text; d jsonb; c jsonb; v_qty numeric; v_units numeric; v_out jsonb := '[]'; v_cost bigint := 0; v_unit_cost bigint;
        v_sell bigint; v_labor numeric := 0; v_install numeric := 0;
begin
  select * into pr from pm.mfg_products x where x.id = p_product;
  if pr.org_id is null or pr.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: product not found' using errcode = '42501'; end if;
  v_p := '{}'::jsonb;
  for k, d in select key, value from jsonb_each(pr.params) loop
    v_p := v_p || jsonb_build_object(k, coalesce(pm._x_try_num(p_params ->> k), pm._x_try_num(d ->> 'default'), 0));
    if pm._x_try_num(d ->> 'min') is not null and (v_p ->> k)::numeric < (d ->> 'min')::numeric then
      raise exception 'PM_INVALID: % must be at least %', k, d ->> 'min' using errcode = '22023';
    end if;
    if pm._x_try_num(d ->> 'max') is not null and (v_p ->> k)::numeric > (d ->> 'max')::numeric then
      raise exception 'PM_INVALID: % must be at most %', k, d ->> 'max' using errcode = '22023';
    end if;
  end loop;
  for k in select jsonb_object_keys(coalesce(p_params, '{}'::jsonb)) loop
    if not (v_p ? k) and k <> 'qty' then v_p := v_p || jsonb_build_object(k, pm._x_try_num(p_params ->> k)); end if;
  end loop;
  v_units := greatest(coalesce(pm._x_try_num(p_params ->> 'qty'), 1), 0);
  for c in select value from jsonb_array_elements(pr.components) loop
    v_qty := round(greatest(pm._mfg5_eval(coalesce(c -> 'coef', '{}'::jsonb), v_p), 0) * v_units, 4);
    continue when v_qty = 0;
    v_unit_cost := coalesce(pm._x_try_bigint(c ->> 'unit_cost_cents'),
      case when upper(c ->> 'kind') = 'LABOR' then
        (select pm.fs_rdiv(coalesce(wc.rate_cents, 0), 60) from pm.work_centers wc where wc.org_id = pr.org_id and wc.location_id = pr.location_id and wc.code = c ->> 'key')
      when upper(c ->> 'kind') in ('INSTALL','FREIGHT') then null
      else (select ms.last_cost_cents from pm.mfg_material_settings ms where ms.org_id = pr.org_id and ms.location_id = pr.location_id and ms.material_key = upper(c ->> 'key')) end, 0);
    v_cost := v_cost + pm.fs_rdiv(v_qty * v_unit_cost, 1);
    if upper(c ->> 'kind') = 'LABOR' then v_labor := v_labor + v_qty; end if;
    if upper(c ->> 'kind') = 'INSTALL' then v_install := v_install + v_qty; end if;
    v_out := v_out || jsonb_build_object('kind', upper(c ->> 'kind'), 'key', c ->> 'key', 'description', coalesce(c ->> 'description', c ->> 'key'),
      'uom', coalesce(c ->> 'uom', case upper(c ->> 'kind') when 'LABOR' then 'MIN' when 'INSTALL' then 'HR' when 'SHEET' then 'SHEET' when 'EDGEBAND' then 'LF' else 'EA' end),
      'qty', v_qty, 'cost_cents', case when p_cost then pm.fs_rdiv(v_qty * v_unit_cost, 1) end);
  end loop;
  v_sell := case when pr.price_coef <> '{}'::jsonb then pm.fs_rdiv(greatest(pm._mfg5_eval(pr.price_coef, v_p), 0) * v_units, 1)
                 when pr.markup_pct is not null then pm.fs_rdiv(v_cost * (1 + pr.markup_pct), 1) else 0 end;
  return jsonb_build_object('product_id', pr.id, 'code', pr.code, 'name', pr.name, 'family', pr.family, 'params', v_p, 'units', v_units, 'components', v_out,
    'labor_minutes', v_labor, 'install_hours', v_install, 'cost_cents', case when p_cost then v_cost end, 'sell_cents', v_sell, 'amounts_visible', p_cost);
end $$;

create or replace function pm.mfg_expand_product(p_product uuid, p_params jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_loc uuid;
begin
  select p.location_id into v_loc from pm.mfg_products p where p.id = p_product and p.org_id = public.get_org_id();
  if v_loc is null then raise exception 'PM_FORBIDDEN: product not found' using errcode = '42501'; end if;
  return pm._mfg5_expand(p_product, p_params, pm._x_sees('projects.financials', 'view', v_loc));
end $$;

-- Price a takeoff (or a typed line) into a DRAFT estimate from the library: one estimate line per
-- product, carrying the expansion in ext.mfg (so the CAD reconcile and est-vs-actual can compare).
create or replace function pm.mfg_add_product_line(p_estimate uuid, p_product uuid, p_params jsonb, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.estimates%rowtype; x jsonb; a jsonb := coalesce(p_attrs, '{}'); v_units numeric; v_line uuid; v_no int; v_cost bigint; v_sell bigint;
        v_tk uuid := pm.access_try_uuid(a ->> 'takeoff_id'); v_desc text;
begin
  select * into e from pm.estimates q where q.id = p_estimate for update;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if e.status <> 'DRAFT' then raise exception 'PM_ESTIMATE_LOCKED: % is %; revise it to add lines', e.number, e.status using errcode = '55000'; end if;
  if not exists (select 1 from pm.mfg_products p where p.id = p_product and p.org_id = e.org_id and p.location_id = e.location_id) then
    raise exception 'PM_INVALID: that product is not in this company''s library' using errcode = '22023';
  end if;
  x := pm._mfg5_expand(p_product, p_params, true);
  v_units := greatest((x ->> 'units')::numeric, 1);
  v_sell := coalesce((x ->> 'sell_cents')::bigint, 0);
  v_cost := coalesce((x ->> 'cost_cents')::bigint, 0);
  select coalesce(max(l.line_no), 0) + 1 into v_no from pm.estimate_lines l where l.org_id = e.org_id and l.estimate_id = e.id;
  v_desc := left(coalesce(nullif(a ->> 'description', ''), (x ->> 'name') || coalesce(' ' || (x -> 'params' ->> 'w') || '"', '')), 300);
  insert into pm.estimate_lines (org_id, estimate_id, line_no, wbs_id, cost_code_id, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents,
                                 labor_hours, sort, ext)
  values (e.org_id, e.id, v_no, pm.access_try_uuid(a ->> 'wbs_id'), pm.access_try_uuid(a ->> 'cost_code_id'), v_desc, v_units, 'EA',
          pm.fs_rdiv(v_cost, v_units), pm.fs_rdiv(v_sell, v_units), v_cost, v_sell,
          round(coalesce((x ->> 'labor_minutes')::numeric, 0) / 60.0, 2), v_no,
          jsonb_build_object('mfg', jsonb_build_object('product_id', p_product, 'code', x ->> 'code', 'params', x -> 'params',
                             'components', (select coalesce(jsonb_agg(c - 'cost_cents'), '[]'::jsonb) from jsonb_array_elements(x -> 'components') c),
                             'install_hours', x -> 'install_hours', 'takeoff_id', v_tk)))
  returning id into v_line;
  if v_tk is not null then update pm.mfg_takeoffs set estimate_line_id = v_line, product_id = p_product where org_id = e.org_id and id = v_tk and job_id = e.job_id; end if;
  return jsonb_build_object('estimate_line_id', v_line, 'units', v_units, 'sell_cents', v_sell);
end $$;

create or replace function pm.mfg_product_library(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean := pm._x_sees('projects.financials', 'view', p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'family', p.family, 'params', p.params, 'is_active', p.is_active,
      'components', case when v_fin then p.components else coalesce((select jsonb_agg(c - 'unit_cost_cents') from jsonb_array_elements(p.components) c), '[]'::jsonb) end,
      'price_coef', p.price_coef, 'markup_pct', case when v_fin then p.markup_pct end, 'routing_id', p.routing_id) order by p.family, p.code)
    from pm.mfg_products p where p.org_id = v_org and p.location_id = p_location), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- M4. MFG-11 Proposal & contract (alternates, allowances, clarifications, exclusions, deposit schedule,
--     versioned PDF, e-sign through 1115 with completion kind 'estimate' → accepts the estimate)
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_proposals (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  job_id            uuid not null,
  estimate_id       uuid not null,
  version           int not null default 1 check (version >= 1),
  status            text not null default 'DRAFT' check (status in ('DRAFT','SENT','SIGNED','DECLINED','VOID','SUPERSEDED')),
  title             text not null check (char_length(title) between 1 and 200),
  alternates        jsonb not null default '[]' check (jsonb_typeof(alternates) = 'array'),      -- [{label, amount_cents, accepted}]
  allowances        jsonb not null default '[]' check (jsonb_typeof(allowances) = 'array'),      -- [{label, amount_cents}]
  clarifications    text[] not null default '{}',
  exclusions        text[] not null default '{}',
  deposit_schedule  jsonb not null default '[{"label":"Deposit at signing","pct":0.5},{"label":"At delivery","pct":0.4},{"label":"At completion","pct":0.1}]'
                      check (jsonb_typeof(deposit_schedule) = 'array'),
  valid_until       date,
  file_id           uuid,
  envelope_id       uuid,
  sent_at           timestamptz,
  signed_at         timestamptz,
  signer_name       text,
  declined_reason   text,
  deposit_request_id uuid,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, estimate_id, version),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.mfg_save_proposal(p_estimate uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare e pm.estimates%rowtype; a jsonb := coalesce(p_attrs, '{}'); p pm.mfg_proposals%rowtype; v_sum numeric; x jsonb;
begin
  select * into e from pm.estimates q where q.id = p_estimate;
  if e.org_id is null or e.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: estimate not found' using errcode = '42501'; end if;
  if a ? 'deposit_schedule' then
    if jsonb_typeof(a -> 'deposit_schedule') <> 'array' then raise exception 'PM_INVALID: the deposit schedule is a list' using errcode = '22023'; end if;
    select coalesce(sum((x2 ->> 'pct')::numeric), 0) into v_sum from jsonb_array_elements(a -> 'deposit_schedule') x2;
    if v_sum > 1.00001 then raise exception 'PM_INVALID: the deposit schedule adds up to more than 100%%' using errcode = '22023'; end if;
  end if;
  for x in select value from jsonb_array_elements(coalesce(a -> 'alternates', '[]'::jsonb)) loop
    if nullif(btrim(coalesce(x ->> 'label', '')), '') is null then raise exception 'PM_INVALID: every alternate needs a label' using errcode = '22023'; end if;
  end loop;
  select * into p from pm.mfg_proposals q where q.org_id = e.org_id and q.estimate_id = e.id and q.status = 'DRAFT' order by q.version desc limit 1 for update;
  if p.id is null then
    insert into pm.mfg_proposals (org_id, location_id, job_id, estimate_id, version, title, alternates, allowances, clarifications, exclusions, deposit_schedule, valid_until)
    values (e.org_id, e.location_id, e.job_id, e.id, coalesce((select max(q.version) from pm.mfg_proposals q where q.org_id = e.org_id and q.estimate_id = e.id), 0) + 1,
            coalesce(nullif(btrim(a ->> 'title'), ''), e.title), coalesce(a -> 'alternates', '[]'::jsonb), coalesce(a -> 'allowances', '[]'::jsonb),
            coalesce(array(select jsonb_array_elements_text(coalesce(a -> 'clarifications', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(a -> 'exclusions', '[]'::jsonb))), '{}'),
            coalesce(a -> 'deposit_schedule', '[{"label":"Deposit at signing","pct":0.5},{"label":"At delivery","pct":0.4},{"label":"At completion","pct":0.1}]'::jsonb),
            coalesce(pm._x_try_date(a ->> 'valid_until'), e.valid_until))
    returning * into p;
  else
    update pm.mfg_proposals set title = coalesce(nullif(btrim(a ->> 'title'), ''), title), alternates = coalesce(a -> 'alternates', alternates),
           allowances = coalesce(a -> 'allowances', allowances),
           clarifications = coalesce(case when a ? 'clarifications' then array(select jsonb_array_elements_text(a -> 'clarifications')) end, clarifications),
           exclusions = coalesce(case when a ? 'exclusions' then array(select jsonb_array_elements_text(a -> 'exclusions')) end, exclusions),
           deposit_schedule = coalesce(a -> 'deposit_schedule', deposit_schedule), valid_until = coalesce(pm._x_try_date(a ->> 'valid_until'), valid_until), updated_at = now()
     where id = p.id returning * into p;
  end if;
  return to_jsonb(p) - 'org_id';
end $$;

-- After the app renders the PDF and sends it for signature: link the document + envelope; the estimate is
-- marked SENT (pm.send_estimate's own path stays the owner of the approvals floor — the app calls it first).
create or replace function pm.mfg_mark_proposal_sent(p_proposal uuid, p_file uuid, p_envelope uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.mfg_proposals%rowtype;
begin
  select * into p from pm.mfg_proposals q where q.id = p_proposal for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: proposal not found' using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_INVALID: proposal v% is %', p.version, lower(p.status) using errcode = '22023'; end if;
  if not exists (select 1 from pm.doc_files f where f.id = p_file and f.org_id = p.org_id and f.job_id = p.job_id) then raise exception 'PM_INVALID: that document is not on this job' using errcode = '22023'; end if;
  if p_envelope is not null and not exists (select 1 from pm.esign_envelopes v where v.id = p_envelope and v.org_id = p.org_id and v.file_id = p_file) then
    raise exception 'PM_INVALID: the signature request is not for that document' using errcode = '22023';
  end if;
  update pm.mfg_proposals set status = 'SUPERSEDED', updated_at = now() where org_id = p.org_id and estimate_id = p.estimate_id and status = 'SENT' and id <> p.id;
  update pm.mfg_proposals set status = 'SENT', file_id = p_file, envelope_id = p_envelope, sent_at = now(), updated_at = now() where id = p.id;
  return jsonb_build_object('proposal_id', p.id, 'status', 'SENT');
end $$;

-- First deposit of the schedule once the proposal is signed (Books mints the invoice → Customer Deposits).
create or replace function pm.mfg_request_proposal_deposit(p_proposal uuid, p_step int default 1)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.mfg_proposals%rowtype; v_pct numeric; v_label text; v_contract bigint; v_amt bigint; v_dep uuid;
begin
  select * into p from pm.mfg_proposals q where q.id = p_proposal for update;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: proposal not found' using errcode = '42501'; end if;
  if p.status <> 'SIGNED' then raise exception 'PM_INVALID: request deposits on a signed proposal' using errcode = '22023'; end if;
  select (x ->> 'pct')::numeric, x ->> 'label' into v_pct, v_label from jsonb_array_elements(p.deposit_schedule) with ordinality t(x, n) where n = coalesce(p_step, 1);
  if v_pct is null or v_pct <= 0 then raise exception 'PM_INVALID: that deposit step is not on the schedule' using errcode = '22023'; end if;
  select m.revised_contract_cents into v_contract from pm.v_job_money m where m.org_id = p.org_id and m.job_id = p.job_id;
  if coalesce(v_contract, 0) <= 0 then raise exception 'PM_INVALID: the contract is not set yet (accept the estimate first)' using errcode = '22023'; end if;
  v_amt := pm.fs_rdiv(v_contract * v_pct, 1);
  v_dep := pm.request_deposit(p.job_id, v_amt, left(coalesce(v_label, 'Deposit'), 200), current_date);
  if coalesce(p_step, 1) = 1 then update pm.mfg_proposals set deposit_request_id = v_dep where id = p.id; end if;
  return jsonb_build_object('deposit_request_id', v_dep, 'amount_cents', v_amt, 'label', v_label);
end $$;

-- ----------------------------------------------------------------------------
-- M5. MFG-14 Site measure gate · MFG-15 cabinet selections → upcharge CO
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_site_measures (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  wbs_id              uuid,
  room                text,
  scheduled_on        date,
  status              text not null default 'SCHEDULED' check (status in ('SCHEDULED','DONE','WAIVED','CANCELLED')),
  measured_by         text,
  measured_at         timestamptz,
  measure_id          uuid,
  dims                jsonb not null default '[]' check (jsonb_typeof(dims) = 'array'),   -- [{wall, width_in, height_in, depth_in, note}]
  photo_document_ids  uuid[] not null default '{}',
  notes               text,
  waive_reason        text,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  check (status <> 'WAIVED' or waive_reason is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_site_measures_job_idx on pm.mfg_site_measures (org_id, job_id, wbs_id);

create or replace function pm.mfg_schedule_measure(p_job uuid, p_wbs uuid, p_on date, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; a jsonb := coalesce(p_attrs, '{}');
begin
  select * into j from pm._x_job(p_job);
  if p_wbs is not null and not exists (select 1 from pm.wbs_nodes w where w.org_id = j.org_id and w.job_id = p_job and w.id = p_wbs) then
    raise exception 'PM_INVALID: that area is not on this job' using errcode = '22023';
  end if;
  insert into pm.mfg_site_measures (org_id, job_id, wbs_id, room, scheduled_on, notes)
  values (j.org_id, p_job, p_wbs, nullif(a ->> 'room', ''), p_on, nullif(a ->> 'notes', '')) returning id into v_id;
  return v_id;
end $$;

create or replace function pm.mfg_record_measure(p_measure uuid, p_dims jsonb, p_photos uuid[] default '{}', p_notes text default null, p_link_measure uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.mfg_site_measures%rowtype;
begin
  select * into m from pm.mfg_site_measures x where x.id = p_measure for update;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: site measure not found' using errcode = '42501'; end if;
  if m.status in ('DONE','CANCELLED') then raise exception 'PM_INVALID: this measure is already %', lower(m.status) using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_dims, '[]'::jsonb)) <> 'array' or (jsonb_array_length(coalesce(p_dims, '[]'::jsonb)) = 0 and coalesce(cardinality(p_photos), 0) = 0) then
    raise exception 'PM_INVALID: record the dimensions (or the measure sheet photos)' using errcode = '22023';
  end if;
  if p_link_measure is not null and not exists (select 1 from pm.measures x where x.id = p_link_measure and x.org_id = m.org_id and x.job_id = m.job_id) then
    raise exception 'PM_INVALID: that measure is not on this job' using errcode = '22023';
  end if;
  update pm.mfg_site_measures set status = 'DONE', measured_by = pm.current_user_id(), measured_at = now(), dims = coalesce(p_dims, '[]'::jsonb),
         photo_document_ids = coalesce(p_photos, '{}'), notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes), measure_id = p_link_measure where id = m.id;
  perform pm.log_activity(m.org_id, null, m.job_id, 'mfg.measured', 'mfg_site_measures', m.id, 'Field measure done', jsonb_build_object('walls', jsonb_array_length(coalesce(p_dims, '[]'::jsonb))));
  return jsonb_build_object('measure_id', m.id, 'status', 'DONE');
end $$;

create or replace function pm.mfg_waive_measure(p_measure uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.mfg_site_measures%rowtype;
begin
  select * into m from pm.mfg_site_measures x where x.id = p_measure for update;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: site measure not found' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: say why drafting can go ahead without a field measure' using errcode = '22023'; end if;
  update pm.mfg_site_measures set status = 'WAIVED', waive_reason = btrim(p_reason) where id = m.id;
  return jsonb_build_object('measure_id', m.id, 'status', 'WAIVED');
end $$;

-- The gates for one area: field measure done (or waived), selections approved, shop drawings state.
create or replace function pm._mfg5_area_gates(p_org uuid, p_job uuid, p_wbs uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_ops_settings; v_loc uuid; v_meas boolean; v_sel int; v_sd text;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job;
  s := pm._mfg5_set(p_org, v_loc);
  v_meas := not s.measure_required
         or exists (select 1 from pm.mfg_site_measures m where m.org_id = p_org and m.job_id = p_job and m.status in ('DONE','WAIVED')
                      and (m.wbs_id is not distinct from p_wbs or m.wbs_id is null));
  select count(*) into v_sel from pm.selections x where x.org_id = p_org and x.job_id = p_job and x.status not in ('APPROVED','VOID')
     and (p_wbs is null or x.wbs_id is null or x.wbs_id = p_wbs);
  select d.status into v_sd from pm.mfg_shop_drawings d where d.org_id = p_org and d.job_id = p_job and d.wbs_id is not distinct from p_wbs
   order by d.revision desc limit 1;
  return jsonb_build_object('measure_done', v_meas, 'open_selections', coalesce(v_sel, 0), 'selections_ok', not s.selections_gate or coalesce(v_sel, 0) = 0,
                            'shop_drawing_status', v_sd);
end $$;

-- Cabinet selections seeded here carry their upcharge rule in a side table (1106's selection ext is a
-- closed field list).
create table if not exists pm.mfg_selection_flags (
  selection_id     uuid primary key,
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  upcharge         boolean not null default true,
  change_order_id  uuid,
  created_at       timestamptz not null default now(),
  unique (org_id, selection_id),
  foreign key (org_id, selection_id) references pm.selections (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.mfg_seed_cabinet_selections(p_job uuid, p_wbs uuid, p_rows jsonb, p_due_on date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; r jsonb; o jsonb; v_sel uuid; n int := 0; k int; v_room text;
begin
  select * into j from pm._x_job(p_job);
  if p_wbs is not null then select w.name into v_room from pm.wbs_nodes w where w.org_id = j.org_id and w.job_id = p_job and w.id = p_wbs; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) = 0 then
    raise exception 'PM_INVALID: list the selections (door style, species, finish, sheen, hardware …)' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    insert into pm.selections (org_id, job_id, wbs_id, category, title, description, allowance_cents, due_on, room, client_visible)
    values (j.org_id, p_job, p_wbs, left(coalesce(r ->> 'category', 'Cabinets'), 80), left(coalesce(r ->> 'title', r ->> 'category', 'Selection'), 200), nullif(r ->> 'description', ''),
            coalesce(pm._x_try_bigint(r ->> 'allowance_cents'), 0), coalesce(pm._x_try_date(r ->> 'due_on'), p_due_on), coalesce(nullif(r ->> 'room', ''), v_room), true)
    returning id into v_sel;
    insert into pm.mfg_selection_flags (selection_id, org_id, job_id, upcharge) values (v_sel, j.org_id, p_job, coalesce(pm._x_try_bool(r ->> 'upcharge'), true));
    k := 0;
    for o in select value from jsonb_array_elements(coalesce(r -> 'options', '[]'::jsonb)) loop
      k := k + 1;
      insert into pm.selection_options (org_id, selection_id, sort, label, description, qty, uom, unit_price_cents, finish, is_recommended, client_visible)
      values (j.org_id, v_sel, k, left(coalesce(o ->> 'label', 'Option'), 200), nullif(o ->> 'description', ''), coalesce(pm._x_try_num(o ->> 'qty'), 1), 'EA',
              coalesce(pm._x_try_bigint(o ->> 'upcharge_cents'), pm._x_try_bigint(o ->> 'unit_price_cents'), 0), nullif(o ->> 'finish', ''),
              coalesce(pm._x_try_bool(o ->> 'recommended'), k = 1), true);
    end loop;
    n := n + 1;
  end loop;
  return jsonb_build_object('selections', n);
end $$;

-- An approved cabinet selection with a positive variance becomes a priced change order (PCO) for the upcharge.
create or replace function pm.tg_mfg5_selection_upcharge() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_co uuid;
begin
  if new.status = 'APPROVED' and old.status is distinct from 'APPROVED' and coalesce(new.variance_cents, 0) > 0
     and exists (select 1 from pm.mfg_selection_flags g where g.selection_id = new.id and g.upcharge and g.change_order_id is null) then
    insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, selection_id, area, requested_at, priced_at, co_type)
    values (new.org_id, new.job_id, left('Selection upcharge: ' || new.title, 200), 'Approved selection ' || new.title, 'Client selection', 'PCO', new.variance_cents,
            new.id, new.room, now(), now(), 'CLIENT')
    returning id into v_co;
    update pm.mfg_selection_flags set change_order_id = v_co where selection_id = new.id;
  end if;
  return null;
exception when others then
  raise warning '1125 selection upcharge CO failed: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_mfg5_selection_upcharge on pm.selections;
create trigger trg_mfg5_selection_upcharge after update of status on pm.selections for each row execute function pm.tg_mfg5_selection_upcharge();

-- ----------------------------------------------------------------------------
-- M6. MFG-16 Shop-drawing submittal log (per area revision cycle, GC / architect stamps) — approval is a
--     hard gate on drawings approval of the area's production orders.
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_shop_drawings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  wbs_id          uuid,
  number          text not null,
  revision        int not null default 0 check (revision >= 0),
  title           text not null check (char_length(title) between 1 and 200),
  status          text not null default 'DRAFTING' check (status in ('DRAFTING','SUBMITTED','APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED','RELEASED','SUPERSEDED','VOID')),
  file_id         uuid,
  envelope_id     uuid,
  reviewer_kind   text check (reviewer_kind is null or reviewer_kind in ('GC','ARCHITECT','DESIGNER','OWNER','ENGINEER')),
  submitted_at    timestamptz,
  submitted_by    text,
  returned_at     timestamptz,
  stamp_code      text check (stamp_code is null or stamp_code in ('APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED')),
  stamped_by      text,
  stamped_file_id uuid,
  comments        text,
  released_at     timestamptz,
  released_by     text,
  supersedes_id   uuid,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number, revision),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_shop_drawings_area_idx on pm.mfg_shop_drawings (org_id, job_id, wbs_id, revision desc);

create or replace function pm.mfg_create_shop_drawing(p_job uuid, p_wbs uuid, p_title text, p_file uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; n bigint; v_num text;
begin
  select * into j from pm._x_job(p_job);
  if p_wbs is not null and not exists (select 1 from pm.wbs_nodes w where w.org_id = j.org_id and w.job_id = p_job and w.id = p_wbs) then
    raise exception 'PM_INVALID: that area is not on this job' using errcode = '22023';
  end if;
  if exists (select 1 from pm.mfg_shop_drawings d where d.org_id = j.org_id and d.job_id = p_job and d.wbs_id is not distinct from p_wbs and d.status not in ('SUPERSEDED','VOID','REJECTED')) then
    raise exception 'PM_DUPLICATE: this area already has a shop drawing in its cycle; revise that one' using errcode = '23505';
  end if;
  if p_file is not null and not exists (select 1 from pm.doc_files f where f.id = p_file and f.org_id = j.org_id and f.job_id = p_job) then
    raise exception 'PM_INVALID: that document is not on this job' using errcode = '22023';
  end if;
  n := pm.next_doc_number(j.org_id, p_job::text, '1125:SD', 'job');
  v_num := 'SD-' || lpad(n::text, 3, '0');
  insert into pm.mfg_shop_drawings (org_id, job_id, wbs_id, number, title, file_id) values (j.org_id, p_job, p_wbs, v_num, btrim(p_title), p_file) returning id into v_id;
  return v_id;
end $$;

-- Security review R6: the stamp reviewer is outside the organization — an e-mail of any member of the
-- org (a drafter sending the "GC stamp" to themselves or a colleague) is refused before the envelope is sent.
create or replace function pm._mfg5_member_email(p_org uuid, p_email text) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select exists (select 1 from core.users u join core.memberships m on m.user_id = u.id
                  where m.org_id = p_org and lower(btrim(u.email)) = lower(btrim(coalesce(p_email, ''))))
$$;

create or replace function pm.mfg_check_reviewer(p_id uuid, p_email text)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.mfg_shop_drawings%rowtype;
begin
  select * into d from pm.mfg_shop_drawings x where x.id = p_id;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shop drawing not found' using errcode = '42501'; end if;
  if pm._mfg5_member_email(d.org_id, p_email) then
    raise exception 'PM_SOD_VIOLATION: the stamp comes from the GC / architect, not someone in your organization' using errcode = '42501';
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function pm.mfg_submit_shop_drawing(p_id uuid, p_file uuid, p_reviewer_kind text default 'GC', p_envelope uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.mfg_shop_drawings%rowtype;
begin
  select * into d from pm.mfg_shop_drawings x where x.id = p_id for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shop drawing not found' using errcode = '42501'; end if;
  if d.status <> 'DRAFTING' then raise exception 'PM_INVALID: % rev % is %', d.number, d.revision, lower(d.status) using errcode = '22023'; end if;
  if p_file is null or not exists (select 1 from pm.doc_files f where f.id = p_file and f.org_id = d.org_id and f.job_id = d.job_id) then
    raise exception 'PM_INVALID: attach the drawing PDF (a document on this job)' using errcode = '22023';
  end if;
  if p_envelope is not null and not exists (select 1 from pm.esign_envelopes v where v.id = p_envelope and v.org_id = d.org_id and v.file_id = p_file) then
    raise exception 'PM_INVALID: the stamp request is not for that document' using errcode = '22023';
  end if;
  if p_envelope is not null and exists (select 1 from pm.esign_signers sg where sg.org_id = d.org_id and sg.envelope_id = p_envelope and pm._mfg5_member_email(d.org_id, sg.email)) then
    raise exception 'PM_SOD_VIOLATION: the stamp comes from the GC / architect, not someone in your organization' using errcode = '42501';
  end if;
  update pm.mfg_shop_drawings set status = 'SUBMITTED', file_id = p_file, envelope_id = p_envelope, reviewer_kind = upper(coalesce(p_reviewer_kind, 'GC')),
         submitted_at = now(), submitted_by = pm.current_user_id(), updated_at = now() where id = d.id;
  return jsonb_build_object('shop_drawing_id', d.id, 'status', 'SUBMITTED');
end $$;

-- The returned stamp (portal / e-sign completion, or the stamped PDF the GC e-mailed back). Revise &
-- resubmit opens the next revision in DRAFTING.
create or replace function pm._mfg5_stamp(p_id uuid, p_code text, p_by text, p_comments text, p_stamped_file uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.mfg_shop_drawings%rowtype; v_code text := upper(coalesce(p_code, '')); v_next uuid;
begin
  select * into d from pm.mfg_shop_drawings x where x.id = p_id for update;
  if d.status <> 'SUBMITTED' then raise exception 'PM_INVALID: % rev % is not out for review', d.number, d.revision using errcode = '22023'; end if;
  if v_code not in ('APPROVED','APPROVED_AS_NOTED','REVISE_RESUBMIT','REJECTED') then raise exception 'PM_INVALID: stamp %', v_code using errcode = '22023'; end if;
  update pm.mfg_shop_drawings set status = v_code, stamp_code = v_code, stamped_by = left(p_by, 200), comments = nullif(btrim(coalesce(p_comments, '')), ''),
         stamped_file_id = p_stamped_file, returned_at = now(), updated_at = now() where id = d.id;
  if v_code = 'REVISE_RESUBMIT' then
    insert into pm.mfg_shop_drawings (org_id, job_id, wbs_id, number, revision, title, supersedes_id)
    values (d.org_id, d.job_id, d.wbs_id, d.number, d.revision + 1, d.title, d.id) returning id into v_next;
    update pm.mfg_shop_drawings set status = 'SUPERSEDED' where id = d.id;
    insert into pm.mfg_eng_tasks (org_id, job_id, wbs_id, kind, title, shop_drawing_id, status)
    values (d.org_id, d.job_id, d.wbs_id, 'REVISION', left(format('Revise %s rev %s: %s', d.number, d.revision + 1, coalesce(p_comments, 'per reviewer')), 200), v_next, 'QUEUED');
  end if;
  perform pm.log_activity(d.org_id, null, d.job_id, 'shop_drawing.stamped', 'mfg_shop_drawings', d.id, format('%s rev %s: %s by %s', d.number, d.revision, lower(replace(v_code, '_', ' ')), coalesce(p_by, 'reviewer')), '{}'::jsonb);
  return jsonb_build_object('shop_drawing_id', d.id, 'status', v_code, 'next_revision_id', v_next);
end $$;

create or replace function pm.mfg_record_stamp(p_id uuid, p_code text, p_by text, p_comments text default null, p_stamped_file uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.mfg_shop_drawings%rowtype;
begin
  select * into d from pm.mfg_shop_drawings x where x.id = p_id;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shop drawing not found' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_by, '')), '') is null then raise exception 'PM_INVALID: who stamped it?' using errcode = '22023'; end if;
  if upper(coalesce(p_code, '')) in ('REVISE_RESUBMIT','REJECTED','APPROVED_AS_NOTED') and nullif(btrim(coalesce(p_comments, '')), '') is null then
    raise exception 'PM_INVALID: record the reviewer''s comments' using errcode = '22023';
  end if;
  -- security review M6: a stamp typed in by hand is evidence only with the stamped file (a document on
  -- this job) and from someone other than the person who submitted it — or a production approver.
  if not pm._x_sees('projects.production', 'approve', null, d.job_id) then
    if p_stamped_file is null or not exists (select 1 from pm.doc_files f where f.id = p_stamped_file and f.org_id = d.org_id and f.job_id = d.job_id) then
      raise exception 'PM_INVALID: attach the stamped drawing the reviewer returned (a document on this job)' using errcode = '22023';
    end if;
    if d.submitted_by is not null and d.submitted_by = pm.current_user_id() then
      raise exception 'PM_SOD_VIOLATION: the person who submitted the drawing cannot record its stamp' using errcode = '42501';
    end if;
  elsif p_stamped_file is not null and not exists (select 1 from pm.doc_files f where f.id = p_stamped_file and f.org_id = d.org_id and f.job_id = d.job_id) then
    raise exception 'PM_INVALID: the stamped file is not a document on this job' using errcode = '22023';
  end if;
  return pm._mfg5_stamp(d.id, p_code, btrim(p_by), p_comments, p_stamped_file);
end $$;

-- Released for fabrication: approved (or approved as noted) + the field-measure gate; then the area's NEW
-- production orders get their drawings approval (1105 gate).
create or replace function pm.mfg_release_shop_drawing(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.mfg_shop_drawings%rowtype; g jsonb; w record; n int := 0;
begin
  select * into d from pm.mfg_shop_drawings x where x.id = p_id for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shop drawing not found' using errcode = '42501'; end if;
  if d.status not in ('APPROVED','APPROVED_AS_NOTED') then raise exception 'PM_SHOP_DRAWINGS_NOT_APPROVED: % rev % is %', d.number, d.revision, lower(replace(d.status, '_', ' ')) using errcode = '22023'; end if;
  -- security review R6: whoever submitted the drawing does not also release it for fabrication
  if d.submitted_by is not null and d.submitted_by = pm.current_user_id() and not pm._x_sees('projects.production', 'approve', null, d.job_id) then
    raise exception 'PM_SOD_VIOLATION: someone other than the drawing''s submitter releases it (or a production approver)' using errcode = '42501';
  end if;
  g := pm._mfg5_area_gates(d.org_id, d.job_id, d.wbs_id);
  if not (g ->> 'measure_done')::boolean then raise exception 'PM_MEASURE_REQUIRED: field-measure the area (or waive it) before releasing drawings' using errcode = '22023'; end if;
  update pm.mfg_shop_drawings set status = 'RELEASED', released_at = now(), released_by = pm.current_user_id(), updated_at = now() where id = d.id;
  for w in select x.id from pm.work_orders x where x.org_id = d.org_id and x.job_id = d.job_id and x.kind = 'PRODUCTION' and x.status = 'NEW'
             and x.wbs_id is not distinct from d.wbs_id and x.drawings_approved_at is null loop
    perform pm.approve_drawings(w.id, false);
    n := n + 1;
  end loop;
  return jsonb_build_object('shop_drawing_id', d.id, 'status', 'RELEASED', 'orders_approved', n);
end $$;

-- The gate: an area with a shop-drawing cycle cannot have production drawings approved until released.
create or replace function pm.tg_mfg5_drawings_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.kind = 'PRODUCTION' and new.drawings_approved_at is not null and old.drawings_approved_at is null
     and exists (select 1 from pm.mfg_shop_drawings d where d.org_id = new.org_id and d.job_id = new.job_id and d.wbs_id is not distinct from new.wbs_id and d.status <> 'VOID')
     and not exists (select 1 from pm.mfg_shop_drawings d where d.org_id = new.org_id and d.job_id = new.job_id and d.wbs_id is not distinct from new.wbs_id and d.status = 'RELEASED') then
    raise exception 'PM_SHOP_DRAWINGS_NOT_APPROVED: this area''s shop drawings are not approved and released yet' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_mfg5_drawings_gate on pm.work_orders;
create trigger trg_mfg5_drawings_gate before update of drawings_approved_at on pm.work_orders for each row execute function pm.tg_mfg5_drawings_gate();

create or replace function pm.mfg_shop_drawing_log(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'revision', d.revision, 'title', d.title, 'status', d.status, 'wbs_id', d.wbs_id,
      'area', (select w.name from pm.wbs_nodes w where w.id = d.wbs_id), 'file_id', d.file_id, 'envelope_id', d.envelope_id, 'reviewer_kind', d.reviewer_kind,
      'submitted_at', d.submitted_at, 'returned_at', d.returned_at, 'days_out', case when d.status = 'SUBMITTED' then current_date - d.submitted_at::date end,
      'stamp_code', d.stamp_code, 'stamped_by', d.stamped_by, 'comments', d.comments, 'released_at', d.released_at,
      'gates', pm._mfg5_area_gates(d.org_id, d.job_id, d.wbs_id)) order by d.number, d.revision desc)
    from pm.mfg_shop_drawings d where d.org_id = j.org_id and d.job_id = p_job), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- M7. MFG-17 Drawing sheet current-set enforcement. Shop and field seats (no Documents edit on the job)
--     see only the current revision of a sheet at companies that keep the rule on (default on).
-- ----------------------------------------------------------------------------
create or replace function pm.mfg_current_only_job_ids() returns setof uuid
language sql stable security definer
set search_path = pm, core, public
as $$
  select j.id from core.jobs j
   where j.org_id = public.get_org_id()
     and j.location_id in (select s.location_id from pm.mfg_settings s where s.org_id = public.get_org_id())
     and not exists (select 1 from pm.mfg_ops_settings o where o.org_id = j.org_id and o.location_id = j.location_id and not o.current_set_only)
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'drawing_revisions' and policyname = 'mfg_current_set_only') then
    create policy mfg_current_set_only on pm.drawing_revisions as restrictive for select to authenticated
      using (is_current
             or job_id in (select pm.my_job_ids_with('projects.documents', 'edit'))
             or job_id not in (select pm.mfg_current_only_job_ids()));
  end if;
end $$;

-- The current set of a job (or one area's sheets by number prefix) for the traveler / installer.
create or replace function pm.mfg_current_sheets(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return coalesce((select jsonb_agg(jsonb_build_object('sheet_id', s.id, 'sheet_number', s.sheet_number, 'title', coalesce(r.title, s.title), 'discipline', s.discipline,
      'revision_id', r.id, 'revision_label', r.revision_label, 'set', ds.name, 'set_kind', ds.set_kind, 'issued_on', ds.issued_on, 'revisions', s.revision_count,
      'superseded_count', greatest(s.revision_count - 1, 0)) order by s.sheet_number)
    from pm.drawing_sheets s join pm.drawing_revisions r on r.org_id = s.org_id and r.id = s.current_revision_id
    join pm.drawing_sets ds on ds.org_id = r.org_id and ds.id = r.set_id
   where s.org_id = j.org_id and s.job_id = p_job), '[]'::jsonb);
end $$;

-- Is this revision the one to build from? (watermark the viewer otherwise)
create or replace function pm.mfg_sheet_status(p_revision uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.drawing_revisions%rowtype; s pm.drawing_sheets%rowtype;
begin
  select * into r from pm.drawing_revisions x where x.id = p_revision;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: drawing not found' using errcode = '42501'; end if;
  select * into s from pm.drawing_sheets x where x.org_id = r.org_id and x.id = r.sheet_id;
  return jsonb_build_object('revision_id', r.id, 'is_current', r.is_current and s.current_revision_id = r.id, 'current_revision_id', s.current_revision_id,
    'sheet_number', s.sheet_number, 'watermark', case when r.is_current and s.current_revision_id = r.id then null else 'SUPERSEDED — DO NOT BUILD' end);
end $$;

-- ----------------------------------------------------------------------------
-- M8. MFG-18 Engineering queue + drafter load · MFG-22 CO → re-engineering
-- ----------------------------------------------------------------------------
alter table pm.mfg_shop_drawings add column if not exists submitted_by text;

create table if not exists pm.mfg_eng_tasks (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  wbs_id               uuid,
  kind                 text not null default 'DRAFTING' check (kind in ('DRAFTING','REVISION','CAD','CHECK','CO_REVISION')),
  title                text not null check (char_length(title) between 1 and 200),
  assignee_membership  uuid references core.memberships(id) on delete set null,
  slot_on              date,
  due_on               date,
  est_hours            numeric(7,2) not null default 0 check (est_hours >= 0),
  actual_hours         numeric(7,2) not null default 0 check (actual_hours >= 0),
  status               text not null default 'QUEUED' check (status in ('QUEUED','BLOCKED','IN_PROGRESS','SUBMITTED','DONE','CANCELLED')),
  blocked_reason       text,
  shop_drawing_id      uuid,
  change_order_id      uuid,
  done_at              timestamptz,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_eng_tasks_open_idx on pm.mfg_eng_tasks (org_id, job_id, status);

create or replace function pm.mfg_save_eng_task(p_job uuid, p_id uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a jsonb := coalesce(p_attrs, '{}'); v_id uuid := p_id; s pm.mfg_ops_settings; v_slot date; v_due date; v_asg uuid := pm.access_try_uuid(a ->> 'assignee_membership');
begin
  select * into j from pm._x_job(p_job);
  s := pm._mfg5_set(j.org_id, j.location_id);
  if v_asg is not null and not exists (select 1 from core.memberships m where m.id = v_asg and m.org_id = j.org_id and m.status = 'active') then
    raise exception 'PM_INVALID: that drafter is not in this organization' using errcode = '22023';
  end if;
  -- the production slot: given, or the earliest promise / planned start of the area's production orders
  v_slot := coalesce(pm._x_try_date(a ->> 'slot_on'), (select min(coalesce(w.scheduled_start::date, w.promised_on, w.due_on)) from pm.work_orders w
             where w.org_id = j.org_id and w.job_id = p_job and w.kind = 'PRODUCTION' and w.status = 'NEW' and w.wbs_id is not distinct from pm.access_try_uuid(a ->> 'wbs_id')));
  v_due := coalesce(pm._x_try_date(a ->> 'due_on'), v_slot - s.eng_buffer_days);
  if v_id is null then
    insert into pm.mfg_eng_tasks (org_id, job_id, wbs_id, kind, title, assignee_membership, slot_on, due_on, est_hours, shop_drawing_id, change_order_id)
    values (j.org_id, p_job, pm.access_try_uuid(a ->> 'wbs_id'), upper(coalesce(nullif(a ->> 'kind', ''), 'DRAFTING')), btrim(coalesce(a ->> 'title', 'Drafting')), v_asg, v_slot, v_due,
            coalesce(pm._x_try_num(a ->> 'est_hours'), 0), pm.access_try_uuid(a ->> 'shop_drawing_id'), pm.access_try_uuid(a ->> 'change_order_id'))
    returning id into v_id;
  else
    update pm.mfg_eng_tasks set title = coalesce(nullif(btrim(a ->> 'title'), ''), title), assignee_membership = coalesce(v_asg, assignee_membership),
           slot_on = coalesce(v_slot, slot_on), due_on = coalesce(v_due, due_on), est_hours = coalesce(pm._x_try_num(a ->> 'est_hours'), est_hours), updated_at = now()
     where org_id = j.org_id and job_id = p_job and id = v_id;
    if not found then raise exception 'PM_FORBIDDEN: engineering task not found' using errcode = '42501'; end if;
  end if;
  return v_id;
end $$;

-- Start / submit / finish; drafting cannot start while the area's gates (field measure, selections) are open.
create or replace function pm.mfg_move_eng_task(p_task uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.mfg_eng_tasks%rowtype; v_to text := upper(coalesce(p_status, '')); g jsonb; v_reason text;
begin
  select * into t from pm.mfg_eng_tasks x where x.id = p_task for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: engineering task not found' using errcode = '42501'; end if;
  if v_to not in ('QUEUED','IN_PROGRESS','SUBMITTED','DONE','CANCELLED') then raise exception 'PM_INVALID: status %', v_to using errcode = '22023'; end if;
  if v_to in ('IN_PROGRESS','SUBMITTED','DONE') and t.kind in ('DRAFTING','CAD') then
    g := pm._mfg5_area_gates(t.org_id, t.job_id, t.wbs_id);
    v_reason := case when not (g ->> 'measure_done')::boolean then 'Waiting on the field measure'
                     when not (g ->> 'selections_ok')::boolean then format('Waiting on %s selection(s)', g ->> 'open_selections') end;
    if v_reason is not null then
      update pm.mfg_eng_tasks set status = 'BLOCKED', blocked_reason = v_reason, updated_at = now() where id = t.id;
      return jsonb_build_object('task_id', t.id, 'status', 'BLOCKED', 'blocked_reason', v_reason);
    end if;
  end if;
  update pm.mfg_eng_tasks set status = v_to, blocked_reason = null, done_at = case when v_to = 'DONE' then now() end, updated_at = now() where id = t.id;
  return jsonb_build_object('task_id', t.id, 'status', v_to);
end $$;

-- Engineering hours: on the task and as a SUBMITTED time entry for the drafter (JOB_TIME, engineering bucket
-- through the job's ENGINEERING cost code when mapped).
create or replace function pm.mfg_log_eng_hours(p_task uuid, p_hours numeric, p_work_date date default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.mfg_eng_tasks%rowtype; v_emp uuid; v_te uuid; v_cc uuid; v_loc uuid;
begin
  select * into t from pm.mfg_eng_tasks x where x.id = p_task for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: engineering task not found' using errcode = '42501'; end if;
  if coalesce(p_hours, 0) <= 0 or p_hours > 24 then raise exception 'PM_INVALID: 0 to 24 hours' using errcode = '22023'; end if;
  select e.id into v_emp from core.employees e where e.org_id = t.org_id and e.clerk_user_id = pm.current_user_id() and e.is_active limit 1;
  select j.location_id into v_loc from core.jobs j where j.id = t.job_id;
  select b.cost_code_id into v_cc from pm.mfg_cost_buckets b where b.org_id = t.org_id and b.location_id = v_loc and b.bucket = 'ENGINEERING' limit 1;
  if v_emp is not null then
    insert into pm.time_entries (org_id, job_id, employee_id, user_id, work_date, hours, cost_code_id, wbs_id, notes, approval_state, source_ref)
    values (t.org_id, t.job_id, v_emp, pm.current_user_id(), coalesce(p_work_date, current_date), p_hours, v_cc, t.wbs_id,
            left('Engineering: ' || t.title || coalesce(' — ' || nullif(btrim(p_note), ''), ''), 500), 'SUBMITTED', 'pm:mfg_eng:' || t.id::text || ':' || gen_random_uuid()::text)
    returning id into v_te;
  end if;
  update pm.mfg_eng_tasks set actual_hours = actual_hours + p_hours, status = case when status = 'QUEUED' then 'IN_PROGRESS' else status end, updated_at = now() where id = t.id;
  return jsonb_build_object('task_id', t.id, 'time_entry_id', v_te, 'actual_hours', t.actual_hours + p_hours);
end $$;

-- The drafting kanban + drafter load per week (remaining estimated hours spread to the due week) vs capacity.
create or replace function pm.mfg_eng_board(p_location uuid, p_weeks int default 8)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); s pm.mfg_ops_settings; v_w0 date := date_trunc('week', current_date)::date;
begin
  s := pm._mfg5_set(v_org, p_location);
  return jsonb_build_object('capacity_hours_per_week', s.drafter_hours_per_week,
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'job_id', t.job_id, 'job', jb.job_number, 'job_name', jb.name, 'area', (select w.name from pm.wbs_nodes w where w.id = t.wbs_id),
        'wbs_id', t.wbs_id, 'kind', t.kind, 'title', t.title, 'status', t.status, 'blocked_reason', t.blocked_reason, 'assignee_membership', t.assignee_membership,
        'assignee', core.notify_member_name(t.assignee_membership), 'slot_on', t.slot_on, 'due_on', t.due_on, 'est_hours', t.est_hours, 'actual_hours', t.actual_hours,
        'at_risk', t.status not in ('DONE','CANCELLED','SUBMITTED') and t.due_on is not null and (t.due_on < current_date
                   or greatest(t.est_hours - t.actual_hours, 0) > s.drafter_hours_per_week / 5.0 * greatest((t.due_on - current_date), 0)),
        'gates', pm._mfg5_area_gates(t.org_id, t.job_id, t.wbs_id)) order by t.due_on nulls last, t.created_at)
      from pm.mfg_eng_tasks t join core.jobs jb on jb.org_id = t.org_id and jb.id = t.job_id
     where t.org_id = v_org and jb.location_id = p_location and (t.status not in ('DONE','CANCELLED') or t.done_at > now() - interval '14 days')), '[]'::jsonb),
    'load', coalesce((select jsonb_agg(jsonb_build_object('assignee_membership', x.m, 'assignee', core.notify_member_name(x.m), 'week', x.wk, 'hours', round(x.hrs, 1),
        'over', x.hrs > s.drafter_hours_per_week) order by x.m, x.wk)
      from (select t.assignee_membership m, greatest(date_trunc('week', coalesce(t.due_on, current_date))::date, v_w0) wk, sum(greatest(t.est_hours - t.actual_hours, 0)) hrs
              from pm.mfg_eng_tasks t join core.jobs jb on jb.org_id = t.org_id and jb.id = t.job_id
             where t.org_id = v_org and jb.location_id = p_location and t.status in ('QUEUED','BLOCKED','IN_PROGRESS')
               and coalesce(t.due_on, current_date) < v_w0 + make_interval(days => greatest(coalesce(p_weeks, 8), 1) * 7)
             group by 1, 2) x), '[]'::jsonb));
end $$;

create table if not exists pm.mfg_co_areas (
  org_id           uuid not null references core.organizations(id) on delete cascade,
  change_order_id  uuid not null,
  wbs_id           uuid not null,
  primary key (org_id, change_order_id, wbs_id)
);

create or replace function pm.mfg_link_co_areas(p_co uuid, p_wbs uuid[])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.change_orders%rowtype; w uuid; n int := 0;
begin
  select * into c from pm.change_orders x where x.id = p_co;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: change order not found' using errcode = '42501'; end if;
  delete from pm.mfg_co_areas where org_id = c.org_id and change_order_id = c.id;
  foreach w in array coalesce(p_wbs, '{}') loop
    if not exists (select 1 from pm.wbs_nodes x where x.org_id = c.org_id and x.job_id = c.job_id and x.id = w) then raise exception 'PM_INVALID: area not on this job' using errcode = '22023'; end if;
    insert into pm.mfg_co_areas (org_id, change_order_id, wbs_id) values (c.org_id, c.id, w) on conflict do nothing;
    n := n + 1;
  end loop;
  return jsonb_build_object('change_order_id', c.id, 'areas', n);
end $$;

-- A change order approved on areas it touches: re-engineering tasks open, released shop drawings for those
-- areas go back to a new revision, and released production orders there are listed as impacted.
create or replace function pm.tg_mfg5_co_reengineer() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a record; d pm.mfg_shop_drawings%rowtype; v_next uuid;
begin
  if new.stage = 'APPROVED' and old.stage is distinct from 'APPROVED' then
    for a in select x.wbs_id from pm.mfg_co_areas x where x.org_id = new.org_id and x.change_order_id = new.id loop
      insert into pm.mfg_eng_tasks (org_id, job_id, wbs_id, kind, title, change_order_id)
      values (new.org_id, new.job_id, a.wbs_id, 'CO_REVISION', left(format('Re-engineer for %s: %s', coalesce(new.number, 'CO'), new.title), 200), new.id);
      select * into d from pm.mfg_shop_drawings x where x.org_id = new.org_id and x.job_id = new.job_id and x.wbs_id = a.wbs_id
         and x.status in ('APPROVED','APPROVED_AS_NOTED','RELEASED') order by x.revision desc limit 1;
      if d.id is not null then
        insert into pm.mfg_shop_drawings (org_id, job_id, wbs_id, number, revision, title, supersedes_id, comments)
        values (d.org_id, d.job_id, d.wbs_id, d.number, d.revision + 1, d.title, d.id, 'Revision for ' || coalesce(new.number, 'a change order'))
        returning id into v_next;
        update pm.mfg_shop_drawings set status = 'SUPERSEDED', updated_at = now() where id = d.id;
      end if;
    end loop;
  end if;
  return null;
exception when others then
  raise warning '1125 CO re-engineering failed: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_mfg5_co_reengineer on pm.change_orders;
create trigger trg_mfg5_co_reengineer after update of stage on pm.change_orders for each row execute function pm.tg_mfg5_co_reengineer();

create or replace function pm.mfg_co_impact(p_co uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.change_orders%rowtype;
begin
  select * into c from pm.change_orders x where x.id = p_co;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: change order not found' using errcode = '42501'; end if;
  return jsonb_build_object('change_order_id', c.id, 'stage', c.stage,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('wbs_id', a.wbs_id, 'area', w.name)) from pm.mfg_co_areas a join pm.wbs_nodes w on w.id = a.wbs_id
                        where a.org_id = c.org_id and a.change_order_id = c.id), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('work_order_id', wo.id, 'number', wo.number, 'status', wo.status, 'area', (select w.name from pm.wbs_nodes w where w.id = wo.wbs_id),
        'ops_done', (select count(*) from pm.wo_operations o where o.org_id = wo.org_id and o.work_order_id = wo.id and o.status = 'DONE'),
        'issued_moves', (select count(*) from pm.material_moves m where m.org_id = wo.org_id and m.work_order_id = wo.id and m.kind = 'ISSUE')))
      from pm.work_orders wo where wo.org_id = c.org_id and wo.job_id = c.job_id and wo.kind = 'PRODUCTION'
       and wo.wbs_id in (select a.wbs_id from pm.mfg_co_areas a where a.org_id = c.org_id and a.change_order_id = c.id)), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status)) from pm.mfg_eng_tasks t where t.org_id = c.org_id and t.change_order_id = c.id), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- M9. MFG-20 cut list (edge banding per edge, grain, machining, labels, UOM) · MFG-25 family routings ·
--     MFG-32 paperless traveler
-- ----------------------------------------------------------------------------
alter table pm.bom_lines add column if not exists edge_l1 text;
alter table pm.bom_lines add column if not exists edge_l2 text;
alter table pm.bom_lines add column if not exists edge_w1 text;
alter table pm.bom_lines add column if not exists edge_w2 text;
alter table pm.bom_lines add column if not exists machining boolean;
alter table pm.bom_lines add column if not exists label_id text;

-- Edge codes "L1", "L2W1", "ALL", "L1L2W1W2" → per-edge flags (the CAD export format) — set on the line.
create or replace function pm._mfg5_edges(p text) returns text[]
language sql immutable
as $$
  select case when p is null or btrim(p) = '' then array[null, null, null, null]::text[]
              when upper(p) in ('ALL','4','L1L2W1W2') then array['EB','EB','EB','EB']
              else array[case when upper(p) like '%L1%' then 'EB' end, case when upper(p) like '%L2%' then 'EB' end,
                         case when upper(p) like '%W1%' then 'EB' end, case when upper(p) like '%W2%' then 'EB' end] end
$$;

-- The cut list of a production order: parts under their assemblies with size, grain, edges, labels;
-- per material the part area (sq ft), sheets at 4×8 (32 sq ft) less the nest's yield when known, edge
-- banding LF from the banded edges, board feet for lumber. Mirrors lib/mfg/uom.ts.
create or replace function pm.mfg_cut_list(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_parts jsonb; v_mat jsonb;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: production order not found' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'assembly', coalesce(p.assembly_ref, p.description), 'assembly_id', b.parent_id, 'part_code', b.part_code,
           'label_id', coalesce(b.label_id, b.source_ref), 'description', b.description, 'material', b.material, 'qty', b.qty, 'length_mm', b.length_mm, 'width_mm', b.width_mm,
           'thickness_mm', b.thickness_mm, 'grain', b.grain,
           'edges', jsonb_build_object('l1', coalesce(b.edge_l1, (pm._mfg5_edges(b.edgeband))[1]), 'l2', coalesce(b.edge_l2, (pm._mfg5_edges(b.edgeband))[2]),
                                       'w1', coalesce(b.edge_w1, (pm._mfg5_edges(b.edgeband))[3]), 'w2', coalesce(b.edge_w2, (pm._mfg5_edges(b.edgeband))[4])),
           'machining', coalesce(b.machining, false),
           'sqft', round(coalesce(b.length_mm, 0) * coalesce(b.width_mm, 0) * b.qty / 92903.04, 3),
           'edge_lf', round(b.qty * ((case when coalesce(b.edge_l1, (pm._mfg5_edges(b.edgeband))[1]) is not null then coalesce(b.length_mm, 0) else 0 end)
                                   + (case when coalesce(b.edge_l2, (pm._mfg5_edges(b.edgeband))[2]) is not null then coalesce(b.length_mm, 0) else 0 end)
                                   + (case when coalesce(b.edge_w1, (pm._mfg5_edges(b.edgeband))[3]) is not null then coalesce(b.width_mm, 0) else 0 end)
                                   + (case when coalesce(b.edge_w2, (pm._mfg5_edges(b.edgeband))[4]) is not null then coalesce(b.width_mm, 0) else 0 end)) / 304.8, 2))
           order by coalesce(p.seq, b.seq), b.seq), '[]'::jsonb)
    into v_parts
    from pm.bom_lines b left join pm.bom_lines p on p.org_id = b.org_id and p.id = b.parent_id
   where b.org_id = w.org_id and b.work_order_id = w.id and b.line_kind = 'PART';
  select coalesce(jsonb_agg(jsonb_build_object('material', x.material, 'thickness_mm', x.thickness_mm, 'parts', x.n, 'sqft', round(x.sqft, 2),
           'sheets_4x8', ceil(round(x.sqft / 32.0 / greatest(coalesce(y.yield, 0.80), 0.3), 6)), 'yield_pct', coalesce(y.yield, 0.80),
           'nest_sheets', y.sheets) order by x.material), '[]'::jsonb)
    into v_mat
    from (select upper(btrim(coalesce(b.material, '?'))) as material, b.thickness_mm, count(*) as n, sum(coalesce(b.length_mm, 0) * coalesce(b.width_mm, 0) * b.qty) / 92903.04 as sqft
            from pm.bom_lines b where b.org_id = w.org_id and b.work_order_id = w.id and b.line_kind = 'PART' group by 1, 2) x
    left join lateral (select avg(l.yield_pct) / case when avg(l.yield_pct) > 1 then 100 else 1 end as yield, sum(l.qty) as sheets
                         from pm.mfg_cad_lines l join pm.mfg_cad_imports i on i.org_id = l.org_id and i.id = l.import_id
                        where l.org_id = w.org_id and i.work_order_id = w.id and i.status = 'APPLIED' and l.line_kind = 'SHEET'
                          and upper(btrim(coalesce(l.material, '?'))) = x.material and l.thickness_mm is not distinct from x.thickness_mm) y on true;
  return jsonb_build_object('work_order_id', w.id, 'number', w.number, 'parts', v_parts, 'materials', v_mat,
    'edge_lf_total', (select coalesce(sum((p2 ->> 'edge_lf')::numeric), 0) from jsonb_array_elements(v_parts) p2),
    'board_feet', (select coalesce(round(sum(coalesce(b.length_mm, 0) * coalesce(b.width_mm, 0) * coalesce(b.thickness_mm, 0) * b.qty) / 2359737.216, 2), 0)
                     from pm.bom_lines b where b.org_id = w.org_id and b.work_order_id = w.id and b.line_kind = 'LUMBER'));
end $$;

create or replace function pm.mfg_set_part_edges(p_line uuid, p_edges jsonb, p_label text default null, p_machining boolean default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.bom_lines%rowtype; w pm.work_orders%rowtype;
begin
  select * into b from pm.bom_lines x where x.id = p_line for update;
  if b.org_id is null or b.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: BOM line not found' using errcode = '42501'; end if;
  select * into w from pm.work_orders x where x.org_id = b.org_id and x.id = b.work_order_id;
  if w.status <> 'NEW' then raise exception 'PM_PRODUCTION_LOCKED: % is released; change it through a change order', w.number using errcode = '55000'; end if;
  update pm.bom_lines set edge_l1 = nullif(p_edges ->> 'l1', ''), edge_l2 = nullif(p_edges ->> 'l2', ''), edge_w1 = nullif(p_edges ->> 'w1', ''),
         edge_w2 = nullif(p_edges ->> 'w2', ''), label_id = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label_id), machining = coalesce(p_machining, machining), updated_at = now()
   where id = b.id;
  return jsonb_build_object('line_id', b.id);
end $$;

create table if not exists pm.mfg_family_routings (
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  family       text not null check (family in ('BASE','WALL','TALL','VANITY','CLOSET','PANEL','FILLER','COUNTERTOP','DESK','FEATURE_WALL','OTHER')),
  routing_id   uuid not null,
  primary key (org_id, location_id, family),
  foreign key (org_id, routing_id) references pm.routings (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.mfg_set_family_routing(p_location uuid, p_family text, p_routing uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  if p_routing is null then
    delete from pm.mfg_family_routings where org_id = v_org and location_id = p_location and family = upper(p_family);
    return jsonb_build_object('family', upper(p_family), 'routing_id', null);
  end if;
  if not exists (select 1 from pm.routings r where r.id = p_routing and r.org_id = v_org and r.location_id = p_location and r.is_active) then
    raise exception 'PM_UNKNOWN_ROUTING: that routing is not active on this company' using errcode = 'P0002';
  end if;
  insert into pm.mfg_family_routings as f (org_id, location_id, family, routing_id) values (v_org, p_location, upper(p_family), p_routing)
  on conflict (org_id, location_id, family) do update set routing_id = excluded.routing_id;
  return jsonb_build_object('family', upper(p_family), 'routing_id', p_routing);
end $$;

-- Copy the family's routing template to a NEW production order (locked at release by 1105).
create or replace function pm.mfg_apply_family_routing(p_wo uuid, p_family text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_r uuid; n int;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: production order not found' using errcode = '42501'; end if;
  select f.routing_id into v_r from pm.mfg_family_routings f where f.org_id = w.org_id and f.location_id = w.location_id and f.family = upper(coalesce(p_family, ''));
  if v_r is null then raise exception 'PM_UNKNOWN_ROUTING: no routing template for the % family', lower(coalesce(p_family, '?')) using errcode = 'P0002'; end if;
  n := pm.apply_routing(w.id, v_r, true);
  begin
    perform pm.mfg_restandard_operations(w.id);
  exception when others then null;
  end;
  return jsonb_build_object('work_order_id', w.id, 'routing_id', v_r, 'operations', n);
end $$;

-- What the station shows: the operation, the order's current drawings (current revisions only), the
-- assemblies and their parts, the nest sheets, the photos / notes, change-order and superseded flags.
-- No money.
create or replace function pm.mfg_traveler(p_wo uuid, p_operation uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; op pm.wo_operations%rowtype; v_cos jsonb;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: production order not found' using errcode = '42501'; end if;
  if p_operation is not null then select * into op from pm.wo_operations x where x.org_id = w.org_id and x.work_order_id = w.id and x.id = p_operation; end if;
  select coalesce(jsonb_agg(jsonb_build_object('change_order_id', c.id, 'number', c.number, 'title', c.title, 'stage', c.stage, 'approved_at', c.approved_at) order by c.created_at), '[]'::jsonb)
    into v_cos from pm.change_orders c
   where c.org_id = w.org_id and c.job_id = w.job_id and c.stage not in ('VOID','REJECTED')
     and (exists (select 1 from pm.mfg_co_areas a where a.org_id = c.org_id and a.change_order_id = c.id and a.wbs_id is not distinct from w.wbs_id)
          or (w.released_at is not null and c.created_at > w.released_at and not exists (select 1 from pm.mfg_co_areas a where a.org_id = c.org_id and a.change_order_id = c.id)));
  return jsonb_build_object('work_order_id', w.id, 'number', w.number, 'summary', w.summary, 'status', w.status, 'job_id', w.job_id,
    'area', (select x.name from pm.wbs_nodes x where x.id = w.wbs_id), 'quantity', w.quantity, 'promised_on', w.promised_on,
    'operation', case when op.id is null then null else jsonb_build_object('id', op.id, 'seq', op.seq, 'name', op.name, 'status', op.status, 'std_minutes', op.std_minutes,
       'work_center', (select c.name from pm.work_centers c where c.id = op.work_center_id),
       'instructions', (select rs.instructions from pm.routing_steps rs where rs.id = op.routing_step_id)) end,
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'seq', o.seq, 'name', o.name, 'status', o.status,
        'work_center', (select c.name from pm.work_centers c where c.id = o.work_center_id)) order by o.seq) from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = w.id), '[]'::jsonb),
    'sheets', pm.mfg_current_sheets(w.job_id),
    'shop_drawing', (select jsonb_build_object('number', d.number, 'revision', d.revision, 'status', d.status, 'file_id', d.file_id, 'stamp_code', d.stamp_code, 'comments', d.comments)
                       from pm.mfg_shop_drawings d where d.org_id = w.org_id and d.job_id = w.job_id and d.wbs_id is not distinct from w.wbs_id and d.status not in ('SUPERSEDED','VOID')
                       order by d.revision desc limit 1),
    'assemblies', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'ref', a.assembly_ref, 'description', a.description, 'qty', a.qty,
        'parts', (select count(*) from pm.bom_lines p where p.org_id = a.org_id and p.parent_id = a.id)) order by a.seq)
      from pm.bom_lines a where a.org_id = w.org_id and a.work_order_id = w.id and a.line_kind = 'ASSEMBLY'), '[]'::jsonb),
    'nests', coalesce((select jsonb_agg(jsonb_build_object('material', l.material, 'thickness_mm', l.thickness_mm, 'sheets', l.qty, 'yield_pct', l.yield_pct, 'description', l.description) order by l.line_no)
      from pm.mfg_cad_lines l join pm.mfg_cad_imports i on i.org_id = l.org_id and i.id = l.import_id
     where l.org_id = w.org_id and i.work_order_id = w.id and i.status = 'APPLIED' and l.line_kind = 'SHEET'), '[]'::jsonb),
    'remakes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'part_label', r.part_label, 'reason_code', r.reason_code, 'status', r.status)) from pm.mfg_remakes r
      where r.org_id = w.org_id and r.work_order_id = w.id and r.status in ('REQUESTED','APPROVED')), '[]'::jsonb),
    'change_orders', v_cos, 'co_flag', jsonb_array_length(v_cos) > 0, 'notes', w.description);
end $$;

-- ----------------------------------------------------------------------------
-- M10. MFG-40 Sheet-goods inventory (spec per material, allocations, cycle counts) · MFG-42 issue from
--      nests · MFG-43 outside processing
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_sheet_specs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  material_key   text not null,
  item_id        uuid,
  material       text not null,
  kind           text not null default 'SHEET' check (kind in ('SHEET','EDGEBAND','HARDWARE','LUMBER','FINISH','OTHER')),
  thickness_mm   numeric(8,2),
  length_mm      numeric(8,1),
  width_mm       numeric(8,1),
  grain          text check (grain is null or grain in ('LENGTH','WIDTH','NONE')),
  finish         text,
  core           text,
  uom            text not null default 'SHEET',
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, material_key)
);

create table if not exists pm.mfg_allocations (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  item_id            uuid not null,
  stock_location_id  uuid not null,
  job_id             uuid not null,
  work_order_id      uuid,
  qty                numeric(14,4) not null check (qty > 0),
  status             text not null default 'ALLOCATED' check (status in ('ALLOCATED','ISSUED','RELEASED')),
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_alloc_item_idx on pm.mfg_allocations (org_id, item_id, stock_location_id, status);

create table if not exists pm.mfg_counts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  stock_location_id  uuid not null,
  status             text not null default 'OPEN' check (status in ('OPEN','POSTED','CANCELLED')),
  started_by         text default pm.current_user_id(),
  started_at         timestamptz not null default now(),
  posted_by          text,
  posted_at          timestamptz,
  unique (org_id, id),
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate
);
create table if not exists pm.mfg_count_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.organizations(id) on delete cascade,
  count_id    uuid not null,
  item_id     uuid not null,
  system_qty  numeric(14,4) not null,
  counted_qty numeric(14,4),
  move_id     uuid,
  unique (org_id, id),
  unique (count_id, item_id),
  foreign key (org_id, count_id) references pm.mfg_counts (org_id, id) on delete cascade deferrable initially immediate
);

-- One material key → its inventory item (the 1122 material setting's item, else a core.items identity).
create or replace function pm._mfg5_item_for(p_org uuid, p_location uuid, p_key text, p_name text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_item uuid;
begin
  select coalesce(s.item_id, ms.item_id) into v_item
    from (select 1) z
    left join pm.mfg_sheet_specs s on s.org_id = p_org and s.location_id = p_location and s.material_key = upper(p_key)
    left join pm.mfg_material_settings ms on ms.org_id = p_org and ms.location_id = p_location and ms.material_key = upper(p_key);
  if v_item is null then
    v_item := pm.ensure_part_item(p_org, left('MAT:' || upper(p_key), 60), coalesce(p_name, p_key));
    update pm.mfg_sheet_specs set item_id = v_item where org_id = p_org and location_id = p_location and material_key = upper(p_key) and item_id is null;
  end if;
  return v_item;
end $$;

create or replace function pm.mfg_save_sheet_spec(p_location uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); a jsonb := coalesce(p_attrs, '{}'); v_key text; v_id uuid; v_kind text := upper(coalesce(nullif(a ->> 'kind', ''), 'SHEET'));
begin
  if nullif(btrim(coalesce(a ->> 'material', '')), '') is null then raise exception 'PM_INVALID: name the material' using errcode = '22023'; end if;
  v_key := coalesce(nullif(upper(btrim(a ->> 'material_key')), ''), pm.mfg_material_key(v_kind, a ->> 'material', pm._x_try_num(a ->> 'thickness_mm'), a ->> 'part_code'));
  insert into pm.mfg_sheet_specs as s (org_id, location_id, material_key, material, kind, thickness_mm, length_mm, width_mm, grain, finish, core, uom)
  values (v_org, p_location, v_key, btrim(a ->> 'material'), v_kind, pm._x_try_num(a ->> 'thickness_mm'), coalesce(pm._x_try_num(a ->> 'length_mm'), 2440),
          coalesce(pm._x_try_num(a ->> 'width_mm'), 1220), upper(nullif(a ->> 'grain', '')), nullif(a ->> 'finish', ''), nullif(a ->> 'core', ''),
          coalesce(nullif(a ->> 'uom', ''), case when v_kind = 'EDGEBAND' then 'LF' when v_kind = 'SHEET' then 'SHEET' else 'EA' end))
  on conflict (org_id, location_id, material_key) do update set material = excluded.material, kind = excluded.kind, thickness_mm = excluded.thickness_mm,
    length_mm = excluded.length_mm, width_mm = excluded.width_mm, grain = excluded.grain, finish = excluded.finish, core = excluded.core, uom = excluded.uom
  returning id into v_id;
  perform pm._mfg5_item_for(v_org, p_location, v_key, btrim(a ->> 'material'));
  return v_id;
end $$;

-- On hand per spec per stock location, allocated to jobs, free.
create or replace function pm.mfg_sheet_inventory(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('spec_id', s.id, 'material_key', s.material_key, 'material', s.material, 'kind', s.kind, 'thickness_mm', s.thickness_mm,
      'size', case when s.length_mm is not null and s.width_mm is not null then format('%s × %s mm', trim(to_char(s.length_mm, 'FM99990')), trim(to_char(s.width_mm, 'FM99990'))) end,
      'grain', s.grain, 'finish', s.finish, 'core', s.core, 'uom', s.uom, 'item_id', s.item_id,
      'by_location', coalesce((select jsonb_agg(jsonb_build_object('stock_location_id', sl.id, 'stock_location', sl.name, 'on_hand', pm.part_on_hand(v_org, sl.id, s.item_id),
            'allocated', coalesce((select sum(a.qty) from pm.mfg_allocations a where a.org_id = v_org and a.item_id = s.item_id and a.stock_location_id = sl.id and a.status = 'ALLOCATED'), 0)) order by sl.name)
          from pm.stock_locations sl where sl.org_id = v_org and sl.location_id = p_location and sl.is_active and sl.kind in ('WAREHOUSE','SHOP','STAGING','REMNANT')), '[]'::jsonb),
      'on_hand', (select coalesce(sum(v.qty_on_hand), 0) from pm.v_stock_on_hand v where v.org_id = v_org and v.location_id = p_location and v.item_id = s.item_id),
      'allocated', coalesce((select sum(a.qty) from pm.mfg_allocations a where a.org_id = v_org and a.location_id = p_location and a.item_id = s.item_id and a.status = 'ALLOCATED'), 0))
      order by s.kind, s.material_key)
    from pm.mfg_sheet_specs s where s.org_id = v_org and s.location_id = p_location), '[]'::jsonb);
end $$;

create or replace function pm.mfg_allocate(p_job uuid, p_item uuid, p_stock_location uuid, p_qty numeric, p_wo uuid default null, p_release boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; v_oh numeric; v_alloc numeric;
begin
  select * into j from pm._x_job(p_job);
  if not exists (select 1 from pm.stock_locations s where s.id = p_stock_location and s.org_id = j.org_id and s.location_id = j.location_id) then
    raise exception 'PM_INVALID: stock location not on this company' using errcode = '22023';
  end if;
  if p_release then
    update pm.mfg_allocations set status = 'RELEASED' where org_id = j.org_id and job_id = p_job and item_id = p_item and stock_location_id = p_stock_location and status = 'ALLOCATED';
    return jsonb_build_object('released', true);
  end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;
  v_oh := pm.part_on_hand(j.org_id, p_stock_location, p_item);
  select coalesce(sum(a.qty), 0) into v_alloc from pm.mfg_allocations a where a.org_id = j.org_id and a.item_id = p_item and a.stock_location_id = p_stock_location and a.status = 'ALLOCATED';
  if v_oh - v_alloc < p_qty then raise exception 'PM_INVALID: only % free (% on hand, % allocated)', trim_scale(v_oh - v_alloc), trim_scale(v_oh), trim_scale(v_alloc) using errcode = '22023'; end if;
  insert into pm.mfg_allocations (org_id, location_id, item_id, stock_location_id, job_id, work_order_id, qty)
  values (j.org_id, j.location_id, p_item, p_stock_location, p_job, p_wo, p_qty) returning id into v_id;
  return jsonb_build_object('allocation_id', v_id, 'free_after', v_oh - v_alloc - p_qty);
end $$;

create or replace function pm.mfg_start_count(p_stock_location uuid, p_items uuid[] default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.stock_locations%rowtype; v_id uuid;
begin
  select * into s from pm.stock_locations x where x.id = p_stock_location;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: stock location not found' using errcode = '42501'; end if;
  insert into pm.mfg_counts (org_id, location_id, stock_location_id) values (s.org_id, s.location_id, s.id) returning id into v_id;
  insert into pm.mfg_count_lines (org_id, count_id, item_id, system_qty)
  select s.org_id, v_id, sp.item_id, pm.part_on_hand(s.org_id, s.id, sp.item_id)
    from pm.mfg_sheet_specs sp where sp.org_id = s.org_id and sp.location_id = s.location_id and sp.item_id is not null
     and (p_items is null or sp.item_id = any (p_items));
  return v_id;
end $$;

create or replace function pm.mfg_record_count(p_count uuid, p_item uuid, p_qty numeric)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.mfg_counts%rowtype;
begin
  select * into c from pm.mfg_counts x where x.id = p_count;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: count not found' using errcode = '42501'; end if;
  if c.status <> 'OPEN' then raise exception 'PM_INVALID: that count is %', lower(c.status) using errcode = '22023'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'PM_INVALID: counted quantity is ≥ 0' using errcode = '22023'; end if;
  insert into pm.mfg_count_lines as l (org_id, count_id, item_id, system_qty, counted_qty)
  values (c.org_id, c.id, p_item, pm.part_on_hand(c.org_id, c.stock_location_id, p_item), p_qty)
  on conflict (count_id, item_id) do update set counted_qty = excluded.counted_qty;
  return jsonb_build_object('count_id', c.id, 'item_id', p_item, 'counted', p_qty);
end $$;

-- Post: each counted line with a variance becomes an ADJUST move (shrink / overage; Books values it).
create or replace function pm.mfg_post_count(p_count uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.mfg_counts%rowtype; l pm.mfg_count_lines%rowtype; v_now numeric; v_var numeric; n int := 0; v_move uuid;
begin
  select * into c from pm.mfg_counts x where x.id = p_count for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: count not found' using errcode = '42501'; end if;
  if c.status <> 'OPEN' then raise exception 'PM_INVALID: that count is %', lower(c.status) using errcode = '22023'; end if;
  for l in select * from pm.mfg_count_lines x where x.org_id = c.org_id and x.count_id = c.id and x.counted_qty is not null loop
    v_now := pm.part_on_hand(c.org_id, c.stock_location_id, l.item_id);
    v_var := l.counted_qty - v_now;
    continue when v_var = 0;
    v_move := pm.record_material_move('ADJUST', l.item_id, abs(v_var), case when v_var < 0 then c.stock_location_id end, case when v_var > 0 then c.stock_location_id end,
                                      null, null, 'EA', null, 'pm:mfgcount:' || c.id::text || ':' || l.item_id::text, null, 'Cycle count variance');
    update pm.mfg_count_lines set move_id = v_move where id = l.id;
    n := n + 1;
  end loop;
  update pm.mfg_counts set status = 'POSTED', posted_at = now(), posted_by = pm.current_user_id() where id = c.id;
  return jsonb_build_object('count_id', c.id, 'adjustments', n);
end $$;

-- MFG-42: issue the nest's sheets (CAD import SHEET lines) to the production order from a stock location.
-- An issue over the nest by more than the tolerance is flagged (and needs a reason).
create table if not exists pm.mfg_material_issues (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  work_order_id   uuid not null,
  import_id       uuid,
  item_id         uuid not null,
  material_key    text,
  nest_qty        numeric(14,4),
  issued_qty      numeric(14,4) not null check (issued_qty > 0),
  over_pct        numeric(8,4),
  flagged         boolean not null default false,
  reason          text,
  move_id         uuid,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id)
);

create or replace function pm.mfg_issue_from_nest(p_wo uuid, p_stock_location uuid, p_lines jsonb default null, p_reason text default null, p_tolerance numeric default 0.05)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_imp uuid; r record; v_item uuid; v_qty numeric; v_over numeric; v_move uuid; v_out jsonb := '[]'; v_flag boolean; x jsonb;
begin
  select * into w from pm.work_orders q where q.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: production order not found' using errcode = '42501'; end if;
  if w.kind <> 'PRODUCTION' then raise exception 'PM_NOT_PRODUCTION: %', w.number using errcode = '22023'; end if;
  if not exists (select 1 from pm.stock_locations s where s.id = p_stock_location and s.org_id = w.org_id and s.location_id = w.location_id) then
    raise exception 'PM_INVALID: stock location not on this company' using errcode = '22023';
  end if;
  select i.id into v_imp from pm.mfg_cad_imports i where i.org_id = w.org_id and i.work_order_id = w.id and i.status = 'APPLIED' order by i.applied_at desc limit 1;
  for r in select pm.mfg_material_key('SHEET', l.material, l.thickness_mm, null) as key, min(l.material) as material, sum(l.qty) as nest_qty
             from pm.mfg_cad_lines l where l.org_id = w.org_id and l.import_id = v_imp and l.line_kind = 'SHEET' group by 1 loop
    v_qty := r.nest_qty;
    if p_lines is not null then
      select pm._x_try_num(y ->> 'qty') into v_qty from jsonb_array_elements(p_lines) y where upper(y ->> 'material_key') = r.key;
      continue when v_qty is null or v_qty <= 0;
    end if;
    v_over := case when r.nest_qty > 0 then round((v_qty - r.nest_qty) / r.nest_qty, 4) end;
    v_flag := coalesce(v_over, 0) > coalesce(p_tolerance, 0.05);
    if v_flag and nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'PM_INVALID: % is % over the nest; give a reason to issue it', r.key, round(v_over * 100, 1) || '%' using errcode = '22023';
    end if;
    v_item := pm._mfg5_item_for(w.org_id, w.location_id, r.key, r.material);
    v_move := pm.record_material_move('ISSUE', v_item, v_qty, p_stock_location, null, w.job_id, w.id, 'SHEET', null,
                                      'pm:mfgnest:' || w.id::text || ':' || r.key || ':' || to_char(now(), 'YYYYMMDDHH24MISSUS'), null, 'Issued from nest', r.material);
    insert into pm.mfg_material_issues (org_id, job_id, work_order_id, import_id, item_id, material_key, nest_qty, issued_qty, over_pct, flagged, reason, move_id)
    values (w.org_id, w.job_id, w.id, v_imp, v_item, r.key, r.nest_qty, v_qty, v_over, v_flag, nullif(btrim(coalesce(p_reason, '')), ''), v_move);
    update pm.mfg_allocations set status = 'ISSUED' where org_id = w.org_id and job_id = w.job_id and item_id = v_item and stock_location_id = p_stock_location and status = 'ALLOCATED';
    v_out := v_out || jsonb_build_object('material_key', r.key, 'nest_qty', r.nest_qty, 'issued_qty', v_qty, 'over_pct', v_over, 'flagged', v_flag, 'move_id', v_move);
  end loop;
  -- manual picks for materials not in the nest
  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    continue when exists (select 1 from jsonb_array_elements(v_out) o where o ->> 'material_key' = upper(x ->> 'material_key'));
    continue when coalesce(pm._x_try_num(x ->> 'qty'), 0) <= 0 or nullif(x ->> 'material_key', '') is null;
    v_item := pm._mfg5_item_for(w.org_id, w.location_id, upper(x ->> 'material_key'), x ->> 'material_key');
    v_move := pm.record_material_move('ISSUE', v_item, (x ->> 'qty')::numeric, p_stock_location, null, w.job_id, w.id, coalesce(nullif(x ->> 'uom', ''), 'EA'), null,
                                      'pm:mfgpick:' || w.id::text || ':' || upper(x ->> 'material_key') || ':' || to_char(now(), 'YYYYMMDDHH24MISSUS'), null, 'Manual pick', x ->> 'material_key');
    insert into pm.mfg_material_issues (org_id, job_id, work_order_id, item_id, material_key, issued_qty, reason, move_id)
    values (w.org_id, w.job_id, w.id, v_item, upper(x ->> 'material_key'), (x ->> 'qty')::numeric, nullif(btrim(coalesce(p_reason, '')), ''), v_move);
    v_out := v_out || jsonb_build_object('material_key', upper(x ->> 'material_key'), 'issued_qty', (x ->> 'qty')::numeric, 'move_id', v_move, 'manual', true);
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'PM_INVALID: nothing to issue (apply the CAD nest first, or pick materials)' using errcode = '22023'; end if;
  return jsonb_build_object('work_order_id', w.id, 'issued', v_out);
end $$;

-- MFG-43: send-out operations (finishing, stone, powder coat, purchased doors) with their own PO.
create table if not exists pm.mfg_outside_ops (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  work_order_id    uuid not null,
  operation_id     uuid not null,
  vendor_id        uuid not null references core.vendors(id),
  commitment_id    uuid,
  status           text not null default 'PLANNED' check (status in ('PLANNED','SENT','BACK','CANCELLED')),
  sent_on          date,
  due_back_on      date,
  back_on          date,
  qty              numeric(12,4) not null default 1 check (qty > 0),
  notes            text,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, operation_id)
);

create or replace function pm.mfg_send_outside(p_operation uuid, p_vendor uuid, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare op pm.wo_operations%rowtype; w pm.work_orders%rowtype; a jsonb := coalesce(p_attrs, '{}'); v_id uuid; v_c uuid; v_amt bigint := coalesce(pm._x_try_bigint(a ->> 'amount_cents'), 0);
        v_lead int; v_due date;
begin
  select * into op from pm.wo_operations x where x.id = p_operation;
  if op.org_id is null or op.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: operation not found' using errcode = '42501'; end if;
  select * into w from pm.work_orders x where x.org_id = op.org_id and x.id = op.work_order_id;
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = op.org_id) then raise exception 'PM_UNKNOWN_VENDOR: vendor not found' using errcode = '22023'; end if;
  select rs.outside_lead_days into v_lead from pm.routing_steps rs where rs.id = op.routing_step_id;
  v_due := coalesce(pm._x_try_date(a ->> 'due_back_on'), current_date + coalesce(v_lead, 7));
  if v_amt > 0 or coalesce(pm._x_try_bool(a ->> 'create_po'), true) then
    insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, description, status)
    values (op.org_id, w.location_id, w.job_id, p_vendor, 'PO', left('Outside: ' || op.name || ' — ' || coalesce(w.number, ''), 200), nullif(a ->> 'notes', ''), 'DRAFT')
    returning id into v_c;
    insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, unit_cost_cents, amount_cents)
    values (op.org_id, v_c, 1, (select b.cost_code_id from pm.mfg_cost_buckets b where b.org_id = op.org_id and b.location_id = w.location_id and b.bucket = 'OUTSIDE' limit 1),
            'SUBCONTRACTOR', left(op.name || ' (' || coalesce(w.number, '') || ')', 300), coalesce(pm._x_try_num(a ->> 'qty'), 1), 'EA',
            case when coalesce(pm._x_try_num(a ->> 'qty'), 1) > 0 then pm.fs_rdiv(v_amt, coalesce(pm._x_try_num(a ->> 'qty'), 1)) end, v_amt);
  end if;
  insert into pm.mfg_outside_ops as o (org_id, job_id, work_order_id, operation_id, vendor_id, commitment_id, status, sent_on, due_back_on, qty, notes)
  values (op.org_id, w.job_id, w.id, op.id, p_vendor, v_c, case when coalesce(pm._x_try_bool(a ->> 'sent'), true) then 'SENT' else 'PLANNED' end,
          case when coalesce(pm._x_try_bool(a ->> 'sent'), true) then current_date end, v_due, coalesce(pm._x_try_num(a ->> 'qty'), 1), nullif(a ->> 'notes', ''))
  on conflict (org_id, operation_id) do update set vendor_id = excluded.vendor_id, commitment_id = coalesce(o.commitment_id, excluded.commitment_id), status = excluded.status,
    sent_on = coalesce(o.sent_on, excluded.sent_on), due_back_on = excluded.due_back_on, qty = excluded.qty, notes = coalesce(excluded.notes, o.notes)
  returning id into v_id;
  return jsonb_build_object('outside_op_id', v_id, 'commitment_id', v_c, 'due_back_on', v_due);
end $$;

create or replace function pm.mfg_receive_outside(p_outside uuid, p_back_on date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare o pm.mfg_outside_ops%rowtype;
begin
  select * into o from pm.mfg_outside_ops x where x.id = p_outside for update;
  if o.org_id is null or o.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: outside operation not found' using errcode = '42501'; end if;
  if o.status not in ('SENT','PLANNED') then raise exception 'PM_INVALID: it is %', lower(o.status) using errcode = '22023'; end if;
  update pm.mfg_outside_ops set status = 'BACK', back_on = coalesce(p_back_on, current_date) where id = o.id;
  return jsonb_build_object('outside_op_id', o.id, 'status', 'BACK');
end $$;

-- Every send-out op with lateness vs the due date and vs the area's install date.
create or replace function pm.mfg_outside_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(r order by r ->> 'due_back_on') from (
    select jsonb_build_object('id', o.id, 'status', o.status, 'job', jb.job_number, 'job_id', o.job_id, 'work_order_id', o.work_order_id, 'order', w.number,
      'operation', op.name, 'vendor', v.name, 'sent_on', o.sent_on, 'due_back_on', o.due_back_on, 'back_on', o.back_on, 'commitment_id', o.commitment_id,
      'po_number', (select c.number from pm.commitments c where c.id = o.commitment_id),
      'install_on', (select min(i.starts_on) from pm.mfg_installs i where i.org_id = o.org_id and i.job_id = o.job_id and i.wbs_id is not distinct from w.wbs_id and i.status <> 'CANCELLED'),
      'late', o.status in ('PLANNED','SENT') and o.due_back_on < current_date,
      'breaks_install', o.status in ('PLANNED','SENT') and o.due_back_on >= (select min(i.starts_on) from pm.mfg_installs i where i.org_id = o.org_id and i.job_id = o.job_id
                                                                             and i.wbs_id is not distinct from w.wbs_id and i.status <> 'CANCELLED')) as r
      from pm.mfg_outside_ops o join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id join core.jobs jb on jb.id = o.job_id
      join pm.wo_operations op on op.org_id = o.org_id and op.id = o.operation_id join core.vendors v on v.id = o.vendor_id
     where o.org_id = v_org and jb.location_id = p_location and (o.status in ('PLANNED','SENT') or o.back_on > current_date - 30)) q), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- M11. MFG-44 Shipping & delivery tickets with proof of delivery
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_shipments (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  number               text not null,
  status               text not null default 'PACKING' check (status in ('PACKING','LOADED','DELIVERED','CANCELLED')),
  ship_on              date,
  promised_on          date,
  truck                text,
  driver               text,
  wbs_ids              uuid[] not null default '{}',
  delivered_at         timestamptz,
  signer_name          text,
  signature_document_id uuid,
  photo_document_ids   uuid[] not null default '{}',
  delivery_notes       text,
  load_check           jsonb not null default '{}' check (jsonb_typeof(load_check) = 'object'),
  billing_request_id   uuid,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.mfg_shipment_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  shipment_id     uuid not null,
  bom_line_id     uuid,
  work_order_id   uuid,
  wbs_id          uuid,
  room            text,
  label           text not null,
  description     text,
  crate           text,
  seq             int not null default 0,
  loaded          boolean not null default false,
  delivered       boolean not null default false,
  exception       text check (exception is null or exception in ('MISSING','DAMAGED','SHORT')),
  unique (org_id, id),
  foreign key (org_id, shipment_id) references pm.mfg_shipments (org_id, id) on delete cascade deferrable initially immediate
);

-- Build a packing list from the areas' assemblies (cabinets) in install sequence (area order, then BOM seq).
create or replace function pm.mfg_create_shipment(p_job uuid, p_wbs uuid[], p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a jsonb := coalesce(p_attrs, '{}'); v_id uuid; n int; v_num text;
begin
  select * into j from pm._x_job(p_job);
  v_num := 'SHP-' || (select job_number from core.jobs where id = p_job) || '-' || lpad(pm.next_doc_number(j.org_id, p_job::text, '1125:SHIP', 'job')::text, 2, '0');
  insert into pm.mfg_shipments (org_id, job_id, number, ship_on, promised_on, truck, driver, wbs_ids)
  values (j.org_id, p_job, v_num, pm._x_try_date(a ->> 'ship_on'), pm._x_try_date(a ->> 'promised_on'), nullif(a ->> 'truck', ''), nullif(a ->> 'driver', ''), coalesce(p_wbs, '{}'))
  returning id into v_id;
  insert into pm.mfg_shipment_items (org_id, shipment_id, bom_line_id, work_order_id, wbs_id, room, label, description, crate, seq)
  select j.org_id, v_id, b.id, b.work_order_id, coalesce(b.wbs_id, w.wbs_id), (select x.name from pm.wbs_nodes x where x.id = coalesce(b.wbs_id, w.wbs_id)),
         coalesce(b.label_id, b.assembly_ref, b.part_code, left(b.description, 40)), b.description, null,
         row_number() over (order by (select x.sort from pm.wbs_nodes x where x.id = coalesce(b.wbs_id, w.wbs_id)) nulls last, w.number, b.seq)
    from pm.bom_lines b join pm.work_orders w on w.org_id = b.org_id and w.id = b.work_order_id
   where b.org_id = j.org_id and b.job_id = p_job and b.line_kind in ('ASSEMBLY','BUYOUT') and w.kind = 'PRODUCTION' and w.status <> 'CANCELLED'
     and (cardinality(coalesce(p_wbs, '{}')) = 0 or coalesce(b.wbs_id, w.wbs_id) = any (p_wbs));
  get diagnostics n = row_count;
  return jsonb_build_object('shipment_id', v_id, 'number', v_num, 'items', n);
end $$;

create or replace function pm.mfg_mark_items(p_shipment uuid, p_items uuid[], p_field text, p_value boolean default true, p_exception text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_shipments%rowtype; n int;
begin
  select * into s from pm.mfg_shipments x where x.id = p_shipment;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  if s.status in ('DELIVERED','CANCELLED') then raise exception 'PM_INVALID: shipment % is %', s.number, lower(s.status) using errcode = '22023'; end if;
  if p_field = 'loaded' then
    update pm.mfg_shipment_items set loaded = p_value where org_id = s.org_id and shipment_id = s.id and id = any (p_items);
  elsif p_field = 'delivered' then
    update pm.mfg_shipment_items set delivered = p_value where org_id = s.org_id and shipment_id = s.id and id = any (p_items);
  elsif p_field = 'exception' then
    if p_exception is not null and upper(p_exception) not in ('MISSING','DAMAGED','SHORT') then raise exception 'PM_INVALID: exception %', p_exception using errcode = '22023'; end if;
    update pm.mfg_shipment_items set exception = upper(p_exception) where org_id = s.org_id and shipment_id = s.id and id = any (p_items);
  else
    raise exception 'PM_INVALID: mark loaded, delivered or an exception' using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('shipment_id', s.id, 'updated', n);
end $$;

-- Check the load against the BOM before the truck leaves: every assembly of the areas on board.
create or replace function pm.mfg_check_load(p_shipment uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_shipments%rowtype; v jsonb; v_missing int; v_total int; v_open int;
begin
  select * into s from pm.mfg_shipments x where x.id = p_shipment for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  select count(*), count(*) filter (where not loaded) into v_total, v_missing from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id;
  select count(*) into v_open from pm.work_orders w where w.org_id = s.org_id and w.job_id = s.job_id and w.kind = 'PRODUCTION'
     and (cardinality(s.wbs_ids) = 0 or w.wbs_id = any (s.wbs_ids)) and w.status not in ('COMPLETE','CLOSED','CANCELLED');
  v := jsonb_build_object('items', v_total, 'not_loaded', v_missing, 'orders_not_complete', v_open, 'ok', v_missing = 0 and v_open = 0,
    'not_loaded_labels', coalesce((select jsonb_agg(i.label order by i.seq) from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id and not i.loaded), '[]'::jsonb),
    'checked_at', now());
  update pm.mfg_shipments set load_check = v, status = case when v_missing = 0 and status = 'PACKING' then 'LOADED' else status end where id = s.id;
  return v;
end $$;

-- Proof of delivery: signer + signature image (a document the app filed) + photos; delivered items and
-- exceptions (a missing / damaged cabinet opens a remake request on its order). JOB_PROGRESS goes out.
create or replace function pm.mfg_deliver_shipment(p_shipment uuid, p_signer text, p_signature_document uuid, p_photos uuid[] default '{}', p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_shipments%rowtype; i record; n_rem int := 0; v_ev uuid; n_held int := 0; v_progress_pending boolean := false;
begin
  select * into s from pm.mfg_shipments x where x.id = p_shipment for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  if s.status in ('DELIVERED','CANCELLED') then raise exception 'PM_INVALID: shipment % is %', s.number, lower(s.status) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_signer, '')), '') is null then raise exception 'PM_INVALID: who received the delivery?' using errcode = '22023'; end if;
  -- security review M5: the signature image and photos are files of this org on this job
  perform pm._d5_claim_doc(s.org_id, s.job_id, p_signature_document, 'delivery signature');
  perform pm._d5_claim_docs(s.org_id, s.job_id, p_photos, 'delivery photo');
  update pm.mfg_shipment_items set delivered = true where org_id = s.org_id and shipment_id = s.id and loaded and exception is null;
  -- nested-guard audit: mfg_request_remake's guard (own operation / production / jobs edit) is skipped
  -- inside this RPC, so it is checked per order; a driver with dispatch rights only leaves the remake to the shop.
  for i in select * from pm.mfg_shipment_items x where x.org_id = s.org_id and x.shipment_id = s.id and x.exception in ('MISSING','DAMAGED') and x.work_order_id is not null loop
    if not (pm.access_my_work_order(i.work_order_id) or pm.access_can_row('projects.production', 'edit', 'work_orders', i.work_order_id)
            or pm.access_can_row('projects.jobs', 'edit', 'work_orders', i.work_order_id)) then
      n_held := n_held + 1;
      continue;
    end if;
    begin
      perform pm.mfg_request_remake(i.work_order_id, i.label, case when i.exception = 'MISSING' then 'MISSING' else 'DAMAGE_FIELD' end, 1,
                                    'Delivery ' || s.number || ': ' || lower(i.exception), '{}', 'FIELD', null);
      n_rem := n_rem + 1;
    exception when others then raise warning '1125 delivery remake failed: %', sqlerrm;
    end;
  end loop;
  update pm.mfg_shipments set status = 'DELIVERED', delivered_at = now(), signer_name = btrim(p_signer), signature_document_id = p_signature_document,
         photo_document_ids = coalesce(p_photos, '{}'), delivery_notes = nullif(btrim(coalesce(p_notes, '')), '') where id = s.id;
  -- nested-guard audit: JOB_PROGRESS is a Books event (emit_job_progress needs Job financials edit, a
  -- guard skipped inside this RPC) — sent only when the deliverer holds it; otherwise left for the PM.
  if pm._x_sees('projects.financials', 'edit', null, s.job_id) then
    begin
      v_ev := pm.emit_job_progress(s.job_id, 'PROGRESS_UPDATE', current_date);
    exception when others then v_ev := null;
    end;
  else
    v_progress_pending := true;
  end if;
  perform pm.log_activity(s.org_id, null, s.job_id, 'mfg.delivered', 'mfg_shipments', s.id, format('%s delivered, signed by %s', s.number, btrim(p_signer)),
    jsonb_build_object('remakes', n_rem, 'remakes_for_the_shop', n_held, 'progress_event', v_ev, 'progress_pending', v_progress_pending));
  return jsonb_build_object('shipment_id', s.id, 'status', 'DELIVERED', 'remakes', n_rem, 'remakes_for_the_shop', n_held, 'progress_event', v_ev,
                            'progress_pending', v_progress_pending);
end $$;

create or replace function pm.mfg_shipment_board(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'number', s.number, 'status', s.status, 'job_id', s.job_id, 'job', jb.job_number, 'job_name', jb.name,
      'ship_on', s.ship_on, 'promised_on', s.promised_on, 'delivered_at', s.delivered_at, 'signer_name', s.signer_name, 'truck', s.truck,
      'items', (select count(*) from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id),
      'loaded', (select count(*) from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id and i.loaded),
      'exceptions', (select count(*) from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id and i.exception is not null),
      'on_time', case when s.delivered_at is not null and s.promised_on is not null then s.delivered_at::date <= s.promised_on end,
      'load_check', s.load_check, 'billing_request_id', s.billing_request_id) order by (s.status = 'DELIVERED'), s.ship_on nulls last)
    from pm.mfg_shipments s join core.jobs jb on jb.id = s.job_id
   where s.org_id = v_org and jb.location_id = p_location and (s.status <> 'DELIVERED' or s.delivered_at > now() - interval '30 days')), '[]'::jsonb);
end $$;

create or replace function pm.mfg_shipment_detail(p_shipment uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_shipments%rowtype;
begin
  select * into s from pm.mfg_shipments x where x.id = p_shipment;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  return jsonb_build_object('shipment', to_jsonb(s) - 'org_id', 'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'description', i.description,
      'room', i.room, 'crate', i.crate, 'seq', i.seq, 'loaded', i.loaded, 'delivered', i.delivered, 'exception', i.exception) order by i.seq)
    from pm.mfg_shipment_items i where i.org_id = s.org_id and i.shipment_id = s.id), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- M12. MFG-46 Installer app (phone) · MFG-47 punch / back-charges / warranty
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_install_signoffs (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  install_id             uuid not null,
  job_id                 uuid not null,
  signer_name            text not null,
  signature_document_id  uuid,
  photo_document_ids     uuid[] not null default '{}',
  open_punch             int not null default 0,
  notes                  text,
  signed_at              timestamptz not null default now(),
  created_by             text default pm.current_user_id(),
  unique (org_id, id)
);

-- Today's (and this week's) installs for the signed-in installer: crews they are on, or every install for
-- dispatch / production managers. No money.
create or replace function pm.mfg_installer_home(p_location uuid, p_day date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_day date := coalesce(p_day, current_date); v_all boolean;
begin
  v_all := pm.access_can_location('projects.dispatch', 'edit', p_location) or pm.access_can_location('projects.production', 'edit', p_location);
  return jsonb_build_object('day', v_day, 'installs', coalesce((select jsonb_agg(jsonb_build_object('install_id', i.id, 'job_id', i.job_id, 'job', jb.job_number, 'job_name', jb.name,
      'area', (select w.name from pm.wbs_nodes w where w.id = i.wbs_id), 'wbs_id', i.wbs_id, 'starts_on', i.starts_on, 'ends_on', i.ends_on, 'status', i.status,
      'crew', (select c.name from pm.crews c where c.id = i.crew_id),
      'site', (select concat_ws(', ', p.site_address_line1, p.site_city, p.site_state) from pm.projects p where p.job_id = i.job_id),
      'open_punch', (select count(*) from pm.punch_items pi where pi.org_id = i.org_id and pi.job_id = i.job_id and pi.status in ('OPEN','IN_PROGRESS')
                                                         and (i.wbs_id is null or pi.wbs_id is null or pi.wbs_id = i.wbs_id)),
      'signed_off', exists (select 1 from pm.mfg_install_signoffs s where s.org_id = i.org_id and s.install_id = i.id)) order by i.starts_on)
    from pm.mfg_installs i join core.jobs jb on jb.id = i.job_id
   where i.org_id = v_org and jb.location_id = p_location and i.status <> 'CANCELLED' and v_day between i.starts_on - 1 and i.ends_on + 1
     and (v_all or i.crew_id in (select pm.my_crew_ids()) or i.job_id in (select pm.my_job_ids()))), '[]'::jsonb));
end $$;

-- Room-by-room install time from the phone: a SUBMITTED time entry on the job (install bucket).
-- Security review M4: idempotent by the phone's command id (source_ref pm:mfg_install:<install>:<command>,
-- unique per org), at most 16 h per employee per day across all their time, and the caller must be on the
-- install's crew (or hold projects.dispatch:edit on the job).
drop function if exists pm.mfg_log_install_time(uuid, numeric, text, text);
create or replace function pm.mfg_log_install_time(p_install uuid, p_hours numeric, p_room text default null, p_note text default null, p_command uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.mfg_installs%rowtype; v_emp uuid; v_cc uuid; v_loc uuid; v_te uuid; v_ref text; v_day numeric;
begin
  select * into i from pm.mfg_installs x where x.id = p_install;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: install not found' using errcode = '42501'; end if;
  v_ref := 'pm:mfg_install:' || i.id::text || ':' || coalesce(p_command, gen_random_uuid())::text;
  select t.id into v_te from pm.time_entries t where t.org_id = i.org_id and t.source_ref = v_ref;
  if v_te is not null then return jsonb_build_object('time_entry_id', v_te, 'replayed', true); end if;
  if coalesce(p_hours, 0) <= 0 or p_hours > 16 then raise exception 'PM_INVALID: 0 to 16 hours' using errcode = '22023'; end if;
  select e.id into v_emp from core.employees e where e.org_id = i.org_id and e.clerk_user_id = pm.current_user_id() and e.is_active limit 1;
  if v_emp is null then raise exception 'PM_NO_EMPLOYEE: your sign-in is not linked to an employee record' using errcode = '22023'; end if;
  if not ((i.crew_id is not null and i.crew_id in (select pm.my_crew_ids())) or pm.access_can_job('projects.dispatch', 'edit', i.job_id)) then
    raise exception 'PM_FORBIDDEN: log install time on an install your crew is on (or with projects.dispatch:edit)' using errcode = '42501';
  end if;
  select coalesce(sum(t.hours), 0) into v_day from pm.time_entries t
   where t.org_id = i.org_id and t.employee_id = v_emp and t.work_date = current_date and t.approval_state not in ('VOID','REJECTED');
  if v_day + p_hours > 16 then
    raise exception 'PM_INVALID: that makes % hours today; at most 16 hours a day (the office enters the rest)', v_day + p_hours using errcode = '22023';
  end if;
  select j.location_id into v_loc from core.jobs j where j.id = i.job_id;
  select b.cost_code_id into v_cc from pm.mfg_cost_buckets b where b.org_id = i.org_id and b.location_id = v_loc and b.bucket = 'INSTALL' limit 1;
  insert into pm.time_entries (org_id, job_id, employee_id, user_id, work_date, hours, cost_code_id, wbs_id, notes, approval_state, source_ref)
  values (i.org_id, i.job_id, v_emp, pm.current_user_id(), current_date, p_hours, v_cc, i.wbs_id,
          left('Install' || coalesce(' — ' || nullif(btrim(p_room), ''), '') || coalesce(': ' || nullif(btrim(p_note), ''), ''), 500), 'SUBMITTED',
          v_ref)
  returning id into v_te;
  if i.status in ('PLANNED','CONFIRMED') then update pm.mfg_installs set status = 'IN_PROGRESS', updated_at = now() where id = i.id; end if;
  return jsonb_build_object('time_entry_id', v_te, 'replayed', false);
end $$;

-- A punch item from the field (room, photo, responsible party); missing / damaged parts open a remake.
create table if not exists pm.mfg_punch_ext (
  punch_id            uuid primary key,
  org_id              uuid not null references core.organizations(id) on delete cascade,
  responsible         text not null check (responsible in ('SHOP','INSTALL','GC','VENDOR','DESIGN','CUSTOMER')),
  room                text,
  photo_document_ids  uuid[] not null default '{}',
  remake_id           uuid,
  backcharge_cents    bigint check (backcharge_cents is null or backcharge_cents >= 0),
  backcharge_to       text check (backcharge_to is null or backcharge_to in ('GC','VENDOR')),
  backcharge_customer_id uuid references core.customers(id),
  backcharge_vendor_id   uuid references core.vendors(id),
  backcharge_status   text check (backcharge_status is null or backcharge_status in ('PROPOSED','BILLED','ACCEPTED','WAIVED')),
  billing_request_id  uuid,
  warranty_of_job_id  uuid,
  created_at          timestamptz not null default now()
);

create or replace function pm.mfg_add_punch(p_job uuid, p_attrs jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a jsonb := coalesce(p_attrs, '{}'); v_id uuid; v_resp text := upper(coalesce(nullif(a ->> 'responsible', ''), 'INSTALL')); v_rem uuid; v_wo uuid := pm.access_try_uuid(a ->> 'work_order_id');
        v_kind text := upper(coalesce(nullif(a ->> 'kind', ''), 'PUNCH')); d uuid;
begin
  select * into j from pm._x_job(p_job);
  if nullif(btrim(coalesce(a ->> 'title', '')), '') is null then raise exception 'PM_INVALID: describe the punch item' using errcode = '22023'; end if;
  if v_kind not in ('PUNCH','WARRANTY','CALLBACK') then raise exception 'PM_INVALID: kind %', v_kind using errcode = '22023'; end if;
  insert into pm.punch_items (org_id, job_id, kind, title, description, wbs_id, area, responsible_vendor_id, assignee_user_id, due_on, billable, ext)
  values (j.org_id, p_job, v_kind, left(btrim(a ->> 'title'), 200), nullif(a ->> 'description', ''), pm.access_try_uuid(a ->> 'wbs_id'), nullif(a ->> 'room', ''),
          pm.access_try_uuid(a ->> 'vendor_id'), nullif(a ->> 'assignee_user_id', ''), pm._x_try_date(a ->> 'due_on'), v_resp in ('GC','VENDOR'),
          jsonb_build_object('mfg', jsonb_build_object('responsible', v_resp)))
  returning id into v_id;
  perform pm._d5_claim_docs(j.org_id, p_job, coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x
                                                             where pm.access_try_uuid(x) is not null), '{}'), 'punch photo');
  -- nested-guard audit: mfg_request_remake's guard is skipped here; a remake needs the caller's own
  -- operation, production edit or jobs edit on that order (jobs create alone opens the punch only).
  if v_wo is not null and upper(coalesce(a ->> 'part_issue', '')) in ('MISSING','DAMAGED')
     and not (pm.access_my_work_order(v_wo) or pm.access_can_row('projects.production', 'edit', 'work_orders', v_wo) or pm.access_can_row('projects.jobs', 'edit', 'work_orders', v_wo)) then
    raise exception 'PM_FORBIDDEN: requesting a remake needs your own operation, production edit or jobs edit on that order' using errcode = '42501';
  end if;
  if v_wo is not null and upper(coalesce(a ->> 'part_issue', '')) in ('MISSING','DAMAGED') then
    v_rem := pm.mfg_request_remake(v_wo, coalesce(nullif(a ->> 'part_label', ''), left(btrim(a ->> 'title'), 60)),
                                   case when upper(a ->> 'part_issue') = 'MISSING' then 'MISSING' else 'DAMAGE_FIELD' end, coalesce(pm._x_try_num(a ->> 'qty'), 1),
                                   left(btrim(a ->> 'title'), 500), coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x
                                                                                  where pm.access_try_uuid(x) is not null), '{}'), 'FIELD', null);
  end if;
  insert into pm.mfg_punch_ext (punch_id, org_id, responsible, room, photo_document_ids, remake_id)
  values (v_id, j.org_id, v_resp, nullif(a ->> 'room', ''),
          coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x where pm.access_try_uuid(x) is not null), '{}'), v_rem);
  for d in select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x loop
    continue when d is null;
    insert into pm.document_links (org_id, document_id, job_id, subject_table, subject_id, role) values (j.org_id, d, p_job, 'punch_items', v_id, 'photo')
    on conflict do nothing;
  end loop;
  return jsonb_build_object('punch_id', v_id, 'remake_id', v_rem);
end $$;

-- Back-charge the GC (a billing request line on the job, Books invoices it) or a vendor (a debit memo
-- request held here for Books AP — no Projects event exists for vendor debits).
create or replace function pm.mfg_backcharge(p_punch uuid, p_to text, p_amount_cents bigint, p_party uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare pu pm.punch_items%rowtype; x pm.mfg_punch_ext%rowtype; v_to text := upper(coalesce(p_to, '')); v_req uuid; v_contract uuid; v_loc uuid; v_cust uuid;
begin
  select * into pu from pm.punch_items q where q.id = p_punch;
  if pu.org_id is null or pu.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: punch item not found' using errcode = '42501'; end if;
  select * into x from pm.mfg_punch_ext q where q.punch_id = pu.id;
  if v_to not in ('GC','VENDOR') then raise exception 'PM_INVALID: back-charge the GC or a vendor' using errcode = '22023'; end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'PM_INVALID: the back-charge is > 0' using errcode = '22023'; end if;
  select j.location_id, j.customer_id into v_loc, v_cust from core.jobs j where j.id = pu.job_id;
  if v_to = 'GC' then
    v_contract := pm.primary_contract_id(pu.org_id, pu.job_id);
    if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the job has no active contract to bill against' using errcode = 'P0001'; end if;
    v_req := gen_random_uuid();
    insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, occurred_on, memo, created_by)
    values (v_req, pu.org_id, pu.job_id, v_contract, 'TIME_MATERIALS', 'DRAFT', current_date, left('Back-charge: ' || pu.title, 200), pm.current_user_id());
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, wbs_id)
    values (pu.org_id, v_req, 1, 0, 'STANDARD', left('Back-charge: ' || pu.title, 300), p_amount_cents, pu.wbs_id);
  else
    if p_party is null or not exists (select 1 from core.vendors v where v.id = p_party and v.org_id = pu.org_id) then raise exception 'PM_UNKNOWN_VENDOR: pick the vendor' using errcode = '22023'; end if;
  end if;
  insert into pm.mfg_punch_ext as e (punch_id, org_id, responsible, backcharge_cents, backcharge_to, backcharge_customer_id, backcharge_vendor_id, backcharge_status, billing_request_id)
  values (pu.id, pu.org_id, v_to, p_amount_cents, v_to, case when v_to = 'GC' then coalesce(p_party, v_cust) end, case when v_to = 'VENDOR' then p_party end,
          case when v_to = 'GC' then 'BILLED' else 'PROPOSED' end, v_req)
  on conflict (punch_id) do update set backcharge_cents = excluded.backcharge_cents, backcharge_to = excluded.backcharge_to,
    backcharge_customer_id = excluded.backcharge_customer_id, backcharge_vendor_id = excluded.backcharge_vendor_id, backcharge_status = excluded.backcharge_status,
    billing_request_id = coalesce(excluded.billing_request_id, e.billing_request_id);
  update pm.punch_items set billable = true, updated_at = now() where id = pu.id;
  return jsonb_build_object('punch_id', pu.id, 'billing_request_id', v_req, 'to', v_to);
end $$;

-- Warranty work opens against the original job (a WARRANTY punch + a service work order on that job).
create or replace function pm.mfg_open_warranty(p_job uuid, p_title text, p_attrs jsonb default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_p jsonb; v_wo uuid;
begin
  select * into j from pm._x_job(p_job);
  v_p := pm.mfg_add_punch(p_job, coalesce(p_attrs, '{}'::jsonb) || jsonb_build_object('title', p_title, 'kind', 'WARRANTY', 'responsible', coalesce(p_attrs ->> 'responsible', 'SHOP')));
  v_wo := pm.create_work_order(p_job, 'SERVICE', left('Warranty: ' || p_title, 200), 3, null, null, null, null, '{}', 'INTERNAL');
  update pm.mfg_punch_ext set warranty_of_job_id = p_job where punch_id = (v_p ->> 'punch_id')::uuid;
  return v_p || jsonb_build_object('work_order_id', v_wo);
end $$;

create or replace function pm.mfg_install_signoff(p_install uuid, p_signer text, p_signature_document uuid, p_photos uuid[] default '{}', p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.mfg_installs%rowtype; v_open int; v_id uuid;
begin
  select * into i from pm.mfg_installs x where x.id = p_install for update;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: install not found' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_signer, '')), '') is null then raise exception 'PM_INVALID: the customer''s name is required' using errcode = '22023'; end if;
  -- security review M5: the signature image and photos are files of this org on this job
  perform pm._d5_claim_doc(i.org_id, i.job_id, p_signature_document, 'install signature');
  perform pm._d5_claim_docs(i.org_id, i.job_id, p_photos, 'install photo');
  select count(*) into v_open from pm.punch_items p where p.org_id = i.org_id and p.job_id = i.job_id and p.status in ('OPEN','IN_PROGRESS')
     and (i.wbs_id is null or p.wbs_id is null or p.wbs_id = i.wbs_id);
  insert into pm.mfg_install_signoffs (org_id, install_id, job_id, signer_name, signature_document_id, photo_document_ids, open_punch, notes)
  values (i.org_id, i.id, i.job_id, btrim(p_signer), p_signature_document, coalesce(p_photos, '{}'), v_open, nullif(btrim(coalesce(p_notes, '')), '')) returning id into v_id;
  update pm.mfg_installs set status = 'DONE', updated_at = now() where id = i.id;
  return jsonb_build_object('signoff_id', v_id, 'open_punch', v_open);
end $$;

create or replace function pm.mfg_punch_board(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_cv boolean;
begin
  select * into j from pm._x_job(p_job);
  v_cv := pm._x_sees('projects.contract_value', 'view', j.location_id, p_job);
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'title', p.title, 'status', p.status, 'room', coalesce(x.room, p.area),
      'area', (select w.name from pm.wbs_nodes w where w.id = p.wbs_id), 'responsible', coalesce(x.responsible, p.ext #>> '{mfg,responsible}'), 'due_on', p.due_on,
      'photos', coalesce(cardinality(x.photo_document_ids), 0), 'remake_id', x.remake_id, 'backcharge_to', x.backcharge_to, 'backcharge_status', x.backcharge_status,
      'backcharge_cents', case when v_cv then x.backcharge_cents end, 'billing_request_id', x.billing_request_id, 'created_at', p.created_at)
      order by (p.status in ('OPEN','IN_PROGRESS')) desc, p.created_at)
    from pm.punch_items p left join pm.mfg_punch_ext x on x.punch_id = p.id where p.org_id = j.org_id and p.job_id = p_job and p.status <> 'VOID'), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- M13. MFG-48 job cost est vs committed vs actual by area and bucket · MFG-50 stored materials + bill on
--      ship · MFG-52 WIP · MFG-53 owner dashboard · MFG-55 portal feed
-- ----------------------------------------------------------------------------
create table if not exists pm.mfg_cost_buckets (
  org_id        uuid not null references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  cost_code_id  uuid not null,
  bucket        text not null check (bucket in ('MATERIAL','SHOP_LABOR','ENGINEERING','INSTALL','OUTSIDE','FREIGHT','COST_OF_QUALITY','OTHER')),
  primary key (org_id, location_id, cost_code_id),
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.mfg_set_cost_buckets(p_location uuid, p_rows jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); r jsonb; n int := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if not exists (select 1 from pm.cost_codes c where c.id = (r ->> 'cost_code_id')::uuid and c.org_id = v_org and c.location_id = p_location) then
      raise exception 'PM_INVALID: cost code not on this company' using errcode = '22023';
    end if;
    if r ->> 'bucket' is null then
      delete from pm.mfg_cost_buckets where org_id = v_org and location_id = p_location and cost_code_id = (r ->> 'cost_code_id')::uuid;
    else
      insert into pm.mfg_cost_buckets as b (org_id, location_id, cost_code_id, bucket) values (v_org, p_location, (r ->> 'cost_code_id')::uuid, upper(r ->> 'bucket'))
      on conflict (org_id, location_id, cost_code_id) do update set bucket = excluded.bucket;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Bucket of a cost code (mapped, else from the code's cost type).
create or replace function pm._mfg5_bucket(p_org uuid, p_location uuid, p_cost_code uuid, p_hint text) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce((select b.bucket from pm.mfg_cost_buckets b where b.org_id = p_org and b.location_id = p_location and b.cost_code_id = p_cost_code),
    case upper(coalesce((select c.cost_type from pm.cost_codes c where c.id = p_cost_code), p_hint, ''))
      when 'MATERIALS' then 'MATERIAL' when 'MATERIAL' then 'MATERIAL' when 'LABOR' then 'SHOP_LABOR' when 'SUBCONTRACTOR' then 'OUTSIDE' when 'SUBCONTRACT' then 'OUTSIDE'
      when 'EQUIPMENT' then 'OTHER' when 'FREIGHT' then 'FREIGHT'
      else 'OTHER' end)
$$;

create or replace function pm.mfg_job_cost(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_est uuid; v_rows jsonb; v_cq bigint;
begin
  select * into j from pm._x_job(p_job);
  select coalesce(sum(r.est_material_cents), 0)::bigint into v_cq from pm.mfg_remakes r where r.org_id = j.org_id and r.job_id = p_job and r.status in ('APPROVED','DONE');
  select e.id into v_est from pm.estimates e where e.org_id = j.org_id and e.job_id = p_job and e.status = 'ACCEPTED' order by e.accepted_at desc nulls last, e.version desc limit 1;
  with est as (
    select l.wbs_id, case when l.cost_code_id is not null then pm._mfg5_bucket(j.org_id, j.location_id, l.cost_code_id, null)
                          when coalesce(l.labor_hours, 0) > 0 then 'SHOP_LABOR' else 'MATERIAL' end as bucket, sum(coalesce(l.cost_cents, 0))::bigint as amt
      from pm.estimate_lines l where l.org_id = j.org_id and l.estimate_id = v_est group by 1, 2
  ), com as (
    select null::uuid as wbs_id, pm._mfg5_bucket(j.org_id, j.location_id, cl.cost_code_id, cl.cost_type) as bucket, sum(cl.amount_cents)::bigint as amt
      from pm.commitment_lines cl join pm.commitments c on c.org_id = cl.org_id and c.id = cl.commitment_id
     where c.org_id = j.org_id and c.job_id = p_job and c.status in ('APPROVED','EXECUTED','CLOSED') group by 1, 2
  ), act as (
    select null::uuid as wbs_id, pm._mfg5_bucket(j.org_id, j.location_id, jc.cost_code_id, jc.cost_type) as bucket, sum(jc.amount_cents)::bigint as amt
      from pm.job_costs jc where jc.org_id = j.org_id and jc.job_id = p_job and jc.lifecycle in ('PENDING','CLEARED') group by 1, 2
  ), keys as (select wbs_id, bucket from est union select wbs_id, bucket from com union select wbs_id, bucket from act)
  select coalesce(jsonb_agg(jsonb_build_object('wbs_id', k.wbs_id, 'area', coalesce((select w.name from pm.wbs_nodes w where w.id = k.wbs_id), 'Job-level / not by area'),
           'bucket', k.bucket, 'estimate_cents', coalesce(e.amt, 0), 'committed_cents', coalesce(c.amt, 0), 'actual_cents', coalesce(a.amt, 0),
           'variance_cents', coalesce(e.amt, 0) - greatest(coalesce(a.amt, 0), coalesce(c.amt, 0))) order by k.wbs_id nulls last, k.bucket), '[]'::jsonb)
    into v_rows
    from keys k left join est e on e.wbs_id is not distinct from k.wbs_id and e.bucket = k.bucket
    left join com c on c.wbs_id is not distinct from k.wbs_id and c.bucket = k.bucket
    left join act a on a.wbs_id is not distinct from k.wbs_id and a.bucket = k.bucket;
  return jsonb_build_object('job_id', p_job, 'estimate_id', v_est, 'rows', v_rows,
    'totals', jsonb_build_object('estimate_cents', (select coalesce(sum((r ->> 'estimate_cents')::bigint), 0) from jsonb_array_elements(v_rows) r),
                                 'committed_cents', (select coalesce(sum((r ->> 'committed_cents')::bigint), 0) from jsonb_array_elements(v_rows) r),
                                 'actual_cents', (select coalesce(sum((r ->> 'actual_cents')::bigint), 0) from jsonb_array_elements(v_rows) r)),
    'cost_of_quality_cents', coalesce(v_cq, 0),
    'note', 'Actual is Books job cost (materials, payroll + burden, bills). Overhead is never on the job.');
end $$;

create table if not exists pm.mfg_stored_materials (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  wbs_id              uuid,
  description         text not null check (char_length(description) between 1 and 300),
  stored_at           text not null check (char_length(stored_at) between 1 and 200),
  value_cents         bigint not null check (value_cents > 0),
  insured             boolean not null default false,
  stored_on           date not null default current_date,
  photo_document_ids  uuid[] not null default '{}',
  status              text not null default 'STORED' check (status in ('STORED','BILLED','DELIVERED','CANCELLED')),
  billing_request_id  uuid,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.mfg_add_stored_material(p_job uuid, p_attrs jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a jsonb := coalesce(p_attrs, '{}'); v_id uuid;
begin
  select * into j from pm._x_job(p_job);
  if coalesce(pm._x_try_bigint(a ->> 'value_cents'), 0) <= 0 then raise exception 'PM_INVALID: the stored value is > 0' using errcode = '22023'; end if;
  insert into pm.mfg_stored_materials (org_id, job_id, wbs_id, description, stored_at, value_cents, insured, stored_on, photo_document_ids)
  values (j.org_id, p_job, pm.access_try_uuid(a ->> 'wbs_id'), btrim(a ->> 'description'), btrim(coalesce(a ->> 'stored_at', 'Shop')), (a ->> 'value_cents')::bigint,
          coalesce(pm._x_try_bool(a ->> 'insured'), false), coalesce(pm._x_try_date(a ->> 'stored_on'), current_date),
          coalesce(array(select pm.access_try_uuid(x) from jsonb_array_elements_text(coalesce(a -> 'photo_document_ids', '[]'::jsonb)) x where pm.access_try_uuid(x) is not null), '{}'))
  returning id into v_id;
  return v_id;
end $$;

-- Bill stored materials (millwork finished and stored off-site): one DRAFT billing request with the
-- stored-materials column (G703 column F); Books mints the invoice when it is approved and emitted.
create or replace function pm.mfg_bill_stored_materials(p_job uuid, p_ids uuid[])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_contract uuid; v_req uuid := gen_random_uuid(); v_sum bigint; n int := 0; m pm.mfg_stored_materials%rowtype;
begin
  select * into j from pm._x_job(p_job);
  v_contract := pm.primary_contract_id(j.org_id, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the job has no active contract' using errcode = 'P0001'; end if;
  select coalesce(sum(x.value_cents), 0) into v_sum from pm.mfg_stored_materials x where x.org_id = j.org_id and x.job_id = p_job and x.id = any (p_ids) and x.status = 'STORED';
  if v_sum = 0 then raise exception 'PM_INVALID: pick stored materials that are not billed yet' using errcode = '22023'; end if;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, occurred_on, period_end, memo, created_by)
  values (v_req, j.org_id, p_job, v_contract, 'PROGRESS', 'DRAFT', current_date, current_date, 'Materials stored off site', pm.current_user_id());
  for m in select * from pm.mfg_stored_materials x where x.org_id = j.org_id and x.job_id = p_job and x.id = any (p_ids) and x.status = 'STORED' order by x.stored_on loop
    n := n + 1;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, wbs_id, stored_materials_cents)
    values (j.org_id, v_req, n, n, 'STANDARD', left('Stored at ' || m.stored_at || ': ' || m.description, 300), m.value_cents, m.wbs_id, m.value_cents);
    update pm.mfg_stored_materials set status = 'BILLED', billing_request_id = v_req where id = m.id;
  end loop;
  -- nested-guard audit: finalize_billing_retainage (Billing edit) runs on the DRAFT request this call just made —
  -- the retainage is computed from the contract, nothing caller-supplied; review / approval stay Billing's.
  begin perform pm.finalize_billing_retainage(v_req); exception when others then null; end;
  return jsonb_build_object('billing_request_id', v_req, 'lines', n, 'amount_cents', v_sum);
end $$;

-- Invoice on ship: the delivered areas' contract value (the accepted estimate's lines for those areas)
-- less what was already billed for them as stored materials.
create or replace function pm.mfg_bill_shipment(p_shipment uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_shipments%rowtype; v_contract uuid; v_req uuid := gen_random_uuid(); v_est uuid; r record; n int := 0; v_total bigint := 0; v_stored bigint;
begin
  select * into s from pm.mfg_shipments x where x.id = p_shipment for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: shipment not found' using errcode = '42501'; end if;
  if s.status <> 'DELIVERED' then raise exception 'PM_INVALID: bill a delivered shipment' using errcode = '22023'; end if;
  if s.billing_request_id is not null then raise exception 'PM_DUPLICATE: this delivery is already billed' using errcode = '23505'; end if;
  v_contract := pm.primary_contract_id(s.org_id, s.job_id);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: the job has no active contract' using errcode = 'P0001'; end if;
  select e.id into v_est from pm.estimates e where e.org_id = s.org_id and e.job_id = s.job_id and e.status = 'ACCEPTED' order by e.accepted_at desc nulls last limit 1;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, occurred_on, period_end, memo, created_by)
  values (v_req, s.org_id, s.job_id, v_contract, 'PROGRESS', 'DRAFT', current_date, current_date, 'Delivered: ' || s.number, pm.current_user_id());
  for r in select l.wbs_id, sum(l.amount_cents)::bigint as amt, (select w.name from pm.wbs_nodes w where w.id = l.wbs_id) as area
             from pm.estimate_lines l where l.org_id = s.org_id and l.estimate_id = v_est
              and (cardinality(s.wbs_ids) = 0 or l.wbs_id = any (s.wbs_ids)) group by 1 loop
    continue when coalesce(r.amt, 0) <= 0;
    select coalesce(sum(m.value_cents), 0) into v_stored from pm.mfg_stored_materials m
     where m.org_id = s.org_id and m.job_id = s.job_id and m.wbs_id is not distinct from r.wbs_id and m.status = 'BILLED';
    n := n + 1;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, wbs_id)
    values (s.org_id, v_req, n, n, 'STANDARD', left('Delivered — ' || coalesce(r.area, 'job'), 300), r.amt - v_stored, r.wbs_id);
    update pm.mfg_stored_materials set status = 'DELIVERED' where org_id = s.org_id and job_id = s.job_id and wbs_id is not distinct from r.wbs_id and status = 'BILLED';
    v_total := v_total + r.amt - v_stored;
  end loop;
  if n = 0 then raise exception 'PM_INVALID: no estimate value on the delivered areas (accept the estimate, with areas on its lines)' using errcode = '22023'; end if;
  -- nested-guard audit: finalize_billing_retainage (Billing edit) runs on the DRAFT request this call just made —
  -- the retainage is computed from the contract, nothing caller-supplied; review / approval stay Billing's.
  begin perform pm.finalize_billing_retainage(v_req); exception when others then null; end;
  update pm.mfg_shipments set billing_request_id = v_req where id = s.id;
  return jsonb_build_object('billing_request_id', v_req, 'lines', n, 'amount_cents', v_total);
end $$;

create or replace function pm.mfg_billing_board(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_cv boolean;
begin
  select * into j from pm._x_job(p_job);
  v_cv := pm._x_sees('projects.contract_value', 'view', j.location_id, p_job);
  return jsonb_build_object(
    'proposal', (select jsonb_build_object('id', p.id, 'version', p.version, 'status', p.status, 'deposit_schedule', p.deposit_schedule, 'deposit_request_id', p.deposit_request_id)
                   from pm.mfg_proposals p where p.org_id = j.org_id and p.job_id = p_job and p.status in ('SIGNED','SENT') order by p.version desc limit 1),
    'stored', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'description', m.description, 'stored_at', m.stored_at, 'status', m.status, 'stored_on', m.stored_on,
        'insured', m.insured, 'area', (select w.name from pm.wbs_nodes w where w.id = m.wbs_id), 'billing_request_id', m.billing_request_id,
        'value_cents', case when v_cv then m.value_cents end) order by m.stored_on) from pm.mfg_stored_materials m where m.org_id = j.org_id and m.job_id = p_job and m.status <> 'CANCELLED'), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'number', s.number, 'status', s.status, 'delivered_at', s.delivered_at, 'billing_request_id', s.billing_request_id))
      from pm.mfg_shipments s where s.org_id = j.org_id and s.job_id = p_job), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'billing_type', r.billing_type, 'status', r.status, 'memo', r.memo, 'occurred_on', r.occurred_on,
        'invoice_number', r.invoice_number, 'net_cents', case when v_cv then r.net_cents end) order by r.created_at desc)
      from pm.billing_requests r where r.org_id = j.org_id and r.job_id = p_job), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'memo', d.memo, 'status', d.status, 'invoice_number', d.invoice_number,
        'amount_cents', case when v_cv then d.amount_cents end) order by d.created_at) from pm.deposit_requests d where d.org_id = j.org_id and d.job_id = p_job), '[]'::jsonb),
    'amounts_visible', v_cv);
end $$;

-- WIP per job (cost-to-cost): contract, EAC (the revised budget, raised to actual when actual is over),
-- cost to date (Books job cost), % complete, earned, billed, over / under, margin and fade vs the last
-- pinned snapshot. Books computes the booked WIP; this is the shop's working view of the same math.
create table if not exists pm.mfg_wip_snapshots (
  org_id        uuid not null references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  period_end    date not null,
  contract_cents bigint not null,
  eac_cents     bigint not null,
  cost_cents    bigint not null,
  billed_cents  bigint not null,
  margin_pct    numeric(8,5),
  pinned_by     text default pm.current_user_id(),
  pinned_at     timestamptz not null default now(),
  primary key (org_id, job_id, period_end)
);

create or replace function pm._mfg5_wip_row(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare m pm.v_job_money%rowtype; v_cost bigint; v_billed bigint; v_eac bigint; v_pct numeric; v_earned bigint; v_margin numeric; sn pm.mfg_wip_snapshots%rowtype;
begin
  select * into m from pm.v_job_money x where x.org_id = p_org and x.job_id = p_job;
  select coalesce(sum(jc.amount_cents), 0) into v_cost from pm.job_costs jc where jc.org_id = p_org and jc.job_id = p_job and jc.lifecycle in ('PENDING','CLEARED');
  select coalesce(sum(r.gross_earned_cents), 0) into v_billed from pm.billing_requests r
   where r.org_id = p_org and r.job_id = p_job and r.status in ('EMITTED','ISSUED','UNISSUED') and r.billing_subtype is distinct from 'RETAINAGE_RELEASE';
  v_eac := greatest(coalesce(m.budget_revised_cents, m.cost_estimate_cents, 0)::bigint, v_cost);
  v_pct := case when v_eac > 0 then least(v_cost::numeric / v_eac, 1) else 0 end;
  v_earned := pm.fs_rdiv(coalesce(m.revised_contract_cents, 0) * v_pct, 1);
  v_margin := case when coalesce(m.revised_contract_cents, 0) > 0 then round((m.revised_contract_cents - v_eac)::numeric / m.revised_contract_cents, 5) end;
  select * into sn from pm.mfg_wip_snapshots s where s.org_id = p_org and s.job_id = p_job order by s.period_end desc limit 1;
  return jsonb_build_object('job_id', p_job, 'contract_cents', coalesce(m.revised_contract_cents, 0), 'eac_cents', v_eac, 'cost_to_date_cents', v_cost,
    'pct_complete', round(v_pct, 4), 'earned_cents', v_earned, 'billed_cents', v_billed, 'over_under_cents', v_billed - v_earned,
    'margin_pct', v_margin, 'prior_margin_pct', sn.margin_pct, 'fade_pct', case when sn.margin_pct is not null and v_margin is not null then round(sn.margin_pct - v_margin, 5) end,
    'loss_job', coalesce(m.revised_contract_cents, 0) > 0 and v_eac > m.revised_contract_cents, 'last_pinned', sn.period_end);
end $$;

create or replace function pm.mfg_wip(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(pm._mfg5_wip_row(v_org, j.id) || jsonb_build_object('job', j.job_number, 'job_name', j.name) order by j.job_number)
    from core.jobs j join pm.projects p on p.org_id = j.org_id and p.job_id = j.id
   where j.org_id = v_org and j.location_id = p_location and p.actual_finish is null
     and j.id in (select pm.my_money_job_ids('projects.financials'))
     and exists (select 1 from pm.work_orders w where w.org_id = j.org_id and w.job_id = j.id and w.kind = 'PRODUCTION')), '[]'::jsonb);
end $$;

create or replace function pm.mfg_pin_wip(p_location uuid, p_period_end date)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); r jsonb; n int := 0;
begin
  if p_period_end is null then raise exception 'PM_INVALID: pick the period end' using errcode = '22023'; end if;
  for r in select value from jsonb_array_elements(pm.mfg_wip(p_location)) loop
    insert into pm.mfg_wip_snapshots as s (org_id, job_id, period_end, contract_cents, eac_cents, cost_cents, billed_cents, margin_pct)
    values (v_org, (r ->> 'job_id')::uuid, p_period_end, (r ->> 'contract_cents')::bigint, (r ->> 'eac_cents')::bigint, (r ->> 'cost_to_date_cents')::bigint,
            (r ->> 'billed_cents')::bigint, (r ->> 'margin_pct')::numeric)
    on conflict (org_id, job_id, period_end) do update set contract_cents = excluded.contract_cents, eac_cents = excluded.eac_cents, cost_cents = excluded.cost_cents,
      billed_cents = excluded.billed_cents, margin_pct = excluded.margin_pct, pinned_by = pm.current_user_id(), pinned_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- The owner's one screen: weeks of backlog (largest work center), on-time delivery %, throughput per
-- week (delivered contract value, last 4 weeks), margin fade, deposits held, cost of quality, win rate,
-- quote → ship lead time.
create or replace function pm.mfg_owner_dashboard(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean := pm._x_sees('projects.financials', 'view', p_location);
        v_cv boolean := pm._x_sees('projects.contract_value', 'view', p_location); b jsonb; v_weeks numeric; v_ontime numeric; v_thru bigint; v_dep bigint; v_coq jsonb;
        v_win numeric; v_lead numeric; v_wip jsonb; v_fade numeric; v_loss int;
begin
  b := pm.mfg_backlog(p_location, 12);
  select max((c ->> 'weeks_of_backlog')::numeric) into v_weeks from jsonb_array_elements(b -> 'centers') c;
  select round(avg(case when s.delivered_at::date <= s.promised_on then 1 else 0 end), 3) into v_ontime
    from pm.mfg_shipments s join core.jobs j on j.id = s.job_id where s.org_id = v_org and j.location_id = p_location and s.status = 'DELIVERED' and s.promised_on is not null
     and s.delivered_at > now() - interval '90 days';
  select coalesce(sum(r.gross_earned_cents), 0) / 4 into v_thru from pm.billing_requests r join pm.mfg_shipments s on s.org_id = r.org_id and s.billing_request_id = r.id
    join core.jobs j on j.id = s.job_id where r.org_id = v_org and j.location_id = p_location and s.delivered_at > now() - interval '28 days';
  select coalesce(sum(d.amount_cents), 0) into v_dep from pm.deposit_requests d join core.jobs j on j.id = d.job_id
   where d.org_id = v_org and j.location_id = p_location and d.status in ('EMITTED','ISSUED')
     and not exists (select 1 from pm.billing_requests r where r.org_id = d.org_id and r.job_id = d.job_id and r.status in ('EMITTED','ISSUED') and r.memo like 'Delivered%');
  v_coq := pm.mfg_cost_of_quality(p_location, (current_date - 90), current_date);
  select round(count(*) filter (where o.stage = 'WON')::numeric / nullif(count(*) filter (where o.stage in ('WON','LOST')), 0), 3) into v_win
    from pm.mfg_opportunities o where o.org_id = v_org and o.location_id = p_location and o.decided_at > now() - interval '12 months';
  select round(avg(extract(epoch from (x.first_delivery - o.decided_at)) / 86400.0)::numeric, 1) into v_lead
    from pm.mfg_opportunities o cross join lateral (select min(s.delivered_at) as first_delivery from pm.mfg_shipments s where s.org_id = o.org_id and s.job_id = o.job_id and s.status = 'DELIVERED') x
   where o.org_id = v_org and o.location_id = p_location and o.stage = 'WON' and x.first_delivery is not null;
  -- nested-guard audit: mfg_wip (Financials view), mfg_eng_board / mfg_outside_board (Production view) skip their
  -- guards here; only their money-free figures are used, and the money ones are stripped by v_fin / v_cv below.
  v_wip := pm.mfg_wip(p_location);
  select round(avg((r ->> 'fade_pct')::numeric), 4), count(*) filter (where (r ->> 'loss_job')::boolean) into v_fade, v_loss from jsonb_array_elements(v_wip) r;
  return jsonb_build_object('weeks_of_backlog', v_weeks, 'on_time_pct', v_ontime, 'throughput_per_week_cents', case when v_cv then v_thru end,
    'margin_fade_pct', case when v_fin then v_fade end, 'loss_jobs', case when v_fin then v_loss end, 'deposits_held_cents', case when v_cv then v_dep end,
    'cost_of_quality_share', v_coq -> 'remake_share', 'cost_of_quality_material_cents', case when v_fin then (select sum((e ->> 'material_cents')::bigint) from jsonb_array_elements(v_coq -> 'by_reason') e) end,
    'win_rate', v_win, 'quote_to_ship_days', v_lead,
    'actions', (select coalesce(jsonb_agg(a), '[]'::jsonb) from (
       select jsonb_build_object('kind', 'late_outside', 'count', count(*)) a from jsonb_array_elements(pm.mfg_outside_board(p_location)) x where (x ->> 'late')::boolean having count(*) > 0
       union all select jsonb_build_object('kind', 'eng_at_risk', 'count', count(*)) from jsonb_array_elements(pm.mfg_eng_board(p_location, 4) -> 'tasks') x where (x ->> 'at_risk')::boolean having count(*) > 0
       union all select jsonb_build_object('kind', 'loss_jobs', 'count', v_loss) where v_fin and v_loss > 0) q),
    'amounts_visible', jsonb_build_object('financials', v_fin, 'contract_value', v_cv));
end $$;

-- MFG-55 portal hook: what a customer / GC / designer may see about the shop's progress on a job (shop
-- drawings out for their stamp, selections to approve, deliveries, installs). No money, no internal notes.
-- Service-only: the portal schema (1118) calls it after its own session + grant checks.
create or replace function pm.mfg_portal_job_feed(p_org uuid, p_job uuid)
returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select jsonb_build_object(
    'shop_drawings', coalesce((select jsonb_agg(jsonb_build_object('number', d.number, 'revision', d.revision, 'title', d.title, 'status', d.status, 'submitted_at', d.submitted_at,
        'returned_at', d.returned_at, 'envelope_id', d.envelope_id) order by d.number, d.revision desc)
      from pm.mfg_shop_drawings d where d.org_id = p_org and d.job_id = p_job and d.status not in ('DRAFTING','VOID')), '[]'::jsonb),
    'selections_open', (select count(*) from pm.selections s where s.org_id = p_org and s.job_id = p_job and s.client_visible and s.status in ('OPEN','PROPOSED')),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('number', s.number, 'status', s.status, 'ship_on', s.ship_on, 'delivered_at', s.delivered_at) order by s.ship_on nulls last)
      from pm.mfg_shipments s where s.org_id = p_org and s.job_id = p_job and s.status <> 'CANCELLED'), '[]'::jsonb),
    'installs', coalesce((select jsonb_agg(jsonb_build_object('starts_on', i.starts_on, 'ends_on', i.ends_on, 'status', i.status) order by i.starts_on)
      from pm.mfg_installs i where i.org_id = p_org and i.job_id = p_job and i.status <> 'CANCELLED'), '[]'::jsonb))
$$;

-- ----------------------------------------------------------------------------
-- M14. Boards the manufacturing screens read
-- ----------------------------------------------------------------------------
-- One job's areas with every gate: field measure, selections, shop drawings, engineering tasks.
create or replace function pm.mfg_area_board(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return jsonb_build_object('job_id', p_job,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('wbs_id', a.id, 'name', a.name, 'code', a.code, 'gates', pm._mfg5_area_gates(j.org_id, p_job, a.id),
        'measures', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'status', m.status, 'scheduled_on', m.scheduled_on, 'measured_at', m.measured_at, 'room', m.room,
            'walls', jsonb_array_length(m.dims), 'photos', cardinality(m.photo_document_ids), 'waive_reason', m.waive_reason) order by m.created_at)
          from pm.mfg_site_measures m where m.org_id = j.org_id and m.job_id = p_job and m.wbs_id = a.id), '[]'::jsonb),
        'selections', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'category', s.category, 'title', s.title, 'status', s.status, 'due_on', s.due_on,
            'change_order_id', (select g.change_order_id from pm.mfg_selection_flags g where g.selection_id = s.id)) order by s.sort, s.created_at)
          from pm.selections s where s.org_id = j.org_id and s.job_id = p_job and s.wbs_id = a.id and s.status <> 'VOID'), '[]'::jsonb),
        'orders', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'number', w.number, 'status', w.status, 'drawings_approved', w.drawings_approved_at is not null,
            'promised_on', w.promised_on) order by w.number) from pm.work_orders w where w.org_id = j.org_id and w.job_id = p_job and w.kind = 'PRODUCTION' and w.wbs_id = a.id), '[]'::jsonb))
        order by a.sort, a.name)
      from pm.wbs_nodes a where a.org_id = j.org_id and a.job_id = p_job and a.parent_id is null), '[]'::jsonb),
    'job_level_measures', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'status', m.status, 'scheduled_on', m.scheduled_on, 'room', m.room))
      from pm.mfg_site_measures m where m.org_id = j.org_id and m.job_id = p_job and m.wbs_id is null), '[]'::jsonb),
    'shop_drawings', pm.mfg_shop_drawing_log(p_job),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'wbs_id', t.wbs_id, 'kind', t.kind, 'title', t.title, 'status', t.status, 'blocked_reason', t.blocked_reason,
        'due_on', t.due_on, 'est_hours', t.est_hours, 'actual_hours', t.actual_hours, 'assignee', core.notify_member_name(t.assignee_membership)) order by t.due_on nulls last)
      from pm.mfg_eng_tasks t where t.org_id = j.org_id and t.job_id = p_job and t.status <> 'CANCELLED'), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'version', p.version, 'status', p.status, 'title', p.title, 'sent_at', p.sent_at, 'signed_at', p.signed_at,
        'signer_name', p.signer_name, 'estimate_id', p.estimate_id, 'file_id', p.file_id) order by p.version desc)
      from pm.mfg_proposals p where p.org_id = j.org_id and p.job_id = p_job), '[]'::jsonb));
end $$;

create or replace function pm.mfg_proposal_detail(p_proposal uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.mfg_proposals%rowtype; v_cv boolean;
begin
  select * into p from pm.mfg_proposals x where x.id = p_proposal;
  if p.org_id is null or p.org_id is distinct from public.get_org_id() then raise exception 'PM_FORBIDDEN: proposal not found' using errcode = '42501'; end if;
  v_cv := pm._x_sees('projects.contract_value', 'view', p.location_id, p.job_id);
  return (to_jsonb(p) - 'org_id') || jsonb_build_object(
    'alternates', case when v_cv then p.alternates else coalesce((select jsonb_agg(x - 'amount_cents') from jsonb_array_elements(p.alternates) x), '[]'::jsonb) end,
    'allowances', case when v_cv then p.allowances else coalesce((select jsonb_agg(x - 'amount_cents') from jsonb_array_elements(p.allowances) x), '[]'::jsonb) end,
    'estimate_total_cents', case when v_cv then (select e.total_cents from pm.estimates e where e.id = p.estimate_id) end, 'amounts_visible', v_cv);
end $$;

-- The latest proposal per estimate at a company (the proposals screen's picker).
create or replace function pm.mfg_proposal_list(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'estimate_id', x.estimate_id, 'job_id', x.job_id, 'version', x.version, 'status', x.status, 'title', x.title,
      'sent_at', x.sent_at, 'signed_at', x.signed_at) order by x.created_at desc)
    from (select distinct on (p.estimate_id) p.* from pm.mfg_proposals p where p.org_id = v_org and p.location_id = p_location
           order by p.estimate_id, p.version desc) x), '[]'::jsonb);
end $$;

create or replace function pm.mfg_ops_config(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  return jsonb_build_object('settings', to_jsonb(pm._mfg5_set(v_org, p_location)) - 'org_id',
    'cost_buckets', coalesce((select jsonb_agg(jsonb_build_object('cost_code_id', c.id, 'code', c.code, 'name', c.name, 'cost_type', c.cost_type, 'bucket', b.bucket) order by c.code)
      from pm.cost_codes c left join pm.mfg_cost_buckets b on b.org_id = c.org_id and b.location_id = p_location and b.cost_code_id = c.id
     where c.org_id = v_org and c.location_id = p_location and c.job_id is null and c.is_active), '[]'::jsonb),
    'family_routings', coalesce((select jsonb_agg(jsonb_build_object('family', f.family, 'routing_id', f.routing_id, 'routing', r.name) order by f.family)
      from pm.mfg_family_routings f join pm.routings r on r.id = f.routing_id where f.org_id = v_org and f.location_id = p_location), '[]'::jsonb),
    'routings', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name) order by r.code) from pm.routings r
      where r.org_id = v_org and r.location_id = p_location and r.is_active), '[]'::jsonb),
    'stock_locations', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'kind', s.kind) order by s.code) from pm.stock_locations s
      where s.org_id = v_org and s.location_id = p_location and s.is_active), '[]'::jsonb));
end $$;

-- ----------------------------------------------------------------------------
-- E. e-sign settlement for envelopes 1125 rows link (completion kind 'none'). Runs in the signer's anon
--    context, so it calls only unguarded helpers; it never fails the signature.
-- ----------------------------------------------------------------------------
create or replace function pm.tg_d5_envelope_settle() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_names text; r record;
begin
  if new.status is not distinct from old.status or new.status not in ('completed','declined') then return null; end if;
  begin
    select string_agg(coalesce(nullif(btrim(s.typed_name), ''), s.name), ', ' order by s.routing_order, s.position) into v_names
      from pm.esign_signers s where s.org_id = new.org_id and s.envelope_id = new.id;
    if new.status = 'completed' then
      update pm.dlr_ro_checkins set signed_at = coalesce(new.completed_at, now()), signer_name = coalesce(signer_name, v_names), signature_method = 'TEXT'
       where org_id = new.org_id and envelope_id = new.id and signed_at is null;
      update pm.dlr_rental_paperwork set signed_at = coalesce(new.completed_at, now()), signer_name = coalesce(signer_name, v_names)
       where org_id = new.org_id and envelope_id = new.id and signed_at is null;
      update pm.mfg_proposals set status = 'SIGNED', signed_at = coalesce(new.completed_at, now()), signer_name = v_names, updated_at = now()
       where org_id = new.org_id and envelope_id = new.id and status = 'SENT';
      for r in select e.id from pm.dlr_ro_estimates e where e.org_id = new.org_id and e.envelope_id = new.id and e.status = 'SENT' loop
        perform pm._d5_decide_findings(r.id, coalesce((select jsonb_agg(jsonb_build_object('finding_id', f.id, 'decision', 'APPROVED')) from pm.dlr_ro_findings f
                                                        where f.org_id = new.org_id and f.estimate_id = r.id and f.status = 'SENT'), '[]'::jsonb), coalesce(v_names, 'Customer'), 'TEXT_LINK');
      end loop;
      for r in select d.id from pm.mfg_shop_drawings d where d.org_id = new.org_id and d.envelope_id = new.id and d.status = 'SUBMITTED' loop
        perform pm._mfg5_stamp(r.id, 'APPROVED', coalesce(v_names, 'Reviewer'), 'Approved by e-signature', new.signed_document_id);
      end loop;
    else
      update pm.mfg_proposals set status = 'DECLINED', declined_reason = new.decline_reason, updated_at = now()
       where org_id = new.org_id and envelope_id = new.id and status = 'SENT';
      for r in select e.id from pm.dlr_ro_estimates e where e.org_id = new.org_id and e.envelope_id = new.id and e.status = 'SENT' loop
        perform pm._d5_decide_findings(r.id, coalesce((select jsonb_agg(jsonb_build_object('finding_id', f.id, 'decision', 'DECLINED')) from pm.dlr_ro_findings f
                                                        where f.org_id = new.org_id and f.estimate_id = r.id and f.status = 'SENT'), '[]'::jsonb), coalesce(v_names, 'Customer'), 'TEXT_LINK');
      end loop;
      for r in select d.id from pm.mfg_shop_drawings d where d.org_id = new.org_id and d.envelope_id = new.id and d.status = 'SUBMITTED' loop
        perform pm._mfg5_stamp(r.id, 'REVISE_RESUBMIT', coalesce(v_names, 'Reviewer'), coalesce(new.decline_reason, 'Returned without approval'), null);
      end loop;
    end if;
  exception when others then
    raise warning '1125 envelope settle failed for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists trg_d5_envelope_settle on pm.esign_envelopes;
create trigger trg_d5_envelope_settle after update of status on pm.esign_envelopes for each row execute function pm.tg_d5_envelope_settle();

-- ============================================================================
-- Z. 1110 registries: classes, masked columns, RPC guards; RLS; grants
-- ============================================================================
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('dlr_store_settings', 'S', 'location', '{}', 'projects.settings', null, null, null, null, false, '1125: store settings (keys validated by the RPC)'),
  ('dlr_customer_texts', 'C', 'location', '{projects.store,projects.customers}', null, null, null, null, null, false, '1125: customer texts queued from the store screens'),
  ('dlr_shipments', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: OEM shipments to receive'),
  ('dlr_shipment_lines', 'C', 'parent', '{}', null, 'dlr_shipments', 'shipment_id', null, null, false, '1125: shipment unit lines; cost masked'),
  ('dlr_lot_audits', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: lot counts / floor-plan audits'),
  ('dlr_lot_scans', 'C', 'parent', '{}', null, 'dlr_lot_audits', 'audit_id', null, null, false, '1125: lot scans'),
  ('dlr_recons', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: used / trade-in recon'),
  ('dlr_quote_payment_options', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: payment menu pinned on a quote'),
  ('dlr_incentives', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: OEM / dealer incentive library; amounts through RPCs'),
  ('dlr_deal_incentives', 'C', 'parent', '{}', null, 'dealer_deals', 'deal_id', null, null, false, '1125: incentives on a deal'),
  ('dlr_incentive_claims', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: program claims to receipt'),
  ('dlr_deal_stips', 'C', 'parent', '{}', null, 'dealer_deals', 'deal_id', null, null, false, '1125: lender stipulations'),
  ('dlr_deal_funding', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: lender funding status (contracts in transit)'),
  ('dlr_unwinds', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: unwind choices + deposit instruction'),
  ('dlr_order_transmissions', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: electronic parts order transmissions / acks'),
  ('dlr_backorders', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: parts backorders'),
  ('dlr_part_transfers', 'C', 'location', '{projects.store}', null, null, null, '%1$sfrom_location_id in (select pm.my_location_ids(''projects.store'', ''view''))', null, false, '1125: inter-store parts transfers (both stores read)'),
  ('dlr_service_capacity', 'S', 'location', '{}', 'projects.settings', null, null, null, null, false, '1125: service tech-hour capacity by weekday'),
  ('dlr_capacity_overrides', 'S', 'location', '{}', 'projects.settings', null, null, null, null, false, '1125: service capacity day overrides'),
  ('dlr_service_appointments', 'C', 'location', '{projects.store,projects.dispatch}', null, null, null, null, null, false, '1125: service appointments'),
  ('dlr_stops', 'C', 'location', '{projects.store,projects.dispatch}', null, null, null, null, null, false, '1125: pickup / delivery truck stops'),
  ('dlr_ro_state', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: RO stage, QC, pickup'),
  ('dlr_ro_checkins', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: RO check-in'),
  ('dlr_ro_estimates', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: added-work estimate batches; totals through RPCs'),
  ('dlr_ro_findings', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: tech findings; amounts through RPCs'),
  ('dlr_shop_fee_rules', 'S', 'location', '{}', 'projects.settings', null, null, null, null, false, '1125: shop supplies / environmental fee rules'),
  ('dlr_ro_fee_lines', 'J', 'parent', '{}', null, 'work_orders', 'work_order_id', null, null, false, '1125: fee rule → RO line'),
  ('dlr_ro_sublets', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: sublet work; cost through RPCs'),
  ('dlr_rental_rate_ext', 'C', 'parent', '{}', null, 'rental_rates', 'rate_id', null, null, false, '1125: hour / half-day / minimum / accessories'),
  ('dlr_rental_blocks', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: rental maintenance / down blocks'),
  ('dlr_rental_paperwork', 'C', 'parent', '{}', null, 'rental_contracts', 'contract_id', null, null, false, '1125: rental contract-out paperwork (license last 4, COI, hold)'),
  ('dlr_rerent_holds', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: re-rent inspection holds'),
  ('dlr_fleet_pm_rules', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: rental fleet PM rules'),
  ('dlr_fleet_pm_log', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: rental fleet PM log'),
  ('dlr_registers', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: cash registers'),
  ('dlr_drawer_sessions', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: drawer sessions; amounts through RPCs'),
  ('dlr_drawer_entries', 'C', 'parent', '{}', null, 'dlr_drawer_sessions', 'session_id', null, null, false, '1125: drawer payments'),
  ('dlr_deposit_batches', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: deposit-batch facts for Books'),
  ('dlr_price_limits', 'S', 'location', '{}', 'projects.settings', null, null, null, null, false, '1125: discount limits by role (read by the price guard)'),
  ('dlr_manager_pins', 'O', 'org', '{}', null, null, null, null, null, false, '1125: manager PIN hashes (no member grants)'),
  ('dlr_pin_attempts', 'O', 'org', '{}', null, null, null, null, null, false, '1125: wrong-PIN counters per caller + store (no member grants)'),
  ('dlr_price_overrides', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: price overrides; cost through RPCs'),
  ('dlr_close_runs', 'C', 'location', '{projects.store}', null, null, null, null, null, false, '1125: day / month store close sign-offs'),
  ('dlr_line_stories', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: 3C story (complaint / cause / correction) per RO line'),
  ('dlr_line_story_commands', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: phone story commands (idempotency log)'),
  ('mfg_ops_settings', 'S', 'location', '{}', 'projects.production', null, null, null, null, false, '1125: manufacturing completion settings'),
  ('mfg_opportunities', 'C', 'location', '{projects.estimates,projects.leads}', null, null, null, null, null, false, '1125: bid board; value through RPCs'),
  ('mfg_opportunity_bids', 'C', 'parent', '{}', null, 'mfg_opportunities', 'opportunity_id', null, null, false, '1125: bids per GC'),
  ('mfg_takeoff_scales', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: takeoff scale per sheet revision'),
  ('mfg_takeoffs', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: drawing takeoffs'),
  ('mfg_products', 'S', 'location', '{}', 'projects.production', null, null, null, null, false, '1125: parametric product library (cost in components: RPC only)'),
  ('mfg_proposals', 'C', 'location', '{projects.estimates}', null, null, null, null, null, false, '1125: proposals; amounts through RPCs'),
  ('mfg_site_measures', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: field measures'),
  ('mfg_shop_drawings', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: shop drawing submittal log'),
  ('mfg_eng_tasks', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: engineering queue'),
  ('mfg_selection_flags', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: cabinet selection upcharge rule + its change order'),
  ('mfg_co_areas', 'M', 'parent', '{}', null, 'change_orders', 'change_order_id', null, null, false, '1125: areas a change order touches'),
  ('mfg_family_routings', 'S', 'location', '{}', 'projects.production', null, null, null, null, false, '1125: routing template per product family'),
  ('mfg_sheet_specs', 'S', 'location', '{}', 'projects.production', null, null, null, null, false, '1125: sheet-goods specs'),
  ('mfg_allocations', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: material allocated to jobs'),
  ('mfg_counts', 'C', 'location', '{projects.production,projects.store}', null, null, null, null, null, false, '1125: material cycle counts'),
  ('mfg_count_lines', 'C', 'parent', '{}', null, 'mfg_counts', 'count_id', null, null, false, '1125: count lines'),
  ('mfg_material_issues', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: issues from nests'),
  ('mfg_outside_ops', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: outside processing'),
  ('mfg_shipments', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: shipping tickets + proof of delivery'),
  ('mfg_shipment_items', 'J', 'parent', '{}', null, 'mfg_shipments', 'shipment_id', null, null, false, '1125: packing list lines'),
  ('mfg_install_signoffs', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: install sign-offs'),
  ('mfg_punch_ext', 'J', 'parent', '{}', null, 'punch_items', 'punch_id', null, null, false, '1125: punch responsibility / back-charge; amounts through RPCs'),
  ('mfg_cost_buckets', 'S', 'location', '{}', 'projects.financials', null, null, null, null, false, '1125: cost code → job-cost bucket'),
  ('mfg_stored_materials', 'J', 'job', '{projects.jobs}', null, null, null, null, null, false, '1125: materials stored off site; value through RPCs'),
  ('mfg_wip_snapshots', 'M', 'job', '{projects.financials}', null, null, null, null, null, false, '1125: WIP pinned per period')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('dlr_set_store_settings', '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1125'),
  ('dlr_store_settings_get', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_create_shipment', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', '1125'),
  ('dlr_scan_shipment', '{p_shipment}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_shipments'', p_shipment);', '1125'),
  ('dlr_mark_shipment_line', '{p_line}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_shipment_lines'', p_line);', '1125'),
  ('dlr_receive_shipment', '{p_shipment}', 'perform pm.access_assert_row(''projects.store'', array[''create''], ''dlr_shipments'', p_shipment); perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_shipments'', p_shipment);', '1125'),
  ('dlr_shipment_detail', '{p_shipment}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dlr_shipments'', p_shipment);', '1125'),
  ('dlr_start_lot_audit', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', '1125'),
  ('dlr_lot_scan', '{p_audit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_lot_audits'', p_audit);', '1125'),
  ('dlr_lot_audit_report', '{p_audit}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dlr_lot_audits'', p_audit);', '1125'),
  ('dlr_close_lot_audit', '{p_audit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_lot_audits'', p_audit);', '1125'),
  ('dlr_open_recon', '{p_unit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit); if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''assets'', p_unit) or pm.access_can_row(''projects.production'', ''create'', ''assets'', p_unit)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.production:create''); end if;', '1125'),
  ('dlr_complete_recon', '{p_recon}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_recons'', p_recon);', '1125'),
  ('dlr_recon_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_payment_menu', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_attach_payment_menu', '{p_quote}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_quotes'', p_quote);', '1125'),
  ('dlr_eligible_incentives', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_apply_incentive', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_update_incentive_claim', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_incentive_claims'', p_claim);', '1125'),
  ('dlr_incentive_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_save_incentives', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.store'', ''approve'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.store:approve''); end if;', '1125'),
  ('dlr_set_stip', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_set_lender_status', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_cit_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_unwind_deal', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''approve''], ''dealer_deals'', p_deal);', '1125'),
  ('dlr_text_special_order', '{p_so}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_special_orders'', p_so);', '1125'),
  ('dlr_special_order_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_stock_suggestions', '{p_stock_location}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''stock_locations'', p_stock_location);', '1125'),
  ('dlr_apply_stocking', '{p_stock_location}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''stock_locations'', p_stock_location);', '1125'),
  ('dlr_create_stock_order', '{p_stock_location}', 'perform pm.access_assert_row(''projects.store'', array[''create''], ''stock_locations'', p_stock_location);', '1125'),
  ('dlr_record_order_transmission', '{p_order}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_orders'', p_order);', '1125'),
  ('dlr_record_order_ack', '{p_transmission}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_order_transmissions'', p_transmission);', '1125'),
  ('dlr_backorder_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_part_locator', '{p_part_number}', 'if not exists (select 1 from pm.my_location_ids(''projects.store'', ''view'')) then perform pm.access_forbid(''requires projects.store:view''); end if;', '1125'),
  ('dlr_request_transfer', '{p_to_stock_location}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''stock_locations'', p_to_stock_location);', '1125'),
  ('dlr_advance_transfer', '{p_transfer}', 'if not exists (select 1 from pm.dlr_part_transfers gt where gt.id = p_transfer and gt.org_id = public.get_org_id() and (pm.access_can_location(''projects.store'', ''edit'', gt.from_location_id) or pm.access_can_location(''projects.store'', ''edit'', gt.to_location_id))) then perform pm.access_forbid(''requires projects.store:edit at the sending or receiving store''); end if;', '1125'),
  ('dlr_transfer_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_set_internal_route', '{p_line}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_order_lines'', p_line);', '1125'),
  ('dlr_set_service_capacity', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.store'', ''approve'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.store:approve or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_service_calendar', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.store:view or projects.dispatch:view''); end if;', '1125'),
  ('dlr_book_service', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_update_appointment', '{p_appointment}', 'if not (pm.access_can_row(''projects.store'', ''edit'', ''dlr_service_appointments'', p_appointment) or pm.access_can_row(''projects.dispatch'', ''edit'', ''dlr_service_appointments'', p_appointment)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_add_stop', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_route_plan', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.store:view or projects.dispatch:view''); end if;', '1125'),
  ('dlr_set_route_order', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_finish_stop', '{p_stop}', 'if not (pm.access_can_row(''projects.store'', ''edit'', ''dlr_stops'', p_stop) or pm.access_can_row(''projects.dispatch'', ''edit'', ''dlr_stops'', p_stop)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_set_ro_stage', '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.store'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_text_ro_customer', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_ro_status_reply', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''work_orders'', p_wo);', '1125'),
  ('dlr_check_in', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location); if not (pm.access_can_location(''projects.dispatch'', ''edit'', p_location) or pm.access_can_location(''projects.production'', ''create'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.production:create''); end if;', '1125'),
  ('dlr_record_checkin_signature', '{p_checkin}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_ro_checkins'', p_checkin);', '1125'),
  ('dlr_add_finding', '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.store'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_send_estimate', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_link_estimate_envelope', '{p_estimate}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_ro_estimates'', p_estimate);', '1125'),
  ('dlr_decide_findings', '{p_estimate}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_ro_estimates'', p_estimate);', '1125'),
  ('dlr_add_sublet', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_update_sublet', '{p_sublet}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_ro_sublets'', p_sublet);', '1125'),
  ('dlr_apply_shop_fees', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_ro_close_check', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''work_orders'', p_wo);', '1125'),
  ('dlr_qc_signoff', '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.store'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_close_ro', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo); perform pm.access_assert_row(''projects.dispatch'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_ro_invoice', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''work_orders'', p_wo);', '1125'),
  ('dlr_text_pay_link', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_record_pickup', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_storage_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_add_storage_fee', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('dlr_wip_report', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_service_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_ro_desk', '{p_wo}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''work_orders'', p_wo);', '1125'),
  ('dlr_set_rate_ext', '{p_rate}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_rates'', p_rate);', '1125'),
  ('dlr_rental_quote', '{p_unit}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''assets'', p_unit);', '1125'),
  ('dlr_block_rental_unit', '{p_unit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', '1125'),
  ('dlr_release_block', '{p_block}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_rental_blocks'', p_block);', '1125'),
  ('dlr_rental_availability', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_rental_substitutes', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''rental_contracts'', p_contract);', '1125'),
  ('dlr_set_rental_paperwork', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', '1125'),
  ('dlr_rental_out_check', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''rental_contracts'', p_contract);', '1125'),
  ('dlr_check_out_rental', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', '1125'),
  ('dlr_clear_rerent', '{p_hold}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_rerent_holds'', p_hold);', '1125'),
  ('dlr_save_fleet_pm_rule', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', '1125'),
  ('dlr_fleet_due', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_schedule_fleet_pm', '{p_unit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit); if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''assets'', p_unit) or pm.access_can_row(''projects.production'', ''create'', ''assets'', p_unit)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.production:create''); end if;', '1125'),
  ('dlr_complete_fleet_pm', '{p_unit}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''assets'', p_unit);', '1125'),
  ('dlr_rental_damage_ro', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract); if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''rental_contracts'', p_contract) or pm.access_can_row(''projects.production'', ''create'', ''rental_contracts'', p_contract)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.production:create''); end if;', '1125'),
  ('dlr_run_cycle_billing', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', '1125'),
  ('dlr_customer_360', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_save_register', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''approve''], p_location);', '1125'),
  ('dlr_open_drawer', '{p_register}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_registers'', p_register);', '1125'),
  ('dlr_record_payment', '{p_session}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_drawer_sessions'', p_session);', '1125'),
  ('dlr_close_drawer', '{p_session}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_drawer_sessions'', p_session);', '1125'),
  ('dlr_drawer_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_set_price_limits', '{p_location}', 'perform pm.access_assert_location(''projects.settings'', array[''configure''], p_location);', '1125'),
  ('dlr_price_check', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_request_price_override', '{p_kind,p_line}', 'if upper(coalesce(p_kind, '''')) = ''PARTS_TICKET_LINE'' then perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_ticket_lines'', p_line); else perform pm.access_assert_row(''projects.store'', array[''edit''], ''work_order_lines'', p_line); end if;', '1125'),
  ('dlr_decide_price_override', '{p_override}', 'perform pm.access_assert_row(''projects.store'', array[''approve''], ''dlr_price_overrides'', p_override);', '1125'),
  ('dlr_set_manager_pin', '{p_pin}', 'if not exists (select 1 from pm.my_location_ids(''projects.store'', ''approve'')) then perform pm.access_forbid(''requires projects.store:approve''); end if;', '1125'),
  ('dlr_approve_override_pin', '{p_override}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_price_overrides'', p_override);', '1125'),
  ('dlr_price_override_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_store_close_checklist', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_sign_store_close', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''approve''], p_location);', '1125'),
  ('dlr_save_shop_fee_rule', '{p_location}', 'if not (pm.access_can_location(''projects.settings'', ''configure'', p_location) or pm.access_can_location(''projects.store'', ''approve'', p_location)) then perform pm.access_forbid(''requires projects.settings:configure or projects.store:approve''); end if;', '1125'),
  ('dlr_store_config', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_yard_board', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''view''], p_location);', '1125'),
  ('dlr_clock_indirect', '{p_location}', 'if not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1125'),
  ('dlr_clock_off', '{p_location}', 'if not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1125'),
  ('dlr_clock_on', '{p_line}', 'if not (exists (select 1 from pm.work_order_lines gl where gl.id = p_line and gl.org_id = public.get_org_id() and pm.access_my_work_order(gl.work_order_id)) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.time'', ''create'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires your own RO, projects.dispatch:edit or projects.time:create on the job''); end if;', '1125'),
  ('dlr_ack_late_time', '{p_ids}', 'perform pm.access_assert_row(''projects.time'', array[''approve''], ''time_entries'', x) from unnest(p_ids) as x;', '1125'),
  ('dlr_late_time', '{p_location}', 'if not (pm.access_can_location(''projects.time'', ''approve'', p_location) or pm.access_can_location(''projects.dispatch'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.time:approve or projects.dispatch:edit''); end if;', '1125'),
  ('dlr_set_line_story', '{p_line}', 'if not (exists (select 1 from pm.work_order_lines gl where gl.id = p_line and gl.org_id = public.get_org_id() and (pm.access_my_work_order(gl.work_order_id) or gl.performed_by_employee_id in (select pm.my_employee_ids()) or exists (select 1 from pm.dlr_tech_punches gp where gp.org_id = gl.org_id and gp.work_order_line_id = gl.id and gp.employee_id in (select pm.my_employee_ids())))) or pm.access_can_row(''projects.store'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires your own RO line, projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('mfg_set_ops_settings', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1125'),
  ('mfg_ops_settings_get', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.jobs'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production:view or projects.jobs:view''); end if;', '1125'),
  ('mfg_save_opportunity', '{p_location}', 'perform pm.access_assert_location(''projects.estimates'', array[''create''], p_location);', '1125'),
  ('mfg_move_opportunity', '{p_id}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''mfg_opportunities'', p_id);', '1125'),
  ('mfg_save_bid', '{p_opportunity}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''mfg_opportunities'', p_opportunity);', '1125'),
  ('mfg_award_bid', '{p_bid}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''mfg_opportunity_bids'', p_bid);', '1125'),
  ('mfg_bid_board', '{p_location}', 'perform pm.access_assert_location(''projects.estimates'', array[''view''], p_location);', '1125'),
  ('mfg_set_takeoff_scale', '{p_revision}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''drawing_revisions'', p_revision);', '1125'),
  ('mfg_save_takeoff', '{p_revision}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''drawing_revisions'', p_revision);', '1125'),
  ('mfg_delete_takeoff', '{p_id}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''mfg_takeoffs'', p_id);', '1125'),
  ('mfg_takeoff_sheet', '{p_revision}', 'if not (pm.access_can_row(''projects.documents'', ''view'', ''drawing_revisions'', p_revision) or pm.access_can_row(''projects.estimates'', ''view'', ''drawing_revisions'', p_revision)) then perform pm.access_forbid(''requires projects.documents:view or projects.estimates:view''); end if;', '1125'),
  ('mfg_takeoff_summary', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1125'),
  ('mfg_save_product', '{p_location}', 'if not (pm.access_can_location(''projects.estimates'', ''edit'', p_location) or pm.access_can_location(''projects.production'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.estimates:edit or projects.production:edit''); end if;', '1125'),
  ('mfg_expand_product', '{p_product}', 'if not (pm.access_can_row(''projects.estimates'', ''view'', ''mfg_products'', p_product) or pm.access_can_row(''projects.production'', ''view'', ''mfg_products'', p_product)) then perform pm.access_forbid(''requires projects.estimates:view or projects.production:view''); end if;', '1125'),
  ('mfg_add_product_line', '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', '1125'),
  ('mfg_product_library', '{p_location}', 'if not (pm.access_can_location(''projects.estimates'', ''view'', p_location) or pm.access_can_location(''projects.production'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.estimates:view or projects.production:view''); end if;', '1125'),
  ('mfg_save_proposal', '{p_estimate}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''estimates'', p_estimate);', '1125'),
  ('mfg_mark_proposal_sent', '{p_proposal}', 'perform pm.access_assert_row(''projects.estimates'', array[''edit''], ''mfg_proposals'', p_proposal);', '1125'),
  ('mfg_request_proposal_deposit', '{p_proposal}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''mfg_proposals'', p_proposal);', '1125'),
  ('mfg_schedule_measure', '{p_job}', 'if not (pm.access_can_job(''projects.production'', ''edit'', p_job) or pm.access_can_job(''projects.dispatch'', ''edit'', p_job) or pm.access_can_job(''projects.jobs'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.production:edit or projects.dispatch:edit or projects.jobs:edit''); end if;', '1125'),
  ('mfg_record_measure', '{p_measure}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_site_measures'', p_measure) or pm.access_can_row(''projects.jobs'', ''edit'', ''mfg_site_measures'', p_measure)) then perform pm.access_forbid(''requires projects.production:edit or projects.jobs:edit''); end if;', '1125'),
  ('mfg_waive_measure', '{p_measure}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_site_measures'', p_measure);', '1125'),
  ('mfg_seed_cabinet_selections', '{p_job}', 'perform pm.access_assert_job(''projects.selections'', array[''create''], p_job);', '1125'),
  ('mfg_create_shop_drawing', '{p_job}', 'if not (pm.access_can_job(''projects.production'', ''edit'', p_job) or pm.access_can_job(''projects.documents'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.production:edit or projects.documents:edit''); end if;', '1125'),
  ('mfg_submit_shop_drawing', '{p_id}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shop_drawings'', p_id) or pm.access_can_row(''projects.documents'', ''edit'', ''mfg_shop_drawings'', p_id)) then perform pm.access_forbid(''requires projects.production:edit or projects.documents:edit''); end if;', '1125'),
  ('mfg_record_stamp', '{p_id}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shop_drawings'', p_id) or pm.access_can_row(''projects.documents'', ''edit'', ''mfg_shop_drawings'', p_id)) then perform pm.access_forbid(''requires projects.production:edit or projects.documents:edit''); end if;', '1125'),
  ('mfg_release_shop_drawing', '{p_id}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_shop_drawings'', p_id);', '1125'),
  ('mfg_shop_drawing_log', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1125'),
  ('mfg_current_sheets', '{p_job}', 'if not (pm.access_can_job(''projects.documents'', ''view'', p_job) or pm.access_can_job(''projects.production'', ''view'', p_job)) then perform pm.access_forbid(''requires projects.documents:view or projects.production:view''); end if;', '1125'),
  ('mfg_sheet_status', '{p_revision}', 'if not (pm.access_can_row(''projects.documents'', ''view'', ''drawing_revisions'', p_revision) or pm.access_can_row(''projects.production'', ''view'', ''drawing_revisions'', p_revision)) then perform pm.access_forbid(''requires projects.documents:view or projects.production:view''); end if;', '1125'),
  ('mfg_save_eng_task', '{p_job}', 'perform pm.access_assert_job(''projects.production'', array[''edit''], p_job);', '1125'),
  ('mfg_move_eng_task', '{p_task}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_eng_tasks'', p_task);', '1125'),
  ('mfg_log_eng_hours', '{p_task}', 'if not (exists (select 1 from pm.mfg_eng_tasks gt where gt.id = p_task and gt.org_id = public.get_org_id() and gt.assignee_membership = core.client_scope_caller_membership()) or pm.access_can_row(''projects.production'', ''edit'', ''mfg_eng_tasks'', p_task)) then perform pm.access_forbid(''requires the assigned drafter or projects.production:edit''); end if;', '1125'),
  ('mfg_eng_board', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''view''], p_location);', '1125'),
  ('mfg_link_co_areas', '{p_co}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''change_orders'', p_co);', '1125'),
  ('mfg_co_impact', '{p_co}', 'perform pm.access_assert_row(''projects.change_orders'', array[''view''], ''change_orders'', p_co);', '1125'),
  ('mfg_cut_list', '{p_wo}', 'if not (pm.access_can_row(''projects.production'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.production:view or projects.jobs:view''); end if;', '1125'),
  ('mfg_set_part_edges', '{p_line}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''bom_lines'', p_line);', '1125'),
  ('mfg_set_family_routing', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1125'),
  ('mfg_apply_family_routing', '{p_wo}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('mfg_traveler', '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.production'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.production:view or projects.jobs:view''); end if;', '1125'),
  ('mfg_save_sheet_spec', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1125'),
  ('mfg_sheet_inventory', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.commitments'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production:view or projects.store:view or projects.commitments:view''); end if;', '1125'),
  ('mfg_allocate', '{p_job}', 'perform pm.access_assert_job(''projects.production'', array[''edit''], p_job);', '1125'),
  ('mfg_start_count', '{p_stock_location}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''stock_locations'', p_stock_location);', '1125'),
  ('mfg_record_count', '{p_count}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_counts'', p_count);', '1125'),
  ('mfg_post_count', '{p_count}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_counts'', p_count);', '1125'),
  ('mfg_issue_from_nest', '{p_wo}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', '1125'),
  ('mfg_send_outside', '{p_operation}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''wo_operations'', p_operation); perform pm.access_assert_row(''projects.commitments'', array[''create''], ''wo_operations'', p_operation);', '1125'),
  ('mfg_receive_outside', '{p_outside}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_outside_ops'', p_outside);', '1125'),
  ('mfg_outside_board', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''view''], p_location);', '1125'),
  ('mfg_create_shipment', '{p_job}', 'if not (pm.access_can_job(''projects.production'', ''edit'', p_job) or pm.access_can_job(''projects.dispatch'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.production:edit or projects.dispatch:edit''); end if;', '1125'),
  ('mfg_mark_items', '{p_shipment}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.dispatch'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.jobs'', ''edit'', ''mfg_shipments'', p_shipment)) then perform pm.access_forbid(''requires projects.production:edit or projects.dispatch:edit or projects.jobs:edit''); end if;', '1125'),
  ('mfg_check_load', '{p_shipment}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.dispatch'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.jobs'', ''edit'', ''mfg_shipments'', p_shipment)) then perform pm.access_forbid(''requires projects.production:edit or projects.dispatch:edit or projects.jobs:edit''); end if;', '1125'),
  ('mfg_deliver_shipment', '{p_shipment}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.dispatch'', ''edit'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.jobs'', ''edit'', ''mfg_shipments'', p_shipment)) then perform pm.access_forbid(''requires projects.production:edit or projects.dispatch:edit or projects.jobs:edit''); end if;', '1125'),
  ('mfg_shipment_board', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production:view or projects.dispatch:view''); end if;', '1125'),
  ('mfg_shipment_detail', '{p_shipment}', 'if not (pm.access_can_row(''projects.production'', ''view'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.dispatch'', ''view'', ''mfg_shipments'', p_shipment) or pm.access_can_row(''projects.jobs'', ''view'', ''mfg_shipments'', p_shipment)) then perform pm.access_forbid(''requires projects.production:view or projects.dispatch:view or projects.jobs:view''); end if;', '1125'),
  ('mfg_installer_home', '{p_location}', 'perform pm.access_assert_location(''projects.jobs'', array[''view''], p_location);', '1125'),
  ('mfg_log_install_time', '{p_install}', 'perform pm.access_assert_row(''projects.time'', array[''create''], ''mfg_installs'', p_install);', '1125'),
  ('mfg_add_punch', '{p_job}', 'if not (pm.access_can_job(''projects.jobs'', ''create'', p_job) or pm.access_can_job(''projects.jobs'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.jobs:create or projects.jobs:edit''); end if;', '1125'),
  ('mfg_backcharge', '{p_punch,p_to}', 'if upper(coalesce(p_to, '''')) = ''GC'' then perform pm.access_assert_row(''projects.billing'', array[''create''], ''punch_items'', p_punch); else perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''punch_items'', p_punch); end if;', '1125'),
  ('mfg_open_warranty', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job); if not (pm.access_can_job(''projects.production'', ''create'', p_job) or pm.access_can_job(''projects.dispatch'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.production:create or projects.dispatch:edit''); end if;', '1125'),
  ('mfg_install_signoff', '{p_install}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''mfg_installs'', p_install);', '1125'),
  ('mfg_punch_board', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1125'),
  ('mfg_set_cost_buckets', '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location);', '1125'),
  ('mfg_job_cost', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1125'),
  ('mfg_add_stored_material', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1125'),
  ('mfg_bill_stored_materials', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1125'),
  ('mfg_bill_shipment', '{p_shipment}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''mfg_shipments'', p_shipment);', '1125'),
  ('mfg_billing_board', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''view''], p_job);', '1125'),
  ('mfg_wip', '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''view''], p_location);', '1125'),
  ('mfg_pin_wip', '{p_location}', 'perform pm.access_assert_location(''projects.financials'', array[''edit''], p_location);', '1125'),
  ('mfg_owner_dashboard', '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.financials'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports:view or projects.financials:view''); end if;', '1125'),
  ('mfg_area_board', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1125'),
  ('mfg_check_reviewer', '{p_id}', 'if not (pm.access_can_row(''projects.production'', ''edit'', ''mfg_shop_drawings'', p_id) or pm.access_can_row(''projects.documents'', ''edit'', ''mfg_shop_drawings'', p_id)) then perform pm.access_forbid(''requires projects.production:edit or projects.documents:edit''); end if;', '1125'),
  ('dlr_note_drawer_variance', '{p_session}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_drawer_sessions'', p_session);', '1125'),
  ('add_work_order_line', '{p_wo}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.store'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires projects.jobs:edit or projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('update_work_order_line', '{p_line}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.store'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires projects.jobs:edit or projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('remove_work_order_line', '{p_line}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.store'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires projects.jobs:edit or projects.store:edit or projects.dispatch:edit''); end if;', '1125'),
  ('field_time_insert', '{p_job}', 'if not (pm.access_can_job(''projects.time'', ''create'', p_job) or pm.access_can_job(''projects.time'', ''approve'', p_job)) then perform pm.access_forbid(''requires projects.time:create or projects.time:approve''); end if;', '1125'),
  ('field_time_update', '{p_id}', 'if not (pm.access_can_row(''projects.time'', ''edit'', ''time_entries'', p_id) or pm.access_can_row(''projects.time'', ''approve'', ''time_entries'', p_id)) then perform pm.access_forbid(''requires projects.time:edit or projects.time:approve''); end if;', '1125'),
  ('mfg_proposal_detail', '{p_proposal}', 'perform pm.access_assert_row(''projects.estimates'', array[''view''], ''mfg_proposals'', p_proposal);', '1125'),
  ('mfg_proposal_list', '{p_location}', 'perform pm.access_assert_location(''projects.estimates'', array[''view''], p_location);', '1125'),
  ('mfg_ops_config', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.financials'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production:view or projects.financials:view''); end if;', '1125')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('mfg_current_only_job_ids', '1125: the caller''s own job set for the current-drawing-set policy (RLS helper)'),
  ('_d5_late_since', '1125: minutes since the end of a day in the company''s time zone (read-only; the member-invoked time-entry gate trigger calls it)')
on conflict (function_name) do update set reason = excluded.reason;

-- Masked columns (security review L3): the RO check-in's authorization limit and deposit are money.
insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('dlr_ro_checkins', 'auth_limit_cents', 't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null::text, '1125 L3: customer authorization limit'),
  ('dlr_ro_checkins', 'deposit_cents',    't.location_id in (select pm.my_location_ids(''projects.contract_value'', ''view''))', null::text, '1125 L3: RO deposit')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

-- RLS: permissive org isolation on every new table (the class policies narrow it)
do $$
declare t text;
begin
  foreach t in array array['dlr_store_settings', 'dlr_customer_texts', 'dlr_shipments', 'dlr_shipment_lines', 'dlr_lot_audits', 'dlr_lot_scans', 'dlr_recons', 'dlr_quote_payment_options', 'dlr_incentives', 'dlr_deal_incentives', 'dlr_incentive_claims', 'dlr_deal_stips', 'dlr_deal_funding', 'dlr_unwinds', 'dlr_order_transmissions', 'dlr_backorders', 'dlr_part_transfers', 'dlr_service_capacity', 'dlr_capacity_overrides', 'dlr_service_appointments', 'dlr_stops', 'dlr_ro_state', 'dlr_ro_checkins', 'dlr_ro_estimates', 'dlr_ro_findings', 'dlr_shop_fee_rules', 'dlr_ro_fee_lines', 'dlr_ro_sublets', 'dlr_rental_rate_ext', 'dlr_rental_blocks', 'dlr_rental_paperwork', 'dlr_rerent_holds', 'dlr_fleet_pm_rules', 'dlr_fleet_pm_log', 'dlr_registers', 'dlr_drawer_sessions', 'dlr_drawer_entries', 'dlr_deposit_batches', 'dlr_price_limits', 'dlr_manager_pins', 'dlr_pin_attempts', 'dlr_price_overrides', 'dlr_close_runs', 'dlr_line_stories', 'dlr_line_story_commands', 'mfg_ops_settings', 'mfg_opportunities', 'mfg_opportunity_bids', 'mfg_takeoff_scales', 'mfg_takeoffs', 'mfg_products', 'mfg_proposals', 'mfg_site_measures', 'mfg_shop_drawings', 'mfg_eng_tasks', 'mfg_selection_flags', 'mfg_co_areas', 'mfg_family_routings', 'mfg_sheet_specs', 'mfg_allocations', 'mfg_counts', 'mfg_count_lines', 'mfg_material_issues', 'mfg_outside_ops', 'mfg_shipments', 'mfg_shipment_items', 'mfg_install_signoffs', 'mfg_punch_ext', 'mfg_cost_buckets', 'mfg_stored_materials', 'mfg_wip_snapshots'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
  end loop;
end $$;

-- members read workflow rows without money directly; everything with money, PII or hashes goes through the RPCs
grant select on pm.dlr_store_settings, pm.dlr_customer_texts, pm.dlr_shipments, pm.dlr_lot_audits, pm.dlr_lot_scans, pm.dlr_recons, pm.dlr_deal_stips, pm.dlr_order_transmissions, pm.dlr_backorders, pm.dlr_part_transfers, pm.dlr_service_capacity, pm.dlr_capacity_overrides, pm.dlr_service_appointments, pm.dlr_stops, pm.dlr_ro_state, pm.dlr_ro_checkins, pm.dlr_rental_blocks, pm.dlr_rerent_holds, pm.dlr_fleet_pm_rules, pm.dlr_fleet_pm_log, pm.dlr_registers, pm.dlr_price_limits, pm.dlr_close_runs, pm.dlr_line_stories, pm.mfg_ops_settings, pm.mfg_takeoff_scales, pm.mfg_takeoffs, pm.mfg_site_measures, pm.mfg_shop_drawings, pm.mfg_eng_tasks, pm.mfg_selection_flags, pm.mfg_family_routings, pm.mfg_sheet_specs, pm.mfg_allocations, pm.mfg_counts, pm.mfg_count_lines, pm.mfg_material_issues, pm.mfg_outside_ops, pm.mfg_shipments, pm.mfg_shipment_items, pm.mfg_install_signoffs, pm.mfg_cost_buckets
  to authenticated;

select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon; members get the guarded RPC surface (+ the allowlisted policy helper).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              '_d5_defaults', '_d5_set', 'dlr_set_store_settings', 'dlr_store_settings_get', '_d5_meters', '_d5_contact',
              '_d5_text', '_d5_notify', '_d5_unit_label', '_d5_company_name', '_d5_claim_doc', '_d5_claim_docs',
              '_d5_assert_envelope', '_d5_claim_rental_doc', '_d5_assert_rental_envelope', '_d5_number', 'dlr_create_shipment', 'dlr_scan_shipment',
              'dlr_mark_shipment_line', 'dlr_receive_shipment', 'dlr_shipment_detail', 'dlr_start_lot_audit', 'dlr_lot_scan', 'dlr_lot_audit_report',
              'dlr_close_lot_audit', '_d5_open_recon', 'dlr_open_recon', 'dlr_complete_recon', 'dlr_recon_board', 'tg_d5_trade_recon',
              'tg_d5_recon_lock_deal_line', 'tg_d5_recon_lock_listing', 'dlr_payment_menu', 'dlr_attach_payment_menu', 'dlr_eligible_incentives', 'dlr_apply_incentive',
              'tg_d5_deal_claims', 'dlr_update_incentive_claim', 'dlr_incentive_board', 'dlr_save_incentives', 'dlr_set_stip', 'dlr_set_lender_status',
              'dlr_cit_board', 'dlr_unwind_deal', 'tg_d5_special_order_text', 'dlr_text_special_order', 'dlr_special_order_board', '_d5_stocking',
              'dlr_stock_suggestions', 'dlr_apply_stocking', 'dlr_create_stock_order', 'dlr_record_order_transmission', 'dlr_record_order_ack', 'dlr_backorder_board',
              'dlr_part_locator', 'dlr_request_transfer', 'dlr_advance_transfer', 'dlr_transfer_board', 'tg_d5_wo_line_route', 'dlr_set_internal_route',
              'dlr_set_service_capacity', '_d5_day_capacity', '_d5_backlog_hours', '_d5_ready_date', 'dlr_service_calendar', 'dlr_book_service',
              'dlr_update_appointment', 'dlr_add_stop', 'dlr_route_plan', 'dlr_set_route_order', 'dlr_finish_stop', '_d5_stage_text',
              '_d5_set_stage', 'dlr_set_ro_stage', 'dlr_text_ro_customer', 'dlr_ro_status_reply', 'dlr_check_in', 'dlr_record_checkin_signature',
              'dlr_add_finding', 'dlr_send_estimate', 'dlr_link_estimate_envelope', '_d5_decide_findings', 'dlr_decide_findings', 'dlr_add_sublet',
              'dlr_update_sublet', 'dlr_apply_shop_fees', 'dlr_ro_close_check', 'dlr_qc_signoff', 'dlr_close_ro', 'dlr_ro_invoice',
              'dlr_text_pay_link', 'dlr_record_pickup', 'dlr_storage_board', 'dlr_add_storage_fee', 'dlr_wip_report', 'dlr_service_board',
              'dlr_ro_desk', 'dlr_set_rate_ext', '_d5_rental_quote', 'dlr_rental_quote', 'tg_d5_rental_block_guard', 'dlr_block_rental_unit',
              'dlr_release_block', 'dlr_rental_availability', 'dlr_rental_substitutes', 'dlr_set_rental_paperwork', 'dlr_rental_out_check', 'dlr_check_out_rental',
              'tg_d5_rental_out_gate', 'tg_d5_rental_returned', 'dlr_clear_rerent', 'dlr_save_fleet_pm_rule', 'dlr_fleet_due', 'dlr_schedule_fleet_pm',
              'dlr_complete_fleet_pm', 'dlr_rental_damage_ro', 'dlr_run_cycle_billing', '_d5_cycle_due', 'dlr_customer_360', 'dlr_save_register',
              'dlr_open_drawer', '_d5_source_due', 'dlr_record_payment', 'tg_d5_ticket_drawer', '_d5_drawer_expected', 'dlr_close_drawer',
              'dlr_note_drawer_variance', 'dlr_drawer_board', '_d5_role_keys', '_d5_limit', 'dlr_set_price_limits', '_d5_price_allowed',
              'dlr_price_check', '_d5_assert_price', '_d5_posted_labor_rate', '_d5_override_line', '_d5_apply_override', 'dlr_request_price_override',
              '_d5_decide_override', 'dlr_decide_price_override', '_d5_crypt', '_d5_bf_salt', 'dlr_set_manager_pin', 'dlr_approve_override_pin',
              'dlr_price_override_board', '_d5_line_base', 'tg_d5_price_guard', 'tg_d5_issued_line_lock', 'remove_work_order_line', 'add_work_order_line',
              'update_work_order_line', 'dlr_store_close_checklist', 'dlr_sign_store_close', 'dlr_save_shop_fee_rule', 'dlr_store_config', 'dlr_yard_board',
              '_d5_tap_time', '_d5_late_minutes', '_d5_week_open', '_d5_punch_fits', '_d5_close_punch_at', 'dlr_clock_on',
              'dlr_clock_off', 'dlr_clock_indirect', '_d5_late_since', 'tg_d5_late_time_gate', 'field_time_insert', 'field_time_update',
              'dlr_ack_late_time', 'dlr_late_time', 'dlr_set_line_story', '_mfg5_set', 'mfg_set_ops_settings', 'mfg_ops_settings_get',
              'mfg_save_opportunity', 'mfg_move_opportunity', 'mfg_save_bid', 'mfg_award_bid', 'mfg_bid_board', '_mfg5_len',
              '_mfg5_area', '_mfg5_to_base', 'mfg_set_takeoff_scale', '_mfg5_takeoff_uom', '_mfg5_takeoff_qty', 'mfg_save_takeoff',
              'mfg_delete_takeoff', 'mfg_takeoff_sheet', 'mfg_takeoff_summary', '_mfg5_eval', 'mfg_save_product', '_mfg5_expand',
              'mfg_expand_product', 'mfg_add_product_line', 'mfg_product_library', 'mfg_save_proposal', 'mfg_mark_proposal_sent', 'mfg_request_proposal_deposit',
              'mfg_schedule_measure', 'mfg_record_measure', 'mfg_waive_measure', '_mfg5_area_gates', 'mfg_seed_cabinet_selections', 'tg_mfg5_selection_upcharge',
              'mfg_create_shop_drawing', '_mfg5_member_email', 'mfg_check_reviewer', 'mfg_submit_shop_drawing', '_mfg5_stamp', 'mfg_record_stamp',
              'mfg_release_shop_drawing', 'tg_mfg5_drawings_gate', 'mfg_shop_drawing_log', 'mfg_current_only_job_ids', 'mfg_current_sheets', 'mfg_sheet_status',
              'mfg_save_eng_task', 'mfg_move_eng_task', 'mfg_log_eng_hours', 'mfg_eng_board', 'mfg_link_co_areas', 'tg_mfg5_co_reengineer',
              'mfg_co_impact', '_mfg5_edges', 'mfg_cut_list', 'mfg_set_part_edges', 'mfg_set_family_routing', 'mfg_apply_family_routing',
              'mfg_traveler', '_mfg5_item_for', 'mfg_save_sheet_spec', 'mfg_sheet_inventory', 'mfg_allocate', 'mfg_start_count',
              'mfg_record_count', 'mfg_post_count', 'mfg_issue_from_nest', 'mfg_send_outside', 'mfg_receive_outside', 'mfg_outside_board',
              'mfg_create_shipment', 'mfg_mark_items', 'mfg_check_load', 'mfg_deliver_shipment', 'mfg_shipment_board', 'mfg_shipment_detail',
              'mfg_installer_home', 'mfg_log_install_time', 'mfg_add_punch', 'mfg_backcharge', 'mfg_open_warranty', 'mfg_install_signoff',
              'mfg_punch_board', 'mfg_set_cost_buckets', '_mfg5_bucket', 'mfg_job_cost', 'mfg_add_stored_material', 'mfg_bill_stored_materials',
              'mfg_bill_shipment', 'mfg_billing_board', '_mfg5_wip_row', 'mfg_wip', 'mfg_pin_wip', 'mfg_owner_dashboard',
              'mfg_portal_job_feed', 'mfg_area_board', 'mfg_proposal_detail', 'mfg_proposal_list', 'mfg_ops_config', 'tg_d5_envelope_settle') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in (
              'dlr_set_store_settings', 'dlr_store_settings_get', 'dlr_create_shipment', 'dlr_scan_shipment', 'dlr_mark_shipment_line', 'dlr_receive_shipment',
              'dlr_shipment_detail', 'dlr_start_lot_audit', 'dlr_lot_scan', 'dlr_lot_audit_report', 'dlr_close_lot_audit', 'dlr_open_recon',
              'dlr_complete_recon', 'dlr_recon_board', 'dlr_payment_menu', 'dlr_attach_payment_menu', 'dlr_eligible_incentives', 'dlr_apply_incentive',
              'dlr_update_incentive_claim', 'dlr_incentive_board', 'dlr_save_incentives', 'dlr_set_stip', 'dlr_set_lender_status', 'dlr_cit_board',
              'dlr_unwind_deal', 'dlr_text_special_order', 'dlr_special_order_board', 'dlr_stock_suggestions', 'dlr_apply_stocking', 'dlr_create_stock_order',
              'dlr_record_order_transmission', 'dlr_record_order_ack', 'dlr_backorder_board', 'dlr_part_locator', 'dlr_request_transfer', 'dlr_advance_transfer',
              'dlr_transfer_board', 'dlr_set_internal_route', 'dlr_set_service_capacity', 'dlr_service_calendar', 'dlr_book_service', 'dlr_update_appointment',
              'dlr_add_stop', 'dlr_route_plan', 'dlr_set_route_order', 'dlr_finish_stop', 'dlr_set_ro_stage', 'dlr_text_ro_customer',
              'dlr_ro_status_reply', 'dlr_check_in', 'dlr_record_checkin_signature', 'dlr_add_finding', 'dlr_send_estimate', 'dlr_link_estimate_envelope',
              'dlr_decide_findings', 'dlr_add_sublet', 'dlr_update_sublet', 'dlr_apply_shop_fees', 'dlr_ro_close_check', 'dlr_qc_signoff',
              'dlr_close_ro', 'dlr_ro_invoice', 'dlr_text_pay_link', 'dlr_record_pickup', 'dlr_storage_board', 'dlr_add_storage_fee',
              'dlr_wip_report', 'dlr_service_board', 'dlr_ro_desk', 'dlr_set_rate_ext', 'dlr_rental_quote', 'dlr_block_rental_unit',
              'dlr_release_block', 'dlr_rental_availability', 'dlr_rental_substitutes', 'dlr_set_rental_paperwork', 'dlr_rental_out_check', 'dlr_check_out_rental',
              'dlr_clear_rerent', 'dlr_save_fleet_pm_rule', 'dlr_fleet_due', 'dlr_schedule_fleet_pm', 'dlr_complete_fleet_pm', 'dlr_rental_damage_ro',
              'dlr_run_cycle_billing', 'dlr_customer_360', 'dlr_save_register', 'dlr_open_drawer', 'dlr_record_payment', 'dlr_close_drawer',
              'dlr_drawer_board', 'dlr_set_price_limits', 'dlr_price_check', 'dlr_request_price_override', 'dlr_decide_price_override', 'dlr_set_manager_pin',
              'dlr_approve_override_pin', 'dlr_price_override_board', 'dlr_store_close_checklist', 'dlr_sign_store_close', 'dlr_save_shop_fee_rule', 'dlr_store_config',
              'dlr_yard_board', 'dlr_clock_indirect', 'dlr_clock_off', 'dlr_clock_on', 'dlr_ack_late_time', 'dlr_late_time',
              'dlr_set_line_story', 'mfg_set_ops_settings', 'mfg_ops_settings_get', 'mfg_save_opportunity', 'mfg_move_opportunity', 'mfg_save_bid',
              'mfg_award_bid', 'mfg_bid_board', 'mfg_set_takeoff_scale', 'mfg_save_takeoff', 'mfg_delete_takeoff', 'mfg_takeoff_sheet',
              'mfg_takeoff_summary', 'mfg_save_product', 'mfg_expand_product', 'mfg_add_product_line', 'mfg_product_library', 'mfg_save_proposal',
              'mfg_mark_proposal_sent', 'mfg_request_proposal_deposit', 'mfg_schedule_measure', 'mfg_record_measure', 'mfg_waive_measure', 'mfg_seed_cabinet_selections',
              'mfg_create_shop_drawing', 'mfg_submit_shop_drawing', 'mfg_record_stamp', 'mfg_release_shop_drawing', 'mfg_shop_drawing_log', 'mfg_current_sheets',
              'mfg_sheet_status', 'mfg_save_eng_task', 'mfg_move_eng_task', 'mfg_log_eng_hours', 'mfg_eng_board', 'mfg_link_co_areas',
              'mfg_co_impact', 'mfg_cut_list', 'mfg_set_part_edges', 'mfg_set_family_routing', 'mfg_apply_family_routing', 'mfg_traveler',
              'mfg_save_sheet_spec', 'mfg_sheet_inventory', 'mfg_allocate', 'mfg_start_count', 'mfg_record_count', 'mfg_post_count',
              'mfg_issue_from_nest', 'mfg_send_outside', 'mfg_receive_outside', 'mfg_outside_board', 'mfg_create_shipment', 'mfg_mark_items',
              'mfg_check_load', 'mfg_deliver_shipment', 'mfg_shipment_board', 'mfg_shipment_detail', 'mfg_installer_home', 'mfg_log_install_time',
              'mfg_add_punch', 'mfg_backcharge', 'mfg_open_warranty', 'mfg_install_signoff', 'mfg_punch_board', 'mfg_set_cost_buckets',
              'mfg_job_cost', 'mfg_add_stored_material', 'mfg_bill_stored_materials', 'mfg_bill_shipment', 'mfg_billing_board', 'mfg_wip',
              'mfg_pin_wip', 'mfg_owner_dashboard', 'mfg_area_board', 'mfg_check_reviewer', 'dlr_note_drawer_variance', 'add_work_order_line',
              'update_work_order_line', 'remove_work_order_line', 'field_time_insert', 'field_time_update', 'mfg_proposal_detail', 'mfg_proposal_list',
              'mfg_ops_config', 'mfg_current_only_job_ids', '_d5_late_since') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1125_pm_dealer_mfg_completion
-- ============================================================================
