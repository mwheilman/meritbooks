-- =============================================================================
-- Migration 189: department budgets — versions, department plans, owners, templates,
-- comments, lifecycle locks, and the published-budget mirror (Wave 4B).
-- =============================================================================
-- Audit rows FP-06 (versions + approval), FP-07 (templates), FP-08 (department budgets:
-- owners, submit / review / approve), FP-21 (budget collaboration) —
-- docs/audit-2026-10/FEATURE-GAP-AUDIT.md §6.3 Wave 4B; docs/FPB-reports-fpna.md §4.11.
--
-- §1  public.budget_plan_versions      one version of a company's fiscal-year plan
--                                       (BUDGET | REFORECAST), DRAFT → IN_REVIEW → APPROVED →
--                                       LOCKED (+ SUPERSEDED). At most ONE current BUDGET version
--                                       per company × FY. Approver ≠ submitter (CHECK).
-- §2  public.budget_version_lines      company × department (NULL = company level) × account ×
--                                       month, bigint cents. Lines of a non-DRAFT version, or of a
--                                       SUBMITTED / APPROVED department plan, are refused (trigger).
-- §3  public.budget_line_drivers       how a line was built (method + params), same lock.
-- §4  public.budget_department_plans   the unit a person owns: department, owner, template,
--                                       status NOT_STARTED → DRAFT → SUBMITTED → APPROVED
--                                       (or RETURNED with a note). Approver ≠ submitter (CHECK).
-- §5  public.budget_department_owners  standing owner per department (carried into new versions).
-- §6  public.budget_templates          tenant templates; immutable rows, edit = new version.
-- §7  public.budget_comments           threaded line comments, justification requests and
--                                       variance explanations (reviewer ≠ author, CHECK).
-- §8  public.budget_events             append-only audit of transitions / imports / generation.
-- §9  public.budgets (013)             becomes the PUBLISHED budget of record: + version_id,
--                                       NULLS NOT DISTINCT key (the old key let NULL-department
--                                       rows duplicate), maintained by trigger from the current
--                                       version's lines, so every existing reader (BvA, report
--                                       engine, flux, FP&A, metrics) keeps reading one version.
--                                       Existing rows migrate into "FY{yr} Budget v1" (DRAFT,
--                                       current) per company × FY, cents unchanged.
-- §10 triggers: lifecycle guard, line lock, plan guard, publish + mirror, append-only events.
-- §11 RLS + grants: members SELECT their org only; every write is the service role (the app,
--     after its permission + client-scope check — the 171/187 pattern). budgets loses its
--     member write policy and grants. M1: every function EXECUTE-revoked from public / anon /
--     authenticated, granted to service_role.
-- §11b department scope (H6): RESTRICTIVE budget_department_scope on lines / drivers / plans /
--     comments / owners (finance + approvers see all; owners their departments); owner_email is
--     not member-readable (column grants).
-- §12 core.apply_client_scope_rls() + core.apply_projects_only_seat_deny() re-run (guarded).
--
-- H5: only an APPROVED / LOCKED BUDGET version can be current (CHECK); the migrated v1 is
-- "approved-migrated" (legacy, approved_by = 'system:migration-189'); lines can't be written for
-- months whose fiscal period is SOFT_CLOSE / HARD_CLOSE (BUDGET_PERIOD_CLOSED).
--
-- Purge: deletes refused by the guards (approved versions, their lines, plans, events) are allowed
-- inside a server-side purge that sets the 153 transaction-local GUC
--   set local meritbooks.allow_ledger_purge = 'on';   (events also honor meritbooks.allow_audit_purge)
-- — the reserved reset_tenant_data RPC / purge_org_ledger must set it. Not settable via PostgREST.
--
-- No GL effect: nothing here writes gl_entries / gl_entry_lines or fiscal_periods.
-- Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to Supabase FIRST, then
-- commit the code that depends on it.
-- =============================================================================

-- ── §1 versions ──────────────────────────────────────────────────────────────
create table if not exists public.budget_plan_versions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  location_id          uuid not null references core.locations(id) on delete cascade,
  fiscal_year          integer not null,
  kind                 text not null default 'BUDGET',
  version_number       integer not null default 1,
  label                text not null,
  status               text not null default 'DRAFT',
  is_current           boolean not null default false,
  parent_version_id    uuid references public.budget_plan_versions(id) on delete set null,
  basis                text not null default 'BLANK',
  growth_bps           integer,
  due_date             date,
  materiality_cents    bigint not null default 500000,
  materiality_bps      integer not null default 1000,
  notes                text,
  created_by           text,
  submitted_by         text,
  submitted_at         timestamptz,
  submit_note          text,
  returned_note        text,
  approved_by          text,
  approved_by_user_id  uuid,
  approved_at          timestamptz,
  locked_by            text,
  locked_at            timestamptz,
  superseded_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_plan_versions_chk') then
    alter table public.budget_plan_versions add constraint budget_plan_versions_chk
      check (kind in ('BUDGET', 'REFORECAST')
             and status in ('DRAFT', 'IN_REVIEW', 'APPROVED', 'LOCKED', 'SUPERSEDED')
             and basis in ('BLANK', 'MIGRATED', 'PRIOR_YEAR_ACTUALS', 'PRIOR_BUDGET', 'TEMPLATE', 'COPY', 'IMPORT', 'REFORECAST')
             and fiscal_year between 2000 and 2100
             and version_number between 1 and 999
             and length(btrim(label)) between 1 and 120
             and (growth_bps is null or growth_bps between -10000 and 100000)
             and materiality_cents >= 0
             and materiality_bps between 0 and 1000000
             and (notes is null or length(notes) <= 4000)
             and (submit_note is null or length(submit_note) <= 1000)
             and (returned_note is null or length(returned_note) <= 1000)
             -- only an APPROVED / LOCKED BUDGET version can be the published budget of record (H5):
             -- a draft or in-review version never reaches public.budgets (BvA, reports, flux, FP&A)
             and (not is_current or (kind = 'BUDGET' and status in ('APPROVED', 'LOCKED')))
             and (status <> 'IN_REVIEW' or (submitted_by is not null and submitted_at is not null))
             and (status not in ('APPROVED', 'LOCKED') or (approved_by is not null and approved_at is not null))
             -- segregation of duties: the person who submitted the version can't approve it
             and (approved_by is null or submitted_by is null or approved_by <> submitted_by)
             and (status <> 'LOCKED' or (locked_by is not null and locked_at is not null))
             and (status <> 'SUPERSEDED' or superseded_at is not null));
  end if;
end $$;
create unique index if not exists uq_budget_plan_versions_number
  on public.budget_plan_versions (org_id, location_id, fiscal_year, kind, version_number);
create unique index if not exists uq_budget_plan_versions_current
  on public.budget_plan_versions (org_id, location_id, fiscal_year) where is_current;
create index if not exists ix_budget_plan_versions_scope
  on public.budget_plan_versions (org_id, location_id, fiscal_year);
comment on table public.budget_plan_versions is
  'Mig 189: one version of a company × fiscal-year plan. kind BUDGET | REFORECAST. DRAFT → IN_REVIEW → APPROVED → LOCKED (+ SUPERSEDED, terminal). is_current = the BUDGET version published to public.budgets (one per company × FY). approved_by <> submitted_by. Lines are editable only while DRAFT. Service-role writes only.';

-- ── §2 version lines ─────────────────────────────────────────────────────────
create table if not exists public.budget_version_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  version_id     uuid not null references public.budget_plan_versions(id) on delete cascade,
  location_id    uuid not null references core.locations(id) on delete cascade,
  fiscal_year    integer not null,
  account_id     uuid not null references public.accounts(id),
  department_id  uuid references core.departments(id),
  period_number  integer not null,
  amount_cents   bigint not null default 0,
  source         text not null default 'MANUAL',
  notes          text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_version_lines_chk') then
    alter table public.budget_version_lines add constraint budget_version_lines_chk
      check (period_number between 1 and 13
             and fiscal_year between 2000 and 2100
             and source in ('MANUAL', 'IMPORT', 'TEMPLATE', 'PRIOR_YEAR', 'DRIVER', 'COPY', 'PASTE', 'MIGRATED', 'REFORECAST')
             and (notes is null or length(notes) <= 1000));
  end if;
end $$;
create unique index if not exists uq_budget_version_lines_cell
  on public.budget_version_lines (version_id, account_id, department_id, period_number) nulls not distinct;
create index if not exists ix_budget_version_lines_scope
  on public.budget_version_lines (org_id, location_id, fiscal_year);
create index if not exists ix_budget_version_lines_dept
  on public.budget_version_lines (version_id, department_id);
comment on table public.budget_version_lines is
  'Mig 189: budget cells of a version — company × department (NULL = company level) × account × month (13 = adjustments), bigint cents. Refused by trigger unless the version is DRAFT and the department plan (if any) is not SUBMITTED / APPROVED. Mirrored into public.budgets while the version is current.';

-- ── §3 line drivers ──────────────────────────────────────────────────────────
create table if not exists public.budget_line_drivers (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  version_id     uuid not null references public.budget_plan_versions(id) on delete cascade,
  location_id    uuid not null references core.locations(id) on delete cascade,
  account_id     uuid not null references public.accounts(id),
  department_id  uuid references core.departments(id),
  method         text not null,
  params         jsonb not null default '{}'::jsonb,
  annual_cents   bigint not null default 0,
  bridge_driver  text not null default 'AUTO',
  note           text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_line_drivers_chk') then
    alter table public.budget_line_drivers add constraint budget_line_drivers_chk
      check (method in ('FIXED_MONTHLY', 'ANNUAL_EVEN', 'ANNUAL_SEASONAL', 'PY_GROWTH', 'PCT_OF_REVENUE',
                        'HEADCOUNT_RATE', 'UNITS_RATE', 'PRIOR_BUDGET_GROWTH', 'MANUAL')
             and bridge_driver in ('AUTO', 'HEADCOUNT', 'RATE', 'VOLUME', 'NEW_INITIATIVE', 'ONE_TIME', 'INFLATION')
             and jsonb_typeof(params) = 'object'
             and (note is null or length(note) <= 1000));
  end if;
end $$;
create unique index if not exists uq_budget_line_drivers_row
  on public.budget_line_drivers (version_id, account_id, department_id) nulls not distinct;
comment on table public.budget_line_drivers is
  'Mig 189: how a budget row (version × account × department) was built — method + params (cents / bps / counts), the annual result, and the bridge driver it reports under. Same lock as the lines.';

-- ── §4 department plans ──────────────────────────────────────────────────────
create table if not exists public.budget_department_plans (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  version_id            uuid not null references public.budget_plan_versions(id) on delete cascade,
  location_id           uuid not null references core.locations(id) on delete cascade,
  department_id         uuid not null references core.departments(id) on delete cascade,
  owner_user_id         text,
  owner_name            text,
  template_key          text,
  template_version      integer,
  status                text not null default 'NOT_STARTED',
  due_date              date,
  target_revenue_cents  bigint,
  target_expense_cents  bigint,
  gap_note              text,
  submitted_by          text,
  submitted_at          timestamptz,
  submit_note           text,
  reviewed_by           text,
  reviewed_at           timestamptz,
  review_note           text,
  approved_by           text,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_department_plans_chk') then
    alter table public.budget_department_plans add constraint budget_department_plans_chk
      check (status in ('NOT_STARTED', 'DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED')
             and (owner_name is null or length(owner_name) <= 200)
             and (template_key is null or length(template_key) between 1 and 80)
             and (gap_note is null or length(gap_note) <= 1000)
             and (submit_note is null or length(submit_note) <= 1000)
             and (review_note is null or length(review_note) <= 1000)
             and (status <> 'SUBMITTED' or (submitted_by is not null and submitted_at is not null))
             and (status <> 'RETURNED' or (reviewed_by is not null and reviewed_at is not null
                                           and review_note is not null and length(btrim(review_note)) >= 3))
             and (status <> 'APPROVED' or (approved_by is not null and approved_at is not null))
             -- segregation of duties: the submitter can't approve their own department
             and (approved_by is null or submitted_by is null or approved_by <> submitted_by));
  end if;
end $$;
create unique index if not exists uq_budget_department_plans_dept
  on public.budget_department_plans (version_id, department_id);
create index if not exists ix_budget_department_plans_owner
  on public.budget_department_plans (org_id, owner_user_id);
comment on table public.budget_department_plans is
  'Mig 189: a department inside a budget version — owner, template, NOT_STARTED → DRAFT → SUBMITTED → APPROVED | RETURNED (note ≥ 3 chars), due date, revenue / expense targets, gap note. approved_by <> submitted_by. Changes only while the version is DRAFT.';

-- ── §5 department owners ─────────────────────────────────────────────────────
create table if not exists public.budget_department_owners (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid references core.locations(id) on delete cascade,
  department_id  uuid not null references core.departments(id) on delete cascade,
  owner_user_id  text not null,
  owner_name     text,
  owner_email    text,
  assigned_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_department_owners_chk') then
    alter table public.budget_department_owners add constraint budget_department_owners_chk
      check (length(btrim(owner_user_id)) between 1 and 200
             and (owner_name is null or length(owner_name) <= 200)
             and (owner_email is null or length(owner_email) <= 320));
  end if;
end $$;
create unique index if not exists uq_budget_department_owners_dept
  on public.budget_department_owners (org_id, department_id);
create index if not exists ix_budget_department_owners_user
  on public.budget_department_owners (org_id, owner_user_id);
comment on table public.budget_department_owners is
  'Mig 189: the standing budget owner of each department (Clerk user id). Copied into every new version''s department plan; the source of "my departments" for department-head budget scope.';

-- ── §6 templates ─────────────────────────────────────────────────────────────
create table if not exists public.budget_templates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  template_key    text not null,
  version         integer not null default 1,
  name            text not null,
  department_kind text not null,
  description     text,
  based_on        text,
  lines           jsonb not null default '[]'::jsonb,
  kpis            jsonb not null default '[]'::jsonb,
  is_active       boolean not null default true,
  created_by      text,
  created_at      timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_templates_chk') then
    alter table public.budget_templates add constraint budget_templates_chk
      check (template_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'
             and version between 1 and 9999
             and length(btrim(name)) between 1 and 120
             and department_kind in ('SALES', 'MARKETING', 'OPERATIONS', 'SERVICE', 'PARTS', 'SHOP', 'CONSTRUCTION_PM',
                                     'ADMIN', 'EXECUTIVE', 'FINANCE', 'OTHER')
             and (description is null or length(description) <= 2000)
             and jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 200
             and jsonb_typeof(kpis) = 'array' and jsonb_array_length(kpis) <= 30);
  end if;
end $$;
create unique index if not exists uq_budget_templates_version
  on public.budget_templates (org_id, template_key, version);
comment on table public.budget_templates is
  'Mig 189: tenant budget templates. Rows are immutable — saving a template inserts version n+1 and flags it active; plans record the (key, version) they started from. System templates ship in code (lib/budgets/templates/system.ts). Lines select accounts by type / sub-type / group / name, never by number.';

-- ── §7 comments & variance explanations ──────────────────────────────────────
create table if not exists public.budget_comments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references core.organizations(id) on delete cascade,
  location_id      uuid not null references core.locations(id) on delete cascade,
  version_id       uuid references public.budget_plan_versions(id) on delete cascade,
  department_id    uuid references core.departments(id) on delete cascade,
  account_id       uuid references public.accounts(id) on delete cascade,
  period_number    integer,
  parent_id        uuid references public.budget_comments(id) on delete cascade,
  kind             text not null default 'COMMENT',
  status           text not null default 'OPEN',
  body             text not null,
  author_user_id   text not null,
  author_name      text,
  period_key       text,
  variance_window  text,
  variance_cents   bigint,
  resolved_by      text,
  resolved_at      timestamptz,
  reviewed_by      text,
  reviewed_at      timestamptz,
  review_note      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_comments_chk') then
    alter table public.budget_comments add constraint budget_comments_chk
      check (kind in ('COMMENT', 'JUSTIFY_REQUEST', 'VARIANCE_EXPLANATION')
             and status in ('OPEN', 'RESOLVED', 'EXPLAINED', 'REVIEWED')
             and length(btrim(body)) between 1 and 4000
             and (period_number is null or period_number between 1 and 13)
             and (period_key is null or period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
             and (variance_window is null or variance_window in ('MONTH', 'QTD', 'YTD', 'TTM'))
             and (review_note is null or length(review_note) <= 1000)
             and (kind <> 'VARIANCE_EXPLANATION' or (period_key is not null and variance_window is not null and account_id is not null))
             and (status <> 'RESOLVED' or (resolved_by is not null and resolved_at is not null))
             -- segregation of duties: a variance explanation is reviewed by someone other than its author
             and (status <> 'REVIEWED' or (reviewed_by is not null and reviewed_at is not null and reviewed_by <> author_user_id)));
  end if;
end $$;
create index if not exists ix_budget_comments_version on public.budget_comments (version_id, department_id);
create index if not exists ix_budget_comments_variance on public.budget_comments (org_id, location_id, period_key) where kind = 'VARIANCE_EXPLANATION';
comment on table public.budget_comments is
  'Mig 189: threaded comments on a budget line, justification requests, and variance explanations (owner explains → EXPLAINED; a different person reviews → REVIEWED, DB CHECK).';

-- ── §8 events (append-only) ──────────────────────────────────────────────────
create table if not exists public.budget_events (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id) on delete cascade,
  version_id          uuid references public.budget_plan_versions(id) on delete cascade,
  department_plan_id  uuid references public.budget_department_plans(id) on delete cascade,
  event_kind          text not null,
  from_status         text,
  to_status           text,
  actor_user_id       text,
  note                text,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budget_events_chk') then
    alter table public.budget_events add constraint budget_events_chk
      check (event_kind in ('VERSION_CREATED', 'VERSION_SUBMITTED', 'VERSION_RETURNED', 'VERSION_APPROVED', 'VERSION_LOCKED',
                            'VERSION_SUPERSEDED', 'VERSION_DELETED', 'PLAN_SUBMITTED', 'PLAN_RETURNED', 'PLAN_APPROVED',
                            'PLAN_REOPENED', 'LINES_SAVED', 'LINES_IMPORTED', 'LINES_GENERATED', 'OWNER_ASSIGNED',
                            'TEMPLATE_SAVED', 'MIGRATED')
             and (note is null or length(note) <= 1000)
             and jsonb_typeof(meta) = 'object');
  end if;
end $$;
create index if not exists ix_budget_events_version on public.budget_events (version_id, created_at);
comment on table public.budget_events is
  'Mig 189: append-only audit of budget transitions, imports, generation and owner changes (UPDATE / DELETE refused except by cascade).';

-- ── §9 public.budgets becomes the published budget of record ─────────────────
alter table public.budgets add column if not exists version_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'budgets_version_id_fkey') then
    alter table public.budgets add constraint budgets_version_id_fkey
      foreign key (version_id) references public.budget_plan_versions(id) on delete set null;
  end if;
end $$;

-- Collapse duplicate company-level cells the old key allowed (NULL department never
-- collided). Keep the most recently updated row; the lost rows are a superseded edit.
delete from public.budgets b
 using public.budgets d
 where b.org_id = d.org_id and b.location_id = d.location_id and b.account_id = d.account_id
   and b.department_id is not distinct from d.department_id
   and b.fiscal_year = d.fiscal_year and b.period_number = d.period_number
   and (coalesce(b.updated_at, b.created_at, 'epoch'::timestamptz), b.id::text)
     < (coalesce(d.updated_at, d.created_at, 'epoch'::timestamptz), d.id::text);

-- Replace every legacy UNIQUE constraint on budgets (live: unique_budget_entry; replay:
-- the auto-named one from 013) with one NULLS NOT DISTINCT key.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.budgets'::regclass and contype = 'u' loop
    execute format('alter table public.budgets drop constraint %I', c.conname);
  end loop;
end $$;
create unique index if not exists uq_budgets_cell
  on public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number) nulls not distinct;
create index if not exists ix_budgets_version on public.budgets (version_id);
comment on column public.budgets.version_id is
  'Mig 189: the budget_plan_versions row this published cell came from (the current BUDGET version for its company × FY). Maintained by trigger — write the version lines, never this table.';

-- Migrate existing rows: one "FY{yr} Budget v1 (migrated)" version per company × FY, marked
-- APPROVED-MIGRATED (legacy): basis = 'MIGRATED', approved_by = 'system:migration-189'. The rows
-- were the budget of record before versions existed, so they stay published (every existing
-- reader keeps working) — but only an APPROVED / LOCKED version may be current (H5), so the
-- migrated v1 is explicitly approved by the migration, never left a current DRAFT. Changes go
-- into a new version, which needs a real submit → approve by someone else.
--
-- One DO block = one transaction: the transaction-local GUC meritbooks.budget_migration lets the
-- §10 guards (present on a re-run) accept this backfill — DRAFT → APPROVED without review, lines
-- in closed months, plans on an approved version. The GUC is honoured only by those guards and
-- is never settable through PostgREST (writes are service-role only anyway).
-- Order on a re-run: the version is created DRAFT and NOT current, the rows are linked and copied
-- into its lines, and only then is it approved + made current — so the publish trigger
-- re-publishes exactly the copied cells instead of clearing the company-year.
do $$
begin
  perform set_config('meritbooks.budget_migration', 'on', true);

  insert into public.budget_plan_versions (org_id, location_id, fiscal_year, kind, version_number, label, status, is_current, basis, notes)
  select s.org_id, s.location_id, s.fiscal_year, 'BUDGET', 1, 'FY' || s.fiscal_year || ' Budget v1 (migrated)', 'DRAFT', false, 'MIGRATED',
         'Created by migration 189 from the budget entered before versions existed; approved-migrated (legacy) so it stays the budget of record.'
    from (select distinct org_id, location_id, fiscal_year from public.budgets where version_id is null) s
   where s.fiscal_year between 2000 and 2100
     and not exists (select 1 from public.budget_plan_versions v
                      where v.org_id = s.org_id and v.location_id = s.location_id
                        and v.fiscal_year = s.fiscal_year and v.kind = 'BUDGET');

  -- Link unversioned rows to their company-year's migrated v1 created just above (still DRAFT;
  -- never to a reviewed version: stray rows beside an approved budget stay unlinked).
  update public.budgets b
     set version_id = v.id
    from public.budget_plan_versions v
   where b.version_id is null
     and v.org_id = b.org_id and v.location_id = b.location_id and v.fiscal_year = b.fiscal_year
     and v.kind = 'BUDGET' and v.basis = 'MIGRATED' and v.version_number = 1 and v.status = 'DRAFT';

  insert into public.budget_version_lines (org_id, version_id, location_id, fiscal_year, account_id, department_id,
                                           period_number, amount_cents, source, notes, updated_by)
  select b.org_id, b.version_id, b.location_id, b.fiscal_year, b.account_id, b.department_id,
         b.period_number, b.amount_cents, 'MIGRATED', left(b.notes, 1000), b.created_by
    from public.budgets b
    join public.budget_plan_versions v on v.id = b.version_id and v.status = 'DRAFT' and v.basis = 'MIGRATED'
   where not exists (select 1 from public.budget_version_lines l
                      where l.version_id = b.version_id and l.account_id = b.account_id
                        and l.department_id is not distinct from b.department_id
                        and l.period_number = b.period_number);

  -- Department plans for the departments the migrated budgets carry — approved with the version.
  insert into public.budget_department_plans (org_id, version_id, location_id, department_id, status, approved_by, approved_at)
  select distinct l.org_id, l.version_id, l.location_id, l.department_id, 'APPROVED', 'system:migration-189', now()
    from public.budget_version_lines l
    join public.budget_plan_versions v on v.id = l.version_id and v.status = 'DRAFT' and v.basis = 'MIGRATED'
   where l.department_id is not null and l.source = 'MIGRATED'
     and not exists (select 1 from public.budget_department_plans p
                      where p.version_id = l.version_id and p.department_id = l.department_id);

  -- Approve-migrated + publish (one statement: the CHECK needs APPROVED whenever is_current).
  update public.budget_plan_versions v
     set status = 'APPROVED', approved_by = 'system:migration-189', approved_at = now(),
         is_current = not exists (select 1 from public.budget_plan_versions c
                                   where c.org_id = v.org_id and c.location_id = v.location_id
                                     and c.fiscal_year = v.fiscal_year and c.is_current and c.id <> v.id)
   where v.basis = 'MIGRATED' and v.kind = 'BUDGET' and v.status = 'DRAFT';

  insert into public.budget_events (org_id, location_id, version_id, event_kind, to_status, note, meta)
  select v.org_id, v.location_id, v.id, 'MIGRATED', 'APPROVED',
         'Budget rows linked to a version by migration 189 and approved-migrated (legacy budget of record).',
         jsonb_build_object('lines', (select count(*) from public.budget_version_lines l where l.version_id = v.id),
                            'approved_migrated', true)
    from public.budget_plan_versions v
   where v.basis = 'MIGRATED'
     and not exists (select 1 from public.budget_events e where e.version_id = v.id and e.event_kind = 'MIGRATED');
end $$;

-- ── §10 triggers ─────────────────────────────────────────────────────────────

-- 10a. Version lifecycle guard.
create or replace function public.budget_version_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare
  v_open int;
begin
  -- Migration 189's own backfill (transaction-local GUC, see §9) approves the migrated v1.
  if tg_op <> 'DELETE' and coalesce(current_setting('meritbooks.budget_migration', true), '') = 'on' then return new; end if;
  if tg_op = 'DELETE' then
    -- A cascade (company / org removal) or a server-side purge (tenant / sandbox reset, the 153
    -- transaction-local GUC) may remove anything; a direct delete only a draft.
    if pg_trigger_depth() > 1 or coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then return old; end if;
    if old.status <> 'DRAFT' then
      raise exception 'BUDGET_LOCKED: a % budget version can''t be deleted', lower(old.status) using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'BUDGET_LOCKED: a budget version starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.org_id <> old.org_id or new.location_id <> old.location_id or new.fiscal_year <> old.fiscal_year
     or new.kind <> old.kind or new.version_number <> old.version_number then
    raise exception 'BUDGET_LOCKED: a version''s company, year, kind and number can''t change' using errcode = '23514';
  end if;
  if new.status <> old.status then
    if not ((old.status = 'DRAFT' and new.status = 'IN_REVIEW')
         or (old.status = 'IN_REVIEW' and new.status in ('DRAFT', 'APPROVED'))
         or (old.status = 'APPROVED' and new.status in ('LOCKED', 'SUPERSEDED'))
         or (old.status = 'DRAFT' and new.status = 'SUPERSEDED')
         or (old.status = 'IN_REVIEW' and new.status = 'SUPERSEDED')) then
      raise exception 'BUDGET_LOCKED: a version can''t move from % to %', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'APPROVED' then
      select count(*) into v_open from public.budget_department_plans p
       where p.version_id = new.id and p.status <> 'APPROVED';
      if v_open > 0 then
        raise exception 'BUDGET_LOCKED: % department budget(s) are not approved yet', v_open using errcode = '23514';
      end if;
    end if;
  elsif old.status = 'LOCKED' and new.is_current <> old.is_current then
    raise exception 'BUDGET_LOCKED: the FY% budget is locked — changes go into a reforecast', old.fiscal_year using errcode = '23514';
  elsif old.status in ('APPROVED', 'LOCKED', 'SUPERSEDED') then
    -- An approved / locked version is frozen except for the published flag (and it can't come back once superseded).
    if new.label <> old.label or new.materiality_cents <> old.materiality_cents or new.materiality_bps <> old.materiality_bps
       or new.due_date is distinct from old.due_date or new.growth_bps is distinct from old.growth_bps
       or new.approved_by is distinct from old.approved_by or new.submitted_by is distinct from old.submitted_by then
      raise exception 'BUDGET_LOCKED: an % version is read-only — create a new version to change it', lower(old.status) using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- 10b. Line / driver lock: the version must be DRAFT and the department plan open.
create or replace function public.budget_line_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare
  v_vid uuid; v_dept uuid; v_status text; v_org uuid; v_loc uuid; v_fy int; v_plan text;
  v_periods int[]; v_closed int; v_kind text; v_published boolean; v_cell bigint;
begin
  if tg_op <> 'DELETE' and coalesce(current_setting('meritbooks.budget_migration', true), '') = 'on' then return new; end if;
  if tg_op = 'DELETE' then
    if coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then return old; end if;
    v_vid := old.version_id; v_dept := old.department_id;
  else
    v_vid := new.version_id; v_dept := new.department_id;
    if tg_op = 'UPDATE' and (new.version_id <> old.version_id or new.account_id <> old.account_id
        or new.department_id is distinct from old.department_id) then
      raise exception 'BUDGET_LOCKED: a budget line''s version, account and department can''t change' using errcode = '23514';
    end if;
  end if;

  select status, org_id, location_id, fiscal_year, kind into v_status, v_org, v_loc, v_fy, v_kind
    from public.budget_plan_versions where id = v_vid;
  if not found then
    if tg_op = 'DELETE' then return old; end if; -- the version itself is being removed (cascade)
    raise exception 'BUDGET_LOCKED: budget version not found' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 and v_status = 'DRAFT' then return old; end if;
  if v_status <> 'DRAFT' then
    raise exception 'BUDGET_LOCKED: this budget version is % — create a new version to change it', lower(replace(v_status, '_', ' '))
      using errcode = '23514';
  end if;
  if tg_op <> 'DELETE' and (new.org_id <> v_org or new.location_id <> v_loc) then
    raise exception 'BUDGET_LOCKED: a line must belong to its version''s company' using errcode = '23514';
  end if;
  if v_dept is not null then
    select status into v_plan from public.budget_department_plans where version_id = v_vid and department_id = v_dept;
    if v_plan in ('SUBMITTED', 'APPROVED') then
      raise exception 'BUDGET_LOCKED: this department budget is % — return it to draft to change it', lower(v_plan)
        using errcode = '23514';
    end if;
  end if;
  -- H5: a month whose fiscal period is SOFT_CLOSE / HARD_CLOSE is history — its budget can't
  -- be written (BvA for a closed month must not move). Lines only (drivers carry no month);
  -- period 13 (adjustments) has no fiscal period. Calendar mapping: period_year = fiscal_year,
  -- period_month = period_number (same as lib/budgets/service/department-view.ts).
  if tg_table_name = 'budget_version_lines' then
    v_periods := array_remove(array[
      case when tg_op <> 'INSERT' then (to_jsonb(old) ->> 'period_number')::int end,
      case when tg_op <> 'DELETE' then (to_jsonb(new) ->> 'period_number')::int end], null);
    select fp.period_month into v_closed
      from public.fiscal_periods fp
     where fp.org_id = v_org and fp.location_id = v_loc and fp.period_year = v_fy
       and fp.period_month = any (v_periods)
       and fp.status::text in ('SOFT_CLOSE', 'HARD_CLOSE')
     limit 1;
    -- Filling a NEW version may write a closed month only without moving history:
    --   * a REFORECAST (never published — the CHECK keeps is_current on BUDGET versions), or
    --   * nothing is published for this company × FY yet (no budget of record to move), or
    --   * the amount equals the published cell (the service copies closed months from the
    --     published version), or an UPDATE that leaves the amount unchanged.
    -- Any other INSERT / UPDATE / DELETE of a closed month is refused.
    if v_closed is not null and tg_op = 'INSERT' then
      if v_kind = 'REFORECAST' then
        v_closed := null;
      else
        select exists (select 1 from public.budget_plan_versions c
                        where c.org_id = v_org and c.location_id = v_loc and c.fiscal_year = v_fy and c.is_current)
          into v_published;
        if not v_published then
          v_closed := null;
        else
          select b.amount_cents into v_cell
            from public.budgets b
           where b.org_id = v_org and b.location_id = v_loc and b.account_id = new.account_id
             and b.department_id is not distinct from new.department_id
             and b.fiscal_year = v_fy and b.period_number = new.period_number
           limit 1;
          if coalesce(v_cell, 0) = new.amount_cents then v_closed := null; end if;
        end if;
      end if;
    elsif v_closed is not null and tg_op = 'UPDATE'
          and new.period_number = old.period_number and new.amount_cents = old.amount_cents then
      v_closed := null;
    end if;
    if v_closed is not null then
      raise exception 'BUDGET_PERIOD_CLOSED: %-% is closed — its budget can''t change', v_fy, lpad(v_closed::text, 2, '0')
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- 10c. Lines: the fiscal year follows the version (checked separately: drivers have no FY).
create or replace function public.budget_line_year_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare v_fy int;
begin
  select fiscal_year into v_fy from public.budget_plan_versions where id = new.version_id;
  if v_fy is not null and new.fiscal_year <> v_fy then
    raise exception 'BUDGET_LOCKED: a line''s fiscal year must match its version (FY%)', v_fy using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 10d. Department plans change only while the version is a draft.
create or replace function public.budget_plan_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare v_status text; v_vid uuid;
begin
  if tg_op <> 'DELETE' and coalesce(current_setting('meritbooks.budget_migration', true), '') = 'on' then return new; end if;
  if tg_op = 'DELETE' and coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on' then return old; end if;
  v_vid := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  select status into v_status from public.budget_plan_versions where id = v_vid;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'BUDGET_LOCKED: budget version not found' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if v_status <> 'DRAFT' then
    -- Owner / contact snapshots may still be corrected on a non-draft version; workflow may not.
    if tg_op = 'UPDATE' and new.status = old.status and new.approved_by is not distinct from old.approved_by
       and new.submitted_by is not distinct from old.submitted_by and new.target_expense_cents is not distinct from old.target_expense_cents
       and new.target_revenue_cents is not distinct from old.target_revenue_cents then
      return new;
    end if;
    raise exception 'BUDGET_LOCKED: department budgets can''t change once the version is %', lower(replace(v_status, '_', ' '))
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.version_id <> old.version_id or new.department_id <> old.department_id) then
    raise exception 'BUDGET_LOCKED: a department plan''s version and department can''t change' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- 10e. Publish: the current BUDGET version's lines ARE public.budgets for its company × FY.
create or replace function public.budget_publish_version() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if tg_op = 'UPDATE' and old.is_current and not new.is_current then
    delete from public.budgets where version_id = old.id;
  end if;
  if new.is_current and new.status in ('APPROVED', 'LOCKED') and (tg_op = 'INSERT' or not old.is_current) then
    delete from public.budgets
     where org_id = new.org_id and location_id = new.location_id and fiscal_year = new.fiscal_year;
    insert into public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number,
                                amount_cents, notes, created_by, version_id)
    select l.org_id, l.location_id, l.account_id, l.department_id, l.fiscal_year, l.period_number,
           l.amount_cents, l.notes, l.updated_by, l.version_id
      from public.budget_version_lines l
     where l.version_id = new.id;
  end if;
  return new;
end;
$$;

-- 10f. Mirror each line write while its version is current.
create or replace function public.budget_mirror_line() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
declare v_current boolean;
begin
  -- Mirror only the current APPROVED / LOCKED version (H5; the CHECK already ties is_current to it).
  select is_current and status in ('APPROVED', 'LOCKED') into v_current
    from public.budget_plan_versions
   where id = case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  if not coalesce(v_current, false) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    delete from public.budgets
     where version_id = old.version_id and account_id = old.account_id
       and department_id is not distinct from old.department_id and period_number = old.period_number;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    delete from public.budgets
     where org_id = new.org_id and location_id = new.location_id and account_id = new.account_id
       and department_id is not distinct from new.department_id
       and fiscal_year = new.fiscal_year and period_number = new.period_number;
    insert into public.budgets (org_id, location_id, account_id, department_id, fiscal_year, period_number,
                                amount_cents, notes, created_by, version_id)
    values (new.org_id, new.location_id, new.account_id, new.department_id, new.fiscal_year, new.period_number,
            new.amount_cents, new.notes, new.updated_by, new.version_id);
    return new;
  end if;
  return old;
end;
$$;

-- 10g'. Approve a version atomically: SoD, supersede the current BUDGET version, publish.
--       Service role only (the route has checked fpa.budgets:approve + client scope first).
create or replace function public.budget_approve_version(p_version uuid, p_actor text, p_actor_user_id uuid)
  returns uuid language plpgsql set search_path = public, pg_temp as
$$
declare
  v public.budget_plan_versions%rowtype;
  cur public.budget_plan_versions%rowtype;
begin
  select * into v from public.budget_plan_versions where id = p_version for update;
  if not found then
    raise exception 'BUDGET_LOCKED: budget version not found' using errcode = '23514';
  end if;
  if v.status <> 'IN_REVIEW' then
    raise exception 'BUDGET_LOCKED: submit the version for approval first (it is %)', lower(replace(v.status, '_', ' ')) using errcode = '23514';
  end if;
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'BUDGET_SOD: an approver is required' using errcode = '23514';
  end if;
  if v.submitted_by = p_actor then
    raise exception 'BUDGET_SOD: the person who submitted a budget can''t approve it' using errcode = '23514';
  end if;
  if v.kind = 'BUDGET' then
    select * into cur from public.budget_plan_versions
     where org_id = v.org_id and location_id = v.location_id and fiscal_year = v.fiscal_year
       and is_current and id <> v.id
     for update;
    if found then
      if cur.status = 'LOCKED' then
        raise exception 'BUDGET_LOCKED: the FY% budget is locked — changes go into a reforecast', v.fiscal_year using errcode = '23514';
      end if;
      update public.budget_plan_versions
         set is_current = false, status = 'SUPERSEDED', superseded_at = now()
       where id = cur.id;
    end if;
    update public.budget_plan_versions
       set status = 'APPROVED', approved_by = p_actor, approved_by_user_id = p_actor_user_id, approved_at = now(), is_current = true
     where id = v.id;
  else
    update public.budget_plan_versions
       set status = 'APPROVED', approved_by = p_actor, approved_by_user_id = p_actor_user_id, approved_at = now()
     where id = v.id;
  end if;
  return v.id;
end;
$$;

-- 10g. Append-only events (cascade deletes allowed).
create or replace function public.budget_events_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp as
$$
begin
  if tg_op = 'DELETE' and (pg_trigger_depth() > 1 or coalesce(current_setting('meritbooks.allow_ledger_purge', true), '') = 'on'
                           or coalesce(current_setting('meritbooks.allow_audit_purge', true), '') = 'on') then
    return old;
  end if;
  raise exception 'budget_events is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists trg_budget_version_guard on public.budget_plan_versions;
create trigger trg_budget_version_guard before insert or update or delete on public.budget_plan_versions
  for each row execute function public.budget_version_guard();
drop trigger if exists trg_budget_publish_version on public.budget_plan_versions;
create trigger trg_budget_publish_version after insert or update of is_current on public.budget_plan_versions
  for each row execute function public.budget_publish_version();
drop trigger if exists trg_budget_plan_versions_updated_at on public.budget_plan_versions;
create trigger trg_budget_plan_versions_updated_at before update on public.budget_plan_versions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budget_line_guard on public.budget_version_lines;
create trigger trg_budget_line_guard before insert or update or delete on public.budget_version_lines
  for each row execute function public.budget_line_guard();
drop trigger if exists trg_budget_line_year_guard on public.budget_version_lines;
create trigger trg_budget_line_year_guard before insert or update on public.budget_version_lines
  for each row execute function public.budget_line_year_guard();
drop trigger if exists trg_budget_mirror_line on public.budget_version_lines;
create trigger trg_budget_mirror_line after insert or update or delete on public.budget_version_lines
  for each row execute function public.budget_mirror_line();
drop trigger if exists trg_budget_version_lines_updated_at on public.budget_version_lines;
create trigger trg_budget_version_lines_updated_at before update on public.budget_version_lines
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budget_driver_guard on public.budget_line_drivers;
create trigger trg_budget_driver_guard before insert or update or delete on public.budget_line_drivers
  for each row execute function public.budget_line_guard();
drop trigger if exists trg_budget_line_drivers_updated_at on public.budget_line_drivers;
create trigger trg_budget_line_drivers_updated_at before update on public.budget_line_drivers
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budget_plan_guard on public.budget_department_plans;
create trigger trg_budget_plan_guard before insert or update or delete on public.budget_department_plans
  for each row execute function public.budget_plan_guard();
drop trigger if exists trg_budget_department_plans_updated_at on public.budget_department_plans;
create trigger trg_budget_department_plans_updated_at before update on public.budget_department_plans
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budget_department_owners_updated_at on public.budget_department_owners;
create trigger trg_budget_department_owners_updated_at before update on public.budget_department_owners
  for each row execute function public.set_updated_at();
drop trigger if exists trg_budget_comments_updated_at on public.budget_comments;
create trigger trg_budget_comments_updated_at before update on public.budget_comments
  for each row execute function public.set_updated_at();

drop trigger if exists trg_budget_events_append_only on public.budget_events;
create trigger trg_budget_events_append_only before update or delete on public.budget_events
  for each row execute function public.budget_events_append_only();

-- ── §11 RLS + grants (members read their org; the service role writes) ───────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['budget_plan_versions', 'budget_version_lines', 'budget_line_drivers', 'budget_department_plans',
                           'budget_department_owners', 'budget_templates', 'budget_comments', 'budget_events'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t
                and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- budgets: the published budget is written only by the version triggers (service role).
alter table public.budgets enable row level security;
drop policy if exists "org_isolation" on public.budgets;
drop policy if exists member_read on public.budgets;
drop policy if exists service_all on public.budgets;
create policy member_read on public.budgets for select to authenticated using (org_id = public.get_org_id());
create policy service_all on public.budgets for all to service_role using (true) with check (true);
revoke all on table public.budgets from anon;
revoke insert, update, delete, truncate on table public.budgets from authenticated;
grant select on table public.budgets to authenticated;
grant select, insert, update, delete on table public.budgets to service_role;

-- ── §11b department scope in the database (H6) ──────────────────────────────
-- Department heads (owners) read only their own departments' budget rows; finance staff and
-- budget approvers read every department and the company-level (department NULL) lines.
-- Mirrors lib/budgets/scope.ts (ALL = finance staff / approver; DEPARTMENTS = owned only).
--   ALL  = core.is_finance_member() (journal_entries:create / close_mgmt:manage)
--          OR legacy close_mgmt::view / close_mgmt::manage cell (finance staff / approver)
--          OR v2 fpa.budgets:approve / close.checklist:view.
create or replace function core.budget_sees_all_departments() returns boolean
  language plpgsql stable security definer set search_path = core, public, pg_temp as
$$
declare v_org uuid; v_sub text; v_role text;
begin
  v_org := public.get_org_id();
  v_sub := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
  if v_org is null or nullif(btrim(coalesce(v_sub, '')), '') is null then return false; end if;
  if core.is_finance_member() then return true; end if;
  if core.access_enforcement_mode_of(v_org) = 'v2' then
    return coalesce(core.has_capability('fpa.budgets', 'approve'), false)
        or coalesce(core.has_capability('close.checklist', 'view'), false);
  end if;
  select e.role::text into v_role from core.employees e
   where e.clerk_user_id = v_sub and e.org_id = v_org and e.is_active limit 1;
  if v_role is null then return false; end if;
  return coalesce(core.rbac_legacy_cells(v_org, v_role, true) && array['close_mgmt::view', 'close_mgmt::manage']::text[], false);
end
$$;
comment on function core.budget_sees_all_departments() is
  'Mig 189 (H6): may the CALLER (JWT) read every department''s budget (finance staff / approver)? Else only owned departments.';

create or replace function core.budget_owned_department_ids() returns setof uuid
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select o.department_id
    from public.budget_department_owners o
   where o.org_id = public.get_org_id()
     and o.owner_user_id = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
$$;
comment on function core.budget_owned_department_ids() is
  'Mig 189 (H6): the departments the CALLER (JWT sub) owns in their org (public.budget_department_owners).';

revoke all on function core.budget_sees_all_departments() from public, anon, authenticated;
revoke all on function core.budget_owned_department_ids() from public, anon, authenticated;
grant execute on function core.budget_sees_all_departments() to authenticated, service_role;
grant execute on function core.budget_owned_department_ids() to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['budget_version_lines', 'budget_line_drivers', 'budget_department_plans',
                           'budget_comments', 'budget_department_owners'] loop
    execute format('drop policy if exists budget_department_scope on public.%I', t);
    execute format($p$create policy budget_department_scope on public.%I as restrictive for select to authenticated
      using ((select core.budget_sees_all_departments())
             or (department_id is not null and department_id in (select core.budget_owned_department_ids())))$p$, t);
  end loop;
end $$;

-- owner_email is contact data for finance admins (read through the service API), not every member:
-- column-level SELECT on everything else.
revoke select on table public.budget_department_owners from authenticated;
grant select (id, org_id, location_id, department_id, owner_user_id, owner_name, assigned_by, created_at, updated_at)
  on table public.budget_department_owners to authenticated;

-- Functions (M1): no caller but the triggers; never callable by members.
revoke all on function public.budget_version_guard() from public, anon, authenticated;
revoke all on function public.budget_line_guard() from public, anon, authenticated;
revoke all on function public.budget_line_year_guard() from public, anon, authenticated;
revoke all on function public.budget_plan_guard() from public, anon, authenticated;
revoke all on function public.budget_publish_version() from public, anon, authenticated;
revoke all on function public.budget_mirror_line() from public, anon, authenticated;
revoke all on function public.budget_events_append_only() from public, anon, authenticated;
revoke all on function public.budget_approve_version(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.budget_version_guard() to service_role;
grant execute on function public.budget_line_guard() to service_role;
grant execute on function public.budget_line_year_guard() to service_role;
grant execute on function public.budget_plan_guard() to service_role;
grant execute on function public.budget_publish_version() to service_role;
grant execute on function public.budget_mirror_line() to service_role;
grant execute on function public.budget_events_append_only() to service_role;
grant execute on function public.budget_approve_version(uuid, text, uuid) to service_role;

-- End migration 189.

-- ── §12 client scope + Projects-only seat deny (guarded: absent in the replay) ─
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['budget_plan_versions', 'budget_version_lines', 'budget_line_drivers', 'budget_department_plans',
                             'budget_department_owners', 'budget_templates', 'budget_comments', 'budget_events'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
