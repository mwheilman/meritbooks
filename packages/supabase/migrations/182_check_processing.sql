-- =============================================================================
-- Migration 182: check processing — check stock, per-account number sequences,
--                the check register, voids/spoils, positive-pay history
--                (Wave 2C, docs/FPB-check-processing.md)
-- =============================================================================
-- Released CHECK-method AP payments (bill_payments, posted DR A/P / CR Cash on release)
-- are bundled into PRINTED checks with numbers from a per-bank-account sequence.
--
-- §1  public.bank_check_sequences — next check number per bank account. Changed only
--     by the functions below (atomic, row-locked): no gaps, no duplicates.
-- §2  public.check_sequence_events — declared jumps of the sequence (the register's gap
--     check ignores declared skips).
-- §3  public.check_stock_profiles — per bank account: layout, printer nudge, payer / bank
--     blocks, MICR masks (last 4) + a Vault pointer to the full routing / account numbers,
--     signature storage paths, second-signature threshold, void / stale days, positive-pay
--     format + mapping. micr_secret_ref and the signature paths are column-revoked from
--     members (167 field masks, re-applied at the end).
-- §4  public.check_print_runs, public.ap_checks (the register), public.ap_check_payments
--     (check ↔ bill_payments; a payment is on at most one CURRENT check),
--     public.positive_pay_exports.
-- §5  guard_ap_check(): legal status transitions only; number / account / amount / payee /
--     date never change; no deletes (cascades from an org teardown and the 152/153 purge
--     GUC excepted).
-- §6  public.issue_check_print_run(): allocate N consecutive numbers AND insert the N
--     checks + links + the run in ONE transaction under the sequence row lock; re-checks
--     every payment (POSTED, CHECK, drawn on this account's GL cash account, released
--     through the pay run, not handwritten, same vendor per check, Σ = check amount) and
--     the print SoD (printer ≠ preparer; printer = approver only as the 174 release
--     policy allows). public.set_check_sequence(): move the next number (must stay above
--     every issued number); the jump is logged.
-- §7  approvals: "one approval per bill, ever" (042 uq_approvals_subject) becomes "one
--     OPEN approval per bill" — a voided check returns its approval (RELEASED → RETURNED)
--     and the bill must be able to queue again.
-- §8  Private Storage bucket `check-signatures` (no member object policies at all — the
--     server reads it with the service role, only to render a check).
-- §9  RLS: member SELECT (org) + service_all; members are SELECT-only (171 write lock);
--     client scope re-applied (every table carries location_id).
--
-- M1 lesson: every function EXECUTE-revoked from public / anon / authenticated and
-- granted to service_role. Idempotent. PGlite-compatible (no subqueries in CHECK).
-- No GL effect (printing posts nothing; voids post through the app's posting engine).
-- Apply to Supabase FIRST.
-- =============================================================================

-- ── §1 sequences ─────────────────────────────────────────────────────────────
create table if not exists public.bank_check_sequences (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  next_number     bigint not null default 1001,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint bank_check_sequences_next_chk check (next_number between 1 and 99999999)
);
create unique index if not exists uq_bank_check_sequences_account
  on public.bank_check_sequences (org_id, bank_account_id);
comment on table public.bank_check_sequences is
  'Mig 182: next check number per bank account. Written only by issue_check_print_run / set_check_sequence (row-locked): no gaps, no duplicates.';

-- ── §2 declared sequence jumps ───────────────────────────────────────────────
create table if not exists public.check_sequence_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  from_number     bigint not null,
  to_number       bigint not null,
  reason          text not null,
  actor           text not null,
  created_at      timestamptz not null default now(),
  constraint check_sequence_events_reason_chk check (length(btrim(reason)) between 3 and 500)
);
create index if not exists idx_check_sequence_events_account
  on public.check_sequence_events (org_id, bank_account_id, created_at desc);

-- ── §3 check stock profiles ──────────────────────────────────────────────────
create table if not exists public.check_stock_profiles (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references core.organizations(id) on delete cascade,
  location_id                 uuid not null references core.locations(id),
  bank_account_id             uuid not null references public.bank_accounts(id) on delete cascade,
  layout                      text not null default 'VOUCHER_TOP',
  offset_x_pt                 numeric(6,2) not null default 0,
  offset_y_pt                 numeric(6,2) not null default 0,
  payer_name                  text,
  payer_address               text,
  logo_url                    text,
  bank_name                   text,
  bank_address                text,
  bank_fraction               text,
  routing_mask                text,          -- last 4 ONLY (e.g. '****0021')
  account_mask                text,          -- last 4 ONLY
  micr_secret_ref             uuid,          -- Vault pointer to {"routing","account"} (column-revoked)
  micr_set_at                 timestamptz,
  micr_set_by                 text,
  signature_path              text,          -- check-signatures bucket key (column-revoked)
  signature_set_at            timestamptz,
  signature_set_by            text,
  signature2_path             text,          -- optional second signature (column-revoked)
  signature2_set_at           timestamptz,
  signature2_set_by           text,
  second_signature_over_cents bigint,        -- above this a second signature prints (or a blank line)
  max_check_cents             bigint,        -- optional ceiling: refuse to print a larger check
  void_after_days             integer not null default 90,
  stale_after_days            integer not null default 180,
  one_check_per_bill          boolean not null default false,
  aux_on_us_digits            smallint not null default 6,
  positive_pay_format         text not null default 'GENERIC_CSV',
  positive_pay_mapping        jsonb,
  updated_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint csp_layout_chk check (layout in ('VOUCHER_TOP', 'VOUCHER_MIDDLE', 'VOUCHER_BOTTOM', 'THREE_UP')),
  constraint csp_offset_chk check (offset_x_pt between -72 and 72 and offset_y_pt between -72 and 72),
  constraint csp_routing_mask_chk check (routing_mask is null or routing_mask ~ '^\*{0,8}[0-9]{4}$'),
  constraint csp_account_mask_chk check (account_mask is null or account_mask ~ '^\*{0,13}[0-9]{4}$'),
  constraint csp_second_sig_chk check (second_signature_over_cents is null or second_signature_over_cents > 0),
  constraint csp_max_chk check (max_check_cents is null or max_check_cents > 0),
  constraint csp_void_days_chk check (void_after_days between 30 and 365),
  constraint csp_stale_days_chk check (stale_after_days between 30 and 730),
  constraint csp_aux_digits_chk check (aux_on_us_digits between 4 and 10),
  constraint csp_pp_format_chk check (positive_pay_format in ('GENERIC_CSV', 'CHASE_STYLE_FIXED', 'BOFA_STYLE_FIXED', 'CUSTOM_CSV', 'CUSTOM_FIXED')),
  constraint csp_pp_mapping_chk check (positive_pay_mapping is null or jsonb_typeof(positive_pay_mapping) = 'object'),
  constraint csp_text_len_chk check (
    coalesce(length(payer_name), 0) <= 200 and coalesce(length(payer_address), 0) <= 500
    and coalesce(length(bank_name), 0) <= 200 and coalesce(length(bank_address), 0) <= 500
    and coalesce(length(bank_fraction), 0) <= 40 and coalesce(length(logo_url), 0) <= 1000)
);
create unique index if not exists uq_check_stock_profiles_account
  on public.check_stock_profiles (org_id, bank_account_id);
comment on table public.check_stock_profiles is
  'Mig 182: check stock / printing setup per bank account. Full MICR numbers live in Vault (micr_secret_ref); signature images in the private check-signatures bucket. Both pointers are column-revoked from members.';

-- §3b check-stock SECURITY changes awaiting a second admin (security review M9). A change
-- to a signature image or the MICR bank numbers, or a loosening of the second-signature
-- threshold / max-check amount, opens a row here; until a DIFFERENT tenant admin confirms
-- it (or 24 h pass) the person who made it cannot print checks on that account
-- (issue_check_print_run refuses). Only confirmed_by / confirmed_at ever change, once.
create table if not exists public.check_stock_security_changes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  change_kind     text not null,
  summary         text not null,
  changed_by      text not null,
  changed_at      timestamptz not null default now(),
  hold_until      timestamptz not null default (now() + interval '24 hours'),
  confirmed_by    text,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint cssc_kind_chk check (change_kind in ('SIGNATURE', 'SIGNATURE_REMOVED', 'BANK_NUMBERS', 'SECOND_SIGNATURE_THRESHOLD', 'MAX_CHECK_AMOUNT')),
  constraint cssc_summary_chk check (length(summary) between 1 and 500),
  constraint cssc_confirm_pair_chk check ((confirmed_at is null) = (confirmed_by is null)),
  constraint cssc_confirmer_chk check (confirmed_by is null or confirmed_by <> changed_by)
);
create index if not exists idx_check_stock_security_changes_open
  on public.check_stock_security_changes (org_id, bank_account_id, changed_by) where confirmed_at is null;
comment on table public.check_stock_security_changes is
  'Mig 182 (security review M9): signature / bank-number / threshold changes on a check stock profile. The changer cannot print on the account for 24 h unless a different tenant admin confirms.';

create or replace function public.guard_check_stock_security_change() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;  -- cascades from an org / account teardown
  end if;
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A check-stock security change is audit evidence and cannot be deleted (migration 182).' using errcode = '42501';
  end if;
  if (new.org_id, new.location_id, new.bank_account_id, new.change_kind, new.summary, new.changed_by, new.changed_at, new.hold_until, new.created_at)
     is distinct from
     (old.org_id, old.location_id, old.bank_account_id, old.change_kind, old.summary, old.changed_by, old.changed_at, old.hold_until, old.created_at) then
    raise exception 'A check-stock security change never changes; only its confirmation is recorded (migration 182).' using errcode = '42501';
  end if;
  if old.confirmed_at is not null and (new.confirmed_at, new.confirmed_by) is distinct from (old.confirmed_at, old.confirmed_by) then
    raise exception 'This check-stock change was already confirmed (migration 182).' using errcode = '42501';
  end if;
  return new;
end
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_check_stock_security_change' and tgrelid = 'public.check_stock_security_changes'::regclass) then
    create trigger trg_guard_check_stock_security_change before update or delete on public.check_stock_security_changes
      for each row execute function public.guard_check_stock_security_change();
  end if;
end $$;

-- ── §4 print runs, the register, links, positive-pay history ─────────────────
create table if not exists public.check_print_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  kind            text not null default 'CHECKS',
  layout          text,
  check_count     integer not null default 0,
  total_cents     bigint not null default 0,
  first_number    bigint,
  last_number     bigint,
  printed_by      text not null,
  note            text,
  created_at      timestamptz not null default now(),
  constraint cpr_kind_chk check (kind in ('CHECKS', 'ALIGNMENT')),
  constraint cpr_count_chk check (check_count >= 0 and total_cents >= 0)
);
create index if not exists idx_check_print_runs_account on public.check_print_runs (org_id, bank_account_id, created_at desc);

create table if not exists public.positive_pay_exports (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id),
  bank_account_id    uuid not null references public.bank_accounts(id) on delete cascade,
  format             text not null,
  mode               text not null default 'SINCE_LAST',
  from_date          date,
  through_date       date,
  issue_count        integer not null default 0,
  void_count         integer not null default 0,
  issue_total_cents  bigint not null default 0,
  void_total_cents   bigint not null default 0,
  file_name          text not null,
  file_sha256        text,
  generated_by       text not null,
  created_at         timestamptz not null default now(),
  constraint ppe_mode_chk check (mode in ('SINCE_LAST', 'RANGE')),
  constraint ppe_counts_chk check (issue_count >= 0 and void_count >= 0 and issue_total_cents >= 0 and void_total_cents >= 0)
);
create index if not exists idx_positive_pay_exports_account on public.positive_pay_exports (org_id, bank_account_id, created_at desc);

create table if not exists public.ap_checks (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references core.organizations(id) on delete cascade,
  location_id                  uuid not null references core.locations(id),
  bank_account_id              uuid not null references public.bank_accounts(id),
  check_number                 bigint not null,
  check_date                   date not null,
  payee_vendor_id              uuid references core.vendors(id),
  payee_name                   text not null,
  payee_address                text,
  amount_cents                 bigint not null,
  memo                         text,
  status                       text not null default 'PRINTED',
  print_run_id                 uuid references public.check_print_runs(id) on delete set null,
  printed_by                   text not null,
  printed_at                   timestamptz not null default now(),
  signatures_printed           smallint not null default 0,
  issued_at                    timestamptz,
  issued_by                    text,
  mailed_at                    timestamptz,
  mailed_by                    text,
  mail_provider                text,
  mail_tracking                text,
  cleared_at                   timestamptz,
  cleared_bank_transaction_id  uuid references public.bank_transactions(id) on delete set null,
  cleared_by                   text,
  clear_note                   text,
  void_requested_at            timestamptz,
  void_requested_by            text,
  voided_at                    timestamptz,
  voided_by                    text,
  void_reason                  text,
  void_kind                    text,
  void_date                    date,
  reversal_mode                text,
  reversal_entry_ids           jsonb,
  replaces_check_id            uuid references public.ap_checks(id) on delete set null,
  positive_pay_issue_export_id uuid references public.positive_pay_exports(id) on delete set null,
  positive_pay_void_export_id  uuid references public.positive_pay_exports(id) on delete set null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint ap_checks_number_chk check (check_number between 1 and 99999999),
  constraint ap_checks_amount_chk check (amount_cents > 0 and amount_cents <= 9999999999),
  constraint ap_checks_status_chk check (status in ('PRINTED', 'ISSUED', 'MAILED', 'CLEARED', 'VOIDED', 'SPOILED')),
  constraint ap_checks_void_kind_chk check (void_kind is null or void_kind in ('VOID', 'SPOIL')),
  constraint ap_checks_reversal_chk check (reversal_mode is null or reversal_mode in ('NONE', 'VOID_IN_PLACE', 'REVERSING_ENTRY', 'MIXED')),
  constraint ap_checks_payee_chk check (length(btrim(payee_name)) between 1 and 200),
  constraint ap_checks_memo_chk check (memo is null or length(memo) <= 200),
  constraint ap_checks_terminal_chk check (
    status not in ('VOIDED', 'SPOILED') or (voided_at is not null and voided_by is not null and void_reason is not null)),
  constraint ap_checks_cleared_chk check (status <> 'CLEARED' or cleared_at is not null)
);
create unique index if not exists uq_ap_checks_number
  on public.ap_checks (org_id, bank_account_id, check_number);
create index if not exists idx_ap_checks_status on public.ap_checks (org_id, bank_account_id, status, check_date);
create index if not exists idx_ap_checks_vendor on public.ap_checks (org_id, payee_vendor_id);
comment on table public.ap_checks is
  'Mig 182: the check register. One row per printed check number (PRINTED → ISSUED/MAILED → CLEARED, or VOIDED / SPOILED). Numbers come from bank_check_sequences via issue_check_print_run only.';

create table if not exists public.ap_check_payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id),
  check_id         uuid not null references public.ap_checks(id) on delete cascade,
  bill_payment_id  uuid not null references public.bill_payments(id),
  approval_id      uuid references public.approvals(id),
  bill_id          uuid not null references public.bills(id),
  amount_cents     bigint not null,
  is_current       boolean not null default true,
  reversed_at      timestamptz,
  reversal_gl_entry_id uuid references public.gl_entries(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint acp_amount_chk check (amount_cents > 0)
);
create unique index if not exists uq_ap_check_payments_current
  on public.ap_check_payments (bill_payment_id) where is_current;
create index if not exists idx_ap_check_payments_check on public.ap_check_payments (check_id);

-- ── §5 register guard ────────────────────────────────────────────────────────
create or replace function public.guard_ap_check() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A check in the register cannot be deleted; void or spoil it instead (migration 182).'
      using errcode = '42501';
  end if;

  if (new.org_id, new.location_id, new.bank_account_id, new.check_number, new.check_date, new.amount_cents,
      new.payee_vendor_id, new.payee_name, new.printed_by, new.printed_at, new.print_run_id)
     is distinct from
     (old.org_id, old.location_id, old.bank_account_id, old.check_number, old.check_date, old.amount_cents,
      old.payee_vendor_id, old.payee_name, old.printed_by, old.printed_at, old.print_run_id) then
    raise exception 'A printed check''s number, account, date, payee and amount never change; void it and print a new one (migration 182).'
      using errcode = '42501';
  end if;

  if old.status in ('VOIDED', 'SPOILED') then
    if (new.status, new.voided_at, new.voided_by, new.void_reason, new.void_kind, new.void_date, new.reversal_mode, new.reversal_entry_ids)
       is distinct from
       (old.status, old.voided_at, old.voided_by, old.void_reason, old.void_kind, old.void_date, old.reversal_mode, old.reversal_entry_ids) then
      raise exception 'A voided or spoiled check is final (migration 182).' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'PRINTED' and new.status in ('ISSUED', 'MAILED', 'CLEARED', 'VOIDED', 'SPOILED'))
      or (old.status = 'ISSUED'  and new.status in ('MAILED', 'CLEARED', 'VOIDED'))
      or (old.status = 'MAILED'  and new.status in ('CLEARED', 'VOIDED'))
      or (old.status = 'CLEARED' and new.status in ('ISSUED', 'MAILED')
                                 and new.cleared_at is null and new.cleared_bank_transaction_id is null)
    ) then
      raise exception 'Invalid check status change % -> % (migration 182).', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'SPOILED' and new.void_kind is distinct from 'SPOIL' then
      raise exception 'A spoiled check is recorded with void_kind SPOIL.' using errcode = 'check_violation';
    end if;
    -- Security review M1: spoiling returns the payments to "ready", so only the person who
    -- printed the check may spoil it, and only within 24 h of printing; otherwise void it.
    if new.status = 'SPOILED' then
      if new.voided_by is distinct from old.printed_by then
        raise exception 'Only the person who printed check % can spoil it; void it instead (migration 182).', old.check_number
          using errcode = 'check_violation';
      end if;
      if now() > old.printed_at + interval '24 hours' then
        raise exception 'Check % was printed more than 24 hours ago, so it can''t be spoiled; void it instead (migration 182).', old.check_number
          using errcode = 'check_violation';
      end if;
    end if;
    if new.status = 'VOIDED' and new.void_kind is distinct from 'VOID' then
      raise exception 'A voided check is recorded with void_kind VOID.' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_ap_check' and tgrelid = 'public.ap_checks'::regclass) then
    create trigger trg_guard_ap_check before update or delete on public.ap_checks
      for each row execute function public.guard_ap_check();
  end if;
end $$;

-- Links: only is_current / reversal stamping may change; never deleted directly.
create or replace function public.guard_ap_check_payment() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A check''s payment link cannot be deleted (migration 182).' using errcode = '42501';
  end if;
  if (new.org_id, new.check_id, new.bill_payment_id, new.bill_id, new.amount_cents, new.approval_id)
     is distinct from (old.org_id, old.check_id, old.bill_payment_id, old.bill_id, old.amount_cents, old.approval_id) then
    raise exception 'A check''s payment link never changes (migration 182).' using errcode = '42501';
  end if;
  if old.is_current = false and new.is_current = true then
    raise exception 'A released payment link cannot be made current again (migration 182).' using errcode = '42501';
  end if;
  return new;
end
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_ap_check_payment' and tgrelid = 'public.ap_check_payments'::regclass) then
    create trigger trg_guard_ap_check_payment before update or delete on public.ap_check_payments
      for each row execute function public.guard_ap_check_payment();
  end if;
end $$;

-- ── §6 atomic print run + sequence moves ─────────────────────────────────────
-- p_checks: [{ payee_vendor_id, payee_name, payee_address, amount_cents, memo,
--              signatures_printed, replaces_check_id,
--              payments: [{ bill_payment_id }] }]
-- Raises with a message the app shows as-is. A stale p_expected_first raises a message
-- starting 'STALE_SEQUENCE:'.
create or replace function public.issue_check_print_run(
  p_org uuid,
  p_bank_account uuid,
  p_actor text,
  p_check_date date,
  p_checks jsonb,
  p_expected_first bigint default null,
  p_layout text default null)
returns jsonb
language plpgsql security definer set search_path = public, core, pg_temp as
$$
declare
  v_ba record;
  v_next bigint;
  v_count int;
  v_run uuid;
  v_i int := 0;
  c jsonb;
  p jsonb;
  v_check uuid;
  v_num bigint;
  v_sum bigint;
  v_amount bigint;
  v_vendor uuid;
  v_out jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_pay record;
  v_appr record;
  v_sole boolean;
  v_max bigint;
  v_rep record;
begin
  if p_org is null or p_bank_account is null then
    raise exception 'organization and bank account are required' using errcode = 'check_violation';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 then
    raise exception 'the printer is required' using errcode = 'check_violation';
  end if;
  if p_check_date is null then
    raise exception 'a check date is required' using errcode = 'check_violation';
  end if;
  if p_checks is null or jsonb_typeof(p_checks) <> 'array' or jsonb_array_length(p_checks) = 0 then
    raise exception 'choose at least one check to print' using errcode = 'check_violation';
  end if;
  v_count := jsonb_array_length(p_checks);
  if v_count > 500 then
    raise exception 'print at most 500 checks at a time' using errcode = 'check_violation';
  end if;

  select ba.id, ba.location_id, ba.account_id, ba.account_type, ba.is_active
    into v_ba
    from public.bank_accounts ba
   where ba.id = p_bank_account and ba.org_id = p_org;
  if not found then
    raise exception 'That bank account is not part of this organization.' using errcode = 'no_data_found';
  end if;
  if v_ba.account_type <> 'CHECKING' or not v_ba.is_active then
    raise exception 'Checks can only be printed on an active checking account.' using errcode = 'check_violation';
  end if;

  select o.sole_approver_mode, o.sole_approver_max_cents into v_sole, v_max
    from core.organizations o where o.id = p_org;

  -- Security review M9: the person who changed this account's signatures / bank numbers /
  -- thresholds can't print on it for 24 h unless a different admin confirmed the change.
  if exists (select 1 from public.check_stock_security_changes x
              where x.org_id = p_org and x.bank_account_id = p_bank_account and x.changed_by = p_actor
                and x.confirmed_at is null and x.hold_until > now()) then
    raise exception 'You changed this account''s check security settings in the last 24 hours. Another admin has to confirm the change before you can print checks on it.'
      using errcode = 'check_violation';
  end if;

  insert into public.bank_check_sequences (org_id, location_id, bank_account_id)
  values (p_org, v_ba.location_id, p_bank_account)
  on conflict (org_id, bank_account_id) do nothing;

  select s.next_number into v_next
    from public.bank_check_sequences s
   where s.org_id = p_org and s.bank_account_id = p_bank_account
   for update;

  if p_expected_first is not null and p_expected_first <> v_next then
    raise exception 'STALE_SEQUENCE: the next check number is now %, not % — refresh and try again.', v_next, p_expected_first
      using errcode = 'check_violation';
  end if;
  if v_next + v_count - 1 > 99999999 then
    raise exception 'The check-number sequence would pass 99,999,999.' using errcode = 'check_violation';
  end if;

  insert into public.check_print_runs (org_id, location_id, bank_account_id, kind, layout, printed_by)
  values (p_org, v_ba.location_id, p_bank_account, 'CHECKS', p_layout, p_actor)
  returning id into v_run;

  for c in select value from jsonb_array_elements(p_checks) loop
    v_num := v_next + v_i;
    v_vendor := nullif(c ->> 'payee_vendor_id', '')::uuid;
    v_amount := (c ->> 'amount_cents')::bigint;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Each check needs an amount greater than $0.' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(c -> 'payments') is distinct from 'array' or jsonb_array_length(c -> 'payments') = 0 then
      raise exception 'Each check must pay at least one released bill.' using errcode = 'check_violation';
    end if;

    if nullif(c ->> 'replaces_check_id', '') is not null then
      select k.id, k.status, k.bank_account_id into v_rep
        from public.ap_checks k
       where k.id = (c ->> 'replaces_check_id')::uuid and k.org_id = p_org;
      if not found or v_rep.status <> 'SPOILED' or v_rep.bank_account_id <> p_bank_account then
        raise exception 'A reprint can only replace a spoiled check on the same bank account.' using errcode = 'check_violation';
      end if;
    end if;

    insert into public.ap_checks (org_id, location_id, bank_account_id, check_number, check_date, payee_vendor_id,
                                  payee_name, payee_address, amount_cents, memo, status, print_run_id, printed_by,
                                  signatures_printed, replaces_check_id)
    values (p_org, v_ba.location_id, p_bank_account, v_num, p_check_date, v_vendor,
            coalesce(nullif(btrim(c ->> 'payee_name'), ''), 'Payee'), nullif(c ->> 'payee_address', ''), v_amount,
            nullif(c ->> 'memo', ''), 'PRINTED', v_run, p_actor,
            coalesce((c ->> 'signatures_printed')::smallint, 0), nullif(c ->> 'replaces_check_id', '')::uuid)
    returning id into v_check;

    v_sum := 0;
    for p in select value from jsonb_array_elements(c -> 'payments') loop
      select bp.id, bp.bill_id, bp.amount_cents, bp.status, bp.method, bp.cash_account_id, bp.location_id, b.vendor_id
        into v_pay
        from public.bill_payments bp
        join public.bills b on b.id = bp.bill_id
       where bp.id = (p ->> 'bill_payment_id')::uuid and bp.org_id = p_org
       for update of bp;
      if not found then
        raise exception 'A payment on this run is not part of this organization.' using errcode = 'no_data_found';
      end if;
      if v_pay.status <> 'POSTED' then
        raise exception 'A payment on this run was voided.' using errcode = 'check_violation';
      end if;
      if upper(coalesce(v_pay.method, '')) <> 'CHECK' then
        raise exception 'Only check payments can be printed.' using errcode = 'check_violation';
      end if;
      if v_pay.cash_account_id is distinct from v_ba.account_id then
        raise exception 'A payment on this run was released from a different bank account.' using errcode = 'check_violation';
      end if;
      if v_vendor is not null and v_pay.vendor_id <> v_vendor then
        raise exception 'Every bill on one check must be for the same vendor.' using errcode = 'check_violation';
      end if;

      select a.id, a.prepared_by, a.approved_by, a.amount_cents, a.provider_correlation_id
        into v_appr
        from public.approvals a
       where a.org_id = p_org and a.kind = 'AP_DISBURSEMENT' and a.subject_table = 'bills'
         and a.subject_id = v_pay.bill_id and a.status in ('RELEASED', 'SETTLED')
         and (a.provider_correlation_id = 'bill_payment:' || v_pay.id::text
              or a.provider_correlation_id like 'bill_payment:' || v_pay.id::text || '|%')
       limit 1;
      if not found then
        raise exception 'A payment on this run was not released through the pay run.' using errcode = 'check_violation';
      end if;
      if v_appr.provider_correlation_id like '%|check:%' then
        raise exception 'A payment on this run was recorded as a handwritten check.' using errcode = 'check_violation';
      end if;
      if v_appr.prepared_by = p_actor then
        raise exception 'Separation of duties: the person who prepared a payment cannot print its check.'
          using errcode = 'check_violation';
      end if;
      if v_appr.approved_by is not null and v_appr.approved_by = p_actor then
        if not coalesce(v_sole, false) then
          raise exception 'Separation of duties: the person who approved a payment cannot also print its check.'
            using errcode = 'check_violation';
        end if;
        if v_max is not null and (v_appr.amount_cents is null or abs(v_appr.amount_cents) > v_max) then
          raise exception 'Separation of duties: this payment is over the amount its approver may also release, so someone else has to print it.'
            using errcode = 'check_violation';
        end if;
      end if;

      insert into public.ap_check_payments (org_id, location_id, check_id, bill_payment_id, approval_id, bill_id, amount_cents)
      values (p_org, v_ba.location_id, v_check, v_pay.id, v_appr.id, v_pay.bill_id, v_pay.amount_cents);
      v_sum := v_sum + v_pay.amount_cents;
    end loop;

    if v_sum <> v_amount then
      raise exception 'A check''s amount does not equal the payments on it.' using errcode = 'check_violation';
    end if;
    v_total := v_total + v_sum;
    v_out := v_out || jsonb_build_array(jsonb_build_object('check_id', v_check, 'check_number', v_num, 'amount_cents', v_sum));
    v_i := v_i + 1;
  end loop;

  update public.bank_check_sequences
     set next_number = v_next + v_count, updated_at = now(), updated_by = p_actor
   where org_id = p_org and bank_account_id = p_bank_account;

  update public.check_print_runs
     set check_count = v_count, total_cents = v_total, first_number = v_next, last_number = v_next + v_count - 1
   where id = v_run;

  return jsonb_build_object('run_id', v_run, 'first_number', v_next, 'last_number', v_next + v_count - 1,
                            'total_cents', v_total, 'checks', v_out);
end
$$;

-- Move the next number (a new box of stock, a bank-issued range). Must stay above every
-- number already issued on the account, so a duplicate is impossible; the jump is logged.
create or replace function public.set_check_sequence(
  p_org uuid, p_bank_account uuid, p_next bigint, p_actor text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, core, pg_temp as
$$
declare
  v_loc uuid;
  v_old bigint;
  v_max bigint;
begin
  if p_next is null or p_next < 1 or p_next > 99999999 then
    raise exception 'Enter a check number from 1 to 99,999,999.' using errcode = 'check_violation';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Say why the check number is changing.' using errcode = 'check_violation';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 then
    raise exception 'the actor is required' using errcode = 'check_violation';
  end if;
  select ba.location_id into v_loc from public.bank_accounts ba where ba.id = p_bank_account and ba.org_id = p_org;
  if not found then
    raise exception 'That bank account is not part of this organization.' using errcode = 'no_data_found';
  end if;

  insert into public.bank_check_sequences (org_id, location_id, bank_account_id, next_number)
  values (p_org, v_loc, p_bank_account, 1001)
  on conflict (org_id, bank_account_id) do nothing;
  select s.next_number into v_old from public.bank_check_sequences s
   where s.org_id = p_org and s.bank_account_id = p_bank_account for update;

  select max(k.check_number) into v_max from public.ap_checks k
   where k.org_id = p_org and k.bank_account_id = p_bank_account;
  if v_max is not null and p_next <= v_max then
    raise exception 'Check number % is already used on this account; the next number must be above %.', p_next, v_max
      using errcode = 'check_violation';
  end if;
  if p_next = v_old then
    return jsonb_build_object('status', 'unchanged', 'next_number', v_old);
  end if;

  update public.bank_check_sequences
     set next_number = p_next, updated_at = now(), updated_by = p_actor
   where org_id = p_org and bank_account_id = p_bank_account;
  insert into public.check_sequence_events (org_id, location_id, bank_account_id, from_number, to_number, reason, actor)
  values (p_org, v_loc, p_bank_account, v_old, p_next, btrim(p_reason), p_actor);
  return jsonb_build_object('status', 'applied', 'previous_next_number', v_old, 'next_number', p_next);
end
$$;

-- ── §7 approvals: one OPEN approval per bill ─────────────────────────────────
do $$ begin
  if to_regclass('public.approvals') is not null then
    drop index if exists public.uq_approvals_subject;
    create unique index if not exists uq_approvals_subject_open
      on public.approvals (subject_table, subject_id)
      where status not in ('REJECTED', 'RETURNED');
  end if;
end $$;

-- ── §8 private signature bucket (service role only) ──────────────────────────
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('check-signatures', 'check-signatures', false)
    on conflict (id) do nothing;
  end if;
end $$;

-- ── field masks: the Vault pointer + signature paths are server-only ─────────
do $$ begin
  if to_regclass('core.field_class_columns') is not null then
    insert into core.field_class_columns (field_class, schema_name, table_name, column_name, enforcement, note) values
      ('bank',    'public', 'check_stock_profiles', 'micr_secret_ref', 'column_revoke', 'Vault pointer to the full MICR routing / account numbers; read only by the server at print / positive pay'),
      ('bank',    'public', 'check_stock_profiles', 'routing_mask',    'serializer',    'Stored as last 4 only'),
      ('bank',    'public', 'check_stock_profiles', 'account_mask',    'serializer',    'Stored as last 4 only'),
      ('secrets', 'public', 'check_stock_profiles', 'signature_path',  'column_revoke', 'Signature image key; rendered only on a printed check'),
      ('secrets', 'public', 'check_stock_profiles', 'signature2_path', 'column_revoke', 'Second signature image key; rendered only on a printed check')
    on conflict (schema_name, table_name, column_name) do update
      set field_class = excluded.field_class, enforcement = excluded.enforcement, note = excluded.note;
  end if;
end $$;

-- ── §9 RLS + the business write lock ─────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['bank_check_sequences', 'check_sequence_events', 'check_stock_profiles',
                           'check_print_runs', 'positive_pay_exports', 'ap_checks', 'ap_check_payments',
                           'check_stock_security_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'member_read') then
      execute format('create policy member_read on public.%I for select using (org_id = public.get_org_id())', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'service_all') then
      execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    end if;
    execute format('revoke insert, update, delete, truncate on table public.%I from anon, authenticated', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── privileges (M1) ──────────────────────────────────────────────────────────
revoke all on function public.guard_ap_check() from public, anon, authenticated;
revoke all on function public.guard_ap_check_payment() from public, anon, authenticated;
revoke all on function public.guard_check_stock_security_change() from public, anon, authenticated;
revoke all on function public.issue_check_print_run(uuid, uuid, text, date, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function public.issue_check_print_run(uuid, uuid, text, date, jsonb, bigint, text) to service_role;
revoke all on function public.set_check_sequence(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.set_check_sequence(uuid, uuid, bigint, text, text) to service_role;

-- Column masks (167): table SELECT for members becomes per-column, minus the revoked ones.
do $$ begin
  if to_regprocedure('core.apply_field_column_masks()') is not null then
    perform core.apply_field_column_masks();
  end if;
end $$;

-- End migration 182.

-- Client scope (163): every table above owns a location_id.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
