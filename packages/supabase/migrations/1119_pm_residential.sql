-- ============================================================================
-- 1119 · Merit Projects — residential depth (Wave B, agent B-RES)
--
-- Spec: /home/claude/panel/02-residential.md (seat 02, every Launch row RES-01…127),
-- docs/projects/WAVE-B-BRIEF.md (binding rules). Builds on 1100–1117 (estimates + accept_estimate,
-- allowances, deposits, milestone billing, selections, client approvals, procurement, schedule
-- templates + CPM, draws, labor rate cards, approvals engine, notifications, e-sign) and the 1110
-- access foundation. Every new table is classified in pm.access_table_classes, every member
-- definer RPC is registered in pm.access_rpc_guards, money columns are masked through
-- pm.access_masked_columns. No GL posting: Books owns invoices, deposits, AR, AP, tax and cash.
--
-- WHAT THIS MIGRATION ADDS
--   A. Setup + cost catalog (RES-01/17/18)
--        res_settings (per company: contract / tax defaults, overage rule, selection buffer, reminder
--        cadence, trade confirm window, unforeseen-conditions clause, late-change fee, warranty walk
--        cadence, deposit default) · res_state_rules (catalog: cancellation notice days + text, deposit
--        caps, labor / design-fee taxability by state) · res_catalog_items (cost code × cost type, unit
--        cost, waste %, markup or margin, supplier SKU, labor rate card + hours per unit, tax category)
--        · res_assemblies ─< res_assembly_items. The labor rule is 1108's: cost = pay + burden (the
--        budget), estimating rate adds overhead (shown separately, recovered in margin, never in cost).
--   B. Proposals (RES-19/25/26/27/28/29/85)
--        res_proposals (1 : 1 with a pm.estimates number on the job; contract type, tax form, scope
--        narrative, inclusions / exclusions, state cancellation notice, deposit, design-retainer credit,
--        schedule template) ─< res_proposal_options (alternates in a group = good / better / best,
--        add-ons) ─< res_proposal_lines (catalog / assembly / labor / allowance / contingency lines)
--        · res_proposal_snapshots (every sent version, kept) · res_payment_schedule (deposit,
--        milestones tied to schedule-template refs, final) · res_job_terms (contract form on the job).
--        pm.res_create_proposal (from a crm lead through crm.convert_lead — customer via the matcher —
--        or on an existing job), res_add_assembly, res_price_proposal, res_set_payment_schedule,
--        res_send_proposal (sync → estimate, approvals engine below the margin floor, snapshot),
--        res_revise_proposal, res_accept_proposal (in person) and the e-sign path (an estimate
--        accepted by its signed document completes the proposal in the same transaction).
--        Accept → job in one click: accept_estimate (baseline budget without overhead, allowances,
--        contract) + job terms + schedule from template + selections from allowance lines + payment
--        schedule bound to milestone tasks + deposit request (Books mints the invoice; pay link) +
--        household / portal invites + the crm lead marked converted.
--   C. Selections & allowances (RES-31/32/33/34/35/81/88)
--        pm.selections + room, install task, lead time, needed-by, reminders, at-risk flag, shared
--        allowance; pm.selection_options + image, finish, spec sheet, vendor URL, vendor deposit %.
--        pm.res_selection_preview (delta vs the allowance BEFORE choosing, shared allowances included),
--        pm.res_choose_selection (client approval → allowance change order signed by the customer and
--        approved through the approvals engine → deposit request or next-milestone add → draft PO +
--        procurement item → vendor deposit request), pm.res_refresh_selection_deadlines (install task
--        start − lead time − buffer), pm.res_send_selection_reminders (customer.selection_reminder),
--        pm.res_reconcile_allowance (net variance → add / deduct CO), pm.res_decision_queue.
--   D. Change orders (RES-40/41/42/43/44/118)
--        pm.change_orders + co_type (CLIENT | FIELD_REQUEST | DEMO_DISCOVERY | ALLOWANCE | NO_CHARGE),
--        initiated_by, reason_code, stop_work, emergency, contract clause, photo / voice evidence,
--        transcript, signer; res_change_order_lines. res_request_field_co (photo + voice from the
--        field; "do not proceed until signed"), res_price_change_order, res_record_co_signature
--        (in-person / fast-sign), res_create_internal_co (no-charge, builder error / goodwill),
--        res_propose_trade_cos (matching commitment changes), pm.v_res_co_exposure + summary.
--   E. Trade partners (RES-30/48/56/57/58/59/60/61)
--        res_task_trades (assignment → SMS with Confirm / Can't / Propose link; red 72 h before),
--        public.res_trade_respond (token-scoped, anon); res_bid_packages ─< res_bid_package_lines,
--        res_bid_invites ─< res_bid_prices, public.res_bid_submit, pm.res_bid_leveling, res_award_bid
--        (→ subcontract); commitments + trade acceptance (public.res_po_accept); res_vendor_deposits
--        (special orders); res_trade_invoices ─< res_trade_invoice_lines (match to PO lines: price,
--        quantity, over-commitment); pm.res_compliance_gate (COI / W-9 / licence / lien waiver) blocks
--        approval for payment.
--   F. Billing (RES-77/78/80/82/85/86/125)
--        payment milestones become 0-day milestone tasks after their schedule task; the task finishing
--        drafts the milestone billing request (held when the photo / checklist is missing);
--        res_generate_cost_plus_billing (posted costs + fee, each cost once via pm.billing_links, backup
--        list); res_assemble_draw_package (lines, photos, invoices, lien waivers, title date-down) +
--        res_request_draw_shortfall (owner pays what the lender did not); pm.res_tax_preview (product vs
--        labor vs design fee by contract form and state); pm.res_billing_integrity (the daily leak scan).
--   G. Home builder (RES-03/54/55/64/65/66/103/104/105/106/107/108/110/111/112)
--        res_communities ─< res_community_phases, res_lots (raw → … → closed, premium, setbacks, swing,
--        HOA rules, plat geometry, spec flag), res_plans ─< res_plan_prices / res_elevations,
--        res_options ─< res_option_prices (dependencies, exclusions, stage cutoff, structural, tasks to
--        add), res_price_agreements (trade × plan / elevation / option, effective-dated, release stage),
--        res_purchase_agreements ─< res_pa_options / res_pa_addenda (contingencies, earnest money →
--        deposit), res_start_package_items (release a lot → POs by stage; option change regenerates),
--        res_vpos (reason codes, chargeback party), res_permits / res_inspections (a failed inspection
--        blocks its task), res_closings (checklist + settlement statement), v_res_starts_board,
--        v_res_spec_inventory, res_builder_kpis.
--   H. Remodeler + closeout (RES-96/97/99/115/116/117/119/120)
--        res_home_profiles (occupied-home rules for the field app), res_protection_checks (day-1
--        containment, daily cleanup photo, protection removal), res_rrp_records (pre-1978: certified
--        renovator, pamphlet acknowledgment, containment + cleaning verification, kept 3 years),
--        res_household_members (who can sign / pay / see money; portal invite hook), res_chains ─<
--        res_chain_steps (cabinet → template → fabrication → counter → backsplash with lead times and
--        homeowner-visible status), res_walks (final walkthrough, orientation, 30-day / 11-month /
--        2-year warranty walks; acceptance signed; items → punch).
--
-- ACCESS (1110 classes; registered below)
--   S  res_settings, res_catalog_items, res_assemblies (+ items), res_communities (+ phases), res_lots,
--      res_plans (+ prices, elevations), res_options (+ prices). Cost / margin columns masked.
--   O  res_state_rules (catalog, no org_id; read by every member).
--   C  res_proposals (+ options, lines, snapshots) on projects.estimates at the company — cost masked
--      (financials on the job, or the author: "cost only on the estimates they wrote");
--      res_purchase_agreements (+ options, addenda) on projects.estimates / leads;
--      res_price_agreements on projects.commitments / financials.
--   M  res_payment_schedule, res_job_terms, res_closings (contract_value); res_change_order_lines
--      (parent change_orders); res_bid_packages (+ lines), res_bid_invites (+ prices),
--      res_vendor_deposits, res_trade_invoices (+ lines), res_start_package_items, res_vpos
--      (financials).
--   J  res_home_profiles, res_household_members, res_protection_checks, res_rrp_records, res_permits,
--      res_inspections, res_chains (+ steps), res_walks, res_task_trades.
--   Public (anon) surface: public.res_trade_respond, public.res_bid_submit, public.res_po_accept —
--   SECURITY DEFINER, search_path pinned, sha-256 token match first, nothing else reachable. Nothing
--   in pm is executable by anon.
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * A proposal always sits on a job (pm.estimates needs one): from a lead, crm.convert_lead creates
--     the presale job + customer (the shared matcher) at proposal creation, as the existing
--     lead → estimate flow does. "Accept → job" then turns that presale job into a sold job with every
--     downstream object; nothing is re-keyed.
--   * The e-sign document is the estimate's proposal document (doc_files.subject_table must be one of
--     1115's known tables). The estimate callback accepts it; a deferred constraint trigger on
--     pm.estimates completes the residential half in the same transaction.
--   * Sales tax is computed here (preview + proposal totals) by contract form; the invoice-line tax
--     category is a Books seam ask (frozen v3 JOB_BILLING has no tax_contract_form yet).
--   * Vendor deposits, trade invoices and VPO chargebacks are recorded here; JOB_COMMITMENT
--     prepayment_required / JOB_PAYABLE_REQUEST / vendor credits are Books seam asks.
--   * New notification events are mandatory (no persona recipes yet — the recipe mirror in
--     apps/projects/src/lib/notify/recipes.ts belongs to Wave A; the lead adds rows there).
--   * Portal grants: res_household_members.portal_status = PENDING_INVITE is the hook the portals
--     migration (1118) consumes; no portal tables are touched here.
--
-- APPLY RULE: after 1110–1117. Idempotent: safe twice; PGlite-safe.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1119_pm_residential requires 1110_pm_access';
  end if;
  if to_regclass('pm.approval_requests') is null then
    raise exception '1119_pm_residential requires 1113_pm_approvals';
  end if;
  if to_regclass('pm.esign_envelopes') is null then
    raise exception '1119_pm_residential requires 1115_pm_documents_esign';
  end if;
  if to_regclass('core.outbound_messages') is null then
    raise exception '1119_pm_residential requires 1114_notifications';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 0. Helpers
-- ----------------------------------------------------------------------------
-- Integer half-up rounding of a non-negative-or-negative numeric to cents (away from zero on .5).
create or replace function pm.res_round(p numeric) returns bigint
language sql immutable
set search_path = pm, public
as $$ select case when p is null then null when p >= 0 then floor(p + 0.5)::bigint else -floor(-p + 0.5)::bigint end $$;

-- Sell price from a cost: markup (cost × (1 + m)) or margin (cost ÷ (1 − g)).
create or replace function pm.res_sell(p_cost bigint, p_markup numeric, p_margin numeric) returns bigint
language sql immutable
set search_path = pm, public
as $$
  select case
    when p_cost is null then null
    when p_margin is not null and p_margin < 1 then pm.res_round(p_cost / (1 - p_margin))
    else pm.res_round(p_cost * (1 + coalesce(p_markup, 0))) end
$$;

-- The caller's membership (for job teams / household / audit).
create or replace function pm._res_me() returns uuid
language sql stable security definer
set search_path = pm, core, public
as $$ select core.client_scope_caller_membership() $$;

-- ----------------------------------------------------------------------------
-- A. Settings, state rules, cost catalog, assemblies
-- ----------------------------------------------------------------------------
create table if not exists pm.res_settings (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id),
  business_kind           text not null default 'remodel' check (business_kind in ('remodel','custom','production','hybrid')),
  state_code              text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  default_contract_type   text not null default 'FIXED_PRICE' check (default_contract_type in
                            ('FIXED_PRICE','COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS','DESIGN_AGREEMENT','PURCHASE_AGREEMENT')),
  default_tax_form        text not null default 'LUMP_SUM_IMPROVEMENT' check (default_tax_form in ('LUMP_SUM_IMPROVEMENT','RETAIL_PLUS_INSTALL','EXEMPT')),
  default_tax_rate        numeric(7,6) not null default 0 check (default_tax_rate >= 0 and default_tax_rate < 0.5),
  default_deposit_pct     numeric(6,4) not null default 0.10 check (default_deposit_pct >= 0 and default_deposit_pct <= 1),
  default_markup_pct      numeric(7,4) not null default 0.25 check (default_markup_pct >= 0 and default_markup_pct <= 10),
  overage_billing         text not null default 'UPFRONT' check (overage_billing in ('UPFRONT','NEXT_MILESTONE')),
  selection_buffer_days   int not null default 5 check (selection_buffer_days between 0 and 120),
  reminder_lead_days      int not null default 7 check (reminder_lead_days between 0 and 60),
  reminder_every_days     int not null default 3 check (reminder_every_days between 1 and 30),
  trade_confirm_hours     int not null default 72 check (trade_confirm_hours between 1 and 720),
  unforeseen_clause       text not null default 'Concealed or unforeseen conditions (for example rot, unsafe wiring, out-of-code plumbing or structural defects) found after demolition are not part of the contract price. We stop work in the affected area and proceed only after you sign a change order.'
                            check (char_length(unforeseen_clause) <= 2000),
  late_change_fee_cents   bigint not null default 25000 check (late_change_fee_cents >= 0),
  warranty_walk_days      int[] not null default '{30,330,730}',
  structural_warranty_years int not null default 10 check (structural_warranty_years between 0 and 20),
  updated_by              text default pm.current_user_id(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, location_id),
  unique (org_id, id)
);
comment on table pm.res_settings is '1119 (RES-01): residential setup per company — defaults the proposal builder, selections, trade and warranty flows read.';

create table if not exists pm.res_state_rules (
  state_code           text primary key check (state_code ~ '^[A-Z]{2}$'),
  name                 text not null,
  cancel_days          int not null default 3 check (cancel_days between 0 and 30),
  notice_text          text not null,
  deposit_cap_pct      numeric(6,4) check (deposit_cap_pct is null or (deposit_cap_pct > 0 and deposit_cap_pct <= 1)),
  deposit_cap_cents    bigint check (deposit_cap_cents is null or deposit_cap_cents > 0),
  labor_taxable        boolean not null default false,
  design_fee_taxable   boolean not null default false,
  updated_at           timestamptz not null default now()
);
comment on table pm.res_state_rules is '1119 (RES-26/28/85): home-improvement cancellation notice, deposit caps and taxability by state (Merit-published catalog; service_role writes).';

create table if not exists pm.res_catalog_items (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  code                 text not null check (char_length(code) between 1 and 60),
  name                 text not null check (char_length(name) between 1 and 200),
  description          text check (description is null or char_length(description) <= 2000),
  category             text check (category is null or char_length(category) <= 80),
  cost_code_id         uuid,
  cost_type            text not null default 'MATERIALS' check (cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  uom                  text not null default 'EA' check (char_length(uom) between 1 and 12),
  unit_cost_cents      bigint not null default 0 check (unit_cost_cents >= 0),
  waste_pct            numeric(6,4) not null default 0 check (waste_pct >= 0 and waste_pct <= 2),
  markup_pct           numeric(7,4) check (markup_pct is null or (markup_pct >= 0 and markup_pct <= 10)),
  margin_pct           numeric(6,4) check (margin_pct is null or (margin_pct >= 0 and margin_pct < 1)),
  unit_price_cents     bigint check (unit_price_cents is null or unit_price_cents >= 0),       -- sell (derived unless locked)
  price_locked         boolean not null default false,
  supplier_sku         text check (supplier_sku is null or char_length(supplier_sku) <= 80),
  vendor_id            uuid references core.vendors(id),
  supplier_url         text check (supplier_url is null or supplier_url ~ '^https?://'),
  image_url            text check (image_url is null or image_url ~ '^https?://'),
  lead_time_days       int check (lead_time_days is null or lead_time_days between 0 and 730),
  labor_rate_card_id   uuid,
  labor_hours_per_unit numeric(10,4) check (labor_hours_per_unit is null or labor_hours_per_unit >= 0),
  tax_category         text not null default 'MATERIAL' check (tax_category in ('MATERIAL','LABOR','SUBCONTRACT','DESIGN_FEE','EQUIPMENT','PERMIT_FEE','OTHER')),
  item_id              uuid,                                     -- core.items (shared Books item) — optional link
  is_active            boolean not null default true,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id),
  check (markup_pct is null or margin_pct is null),
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, labor_rate_card_id) references pm.labor_rate_cards (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_catalog_loc_idx on pm.res_catalog_items (org_id, location_id, category, code) where is_active;
comment on table pm.res_catalog_items is '1119 (RES-17): cost catalog item keyed to cost code × cost type; cost / markup masked (financials or estimates:create at the company).';

create table if not exists pm.res_assemblies (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id   uuid not null references core.locations(id),
  code          text not null check (char_length(code) between 1 and 60),
  name          text not null check (char_length(name) between 1 and 200),
  description   text check (description is null or char_length(description) <= 2000),
  uom           text not null default 'EA',
  job_type_keys text[] not null default '{}',
  is_active     boolean not null default true,
  created_by    text default pm.current_user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.res_assembly_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  assembly_id      uuid not null,
  catalog_item_id  uuid not null,
  qty_per_unit     numeric(14,4) not null default 1 check (qty_per_unit > 0),
  sort             int not null default 0,
  note             text,
  unique (org_id, id),
  foreign key (org_id, assembly_id) references pm.res_assemblies (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, catalog_item_id) references pm.res_catalog_items (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_assembly_items_idx on pm.res_assembly_items (org_id, assembly_id, sort);

-- ----------------------------------------------------------------------------
-- B. Proposals
-- ----------------------------------------------------------------------------
create table if not exists pm.res_proposals (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id            uuid not null references core.locations(id),       -- = the job's company (trigger)
  job_id                 uuid not null,
  estimate_id            uuid,                                              -- the current pm.estimates version
  lead_id                uuid references crm.leads(id),
  customer_id            uuid references core.customers(id),
  number                 text,                                              -- = the estimate number
  version                int not null default 1 check (version >= 1),
  title                  text not null check (char_length(title) between 1 and 200),
  job_type_key           text,
  contract_type          text not null default 'FIXED_PRICE' check (contract_type in
                           ('FIXED_PRICE','COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS','DESIGN_AGREEMENT','PURCHASE_AGREEMENT')),
  fee_pct                numeric(6,4) check (fee_pct is null or (fee_pct >= 0 and fee_pct <= 1)),
  fee_cents              bigint check (fee_cents is null or fee_cents >= 0),
  gmp_cents              bigint check (gmp_cents is null or gmp_cents > 0),
  savings_split_pct      numeric(6,4) check (savings_split_pct is null or (savings_split_pct >= 0 and savings_split_pct <= 1)),
  tax_contract_form      text not null default 'LUMP_SUM_IMPROVEMENT' check (tax_contract_form in ('LUMP_SUM_IMPROVEMENT','RETAIL_PLUS_INSTALL','EXEMPT')),
  tax_rate               numeric(7,6) not null default 0 check (tax_rate >= 0 and tax_rate < 0.5),
  state_code             text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  scope_narrative        text check (scope_narrative is null or char_length(scope_narrative) <= 20000),
  inclusions             text[] not null default '{}',
  exclusions             text[] not null default '{}',
  terms                  text check (terms is null or char_length(terms) <= 20000),
  cancellation_notice    text,                                              -- from res_state_rules at send
  cancel_days            int,
  deposit_pct            numeric(6,4) check (deposit_pct is null or (deposit_pct >= 0 and deposit_pct <= 1)),
  deposit_cents          bigint check (deposit_cents is null or deposit_cents >= 0),     -- fixed deposit (wins over pct)
  deposit_refundable     boolean not null default false,
  design_proposal_id     uuid,                                              -- the design agreement whose retainer is credited
  credit_to_build        boolean not null default false,                    -- on a design agreement: credit the retainer on the build contract
  retainer_credit_cents  bigint not null default 0 check (retainer_credit_cents >= 0),
  schedule_template_key  text,
  planned_start          date,
  valid_until            date,
  status                 text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','SUPERSEDED')),
  -- totals (maintained by pm._res_proposal_totals over base + selected options)
  base_price_cents       bigint not null default 0,
  options_price_cents    bigint not null default 0,
  allowance_cents        bigint not null default 0,
  contingency_cents      bigint not null default 0,
  fee_total_cents        bigint not null default 0,
  contingency_pct        numeric(6,4) check (contingency_pct is null or (contingency_pct >= 0 and contingency_pct <= 0.5)),
  tax_cents              bigint not null default 0,                         -- collected on the invoices by Books (not in the contract)
  use_tax_cents          bigint not null default 0,                         -- lump-sum improvement: contractor's tax on materials (masked)
  total_cents            bigint not null default 0,                         -- contract price (pre-tax) = the estimate total
  grand_total_cents      bigint not null default 0,                         -- what the homeowner pays: contract + tax
  cost_cents             bigint not null default 0,                         -- budget cost: pay + burden, no overhead (masked)
  overhead_cents         bigint not null default 0,                         -- overhead recovery in the labor (masked)
  deposit_due_cents      bigint not null default 0,
  sent_at                timestamptz,
  first_viewed_at        timestamptz,
  last_viewed_at         timestamptz,
  view_count             int not null default 0,
  file_id                uuid,                                              -- the proposal document (pm.doc_files)
  envelope_id            uuid,                                              -- its signature request
  signed_at              timestamptz,
  signed_by_name         text,
  sign_method            text check (sign_method is null or sign_method in ('IN_PERSON','PORTAL','EMAIL','PHONE','E_SIGNATURE')),
  accepted_at            timestamptz,
  accepted_by            text,
  declined_at            timestamptz,
  decline_reason         text,
  result                 jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),   -- what accept built
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  check ((status = 'ACCEPTED') = (accepted_at is not null) or status = 'SUPERSEDED'),
  check (contract_type <> 'COST_PLUS_GMP' or gmp_cents is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, estimate_id) references pm.estimates (org_id, id) deferrable initially immediate,
  foreign key (org_id, design_proposal_id) references pm.res_proposals (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_proposals_loc_idx on pm.res_proposals (org_id, location_id, status, updated_at desc);
create index if not exists pm_res_proposals_job_idx on pm.res_proposals (org_id, job_id);
create unique index if not exists pm_res_proposals_estimate_uidx on pm.res_proposals (org_id, estimate_id) where estimate_id is not null;
comment on table pm.res_proposals is '1119 (RES-19/26/27/29): the residential proposal over one pm.estimates number; cost / overhead masked.';

create table if not exists pm.res_proposal_options (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  proposal_id   uuid not null,
  kind          text not null default 'ADD_ON' check (kind in ('ALTERNATE','ADD_ON')),
  group_key     text check (group_key is null or group_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),   -- alternates sharing a key: pick one
  tier          text check (tier is null or tier in ('GOOD','BETTER','BEST')),
  label         text not null check (char_length(label) between 1 and 120),
  description   text check (description is null or char_length(description) <= 4000),
  image_url     text check (image_url is null or image_url ~ '^https?://'),
  is_selected   boolean not null default false,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  check (kind <> 'ALTERNATE' or group_key is not null),
  foreign key (org_id, proposal_id) references pm.res_proposals (org_id, id) on delete cascade deferrable initially immediate
);
create index if not exists pm_res_proposal_options_idx on pm.res_proposal_options (org_id, proposal_id, sort);

create table if not exists pm.res_proposal_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  proposal_id         uuid not null,
  option_id           uuid,                               -- null = base scope
  catalog_item_id     uuid,
  assembly_id         uuid,
  cost_code_id        uuid,
  cost_type           text not null default 'MATERIALS' check (cost_type in ('LABOR','MATERIALS','SUBCONTRACTOR','EQUIPMENT','OTHER')),
  room                text check (room is null or char_length(room) <= 80),
  description         text not null default '' check (char_length(description) <= 500),
  qty                 numeric(14,4) not null default 1 check (qty >= 0),
  uom                 text not null default 'EA',
  waste_pct           numeric(6,4) not null default 0 check (waste_pct >= 0 and waste_pct <= 2),
  unit_cost_cents     bigint not null default 0 check (unit_cost_cents >= 0),
  markup_pct          numeric(7,4) check (markup_pct is null or (markup_pct >= 0 and markup_pct <= 10)),
  margin_pct          numeric(6,4) check (margin_pct is null or (margin_pct >= 0 and margin_pct < 1)),
  unit_price_cents    bigint check (unit_price_cents is null or unit_price_cents >= 0),     -- explicit sell (wins)
  labor_rate_card_id  uuid,                               -- labor line: qty = hours, priced by 1108's rule
  labor_hours         numeric(14,4) check (labor_hours is null or labor_hours >= 0),
  cost_cents          bigint not null default 0,          -- extended budget cost (pay + burden for labor)
  overhead_cents      bigint not null default 0,          -- labor overhead recovery (never in the budget)
  price_cents         bigint not null default 0,          -- extended sell
  is_allowance        boolean not null default false,
  allowance_category  text check (allowance_category is null or char_length(allowance_category) <= 80),
  selection_titles    text[] not null default '{}',       -- shared allowance: one selection per title
  is_contingency      boolean not null default false,
  tax_category        text not null default 'MATERIAL' check (tax_category in ('MATERIAL','LABOR','SUBCONTRACT','DESIGN_FEE','EQUIPMENT','PERMIT_FEE','OTHER')),
  client_visible      boolean not null default true,      -- shown on the proposal document (lump-sum lines can be hidden)
  sort                int not null default 0,
  ext                 jsonb not null default '{}' check (jsonb_typeof(ext) = 'object'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, id),
  check (markup_pct is null or margin_pct is null),
  check (not is_allowance or price_cents >= 0),
  foreign key (org_id, proposal_id) references pm.res_proposals (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, option_id) references pm.res_proposal_options (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, catalog_item_id) references pm.res_catalog_items (org_id, id) deferrable initially immediate,
  foreign key (org_id, assembly_id) references pm.res_assemblies (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, labor_rate_card_id) references pm.labor_rate_cards (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_proposal_lines_idx on pm.res_proposal_lines (org_id, proposal_id, option_id, sort);

create table if not exists pm.res_proposal_snapshots (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  proposal_id   uuid not null,
  version       int not null,
  estimate_id   uuid,
  total_cents   bigint not null,
  body          jsonb not null check (jsonb_typeof(body) = 'object'),     -- header, options, lines (sell), payment schedule
  sent_at       timestamptz not null default now(),
  sent_by       text default pm.current_user_id(),
  unique (org_id, id),
  unique (org_id, proposal_id, version),
  foreign key (org_id, proposal_id) references pm.res_proposals (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_payment_schedule (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  proposal_id          uuid,
  seq                  int not null check (seq >= 1),
  label                text not null check (char_length(label) between 1 and 120),
  kind                 text not null default 'MILESTONE' check (kind in ('DEPOSIT','MILESTONE','FINAL')),
  pct                  numeric(7,6) check (pct is null or (pct > 0 and pct <= 1)),
  amount_cents         bigint check (amount_cents is null or amount_cents >= 0),     -- pinned at accept
  added_cents          bigint not null default 0,                                     -- overages added "with the next milestone"
  trigger_ref          text check (trigger_ref is null or trigger_ref ~ '^[a-z0-9_]{1,48}$'),   -- schedule template ref (e.g. cabinets)
  task_id              uuid,                       -- the schedule task whose completion triggers it
  billing_task_id      uuid,                       -- the 0-day billing milestone after it
  requires_photo       boolean not null default false,
  requires_checklist   boolean not null default false,
  status               text not null default 'PLANNED' check (status in ('PLANNED','SCHEDULED','HELD','DRAFTED','BILLED','VOID')),
  hold_reason          text,
  billing_request_id   uuid,
  deposit_request_id   uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  check (pct is not null or amount_cents is not null),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, proposal_id) references pm.res_proposals (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) on delete set null deferrable initially immediate,
  foreign key (org_id, billing_task_id) references pm.tasks (org_id, id) on delete set null deferrable initially immediate
);
create index if not exists pm_res_payment_schedule_job_idx on pm.res_payment_schedule (org_id, job_id, seq);
create unique index if not exists pm_res_payment_schedule_seq_uidx on pm.res_payment_schedule (org_id, proposal_id, seq) where proposal_id is not null;

create table if not exists pm.res_job_terms (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  proposal_id          uuid,
  contract_type        text not null check (contract_type in
                         ('FIXED_PRICE','COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS','DESIGN_AGREEMENT','PURCHASE_AGREEMENT')),
  fee_pct              numeric(6,4),
  fee_cents            bigint,
  gmp_cents            bigint,
  savings_split_pct    numeric(6,4),
  tax_contract_form    text not null default 'LUMP_SUM_IMPROVEMENT' check (tax_contract_form in ('LUMP_SUM_IMPROVEMENT','RETAIL_PLUS_INSTALL','EXEMPT')),
  tax_rate             numeric(7,6) not null default 0,
  state_code           text,
  deposit_apply_mode   text not null default 'PRO_RATA' check (deposit_apply_mode in ('PRO_RATA','AT_FINAL')),
  overage_billing      text not null default 'UPFRONT' check (overage_billing in ('UPFRONT','NEXT_MILESTONE')),
  open_book            boolean not null default false,
  retainer_credit_cents bigint not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
comment on table pm.res_job_terms is '1119 (RES-27/85): the contract form on a sold job — drives billing (cost-plus fee, deposit application), tax and open-book visibility.';

-- ----------------------------------------------------------------------------
-- C. Selections & allowances (additive on 1106 / 1102)
-- ----------------------------------------------------------------------------
alter table pm.selections add column if not exists room text;
alter table pm.selections add column if not exists install_task_id uuid;
alter table pm.selections add column if not exists lead_time_days int;
alter table pm.selections add column if not exists buffer_days int;
alter table pm.selections add column if not exists needed_by_on date;
alter table pm.selections add column if not exists deadline_source text not null default 'MANUAL';
alter table pm.selections add column if not exists at_risk boolean not null default false;
alter table pm.selections add column if not exists reminder_sent_at timestamptz;
alter table pm.selections add column if not exists reminder_count int not null default 0;
alter table pm.selections add column if not exists parent_selection_id uuid;     -- dependent selection (tile → grout)
alter table pm.selections add column if not exists client_visible boolean not null default true;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'selections_res_deadline_chk' and conrelid = 'pm.selections'::regclass) then
    alter table pm.selections add constraint selections_res_deadline_chk check (
      deadline_source in ('MANUAL','SCHEDULE') and (lead_time_days is null or lead_time_days between 0 and 730)
      and (buffer_days is null or buffer_days between 0 and 120) and reminder_count >= 0 and (room is null or char_length(room) <= 80));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'selections_res_install_task_fk' and conrelid = 'pm.selections'::regclass) then
    alter table pm.selections add constraint selections_res_install_task_fk
      foreign key (org_id, install_task_id) references pm.tasks (org_id, id) on delete set null deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'selections_res_parent_fk' and conrelid = 'pm.selections'::regclass) then
    alter table pm.selections add constraint selections_res_parent_fk
      foreign key (org_id, parent_selection_id) references pm.selections (org_id, id) on delete set null deferrable initially immediate;
  end if;
end $$;

alter table pm.selection_options add column if not exists image_url text;
alter table pm.selection_options add column if not exists finish text;
alter table pm.selection_options add column if not exists spec_document_id uuid references public.documents(id) on delete set null;
alter table pm.selection_options add column if not exists vendor_url text;
alter table pm.selection_options add column if not exists vendor_deposit_pct numeric(5,4);
alter table pm.selection_options add column if not exists client_visible boolean not null default true;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'selection_options_res_chk' and conrelid = 'pm.selection_options'::regclass) then
    alter table pm.selection_options add constraint selection_options_res_chk check (
      (image_url is null or image_url ~ '^https?://') and (vendor_url is null or vendor_url ~ '^https?://')
      and (finish is null or char_length(finish) <= 120)
      and (vendor_deposit_pct is null or (vendor_deposit_pct > 0 and vendor_deposit_pct <= 1)));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- D. Change orders (additive on 1100) + lines
-- ----------------------------------------------------------------------------
alter table pm.change_orders add column if not exists co_type text not null default 'CLIENT';
alter table pm.change_orders add column if not exists initiated_by text;
alter table pm.change_orders add column if not exists reason_code text;
alter table pm.change_orders add column if not exists stop_work boolean not null default false;
alter table pm.change_orders add column if not exists emergency boolean not null default false;
alter table pm.change_orders add column if not exists contract_clause text;
alter table pm.change_orders add column if not exists evidence_document_ids uuid[] not null default '{}';
alter table pm.change_orders add column if not exists voice_document_id uuid;
alter table pm.change_orders add column if not exists transcript text;
alter table pm.change_orders add column if not exists area text;
alter table pm.change_orders add column if not exists allowance_id uuid;
alter table pm.change_orders add column if not exists selection_id uuid;
alter table pm.change_orders add column if not exists requested_at timestamptz;
alter table pm.change_orders add column if not exists priced_at timestamptz;
alter table pm.change_orders add column if not exists sent_at timestamptz;
alter table pm.change_orders add column if not exists signed_at timestamptz;
alter table pm.change_orders add column if not exists signer_name text;
alter table pm.change_orders add column if not exists client_approval_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'change_orders_res_chk' and conrelid = 'pm.change_orders'::regclass) then
    alter table pm.change_orders add constraint change_orders_res_chk check (
      co_type in ('CLIENT','FIELD_REQUEST','DEMO_DISCOVERY','ALLOWANCE','NO_CHARGE')
      and (initiated_by is null or initiated_by in ('CLIENT','BUILDER','FIELD'))
      and (reason_code is null or reason_code in ('CLIENT_REQUEST','HIDDEN_CONDITION','CODE_REQUIRED','DESIGN_CHANGE','ALLOWANCE_OVERAGE',
                                                   'ALLOWANCE_CREDIT','BUILDER_ERROR','GOODWILL','VENDOR_ERROR','DAMAGE','OTHER'))
      and (co_type <> 'NO_CHARGE' or amount_cents = 0)
      and (transcript is null or char_length(transcript) <= 8000) and (area is null or char_length(area) <= 120));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'change_orders_res_allowance_fk' and conrelid = 'pm.change_orders'::regclass) then
    alter table pm.change_orders add constraint change_orders_res_allowance_fk
      foreign key (org_id, allowance_id) references pm.allowances (org_id, id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'change_orders_res_selection_fk' and conrelid = 'pm.change_orders'::regclass) then
    alter table pm.change_orders add constraint change_orders_res_selection_fk
      foreign key (org_id, selection_id) references pm.selections (org_id, id) deferrable initially immediate;
  end if;
end $$;
create index if not exists pm_change_orders_res_open_idx on pm.change_orders (org_id, job_id, co_type) where stage in ('PCO','COR');

create table if not exists pm.res_change_order_lines (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  change_order_id   uuid not null,
  catalog_item_id   uuid,
  cost_code_id      uuid,
  description       text not null check (char_length(description) between 1 and 500),
  qty               numeric(14,4) not null default 1 check (qty >= 0),
  uom               text not null default 'EA',
  unit_cost_cents   bigint not null default 0 check (unit_cost_cents >= 0),
  markup_pct        numeric(7,4) check (markup_pct is null or (markup_pct >= 0 and markup_pct <= 10)),
  cost_cents        bigint not null default 0,
  price_cents       bigint not null default 0,
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, change_order_id) references pm.change_orders (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate,
  foreign key (org_id, catalog_item_id) references pm.res_catalog_items (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_co_lines_idx on pm.res_change_order_lines (org_id, change_order_id, sort);

-- ----------------------------------------------------------------------------
-- E. Trade partners: schedule confirmations, bids, PO acceptance, vendor deposits, invoices
-- ----------------------------------------------------------------------------
create table if not exists pm.res_task_trades (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  task_id           uuid not null,
  vendor_id         uuid not null references core.vendors(id),
  contact_id        uuid references core.contacts(id),
  status            text not null default 'ASSIGNED' check (status in ('ASSIGNED','NOTIFIED','CONFIRMED','DECLINED','PROPOSED','CANCELLED')),
  start_on          date,                                   -- the date the trade was asked for
  proposed_on       date,
  response_note     text check (response_note is null or char_length(response_note) <= 1000),
  token_hash        text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at  timestamptz,
  notified_at       timestamptz,
  responded_at      timestamptz,
  reminders         int not null default 0,
  message_id        uuid,
  created_by        text default pm.current_user_id(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_res_task_trades_open_uidx on pm.res_task_trades (org_id, task_id, vendor_id) where status <> 'CANCELLED';
create unique index if not exists pm_res_task_trades_token_uidx on pm.res_task_trades (token_hash) where token_hash is not null;

create table if not exists pm.res_bid_packages (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  number         text,
  title          text not null check (char_length(title) between 1 and 200),
  scope          text check (scope is null or char_length(scope) <= 20000),
  cost_code_id   uuid,
  due_at         timestamptz,
  status         text not null default 'DRAFT' check (status in ('DRAFT','OUT','LEVELING','AWARDED','CANCELLED')),
  document_ids   uuid[] not null default '{}',
  awarded_invite_id uuid,
  commitment_id  uuid,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_bid_package_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  package_id          uuid not null,
  cost_code_id        uuid,
  description         text not null check (char_length(description) between 1 and 500),
  qty                 numeric(14,4) not null default 1 check (qty > 0),
  uom                 text not null default 'LS',
  budget_cents        bigint check (budget_cents is null or budget_cents >= 0),
  sort                int not null default 0,
  unique (org_id, id),
  foreign key (org_id, package_id) references pm.res_bid_packages (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_bid_invites (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  package_id        uuid not null,
  vendor_id         uuid not null references core.vendors(id),
  contact_id        uuid references core.contacts(id),
  status            text not null default 'INVITED' check (status in ('INVITED','VIEWED','SUBMITTED','DECLINED','AWARDED','NOT_AWARDED')),
  token_hash        text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at  timestamptz,
  exclusions        text check (exclusions is null or char_length(exclusions) <= 4000),
  notes             text check (notes is null or char_length(notes) <= 4000),
  total_cents       bigint,
  submitted_at      timestamptz,
  invited_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, package_id, vendor_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, package_id) references pm.res_bid_packages (org_id, id) on delete cascade deferrable initially immediate
);
create unique index if not exists pm_res_bid_invites_token_uidx on pm.res_bid_invites (token_hash) where token_hash is not null;

create table if not exists pm.res_bid_prices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  invite_id     uuid not null,
  line_id       uuid not null,
  included      boolean not null default true,
  amount_cents  bigint check (amount_cents is null or amount_cents >= 0),
  note          text check (note is null or char_length(note) <= 1000),
  unique (org_id, id),
  unique (org_id, invite_id, line_id),
  foreign key (org_id, invite_id) references pm.res_bid_invites (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, line_id) references pm.res_bid_package_lines (org_id, id) on delete cascade deferrable initially immediate
);

-- Rate counters for the no-account trade links (the 1117 fs_rate_counters pattern): fixed hourly
-- windows per bucket (link, hashed client address, failed lookups); no org_id, no member grants —
-- written only by the public token functions. Expired windows are swept on every hit.
create table if not exists pm.res_rate_counters (
  bucket        text not null check (char_length(bucket) between 3 and 200),
  window_start  timestamptz not null,
  expires_at    timestamptz not null,
  hits          int not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
create index if not exists pm_res_rate_counters_expiry_idx on pm.res_rate_counters (expires_at);

-- PO / work-order acceptance by the trade (no account; one-time link)
alter table pm.commitments add column if not exists trade_accept_token_hash text;
alter table pm.commitments add column if not exists trade_accepted_at timestamptz;
alter table pm.commitments add column if not exists trade_accepted_name text;
alter table pm.commitments add column if not exists release_stage text;
alter table pm.commitments add column if not exists lot_id uuid;
alter table pm.commitments add column if not exists vpo_reason text;
alter table pm.commitments add column if not exists trade_accept_expires_at timestamptz;
create unique index if not exists pm_commitments_trade_token_uidx on pm.commitments (trade_accept_token_hash) where trade_accept_token_hash is not null;

create table if not exists pm.res_vendor_deposits (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid not null,
  commitment_id         uuid not null,
  vendor_id             uuid references core.vendors(id),
  selection_id          uuid,
  pct                   numeric(5,4) check (pct is null or (pct > 0 and pct <= 1)),
  amount_cents          bigint not null check (amount_cents > 0),
  status                text not null default 'REQUESTED' check (status in ('REQUESTED','APPROVED','PAID','RELIEVED','VOID')),
  requested_on          date not null default current_date,
  approved_at           timestamptz,
  paid_on               date,
  payment_ref           text,
  expected_delivery_on  date,
  delivered_on          date,
  relieved_at           timestamptz,
  memo                  text,
  created_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_vendor_deposits_job_idx on pm.res_vendor_deposits (org_id, job_id, status);

create table if not exists pm.res_trade_invoices (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id           uuid not null,
  commitment_id    uuid not null,
  vendor_id        uuid references core.vendors(id),
  invoice_number   text not null check (char_length(invoice_number) between 1 and 60),
  invoice_date     date not null default current_date,
  amount_cents     bigint not null check (amount_cents > 0),
  document_id      uuid references public.documents(id) on delete set null,
  source           text not null default 'OFFICE' check (source in ('PORTAL','OFFICE','EMAIL','PHOTO')),
  status           text not null default 'SUBMITTED' check (status in ('SUBMITTED','MATCHED','VARIANCE','APPROVED','HELD','REJECTED')),
  variances        jsonb not null default '[]' check (jsonb_typeof(variances) = 'array'),
  hold_reasons     text[] not null default '{}',
  entered_by       text,                       -- who keyed / accepted it (the preparer; never its approver)
  variance_change_ids uuid[] not null default '{}',   -- commitment changes that carry an accepted overage (1113 engine)
  approved_by      text,
  approved_at      timestamptz,
  approval_reason  text,
  rejected_reason  text,
  created_by       text default pm.current_user_id(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, vendor_id, invoice_number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_trade_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  invoice_id          uuid not null,
  commitment_line_id  uuid,
  description         text not null default '',
  qty                 numeric(14,4),
  unit_cost_cents     bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  amount_cents        bigint not null check (amount_cents >= 0),
  unique (org_id, id),
  foreign key (org_id, invoice_id) references pm.res_trade_invoices (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, commitment_line_id) references pm.commitment_lines (org_id, id) deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- G. Home builder: land → community → phase → lot; plans, options, price agreements
-- ----------------------------------------------------------------------------
create table if not exists pm.res_communities (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  code            text not null check (char_length(code) between 1 and 24),
  name            text not null check (char_length(name) between 1 and 120),
  land_parcel     text check (land_parcel is null or char_length(land_parcel) <= 200),
  city            text, state text, zip text,
  hoa_name        text,
  hoa_rules       text check (hoa_rules is null or char_length(hoa_rules) <= 8000),
  status          text not null default 'ACTIVE' check (status in ('PLANNING','ACTIVE','SOLD_OUT','CLOSED')),
  plat_document_id uuid references public.documents(id) on delete set null,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.res_community_phases (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  community_id  uuid not null,
  name          text not null check (char_length(name) between 1 and 80),
  sort          int not null default 0,
  status        text not null default 'PLANNED' check (status in ('PLANNED','IN_DEVELOPMENT','RELEASED','SOLD_OUT')),
  unique (org_id, id),
  foreign key (org_id, community_id) references pm.res_communities (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_plans (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  code                 text not null check (char_length(code) between 1 and 24),
  name                 text not null check (char_length(name) between 1 and 120),
  beds                 numeric(3,1), baths numeric(3,1), sqft int, garage_stalls int,
  base_cost_cents      bigint check (base_cost_cents is null or base_cost_cents >= 0),     -- masked
  target_margin_pct    numeric(6,4) check (target_margin_pct is null or (target_margin_pct >= 0 and target_margin_pct < 1)),  -- masked
  standard_cycle_days  int check (standard_cycle_days is null or standard_cycle_days between 1 and 1000),
  schedule_template_key text,
  job_type_key         text,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.res_elevations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  plan_id        uuid not null,
  code           text not null check (char_length(code) between 1 and 12),
  name           text not null,
  premium_cents  bigint not null default 0 check (premium_cents >= 0),
  unique (org_id, id),
  unique (org_id, plan_id, code),
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_plan_prices (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  plan_id           uuid not null,
  community_id      uuid,
  base_price_cents  bigint not null check (base_price_cents > 0),
  effective_from    date not null default current_date,
  effective_to      date,
  unique (org_id, id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, community_id) references pm.res_communities (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_options (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  code               text not null check (char_length(code) between 1 and 40),
  name               text not null check (char_length(name) between 1 and 200),
  category           text check (category is null or char_length(category) <= 80),
  cutoff_stage       text not null default 'PRE_DRYWALL' check (cutoff_stage in ('PRE_START','PRE_FRAME','PRE_DRYWALL','PRE_TRIM','ANYTIME')),
  is_structural      boolean not null default false,
  plan_ids           uuid[],                    -- null = every plan
  requires           uuid[] not null default '{}',
  excludes           uuid[] not null default '{}',
  cost_cents         bigint check (cost_cents is null or cost_cents >= 0),     -- masked
  add_tasks          jsonb not null default '[]' check (jsonb_typeof(add_tasks) = 'array'),   -- [{title, duration, after_ref}]
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, location_id, code),
  unique (org_id, id)
);

create table if not exists pm.res_option_prices (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  option_id       uuid not null,
  community_id    uuid,
  plan_id         uuid,
  price_cents     bigint not null check (price_cents >= 0),
  effective_from  date not null default current_date,
  effective_to    date,
  unique (org_id, id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (org_id, option_id) references pm.res_options (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, community_id) references pm.res_communities (org_id, id) deferrable initially immediate,
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_lots (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id),
  community_id      uuid not null,
  phase_id          uuid,
  lot_number        text not null check (char_length(lot_number) between 1 and 24),
  block             text,
  address_line1     text,
  status            text not null default 'RAW' check (status in ('RAW','DEVELOPED','AVAILABLE','HELD','SOLD','STARTED','COMPLETE','CLOSED')),
  premium_cents     bigint not null default 0 check (premium_cents >= 0),
  land_cost_cents   bigint check (land_cost_cents is null or land_cost_cents >= 0),   -- masked
  setbacks          jsonb not null default '{}' check (jsonb_typeof(setbacks) = 'object'),
  swing             text check (swing is null or swing in ('LEFT','RIGHT','EITHER')),
  hoa_rules         text,
  plat_geometry     jsonb check (plat_geometry is null or jsonb_typeof(plat_geometry) in ('object','array')),
  plan_id           uuid,
  elevation_id      uuid,
  job_id            uuid,
  is_spec           boolean not null default false,
  list_price_cents  bigint check (list_price_cents is null or list_price_cents >= 0),
  incentives_cents  bigint not null default 0 check (incentives_cents >= 0),
  listed_on         date,
  held_until        date,
  held_for          text,
  started_on        date,
  completed_on      date,
  closed_on         date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, community_id, lot_number, block),
  foreign key (org_id, community_id) references pm.res_communities (org_id, id) deferrable initially immediate,
  foreign key (org_id, phase_id) references pm.res_community_phases (org_id, id) deferrable initially immediate,
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) deferrable initially immediate,
  foreign key (org_id, elevation_id) references pm.res_elevations (org_id, id) deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_lots_community_idx on pm.res_lots (org_id, community_id, status);
create unique index if not exists pm_res_lots_job_uidx on pm.res_lots (org_id, job_id) where job_id is not null;

create table if not exists pm.res_price_agreements (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  vendor_id        uuid not null references core.vendors(id),
  plan_id          uuid,
  elevation_id     uuid,
  option_id        uuid,
  community_id     uuid,
  cost_code_id     uuid,
  scope            text not null check (char_length(scope) between 1 and 300),
  amount_cents     bigint not null check (amount_cents >= 0),
  release_stage    text not null default 'START' check (release_stage in ('START','FOUNDATION','FRAME','MECHANICAL','DRYWALL','TRIM','FINAL')),
  effective_from   date not null default current_date,
  effective_to     date,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check (plan_id is not null or option_id is not null),
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) deferrable initially immediate,
  foreign key (org_id, elevation_id) references pm.res_elevations (org_id, id) deferrable initially immediate,
  foreign key (org_id, option_id) references pm.res_options (org_id, id) deferrable initially immediate,
  foreign key (org_id, community_id) references pm.res_communities (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_purchase_agreements (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id),
  lot_id               uuid not null,
  job_id               uuid,
  customer_id          uuid references core.customers(id),
  number               text,
  plan_id              uuid not null,
  elevation_id         uuid,
  base_price_cents     bigint not null default 0,
  elevation_cents      bigint not null default 0,
  lot_premium_cents    bigint not null default 0,
  options_cents        bigint not null default 0,
  incentives_cents     bigint not null default 0,
  fees_cents           bigint not null default 0,
  total_cents          bigint not null default 0,
  earnest_money_cents  bigint not null default 0 check (earnest_money_cents >= 0),
  earnest_in_escrow    boolean not null default true,
  contingencies        jsonb not null default '[]' check (jsonb_typeof(contingencies) = 'array'),  -- [{kind, due_on, status}]
  status               text not null default 'DRAFT' check (status in ('DRAFT','SIGNED','CANCELLED','CLOSED')),
  signed_at            timestamptz,
  signed_by_name       text,
  deposit_request_id   uuid,
  cancelled_at         timestamptz,
  cancel_reason        text,
  created_by           text default pm.current_user_id(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, lot_id) references pm.res_lots (org_id, id) deferrable initially immediate,
  foreign key (org_id, plan_id) references pm.res_plans (org_id, id) deferrable initially immediate,
  foreign key (org_id, elevation_id) references pm.res_elevations (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_res_pa_open_lot_uidx on pm.res_purchase_agreements (org_id, lot_id) where status in ('DRAFT','SIGNED');

create table if not exists pm.res_pa_options (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  agreement_id   uuid not null,
  option_id      uuid not null,
  qty            numeric(10,2) not null default 1 check (qty > 0),
  price_cents    bigint not null,
  addendum_id    uuid,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','REMOVED')),
  added_at       timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, agreement_id) references pm.res_purchase_agreements (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, option_id) references pm.res_options (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_res_pa_options_active_uidx on pm.res_pa_options (org_id, agreement_id, option_id) where status = 'ACTIVE';

create table if not exists pm.res_pa_addenda (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  agreement_id   uuid not null,
  seq            int not null check (seq >= 1),
  kind           text not null default 'OPTIONS' check (kind in ('OPTIONS','PRICE','CONTINGENCY','OTHER')),
  change_cents   bigint not null default 0,
  late_fee_cents bigint not null default 0,
  lines          jsonb not null default '[]' check (jsonb_typeof(lines) = 'array'),
  status         text not null default 'DRAFT' check (status in ('DRAFT','SIGNED','VOID')),
  signed_at      timestamptz,
  signed_by_name text,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, agreement_id, seq),
  foreign key (org_id, agreement_id) references pm.res_purchase_agreements (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_start_package_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id              uuid not null,
  lot_id              uuid not null,
  price_agreement_id  uuid,
  option_id           uuid,
  vendor_id           uuid references core.vendors(id),
  release_stage       text not null,
  scope               text not null,
  amount_cents        bigint not null,
  commitment_id       uuid,
  status              text not null default 'HELD' check (status in ('HELD','RELEASED','VOID')),
  released_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, lot_id) references pm.res_lots (org_id, id) deferrable initially immediate,
  foreign key (org_id, commitment_id) references pm.commitments (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_res_spi_agreement_uidx on pm.res_start_package_items (org_id, lot_id, price_agreement_id) where status <> 'VOID';

create table if not exists pm.res_vpos (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                 uuid not null,
  lot_id                 uuid,
  number                 text,
  vendor_id              uuid not null references core.vendors(id),
  reason_code            text not null check (reason_code in ('BUILDER_ERROR','FIELD_CHANGE','VENDOR_ERROR','DESIGN_CHANGE','DAMAGE_THEFT','OTHER')),
  chargeback_vendor_id   uuid references core.vendors(id),
  description            text not null check (char_length(description) between 1 and 1000),
  cost_code_id           uuid,
  amount_cents           bigint not null check (amount_cents > 0),
  submitted_by_trade     boolean not null default false,
  status                 text not null default 'REQUESTED' check (status in ('REQUESTED','APPROVED','REJECTED','VOID')),
  commitment_id          uuid,
  evidence_document_ids  uuid[] not null default '{}',
  created_by             text default pm.current_user_id(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, cost_code_id) references pm.cost_codes (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_vpos_job_idx on pm.res_vpos (org_id, job_id, reason_code);

create table if not exists pm.res_closings (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  lot_id               uuid,
  scheduled_on         date,
  title_company        text,
  checklist            jsonb not null default '[]' check (jsonb_typeof(checklist) = 'array'),   -- manual items [{key,label,done,done_at}]
  settlement           jsonb not null default '{}' check (jsonb_typeof(settlement) = 'object'),  -- {sale_price_cents, concessions_cents, commissions_cents, loan_payoff_cents, ...}
  settlement_document_id uuid references public.documents(id) on delete set null,
  status               text not null default 'OPEN' check (status in ('OPEN','READY','CLOSED','CANCELLED')),
  closed_on            date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

-- ----------------------------------------------------------------------------
-- H. Field, remodeler and closeout records (job class J)
-- ----------------------------------------------------------------------------
create table if not exists pm.res_home_profiles (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                uuid not null,
  occupied              boolean not null default true,
  year_built            int check (year_built is null or year_built between 1600 and 2100),
  lockbox_code          text check (lockbox_code is null or char_length(lockbox_code) <= 40),
  alarm_code            text check (alarm_code is null or char_length(alarm_code) <= 40),
  garage_code           text check (garage_code is null or char_length(garage_code) <= 40),
  gate_code             text check (gate_code is null or char_length(gate_code) <= 40),
  pets                  text check (pets is null or char_length(pets) <= 500),
  children              text check (children is null or char_length(children) <= 500),
  work_hours            text check (work_hours is null or char_length(work_hours) <= 200),
  parking               text check (parking is null or char_length(parking) <= 500),
  off_limits            text check (off_limits is null or char_length(off_limits) <= 500),
  utility_notice        text check (utility_notice is null or char_length(utility_notice) <= 500),
  temp_kitchen          text check (temp_kitchen is null or char_length(temp_kitchen) <= 500),
  bathroom_for_crew     text check (bathroom_for_crew is null or char_length(bathroom_for_crew) <= 200),
  notes                 text check (notes is null or char_length(notes) <= 4000),
  rrp_required          boolean generated always as (year_built is not null and year_built < 1978) stored,
  asbestos_suspect      boolean not null default false,
  mold_suspect          boolean not null default false,
  updated_by            text default pm.current_user_id(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
comment on table pm.res_home_profiles is '1119 (RES-115): occupied-home rules shown on the field app every day (access codes, pets, hours, parking, off-limits rooms, utility notice, temporary kitchen).';

create table if not exists pm.res_household_members (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  contact_id      uuid references core.contacts(id),
  name            text not null check (char_length(name) between 1 and 200),
  email           text check (email is null or char_length(email) <= 254),
  phone           text check (phone is null or char_length(phone) <= 40),
  relation        text not null default 'OWNER' check (relation in ('OWNER','SPOUSE','FAMILY','ARCHITECT','DESIGNER','REALTOR','LENDER','PROPERTY_MANAGER','OTHER')),
  can_sign        boolean not null default false,
  can_pay         boolean not null default false,
  sees_money      boolean not null default true,
  notify_sms      boolean not null default true,
  notify_email    boolean not null default true,
  portal_status   text not null default 'PENDING_INVITE' check (portal_status in ('PENDING_INVITE','INVITED','ACTIVE','REVOKED','NONE')),
  invited_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_res_household_contact_uidx on pm.res_household_members (org_id, job_id, contact_id) where contact_id is not null;

create table if not exists pm.res_protection_checks (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id               uuid not null,
  kind                 text not null check (kind in ('DAY1_CONTAINMENT','DAILY_CLEANUP','PROTECTION_REMOVAL')),
  check_date           date not null default current_date,
  items                jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),   -- [{key, label, done}]
  photo_document_ids   uuid[] not null default '{}',
  status               text not null default 'OPEN' check (status in ('OPEN','PASSED','FAILED')),
  completed_by         text,
  completed_at         timestamptz,
  note                 text check (note is null or char_length(note) <= 2000),
  created_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, kind, check_date),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_rrp_records (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id                       uuid not null,
  required                     boolean not null default true,
  renovator_employee_id        uuid references core.employees(id),
  renovator_name               text,
  renovator_cert_number        text,
  renovator_cert_expires_on    date,
  firm_cert_number             text,
  pamphlet_ack_name            text,
  pamphlet_ack_at              timestamptz,
  pamphlet_ack_document_id     uuid references public.documents(id) on delete set null,
  containment_verified_at      timestamptz,
  containment_photo_ids        uuid[] not null default '{}',
  cleaning_verified_at         timestamptz,
  cleaning_card_result         text check (cleaning_card_result is null or cleaning_card_result in ('PASS','FAIL','RECLEAN_PASS')),
  asbestos_test                text not null default 'NOT_TESTED' check (asbestos_test in ('NOT_TESTED','NEGATIVE','POSITIVE','PRESUMED')),
  mold_test                    text not null default 'NOT_TESTED' check (mold_test in ('NOT_TESTED','NEGATIVE','POSITIVE','PRESUMED')),
  retain_until                 date,
  status                       text not null default 'OPEN' check (status in ('OPEN','COMPLETE','NOT_REQUIRED')),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
comment on table pm.res_rrp_records is '1119 (RES-117): EPA RRP lead-safe record for a pre-1978 home — renovator, pamphlet acknowledgment, containment + cleaning verification; kept 3 years after completion.';

create table if not exists pm.res_permits (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  kind          text not null check (kind in ('BUILDING','ELECTRICAL','PLUMBING','MECHANICAL','DEMOLITION','HOA','ARCHITECTURAL','ZONING',
                                              'NEIGHBOR_NOTICE','DUMPSTER','PORTABLE_TOILET','OTHER')),
  number        text check (number is null or char_length(number) <= 60),
  authority     text check (authority is null or char_length(authority) <= 200),
  status        text not null default 'NOT_STARTED' check (status in ('NOT_STARTED','APPLIED','ISSUED','APPROVED','DENIED','EXPIRED','CLOSED',
                                                                       'ORDERED','DELIVERED','REMOVED','SENT')),
  applied_on    date, issued_on date, expires_on date,
  delivered_on  date, removal_on date, removed_on date,
  vendor_id     uuid references core.vendors(id),
  fee_cents     bigint check (fee_cents is null or fee_cents >= 0),
  document_id   uuid references public.documents(id) on delete set null,
  notes         text check (notes is null or char_length(notes) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_res_permits_job_idx on pm.res_permits (org_id, job_id, kind);

create table if not exists pm.res_inspections (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id         uuid not null,
  permit_id      uuid,
  kind           text not null check (kind in ('FOOTING','FOUNDATION','FRAMING','MEP_ROUGH','INSULATION','DRYWALL','FINAL','OTHER')),
  task_id        uuid,                        -- the schedule task the result gates
  requested_on   date not null default current_date,
  scheduled_on   date,
  result         text not null default 'PENDING' check (result in ('PENDING','PASS','FAIL','PARTIAL','CANCELLED')),
  result_on      date,
  inspector      text,
  notes          text check (notes is null or char_length(notes) <= 2000),
  reinspect_of   uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, permit_id) references pm.res_permits (org_id, id) deferrable initially immediate,
  foreign key (org_id, task_id) references pm.tasks (org_id, id) on delete set null deferrable initially immediate
);

create table if not exists pm.res_chains (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id        uuid not null,
  kind          text not null default 'CABINET_COUNTER' check (kind in ('CABINET_COUNTER','WINDOWS','CUSTOM')),
  name          text not null default 'Cabinets and countertops',
  status        text not null default 'ACTIVE' check (status in ('ACTIVE','DONE','CANCELLED')),
  created_at    timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);

create table if not exists pm.res_chain_steps (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  chain_id          uuid not null,
  seq               int not null check (seq >= 1),
  step_key          text not null check (step_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label             text not null,
  vendor_id         uuid references core.vendors(id),
  commitment_id     uuid,
  task_id           uuid,
  lead_days         int not null default 0 check (lead_days between 0 and 365),
  planned_on        date,
  actual_on         date,
  status            text not null default 'PENDING' check (status in ('PENDING','SCHEDULED','DONE','SKIPPED')),
  homeowner_visible boolean not null default true,
  homeowner_label   text,
  unique (org_id, id),
  unique (org_id, chain_id, seq),
  foreign key (org_id, chain_id) references pm.res_chains (org_id, id) on delete cascade deferrable initially immediate
);

create table if not exists pm.res_walks (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id            uuid not null,
  kind              text not null check (kind in ('FINAL_WALKTHROUGH','ORIENTATION','WARRANTY_30','WARRANTY_11M','WARRANTY_2Y','CUSTOM')),
  due_on            date,
  scheduled_at      timestamptz,
  status            text not null default 'PLANNED' check (status in ('PLANNED','SCHEDULED','DONE','SKIPPED')),
  items             jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),  -- [{title, location, trade_vendor_id}]
  punch_created     int not null default 0,
  accepted_by_name  text,
  accepted_at       timestamptz,
  signature_document_id uuid references public.documents(id) on delete set null,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_res_walks_kind_uidx on pm.res_walks (org_id, job_id, kind) where kind <> 'CUSTOM';

-- ----------------------------------------------------------------------------
-- 1. Shared triggers
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['res_settings','res_catalog_items','res_assemblies','res_proposals','res_proposal_lines','res_payment_schedule',
    'res_job_terms','res_task_trades','res_bid_packages','res_vendor_deposits','res_trade_invoices','res_communities','res_plans','res_options',
    'res_lots','res_purchase_agreements','res_vpos','res_closings','res_home_profiles','res_household_members','res_rrp_records','res_permits',
    'res_inspections','res_walks'] loop
    execute format('drop trigger if exists trg_touch_updated_at on pm.%I', t);
    execute format('create trigger trg_touch_updated_at before update on pm.%I for each row execute function pm.tg_touch_updated_at()', t);
  end loop;
  foreach t in array array['res_settings','res_catalog_items','res_assemblies','res_communities','res_plans','res_options','res_lots',
    'res_price_agreements','res_purchase_agreements'] loop
    execute format('drop trigger if exists trg_location_in_org on pm.%I', t);
    execute format('create trigger trg_location_in_org before insert or update of location_id, org_id on pm.%I for each row execute function pm.tg_location_in_org()', t);
  end loop;
end $$;

-- Proposal: company = the job's company; customer = the job's customer; number = the estimate's.
create or replace function pm.tg_res_proposal_defaults() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_loc uuid; v_cust uuid;
begin
  select j.location_id, j.customer_id into v_loc, v_cust from core.jobs j where j.org_id = new.org_id and j.id = new.job_id;
  if v_loc is null then raise exception 'PM_UNKNOWN_JOB: job % not in org', new.job_id using errcode = '23503'; end if;
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    raise exception 'PM_RES_PROPOSAL_JOB_FIXED: a proposal cannot move between jobs' using errcode = '42501';
  end if;
  new.location_id := v_loc;
  new.customer_id := coalesce(new.customer_id, v_cust);
  if new.estimate_id is not null then
    select e.number into new.number from pm.estimates e where e.org_id = new.org_id and e.id = new.estimate_id;
  end if;
  -- members edit the content of a DRAFT only; status / totals / signature move through the functions
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') then
    if old.status <> 'DRAFT' then
      raise exception 'PM_RES_PROPOSAL_LOCKED: a % proposal cannot be edited (revise it)', lower(old.status) using errcode = '55000';
    end if;
    if new.status is distinct from old.status or new.estimate_id is distinct from old.estimate_id or new.total_cents is distinct from old.total_cents
       or new.accepted_at is distinct from old.accepted_at or new.signed_at is distinct from old.signed_at or new.result is distinct from old.result
       or new.version is distinct from old.version or new.cost_cents is distinct from old.cost_cents then
      raise exception 'PM_RES_PROPOSAL_STATE: status, totals and signatures change only through the proposal functions' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_res_proposal_defaults on pm.res_proposals;
create trigger trg_res_proposal_defaults before insert or update on pm.res_proposals
  for each row execute function pm.tg_res_proposal_defaults();

-- Lines + options of a non-DRAFT proposal are frozen for members (definer code may write).
create or replace function pm.tg_res_proposal_child_lock() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_status text; v_org uuid; v_prop uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; v_prop := old.proposal_id; else v_org := new.org_id; v_prop := new.proposal_id; end if;
  if current_user in ('authenticated', 'anon') then
    select p.status into v_status from pm.res_proposals p where p.org_id = v_org and p.id = v_prop;
    if v_status is distinct from 'DRAFT' then
      raise exception 'PM_RES_PROPOSAL_LOCKED: the proposal is % — revise it to change lines or options', lower(coalesce(v_status, 'missing'))
        using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Price one line (the same arithmetic as apps/projects/src/lib/residential/pricing.ts).
--   labor (rate card): hours = labor_hours ?? qty; cost = round(hours × (pay + burden)); estimating =
--     round(hours × estimating rate); overhead = estimating − cost; unit sell = explicit ?? sell(estimating
--     rate); price = round(hours × unit sell). (= what 1108's estimate-line trigger computes.)
--   other: cost = round(qty × (1 + waste) × unit cost); price = explicit ? round(qty × unit sell) : sell(cost)
--   sell(x) = margin ? round(x ÷ (1 − margin)) : round(x × (1 + markup))
--   allowance with no cost: cost = price.
create or replace function pm.tg_res_proposal_line_price() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r jsonb; v_hours numeric; v_est bigint; ci pm.res_catalog_items%rowtype; v_unit bigint; v_markup numeric; v_loc uuid; v_ct text;
begin
  if new.option_id is not null and not exists (select 1 from pm.res_proposal_options o where o.org_id = new.org_id and o.id = new.option_id and o.proposal_id = new.proposal_id) then
    raise exception 'PM_INVALID: the option is not on this proposal' using errcode = '22023';
  end if;
  select p.location_id, p.contract_type into v_loc, v_ct from pm.res_proposals p where p.org_id = new.org_id and p.id = new.proposal_id;
  if tg_op = 'INSERT' and new.catalog_item_id is not null then
    select * into ci from pm.res_catalog_items c where c.org_id = new.org_id and c.id = new.catalog_item_id;
    if ci.id is null or ci.location_id <> v_loc then raise exception 'PM_INVALID: catalog item is not in this company''s catalog' using errcode = '22023'; end if;
    if coalesce(new.description, '') = '' then new.description := ci.name; end if;
    new.cost_code_id := coalesce(new.cost_code_id, ci.cost_code_id);
    if new.cost_type = 'MATERIALS' then new.cost_type := ci.cost_type; end if;
    if new.uom = 'EA' then new.uom := ci.uom; end if;
    if new.unit_cost_cents = 0 then new.unit_cost_cents := ci.unit_cost_cents; end if;
    if new.waste_pct = 0 then new.waste_pct := ci.waste_pct; end if;
    if new.markup_pct is null and new.margin_pct is null then new.markup_pct := ci.markup_pct; new.margin_pct := ci.margin_pct; end if;
    if new.unit_price_cents is null and ci.price_locked then new.unit_price_cents := ci.unit_price_cents; end if;
    if new.tax_category = 'MATERIAL' then new.tax_category := ci.tax_category; end if;
  end if;
  if new.markup_pct is null and new.margin_pct is null and not new.is_allowance and new.unit_price_cents is null then
    select s.default_markup_pct into v_markup from pm.res_settings s where s.org_id = new.org_id and s.location_id = v_loc;
    new.markup_pct := coalesce(v_markup, 0);
  end if;
  -- cost-plus: lines carry cost; the fee is added on the proposal
  if v_ct in ('COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS') and not new.is_allowance and new.unit_price_cents is null then
    new.markup_pct := 0; new.margin_pct := null;
  end if;

  if new.labor_rate_card_id is not null then
    r := pm.labor_rate_for(new.org_id, new.labor_rate_card_id);
    if r is null then raise exception 'PM_UNKNOWN_RATE_CARD: %', new.labor_rate_card_id using errcode = '23503'; end if;
    if (r ->> 'estimating_rate_cents') is null then
      raise exception 'PM_RATE_CARD_NO_BASE: % uses each employee''s pay rate; give the card a base rate to price estimates with it', r ->> 'label' using errcode = '22023';
    end if;
    v_hours := coalesce(new.labor_hours, new.qty, 0);
    new.labor_hours := v_hours;
    new.qty := v_hours;
    new.uom := 'HR';
    new.cost_type := 'LABOR';
    if new.tax_category = 'MATERIAL' then new.tax_category := 'LABOR'; end if;
    new.unit_cost_cents := (r ->> 'estimating_rate_cents')::bigint;
    new.cost_cents := pm.res_round(v_hours * (r ->> 'cost_rate_cents')::numeric);
    v_est := pm.res_round(v_hours * (r ->> 'estimating_rate_cents')::numeric);
    new.overhead_cents := v_est - new.cost_cents;
    v_unit := coalesce(new.unit_price_cents, pm.res_sell((r ->> 'estimating_rate_cents')::bigint, new.markup_pct, new.margin_pct));
    new.price_cents := pm.res_round(v_hours * v_unit);
    if coalesce(new.description, '') = '' then new.description := r ->> 'label'; end if;
    new.ext := new.ext || jsonb_build_object('unit_sell_cents', v_unit, 'cost_rate_cents', (r ->> 'cost_rate_cents')::bigint,
                                             'estimating_rate_cents', (r ->> 'estimating_rate_cents')::bigint);
  else
    new.labor_hours := null;
    new.cost_cents := pm.res_round(new.qty * (1 + new.waste_pct) * new.unit_cost_cents);
    new.overhead_cents := 0;
    if new.unit_price_cents is not null then
      new.price_cents := pm.res_round(new.qty * new.unit_price_cents);
    else
      new.price_cents := coalesce(pm.res_sell(new.cost_cents, new.markup_pct, new.margin_pct), 0);
    end if;
    if new.is_allowance and new.cost_cents = 0 then new.cost_cents := new.price_cents; end if;
    new.ext := new.ext - 'unit_sell_cents' - 'cost_rate_cents' - 'estimating_rate_cents';
  end if;
  if coalesce(btrim(new.description), '') = '' then new.description := 'Line'; end if;
  return new;
end $$;

-- Totals over the base scope + selected options (same as pricing.ts proposalTotals).
create or replace function pm._res_proposal_totals(p_proposal uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; st pm.res_state_rules%rowtype; v_scope bigint; v_opt bigint; v_allow bigint; v_cont bigint;
  v_cost bigint; v_oh bigint; v_fee bigint := 0; v_tax bigint := 0; v_use bigint := 0; v_total bigint; v_dep bigint; v_taxable bigint;
  v_base_nonallow bigint; v_cont_auto bigint := 0; v_mat_cost bigint;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal;
  if p.id is null then return; end if;
  if p.state_code is not null then select * into st from pm.res_state_rules s where s.state_code = p.state_code; end if;
  with inc as (
    select l.* from pm.res_proposal_lines l
      left join pm.res_proposal_options o on o.org_id = l.org_id and o.id = l.option_id
     where l.org_id = p.org_id and l.proposal_id = p.id and (l.option_id is null or o.is_selected)
  )
  select coalesce(sum(price_cents), 0), coalesce(sum(price_cents) filter (where option_id is not null), 0),
         coalesce(sum(price_cents) filter (where is_allowance), 0), coalesce(sum(price_cents) filter (where is_contingency), 0),
         coalesce(sum(cost_cents), 0), coalesce(sum(overhead_cents), 0),
         coalesce(sum(price_cents) filter (where tax_category in ('MATERIAL','EQUIPMENT')
                                             or (tax_category = 'LABOR' and coalesce(st.labor_taxable, false))
                                             or (tax_category = 'DESIGN_FEE' and coalesce(st.design_fee_taxable, false))), 0),
         coalesce(sum(price_cents) filter (where not is_allowance and not is_contingency), 0),
         coalesce(sum(cost_cents) filter (where tax_category in ('MATERIAL','EQUIPMENT')), 0)
    into v_scope, v_opt, v_allow, v_cont, v_cost, v_oh, v_taxable, v_base_nonallow, v_mat_cost
    from inc;
  if p.contingency_pct is not null then v_cont_auto := pm.res_round(v_base_nonallow * p.contingency_pct); end if;
  if p.contract_type in ('COST_PLUS_PCT','COST_PLUS_GMP') then v_fee := pm.res_round(v_cost * coalesce(p.fee_pct, 0));
  elsif p.contract_type = 'COST_PLUS_FEE' then v_fee := coalesce(p.fee_cents, 0);
  end if;
  v_total := v_scope + v_cont_auto + v_fee;
  if p.tax_contract_form = 'RETAIL_PLUS_INSTALL' then
    v_tax := pm.res_round(v_taxable * p.tax_rate);
  elsif p.tax_contract_form = 'LUMP_SUM_IMPROVEMENT' then
    v_use := pm.res_round(v_mat_cost * p.tax_rate);
  end if;
  v_dep := coalesce(p.deposit_cents, pm.res_round(v_total * coalesce(p.deposit_pct, 0)));
  if st.deposit_cap_pct is not null then v_dep := least(v_dep, pm.res_round(v_total * st.deposit_cap_pct)); end if;
  if st.deposit_cap_cents is not null then v_dep := least(v_dep, st.deposit_cap_cents); end if;
  v_dep := greatest(v_dep - p.retainer_credit_cents, 0);
  update pm.res_proposals
     set base_price_cents = v_scope - v_opt, options_price_cents = v_opt, allowance_cents = v_allow, contingency_cents = v_cont + v_cont_auto,
         fee_total_cents = v_fee, tax_cents = v_tax, use_tax_cents = v_use, total_cents = v_total, grand_total_cents = v_total + v_tax,
         cost_cents = v_cost, overhead_cents = v_oh, deposit_due_cents = v_dep
   where id = p.id;
end $$;

create or replace function pm.tg_res_proposal_line_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if tg_op = 'DELETE' then perform pm._res_proposal_totals(old.proposal_id); else perform pm._res_proposal_totals(new.proposal_id); end if;
  return null;
end $$;

create or replace function pm.tg_res_proposal_header_totals() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  perform pm._res_proposal_totals(new.id);
  return null;
end $$;

drop trigger if exists trg_res_proposal_line_lock on pm.res_proposal_lines;
create trigger trg_res_proposal_line_lock before insert or update or delete on pm.res_proposal_lines
  for each row execute function pm.tg_res_proposal_child_lock();
drop trigger if exists trg_res_proposal_option_lock on pm.res_proposal_options;
create trigger trg_res_proposal_option_lock before insert or update or delete on pm.res_proposal_options
  for each row execute function pm.tg_res_proposal_child_lock();
drop trigger if exists trg_res_proposal_line_price on pm.res_proposal_lines;
create trigger trg_res_proposal_line_price before insert or update on pm.res_proposal_lines
  for each row execute function pm.tg_res_proposal_line_price();
drop trigger if exists trg_res_proposal_line_totals on pm.res_proposal_lines;
create trigger trg_res_proposal_line_totals after insert or update or delete on pm.res_proposal_lines
  for each row execute function pm.tg_res_proposal_line_totals();
drop trigger if exists trg_res_proposal_option_totals on pm.res_proposal_options;
create trigger trg_res_proposal_option_totals after insert or update or delete on pm.res_proposal_options
  for each row execute function pm.tg_res_proposal_line_totals();
drop trigger if exists trg_res_proposal_header_totals on pm.res_proposals;
create trigger trg_res_proposal_header_totals after update of contract_type, fee_pct, fee_cents, tax_contract_form, tax_rate, state_code,
  deposit_pct, deposit_cents, retainer_credit_cents, contingency_pct on pm.res_proposals
  for each row execute function pm.tg_res_proposal_header_totals();

-- Catalog: sell price follows cost × markup unless locked.
create or replace function pm.tg_res_catalog_price() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if not new.price_locked and (new.markup_pct is not null or new.margin_pct is not null) then
    new.unit_price_cents := pm.res_sell(pm.res_round(new.unit_cost_cents * (1 + new.waste_pct)), new.markup_pct, new.margin_pct);
  end if;
  return new;
end $$;
drop trigger if exists trg_res_catalog_price on pm.res_catalog_items;
create trigger trg_res_catalog_price before insert or update on pm.res_catalog_items
  for each row execute function pm.tg_res_catalog_price();

-- ----------------------------------------------------------------------------
-- 2. Proposal RPCs
-- ----------------------------------------------------------------------------
-- Default payment schedule for a schedule template (pct of the contract; the deposit row first).
create or replace function pm._res_default_payment_schedule(p_template text, p_deposit numeric) returns jsonb
language sql immutable
set search_path = pm, public
as $$
  select case
    when p_template = 'kitchen_remodel' then jsonb_build_array(
      jsonb_build_object('label', 'Deposit at signing', 'kind', 'DEPOSIT', 'pct', p_deposit),
      jsonb_build_object('label', 'Demolition complete', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.25, 6), 'trigger_ref', 'demolition'),
      jsonb_build_object('label', 'Cabinets installed', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.30, 6), 'trigger_ref', 'cabinets'),
      jsonb_build_object('label', 'Countertops installed', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.30, 6), 'trigger_ref', 'install_tops', 'requires_photo', true),
      jsonb_build_object('label', 'Substantial completion', 'kind', 'FINAL', 'trigger_ref', 'complete', 'requires_checklist', true))
    when p_template = 'bathroom_remodel' then jsonb_build_array(
      jsonb_build_object('label', 'Deposit at signing', 'kind', 'DEPOSIT', 'pct', p_deposit),
      jsonb_build_object('label', 'Demolition complete', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.30, 6), 'trigger_ref', 'demolition'),
      jsonb_build_object('label', 'Tile complete', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.40, 6), 'trigger_ref', 'tile', 'requires_photo', true),
      jsonb_build_object('label', 'Substantial completion', 'kind', 'FINAL', 'trigger_ref', 'complete', 'requires_checklist', true))
    else jsonb_build_array(
      jsonb_build_object('label', 'Deposit at signing', 'kind', 'DEPOSIT', 'pct', p_deposit),
      jsonb_build_object('label', 'Midpoint', 'kind', 'MILESTONE', 'pct', round((1 - p_deposit) * 0.5, 6)),
      jsonb_build_object('label', 'Substantial completion', 'kind', 'FINAL', 'trigger_ref', 'complete'))
  end
$$;

-- Insert payment schedule rows from a jsonb array (DRAFT proposals; definer).
create or replace function pm._res_write_payment_schedule(p_proposal uuid, p_items jsonb) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; x jsonb; i int := 0; v_pct numeric := 0; v_final int := 0; v_open boolean;
begin
  select * into p from pm.res_proposals where id = p_proposal;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 30 then
    raise exception 'PM_INVALID: a payment schedule has 1–30 rows' using errcode = '22023';
  end if;
  select coalesce(sum((e ->> 'pct')::numeric), 0), count(*) filter (where coalesce(e ->> 'kind', 'MILESTONE') = 'FINAL')
    into v_pct, v_final from jsonb_array_elements(p_items) e;
  if v_final > 1 then raise exception 'PM_INVALID: only one final payment' using errcode = '22023'; end if;
  if v_pct > 1.000001 then raise exception 'PM_INVALID: the payment schedule adds up to more than 100%% of the contract' using errcode = '22023'; end if;
  delete from pm.res_payment_schedule s where s.org_id = p.org_id and s.proposal_id = p.id;
  for x in select value from jsonb_array_elements(p_items) loop
    i := i + 1;
    -- a FINAL row without an amount takes the balance
    v_open := coalesce(x ->> 'kind', '') = 'FINAL' and x ->> 'pct' is null and x ->> 'amount_cents' is null;
    insert into pm.res_payment_schedule (org_id, job_id, proposal_id, seq, label, kind, pct, amount_cents, trigger_ref, requires_photo, requires_checklist)
    values (p.org_id, p.job_id, p.id, i, left(coalesce(nullif(btrim(x ->> 'label'), ''), 'Payment ' || i), 120), coalesce(x ->> 'kind', 'MILESTONE'),
            case when v_open then greatest(round(1 - v_pct, 6), 0.000001) else (x ->> 'pct')::numeric end,
            (x ->> 'amount_cents')::bigint, nullif(x ->> 'trigger_ref', ''),
            coalesce((x ->> 'requires_photo')::boolean, false), coalesce((x ->> 'requires_checklist')::boolean, false));
  end loop;
  return i;
end $$;

-- Create a proposal from a crm lead (convert_lead: presale job + customer by the shared matcher +
-- a DRAFT estimate) or on an existing job.
create or replace function pm.res_create_proposal(p_location uuid, p_lead uuid default null, p_job uuid default null,
                                                  p_title text default null, p_job_type_key text default null, p_attrs jsonb default '{}')
returns uuid
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare
  a jsonb := coalesce(p_attrs, '{}'::jsonb); v_org uuid := public.get_org_id(); v_job uuid := p_job; v_est uuid; v_cust uuid; v_loc uuid;
  s pm.res_settings%rowtype; v_id uuid := gen_random_uuid(); v_title text; v_tpl text; v_jt text; r jsonb; v_prev text; v_me uuid;
  v_design pm.res_proposals%rowtype; v_dep numeric;
begin
  if (p_lead is null) = (p_job is null) then raise exception 'PM_INVALID: start a proposal from a lead or on a job' using errcode = '22023'; end if;
  if p_lead is not null then
    select l.location_id, l.title into v_loc, v_title from crm.leads l where l.id = p_lead and l.org_id = v_org;
    if v_loc is null then raise exception 'PM_FORBIDDEN: lead % not found', p_lead using errcode = '42501'; end if;
    if p_location is not null and p_location <> v_loc then raise exception 'PM_INVALID: the lead belongs to another company' using errcode = '22023'; end if;
    v_prev := coalesce(current_setting('pm.access_entry', true), '');
    r := crm.convert_lead(p_lead, 'estimate', p_job_type_key);
    perform set_config('pm.access_entry', v_prev, true);
    v_job := (r ->> 'job_id')::uuid; v_est := (r ->> 'estimate_id')::uuid; v_cust := (r ->> 'customer_id')::uuid;
  else
    select j.location_id, j.name, j.customer_id into v_loc, v_title, v_cust from core.jobs j where j.id = p_job and j.org_id = v_org;
    if v_loc is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
    if p_location is not null and p_location <> v_loc then raise exception 'PM_INVALID: the job belongs to another company' using errcode = '22023'; end if;
    insert into pm.estimates (org_id, job_id, customer_id, title, status, created_by)
    values (v_org, v_job, v_cust, left(coalesce(nullif(btrim(p_title), ''), v_title, 'Proposal'), 200), 'DRAFT', pm.current_user_id())
    returning id into v_est;
  end if;
  select * into s from pm.res_settings x where x.org_id = v_org and x.location_id = v_loc;
  select jt.key into v_jt from pm.projects pr join pm.job_types jt on jt.org_id = pr.org_id and jt.id = pr.job_type_id
   where pr.org_id = v_org and pr.job_id = v_job;
  v_tpl := coalesce(nullif(a ->> 'schedule_template_key', ''),
    (select t.key from pm.schedule_templates t where t.org_id = v_org and t.location_id = v_loc and t.is_active and v_jt = any (t.job_type_keys) order by t.source, t.key limit 1),
    (select c.key from pm.schedule_template_catalog c where v_jt = any (c.job_type_keys) order by c.key limit 1),
    case when v_jt ~ 'kitchen' then 'kitchen_remodel' when v_jt ~ 'bath' then 'bathroom_remodel' end);
  if v_tpl is not null and not exists (select 1 from pm.schedule_templates t where t.org_id = v_org and t.location_id = v_loc and t.key = v_tpl)
     and not exists (select 1 from pm.schedule_template_catalog c where c.key = v_tpl) then
    raise exception 'PM_INVALID: schedule template % is not available', v_tpl using errcode = '22023';
  end if;
  -- a design agreement on this job whose retainer credits the build
  select * into v_design from pm.res_proposals x
   where x.org_id = v_org and x.job_id = v_job and x.contract_type = 'DESIGN_AGREEMENT' and x.status = 'ACCEPTED' and x.credit_to_build
   order by x.accepted_at desc limit 1;
  v_dep := coalesce((a ->> 'deposit_pct')::numeric, s.default_deposit_pct, 0.10);

  insert into pm.res_proposals (id, org_id, location_id, job_id, estimate_id, lead_id, customer_id, title, job_type_key, contract_type,
                                fee_pct, fee_cents, gmp_cents, savings_split_pct, tax_contract_form, tax_rate, state_code, scope_narrative,
                                inclusions, exclusions, terms, deposit_pct, deposit_cents, deposit_refundable, credit_to_build,
                                design_proposal_id, retainer_credit_cents, schedule_template_key, planned_start, valid_until, contingency_pct, created_by)
  values (v_id, v_org, v_loc, v_job, v_est, p_lead, v_cust,
          left(coalesce(nullif(btrim(p_title), ''), v_title, 'Proposal'), 200), v_jt,
          coalesce(nullif(a ->> 'contract_type', ''), s.default_contract_type, 'FIXED_PRICE'),
          (a ->> 'fee_pct')::numeric, (a ->> 'fee_cents')::bigint, (a ->> 'gmp_cents')::bigint, (a ->> 'savings_split_pct')::numeric,
          coalesce(nullif(a ->> 'tax_contract_form', ''), s.default_tax_form, 'LUMP_SUM_IMPROVEMENT'),
          coalesce((a ->> 'tax_rate')::numeric, s.default_tax_rate, 0), coalesce(nullif(a ->> 'state_code', ''), s.state_code),
          nullif(a ->> 'scope_narrative', ''),
          coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(a -> 'inclusions') = 'array' then a -> 'inclusions' else '[]'::jsonb end)), '{}'),
          coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(a -> 'exclusions') = 'array' then a -> 'exclusions' else '[]'::jsonb end)), '{}'),
          nullif(a ->> 'terms', ''), v_dep, (a ->> 'deposit_cents')::bigint, coalesce((a ->> 'deposit_refundable')::boolean, false),
          coalesce((a ->> 'credit_to_build')::boolean, false),
          v_design.id, case when v_design.id is not null then coalesce((v_design.result ->> 'deposit_cents')::bigint, v_design.deposit_due_cents, 0) else 0 end,
          v_tpl, (a ->> 'planned_start')::date, coalesce((a ->> 'valid_until')::date, current_date + 30),
          (a ->> 'contingency_pct')::numeric, pm.current_user_id());
  perform pm._res_write_payment_schedule(v_id, case when jsonb_typeof(a -> 'payment_schedule') = 'array' then a -> 'payment_schedule'
                                                    else pm._res_default_payment_schedule(v_tpl, v_dep) end);
  -- the author joins the job team (sales reach the jobs they sell)
  v_me := pm._res_me();
  if v_me is not null and not exists (select 1 from pm.job_members m where m.org_id = v_org and m.job_id = v_job and m.membership_id = v_me) then
    insert into pm.job_members (org_id, job_id, membership_id, slot, added_by) values (v_org, v_job, v_me, 'sales', pm.current_user_id())
    on conflict do nothing;
  end if;
  perform pm.log_activity(v_org, v_loc, v_job, 'proposal.created', 'res_proposals', v_id, format('Proposal started: %s', left(coalesce(p_title, v_title, ''), 120)),
    jsonb_build_object('lead_id', p_lead, 'estimate_id', v_est, 'schedule_template', v_tpl));
  return v_id;
end $$;

create or replace function pm.res_set_payment_schedule(p_proposal uuid, p_items jsonb) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_RES_PROPOSAL_LOCKED: revise the proposal to change its payment schedule' using errcode = '55000'; end if;
  return pm._res_write_payment_schedule(p.id, p_items);
end $$;

-- Add a catalog item or an assembly (each item × qty, plus its labor line) to a DRAFT proposal.
create or replace function pm.res_add_catalog_lines(p_proposal uuid, p_catalog_item uuid default null, p_assembly uuid default null,
                                                    p_qty numeric default 1, p_option uuid default null, p_room text default null)
returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; it record; n int := 0; v_sort int;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_RES_PROPOSAL_LOCKED: revise the proposal to add lines' using errcode = '55000'; end if;
  if (p_catalog_item is null) = (p_assembly is null) then raise exception 'PM_INVALID: add one catalog item or one assembly' using errcode = '22023'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'PM_INVALID: quantity must be > 0' using errcode = '22023'; end if;
  select coalesce(max(sort), 0) + 1 into v_sort from pm.res_proposal_lines where org_id = p.org_id and proposal_id = p.id;
  for it in
    select c.*, x.q from (
      select ai.catalog_item_id as cid, ai.qty_per_unit * p_qty as q, ai.sort from pm.res_assembly_items ai
        join pm.res_assemblies asm on asm.org_id = ai.org_id and asm.id = ai.assembly_id
       where p_assembly is not null and ai.org_id = p.org_id and ai.assembly_id = p_assembly and asm.location_id = p.location_id
      union all
      select p_catalog_item, p_qty, 0 where p_catalog_item is not null) x
    join pm.res_catalog_items c on c.org_id = p.org_id and c.id = x.cid and c.location_id = p.location_id
    order by x.sort
  loop
    insert into pm.res_proposal_lines (org_id, proposal_id, option_id, catalog_item_id, assembly_id, room, qty, sort)
    values (p.org_id, p.id, p_option, it.id, p_assembly, p_room, it.q, v_sort);
    n := n + 1; v_sort := v_sort + 1;
    if it.labor_rate_card_id is not null and coalesce(it.labor_hours_per_unit, 0) > 0 then
      insert into pm.res_proposal_lines (org_id, proposal_id, option_id, catalog_item_id, assembly_id, cost_code_id, room, description,
                                         labor_rate_card_id, labor_hours, markup_pct, sort)
      values (p.org_id, p.id, p_option, null, p_assembly, it.cost_code_id, p_room, 'Install: ' || it.name, it.labor_rate_card_id,
              round(it.q * it.labor_hours_per_unit, 4), it.markup_pct, v_sort);
      n := n + 1; v_sort := v_sort + 1;
    end if;
  end loop;
  if n = 0 then raise exception 'PM_INVALID: nothing to add (the item or assembly is not in this company''s catalog)' using errcode = '22023'; end if;
  return n;
end $$;

-- Choose options (alternates: exactly one per group; add-ons any). DRAFT only.
create or replace function pm.res_select_options(p_proposal uuid, p_option_ids uuid[]) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_bad text; n int;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_RES_PROPOSAL_LOCKED: options are chosen on a draft or at acceptance' using errcode = '55000'; end if;
  if exists (select 1 from unnest(coalesce(p_option_ids, '{}')) x where not exists (select 1 from pm.res_proposal_options o where o.id = x and o.proposal_id = p.id)) then
    raise exception 'PM_INVALID: an option is not on this proposal' using errcode = '22023';
  end if;
  select string_agg(g, ', ') into v_bad from (
    select o.group_key as g from pm.res_proposal_options o where o.org_id = p.org_id and o.proposal_id = p.id and o.kind = 'ALTERNATE'
     group by o.group_key having count(*) filter (where o.id = any (coalesce(p_option_ids, '{}'))) > 1) z;
  if v_bad is not null then raise exception 'PM_RES_OPTION_GROUP: pick one option in %', v_bad using errcode = '22023'; end if;
  update pm.res_proposal_options o set is_selected = (o.id = any (coalesce(p_option_ids, '{}'))) where o.org_id = p.org_id and o.proposal_id = p.id;
  get diagnostics n = row_count;
  perform pm._res_proposal_totals(p.id);
  return n;
end $$;

-- Rewrite the DRAFT estimate's lines from the included proposal lines (+ computed contingency + fee).
create or replace function pm._res_sync_estimate(p_proposal uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; e pm.estimates%rowtype; v_auto bigint;
begin
  select * into p from pm.res_proposals where id = p_proposal;
  select * into e from pm.estimates where org_id = p.org_id and id = p.estimate_id for update;
  if e.id is null then raise exception 'PM_RES_NO_ESTIMATE: the proposal has no estimate' using errcode = 'P0002'; end if;
  if e.status <> 'DRAFT' then raise exception 'PM_RES_ESTIMATE_NOT_DRAFT: estimate % v% is %', e.number, e.version, e.status using errcode = '22023'; end if;
  delete from pm.estimate_lines l where l.org_id = e.org_id and l.estimate_id = e.id;
  insert into pm.estimate_lines (org_id, estimate_id, line_no, cost_code_id, description, qty, uom, unit_cost_cents, unit_price_cents,
                                 cost_cents, amount_cents, is_allowance, sort, labor_rate_card_id, labor_hours, ext)
  select l.org_id, e.id, (row_number() over (order by (l.option_id is not null), l.sort, l.created_at))::int, l.cost_code_id,
         left(concat_ws(' — ', nullif(l.room, ''), l.description), 500), l.qty, l.uom,
         case when l.labor_rate_card_id is null then l.unit_cost_cents end,
         case when l.labor_rate_card_id is not null then (l.ext ->> 'unit_sell_cents')::bigint
              when l.qty > 0 and l.unit_price_cents is not null then l.unit_price_cents end,
         case when l.labor_rate_card_id is null then l.cost_cents end, l.price_cents, l.is_allowance,
         (row_number() over (order by (l.option_id is not null), l.sort, l.created_at))::int,
         l.labor_rate_card_id, l.labor_hours,
         jsonb_build_object('res_line_id', l.id, 'option_id', l.option_id, 'tax_category', l.tax_category, 'room', l.room)
    from pm.res_proposal_lines l
    left join pm.res_proposal_options o on o.org_id = l.org_id and o.id = l.option_id
   where l.org_id = p.org_id and l.proposal_id = p.id and (l.option_id is null or o.is_selected);
  v_auto := p.contingency_cents - coalesce((select sum(l.price_cents) from pm.res_proposal_lines l
                                              left join pm.res_proposal_options o on o.org_id = l.org_id and o.id = l.option_id
                                             where l.org_id = p.org_id and l.proposal_id = p.id and l.is_contingency and (l.option_id is null or o.is_selected)), 0);
  if v_auto > 0 then
    insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, cost_cents, amount_cents, sort, ext)
    values (p.org_id, e.id, 9000, 'Contingency', 1, 0, v_auto, 9000, jsonb_build_object('res_kind', 'contingency'));
  end if;
  if p.fee_total_cents > 0 then
    insert into pm.estimate_lines (org_id, estimate_id, line_no, description, qty, cost_cents, amount_cents, sort, ext)
    values (p.org_id, e.id, 9001, case when p.contract_type = 'COST_PLUS_FEE' then 'Builder fee (fixed)' else format('Builder fee (%s%%)', round(coalesce(p.fee_pct, 0) * 100, 2)) end,
            1, 0, p.fee_total_cents, 9001, jsonb_build_object('res_kind', 'fee'));
  end if;
  update pm.estimates set title = left(p.title, 200), valid_until = p.valid_until,
         notes = left(coalesce(p.scope_narrative, notes, ''), 4000)
   where id = e.id;
  return e.id;
end $$;

-- Validate a proposal before it goes to the homeowner. Raises the first problem in plain words.
create or replace function pm._res_validate_proposal(p_proposal uuid) returns void
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_n int; v_bad text; v_sum numeric;
begin
  select * into p from pm.res_proposals where id = p_proposal;
  select count(*) into v_n from pm.res_proposal_lines l where l.org_id = p.org_id and l.proposal_id = p.id;
  if v_n = 0 then raise exception 'PM_RES_PROPOSAL_EMPTY: add scope lines first' using errcode = '22023'; end if;
  select string_agg(left(l.description, 60), '; ') into v_bad from pm.res_proposal_lines l
   where l.org_id = p.org_id and l.proposal_id = p.id and l.cost_cents <> 0 and l.cost_code_id is null;
  if v_bad is not null then raise exception 'PM_RES_UNCODED: give these lines a cost code (the budget is by cost code): %', v_bad using errcode = '22023'; end if;
  select string_agg(distinct o.group_key, ', ') into v_bad from pm.res_proposal_options o
   where o.org_id = p.org_id and o.proposal_id = p.id and o.kind = 'ALTERNATE'
     and not exists (select 1 from pm.res_proposal_options o2 where o2.org_id = o.org_id and o2.proposal_id = o.proposal_id and o2.group_key = o.group_key and o2.is_selected);
  if v_bad is not null then raise exception 'PM_RES_OPTION_GROUP: pick one option in %', v_bad using errcode = '22023'; end if;
  if p.total_cents <= 0 then raise exception 'PM_RES_PROPOSAL_ZERO: the proposal total must be more than zero' using errcode = '22023'; end if;
  select coalesce(sum(s.pct), 0) + coalesce(sum(s.amount_cents)::numeric / nullif(p.total_cents, 0), 0) into v_sum
    from pm.res_payment_schedule s where s.org_id = p.org_id and s.proposal_id = p.id;
  if abs(v_sum - 1) > 0.0001 then
    raise exception 'PM_RES_PAYMENT_SCHEDULE: the payment schedule adds up to %%% of the contract, not 100%%', round(v_sum * 100, 2) using errcode = '22023';
  end if;
end $$;

-- Send: validate → sync the estimate → (below the margin floor) the approvals engine → SENT + snapshot.
create or replace function pm.res_send_proposal(p_proposal uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; e pm.estimates%rowtype; st pm.res_state_rules%rowtype; v_appr jsonb; v_body jsonb;
  v_prev text; v_estimate_total bigint;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status <> 'DRAFT' then raise exception 'PM_RES_PROPOSAL_NOT_DRAFT: the proposal is %', lower(p.status) using errcode = '22023'; end if;
  perform pm._res_proposal_totals(p.id);
  select * into p from pm.res_proposals where id = p.id;
  perform pm._res_validate_proposal(p.id);
  if p.state_code is not null then select * into st from pm.res_state_rules s where s.state_code = p.state_code; end if;
  select * into e from pm.estimates where org_id = p.org_id and id = p.estimate_id;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  if e.status = 'DRAFT' then
    perform pm._res_sync_estimate(p.id);
    if pm.approval_needed('estimate', e.id) then
      v_appr := pm.approval_submit('estimate', e.id, null, 'web');
      perform set_config('pm.access_entry', v_prev, true);
      perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'proposal.approval_requested', 'res_proposals', p.id,
        'Proposal sent for internal approval (below the margin floor)', jsonb_build_object('estimate_id', e.id));
      return jsonb_build_object('status', 'approval_required', 'proposal_id', p.id, 'estimate_id', e.id, 'approval', v_appr);
    end if;
    perform pm.send_estimate(e.id);
  elsif e.status = 'SENT' then
    -- approved through the engine (it sent the estimate): the proposal must still be what was approved
    select e2.total_cents into v_estimate_total from pm.estimates e2 where e2.id = e.id;
    if v_estimate_total <> p.total_cents then
      perform set_config('pm.access_entry', v_prev, true);
      raise exception 'PM_RES_PROPOSAL_CHANGED: the proposal changed after it was approved (% vs % cents) — revise it', p.total_cents, v_estimate_total using errcode = '22023';
    end if;
  else
    perform set_config('pm.access_entry', v_prev, true);
    raise exception 'PM_RES_ESTIMATE_STATE: the estimate is %', lower(e.status) using errcode = '22023';
  end if;
  perform set_config('pm.access_entry', v_prev, true);

  v_body := jsonb_build_object(
    'title', p.title, 'contract_type', p.contract_type, 'tax_contract_form', p.tax_contract_form, 'total_cents', p.total_cents,
    'tax_cents', p.tax_cents, 'grand_total_cents', p.grand_total_cents, 'deposit_due_cents', p.deposit_due_cents,
    'scope_narrative', p.scope_narrative, 'inclusions', to_jsonb(p.inclusions), 'exclusions', to_jsonb(p.exclusions),
    'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'kind', o.kind, 'group_key', o.group_key, 'selected', o.is_selected) order by o.sort)
                           from pm.res_proposal_options o where o.org_id = p.org_id and o.proposal_id = p.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'option_id', l.option_id, 'room', l.room, 'description', l.description,
                                                           'qty', l.qty, 'uom', l.uom, 'price_cents', l.price_cents, 'is_allowance', l.is_allowance) order by l.sort)
                         from pm.res_proposal_lines l where l.org_id = p.org_id and l.proposal_id = p.id), '[]'::jsonb),
    'payment_schedule', coalesce((select jsonb_agg(jsonb_build_object('seq', s.seq, 'label', s.label, 'kind', s.kind, 'pct', s.pct, 'amount_cents', s.amount_cents) order by s.seq)
                                    from pm.res_payment_schedule s where s.org_id = p.org_id and s.proposal_id = p.id), '[]'::jsonb));
  insert into pm.res_proposal_snapshots (org_id, proposal_id, version, estimate_id, total_cents, body)
  values (p.org_id, p.id, p.version, p.estimate_id, p.total_cents, v_body)
  on conflict (org_id, proposal_id, version) do update set body = excluded.body, total_cents = excluded.total_cents, sent_at = now();
  update pm.res_proposals
     set status = 'SENT', sent_at = now(),
         cancel_days = coalesce(st.cancel_days, 3),
         cancellation_notice = coalesce(st.notice_text,
           'You may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction. See the attached notice of cancellation form for an explanation of this right.')
   where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'proposal.sent', 'res_proposals', p.id,
    format('Proposal %s v%s sent (%s cents)', coalesce(p.number, ''), p.version, p.total_cents), jsonb_build_object('total_cents', p.total_cents));
  return jsonb_build_object('status', 'sent', 'proposal_id', p.id, 'estimate_id', p.estimate_id, 'total_cents', p.total_cents,
                            'grand_total_cents', p.grand_total_cents, 'deposit_due_cents', p.deposit_due_cents, 'version', p.version);
end $$;

-- Homeowner opened the proposal (portal / signing link): view tracking.
create or replace function pm.res_mark_proposal_viewed(p_proposal uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  update pm.res_proposals set view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
   where id = p_proposal and org_id = public.get_org_id() and status = 'SENT';
end $$;

-- Revise: a new DRAFT estimate version; lines editable again (an open signature request must be voided first).
create or replace function pm.res_revise_proposal(p_proposal uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_new uuid; v_prev text; v_est_status text;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status not in ('SENT','DECLINED','DRAFT') then raise exception 'PM_RES_PROPOSAL_STATE: a % proposal cannot be revised', lower(p.status) using errcode = '22023'; end if;
  if p.envelope_id is not null and exists (select 1 from pm.esign_envelopes e where e.id = p.envelope_id and e.status in ('draft','sent')) then
    raise exception 'PM_RES_ENVELOPE_OPEN: void the open signature request before revising' using errcode = '22023';
  end if;
  select e.status into v_est_status from pm.estimates e where e.id = p.estimate_id;
  if p.status = 'DRAFT' and v_est_status = 'DRAFT' then return p.estimate_id; end if;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_new := pm.revise_estimate(p.estimate_id);
  perform set_config('pm.access_entry', v_prev, true);
  update pm.res_proposals set estimate_id = v_new, version = version + 1, status = 'DRAFT', envelope_id = null, file_id = null,
         declined_at = null, decline_reason = null
   where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'proposal.revised', 'res_proposals', p.id, format('Proposal revised to v%s', p.version + 1), '{}'::jsonb);
  return v_new;
end $$;

create or replace function pm.res_decline_proposal(p_proposal uuid, p_reason text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_prev text; v_est text;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status not in ('DRAFT','SENT') then raise exception 'PM_RES_PROPOSAL_STATE: the proposal is %', lower(p.status) using errcode = '22023'; end if;
  select e.status into v_est from pm.estimates e where e.id = p.estimate_id;
  if v_est in ('DRAFT','SENT') then
    v_prev := coalesce(current_setting('pm.access_entry', true), '');
    perform set_config('pm.access_entry', 'on', true);
    perform pm.decline_estimate(p.estimate_id, p_reason);
    perform set_config('pm.access_entry', v_prev, true);
  end if;
  update pm.res_proposals set status = 'DECLINED', declined_at = now(), decline_reason = left(p_reason, 1000) where id = p.id;
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'proposal.declined', 'res_proposals', p.id, 'Proposal declined', jsonb_build_object('reason', p_reason));
  return p.id;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Accept → job in one click
-- ----------------------------------------------------------------------------
-- Map a selection category to the schedule-template task it must be on site for.
create or replace function pm.res_install_ref(p_category text) returns text[]
language sql immutable
set search_path = pm, public
as $$
  select case
    when lower(coalesce(p_category, '')) ~ 'counter|quartz|granite|top' then array['template_tops','install_tops']
    when lower(coalesce(p_category, '')) ~ 'cabinet|hardware' then array['cabinets','vanity']
    when lower(coalesce(p_category, '')) ~ 'backsplash' then array['backsplash','tile']
    when lower(coalesce(p_category, '')) ~ 'tile|shower' then array['tile','backsplash']
    when lower(coalesce(p_category, '')) ~ 'plumb|faucet|fixture|sink|toilet|tub' then array['plumbing_trim','trim']
    when lower(coalesce(p_category, '')) ~ 'light|electric' then array['electrical_trim','trim']
    when lower(coalesce(p_category, '')) ~ 'appliance' then array['appliances']
    when lower(coalesce(p_category, '')) ~ 'floor' then array['flooring','tile']
    when lower(coalesce(p_category, '')) ~ 'vanity|mirror' then array['vanity','accessories']
    when lower(coalesce(p_category, '')) ~ 'paint' then array['prime','paint']
    when lower(coalesce(p_category, '')) ~ 'glass' then array['glass']
    else array[]::text[] end
$$;

-- Needed-by dates for a job's open selections: install task start − lead time − buffer (calendar days).
create or replace function pm._res_refresh_deadlines(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; s record; v_task uuid; v_start date; v_lead int; v_buf int; v_need date; n int := 0; v_def int;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  select coalesce(x.selection_buffer_days, 5) into v_def from pm.res_settings x where x.org_id = v_org and x.location_id = v_loc;
  v_def := coalesce(v_def, 5);
  for s in select * from pm.selections x where x.org_id = v_org and x.job_id = p_job and x.status in ('OPEN','PROPOSED','REJECTED') loop
    v_task := s.install_task_id;
    if v_task is null then
      select t.id into v_task from pm.tasks t, unnest(pm.res_install_ref(s.category)) with ordinality as r(ref, o)
       where t.org_id = v_org and t.job_id = p_job and t.status <> 'CANCELLED' and t.template_ref like '%:' || r.ref
       order by r.o, t.start_on nulls last limit 1;
    end if;
    if v_task is null then continue; end if;
    select coalesce(t.early_start, t.start_on) into v_start from pm.tasks t where t.id = v_task;
    if v_start is null then continue; end if;
    v_lead := coalesce(s.lead_time_days, (select max(o.lead_time_days) from pm.selection_options o where o.org_id = v_org and o.selection_id = s.id), 0);
    v_buf := coalesce(s.buffer_days, v_def);
    v_need := v_start - v_lead - v_buf;
    update pm.selections
       set install_task_id = v_task, needed_by_on = v_need,
           due_on = case when deadline_source = 'SCHEDULE' or due_on is null then v_need else due_on end,
           deadline_source = case when deadline_source = 'SCHEDULE' or due_on is null then 'SCHEDULE' else deadline_source end,
           at_risk = v_need < current_date
     where id = s.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function pm.res_refresh_selection_deadlines(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501';
  end if;
  return pm._res_refresh_deadlines(p_job);
end $$;

-- Payment milestones → 0-day billing milestone tasks after their trigger task (amount pinned).
create or replace function pm._res_bind_payment_schedule(p_proposal uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; s record; v_total bigint; v_sum bigint := 0; v_amt bigint; v_last uuid; v_task pm.tasks%rowtype;
  v_bt uuid; v_dep uuid; v_dep_amt bigint; v_out jsonb := '[]'::jsonb; v_tpl text; v_n int := 0; v_cnt int;
begin
  select * into p from pm.res_proposals where id = p_proposal;
  v_total := p.total_cents;
  v_tpl := p.schedule_template_key;
  select count(*) into v_cnt from pm.res_payment_schedule x where x.org_id = p.org_id and x.proposal_id = p.id;
  for s in select * from pm.res_payment_schedule x where x.org_id = p.org_id and x.proposal_id = p.id order by x.seq loop
    v_n := v_n + 1;
    v_amt := case when v_n = v_cnt then v_total - v_sum else coalesce(s.amount_cents, pm.res_round(v_total * s.pct)) end;
    v_sum := v_sum + v_amt;
    update pm.res_payment_schedule set amount_cents = v_amt where id = s.id;
    if s.kind = 'DEPOSIT' then
      v_dep_amt := greatest(v_amt - p.retainer_credit_cents, 0);
      if v_dep_amt > 0 then
        v_dep := pm.request_deposit(p.job_id, v_dep_amt, left(format('%s — %s', s.label, p.title), 200), current_date);
        update pm.res_payment_schedule set deposit_request_id = v_dep, status = 'DRAFTED' where id = s.id;
      else
        update pm.res_payment_schedule set status = 'BILLED', hold_reason = 'Covered by the design retainer credit' where id = s.id;
      end if;
      v_out := v_out || jsonb_build_object('seq', s.seq, 'kind', 'DEPOSIT', 'amount_cents', v_amt, 'deposit_request_id', v_dep, 'requested_cents', v_dep_amt);
      continue;
    end if;
    v_task := null;
    if s.trigger_ref is not null and v_tpl is not null then
      select * into v_task from pm.tasks t where t.org_id = p.org_id and t.job_id = p.job_id and t.template_ref = v_tpl || ':' || s.trigger_ref limit 1;
    end if;
    if v_task.id is null and s.kind = 'FINAL' then
      select * into v_task from pm.tasks t where t.org_id = p.org_id and t.job_id = p.job_id and t.is_milestone and t.status <> 'CANCELLED'
       order by t.due_on desc nulls last, t.sort desc limit 1;
    end if;
    if v_task.id is null then
      v_out := v_out || jsonb_build_object('seq', s.seq, 'kind', s.kind, 'amount_cents', v_amt, 'task_id', null);
      continue;
    end if;
    if v_task.is_milestone then
      v_bt := v_task.id;   -- a template milestone (e.g. substantial completion) bills itself
      update pm.tasks set billing_amount_cents = coalesce(billing_amount_cents, 0) + v_amt where id = v_bt;
    else
      insert into pm.tasks (org_id, job_id, parent_task_id, title, is_milestone, duration_days, sort, status, billing_amount_cents,
                            constraint_type, template_ref, created_by)
      values (p.org_id, p.job_id, v_task.parent_task_id, left('Payment: ' || s.label, 200), true, 0, v_task.sort, 'TODO', v_amt,
              'ASAP', null, pm.current_user_id())
      returning id into v_bt;
      insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days) values (p.org_id, v_task.id, v_bt, 'FS', 0)
      on conflict do nothing;
    end if;
    update pm.res_payment_schedule set task_id = v_task.id, billing_task_id = v_bt, status = 'SCHEDULED' where id = s.id;
    v_out := v_out || jsonb_build_object('seq', s.seq, 'kind', s.kind, 'amount_cents', v_amt, 'task_id', v_task.id, 'billing_task_id', v_bt);
  end loop;
  return v_out;
end $$;

-- Selections from the accepted estimate's allowance lines (one per line, or one per listed title
-- sharing the allowance).
create or replace function pm._res_selections_from_allowances(p_proposal uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; a record; t text; n int := 0; v_titles text[]; v_i int;
begin
  select * into p from pm.res_proposals where id = p_proposal;
  for a in
    select al.id as allowance_id, al.allowance_cents, al.cost_code_id, el.description, rl.allowance_category, rl.room, rl.selection_titles, rl.description as line_desc
      from pm.allowances al
      join pm.estimate_lines el on el.org_id = al.org_id and el.id = al.estimate_line_id
      left join pm.res_proposal_lines rl on rl.org_id = el.org_id and rl.id = pm.access_try_uuid(el.ext ->> 'res_line_id')
     where al.org_id = p.org_id and al.job_id = p.job_id and el.estimate_id = p.estimate_id
       and not exists (select 1 from pm.selections s where s.org_id = al.org_id and s.allowance_id = al.id)
  loop
    v_titles := case when cardinality(coalesce(a.selection_titles, '{}')) > 0 then a.selection_titles else array[coalesce(a.line_desc, a.description)] end;
    v_i := 0;
    foreach t in array v_titles loop
      v_i := v_i + 1;
      insert into pm.selections (org_id, job_id, category, title, room, allowance_cents, allowance_id, status, sort, deadline_source, ext)
      values (p.org_id, p.job_id, left(coalesce(nullif(a.allowance_category, ''), 'Allowance'), 80), left(t, 200), a.room,
              case when cardinality(v_titles) = 1 then a.allowance_cents end, a.allowance_id, 'OPEN', n, 'SCHEDULE',
              jsonb_build_object('_res_shared', cardinality(v_titles) > 1, '_res_cost_code_id', a.cost_code_id, '_res_source', 'proposal'));
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- Household / portal invite hook from the customer's contacts.
create or replace function pm._res_household_from_customer(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_cust uuid; n int := 0; c record;
begin
  select j.org_id, j.customer_id into v_org, v_cust from core.jobs j where j.id = p_job;
  if v_cust is null then return 0; end if;
  for c in select * from core.contacts x where x.org_id = v_org and x.customer_id = v_cust and x.identity_status = 'active' order by x.is_primary desc, x.created_at loop
    insert into pm.res_household_members (org_id, job_id, contact_id, name, email, phone, relation, can_sign, can_pay, sees_money)
    values (v_org, p_job, c.id, left(coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, c.phone, 'Homeowner'), 200),
            c.email, c.phone, case when c.is_primary then 'OWNER' else 'FAMILY' end, c.can_sign or c.is_primary, c.can_pay or c.is_primary, true)
    on conflict (org_id, job_id, contact_id) where contact_id is not null do nothing;
    n := n + 1;
  end loop;
  if n = 0 then
    insert into pm.res_household_members (org_id, job_id, name, email, phone, relation, can_sign, can_pay)
    select v_org, p_job, left(coalesce(nullif(btrim(cu.name), ''), 'Homeowner'), 200), cu.email, cu.phone, 'OWNER', true, true
      from core.customers cu where cu.id = v_cust
       and not exists (select 1 from pm.res_household_members h where h.org_id = v_org and h.job_id = p_job);
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

-- Everything that follows an accepted estimate on a residential proposal. Idempotent per proposal.
create or replace function pm._res_complete_acceptance(p_proposal uuid, p_method text, p_signer text) returns jsonb
language plpgsql security definer
set search_path = pm, core, crm, public
as $$
declare
  p pm.res_proposals%rowtype; v_prev text; v_warn text[] := '{}'; v_sched jsonb; v_pay jsonb; v_sel int := 0; v_house int := 0;
  v_contract uuid; v_design pm.res_proposals%rowtype; v_total bigint; v_dep bigint; r jsonb; v_rule text; v_start date;
begin
  select * into p from pm.res_proposals where id = p_proposal for update;
  if p.status = 'ACCEPTED' then return p.result; end if;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  perform pm._res_proposal_totals(p.id);
  select * into p from pm.res_proposals where id = p.id;

  -- contract value: a build after a design agreement on the same job (credit → the build price absorbs it)
  if p.design_proposal_id is not null then
    select * into v_design from pm.res_proposals where id = p.design_proposal_id;
    v_contract := pm.primary_contract_id(p.org_id, p.job_id);
    if v_contract is not null then
      v_total := case when v_design.credit_to_build then greatest(p.total_cents, v_design.total_cents) else v_design.total_cents + p.total_cents end;
      perform pm.set_contract(p.job_id, v_total, 'PRIME', null, null, v_contract, null);
    end if;
  end if;

  select coalesce(x.overage_billing, 'UPFRONT') into v_rule from pm.res_settings x where x.org_id = p.org_id and x.location_id = p.location_id;
  insert into pm.res_job_terms (org_id, job_id, proposal_id, contract_type, fee_pct, fee_cents, gmp_cents, savings_split_pct, tax_contract_form,
                                tax_rate, state_code, open_book, overage_billing, retainer_credit_cents)
  values (p.org_id, p.job_id, p.id, p.contract_type, p.fee_pct, p.fee_cents, p.gmp_cents, p.savings_split_pct, p.tax_contract_form,
          p.tax_rate, p.state_code, p.contract_type like 'COST_PLUS%', coalesce(v_rule, 'UPFRONT'), p.retainer_credit_cents)
  on conflict (org_id, job_id) do update set proposal_id = excluded.proposal_id, contract_type = excluded.contract_type, fee_pct = excluded.fee_pct,
    fee_cents = excluded.fee_cents, gmp_cents = excluded.gmp_cents, savings_split_pct = excluded.savings_split_pct,
    tax_contract_form = excluded.tax_contract_form, tax_rate = excluded.tax_rate, state_code = excluded.state_code, open_book = excluded.open_book,
    retainer_credit_cents = excluded.retainer_credit_cents;

  -- schedule from the template
  if p.schedule_template_key is not null and p.contract_type <> 'DESIGN_AGREEMENT'
     and not exists (select 1 from pm.tasks t where t.org_id = p.org_id and t.job_id = p.job_id and t.template_ref like p.schedule_template_key || ':%') then
    v_start := coalesce(p.planned_start, current_date + 14);
    begin
      v_sched := pm.apply_schedule_template(p.job_id, p.schedule_template_key, v_start);
    exception when others then
      v_warn := v_warn || ('schedule: ' || sqlerrm);
    end;
  end if;

  -- payment schedule (deposit request → Books mints the invoice; milestones bound to tasks)
  begin
    v_pay := pm._res_bind_payment_schedule(p.id);
  exception when others then
    v_warn := v_warn || ('payment schedule: ' || sqlerrm);
  end;
  begin
    perform pm._schedule_run(p.job_id);
  exception when others then
    null;
  end;

  -- selections from allowance lines, deadlines from the schedule
  v_sel := pm._res_selections_from_allowances(p.id);
  perform pm._res_refresh_deadlines(p.job_id);
  -- household (portal invites) + the occupied-home profile + RRP when the home is pre-1978
  v_house := pm._res_household_from_customer(p.job_id);
  perform pm._res_invite_household(p.job_id);
  insert into pm.res_home_profiles (org_id, job_id) values (p.org_id, p.job_id) on conflict (org_id, job_id) do nothing;
  -- the lead is won
  if p.lead_id is not null then
    update crm.leads set won_at = coalesce(won_at, now()), converted_job_id = coalesce(converted_job_id, p.job_id)
     where id = p.lead_id and lost_at is null;
  end if;

  select (x ->> 'requested_cents')::bigint into v_dep from jsonb_array_elements(coalesce(v_pay, '[]'::jsonb)) x where x ->> 'kind' = 'DEPOSIT' limit 1;
  r := jsonb_build_object('job_id', p.job_id, 'estimate_id', p.estimate_id, 'contract_cents', p.total_cents, 'grand_total_cents', p.grand_total_cents,
                          'deposit_cents', coalesce(v_dep, 0), 'schedule', v_sched, 'payment_schedule', coalesce(v_pay, '[]'::jsonb),
                          'selections_created', v_sel, 'household_invites', v_house, 'warnings', to_jsonb(v_warn),
                          'method', p_method, 'signer', p_signer);
  update pm.res_proposals
     set status = 'ACCEPTED', accepted_at = now(), accepted_by = pm.current_user_id(), signed_at = coalesce(signed_at, now()),
         signed_by_name = coalesce(signed_by_name, p_signer), sign_method = coalesce(sign_method, p_method), result = r
   where id = p.id;
  perform set_config('pm.access_entry', v_prev, true);
  perform pm.log_activity(p.org_id, p.location_id, p.job_id, 'proposal.accepted', 'res_proposals', p.id,
    format('Proposal accepted (%s): job built — %s selections, deposit %s cents', coalesce(p_signer, 'signed'), v_sel, coalesce(v_dep, 0)), r);
  return r;
end $$;

-- In person / on the tablet: the homeowner signs here (or chooses different options first).
create or replace function pm.res_accept_proposal(p_proposal uuid, p_signer_name text, p_method text default 'IN_PERSON',
                                                  p_option_ids uuid[] default null, p_signature_document uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; e pm.estimates%rowtype; v_prev text; v_new uuid; v_changed boolean := false; v_appr uuid;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.status = 'ACCEPTED' then return p.result; end if;
  if p.status not in ('DRAFT','SENT') then raise exception 'PM_RES_PROPOSAL_STATE: the proposal is %', lower(p.status) using errcode = '22023'; end if;
  if p_signer_name is null or btrim(p_signer_name) = '' then raise exception 'PM_INVALID: the homeowner''s name is required' using errcode = '22023'; end if;
  if coalesce(p_method, 'IN_PERSON') not in ('IN_PERSON','PORTAL','EMAIL','PHONE','E_SIGNATURE') then
    raise exception 'PM_INVALID: unknown signing method' using errcode = '22023';
  end if;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  if p_option_ids is not null then
    v_changed := exists (select 1 from pm.res_proposal_options o where o.org_id = p.org_id and o.proposal_id = p.id
                          and o.is_selected is distinct from (o.id = any (p_option_ids)));
  end if;
  select * into e from pm.estimates where org_id = p.org_id and id = p.estimate_id;
  if v_changed and e.status = 'SENT' then
    v_new := pm.revise_estimate(e.id);
    update pm.res_proposals set estimate_id = v_new, version = version + 1, status = 'DRAFT' where id = p.id;
    select * into e from pm.estimates where id = v_new;
  end if;
  if v_changed then
    update pm.res_proposal_options o set is_selected = (o.id = any (p_option_ids)) where o.org_id = p.org_id and o.proposal_id = p.id;
  end if;
  perform pm._res_proposal_totals(p.id);
  perform pm._res_validate_proposal(p.id);
  if e.status = 'DRAFT' then perform pm._res_sync_estimate(p.id); end if;
  update pm.res_proposals set signed_at = now(), signed_by_name = btrim(p_signer_name), sign_method = coalesce(p_method, 'IN_PERSON') where id = p.id;
  insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, method, signature_document_id, amount_cents, snapshot, recorded_by)
  values (p.org_id, p.job_id, 'estimates', p.estimate_id, 'APPROVED', btrim(p_signer_name), coalesce(p_method, 'IN_PERSON'), p_signature_document,
          (select total_cents from pm.res_proposals where id = p.id),
          jsonb_build_object('proposal_id', p.id, 'options', to_jsonb(coalesce(p_option_ids, '{}'::uuid[]))), pm.current_user_id())
  returning id into v_appr;
  perform pm.accept_estimate((select estimate_id from pm.res_proposals where id = p.id));
  perform set_config('pm.access_entry', v_prev, true);
  return pm._res_complete_acceptance(p.id, coalesce(p_method, 'IN_PERSON'), btrim(p_signer_name)) || jsonb_build_object('client_approval_id', v_appr);
end $$;

-- E-sign path: the estimate's proposal document was signed and lib/esign accepted the estimate;
-- the residential half runs at commit (deferred), as the same caller.
create or replace function pm.tg_res_estimate_accepted() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; v_signer text;
begin
  select * into p from pm.res_proposals x where x.org_id = new.org_id and x.estimate_id = new.id and x.status in ('DRAFT','SENT');
  if p.id is null then return null; end if;
  select string_agg(s.typed_name, ' & ' order by s.position) into v_signer
    from pm.esign_envelopes e join pm.esign_signers s on s.envelope_id = e.id
   where e.org_id = new.org_id and e.id = p.envelope_id and s.status = 'signed';
  perform pm._res_complete_acceptance(p.id, 'E_SIGNATURE', coalesce(v_signer, new.accepted_by));
  return null;
end $$;
drop trigger if exists trg_res_estimate_accepted on pm.estimates;
create constraint trigger trg_res_estimate_accepted after update of status on pm.estimates
  deferrable initially deferred for each row
  when (new.status = 'ACCEPTED' and old.status is distinct from 'ACCEPTED')
  execute function pm.tg_res_estimate_accepted();

-- Link the proposal's signature request (the app sends the PDF through lib/esign requestSignature).
create or replace function pm.res_link_proposal_envelope(p_proposal uuid, p_envelope uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; e pm.esign_envelopes%rowtype; f pm.doc_files%rowtype;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id() for update;
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  select * into e from pm.esign_envelopes x where x.id = p_envelope and x.org_id = p.org_id;
  select * into f from pm.doc_files x where x.id = e.file_id;
  if e.id is null or f.subject_table is distinct from 'estimates' or f.subject_id is distinct from p.estimate_id then
    raise exception 'PM_INVALID: that signature request is not for this proposal''s document' using errcode = '22023';
  end if;
  update pm.res_proposals set envelope_id = e.id, file_id = f.id where id = p.id;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Selections: allowance position, preview, choose → CO + deposit + PO, reminders, reconcile
-- ----------------------------------------------------------------------------
-- The allowance a selection draws on: amount, what other approved selections already used, remaining.
create or replace function pm._res_allowance_position(p_selection uuid)
returns table (allowance_id uuid, allowance_cents bigint, used_by_others_cents bigint, remaining_cents bigint, shared boolean)
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; v_a bigint; v_used bigint := 0;
begin
  select * into s from pm.selections x where x.id = p_selection;
  if s.allowance_id is not null then
    select al.allowance_cents into v_a from pm.allowances al where al.org_id = s.org_id and al.id = s.allowance_id;
    select coalesce(sum(x.chosen_total_cents), 0) into v_used from pm.selections x
     where x.org_id = s.org_id and x.allowance_id = s.allowance_id and x.id <> s.id and x.status = 'APPROVED';
    return query select s.allowance_id, v_a, v_used, v_a - v_used,
      exists (select 1 from pm.selections x where x.org_id = s.org_id and x.allowance_id = s.allowance_id and x.id <> s.id);
  else
    v_a := coalesce(s.allowance_cents, case when jsonb_typeof(s.ext -> 'allowance_cents') = 'number' then (s.ext ->> 'allowance_cents')::bigint end);
    return query select null::uuid, v_a, 0::bigint, v_a, false;
  end if;
end $$;

-- What each option does to the allowance BEFORE the homeowner picks (RES-33).
--   over  = max(0, option − max(remaining, 0))   (the change-order amount if chosen)
--   under = max(0, remaining − option)             (credited at reconciliation)
create or replace function pm.res_selection_preview(p_selection uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.selections%rowtype; a record; v_cv boolean; v_opts jsonb;
begin
  select * into s from pm.selections x where x.id = p_selection and x.org_id = public.get_org_id();
  if s.id is null then raise exception 'PM_FORBIDDEN: selection % not found', p_selection using errcode = '42501'; end if;
  v_cv := pm.access_is_service() or exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = s.job_id);
  select * into a from pm._res_allowance_position(s.id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'label', o.label, 'description', o.description, 'vendor_id', o.vendor_id, 'vendor_sku', o.vendor_sku,
           'finish', o.finish, 'image_url', o.image_url, 'vendor_url', o.vendor_url, 'lead_time_days', o.lead_time_days,
           'is_recommended', o.is_recommended, 'qty', o.qty, 'uom', o.uom,
           'amount_cents', case when v_cv then o.amount_cents end,
           'over_cents', case when v_cv and a.allowance_cents is not null then greatest(0, o.amount_cents - greatest(a.remaining_cents, 0)) end,
           'under_cents', case when v_cv and a.allowance_cents is not null then greatest(0, a.remaining_cents - o.amount_cents) end,
           'needed_by_on', case when s.install_task_id is not null then
               (select coalesce(t.early_start, t.start_on) - coalesce(o.lead_time_days, 0) - coalesce(s.buffer_days, 5) from pm.tasks t where t.id = s.install_task_id) end)
         order by o.sort, o.label), '[]'::jsonb)
    into v_opts
    from pm.selection_options o where o.org_id = s.org_id and o.selection_id = s.id and o.client_visible;
  return jsonb_build_object('selection_id', s.id, 'job_id', s.job_id, 'title', s.title, 'category', s.category, 'room', s.room,
    'status', s.status, 'due_on', s.due_on, 'needed_by_on', s.needed_by_on, 'at_risk', s.at_risk,
    'allowance_id', a.allowance_id, 'shared', a.shared,
    'allowance_cents', case when v_cv then a.allowance_cents end,
    'used_by_others_cents', case when v_cv then a.used_by_others_cents end,
    'remaining_cents', case when v_cv then a.remaining_cents end,
    'money_visible', v_cv, 'options', v_opts);
end $$;

-- Approve a change order the customer signed: the approvals engine when a rule applies, else the
-- CO's own approval. Returns 'approved' | 'awaiting_internal_approval'.
create or replace function pm._res_customer_signed_co(p_co uuid, p_reason text) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v jsonb; v_prev text := coalesce(current_setting('pm.access_entry', true), '');
begin
  perform set_config('pm.access_entry', 'on', true);
  begin
    v := pm.approval_decide('change_order', p_co, 'approve', p_reason, null, null, 'api');
    if v ->> 'status' = 'not_needed' then
      -- No approval chain at this company: the change order is approved only by someone who holds
      -- projects.change_orders:approve on its job (security review MEDIUM — the nested call skips
      -- approve_change_order's own guard, so the capability is checked here). Otherwise it stays
      -- signed by the customer and waits for an approver.
      if pm.access_is_service() or pm.access_can_row('projects.change_orders', 'approve', 'change_orders', p_co) then
        perform pm.approve_change_order(p_co);
        v := jsonb_build_object('status', 'approved');
      else
        v := jsonb_build_object('status', 'awaiting');
      end if;
    end if;
  exception when insufficient_privilege then
    v := jsonb_build_object('status', 'submitted', 'error', sqlerrm);
  end;
  perform set_config('pm.access_entry', v_prev, true);
  return case when v ->> 'status' = 'approved' then 'approved' else 'awaiting_internal_approval' end;
end $$;

-- The one flow (RES-33/35): client approval → allowance CO (signed by the customer) → deposit or
-- next-milestone add → draft PO + procurement item → vendor deposit request.
create or replace function pm.res_choose_selection(
  p_selection uuid, p_option uuid, p_approver_name text, p_method text default 'IN_PERSON', p_approver_email text default null,
  p_signature_document uuid default null, p_overage_billing text default null, p_create_po boolean default true)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  s pm.selections%rowtype; o pm.selection_options%rowtype; a record; v_over bigint; v_under bigint; v_appr uuid; v_co uuid;
  v_co_state text; v_rule text; v_dep uuid; v_po uuid; v_line uuid; v_proc uuid; v_vdep uuid; v_cost bigint; v_cc uuid; v_loc uuid;
  v_warn text[] := '{}'; v_prev text; v_next uuid; v_deliv uuid; v_lead int; v_cost_impact bigint;
begin
  select * into s from pm.selections x where x.id = p_selection and x.org_id = public.get_org_id() for update;
  if s.id is null then raise exception 'PM_FORBIDDEN: selection % not found', p_selection using errcode = '42501'; end if;
  select * into o from pm.selection_options x where x.org_id = s.org_id and x.selection_id = s.id and x.id = p_option;
  if o.id is null then raise exception 'PM_INVALID: option % is not on this selection', p_option using errcode = '22023'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = s.job_id;
  select * into a from pm._res_allowance_position(s.id);
  v_over := case when a.allowance_cents is not null then greatest(0, o.amount_cents - greatest(a.remaining_cents, 0)) else 0 end;
  v_under := case when a.allowance_cents is not null then greatest(0, a.remaining_cents - o.amount_cents) else 0 end;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_appr := pm.approve_selection(s.id, o.id, p_approver_name, coalesce(p_method, 'IN_PERSON'), p_approver_email, null, p_signature_document, null);
  perform set_config('pm.access_entry', v_prev, true);

  v_cost := pm.res_round(o.qty * coalesce(o.unit_cost_cents, 0)) + o.freight_cents;
  v_cc := coalesce((select al.cost_code_id from pm.allowances al where al.org_id = s.org_id and al.id = s.allowance_id), pm.access_try_uuid(s.ext ->> '_res_cost_code_id'));
  if v_over > 0 then
    v_cost_impact := case when o.amount_cents > 0 then pm.res_round(v_cost::numeric * v_over / o.amount_cents) else 0 end;
    insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, cost_impact_cents, co_type, initiated_by,
                                  reason_code, allowance_id, selection_id, requested_at, priced_at, signed_at, signer_name, client_approval_id, created_by)
    values (s.org_id, s.job_id, left(format('Allowance overage — %s: %s', s.title, o.label), 200),
            format('%s chose %s (%s cents). Allowance remaining %s cents; overage %s cents.', btrim(p_approver_name), o.label, o.amount_cents,
                   greatest(a.remaining_cents, 0), v_over),
            'ALLOWANCE', 'COR', v_over, v_cost_impact, 'ALLOWANCE', 'CLIENT', 'ALLOWANCE_OVERAGE', s.allowance_id, s.id, now(), now(), now(),
            btrim(p_approver_name), v_appr, 'customer:' || v_appr::text)
    returning id into v_co;
    insert into pm.res_change_order_lines (org_id, change_order_id, cost_code_id, description, qty, uom, unit_cost_cents, cost_cents, price_cents)
    values (s.org_id, v_co, v_cc, left(format('%s over allowance', o.label), 500), 1, 'LS', v_cost_impact, v_cost_impact, v_over);
    v_co_state := pm._res_customer_signed_co(v_co, 'Signed by the customer with the selection');

    v_rule := coalesce(p_overage_billing,
                       (select t.overage_billing from pm.res_job_terms t where t.org_id = s.org_id and t.job_id = s.job_id),
                       (select x.overage_billing from pm.res_settings x where x.org_id = s.org_id and x.location_id = v_loc), 'UPFRONT');
    if v_rule = 'UPFRONT' then
      begin
        perform set_config('pm.access_entry', 'on', true);
        v_dep := pm.request_deposit(s.job_id, v_over, left(format('Allowance overage — %s: %s', s.title, o.label), 200), current_date);
        perform set_config('pm.access_entry', v_prev, true);
      exception when others then
        perform set_config('pm.access_entry', v_prev, true);
        v_warn := v_warn || ('deposit: ' || sqlerrm);
        v_rule := 'NEXT_MILESTONE';
      end;
    end if;
    if v_rule = 'NEXT_MILESTONE' then
      select ps.id into v_next from pm.res_payment_schedule ps
       where ps.org_id = s.org_id and ps.job_id = s.job_id and ps.kind in ('MILESTONE','FINAL') and ps.status in ('PLANNED','SCHEDULED','HELD')
       order by ps.seq limit 1;
      if v_next is not null then
        update pm.res_payment_schedule set added_cents = added_cents + v_over where id = v_next;
        update pm.tasks t set billing_amount_cents = coalesce(t.billing_amount_cents, 0) + v_over
          from pm.res_payment_schedule ps where ps.id = v_next and t.id = ps.billing_task_id;
      else
        v_warn := v_warn || 'no open payment milestone: bill the overage from the change order'::text;
      end if;
    end if;
  end if;

  -- draft PO to the option's vendor (purchasing rights required), procurement item, vendor deposit
  if p_create_po and o.vendor_id is not null then
    if pm.access_is_service() or pm.access_can_job('projects.commitments', 'create', s.job_id) then
      insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, description, retainage_pct, created_by)
      values (s.org_id, v_loc, s.job_id, o.vendor_id, 'PO', left(format('Selection: %s — %s', s.title, o.label), 200),
              format('Selection approved by %s. SKU %s.', btrim(p_approver_name), coalesce(o.vendor_sku, '—')), 0, pm.current_user_id())
      returning id into v_po;
      insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, unit_cost_cents, amount_cents)
      values (s.org_id, v_po, 1, v_cc, 'MATERIALS', left(coalesce(o.description, o.label), 500), o.qty, o.uom, o.unit_cost_cents, v_cost)
      returning id into v_line;
      perform set_config('pm.access_entry', 'on', true);
      v_proc := pm.create_procurement_from_selection(s.id, o.vendor_id);
      perform set_config('pm.access_entry', v_prev, true);
      update pm.procurement_items set commitment_id = v_po, commitment_line_id = v_line where id = v_proc;
      if o.vendor_deposit_pct is not null and v_cost > 0 then
        insert into pm.res_vendor_deposits (org_id, job_id, commitment_id, vendor_id, selection_id, pct, amount_cents, memo)
        values (s.org_id, s.job_id, v_po, o.vendor_id, s.id, o.vendor_deposit_pct, greatest(pm.res_round(v_cost * o.vendor_deposit_pct), 1),
                left(format('Special-order deposit: %s', o.label), 500))
        returning id into v_vdep;
      end if;
      -- delivery milestone ahead of the install task (lead time drives the schedule)
      v_lead := coalesce(o.lead_time_days, s.lead_time_days);
      if s.install_task_id is not null and v_lead is not null then
        insert into pm.tasks (org_id, job_id, title, is_milestone, duration_days, status, constraint_type, constraint_date, sort, created_by)
        values (s.org_id, s.job_id, left('Delivery: ' || s.title, 200), true, 0, 'TODO', 'SNET', current_date + v_lead,
                coalesce((select t.sort from pm.tasks t where t.id = s.install_task_id), 0), pm.current_user_id())
        returning id into v_deliv;
        insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days) values (s.org_id, v_deliv, s.install_task_id, 'FS', 0) on conflict do nothing;
        begin perform pm._schedule_run(s.job_id); exception when others then v_warn := v_warn || ('schedule: ' || sqlerrm); end;
      end if;
    else
      v_warn := v_warn || 'purchase order not drafted: you do not have purchasing rights on this job'::text;
    end if;
  end if;
  update pm.selections set lead_time_days = coalesce(o.lead_time_days, lead_time_days), at_risk = false where id = s.id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'selection.chosen', 'selections', s.id,
    format('%s chose %s for %s%s', btrim(p_approver_name), o.label, s.title, case when v_over > 0 then format(' (%s cents over allowance)', v_over) else '' end),
    jsonb_build_object('change_order_id', v_co, 'deposit_request_id', v_dep, 'commitment_id', v_po, 'vendor_deposit_id', v_vdep));
  return jsonb_build_object('client_approval_id', v_appr, 'over_cents', v_over, 'under_cents', v_under, 'change_order_id', v_co,
    'change_order_state', v_co_state, 'overage_billing', case when v_over > 0 then v_rule end, 'deposit_request_id', v_dep,
    'commitment_id', v_po, 'procurement_item_id', v_proc, 'vendor_deposit_id', v_vdep, 'delivery_task_id', v_deliv, 'warnings', to_jsonb(v_warn));
end $$;

-- Remind the household about selections due soon (customer.selection_reminder; held until go-live).
create or replace function pm.res_send_selection_reminders(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; st pm.res_settings%rowtype; s record; h record; n int := 0; v_any boolean;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job and j.org_id = public.get_org_id();
  if v_org is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  select * into st from pm.res_settings x where x.org_id = v_org and x.location_id = v_loc;
  perform pm._res_refresh_deadlines(p_job);
  for s in select * from pm.selections x where x.org_id = v_org and x.job_id = p_job and x.status in ('OPEN','PROPOSED','REJECTED')
              and x.client_visible and x.due_on is not null and x.due_on <= current_date + coalesce(st.reminder_lead_days, 7)
              and (x.reminder_sent_at is null or x.reminder_sent_at < now() - make_interval(days => coalesce(st.reminder_every_days, 3))) loop
    v_any := false;
    for h in select * from pm.res_household_members m where m.org_id = v_org and m.job_id = p_job and m.contact_id is not null
                and m.portal_status <> 'REVOKED' loop
      if h.notify_sms and h.phone is not null then
        begin
          perform core.notify_customer(v_org, v_loc, p_job, 'customer.selection_reminder', 'sms', h.contact_id, null,
            left(format('Reminder: please choose your %s (%s) by %s so the schedule holds.', lower(s.category), s.title, to_char(s.due_on, 'Mon DD')), 300),
            '/selections?job=' || p_job::text, 'selrem:' || s.id::text || ':' || current_date::text || ':sms:' || h.id::text, pm.current_user_id());
          v_any := true;
        exception when others then null;
        end;
      end if;
      if h.notify_email and h.email is not null then
        begin
          perform core.notify_customer(v_org, v_loc, p_job, 'customer.selection_reminder', 'email', h.contact_id,
            left(format('Selection due: %s', s.title), 200),
            format('Please choose your %s (%s) by %s. Choosing on time keeps your project on schedule.', lower(s.category), s.title, to_char(s.due_on, 'FMMonth DD')),
            '/selections?job=' || p_job::text, 'selrem:' || s.id::text || ':' || current_date::text || ':email:' || h.id::text, pm.current_user_id());
          v_any := true;
        exception when others then null;
        end;
      end if;
    end loop;
    if v_any then
      update pm.selections set reminder_sent_at = now(), reminder_count = reminder_count + 1 where id = s.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Reconcile an allowance once every selection on it is decided: the net variance not already
-- covered by overage change orders becomes an add or deduct CO; the allowance closes (RES-81).
create or replace function pm.res_reconcile_allowance(p_allowance uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare al pm.allowances%rowtype; v_chosen bigint; v_cos bigint; v_net bigint; v_open int; v_co uuid; v_state text; v_loc uuid;
begin
  select * into al from pm.allowances x where x.id = p_allowance and x.org_id = public.get_org_id() for update;
  if al.id is null then raise exception 'PM_FORBIDDEN: allowance % not found', p_allowance using errcode = '42501'; end if;
  if al.status <> 'OPEN' then raise exception 'PM_ALLOWANCE_CLOSED: %', al.description using errcode = '22023'; end if;
  select count(*) filter (where s.status not in ('APPROVED','VOID')), coalesce(sum(s.chosen_total_cents) filter (where s.status = 'APPROVED'), 0)
    into v_open, v_chosen from pm.selections s where s.org_id = al.org_id and s.allowance_id = al.id;
  if v_open > 0 then raise exception 'PM_RES_SELECTIONS_OPEN: % selection(s) on this allowance are still open', v_open using errcode = '22023'; end if;
  select coalesce(sum(c.amount_cents), 0) into v_cos from pm.change_orders c
   where c.org_id = al.org_id and c.allowance_id = al.id and c.stage not in ('VOID','REJECTED');
  v_net := (v_chosen - al.allowance_cents) - v_cos;
  if v_net <> 0 then
    insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, cost_impact_cents, co_type, initiated_by,
                                  reason_code, allowance_id, requested_at, priced_at, created_by)
    values (al.org_id, al.job_id, left(format('Allowance %s — %s', case when v_net < 0 then 'credit' else 'reconciliation' end, al.description), 200),
            format('Allowance %s cents; selections %s cents; overage already on change orders %s cents.', al.allowance_cents, v_chosen, v_cos),
            'ALLOWANCE', 'COR', v_net, null, 'ALLOWANCE', 'BUILDER', case when v_net < 0 then 'ALLOWANCE_CREDIT' else 'ALLOWANCE_OVERAGE' end,
            al.id, now(), now(), pm.current_user_id())
    returning id into v_co;
    insert into pm.res_change_order_lines (org_id, change_order_id, cost_code_id, description, qty, uom, price_cents)
    values (al.org_id, v_co, al.cost_code_id, left('Allowance reconciliation: ' || al.description, 500), 1, 'LS', v_net);
  end if;
  update pm.allowances set actual_cents = v_chosen, status = 'CLOSED', closed_at = now(), variance_co_id = coalesce(v_co, variance_co_id) where id = al.id;
  select j.location_id into v_loc from core.jobs j where j.id = al.job_id;
  perform pm.log_activity(al.org_id, v_loc, al.job_id, 'allowance.reconciled', 'allowances', al.id,
    format('Allowance %s reconciled: net %s cents', al.description, v_net), jsonb_build_object('change_order_id', v_co, 'net_cents', v_net));
  return jsonb_build_object('allowance_id', al.id, 'chosen_cents', v_chosen, 'allowance_cents', al.allowance_cents, 'prior_co_cents', v_cos,
                            'net_cents', v_net, 'change_order_id', v_co);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Change orders: field requests, demo discovery, pricing, signatures, internal, trade COs
-- ----------------------------------------------------------------------------
-- From the field: photo + voice; "do not proceed until signed" unless it is an emergency.
create or replace function pm.res_request_field_co(p_job uuid, p_title text, p_note text default null, p_transcript text default null,
                                                   p_photo_documents uuid[] default '{}', p_voice_document uuid default null,
                                                   p_demo_discovery boolean default false, p_emergency boolean default false, p_area text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid; v_id uuid; v_clause text; v_pm uuid[]; v_type text;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  if v_loc is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  if p_title is null or btrim(p_title) = '' then raise exception 'PM_INVALID: say what you found' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_photo_documents, '{}')) d where not exists (select 1 from public.documents x where x.id = d and x.org_id = v_org)) then
    raise exception 'PM_INVALID: a photo is not in this organization' using errcode = '22023';
  end if;
  v_type := case when p_demo_discovery then 'DEMO_DISCOVERY' else 'FIELD_REQUEST' end;
  if p_demo_discovery then
    select x.unforeseen_clause into v_clause from pm.res_settings x where x.org_id = v_org and x.location_id = v_loc;
    v_clause := coalesce(v_clause, 'Concealed conditions found after demolition are not part of the contract price.');
  end if;
  insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, co_type, initiated_by, reason_code,
                                stop_work, emergency, contract_clause, evidence_document_ids, voice_document_id, transcript, area, requested_at, created_by)
  values (v_org, p_job, left(btrim(p_title), 200), left(p_note, 4000), case when p_demo_discovery then 'Hidden condition' else 'Field request' end,
          'PCO', 0, v_type, 'FIELD', case when p_demo_discovery then 'HIDDEN_CONDITION' else 'CLIENT_REQUEST' end,
          not coalesce(p_emergency, false), coalesce(p_emergency, false), v_clause, coalesce(p_photo_documents, '{}'), p_voice_document,
          left(p_transcript, 8000), left(p_area, 120), now(), pm.current_user_id())
  returning id into v_id;
  -- tell the PM team (mandatory event: a stop-work item must be seen)
  select coalesce(array_agg(distinct m.membership_id), '{}') into v_pm from pm.job_members m
   where m.org_id = v_org and m.job_id = p_job and m.slot in ('pm','apm','superintendent');
  begin
    perform core.notify_fanout(v_org, 'change_order.requested', v_loc, p_job, 'change_order', v_id, pm._res_me(), v_pm,
      left(format('%s: %s', case when p_demo_discovery then 'Hidden condition' else 'Change requested' end, btrim(p_title)), 200),
      case when coalesce(p_emergency, false) then 'Emergency — work continued. Price it and send for signature.'
           else 'Work in this area is stopped until the homeowner signs. Price it and send it.' end,
      null, null, '/change-orders?co=' || v_id::text, 'co.requested:' || v_id::text, '{}'::jsonb, null, 'attention', false);
  exception when others then null;
  end;
  perform pm.log_activity(v_org, v_loc, p_job, 'change_order.requested', 'change_orders', v_id,
    format('%s requested from the field: %s%s', case when p_demo_discovery then 'Hidden-condition change order' else 'Change order' end, btrim(p_title),
           case when coalesce(p_emergency, false) then ' (emergency — proceeding)' else ' — do not proceed until signed' end),
    jsonb_build_object('photos', cardinality(coalesce(p_photo_documents, '{}')), 'voice', p_voice_document is not null, 'stop_work', not coalesce(p_emergency, false)));
  return v_id;
end $$;

-- Price a CO from lines (catalog or typed): amount = Σ price, cost impact = Σ cost. PCO / COR only.
create or replace function pm.res_price_change_order(p_co uuid, p_lines jsonb, p_schedule_days int default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; x jsonb; ci pm.res_catalog_items%rowtype; v_qty numeric; v_uc bigint; v_mk numeric; v_cost bigint; v_price bigint;
  v_tc bigint := 0; v_tp bigint := 0; i int := 0; v_loc uuid; v_def numeric;
begin
  select * into co from pm.change_orders c where c.id = p_co and c.org_id = public.get_org_id() for update;
  if co.id is null then raise exception 'PM_FORBIDDEN: change order % not found', p_co using errcode = '42501'; end if;
  if co.stage not in ('PCO','COR') then raise exception 'PM_CO_NOT_EDITABLE: change order % is %', co.number, co.stage using errcode = '22023'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'PM_INVALID: price a change order with 1–100 lines' using errcode = '22023';
  end if;
  select j.location_id into v_loc from core.jobs j where j.id = co.job_id;
  select coalesce(s.default_markup_pct, 0.25) into v_def from pm.res_settings s where s.org_id = co.org_id and s.location_id = v_loc;
  delete from pm.res_change_order_lines l where l.org_id = co.org_id and l.change_order_id = co.id;
  for x in select value from jsonb_array_elements(p_lines) loop
    i := i + 1;
    ci := null;
    if pm.access_try_uuid(x ->> 'catalog_item_id') is not null then
      select * into ci from pm.res_catalog_items c where c.org_id = co.org_id and c.id = pm.access_try_uuid(x ->> 'catalog_item_id') and c.location_id = v_loc;
    end if;
    v_qty := coalesce((x ->> 'qty')::numeric, 1);
    v_uc := coalesce((x ->> 'unit_cost_cents')::bigint, ci.unit_cost_cents, 0);
    v_mk := coalesce((x ->> 'markup_pct')::numeric, ci.markup_pct, v_def, 0);
    v_cost := pm.res_round(v_qty * v_uc);
    v_price := coalesce(case when (x ->> 'price_cents') is not null then (x ->> 'price_cents')::bigint end,
                        case when (x ->> 'unit_price_cents') is not null then pm.res_round(v_qty * (x ->> 'unit_price_cents')::bigint) end,
                        pm.res_round(v_cost * (1 + v_mk)));
    if co.co_type = 'NO_CHARGE' then v_price := 0; end if;
    insert into pm.res_change_order_lines (org_id, change_order_id, catalog_item_id, cost_code_id, description, qty, uom, unit_cost_cents, markup_pct,
                                           cost_cents, price_cents, sort)
    values (co.org_id, co.id, ci.id, coalesce(pm.access_try_uuid(x ->> 'cost_code_id'), ci.cost_code_id),
            left(coalesce(nullif(btrim(x ->> 'description'), ''), ci.name, 'Change'), 500), v_qty, coalesce(x ->> 'uom', ci.uom, 'EA'),
            v_uc, v_mk, v_cost, v_price, i);
    v_tc := v_tc + v_cost; v_tp := v_tp + v_price;
  end loop;
  update pm.change_orders set amount_cents = v_tp, cost_impact_cents = v_tc, schedule_days = coalesce(p_schedule_days, schedule_days),
         priced_at = now(), stage = 'COR' where id = co.id;
  perform pm.log_activity(co.org_id, v_loc, co.job_id, 'change_order.priced', 'change_orders', co.id,
    format('%s priced at %s cents', co.number, v_tp), jsonb_build_object('lines', i));
  return jsonb_build_object('change_order_id', co.id, 'amount_cents', v_tp, 'cost_impact_cents', v_tc, 'lines', i);
end $$;

-- The homeowner signed in person (tablet) or by fast-sign link: record it, then approve (engine).
create or replace function pm.res_record_co_signature(p_co uuid, p_signer_name text, p_method text default 'IN_PERSON',
                                                      p_signature_document uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; v_appr uuid; v_state text; v_loc uuid;
begin
  select * into co from pm.change_orders c where c.id = p_co and c.org_id = public.get_org_id() for update;
  if co.id is null then raise exception 'PM_FORBIDDEN: change order % not found', p_co using errcode = '42501'; end if;
  if co.stage not in ('PCO','COR') then raise exception 'PM_CO_NOT_APPROVABLE: change order % is %', co.number, co.stage using errcode = '22023'; end if;
  if p_signer_name is null or btrim(p_signer_name) = '' then raise exception 'PM_INVALID: the homeowner''s name is required' using errcode = '22023'; end if;
  if co.co_type <> 'NO_CHARGE' and co.priced_at is null and co.amount_cents = 0 then
    raise exception 'PM_RES_CO_UNPRICED: price the change order before the homeowner signs' using errcode = '22023';
  end if;
  insert into pm.client_approvals (org_id, job_id, subject_table, subject_id, decision, approver_name, method, signature_document_id, amount_cents, snapshot, recorded_by)
  values (co.org_id, co.job_id, 'change_orders', co.id, 'APPROVED', btrim(p_signer_name), coalesce(p_method, 'IN_PERSON'), p_signature_document, co.amount_cents,
          jsonb_build_object('number', co.number, 'title', co.title, 'amount_cents', co.amount_cents, 'schedule_days', co.schedule_days,
                             'lines', (select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'qty', l.qty, 'price_cents', l.price_cents) order by l.sort), '[]'::jsonb)
                                         from pm.res_change_order_lines l where l.org_id = co.org_id and l.change_order_id = co.id)),
          pm.current_user_id())
  returning id into v_appr;
  update pm.change_orders set signed_at = now(), signer_name = btrim(p_signer_name), client_approval_id = v_appr, stage = 'COR' where id = co.id;
  v_state := pm._res_customer_signed_co(co.id, format('Signed by %s (%s)', btrim(p_signer_name), lower(coalesce(p_method, 'in person'))));
  select j.location_id into v_loc from core.jobs j where j.id = co.job_id;
  perform pm.log_activity(co.org_id, v_loc, co.job_id, 'change_order.client_signed', 'change_orders', co.id,
    format('%s signed %s', btrim(p_signer_name), co.number), jsonb_build_object('state', v_state, 'method', p_method));
  return jsonb_build_object('change_order_id', co.id, 'client_approval_id', v_appr, 'state', v_state);
end $$;

-- No-charge / internal CO: builder error or goodwill — cost moves to the right reason, price 0.
create or replace function pm.res_create_internal_co(p_job uuid, p_title text, p_reason_code text, p_cost_cents bigint, p_cost_code uuid default null,
                                                     p_note text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid; v_id uuid;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  if v_loc is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  if p_reason_code not in ('BUILDER_ERROR','GOODWILL','VENDOR_ERROR','DAMAGE','OTHER') then
    raise exception 'PM_INVALID: an internal change order needs a reason (builder error, goodwill, vendor error, damage, other)' using errcode = '22023';
  end if;
  if p_cost_cents is null or p_cost_cents < 0 then raise exception 'PM_INVALID: cost must be ≥ 0' using errcode = '22023'; end if;
  insert into pm.change_orders (org_id, job_id, title, description, reason, stage, amount_cents, cost_impact_cents, co_type, initiated_by, reason_code,
                                requested_at, priced_at, created_by)
  values (v_org, p_job, left(coalesce(nullif(btrim(p_title), ''), 'Internal change'), 200), left(p_note, 4000), 'Internal (no charge)', 'COR', 0, p_cost_cents,
          'NO_CHARGE', 'BUILDER', p_reason_code, now(), now(), pm.current_user_id())
  returning id into v_id;
  insert into pm.res_change_order_lines (org_id, change_order_id, cost_code_id, description, qty, uom, unit_cost_cents, cost_cents, price_cents)
  values (v_org, v_id, p_cost_code, left(coalesce(nullif(btrim(p_title), ''), 'Internal change'), 500), 1, 'LS', p_cost_cents, p_cost_cents, 0);
  perform pm.log_activity(v_org, v_loc, p_job, 'change_order.internal', 'change_orders', v_id,
    format('No-charge change order (%s): %s cents of cost', lower(replace(p_reason_code, '_', ' ')), p_cost_cents), jsonb_build_object('reason_code', p_reason_code));
  return v_id;
end $$;

-- Matching trade change orders for an owner CO: one DRAFT commitment change per open commitment
-- on each CO line's cost code (RES-43). Returns the drafts.
create or replace function pm.res_propose_trade_cos(p_co uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare co pm.change_orders%rowtype; l record; v_c uuid; v_line uuid; v_id uuid; v_out jsonb := '[]'::jsonb;
begin
  select * into co from pm.change_orders c where c.id = p_co and c.org_id = public.get_org_id();
  if co.id is null then raise exception 'PM_FORBIDDEN: change order % not found', p_co using errcode = '42501'; end if;
  for l in select * from pm.res_change_order_lines x where x.org_id = co.org_id and x.change_order_id = co.id and x.cost_code_id is not null and x.cost_cents <> 0 loop
    select cm.id, cl.id into v_c, v_line from pm.commitments cm
      join pm.commitment_lines cl on cl.org_id = cm.org_id and cl.commitment_id = cm.id and cl.cost_code_id = l.cost_code_id
     where cm.org_id = co.org_id and cm.job_id = co.job_id and cm.status in ('APPROVED','EXECUTED')
     order by cm.approved_at desc nulls last limit 1;
    continue when v_c is null;
    if exists (select 1 from pm.commitment_changes cc where cc.org_id = co.org_id and cc.commitment_id = v_c and cc.owner_co_id = co.id
                 and cc.commitment_line_id = v_line and cc.status <> 'VOID') then continue; end if;
    insert into pm.commitment_changes (org_id, job_id, commitment_id, commitment_line_id, description, reason, amount_cents, owner_co_id, created_by)
    values (co.org_id, co.job_id, v_c, v_line, left(format('%s: %s', co.number, l.description), 300), 'Owner change order', l.cost_cents, co.id, pm.current_user_id())
    returning id into v_id;
    v_out := v_out || jsonb_build_object('commitment_change_id', v_id, 'commitment_id', v_c, 'cost_code_id', l.cost_code_id);
  end loop;
  return v_out;
end $$;

-- Pending CO exposure (RES-42): open COs with age, stop-work and whether work was logged since.
create or replace view pm.v_res_co_exposure with (security_invoker = on) as
select c.id, c.org_id, c.job_id, c.number, c.title, c.co_type, c.stage, c.reason_code, c.initiated_by, c.stop_work, c.emergency,
       c.signed_at, c.signer_name, c.created_at, c.requested_at, c.priced_at,
       (current_date - coalesce(c.requested_at, c.created_at)::date) as age_days,
       case when c.stage = 'APPROVED' then 'approved' when c.stage in ('REJECTED','VOID') then lower(c.stage)
            when c.signed_at is not null then 'signed' when c.priced_at is not null then 'sent' else 'unpriced' end as exposure_state,
       exists (select 1 from pm.time_entries te where te.org_id = c.org_id and te.job_id = c.job_id and te.work_date >= coalesce(c.requested_at, c.created_at)::date)
         and c.stop_work and c.stage in ('PCO','COR') as work_logged_unsigned
  from pm.change_orders c
 where c.stage in ('PCO','COR') or (c.stage = 'APPROVED' and c.approved_at > now() - interval '30 days');
comment on view pm.v_res_co_exposure is '1119 (RES-42): open and recent change orders with age, state and the unsigned-work flag. Amounts: read pm.v_change_orders_masked. Invoker.';

create or replace function pm.res_co_exposure_summary(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_money boolean;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: company % not found', p_location using errcode = '42501';
  end if;
  v_money := pm.access_is_service() or pm.can('projects.contract_value', 'view', p_location);
  return (
    select jsonb_build_object(
      'open', count(*), 'unpriced', count(*) filter (where c.priced_at is null), 'awaiting_signature', count(*) filter (where c.priced_at is not null and c.signed_at is null),
      'signed_awaiting_approval', count(*) filter (where c.signed_at is not null), 'stop_work', count(*) filter (where c.stop_work),
      'older_than_7_days', count(*) filter (where coalesce(c.requested_at, c.created_at) < now() - interval '7 days'),
      'pending_value_cents', case when v_money then coalesce(sum(c.amount_cents) filter (where c.job_id in (select pm.my_money_job_ids('projects.contract_value'))), 0) end)
      from pm.change_orders c join core.jobs j on j.id = c.job_id
     where c.org_id = public.get_org_id() and j.location_id = p_location and c.stage in ('PCO','COR')
       and c.job_id in (select pm.my_job_ids()));
end $$;

-- ----------------------------------------------------------------------------
-- 6. Trade partners
-- ----------------------------------------------------------------------------
insert into core.notification_event_types as e (key, label, description, category, audience, money_cap, mandatory, batch_window_minutes, severity, emit_rpc, sort) values
  ('change_order.requested',  'Change order requested from the field', 'A crew lead found something that needs a change order (work there is stopped until it is signed).', 'approvals', 'internal', null, true, 0, 'attention', false, 85),
  ('trade.schedule_response', 'Trade answered a schedule request', 'A trade partner could not make a date or proposed another one.', 'schedule', 'internal', null, true, 0, 'attention', false, 45),
  ('trade.schedule_request',  'Schedule request to a trade', 'Texts a trade partner the date, address and scope with Confirm / Can''t / Propose a date.', 'schedule', 'customer', null, false, 0, 'info', false, 260),
  ('trade.bid_invite',        'Bid invitation to a trade', 'Invites a trade partner to price a bid package by line.', 'work', 'customer', null, false, 0, 'info', false, 270),
  ('trade.po_ready',          'Purchase order ready for a trade', 'Sends a trade partner their purchase order or work order to accept.', 'work', 'customer', null, false, 0, 'info', false, 280)
on conflict (key) do update set label = excluded.label, description = excluded.description, category = excluded.category,
  audience = excluded.audience, money_cap = excluded.money_cap, mandatory = excluded.mandatory,
  batch_window_minutes = excluded.batch_window_minutes, severity = excluded.severity, emit_rpc = excluded.emit_rpc, sort = excluded.sort;

-- Assign a trade to a task and text them the date / address / scope with a one-time link
-- (the app makes the token; only its sha-256 reaches the database).
create or replace function pm.res_assign_trade(p_task uuid, p_vendor uuid, p_contact uuid default null, p_token_hash text default null,
                                               p_link text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare t pm.tasks%rowtype; v_loc uuid; v_id uuid; v_ct core.contacts%rowtype; v_msg uuid; v_addr text; v_vendor text; v_body text; v_hours int;
begin
  select * into t from pm.tasks x where x.id = p_task and x.org_id = public.get_org_id() for update;
  if t.id is null then raise exception 'PM_FORBIDDEN: task % not found', p_task using errcode = '42501'; end if;
  select v.name into v_vendor from core.vendors v where v.id = p_vendor and v.org_id = t.org_id;
  if v_vendor is null then raise exception 'PM_INVALID: vendor not in this organization' using errcode = '22023'; end if;
  if p_contact is not null then
    select * into v_ct from core.contacts c where c.id = p_contact and c.org_id = t.org_id and c.vendor_id = p_vendor;
    if v_ct.id is null then raise exception 'PM_INVALID: that contact does not work for this vendor' using errcode = '22023'; end if;
  else
    select * into v_ct from core.contacts c where c.org_id = t.org_id and c.vendor_id = p_vendor and c.identity_status = 'active'
     order by c.is_primary desc, c.created_at limit 1;
  end if;
  if p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash must be sha-256 hex' using errcode = '22023'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = t.job_id;
  select x.trade_confirm_hours into v_hours from pm.res_settings x where x.org_id = t.org_id and x.location_id = v_loc;
  update pm.res_task_trades set status = 'CANCELLED' where org_id = t.org_id and task_id = t.id and vendor_id <> p_vendor and status <> 'CANCELLED';
  insert into pm.res_task_trades (org_id, job_id, task_id, vendor_id, contact_id, status, start_on, token_hash, token_expires_at)
  values (t.org_id, t.job_id, t.id, p_vendor, v_ct.id, 'ASSIGNED', coalesce(t.early_start, t.start_on), p_token_hash,
          case when p_token_hash is not null then now() + interval '30 days' end)
  on conflict (org_id, task_id, vendor_id) where status <> 'CANCELLED' do update
    set contact_id = excluded.contact_id, token_hash = coalesce(excluded.token_hash, pm.res_task_trades.token_hash),
        token_expires_at = coalesce(excluded.token_expires_at, pm.res_task_trades.token_expires_at),
        start_on = excluded.start_on, status = 'ASSIGNED', proposed_on = null, responded_at = null
  returning id into v_id;
  update pm.tasks set assigned_vendor_id = p_vendor where id = t.id;
  if v_ct.id is not null and v_ct.phone is not null and p_link is not null then
    select concat_ws(', ', pr.site_address_line1, pr.site_city) into v_addr from pm.projects pr where pr.org_id = t.org_id and pr.job_id = t.job_id;
    v_body := left(format('%s – %s – %s. %s Confirm, say you can''t, or propose a date: %s',
                          coalesce(core.notify_job_label(t.job_id), 'Job'), t.title, coalesce(to_char(coalesce(t.early_start, t.start_on), 'Dy Mon DD'), 'date TBD'),
                          case when v_addr is not null and v_addr <> '' then 'At ' || v_addr || '.' else '' end, p_link), 600);
    begin
      v_msg := core.notify_customer(t.org_id, v_loc, t.job_id, 'trade.schedule_request', 'sms', v_ct.id, null, v_body, null,
                                    'trade:' || v_id::text || ':' || coalesce(p_token_hash, 'x'), pm.current_user_id());
      update pm.res_task_trades set status = 'NOTIFIED', notified_at = now(), message_id = v_msg where id = v_id;
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('task_trade_id', v_id, 'contact_id', v_ct.id, 'message_id', v_msg, 'confirm_window_hours', coalesce(v_hours, 72));
end $$;

-- Rate limits for the no-account links (security review LOW): one hit on a fixed hourly window;
-- true while the bucket is under its limit (a bucket at its limit is refused without a write).
-- Atomic (conditional update / upsert hold the row lock). Each call sweeps up to 200 expired windows.
create or replace function pm._res_hit(p_bucket text, p_limit int) returns boolean
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_start timestamptz := date_trunc('hour', now()); v_hits int;
begin
  if p_limit <= 0 then return false; end if;
  delete from pm.res_rate_counters c where c.ctid in (select x.ctid from pm.res_rate_counters x where x.expires_at <= now() limit 200);
  update pm.res_rate_counters c set hits = c.hits + 1 where c.bucket = p_bucket and c.window_start = v_start and c.hits < p_limit returning c.hits into v_hits;
  if found then return true; end if;
  insert into pm.res_rate_counters as c (bucket, window_start, expires_at, hits) values (p_bucket, v_start, v_start + interval '1 hour', 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < p_limit
  returning c.hits into v_hits;
  return found;
end $$;

-- The gate every public trade-link call passes first. p_client is the address the app route took
-- from the platform's trusted value (x-vercel-forwarded-for / the request ip / the rightmost
-- forwarded hop — never the request body); hashed here, never stored raw. It is advisory: a direct
-- anon RPC caller can vary it, so the caps that do not depend on it are the ceiling — 60 calls /
-- hour per link, 2,000 failed lookups and 20,000 calls overall. Per client: 600 calls and 30 failed
-- lookups. Returns null when allowed, else the refusal jsonb.
create or replace function pm._res_link_gate(p_kind text, p_hash text, p_found boolean, p_client text) returns jsonb
language plpgsql volatile security definer
set search_path = pm, core, public
as $$
declare v_cli text := case when p_client is null or btrim(p_client) = '' then 'unknown'
                           else left(encode(sha256(convert_to(lower(btrim(left(p_client, 200))), 'UTF8')), 'hex'), 32) end;
begin
  if not pm._res_hit('res:all', 20000) or not pm._res_hit('res:cli:' || v_cli, 600) then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  if not p_found then
    if not pm._res_hit('res:bad:' || v_cli, 30) or not pm._res_hit('res:bad:all', 2000) then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
    return null;
  end if;
  if not pm._res_hit('res:link:' || p_kind || ':' || left(p_hash, 32), 60) then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  return null;
end $$;

-- Public (anon, token-scoped): the trade opens the link and confirms, declines or proposes a date.
drop function if exists public.res_trade_respond(text, text, date, text);
create or replace function public.res_trade_respond(p_token text, p_response text default 'VIEW', p_proposed_on date default null,
                                                    p_note text default null, p_client text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.res_task_trades%rowtype; t pm.tasks%rowtype; v_hash text; v_resp text := upper(coalesce(p_response, 'VIEW')); v_pm uuid[]; v_loc uuid;
  v_addr text; v_vendor text; v_gate jsonb;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 200 then
    return coalesce(pm._res_link_gate('trade', '', false, p_client), jsonb_build_object('ok', false, 'reason', 'invalid'));
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into r from pm.res_task_trades x where x.token_hash = v_hash;
  v_gate := pm._res_link_gate('trade', v_hash, r.id is not null, p_client);
  if v_gate is not null then return v_gate; end if;
  if r.id is null or r.status = 'CANCELLED' or r.token_expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into t from pm.tasks x where x.id = r.task_id;
  select v.name into v_vendor from core.vendors v where v.id = r.vendor_id;
  select concat_ws(', ', pr.site_address_line1, pr.site_city, pr.site_state), pr.location_id into v_addr, v_loc
    from pm.projects pr where pr.org_id = r.org_id and pr.job_id = r.job_id;
  if v_resp = 'VIEW' then
    return jsonb_build_object('ok', true, 'status', r.status, 'task', t.title, 'job', core.notify_job_label(r.job_id), 'start_on', coalesce(t.early_start, t.start_on),
                              'duration_days', t.duration_days, 'address', v_addr, 'vendor', v_vendor, 'scope', left(t.description, 2000), 'proposed_on', r.proposed_on);
  end if;
  if v_resp not in ('CONFIRM','DECLINE','PROPOSE') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_resp = 'PROPOSE' and (p_proposed_on is null or p_proposed_on < current_date) then return jsonb_build_object('ok', false, 'reason', 'date'); end if;
  update pm.res_task_trades
     set status = case v_resp when 'CONFIRM' then 'CONFIRMED' when 'DECLINE' then 'DECLINED' else 'PROPOSED' end,
         proposed_on = case when v_resp = 'PROPOSE' then p_proposed_on end, response_note = left(p_note, 1000), responded_at = now(),
         start_on = coalesce(t.early_start, t.start_on)
   where id = r.id;
  perform pm.log_activity(r.org_id, v_loc, r.job_id, 'trade.' || lower(v_resp), 'res_task_trades', r.id,
    format('%s %s %s', coalesce(v_vendor, 'Trade'), case v_resp when 'CONFIRM' then 'confirmed' when 'DECLINE' then 'cannot make' else 'proposed ' || p_proposed_on::text || ' for' end, t.title),
    jsonb_build_object('note', left(p_note, 500)), 'SYSTEM');
  if v_resp <> 'CONFIRM' then
    select coalesce(array_agg(distinct m.membership_id), '{}') into v_pm from pm.job_members m
     where m.org_id = r.org_id and m.job_id = r.job_id and m.slot in ('pm','apm','superintendent','coordinator');
    begin
      perform core.notify_fanout(r.org_id, 'trade.schedule_response', v_loc, r.job_id, 'task', t.id, null, v_pm,
        left(format('%s %s: %s', coalesce(v_vendor, 'A trade'), case when v_resp = 'DECLINE' then 'can''t make it' else 'proposed ' || to_char(p_proposed_on, 'Mon DD') end, t.title), 200),
        left(p_note, 500), null, null, '/schedule?job=' || r.job_id::text, 'trade.resp:' || r.id::text || ':' || v_resp || ':' || coalesce(p_proposed_on::text, ''),
        '{}'::jsonb, null, 'attention', false);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'status', case v_resp when 'CONFIRM' then 'CONFIRMED' when 'DECLINE' then 'DECLINED' else 'PROPOSED' end);
end $$;

-- Trade confirmations with the red flag: not confirmed and starting within the window (72 h default).
create or replace view pm.v_res_trade_confirmations with (security_invoker = on) as
select tt.id, tt.org_id, tt.job_id, tt.task_id, t.title as task_title, coalesce(t.early_start, t.start_on) as start_on, tt.vendor_id, tt.contact_id,
       tt.status, tt.proposed_on, tt.response_note, tt.notified_at, tt.responded_at,
       (tt.status not in ('CONFIRMED','CANCELLED') and coalesce(t.early_start, t.start_on) is not null
        and coalesce(t.early_start, t.start_on)::timestamptz
            <= now() + make_interval(hours => coalesce((select s.trade_confirm_hours from pm.res_settings s join core.jobs j on j.location_id = s.location_id
                                                                          where j.id = tt.job_id and s.org_id = tt.org_id), 72))) as at_risk,
       (tt.status = 'CONFIRMED' and tt.start_on is distinct from coalesce(t.early_start, t.start_on)) as date_moved_since_confirm
  from pm.res_task_trades tt
  join pm.tasks t on t.org_id = tt.org_id and t.id = tt.task_id
 where tt.status <> 'CANCELLED' and t.status not in ('DONE','CANCELLED');
comment on view pm.v_res_trade_confirmations is '1119 (RES-48): trade confirmations — at_risk = not confirmed and starting inside the confirm window; date_moved_since_confirm = re-confirm. Invoker.';

-- Bid packages → invites (token link) → line prices → leveling → award (a DRAFT subcontract).
create or replace function pm.res_invite_bidder(p_package uuid, p_vendor uuid, p_contact uuid default null, p_token_hash text default null,
                                                p_link text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.res_bid_packages%rowtype; v_id uuid; v_ct core.contacts%rowtype; v_loc uuid;
begin
  select * into b from pm.res_bid_packages x where x.id = p_package and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: bid package % not found', p_package using errcode = '42501'; end if;
  if b.status not in ('DRAFT','OUT') then raise exception 'PM_RES_BID_STATE: the bid package is %', lower(b.status) using errcode = '22023'; end if;
  if not exists (select 1 from core.vendors v where v.id = p_vendor and v.org_id = b.org_id) then raise exception 'PM_INVALID: vendor not in this organization' using errcode = '22023'; end if;
  if p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash must be sha-256 hex' using errcode = '22023'; end if;
  select * into v_ct from core.contacts c where c.org_id = b.org_id and c.vendor_id = p_vendor and (p_contact is null or c.id = p_contact)
   order by c.is_primary desc, c.created_at limit 1;
  insert into pm.res_bid_invites (org_id, job_id, package_id, vendor_id, contact_id, token_hash, token_expires_at)
  values (b.org_id, b.job_id, b.id, p_vendor, v_ct.id, p_token_hash, coalesce(b.due_at, now() + interval '14 days') + interval '7 days')
  on conflict (org_id, package_id, vendor_id) do update set token_hash = coalesce(excluded.token_hash, pm.res_bid_invites.token_hash), contact_id = excluded.contact_id
  returning id into v_id;
  update pm.res_bid_packages set status = 'OUT' where id = b.id and status = 'DRAFT';
  select j.location_id into v_loc from core.jobs j where j.id = b.job_id;
  if v_ct.id is not null and p_link is not null then
    begin
      perform core.notify_customer(b.org_id, v_loc, b.job_id, 'trade.bid_invite', case when v_ct.email is not null then 'email' else 'sms' end, v_ct.id,
        left('Bid request: ' || b.title, 200),
        left(format('You are invited to bid %s on %s%s. Price each line here: %s', b.title, coalesce(core.notify_job_label(b.job_id), 'a job'),
                    case when b.due_at is not null then ', due ' || to_char(b.due_at, 'Mon DD') else '' end, p_link), 600),
        null, 'bid:' || v_id::text, pm.current_user_id());
    exception when others then null;
    end;
  end if;
  return v_id;
end $$;

-- Public (anon, token-scoped): view the package (no budget; read-only), 'open' (the bidder says
-- they are working on it: VIEWED), submit line prices, or decline. Submissions and declines are
-- taken only while the package is OUT and before its due time: once leveling starts
-- (pm.res_start_leveling) or the due time passes, late bids and changes after a decline are refused.
drop function if exists public.res_bid_portal(text, text, jsonb);
create or replace function public.res_bid_portal(p_token text, p_action text default 'view', p_payload jsonb default '{}', p_client text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.res_bid_invites%rowtype; b pm.res_bid_packages%rowtype; v_hash text; x jsonb; v_total bigint := 0; v_line uuid; v_act text := lower(coalesce(p_action, 'view'));
  v_gate jsonb; v_open boolean;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 200 then
    return coalesce(pm._res_link_gate('bid', '', false, p_client), jsonb_build_object('ok', false, 'reason', 'invalid'));
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into i from pm.res_bid_invites x2 where x2.token_hash = v_hash;
  v_gate := pm._res_link_gate('bid', v_hash, i.id is not null, p_client);
  if v_gate is not null then return v_gate; end if;
  if i.id is null or i.token_expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into b from pm.res_bid_packages x2 where x2.id = i.package_id;
  v_open := b.status = 'OUT' and (b.due_at is null or now() <= b.due_at) and i.status not in ('AWARDED','NOT_AWARDED');
  if v_act = 'view' then
    return jsonb_build_object('ok', true, 'package', b.title, 'scope', b.scope, 'due_at', b.due_at, 'status', i.status, 'open', v_open,
      'job', core.notify_job_label(b.job_id), 'exclusions', i.exclusions,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'description', l.description, 'qty', l.qty, 'uom', l.uom,
                                                             'amount_cents', pr.amount_cents, 'included', coalesce(pr.included, true)) order by l.sort)
                           from pm.res_bid_package_lines l left join pm.res_bid_prices pr on pr.invite_id = i.id and pr.line_id = l.id
                          where l.package_id = b.id), '[]'::jsonb));
  end if;
  if not v_open then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if v_act = 'open' then
    if i.status = 'INVITED' then update pm.res_bid_invites set status = 'VIEWED' where id = i.id; end if;
    return jsonb_build_object('ok', true, 'status', case when i.status = 'INVITED' then 'VIEWED' else i.status end);
  end if;
  if v_act = 'decline' then
    update pm.res_bid_invites set status = 'DECLINED', notes = left(p_payload ->> 'notes', 4000) where id = i.id;
    return jsonb_build_object('ok', true, 'status', 'DECLINED');
  end if;
  if v_act <> 'submit' or jsonb_typeof(p_payload -> 'prices') <> 'array' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  for x in select value from jsonb_array_elements(p_payload -> 'prices') loop
    v_line := pm.access_try_uuid(x ->> 'line_id');
    if v_line is null or not exists (select 1 from pm.res_bid_package_lines l where l.id = v_line and l.package_id = b.id) then
      return jsonb_build_object('ok', false, 'reason', 'line');
    end if;
    if (x ->> 'amount_cents') is not null and ((x ->> 'amount_cents')::bigint < 0 or (x ->> 'amount_cents')::bigint > 10000000000) then
      return jsonb_build_object('ok', false, 'reason', 'amount');
    end if;
    insert into pm.res_bid_prices (org_id, invite_id, line_id, included, amount_cents, note)
    values (i.org_id, i.id, v_line, coalesce((x ->> 'included')::boolean, true), (x ->> 'amount_cents')::bigint, left(x ->> 'note', 1000))
    on conflict (org_id, invite_id, line_id) do update set included = excluded.included, amount_cents = excluded.amount_cents, note = excluded.note;
  end loop;
  select coalesce(sum(pr.amount_cents) filter (where pr.included), 0) into v_total from pm.res_bid_prices pr where pr.invite_id = i.id;
  update pm.res_bid_invites set status = 'SUBMITTED', submitted_at = now(), total_cents = v_total,
         exclusions = left(p_payload ->> 'exclusions', 4000), notes = left(p_payload ->> 'notes', 4000)
   where id = i.id;
  perform pm.log_activity(i.org_id, (select location_id from core.jobs where id = b.job_id), b.job_id, 'bid.submitted', 'res_bid_invites', i.id,
    format('Bid received for %s', b.title), '{}'::jsonb, 'SYSTEM');
  return jsonb_build_object('ok', true, 'status', 'SUBMITTED', 'total_cents', v_total);
end $$;

-- Close bidding and start leveling: no submission, revision or late bid is taken after this.
create or replace function pm.res_start_leveling(p_package uuid) returns text
language plpgsql security definer
set search_path = pm, core, public
as $$
declare b pm.res_bid_packages%rowtype;
begin
  select * into b from pm.res_bid_packages x where x.id = p_package and x.org_id = public.get_org_id() for update;
  if b.id is null then raise exception 'PM_FORBIDDEN: bid package % not found', p_package using errcode = '42501'; end if;
  if b.status not in ('OUT','LEVELING') then raise exception 'PM_RES_BID_STATE: the bid package is %', lower(b.status) using errcode = '22023'; end if;
  update pm.res_bid_packages set status = 'LEVELING' where id = b.id and status = 'OUT';
  perform pm.log_activity(b.org_id, (select location_id from core.jobs where id = b.job_id), b.job_id, 'bid.leveling', 'res_bid_packages', b.id,
    format('Bidding closed on %s', b.title), '{}'::jsonb);
  return 'LEVELING';
end $$;

-- Leveling grid: one row per line × bidder; low / high / spread; missing lines and exclusions flagged.
create or replace function pm.res_bid_leveling(p_package uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare b pm.res_bid_packages%rowtype;
begin
  select * into b from pm.res_bid_packages x where x.id = p_package and x.org_id = public.get_org_id();
  if b.id is null then raise exception 'PM_FORBIDDEN: bid package % not found', p_package using errcode = '42501'; end if;
  return jsonb_build_object('package_id', b.id, 'title', b.title, 'status', b.status,
    'bidders', coalesce((select jsonb_agg(jsonb_build_object('invite_id', i.id, 'vendor_id', i.vendor_id, 'vendor', v.name, 'status', i.status,
                                                             'total_cents', i.total_cents, 'exclusions', i.exclusions,
                                                             'missing_lines', (select count(*) from pm.res_bid_package_lines l where l.package_id = b.id
                                                                                 and not exists (select 1 from pm.res_bid_prices pr where pr.invite_id = i.id and pr.line_id = l.id and pr.included and pr.amount_cents is not null)))
                                        order by i.total_cents nulls last)
                           from pm.res_bid_invites i join core.vendors v on v.id = i.vendor_id where i.package_id = b.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_id', l.id, 'description', l.description, 'budget_cents', l.budget_cents,
                        'low_cents', (select min(pr.amount_cents) from pm.res_bid_prices pr join pm.res_bid_invites i on i.id = pr.invite_id where pr.line_id = l.id and pr.included and i.status = 'SUBMITTED'),
                        'high_cents', (select max(pr.amount_cents) from pm.res_bid_prices pr join pm.res_bid_invites i on i.id = pr.invite_id where pr.line_id = l.id and pr.included and i.status = 'SUBMITTED'),
                        'prices', (select coalesce(jsonb_agg(jsonb_build_object('invite_id', pr.invite_id, 'amount_cents', pr.amount_cents, 'included', pr.included, 'note', pr.note)), '[]'::jsonb)
                                     from pm.res_bid_prices pr where pr.line_id = l.id),
                        'gap', exists (select 1 from pm.res_bid_invites i where i.package_id = b.id and i.status = 'SUBMITTED'
                                         and not exists (select 1 from pm.res_bid_prices pr where pr.invite_id = i.id and pr.line_id = l.id and pr.included and pr.amount_cents is not null)))
                        order by l.sort) from pm.res_bid_package_lines l where l.package_id = b.id), '[]'::jsonb));
end $$;

create or replace function pm.res_award_bid(p_invite uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.res_bid_invites%rowtype; b pm.res_bid_packages%rowtype; v_c uuid; v_loc uuid; n int := 0; l record;
begin
  select * into i from pm.res_bid_invites x where x.id = p_invite and x.org_id = public.get_org_id() for update;
  if i.id is null then raise exception 'PM_FORBIDDEN: bid % not found', p_invite using errcode = '42501'; end if;
  if i.status <> 'SUBMITTED' then raise exception 'PM_RES_BID_STATE: only a submitted bid can be awarded (this one is %)', lower(i.status) using errcode = '22023'; end if;
  select * into b from pm.res_bid_packages x where x.id = i.package_id for update;
  if b.status = 'AWARDED' then raise exception 'PM_RES_BID_STATE: the package is already awarded' using errcode = '22023'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = b.job_id;
  insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, description, retainage_pct, created_by)
  values (b.org_id, v_loc, b.job_id, i.vendor_id, 'SUBCONTRACT', left('Subcontract: ' || b.title, 200), left(concat_ws(E'\n', b.scope, 'Exclusions: ' || i.exclusions), 4000), null, pm.current_user_id())
  returning id into v_c;
  for l in select bl.*, pr.amount_cents as bid from pm.res_bid_package_lines bl join pm.res_bid_prices pr on pr.line_id = bl.id and pr.invite_id = i.id
            where bl.package_id = b.id and pr.included and pr.amount_cents is not null order by bl.sort loop
    n := n + 1;
    insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, amount_cents)
    values (b.org_id, v_c, n, coalesce(l.cost_code_id, b.cost_code_id), 'SUBCONTRACTOR', l.description, l.qty, l.uom, l.bid);
  end loop;
  update pm.res_bid_invites set status = case when id = i.id then 'AWARDED' else 'NOT_AWARDED' end
   where package_id = b.id and status in ('SUBMITTED','VIEWED','INVITED');
  update pm.res_bid_packages set status = 'AWARDED', awarded_invite_id = i.id, commitment_id = v_c where id = b.id;
  perform pm.log_activity(b.org_id, v_loc, b.job_id, 'bid.awarded', 'res_bid_packages', b.id, format('Awarded %s', b.title),
    jsonb_build_object('commitment_id', v_c, 'invite_id', i.id));
  return v_c;
end $$;

-- PO / work order to the trade with a one-time accept link (RES-57).
create or replace function pm.res_send_po_to_trade(p_commitment uuid, p_token_hash text, p_link text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_ct core.contacts%rowtype; v_msg uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: commitment % not found', p_commitment using errcode = '42501'; end if;
  if c.status not in ('APPROVED','EXECUTED') then raise exception 'PM_RES_PO_NOT_APPROVED: approve the purchase order before sending it' using errcode = '22023'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'PM_INVALID: token hash must be sha-256 hex' using errcode = '22023'; end if;
  -- the link expires (30 days); sending again replaces it
  update pm.commitments set trade_accept_token_hash = p_token_hash, trade_accept_expires_at = now() + interval '30 days' where id = c.id;
  select * into v_ct from core.contacts x where x.org_id = c.org_id and x.vendor_id = c.vendor_id and x.identity_status = 'active' order by x.is_primary desc, x.created_at limit 1;
  if v_ct.id is not null and p_link is not null then
    begin
      v_msg := core.notify_customer(c.org_id, c.location_id, c.job_id, 'trade.po_ready', case when v_ct.email is not null then 'email' else 'sms' end, v_ct.id,
        left('Purchase order ' || c.number, 200), left(format('%s %s is ready for you to accept: %s', case when c.commitment_type = 'PO' then 'Purchase order' else 'Subcontract' end, c.number, p_link), 600),
        null, 'po:' || c.id::text || ':' || p_token_hash, pm.current_user_id());
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('commitment_id', c.id, 'contact_id', v_ct.id, 'message_id', v_msg);
end $$;

drop function if exists public.res_po_accept(text, text, text);
create or replace function public.res_po_accept(p_token text, p_action text default 'view', p_name text default null, p_client text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_hash text; v_gate jsonb;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 200 then
    return coalesce(pm._res_link_gate('po', '', false, p_client), jsonb_build_object('ok', false, 'reason', 'invalid'));
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into c from pm.commitments x where x.trade_accept_token_hash = v_hash;
  v_gate := pm._res_link_gate('po', v_hash, c.id is not null, p_client);
  if v_gate is not null then return v_gate; end if;
  if c.id is null or c.status in ('VOID','CLOSED') or c.trade_accept_expires_at is null or c.trade_accept_expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if lower(coalesce(p_action, 'view')) = 'view' then
    return jsonb_build_object('ok', true, 'number', c.number, 'title', c.title, 'description', c.description, 'job', core.notify_job_label(c.job_id),
      'accepted_at', c.trade_accepted_at, 'accepted_name', c.trade_accepted_name,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'qty', l.qty, 'uom', l.uom, 'amount_cents', l.amount_cents) order by l.line_no)
                           from pm.commitment_lines l where l.commitment_id = c.id), '[]'::jsonb),
      'total_cents', (select coalesce(sum(l.amount_cents), 0) from pm.commitment_lines l where l.commitment_id = c.id));
  end if;
  if lower(p_action) <> 'accept' or p_name is null or length(btrim(p_name)) not between 2 and 120 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if c.trade_accepted_at is null then
    update pm.commitments set trade_accepted_at = now(), trade_accepted_name = btrim(p_name) where id = c.id;
    perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'commitment.trade_accepted', 'commitments', c.id,
      format('%s accepted %s', btrim(p_name), c.number), '{}'::jsonb, 'SYSTEM');
  end if;
  return jsonb_build_object('ok', true, 'accepted_at', coalesce(c.trade_accepted_at, now()));
end $$;

-- Vendor deposits on special orders (RES-58).
create or replace function pm.res_request_vendor_deposit(p_commitment uuid, p_pct numeric default null, p_amount_cents bigint default null,
                                                         p_expected_delivery date default null, p_memo text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_total bigint; v_amt bigint; v_id uuid;
begin
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = public.get_org_id();
  if c.id is null then raise exception 'PM_FORBIDDEN: commitment % not found', p_commitment using errcode = '42501'; end if;
  if c.status = 'VOID' then raise exception 'PM_INVALID: the purchase order is void' using errcode = '22023'; end if;
  select coalesce(sum(l.amount_cents), 0) into v_total from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id;
  v_amt := coalesce(p_amount_cents, pm.res_round(v_total * coalesce(p_pct, 0.5)));
  if v_amt <= 0 or v_amt > v_total then raise exception 'PM_INVALID: a deposit must be between 1 cent and the order total (% cents)', v_total using errcode = '22023'; end if;
  insert into pm.res_vendor_deposits (org_id, job_id, commitment_id, vendor_id, pct, amount_cents, expected_delivery_on, memo)
  values (c.org_id, c.job_id, c.id, c.vendor_id, p_pct, v_amt, p_expected_delivery, left(p_memo, 500))
  returning id into v_id;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'vendor_deposit.requested', 'res_vendor_deposits', v_id,
    format('Vendor deposit requested on %s: %s cents', c.number, v_amt), jsonb_build_object('commitment_id', c.id));
  return v_id;
end $$;

create or replace function pm.res_advance_vendor_deposit(p_deposit uuid, p_to text, p_on date default null, p_ref text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.res_vendor_deposits%rowtype; ok boolean;
begin
  select * into d from pm.res_vendor_deposits x where x.id = p_deposit and x.org_id = public.get_org_id() for update;
  if d.id is null then raise exception 'PM_FORBIDDEN: vendor deposit % not found', p_deposit using errcode = '42501'; end if;
  ok := case d.status when 'REQUESTED' then p_to in ('APPROVED','VOID') when 'APPROVED' then p_to in ('PAID','VOID') when 'PAID' then p_to = 'RELIEVED' else false end;
  if not ok then raise exception 'PM_RES_DEPOSIT_TRANSITION: % → %', d.status, p_to using errcode = '22023'; end if;
  update pm.res_vendor_deposits
     set status = p_to, approved_at = case when p_to = 'APPROVED' then now() else approved_at end,
         paid_on = case when p_to = 'PAID' then coalesce(p_on, current_date) else paid_on end,
         payment_ref = coalesce(p_ref, payment_ref),
         delivered_on = case when p_to = 'RELIEVED' then coalesce(p_on, current_date) else delivered_on end,
         relieved_at = case when p_to = 'RELIEVED' then now() else relieved_at end
   where id = d.id;
  return d.id;
end $$;

-- Compliance gate (RES-60): reasons a trade may not be paid now.
create or replace function pm.res_compliance_gate(p_commitment uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_reasons text[] := '{}';
begin
  select * into c from pm.commitments x where x.id = p_commitment and x.org_id = public.get_org_id();
  if c.id is null then raise exception 'PM_FORBIDDEN: commitment % not found', p_commitment using errcode = '42501'; end if;
  if c.payment_hold then v_reasons := v_reasons || coalesce('Payment hold: ' || c.hold_reason, 'Payment hold'); end if;
  if exists (select 1 from pm.compliance_docs d where d.org_id = c.org_id and (d.commitment_id = c.id or (d.commitment_id is null and d.job_id = c.job_id and d.vendor_id = c.vendor_id))
               and d.doc_type = 'COI' and d.required and (d.status in ('MISSING','EXPIRED','REJECTED') or (d.expires_on is not null and d.expires_on < current_date))) then
    v_reasons := v_reasons || 'Certificate of insurance missing or expired'::text;
  end if;
  if exists (select 1 from pm.compliance_docs d where d.org_id = c.org_id and (d.commitment_id = c.id or (d.commitment_id is null and d.vendor_id = c.vendor_id))
               and d.doc_type = 'W9' and d.required and d.status in ('MISSING','REJECTED')) then
    v_reasons := v_reasons || 'W-9 missing'::text;
  end if;
  if exists (select 1 from pm.compliance_docs d where d.org_id = c.org_id and (d.commitment_id = c.id or d.vendor_id = c.vendor_id)
               and d.doc_type = 'OTHER' and d.required and coalesce(d.notes, '') ilike 'licen%' and (d.status in ('MISSING','EXPIRED','REJECTED') or d.expires_on < current_date)) then
    v_reasons := v_reasons || 'Contractor licence missing or expired'::text;
  end if;
  if exists (select 1 from pm.compliance_docs d where d.org_id = c.org_id and d.commitment_id = c.id
               and d.doc_type in ('LIEN_WAIVER_CONDITIONAL','LIEN_WAIVER_UNCONDITIONAL','LIEN_WAIVER_FINAL') and d.required and d.status in ('MISSING','REJECTED')) then
    v_reasons := v_reasons || 'Lien waiver missing'::text;
  end if;
  return jsonb_build_object('commitment_id', c.id, 'eligible', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons));
end $$;

-- Match a trade invoice to its PO, from its stored lines (used at submission and again at approval,
-- after any accepted overage raised the commitment). Variances:
--   money   price (unit cost above the PO's), over_line (invoiced to date above the line),
--           over_commitment (invoiced to date above the commitment) — approvable only as a
--           commitment change through the 1113 engine (pm.res_approve_trade_invoice)
--   hard    unmatched_line, quantity (billed above what was received), total (lines ≠ invoice) —
--           never approvable: correct the invoice, receive the goods, or reject it
-- over_by_line = {commitment_line_id: cents} the overage per PO line; header_over_cents = the
-- commitment-level overage. A price variance on a line an approved change from this invoice already
-- covers is not raised again.
create or replace function pm._res_match_trade_invoice(p_invoice uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare ti pm.res_trade_invoices%rowtype; g record; cl pm.commitment_lines%rowtype; v_var jsonb := '[]'::jsonb; v_over jsonb := '{}'::jsonb;
  v_waived uuid[]; v_line_over bigint; v_price_over bigint; v_prior bigint; v_total bigint; v_to_date bigint; v_header bigint := 0; v_nlines int;
begin
  select * into ti from pm.res_trade_invoices x where x.id = p_invoice;
  if ti.id is null then return jsonb_build_object('variances', '[]'::jsonb, 'over_by_line', '{}'::jsonb, 'header_over_cents', 0); end if;
  select coalesce(array_agg(x.commitment_line_id) filter (where x.commitment_line_id is not null), '{}') into v_waived
    from pm.commitment_changes x where x.org_id = ti.org_id and x.id = any (ti.variance_change_ids) and x.status = 'APPROVED';
  for g in select il.commitment_line_id, sum(il.amount_cents)::bigint as amt, sum(il.qty) as qty, max(il.unit_cost_cents) as unit,
                  string_agg(il.description, '; ') as descr, count(*) as n
             from pm.res_trade_invoice_lines il where il.invoice_id = ti.id group by il.commitment_line_id loop
    if g.commitment_line_id is null then
      v_var := v_var || jsonb_build_object('kind', 'unmatched_line', 'description', left(g.descr, 500), 'amount_cents', g.amt);
      continue;
    end if;
    select * into cl from pm.commitment_lines l where l.org_id = ti.org_id and l.id = g.commitment_line_id;
    v_line_over := 0;
    if g.unit is not null and cl.unit_cost_cents is not null and g.unit > cl.unit_cost_cents and not (cl.id = any (v_waived)) then
      v_price_over := pm.res_round((g.unit - cl.unit_cost_cents) * coalesce(g.qty, 1));
      v_var := v_var || jsonb_build_object('kind', 'price', 'line_id', cl.id, 'po_unit_cost_cents', cl.unit_cost_cents, 'invoice_unit_cost_cents', g.unit, 'over_cents', v_price_over);
      v_line_over := v_price_over;
    end if;
    if g.qty is not null and cl.qty is not null and cl.received_qty > 0 and g.qty > cl.received_qty then
      v_var := v_var || jsonb_build_object('kind', 'quantity', 'line_id', cl.id, 'received_qty', cl.received_qty, 'invoice_qty', g.qty);
    end if;
    select coalesce(sum(il.amount_cents), 0) into v_prior from pm.res_trade_invoice_lines il join pm.res_trade_invoices t2 on t2.id = il.invoice_id
     where il.commitment_line_id = cl.id and t2.status <> 'REJECTED' and t2.id <> ti.id;
    if v_prior + g.amt > cl.amount_cents then
      v_var := v_var || jsonb_build_object('kind', 'over_line', 'line_id', cl.id, 'committed_cents', cl.amount_cents, 'invoiced_to_date_cents', v_prior + g.amt,
                                           'over_cents', v_prior + g.amt - cl.amount_cents);
      v_line_over := greatest(v_line_over, v_prior + g.amt - cl.amount_cents);
    end if;
    if v_line_over > 0 then v_over := v_over || jsonb_build_object(cl.id::text, v_line_over); end if;
  end loop;
  select coalesce(sum(l.amount_cents), 0) into v_total from pm.commitment_lines l where l.org_id = ti.org_id and l.commitment_id = ti.commitment_id;
  select coalesce(sum(t2.amount_cents), 0) into v_to_date from pm.res_trade_invoices t2 where t2.commitment_id = ti.commitment_id and t2.status <> 'REJECTED';
  if v_to_date > v_total then
    v_header := v_to_date - v_total;
    v_var := v_var || jsonb_build_object('kind', 'over_commitment', 'committed_cents', v_total, 'invoiced_to_date_cents', v_to_date, 'over_cents', v_header);
  end if;
  select count(*) into v_nlines from pm.res_trade_invoice_lines il where il.invoice_id = ti.id;
  if v_nlines > 0 and ti.amount_cents <> (select coalesce(sum(il.amount_cents), 0) from pm.res_trade_invoice_lines il where il.invoice_id = ti.id) then
    v_var := v_var || jsonb_build_object('kind', 'total', 'invoice_cents', ti.amount_cents,
                                         'lines_cents', (select coalesce(sum(il.amount_cents), 0) from pm.res_trade_invoice_lines il where il.invoice_id = ti.id));
  end if;
  return jsonb_build_object('variances', v_var, 'over_by_line', v_over, 'header_over_cents', v_header);
end $$;

-- Trade invoice → match to the PO (price, quantity, over-commitment) (RES-59). The caller is the
-- invoice's preparer (entered_by) and can never approve it.
create or replace function pm.res_submit_trade_invoice(p_commitment uuid, p_invoice_number text, p_invoice_date date, p_amount_cents bigint,
                                                       p_lines jsonb default '[]', p_document uuid default null, p_source text default 'OFFICE') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.commitments%rowtype; v_id uuid; x jsonb; cl pm.commitment_lines%rowtype; v_amt bigint; m jsonb; v_var jsonb; v_me text := pm.current_user_id();
begin
  select * into c from pm.commitments x2 where x2.id = p_commitment and x2.org_id = public.get_org_id();
  if c.id is null then raise exception 'PM_FORBIDDEN: commitment % not found', p_commitment using errcode = '42501'; end if;
  if c.status not in ('APPROVED','EXECUTED','CLOSED') then raise exception 'PM_RES_PO_NOT_APPROVED: invoices match approved purchase orders only' using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: entering an invoice requires an identified user' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 200 then
    raise exception 'PM_INVALID: lines must be an array of at most 200' using errcode = '22023';
  end if;
  insert into pm.res_trade_invoices (org_id, job_id, commitment_id, vendor_id, invoice_number, invoice_date, amount_cents, document_id, source, entered_by, created_by)
  values (c.org_id, c.job_id, c.id, c.vendor_id, btrim(p_invoice_number), coalesce(p_invoice_date, current_date), p_amount_cents, p_document, coalesce(p_source, 'OFFICE'), v_me, v_me)
  returning id into v_id;
  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into cl from pm.commitment_lines l where l.org_id = c.org_id and l.commitment_id = c.id and l.id = pm.access_try_uuid(x ->> 'commitment_line_id');
    v_amt := coalesce((x ->> 'amount_cents')::bigint, pm.res_round(coalesce((x ->> 'qty')::numeric, 0) * coalesce((x ->> 'unit_cost_cents')::bigint, 0)));
    if v_amt < 0 then raise exception 'PM_INVALID: invoice line amounts cannot be negative' using errcode = '22023'; end if;
    insert into pm.res_trade_invoice_lines (org_id, invoice_id, commitment_line_id, description, qty, unit_cost_cents, amount_cents)
    values (c.org_id, v_id, cl.id, left(coalesce(x ->> 'description', cl.description, ''), 500), (x ->> 'qty')::numeric, (x ->> 'unit_cost_cents')::bigint, v_amt);
  end loop;
  m := pm._res_match_trade_invoice(v_id);
  v_var := m -> 'variances';
  update pm.res_trade_invoices set variances = v_var, status = case when jsonb_array_length(v_var) = 0 then 'MATCHED' else 'VARIANCE' end where id = v_id;
  perform pm.log_activity(c.org_id, c.location_id, c.job_id, 'trade_invoice.received', 'res_trade_invoices', v_id,
    format('Invoice %s on %s: %s', btrim(p_invoice_number), c.number, case when jsonb_array_length(v_var) = 0 then 'matches the PO' else jsonb_array_length(v_var) || ' variance(s)' end),
    jsonb_build_object('variances', jsonb_array_length(v_var)));
  return jsonb_build_object('invoice_id', v_id, 'status', case when jsonb_array_length(v_var) = 0 then 'MATCHED' else 'VARIANCE' end, 'variances', v_var);
end $$;

-- Approve for payment (security review HIGH):
--   * the invoice's preparer never approves it (PM_SOD_VIOLATION) — except a solo-mode company
--     (pm._approval_solo) with a typed reason, logged as an exception;
--   * hard variances (unmatched line, quantity above received, lines ≠ total) are never approvable;
--   * a money variance (price / over line / over commitment) is accepted only as a commitment change
--     for the overage, prepared by the invoice's preparer and decided through pm.approval_decide
--     ('commitment_change' — the 1113 engine's amount ladder, preparer ≠ approver, delegation,
--     audit). Where the company has no approval settings the engine answers not_needed and
--     pm.approve_commitment_change applies the change itself (its own preparer check and approval
--     limit). While a change waits on an approver the invoice stays VARIANCE ('pending');
--   * then the compliance gate: refused (HELD with reasons) while it is closed.
drop function if exists pm.res_approve_trade_invoice(uuid, boolean);
create or replace function pm.res_approve_trade_invoice(p_invoice uuid, p_reason text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare ti pm.res_trade_invoices%rowtype; g jsonb; v_loc uuid; v_me text := pm.current_user_id(); v_prep text; m jsonb; v_hard text[];
  k text; v_cents bigint; v_line_sum bigint := 0; v_target uuid; v_cc uuid; v_new uuid[] := '{}'; v_res jsonb; v_pending int; v_self boolean := false;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into ti from pm.res_trade_invoices x where x.id = p_invoice and x.org_id = public.get_org_id() for update;
  if ti.id is null then raise exception 'PM_FORBIDDEN: invoice % not found', p_invoice using errcode = '42501'; end if;
  if ti.status not in ('MATCHED','VARIANCE','HELD') then raise exception 'PM_RES_INVOICE_STATE: the invoice is %', lower(ti.status) using errcode = '22023'; end if;
  if v_me is null then raise exception 'PM_NO_ACTOR: approval requires an identified user' using errcode = '42501'; end if;
  select j.location_id into v_loc from core.jobs j where j.id = ti.job_id;
  v_prep := coalesce(ti.entered_by, ti.created_by);
  if v_prep is not null and v_prep = v_me then
    if not (pm._approval_solo(ti.org_id, v_loc) and char_length(coalesce(v_reason, '')) >= 5) then
      raise exception 'PM_SOD_VIOLATION: the person who entered invoice % cannot approve it', ti.invoice_number using errcode = '42501';
    end if;
    v_self := true;
  end if;

  m := pm._res_match_trade_invoice(ti.id);
  v_hard := array(select distinct v ->> 'kind' from jsonb_array_elements(m -> 'variances') v where v ->> 'kind' in ('unmatched_line','quantity','total'));
  if cardinality(v_hard) > 0 then
    update pm.res_trade_invoices set variances = m -> 'variances', status = case when status = 'HELD' then 'VARIANCE' else status end where id = ti.id;
    raise exception 'PM_RES_INVOICE_VARIANCE: % — correct the invoice (or receive the goods) before it can be approved',
      array_to_string(array(select case x when 'unmatched_line' then 'a line matches no PO line' when 'quantity' then 'it bills more than was received'
                                           else 'its lines do not add up to its total' end from unnest(v_hard) x), '; ') using errcode = '22023';
  end if;

  if jsonb_array_length(m -> 'variances') > 0 then
    if exists (select 1 from pm.commitment_changes x where x.org_id = ti.org_id and x.id = any (ti.variance_change_ids) and x.status in ('REJECTED','VOID')) then
      raise exception 'PM_RES_INVOICE_VARIANCE_REJECTED: the overage on invoice % was rejected — reject the invoice or ask the trade to correct it', ti.invoice_number using errcode = '22023';
    end if;
    -- New overage (none routed yet, or more than the approved changes covered): one change per PO
    -- line, the commitment-level remainder on the largest line.
    if not exists (select 1 from pm.commitment_changes x where x.org_id = ti.org_id and x.id = any (ti.variance_change_ids) and x.status = 'DRAFT') then
      for k, v_cents in select e.key, (e.value)::text::bigint from jsonb_each(m -> 'over_by_line') e loop
        insert into pm.commitment_changes (org_id, commitment_id, commitment_line_id, description, reason, amount_cents, created_by)
        values (ti.org_id, ti.commitment_id, k::uuid, left(format('Invoice %s over the PO line', ti.invoice_number), 200),
                left(coalesce(v_reason, 'Trade invoice variance'), 1000), v_cents, v_prep)
        returning id into v_cc;
        v_new := v_new || v_cc; v_line_sum := v_line_sum + v_cents;
      end loop;
      if coalesce((m ->> 'header_over_cents')::bigint, 0) > v_line_sum then
        select l.id into v_target from pm.commitment_lines l where l.org_id = ti.org_id and l.commitment_id = ti.commitment_id order by l.amount_cents desc, l.line_no limit 1;
        insert into pm.commitment_changes (org_id, commitment_id, commitment_line_id, description, reason, amount_cents, created_by)
        values (ti.org_id, ti.commitment_id, v_target, left(format('Invoice %s over the commitment', ti.invoice_number), 200),
                left(coalesce(v_reason, 'Trade invoice variance'), 1000), (m ->> 'header_over_cents')::bigint - v_line_sum, v_prep)
        returning id into v_cc;
        v_new := v_new || v_cc;
      end if;
      update pm.res_trade_invoices set variance_change_ids = variance_change_ids || v_new, status = 'VARIANCE', variances = m -> 'variances'
       where id = ti.id returning * into ti;
    end if;
    -- The caller's decision on each open change, through the engine (it decides whether this
    -- person may approve at this amount; otherwise the request waits in Approvals).
    for v_cc in select x.id from pm.commitment_changes x where x.org_id = ti.org_id and x.id = any (ti.variance_change_ids) and x.status = 'DRAFT' order by x.created_at loop
      v_res := pm.approval_decide('commitment_change', v_cc, 'approve', coalesce(v_reason, 'Invoice variance accepted'), case when v_self then v_reason end, null, 'api');
      if v_res ->> 'status' = 'not_needed' then perform pm.approve_commitment_change(v_cc); end if;
    end loop;
    select count(*) into v_pending from pm.commitment_changes x where x.org_id = ti.org_id and x.id = any (ti.variance_change_ids) and x.status = 'DRAFT';
    if v_pending > 0 then
      perform pm.log_activity(ti.org_id, v_loc, ti.job_id, 'trade_invoice.variance_routed', 'res_trade_invoices', ti.id,
        format('Invoice %s overage sent for approval', ti.invoice_number), jsonb_build_object('change_ids', to_jsonb(ti.variance_change_ids)));
      return jsonb_build_object('invoice_id', ti.id, 'status', 'VARIANCE', 'approval', 'pending', 'change_ids', to_jsonb(ti.variance_change_ids));
    end if;
    m := pm._res_match_trade_invoice(ti.id);
    if jsonb_array_length(m -> 'variances') > 0 then
      update pm.res_trade_invoices set variances = m -> 'variances' where id = ti.id;
      raise exception 'PM_RES_INVOICE_VARIANCE: invoice % still does not match after the approved change', ti.invoice_number using errcode = '22023';
    end if;
    update pm.res_trade_invoices set variances = '[]'::jsonb where id = ti.id;
  end if;

  g := pm.res_compliance_gate(ti.commitment_id);
  if not (g ->> 'eligible')::boolean then
    update pm.res_trade_invoices set status = 'HELD', hold_reasons = array(select jsonb_array_elements_text(g -> 'reasons')) where id = ti.id;
    perform pm.log_activity(ti.org_id, v_loc, ti.job_id, 'trade_invoice.held', 'res_trade_invoices', ti.id, 'Payment held: ' || (g ->> 'reasons'), g);
    return jsonb_build_object('invoice_id', ti.id, 'status', 'HELD', 'reasons', g -> 'reasons');
  end if;
  update pm.res_trade_invoices set status = 'APPROVED', approved_by = v_me, approved_at = now(), hold_reasons = '{}', approval_reason = v_reason where id = ti.id;
  perform pm.log_activity(ti.org_id, v_loc, ti.job_id, case when v_self then 'trade_invoice.approved_self' else 'trade_invoice.approved' end, 'res_trade_invoices', ti.id,
    format('Invoice %s approved for payment%s', ti.invoice_number, case when v_self then ' by the person who entered it (solo company): ' || v_reason else '' end),
    jsonb_build_object('sod_exception', v_self, 'change_ids', to_jsonb(ti.variance_change_ids)));
  return jsonb_build_object('invoice_id', ti.id, 'status', 'APPROVED', 'change_ids', to_jsonb(ti.variance_change_ids));
end $$;

-- Reject a trade invoice (and void the overage changes still waiting on it).
create or replace function pm.res_reject_trade_invoice(p_invoice uuid, p_reason text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare ti pm.res_trade_invoices%rowtype; v_loc uuid;
begin
  select * into ti from pm.res_trade_invoices x where x.id = p_invoice and x.org_id = public.get_org_id() for update;
  if ti.id is null then raise exception 'PM_FORBIDDEN: invoice % not found', p_invoice using errcode = '42501'; end if;
  if ti.status in ('APPROVED','REJECTED') then raise exception 'PM_RES_INVOICE_STATE: the invoice is %', lower(ti.status) using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'PM_INVALID: say why the invoice is rejected' using errcode = '22023'; end if;
  update pm.commitment_changes set status = 'VOID' where org_id = ti.org_id and id = any (ti.variance_change_ids) and status = 'DRAFT';
  update pm.res_trade_invoices set status = 'REJECTED', rejected_reason = left(btrim(p_reason), 1000) where id = ti.id;
  select j.location_id into v_loc from core.jobs j where j.id = ti.job_id;
  perform pm.log_activity(ti.org_id, v_loc, ti.job_id, 'trade_invoice.rejected', 'res_trade_invoices', ti.id, format('Invoice %s rejected: %s', ti.invoice_number, left(btrim(p_reason), 200)), '{}'::jsonb);
  return jsonb_build_object('invoice_id', ti.id, 'status', 'REJECTED');
end $$;

-- ----------------------------------------------------------------------------
-- 7. Billing: milestones from tasks, cost-plus with backup, draw package, tax, integrity scan
-- ----------------------------------------------------------------------------
-- Why a payment milestone cannot be drafted yet (photo / checklist evidence).
create or replace function pm._res_milestone_holds(p_item uuid) returns text[]
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare s pm.res_payment_schedule%rowtype; t pm.tasks%rowtype; v text[] := '{}';
begin
  select * into s from pm.res_payment_schedule where id = p_item;
  select * into t from pm.tasks where id = s.task_id;
  if s.requires_photo and not exists (
       select 1 from pm.doc_files f where f.org_id = s.org_id and f.job_id = s.job_id and f.kind = 'photo' and f.status = 'active'
          and f.created_at >= coalesce(t.actual_start::timestamptz, t.created_at)) then
    v := v || 'No completion photo filed for this milestone'::text;
  end if;
  if s.requires_checklist and exists (select 1 from pm.punch_items p where p.org_id = s.org_id and p.job_id = s.job_id and p.kind = 'PUNCH' and p.status not in ('CLOSED','VOID')) then
    v := v || 'Punch list is not closed'::text;
  end if;
  return v;
end $$;

-- Draft the milestone's billing request (DRAFT → the PM approves through Approvals → Books invoices).
create or replace function pm._res_draft_milestone(p_item uuid, p_force boolean) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.res_payment_schedule%rowtype; v_holds text[]; v_req uuid; v_prev text; v_bt uuid; t pm.tasks%rowtype;
begin
  select * into s from pm.res_payment_schedule where id = p_item for update;
  if s.status not in ('SCHEDULED','HELD','PLANNED') then return s.billing_request_id; end if;
  v_holds := case when p_force then '{}'::text[] else pm._res_milestone_holds(s.id) end;
  if cardinality(v_holds) > 0 then
    update pm.res_payment_schedule set status = 'HELD', hold_reason = array_to_string(v_holds, '; ') where id = s.id;
    return null;
  end if;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_bt := s.billing_task_id;
  if v_bt is null then
    -- no schedule binding: a done milestone for this payment
    insert into pm.tasks (org_id, job_id, title, is_milestone, duration_days, status, billing_amount_cents, created_by)
    values (s.org_id, s.job_id, left('Payment: ' || s.label, 200), true, 0, 'DONE', coalesce(s.amount_cents, 0) + s.added_cents, pm.current_user_id())
    returning id into v_bt;
    update pm.res_payment_schedule set billing_task_id = v_bt where id = s.id;
  else
    select * into t from pm.tasks where id = v_bt;
    if t.status <> 'DONE' then update pm.tasks set status = 'DONE', pct_complete = 1 where id = v_bt; end if;
  end if;
  v_req := pm.generate_milestone_billing(s.job_id, array[v_bt], current_date);
  perform set_config('pm.access_entry', v_prev, true);
  update pm.res_payment_schedule set status = 'DRAFTED', billing_request_id = v_req, hold_reason = null where id = s.id;
  return v_req;
end $$;

-- A schedule task finishing drafts its payment milestone(s).
create or replace function pm.tg_res_task_done_milestone() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s record;
begin
  for s in select x.id from pm.res_payment_schedule x
            where x.org_id = new.org_id and x.job_id = new.job_id and x.task_id = new.id and x.status in ('SCHEDULED','PLANNED') loop
    perform pm._res_draft_milestone(s.id, false);
  end loop;
  return null;
end $$;
drop trigger if exists trg_res_task_done_milestone on pm.tasks;
create trigger trg_res_task_done_milestone after update of status on pm.tasks
  for each row when (new.status = 'DONE' and old.status is distinct from 'DONE')
  execute function pm.tg_res_task_done_milestone();

-- PM releases a held milestone (with a reason) or bills one that has no schedule task.
create or replace function pm.res_release_milestone(p_item uuid, p_reason text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare s pm.res_payment_schedule%rowtype; v_req uuid; v_loc uuid;
begin
  select * into s from pm.res_payment_schedule x where x.id = p_item and x.org_id = public.get_org_id();
  if s.id is null then raise exception 'PM_FORBIDDEN: payment milestone % not found', p_item using errcode = '42501'; end if;
  if s.kind = 'DEPOSIT' then raise exception 'PM_INVALID: deposits are requested at signing' using errcode = '22023'; end if;
  if s.status = 'HELD' and (p_reason is null or length(btrim(p_reason)) < 5) then
    raise exception 'PM_INVALID: say why this milestone is billed without its evidence' using errcode = '22023';
  end if;
  if s.status = 'SCHEDULED' and s.task_id is not null and not exists (select 1 from pm.tasks t where t.id = s.task_id and t.status = 'DONE') then
    raise exception 'PM_RES_MILESTONE_NOT_DONE: the schedule task for this payment is not complete' using errcode = '22023';
  end if;
  v_req := pm._res_draft_milestone(s.id, true);
  select j.location_id into v_loc from core.jobs j where j.id = s.job_id;
  perform pm.log_activity(s.org_id, v_loc, s.job_id, 'payment_milestone.released', 'res_payment_schedule', s.id,
    format('Payment milestone "%s" drafted%s', s.label, case when p_reason is not null then ' — ' || left(p_reason, 200) else '' end),
    jsonb_build_object('billing_request_id', v_req));
  return v_req;
end $$;

-- Cost-plus billing (RES-78): posted (CLEARED) costs not yet billed + the fee; each cost once
-- (pm.billing_links PK); a GMP caps the total. Returns the request and its backup list.
create or replace function pm.res_generate_cost_plus_billing(p_job uuid, p_through date default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; t pm.res_job_terms%rowtype; v_contract uuid; v_req uuid := gen_random_uuid(); g record; v_line uuid; v_sort int := 0;
  v_costs bigint := 0; v_fee bigint := 0; v_rate numeric; v_billed bigint; v_cap bigint; v_backup jsonb; v_est_cost bigint; v_fee_billed bigint;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job and j.org_id = public.get_org_id();
  if v_org is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  select * into t from pm.res_job_terms x where x.org_id = v_org and x.job_id = p_job;
  if t.id is null or t.contract_type not in ('COST_PLUS_PCT','COST_PLUS_FEE','COST_PLUS_GMP','TIME_MATERIALS') then
    raise exception 'PM_RES_NOT_COST_PLUS: this job is not billed cost-plus' using errcode = '22023';
  end if;
  v_contract := pm.primary_contract_id(v_org, p_job);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', p_job using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pm.billing:' || p_job::text, 0));
  if not exists (select 1 from pm.job_costs c where c.org_id = v_org and c.job_id = p_job and c.lifecycle = 'CLEARED' and c.amount_cents <> 0
                    and (p_through is null or c.occurred_on <= p_through)
                    and not exists (select 1 from pm.billing_links bl where bl.org_id = c.org_id and bl.source_table = 'job_costs' and bl.source_id = c.id)) then
    raise exception 'PM_RES_NOTHING_TO_BILL: no posted costs are waiting to be billed' using errcode = '22023';
  end if;
  select coalesce(k.retention_pct, 0) into v_rate from pm.contracts k where k.org_id = v_org and k.id = v_contract;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, period_end, memo, created_by)
  values (v_req, v_org, p_job, v_contract, 'TIME_MATERIALS', 'DRAFT', 'tm', current_date, coalesce(p_through, current_date),
          'Cost-plus billing: posted costs with backup', pm.current_user_id());
  for g in
    select c.cost_code_id, coalesce(cc.code || ' ' || cc.name, 'Uncoded costs') as label, sum(c.amount_cents)::bigint as amt, array_agg(c.id) as ids
      from pm.job_costs c left join pm.cost_codes cc on cc.id = c.cost_code_id
     where c.org_id = v_org and c.job_id = p_job and c.lifecycle = 'CLEARED' and c.amount_cents <> 0
       and (p_through is null or c.occurred_on <= p_through)
       and not exists (select 1 from pm.billing_links bl where bl.org_id = c.org_id and bl.source_table = 'job_costs' and bl.source_id = c.id)
     group by c.cost_code_id, cc.code, cc.name order by cc.code nulls last
  loop
    v_sort := v_sort + 1;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, cost_code_id,
                                          this_period_work_cents, retainage_rate, retainage_this_period_cents)
    values (v_org, v_req, v_sort, v_sort, 'STANDARD', left(format('%s (%s costs)', g.label, cardinality(g.ids)), 500), g.amt, g.cost_code_id,
            g.amt, v_rate, pm.res_round(g.amt * v_rate))
    returning id into v_line;
    insert into pm.billing_links (org_id, source_table, source_id, job_id, billing_request_id, billing_request_line_id, amount_cents)
    select v_org, 'job_costs', c.id, p_job, v_req, v_line, c.amount_cents from pm.job_costs c where c.id = any (g.ids);
    v_costs := v_costs + g.amt;
  end loop;
  -- fee
  if t.contract_type in ('COST_PLUS_PCT','COST_PLUS_GMP') then
    v_fee := pm.res_round(v_costs * coalesce(t.fee_pct, 0));
  elsif t.contract_type = 'COST_PLUS_FEE' then
    select coalesce(sum(b.amount_cents), 0) into v_est_cost from pm.v_job_current_budget_lines b where b.job_id = p_job;
    select coalesce(sum(bl.amount_cents), 0) into v_fee_billed from pm.billing_request_lines bl join pm.billing_requests r on r.id = bl.billing_request_id
     where r.org_id = v_org and r.job_id = p_job and r.status <> 'VOID' and bl.description like 'Builder fee%' and r.id <> v_req;
    v_fee := least(greatest(coalesce(t.fee_cents, 0) - v_fee_billed, 0),
                   case when v_est_cost > 0 then pm.res_round(coalesce(t.fee_cents, 0)::numeric * v_costs / v_est_cost) else coalesce(t.fee_cents, 0) end);
  end if;
  if t.contract_type = 'COST_PLUS_GMP' and t.gmp_cents is not null then
    select coalesce(sum(r.gross_earned_cents), 0) into v_billed from pm.billing_requests r where r.org_id = v_org and r.job_id = p_job and r.status <> 'VOID' and r.id <> v_req;
    v_cap := greatest(t.gmp_cents - v_billed - v_costs, 0);
    v_fee := least(v_fee, v_cap);
  end if;
  if v_fee > 0 then
    v_sort := v_sort + 1;
    insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents,
                                          this_period_work_cents, retainage_rate, retainage_this_period_cents)
    values (v_org, v_req, v_sort, v_sort, 'STANDARD',
            case when t.contract_type = 'COST_PLUS_FEE' then 'Builder fee (fixed, earned with cost)' else format('Builder fee (%s%% of cost)', round(coalesce(t.fee_pct, 0) * 100, 2)) end,
            v_fee, v_fee, v_rate, pm.res_round(v_fee * v_rate));
  end if;
  perform pm.finalize_billing_retainage(v_req);
  select coalesce(jsonb_agg(jsonb_build_object('job_cost_id', c.id, 'occurred_on', c.occurred_on, 'cost_type', c.cost_type, 'vendor_id', c.vendor_id,
                                               'description', c.description, 'amount_cents', c.amount_cents, 'gl_entry_id', c.gl_entry_id, 'source_ref', c.source_ref)
                            order by c.occurred_on, c.id), '[]'::jsonb)
    into v_backup
    from pm.job_costs c join pm.billing_links bl on bl.org_id = c.org_id and bl.source_table = 'job_costs' and bl.source_id = c.id
   where bl.billing_request_id = v_req;
  perform pm.log_activity(v_org, v_loc, p_job, 'billing.drafted', 'billing_requests', v_req,
    format('Drafted cost-plus billing: %s cents of cost + %s cents fee', v_costs, v_fee), jsonb_build_object('mode', 'COST_PLUS', 'costs', jsonb_array_length(v_backup)));
  return jsonb_build_object('billing_request_id', v_req, 'cost_cents', v_costs, 'fee_cents', v_fee, 'backup', v_backup);
end $$;

-- Lender draw package (RES-82): lines, photos, invoices, lien waivers, title date-down → draws.package.
create or replace function pm.res_assemble_draw_package(p_draw uuid, p_title_date_down date default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_from date; v_pkg jsonb; v_missing text[] := '{}'; v_photos int; v_waivers int; v_open_waivers int;
begin
  select * into d from pm.draws x where x.id = p_draw and x.org_id = public.get_org_id() for update;
  if d.id is null then raise exception 'PM_FORBIDDEN: draw % not found', p_draw using errcode = '42501'; end if;
  if d.status not in ('DRAFT','RETURNED') then raise exception 'PM_DRAW_TRANSITION_INVALID: the package is assembled before submission (draw is %)', d.status using errcode = '22023'; end if;
  select coalesce(max(x.period_end), (select min(c.created_at)::date from pm.contracts c where c.org_id = d.org_id and c.job_id = d.job_id), d.period_end - 30)
    into v_from from pm.draws x where x.org_id = d.org_id and x.draw_schedule_id = d.draw_schedule_id and x.draw_number < d.draw_number and x.status <> 'CANCELLED';
  select count(*) into v_photos from pm.doc_files f where f.org_id = d.org_id and f.job_id = d.job_id and f.kind = 'photo' and f.status = 'active'
     and f.created_at::date > v_from and f.created_at::date <= d.period_end + 3;
  select count(*), count(*) filter (where cd.status in ('MISSING','REJECTED')) into v_waivers, v_open_waivers
    from pm.compliance_docs cd where cd.org_id = d.org_id and cd.job_id = d.job_id and cd.doc_type like 'LIEN_WAIVER%' and cd.required;
  if v_photos = 0 then v_missing := v_missing || 'No progress photos this period'::text; end if;
  if v_open_waivers > 0 then v_missing := v_missing || format('%s lien waiver(s) missing', v_open_waivers); end if;
  if coalesce(p_title_date_down, pm.res_try_date(d.package ->> 'title_date_down_on')) is null then v_missing := v_missing || 'Title date-down not recorded'::text; end if;
  v_pkg := jsonb_build_object(
    'assembled_at', now(), 'period_from', v_from, 'period_end', d.period_end,
    'title_date_down_on', coalesce(p_title_date_down, pm.res_try_date(d.package ->> 'title_date_down_on')),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('draw_line_id', l.id, 'budget_line_id', l.draw_budget_line_id, 'requested_cents', l.requested_cents,
                                                           'retainage_held_cents', l.retainage_held_cents) order by l.created_at)
                         from pm.draw_lines l where l.org_id = d.org_id and l.draw_id = d.id), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(f.id order by f.created_at) from pm.doc_files f where f.org_id = d.org_id and f.job_id = d.job_id and f.kind = 'photo'
                          and f.status = 'active' and f.created_at::date > v_from and f.created_at::date <= d.period_end + 3), '[]'::jsonb),
    'invoices', jsonb_build_object('count', (select count(*) from pm.job_costs c where c.org_id = d.org_id and c.job_id = d.job_id and c.lifecycle in ('PENDING','CLEARED')
                                               and c.occurred_on > v_from and c.occurred_on <= d.period_end),
                                   'total_cents', (select coalesce(sum(c.amount_cents), 0) from pm.job_costs c where c.org_id = d.org_id and c.job_id = d.job_id
                                                     and c.lifecycle in ('PENDING','CLEARED') and c.occurred_on > v_from and c.occurred_on <= d.period_end)),
    'lien_waivers', coalesce((select jsonb_agg(jsonb_build_object('id', cd.id, 'type', cd.doc_type, 'status', cd.status, 'vendor_id', cd.vendor_id, 'covers_through', cd.covers_through))
                                from pm.compliance_docs cd where cd.org_id = d.org_id and cd.job_id = d.job_id and cd.doc_type like 'LIEN_WAIVER%'), '[]'::jsonb),
    'missing', to_jsonb(v_missing), 'complete', cardinality(v_missing) = 0);
  update pm.draws set package = coalesce(package, '{}'::jsonb) || v_pkg where id = d.id;
  return v_pkg;
end $$;

create or replace function pm.res_try_date(p text) returns date
language plpgsql immutable
set search_path = pm, public
as $$ begin return p::date; exception when others then return null; end $$;

-- What the lender did not fund goes to the owner (RES-82): a DRAFT billing request to the customer.
create or replace function pm.res_request_draw_shortfall(p_draw uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.draws%rowtype; v_short bigint; v_contract uuid; v_req uuid := gen_random_uuid(); v_loc uuid;
begin
  select * into d from pm.draws x where x.id = p_draw and x.org_id = public.get_org_id();
  if d.id is null then raise exception 'PM_FORBIDDEN: draw % not found', p_draw using errcode = '42501'; end if;
  if d.status <> 'FUNDED' then raise exception 'PM_DRAW_TRANSITION_INVALID: the shortfall is known once the draw is funded' using errcode = '22023'; end if;
  v_short := coalesce(d.requested_cents, d.loan_expected_cents, 0) - coalesce(d.funded_cents, 0);
  if v_short <= 0 then raise exception 'PM_RES_NO_SHORTFALL: the lender funded the full request' using errcode = '22023'; end if;
  if exists (select 1 from pm.billing_requests r where r.org_id = d.org_id and r.job_id = d.job_id and r.memo = format('Draw %s shortfall', d.draw_number) and r.status <> 'VOID') then
    raise exception 'PM_RES_SHORTFALL_EXISTS: the shortfall for draw % is already billed', d.draw_number using errcode = '22023';
  end if;
  v_contract := pm.primary_contract_id(d.org_id, d.job_id);
  if v_contract is null then raise exception 'PRECONDITION_NO_CONTRACT: job % has no ACTIVE contract', d.job_id using errcode = 'P0001'; end if;
  insert into pm.billing_requests (id, org_id, job_id, contract_id, billing_type, status, generated_by, occurred_on, memo, created_by)
  values (v_req, d.org_id, d.job_id, v_contract, 'PROGRESS', 'DRAFT', 'progress', current_date, format('Draw %s shortfall', d.draw_number), pm.current_user_id());
  insert into pm.billing_request_lines (org_id, billing_request_id, line_no, sort, line_type, description, amount_cents, this_period_work_cents, retainage_rate)
  values (d.org_id, v_req, 1, 0, 'STANDARD', format('Draw %s: requested %s, lender funded %s — owner portion', d.draw_number,
          coalesce(d.requested_cents, d.loan_expected_cents), d.funded_cents), v_short, v_short, 0);
  perform pm.finalize_billing_retainage(v_req);
  select j.location_id into v_loc from core.jobs j where j.id = d.job_id;
  perform pm.log_activity(d.org_id, v_loc, d.job_id, 'draw.shortfall_billed', 'draws', d.id, format('Draw %s shortfall %s cents to the owner', d.draw_number, v_short),
    jsonb_build_object('billing_request_id', v_req));
  return v_req;
end $$;

-- Sales tax by contract form (RES-85), for a proposal: the same rule as the proposal totals.
create or replace function pm.res_tax_preview(p_proposal uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare p pm.res_proposals%rowtype; st pm.res_state_rules%rowtype; v_cats jsonb;
begin
  select * into p from pm.res_proposals x where x.id = p_proposal and x.org_id = public.get_org_id();
  if p.id is null then raise exception 'PM_FORBIDDEN: proposal % not found', p_proposal using errcode = '42501'; end if;
  if p.state_code is not null then select * into st from pm.res_state_rules s where s.state_code = p.state_code; end if;
  select coalesce(jsonb_object_agg(cat, jsonb_build_object('price_cents', price, 'taxable', taxable)), '{}'::jsonb) into v_cats from (
    select l.tax_category as cat, sum(l.price_cents)::bigint as price,
           (p.tax_contract_form = 'RETAIL_PLUS_INSTALL' and (l.tax_category in ('MATERIAL','EQUIPMENT') or (l.tax_category = 'LABOR' and coalesce(st.labor_taxable, false))
                                                             or (l.tax_category = 'DESIGN_FEE' and coalesce(st.design_fee_taxable, false)))) as taxable
      from pm.res_proposal_lines l left join pm.res_proposal_options o on o.id = l.option_id
     where l.org_id = p.org_id and l.proposal_id = p.id and (l.option_id is null or o.is_selected)
     group by l.tax_category) z;
  return jsonb_build_object('tax_contract_form', p.tax_contract_form, 'tax_rate', p.tax_rate, 'state_code', p.state_code,
    'labor_taxable', coalesce(st.labor_taxable, false), 'design_fee_taxable', coalesce(st.design_fee_taxable, false),
    'categories', v_cats, 'tax_cents', p.tax_cents,
    'rule', case p.tax_contract_form
      when 'LUMP_SUM_IMPROVEMENT' then 'Real-property improvement: the contractor pays tax on materials as the consumer; the homeowner''s invoices carry no sales tax.'
      when 'RETAIL_PLUS_INSTALL' then 'Retail sale plus installation: product lines are taxed on the invoice; installation labor and design fees follow the state rule.'
      else 'Exempt: no sales tax on this contract.' end);
end $$;

-- The daily leak scan (RES-125): what should have been billed or fixed and wasn't.
create or replace function pm.res_billing_integrity(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_out jsonb := '[]'::jsonb; v_cv boolean;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = v_org) then
    raise exception 'PM_FORBIDDEN: company % not found', p_location using errcode = '42501';
  end if;
  v_cv := pm.access_is_service() or pm.can('projects.contract_value', 'view', p_location);
  -- completed milestones not invoiced (or held)
  v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('kind', case when s.status = 'HELD' then 'milestone_held' else 'milestone_unbilled' end,
             'job_id', s.job_id, 'subject_id', s.id, 'label', s.label, 'reason', s.hold_reason, 'amount_cents', case when v_cv then s.amount_cents + s.added_cents end))
      from pm.res_payment_schedule s join core.jobs j on j.id = s.job_id
     where s.org_id = v_org and j.location_id = p_location and s.job_id in (select pm.my_job_ids())
       and (s.status = 'HELD' or (s.status = 'SCHEDULED' and exists (select 1 from pm.tasks t where t.id = s.task_id and t.status = 'DONE')))), '[]'::jsonb);
  -- approved change orders since the job's last billing request
  v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('kind', 'change_order_unbilled', 'job_id', c.job_id, 'subject_id', c.id, 'label', c.number || ' ' || c.title,
             'amount_cents', case when v_cv then c.amount_cents end))
      from pm.change_orders c join core.jobs j on j.id = c.job_id
     where c.org_id = v_org and j.location_id = p_location and c.job_id in (select pm.my_job_ids()) and c.stage = 'APPROVED' and c.amount_cents > 0
       and c.approved_at > coalesce((select max(r.created_at) from pm.billing_requests r where r.org_id = c.org_id and r.job_id = c.job_id and r.status <> 'VOID'), '-infinity'::timestamptz)
       and not exists (select 1 from pm.deposit_requests d where d.org_id = c.org_id and d.job_id = c.job_id and d.created_at >= c.approved_at - interval '1 minute' and d.amount_cents = c.amount_cents)), '[]'::jsonb);
  -- cost-plus costs posted and not billed
  v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('kind', 'cost_plus_unbilled', 'job_id', x.job_id, 'count', x.n, 'amount_cents', case when v_cv then x.amt end))
      from (select c.job_id, count(*) as n, sum(c.amount_cents)::bigint as amt from pm.job_costs c join pm.res_job_terms t on t.org_id = c.org_id and t.job_id = c.job_id
             join core.jobs j on j.id = c.job_id
            where c.org_id = v_org and j.location_id = p_location and c.job_id in (select pm.my_job_ids()) and t.contract_type like 'COST_PLUS%' and c.lifecycle = 'CLEARED'
              and not exists (select 1 from pm.billing_links bl where bl.org_id = c.org_id and bl.source_table = 'job_costs' and bl.source_id = c.id)
            group by c.job_id) x), '[]'::jsonb);
  -- timecards waiting more than two days
  v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('kind', 'time_unapproved', 'job_id', x.job_id, 'count', x.n))
      from (select te.job_id, count(*) as n from pm.time_entries te join core.jobs j on j.id = te.job_id
             where te.org_id = v_org and j.location_id = p_location and te.job_id in (select pm.my_job_ids()) and te.approval_state = 'SUBMITTED'
               and te.work_date < current_date - 2 group by te.job_id) x), '[]'::jsonb);
  -- expired COIs on active trades
  v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('kind', 'coi_expired', 'job_id', cd.job_id, 'subject_id', cd.id, 'vendor_id', cd.vendor_id, 'expires_on', cd.expires_on))
      from pm.compliance_docs cd join pm.commitments cm on cm.org_id = cd.org_id and cm.id = cd.commitment_id
     where cd.org_id = v_org and cm.location_id = p_location and cd.job_id in (select pm.my_job_ids()) and cd.doc_type = 'COI'
       and cm.status in ('APPROVED','EXECUTED') and (cd.status = 'EXPIRED' or cd.expires_on < current_date)), '[]'::jsonb);
  return v_out;
end $$;

-- Homeowner decision queue (RES-88): everything waiting on the household, soonest / costliest first.
create or replace function pm.res_decision_queue(p_job uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_cv boolean;
begin
  if not exists (select 1 from pm.my_job_ids() x where x = p_job) and not pm.access_is_service() then
    raise exception 'PM_FORBIDDEN: job % is not one of your jobs', p_job using errcode = '42501';
  end if;
  v_cv := pm.access_is_service() or exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = p_job);
  return coalesce((select jsonb_agg(q order by (q ->> 'due_on') nulls last, (q ->> 'kind')) from (
      select jsonb_build_object('kind', 'selection', 'id', s.id, 'title', s.title, 'category', s.category, 'room', s.room, 'due_on', s.due_on,
                                'at_risk', s.at_risk, 'allowance_cents', case when v_cv then coalesce(s.allowance_cents, al.allowance_cents) end) as q
        from pm.selections s left join pm.allowances al on al.id = s.allowance_id
       where s.org_id = v_org and s.job_id = p_job and s.status in ('OPEN','PROPOSED','REJECTED') and s.client_visible
      union all
      select jsonb_build_object('kind', 'change_order', 'id', c.id, 'title', c.number || ' ' || c.title, 'due_on', (coalesce(c.priced_at, c.created_at) + interval '2 days')::date,
                                'stop_work', c.stop_work, 'amount_cents', case when v_cv then c.amount_cents end)
        from pm.change_orders c where c.org_id = v_org and c.job_id = p_job and c.stage in ('PCO','COR') and c.priced_at is not null and c.signed_at is null
      union all
      select jsonb_build_object('kind', 'deposit', 'id', d.id, 'title', d.memo, 'due_on', d.occurred_on, 'status', d.status,
                                'amount_cents', case when v_cv then d.amount_cents end)
        from pm.deposit_requests d where d.org_id = v_org and d.job_id = p_job and d.status in ('EMITTED','ISSUED')
      union all
      select jsonb_build_object('kind', 'proposal', 'id', p.id, 'title', p.title, 'due_on', p.valid_until, 'amount_cents', case when v_cv then p.grand_total_cents end)
        from pm.res_proposals p where p.org_id = v_org and p.job_id = p_job and p.status = 'SENT'
      union all
      select jsonb_build_object('kind', 'walkthrough', 'id', w.id, 'title', replace(initcap(replace(w.kind, '_', ' ')), 'Warranty ', 'Warranty walk '), 'due_on', w.due_on)
        from pm.res_walks w where w.org_id = v_org and w.job_id = p_job and w.status in ('PLANNED','SCHEDULED') and w.due_on <= current_date + 14
    ) z(q)), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------
-- 9b. Portal integration (1118): household invites at acceptance; portal answers mirror the
--     one-tap trade confirmations. Both are no-ops when the portals migration is not installed.
-- ----------------------------------------------------------------------------
create or replace function pm._res_invite_household(p_job uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare h record; v_loc uuid; n int := 0;
begin
  if to_regprocedure('pm.portal_invite(uuid,text,uuid,uuid[],jsonb)') is null then return 0; end if;
  select j.location_id into v_loc from core.jobs j where j.id = p_job;
  for h in select * from pm.res_household_members m where m.job_id = p_job and m.contact_id is not null and m.portal_status = 'PENDING_INVITE' loop
    begin
      execute 'select pm.portal_invite($1, $2, $3, $4, $5)' using v_loc, 'customer', h.contact_id, array[p_job],
        jsonb_build_object('role', 'approver', 'can_sign', h.can_sign, 'can_pay', h.can_pay);
      update pm.res_household_members set portal_status = 'INVITED', invited_at = now() where id = h.id;
      n := n + 1;
    exception when others then
      null;   -- the caller may not invite (customers:edit), or the contact has no address: stays PENDING_INVITE for the office
    end;
  end loop;
  return n;
end $$;

create or replace function pm.tg_res_portal_task_response() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  update pm.res_task_trades
     set status = case new.response when 'confirmed' then 'CONFIRMED' when 'declined' then 'DECLINED' else 'PROPOSED' end,
         proposed_on = new.proposed_start, response_note = left(new.note, 1000), responded_at = now()
   where org_id = new.org_id and task_id = new.task_id and vendor_id = new.vendor_id and status <> 'CANCELLED';
  return null;
end $$;

do $$
begin
  if to_regclass('pm.portal_task_responses') is not null then
    execute 'drop trigger if exists trg_res_portal_task_response on pm.portal_task_responses';
    execute 'create trigger trg_res_portal_task_response after insert on pm.portal_task_responses for each row execute function pm.tg_res_portal_task_response()';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Home builder: price book, purchase agreements, design center, start packages, VPOs, closing
-- ----------------------------------------------------------------------------
create or replace function pm.res_stage_rank(p text) returns int
language sql immutable
set search_path = pm, public
as $$ select case p when 'PRE_START' then 1 when 'PRE_FRAME' then 2 when 'PRE_DRYWALL' then 3 when 'PRE_TRIM' then 4 when 'CLOSEOUT' then 5 when 'ANYTIME' then 9 else 0 end $$;

-- Where a lot's house is (for design-center cutoffs): not started → PRE_START; framing begun →
-- PRE_DRYWALL; drywall begun → PRE_TRIM; trim begun → past every cutoff (CLOSEOUT).
create or replace function pm.res_lot_stage(p_job uuid) returns text
language sql stable security definer
set search_path = pm, core, public
as $$
  select case
    when p_job is null or not exists (select 1 from pm.tasks t where t.job_id = p_job and t.status in ('IN_PROGRESS','DONE') and not t.is_summary) then 'PRE_START'
    when exists (select 1 from pm.tasks t where t.job_id = p_job and t.status in ('IN_PROGRESS','DONE') and not t.is_summary and t.title ~* '(trim|cabinet|finish carp)') then 'CLOSEOUT'
    when exists (select 1 from pm.tasks t where t.job_id = p_job and t.status in ('IN_PROGRESS','DONE') and not t.is_summary and t.title ~* 'drywall') then 'PRE_TRIM'
    when exists (select 1 from pm.tasks t where t.job_id = p_job and t.status in ('IN_PROGRESS','DONE') and not t.is_summary and t.title ~* 'fram') then 'PRE_DRYWALL'
    else 'PRE_FRAME' end
$$;

-- The effective price of an option for a lot (most specific row wins: community + plan, community,
-- plan, everyone), on a date.
create or replace function pm._res_option_price(p_option uuid, p_community uuid, p_plan uuid, p_on date) returns bigint
language sql stable security definer
set search_path = pm, core, public
as $$
  select op.price_cents from pm.res_option_prices op
   where op.option_id = p_option and (op.community_id is null or op.community_id = p_community) and (op.plan_id is null or op.plan_id = p_plan)
     and op.effective_from <= p_on and (op.effective_to is null or op.effective_to >= p_on)
   order by (op.community_id is not null) desc, (op.plan_id is not null) desc, op.effective_from desc limit 1
$$;

-- Price a lot + plan + elevation + options (RES-104), with the rule checks.
create or replace function pm.res_quote_lot(p_lot uuid, p_plan uuid, p_elevation uuid default null, p_options uuid[] default '{}', p_on date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare l pm.res_lots%rowtype; pl pm.res_plans%rowtype; v_on date := coalesce(p_on, current_date); v_base bigint; v_elev bigint := 0; o record;
  v_opts jsonb := '[]'::jsonb; v_sum bigint := 0; v_issues text[] := '{}'; v_price bigint; v_fin boolean; v_cost bigint := 0;
begin
  select * into l from pm.res_lots x where x.id = p_lot and x.org_id = public.get_org_id();
  if l.id is null then raise exception 'PM_FORBIDDEN: lot % not found', p_lot using errcode = '42501'; end if;
  select * into pl from pm.res_plans x where x.id = p_plan and x.org_id = l.org_id and x.location_id = l.location_id;
  if pl.id is null then raise exception 'PM_INVALID: plan is not in this company''s plan book' using errcode = '22023'; end if;
  v_fin := pm.access_is_service() or pm.can('projects.financials', 'view', l.location_id);
  select pp.base_price_cents into v_base from pm.res_plan_prices pp
   where pp.plan_id = pl.id and (pp.community_id is null or pp.community_id = l.community_id) and pp.effective_from <= v_on
     and (pp.effective_to is null or pp.effective_to >= v_on)
   order by (pp.community_id is not null) desc, pp.effective_from desc limit 1;
  if v_base is null then v_issues := v_issues || 'No base price for this plan in this community on this date'::text; end if;
  if p_elevation is not null then
    select e.premium_cents into v_elev from pm.res_elevations e where e.id = p_elevation and e.plan_id = pl.id;
    if v_elev is null then v_issues := v_issues || 'The elevation is not one of this plan''s'::text; v_elev := 0; end if;
  end if;
  for o in select x.* from pm.res_options x where x.id = any (coalesce(p_options, '{}')) and x.org_id = l.org_id loop
    v_price := pm._res_option_price(o.id, l.community_id, pl.id, v_on);
    if v_price is null then v_issues := v_issues || format('%s has no price on this date', o.name); v_price := 0; end if;
    if o.plan_ids is not null and not (pl.id = any (o.plan_ids)) then v_issues := v_issues || format('%s is not offered on plan %s', o.name, pl.code); end if;
    if exists (select 1 from unnest(o.requires) r where not (r = any (p_options))) then
      v_issues := v_issues || format('%s requires %s', o.name, (select string_agg(x.name, ', ') from pm.res_options x where x.id = any (o.requires) and not (x.id = any (p_options))));
    end if;
    if exists (select 1 from unnest(o.excludes) r where r = any (p_options)) then
      v_issues := v_issues || format('%s cannot be combined with %s', o.name, (select string_agg(x.name, ', ') from pm.res_options x where x.id = any (o.excludes) and x.id = any (p_options)));
    end if;
    v_sum := v_sum + v_price;
    v_cost := v_cost + coalesce(o.cost_cents, 0);
    v_opts := v_opts || jsonb_build_object('option_id', o.id, 'code', o.code, 'name', o.name, 'price_cents', v_price, 'cutoff_stage', o.cutoff_stage,
                                           'is_structural', o.is_structural,
                                           'margin_pct', case when v_fin and v_price > 0 and o.cost_cents is not null then round((v_price - o.cost_cents)::numeric / v_price, 4) end);
  end loop;
  if cardinality(coalesce(p_options, '{}')) <> (select count(*) from pm.res_options x where x.id = any (coalesce(p_options, '{}')) and x.org_id = l.org_id) then
    v_issues := v_issues || 'An option is not in this company''s option book'::text;
  end if;
  return jsonb_build_object('lot_id', l.id, 'plan_id', pl.id, 'base_price_cents', v_base, 'elevation_cents', v_elev, 'lot_premium_cents', l.premium_cents,
    'options', v_opts, 'options_cents', v_sum, 'total_cents', coalesce(v_base, 0) + v_elev + l.premium_cents + v_sum, 'issues', to_jsonb(v_issues),
    'margin_pct', case when v_fin and pl.base_cost_cents is not null and coalesce(v_base, 0) + v_elev + v_sum > 0
                       then round((coalesce(v_base, 0) + v_elev + v_sum - pl.base_cost_cents - v_cost)::numeric / (coalesce(v_base, 0) + v_elev + v_sum), 4) end,
    'below_target', case when v_fin and pl.target_margin_pct is not null and pl.base_cost_cents is not null and coalesce(v_base, 0) + v_elev + v_sum > 0
                         then (coalesce(v_base, 0) + v_elev + v_sum - pl.base_cost_cents - v_cost)::numeric / (coalesce(v_base, 0) + v_elev + v_sum) < pl.target_margin_pct end);
end $$;

create or replace function pm._res_pa_totals(p_pa uuid) returns void
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  update pm.res_purchase_agreements a
     set options_cents = coalesce((select sum(o.price_cents * o.qty)::bigint from pm.res_pa_options o where o.agreement_id = a.id and o.status = 'ACTIVE'), 0),
         fees_cents = coalesce((select sum(d.late_fee_cents) from pm.res_pa_addenda d where d.agreement_id = a.id and d.status = 'SIGNED'), 0)
   where a.id = p_pa;
  update pm.res_purchase_agreements a set total_cents = a.base_price_cents + a.elevation_cents + a.lot_premium_cents + a.options_cents + a.fees_cents - a.incentives_cents
   where a.id = p_pa;
end $$;

-- Purchase agreement (RES-105): lot + plan + elevation + options + premium + incentives + earnest money + contingencies.
create or replace function pm.res_create_purchase_agreement(p_lot uuid, p_customer uuid, p_plan uuid, p_elevation uuid default null,
                                                            p_options uuid[] default '{}', p_attrs jsonb default '{}') returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.res_lots%rowtype; q jsonb; v_id uuid := gen_random_uuid(); a jsonb := coalesce(p_attrs, '{}'::jsonb); x jsonb;
begin
  select * into l from pm.res_lots x2 where x2.id = p_lot and x2.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: lot % not found', p_lot using errcode = '42501'; end if;
  if l.status not in ('AVAILABLE','HELD','STARTED','COMPLETE') or (l.status in ('STARTED','COMPLETE') and not l.is_spec) then
    raise exception 'PM_RES_LOT_NOT_AVAILABLE: lot % is %', l.lot_number, lower(l.status) using errcode = '22023';
  end if;
  if not exists (select 1 from core.customers c where c.id = p_customer and c.org_id = l.org_id) then raise exception 'PM_INVALID: buyer not found' using errcode = '22023'; end if;
  if l.is_spec and l.plan_id is not null and l.plan_id <> p_plan then raise exception 'PM_INVALID: a spec home keeps its plan' using errcode = '22023'; end if;
  q := pm.res_quote_lot(l.id, p_plan, p_elevation, p_options);
  if jsonb_array_length(q -> 'issues') > 0 then raise exception 'PM_RES_OPTION_RULES: %', (select string_agg(value, '; ') from jsonb_array_elements_text(q -> 'issues')) using errcode = '22023'; end if;
  insert into pm.res_purchase_agreements (id, org_id, location_id, lot_id, job_id, customer_id, number, plan_id, elevation_id, base_price_cents, elevation_cents,
                                          lot_premium_cents, incentives_cents, earnest_money_cents, earnest_in_escrow, contingencies)
  values (v_id, l.org_id, l.location_id, l.id, l.job_id, p_customer, 'PA-' || l.lot_number || '-' || to_char(current_date, 'YYMMDD'), p_plan, p_elevation,
          coalesce((q ->> 'base_price_cents')::bigint, 0), (q ->> 'elevation_cents')::bigint, (q ->> 'lot_premium_cents')::bigint,
          coalesce((a ->> 'incentives_cents')::bigint, l.incentives_cents, 0), coalesce((a ->> 'earnest_money_cents')::bigint, 0),
          coalesce((a ->> 'earnest_in_escrow')::boolean, true), coalesce(case when jsonb_typeof(a -> 'contingencies') = 'array' then a -> 'contingencies' end, '[]'::jsonb));
  for x in select value from jsonb_array_elements(q -> 'options') loop
    insert into pm.res_pa_options (org_id, agreement_id, option_id, price_cents) values (l.org_id, v_id, (x ->> 'option_id')::uuid, (x ->> 'price_cents')::bigint);
  end loop;
  perform pm._res_pa_totals(v_id);
  update pm.res_lots set status = case when status = 'AVAILABLE' then 'HELD' else status end, held_for = 'Purchase agreement', held_until = current_date + 14 where id = l.id;
  return v_id;
end $$;

-- Sign: the lot is sold; the house job exists (created, or the spec job gets its buyer); contract = PA
-- total; earnest money → deposit request (Books: customer deposit liability, escrow flag in the memo).
create or replace function pm.res_sign_purchase_agreement(p_pa uuid, p_signer_name text, p_job_type_key text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.res_purchase_agreements%rowtype; l pm.res_lots%rowtype; pl pm.res_plans%rowtype; v_job uuid; v_prev text; v_dep uuid; v_jt text; v_contract uuid;
begin
  select * into a from pm.res_purchase_agreements x where x.id = p_pa and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: purchase agreement % not found', p_pa using errcode = '42501'; end if;
  if a.status <> 'DRAFT' then raise exception 'PM_RES_PA_STATE: the agreement is %', lower(a.status) using errcode = '22023'; end if;
  if p_signer_name is null or btrim(p_signer_name) = '' then raise exception 'PM_INVALID: the buyer''s name is required' using errcode = '22023'; end if;
  select * into l from pm.res_lots where id = a.lot_id for update;
  select * into pl from pm.res_plans where id = a.plan_id;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_job := l.job_id;
  if v_job is null then
    v_jt := coalesce(nullif(p_job_type_key, ''), pl.job_type_key,
                     (select t.key from pm.job_types t where t.org_id = a.org_id and t.location_id = a.location_id and t.is_active order by t.sort, t.key limit 1));
    v_job := pm.create_project(a.location_id, v_jt, left(format('Lot %s %s — %s', l.lot_number, coalesce(l.block, ''), pl.name), 200), a.customer_id, a.total_cents, false, '{}'::jsonb);
  else
    update core.jobs set customer_id = a.customer_id, customer_name = (select c.name from core.customers c where c.id = a.customer_id) where id = v_job;
    v_contract := pm.primary_contract_id(a.org_id, v_job);
    if v_contract is null then perform pm.set_contract(v_job, a.total_cents, 'PRIME', null, null, null, null);
    else perform pm.set_contract(v_job, a.total_cents, 'PRIME', null, null, v_contract, null); end if;
  end if;
  insert into pm.res_job_terms (org_id, job_id, contract_type, tax_contract_form, open_book)
  values (a.org_id, v_job, 'PURCHASE_AGREEMENT', 'LUMP_SUM_IMPROVEMENT', false)
  on conflict (org_id, job_id) do update set contract_type = 'PURCHASE_AGREEMENT';
  if a.earnest_money_cents > 0 then
    v_dep := pm.request_deposit(v_job, a.earnest_money_cents,
      left(format('Earnest money — lot %s%s', l.lot_number, case when a.earnest_in_escrow then ' (held in escrow)' else '' end), 200), current_date);
  end if;
  perform set_config('pm.access_entry', v_prev, true);
  update pm.res_purchase_agreements set status = 'SIGNED', signed_at = now(), signed_by_name = btrim(p_signer_name), job_id = v_job, deposit_request_id = v_dep where id = a.id;
  update pm.res_lots set status = case when status in ('STARTED','COMPLETE') then status else 'SOLD' end, job_id = v_job,
         plan_id = a.plan_id, elevation_id = a.elevation_id, held_until = null, held_for = null where id = l.id;
  perform pm._res_household_from_customer(v_job);
  perform pm._res_invite_household(v_job);
  perform pm.log_activity(a.org_id, a.location_id, v_job, 'purchase_agreement.signed', 'res_purchase_agreements', a.id,
    format('Purchase agreement signed by %s: lot %s', btrim(p_signer_name), l.lot_number), jsonb_build_object('deposit_request_id', v_dep, 'total_cents', a.total_cents));
  return jsonb_build_object('purchase_agreement_id', a.id, 'job_id', v_job, 'deposit_request_id', v_dep, 'total_cents', a.total_cents);
end $$;

-- Design center (RES-106): add / remove options as an addendum. Past an option's cutoff a structural
-- option is refused; any other option carries the late-change fee.
create or replace function pm.res_pa_change_options(p_pa uuid, p_add uuid[] default '{}', p_remove uuid[] default '{}', p_signer_name text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare a pm.res_purchase_agreements%rowtype; l pm.res_lots%rowtype; v_stage text; o record; v_lines jsonb := '[]'::jsonb; v_change bigint := 0;
  v_fee bigint := 0; v_fee_each bigint; v_add_id uuid; v_seq int; v_price bigint; v_all uuid[]; q jsonb; v_late boolean := false; v_prev text; v_regen jsonb;
begin
  select * into a from pm.res_purchase_agreements x where x.id = p_pa and x.org_id = public.get_org_id() for update;
  if a.id is null then raise exception 'PM_FORBIDDEN: purchase agreement % not found', p_pa using errcode = '42501'; end if;
  if a.status not in ('DRAFT','SIGNED') then raise exception 'PM_RES_PA_STATE: the agreement is %', lower(a.status) using errcode = '22023'; end if;
  select * into l from pm.res_lots where id = a.lot_id;
  v_stage := pm.res_lot_stage(a.job_id);
  select coalesce(s.late_change_fee_cents, 25000) into v_fee_each from pm.res_settings s where s.org_id = a.org_id and s.location_id = a.location_id;
  v_fee_each := coalesce(v_fee_each, 25000);
  select array_agg(distinct x) into v_all from (
    select o2.option_id as x from pm.res_pa_options o2 where o2.agreement_id = a.id and o2.status = 'ACTIVE' and not (o2.option_id = any (coalesce(p_remove, '{}')))
    union select unnest(coalesce(p_add, '{}'))) z;
  q := pm.res_quote_lot(l.id, a.plan_id, a.elevation_id, coalesce(v_all, '{}'));
  if jsonb_array_length(q -> 'issues') > 0 then raise exception 'PM_RES_OPTION_RULES: %', (select string_agg(value, '; ') from jsonb_array_elements_text(q -> 'issues')) using errcode = '22023'; end if;
  for o in select x.*, (x.id = any (coalesce(p_add, '{}'))) as adding from pm.res_options x
            where x.org_id = a.org_id and (x.id = any (coalesce(p_add, '{}')) or x.id = any (coalesce(p_remove, '{}'))) loop
    if pm.res_stage_rank(v_stage) > pm.res_stage_rank(o.cutoff_stage) then
      if o.is_structural then
        raise exception 'PM_RES_CUTOFF_PASSED: % is structural and its cutoff (%) has passed', o.name, lower(replace(o.cutoff_stage, '_', ' ')) using errcode = '22023';
      end if;
      v_late := true;
    end if;
    if o.adding then
      if exists (select 1 from pm.res_pa_options x where x.agreement_id = a.id and x.option_id = o.id and x.status = 'ACTIVE') then continue; end if;
      v_price := pm._res_option_price(o.id, l.community_id, a.plan_id, current_date);
      v_change := v_change + v_price;
      v_lines := v_lines || jsonb_build_object('option_id', o.id, 'name', o.name, 'action', 'ADD', 'price_cents', v_price);
    else
      select x.price_cents into v_price from pm.res_pa_options x where x.agreement_id = a.id and x.option_id = o.id and x.status = 'ACTIVE';
      continue when v_price is null;
      v_change := v_change - v_price;
      v_lines := v_lines || jsonb_build_object('option_id', o.id, 'name', o.name, 'action', 'REMOVE', 'price_cents', -v_price);
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then return jsonb_build_object('purchase_agreement_id', a.id, 'changed', false); end if;
  v_fee := case when v_late and a.status = 'SIGNED' then v_fee_each else 0 end;
  select coalesce(max(seq), 0) + 1 into v_seq from pm.res_pa_addenda where agreement_id = a.id;
  insert into pm.res_pa_addenda (org_id, agreement_id, seq, kind, change_cents, late_fee_cents, lines, status, signed_at, signed_by_name)
  values (a.org_id, a.id, v_seq, 'OPTIONS', v_change, v_fee, v_lines,
          case when p_signer_name is not null or a.status = 'DRAFT' then 'SIGNED' else 'DRAFT' end,
          case when p_signer_name is not null or a.status = 'DRAFT' then now() end, p_signer_name)
  returning id into v_add_id;
  if p_signer_name is not null or a.status = 'DRAFT' then
    perform pm._res_apply_addendum(v_add_id);
  end if;
  return jsonb_build_object('purchase_agreement_id', a.id, 'addendum_id', v_add_id, 'change_cents', v_change, 'late_fee_cents', v_fee, 'stage', v_stage,
                            'signed', p_signer_name is not null or a.status = 'DRAFT', 'lines', v_lines);
end $$;

create or replace function pm._res_apply_addendum(p_addendum uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.res_pa_addenda%rowtype; a pm.res_purchase_agreements%rowtype; x jsonb; v_prev text; v_contract uuid; v_regen jsonb;
begin
  select * into d from pm.res_pa_addenda where id = p_addendum;
  select * into a from pm.res_purchase_agreements where id = d.agreement_id for update;
  for x in select value from jsonb_array_elements(d.lines) loop
    if x ->> 'action' = 'ADD' then
      insert into pm.res_pa_options (org_id, agreement_id, option_id, price_cents, addendum_id) values (a.org_id, a.id, (x ->> 'option_id')::uuid, (x ->> 'price_cents')::bigint, d.id);
    else
      update pm.res_pa_options set status = 'REMOVED', addendum_id = d.id where agreement_id = a.id and option_id = (x ->> 'option_id')::uuid and status = 'ACTIVE';
    end if;
  end loop;
  perform pm._res_pa_totals(a.id);
  select * into a from pm.res_purchase_agreements where id = a.id;
  if a.status = 'SIGNED' and a.job_id is not null then
    v_prev := coalesce(current_setting('pm.access_entry', true), '');
    perform set_config('pm.access_entry', 'on', true);
    v_contract := pm.primary_contract_id(a.org_id, a.job_id);
    if v_contract is not null then perform pm.set_contract(a.job_id, a.total_cents, 'PRIME', null, null, v_contract, null); end if;
    perform set_config('pm.access_entry', v_prev, true);
    if exists (select 1 from pm.res_start_package_items i where i.lot_id = a.lot_id) then
      v_regen := pm._res_regenerate_start_package(a.lot_id, true);
    end if;
  end if;
  return coalesce(v_regen, '{}'::jsonb);
end $$;

create or replace function pm.res_sign_addendum(p_addendum uuid, p_signer_name text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare d pm.res_pa_addenda%rowtype;
begin
  select * into d from pm.res_pa_addenda x where x.id = p_addendum and x.org_id = public.get_org_id() for update;
  if d.id is null then raise exception 'PM_FORBIDDEN: addendum % not found', p_addendum using errcode = '42501'; end if;
  if d.status <> 'DRAFT' then raise exception 'PM_RES_PA_STATE: the addendum is %', lower(d.status) using errcode = '22023'; end if;
  if p_signer_name is null or btrim(p_signer_name) = '' then raise exception 'PM_INVALID: the buyer''s name is required' using errcode = '22023'; end if;
  update pm.res_pa_addenda set status = 'SIGNED', signed_at = now(), signed_by_name = btrim(p_signer_name) where id = d.id;
  return pm._res_apply_addendum(d.id);
end $$;

-- The start package a lot should have (plan + elevation + options × effective trade price agreements).
create or replace function pm._res_desired_package(p_lot uuid)
returns table (price_agreement_id uuid, option_id uuid, vendor_id uuid, release_stage text, scope text, amount_cents bigint, cost_code_id uuid)
language sql stable security definer
set search_path = pm, core, public
as $$
  with l as (select * from pm.res_lots where id = p_lot),
       pa as (select a.* from pm.res_purchase_agreements a, l where a.lot_id = l.id and a.status = 'SIGNED' order by a.signed_at desc limit 1),
       opts as (select o.option_id from pm.res_pa_options o, pa where o.agreement_id = pa.id and o.status = 'ACTIVE'),
       on_day as (select coalesce(l.started_on, current_date) as d from l)
  select g.id, g.option_id, g.vendor_id, g.release_stage, g.scope, g.amount_cents, g.cost_code_id
    from pm.res_price_agreements g, l, on_day
   where g.org_id = l.org_id and g.location_id = l.location_id
     and g.effective_from <= on_day.d and (g.effective_to is null or g.effective_to >= on_day.d)
     and (g.community_id is null or g.community_id = l.community_id)
     and ((g.option_id is null and g.plan_id = l.plan_id and (g.elevation_id is null or g.elevation_id = l.elevation_id))
          or (g.option_id is not null and g.option_id in (select option_id from opts) and (g.plan_id is null or g.plan_id = l.plan_id)))
$$;

-- Release a lot (RES-65): job + plan schedule + option tasks + the start package (commitments grouped by
-- vendor × release stage; the START stage is released at once). Flags options without a price agreement.
create or replace function pm.res_release_lot(p_lot uuid, p_start_on date default null, p_job_type_key text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.res_lots%rowtype; pl pm.res_plans%rowtype; v_job uuid; v_prev text; v_tpl jsonb; v_missing jsonb; o record; v_task uuid; x jsonb; v_rel jsonb; v_jt text; r jsonb;
begin
  select * into l from pm.res_lots x2 where x2.id = p_lot and x2.org_id = public.get_org_id() for update;
  if l.id is null then raise exception 'PM_FORBIDDEN: lot % not found', p_lot using errcode = '42501'; end if;
  if l.plan_id is null then raise exception 'PM_INVALID: give the lot a plan before releasing it' using errcode = '22023'; end if;
  if l.status not in ('SOLD','AVAILABLE','HELD') or (l.status in ('AVAILABLE','HELD') and not l.is_spec) then
    raise exception 'PM_RES_LOT_NOT_RELEASABLE: lot % is % (sell it, or mark it a spec home)', l.lot_number, lower(l.status) using errcode = '22023';
  end if;
  if exists (select 1 from pm.res_start_package_items i where i.lot_id = l.id and i.status <> 'VOID') then
    raise exception 'PM_RES_ALREADY_RELEASED: lot % is already released (change options to regenerate its package)', l.lot_number using errcode = '22023';
  end if;
  select * into pl from pm.res_plans where id = l.plan_id;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v_job := l.job_id;
  if v_job is null then
    v_jt := coalesce(nullif(p_job_type_key, ''), pl.job_type_key,
                     (select t.key from pm.job_types t where t.org_id = l.org_id and t.location_id = l.location_id and t.is_active order by t.sort, t.key limit 1));
    v_job := pm.create_project(l.location_id, v_jt, left(format('Lot %s %s — %s (spec)', l.lot_number, coalesce(l.block, ''), pl.name), 200), null, null, false, '{}'::jsonb);
    update pm.res_lots set job_id = v_job where id = l.id;
  end if;
  update pm.res_lots set status = 'STARTED', started_on = coalesce(p_start_on, current_date) where id = l.id;
  if pl.schedule_template_key is not null and not exists (select 1 from pm.tasks t where t.job_id = v_job and t.template_ref like pl.schedule_template_key || ':%') then
    begin
      v_tpl := pm.apply_schedule_template(v_job, pl.schedule_template_key, coalesce(p_start_on, current_date));
    exception when others then v_tpl := jsonb_build_object('error', sqlerrm);
    end;
  end if;
  -- option tasks (sold options add their own work)
  for o in select ro.* from pm.res_options ro join pm.res_pa_options po on po.option_id = ro.id and po.status = 'ACTIVE'
             join pm.res_purchase_agreements a on a.id = po.agreement_id and a.lot_id = l.id and a.status = 'SIGNED'
            where jsonb_array_length(ro.add_tasks) > 0 loop
    for x in select value from jsonb_array_elements(o.add_tasks) loop
      insert into pm.tasks (org_id, job_id, title, description, duration_days, status, created_by)
      values (l.org_id, v_job, left(coalesce(x ->> 'title', o.name), 200), left('Option: ' || o.name, 500), coalesce((x ->> 'duration')::int, 1), 'TODO', pm.current_user_id())
      returning id into v_task;
      if x ->> 'after_ref' is not null and pl.schedule_template_key is not null then
        insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days)
        select l.org_id, t.id, v_task, 'FS', 0 from pm.tasks t where t.job_id = v_job and t.template_ref = pl.schedule_template_key || ':' || (x ->> 'after_ref') limit 1
        on conflict do nothing;
      end if;
    end loop;
  end loop;
  begin perform pm._schedule_run(v_job); exception when others then null; end;
  perform set_config('pm.access_entry', v_prev, true);
  r := pm._res_regenerate_start_package(l.id, true);
  v_rel := pm._res_release_stage(l.id, 'START');
  select coalesce(jsonb_agg(jsonb_build_object('option_id', ro.id, 'name', ro.name)), '[]'::jsonb) into v_missing
    from pm.res_options ro join pm.res_pa_options po on po.option_id = ro.id and po.status = 'ACTIVE'
    join pm.res_purchase_agreements a on a.id = po.agreement_id and a.lot_id = l.id and a.status = 'SIGNED'
   where not exists (select 1 from pm._res_desired_package(l.id) d where d.option_id = ro.id);
  perform pm.log_activity(l.org_id, l.location_id, v_job, 'lot.released', 'res_lots', l.id, format('Lot %s released to build', l.lot_number),
    jsonb_build_object('package', r, 'options_without_agreement', v_missing));
  return jsonb_build_object('lot_id', l.id, 'job_id', v_job, 'schedule', v_tpl, 'package', r, 'released', v_rel, 'options_without_price_agreement', v_missing);
end $$;

-- Build / refresh the start package to match the lot's plan + options (RES-107). p_commit = false
-- previews: which items would be added or voided and which trades are affected.
create or replace function pm._res_regenerate_start_package(p_lot uuid, p_commit boolean) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare l pm.res_lots%rowtype; d record; i record; v_added jsonb := '[]'::jsonb; v_voided jsonb := '[]'::jsonb; v_c uuid; v_line int; v_prev text;
begin
  select * into l from pm.res_lots where id = p_lot;
  if l.job_id is null then return jsonb_build_object('added', '[]'::jsonb, 'voided', '[]'::jsonb); end if;
  for d in select * from pm._res_desired_package(l.id) x
            where not exists (select 1 from pm.res_start_package_items it where it.lot_id = l.id and it.price_agreement_id = x.price_agreement_id and it.status <> 'VOID') loop
    v_added := v_added || jsonb_build_object('price_agreement_id', d.price_agreement_id, 'vendor_id', d.vendor_id, 'scope', d.scope, 'stage', d.release_stage, 'amount_cents', d.amount_cents);
    if p_commit then
      -- one DRAFT commitment per vendor × stage (an approved one gets a commitment change instead)
      select c.id into v_c from pm.commitments c where c.org_id = l.org_id and c.job_id = l.job_id and c.vendor_id = d.vendor_id and c.release_stage = d.release_stage
         and c.lot_id = l.id and c.status = 'DRAFT' limit 1;
      if v_c is null and exists (select 1 from pm.commitments c where c.org_id = l.org_id and c.job_id = l.job_id and c.vendor_id = d.vendor_id
                                   and c.release_stage = d.release_stage and c.lot_id = l.id and c.status in ('APPROVED','EXECUTED')) then
        select c.id into v_c from pm.commitments c where c.org_id = l.org_id and c.job_id = l.job_id and c.vendor_id = d.vendor_id
           and c.release_stage = d.release_stage and c.lot_id = l.id and c.status in ('APPROVED','EXECUTED') limit 1;
        insert into pm.commitment_changes (org_id, job_id, commitment_id, cost_code_id, description, reason, amount_cents, created_by)
        values (l.org_id, l.job_id, v_c, d.cost_code_id, left('Option added: ' || d.scope, 300), 'Option change', greatest(d.amount_cents, 1), pm.current_user_id());
      else
        if v_c is null then
          insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, retainage_pct, release_stage, lot_id, created_by)
          values (l.org_id, l.location_id, l.job_id, d.vendor_id, 'PO', left(format('Lot %s — %s stage', l.lot_number, initcap(d.release_stage)), 200), null, d.release_stage, l.id, pm.current_user_id())
          returning id into v_c;
        end if;
        select coalesce(max(line_no), 0) + 1 into v_line from pm.commitment_lines where commitment_id = v_c;
        insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, amount_cents)
        values (l.org_id, v_c, v_line, d.cost_code_id, 'SUBCONTRACTOR', left(d.scope, 500), 1, 'LS', d.amount_cents);
      end if;
      insert into pm.res_start_package_items (org_id, job_id, lot_id, price_agreement_id, option_id, vendor_id, release_stage, scope, amount_cents, commitment_id)
      values (l.org_id, l.job_id, l.id, d.price_agreement_id, d.option_id, d.vendor_id, d.release_stage, d.scope, d.amount_cents, v_c);
    end if;
  end loop;
  for i in select it.* from pm.res_start_package_items it where it.lot_id = l.id and it.status <> 'VOID'
              and not exists (select 1 from pm._res_desired_package(l.id) x where x.price_agreement_id = it.price_agreement_id) loop
    v_voided := v_voided || jsonb_build_object('item_id', i.id, 'vendor_id', i.vendor_id, 'scope', i.scope, 'stage', i.release_stage, 'amount_cents', i.amount_cents);
    if p_commit then
      update pm.res_start_package_items set status = 'VOID' where id = i.id;
      if exists (select 1 from pm.commitments c where c.id = i.commitment_id and c.status = 'DRAFT') then
        delete from pm.commitment_lines cl where cl.commitment_id = i.commitment_id and cl.description = left(i.scope, 500) and cl.amount_cents = i.amount_cents;
      elsif exists (select 1 from pm.commitments c where c.id = i.commitment_id and c.status in ('APPROVED','EXECUTED')) then
        insert into pm.commitment_changes (org_id, job_id, commitment_id, description, reason, amount_cents, created_by)
        select l.org_id, l.job_id, i.commitment_id, left('Option removed: ' || i.scope, 300), 'Option change', -greatest(i.amount_cents, 1), pm.current_user_id();
      end if;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'voided', v_voided,
    'trades', (select coalesce(jsonb_agg(distinct (x ->> 'vendor_id')), '[]'::jsonb) from jsonb_array_elements(v_added || v_voided) x));
end $$;

create or replace function pm.res_preview_start_package(p_lot uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from pm.res_lots l where l.id = p_lot and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: lot % not found', p_lot using errcode = '42501';
  end if;
  return pm._res_regenerate_start_package(p_lot, false);
end $$;

-- Release a construction stage: its commitments go through Approvals (or approve at once when no rule applies).
create or replace function pm._res_release_stage(p_lot uuid, p_stage text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c record; v jsonb; v_out jsonb := '[]'::jsonb; v_prev text := coalesce(current_setting('pm.access_entry', true), '');
begin
  perform set_config('pm.access_entry', 'on', true);
  for c in select distinct cm.id, cm.number from pm.res_start_package_items i join pm.commitments cm on cm.id = i.commitment_id
            where i.lot_id = p_lot and i.release_stage = p_stage and i.status = 'HELD' and cm.status = 'DRAFT' loop
    begin
      v := pm.approval_decide('commitment', c.id, 'approve', 'Start package release', null, null, 'api');
      if v ->> 'status' = 'not_needed' then
        perform pm.approve_commitment(c.id);
        v := jsonb_build_object('status', 'approved');
      end if;
    exception when others then
      v := jsonb_build_object('status', 'submitted', 'error', sqlerrm);
    end;
    v_out := v_out || jsonb_build_object('commitment_id', c.id, 'number', c.number, 'status', v ->> 'status');
  end loop;
  update pm.res_start_package_items set status = 'RELEASED', released_at = now() where lot_id = p_lot and release_stage = p_stage and status = 'HELD';
  perform set_config('pm.access_entry', v_prev, true);
  return v_out;
end $$;

create or replace function pm.res_release_stage(p_lot uuid, p_stage text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from pm.res_lots l where l.id = p_lot and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: lot % not found', p_lot using errcode = '42501';
  end if;
  if p_stage not in ('START','FOUNDATION','FRAME','MECHANICAL','DRYWALL','TRIM','FINAL') then raise exception 'PM_INVALID: unknown release stage' using errcode = '22023'; end if;
  return pm._res_release_stage(p_lot, p_stage);
end $$;

-- VPO / EPO with a reason code (RES-66): a PO for the extra, through Approvals; optional chargeback party.
create or replace function pm.res_create_vpo(p_job uuid, p_vendor uuid, p_reason_code text, p_amount_cents bigint, p_description text,
                                             p_cost_code uuid default null, p_chargeback_vendor uuid default null, p_by_trade boolean default false,
                                             p_evidence uuid[] default '{}') returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_loc uuid; v_id uuid; v_c uuid; v_lot uuid; v_n bigint; v_num text; v jsonb; v_prev text;
begin
  select j.location_id into v_loc from core.jobs j where j.id = p_job and j.org_id = v_org;
  if v_loc is null then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'PM_INVALID: a VPO amount must be > 0' using errcode = '22023'; end if;
  select l.id into v_lot from pm.res_lots l where l.org_id = v_org and l.job_id = p_job;
  v_n := pm.next_doc_number(v_org, v_loc::text, 'VPO', to_char(current_date, 'YYYY'));
  v_num := 'VPO-' || to_char(current_date, 'YYYY') || '-' || lpad(v_n::text, 4, '0');
  insert into pm.commitments (org_id, location_id, job_id, vendor_id, commitment_type, title, description, retainage_pct, lot_id, vpo_reason, created_by)
  values (v_org, v_loc, p_job, p_vendor, 'PO', left(v_num || ': ' || p_description, 200), p_description, 0, v_lot, p_reason_code, pm.current_user_id())
  returning id into v_c;
  insert into pm.commitment_lines (org_id, commitment_id, line_no, cost_code_id, cost_type, description, qty, uom, amount_cents)
  values (v_org, v_c, 1, p_cost_code, 'SUBCONTRACTOR', left(p_description, 500), 1, 'LS', p_amount_cents);
  insert into pm.res_vpos (org_id, job_id, lot_id, number, vendor_id, reason_code, chargeback_vendor_id, description, cost_code_id, amount_cents,
                           submitted_by_trade, commitment_id, evidence_document_ids)
  values (v_org, p_job, v_lot, v_num, p_vendor, p_reason_code, p_chargeback_vendor, left(p_description, 1000), p_cost_code, p_amount_cents,
          coalesce(p_by_trade, false), v_c, coalesce(p_evidence, '{}'))
  returning id into v_id;
  v_prev := coalesce(current_setting('pm.access_entry', true), '');
  perform set_config('pm.access_entry', 'on', true);
  v := pm.approval_submit('commitment', v_c, null, 'web');
  perform set_config('pm.access_entry', v_prev, true);
  perform pm.log_activity(v_org, v_loc, p_job, 'vpo.created', 'res_vpos', v_id, format('%s (%s): %s cents', v_num, lower(replace(p_reason_code, '_', ' ')), p_amount_cents),
    jsonb_build_object('commitment_id', v_c, 'chargeback_vendor_id', p_chargeback_vendor));
  return jsonb_build_object('vpo_id', v_id, 'number', v_num, 'commitment_id', v_c, 'approval', v);
end $$;

-- Keep a VPO's status with its commitment (approved / void).
create or replace function pm.tg_res_vpo_follow_commitment() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  update pm.res_vpos set status = case when new.status in ('APPROVED','EXECUTED','CLOSED') then 'APPROVED' when new.status = 'VOID' then 'VOID' else status end
   where org_id = new.org_id and commitment_id = new.id and status = 'REQUESTED';
  return null;
end $$;
drop trigger if exists trg_res_vpo_follow_commitment on pm.commitments;
create trigger trg_res_vpo_follow_commitment after update of status on pm.commitments
  for each row when (new.status is distinct from old.status) execute function pm.tg_res_vpo_follow_commitment();

-- Inspections: a failed inspection blocks its task and opens the re-inspection; a pass completes it.
create or replace function pm.res_record_inspection(p_inspection uuid, p_result text, p_on date default null, p_inspector text default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare i pm.res_inspections%rowtype; v_re uuid; v_loc uuid;
begin
  select * into i from pm.res_inspections x where x.id = p_inspection and x.org_id = public.get_org_id() for update;
  if i.id is null then raise exception 'PM_FORBIDDEN: inspection % not found', p_inspection using errcode = '42501'; end if;
  if p_result not in ('PASS','FAIL','PARTIAL','CANCELLED') then raise exception 'PM_INVALID: result is pass, fail, partial or cancelled' using errcode = '22023'; end if;
  update pm.res_inspections set result = p_result, result_on = coalesce(p_on, current_date), inspector = coalesce(p_inspector, inspector),
         notes = coalesce(left(p_notes, 2000), notes) where id = i.id;
  if i.task_id is not null then
    if p_result in ('FAIL','PARTIAL') then
      update pm.tasks set status = 'BLOCKED' where id = i.task_id and status <> 'DONE';
      insert into pm.res_inspections (org_id, job_id, permit_id, kind, task_id, requested_on, reinspect_of)
      values (i.org_id, i.job_id, i.permit_id, i.kind, i.task_id, current_date, i.id) returning id into v_re;
    elsif p_result = 'PASS' then
      update pm.tasks set status = 'DONE', pct_complete = 1 where id = i.task_id and status <> 'DONE';
    end if;
  end if;
  select j.location_id into v_loc from core.jobs j where j.id = i.job_id;
  perform pm.log_activity(i.org_id, v_loc, i.job_id, 'inspection.' || lower(p_result), 'res_inspections', i.id,
    format('%s inspection: %s', initcap(replace(i.kind, '_', ' ')), lower(p_result)), jsonb_build_object('reinspection_id', v_re));
  return jsonb_build_object('inspection_id', i.id, 'result', p_result, 'reinspection_id', v_re);
end $$;

-- Closing (RES-111): derived items + manual items; close the lot when everything is done.
create or replace function pm.res_closing_status(p_closing uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare c pm.res_closings%rowtype; v_items jsonb;
begin
  select * into c from pm.res_closings x where x.id = p_closing and x.org_id = public.get_org_id();
  if c.id is null then raise exception 'PM_FORBIDDEN: closing % not found', p_closing using errcode = '42501'; end if;
  v_items := jsonb_build_array(
    jsonb_build_object('key', 'punch_closed', 'label', 'Walk punch list closed', 'auto', true,
      'done', not exists (select 1 from pm.punch_items p where p.org_id = c.org_id and p.job_id = c.job_id and p.kind = 'PUNCH' and p.status not in ('CLOSED','VOID'))),
    jsonb_build_object('key', 'final_inspection', 'label', 'Final inspection / certificate of occupancy', 'auto', true,
      'done', exists (select 1 from pm.res_inspections i where i.org_id = c.org_id and i.job_id = c.job_id and i.kind = 'FINAL' and i.result = 'PASS')),
    jsonb_build_object('key', 'orientation', 'label', 'Homebuyer orientation', 'auto', true,
      'done', exists (select 1 from pm.res_walks w where w.org_id = c.org_id and w.job_id = c.job_id and w.kind in ('ORIENTATION','FINAL_WALKTHROUGH') and w.status = 'DONE')),
    jsonb_build_object('key', 'settlement', 'label', 'Settlement statement entered', 'auto', true, 'done', c.settlement <> '{}'::jsonb))
    || coalesce((select jsonb_agg(x || jsonb_build_object('auto', false)) from jsonb_array_elements(c.checklist) x), '[]'::jsonb);
  return jsonb_build_object('closing_id', c.id, 'status', c.status, 'items', v_items,
                            'ready', not exists (select 1 from jsonb_array_elements(v_items) x where not coalesce((x ->> 'done')::boolean, false)));
end $$;

create or replace function pm.res_open_closing(p_job uuid, p_scheduled_on date default null, p_title_company text default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid; v_lot uuid;
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org) then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  select l.id into v_lot from pm.res_lots l where l.org_id = v_org and l.job_id = p_job;
  insert into pm.res_closings (org_id, job_id, lot_id, scheduled_on, title_company, checklist)
  values (v_org, p_job, v_lot, p_scheduled_on, p_title_company, jsonb_build_array(
    jsonb_build_object('key', 'title_clear', 'label', 'Title commitment clear', 'done', false),
    jsonb_build_object('key', 'lender_ctc', 'label', 'Lender clear to close', 'done', false),
    jsonb_build_object('key', 'final_walk_signed', 'label', 'Buyer signed the final walk', 'done', false)))
  on conflict (org_id, job_id) do update set scheduled_on = coalesce(excluded.scheduled_on, pm.res_closings.scheduled_on),
    title_company = coalesce(excluded.title_company, pm.res_closings.title_company)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm.res_close(p_closing uuid, p_closed_on date default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.res_closings%rowtype; st jsonb; v_walks int; v_loc uuid;
begin
  select * into c from pm.res_closings x where x.id = p_closing and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: closing % not found', p_closing using errcode = '42501'; end if;
  if c.status = 'CLOSED' then raise exception 'PM_RES_CLOSING_STATE: already closed' using errcode = '22023'; end if;
  st := pm.res_closing_status(c.id);
  if not (st ->> 'ready')::boolean then
    raise exception 'PM_RES_CLOSING_NOT_READY: %', (select string_agg(x ->> 'label', '; ') from jsonb_array_elements(st -> 'items') x where not coalesce((x ->> 'done')::boolean, false))
      using errcode = '22023';
  end if;
  update pm.res_closings set status = 'CLOSED', closed_on = coalesce(p_closed_on, current_date) where id = c.id;
  update pm.res_lots set status = 'CLOSED', closed_on = coalesce(p_closed_on, current_date), completed_on = coalesce(completed_on, current_date) where id = c.lot_id;
  v_walks := pm._res_schedule_warranty_walks(c.job_id, coalesce(p_closed_on, current_date));
  select j.location_id into v_loc from core.jobs j where j.id = c.job_id;
  perform pm.log_activity(c.org_id, v_loc, c.job_id, 'closing.closed', 'res_closings', c.id, 'Home closed — warranty walks scheduled',
    jsonb_build_object('settlement', c.settlement, 'warranty_walks', v_walks));
  return jsonb_build_object('closing_id', c.id, 'closed_on', coalesce(p_closed_on, current_date), 'warranty_walks', v_walks);
end $$;

-- Starts board + spec inventory (invoker: the caller's job / lot rows).
create or replace view pm.v_res_starts_board with (security_invoker = on) as
select l.id as lot_id, l.org_id, l.location_id, l.community_id, c.name as community, l.phase_id, l.lot_number, l.block, l.status, l.is_spec, l.plan_id,
       pl.code as plan_code, pl.name as plan_name, pl.standard_cycle_days, l.job_id, l.started_on, l.completed_on,
       case when l.started_on is not null then coalesce(l.completed_on, current_date) - l.started_on end as cycle_days,
       (select t.title from pm.tasks t where t.job_id = l.job_id and t.is_summary and t.status <> 'DONE' and t.status <> 'CANCELLED' order by t.sort limit 1) as current_stage,
       (select round(avg(coalesce(t.pct_complete, case when t.status = 'DONE' then 1 else 0 end)), 4) from pm.tasks t where t.job_id = l.job_id and not t.is_summary and t.status <> 'CANCELLED') as pct_complete,
       pr.super_user_id,
       (l.started_on is not null and l.completed_on is null and pl.standard_cycle_days is not null
        and (current_date - l.started_on) > pl.standard_cycle_days
              * coalesce((select avg(coalesce(t.pct_complete, case when t.status = 'DONE' then 1 else 0 end)) from pm.tasks t where t.job_id = l.job_id and not t.is_summary and t.status <> 'CANCELLED'), 0)
              + 5) as behind_standard
  from pm.res_lots l
  join pm.res_communities c on c.id = l.community_id
  left join pm.res_plans pl on pl.id = l.plan_id
  left join pm.projects pr on pr.job_id = l.job_id;
comment on view pm.v_res_starts_board is '1119 (RES-55): lots by stage with cycle days vs the plan standard and the superintendent. Invoker.';

create or replace view pm.v_res_spec_inventory with (security_invoker = on) as
select l.id as lot_id, l.org_id, l.location_id, l.community_id, l.lot_number, l.block, l.status, l.plan_id, l.job_id, l.list_price_cents, l.incentives_cents,
       l.listed_on, case when l.listed_on is not null then current_date - l.listed_on end as days_on_market,
       (l.listed_on is not null and current_date - l.listed_on > 60) as aging
  from pm.res_lots l where l.is_spec and l.status not in ('CLOSED','SOLD');
comment on view pm.v_res_spec_inventory is '1119 (RES-108): spec homes with days on market; aging after 60 days. Invoker.';

-- Builder KPIs (RES-112): cycle time by plan / superintendent; VPO dollars by reason as % of direct cost.
create or replace function pm.res_builder_kpis(p_location uuid) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare v_fin boolean;
begin
  if not exists (select 1 from core.locations l where l.id = p_location and l.org_id = public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: company % not found', p_location using errcode = '42501';
  end if;
  v_fin := pm.access_is_service() or pm.can('projects.financials', 'view', p_location);
  return jsonb_build_object(
    'cycle_by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan_id', x.plan_id, 'plan', x.code, 'homes', x.n, 'avg_cycle_days', x.avg_days, 'standard', x.std))
      from (select l.plan_id, pl.code, count(*) as n, round(avg(coalesce(l.completed_on, current_date) - l.started_on), 1) as avg_days, max(pl.standard_cycle_days) as std
              from pm.res_lots l join pm.res_plans pl on pl.id = l.plan_id
             where l.location_id = p_location and l.started_on is not null and l.job_id in (select pm.my_job_ids()) group by l.plan_id, pl.code) x), '[]'::jsonb),
    'cycle_by_superintendent', coalesce((select jsonb_agg(jsonb_build_object('super_user_id', x.su, 'homes', x.n, 'avg_cycle_days', x.avg_days))
      from (select pr.super_user_id as su, count(*) as n, round(avg(coalesce(l.completed_on, current_date) - l.started_on), 1) as avg_days
              from pm.res_lots l join pm.projects pr on pr.job_id = l.job_id
             where l.location_id = p_location and l.started_on is not null and l.job_id in (select pm.my_job_ids()) group by pr.super_user_id) x), '[]'::jsonb),
    'vpo_by_reason', case when v_fin then coalesce((select jsonb_agg(jsonb_build_object('reason_code', x.reason_code, 'count', x.n, 'amount_cents', x.amt,
                                                     'pct_of_direct_cost', case when x.direct > 0 then round(x.amt::numeric / x.direct, 4) end))
      from (select v.reason_code, count(*) as n, sum(v.amount_cents)::bigint as amt,
                   (select coalesce(sum(cl.amount_cents), 0) from pm.commitments cm join pm.commitment_lines cl on cl.commitment_id = cm.id
                     where cm.location_id = p_location and cm.lot_id is not null and cm.vpo_reason is null and cm.status in ('APPROVED','EXECUTED','CLOSED')) as direct
              from pm.res_vpos v join core.jobs j on j.id = v.job_id
             where j.location_id = p_location and v.status = 'APPROVED' group by v.reason_code) x), '[]'::jsonb) end);
end $$;

-- ----------------------------------------------------------------------------
-- 9. Remodeler + closeout records
-- ----------------------------------------------------------------------------
-- RRP: a pre-1978 home needs a lead-safe record; kept 3 years after completion.
create or replace function pm.tg_res_home_profile_rrp() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.rrp_required then
    insert into pm.res_rrp_records (org_id, job_id, required) values (new.org_id, new.job_id, true)
    on conflict (org_id, job_id) do update set required = true, status = case when pm.res_rrp_records.status = 'NOT_REQUIRED' then 'OPEN' else pm.res_rrp_records.status end;
  end if;
  return null;
end $$;
drop trigger if exists trg_res_home_profile_rrp on pm.res_home_profiles;
create trigger trg_res_home_profile_rrp after insert or update of year_built on pm.res_home_profiles
  for each row execute function pm.tg_res_home_profile_rrp();

create or replace function pm.tg_res_rrp_status() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if not new.required then new.status := 'NOT_REQUIRED';
  elsif coalesce(new.renovator_name, new.renovator_employee_id::text) is not null and new.renovator_cert_number is not null
        and new.pamphlet_ack_at is not null and new.containment_verified_at is not null and new.cleaning_verified_at is not null
        and new.cleaning_card_result in ('PASS','RECLEAN_PASS') then
    new.status := 'COMPLETE';
    new.retain_until := coalesce(new.retain_until, (new.cleaning_verified_at::date + interval '3 years')::date);
  else new.status := 'OPEN';
  end if;
  if new.renovator_cert_expires_on is not null and new.renovator_cert_expires_on < current_date and new.status = 'COMPLETE' and tg_op = 'INSERT' then
    raise exception 'PM_RES_RRP_CERT_EXPIRED: the renovator''s RRP certificate has expired' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_res_rrp_status on pm.res_rrp_records;
create trigger trg_res_rrp_status before insert or update on pm.res_rrp_records
  for each row execute function pm.tg_res_rrp_status();

-- Dust / protection checks (RES-116): template items per kind; pass = every item done + a photo.
create or replace function pm.res_start_protection_check(p_job uuid, p_kind text, p_date date default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid; v_items jsonb;
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org) then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  v_items := case p_kind
    when 'DAY1_CONTAINMENT' then '[{"key":"zipwall","label":"Zip walls / plastic containment up","done":false},{"key":"floor","label":"Floor protection to the work area","done":false},
                                  {"key":"hvac","label":"HVAC returns and registers covered","done":false},{"key":"negative_air","label":"Negative air running (if dusty demo)","done":false},
                                  {"key":"path","label":"Protected path from the door","done":false},{"key":"valuables","label":"Homeowner moved valuables / fragile items","done":false}]'::jsonb
    when 'DAILY_CLEANUP' then '[{"key":"sweep","label":"Swept and vacuumed (HEPA)","done":false},{"key":"debris","label":"Debris out to the dumpster","done":false},
                                {"key":"tools","label":"Tools stowed, cords off walkways","done":false},{"key":"containment","label":"Containment intact","done":false},
                                {"key":"water","label":"Water / power restored where shut off","done":false}]'::jsonb
    when 'PROTECTION_REMOVAL' then '[{"key":"plastic","label":"Containment removed","done":false},{"key":"floor","label":"Floor protection removed, floors cleaned","done":false},
                                     {"key":"hvac","label":"HVAC covers removed, filter changed","done":false},{"key":"walkthrough","label":"Walked the path with the homeowner","done":false}]'::jsonb
    else null end;
  if v_items is null then raise exception 'PM_INVALID: unknown check' using errcode = '22023'; end if;
  insert into pm.res_protection_checks (org_id, job_id, kind, check_date, items)
  values (v_org, p_job, p_kind, coalesce(p_date, current_date), v_items)
  on conflict (org_id, job_id, kind, check_date) do update set items = pm.res_protection_checks.items
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm.res_complete_protection_check(p_check uuid, p_done_keys text[], p_photos uuid[] default '{}', p_note text default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare c pm.res_protection_checks%rowtype; v_items jsonb; v_all boolean; v_status text;
begin
  select * into c from pm.res_protection_checks x where x.id = p_check and x.org_id = public.get_org_id() for update;
  if c.id is null then raise exception 'PM_FORBIDDEN: check % not found', p_check using errcode = '42501'; end if;
  select jsonb_agg(x || jsonb_build_object('done', (x ->> 'key') = any (coalesce(p_done_keys, '{}')))) into v_items from jsonb_array_elements(c.items) x;
  v_all := not exists (select 1 from jsonb_array_elements(v_items) x where not (x ->> 'done')::boolean);
  v_status := case when v_all and cardinality(coalesce(p_photos, '{}')) + cardinality(c.photo_document_ids) > 0 then 'PASSED' else 'FAILED' end;
  update pm.res_protection_checks set items = v_items, photo_document_ids = photo_document_ids || coalesce(p_photos, '{}'), status = v_status,
         completed_by = pm.current_user_id(), completed_at = now(), note = coalesce(left(p_note, 2000), note) where id = c.id;
  return jsonb_build_object('check_id', c.id, 'status', v_status,
    'missing', (select coalesce(jsonb_agg(x ->> 'label'), '[]'::jsonb) from jsonb_array_elements(v_items) x where not (x ->> 'done')::boolean),
    'photo_required', cardinality(coalesce(p_photos, '{}')) + cardinality(c.photo_document_ids) = 0);
end $$;

-- Cabinet → template → fabrication → counter → backsplash chain (RES-120).
create or replace function pm.res_create_chain(p_job uuid, p_kind text default 'CABINET_COUNTER') returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid; s record; v_task uuid; v_prev date; v_plan date; v_cab_lead int;
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org) then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  if p_kind <> 'CABINET_COUNTER' then raise exception 'PM_INVALID: only the cabinet / countertop chain is templated' using errcode = '22023'; end if;
  insert into pm.res_chains (org_id, job_id, kind, name) values (v_org, p_job, p_kind, 'Cabinets and countertops') returning id into v_id;
  select max(o.lead_time_days) into v_cab_lead from pm.selections sel join pm.selection_options o on o.selection_id = sel.id
   where sel.org_id = v_org and sel.job_id = p_job and sel.category ~* 'cabinet' and (sel.chosen_option_id is null or o.id = sel.chosen_option_id);
  for s in select * from (values
      (1, 'cabinet_order', 'Cabinets ordered', 0, array['order_cabinets'], 'Cabinets ordered'),
      (2, 'cabinet_delivery', 'Cabinets delivered', coalesce(v_cab_lead, 35), array['cabinet_lead'], 'Cabinets arrive'),
      (3, 'cabinet_install', 'Cabinets installed', 2, array['cabinets'], 'Cabinets installed'),
      (4, 'counter_template', 'Countertop template', 1, array['template_tops'], 'Countertop measuring visit'),
      (5, 'counter_fabrication', 'Countertop fabrication', 7, array['fab_tops'], 'Countertops being made'),
      (6, 'counter_install', 'Countertops installed', 1, array['install_tops'], 'Countertops installed'),
      (7, 'backsplash', 'Backsplash installed', 2, array['backsplash'], 'Backsplash installed')) v(seq, k, lbl, lead, refs, hl) loop
    select t.id, coalesce(t.early_start, t.start_on) into v_task, v_plan from pm.tasks t
     where t.org_id = v_org and t.job_id = p_job and exists (select 1 from unnest(s.refs) r where t.template_ref like '%:' || r) limit 1;
    v_plan := coalesce(v_plan, case when v_prev is not null then v_prev + s.lead else current_date end);
    insert into pm.res_chain_steps (org_id, chain_id, seq, step_key, label, task_id, lead_days, planned_on, homeowner_label)
    values (v_org, v_id, s.seq, s.k, s.lbl, v_task, s.lead, v_plan, s.hl);
    v_prev := v_plan; v_task := null; v_plan := null;
  end loop;
  return v_id;
end $$;

-- Record a step's actual date; later unfinished steps re-plan from it (counter install = template +
-- fabrication lead + install).
create or replace function pm.res_advance_chain_step(p_step uuid, p_actual_on date default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare st pm.res_chain_steps%rowtype; r record; v_prev date;
begin
  select * into st from pm.res_chain_steps x where x.id = p_step and x.org_id = public.get_org_id() for update;
  if st.id is null then raise exception 'PM_FORBIDDEN: step % not found', p_step using errcode = '42501'; end if;
  update pm.res_chain_steps set actual_on = coalesce(p_actual_on, current_date), status = 'DONE' where id = st.id;
  v_prev := coalesce(p_actual_on, current_date);
  for r in select * from pm.res_chain_steps x where x.chain_id = st.chain_id and x.seq > st.seq order by x.seq loop
    exit when r.status = 'DONE';
    v_prev := v_prev + r.lead_days;
    update pm.res_chain_steps set planned_on = v_prev, status = 'SCHEDULED' where id = r.id;
  end loop;
  if not exists (select 1 from pm.res_chain_steps x where x.chain_id = st.chain_id and x.status not in ('DONE','SKIPPED')) then
    update pm.res_chains set status = 'DONE' where id = st.chain_id;
  end if;
  return jsonb_build_object('chain_id', st.chain_id,
    'steps', (select jsonb_agg(jsonb_build_object('step_key', x.step_key, 'label', x.label, 'planned_on', x.planned_on, 'actual_on', x.actual_on, 'status', x.status) order by x.seq)
                from pm.res_chain_steps x where x.chain_id = st.chain_id));
end $$;

-- Walks: final walkthrough / orientation / warranty walks (RES-96/99).
create or replace function pm._res_schedule_warranty_walks(p_job uuid, p_from date) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid; v_loc uuid; v_days int[]; n int := 0; d int; i int := 0; v_kind text;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  select s.warranty_walk_days into v_days from pm.res_settings s where s.org_id = v_org and s.location_id = v_loc;
  v_days := coalesce(v_days, '{30,330,730}');
  foreach d in array v_days loop
    i := i + 1;
    v_kind := case i when 1 then 'WARRANTY_30' when 2 then 'WARRANTY_11M' when 3 then 'WARRANTY_2Y' else null end;
    continue when v_kind is null;
    insert into pm.res_walks (org_id, job_id, kind, due_on) values (v_org, p_job, v_kind, p_from + d)
    on conflict (org_id, job_id, kind) where kind <> 'CUSTOM' do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function pm.res_schedule_warranty_walks(p_job uuid, p_from date default null) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = public.get_org_id()) then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  return pm._res_schedule_warranty_walks(p_job, coalesce(p_from, current_date));
end $$;

create or replace function pm.res_plan_walk(p_job uuid, p_kind text, p_due_on date default null, p_scheduled_at timestamptz default null) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid := public.get_org_id(); v_id uuid;
begin
  if not exists (select 1 from core.jobs j where j.id = p_job and j.org_id = v_org) then raise exception 'PM_FORBIDDEN: job % not found', p_job using errcode = '42501'; end if;
  if p_kind not in ('FINAL_WALKTHROUGH','ORIENTATION','CUSTOM') then raise exception 'PM_INVALID: plan a final walkthrough, orientation or custom walk' using errcode = '22023'; end if;
  insert into pm.res_walks (org_id, job_id, kind, due_on, scheduled_at, status)
  values (v_org, p_job, p_kind, coalesce(p_due_on, p_scheduled_at::date, current_date), p_scheduled_at, case when p_scheduled_at is not null then 'SCHEDULED' else 'PLANNED' end)
  on conflict (org_id, job_id, kind) where kind <> 'CUSTOM' do update set due_on = excluded.due_on, scheduled_at = excluded.scheduled_at, status = excluded.status
  returning id into v_id;
  return v_id;
end $$;

-- Complete a walk: items become punch (or warranty) items; the homeowner signs acceptance.
create or replace function pm.res_complete_walk(p_walk uuid, p_items jsonb default '[]', p_accepted_by text default null,
                                                p_signature_document uuid default null) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare w pm.res_walks%rowtype; x jsonb; n int := 0; v_kind text; v_loc uuid;
begin
  select * into w from pm.res_walks y where y.id = p_walk and y.org_id = public.get_org_id() for update;
  if w.id is null then raise exception 'PM_FORBIDDEN: walk % not found', p_walk using errcode = '42501'; end if;
  if w.status = 'DONE' then raise exception 'PM_RES_WALK_DONE: this walk is complete' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then
    raise exception 'PM_INVALID: items are a list (at most 200)' using errcode = '22023';
  end if;
  v_kind := case when w.kind like 'WARRANTY%' then 'WARRANTY' else 'PUNCH' end;
  for x in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(btrim(x ->> 'title'), '') = '';
    insert into pm.punch_items (org_id, job_id, kind, title, description, area, responsible_vendor_id, due_on, ext)
    values (w.org_id, w.job_id, v_kind, left(btrim(x ->> 'title'), 200), left(x ->> 'description', 2000), left(x ->> 'location', 120),
            pm.access_try_uuid(x ->> 'trade_vendor_id'), current_date + coalesce((x ->> 'due_days')::int, 14), jsonb_build_object('walk_id', w.id));
    n := n + 1;
  end loop;
  update pm.res_walks set status = 'DONE', completed_at = now(), items = coalesce(p_items, '[]'::jsonb), punch_created = n,
         accepted_by_name = coalesce(btrim(p_accepted_by), accepted_by_name), accepted_at = case when p_accepted_by is not null then now() else accepted_at end,
         signature_document_id = coalesce(p_signature_document, signature_document_id)
   where id = w.id;
  select j.location_id into v_loc from core.jobs j where j.id = w.job_id;
  perform pm.log_activity(w.org_id, v_loc, w.job_id, 'walk.completed', 'res_walks', w.id,
    format('%s complete: %s item(s)%s', initcap(replace(w.kind, '_', ' ')), n, case when p_accepted_by is not null then ', accepted by ' || btrim(p_accepted_by) else '' end),
    jsonb_build_object('punch_created', n));
  return jsonb_build_object('walk_id', w.id, 'punch_created', n, 'accepted', p_accepted_by is not null);
end $$;

-- ----------------------------------------------------------------------------
-- 10. State rules catalog (starting values — the lead / counsel confirm per state before go-live)
-- ----------------------------------------------------------------------------
insert into pm.res_state_rules as r (state_code, name, cancel_days, notice_text, deposit_cap_pct, deposit_cap_cents, labor_taxable, design_fee_taxable) values
  ('IA', 'Iowa', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the date of this contract (Iowa Code ch. 555A / FTC Cooling-Off Rule). To cancel, deliver a signed and dated copy of this notice, or any other written notice, to the contractor before midnight of the third business day.', null, null, false, false),
  ('IL', 'Illinois', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without penalty or obligation, within three business days from the above date (815 ILCS 513 Home Repair and Remodeling Act; FTC Cooling-Off Rule).', null, null, false, false),
  ('MN', 'Minnesota', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Minn. Stat. 325G.06–.11).', null, null, false, false),
  ('MO', 'Missouri', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Mo. Rev. Stat. 407.700 et seq.).', null, null, false, false),
  ('NE', 'Nebraska', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Neb. Rev. Stat. 69-1601 et seq.).', null, null, false, false),
  ('WI', 'Wisconsin', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Wis. Admin. Code ATCP 110).', null, null, false, false),
  ('SD', 'South Dakota', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (SDCL 37-24-5.1; FTC Cooling-Off Rule).', null, null, true, true),
  ('CA', 'California', 3, 'You, the buyer, may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction (Cal. Bus. & Prof. Code 7159; Civ. Code 1689.5–.7). Read the attached notice of cancellation form for an explanation of this right.', 0.10, 100000, false, false),
  ('TX', 'Texas', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Tex. Bus. & Com. Code ch. 601).', null, null, false, false),
  ('FL', 'Florida', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (Fla. Stat. 501.021–.055).', null, null, false, false),
  ('NY', 'New York', 3, 'You may cancel this contract at any time prior to midnight of the third business day after receiving a copy of this contract (N.Y. Gen. Bus. Law 771 home improvement contracts).', null, null, false, false),
  ('CO', 'Colorado', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (FTC Cooling-Off Rule, 16 CFR 429).', null, null, false, false),
  ('AZ', 'Arizona', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (A.R.S. 44-5001 et seq.).', null, null, false, false),
  ('NM', 'New Mexico', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (FTC Cooling-Off Rule, 16 CFR 429).', null, null, true, true),
  ('HI', 'Hawaii', 3, 'NOTICE OF CANCELLATION: You may cancel this transaction, without any penalty or obligation, within three business days from the above date (HRS 481C).', null, null, true, true)
on conflict (state_code) do update set name = excluded.name, cancel_days = excluded.cancel_days, notice_text = excluded.notice_text,
  deposit_cap_pct = excluded.deposit_cap_pct, deposit_cap_cents = excluded.deposit_cap_cents, labor_taxable = excluded.labor_taxable,
  design_fee_taxable = excluded.design_fee_taxable, updated_at = now();

-- ----------------------------------------------------------------------------
-- 11. 1110 registries: classes, masked columns, RPC guards
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('res_settings',            'S','location', '{}', 'projects.settings',  null, null, null, null, false, '1119 (RES-01): residential setup per company'),
  ('res_state_rules',         'O','org',      '{}', null,                 null, null, null, null, false, '1119: state cancellation / deposit / tax catalog (no org_id; service_role writes)'),
  ('res_rate_counters',       'O','org',      '{}', null,                 null, null, null, null, false, '1119: trade-link rate-limit counters (no org_id, no member grants; definer functions only)'),
  ('res_catalog_items',       'S','location', '{}', 'projects.estimates', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.settings'', ''configure''))', false, '1119 (RES-17): cost catalog; cost / markup masked'),
  ('res_assemblies',          'S','location', '{}', 'projects.estimates', null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.settings'', ''configure''))', false, '1119 (RES-17): assemblies'),
  ('res_assembly_items',      'S','parent',   '{}', 'projects.estimates', 'res_assemblies', 'assembly_id', null, null, false, '1119: assembly components'),
  ('res_proposals',           'C','location', '{projects.estimates}', 'projects.estimates', null, null,
     '%1$sjob_id in (select pm.my_job_ids_with(''projects.estimates'', ''view''))', null, false, '1119 (RES-19/26): proposals; status / totals move through RPCs; cost masked'),
  ('res_proposal_options',    'C','parent',   '{}', 'projects.estimates', 'res_proposals', 'proposal_id', null, null, false, '1119: proposal options (draft only for members)'),
  ('res_proposal_lines',      'C','parent',   '{}', 'projects.estimates', 'res_proposals', 'proposal_id', null, null, false, '1119: proposal lines (draft only for members); cost masked'),
  ('res_proposal_snapshots',  'C','parent',   '{}', null,                 'res_proposals', 'proposal_id', null, null, false, '1119: sent versions (definer-written)'),
  ('res_payment_schedule',    'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1119 (RES-77): payment schedule; written by RPCs'),
  ('res_job_terms',           'M','job',      '{projects.contract_value}', null, null, null, null, null, false, '1119 (RES-27/85): contract form on the job'),
  ('res_change_order_lines',  'M','parent',   '{}', null,                 'change_orders', 'change_order_id', null, null, false, '1119: change-order lines (priced by RPC); cost masked'),
  ('res_task_trades',         'J','job',      '{projects.jobs}', null,    null, null, null, null, false, '1119 (RES-48): trade schedule confirmations (token hash; RPC / public link write)'),
  ('res_bid_packages',        'M','job',      '{projects.financials}', 'projects.commitments', null, null, null, null, false, '1119 (RES-30): bid packages'),
  ('res_bid_package_lines',   'M','parent',   '{}', 'projects.commitments', 'res_bid_packages', 'package_id', null, null, false, '1119: bid package lines'),
  ('res_bid_invites',         'M','job',      '{projects.financials}', null, null, null, null, null, false, '1119: bid invitations (token hash)'),
  ('res_bid_prices',          'M','parent',   '{}', null,                 'res_bid_invites', 'invite_id', null, null, false, '1119: bid line prices (public portal writes)'),
  ('res_vendor_deposits',     'M','job',      '{projects.financials}', null, null, null, null, null, false, '1119 (RES-58): vendor deposits on special orders'),
  ('res_trade_invoices',      'M','job',      '{projects.financials}', null, null, null, null, null, false, '1119 (RES-59): trade invoices matched to POs'),
  ('res_trade_invoice_lines', 'M','parent',   '{}', null,                 'res_trade_invoices', 'invoice_id', null, null, false, '1119: trade invoice lines'),
  ('res_communities',         'S','location', '{}', 'projects.settings',  null, null, null, null, false, '1119 (RES-103): communities'),
  ('res_community_phases',    'S','parent',   '{}', 'projects.settings',  'res_communities', 'community_id', null, null, false, '1119: community phases'),
  ('res_plans',               'S','location', '{}', 'projects.settings',  null, null, null, null, false, '1119 (RES-104): plans; cost / margin masked'),
  ('res_elevations',          'S','parent',   '{}', 'projects.settings',  'res_plans', 'plan_id', null, null, false, '1119: elevations'),
  ('res_plan_prices',         'S','parent',   '{}', 'projects.settings',  'res_plans', 'plan_id', null, null, false, '1119: base price per plan × community, effective-dated'),
  ('res_options',             'S','location', '{}', 'projects.settings',  null, null, null, null, false, '1119 (RES-104): option catalog; cost masked'),
  ('res_option_prices',       'S','parent',   '{}', 'projects.settings',  'res_options', 'option_id', null, null, false, '1119: option prices, effective-dated'),
  ('res_lots',                'S','location', '{}', 'projects.settings',  null, null, null,
     '%1$slocation_id in (select pm.my_location_ids(''projects.jobs'', ''edit''))', false, '1119 (RES-103): lots; land cost masked'),
  ('res_price_agreements',    'C','location', '{projects.commitments,projects.financials}', 'projects.commitments', null, null, null, null, false, '1119 (RES-64): trade price agreements'),
  ('res_purchase_agreements', 'C','location', '{projects.estimates,projects.leads}', null, null, null,
     '%1$sjob_id in (select pm.my_money_job_ids(''projects.contract_value''))', null, false, '1119 (RES-105): buyer purchase agreements (RPC-written)'),
  ('res_pa_options',          'C','parent',   '{}', null,                 'res_purchase_agreements', 'agreement_id', null, null, false, '1119: options on a purchase agreement'),
  ('res_pa_addenda',          'C','parent',   '{}', null,                 'res_purchase_agreements', 'agreement_id', null, null, false, '1119 (RES-106): addenda'),
  ('res_start_package_items', 'M','job',      '{projects.financials}', null, null, null, null, null, false, '1119 (RES-65/107): start package'),
  ('res_vpos',                'M','job',      '{projects.financials}', null, null, null, null, null, false, '1119 (RES-66): variance POs with reason codes'),
  ('res_closings',            'M','job',      '{projects.contract_value}', 'projects.jobs', null, null, null, null, false, '1119 (RES-111): closing checklist + settlement'),
  ('res_home_profiles',       'J','job',      '{projects.jobs}', 'projects.jobs', null, null, null, null, false, '1119 (RES-115): occupied-home profile (field app)'),
  ('res_household_members',   'J','job',      '{projects.jobs}', 'projects.customers', null, null, null, null, false, '1119 (RES-87): household + portal invite hook'),
  ('res_protection_checks',   'J','job',      '{projects.jobs}', null,    null, null, null, null, false, '1119 (RES-116): dust / protection checks (RPC)'),
  ('res_rrp_records',         'J','job',      '{projects.jobs}', 'projects.jobs', null, null, null, null, false, '1119 (RES-117): EPA RRP lead-safe records'),
  ('res_permits',             'J','job',      '{projects.jobs}', 'projects.jobs', null, null, null, null, false, '1119 (RES-110/119): permits, HOA, dumpsters; fee masked'),
  ('res_inspections',         'J','job',      '{projects.jobs}', 'projects.jobs', null, null, null, null, false, '1119 (RES-110): inspections (result through RPC)'),
  ('res_chains',              'J','job',      '{projects.jobs}', null,    null, null, null, null, false, '1119 (RES-120): cabinet / counter chain'),
  ('res_chain_steps',         'J','parent',   '{}', null,                 'res_chains', 'chain_id', null, null, false, '1119: chain steps (RPC)'),
  ('res_walks',               'J','job',      '{projects.jobs}', null,    null, null, null, null, false, '1119 (RES-96/99): walkthroughs, orientation, warranty walks')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_masked_columns as m (schema_name, table_name, column_name, visible_when, masked_expr, note)
select 'pm', x.* from (values
  ('res_catalog_items',  'unit_cost_cents', '(t.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')) or t.location_id in (select pm.my_location_ids(''projects.estimates'', ''create'')))', null::text, '1119: catalog cost (estimators price with it)'),
  ('res_catalog_items',  'markup_pct',      '(t.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')) or t.location_id in (select pm.my_location_ids(''projects.estimates'', ''create'')))', null, '1119'),
  ('res_catalog_items',  'margin_pct',      '(t.location_id in (select pm.my_location_ids(''projects.financials'', ''view'')) or t.location_id in (select pm.my_location_ids(''projects.estimates'', ''create'')))', null, '1119'),
  ('res_proposals',      'cost_cents',      '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.created_by = (select pm.current_user_id()))', null, '1119: budget cost; also the author'),
  ('res_proposals',      'overhead_cents',  '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.created_by = (select pm.current_user_id()))', null, '1119'),
  ('res_proposals',      'use_tax_cents',   '(t.job_id in (select pm.my_money_job_ids(''projects.financials'')) or t.created_by = (select pm.current_user_id()))', null, '1119'),
  ('res_proposal_lines', 'unit_cost_cents', 't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1119'),
  ('res_proposal_lines', 'cost_cents',      't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1119'),
  ('res_proposal_lines', 'overhead_cents',  't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1119'),
  ('res_proposal_lines', 'markup_pct',      't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1119'),
  ('res_proposal_lines', 'margin_pct',      't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))', null, '1119'),
  ('res_proposal_lines', 'ext',             't.proposal_id in (select x.id from pm.res_proposals x where x.org_id = public.get_org_id() and (x.job_id in (select pm.my_money_job_ids(''projects.financials'')) or x.created_by = (select pm.current_user_id())))',
                                            't.ext - ''cost_rate_cents'' - ''estimating_rate_cents''', '1119: labor cost rates stripped'),
  ('res_change_order_lines','unit_cost_cents','t.change_order_id in (select x.id from pm.change_orders x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.financials'')))', null, '1119'),
  ('res_change_order_lines','cost_cents',   't.change_order_id in (select x.id from pm.change_orders x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.financials'')))', null, '1119'),
  ('res_change_order_lines','markup_pct',   't.change_order_id in (select x.id from pm.change_orders x where x.org_id = public.get_org_id() and x.job_id in (select pm.my_money_job_ids(''projects.financials'')))', null, '1119'),
  ('res_plans',          'base_cost_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1119'),
  ('res_plans',          'target_margin_pct','t.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1119'),
  ('res_options',        'cost_cents',      't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1119'),
  ('res_lots',           'land_cost_cents', 't.location_id in (select pm.my_location_ids(''projects.financials'', ''view''))', null, '1119'),
  ('res_permits',        'fee_cents',       't.job_id in (select pm.my_money_job_ids(''projects.financials''))', null, '1119')
) as x(table_name, column_name, visible_when, masked_expr, note)
on conflict (schema_name, table_name, column_name) do update set visible_when = excluded.visible_when, masked_expr = excluded.masked_expr, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('res_create_proposal',      '{p_location,p_lead,p_job}', 'if not pm.access_can_location(''projects.estimates'', ''create'', coalesce((select gj.location_id from core.jobs gj where gj.id = p_job and gj.org_id = public.get_org_id()), (select gld.location_id from crm.leads gld where gld.id = p_lead and gld.org_id = public.get_org_id()), p_location)) then perform pm.access_forbid(''requires projects.estimates:create at this company''); end if;', '1119'),
  ('res_set_payment_schedule', '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_add_catalog_lines',    '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_select_options',       '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_send_proposal',        '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119: margin floor through Approvals'),
  ('res_revise_proposal',      '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_decline_proposal',     '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_accept_proposal',      '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119: builds the job (budget, schedule, selections, deposit)'),
  ('res_link_proposal_envelope','{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_mark_proposal_viewed', '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''view''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_tax_preview',          '{p_proposal}', 'perform pm.access_assert_location(''projects.estimates'', array[''view''], (select gp.location_id from pm.res_proposals gp where gp.id = p_proposal and gp.org_id = public.get_org_id()));', '1119'),
  ('res_refresh_selection_deadlines','{p_job}', 'perform pm.access_assert_job(''projects.selections'', array[''view''], p_job);', '1119'),
  ('res_selection_preview',    '{p_selection}', 'if not (pm.access_can_row(''projects.selections'', ''view'', ''selections'', p_selection) or pm.access_can_row(''projects.jobs'', ''view'', ''selections'', p_selection)) then perform pm.access_forbid(''requires the selection''''s job''); end if;', '1119: money nulled without contract_value'),
  ('res_choose_selection',     '{p_selection}', 'perform pm.access_assert_row(''projects.selections'', array[''approve''], ''selections'', p_selection);', '1119: CO through Approvals; PO only with commitments:create'),
  ('res_send_selection_reminders','{p_job}',   'perform pm.access_assert_job(''projects.selections'', array[''edit''], p_job);', '1119'),
  ('res_reconcile_allowance',  '{p_allowance}', 'perform pm.access_assert_row(''projects.selections'', array[''approve''], ''allowances'', p_allowance);', '1119'),
  ('res_request_field_co',     '{p_job}', 'if not (pm.access_can_job(''projects.change_orders'', ''create'', p_job) or pm.access_can_job(''projects.documents'', ''create'', p_job)) then perform pm.access_forbid(''requires projects.change_orders:create or projects.documents:create on this job''); end if;', '1119: field roles, no price'),
  ('res_price_change_order',   '{p_co}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''change_orders'', p_co); perform pm.access_assert_row(''projects.contract_value'', array[''view''], ''change_orders'', p_co);', '1119: pricing needs the sell side'),
  ('res_record_co_signature',  '{p_co}', 'perform pm.access_assert_row(''projects.change_orders'', array[''edit''], ''change_orders'', p_co);', '1119: approval through the engine'),
  ('res_create_internal_co',   '{p_job}', 'perform pm.access_assert_job(''projects.change_orders'', array[''create''], p_job); perform pm.access_assert_job(''projects.financials'', array[''view''], p_job);', '1119'),
  ('res_propose_trade_cos',    '{p_co}', 'perform pm.access_assert_row(''projects.commitments'', array[''create''], ''change_orders'', p_co);', '1119'),
  ('res_co_exposure_summary',  '{p_location}', 'perform pm.access_assert_location(''projects.change_orders'', array[''view''], p_location);', '1119: value masked inside'),
  ('res_assign_trade',         '{p_task}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''tasks'', p_task) or pm.access_can_row(''projects.dispatch'', ''edit'', ''tasks'', p_task)) then perform pm.access_forbid(''requires projects.jobs:edit on this job''); end if;', '1119'),
  ('res_invite_bidder',        '{p_package}', 'perform pm.access_assert_row(''projects.commitments'', array[''create''], ''res_bid_packages'', p_package);', '1119'),
  ('res_bid_leveling',         '{p_package}', 'perform pm.access_assert_row(''projects.commitments'', array[''view''], ''res_bid_packages'', p_package); perform pm.access_assert_row(''projects.financials'', array[''view''], ''res_bid_packages'', p_package);', '1119'),
  ('res_award_bid',            '{p_invite}', 'perform pm.access_assert_row(''projects.commitments'', array[''create''], ''res_bid_invites'', p_invite);', '1119: DRAFT subcontract; approval through the engine'),
  ('res_send_po_to_trade',     '{p_commitment}', 'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', '1119'),
  ('res_request_vendor_deposit','{p_commitment}', 'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', '1119'),
  ('res_advance_vendor_deposit','{p_deposit,p_to}', 'perform pm.access_assert_row(''projects.commitments'', case when p_to in (''APPROVED'',''VOID'') then array[''approve''] else array[''edit''] end, ''res_vendor_deposits'', p_deposit);', '1119'),
  ('res_compliance_gate',      '{p_commitment}', 'perform pm.access_assert_row(''projects.commitments'', array[''view''], ''commitments'', p_commitment);', '1119'),
  ('res_submit_trade_invoice', '{p_commitment}', 'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''commitments'', p_commitment);', '1119'),
  ('res_approve_trade_invoice','{p_invoice}', 'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''res_trade_invoices'', p_invoice);', '1119: preparer refused; overage through the engine (commitment_change); compliance gate inside'),
  ('res_reject_trade_invoice', '{p_invoice}', 'perform pm.access_assert_row(''projects.commitments'', array[''approve''], ''res_trade_invoices'', p_invoice);', '1119'),
  ('res_start_leveling',       '{p_package}', 'perform pm.access_assert_row(''projects.commitments'', array[''edit''], ''res_bid_packages'', p_package);', '1119: closes bidding'),
  ('res_release_milestone',    '{p_item}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''res_payment_schedule'', p_item);', '1119'),
  ('res_generate_cost_plus_billing','{p_job}', 'perform pm.access_assert_job(''projects.billing'', array[''create''], p_job);', '1119'),
  ('res_assemble_draw_package','{p_draw}', 'perform pm.access_assert_row(''projects.billing'', array[''edit''], ''draws'', p_draw);', '1119'),
  ('res_request_draw_shortfall','{p_draw}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''draws'', p_draw);', '1119'),
  ('res_billing_integrity',    '{p_location}', 'if not (pm.access_can_location(''projects.billing'', ''view'', p_location) or pm.access_can_location(''projects.jobs_all'', ''view'', p_location)) then perform pm.access_forbid(''requires projects.billing:view''); end if;', '1119: amounts masked inside'),
  ('res_decision_queue',       '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''view''], p_job);', '1119: amounts masked inside'),
  ('res_quote_lot',            '{p_lot}', 'if not (pm.access_can_location(''projects.estimates'', ''view'', (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id())) or pm.access_can_location(''projects.leads'', ''view'', (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id()))) then perform pm.access_forbid(''requires projects.estimates or leads at this company''); end if;', '1119: margin masked inside'),
  ('res_create_purchase_agreement','{p_lot}', 'perform pm.access_assert_location(''projects.estimates'', array[''create''], (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id()));', '1119'),
  ('res_sign_purchase_agreement','{p_pa}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gpa.location_id from pm.res_purchase_agreements gpa where gpa.id = p_pa and gpa.org_id = public.get_org_id()));', '1119: creates the house job + earnest-money deposit'),
  ('res_pa_change_options',    '{p_pa}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gpa.location_id from pm.res_purchase_agreements gpa where gpa.id = p_pa and gpa.org_id = public.get_org_id()));', '1119'),
  ('res_sign_addendum',        '{p_addendum}', 'perform pm.access_assert_location(''projects.estimates'', array[''edit''], (select gpa.location_id from pm.res_pa_addenda gad join pm.res_purchase_agreements gpa on gpa.id = gad.agreement_id where gad.id = p_addendum and gad.org_id = public.get_org_id()));', '1119'),
  ('res_release_lot',          '{p_lot}', 'perform pm.access_assert_location(''projects.jobs'', array[''create''], (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id())); perform pm.access_assert_location(''projects.commitments'', array[''create''], (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id()));', '1119'),
  ('res_preview_start_package','{p_lot}', 'perform pm.access_assert_location(''projects.commitments'', array[''view''], (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id()));', '1119'),
  ('res_release_stage',        '{p_lot}', 'perform pm.access_assert_location(''projects.commitments'', array[''edit''], (select glt.location_id from pm.res_lots glt where glt.id = p_lot and glt.org_id = public.get_org_id()));', '1119: approval through the engine'),
  ('res_create_vpo',           '{p_job}', 'if not (pm.access_can_job(''projects.commitments'', ''create'', p_job) or pm.access_can_job(''projects.change_orders'', ''create'', p_job)) then perform pm.access_forbid(''requires projects.commitments:create or change_orders:create on this job''); end if;', '1119'),
  ('res_record_inspection',    '{p_inspection}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_inspections'', p_inspection);', '1119'),
  ('res_closing_status',       '{p_closing}', 'perform pm.access_assert_row(''projects.jobs'', array[''view''], ''res_closings'', p_closing);', '1119'),
  ('res_open_closing',         '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1119'),
  ('res_close',                '{p_closing}', 'perform pm.access_assert_row(''projects.billing'', array[''create''], ''res_closings'', p_closing);', '1119'),
  ('res_builder_kpis',         '{p_location}', 'perform pm.access_assert_location(''projects.reports'', array[''view''], p_location);', '1119: VPO money masked inside'),
  ('res_start_protection_check','{p_job}', 'if not (pm.access_can_job(''projects.jobs'', ''edit'', p_job) or pm.access_can_job(''projects.documents'', ''create'', p_job)) then perform pm.access_forbid(''requires your job''); end if;', '1119: crews'),
  ('res_complete_protection_check','{p_check}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''res_protection_checks'', p_check) or pm.access_can_row(''projects.documents'', ''create'', ''res_protection_checks'', p_check)) then perform pm.access_forbid(''requires your job''); end if;', '1119: crews'),
  ('res_create_chain',         '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1119'),
  ('res_advance_chain_step',   '{p_step}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''res_chain_steps'', p_step);', '1119'),
  ('res_schedule_warranty_walks','{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1119'),
  ('res_plan_walk',            '{p_job}', 'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1119'),
  ('res_complete_walk',        '{p_walk}', 'if not (pm.access_can_row(''projects.jobs'', ''edit'', ''res_walks'', p_walk) or pm.access_can_row(''projects.jobs'', ''create'', ''res_walks'', p_walk)) then perform pm.access_forbid(''requires projects.jobs:create on this job''); end if;', '1119')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 12. RLS + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['res_settings','res_catalog_items','res_assemblies','res_assembly_items','res_proposals','res_proposal_options',
    'res_proposal_lines','res_proposal_snapshots','res_payment_schedule','res_job_terms','res_change_order_lines','res_task_trades','res_bid_packages',
    'res_bid_package_lines','res_bid_invites','res_bid_prices','res_vendor_deposits','res_trade_invoices','res_trade_invoice_lines','res_communities',
    'res_community_phases','res_plans','res_elevations','res_plan_prices','res_options','res_option_prices','res_lots','res_price_agreements',
    'res_purchase_agreements','res_pa_options','res_pa_addenda','res_start_package_items','res_vpos','res_closings','res_home_profiles',
    'res_household_members','res_protection_checks','res_rrp_records','res_permits','res_inspections','res_chains','res_chain_steps','res_walks'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    execute format('revoke all on pm.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on pm.%I to service_role', t);
    execute format('grant select on pm.%I to authenticated', t);
  end loop;
  -- member-writable through the class write predicates (state / money columns stay RPC-only by trigger)
  foreach t in array array['res_settings','res_catalog_items','res_assemblies','res_assembly_items','res_proposal_options','res_proposal_lines',
    'res_bid_packages','res_bid_package_lines','res_communities','res_community_phases','res_plans','res_elevations','res_plan_prices','res_options',
    'res_option_prices','res_lots','res_price_agreements','res_household_members','res_permits'] loop
    execute format('grant insert, update, delete on pm.%I to authenticated', t);
  end loop;
  foreach t in array array['res_home_profiles','res_rrp_records','res_inspections'] loop
    execute format('grant insert, update on pm.%I to authenticated', t);
  end loop;
  execute 'grant update on pm.res_proposals to authenticated';
  execute 'grant update (checklist, scheduled_on, title_company, settlement, settlement_document_id) on pm.res_closings to authenticated';
end $$;

alter table pm.res_rate_counters enable row level security;
revoke all on pm.res_rate_counters from public, anon, authenticated;
grant select, insert, update, delete on pm.res_rate_counters to service_role;

alter table pm.res_state_rules enable row level security;
revoke all on pm.res_state_rules from public, anon, authenticated;
grant select on pm.res_state_rules to authenticated;
grant select, insert, update, delete on pm.res_state_rules to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'res_state_rules' and policyname = 'catalog_read') then
    create policy catalog_read on pm.res_state_rules for select to authenticated using (true);
  end if;
end $$;

-- inspections: members record requests; the result moves through pm.res_record_inspection
create or replace function pm.tg_res_inspection_result_guard() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated', 'anon') and (tg_op = 'INSERT' and new.result <> 'PENDING'
     or tg_op = 'UPDATE' and new.result is distinct from old.result) then
    raise exception 'PM_RES_INSPECTION_RESULT: record the result with pm.res_record_inspection (it blocks or completes the task)' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_res_inspection_result_guard on pm.res_inspections;
create trigger trg_res_inspection_result_guard before insert or update on pm.res_inspections
  for each row execute function pm.tg_res_inspection_result_guard();

-- lots: status moves through the builder RPCs once a buyer / job is attached
create or replace function pm.tg_res_lot_guard() returns trigger
language plpgsql
set search_path = pm, public
as $$
begin
  if current_user in ('authenticated', 'anon') and tg_op = 'UPDATE'
     and (new.job_id is distinct from old.job_id or (new.status is distinct from old.status and (old.status in ('SOLD','STARTED','COMPLETE','CLOSED') or new.status in ('SOLD','STARTED','COMPLETE','CLOSED')))) then
    raise exception 'PM_RES_LOT_STATE: sold / started / closed lots change through the purchase agreement, release and closing' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_res_lot_guard on pm.res_lots;
create trigger trg_res_lot_guard before update on pm.res_lots for each row execute function pm.tg_res_lot_guard();

grant select on pm.v_res_co_exposure, pm.v_res_trade_confirmations, pm.v_res_starts_board, pm.v_res_spec_inventory to authenticated, service_role;
revoke all on pm.v_res_co_exposure, pm.v_res_trade_confirmations, pm.v_res_starts_board, pm.v_res_spec_inventory from anon;

select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- Function grants: nothing for PUBLIC / anon in pm; members get the RPC surface; the three token
-- functions are the only anon surface (schema public, token-scoped).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and (p.proname like 'res\_%' or p.proname like '\_res\_%' or p.proname like 'tg\_res\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in (select g.function_name from pm.access_rpc_guards g where g.function_name like 'res\_%')
       or r.proname in ('res_round','res_sell','res_install_ref','res_stage_rank','res_try_date') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('res_trade_respond','res_bid_portal','res_po_accept') loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- ============================================================================
-- end 1119_pm_residential
-- ============================================================================
