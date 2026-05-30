-- Migration 017: Retire obsolete labor columns on employees (Session 12 pivot)
-- Run ONLY after the labor-free /api/me, /api/team, and Team page are deployed and green.
-- employees becomes a generic users/roles record. Neutral comp columns
-- (hourly_rate_cents, annual_salary_cents) are KEPT for future payroll.

alter table employees drop column if exists labor_type;
alter table employees drop column if exists fica_rate;
alter table employees drop column if exists wc_rate;
alter table employees drop column if exists benefits_monthly_cents;
alter table employees drop column if exists direct_assigned_allocation_pct;
alter table employees drop column if exists direct_assigned_target_location_id;
alter table employees drop column if exists owner_pool_retention_pct;
alter table employees drop column if exists weekly_target_hours;
alter table employees drop column if exists utilization_flag_threshold;
alter table employees drop column if exists consecutive_low_periods;
alter table employees drop column if exists assigned_location_ids;

-- labor_type_enum is now unused; drop it if nothing else references it.
do $$ begin
  drop type if exists labor_type_enum;
exception when dependent_objects_still_exist then null; end $$;
