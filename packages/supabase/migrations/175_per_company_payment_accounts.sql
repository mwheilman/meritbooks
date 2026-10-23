-- =============================================================================
-- Migration 175: one Stripe account per company + honest live/test mode (Wave 1A)
-- =============================================================================
-- Audit 2026-10 §2.9 / PM-01 / PM-02 / BF-03; FPB-payments-fees §17.
--
-- THE GAP. core.provider_connections (041) had no company column and was unique on
-- (org, capability, provider, environment): ONE Stripe connected account per tenant, so
-- every company's customer payments would settle into one bank account. The same key
-- also let a second Plaid Item overwrite the first one's connection row (and its Vault
-- token reference).
--
-- §1  core.provider_connections.location_id (nullable = a tenant-level connection) with a
--     same-org guard, plus the cached Stripe account status the Payments screen shows:
--     charges / payouts enabled, details submitted, disabled reason, requirements due,
--     payout bank name + last 4, when it was last checked.
-- §2  Uniqueness: one row per (org, capability, provider, environment, company) — NULLS
--     NOT DISTINCT, so there is still exactly one tenant-level row — for every capability
--     except BANK_FEED, where a row is one Plaid Item: (org, …, environment, account_handle).
--     The app no longer upserts on the old key (lib/money/connections.ts selects, then
--     inserts or updates), so the partial indexes need no ON CONFLICT inference.
-- §3  core.org_payment_settings: account_mode 'per_company' (DEFAULT) | 'single' (explicit
--     opt-in: "one Stripe account for all companies").
-- §4  public.payment_test_runs: the "$1 test payment" helper's record (company,
--     environment, invoice, who, status). Only invoices recorded here can be refunded by
--     the helper.
-- §5  Write locks (171 pattern): every new table is SELECT-only for members; the app
--     writes through the service role after its permission check, org pinned.
--
-- SAFETY: no data change except dropping the old unique index (the existing rows satisfy
-- the new indexes: one Stripe row and one Plaid row per tenant today). No GL effect.
-- Idempotent. PGlite-compatible (no subqueries in CHECK; guards are triggers).
-- M1 lesson: every new function is EXECUTE-revoked from public / anon / authenticated,
-- then granted explicitly. Apply to Supabase FIRST, then the code.
-- =============================================================================

do $$
begin
  if to_regclass('core.provider_connections') is null then
    raise exception 'core.provider_connections not found — deploy migration 041 before 175.';
  end if;
end $$;

-- ── §1 company + cached account status ───────────────────────────────────────
alter table core.provider_connections add column if not exists location_id        uuid;
alter table core.provider_connections add column if not exists charges_enabled    boolean;
alter table core.provider_connections add column if not exists payouts_enabled    boolean;
alter table core.provider_connections add column if not exists details_submitted  boolean;
alter table core.provider_connections add column if not exists disabled_reason    text;
alter table core.provider_connections add column if not exists requirements_due   text[] not null default '{}'::text[];
alter table core.provider_connections add column if not exists payout_bank_name   text;
alter table core.provider_connections add column if not exists payout_bank_last4  text;
alter table core.provider_connections add column if not exists status_checked_at  timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'provider_connections_location_fk') then
    alter table core.provider_connections
      add constraint provider_connections_location_fk
      foreign key (location_id) references core.locations(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'provider_connections_payout_last4_chk') then
    alter table core.provider_connections
      add constraint provider_connections_payout_last4_chk
      check (payout_bank_last4 is null or payout_bank_last4 ~ '^[0-9]{4}$');
  end if;
end $$;

comment on column core.provider_connections.location_id is
  'Mig 175: the company (core.locations) this connection belongs to — e.g. that company''s own Stripe connected account. NULL = a tenant-level connection (used for collections only when core.org_payment_settings.account_mode = ''single'').';
comment on column core.provider_connections.payout_bank_last4 is
  'Mig 175: last 4 digits of the payout bank account Stripe reports for the connected account (display + change audit only; never a full account number).';

-- A connection's company must belong to the connection's tenant (FKs never check the org).
create or replace function core.provider_connections_location_guard() returns trigger
  language plpgsql set search_path = core, public, pg_temp as
$$
begin
  if new.location_id is not null and not exists (
    select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id
  ) then
    raise exception 'That company is not part of this organization.' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke all on function core.provider_connections_location_guard() from public, anon, authenticated;
grant execute on function core.provider_connections_location_guard() to service_role;

drop trigger if exists trg_provider_connections_location_guard on core.provider_connections;
create trigger trg_provider_connections_location_guard
  before insert or update of location_id, org_id on core.provider_connections
  for each row execute function core.provider_connections_location_guard();

-- ── §2 uniqueness ────────────────────────────────────────────────────────────
drop index if exists core.uq_provider_connections_scope;

create unique index if not exists uq_provider_connections_company
  on core.provider_connections (org_id, capability, provider, environment, location_id) nulls not distinct
  where capability <> 'BANK_FEED';

create unique index if not exists uq_provider_connections_bank_item
  on core.provider_connections (org_id, capability, provider, environment, account_handle)
  where capability = 'BANK_FEED';

-- Webhooks resolve a connected account id → connection → company.
create index if not exists ix_provider_connections_account_handle
  on core.provider_connections (account_handle) where account_handle is not null;

-- ── §3 tenant payment settings ───────────────────────────────────────────────
create table if not exists core.org_payment_settings (
  org_id        uuid primary key references core.organizations(id) on delete cascade,
  account_mode  text not null default 'per_company'
                  check (account_mode in ('per_company', 'single')),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
comment on table core.org_payment_settings is
  'Mig 175: tenant payment-collection settings. account_mode per_company (default) = each company collects into its own Stripe account; single = every company uses the one tenant-level account (explicit opt-in). No row = per_company.';

-- ── §4 the $1 test-payment helper's record ───────────────────────────────────
create table if not exists public.payment_test_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null,
  location_id        uuid not null references core.locations(id) on delete restrict,
  invoice_id         uuid references public.invoices(id) on delete set null,
  connection_id      uuid references core.provider_connections(id) on delete set null,
  environment        text not null check (environment in ('test', 'live')),
  amount_cents       bigint not null check (amount_cents > 0),
  status             text not null default 'CREATED'
                       check (status in ('CREATED', 'CANCELLED', 'REFUNDED')),
  payment_intent_id  text,
  refund_id          text,
  created_by         text not null,
  created_at         timestamptz not null default now(),
  closed_by          text,
  closed_at          timestamptz,
  updated_at         timestamptz not null default now()
);
comment on table public.payment_test_runs is
  'Mig 175: one row per "$1 test payment" (Settings → Payments). Status CREATED → CANCELLED (voided before payment) or REFUNDED (paid, then refunded; GL entries voided). Paid-ness is read from the invoice.';

create unique index if not exists uq_payment_test_runs_invoice on public.payment_test_runs (invoice_id) where invoice_id is not null;
create index if not exists ix_payment_test_runs_org_loc on public.payment_test_runs (org_id, location_id, created_at desc);

create or replace function public.payment_test_runs_guard() returns trigger
  language plpgsql set search_path = public, core, pg_temp as
$$
begin
  if not exists (select 1 from core.locations l where l.id = new.location_id and l.org_id = new.org_id) then
    raise exception 'That company is not part of this organization.' using errcode = 'check_violation';
  end if;
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.invoice_id and i.org_id = new.org_id
  ) then
    raise exception 'That invoice is not part of this organization.' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
revoke all on function public.payment_test_runs_guard() from public, anon, authenticated;
grant execute on function public.payment_test_runs_guard() to service_role;

drop trigger if exists trg_payment_test_runs_guard on public.payment_test_runs;
create trigger trg_payment_test_runs_guard
  before insert or update on public.payment_test_runs
  for each row execute function public.payment_test_runs_guard();

-- ── §5 RLS + write locks (SELECT-only for members) ───────────────────────────
alter table core.org_payment_settings enable row level security;
alter table public.payment_test_runs  enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'org_payment_settings' and policyname = 'member_read') then
    create policy member_read on core.org_payment_settings for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'org_payment_settings' and policyname = 'service_all') then
    create policy service_all on core.org_payment_settings for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_test_runs' and policyname = 'member_read') then
    create policy member_read on public.payment_test_runs for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_test_runs' and policyname = 'service_all') then
    create policy service_all on public.payment_test_runs for all to service_role using (true) with check (true);
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['core.org_payment_settings', 'public.payment_test_runs'] loop
    execute format('revoke insert, update, delete, truncate on table %s from anon, authenticated', t);
    execute format('grant select on table %s to authenticated', t);
    execute format('grant select, insert, update, delete on table %s to service_role', t);
  end loop;
end $$;

-- provider_connections stays as 171 left it (SELECT-only for members); re-assert the grant
-- revoke so the new columns cannot be written over PostgREST by a member either.
revoke insert, update, delete, truncate on table core.provider_connections from anon, authenticated;

-- ── verification ─────────────────────────────────────────────────────────────
do $$
begin
  raise notice 'Migration 175 OK: location_id=%, settings=%, test_runs=%',
    exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'provider_connections' and column_name = 'location_id'),
    to_regclass('core.org_payment_settings') is not null,
    to_regclass('public.payment_test_runs') is not null;
end $$;

-- End migration 175.

-- Re-apply client-scope RLS (163): provider_connections and payment_test_runs now carry an
-- owning location_id, so they get the RESTRICTIVE client_scope_rls policy (a tenant-level
-- connection, location_id null, stays visible to every member of the tenant).
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
