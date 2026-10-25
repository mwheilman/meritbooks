-- ============================================================================
-- 1116 · Merit Projects — workspace plan schema v2 (pack manifest v2 experience section)
--
-- Spec: panel seat 10 §2.1 PLT-01 / PLT-03, §5 item 5; UX seat 08 §3a ("What changes per
-- industry"). Contract: packages/industry-packs/src/types.ts (PLAN_SCHEMA_VERSION = 2).
--
-- What changes
--   pm.apply_pack_plan(p_plan, p_role) accepts schema_version 1 or 2. A v2 plan adds one key,
--   `experience` (roles → persona templates, rails and homes per persona group, job page tabs per
--   job type, field actions, schedule views, document template and checklist keys). It is stored
--   verbatim in pm.pack_installs.resolved like the rest of the plan; nothing is materialized, so no
--   table, column, policy or grant changes. Tenant deltas keep living in pm.pack_overrides
--   (RFC 6901 pointers under /experience/… and /vocabulary/…); the TS compiler and the app layer
--   them (compilePlan overrides, apps/projects lib/packs/experience.ts).
--
-- How
--   The function body is patched in place (pg_get_functiondef → replace the one version check →
--   execute), the same technique 1110 uses to inject guards, so the 1110 capability guard already
--   injected at the top of the body is kept as is (marker pm_access_guard stays present).
--   Idempotent: when the v1-only check is no longer in the body, nothing runs. PGlite-safe.
-- ============================================================================

do $$
declare
  v_oid   oid;
  v_def   text;
  v_old   text := $q$if (p_plan ->> 'schema_version') is distinct from '1' then
    raise exception 'PLAN_INVALID: unsupported schema_version % (expected 1)', p_plan ->> 'schema_version' using errcode = '22023';$q$;
  v_new   text := $q$if coalesce(p_plan ->> 'schema_version', '') not in ('1', '2') then
    raise exception 'PLAN_INVALID: unsupported schema_version % (expected 1 or 2)', p_plan ->> 'schema_version' using errcode = '22023';$q$;
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'pm' and p.proname = 'apply_pack_plan'
   order by p.oid
   limit 1;
  if v_oid is null then
    raise exception '1116: pm.apply_pack_plan does not exist (1100 must run first)';
  end if;
  v_def := pg_get_functiondef(v_oid);
  if position(v_new in v_def) > 0 then
    return;                                   -- already v2
  end if;
  if position(v_old in v_def) = 0 then
    raise exception '1116: pm.apply_pack_plan has no recognisable schema_version check; refusing to guess';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

comment on function pm.apply_pack_plan(jsonb, text) is
  'Applies a WorkspacePlan (schema_version 1 or 2; v2 adds the `experience` section stored in pack_installs.resolved). 1100, version check widened by 1116.';

-- ============================================================================
-- Security review (prototype pollution): a pack override may never name __proto__, constructor
-- or prototype — not as a pointer segment and not as a key anywhere in its value. The app applies
-- /experience/… overrides on every render; such a key could reach Object.prototype server-wide.
-- The 1100 pointer check (json_pointer ~ '^(/([^~/]|~[01])*)+$') allows them; this narrows it.
-- The TS side refuses them too (packages/industry-packs experience.ts, apps/projects lib/api.ts).
-- ============================================================================

-- True when no object key at any depth of p is one of the reserved names. Immutable, so a CHECK
-- may call it; not security definer (it reads only its argument).
create or replace function pm.pack_override_keys_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = pm, pg_catalog
as $$
declare k text; v jsonb;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select e.key, e.value from jsonb_each(p) e loop
      if k in ('__proto__', 'constructor', 'prototype') or not pm.pack_override_keys_ok(v) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select e.value from jsonb_array_elements(p) e loop
      if not pm.pack_override_keys_ok(v) then return false; end if;
    end loop;
  end if;
  return true;
end $$;

-- Pointer segments: RFC 6901 escapes only '~' and '/', so a reserved name can only appear literally.
create or replace function pm.pack_override_pointer_ok(p text) returns boolean
language sql immutable
set search_path = pm, pg_catalog
as $$ select p is not null and p !~ '(^|/)(__proto__|constructor|prototype)(/|$)' $$;

do $$
declare n int;
begin
  -- Rows like these can only be exploit attempts (no pack or app path writes them): remove them
  -- so the constraint validates, and say how many went.
  delete from pm.pack_overrides
   where not pm.pack_override_pointer_ok(json_pointer) or not pm.pack_override_keys_ok(value);
  get diagnostics n = row_count;
  if n > 0 then raise notice '1116: removed % pack override(s) naming __proto__ / constructor / prototype', n; end if;
end $$;

alter table pm.pack_overrides drop constraint if exists pack_overrides_no_proto_chk;
alter table pm.pack_overrides add constraint pack_overrides_no_proto_chk
  check (pm.pack_override_pointer_ok(json_pointer) and pm.pack_override_keys_ok(value));

-- Never anon (Supabase's default privileges grant new functions to anon; the 1110/1117 registry
-- tests assert anon executes nothing in pm).
revoke all on function pm.pack_override_keys_ok(jsonb) from public, anon;
revoke all on function pm.pack_override_pointer_ok(text) from public, anon;
grant execute on function pm.pack_override_keys_ok(jsonb) to authenticated, service_role;
grant execute on function pm.pack_override_pointer_ok(text) to authenticated, service_role;
