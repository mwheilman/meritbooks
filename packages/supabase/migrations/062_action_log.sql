-- =============================================================================
-- Migration 062: action log — the trust-layer spine
-- =============================================================================
-- A single append-only record of "who did what, on which subject, and (for AI)
-- with what confidence/disposition." This is the primitive the autonomous
-- pipelines and the exception queue build on. The survey found four partial,
-- overlapping logs (ai_decisions, audit_log, approval_steps, job_cost_attributions)
-- but NO unified log and — critically — NO machine-vs-human actor model. This
-- adds both, additively; existing logs keep working and get folded in over time.
--
-- Also unblocks attribution: today gl_entries.created_by et al. are written NULL
-- because there was no Clerk-text -> core.users(uuid) bridge. The self_provision
-- policy below lets a signed-in user materialize their own core.users row, so the
-- app can resolve a real actor uuid (see lib/trust/actor.ts).
-- =============================================================================

-- Machine-vs-human-vs-system. The #1 missing primitive.
do $$
begin
  create type core.actor_type as enum ('HUMAN', 'AI', 'SYSTEM');
exception
  when duplicate_object then null;
end $$;

create table if not exists core.action_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid references core.locations(id),
  actor_type     core.actor_type not null,
  actor_user_id  uuid references core.users(id),     -- null for AI / SYSTEM
  action         text not null,                        -- 'team.member.add', 'bankfeed.approve', ...
  subject_table  text,                                 -- 'employees', 'gl_entries', ...
  subject_id     text,                                 -- uuid or external ref, as text
  summary        text,                                 -- human-readable one-liner
  confidence     numeric(5,4),                         -- AI actions only
  tier           text check (tier in ('auto', 'review', 'escalate')),
  correlation_id text,                                 -- link to ai_decisions / ai_usage
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
comment on table core.action_log is
  'Append-only unified action/audit log with machine-vs-human attribution. No UPDATE/DELETE policy = immutable for app roles.';

create index if not exists idx_action_log_org_created on core.action_log (org_id, created_at desc);
create index if not exists idx_action_log_subject     on core.action_log (subject_table, subject_id);
create index if not exists idx_action_log_actor       on core.action_log (actor_user_id);

-- Append-only under RLS: SELECT + INSERT for the org; no UPDATE/DELETE policies,
-- so app roles can never mutate history. service_role retains full access.
alter table core.action_log enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='action_log' and policyname='org_read') then
    create policy "org_read" on core.action_log for select using (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='action_log' and policyname='org_insert') then
    create policy "org_insert" on core.action_log for insert with check (org_id = public.get_org_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='action_log' and policyname='service_all') then
    create policy "service_all" on core.action_log for all to service_role using (true) with check (true);
  end if;
end $$;

-- Let a signed-in user create THEIR OWN core.users row (self-provisioning), so
-- attribution can resolve a real actor uuid without a service-role round-trip.
-- (061 only had self_read + service_all; add a scoped insert.)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='core' and tablename='users' and policyname='self_provision') then
    create policy "self_provision" on core.users for insert
      with check (clerk_user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
  end if;
end $$;
