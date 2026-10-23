-- =============================================================================
-- Migration 177: bank / card feed split transactions (Wave 1C, FPB-bank-feed-splits)
-- =============================================================================
-- Approving a feed line used to post exactly two GL lines. A split posts N lines in one
-- balanced JE (same company) or one balanced JE per company (cross-company, with the
-- INTERCOMPANY_AR / INTERCOMPANY_AP due-to/due-from pair tagged by counterparty).
--
-- §1  public.split_rules — "remember this split": vendor and/or description pattern →
--     a % allocation (allocations jsonb, basis points). One active rule per vendor per
--     company (location_id null = any company).
-- §2  public.bank_transaction_splits — one row per split line (DRAFT until posted, then
--     POSTED with the GL entry / line it produced). `location_id` is the TRANSACTION's
--     company (the owning client: client-scope RLS follows the bank line);
--     `allocation_location_id` is the company the line books to.
-- §3  guard: a POSTED split line can't be deleted, nor its money / coding rewritten; the
--     only change allowed is the reversal flow (POSTED → DRAFT with the GL links cleared and
--     the posting_version bumped). FK cascades (org teardown) and the ledger-purge GUC
--     (meritbooks.allow_ledger_purge, 152/153 — tenant reset / sandbox) pass.
-- §4  RLS: org isolation SELECT for members + service_all; members are SELECT-only (the
--     business-write-lock pattern, 171/172) — the app writes through the service role
--     after its permission check, org pin and client-scope assert (lib/db/scoped-writer.ts).
-- §5  client-scope RLS re-applied (both tables carry location_id).
--
-- M1 lesson: trigger functions EXECUTE-revoked from public / anon / authenticated.
-- Idempotent. PGlite-compatible (no subqueries in CHECK). Apply to Supabase FIRST.
-- Requires 004/005 (gl_entries, bank_transactions), 019 (core carve), 035 (counterparty).
-- =============================================================================

-- ── §1 split rules ───────────────────────────────────────────────────────────
create table if not exists public.split_rules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- The company (bank / card owner) the rule applies to; null = any company in the org.
  location_id uuid references core.locations(id) on delete cascade,
  vendor_id uuid references core.vendors(id) on delete cascade,
  -- Lower-cased, whitespace-collapsed substring of the bank description.
  description_pattern text,
  name text not null,
  -- [{percent_bp, account_id, allocation_location_id, department_id?, class_id?, job_id?,
  --   cost_code_id?, memo?}] — percent_bp sums to 10000 (validated in the app).
  allocations jsonb not null,
  is_active boolean not null default true,
  times_applied integer not null default 0,
  last_applied_at timestamptz,
  created_by text,                         -- Clerk user id (text), attribution only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint split_rules_target_chk check (vendor_id is not null or description_pattern is not null),
  constraint split_rules_pattern_chk check (description_pattern is null or length(description_pattern) between 3 and 200),
  constraint split_rules_name_chk check (length(name) between 1 and 120),
  constraint split_rules_alloc_chk check (
    jsonb_typeof(allocations) = 'array'
    and jsonb_array_length(allocations) between 1 and 50
  ),
  constraint split_rules_times_chk check (times_applied >= 0)
);

create index if not exists idx_split_rules_org_vendor on public.split_rules (org_id, vendor_id) where is_active;
create index if not exists idx_split_rules_org_loc on public.split_rules (org_id, location_id) where is_active;
-- One active vendor rule per company (org-wide rules use the zero uuid as their key).
create unique index if not exists uq_split_rules_active_vendor
  on public.split_rules (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), vendor_id)
  where is_active and vendor_id is not null;

-- ── §2 split lines ───────────────────────────────────────────────────────────
create table if not exists public.bank_transaction_splits (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  -- The transaction's company (owning client for client-scope RLS).
  location_id uuid not null references core.locations(id),
  line_no smallint not null,
  status text not null default 'DRAFT',
  amount_cents bigint not null,
  percent_bp integer,
  account_id uuid not null references public.accounts(id),
  -- The company this line books to (= location_id for a same-company line).
  allocation_location_id uuid not null references core.locations(id),
  department_id uuid references core.departments(id),
  class_id uuid references public.classes(id),
  job_id uuid references core.jobs(id),
  cost_code_id uuid references public.job_cost_codes(id),
  memo text,
  -- Bumped by each reversal; part of the GL source_ref so a re-post is a new posting.
  posting_version integer not null default 1,
  -- The posted JE (on allocation_location_id's books) and the GL line this split produced.
  gl_entry_id uuid references public.gl_entries(id) on delete set null,
  gl_entry_line_id uuid references public.gl_entry_lines(id) on delete set null,
  split_rule_id uuid references public.split_rules(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bts_line_no_chk check (line_no between 1 and 50),
  constraint bts_status_chk check (status in ('DRAFT', 'POSTED')),
  constraint bts_amount_chk check (amount_cents > 0),
  constraint bts_percent_chk check (percent_bp is null or (percent_bp > 0 and percent_bp <= 10000)),
  constraint bts_memo_chk check (memo is null or length(memo) <= 500),
  constraint bts_version_chk check (posting_version >= 1),
  constraint bts_posted_link_chk check (status <> 'POSTED' or gl_entry_id is not null or posted_at is not null)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uq_bts_txn_line') then
    alter table public.bank_transaction_splits
      add constraint uq_bts_txn_line unique (bank_transaction_id, line_no);
  end if;
end $$;

create index if not exists idx_bts_org_txn on public.bank_transaction_splits (org_id, bank_transaction_id);
create index if not exists idx_bts_gl_entry on public.bank_transaction_splits (gl_entry_id) where gl_entry_id is not null;
create index if not exists idx_bts_alloc_loc on public.bank_transaction_splits (org_id, allocation_location_id);

comment on table public.bank_transaction_splits is
  'Mig 177: one row per split line of a bank / card feed transaction. DRAFT until approved; POSTED rows link the JE (per company) and GL line they produced. Edits after posting go through reversal (void + version bump).';
comment on table public.split_rules is
  'Mig 177: remembered split allocations (percent, basis points) by vendor and/or description pattern, per company or org-wide.';

-- ── §3 posted-split guard ────────────────────────────────────────────────────
create or replace function public.guard_posted_bank_split() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  -- FK cascade from the parent bank transaction / org teardown.
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Org teardown / sandbox / tenant reset (the 152/153 ledger-purge GUC, server-side only).
  if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'POSTED' then
      raise exception 'A posted split line cannot be deleted; reverse the transaction first (migration 177).'
        using errcode = '42501';
    end if;
    return old;
  end if;
  -- UPDATE of a POSTED row
  if old.status = 'POSTED' then
    if new.status = 'DRAFT' and new.posting_version > old.posting_version
       and new.gl_entry_id is null and new.gl_entry_line_id is null then
      return new;                              -- the reversal flow
    end if;
    if new.status = 'POSTED'
       and (new.amount_cents, new.account_id, new.allocation_location_id, new.bank_transaction_id, new.line_no, new.posting_version)
           is not distinct from
           (old.amount_cents, old.account_id, old.allocation_location_id, old.bank_transaction_id, old.line_no, old.posting_version)
       and new.gl_entry_id is not distinct from old.gl_entry_id then
      return new;                              -- link / memo / rule stamping only
    end if;
    raise exception 'A posted split line is immutable; reverse the transaction to edit it (migration 177).'
      using errcode = '42501';
  end if;
  return new;
end
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_posted_bank_split'
                   and tgrelid = 'public.bank_transaction_splits'::regclass) then
    create trigger trg_guard_posted_bank_split
      before update or delete on public.bank_transaction_splits
      for each row execute function public.guard_posted_bank_split();
  end if;
end $$;

revoke all on function public.guard_posted_bank_split() from public, anon, authenticated;

-- ── §4 RLS + the business write lock ─────────────────────────────────────────
alter table public.split_rules enable row level security;
alter table public.bank_transaction_splits enable row level security;

do $$ begin
  create policy member_read on public.split_rules for select using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy service_all on public.split_rules for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy member_read on public.bank_transaction_splits for select using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy service_all on public.bank_transaction_splits for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Hosted Supabase grants new tables to anon / authenticated by default: revoke writes,
-- grant member reads, and give the service role DML explicitly.
revoke insert, update, delete, truncate on table public.split_rules from anon, authenticated;
revoke insert, update, delete, truncate on table public.bank_transaction_splits from anon, authenticated;
revoke all on table public.split_rules from anon;
revoke all on table public.bank_transaction_splits from anon;
grant select on table public.split_rules to authenticated;
grant select on table public.bank_transaction_splits to authenticated;
grant select, insert, update, delete on table public.split_rules to service_role;
grant select, insert, update, delete on table public.bank_transaction_splits to service_role;

-- End migration 177.

-- ── §5 client scope (both tables own a location_id) ─────────────────────────
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
