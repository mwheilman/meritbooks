-- =============================================================================
-- Migration 181: receipt capture, matching and chase (Wave 2B)
-- =============================================================================
-- FPB: docs/FPB-workforce-app.md §4.2, §4.9, §15 (audit RC-02…RC-08, RC-11).
-- Rides the Wave 1D request engine (core.requests kind 'receipt', migration 178).
--
-- §1  core.organizations.receipt_chase_enabled      tenant master switch (default ON)
-- §2  public.company_policies.receipt_chase_enabled per-client switch (null = follow tenant)
-- §3  public.receipt_policies                       threshold, memo, grace, window, reminder
--                                                   days, escalation, match tolerances
-- §4  public.card_assignments                       card → cardholder (+ opt-out w/ approval)
-- §5  public.receipt_charge_states                  one row per card charge the chase saw
-- §6  public.receipts (+ columns)                   capture / match / dedupe metadata
-- §7  public.workforce_links                        hashed magic links (Merit Workforce)
-- §8  RLS + grants                                  members SELECT their org; every write is
--                                                   the service role (the 171 pattern);
--                                                   workforce_links: service role only
-- §9  client-scope RLS re-applied (163)
--
-- M1 lesson: no new functions. Idempotent. PGlite-compatible (no subqueries in CHECK).
-- No GL effect. Apply to Supabase FIRST, then commit the code that uses it.
-- =============================================================================

-- ── §1 tenant switch ─────────────────────────────────────────────────────────
alter table core.organizations add column if not exists receipt_chase_enabled boolean not null default true;
alter table core.organizations add column if not exists receipt_chase_changed_at timestamptz;
alter table core.organizations add column if not exists receipt_chase_changed_by text;
comment on column core.organizations.receipt_chase_enabled is
  'Mig 181 (FPB-workforce-app §4.9): tenant master switch for receipt chase. Effective per client = this AND (company_policies.receipt_chase_enabled is null or true). Changes are audited (audit_log).';

-- ── §2 client switch ─────────────────────────────────────────────────────────
alter table public.company_policies add column if not exists receipt_chase_enabled boolean;
alter table public.company_policies add column if not exists receipt_chase_changed_at timestamptz;
alter table public.company_policies add column if not exists receipt_chase_changed_by text;
comment on column public.company_policies.receipt_chase_enabled is
  'Mig 181: per-client receipt chase switch. null = follow the tenant switch; false = off for this client; true = on (only effective when the tenant switch is on).';

-- ── §3 receipt_policies ──────────────────────────────────────────────────────
create table if not exists public.receipt_policies (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references core.organizations(id) on delete cascade,
  location_id                 uuid references core.locations(id) on delete cascade,
  receipt_required_over_cents bigint,
  memo_required               boolean,
  memo_required_over_cents    bigint,
  grace_days                  integer,
  chase_window_days           integer,
  reminder_days               integer[],
  escalate_to                 text,
  bookkeeper_membership_id    uuid references core.memberships(id) on delete set null,
  amount_tolerance_cents      bigint,
  tip_tolerance_bp            integer,
  date_window_days            integer,
  auto_match_min_score        numeric(4,3),
  suggest_min_score           numeric(4,3),
  digest_enabled              boolean,
  updated_by                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
comment on table public.receipt_policies is
  'Mig 181 (IA M-11): receipt policy. Tenant row (location_id null) + optional client rows; a null column inherits (client ← tenant ← code default). Written only by the service role (lib/receipts/policy.ts).';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'receipt_policies_values_chk') then
    alter table public.receipt_policies add constraint receipt_policies_values_chk
      check ((receipt_required_over_cents is null or receipt_required_over_cents between 0 and 100000000)
             and (memo_required_over_cents is null or memo_required_over_cents between 0 and 100000000)
             and (grace_days is null or grace_days between 0 and 30)
             and (chase_window_days is null or chase_window_days between 1 and 365)
             and (reminder_days is null or (cardinality(reminder_days) between 1 and 12))
             and (escalate_to is null or escalate_to in ('manager', 'bookkeeper', 'none'))
             and (amount_tolerance_cents is null or amount_tolerance_cents between 0 and 100000)
             and (tip_tolerance_bp is null or tip_tolerance_bp between 0 and 10000)
             and (date_window_days is null or date_window_days between 0 and 14)
             and (auto_match_min_score is null or auto_match_min_score between 0.5 and 1)
             and (suggest_min_score is null or suggest_min_score between 0.3 and 1));
  end if;
end $$;
create unique index if not exists ux_receipt_policies_tenant on public.receipt_policies (org_id) where location_id is null;
create unique index if not exists ux_receipt_policies_client on public.receipt_policies (org_id, location_id) where location_id is not null;

-- ── §4 card_assignments ──────────────────────────────────────────────────────
create table if not exists public.card_assignments (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references core.organizations(id) on delete cascade,
  location_id              uuid not null references core.locations(id) on delete cascade,
  bank_account_id          uuid references public.bank_accounts(id) on delete cascade,
  card_last4               text,
  card_label               text,
  holder_type              text not null default 'employee',
  membership_id            uuid references core.memberships(id) on delete set null,
  employee_id              uuid references core.employees(id) on delete set null,
  holder_name              text not null,
  holder_email             text,
  holder_phone             text,
  holder_timezone          text,
  manager_membership_id    uuid references core.memberships(id) on delete set null,
  active                   boolean not null default true,
  starts_on                date,
  ends_on                  date,
  chase_opt_out            boolean not null default false,
  opt_out_status           text not null default 'none',
  opt_out_reason           text,
  opt_out_requested_by     text,
  opt_out_requested_at     timestamptz,
  opt_out_decided_by       text,
  opt_out_decided_at       timestamptz,
  created_by               text,
  updated_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on table public.card_assignments is
  'Mig 181 (IA M-11 card_holders): who holds which card. A charge on bank_account_id (and, when set, carrying card_last4) belongs to this cardholder. Chase opt-out needs a second person''s approval. Written only by the service role.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'card_assignments_chk') then
    alter table public.card_assignments add constraint card_assignments_chk
      check ((bank_account_id is not null or card_last4 is not null)
             and (card_last4 is null or card_last4 ~ '^[0-9]{4}$')
             and holder_type in ('member', 'employee', 'external')
             and (holder_type <> 'member' or membership_id is not null)
             and length(holder_name) between 1 and 200
             and (holder_email is null or (holder_email = lower(holder_email) and length(holder_email) between 3 and 320))
             and (holder_phone is null or length(holder_phone) between 7 and 32)
             and (card_label is null or length(card_label) <= 80)
             and (ends_on is null or starts_on is null or ends_on >= starts_on)
             and opt_out_status in ('none', 'pending', 'approved', 'rejected')
             and (chase_opt_out = false or opt_out_status = 'approved'));
  end if;
end $$;
create unique index if not exists ux_card_assignments_live
  on public.card_assignments (org_id, coalesce(bank_account_id::text, ''), coalesce(card_last4, ''))
  where active;
create index if not exists ix_card_assignments_org on public.card_assignments (org_id, location_id, active);
create index if not exists ix_card_assignments_member on public.card_assignments (membership_id) where membership_id is not null;
create index if not exists ix_card_assignments_employee on public.card_assignments (employee_id) where employee_id is not null;
create index if not exists ix_card_assignments_email on public.card_assignments (org_id, holder_email) where holder_email is not null;

-- ── §5 receipt_charge_states ─────────────────────────────────────────────────
create table if not exists public.receipt_charge_states (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id) on delete cascade,
  bank_transaction_id  uuid not null references public.bank_transactions(id) on delete cascade,
  bank_account_id      uuid references public.bank_accounts(id) on delete set null,
  card_assignment_id   uuid references public.card_assignments(id) on delete set null,
  -- true when a person reassigned the charge to another cardholder (the sync keeps it).
  holder_override      boolean not null default false,
  charge_date          date not null,
  amount_cents         bigint not null,
  merchant             text,
  status               text not null,
  request_id           uuid references core.requests(id) on delete set null,
  receipt_id           uuid references public.receipts(id) on delete set null,
  chase_count          integer not null default 0,
  reason               text,
  decided_by           text,
  decided_at           timestamptz,
  first_seen_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.receipt_charge_states is
  'Mig 181: the receipt chase''s view of each card charge (needed / requested / matched / not_required / below_threshold / chase_off / no_cardholder / opted_out) with its request and receipt. Rebuilt idempotently by receipts.chase_sync; service role only.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'receipt_charge_states_chk') then
    alter table public.receipt_charge_states add constraint receipt_charge_states_chk
      check (status in ('needed', 'requested', 'matched', 'not_required', 'below_threshold', 'chase_off', 'no_cardholder', 'opted_out')
             and amount_cents >= 0
             and chase_count >= 0
             and (reason is null or length(reason) <= 500)
             and (status <> 'not_required' or reason is not null));
  end if;
end $$;
create unique index if not exists ux_receipt_charge_states_txn on public.receipt_charge_states (org_id, bank_transaction_id);
create index if not exists ix_receipt_charge_states_open on public.receipt_charge_states (org_id, status, charge_date);
create index if not exists ix_receipt_charge_states_holder on public.receipt_charge_states (card_assignment_id, status);

-- ── §6 receipts: capture / match metadata ────────────────────────────────────
alter table public.receipts add column if not exists submitted_by_user text;
alter table public.receipts add column if not exists card_assignment_id uuid references public.card_assignments(id) on delete set null;
alter table public.receipts add column if not exists document_id uuid references public.documents(id) on delete set null;
alter table public.receipts add column if not exists memo text;
alter table public.receipts add column if not exists job_id uuid references core.jobs(id) on delete set null;
alter table public.receipts add column if not exists match_status text not null default 'unmatched';
alter table public.receipts add column if not exists match_score numeric(5,4);
alter table public.receipts add column if not exists match_candidate_txn_id uuid references public.bank_transactions(id) on delete set null;
alter table public.receipts add column if not exists match_method text;
alter table public.receipts add column if not exists matched_at timestamptz;
alter table public.receipts add column if not exists matched_by text;
alter table public.receipts add column if not exists extraction_status text not null default 'pending';
alter table public.receipts add column if not exists content_sha256 text;
alter table public.receipts add column if not exists inbound_message_id text;
alter table public.receipts add column if not exists flags text[] not null default array[]::text[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'receipts_capture_chk') then
    alter table public.receipts add constraint receipts_capture_chk
      check (match_status in ('unmatched', 'suggested', 'matched', 'not_required')
             and (match_method is null or match_method in ('auto', 'confirmed', 'manual', 'request'))
             and extraction_status in ('pending', 'done', 'failed', 'skipped')
             and (match_score is null or match_score between 0 and 1)
             and (memo is null or length(memo) <= 1000)
             and (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$')
             and (match_status <> 'matched' or bank_transaction_id is not null));
  end if;
end $$;
-- One receipt per card charge; one receipt per identical file per tenant (dedupe).
create unique index if not exists ux_receipts_bank_txn on public.receipts (org_id, bank_transaction_id) where bank_transaction_id is not null;
create unique index if not exists ux_receipts_content on public.receipts (org_id, content_sha256) where content_sha256 is not null;
create index if not exists ix_receipts_match on public.receipts (org_id, match_status, submitted_at desc);
create index if not exists ix_receipts_holder on public.receipts (card_assignment_id) where card_assignment_id is not null;

-- ── §7 workforce_links ───────────────────────────────────────────────────────
create table if not exists public.workforce_links (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid references core.locations(id) on delete cascade,
  card_assignment_id  uuid not null references public.card_assignments(id) on delete cascade,
  purpose             text not null default 'receipts',
  token_hash          text not null,
  source_request_id   uuid references core.requests(id) on delete set null,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz not null default now()
);
comment on table public.workforce_links is
  'Mig 181: Merit Workforce magic links (receipts for ONE card assignment), stored only as sha256 hex. No member access at all; the server resolves a presented token by its hash.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workforce_links_chk') then
    alter table public.workforce_links add constraint workforce_links_chk
      check (token_hash ~ '^[0-9a-f]{64}$' and purpose in ('receipts'));
  end if;
end $$;
create unique index if not exists ux_workforce_links_hash on public.workforce_links (token_hash);
create index if not exists ix_workforce_links_assignment on public.workforce_links (card_assignment_id);

-- ── §8 RLS + grants ──────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['receipt_policies', 'card_assignments', 'receipt_charge_states', 'workforce_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists service_all on public.%I', t);
    if t <> 'workforce_links' then
      execute format('create policy member_read on public.%I for select to authenticated using (org_id is not null and org_id = public.get_org_id())', t);
    end if;
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    if t = 'workforce_links' then
      execute format('revoke select on table public.%I from authenticated', t);
    else
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── §9 client scope (every table above with a location_id) ───────────────────
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- End migration 181.
