-- =============================================================================
-- Migration 087: identity — resolve the tenant from the Clerk org claim
-- =============================================================================
-- Closes identity gate #9 at the RLS boundary. With Clerk organizations enabled,
-- the session's `org_id` claim can be EITHER:
--   (a) a MeritBooks tenant uuid (core.organizations.id) — when a custom JWT
--       template maps it (the current live behavior), OR
--   (b) a raw Clerk organization id ('org_XXXX') — Clerk's default claim, which is
--       NOT a uuid, so the old `(claim->>'org_id')::uuid` cast in get_org_id() blew
--       up / returned null and every request fell back to an arbitrary "first org".
--
-- This migration makes get_org_id() DEFENSIVE — it accepts both shapes and maps a
-- Clerk org id to the bound Books tenant via core.organizations.clerk_org_id —
-- and FAIL-CLOSED (returns null when the claim resolves to no tenant, so RLS shows
-- zero rows instead of leaking another tenant's data).
--
-- ADDITIVE + IDEMPOTENT. The clerk_org_id column + unique index already exist
-- (migration 061); they are re-asserted here with IF NOT EXISTS so this migration
-- stands alone. No data is backfilled — the app binds the single existing tenant to
-- the caller's Clerk org on first authenticated login (lib/rbac/resolve-tenant.ts
-- bindClerkOrgOnLogin), guarded by the unique index below.
-- =============================================================================

-- Clerk org  →  MeritBooks tenant uuid. (Idempotent re-assert of migration 061.)
alter table core.organizations add column if not exists clerk_org_id text;
create unique index if not exists uq_org_clerk_org_id
  on core.organizations (clerk_org_id) where clerk_org_id is not null;

-- -----------------------------------------------------------------------------
-- get_org_id(): the single tenant-resolution function every RLS policy calls.
--
-- SECURITY DEFINER is REQUIRED: the function now reads core.organizations, whose
-- own RLS policy is `id = public.get_org_id()`. Called as the invoker that would
-- recurse into its own policy (infinite recursion). As DEFINER (owned by the
-- migration/superuser role, which bypasses RLS on tables it owns — no table sets
-- FORCE ROW LEVEL SECURITY), the internal lookups run without RLS, so there is no
-- recursion and no privilege leak (it only ever returns the caller's own claim's
-- tenant id). The uuid cast is guarded behind a regex so a non-uuid Clerk claim
-- can never raise a cast error mid-policy-evaluation.
-- -----------------------------------------------------------------------------
create or replace function public.get_org_id() returns uuid
language plpgsql
stable
security definer
set search_path = public, core
as $$
declare
  v      text;
  result uuid;
begin
  v := current_setting('request.jwt.claims', true)::json ->> 'org_id';
  if v is null or v = '' then
    return null;
  end if;

  -- Case 1: the claim is already a Books tenant uuid — accept it only if a matching
  -- tenant exists (a uuid-shaped claim for an unknown org must not be honored).
  if v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select o.id into result from core.organizations o where o.id = v::uuid;
    if result is not null then
      return result;
    end if;
    -- uuid-shaped but unknown: fall through to the Clerk mapping, then null.
  end if;

  -- Case 2: map a Clerk org id ('org_XXXX') to the bound Books tenant. Returns null
  -- when unbound -> RLS shows no rows -> fail closed.
  select o.id into result from core.organizations o where o.clerk_org_id = v;
  return result;
end;
$$;

comment on function public.get_org_id() is
  'Tenant resolver for RLS. Reads the session org_id claim and returns the MeritBooks tenant uuid, accepting either a Books uuid (verified to exist) or a Clerk org id mapped via core.organizations.clerk_org_id. Returns null (fail closed) when the claim maps to no tenant. SECURITY DEFINER to avoid recursing into core.organizations RLS.';
