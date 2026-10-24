-- ============================================================================
-- 1112 · Merit Projects — scheduling engine: working calendars, CPM, reschedule / preview,
--        links, outline (indent / order), baselines + variance, templates, look-ahead,
--        resource load, all-jobs summary
--
-- Spec: docs/projects/WAVE1-SCHEDULE-SPEC.md §2 (the fixed contract — every name below is the
-- §2 name). Access model: 1110_pm_access.sql (policy classes, pm.can, guarded definer RPCs,
-- masked views). Client mirror: apps/projects/src/lib/pm/schedule/cpm.ts; both are tested on
-- the shared cases in packages/projects-access/test/fixtures/cpm-cases.json.
--
-- What this migration creates
--   pm.work_calendars (company calendar, or org-wide when location_id is null), pm.work_calendar_days
--     (exceptions: holiday = is_workday false, extra working day = true); every existing org gets an
--     org default "Standard (Mon–Fri, 8 h)". pm.schedule_calendar(p_job): pm.schedules.calendar_id →
--     the company default → the org default → null (= built-in Mon–Fri, 8 h). Working-day helpers
--     pm.cal_is_workday / cal_workdays / cal_count / cal_workdays_between / cal_add_workdays.
--   pm.schedules — one per job: calendar_id, anchor_start (project start), status_date (data date),
--     cpm_at, start_on, finish_on, critical_count, task_count, ignored_links.
--   pm.tasks (additive): constraint_type (ASAP|SNET|FNLT|MSO), constraint_date, actual_start,
--     actual_finish, assigned_crew_id, assigned_vendor_id, commitment_id, hours_per_day, early_start,
--     early_finish, late_start, late_finish, total_float, free_float, is_critical, is_summary,
--     constraint_conflict, cpm_at, template_ref, wbs_code. duration_days = WORKING days.
--     Existing rows: a start date becomes SNET on it (MS Project behaviour); DONE / IN_PROGRESS rows
--     get actual dates from their dates. Inserts: a start date without a constraint → SNET.
--     Progress coherence (trigger): an actual finish or 100 % → DONE; DONE fills actual dates;
--     % > 0 or an actual start → IN_PROGRESS; reopening clears the actual finish.
--   pm.task_deps guard: same job; lag −365…365 working days; no link to or from a phase (a task with
--     children — link one of its tasks); a link that closes a loop is refused naming it:
--     `PM_DEP_CYCLE: Drywall → Framing → Rough-in → Drywall` (the new link's predecessor first).
--     The loop check runs once per statement (set_task_links / template apply insert many links).
--     A task with links cannot be given children (indent / insert under it is refused).
--   pm.schedule_cpm(p_job) returns setof pm.tasks — CPM (below), written onto pm.tasks + pm.schedules,
--     idempotent (a second run changes no row). billing_amount_cents is nulled unless the caller
--     holds projects.contract_value on the job (same rule as pm.v_tasks_masked).
--   pm.reschedule_task(p_task, p_new_start, p_new_duration) → jsonb {changed:[{id, title, start_on,
--     due_on, early_start, early_finish, late_start, late_finish, total_float, free_float, is_critical,
--     duration_days, is_summary, status}], finish_before, finish_after, finish_delta_days, moved_count,
--     critical_count}. A new start becomes SNET (MSO keeps its type, takes the date); a new duration
--     replaces it (≥ 1 for a task; a milestone stays 0). A phase moves by shifting its unstarted tasks
--     by the same working days (its duration cannot be set). A started task's start is not moved
--     (PM_SCHEDULE_STARTED — change its actual start). moved_count = non-phase tasks whose start or
--     finish changed (the dragged one included); changed also lists float / critical changes.
--   pm.preview_reschedule(...) — the same result computed inside a rolled-back subtransaction: no row,
--     header or timestamp changes (projects.jobs:edit, like the edit it previews).
--   pm.set_task_links(p_task, p_links jsonb [{pred_id, dep_type, lag_days}]) — replaces the task's
--     predecessors, re-runs CPM, returns the reschedule shape.
--   pm.indent_task(p_task, 'in'|'out'): in = last child of the previous sibling; out = sibling of its
--     parent, right after the parent's branch. pm.move_task_order(p_task, p_after_task): after a
--     sibling-or-other row = that row's sibling right after its branch; after its own parent = first
--     child; null = first among its siblings. sort is renumbered to the outline (preorder) order;
--     wbs_code ("1.2.3") is the outline number. Both return the reschedule shape.
--   Baselines: pm.schedule_baselines (one active per job) + pm.schedule_baseline_tasks (task_id,
--     start_on, due_on, duration_days …); pm.set_schedule_baseline(p_job, p_name) → baseline id
--     (runs CPM first); pm.v_schedule_variance (working-day start / finish / duration variance vs
--     the active baseline; + = later).
--   Templates: pm.schedule_template_catalog (global, per pack: body {items:[{ref, kind
--     phase|task|milestone, parent, name, duration, deps:[{ref, type, lag}]}]}) → pm.schedule_templates
--     (per company; PACK copies seeded for every company's installed packs + general, on install;
--     TENANT templates validated). pm.apply_schedule_template(p_job, p_template, p_start):
--     p_template = a pm.schedule_templates id, or a template key (company first, then catalog).
--     Phases become summary rows, tasks / milestones their children, links copied; into an empty job
--     p_start is the project start, into a job with tasks the template's first tasks get SNET p_start.
--     Seeded: kitchen remodel (29), bathroom remodel (21), custom home (133), commercial tenant
--     improvement (65), HVAC replacement install (14), cabinet ETO job (25), flooring install (11),
--     RE development milestones (29), trade rough-in + trim (11), design project (11), engagement (7),
--     PDI + delivery (6), simple project (6).
--   pm.v_schedule_jobs (one row per job with a schedule or tasks: dates, counts, % complete, next
--     milestone, active baseline finish + variance; filter by location_id / pm_user_id / stage_key).
--   pm.schedule_lookahead(p_from, p_days) — open leaf tasks starting or active in the window, on the
--     caller's jobs, with trade (crew → vendor → cost code), and constraints jsonb [{kind, label,
--     ref_id}]: predecessor (FS/FF predecessor not done, SS/SF not started), material (the task's PO
--     — pm.commitments PO via tasks.commitment_id — not approved / lines not fully received; or
--     pm.procurement_items on the task's WBS node not yet received), submittal (proj.submittals row
--     named by tasks.ext._submittal_id not APPROVED / APPROVED_AS_NOTED — the legacy table is the
--     only submittal store; read only when it exists), other (BLOCKED, constraint date cannot be met).
--   pm.resource_load(p_from, p_to) — crew / vendor / employee × working day hours: open tasks
--     (hours_per_day, else the calendar's) plus dispatch_assignments slot hours; capacity from
--     pm.crews.capacity_minutes_per_day (employee 8 h, vendor none).
--
-- CPM (same model as the client mirror; P6-style integer boundaries on the job's working days)
--   A task occupies working days es … ef−1 (ef = es + duration); duration 0 = a point (milestone).
--   Durations: milestone 0; duration_days; legacy rows without one = working days in [start, due]
--   (≥ 1); else 1. Phases (tasks with a non-cancelled child) and CANCELLED tasks are not in the
--   network; links touching them are ignored (counted in pm.schedules.ignored_links).
--   Links (lag in working days): FS es(s) ≥ ef(p)+lag · SS es(s) ≥ es(p)+lag · FF ef(s) ≥ ef(p)+lag ·
--   SF ef(s) ≥ es(p)+lag. Every unstarted task starts ≥ the project start (anchor) and ≥ the status
--   date; SNET raises its start; MSO sets it (conflict flagged when logic needs later) and pins its
--   late dates; FNLT caps its late finish (conflict when early finish is later → negative float).
--   Actual start / finish pin a task (an actual finish → late = early). In progress with a status
--   date: finish ≥ status date + ceil(remaining = duration × (1 − %)), at least 1.
--   A point with predecessors is a finish milestone, shown on the last working day before its
--   boundary; one without is a start milestone, shown on the boundary day.
--   Backward pass from the project finish (max early finish): total float = lf − ef; free float =
--   min link slack (no successor: project finish − ef), capped at total float. Critical = total
--   float ≤ 0 and not finished. Phases roll up from children: min start / max finish, early / late
--   min / max, min floats, any critical / conflict, duration-weighted % (rounded to 4 places),
--   status (all DONE → DONE, any started → IN_PROGRESS, else TODO; CANCELLED kept), actual start =
--   min, actual finish = max when every child has one. Anchor: pm.schedules.anchor_start →
--   pm.projects.planned_start → earliest task start / actual start / constraint date → today (then
--   persisted, so a schedule never drifts with the clock).
--
-- ACCESS (1110 classes; all registered in pm.access_table_classes)
--   J  schedules (write projects.jobs; members may set calendar_id / anchor_start / status_date —
--      the change re-runs CPM), schedule_baselines + schedule_baseline_tasks (written only by
--      pm.set_schedule_baseline).
--   S  work_calendars, work_calendar_days (parent), schedule_templates: read by every Projects
--      member of the company; write projects.settings:configure. schedule_template_catalog: S / org
--      (any Projects member reads; nobody writes but service_role).
--   pm.tasks: members lose table-level UPDATE and keep it on every column except id / org_id /
--     created_at and the engine's outputs (early / late dates, floats, is_critical, is_summary,
--     constraint_conflict, cpm_at, template_ref, wbs_code). pm.v_tasks_masked is rebuilt
--     (pm.access_apply_masks) so it carries the new columns.
--   RPCs (definer, org-guarded, registered in pm.access_rpc_guards): projects.jobs:edit on the job for
--     schedule_cpm, reschedule_task, preview_reschedule, set_task_links, indent_task, move_task_order,
--     set_schedule_baseline, apply_schedule_template;
--     schedule_lookahead / resource_load need projects.jobs or jobs_all:view and only ever read the
--     caller's jobs (pm.my_job_ids()). Labor (jobs:view) reads its own jobs' schedules, cannot write.
--     Internal helpers (pm._*) and trigger functions are service-only.
--
-- SECURITY REVIEW (2026-10-24), fixed here (section 15 unless noted):
--   M1 org-wide calendars (location_id null) and their days: writes need projects.settings:configure at
--      every company of the org or an owner / admin seat (pm.schedule_org_settings_ok, restrictive
--      pm_sched_orgcal_* policies); a job's schedule may use only its company's or an org-wide calendar.
--   M2 dates bounded to 1900-01-01 … 2200-12-31 (tasks constraint / actual / start / due, schedules
--      anchor / status date, calendar days); CPM refuses spans over ~40 years (PM_SCHEDULE_RANGE) and
--      jobs over 10,000 tasks (PM_SCHEDULE_TOO_LARGE, also checked per insert statement); a legacy
--      duration derived from dates is capped at 3,650 working days.
--   L1 outline edits take a per-job advisory lock (tg_task_hierarchy) so racing re-parents cannot form a
--      loop; recursive walks use UNION; CPM refuses an outline loop (PM_SCHEDULE_OUTLINE_LOOP).
--   L2 look-ahead submittals: the caller's org, a reachable job, and the task's own job only.
--   L3 pm.preview_reschedule requires projects.jobs:edit.
--   +  tasks.billing_amount_cents / billing_pct: a member write needs projects.contract_value on the job
--      (pm.tg_task_billing_guard).
--
-- DEVIATIONS / JUDGMENT CALLS (reported to the lead)
--   * pm.schedule_baseline_tasks stores due_on (the pm.tasks name), not "finish_on".
--   * Links to / from phases are refused (the client mirror ignores them; MS Project expands them).
--   * Submittal reason: no pm submittals table exists; the legacy proj.submittals table is read
--     through tasks.ext._submittal_id (an ext key starting with "_" needs no field definition).
--   * The lookahead / resource load show the crew, vendor and employee names of tasks on the
--     caller's own jobs (a supervisor needs to know who is coming), even without dispatch / purchasing.
--
-- APPLY RULE: after 1110 / 1111. Idempotent: safe twice; 1110 / 1111 can be re-applied after it.
-- ============================================================================

do $$
begin
  if to_regclass('pm.access_table_classes') is null then
    raise exception '1112_pm_schedule requires 1110_pm_access';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Working calendars
-- ----------------------------------------------------------------------------
create table if not exists pm.work_calendars (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid references core.locations(id),          -- null = org-wide
  name           text not null check (char_length(btrim(name)) between 1 and 80),
  workdays       smallint[] not null default '{1,2,3,4,5}'
                   check (cardinality(workdays) between 1 and 7 and workdays <@ '{1,2,3,4,5,6,7}'::smallint[]),
  hours_per_day  numeric(4,2) not null default 8 check (hours_per_day > 0 and hours_per_day <= 24),
  is_default     boolean not null default false,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id)
);
create unique index if not exists pm_work_calendars_name_uidx
  on pm.work_calendars (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create unique index if not exists pm_work_calendars_default_uidx
  on pm.work_calendars (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_default;
comment on table pm.work_calendars is
  '1112: working calendars (ISO weekdays 1 = Monday … 7 = Sunday, hours a day). location_id null = org-wide. One default per company and one org default.';

create table if not exists pm.work_calendar_days (
  org_id       uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  calendar_id  uuid not null,
  day          date not null,
  is_workday   boolean not null default false,          -- false = holiday; true = extra working day
  name         text check (name is null or char_length(name) <= 80),
  created_at   timestamptz not null default now(),
  primary key (calendar_id, day),
  foreign key (org_id, calendar_id) references pm.work_calendars (org_id, id) on delete cascade deferrable initially immediate
);
comment on table pm.work_calendar_days is '1112: calendar exceptions — a holiday (is_workday false) or a working day off the normal week (true).';

create or replace trigger trg_touch_updated_at before update on pm.work_calendars
  for each row execute function pm.tg_touch_updated_at();
create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.work_calendars
  for each row execute function pm.tg_location_in_org();

-- every org gets an org-wide default calendar (idempotent)
insert into pm.work_calendars (org_id, location_id, name, workdays, hours_per_day, is_default)
select o.id, null, 'Standard (Mon–Fri, 8 h)', '{1,2,3,4,5}', 8, true
  from core.organizations o
 where not exists (select 1 from pm.work_calendars c where c.org_id = o.id and c.location_id is null and c.is_default)
   and not exists (select 1 from pm.work_calendars c where c.org_id = o.id and c.location_id is null and lower(c.name) = lower('Standard (Mon–Fri, 8 h)'));

-- ----------------------------------------------------------------------------
-- 2. Schedule header (one per job)
-- ----------------------------------------------------------------------------
create table if not exists pm.schedules (
  job_id          uuid primary key,
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  calendar_id     uuid,
  anchor_start    date,          -- project start: unstarted work never starts before it
  status_date     date,          -- data date: unstarted work is not scheduled before it (null = off)
  cpm_at          timestamptz,   -- last CPM run
  start_on        date,          -- first working day on / after the anchor (last run)
  finish_on       date,          -- project finish (last run)
  critical_count  int,
  task_count      int,
  ignored_links   int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, job_id),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate,
  foreign key (org_id, calendar_id) references pm.work_calendars (org_id, id) on delete set null (calendar_id) deferrable initially immediate
);
comment on table pm.schedules is '1112: one schedule header per job (calendar, project start, status date, last CPM result).';
create or replace trigger trg_touch_updated_at before update on pm.schedules
  for each row execute function pm.tg_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Working-day helpers (invoker; a null / unknown calendar = Monday–Friday)
-- ----------------------------------------------------------------------------
create or replace function pm.cal_is_workday(p_cal uuid, p_day date) returns boolean
language sql stable
set search_path = pm, core, public
as $$
  select coalesce(
    (select x.is_workday from pm.work_calendar_days x where x.calendar_id = p_cal and x.day = p_day),
    extract(isodow from p_day)::smallint = any (coalesce((select c.workdays from pm.work_calendars c where c.id = p_cal), '{1,2,3,4,5}'::smallint[])))
$$;

-- Working days in [p_from, p_to], ascending.
create or replace function pm.cal_workdays(p_cal uuid, p_from date, p_to date) returns date[]
language sql stable
set search_path = pm, core, public
as $$
  select coalesce(array_agg(g.d order by g.d), '{}'::date[])
    from (select gs::date as d from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs) g
    cross join (select coalesce((select c.workdays from pm.work_calendars c where c.id = p_cal), '{1,2,3,4,5}'::smallint[]) as wd) c
    left join pm.work_calendar_days x on x.calendar_id = p_cal and x.day = g.d
   where coalesce(x.is_workday, extract(isodow from g.d)::smallint = any (c.wd))
$$;

-- Working days in [p_from, p_to] (0 when p_to < p_from).
create or replace function pm.cal_count(p_cal uuid, p_from date, p_to date) returns int
language sql stable
set search_path = pm, core, public
as $$
  select case when p_from is null or p_to is null or p_to < p_from then 0 else cardinality(pm.cal_workdays(p_cal, p_from, p_to)) end
$$;

-- Signed working days in (a, b] (b > a), or minus those in (b, a] (b < a). + = b is later.
create or replace function pm.cal_workdays_between(p_cal uuid, p_a date, p_b date) returns int
language sql stable
set search_path = pm, core, public
as $$
  select case when p_a is null or p_b is null then null
              when p_b = p_a then 0
              when p_b > p_a then cardinality(pm.cal_workdays(p_cal, p_a + 1, p_b))
              else -cardinality(pm.cal_workdays(p_cal, p_b + 1, p_a)) end
$$;

-- n > 0: the n-th working day after p_day; n < 0: the |n|-th before; n = 0: first working day on / after.
create or replace function pm.cal_add_workdays(p_cal uuid, p_day date, p_n int) returns date
language plpgsql stable
set search_path = pm, core, public
as $$
declare w date[]; v_span int := (abs(coalesce(p_n, 0)) + 1) * 7 + 60; v_n int := coalesce(p_n, 0);
begin
  if p_day is null then return null; end if;
  loop
    if v_n >= 0 then
      w := pm.cal_workdays(p_cal, case when v_n = 0 then p_day else p_day + 1 end, p_day + v_span);
      if cardinality(w) >= greatest(v_n, 1) then return w[greatest(v_n, 1)]; end if;
    else
      w := pm.cal_workdays(p_cal, p_day - v_span, p_day - 1);
      if cardinality(w) >= -v_n then return w[cardinality(w) + v_n + 1]; end if;
    end if;
    if v_span > 40000 then raise exception 'PM_SCHEDULE_CALENDAR: the calendar has no working days near %', p_day using errcode = '22023'; end if;
    v_span := v_span * 2;
  end loop;
end $$;

-- The job's calendar: its schedule's, else the company default, else the org default, else null
-- (= Monday–Friday, 8 h). Invoker: members resolve it through pm.projects (core.jobs is narrowed
-- for Projects-only seats).
create or replace function pm.schedule_calendar(p_job uuid) returns uuid
language sql stable
set search_path = pm, core, public
as $$
  with j as (
    select coalesce((select p.org_id from pm.projects p where p.job_id = p_job),
                    (select cj.org_id from core.jobs cj where cj.id = p_job)) as org_id,
           coalesce((select p.location_id from pm.projects p where p.job_id = p_job),
                    (select cj.location_id from core.jobs cj where cj.id = p_job)) as location_id)
  select coalesce(
    (select s.calendar_id from pm.schedules s where s.job_id = p_job and s.calendar_id is not null),
    (select c.id from pm.work_calendars c, j where c.org_id = j.org_id and c.location_id = j.location_id and c.is_default
      order by c.created_at, c.id limit 1),
    (select c.id from pm.work_calendars c, j where c.org_id = j.org_id and c.location_id is null and c.is_default
      order by c.created_at, c.id limit 1))
$$;
comment on function pm.schedule_calendar(uuid) is '1112 / spec §2: job → company default → org default calendar (null = built-in Mon–Fri, 8 h).';

-- ----------------------------------------------------------------------------
-- 4. pm.tasks: scheduling columns (additive)
-- ----------------------------------------------------------------------------
alter table pm.tasks add column if not exists constraint_type     text;
alter table pm.tasks add column if not exists constraint_date     date;
alter table pm.tasks add column if not exists actual_start        date;
alter table pm.tasks add column if not exists actual_finish       date;
alter table pm.tasks add column if not exists assigned_crew_id    uuid;
alter table pm.tasks add column if not exists assigned_vendor_id  uuid references core.vendors(id) on delete set null;
alter table pm.tasks add column if not exists commitment_id       uuid;
alter table pm.tasks add column if not exists hours_per_day       numeric(5,2);
alter table pm.tasks add column if not exists early_start         date;
alter table pm.tasks add column if not exists early_finish        date;
alter table pm.tasks add column if not exists late_start          date;
alter table pm.tasks add column if not exists late_finish         date;
alter table pm.tasks add column if not exists total_float         int;
alter table pm.tasks add column if not exists free_float          int;
alter table pm.tasks add column if not exists is_critical         boolean not null default false;
alter table pm.tasks add column if not exists is_summary          boolean not null default false;
alter table pm.tasks add column if not exists constraint_conflict boolean not null default false;
alter table pm.tasks add column if not exists cpm_at              timestamptz;
alter table pm.tasks add column if not exists template_ref        text;
alter table pm.tasks add column if not exists wbs_code            text;

comment on column pm.tasks.duration_days is '1112: WORKING days on the job calendar (0 = milestone).';
comment on column pm.tasks.constraint_type is '1112: ASAP | SNET (start no earlier than) | FNLT (finish no later than) | MSO (must start on).';
comment on column pm.tasks.total_float is '1112: working days (CPM output).';
comment on column pm.tasks.free_float is '1112: working days (CPM output).';

-- Existing rows (one-time, idempotent): a start date is kept as SNET; done / started work gets its actuals.
update pm.tasks set constraint_type = case when start_on is not null then 'SNET' else 'ASAP' end,
                    constraint_date = start_on
 where constraint_type is null;
update pm.tasks set actual_finish = coalesce(due_on, completed_at::date),
                    actual_start  = least(coalesce(start_on, due_on, completed_at::date), coalesce(due_on, completed_at::date))
 where status = 'DONE' and actual_finish is null and coalesce(due_on, completed_at::date) is not null;
update pm.tasks set actual_start = least(start_on, current_date)
 where status = 'IN_PROGRESS' and actual_start is null and start_on is not null;
alter table pm.tasks alter column constraint_type set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_constraint_type_check') then
    alter table pm.tasks add constraint tasks_constraint_type_check
      check (constraint_type in ('ASAP','SNET','FNLT','MSO') and ((constraint_type = 'ASAP') = (constraint_date is null)));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_actuals_check') then
    alter table pm.tasks add constraint tasks_actuals_check
      check (actual_finish is null or actual_start is null or actual_finish >= actual_start);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_hours_per_day_check') then
    alter table pm.tasks add constraint tasks_hours_per_day_check
      check (hours_per_day is null or (hours_per_day > 0 and hours_per_day <= 24));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_duration_bound_check') then
    alter table pm.tasks add constraint tasks_duration_bound_check check (duration_days is null or duration_days <= 3650);
  end if;
  -- security review M2: dates stay in 1900-01-01 … 2200-12-31 (far dates would make CPM span centuries)
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_schedule_dates_range_check') then
    alter table pm.tasks add constraint tasks_schedule_dates_range_check
      check (    (constraint_date is null or constraint_date between '1900-01-01' and '2200-12-31')
             and (actual_start    is null or actual_start    between '1900-01-01' and '2200-12-31')
             and (actual_finish   is null or actual_finish   between '1900-01-01' and '2200-12-31'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_plan_dates_range_check') then
    -- NOT VALID: enforced on every new write; legacy rows are not re-validated
    alter table pm.tasks add constraint tasks_plan_dates_range_check
      check (    (start_on is null or start_on between '1900-01-01' and '2200-12-31')
             and (due_on   is null or due_on   between '1900-01-01' and '2200-12-31')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_template_ref_check') then
    alter table pm.tasks add constraint tasks_template_ref_check
      check (template_ref is null or template_ref ~ '^[a-z][a-z0-9_]{0,47}:[a-z0-9_:]{1,100}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_assigned_crew_fkey') then
    alter table pm.tasks add constraint tasks_assigned_crew_fkey
      foreign key (org_id, assigned_crew_id) references pm.crews (org_id, id) on delete set null (assigned_crew_id) deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.tasks'::regclass and conname = 'tasks_commitment_fkey') then
    alter table pm.tasks add constraint tasks_commitment_fkey
      foreign key (org_id, commitment_id) references pm.commitments (org_id, id) on delete set null (commitment_id) deferrable initially immediate;
  end if;
end $$;

create unique index if not exists pm_tasks_template_ref_uidx on pm.tasks (org_id, job_id, template_ref) where template_ref is not null;
create index if not exists pm_tasks_parent_idx on pm.tasks (org_id, parent_task_id) where parent_task_id is not null;
create index if not exists pm_tasks_crew_idx on pm.tasks (org_id, assigned_crew_id, start_on) where assigned_crew_id is not null;
create index if not exists pm_tasks_window_idx on pm.tasks (org_id, start_on, due_on) where status not in ('DONE','CANCELLED');
create index if not exists pm_task_deps_pred_idx on pm.task_deps (org_id, pred_id);

-- Constraint defaults: a start date given on insert without a constraint becomes SNET; ASAP has no
-- date; SNET / FNLT / MSO without a date take the start (else today); milestones are 0 days.
create or replace function pm.tg_task_schedule_defaults() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if new.constraint_type is null then
    if tg_op = 'INSERT' and new.start_on is not null then
      new.constraint_type := 'SNET'; new.constraint_date := new.start_on;
    else
      new.constraint_type := 'ASAP'; new.constraint_date := null;
    end if;
  elsif new.constraint_type = 'ASAP' then
    new.constraint_date := null;
  elsif new.constraint_date is null then
    new.constraint_date := coalesce(new.start_on, current_date);
  end if;
  if new.is_milestone then new.duration_days := 0; end if;
  return new;
end $$;

-- Outline integrity: a parent on the same job, no loop, and a task with links cannot get children
-- (links to / from phases are refused — see the dependency guard). A task with links or children
-- cannot change job.
create or replace function pm.tg_task_hierarchy() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_title text;
begin
  if tg_op = 'UPDATE' and new.job_id is distinct from old.job_id then
    if exists (select 1 from pm.task_deps d where d.org_id = new.org_id and (d.pred_id = new.id or d.succ_id = new.id))
       or exists (select 1 from pm.tasks c where c.org_id = new.org_id and c.parent_task_id = new.id) then
      raise exception 'PM_SCHEDULE_CROSS_JOB: "%" has links or tasks under it; it cannot move to another job', new.title using errcode = '23514';
    end if;
  end if;
  if new.parent_task_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.parent_task_id is not distinct from old.parent_task_id and new.job_id = old.job_id then return new; end if;
  -- security review L1: one outline change per job at a time, so two racing re-parents cannot both
  -- pass the loop check against the old tree (the check below then sees the other's committed edit)
  perform pg_advisory_xact_lock(hashtextextended('pm.task_tree:' || new.job_id::text, 0));
  select t.job_id, t.title into v_job, v_title from pm.tasks t where t.org_id = new.org_id and t.id = new.parent_task_id;
  if v_job is null or v_job <> new.job_id then
    raise exception 'PM_SCHEDULE_CROSS_JOB: a task and its parent must be on the same job' using errcode = '23514';
  end if;
  if new.parent_task_id = new.id or exists (
       with recursive up(id, parent_id) as (
         select t.id, t.parent_task_id from pm.tasks t where t.org_id = new.org_id and t.id = new.parent_task_id
         union
         select t.id, t.parent_task_id from pm.tasks t join up on t.id = up.parent_id where t.org_id = new.org_id)
       select 1 from up where up.id = new.id) then
    raise exception 'PM_INVALID: "%" cannot sit under one of its own tasks', new.title using errcode = '22023';
  end if;
  if exists (select 1 from pm.task_deps d where d.org_id = new.org_id and (d.pred_id = new.parent_task_id or d.succ_id = new.parent_task_id)) then
    raise exception 'PM_SCHEDULE_LINKED_PARENT: "%" has links. Remove its links before putting tasks under it.', v_title using errcode = '23514';
  end if;
  return new;
end $$;

-- Status ⇄ progress ⇄ actual dates stay coherent (changes only; the engine's own writes skip it).
create or replace function pm.tg_task_progress() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
declare v_ins boolean := tg_op = 'INSERT';
begin
  if coalesce(current_setting('pm.schedule_writing', true), '') = 'on' then return new; end if;
  -- an actual finish, or 100 %, means done
  if new.status not in ('DONE','CANCELLED') and (
       (new.actual_finish is not null and (v_ins or old.actual_finish is distinct from new.actual_finish))
    or (new.pct_complete = 1 and (v_ins or old.pct_complete is distinct from new.pct_complete))) then
    new.status := 'DONE';
  end if;
  if new.status = 'DONE' and (v_ins or old.status <> 'DONE') then
    new.pct_complete := 1;
    new.actual_finish := coalesce(new.actual_finish, least(coalesce(new.due_on, current_date), current_date));
    new.actual_start := coalesce(new.actual_start, least(coalesce(new.start_on, new.actual_finish), new.actual_finish));
    new.completed_at := coalesce(new.completed_at, now());
  elsif not v_ins and old.status = 'DONE' and new.status in ('TODO','IN_PROGRESS','BLOCKED') then
    -- reopened: the finish is no longer actual
    if new.actual_finish is not distinct from old.actual_finish then new.actual_finish := null; end if;
    if new.pct_complete = 1 then new.pct_complete := null; end if;
    new.completed_at := null;
  end if;
  -- started
  if new.status = 'TODO' and (
       (coalesce(new.pct_complete, 0) > 0 and (v_ins or old.pct_complete is distinct from new.pct_complete))
    or (new.actual_start is not null and (v_ins or old.actual_start is distinct from new.actual_start))) then
    new.status := 'IN_PROGRESS';
  end if;
  if new.status = 'IN_PROGRESS' and new.actual_start is null and (v_ins or old.status is distinct from 'IN_PROGRESS') then
    new.actual_start := least(coalesce(new.start_on, current_date), current_date);
  end if;
  return new;
end $$;

-- A task's commitment is on the same job; it names the sub when the task does not.
create or replace function pm.tg_task_commitment() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_vendor uuid;
begin
  if new.commitment_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.commitment_id is not distinct from old.commitment_id and new.job_id = old.job_id then return new; end if;
  select c.job_id, c.vendor_id into v_job, v_vendor from pm.commitments c where c.org_id = new.org_id and c.id = new.commitment_id;
  if v_job is null or v_job <> new.job_id then
    raise exception 'PM_SCHEDULE_COMMITMENT_JOB: that commitment is on a different job' using errcode = '23514';
  end if;
  new.assigned_vendor_id := coalesce(new.assigned_vendor_id, v_vendor);
  return new;
end $$;

create or replace trigger trg_task_schedule_defaults
  before insert or update of constraint_type, constraint_date, is_milestone, duration_days on pm.tasks
  for each row execute function pm.tg_task_schedule_defaults();
create or replace trigger trg_task_hierarchy
  before insert or update of parent_task_id, job_id on pm.tasks
  for each row execute function pm.tg_task_hierarchy();
create or replace trigger trg_task_progress
  before insert or update of status, pct_complete, actual_start, actual_finish on pm.tasks
  for each row execute function pm.tg_task_progress();
create or replace trigger trg_task_commitment
  before insert or update of commitment_id, job_id on pm.tasks
  for each row execute function pm.tg_task_commitment();
create or replace trigger trg_task_refs_in_org
  before insert or update of assigned_vendor_id, assignee_employee_id, org_id on pm.tasks
  for each row execute function pm.tg_refs_in_org('assigned_vendor_id:core.vendors', 'assignee_employee_id:core.employees');

-- ----------------------------------------------------------------------------
-- 5. Dependency guard: same job, lag bounds, no phase links, and no loops (the error names it)
-- ----------------------------------------------------------------------------

-- Does the job's link graph (every link, cancelled tasks and phases included) have a loop? Kahn.
create or replace function pm._dep_has_cycle(p_job uuid) returns boolean
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid; v_ids uuid[]; v_from int[]; v_to int[]; v_n int; v_m int; v_os int[]; v_deg int[]; v_q int[];
  v_qh int := 1; v_qt int := 0; v_i int; v_e int; v_s int;
begin
  select jj.org_id into v_org from core.jobs jj where jj.id = p_job;
  select array_agg(tt.id order by tt.id) into v_ids from pm.tasks tt where tt.org_id = v_org and tt.job_id = p_job;
  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then return false; end if;
  with ix as (select ux.id, ux.i::int as i from unnest(v_ids) with ordinality as ux(id, i))
  select array_agg(ip.i order by ip.i, isx.i), array_agg(isx.i order by ip.i, isx.i) into v_from, v_to
    from pm.task_deps dd join ix isx on isx.id = dd.succ_id join ix ip on ip.id = dd.pred_id
   where dd.org_id = v_org and dd.succ_id = any (v_ids);
  v_m := coalesce(cardinality(v_from), 0);
  if v_m = 0 then return false; end if;
  v_os := array_fill(0, array[v_n + 1]); v_deg := array_fill(0, array[v_n]); v_q := array_fill(0, array[v_n]);
  for v_e in 1..v_m loop
    v_os[v_from[v_e] + 1] := v_os[v_from[v_e] + 1] + 1;
    v_deg[v_to[v_e]] := v_deg[v_to[v_e]] + 1;
  end loop;
  v_os[1] := 1;
  for v_i in 1..v_n loop v_os[v_i + 1] := v_os[v_i] + v_os[v_i + 1]; end loop;
  for v_i in 1..v_n loop if v_deg[v_i] = 0 then v_qt := v_qt + 1; v_q[v_qt] := v_i; end if; end loop;
  while v_qh <= v_qt loop
    v_i := v_q[v_qh]; v_qh := v_qh + 1;
    for v_e in v_os[v_i] .. v_os[v_i + 1] - 1 loop
      v_s := v_to[v_e]; v_deg[v_s] := v_deg[v_s] - 1;
      if v_deg[v_s] = 0 then v_qt := v_qt + 1; v_q[v_qt] := v_s; end if;
    end loop;
  end loop;
  return v_qt < v_n;
end $$;

-- Shortest link path p_from ⇝ p_to on the job (BFS), as task ids p_from … p_to; null when none.
create or replace function pm._dep_path(p_job uuid, p_from uuid, p_to uuid) returns uuid[]
language plpgsql stable security definer
set search_path = pm, core, public
as $$
declare
  v_org uuid; v_ids uuid[]; v_from int[]; v_to int[]; v_n int; v_m int; v_os int[]; v_prev int[]; v_q int[];
  v_qh int := 1; v_qt int := 0; v_i int; v_e int; v_s int; v_fi int; v_ti int; v_path uuid[] := '{}';
begin
  select jj.org_id into v_org from core.jobs jj where jj.id = p_job;
  select array_agg(tt.id order by tt.id) into v_ids from pm.tasks tt where tt.org_id = v_org and tt.job_id = p_job;
  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then return null; end if;
  v_fi := array_position(v_ids, p_from); v_ti := array_position(v_ids, p_to);
  if v_fi is null or v_ti is null then return null; end if;
  with ix as (select ux.id, ux.i::int as i from unnest(v_ids) with ordinality as ux(id, i))
  select array_agg(ip.i order by ip.i, isx.i), array_agg(isx.i order by ip.i, isx.i) into v_from, v_to
    from pm.task_deps dd join ix isx on isx.id = dd.succ_id join ix ip on ip.id = dd.pred_id
   where dd.org_id = v_org and dd.succ_id = any (v_ids);
  v_m := coalesce(cardinality(v_from), 0);
  v_os := array_fill(0, array[v_n + 1]); v_prev := array_fill(0, array[v_n]); v_q := array_fill(0, array[v_n]);
  for v_e in 1..v_m loop v_os[v_from[v_e] + 1] := v_os[v_from[v_e] + 1] + 1; end loop;
  v_os[1] := 1;
  for v_i in 1..v_n loop v_os[v_i + 1] := v_os[v_i] + v_os[v_i + 1]; end loop;
  v_qt := 1; v_q[1] := v_fi; v_prev[v_fi] := -1;
  while v_qh <= v_qt loop
    v_i := v_q[v_qh]; v_qh := v_qh + 1;
    exit when v_i = v_ti;
    for v_e in v_os[v_i] .. v_os[v_i + 1] - 1 loop
      v_s := v_to[v_e];
      if v_prev[v_s] = 0 then v_prev[v_s] := v_i; v_qt := v_qt + 1; v_q[v_qt] := v_s; end if;
    end loop;
  end loop;
  if v_prev[v_ti] = 0 then return null; end if;
  v_i := v_ti;
  while v_i <> -1 loop v_path := v_ids[v_i] || v_path; v_i := v_prev[v_i]; end loop;
  return v_path;
end $$;

create or replace function pm.tg_task_dep_guard() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_pj uuid; v_pt text; v_sj uuid; v_st text;
begin
  select t.job_id, t.title into v_pj, v_pt from pm.tasks t where t.org_id = new.org_id and t.id = new.pred_id;
  select t.job_id, t.title into v_sj, v_st from pm.tasks t where t.org_id = new.org_id and t.id = new.succ_id;
  if v_pj is null or v_sj is null or v_pj <> v_sj then
    raise exception 'PM_DEP_CROSS_JOB: both tasks of a link must be on the same job' using errcode = '23514';
  end if;
  if new.pred_id = new.succ_id then
    raise exception 'PM_DEP_CYCLE: % → %', v_pt, v_pt using errcode = '23514', hint = 'A task cannot follow itself.';
  end if;
  if new.lag_days < -365 or new.lag_days > 365 then
    raise exception 'PM_DEP_LAG: the lag must be between -365 and 365 working days (got %)', new.lag_days using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.pred_id = old.pred_id and new.succ_id = old.succ_id then return new; end if;
  if exists (select 1 from pm.tasks c where c.org_id = new.org_id and c.parent_task_id = new.pred_id and c.status <> 'CANCELLED') then
    raise exception 'PM_DEP_SUMMARY: "%" is a phase. Link to one of its tasks instead.', v_pt using errcode = '23514';
  end if;
  if exists (select 1 from pm.tasks c where c.org_id = new.org_id and c.parent_task_id = new.succ_id and c.status <> 'CANCELLED') then
    raise exception 'PM_DEP_SUMMARY: "%" is a phase. Link one of its tasks instead.', v_st using errcode = '23514';
  end if;
  return new;
end $$;

-- Once per statement: a loop anywhere on a touched job is refused, naming the loop through the new link.
create or replace function pm.tg_task_dep_cycle() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; r record; v_path uuid[]; v_names text;
begin
  for v_job in select distinct t.job_id from nt join pm.tasks t on t.id = nt.succ_id loop
    if pm._dep_has_cycle(v_job) then
      for r in select nt.pred_id, nt.succ_id from nt join pm.tasks t on t.id = nt.succ_id where t.job_id = v_job loop
        v_path := pm._dep_path(v_job, r.succ_id, r.pred_id);
        if v_path is not null then
          select string_agg(t.title, ' → ' order by x.o) into v_names
            from unnest(array[r.pred_id] || v_path) with ordinality as x(id, o) join pm.tasks t on t.id = x.id;
          raise exception 'PM_DEP_CYCLE: %', v_names using errcode = '23514', hint = 'Remove one of these links.';
        end if;
      end loop;
      raise exception 'PM_DEP_CYCLE: the links on this job loop back on themselves' using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

create or replace trigger trg_task_dep_guard before insert or update on pm.task_deps
  for each row execute function pm.tg_task_dep_guard();
drop trigger if exists trg_task_dep_cycle_ins on pm.task_deps;
create trigger trg_task_dep_cycle_ins after insert on pm.task_deps
  referencing new table as nt for each statement execute function pm.tg_task_dep_cycle();
drop trigger if exists trg_task_dep_cycle_upd on pm.task_deps;
create trigger trg_task_dep_cycle_upd after update on pm.task_deps
  referencing new table as nt for each statement execute function pm.tg_task_dep_cycle();

-- ----------------------------------------------------------------------------
-- 6. CPM engine (internal; the member RPCs below guard and call it)
-- ----------------------------------------------------------------------------

-- Ensure the job's schedule header exists and lock it (one CPM / structural edit per job at a time).
create or replace function pm._schedule_lock(p_job uuid) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_org uuid;
begin
  select j.org_id into v_org from core.jobs j where j.id = p_job;
  if v_org is null then raise exception 'PM_NOT_FOUND: job % not found', p_job using errcode = 'P0002'; end if;
  insert into pm.schedules (job_id, org_id) values (p_job, v_org) on conflict (job_id) do nothing;
  perform 1 from pm.schedules s where s.job_id = p_job for update;
  return v_org;
end $$;

create or replace function pm._schedule_run(p_job uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare
  v_org uuid; v_cal uuid; v_anchor date; v_dd date; v_wd smallint[]; v_prev_flag text; v_now timestamptz := now();
  vn int; vm int; vk int; vi int; vj int; ve int; vs int; vv int; vl int; vf int; vbd int; vx int; v_dur int; v_lvl int; v_maxd int := 0;
  v_ign int := 0; v_nodes int := 0; v_crit int := 0; v_finish date; v_tmp date[]; v_cnt int;
  -- tasks, index 1..n in outline order (sort, title, id)
  a_id uuid[]; a_title text[]; a_par int[]; a_st text[]; a_durin int[]; a_durraw int[]; a_son date[]; a_don date[];
  a_pct numeric[]; a_ct text[]; a_cd date[]; a_as date[]; a_af date[]; a_sum boolean[]; a_node boolean[];
  -- links sorted by predecessor index, CSR offsets
  e_from int[]; e_to int[]; e_typ int[]; e_lag int[]; a_os int[]; a_deg int[]; a_topo int[]; v_qh int := 1; v_qt int := 0;
  -- passes
  a_d int[]; a_es int[]; a_ef int[]; a_cand int[]; a_conf boolean[]; a_pin boolean[]; a_hasp boolean[];
  a_ls int[]; a_lf int[]; a_tf int[]; a_ff int[];
  -- working-day index: ordinal o is w[o + v_woff]; lt(D) = a_lt[D - v_b + 1] for D in [v_b, v_e + 1]
  v_b date; v_e date; a_lt int[]; w date[]; v_woff int := 1; v_p0 int; v_ddo int; v_pf int; v_omin int; v_omax int;
  -- outputs
  o_s date[]; o_d date[]; o_es date[]; o_ef date[]; o_ls date[]; o_lf date[]; o_tf int[]; o_ff int[];
  o_crit boolean[]; o_conf boolean[]; o_dur int[]; o_so int[]; o_fo int[]; o_st text[]; o_pct numeric[];
  o_as date[]; o_af date[]; o_has boolean[]; a_depth int[];
  -- roll-up accumulators, per phase
  g_s date[]; g_d date[]; g_es date[]; g_ef date[]; g_ls date[]; g_lf date[]; g_tf int[]; g_ff int[];
  g_crit boolean[]; g_conf boolean[]; g_w numeric[]; g_wp numeric[]; g_p numeric[]; g_c int[];
  g_alldone boolean[]; g_started boolean[]; g_as date[]; g_allaf boolean[]; g_af date[]; g_so int[]; g_fo int[];
  c_pct numeric; c_w numeric; c_st text; c_as date; c_af date;
  v_path uuid[]; v_names text;
begin
  select jj.org_id into v_org from core.jobs jj where jj.id = p_job;
  if v_org is null then raise exception 'PM_NOT_FOUND: job % not found', p_job using errcode = 'P0002'; end if;
  v_prev_flag := coalesce(current_setting('pm.schedule_writing', true), '');
  perform set_config('pm.schedule_writing', 'on', true);
  perform pm._schedule_lock(p_job);
  select sc.anchor_start, sc.status_date into v_anchor, v_dd from pm.schedules sc where sc.job_id = p_job;
  v_cal := pm.schedule_calendar(p_job);
  v_wd := coalesce((select wc.workdays from pm.work_calendars wc where wc.id = v_cal), '{1,2,3,4,5}'::smallint[]);

  -- the job's tasks
  with tk as (
    select tt.*, row_number() over (order by tt.sort, tt.title, tt.id)::int as rn
      from pm.tasks tt where tt.org_id = v_org and tt.job_id = p_job
  ), kc as (
    select ch.parent_task_id, count(*) as cnt from tk ch where ch.parent_task_id is not null and ch.status <> 'CANCELLED' group by 1
  )
  select array_agg(tk.id order by tk.rn), array_agg(tk.title order by tk.rn), array_agg(pp.rn order by tk.rn),
         array_agg(tk.status order by tk.rn),
         array_agg(case when tk.is_milestone then 0
                        when tk.duration_days is not null then greatest(0, tk.duration_days)
                        when tk.start_on is not null and tk.due_on is not null then least(3650, greatest(1, pm.cal_count(v_cal, tk.start_on, least(tk.due_on, tk.start_on + 5110))))
                        else 1 end order by tk.rn),
         array_agg(tk.duration_days order by tk.rn),
         array_agg(tk.start_on order by tk.rn), array_agg(tk.due_on order by tk.rn), array_agg(tk.pct_complete order by tk.rn),
         array_agg(tk.constraint_type order by tk.rn), array_agg(tk.constraint_date order by tk.rn),
         array_agg(tk.actual_start order by tk.rn), array_agg(tk.actual_finish order by tk.rn),
         array_agg(kc.cnt is not null order by tk.rn)
    into a_id, a_title, a_par, a_st, a_durin, a_durraw, a_son, a_don, a_pct, a_ct, a_cd, a_as, a_af, a_sum
    from tk left join tk pp on pp.id = tk.parent_task_id left join kc on kc.parent_task_id = tk.id;
  vn := coalesce(cardinality(a_id), 0);
  if vn > 10000 then
    raise exception 'PM_SCHEDULE_TOO_LARGE: a schedule holds at most 10,000 tasks (this job has %)', vn using errcode = '54000';
  end if;

  if vn = 0 then
    update pm.schedules sc set cpm_at = v_now, start_on = null, finish_on = null, critical_count = 0, task_count = 0, ignored_links = 0
     where sc.job_id = p_job;
    perform set_config('pm.schedule_writing', v_prev_flag, true);
    return jsonb_build_object('job_id', p_job, 'task_count', 0, 'critical_count', 0, 'finish_on', null, 'start_on', null, 'ignored_links', 0);
  end if;

  a_node := array_fill(false, array[vn]);
  for vi in 1..vn loop
    a_node[vi] := not a_sum[vi] and a_st[vi] <> 'CANCELLED';
    if a_node[vi] then v_nodes := v_nodes + 1; end if;
  end loop;

  -- links between network tasks, sorted by predecessor; links touching a phase or a cancelled task are ignored
  with ix as (select ux.id, ux.rn::int as rn, ux.nd from unnest(a_id, a_node) with ordinality as ux(id, nd, rn))
  select array_agg(ip.rn order by ip.rn, isx.rn) filter (where ip.nd and isx.nd),
         array_agg(isx.rn order by ip.rn, isx.rn) filter (where ip.nd and isx.nd),
         array_agg(case dd.dep_type when 'FS' then 1 when 'SS' then 2 when 'FF' then 3 else 4 end order by ip.rn, isx.rn) filter (where ip.nd and isx.nd),
         array_agg(dd.lag_days order by ip.rn, isx.rn) filter (where ip.nd and isx.nd),
         count(*) filter (where not (ip.nd and isx.nd))
    into e_from, e_to, e_typ, e_lag, v_ign
    from pm.task_deps dd join ix isx on isx.id = dd.succ_id join ix ip on ip.id = dd.pred_id
   where dd.org_id = v_org and dd.succ_id = any (a_id);
  vm := coalesce(cardinality(e_from), 0);

  a_os := array_fill(0, array[vn + 1]); a_deg := array_fill(0, array[vn]); a_topo := array_fill(0, array[vn]);
  a_hasp := array_fill(false, array[vn]);
  for ve in 1..vm loop
    a_os[e_from[ve] + 1] := a_os[e_from[ve] + 1] + 1;
    a_deg[e_to[ve]] := a_deg[e_to[ve]] + 1;
    a_hasp[e_to[ve]] := true;
  end loop;
  a_os[1] := 1;
  for vi in 1..vn loop a_os[vi + 1] := a_os[vi] + a_os[vi + 1]; end loop;

  -- topological order (Kahn); a shortfall is a loop
  for vi in 1..vn loop if a_deg[vi] = 0 then v_qt := v_qt + 1; a_topo[v_qt] := vi; end if; end loop;
  while v_qh <= v_qt loop
    vi := a_topo[v_qh]; v_qh := v_qh + 1;
    for ve in a_os[vi] .. a_os[vi + 1] - 1 loop
      vs := e_to[ve]; a_deg[vs] := a_deg[vs] - 1;
      if a_deg[vs] = 0 then v_qt := v_qt + 1; a_topo[v_qt] := vs; end if;
    end loop;
  end loop;
  if v_qt < vn then
    for ve in 1..vm loop
      if a_deg[e_from[ve]] > 0 and a_deg[e_to[ve]] > 0 then
        v_path := pm._dep_path(p_job, a_id[e_to[ve]], a_id[e_from[ve]]);
        if v_path is not null then
          select string_agg(tt.title, ' → ' order by ux.o) into v_names
            from unnest(array[a_id[e_from[ve]]] || v_path) with ordinality as ux(id, o) join pm.tasks tt on tt.id = ux.id;
          raise exception 'PM_DEP_CYCLE: %', v_names using errcode = '23514', hint = 'Remove one of these links.';
        end if;
      end if;
    end loop;
    raise exception 'PM_DEP_CYCLE: the links on this job loop back on themselves' using errcode = '23514';
  end if;

  -- project start (persisted on the first run)
  if v_anchor is null then
    v_anchor := coalesce(
      (select pj.planned_start from pm.projects pj where pj.org_id = v_org and pj.job_id = p_job),
      (select min(zz) from unnest(a_son || a_as || a_cd) as uz(zz)),
      current_date);
    update pm.schedules sc set anchor_start = v_anchor where sc.job_id = p_job;
  end if;

  -- working-day index over [v_b, v_e + 1] (every input date is inside)
  select least(min(uz.zz), v_anchor, v_dd), greatest(max(uz.zz), v_anchor, v_dd) into v_b, v_e
    from unnest(a_as || a_af || a_cd) as uz(zz);
  v_b := v_b - 1; v_e := v_e + 60;
  if v_e - v_b > 14700 then
    raise exception 'PM_SCHEDULE_RANGE: the schedule''s dates span more than 40 years (% to %); check the constraint, actual, start and status dates',
      v_b + 1, v_e - 60 using errcode = '22008';
  end if;
  select array_agg(cq.cnt order by cq.dy), array_agg(cq.dy order by cq.dy) filter (where cq.wk)
    into a_lt, w
    from (select gq.dy, gq.wk, (count(*) filter (where gq.wk) over (order by gq.dy rows between unbounded preceding and 1 preceding))::int as cnt
            from (select gs::date as dy, coalesce(xd.is_workday, extract(isodow from gs)::smallint = any (v_wd)) as wk
                    from generate_series(v_b::timestamp, (v_e + 1)::timestamp, interval '1 day') gs
                    left join pm.work_calendar_days xd on xd.calendar_id = v_cal and xd.day = gs::date) gq) cq;
  if w is null then
    w := pm.cal_workdays(v_cal, v_e + 2, v_e + 800);
    if cardinality(w) = 0 then raise exception 'PM_SCHEDULE_CALENDAR: the job calendar has no working days' using errcode = '22023'; end if;
  end if;
  v_p0 := a_lt[(v_anchor - v_b) + 1];
  if v_dd is not null then v_ddo := a_lt[(v_dd - v_b) + 1]; end if;

  -- forward pass
  a_d := a_durin;
  a_es := array_fill(0, array[vn]); a_ef := array_fill(0, array[vn]); a_cand := array_fill(null::int, array[vn]);
  a_conf := array_fill(false, array[vn]); a_pin := array_fill(false, array[vn]);
  for vk in 1..vn loop
    vi := a_topo[vk];
    continue when not a_node[vi];
    v_dur := a_d[vi];
    if v_dur = 0 and (a_af[vi] is not null or a_as[vi] is not null) then
      vbd := case when a_hasp[vi] then a_lt[(coalesce(a_af[vi], a_as[vi]) - v_b) + 2] else a_lt[(coalesce(a_af[vi], a_as[vi]) - v_b) + 1] end;
      a_es[vi] := vbd; a_ef[vi] := vbd; a_pin[vi] := true;
    elsif a_as[vi] is not null or a_af[vi] is not null then
      if a_as[vi] is not null then
        a_es[vi] := a_lt[(a_as[vi] - v_b) + 1];
        if a_af[vi] is not null then
          a_ef[vi] := greatest(a_lt[(a_af[vi] - v_b) + 2], a_es[vi] + 1);
        else
          a_ef[vi] := a_es[vi] + v_dur;
          if v_ddo is not null then
            a_ef[vi] := greatest(a_ef[vi], v_ddo + greatest(1, ceil(round(v_dur * (1 - coalesce(a_pct[vi], 0)), 9))::int));
          end if;
        end if;
      else
        a_ef[vi] := a_lt[(a_af[vi] - v_b) + 2];
        a_es[vi] := a_ef[vi] - v_dur;
      end if;
      a_pin[vi] := a_af[vi] is not null;
    else
      vv := greatest(v_p0, a_cand[vi]);
      if v_ddo is not null then vv := greatest(vv, v_ddo); end if;
      if a_ct[vi] in ('SNET', 'MSO') then
        vx := case when v_dur = 0 and a_hasp[vi] then a_lt[(a_cd[vi] - v_b) + 2] else a_lt[(a_cd[vi] - v_b) + 1] end;
        if a_ct[vi] = 'SNET' then
          vv := greatest(vv, vx);
        else
          if a_cand[vi] is not null and a_cand[vi] > vx then a_conf[vi] := true; end if;
          vv := vx;
        end if;
      end if;
      a_es[vi] := vv; a_ef[vi] := vv + v_dur;
    end if;
    for ve in a_os[vi] .. a_os[vi + 1] - 1 loop
      vs := e_to[ve];
      vv := case e_typ[ve] when 1 then a_ef[vi] + e_lag[ve]
                           when 2 then a_es[vi] + e_lag[ve]
                           when 3 then a_ef[vi] + e_lag[ve] - a_d[vs]
                           else a_es[vi] + e_lag[ve] - a_d[vs] end;
      if a_cand[vs] is null or vv > a_cand[vs] then a_cand[vs] := vv; end if;
    end loop;
  end loop;

  -- project finish boundary
  v_pf := null;
  for vi in 1..vn loop if a_node[vi] and (v_pf is null or a_ef[vi] > v_pf) then v_pf := a_ef[vi]; end if; end loop;
  v_pf := coalesce(v_pf, v_p0);

  -- backward pass
  a_ls := array_fill(0, array[vn]); a_lf := array_fill(0, array[vn]); a_tf := array_fill(0, array[vn]); a_ff := array_fill(0, array[vn]);
  for vk in reverse vn..1 loop
    vi := a_topo[vk];
    continue when not a_node[vi];
    v_dur := a_d[vi];
    vl := v_pf; vf := null;
    for ve in a_os[vi] .. a_os[vi + 1] - 1 loop
      vs := e_to[ve];
      vv := case e_typ[ve] when 1 then a_ls[vs] - e_lag[ve]
                           when 2 then a_ls[vs] - e_lag[ve] + v_dur
                           when 3 then a_lf[vs] - e_lag[ve]
                           else a_lf[vs] - e_lag[ve] + v_dur end;
      if vv < vl then vl := vv; end if;
      vv := case e_typ[ve] when 1 then a_es[vs] - e_lag[ve] - a_ef[vi]
                           when 2 then a_es[vs] - e_lag[ve] - a_es[vi]
                           when 3 then a_ef[vs] - e_lag[ve] - a_ef[vi]
                           else a_ef[vs] - e_lag[ve] - a_es[vi] end;
      if vf is null or vv < vf then vf := vv; end if;
    end loop;
    if vf is null then vf := v_pf - a_ef[vi]; end if;
    if a_ct[vi] = 'FNLT' then
      vx := case when v_dur = 0 and not a_hasp[vi] then a_lt[(a_cd[vi] - v_b) + 2] - 1 else a_lt[(a_cd[vi] - v_b) + 2] end;
      if vx < vl then vl := vx; end if;
      if a_ef[vi] > vx then a_conf[vi] := true; end if;
    end if;
    if a_ct[vi] = 'MSO' and a_as[vi] is null and a_af[vi] is null and a_ef[vi] < vl then vl := a_ef[vi]; end if;
    if a_pin[vi] then vl := a_ef[vi]; end if;
    a_lf[vi] := vl; a_ls[vi] := vl - v_dur; a_tf[vi] := vl - a_ef[vi]; a_ff[vi] := least(vf, a_tf[vi]);
  end loop;

  -- extend the working-day list to every ordinal the outputs need (at most ~40 years of working days)
  v_omin := v_p0; v_omax := v_p0;
  for vi in 1..vn loop
    continue when not a_node[vi];
    v_omin := least(v_omin, a_es[vi] - 1, a_ls[vi] - 1, a_ef[vi] - 1, a_lf[vi] - 1);
    v_omax := greatest(v_omax, a_ef[vi], a_lf[vi], a_es[vi], a_ls[vi]);
  end loop;
  if v_omax - v_omin > 10440 then
    raise exception 'PM_SCHEDULE_RANGE: the schedule would run more than 40 years of working days; check durations, lags and constraints'
      using errcode = '22008';
  end if;
  while v_omin + v_woff < 1 loop
    v_tmp := pm.cal_workdays(v_cal, w[1] - 400 - 2 * (1 - (v_omin + v_woff)), w[1] - 1);
    if cardinality(v_tmp) = 0 then raise exception 'PM_SCHEDULE_CALENDAR: the job calendar has no working days' using errcode = '22023'; end if;
    w := v_tmp || w; v_woff := v_woff + cardinality(v_tmp);
    if w[1] < date '1900-01-01' then
      raise exception 'PM_SCHEDULE_RANGE: the schedule would start before 1900' using errcode = '22008';
    end if;
  end loop;
  while v_omax + v_woff > cardinality(w) loop
    v_cnt := cardinality(w);
    v_tmp := pm.cal_workdays(v_cal, w[v_cnt] + 1, w[v_cnt] + 400 + 2 * (v_omax + v_woff - v_cnt));
    if cardinality(v_tmp) = 0 then raise exception 'PM_SCHEDULE_CALENDAR: the job calendar has no working days' using errcode = '22023'; end if;
    w := w || v_tmp;
    if w[v_cnt + 1] > date '2200-12-31' then
      raise exception 'PM_SCHEDULE_RANGE: the schedule would finish after 2200' using errcode = '22008';
    end if;
  end loop;

  -- outputs: network tasks (other rows keep their dates; their engine fields clear)
  o_s := a_son; o_d := a_don; o_dur := a_durraw; o_st := a_st; o_pct := a_pct; o_as := a_as; o_af := a_af;
  o_es := array_fill(null::date, array[vn]); o_ef := o_es; o_ls := o_es; o_lf := o_es;
  o_tf := array_fill(null::int, array[vn]); o_ff := o_tf; o_so := o_tf; o_fo := o_tf;
  o_crit := array_fill(false, array[vn]); o_conf := o_crit; o_has := o_crit;
  for vi in 1..vn loop
    continue when not a_node[vi];
    v_dur := a_d[vi];
    if v_dur = 0 then
      vbd := case when a_hasp[vi] then greatest(a_es[vi] - 1, v_p0) else a_es[vi] end;
      vx := case when a_hasp[vi] then greatest(a_ls[vi] - 1, v_p0) else a_ls[vi] end;
      o_es[vi] := w[vbd + v_woff]; o_ef[vi] := o_es[vi]; o_ls[vi] := w[vx + v_woff]; o_lf[vi] := o_ls[vi];
      if a_af[vi] is not null or a_as[vi] is not null then
        o_s[vi] := coalesce(a_af[vi], a_as[vi]); o_d[vi] := o_s[vi];
        o_so[vi] := a_lt[(o_s[vi] - v_b) + 1]; o_fo[vi] := a_lt[(o_s[vi] - v_b) + 2];
      else
        o_s[vi] := o_es[vi]; o_d[vi] := o_es[vi]; o_so[vi] := vbd; o_fo[vi] := vbd + 1;
      end if;
    else
      o_es[vi] := w[a_es[vi] + v_woff]; o_ef[vi] := w[a_ef[vi] - 1 + v_woff];
      o_ls[vi] := w[a_ls[vi] + v_woff]; o_lf[vi] := w[a_lf[vi] - 1 + v_woff];
      o_s[vi] := coalesce(a_as[vi], o_es[vi]);
      o_so[vi] := case when a_as[vi] is not null then a_lt[(a_as[vi] - v_b) + 1] else a_es[vi] end;
      o_d[vi] := coalesce(a_af[vi], o_ef[vi]);
      o_fo[vi] := case when a_af[vi] is not null then a_lt[(a_af[vi] - v_b) + 2] else a_ef[vi] end;
    end if;
    o_dur[vi] := v_dur;
    o_tf[vi] := a_tf[vi]; o_ff[vi] := a_ff[vi]; o_conf[vi] := a_conf[vi];
    o_crit[vi] := a_tf[vi] <= 0 and not (a_pin[vi] or a_st[vi] = 'DONE');
    o_has[vi] := true;
    if o_crit[vi] then v_crit := v_crit + 1; end if;
    if v_finish is null or o_d[vi] > v_finish then v_finish := o_d[vi]; end if;
  end loop;

  -- phases roll up from their children, deepest first
  a_depth := array_fill(0, array[vn]);
  for vi in 1..vn loop
    v_lvl := 0; vj := a_par[vi];
    while vj is not null and v_lvl < 200 loop v_lvl := v_lvl + 1; vj := a_par[vj]; end loop;
    a_depth[vi] := v_lvl; v_maxd := greatest(v_maxd, v_lvl);
  end loop;
  if v_maxd >= 200 then
    -- a parent loop in the outline (bad data): refuse instead of rolling up forever
    select string_agg(x.t, ' ⇄ ' order by x.o) into v_names
      from (select a_title[q.i] as t, q.i as o from generate_subscripts(a_depth, 1) as q(i) where a_depth[q.i] >= 200 limit 6) x;
    raise exception 'PM_SCHEDULE_OUTLINE_LOOP: these tasks sit under each other: %. Move one of them out.', v_names using errcode = '22023';
  end if;
  g_s := array_fill(null::date, array[vn]); g_d := g_s; g_es := g_s; g_ef := g_s; g_ls := g_s; g_lf := g_s; g_as := g_s; g_af := g_s;
  g_tf := array_fill(null::int, array[vn]); g_ff := g_tf; g_so := g_tf; g_fo := g_tf; g_c := array_fill(0, array[vn]);
  g_crit := array_fill(false, array[vn]); g_conf := g_crit; g_started := g_crit;
  g_alldone := array_fill(true, array[vn]); g_allaf := g_alldone;
  g_w := array_fill(0::numeric, array[vn]); g_wp := g_w; g_p := g_w;
  for v_lvl in reverse v_maxd..0 loop
    -- finalize the phases at this depth (their children, one level deeper, are aggregated)
    for vi in 1..vn loop
      continue when a_depth[vi] <> v_lvl or not a_sum[vi] or g_c[vi] = 0;
      o_s[vi] := g_s[vi]; o_d[vi] := g_d[vi]; o_es[vi] := g_es[vi]; o_ef[vi] := g_ef[vi]; o_ls[vi] := g_ls[vi]; o_lf[vi] := g_lf[vi];
      o_tf[vi] := g_tf[vi]; o_ff[vi] := g_ff[vi]; o_crit[vi] := g_crit[vi]; o_conf[vi] := g_conf[vi];
      o_so[vi] := g_so[vi]; o_fo[vi] := g_fo[vi];
      o_dur[vi] := case when g_so[vi] is not null and g_fo[vi] is not null then g_fo[vi] - g_so[vi] end;
      o_pct[vi] := round(case when g_w[vi] > 0 then g_wp[vi] / g_w[vi] else g_p[vi] / g_c[vi] end, 4);
      o_st[vi] := case when a_st[vi] = 'CANCELLED' then 'CANCELLED' when g_alldone[vi] then 'DONE'
                       when g_started[vi] then 'IN_PROGRESS' else 'TODO' end;
      o_as[vi] := g_as[vi]; o_af[vi] := case when g_allaf[vi] then g_af[vi] end;
      o_has[vi] := true;
    end loop;
    -- aggregate this depth into the parents
    for vi in 1..vn loop
      continue when a_depth[vi] <> v_lvl or a_par[vi] is null or a_st[vi] = 'CANCELLED' or not o_has[vi];
      vj := a_par[vi];
      if a_sum[vi] then c_pct := coalesce(o_pct[vi], 0); c_st := o_st[vi]; c_as := o_as[vi]; c_af := o_af[vi];
      else c_pct := coalesce(a_pct[vi], 0); c_st := a_st[vi]; c_as := a_as[vi]; c_af := a_af[vi]; end if;
      c_w := greatest(coalesce(o_dur[vi], 0), 0);
      g_c[vj] := g_c[vj] + 1;
      if o_s[vi] is not null and (g_s[vj] is null or o_s[vi] < g_s[vj]) then g_s[vj] := o_s[vi]; g_so[vj] := o_so[vi]; end if;
      if o_d[vi] is not null and (g_d[vj] is null or o_d[vi] > g_d[vj]) then g_d[vj] := o_d[vi]; g_fo[vj] := o_fo[vi]; end if;
      if o_es[vi] is not null and (g_es[vj] is null or o_es[vi] < g_es[vj]) then g_es[vj] := o_es[vi]; end if;
      if o_ef[vi] is not null and (g_ef[vj] is null or o_ef[vi] > g_ef[vj]) then g_ef[vj] := o_ef[vi]; end if;
      if o_ls[vi] is not null and (g_ls[vj] is null or o_ls[vi] < g_ls[vj]) then g_ls[vj] := o_ls[vi]; end if;
      if o_lf[vi] is not null and (g_lf[vj] is null or o_lf[vi] > g_lf[vj]) then g_lf[vj] := o_lf[vi]; end if;
      if o_tf[vi] is not null and (g_tf[vj] is null or o_tf[vi] < g_tf[vj]) then g_tf[vj] := o_tf[vi]; end if;
      if o_ff[vi] is not null and (g_ff[vj] is null or o_ff[vi] < g_ff[vj]) then g_ff[vj] := o_ff[vi]; end if;
      g_crit[vj] := g_crit[vj] or o_crit[vi];
      g_conf[vj] := g_conf[vj] or o_conf[vi];
      g_w[vj] := g_w[vj] + c_w; g_wp[vj] := g_wp[vj] + c_pct * c_w; g_p[vj] := g_p[vj] + c_pct;
      g_alldone[vj] := g_alldone[vj] and c_st = 'DONE';
      g_started[vj] := g_started[vj] or c_st in ('IN_PROGRESS', 'DONE') or c_as is not null;
      if c_as is not null and (g_as[vj] is null or c_as < g_as[vj]) then g_as[vj] := c_as; end if;
      g_allaf[vj] := g_allaf[vj] and c_af is not null;
      if c_af is not null and (g_af[vj] is null or c_af > g_af[vj]) then g_af[vj] := c_af; end if;
    end loop;
  end loop;

  -- write only the rows that differ; the outline number comes from parent + sort
  with recursive ox as (
    select * from unnest(a_id, o_s, o_d, o_dur, o_es, o_ef, o_ls, o_lf, o_tf, o_ff, o_crit, o_conf, a_sum, o_st, o_pct, o_as, o_af)
      as ux(id, n_s, n_d, n_dur, n_es, n_ef, n_ls, n_lf, n_tf, n_ff, n_crit, n_conf, n_summ, n_st, n_pct, n_as, n_af)
  ), ranked as (
    select tt.id, tt.parent_task_id, row_number() over (partition by tt.parent_task_id order by tt.sort, tt.title, tt.id) as rk
      from pm.tasks tt where tt.org_id = v_org and tt.job_id = p_job
  ), tree as (
    select rr.id, rr.rk::text as code from ranked rr where rr.parent_task_id is null
    union all
    select rr.id, tr.code || '.' || rr.rk from ranked rr join tree tr on rr.parent_task_id = tr.id
  ), nv as (
    select ox.*, tree.code as n_code from ox left join tree on tree.id = ox.id
  )
  update pm.tasks tt set
    start_on = nv.n_s, due_on = nv.n_d, duration_days = nv.n_dur,
    early_start = nv.n_es, early_finish = nv.n_ef, late_start = nv.n_ls, late_finish = nv.n_lf,
    total_float = nv.n_tf, free_float = nv.n_ff, is_critical = nv.n_crit, constraint_conflict = nv.n_conf, is_summary = nv.n_summ,
    status = nv.n_st, pct_complete = nv.n_pct, actual_start = nv.n_as, actual_finish = nv.n_af, wbs_code = nv.n_code, cpm_at = v_now
  from nv
  where tt.id = nv.id and tt.org_id = v_org
    and (tt.start_on, tt.due_on, tt.duration_days, tt.early_start, tt.early_finish, tt.late_start, tt.late_finish, tt.total_float,
         tt.free_float, tt.is_critical, tt.constraint_conflict, tt.is_summary, tt.status, tt.pct_complete, tt.actual_start,
         tt.actual_finish, tt.wbs_code)
        is distinct from
        (nv.n_s, nv.n_d, nv.n_dur, nv.n_es, nv.n_ef, nv.n_ls, nv.n_lf, nv.n_tf, nv.n_ff, nv.n_crit, nv.n_conf, nv.n_summ, nv.n_st,
         nv.n_pct::numeric(5,4), nv.n_as, nv.n_af, nv.n_code);

  update pm.schedules sc set cpm_at = v_now, start_on = w[v_p0 + v_woff], finish_on = v_finish, critical_count = v_crit,
         task_count = v_nodes, ignored_links = coalesce(v_ign, 0)
   where sc.job_id = p_job;
  perform set_config('pm.schedule_writing', v_prev_flag, true);
  return jsonb_build_object('job_id', p_job, 'start_on', w[v_p0 + v_woff], 'finish_on', v_finish, 'critical_count', v_crit,
                            'task_count', v_nodes, 'ignored_links', coalesce(v_ign, 0));
end $$;
-- The schedule-relevant state of every task of a job (for diffs).
create or replace function pm._schedule_snapshot(p_job uuid) returns jsonb
language sql stable security definer
set search_path = pm, core, public
as $$
  select coalesce(jsonb_object_agg(t.id::text, jsonb_build_object(
           'start_on', t.start_on, 'due_on', t.due_on, 'early_start', t.early_start, 'early_finish', t.early_finish,
           'late_start', t.late_start, 'late_finish', t.late_finish, 'total_float', t.total_float, 'free_float', t.free_float,
           'is_critical', t.is_critical, 'duration_days', t.duration_days, 'is_summary', t.is_summary, 'status', t.status)), '{}'::jsonb)
    from pm.tasks t where t.job_id = p_job
$$;

-- Project finish as the tasks stand: latest finish of a non-cancelled task without live children.
create or replace function pm._schedule_finish(p_job uuid) returns date
language sql stable security definer
set search_path = pm, core, public
as $$
  select max(t.due_on) from pm.tasks t
   where t.job_id = p_job and t.status <> 'CANCELLED'
     and not exists (select 1 from pm.tasks c where c.org_id = t.org_id and c.parent_task_id = t.id and c.status <> 'CANCELLED')
$$;

-- The reschedule result shape for a job against a snapshot taken before the change.
create or replace function pm._schedule_diff(p_job uuid, p_before jsonb, p_finish_before date) returns jsonb
language plpgsql stable security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare v_changed jsonb; v_moved int; v_after date; v_crit int; v_cal uuid := pm.schedule_calendar(p_job);
begin
  with cur as (
    select t.id, t.sort, t.title, t.is_summary, t.status, jsonb_build_object(
             'start_on', t.start_on, 'due_on', t.due_on, 'early_start', t.early_start, 'early_finish', t.early_finish,
             'late_start', t.late_start, 'late_finish', t.late_finish, 'total_float', t.total_float, 'free_float', t.free_float,
             'is_critical', t.is_critical, 'duration_days', t.duration_days, 'is_summary', t.is_summary, 'status', t.status) as j
      from pm.tasks t where t.job_id = p_job
  ), ch as (
    select c.*, p_before -> c.id::text as b from cur c where (p_before -> c.id::text) is distinct from c.j
  )
  select coalesce(jsonb_agg(ch.j || jsonb_build_object('id', ch.id, 'title', ch.title) order by ch.sort, ch.title, ch.id), '[]'::jsonb),
         count(*) filter (where not ch.is_summary and ch.status <> 'CANCELLED'
                            and (ch.b is null or (ch.b ->> 'start_on') is distinct from (ch.j ->> 'start_on')
                                 or (ch.b ->> 'due_on') is distinct from (ch.j ->> 'due_on')))::int
    into v_changed, v_moved
    from ch;
  select sc.finish_on, sc.critical_count into v_after, v_crit from pm.schedules sc where sc.job_id = p_job;
  return jsonb_build_object('changed', v_changed, 'finish_before', p_finish_before, 'finish_after', v_after,
                            'finish_delta_days', pm.cal_workdays_between(v_cal, p_finish_before, v_after),
                            'moved_count', coalesce(v_moved, 0), 'critical_count', coalesce(v_crit, 0));
end $$;

-- Renumber sort to the outline (preorder) order; p_moved breaks a sort tie by going after the other row.
create or replace function pm._schedule_renumber(p_job uuid, p_moved uuid) returns void
language sql security definer
set search_path = pm, core, public
as $$
  with recursive ranked as (
    select t.id, t.parent_task_id,
           row_number() over (partition by t.parent_task_id order by t.sort, (t.id = p_moved) nulls first, t.title, t.id) as rk
      from pm.tasks t where t.job_id = p_job
  ), tree as (
    select r.id, array[r.rk] as path from ranked r where r.parent_task_id is null
    union all
    select r.id, tr.path || r.rk from ranked r join tree tr on r.parent_task_id = tr.id
  ), num as (
    select tree.id, (row_number() over (order by tree.path) - 1)::int as n from tree
  )
  update pm.tasks t set sort = num.n from num where t.id = num.id and t.sort is distinct from num.n
$$;

-- Apply a move / resize to a task (no CPM). Raises for what cannot move.
create or replace function pm._reschedule_apply(p_task uuid, p_new_start date, p_new_duration int) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare r pm.tasks; v_cal uuid; v_delta int; v_is_sum boolean; v_from date;
begin
  select * into r from pm.tasks t where t.id = p_task and (public.get_org_id() is null or t.org_id = public.get_org_id());
  if r.id is null then raise exception 'PM_NOT_FOUND: task % not found', p_task using errcode = 'P0002'; end if;
  if p_new_duration is not null and (p_new_duration < 0 or p_new_duration > 3650) then
    raise exception 'PM_INVALID: a duration is 0 to 3650 working days (got %)', p_new_duration using errcode = '22023';
  end if;
  v_is_sum := exists (select 1 from pm.tasks c where c.org_id = r.org_id and c.parent_task_id = r.id and c.status <> 'CANCELLED');
  if v_is_sum then
    if p_new_duration is not null then
      raise exception 'PM_INVALID: "%" is a phase; its length comes from its tasks. Change the tasks inside it.', r.title using errcode = '22023';
    end if;
    if p_new_start is null or r.start_on is null or p_new_start = r.start_on then return r.job_id; end if;
    v_cal := pm.schedule_calendar(r.job_id);
    v_from := pm.cal_add_workdays(v_cal, r.start_on, 0);
    v_delta := pm.cal_workdays_between(v_cal, v_from, pm.cal_add_workdays(v_cal, p_new_start, 0));
    if v_delta = 0 then return r.job_id; end if;
    -- shift every unstarted task under the phase by the same working days
    with recursive sub as (
      select t.id from pm.tasks t where t.org_id = r.org_id and t.parent_task_id = r.id
      union
      select t.id from pm.tasks t join sub on t.parent_task_id = sub.id where t.org_id = r.org_id
    )
    update pm.tasks t
       set constraint_type = case when t.constraint_type = 'MSO' then 'MSO' else 'SNET' end,
           constraint_date = pm.cal_add_workdays(v_cal, pm.cal_add_workdays(v_cal, t.start_on, 0), v_delta)
     where t.id in (select sub.id from sub) and t.org_id = r.org_id
       and t.status not in ('DONE', 'CANCELLED') and t.actual_start is null and t.start_on is not null
       and not exists (select 1 from pm.tasks c where c.org_id = t.org_id and c.parent_task_id = t.id and c.status <> 'CANCELLED');
    return r.job_id;
  end if;
  if p_new_duration is not null and not r.is_milestone then
    update pm.tasks t set duration_days = greatest(1, p_new_duration) where t.id = r.id;
  end if;
  if p_new_start is not null and p_new_start is distinct from r.start_on then
    if r.actual_start is not null or r.actual_finish is not null or r.status = 'DONE' then
      raise exception 'PM_SCHEDULE_STARTED: "%" has started. Change its actual start instead of moving it.', r.title using errcode = '22023';
    end if;
    update pm.tasks t set constraint_type = case when r.constraint_type = 'MSO' then 'MSO' else 'SNET' end,
                          constraint_date = p_new_start
     where t.id = r.id;
  end if;
  return r.job_id;
end $$;

create or replace function pm._reschedule(p_task uuid, p_new_start date, p_new_duration int) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_job uuid; v_before jsonb; v_fin date;
begin
  select t.job_id into v_job from pm.tasks t where t.id = p_task and (public.get_org_id() is null or t.org_id = public.get_org_id());
  if v_job is null then raise exception 'PM_NOT_FOUND: task % not found', p_task using errcode = 'P0002'; end if;
  perform pm._schedule_lock(v_job);
  v_before := pm._schedule_snapshot(v_job);
  v_fin := pm._schedule_finish(v_job);
  perform pm._reschedule_apply(p_task, p_new_start, p_new_duration);
  perform pm._schedule_run(v_job);
  return pm._schedule_diff(v_job, v_before, v_fin);
end $$;

-- ----------------------------------------------------------------------------
-- 7. Member RPCs (guards injected from pm.access_rpc_guards — section 13)
-- ----------------------------------------------------------------------------
create or replace function pm.schedule_cpm(p_job uuid) returns setof pm.tasks
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r pm.tasks; v_money boolean;
begin
  perform pm._schedule_run(p_job);
  v_money := pm.access_is_service() or exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = p_job);
  for r in select * from pm.tasks t where t.job_id = p_job order by t.sort, t.title, t.id loop
    if not v_money then r.billing_amount_cents := null; end if;
    return next r;
  end loop;
  return;
end $$;
comment on function pm.schedule_cpm(uuid) is
  '1112 / spec §2: run CPM on the job (forward / backward pass, FS/SS/FF/SF + lag, constraints, actuals, working calendar, phase roll-up), write it, return the tasks (billing amount masked as in pm.v_tasks_masked).';

create or replace function pm.reschedule_task(p_task uuid, p_new_start date, p_new_duration int) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  return pm._reschedule(p_task, p_new_start, p_new_duration);
end $$;
comment on function pm.reschedule_task(uuid, date, int) is
  '1112 / spec §2: move (start → SNET) and / or resize a task, re-run CPM, return {changed, finish_before, finish_after, finish_delta_days, moved_count, critical_count}.';

create or replace function pm.preview_reschedule(p_task uuid, p_new_start date, p_new_duration int) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_result jsonb;
begin
  -- computed for real, then rolled back: nothing (rows, header, timestamps) survives
  declare v_dummy int;
  begin
    v_result := pm._reschedule(p_task, p_new_start, p_new_duration);
    raise exception using errcode = 'PMPRV', message = 'PM_PREVIEW_ROLLBACK';
  exception when sqlstate 'PMPRV' then
    v_dummy := 0;
  end;
  return v_result || jsonb_build_object('preview', true);
end $$;
comment on function pm.preview_reschedule(uuid, date, int) is
  '1112 / spec §2: what pm.reschedule_task would return, without writing anything (ghost bars).';

create or replace function pm.set_task_links(p_task uuid, p_links jsonb) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare r pm.tasks; v_before jsonb; v_fin date; v_bad text; v_links jsonb := coalesce(p_links, '[]'::jsonb);
begin
  select * into r from pm.tasks t where t.id = p_task and (public.get_org_id() is null or t.org_id = public.get_org_id());
  if r.id is null then raise exception 'PM_NOT_FOUND: task % not found', p_task using errcode = 'P0002'; end if;
  if jsonb_typeof(v_links) <> 'array' then
    raise exception 'PM_INVALID: links must be a list of {pred_id, dep_type, lag_days}' using errcode = '22023';
  end if;
  select string_agg(coalesce(x ->> 'pred_id', '?'), ', ') into v_bad
    from jsonb_array_elements(v_links) x
   where jsonb_typeof(x) <> 'object' or pm.access_try_uuid(x ->> 'pred_id') is null
      or upper(coalesce(x ->> 'dep_type', 'FS')) not in ('FS', 'SS', 'FF', 'SF')
      or (x ? 'lag_days' and case jsonb_typeof(x -> 'lag_days') when 'null' then false
                                  when 'number' then (x ->> 'lag_days')::numeric % 1 <> 0 else true end);
  if v_bad is not null then
    raise exception 'PM_INVALID: each link needs a pred_id (uuid), dep_type FS / SS / FF / SF and a whole-day lag_days (bad: %)', v_bad using errcode = '22023';
  end if;
  select string_agg(p.title, ', ') into v_bad
    from (select (x ->> 'pred_id')::uuid as pred from jsonb_array_elements(v_links) x group by 1 having count(*) > 1) d
    join pm.tasks p on p.id = d.pred;
  if v_bad is not null then
    raise exception 'PM_INVALID: "%" is listed twice. Keep one link to it.', v_bad using errcode = '22023';
  end if;
  select string_agg(coalesce(p.title, d.pred::text), ', ') into v_bad
    from (select (x ->> 'pred_id')::uuid as pred from jsonb_array_elements(v_links) x) d
    left join pm.tasks p on p.id = d.pred and p.org_id = r.org_id and p.job_id = r.job_id
   where p.id is null;
  if v_bad is not null then
    raise exception 'PM_DEP_CROSS_JOB: % is not a task on this job', v_bad using errcode = '23514';
  end if;

  perform pm._schedule_lock(r.job_id);
  v_before := pm._schedule_snapshot(r.job_id);
  v_fin := pm._schedule_finish(r.job_id);
  delete from pm.task_deps d
   where d.org_id = r.org_id and d.succ_id = r.id
     and d.pred_id not in (select (x ->> 'pred_id')::uuid from jsonb_array_elements(v_links) x);
  insert into pm.task_deps as d (org_id, pred_id, succ_id, dep_type, lag_days)
  select r.org_id, (x ->> 'pred_id')::uuid, r.id, upper(coalesce(x ->> 'dep_type', 'FS')), coalesce((x ->> 'lag_days')::numeric::int, 0)
    from jsonb_array_elements(v_links) x
  on conflict (pred_id, succ_id) do update set dep_type = excluded.dep_type, lag_days = excluded.lag_days
   where (d.dep_type, d.lag_days) is distinct from (excluded.dep_type, excluded.lag_days);
  perform pm._schedule_run(r.job_id);
  return pm._schedule_diff(r.job_id, v_before, v_fin);
end $$;
comment on function pm.set_task_links(uuid, jsonb) is
  '1112 / spec §2: replace a task''s predecessors with the parsed list [{pred_id, dep_type, lag_days}], re-run CPM, return the reschedule shape.';

create or replace function pm.indent_task(p_task uuid, p_direction text) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare r pm.tasks; v_prev uuid; v_par pm.tasks; v_before jsonb; v_fin date;
begin
  if p_direction is null or p_direction not in ('in', 'out') then
    raise exception 'PM_INVALID: direction is ''in'' or ''out''' using errcode = '22023';
  end if;
  select * into r from pm.tasks t where t.id = p_task and (public.get_org_id() is null or t.org_id = public.get_org_id());
  if r.id is null then raise exception 'PM_NOT_FOUND: task % not found', p_task using errcode = 'P0002'; end if;
  perform pm._schedule_lock(r.job_id);
  v_before := pm._schedule_snapshot(r.job_id);
  v_fin := pm._schedule_finish(r.job_id);
  perform pm._schedule_renumber(r.job_id, null);
  select * into r from pm.tasks t where t.id = p_task;
  if p_direction = 'in' then
    select t.id into v_prev from pm.tasks t
     where t.org_id = r.org_id and t.job_id = r.job_id and t.parent_task_id is not distinct from r.parent_task_id
       and (t.sort, t.title, t.id) < (r.sort, r.title, r.id)
     order by t.sort desc, t.title desc, t.id desc limit 1;
    if v_prev is null then
      raise exception 'PM_SCHEDULE_INDENT: there is no task above "%" at its level to put it under', r.title using errcode = '22023';
    end if;
    update pm.tasks t set parent_task_id = v_prev where t.id = r.id;
    perform pm._schedule_renumber(r.job_id, null);
  else
    if r.parent_task_id is null then
      raise exception 'PM_SCHEDULE_INDENT: "%" is already at the top level', r.title using errcode = '22023';
    end if;
    select * into v_par from pm.tasks t where t.id = r.parent_task_id;
    update pm.tasks t set parent_task_id = v_par.parent_task_id, sort = v_par.sort where t.id = r.id;
    perform pm._schedule_renumber(r.job_id, r.id);
  end if;
  perform pm._schedule_run(r.job_id);
  return pm._schedule_diff(r.job_id, v_before, v_fin);
end $$;
comment on function pm.indent_task(uuid, text) is
  '1112 / spec §2: Tab (in: last child of the previous sibling, which becomes a phase) / Shift-Tab (out: sibling of its parent, right after the parent''s branch); re-runs CPM.';

create or replace function pm.move_task_order(p_task uuid, p_after_task uuid) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare r pm.tasks; a pm.tasks; v_before jsonb; v_fin date;
begin
  select * into r from pm.tasks t where t.id = p_task and (public.get_org_id() is null or t.org_id = public.get_org_id());
  if r.id is null then raise exception 'PM_NOT_FOUND: task % not found', p_task using errcode = 'P0002'; end if;
  perform pm._schedule_lock(r.job_id);
  v_before := pm._schedule_snapshot(r.job_id);
  v_fin := pm._schedule_finish(r.job_id);
  perform pm._schedule_renumber(r.job_id, null);
  if p_after_task is null then
    update pm.tasks t set sort = -1 where t.id = r.id;
  elsif p_after_task <> r.id then
    select * into a from pm.tasks t where t.id = p_after_task and t.org_id = r.org_id and t.job_id = r.job_id;
    if a.id is null then raise exception 'PM_INVALID: the row to move after is not on this job' using errcode = '22023'; end if;
    if exists (with recursive up(id, parent_id) as (
                 select t.id, t.parent_task_id from pm.tasks t where t.id = a.id
                 union
                 select t.id, t.parent_task_id from pm.tasks t join up on t.id = up.parent_id)
               select 1 from up where up.id = r.id) then
      raise exception 'PM_INVALID: "%" cannot move under one of its own tasks', r.title using errcode = '22023';
    end if;
    if a.id = r.parent_task_id then
      update pm.tasks t set sort = -1 where t.id = r.id;
    else
      update pm.tasks t set parent_task_id = a.parent_task_id, sort = a.sort where t.id = r.id;
    end if;
  end if;
  perform pm._schedule_renumber(r.job_id, r.id);
  perform pm._schedule_run(r.job_id);
  return pm._schedule_diff(r.job_id, v_before, v_fin);
end $$;
comment on function pm.move_task_order(uuid, uuid) is
  '1112 / spec §2: move a task (with its branch) right after another row (its sibling then), to be first under its parent (after = the parent), or first among its siblings (after = null); re-runs CPM.';

-- ----------------------------------------------------------------------------
-- 8. Baselines + variance
-- ----------------------------------------------------------------------------
create table if not exists pm.schedule_baselines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  job_id          uuid not null,
  number          int not null check (number >= 1),
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  is_active       boolean not null default true,
  project_start   date,
  project_finish  date,
  task_count      int not null default 0,
  created_by      text default pm.current_user_id(),
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, job_id, number),
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create unique index if not exists pm_schedule_baselines_active_uidx on pm.schedule_baselines (org_id, job_id) where is_active;

create table if not exists pm.schedule_baseline_tasks (
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  baseline_id    uuid not null,
  job_id         uuid not null,
  task_id        uuid not null,           -- no FK: a deleted task stays in the baseline
  title          text not null,
  wbs_code       text,
  sort           int not null default 0,
  is_summary     boolean not null default false,
  is_milestone   boolean not null default false,
  start_on       date,
  due_on         date,
  duration_days  int,
  primary key (baseline_id, task_id),
  foreign key (org_id, baseline_id) references pm.schedule_baselines (org_id, id) on delete cascade deferrable initially immediate,
  foreign key (org_id, job_id) references core.jobs (org_id, id) deferrable initially immediate
);
create index if not exists pm_schedule_baseline_tasks_job_idx on pm.schedule_baseline_tasks (org_id, job_id);

create or replace function pm.set_schedule_baseline(p_job uuid, p_name text) returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare v_org uuid; v_id uuid; v_no int; v_name text;
begin
  v_org := pm._schedule_lock(p_job);
  if public.get_org_id() is not null and v_org <> public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % is not in the caller''s organization', p_job using errcode = '42501';
  end if;
  perform pm._schedule_run(p_job);
  select coalesce(max(b.number), 0) + 1 into v_no from pm.schedule_baselines b where b.org_id = v_org and b.job_id = p_job;
  v_name := coalesce(nullif(btrim(p_name), ''), 'Baseline ' || v_no);
  if char_length(v_name) > 80 then raise exception 'PM_INVALID: a baseline name is at most 80 characters' using errcode = '22023'; end if;
  update pm.schedule_baselines b set is_active = false where b.org_id = v_org and b.job_id = p_job and b.is_active;
  insert into pm.schedule_baselines (org_id, job_id, number, name, is_active, project_start, project_finish, task_count, created_by)
  select v_org, p_job, v_no, v_name, true, sc.start_on, sc.finish_on, coalesce(sc.task_count, 0), pm.current_user_id()
    from pm.schedules sc where sc.job_id = p_job
  returning id into v_id;
  insert into pm.schedule_baseline_tasks (org_id, baseline_id, job_id, task_id, title, wbs_code, sort, is_summary, is_milestone, start_on, due_on, duration_days)
  select v_org, v_id, p_job, t.id, t.title, t.wbs_code, t.sort, t.is_summary, t.is_milestone, t.start_on, t.due_on, t.duration_days
    from pm.tasks t where t.org_id = v_org and t.job_id = p_job and t.status <> 'CANCELLED';
  return v_id;
end $$;
comment on function pm.set_schedule_baseline(uuid, text) is
  '1112 / spec §2: run CPM, then snapshot the job''s schedule as its new active baseline; returns the baseline id.';

-- ----------------------------------------------------------------------------
-- 9. Templates
-- ----------------------------------------------------------------------------
create table if not exists pm.schedule_template_catalog (
  key            text primary key check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  pack_key       text not null check (pack_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name           text not null,
  description    text,
  job_type_keys  text[] not null default '{}',
  body           jsonb not null,
  task_count     int not null default 0,
  version        int not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table pm.schedule_template_catalog is '1112: global schedule templates per industry pack (Merit-published; service_role writes).';

create table if not exists pm.schedule_templates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id),
  key            text not null check (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name           text not null check (char_length(btrim(name)) between 1 and 120),
  description    text,
  pack_key       text,
  job_type_keys  text[] not null default '{}',
  body           jsonb not null,
  task_count     int not null default 0,
  source         text not null default 'TENANT' check (source in ('PACK', 'TENANT')),
  catalog_key    text,
  is_active      boolean not null default true,
  created_by     text default pm.current_user_id(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, location_id, key)
);
comment on table pm.schedule_templates is '1112: a company''s schedule templates (PACK copies of its installed packs'' catalog templates + its own TENANT templates).';
create or replace trigger trg_touch_updated_at before update on pm.schedule_templates
  for each row execute function pm.tg_touch_updated_at();
create or replace trigger trg_location_in_org before insert or update of location_id, org_id on pm.schedule_templates
  for each row execute function pm.tg_location_in_org();

-- Validate a template body; returns its task count (tasks + milestones).
create or replace function pm._template_validate(p_body jsonb) returns int
language plpgsql stable
set search_path = pm, core, public
as $$
declare v_bad text; v_n int;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or jsonb_typeof(p_body -> 'items') <> 'array' then
    raise exception 'PM_TEMPLATE_INVALID: a template body is {"items": [...]}' using errcode = '22023';
  end if;
  if jsonb_array_length(p_body -> 'items') = 0 or jsonb_array_length(p_body -> 'items') > 2000 then
    raise exception 'PM_TEMPLATE_INVALID: a template has 1 to 2000 rows' using errcode = '22023';
  end if;
  with it as (select x.value as v from jsonb_array_elements(p_body -> 'items') x)
  select string_agg(coalesce(it.v ->> 'ref', '?'), ', ') into v_bad from it
   where jsonb_typeof(it.v) <> 'object'
      or coalesce(it.v ->> 'ref', '') !~ '^[a-z0-9_]{1,48}$'
      or coalesce(it.v ->> 'kind', '') not in ('phase', 'task', 'milestone')
      or char_length(btrim(coalesce(it.v ->> 'name', ''))) not between 1 and 200
      or (it.v ->> 'kind' = 'task' and case when jsonb_typeof(it.v -> 'duration') = 'number'
                                            then (it.v ->> 'duration')::numeric % 1 <> 0 or (it.v ->> 'duration')::numeric not between 0 and 3650
                                            else true end)
      or (it.v ? 'deps' and jsonb_typeof(it.v -> 'deps') <> 'array');
  if v_bad is not null then raise exception 'PM_TEMPLATE_INVALID: bad rows: %', v_bad using errcode = '22023'; end if;
  with it as (select x.value as v from jsonb_array_elements(p_body -> 'items') x)
  select string_agg(r, ', ') into v_bad from (select it.v ->> 'ref' as r from it group by 1 having count(*) > 1) d;
  if v_bad is not null then raise exception 'PM_TEMPLATE_INVALID: duplicate refs: %', v_bad using errcode = '22023'; end if;
  with it as (select x.value as v from jsonb_array_elements(p_body -> 'items') x)
  select string_agg(a.v ->> 'ref', ', ') into v_bad from it a
   where a.v ->> 'parent' is not null
     and not exists (select 1 from it p where p.v ->> 'ref' = a.v ->> 'parent' and p.v ->> 'kind' = 'phase');
  if v_bad is not null then raise exception 'PM_TEMPLATE_INVALID: parent is not a phase of the template: %', v_bad using errcode = '22023'; end if;
  with it as (select x.value as v from jsonb_array_elements(p_body -> 'items') x),
       dp as (select a.v ->> 'ref' as succ, a.v ->> 'kind' as kind, d.value as dep from it a cross join lateral jsonb_array_elements(coalesce(a.v -> 'deps', '[]')) d)
  select string_agg(dp.succ || '←' || coalesce(dp.dep ->> 'ref', '?'), ', ') into v_bad from dp
   where dp.kind = 'phase'
      or jsonb_typeof(dp.dep) <> 'object'
      or coalesce(dp.dep ->> 'type', 'FS') not in ('FS', 'SS', 'FF', 'SF')
      or (dp.dep ? 'lag' and case when jsonb_typeof(dp.dep -> 'lag') = 'number'
                                  then (dp.dep ->> 'lag')::numeric % 1 <> 0 or (dp.dep ->> 'lag')::numeric not between -365 and 365
                                  else true end)
      or dp.dep ->> 'ref' = dp.succ
      or not exists (select 1 from it p where p.v ->> 'ref' = dp.dep ->> 'ref' and p.v ->> 'kind' <> 'phase');
  if v_bad is not null then raise exception 'PM_TEMPLATE_INVALID: bad links (task ← predecessor): %', v_bad using errcode = '22023'; end if;
  select count(*) into v_n from jsonb_array_elements(p_body -> 'items') x where x.value ->> 'kind' <> 'phase';
  return v_n;
end $$;

create or replace function pm.tg_schedule_template_validate() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  new.task_count := pm._template_validate(new.body);
  return new;
end $$;
create or replace trigger trg_schedule_template_validate before insert or update of body on pm.schedule_templates
  for each row execute function pm.tg_schedule_template_validate();
create or replace trigger trg_schedule_template_validate before insert or update of body on pm.schedule_template_catalog
  for each row execute function pm.tg_schedule_template_validate();

-- Catalog seed. Rows: (template, kind P phase | T task | M milestone, ref, phase, name, working days,
-- predecessors "ref", "ref:SS", "ref:FF+2", "ref-1" (FS lead), comma-separated).
do $tpl$
declare v_bad text;
begin
  create temp table _tpl_head (key text primary key, pack_key text, name text, description text, job_type_keys text[]);
  create temp table _tpl_rows (ord serial, tpl text, kind text, ref text, parent text, name text, dur int, deps text);

  insert into _tpl_head values
    ('commercial_ti', 'commercial_gc', 'Commercial tenant improvement',
     'Office or retail interior build-out: permit and long-lead gear, demolition, MEP rough-in, inspections, close-up, finishes, closeout and CO.',
     '{tenant_improvement,lump_sum,gmp_cost_plus}'),
    ('kitchen_remodel', 'residential_remodel', 'Kitchen remodel',
     'Full kitchen: selections, permit, cabinet lead time, demolition, rough-in, drywall, cabinets, tops, trim and punch.',
     '{fixed_price_remodel,cost_plus_remodel}'),
    ('bathroom_remodel', 'residential_remodel', 'Bathroom remodel',
     'Hall or primary bath: demolition, rough-in, waterproofing, tile, vanity, glass, trim and punch.',
     '{fixed_price_remodel,cost_plus_remodel,small_repair}'),
    ('custom_home', 'home_builder', 'Custom home build',
     'Contract to closing: preconstruction and permits, site work, foundation, framing, dry-in, rough-ins, insulation and drywall, interior and exterior finishes, site finish, finals and CO.',
     '{custom_home,cost_plus_home,presold_home,spec_home}'),
    ('hvac_replacement', 'field_service', 'HVAC replacement install',
     'Changeout from sale to follow-up: survey, permit, order, removal, set, connect, start-up, inspection.',
     '{replacement_install,commercial_service}'),
    ('cabinet_eto', 'manufacturing_eto', 'Cabinet job (design to install)',
     'Engineered-to-order casework: measure, design, drawings approval, procurement, CNC, assembly, finishing, QC, delivery and install.',
     '{residential_cabinets,commercial_millwork,build_to_print}'),
    ('flooring_install', 'flooring', 'Flooring install',
     'Measure to walkthrough: quote, order, lead time, acclimation, tear-out, prep, install and transitions.',
     '{retail_install,builder_lot,commercial_flooring}'),
    ('re_development', 'real_estate_development', 'Real estate development milestones',
     'Acquisition through stabilization: diligence, land closing, entitlements, design, financing, construction, sales or lease-up.',
     '{for_sale_development,rental_development,land_development}'),
    ('trade_rough_trim', 'specialty_trade', 'Trade rough-in and trim',
     'Two-trip trade scope: submittals, material, rough-in, inspection, wait for the GC, trim-out and final.',
     '{subcontract,tm_work}'),
    ('design_project', 'interior_design', 'Full-service design project',
     'Discovery to reveal: concept, design development, approval, specification, procurement, receiving and install day.',
     '{full_service_design,flat_fee_design,procurement_order}'),
    ('engagement_phases', 'professional_services', 'Engagement phases',
     'Kickoff, discovery, analysis, recommendations, client review, delivery and closeout.',
     '{hourly_engagement,fixed_fee,monthly_retainer}'),
    ('pdi_delivery', 'equipment_dealer', 'PDI and delivery',
     'Unit received to delivered: PDI, accessories, set-up, customer walkthrough and delivery.',
     '{pdi_setup,customer_repair}'),
    ('simple_project', 'general', 'Simple project',
     'Plan, procure, do the work, close out: a neutral starting schedule for any job.',
     '{fixed_price,milestone_project,time_materials}');

  insert into _tpl_rows (tpl, kind, ref, parent, name, dur, deps) values
    -- commercial tenant improvement (65)
    ('commercial_ti','P','pre',null,'Preconstruction',null,null),
    ('commercial_ti','M','ntp','pre','Notice to proceed',0,''),
    ('commercial_ti','T','precon','pre','Preconstruction meeting',1,'ntp'),
    ('commercial_ti','T','permit_submit','pre','Permit submission',2,'ntp'),
    ('commercial_ti','T','permit_review','pre','Building permit review',15,'permit_submit'),
    ('commercial_ti','M','permit_issued','pre','Permit issued',0,'permit_review'),
    ('commercial_ti','T','submittals_arch','pre','Architectural submittals',10,'precon'),
    ('commercial_ti','T','submittals_mep','pre','MEP and fire protection submittals',10,'precon'),
    ('commercial_ti','T','submittal_review','pre','Architect and engineer submittal review',10,'submittals_arch,submittals_mep'),
    ('commercial_ti','T','order_long_lead','pre','Order long-lead equipment (RTU, switchgear)',2,'submittal_review'),
    ('commercial_ti','T','long_lead','pre','Long-lead fabrication and delivery',35,'order_long_lead'),
    ('commercial_ti','T','order_storefront','pre','Order storefront and doors',2,'submittal_review'),
    ('commercial_ti','T','storefront_lead','pre','Storefront and door lead time',25,'order_storefront'),
    ('commercial_ti','P','demo',null,'Demolition and preparation',null,null),
    ('commercial_ti','T','mobilize','demo','Mobilize, temporary protection and signage',2,'permit_issued'),
    ('commercial_ti','T','abatement','demo','Abatement (where required)',3,'mobilize'),
    ('commercial_ti','T','demo_interior','demo','Interior demolition',5,'abatement'),
    ('commercial_ti','T','demo_mep','demo','MEP demolition and make-safe',3,'demo_interior:SS+2'),
    ('commercial_ti','T','sawcut','demo','Sawcut and trench slab for plumbing',3,'demo_interior'),
    ('commercial_ti','T','layout','demo','Layout walls',1,'demo_interior'),
    ('commercial_ti','P','rough',null,'Rough-in',null,null),
    ('commercial_ti','T','ug_plumbing','rough','Underground plumbing',4,'sawcut'),
    ('commercial_ti','T','ug_insp','rough','Underground plumbing inspection',1,'ug_plumbing'),
    ('commercial_ti','T','slab_patch','rough','Patch slab',2,'ug_insp'),
    ('commercial_ti','T','framing','rough','Metal stud framing',10,'layout'),
    ('commercial_ti','T','door_frames','rough','Hollow metal door frames',3,'framing:SS+3'),
    ('commercial_ti','T','blocking','rough','In-wall blocking',3,'framing:SS+4'),
    ('commercial_ti','T','hvac_rough','rough','HVAC ductwork rough-in',10,'framing:SS+3,demo_mep'),
    ('commercial_ti','T','plumbing_rough','rough','Plumbing rough-in',6,'framing:SS+3,slab_patch'),
    ('commercial_ti','T','electrical_rough','rough','Electrical rough-in',10,'framing:SS+3,demo_mep'),
    ('commercial_ti','T','sprinkler_rough','rough','Fire sprinkler rough-in',6,'framing:SS+5'),
    ('commercial_ti','T','fire_alarm_rough','rough','Fire alarm rough-in',4,'electrical_rough:SS+4'),
    ('commercial_ti','T','low_voltage','rough','Low voltage and data rough-in',5,'electrical_rough:SS+5'),
    ('commercial_ti','T','in_wall_insp','rough','In-wall inspections',1,'plumbing_rough,electrical_rough,hvac_rough,blocking'),
    ('commercial_ti','T','insulation','rough','Wall insulation',2,'in_wall_insp'),
    ('commercial_ti','P','close',null,'Close-up',null,null),
    ('commercial_ti','T','drywall_hang','close','Hang drywall',6,'insulation'),
    ('commercial_ti','T','drywall_finish','close','Tape and finish drywall',6,'drywall_hang:SS+3'),
    ('commercial_ti','T','above_ceiling','close','Above-ceiling MEP complete',3,'hvac_rough,sprinkler_rough,fire_alarm_rough,low_voltage'),
    ('commercial_ti','T','above_ceiling_insp','close','Above-ceiling inspection',1,'above_ceiling,drywall_hang'),
    ('commercial_ti','T','ceiling_grid','close','Ceiling grid',4,'above_ceiling_insp'),
    ('commercial_ti','T','prime','close','Prime walls',2,'drywall_finish'),
    ('commercial_ti','P','fin',null,'Finishes',null,null),
    ('commercial_ti','T','paint','fin','Paint',6,'prime'),
    ('commercial_ti','T','rtu_set','fin','Set rooftop units (crane)',1,'long_lead,hvac_rough'),
    ('commercial_ti','T','storefront','fin','Install storefront and entrance',4,'storefront_lead,demo_interior'),
    ('commercial_ti','T','doors_hw','fin','Doors and hardware',3,'paint,door_frames'),
    ('commercial_ti','T','casework','fin','Casework and countertops',4,'paint'),
    ('commercial_ti','T','flooring_hard','fin','Tile and hard flooring',5,'paint'),
    ('commercial_ti','T','flooring_soft','fin','Carpet and resilient flooring',4,'flooring_hard:SS+2'),
    ('commercial_ti','T','base','fin','Rubber base',2,'flooring_soft'),
    ('commercial_ti','T','ceiling_tile','fin','Ceiling tile',3,'ceiling_grid,paint:SS+3'),
    ('commercial_ti','T','electrical_trim','fin','Electrical trim and light fixtures',5,'ceiling_tile:SS+1'),
    ('commercial_ti','T','plumbing_trim','fin','Plumbing fixtures and trim',3,'casework,flooring_hard'),
    ('commercial_ti','T','hvac_startup','fin','HVAC start-up',2,'rtu_set,electrical_trim'),
    ('commercial_ti','T','fa_devices','fin','Fire alarm devices and test',3,'ceiling_tile'),
    ('commercial_ti','T','sprinkler_trim','fin','Sprinkler heads trim',2,'ceiling_tile'),
    ('commercial_ti','T','tab','fin','Test and balance',3,'hvac_startup,ceiling_tile'),
    ('commercial_ti','T','specialties','fin','Toilet accessories and specialties',2,'plumbing_trim'),
    ('commercial_ti','T','final_clean','fin','Final clean',2,'base,doors_hw,electrical_trim,specialties,storefront'),
    ('commercial_ti','P','out',null,'Closeout',null,null),
    ('commercial_ti','T','fire_final','out','Fire marshal final',1,'fa_devices,sprinkler_trim'),
    ('commercial_ti','T','building_final','out','Building final inspection',1,'final_clean,tab,plumbing_trim,fire_final'),
    ('commercial_ti','M','co','out','Certificate of occupancy',0,'building_final'),
    ('commercial_ti','T','punch_walk','out','Punch walk with the architect',1,'final_clean'),
    ('commercial_ti','T','punch','out','Punch list completion',5,'punch_walk'),
    ('commercial_ti','T','om_manuals','out','O&M manuals, warranties and as-builts',5,'punch_walk:SS'),
    ('commercial_ti','T','training','out','Owner training',1,'tab'),
    ('commercial_ti','M','substantial','out','Substantial completion',0,'co,punch'),
    ('commercial_ti','T','closeout','out','Closeout and final pay application',5,'substantial,om_manuals,training'),
    ('commercial_ti','M','final_completion','out','Final completion',0,'closeout'),

    -- kitchen remodel (29)
    ('kitchen_remodel','P','pre',null,'Preconstruction',null,null),
    ('kitchen_remodel','M','contract','pre','Contract signed',0,''),
    ('kitchen_remodel','T','selections','pre','Selections finalized',5,'contract'),
    ('kitchen_remodel','T','permit','pre','Permit approval',10,'contract'),
    ('kitchen_remodel','T','order_cabinets','pre','Order cabinets',1,'selections'),
    ('kitchen_remodel','T','cabinet_lead','pre','Cabinet lead time',25,'order_cabinets'),
    ('kitchen_remodel','T','order_fixtures','pre','Order appliances and fixtures',1,'selections'),
    ('kitchen_remodel','P','demo',null,'Demolition',null,null),
    ('kitchen_remodel','T','protect','demo','Site protection and dust control',1,'permit,selections'),
    ('kitchen_remodel','T','demolition','demo','Demolition and haul-off',2,'protect'),
    ('kitchen_remodel','P','rough',null,'Rough-in',null,null),
    ('kitchen_remodel','T','framing','rough','Framing changes',2,'demolition'),
    ('kitchen_remodel','T','plumbing_rough','rough','Plumbing rough-in',2,'framing'),
    ('kitchen_remodel','T','electrical_rough','rough','Electrical rough-in',2,'plumbing_rough:SS'),
    ('kitchen_remodel','T','hvac_rough','rough','HVAC and range hood duct',1,'plumbing_rough:SS+1'),
    ('kitchen_remodel','T','rough_insp','rough','Rough inspection',1,'plumbing_rough,electrical_rough,hvac_rough'),
    ('kitchen_remodel','P','close',null,'Close-up',null,null),
    ('kitchen_remodel','T','insulation','close','Insulation',1,'rough_insp'),
    ('kitchen_remodel','T','drywall','close','Drywall hang and finish',4,'insulation'),
    ('kitchen_remodel','P','fin',null,'Finishes',null,null),
    ('kitchen_remodel','T','prime','fin','Prime and first coat',2,'drywall'),
    ('kitchen_remodel','T','flooring','fin','Flooring',2,'prime'),
    ('kitchen_remodel','T','cabinets','fin','Install cabinets',2,'flooring,cabinet_lead'),
    ('kitchen_remodel','T','template_tops','fin','Countertop template',1,'cabinets'),
    ('kitchen_remodel','T','fab_tops','fin','Countertop fabrication',7,'template_tops'),
    ('kitchen_remodel','T','install_tops','fin','Install countertops',1,'fab_tops'),
    ('kitchen_remodel','T','backsplash','fin','Tile backsplash',2,'install_tops'),
    ('kitchen_remodel','T','plumbing_trim','fin','Plumbing trim and fixtures',1,'install_tops'),
    ('kitchen_remodel','T','electrical_trim','fin','Electrical trim and under-cabinet lights',1,'plumbing_trim:SS'),
    ('kitchen_remodel','T','appliances','fin','Set appliances',1,'install_tops,order_fixtures'),
    ('kitchen_remodel','T','final_paint','fin','Final paint and touch-up',1,'backsplash,electrical_trim'),
    ('kitchen_remodel','P','out',null,'Closeout',null,null),
    ('kitchen_remodel','T','final_insp','out','Final inspection',1,'final_paint,plumbing_trim,appliances'),
    ('kitchen_remodel','T','punch','out','Punch list',2,'final_insp'),
    ('kitchen_remodel','M','complete','out','Substantial completion',0,'punch'),

    -- bathroom remodel (21)
    ('bathroom_remodel','P','pre',null,'Preconstruction',null,null),
    ('bathroom_remodel','M','contract','pre','Contract signed',0,''),
    ('bathroom_remodel','T','selections','pre','Tile and fixture selections',5,'contract'),
    ('bathroom_remodel','T','permit','pre','Permit approval',5,'contract'),
    ('bathroom_remodel','T','order','pre','Order vanity, fixtures and tile',10,'selections'),
    ('bathroom_remodel','P','rough',null,'Demolition and rough-in',null,null),
    ('bathroom_remodel','T','protect','rough','Protect floors and set up dust control',1,'permit,selections'),
    ('bathroom_remodel','T','demolition','rough','Demolition',2,'protect'),
    ('bathroom_remodel','T','plumbing_rough','rough','Plumbing rough-in',2,'demolition'),
    ('bathroom_remodel','T','electrical_rough','rough','Electrical and exhaust fan rough-in',1,'plumbing_rough:SS'),
    ('bathroom_remodel','T','rough_insp','rough','Rough inspection',1,'plumbing_rough,electrical_rough'),
    ('bathroom_remodel','P','fin',null,'Finishes',null,null),
    ('bathroom_remodel','T','board','fin','Cement board and drywall',2,'rough_insp'),
    ('bathroom_remodel','T','waterproof','fin','Waterproofing and flood test',2,'board'),
    ('bathroom_remodel','T','tile','fin','Tile floor and shower',4,'waterproof,order'),
    ('bathroom_remodel','T','grout','fin','Grout and seal',1,'tile'),
    ('bathroom_remodel','T','paint','fin','Paint',1,'grout'),
    ('bathroom_remodel','T','vanity','fin','Vanity and top',1,'paint'),
    ('bathroom_remodel','T','trim','fin','Plumbing and electrical trim',1,'vanity'),
    ('bathroom_remodel','T','glass','fin','Shower glass (measured after tile)',1,'grout+5'),
    ('bathroom_remodel','T','accessories','fin','Mirror and accessories',1,'trim'),
    ('bathroom_remodel','P','out',null,'Closeout',null,null),
    ('bathroom_remodel','T','final_insp','out','Final inspection',1,'trim,glass,accessories'),
    ('bathroom_remodel','T','punch','out','Punch list',1,'final_insp'),
    ('bathroom_remodel','M','complete','out','Substantial completion',0,'punch'),

    -- custom home (133)
    ('custom_home','P','pre',null,'Preconstruction',null,null),
    ('custom_home','M','contract','pre','Contract signed',0,''),
    ('custom_home','T','plan_review','pre','Plan review and engineering',10,'contract'),
    ('custom_home','T','survey','pre','Lot survey and staking plan',3,'contract'),
    ('custom_home','T','soils','pre','Soils report',5,'contract'),
    ('custom_home','T','truss_design','pre','Truss and engineered lumber design',7,'plan_review'),
    ('custom_home','T','energy','pre','Energy code calculations',2,'plan_review'),
    ('custom_home','T','permit_submit','pre','Submit building permit',1,'plan_review,survey,soils,energy'),
    ('custom_home','T','permit_review','pre','Permit review',20,'permit_submit'),
    ('custom_home','M','permit_issued','pre','Building permit issued',0,'permit_review'),
    ('custom_home','T','selections_ext','pre','Selections: exterior, windows and doors',5,'contract'),
    ('custom_home','T','selections_kitchen','pre','Selections: cabinets, counters and plumbing',10,'selections_ext'),
    ('custom_home','T','selections_finish','pre','Selections: flooring, tile, lighting and paint',10,'selections_kitchen'),
    ('custom_home','T','loan','pre','Construction loan closing',15,'contract'),
    ('custom_home','T','precon_meeting','pre','Preconstruction meeting with the owner',1,'permit_issued,loan'),
    ('custom_home','P','site',null,'Site work',null,null),
    ('custom_home','T','locates','site','Utility locates',2,'precon_meeting'),
    ('custom_home','T','erosion','site','Silt fence and erosion control',1,'locates'),
    ('custom_home','T','clear','site','Clear and grub the lot',2,'erosion'),
    ('custom_home','T','temp_power','site','Temporary power and toilet',2,'locates'),
    ('custom_home','T','rock_drive','site','Construction entrance (rock drive)',1,'clear'),
    ('custom_home','T','stake','site','Stake house corners',1,'clear'),
    ('custom_home','T','excavate','site','Excavate basement',3,'stake'),
    ('custom_home','T','taps','site','Water and sewer taps',3,'excavate:SS+1'),
    ('custom_home','P','found',null,'Foundation',null,null),
    ('custom_home','T','footing_forms','found','Form footings',2,'excavate'),
    ('custom_home','T','footing_insp','found','Footing inspection',1,'footing_forms'),
    ('custom_home','T','footing_pour','found','Pour footings',1,'footing_insp'),
    ('custom_home','T','wall_forms','found','Form foundation walls',3,'footing_pour+1'),
    ('custom_home','T','wall_insp','found','Foundation wall inspection',1,'wall_forms'),
    ('custom_home','T','wall_pour','found','Pour foundation walls',1,'wall_insp'),
    ('custom_home','T','strip_forms','found','Strip forms',1,'wall_pour+2'),
    ('custom_home','T','waterproofing','found','Waterproofing and drain tile',2,'strip_forms'),
    ('custom_home','T','ug_plumbing','found','Under-slab plumbing',2,'strip_forms'),
    ('custom_home','T','ug_insp','found','Under-slab plumbing inspection',1,'ug_plumbing'),
    ('custom_home','T','backfill','found','Backfill foundation',2,'waterproofing,ug_insp'),
    ('custom_home','T','slab_prep','found','Gravel, vapor barrier and radon pipe',1,'ug_insp'),
    ('custom_home','T','basement_slab','found','Pour basement slab',1,'slab_prep,backfill'),
    ('custom_home','P','frame',null,'Framing',null,null),
    ('custom_home','T','lumber','frame','Lumber package delivery',1,'backfill'),
    ('custom_home','T','deck_1','frame','First-floor deck: sill, joists and subfloor',4,'lumber'),
    ('custom_home','T','walls_1','frame','First-floor walls',4,'deck_1'),
    ('custom_home','T','beams','frame','Beams, posts and hardware',2,'walls_1:SS+2'),
    ('custom_home','T','deck_2','frame','Second-floor deck',3,'walls_1'),
    ('custom_home','T','walls_2','frame','Second-floor walls',4,'deck_2'),
    ('custom_home','T','stairs','frame','Stairs',1,'deck_2'),
    ('custom_home','T','truss_lead','frame','Truss fabrication lead time',15,'truss_design'),
    ('custom_home','T','trusses','frame','Set roof trusses',2,'walls_2,truss_lead'),
    ('custom_home','T','roof_sheathing','frame','Roof sheathing',2,'trusses'),
    ('custom_home','T','porch_framing','frame','Porch and deck framing',3,'roof_sheathing'),
    ('custom_home','T','framing_punch','frame','Framing punch and blocking',2,'roof_sheathing,stairs,beams'),
    ('custom_home','P','dryin',null,'Dry-in',null,null),
    ('custom_home','T','underlayment','dryin','Roof underlayment and drip edge',1,'roof_sheathing'),
    ('custom_home','T','roofing','dryin','Shingles and flashing',4,'underlayment'),
    ('custom_home','T','house_wrap','dryin','House wrap',2,'roof_sheathing'),
    ('custom_home','T','windows_order','dryin','Order windows and exterior doors',1,'selections_ext'),
    ('custom_home','T','windows_lead','dryin','Window and door lead time',30,'windows_order'),
    ('custom_home','T','windows','dryin','Install windows',3,'windows_lead,house_wrap'),
    ('custom_home','T','ext_doors','dryin','Install exterior doors',1,'windows'),
    ('custom_home','M','dried_in','dryin','Dried in',0,'roofing,windows,ext_doors'),
    ('custom_home','P','rough',null,'Mechanical rough-ins',null,null),
    ('custom_home','T','plumbing_topout','rough','Plumbing top-out',5,'dried_in'),
    ('custom_home','T','tubs','rough','Set tubs and shower pans',1,'plumbing_topout:SS+1'),
    ('custom_home','T','hvac_rough','rough','HVAC rough-in',5,'dried_in,plumbing_topout:SS+1'),
    ('custom_home','T','gas','rough','Gas piping',1,'hvac_rough'),
    ('custom_home','T','fireplace','rough','Fireplace install',1,'dried_in'),
    ('custom_home','T','electrical_rough','rough','Electrical rough-in',6,'hvac_rough:SS+2'),
    ('custom_home','T','low_voltage','rough','Low voltage, data and security prewire',2,'electrical_rough:SS+3'),
    ('custom_home','T','plumbing_insp','rough','Plumbing rough inspection',1,'plumbing_topout,tubs'),
    ('custom_home','T','mech_insp','rough','Mechanical rough inspection',1,'hvac_rough,gas,fireplace'),
    ('custom_home','T','elec_insp','rough','Electrical rough inspection',1,'electrical_rough,low_voltage'),
    ('custom_home','T','framing_insp','rough','Framing inspection',1,'framing_punch,plumbing_insp,mech_insp,elec_insp'),
    ('custom_home','M','rough_ok','rough','Rough-ins approved',0,'framing_insp'),
    ('custom_home','T','owner_rough_walk','rough','Owner pre-drywall walkthrough',1,'rough_ok'),
    ('custom_home','T','fire_block','rough','Fire blocking and sealing',1,'rough_ok'),
    ('custom_home','P','insul',null,'Insulation and drywall',null,null),
    ('custom_home','T','insulation','insul','Insulation (walls and rims)',2,'owner_rough_walk,fire_block'),
    ('custom_home','T','insul_insp','insul','Insulation inspection',1,'insulation'),
    ('custom_home','T','drywall_stock','insul','Drywall delivery and stocking',1,'insul_insp'),
    ('custom_home','T','drywall_hang','insul','Hang drywall',5,'drywall_stock'),
    ('custom_home','T','attic_insul','insul','Blown attic insulation',1,'drywall_hang'),
    ('custom_home','T','drywall_tape','insul','Tape and mud',5,'drywall_hang'),
    ('custom_home','T','drywall_sand','insul','Sand and texture',2,'drywall_tape'),
    ('custom_home','T','drywall_walk','insul','Drywall walk and touch-up',1,'drywall_sand'),
    ('custom_home','P','int',null,'Interior finishes',null,null),
    ('custom_home','T','cabinets_order','int','Order cabinets',1,'selections_kitchen'),
    ('custom_home','T','cabinets_lead','int','Cabinet lead time',35,'cabinets_order'),
    ('custom_home','T','prime','int','Prime walls and ceilings',2,'drywall_walk'),
    ('custom_home','T','int_trim','int','Interior doors and trim',6,'prime'),
    ('custom_home','T','stair_rail','int','Stair parts and railings',2,'int_trim:SS+2'),
    ('custom_home','T','cabinets','int','Install cabinets',4,'cabinets_lead,prime'),
    ('custom_home','T','hardware','int','Cabinet and door hardware',1,'cabinets,int_trim'),
    ('custom_home','T','counter_template','int','Countertop template',1,'cabinets'),
    ('custom_home','T','counter_fab','int','Countertop fabrication',10,'counter_template'),
    ('custom_home','T','counters','int','Install countertops',1,'counter_fab'),
    ('custom_home','T','tile_floor','int','Tile floors',5,'prime'),
    ('custom_home','T','tile_shower','int','Tile showers and tub surrounds',5,'tile_floor:SS+1'),
    ('custom_home','T','backsplash','int','Tile backsplash',2,'counters'),
    ('custom_home','T','paint','int','Paint walls and trim',7,'int_trim'),
    ('custom_home','T','hardwood','int','Hardwood and LVP flooring',5,'paint'),
    ('custom_home','T','plumbing_trim','int','Plumbing trim and fixtures',3,'counters,tile_shower'),
    ('custom_home','T','electrical_trim','int','Electrical trim and fixtures',4,'paint'),
    ('custom_home','T','hvac_trim','int','HVAC trim, registers and start-up',2,'paint'),
    ('custom_home','T','appliances','int','Appliances',1,'counters,electrical_trim'),
    ('custom_home','T','shower_glass','int','Shower glass',1,'tile_shower+5'),
    ('custom_home','T','mirrors','int','Mirrors, bath accessories and shelving',2,'paint,shower_glass'),
    ('custom_home','T','closets','int','Closet systems',2,'paint'),
    ('custom_home','T','touch_up','int','Final paint touch-up',2,'plumbing_trim,electrical_trim,appliances,mirrors,closets,stair_rail,hardware,hardwood'),
    ('custom_home','T','carpet','int','Carpet',2,'touch_up'),
    ('custom_home','P','ext',null,'Exterior finishes',null,null),
    ('custom_home','T','soffit','ext','Soffit and fascia',3,'roofing'),
    ('custom_home','T','siding_order','ext','Order siding and exterior trim',1,'selections_ext'),
    ('custom_home','T','siding_lead','ext','Siding lead time',10,'siding_order'),
    ('custom_home','T','siding','ext','Siding',8,'house_wrap,windows,siding_lead'),
    ('custom_home','T','ext_trim','ext','Exterior trim and corners',3,'siding:SS+3'),
    ('custom_home','T','masonry','ext','Stone and brick veneer',5,'windows'),
    ('custom_home','T','gutters','ext','Gutters and downspouts',1,'soffit,siding'),
    ('custom_home','T','ext_paint','ext','Exterior paint and caulk',4,'ext_trim,masonry'),
    ('custom_home','T','garage_door','ext','Garage door and opener',1,'ext_paint'),
    ('custom_home','T','porch_finish','ext','Porch ceilings, columns and decking',3,'porch_framing,ext_paint:SS'),
    ('custom_home','T','ext_lights','ext','Exterior lights and fixtures',1,'ext_paint,electrical_trim'),
    ('custom_home','P','sitefin',null,'Site finish and landscaping',null,null),
    ('custom_home','T','rough_grade','sitefin','Rough grade',2,'backfill,taps'),
    ('custom_home','T','flatwork_forms','sitefin','Driveway, walk and patio forms',2,'rough_grade,masonry'),
    ('custom_home','T','flatwork','sitefin','Pour driveway, walks and patio',2,'flatwork_forms'),
    ('custom_home','T','final_grade','sitefin','Final grade',2,'flatwork,gutters'),
    ('custom_home','T','irrigation','sitefin','Irrigation',2,'final_grade'),
    ('custom_home','T','sod','sitefin','Sod and seed',2,'irrigation'),
    ('custom_home','T','landscaping','sitefin','Landscape beds and plantings',3,'final_grade'),
    ('custom_home','T','mailbox','sitefin','Mailbox and address',1,'flatwork'),
    ('custom_home','P','close',null,'Finals and closing',null,null),
    ('custom_home','T','final_clean','close','Final clean',2,'carpet,ext_lights,garage_door,porch_finish'),
    ('custom_home','T','blower_door','close','Blower door and energy test',1,'final_clean'),
    ('custom_home','T','plumbing_final','close','Plumbing final',1,'plumbing_trim'),
    ('custom_home','T','mech_final','close','Mechanical final',1,'hvac_trim,appliances'),
    ('custom_home','T','elec_final','close','Electrical final',1,'electrical_trim,ext_lights'),
    ('custom_home','T','building_final','close','Building final inspection',1,'plumbing_final,mech_final,elec_final,blower_door,final_grade'),
    ('custom_home','M','co','close','Certificate of occupancy',0,'building_final'),
    ('custom_home','T','orientation','close','Homeowner orientation walkthrough',1,'co'),
    ('custom_home','T','punch','close','Punch list',5,'orientation'),
    ('custom_home','T','touch_clean','close','Touch-up clean',1,'punch'),
    ('custom_home','T','closing_docs','close','Warranty binder and closing documents',2,'co'),
    ('custom_home','M','closing','close','Closing and keys',0,'touch_clean,closing_docs,sod,landscaping,mailbox'),
    ('custom_home','T','warranty_visit','close','30-day warranty visit',1,'closing+20'),

    -- HVAC replacement install (14)
    ('hvac_replacement','P','sale',null,'Sale and order',null,null),
    ('hvac_replacement','M','sold','sale','Sale closed',0,''),
    ('hvac_replacement','T','survey','sale','Load calculation and site survey',1,'sold'),
    ('hvac_replacement','T','permit','sale','Mechanical permit',3,'sold'),
    ('hvac_replacement','T','order','sale','Order equipment',1,'survey'),
    ('hvac_replacement','T','lead','sale','Equipment lead time',5,'order'),
    ('hvac_replacement','P','install',null,'Install',null,null),
    ('hvac_replacement','T','stage','install','Stage equipment and materials',1,'lead'),
    ('hvac_replacement','T','removal','install','Remove old equipment and recover refrigerant',1,'stage,permit'),
    ('hvac_replacement','T','set_equipment','install','Set furnace, coil and condenser',1,'removal:SS'),
    ('hvac_replacement','T','connections','install','Line set, drain, electrical and venting',1,'set_equipment:SS'),
    ('hvac_replacement','T','startup','install','Start-up, charge and commissioning',1,'set_equipment,connections'),
    ('hvac_replacement','P','closeout',null,'Closeout',null,null),
    ('hvac_replacement','T','walkthrough','closeout','Customer walkthrough and warranty registration',1,'startup'),
    ('hvac_replacement','T','inspection','closeout','Permit inspection',1,'startup+2'),
    ('hvac_replacement','T','follow_up','closeout','Follow-up call',1,'startup+5'),
    ('hvac_replacement','M','closed','closeout','Job closed',0,'walkthrough,inspection,follow_up'),

    -- cabinet ETO job (25)
    ('cabinet_eto','P','eng',null,'Engineering',null,null),
    ('cabinet_eto','T','measure','eng','Field measure',1,''),
    ('cabinet_eto','T','design','eng','Design and layout',3,'measure'),
    ('cabinet_eto','T','quote','eng','Price and quote approval',2,'design'),
    ('cabinet_eto','M','deposit','eng','Deposit received',0,'quote'),
    ('cabinet_eto','T','shop_drawings','eng','Shop drawings',4,'deposit'),
    ('cabinet_eto','T','drawing_review','eng','Customer drawing review',3,'shop_drawings'),
    ('cabinet_eto','M','approved','eng','Drawings approved',0,'drawing_review'),
    ('cabinet_eto','T','programming','eng','Cut list and CNC programming',2,'approved'),
    ('cabinet_eto','P','proc',null,'Procurement',null,null),
    ('cabinet_eto','T','order_sheet','proc','Order sheet goods',1,'approved'),
    ('cabinet_eto','T','sheet_lead','proc','Sheet goods lead time',5,'order_sheet'),
    ('cabinet_eto','T','order_hardware','proc','Order hardware and accessories',1,'approved'),
    ('cabinet_eto','T','hardware_lead','proc','Hardware lead time',7,'order_hardware'),
    ('cabinet_eto','T','order_doors','proc','Order doors and drawer fronts',1,'approved'),
    ('cabinet_eto','T','doors_lead','proc','Door and drawer-front lead time',15,'order_doors'),
    ('cabinet_eto','P','shop',null,'Shop',null,null),
    ('cabinet_eto','T','cnc','shop','CNC cut and edgeband',3,'programming,sheet_lead'),
    ('cabinet_eto','T','boxes','shop','Box assembly',4,'cnc:SS+1'),
    ('cabinet_eto','T','drawers','shop','Drawer boxes',2,'cnc'),
    ('cabinet_eto','T','finishing','shop','Finishing (sand, stain and topcoat)',5,'boxes,doors_lead'),
    ('cabinet_eto','T','final_assembly','shop','Final assembly (doors, fronts and hardware)',2,'finishing,drawers,hardware_lead'),
    ('cabinet_eto','T','qc','shop','QC and pack',1,'final_assembly'),
    ('cabinet_eto','P','field',null,'Field',null,null),
    ('cabinet_eto','T','deliver','field','Deliver to site',1,'qc'),
    ('cabinet_eto','T','install','field','Install',4,'deliver'),
    ('cabinet_eto','T','counters','field','Countertop template handoff',1,'install'),
    ('cabinet_eto','T','punch','field','Punch and adjustments',1,'install+5'),
    ('cabinet_eto','M','complete','field','Job complete',0,'punch,counters'),

    -- flooring install (11)
    ('flooring_install','P','sell',null,'Measure and order',null,null),
    ('flooring_install','T','measure','sell','Measure',1,''),
    ('flooring_install','M','approved','sell','Quote approved',0,'measure'),
    ('flooring_install','T','order','sell','Order material',1,'approved'),
    ('flooring_install','T','lead','sell','Material lead time',10,'order'),
    ('flooring_install','P','prep',null,'Preparation',null,null),
    ('flooring_install','T','deliver','prep','Delivery and acclimation',2,'lead'),
    ('flooring_install','T','move_out','prep','Move furniture',1,'deliver:FF'),
    ('flooring_install','T','tear_out','prep','Remove existing flooring',1,'move_out'),
    ('flooring_install','T','subfloor','prep','Subfloor prep and leveling',1,'tear_out'),
    ('flooring_install','P','inst',null,'Install',null,null),
    ('flooring_install','T','install','inst','Install flooring',2,'subfloor,deliver'),
    ('flooring_install','T','trim','inst','Transitions, base and trim',1,'install'),
    ('flooring_install','M','walkthrough','inst','Customer walkthrough',0,'trim'),

    -- real estate development milestones (29)
    ('re_development','P','acq',null,'Acquisition',null,null),
    ('re_development','M','loi','acq','LOI signed',0,''),
    ('re_development','M','psa','acq','Purchase agreement signed',0,'loi+10'),
    ('re_development','T','diligence','acq','Due diligence period',30,'psa'),
    ('re_development','T','phase1','acq','Phase I environmental',15,'psa'),
    ('re_development','T','title','acq','Title and survey review',20,'psa'),
    ('re_development','T','appraisal','acq','Appraisal',15,'psa'),
    ('re_development','M','diligence_done','acq','Diligence contingency waived',0,'diligence,phase1,title'),
    ('re_development','M','land_close','acq','Land closing',0,'diligence_done+10'),
    ('re_development','P','ent',null,'Entitlements and design',null,null),
    ('re_development','T','concept','ent','Concept plan and yield study',15,'loi'),
    ('re_development','T','zoning','ent','Zoning / PUD application and hearings',45,'concept,psa'),
    ('re_development','M','zoning_ok','ent','Zoning approved',0,'zoning'),
    ('re_development','T','prelim_plat','ent','Preliminary plat',30,'zoning_ok'),
    ('re_development','T','civil','ent','Civil engineering',40,'prelim_plat:SS+10'),
    ('re_development','M','final_plat','ent','Final plat recorded',0,'civil,prelim_plat'),
    ('re_development','T','architecture','ent','Architectural design',45,'concept'),
    ('re_development','T','permits','ent','Building permits',20,'architecture,final_plat'),
    ('re_development','P','fin',null,'Financing',null,null),
    ('re_development','T','pro_forma','fin','Pro forma and budget lock',10,'architecture:SS+20'),
    ('re_development','T','equity','fin','Equity raise',40,'pro_forma'),
    ('re_development','T','underwriting','fin','Construction loan underwriting',30,'pro_forma,appraisal'),
    ('re_development','M','loan_close','fin','Construction loan closed',0,'underwriting,equity,land_close'),
    ('re_development','P','build',null,'Construction',null,null),
    ('re_development','M','ntp','build','Notice to proceed',0,'loan_close,permits'),
    ('re_development','T','horizontal','build','Horizontal improvements (roads and utilities)',60,'ntp'),
    ('re_development','T','vertical','build','Vertical construction',140,'horizontal:SS+40'),
    ('re_development','M','first_co','build','First certificate of occupancy',0,'vertical:SS+90'),
    ('re_development','M','final_co','build','Final certificates of occupancy',0,'vertical'),
    ('re_development','P','sell',null,'Sales and lease-up',null,null),
    ('re_development','T','marketing','sell','Marketing and presales',60,'vertical:SS+20'),
    ('re_development','T','closings','sell','Unit closings / lease-up',90,'first_co,marketing:SS+30'),
    ('re_development','M','stabilized','sell','Sold out / stabilized',0,'closings,final_co'),
    ('re_development','T','payoff','sell','Loan payoff and investor distributions',15,'stabilized'),

    -- trade rough-in and trim (11)
    ('trade_rough_trim','P','pre',null,'Preparation',null,null),
    ('trade_rough_trim','M','award','pre','Subcontract awarded',0,''),
    ('trade_rough_trim','T','submittals','pre','Submittals',5,'award'),
    ('trade_rough_trim','T','material','pre','Order material',7,'submittals'),
    ('trade_rough_trim','P','rough',null,'Rough-in',null,null),
    ('trade_rough_trim','T','mobilize','rough','Mobilize',1,'material'),
    ('trade_rough_trim','T','rough_in','rough','Rough-in',5,'mobilize'),
    ('trade_rough_trim','T','rough_insp','rough','Rough inspection',1,'rough_in'),
    ('trade_rough_trim','P','trim',null,'Trim-out',null,null),
    ('trade_rough_trim','T','gc_close','trim','GC close-up (drywall and paint)',15,'rough_insp'),
    ('trade_rough_trim','T','trim_out','trim','Trim-out',3,'gc_close'),
    ('trade_rough_trim','T','startup','trim','Start-up and test',1,'trim_out'),
    ('trade_rough_trim','T','final_insp','trim','Final inspection',1,'startup'),
    ('trade_rough_trim','M','done','trim','Scope complete',0,'final_insp'),

    -- full-service design project (11)
    ('design_project','P','design',null,'Design',null,null),
    ('design_project','T','discovery','design','Discovery and measure',3,''),
    ('design_project','T','concept','design','Concept and mood boards',10,'discovery'),
    ('design_project','T','development','design','Design development',15,'concept'),
    ('design_project','M','approval','design','Client approval',0,'development'),
    ('design_project','P','proc',null,'Procurement',null,null),
    ('design_project','T','specs','proc','Specifications and proposals',5,'approval'),
    ('design_project','T','orders','proc','Place orders and deposits',3,'specs'),
    ('design_project','T','lead','proc','Vendor lead times',40,'orders'),
    ('design_project','T','receiving','proc','Receiving and inspection',5,'lead:FF+2'),
    ('design_project','P','inst',null,'Installation',null,null),
    ('design_project','T','install','inst','Install day',2,'receiving'),
    ('design_project','T','styling','inst','Styling',1,'install'),
    ('design_project','M','reveal','inst','Reveal',0,'styling'),

    -- engagement phases (7)
    ('engagement_phases','P','disc',null,'Discovery',null,null),
    ('engagement_phases','M','kickoff','disc','Kickoff',0,''),
    ('engagement_phases','T','discovery','disc','Discovery interviews',5,'kickoff'),
    ('engagement_phases','P','work',null,'Analysis',null,null),
    ('engagement_phases','T','analysis','work','Analysis',10,'discovery:SS+3'),
    ('engagement_phases','T','recommend','work','Recommendations draft',5,'analysis'),
    ('engagement_phases','P','deliver',null,'Delivery',null,null),
    ('engagement_phases','M','review','deliver','Client review',0,'recommend+3'),
    ('engagement_phases','T','final_delivery','deliver','Final delivery',2,'review'),
    ('engagement_phases','T','closeout','deliver','Closeout and invoice',1,'final_delivery'),

    -- PDI and delivery (6)
    ('pdi_delivery','P','shop',null,'Shop',null,null),
    ('pdi_delivery','M','received','shop','Unit received',0,''),
    ('pdi_delivery','T','pdi','shop','Pre-delivery inspection',1,'received'),
    ('pdi_delivery','T','accessories','shop','Install accessories and attachments',2,'pdi'),
    ('pdi_delivery','T','setup','shop','Set-up and test run',1,'accessories'),
    ('pdi_delivery','P','deliver',null,'Delivery',null,null),
    ('pdi_delivery','T','walkthrough','deliver','Customer walkthrough',1,'setup'),
    ('pdi_delivery','M','delivered','deliver','Delivered',0,'walkthrough+1'),

    -- simple project (6)
    ('simple_project','P','plan',null,'Plan',null,null),
    ('simple_project','M','kickoff','plan','Kickoff',0,''),
    ('simple_project','T','planning','plan','Planning and approvals',3,'kickoff'),
    ('simple_project','T','procure','plan','Procure materials',5,'planning'),
    ('simple_project','P','do',null,'Execute',null,null),
    ('simple_project','T','work','do','Do the work',10,'planning,procure:SS+3'),
    ('simple_project','P','close',null,'Close',null,null),
    ('simple_project','T','punch','close','Punch and closeout',2,'work'),
    ('simple_project','M','complete','close','Complete',0,'punch');

  -- every predecessor token must parse
  select string_agg(r.tpl || '.' || r.ref || ' ← ' || tok, ', ') into v_bad
    from _tpl_rows r cross join lateral regexp_split_to_table(coalesce(r.deps, ''), '\s*,\s*') tok
   where tok <> '' and tok !~ '^[a-z0-9_]+(:(FS|SS|FF|SF))?([+-][0-9]+)?$';
  if v_bad is not null then raise exception 'PM_TEMPLATE_SEED: bad predecessor tokens: %', v_bad; end if;

  insert into pm.schedule_template_catalog as c (key, pack_key, name, description, job_type_keys, body)
  select h.key, h.pack_key, h.name, h.description, h.job_type_keys,
         jsonb_build_object('items', (
           select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'ref', r.ref,
                    'kind', case r.kind when 'P' then 'phase' when 'M' then 'milestone' else 'task' end,
                    'parent', r.parent,
                    'name', r.name,
                    'duration', case r.kind when 'P' then null when 'M' then 0 else r.dur end,
                    'deps', case when r.kind = 'P' then null else (
                      select coalesce(jsonb_agg(jsonb_build_object('ref', m[1], 'type', coalesce(m[2], 'FS'), 'lag', coalesce(m[3]::int, 0)) order by o), '[]'::jsonb)
                        from regexp_split_to_table(coalesce(r.deps, ''), '\s*,\s*') with ordinality as tk(tok, o)
                        cross join lateral regexp_match(tk.tok, '^([a-z0-9_]+)(?::(FS|SS|FF|SF))?([+-][0-9]+)?$') as m
                       where tk.tok <> '') end)) order by r.ord)
             from _tpl_rows r where r.tpl = h.key))
    from _tpl_head h
  on conflict (key) do update set pack_key = excluded.pack_key, name = excluded.name, description = excluded.description,
    job_type_keys = excluded.job_type_keys, body = excluded.body, updated_at = now(),
    version = c.version + case when c.body is distinct from excluded.body then 1 else 0 end;

  drop table _tpl_rows;
  drop table _tpl_head;
end $tpl$;

-- Company copies of the catalog for its installed packs (+ general). Idempotent; never overwrites.
create or replace function pm._seed_schedule_templates(p_org uuid, p_location uuid) returns int
language plpgsql security definer
set search_path = pm, core, public
as $$
declare n int;
begin
  insert into pm.schedule_templates (org_id, location_id, key, name, description, pack_key, job_type_keys, body, source, catalog_key)
  select p_org, p_location, c.key, c.name, c.description, c.pack_key, c.job_type_keys, c.body, 'PACK', c.key
    from pm.schedule_template_catalog c
   where c.pack_key = 'general'
      or c.pack_key in (select i.pack_key from pm.pack_installs i where i.org_id = p_org and i.location_id = p_location and i.status = 'ACTIVE')
  on conflict (org_id, location_id, key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pm.tg_pack_install_schedule_templates() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if new.status = 'ACTIVE' then perform pm._seed_schedule_templates(new.org_id, new.location_id); end if;
  return null;
end $$;
create or replace trigger trg_pack_install_schedule_templates after insert or update of status, pack_key on pm.pack_installs
  for each row execute function pm.tg_pack_install_schedule_templates();

do $$
declare r record;
begin
  for r in select distinct i.org_id, i.location_id from pm.pack_installs i where i.status = 'ACTIVE' loop
    perform pm._seed_schedule_templates(r.org_id, r.location_id);
  end loop;
end $$;

create or replace function pm.apply_schedule_template(p_job uuid, p_template text, p_start date) returns jsonb
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare
  v_org uuid; v_loc uuid; v_key text; v_name text; v_body jsonb; v_base int; v_has boolean; v_map jsonb;
  v_created int; v_links int; v_run jsonb; v_id uuid;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or (public.get_org_id() is not null and v_org <> public.get_org_id()) then
    raise exception 'PM_FORBIDDEN: job % is not in the caller''s organization', p_job using errcode = '42501';
  end if;
  v_id := pm.access_try_uuid(p_template);
  if v_id is not null then
    select st.key, st.name, st.body into v_key, v_name, v_body from pm.schedule_templates st
     where st.id = v_id and st.org_id = v_org and st.location_id = v_loc;
  else
    select st.key, st.name, st.body into v_key, v_name, v_body from pm.schedule_templates st
     where st.org_id = v_org and st.location_id = v_loc and st.key = p_template and st.is_active;
    if v_body is null then
      select c.key, c.name, c.body into v_key, v_name, v_body from pm.schedule_template_catalog c where c.key = p_template;
    end if;
  end if;
  if v_body is null then
    raise exception 'PM_NOT_FOUND: schedule template % is not available for this job''s company', p_template using errcode = 'P0002';
  end if;
  perform pm._template_validate(v_body);

  perform pm._schedule_lock(p_job);
  if exists (select 1 from pm.tasks t where t.org_id = v_org and t.job_id = p_job and t.template_ref like v_key || ':%') then
    raise exception 'PM_SCHEDULE_TEMPLATE_APPLIED: the % template is already on this job', v_name using errcode = '23505';
  end if;
  select coalesce(max(t.sort) + 1, 0), count(*) > 0 into v_base, v_has from pm.tasks t where t.org_id = v_org and t.job_id = p_job;
  if not v_has and p_start is not null then
    update pm.schedules sc set anchor_start = p_start where sc.job_id = p_job;
  end if;

  with recursive node as (
    select x.value ->> 'ref' as ref, x.value ->> 'parent' as parent, x.value ->> 'kind' as kind, x.value ->> 'name' as name,
           (x.value ->> 'duration')::numeric::int as dur, coalesce(x.value -> 'deps', '[]'::jsonb) as deps, x.o::int as o, gen_random_uuid() as id
      from jsonb_array_elements(v_body -> 'items') with ordinality as x(value, o)
  ), tree as (
    select n.ref, array[n.o] as path from node n where n.parent is null
    union all
    select n.ref, tr.path || n.o from node n join tree tr on n.parent = tr.ref
  ), ins as (
    insert into pm.tasks (id, org_id, job_id, parent_task_id, title, is_milestone, duration_days, sort, status,
                          constraint_type, constraint_date, template_ref, created_by)
    select n.id, v_org, p_job, p.id, n.name, n.kind = 'milestone',
           case n.kind when 'phase' then null when 'milestone' then 0 else n.dur end,
           v_base + (row_number() over (order by tr.path))::int - 1, 'TODO',
           case when v_has and p_start is not null and n.kind <> 'phase' and jsonb_array_length(n.deps) = 0 then 'SNET' else 'ASAP' end,
           case when v_has and p_start is not null and n.kind <> 'phase' and jsonb_array_length(n.deps) = 0 then p_start end,
           v_key || ':' || n.ref, pm.current_user_id()
      from node n join tree tr on tr.ref = n.ref left join node p on p.ref = n.parent
     order by tr.path
    returning id, template_ref
  )
  select jsonb_object_agg(substr(ins.template_ref, char_length(v_key) + 2), ins.id), count(*) into v_map, v_created from ins;

  insert into pm.task_deps (org_id, pred_id, succ_id, dep_type, lag_days)
  select v_org, (v_map ->> (d.value ->> 'ref'))::uuid, (v_map ->> (x.value ->> 'ref'))::uuid,
         coalesce(d.value ->> 'type', 'FS'), coalesce((d.value ->> 'lag')::numeric::int, 0)
    from jsonb_array_elements(v_body -> 'items') x
    cross join lateral jsonb_array_elements(coalesce(x.value -> 'deps', '[]'::jsonb)) d;
  get diagnostics v_links = row_count;

  v_run := pm._schedule_run(p_job);
  return jsonb_build_object('template_key', v_key, 'name', v_name, 'created', v_created, 'links', v_links,
                            'start_on', v_run -> 'start_on', 'finish_on', v_run -> 'finish_on', 'critical_count', v_run -> 'critical_count');
end $$;
comment on function pm.apply_schedule_template(uuid, text, date) is
  '1112 / spec §2: add a schedule template (pm.schedule_templates id, or a company / catalog key) to a job — phases, tasks, milestones and links — starting p_start; re-runs CPM.';

-- ----------------------------------------------------------------------------
-- 10. Views: all-jobs summary, baseline variance (invoker: RLS of the caller applies)
-- ----------------------------------------------------------------------------
drop view if exists pm.v_schedule_jobs;
create view pm.v_schedule_jobs with (security_invoker = on) as
with agg as (
  select t.job_id,
         min(t.start_on) filter (where not t.is_summary)                                              as start_on,
         max(t.due_on) filter (where not t.is_summary)                                                as finish_on,
         count(*) filter (where not t.is_summary)::int                                                as task_count,
         count(*) filter (where not t.is_summary and t.status <> 'DONE')::int                          as open_count,
         count(*) filter (where not t.is_summary and t.status = 'DONE')::int                           as done_count,
         count(*) filter (where not t.is_summary and t.status = 'IN_PROGRESS')::int                    as in_progress_count,
         count(*) filter (where not t.is_summary and t.is_critical)::int                               as critical_count,
         count(*) filter (where not t.is_summary and t.status <> 'DONE' and t.due_on < current_date)::int as late_count,
         count(*) filter (where t.is_milestone)::int                                                   as milestone_count,
         round(case when sum(greatest(coalesce(t.duration_days, 0), 0)) filter (where not t.is_summary) > 0
                    then sum(greatest(coalesce(t.duration_days, 0), 0) * coalesce(t.pct_complete, 0)) filter (where not t.is_summary)
                         / sum(greatest(coalesce(t.duration_days, 0), 0)) filter (where not t.is_summary)
                    else avg(coalesce(t.pct_complete, 0)) filter (where not t.is_summary) end, 4)       as pct_complete
    from pm.tasks t
   where t.status <> 'CANCELLED'
   group by t.job_id
)
select p.job_id, p.org_id, p.location_id, j.job_number, j.name as job_name, j.customer_name, p.stage_key,
       p.pm_user_id, p.super_user_id,
       s.calendar_id, s.anchor_start, s.status_date, s.cpm_at,
       a.start_on, a.finish_on,
       coalesce(a.task_count, 0) as task_count, coalesce(a.open_count, 0) as open_count, coalesce(a.done_count, 0) as done_count,
       coalesce(a.in_progress_count, 0) as in_progress_count, coalesce(a.critical_count, 0) as critical_count,
       coalesce(a.late_count, 0) as late_count, coalesce(a.milestone_count, 0) as milestone_count, a.pct_complete,
       nm.id as next_milestone_id, nm.title as next_milestone_title, nm.due_on as next_milestone_on,
       b.id as baseline_id, b.name as baseline_name, b.project_finish as baseline_finish,
       pm.cal_workdays_between(pm.schedule_calendar(p.job_id), b.project_finish, a.finish_on) as finish_variance_days
  from pm.projects p
  left join agg a on a.job_id = p.job_id
  left join pm.schedules s on s.job_id = p.job_id
  left join pm.v_core_jobs_masked j on j.id = p.job_id
  left join pm.schedule_baselines b on b.job_id = p.job_id and b.is_active
  left join lateral (
    select t.id, t.title, t.due_on from pm.tasks t
     where t.job_id = p.job_id and t.is_milestone and t.status not in ('DONE', 'CANCELLED')
     order by t.due_on nulls last, t.sort limit 1) nm on true
 where a.job_id is not null or s.job_id is not null;
comment on view pm.v_schedule_jobs is
  '1112 / spec §2: one row per job with a schedule — dates, task counts, critical / late counts, duration-weighted % complete, next milestone, active baseline finish and variance (working days). Invoker: the caller''s RLS applies.';

drop view if exists pm.v_schedule_variance;
create view pm.v_schedule_variance with (security_invoker = on) as
with cal as (
  select b.job_id, b.id as baseline_id, b.name as baseline_name, pm.schedule_calendar(b.job_id) as calendar_id
    from pm.schedule_baselines b where b.is_active
)
select t.job_id, c.baseline_id, c.baseline_name, t.id as task_id, t.title, t.wbs_code, t.sort, t.is_summary, t.is_milestone,
       bt.start_on as baseline_start, bt.due_on as baseline_finish, bt.duration_days as baseline_duration,
       t.start_on, t.due_on, t.duration_days,
       pm.cal_workdays_between(c.calendar_id, bt.start_on, t.start_on) as start_variance_days,
       pm.cal_workdays_between(c.calendar_id, bt.due_on, t.due_on) as finish_variance_days,
       t.duration_days - bt.duration_days as duration_variance_days,
       case when bt.task_id is null then 'new'
            when t.due_on is null or bt.due_on is null then 'not_scheduled'
            when t.due_on > bt.due_on then 'late'
            when t.due_on < bt.due_on then 'early'
            else 'on_track' end as variance_status
  from pm.tasks t
  join cal c on c.job_id = t.job_id
  left join pm.schedule_baseline_tasks bt on bt.baseline_id = c.baseline_id and bt.task_id = t.id
 where t.status <> 'CANCELLED';
comment on view pm.v_schedule_variance is
  '1112 / spec §2: every task vs the job''s active baseline — working-day start / finish variance (+ = later) and duration variance. Invoker.';

-- ----------------------------------------------------------------------------
-- 11. Look-ahead with constraint reasons; resource load
-- ----------------------------------------------------------------------------
create or replace function pm.schedule_lookahead(p_from date default current_date, p_days int default 21)
returns table (
  job_id uuid, job_number text, job_name text, location_id uuid, task_id uuid, wbs_code text, title text, sort int,
  start_on date, due_on date, duration_days int, status text, pct_complete numeric, is_critical boolean, total_float int,
  is_milestone boolean, crew_id uuid, crew_name text, vendor_id uuid, vendor_name text, assignee_employee_id uuid,
  trade text, constraints jsonb, constraint_count int, ready boolean)
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
declare v_from date := coalesce(p_from, current_date); v_to date; v_sub jsonb := '{}'::jsonb;
begin
  if p_days is not null and (p_days < 1 or p_days > 120) then
    raise exception 'PM_INVALID: the look-ahead window is 1 to 120 days' using errcode = '22023';
  end if;
  v_to := v_from + coalesce(p_days, 21) - 1;
  -- legacy submittal register (the only one): tasks name a row by ext._submittal_id
  if to_regclass('proj.submittals') is not null then
    execute $q$
      select coalesce(jsonb_object_agg(s.id::text, jsonb_build_object('number', s.number, 'title', s.title, 'status', s.status, 'job_id', s.job_id)), '{}'::jsonb)
        from proj.submittals s
       where (public.get_org_id() is null or s.org_id = public.get_org_id())
         and s.job_id in (select pm.my_job_ids())
         and s.id in (select pm.access_try_uuid(t.ext ->> '_submittal_id') from pm.tasks t
                       where t.ext ? '_submittal_id' and t.job_id in (select pm.my_job_ids())
                         and (public.get_org_id() is null or t.org_id = public.get_org_id()))
    $q$ into v_sub;
  end if;
  return query
  with tw as (
    select t.* from pm.tasks t
     where t.job_id in (select pm.my_job_ids())
       and (public.get_org_id() is null or t.org_id = public.get_org_id())
       and not t.is_summary and t.status not in ('DONE', 'CANCELLED')
       and t.start_on is not null and t.start_on <= v_to and coalesce(t.due_on, t.start_on) >= v_from
  )
  select t.job_id, j.job_number::text, j.name::text, j.location_id, t.id, t.wbs_code, t.title, t.sort,
         t.start_on, t.due_on, t.duration_days, t.status, t.pct_complete::numeric, t.is_critical, t.total_float, t.is_milestone,
         t.assigned_crew_id, c.name::text, t.assigned_vendor_id, coalesce(v.display_name, v.name)::text, t.assignee_employee_id,
         coalesce(c.name, v.display_name, v.name, cc.name, 'Unassigned')::text,
         r.reasons, jsonb_array_length(r.reasons), jsonb_array_length(r.reasons) = 0
    from tw t
    join core.jobs j on j.id = t.job_id
    left join pm.crews c on c.id = t.assigned_crew_id
    left join core.vendors v on v.id = t.assigned_vendor_id
    left join pm.cost_codes cc on cc.id = t.cost_code_id
    cross join lateral (
      select coalesce(jsonb_agg(z.reason order by z.o, z.label), '[]'::jsonb) as reasons from (
        select 1 as o, p.title as label,
               jsonb_build_object('kind', 'predecessor', 'label', 'Predecessor not done: ' || p.title, 'ref_id', p.id) as reason
          from pm.task_deps d join pm.tasks p on p.id = d.pred_id
         where d.org_id = t.org_id and d.succ_id = t.id and p.status <> 'CANCELLED'
           and ((d.dep_type in ('FS', 'FF') and p.status <> 'DONE')
             or (d.dep_type in ('SS', 'SF') and p.status in ('TODO', 'BLOCKED') and p.actual_start is null))
        union all
        select 2, cm.number,
               jsonb_build_object('kind', 'material',
                                  'label', case when cm.status = 'DRAFT' then 'PO ' || cm.number || ' is not approved'
                                                else 'Material not received: PO ' || cm.number end,
                                  'ref_id', cm.id)
          from pm.commitments cm
         where cm.org_id = t.org_id and cm.id = t.commitment_id and cm.commitment_type = 'PO'
           and (cm.status = 'DRAFT'
             or (cm.status in ('APPROVED', 'EXECUTED') and exists (
                   select 1 from pm.commitment_lines cl
                    where cl.org_id = cm.org_id and cl.commitment_id = cm.id
                      and ((cl.qty is not null and cl.qty > 0 and cl.received_qty < cl.qty)
                        or ((cl.qty is null or cl.qty = 0) and cl.received_cents < cl.amount_cents)))))
        union all
        select 3, pi.description,
               jsonb_build_object('kind', 'material',
                                  'label', 'Material not received: ' || pi.description || ' (' || lower(replace(pi.status, '_', ' '))
                                           || coalesce(', expected ' || to_char(pi.expected_on, 'YYYY-MM-DD'), '') || ')',
                                  'ref_id', pi.id)
          from pm.procurement_items pi
         where t.wbs_id is not null and pi.org_id = t.org_id and pi.job_id = t.job_id and pi.wbs_id = t.wbs_id
           and pi.status in ('SPECIFIED', 'PROPOSED', 'APPROVED', 'ORDERED', 'ACKNOWLEDGED', 'BACK_ORDERED', 'SHIPPED', 'DAMAGED')
        union all
        select 4, coalesce(v_sub -> (t.ext ->> '_submittal_id') ->> 'number', ''),
               jsonb_build_object('kind', 'submittal',
                                  'label', 'Submittal ' || coalesce(v_sub -> (t.ext ->> '_submittal_id') ->> 'number', '') || ' not approved ('
                                           || lower(replace(v_sub -> (t.ext ->> '_submittal_id') ->> 'status', '_', ' ')) || ')',
                                  'ref_id', t.ext ->> '_submittal_id')
         where t.ext ? '_submittal_id' and v_sub ? (t.ext ->> '_submittal_id')
           and (v_sub -> (t.ext ->> '_submittal_id') ->> 'job_id') = t.job_id::text
           and (v_sub -> (t.ext ->> '_submittal_id') ->> 'status') not in ('APPROVED', 'APPROVED_AS_NOTED')
        union all
        select 5, 'blocked', jsonb_build_object('kind', 'other', 'label', 'Marked blocked', 'ref_id', null)
         where t.status = 'BLOCKED'
        union all
        select 6, 'constraint', jsonb_build_object('kind', 'other', 'label', 'Its constraint date cannot be met', 'ref_id', null)
         where t.constraint_conflict
      ) z
    ) r
   order by 22, t.start_on, j.job_number, t.sort;
end $$;
comment on function pm.schedule_lookahead(date, int) is
  '1112 / spec §2: open tasks starting or active in [p_from, p_from + p_days), on the caller''s jobs, with trade and constraint reasons (predecessor / material / submittal / other).';

create or replace function pm.resource_load(p_from date, p_to date)
returns table (
  resource_kind text, resource_id uuid, resource_name text, day date, hours numeric, task_hours numeric, dispatch_hours numeric,
  capacity_hours numeric, task_count int, dispatch_count int, over_capacity boolean, job_ids uuid[], task_ids uuid[])
language plpgsql security definer
set search_path = pm, core, public
as $$
#variable_conflict use_column
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'PM_INVALID: give a range of 1 to 367 days (p_from ≤ p_to)' using errcode = '22023';
  end if;
  return query
  with mj as (
    select x as job_id from pm.my_job_ids() x
  ), days as (
    select gs::date as d from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ), tk as (
    select t.id, t.org_id, t.job_id, t.start_on, t.due_on, t.assigned_crew_id, t.assigned_vendor_id, t.assignee_employee_id, t.hours_per_day
      from pm.tasks t
     where t.job_id in (select mj.job_id from mj)
       and (public.get_org_id() is null or t.org_id = public.get_org_id())
       and not t.is_summary and not t.is_milestone and t.status not in ('DONE', 'CANCELLED')
       and t.start_on is not null and t.due_on is not null and t.start_on <= p_to and t.due_on >= p_from
       and (t.assigned_crew_id is not null or t.assigned_vendor_id is not null or t.assignee_employee_id is not null)
  ), jcal as (
    select jc.job_id, jc.cal, coalesce(c.workdays, '{1,2,3,4,5}'::smallint[]) as wd, coalesce(c.hours_per_day, 8)::numeric as hpd
      from (select q.job_id, pm.schedule_calendar(q.job_id) as cal from (select distinct tk.job_id from tk) q) jc
      left join pm.work_calendars c on c.id = jc.cal
  ), tday as (
    select tk.*, dd.d, coalesce(tk.hours_per_day, jcal.hpd)::numeric as hrs
      from tk join jcal on jcal.job_id = tk.job_id
      join days dd on dd.d between tk.start_on and tk.due_on
      left join pm.work_calendar_days x on x.calendar_id = jcal.cal and x.day = dd.d
     where coalesce(x.is_workday, extract(isodow from dd.d)::smallint = any (jcal.wd))
  ), disp as (
    select da.id, da.job_id, da.crew_id, da.employee_id, dd.d,
           (extract(epoch from (least(upper(da.slot), (dd.d + 1)::timestamptz) - greatest(lower(da.slot), dd.d::timestamptz))) / 3600.0)::numeric as hrs
      from pm.dispatch_assignments da
      join days dd on da.slot && tstzrange(dd.d::timestamptz, (dd.d + 1)::timestamptz)
     where da.job_id in (select mj.job_id from mj)
       and (public.get_org_id() is null or da.org_id = public.get_org_id())
       and da.status <> 'CANCELLED'
  ), u as (
    select 'crew'::text as kind, tday.assigned_crew_id as rid, tday.d, tday.hrs as th, 0::numeric as dh, tday.id as task_id, null::uuid as disp_id, tday.job_id
      from tday where tday.assigned_crew_id is not null
    union all
    select 'vendor', tday.assigned_vendor_id, tday.d, tday.hrs, 0, tday.id, null, tday.job_id
      from tday where tday.assigned_crew_id is null and tday.assigned_vendor_id is not null
    union all
    select 'employee', tday.assignee_employee_id, tday.d, tday.hrs, 0, tday.id, null, tday.job_id
      from tday where tday.assignee_employee_id is not null
    union all
    select 'crew', disp.crew_id, disp.d, 0, disp.hrs, null, disp.id, disp.job_id from disp where disp.crew_id is not null and disp.hrs > 0
    union all
    select 'employee', disp.employee_id, disp.d, 0, disp.hrs, null, disp.id, disp.job_id from disp where disp.employee_id is not null and disp.hrs > 0
  ), agg as (
    select u.kind, u.rid, u.d, sum(u.th) as th, sum(u.dh) as dh,
           count(distinct u.task_id)::int as tc, count(distinct u.disp_id)::int as dc,
           array_agg(distinct u.job_id) as jobs, array_remove(array_agg(distinct u.task_id), null) as tasks
      from u group by u.kind, u.rid, u.d
  )
  select a.kind, a.rid,
         coalesce(cr.name, coalesce(ve.display_name, ve.name), nullif(btrim(concat_ws(' ', em.first_name, em.last_name)), ''), 'Unnamed')::text,
         a.d, round(a.th + a.dh, 2), round(a.th, 2), round(a.dh, 2),
         case a.kind when 'crew' then round(coalesce(cr.capacity_minutes_per_day, 480) / 60.0, 2) when 'employee' then 8::numeric end,
         a.tc, a.dc,
         case a.kind when 'crew' then a.th + a.dh > coalesce(cr.capacity_minutes_per_day, 480) / 60.0
                     when 'employee' then a.th + a.dh > 8 else false end,
         a.jobs, a.tasks
    from agg a
    left join pm.crews cr on a.kind = 'crew' and cr.id = a.rid
    left join core.vendors ve on a.kind = 'vendor' and ve.id = a.rid
    left join core.employees em on a.kind = 'employee' and em.id = a.rid
   order by a.kind, 3, a.d;
end $$;
comment on function pm.resource_load(date, date) is
  '1112 / spec §2: crew / vendor / employee × working day hours from open scheduled tasks on the caller''s jobs plus dispatch slots, with capacity.';

-- ----------------------------------------------------------------------------
-- 12. Schedule header edits re-run CPM (calendar, project start, status date)
-- ----------------------------------------------------------------------------
create or replace function pm.tg_schedule_header_cpm() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
begin
  if coalesce(current_setting('pm.schedule_writing', true), '') = 'on' then return null; end if;
  if tg_op = 'INSERT' or new.calendar_id is distinct from old.calendar_id or new.anchor_start is distinct from old.anchor_start
     or new.status_date is distinct from old.status_date then
    perform pm._schedule_run(new.job_id);
  end if;
  return null;
end $$;
create or replace trigger trg_schedule_header_cpm after insert or update of calendar_id, anchor_start, status_date on pm.schedules
  for each row execute function pm.tg_schedule_header_cpm();

-- ----------------------------------------------------------------------------
-- 13. 1110 registries: classes, RPC guards
-- ----------------------------------------------------------------------------
insert into pm.access_table_classes as t
  (table_name, class, scope, read_caps, write_cap, parent_table, parent_column, read_extra, write_extra, insert_without_money, note)
values
  ('work_calendars',            'S','location', '{}',              'projects.settings', null, null, null, null, false, '1112: working calendars (company, or org-wide when location_id is null)'),
  ('work_calendar_days',        'S','parent',   '{}',              'projects.settings', 'work_calendars', 'calendar_id', null, null, false, '1112: calendar holidays / extra working days'),
  ('schedules',                 'J','job',      '{projects.jobs}', 'projects.jobs',     null, null, null, null, false, '1112: schedule header; CPM results written by pm.schedule_cpm'),
  ('schedule_baselines',        'J','job',      '{projects.jobs}', null,                null, null, null, null, false, '1112: written only by pm.set_schedule_baseline'),
  ('schedule_baseline_tasks',   'J','job',      '{projects.jobs}', null,                null, null, null, null, false, '1112: written only by pm.set_schedule_baseline'),
  ('schedule_template_catalog', 'S','org',      '{}',              null,                null, null, null, null, false, '1112: global catalog (no org_id); service_role writes'),
  ('schedule_templates',        'S','location', '{}',              'projects.settings', null, null, null, null, false, '1112: company schedule templates')
on conflict (table_name) do update set
  class = excluded.class, scope = excluded.scope, read_caps = excluded.read_caps, write_cap = excluded.write_cap,
  parent_table = excluded.parent_table, parent_column = excluded.parent_column, read_extra = excluded.read_extra,
  write_extra = excluded.write_extra, insert_without_money = excluded.insert_without_money, note = excluded.note;

insert into pm.access_rpc_guards as g (function_name, args, guard_sql, note) values
  ('schedule_cpm',            '{p_job}',  'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1112'),
  ('reschedule_task',         '{p_task}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_task);', '1112'),
  ('preview_reschedule',      '{p_task}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_task);', '1112: computes an edit (rolled back) — same right as the edit (security review L3)'),
  ('set_task_links',          '{p_task}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_task);', '1112'),
  ('indent_task',             '{p_task}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_task);', '1112'),
  ('move_task_order',         '{p_task}', 'perform pm.access_assert_row(''projects.jobs'', array[''edit''], ''tasks'', p_task);', '1112'),
  ('set_schedule_baseline',   '{p_job}',  'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1112'),
  ('apply_schedule_template', '{p_job}',  'perform pm.access_assert_job(''projects.jobs'', array[''edit''], p_job);', '1112'),
  ('schedule_lookahead',      '{}',       'if not pm.can_any(array[''projects.jobs'', ''projects.jobs_all'']::text[], ''view'') then perform pm.access_forbid(''requires projects.jobs:view''); end if;', '1112: rows are the caller''s jobs only'),
  ('resource_load',           '{}',       'if not pm.can_any(array[''projects.jobs'', ''projects.jobs_all'']::text[], ''view'') then perform pm.access_forbid(''requires projects.jobs:view''); end if;', '1112: rows are the caller''s jobs only')
on conflict (function_name) do update set args = excluded.args, guard_sql = excluded.guard_sql, note = excluded.note;

-- ----------------------------------------------------------------------------
-- 14. RLS (org isolation, permissive) + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['work_calendars','work_calendar_days','schedules','schedule_baselines','schedule_baseline_tasks','schedule_templates'] loop
    execute format('alter table pm.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = t and policyname = 'org_isolation') then
      execute format('create policy org_isolation on pm.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
  end loop;
  alter table pm.schedule_template_catalog enable row level security;
  if not exists (select 1 from pg_policies where schemaname = 'pm' and tablename = 'schedule_template_catalog' and policyname = 'catalog_read') then
    create policy catalog_read on pm.schedule_template_catalog for select using (true);
  end if;
end $$;

revoke all on pm.work_calendars, pm.work_calendar_days, pm.schedules, pm.schedule_baselines, pm.schedule_baseline_tasks,
              pm.schedule_template_catalog, pm.schedule_templates from public, anon, authenticated;
grant select, insert, update, delete on pm.work_calendars, pm.work_calendar_days, pm.schedules, pm.schedule_baselines,
              pm.schedule_baseline_tasks, pm.schedule_template_catalog, pm.schedule_templates to service_role;
grant select, insert, update, delete on pm.work_calendars, pm.work_calendar_days to authenticated;
grant select on pm.schedules, pm.schedule_baselines, pm.schedule_baseline_tasks, pm.schedule_template_catalog to authenticated;
grant insert (job_id, calendar_id, anchor_start, status_date) on pm.schedules to authenticated;
grant update (calendar_id, anchor_start, status_date) on pm.schedules to authenticated;
grant select, delete on pm.schedule_templates to authenticated;
grant insert (location_id, key, name, description, pack_key, job_type_keys, body, is_active) on pm.schedule_templates to authenticated;
grant update (name, description, job_type_keys, body, is_active) on pm.schedule_templates to authenticated;
grant select on pm.v_schedule_jobs, pm.v_schedule_variance to authenticated, service_role;

-- pm.tasks: members keep UPDATE on every column but the identity and the engine's outputs
do $$
declare v_cols text;
begin
  select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'pm' and c.table_name = 'tasks'
     and c.column_name not in ('id', 'org_id', 'created_at', 'early_start', 'early_finish', 'late_start', 'late_finish',
                               'total_float', 'free_float', 'is_critical', 'is_summary', 'constraint_conflict', 'cpm_at',
                               'template_ref', 'wbs_code');
  execute 'revoke update on table pm.tasks from authenticated';
  execute format('grant update (%s) on table pm.tasks to authenticated', v_cols);
end $$;

-- Policies (every classified table), masked views (pm.v_tasks_masked gains the new columns),
-- RPC guards (injected into the 1112 RPC bodies).
select pm.access_apply_policies();
select pm.access_apply_masks();
select pm.access_apply_rpc_guards();

-- ----------------------------------------------------------------------------
-- 15. Security review hardening (2026-10-24)
-- ----------------------------------------------------------------------------
-- M1: an org-wide calendar (location_id null) drives every company's schedules, so writing it (or its
--     days) needs projects.settings:configure at EVERY company of the org, or an owner / admin seat.
--     Extra RESTRICTIVE policies (AND-ed with the 1110 class policies; 1110 only replaces pm_access_*).
create or replace function pm.schedule_org_settings_ok() returns boolean
language sql stable security definer
set search_path = pm, core, public
as $$
  select pm.access_is_service()
      or exists (select 1 from core.memberships ms
                  where ms.id = core.client_scope_caller_membership() and ms.status = 'active'
                    and ms.audience = 'internal_staff'
                    and core.rbac_normalize_legacy_role(ms.role) = 'company_admin')
      or (exists (select 1 from core.locations l where l.org_id = public.get_org_id())
          and not exists (select 1 from core.locations l
                           where l.org_id = public.get_org_id()
                             and not pm.can('projects.settings', 'configure', l.id)))
$$;
comment on function pm.schedule_org_settings_ok() is
  '1112 (security review M1): may the caller change org-wide schedule settings — an owner / admin seat, or projects.settings:configure at every company of the org?';
insert into pm.access_rpc_allowlist as a (function_name, reason) values
  ('schedule_org_settings_ok', 'describes the caller''s own grants (org-wide calendar policies)')
on conflict (function_name) do update set reason = excluded.reason;

do $$
begin
  drop policy if exists pm_sched_orgcal_insert on pm.work_calendars;
  drop policy if exists pm_sched_orgcal_update on pm.work_calendars;
  drop policy if exists pm_sched_orgcal_delete on pm.work_calendars;
  create policy pm_sched_orgcal_insert on pm.work_calendars as restrictive for insert to authenticated
    with check (location_id is not null or (select pm.schedule_org_settings_ok()));
  create policy pm_sched_orgcal_update on pm.work_calendars as restrictive for update to authenticated
    using (location_id is not null or (select pm.schedule_org_settings_ok()))
    with check (location_id is not null or (select pm.schedule_org_settings_ok()));
  create policy pm_sched_orgcal_delete on pm.work_calendars as restrictive for delete to authenticated
    using (location_id is not null or (select pm.schedule_org_settings_ok()));
  drop policy if exists pm_sched_orgcal_insert on pm.work_calendar_days;
  drop policy if exists pm_sched_orgcal_update on pm.work_calendar_days;
  drop policy if exists pm_sched_orgcal_delete on pm.work_calendar_days;
  create policy pm_sched_orgcal_insert on pm.work_calendar_days as restrictive for insert to authenticated
    with check ((select pm.schedule_org_settings_ok())
                or calendar_id in (select c.id from pm.work_calendars c where c.org_id = public.get_org_id() and c.location_id is not null));
  create policy pm_sched_orgcal_update on pm.work_calendar_days as restrictive for update to authenticated
    using ((select pm.schedule_org_settings_ok())
           or calendar_id in (select c.id from pm.work_calendars c where c.org_id = public.get_org_id() and c.location_id is not null))
    with check ((select pm.schedule_org_settings_ok())
                or calendar_id in (select c.id from pm.work_calendars c where c.org_id = public.get_org_id() and c.location_id is not null));
  create policy pm_sched_orgcal_delete on pm.work_calendar_days as restrictive for delete to authenticated
    using ((select pm.schedule_org_settings_ok())
           or calendar_id in (select c.id from pm.work_calendars c where c.org_id = public.get_org_id() and c.location_id is not null));
end $$;

-- M1 (cont.): a job's schedule uses its own company's calendar or an org-wide one — never another
-- company's (whose settings holders could then move this job).
create or replace function pm.tg_schedule_header_check() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare v_cal_loc uuid; v_cal_org uuid; v_job_loc uuid;
begin
  if new.calendar_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.calendar_id is not distinct from old.calendar_id then return new; end if;
  select c.location_id, c.org_id into v_cal_loc, v_cal_org from pm.work_calendars c where c.id = new.calendar_id;
  select j.location_id into v_job_loc from core.jobs j where j.id = new.job_id and j.org_id = new.org_id;
  if v_cal_org is distinct from new.org_id or (v_cal_loc is not null and v_cal_loc is distinct from v_job_loc) then
    raise exception 'PM_INVALID: a job uses its own company''s calendar or an org-wide one' using errcode = '23514';
  end if;
  return new;
end $$;
create or replace trigger trg_schedule_header_check before insert or update of calendar_id on pm.schedules
  for each row execute function pm.tg_schedule_header_check();

-- M2: date bounds on the header and calendar days (the tasks' are in section 4).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'pm.schedules'::regclass and conname = 'schedules_dates_range_check') then
    alter table pm.schedules add constraint schedules_dates_range_check
      check (    (anchor_start is null or anchor_start between '1900-01-01' and '2200-12-31')
             and (status_date  is null or status_date  between '1900-01-01' and '2200-12-31'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'pm.work_calendar_days'::regclass and conname = 'work_calendar_days_range_check') then
    alter table pm.work_calendar_days add constraint work_calendar_days_range_check check (day between '1900-01-01' and '2200-12-31');
  end if;
end $$;

-- M2: at most 10,000 tasks on a job (checked once per insert statement).
create or replace function pm.tg_task_job_cap() returns trigger
language plpgsql security definer
set search_path = pm, core, public
as $$
declare r record;
begin
  for r in select x.org_id, x.job_id, count(*) as added from nt x group by 1, 2 loop
    if (select count(*) from pm.tasks t where t.org_id = r.org_id and t.job_id = r.job_id) > 10000 then
      raise exception 'PM_SCHEDULE_TOO_LARGE: a schedule holds at most 10,000 tasks' using errcode = '54000';
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists trg_task_job_cap on pm.tasks;
create trigger trg_task_job_cap after insert on pm.tasks
  referencing new table as nt for each statement execute function pm.tg_task_job_cap();

-- Milestone billing value: members change tasks.billing_amount_cents / billing_pct only with
-- projects.contract_value on the job (the value they could not even read otherwise). Definer RPCs
-- (current_user = owner) and service_role are not affected.
create or replace function pm.tg_task_billing_guard() returns trigger
language plpgsql
set search_path = pm, core, public
as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if (tg_op = 'INSERT' and (new.billing_amount_cents is not null or new.billing_pct is not null))
     or (tg_op = 'UPDATE' and (new.billing_amount_cents is distinct from old.billing_amount_cents
                               or new.billing_pct is distinct from old.billing_pct)) then
    if not exists (select 1 from pm.my_money_job_ids('projects.contract_value') x where x = new.job_id) then
      raise exception 'PM_FORBIDDEN: changing a task''s billing value requires projects.contract_value on this job' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create or replace trigger trg_task_billing_guard before insert or update of billing_amount_cents, billing_pct on pm.tasks
  for each row execute function pm.tg_task_billing_guard();

-- Function grants: nothing for PUBLIC / anon; members get the RPC surface and the invoker helpers.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'pm' and p.proname in (
              'cal_is_workday','cal_workdays','cal_count','cal_workdays_between','cal_add_workdays','schedule_calendar',
              'tg_task_schedule_defaults','tg_task_hierarchy','tg_task_progress','tg_task_commitment','tg_task_dep_guard','tg_task_dep_cycle',
              '_dep_has_cycle','_dep_path','_schedule_lock','_schedule_run','_schedule_snapshot','_schedule_finish','_schedule_diff',
              '_schedule_renumber','_reschedule_apply','_reschedule','_template_validate','tg_schedule_template_validate',
              '_seed_schedule_templates','tg_pack_install_schedule_templates','tg_schedule_header_cpm',
              'schedule_cpm','reschedule_task','preview_reschedule','set_task_links','indent_task','move_task_order',
              'set_schedule_baseline','apply_schedule_template','schedule_lookahead','resource_load',
              'schedule_org_settings_ok','tg_schedule_header_check','tg_task_job_cap','tg_task_billing_guard') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname in ('cal_is_workday','cal_workdays','cal_count','cal_workdays_between','cal_add_workdays','schedule_calendar',
                     'schedule_cpm','reschedule_task','preview_reschedule','set_task_links','indent_task','move_task_order',
                     'set_schedule_baseline','apply_schedule_template','schedule_lookahead','resource_load',
                     'schedule_org_settings_ok') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- end 1112_pm_schedule
-- ============================================================================
