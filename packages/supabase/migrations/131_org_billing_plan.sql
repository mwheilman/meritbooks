-- Migration 131 — subscription billing MODEL (computation/display only; no live charging).
-- Adds an org's plan + optional negotiated custom monthly amount so the Operator Console
-- can compute list-price MRR and each tenant can see its own plan/cost. Additive + idempotent.
-- No live billing/charging is wired here — this is a deterministic pricing model only.

alter table core.organizations
  add column if not exists billing_plan text not null default 'direct';

alter table core.organizations
  add column if not exists custom_mrr_cents bigint null;

-- Constrain the plan vocabulary (idempotent: drop-if-exists then add).
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_schema = 'core'
      and table_name = 'organizations'
      and constraint_name = 'organizations_billing_plan_check'
  ) then
    alter table core.organizations drop constraint organizations_billing_plan_check;
  end if;
end $$;

alter table core.organizations
  add constraint organizations_billing_plan_check
  check (billing_plan in ('direct', 'firm', 'enterprise'));

comment on column core.organizations.billing_plan is
  'Subscription pricing model: direct ($99/co first 5, $59 thereafter), firm ($499 platform + tiered wholesale per client entity), or enterprise (custom). Computation/display only — no live charging is wired to this column.';
comment on column core.organizations.custom_mrr_cents is
  'Optional negotiated monthly amount in integer cents (enterprise plan). When null, enterprise falls back to the direct formula.';
