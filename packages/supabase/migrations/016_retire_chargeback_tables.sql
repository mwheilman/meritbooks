-- Migration 016: Retire obsolete chargeback / labor tables (Session 12 pivot, Phase 0 Step B)
-- Safe to run: every runtime reader of these tables (chargeback service, overhead-rate
-- service, their APIs and the chargebacks page) was removed earlier in Phase 0.
-- The `employees` table is RETAINED (it backs RBAC / users / /api/me). Only the
-- chargeback-specific tables are dropped here. The labor-specific COLUMNS on employees
-- (labor_type, fica_rate, utilization, etc.) are retired in a later pass, after the Team
-- UI and /api/me stop reading them.
-- CASCADE drops the now-orphaned FK on job_cost_entries.time_entry_id; the (unused,
-- nullable) column itself remains and is harmless.

drop table if exists chargeback_lines cascade;
drop table if exists chargeback_invoices cascade;
drop table if exists chargeback_periods cascade;
drop table if exists shared_cost_allocations cascade;
drop table if exists shared_cost_rules cascade;
drop table if exists overhead_rate_periods cascade;
drop table if exists time_entries cascade;
