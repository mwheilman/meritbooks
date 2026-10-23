-- =============================================================================
-- Migration 176: invoice design templates, customer template / CC defaults,
--                invoice CC + line display fields, and the AR write lock (HIGH-2).
-- =============================================================================
--
-- FPB      : docs/FPB-invoices.md §4 (Slice 1B — design, customization, pay links).
-- Audit    : docs/audit-2026-10/FEATURE-GAP-AUDIT.md §2.9, AR-01…AR-05, Wave 1B.
--
-- §1 public.invoice_templates becomes a real template library. Until now it held ONE
--    branding row per company (unique(org_id, location_id)), defaulting to emerald.
--    Now a company (or the whole organization, location_id null) has any number of
--    NAMED templates, one of which is the default:
--      name, is_default, font (SANS | SERIF — built-in PDF faces, deterministic bytes),
--      visible_columns (which line columns print), custom_fields (header / footer
--      label-value pairs), line_fields (custom per-line columns), terms_text,
--      payment_instructions, show_qr, show_pay_button, attachments_allowed.
--    `style` (MODERN | CLASSIC | MINIMAL | BOLD | COMPACT) stays the layout variant.
--    accent_color now defaults to Merit Electric Blue #2563EB; rows still on the old
--    emerald default are moved to it (a default, never a tenant's choice — live has 0
--    rows on the day this was written).
-- §2 public.invoices.template_id (per-invoice choice; null = inherit) and cc_emails;
--    public.invoice_lines.service_date, item_id, custom_fields — the line facts the
--    template's columns print.
-- §3 public.customer_invoice_settings — per customer: assigned template + default CC
--    list. Books-owned (the customer master stays in core; nothing is copied).
--    Template resolution (lib/invoices/templates/resolve.ts):
--      invoice.template_id → customer assignment → company default → org default →
--      built-in.
-- §4 HIGH-2 closed: invoices, invoice_lines, internal_invoices, internal_invoice_lines,
--    customer_deposits, customer_deposit_applications — plus invoice_templates and the
--    new customer_invoice_settings — become SELECT-only for members (171 / 172 pattern,
--    ORDER-INDEPENDENT). Every app write goes through lib/db/scoped-writer.ts (service
--    role, after the route's permission check, org pinned, client scope asserted). The
--    last member write sites (lib/invoices/create-invoice.ts, dept-invoice-consumer,
--    lib/customer-deposits/**) moved in the same change.
--
-- LEDGER CONTROLS UNCHANGED: balance, period lock (152), posted-GL immutability (153),
-- control-account / approved-account / dimension validation and numbering are
-- role-independent triggers.
--
-- SAFETY: additive columns; one default-value data move (emerald → Electric on the
-- untouched default only). No GL effect. Idempotent. PGlite-compatible (no subqueries in
-- CHECKs; policies only). Tables absent in an environment are skipped (to_regclass).
-- No new functions.
-- =============================================================================

-- ── Guards ──────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.invoice_templates') is null then
    raise exception 'public.invoice_templates not found — deploy 050 before 176.';
  end if;
  if to_regclass('public.invoices') is null or to_regclass('core.customers') is null then
    raise exception 'public.invoices / core.customers not found — deploy 008 / 019 before 176.';
  end if;
end $$;

-- =============================================================================
-- §1 invoice_templates → a named template library
-- =============================================================================
alter table public.invoice_templates alter column location_id drop not null;

-- The one-row-per-company unique constraint goes (a company now has many templates).
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.invoice_templates'::regclass
       and con.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(con.conkey) k
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
           = array['location_id', 'org_id']
  loop
    execute format('alter table public.invoice_templates drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.invoice_templates add column if not exists name                 text;
alter table public.invoice_templates add column if not exists is_default           boolean not null default false;
alter table public.invoice_templates add column if not exists font                 text    not null default 'SANS';
alter table public.invoice_templates add column if not exists visible_columns      text[]  not null default array['description','quantity','rate','amount']::text[];
alter table public.invoice_templates add column if not exists custom_fields        jsonb   not null default '[]'::jsonb;
alter table public.invoice_templates add column if not exists line_fields          jsonb   not null default '[]'::jsonb;
alter table public.invoice_templates add column if not exists terms_text           text;
alter table public.invoice_templates add column if not exists payment_instructions text;
alter table public.invoice_templates add column if not exists show_qr              boolean not null default true;
alter table public.invoice_templates add column if not exists show_pay_button      boolean not null default true;
alter table public.invoice_templates add column if not exists attachments_allowed  boolean not null default true;
alter table public.invoice_templates add column if not exists updated_by           text;

-- Existing per-company rows become that company's default "Standard" template.
update public.invoice_templates set name = 'Standard' where name is null;
update public.invoice_templates t set is_default = true
 where not t.is_default
   and t.location_id is not null
   and not exists (select 1 from public.invoice_templates x
                    where x.org_id = t.org_id and x.location_id = t.location_id and x.is_default);
alter table public.invoice_templates alter column name set not null;

-- Brand default: Merit Electric Blue, never emerald. Only the untouched default moves.
alter table public.invoice_templates alter column accent_color set default '#2563EB';
update public.invoice_templates set accent_color = '#2563EB' where lower(accent_color) = '#10b981';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_font_chk') then
    alter table public.invoice_templates add constraint invoice_templates_font_chk check (font in ('SANS','SERIF'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_name_chk') then
    alter table public.invoice_templates add constraint invoice_templates_name_chk
      check (length(btrim(name)) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_columns_chk') then
    alter table public.invoice_templates add constraint invoice_templates_columns_chk check (
      visible_columns <@ array['item','description','quantity','rate','amount','tax','job','cost_code','service_date','custom']::text[]
      and 'description' = any(visible_columns)
      and 'amount' = any(visible_columns));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_accent_chk') then
    alter table public.invoice_templates add constraint invoice_templates_accent_chk
      check (accent_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_templates_json_chk') then
    alter table public.invoice_templates add constraint invoice_templates_json_chk
      check (jsonb_typeof(custom_fields) = 'array' and jsonb_typeof(line_fields) = 'array');
  end if;
end $$;

-- One default per company, one org-wide default; names unique within a scope.
create unique index if not exists invoice_templates_one_default_uq
  on public.invoice_templates (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default;
create unique index if not exists invoice_templates_name_uq
  on public.invoice_templates (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists invoice_templates_org_loc_idx on public.invoice_templates (org_id, location_id);

-- =============================================================================
-- §2 invoices / invoice_lines display + delivery columns
-- =============================================================================
alter table public.invoices add column if not exists template_id uuid;
alter table public.invoices add column if not exists cc_emails   text[] not null default '{}'::text[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_template_id_fkey') then
    alter table public.invoices add constraint invoices_template_id_fkey
      foreign key (template_id) references public.invoice_templates(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_cc_emails_chk') then
    alter table public.invoices add constraint invoices_cc_emails_chk check (coalesce(array_length(cc_emails, 1), 0) <= 10);
  end if;
end $$;
create index if not exists invoices_template_idx on public.invoices (template_id) where template_id is not null;

alter table public.invoice_lines add column if not exists service_date  date;
alter table public.invoice_lines add column if not exists item_id       uuid;
alter table public.invoice_lines add column if not exists custom_fields jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_lines_item_id_fkey')
     and to_regclass('core.items') is not null then
    alter table public.invoice_lines add constraint invoice_lines_item_id_fkey
      foreign key (item_id) references core.items(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoice_lines_custom_fields_chk') then
    alter table public.invoice_lines add constraint invoice_lines_custom_fields_chk check (jsonb_typeof(custom_fields) = 'object');
  end if;
end $$;

-- =============================================================================
-- §3 customer_invoice_settings — template assignment + default CC per customer
-- =============================================================================
create table if not exists public.customer_invoice_settings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  customer_id  uuid not null references core.customers(id) on delete cascade,
  template_id  uuid references public.invoice_templates(id) on delete set null,
  cc_emails    text[] not null default '{}'::text[],
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, customer_id),
  constraint customer_invoice_settings_cc_chk check (coalesce(array_length(cc_emails, 1), 0) <= 10)
);
create index if not exists customer_invoice_settings_template_idx
  on public.customer_invoice_settings (template_id) where template_id is not null;

alter table public.customer_invoice_settings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_invoice_settings'
                  and policyname = 'member_read') then
    create policy member_read on public.customer_invoice_settings for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_invoice_settings'
                  and policyname = 'service_all') then
    create policy service_all on public.customer_invoice_settings for all to service_role using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- §4 AR write lock (HIGH-2) — 171 / 172 pattern, order-independent
-- =============================================================================
do $$
declare
  t record;
  p record;
  v_roles text;
begin
  for t in
    select * from (values
      ('public', 'invoices'),
      ('public', 'invoice_lines'),
      ('public', 'internal_invoices'),
      ('public', 'internal_invoice_lines'),
      ('public', 'customer_deposits'),
      ('public', 'customer_deposit_applications'),
      ('public', 'invoice_templates'),
      ('public', 'customer_invoice_settings')
    ) as v(sch, tbl)
  loop
    if to_regclass(format('%I.%I', t.sch, t.tbl)) is null then
      raise notice 'migration 176: %.% not present, skipped', t.sch, t.tbl;
      continue;
    end if;
    execute format('alter table %I.%I enable row level security', t.sch, t.tbl);

    -- PERMISSIVE member write policies → SELECT policies with the SAME predicate.
    for p in
      select policyname, cmd, roles, qual
        from pg_policies
       where schemaname = t.sch and tablename = t.tbl
         and permissive = 'PERMISSIVE'
         and cmd <> 'SELECT'
         and roles::text <> '{service_role}'
    loop
      execute format('drop policy if exists %I on %I.%I', p.policyname, t.sch, t.tbl);
      if p.cmd = 'ALL' and p.qual is not null
         and not exists (select 1 from pg_policies x
                          where x.schemaname = t.sch and x.tablename = t.tbl
                            and x.policyname = p.policyname) then
        v_roles := array_to_string(p.roles, ', ');
        execute format('create policy %I on %I.%I for select to %s using (%s)',
                       p.policyname, t.sch, t.tbl, v_roles, p.qual);
      end if;
    end loop;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and cmd in ('SELECT', 'ALL')
                      and permissive = 'PERMISSIVE' and roles::text <> '{service_role}') then
      execute format('create policy member_read on %I.%I for select using (org_id = public.get_org_id())',
                     t.sch, t.tbl);
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = t.sch and tablename = t.tbl and policyname = 'service_all') then
      execute format(
        'create policy service_all on %I.%I for all to service_role using (true) with check (true)',
        t.sch, t.tbl);
    end if;

    execute format('revoke insert, update, delete, truncate on table %I.%I from anon, authenticated', t.sch, t.tbl);
    execute format('grant select on table %I.%I to authenticated', t.sch, t.tbl);
    execute format('grant select, insert, update, delete on table %I.%I to service_role', t.sch, t.tbl);
  end loop;
end $$;

-- End migration 176.

-- Re-apply client-scope RLS (163) so the policies above compose with it (RESTRICTIVE
-- client_scope_rls policies are untouched; the re-apply keeps this order-independent).
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
