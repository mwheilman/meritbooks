-- Migration 080: AP Purchase Orders + Goods Receipts + 3-way match (GATE 11b — Books AP)
-- =============================================================
-- Closes the structural AP gap: Books had bills but NO purchase-order model, so
-- there was nothing to run a 3-way match against (PO ↔ receipt ↔ bill). This adds
-- the GENERAL (non-job) vendor-procurement PO to the `public` schema.
--
-- SCOPE BOUNDARY (deliberate): this is DISTINCT from `proj.commitments`, which the
-- MeritProjects workstream owns for the JOB / subcontract context. That is a PO in
-- the construction-commitment sense; THIS is the everyday AP procurement PO (office
-- supplies, equipment, materials against a GL account). They never overlap — a job
-- PO lives in proj.*; a general vendor PO lives here. Nothing in this migration
-- touches proj.* .
--
-- Numbering: Books mints po_number (canon §2 "Numbering owners" — bill#/PO# → Books),
-- enforced UNIQUE per org.
--
-- Money is bigint cents everywhere. RLS org_isolation via public.get_org_id()
-- (Clerk org_id claim; never auth.uid()). Master data (vendor/location/item/dept)
-- is referenced by FK into `core`; the ledger stays in `public`. The bills table is
-- NOT altered — the bill↔PO relationship lives in its own link table.
--
-- ADDITIVE + idempotent (create-if-not-exists; safe to re-run). Books band; next
-- after 079. Requires 019 (core carve → core.vendors/locations/items/departments),
-- 003 (public.accounts), 005 (public.bills). Apply to Supabase FIRST, then ship the
-- code that depends on it. DEGRADES SAFE — absent these tables the PO feature is
-- simply unavailable; nothing else breaks.
-- =============================================================

-- ---- Guard: the master-data + bills tables we FK into must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'vendors') then
    raise exception 'core.vendors not found — deploy migration 019 (core carve) before 080.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'bills') then
    raise exception 'public.bills not found — deploy migration 005 before 080.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'accounts') then
    raise exception 'public.accounts not found — deploy migration 003 before 080.';
  end if;
end $$;

-- =============================================================
-- 1. PURCHASE ORDER (header)
-- =============================================================
-- Lifecycle: DRAFT → OPEN (issued to vendor) → PARTIAL (some received) →
-- CLOSED (fully received/billed) | CANCELLED. Totals are convenience roll-ups of
-- the lines; the lines are authoritative.
create table if not exists public.purchase_orders (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Optional legal-entity / location scope (core master data). Nullable so a PO can
  -- be raised org-wide before an entity is chosen.
  location_id uuid references core.locations(id) on delete set null,
  vendor_id uuid not null references core.vendors(id) on delete restrict,

  -- Books-minted, unique per tenant.
  po_number text not null,

  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'OPEN', 'PARTIAL', 'CLOSED', 'CANCELLED')),

  order_date date not null default current_date,
  expected_date date,
  memo text,

  -- Roll-ups (bigint cents). Kept in sync by the app when lines/receipts/bills move.
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  received_total_cents bigint not null default 0,   -- value of goods received
  billed_total_cents bigint not null default 0,     -- value billed against this PO

  -- Attribution: uuid columns stay null for Clerk (text) ids; human actor is the
  -- *_by_user text column (mirrors bills / gl_entries attribution convention).
  created_by uuid,
  created_by_user text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_purchase_orders_number
  on public.purchase_orders(org_id, po_number);
create index if not exists idx_purchase_orders_status
  on public.purchase_orders(org_id, status, order_date desc);
create index if not exists idx_purchase_orders_vendor
  on public.purchase_orders(org_id, vendor_id);

-- =============================================================
-- 2. PURCHASE ORDER LINES
-- =============================================================
-- One ordered line: a GL account (COGS/OPEX) or item, ordered qty × unit cost.
-- received_qty / billed_qty are meters advanced by receipts and bill matches;
-- the 3-way match reads ordered vs received vs billed off these + the bill.
create table if not exists public.purchase_order_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  line_number int not null,
  description text,
  -- The expense/COGS account this line will post to when billed (public.accounts).
  account_id uuid references public.accounts(id) on delete set null,
  item_id uuid references core.items(id) on delete set null,
  department_id uuid references core.departments(id) on delete set null,
  job_id uuid,                                   -- optional GL dimension (thin ref)

  -- Quantities may be fractional (hours, sq ft); money stays bigint cents.
  quantity numeric(18,4) not null default 1 check (quantity >= 0),
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  amount_cents bigint not null default 0,        -- ordered extended = round(qty*unit)
  received_qty numeric(18,4) not null default 0 check (received_qty >= 0),
  billed_qty numeric(18,4) not null default 0 check (billed_qty >= 0),

  created_at timestamptz not null default now(),
  constraint uq_po_line_number unique (po_id, line_number)
);

create index if not exists idx_po_lines_po on public.purchase_order_lines(po_id);
create index if not exists idx_po_lines_org on public.purchase_order_lines(org_id);

-- =============================================================
-- 3. GOODS RECEIPTS (header + lines) — the "received" leg of the 3-way match
-- =============================================================
create table if not exists public.goods_receipts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  receipt_number text,
  received_date date not null default current_date,
  received_by_user text,                          -- Clerk actor (text)
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_goods_receipts_po on public.goods_receipts(po_id);
create index if not exists idx_goods_receipts_org on public.goods_receipts(org_id, received_date desc);

create table if not exists public.goods_receipt_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  receipt_id uuid not null references public.goods_receipts(id) on delete cascade,
  po_line_id uuid not null references public.purchase_order_lines(id) on delete cascade,
  quantity_received numeric(18,4) not null default 0 check (quantity_received >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_grl_receipt on public.goods_receipt_lines(receipt_id);
create index if not exists idx_grl_po_line on public.goods_receipt_lines(po_line_id);

-- =============================================================
-- 4. BILL ↔ PO LINK (the match result) — does NOT alter public.bills
-- =============================================================
-- When a bill is linked to a PO, the 3-way match runs and its verdict is stored
-- here. A clean match can be approved; a mismatch surfaces as a PROPOSED
-- ai_decisions exception (feature THREE_WAY_MATCH) for a human — never auto-pays.
create table if not exists public.bill_po_links (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  match_status text not null default 'PENDING'
    check (match_status in ('PENDING', 'MATCHED', 'EXCEPTION', 'OVERRIDDEN')),
  -- The full computed three-way-match verdict (per-line ordered/received/billed +
  -- flags + tolerance used) for drill-down and audit.
  match_result jsonb,
  -- The ai_decisions row raised when the match is an EXCEPTION (drill-through).
  exception_decision_id uuid references public.ai_decisions(id) on delete set null,
  matched_by_user text,
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_bill_po_link unique (org_id, bill_id, po_id)
);

create index if not exists idx_bill_po_links_bill on public.bill_po_links(bill_id);
create index if not exists idx_bill_po_links_po on public.bill_po_links(po_id);

-- =============================================================
-- 5. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'purchase_orders', 'purchase_order_lines', 'goods_receipts',
    'goods_receipt_lines', 'bill_po_links'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    begin
      execute format(
        'create policy "org_isolation" on public.%I for all using (org_id = public.get_org_id());',
        t
      );
    exception when duplicate_object then null;
    end;
    execute format(
      'grant select, insert, update, delete on public.%I to anon, authenticated, service_role;',
      t
    );
  end loop;
end $$;

-- Keep purchase_orders.updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_purchase_orders_updated
        before update on public.purchase_orders
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================
-- DONE. Books now has a general-procurement purchase order (public.purchase_orders
-- + lines), goods receipts (public.goods_receipts + lines), and a bill↔PO link that
-- carries the 3-way-match verdict — all org-isolated by RLS, all money in cents,
-- all master data referenced from core. proj.* is untouched. The engine
-- (lib/procurement/three-way-match) reads ordered vs received vs billed and flags
-- over-bill / over-receipt / price-variance; a mismatch rides the ai_decisions →
-- /exceptions rail for human approval. Never auto-pays.
-- =============================================================
