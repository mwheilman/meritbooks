-- =============================================================================
-- Migration 174: optional approver-release threshold (owner decision, 05 Q1 extended)
-- =============================================================================
-- Owner: "payment release is optional. they can have no threshold, or they can have a
-- threshold that they set."  The tenant setting has three choices:
--
--   Off              (default)  sole_approver_mode = false
--                    the person who approved a payment can never release it.
--   On, any amount              sole_approver_mode = true,  sole_approver_max_cents = null
--                    the approver may also release it.
--   On, up to $X                sole_approver_mode = true,  sole_approver_max_cents = X (> 0)
--                    the approver may release payments of X or less; above X a second
--                    person must release.
--
-- In every choice the PREPARER never releases, and PAYROLL always needs a releaser other
-- than the approver (strict H6 for payroll — the app's releaseRun already enforced it,
-- 170 §1; this migration makes the DB enforce it too).
--
-- §1  core.organizations.sole_approver_max_cents bigint null (> 0 when set).
-- §2  public.approvals_release_sod_guard() (165) re-created: approver = releaser is
--     allowed only when the tenant allows it, the kind is not PAYROLL_RUN, and — with a
--     threshold — the approval's |amount_cents| is at or below it (an approval without
--     an amount fails closed when a threshold is set).
-- §3  core.set_approver_release_policy(): the app's ONLY writer of the two columns
--     (service_role only). Tenant admin only (core.access_mode_is_admin, 170); firms
--     can't turn it on; a LOOSENING change (off → on, up-to → any, raising the
--     threshold) is refused unless the app attests the session meets the tenant's
--     CURRENT security policy (p_session_policy_met — the 170 §5 pattern: the app runs
--     assertSessionMeetsPolicy, the DB re-derives "is this loosening" itself).
-- §4  every change of either column, by any writer, is logged to core.access_change_log
--     ('approver_release.change', subject tenant_setting, before / after, loosening) by an
--     AFTER trigger through core.access_log_write (attribution via access_set_context).
-- §5  the platform rule "Approver can't release" gets the new plain-English wording.
--
-- M1 lesson: every function EXECUTE-revoked from public / anon / authenticated, then
-- granted explicitly (service_role). Idempotent. PGlite-compatible (no subqueries in
-- CHECK). No GL effect. Apply to Supabase FIRST.
-- =============================================================================

-- ── §1 the threshold column ──────────────────────────────────────────────────
alter table core.organizations add column if not exists sole_approver_max_cents bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_sole_approver_max_chk') then
    alter table core.organizations add constraint organizations_sole_approver_max_chk
      check (sole_approver_max_cents is null or sole_approver_max_cents > 0);
  end if;
end $$;
comment on column core.organizations.sole_approver_max_cents is
  'Mig 174: with sole_approver_mode on, the largest payment (bigint cents) its approver may also release. Null = any amount. Ignored when sole_approver_mode is off. Payroll never.';

-- The three choices as one word (used by the guard, the RPC and the log).
create or replace function core.approver_release_choice(p_mode boolean, p_max bigint) returns text
  language sql immutable as
$$ select case when not coalesce(p_mode, false) then 'off' when p_max is null then 'any' else 'up_to' end $$;

-- true when (from) → (to) lets the approver release MORE than before.
create or replace function core.approver_release_is_loosening(
  p_from_mode boolean, p_from_max bigint, p_to_mode boolean, p_to_max bigint) returns boolean
  language sql immutable as
$$
  select case
    when core.approver_release_choice(p_to_mode, p_to_max) = 'off' then false
    when core.approver_release_choice(p_from_mode, p_from_max) = 'off' then true
    when core.approver_release_choice(p_from_mode, p_from_max) = 'any' then false
    when core.approver_release_choice(p_to_mode, p_to_max) = 'any' then true
    else p_to_max > p_from_max
  end
$$;

-- ── §2 the DB release guard (supersedes 165) ─────────────────────────────────
create or replace function public.approvals_release_sod_guard() returns trigger
  language plpgsql security definer set search_path = public, core, pg_temp as
$$
declare v_sole boolean; v_max bigint;
begin
  if new.released_by is null then return new; end if;
  if tg_op = 'UPDATE' and new.released_by is not distinct from old.released_by
     and new.approved_by is not distinct from old.approved_by then
    return new;
  end if;
  if new.released_by = new.prepared_by then
    raise exception 'Separation of duties: the person who prepared this payment cannot release it.'
      using errcode = 'check_violation';
  end if;
  if new.approved_by is not null and new.released_by = new.approved_by then
    if new.kind = 'PAYROLL_RUN' then
      raise exception 'Separation of duties: payroll must be released by someone other than the person who approved it.'
        using errcode = 'check_violation';
    end if;
    select o.sole_approver_mode, o.sole_approver_max_cents into v_sole, v_max
      from core.organizations o where o.id = new.org_id;
    if not coalesce(v_sole, false) then
      raise exception 'Separation of duties: the person who approved this payment cannot also release it.'
        using errcode = 'check_violation';
    end if;
    if v_max is not null and (new.amount_cents is null or abs(new.amount_cents) > v_max) then
      raise exception 'Separation of duties: this payment is over the amount its approver may also release, so someone else has to release it.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
do $$ begin
  if to_regclass('public.approvals') is not null then
    drop trigger if exists trg_approvals_release_sod on public.approvals;
    create trigger trg_approvals_release_sod before insert or update of released_by, approved_by on public.approvals
      for each row execute function public.approvals_release_sod_guard();
  end if;
end $$;

-- ── §4 log every change (any writer) ─────────────────────────────────────────
create or replace function core.approver_release_log_trg() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  if (new.sole_approver_mode, new.sole_approver_max_cents)
     is not distinct from (old.sole_approver_mode, old.sole_approver_max_cents) then
    return null;
  end if;
  perform core.access_log_write(
    new.id, 'approver_release.change', 'tenant_setting', new.id, '{}'::uuid[], '{}'::uuid[], true,
    jsonb_build_object('approver_may_release', core.approver_release_choice(old.sole_approver_mode, old.sole_approver_max_cents),
                       'up_to_cents', case when old.sole_approver_mode then old.sole_approver_max_cents end),
    jsonb_build_object('approver_may_release', core.approver_release_choice(new.sole_approver_mode, new.sole_approver_max_cents),
                       'up_to_cents', case when new.sole_approver_mode then new.sole_approver_max_cents end,
                       'loosening', core.approver_release_is_loosening(old.sole_approver_mode, old.sole_approver_max_cents,
                                                                      new.sole_approver_mode, new.sole_approver_max_cents)),
    null, null, 'system');
  return null;
end
$$;
drop trigger if exists trg_organizations_approver_release_log on core.organizations;
create trigger trg_organizations_approver_release_log
  after update of sole_approver_mode, sole_approver_max_cents on core.organizations
  for each row execute function core.approver_release_log_trg();

-- ── §3 the app's entry point ─────────────────────────────────────────────────
-- p_choice             'off' | 'any' | 'up_to'
-- p_max_cents          required (> 0) for 'up_to'; ignored otherwise
-- p_actor              core.users.id of the admin making the change
-- p_session_policy_met the app's attestation that THIS session meets the tenant's current
--                      security policy (assertSessionMeetsPolicy). Required for loosening.
create or replace function core.set_approver_release_policy(
  p_org uuid, p_choice text, p_max_cents bigint, p_actor uuid,
  p_session_policy_met boolean default false, p_reason text default null, p_ip text default null)
returns jsonb
language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_m uuid;
  v_type text;
  v_mode boolean;
  v_max bigint;
  v_to_mode boolean;
  v_to_max bigint;
  v_loose boolean;
begin
  if p_org is null then raise exception 'organization required' using errcode = 'check_violation'; end if;
  if p_choice is null or p_choice not in ('off', 'any', 'up_to') then
    raise exception 'choose off, any amount, or up to an amount' using errcode = 'check_violation';
  end if;
  if p_choice = 'up_to' and (p_max_cents is null or p_max_cents <= 0) then
    raise exception 'enter an amount greater than $0' using errcode = 'check_violation';
  end if;

  select ms.id into v_m from core.memberships ms
   where ms.org_id = p_org and ms.user_id = p_actor and coalesce(ms.status, 'active') = 'active';
  if v_m is null or not core.access_mode_is_admin(v_m) then
    raise exception 'Only a tenant admin can change who may release payments' using errcode = '42501';
  end if;

  select o.tenant_type, o.sole_approver_mode, o.sole_approver_max_cents into v_type, v_mode, v_max
    from core.organizations o where o.id = p_org for update;
  if not found then raise exception 'organization % not found', p_org using errcode = 'no_data_found'; end if;

  v_to_mode := p_choice <> 'off';
  v_to_max := case when p_choice = 'up_to' then p_max_cents end;

  if v_to_mode and v_type = 'firm' then
    raise exception 'One-person approval isn''t available for firms.' using errcode = '42501';
  end if;
  if (v_to_mode, v_to_max) is not distinct from (v_mode, case when v_mode then v_max end) then
    return jsonb_build_object('status', 'unchanged', 'choice', p_choice, 'up_to_cents', v_to_max);
  end if;

  v_loose := core.approver_release_is_loosening(v_mode, v_max, v_to_mode, v_to_max);
  if v_loose and not coalesce(p_session_policy_met, false) then
    raise exception 'Relaxing who may release payments needs a session that meets your security policy.'
      using errcode = '42501';
  end if;

  perform core.access_set_context(p_actor, 'ui',
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''),
             case when v_loose then 'Relaxed who may release payments' else 'Tightened who may release payments' end),
    p_ip, null);
  update core.organizations
     set sole_approver_mode = v_to_mode, sole_approver_max_cents = v_to_max
   where id = p_org;

  return jsonb_build_object('status', 'applied', 'choice', p_choice, 'up_to_cents', v_to_max,
                            'previous_choice', core.approver_release_choice(v_mode, v_max),
                            'loosening', v_loose);
end
$$;

-- ── privileges (M1) ──────────────────────────────────────────────────────────
revoke all on function core.approver_release_choice(boolean, bigint) from public, anon, authenticated;
grant execute on function core.approver_release_choice(boolean, bigint) to service_role;
revoke all on function core.approver_release_is_loosening(boolean, bigint, boolean, bigint) from public, anon, authenticated;
grant execute on function core.approver_release_is_loosening(boolean, bigint, boolean, bigint) to service_role;
revoke all on function public.approvals_release_sod_guard() from public, anon, authenticated;
grant execute on function public.approvals_release_sod_guard() to service_role;
revoke all on function core.approver_release_log_trg() from public, anon, authenticated;
grant execute on function core.approver_release_log_trg() to service_role;
revoke all on function core.set_approver_release_policy(uuid, text, bigint, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function core.set_approver_release_policy(uuid, text, bigint, uuid, boolean, text, text) to service_role;

-- ── §5 plain-English rule text ───────────────────────────────────────────────
do $$ begin
  if to_regprocedure('core.sod_seed_platform_rules(jsonb)') is not null then
    perform core.sod_seed_platform_rules($r$[
      {"key":"H6_APPROVER_RELEASER","rule_type":"transaction","enforcement":"hard","platform_locked":true,"sort_order":3,
       "name":"Approver can't release",
       "description":"The person who approves a payment can't also release it, unless your company allows it (for any amount or up to a limit you set). Payroll always needs a second person.",
       "suggested_fix":"Have a different person release approved payments."}
    ]$r$::jsonb);
  end if;
end $$;

-- End migration 174.

-- Wave-2 integration: re-apply client-scope RLS (163) so this migration stays
-- order-independent with it.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
