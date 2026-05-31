-- =============================================================
-- Session 14 — Acme wipe + Suite Core validation
-- Run these in the Supabase SQL editor. Three independent sections.
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- SECTION A — PROVE THE CARVE (run immediately after migration 019,
--             no data required)
-- ─────────────────────────────────────────────────────────────
-- Expect: all eight rows report schema = 'core'.

select table_schema, table_name
from information_schema.tables
where table_name in
  ('organizations','locations','departments','customers','vendors','items','employees','jobs')
  and table_schema in ('public','core')
order by table_name;

-- Confirm the thin-canonical additions landed:
--   items: sku (renamed from code), item_type, income_account_id, cogs_account_id
--   employees: payroll_account_id
select table_name, column_name
from information_schema.columns
where table_schema = 'core'
  and ((table_name = 'items'     and column_name in ('sku','item_type','income_account_id','cogs_account_id'))
    or (table_name = 'employees' and column_name in ('payroll_account_id')))
order by table_name, column_name;


-- ─────────────────────────────────────────────────────────────
-- SECTION B — WIPE THE TEST TENANT (clean slate before re-onboarding)
-- ─────────────────────────────────────────────────────────────
-- Single-tenant dev DB: deleting the organization cascades to every
-- org-scoped row (locations, departments, fiscal_periods, accounts,
-- internal invoices, gl entries, the Acme test data — everything).
-- The wizard re-seeds the COA on the next onboarding run.
--
-- Uncomment to run:

-- delete from core.organizations;

-- Verify empty:
-- select 'organizations' t, count(*) from core.organizations
-- union all select 'locations', count(*) from core.locations
-- union all select 'gl_entries', count(*) from public.gl_entries;


-- ─────────────────────────────────────────────────────────────
-- SECTION C — PROVE PLACEMENT (run AFTER re-onboarding + imports)
-- ─────────────────────────────────────────────────────────────
-- Master data must live in core; ledger data must live in Books (public).
-- Expect non-zero counts on the core side for whatever you onboarded/imported,
-- and ledger rows on the public side for any trial balance / open AR-AP / GL
-- history you imported.

select 'core.locations'   as object, count(*) from core.locations
union all select 'core.departments', count(*) from core.departments
union all select 'core.customers',   count(*) from core.customers
union all select 'core.vendors',     count(*) from core.vendors
union all select 'core.items',       count(*) from core.items
union all select 'core.employees',   count(*) from core.employees
union all select 'core.jobs',        count(*) from core.jobs
union all select '— ledger (Books) —', null
union all select 'public.gl_entries (opening + history)', count(*) from public.gl_entries
union all select 'public.invoices (open AR)', count(*) from public.invoices
union all select 'public.bills (open AP)',    count(*) from public.bills;

-- Spot-check that imported ledger rows correctly reference core master data
-- (FK integrity across the schema boundary):
select i.invoice_number, c.name as customer, i.total_cents
from public.invoices i
join core.customers c on c.id = i.customer_id
order by i.created_at desc
limit 10;
