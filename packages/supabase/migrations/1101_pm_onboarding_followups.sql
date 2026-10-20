-- ============================================================================
-- 1101 · Merit Projects v2 — onboarding follow-ups to 1100
--
--   1. pm.onboarding_runs: let a run keep advancing after APPLIED (bring_work → team → done).
--      ALTER POLICY (no drop) — the 1100 check rejected status 'APPLIED' on update.
--   2. pm.adopt_job(job, job_type_key): bring an existing core.jobs row (e.g. Books WIP
--      import) under Merit Projects. Members cannot insert pm.projects directly.
--   3. pm.set_job_customer(job, customer_id, customer_name): the only path for Projects to
--      change a job's customer identity on core.jobs (Projects is the job-identity creator,
--      ownership matrix §5); validates the customer belongs to the org.
-- Idempotent. Definer functions org-guard first; EXECUTE granted to authenticated only.
-- ============================================================================

alter policy org_update on pm.onboarding_runs
  using (org_id = public.get_org_id())
  with check (org_id = public.get_org_id() and status in ('IN_PROGRESS','APPLIED','ABANDONED','COMPLETE'));

grant update (step, status, inputs, classification, plan, ai_decision_id, completed_at) on pm.onboarding_runs to authenticated;

-- ----------------------------------------------------------------------------
-- pm.adopt_job
-- ----------------------------------------------------------------------------
create or replace function pm.adopt_job(p_job uuid, p_job_type_key text)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org    uuid;
  v_loc    uuid;
  v_status text;
  v_name   text;
  jt       pm.job_types%rowtype;
  v_stage  pm.stage_defs%rowtype;
begin
  select j.org_id, j.location_id, j.status, j.name into v_org, v_loc, v_status, v_name
  from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if exists (select 1 from pm.projects p where p.org_id = v_org and p.job_id = p_job) then
    return p_job;                                   -- already adopted: idempotent
  end if;

  select * into jt from pm.job_types t
  where t.org_id = v_org and t.location_id = v_loc and t.key = p_job_type_key and t.is_active;
  if not found then
    raise exception 'PM_UNKNOWN_JOB_TYPE: % is not an active job type on this company', p_job_type_key using errcode = 'P0002';
  end if;

  -- keep the job where it is: first stage (by sort) whose core_status matches the job's
  -- current status; fall back to the machine's initial stage
  select * into v_stage from pm.stage_defs s
  where s.org_id = v_org and s.location_id = v_loc and s.machine_key = jt.stage_machine_key
    and s.is_active and s.core_status = v_status
  order by s.sort limit 1;
  if not found then
    select * into v_stage from pm.stage_defs s
    where s.org_id = v_org and s.location_id = v_loc and s.machine_key = jt.stage_machine_key
      and s.is_active and s.is_initial;
    if not found then raise exception 'PM_NO_INITIAL_STAGE: machine %', jt.stage_machine_key using errcode = 'P0002'; end if;
  end if;

  insert into pm.projects (job_id, org_id, location_id, job_type_id, stage_key, is_sample, ext, created_by)
  values (p_job, v_org, v_loc, jt.id, v_stage.stage_key, false,
          jsonb_build_object('_adopted_from', 'core.jobs', '_adopted_at', now()), pm.current_user_id());

  if v_stage.core_status is distinct from v_status then
    update core.jobs set status = v_stage.core_status where org_id = v_org and id = p_job;
  end if;

  perform pm.log_activity(v_org, v_loc, p_job, 'project.adopted', 'projects', p_job,
    format('Brought %s into Merit Projects as %s', coalesce(v_name, 'job'), jt.label),
    jsonb_build_object('job_type', jt.key, 'stage', v_stage.stage_key, 'previous_status', v_status));
  return p_job;
end $$;

-- ----------------------------------------------------------------------------
-- pm.set_job_customer
-- ----------------------------------------------------------------------------
create or replace function pm.set_job_customer(p_job uuid, p_customer_id uuid default null, p_customer_name text default null)
returns uuid
language plpgsql security definer
set search_path = pm, core, public
as $$
declare
  v_org  uuid;
  v_loc  uuid;
  v_name text;
begin
  select j.org_id, j.location_id into v_org, v_loc from core.jobs j where j.id = p_job;
  if v_org is null or v_org is distinct from public.get_org_id() then
    raise exception 'PM_FORBIDDEN: job % not found in the caller''s organization', p_job using errcode = '42501';
  end if;
  if p_customer_id is not null then
    select c.name into v_name from core.customers c
    where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null;
    if v_name is null then raise exception 'PM_UNKNOWN_CUSTOMER: %', p_customer_id using errcode = 'P0002'; end if;
  else
    v_name := nullif(btrim(coalesce(p_customer_name, '')), '');
    if v_name is not null and length(v_name) > 200 then
      raise exception 'PM_INVALID: customer name too long' using errcode = '22023';
    end if;
  end if;

  update core.jobs set customer_id = p_customer_id, customer_name = v_name
  where org_id = v_org and id = p_job;

  perform pm.log_activity(v_org, v_loc, p_job, 'project.customer_set', 'jobs', p_job,
    format('Customer set to %s', coalesce(v_name, '(none)')),
    jsonb_build_object('customer_id', p_customer_id, 'customer_name', v_name));
  return p_job;
end $$;

revoke execute on function pm.adopt_job(uuid, text) from public, anon;
revoke execute on function pm.set_job_customer(uuid, uuid, text) from public, anon;
grant execute on function pm.adopt_job(uuid, text) to authenticated, service_role;
grant execute on function pm.set_job_customer(uuid, uuid, text) to authenticated, service_role;
