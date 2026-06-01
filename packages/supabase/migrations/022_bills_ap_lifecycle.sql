-- Migration 022: Bills AP lifecycle + approver routing (Session 18 — AP correction)
-- =============================================================
-- Folds cost-approval into the bill (Session 17 Section 3 decision). The bill now
-- owns the full AP lifecycle: PENDING -> APPROVED -> SCHEDULED -> PARTIALLY_PAID/PAID,
-- carries the routed approver, and stores the scheduled payment date + payment record.
--
-- The standalone "Cost Approvals" tab is retired; its plumbing (cost_approval_rules,
-- job_cost_attributions, core.events) is reused — triggered from Bills and from
-- bank-feed / credit-card categorization instead of its own page.
--
-- Idempotent. Safe to re-run. Requires migration 005 (bills) + 021 (seam).
-- =============================================================

-- ---- Guard: confirm bills + seam exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'bills') then
    raise exception 'public.bills not found — deploy migration 005 before 022.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cost_approval_rules') then
    raise exception 'cost_approval_rules not found — deploy migration 021 before 022.';
  end if;
end $$;

-- =============================================================
-- 1. Add SCHEDULED to the bills status check
-- =============================================================
do $$
declare
  conname text;
begin
  -- Drop whatever the current status check constraint is named, then re-add with SCHEDULED.
  select c.conname into conname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'bills'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%in%';

  if conname is not null then
    execute format('alter table public.bills drop constraint %I', conname);
  end if;

  alter table public.bills
    add constraint bills_status_check
    check (status in ('PENDING','APPROVED','SCHEDULED','PARTIALLY_PAID','PAID','VOIDED','ON_HOLD'));
end $$;

-- =============================================================
-- 2. Approver routing + scheduling + payment columns on the bill
-- =============================================================
alter table public.bills
  add column if not exists approver_type text
    check (approver_type in ('ACCOUNTING','RESPONSIBLE_PARTY','PM_LEADER')),
  add column if not exists approver_ref text,            -- employee/clerk id when routed to a person
  add column if not exists approved_by_user text,        -- Clerk user id of who approved (text; approved_by stays uuid/legacy)
  add column if not exists scheduled_payment_date date,
  add column if not exists payment_method text,
  add column if not exists paid_at timestamptz,
  add column if not exists void_reason text;

-- Open-status index for the Bills queue (PENDING / APPROVED / SCHEDULED / ON_HOLD / PARTIALLY_PAID)
create index if not exists idx_bills_status_due on public.bills(org_id, status, due_date);

-- =============================================================
-- 3. Link an attribution back to its originating bill (reporting + clearing)
-- =============================================================
alter table public.job_cost_attributions
  add column if not exists bill_id uuid references public.bills(id);
create index if not exists idx_attr_bill on public.job_cost_attributions(bill_id);
