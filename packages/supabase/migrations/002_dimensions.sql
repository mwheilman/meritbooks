-- Migration 002: Dimensional Model
-- Locations = portfolio companies. 4 dimensions for GL tracking.

-- =============================================================
-- LOCATIONS (portfolio companies / entities)
-- =============================================================

create table locations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  short_code text not null,
  industry text,
  fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12),
  gl_classification_default dept_gl_classification_enum not null default 'ALWAYS_OPEX',
  rev_rec_method rev_rec_method_enum not null default 'POINT_OF_SALE',
  rev_rec_correction_approach text not null default 'TRUE_UP_FORWARD' check (rev_rec_correction_approach in ('TRUE_UP_FORWARD', 'RETROACTIVE')),
  minimum_cash_cents bigint not null default 0,
  is_active boolean not null default true,
  require_department boolean not null default false,
  require_class boolean not null default false,
  require_item boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, short_code)
);

-- =============================================================
-- DEPARTMENTS
-- =============================================================

create table departments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code text not null,
  gl_classification dept_gl_classification_enum not null default 'ALWAYS_OPEX',
  is_active boolean not null default true,
  parent_department_id uuid references departments(id),
  hierarchy_depth int not null default 1 check (hierarchy_depth between 1 and 3),
  clock_mode text not null default 'TIMER' check (clock_mode in ('TIMER', 'MANUAL')),
  require_gps boolean not null default false,
  require_phase boolean not null default false,
  pm_tool text, -- ClickUp, Monday, Asana, Jira, Harvest, None
  billable_by_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, code)
);

-- =============================================================
-- CLASSES (job phases, work types)
-- =============================================================

create table classes (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(org_id, code)
);

-- =============================================================
-- ITEMS (materials, services, cost codes)
-- =============================================================

create table items (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code text not null,
  unit_of_measure text,
  default_unit_cost_cents bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(org_id, code)
);

-- =============================================================
-- JUNCTION TABLES — which dimensions are valid per location
-- =============================================================

create table location_departments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  department_id uuid not null references departments(id) on delete cascade,
  unique(location_id, department_id)
);

create table location_classes (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  class_id uuid not null references classes(id) on delete cascade,
  unique(location_id, class_id)
);

create table location_items (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  unique(location_id, item_id)
);

-- =============================================================
-- INDEXES
-- =============================================================

create index idx_locations_org on locations(org_id);
create index idx_departments_org on departments(org_id);
create index idx_classes_org on classes(org_id);
create index idx_items_org on items(org_id);
create index idx_loc_depts_location on location_departments(location_id);
create index idx_loc_classes_location on location_classes(location_id);
create index idx_loc_items_location on location_items(location_id);

-- =============================================================
-- RLS
-- =============================================================

alter table locations enable row level security;
alter table departments enable row level security;
alter table classes enable row level security;
alter table items enable row level security;
alter table location_departments enable row level security;
alter table location_classes enable row level security;
alter table location_items enable row level security;

create policy "org_isolation" on locations for all using (org_id = public.get_org_id());
create policy "org_isolation" on departments for all using (org_id = public.get_org_id());
create policy "org_isolation" on classes for all using (org_id = public.get_org_id());
create policy "org_isolation" on items for all using (org_id = public.get_org_id());
create policy "org_isolation" on location_departments for all using (org_id = public.get_org_id());
create policy "org_isolation" on location_classes for all using (org_id = public.get_org_id());
create policy "org_isolation" on location_items for all using (org_id = public.get_org_id());

-- =============================================================
-- TRIGGERS
-- =============================================================

create trigger trg_locations_updated_at
  before update on locations for each row execute function set_updated_at();

create trigger trg_departments_updated_at
  before update on departments for each row execute function set_updated_at();
