-- Migration 153: Posted-GL immutability against direct PostgREST writes
-- =============================================================
-- THE GAP (security HIGH). `authenticated` holds full DML on public.gl_entries /
-- public.gl_entry_lines under the `org_isolation` FOR ALL policy (004). RLS only
-- scopes rows to the caller's org; it does not stop a member, calling PostgREST
-- directly with their Clerk session token, from:
--   (a) DELETE-ing a POSTED journal-entry header — its lines CASCADE away, and
--       152's line guard can't see the (already deleted) parent, so the entry
--       vanishes from the book of record, closed period or not;
--   (b) UPDATE-ing a POSTED entry's status away from POSTED (→ PENDING/DRAFT…)
--       — the entry silently drops out of every POSTED-only report, even inside
--       a HARD_CLOSE period, and its lines become editable (152 only freezes the
--       lines of a POSTED parent), after which it can be flipped back;
--   (c) INSERT-ing extra lines into an existing POSTED entry (152's line guard
--       was BEFORE UPDATE OR DELETE only) — e.g. a balanced DR/CR pair that moves
--       money between accounts inside a hard-closed month.
--
-- HOW THE APP POSTS (verified before writing this — every path, not just one):
--   postJournalEntry (lib/services/gl-posting.ts), POST /api/journal-entries,
--   bookInternalInvoice (lib/services/internal-invoices.ts) and the TB / GL-history
--   importers (api/import) all INSERT the header with status = 'POSTED' in ONE
--   PostgREST request and INSERT its lines in a SECOND request — i.e. two separate
--   transactions. On a line failure they DELETE the (line-less) POSTED header.
--   So:
--     * a blanket "no line INSERT under a POSTED parent" guard would break ALL
--       posting, and so would "parent created in an earlier transaction"
--       (`created_at < now()`): the header is ALWAYS from an earlier transaction.
--     * a blanket "no DELETE of a POSTED header" would break every rollback.
--   The rules below are therefore keyed on whether the entry already has lines
--   COMMITTED BY ANOTHER TRANSACTION, detected with the system column `xmin`
--   (the inserting transaction id — unforgeable, unlike created_at):
--
-- WHAT THIS DOES (additive, idempotent):
--   (1) guard_posted_gl_header_delete() — BEFORE DELETE on gl_entries:
--         a POSTED header that HAS LINES cannot be deleted. A POSTED header with
--         zero lines (the app's failed-post rollback: the line INSERT failed and
--         rolled back) has no ledger effect and may still be deleted. Org
--         teardown / sandbox reset / tenant reset must opt out for ONE
--         transaction with
--             set local meritbooks.allow_ledger_purge = 'on';
--         (the same 152 GUC; a transaction-local GUC can't be set through
--         PostgREST, so only server-side SQL — a SECURITY DEFINER RPC, a
--         migration, psql — can use it). See purge_org_ledger() below.
--   (2) enforce_period_lock() (152, copied verbatim) gains rule 3 — status
--       transitions OUT of POSTED / VOIDED:
--         * POSTED → VOIDED is the app's void flow (voidJournalEntry). Allowed in
--           OPEN / SOFT_CLOSE periods; REJECTED when the entry's period is
--           HARD_CLOSE (the app already refuses this; the DB now does too).
--         * POSTED → anything else (un-posting) is always rejected — corrections
--           go through void / reversal, never "un-post, edit lines, re-post".
--         * VOIDED → anything is rejected (void is terminal; otherwise
--           void → edit lines → un-void would launder a line edit).
--   (3) guard_posted_gl_lines() (152) now also fires BEFORE INSERT. A line INSERT
--       under a POSTED parent is rejected when
--         a. the parent's period is HARD_CLOSE (by fiscal_period_id, or any
--            period for the org+location covering entry_date), or
--         b. the parent already has a line committed by ANOTHER transaction
--            (some existing line's xmin <> this transaction's xid) — the entry's
--            line set was sealed when that transaction committed, or
--         c. the parent header has no lines yet but is stale (created more than
--            10 minutes before this transaction started) — an orphaned header
--            from a failed post can't be filled in later.
--       Normal posting (header in txn 1, ALL lines in one statement in txn 2,
--       milliseconds later) passes every rule. Multiple line statements inside ONE
--       transaction (server-side SQL) also pass.
--       Known limit: (b) is keyed on xmin, so a single transaction that first
--       UPDATEs every existing line (re-stamping its xmin) and then INSERTs could
--       pass (b). That needs a multi-statement transaction, which PostgREST — the
--       surface this closes — cannot issue; (a) still applies regardless.
--   (4) purge_org_ledger(p_org_id) — SECURITY DEFINER, service_role ONLY: sets
--       the purge GUC for its own transaction and deletes the org's GL (lines
--       cascade). Used by the sandbox reset (lib/services/sandbox.ts). The
--       tenant-reset RPC (reset_tenant_data, not yet installed) must also
--       `set local meritbooks.allow_ledger_purge = 'on'` before deleting.
--   (5) REVOKE EXECUTE on the trigger functions (and the purge RPC) from PUBLIC,
--       anon, authenticated. Trigger firing does not check EXECUTE (verified), so
--       this only removes direct-call surface.
--
-- NOT DONE HERE (follow-up): revoking table DML on gl_entries / gl_entry_lines
-- from `authenticated`. Server routes still write the GL through the RLS client
-- (journal-entries, import, reconciliation adjustment, postJournalEntry callers)
-- as `authenticated`, so that revoke must follow moving those writes behind a
-- definer RPC / the admin client.
--
-- All functions are SECURITY DEFINER with a pinned search_path so lookups see
-- the real rows regardless of the writer's RLS visibility.
--
-- Requires 152. Next: 154.
-- =============================================================

-- -------------------------------------------------------------
-- (1) A POSTED header with lines cannot be deleted
-- -------------------------------------------------------------
create or replace function public.guard_posted_gl_header_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    return old;
  end if;

  if old.status::text = 'POSTED'
     and exists (select 1 from public.gl_entry_lines l where l.gl_entry_id = old.id) then
    raise exception 'Cannot delete posted journal entry % (%). Posted entries are immutable — void or reverse the entry instead.',
      old.entry_number, old.id
      using errcode = 'P0001',
            hint = 'Only a POSTED entry with no lines (a failed post being rolled back) may be deleted.';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_guard_posted_gl_header_delete on public.gl_entries;
create trigger trg_guard_posted_gl_header_delete
  before delete on public.gl_entries
  for each row execute function public.guard_posted_gl_header_delete();

-- -------------------------------------------------------------
-- (2) Period lock (152, verbatim) + rule 3: no un-posting, void only when open
-- -------------------------------------------------------------
create or replace function public.enforce_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref_status   text;
  v_hard_id      uuid;
  v_hard_label   text;
  v_check_new    boolean := false;
  v_old_hard     text;
  v_old_cover    uuid;
begin
  -- 1. Is the row (being) POSTED in a way that touches a period?
  if new.status::text = 'POSTED' then
    if tg_op = 'INSERT' then
      v_check_new := true;
    elsif old.status::text is distinct from 'POSTED' then
      v_check_new := true;                         -- status transition -> POSTED
    elsif new.fiscal_period_id is distinct from old.fiscal_period_id
       or new.entry_date      is distinct from old.entry_date
       or new.location_id     is distinct from old.location_id then
      v_check_new := true;                         -- re-dating a posted entry
    end if;
  end if;

  if v_check_new then
    -- 1a. The referenced period (what 004 checked).
    select status::text into v_ref_status
      from public.fiscal_periods where id = new.fiscal_period_id;

    if v_ref_status = 'HARD_CLOSE' then
      raise exception 'Cannot post to hard-closed period % (entry dated %). Reopen the period with a reason, or post a correcting entry in an open period.',
        new.fiscal_period_id, new.entry_date
        using errcode = 'P0001',
              hint = 'HARD_CLOSE periods reject new postings; OPEN and SOFT_CLOSE accept them.';
    end if;

    -- 1b. Any period for this org + location that covers the entry date.
    select fp.id, fp.period_year || '-' || lpad(fp.period_month::text, 2, '0')
      into v_hard_id, v_hard_label
      from public.fiscal_periods fp
     where fp.org_id = new.org_id
       and fp.location_id = new.location_id
       and new.entry_date between fp.start_date and fp.end_date
       and fp.status::text = 'HARD_CLOSE'
     limit 1;

    if v_hard_id is not null then
      raise exception 'Cannot post to hard-closed period % (%) — entry dated %. Reopen the period with a reason, or post a correcting entry in an open period.',
        v_hard_label, v_hard_id, new.entry_date
        using errcode = 'P0001',
              hint = 'HARD_CLOSE periods reject new postings; OPEN and SOFT_CLOSE accept them.';
    end if;
  end if;

  -- 2. Moving an already-POSTED entry OUT of a hard-closed period also
  --    mutates that closed period — reject.
  if tg_op = 'UPDATE'
     and old.status::text = 'POSTED'
     and new.status::text = 'POSTED'
     and (new.fiscal_period_id is distinct from old.fiscal_period_id
          or new.entry_date    is distinct from old.entry_date
          or new.location_id   is distinct from old.location_id) then
    select status::text into v_old_hard
      from public.fiscal_periods where id = old.fiscal_period_id;
    if v_old_hard = 'HARD_CLOSE' then
      raise exception 'Cannot move posted entry % out of hard-closed period %. Reverse it with a new entry in an open period instead.',
        old.id, old.fiscal_period_id
        using errcode = 'P0001';
    end if;
  end if;

  -- 3. (153) Status transitions OUT of POSTED / VOIDED.
  if tg_op = 'UPDATE' then
    -- 3a. VOIDED is terminal.
    if old.status::text = 'VOIDED' and new.status::text is distinct from 'VOIDED' then
      raise exception 'Cannot change the status of voided journal entry % (%). A void is final — post a new entry instead.',
        old.entry_number, old.id
        using errcode = 'P0001';
    end if;

    if old.status::text = 'POSTED' and new.status::text is distinct from 'POSTED' then
      -- 3b. Un-posting (POSTED -> anything but VOIDED) is never allowed.
      if new.status::text is distinct from 'VOIDED' then
        raise exception 'Cannot un-post journal entry % (%) to status %. Posted entries are immutable — void or reverse the entry instead.',
          old.entry_number, old.id, new.status
          using errcode = 'P0001';
      end if;

      -- 3c. POSTED -> VOIDED only outside a hard-closed period (the app's void
      --     flow runs in OPEN / SOFT_CLOSE). Checked against the entry's OLD
      --     period, by id and by date coverage, like rule 1.
      select status::text into v_old_hard
        from public.fiscal_periods where id = old.fiscal_period_id;

      select fp.id into v_old_cover
        from public.fiscal_periods fp
       where fp.org_id = old.org_id
         and fp.location_id = old.location_id
         and old.entry_date between fp.start_date and fp.end_date
         and fp.status::text = 'HARD_CLOSE'
       limit 1;

      if v_old_hard = 'HARD_CLOSE' or v_old_cover is not null then
        raise exception 'Cannot void journal entry % (%) — its period is hard-closed. Post a reversing entry in an open period instead.',
          old.entry_number, old.id
          using errcode = 'P0001',
                hint = 'Reopen the period with a reason to void in place.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Same trigger as 152 (BEFORE INSERT OR UPDATE); re-created so this migration
-- is self-sufficient if replayed.
drop trigger if exists trg_enforce_period_lock on public.gl_entries;
create trigger trg_enforce_period_lock
  before insert or update on public.gl_entries
  for each row execute function public.enforce_period_lock();

-- -------------------------------------------------------------
-- (3) Lines of a POSTED entry: immutable on UPDATE/DELETE (152) AND sealed on INSERT
-- -------------------------------------------------------------
create or replace function public.guard_posted_gl_lines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent        record;
  v_parent_status text;
  v_ref_status    text;
  v_hard_id       uuid;
  v_my_xid        bigint;
begin
  -- Explicit, transaction-local opt-out for server-side bulk purges only.
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- ── INSERT (153): a POSTED entry's line set is sealed once committed ──────────
  if tg_op = 'INSERT' then
    select e.id, e.status::text as status, e.org_id, e.location_id, e.entry_date,
           e.fiscal_period_id, e.created_at, e.entry_number
      into v_parent
      from public.gl_entries e where e.id = new.gl_entry_id;

    -- Parent missing (FK will reject) or not POSTED (DRAFT/PENDING build-up) -> allow.
    if not found or v_parent.status is distinct from 'POSTED' then
      return new;
    end if;

    -- a. No lines into a hard-closed period, ever.
    select status::text into v_ref_status
      from public.fiscal_periods where id = v_parent.fiscal_period_id;
    select fp.id into v_hard_id
      from public.fiscal_periods fp
     where fp.org_id = v_parent.org_id
       and fp.location_id = v_parent.location_id
       and v_parent.entry_date between fp.start_date and fp.end_date
       and fp.status::text = 'HARD_CLOSE'
     limit 1;
    if v_ref_status = 'HARD_CLOSE' or v_hard_id is not null then
      raise exception 'Cannot add a line to posted journal entry % (%) — its period is hard-closed.',
        v_parent.entry_number, v_parent.id
        using errcode = 'P0001';
    end if;

    -- b. Lines already committed by ANOTHER transaction => the entry is sealed.
    --    xmin is the inserting transaction's 32-bit xid; txid_current() is the
    --    epoch-extended 64-bit form, so compare modulo 2^32.
    v_my_xid := txid_current() % 4294967296;
    if exists (
      select 1 from public.gl_entry_lines l
       where l.gl_entry_id = new.gl_entry_id
         and l.xmin::text::bigint <> v_my_xid
    ) then
      raise exception 'Cannot add a line to posted journal entry % (%). Posted entries are immutable — void or reverse the entry instead.',
        v_parent.entry_number, v_parent.id
        using errcode = 'P0001';
    end if;

    -- c. A line-less POSTED header is only fillable by the posting that just
    --    created it (seconds, not minutes).
    if v_parent.created_at < now() - interval '10 minutes'
       and not exists (select 1 from public.gl_entry_lines l where l.gl_entry_id = new.gl_entry_id) then
      raise exception 'Cannot add lines to stale posted journal entry % (%) — it was created at % with no lines. Post a new entry instead.',
        v_parent.entry_number, v_parent.id, v_parent.created_at
        using errcode = 'P0001';
    end if;

    return new;
  end if;

  -- ── UPDATE / DELETE (152, unchanged) ──────────────────────────────────────────
  -- Parent not visible (cascade from a deleted header) or not POSTED -> allow.
  select status::text into v_parent_status
    from public.gl_entries where id = old.gl_entry_id;

  if v_parent_status is distinct from 'POSTED' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Cannot delete line % of posted journal entry %. Posted entries are immutable — void or reverse the entry instead.',
      old.id, old.gl_entry_id
      using errcode = 'P0001';
  end if;

  -- UPDATE: dimension tagging is fine; money-bearing columns are frozen.
  if new.debit_cents  is distinct from old.debit_cents
     or new.credit_cents is distinct from old.credit_cents
     or new.account_id   is distinct from old.account_id
     or new.location_id  is distinct from old.location_id
     or new.gl_entry_id  is distinct from old.gl_entry_id
     or new.org_id       is distinct from old.org_id then
    raise exception 'Cannot change the amount, account, entity or entry of line % on posted journal entry %. Void or reverse the entry instead.',
      old.id, old.gl_entry_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_posted_gl_lines on public.gl_entry_lines;
create trigger trg_guard_posted_gl_lines
  before insert or update or delete on public.gl_entry_lines
  for each row execute function public.guard_posted_gl_lines();

-- -------------------------------------------------------------
-- (4) Server-side ledger purge (service_role only)
-- -------------------------------------------------------------
create or replace function public.purge_org_ledger(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_org_id is null then
    raise exception 'purge_org_ledger requires an org id' using errcode = '22004';
  end if;
  perform set_config('meritbooks.allow_ledger_purge', 'on', true);  -- this transaction only
  delete from public.gl_entries where org_id = p_org_id;            -- lines cascade
  get diagnostics v_count = row_count;
  perform set_config('meritbooks.allow_ledger_purge', '', true);
  return v_count;
end;
$$;

comment on function public.purge_org_ledger(uuid) is
  'Deletes ALL gl_entries (+ cascaded lines) for one org, bypassing the posted-immutability guards. service_role only — sandbox reset / tenant teardown. Never grant to authenticated.';

-- -------------------------------------------------------------
-- (5) No direct-call surface for anon / authenticated
-- -------------------------------------------------------------
revoke execute on function public.guard_posted_gl_header_delete() from public, anon, authenticated;
revoke execute on function public.enforce_period_lock()          from public, anon, authenticated;
revoke execute on function public.guard_posted_gl_lines()        from public, anon, authenticated;
revoke execute on function public.purge_org_ledger(uuid)         from public, anon, authenticated;
grant  execute on function public.purge_org_ledger(uuid)         to service_role;

-- =============================================================
-- DONE. Posted headers with lines can't be deleted; posted entries can't be
-- un-posted, voided in a hard-closed period, or un-voided; a posted entry's line
-- set is sealed once committed. Normal two-request posting + rollback unchanged.
-- =============================================================
