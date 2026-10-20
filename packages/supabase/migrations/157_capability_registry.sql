-- =============================================================================
-- Migration 157: capability registry mirror (05-RBAC-SPEC §5.7 R-1) — wave 1
-- =============================================================================
-- core.capabilities           one row per RESOURCE (the capability is resource × action)
--   key text pk               e.g. 'ap.bills' (books prefix implied), 'core.access.roles'
--   module                    books | core | platform
--   domain                    builder area (GL, AP, Payments, …)
--   actions text[]            ⊆ the 9 canonical actions
--   label, description
--   tags text[]               ⊆ money | sensitive | locked | group
--   risk_tier                 standard | elevated | high | critical (derived from tags)
--   platform_only bool        module = platform (hard rule H5)
--   field_classes text[]      ⊆ comp | tin | bank | personal | secrets
--   supports_constraints      ⊆ amount_limit | dimension_restriction | doc_types |
--                               ownership | period | delivered_to_me | assigned_to_me
--   introduced_in, status (active | deprecated), alias_of -> capabilities(key)
-- core.capability_migrations  equivalence-preserving split / rename log
--
-- SOURCE OF TRUTH is the code registry apps/web/src/lib/rbac/capabilities.ts. The
-- GENERATED block at the bottom is written by apps/web/scripts/rbac/generate-access-seed.ts
-- and is a pure upsert (a key that disappears from code is marked deprecated, never
-- deleted — grants may still reference it). The guard test
-- (src/test/access-foundations.test.ts) replays migrations and fails if DB ≠ code.
--
-- RLS: platform catalog, not tenant data → any signed-in member may READ; writes are
-- service_role only (154 pattern; anon/authenticated write grants revoked).
-- ADDITIVE + IDEMPOTENT. No behavior change.
-- =============================================================================

create or replace function core.rbac_actions() returns text[]
  language sql immutable as
$$ select array['view','create','edit','delete','approve','post','release','export','configure']::text[] $$;

create table if not exists core.capabilities (
  key                  text primary key,
  module               text not null,
  domain               text not null,
  actions              text[] not null,
  label                text not null,
  description          text not null default '',
  tags                 text[] not null default '{}',
  risk_tier            text not null default 'standard',
  platform_only        boolean not null default false,
  field_classes        text[] not null default '{}',
  supports_constraints text[] not null default '{}',
  introduced_in        text,
  status               text not null default 'active',
  alias_of             text references core.capabilities(key),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint capabilities_key_format_chk check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  constraint capabilities_module_chk check (module in ('books', 'core', 'platform')),
  constraint capabilities_actions_chk check (cardinality(actions) > 0 and actions <@ core.rbac_actions()),
  constraint capabilities_tags_chk check (tags <@ array['money','sensitive','locked','group']::text[]),
  constraint capabilities_risk_chk check (risk_tier in ('standard','elevated','high','critical')),
  constraint capabilities_fields_chk check (field_classes <@ array['comp','tin','bank','personal','secrets']::text[]),
  constraint capabilities_constraints_chk check (supports_constraints <@ array['amount_limit','dimension_restriction','doc_types','ownership','period','delivered_to_me','assigned_to_me']::text[]),
  constraint capabilities_status_chk check (status in ('active', 'deprecated'))
);
comment on table core.capabilities is
  '05 R-1: mirror of the code capability registry (lib/rbac/capabilities.ts). One row per resource; a capability is key:action.';

create table if not exists core.capability_migrations (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('split', 'rename')),
  from_key   text not null,
  to_keys    text[] not null check (cardinality(to_keys) > 0),
  note       text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, from_key)
);
comment on table core.capability_migrations is
  '05 R-1 / §1.7: equivalence-preserving split/rename of capabilities (a role holding the parent gets the children).';

-- Is `p_action` a valid action of capability `p_key`? (used by grant validation)
create or replace function core.capability_has_action(p_key text, p_action text) returns boolean
  language sql stable as
$$ select exists (select 1 from core.capabilities c where c.key = p_key and p_action = any (c.actions)) $$;

-- Deploy-step mirror: upsert every capability from the code registry JSON.
create or replace function core.rbac_mirror_capabilities(p_caps jsonb) returns integer
  language plpgsql as
$$
declare n integer := 0; r jsonb;
begin
  for r in select * from jsonb_array_elements(p_caps) loop
    insert into core.capabilities as c
      (key, module, domain, actions, label, description, tags, risk_tier, platform_only,
       field_classes, supports_constraints, introduced_in, status)
    values (
      r->>'key', r->>'module', r->>'domain',
      array(select jsonb_array_elements_text(r->'actions')),
      r->>'label', coalesce(r->>'description', ''),
      array(select jsonb_array_elements_text(r->'tags')),
      r->>'risk_tier', (r->>'platform_only')::boolean,
      array(select jsonb_array_elements_text(r->'field_classes')),
      array(select jsonb_array_elements_text(r->'supports_constraints')),
      r->>'introduced_in', coalesce(r->>'status', 'active'))
    on conflict (key) do update set
      module = excluded.module, domain = excluded.domain, actions = excluded.actions,
      label = excluded.label, description = excluded.description, tags = excluded.tags,
      risk_tier = excluded.risk_tier, platform_only = excluded.platform_only,
      field_classes = excluded.field_classes, supports_constraints = excluded.supports_constraints,
      introduced_in = coalesce(c.introduced_in, excluded.introduced_in),
      status = excluded.status, updated_at = now()
    where (c.module, c.domain, c.actions, c.label, c.description, c.tags, c.risk_tier,
           c.platform_only, c.field_classes, c.supports_constraints, c.status)
      is distinct from
          (excluded.module, excluded.domain, excluded.actions, excluded.label, excluded.description,
           excluded.tags, excluded.risk_tier, excluded.platform_only, excluded.field_classes,
           excluded.supports_constraints, excluded.status);
    n := n + 1;
  end loop;
  -- Keys removed from code are deprecated, never deleted (grants may reference them).
  update core.capabilities set status = 'deprecated', updated_at = now()
   where status = 'active'
     and key not in (select e->>'key' from jsonb_array_elements(p_caps) e);
  return n;
end
$$;
revoke all on function core.rbac_mirror_capabilities(jsonb) from public, anon, authenticated;
grant execute on function core.rbac_mirror_capabilities(jsonb) to service_role;

-- ── RLS: catalog readable by members; writes service_role only ────────────────
do $$
declare t text;
begin
  foreach t in array array['capabilities', 'capability_migrations'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists member_read on core.%I', t);
    execute format('drop policy if exists service_all on core.%I', t);
    execute format('create policy member_read on core.%I for select to authenticated using (true)', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- BEGIN GENERATED capabilities (apps/web/scripts/rbac/generate-access-seed.ts — do not edit by hand)
select core.rbac_mirror_capabilities($seed$[
  {"key":"gl.accounts","module":"books","domain":"GL","actions":["view","create","edit","delete","approve","export","configure"],"label":"Chart of accounts","description":"Accounts, account requests (create) and the COA approval workflow (approve); configure = COA rules and groups.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.journal_entries","module":"books","domain":"GL","actions":["view","create","edit","delete","approve","post","export"],"label":"Journal entries","description":"Manual journal entries: prepare, reviewer approval, post to the ledger.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit","dimension_restriction","doc_types","period"],"introduced_in":"wave1","status":"active"},
  {"key":"gl.recurring_entries","module":"books","domain":"GL","actions":["view","create","edit","delete","approve","post"],"label":"Recurring entries","description":"Recurring journal entries: propose, approve, post.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"gl.periods","module":"books","domain":"GL","actions":["view","edit","approve","configure"],"label":"Periods","description":"Open / soft-close a period (edit), hard close (approve), fiscal calendar (configure).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.period_override","module":"books","domain":"GL","actions":["post"],"label":"Post into a soft-closed period","description":"Privileged posting into a soft-closed period. Hard-closed periods can never be posted to.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.reporting_basis","module":"books","domain":"GL","actions":["view","create","edit","post"],"label":"Reporting basis adjustments","description":"Accrual / cash / tax overlay adjustments.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.dimensions","module":"books","domain":"GL","actions":["view","create","edit","delete","configure"],"label":"Departments, classes & items","description":"Dimension masters.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.year_end","module":"books","domain":"GL","actions":["view","post"],"label":"Year-end close","description":"Close the year to retained earnings.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.intercompany","module":"books","domain":"GL","actions":["view","create","edit","approve","post"],"label":"Intercompany","description":"Intercompany matching and pair balances.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.internal_invoices","module":"books","domain":"GL","actions":["view","create","edit","approve","post","release"],"label":"Internal invoices","description":"Inter-department / inter-client invoices; release = issue to the counterparty.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"gl.posted_edit","module":"books","domain":"GL","actions":["edit"],"label":"Edit posted records","description":"Privileged override: reverse and re-post a posted record with a typed reason.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"close.checklist","module":"books","domain":"Close","actions":["view","edit","approve","configure"],"label":"Close checklist","description":"Complete close tasks (edit), reviewer sign-off (approve), checklist templates (configure).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"close.package","module":"books","domain":"Close","actions":["view","release","export"],"label":"Close package","description":"The client close packet; release = deliver it.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"bank.connections","module":"books","domain":"Bank","actions":["view","create","delete","configure"],"label":"Bank connections","description":"Plaid links and account mapping.","tags":["sensitive"],"risk_tier":"elevated","platform_only":false,"field_classes":["bank"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"bank.transactions","module":"books","domain":"Bank","actions":["view","edit","approve","export"],"label":"Bank transactions","description":"Code bank transactions (edit); approve coding, which posts through the engine.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"bank.rules","module":"books","domain":"Bank","actions":["view","create","edit","delete"],"label":"Bank rules","description":"Deterministic coding rules.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"bank.statements","module":"books","domain":"Bank","actions":["view","create"],"label":"Bank statements","description":"Statement import.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"bank.reconciliations","module":"books","domain":"Bank","actions":["view","create","edit","approve","export"],"label":"Reconciliations","description":"Prepare a reconciliation (edit) and reviewer sign-off (approve).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"bank.transfers","module":"books","domain":"Bank","actions":["view","create","approve","release"],"label":"Transfers","description":"Transfers between accounts and clients.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"cards.transactions","module":"books","domain":"Cards","actions":["view","edit","approve","export"],"label":"Card transactions","description":"Card feed (incl. Ramp): code and approve.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["ownership"],"introduced_in":"wave1","status":"active"},
  {"key":"cards.ramp_sync","module":"books","domain":"Cards","actions":["view","configure"],"label":"Ramp sync","description":"Push COA, dimensions and vendors to Ramp.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"cards.cardholders","module":"books","domain":"Cards","actions":["view","edit","configure"],"label":"Cardholders","description":"Map cards to employees (IA M-11).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ap.bills","module":"books","domain":"AP","actions":["view","create","edit","delete","approve","post","export"],"label":"Bills","description":"Vendor bills incl. intake queue and OCR drafts.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit","dimension_restriction","doc_types"],"introduced_in":"wave1","status":"active"},
  {"key":"ap.vendor_credits","module":"books","domain":"AP","actions":["view","create","approve","post"],"label":"Vendor credits","description":"Vendor credits.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"ap.purchase_orders","module":"books","domain":"AP","actions":["view","create","edit","delete","approve"],"label":"Purchase orders","description":"Purchase orders, goods receipts and 3-way match.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit","dimension_restriction"],"introduced_in":"wave1","status":"active"},
  {"key":"ap.policy","module":"books","domain":"AP","actions":["view","configure"],"label":"AP policy","description":"AP policy engine (natural-language rules).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"pay.batches","module":"books","domain":"Payments","actions":["view","create","edit","approve","release","export"],"label":"Pay runs","description":"Pay runs and check runs: build/queue, approve, release; export = positive-pay / NACHA file.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"pay.checks","module":"books","domain":"Payments","actions":["view","create","edit","post"],"label":"Checks","description":"Assign check numbers, print, remittance PDF; post = void (posts a reversal).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"pay.customer_payments","module":"books","domain":"Payments","actions":["view","create","edit","post"],"label":"Customer payments","description":"Record payments and cash application.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"pay.refunds","module":"books","domain":"Payments","actions":["view","create","approve","release"],"label":"Refunds","description":"Customer refunds.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"pay.vendor_bank_details","module":"books","domain":"Payments","actions":["view","edit"],"label":"Vendor bank details","description":"Bank account and routing on vendor payment profiles (most common payment-fraud vector).","tags":["sensitive","locked"],"risk_tier":"critical","platform_only":false,"field_classes":["bank"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"pay.provider_connections","module":"books","domain":"Payments","actions":["view","configure"],"label":"Payment providers","description":"Stripe / ACH / bank origination setup.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":["secrets"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"exp.receipts","module":"books","domain":"Expenses","actions":["view","create","edit","delete","approve"],"label":"Receipts","description":"Receipts; supports the ownership constraint (own / team / all).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["ownership","amount_limit","dimension_restriction"],"introduced_in":"wave1","status":"active"},
  {"key":"exp.reports","module":"books","domain":"Expenses","actions":["view","create","edit","approve"],"label":"Expense reports","description":"Expense reports and the approver queue.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["ownership","amount_limit","dimension_restriction","doc_types"],"introduced_in":"wave1","status":"active"},
  {"key":"exp.reimbursements","module":"books","domain":"Expenses","actions":["view","create","approve","release"],"label":"Reimbursements","description":"Reimbursement batches.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"exp.policy","module":"books","domain":"Expenses","actions":["view","configure"],"label":"Expense policy","description":"Mileage, per-diem and out-of-policy rules.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"exp.chase_policy","module":"books","domain":"Expenses","actions":["view","configure"],"label":"Receipt chase policy","description":"Receipt policy and chase cadence (IA M-11).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.invoices","module":"books","domain":"AR","actions":["view","create","edit","delete","approve","post","release","export"],"label":"Invoices","description":"Customer invoices; release = send to customer; post = post / void.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"ar.credit_memos","module":"books","domain":"AR","actions":["view","create","approve","post"],"label":"Credit memos","description":"Credit memos.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"ar.write_offs","module":"books","domain":"AR","actions":["view","create","approve","post"],"label":"Write-offs","description":"Bad-debt write-offs.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"ar.estimates","module":"books","domain":"AR","actions":["view","create","edit","delete","release"],"label":"Estimates","description":"Estimates; release = send.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.deposits","module":"books","domain":"AR","actions":["view","create","post"],"label":"Deposits & retainers","description":"Customer deposits and retainers.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.recurring","module":"books","domain":"AR","actions":["view","create","edit","delete"],"label":"Recurring invoices","description":"Recurring invoice templates.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.collections","module":"books","domain":"AR","actions":["view","edit","release"],"label":"Collections","description":"Worklist and promise-to-pay (edit); send dunning (release).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.statements","module":"books","domain":"AR","actions":["view","release"],"label":"Customer statements","description":"Customer statements; release = send.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ar.payment_links","module":"books","domain":"AR","actions":["view","configure"],"label":"Payment links","description":"Stripe Pay Now per client.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"revrec.methods","module":"books","domain":"Rev rec","actions":["view","edit","configure"],"label":"Recognition methods","description":"Per-job method assignment (9 methods).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"revrec.runs","module":"books","domain":"Rev rec","actions":["view","create","post"],"label":"Recognition runs","description":"Recognition runs (2410 / 1180 entries).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"revrec.schedules","module":"books","domain":"Rev rec","actions":["view","export"],"label":"Recognition schedules","description":"Roll-forward and waterfall.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"jobs.jobs","module":"books","domain":"Jobs","actions":["view","create","edit","delete"],"label":"Jobs","description":"Jobs, cost codes, job P&L.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["dimension_restriction"],"introduced_in":"wave1","status":"active"},
  {"key":"jobs.change_orders","module":"books","domain":"Jobs","actions":["view","create","approve"],"label":"Change orders","description":"Change orders.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"jobs.wip","module":"books","domain":"Jobs","actions":["view","edit","post","export"],"label":"WIP","description":"WIP schedule, EAC, over/under-billing adjustments.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"inv.items","module":"books","domain":"Inventory","actions":["view","create","edit","delete"],"label":"Inventory items","description":"Inventory items.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"inv.movements","module":"books","domain":"Inventory","actions":["view","create","approve","post"],"label":"Inventory movements","description":"Movements and movement approval.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"inv.valuation","module":"books","domain":"Inventory","actions":["view","post","configure"],"label":"Inventory valuation","description":"FIFO / standard costing and GL tie-out.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"fa.assets","module":"books","domain":"Assets","actions":["view","create","edit","delete","post"],"label":"Fixed assets","description":"Fixed assets incl. depreciation runs (post), tax book, disposals.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"fa.leases","module":"books","domain":"Assets","actions":["view","create","edit","post"],"label":"Leases","description":"ASC 842 commence, modify, terminate.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"fa.prepaids","module":"books","domain":"Assets","actions":["view","create","edit","post"],"label":"Prepaids","description":"Prepaids, insurance amortization, intangibles.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"debt.loans","module":"books","domain":"Debt","actions":["view","create","edit","post"],"label":"Loans","description":"Origination, P&I, payoff, refinance.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"debt.covenants","module":"books","domain":"Debt","actions":["view","edit","configure"],"label":"Covenants","description":"Covenant monitor and compute.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"debt.certificates","module":"books","domain":"Debt","actions":["view","create","approve","release"],"label":"Compliance certificates","description":"Compliance certificates; release = send to lender.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["delivered_to_me"],"introduced_in":"wave1","status":"active"},
  {"key":"debt.borrowing_base","module":"books","domain":"Debt","actions":["view","create","approve","release"],"label":"Borrowing base","description":"Borrowing base certificates.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["delivered_to_me"],"introduced_in":"wave1","status":"active"},
  {"key":"debt.lender_obligations","module":"books","domain":"Debt","actions":["view","create","edit","configure"],"label":"Lender obligations","description":"Lender reporting calendar and deliveries (IA M-14).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"cash.position","module":"books","domain":"Cash","actions":["view"],"label":"Cash position","description":"Cash position.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"cash.forecast","module":"books","domain":"Cash","actions":["view","create","edit"],"label":"Cash forecast","description":"13-week and direct forecast.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"cash.obligations","module":"books","domain":"Cash","actions":["view","create","edit"],"label":"Obligations","description":"Renewals and subscriptions calendar.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"payroll.runs","module":"books","domain":"Payroll","actions":["view","create","edit","approve","release"],"label":"Payroll runs","description":"Payroll runs; release = release to the provider.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":["comp"],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"payroll.register","module":"books","domain":"Payroll","actions":["view","create","post"],"label":"Payroll register","description":"Register import to journal entry.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":["comp"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"payroll.employees","module":"books","domain":"Payroll","actions":["view","create","edit"],"label":"Payroll employees","description":"HR record; pay rate and bank fields fall under the comp and bank field classes.","tags":["sensitive"],"risk_tier":"elevated","platform_only":false,"field_classes":["comp","bank","tin","personal"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"payroll.remittances","module":"books","domain":"Payroll","actions":["view","create","release"],"label":"Payroll remittances","description":"Tax and benefit remittances.","tags":["money"],"risk_tier":"high","platform_only":false,"field_classes":[],"supports_constraints":["amount_limit"],"introduced_in":"wave1","status":"active"},
  {"key":"payroll.settings","module":"books","domain":"Payroll","actions":["view","configure"],"label":"Payroll settings","description":"Pay schedules, register mappings, provider.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"tax.sales_tax","module":"books","domain":"Tax","actions":["view","edit","post","configure"],"label":"Sales tax","description":"Rates, worksheet, filing calendar, nexus.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"tax.filings","module":"books","domain":"Tax","actions":["view","create","approve","release"],"label":"Tax filings","description":"Sales-tax returns and FIRE 1099 transmission; release = file.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"tax.1099","module":"books","domain":"Tax","actions":["view","create","edit","export"],"label":"1099s","description":"W-9 gaps and Copy B.","tags":["sensitive"],"risk_tier":"elevated","platform_only":false,"field_classes":["tin"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"tax.provision","module":"books","domain":"Tax","actions":["view","create","edit","post"],"label":"Tax provision","description":"ASC 740, book-to-tax M-1/M-3, return package.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"fpa.budgets","module":"books","domain":"FP&A","actions":["view","create","edit","approve","export"],"label":"Budgets","description":"Budgets; approve = lock a budget version.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["dimension_restriction"],"introduced_in":"wave1","status":"active"},
  {"key":"fpa.scenarios","module":"books","domain":"FP&A","actions":["view","create","edit"],"label":"Scenarios","description":"Drivers, reforecast, what-if.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"fpa.profitability","module":"books","domain":"FP&A","actions":["view","export"],"label":"Profitability","description":"Per-entity profitability.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"reports.financial","module":"books","domain":"Reports","actions":["view","export"],"label":"Financial reports","description":"P&L, balance sheet, cash flow, trial balance, GL detail, aging.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["dimension_restriction"],"introduced_in":"wave1","status":"active"},
  {"key":"reports.saved_views","module":"books","domain":"Reports","actions":["view","create","edit","delete"],"label":"Saved views","description":"Saved report views.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["ownership"],"introduced_in":"wave1","status":"active"},
  {"key":"reports.packs","module":"books","domain":"Reports","actions":["view","create","edit","release"],"label":"Report packs","description":"Report packs; release = scheduled delivery to others.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["delivered_to_me"],"introduced_in":"wave1","status":"active"},
  {"key":"reports.board_package","module":"books","domain":"Reports","actions":["view","create","approve","release"],"label":"Board package","description":"Board package generator.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["delivered_to_me"],"introduced_in":"wave1","status":"active"},
  {"key":"consol.groups","module":"books","domain":"Consolidation","actions":["view","create","edit","delete","configure"],"label":"Consolidation groups","description":"Group membership, method, FX.","tags":["group"],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"consol.statements","module":"books","domain":"Consolidation","actions":["view","export"],"label":"Consolidated statements","description":"Consolidated statements; requires view on every member.","tags":["group"],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"consol.eliminations","module":"books","domain":"Consolidation","actions":["view","create","post"],"label":"Eliminations","description":"Group-level top-side adjustments.","tags":["group"],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.exceptions","module":"books","domain":"Controls","actions":["view","edit","approve"],"label":"Exceptions","description":"Exceptions: resolve (edit), accept risk (approve).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.approval_workflows","module":"books","domain":"Controls","actions":["view","configure"],"label":"Approval workflows","description":"Approval chains and the simulator.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.compliance","module":"books","domain":"Controls","actions":["view","edit","approve"],"label":"Compliance","description":"SOX command center.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.vendor_compliance","module":"books","domain":"Controls","actions":["view","edit","approve"],"label":"Vendor compliance","description":"W-9 / COI.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.pbc","module":"books","domain":"Controls","actions":["view","create","edit","approve"],"label":"PBC requests","description":"Auditor request list.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.audit_trail","module":"books","domain":"Controls","actions":["view","export"],"label":"Audit trail","description":"Audit trail.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ctl.ai_decisions","module":"books","domain":"Controls","actions":["view","export"],"label":"AI decision log","description":"AI decision log.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"mdm.vendors","module":"books","domain":"Masters","actions":["view","create","edit","delete"],"label":"Vendors","description":"Vendor master incl. merge/dedupe (edit). Bank details are NOT included.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"mdm.customers","module":"books","domain":"Masters","actions":["view","create","edit","delete"],"label":"Customers","description":"Customer master, merge, risk dossier.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"mdm.items","module":"books","domain":"Masters","actions":["view","create","edit","delete"],"label":"Items","description":"Product / service items.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"docs.documents","module":"books","domain":"Requests & portals","actions":["view","create","delete","export"],"label":"Documents","description":"Document center.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["ownership"],"introduced_in":"wave1","status":"active"},
  {"key":"req.client_requests","module":"books","domain":"Requests & portals","actions":["view","create","edit","release"],"label":"Client requests","description":"Draft and answer requests; release = send / remind (external).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":["assigned_to_me"],"introduced_in":"wave1","status":"active"},
  {"key":"portal.customer","module":"books","domain":"Requests & portals","actions":["view","release","configure"],"label":"Customer portal","description":"Customer portal; release = issue a magic link.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"portal.vendor","module":"books","domain":"Requests & portals","actions":["view","release","configure"],"label":"Vendor portal","description":"Vendor portal; release = issue a magic link.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"portal.client","module":"books","domain":"Requests & portals","actions":["view","configure"],"label":"Client portal","description":"Firm-client portal (planned).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"onb.clients","module":"books","domain":"Onboarding","actions":["view","create","edit","delete"],"label":"Clients","description":"Add / archive clients (delete = archive).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"onb.wizard","module":"books","domain":"Onboarding","actions":["view","edit"],"label":"Onboarding wizard","description":"Run the onboarding wizard (replaces admin_scope PREPARER).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"onb.imports","module":"books","domain":"Onboarding","actions":["view","create","post"],"label":"Data imports","description":"TB / AR / AP / WIP / equity imports; post = post opening balances.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"onb.conversion","module":"books","domain":"Onboarding","actions":["view","approve","post"],"label":"Conversion","description":"Conversion; approve = pass the tie-out gate.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"int.connections","module":"books","domain":"Integrations","actions":["view","create","delete","configure"],"label":"Connections","description":"QBO / Xero / Sage / ERP / Ramp connectors.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":["secrets"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"int.api_keys","module":"books","domain":"Integrations","actions":["view","create","delete"],"label":"API keys","description":"API keys.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":["secrets"],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"int.sync_runs","module":"books","domain":"Integrations","actions":["view","edit"],"label":"Sync runs","description":"Retry and resolve sync errors.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"int.mappings","module":"books","domain":"Integrations","actions":["view","edit"],"label":"Connector mappings","description":"Connector mapping queue (07).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ai.assist","module":"books","domain":"AI","actions":["view"],"label":"AI assist","description":"Command bar / NL query / JE composer drafts (saving still needs the underlying capability).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ai.agents","module":"books","domain":"AI","actions":["view","create","configure"],"label":"Agents","description":"Run an agent recipe (create); recipe settings (configure).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ai.autonomy","module":"books","domain":"AI","actions":["view","configure"],"label":"AI autonomy","description":"Autonomy dial and kill switch.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"home.workspace","module":"books","domain":"Workspace","actions":["view"],"label":"Workspace home","description":"Tenant workspace surfaces.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"home.client","module":"books","domain":"Workspace","actions":["view"],"label":"Client home","description":"Client home.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"home.platform","module":"platform","domain":"Workspace","actions":["view"],"label":"Platform home","description":"Platform console home.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"home.portal","module":"books","domain":"Workspace","actions":["view"],"label":"Portal home","description":"Portal home for external audiences.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ws.client_health","module":"books","domain":"Workspace","actions":["view"],"label":"Client health","description":"Operations / client health, capacity.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"ws.assignments","module":"books","domain":"Workspace","actions":["view","create","edit","delete"],"label":"Capacity assignments","description":"Preparer / reviewer / approver capacity assignments (IA M-5).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"alerts.watch_rules","module":"books","domain":"Workspace","actions":["view","create","edit","delete"],"label":"Watch rules","description":"Alert watch rules (IA M-13).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.members","module":"core","domain":"Access","actions":["view","create","edit","delete"],"label":"Members","description":"Invite, deactivate, edit profile.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.roles","module":"core","domain":"Access","actions":["view","create","edit","delete","configure"],"label":"Roles & permission sets","description":"Author roles and permission sets; configure = publish.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.assignments","module":"core","domain":"Access","actions":["view","create","edit","delete"],"label":"Access assignments","description":"Grant and revoke access (delegation ceiling).","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.reviews","module":"core","domain":"Access","actions":["view","create","approve","export"],"label":"Access reviews","description":"Run and attest access reviews.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.simulate","module":"core","domain":"Access","actions":["view"],"label":"View as","description":"Read-only view-as simulation.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.access.sod_policy","module":"core","domain":"Access","actions":["view","configure"],"label":"Conflict rules","description":"Tighten SoD, approve exceptions.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.settings","module":"core","domain":"Settings","actions":["view","configure"],"label":"Tenant settings","description":"System, security (MFA / IP / session), branding.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.accounting_settings","module":"core","domain":"Settings","actions":["view","configure"],"label":"Accounting settings","description":"GL rules and close gates.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.billing","module":"core","domain":"Settings","actions":["view","configure"],"label":"Billing","description":"Plan and payment method; configure limited to the billing owner.","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.dashboard_layouts","module":"core","domain":"Settings","actions":["view","configure"],"label":"Dashboard layouts","description":"Publish role layouts (IA M-8).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.support_access","module":"core","domain":"Settings","actions":["view","approve"],"label":"Support access","description":"Approve platform support grants (IA M-9).","tags":[],"risk_tier":"standard","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.export","module":"core","domain":"Settings","actions":["export"],"label":"Full tenant export","description":"Full tenant export.","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"core.tenant.reset","module":"core","domain":"Settings","actions":["delete"],"label":"Tenant reset","description":"Sandbox / tenant reset (two-person rule).","tags":["locked"],"risk_tier":"critical","platform_only":false,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.tenants","module":"platform","domain":"Platform","actions":["view","create","edit"],"label":"Tenants","description":"Provision, suspend, lifecycle.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.entitlements","module":"platform","domain":"Platform","actions":["view","configure"],"label":"Entitlements","description":"Module entitlements.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.templates","module":"platform","domain":"Platform","actions":["view","create","edit","configure"],"label":"Templates","description":"Role, permission-set and envelope templates, SoD rules, dashboard defaults.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.support","module":"platform","domain":"Platform","actions":["view","create"],"label":"Support","description":"Request support access, run sessions.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.billing","module":"platform","domain":"Platform","actions":["view","configure"],"label":"Platform billing","description":"Platform billing.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.health","module":"platform","domain":"Platform","actions":["view"],"label":"Platform health","description":"Ops, AI gateway, integrations.","tags":[],"risk_tier":"standard","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"},
  {"key":"platform.break_glass","module":"platform","domain":"Platform","actions":["create"],"label":"Break-glass","description":"Incident access (IA Q6).","tags":["locked"],"risk_tier":"critical","platform_only":true,"field_classes":[],"supports_constraints":[],"introduced_in":"wave1","status":"active"}
]$seed$::jsonb);
-- END GENERATED capabilities
