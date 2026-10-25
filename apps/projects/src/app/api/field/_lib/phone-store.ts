import 'server-only';
/**
 * The Supabase PhoneStore: every call on the caller's RLS client (guarded definer RPCs of the Wave
 * A/B migrations), never the service role. esign.sign runs on the anon key through lib/esign/public
 * (token-scoped, as the public signing page does). Only non-money columns are selected.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { actOnRequest, loadRequest } from '@/lib/approvals/server';
import { markNotifications } from '@/lib/notify/inbox';
import { signWithToken } from '@/lib/esign/public';
import { xcall } from '@/lib/dealer/rpc';
import { fsCall } from '@/lib/fieldservice/rpc';
import type { ApprovalSnapshot, FsEstimateRef, OpenTechPunch, PhoneStore } from './phone-store-types';

async function one<T>(q: PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>, what: string): Promise<T | null> {
  const r = await q;
  if (r.error) throw new PmQueryError(what, r.error);
  return (r.data ?? null) as T | null;
}

export function createPhoneStore(db: SupabaseClient, who: { userId: string }): PhoneStore {
  const pm = () => db.schema('pm');
  let empCache: Promise<string | null> | null = null;
  const employeeId = () => {
    empCache ??= (async () => {
      const r = await db.schema('core').from('employees').select('id').eq('clerk_user_id', who.userId).eq('is_active', true).limit(1).maybeSingle();
      return r.error ? null : ((r.data as { id: string } | null)?.id ?? null);
    })();
    return empCache;
  };

  return {
    async approval(requestId) {
      try {
        const d = await loadRequest(db, requestId);
        return {
          id: d.id, status: d.status, round: d.round, step: d.step, canAct: d.can_act, title: d.title,
          history: (d.history ?? []).map((h) => ({ decision: h.decision, round: h.round, step: h.step, actor: h.actor, channel: h.channel, at: h.at })),
        } satisfies ApprovalSnapshot;
      } catch (e) {
        if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return null;
        throw e;
      }
    },

    async actApproval(requestId, decision, o) {
      const r = await actOnRequest(db, requestId, decision, { reason: o.reason, selfReason: o.selfReason, channel: 'phone' });
      return { status: r.status, message: r.message ?? null, waitingOn: r.waiting_on ?? null };
    },

    markNotifications: (ids, state) => markNotifications(db, ids, state),

    async kioskEvents(companyId, events) {
      const r = await xcall<{ results?: Array<{ ok: boolean; replay?: boolean; error?: string }> }>(db, 'mfg_kiosk_events', { p_location: companyId, p_events: events });
      return (r.results ?? []).map((x) => ({ ok: !!x.ok, replay: !!x.replay, error: x.error }));
    },

    async roLine(lineId) {
      const l = await one<{ id: string; work_order_id: string; job_id: string }>(pm().from('work_order_lines').select('id, work_order_id, job_id').eq('id', lineId).maybeSingle(), 'repair order line');
      if (!l) return null;
      const w = await one<{ id: string; location_id: string; number: string | null }>(pm().from('work_orders').select('id, location_id, number').eq('id', l.work_order_id).maybeSingle(), 'repair order');
      return w ? { lineId: l.id, workOrderId: w.id, jobId: l.job_id, companyId: w.location_id, number: w.number } : null;
    },

    async workOrder(id) {
      const w = await one<{ id: string; job_id: string; location_id: string; number: string | null; kind: string }>(pm().from('work_orders').select('id, job_id, location_id, number, kind').eq('id', id).maybeSingle(), 'work order');
      return w ? { id: w.id, jobId: w.job_id, companyId: w.location_id, number: w.number, kind: w.kind } : null;
    },

    async roOpenPunch(companyId) {
      const me = await employeeId();
      if (!me) return null;
      const p = await one<{ kind: string; work_order_line_id: string | null; started_at: string }>(
        pm().from('dlr_tech_punches').select('kind, work_order_line_id, started_at').eq('location_id', companyId).eq('employee_id', me).is('ended_at', null).limit(1).maybeSingle(),
        'open punch',
      );
      return p ? ({ lineId: p.work_order_line_id, kind: p.kind, indirectKind: p.kind === 'LINE' ? null : p.kind, startedAt: p.started_at } satisfies OpenTechPunch) : null;
    },

    // The tap time rides along (1125): the database bounds it (PM_CLOCK_AHEAD / PM_PUNCH_STALE 422,
    // PM_PUNCH_OVERLAP 409 — refusals the phone shows and never retries) and keeps received_at too.
    async roClockOn(lineId, at) {
      await xcall(db, 'dlr_clock_on', { p_line: lineId, p_employee: null, p_at: at });
    },

    async roClockOff(companyId, at) {
      const r = await xcall<{ open?: boolean }>(db, 'dlr_clock_off', { p_location: companyId, p_employee: null, p_end_at: at });
      return { open: r.open !== false };
    },

    async roIndirect(companyId, kind, at) {
      await xcall(db, 'dlr_clock_indirect', { p_location: companyId, p_kind: kind, p_employee: null, p_at: at });
    },

    async esignSign(token, input, meta) {
      const s = await signWithToken(token, { typedName: input.typedName, signaturePng: input.signaturePng, consent: true }, meta);
      return { ok: s.ok, reason: s.reason ?? null };
    },

    async fsEstimate(id) {
      const e = await one<{ id: string; location_id: string; job_id: string; work_order_id: string | null; number: string | null; status: FsEstimateRef['status']; sold_option_ids: string[] | null }>(
        pm().from('fs_estimates').select('id, location_id, job_id, work_order_id, number, status, sold_option_ids').eq('id', id).maybeSingle(),
        'estimate',
      );
      return e ? { id: e.id, companyId: e.location_id, jobId: e.job_id, workOrderId: e.work_order_id, number: e.number, status: e.status, soldOptionIds: e.sold_option_ids ?? [] } : null;
    },

    async fsToggle(itemId, selected) {
      await fsCall(db, 'fs_toggle_option_item', { p_item: itemId, p_selected: selected });
    },

    async fsSell(a) {
      const r = await fsCall<{ lines: number; agreement_id: string | null; deposit_request_id: string | null; member_pricing: boolean }>(db, 'fs_sell_estimate', {
        p_estimate: a.estimateId, p_option_ids: a.optionIds, p_signed_name: a.signedName, p_dismiss_reason: a.dismissReason,
        p_join_template: a.joinTemplateId, p_deposit_cents: a.depositCents, p_request_deposit: a.requestDeposit, p_deposit_ref: a.depositRef,
        p_financing_plan: a.financingPlanId, p_sold_by_employee: null, p_signature_document: a.signatureDocumentId,
      });
      return { lines: r.lines, agreementId: r.agreement_id, depositRequestId: r.deposit_request_id, memberPricing: r.member_pricing };
    },

    async fsDecline(estimateId, reason) {
      await fsCall(db, 'fs_decline_estimate', { p_estimate: estimateId, p_reason: reason });
    },
  };
}
