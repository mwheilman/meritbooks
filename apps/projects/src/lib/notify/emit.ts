import 'server-only';
/**
 * Raise a notification from app code — for the events the database cannot see by itself
 * (approvals, e-sign requests, @mentions).
 *
 * Approvals (security review L): pass subjectType 'approval_request' and subjectId = the
 * pm.approval_requests id; the caller must be on that request (submitter / preparer / decider /
 * an actor). The database builds the title, body, amount and link from the request; `title` /
 * `body` / money fields are ignored. approval.requested goes to the current step's eligible
 * approvers (recipients narrow it; [] = all of them); approval.decided to the submitter and
 * preparers. Mentions and signing requests get templated titles ("Dana Lee mentioned you on
 * J-1001"; your text becomes the quoted excerpt / document name), are never mandatory, at most 20
 * people a call and 100 a person per hour. Job / task / punch assignment, change-order
 * signature, time submission, lead assignment and speed-to-lead are DB triggers (1114) and need
 * no call. Runs AS THE USER (pm.notify_emit is guarded: projects.jobs:view on the job, or a
 * Projects role at the company); the database filters recipients (reach the job, never the
 * actor) and decides money per recipient. Never throws: a failed notification must not fail
 * the action that raised it.
 *
 *   await notify(db, { event: 'approval.requested', jobId, recipients: approverIds,
 *     title: 'PO 1007 needs your approval', titleWithMoney: 'PO 1007 needs your approval ($12,500.00)',
 *     moneyCap: 'projects.financials', link: `/review?item=${id}`, dedupe: `po:${id}:step:2` });
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomerEvent, EmittableEvent } from './recipes';

export interface NotifyInput {
  event: EmittableEvent;
  /** The job the event is about (preferred), or the company when there is no job. */
  jobId?: string | null;
  companyId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  /** core.memberships ids (≤ 50; mentions ≤ 20; approvals may pass []). People who cannot reach the job are dropped by the database. */
  recipients: readonly string[];
  title: string;
  body?: string | null;
  /** The same sentence WITH amounts — shown only to recipients who hold `moneyCap` on the job. */
  titleWithMoney?: string | null;
  bodyWithMoney?: string | null;
  moneyCap?: 'projects.contract_value' | 'projects.financials' | null;
  /** Internal path, e.g. "/review?item=…". */
  link?: string | null;
  /** Idempotency key (per event): the same key never notifies the same person twice. */
  dedupe?: string | null;
}

export type NotifyResult = { ok: true; notified: number } | { ok: false; error: string };

export async function notify(db: SupabaseClient, n: NotifyInput): Promise<NotifyResult> {
  try {
    const { data, error } = await db.schema('pm').rpc('notify_emit', {
      p_event: n.event,
      p_job: n.jobId ?? null,
      p_location: n.jobId ? null : n.companyId ?? null,
      p_subject_type: n.subjectType ?? null,
      p_subject_id: n.subjectId ?? null,
      p_recipients: [...new Set(n.recipients)].slice(0, 50),
      p_title: n.title,
      p_body: n.body ?? null,
      p_title_money: n.titleWithMoney ?? null,
      p_body_money: n.bodyWithMoney ?? null,
      p_deep_link: n.link ?? null,
      p_dedupe: n.dedupe ?? null,
      p_money_cap: n.moneyCap ?? null,
    });
    if (error) {
      console.warn('[notify] emit failed (non-fatal):', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, notified: typeof data === 'number' ? data : 0 };
  } catch (e) {
    console.warn('[notify] emit failed (non-fatal):', e);
    return { ok: false, error: e instanceof Error ? e.message : 'notify failed' };
  }
}

export interface CustomerMessageInput {
  event: CustomerEvent;
  channel: 'email' | 'sms';
  jobId?: string | null;
  companyId?: string | null;
  contactId: string;
  subject?: string | null;
  body: string;
  dedupe?: string | null;
}

export type CustomerMessageResult =
  | { ok: true; id: string; status: 'queued' | 'held' | 'suppressed' | 'skipped'; reason: string | null; notBefore: string | null }
  | { ok: false; error: string };

/**
 * A message to a customer contact. HELD until the company goes live (Inbox → Settings), and
 * suppressed without text consent or after a STOP. The caller shows the returned status.
 */
export async function sendCustomerMessage(db: SupabaseClient, m: CustomerMessageInput): Promise<CustomerMessageResult> {
  const { data, error } = await db.schema('pm').rpc('notify_customer_message', {
    p_event: m.event, p_channel: m.channel, p_job: m.jobId ?? null, p_location: m.jobId ? null : m.companyId ?? null,
    p_contact: m.contactId, p_subject: m.subject ?? null, p_body: m.body, p_deep_link: null, p_dedupe: m.dedupe ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const r = (data ?? {}) as { id?: string; status?: string; reason?: string | null; notBefore?: string | null };
  const status = r.status === 'held' || r.status === 'suppressed' || r.status === 'skipped' ? r.status : 'queued';
  return { ok: true, id: r.id ?? '', status, reason: r.reason ?? null, notBefore: r.notBefore ?? null };
}
