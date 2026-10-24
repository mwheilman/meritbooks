# Merit Projects — Wave 1 schedule spec: Gantt, critical path, look-ahead, crew board

Status: approved scope (expert-panel spec §4.4 and §8.3; owner: "the schedule doesn't have gantt charts").

## 1. Acceptance

1. A job's Schedule tab opens on a real Gantt for commercial_gc, home_builder, residential_remodel,
   real_estate_development (and specialty_trade/professional_services/manufacturing job level).
2. Left grid edits like a spreadsheet: WBS number, name, duration (working days), start, finish, % complete,
   assignee/crew, predecessors typed as `12FS+2d` (several, comma-separated). Tab indents (makes a phase/summary),
   Shift-Tab outdents, Enter adds a row below.
3. Bars: drag middle to move, drag right edge to change duration, drag from an end dot to another bar to link.
   While dragging, ghost bars show where successors land and the new finish date; on release a 10 s undo toast
   says "Moved 9 tasks; finish +3 days". Double-click opens the task side panel.
4. Critical path toggle (critical bars and links highlighted; float shown on hover). Baseline toggle (ghost bars
   from the active baseline; variance in days). Milestones as diamonds. Today line. Weekend/holiday shading from the
   job's work calendar. Zoom day/week/month, remembered per user.
5. Circular links are refused with a message naming the loop.
6. Tablet: long-press to drag, two-finger pan; supervisors update % complete and actual dates and push tasks.
7. 2,000 tasks render under 1 s and drag at 60 fps (virtualized rows, canvas or SVG with windowing).
8. Print/PDF: 11×17 landscape, fit to N weeks, legend.
9. Global Schedule page: all jobs stacked (summary bars per job, expand to tasks), filters by PM/company/stage,
   plus the 3-week look-ahead view (tasks starting or active in the window, grouped by trade/crew, with constraints:
   submittal not approved, material not received, predecessor not done) and the crew board (crews × days).
10. Permissions: schedule edits need projects.jobs:edit on the job; Labor sees the schedule read-only for own jobs;
    task billing amounts stay masked (pm.v_tasks_masked).
11. Import/export: MS Project XML and Primavera P6 XER import + export (Next if time runs out; CSV export at Launch).

## 2. Engine (migration 1112_pm_schedule.sql) — fixed contract

- Working calendars: `pm.work_calendars`, `pm.work_calendar_days`; `pm.schedule_calendar(job)` resolves job →
  company → org default (Mon–Fri, 8 h).
- `pm.schedules` (one per job: calendar_id, anchor_start, status_date, cpm_at, finish_on, critical_count).
- `pm.tasks` additive columns: constraint_type (ASAP|SNET|FNLT|MSO), constraint_date, actual_start, actual_finish,
  assigned_crew_id, assigned_vendor_id, commitment_id, hours_per_day, early_start, early_finish, late_start,
  late_finish, total_float, free_float, is_critical, is_summary, constraint_conflict, cpm_at, template_ref, wbs_code.
  `duration_days` = working days.
- `pm.task_deps` guard: same job, lag bounds (−365..365), cycle check that names the loop (`PM_DEP_CYCLE: A → B → A`).
- `pm.schedule_cpm(p_job uuid) returns setof pm.tasks` — forward/backward pass, FS/SS/FF/SF + lag, constraints,
  actuals pin dates, working calendars, summary roll-up; writes results; idempotent.
- `pm.reschedule_task(p_task uuid, p_new_start date, p_new_duration int) returns jsonb` — moves/resizes, re-runs CPM,
  returns `{changed:[{id,start_on,due_on,early_start,...}], finish_before, finish_after, moved_count}`.
- `pm.preview_reschedule(p_task, p_new_start, p_new_duration) returns jsonb` — same result without writing (for ghost
  bars when the client can't compute locally).
- `pm.set_task_links(p_task uuid, p_links jsonb)` — replace a task's predecessors from parsed `12FS+2d` input.
- `pm.indent_task(p_task, p_direction 'in'|'out')`, `pm.move_task_order(p_task, p_after_task)`.
- Baselines: `pm.schedule_baselines`, `pm.schedule_baseline_tasks`, `pm.set_schedule_baseline(p_job, p_name)`,
  `pm.v_schedule_variance`.
- Templates: `pm.schedule_template_catalog` (global per pack) → `pm.schedule_templates` (per company),
  `pm.apply_schedule_template(p_job, p_template, p_start)`; seed realistic templates per pack (remodel kitchen/bath,
  custom home ~120 tasks, commercial TI, HVAC install, ETO cabinet job, flooring install, RE development milestones).
- Views/functions: `pm.v_schedule_jobs` (summary per job), `pm.schedule_lookahead(p_from date, p_days int)` with
  constraint reasons, `pm.resource_load(p_from, p_to)` (crew/vendor × day hours).
- Every new table classified per 1110 (J job-scoped; templates S); every definer function org-guarded + pm.can-checked
  (projects.jobs:edit for writes, view for reads) and registered for the 1110 guard test.

The client may also compute CPM locally (same algorithm, `apps/projects/src/lib/pm/schedule/cpm.ts`, unit-tested
against the SQL engine on shared fixtures) for instant ghost bars; the server result is authoritative.
