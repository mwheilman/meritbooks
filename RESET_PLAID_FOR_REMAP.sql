-- ============================================================================
-- RESET_PLAID_FOR_REMAP.sql  (Session 25)
-- Run ONCE in the Supabase SQL editor BEFORE a clean Plaid reconnect.
--
-- WHAT IT DOES (idempotent, transactional, tenant-scoped):
--   Clears the Plaid bank-feed state so you can connect ONE time cleanly:
--     - unposted Plaid-sourced bank transactions   (posted ones are PRESERVED)
--     - staged pending accounts
--     - Plaid-sourced bank accounts with no remaining transactions
--     - Plaid items
--     - BANK_FEED / plaid provider connections
--
-- WHAT IT WILL NOT TOUCH:
--   - Any bank_transaction that has already been POSTED to the GL
--     (gl_entry_id is not null) — those are real ledger entries.
--   - If posted Plaid transactions exist, the run ABORTS with a notice so you
--     never destroy booked history. Un-post / void them first if you truly want
--     a full wipe.
--   - Vault secret rows are left in place (harmless orphans; cheap to ignore).
--
-- SAFE TO RE-RUN. Resolves the active org exactly as the app does.
-- ============================================================================

do $$
declare
  v_org uuid;
  v_posted int;
  v_txn int;
  v_pending int;
  v_acct int;
  v_items int;
  v_conn int;
begin
  select id into v_org from core.organizations order by created_at limit 1;
  if v_org is null then
    raise exception 'No organization found — nothing to reset.';
  end if;

  -- Guard: refuse to run if Plaid transactions have already been posted.
  select count(*) into v_posted
  from bank_transactions
  where org_id = v_org
    and plaid_transaction_id is not null
    and gl_entry_id is not null;

  if v_posted > 0 then
    raise exception
      'Abort: % posted Plaid transaction(s) exist for this org. Void/un-post them before a full reset.', v_posted;
  end if;

  -- 1) Delete unposted Plaid-sourced transactions.
  delete from bank_transactions
  where org_id = v_org
    and plaid_transaction_id is not null
    and gl_entry_id is null;
  get diagnostics v_txn = row_count;

  -- 2) Delete staged pending accounts.
  delete from plaid_pending_accounts where org_id = v_org;
  get diagnostics v_pending = row_count;

  -- 3) Delete Plaid bank accounts that now have zero remaining transactions.
  delete from bank_accounts ba
  where ba.org_id = v_org
    and ba.plaid_account_id is not null
    and not exists (
      select 1 from bank_transactions bt
      where bt.bank_account_id = ba.id
    );
  get diagnostics v_acct = row_count;

  -- 4) Delete Plaid items.
  delete from plaid_items where org_id = v_org;
  get diagnostics v_items = row_count;

  -- 5) Delete BANK_FEED / plaid provider connections.
  delete from core.provider_connections
  where org_id = v_org
    and capability = 'BANK_FEED'
    and provider = 'plaid';
  get diagnostics v_conn = row_count;

  raise notice 'Plaid reset complete for org %: % txns, % pending, % accounts, % items, % connections removed.',
    v_org, v_txn, v_pending, v_acct, v_items, v_conn;
end $$;
