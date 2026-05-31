-- Migration 020: core.jobs archetype (thin-identity completion)
-- =============================================================
-- Adds the job archetype/template classifier to the thin core.jobs identity
-- contract. Core-owned, written by the creating module (Projects, or Core/manual
-- before Projects exists). Nullable; no backfill needed.
--
-- Schema-agnostic: targets jobs wherever it currently lives (core after
-- migration 019; public if 019 has not yet been applied). Idempotent.
-- =============================================================

do $$
declare
  sch text;
begin
  select table_schema into sch
  from information_schema.tables
  where table_name = 'jobs' and table_schema in ('core', 'public')
  order by case table_schema when 'core' then 0 else 1 end
  limit 1;

  if sch is null then
    raise notice 'jobs table not found in core or public; nothing to do.';
    return;
  end if;

  execute format(
    'alter table %I.jobs add column if not exists archetype text',
    sch
  );

  execute format(
    $c$comment on column %I.jobs.archetype is
      'Job archetype / template classifier (e.g., service-call, fixed-bid-construction, T&M, retainer). Core-owned thin-identity field; set by the creating module. Distinct from job_type (industry tag).'$c$,
    sch
  );

  raise notice 'Added archetype to %.jobs', sch;
end $$;
