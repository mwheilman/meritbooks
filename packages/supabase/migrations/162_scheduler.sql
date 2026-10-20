-- =============================================================================
-- Migration 162: Scheduler — scheduled jobs + run log (INT-01 / IA M-12).
-- =============================================================================
-- WHAT. Two tables + one service-only lock function back the Vercel-Cron-driven
-- scheduler (apps/web/src/lib/scheduler/*, dispatcher /api/cron/tick):
--
--   core.scheduled_jobs  one STATE + OVERRIDE row per (job_key, org_id, location_id).
--                        org_id NULL = the platform row for that job (a platform job's
--                        own state, and the platform-wide override/kill switch for an
--                        org job). The job CATALOG (label, default cron, default
--                        enabled, timeout) lives in code (lib/scheduler/registry.ts);
--                        a row only carries overrides (enabled/cron, NULL = inherit)
--                        plus run state (last completed slot, attempts, backoff) and
--                        the single-flight LOCK (lock_owner + lock_expires_at).
--   core.job_runs        the append-mostly run log every "Automation health" widget
--                        reads ("Detectors ran 02:10 today"). One row per attempt.
--
-- SINGLE-FLIGHT. core.scheduler_try_lock() atomically claims the (job, org) row
-- with an expiring lock: a second concurrent tick (or a retried Vercel invocation)
-- gets FALSE and skips. An expired lock (a run killed by the platform timeout) is
-- claimable again, so a crash never wedges a job forever. Release is a plain
-- service-role UPDATE filtered on lock_owner (only the holder clears its own lock).
--
-- IDEMPOTENCY. job_runs.idempotency_key = '<job>:<org|platform>:<slot ISO>' is
-- UNIQUE among non-failed runs (partial index): a slot that is running or already
-- finished ok/partial/skipped can never be started twice, while a FAILED attempt
-- frees the key so the runner may retry it (with backoff, capped attempts).
--
-- SECURITY (mirrors migration 154). RLS ON for both tables. Members get exactly one
-- policy — SELECT of their own tenant's rows (org_id = get_org_id()); platform rows
-- (org_id NULL) are invisible to members. All writes are service_role only:
-- INSERT/UPDATE/DELETE/TRUNCATE are REVOKED from anon + authenticated, and the
-- lock function is EXECUTE-revoked from PUBLIC/anon/authenticated. A member can never
-- forge a run, re-enable a disabled job, or steal/release a lock.
--
-- SAFETY. New tables only; no data change; no GL effect. Idempotent (IF NOT EXISTS,
-- drop-and-recreate policies, create or replace functions).
-- =============================================================================

create table if not exists core.scheduled_jobs (
  id                    uuid primary key default gen_random_uuid(),
  job_key               text not null check (job_key ~ '^[a-z0-9_]+(\.[a-z0-9_:-]+)+$'),
  org_id                uuid references core.organizations(id) on delete cascade,
  location_id           uuid,
  -- overrides (NULL = inherit from the platform row, then from the code registry)
  enabled               boolean,
  cron                  text,
  owner_capability      text,
  -- run state
  last_slot_at          timestamptz,          -- newest slot that FINISHED (ok/partial/skipped or gave up)
  last_run_at           timestamptz,
  last_status           text check (last_status is null or last_status in ('running','ok','partial','failed','skipped')),
  next_run_at           timestamptz,          -- informational (UI); due-ness is computed from cron + last_slot_at
  pending_slot_at       timestamptz,          -- slot currently being retried after a failure
  attempts              integer not null default 0,   -- failed attempts at pending_slot_at
  consecutive_failures  integer not null default 0,
  backoff_until         timestamptz,
  -- single-flight lock
  lock_owner            text,
  lock_expires_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint scheduled_jobs_scope_uniq unique nulls not distinct (job_key, org_id, location_id)
);

comment on table core.scheduled_jobs is
  'M-12 scheduler state + overrides per (job_key, org_id, location_id). org_id NULL = platform row. enabled/cron NULL = inherit (platform row, then code registry). Writes are service_role only.';

create index if not exists idx_scheduled_jobs_org on core.scheduled_jobs (org_id);

create table if not exists core.job_runs (
  id                uuid primary key default gen_random_uuid(),
  job_key           text not null,
  org_id            uuid references core.organizations(id) on delete cascade,
  location_id       uuid,
  slot_at           timestamptz not null,       -- the cron occurrence this run serves
  attempt           integer not null default 1 check (attempt >= 1),
  idempotency_key   text not null,
  trigger           text not null default 'cron' check (trigger in ('cron','manual')),
  actor             text not null default 'system:scheduler',
  status            text not null default 'running'
                      check (status in ('running','ok','partial','failed','skipped')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_ms       integer,
  items_processed   integer not null default 0,
  counts            jsonb not null default '{}'::jsonb,
  summary           text,
  error             text,
  created_at        timestamptz not null default now()
);

comment on table core.job_runs is
  'M-12 run log: one row per scheduler attempt (job_key, org_id, slot). idempotency_key is unique among non-failed runs. Writes are service_role only; members read their own org.';

create unique index if not exists uq_job_runs_idempotency_live
  on core.job_runs (idempotency_key) where status <> 'failed';
create index if not exists idx_job_runs_org_job_started
  on core.job_runs (org_id, job_key, started_at desc);
create index if not exists idx_job_runs_started on core.job_runs (started_at);

-- ── RLS + grants (migration-154 pattern: member_read + service_all) ──────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['scheduled_jobs', 'job_runs'] loop
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'core' and tablename = t loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy member_read on core.%I for select using (org_id is not null and org_id = public.get_org_id())', t);
    execute format(
      'create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from anon, authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- ── Single-flight lock: claim ─────────────────────────────────────────────────
-- Upserts the (job, org) state row, then claims its lock iff free or expired.
-- Returns TRUE when THIS caller now holds the lock, FALSE when someone else does.
create or replace function core.scheduler_try_lock(
  p_job_key     text,
  p_org_id      uuid,
  p_owner       text,
  p_ttl_seconds integer
) returns boolean
language plpgsql
volatile
set search_path = core, public
as $$
declare
  claimed uuid;
begin
  if p_owner is null or p_owner = '' then
    raise exception 'scheduler_try_lock: owner required';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'scheduler_try_lock: ttl must be 1..3600 seconds';
  end if;

  insert into core.scheduled_jobs (job_key, org_id, location_id)
  values (p_job_key, p_org_id, null)
  on conflict do nothing;

  update core.scheduled_jobs
     set lock_owner      = p_owner,
         lock_expires_at = now() + make_interval(secs => p_ttl_seconds),
         updated_at      = now()
   where job_key = p_job_key
     and org_id is not distinct from p_org_id
     and location_id is null
     and (lock_owner is null or lock_expires_at is null or lock_expires_at <= now())
  returning id into claimed;

  return claimed is not null;
end $$;

revoke all on function core.scheduler_try_lock(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function core.scheduler_try_lock(text, uuid, text, integer) to service_role;
