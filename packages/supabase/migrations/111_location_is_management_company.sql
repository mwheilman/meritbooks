-- =============================================================================
-- Migration 111: core.locations.is_management_company — white-label flag
-- =============================================================================
-- The parent / management company (the one you consolidate INTO, and exclude from
-- the "portfolio companies & third parties" working scope) was previously detected
-- by a HARDCODED name match on 'merit management' / 'merit-mgmt' in /api/me. That
-- breaks white-label: any other tenant's management entity would never be recognized.
--
-- Replace the string heuristic with a real, tenant-owned data flag. Default false
-- (a plain entity); the app filters on !is_management_company instead of the name.
--
-- A one-time backfill preserves Merit's existing behavior by setting the flag true
-- for whatever row the OLD heuristic matched (name ilike '%merit management%' OR
-- short_code ilike '%merit-mgmt%'). Idempotent + additive: the column add is
-- guarded, and the backfill only ever flips false→true for the legacy match, so
-- re-running is a no-op. core band; next number: 112.
-- =============================================================================

alter table core.locations
  add column if not exists is_management_company boolean not null default false;

comment on column core.locations.is_management_company is
  'True for the tenant''s parent/management/holding entity — the one consolidated INTO and excluded from the "portfolio companies & third parties" working scope. Replaces the retired hardcoded name match.';

-- One-time backfill: preserve the legacy Merit behavior by flagging the row the old
-- name heuristic matched. Only flips false→true, so it is safe to re-run.
update core.locations
  set is_management_company = true
  where is_management_company = false
    and (lower(name) like '%merit management%' or lower(short_code) like '%merit-mgmt%');
