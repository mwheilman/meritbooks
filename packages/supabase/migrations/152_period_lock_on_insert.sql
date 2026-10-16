-- Migration 152: Period lock on INSERT + posted-line immutability
-- =============================================================
-- THE GAP. Migration 004 created trg_enforce_period_lock as BEFORE UPDATE only,
-- so a gl_entries row INSERTED directly with status = 'POSTED' into a
-- HARD_CLOSE period was stopped only by application code — and any writer that
-- skipped the app-side check (e.g. the GL-history / opening-balance importer)
-- could post straight into a closed month. Nothing at the DB level stopped a
-- DELETE (or an amount rewrite) of the lines under an already-POSTED entry.
--
-- CANON (CANON-ANCHOR §3, Rule F): entries may post into OPEN or SOFT_CLOSE
-- periods; HARD_CLOSE blocks. The sanctioned way to touch a closed month is to
-- REOPEN the period with a reason (fiscal_periods.close_override_reason, via
-- setPeriodStatus) — there is no per-entry bypass, and this migration adds none.
-- Corrections to a posted entry go through void / reversal, never line edits.
--
-- WHAT THIS DOES (additive, idempotent):
--   (a) enforce_period_lock() now runs BEFORE INSERT OR UPDATE on gl_entries and
--       rejects a POSTED entry whose period is HARD_CLOSE. The period is checked
--       two ways (either one HARD_CLOSE => reject):
--         1. the referenced fiscal_period_id (exactly what 004 checked), and
--         2. any fiscal_periods row for the same org + location whose date
--            range covers entry_date (catches a fiscal_period_id that doesn't
--            match the entry date).
--       It fires when an entry BECOMES posted (insert as POSTED, or
--       status -> POSTED), and when an already-POSTED entry is re-dated /
--       re-periodized / moved to another location (into OR out of a closed
--       period). Other updates to posted rows (void, reversal links, memo) are
--       unchanged. As in 004: if there's no matching period row, the entry is
--       allowed (the NOT NULL fiscal_period_id FK already requires a period).
--   (b) guard_posted_gl_lines() — BEFORE UPDATE OR DELETE on gl_entry_lines:
--         * DELETE of a line whose parent entry is POSTED is rejected.
--         * UPDATE of the money-bearing columns (debit_cents, credit_cents,
--           account_id, location_id, gl_entry_id, org_id) on such a line is
--           rejected. Dimension tagging (job_id, department_id, class_id,
--           item_id, memo, ...) stays allowed — bank-feed approve, bill-ap and
--           job-cost-events stamp job_id onto posted lines.
--       Cascades still work: when the parent gl_entries row is itself deleted
--       (FK ON DELETE CASCADE — org teardown, sandbox reset, a posting
--       routine rolling back its own just-inserted header), the parent is no
--       longer visible to the line trigger, so the cascaded line delete is
--       allowed. Header deletion is out of scope here (see report).
--       Bulk purges (tenant reset RPC) can opt out for ONE transaction with
--           set local meritbooks.allow_ledger_purge = 'on';
--       A transaction-local GUC can't be set through PostgREST, so ordinary
--       API callers can't use it; only server-side SQL (a SECURITY DEFINER
--       admin RPC, a migration, psql) can.
--
-- Both functions are SECURITY DEFINER with a pinned search_path so the period
-- / parent-status lookups see the real rows no matter which role runs the
-- write. (An RLS-filtered lookup that saw nothing would quietly let the write
-- through.)
--
-- Requires 004 (gl_entries, gl_entry_lines, fiscal_periods). Next: 153.
-- =============================================================

-- -------------------------------------------------------------
-- (a) Period lock on INSERT and UPDATE of gl_entries
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

  return new;
end;
$$;

drop trigger if exists trg_enforce_period_lock on public.gl_entries;
create trigger trg_enforce_period_lock
  before insert or update on public.gl_entries
  for each row execute function public.enforce_period_lock();

-- -------------------------------------------------------------
-- (b) Lines of a POSTED entry are immutable (delete / money columns)
-- -------------------------------------------------------------
create or replace function public.guard_posted_gl_lines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent_status text;
begin
  -- Explicit, transaction-local opt-out for server-side bulk purges only.
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

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
  before update or delete on public.gl_entry_lines
  for each row execute function public.guard_posted_gl_lines();

-- =============================================================
-- DONE. Period lock now applies on INSERT as well as UPDATE; lines of a posted
-- entry can't be deleted or have their amounts/accounts rewritten.
-- =============================================================
