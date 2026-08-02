-- Migration 091: Income Tax Provision (ASC 740) — current + deferred tax substrate
-- =============================================================
-- ASC 740 bridges BOOK net income to the income-tax expense a company reports. It builds
-- directly on the book-to-tax difference engine (migration 077 + apps/web/src/lib/tax/
-- book-tax.ts / m1-report.ts): the Schedule M-1/M-3 reconciliation splits every difference
-- PERMANENT vs TEMPORARY, and THAT split is exactly the ASC 740 input —
--
--   current tax      = taxable income × statutory rate      (what you owe this year)
--   deferred tax     = temporary differences × statutory rate → change in DTA / DTL
--   total provision  = (pretax book income + permanent net) × statutory rate
--
-- Permanent differences move the effective rate; temporary differences only shift tax
-- between current (payable) and deferred (DTA/DTL) — they wash out of the total. The math
-- lives in the PURE, unit-tested engine apps/web/src/lib/tax/provision.ts; this migration is
-- only the persistence substrate for a computed-then-human-approved provision and its
-- balanced provision journal entry.
--
-- Two additive, RLS-isolated structures:
--   1. tax_provision       — one row per (org, entity/location, period). Snapshots the
--                            statutory rate, pretax book income, permanent/temporary net,
--                            taxable income, current tax, deferred tax, the DTA/DTL balance
--                            change, effective rate, and lifecycle status. The computed
--                            provision is PROPOSED; a human approves; posting stamps the
--                            gl_entry_id + source_ref of the balanced provision JE.
--   2. deferred_tax_items  — the per-line temporary-difference detail behind the deferred
--                            column (which M-1 line, how much timing difference, the deferred
--                            tax, and whether it lands in the deferred tax ASSET or LIABILITY).
--
-- DEGRADE SAFE: nothing here posts, moves money, or touches the GL. The engine computes the
-- numbers deterministically from book NI + the M-1 permanent/temporary split; a human
-- approves; the provision JE posts through the deterministic postJournalEntry (debits =
-- credits or it does not post), resolving income-tax-expense / income-taxes-payable /
-- deferred-tax-asset / deferred-tax-liability accounts BY ROLE (canon §2/§3).
--
-- Additive + idempotent (create-if-not-exists). RLS org_isolation via get_org_id().
-- Money is bigint cents. Requires 001 (core.organizations), 004 (gl_entries), 077 (book_tax).
-- Books band; next migration number: 092.
-- =============================================================

-- ---- Guard: the tables this references must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy the foundation migration before 091.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'gl_entries') then
    raise exception 'public.gl_entries not found — deploy migration 004 before 091.';
  end if;
end $$;

-- =============================================================
-- 1. tax_provision — one computed-then-approved provision per (org, location, period)
-- =============================================================
create table if not exists public.tax_provision (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  -- Entity/company the provision is booked to (JE posts to one location). NULL = org-wide /
  -- consolidated preview (not directly postable). No FK: locations live in core and this stays
  -- additive/decoupled; RLS still isolates by org_id.
  location_id uuid,
  -- Human period label, e.g. 'FY2026' or '2026-01..2026-12'. The authoritative bounds are the
  -- start/end dates below.
  period text not null,
  start_date date not null,
  end_date date not null,
  -- Statutory income-tax rate applied (percent, e.g. 21.000).
  statutory_rate numeric(6,3) not null
    check (statutory_rate >= 0 and statutory_rate <= 100),
  -- Snapshot of the inputs + results (all bigint cents; deferred/effective can be negative).
  pretax_book_income_cents bigint not null default 0,
  permanent_diff_cents bigint not null default 0,   -- net permanent (additions − subtractions)
  temporary_diff_cents bigint not null default 0,   -- net temporary (additions − subtractions)
  taxable_income_cents bigint not null default 0,
  current_tax_cents bigint not null default 0,      -- taxable income × rate (payable this year)
  deferred_tax_cents bigint not null default 0,     -- deferred tax expense (+) / benefit (−)
  total_provision_cents bigint not null default 0,  -- current + deferred (the reported expense)
  -- Deferred-tax balance change this period: increase in DTA (from deductible temp diffs) and
  -- DTL (from taxable temp diffs), and the net DTA position change (dta − dtl).
  dta_change_cents bigint not null default 0,
  dtl_change_cents bigint not null default 0,
  dta_dtl_balance_cents bigint not null default 0,  -- net deferred tax asset (dta − dtl)
  effective_rate_pct numeric(9,4) not null default 0,
  status text not null default 'PROPOSED'
    check (status in ('DRAFT', 'PROPOSED', 'POSTED', 'VOID')),
  -- Set when the provision JE is posted (idempotency: source_ref guards a double post).
  gl_entry_id uuid references public.gl_entries(id) on delete set null,
  source_ref text,
  note text,
  created_by uuid,                                   -- nullable; never a Clerk id (see canon)
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tax_provision_org
  on public.tax_provision(org_id);
create index if not exists idx_tax_provision_period
  on public.tax_provision(org_id, start_date, end_date);
create index if not exists idx_tax_provision_status
  on public.tax_provision(org_id, status);

-- One provision per (org, entity, period). COALESCE lets a NULL location behave as a single
-- consolidated slot without violating uniqueness.
create unique index if not exists uq_tax_provision_period
  on public.tax_provision(
    org_id,
    coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    start_date,
    end_date
  );

-- =============================================================
-- 2. deferred_tax_items — per-line temporary-difference detail behind the deferred column
-- =============================================================
create table if not exists public.deferred_tax_items (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  provision_id uuid not null references public.tax_provision(id) on delete cascade,
  m_line_code text not null,                         -- FK-by-value to book_tax_m_lines.code
  label text,
  difference_type text not null default 'TEMPORARY'
    check (difference_type in ('PERMANENT', 'TEMPORARY')),
  temporary_diff_cents bigint not null default 0,    -- signed temp diff (add +, subtract −)
  deferred_tax_cents bigint not null default 0,      -- temp diff × rate (the deferred effect)
  -- Which deferred balance this line rolls into: a deductible temp diff builds a Deferred Tax
  -- ASSET; a taxable temp diff builds a Deferred Tax LIABILITY.
  category text not null
    check (category in ('DTA', 'DTL')),
  created_at timestamptz not null default now()
);

create index if not exists idx_deferred_tax_items_org
  on public.deferred_tax_items(org_id);
create index if not exists idx_deferred_tax_items_provision
  on public.deferred_tax_items(provision_id);

-- =============================================================
-- 3. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
alter table public.tax_provision      enable row level security;
alter table public.deferred_tax_items enable row level security;

do $$ begin
  create policy "org_isolation" on public.tax_provision
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on public.deferred_tax_items
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.tax_provision      to anon, authenticated, service_role;
grant select, insert, update, delete on public.deferred_tax_items to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_tax_provision_updated
        before update on public.tax_provision
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================
-- DONE. The tenant can compute an ASC 740 provision (current + deferred) from book net
-- income and the M-1 permanent/temporary split, save it PROPOSED, and — on human approval —
-- post a single balanced provision JE (income tax expense / income taxes payable + deferred
-- tax asset/liability). Absent any activity the provision is zero and nothing posts.
-- =============================================================
