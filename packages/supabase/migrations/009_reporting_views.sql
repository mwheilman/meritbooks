-- Migration 009: Financial Reporting Views
-- Computed from gl_entry_lines. These are the statements.

-- =============================================================
-- TRIAL BALANCE VIEW
-- Net balance per account for a given period range.
-- =============================================================

create or replace view v_trial_balance as
select
  l.org_id,
  l.location_id,
  loc.name as location_name,
  l.account_id,
  a.account_number,
  a.name as account_name,
  a.account_type,
  a.account_sub_type,
  ag.name as account_group_name,
  at2.display_order as type_order,
  ast.display_order as sub_type_order,
  ag.display_order as group_order,
  a.display_order as account_order,
  sum(l.debit_cents) as total_debits,
  sum(l.credit_cents) as total_credits,
  case
    when at2.normal_balance = 'DEBIT' then sum(l.debit_cents) - sum(l.credit_cents)
    else sum(l.credit_cents) - sum(l.debit_cents)
  end as net_balance
from gl_entry_lines l
join gl_entries e on e.id = l.gl_entry_id
join accounts a on a.id = l.account_id
join account_groups ag on ag.id = a.account_group_id
join account_sub_types ast on ast.id = ag.account_sub_type_id
join account_types at2 on at2.id = ast.account_type_id
join locations loc on loc.id = l.location_id
where e.status = 'POSTED'
group by
  l.org_id, l.location_id, loc.name,
  l.account_id, a.account_number, a.name,
  a.account_type, a.account_sub_type,
  ag.name, at2.display_order, ast.display_order,
  ag.display_order, a.display_order, at2.normal_balance;

-- =============================================================
-- INCOME STATEMENT VIEW
-- Revenue - COGS = Gross Profit - OpEx = EBITDA - Other = Net Income
-- =============================================================

create or replace view v_income_statement as
select
  l.org_id,
  l.location_id,
  loc.name as location_name,
  a.account_type,
  ast.name as sub_type_name,
  ag.name as group_name,
  a.account_number,
  a.name as account_name,
  at2.display_order as type_order,
  ast.display_order as sub_type_order,
  ag.display_order as group_order,
  a.display_order as account_order,
  e.entry_date,
  extract(year from e.entry_date)::int as fiscal_year,
  extract(month from e.entry_date)::int as fiscal_month,
  case
    when a.account_type = 'REVENUE' then sum(l.credit_cents) - sum(l.debit_cents)
    else sum(l.debit_cents) - sum(l.credit_cents) -- COGS, OPEX, OTHER are debit-normal
  end as amount_cents
from gl_entry_lines l
join gl_entries e on e.id = l.gl_entry_id
join accounts a on a.id = l.account_id
join account_groups ag on ag.id = a.account_group_id
join account_sub_types ast on ast.id = ag.account_sub_type_id
join account_types at2 on at2.id = ast.account_type_id
join locations loc on loc.id = l.location_id
where e.status = 'POSTED'
  and a.account_type in ('REVENUE', 'COGS', 'OPEX', 'OTHER')
group by
  l.org_id, l.location_id, loc.name,
  a.account_type, ast.name, ag.name,
  a.account_number, a.name,
  at2.display_order, ast.display_order, ag.display_order, a.display_order,
  e.entry_date;

-- =============================================================
-- BALANCE SHEET VIEW
-- Assets = Liabilities + Equity (at a point in time)
-- =============================================================

create or replace view v_balance_sheet as
select
  l.org_id,
  l.location_id,
  loc.name as location_name,
  a.account_type,
  ast.name as sub_type_name,
  ag.name as group_name,
  a.account_number,
  a.name as account_name,
  at2.display_order as type_order,
  ast.display_order as sub_type_order,
  ag.display_order as group_order,
  a.display_order as account_order,
  case
    when at2.normal_balance = 'DEBIT' then sum(l.debit_cents) - sum(l.credit_cents)
    else sum(l.credit_cents) - sum(l.debit_cents)
  end as balance_cents
from gl_entry_lines l
join gl_entries e on e.id = l.gl_entry_id
join accounts a on a.id = l.account_id
join account_groups ag on ag.id = a.account_group_id
join account_sub_types ast on ast.id = ag.account_sub_type_id
join account_types at2 on at2.id = ast.account_type_id
join locations loc on loc.id = l.location_id
where e.status = 'POSTED'
  and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
group by
  l.org_id, l.location_id, loc.name,
  a.account_type, ast.name, ag.name,
  a.account_number, a.name,
  at2.display_order, ast.display_order, ag.display_order, a.display_order,
  at2.normal_balance;

-- =============================================================
-- GL DETAIL VIEW (drill-down to individual lines)
-- =============================================================

create or replace view v_gl_detail as
select
  l.org_id,
  e.entry_number,
  e.entry_date,
  e.entry_type,
  e.memo as entry_memo,
  e.source_module,
  e.status as entry_status,
  l.line_number,
  a.account_number,
  a.name as account_name,
  a.account_type,
  l.debit_cents,
  l.credit_cents,
  l.memo as line_memo,
  loc.name as location_name,
  loc.short_code as location_code,
  d.name as department_name,
  c.name as class_name,
  i.name as item_name,
  e.created_by,
  e.posted_by,
  e.posted_at,
  l.created_at as line_created_at
from gl_entry_lines l
join gl_entries e on e.id = l.gl_entry_id
join accounts a on a.id = l.account_id
join locations loc on loc.id = l.location_id
left join departments d on d.id = l.department_id
left join classes c on c.id = l.class_id
left join items i on i.id = l.item_id;

-- =============================================================
-- JOURNAL ENTRY AUDIT VIEW (field-level change history)
-- =============================================================

create or replace view v_journal_entry_audit as
select
  al.org_id,
  al.record_id as gl_entry_id,
  e.entry_number,
  al.action,
  al.field_name,
  al.old_value,
  al.new_value,
  al.user_id,
  al.ip_address,
  al.created_at as changed_at
from audit_log al
join gl_entries e on e.id = al.record_id
where al.table_name = 'gl_entries'
order by al.created_at desc;

-- =============================================================
-- AP AGING VIEW
-- =============================================================

create or replace view v_ap_aging as
select
  b.org_id,
  b.location_id,
  loc.name as location_name,
  b.vendor_id,
  v.name as vendor_name,
  b.id as bill_id,
  b.bill_number,
  b.bill_date,
  b.due_date,
  b.total_cents,
  b.amount_paid_cents,
  b.balance_cents,
  case
    when current_date - b.due_date <= 0 then 'CURRENT'
    when current_date - b.due_date between 1 and 30 then '1-30'
    when current_date - b.due_date between 31 and 60 then '31-60'
    when current_date - b.due_date between 61 and 90 then '61-90'
    else '90+'
  end as aging_bucket
from bills b
join vendors v on v.id = b.vendor_id
join locations loc on loc.id = b.location_id
where b.status not in ('PAID', 'VOIDED');

-- =============================================================
-- AR AGING VIEW
-- =============================================================

create or replace view v_ar_aging as
select
  inv.org_id,
  inv.location_id,
  loc.name as location_name,
  inv.customer_id,
  c.name as customer_name,
  inv.id as invoice_id,
  inv.invoice_number,
  inv.invoice_date,
  inv.due_date,
  inv.total_cents,
  inv.amount_paid_cents,
  inv.balance_cents,
  case
    when current_date - inv.due_date <= 0 then 'CURRENT'
    when current_date - inv.due_date between 1 and 30 then '1-30'
    when current_date - inv.due_date between 31 and 60 then '31-60'
    when current_date - inv.due_date between 61 and 90 then '61-90'
    else '90+'
  end as aging_bucket
from invoices inv
join customers c on c.id = inv.customer_id
join locations loc on loc.id = inv.location_id
where inv.status not in ('PAID', 'VOIDED', 'DRAFT');

-- =============================================================
-- CASH POSITION VIEW
-- =============================================================

create or replace view v_cash_position as
select
  ba.org_id,
  ba.location_id,
  loc.name as location_name,
  ba.id as bank_account_id,
  ba.institution_name,
  ba.account_name,
  ba.account_mask,
  ba.account_type,
  ba.current_balance_cents,
  ba.available_balance_cents,
  ba.balance_updated_at,
  loc.minimum_cash_cents,
  case
    when ba.current_balance_cents >= loc.minimum_cash_cents * 2 then 'HEALTHY'
    when ba.current_balance_cents >= loc.minimum_cash_cents then 'ADEQUATE'
    when ba.current_balance_cents >= loc.minimum_cash_cents * 0.5 then 'NEAR_MINIMUM'
    else 'CRITICAL'
  end as cash_status
from bank_accounts ba
join locations loc on loc.id = ba.location_id
where ba.is_active = true;

-- =============================================================
-- JOB PROFITABILITY VIEW
-- =============================================================

create or replace view v_job_profitability as
select
  j.org_id,
  j.location_id,
  loc.name as location_name,
  j.id as job_id,
  j.job_number,
  j.name as job_name,
  j.status,
  j.contract_amount_cents,
  j.estimated_cost_cents,
  j.actual_cost_cents,
  j.billed_to_date_cents,
  j.revenue_recognized_cents,
  j.contract_amount_cents - j.actual_cost_cents as estimated_profit_cents,
  case
    when j.contract_amount_cents > 0
    then round(((j.contract_amount_cents - j.actual_cost_cents)::numeric / j.contract_amount_cents) * 100, 2)
    else 0
  end as profit_margin_pct,
  j.pct_complete,
  case
    when j.estimated_cost_cents > 0
    then round((j.actual_cost_cents::numeric / j.estimated_cost_cents) * 100, 2)
    else 0
  end as cost_pct_of_budget
from jobs j
join locations loc on loc.id = j.location_id;
