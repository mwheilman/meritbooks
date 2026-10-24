-- =============================================================================
-- Migration 190: brand profiles (tenant + company brand from logo) and
--                invoice_templates.inherit_brand.
-- =============================================================================
--
-- FPB : docs/FPB-branding.md (§6 data model, §7 resolution, §8 gates).
--
-- §1 public.brand_profiles — one row per tenant (location_id IS NULL) and per company.
--    Logos (light / dark-background / square mark) are public URLs in the `branding`
--    bucket under ${orgId}/ — validated in the app by isTenantLogoUrl (the SSRF guard of
--    Slice 1B); the derived palette (primary, secondary, accent, ink, surface, on-primary),
--    font (DM_SANS | SYSTEM | SERIF), source (derived | manual), the swatches the browser
--    extracted, and the server-recomputed contrast report.
--    Resolution (lib/branding/resolve.ts): company (use_tenant_brand = false) → tenant →
--    Merit default.
-- §2 public.invoice_templates.inherit_brand — templates take logo / accent / font from the
--    resolved company brand unless switched off. Rows that already carry an explicit choice
--    (a non-default accent or a logo) are added with inherit_brand = false, ONCE (only on
--    the run that creates the column), so a tenant's choice is never overwritten.
-- §3 Write lock (171 / 176 pattern): members SELECT only; every write goes through the
--    service role after the route's settings_system:edit check (lib/branding/service.ts).
--    Client scope (163) re-applied at the end — a tenant row (location_id null) stays
--    visible to every member of the org, a company row follows the company's scope.
--
-- SAFETY: additive. No GL effect. No functions. Idempotent. PGlite-compatible (no
-- subqueries in CHECKs). Apply to Supabase FIRST, then the code.
-- =============================================================================

do $$
begin
  if to_regclass('core.organizations') is null or to_regclass('core.locations') is null then
    raise exception 'core.organizations / core.locations not found — deploy 001 before 190.';
  end if;
  if to_regclass('public.invoice_templates') is null then
    raise exception 'public.invoice_templates not found — deploy 050 / 176 before 190.';
  end if;
end $$;

-- =============================================================================
-- §1 brand_profiles
-- =============================================================================
create table if not exists public.brand_profiles (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid references core.locations(id) on delete cascade,   -- null = tenant
  use_tenant_brand  boolean not null default true,
  logo_url          text,
  logo_dark_url     text,
  mark_url          text,
  primary_color     text not null default '#2563EB',
  secondary_color   text not null default '#0A1628',
  accent_color      text not null default '#3B82F6',
  ink_color         text not null default '#0A1628',
  surface_color     text not null default '#EBF2FE',
  on_primary_color  text not null default '#FFFFFF',
  font              text not null default 'DM_SANS',
  palette_source    text not null default 'derived',
  extracted_colors  jsonb not null default '[]'::jsonb,
  contrast_report   jsonb not null default '{}'::jsonb,
  updated_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brand_profiles_colors_chk') then
    alter table public.brand_profiles add constraint brand_profiles_colors_chk check (
      primary_color    ~ '^#[0-9A-Fa-f]{6}$' and
      secondary_color  ~ '^#[0-9A-Fa-f]{6}$' and
      accent_color     ~ '^#[0-9A-Fa-f]{6}$' and
      ink_color        ~ '^#[0-9A-Fa-f]{6}$' and
      surface_color    ~ '^#[0-9A-Fa-f]{6}$' and
      on_primary_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_profiles_font_chk') then
    alter table public.brand_profiles add constraint brand_profiles_font_chk
      check (font in ('DM_SANS', 'SYSTEM', 'SERIF'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_profiles_source_chk') then
    alter table public.brand_profiles add constraint brand_profiles_source_chk
      check (palette_source in ('derived', 'manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_profiles_urls_chk') then
    alter table public.brand_profiles add constraint brand_profiles_urls_chk check (
      coalesce(length(logo_url), 0) <= 1000 and
      coalesce(length(logo_dark_url), 0) <= 1000 and
      coalesce(length(mark_url), 0) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'brand_profiles_json_chk') then
    alter table public.brand_profiles add constraint brand_profiles_json_chk check (
      jsonb_typeof(extracted_colors) = 'array' and jsonb_typeof(contrast_report) = 'object');
  end if;
end $$;

-- One tenant row per org; one row per company.
create unique index if not exists brand_profiles_scope_uq
  on public.brand_profiles (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists brand_profiles_loc_idx
  on public.brand_profiles (location_id) where location_id is not null;

-- =============================================================================
-- §2 invoice_templates.inherit_brand (explicit choices preserved, once)
-- =============================================================================
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoice_templates'
                    and column_name = 'inherit_brand') then
    alter table public.invoice_templates add column inherit_brand boolean not null default true;
    update public.invoice_templates
       set inherit_brand = false
     where logo_url is not null
        or upper(accent_color) not in ('#2563EB', '#10B981');
  end if;
end $$;

-- =============================================================================
-- §3 RLS + write lock (member SELECT, service writes)
-- =============================================================================
alter table public.brand_profiles enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'brand_profiles'
                  and policyname = 'member_read') then
    create policy member_read on public.brand_profiles for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'brand_profiles'
                  and policyname = 'service_all') then
    create policy service_all on public.brand_profiles for all to service_role using (true) with check (true);
  end if;
end $$;

revoke all on table public.brand_profiles from anon;
revoke insert, update, delete, truncate on table public.brand_profiles from authenticated;
grant select on table public.brand_profiles to authenticated;
grant select, insert, update, delete on table public.brand_profiles to service_role;

-- End migration 190.

-- Client scope (163): brand_profiles owns a (nullable) location_id.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- ── Projects-only seat deny (1110 contract; guarded: absent in the PGlite replay) ──
-- Every RLS table this migration creates gets the RESTRICTIVE projects_only_seat_deny policy.
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['brand_profiles'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
