-- ============================================================================
-- 1122 · Merit Projects — industry depth: equipment dealer, manufacturing (ETO cabinetry /
--        millwork), flooring, interior design and real-estate development (Wave B, agent B5)
--
-- Spec: expert-panel seats 04 (MFG / FLR / ID) and 05 (DLR / RED), Launch rows, prioritized by each
-- seat's make-or-break list; docs/projects/WAVE-B-BRIEF.md (binding rules). Builds on 1104 (work
-- orders, assets, stock), 1105 (production), 1106 (measures, selections, procurement), 1107 (draws),
-- 1109 (dealer store), 1110 (access), 1113 (approvals engine), 1115 (documents / e-sign) and
-- 1117 (pricing helpers). Nothing in 1100–1117 is modified: additive columns, new tables, new
-- definer RPCs, and three additive triggers (draw in-balance block, lender-consent gate on a dev
-- budget revision, design billing lock on time entries) that act only on rows this migration links.
--
-- MONEY RULES (1110): bigint cents everywhere, fractions for percents, integer half-up rounding
-- (pm.fs_rdiv, 1117). Cost columns are masked through pm.access_masked_columns (financials /
-- labor_rates); every definer RPC that returns money strips it unless the caller holds the
-- capability at that company / job. NO GL: Books owns AR, AP, payroll, inventory value, floor plan,
-- warranty receivable, deposits liability, equity. Projects keeps quantities, states and documents.
--
-- WHAT THIS ADDS (prefix per industry; one shared primitive)
--   V  vendor inbox agent hook (shared: ID-21, FLR-23, MFG-38)
--        vendor_inbox_messages, vendor_inbox_proposals; vi_ingest (rules-only parse result from the
--        app, matched to PO numbers / sidemarks / tracking), vi_decide, vi_dismiss. Price and
--        lead-time changes always wait for a person.
--   D  equipment dealer (DLR)
--        counter: dlr_lost_sales + dlr_log_lost_sale (DLR-37), pm.v_dlr_counter_speed (open → close
--          seconds, % under 60 s — make-or-break 1), dlr_add_pick_list (PartSmart / PartStream pick
--          list → ticket lines through supersession, DLR-29), dlr_scan (one scan → unit / part / RO /
--          ticket / deal / rental, DLR-02 + make-or-break 4)
--        price files: dlr_price_rules (matrix), dlr_price_files + _lines, dlr_stage_price_file (diff:
--          new / changed / superseded / margin under floor), dlr_apply_price_file (DLR-28)
--        catalog + OEM integrations: dlr_integrations (PARTSMART / PARTSTREAM deep links, OEM warranty
--          channels; config is non-secret, credentials never stored here)
--        warranty: warranty_claims gains the OEM claim-builder fields (DLR-58); dlr_claim_parts;
--          pm.dlr_oem_profile(brand) (channel, filing / response / retention days, required fields);
--          dlr_claim_readiness, dlr_update_claim, dlr_prepare_claim_submission (packet + portal-assist
--          copy fields; direct submission adapters are stubs per OEM until an API contract exists),
--          dlr_record_claim_submitted, dlr_record_claim_response, dlr_resolve_rejected_claim
--          (resubmit / rebill / write off), dlr_claim_submissions log, credit memos
--          (dlr_credit_memos + _lines, dlr_import_credit_memo auto-propose, dlr_confirm_credit_match),
--          pm.v_dlr_claim_deadlines (DLR-59/60/61)
--        unit timeline: dlr_unit_timeline (receipt, costs, deal, PDI, ROs, claims, rentals, trade,
--          transfers — DLR-02)
--        deal desk: dlr_finance_programs (OEM promo rates with subvention, cash rebates — DLR-13/14),
--          dlr_fee_schedule (doc / setup / freight fees — DLR-12), dlr_payment_scenarios (amortized,
--          pm.fs_monthly_payment), dlr_apply_program, dlr_apply_standard_fees, dlr_deal_worksheet
--          (front / back gross, over-allowance, subvention, F&I, commission base, floor + approval state
--          from the 1113 engine; gross stripped without financials — DLR-15/16/18/19)
--        sold-out-of-trust: pm.v_dlr_sold_unpaid (GM home) and dlr_delivery_blockers (the 1109
--          payoff guard, explained before the click — DLR-06/23)
--        rentals: dlr_rental_settings, dlr_rental_inspections (out / in, zones, fuel, meter, photos),
--          dlr_record_rental_inspection, dlr_rental_damage_compare, dlr_apply_rental_charges (DLR-65/66)
--        tech clock: dlr_tech_punches (one open punch per tech), dlr_clock_on / dlr_clock_off /
--          dlr_clock_indirect, dlr_flag_line, dlr_tech_board (flagged vs clocked, efficiency,
--          productivity — DLR-47/56). A line punch closes into a SUBMITTED pm.time_entries row on the
--          RO (existing approval + JOB_TIME path).
--        KPIs: dlr_kpis (counter speed, fill rate, lost sales, parts GM, WIP aging, tech efficiency,
--          warranty outstanding / rejection, unit aging, sold-unpaid, rental $ utilization — DLR-75)
--   M  manufacturing (MFG)
--        CAD/CAM: mfg_cad_imports + mfg_cad_lines, mfg_stage_cad_import (diff vs the estimate: sheets,
--          edgeband, hardware, hours), mfg_apply_cad_import (→ pm.bom_lines) (MFG-19/20)
--        work centers: work_centers gains efficiency / hours / shifts / costing rate; mfg_center_downtime;
--          routing_steps gains run basis (PART / SHEET / LF / BOX / UNIT), machine and outside flags;
--          mfg_restandard_operations (MFG-24/25)
--        release gates: mfg_settings, mfg_release_check, mfg_release (deposit paid per Books invoice,
--          material on hand or on order, CAD applied, plus the 1105 gates — MFG-26)
--        backlog: mfg_backlog (booked / unreleased / quoted-weighted shop-hours per center per week vs
--          capacity, weeks of backlog — MFG-27)
--        kiosk: mfg_badges (sha-256 badge + PIN), mfg_kiosk_sessions, mfg_kiosk_punches,
--          mfg_set_badge, mfg_kiosk_identify, mfg_kiosk_events (offline queue replay, idempotent per
--          client event id, two jobs at once split the time) — MFG-30/31; no money anywhere on it
--        remakes: mfg_remakes, mfg_request_remake, mfg_decide_remake, mfg_cost_of_quality (MFG-34)
--        MRP-lite: mfg_material_settings, mfg_material_demand, mfg_create_po_from_demand,
--          mfg_receive_po_line (MFG-36/37/39/40)
--        installs: mfg_installs, mfg_schedule_install, mfg_install_board (MFG-45)
--   F  flooring (FLR)
--        flr_products, flr_labor_rates, pm.flr_material_qty (UoM engine: SY / SF / carton / roll LF /
--          LF / step + waste — mirrored by lib/flooring/uom.ts), flr_import_measure (MeasureSquare /
--          RFMS → pm.measures), flr_job_settings (tax mode per job), flr_quote_lines +
--          flr_build_quote (→ pm.estimate_lines; margin floor through the 1113 estimate approval),
--          flr_rolls / flr_cut_tickets / flr_cuts (roll + dye lot, remaining length, remnants, lot-mix
--          warning, roll suggestion), flr_site_checks + flr_job_readiness (gate), flr_capacity +
--          flr_install_bookings + flr_book_install / flr_install_board (SF capacity), installer pay:
--          flr_pay_tickets / _lines / flr_chargebacks (piece rate, splits, partial qty, job minimum,
--          chargebacks netted; 1099 → payable request held for Books AP, W-2 → PIECE time entry)
--   I  interior design (dsn_)
--        dsn_items (rooms, placeholders, client price, visibility), procurement_items gains the design
--          item link, component kind and the four deposit / balance dates (8-date hub with
--          pm.v_dsn_procurement_hub), dsn_proposals + items (per-item approve / reject / comment),
--          dsn_item_deposits + dsn_deposit_moves (per-item deposits through pm.deposit_requests,
--          reallocation memo), dsn_create_pos (grouped by vendor, sidemark), dsn_receive_component,
--          dsn_fee_agreements + dsn_fee_ledger + dsn_billed_time (fee invoicing: hourly, flat by
--          phase, % of budget, procurement fee, retainer; billed time locks)
--   R  real-estate development (dev_)
--        dev_projects (SPE = project = Books entity; stage), dev_spe_requests (the documented request
--          to Books — Books exposes no entity-provisioning action to Projects), dev_key_dates,
--          dev_pro_formas + dev_compute_pro_forma (yield on cost, LTC, DSCR, equity multiple, IRR —
--          deterministic), dev_sources (capital stack, funding rule), dev_budget_lines (lender line +
--          CIP account + contingency pool per cost code), dev_budget_grid (original / revised /
--          committed / pending CO / ECAC / paid / drawn / remaining to fund / variance),
--          dev_reallocations + dev_propose_reallocation (a REVISED budget routed through the 1113
--          budget_transfer approval) + lender consent, dev_contingency, dev_in_balance (+ draw
--          submission block), dev_draw_invoices + dev_build_draw, dev_lender_templates +
--          dev_draw_package (lender read order), dev_draw_precheck, dev_draw_waivers +
--          dev_request_draw_waivers (pm.compliance_docs → payment hold), dev_capital_plan,
--          dev_overview (all SPEs), dev_investor_view (core.equity_holders — Books only)
--
-- ACCESS: every new table classified (pm.access_table_classes), money columns masked, every
--   member-executable definer RPC guarded (pm.access_rpc_guards); helpers / triggers are
--   service-only; nothing executable by anon; projects_only_seat_deny is not needed (no new public /
--   core tables).
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * No new core.events types: Books rejects unknown Projects event types. Installer 1099 payables,
--     W-2 piece pay keys, design deposit reallocations, warranty rebills and credit-memo matches are
--     held in pm rows (payload ready) for the Books consumers listed in the hand-off.
--   * Approvals: the 1113 object list is closed. Deal gross keeps dealer_deal, flooring quotes the
--     estimate floor, dev reallocations ride budget_transfer (a REVISED budget). Pay-ticket approval
--     and remake approval are role checks with preparer ≠ approver in the RPC.
--   * Kiosk: the device is a signed-in seat holding projects.production:edit at the company; the
--     worker identifies by badge + PIN (sha-256 only); a session token (sha-256) lets the device
--     queue events offline for up to 14 hours.
--   * The OEM direct-submission adapters are interfaces with stubs (no OEM API contract exists yet);
--     every claim gets a portal-assist packet, deadlines and the submission log today.
--
-- APPLY RULE: after 1100–1117. Idempotent (safe twice); PGlite-safe.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1122 requires 1110_pm_access';
  end if;
  if to_regprocedure('pm.fs_rdiv(numeric,numeric)') is null then
    raise exception '1122 requires 1117_pm_field_service_depth (pm.fs_rdiv / pm.fs_monthly_payment)';
  end if;
  if to_regprocedure('pm.approval_decide(text,uuid,text,text,text,text,text)') is null then
    raise exception '1122 requires 1113_pm_approvals';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Shared helpers (service-only unless noted)
-- ----------------------------------------------------------------------------
-- The caller's company in the org or PM_FORBIDDEN (returns the org).
create or replace function pm._x_org_of_location(p_location uuid) returns uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid;
begin
  select l.org_id into v_org from core.locations l where l.id = p_location;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: company % is not in the caller''s organization', p_location using errcode = '42501';
  end if;
  return v_org;
end $$;

-- (org, company) of a job in the caller's org or PM_FORBIDDEN.
create or replace function pm._x_job(p_job uuid, out org_id uuid, out location_id uuid)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  select j.org_id, j.location_id into org_id, location_id from core.jobs j where j.id = p_job;
  if org_id is null or org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
end $$;

-- Books invoice state for a Projects-issued invoice (deposit / billing): read through a definer
-- (Projects-only seats cannot read Books tables). available = false when Books has no invoices table.
create or replace function pm._x_invoice_state(p_org uuid, p_invoice uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_status text; v_total bigint; v_paid bigint;
begin
  if p_invoice is null then return jsonb_build_object('available', true, 'found', false); end if;
  if to_regclass('public.invoices') is null then return jsonb_build_object('available', false, 'found', false); end if;
  execute 'select i.status, i.total_cents, i.amount_paid_cents from public.invoices i where i.org_id = $1 and i.id = $2'
    into v_status, v_total, v_paid using p_org, p_invoice;
  if v_status is null then return jsonb_build_object('available', true, 'found', false); end if;
  return jsonb_build_object('available', true, 'found', true, 'status', v_status, 'total_cents', v_total, 'paid_cents', v_paid,
                            'paid', v_status = 'PAID' or (v_total > 0 and v_paid >= v_total));
end $$;

-- Deposit position of a job from pm.deposit_requests + Books invoice payment state.
--   none_requested: no live deposit request; all_paid: every issued deposit invoice is paid.
create or replace function pm._x_job_deposits(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r record; v_req bigint := 0; v_paid bigint := 0; v_n int := 0; v_unpaid int := 0; v_avail boolean := true; s jsonb;
begin
  for r in select d.* from pm.deposit_requests d
            where d.org_id = p_org and d.job_id = p_job and d.status not in ('VOID','REJECTED') loop
    v_n := v_n + 1;
    v_req := v_req + r.amount_cents;
    s := pm._x_invoice_state(p_org, r.invoice_id);
    if not coalesce((s ->> 'available')::boolean, false) then v_avail := false; end if;
    if coalesce((s ->> 'paid')::boolean, false) then v_paid := v_paid + r.amount_cents;
    else v_unpaid := v_unpaid + 1; end if;
  end loop;
  return jsonb_build_object('requests', v_n, 'requested_cents', v_req, 'paid_cents', v_paid,
                            'none_requested', v_n = 0, 'all_paid', v_n > 0 and v_unpaid = 0, 'books_available', v_avail);
end $$;

-- sha-256 hex of a text (badge codes, PINs, session tokens). Immutable, no secret.
create or replace function pm._x_sha256(p text) returns text
language sql immutable
set search_path = pm, public
as $$ select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;

-- Lenient casts for parsed / imported text (null on anything that does not parse).
create or replace function pm._x_try_date(p text) returns date
language plpgsql immutable
as $$ begin if p is null or btrim(p) = '' then return null; end if; return p::date; exception when others then return null; end $$;

create or replace function pm._x_try_bigint(p text) returns bigint
language plpgsql immutable
as $$ begin if p is null or btrim(p) = '' then return null; end if; return round(p::numeric)::bigint; exception when others then return null; end $$;

create or replace function pm._x_try_ts(p text) returns timestamptz
language plpgsql stable
as $$ begin if p is null or btrim(p) = '' then return null; end if; return p::timestamptz; exception when others then return null; end $$;

create or replace function pm._x_try_num(p text) returns numeric
language plpgsql immutable
as $$ begin if p is null or btrim(p) = '' then return null; end if; return p::numeric; exception when others then return null; end $$;

create or replace function pm._x_try_bool(p text) returns boolean
language sql immutable
as $$ select case when lower(btrim(coalesce(p, ''))) in ('true','t','1','yes','y','on') then true
                  when lower(btrim(coalesce(p, ''))) in ('false','f','0','no','n','off') then false end $$;

-- Money visibility of the caller (definer-safe): service and owners see everything.
create or replace function pm._x_sees(p_cap text, p_action text, p_location uuid, p_job uuid default null) returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or (p_job is not null and pm.access_can_job(p_cap, p_action, p_job))
      or (p_job is null and pm.access_can_location(p_cap, p_action, p_location))
$$;

-- ----------------------------------------------------------------------------
-- V. Vendor inbox agent hook (shared primitive — ID-21, FLR-23, MFG-38)
--   The app parses a forwarded vendor email with deterministic rules (lib/design/inbox.ts: PO
--   numbers, sidemarks, kind, ship / delivery dates, tracking numbers, totals) and sends the parse
--   here. Matching and proposals are server-side; dates / tracking / status apply on a click, price
--   and lead-time changes always need a person (needs_approval).
-- ----------------------------------------------------------------------------
create table if not exists pm.vendor_inbox_messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  received_at         timestamptz not null default now(),
  from_address        text check (from_address is null or char_length(from_address) <= 320),
  subject             text check (subject is null or char_length(subject) <= 500),
  body_text           text check (body_text is null or char_length(body_text) <= 100000),
  attachment_document_ids uuid[] not null default '{}',
  kind                text not null default 'OTHER' check (kind in ('ACKNOWLEDGMENT','SHIP_NOTICE','INVOICE','PRO_FORMA','BACKORDER','OTHER')),
  parsed              jsonb not null default '{}' check (jsonb_typeof(parsed) = 'object'),
  vendor_id           uuid references core.vendors(id),
  match_status        text not null default 'UNMATCHED' check (match_status in ('UNMATCHED','MATCHED','PARTIAL')),
  status              text not null default 'NEW' check (status in ('NEW','PROPOSED','APPLIED','DISMISSED')),
  decided_by          text,
  decided_at          timestamptz,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists pm_vim_loc_idx on pm.vendor_inbox_messages (org_id, location_id, status, received_at desc);

create table if not exists pm.vendor_inbox_proposals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  message_id      uuid not null,
  target_table    text not null check (target_table in ('procurement_items','parts_special_orders')),
  target_id       uuid not null,
  job_id          uuid,
  field           text not null check (field in ('status','acknowledged_on','expected_on','shipped_on','tracking_ref','unit_cost_cents','lead_time','note')),
  old_value       text,
  new_value       text,
  confidence      numeric(4,3) not null default 1 check (confidence >= 0 and confidence <= 1),
  needs_approval  boolean not null default false,
  status          text not null default 'PROPOSED' check (status in ('PROPOSED','APPLIED','REJECTED')),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, message_id) references pm.vendor_inbox_messages (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_vip_msg_idx on pm.vendor_inbox_proposals (org_id, message_id);

-- Ingest one parsed email. p_parsed (from the app's rules parser):
--   { kind, po_numbers: [..], sidemarks: [..], dates: {ship_on, delivery_on, acknowledged_on},
--     tracking: [..], total_cents, line_prices: [{sku, unit_cents}], lead_time_days }
create or replace function pm.vi_ingest(p_location uuid, p_from text, p_subject text, p_body text, p_parsed jsonb default '{}',
                                        p_attachments uuid[] default '{}')
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid; v_p jsonb := coalesce(p_parsed, '{}'); v_kind text;
        r record; v_n int := 0; v_targets int := 0; v_ship date; v_deliv date; v_ack date; v_track text; v_status text; v_vendor uuid;
        v_po text[]; v_side text[];
begin
  if jsonb_typeof(v_p) <> 'object' then raise exception 'PM_INVALID: parsed must be an object' using errcode = '22023'; end if;
  v_kind := coalesce(nullif(v_p ->> 'kind', ''), 'OTHER');
  if v_kind not in ('ACKNOWLEDGMENT','SHIP_NOTICE','INVOICE','PRO_FORMA','BACKORDER','OTHER') then v_kind := 'OTHER'; end if;
  v_po := array(select upper(btrim(x)) from jsonb_array_elements_text(coalesce(v_p -> 'po_numbers', '[]')) x where btrim(x) <> '' limit 50);
  v_side := array(select upper(btrim(x)) from jsonb_array_elements_text(coalesce(v_p -> 'sidemarks', '[]')) x where btrim(x) <> '' limit 50);
  v_ship  := pm._x_try_date(v_p #>> '{dates,ship_on}');
  v_deliv := pm._x_try_date(v_p #>> '{dates,delivery_on}');
  v_ack   := pm._x_try_date(v_p #>> '{dates,acknowledged_on}');
  v_track := nullif(left(btrim(coalesce(v_p #>> '{tracking,0}', '')), 80), '');
  v_status := case v_kind when 'ACKNOWLEDGMENT' then 'ACKNOWLEDGED' when 'SHIP_NOTICE' then 'SHIPPED'
                          when 'BACKORDER' then 'BACK_ORDERED' when 'PRO_FORMA' then 'ACKNOWLEDGED' end;

  insert into pm.vendor_inbox_messages (org_id, location_id, from_address, subject, body_text, attachment_document_ids, kind, parsed)
  values (v_org, p_location, left(p_from, 320), left(p_subject, 500), left(p_body, 100000), coalesce(p_attachments, '{}'), v_kind, v_p)
  returning id into v_id;

  -- candidate lines: procurement items on this company's jobs matched by PO number or sidemark
  for r in
    select pi.*, (upper(coalesce(pi.po_number, c.number, '')) = any (v_po)) as by_po
      from pm.procurement_items pi
      join core.jobs j on j.org_id = pi.org_id and j.id = pi.job_id and j.location_id = p_location
      left join pm.commitments c on c.org_id = pi.org_id and c.id = pi.commitment_id
     where pi.org_id = v_org and pi.status not in ('CANCELLED','RETURNED','INSTALLED','DELIVERED')
       and ((cardinality(v_po) > 0 and upper(coalesce(pi.po_number, c.number, '')) = any (v_po))
         or (cardinality(v_side) > 0 and upper(coalesce(pi.sidemark, '')) = any (v_side)))
     limit 200
  loop
    v_targets := v_targets + 1;
    v_vendor := coalesce(v_vendor, r.vendor_id);
    if v_status is not null and r.status is distinct from v_status
       and not (r.status in ('RECEIVED','DAMAGED','STORED') ) then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence)
      values (v_org, v_id, 'procurement_items', r.id, r.job_id, 'status', r.status, v_status, case when r.by_po then 0.95 else 0.75 end);
      v_n := v_n + 1;
    end if;
    if v_ack is not null and r.acknowledged_on is distinct from v_ack then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence)
      values (v_org, v_id, 'procurement_items', r.id, r.job_id, 'acknowledged_on', r.acknowledged_on::text, v_ack::text, 0.9);
      v_n := v_n + 1;
    end if;
    if coalesce(v_deliv, v_ship) is not null and r.expected_on is distinct from coalesce(v_deliv, v_ship) then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence, needs_approval)
      values (v_org, v_id, 'procurement_items', r.id, r.job_id, 'expected_on', r.expected_on::text, coalesce(v_deliv, v_ship)::text, 0.85,
              -- a later ETA than the install date is a lead-time change: a person decides
              r.install_on is not null and coalesce(v_deliv, v_ship) > r.install_on);
      v_n := v_n + 1;
    end if;
    if v_ship is not null and v_kind = 'SHIP_NOTICE' and r.shipped_on is distinct from v_ship then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence)
      values (v_org, v_id, 'procurement_items', r.id, r.job_id, 'shipped_on', r.shipped_on::text, v_ship::text, 0.9);
      v_n := v_n + 1;
    end if;
    if v_track is not null and r.tracking_ref is distinct from v_track then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence)
      values (v_org, v_id, 'procurement_items', r.id, r.job_id, 'tracking_ref', r.tracking_ref, v_track, 0.9);
      v_n := v_n + 1;
    end if;
    -- a quoted unit price that differs from the line's cost always needs a person
    if r.vendor_sku is not null and exists (select 1 from jsonb_array_elements(coalesce(v_p -> 'line_prices', '[]')) lp
                                             where upper(lp ->> 'sku') = upper(r.vendor_sku)
                                               and pm._x_try_bigint(lp ->> 'unit_cents') is distinct from r.unit_cost_cents) then
      insert into pm.vendor_inbox_proposals (org_id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence, needs_approval)
      select v_org, v_id, 'procurement_items', r.id, r.job_id, 'unit_cost_cents', r.unit_cost_cents::text, (lp ->> 'unit_cents'), 0.8, true
        from jsonb_array_elements(coalesce(v_p -> 'line_prices', '[]')) lp where upper(lp ->> 'sku') = upper(r.vendor_sku) limit 1;
      v_n := v_n + 1;
    end if;
  end loop;

  update pm.vendor_inbox_messages
     set status = case when v_n > 0 then 'PROPOSED' else 'NEW' end,
         match_status = case when v_targets = 0 then 'UNMATCHED' when cardinality(v_po) + cardinality(v_side) > v_targets then 'PARTIAL' else 'MATCHED' end,
         vendor_id = v_vendor
   where id = v_id;
  return jsonb_build_object('message_id', v_id, 'matched_lines', v_targets, 'proposals', v_n, 'kind', v_kind);
end $$;

-- Apply or reject one proposal. Applying a needs_approval proposal needs projects.commitments:approve
-- or projects.selections:approve on the job (a price / lead-time change is a decision).
create or replace function pm.vi_decide(p_proposal uuid, p_decision text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.vendor_inbox_proposals%rowtype; v_org uuid := public.get_org_id(); v_left int;
begin
  select * into p from pm.vendor_inbox_proposals x where x.id = p_proposal for update;
  if p.org_id is null or p.org_id is distinct from v_org then
    raise exception 'PM_FORBIDDEN: proposal % not found in the caller''s organization', p_proposal using errcode = '42501';
  end if;
  if p.status <> 'PROPOSED' then raise exception 'PM_INBOX_DECIDED: this proposal is already %', lower(p.status) using errcode = '22023'; end if;
  if p_decision not in ('apply','reject') then raise exception 'PM_INVALID: decide apply or reject' using errcode = '22023'; end if;
  if p_decision = 'apply' then
    if p.needs_approval and not (pm.access_can_job('projects.commitments', 'approve', p.job_id) or pm.access_can_job('projects.selections', 'approve', p.job_id)) then
      raise exception 'PM_FORBIDDEN: a price or lead-time change needs projects.commitments:approve or projects.selections:approve' using errcode = '42501';
    end if;
    if p.target_table = 'procurement_items' then
      if p.field = 'status' then
        -- the 1106 state machine decides (an out-of-order notice raises PM_ITEM_TRANSITION_INVALID)
        perform pm.advance_procurement_item(p.target_id, p.new_value, current_date, '{}'::jsonb);
      elsif p.field = 'acknowledged_on' then update pm.procurement_items set acknowledged_on = p.new_value::date where org_id = v_org and id = p.target_id;
      elsif p.field = 'expected_on' then update pm.procurement_items set expected_on = p.new_value::date where org_id = v_org and id = p.target_id;
      elsif p.field = 'shipped_on' then update pm.procurement_items set shipped_on = p.new_value::date where org_id = v_org and id = p.target_id;
      elsif p.field = 'tracking_ref' then update pm.procurement_items set tracking_ref = p.new_value where org_id = v_org and id = p.target_id;
      elsif p.field = 'unit_cost_cents' then update pm.procurement_items set unit_cost_cents = p.new_value::bigint where org_id = v_org and id = p.target_id;
      end if;
    end if;
  end if;
  update pm.vendor_inbox_proposals set status = case when p_decision = 'apply' then 'APPLIED' else 'REJECTED' end,
         decided_by = pm.current_user_id(), decided_at = now() where id = p.id;
  select count(*) into v_left from pm.vendor_inbox_proposals x where x.org_id = v_org and x.message_id = p.message_id and x.status = 'PROPOSED';
  if v_left = 0 then
    update pm.vendor_inbox_messages set status = 'APPLIED', decided_by = pm.current_user_id(), decided_at = now()
     where org_id = v_org and id = p.message_id and status in ('NEW','PROPOSED');
  end if;
  return jsonb_build_object('proposal_id', p.id, 'status', case when p_decision = 'apply' then 'APPLIED' else 'REJECTED' end, 'open_on_message', v_left);
end $$;

create or replace function pm.vi_dismiss(p_message uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare m pm.vendor_inbox_messages%rowtype;
begin
  select * into m from pm.vendor_inbox_messages x where x.id = p_message for update;
  if m.org_id is null or m.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: message % not found in the caller''s organization', p_message using errcode = '42501';
  end if;
  update pm.vendor_inbox_proposals set status = 'REJECTED', decided_by = pm.current_user_id(), decided_at = now()
   where org_id = m.org_id and message_id = m.id and status = 'PROPOSED';
  update pm.vendor_inbox_messages set status = 'DISMISSED', decided_by = pm.current_user_id(), decided_at = now() where id = m.id;
  return m.id;
end $$;

-- ============================================================================
-- D. Equipment dealer
-- ============================================================================

-- D1. Counter: lost sales, speed, pick lists, one-scan resolver ----------------
create table if not exists pm.dlr_lost_sales (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  part_id        uuid,
  part_number    text not null check (char_length(btrim(part_number)) between 1 and 40),
  manufacturer   text,
  description    text,
  qty            numeric(12,4) not null default 1 check (qty > 0),
  customer_type  text not null default 'RETAIL' check (customer_type in ('RETAIL','COMMERCIAL','INTERNAL','WARRANTY')),
  reason         text not null default 'OUT_OF_STOCK' check (reason in ('NOT_STOCKED','OUT_OF_STOCK','PRICE','SUPERSEDED_UNKNOWN','OTHER')),
  ticket_id      uuid,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate,
  foreign key (org_id, ticket_id) references pm.parts_tickets (org_id, id) on delete set null deferrable initially immediate
);
create index if not exists pm_dlr_lost_sales_idx on pm.dlr_lost_sales (org_id, location_id, created_at desc);

create or replace function pm.dlr_log_lost_sale(p_location uuid, p_part_number text, p_qty numeric default 1, p_customer_type text default 'RETAIL',
                                                p_reason text default 'OUT_OF_STOCK', p_ticket uuid default null, p_description text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_pn text := upper(btrim(coalesce(p_part_number, ''))); v_part uuid; v_mfr text; v_id uuid;
begin
  if v_pn = '' then raise exception 'PM_INVALID: part number is required' using errcode = '22023'; end if;
  if p_ticket is not null and not exists (select 1 from pm.parts_tickets t where t.org_id = v_org and t.id = p_ticket and t.location_id = p_location) then
    raise exception 'PM_INVALID: that ticket is not on this company' using errcode = '22023';
  end if;
  select p.id, p.manufacturer into v_part, v_mfr from pm.parts p
   where p.org_id = v_org and p.location_id = p_location and upper(btrim(p.part_number)) = v_pn order by p.status = 'ACTIVE' desc limit 1;
  insert into pm.dlr_lost_sales (org_id, location_id, part_id, part_number, manufacturer, description, qty, customer_type, reason, ticket_id)
  values (v_org, p_location, v_part, v_pn, v_mfr, nullif(left(btrim(coalesce(p_description, '')), 200), ''), coalesce(p_qty, 1),
          coalesce(p_customer_type, 'RETAIL'), coalesce(p_reason, 'OUT_OF_STOCK'), p_ticket)
  returning id into v_id;
  return v_id;
end $$;

-- Counter speed per company per day: ticket open → close seconds (make-or-break: under 60 s).
create or replace view pm.v_dlr_counter_speed with (security_invoker = on) as
select t.org_id, t.location_id, (t.closed_at)::date as day,
       count(*)::int as tickets,
       round(percentile_cont(0.5) within group (order by extract(epoch from (t.closed_at - t.created_at)))::numeric, 1) as median_seconds,
       round(avg(extract(epoch from (t.closed_at - t.created_at)))::numeric, 1) as avg_seconds,
       round((count(*) filter (where t.closed_at - t.created_at <= interval '60 seconds'))::numeric / count(*), 4) as pct_under_60s
from pm.parts_tickets t
where t.status = 'CLOSED' and t.closed_at is not null and not t.is_sample
group by t.org_id, t.location_id, (t.closed_at)::date;

-- A catalog pick list (PartSmart export / PartStream cart) onto an open counter ticket. Each number
-- follows its supersession chain; fill comes from on-hand at the ticket's stock location (the store's
-- negative-stock rule applies); unknown numbers come back for the counter to add or special-order.
create or replace function pm.dlr_add_pick_list(p_ticket uuid, p_lines jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.parts_tickets%rowtype; s pm.dealer_settings%rowtype; e jsonb; v_pn text; v_mfr text; v_qty numeric; v_part uuid; v_res uuid;
        p pm.parts%rowtype; v_oh numeric; v_taken numeric; v_fill numeric; v_line int; v_sort int; v_added jsonb := '[]'; v_unknown jsonb := '[]';
begin
  select * into t from pm.parts_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status <> 'OPEN' then raise exception 'PM_TICKET_LOCKED: ticket % is %', t.number, t.status using errcode = '55000'; end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'PM_INVALID: a pick list needs at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'PM_INVALID: at most 200 pick-list lines' using errcode = '22023'; end if;
  s := pm.dealer_settings_row(t.org_id, t.location_id);
  select coalesce(max(l.line_no), 0), coalesce(max(l.sort), -1) into v_line, v_sort from pm.parts_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_pn := upper(btrim(coalesce(e ->> 'part_number', '')));
    v_mfr := nullif(upper(btrim(coalesce(e ->> 'manufacturer', ''))), '');
    v_qty := coalesce(pm._x_try_num(e ->> 'qty'), 1);
    continue when v_pn = '' or v_qty <= 0;
    select x.id into v_part from pm.parts x
     where x.org_id = t.org_id and x.location_id = t.location_id and upper(btrim(x.part_number)) = v_pn
       and (v_mfr is null or upper(coalesce(x.manufacturer, '')) = v_mfr)
     order by (upper(coalesce(x.manufacturer, '')) = coalesce(v_mfr, '')) desc, x.status = 'ACTIVE' desc limit 1;
    if v_part is null then
      v_unknown := v_unknown || jsonb_build_object('part_number', v_pn, 'manufacturer', v_mfr, 'qty', v_qty, 'description', e ->> 'description');
      continue;
    end if;
    v_res := pm.resolve_part(v_part);
    select * into p from pm.parts x where x.id = v_res;
    v_oh := pm.part_on_hand(t.org_id, t.stock_location_id, p.item_id);
    select coalesce(sum(l.qty_filled), 0) into v_taken from pm.parts_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id and l.part_id = p.id;
    v_fill := case when s.allow_negative_parts then v_qty else greatest(least(v_qty, coalesce(v_oh, 0) - v_taken), 0) end;
    v_line := v_line + 1; v_sort := v_sort + 1;
    insert into pm.parts_ticket_lines (org_id, ticket_id, line_no, sort, part_id, requested_part_id, description, qty_requested, qty_filled,
                                       qty_special_order, unit_price_cents, taxable)
    values (t.org_id, t.id, v_line, v_sort, p.id, case when p.id <> v_part then v_part end, p.description, v_qty, v_fill, 0,
            coalesce(p.price_cents, p.list_price_cents, 0), true);
    v_added := v_added || jsonb_build_object('part_id', p.id, 'part_number', p.part_number, 'keyed', v_pn, 'superseded', p.id <> v_part,
                                             'qty', v_qty, 'filled', v_fill, 'short', v_qty - v_fill);
  end loop;
  perform pm.log_activity(t.org_id, t.location_id, null, 'parts_ticket.pick_list', 'parts_tickets', t.id,
    format('Pick list on %s: %s lines, %s unknown', t.number, jsonb_array_length(v_added), jsonb_array_length(v_unknown)), '{}'::jsonb);
  return jsonb_build_object('added', v_added, 'unknown', v_unknown);
end $$;

-- One scan, anywhere: serial / stock # / VIN → unit; part number → part (through supersession);
-- RO / ticket / deal / rental numbers → that record. Company-scoped; first match wins.
create or replace function pm.dlr_scan(p_location uuid, p_code text)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_c text := upper(btrim(coalesce(p_code, ''))); r record; v_res uuid;
begin
  if v_c = '' or char_length(v_c) > 80 then return jsonb_build_object('kind', 'none'); end if;
  select a.id, concat_ws(' ', a.model_year::text, a.make, a.model) as label, a.serial_number, a.stock_number, a.unit_status into r
    from pm.assets a
   where a.org_id = v_org and a.location_id = p_location
     and (upper(a.serial_number) = v_c or upper(a.stock_number) = v_c or upper(a.vin) = v_c)
   order by a.unit_status is not null desc, a.updated_at desc limit 1;
  if r.id is not null then
    return jsonb_build_object('kind', 'unit', 'id', r.id, 'label', r.label, 'serial_number', r.serial_number, 'stock_number', r.stock_number,
                              'status', r.unit_status);
  end if;
  select p.id into v_res from pm.parts p
   where p.org_id = v_org and p.location_id = p_location and upper(btrim(p.part_number)) = v_c order by p.status = 'ACTIVE' desc limit 1;
  if v_res is not null then
    select p.id, p.part_number, p.description, p.manufacturer into r from pm.parts p where p.id = pm.resolve_part(v_res);
    return jsonb_build_object('kind', 'part', 'id', r.id, 'label', concat_ws(' ', r.manufacturer, r.part_number), 'description', r.description,
                              'keyed_part_id', v_res, 'superseded', r.id <> v_res);
  end if;
  select w.id, w.number, w.kind, w.status, w.job_id into r from pm.work_orders w
   where w.org_id = v_org and w.location_id = p_location and upper(w.number) = v_c limit 1;
  if r.id is not null then return jsonb_build_object('kind', 'work_order', 'id', r.id, 'label', r.number, 'status', r.status, 'job_id', r.job_id, 'wo_kind', r.kind); end if;
  select x.id, x.number, x.status into r from pm.parts_tickets x where x.org_id = v_org and x.location_id = p_location and upper(x.number) = v_c limit 1;
  if r.id is not null then return jsonb_build_object('kind', 'ticket', 'id', r.id, 'label', r.number, 'status', r.status); end if;
  select x.id, x.number, x.stage as status into r from pm.dealer_deals x where x.org_id = v_org and x.location_id = p_location and upper(x.number) = v_c limit 1;
  if r.id is not null then return jsonb_build_object('kind', 'deal', 'id', r.id, 'label', r.number, 'status', r.status); end if;
  select x.id, x.number, x.status into r from pm.rental_contracts x where x.org_id = v_org and x.location_id = p_location and upper(x.number) = v_c limit 1;
  if r.id is not null then return jsonb_build_object('kind', 'rental', 'id', r.id, 'label', r.number, 'status', r.status); end if;
  return jsonb_build_object('kind', 'none', 'code', v_c);
end $$;

-- D2. OEM price files + price matrix ------------------------------------------
create table if not exists pm.dlr_price_rules (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  manufacturer      text,                                   -- null = the store default
  category          text,                                   -- null = every category
  basis             text not null default 'LIST' check (basis in ('LIST','COST')),
  pct               numeric(7,4) not null default 0 check (pct > -1 and pct <= 5),   -- LIST: list × (1 + pct); COST: cost × (1 + pct)
  min_margin_pct    numeric(5,4) check (min_margin_pct is null or (min_margin_pct >= 0 and min_margin_pct < 1)),
  priority          int not null default 0,
  is_active         boolean not null default true,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id)
);

create table if not exists pm.dlr_price_files (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  manufacturer   text not null check (char_length(btrim(manufacturer)) between 1 and 24),
  mfr_vendor_id  uuid references core.vendors(id),
  format         text not null default 'GENERIC' check (format in ('KUBOTA','STIHL','HUSQVARNA','TORO','EXMARK','ECHO','BRIGGS','GENERIC')),
  file_name      text,
  effective_on   date not null default current_date,
  status         text not null default 'STAGED' check (status in ('STAGED','APPLIED','DISCARDED')),
  row_count      int not null default 0,
  summary        jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  applied_by     text,
  applied_at     timestamptz,
  unique (org_id, id),
  check (status <> 'APPLIED' or applied_at is not null)
);
create index if not exists pm_dlr_price_files_idx on pm.dlr_price_files (org_id, location_id, created_at desc);

create table if not exists pm.dlr_price_file_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  file_id            uuid not null,
  line_no            int not null,
  part_number        text not null,
  description        text,
  uom                text,
  category           text,
  list_price_cents   bigint check (list_price_cents is null or list_price_cents >= 0),
  cost_cents         bigint check (cost_cents is null or cost_cents >= 0),
  core_charge_cents  bigint check (core_charge_cents is null or core_charge_cents >= 0),
  supersedes_to      text,                                   -- this number is replaced by …
  action             text not null check (action in ('NEW','CHANGED','UNCHANGED','SUPERSEDED','INVALID')),
  part_id            uuid,
  old_list_cents     bigint,
  old_cost_cents     bigint,
  old_price_cents    bigint,
  new_price_cents    bigint,
  margin_pct         numeric(7,4),
  below_floor        boolean not null default false,
  error              text,
  applied            boolean not null default false,
  unique (org_id, id),
  unique (file_id, line_no),
  foreign key (org_id, file_id) references pm.dlr_price_files (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_dlr_pfl_file_idx on pm.dlr_price_file_lines (org_id, file_id, action);

-- Sell price from the matrix (most specific active rule: manufacturer + category > manufacturer > default).
create or replace function pm.dlr_matrix_price(p_org uuid, p_location uuid, p_manufacturer text, p_category text,
                                               p_list bigint, p_cost bigint, out price_cents bigint, out min_margin_pct numeric)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare r pm.dlr_price_rules%rowtype;
begin
  select * into r from pm.dlr_price_rules x
   where x.org_id = p_org and x.location_id = p_location and x.is_active
     and (x.manufacturer is null or upper(x.manufacturer) = upper(coalesce(p_manufacturer, '')))
     and (x.category is null or upper(x.category) = upper(coalesce(p_category, '')))
   order by (x.manufacturer is not null) desc, (x.category is not null) desc, x.priority desc, x.created_at
   limit 1;
  if r.id is null then
    price_cents := p_list;
  elsif r.basis = 'LIST' then
    price_cents := case when p_list is null then null else round(p_list * (1 + r.pct))::bigint end;
  else
    price_cents := case when p_cost is null then p_list else round(p_cost * (1 + r.pct))::bigint end;
  end if;
  min_margin_pct := coalesce(r.min_margin_pct, (select s.margin_floor_pct from pm.dealer_settings s where s.org_id = p_org and s.location_id = p_location));
end $$;

-- Stage an OEM price file (rows already mapped by lib/dealer/price-files.ts). Nothing changes in the
-- catalog until pm.dlr_apply_price_file. Rows: [{part_number, description, list_price_cents, cost_cents,
-- core_charge_cents, supersedes_to, uom, category}].
create or replace function pm.dlr_stage_price_file(p_location uuid, p_manufacturer text, p_format text, p_file_name text,
                                                   p_effective_on date, p_rows jsonb, p_mfr_vendor uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_mfr text := upper(btrim(coalesce(p_manufacturer, ''))); v_id uuid; e jsonb; n int := 0;
        v_pn text; p pm.parts%rowtype; v_list bigint; v_cost bigint; v_core bigint; v_sup text; v_action text; v_err text; mp record;
        v_new int := 0; v_chg int := 0; v_same int := 0; v_sup_n int := 0; v_bad int := 0; v_floor int := 0; v_margin numeric;
begin
  if v_mfr = '' then raise exception 'PM_INVALID: the price file needs a manufacturer line code' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_rows, 'null')) <> 'array' then raise exception 'PM_INVALID: rows must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 50000 then raise exception 'PM_INVALID: at most 50,000 rows per file' using errcode = '22023'; end if;
  insert into pm.dlr_price_files (org_id, location_id, manufacturer, mfr_vendor_id, format, file_name, effective_on)
  values (v_org, p_location, v_mfr, p_mfr_vendor, coalesce(nullif(upper(p_format), ''), 'GENERIC'), left(p_file_name, 200), coalesce(p_effective_on, current_date))
  returning id into v_id;
  for e in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    v_pn := upper(btrim(coalesce(e ->> 'part_number', '')));
    v_list := pm._x_try_bigint(e ->> 'list_price_cents');
    v_cost := pm._x_try_bigint(e ->> 'cost_cents');
    v_core := pm._x_try_bigint(e ->> 'core_charge_cents');
    v_sup := nullif(upper(btrim(coalesce(e ->> 'supersedes_to', ''))), '');
    v_err := null; p := null;
    if v_pn = '' or char_length(v_pn) > 40 then v_err := 'part number missing or longer than 40 characters';
    elsif (v_list is not null and v_list < 0) or (v_cost is not null and v_cost < 0) then v_err := 'negative price';
    elsif v_sup = v_pn then v_err := 'a part cannot supersede itself';
    end if;
    if v_err is null then
      select * into p from pm.parts x where x.org_id = v_org and x.location_id = p_location
         and upper(coalesce(x.manufacturer, '')) = v_mfr and upper(btrim(x.part_number)) = v_pn limit 1;
      if v_sup is not null then v_action := 'SUPERSEDED';
      elsif p.id is null then
        v_action := 'NEW';
        if nullif(btrim(coalesce(e ->> 'description', '')), '') is null then v_err := 'a new part needs a description'; end if;
      elsif (v_list is not null and v_list is distinct from p.list_price_cents) or (v_cost is not null and v_cost is distinct from p.cost_cents)
         or (v_core is not null and v_core is distinct from p.core_charge_cents) then v_action := 'CHANGED';
      else v_action := 'UNCHANGED';
      end if;
    end if;
    if v_err is not null then v_action := 'INVALID'; end if;
    select * into mp from pm.dlr_matrix_price(v_org, p_location, v_mfr, coalesce(e ->> 'category', p.category),
                                               coalesce(v_list, p.list_price_cents), coalesce(v_cost, p.cost_cents));
    v_margin := case when coalesce(mp.price_cents, 0) > 0 and coalesce(v_cost, p.cost_cents) is not null
                     then round((mp.price_cents - coalesce(v_cost, p.cost_cents))::numeric / mp.price_cents, 4) end;
    insert into pm.dlr_price_file_lines (org_id, file_id, line_no, part_number, description, uom, category, list_price_cents, cost_cents,
                                         core_charge_cents, supersedes_to, action, part_id, old_list_cents, old_cost_cents, old_price_cents,
                                         new_price_cents, margin_pct, below_floor, error)
    values (v_org, v_id, n, coalesce(nullif(v_pn, ''), '?'), nullif(left(btrim(coalesce(e ->> 'description', '')), 200), ''),
            nullif(left(e ->> 'uom', 12), ''), nullif(left(e ->> 'category', 40), ''), v_list, v_cost, v_core, v_sup, v_action, p.id,
            p.list_price_cents, p.cost_cents, p.price_cents, mp.price_cents, v_margin,
            v_action in ('NEW','CHANGED') and v_margin is not null and mp.min_margin_pct is not null and v_margin < mp.min_margin_pct, v_err);
    case v_action when 'NEW' then v_new := v_new + 1; when 'CHANGED' then v_chg := v_chg + 1; when 'UNCHANGED' then v_same := v_same + 1;
                  when 'SUPERSEDED' then v_sup_n := v_sup_n + 1; else v_bad := v_bad + 1; end case;
    if v_action in ('NEW','CHANGED') and v_margin is not null and mp.min_margin_pct is not null and v_margin < mp.min_margin_pct then v_floor := v_floor + 1; end if;
  end loop;
  update pm.dlr_price_files set row_count = n,
         summary = jsonb_build_object('new', v_new, 'changed', v_chg, 'unchanged', v_same, 'superseded', v_sup_n, 'invalid', v_bad, 'below_floor', v_floor)
   where id = v_id;
  return jsonb_build_object('file_id', v_id, 'rows', n, 'new', v_new, 'changed', v_chg, 'unchanged', v_same, 'superseded', v_sup_n,
                            'invalid', v_bad, 'below_floor', v_floor);
end $$;

-- Apply a staged file: new parts created (core.items identity via pm.upsert_part), list / cost / matrix
-- price updated, supersessions chained (replacement created from the old part's description when the
-- file does not carry it). Lines that fail keep their error; the rest apply.
create or replace function pm.dlr_apply_price_file(p_file uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dlr_price_files%rowtype; l pm.dlr_price_file_lines%rowtype; v_id uuid; v_new uuid; o pm.parts%rowtype; v_ok int := 0; v_fail int := 0;
begin
  select * into f from pm.dlr_price_files x where x.id = p_file for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: price file % not found in the caller''s organization', p_file using errcode = '42501';
  end if;
  if f.status <> 'STAGED' then raise exception 'PM_PRICE_FILE_STATE: this file is %', lower(f.status) using errcode = '22023'; end if;
  for l in select * from pm.dlr_price_file_lines x where x.org_id = f.org_id and x.file_id = f.id and x.action in ('NEW','CHANGED') order by x.line_no loop
    begin
      v_id := pm.upsert_part(f.location_id, l.part_number, coalesce(l.description, (select p.description from pm.parts p where p.id = l.part_id)),
                jsonb_strip_nulls(jsonb_build_object('manufacturer', f.manufacturer, 'mfr_vendor_id', f.mfr_vendor_id, 'uom', l.uom, 'category', l.category,
                  'list_price_cents', l.list_price_cents, 'cost_cents', l.cost_cents, 'price_cents', l.new_price_cents, 'core_charge_cents', l.core_charge_cents)));
      update pm.dlr_price_file_lines set applied = true, part_id = v_id where id = l.id;
      v_ok := v_ok + 1;
    exception when others then
      update pm.dlr_price_file_lines set error = left(sqlerrm, 300) where id = l.id;
      v_fail := v_fail + 1;
    end;
  end loop;
  for l in select * from pm.dlr_price_file_lines x where x.org_id = f.org_id and x.file_id = f.id and x.action = 'SUPERSEDED' order by x.line_no loop
    begin
      select * into o from pm.parts x where x.org_id = f.org_id and x.location_id = f.location_id
         and upper(coalesce(x.manufacturer, '')) = f.manufacturer and upper(btrim(x.part_number)) = l.part_number limit 1;
      if o.id is null then
        o.id := pm.upsert_part(f.location_id, l.part_number, coalesce(l.description, 'Superseded part'),
                  jsonb_strip_nulls(jsonb_build_object('manufacturer', f.manufacturer, 'mfr_vendor_id', f.mfr_vendor_id, 'list_price_cents', l.list_price_cents)));
        select * into o from pm.parts x where x.id = o.id;
      end if;
      select x.id into v_new from pm.parts x where x.org_id = f.org_id and x.location_id = f.location_id
         and upper(coalesce(x.manufacturer, '')) = f.manufacturer and upper(btrim(x.part_number)) = l.supersedes_to limit 1;
      if v_new is null then
        v_new := pm.upsert_part(f.location_id, l.supersedes_to, o.description,
                   jsonb_strip_nulls(jsonb_build_object('manufacturer', f.manufacturer, 'mfr_vendor_id', f.mfr_vendor_id, 'uom', o.uom, 'category', o.category,
                     'list_price_cents', coalesce(l.list_price_cents, o.list_price_cents), 'cost_cents', o.cost_cents, 'price_cents', o.price_cents)));
      end if;
      if o.superseded_by_part_id is distinct from v_new then perform pm.supersede_part(o.id, v_new); end if;
      update pm.dlr_price_file_lines set applied = true, part_id = o.id where id = l.id;
      v_ok := v_ok + 1;
    exception when others then
      update pm.dlr_price_file_lines set error = left(sqlerrm, 300) where id = l.id;
      v_fail := v_fail + 1;
    end;
  end loop;
  update pm.dlr_price_files set status = 'APPLIED', applied_by = pm.current_user_id(), applied_at = now(),
         summary = summary || jsonb_build_object('applied', v_ok, 'failed', v_fail)
   where id = f.id;
  perform pm.log_activity(f.org_id, f.location_id, null, 'price_file.applied', 'dlr_price_files', f.id,
    format('%s price file applied: %s lines, %s failed', f.manufacturer, v_ok, v_fail), f.summary);
  return jsonb_build_object('file_id', f.id, 'applied', v_ok, 'failed', v_fail);
end $$;

create or replace function pm.dlr_discard_price_file(p_file uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dlr_price_files%rowtype;
begin
  select * into f from pm.dlr_price_files x where x.id = p_file for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: price file % not found in the caller''s organization', p_file using errcode = '42501';
  end if;
  if f.status <> 'STAGED' then raise exception 'PM_PRICE_FILE_STATE: this file is %', lower(f.status) using errcode = '22023'; end if;
  update pm.dlr_price_files set status = 'DISCARDED' where id = f.id;
  return f.id;
end $$;

-- D3. Catalog + OEM integrations (non-secret configuration) --------------------
create table if not exists pm.dlr_integrations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  provider      text not null check (provider in ('PARTSMART','PARTSTREAM','OEM_WARRANTY','OEM_REGISTRATION','OEM_PARTS_ORDER')),
  brand         text not null default '' check (char_length(brand) <= 24),   -- '' for catalog providers
  enabled       boolean not null default true,
  status        text not null default 'NOT_CONNECTED' check (status in ('NOT_CONNECTED','STUB','PORTAL_ASSIST','CONNECTED')),
  config        jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and not (config ?| array['password','secret','api_key','token'])),
  updated_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, location_id, provider, brand),
  unique (org_id, id)
);

-- D4. Warranty claim builder, submission, adjudication, credit matching -------
alter table pm.warranty_claims add column if not exists oem_brand          text;
alter table pm.warranty_claims add column if not exists causal_part_number text;
alter table pm.warranty_claims add column if not exists causal_part_serial text;
alter table pm.warranty_claims add column if not exists failure_on         date;
alter table pm.warranty_claims add column if not exists repair_on          date;
alter table pm.warranty_claims add column if not exists purchase_on        date;
alter table pm.warranty_claims add column if not exists machine_hours      numeric(12,2);
alter table pm.warranty_claims add column if not exists engine_hours       numeric(12,2);
alter table pm.warranty_claims add column if not exists engine_serial      text;
alter table pm.warranty_claims add column if not exists symptom_code       text;
alter table pm.warranty_claims add column if not exists defect_code        text;
alter table pm.warranty_claims add column if not exists remedy_code        text;
alter table pm.warranty_claims add column if not exists complaint          text;
alter table pm.warranty_claims add column if not exists cause              text;
alter table pm.warranty_claims add column if not exists correction         text;
alter table pm.warranty_claims add column if not exists requested_hours    numeric(8,2);
alter table pm.warranty_claims add column if not exists pre_auth_ref       text;
alter table pm.warranty_claims add column if not exists submit_by          date;
alter table pm.warranty_claims add column if not exists response_due_on    date;
alter table pm.warranty_claims add column if not exists retention_until    date;
alter table pm.warranty_claims add column if not exists return_tag         text;
alter table pm.warranty_claims add column if not exists parts_returned_on  date;
alter table pm.warranty_claims add column if not exists submission_channel text;
alter table pm.warranty_claims add column if not exists external_ref       text;
alter table pm.warranty_claims add column if not exists adjudication       text;
alter table pm.warranty_claims add column if not exists credit_memo_ref    text;
alter table pm.warranty_claims add column if not exists credited_cents     bigint not null default 0;
alter table pm.warranty_claims add column if not exists rebill_requested_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'warranty_claims_dlr_chk' and conrelid = 'pm.warranty_claims'::regclass) then
    alter table pm.warranty_claims add constraint warranty_claims_dlr_chk check (
      (machine_hours is null or machine_hours >= 0) and (engine_hours is null or engine_hours >= 0)
      and (requested_hours is null or requested_hours >= 0) and credited_cents >= 0
      and (submission_channel is null or submission_channel in ('DIRECT','PORTAL_ASSIST','MANUAL'))
      and (adjudication is null or adjudication in ('ACCEPTED','ADJUSTED','REJECTED','RETURNED','REBILLED','WRITTEN_OFF'))
      and (repair_on is null or failure_on is null or repair_on >= failure_on));
  end if;
end $$;

create table if not exists pm.dlr_claim_parts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  claim_id          uuid not null,
  line_no           int not null default 0,
  part_id           uuid,
  part_number       text not null check (char_length(btrim(part_number)) between 1 and 40),
  description       text,
  qty               numeric(12,4) not null default 1 check (qty > 0),
  unit_price_cents  bigint not null default 0 check (unit_price_cents >= 0),
  amount_cents      bigint generated always as ((round(qty * unit_price_cents))::bigint) stored,
  is_causal         boolean not null default false,
  return_required   boolean not null default false,
  returned_on       date,
  created_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, claim_id) references pm.warranty_claims (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, part_id) references pm.parts (org_id, id) deferrable initially immediate
);

create table if not exists pm.dlr_claim_submissions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  claim_id      uuid not null,
  attempt_no    int not null check (attempt_no >= 1),
  brand         text,
  channel       text not null check (channel in ('DIRECT','PORTAL_ASSIST')),
  packet        jsonb not null check (jsonb_typeof(packet) = 'object'),
  status        text not null default 'PREPARED' check (status in ('PREPARED','SENT','ACKNOWLEDGED','FAILED','FILED_ON_PORTAL','SUPERSEDED')),
  external_ref  text,
  response      jsonb,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  unique (claim_id, attempt_no),
  foreign key (org_id, claim_id) references pm.warranty_claims (org_id, id) on delete cascade deferrable initially immediate
);

-- OEM profile (code catalog; no table). channel DIRECT = an electronic adapter is defined (stubbed
-- until each OEM's API contract is signed); PORTAL = portal-assist packet. Days count from the repair
-- (filing), the submission (response) and the decision (part retention).
create or replace function pm.dlr_oem_profile(p_brand text) returns jsonb
language sql immutable
as $$
  select case upper(coalesce(p_brand, ''))
    when 'KUBOTA'    then '{"brand":"KUBOTA","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":90,"preauth_over_cents":150000,
                           "required":["symptom_code","defect_code","remedy_code","machine_hours","causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction","requested_hours"]}'::jsonb
    when 'TORO'      then '{"brand":"TORO","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":60,"preauth_over_cents":100000,
                           "required":["defect_code","remedy_code","machine_hours","causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction"]}'::jsonb
    when 'EXMARK'    then '{"brand":"EXMARK","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":60,"preauth_over_cents":100000,
                           "required":["defect_code","remedy_code","machine_hours","causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction"]}'::jsonb
    when 'STIHL'     then '{"brand":"STIHL","channel":"DIRECT","filing_days":30,"response_days":21,"retention_days":60,"preauth_over_cents":50000,
                           "required":["causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction"]}'::jsonb
    when 'HUSQVARNA' then '{"brand":"HUSQVARNA","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":60,"preauth_over_cents":75000,
                           "required":["defect_code","causal_part_number","failure_on","repair_on","purchase_on","machine_hours","complaint","cause","correction"]}'::jsonb
    when 'ECHO'      then '{"brand":"ECHO","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":60,"preauth_over_cents":50000,
                           "required":["causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction"]}'::jsonb
    when 'BRIGGS'    then '{"brand":"BRIGGS","channel":"DIRECT","filing_days":30,"response_days":30,"retention_days":60,"preauth_over_cents":50000,
                           "required":["engine_serial","engine_hours","causal_part_number","failure_on","repair_on","purchase_on","complaint","cause","correction"]}'::jsonb
    else jsonb_build_object('brand', upper(coalesce(p_brand, '')), 'channel', 'PORTAL', 'filing_days', 30, 'response_days', 30, 'retention_days', 60,
                            'preauth_over_cents', null, 'required', '["causal_part_number","failure_on","repair_on","complaint","cause","correction"]'::jsonb)
  end
$$;

-- Missing fields, deadlines and the channel for a claim (deterministic; the AI only drafts the text).
create or replace function pm.dlr_claim_readiness(p_claim uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; a pm.assets%rowtype; prof jsonb; k text; v_missing text[] := '{}'; v_row jsonb; v_submit_by date; v_parts int;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  select * into a from pm.assets x where x.org_id = c.org_id and x.id = c.asset_id;
  prof := pm.dlr_oem_profile(coalesce(c.oem_brand, a.make));
  v_row := to_jsonb(c);
  for k in select jsonb_array_elements_text(prof -> 'required') loop
    if v_row ->> k is null or btrim(v_row ->> k) = '' then
      if not (k = 'purchase_on' and a.unit_delivered_on is not null) then v_missing := v_missing || k; end if;
    end if;
  end loop;
  if c.oem_brand is null and a.make is null then v_missing := v_missing || 'oem_brand'::text; end if;
  if a.serial_number is null then v_missing := v_missing || 'serial_number'::text; end if;
  if c.claimed_cents <= 0 then v_missing := v_missing || 'claimed_amount'::text; end if;
  if (prof ->> 'preauth_over_cents') is not null and c.claimed_cents > (prof ->> 'preauth_over_cents')::bigint and c.pre_auth_ref is null then
    v_missing := v_missing || 'pre_auth_ref'::text;
  end if;
  select count(*) into v_parts from pm.dlr_claim_parts p where p.org_id = c.org_id and p.claim_id = c.id and p.is_causal;
  if c.claimed_parts_cents > 0 and v_parts = 0 and c.causal_part_number is null then v_missing := v_missing || 'causal_part'::text; end if;
  v_submit_by := coalesce(c.submit_by, c.filing_deadline, c.repair_on + (prof ->> 'filing_days')::int);
  return jsonb_build_object('claim_id', c.id, 'status', c.status, 'brand', prof ->> 'brand', 'channel', prof ->> 'channel',
    'ready', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing), 'submit_by', v_submit_by,
    'days_left', case when v_submit_by is not null then v_submit_by - current_date end,
    'response_due_on', coalesce(c.response_due_on, (c.submitted_at)::date + (prof ->> 'response_days')::int),
    'retention_days', (prof ->> 'retention_days')::int, 'profile', prof);
end $$;

-- Claim builder edits (DRAFT / RETURNED only). Fields not named keep their value.
create or replace function pm.dlr_update_claim(p_claim uuid, p_fields jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; f jsonb := coalesce(p_fields, '{}'); prof jsonb; k text;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  if c.status not in ('DRAFT','RETURNED','REJECTED') then
    raise exception 'PM_CLAIM_LOCKED: a % claim cannot be edited', lower(c.status) using errcode = '55000';
  end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('oem_brand','causal_part_number','causal_part_serial','failure_on','repair_on','purchase_on','machine_hours','engine_hours',
                 'engine_serial','symptom_code','defect_code','remedy_code','complaint','cause','correction','requested_hours','pre_auth_ref',
                 'return_tag','failure_code','labor_op','labor_hours','claimed_labor_cents','claimed_other_cents','notes','filing_deadline') then
      raise exception 'PM_INVALID: % is not a claim field', k using errcode = '22023';
    end if;
  end loop;
  update pm.warranty_claims set
    oem_brand          = case when f ? 'oem_brand' then nullif(upper(btrim(f ->> 'oem_brand')), '') else oem_brand end,
    causal_part_number = case when f ? 'causal_part_number' then nullif(upper(btrim(f ->> 'causal_part_number')), '') else causal_part_number end,
    causal_part_serial = case when f ? 'causal_part_serial' then nullif(btrim(f ->> 'causal_part_serial'), '') else causal_part_serial end,
    failure_on         = case when f ? 'failure_on' then pm._x_try_date(f ->> 'failure_on') else failure_on end,
    repair_on          = case when f ? 'repair_on' then pm._x_try_date(f ->> 'repair_on') else repair_on end,
    purchase_on        = case when f ? 'purchase_on' then pm._x_try_date(f ->> 'purchase_on') else purchase_on end,
    machine_hours      = case when f ? 'machine_hours' then pm._x_try_num(f ->> 'machine_hours') else machine_hours end,
    engine_hours       = case when f ? 'engine_hours' then pm._x_try_num(f ->> 'engine_hours') else engine_hours end,
    engine_serial      = case when f ? 'engine_serial' then nullif(btrim(f ->> 'engine_serial'), '') else engine_serial end,
    symptom_code       = case when f ? 'symptom_code' then nullif(upper(btrim(f ->> 'symptom_code')), '') else symptom_code end,
    defect_code        = case when f ? 'defect_code' then nullif(upper(btrim(f ->> 'defect_code')), '') else defect_code end,
    remedy_code        = case when f ? 'remedy_code' then nullif(upper(btrim(f ->> 'remedy_code')), '') else remedy_code end,
    complaint          = case when f ? 'complaint' then nullif(left(btrim(f ->> 'complaint'), 2000), '') else complaint end,
    cause              = case when f ? 'cause' then nullif(left(btrim(f ->> 'cause'), 2000), '') else cause end,
    correction         = case when f ? 'correction' then nullif(left(btrim(f ->> 'correction'), 2000), '') else correction end,
    requested_hours    = case when f ? 'requested_hours' then pm._x_try_num(f ->> 'requested_hours') else requested_hours end,
    pre_auth_ref       = case when f ? 'pre_auth_ref' then nullif(btrim(f ->> 'pre_auth_ref'), '') else pre_auth_ref end,
    return_tag         = case when f ? 'return_tag' then nullif(btrim(f ->> 'return_tag'), '') else return_tag end,
    failure_code       = case when f ? 'failure_code' then nullif(btrim(f ->> 'failure_code'), '') else failure_code end,
    labor_op           = case when f ? 'labor_op' then nullif(btrim(f ->> 'labor_op'), '') else labor_op end,
    labor_hours        = case when f ? 'labor_hours' then pm._x_try_num(f ->> 'labor_hours') else labor_hours end,
    claimed_labor_cents = case when f ? 'claimed_labor_cents' then greatest(coalesce(pm._x_try_bigint(f ->> 'claimed_labor_cents'), 0), 0) else claimed_labor_cents end,
    claimed_other_cents = case when f ? 'claimed_other_cents' then greatest(coalesce(pm._x_try_bigint(f ->> 'claimed_other_cents'), 0), 0) else claimed_other_cents end,
    notes              = case when f ? 'notes' then nullif(left(f ->> 'notes', 4000), '') else notes end,
    filing_deadline    = case when f ? 'filing_deadline' then pm._x_try_date(f ->> 'filing_deadline') else filing_deadline end
  where id = c.id;
  -- the brand's filing window sets the submit-by date unless a deadline was keyed
  select * into c from pm.warranty_claims x where x.id = c.id;
  prof := pm.dlr_oem_profile(coalesce(c.oem_brand, (select a.make from pm.assets a where a.org_id = c.org_id and a.id = c.asset_id)));
  update pm.warranty_claims set submit_by = coalesce(c.filing_deadline, c.repair_on + (prof ->> 'filing_days')::int) where id = c.id;
  return c.id;
end $$;

-- Replace the claim's part lines; claimed parts = Σ lines.
create or replace function pm.dlr_set_claim_parts(p_claim uuid, p_parts jsonb)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; e jsonb; n int := 0; v_loc uuid; v_part uuid; v_pn text;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  if c.status not in ('DRAFT','RETURNED','REJECTED') then raise exception 'PM_CLAIM_LOCKED: a % claim cannot be edited', lower(c.status) using errcode = '55000'; end if;
  if jsonb_typeof(coalesce(p_parts, 'null')) <> 'array' or jsonb_array_length(p_parts) > 100 then
    raise exception 'PM_INVALID: parts must be an array of at most 100 lines' using errcode = '22023';
  end if;
  select w.location_id into v_loc from pm.work_orders w where w.org_id = c.org_id and w.id = c.work_order_id;
  delete from pm.dlr_claim_parts where org_id = c.org_id and claim_id = c.id;
  for e in select * from jsonb_array_elements(p_parts) loop
    v_pn := upper(btrim(coalesce(e ->> 'part_number', '')));
    continue when v_pn = '';
    n := n + 1;
    select p.id into v_part from pm.parts p where p.org_id = c.org_id and p.location_id = v_loc and upper(btrim(p.part_number)) = v_pn limit 1;
    insert into pm.dlr_claim_parts (org_id, claim_id, line_no, part_id, part_number, description, qty, unit_price_cents, is_causal, return_required)
    values (c.org_id, c.id, n, v_part, left(v_pn, 40), nullif(left(e ->> 'description', 200), ''), coalesce(pm._x_try_num(e ->> 'qty'), 1),
            greatest(coalesce(pm._x_try_bigint(e ->> 'unit_price_cents'), 0), 0), coalesce(pm._x_try_bool(e ->> 'is_causal'), false),
            coalesce(pm._x_try_bool(e ->> 'return_required'), false));
  end loop;
  update pm.warranty_claims set claimed_parts_cents = coalesce((select sum(p.amount_cents) from pm.dlr_claim_parts p where p.org_id = c.org_id and p.claim_id = c.id), 0),
         causal_part_number = coalesce(causal_part_number, (select p.part_number from pm.dlr_claim_parts p where p.org_id = c.org_id and p.claim_id = c.id and p.is_causal order by p.line_no limit 1))
   where id = c.id;
  return n;
end $$;

-- Build the submission packet (structured for a direct adapter + ordered copy fields for the OEM
-- portal) and log it. Refuses an incomplete claim. The app's adapter (lib/dealer/warranty-adapters.ts)
-- sends it when the brand is connected, else the clerk files it on the portal with the copy fields.
create or replace function pm.dlr_prepare_claim_submission(p_claim uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; a pm.assets%rowtype; w pm.work_orders%rowtype; rd jsonb; v_packet jsonb; v_parts jsonb; v_id uuid; v_n int;
        v_dealer text; v_channel text; v_integ pm.dlr_integrations%rowtype;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  if c.status not in ('DRAFT','RETURNED','REJECTED') then raise exception 'PM_CLAIM_TRANSITION_INVALID: % claim', lower(c.status) using errcode = '22023'; end if;
  rd := pm.dlr_claim_readiness(p_claim);
  if not (rd ->> 'ready')::boolean then
    raise exception 'PM_CLAIM_INCOMPLETE: the claim still needs: %', (select string_agg(x, ', ') from jsonb_array_elements_text(rd -> 'missing') x)
      using errcode = 'P0001';
  end if;
  select * into a from pm.assets x where x.org_id = c.org_id and x.id = c.asset_id;
  select * into w from pm.work_orders x where x.org_id = c.org_id and x.id = c.work_order_id;
  select * into v_integ from pm.dlr_integrations i where i.org_id = c.org_id and i.location_id = w.location_id and i.provider = 'OEM_WARRANTY'
     and i.brand = (rd ->> 'brand') and i.enabled limit 1;
  v_dealer := v_integ.config ->> 'dealer_code';
  v_channel := case when (rd ->> 'channel') = 'DIRECT' and v_integ.status = 'CONNECTED' then 'DIRECT' else 'PORTAL_ASSIST' end;
  select coalesce(jsonb_agg(jsonb_build_object('part_number', p.part_number, 'description', p.description, 'qty', p.qty, 'unit_price_cents', p.unit_price_cents,
                                               'amount_cents', p.amount_cents, 'causal', p.is_causal, 'return_required', p.return_required) order by p.line_no), '[]')
    into v_parts from pm.dlr_claim_parts p where p.org_id = c.org_id and p.claim_id = c.id;
  v_packet := jsonb_build_object(
    'brand', rd ->> 'brand', 'dealer_code', v_dealer, 'dealer_claim_ref', w.number || '-' || left(c.id::text, 8),
    'repair_order', w.number, 'pre_authorization', c.pre_auth_ref,
    'unit', jsonb_build_object('make', a.make, 'model', a.model, 'model_year', a.model_year, 'serial_number', a.serial_number,
                               'engine_serial', c.engine_serial, 'machine_hours', coalesce(c.machine_hours, w.meter_in), 'engine_hours', c.engine_hours,
                               'purchase_on', coalesce(c.purchase_on, a.unit_delivered_on)),
    'failure', jsonb_build_object('failure_on', c.failure_on, 'repair_on', c.repair_on, 'symptom_code', c.symptom_code, 'defect_code', c.defect_code,
                                  'remedy_code', c.remedy_code, 'causal_part_number', c.causal_part_number, 'causal_part_serial', c.causal_part_serial,
                                  'complaint', coalesce(c.complaint, w.complaint), 'cause', coalesce(c.cause, w.cause), 'correction', coalesce(c.correction, w.resolution)),
    'labor', jsonb_build_object('labor_op', c.labor_op, 'requested_hours', coalesce(c.requested_hours, c.labor_hours), 'labor_cents', c.claimed_labor_cents),
    'parts', v_parts, 'other_cents', c.claimed_other_cents, 'claimed_cents', c.claimed_cents,
    'copy_fields', jsonb_build_array(
      jsonb_build_object('label', 'Dealer number', 'value', v_dealer),
      jsonb_build_object('label', 'Serial number', 'value', a.serial_number),
      jsonb_build_object('label', 'Model', 'value', a.model),
      jsonb_build_object('label', 'Purchase date', 'value', coalesce(c.purchase_on, a.unit_delivered_on)),
      jsonb_build_object('label', 'Failure date', 'value', c.failure_on),
      jsonb_build_object('label', 'Repair date', 'value', c.repair_on),
      jsonb_build_object('label', 'Hours', 'value', coalesce(c.machine_hours, w.meter_in)),
      jsonb_build_object('label', 'Symptom / defect / remedy', 'value', concat_ws(' / ', c.symptom_code, c.defect_code, c.remedy_code)),
      jsonb_build_object('label', 'Causal part', 'value', c.causal_part_number),
      jsonb_build_object('label', 'Complaint', 'value', coalesce(c.complaint, w.complaint)),
      jsonb_build_object('label', 'Cause', 'value', coalesce(c.cause, w.cause)),
      jsonb_build_object('label', 'Correction', 'value', coalesce(c.correction, w.resolution)),
      jsonb_build_object('label', 'Labor op / hours', 'value', concat_ws(' / ', c.labor_op, coalesce(c.requested_hours, c.labor_hours)::text)),
      jsonb_build_object('label', 'Pre-authorization', 'value', c.pre_auth_ref)),
    'submit_by', rd -> 'submit_by');
  update pm.dlr_claim_submissions set status = 'SUPERSEDED', updated_at = now()
   where org_id = c.org_id and claim_id = c.id and status = 'PREPARED';
  select coalesce(max(s.attempt_no), 0) + 1 into v_n from pm.dlr_claim_submissions s where s.org_id = c.org_id and s.claim_id = c.id;
  insert into pm.dlr_claim_submissions (org_id, claim_id, attempt_no, brand, channel, packet)
  values (c.org_id, c.id, v_n, rd ->> 'brand', v_channel, v_packet) returning id into v_id;
  update pm.warranty_claims set oem_brand = coalesce(oem_brand, rd ->> 'brand'), submit_by = coalesce(submit_by, (rd ->> 'submit_by')::date) where id = c.id;
  return jsonb_build_object('submission_id', v_id, 'attempt_no', v_n, 'channel', v_channel, 'packet', v_packet);
end $$;

-- The adapter (or the clerk, after filing on the portal) records the submission; the claim moves to
-- SUBMITTED through pm.advance_warranty_claim (1104 state machine, DEALER_WARRANTY_CLAIM emit).
create or replace function pm.dlr_record_claim_submitted(p_submission uuid, p_status text, p_external_ref text default null,
                                                         p_claim_number text default null, p_response jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.dlr_claim_submissions%rowtype; c pm.warranty_claims%rowtype; prof jsonb;
begin
  select * into s from pm.dlr_claim_submissions x where x.id = p_submission for update;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: submission % not found in the caller''s organization', p_submission using errcode = '42501';
  end if;
  if p_status not in ('SENT','ACKNOWLEDGED','FAILED','FILED_ON_PORTAL') then raise exception 'PM_INVALID: status %', p_status using errcode = '22023'; end if;
  if s.status not in ('PREPARED','SENT') then raise exception 'PM_CLAIM_SUBMISSION_STATE: this submission is %', lower(s.status) using errcode = '22023'; end if;
  update pm.dlr_claim_submissions set status = p_status, external_ref = coalesce(nullif(btrim(p_external_ref), ''), external_ref),
         response = coalesce(p_response, response), updated_at = now() where id = s.id;
  select * into c from pm.warranty_claims x where x.id = s.claim_id for update;
  if p_status in ('SENT','ACKNOWLEDGED','FILED_ON_PORTAL') and c.status in ('DRAFT','RETURNED','REJECTED') then
    perform pm.advance_warranty_claim(c.id, 'SUBMITTED', null, coalesce(nullif(btrim(p_claim_number), ''), nullif(btrim(p_external_ref), '')), null);
    prof := pm.dlr_oem_profile(s.brand);
    update pm.warranty_claims set submission_channel = case when s.channel = 'DIRECT' and p_status <> 'FILED_ON_PORTAL' then 'DIRECT' else 'PORTAL_ASSIST' end,
           external_ref = coalesce(nullif(btrim(p_external_ref), ''), external_ref),
           response_due_on = current_date + (prof ->> 'response_days')::int
     where id = c.id;
  end if;
  return jsonb_build_object('submission_id', s.id, 'status', p_status, 'claim_status', (select status from pm.warranty_claims where id = c.id));
end $$;

-- OEM decision: ACCEPTED (approved in full) / ADJUSTED (approved for less) / REJECTED / RETURNED (needs info).
create or replace function pm.dlr_record_claim_response(p_claim uuid, p_outcome text, p_approved_cents bigint default null, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype; prof jsonb; v_amt bigint;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  if p_outcome not in ('ACCEPTED','ADJUSTED','REJECTED','RETURNED') then raise exception 'PM_INVALID: outcome %', p_outcome using errcode = '22023'; end if;
  if c.status <> 'SUBMITTED' then raise exception 'PM_CLAIM_TRANSITION_INVALID: the claim is %', lower(c.status) using errcode = '22023'; end if;
  if p_outcome = 'ADJUSTED' and (p_approved_cents is null or p_approved_cents >= c.claimed_cents) then
    raise exception 'PM_INVALID: an adjusted claim needs an approved amount below the claimed amount' using errcode = '22023';
  end if;
  if p_outcome in ('REJECTED','RETURNED') and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'PM_INVALID: record the OEM''s reason' using errcode = '22023';
  end if;
  v_amt := case when p_outcome = 'ACCEPTED' then c.claimed_cents else p_approved_cents end;
  perform pm.advance_warranty_claim(c.id, case p_outcome when 'ACCEPTED' then 'APPROVED' when 'ADJUSTED' then 'APPROVED' else p_outcome end,
                                    case when p_outcome in ('ACCEPTED','ADJUSTED') then v_amt end, null, p_reason);
  prof := pm.dlr_oem_profile(c.oem_brand);
  update pm.warranty_claims set adjudication = p_outcome,
         retention_until = case when p_outcome in ('ACCEPTED','ADJUSTED','REJECTED') then current_date + (prof ->> 'retention_days')::int else retention_until end
   where id = c.id;
  return jsonb_build_object('claim_id', c.id, 'status', (select status from pm.warranty_claims where id = c.id), 'adjudication', p_outcome, 'approved_cents', v_amt);
end $$;

-- A rejected / returned claim: RESUBMIT (back to the builder → a new packet), REBILL (the customer pays:
-- the claim is written off and a rebill is requested), WRITE_OFF.
create or replace function pm.dlr_resolve_rejected_claim(p_claim uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.warranty_claims%rowtype;
begin
  select * into c from pm.warranty_claims x where x.id = p_claim for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: claim % not found in the caller''s organization', p_claim using errcode = '42501';
  end if;
  if p_action not in ('RESUBMIT','REBILL','WRITE_OFF') then raise exception 'PM_INVALID: action %', p_action using errcode = '22023'; end if;
  if c.status not in ('REJECTED','RETURNED') then raise exception 'PM_CLAIM_TRANSITION_INVALID: the claim is %', lower(c.status) using errcode = '22023'; end if;
  if p_action = 'RESUBMIT' then
    return pm.dlr_prepare_claim_submission(c.id) || jsonb_build_object('action', 'RESUBMIT');
  end if;
  perform pm.advance_warranty_claim(c.id, 'WRITTEN_OFF', null, null, coalesce(p_reason, case when p_action = 'REBILL' then 'Rebilled to the customer' end));
  update pm.warranty_claims set adjudication = case when p_action = 'REBILL' then 'REBILLED' else 'WRITTEN_OFF' end,
         rebill_requested_at = case when p_action = 'REBILL' then now() else rebill_requested_at end
   where id = c.id;
  return jsonb_build_object('claim_id', c.id, 'action', p_action, 'status', 'WRITTEN_OFF');
end $$;

-- OEM credit memos (often on the parts statement): lines proposed to claims by claim #, then serial +
-- amount; a person confirms. Books posts the credit (DEALER_WARRANTY_PAID comes back from Books).
create table if not exists pm.dlr_credit_memos (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  oem_vendor_id  uuid references core.vendors(id),
  brand          text,
  memo_ref       text not null check (char_length(btrim(memo_ref)) between 1 and 60),
  memo_on        date not null default current_date,
  total_cents    bigint not null default 0,
  status         text not null default 'OPEN' check (status in ('OPEN','MATCHED','CLOSED')),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, location_id, memo_ref),
  unique (org_id, id)
);
create table if not exists pm.dlr_credit_memo_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  memo_id           uuid not null,
  line_no           int not null,
  reference         text,
  claim_number      text,
  serial_number     text,
  description       text,
  amount_cents      bigint not null,
  proposed_claim_id uuid,
  matched_claim_id  uuid,
  confidence        numeric(4,3),
  match_status      text not null default 'UNMATCHED' check (match_status in ('UNMATCHED','PROPOSED','MATCHED','IGNORED')),
  decided_by        text,
  decided_at        timestamptz,
  unique (org_id, id),
  unique (memo_id, line_no),
  foreign key (org_id, memo_id) references pm.dlr_credit_memos (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, proposed_claim_id) references pm.warranty_claims (org_id, id) deferrable initially immediate,
  foreign key (org_id, matched_claim_id) references pm.warranty_claims (org_id, id) deferrable initially immediate
);

create or replace function pm.dlr_import_credit_memo(p_location uuid, p_memo_ref text, p_memo_on date, p_lines jsonb,
                                                     p_oem_vendor uuid default null, p_brand text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid; e jsonb; n int := 0; v_claim uuid; v_conf numeric; v_cn text; v_sn text; v_amt bigint;
        v_prop int := 0; v_total bigint := 0;
begin
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 2000 then
    raise exception 'PM_INVALID: a credit memo needs 1–2,000 lines' using errcode = '22023';
  end if;
  if exists (select 1 from pm.dlr_credit_memos m where m.org_id = v_org and m.location_id = p_location and m.memo_ref = btrim(p_memo_ref)) then
    raise exception 'PM_DUPLICATE: credit memo % was already imported', p_memo_ref using errcode = '23505';
  end if;
  insert into pm.dlr_credit_memos (org_id, location_id, oem_vendor_id, brand, memo_ref, memo_on)
  values (v_org, p_location, p_oem_vendor, nullif(upper(btrim(coalesce(p_brand, ''))), ''), btrim(p_memo_ref), coalesce(p_memo_on, current_date))
  returning id into v_id;
  for e in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    v_cn := nullif(upper(btrim(coalesce(e ->> 'claim_number', ''))), '');
    v_sn := nullif(upper(btrim(coalesce(e ->> 'serial_number', ''))), '');
    v_amt := coalesce(pm._x_try_bigint(e ->> 'amount_cents'), 0);
    v_total := v_total + v_amt;
    v_claim := null; v_conf := null;
    if v_cn is not null then
      select c.id into v_claim from pm.warranty_claims c join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
       where c.org_id = v_org and w.location_id = p_location and upper(c.claim_number) = v_cn and c.status in ('SUBMITTED','APPROVED','RETURNED')
       limit 1;
      if v_claim is not null then v_conf := 1.0; end if;
    end if;
    if v_claim is null and v_sn is not null then
      select c.id into v_claim from pm.warranty_claims c join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
        join pm.assets a on a.org_id = c.org_id and a.id = c.asset_id
       where c.org_id = v_org and w.location_id = p_location and upper(a.serial_number) = v_sn and c.status in ('SUBMITTED','APPROVED')
         and v_amt in (c.claimed_cents, coalesce(c.approved_cents, -1))
       order by c.submitted_at limit 1;
      if v_claim is not null then v_conf := 0.8; end if;
    end if;
    insert into pm.dlr_credit_memo_lines (org_id, memo_id, line_no, reference, claim_number, serial_number, description, amount_cents,
                                          proposed_claim_id, confidence, match_status)
    values (v_org, v_id, n, nullif(left(e ->> 'reference', 60), ''), v_cn, v_sn, nullif(left(e ->> 'description', 200), ''), v_amt,
            v_claim, v_conf, case when v_claim is not null then 'PROPOSED' else 'UNMATCHED' end);
    if v_claim is not null then v_prop := v_prop + 1; end if;
  end loop;
  update pm.dlr_credit_memos set total_cents = v_total where id = v_id;
  return jsonb_build_object('memo_id', v_id, 'lines', n, 'proposed', v_prop, 'unmatched', n - v_prop, 'total_cents', v_total);
end $$;

-- Confirm a line against a claim (the proposed one or another), or ignore it (p_claim null).
create or replace function pm.dlr_confirm_credit_match(p_line uuid, p_claim uuid default null, p_ignore boolean default false)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.dlr_credit_memo_lines%rowtype; m pm.dlr_credit_memos%rowtype; c pm.warranty_claims%rowtype; v_claim uuid; v_open int;
begin
  select * into l from pm.dlr_credit_memo_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: memo line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  if l.match_status in ('MATCHED','IGNORED') then raise exception 'PM_CREDIT_DECIDED: this line is already %', lower(l.match_status) using errcode = '22023'; end if;
  select * into m from pm.dlr_credit_memos x where x.org_id = l.org_id and x.id = l.memo_id for update;
  if p_ignore then
    update pm.dlr_credit_memo_lines set match_status = 'IGNORED', decided_by = pm.current_user_id(), decided_at = now() where id = l.id;
  else
    v_claim := coalesce(p_claim, l.proposed_claim_id);
    if v_claim is null then raise exception 'PM_INVALID: pick the claim this credit pays' using errcode = '22023'; end if;
    select wc.* into c from pm.warranty_claims wc join pm.work_orders w on w.org_id = wc.org_id and w.id = wc.work_order_id
     where wc.id = v_claim and wc.org_id = l.org_id and w.location_id = m.location_id for update of wc;
    if c.id is null then raise exception 'PM_INVALID: that claim is not on this company' using errcode = '22023'; end if;
    if c.status not in ('SUBMITTED','APPROVED','PAID') then raise exception 'PM_CLAIM_TRANSITION_INVALID: the claim is %', lower(c.status) using errcode = '22023'; end if;
    if c.status = 'SUBMITTED' then
      perform pm.advance_warranty_claim(c.id, 'APPROVED', least(greatest(l.amount_cents, 0), c.claimed_cents), null, 'Credit memo ' || m.memo_ref);
      update pm.warranty_claims set adjudication = case when l.amount_cents >= c.claimed_cents then 'ACCEPTED' else 'ADJUSTED' end where id = c.id;
    end if;
    update pm.warranty_claims set credited_cents = credited_cents + greatest(l.amount_cents, 0), credit_memo_ref = m.memo_ref where id = c.id;
    update pm.dlr_credit_memo_lines set match_status = 'MATCHED', matched_claim_id = c.id, decided_by = pm.current_user_id(), decided_at = now() where id = l.id;
  end if;
  select count(*) into v_open from pm.dlr_credit_memo_lines x where x.org_id = l.org_id and x.memo_id = l.memo_id and x.match_status in ('UNMATCHED','PROPOSED');
  if v_open = 0 then update pm.dlr_credit_memos set status = 'MATCHED' where id = m.id; end if;
  return jsonb_build_object('line_id', l.id, 'status', case when p_ignore then 'IGNORED' else 'MATCHED' end, 'claim_id', v_claim, 'open_lines', v_open);
end $$;

create or replace view pm.v_dlr_claim_deadlines with (security_invoker = on) as
select c.org_id, w.location_id, c.id as claim_id, c.claim_number, c.status, c.oem_brand, w.number as ro_number, c.job_id, c.work_order_id,
       c.asset_id, a.serial_number, a.make, a.model, c.claimed_cents, c.approved_cents, c.credited_cents, c.adjudication,
       coalesce(c.submit_by, c.filing_deadline) as submit_by,
       coalesce(c.submit_by, c.filing_deadline) - current_date as days_to_submit,
       c.response_due_on, c.retention_until, c.return_tag, c.parts_returned_on,
       (c.status = 'DRAFT' and coalesce(c.submit_by, c.filing_deadline) is not null and coalesce(c.submit_by, c.filing_deadline) <= current_date + 7) as submit_at_risk,
       (c.status = 'SUBMITTED' and c.response_due_on is not null and c.response_due_on < current_date) as response_overdue,
       (c.retention_until is not null and c.retention_until >= current_date and c.parts_returned_on is null) as retain_parts
from pm.warranty_claims c
join pm.work_orders w on w.org_id = c.org_id and w.id = c.work_order_id
left join pm.assets a on a.org_id = c.org_id and a.id = c.asset_id;

-- D5. Unit timeline ---------------------------------------------------------------
create or replace function pm.dlr_unit_timeline(p_unit uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare a pm.assets%rowtype; v_fin boolean; v_out jsonb;
begin
  select * into a from pm.assets x where x.id = p_unit;
  if a.org_id is null or a.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: unit % not found in the caller''s organization', p_unit using errcode = '42501';
  end if;
  v_fin := pm._x_sees('projects.financials', 'view', a.location_id);
  with ev as (
    select coalesce(a.received_on::timestamptz, a.created_at) as at, 'received' as kind,
           format('Received%s', case when a.mfr_invoice_ref is not null then ' on invoice ' || a.mfr_invoice_ref else '' end) as title,
           'assets' as ref_table, a.id as ref_id, jsonb_build_object('condition', a.condition, 'stock_number', a.stock_number) as detail
     where a.received_on is not null
    union all
    select u.created_at, 'cost', format('Cost added: %s', lower(replace(u.cost_type, '_', ' '))), 'dealer_unit_costs', u.id,
           case when v_fin then jsonb_build_object('amount_cents', u.amount_cents) else '{}'::jsonb end
      from pm.dealer_unit_costs u where u.org_id = a.org_id and u.asset_id = a.id
    union all
    select d.stage_entered_at, 'deal', format('Deal %s %s', d.number, lower(d.stage)), 'dealer_deals', d.id, jsonb_build_object('stage', d.stage)
      from pm.dealer_deal_lines l join pm.dealer_deals d on d.org_id = l.org_id and d.id = l.deal_id
     where l.org_id = a.org_id and l.asset_id = a.id
    union all
    select coalesce(t.received_at, t.appraised_at, t.created_at), 'trade', format('Traded in on deal %s', d.number), 'dealer_trades', t.id,
           jsonb_build_object('status', t.status, 'meter', t.meter_reading)
      from pm.dealer_trades t join pm.dealer_deals d on d.org_id = t.org_id and d.id = t.deal_id
     where t.org_id = a.org_id and (t.asset_id = a.id or t.received_asset_id = a.id)
    union all
    select coalesce(w.checked_in_at, w.created_at), case w.kind when 'PDI' then 'pdi' else 'service' end,
           format('%s %s: %s', case w.kind when 'PDI' then 'PDI' else 'RO' end, w.number, w.summary), 'work_orders', w.id,
           jsonb_build_object('status', w.status, 'meter_in', w.meter_in, 'complaint', w.complaint, 'closed_at', w.closed_at)
      from pm.work_orders w where w.org_id = a.org_id and w.asset_id = a.id
    union all
    select coalesce(c.submitted_at, c.created_at), 'warranty', format('Warranty claim %s %s', coalesce(c.claim_number, ''), lower(c.status)),
           'warranty_claims', c.id, jsonb_build_object('status', c.status, 'brand', c.oem_brand, 'defect_code', c.defect_code)
      from pm.warranty_claims c where c.org_id = a.org_id and c.asset_id = a.id
    union all
    select coalesce(r.checked_out_at, lower(r.reserved)), 'rental', format('Rental %s %s', r.number, lower(r.status)), 'rental_contracts', r.id,
           jsonb_build_object('status', r.status, 'meter_out', r.meter_out, 'meter_in', r.meter_in)
      from pm.rental_contracts r where r.org_id = a.org_id and r.asset_id = a.id
    union all
    select x.created_at, 'activity', coalesce(x.summary, x.verb), 'activity', x.id, jsonb_build_object('verb', x.verb)
      from pm.activity x where x.org_id = a.org_id and x.subject_table = 'assets' and x.subject_id = a.id
       and x.verb in ('unit.transferred','unit.status','unit.registered','unit.ordered','unit.received')
    union all
    select coalesce(a.unit_delivered_on::timestamptz, a.updated_at), 'delivered', 'Delivered to the customer', 'assets', a.id, '{}'::jsonb
     where a.unit_delivered_on is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'title', title, 'ref_table', ref_table, 'ref_id', ref_id, 'detail', detail)
                            order by at desc), '[]') into v_out from ev;
  return jsonb_build_object('unit', jsonb_build_object('id', a.id, 'serial_number', a.serial_number, 'stock_number', a.stock_number, 'make', a.make,
                              'model', a.model, 'model_year', a.model_year, 'status', a.unit_status, 'condition', a.condition, 'meter', a.meter_reading,
                              'customer_id', a.customer_id),
                            'events', v_out);
end $$;

-- D6. Deal desk: finance programs, fee schedule, payment scenarios, worksheet ----
create table if not exists pm.dlr_finance_programs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  code                 text not null check (char_length(btrim(code)) between 1 and 40),
  name                 text not null check (char_length(btrim(name)) between 1 and 120),
  kind                 text not null check (kind in ('PROMO_RATE','STANDARD_RATE','CASH_REBATE')),
  brand                text,
  lender_vendor_id     uuid references core.vendors(id),
  oem_vendor_id        uuid references core.vendors(id),
  apr                  numeric(7,5) not null default 0 check (apr >= 0 and apr <= 1),
  term_months          int check (term_months is null or term_months between 1 and 120),
  subvention_pct       numeric(6,5) not null default 0 check (subvention_pct >= 0 and subvention_pct <= 0.5),   -- dealer buy-down fee
  rebate_cents         bigint not null default 0 check (rebate_cents >= 0),
  min_amount_cents     bigint not null default 0 check (min_amount_cents >= 0),
  categories           text[] not null default '{}',
  model_pattern        text,                                                  -- ILIKE pattern on the unit model
  starts_on            date,
  ends_on              date,
  claim_deadline_days  int check (claim_deadline_days is null or claim_deadline_days >= 0),
  is_active            boolean not null default true,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (kind = 'CASH_REBATE' or term_months is not null)
);

create table if not exists pm.dlr_fee_schedule (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  code         text not null check (code ~ '^[A-Z0-9_]{2,24}$'),
  label        text not null check (char_length(btrim(label)) between 1 and 80),
  kind         text not null check (kind in ('DOC','SETUP','FREIGHT','PDI','ENVIRONMENTAL','OTHER')),
  amount_cents bigint not null check (amount_cents >= 0),
  cost_cents   bigint not null default 0 check (cost_cents >= 0),
  taxable      boolean not null default true,
  categories   text[] not null default '{}',
  conditions   text[] not null default '{}',     -- NEW / USED …; empty = every unit
  auto_apply   boolean not null default true,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

-- Programs a deal's units qualify for today (category / model / brand / date / amount).
create or replace function pm._dlr_eligible_programs(p_deal uuid) returns setof pm.dlr_finance_programs
language sql stable security definer
set search_path = pm, core, public
as $$
  select f.* from pm.dlr_finance_programs f
  join pm.dealer_deals d on d.id = p_deal and d.org_id = f.org_id and d.location_id = f.location_id
  where f.is_active and (f.starts_on is null or f.starts_on <= current_date) and (f.ends_on is null or f.ends_on >= current_date)
    and exists (select 1 from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
                 where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
                   and (cardinality(f.categories) = 0 or upper(coalesce(a.category, '')) = any (array(select upper(c) from unnest(f.categories) c)))
                   and (f.model_pattern is null or a.model ilike f.model_pattern)
                   and (f.brand is null or upper(coalesce(a.make, '')) = upper(f.brand)))
  order by f.kind, f.apr, f.code
$$;

-- Monthly payment side by side: cash, then each eligible program. Subvention (dealer cost) and dealer
-- net only with projects.financials at the store.
create or replace function pm.dlr_payment_scenarios(p_deal uuid, p_down_cents bigint default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; t jsonb; f pm.dlr_finance_programs%rowtype; v_fin boolean; v_bal bigint; v_amt bigint; v_sub bigint; v_out jsonb := '[]';
        v_front bigint; v_std pm.dlr_finance_programs%rowtype;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if coalesce(p_down_cents, 0) < 0 then raise exception 'PM_INVALID: down payment must be ≥ 0' using errcode = '22023'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', d.location_id);
  t := pm.dealer_deal_totals(d.id);
  v_bal := greatest(coalesce((t ->> 'balance_due_estimate_cents')::bigint, 0), 0);
  v_front := (t ->> 'front_gross_cents')::bigint;
  v_out := v_out || jsonb_build_object('kind', 'CASH', 'code', 'CASH', 'name', 'Cash', 'amount_due_cents', v_bal);
  select * into v_std from pm._dlr_eligible_programs(d.id) x where x.kind = 'STANDARD_RATE' order by x.apr limit 1;
  for f in select * from pm._dlr_eligible_programs(d.id) loop
    if f.kind = 'CASH_REBATE' then
      v_amt := greatest(v_bal - coalesce(p_down_cents, 0) - f.rebate_cents, 0);
      v_out := v_out || jsonb_build_object('kind', f.kind, 'program_id', f.id, 'code', f.code, 'name', f.name, 'rebate_cents', f.rebate_cents,
        'amount_financed_cents', case when v_std.id is not null then v_amt end, 'apr', v_std.apr, 'term_months', v_std.term_months,
        'monthly_cents', case when v_std.id is not null and v_amt > 0 then pm.fs_monthly_payment(v_amt, v_std.apr, v_std.term_months) end,
        'cash_due_cents', greatest(v_bal - f.rebate_cents, 0));
      continue;
    end if;
    v_amt := greatest(v_bal - coalesce(p_down_cents, 0), 0);
    continue when v_amt < f.min_amount_cents or v_amt = 0;
    v_sub := round(v_amt * f.subvention_pct)::bigint;
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object('kind', f.kind, 'program_id', f.id, 'code', f.code, 'name', f.name,
      'lender_vendor_id', f.lender_vendor_id, 'apr', f.apr, 'term_months', f.term_months, 'amount_financed_cents', v_amt,
      'monthly_cents', pm.fs_monthly_payment(v_amt, f.apr, f.term_months),
      'total_of_payments_cents', pm.fs_monthly_payment(v_amt, f.apr, f.term_months) * f.term_months,
      'subvention_cents', case when v_fin then v_sub end,
      'dealer_net_front_cents', case when v_fin then v_front - v_sub end));
  end loop;
  return jsonb_build_object('deal_id', d.id, 'balance_due_cents', v_bal, 'down_cents', coalesce(p_down_cents, 0), 'scenarios', v_out,
                            'amounts_visible', v_fin);
end $$;

-- Put a program on the deal (QUOTE / WRITTEN). A rate program sets the finance terms and the
-- subvention fee; a cash rebate adds a REBATE line carrying the program code (DEAL_SOLD program id).
create or replace function pm.dlr_apply_program(p_deal uuid, p_program uuid, p_down_cents bigint default 0)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; f pm.dlr_finance_programs%rowtype; t jsonb; v_amt bigint; v_line int;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage not in ('QUOTE','WRITTEN') then raise exception 'PM_DEAL_LOCKED: deal % is %; reopen it to change terms', d.number, d.stage using errcode = '55000'; end if;
  select * into f from pm._dlr_eligible_programs(d.id) x where x.id = p_program;
  if f.id is null then raise exception 'PM_PROGRAM_NOT_ELIGIBLE: that program does not apply to this deal today' using errcode = '22023'; end if;
  if f.kind = 'CASH_REBATE' then
    if exists (select 1 from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'REBATE' and l.program_ref = f.code) then
      raise exception 'PM_DUPLICATE: rebate % is already on the deal', f.code using errcode = '23505';
    end if;
    select coalesce(max(l.line_no), 0) + 1 into v_line from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id;
    insert into pm.dealer_deal_lines (org_id, deal_id, line_no, line_type, description, qty, unit_price_cents, taxable, program_ref, oem_vendor_id, rebate_treatment, sort)
    values (d.org_id, d.id, v_line, 'REBATE', f.name, 1, f.rebate_cents, false, f.code, f.oem_vendor_id, 'PASS_THROUGH', 900 + v_line);
  else
    t := pm.dealer_deal_totals(d.id);
    v_amt := greatest(coalesce((t ->> 'balance_due_estimate_cents')::bigint, 0) - coalesce(p_down_cents, 0), 0);
    if v_amt < f.min_amount_cents then raise exception 'PM_PROGRAM_NOT_ELIGIBLE: % needs at least % cents financed', f.code, f.min_amount_cents using errcode = '22023'; end if;
    update pm.dealer_deals set finance_type = 'RETAIL_FINANCE', finance_vendor_id = coalesce(f.lender_vendor_id, finance_vendor_id),
           amount_financed_cents = v_amt, subvention_cents = round(v_amt * f.subvention_pct)::bigint,
           finance_ref = 'PROGRAM:' || f.code || ' ' || to_char(f.apr * 100, 'FM990.00') || '%/' || f.term_months
     where id = d.id;
  end if;
  perform pm.log_activity(d.org_id, d.location_id, null, 'deal.program', 'dealer_deals', d.id, format('Program %s on %s', f.code, d.number),
    jsonb_build_object('program', f.code, 'kind', f.kind));
  return jsonb_build_object('deal_id', d.id, 'program', f.code, 'kind', f.kind);
end $$;

-- Doc / setup / freight fees from the store schedule for the deal's units (once per code).
create or replace function pm.dlr_apply_standard_fees(p_deal uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; f pm.dlr_fee_schedule%rowtype; n int := 0; v_line int;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  if d.stage not in ('QUOTE','WRITTEN') then raise exception 'PM_DEAL_LOCKED: deal % is %', d.number, d.stage using errcode = '55000'; end if;
  for f in select x.* from pm.dlr_fee_schedule x
            where x.org_id = d.org_id and x.location_id = d.location_id and x.is_active and x.auto_apply
              and exists (select 1 from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
                           where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT'
                             and (cardinality(x.categories) = 0 or upper(coalesce(a.category, '')) = any (array(select upper(c) from unnest(x.categories) c)))
                             and (cardinality(x.conditions) = 0 or coalesce(a.condition, '') = any (x.conditions)))
              and not exists (select 1 from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id and l.program_ref = 'FEE:' || x.code)
            order by x.kind, x.code loop
    select coalesce(max(l.line_no), 0) + 1 into v_line from pm.dealer_deal_lines l where l.org_id = d.org_id and l.deal_id = d.id;
    insert into pm.dealer_deal_lines (org_id, deal_id, line_no, line_type, description, qty, unit_price_cents, cost_cents, taxable, program_ref, sort)
    values (d.org_id, d.id, v_line, 'FEE', f.label, 1, f.amount_cents, f.cost_cents, f.taxable, 'FEE:' || f.code, 500 + v_line);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The desk worksheet: totals, floor check, approval state (1113 engine), commission base and the
-- blockers before delivery. Gross / cost keys stripped without projects.financials.
create or replace function pm.dlr_deal_worksheet(p_deal uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; s pm.dealer_settings%rowtype; t jsonb; v_fin boolean; v_below boolean; v_pct numeric; v_appr jsonb; v_out jsonb;
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  s := pm.dealer_settings_row(d.org_id, d.location_id);
  t := pm.dealer_deal_totals(d.id);
  v_pct := (t ->> 'front_gross_pct')::numeric;
  v_below := (v_pct is not null and v_pct < s.margin_floor_pct) or (t ->> 'front_gross_cents')::bigint < s.min_front_gross_cents;
  begin
    v_appr := pm.approval_object_status('dealer_deal', d.id);
  exception when others then v_appr := null;
  end;
  v_fin := pm._x_sees('projects.financials', 'view', d.location_id);
  v_out := jsonb_build_object('deal_id', d.id, 'number', d.number, 'stage', d.stage, 'finance_type', d.finance_type, 'finance_ref', d.finance_ref,
    'totals', t, 'margin_floor_pct', s.margin_floor_pct, 'below_floor', v_below,
    'commission_base_cents', (t ->> 'total_gross_cents')::bigint,
    'over_allowance_cents', (t ->> 'over_allowance_cents')::bigint,
    'approval', v_appr, 'delivery', pm.dlr_delivery_blockers(d.id), 'amounts_visible', v_fin);
  if not v_fin then
    v_out := v_out || jsonb_build_object('totals', pm.access_strip_keys(t, pm.access_deal_money_keys()), 'margin_floor_pct', null,
                                         'commission_base_cents', null, 'over_allowance_cents', null, 'below_floor', v_below);
  end if;
  return v_out;
end $$;

-- D7. Sold-out-of-trust: what blocks delivery, before the click; GM list of sold-unpaid units.
create or replace function pm.dlr_delivery_blockers(p_deal uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.dealer_deals%rowtype; s pm.dealer_settings%rowtype; v_missing jsonb; v_payoff jsonb; v_notsold jsonb; v_block jsonb := '[]'; v_warn jsonb := '[]';
begin
  select * into d from pm.dealer_deals x where x.id = p_deal;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: deal % not found in the caller''s organization', p_deal using errcode = '42501';
  end if;
  s := pm.dealer_settings_row(d.org_id, d.location_id);
  select coalesce(jsonb_agg(e ->> 'label'), '[]') into v_missing from jsonb_array_elements(d.delivery_checklist) e
   where coalesce((e ->> 'required')::boolean, false) and not coalesce((e ->> 'done')::boolean, false) and e ->> 'key' <> 'pdi_complete';
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', a.id, 'stock_number', a.stock_number, 'serial_number', a.serial_number,
                                               'payoff_due_on', a.payoff_due_on, 'floor_status', a.floor_status)), '[]')
    into v_payoff
    from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
   where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT' and a.floored and coalesce(a.payoff_cents, 0) > 0 and not a.payoff_scheduled;
  select coalesce(jsonb_agg(coalesce(a.stock_number, a.serial_number)), '[]') into v_notsold
    from pm.dealer_deal_lines l join pm.assets a on a.org_id = l.org_id and a.id = l.asset_id
   where l.org_id = d.org_id and l.deal_id = d.id and l.line_type = 'UNIT' and d.stage = 'FUNDED' and (a.deal_id is distinct from d.id or a.unit_status <> 'SOLD');
  if d.stage <> 'FUNDED' then v_block := v_block || jsonb_build_object('code', 'NOT_FUNDED', 'message', format('The deal is %s; it delivers once funded.', lower(d.stage))); end if;
  if jsonb_array_length(v_missing) > 0 then v_block := v_block || jsonb_build_object('code', 'CHECKLIST', 'items', v_missing); end if;
  if jsonb_array_length(v_notsold) > 0 then v_block := v_block || jsonb_build_object('code', 'UNIT_NOT_SOLD', 'items', v_notsold); end if;
  if jsonb_array_length(v_payoff) > 0 and s.payoff_guard = 'BLOCK' then
    v_block := v_block || jsonb_build_object('code', 'PAYOFF_NOT_SCHEDULED', 'units', v_payoff, 'message', 'Merit Books has not scheduled the floor-plan payoff.');
  elsif jsonb_array_length(v_payoff) > 0 and s.payoff_guard = 'WARN' then
    v_warn := v_warn || jsonb_build_object('code', 'PAYOFF_NOT_SCHEDULED', 'units', v_payoff, 'ack_roles', to_jsonb(s.payoff_ack_roles),
                                           'message', 'Delivering before the payoff is scheduled sells the unit out of trust; a manager acknowledges it.');
  end if;
  return jsonb_build_object('can_deliver', jsonb_array_length(v_block) = 0, 'blockers', v_block, 'warnings', v_warn, 'payoff_guard', s.payoff_guard);
end $$;

create or replace view pm.v_dlr_sold_unpaid with (security_invoker = on) as
select a.org_id, a.location_id, a.id as unit_id, a.stock_number, a.serial_number, a.make, a.model, a.model_year, a.unit_status,
       a.unit_sold_on, a.unit_delivered_on, a.floor_status, a.payoff_due_on, a.deal_id,
       greatest(current_date - coalesce(a.unit_delivered_on, a.unit_sold_on, current_date), 0) as days_unpaid
from pm.assets a
where a.unit_status in ('SOLD','DELIVERED') and a.floored and not a.payoff_scheduled
  and coalesce(a.floor_status, '') in ('FLOORED','SOLD_UNPAID','IN_DEFAULT');

-- D8. Rentals: inspections out / in, damage compare, charges ----------------------
create table if not exists pm.dlr_rental_settings (
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id               uuid not null references core.locations(id),
  fuel_cents_per_eighth     bigint not null default 1500 check (fuel_cents_per_eighth >= 0),
  cleaning_cents            bigint not null default 7500 check (cleaning_cents >= 0),
  damage_prices             jsonb not null default '{"SCRATCH":2500,"DENT":7500,"CRACK":15000,"BROKEN":25000,"MISSING":10000}'
                              check (jsonb_typeof(damage_prices) = 'object'),
  hours_per_day_allowance   numeric(5,2) not null default 8 check (hours_per_day_allowance >= 0),
  overtime_cents_per_hour   bigint not null default 0 check (overtime_cents_per_hour >= 0),
  zones                     text[] not null default array['FRONT','REAR','LEFT','RIGHT','TOP','CAB','ATTACHMENT','TIRES_TRACKS'],
  updated_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (org_id, location_id)
);

create table if not exists pm.dlr_rental_inspections (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  contract_id         uuid not null,
  phase               text not null check (phase in ('OUT','IN')),
  meter               numeric(12,2) check (meter is null or meter >= 0),
  fuel_eighths        int check (fuel_eighths is null or fuel_eighths between 0 and 8),
  clean               boolean,
  zones               jsonb not null default '[]' check (jsonb_typeof(zones) = 'array'),
  photo_document_ids  uuid[] not null default '{}',
  notes               text,
  inspected_by        text default pm.current_user_id(),
  inspected_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (contract_id, phase),
  foreign key (org_id, contract_id) references pm.rental_contracts (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm._dlr_damage_rank(p text) returns int
language sql immutable
as $$ select case upper(coalesce(p, 'OK')) when 'OK' then 0 when 'SCRATCH' then 1 when 'DENT' then 2 when 'CRACK' then 3 when 'BROKEN' then 4 when 'MISSING' then 5 else 0 end $$;

create or replace function pm.dlr_record_rental_inspection(p_contract uuid, p_phase text, p_meter numeric, p_fuel_eighths int, p_clean boolean,
                                                           p_zones jsonb default '[]', p_photos uuid[] default '{}', p_notes text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; v_id uuid; z jsonb;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if p_phase not in ('OUT','IN') then raise exception 'PM_INVALID: phase OUT or IN' using errcode = '22023'; end if;
  if p_phase = 'OUT' and c.status not in ('RESERVED','OUT') then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  if p_phase = 'IN' and c.status not in ('OUT','RETURNED') then raise exception 'PM_RENTAL_TRANSITION_INVALID: % is %', c.number, c.status using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_zones, '[]')) <> 'array' or jsonb_array_length(coalesce(p_zones, '[]')) > 40 then
    raise exception 'PM_INVALID: zones must be an array (at most 40)' using errcode = '22023';
  end if;
  for z in select * from jsonb_array_elements(coalesce(p_zones, '[]')) loop
    if upper(coalesce(z ->> 'condition', 'OK')) not in ('OK','SCRATCH','DENT','CRACK','BROKEN','MISSING') or nullif(btrim(coalesce(z ->> 'zone', '')), '') is null then
      raise exception 'PM_INVALID: each zone needs a name and a condition (OK, SCRATCH, DENT, CRACK, BROKEN, MISSING)' using errcode = '22023';
    end if;
  end loop;
  if exists (select 1 from unnest(coalesce(p_photos, '{}')) d where not exists (select 1 from public.documents x where x.id = d and x.org_id = c.org_id)) then
    raise exception 'PM_INVALID: a photo is not a document of this organization' using errcode = '22023';
  end if;
  insert into pm.dlr_rental_inspections (org_id, contract_id, phase, meter, fuel_eighths, clean, zones, photo_document_ids, notes)
  values (c.org_id, c.id, p_phase, p_meter, p_fuel_eighths, p_clean, coalesce(p_zones, '[]'), coalesce(p_photos, '{}'), nullif(left(p_notes, 2000), ''))
  on conflict (contract_id, phase) do update set meter = excluded.meter, fuel_eighths = excluded.fuel_eighths, clean = excluded.clean,
     zones = excluded.zones, photo_document_ids = excluded.photo_document_ids, notes = excluded.notes,
     inspected_by = pm.current_user_id(), inspected_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Compare in vs out: new damage per zone (worse condition than out), fuel short, cleaning, meter
-- overtime against the daily allowance; suggested charges from the store price list.
create or replace function pm.dlr_rental_damage_compare(p_contract uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype; o pm.dlr_rental_inspections%rowtype; i pm.dlr_rental_inspections%rowtype; s pm.dlr_rental_settings%rowtype;
        v_new jsonb := '[]'; v_damage bigint := 0; v_fuel bigint := 0; v_clean bigint := 0; v_over numeric := 0; v_ot bigint := 0; z record; v_days int;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  select * into o from pm.dlr_rental_inspections x where x.org_id = c.org_id and x.contract_id = c.id and x.phase = 'OUT';
  select * into i from pm.dlr_rental_inspections x where x.org_id = c.org_id and x.contract_id = c.id and x.phase = 'IN';
  select * into s from pm.dlr_rental_settings x where x.org_id = c.org_id and x.location_id = c.location_id;
  if s.org_id is null then
    s.fuel_cents_per_eighth := 1500; s.cleaning_cents := 7500; s.hours_per_day_allowance := 8; s.overtime_cents_per_hour := 0;
    s.damage_prices := '{"SCRATCH":2500,"DENT":7500,"CRACK":15000,"BROKEN":25000,"MISSING":10000}';
  end if;
  if i.id is null then return jsonb_build_object('ready', false, 'reason', 'no check-in inspection yet', 'has_out', o.id is not null); end if;
  for z in
    select upper(btrim(iz ->> 'zone')) as zone, upper(coalesce(iz ->> 'condition', 'OK')) as cond_in, iz ->> 'note' as note,
           coalesce((select upper(coalesce(oz ->> 'condition', 'OK')) from jsonb_array_elements(coalesce(o.zones, '[]')) oz
                      where upper(btrim(oz ->> 'zone')) = upper(btrim(iz ->> 'zone')) limit 1), 'OK') as cond_out
      from jsonb_array_elements(i.zones) iz
  loop
    if pm._dlr_damage_rank(z.cond_in) > pm._dlr_damage_rank(z.cond_out) then
      v_new := v_new || jsonb_build_object('zone', z.zone, 'out', z.cond_out, 'in', z.cond_in, 'note', z.note,
                                           'charge_cents', coalesce((s.damage_prices ->> z.cond_in)::bigint, 0));
      v_damage := v_damage + coalesce((s.damage_prices ->> z.cond_in)::bigint, 0);
    end if;
  end loop;
  if o.fuel_eighths is not null and i.fuel_eighths is not null and i.fuel_eighths < o.fuel_eighths then
    v_fuel := (o.fuel_eighths - i.fuel_eighths) * s.fuel_cents_per_eighth;
  end if;
  if coalesce(o.clean, true) and i.clean = false then v_clean := s.cleaning_cents; end if;
  if c.checked_out_at is not null and coalesce(i.meter, c.meter_in) is not null and coalesce(o.meter, c.meter_out) is not null then
    v_days := greatest(1, ceil(extract(epoch from (coalesce(c.checked_in_at, i.inspected_at) - c.checked_out_at)) / 86400.0)::int);
    v_over := greatest(coalesce(i.meter, c.meter_in) - coalesce(o.meter, c.meter_out) - v_days * s.hours_per_day_allowance, 0);
    v_ot := round(v_over * s.overtime_cents_per_hour)::bigint;
  end if;
  return jsonb_build_object('ready', true, 'has_out', o.id is not null, 'new_damage', v_new, 'damage_cents', v_damage,
    'fuel_short_eighths', greatest(coalesce(o.fuel_eighths, 0) - coalesce(i.fuel_eighths, 0), 0), 'fuel_cents', v_fuel,
    'cleaning_cents', v_clean, 'overtime_hours', v_over, 'overtime_cents', v_ot,
    'suggested_total_cents', v_damage + v_fuel + v_clean + v_ot,
    'photos_out', to_jsonb(coalesce(o.photo_document_ids, '{}')), 'photos_in', to_jsonb(i.photo_document_ids));
end $$;

-- Put the reviewed charges on the returned contract before the final bill (pm.bill_rental).
create or replace function pm.dlr_apply_rental_charges(p_contract uuid, p_damage_cents bigint, p_fuel_cents bigint, p_cleaning_cents bigint,
                                                       p_notes text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.rental_contracts%rowtype;
begin
  select * into c from pm.rental_contracts x where x.id = p_contract for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: rental contract % not found in the caller''s organization', p_contract using errcode = '42501';
  end if;
  if c.status <> 'RETURNED' then raise exception 'PM_RENTAL_TRANSITION_INVALID: charges go on a returned contract (% is %)', c.number, c.status using errcode = '22023'; end if;
  if least(coalesce(p_damage_cents, 0), coalesce(p_fuel_cents, 0), coalesce(p_cleaning_cents, 0)) < 0 then
    raise exception 'PM_INVALID: charges must be ≥ 0' using errcode = '22023';
  end if;
  update pm.rental_contracts set damage_cents = coalesce(p_damage_cents, 0), fuel_cents = coalesce(p_fuel_cents, 0),
         cleaning_cents = coalesce(p_cleaning_cents, 0), damage_notes = coalesce(nullif(left(p_notes, 2000), ''), damage_notes)
   where id = c.id;
  perform pm.log_activity(c.org_id, c.location_id, null, 'rental.charges', 'rental_contracts', c.id, format('Return charges on %s', c.number),
    jsonb_build_object('damage_cents', p_damage_cents, 'fuel_cents', p_fuel_cents, 'cleaning_cents', p_cleaning_cents));
  return c.id;
end $$;

-- D9. Tech clock per RO line + productivity -------------------------------------
create table if not exists pm.dlr_tech_punches (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id),
  employee_id         uuid not null references core.employees(id),
  kind                text not null default 'LINE' check (kind in ('LINE','SHOP','WAITING_PARTS','TRAINING','CLEANUP','IDLE')),
  job_id              uuid,
  work_order_id       uuid,
  work_order_line_id  uuid,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  source              text not null default 'PHONE' check (source in ('PHONE','KIOSK','ADJUSTED')),
  time_entry_id       uuid,
  notes               text,
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  check (ended_at is null or ended_at >= started_at),
  check ((kind = 'LINE') = (work_order_line_id is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_dlr_one_open_punch on pm.dlr_tech_punches (org_id, employee_id) where ended_at is null;
create index if not exists pm_dlr_punch_line_idx on pm.dlr_tech_punches (org_id, work_order_line_id);
create index if not exists pm_dlr_punch_emp_idx on pm.dlr_tech_punches (org_id, location_id, employee_id, started_at);

-- The caller's employee row (first), or the named one when the caller may clock others.
create or replace function pm._dlr_punch_employee(p_location uuid, p_employee uuid) returns uuid
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_me uuid;
begin
  select x into v_me from pm.my_employee_ids() x limit 1;
  if p_employee is null or p_employee = v_me then
    if v_me is null then raise exception 'PM_NO_EMPLOYEE: your seat is not linked to an employee record' using errcode = '22023'; end if;
    return v_me;
  end if;
  if not (pm.access_can_location('projects.dispatch', 'edit', p_location) or pm.access_can_location('projects.time', 'approve', p_location)) then
    raise exception 'PM_FORBIDDEN: clocking another technician needs projects.dispatch:edit or projects.time:approve' using errcode = '42501';
  end if;
  if not exists (select 1 from core.employees e where e.id = p_employee and e.org_id = public.get_org_id()) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: %', p_employee using errcode = 'P0002';
  end if;
  return p_employee;
end $$;

-- Close a punch at p_end (default now); a LINE punch becomes a SUBMITTED time entry on the RO's job.
create or replace function pm._dlr_close_punch(p_punch uuid, p_end timestamptz default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dlr_tech_punches%rowtype; v_end timestamptz; v_hours numeric; v_te uuid; l pm.work_order_lines%rowtype;
begin
  select * into p from pm.dlr_tech_punches x where x.id = p_punch for update;
  if p.ended_at is not null then return jsonb_build_object('punch_id', p.id, 'already_closed', true); end if;
  v_end := coalesce(p_end, now());
  if v_end < p.started_at then raise exception 'PM_INVALID: the punch cannot end before it started' using errcode = '22023'; end if;
  v_hours := round((extract(epoch from (v_end - p.started_at)) / 3600.0)::numeric, 2);
  if v_hours > 24 then
    raise exception 'PM_PUNCH_TOO_LONG: this punch has been open % hours; a service manager closes it with the real end time', v_hours using errcode = 'P0001';
  end if;
  update pm.dlr_tech_punches set ended_at = v_end, source = case when p_end is not null and p_end < now() - interval '5 minutes' then 'ADJUSTED' else source end
   where id = p.id;
  if p.kind = 'LINE' and v_hours > 0 then
    select * into l from pm.work_order_lines x where x.id = p.work_order_line_id;
    insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, pay_type, billable, notes, approval_state, work_order_id, source_ref, created_by)
    values (p.org_id, p.job_id, p.employee_id, (p.started_at)::date, v_hours, 'REG', l.pay_type = 'CUSTOMER',
            left(format('RO line: %s', l.description), 300), 'SUBMITTED', p.work_order_id, 'pm:punch:' || p.id::text, pm.current_user_id())
    returning id into v_te;
    update pm.dlr_tech_punches set time_entry_id = v_te where id = p.id;
  end if;
  return jsonb_build_object('punch_id', p.id, 'hours', v_hours, 'time_entry_id', v_te);
end $$;

-- Clock on to an RO line (closes the tech's open punch first). Several techs may work one line.
create or replace function pm.dlr_clock_on(p_line uuid, p_employee uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype; v_emp uuid; v_open uuid; v_closed jsonb; v_id uuid;
begin
  select * into l from pm.work_order_lines x where x.id = p_line;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RO line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if l.kind not in ('LABOR','SERVICE','SUBLET','MISC') then raise exception 'PM_INVALID: clock on to a labor line, not a % line', lower(l.kind) using errcode = '22023'; end if;
  v_emp := pm._dlr_punch_employee(w.location_id, p_employee);
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = l.org_id and x.employee_id = v_emp and x.ended_at is null for update;
  if v_open is not null then v_closed := pm._dlr_close_punch(v_open); end if;
  insert into pm.dlr_tech_punches (org_id, location_id, employee_id, kind, job_id, work_order_id, work_order_line_id, source)
  values (l.org_id, w.location_id, v_emp, 'LINE', w.job_id, w.id, l.id, case when p_employee is null then 'PHONE' else 'KIOSK' end)
  returning id into v_id;
  if w.status in ('NEW','SCHEDULED','DISPATCHED','ON_HOLD') then
    update pm.work_orders set status = 'IN_PROGRESS', started_at = coalesce(started_at, now()), hold_reason = null where id = w.id;
  end if;
  return jsonb_build_object('punch_id', v_id, 'closed', v_closed, 'work_order', w.number);
end $$;

-- Clock off (the open punch); optional end time for a manager correcting a forgotten punch.
create or replace function pm.dlr_clock_off(p_location uuid, p_employee uuid default null, p_end_at timestamptz default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_emp uuid; v_open uuid;
begin
  v_emp := pm._dlr_punch_employee(p_location, p_employee);
  -- A corrected end time is a manager's correction whoever the punch belongs to (security review L1:
  -- a tech naming their own employee id no longer skips it).
  if p_end_at is not null and not pm.access_can_location('projects.dispatch', 'edit', p_location) then
    raise exception 'PM_FORBIDDEN: a corrected end time needs projects.dispatch:edit' using errcode = '42501';
  end if;
  if p_end_at is not null and p_end_at > now() + interval '1 minute' then
    raise exception 'PM_INVALID: the end time cannot be in the future' using errcode = '22023';
  end if;
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = v_org and x.employee_id = v_emp and x.ended_at is null;
  if v_open is null then return jsonb_build_object('open', false); end if;
  return pm._dlr_close_punch(v_open, p_end_at) || jsonb_build_object('open', true);
end $$;

-- Indirect time (shop, waiting on parts, training, cleanup): attendance, never a job.
create or replace function pm.dlr_clock_indirect(p_location uuid, p_kind text, p_employee uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_emp uuid; v_open uuid; v_closed jsonb; v_id uuid;
begin
  if p_kind not in ('SHOP','WAITING_PARTS','TRAINING','CLEANUP','IDLE') then raise exception 'PM_INVALID: kind %', p_kind using errcode = '22023'; end if;
  v_emp := pm._dlr_punch_employee(p_location, p_employee);
  select x.id into v_open from pm.dlr_tech_punches x where x.org_id = v_org and x.employee_id = v_emp and x.ended_at is null;
  if v_open is not null then v_closed := pm._dlr_close_punch(v_open); end if;
  insert into pm.dlr_tech_punches (org_id, location_id, employee_id, kind) values (v_org, p_location, v_emp, p_kind) returning id into v_id;
  return jsonb_build_object('punch_id', v_id, 'closed', v_closed);
end $$;

-- Flagged (flat-rate) hours on a line, entered at completion.
create or replace function pm.dlr_flag_line(p_line uuid, p_flag_hours numeric)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.work_order_lines%rowtype; w pm.work_orders%rowtype;
begin
  select * into l from pm.work_order_lines x where x.id = p_line for update;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: RO line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = l.org_id and x.id = l.work_order_id;
  if w.status in ('CLOSED','CANCELLED') then raise exception 'PM_WO_LOCKED: % is %', w.number, lower(w.status) using errcode = '55000'; end if;
  if p_flag_hours is null or p_flag_hours < 0 or p_flag_hours > 200 then raise exception 'PM_INVALID: flagged hours 0–200' using errcode = '22023'; end if;
  update pm.work_order_lines set flag_hours = round(p_flag_hours, 2) where id = l.id;
  return l.id;
end $$;

-- Flagged vs clocked per tech for a period. Rows: every tech for holders of dispatch:view,
-- time:approve or reports:view at the store; otherwise the caller's own row only.
create or replace function pm.dlr_tech_board(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_from timestamptz := coalesce(p_from, current_date)::timestamptz;
        v_to timestamptz := (coalesce(p_to, coalesce(p_from, current_date)) + 1)::timestamptz; v_all boolean; v_out jsonb;
begin
  v_all := pm.access_can_location('projects.dispatch', 'view', p_location) or pm.access_can_location('projects.time', 'approve', p_location)
        or pm.access_can_location('projects.reports', 'view', p_location);
  with pun as (
    select p.*, extract(epoch from (least(coalesce(p.ended_at, now()), v_to) - greatest(p.started_at, v_from))) / 3600.0 as hrs
      from pm.dlr_tech_punches p
     where p.org_id = v_org and p.location_id = p_location and p.started_at < v_to and coalesce(p.ended_at, now()) > v_from
       and (v_all or p.employee_id in (select pm.my_employee_ids()))
  ), line_tot as (   -- every tech's clocked time on the line, all time (for the flag share)
    select x.work_order_line_id, sum(extract(epoch from (coalesce(x.ended_at, now()) - x.started_at)) / 3600.0) as all_hrs
      from pm.dlr_tech_punches x where x.org_id = v_org and x.work_order_line_id in (select work_order_line_id from pun where kind = 'LINE')
     group by 1
  ), per_line as (
    select p.employee_id, p.work_order_line_id, sum(p.hrs) as hrs, sum(extract(epoch from (coalesce(p.ended_at, now()) - p.started_at)) / 3600.0) as mine_all
      from pun p where p.kind = 'LINE' group by 1, 2
  ), flagged as (
    select pl.employee_id,
           sum(coalesce(l.flag_hours, 0) * case when lt.all_hrs > 0 then pl.mine_all / lt.all_hrs else 0 end) as flag_hrs,
           count(*) filter (where l.flag_hours is not null and lt.all_hrs > l.flag_hours * 1.25) as lines_over
      from per_line pl join pm.work_order_lines l on l.org_id = v_org and l.id = pl.work_order_line_id
      join line_tot lt on lt.work_order_line_id = pl.work_order_line_id
     group by 1
  ), agg as (
    select p.employee_id,
           round(sum(p.hrs) filter (where p.kind = 'LINE')::numeric, 2) as clocked,
           round(sum(p.hrs) filter (where p.kind <> 'LINE')::numeric, 2) as indirect,
           round(sum(p.hrs)::numeric, 2) as attendance,
           (select jsonb_build_object('punch_id', o.id, 'kind', o.kind, 'started_at', o.started_at, 'work_order_id', o.work_order_id,
                                      'work_order_line_id', o.work_order_line_id)
              from pm.dlr_tech_punches o where o.org_id = v_org and o.employee_id = p.employee_id and o.ended_at is null limit 1) as open_punch
      from pun p group by p.employee_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', a.employee_id,
           'name', nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''),
           'clocked_hours', coalesce(a.clocked, 0), 'indirect_hours', coalesce(a.indirect, 0), 'attendance_hours', coalesce(a.attendance, 0),
           'flagged_hours', round(coalesce(f.flag_hrs, 0)::numeric, 2),
           'efficiency', case when coalesce(a.clocked, 0) > 0 then round((coalesce(f.flag_hrs, 0) / a.clocked)::numeric, 4) end,
           'productivity', case when coalesce(a.attendance, 0) > 0 then round((coalesce(a.clocked, 0) / a.attendance)::numeric, 4) end,
           'lines_over_flat_rate', coalesce(f.lines_over, 0), 'open_punch', a.open_punch) order by e.last_name, e.first_name), '[]')
    into v_out
    from agg a join core.employees e on e.id = a.employee_id left join flagged f on f.employee_id = a.employee_id;
  return jsonb_build_object('location_id', p_location, 'from', v_from::date, 'to', (v_to - interval '1 day')::date, 'all_techs', v_all, 'techs', v_out);
end $$;

-- D10. Dealer KPI dashboard (DLR-75). Money (parts GM, warranty $, rental $) needs the money cap.
create or replace function pm.dlr_kpis(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_from date := coalesce(p_from, date_trunc('month', current_date)::date);
        v_to date := coalesce(p_to, current_date); v_fin boolean; v_cv boolean; c record; f record; ls int; w record; u record; r record; ro record; tb jsonb;
        v_eff numeric; v_prod numeric;
begin
  v_fin := pm._x_sees('projects.financials', 'view', p_location);
  v_cv := v_fin or pm._x_sees('projects.store', 'approve', p_location);
  select count(*)::int as n,
         percentile_cont(0.5) within group (order by extract(epoch from (t.closed_at - t.created_at))) as med,
         case when count(*) > 0 then (count(*) filter (where t.closed_at - t.created_at <= interval '60 seconds'))::numeric / count(*) end as under60
    into c from pm.parts_tickets t
   where t.org_id = v_org and t.location_id = p_location and t.status = 'CLOSED' and t.closed_at >= v_from and t.closed_at < v_to + 1 and not t.is_sample;
  select coalesce(sum(l.qty_requested), 0) as req, coalesce(sum(l.qty_filled), 0) as filled, coalesce(sum(l.amount_cents), 0)::bigint as sales,
         coalesce(sum(round(l.qty_filled * coalesce(l.unit_cost_cents, 0))), 0)::bigint as cost
    into f from pm.parts_ticket_lines l join pm.parts_tickets t on t.org_id = l.org_id and t.id = l.ticket_id
   where t.org_id = v_org and t.location_id = p_location and t.status = 'CLOSED' and t.closed_at >= v_from and t.closed_at < v_to + 1 and not t.is_sample;
  select count(*)::int into ls from pm.dlr_lost_sales x where x.org_id = v_org and x.location_id = p_location and x.created_at >= v_from and x.created_at < v_to + 1;
  select count(*)::int as open_ros,
         count(*) filter (where current_date - coalesce(x.checked_in_at, x.created_at)::date <= 7)::int as d0_7,
         count(*) filter (where current_date - coalesce(x.checked_in_at, x.created_at)::date between 8 and 14)::int as d8_14,
         count(*) filter (where current_date - coalesce(x.checked_in_at, x.created_at)::date between 15 and 30)::int as d15_30,
         count(*) filter (where current_date - coalesce(x.checked_in_at, x.created_at)::date > 30)::int as d30p
    into ro from pm.work_orders x
   where x.org_id = v_org and x.location_id = p_location and x.kind = 'REPAIR_ORDER' and x.status not in ('CLOSED','CANCELLED');
  tb := pm.dlr_tech_board(p_location, v_from, v_to);
  select case when sum((e ->> 'clocked_hours')::numeric) > 0 then round(sum((e ->> 'flagged_hours')::numeric) / sum((e ->> 'clocked_hours')::numeric), 4) end,
         case when sum((e ->> 'attendance_hours')::numeric) > 0 then round(sum((e ->> 'clocked_hours')::numeric) / sum((e ->> 'attendance_hours')::numeric), 4) end
    into v_eff, v_prod from jsonb_array_elements(tb -> 'techs') e;
  select count(*) filter (where cl.status in ('SUBMITTED','APPROVED','RETURNED'))::int as outstanding,
         coalesce(sum(greatest(coalesce(cl.approved_cents, cl.claimed_cents) - cl.paid_cents, 0)) filter (where cl.status in ('SUBMITTED','APPROVED','RETURNED')), 0)::bigint as outstanding_cents,
         count(*) filter (where cl.status = 'REJECTED' and cl.decided_at >= current_date - 365)::int as rejected,
         count(*) filter (where cl.decided_at >= current_date - 365 and cl.status in ('APPROVED','PAID','REJECTED','WRITTEN_OFF'))::int as decided,
         count(*) filter (where cl.status = 'DRAFT' and coalesce(cl.submit_by, cl.filing_deadline) <= current_date + 7)::int as near_deadline
    into w from pm.warranty_claims cl join pm.work_orders wo on wo.org_id = cl.org_id and wo.id = cl.work_order_id
   where cl.org_id = v_org and wo.location_id = p_location;
  select count(*) filter (where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD'))::int as in_stock,
         count(*) filter (where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD') and current_date - coalesce(a.received_on, a.created_at::date) <= 90)::int as a0_90,
         count(*) filter (where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD') and current_date - coalesce(a.received_on, a.created_at::date) between 91 and 180)::int as a91_180,
         count(*) filter (where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD') and current_date - coalesce(a.received_on, a.created_at::date) between 181 and 365)::int as a181_365,
         count(*) filter (where a.unit_status in ('IN_STOCK','PDI','DEMO','ON_HOLD') and current_date - coalesce(a.received_on, a.created_at::date) > 365)::int as a365p,
         count(*) filter (where a.unit_status in ('SOLD','DELIVERED') and a.floored and not a.payoff_scheduled
                          and coalesce(a.floor_status, '') in ('FLOORED','SOLD_UNPAID','IN_DEFAULT'))::int as sold_unpaid,
         count(*) filter (where a.unit_delivered_on >= current_date - 365)::int as delivered_365
    into u from pm.assets a where a.org_id = v_org and a.location_id = p_location and a.unit_status is not null and not a.is_sample;
  select coalesce(sum(x.on_rent_days), 0) as on_rent, coalesce(sum(x.available_days), 0) as avail, coalesce(sum(x.billed_90d_cents), 0)::bigint as billed,
         coalesce((select sum(a.dealer_cost_cents) from pm.assets a where a.org_id = v_org and a.location_id = p_location and a.unit_status = 'RENTAL'), 0)::bigint as fleet_cost
    into r from pm.v_rental_utilization x where x.org_id = v_org and x.location_id = p_location;
  return jsonb_build_object(
    'location_id', p_location, 'from', v_from, 'to', v_to, 'amounts_visible', v_fin,
    'counter', jsonb_build_object('tickets', c.n, 'median_seconds', round(c.med::numeric, 1), 'pct_under_60s', round(c.under60, 4),
                                  'fill_rate', case when f.req > 0 then round(f.filled / f.req, 4) end, 'lost_sales', ls,
                                  'parts_sales_cents', case when v_cv then f.sales end,
                                  'parts_gm_pct', case when v_fin and f.sales > 0 then round((f.sales - f.cost)::numeric / f.sales, 4) end),
    'service', jsonb_build_object('open_ros', ro.open_ros, 'wip_aging', jsonb_build_object('d0_7', ro.d0_7, 'd8_14', ro.d8_14, 'd15_30', ro.d15_30, 'd30_plus', ro.d30p),
                                  'efficiency', v_eff, 'productivity', v_prod, 'techs', jsonb_array_length(tb -> 'techs')),
    'warranty', jsonb_build_object('outstanding', w.outstanding, 'outstanding_cents', case when v_cv then w.outstanding_cents end,
                                   'rejection_rate', case when w.decided > 0 then round(w.rejected::numeric / w.decided, 4) end, 'near_deadline', w.near_deadline),
    'units', jsonb_build_object('in_stock', u.in_stock, 'aging', jsonb_build_object('d0_90', u.a0_90, 'd91_180', u.a91_180, 'd181_365', u.a181_365, 'd365_plus', u.a365p),
                                'sold_unpaid', u.sold_unpaid, 'turns_365', case when u.in_stock > 0 then round(u.delivered_365::numeric / u.in_stock, 2) end),
    'rental', jsonb_build_object('time_utilization', case when r.avail > 0 then round(r.on_rent / r.avail, 4) end,
                                 'dollar_utilization', case when v_fin and r.fleet_cost > 0 then round((r.billed * 4)::numeric / r.fleet_cost, 4) end),
    'absorption', jsonb_build_object('available', false, 'needs', 'Merit Books departmental gross profit (parts, service, rental) and fixed expense by store'));
end $$;

-- ============================================================================
-- M. Manufacturing (ETO cabinetry / millwork)
-- ============================================================================

-- M0. Shop settings (release gates, kiosk, backlog weighting) ---------------------
create table if not exists pm.mfg_settings (
  org_id                   uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id),
  require_deposit          boolean not null default true,
  require_material         boolean not null default true,
  require_cad_import       boolean not null default false,
  quote_win_probability    numeric(4,3) not null default 0.30 check (quote_win_probability between 0 and 1),
  kiosk_session_hours      int not null default 14 check (kiosk_session_hours between 1 and 24),
  forgotten_punch_hours    numeric(5,2) not null default 10 check (forgotten_punch_hours > 0),
  install_buffer_days      int not null default 2 check (install_buffer_days between 0 and 60),
  updated_by               text default pm.current_user_id(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (org_id, location_id)
);

create or replace function pm._mfg_settings(p_org uuid, p_location uuid) returns pm.mfg_settings
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.mfg_settings%rowtype;
begin
  select * into s from pm.mfg_settings x where x.org_id = p_org and x.location_id = p_location;
  if s.org_id is null then
    s.org_id := p_org; s.location_id := p_location; s.require_deposit := true; s.require_material := true; s.require_cad_import := false;
    s.quote_win_probability := 0.30; s.kiosk_session_hours := 14; s.forgotten_punch_hours := 10; s.install_buffer_days := 2;
  end if;
  return s;
end $$;

-- M1. CAD/CAM import + reconcile ---------------------------------------------------
create table if not exists pm.mfg_cad_imports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  work_order_id  uuid,
  wbs_id         uuid,
  source         text not null check (source in ('CABINET_VISION','MICROVELLUM','MOZAIK','KCD','CABBUILDER','IMOS','GENERIC')),
  file_name      text,
  status         text not null default 'STAGED' check (status in ('STAGED','APPLIED','DISCARDED')),
  estimate_id    uuid,
  counts         jsonb not null default '{}' check (jsonb_typeof(counts) = 'object'),
  diff           jsonb not null default '[]' check (jsonb_typeof(diff) = 'array'),
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  applied_by     text,
  applied_at     timestamptz,
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create table if not exists pm.mfg_cad_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  import_id      uuid not null,
  line_no        int not null,
  line_kind      text not null check (line_kind in ('ASSEMBLY','PART','SHEET','EDGEBAND','HARDWARE','BUYOUT','FINISH')),
  assembly_ref   text,
  part_code      text,
  label_id       text,
  description    text not null check (char_length(description) between 1 and 300),
  material       text,
  qty            numeric(14,4) not null check (qty > 0),
  uom            text not null default 'EA',
  length_mm      numeric(10,2),
  width_mm       numeric(10,2),
  thickness_mm   numeric(10,2),
  grain          text check (grain is null or grain in ('NONE','LENGTH','WIDTH')),
  edgeband       text,
  machining      boolean not null default false,
  yield_pct      numeric(6,4),
  unique (org_id, id),
  unique (import_id, line_no),
  foreign key (org_id, import_id) references pm.mfg_cad_imports (org_id, id) on delete cascade deferrable initially immediate
);

-- Material key used to compare CAD output with the estimate: SHEET / EDGEBAND by material (+ thickness),
-- HARDWARE by part code. Estimate lines opt in with ext.mfg = {kind, key} (written by the estimator /
-- the parametric library); unmatched keys still show on the diff.
create or replace function pm.mfg_material_key(p_kind text, p_material text, p_thickness numeric, p_part_code text) returns text
language sql immutable
as $$
  select case
    when p_kind in ('SHEET','EDGEBAND') then upper(btrim(coalesce(p_material, '?'))) || case when p_thickness is not null then '|' || trim(to_char(p_thickness, 'FM9990.0')) else '' end
    when p_kind = 'HARDWARE' then upper(btrim(coalesce(p_part_code, p_material, '?')))
    else upper(btrim(coalesce(p_part_code, p_material, '?'))) end
$$;

create or replace function pm.mfg_stage_cad_import(p_job uuid, p_source text, p_file_name text, p_lines jsonb,
                                                   p_work_order uuid default null, p_wbs uuid default null, p_estimate uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; e jsonb; n int := 0; v_kind text; v_est uuid; v_diff jsonb; v_fin boolean; v_counts jsonb;
begin
  select * into j from pm._x_job(p_job);
  if p_source not in ('CABINET_VISION','MICROVELLUM','MOZAIK','KCD','CABBUILDER','IMOS','GENERIC') then
    raise exception 'PM_INVALID: source %', p_source using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 20000 then
    raise exception 'PM_INVALID: a CAD import needs 1–20,000 lines' using errcode = '22023';
  end if;
  if p_work_order is not null and not exists (select 1 from pm.work_orders w where w.org_id = j.org_id and w.id = p_work_order and w.job_id = p_job and w.kind = 'PRODUCTION') then
    raise exception 'PM_INVALID: the work order is not a production order on this job' using errcode = '22023';
  end if;
  v_est := coalesce(p_estimate, (select e2.id from pm.estimates e2 where e2.org_id = j.org_id and e2.job_id = p_job
                                  order by (e2.status = 'ACCEPTED') desc, e2.version desc, e2.created_at desc limit 1));
  insert into pm.mfg_cad_imports (org_id, job_id, work_order_id, wbs_id, source, file_name, estimate_id)
  values (j.org_id, p_job, p_work_order, p_wbs, p_source, left(p_file_name, 200), v_est) returning id into v_id;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_kind := upper(coalesce(e ->> 'line_kind', 'PART'));
    if v_kind not in ('ASSEMBLY','PART','SHEET','EDGEBAND','HARDWARE','BUYOUT','FINISH') then v_kind := 'PART'; end if;
    continue when nullif(btrim(coalesce(e ->> 'description', '')), '') is null or coalesce(pm._x_try_num(e ->> 'qty'), 0) <= 0;
    n := n + 1;
    insert into pm.mfg_cad_lines (org_id, import_id, line_no, line_kind, assembly_ref, part_code, label_id, description, material, qty, uom,
                                  length_mm, width_mm, thickness_mm, grain, edgeband, machining, yield_pct)
    values (j.org_id, v_id, n, v_kind, nullif(left(e ->> 'assembly_ref', 60), ''), nullif(left(e ->> 'part_code', 60), ''),
            nullif(left(e ->> 'label_id', 60), ''), left(btrim(e ->> 'description'), 300), nullif(left(e ->> 'material', 120), ''),
            pm._x_try_num(e ->> 'qty'), coalesce(nullif(left(e ->> 'uom', 12), ''), case v_kind when 'SHEET' then 'SHEET' when 'EDGEBAND' then 'LF' else 'EA' end),
            nullif(pm._x_try_num(e ->> 'length_mm'), 0), nullif(pm._x_try_num(e ->> 'width_mm'), 0), nullif(pm._x_try_num(e ->> 'thickness_mm'), 0),
            case when upper(e ->> 'grain') in ('NONE','LENGTH','WIDTH') then upper(e ->> 'grain') end, nullif(left(e ->> 'edgeband', 60), ''),
            coalesce(lower(e ->> 'machining') in ('true','t','1','yes','y'), false), pm._x_try_num(e ->> 'yield_pct'));
  end loop;
  if n = 0 then raise exception 'PM_INVALID: no usable lines (each needs a description and a quantity)' using errcode = '22023'; end if;
  v_fin := pm._x_sees('projects.financials', 'view', j.location_id, p_job);
  -- diff: CAD quantities vs estimate quantities by material key
  with cad as (
    select l.line_kind as kind, pm.mfg_material_key(l.line_kind, l.material, l.thickness_mm, l.part_code) as key, sum(l.qty) as qty
      from pm.mfg_cad_lines l where l.org_id = j.org_id and l.import_id = v_id and l.line_kind in ('SHEET','EDGEBAND','HARDWARE','BUYOUT')
     group by 1, 2
  ), est as (
    select upper(el.ext #>> '{mfg,kind}') as kind, upper(btrim(el.ext #>> '{mfg,key}')) as key, sum(coalesce(el.qty, 0)) as qty,
           sum(coalesce(el.cost_cents, 0))::bigint as cost, case when sum(coalesce(el.qty, 0)) > 0 then sum(coalesce(el.cost_cents, 0)) / sum(el.qty) end as unit_cost
      from pm.estimate_lines el where el.org_id = j.org_id and el.estimate_id = v_est and el.ext ? 'mfg'
     group by 1, 2
  ), keys as (select kind, key from cad union select kind, key from est)
  select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'key', k.key, 'estimated_qty', coalesce(es.qty, 0), 'cad_qty', coalesce(c.qty, 0),
                    'delta_qty', coalesce(c.qty, 0) - coalesce(es.qty, 0),
                    'delta_cost_cents', case when v_fin and es.unit_cost is not null then round((coalesce(c.qty, 0) - coalesce(es.qty, 0)) * es.unit_cost)::bigint end,
                    'status', case when es.key is null then 'NOT_ESTIMATED' when c.key is null then 'NOT_IN_CAD'
                                   when c.qty > es.qty then 'OVER' when c.qty < es.qty then 'UNDER' else 'MATCH' end)
                  order by k.kind, k.key), '[]')
    into v_diff
    from keys k left join cad c on c.kind = k.kind and c.key = k.key left join est es on es.kind = k.kind and es.key = k.key;
  select jsonb_build_object('lines', n,
           'assemblies', count(*) filter (where line_kind = 'ASSEMBLY'), 'parts', count(*) filter (where line_kind = 'PART'),
           'sheets', coalesce(sum(qty) filter (where line_kind = 'SHEET'), 0), 'edgeband_lf', coalesce(sum(qty) filter (where line_kind = 'EDGEBAND'), 0),
           'hardware', coalesce(sum(qty) filter (where line_kind = 'HARDWARE'), 0),
           'estimate_hours', (select round(coalesce(sum(el.labor_hours), 0), 2) from pm.estimate_lines el where el.org_id = j.org_id and el.estimate_id = v_est),
           'routing_hours', (select round(coalesce(sum(o.std_minutes), 0) / 60.0, 2) from pm.wo_operations o where o.org_id = j.org_id and o.work_order_id = p_work_order))
    into v_counts from pm.mfg_cad_lines where org_id = j.org_id and import_id = v_id;
  update pm.mfg_cad_imports set diff = v_diff, counts = v_counts where id = v_id;
  return jsonb_build_object('import_id', v_id, 'estimate_id', v_est, 'counts', v_counts, 'diff', v_diff);
end $$;

-- Write the import into the production order's BOM (replaces lines from an earlier CAD import).
create or replace function pm.mfg_apply_cad_import(p_import uuid, p_work_order uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.mfg_cad_imports%rowtype; w pm.work_orders%rowtype; l pm.mfg_cad_lines%rowtype; v_parent uuid; v_map jsonb := '{}'; n int := 0;
        v_kind text;
begin
  select * into i from pm.mfg_cad_imports x where x.id = p_import for update;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: import % not found in the caller''s organization', p_import using errcode = '42501';
  end if;
  if i.status <> 'STAGED' then raise exception 'PM_CAD_IMPORT_STATE: this import is %', lower(i.status) using errcode = '22023'; end if;
  select * into w from pm.work_orders x where x.org_id = i.org_id and x.id = coalesce(p_work_order, i.work_order_id) and x.job_id = i.job_id for update;
  if w.id is null or w.kind <> 'PRODUCTION' then raise exception 'PM_INVALID: pick the production order the BOM goes to' using errcode = '22023'; end if;
  if w.status <> 'NEW' then raise exception 'PM_PRODUCTION_LOCKED: % is %; change a released BOM through a change order', w.number, w.status using errcode = '55000'; end if;
  delete from pm.bom_lines b where b.org_id = i.org_id and b.work_order_id = w.id and b.source_ref like 'cad:%';
  -- assemblies first (cabinet boxes), then their parts / materials
  for l in select * from pm.mfg_cad_lines x where x.org_id = i.org_id and x.import_id = i.id order by (x.line_kind <> 'ASSEMBLY'), x.line_no loop
    v_parent := case when l.line_kind <> 'ASSEMBLY' and l.assembly_ref is not null then (v_map ->> l.assembly_ref)::uuid end;
    v_kind := case l.line_kind when 'FINISH' then 'FINISH' else l.line_kind end;
    insert into pm.bom_lines (org_id, job_id, work_order_id, parent_id, seq, line_kind, part_code, description, material, qty, uom, length_mm, width_mm,
                              thickness_mm, grain, edgeband, assembly_ref, wbs_id, source_ref)
    values (i.org_id, i.job_id, w.id, v_parent, l.line_no, v_kind, coalesce(l.part_code, l.label_id), l.description, l.material, l.qty, l.uom,
            case when l.length_mm > 0 then l.length_mm end, case when l.width_mm > 0 then l.width_mm end, case when l.thickness_mm > 0 then l.thickness_mm end,
            l.grain, l.edgeband, l.assembly_ref, coalesce(i.wbs_id, w.wbs_id), 'cad:' || i.id::text || ':' || l.line_no)
    returning id into v_parent;
    if l.line_kind = 'ASSEMBLY' and l.assembly_ref is not null and not (v_map ? l.assembly_ref) then
      v_map := v_map || jsonb_build_object(l.assembly_ref, v_parent);
    end if;
    n := n + 1;
  end loop;
  update pm.mfg_cad_imports set status = 'APPLIED', applied_by = pm.current_user_id(), applied_at = now(), work_order_id = w.id where id = i.id;
  perform pm.log_activity(i.org_id, w.location_id, i.job_id, 'production.cad_applied', 'work_orders', w.id,
    format('%s BOM from %s: %s lines', w.number, initcap(replace(lower(i.source), '_', ' ')), n), jsonb_build_object('import_id', i.id));
  return jsonb_build_object('import_id', i.id, 'work_order_id', w.id, 'bom_lines', n);
end $$;

-- M2. Work centers with capacity, downtime, routing run basis ---------------------
alter table pm.work_centers add column if not exists efficiency_pct      numeric(4,3) not null default 0.85;
alter table pm.work_centers add column if not exists hours_per_day       numeric(5,2) not null default 8;
alter table pm.work_centers add column if not exists days_per_week       int not null default 5;
alter table pm.work_centers add column if not exists shifts              int not null default 1;
alter table pm.work_centers add column if not exists crew_size           int not null default 1;
alter table pm.work_centers add column if not exists costing_rate_cents  bigint;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'work_centers_mfg_chk' and conrelid = 'pm.work_centers'::regclass) then
    alter table pm.work_centers add constraint work_centers_mfg_chk check (efficiency_pct > 0 and efficiency_pct <= 1.5
      and hours_per_day between 0 and 24 and days_per_week between 0 and 7 and shifts between 1 and 4 and crew_size between 1 and 100
      and (costing_rate_cents is null or costing_rate_cents >= 0));
  end if;
end $$;

alter table pm.routing_steps add column if not exists run_basis           text not null default 'UNIT';
alter table pm.routing_steps add column if not exists is_machine          boolean not null default false;
alter table pm.routing_steps add column if not exists is_outside          boolean not null default false;
alter table pm.routing_steps add column if not exists outside_vendor_id   uuid references core.vendors(id);
alter table pm.routing_steps add column if not exists outside_lead_days   int;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'routing_steps_basis_chk' and conrelid = 'pm.routing_steps'::regclass) then
    alter table pm.routing_steps add constraint routing_steps_basis_chk check (run_basis in ('UNIT','PART','SHEET','LF','BOX')
      and (outside_lead_days is null or outside_lead_days between 0 and 365));
  end if;
end $$;

create table if not exists pm.mfg_center_downtime (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  work_center_id  uuid not null,
  starts_on       date not null,
  ends_on         date not null,
  reason          text,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  check (ends_on >= starts_on),
  foreign key (org_id, work_center_id) references pm.work_centers (org_id, id) on delete cascade deferrable initially immediate
);

-- Weekly capacity minutes of a center in the week starting p_week (Monday): base × efficiency − downtime days.
create or replace function pm.mfg_center_week_minutes(p_center uuid, p_week date) returns int
language sql stable security definer
set search_path = pm, core, public
as $$
  select greatest(0, round(c.capacity_minutes_per_week * c.efficiency_pct
           * (1 - least(1, coalesce((select count(distinct d)::numeric from pm.mfg_center_downtime t,
                                            generate_series(greatest(t.starts_on, p_week), least(t.ends_on, p_week + 6), interval '1 day') d
                                      where t.org_id = c.org_id and t.work_center_id = c.id and t.starts_on <= p_week + 6 and t.ends_on >= p_week
                                        and extract(isodow from d) <= greatest(c.days_per_week, 1)), 0) / greatest(c.days_per_week, 1)))))::int
    from pm.work_centers c where c.id = p_center and c.status = 'ACTIVE'
$$;

-- Recompute operation standards from the BOM by run basis (setup + run × parts | sheets | LF | boxes | WO qty).
create or replace function pm.mfg_restandard_operations(p_wo uuid)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; o record; v_q numeric; n int := 0; b record;
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.kind <> 'PRODUCTION' or w.status <> 'NEW' then raise exception 'PM_PRODUCTION_LOCKED: standards are set before release' using errcode = '55000'; end if;
  select coalesce(sum(qty) filter (where line_kind = 'PART'), 0) as parts, coalesce(sum(qty) filter (where line_kind = 'SHEET'), 0) as sheets,
         coalesce(sum(qty) filter (where line_kind = 'EDGEBAND'), 0) as lf, coalesce(sum(qty) filter (where line_kind = 'ASSEMBLY'), 0) as boxes
    into b from pm.bom_lines where org_id = w.org_id and work_order_id = w.id;
  for o in select op.id, s.setup_minutes, s.run_minutes_per_unit, s.run_basis
             from pm.wo_operations op join pm.routing_steps s on s.org_id = op.org_id and s.id = op.routing_step_id
            where op.org_id = w.org_id and op.work_order_id = w.id and op.status = 'PENDING' loop
    v_q := case o.run_basis when 'PART' then b.parts when 'SHEET' then b.sheets when 'LF' then b.lf when 'BOX' then b.boxes else w.quantity end;
    update pm.wo_operations set std_minutes = round(o.setup_minutes + o.run_minutes_per_unit * coalesce(v_q, 0))::int where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- M3. Release to shop with gates ---------------------------------------------------
-- Every gate with its state; the 1105 gates + deposit (Books payment of the deposit invoice), material
-- (each BOM material on hand or on an open PO) and CAD (an applied import) per the shop settings.
create or replace function pm.mfg_release_check(p_wo uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; s pm.mfg_settings; v_dep jsonb; v_short jsonb; v_g jsonb := '[]'; v_ok boolean := true; v_cad boolean;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if w.kind <> 'PRODUCTION' then raise exception 'PM_NOT_PRODUCTION: %', w.number using errcode = '22023'; end if;
  s := pm._mfg_settings(w.org_id, w.location_id);
  v_g := v_g || jsonb_build_object('key', 'drawings_approved', 'ok', w.drawings_approved_at is not null, 'owner', 'drafting',
                                   'detail', case when w.drawings_approved_at is null then 'Shop drawings are not approved.' end);
  v_g := v_g || jsonb_build_object('key', 'bom_present', 'ok', exists (select 1 from pm.bom_lines b where b.org_id = w.org_id and b.work_order_id = w.id), 'owner', 'engineering');
  v_g := v_g || jsonb_build_object('key', 'operations_present', 'ok', exists (select 1 from pm.wo_operations o where o.org_id = w.org_id and o.work_order_id = w.id), 'owner', 'production');
  v_g := v_g || jsonb_build_object('key', 'selections_approved', 'ok', pm.guard_selections_approved(w.job_id), 'owner', 'project manager');
  v_g := v_g || jsonb_build_object('key', 'has_budget', 'ok', pm.guard_has_budget(w.job_id), 'owner', 'project manager');
  v_dep := pm._x_job_deposits(w.org_id, w.job_id);
  v_g := v_g || jsonb_build_object('key', 'deposit_received', 'required', s.require_deposit,
    'ok', not s.require_deposit or coalesce((v_dep ->> 'all_paid')::boolean, false), 'owner', 'office',
    'detail', case when not s.require_deposit then null
                   when (v_dep ->> 'none_requested')::boolean then 'No deposit has been requested.'
                   when not (v_dep ->> 'books_available')::boolean then 'Merit Books does not report invoice payments yet.'
                   when not (v_dep ->> 'all_paid')::boolean then 'The deposit invoice is not paid in Books.' end);
  select coalesce(jsonb_agg(jsonb_build_object('key', d ->> 'key', 'description', d ->> 'description', 'short_qty', d -> 'short_qty')), '[]')
    into v_short from jsonb_array_elements(pm._mfg_demand_rows(w.org_id, w.location_id, w.id)) d where (d ->> 'short_qty')::numeric > 0;
  v_g := v_g || jsonb_build_object('key', 'material_ready', 'required', s.require_material,
    'ok', not s.require_material or jsonb_array_length(v_short) = 0, 'owner', 'purchasing', 'short', v_short);
  v_cad := exists (select 1 from pm.mfg_cad_imports i where i.org_id = w.org_id and i.work_order_id = w.id and i.status = 'APPLIED');
  v_g := v_g || jsonb_build_object('key', 'cad_reconciled', 'required', s.require_cad_import, 'ok', not s.require_cad_import or v_cad, 'owner', 'engineering');
  select bool_and((g ->> 'ok')::boolean) into v_ok from jsonb_array_elements(v_g) g;
  return jsonb_build_object('work_order_id', w.id, 'number', w.number, 'status', w.status, 'ready', coalesce(v_ok, false) and w.status = 'NEW', 'gates', v_g);
end $$;

-- Release when every gate passes. A failing 1122 gate (deposit / material / CAD) may be overridden with a
-- written reason by a holder of projects.production:edit AND projects.financials:edit (logged); the
-- 1105 gates are never overridden.
create or replace function pm.mfg_release(p_wo uuid, p_override_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; chk jsonb; v_fail text[]; v_soft text[]; v_hard text[]; v_res text[];
begin
  select * into w from pm.work_orders x where x.id = p_wo for update;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  chk := pm.mfg_release_check(p_wo);
  select array_agg(g ->> 'key') into v_fail from jsonb_array_elements(chk -> 'gates') g where not (g ->> 'ok')::boolean;
  v_soft := array(select x from unnest(coalesce(v_fail, '{}')) x where x in ('deposit_received','material_ready','cad_reconciled'));
  v_hard := array(select x from unnest(coalesce(v_fail, '{}')) x where x not in ('deposit_received','material_ready','cad_reconciled'));
  if cardinality(v_hard) > 0 then return chk || jsonb_build_object('released', false, 'failed', to_jsonb(v_hard || v_soft)); end if;
  if cardinality(v_soft) > 0 then
    if nullif(btrim(coalesce(p_override_reason, '')), '') is null or char_length(btrim(p_override_reason)) < 5 then
      return chk || jsonb_build_object('released', false, 'failed', to_jsonb(v_soft), 'overridable', true);
    end if;
    if not pm.access_can_job('projects.financials', 'edit', w.job_id) then
      raise exception 'PM_FORBIDDEN: releasing past the deposit / material / CAD gate needs projects.financials:edit' using errcode = '42501';
    end if;
    perform pm.log_activity(w.org_id, w.location_id, w.job_id, 'production.release_override', 'work_orders', w.id,
      format('%s released past %s: %s', w.number, array_to_string(v_soft, ', '), btrim(p_override_reason)), jsonb_build_object('gates', v_soft));
  end if;
  v_res := pm.release_to_shop(p_wo);
  return jsonb_build_object('released', cardinality(coalesce(v_res, '{}')) = 0, 'failed', to_jsonb(coalesce(v_res, '{}')), 'overridden', to_jsonb(v_soft));
end $$;

-- M4. Backlog in shop-hours vs capacity -------------------------------------------
-- Per center: booked (released, remaining std), unreleased (NEW production orders) and quoted-weighted
-- (SENT estimates' labor hours × win probability, spread by each center's share of the last 90 days'
-- standard minutes), loaded forward week by week from this Monday against weekly capacity.
create or replace function pm.mfg_backlog(p_location uuid, p_weeks int default 12)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); s pm.mfg_settings; v_week0 date := date_trunc('week', current_date)::date;
        c record; v_left numeric; v_cap int; k int; v_weeks jsonb; v_out jsonb := '[]'; v_quote_h numeric; v_share numeric; v_total_std numeric;
        v_load numeric; v_q numeric;
begin
  if p_weeks is null or p_weeks < 1 or p_weeks > 52 then raise exception 'PM_INVALID: 1–52 weeks' using errcode = '22023'; end if;
  s := pm._mfg_settings(v_org, p_location);
  select coalesce(sum(el.labor_hours), 0) into v_quote_h
    from pm.estimates e join pm.estimate_lines el on el.org_id = e.org_id and el.estimate_id = e.id
   where e.org_id = v_org and e.location_id = p_location and e.status = 'SENT';
  select coalesce(sum(o.std_minutes), 0) into v_total_std
    from pm.wo_operations o join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
   where o.org_id = v_org and w.location_id = p_location and w.created_at >= now() - interval '90 days';
  for c in
    select wc.id, wc.code, wc.name, wc.status, wc.capacity_minutes_per_week, wc.efficiency_pct,
           coalesce(sum(greatest(o.std_minutes - o.actual_minutes, 0)) filter (where w.status in ('RELEASED','IN_PROGRESS','ON_HOLD') and o.status in ('PENDING','READY','IN_PROGRESS')), 0) as booked_min,
           coalesce(sum(o.std_minutes) filter (where w.status = 'NEW'), 0) as unreleased_min,
           coalesce((select sum(o2.std_minutes) from pm.wo_operations o2 join pm.work_orders w2 on w2.org_id = o2.org_id and w2.id = o2.work_order_id
                      where o2.org_id = v_org and o2.work_center_id = wc.id and w2.created_at >= now() - interval '90 days'), 0) as recent_std
      from pm.work_centers wc
      left join pm.wo_operations o on o.org_id = wc.org_id and o.work_center_id = wc.id
      left join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id and w.kind = 'PRODUCTION' and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')
     where wc.org_id = v_org and wc.location_id = p_location and wc.status <> 'INACTIVE'
     group by wc.id
     order by wc.sort, wc.code
  loop
    v_share := case when v_total_std > 0 then c.recent_std / v_total_std else 0 end;
    v_q := round(v_quote_h * 60 * s.quote_win_probability * v_share);
    v_left := c.booked_min + c.unreleased_min + v_q;
    v_weeks := '[]';
    for k in 0 .. p_weeks - 1 loop
      v_cap := coalesce(pm.mfg_center_week_minutes(c.id, v_week0 + k * 7), 0);
      v_load := least(v_left, v_cap);
      v_weeks := v_weeks || jsonb_build_object('week_start', v_week0 + k * 7, 'capacity_hours', round(v_cap / 60.0, 1), 'load_hours', round(v_load / 60.0, 1),
                                               'pct', case when v_cap > 0 then round(v_load / v_cap, 3) end);
      v_left := greatest(v_left - v_cap, 0);
    end loop;
    v_cap := coalesce(pm.mfg_center_week_minutes(c.id, v_week0), 0);
    v_out := v_out || jsonb_build_object('work_center_id', c.id, 'code', c.code, 'name', c.name, 'status', c.status,
      'weekly_capacity_hours', round(v_cap / 60.0, 1), 'booked_hours', round(c.booked_min / 60.0, 1),
      'unreleased_hours', round(c.unreleased_min / 60.0, 1), 'quoted_weighted_hours', round(v_q / 60.0, 1),
      'weeks_of_backlog', case when v_cap > 0 then round((c.booked_min + c.unreleased_min)::numeric / v_cap, 1) end,
      'overflow_hours', round(v_left / 60.0, 1), 'weeks', v_weeks);
  end loop;
  return jsonb_build_object('location_id', p_location, 'week_start', v_week0, 'weeks', p_weeks, 'win_probability', s.quote_win_probability, 'centers', v_out);
end $$;

-- M5. Shop-floor kiosk -------------------------------------------------------------
create table if not exists pm.mfg_badges (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  employee_id  uuid not null references core.employees(id),
  badge_hash   text not null check (badge_hash ~ '^[0-9a-f]{64}$'),
  pin_hash     text check (pin_hash is null or pin_hash ~ '^[0-9a-f]{64}$'),
  is_active    boolean not null default true,
  failed_count int not null default 0,
  locked_until timestamptz,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, employee_id)
);
create unique index if not exists pm_mfg_badge_hash_uidx on pm.mfg_badges (org_id, location_id, badge_hash) where is_active;

create table if not exists pm.mfg_kiosk_sessions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  employee_id   uuid not null references core.employees(id),
  token_hash    text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  device_user   text,
  started_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  unique (org_id, id),
  unique (token_hash)
);

create table if not exists pm.mfg_kiosk_punches (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  employee_id      uuid not null references core.employees(id),
  job_id           uuid,
  work_order_id    uuid,
  operation_id     uuid,
  indirect_code    text check (indirect_code is null or indirect_code in ('CLEANUP','MAINTENANCE','TRAINING','MEETING','WAITING_MATERIAL','OTHER')),
  started_at       timestamptz not null,
  ended_at         timestamptz,
  good_qty         numeric(14,4),
  scrap_qty        numeric(14,4),
  pause_reason     text,
  split_minutes    int,                              -- minutes after splitting overlaps (two jobs at once)
  time_entry_id    uuid,
  start_event_id   text not null,
  end_event_id     text,
  source           text not null default 'KIOSK' check (source in ('KIOSK','ADJUSTED')),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, start_event_id),
  check (ended_at is null or ended_at >= started_at),
  check ((operation_id is null) <> (indirect_code is null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, operation_id) references pm.wo_operations (org_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_kp_emp_idx on pm.mfg_kiosk_punches (org_id, employee_id, started_at);

-- Idempotency ledger for every kiosk event (offline replays answer from here).
create table if not exists pm.mfg_kiosk_events (
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  client_event_id  text not null check (char_length(client_event_id) between 8 and 80),
  employee_id      uuid not null,
  action           text not null,
  result           jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (org_id, client_event_id)
);

-- Set (or reset) a worker's badge and PIN. Raw values never stored.
create or replace function pm.mfg_set_badge(p_location uuid, p_employee uuid, p_badge text, p_pin text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid;
begin
  if not exists (select 1 from core.employees e where e.id = p_employee and e.org_id = v_org) then
    raise exception 'PM_UNKNOWN_EMPLOYEE: %', p_employee using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_badge, ''))) < 4 then raise exception 'PM_INVALID: a badge code has at least 4 characters' using errcode = '22023'; end if;
  -- Every badge carries a PIN (security review R2): a badge code alone is guessable at a shared station.
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then raise exception 'PM_INVALID: every badge needs a PIN of 4–8 digits' using errcode = '22023'; end if;
  insert into pm.mfg_badges (org_id, location_id, employee_id, badge_hash, pin_hash)
  values (v_org, p_location, p_employee, pm._x_sha256('badge:' || upper(btrim(p_badge))),
          pm._x_sha256('pin:' || p_employee::text || ':' || p_pin))
  on conflict (org_id, location_id, employee_id) do update set badge_hash = excluded.badge_hash, pin_hash = excluded.pin_hash,
     is_active = true, failed_count = 0, locked_until = null, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Operations a worker may run now at the company (READY / IN_PROGRESS on released orders). No money.
create or replace function pm._mfg_kiosk_ops(p_org uuid, p_location uuid, p_employee uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('operation_id', o.id, 'work_order_id', w.id, 'work_order', w.number, 'summary', w.summary,
           'job', j.job_number, 'seq', o.seq, 'operation', o.name, 'work_center', wc.name, 'status', o.status,
           'assigned_to_me', o.employee_id = p_employee, 'qty', w.quantity) order by (o.employee_id = p_employee) desc, w.promised_on nulls last, w.number, o.seq), '[]')
    from pm.wo_operations o
    join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
    join core.jobs j on j.org_id = w.org_id and j.id = w.job_id
    join pm.work_centers wc on wc.org_id = o.org_id and wc.id = o.work_center_id
   where o.org_id = p_org and w.location_id = p_location and w.kind = 'PRODUCTION' and w.status in ('RELEASED','IN_PROGRESS','ON_HOLD')
     and o.status in ('READY','IN_PROGRESS')
$$;

-- Per-station guard for badge sign-in (security review H2 / R2). The STATION (the signed-in seat at
-- a company) is what locks: 10 failed sign-ins within a sliding 15 minutes lock it for 15 minutes,
-- and more than 20 sign-ins a minute are refused. A success never clears the failure log. A badge is
-- never hard-locked (that would let anyone lock a coworker out); repeated wrong PINs on one badge
-- raise a shop-lead alert instead (pm.mfg_badge_alerts). Definer-only tables, no member grants.
create table if not exists pm.mfg_kiosk_device_guard (
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  device_user    text not null,
  window_start   timestamptz not null default now(),
  attempts       int not null default 0,
  failures_since timestamptz not null default now(),
  failures       int not null default 0,
  locked_until   timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (org_id, location_id, device_user)
);
create table if not exists pm.mfg_kiosk_failures (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id),
  device_user  text not null,
  badge_id     uuid,
  reason       text not null check (reason in ('UNKNOWN_BADGE','WRONG_PIN','NO_PIN')),
  at           timestamptz not null default now()
);
create index if not exists pm_mfg_kiosk_failures_dev_idx on pm.mfg_kiosk_failures (org_id, location_id, device_user, at);
create index if not exists pm_mfg_kiosk_failures_badge_idx on pm.mfg_kiosk_failures (org_id, badge_id, at) where badge_id is not null;

-- Badge + PIN → a kiosk session for that worker: the token (returned once) lets the device queue
-- events offline. A refusal is RETURNED ({ok: false, code}), never raised, so the counters persist.
create or replace function pm.mfg_kiosk_identify(p_location uuid, p_badge text, p_pin text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); b pm.mfg_badges%rowtype; s pm.mfg_settings; v_token text; v_name text; v_open jsonb;
        g pm.mfg_kiosk_device_guard%rowtype; v_dev text := coalesce(pm.current_user_id(), 'unknown'); v_reason text; v_fails int;
begin
  insert into pm.mfg_kiosk_device_guard (org_id, location_id, device_user) values (v_org, p_location, v_dev)
  on conflict (org_id, location_id, device_user) do nothing;
  select * into g from pm.mfg_kiosk_device_guard x where x.org_id = v_org and x.location_id = p_location and x.device_user = v_dev for update;
  if g.locked_until is not null and g.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'PM_KIOSK_DEVICE_LOCKED', 'retry_at', g.locked_until);
  end if;
  if g.window_start < now() - interval '1 minute' then g.window_start := now(); g.attempts := 0; end if;
  g.attempts := g.attempts + 1;
  update pm.mfg_kiosk_device_guard set window_start = g.window_start, attempts = g.attempts, locked_until = null, updated_at = now()
   where org_id = v_org and location_id = p_location and device_user = v_dev;
  if g.attempts > 20 then
    return jsonb_build_object('ok', false, 'code', 'PM_KIOSK_RATE_LIMIT', 'retry_at', g.window_start + interval '1 minute');
  end if;

  select * into b from pm.mfg_badges x where x.org_id = v_org and x.location_id = p_location and x.is_active
     and x.badge_hash = pm._x_sha256('badge:' || upper(btrim(coalesce(p_badge, ''))));
  if b.id is null then v_reason := 'UNKNOWN_BADGE';
  elsif b.pin_hash is null then v_reason := 'NO_PIN';
  elsif b.pin_hash <> pm._x_sha256('pin:' || b.employee_id::text || ':' || coalesce(p_pin, '')) then v_reason := 'WRONG_PIN';
  end if;
  if v_reason is not null then
    insert into pm.mfg_kiosk_failures (org_id, location_id, device_user, badge_id, reason) values (v_org, p_location, v_dev, b.id, v_reason);
    if b.id is not null then update pm.mfg_badges set failed_count = failed_count + 1, updated_at = now() where id = b.id; end if;
    select count(*) into v_fails from pm.mfg_kiosk_failures f
     where f.org_id = v_org and f.location_id = p_location and f.device_user = v_dev and f.at > now() - interval '15 minutes';
    update pm.mfg_kiosk_device_guard set failures = v_fails, failures_since = now() - interval '15 minutes',
           locked_until = case when v_fails >= 10 then now() + interval '15 minutes' end, updated_at = now()
     where org_id = v_org and location_id = p_location and device_user = v_dev;
    return jsonb_build_object('ok', false,
      'code', case when v_fails >= 10 then 'PM_KIOSK_DEVICE_LOCKED' when v_reason = 'UNKNOWN_BADGE' then 'PM_KIOSK_BADGE'
                   when v_reason = 'NO_PIN' then 'PM_KIOSK_PIN_REQUIRED' else 'PM_KIOSK_PIN' end,
      'station_tries_left', greatest(10 - v_fails, 0));
  end if;

  -- success: the badge's signal counter restarts; the station's failure log is kept (sliding window)
  update pm.mfg_badges set failed_count = 0 where id = b.id;
  s := pm._mfg_settings(v_org, p_location);
  v_token := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || b.id::text, 'UTF8')), 'hex');
  insert into pm.mfg_kiosk_sessions (org_id, location_id, employee_id, token_hash, device_user, expires_at)
  values (v_org, p_location, b.employee_id, pm._x_sha256(v_token), pm.current_user_id(), now() + make_interval(hours => s.kiosk_session_hours));
  select nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), '') into v_name from core.employees e where e.id = b.employee_id;
  select coalesce(jsonb_agg(jsonb_build_object('punch_id', p.id, 'operation_id', p.operation_id, 'indirect_code', p.indirect_code, 'started_at', p.started_at,
                                               'work_order', w.number, 'operation', o.name)), '[]')
    into v_open from pm.mfg_kiosk_punches p left join pm.wo_operations o on o.org_id = p.org_id and o.id = p.operation_id
    left join pm.work_orders w on w.org_id = p.org_id and w.id = p.work_order_id
   where p.org_id = v_org and p.employee_id = b.employee_id and p.ended_at is null;
  return jsonb_build_object('ok', true, 'session_token', v_token, 'expires_at', now() + make_interval(hours => s.kiosk_session_hours),
    'employee_id', b.employee_id, 'name', v_name, 'open', v_open, 'operations', pm._mfg_kiosk_ops(v_org, p_location, b.employee_id));
end $$;

-- The shop lead's signal: badges with 5+ wrong PINs in 24 hours (someone may be guessing a coworker's
-- PIN) and stations locked now. Names only; no hashes.
create or replace function pm.mfg_badge_alerts(p_location uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
begin
  return jsonb_build_object(
    'badges', coalesce((select jsonb_agg(jsonb_build_object('employee_id', b.employee_id,
                 'name', nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), 'wrong_pins_24h', x.n, 'last_at', x.last_at) order by x.n desc)
               from (select f.badge_id, count(*)::int as n, max(f.at) as last_at from pm.mfg_kiosk_failures f
                      where f.org_id = public.get_org_id() and f.location_id = p_location and f.badge_id is not null and f.reason = 'WRONG_PIN'
                        and f.at > now() - interval '24 hours' group by f.badge_id having count(*) >= 5) x
               join pm.mfg_badges b on b.id = x.badge_id join core.employees e on e.id = b.employee_id), '[]'),
    'locked_stations', (select count(*)::int from pm.mfg_kiosk_device_guard g
                         where g.org_id = public.get_org_id() and g.location_id = p_location and g.locked_until > now()));
end $$;

-- Minutes of a punch after splitting overlap with the same worker's other punches (two jobs at once
-- share the clock equally), from start to p_end.
create or replace function pm._mfg_split_minutes(p_punch uuid, p_end timestamptz) returns int
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.mfg_kiosk_punches%rowtype; v_pts timestamptz[]; i int; v_a timestamptz; v_b timestamptz; v_n int; v_sec numeric := 0;
begin
  select * into p from pm.mfg_kiosk_punches x where x.id = p_punch;
  select array_agg(distinct t order by t) into v_pts from (
    select p.started_at as t union select p_end
    union select greatest(x.started_at, p.started_at) from pm.mfg_kiosk_punches x
           where x.org_id = p.org_id and x.employee_id = p.employee_id and x.id <> p.id and x.started_at < p_end and coalesce(x.ended_at, p_end) > p.started_at
    union select least(coalesce(x.ended_at, p_end), p_end) from pm.mfg_kiosk_punches x
           where x.org_id = p.org_id and x.employee_id = p.employee_id and x.id <> p.id and x.started_at < p_end and coalesce(x.ended_at, p_end) > p.started_at
  ) q where t between p.started_at and p_end;
  for i in 1 .. coalesce(array_length(v_pts, 1), 1) - 1 loop
    v_a := v_pts[i]; v_b := v_pts[i + 1];
    select 1 + count(*) into v_n from pm.mfg_kiosk_punches x
     where x.org_id = p.org_id and x.employee_id = p.employee_id and x.id <> p.id and x.operation_id is not null
       and x.started_at <= v_a and coalesce(x.ended_at, p_end) >= v_b;
    v_sec := v_sec + extract(epoch from (v_b - v_a)) / greatest(v_n, 1);
  end loop;
  return round(v_sec / 60.0)::int;
end $$;

-- One kiosk event (also the offline replay path, one element of p_events at a time):
--   {client_event_id, session_token, action START|STOP|PAUSE|COMPLETE|INDIRECT_START|INDIRECT_STOP|REMAKE,
--    operation_id, good_qty, scrap_qty, reason, indirect_code, at, part_label, remake_reason}
-- STOP / PAUSE / COMPLETE close the worker's punch on that operation into a SUBMITTED time entry (split
-- minutes); COMPLETE also completes the operation (pm.complete_operation). Replays return the first answer.
create or replace function pm._mfg_kiosk_event(p_org uuid, p_location uuid, e jsonb) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_cid text := btrim(coalesce(e ->> 'client_event_id', '')); v_prev jsonb; ses pm.mfg_kiosk_sessions%rowtype; v_act text := upper(coalesce(e ->> 'action', ''));
        v_at timestamptz; v_op pm.wo_operations%rowtype; w pm.work_orders%rowtype; p pm.mfg_kiosk_punches%rowtype; v_min int; v_te uuid; v_res jsonb; v_id uuid;
        v_good numeric := pm._x_try_num(e ->> 'good_qty'); v_scrap numeric := coalesce(pm._x_try_num(e ->> 'scrap_qty'), 0); v_code text;
begin
  if char_length(v_cid) < 8 then return jsonb_build_object('ok', false, 'error', 'PM_INVALID: client_event_id'); end if;
  select x.result into v_prev from pm.mfg_kiosk_events x where x.org_id = p_org and x.client_event_id = v_cid;
  if v_prev is not null then return v_prev || jsonb_build_object('replay', true); end if;
  select * into ses from pm.mfg_kiosk_sessions s where s.token_hash = pm._x_sha256(coalesce(e ->> 'session_token', '')) and s.org_id = p_org and s.location_id = p_location;
  if ses.id is null then return jsonb_build_object('ok', false, 'error', 'PM_KIOSK_SESSION: scan the badge again'); end if;
  v_at := coalesce(pm._x_try_ts(e ->> 'at'), now());
  if v_at > now() + interval '2 minutes' then v_at := now(); end if;
  if v_at > ses.expires_at or v_at < ses.started_at - interval '1 minute' then
    return jsonb_build_object('ok', false, 'error', 'PM_KIOSK_SESSION: the event is outside the badge session');
  end if;
  if v_act in ('START','STOP','PAUSE','COMPLETE','REMAKE') then
    select * into v_op from pm.wo_operations o where o.org_id = p_org and o.id = pm.access_try_uuid(e ->> 'operation_id');
    if v_op.id is null then return jsonb_build_object('ok', false, 'error', 'PM_UNKNOWN_OPERATION'); end if;
    select * into w from pm.work_orders x where x.org_id = p_org and x.id = v_op.work_order_id;
    if w.location_id <> p_location then return jsonb_build_object('ok', false, 'error', 'PM_INVALID: the operation is at another company'); end if;
  end if;
  begin
    if v_act = 'START' then
      if exists (select 1 from pm.mfg_kiosk_punches x where x.org_id = p_org and x.employee_id = ses.employee_id and x.operation_id = v_op.id and x.ended_at is null) then
        v_res := jsonb_build_object('ok', true, 'note', 'already running');
      else
        if v_op.status in ('PENDING','READY') then perform pm.start_operation(v_op.id, ses.employee_id); end if;
        insert into pm.mfg_kiosk_punches (org_id, location_id, employee_id, job_id, work_order_id, operation_id, started_at, start_event_id)
        values (p_org, p_location, ses.employee_id, v_op.job_id, v_op.work_order_id, v_op.id, v_at, v_cid) returning id into v_id;
        v_res := jsonb_build_object('ok', true, 'punch_id', v_id, 'running', (select count(*) from pm.mfg_kiosk_punches x where x.org_id = p_org and x.employee_id = ses.employee_id and x.ended_at is null));
      end if;
    elsif v_act in ('STOP','PAUSE','COMPLETE') then
      select * into p from pm.mfg_kiosk_punches x where x.org_id = p_org and x.employee_id = ses.employee_id and x.operation_id = v_op.id and x.ended_at is null
       order by x.started_at desc limit 1 for update;
      if p.id is null and v_act <> 'COMPLETE' then
        v_res := jsonb_build_object('ok', false, 'error', 'PM_KIOSK_NOT_RUNNING: that operation is not running for you');
      else
        if p.id is not null then
          v_min := pm._mfg_split_minutes(p.id, greatest(v_at, p.started_at));
          update pm.mfg_kiosk_punches set ended_at = greatest(v_at, p.started_at), end_event_id = v_cid, split_minutes = v_min, good_qty = v_good,
                 scrap_qty = v_scrap, pause_reason = case when v_act = 'PAUSE' then nullif(left(e ->> 'reason', 120), '') end
           where id = p.id;
          if v_min > 0 then
            insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, pay_type, billable, notes, approval_state, operation_id, source_ref, created_by)
            values (p_org, v_op.job_id, ses.employee_id, (p.started_at)::date, least(round(v_min / 60.0, 2), 24), 'REG', false,
                    left(format('%s op %s %s', w.number, v_op.seq, v_op.name), 300), 'SUBMITTED', v_op.id, 'pm:kiosk:' || p.id::text, pm.current_user_id())
            returning id into v_te;
            update pm.mfg_kiosk_punches set time_entry_id = v_te where id = p.id;
          end if;
        end if;
        if v_act = 'COMPLETE' and v_op.status in ('PENDING','READY','IN_PROGRESS') then
          perform pm.complete_operation(v_op.id, coalesce(v_min, 0), v_good, v_scrap, nullif(left(e ->> 'reason', 300), ''));
        end if;
        v_res := jsonb_build_object('ok', true, 'punch_id', p.id, 'minutes', coalesce(v_min, 0), 'time_entry_id', v_te, 'completed', v_act = 'COMPLETE');
      end if;
    elsif v_act = 'INDIRECT_START' then
      v_code := upper(coalesce(e ->> 'indirect_code', 'OTHER'));
      if v_code not in ('CLEANUP','MAINTENANCE','TRAINING','MEETING','WAITING_MATERIAL','OTHER') then v_code := 'OTHER'; end if;
      insert into pm.mfg_kiosk_punches (org_id, location_id, employee_id, indirect_code, started_at, start_event_id)
      values (p_org, p_location, ses.employee_id, v_code, v_at, v_cid) returning id into v_id;
      v_res := jsonb_build_object('ok', true, 'punch_id', v_id);
    elsif v_act = 'INDIRECT_STOP' then
      update pm.mfg_kiosk_punches set ended_at = greatest(v_at, started_at), end_event_id = v_cid,
             split_minutes = round(extract(epoch from (greatest(v_at, started_at) - started_at)) / 60.0)::int
       where org_id = p_org and employee_id = ses.employee_id and indirect_code is not null and ended_at is null;
      v_res := jsonb_build_object('ok', true);
    elsif v_act = 'REMAKE' then
      v_id := pm._mfg_create_remake(p_org, v_op.work_order_id, v_op.id, e ->> 'part_label', coalesce(e ->> 'remake_reason', 'OTHER'),
                                    coalesce(pm._x_try_num(e ->> 'qty'), 1), e ->> 'reason', '{}'::uuid[], 'STATION', ses.employee_id);
      v_res := jsonb_build_object('ok', true, 'remake_id', v_id);
    else
      v_res := jsonb_build_object('ok', false, 'error', 'PM_INVALID: action');
    end if;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'error', left(sqlerrm, 300));
  end;
  if coalesce((v_res ->> 'ok')::boolean, false) then
    insert into pm.mfg_kiosk_events (org_id, client_event_id, employee_id, action, result) values (p_org, v_cid, ses.employee_id, v_act, v_res)
    on conflict do nothing;
  end if;
  return v_res || jsonb_build_object('client_event_id', v_cid);
end $$;

-- Batch entry (live taps and the offline queue). At most 200 events per call; results in order.
create or replace function pm.mfg_kiosk_events(p_location uuid, p_events jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); e jsonb; v_out jsonb := '[]';
begin
  if jsonb_typeof(coalesce(p_events, 'null')) <> 'array' or jsonb_array_length(p_events) > 200 then
    raise exception 'PM_INVALID: events must be an array of at most 200' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_events) x order by coalesce(x ->> 'at', '') loop
    v_out := v_out || pm._mfg_kiosk_event(v_org, p_location, e);
  end loop;
  return jsonb_build_object('results', v_out);
end $$;

-- Forgotten clock-outs for the shop lead (open longer than the shop's threshold).
create or replace view pm.v_mfg_open_punches with (security_invoker = on) as
select p.org_id, p.location_id, p.id as punch_id, p.employee_id, p.job_id, p.work_order_id, p.operation_id, p.indirect_code, p.started_at,
       round((extract(epoch from (now() - p.started_at)) / 3600.0)::numeric, 2) as open_hours
from pm.mfg_kiosk_punches p where p.ended_at is null;

-- M6. Remakes / cost of quality ------------------------------------------------------
create table if not exists pm.mfg_remakes (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  work_order_id          uuid not null,
  operation_id           uuid,
  part_label             text,
  reason_code            text not null check (reason_code in ('MACHINING','MATERIAL_DEFECT','ASSEMBLY','FINISH','DAMAGE_SHOP','DAMAGE_FIELD',
                                                              'MEASURE','DESIGN','MISSING','OTHER')),
  source                 text not null default 'STATION' check (source in ('STATION','FIELD','QC')),
  qty                    numeric(12,4) not null default 1 check (qty > 0),
  notes                  text,
  photo_document_ids     uuid[] not null default '{}',
  status                 text not null default 'REQUESTED' check (status in ('REQUESTED','APPROVED','REJECTED','DONE')),
  remake_work_order_id   uuid,
  est_material_cents     bigint check (est_material_cents is null or est_material_cents >= 0),
  reported_by_employee_id uuid references core.employees(id),
  decided_by             text,
  decided_at             timestamptz,
  decision_note          text,
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, work_order_id) references pm.work_orders (org_id, job_id, id) deferrable initially immediate
);
create index if not exists pm_mfg_remakes_idx on pm.mfg_remakes (org_id, job_id, status);

create or replace function pm._mfg_create_remake(p_org uuid, p_wo uuid, p_op uuid, p_part_label text, p_reason text, p_qty numeric, p_notes text,
                                                 p_photos uuid[], p_source text, p_employee uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_id uuid;
begin
  select * into w from pm.work_orders x where x.org_id = p_org and x.id = p_wo;
  if w.id is null or w.kind <> 'PRODUCTION' then raise exception 'PM_INVALID: remakes come from a production order' using errcode = '22023'; end if;
  if upper(coalesce(p_reason, '')) not in ('MACHINING','MATERIAL_DEFECT','ASSEMBLY','FINISH','DAMAGE_SHOP','DAMAGE_FIELD','MEASURE','DESIGN','MISSING','OTHER') then
    raise exception 'PM_INVALID: remake reason %', p_reason using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_photos, '{}')) d where not exists (select 1 from public.documents x where x.id = d and x.org_id = p_org)) then
    raise exception 'PM_INVALID: a photo is not a document of this organization' using errcode = '22023';
  end if;
  insert into pm.mfg_remakes (org_id, job_id, work_order_id, operation_id, part_label, reason_code, source, qty, notes, photo_document_ids, reported_by_employee_id)
  values (p_org, w.job_id, w.id, p_op, nullif(left(p_part_label, 80), ''), upper(p_reason), coalesce(p_source, 'STATION'), coalesce(p_qty, 1),
          nullif(left(p_notes, 2000), ''), coalesce(p_photos, '{}'), p_employee)
  returning id into v_id;
  perform pm.log_activity(p_org, w.location_id, w.job_id, 'production.remake_requested', 'mfg_remakes', v_id,
    format('Remake requested on %s: %s', w.number, coalesce(p_part_label, lower(p_reason))), jsonb_build_object('reason', upper(p_reason)));
  return v_id;
end $$;

create or replace function pm.mfg_request_remake(p_wo uuid, p_part_label text, p_reason text, p_qty numeric default 1, p_notes text default null,
                                                 p_photos uuid[] default '{}', p_source text default 'STATION', p_op uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.work_orders%rowtype; v_emp uuid;
begin
  select * into w from pm.work_orders x where x.id = p_wo;
  if w.org_id is null or w.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: work order % not found in the caller''s organization', p_wo using errcode = '42501';
  end if;
  if p_source not in ('STATION','FIELD','QC') then raise exception 'PM_INVALID: source %', p_source using errcode = '22023'; end if;
  select x into v_emp from pm.my_employee_ids() x limit 1;
  return pm._mfg_create_remake(w.org_id, w.id, p_op, p_part_label, p_reason, p_qty, p_notes, p_photos, p_source, v_emp);
end $$;

-- Approve (a remake production order opens, linked to the original; cost of quality tag) or reject.
-- The approver cannot be the person who reported it (preparer ≠ approver).
create or replace function pm.mfg_decide_remake(p_remake uuid, p_approve boolean, p_note text default null, p_est_material_cents bigint default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.mfg_remakes%rowtype; w pm.work_orders%rowtype; v_wo uuid;
begin
  select * into r from pm.mfg_remakes x where x.id = p_remake for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: remake % not found in the caller''s organization', p_remake using errcode = '42501';
  end if;
  if r.status <> 'REQUESTED' then raise exception 'PM_REMAKE_DECIDED: this remake is %', lower(r.status) using errcode = '22023'; end if;
  if r.created_by is not null and r.created_by = pm.current_user_id() then
    raise exception 'PM_SOD_VIOLATION: the person who reported a remake does not approve it' using errcode = '42501';
  end if;
  if p_est_material_cents is not null and not pm.access_can_job('projects.financials', 'edit', r.job_id) then
    raise exception 'PM_FORBIDDEN: a material estimate needs projects.financials:edit' using errcode = '42501';
  end if;
  select * into w from pm.work_orders x where x.org_id = r.org_id and x.id = r.work_order_id;
  if p_approve then
    v_wo := pm.create_production_order(r.job_id, left(format('Remake %s (%s)', coalesce(r.part_label, w.number), lower(r.reason_code)), 200), r.qty,
                                       w.routing_id, null, w.wbs_id, w.id);
    update pm.work_orders set drawings_approved_at = w.drawings_approved_at, drawings_approved_by = w.drawings_approved_by where id = v_wo;
  end if;
  update pm.mfg_remakes set status = case when p_approve then 'APPROVED' else 'REJECTED' end, remake_work_order_id = v_wo,
         decided_by = pm.current_user_id(), decided_at = now(), decision_note = nullif(left(p_note, 1000), ''),
         est_material_cents = coalesce(p_est_material_cents, est_material_cents)
   where id = r.id;
  return jsonb_build_object('remake_id', r.id, 'status', case when p_approve then 'APPROVED' else 'REJECTED' end, 'remake_work_order_id', v_wo);
end $$;

-- Cost of quality by reason: count, qty, remake shop minutes (actual on remake orders) and material $
-- (projects.financials only).
create or replace function pm.mfg_cost_of_quality(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_fin boolean; v_out jsonb; v_from date := coalesce(p_from, current_date - 90); v_to date := coalesce(p_to, current_date);
        v_total_min numeric;
begin
  v_fin := pm._x_sees('projects.financials', 'view', p_location);
  select coalesce(sum(o.actual_minutes), 0) into v_total_min
    from pm.wo_operations o join pm.work_orders w on w.org_id = o.org_id and w.id = o.work_order_id
   where o.org_id = v_org and w.location_id = p_location and w.kind = 'PRODUCTION' and o.completed_at >= v_from and o.completed_at < v_to + 1;
  select coalesce(jsonb_agg(x order by x ->> 'reason_code'), '[]') into v_out from (
    select jsonb_build_object('reason_code', r.reason_code, 'remakes', count(*), 'qty', sum(r.qty),
             'remake_minutes', coalesce(sum((select sum(o.actual_minutes) from pm.wo_operations o where o.org_id = r.org_id and o.work_order_id = r.remake_work_order_id)), 0),
             'material_cents', case when v_fin then sum(coalesce(r.est_material_cents, 0)) end) as x
      from pm.mfg_remakes r join core.jobs j on j.org_id = r.org_id and j.id = r.job_id
     where r.org_id = v_org and j.location_id = p_location and r.created_at >= v_from and r.created_at < v_to + 1 and r.status <> 'REJECTED'
     group by r.reason_code) q;
  return jsonb_build_object('from', v_from, 'to', v_to, 'by_reason', v_out, 'shop_minutes', v_total_min,
    'remake_minutes', (select coalesce(sum((e ->> 'remake_minutes')::numeric), 0) from jsonb_array_elements(v_out) e),
    'remake_share', case when v_total_min > 0 then round((select coalesce(sum((e ->> 'remake_minutes')::numeric), 0) from jsonb_array_elements(v_out) e) / v_total_min, 4) end,
    'amounts_visible', v_fin);
end $$;

-- M7. MRP-lite: demand → POs → receiving ----------------------------------------------
create table if not exists pm.mfg_material_settings (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  material_key         text not null check (char_length(material_key) between 1 and 160),
  item_id              uuid,
  description          text,
  uom                  text not null default 'EA',
  lead_days            int not null default 7 check (lead_days between 0 and 365),
  pack_qty             numeric(14,4) check (pack_qty is null or pack_qty > 0),
  min_qty              numeric(14,4) check (min_qty is null or min_qty >= 0),
  preferred_vendor_id  uuid references core.vendors(id),
  last_cost_cents      bigint check (last_cost_cents is null or last_cost_cents >= 0),
  cost_code_id         uuid,
  is_long_lead         boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, location_id, material_key),
  unique (org_id, id),
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

-- Demand rows (one production order, or every open one at the company): BOM material by key, net of
-- what was issued to that order, on hand at the company and open PO quantity; need-by = scheduled
-- start (or promised date) minus nothing; long-lead when lead time runs past the need-by date.
create or replace function pm._mfg_demand_rows(p_org uuid, p_location uuid, p_wo uuid default null) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_out jsonb;
begin
  with dem as (
    select coalesce(b.item_id::text, pm.mfg_material_key(b.line_kind, b.material, b.thickness_mm, b.part_code)) as key,
           b.item_id, min(b.description) as description, b.uom, b.line_kind, sum(b.qty) as qty,
           min(coalesce(w.scheduled_start::date, w.promised_on, w.due_on)) as need_by,
           array_agg(distinct w.number) as orders
      from pm.bom_lines b join pm.work_orders w on w.org_id = b.org_id and w.id = b.work_order_id
     where b.org_id = p_org and w.location_id = p_location and w.kind = 'PRODUCTION' and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')
       and (p_wo is null or w.id = p_wo) and b.line_kind in ('SHEET','LUMBER','EDGEBAND','HARDWARE','BUYOUT','FINISH','CONSUMABLE')
     group by 1, 2, 4, 5
  ), iss as (
    select m.item_id, sum(m.qty) as qty from pm.material_moves m join pm.work_orders w on w.org_id = m.org_id and w.id = m.work_order_id
     where m.org_id = p_org and m.location_id = p_location and m.kind = 'ISSUE' and w.status in ('NEW','RELEASED','IN_PROGRESS','ON_HOLD')
       and (p_wo is null or w.id = p_wo)
     group by 1
  ), oh as (
    select s.item_id, sum(s.qty_on_hand) as qty from pm.v_stock_on_hand s where s.org_id = p_org and s.location_id = p_location group by 1
  ), po as (
    select l.item_id, sum(greatest(coalesce(l.qty, 0) - l.received_qty, 0)) as qty
      from pm.commitment_lines l join pm.commitments c on c.org_id = l.org_id and c.id = l.commitment_id
     where l.org_id = p_org and c.location_id = p_location and c.status in ('DRAFT','APPROVED','EXECUTED') and l.item_id is not null
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', d.key, 'item_id', d.item_id, 'description', coalesce(ms.description, d.description), 'uom', d.uom, 'kind', d.line_kind,
           'required_qty', d.qty, 'issued_qty', coalesce(i.qty, 0), 'on_hand_qty', coalesce(o.qty, 0), 'on_order_qty', coalesce(p.qty, 0),
           'short_qty', greatest(d.qty - coalesce(i.qty, 0) - coalesce(o.qty, 0) - coalesce(p.qty, 0), 0),
           'suggested_qty', case when greatest(d.qty - coalesce(i.qty, 0) - coalesce(o.qty, 0) - coalesce(p.qty, 0), 0) = 0 then 0
                                 when ms.pack_qty is not null then ceil(greatest(d.qty - coalesce(i.qty, 0) - coalesce(o.qty, 0) - coalesce(p.qty, 0), 0) / ms.pack_qty) * ms.pack_qty
                                 else greatest(d.qty - coalesce(i.qty, 0) - coalesce(o.qty, 0) - coalesce(p.qty, 0), 0) end,
           'need_by', d.need_by, 'lead_days', coalesce(ms.lead_days, 7), 'order_by', d.need_by - coalesce(ms.lead_days, 7),
           'long_lead', coalesce(ms.is_long_lead, false) or (d.need_by is not null and current_date + coalesce(ms.lead_days, 7) > d.need_by),
           'vendor_id', ms.preferred_vendor_id, 'orders', to_jsonb(d.orders)) order by d.need_by nulls last, d.key), '[]')
    into v_out
    from dem d
    left join iss i on i.item_id = d.item_id
    left join oh o on o.item_id = d.item_id
    left join po p on p.item_id = d.item_id
    left join pm.mfg_material_settings ms on ms.org_id = p_org and ms.location_id = p_location
         and (ms.item_id = d.item_id or upper(ms.material_key) = upper(d.key));
  return v_out;
end $$;

create or replace function pm.mfg_material_demand(p_location uuid, p_wo uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location);
begin
  if p_wo is not null and not exists (select 1 from pm.work_orders w where w.org_id = v_org and w.id = p_wo and w.location_id = p_location) then
    raise exception 'PM_INVALID: the work order is not at this company' using errcode = '22023';
  end if;
  return jsonb_build_object('location_id', p_location, 'rows', pm._mfg_demand_rows(v_org, p_location, p_wo));
end $$;

-- Draft PO(s) from demand lines for one job: [{item_id, description, qty, uom, unit_cost_cents, cost_code_id}].
-- One DRAFT commitment per call (1113 routes its approval); Books' AP does the three-way match.
create or replace function pm.mfg_create_po_from_demand(p_job uuid, p_vendor uuid, p_lines jsonb, p_title text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; e jsonb; n int := 0; v_cc uuid; v_qty numeric; v_unit bigint; v_num text;
begin
  select * into j from pm._x_job(p_job);
  if p_vendor is null or not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = j.org_id) then
    raise exception 'PM_UNKNOWN_VENDOR: pick the vendor' using errcode = '23503';
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 500 then
    raise exception 'PM_INVALID: a PO needs 1–500 lines' using errcode = '22023';
  end if;
  insert into pm.commitments (org_id, job_id, vendor_id, commitment_type, title, status)
  values (j.org_id, p_job, p_vendor, 'PO', coalesce(nullif(left(p_title, 200), ''), 'Material from demand'), 'DRAFT') returning id, number into v_id, v_num;
  for e in select * from jsonb_array_elements(p_lines) loop
    v_qty := pm._x_try_num(e ->> 'qty');
    continue when coalesce(v_qty, 0) <= 0;
    v_unit := greatest(coalesce(pm._x_try_bigint(e ->> 'unit_cost_cents'), 0), 0);
    v_cc := coalesce(pm.access_try_uuid(e ->> 'cost_code_id'),
                     (select ms.cost_code_id from pm.mfg_material_settings ms where ms.org_id = j.org_id and ms.location_id = j.location_id
                        and ms.item_id = pm.access_try_uuid(e ->> 'item_id') limit 1));
    n := n + 1;
    insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, item_id, qty, uom, unit_cost_cents, amount_cents)
    values (j.org_id, v_id, n, v_cc, 'MATERIALS', left(coalesce(nullif(e ->> 'description', ''), 'Material'), 300), pm.access_try_uuid(e ->> 'item_id'),
            v_qty, coalesce(nullif(e ->> 'uom', ''), 'EA'), v_unit, round(v_qty * v_unit)::bigint);
  end loop;
  if n = 0 then raise exception 'PM_INVALID: no line had a quantity' using errcode = '22023'; end if;
  return jsonb_build_object('commitment_id', v_id, 'number', v_num, 'lines', n);
end $$;

-- Receive a PO line (pm.record_receipt → JOB_COMMITMENT received-to-date) and, with a stock location,
-- put it in stock (pm.record_material_move RECEIPT; JOB_MATERIAL reserved for Books).
create or replace function pm.mfg_receive_po_line(p_line uuid, p_qty numeric, p_stock_location uuid default null, p_note text default null,
                                                  p_packing_slip text default null, p_document uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.commitment_lines%rowtype; c pm.commitments%rowtype; v_rec uuid; v_move uuid;
begin
  select * into l from pm.commitment_lines x where x.id = p_line;
  if l.org_id is null or l.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: PO line % not found in the caller''s organization', p_line using errcode = '42501';
  end if;
  select * into c from pm.commitments x where x.org_id = l.org_id and x.id = l.commitment_id;
  v_rec := pm.record_receipt(p_line, p_qty, current_date, nullif(left(p_note, 500), ''), p_document, null, nullif(left(p_packing_slip, 80), ''));
  if p_stock_location is not null and l.item_id is not null then
    v_move := pm.record_material_move('RECEIPT', l.item_id, p_qty, null, p_stock_location, null, null, coalesce(l.uom, 'EA'), c.number,
                                      'pm:mfgrcv:' || v_rec::text, null, nullif(left(p_note, 500), ''), l.description);
  end if;
  return jsonb_build_object('receipt_id', v_rec, 'move_id', v_move);
end $$;

-- M8. Install scheduling ---------------------------------------------------------------
create table if not exists pm.mfg_installs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  wbs_id          uuid,
  crew_id         uuid,
  starts_on       date not null,
  ends_on         date not null,
  site_ready_on   date,
  status          text not null default 'PLANNED' check (status in ('PLANNED','CONFIRMED','IN_PROGRESS','DONE','CANCELLED')),
  conflicts       jsonb not null default '[]' check (jsonb_typeof(conflicts) = 'array'),
  notes           text,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  check (ends_on >= starts_on),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate,
  foreign key (org_id, crew_id) references pm.crews (org_id, id) deferrable initially immediate
);

-- Conflicts of an install: crew double-booked, production not done in time (open production orders
-- promised after the start minus the buffer), GC site not ready.
create or replace function pm._mfg_install_conflicts(p_install uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare i pm.mfg_installs%rowtype; v_loc uuid; s pm.mfg_settings; v jsonb := '[]'; r record;
begin
  select * into i from pm.mfg_installs x where x.id = p_install;
  select j.location_id into v_loc from core.jobs j where j.org_id = i.org_id and j.id = i.job_id;
  s := pm._mfg_settings(i.org_id, v_loc);
  if i.crew_id is not null then
    for r in select x.id, j.job_number, x.starts_on, x.ends_on from pm.mfg_installs x join core.jobs j on j.org_id = x.org_id and j.id = x.job_id
              where x.org_id = i.org_id and x.crew_id = i.crew_id and x.id <> i.id and x.status not in ('CANCELLED','DONE')
                and x.starts_on <= i.ends_on and x.ends_on >= i.starts_on loop
      v := v || jsonb_build_object('code', 'CREW_OVERLAP', 'install_id', r.id, 'job', r.job_number, 'starts_on', r.starts_on, 'ends_on', r.ends_on);
    end loop;
  end if;
  for r in select w.id, w.number, w.status, coalesce(w.promised_on, w.due_on) as ready_on from pm.work_orders w
            where w.org_id = i.org_id and w.job_id = i.job_id and w.kind = 'PRODUCTION' and w.status not in ('COMPLETE','CLOSED','CANCELLED')
              and (i.wbs_id is null or w.wbs_id is null or w.wbs_id = i.wbs_id) loop
    if r.ready_on is null or r.ready_on > i.starts_on - s.install_buffer_days then
      v := v || jsonb_build_object('code', 'PRODUCTION_NOT_READY', 'work_order_id', r.id, 'work_order', r.number, 'status', r.status, 'ready_on', r.ready_on);
    end if;
  end loop;
  if i.site_ready_on is not null and i.site_ready_on > i.starts_on then
    v := v || jsonb_build_object('code', 'SITE_NOT_READY', 'site_ready_on', i.site_ready_on);
  end if;
  return v;
end $$;

create or replace function pm.mfg_schedule_install(p_job uuid, p_starts_on date, p_ends_on date, p_crew uuid default null, p_site_ready_on date default null,
                                                   p_wbs uuid default null, p_install uuid default null, p_notes text default null, p_status text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid := p_install; v_conf jsonb;
begin
  select * into j from pm._x_job(p_job);
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then raise exception 'PM_INVALID: install dates' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('PLANNED','CONFIRMED','IN_PROGRESS','DONE','CANCELLED') then raise exception 'PM_INVALID: status' using errcode = '22023'; end if;
  if p_crew is not null and not exists (select 1 from pm.crews c where c.org_id = j.org_id and c.id = p_crew and c.location_id = j.location_id) then
    raise exception 'PM_INVALID: the crew is not at this company' using errcode = '22023';
  end if;
  if v_id is null then
    insert into pm.mfg_installs (org_id, job_id, wbs_id, crew_id, starts_on, ends_on, site_ready_on, notes, status)
    values (j.org_id, p_job, p_wbs, p_crew, p_starts_on, p_ends_on, p_site_ready_on, nullif(left(p_notes, 2000), ''), coalesce(p_status, 'PLANNED'))
    returning id into v_id;
  else
    update pm.mfg_installs set wbs_id = p_wbs, crew_id = p_crew, starts_on = p_starts_on, ends_on = p_ends_on, site_ready_on = p_site_ready_on,
           notes = coalesce(nullif(left(p_notes, 2000), ''), notes), status = coalesce(p_status, status), updated_at = now()
     where id = v_id and org_id = j.org_id and job_id = p_job;
    if not found then raise exception 'PM_INVALID: install % is not on this job', v_id using errcode = '22023'; end if;
  end if;
  v_conf := pm._mfg_install_conflicts(v_id);
  update pm.mfg_installs set conflicts = v_conf where id = v_id;
  return jsonb_build_object('install_id', v_id, 'conflicts', v_conf);
end $$;

create or replace function pm.mfg_install_board(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_from date := coalesce(p_from, current_date - 7); v_to date := coalesce(p_to, current_date + 60);
begin
  return jsonb_build_object('from', v_from, 'to', v_to, 'installs', coalesce((
    select jsonb_agg(jsonb_build_object('install_id', i.id, 'job_id', i.job_id, 'job', j.job_number, 'job_name', j.name, 'crew_id', i.crew_id, 'crew', c.name,
             'starts_on', i.starts_on, 'ends_on', i.ends_on, 'site_ready_on', i.site_ready_on, 'status', i.status,
             'conflicts', pm._mfg_install_conflicts(i.id)) order by i.starts_on, j.job_number)
      from pm.mfg_installs i join core.jobs j on j.org_id = i.org_id and j.id = i.job_id left join pm.crews c on c.org_id = i.org_id and c.id = i.crew_id
     where i.org_id = v_org and j.location_id = p_location and i.status <> 'CANCELLED' and i.starts_on <= v_to and i.ends_on >= v_from
       and j.id in (select pm.my_job_ids())), '[]'));
end $$;

-- ============================================================================
-- F. Flooring (retail + install)
-- ============================================================================

create table if not exists pm.flr_settings (
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  remnant_min_in         int not null default 24 check (remnant_min_in between 0 and 600),
  remnant_max_in         int not null default 144 check (remnant_max_in between 0 and 1200),
  default_deposit_pct    numeric(5,4) not null default 0.50 check (default_deposit_pct between 0 and 1),
  required_site_checks   text[] not null default array['MOISTURE','OLD_FLOOR_REMOVED'],
  default_waste          jsonb not null default '{"CARPET":0.10,"LVP":0.08,"LAMINATE":0.08,"HARDWOOD":0.10,"TILE":0.12,"VINYL_SHEET":0.10,"RUBBER":0.05,"OTHER":0.10}'
                           check (jsonb_typeof(default_waste) = 'object'),
  updated_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (org_id, location_id),
  check (remnant_max_in >= remnant_min_in)
);

create or replace function pm._flr_settings(p_org uuid, p_location uuid) returns pm.flr_settings
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.flr_settings%rowtype;
begin
  select * into s from pm.flr_settings x where x.org_id = p_org and x.location_id = p_location;
  if s.org_id is null then
    s.org_id := p_org; s.location_id := p_location; s.remnant_min_in := 24; s.remnant_max_in := 144; s.default_deposit_pct := 0.50;
    s.required_site_checks := array['MOISTURE','OLD_FLOOR_REMOVED'];
    s.default_waste := '{"CARPET":0.10,"LVP":0.08,"LAMINATE":0.08,"HARDWOOD":0.10,"TILE":0.12,"VINYL_SHEET":0.10,"RUBBER":0.05,"OTHER":0.10}';
  end if;
  return s;
end $$;

-- F1. Product file + labor price list -------------------------------------------------
create table if not exists pm.flr_products (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  item_id               uuid,
  sku                   text,
  style                 text not null check (char_length(btrim(style)) between 1 and 120),
  color                 text,
  mill_name             text,                 -- private label crossover: the mill's style name
  vendor_id             uuid references core.vendors(id),
  category              text not null check (category in ('CARPET','LVP','HARDWOOD','LAMINATE','TILE','VINYL_SHEET','RUBBER','PAD','SUNDRY','TRANSITION','OTHER')),
  sell_uom              text not null check (sell_uom in ('SY','SF','CARTON','LF','EA','ROLL')),
  roll_width_ft         numeric(6,2) check (roll_width_ft is null or roll_width_ft > 0),
  carton_sf             numeric(10,2) check (carton_sf is null or carton_sf > 0),
  waste_pct             numeric(5,4) check (waste_pct is null or (waste_pct >= 0 and waste_pct <= 1)),
  cost_cents            bigint check (cost_cents is null or cost_cents >= 0),        -- landed cost per sell unit (masked)
  price_retail_cents    bigint check (price_retail_cents is null or price_retail_cents >= 0),
  price_builder_cents   bigint check (price_builder_cents is null or price_builder_cents >= 0),
  price_contract_cents  bigint check (price_contract_cents is null or price_contract_cents >= 0),
  taxable               boolean not null default true,
  is_active             boolean not null default true,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  check (sell_uom <> 'CARTON' or carton_sf is not null)
);
create index if not exists pm_flr_products_idx on pm.flr_products (org_id, location_id, category, style);

create table if not exists pm.flr_labor_rates (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),
  code                   text not null check (code ~ '^[A-Z0-9_]{2,32}$'),
  description            text not null check (char_length(btrim(description)) between 1 and 160),
  unit                   text not null check (unit in ('SY','SF','LF','STEP','EA','JOB','HOUR')),
  applies_to             text not null default 'FLOOR' check (applies_to in ('FLOOR','STAIRS','PERIMETER','TRANSITION','PREP','DEMO','MOVING','OTHER')),
  categories             text[] not null default '{}',     -- product categories this rate is the default for
  sell_cents             bigint not null default 0 check (sell_cents >= 0),
  pay_cents              bigint not null default 0 check (pay_cents >= 0),         -- installer piece rate (masked: labor rates)
  job_minimum_pay_cents  bigint not null default 0 check (job_minimum_pay_cents >= 0),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

-- F2. UoM engine (mirrored exactly by apps/projects lib/flooring/uom.ts — integer hundredths, half-up).
--   gross SF = sf × (1 + waste);  SF → ⌈gross⌉;  SY (no roll width) → ⌈gross ÷ 9⌉ to the cent of a SY;
--   SY with a roll width → roll LF = ⌈gross ÷ width⌉, SY = LF × width ÷ 9 (half-up to 0.01);
--   ROLL → roll LF;  CARTON → ⌈gross ÷ carton SF⌉;  LF → ⌈lf × (1 + waste)⌉;  STEP → ⌈each⌉ (no waste);
--   EA → ⌈each × (1 + waste)⌉.
create or replace function pm.flr_material_qty(p_uom text, p_sf numeric, p_lf numeric, p_each numeric, p_waste numeric,
                                               p_carton_sf numeric default null, p_roll_width_ft numeric default null)
returns jsonb
language plpgsql immutable
as $$
declare v_sf bigint := round(coalesce(p_sf, 0) * 100); v_w bigint := round(coalesce(p_waste, 0) * 10000); v_gross bigint; v_qty numeric; v_lf bigint;
        v_width bigint; v_carton bigint; v_roll bigint; v_lf_c bigint;
begin
  if coalesce(p_sf, 0) < 0 or coalesce(p_lf, 0) < 0 or coalesce(p_each, 0) < 0 or coalesce(p_waste, 0) < 0 then
    raise exception 'PM_INVALID: quantities and waste must be ≥ 0' using errcode = '22023';
  end if;
  v_gross := (v_sf * (10000 + v_w) + 5000) / 10000;                               -- hundredths of a SF, half-up
  case upper(coalesce(p_uom, 'SF'))
    when 'SF' then v_qty := ceil(v_gross / 100.0);
    when 'SY' then
      if coalesce(p_roll_width_ft, 0) > 0 then
        v_width := round(p_roll_width_ft * 100);
        v_roll := ceil(v_gross::numeric / v_width);                               -- whole running feet off the roll
        v_qty := ((v_roll * v_width * 100 + 450) / 900)::bigint / 100.0;          -- SY to 0.01, half-up
      else
        v_qty := ceil(v_gross / 9.0) / 100.0;
      end if;
    when 'ROLL' then
      if coalesce(p_roll_width_ft, 0) <= 0 then raise exception 'PM_INVALID: a roll product needs a roll width' using errcode = '22023'; end if;
      v_width := round(p_roll_width_ft * 100);
      v_roll := ceil(v_gross::numeric / v_width);
      v_qty := v_roll;
    when 'CARTON' then
      if coalesce(p_carton_sf, 0) <= 0 then raise exception 'PM_INVALID: a carton product needs its coverage (SF per carton)' using errcode = '22023'; end if;
      v_carton := round(p_carton_sf * 100);
      v_qty := ceil(v_gross::numeric / v_carton);
    when 'LF' then
      v_lf_c := round(coalesce(p_lf, 0) * 100);
      v_qty := ceil(((v_lf_c * (10000 + v_w) + 5000) / 10000) / 100.0);
    when 'STEP' then v_qty := ceil(coalesce(p_each, 0));
    when 'EA' then v_qty := ceil(round(coalesce(p_each, 0) * 100) * (10000 + v_w) / 1000000.0);
    else raise exception 'PM_INVALID: unit %', p_uom using errcode = '22023';
  end case;
  return jsonb_build_object('uom', upper(coalesce(p_uom, 'SF')), 'qty', v_qty, 'net_sf', coalesce(p_sf, 0), 'gross_sf', v_gross / 100.0,
                            'roll_lf', v_roll, 'cartons', case when upper(p_uom) = 'CARTON' then v_qty end,
                            'covered_sf', case when upper(p_uom) = 'CARTON' then v_qty * v_carton / 100.0 end);
end $$;

-- F3. Measure file import (MeasureSquare / RFMS Measure / generic CSV, parsed in lib/flooring/measure-import.ts)
--   rooms: [{room, area_kind, category, sqft, linear_ft, each_count, waste_pct, notes}]
create or replace function pm.flr_import_measure(p_job uuid, p_source text, p_rooms jsonb, p_source_ref text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; s pm.flr_settings; v_id uuid; e jsonb; n int := 0; v_kind text; v_cat text; v_sf numeric := 0; v_w numeric;
begin
  select * into j from pm._x_job(p_job);
  if upper(coalesce(p_source, '')) not in ('MEASURESQUARE','RFMS','QFLOORS','IMPORT','MANUAL') then raise exception 'PM_INVALID: source %', p_source using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_rooms, 'null')) <> 'array' or jsonb_array_length(p_rooms) = 0 or jsonb_array_length(p_rooms) > 500 then
    raise exception 'PM_INVALID: a measure needs 1–500 rooms' using errcode = '22023';
  end if;
  s := pm._flr_settings(j.org_id, j.location_id);
  insert into pm.measures (org_id, job_id, source, source_ref, measured_on, notes)
  values (j.org_id, p_job, upper(p_source), nullif(left(p_source_ref, 200), ''), current_date, 'Imported from ' || initcap(lower(p_source)))
  returning id into v_id;
  for e in select * from jsonb_array_elements(p_rooms) loop
    continue when nullif(btrim(coalesce(e ->> 'room', '')), '') is null;
    v_kind := upper(coalesce(e ->> 'area_kind', 'FLOOR'));
    if v_kind not in ('FLOOR','STAIRS','WALL','BASE','TRANSITION','OTHER') then v_kind := 'OTHER'; end if;
    v_cat := upper(coalesce(e ->> 'category', ''));
    if v_cat not in ('CARPET','LVP','HARDWOOD','LAMINATE','TILE','VINYL_SHEET','RUBBER','OTHER') then v_cat := case when v_cat = '' then null else 'OTHER' end; end if;
    v_w := coalesce(pm._x_try_num(e ->> 'waste_pct'), (s.default_waste ->> coalesce(v_cat, 'OTHER'))::numeric, 0.10);
    n := n + 1;
    insert into pm.measure_areas (org_id, measure_id, job_id, room_name, area_kind, product_category, sqft, linear_ft, each_count, waste_pct,
                                  material_uom, sort, notes)
    values (j.org_id, v_id, p_job, left(btrim(e ->> 'room'), 120), v_kind, v_cat, greatest(coalesce(pm._x_try_num(e ->> 'sqft'), 0), 0),
            nullif(greatest(coalesce(pm._x_try_num(e ->> 'linear_ft'), 0), 0), 0), nullif(greatest(coalesce(pm._x_try_num(e ->> 'each_count'), 0), 0), 0),
            least(greatest(v_w, 0), 1), case v_kind when 'BASE' then 'LF' when 'TRANSITION' then 'EA' else 'SF' end, n, nullif(left(e ->> 'notes', 500), ''));
    v_sf := v_sf + greatest(coalesce(pm._x_try_num(e ->> 'sqft'), 0), 0);
  end loop;
  if n = 0 then raise exception 'PM_INVALID: no room had a name' using errcode = '22023'; end if;
  return jsonb_build_object('measure_id', v_id, 'version', (select version from pm.measures where id = v_id), 'rooms', n, 'sqft', v_sf);
end $$;

-- F4. Job settings (tax mode per job) + quote builder ----------------------------------
create table if not exists pm.flr_job_settings (
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                  uuid not null,
  tax_mode                text not null default 'RETAIL' check (tax_mode in ('RETAIL','REAL_PROPERTY','EXEMPT')),
  exemption_ref           text,
  exemption_expires_on    date,
  price_level             text not null default 'RETAIL' check (price_level in ('RETAIL','BUILDER','CONTRACT')),
  deposit_pct             numeric(5,4) check (deposit_pct is null or (deposit_pct >= 0 and deposit_pct <= 1)),
  required_site_checks    text[],
  updated_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (org_id, job_id),
  check (tax_mode <> 'EXEMPT' or exemption_ref is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.flr_set_job_settings(p_job uuid, p_tax_mode text, p_price_level text default 'RETAIL', p_exemption_ref text default null,
                                                   p_exemption_expires_on date default null, p_deposit_pct numeric default null,
                                                   p_required_site_checks text[] default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  if p_tax_mode = 'EXEMPT' and nullif(btrim(coalesce(p_exemption_ref, '')), '') is null then
    raise exception 'PM_INVALID: an exempt job needs the certificate number' using errcode = '22023';
  end if;
  if p_required_site_checks is not null and exists (select 1 from unnest(p_required_site_checks) x
       where x not in ('MOISTURE','OLD_FLOOR_REMOVED','FURNITURE_MOVED','HVAC_RUNNING','SUBFLOOR_FLAT','OTHER')) then
    raise exception 'PM_INVALID: unknown site check' using errcode = '22023';
  end if;
  insert into pm.flr_job_settings (org_id, job_id, tax_mode, exemption_ref, exemption_expires_on, price_level, deposit_pct, required_site_checks)
  values (j.org_id, p_job, coalesce(p_tax_mode, 'RETAIL'), nullif(btrim(coalesce(p_exemption_ref, '')), ''), p_exemption_expires_on,
          coalesce(p_price_level, 'RETAIL'), p_deposit_pct, p_required_site_checks)
  on conflict (org_id, job_id) do update set tax_mode = excluded.tax_mode, exemption_ref = excluded.exemption_ref,
     exemption_expires_on = excluded.exemption_expires_on, price_level = excluded.price_level, deposit_pct = excluded.deposit_pct,
     required_site_checks = excluded.required_site_checks, updated_by = pm.current_user_id(), updated_at = now();
  return p_job;
end $$;

create table if not exists pm.flr_quote_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  estimate_id        uuid not null,
  estimate_line_id   uuid not null,
  area_id            uuid,
  room               text,
  line_class         text not null check (line_class in ('MATERIAL','PAD','LABOR','ACCESSORY','FREIGHT','PREP','DEMO','MOVING')),
  tax_class          text not null check (tax_class in ('MATERIAL','LABOR','FREIGHT','SERVICE')),
  tier               text check (tier is null or tier in ('GOOD','BETTER','BEST')),
  product_id         uuid,
  labor_code         text,
  measured_qty       numeric(14,4),
  uom                text,
  waste_pct          numeric(5,4),
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (estimate_line_id),
  foreign key (org_id, estimate_id) references pm.estimates (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, estimate_line_id) references pm.estimate_lines (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm._flr_price(p pm.flr_products, p_level text) returns bigint
language sql immutable
as $$ select coalesce(case p_level when 'BUILDER' then p.price_builder_cents when 'CONTRACT' then p.price_contract_cents end, p.price_retail_cents, 0) $$;

-- Rooms of a measure + chosen products → estimate lines by room: material (UoM + waste), pad, install
-- labor on the net measured quantity, stairs per step, tack strip per perimeter LF, transitions, and
-- optional prep / demo / moving. Flags what a flooring estimator usually misses. The estimate stays a
-- DRAFT; sending it routes through the 1113 estimate approval when the margin is below the floor.
--   p_choices: [{area_id, product_id, pad_product_id, tier, prep, demo, moving}]
create or replace function pm.flr_build_quote(p_job uuid, p_measure uuid, p_choices jsonb, p_estimate uuid default null, p_title text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; js pm.flr_job_settings%rowtype; v_est uuid := p_estimate; e jsonb; a pm.measure_areas%rowtype; p pm.flr_products%rowtype; pad pm.flr_products%rowtype;
        lr pm.flr_labor_rates%rowtype; v_level text; q jsonb; v_line int := 0; v_flags jsonb := '[]'; v_tier text; v_uom text; v_w numeric; v_net numeric;
        v_has_trans boolean; v_n int := 0; r record; v_sy numeric;
begin
  select * into j from pm._x_job(p_job);
  if not exists (select 1 from pm.measures m where m.org_id = j.org_id and m.id = p_measure and m.job_id = p_job) then
    raise exception 'PM_INVALID: the measure is not on this job' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_choices, 'null')) <> 'array' or jsonb_array_length(p_choices) = 0 then
    raise exception 'PM_INVALID: choose a product for at least one room' using errcode = '22023';
  end if;
  select * into js from pm.flr_job_settings x where x.org_id = j.org_id and x.job_id = p_job;
  v_level := coalesce(js.price_level, 'RETAIL');
  if v_est is null then
    insert into pm.estimates (org_id, location_id, job_id, title) values (j.org_id, j.location_id, p_job, coalesce(nullif(left(p_title, 200), ''), 'Flooring quote'))
    returning id into v_est;
  elsif not exists (select 1 from pm.estimates x where x.org_id = j.org_id and x.id = v_est and x.job_id = p_job and x.status = 'DRAFT') then
    raise exception 'PM_ESTIMATE_LOCKED: rebuild a DRAFT estimate on this job' using errcode = '55000';
  end if;
  delete from pm.estimate_lines el where el.org_id = j.org_id and el.estimate_id = v_est and el.id in (select q2.estimate_line_id from pm.flr_quote_lines q2 where q2.org_id = j.org_id and q2.estimate_id = v_est);
  select coalesce(max(el.line_no), 0) into v_line from pm.estimate_lines el where el.org_id = j.org_id and el.estimate_id = v_est;
  select exists (select 1 from pm.measure_areas x where x.org_id = j.org_id and x.measure_id = p_measure and x.area_kind = 'TRANSITION') into v_has_trans;

  for e in select * from jsonb_array_elements(p_choices) loop
    select * into a from pm.measure_areas x where x.org_id = j.org_id and x.measure_id = p_measure and x.id = pm.access_try_uuid(e ->> 'area_id');
    continue when a.id is null;
    select * into p from pm.flr_products x where x.org_id = j.org_id and x.location_id = j.location_id and x.id = pm.access_try_uuid(e ->> 'product_id') and x.is_active;
    if p.id is null then raise exception 'PM_INVALID: pick an active product for %', a.room_name using errcode = '22023'; end if;
    v_tier := case when upper(e ->> 'tier') in ('GOOD','BETTER','BEST') then upper(e ->> 'tier') end;
    v_w := coalesce(p.waste_pct, a.waste_pct);
    v_uom := p.sell_uom;
    if a.area_kind in ('FLOOR','STAIRS','WALL','OTHER') then
      q := pm.flr_material_qty(v_uom, a.sqft, a.linear_ft, a.each_count, v_w, p.carton_sf, p.roll_width_ft);
      v_line := v_line + 1; v_n := v_n + 1;
      with ins as (
        insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
        values (j.org_id, v_est, v_line, left(format('%s — %s %s', a.room_name, p.style, coalesce(p.color, '')), 300), (q ->> 'qty')::numeric,
                case when v_uom = 'ROLL' then 'LF' else v_uom end, p.cost_cents, pm._flr_price(p, v_level),
                round((q ->> 'qty')::numeric * coalesce(p.cost_cents, 0))::bigint, round((q ->> 'qty')::numeric * pm._flr_price(p, v_level))::bigint, v_line)
        returning id)
      insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, product_id, measured_qty, uom, waste_pct)
      select j.org_id, v_est, ins.id, a.id, a.room_name, 'MATERIAL', 'MATERIAL', v_tier, p.id, a.sqft, v_uom, v_w from ins;
      -- pad under carpet: same SY as the carpet
      if p.category = 'CARPET' then
        select * into pad from pm.flr_products x where x.org_id = j.org_id and x.location_id = j.location_id and x.id = pm.access_try_uuid(e ->> 'pad_product_id') and x.is_active;
        if pad.id is null then
          v_flags := v_flags || jsonb_build_object('code', 'CARPET_NO_PAD', 'room', a.room_name);
        else
          v_sy := case when v_uom = 'SY' then (q ->> 'qty')::numeric else ceil(a.sqft * (1 + v_w) / 9.0 * 100) / 100.0 end;
          v_line := v_line + 1; v_n := v_n + 1;
          with ins as (
            insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
            values (j.org_id, v_est, v_line, left(format('%s — pad %s', a.room_name, pad.style), 300), v_sy, 'SY', pad.cost_cents, pm._flr_price(pad, v_level),
                    round(v_sy * coalesce(pad.cost_cents, 0))::bigint, round(v_sy * pm._flr_price(pad, v_level))::bigint, v_line)
            returning id)
          insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, product_id, measured_qty, uom, waste_pct)
          select j.org_id, v_est, ins.id, a.id, a.room_name, 'PAD', 'MATERIAL', v_tier, pad.id, v_sy, 'SY', v_w from ins;
        end if;
      end if;
      -- install labor (net measured, never the waste)
      select * into lr from pm.flr_labor_rates x where x.org_id = j.org_id and x.location_id = j.location_id and x.is_active
         and x.applies_to = case when a.area_kind = 'STAIRS' then 'STAIRS' else 'FLOOR' end
         and (cardinality(x.categories) = 0 or p.category = any (x.categories))
       order by cardinality(x.categories) desc, x.code limit 1;
      if lr.id is null then
        v_flags := v_flags || jsonb_build_object('code', case when a.area_kind = 'STAIRS' then 'STAIRS_NO_LABOR' else 'NO_INSTALL_LABOR' end, 'room', a.room_name);
      else
        v_net := case lr.unit when 'SY' then round(a.sqft / 9.0, 2) when 'SF' then a.sqft when 'STEP' then coalesce(a.each_count, 0)
                              when 'LF' then coalesce(a.linear_ft, 0) when 'EA' then coalesce(a.each_count, 1) else 1 end;
        if v_net > 0 then
          v_line := v_line + 1; v_n := v_n + 1;
          with ins as (
            insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
            values (j.org_id, v_est, v_line, left(format('%s — %s', a.room_name, lr.description), 300), v_net, lr.unit, lr.pay_cents, lr.sell_cents,
                    round(v_net * lr.pay_cents)::bigint, round(v_net * lr.sell_cents)::bigint, v_line)
            returning id)
          insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, labor_code, measured_qty, uom)
          select j.org_id, v_est, ins.id, a.id, a.room_name, 'LABOR', 'LABOR', v_tier, lr.code, v_net, lr.unit from ins;
        end if;
      end if;
      if a.area_kind = 'STAIRS' and coalesce(a.each_count, 0) = 0 then v_flags := v_flags || jsonb_build_object('code', 'STAIRS_NO_STEP_COUNT', 'room', a.room_name); end if;
      -- carpet perimeter: tack strip / binding
      if p.category = 'CARPET' and coalesce(a.linear_ft, 0) > 0 then
        select * into lr from pm.flr_labor_rates x where x.org_id = j.org_id and x.location_id = j.location_id and x.is_active and x.applies_to = 'PERIMETER'
           and (cardinality(x.categories) = 0 or 'CARPET' = any (x.categories)) order by x.code limit 1;
        if lr.id is not null then
          v_line := v_line + 1; v_n := v_n + 1;
          with ins as (
            insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
            values (j.org_id, v_est, v_line, left(format('%s — %s', a.room_name, lr.description), 300), a.linear_ft, lr.unit, lr.pay_cents, lr.sell_cents,
                    round(a.linear_ft * lr.pay_cents)::bigint, round(a.linear_ft * lr.sell_cents)::bigint, v_line)
            returning id)
          insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, labor_code, measured_qty, uom)
          select j.org_id, v_est, ins.id, a.id, a.room_name, 'ACCESSORY', 'LABOR', v_tier, lr.code, a.linear_ft, lr.unit from ins;
        end if;
      end if;
      if p.category in ('LVP','LAMINATE','HARDWOOD','TILE') and not v_has_trans then
        v_flags := v_flags || jsonb_build_object('code', 'HARD_SURFACE_NO_TRANSITION', 'room', a.room_name);
      end if;
      -- optional prep / demo / moving at the room's net SF
      for r in select x.* from pm.flr_labor_rates x
                where x.org_id = j.org_id and x.location_id = j.location_id and x.is_active
                  and ((x.applies_to = 'PREP' and coalesce(pm._x_try_bool(e ->> 'prep'), false)) or (x.applies_to = 'DEMO' and coalesce(pm._x_try_bool(e ->> 'demo'), false))
                    or (x.applies_to = 'MOVING' and coalesce(pm._x_try_bool(e ->> 'moving'), false)))
                  and (cardinality(x.categories) = 0 or p.category = any (x.categories)) loop
        v_net := case r.unit when 'SY' then round(a.sqft / 9.0, 2) when 'SF' then a.sqft else 1 end;
        continue when v_net <= 0;
        v_line := v_line + 1; v_n := v_n + 1;
        with ins as (
          insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
          values (j.org_id, v_est, v_line, left(format('%s — %s', a.room_name, r.description), 300), v_net, r.unit, r.pay_cents, r.sell_cents,
                  round(v_net * r.pay_cents)::bigint, round(v_net * r.sell_cents)::bigint, v_line)
          returning id)
        insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, labor_code, measured_qty, uom)
        select j.org_id, v_est, ins.id, a.id, a.room_name, r.applies_to, 'SERVICE', v_tier, r.code, v_net, r.unit from ins;
      end loop;
    elsif a.area_kind = 'TRANSITION' then
      v_line := v_line + 1; v_n := v_n + 1;
      with ins as (
        insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
        values (j.org_id, v_est, v_line, left(format('%s — %s', a.room_name, p.style), 300), coalesce(a.each_count, 1), 'EA', p.cost_cents, pm._flr_price(p, v_level),
                round(coalesce(a.each_count, 1) * coalesce(p.cost_cents, 0))::bigint, round(coalesce(a.each_count, 1) * pm._flr_price(p, v_level))::bigint, v_line)
        returning id)
      insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, product_id, measured_qty, uom)
      select j.org_id, v_est, ins.id, a.id, a.room_name, 'ACCESSORY', 'MATERIAL', v_tier, p.id, coalesce(a.each_count, 1), 'EA' from ins;
    elsif a.area_kind = 'BASE' then
      q := pm.flr_material_qty('LF', 0, a.linear_ft, 0, v_w);
      v_line := v_line + 1; v_n := v_n + 1;
      with ins as (
        insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, sort)
        values (j.org_id, v_est, v_line, left(format('%s — %s', a.room_name, p.style), 300), (q ->> 'qty')::numeric, 'LF', p.cost_cents, pm._flr_price(p, v_level),
                round((q ->> 'qty')::numeric * coalesce(p.cost_cents, 0))::bigint, round((q ->> 'qty')::numeric * pm._flr_price(p, v_level))::bigint, v_line)
        returning id)
      insert into pm.flr_quote_lines (org_id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, product_id, measured_qty, uom, waste_pct)
      select j.org_id, v_est, ins.id, a.id, a.room_name, 'ACCESSORY', 'MATERIAL', v_tier, p.id, a.linear_ft, 'LF', v_w from ins;
    end if;
  end loop;
  if v_n = 0 then raise exception 'PM_INVALID: no chosen room belongs to the measure' using errcode = '22023'; end if;
  return jsonb_build_object('estimate_id', v_est, 'lines', v_n, 'flags', v_flags, 'tax_mode', coalesce(js.tax_mode, 'RETAIL'), 'price_level', v_level,
                            'total_cents', (select e2.total_cents from pm.estimates e2 where e2.id = v_est));
end $$;

-- F5. Rolls, dye lots, cut tickets, remnants -------------------------------------------
create table if not exists pm.flr_rolls (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id),
  product_id            uuid not null,
  roll_number           text not null check (char_length(btrim(roll_number)) between 1 and 40),
  dye_lot               text not null check (char_length(btrim(dye_lot)) between 1 and 40),
  width_in              numeric(8,2) not null check (width_in > 0),
  original_len_in       numeric(10,2) not null check (original_len_in > 0),
  remaining_len_in      numeric(10,2) not null check (remaining_len_in >= 0),
  stock_location_id     uuid,
  bin                   text,
  status                text not null default 'AVAILABLE' check (status in ('AVAILABLE','RESERVED','REMNANT','DEPLETED','DAMAGED')),
  reserved_job_id       uuid,
  parent_roll_id        uuid,
  cost_per_lf_cents     bigint check (cost_per_lf_cents is null or cost_per_lf_cents >= 0),
  received_on           date not null default current_date,
  received_condition    text not null default 'GOOD' check (received_condition in ('GOOD','DAMAGED','SHORT')),
  procurement_item_id   uuid,
  notes                 text,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, location_id, product_id, roll_number),
  unique (org_id, id),
  check (remaining_len_in <= original_len_in),
  check ((status = 'RESERVED') = (reserved_job_id is not null)),
  foreign key (org_id, product_id) references pm.flr_products (org_id, id) deferrable initially immediate,
  foreign key (org_id, stock_location_id) references pm.stock_locations (org_id, id) deferrable initially immediate,
  foreign key (org_id, reserved_job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, parent_roll_id) references pm.flr_rolls (org_id, id) deferrable initially immediate
);
create index if not exists pm_flr_rolls_idx on pm.flr_rolls (org_id, location_id, product_id, status);

create table if not exists pm.flr_cut_tickets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id      uuid not null,
  number      text not null,
  status      text not null default 'OPEN' check (status in ('OPEN','CUT','VOID')),
  due_on      date,
  warnings    jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  created_by  text default pm.current_user_id(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create table if not exists pm.flr_cuts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  ticket_id        uuid not null,
  roll_id          uuid not null,
  seq              int not null,
  room             text,
  planned_len_in   numeric(10,2) not null check (planned_len_in > 0),
  actual_len_in    numeric(10,2) check (actual_len_in is null or actual_len_in > 0),
  status           text not null default 'PLANNED' check (status in ('PLANNED','CUT','VOID')),
  cut_at           timestamptz,
  cut_by           text,
  remnant_roll_id  uuid,
  move_id          uuid,
  unique (org_id, id),
  unique (ticket_id, seq),
  check (status <> 'CUT' or (actual_len_in is not null and cut_at is not null)),
  foreign key (org_id, ticket_id) references pm.flr_cut_tickets (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, roll_id) references pm.flr_rolls (org_id, id) deferrable initially immediate
);

create or replace function pm.flr_receive_roll(p_location uuid, p_product uuid, p_roll_number text, p_dye_lot text, p_width_in numeric, p_length_in numeric,
                                               p_stock_location uuid default null, p_bin text default null, p_cost_per_lf_cents bigint default null,
                                               p_procurement_item uuid default null, p_condition text default 'GOOD', p_notes text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); p pm.flr_products%rowtype; v_id uuid; pi pm.procurement_items%rowtype;
begin
  select * into p from pm.flr_products x where x.org_id = v_org and x.location_id = p_location and x.id = p_product;
  if p.id is null then raise exception 'PM_INVALID: the product is not in this store''s product file' using errcode = '22023'; end if;
  if p_cost_per_lf_cents is not null and not pm.access_can_location('projects.financials', 'edit', p_location) then
    raise exception 'PM_FORBIDDEN: landed cost needs projects.financials:edit' using errcode = '42501';
  end if;
  if coalesce(p_condition, 'GOOD') not in ('GOOD','DAMAGED','SHORT') then raise exception 'PM_INVALID: condition' using errcode = '22023'; end if;
  if p_stock_location is not null and not exists (select 1 from pm.stock_locations s where s.org_id = v_org and s.id = p_stock_location and s.location_id = p_location) then
    raise exception 'PM_INVALID: the stock location is not at this store' using errcode = '22023';
  end if;
  insert into pm.flr_rolls (org_id, location_id, product_id, roll_number, dye_lot, width_in, original_len_in, remaining_len_in, stock_location_id, bin,
                            status, cost_per_lf_cents, received_condition, procurement_item_id, notes)
  values (v_org, p_location, p.id, upper(btrim(p_roll_number)), upper(btrim(p_dye_lot)), p_width_in, p_length_in, p_length_in, p_stock_location,
          nullif(left(p_bin, 24), ''), case when coalesce(p_condition, 'GOOD') = 'DAMAGED' then 'DAMAGED' else 'AVAILABLE' end, p_cost_per_lf_cents,
          coalesce(p_condition, 'GOOD'), p_procurement_item, nullif(left(p_notes, 1000), ''))
  returning id into v_id;
  if p.item_id is not null and p_stock_location is not null then
    perform pm.record_material_move('RECEIPT', p.item_id, round(p_length_in / 12.0, 4), null, p_stock_location, null, null, 'LF',
                                    upper(btrim(p_roll_number)) || '/' || upper(btrim(p_dye_lot)), 'pm:flrroll:' || v_id::text, null, null, p.style);
  end if;
  if p_procurement_item is not null then
    select * into pi from pm.procurement_items x where x.org_id = v_org and x.id = p_procurement_item;
    if pi.id is not null and pi.status in ('ORDERED','ACKNOWLEDGED','BACK_ORDERED','SHIPPED') then
      perform pm.advance_procurement_item(pi.id, case when coalesce(p_condition, 'GOOD') = 'DAMAGED' and pi.status = 'SHIPPED' then 'DAMAGED' else 'RECEIVED' end,
                                          current_date, jsonb_build_object('received_condition', case coalesce(p_condition, 'GOOD') when 'SHORT' then 'PARTIAL' else coalesce(p_condition, 'GOOD') end,
                                                                           'storage_location_id', p_stock_location));
    end if;
  end if;
  return v_id;
end $$;

-- Dye-lot continuity: products on the job whose reserved / cut rolls come from more than one lot, and
-- whether one lot alone could cover the length still needed.
create or replace function pm._flr_lot_warnings(p_org uuid, p_job uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  with use as (
    select r.product_id, r.dye_lot, sum(c.planned_len_in) filter (where c.status = 'PLANNED') as need_in
      from pm.flr_cuts c join pm.flr_cut_tickets t on t.org_id = c.org_id and t.id = c.ticket_id
      join pm.flr_rolls r on r.org_id = c.org_id and r.id = c.roll_id
     where c.org_id = p_org and t.job_id = p_job and c.status <> 'VOID' and t.status <> 'VOID'
     group by 1, 2
    union
    select r.product_id, r.dye_lot, null from pm.flr_rolls r where r.org_id = p_org and r.reserved_job_id = p_job
  ), lots as (
    select product_id, array_agg(distinct dye_lot order by dye_lot) as lots, coalesce(sum(need_in), 0) as need_in from use group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('code', 'LOT_MIX', 'product_id', l.product_id, 'style', p.style, 'lots', to_jsonb(l.lots),
            'one_lot_can_cover', exists (select 1 from pm.flr_rolls r where r.org_id = p_org and r.product_id = l.product_id
                                           and r.status in ('AVAILABLE','RESERVED','REMNANT') group by r.dye_lot having sum(r.remaining_len_in) >= l.need_in))), '[]')
    from lots l join pm.flr_products p on p.org_id = p_org and p.id = l.product_id
   where cardinality(l.lots) > 1
$$;

create or replace function pm.flr_lot_check(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return jsonb_build_object('job_id', p_job, 'warnings', pm._flr_lot_warnings(j.org_id, p_job));
end $$;

-- Rolls that can take a cut: same lot as the job's other cuts first, then the smallest leftover
-- (remnants before full rolls).
create or replace function pm.flr_suggest_roll(p_location uuid, p_product uuid, p_length_in numeric, p_job uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_lots text[];
begin
  if p_length_in is null or p_length_in <= 0 then raise exception 'PM_INVALID: cut length must be > 0' using errcode = '22023'; end if;
  if p_job is not null then
    select array_agg(distinct r.dye_lot) into v_lots from pm.flr_cuts c join pm.flr_cut_tickets t on t.org_id = c.org_id and t.id = c.ticket_id
      join pm.flr_rolls r on r.org_id = c.org_id and r.id = c.roll_id
     where c.org_id = v_org and t.job_id = p_job and r.product_id = p_product and c.status <> 'VOID';
  end if;
  return jsonb_build_object('rolls', coalesce((
    select jsonb_agg(jsonb_build_object('roll_id', r.id, 'roll_number', r.roll_number, 'dye_lot', r.dye_lot, 'status', r.status, 'bin', r.bin,
             'available_in', r.remaining_len_in - coalesce(pl.planned, 0), 'leftover_in', r.remaining_len_in - coalesce(pl.planned, 0) - p_length_in,
             'same_lot', r.dye_lot = any (coalesce(v_lots, '{}')))
           order by (r.dye_lot = any (coalesce(v_lots, '{}'))) desc, (r.status = 'REMNANT') desc, r.remaining_len_in - coalesce(pl.planned, 0) - p_length_in, r.roll_number)
      from pm.flr_rolls r
      left join lateral (select sum(c.planned_len_in) as planned from pm.flr_cuts c where c.org_id = r.org_id and c.roll_id = r.id and c.status = 'PLANNED') pl on true
     where r.org_id = v_org and r.location_id = p_location and r.product_id = p_product
       and (r.status in ('AVAILABLE','REMNANT') or (r.status = 'RESERVED' and r.reserved_job_id is not distinct from p_job))
       and r.remaining_len_in - coalesce(pl.planned, 0) >= p_length_in), '[]'), 'job_lots', to_jsonb(coalesce(v_lots, '{}')));
end $$;

-- Cut ticket for a job: [{roll_id, room, length_in}]. Each roll must have the length left after the
-- other planned cuts; the roll is reserved to the job. Lot-mix warnings come back (and stay on the ticket).
create or replace function pm.flr_create_cut_ticket(p_job uuid, p_cuts jsonb, p_due_on date default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; v_num text; e jsonb; r pm.flr_rolls%rowtype; n int := 0; v_len numeric; v_planned numeric; v_warn jsonb;
begin
  select * into j from pm._x_job(p_job);
  if jsonb_typeof(coalesce(p_cuts, 'null')) <> 'array' or jsonb_array_length(p_cuts) = 0 or jsonb_array_length(p_cuts) > 100 then
    raise exception 'PM_INVALID: a cut ticket needs 1–100 cuts' using errcode = '22023';
  end if;
  v_num := 'CT-' || to_char(current_date, 'YYYY') || '-' || lpad(pm.next_doc_number(j.org_id, 'org', 'FLR_CUT', to_char(current_date, 'YYYY'))::text, 5, '0');
  insert into pm.flr_cut_tickets (org_id, job_id, number, due_on) values (j.org_id, p_job, v_num, p_due_on) returning id into v_id;
  for e in select * from jsonb_array_elements(p_cuts) loop
    v_len := pm._x_try_num(e ->> 'length_in');
    if coalesce(v_len, 0) <= 0 then raise exception 'PM_INVALID: each cut needs a length' using errcode = '22023'; end if;
    select * into r from pm.flr_rolls x where x.org_id = j.org_id and x.id = pm.access_try_uuid(e ->> 'roll_id') for update;
    if r.id is null or r.location_id <> j.location_id then raise exception 'PM_INVALID: roll not found at this store' using errcode = '22023'; end if;
    if r.status in ('DEPLETED','DAMAGED') or (r.status = 'RESERVED' and r.reserved_job_id <> p_job) then
      raise exception 'PM_FLR_ROLL_UNAVAILABLE: roll % is %', r.roll_number, lower(r.status) using errcode = '22023';
    end if;
    select coalesce(sum(c.planned_len_in), 0) into v_planned from pm.flr_cuts c where c.org_id = j.org_id and c.roll_id = r.id and c.status = 'PLANNED';
    if v_planned + v_len > r.remaining_len_in then
      raise exception 'PM_FLR_ROLL_SHORT: roll % has % in left after planned cuts; % in asked', r.roll_number, r.remaining_len_in - v_planned, v_len using errcode = '22023';
    end if;
    n := n + 1;
    insert into pm.flr_cuts (org_id, ticket_id, roll_id, seq, room, planned_len_in) values (j.org_id, v_id, r.id, n, nullif(left(e ->> 'room', 120), ''), v_len);
    if r.status in ('AVAILABLE','REMNANT') then update pm.flr_rolls set status = 'RESERVED', reserved_job_id = p_job, updated_at = now() where id = r.id; end if;
  end loop;
  v_warn := pm._flr_lot_warnings(j.org_id, p_job);
  update pm.flr_cut_tickets set warnings = v_warn where id = v_id;
  return jsonb_build_object('ticket_id', v_id, 'number', v_num, 'cuts', n, 'warnings', v_warn);
end $$;

-- Record a cut (mobile): remaining length drops; the material issue goes to the job at the roll's lot;
-- what is left becomes a REMNANT when it is between the store's remnant limits, is scrapped below
-- the minimum, and stays a roll above the maximum. The ticket closes when every cut is done.
create or replace function pm.flr_record_cut(p_cut uuid, p_actual_len_in numeric default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.flr_cuts%rowtype; t pm.flr_cut_tickets%rowtype; r pm.flr_rolls%rowtype; p pm.flr_products%rowtype; s pm.flr_settings; v_len numeric;
        v_left numeric; v_status text; v_move uuid; v_more boolean; v_scrap numeric := 0;
begin
  select * into c from pm.flr_cuts x where x.id = p_cut for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: cut % not found in the caller''s organization', p_cut using errcode = '42501';
  end if;
  if c.status <> 'PLANNED' then raise exception 'PM_FLR_CUT_DONE: this cut is %', lower(c.status) using errcode = '22023'; end if;
  select * into t from pm.flr_cut_tickets x where x.org_id = c.org_id and x.id = c.ticket_id for update;
  select * into r from pm.flr_rolls x where x.org_id = c.org_id and x.id = c.roll_id for update;
  select * into p from pm.flr_products x where x.org_id = c.org_id and x.id = r.product_id;
  s := pm._flr_settings(r.org_id, r.location_id);
  v_len := coalesce(p_actual_len_in, c.planned_len_in);
  if v_len <= 0 or v_len > r.remaining_len_in then
    raise exception 'PM_FLR_ROLL_SHORT: roll % has % in left', r.roll_number, r.remaining_len_in using errcode = '22023';
  end if;
  v_left := r.remaining_len_in - v_len;
  select exists (select 1 from pm.flr_cuts x where x.org_id = c.org_id and x.roll_id = r.id and x.status = 'PLANNED' and x.id <> c.id) into v_more;
  if v_left = 0 then v_status := 'DEPLETED';
  elsif v_more then v_status := 'RESERVED';
  elsif v_left < s.remnant_min_in then v_status := 'DEPLETED'; v_scrap := v_left;
  elsif v_left <= s.remnant_max_in then v_status := 'REMNANT';
  else v_status := 'AVAILABLE';
  end if;
  update pm.flr_rolls set remaining_len_in = case when v_scrap > 0 then 0 else v_left end, status = v_status,
         reserved_job_id = case when v_status = 'RESERVED' then reserved_job_id end, updated_at = now()
   where id = r.id;
  if p.item_id is not null and r.stock_location_id is not null then
    v_move := pm.record_material_move('ISSUE', p.item_id, round(v_len / 12.0, 4), r.stock_location_id, null, t.job_id, null, 'LF',
                                      r.roll_number || '/' || r.dye_lot, 'pm:flrcut:' || c.id::text, null, coalesce(c.room, t.number), p.style);
    if v_scrap > 0 then
      perform pm.record_material_move('SCRAP', p.item_id, round(v_scrap / 12.0, 4), r.stock_location_id, null, t.job_id, null, 'LF',
                                      r.roll_number || '/' || r.dye_lot, 'pm:flrscrap:' || c.id::text, null, 'Drop below the remnant minimum', p.style);
    end if;
  end if;
  update pm.flr_cuts set status = 'CUT', actual_len_in = v_len, cut_at = now(), cut_by = pm.current_user_id(), move_id = v_move where id = c.id;
  if not exists (select 1 from pm.flr_cuts x where x.org_id = c.org_id and x.ticket_id = t.id and x.status = 'PLANNED') then
    update pm.flr_cut_tickets set status = 'CUT', updated_at = now() where id = t.id;
  end if;
  return jsonb_build_object('cut_id', c.id, 'roll_id', r.id, 'remaining_in', case when v_scrap > 0 then 0 else v_left end, 'roll_status', v_status,
                            'scrap_in', v_scrap, 'move_id', v_move);
end $$;

-- F6. Job readiness gate + install board with SF capacity -------------------------------
create table if not exists pm.flr_site_checks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id       uuid not null,
  check_key    text not null check (check_key in ('MOISTURE','OLD_FLOOR_REMOVED','FURNITURE_MOVED','HVAC_RUNNING','SUBFLOOR_FLAT','OTHER')),
  passed       boolean not null,
  reading      numeric(10,3),
  notes        text,
  photo_document_ids uuid[] not null default '{}',
  recorded_by  text default pm.current_user_id(),
  recorded_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, check_key),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create or replace function pm.flr_record_site_check(p_job uuid, p_check text, p_passed boolean, p_reading numeric default null, p_notes text default null,
                                                    p_photos uuid[] default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid;
begin
  select * into j from pm._x_job(p_job);
  if p_passed is null then raise exception 'PM_INVALID: record pass or fail' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_photos, '{}')) d where not exists (select 1 from public.documents x where x.id = d and x.org_id = j.org_id)) then
    raise exception 'PM_INVALID: a photo is not a document of this organization' using errcode = '22023';
  end if;
  insert into pm.flr_site_checks (org_id, job_id, check_key, passed, reading, notes, photo_document_ids)
  values (j.org_id, p_job, upper(p_check), p_passed, p_reading, nullif(left(p_notes, 1000), ''), coalesce(p_photos, '{}'))
  on conflict (org_id, job_id, check_key) do update set passed = excluded.passed, reading = excluded.reading, notes = excluded.notes,
     photo_document_ids = excluded.photo_document_ids, recorded_by = pm.current_user_id(), recorded_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Ready = material received + inspected (every special-order line on the job), deposit paid in Books
-- (when the job takes a deposit), required site checks passed.
create or replace function pm._flr_readiness(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; s pm.flr_settings; js pm.flr_job_settings%rowtype; v_mat jsonb; v_dep jsonb; v_req text[]; v_site jsonb; v_dep_ok boolean; v_pct numeric;
        v_mat_ok boolean; v_site_ok boolean;
begin
  select j.location_id into v_loc from core.jobs j where j.org_id = p_org and j.id = p_job;
  s := pm._flr_settings(p_org, v_loc);
  select * into js from pm.flr_job_settings x where x.org_id = p_org and x.job_id = p_job;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', pi.id, 'description', pi.description, 'status', pi.status, 'condition', pi.received_condition,
                                               'expected_on', pi.expected_on)), '[]')
    into v_mat from pm.procurement_items pi
   where pi.org_id = p_org and pi.job_id = p_job and pi.status not in ('CANCELLED','RETURNED','SPECIFIED','PROPOSED')
     and not (pi.status in ('RECEIVED','STORED','DELIVERED','INSTALLED') and coalesce(pi.received_condition, 'GOOD') = 'GOOD');
  v_mat_ok := jsonb_array_length(v_mat) = 0;
  v_pct := coalesce(js.deposit_pct, s.default_deposit_pct);
  v_dep := pm._x_job_deposits(p_org, p_job);
  v_dep_ok := v_pct = 0 or coalesce((v_dep ->> 'all_paid')::boolean, false);
  v_req := coalesce(js.required_site_checks, s.required_site_checks);
  select coalesce(jsonb_agg(jsonb_build_object('check', k, 'passed', c.passed, 'reading', c.reading, 'recorded_at', c.recorded_at)), '[]'),
         coalesce(bool_and(coalesce(c.passed, false)), true)
    into v_site, v_site_ok
    from unnest(v_req) k left join pm.flr_site_checks c on c.org_id = p_org and c.job_id = p_job and c.check_key = k;
  return jsonb_build_object('job_id', p_job, 'ready', v_mat_ok and v_dep_ok and v_site_ok,
    'checks', jsonb_build_array(
      jsonb_build_object('key', 'material', 'ok', v_mat_ok, 'open_items', v_mat),
      jsonb_build_object('key', 'deposit', 'ok', v_dep_ok, 'required_pct', v_pct, 'detail', v_dep),
      jsonb_build_object('key', 'site', 'ok', v_site_ok, 'checks', v_site)));
end $$;

create or replace function pm.flr_job_readiness(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return pm._flr_readiness(j.org_id, p_job);
end $$;

create table if not exists pm.flr_capacity (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  crew_id            uuid,
  weekday            int check (weekday is null or weekday between 1 and 7),   -- ISO weekday; null with on_date = that day; both null = every day
  on_date            date,
  sf_per_day         numeric(10,2) not null check (sf_per_day >= 0),
  jobs_per_day       int check (jobs_per_day is null or jobs_per_day >= 0),
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  check (weekday is null or on_date is null),
  foreign key (org_id, crew_id) references pm.crews (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.flr_install_bookings (
  id                         uuid primary key default gen_random_uuid(),
  org_id                     uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                     uuid not null,
  crew_id                    uuid,
  install_on                 date not null,
  days                       int not null default 1 check (days between 1 and 30),
  sf                         numeric(12,2) not null check (sf >= 0),
  status                     text not null default 'BOOKED' check (status in ('BOOKED','CONFIRMED','DONE','CANCELLED')),
  readiness_override_reason  text,
  capacity_override_reason   text,
  notes                      text,
  booked_by                  text default pm.current_user_id(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, crew_id) references pm.crews (org_id, id) deferrable initially immediate
);
create index if not exists pm_flr_bookings_idx on pm.flr_install_bookings (org_id, install_on, status);

-- Capacity of a day for a crew (crew row, else the store row): a dated row beats a weekday row beats an every-day row.
create or replace function pm._flr_day_capacity(p_org uuid, p_location uuid, p_crew uuid, p_day date, out sf numeric, out jobs int)
language sql stable security definer
set search_path = pm, core, public
as $$
  select c.sf_per_day, c.jobs_per_day from pm.flr_capacity c
   where c.org_id = p_org and c.location_id = p_location and (c.crew_id = p_crew or c.crew_id is null)
     and (c.on_date = p_day or (c.on_date is null and (c.weekday is null or c.weekday = extract(isodow from p_day)::int)))
   order by (c.crew_id is not null) desc, (c.on_date is not null) desc, (c.weekday is not null) desc limit 1
$$;

create or replace function pm._flr_day_load(p_org uuid, p_location uuid, p_crew uuid, p_day date, p_exclude uuid default null, out sf numeric, out jobs int)
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(sum(b.sf / b.days), 0), count(*)::int from pm.flr_install_bookings b join core.jobs j on j.org_id = b.org_id and j.id = b.job_id
   where b.org_id = p_org and j.location_id = p_location and b.status in ('BOOKED','CONFIRMED') and b.id is distinct from p_exclude
     and p_day between b.install_on and b.install_on + b.days - 1
     and (p_crew is null or b.crew_id = p_crew or (b.crew_id is null and not exists (select 1 from pm.flr_capacity c where c.org_id = p_org and c.crew_id = p_crew)))
$$;

create or replace function pm.flr_book_install(p_job uuid, p_install_on date, p_sf numeric, p_days int default 1, p_crew uuid default null,
                                               p_override_reason text default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; rd jsonb; d date; cap record; ld record; v_full jsonb := '[]'; v_id uuid; v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  select * into j from pm._x_job(p_job);
  if p_install_on is null or coalesce(p_sf, -1) < 0 or coalesce(p_days, 0) < 1 then raise exception 'PM_INVALID: date, SF and days' using errcode = '22023'; end if;
  if p_crew is not null and not exists (select 1 from pm.crews c where c.org_id = j.org_id and c.id = p_crew and c.location_id = j.location_id) then
    raise exception 'PM_INVALID: the crew is not at this store' using errcode = '22023';
  end if;
  rd := pm._flr_readiness(j.org_id, p_job);
  if not (rd ->> 'ready')::boolean and v_reason is null then
    raise exception 'PM_FLR_NOT_READY: the job is not ready to install (%); give a reason to book anyway',
      (select string_agg(c ->> 'key', ', ') from jsonb_array_elements(rd -> 'checks') c where not (c ->> 'ok')::boolean) using errcode = 'P0001';
  end if;
  for d in select generate_series(p_install_on, p_install_on + p_days - 1, interval '1 day')::date loop
    select * into cap from pm._flr_day_capacity(j.org_id, j.location_id, p_crew, d);
    continue when cap.sf is null;
    select * into ld from pm._flr_day_load(j.org_id, j.location_id, p_crew, d);
    if ld.sf + p_sf / p_days > cap.sf or (cap.jobs is not null and ld.jobs + 1 > cap.jobs) then
      v_full := v_full || jsonb_build_object('day', d, 'capacity_sf', cap.sf, 'booked_sf', round(ld.sf, 2), 'capacity_jobs', cap.jobs, 'booked_jobs', ld.jobs);
    end if;
  end loop;
  if jsonb_array_length(v_full) > 0 and v_reason is null then
    raise exception 'PM_FLR_CAPACITY_FULL: % is full: %', (v_full -> 0 ->> 'day'), v_full using errcode = '53400';
  end if;
  insert into pm.flr_install_bookings (org_id, job_id, crew_id, install_on, days, sf, readiness_override_reason, capacity_override_reason, notes)
  values (j.org_id, p_job, p_crew, p_install_on, p_days, p_sf, case when not (rd ->> 'ready')::boolean then v_reason end,
          case when jsonb_array_length(v_full) > 0 then v_reason end, nullif(left(p_notes, 1000), ''))
  returning id into v_id;
  if v_reason is not null then
    perform pm.log_activity(j.org_id, j.location_id, p_job, 'flooring.install_override', 'flr_install_bookings', v_id,
      format('Install booked past the gate: %s', v_reason), jsonb_build_object('not_ready', not (rd ->> 'ready')::boolean, 'full_days', v_full));
  end if;
  return jsonb_build_object('booking_id', v_id, 'ready', (rd ->> 'ready')::boolean, 'full_days', v_full);
end $$;

create or replace function pm.flr_install_board(p_location uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_from date := coalesce(p_from, current_date); v_to date := coalesce(p_to, current_date + 13);
        v_days jsonb := '[]'; d date; cap record; ld record;
begin
  if v_to < v_from or v_to - v_from > 92 then raise exception 'PM_INVALID: up to 92 days' using errcode = '22023'; end if;
  for d in select generate_series(v_from, v_to, interval '1 day')::date loop
    select * into cap from pm._flr_day_capacity(v_org, p_location, null, d);
    select * into ld from pm._flr_day_load(v_org, p_location, null, d);
    v_days := v_days || jsonb_build_object('day', d, 'capacity_sf', cap.sf, 'capacity_jobs', cap.jobs, 'booked_sf', round(ld.sf, 2), 'booked_jobs', ld.jobs,
                                           'over', cap.sf is not null and ld.sf > cap.sf);
  end loop;
  return jsonb_build_object('from', v_from, 'to', v_to, 'days', v_days, 'bookings', coalesce((
    select jsonb_agg(jsonb_build_object('booking_id', b.id, 'job_id', b.job_id, 'job', j.job_number, 'job_name', j.name, 'crew_id', b.crew_id, 'crew', c.name,
             'install_on', b.install_on, 'days', b.days, 'sf', b.sf, 'status', b.status, 'overridden', b.readiness_override_reason is not null or b.capacity_override_reason is not null,
             'ready', (pm._flr_readiness(v_org, b.job_id) ->> 'ready')::boolean) order by b.install_on, c.name nulls last, j.job_number)
      from pm.flr_install_bookings b join core.jobs j on j.org_id = b.org_id and j.id = b.job_id left join pm.crews c on c.org_id = b.org_id and c.id = b.crew_id
     where b.org_id = v_org and j.location_id = p_location and b.status <> 'CANCELLED'
       and b.install_on <= v_to and b.install_on + b.days - 1 >= v_from and j.id in (select pm.my_job_ids())), '[]'));
end $$;

-- F7. Installer pay tickets + chargebacks ------------------------------------------------
create table if not exists pm.flr_pay_tickets (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  job_id             uuid not null,
  number             text not null,
  worker_type        text not null check (worker_type in ('W2','1099')),
  employee_id        uuid references core.employees(id),
  vendor_id          uuid references core.vendors(id),
  completed_on       date not null,
  split_pct          numeric(5,4) not null default 1 check (split_pct > 0 and split_pct <= 1),
  hours_worked       numeric(6,2) check (hours_worked is null or (hours_worked > 0 and hours_worked <= 24)),
  status             text not null default 'DRAFT' check (status in ('DRAFT','FINALIZED','APPROVED','PAID','VOID')),
  gross_cents        bigint not null default 0 check (gross_cents >= 0),
  chargeback_cents   bigint not null default 0 check (chargeback_cents >= 0),
  net_cents          bigint generated always as (gross_cents - chargeback_cents) stored,
  posting            text check (posting is null or posting in ('PAYABLE_HELD','TIME_ENTRY')),
  payable_payload    jsonb,
  time_entry_id      uuid,
  finalized_by       text,
  finalized_at       timestamptz,
  approved_by        text,
  approved_at        timestamptz,
  void_reason        text,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, id),
  check ((worker_type = 'W2') = (employee_id is not null) and (worker_type = '1099') = (vendor_id is not null)),
  check (worker_type <> 'W2' or status in ('DRAFT','VOID') or hours_worked is not null),
  check (chargeback_cents <= gross_cents),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create table if not exists pm.flr_pay_ticket_lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  ticket_id       uuid not null,
  line_no         int not null,
  labor_code      text not null,
  description     text not null,
  unit            text not null,
  qty             numeric(14,4) not null check (qty > 0),
  rate_cents      bigint not null check (rate_cents >= 0),
  amount_cents    bigint not null check (amount_cents >= 0),
  measured_qty    numeric(14,4),
  over_measured   boolean not null default false,
  unique (org_id, id),
  unique (ticket_id, line_no),
  foreign key (org_id, ticket_id) references pm.flr_pay_tickets (org_id, id) on delete cascade deferrable initially immediate
);
create table if not exists pm.flr_chargebacks (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  job_id               uuid,
  worker_type          text not null check (worker_type in ('W2','1099')),
  employee_id          uuid references core.employees(id),
  vendor_id            uuid references core.vendors(id),
  reason               text not null check (reason in ('CALLBACK','DAMAGE','MATERIAL_OVERUSE','NO_SHOW','OTHER')),
  description          text not null check (char_length(btrim(description)) between 1 and 500),
  amount_cents         bigint not null check (amount_cents > 0),
  applied_cents        bigint not null default 0 check (applied_cents >= 0),
  status               text not null default 'PROPOSED' check (status in ('PROPOSED','ACKNOWLEDGED','APPLIED','WAIVED')),
  acknowledged_by_name text,
  acknowledged_at      timestamptz,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  check ((worker_type = 'W2') = (employee_id is not null) and (worker_type = '1099') = (vendor_id is not null)),
  check (applied_cents <= amount_cents),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Completion → pay tickets. p_lines: [{labor_code, qty}] (partial quantities allowed); p_splits:
-- [{worker_type, employee_id | vendor_id, pct, hours_worked}] summing to 1. Each installer gets one
-- ticket: qty × piece rate × split, plus a top-up to the job minimum when the codes carry one. A tally
-- above the measured quantity is flagged (measured = the job's quote lines for that labor code).
create or replace function pm.flr_ticket_from_completion(p_job uuid, p_completed_on date, p_lines jsonb, p_splits jsonb)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; sp jsonb; e jsonb; lr pm.flr_labor_rates%rowtype; v_tot numeric := 0; v_tid uuid; v_num text; v_n int; v_gross bigint; v_amt bigint;
        v_meas numeric; v_qty numeric; v_min bigint; v_out jsonb := '[]'; v_type text;
begin
  select * into j from pm._x_job(p_job);
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'PM_INVALID: add the completed quantities' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_splits, 'null')) <> 'array' or jsonb_array_length(p_splits) = 0 or jsonb_array_length(p_splits) > 6 then
    raise exception 'PM_INVALID: 1–6 installers' using errcode = '22023';
  end if;
  select coalesce(sum(pm._x_try_num(x ->> 'pct')), 0) into v_tot from jsonb_array_elements(p_splits) x;
  if abs(v_tot - 1) > 0.0001 then raise exception 'PM_INVALID: the splits must add up to 100%% (now %)', v_tot * 100 using errcode = '22023'; end if;
  for sp in select * from jsonb_array_elements(p_splits) loop
    v_type := upper(coalesce(sp ->> 'worker_type', ''));
    if v_type not in ('W2','1099') then raise exception 'PM_INVALID: worker type W2 or 1099' using errcode = '22023'; end if;
    if v_type = 'W2' and not exists (select 1 from core.employees x where x.id = pm.access_try_uuid(sp ->> 'employee_id') and x.org_id = j.org_id) then
      raise exception 'PM_UNKNOWN_EMPLOYEE: a W-2 installer needs an employee record' using errcode = 'P0002';
    end if;
    if v_type = '1099' and not exists (select 1 from core.vendors x where x.id = pm.access_try_uuid(sp ->> 'vendor_id') and x.org_id = j.org_id) then
      raise exception 'PM_UNKNOWN_VENDOR: a 1099 installer needs a vendor record' using errcode = '23503';
    end if;
    v_num := 'PT-' || to_char(current_date, 'YYYY') || '-' || lpad(pm.next_doc_number(j.org_id, 'org', 'FLR_PAY', to_char(current_date, 'YYYY'))::text, 5, '0');
    insert into pm.flr_pay_tickets (org_id, location_id, job_id, number, worker_type, employee_id, vendor_id, completed_on, split_pct, hours_worked)
    values (j.org_id, j.location_id, p_job, v_num, v_type, case when v_type = 'W2' then pm.access_try_uuid(sp ->> 'employee_id') end,
            case when v_type = '1099' then pm.access_try_uuid(sp ->> 'vendor_id') end, coalesce(p_completed_on, current_date),
            pm._x_try_num(sp ->> 'pct'), pm._x_try_num(sp ->> 'hours_worked'))
    returning id into v_tid;
    v_n := 0; v_gross := 0; v_min := 0;
    for e in select * from jsonb_array_elements(p_lines) loop
      v_qty := pm._x_try_num(e ->> 'qty');
      continue when coalesce(v_qty, 0) <= 0;
      select * into lr from pm.flr_labor_rates x where x.org_id = j.org_id and x.location_id = j.location_id and x.code = upper(btrim(coalesce(e ->> 'labor_code', ''))) and x.is_active;
      if lr.id is null then raise exception 'PM_INVALID: labor code % is not on the price list', e ->> 'labor_code' using errcode = '22023'; end if;
      select sum(q.measured_qty) into v_meas from pm.flr_quote_lines q join pm.estimates es on es.org_id = q.org_id and es.id = q.estimate_id
       where q.org_id = j.org_id and es.job_id = p_job and es.status in ('DRAFT','SENT','ACCEPTED') and q.labor_code = lr.code;
      v_amt := round(v_qty * lr.pay_cents * pm._x_try_num(sp ->> 'pct'))::bigint;
      v_n := v_n + 1;
      insert into pm.flr_pay_ticket_lines (org_id, ticket_id, line_no, labor_code, description, unit, qty, rate_cents, amount_cents, measured_qty, over_measured)
      values (j.org_id, v_tid, v_n, lr.code, lr.description, lr.unit, v_qty, lr.pay_cents, v_amt, v_meas, v_meas is not null and v_qty > v_meas);
      v_gross := v_gross + v_amt;
      v_min := greatest(v_min, lr.job_minimum_pay_cents);
    end loop;
    v_min := round(v_min * pm._x_try_num(sp ->> 'pct'))::bigint;
    if v_gross < v_min then
      v_n := v_n + 1;
      insert into pm.flr_pay_ticket_lines (org_id, ticket_id, line_no, labor_code, description, unit, qty, rate_cents, amount_cents)
      values (j.org_id, v_tid, v_n, 'JOB_MINIMUM', 'Top-up to the job minimum', 'JOB', 1, v_min - v_gross, v_min - v_gross);
      v_gross := v_min;
    end if;
    update pm.flr_pay_tickets set gross_cents = v_gross where id = v_tid;
    v_out := v_out || jsonb_build_object('ticket_id', v_tid, 'number', v_num, 'worker_type', v_type,
                                         'gross_cents', case when pm._x_sees('projects.labor_rates', 'view', j.location_id) then v_gross end,
                                         'over_measured', exists (select 1 from pm.flr_pay_ticket_lines l where l.ticket_id = v_tid and l.over_measured));
  end loop;
  return jsonb_build_object('job_id', p_job, 'tickets', v_out);
end $$;

create or replace function pm.flr_finalize_pay_ticket(p_ticket uuid, p_hours_worked numeric default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.flr_pay_tickets%rowtype;
begin
  select * into t from pm.flr_pay_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status <> 'DRAFT' then raise exception 'PM_PAY_TICKET_STATE: the ticket is %', lower(t.status) using errcode = '22023'; end if;
  if t.worker_type = 'W2' and coalesce(p_hours_worked, t.hours_worked) is null then
    raise exception 'PM_INVALID: a W-2 piece-rate ticket needs the hours worked (regular-rate overtime)' using errcode = '22023';
  end if;
  update pm.flr_pay_tickets set status = 'FINALIZED', hours_worked = coalesce(p_hours_worked, hours_worked), finalized_by = pm.current_user_id(),
         finalized_at = now(), updated_at = now() where id = t.id;
  return t.id;
end $$;

-- Approve: acknowledged chargebacks of that installer are netted (never below zero; the rest waits for
-- the next ticket), then the ticket posts ONCE: 1099 → a payable request held for Books AP (payload on
-- the ticket); W-2 → a SUBMITTED PIECE time entry (hours worked; piece earnings in units) for payroll.
-- The person who finalized it does not approve it.
create or replace function pm.flr_approve_pay_ticket(p_ticket uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.flr_pay_tickets%rowtype; cb record; v_room bigint; v_take bigint; v_cb bigint := 0; v_te uuid; v_payload jsonb; v_sees boolean;
begin
  select * into t from pm.flr_pay_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status <> 'FINALIZED' then raise exception 'PM_PAY_TICKET_STATE: finalize the ticket first (it is %)', lower(t.status) using errcode = '22023'; end if;
  if (t.finalized_by is not null and t.finalized_by = pm.current_user_id()) or (t.created_by is not null and t.created_by = pm.current_user_id()) then
    raise exception 'PM_SOD_VIOLATION: the person who made or finalized a pay ticket does not approve it' using errcode = '42501';
  end if;
  -- Security review H1: a 1099 ticket becomes a payable, so an AP approver (commitments or billing approve) approves it;
  -- a W-2 piece ticket is payroll time and stays with time approval (the approver need not see the rates).
  if t.worker_type = '1099' then
    if not (pm.access_can_location('projects.commitments', 'approve', t.location_id) or pm.access_can_location('projects.billing', 'approve', t.location_id)) then
      raise exception 'PM_FORBIDDEN: a 1099 installer pay ticket is a payable: it needs projects.commitments:approve or projects.billing:approve' using errcode = '42501';
    end if;
  elsif not (pm.access_can_location('projects.time', 'approve', t.location_id) or pm.access_can_location('projects.labor_rates', 'edit', t.location_id)) then
    raise exception 'PM_FORBIDDEN: a W-2 pay ticket needs projects.time:approve' using errcode = '42501';
  end if;
  v_room := t.gross_cents;
  for cb in select * from pm.flr_chargebacks x
             where x.org_id = t.org_id and x.location_id = t.location_id and x.status = 'ACKNOWLEDGED' and x.worker_type = t.worker_type
               and x.employee_id is not distinct from t.employee_id and x.vendor_id is not distinct from t.vendor_id
             order by x.created_at for update loop
    exit when v_room <= 0;
    v_take := least(cb.amount_cents - cb.applied_cents, v_room);
    update pm.flr_chargebacks set applied_cents = applied_cents + v_take,
           status = case when applied_cents + v_take >= amount_cents then 'APPLIED' else status end, updated_at = now() where id = cb.id;
    v_room := v_room - v_take; v_cb := v_cb + v_take;
  end loop;
  update pm.flr_pay_tickets set chargeback_cents = v_cb where id = t.id;
  if t.worker_type = 'W2' then
    insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, pay_type, units, billable, notes, approval_state, source_ref, created_by)
    values (t.org_id, t.job_id, t.employee_id, t.completed_on, t.hours_worked, 'PIECE', round((t.gross_cents - v_cb) / 100.0, 2), false,
            left(format('Installer pay ticket %s (piece work)', t.number), 300), 'SUBMITTED', 'pm:paytix:' || t.id::text, pm.current_user_id())
    returning id into v_te;
    update pm.flr_pay_tickets set status = 'APPROVED', posting = 'TIME_ENTRY', time_entry_id = v_te, approved_by = pm.current_user_id(), approved_at = now(), updated_at = now()
     where id = t.id;
  else
    v_payload := jsonb_build_object('event_type', 'JOB_PAYABLE_REQUEST', 'schema_version', 1, 'source_module', 'PROJECTS', 'org_id', t.org_id,
      'location_id', t.location_id, 'job_id', t.job_id, 'vendor_id', t.vendor_id, 'occurred_on', t.completed_on,
      'source_ref', 'pm:paytix:' || t.id::text, 'reference', t.number, 'gross_cents', t.gross_cents, 'chargeback_cents', v_cb,
      'amount_cents', t.gross_cents - v_cb, 'cost_type', 'SUBCONTRACTOR', 'memo', format('Installer pay ticket %s', t.number),
      'lines', (select jsonb_agg(jsonb_build_object('labor_code', l.labor_code, 'description', l.description, 'unit', l.unit, 'qty', l.qty,
                                                    'rate_cents', l.rate_cents, 'amount_cents', l.amount_cents) order by l.line_no)
                  from pm.flr_pay_ticket_lines l where l.org_id = t.org_id and l.ticket_id = t.id));
    update pm.flr_pay_tickets set status = 'APPROVED', posting = 'PAYABLE_HELD', payable_payload = v_payload, approved_by = pm.current_user_id(),
           approved_at = now(), updated_at = now() where id = t.id;
  end if;
  -- Amounts only to callers who may see installer pay: labor rates, or (1099) the AP approver who just approved the payable.
  v_sees := pm._x_sees('projects.labor_rates', 'view', t.location_id) or t.worker_type = '1099';
  return jsonb_build_object('ticket_id', t.id,
                            'net_cents', case when v_sees then t.gross_cents - v_cb end,
                            'chargebacks_cents', case when v_sees then v_cb end, 'time_entry_id', v_te,
                            'posting', case when t.worker_type = 'W2' then 'TIME_ENTRY' else 'PAYABLE_HELD' end);
end $$;

create or replace function pm.flr_void_pay_ticket(p_ticket uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.flr_pay_tickets%rowtype;
begin
  select * into t from pm.flr_pay_tickets x where x.id = p_ticket for update;
  if t.org_id is null or t.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pay ticket % not found in the caller''s organization', p_ticket using errcode = '42501';
  end if;
  if t.status not in ('DRAFT','FINALIZED') then raise exception 'PM_PAY_TICKET_STATE: an approved ticket is reversed in Books' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'PM_INVALID: give a reason' using errcode = '22023'; end if;
  update pm.flr_pay_tickets set status = 'VOID', void_reason = left(btrim(p_reason), 500), updated_at = now() where id = t.id;
  return t.id;
end $$;

create or replace function pm.flr_propose_chargeback(p_location uuid, p_worker_type text, p_worker uuid, p_reason text, p_description text,
                                                     p_amount_cents bigint, p_job uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := pm._x_org_of_location(p_location); v_id uuid;
begin
  if p_worker_type not in ('W2','1099') then raise exception 'PM_INVALID: worker type' using errcode = '22023'; end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'PM_INVALID: a chargeback needs an amount' using errcode = '22023'; end if;
  if p_job is not null and not exists (select 1 from core.jobs j where j.org_id = v_org and j.id = p_job and j.location_id = p_location) then
    raise exception 'PM_INVALID: the job is not at this store' using errcode = '22023';
  end if;
  insert into pm.flr_chargebacks (org_id, location_id, job_id, worker_type, employee_id, vendor_id, reason, description, amount_cents)
  values (v_org, p_location, p_job, p_worker_type, case when p_worker_type = 'W2' then p_worker end, case when p_worker_type = '1099' then p_worker end,
          upper(p_reason), btrim(p_description), p_amount_cents)
  returning id into v_id;
  return v_id;
end $$;

-- The installer acknowledges (their own seat), or a supervisor records the installer's acknowledgment by name.
create or replace function pm.flr_acknowledge_chargeback(p_chargeback uuid, p_name text default null, p_waive boolean default false)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.flr_chargebacks%rowtype; v_own boolean;
begin
  select * into c from pm.flr_chargebacks x where x.id = p_chargeback for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: chargeback % not found in the caller''s organization', p_chargeback using errcode = '42501';
  end if;
  if c.status <> 'PROPOSED' then raise exception 'PM_CHARGEBACK_STATE: the chargeback is %', lower(c.status) using errcode = '22023'; end if;
  v_own := c.employee_id is not null and c.employee_id in (select pm.my_employee_ids());
  if p_waive then
    -- Waiving forgives money owed back: an AP / billing approver decides it (security review H1), never the proposer.
    if not (pm.access_can_location('projects.commitments', 'approve', c.location_id) or pm.access_can_location('projects.billing', 'approve', c.location_id)) then
      raise exception 'PM_FORBIDDEN: waiving a chargeback needs projects.commitments:approve or projects.billing:approve' using errcode = '42501';
    end if;
    if c.created_by is not null and c.created_by = pm.current_user_id() then
      raise exception 'PM_SOD_VIOLATION: the person who proposed a chargeback does not waive it' using errcode = '42501';
    end if;
    update pm.flr_chargebacks set status = 'WAIVED', updated_at = now() where id = c.id;
    return c.id;
  end if;
  if not v_own and not (pm.access_can_location('projects.time', 'approve', c.location_id) or pm.access_can_location('projects.dispatch', 'edit', c.location_id)) then
    raise exception 'PM_FORBIDDEN: the installer or a supervisor acknowledges a chargeback' using errcode = '42501';
  end if;
  if not v_own and nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'PM_INVALID: record who acknowledged it' using errcode = '22023'; end if;
  update pm.flr_chargebacks set status = 'ACKNOWLEDGED', acknowledged_by_name = coalesce(nullif(btrim(p_name), ''), 'installer (own seat)'),
         acknowledged_at = now(), updated_at = now() where id = c.id;
  return c.id;
end $$;

-- ============================================================================
-- I. Interior design (items with components, per-item approval + deposits, procurement hub, fees)
-- ============================================================================

-- I1. Items (client-facing) and components (pm.procurement_items, one PO line each) -------------
create table if not exists pm.dsn_items (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  wbs_id                 uuid,
  room                   text not null check (char_length(btrim(room)) between 1 and 120),
  doc_code               text,
  name                   text not null check (char_length(btrim(name)) between 1 and 200),
  category               text,
  description            text,
  image_document_id      uuid references public.documents(id) on delete set null,
  image_url              text check (image_url is null or image_url ~ '^https://'),
  vendor_url             text check (vendor_url is null or vendor_url ~ '^https://'),
  qty                    numeric(12,4) not null default 1 check (qty > 0),
  is_placeholder         boolean not null default false,
  budget_cents           bigint check (budget_cents is null or budget_cents >= 0),
  client_unit_price_cents bigint check (client_unit_price_cents is null or client_unit_price_cents >= 0),
  client_total_cents     bigint generated always as ((round(qty * coalesce(client_unit_price_cents, 0)))::bigint) stored,
  deposit_pct            numeric(5,4) not null default 0.50 check (deposit_pct >= 0 and deposit_pct <= 1),
  client_visible         boolean not null default true,
  show_cost_to_client    boolean not null default false,
  status                 text not null default 'SPECIFIED' check (status in ('PLACEHOLDER','SPECIFIED','PROPOSED','APPROVED','REJECTED','ORDERED',
                                                                               'RECEIVED','DELIVERED','INSTALLED','CANCELLED')),
  decided_by_name        text,
  decided_at             timestamptz,
  client_comment         text,
  internal_notes         text,
  sort                   int not null default 0,
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, wbs_id) references pm.wbs_nodes (org_id, id) deferrable initially immediate
);
create index if not exists pm_dsn_items_job_idx on pm.dsn_items (org_id, job_id, room, sort);

-- Members edit an item's description fields; price / qty / deposit are pinned once it is proposed.
create or replace function pm.tg_dsn_item_lock() returns trigger
language plpgsql   -- invoker: current_user must be the caller
set search_path = pm, core, public
as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;
  if old.status not in ('PLACEHOLDER','SPECIFIED','REJECTED')
     and (new.qty is distinct from old.qty or new.client_unit_price_cents is distinct from old.client_unit_price_cents
          or new.deposit_pct is distinct from old.deposit_pct or new.job_id is distinct from old.job_id) then
    raise exception 'PM_DSN_ITEM_LOCKED: % is %; its price and quantity are pinned', old.name, lower(old.status) using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists zz_dsn_item_lock on pm.dsn_items;
create trigger zz_dsn_item_lock before update on pm.dsn_items for each row execute function pm.tg_dsn_item_lock();

-- components = procurement lines, each with its own PO, sidemark and the eight procurement dates
alter table pm.procurement_items add column if not exists dsn_item_id          uuid;
alter table pm.procurement_items add column if not exists component_kind       text;
alter table pm.procurement_items add column if not exists client_deposit_on    date;
alter table pm.procurement_items add column if not exists vendor_deposit_on    date;
alter table pm.procurement_items add column if not exists client_balance_on    date;
alter table pm.procurement_items add column if not exists vendor_balance_on    date;
alter table pm.procurement_items add column if not exists dates_done           jsonb not null default '{}';
alter table pm.procurement_items add column if not exists vendor_deposit_pct   numeric(5,4);
alter table pm.procurement_items add column if not exists receive_photo_ids    uuid[] not null default '{}';
alter table pm.procurement_items add column if not exists freight_claim_open   boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'procurement_items_dsn_chk' and conrelid = 'pm.procurement_items'::regclass) then
    alter table pm.procurement_items add constraint procurement_items_dsn_chk check (
      (component_kind is null or component_kind in ('ITEM','FRAME','COM_FABRIC','WORKROOM','FINISH','HARDWARE','FREIGHT','OTHER'))
      and jsonb_typeof(dates_done) = 'object'
      and (vendor_deposit_pct is null or (vendor_deposit_pct >= 0 and vendor_deposit_pct <= 1)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'procurement_items_dsn_item_fk' and conrelid = 'pm.procurement_items'::regclass) then
    alter table pm.procurement_items add constraint procurement_items_dsn_item_fk
      foreign key (org_id, job_id, dsn_item_id) references pm.dsn_items (org_id, job_id, id) deferrable initially immediate;
  end if;
end $$;
create index if not exists pm_procurement_dsn_idx on pm.procurement_items (org_id, dsn_item_id) where dsn_item_id is not null;

-- Add a component to an item (frame from vendor A, COM fabric from B, workroom labor from C …).
create or replace function pm.dsn_add_component(p_item uuid, p_kind text, p_vendor uuid, p_description text, p_qty numeric, p_uom text,
                                                p_unit_cost_cents bigint, p_markup_pct numeric default null, p_vendor_sku text default null,
                                                p_sidemark text default null, p_vendor_deposit_pct numeric default null, p_install_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.dsn_items%rowtype; v_id uuid; v_side text;
begin
  select * into i from pm.dsn_items x where x.id = p_item;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: item % not found in the caller''s organization', p_item using errcode = '42501';
  end if;
  if i.status not in ('PLACEHOLDER','SPECIFIED','PROPOSED','REJECTED') then raise exception 'PM_DSN_ITEM_LOCKED: the item is %', lower(i.status) using errcode = '55000'; end if;
  if p_kind not in ('ITEM','FRAME','COM_FABRIC','WORKROOM','FINISH','HARDWARE','FREIGHT','OTHER') then raise exception 'PM_INVALID: component kind' using errcode = '22023'; end if;
  if p_vendor is not null and not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = i.org_id) then
    raise exception 'PM_UNKNOWN_VENDOR: %', p_vendor using errcode = '23503';
  end if;
  if p_unit_cost_cents is not null and not pm.access_can_job('projects.financials', 'edit', i.job_id) then
    raise exception 'PM_FORBIDDEN: net cost needs projects.financials:edit' using errcode = '42501';
  end if;
  -- default sidemark: client last name / job number + room + doc code (the receiver's label)
  select upper(left(concat_ws(' / ', coalesce(c.name, j.job_number), i.room, i.doc_code), 80)) into v_side
    from core.jobs j left join core.customers c on c.id = j.customer_id where j.org_id = i.org_id and j.id = i.job_id;
  insert into pm.procurement_items (org_id, job_id, wbs_id, vendor_id, description, vendor_sku, sidemark, qty, uom, unit_cost_cents, markup_pct,
                                    dsn_item_id, component_kind, vendor_deposit_pct, install_on, client_deposit_pct)
  values (i.org_id, i.job_id, i.wbs_id, p_vendor, left(coalesce(nullif(btrim(p_description), ''), i.name), 300), nullif(left(p_vendor_sku, 80), ''),
          coalesce(nullif(upper(left(btrim(coalesce(p_sidemark, '')), 80)), ''), v_side), coalesce(p_qty, i.qty), coalesce(nullif(p_uom, ''), 'EA'),
          p_unit_cost_cents, p_markup_pct, i.id, p_kind, p_vendor_deposit_pct, p_install_on, i.deposit_pct)
  returning id into v_id;
  return v_id;
end $$;

-- I2. Proposals with per-item approval -----------------------------------------------------
create table if not exists pm.dsn_proposals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id      uuid not null,
  number      text not null,
  version     int not null default 1,
  title       text,
  status      text not null default 'SENT' check (status in ('SENT','PARTIAL','CLOSED','VOID')),
  sent_at     timestamptz not null default now(),
  sent_by     text default pm.current_user_id(),
  closed_at   timestamptz,
  unique (org_id, number),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create table if not exists pm.dsn_proposal_items (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  proposal_id          uuid not null,
  item_id              uuid not null,
  client_price_cents   bigint not null default 0,
  deposit_cents        bigint not null default 0,
  decision             text not null default 'PENDING' check (decision in ('PENDING','APPROVED','REJECTED','COMMENTED')),
  comment              text,
  decided_by_name      text,
  decided_method       text check (decided_method is null or decided_method in ('IN_PERSON','PORTAL','EMAIL','PHONE','E_SIGNATURE')),
  decided_at           timestamptz,
  client_approval_id   uuid,
  unique (org_id, id),
  unique (proposal_id, item_id),
  foreign key (org_id, proposal_id) references pm.dsn_proposals (org_id, id) on delete cascade deferrable initially immediate
);

-- Send items for approval: one proposal, item prices pinned; components move to PROPOSED.
create or replace function pm.dsn_send_proposal(p_job uuid, p_item_ids uuid[], p_title text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; v_num text; i pm.dsn_items%rowtype; c record; n int := 0; v_ver int;
begin
  select * into j from pm._x_job(p_job);
  if coalesce(cardinality(p_item_ids), 0) = 0 or cardinality(p_item_ids) > 300 then raise exception 'PM_INVALID: send 1–300 items' using errcode = '22023'; end if;
  select coalesce(max(x.version), 0) + 1 into v_ver from pm.dsn_proposals x where x.org_id = j.org_id and x.job_id = p_job;
  v_num := 'PRP-' || to_char(current_date, 'YYYY') || '-' || lpad(pm.next_doc_number(j.org_id, 'org', 'DSN_PROPOSAL', to_char(current_date, 'YYYY'))::text, 5, '0');
  insert into pm.dsn_proposals (org_id, job_id, number, version, title) values (j.org_id, p_job, v_num, v_ver, nullif(left(p_title, 200), '')) returning id into v_id;
  for i in select * from pm.dsn_items x where x.org_id = j.org_id and x.job_id = p_job and x.id = any (p_item_ids) for update loop
    if i.status not in ('SPECIFIED','PROPOSED','REJECTED') or i.client_unit_price_cents is null then
      raise exception 'PM_DSN_NOT_PROPOSABLE: % needs a client price and must not be ordered yet', i.name using errcode = '22023';
    end if;
    insert into pm.dsn_proposal_items (org_id, proposal_id, item_id, client_price_cents, deposit_cents)
    values (j.org_id, v_id, i.id, i.client_total_cents, round(i.client_total_cents * i.deposit_pct)::bigint);
    update pm.dsn_items set status = 'PROPOSED', updated_at = now() where id = i.id;
    for c in select x.id, x.status from pm.procurement_items x where x.org_id = j.org_id and x.dsn_item_id = i.id and x.status = 'SPECIFIED' loop
      perform pm.advance_procurement_item(c.id, 'PROPOSED', current_date, '{}'::jsonb);
    end loop;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'PM_INVALID: none of those items are on this job' using errcode = '22023'; end if;
  return jsonb_build_object('proposal_id', v_id, 'number', v_num, 'items', n);
end $$;

-- The client's decision per item (designer records it; the portal agent records PORTAL). Approval
-- writes a client approval record, moves the components to APPROVED and requests the deposit.
create or replace function pm.dsn_record_decision(p_proposal_item uuid, p_decision text, p_name text, p_comment text default null,
                                                  p_method text default 'IN_PERSON', p_request_deposit boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare pi pm.dsn_proposal_items%rowtype; pr pm.dsn_proposals%rowtype; i pm.dsn_items%rowtype; v_appr uuid; c record; v_dep jsonb; v_open int;
begin
  select * into pi from pm.dsn_proposal_items x where x.id = p_proposal_item for update;
  if pi.org_id is null or pi.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: proposal line % not found in the caller''s organization', p_proposal_item using errcode = '42501';
  end if;
  if p_decision not in ('APPROVED','REJECTED','COMMENTED') then raise exception 'PM_INVALID: decision' using errcode = '22023'; end if;
  if pi.decision in ('APPROVED','REJECTED') then raise exception 'PM_DSN_DECIDED: this item was already %', lower(pi.decision) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'PM_INVALID: the client''s name is required' using errcode = '22023'; end if;
  select * into pr from pm.dsn_proposals x where x.org_id = pi.org_id and x.id = pi.proposal_id for update;
  select * into i from pm.dsn_items x where x.org_id = pi.org_id and x.id = pi.item_id for update;
  if p_decision in ('APPROVED','REJECTED') then
    insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, method, amount_cents, snapshot, comment)
    values (pi.org_id, i.job_id, 'procurement_items', coalesce((select x.id from pm.procurement_items x where x.org_id = pi.org_id and x.dsn_item_id = i.id order by x.created_at limit 1), i.id),
            p_decision, btrim(p_name), coalesce(p_method, 'IN_PERSON'), pi.client_price_cents,
            jsonb_build_object('dsn_item_id', i.id, 'name', i.name, 'room', i.room, 'qty', i.qty, 'client_price_cents', pi.client_price_cents, 'proposal', pr.number),
            nullif(left(p_comment, 2000), ''))
    returning id into v_appr;
  end if;
  update pm.dsn_proposal_items set decision = p_decision, comment = nullif(left(p_comment, 2000), ''), decided_by_name = btrim(p_name),
         decided_method = coalesce(p_method, 'IN_PERSON'), decided_at = now(), client_approval_id = v_appr where id = pi.id;
  if p_decision = 'APPROVED' then
    update pm.dsn_items set status = 'APPROVED', decided_by_name = btrim(p_name), decided_at = now(), client_comment = nullif(left(p_comment, 2000), ''), updated_at = now() where id = i.id;
    for c in select x.id from pm.procurement_items x where x.org_id = pi.org_id and x.dsn_item_id = i.id and x.status in ('SPECIFIED','PROPOSED') loop
      if (select status from pm.procurement_items where id = c.id) = 'SPECIFIED' then perform pm.advance_procurement_item(c.id, 'PROPOSED', current_date, '{}'::jsonb); end if;
      perform pm.advance_procurement_item(c.id, 'APPROVED', current_date, jsonb_build_object('approver_name', btrim(p_name), 'method', coalesce(p_method, 'IN_PERSON')));
    end loop;
    if p_request_deposit and pi.deposit_cents > 0 then v_dep := pm._dsn_request_deposit(pi.org_id, i.job_id, array[i.id]); end if;
  elsif p_decision = 'REJECTED' then
    update pm.dsn_items set status = 'REJECTED', decided_by_name = btrim(p_name), decided_at = now(), client_comment = nullif(left(p_comment, 2000), ''), updated_at = now() where id = i.id;
  else
    update pm.dsn_items set client_comment = nullif(left(p_comment, 2000), ''), updated_at = now() where id = i.id;
  end if;
  select count(*) into v_open from pm.dsn_proposal_items x where x.org_id = pi.org_id and x.proposal_id = pr.id and x.decision in ('PENDING','COMMENTED');
  update pm.dsn_proposals set status = case when v_open = 0 then 'CLOSED' else 'PARTIAL' end, closed_at = case when v_open = 0 then now() end where id = pr.id;
  return jsonb_build_object('proposal_item_id', pi.id, 'decision', p_decision, 'deposit', v_dep, 'open_items', v_open);
end $$;

-- I3. Deposits per item (through pm.deposit_requests → Books customer deposits) and reallocation ----
create table if not exists pm.dsn_item_deposits (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  item_id             uuid not null,
  deposit_request_id  uuid,
  required_cents      bigint not null check (required_cents >= 0),
  allocated_cents     bigint not null default 0,              -- moved by reallocations (+ in / − out)
  status              text not null default 'REQUESTED' check (status in ('REQUESTED','HELD','APPLIED','REFUND_PENDING','CANCELLED')),
  created_by          text default pm.current_user_id(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, item_id) references pm.dsn_items (org_id, job_id, id) deferrable initially immediate,
  foreign key (org_id, deposit_request_id) references pm.deposit_requests (org_id, id) deferrable initially immediate
);
create table if not exists pm.dsn_deposit_moves (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  from_item_id     uuid not null,
  to_item_id       uuid,                                        -- null = held unapplied / refund pending
  cents            bigint not null check (cents > 0),
  reason           text not null check (char_length(btrim(reason)) between 3 and 500),
  memo_payload     jsonb not null,
  books_state      text not null default 'HELD' check (books_state in ('HELD','SENT','ACKED')),
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- One DRAFT deposit request (pm.deposit_requests, emitted by the existing billing path) for items.
create or replace function pm._dsn_request_deposit(p_org uuid, p_job uuid, p_items uuid[]) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_cust uuid; v_total bigint := 0; v_dep uuid; i record; v_names text;
begin
  select j.location_id, j.customer_id into v_loc, v_cust from core.jobs j where j.org_id = p_org and j.id = p_job;
  select coalesce(sum(round(x.client_total_cents * x.deposit_pct)), 0)::bigint, string_agg(x.name, ', ' order by x.room, x.sort)
    into v_total, v_names
    from pm.dsn_items x where x.org_id = p_org and x.job_id = p_job and x.id = any (p_items) and x.status = 'APPROVED'
     and not exists (select 1 from pm.dsn_item_deposits d where d.org_id = p_org and d.item_id = x.id and d.status <> 'CANCELLED');
  if v_total <= 0 then return jsonb_build_object('requested_cents', 0); end if;
  v_dep := gen_random_uuid();
  insert into pm.deposit_requests (id, org_id, location_id, job_id, customer_id, amount_cents, memo, source_ref, created_by)
  values (v_dep, p_org, v_loc, p_job, v_cust, v_total, left('Item deposits: ' || v_names, 500), 'pm:deposit:' || v_dep::text, pm.current_user_id());
  for i in select x.* from pm.dsn_items x where x.org_id = p_org and x.job_id = p_job and x.id = any (p_items) and x.status = 'APPROVED'
             and not exists (select 1 from pm.dsn_item_deposits d where d.org_id = p_org and d.item_id = x.id and d.status <> 'CANCELLED') loop
    insert into pm.dsn_item_deposits (org_id, job_id, item_id, deposit_request_id, required_cents)
    values (p_org, p_job, i.id, v_dep, round(i.client_total_cents * i.deposit_pct)::bigint);
  end loop;
  return jsonb_build_object('deposit_request_id', v_dep, 'requested_cents', v_total);
end $$;

create or replace function pm.dsn_request_deposits(p_job uuid, p_item_ids uuid[])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return pm._dsn_request_deposit(j.org_id, p_job, coalesce(p_item_ids, '{}'));
end $$;

-- Move deposit money held for an item (cancelled / back-ordered) to another item on the job, or hold
-- it unapplied. A memo payload is kept for Books (the liability is per item; no revenue moves).
create or replace function pm.dsn_reallocate_deposit(p_from_item uuid, p_to_item uuid, p_cents bigint, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dsn_items%rowtype; t pm.dsn_items%rowtype; v_held bigint; v_id uuid; v_payload jsonb;
begin
  select * into f from pm.dsn_items x where x.id = p_from_item for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: item % not found in the caller''s organization', p_from_item using errcode = '42501';
  end if;
  if p_to_item is not null then
    select * into t from pm.dsn_items x where x.id = p_to_item and x.org_id = f.org_id and x.job_id = f.job_id for update;
    if t.id is null then raise exception 'PM_INVALID: the target item is not on this project' using errcode = '22023'; end if;
    if t.id = f.id then raise exception 'PM_INVALID: pick another item' using errcode = '22023'; end if;
  end if;
  if coalesce(p_cents, 0) <= 0 then raise exception 'PM_INVALID: amount must be > 0' using errcode = '22023'; end if;
  select coalesce(sum(d.required_cents + d.allocated_cents), 0) into v_held from pm.dsn_item_deposits d
   where d.org_id = f.org_id and d.item_id = f.id and d.status in ('REQUESTED','HELD');
  if p_cents > v_held then raise exception 'PM_DSN_DEPOSIT_SHORT: % holds % cents of deposit', f.name, v_held using errcode = '22023'; end if;
  v_payload := jsonb_build_object('memo', 'DEPOSIT_REALLOCATION', 'job_id', f.job_id, 'from_item_id', f.id, 'from_item', f.name,
                                  'to_item_id', t.id, 'to_item', t.name, 'cents', p_cents, 'reason', btrim(p_reason));
  insert into pm.dsn_deposit_moves (org_id, job_id, from_item_id, to_item_id, cents, reason, memo_payload)
  values (f.org_id, f.job_id, f.id, t.id, p_cents, btrim(p_reason), v_payload) returning id into v_id;
  update pm.dsn_item_deposits set allocated_cents = allocated_cents - p_cents, updated_at = now()
   where id = (select d.id from pm.dsn_item_deposits d where d.org_id = f.org_id and d.item_id = f.id and d.status in ('REQUESTED','HELD') order by d.created_at limit 1);
  if t.id is not null then
    if exists (select 1 from pm.dsn_item_deposits d where d.org_id = f.org_id and d.item_id = t.id and d.status in ('REQUESTED','HELD')) then
      update pm.dsn_item_deposits set allocated_cents = allocated_cents + p_cents, updated_at = now()
       where id = (select d.id from pm.dsn_item_deposits d where d.org_id = f.org_id and d.item_id = t.id and d.status in ('REQUESTED','HELD') order by d.created_at limit 1);
    else
      insert into pm.dsn_item_deposits (org_id, job_id, item_id, required_cents, allocated_cents, status) values (f.org_id, f.job_id, t.id, 0, p_cents, 'HELD');
    end if;
  end if;
  return jsonb_build_object('move_id', v_id, 'from_held_cents', v_held - p_cents);
end $$;

-- Per-item deposit position (requested / allocated / paid per Books invoice of the deposit request).
create or replace view pm.v_dsn_item_deposits with (security_invoker = on) as
select d.org_id, d.job_id, d.item_id, i.name, i.room, d.deposit_request_id, r.status as request_status, r.invoice_number,
       sum(d.required_cents)::bigint as required_cents, sum(d.allocated_cents)::bigint as allocated_cents,
       sum(d.required_cents + d.allocated_cents)::bigint as held_cents
from pm.dsn_item_deposits d
join pm.dsn_items i on i.org_id = d.org_id and i.id = d.item_id
left join pm.deposit_requests r on r.org_id = d.org_id and r.id = d.deposit_request_id
where d.status <> 'CANCELLED'
group by d.org_id, d.job_id, d.item_id, i.name, i.room, d.deposit_request_id, r.status, r.invoice_number;

-- I4. POs grouped by vendor (sidemark on every line) -------------------------------------------
create or replace function pm.dsn_create_pos(p_job uuid, p_component_ids uuid[] default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v record; c record; v_po uuid; v_num text; n int; v_out jsonb := '[]'; v_line uuid; v_cc uuid;
begin
  select * into j from pm._x_job(p_job);
  select c2.id into v_cc from pm.cost_codes c2 where c2.org_id = j.org_id and c2.location_id = j.location_id and c2.cost_type in ('MATERIALS','OTHER')
   order by (c2.cost_type = 'MATERIALS') desc, c2.code limit 1;
  for v in select pi.vendor_id from pm.procurement_items pi
            where pi.org_id = j.org_id and pi.job_id = p_job and pi.status = 'APPROVED' and pi.commitment_id is null and pi.vendor_id is not null
              and (p_component_ids is null or pi.id = any (p_component_ids))
            group by pi.vendor_id order by pi.vendor_id loop
    insert into pm.commitments (org_id, job_id, vendor_id, commitment_type, title, status)
    values (j.org_id, p_job, v.vendor_id, 'PO', 'Design order', 'DRAFT') returning id, number into v_po, v_num;
    n := 0;
    for c in select pi.* from pm.procurement_items pi
              where pi.org_id = j.org_id and pi.job_id = p_job and pi.status = 'APPROVED' and pi.commitment_id is null and pi.vendor_id = v.vendor_id
                and (p_component_ids is null or pi.id = any (p_component_ids))
              order by pi.dsn_item_id, pi.created_at for update loop
      n := n + 1;
      insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, item_id, qty, uom, unit_cost_cents, amount_cents)
      values (j.org_id, v_po, n, v_cc, 'MATERIALS', left(concat_ws(' · ', c.description, c.vendor_sku, 'SIDEMARK ' || c.sidemark), 300), null, c.qty, c.uom,
              coalesce(c.unit_cost_cents, 0), round(c.qty * coalesce(c.unit_cost_cents, 0))::bigint + c.freight_cents)
      returning id into v_line;
      update pm.procurement_items set commitment_id = v_po, commitment_line_id = v_line, po_number = v_num where id = c.id;
    end loop;
    v_out := v_out || jsonb_build_object('commitment_id', v_po, 'number', v_num, 'vendor_id', v.vendor_id, 'lines', n);
  end loop;
  return jsonb_build_object('purchase_orders', v_out);
end $$;

-- I5. The eight-date procurement hub ---------------------------------------------------------
create or replace function pm.dsn_set_component_date(p_component uuid, p_key text, p_on date, p_done boolean default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.procurement_items%rowtype;
begin
  select * into c from pm.procurement_items x where x.id = p_component for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: component % not found in the caller''s organization', p_component using errcode = '42501';
  end if;
  if p_key not in ('order','ship','delivery','install','client_deposit','vendor_deposit','client_balance','vendor_balance') then
    raise exception 'PM_INVALID: date key %', p_key using errcode = '22023';
  end if;
  update pm.procurement_items set
    ordered_on        = case when p_key = 'order' then p_on else ordered_on end,
    shipped_on        = case when p_key = 'ship' then p_on else shipped_on end,
    expected_on       = case when p_key = 'delivery' then p_on else expected_on end,
    install_on        = case when p_key = 'install' then p_on else install_on end,
    client_deposit_on = case when p_key = 'client_deposit' then p_on else client_deposit_on end,
    vendor_deposit_on = case when p_key = 'vendor_deposit' then p_on else vendor_deposit_on end,
    client_balance_on = case when p_key = 'client_balance' then p_on else client_balance_on end,
    vendor_balance_on = case when p_key = 'vendor_balance' then p_on else vendor_balance_on end,
    dates_done        = case when p_done is null then dates_done else dates_done || jsonb_build_object(p_key, p_done) end
  where id = c.id;
  return c.id;
end $$;

create or replace view pm.v_dsn_procurement_hub with (security_invoker = on) as
with d as (
  select pi.org_id, pi.job_id, pi.id as component_id, pi.dsn_item_id, pi.component_kind, pi.description, pi.vendor_id, pi.sidemark, pi.po_number, pi.status,
         pi.tracking_ref, pi.received_condition, pi.freight_claim_open,
         k.key, k.on_date, coalesce((pi.dates_done ->> k.key)::boolean,
           case k.key when 'order' then pi.status not in ('SPECIFIED','PROPOSED','APPROVED')
                      when 'ship' then pi.status in ('SHIPPED','RECEIVED','STORED','DELIVERED','INSTALLED')
                      when 'delivery' then pi.status in ('RECEIVED','STORED','DELIVERED','INSTALLED')
                      when 'install' then pi.status = 'INSTALLED' else false end) as done
    from pm.procurement_items pi
    cross join lateral (values ('order', pi.ordered_on), ('ship', pi.shipped_on), ('delivery', pi.expected_on), ('install', pi.install_on),
                               ('client_deposit', pi.client_deposit_on), ('vendor_deposit', pi.vendor_deposit_on),
                               ('client_balance', pi.client_balance_on), ('vendor_balance', pi.vendor_balance_on)) as k(key, on_date)
   where pi.dsn_item_id is not null and pi.status not in ('CANCELLED','RETURNED')
)
select d.org_id, d.job_id, d.component_id, d.dsn_item_id, i.name as item_name, i.room, d.component_kind, d.description, d.vendor_id, d.sidemark,
       d.po_number, d.status, d.tracking_ref, d.received_condition, d.freight_claim_open,
       jsonb_object_agg(d.key, jsonb_build_object('on', d.on_date, 'done', d.done)) as dates,
       min(d.on_date) filter (where not d.done and d.on_date is not null) as next_due_on,
       case when min(d.on_date) filter (where not d.done and d.on_date is not null) is null then
              case when bool_and(d.done or d.on_date is null) then 'DONE' else 'UNSCHEDULED' end
            when min(d.on_date) filter (where not d.done and d.on_date is not null) < current_date then 'OVERDUE'
            when min(d.on_date) filter (where not d.done and d.on_date is not null) = current_date then 'TODAY'
            when min(d.on_date) filter (where not d.done and d.on_date is not null) <= current_date + 7 then 'THIS_WEEK'
            else 'LATER' end as bucket
from d join pm.dsn_items i on i.org_id = d.org_id and i.id = d.dsn_item_id
group by d.org_id, d.job_id, d.component_id, d.dsn_item_id, i.name, i.room, d.component_kind, d.description, d.vendor_id, d.sidemark, d.po_number,
         d.status, d.tracking_ref, d.received_condition, d.freight_claim_open;

-- I6. Receiving / inspection at the receiver or warehouse ---------------------------------------
create or replace function pm.dsn_receive_component(p_component uuid, p_condition text, p_qty numeric default null, p_storage_location uuid default null,
                                                    p_photos uuid[] default '{}', p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.procurement_items%rowtype; v_to text;
begin
  select * into c from pm.procurement_items x where x.id = p_component for update;
  if c.org_id is null or c.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: component % not found in the caller''s organization', p_component using errcode = '42501';
  end if;
  if p_condition not in ('GOOD','DAMAGED','PARTIAL','WRONG_ITEM') then raise exception 'PM_INVALID: condition' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_photos, '{}')) d where not exists (select 1 from public.documents x where x.id = d and x.org_id = c.org_id)) then
    raise exception 'PM_INVALID: a photo is not a document of this organization' using errcode = '22023';
  end if;
  if p_condition in ('DAMAGED','WRONG_ITEM') and coalesce(cardinality(p_photos), 0) = 0 then
    raise exception 'PM_INVALID: photograph the damage before you receive it' using errcode = '22023';
  end if;
  v_to := case when c.status = 'SHIPPED' and p_condition = 'DAMAGED' then 'DAMAGED' else 'RECEIVED' end;
  perform pm.advance_procurement_item(c.id, v_to, current_date,
            jsonb_strip_nulls(jsonb_build_object('received_qty', p_qty, 'received_condition', case when p_condition = 'DAMAGED' and v_to = 'RECEIVED' then 'DAMAGED' else p_condition end,
                                                 'storage_location_id', p_storage_location, 'note', nullif(left(p_notes, 1000), ''))));
  update pm.procurement_items set receive_photo_ids = coalesce(p_photos, '{}'), freight_claim_open = p_condition in ('DAMAGED','WRONG_ITEM') where id = c.id;
  if c.dsn_item_id is not null and not exists (select 1 from pm.procurement_items x where x.org_id = c.org_id and x.dsn_item_id = c.dsn_item_id
                                                   and x.status not in ('RECEIVED','STORED','DELIVERED','INSTALLED','CANCELLED')) then
    update pm.dsn_items set status = 'RECEIVED', updated_at = now() where org_id = c.org_id and id = c.dsn_item_id and status in ('APPROVED','ORDERED');
  end if;
  return jsonb_build_object('component_id', c.id, 'status', v_to, 'freight_claim', p_condition in ('DAMAGED','WRONG_ITEM'));
end $$;

-- I7. Fee agreements, fee invoicing, time billing ----------------------------------------------
create table if not exists pm.dsn_fee_agreements (
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  fee_model                 text not null check (fee_model in ('HOURLY','FLAT_PHASE','PCT_BUDGET','COST_PLUS','PROCUREMENT_FEE','HYBRID')),
  hourly_rate_cents         bigint check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  rate_groups               jsonb not null default '{}' check (jsonb_typeof(rate_groups) = 'object'),     -- {"PRINCIPAL": 25000, "DESIGNER": 15000}
  phases                    jsonb not null default '[]' check (jsonb_typeof(phases) = 'array'),          -- [{key,label,fee_cents,pct_complete}]
  pct_of_budget             numeric(6,5) check (pct_of_budget is null or (pct_of_budget >= 0 and pct_of_budget <= 1)),
  budget_cents              bigint check (budget_cents is null or budget_cents >= 0),
  procurement_fee_pct       numeric(6,5) check (procurement_fee_pct is null or (procurement_fee_pct >= 0 and procurement_fee_pct <= 1)),
  reimbursable_markup_pct   numeric(6,5) check (reimbursable_markup_pct is null or (reimbursable_markup_pct >= 0 and reimbursable_markup_pct <= 1)),
  retainer_cents            bigint not null default 0 check (retainer_cents >= 0),
  retainer_evergreen        boolean not null default false,
  updated_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dsn_fee_ledger (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  billing_request_id  uuid not null,
  kind                text not null check (kind in ('TIME','PHASE','PCT_BUDGET','PROCUREMENT_FEE','RETAINER')),
  key                 text,
  cents               bigint not null,
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate
);
create table if not exists pm.dsn_billed_time (
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  time_entry_id       uuid not null,
  job_id              uuid not null,
  billing_request_id  uuid not null,
  hours               numeric(6,2) not null,
  rate_cents          bigint not null,
  amount_cents        bigint not null,
  created_at          timestamptz not null default now(),
  primary key (org_id, time_entry_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, billing_request_id) references pm.billing_requests (org_id, id) on delete cascade deferrable initially immediate
);

create or replace function pm.dsn_set_fee_agreement(p_job uuid, p_agreement jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a jsonb := coalesce(p_agreement, '{}'); e jsonb;
begin
  select * into j from pm._x_job(p_job);
  if coalesce(a ->> 'fee_model', '') not in ('HOURLY','FLAT_PHASE','PCT_BUDGET','COST_PLUS','PROCUREMENT_FEE','HYBRID') then
    raise exception 'PM_INVALID: fee model' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(a -> 'phases', '[]')) <> 'array' or jsonb_typeof(coalesce(a -> 'rate_groups', '{}')) <> 'object' then
    raise exception 'PM_INVALID: phases must be a list and rate groups an object' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(coalesce(a -> 'phases', '[]')) loop
    if nullif(e ->> 'key', '') is null or coalesce(pm._x_try_bigint(e ->> 'fee_cents'), -1) < 0
       or coalesce(pm._x_try_num(e ->> 'pct_complete'), 0) not between 0 and 1 then
      raise exception 'PM_INVALID: each phase needs a key, a fee ≥ 0 and a percent complete between 0 and 1' using errcode = '22023';
    end if;
  end loop;
  insert into pm.dsn_fee_agreements (org_id, job_id, fee_model, hourly_rate_cents, rate_groups, phases, pct_of_budget, budget_cents, procurement_fee_pct,
                                     reimbursable_markup_pct, retainer_cents, retainer_evergreen)
  values (j.org_id, p_job, a ->> 'fee_model', pm._x_try_bigint(a ->> 'hourly_rate_cents'), coalesce(a -> 'rate_groups', '{}'), coalesce(a -> 'phases', '[]'),
          pm._x_try_num(a ->> 'pct_of_budget'), pm._x_try_bigint(a ->> 'budget_cents'), pm._x_try_num(a ->> 'procurement_fee_pct'),
          pm._x_try_num(a ->> 'reimbursable_markup_pct'), coalesce(pm._x_try_bigint(a ->> 'retainer_cents'), 0), coalesce(pm._x_try_bool(a ->> 'retainer_evergreen'), false))
  on conflict (org_id, job_id) do update set fee_model = excluded.fee_model, hourly_rate_cents = excluded.hourly_rate_cents, rate_groups = excluded.rate_groups,
     phases = excluded.phases, pct_of_budget = excluded.pct_of_budget, budget_cents = excluded.budget_cents, procurement_fee_pct = excluded.procurement_fee_pct,
     reimbursable_markup_pct = excluded.reimbursable_markup_pct, retainer_cents = excluded.retainer_cents, retainer_evergreen = excluded.retainer_evergreen,
     updated_by = pm.current_user_id(), updated_at = now();
  return p_job;
end $$;

-- Draft the fee invoice (a DRAFT pm.billing_requests TIME_MATERIALS request; approval + emission are
-- the existing billing path). Kinds: TIME (approved billable hours not billed yet, at the entry's bill
-- rate, else the agreement rate), PHASE (fee × % complete − billed), PCT_BUDGET (pct × budget × overall
-- phase progress − billed), PROCUREMENT_FEE (pct × approved merchandise − billed). Billed hours lock.
create or replace function pm.dsn_draft_fee_invoice(p_job uuid, p_through date default null, p_kinds text[] default array['TIME','PHASE','PCT_BUDGET','PROCUREMENT_FEE'])
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; a pm.dsn_fee_agreements%rowtype; v_br uuid := gen_random_uuid(); v_through date := coalesce(p_through, current_date); n int := 0;
        te record; v_rate bigint; v_amt bigint; ph jsonb; v_billed bigint; v_earned bigint; v_total bigint := 0; v_merch bigint; v_prog numeric;
begin
  select * into j from pm._x_job(p_job);
  select * into a from pm.dsn_fee_agreements x where x.org_id = j.org_id and x.job_id = p_job;
  if a.org_id is null then raise exception 'PM_DSN_NO_AGREEMENT: set the fee agreement first' using errcode = '22023'; end if;
  insert into pm.billing_requests (id, org_id, location_id, job_id, billing_type, period_end, occurred_on, memo, source_ref)
  values (v_br, j.org_id, j.location_id, p_job, 'TIME_MATERIALS', v_through, current_date, 'Design fees through ' || to_char(v_through, 'Mon DD, YYYY'),
          'pm:dsnfee:' || v_br::text);
  if 'TIME' = any (p_kinds) then
    for te in select t.* from pm.time_entries t
               where t.org_id = j.org_id and t.job_id = p_job and t.approval_state = 'APPROVED' and t.billable and t.work_date <= v_through
                 and not exists (select 1 from pm.dsn_billed_time b where b.org_id = t.org_id and b.time_entry_id = t.id)
               order by t.work_date, t.created_at loop
      v_rate := coalesce(te.bill_rate_cents, a.hourly_rate_cents, 0);
      continue when v_rate = 0;
      v_amt := round(te.hours * v_rate)::bigint;
      n := n + 1;
      insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, description, amount_cents)
      values (j.org_id, v_br, n, n, left(format('Design time %s: %s h × $%s%s', to_char(te.work_date, 'Mon DD'), te.hours, to_char(v_rate / 100.0, 'FM999990.00'),
                                         coalesce(' — ' || nullif(te.notes, ''), '')), 300), v_amt);
      insert into pm.dsn_billed_time (org_id, time_entry_id, job_id, billing_request_id, hours, rate_cents, amount_cents)
      values (j.org_id, te.id, p_job, v_br, te.hours, v_rate, v_amt);
      insert into pm.dsn_fee_ledger (org_id, job_id, billing_request_id, kind, key, cents) values (j.org_id, p_job, v_br, 'TIME', te.id::text, v_amt);
      v_total := v_total + v_amt;
    end loop;
  end if;
  if 'PHASE' = any (p_kinds) and a.fee_model in ('FLAT_PHASE','HYBRID') then
    for ph in select * from jsonb_array_elements(a.phases) loop
      v_earned := round(coalesce(pm._x_try_bigint(ph ->> 'fee_cents'), 0) * coalesce(pm._x_try_num(ph ->> 'pct_complete'), 0))::bigint;
      select coalesce(sum(l.cents), 0) into v_billed from pm.dsn_fee_ledger l join pm.billing_requests b on b.org_id = l.org_id and b.id = l.billing_request_id
       where l.org_id = j.org_id and l.job_id = p_job and l.kind = 'PHASE' and l.key = ph ->> 'key' and b.status not in ('VOID','REJECTED');
      continue when v_earned - v_billed <= 0;
      n := n + 1;
      insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, description, amount_cents)
      values (j.org_id, v_br, n, n, left(format('%s — %s%% complete', coalesce(ph ->> 'label', ph ->> 'key'), round(coalesce(pm._x_try_num(ph ->> 'pct_complete'), 0) * 100)), 300),
              v_earned - v_billed);
      insert into pm.dsn_fee_ledger (org_id, job_id, billing_request_id, kind, key, cents) values (j.org_id, p_job, v_br, 'PHASE', ph ->> 'key', v_earned - v_billed);
      v_total := v_total + v_earned - v_billed;
    end loop;
  end if;
  if 'PCT_BUDGET' = any (p_kinds) and a.fee_model in ('PCT_BUDGET','HYBRID') and coalesce(a.pct_of_budget, 0) > 0 and coalesce(a.budget_cents, 0) > 0 then
    select case when jsonb_array_length(a.phases) = 0 then 0 else avg(coalesce(pm._x_try_num(p ->> 'pct_complete'), 0)) end into v_prog from jsonb_array_elements(a.phases) p;
    v_earned := round(a.budget_cents * a.pct_of_budget * coalesce(v_prog, 0))::bigint;
    select coalesce(sum(l.cents), 0) into v_billed from pm.dsn_fee_ledger l join pm.billing_requests b on b.org_id = l.org_id and b.id = l.billing_request_id
     where l.org_id = j.org_id and l.job_id = p_job and l.kind = 'PCT_BUDGET' and b.status not in ('VOID','REJECTED');
    if v_earned - v_billed > 0 then
      n := n + 1;
      insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, description, amount_cents)
      values (j.org_id, v_br, n, n, format('Design fee: %s%% of budget, %s%% complete', round(a.pct_of_budget * 100, 2), round(coalesce(v_prog, 0) * 100)), v_earned - v_billed);
      insert into pm.dsn_fee_ledger (org_id, job_id, billing_request_id, kind, cents) values (j.org_id, p_job, v_br, 'PCT_BUDGET', v_earned - v_billed);
      v_total := v_total + v_earned - v_billed;
    end if;
  end if;
  if 'PROCUREMENT_FEE' = any (p_kinds) and coalesce(a.procurement_fee_pct, 0) > 0 then
    select coalesce(sum(i.client_total_cents), 0) into v_merch from pm.dsn_items i
     where i.org_id = j.org_id and i.job_id = p_job and i.status in ('APPROVED','ORDERED','RECEIVED','DELIVERED','INSTALLED');
    v_earned := round(v_merch * a.procurement_fee_pct)::bigint;
    select coalesce(sum(l.cents), 0) into v_billed from pm.dsn_fee_ledger l join pm.billing_requests b on b.org_id = l.org_id and b.id = l.billing_request_id
     where l.org_id = j.org_id and l.job_id = p_job and l.kind = 'PROCUREMENT_FEE' and b.status not in ('VOID','REJECTED');
    if v_earned - v_billed > 0 then
      n := n + 1;
      insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, description, amount_cents)
      values (j.org_id, v_br, n, n, format('Procurement fee: %s%% of approved merchandise', round(a.procurement_fee_pct * 100, 2)), v_earned - v_billed);
      insert into pm.dsn_fee_ledger (org_id, job_id, billing_request_id, kind, cents) values (j.org_id, p_job, v_br, 'PROCUREMENT_FEE', v_earned - v_billed);
      v_total := v_total + v_earned - v_billed;
    end if;
  end if;
  if n = 0 then
    delete from pm.billing_requests where id = v_br;
    return jsonb_build_object('billing_request_id', null, 'lines', 0, 'total_cents', 0);
  end if;
  update pm.billing_requests set gross_earned_cents = v_total, net_cents = v_total where id = v_br;
  return jsonb_build_object('billing_request_id', v_br, 'lines', n, 'total_cents', v_total);
end $$;

-- Billed design time is locked while its invoice stands (a VOID / REJECTED request releases it).
create or replace function pm.tg_dsn_billed_time_lock() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if exists (select 1 from pm.dsn_billed_time b join pm.billing_requests r on r.org_id = b.org_id and r.id = b.billing_request_id
              where b.org_id = old.org_id and b.time_entry_id = old.id and r.status not in ('VOID','REJECTED')) then
    if tg_op = 'DELETE' or new.hours is distinct from old.hours or new.work_date is distinct from old.work_date or new.job_id is distinct from old.job_id
       or new.billable is distinct from old.billable or new.bill_rate_cents is distinct from old.bill_rate_cents
       or (new.approval_state is distinct from old.approval_state and new.approval_state <> 'APPROVED') then
      raise exception 'PM_TIME_BILLED: these hours are on a design invoice; void the invoice to change them' using errcode = '55000';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists zz_dsn_billed_time_lock on pm.time_entries;
create trigger zz_dsn_billed_time_lock before update or delete on pm.time_entries for each row execute function pm.tg_dsn_billed_time_lock();

-- ============================================================================
-- R. Real-estate development (SPE = project = Books entity)
-- ============================================================================

-- R1. Development project record + SPE request + key dates --------------------------------------
create table if not exists pm.dev_projects (
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  spe_name               text,
  spe_location_id        uuid references core.locations(id),        -- the Books entity (company) of the SPE
  sponsor_location_id    uuid references core.locations(id),
  product_type           text not null default 'FOR_RENT' check (product_type in ('FOR_RENT','FOR_SALE','MIXED')),
  stage                  text not null default 'PURSUIT' check (stage in ('PURSUIT','UNDER_CONTRACT','PRE_DEVELOPMENT','SPE_FORMED','CAPITALIZED',
                           'CONSTRUCTION','SUBSTANTIAL_COMPLETION','LEASE_UP','STABILIZED','REFI_DISPOSITION','WIND_DOWN','DEAD')),
  address                text,
  parcels                text[] not null default '{}',
  gc_vendor_id           uuid references core.vendors(id),
  contract_type          text check (contract_type is null or contract_type in ('GMP','STIPULATED_SUM','COST_PLUS')),
  block_out_of_balance   boolean not null default true,
  schedule_behind_days   int not null default 0 check (schedule_behind_days >= 0),
  spe_request_status     text not null default 'NONE' check (spe_request_status in ('NONE','REQUESTED','PROVISIONED')),
  updated_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dev_spe_requests (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),     -- the sponsor company that asks
  job_id               uuid not null,
  payload              jsonb not null check (jsonb_typeof(payload) = 'object'),
  status               text not null default 'REQUESTED' check (status in ('REQUESTED','PROVISIONED','REJECTED')),
  provisioned_location_id uuid references core.locations(id),
  books_note           text,
  requested_by         text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.dev_key_dates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  kind            text not null check (kind in ('DD_EXPIRY','EARNEST_HARD_DATE','PSA_CLOSING','LOAN_CLOSING','RATE_LOCK','COMPLETION_GUARANTY',
                                                'OUTSIDE_COMPLETION','LOAN_MATURITY','EXTENSION_OPTION','RATE_CAP_EXPIRY','LENDER_REPORT','INVESTOR_REPORT','OTHER')),
  label           text,
  due_on          date not null,
  status          text not null default 'OPEN' check (status in ('OPEN','DONE','WAIVED')),
  reminder_days   int not null default 14 check (reminder_days between 0 and 365),
  notes           text,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_dev_key_dates_idx on pm.dev_key_dates (org_id, job_id, due_on) where status = 'OPEN';

create or replace function pm.dev_set_project(p_job uuid, p_fields jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; f jsonb := coalesce(p_fields, '{}'); k text;
begin
  select * into j from pm._x_job(p_job);
  for k in select jsonb_object_keys(f) loop
    if k not in ('spe_name','spe_location_id','sponsor_location_id','product_type','stage','address','parcels','gc_vendor_id','contract_type',
                 'block_out_of_balance','schedule_behind_days') then
      raise exception 'PM_INVALID: % is not a development project field', k using errcode = '22023';
    end if;
  end loop;
  if f ? 'spe_location_id' and pm.access_try_uuid(f ->> 'spe_location_id') is not null
     and not exists (select 1 from core.locations l where l.id = pm.access_try_uuid(f ->> 'spe_location_id') and l.org_id = j.org_id) then
    raise exception 'PM_FORBIDDEN: that entity is not in the caller''s organization' using errcode = '42501';
  end if;
  if f ? 'block_out_of_balance' and not coalesce(pm._x_try_bool(f ->> 'block_out_of_balance'), true) and not pm.access_can_job('projects.financials', 'edit', p_job) then
    raise exception 'PM_FORBIDDEN: turning off the in-balance block needs projects.financials:edit' using errcode = '42501';
  end if;
  insert into pm.dev_projects (org_id, job_id) values (j.org_id, p_job) on conflict do nothing;
  update pm.dev_projects set
    spe_name             = case when f ? 'spe_name' then nullif(left(btrim(f ->> 'spe_name'), 200), '') else spe_name end,
    spe_location_id      = case when f ? 'spe_location_id' then pm.access_try_uuid(f ->> 'spe_location_id') else spe_location_id end,
    sponsor_location_id  = case when f ? 'sponsor_location_id' then pm.access_try_uuid(f ->> 'sponsor_location_id') else sponsor_location_id end,
    product_type         = case when f ? 'product_type' then coalesce(nullif(f ->> 'product_type', ''), product_type) else product_type end,
    stage                = case when f ? 'stage' then coalesce(nullif(f ->> 'stage', ''), stage) else stage end,
    address              = case when f ? 'address' then nullif(left(f ->> 'address', 500), '') else address end,
    parcels              = case when f ? 'parcels' then array(select left(x, 60) from jsonb_array_elements_text(f -> 'parcels') x limit 50) else parcels end,
    gc_vendor_id         = case when f ? 'gc_vendor_id' then pm.access_try_uuid(f ->> 'gc_vendor_id') else gc_vendor_id end,
    contract_type        = case when f ? 'contract_type' then nullif(f ->> 'contract_type', '') else contract_type end,
    block_out_of_balance = case when f ? 'block_out_of_balance' then coalesce(pm._x_try_bool(f ->> 'block_out_of_balance'), true) else block_out_of_balance end,
    schedule_behind_days = case when f ? 'schedule_behind_days' then greatest(coalesce(pm._x_try_num(f ->> 'schedule_behind_days')::int, 0), 0) else schedule_behind_days end,
    updated_by = pm.current_user_id(), updated_at = now()
  where org_id = j.org_id and job_id = p_job;
  return p_job;
end $$;

-- The SPE setup wizard's Books hand-off. Books exposes no entity-provisioning action to Projects, so
-- the wizard files one documented request (entity, COA template, bank placeholder, budget template,
-- investor classes, intercompany link to the sponsor); Books provisions it and answers through
-- pm.dev_mark_spe_provisioned (service role). Nothing is keyed twice: the provisioned entity is
-- written back onto the project.
create or replace function pm.dev_request_spe(p_job uuid, p_payload jsonb)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid; p jsonb := coalesce(p_payload, '{}'); v_sponsor uuid;
begin
  select * into j from pm._x_job(p_job);
  if nullif(btrim(coalesce(p ->> 'entity_name', '')), '') is null then raise exception 'PM_INVALID: the SPE needs its legal name' using errcode = '22023'; end if;
  v_sponsor := coalesce(pm.access_try_uuid(p ->> 'sponsor_location_id'), j.location_id);
  if not exists (select 1 from core.locations l where l.id = v_sponsor and l.org_id = j.org_id) then
    raise exception 'PM_FORBIDDEN: sponsor entity not in the caller''s organization' using errcode = '42501';
  end if;
  if exists (select 1 from pm.dev_spe_requests r where r.org_id = j.org_id and r.job_id = p_job and r.status = 'REQUESTED') then
    raise exception 'PM_DUPLICATE: an SPE request for this project is already open' using errcode = '23505';
  end if;
  insert into pm.dev_spe_requests (org_id, location_id, job_id, payload)
  values (j.org_id, v_sponsor, p_job, jsonb_build_object(
    'request', 'PROVISION_SPE_ENTITY', 'schema_version', 1, 'job_id', p_job, 'sponsor_location_id', v_sponsor,
    'entity_name', btrim(p ->> 'entity_name'), 'entity_type', coalesce(p ->> 'entity_type', 'LLC'), 'state_of_formation', p ->> 'state_of_formation',
    'ein_status', coalesce(p ->> 'ein_status', 'PENDING'), 'coa_template', coalesce(p ->> 'coa_template', 'REAL_ESTATE_DEVELOPMENT'),
    'bank_placeholder', coalesce(p -> 'bank_placeholder', jsonb_build_object('name', 'Operating account (to be opened)')),
    'budget_template', coalesce(p ->> 'budget_template', 'DEVELOPMENT_STANDARD'),
    'investor_classes', coalesce(p -> 'investor_classes', '[]'::jsonb), 'intercompany', jsonb_build_object('with_location_id', v_sponsor, 'kind', 'SPONSOR_SPE'),
    'cip_capitalize', true))
  returning id into v_id;
  insert into pm.dev_projects (org_id, job_id, spe_name, sponsor_location_id, spe_request_status) values (j.org_id, p_job, btrim(p ->> 'entity_name'), v_sponsor, 'REQUESTED')
  on conflict (org_id, job_id) do update set spe_name = excluded.spe_name, sponsor_location_id = excluded.sponsor_location_id, spe_request_status = 'REQUESTED',
     updated_at = now();
  perform pm.log_activity(j.org_id, j.location_id, p_job, 'development.spe_requested', 'dev_spe_requests', v_id,
    format('SPE requested from Books: %s', btrim(p ->> 'entity_name')), '{}'::jsonb);
  return v_id;
end $$;

-- Books' answer (service role only — never member-executable).
create or replace function pm.dev_mark_spe_provisioned(p_request uuid, p_location uuid, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dev_spe_requests%rowtype;
begin
  if not pm.access_is_service() then raise exception 'PM_FORBIDDEN: Books provisions SPE entities' using errcode = '42501'; end if;
  select * into r from pm.dev_spe_requests x where x.id = p_request for update;
  if r.id is null or r.status <> 'REQUESTED' then raise exception 'PM_INVALID: request is not open' using errcode = '22023'; end if;
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = r.org_id) then raise exception 'PM_INVALID: entity' using errcode = '22023'; end if;
  update pm.dev_spe_requests set status = 'PROVISIONED', provisioned_location_id = p_location, books_note = p_note, updated_at = now() where id = r.id;
  update pm.dev_projects set spe_location_id = p_location, spe_request_status = 'PROVISIONED', stage = case when stage in ('PURSUIT','UNDER_CONTRACT','PRE_DEVELOPMENT') then 'SPE_FORMED' else stage end,
         updated_at = now() where org_id = r.org_id and job_id = r.job_id;
  return r.id;
end $$;

-- R2. Pro forma (versioned) with deterministic returns -----------------------------------------
create table if not exists pm.dev_pro_formas (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id       uuid not null,
  label        text not null check (char_length(btrim(label)) between 1 and 80),
  kind         text not null default 'SCENARIO' check (kind in ('UNDERWRITTEN','IC_APPROVED','CURRENT','SCENARIO')),
  status       text not null default 'DRAFT' check (status in ('DRAFT','LOCKED')),
  inputs       jsonb not null check (jsonb_typeof(inputs) = 'object'),
  results      jsonb,
  computed_at  timestamptz,
  locked_by    text,
  locked_at    timestamptz,
  created_by   text default pm.current_user_id(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- IRR of periodic cash flows (bisection on [-0.99, 10]; null when no sign change). Deterministic;
-- mirrored by lib/development/returns.ts (same bounds, 200 iterations, 1e-10 tolerance).
create or replace function pm.dev_irr(p_flows numeric[]) returns numeric
language plpgsql immutable
as $$
declare lo numeric := -0.99; hi numeric := 10; mid numeric; f_lo numeric; f_hi numeric; f_mid numeric; i int; k int;
begin
  if p_flows is null or array_length(p_flows, 1) < 2 then return null; end if;
  f_lo := 0; for k in 1 .. array_length(p_flows, 1) loop f_lo := f_lo + p_flows[k] / power(1 + lo, k - 1); end loop;
  f_hi := 0; for k in 1 .. array_length(p_flows, 1) loop f_hi := f_hi + p_flows[k] / power(1 + hi, k - 1); end loop;
  if sign(f_lo) = sign(f_hi) then return null; end if;
  for i in 1 .. 200 loop
    mid := (lo + hi) / 2;
    f_mid := 0; for k in 1 .. array_length(p_flows, 1) loop f_mid := f_mid + p_flows[k] / power(1 + mid, k - 1); end loop;
    if abs(f_mid) < 1e-10 or (hi - lo) / 2 < 1e-12 then exit; end if;
    if sign(f_mid) = sign(f_lo) then lo := mid; f_lo := f_mid; else hi := mid; end if;
  end loop;
  return round(mid, 6);
end $$;

-- inputs: {total_cost_cents, loan_cents, interest_rate, amort_years (null = interest only), noi_annual_cents,
--          equity_cash_flows_cents: [period 0 (negative contribution) … exit], periods_per_year (1 | 12)}
create or replace function pm.dev_compute_pro_forma(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dev_pro_formas%rowtype; i jsonb; v_cost numeric; v_loan numeric; v_rate numeric; v_amort numeric; v_noi numeric; v_ds numeric;
        v_flows numeric[]; v_irr numeric; v_ppy int; v_in numeric; v_out numeric; r jsonb;
begin
  select * into f from pm.dev_pro_formas x where x.id = p_id for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pro forma % not found in the caller''s organization', p_id using errcode = '42501';
  end if;
  if f.status = 'LOCKED' then raise exception 'PM_DEV_LOCKED: a locked pro forma does not change; copy it' using errcode = '55000'; end if;
  i := f.inputs;
  v_cost := pm._x_try_num(i ->> 'total_cost_cents'); v_loan := coalesce(pm._x_try_num(i ->> 'loan_cents'), 0);
  v_rate := coalesce(pm._x_try_num(i ->> 'interest_rate'), 0); v_amort := pm._x_try_num(i ->> 'amort_years');
  v_noi := pm._x_try_num(i ->> 'noi_annual_cents'); v_ppy := coalesce(pm._x_try_num(i ->> 'periods_per_year')::int, 1);
  v_ds := case when v_loan <= 0 then 0
               when v_amort is null or v_amort <= 0 then round(v_loan * v_rate)
               else pm.fs_monthly_payment(v_loan::bigint, v_rate, (v_amort * 12)::int) * 12 end;
  v_flows := array(select pm._x_try_num(x) from jsonb_array_elements_text(coalesce(i -> 'equity_cash_flows_cents', '[]')) x);
  v_irr := pm.dev_irr(v_flows);
  select coalesce(sum(-x) filter (where x < 0), 0), coalesce(sum(x) filter (where x > 0), 0) into v_in, v_out from unnest(v_flows) x;
  r := jsonb_build_object(
    'yield_on_cost', case when coalesce(v_cost, 0) > 0 and v_noi is not null then round(v_noi / v_cost, 5) end,
    'ltc', case when coalesce(v_cost, 0) > 0 then round(v_loan / v_cost, 5) end,
    'annual_debt_service_cents', round(v_ds)::bigint,
    'dscr', case when v_ds > 0 and v_noi is not null then round(v_noi / v_ds, 3) end,
    'equity_multiple', case when v_in > 0 then round(v_out / v_in, 3) end,
    'irr_period', v_irr,
    'irr_annual', case when v_irr is null then null when v_ppy = 1 then v_irr else round(power(1 + v_irr, v_ppy) - 1, 6) end,
    'equity_in_cents', v_in::bigint, 'equity_out_cents', v_out::bigint, 'periods_per_year', v_ppy);
  update pm.dev_pro_formas set results = r, computed_at = now(), updated_at = now() where id = f.id;
  return r;
end $$;

create or replace function pm.dev_save_pro_forma(p_job uuid, p_label text, p_kind text, p_inputs jsonb, p_id uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid := p_id;
begin
  select * into j from pm._x_job(p_job);
  if jsonb_typeof(coalesce(p_inputs, 'null')) <> 'object' then raise exception 'PM_INVALID: inputs' using errcode = '22023'; end if;
  if v_id is null then
    insert into pm.dev_pro_formas (org_id, job_id, label, kind, inputs) values (j.org_id, p_job, left(btrim(coalesce(p_label, 'Scenario')), 80), coalesce(p_kind, 'SCENARIO'), p_inputs)
    returning id into v_id;
  else
    update pm.dev_pro_formas set label = left(btrim(coalesce(p_label, label)), 80), kind = coalesce(p_kind, kind), inputs = p_inputs, updated_at = now()
     where id = v_id and org_id = j.org_id and job_id = p_job and status = 'DRAFT';
    if not found then raise exception 'PM_DEV_LOCKED: only a draft pro forma on this project changes' using errcode = '55000'; end if;
  end if;
  return jsonb_build_object('pro_forma_id', v_id, 'results', pm.dev_compute_pro_forma(v_id));
end $$;

create or replace function pm.dev_lock_pro_forma(p_id uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare f pm.dev_pro_formas%rowtype;
begin
  select * into f from pm.dev_pro_formas x where x.id = p_id for update;
  if f.org_id is null or f.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: pro forma % not found in the caller''s organization', p_id using errcode = '42501';
  end if;
  if f.status = 'LOCKED' then return f.id; end if;
  perform pm.dev_compute_pro_forma(f.id);
  update pm.dev_pro_formas set status = 'LOCKED', locked_by = pm.current_user_id(), locked_at = now() where id = f.id;
  return f.id;
end $$;

-- R3. Sources & uses (capital stack) -----------------------------------------------------
create table if not exists pm.dev_sources (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  kind               text not null check (kind in ('SENIOR_LOAN','MEZZ','PREF_EQUITY','SPONSOR_EQUITY','LP_EQUITY','TIF','GRANT','TAX_CREDIT','OTHER')),
  name               text not null check (char_length(btrim(name)) between 1 and 120),
  commitment_cents   bigint not null check (commitment_cents >= 0),
  funded_cents       bigint not null default 0 check (funded_cents >= 0),       -- recorded; replaced by Books balances when exposed
  funded_as_of       date,
  rank               int not null default 1 check (rank between 1 and 20),
  funding_rule       text not null default 'SEQUENCED' check (funding_rule in ('EQUITY_FIRST','PRO_RATA','SEQUENCED')),
  draw_schedule_id   uuid,
  notes              text,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id, draw_schedule_id) references pm.draw_schedules (org_id, job_id, id) deferrable initially immediate
);

-- R4. Budget columns + lender / CIP mapping + contingency pools -----------------------------------
--   The working budget is pm.budgets (ORIGINAL / REVISED by cost code); dev_budget_lines maps each cost
--   code to its category, the lender loan-budget line (1107 draw_budget_lines) and the Books CIP account.
create table if not exists pm.dev_budget_lines (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  cost_code_id         uuid not null,
  category             text not null check (category in ('LAND','HARD','SOFT','FINANCING','INTEREST_RESERVE','CONTINGENCY','DEVELOPER_FEE','OTHER')),
  contingency_pool     text check (contingency_pool is null or contingency_pool in ('HARD','SOFT','OWNER')),
  draw_budget_line_id  uuid,
  cip_account_ref      text check (cip_account_ref is null or char_length(cip_account_ref) <= 60),
  sort                 int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, cost_code_id),
  check ((category = 'CONTINGENCY') = (contingency_pool is not null)),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, draw_budget_line_id) references pm.draw_budget_lines (org_id, id) deferrable initially immediate
);

create or replace function pm.dev_map_budget_line(p_job uuid, p_cost_code uuid, p_category text, p_contingency_pool text default null,
                                                  p_draw_budget_line uuid default null, p_cip_account_ref text default null, p_sort int default 0)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_id uuid;
begin
  select * into j from pm._x_job(p_job);
  if not exists (select 1 from pm.cost_codes c where c.org_id = j.org_id and c.id = p_cost_code) then raise exception 'PM_INVALID: cost code' using errcode = '22023'; end if;
  if p_draw_budget_line is not null and not exists (select 1 from pm.draw_budget_lines d where d.org_id = j.org_id and d.id = p_draw_budget_line and d.job_id = p_job) then
    raise exception 'PM_INVALID: the lender line is not on this project' using errcode = '22023';
  end if;
  insert into pm.dev_budget_lines (org_id, job_id, cost_code_id, category, contingency_pool, draw_budget_line_id, cip_account_ref, sort)
  values (j.org_id, p_job, p_cost_code, p_category, case when p_category = 'CONTINGENCY' then coalesce(p_contingency_pool, 'HARD') end, p_draw_budget_line,
          nullif(btrim(coalesce(p_cip_account_ref, '')), ''), coalesce(p_sort, 0))
  on conflict (org_id, job_id, cost_code_id) do update set category = excluded.category, contingency_pool = excluded.contingency_pool,
     draw_budget_line_id = excluded.draw_budget_line_id, cip_account_ref = excluded.cip_account_ref, sort = excluded.sort, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- The seven developer columns per cost code. Paid = Books CLEARED job cost (1103 drain); committed =
-- approved commitments; pending CO = PCO / COR cost impact carrying ext.cost_code_id; ECAC =
-- max(revised, committed exposure + uncommitted cost, actual + pending cost) + pending CO; drawn = the
-- mapped lender line's approved draws apportioned by revised share; remaining to fund = ECAC − drawn.
create or replace function pm._dev_grid_rows(p_org uuid, p_job uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  with orig as (
    select bl.cost_code_id, sum(bl.amount_cents)::bigint as amt from pm.budgets b join pm.budget_lines bl on bl.org_id = b.org_id and bl.budget_id = b.id
     where b.org_id = p_org and b.job_id = p_job and b.kind = 'ORIGINAL' and b.status <> 'SUPERSEDED' group by 1
  ), cur as (
    select cost_code_id, amount_cents as amt from pm._approval_effective_budget(p_org, p_job)
  ), st as (
    select s.* from pm.v_cost_code_status s where s.org_id = p_org and s.job_id = p_job
  ), pco as (
    select pm.access_try_uuid(c.ext ->> 'cost_code_id') as cost_code_id, sum(coalesce(c.cost_impact_cents, c.amount_cents))::bigint as amt
      from pm.change_orders c where c.org_id = p_org and c.job_id = p_job and c.stage in ('PCO','COR') group by 1
  ), drawn as (
    select dl.draw_budget_line_id, sum(coalesce(dl.approved_cents, 0))::bigint as amt from pm.draw_lines dl join pm.draws d on d.org_id = dl.org_id and d.id = dl.draw_id
     where dl.org_id = p_org and dl.job_id = p_job and d.status in ('APPROVED','FUNDED') group by 1
  ), keys as (
    select cost_code_id from orig union select cost_code_id from cur union select cost_code_id from st where cost_code_id is not null
    union select cost_code_id from pm.dev_budget_lines where org_id = p_org and job_id = p_job
  ), base as (
    select k.cost_code_id, cc.code, cc.name, m.category, m.contingency_pool, m.draw_budget_line_id, m.cip_account_ref, coalesce(m.sort, 0) as sort,
           coalesce(o.amt, 0) as original_cents, coalesce(c.amt, o.amt, 0) as revised_cents,
           coalesce(s.committed_cents, 0) as committed_cents, coalesce(p.amt, 0) as pending_co_cents,
           coalesce(s.actual_cents, 0) as paid_cents, coalesce(s.pending_cents, 0) as pending_cost_cents,
           greatest(coalesce(c.amt, o.amt, 0), coalesce(s.forecast_cents, 0)) + coalesce(p.amt, 0) as ecac_cents
      from keys k
      left join pm.cost_codes cc on cc.org_id = p_org and cc.id = k.cost_code_id
      left join pm.dev_budget_lines m on m.org_id = p_org and m.job_id = p_job and m.cost_code_id = k.cost_code_id
      left join orig o on o.cost_code_id = k.cost_code_id
      left join cur c on c.cost_code_id = k.cost_code_id
      left join st s on s.cost_code_id = k.cost_code_id
      left join pco p on p.cost_code_id = k.cost_code_id
     where k.cost_code_id is not null
  ), shares as (
    select b.*, sum(b.revised_cents) over (partition by b.draw_budget_line_id) as lender_line_revised from base b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cost_code_id', s.cost_code_id, 'code', s.code, 'name', s.name, 'category', coalesce(s.category, 'OTHER'), 'contingency_pool', s.contingency_pool,
           'lender_line_id', s.draw_budget_line_id, 'lender_line_no', dbl.line_no, 'lender_line', dbl.description, 'cip_account_ref', s.cip_account_ref,
           'original_cents', s.original_cents, 'revised_cents', s.revised_cents, 'committed_cents', s.committed_cents, 'pending_co_cents', s.pending_co_cents,
           'ecac_cents', s.ecac_cents, 'paid_cents', s.paid_cents, 'pending_cost_cents', s.pending_cost_cents,
           'drawn_cents', case when s.draw_budget_line_id is null then 0
                               when coalesce(s.lender_line_revised, 0) = 0 then 0
                               else round(coalesce(d.amt, 0) * s.revised_cents::numeric / s.lender_line_revised)::bigint end,
           'remaining_to_fund_cents', s.ecac_cents - case when s.draw_budget_line_id is null or coalesce(s.lender_line_revised, 0) = 0 then 0
                                                          else round(coalesce(d.amt, 0) * s.revised_cents::numeric / s.lender_line_revised)::bigint end,
           'variance_cents', s.revised_cents - s.ecac_cents) order by s.sort, s.code), '[]')
    from shares s
    left join pm.draw_budget_lines dbl on dbl.org_id = p_org and dbl.id = s.draw_budget_line_id
    left join drawn d on d.draw_budget_line_id = s.draw_budget_line_id
$$;

create or replace function pm.dev_budget_grid(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_rows jsonb; t record;
begin
  select * into j from pm._x_job(p_job);
  v_rows := pm._dev_grid_rows(j.org_id, p_job);
  select coalesce(sum((r ->> 'original_cents')::bigint), 0) as original, coalesce(sum((r ->> 'revised_cents')::bigint), 0) as revised,
         coalesce(sum((r ->> 'committed_cents')::bigint), 0) as committed, coalesce(sum((r ->> 'pending_co_cents')::bigint), 0) as pending_co,
         coalesce(sum((r ->> 'ecac_cents')::bigint), 0) as ecac, coalesce(sum((r ->> 'paid_cents')::bigint), 0) as paid,
         coalesce(sum((r ->> 'drawn_cents')::bigint), 0) as drawn, coalesce(sum((r ->> 'remaining_to_fund_cents')::bigint), 0) as remaining,
         coalesce(sum((r ->> 'variance_cents')::bigint), 0) as variance, count(*) filter (where r ->> 'lender_line_id' is null) as unmapped
    into t from jsonb_array_elements(v_rows) r;
  return jsonb_build_object('job_id', p_job, 'rows', v_rows, 'totals', jsonb_build_object('original_cents', t.original, 'revised_cents', t.revised,
           'committed_cents', t.committed, 'pending_co_cents', t.pending_co, 'ecac_cents', t.ecac, 'paid_cents', t.paid, 'drawn_cents', t.drawn,
           'remaining_to_fund_cents', t.remaining, 'variance_cents', t.variance), 'unmapped_lines', t.unmapped);
end $$;

-- Reallocations: a REVISED draft of the working budget with the move applied, routed through the
-- 1113 budget_transfer approval (amount tiers, preparer ≠ approver). Where the lender must consent,
-- the approval cannot complete until the consent is recorded.
create table if not exists pm.dev_reallocations (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                    uuid not null,
  from_cost_code_id         uuid not null,
  to_cost_code_id           uuid not null,
  cents                     bigint not null check (cents > 0),
  reason                    text not null check (char_length(btrim(reason)) between 5 and 1000),
  budget_id                 uuid,                         -- the REVISED draft (null once a cancelled draft is removed)
  lender_consent_required   boolean not null default false,
  lender_consent_ref        text,
  lender_consent_on         date,
  status                    text not null default 'PROPOSED' check (status in ('PROPOSED','APPROVED','CANCELLED')),
  approved_at               timestamptz,
  created_by                text default pm.current_user_id(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (budget_id),
  check (from_cost_code_id <> to_cost_code_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, budget_id) references pm.budgets (org_id, id) on delete set null deferrable initially immediate
);

create or replace function pm.dev_propose_reallocation(p_job uuid, p_from uuid, p_to uuid, p_cents bigint, p_reason text, p_lender_consent_required boolean default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; v_bud uuid; v_ver int; v_from bigint; v_id uuid; v_need boolean; r record;
begin
  select * into j from pm._x_job(p_job);
  if p_from = p_to then raise exception 'PM_INVALID: move between two different lines' using errcode = '22023'; end if;
  if coalesce(p_cents, 0) <= 0 then raise exception 'PM_INVALID: amount must be > 0' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or char_length(btrim(p_reason)) < 5 then raise exception 'PM_INVALID: give the reason' using errcode = '22023'; end if;
  if exists (select 1 from pm.budgets b where b.org_id = j.org_id and b.job_id = p_job and b.kind = 'REVISED' and b.status = 'DRAFT') then
    raise exception 'PM_DEV_REALLOCATION_OPEN: finish or cancel the open budget revision first' using errcode = '22023';
  end if;
  select coalesce(amount_cents, 0) into v_from from pm._approval_effective_budget(j.org_id, p_job) where cost_code_id = p_from;
  if coalesce(v_from, 0) < p_cents then raise exception 'PM_DEV_LINE_SHORT: the source line holds % cents', coalesce(v_from, 0) using errcode = '22023'; end if;
  if not exists (select 1 from pm.cost_codes c where c.org_id = j.org_id and c.id = p_to) then raise exception 'PM_INVALID: target cost code' using errcode = '22023'; end if;
  -- lender consent: asked explicitly, or required when money leaves contingency or crosses lender lines
  -- The proposer can ask for consent but never waive it (security review M1): flag OR the derived rule.
  v_need := coalesce(p_lender_consent_required, false) or coalesce((exists (select 1 from pm.dev_budget_lines m where m.org_id = j.org_id and m.job_id = p_job and m.cost_code_id = p_from and m.category = 'CONTINGENCY')
              or (select m1.draw_budget_line_id from pm.dev_budget_lines m1 where m1.org_id = j.org_id and m1.job_id = p_job and m1.cost_code_id = p_from)
                 is distinct from (select m2.draw_budget_line_id from pm.dev_budget_lines m2 where m2.org_id = j.org_id and m2.job_id = p_job and m2.cost_code_id = p_to)), false);
  select coalesce(max(b.version), 0) + 1 into v_ver from pm.budgets b where b.org_id = j.org_id and b.job_id = p_job and b.kind = 'REVISED';
  insert into pm.budgets (org_id, job_id, kind, version, status, label, notes)
  values (j.org_id, p_job, 'REVISED', v_ver, 'DRAFT', left(format('Reallocation: %s', btrim(p_reason)), 200), btrim(p_reason)) returning id into v_bud;
  for r in select * from pm._approval_effective_budget(j.org_id, p_job) loop
    insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents)
    values (j.org_id, v_bud, r.cost_code_id, r.amount_cents - case when r.cost_code_id = p_from then p_cents else 0 end + case when r.cost_code_id = p_to then p_cents else 0 end);
  end loop;
  if not exists (select 1 from pm.budget_lines bl where bl.org_id = j.org_id and bl.budget_id = v_bud and bl.cost_code_id = p_to) then
    insert into pm.budget_lines (org_id, budget_id, cost_code_id, amount_cents) values (j.org_id, v_bud, p_to, p_cents);
  end if;
  insert into pm.dev_reallocations (org_id, job_id, from_cost_code_id, to_cost_code_id, cents, reason, budget_id, lender_consent_required)
  values (j.org_id, p_job, p_from, p_to, p_cents, btrim(p_reason), v_bud, v_need) returning id into v_id;
  return jsonb_build_object('reallocation_id', v_id, 'budget_id', v_bud, 'lender_consent_required', v_need, 'approval_object', 'budget_transfer');
end $$;

create or replace function pm.dev_record_lender_consent(p_reallocation uuid, p_ref text, p_on date default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dev_reallocations%rowtype;
begin
  select * into r from pm.dev_reallocations x where x.id = p_reallocation for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: reallocation % not found in the caller''s organization', p_reallocation using errcode = '42501';
  end if;
  if r.status <> 'PROPOSED' then raise exception 'PM_INVALID: the reallocation is %', lower(r.status) using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_ref, '')), '') is null then raise exception 'PM_INVALID: record the lender''s consent reference' using errcode = '22023'; end if;
  update pm.dev_reallocations set lender_consent_ref = left(btrim(p_ref), 120), lender_consent_on = coalesce(p_on, current_date), updated_at = now() where id = r.id;
  return r.id;
end $$;

create or replace function pm.dev_cancel_reallocation(p_reallocation uuid)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dev_reallocations%rowtype;
begin
  select * into r from pm.dev_reallocations x where x.id = p_reallocation for update;
  if r.org_id is null or r.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: reallocation % not found in the caller''s organization', p_reallocation using errcode = '42501';
  end if;
  if r.status <> 'PROPOSED' then raise exception 'PM_INVALID: the reallocation is %', lower(r.status) using errcode = '22023'; end if;
  -- unlink first: the composite FK's ON DELETE SET NULL would null org_id too
  update pm.dev_reallocations set status = 'CANCELLED', budget_id = null, updated_at = now() where id = r.id;
  delete from pm.budgets where org_id = r.org_id and id = r.budget_id and status = 'DRAFT';
  return r.id;
end $$;

-- Gate on the budget revision (fires inside the engine's execution of budget_transfer): no approval
-- without the lender's consent where it is required; the reallocation follows the budget's state.
create or replace function pm.tg_dev_reallocation_gate() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.dev_reallocations%rowtype;
begin
  if new.status = old.status then return new; end if;
  select * into r from pm.dev_reallocations x where x.org_id = new.org_id and x.budget_id = new.id;
  if r.id is null then return new; end if;
  if new.status = 'APPROVED' and old.status = 'DRAFT' then
    if r.status <> 'PROPOSED' then raise exception 'PM_INVALID: the reallocation is %', lower(r.status) using errcode = '22023'; end if;
    if r.lender_consent_required and r.lender_consent_ref is null then
      raise exception 'PM_DEV_LENDER_CONSENT_REQUIRED: record the lender''s consent before approving this reallocation' using errcode = 'P0001';
    end if;
    update pm.dev_reallocations set status = 'APPROVED', approved_at = now(), updated_at = now() where id = r.id;
  end if;
  return new;
end $$;
-- a00_ sorts before 1113's a0_pm_approval_gate, so the lender-consent answer is the one the user sees.
drop trigger if exists zz_dev_reallocation_gate on pm.budgets;
drop trigger if exists a00_dev_reallocation_gate on pm.budgets;
create trigger a00_dev_reallocation_gate before update of status on pm.budgets for each row execute function pm.tg_dev_reallocation_gate();

-- Contingency by pool: original, current, moved out, drawn / paid, burn vs % complete, projection.
create or replace function pm.dev_contingency(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; v_rows jsonb; v_hard_pct numeric; v_pools jsonb;
begin
  select * into j from pm._x_job(p_job);
  v_rows := pm._dev_grid_rows(j.org_id, p_job);
  select case when sum((r ->> 'ecac_cents')::numeric) > 0 then sum((r ->> 'paid_cents')::numeric) / sum((r ->> 'ecac_cents')::numeric) end into v_hard_pct
    from jsonb_array_elements(v_rows) r where r ->> 'category' = 'HARD';
  select coalesce(jsonb_agg(jsonb_build_object('pool', x.pool, 'original_cents', x.original, 'current_cents', x.cur, 'used_cents', x.original - x.cur,
           'burn_pct', case when x.original > 0 then round((x.original - x.cur)::numeric / x.original, 4) end,
           'pct_complete', round(coalesce(v_hard_pct, 0), 4),
           'projected_remaining_cents', case when coalesce(v_hard_pct, 0) > 0.05 then round(x.original - (x.original - x.cur) / v_hard_pct)::bigint end,
           'at_risk', coalesce(v_hard_pct, 0) > 0 and x.original > 0 and ((x.original - x.cur)::numeric / x.original) > v_hard_pct + 0.10) order by x.pool), '[]')
    into v_pools
    from (select r ->> 'contingency_pool' as pool, sum((r ->> 'original_cents')::bigint) as original, sum((r ->> 'revised_cents')::bigint) as cur
            from jsonb_array_elements(v_rows) r where r ->> 'category' = 'CONTINGENCY' group by 1) x;
  return jsonb_build_object('job_id', p_job, 'pools', v_pools, 'log', coalesce((
    select jsonb_agg(jsonb_build_object('reallocation_id', a.id, 'from', cf.code, 'to', ct.code, 'cents', a.cents, 'reason', a.reason, 'status', a.status,
             'budget_status', b.status, 'lender_consent_required', a.lender_consent_required, 'lender_consent_ref', a.lender_consent_ref,
             'lender_consent_on', a.lender_consent_on, 'created_at', a.created_at, 'approved_at', a.approved_at) order by a.created_at desc)
      from pm.dev_reallocations a left join pm.cost_codes cf on cf.id = a.from_cost_code_id left join pm.cost_codes ct on ct.id = a.to_cost_code_id
      left join pm.budgets b on b.org_id = a.org_id and b.id = a.budget_id
     where a.org_id = j.org_id and a.job_id = p_job), '[]'));
end $$;

-- R5. In-balance test (deterministic) + draw submission block ---------------------------------------
--   cost to complete = Σ ECAC − Σ paid;  remaining sources = Σ (commitment − funded);  gap = ctc − remaining.
--   Funded per loan source with a draw schedule = Σ funded draws on that schedule (until Books exposes
--   the loan balance); equity / other sources use their recorded funded amount.
create or replace function pm._dev_in_balance(p_org uuid, p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_rows jsonb; v_ecac bigint; v_paid bigint; v_src jsonb; v_rem bigint; v_over jsonb; v_uses bigint; v_commit bigint; ir record;
begin
  v_rows := pm._dev_grid_rows(p_org, p_job);
  select coalesce(sum((r ->> 'ecac_cents')::bigint), 0), coalesce(sum((r ->> 'paid_cents')::bigint), 0), coalesce(sum((r ->> 'revised_cents')::bigint), 0)
    into v_ecac, v_paid, v_uses from jsonb_array_elements(v_rows) r;
  select coalesce(jsonb_agg(jsonb_build_object('source_id', s.id, 'kind', s.kind, 'name', s.name, 'rank', s.rank, 'commitment_cents', s.commitment_cents,
           'funded_cents', f.funded, 'remaining_cents', greatest(s.commitment_cents - f.funded, 0), 'over_commitment', f.funded > s.commitment_cents,
           'funded_basis', case when s.draw_schedule_id is not null then 'DRAWS' else 'RECORDED' end) order by s.rank, s.name), '[]'),
         coalesce(sum(greatest(s.commitment_cents - f.funded, 0)), 0), coalesce(sum(s.commitment_cents), 0)
    into v_src, v_rem, v_commit
    from pm.dev_sources s
    cross join lateral (select case when s.draw_schedule_id is not null
                                    then coalesce((select sum(d.funded_cents) from pm.draws d where d.org_id = s.org_id and d.draw_schedule_id = s.draw_schedule_id and d.status = 'FUNDED'), 0)
                                    else s.funded_cents end::bigint as funded) f
   where s.org_id = p_org and s.job_id = p_job;
  select coalesce(jsonb_agg(x), '[]') into v_over from jsonb_array_elements(v_src) x where (x ->> 'over_commitment')::boolean;
  select max(value) filter (where metric = 'interest_reserve_months') as ir_months into ir from pm.v_kpis_development k where k.org_id = p_org and k.job_id = p_job;
  return jsonb_build_object('job_id', p_job, 'cost_to_complete_cents', v_ecac - v_paid, 'remaining_sources_cents', v_rem,
    'gap_cents', (v_ecac - v_paid) - v_rem, 'in_balance', (v_ecac - v_paid) - v_rem <= 0, 'has_sources', jsonb_array_length(v_src) > 0,
    'sources', v_src, 'sources_over_commitment', v_over, 'total_uses_cents', v_uses, 'total_sources_cents', v_commit,
    'sources_equal_uses', v_commit = v_uses, 'interest_reserve_months', ir.ir_months);
end $$;

create or replace function pm.dev_in_balance(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record;
begin
  select * into j from pm._x_job(p_job);
  return pm._dev_in_balance(j.org_id, p_job);
end $$;

create or replace function pm.tg_dev_draw_in_balance() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.dev_projects%rowtype; b jsonb;
begin
  if not (new.status = 'SUBMITTED' and old.status in ('DRAFT','RETURNED')) then return new; end if;
  select * into p from pm.dev_projects x where x.org_id = new.org_id and x.job_id = new.job_id;
  if p.job_id is null or not p.block_out_of_balance then return new; end if;
  b := pm._dev_in_balance(new.org_id, new.job_id);
  if not (b ->> 'has_sources')::boolean then return new; end if;
  if not (b ->> 'in_balance')::boolean then
    raise exception 'PM_DEV_OUT_OF_BALANCE: the project is out of balance by % cents; fund the gap (equity or a reallocation) before the draw goes to the lender', (b ->> 'gap_cents')
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(b -> 'sources_over_commitment') > 0 then
    raise exception 'PM_DEV_SOURCE_OVER_COMMITMENT: a source is funded past its commitment' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists zz_dev_draw_in_balance on pm.draws;
drop trigger if exists a00_dev_draw_in_balance on pm.draws;
create trigger a00_dev_draw_in_balance before update of status on pm.draws for each row execute function pm.tg_dev_draw_in_balance();

-- R6. Draw builder: invoices → lender lines, lender template, package in read order, pre-check, waivers --
create table if not exists pm.dev_draw_invoices (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  draw_id              uuid not null,
  vendor_id            uuid references core.vendors(id),
  commitment_id        uuid,
  cost_code_id         uuid,
  draw_budget_line_id  uuid,
  invoice_number       text not null check (char_length(btrim(invoice_number)) between 1 and 60),
  invoice_on           date,
  amount_cents         bigint not null check (amount_cents > 0),
  retainage_cents      bigint not null default 0 check (retainage_cents >= 0),
  document_id          uuid references public.documents(id) on delete set null,
  status               text not null default 'PENDING' check (status in ('PENDING','APPROVED','EXCLUDED')),
  approved_by          text,
  approved_at          timestamptz,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, draw_id, vendor_id, invoice_number),
  check (retainage_cents <= amount_cents),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, draw_id) references pm.draws (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, draw_budget_line_id) references pm.draw_budget_lines (org_id, id) deferrable initially immediate
);

create table if not exists pm.dev_lender_templates (
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  draw_schedule_id  uuid not null,
  sections          jsonb not null check (jsonb_typeof(sections) = 'array'),
  format_notes      text,
  updated_by        text default pm.current_user_id(),
  updated_at        timestamptz not null default now(),
  primary key (org_id, draw_schedule_id),
  foreign key (org_id, job_id, draw_schedule_id) references pm.draw_schedules (org_id, job_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.dev_draw_waivers (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id             uuid not null,
  draw_id            uuid not null,
  vendor_id          uuid not null references core.vendors(id),
  kind               text not null check (kind in ('CONDITIONAL_CURRENT','UNCONDITIONAL_PRIOR','FINAL')),
  compliance_doc_id  uuid not null,
  amount_cents       bigint not null default 0 check (amount_cents >= 0),
  through_on         date,
  esign_envelope_id  uuid,
  created_by         text default pm.current_user_id(),
  created_at         timestamptz not null default now(),
  unique (org_id, id),
  unique (draw_id, vendor_id, kind),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, draw_id) references pm.draws (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, compliance_doc_id) references pm.compliance_docs (org_id, id) on delete cascade deferrable initially immediate
);

-- Rabbet-canon read order (lender templates override per loan).
create or replace function pm.dev_default_sections() returns jsonb
language sql immutable
as $$ select '[{"key":"cover_letter","label":"Cover letter","required":true},{"key":"draw_summary","label":"Draw summary (G702)","required":true},
              {"key":"continuation","label":"Continuation sheet (G703) by lender line","required":true},{"key":"invoice_summary","label":"Invoice summary","required":true},
              {"key":"invoices","label":"Invoices and pay applications","required":true},{"key":"change_order_log","label":"Change order log","required":true},
              {"key":"stored_materials","label":"Stored materials","required":false},{"key":"lien_waivers","label":"Lien waivers","required":true},
              {"key":"interest_reserve","label":"Interest reserve statement","required":true},{"key":"insurance","label":"Certificates of insurance","required":true},
              {"key":"inspection","label":"Inspection report","required":false},{"key":"photos","label":"Site photos","required":false}]'::jsonb $$;

create or replace function pm.dev_set_lender_template(p_schedule uuid, p_sections jsonb, p_notes text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.draw_schedules%rowtype; e jsonb;
begin
  select * into s from pm.draw_schedules x where x.id = p_schedule;
  if s.org_id is null or s.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw schedule % not found in the caller''s organization', p_schedule using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_sections, 'null')) <> 'array' or jsonb_array_length(p_sections) = 0 then raise exception 'PM_INVALID: sections' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p_sections) loop
    if (e ->> 'key') not in (select x ->> 'key' from jsonb_array_elements(pm.dev_default_sections()) x) then
      raise exception 'PM_INVALID: unknown package section %', e ->> 'key' using errcode = '22023';
    end if;
  end loop;
  insert into pm.dev_lender_templates (org_id, job_id, draw_schedule_id, sections, format_notes)
  values (s.org_id, s.job_id, s.id, p_sections, nullif(left(p_notes, 2000), ''))
  on conflict (org_id, draw_schedule_id) do update set sections = excluded.sections, format_notes = excluded.format_notes, updated_by = pm.current_user_id(), updated_at = now();
  return s.id;
end $$;

create or replace function pm.dev_add_draw_invoice(p_draw uuid, p_vendor uuid, p_invoice_number text, p_amount_cents bigint, p_invoice_on date default null,
                                                   p_commitment uuid default null, p_cost_code uuid default null, p_draw_budget_line uuid default null,
                                                   p_retainage_cents bigint default 0, p_document uuid default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_id uuid; v_line uuid := p_draw_budget_line;
begin
  select * into d from pm.draws x where x.id = p_draw;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_LOCKED: draw % is %', d.draw_number, lower(d.status) using errcode = '55000'; end if;
  if p_vendor is not null and not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = d.org_id) then raise exception 'PM_UNKNOWN_VENDOR' using errcode = '23503'; end if;
  if v_line is null and p_cost_code is not null then
    select m.draw_budget_line_id into v_line from pm.dev_budget_lines m where m.org_id = d.org_id and m.job_id = d.job_id and m.cost_code_id = p_cost_code;
  end if;
  if v_line is not null and not exists (select 1 from pm.draw_budget_lines l where l.org_id = d.org_id and l.id = v_line and l.draw_schedule_id = d.draw_schedule_id) then
    raise exception 'PM_INVALID: the lender line is not on this loan' using errcode = '22023';
  end if;
  insert into pm.dev_draw_invoices (org_id, job_id, draw_id, vendor_id, commitment_id, cost_code_id, draw_budget_line_id, invoice_number, invoice_on, amount_cents,
                                    retainage_cents, document_id)
  values (d.org_id, d.job_id, d.id, p_vendor, p_commitment, p_cost_code, v_line, btrim(p_invoice_number), p_invoice_on, p_amount_cents, coalesce(p_retainage_cents, 0), p_document)
  returning id into v_id;
  return v_id;
end $$;

-- The approver is never the person who added the invoice (preparer ≠ approver).
create or replace function pm.dev_decide_draw_invoice(p_invoice uuid, p_approve boolean)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.dev_draw_invoices%rowtype; d pm.draws%rowtype;
begin
  select * into i from pm.dev_draw_invoices x where x.id = p_invoice for update;
  if i.org_id is null or i.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: invoice % not found in the caller''s organization', p_invoice using errcode = '42501';
  end if;
  select * into d from pm.draws x where x.org_id = i.org_id and x.id = i.draw_id;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_LOCKED: the draw is %', lower(d.status) using errcode = '55000'; end if;
  if p_approve and i.created_by is not null and i.created_by = pm.current_user_id() then
    raise exception 'PM_SOD_VIOLATION: the person who added an invoice does not approve it' using errcode = '42501';
  end if;
  update pm.dev_draw_invoices set status = case when p_approve then 'APPROVED' else 'EXCLUDED' end, approved_by = pm.current_user_id(), approved_at = now() where id = i.id;
  return i.id;
end $$;

-- Requested per lender line = Σ approved invoices mapped to it (direct line, else via the cost code map).
create or replace function pm.dev_build_draw(p_draw uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; r record; n int := 0; v_unmapped int;
begin
  select * into d from pm.draws x where x.id = p_draw for update;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_LOCKED: draw % is %', d.draw_number, lower(d.status) using errcode = '55000'; end if;
  select count(*) into v_unmapped from pm.dev_draw_invoices i
   where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED' and i.draw_budget_line_id is null
     and not exists (select 1 from pm.dev_budget_lines m where m.org_id = i.org_id and m.job_id = i.job_id and m.cost_code_id = i.cost_code_id and m.draw_budget_line_id is not null);
  for r in
    select l.id as line_id, coalesce(sum(i.amount_cents), 0)::bigint as amt
      from pm.draw_budget_lines l
      left join pm.dev_draw_invoices i on i.org_id = l.org_id and i.draw_id = d.id and i.status = 'APPROVED'
           and coalesce(i.draw_budget_line_id, (select m.draw_budget_line_id from pm.dev_budget_lines m where m.org_id = i.org_id and m.job_id = i.job_id and m.cost_code_id = i.cost_code_id)) = l.id
     where l.org_id = d.org_id and l.draw_schedule_id = d.draw_schedule_id
     group by l.id
  loop
    insert into pm.draw_lines (org_id, job_id, draw_schedule_id, draw_id, draw_budget_line_id, requested_cents)
    values (d.org_id, d.job_id, d.draw_schedule_id, d.id, r.line_id, r.amt)
    on conflict (draw_id, draw_budget_line_id) do update set requested_cents = excluded.requested_cents, updated_at = now();
    if r.amt > 0 then n := n + 1; end if;
  end loop;
  return jsonb_build_object('draw_id', d.id, 'lines_with_amounts', n, 'unmapped_invoices', v_unmapped,
    'requested_cents', (select coalesce(sum(l.requested_cents), 0) from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id));
end $$;

-- Waivers for a draw: conditional (this draw) for every vendor with approved invoices, unconditional
-- for every vendor paid on the previous funded draw. Each is a required pm.compliance_docs row on the
-- vendor's commitment (so the payment hold applies until it is received) — the app then sends them
-- for e-signature (lib/esign, kind lien_waiver).
create or replace function pm.dev_request_draw_waivers(p_draw uuid)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; prev pm.draws%rowtype; v record; v_doc uuid; n int := 0; v_out jsonb := '[]';
begin
  select * into d from pm.draws x where x.id = p_draw;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  select * into prev from pm.draws x where x.org_id = d.org_id and x.draw_schedule_id = d.draw_schedule_id and x.draw_number < d.draw_number and x.status = 'FUNDED'
   order by x.draw_number desc limit 1;
  for v in
    select 'CONDITIONAL_CURRENT' as kind, i.vendor_id, max(i.commitment_id::text)::uuid as commitment_id, sum(i.amount_cents)::bigint as amt, d.period_end as through_on
      from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED' and i.vendor_id is not null group by i.vendor_id
    union all
    select 'UNCONDITIONAL_PRIOR', i.vendor_id, max(i.commitment_id::text)::uuid, sum(i.amount_cents)::bigint, prev.period_end
      from pm.dev_draw_invoices i where prev.id is not null and i.org_id = d.org_id and i.draw_id = prev.id and i.status = 'APPROVED' and i.vendor_id is not null group by i.vendor_id
  loop
    continue when exists (select 1 from pm.dev_draw_waivers w where w.draw_id = d.id and w.vendor_id = v.vendor_id and w.kind = v.kind);
    insert into pm.compliance_docs (org_id, job_id, commitment_id, vendor_id, doc_type, status, required, covers_through, amount_cents, notes)
    values (d.org_id, d.job_id, v.commitment_id, v.vendor_id,
            case v.kind when 'CONDITIONAL_CURRENT' then 'LIEN_WAIVER_CONDITIONAL' else 'LIEN_WAIVER_UNCONDITIONAL' end, 'MISSING', true, v.through_on, v.amt,
            format('Draw %s %s waiver', d.draw_number, case v.kind when 'CONDITIONAL_CURRENT' then 'conditional' else 'unconditional (prior draw)' end))
    returning id into v_doc;
    insert into pm.dev_draw_waivers (org_id, job_id, draw_id, vendor_id, kind, compliance_doc_id, amount_cents, through_on)
    values (d.org_id, d.job_id, d.id, v.vendor_id, v.kind, v_doc, v.amt, v.through_on);
    n := n + 1;
    v_out := v_out || jsonb_build_object('vendor_id', v.vendor_id, 'kind', v.kind, 'compliance_doc_id', v_doc, 'amount_cents', v.amt, 'through_on', v.through_on);
  end loop;
  return jsonb_build_object('draw_id', d.id, 'requested', n, 'waivers', v_out);
end $$;

-- Every gap before the lender sees the draw. BLOCK items stop submission (the in-balance trigger
-- enforces the money ones); WARN items are shown.
create or replace function pm._dev_draw_issues(p_draw uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; s pm.draw_schedules%rowtype; p pm.dev_projects%rowtype; b jsonb; v jsonb := '[]'; r record; v_sections jsonb; v_pkg jsonb;
begin
  select * into d from pm.draws x where x.id = p_draw;
  select * into s from pm.draw_schedules x where x.org_id = d.org_id and x.id = d.draw_schedule_id;
  select * into p from pm.dev_projects x where x.org_id = d.org_id and x.job_id = d.job_id;
  for r in select w.*, c.status as doc_status, vd.name as vendor from pm.dev_draw_waivers w join pm.compliance_docs c on c.org_id = w.org_id and c.id = w.compliance_doc_id
             left join core.vendors vd on vd.id = w.vendor_id
            where w.org_id = d.org_id and w.draw_id = d.id and c.status not in ('RECEIVED','VERIFIED') loop
    v := v || jsonb_build_object('severity', 'BLOCK', 'code', case r.kind when 'CONDITIONAL_CURRENT' then 'MISSING_CONDITIONAL_WAIVER' else 'MISSING_UNCONDITIONAL_PRIOR' end,
                                 'message', format('%s waiver from %s is %s', initcap(replace(lower(r.kind), '_', ' ')), coalesce(r.vendor, 'a vendor'), lower(r.doc_status)),
                                 'ref', r.compliance_doc_id);
  end loop;
  for r in select i.vendor_id, vd.name from pm.dev_draw_invoices i left join core.vendors vd on vd.id = i.vendor_id
            where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED' and i.vendor_id is not null
              and not exists (select 1 from pm.dev_draw_waivers w where w.draw_id = d.id and w.vendor_id = i.vendor_id and w.kind = 'CONDITIONAL_CURRENT')
            group by i.vendor_id, vd.name loop
    v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'WAIVER_NOT_REQUESTED', 'message', format('No conditional waiver requested from %s', coalesce(r.name, 'a vendor')), 'ref', r.vendor_id);
  end loop;
  for r in select i.* from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status <> 'EXCLUDED' loop
    if r.status = 'PENDING' then v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'UNAPPROVED_INVOICE', 'message', format('Invoice %s is not approved', r.invoice_number), 'ref', r.id); end if;
    if r.document_id is null then v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'MISSING_INVOICE_DOC', 'message', format('Invoice %s has no file attached', r.invoice_number), 'ref', r.id); end if;
  end loop;
  for r in select distinct on (i.vendor_id) i.vendor_id, vd.name,
                  (select c.status from pm.compliance_docs c where c.org_id = i.org_id and c.job_id = i.job_id and c.vendor_id = i.vendor_id and c.doc_type = 'COI'
                    order by c.expires_on desc nulls last limit 1) as coi_status,
                  (select c.expires_on from pm.compliance_docs c where c.org_id = i.org_id and c.job_id = i.job_id and c.vendor_id = i.vendor_id and c.doc_type = 'COI'
                    order by c.expires_on desc nulls last limit 1) as coi_expires
             from pm.dev_draw_invoices i left join core.vendors vd on vd.id = i.vendor_id
            where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED' and i.vendor_id is not null loop
    if r.coi_status is null or r.coi_status in ('MISSING','REJECTED','EXPIRED') or (r.coi_expires is not null and r.coi_expires < current_date) then
      v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'COI_MISSING_OR_EXPIRED', 'message', format('%s has no current certificate of insurance', coalesce(r.name, 'A vendor')), 'ref', r.vendor_id);
    end if;
  end loop;
  for r in select l.line_no, l.description, coalesce(l.revised_cents, l.original_cents) as revised,
                  (select coalesce(sum(coalesce(x.approved_cents, x.requested_cents)), 0) from pm.draw_lines x join pm.draws dd on dd.org_id = x.org_id and dd.id = x.draw_id
                    where x.org_id = l.org_id and x.draw_budget_line_id = l.id and dd.status not in ('CANCELLED','RETURNED') and dd.id <> d.id) as prior,
                  dl.requested_cents
             from pm.draw_lines dl join pm.draw_budget_lines l on l.org_id = dl.org_id and l.id = dl.draw_budget_line_id
            where dl.org_id = d.org_id and dl.draw_id = d.id and dl.requested_cents > 0 loop
    if r.prior + r.requested_cents > r.revised then
      v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'LINE_OVER_BUDGET', 'message', format('Line %s %s would draw past its loan budget', r.line_no, r.description));
    end if;
  end loop;
  b := pm._dev_in_balance(d.org_id, d.job_id);
  if (b ->> 'has_sources')::boolean and not (b ->> 'in_balance')::boolean then
    v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'OUT_OF_BALANCE', 'message', format('Out of balance by %s cents', b ->> 'gap_cents'));
  end if;
  if jsonb_array_length(coalesce(b -> 'sources_over_commitment', '[]')) > 0 then
    v := v || jsonb_build_object('severity', 'BLOCK', 'code', 'SOURCE_OVER_COMMITMENT', 'message', 'A source is funded past its commitment');
  end if;
  if s.requires_inspection and d.inspection_status not in ('PASSED','NOT_REQUIRED') then
    v := v || jsonb_build_object('severity', 'WARN', 'code', 'INSPECTION_PENDING', 'message', 'The lender''s inspector has not signed off this period');
  end if;
  if coalesce(p.schedule_behind_days, 0) >= 90 then
    v := v || jsonb_build_object('severity', 'WARN', 'code', 'SCHEDULE_BEHIND', 'message', format('The schedule is %s days behind', p.schedule_behind_days));
  end if;
  v_pkg := pm._dev_package_sections(d.id);
  for r in select x from jsonb_array_elements(v_pkg) x where coalesce(pm._x_try_bool(x ->> 'required'), false) and not coalesce(pm._x_try_bool(x ->> 'present'), false) loop
    v := v || jsonb_build_object('severity', 'WARN', 'code', 'PACKAGE_SECTION_MISSING', 'message', format('Package section missing: %s', r.x ->> 'label'));
  end loop;
  return v;
end $$;

-- Sections in the lender's order with presence (deterministic; documents are referenced, not copied).
create or replace function pm._dev_package_sections(p_draw uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; t pm.dev_lender_templates%rowtype; v_sections jsonb; e jsonb; v_out jsonb := '[]'; v_present boolean; v_n int;
begin
  select * into d from pm.draws x where x.id = p_draw;
  select * into t from pm.dev_lender_templates x where x.org_id = d.org_id and x.draw_schedule_id = d.draw_schedule_id;
  v_sections := coalesce(t.sections, pm.dev_default_sections());
  for e in select * from jsonb_array_elements(v_sections) loop
    v_n := null;
    v_present := case e ->> 'key'
      when 'draw_summary' then exists (select 1 from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id and l.requested_cents > 0)
      when 'continuation' then exists (select 1 from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id)
      when 'invoice_summary' then exists (select 1 from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED')
      when 'invoices' then not exists (select 1 from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED' and i.document_id is null)
                           and exists (select 1 from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED')
      when 'change_order_log' then true
      when 'lien_waivers' then exists (select 1 from pm.dev_draw_waivers w where w.draw_id = d.id)
                               and not exists (select 1 from pm.dev_draw_waivers w join pm.compliance_docs c on c.id = w.compliance_doc_id
                                                where w.draw_id = d.id and c.status not in ('RECEIVED','VERIFIED'))
      when 'interest_reserve' then true
      when 'insurance' then true
      when 'inspection' then d.inspection_status in ('PASSED','CONDITIONAL','NOT_REQUIRED')
      else coalesce(pm._x_try_bool(d.package ->> (e ->> 'key')), false) end;
    v_out := v_out || (e || jsonb_build_object('present', coalesce(v_present, false)));
  end loop;
  return v_out;
end $$;

create or replace function pm.dev_draw_precheck(p_draw uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v jsonb;
begin
  select * into d from pm.draws x where x.id = p_draw;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  v := pm._dev_draw_issues(d.id);
  return jsonb_build_object('draw_id', d.id, 'draw_number', d.draw_number, 'status', d.status,
    'ready', not exists (select 1 from jsonb_array_elements(v) x where x ->> 'severity' = 'BLOCK'),
    'blocking', (select count(*) from jsonb_array_elements(v) x where x ->> 'severity' = 'BLOCK'),
    'warnings', (select count(*) from jsonb_array_elements(v) x where x ->> 'severity' = 'WARN'), 'issues', v);
end $$;

-- The package in the lender's read order: G702 summary numbers, G703 lines, invoices, CO log, waivers,
-- interest reserve, COIs, inspection. All figures computed here (no AI math).
create or replace function pm.dev_draw_package(p_draw uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; s pm.draw_schedules%rowtype; j record; v_lines jsonb; v_inv jsonb; v_co jsonb; v_w jsonb; v_coi jsonb; v_sum jsonb; v_ir jsonb;
begin
  select * into d from pm.draws x where x.id = p_draw;
  if d.org_id is null or d.org_id is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: draw % not found in the caller''s organization', p_draw using errcode = '42501';
  end if;
  select * into s from pm.draw_schedules x where x.org_id = d.org_id and x.id = d.draw_schedule_id;
  select jb.job_number, jb.name into j from core.jobs jb where jb.org_id = d.org_id and jb.id = d.job_id;
  select coalesce(jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'category', l.category,
           'scheduled_cents', coalesce(l.revised_cents, l.original_cents),
           'previous_cents', coalesce((select sum(coalesce(x.approved_cents, x.requested_cents)) from pm.draw_lines x join pm.draws dd on dd.org_id = x.org_id and dd.id = x.draw_id
                                       where x.org_id = l.org_id and x.draw_budget_line_id = l.id and dd.draw_number < d.draw_number and dd.status in ('APPROVED','FUNDED')), 0),
           'this_period_cents', coalesce(dl.requested_cents, 0)) order by l.line_no), '[]')
    into v_lines from pm.draw_budget_lines l left join pm.draw_lines dl on dl.org_id = l.org_id and dl.draw_budget_line_id = l.id and dl.draw_id = d.id
   where l.org_id = d.org_id and l.draw_schedule_id = d.draw_schedule_id;
  v_lines := (select coalesce(jsonb_agg(x || jsonb_build_object('to_date_cents', (x ->> 'previous_cents')::bigint + (x ->> 'this_period_cents')::bigint,
                       'balance_cents', (x ->> 'scheduled_cents')::bigint - (x ->> 'previous_cents')::bigint - (x ->> 'this_period_cents')::bigint,
                       'pct_complete', case when (x ->> 'scheduled_cents')::bigint > 0
                                            then round(((x ->> 'previous_cents')::bigint + (x ->> 'this_period_cents')::bigint)::numeric / (x ->> 'scheduled_cents')::bigint, 4) end)
                   order by (x ->> 'line_no')::int), '[]') from jsonb_array_elements(v_lines) x);
  select jsonb_build_object('scheduled_cents', coalesce(sum((x ->> 'scheduled_cents')::bigint), 0), 'previous_cents', coalesce(sum((x ->> 'previous_cents')::bigint), 0),
                            'this_period_cents', coalesce(sum((x ->> 'this_period_cents')::bigint), 0), 'to_date_cents', coalesce(sum((x ->> 'to_date_cents')::bigint), 0),
                            'balance_cents', coalesce(sum((x ->> 'balance_cents')::bigint), 0), 'retainage_pct', s.retainage_pct,
                            'loan_commitment_cents', s.loan_commitment_cents)
    into v_sum from jsonb_array_elements(v_lines) x;
  select coalesce(jsonb_agg(jsonb_build_object('invoice_id', i.id, 'vendor', vd.name, 'invoice_number', i.invoice_number, 'invoice_on', i.invoice_on,
           'amount_cents', i.amount_cents, 'retainage_cents', i.retainage_cents, 'lender_line_id', i.draw_budget_line_id, 'document_id', i.document_id)
           order by vd.name, i.invoice_number), '[]')
    into v_inv from pm.dev_draw_invoices i left join core.vendors vd on vd.id = i.vendor_id where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED';
  select coalesce(jsonb_agg(jsonb_build_object('number', c.number, 'title', c.title, 'stage', c.stage, 'amount_cents', c.amount_cents, 'cost_impact_cents', c.cost_impact_cents,
           'approved_at', c.approved_at) order by c.created_at), '[]')
    into v_co from pm.change_orders c where c.org_id = d.org_id and c.job_id = d.job_id and c.stage in ('APPROVED','COR','PCO');
  select coalesce(jsonb_agg(jsonb_build_object('vendor', vd.name, 'kind', w.kind, 'amount_cents', w.amount_cents, 'through_on', w.through_on, 'status', c.status,
           'document_id', c.document_id) order by vd.name, w.kind), '[]')
    into v_w from pm.dev_draw_waivers w join pm.compliance_docs c on c.org_id = w.org_id and c.id = w.compliance_doc_id left join core.vendors vd on vd.id = w.vendor_id
   where w.org_id = d.org_id and w.draw_id = d.id;
  select coalesce(jsonb_agg(jsonb_build_object('vendor', vd.name, 'status', c.status, 'expires_on', c.expires_on, 'document_id', c.document_id)), '[]')
    into v_coi from pm.compliance_docs c left join core.vendors vd on vd.id = c.vendor_id
   where c.org_id = d.org_id and c.job_id = d.job_id and c.doc_type = 'COI'
     and c.vendor_id in (select i.vendor_id from pm.dev_draw_invoices i where i.org_id = d.org_id and i.draw_id = d.id and i.status = 'APPROVED');
  select jsonb_object_agg(k.metric, k.value) into v_ir from pm.v_kpis_development k
   where k.org_id = d.org_id and k.job_id = d.job_id and k.metric in ('interest_reserve_months','in_balance_gap_cents');
  return jsonb_build_object('draw_id', d.id, 'draw_number', d.draw_number, 'period_end', d.period_end, 'project', j.name, 'job_number', j.job_number,
    'lender', s.lender_name, 'loan_number', s.loan_number, 'sections', pm._dev_package_sections(d.id),
    'summary', v_sum, 'continuation', v_lines, 'invoices', v_inv, 'change_orders', v_co, 'waivers', v_w, 'insurance', v_coi,
    'interest_reserve', jsonb_build_object('reserve_cents', s.interest_reserve_cents, 'kpis', coalesce(v_ir, '{}')),
    'inspection', jsonb_build_object('status', d.inspection_status, 'inspected_on', d.inspected_on, 'inspector', d.inspector_name, 'pct_complete', d.inspector_pct_complete),
    'in_balance', pm._dev_in_balance(d.org_id, d.job_id));
end $$;

-- R7. Capital plan + key dates + cross-SPE overview + investor view (Books only) ------------------------
create table if not exists pm.dev_capital_plan (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  month         date not null check (extract(day from month) = 1),
  uses_cents    bigint not null default 0 check (uses_cents >= 0),
  equity_cents  bigint not null default 0 check (equity_cents >= 0),
  loan_cents    bigint not null default 0 check (loan_cents >= 0),
  source        text not null default 'GENERATED' check (source in ('GENERATED','MANUAL')),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, month),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- Straight-line the remaining cost to complete over p_months from p_start; equity first until the
-- remaining equity is used, then the loan (equity-first funding rule).
create or replace function pm.dev_generate_capital_plan(p_job uuid, p_start date, p_months int)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare j record; b jsonb; v_ctc bigint; v_eq bigint; v_per bigint; v_left bigint; k int; v_m date; v_e bigint; v_l bigint; v_u bigint;
begin
  select * into j from pm._x_job(p_job);
  if coalesce(p_months, 0) < 1 or p_months > 120 then raise exception 'PM_INVALID: 1–120 months' using errcode = '22023'; end if;
  b := pm._dev_in_balance(j.org_id, p_job);
  v_ctc := greatest((b ->> 'cost_to_complete_cents')::bigint, 0);
  select coalesce(sum((x ->> 'remaining_cents')::bigint), 0) into v_eq from jsonb_array_elements(b -> 'sources') x
   where x ->> 'kind' in ('PREF_EQUITY','SPONSOR_EQUITY','LP_EQUITY');
  delete from pm.dev_capital_plan where org_id = j.org_id and job_id = p_job and source = 'GENERATED';
  v_per := v_ctc / p_months; v_left := v_ctc;
  for k in 0 .. p_months - 1 loop
    v_m := (date_trunc('month', coalesce(p_start, current_date)) + make_interval(months => k))::date;
    v_u := case when k = p_months - 1 then v_left else v_per end;
    v_e := least(v_u, v_eq); v_l := v_u - v_e; v_eq := v_eq - v_e; v_left := v_left - v_u;
    insert into pm.dev_capital_plan (org_id, job_id, month, uses_cents, equity_cents, loan_cents, source)
    values (j.org_id, p_job, v_m, v_u, v_e, v_l, 'GENERATED')
    on conflict (org_id, job_id, month) do update set uses_cents = excluded.uses_cents, equity_cents = excluded.equity_cents, loan_cents = excluded.loan_cents
      where pm.dev_capital_plan.source = 'GENERATED';
  end loop;
  return jsonb_build_object('job_id', p_job, 'months', p_months, 'cost_to_complete_cents', v_ctc);
end $$;

-- Every development project the caller reaches with job financials: budget health, contingency left,
-- draws in flight, in-balance, interest-reserve runway, the next 90 days of key dates, 6 months of
-- capital needs.
create or replace function pm.dev_overview(p_location uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); r record; v_out jsonb := '[]'; g jsonb; b jsonb; c jsonb; v_cap jsonb := '{}'; m record;
begin
  if v_org is null then raise exception 'PM_FORBIDDEN: no organization' using errcode = '42501'; end if;
  if p_location is not null then perform pm._x_org_of_location(p_location); end if;
  for r in select p.*, jb.job_number, jb.name, jb.location_id from pm.dev_projects p join core.jobs jb on jb.org_id = p.org_id and jb.id = p.job_id
            where p.org_id = v_org and (p_location is null or jb.location_id = p_location) and p.stage <> 'DEAD'
              and jb.id in (select pm.my_money_job_ids('projects.financials'))
            order by jb.job_number loop
    g := pm.dev_budget_grid(r.job_id) -> 'totals';
    b := pm._dev_in_balance(v_org, r.job_id);
    c := pm.dev_contingency(r.job_id) -> 'pools';
    v_out := v_out || jsonb_build_object('job_id', r.job_id, 'job_number', r.job_number, 'name', r.name, 'stage', r.stage, 'spe_name', r.spe_name,
      'revised_cents', g -> 'revised_cents', 'ecac_cents', g -> 'ecac_cents', 'variance_cents', g -> 'variance_cents', 'paid_cents', g -> 'paid_cents',
      'contingency_remaining_cents', (select coalesce(sum((x ->> 'current_cents')::bigint), 0) from jsonb_array_elements(c) x),
      'in_balance', b -> 'in_balance', 'gap_cents', b -> 'gap_cents', 'interest_reserve_months', b -> 'interest_reserve_months',
      'draws_in_flight', (select count(*) from pm.draws d where d.org_id = v_org and d.job_id = r.job_id and d.status in ('SUBMITTED','INSPECTION','APPROVED')),
      'key_dates', coalesce((select jsonb_agg(jsonb_build_object('kind', k.kind, 'label', k.label, 'due_on', k.due_on) order by k.due_on)
                               from pm.dev_key_dates k where k.org_id = v_org and k.job_id = r.job_id and k.status = 'OPEN' and k.due_on <= current_date + 90), '[]'));
  end loop;
  for m in select cp.month, sum(cp.uses_cents)::bigint as uses, sum(cp.equity_cents)::bigint as eq, sum(cp.loan_cents)::bigint as loan
             from pm.dev_capital_plan cp join core.jobs jb on jb.org_id = cp.org_id and jb.id = cp.job_id
            where cp.org_id = v_org and (p_location is null or jb.location_id = p_location) and cp.month >= date_trunc('month', current_date) and cp.month < date_trunc('month', current_date) + interval '6 months'
              and jb.id in (select pm.my_money_job_ids('projects.financials'))
            group by cp.month order by cp.month loop
    v_cap := v_cap || jsonb_build_object(to_char(m.month, 'YYYY-MM'), jsonb_build_object('uses_cents', m.uses, 'equity_cents', m.eq, 'loan_cents', m.loan));
  end loop;
  return jsonb_build_object('projects', v_out, 'capital_needs', v_cap);
end $$;

-- Investor / cap-table view: read ONLY from Books (core.equity_holders of the SPE entity). Projects keeps
-- no capital ledger; contributions / distributions / K-1s arrive when Books exposes them.
create or replace function pm.dev_investor_view(p_job uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare j record; p pm.dev_projects%rowtype; v_entity uuid; v_rows jsonb;
begin
  select * into j from pm._x_job(p_job);
  select * into p from pm.dev_projects x where x.org_id = j.org_id and x.job_id = p_job;
  v_entity := coalesce(p.spe_location_id, j.location_id);
  if to_regclass('core.equity_holders') is null then
    return jsonb_build_object('available', false, 'reason', 'Merit Books does not expose the equity ledger', 'entity_id', v_entity);
  end if;
  execute $q$ select coalesce(jsonb_agg(jsonb_build_object('name', h.name, 'equity_class', h.equity_class, 'ownership_pct', h.ownership_pct, 'units', h.units,
                     'capital_contributed_cents', h.capital_contributed_cents, 'is_preferred', h.is_preferred) order by h.ownership_pct desc nulls last, h.name), '[]')
                from core.equity_holders h where h.org_id = $1 and h.entity_id = $2 $q$
    into v_rows using j.org_id, v_entity;
  return jsonb_build_object('available', true, 'source', 'BOOKS', 'entity_id', v_entity, 'spe_provisioned', p.spe_location_id is not null,
    'holders', v_rows, 'contributed_cents', (select coalesce(sum((x ->> 'capital_contributed_cents')::bigint), 0) from jsonb_array_elements(v_rows) x),
    'not_yet_exposed', jsonb_build_array('unfunded commitments', 'distributions', 'K-1 files'));
end $$;

-- ============================================================================
-- Z. 1110 registries: classes, masked columns, RPC guards; RLS; grants
-- ============================================================================
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('vendor_inbox_messages',  'C','location', '{projects.commitments,projects.selections,projects.store,projects.production}', null, null, null, null, null, false, '1122: forwarded vendor emails (rules-only parse)'),
  ('vendor_inbox_proposals', 'C','parent',   '{}', null, 'vendor_inbox_messages', 'message_id', null, null, false, '1122: proposed status / date / price updates'),
  ('dlr_lost_sales',         'C','location', '{projects.store}', null, null, null, null, null, false, '1122: counter lost sales'),
  ('dlr_price_rules',        'S','location', '{}', 'projects.settings', null, null, null, '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1122: parts price matrix'),
  ('dlr_price_files',        'C','location', '{projects.store}', null, null, null, null, null, false, '1122: staged OEM price files'),
  ('dlr_price_file_lines',   'C','parent',   '{}', null, 'dlr_price_files', 'file_id', null, null, false, '1122: price file rows; cost masked'),
  ('dlr_integrations',       'S','location', '{}', 'projects.settings', null, null, null, null, false, '1122: catalog / OEM integration settings (non-secret)'),
  ('dlr_claim_parts',        'J','parent',   '{}', null, 'warranty_claims', 'claim_id', null, null, false, '1122: warranty claim part lines'),
  ('dlr_claim_submissions',  'J','parent',   '{}', null, 'warranty_claims', 'claim_id', null, null, false, '1122: claim submission log + packets'),
  ('dlr_credit_memos',       'C','location', '{projects.store}', null, null, null, null, null, false, '1122: OEM credit memos'),
  ('dlr_credit_memo_lines',  'C','parent',   '{}', null, 'dlr_credit_memos', 'memo_id', null, null, false, '1122: credit memo lines and claim matches'),
  ('dlr_finance_programs',   'S','location', '{}', 'projects.settings', null, null, null, '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1122: OEM promo / standard rate / cash rebate programs; subvention masked'),
  ('dlr_fee_schedule',       'S','location', '{}', 'projects.settings', null, null, null, '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1122: doc / setup / freight fees; cost masked'),
  ('dlr_rental_settings',    'S','location', '{}', 'projects.settings', null, null, null, null, false, '1122: rental return charge settings'),
  ('dlr_rental_inspections', 'C','parent',   '{}', null, 'rental_contracts', 'contract_id', null, null, false, '1122: rental out / in inspections'),
  ('dlr_tech_punches',       'P','location', '{}', null, null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids_any(array[''projects.dispatch'',''projects.reports'']::text[], ''view'')) or %1$slocation_id in (select pm.my_location_ids(''projects.time'', ''approve'')))',
     'false', false, '1122: tech punches; own rows or the service manager'),
  ('mfg_settings',           'S','location', '{}', 'projects.production', null, null, null, null, false, '1122: release gates, kiosk session, backlog weighting'),
  ('mfg_cad_imports',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: CAD/CAM imports + diff'),
  ('mfg_cad_lines',          'J','parent',   '{}', null, 'mfg_cad_imports', 'import_id', null, null, false, '1122: CAD/CAM import lines'),
  ('mfg_center_downtime',    'S','location', '{}', 'projects.production', null, null, null, null, false, '1122: work center down days'),
  ('mfg_badges',             'C','location', '{projects.settings}', null, null, null, null, null, false, '1122: kiosk badge / PIN hashes (no member grants)'),
  ('mfg_kiosk_sessions',     'O','org',      '{}', null, null, null, null, null, false, '1122: kiosk badge sessions (token hash; no member grants)'),
  ('mfg_kiosk_device_guard', 'O','org',      '{}', null, null, null, null, null, false, '1122: per-station sign-in counters and lockout (no member grants)'),
  ('mfg_kiosk_failures',     'O','org',      '{}', null, null, null, null, null, false, '1122: kiosk sign-in failure log, sliding window (no member grants)'),
  ('mfg_kiosk_punches',      'P','location', '{}', null, null, null,
     '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.production'', ''edit'')) or %1$slocation_id in (select pm.my_location_ids(''projects.time'', ''approve'')))',
     'false', false, '1122: shop-floor punches; own rows or the shop lead'),
  ('mfg_kiosk_events',       'O','org',      '{}', null, null, null, null, null, false, '1122: kiosk event idempotency ledger (no member grants)'),
  ('mfg_remakes',            'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: remakes / cost of quality; material estimate masked'),
  ('mfg_material_settings',  'S','location', '{}', 'projects.production', null, null, null, null, false, '1122: lead time / pack / vendor per material; cost masked'),
  ('mfg_installs',           'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: install schedule'),
  ('flr_settings',           'S','location', '{}', 'projects.settings', null, null, null, null, false, '1122: remnant limits, deposit, site checks, waste'),
  ('flr_products',           'S','location', '{}', 'projects.settings', null, null, null, '%1$slocation_id in (select pm.my_location_ids(''projects.financials'', ''edit''))', false, '1122: flooring product file; cost masked'),
  ('flr_labor_rates',        'S','location', '{}', 'projects.settings', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''edit''))', false, '1122: labor price list; installer pay masked'),
  ('flr_job_settings',       'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: tax mode / price level per job'),
  ('flr_quote_lines',        'C','parent',   '{}', null, 'estimates', 'estimate_id', null, null, false, '1122: flooring quote line meta (room, class, tax class)'),
  ('flr_rolls',              'C','location', '{projects.store,projects.production,projects.estimates,projects.dispatch}', null, null, null, null, null, false, '1122: rolls by dye lot; cost masked'),
  ('flr_cut_tickets',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: cut tickets'),
  ('flr_cuts',               'J','parent',   '{}', null, 'flr_cut_tickets', 'ticket_id', null, null, false, '1122: cuts'),
  ('flr_site_checks',        'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: site readiness checks'),
  ('flr_capacity',           'S','location', '{}', 'projects.dispatch', null, null, null, null, false, '1122: install SF capacity per day'),
  ('flr_install_bookings',   'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: install bookings'),
  ('flr_pay_tickets',        'P','location', '{}', null, null, null, '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or %1$slocation_id in (select pm.my_location_ids(''projects.time'', ''approve'')) or (%1$sworker_type = ''1099'' and %1$slocation_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', 'false', false, '1122: installer pay tickets; own or labor rates / time approval'),
  ('flr_pay_ticket_lines',   'P','parent',   '{}', null, 'flr_pay_tickets', 'ticket_id', '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or %1$slocation_id in (select pm.my_location_ids(''projects.time'', ''approve'')) or (%1$sworker_type = ''1099'' and %1$slocation_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', 'false', false, '1122: pay ticket lines'),
  ('flr_chargebacks',        'P','location', '{}', null, null, null, '(%1$semployee_id in (select pm.my_employee_ids()) or %1$slocation_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or %1$slocation_id in (select pm.my_location_ids(''projects.time'', ''approve'')) or (%1$sworker_type = ''1099'' and %1$slocation_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', 'false', false, '1122: installer chargebacks'),
  ('dsn_items',              'J','job',      '{projects.selections}', 'projects.selections', null, null, null, null, false, '1122: design items; client price masked'),
  ('dsn_proposals',          'J','job',      '{projects.selections}', null, null, null, null, null, false, '1122: design proposals'),
  ('dsn_proposal_items',     'J','parent',   '{}', null, 'dsn_proposals', 'proposal_id', null, null, false, '1122: per-item decisions; prices masked'),
  ('dsn_item_deposits',      'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1122: client deposits per item'),
  ('dsn_deposit_moves',      'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1122: deposit reallocations (Books memo held)'),
  ('dsn_fee_agreements',     'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1122: design fee agreement'),
  ('dsn_fee_ledger',         'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1122: fee amounts billed per kind'),
  ('dsn_billed_time',        'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1122: billed design hours (lock)'),
  ('dev_projects',           'J','job',      '{projects.jobs}', null, null, null, null, null, false, '1122: development project (SPE) record'),
  ('dev_spe_requests',       'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: SPE provisioning requests to Books'),
  ('dev_key_dates',          'J','job',      '{projects.jobs}', 'projects.jobs', null, null, null, null, false, '1122: key dates and covenant calendar'),
  ('dev_pro_formas',         'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: versioned pro formas'),
  ('dev_sources',            'M','job',      '{projects.financials}', 'projects.financials', null, null, null, null, false, '1122: sources (capital stack)'),
  ('dev_budget_lines',       'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: budget line → lender line / CIP / pool'),
  ('dev_reallocations',      'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: reallocation log (budget_transfer approvals)'),
  ('dev_draw_invoices',      'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: invoices in a draw'),
  ('dev_lender_templates',   'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: lender package order'),
  ('dev_draw_waivers',       'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: lien waivers per draw'),
  ('dev_capital_plan',       'M','job',      '{projects.financials}', null, null, null, null, null, false, '1122: capital needs by month')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('dlr_price_file_lines', 'cost_cents',      't.file_id in (select f.id from pm.dlr_price_files f where f.org_id = public.get_org_id() and f.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null::text, '1122: dealer net'),
  ('dlr_price_file_lines', 'old_cost_cents',  't.file_id in (select f.id from pm.dlr_price_files f where f.org_id = public.get_org_id() and f.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, '1122'),
  ('dlr_price_file_lines', 'margin_pct',      't.file_id in (select f.id from pm.dlr_price_files f where f.org_id = public.get_org_id() and f.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))', null, '1122: margin reveals cost'),
  ('dlr_finance_programs', 'subvention_pct',  't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122: dealer buy-down fee'),
  ('dlr_fee_schedule',     'cost_cents',      't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122'),
  ('mfg_remakes',          'est_material_cents', 't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1122'),
  ('mfg_material_settings','last_cost_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122'),
  ('work_centers',         'costing_rate_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122: pay + burden rate'),
  ('flr_products',         'cost_cents',      't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122: landed cost'),
  ('flr_labor_rates',      'pay_cents',       't.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view''))', null, '1122: installer piece rate'),
  ('flr_labor_rates',      'job_minimum_pay_cents', 't.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view''))', null, '1122'),
  ('flr_rolls',            'cost_per_lf_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122'),
  ('flr_pay_tickets',      'gross_cents', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1: installer pay is labor rates'),
  ('flr_pay_tickets',      'chargeback_cents', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1: installer pay is labor rates'),
  ('flr_pay_tickets',      'net_cents', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1: installer pay is labor rates'),
  ('flr_pay_tickets',      'payable_payload', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1: installer pay is labor rates'),
  ('flr_pay_ticket_lines', 'rate_cents', 't.ticket_id in (select x.id from pm.flr_pay_tickets x where x.org_id = public.get_org_id() and (x.employee_id in (select pm.my_employee_ids()) or x.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (x.worker_type = ''1099'' and x.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve'')))))', null, '1122 security review H1'),
  ('flr_pay_ticket_lines', 'amount_cents', 't.ticket_id in (select x.id from pm.flr_pay_tickets x where x.org_id = public.get_org_id() and (x.employee_id in (select pm.my_employee_ids()) or x.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (x.worker_type = ''1099'' and x.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve'')))))', null, '1122 security review H1'),
  ('flr_chargebacks',      'amount_cents', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1'),
  ('flr_chargebacks',      'applied_cents', '(t.employee_id in (select pm.my_employee_ids()) or t.location_id in (select pm.my_location_ids(''projects.labor_rates'', ''view'')) or (t.worker_type = ''1099'' and t.location_id in (select pm.my_location_ids_any(array[''projects.commitments'', ''projects.billing''], ''approve''))))', null, '1122 security review H1'),
  ('vendor_inbox_messages', 'parsed', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', '(t.parsed - ''total_cents'' - ''line_prices'')', '1122 security review M2: vendor prices are cost'),
  ('vendor_inbox_messages', 'body_text', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122 security review M2: the raw email carries prices'),
  ('vendor_inbox_messages', 'subject', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1122 security review M2: subjects can carry totals (review INFO)'),
  ('vendor_inbox_proposals', 'old_value', '(t.field not in (''unit_cost_cents'', ''total_cents'') or t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or (t.job_id is null and t.message_id in (select m.id from pm.vendor_inbox_messages m where m.org_id = public.get_org_id() and m.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))))', null, '1122 security review M2: price proposals are cost'),
  ('vendor_inbox_proposals', 'new_value', '(t.field not in (''unit_cost_cents'', ''total_cents'') or t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or (t.job_id is null and t.message_id in (select m.id from pm.vendor_inbox_messages m where m.org_id = public.get_org_id() and m.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')))))', null, '1122 security review M2'),
  ('dsn_items',            'budget_cents',    't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1122'),
  ('dsn_items',            'client_unit_price_cents', 't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1122'),
  ('dsn_items',            'client_total_cents', 't.job_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, '1122'),
  ('dsn_proposal_items',   'client_price_cents', 't.proposal_id in (select p.id from pm.dsn_proposals p where p.org_id = public.get_org_id() and p.job_id in (select pm.my_money_job_ids(''projects.contract_value'')))', null, '1122'),
  ('dsn_proposal_items',   'deposit_cents',   't.proposal_id in (select p.id from pm.dsn_proposals p where p.org_id = public.get_org_id() and p.job_id in (select pm.my_money_job_ids(''projects.contract_value'')))', null, '1122')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('dev_add_draw_invoice', '{p_draw}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1122'),
  ('dev_budget_grid', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1122'),
  ('dev_build_draw', '{p_draw}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1122'),
  ('dev_cancel_reallocation', '{p_reallocation}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_reallocations'', p_reallocation);', '1122'),
  ('dev_compute_pro_forma', '{p_id}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pro_formas'', p_id);', '1122'),
  ('dev_contingency', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1122'),
  ('dev_decide_draw_invoice', '{p_invoice}', 'perform pm.access_assert_row(''projects.billing'', array[''approve''], ''dev_draw_invoices'', p_invoice);', '1122'),
  ('dev_draw_package', '{p_draw}', 'perform pm.access_assert_row(''projects.financials'', array[''view''], ''draws'', p_draw);', '1122'),
  ('dev_draw_precheck', '{p_draw}', 'perform pm.access_assert_row(''projects.financials'', array[''view''], ''draws'', p_draw);', '1122'),
  ('dev_generate_capital_plan', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1122'),
  ('dev_in_balance', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1122'),
  ('dev_investor_view', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1122'),
  ('dev_lock_pro_forma', '{p_id}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_pro_formas'', p_id);', '1122'),
  ('dev_map_budget_line', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1122'),
  ('dev_overview', '{p_location}', 'if p_location is not null and not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1122'),
  ('dev_propose_reallocation', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1122'),
  ('dev_record_lender_consent', '{p_reallocation}', 'perform pm.access_assert_row(''projects.financials'', array[''edit''], ''dev_reallocations'', p_reallocation);', '1122'),
  ('dev_request_draw_waivers', '{p_draw}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1122'),
  ('dev_request_spe', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1122'),
  ('dev_save_pro_forma', '{p_job}', 'perform pm.access_assert_job(''projects.financials'', array[''edit''], p_job);', '1122'),
  ('dev_set_lender_template', '{p_schedule}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draw_schedules'', p_schedule);', '1122'),
  ('dev_set_project', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1122'),
  ('dlr_add_pick_list', '{p_ticket}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''parts_tickets'', p_ticket);', '1122'),
  ('dlr_apply_price_file', '{p_file}', 'if not (pm.access_can_row(''projects.store'', ''approve'', ''dlr_price_files'', p_file) or pm.access_can_row(''projects.financials'', ''edit'', ''dlr_price_files'', p_file)) then perform pm.access_forbid(''applying a price file needs projects.store:approve or projects.financials:edit''); end if;', '1122'),
  ('dlr_apply_program', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', '1122'),
  ('dlr_apply_rental_charges', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', '1122'),
  ('dlr_apply_standard_fees', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dealer_deals'', p_deal);', '1122'),
  ('dlr_claim_readiness', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''warranty_claims'', p_claim);', '1122'),
  ('dlr_clock_indirect', '{p_location}', 'if not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1122'),
  ('dlr_clock_off', '{p_location}', 'if not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1122'),
  ('dlr_clock_on', '{p_line}', 'if not (exists (select 1 from pm.work_order_lines gl where gl.id = p_line and gl.org_id = public.get_org_id() and pm.access_my_work_order(gl.work_order_id)) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.time'', ''create'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires your own RO, projects.dispatch:edit or projects.time:create on the job''); end if;', '1122'),
  ('dlr_confirm_credit_match', '{p_line}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_credit_memo_lines'', p_line);', '1122'),
  ('dlr_deal_worksheet', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dealer_deals'', p_deal);', '1122'),
  ('dlr_delivery_blockers', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dealer_deals'', p_deal);', '1122'),
  ('dlr_discard_price_file', '{p_file}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_price_files'', p_file);', '1122'),
  ('dlr_flag_line', '{p_line}', 'if not (exists (select 1 from pm.work_order_lines gl where gl.id = p_line and gl.org_id = public.get_org_id() and pm.access_my_work_order(gl.work_order_id)) or pm.access_can_row(''projects.dispatch'', ''edit'', ''work_order_lines'', p_line) or pm.access_can_row(''projects.store'', ''edit'', ''work_order_lines'', p_line)) then perform pm.access_forbid(''requires your own RO, projects.dispatch:edit or projects.store:edit''); end if;', '1122'),
  ('dlr_import_credit_memo', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', '1122'),
  ('dlr_kpis', '{p_location}', 'if not (pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.store'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.reports or projects.store view''); end if;', '1122'),
  ('dlr_log_lost_sale', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''create''], p_location);', '1122'),
  ('dlr_payment_scenarios', '{p_deal}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''dealer_deals'', p_deal);', '1122'),
  ('dlr_prepare_claim_submission', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''warranty_claims'', p_claim);', '1122'),
  ('dlr_record_claim_response', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''warranty_claims'', p_claim);', '1122'),
  ('dlr_record_claim_submitted', '{p_submission}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''dlr_claim_submissions'', p_submission);', '1122'),
  ('dlr_record_rental_inspection', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''rental_contracts'', p_contract);', '1122'),
  ('dlr_rental_damage_compare', '{p_contract}', 'perform pm.access_assert_row(''projects.store'', array[''view''], ''rental_contracts'', p_contract);', '1122'),
  ('dlr_resolve_rejected_claim', '{p_claim,p_action}', 'perform pm.access_assert_row(''projects.store'', case when p_action = ''RESUBMIT'' then array[''edit''] else array[''approve''] end, ''warranty_claims'', p_claim);', '1122'),
  ('dlr_scan', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.customers'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.store, dispatch or customers view''); end if;', '1122'),
  ('dlr_set_claim_parts', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''warranty_claims'', p_claim);', '1122'),
  ('dlr_stage_price_file', '{p_location}', 'perform pm.access_assert_location(''projects.store'', array[''edit''], p_location);', '1122'),
  ('dlr_tech_board', '{p_location}', 'if not exists (select 1 from core.locations gl where gl.id = p_location and gl.org_id = public.get_org_id()) then perform pm.access_forbid(''company not in the caller''''s organization''); end if;', '1122'),
  ('dlr_unit_timeline', '{p_unit}', 'if not (pm.access_can_row(''projects.store'', ''view'', ''assets'', p_unit) or pm.access_can_row(''projects.dispatch'', ''view'', ''assets'', p_unit) or pm.access_can_row(''projects.customers'', ''view'', ''assets'', p_unit)) then perform pm.access_forbid(''requires projects.store, dispatch or customers view''); end if;', '1122'),
  ('dlr_update_claim', '{p_claim}', 'perform pm.access_assert_row(''projects.store'', array[''edit''], ''warranty_claims'', p_claim);', '1122'),
  ('dsn_add_component', '{p_item}', 'perform pm.access_assert_row(''projects.selections'', array[''edit''], ''dsn_items'', p_item);', '1122'),
  ('dsn_create_pos', '{p_job}', 'perform pm.access_assert_job(''projects.commitments'', array[''create''], p_job);', '1122'),
  ('dsn_draft_fee_invoice', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1122'),
  ('dsn_reallocate_deposit', '{p_from_item}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''dsn_items'', p_from_item);', '1122'),
  ('dsn_receive_component', '{p_component}', 'if not (pm.access_can_row(''projects.selections'', ''edit'', ''procurement_items'', p_component) or pm.access_can_row(''projects.commitments'', ''edit'', ''procurement_items'', p_component) or pm.access_can_row(''projects.store'', ''edit'', ''procurement_items'', p_component)) then perform pm.access_forbid(''requires projects.selections, commitments or store edit''); end if;', '1122'),
  ('dsn_record_decision', '{p_proposal_item}', 'perform pm.access_assert_row(''projects.selections'', array[''approve''], ''dsn_proposal_items'', p_proposal_item);', '1122'),
  ('dsn_request_deposits', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1122'),
  ('dsn_send_proposal', '{p_job}', 'perform pm.access_assert_job(''projects.selections'', array[''edit''], p_job);', '1122'),
  ('dsn_set_component_date', '{p_component}', 'if not (pm.access_can_row(''projects.selections'', ''edit'', ''procurement_items'', p_component) or pm.access_can_row(''projects.commitments'', ''edit'', ''procurement_items'', p_component)) then perform pm.access_forbid(''requires projects.selections or commitments edit''); end if;', '1122'),
  ('dsn_set_fee_agreement', '{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''edit''], p_job);', '1122'),
  ('flr_acknowledge_chargeback', '{p_chargeback}', 'if not exists (select 1 from pm.flr_chargebacks gc where gc.id = p_chargeback and gc.org_id = public.get_org_id()) then perform pm.access_forbid(''chargeback not in the caller''''s organization''); end if;', '1122'),
  ('flr_approve_pay_ticket', '{p_ticket}', 'if not (pm.access_can_row(''projects.time'', ''approve'', ''flr_pay_tickets'', p_ticket) or pm.access_can_row(''projects.labor_rates'', ''edit'', ''flr_pay_tickets'', p_ticket) or pm.access_can_row(''projects.commitments'', ''approve'', ''flr_pay_tickets'', p_ticket) or pm.access_can_row(''projects.billing'', ''approve'', ''flr_pay_tickets'', p_ticket)) then perform pm.access_forbid(''requires projects.time:approve (W-2) or projects.commitments / billing:approve (1099)''); end if;', '1122'),
  ('flr_book_install', '{p_job}', 'perform pm.access_assert_job(''projects.dispatch'', array[''edit''], p_job);', '1122'),
  ('flr_build_quote', '{p_job}', 'perform pm.access_assert_job(''projects.estimates'', array[''edit''], p_job);', '1122'),
  ('flr_create_cut_ticket', '{p_job}', 'if not (pm.access_can_job(''projects.store'', ''edit'', p_job) or pm.access_can_job(''projects.production'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.store or production edit on this job''); end if;', '1122'),
  ('flr_finalize_pay_ticket', '{p_ticket}', 'if not (pm.access_can_row(''projects.dispatch'', ''edit'', ''flr_pay_tickets'', p_ticket) or pm.access_can_row(''projects.time'', ''approve'', ''flr_pay_tickets'', p_ticket)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.time:approve''); end if;', '1122'),
  ('flr_import_measure', '{p_job}', 'if not (pm.access_can_job(''projects.jobs'', ''edit'', p_job) or pm.access_can_job(''projects.estimates'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.jobs or estimates edit on this job''); end if;', '1122'),
  ('flr_install_board', '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.jobs'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch or jobs view''); end if;', '1122'),
  ('flr_job_readiness', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1122'),
  ('flr_lot_check', '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1122'),
  ('flr_propose_chargeback', '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''edit'', p_location) or pm.access_can_location(''projects.time'', ''approve'', p_location)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.time:approve''); end if;', '1122'),
  ('flr_receive_roll', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''edit'', p_location) or pm.access_can_location(''projects.production'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.store or production edit''); end if;', '1122'),
  ('flr_record_cut', '{p_cut}', 'if not (pm.access_can_row(''projects.store'', ''edit'', ''flr_cuts'', p_cut) or pm.access_can_row(''projects.production'', ''edit'', ''flr_cuts'', p_cut)) then perform pm.access_forbid(''requires projects.store or production edit on this job''); end if;', '1122'),
  ('flr_record_site_check', '{p_job}', 'if not (pm.access_can_job(''projects.jobs'', ''edit'', p_job) or pm.access_can_job(''projects.dispatch'', ''edit'', p_job) or pm.access_can_job(''projects.time'', ''create'', p_job)) then perform pm.access_forbid(''requires the job (jobs:edit, dispatch:edit or time:create)''); end if;', '1122'),
  ('flr_set_job_settings', '{p_job}', 'perform pm.access_assert_job(''projects.estimates'', array[''edit''], p_job);', '1122'),
  ('flr_suggest_roll', '{p_location}', 'if not (pm.access_can_location(''projects.store'', ''view'', p_location) or pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.estimates'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.store, production or estimates view''); end if;', '1122'),
  ('flr_ticket_from_completion', '{p_job}', 'if not (pm.access_can_job(''projects.dispatch'', ''edit'', p_job) or pm.access_can_job(''projects.time'', ''approve'', p_job)) then perform pm.access_forbid(''requires projects.dispatch:edit or projects.time:approve on this job''); end if;', '1122'),
  ('flr_void_pay_ticket', '{p_ticket}', 'perform pm.access_assert_row(''projects.time'', array[''approve''], ''flr_pay_tickets'', p_ticket);', '1122'),
  ('mfg_apply_cad_import', '{p_import}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_cad_imports'', p_import);', '1122'),
  ('mfg_backlog', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location) or pm.access_can_location(''projects.estimates'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production, reports or estimates view''); end if;', '1122'),
  ('mfg_cost_of_quality', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.reports'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production or reports view''); end if;', '1122'),
  ('mfg_create_po_from_demand', '{p_job}', 'perform pm.access_assert_job(''projects.commitments'', array[''create''], p_job);', '1122'),
  ('mfg_decide_remake', '{p_remake}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''mfg_remakes'', p_remake);', '1122'),
  ('mfg_install_board', '{p_location}', 'if not (pm.access_can_location(''projects.dispatch'', ''view'', p_location) or pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.jobs'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.dispatch, production or jobs view''); end if;', '1122'),
  ('mfg_kiosk_events', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1122'),
  ('mfg_badge_alerts', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1122'),
  ('mfg_kiosk_identify', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1122'),
  ('mfg_material_demand', '{p_location}', 'if not (pm.access_can_location(''projects.production'', ''view'', p_location) or pm.access_can_location(''projects.commitments'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.production or commitments view''); end if;', '1122'),
  ('mfg_receive_po_line', '{p_line}', 'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitment_lines'', p_line);', '1122'),
  ('mfg_release', '{p_wo}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', '1122'),
  ('mfg_release_check', '{p_wo}', 'if not (pm.access_can_row(''projects.production'', ''view'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''view'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires the job''); end if;', '1122'),
  ('mfg_request_remake', '{p_wo}', 'if not (pm.access_my_work_order(p_wo) or pm.access_can_row(''projects.production'', ''edit'', ''work_orders'', p_wo) or pm.access_can_row(''projects.jobs'', ''edit'', ''work_orders'', p_wo)) then perform pm.access_forbid(''requires your own operation, projects.production:edit or projects.jobs:edit''); end if;', '1122'),
  ('mfg_restandard_operations', '{p_wo}', 'perform pm.access_assert_row(''projects.production'', array[''edit''], ''work_orders'', p_wo);', '1122'),
  ('mfg_schedule_install', '{p_job}', 'if not (pm.access_can_job(''projects.dispatch'', ''edit'', p_job) or pm.access_can_job(''projects.production'', ''edit'', p_job)) then perform pm.access_forbid(''requires projects.dispatch or production edit on this job''); end if;', '1122'),
  ('mfg_set_badge', '{p_location}', 'perform pm.access_assert_location(''projects.production'', array[''edit''], p_location);', '1122'),
  ('mfg_stage_cad_import', '{p_job}', 'perform pm.access_assert_job(''projects.production'', array[''edit''], p_job);', '1122'),
  ('vi_decide', '{p_proposal}', 'if not (pm.access_can_row(''projects.commitments'', ''edit'', ''vendor_inbox_proposals'', p_proposal) or pm.access_can_row(''projects.selections'', ''edit'', ''vendor_inbox_proposals'', p_proposal) or pm.access_can_row(''projects.store'', ''edit'', ''vendor_inbox_proposals'', p_proposal)) then perform pm.access_forbid(''requires projects.commitments, selections or store edit''); end if;', '1122'),
  ('vi_dismiss', '{p_message}', 'if not (pm.access_can_row(''projects.commitments'', ''edit'', ''vendor_inbox_messages'', p_message) or pm.access_can_row(''projects.selections'', ''edit'', ''vendor_inbox_messages'', p_message) or pm.access_can_row(''projects.store'', ''edit'', ''vendor_inbox_messages'', p_message)) then perform pm.access_forbid(''requires projects.commitments, selections or store edit''); end if;', '1122'),
  ('vi_ingest', '{p_location}', 'if not (pm.access_can_location(''projects.commitments'', ''edit'', p_location) or pm.access_can_location(''projects.selections'', ''edit'', p_location) or pm.access_can_location(''projects.store'', ''edit'', p_location)) then perform pm.access_forbid(''requires projects.commitments, selections or store edit''); end if;', '1122')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;


-- RLS: permissive org isolation on every new table (the class policies narrow it)
do $$
declare t text;
begin
  foreach t in array array['vendor_inbox_messages', 'vendor_inbox_proposals', 'dlr_lost_sales', 'dlr_price_rules', 'dlr_price_files', 'dlr_price_file_lines',
              'dlr_integrations', 'dlr_claim_parts', 'dlr_claim_submissions', 'dlr_credit_memos', 'dlr_credit_memo_lines', 'dlr_finance_programs',
              'dlr_fee_schedule', 'dlr_rental_settings', 'dlr_rental_inspections', 'dlr_tech_punches', 'mfg_settings', 'mfg_cad_imports',
              'mfg_cad_lines', 'mfg_center_downtime', 'mfg_badges', 'mfg_kiosk_sessions', 'mfg_kiosk_device_guard', 'mfg_kiosk_failures', 'mfg_kiosk_punches', 'mfg_kiosk_events',
              'mfg_remakes', 'mfg_material_settings', 'mfg_installs', 'flr_settings', 'flr_products', 'flr_labor_rates',
              'flr_job_settings', 'flr_quote_lines', 'flr_rolls', 'flr_cut_tickets', 'flr_cuts', 'flr_site_checks',
              'flr_capacity', 'flr_install_bookings', 'flr_pay_tickets', 'flr_pay_ticket_lines', 'flr_chargebacks', 'dsn_items',
              'dsn_proposals', 'dsn_proposal_items', 'dsn_item_deposits', 'dsn_deposit_moves', 'dsn_fee_agreements', 'dsn_fee_ledger',
              'dsn_billed_time', 'dev_projects', 'dev_spe_requests', 'dev_key_dates', 'dev_pro_formas', 'dev_sources',
              'dev_budget_lines', 'dev_reallocations', 'dev_draw_invoices', 'dev_lender_templates', 'dev_draw_waivers', 'dev_capital_plan'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
  end loop;
end $$;

-- members read workflow rows (definer RPCs write); config / catalog tables are member-writable through
-- their class write cap; badge hashes, kiosk sessions and the kiosk ledger have no member grants
grant select on pm.vendor_inbox_messages, pm.vendor_inbox_proposals, pm.dlr_lost_sales, pm.dlr_price_files, pm.dlr_price_file_lines,
                pm.dlr_claim_parts, pm.dlr_claim_submissions, pm.dlr_credit_memos, pm.dlr_credit_memo_lines, pm.dlr_rental_inspections,
                pm.dlr_tech_punches, pm.mfg_cad_imports, pm.mfg_cad_lines, pm.mfg_kiosk_punches, pm.mfg_remakes, pm.mfg_installs,
                pm.flr_job_settings, pm.flr_quote_lines, pm.flr_rolls, pm.flr_cut_tickets, pm.flr_cuts, pm.flr_site_checks, pm.flr_install_bookings,
                pm.flr_pay_tickets, pm.flr_pay_ticket_lines, pm.flr_chargebacks, pm.dsn_items, pm.dsn_proposals, pm.dsn_proposal_items,
                pm.dsn_item_deposits, pm.dsn_deposit_moves, pm.dsn_fee_agreements, pm.dsn_fee_ledger, pm.dsn_billed_time, pm.dev_projects,
                pm.dev_spe_requests, pm.dev_pro_formas, pm.dev_budget_lines, pm.dev_reallocations, pm.dev_draw_invoices, pm.dev_lender_templates,
                pm.dev_draw_waivers, pm.dev_capital_plan
  to authenticated;
grant select, insert, update, delete on pm.dlr_price_rules, pm.dlr_integrations, pm.dlr_finance_programs, pm.dlr_fee_schedule, pm.dlr_rental_settings,
                pm.mfg_settings, pm.mfg_center_downtime, pm.mfg_material_settings, pm.flr_settings, pm.flr_products, pm.flr_labor_rates, pm.flr_capacity,
                pm.dev_key_dates, pm.dev_sources
  to authenticated;
-- descriptive item fields designers edit directly (state / money columns stay RPC-only)
grant insert (job_id, wbs_id, room, doc_code, name, category, description, image_document_id, image_url, vendor_url, qty, is_placeholder,
                      budget_cents, client_unit_price_cents, deposit_pct, client_visible, show_cost_to_client, internal_notes, sort),
      update (wbs_id, room, doc_code, name, category, description, image_document_id, image_url, vendor_url, qty, is_placeholder,
                      budget_cents, client_unit_price_cents, deposit_pct, client_visible, show_cost_to_client, internal_notes, sort)
  on pm.dsn_items to authenticated;
grant update (efficiency_pct, hours_per_day, days_per_week, shifts, crew_size, costing_rate_cents) on pm.work_centers to authenticated;
grant update (run_basis, is_machine, is_outside, outside_vendor_id, outside_lead_days) on pm.routing_steps to authenticated;

do $$
declare v text;
begin
  foreach v in array array['v_dlr_counter_speed','v_dlr_claim_deadlines','v_dlr_sold_unpaid','v_mfg_open_punches','v_dsn_item_deposits','v_dsn_procurement_hub'] loop
    execute format('revoke all on pm.%I from public, anon, authenticated', v);
    execute format('grant select on pm.%I to authenticated, service_role', v);
  end loop;
end $$;

-- Policies (every classified table), masked views (incl. the new columns on masked 1105 / 1106
-- tables), RPC guards.
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon; members get the guarded RPC surface and the pure helpers.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              '_dev_draw_issues', '_dev_grid_rows', '_dev_in_balance', '_dev_package_sections', '_dlr_close_punch', '_dlr_damage_rank',
              '_dlr_eligible_programs', '_dlr_punch_employee', '_dsn_request_deposit', '_flr_day_capacity', '_flr_day_load', '_flr_lot_warnings',
              '_flr_price', '_flr_readiness', '_flr_settings', '_mfg_create_remake', '_mfg_demand_rows', '_mfg_install_conflicts',
              '_mfg_kiosk_event', '_mfg_kiosk_ops', '_mfg_settings', '_mfg_split_minutes', '_x_invoice_state', '_x_job',
              '_x_job_deposits', '_x_org_of_location', '_x_sees', '_x_sha256', '_x_try_bigint', '_x_try_bool', '_x_try_date',
              '_x_try_num', '_x_try_ts', 'dev_add_draw_invoice', 'dev_budget_grid', 'dev_build_draw', 'dev_cancel_reallocation',
              'dev_compute_pro_forma', 'dev_contingency', 'dev_decide_draw_invoice', 'dev_default_sections', 'dev_draw_package', 'dev_draw_precheck',
              'dev_generate_capital_plan', 'dev_in_balance', 'dev_investor_view', 'dev_irr', 'dev_lock_pro_forma', 'dev_map_budget_line',
              'dev_mark_spe_provisioned', 'dev_overview', 'dev_propose_reallocation', 'dev_record_lender_consent', 'dev_request_draw_waivers', 'dev_request_spe',
              'dev_save_pro_forma', 'dev_set_lender_template', 'dev_set_project', 'dlr_add_pick_list', 'dlr_apply_price_file', 'dlr_apply_program',
              'dlr_apply_rental_charges', 'dlr_apply_standard_fees', 'dlr_claim_readiness', 'dlr_clock_indirect', 'dlr_clock_off', 'dlr_clock_on',
              'dlr_confirm_credit_match', 'dlr_deal_worksheet', 'dlr_delivery_blockers', 'dlr_discard_price_file', 'dlr_flag_line', 'dlr_import_credit_memo',
              'dlr_kpis', 'dlr_log_lost_sale', 'dlr_matrix_price', 'dlr_oem_profile', 'dlr_payment_scenarios', 'dlr_prepare_claim_submission',
              'dlr_record_claim_response', 'dlr_record_claim_submitted', 'dlr_record_rental_inspection', 'dlr_rental_damage_compare', 'dlr_resolve_rejected_claim', 'dlr_scan',
              'dlr_set_claim_parts', 'dlr_stage_price_file', 'dlr_tech_board', 'dlr_unit_timeline', 'dlr_update_claim', 'dsn_add_component',
              'dsn_create_pos', 'dsn_draft_fee_invoice', 'dsn_reallocate_deposit', 'dsn_receive_component', 'dsn_record_decision', 'dsn_request_deposits',
              'dsn_send_proposal', 'dsn_set_component_date', 'dsn_set_fee_agreement', 'flr_acknowledge_chargeback', 'flr_approve_pay_ticket', 'flr_book_install',
              'flr_build_quote', 'flr_create_cut_ticket', 'flr_finalize_pay_ticket', 'flr_import_measure', 'flr_install_board', 'flr_job_readiness',
              'flr_lot_check', 'flr_material_qty', 'flr_propose_chargeback', 'flr_receive_roll', 'flr_record_cut', 'flr_record_site_check',
              'flr_set_job_settings', 'flr_suggest_roll', 'flr_ticket_from_completion', 'flr_void_pay_ticket', 'mfg_apply_cad_import', 'mfg_backlog', 'mfg_badge_alerts',
              'mfg_center_week_minutes', 'mfg_cost_of_quality', 'mfg_create_po_from_demand', 'mfg_decide_remake', 'mfg_install_board', 'mfg_kiosk_events',
              'mfg_kiosk_identify', 'mfg_material_demand', 'mfg_material_key', 'mfg_receive_po_line', 'mfg_release', 'mfg_release_check',
              'mfg_request_remake', 'mfg_restandard_operations', 'mfg_schedule_install', 'mfg_set_badge', 'mfg_stage_cad_import', 'tg_dev_draw_in_balance',
              'tg_dev_reallocation_gate', 'tg_dsn_billed_time_lock', 'tg_dsn_item_lock', 'vi_decide', 'vi_dismiss', 'vi_ingest') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in (
              'dev_add_draw_invoice', 'dev_budget_grid', 'dev_build_draw', 'dev_cancel_reallocation', 'dev_compute_pro_forma', 'dev_contingency',
              'dev_decide_draw_invoice', 'dev_default_sections', 'dev_draw_package', 'dev_draw_precheck', 'dev_generate_capital_plan', 'dev_in_balance',
              'dev_investor_view', 'dev_irr', 'dev_lock_pro_forma', 'dev_map_budget_line', 'dev_overview', 'dev_propose_reallocation',
              'dev_record_lender_consent', 'dev_request_draw_waivers', 'dev_request_spe', 'dev_save_pro_forma', 'dev_set_lender_template', 'dev_set_project',
              'dlr_add_pick_list', 'dlr_apply_price_file', 'dlr_apply_program', 'dlr_apply_rental_charges', 'dlr_apply_standard_fees', 'dlr_claim_readiness',
              'dlr_clock_indirect', 'dlr_clock_off', 'dlr_clock_on', 'dlr_confirm_credit_match', 'dlr_deal_worksheet', 'dlr_delivery_blockers',
              'dlr_discard_price_file', 'dlr_flag_line', 'dlr_import_credit_memo', 'dlr_kpis', 'dlr_log_lost_sale', 'dlr_oem_profile',
              'dlr_payment_scenarios', 'dlr_prepare_claim_submission', 'dlr_record_claim_response', 'dlr_record_claim_submitted', 'dlr_record_rental_inspection', 'dlr_rental_damage_compare',
              'dlr_resolve_rejected_claim', 'dlr_scan', 'dlr_set_claim_parts', 'dlr_stage_price_file', 'dlr_tech_board', 'dlr_unit_timeline',
              'dlr_update_claim', 'dsn_add_component', 'dsn_create_pos', 'dsn_draft_fee_invoice', 'dsn_reallocate_deposit', 'dsn_receive_component',
              'dsn_record_decision', 'dsn_request_deposits', 'dsn_send_proposal', 'dsn_set_component_date', 'dsn_set_fee_agreement', 'flr_acknowledge_chargeback',
              'flr_approve_pay_ticket', 'flr_book_install', 'flr_build_quote', 'flr_create_cut_ticket', 'flr_finalize_pay_ticket', 'flr_import_measure',
              'flr_install_board', 'flr_job_readiness', 'flr_lot_check', 'flr_material_qty', 'flr_propose_chargeback', 'flr_receive_roll',
              'flr_record_cut', 'flr_record_site_check', 'flr_set_job_settings', 'flr_suggest_roll', 'flr_ticket_from_completion', 'flr_void_pay_ticket',
              'mfg_apply_cad_import', 'mfg_backlog', 'mfg_badge_alerts', 'mfg_cost_of_quality', 'mfg_create_po_from_demand', 'mfg_decide_remake', 'mfg_install_board',
              'mfg_kiosk_events', 'mfg_kiosk_identify', 'mfg_material_demand', 'mfg_material_key', 'mfg_receive_po_line', 'mfg_release',
              'mfg_release_check', 'mfg_request_remake', 'mfg_restandard_operations', 'mfg_schedule_install', 'mfg_set_badge', 'mfg_stage_cad_import',
              'vi_decide', 'vi_dismiss', 'vi_ingest') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1122_pm_industry_depth
-- ============================================================================
