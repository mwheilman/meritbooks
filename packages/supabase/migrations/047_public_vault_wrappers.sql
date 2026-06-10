-- Migration 047: public wrappers for the core Vault helpers
--
-- WHY: the Supabase JS client calls RPCs unqualified (`supabase.rpc('name')`),
-- which PostgREST resolves against the `public` schema only. The provider-secret
-- Vault helpers live in `core` (migration 041), so server code that stores/reads
-- a Plaid access token could not reach them. These thin `public` wrappers
-- delegate to the `core` functions and are locked to `service_role` exactly like
-- the originals. SECURITY DEFINER so the wrapper — not the caller — carries the
-- privilege to touch Vault through `core`.
--
-- NOTE (Session 25): this migration was applied directly in the Supabase SQL
-- editor during Session 24 but never committed as a file. Committing it now makes
-- the repo the source of truth. It is idempotent (create-or-replace); re-running
-- against a DB that already has it is a no-op.

create or replace function public.store_provider_secret(p_secret text, p_name text default null)
returns uuid
language sql
security definer
set search_path = core, public
as $$
  select core.store_provider_secret(p_secret, p_name);
$$;

create or replace function public.read_provider_secret(p_ref uuid)
returns text
language sql
security definer
set search_path = core, public
as $$
  select core.read_provider_secret(p_ref);
$$;

create or replace function public.rotate_provider_secret(p_ref uuid, p_secret text)
returns void
language sql
security definer
set search_path = core, public
as $$
  select core.rotate_provider_secret(p_ref, p_secret);
$$;

create or replace function public.delete_provider_secret(p_ref uuid)
returns void
language sql
security definer
set search_path = core, public
as $$
  select core.delete_provider_secret(p_ref);
$$;

-- Lock down to service_role, mirroring the core functions.
revoke all on function public.store_provider_secret(text, text)  from public, anon, authenticated;
revoke all on function public.read_provider_secret(uuid)         from public, anon, authenticated;
revoke all on function public.rotate_provider_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_provider_secret(uuid)       from public, anon, authenticated;
grant execute on function public.store_provider_secret(text, text)  to service_role;
grant execute on function public.read_provider_secret(uuid)         to service_role;
grant execute on function public.rotate_provider_secret(uuid, text) to service_role;
grant execute on function public.delete_provider_secret(uuid)       to service_role;
