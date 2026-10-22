-- =============================================================================
-- Migration 172: business-table PostgREST write-lock sweep, part 2 — audit evidence
--                first, then the rest of the class-A money / ledger / control tables.
-- =============================================================================
--
-- THE HOLE (same as 171). The tables below carried `org_isolation FOR ALL USING
-- (org_id = get_org_id())` plus INSERT / UPDATE / DELETE granted to anon + authenticated,
-- so ANY signed-in member could call /rest/v1/<table> directly and bypass every route
-- check and the capability model. Worst first:
--   * audit_log / ai_audit_log    a member could rewrite or DELETE audit history;
--   * ai_decisions                forge APPROVED AI decisions, rewrite the evidence a
--                                 decision was made on, delete the exception queue;
--   * invoice_events,
--     vendor_compliance_events    rewrite AR / vendor-compliance event trails;
--   * bank_transactions,
--     bank_reconciliations,
--     vendor_patterns             re-categorize / mark reconciled, or teach the
--                                 auto-approve engine a vendor → account mapping;
--   * debt / leases / fixed assets / prepaid + insurance + intangible schedules,
--     recurring JE templates + runs, posting schedules, rev-rec config + runs,
--     year-end closes, tax provision / book-tax / sales-tax, FX rates, COA structure,
--     dimensions, payroll config, procurement, expenses, job cost   — the inputs every
--     engine posts from.
--
-- THE FIX.
--   §1 Write locks (171 pattern, ORDER-INDEPENDENT): RLS stays on; every PERMISSIVE
--      member write policy becomes a SELECT policy with the SAME read predicate;
--      RESTRICTIVE client-scope policies (163) are untouched; service_all added; INSERT /
--      UPDATE / DELETE / TRUNCATE revoked from anon + authenticated. Every app write now
--      goes through lib/db/scoped-writer.ts (service role, after the route's permission
--      check, org pinned, client scope asserted). The scheduler's session-less tenant
--      client (createOrgScopedSupabase) is registered as a SYSTEM org client so its job
--      writes escalate pinned to its one org.
--   §2 Append-only evidence: audit_log, ai_audit_log, invoice_events and
--      vendor_compliance_events refuse UPDATE / DELETE / TRUNCATE for EVERY role —
--      including the service role — except
--        (a) FK cascades / set-null from a parent row (pg_trigger_depth() > 1: org
--            deletion, an invoice rolled back by a failed create), and
--        (b) a documented retention / tenant-reset job that sets the transaction-local
--            GUC `meritbooks.allow_audit_purge = 'on'` (the reserved reset_tenant_data RPC
--            must set it, exactly like 153's meritbooks.allow_ledger_purge);
--      plus, for ai_audit_log only, the one-time human-response stamp (human_response /
--      human_response_by / human_response_at filled in while human_response is null, no
--      other column changed).
--   §3 ai_decisions — PARTIAL lock. Merit Projects (apps/projects/src/lib/ai/decisions.ts,
--      another session's code) still proposes / approves decisions through the member's
--      RLS client, so member INSERT / UPDATE cannot be revoked yet. Members keep exactly
--      that and nothing more:
--        INSERT  only own org, status PROPOSED, no disposition, no posted GL entry;
--        UPDATE  only own org, only while PROPOSED, and (trigger) only status +
--                disposition_by_user / disposition_at / disposition_note may change —
--                the evidence (input, proposed output, confidence, reasoning, model,
--                tokens, cost, creator, client, created_at, posted entry) is immutable;
--        DELETE / TRUNCATE revoked.
--      Every Books write already goes through the service role. FOLLOW-UP: once Projects
--      writes through a definer RPC / its service path, add ai_decisions to §1.
--
-- NOT LOCKED HERE (reported, see business-write-lock.test.ts MEMBER_WRITABLE):
--   invoices, invoice_lines, internal_invoices, internal_invoice_lines, customer_deposits,
--   customer_deposit_applications — their remaining member write sites are in files the
--   Projects-seam builder owns (lib/invoices/create-invoice.ts, billing-consumer,
--   dept-invoice-consumer, lib/customer-deposits/**); every other write site was moved.
--   Class B (workspace) and class C (shared with Projects / owner decision) unchanged.
--
-- LEDGER CONTROLS UNCHANGED: balance, period lock (152), posted-GL immutability (153),
-- control-account / approved-account / dimension validation and entry numbering are
-- role-independent triggers and fire for service-role writes exactly as before.
--
-- SAFETY: no data change, no GL effect. Idempotent. PGlite-compatible (no subqueries in
-- CHECKs; policies only). Tables absent in an environment are skipped (to_regclass).
-- M1 lesson: every function EXECUTE-revoked from public / anon / authenticated, then
-- granted explicitly to service_role.
-- =============================================================================

-- ── §1: write locks ──────────────────────────────────────────────────────────
do $$
declare
  t record;
  p record;
  v_roles text;
begin
  for t in
    select * from (values
      -- audit evidence
      ('public', 'audit_log'),
      ('public', 'ai_audit_log'),
      ('public', 'invoice_events'),
      ('public', 'vendor_compliance_events'),
      -- receivables (the seam-owned invoice / deposit tables are NOT here — see header)
      ('public', 'credit_memos'),
      ('public', 'credit_memo_lines'),
      ('public', 'recurring_invoice_templates'),
      -- intercompany / ownership
      ('public', 'intercompany_balances'),
      ('public', 'intercompany_loans'),
      ('public', 'intercompany_transactions'),
      ('public', 'entity_ownership'),
      ('public', 'equity_holders'),
      ('core',   'equity_holders'),
      -- banking
      ('public', 'bank_transactions'),
      ('public', 'bank_reconciliations'),
      ('public', 'vendor_patterns'),
      -- debt / leases / assets / schedules
      ('public', 'debt_instruments'),
      ('public', 'debt_schedule_lines'),
      ('public', 'loan_covenants'),
      ('public', 'covenant_measurements'),
      ('public', 'leases'),
      ('public', 'lease_schedule_lines'),
      ('public', 'fixed_assets'),
      ('public', 'depreciation_runs'),
      ('public', 'tax_depreciation_runs'),
      ('public', 'insurance_amortization_schedules'),
      ('public', 'insurance_amortization_runs'),
      ('public', 'posting_schedules'),
      ('public', 'posting_schedule_runs'),
      ('public', 'recurring_je_templates'),
      ('public', 'recurring_je_runs'),
      ('public', 'recurring_templates'),
      ('public', 'year_end_closes'),
      -- revenue recognition
      ('public', 'revenue_recognition_runs'),
      ('public', 'rev_rec_method_map'),
      ('public', 'revenue_type_methods'),
      -- job cost / procurement / expenses
      ('public', 'job_cost_entries'),
      ('public', 'job_cost_attributions'),
      ('public', 'retainage_releases'),
      ('public', 'inventory_items'),
      ('public', 'inventory_movements'),
      ('public', 'purchase_orders'),
      ('public', 'purchase_order_lines'),
      ('public', 'goods_receipts'),
      ('public', 'goods_receipt_lines'),
      ('public', 'bill_po_links'),
      ('public', 'expense_reports'),
      ('public', 'expense_report_lines'),
      ('public', 'receipts'),
      -- tax / basis / FX
      ('public', 'sales_tax_filings'),
      ('public', 'sales_tax_rates'),
      ('public', 'tax_provision'),
      ('public', 'deferred_tax_items'),
      ('public', 'tax_year_params'),
      ('public', 'book_tax_account_tags'),
      ('public', 'book_tax_line_overrides'),
      ('public', 'book_tax_m_lines'),
      ('public', 'reporting_basis_adjustments'),
      ('public', 'fx_rates'),
      -- chart-of-accounts structure + dimensions + posting-role map
      ('public', 'account_types'),
      ('public', 'account_sub_types'),
      ('public', 'account_groups'),
      ('public', 'account_roles'),
      ('public', 'classes'),
      ('core',   'departments'),
      ('public', 'location_classes'),
      ('public', 'location_departments'),
      ('public', 'location_items'),
      -- payroll config
      ('public', 'pay_schedules'),
      ('public', 'payroll_register_mappings'),
      -- close / compliance / policy control evidence
      ('public', 'close_checklists'),
      ('public', 'compliance_filings'),
      ('public', 'compliance_obligations'),
      ('public', 'vendor_compliance_docs'),
      ('public', 'company_policies'),
      ('public', 'expense_policies')
    ) as v(sch, tbl)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 172: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- PERMISSIVE member write policies → SELECT policies with the SAME predicate.
    for p in
      select policyname, cmd, roles, qual
        from pg_policies
       where schemaname = t.sch and tablename = t.tbl
         and permissive = 'PERMISSIVE'
         and cmd <> 'SELECT'
         and roles::text <> '{service_role}'
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
      if p.cmd = 'ALL' and p.qual is not null
         and not exists (select 1 from pg_policies x
                          where x.schemaname = t.sch and x.tablename = t.tbl
                            and x.policyname = p.policyname) then
        v_roles := array_to_string(p.roles, ', ');
        execute format('create policy %I on %I.%I for select to %s using (%s)',
                       p.policyname, t.sch, t.tbl, v_roles, p.qual);
      end if;
    end loop;

    -- A table with no member read policy left still needs one (members keep reading).
    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and cmd in ('SELECT', 'ALL')
                      and permissive = 'PERMISSIVE' and roles::text <> '{service_role}') then
      execute format('create policy member_read on %I.%I for select using (org_id = public.get_org_id())',
                     t.sch, t.tbl);
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and policyname = 'service_all') then
      execute format(
        'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
        t.sch, t.tbl);
    end if;

    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant select, insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- ── §2: append-only evidence (immutable for every role) ──────────────────────
create or replace function public.guard_append_only_evidence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_human constant text[] := array['human_response', 'human_response_by', 'human_response_at'];
begin
  -- (a) FK cascade / set-null from a parent row (org deletion, a rolled-back invoice).
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- (b) documented retention / tenant-reset job (transaction-local GUC, service paths only).
  if coalesce(current_setting('meritbooks.allow_audit_purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- ai_audit_log: the human response may be stamped ONCE, nothing else may change.
  if tg_op = 'UPDATE' and tg_table_name = 'ai_audit_log'
     and (to_jsonb(old) ->> 'human_response') is null
     and (to_jsonb(new) ->> 'human_response') is not null
     and (to_jsonb(new) - v_human) = (to_jsonb(old) - v_human) then
    return new;
  end if;
  raise exception '%.% is append-only audit evidence: % is not allowed (migration 172).',
    tg_table_schema, tg_table_name, tg_op
    using errcode = '42501',
          hint = 'Record a new row instead. Retention / tenant-reset jobs set meritbooks.allow_audit_purge for their transaction.';
end
$$;

create or replace function public.guard_append_only_evidence_truncate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('meritbooks.allow_audit_purge', true), '') = 'on' then
    return null;
  end if;
  raise exception '%.% is append-only audit evidence: TRUNCATE is not allowed (migration 172).',
    tg_table_schema, tg_table_name
    using errcode = '42501';
end
$$;

revoke all on function public.guard_append_only_evidence() from public, anon, authenticated;
grant execute on function public.guard_append_only_evidence() to service_role;
revoke all on function public.guard_append_only_evidence_truncate() from public, anon, authenticated;
grant execute on function public.guard_append_only_evidence_truncate() to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['audit_log', 'ai_audit_log', 'invoice_events', 'vendor_compliance_events'] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('drop trigger if exists trg_append_only_evidence on public.%I', t);
    execute format(
      'create trigger trg_append_only_evidence before update or delete on public.%I
         for each row execute function public.guard_append_only_evidence()', t);
    execute format('drop trigger if exists trg_append_only_evidence_truncate on public.%I', t);
    execute format(
      'create trigger trg_append_only_evidence_truncate before truncate on public.%I
         for each statement execute function public.guard_append_only_evidence_truncate()', t);
  end loop;
end $$;

-- ── §3: ai_decisions — partial lock (Projects still writes through the member client) ──
create or replace function public.guard_ai_decisions_member_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lifecycle constant text[] := array['status', 'disposition_by_user', 'disposition_at', 'disposition_note'];
begin
  -- SECURITY INVOKER on purpose: current_user is the role that issued the statement.
  -- Service role / owner / definer paths (every Books write) are not restricted here.
  if current_user not in ('authenticated', 'anon') or pg_trigger_depth() > 1 then
    return new;
  end if;
  if old.status <> 'PROPOSED' then
    raise exception 'ai_decisions: a % decision is final (migration 172).', old.status
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_lifecycle) is distinct from (to_jsonb(old) - v_lifecycle) then
    raise exception 'ai_decisions: members may only change a decision''s status and disposition — the evidence is immutable (migration 172).'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.guard_ai_decisions_member_update() from public, anon, authenticated;
grant execute on function public.guard_ai_decisions_member_update() to service_role;

do $$
declare
  p record;
  v_roles text;
begin
  if to_regclass('public.ai_decisions') is null then
    raise notice 'migration 172: public.ai_decisions not present, skipped';
    return;
  end if;
  alter table public.ai_decisions enable row level security;

  -- Member write policies other than the two below → SELECT with the same predicate.
  for p in
    select policyname, cmd, roles, qual
      from pg_policies
     where schemaname = 'public' and tablename = 'ai_decisions'
       and permissive = 'PERMISSIVE'
       and cmd <> 'SELECT'
       and roles::text <> '{service_role}'
       and policyname not in ('member_propose', 'member_disposition')
  loop
    execute format('drop policy if exists %I on public.ai_decisions', p.policyname);
    if p.cmd = 'ALL' and p.qual is not null then
      v_roles := array_to_string(p.roles, ', ');
      execute format('create policy %I on public.ai_decisions for select to %s using (%s)',
                     p.policyname, v_roles, p.qual);
    end if;
  end loop;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'ai_decisions' and cmd in ('SELECT', 'ALL')
                    and permissive = 'PERMISSIVE' and roles::text <> '{service_role}') then
    create policy member_read on public.ai_decisions for select using (org_id = public.get_org_id());
  end if;

  drop policy if exists member_propose on public.ai_decisions;
  create policy member_propose on public.ai_decisions for insert to authenticated
    with check (org_id = public.get_org_id()
                -- Books' own decisions (control exceptions, proposals) are written by the
                -- server only; members may only create Projects-owned AI proposals.
                and feature like 'PROJECTS\_%'
                and status = 'PROPOSED'
                and disposition_by_user is null
                and disposition_at is null
                and posted_gl_entry_id is null);

  drop policy if exists member_disposition on public.ai_decisions;
  create policy member_disposition on public.ai_decisions for update to authenticated
    using (org_id = public.get_org_id() and status = 'PROPOSED' and feature like 'PROJECTS\_%')
    with check (org_id = public.get_org_id() and feature like 'PROJECTS\_%');

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'ai_decisions' and policyname = 'service_all') then
    create policy service_all on public.ai_decisions for all to service_role using (true) with check (true);
  end if;

  drop trigger if exists trg_ai_decisions_member_update on public.ai_decisions;
  create trigger trg_ai_decisions_member_update before update on public.ai_decisions
    for each row execute function public.guard_ai_decisions_member_update();

  revoke delete, truncate on table public.ai_decisions from anon, authenticated;
  revoke insert, update on table public.ai_decisions from anon;
  grant select, insert, update on table public.ai_decisions to authenticated;
  grant select, insert, update, delete on table public.ai_decisions to service_role;
end $$;

-- End migration 172.

-- Re-apply client-scope RLS (163) so the policies above compose with it (the RESTRICTIVE
-- client_scope_rls policies are untouched here; the re-apply keeps this order-independent).
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
