-- ============================================================================
-- Core hotfix (session 44): get_org_id() single-active-employee fallback
--
-- Problem: a signed-in session with NO active organization (fresh/Private window,
-- or after a second org was auto-created during onboarding) yields no org_id /
-- Clerk `o.id` claim, so get_org_id() returned null → ALL RLS returned empty and
-- the Projects entitlement gate showed "isn't enabled" even though the tenant owns
-- the module. (core.organizations RLS is `id = get_org_id()`.)
--
-- Fix: when the existing claim logic resolves nothing, fall back to the caller's
-- SINGLE active employee seat (keyed to their own Clerk user id, `sub`). Fail
-- closed on 0 or >1 active seats — unchanged (null). This is purely ADDITIVE:
--   * any session carrying a valid org_id / o.id claim returns EXACTLY as before;
--   * a caller can only ever resolve to an org where THEY hold an active seat, so
--     there is no cross-tenant broadening (a multi-org user still gets null).
-- Applied to the live DB first; this file records it for reproducibility.
-- Idempotent (create or replace).
-- ============================================================================
create or replace function public.get_org_id() returns uuid
 language plpgsql stable security definer set search_path to 'public','core' as $function$
declare claims json; v text; sub text; result uuid; orgs uuid[];
begin
  claims := current_setting('request.jwt.claims', true)::json;
  v := nullif(claims ->> 'org_id','');
  if v is null then v := claims -> 'o' ->> 'id'; end if;
  if v is not null and v <> '' then
    if v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select o.id into result from core.organizations o where o.id = v::uuid;
      if result is not null then return result; end if;
    end if;
    select o.id into result from core.organizations o where o.clerk_org_id = v;
    if result is not null then return result; end if;
  end if;
  -- FALLBACK: no active-org claim -> caller's single active employee seat.
  sub := nullif(claims ->> 'sub','');
  if sub is not null then
    select array_agg(distinct e.org_id) into orgs
    from core.employees e where e.clerk_user_id = sub and e.is_active = true;
    if array_length(orgs,1) = 1 then return orgs[1]; end if;
  end if;
  return null;
end $function$;
