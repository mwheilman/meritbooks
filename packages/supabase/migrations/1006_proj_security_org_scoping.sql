-- ============================================================================
-- MeritProjects — SECURITY HOTFIX :: org-scope the SECURITY DEFINER mutators
-- Migration 1006 :: schema `proj`
--
-- Finding (security agent, session 43): the SECURITY DEFINER RPCs fetch a
-- resource by id/job with NO org filter. Because SECURITY DEFINER bypasses RLS,
-- once these are exposed over HTTP (the new write-path routes) a caller in org A
-- could act on an org-B resource by id — including emitting a real JOB_BILLING
-- money event into another tenant's ledger (approve_and_emit_billing), minting a
-- PO number on another tenant's commitment (approve_commitment), or driving
-- another tenant's permit gate (advance_external_gate).
--
-- Fix: add `and org_id = public.get_org_id()` to every by-id/by-job fetch so a
-- cross-org id resolves to "not found" and is cleanly rejected. get_org_id()
-- reads the caller's JWT org claim and still resolves correctly inside a definer
-- function, so the legitimate caller (whose org == the resource's org) is
-- unaffected. Wire shapes and behavior are otherwise UNCHANGED. Idempotent.
-- ============================================================================

-- 1) approve_and_emit_billing — THE money route
create or replace function proj.approve_and_emit_billing(p_request_id uuid, p_approver text default null::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare
  br proj.billing_requests%rowtype; v_cust uuid; v_lines jsonb; v_total bigint;
  v_event uuid := gen_random_uuid(); v_payload jsonb; v_precond text;
begin
  -- org-scoped fetch: a cross-org request id is "not found"
  select * into br from proj.billing_requests where id = p_request_id and org_id = public.get_org_id() for update;
  if not found then raise exception 'Billing request % not found', p_request_id; end if;
  if br.status not in ('DRAFT','REJECTED') then raise exception 'Billing request % is %; only DRAFT/REJECTED can be emitted', p_request_id, br.status; end if;
  select customer_id into v_cust from core.jobs where id = br.job_id;
  if v_cust is null then raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer_id; set one before billing', br.job_id; end if;
  select jsonb_agg(jsonb_build_object('description', l.description, 'amount_cents', l.amount_cents, 'item_id', l.item_id) order by l.sort_order), coalesce(sum(l.amount_cents), 0)
  into v_lines, v_total from proj.billing_request_lines l where l.billing_request_id = br.id;
  if v_lines is null then raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id; end if;
  if v_total <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: total must be > 0 (got %)', v_total; end if;
  v_precond := proj.draw_precondition_met(br.id);
  if v_precond is not null then raise exception '%: billing request % blocked by external gate / compliance', v_precond, br.id; end if;
  if not proj.books_present(br.org_id) then
    update proj.billing_requests set status='UNISSUED', approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now() where id=br.id;
    return null;
  end if;
  v_payload := jsonb_build_object('event_id', v_event, 'event_type','JOB_BILLING', 'source_module','PROJECTS',
    'org_id', br.org_id, 'location_id', br.location_id, 'job_id', br.job_id, 'billing_type', br.billing_type,
    'occurred_on', to_char(br.occurred_on,'YYYY-MM-DD'), 'source_ref', br.source_ref, 'memo', br.memo, 'lines', v_lines);
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');
  update proj.billing_requests set status='EMITTED', event_id=v_event, approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now() where id=br.id;
  return v_event;
end $fn$;

-- 2) approve_commitment
create or replace function proj.approve_commitment(p_commitment_id uuid, p_approver text default null::text)
returns void language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare c proj.commitments%rowtype;
begin
  select * into c from proj.commitments where id = p_commitment_id and org_id = public.get_org_id() for update;
  if not found then raise exception 'Commitment % not found', p_commitment_id; end if;
  if c.status not in ('DRAFT','APPROVED','PARTIAL') then raise exception 'Commitment % is %; cannot approve', p_commitment_id, c.status; end if;
  update proj.commitments
    set status='APPROVED', number=coalesce(number, proj.next_doc_number(org_id, commitment_type)),
        revised_amount_cents=greatest(revised_amount_cents, original_amount_cents),
        executed_at=coalesce(executed_at, now()), approved_by=coalesce(p_approver, approved_by), updated_at=now()
  where id = p_commitment_id;
end $fn$;

-- 3) advance_external_gate
create or replace function proj.advance_external_gate(p_gate_id uuid, p_new_status text, p_actor text default null)
returns proj.external_gates language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare g proj.external_gates%rowtype; ok boolean;
begin
  select * into g from proj.external_gates where id = p_gate_id and org_id = public.get_org_id() for update;
  if not found then raise exception 'external_gate % not found', p_gate_id; end if;
  ok := case g.status
    when 'PENDING' then p_new_status in ('SUBMITTED','WAIVED')
    when 'SUBMITTED' then p_new_status in ('APPROVED','REJECTED','WAIVED')
    when 'APPROVED' then p_new_status in ('CLEARED','EXPIRED','REJECTED')
    when 'REJECTED' then p_new_status in ('SUBMITTED')
    when 'EXPIRED' then p_new_status in ('SUBMITTED') else false end;
  if not ok then raise exception 'GATE_TRANSITION_INVALID: % -> %', g.status, p_new_status; end if;
  update proj.external_gates set status=p_new_status,
    approved_on=case when p_new_status='APPROVED' then coalesce(approved_on, current_date) else approved_on end,
    cleared_by=case when p_new_status in ('CLEARED','WAIVED') then coalesce(p_actor, cleared_by) else cleared_by end,
    cleared_at=case when p_new_status in ('CLEARED','WAIVED') then now() else cleared_at end, updated_at=now()
  where id=p_gate_id returning * into g;
  return g;
end $fn$;

-- 4) approve_change_order
create or replace function proj.approve_change_order(p_co_id uuid, p_approver text default null::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare v_job uuid; v_event uuid;
begin
  update proj.change_orders
    set status = 'APPROVED', approved_by = p_approver, approved_at = now(), updated_at = now()
  where id = p_co_id and org_id = public.get_org_id() and status in ('DRAFT','SUBMITTED','REJECTED')
  returning job_id into v_job;
  if v_job is null then raise exception 'Change order % not found or not approvable', p_co_id; end if;
  v_event := proj.emit_job_progress(v_job, 'CHANGE_ORDER', 'change order approved');
  return v_event;
end $fn$;

-- 5) set_contract
create or replace function proj.set_contract(p_job_id uuid, p_original_contract_cents bigint, p_cost_estimate_cents bigint, p_billing_cadence text default null::text, p_progress_basis text default 'NONE'::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare v_org uuid; v_loc uuid; v_type text; v_arch text; v_contract uuid;
begin
  select org_id, location_id, job_type, archetype into v_org, v_loc, v_type, v_arch
  from core.jobs where id = p_job_id and org_id = public.get_org_id();
  if v_org is null then raise exception 'Job % not found', p_job_id; end if;
  if coalesce(v_type, v_arch) is null then
    raise exception 'PRECONDITION_NO_JOB_TYPE: job % has neither job_type nor archetype; set the type at job creation so Books can resolve the rev-rec method', p_job_id;
  end if;
  insert into proj.contracts as c
    (org_id, job_id, location_id, original_contract_cents, cost_estimate_cents, billing_cadence, progress_basis, status)
  values (v_org, p_job_id, v_loc, p_original_contract_cents, p_cost_estimate_cents, p_billing_cadence, coalesce(p_progress_basis,'NONE'), 'ACTIVE')
  on conflict (org_id, job_id) do update
    set original_contract_cents = excluded.original_contract_cents, cost_estimate_cents = excluded.cost_estimate_cents,
        billing_cadence = coalesce(excluded.billing_cadence, c.billing_cadence), progress_basis = excluded.progress_basis,
        status = 'ACTIVE', updated_at = now()
  returning id into v_contract;
  perform proj.emit_job_progress(p_job_id, 'CONTRACT_SET', 'contract set');
  return v_contract;
end $fn$;

-- 6) update_progress
create or replace function proj.update_progress(p_job_id uuid, p_pct numeric, p_basis text default 'PHYSICAL'::text)
returns uuid language plpgsql security definer set search_path to 'proj','core','public' as $fn$
declare v_event uuid;
begin
  if p_basis not in ('NONE','PHYSICAL','SCHEDULE') then raise exception 'Invalid progress_basis: %', p_basis; end if;
  if p_basis <> 'NONE' and (p_pct is null or p_pct < 0 or p_pct > 1) then
    raise exception 'pct_complete must be between 0 and 1 for a tracked basis (got %)', p_pct;
  end if;
  update proj.contracts
    set pct_complete = case when p_basis = 'NONE' then null else p_pct end, progress_basis = p_basis, updated_at = now()
  where job_id = p_job_id and org_id = public.get_org_id();
  if not found then raise exception 'No contract for job %', p_job_id; end if;
  v_event := proj.emit_job_progress(p_job_id, 'PROGRESS_UPDATE', 'progress update');
  return v_event;
end $fn$;
