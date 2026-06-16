-- =============================================================================
-- Migration 050: Invoice Product Foundation (FPB §2/§3/§5/§11a — document layer)
-- =============================================================================
-- Stands up the data the invoice *product* needs (beyond "it posts"):
--   1. Capture columns on public.invoices (PO, sales rep, customer message,
--      internal note, bill-to/ship-to snapshot, header discount, payment-method
--      override, and a public_token for the hosted customer view).
--   2. The payment-method authorization CASCADE columns on core.locations
--      (entity default), core.customers, core.jobs — resolved most-specific-wins
--      invoice -> job -> customer -> entity (mirrors the rev-rec resolver).
--   3. public.invoice_events — append-only lifecycle log (created/posted/sent/
--      viewed/paid/...). The spine for "opened 3×, last on…".
--   4. public.invoice_templates — per-entity branding for the PDF / hosted view
--      (logo, remit-to, accent color, footer, default customer message).
--
-- No money-movement here. Provider adapter, surcharge, and payment posting land
-- in the next migration (051) with the payments package. Idempotent. cents=bigint.
-- =============================================================================

-- ---- Guards -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='invoices') then
    raise exception 'public.invoices not found — deploy 008 (sub-ledgers) before 050.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema='core' and table_name='customers') then
    raise exception 'core.customers not found — deploy 019 (core carve) before 050.';
  end if;
end $$;

-- =============================================================================
-- 1. Invoice capture columns
-- =============================================================================
alter table public.invoices add column if not exists po_number            text;
alter table public.invoices add column if not exists sales_rep            text;
alter table public.invoices add column if not exists customer_message     text;   -- prints on the invoice
alter table public.invoices add column if not exists internal_note        text;   -- never prints
alter table public.invoices add column if not exists bill_to              jsonb;  -- snapshot at issue
alter table public.invoices add column if not exists ship_to              jsonb;  -- snapshot at issue
alter table public.invoices add column if not exists discount_cents       bigint  not null default 0;
alter table public.invoices add column if not exists terms                text;   -- 'NET_30' etc; informational, due_date is source of truth
alter table public.invoices add column if not exists public_token         uuid    not null default gen_random_uuid();

-- Per-invoice override of the authorized payment methods (null = inherit up the
-- cascade). Values are an array of method codes, e.g. '{ACH}', '{ACH,CARD}'.
alter table public.invoices add column if not exists payment_methods_allowed text[];

-- Backfill tokens for any rows created before the default existed, and lock the
-- token unique so the hosted-view URL is a stable, unguessable key.
update public.invoices set public_token = gen_random_uuid() where public_token is null;
create unique index if not exists invoices_public_token_uq on public.invoices(public_token);

-- =============================================================================
-- 2. Payment-method authorization cascade (entity / customer / job)
-- =============================================================================
-- Null at a level => fall through to the next less-specific level. The effective
-- set is resolved in JS (apps/web/src/lib/invoices/resolve-payment-methods.ts)
-- as invoice -> job -> customer -> entity, then intersected with what the active
-- payment provider actually supports.
alter table core.locations add column if not exists payment_methods_allowed text[];
alter table core.customers add column if not exists payment_methods_allowed text[];
alter table core.jobs      add column if not exists payment_methods_allowed text[];

-- Surcharge posture also cascades. Null => inherit; false => never surcharge
-- (card cost absorbed); true => card offered only with the fee opt-in (default).
alter table core.locations add column if not exists card_surcharge_enabled boolean;
alter table core.customers add column if not exists card_surcharge_enabled boolean;
alter table core.jobs      add column if not exists card_surcharge_enabled boolean;
alter table public.invoices add column if not exists card_surcharge_enabled boolean;

-- Retainage is NOT universal — it only applies to customers/jobs that withhold
-- it (construction). It is opt-in at customer or job creation; the invoice only
-- collects/shows a retainage line when the governing job/customer has it on.
-- Cascade: job -> customer -> entity. default_retainage_pct seeds the rate.
alter table core.locations add column if not exists retainage_enabled     boolean;
alter table core.locations add column if not exists default_retainage_pct numeric(5,2);
alter table core.customers add column if not exists retainage_enabled     boolean;
alter table core.customers add column if not exists default_retainage_pct numeric(5,2);
alter table core.jobs      add column if not exists retainage_enabled     boolean;
alter table core.jobs      add column if not exists default_retainage_pct numeric(5,2);

-- =============================================================================
-- 3. invoice_events — append-only lifecycle log
-- =============================================================================
create table if not exists public.invoice_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.organizations(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  event_type  text not null check (event_type in (
                 'CREATED','POSTED','EDITED','SENT','DELIVERED','VIEWED',
                 'PAY_INITIATED','PAY_SUCCEEDED','PAY_FAILED','FUNDS_SETTLED',
                 'PAYMENT_APPLIED','REMINDER_SENT','MARKED_PAID','REFUNDED',
                 'VOIDED','CREDITED','WRITTEN_OFF')),
  actor       text,                 -- Clerk user id (text) or 'customer'/'system'
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists invoice_events_invoice_idx on public.invoice_events(invoice_id, created_at);
create index if not exists invoice_events_org_idx     on public.invoice_events(org_id);

alter table public.invoice_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='invoice_events' and policyname='invoice_events_rls') then
    create policy invoice_events_rls on public.invoice_events
      using (org_id = get_org_id()) with check (org_id = get_org_id());
  end if;
end $$;

-- =============================================================================
-- 4. invoice_templates — per-entity branding for PDF / hosted view
-- =============================================================================
create table if not exists public.invoice_templates (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id) on delete cascade,
  style            text not null default 'MODERN' check (style in ('MODERN','CLASSIC','MINIMAL','BOLD','COMPACT')),
  logo_url         text,
  accent_color     text not null default '#10b981',   -- emerald brand default
  remit_to         text,                                -- pay-to block (multiline)
  footer_text      text,                                -- terms / thank-you
  default_message  text,                                -- default customer_message
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique(org_id, location_id)
);
-- (idempotent add for envs where the table predates the style column)
alter table public.invoice_templates add column if not exists style text not null default 'MODERN';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_style_chk') then
    alter table public.invoice_templates add constraint invoice_templates_style_chk check (style in ('MODERN','CLASSIC','MINIMAL','BOLD','COMPACT'));
  end if;
end $$;
alter table public.invoice_templates enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='invoice_templates' and policyname='invoice_templates_rls') then
    create policy invoice_templates_rls on public.invoice_templates
      using (org_id = get_org_id()) with check (org_id = get_org_id());
  end if;
end $$;

-- Public storage bucket for tenant logos (used by the branding settings upload).
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

-- =============================================================================
-- 5. Editable text at every level (FPB §2/§3 — "any text, per any scope")
-- =============================================================================
-- Customer-facing text (message, footer, remit-to, terms/payment notes, and the
-- field labels) is overridable at any scope. Resolution is most-specific-wins:
--   invoice (its own columns + INVOICE override) -> invoice_type -> job ->
--   customer -> entity (invoice_templates) -> built-in default.
-- One generic table holds the non-entity overrides; entity defaults stay in
-- invoice_templates. A free-text invoice_type lets a tenant key text to a kind
-- of invoice (e.g. 'Progress Bill', 'Deposit', 'Final').
alter table public.invoices add column if not exists invoice_type text;

create table if not exists public.invoice_text_overrides (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references core.organizations(id) on delete cascade,
  scope      text not null check (scope in ('CUSTOMER','JOB','INVOICE_TYPE','INVOICE')),
  scope_ref  text not null,          -- customer_id / job_id / invoice_type label / invoice_id
  slot       text not null,          -- 'customer_message' | 'footer_text' | 'remit_to' | 'terms_note' | 'payment_instructions' | label slots
  value      text not null,
  updated_at timestamptz not null default now(),
  unique(org_id, scope, scope_ref, slot)
);
create index if not exists invoice_text_overrides_lookup on public.invoice_text_overrides(org_id, scope, scope_ref);
alter table public.invoice_text_overrides enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='invoice_text_overrides' and policyname='invoice_text_overrides_rls') then
    create policy invoice_text_overrides_rls on public.invoice_text_overrides
      using (org_id = get_org_id()) with check (org_id = get_org_id());
  end if;
end $$;

-- =============================================================================
-- Done. Next: 051 (payments) — provider_connections.provider discriminator,
-- surcharge config, PLATFORM_FEE_EXPENSE / CARD_SURCHARGE_RECOVERY roles, and
-- the PaymentProvider adapter wiring.
-- =============================================================================
