-- =============================================================================
-- Migration 171: business-table PostgREST write-lock sweep (wave 2H) — money,
--                ledger and control tables become SELECT-only for members.
-- =============================================================================
--
-- THE HOLE. Every API route checks permissions, but the tables below carried
--     org_isolation FOR ALL USING (org_id = get_org_id())
-- (or an equivalent permissive ALL policy) plus INSERT / UPDATE / DELETE granted to
-- anon + authenticated. PostgREST accepts a member's Clerk token (role=authenticated,
-- org_id=<tenant>), so ANY signed-in member could call /rest/v1/<table> directly and
-- bypass every route check and the capability model (05 / 164), e.g.:
--   * gl_entries / gl_entry_lines   post, edit or void journal entries with no
--                                   journal_entries:post (the balance / period-lock /
--                                   posted-immutability triggers still applied, but
--                                   WHO may post did not);
--   * fiscal_periods                reopen a hard-closed period (status = 'OPEN');
--   * bills / bill_lines /
--     bill_payments                 approve-by-update, rewrite amounts after approval,
--                                   forge payments;
--   * bank_accounts, plaid_items,
--     plaid_pending_accounts        re-map a feed account, rewrite sync cursors;
--   * payment_origination_*,
--     disbursement_*                forge / re-status ACH batches and items;
--   * vendor_payment_profiles       rewrite masked bank details AND `captured_by`,
--                                   which defeats the bank-change rule (the capturer
--                                   may not release payments to that vendor);
--   * ach_authorizations,
--     vendor_payment_holds          forge an ACH authorization, grant yourself a
--                                   compliance override and pay a non-compliant vendor;
--   * vendor_portal_tokens,
--     customer_portal_tokens        mint bearer magic links for any vendor / customer;
--   * customer_payments,
--     payment_applications          forge AR receipts;
--   * public.accounts               create / approve GL accounts (chart of accounts);
--   * core.items                    rewrite item income / COGS account mapping;
--   * core.provider_connections     re-point a tenant's payment / bank provider
--                                   connection (secret_ref) at another credential.
--
-- THE FIX (154 / 167 / 168 pattern, ORDER-INDEPENDENT):
--   1. RLS stays ENABLED.
--   2. Every PERMISSIVE member-facing write policy is converted to a SELECT policy with
--      the SAME read predicate (a client-scope predicate a sibling migration installs is
--      preserved verbatim); RESTRICTIVE policies (163 client scope) never grant anything
--      and are left exactly as they are; a table left with no member read policy gets
--      member_read (org_id = get_org_id()).
--   3. service_all FOR ALL TO service_role is added where missing.
--   4. INSERT / UPDATE / DELETE / TRUNCATE are REVOKED from anon + authenticated, so a
--      future permissive policy cannot re-open writes without an explicit GRANT
--      (src/test/business-write-lock.test.ts fails the build on that drift, and on any
--      NEW table that is member-writable without a recorded reason).
-- Every app write to these tables now goes through the service-role client
-- (lib/db/scoped-writer.ts) AFTER the route's permission check, with org_id pinned to
-- the session org and — because the service role bypasses 163's RESTRICTIVE client-scope
-- policy — the target client asserted in the caller's scope (assertWriteScope).
--
-- LEDGER CONTROLS UNCHANGED. check_journal_balance, the period lock (152), posted-GL
-- immutability (153), control-account / approved-account / dimension validation and
-- entry numbering are role-independent triggers: they fire for service-role writes
-- exactly as they did for member writes (the only bypass is purge_org_ledger's
-- transaction-local GUC, service_role only, unchanged).
--
-- §2 Grant-only hardening: tables whose policies were ALREADY read-only / service-only
-- for members but still carried member write GRANTs (no behaviour change — RLS already
-- refused those writes; this removes the latent foot-gun).
--
-- SAFETY: no data change, no GL effect, no new function. Idempotent. PGlite-compatible.
-- Tables absent in an environment are skipped (to_regclass guard).
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
      -- general ledger + periods
      ('public', 'gl_entries'),
      ('public', 'gl_entry_lines'),
      ('public', 'fiscal_periods'),
      ('public', 'accounts'),
      -- payables
      ('public', 'bills'),
      ('public', 'bill_lines'),
      ('public', 'bill_payments'),
      -- banking
      ('public', 'bank_accounts'),
      ('public', 'plaid_items'),
      ('public', 'plaid_pending_accounts'),
      -- money movement
      ('public', 'payment_origination_batches'),
      ('public', 'payment_origination_items'),
      ('public', 'disbursement_batches'),
      ('public', 'disbursement_batch_items'),
      ('public', 'disbursement_check_numbers'),
      ('public', 'vendor_payment_profiles'),
      ('public', 'ach_authorizations'),
      ('public', 'vendor_payment_holds'),
      -- receivables
      ('public', 'customer_payments'),
      ('public', 'payment_applications'),
      -- bearer-link issuance
      ('public', 'vendor_portal_tokens'),
      ('public', 'customer_portal_tokens'),
      -- master data / provider credentials
      ('core',   'items'),
      ('core',   'provider_connections')
    ) as v(sch, tbl)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 171: %.% not present, skipped', t.sch, t.tbl;
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

-- ── §2: grant-only hardening (member policies already read-only / service-only) ──
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('core',   'account_role_keys'),
      ('core',   'ai_feature_caps'),
      ('core',   'ai_model_prices'),
      ('core',   'ai_tier_config'),
      ('core',   'transaction_types'),
      ('core',   'erp_connections'),
      ('core',   'merchant_fee_schedules'),
      ('public', 'app_error_log'),
      ('public', 'stripe_events')
    ) as v(sch, tbl)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      continue;
    end if;
    -- Only when no member-facing write policy exists (otherwise the table belongs in §1).
    if exists (select 1 from pg_policies
                where schemaname = t.sch and tablename = t.tbl
                  and permissive = 'PERMISSIVE' and cmd <> 'SELECT'
                  and roles::text <> '{service_role}') then
      raise notice 'migration 171: %.% has a member write policy; grant-only hardening skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);
    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant select, insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- End migration 171.

-- Wave-2 integration: re-apply client-scope RLS (163) so the policies above compose
-- with it (the RESTRICTIVE client_scope_rls policies are untouched by §1, but the
-- re-apply keeps this migration order-independent with 163).
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
