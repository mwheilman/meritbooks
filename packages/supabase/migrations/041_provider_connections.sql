-- =============================================================================
-- Migration 041: Provider Connections & Secret Vault (Suite Core — GATE 12)
-- =============================================================================
-- Core-owned, module-agnostic infrastructure (per the Core ruling for GATE 12).
-- Every module that integrates a licensed provider (Books money-movement /
-- payroll, future modules) registers the connection here and stores the
-- provider's credentials in Supabase Vault — NEVER in an application table.
-- The connection row holds an opaque account handle and a Vault *reference*
-- only; the secret itself lives encrypted in vault.secrets.
--
--   core.provider_connections        — one row per (org, capability, provider, env)
--   core.store_provider_secret(...)   — write a secret to Vault, return its ref (uuid)
--   core.read_provider_secret(...)    — read a secret by ref (service_role only)
--   core.rotate_provider_secret(...)  — overwrite a secret in place
--   core.delete_provider_secret(...)  — remove a secret
--
-- REQUIRES migration 019 (core carve) + 023 (entitlements on core.organizations).
-- Idempotent. Secrets are accessed only via these SECURITY DEFINER functions,
-- executable by service_role only; the server (admin client) calls them by RPC.
--
-- OPERATIONAL NOTE: Vault requires SQL statement logging to be OFF so plaintext
-- secrets never land in logs. Supabase Cloud projects have this handled; if this
-- project is ever self-hosted, confirm `log_statement` is not 'all'/'mod'.
-- =============================================================================

-- ---- Guard: confirm the core carve is deployed ----
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'core' and table_name = 'organizations') then
    raise exception 'core.organizations not found — deploy migration 019 (Suite Core carve) before 041.';
  end if;
end $$;

-- ---- Ensure the Vault extension is available (enabled by default on Supabase) ----
create extension if not exists supabase_vault;

-- =============================================================================
-- 1. core.provider_connections
-- =============================================================================
create table if not exists core.provider_connections (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  capability     text not null
                   check (capability in ('AR_COLLECTION','AP_DISBURSEMENT','PAYROLL','BANK_FEED')),
  provider       text not null,                 -- e.g. 'stripe', 'increase', 'modern_treasury', 'melio', 'check', 'gusto', 'plaid'
  environment    text not null default 'test'
                   check (environment in ('test','live')),
  account_handle text,                           -- opaque provider account id (NOT a secret)
  secret_ref     uuid,                           -- pointer into vault.secrets (NOT the secret)
  status         text not null default 'disconnected'
                   check (status in ('active','disconnected','error')),
  connected_by   text,                           -- core.users.clerk_user_id (text); identity tables specced, not built
  status_detail  text,                           -- last error / human-readable status note
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table core.provider_connections is
  'Core-owned registry of per-tenant licensed-provider connections (GATE 12). One row per (org, capability, provider, environment). Holds an opaque account handle + a Vault secret reference only; credentials live in vault.secrets.';

-- One active wiring per (org, capability, provider, environment).
create unique index if not exists uq_provider_connections_scope
  on core.provider_connections (org_id, capability, provider, environment);

create index if not exists ix_provider_connections_org_cap
  on core.provider_connections (org_id, capability);

-- updated_at maintenance
create or replace function core.tg_provider_connections_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_provider_connections_touch on core.provider_connections;
create trigger trg_provider_connections_touch
  before update on core.provider_connections
  for each row execute function core.tg_provider_connections_touch();

-- ---- RLS: tenant isolation (mirrors the core-carve org_isolation pattern) ----
alter table core.provider_connections enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'core' and tablename = 'provider_connections' and policyname = 'org_isolation'
  ) then
    create policy "org_isolation" on core.provider_connections
      for all using (org_id = public.get_org_id());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'core' and tablename = 'provider_connections' and policyname = 'service_write'
  ) then
    create policy "service_write" on core.provider_connections
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- 2. Vault-backed secret helpers (SECURITY DEFINER; service_role only)
-- =============================================================================
-- These wrap Supabase Vault so application code never touches vault.* directly
-- and never sees an internal encryption key. The server calls them by RPC using
-- the service-role client.

create or replace function core.store_provider_secret(p_secret text, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  v_id uuid;
begin
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'secret must be non-empty';
  end if;
  -- vault.create_secret(secret, name, description) -> uuid
  select vault.create_secret(p_secret, p_name, 'provider credential') into v_id;
  return v_id;
end $$;

create or replace function core.read_provider_secret(p_ref uuid)
returns text
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = p_ref;
  return v_secret;  -- null if not found
end $$;

create or replace function core.rotate_provider_secret(p_ref uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = vault, public
as $$
begin
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'secret must be non-empty';
  end if;
  perform vault.update_secret(p_ref, p_secret);
end $$;

create or replace function core.delete_provider_secret(p_ref uuid)
returns void
language plpgsql
security definer
set search_path = vault, public
as $$
begin
  delete from vault.secrets where id = p_ref;
end $$;

-- Lock down execution: service_role only (the server's admin client).
revoke all on function core.store_provider_secret(text, text)  from public, anon, authenticated;
revoke all on function core.read_provider_secret(uuid)         from public, anon, authenticated;
revoke all on function core.rotate_provider_secret(uuid, text) from public, anon, authenticated;
revoke all on function core.delete_provider_secret(uuid)       from public, anon, authenticated;
grant execute on function core.store_provider_secret(text, text)  to service_role;
grant execute on function core.read_provider_secret(uuid)         to service_role;
grant execute on function core.rotate_provider_secret(uuid, text) to service_role;
grant execute on function core.delete_provider_secret(uuid)       to service_role;

-- =============================================================================
-- 3. Verification
-- =============================================================================
do $$
begin
  raise notice 'Migration 041 OK: core.provider_connections present = %, vault ext = %',
    exists (select 1 from information_schema.tables where table_schema='core' and table_name='provider_connections'),
    exists (select 1 from pg_extension where extname='supabase_vault');
end $$;
