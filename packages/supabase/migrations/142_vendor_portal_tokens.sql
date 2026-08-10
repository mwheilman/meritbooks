-- =============================================================================
-- Migration 142: vendor self-service upload portal access tokens.
-- =============================================================================
-- A magic-link token lets a VENDOR (not a Clerk user) upload compliance documents
-- (W-9, COI, banking/remittance details) that flow into the EXISTING vendor-
-- compliance intake. Mirrors the customer-portal token model: opaque, revocable,
-- org+vendor-scoped; the portal API validates server-side, resolves org_id +
-- vendor_id, and accepts uploads narrowed to that vendor only.
--
-- SAFETY / CANON §3: additive + idempotent; the upload lands a document + a
-- compliance intake record for a human to review/accept (never auto-approves a
-- vendor). RLS org_isolation via public.get_org_id(); the public upload path runs
-- through the service role narrowed by token.
-- =============================================================================

create table if not exists public.vendor_portal_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  vendor_id     uuid not null,                 -- core.vendors (stitched in JS)
  token         text not null unique,          -- opaque high-entropy secret (the magic-link value)
  label         text,
  status        text not null default 'ACTIVE'
                  check (status in ('ACTIVE','REVOKED','EXPIRED')),
  requested_docs text[] not null default array['W9','COI']::text[],
  expires_at    timestamptz,
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.vendor_portal_tokens is
  'Opaque, revocable magic-link tokens letting a vendor upload W-9/COI/compliance docs into the existing vendor-compliance intake. Not a tenant session; uploads are narrowed to this vendor_id and always land for human review.';

create index if not exists ix_vendor_portal_tokens_org_vendor on public.vendor_portal_tokens (org_id, vendor_id);
create unique index if not exists ux_vendor_portal_tokens_token on public.vendor_portal_tokens (token);

alter table public.vendor_portal_tokens enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vendor_portal_tokens' and policyname='org_isolation')
    then create policy "org_isolation" on public.vendor_portal_tokens for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vendor_portal_tokens' and policyname='service_write')
    then create policy "service_write" on public.vendor_portal_tokens for all to service_role using (true) with check (true); end if;
end $$;

grant select, insert, update, delete on public.vendor_portal_tokens to anon, authenticated, service_role;
