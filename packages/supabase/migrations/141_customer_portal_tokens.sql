-- =============================================================================
-- Migration 141: customer self-service portal access tokens.
-- =============================================================================
-- A customer portal visitor is NOT a Clerk user. Access is granted by an opaque,
-- revocable, org+customer-scoped token (magic link), mirroring the existing
-- /pay/[token] hosted-pay model but scoped to a CUSTOMER (their whole invoice list
-- + statements) rather than a single invoice. The portal API validates the token
-- server-side, resolves org_id + customer_id, and returns ONLY that customer's
-- data via the admin client narrowed to that customer_id (the visitor never gets
-- a tenant-wide session). Tokens can expire and be revoked.
--
-- SAFETY / CANON §3: additive + idempotent; read-mostly (the portal reads invoices/
-- statements and initiates payment through the EXISTING /pay intent path — it books
-- nothing new). RLS org_isolation via public.get_org_id() for the authenticated
-- admin side; the public portal reads happen through the service role narrowed by
-- token. Money is bigint cents elsewhere.
-- =============================================================================

create table if not exists public.customer_portal_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  customer_id   uuid not null,                 -- core.customers (stitched in JS)
  token         text not null unique,          -- opaque high-entropy secret (the magic-link value)
  label         text,
  status        text not null default 'ACTIVE'
                  check (status in ('ACTIVE','REVOKED','EXPIRED')),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.customer_portal_tokens is
  'Opaque, revocable magic-link tokens granting a customer read access to THEIR invoices/statements (and pay via the existing /pay intent path). Not a tenant session; the portal API narrows all reads to this customer_id.';

create index if not exists ix_customer_portal_tokens_org_customer on public.customer_portal_tokens (org_id, customer_id);
create unique index if not exists ux_customer_portal_tokens_token on public.customer_portal_tokens (token);

alter table public.customer_portal_tokens enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_portal_tokens' and policyname='org_isolation')
    then create policy "org_isolation" on public.customer_portal_tokens for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_portal_tokens' and policyname='service_write')
    then create policy "service_write" on public.customer_portal_tokens for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.customer_portal_tokens to anon, authenticated, service_role;
