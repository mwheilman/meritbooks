-- Migration 077: Book-to-tax difference tagging + Schedule M-1/M-3 substrate (TX-C1/C2)
-- =============================================================
-- "The single richest AI opportunity" (AI-Capability-Matrix TX-C1, tax-compliance §1.3,
-- FPB EC-9): book income ≠ taxable income. This migration adds the tagging substrate the
-- deterministic M-1/M-3 engine (`apps/web/src/lib/tax/book-tax.ts`) reads to bridge BOOK
-- net income → TAXABLE income, classifying every difference PERMANENT vs TEMPORARY on a
-- labeled Schedule M-1 line — a ledger dimension that ties to the GL by construction,
-- replacing the 40-hour year-end reconstruction where book NI moves 5–25%.
--
-- Three additive, RLS-isolated structures:
--   1. book_tax_m_lines        — a per-tenant REFERENCE of standard M-1/M-3 adjustment
--                                lines (meals 50%, penalties/fines permanent, federal tax,
--                                tax-exempt interest, book/tax depreciation temporary,
--                                accruals/prepaids/reserves). Seeded idempotently by
--                                seed_book_tax_m_lines(org). The canonical catalog also
--                                lives in book-tax.ts so the ENGINE is self-contained and
--                                deterministic even before this table is seeded.
--   2. book_tax_account_tags   — per-ACCOUNT default M-adjustment classification
--                                (account_id → difference_type, m_line code, taxable_effect,
--                                disallowance_pct). The main M-1 driver: an account's period
--                                activity × disallowance_pct becomes its add-back/subtraction.
--   3. book_tax_line_overrides — per-TRANSACTION (gl_entry_line) override for a specific
--                                line whose tax character differs from its account default,
--                                or to pin an explicit timing-difference amount (e.g. the
--                                book-vs-tax depreciation delta) the account balance can't
--                                imply. An overridden line is EXCLUDED from its account's
--                                tag activity so it is never double-counted.
--
-- DEGRADE SAFE: with zero tags/overrides the M-1 shows book NI = taxable income and an
-- empty adjustments list. Nothing here posts, moves money, or touches the GL — the AI
-- proposes a TAG (never a number) into public.ai_decisions (feature 'BOOK_TAX_TAG'); a
-- human confirms; the engine does deterministic arithmetic (canon §3).
--
-- Additive + idempotent (create-if-not-exists). RLS org_isolation via get_org_id().
-- Money is bigint cents. Requires 003 (accounts), 004 (gl_entries/gl_entry_lines).
-- Books band; next migration number: 078.
-- =============================================================

-- ---- Guard: the tables these reference must exist ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'accounts') then
    raise exception 'public.accounts not found — deploy migration 003 before 077.';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'gl_entry_lines') then
    raise exception 'public.gl_entry_lines not found — deploy migration 004 before 077.';
  end if;
end $$;

-- =============================================================
-- 1. REFERENCE — standard M-1/M-3 adjustment lines (per-tenant, seedable)
-- =============================================================
-- One row = a named book-tax difference type and how it maps onto Schedule M-1
-- (form 1120) / M-3. `difference_type` PERMANENT never reverses (meals, penalties,
-- tax-exempt income); TEMPORARY reverses in a later year (depreciation, accruals) and
-- is the input the ASC 740 deferred-tax provision needs. `taxable_effect` ADD increases
-- taxable income above book (a nondeductible book expense / book-only income);
-- SUBTRACT decreases it (tax-only deduction / book-only tax-exempt income).
-- `default_disallowance_pct` = the fraction of the account's book activity that is the
-- difference (50 for meals, 100 for penalties/fed tax); NULL for pure timing items whose
-- amount must be supplied explicitly (a depreciation delta, an accrual), not implied by a
-- single account balance.
create table if not exists public.book_tax_m_lines (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  code text not null,                                   -- stable machine code, e.g. 'MEALS_50'
  label text not null,                                  -- human label for the M-1 line
  m1_line text,                                          -- Schedule M-1 line ref, e.g. '5c', '8a'
  difference_type text not null
    check (difference_type in ('PERMANENT', 'TEMPORARY')),
  taxable_effect text not null
    check (taxable_effect in ('ADD', 'SUBTRACT')),
  default_disallowance_pct numeric(6,3)
    check (default_disallowance_pct is null
           or (default_disallowance_pct >= 0 and default_disallowance_pct <= 100)),
  code_section text,                                     -- cited IRC section, e.g. '§274(n)'
  description text,
  is_standard boolean not null default true,             -- false = tenant-authored custom line
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, code)
);

create index if not exists idx_book_tax_m_lines_org
  on public.book_tax_m_lines(org_id) where active;

-- =============================================================
-- 2. PER-ACCOUNT default classification (the main M-1 driver)
-- =============================================================
create table if not exists public.book_tax_account_tags (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  m_line_code text not null,                             -- FK-by-value to book_tax_m_lines.code
  difference_type text not null
    check (difference_type in ('PERMANENT', 'TEMPORARY')),
  taxable_effect text not null
    check (taxable_effect in ('ADD', 'SUBTRACT')),
  -- Overrides the reference-line default when set; NULL = use the m_line's default
  -- (which itself may be NULL for a timing item that needs an explicit amount).
  disallowance_pct numeric(6,3)
    check (disallowance_pct is null
           or (disallowance_pct >= 0 and disallowance_pct <= 100)),
  note text,
  -- Provenance: how this tag was set (manual human, or a confirmed AI proposal).
  source text not null default 'MANUAL'
    check (source in ('MANUAL', 'AI_CONFIRMED', 'IMPORT')),
  ai_decision_id uuid references public.ai_decisions(id) on delete set null,
  created_by uuid,                                       -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One default classification per account.
  unique(org_id, account_id)
);

create index if not exists idx_book_tax_account_tags_org
  on public.book_tax_account_tags(org_id);
create index if not exists idx_book_tax_account_tags_account
  on public.book_tax_account_tags(account_id);

-- =============================================================
-- 3. PER-TRANSACTION (gl_entry_line) override
-- =============================================================
-- A specific line whose tax character differs from its account default, or a pinned
-- explicit timing difference. `override_amount_cents` NULL = derive from the line's
-- activity × the effective disallowance_pct; non-NULL = use exactly that amount (the
-- audit-defensible way to record a depreciation delta or a one-off adjustment).
create table if not exists public.book_tax_line_overrides (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  gl_entry_line_id uuid not null references gl_entry_lines(id) on delete cascade,
  m_line_code text not null,                             -- FK-by-value to book_tax_m_lines.code
  difference_type text not null
    check (difference_type in ('PERMANENT', 'TEMPORARY')),
  taxable_effect text not null
    check (taxable_effect in ('ADD', 'SUBTRACT')),
  disallowance_pct numeric(6,3)
    check (disallowance_pct is null
           or (disallowance_pct >= 0 and disallowance_pct <= 100)),
  override_amount_cents bigint,                          -- explicit pinned difference (cents)
  note text,
  source text not null default 'MANUAL'
    check (source in ('MANUAL', 'AI_CONFIRMED', 'IMPORT')),
  ai_decision_id uuid references public.ai_decisions(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One override per line.
  unique(org_id, gl_entry_line_id)
);

create index if not exists idx_book_tax_line_overrides_org
  on public.book_tax_line_overrides(org_id);
create index if not exists idx_book_tax_line_overrides_line
  on public.book_tax_line_overrides(gl_entry_line_id);

-- =============================================================
-- 4. RLS — org isolation via get_org_id() (Clerk org_id claim; never auth.uid())
-- =============================================================
alter table public.book_tax_m_lines        enable row level security;
alter table public.book_tax_account_tags   enable row level security;
alter table public.book_tax_line_overrides enable row level security;

do $$ begin
  create policy "org_isolation" on public.book_tax_m_lines
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on public.book_tax_account_tags
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "org_isolation" on public.book_tax_line_overrides
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.book_tax_m_lines        to anon, authenticated, service_role;
grant select, insert, update, delete on public.book_tax_account_tags   to anon, authenticated, service_role;
grant select, insert, update, delete on public.book_tax_line_overrides to anon, authenticated, service_role;

-- Keep updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_book_tax_m_lines_updated
        before update on public.book_tax_m_lines
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
    begin
      create trigger trg_book_tax_account_tags_updated
        before update on public.book_tax_account_tags
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
    begin
      create trigger trg_book_tax_line_overrides_updated
        before update on public.book_tax_line_overrides
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- =============================================================
-- 5. SEED — the standard M-1/M-3 reference catalog for a tenant (idempotent)
-- =============================================================
-- Mirrors STANDARD_M_LINES in apps/web/src/lib/tax/book-tax.ts. Safe to re-run: an
-- existing (org, code) row is refreshed, never duplicated. Call per tenant at onboarding
-- (or on-demand from the tagging UI). The engine does NOT depend on this seed — it uses
-- its own code-defined catalog — so an unseeded tenant still computes a correct M-1.
create or replace function public.seed_book_tax_m_lines(p_org uuid)
returns void as $$
begin
  insert into public.book_tax_m_lines
    (org_id, code, label, m1_line, difference_type, taxable_effect, default_disallowance_pct, code_section, description, is_standard)
  values
    (p_org, 'MEALS_50',           'Meals — 50% nondeductible',                '5c', 'PERMANENT', 'ADD',      50,   '§274(n)',      'Business meals are only 50% deductible; add back the disallowed half.', true),
    (p_org, 'ENTERTAINMENT',      'Entertainment — 100% nondeductible',       '5c', 'PERMANENT', 'ADD',      100,  '§274(a)',      'Entertainment is fully nondeductible post-TCJA.', true),
    (p_org, 'PENALTIES_FINES',    'Penalties & fines',                        '5c', 'PERMANENT', 'ADD',      100,  '§162(f)',      'Government penalties and fines are never deductible.', true),
    (p_org, 'FED_INCOME_TAX',     'Federal income tax per books',             '2',  'PERMANENT', 'ADD',      100,  '§275',         'Federal income tax expensed on the books is not deductible.', true),
    (p_org, 'POLITICAL_LOBBYING', 'Political & lobbying',                     '5c', 'PERMANENT', 'ADD',      100,  '§162(e)',      'Political contributions and most lobbying are nondeductible.', true),
    (p_org, 'CLUB_DUES',          'Club dues',                                '5c', 'PERMANENT', 'ADD',      100,  '§274(a)(3)',   'Social, athletic and business club dues are nondeductible.', true),
    (p_org, 'OFFICER_LIFE_INS',   'Officer life-insurance premiums',          '5c', 'PERMANENT', 'ADD',      100,  '§264',         'Premiums where the company is beneficiary are nondeductible.', true),
    (p_org, 'FINES_50_MEALS_ENT', 'Meals & entertainment (blended)',          '5c', 'PERMANENT', 'ADD',      100,  '§274',         'Fully-disallowed meals/entertainment where no 50% class applies.', true),
    (p_org, 'TAX_EXEMPT_INTEREST','Tax-exempt interest income',               '7',  'PERMANENT', 'SUBTRACT', 100,  '§103',         'Municipal-bond interest is book income excluded from taxable income.', true),
    (p_org, 'MEALS_ENT_NONDED',   'Nondeductible fringe / gifts over limit',  '5c', 'PERMANENT', 'ADD',      100,  '§274',         'Gifts over $25 and other nondeductible fringes.', true),
    (p_org, 'BOOK_DEPR_EXCESS',   'Book depreciation over tax',               '5a', 'TEMPORARY', 'ADD',      null, '§167/§168',    'Book depreciation exceeds tax — add the excess (reverses later).', true),
    (p_org, 'TAX_DEPR_EXCESS',    'Tax depreciation over book (§179/bonus)',  '8a', 'TEMPORARY', 'SUBTRACT', null, '§168/§179',    'Tax depreciation (MACRS/§179/bonus) exceeds book — subtract the excess.', true),
    (p_org, 'BAD_DEBT_RESERVE',   'Bad-debt reserve vs write-off',            '5',  'TEMPORARY', 'ADD',      null, '§166',         'Book reserve method vs tax specific-charge-off — timing difference.', true),
    (p_org, 'ACCRUED_EXPENSE',    'Accrued expense not yet deductible',       '5',  'TEMPORARY', 'ADD',      null, '§461',         'Accrued but unpaid expenses failing the all-events/economic-performance test.', true),
    (p_org, 'ACCRUED_BONUS',      'Accrued bonuses / vacation',               '5',  'TEMPORARY', 'ADD',      null, '§461',         'Accrued comp not paid within 2½ months — deferred to when paid.', true),
    (p_org, 'PREPAID_EXPENSE',    'Prepaid deducted on return',               '8',  'TEMPORARY', 'SUBTRACT', null, '§263',         'Prepaid amounts deductible for tax ahead of book amortization.', true),
    (p_org, 'WARRANTY_RESERVE',   'Warranty / other reserves',                '5',  'TEMPORARY', 'ADD',      null, '§461',         'Estimated reserves are book-only until the obligation is fixed.', true),
    (p_org, 'SEC_174_RD',         '§174 R&D capitalization',                  '5',  'TEMPORARY', 'ADD',      null, '§174',         'R&D now mandatorily capitalized/amortized for tax — add book expense excess.', true),
    (p_org, 'DEFERRED_REVENUE',   'Deferred revenue timing',                  '4',  'TEMPORARY', 'ADD',      null, '§451',         'Revenue taxable when received but deferred for book.', true),
    (p_org, 'CHARITABLE_CARRY',   'Charitable contributions over 10% limit',  '5',  'TEMPORARY', 'ADD',      null, '§170',         'Contributions exceeding the 10% taxable-income limit carry forward.', true)
  on conflict (org_id, code) do update set
    label = excluded.label,
    m1_line = excluded.m1_line,
    difference_type = excluded.difference_type,
    taxable_effect = excluded.taxable_effect,
    default_disallowance_pct = excluded.default_disallowance_pct,
    code_section = excluded.code_section,
    description = excluded.description,
    is_standard = true,
    updated_at = now();
end;
$$ language plpgsql;

-- =============================================================
-- DONE. The tenant can now tag accounts / lines with a book-tax character and the
-- deterministic engine produces a Schedule M-1 (and M-3 permanent/temporary summary)
-- from book net income. Absent any tag, taxable income = book net income. No money
-- moves; the AI only proposes a tag a human confirms.
-- =============================================================
