-- Migration 036: Subcontractor retainage payable (Session 22)
-- =============================================================
-- The AR side already withholds retainage on progress bills (invoices carry
-- retainage_cents; the RETAINAGE_RECEIVABLE role 1110 holds it; the `retainage`
-- posting template releases it). This is the symmetric AP side:
--
--   When a (subcontractor) bill is entered with a retainage %, the FULL cost is
--   still recognized as expense, but only (subtotal + tax − retainage) is the
--   currently-due payable. The withheld portion is parked in RETAINAGE PAYABLE
--   (role RETAINAGE_PAYABLE / 2010, seeded in 029) until the work is accepted,
--   then released and paid.
--
--   Bill approval GL (when retainage > 0):
--     DR expense lines (subtotal) + DR tax            = subtotal + tax
--     CR Accounts Payable     (bills.total_cents)     = subtotal + tax − retainage
--     CR Retainage Payable    (bills.retainage_cents) = retainage
--   Balanced; expense recognized in full; AP reflects only what's due now.
--
--   Release (per the retainage register): DR Retainage Payable / CR Operating
--   bank for the released amount, tracked in retainage_releases. Partial releases
--   allowed; outstanding = retainage_cents − Σ released.
--
-- Additive + idempotent. Requires 005 (bills), 029 (account roles). Next: 037.
-- =============================================================

-- ---- Guard ----
do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'bills') then
    raise exception 'public.bills not found — deploy migration 005 before 036.';
  end if;
end $$;

-- =============================================================
-- 1. RETAINAGE on bills (mirrors invoices.retainage_cents on the AR side)
-- =============================================================
-- bills.total_cents is the currently-due amount (already NET of retainage);
-- retainage_cents is the withheld portion held in Retainage Payable.
alter table public.bills
  add column if not exists retainage_pct numeric(5,2) not null default 0
    check (retainage_pct >= 0 and retainage_pct <= 100),
  add column if not exists retainage_cents bigint not null default 0
    check (retainage_cents >= 0);

-- =============================================================
-- 2. Optional per-vendor default retainage % (prefills the bill form)
-- =============================================================
-- vendors live in core (migration 019).
alter table core.vendors
  add column if not exists default_retainage_pct numeric(5,2) not null default 0
    check (default_retainage_pct >= 0 and default_retainage_pct <= 100);

-- =============================================================
-- 3. RETAINAGE RELEASES (each release of withheld retainage, with its GL entry)
-- =============================================================
create table if not exists public.retainage_releases (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  release_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  payment_method text,
  memo text,
  gl_entry_id uuid references public.gl_entries(id),
  created_by uuid,                      -- nullable; never a Clerk id (see 018)
  created_at timestamptz not null default now()
);

create index if not exists idx_retainage_releases_bill on public.retainage_releases(bill_id);
create index if not exists idx_retainage_releases_org  on public.retainage_releases(org_id);

alter table public.retainage_releases enable row level security;
do $$ begin
  create policy "org_isolation" on public.retainage_releases
    for all using (org_id = public.get_org_id());
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.retainage_releases
  to anon, authenticated, service_role;

-- =============================================================
-- DONE. Bills can withhold retainage payable; the register releases + pays it.
-- =============================================================
