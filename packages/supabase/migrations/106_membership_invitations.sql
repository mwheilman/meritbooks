-- =============================================================================
-- Migration 106: core.membership_invitations — invite teammates with a role
-- =============================================================================
-- A company_admin invites a person by email + assigns a Books UserRole (+ optional
-- per-company location grants). On the invitee's first authenticated login, the
-- identity path (claim-invitation) matches a pending, non-expired invite by the
-- CLERK-VERIFIED primary email (not the token — a forwarded link can't claim another
-- address), provisions the core.employees seat with the ASSIGNED role (ahead of the
-- company_admin default), applies the company grants, and marks it accepted; the rest
-- of /api/me then mints core.memberships via the existing provisioning path.
-- Additive + idempotent. RLS: org-scoped read via get_org_id(); writes are service_role
-- (routes use the admin client after app-layer requireManageUsers) — matches the
-- core.memberships pattern (migration 061). App degrades SAFE if absent (invite UI
-- shows "unavailable until migration"). core band; next number: 107 (onboarding_state).
-- =============================================================================

create table if not exists core.membership_invitations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  email             text not null,
  role              text not null,
  first_name        text,
  last_name         text,
  location_ids      uuid[] not null default '{}',
  token             text not null unique,
  status            text not null default 'pending'
                      check (status in ('pending','accepted','revoked','expired')),
  invited_by_clerk  text,
  accepted_clerk_id text,
  accepted_user_id  uuid references core.users(id),
  expires_at        timestamptz not null default (now() + interval '14 days'),
  accepted_at       timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists uq_membership_invite_pending
  on core.membership_invitations (org_id, lower(email)) where status = 'pending';
create index if not exists idx_membership_invite_org   on core.membership_invitations (org_id);
create index if not exists idx_membership_invite_email on core.membership_invitations (lower(email));

alter table core.membership_invitations enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='membership_invitations' and policyname='org_read') then
    create policy "org_read" on core.membership_invitations for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='membership_invitations' and policyname='service_all') then
    create policy "service_all" on core.membership_invitations for all to service_role using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on core.membership_invitations to anon, authenticated, service_role;
