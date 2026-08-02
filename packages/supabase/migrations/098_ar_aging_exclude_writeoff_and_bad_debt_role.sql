-- =============================================================================
-- Migration 098: Invoices→Complete — AR-aging excludes WRITTEN_OFF + BAD_DEBT role
-- =============================================================================
-- Two deltas that let Invoices reach its FPB bar:
--  (a) v_ar_aging now excludes WRITTEN_OFF invoices (was only PAID/VOIDED/DRAFT).
--      Reproduced from the LIVE view definition (joins core.customers/core.locations,
--      security_invoker per migration 068) with WRITTEN_OFF added to the exclusion.
--  (b) BAD_DEBT_EXPENSE account role registered in the controlled vocabulary +
--      account 6670 created (free OPEX "Office & Administrative" slot) + role map
--      re-seeded, so invoice write-offs resolve the expense account BY ROLE
--      (lib/invoices/write-off-posting.ts) instead of a hardcoded number.
-- Additive + idempotent. Books band; next number: 099.
-- =============================================================================

create or replace view public.v_ar_aging as
 SELECT inv.org_id,
    inv.location_id,
    loc.name AS location_name,
    inv.customer_id,
    c.name AS customer_name,
    inv.id AS invoice_id,
    inv.invoice_number,
    inv.invoice_date,
    inv.due_date,
    inv.total_cents,
    inv.amount_paid_cents,
    inv.balance_cents,
        CASE
            WHEN (CURRENT_DATE - inv.due_date) <= 0 THEN 'CURRENT'::text
            WHEN (CURRENT_DATE - inv.due_date) >= 1 AND (CURRENT_DATE - inv.due_date) <= 30 THEN '1-30'::text
            WHEN (CURRENT_DATE - inv.due_date) >= 31 AND (CURRENT_DATE - inv.due_date) <= 60 THEN '31-60'::text
            WHEN (CURRENT_DATE - inv.due_date) >= 61 AND (CURRENT_DATE - inv.due_date) <= 90 THEN '61-90'::text
            ELSE '90+'::text
        END AS aging_bucket
   FROM invoices inv
     JOIN core.customers c ON c.id = inv.customer_id
     JOIN core.locations loc ON loc.id = inv.location_id
  WHERE inv.status <> ALL (ARRAY['PAID'::text, 'VOIDED'::text, 'DRAFT'::text, 'WRITTEN_OFF'::text]);
alter view public.v_ar_aging set (security_invoker = true);

insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('BAD_DEBT_EXPENSE', 'Bad debt expense (AR write-off)', 'ORG', '6670')
on conflict (role_key) do update
  set label = excluded.label, scope = excluded.scope,
      default_account_number = excluded.default_account_number;

insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status, display_order)
select a.org_id, a.account_group_id, '6670', 'Bad Debt Expense', 'OPEX', 'OPERATING_EXPENSE', true, 'APPROVED', 8
from public.accounts a where a.account_number = '6660'
  and not exists (select 1 from public.accounts x where x.org_id = a.org_id and x.account_number = '6670');

do $$ declare o record; begin
  for o in select id from core.organizations loop perform public.seed_account_roles(o.id); end loop;
end $$;
