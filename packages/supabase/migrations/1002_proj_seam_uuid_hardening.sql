-- ============================================================================
-- MeritProjects — Seam hardening :: uuid_generate_v4 -> gen_random_uuid
-- Migration 1002 :: schema `proj` (bugfix on 067 seam functions — wire UNCHANGED)
--
-- Latent bug found in G1 verification (session 42): proj.emit_job_progress and
-- proj.approve_and_emit_billing pin `search_path = proj, core, public`, which
-- EXCLUDES schema `extensions` where uuid-ossp's uuid_generate_v4() lives. The
-- bare in-body calls therefore fail at RUNTIME for every caller (app included),
-- so the JOB_PROGRESS / JOB_BILLING emit paths never succeed (proj.contracts
-- had 0 rows on the live DB). Table-column DEFAULT uuid_generate_v4() resolve
-- fine (bound schema-qualified at DDL time) — only in-function name resolution
-- breaks. Fix: gen_random_uuid() (pg_catalog, always resolvable; no search_path
-- dependency). No event shape, field, direction, lifecycle, or keying changes.
--
-- Idempotent: create-or-replace.
-- ============================================================================

create or replace function proj.emit_job_progress(p_job_id uuid, p_trigger text, p_memo text default null::text)
 returns uuid language plpgsql security definer set search_path to 'proj','core','public'
as $function$
declare
  vc proj.v_contract_current%rowtype; v_org uuid; v_loc uuid; v_pct numeric(5,4);
  v_event uuid; v_books boolean; v_srcref text; v_payload jsonb;
begin
  if p_trigger not in ('CONTRACT_SET','CHANGE_ORDER','PROGRESS_UPDATE') then
    raise exception 'Invalid JOB_PROGRESS trigger: %', p_trigger;
  end if;
  select * into vc from proj.v_contract_current where job_id = p_job_id;
  if not found then
    raise exception 'No contract for job % — set the contract before emitting progress', p_job_id;
  end if;
  v_org := vc.org_id; v_loc := vc.location_id;
  v_pct := case when vc.progress_basis in ('PHYSICAL','SCHEDULE') then vc.pct_complete else null end;
  v_books := proj.books_present(v_org);
  v_event := gen_random_uuid();
  v_srcref := p_trigger || ':' || p_job_id::text;
  if v_books then
    v_payload := jsonb_build_object(
      'event_id', v_event, 'event_type','JOB_PROGRESS', 'source_module','PROJECTS',
      'org_id', v_org, 'location_id', v_loc, 'job_id', p_job_id, 'trigger', p_trigger,
      'contract_value_cents', vc.contract_value_cents, 'cost_estimate_cents', vc.cost_estimate_cents,
      'pct_complete', v_pct, 'occurred_on', to_char(current_date,'YYYY-MM-DD'),
      'source_ref', v_srcref, 'memo', p_memo);
    insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
    values (v_org, v_event, 'JOB_PROGRESS', 'PROJECTS', v_payload, current_date, 'pending');
  else
    v_event := null;
  end if;
  insert into proj.job_progress_log
    (org_id, job_id, event_id, trigger, contract_value_cents, cost_estimate_cents, pct_complete, emitted)
  values (v_org, p_job_id, v_event, p_trigger, vc.contract_value_cents, vc.cost_estimate_cents, v_pct, v_books);
  return v_event;
end $function$;

create or replace function proj.approve_and_emit_billing(p_request_id uuid, p_approver text default null::text)
 returns uuid language plpgsql security definer set search_path to 'proj','core','public'
as $function$
declare
  br proj.billing_requests%rowtype; v_cust uuid; v_lines jsonb; v_total bigint;
  v_event uuid := gen_random_uuid(); v_payload jsonb;
begin
  select * into br from proj.billing_requests where id = p_request_id for update;
  if not found then raise exception 'Billing request % not found', p_request_id; end if;
  if br.status not in ('DRAFT','REJECTED') then
    raise exception 'Billing request % is %; only DRAFT/REJECTED can be emitted', p_request_id, br.status;
  end if;
  select customer_id into v_cust from core.jobs where id = br.job_id;
  if v_cust is null then
    raise exception 'PRECONDITION_NO_CUSTOMER: job % has no customer_id; set one before billing', br.job_id;
  end if;
  select
    jsonb_agg(jsonb_build_object('description', l.description, 'amount_cents', l.amount_cents, 'item_id', l.item_id) order by l.sort_order),
    coalesce(sum(l.amount_cents), 0)
  into v_lines, v_total
  from proj.billing_request_lines l where l.billing_request_id = br.id;
  if v_lines is null then raise exception 'PRECONDITION_NO_LINES: billing request % has no lines', br.id; end if;
  if v_total <= 0 then raise exception 'PRECONDITION_NONPOSITIVE: total must be > 0 (got %)', v_total; end if;
  if not proj.books_present(br.org_id) then
    update proj.billing_requests
      set status = 'UNISSUED', approved_by = p_approver, approved_at = now(), rejection_reason = null, updated_at = now()
    where id = br.id;
    return null;
  end if;
  v_payload := jsonb_build_object(
    'event_id', v_event, 'event_type','JOB_BILLING', 'source_module','PROJECTS',
    'org_id', br.org_id, 'location_id', br.location_id, 'job_id', br.job_id,
    'billing_type', br.billing_type, 'occurred_on', to_char(br.occurred_on,'YYYY-MM-DD'),
    'source_ref', br.source_ref, 'memo', br.memo, 'lines', v_lines);
  insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
  values (br.org_id, v_event, 'JOB_BILLING', 'PROJECTS', v_payload, br.occurred_on, 'pending');
  update proj.billing_requests
    set status='EMITTED', event_id=v_event, approved_by=p_approver, approved_at=now(), rejection_reason=null, updated_at=now()
  where id = br.id;
  return v_event;
end $function$;
