-- Migration 024: Fix validate_dimensions() stale table reference
-- =============================================================
-- The dimension-requirement trigger (from 004) selects `from locations`,
-- but locations was moved to the `core` schema by the core-carve migration.
-- The function was never updated, so it fails to resolve the table and EVERY
-- gl_entry_lines insert/update throws:
--   relation "locations" does not exist
-- i.e. no GL posting (manual, AP, AR, rev-rec, depreciation) could ever post.
--
-- Fix: qualify the table as core.locations. `accounts` stays unqualified
-- (still in public / on the search_path). Behavior is otherwise unchanged.
--
-- Idempotent (create or replace). Requires the core-carve migration.
-- =============================================================

create or replace function validate_dimensions()
returns trigger as $$
declare
  acct record;
  loc record;
begin
  select require_department, require_class, require_item
  into acct from accounts where id = new.account_id;

  select require_department, require_class, require_item
  into loc from core.locations where id = new.location_id;

  -- Use stricter of account vs location requirement
  if (acct.require_department or loc.require_department) and new.department_id is null then
    raise exception 'Department required for account % in location %', new.account_id, new.location_id;
  end if;

  if (acct.require_class or loc.require_class) and new.class_id is null then
    raise exception 'Class required for account % in location %', new.account_id, new.location_id;
  end if;

  if (acct.require_item or loc.require_item) and new.item_id is null then
    raise exception 'Item required for account % in location %', new.account_id, new.location_id;
  end if;

  return new;
end;
$$ language plpgsql;
