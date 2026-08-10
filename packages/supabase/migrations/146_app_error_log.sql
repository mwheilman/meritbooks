-- =============================================================================
-- Migration 146: application error / observability log.
-- =============================================================================
-- Internal error-capture sink so failures are VISIBLE (an ops health dashboard reads
-- it) even before a paid APM (Sentry) is wired — a Sentry DSN is a later env swap that
-- ALSO forwards, but this table means we are never blind. Captures API + UI + job
-- errors with enough context to triage, and NEVER stores secrets.
--
-- SAFETY / CANON §3: additive + idempotent; diagnostics only. org_id is nullable
-- (some failures occur pre-tenant-resolution). RLS: org rows isolate via get_org_id();
-- the cross-tenant ops view reads through the service role and is platform-staff-gated
-- in the app. Stack/message must be scrubbed of secrets by the writer.
-- =============================================================================

create table if not exists public.app_error_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid,                            -- nullable; set when resolvable
  occurred_at  timestamptz not null default now(),
  level        text not null default 'ERROR' check (level in ('ERROR','WARN','FATAL')),
  source       text not null default 'api' check (source in ('api','ui','job','webhook')),
  route        text,
  message      text not null,
  stack        text,
  digest       text,                            -- stable hash for grouping/dedup
  user_id      text,
  request_id   text,
  meta         jsonb,
  resolved     boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on table public.app_error_log is
  'Application error/observability sink (API/UI/job/webhook). Never stores secrets. org_id nullable for pre-tenant failures. Ops dashboard reads via service role (platform-staff gated); a Sentry DSN, when set, additionally forwards.';

create index if not exists ix_app_error_log_occurred on public.app_error_log (occurred_at desc);
create index if not exists ix_app_error_log_org       on public.app_error_log (org_id, occurred_at desc);
create index if not exists ix_app_error_log_digest    on public.app_error_log (digest);

alter table public.app_error_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='app_error_log' and policyname='org_isolation_read')
    then create policy "org_isolation_read" on public.app_error_log for select using (org_id is not null and org_id = public.get_org_id()); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='app_error_log' and policyname='service_write')
    then create policy "service_write" on public.app_error_log for all to service_role using (true) with check (true); end if;
end $$;

grant select on public.app_error_log to authenticated;
grant select, insert, update, delete on public.app_error_log to service_role;
