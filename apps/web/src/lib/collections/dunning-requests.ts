/**
 * Dunning reminders as request-engine rows (core.requests kind 'dunning', migration 178).
 *
 * Each ladder step for an invoice is ONE request — dedupe key `dunning:<invoice>:<stage>`
 * (one live request per step, enforced by the 178 partial unique index). The request engine
 * (`requests.remind`, every 15 min) does the sending, so quiet hours, unsubscribe /
 * suppression, bounces and send quotas all apply, and every send lands on the request's
 * timeline in Requests.
 *
 *   DRAFT  the row is created with NO next send time. The dispatcher only picks up rows whose
 *          next_send_at has arrived, so it waits in Requests → Dunning until a person reviews
 *          it and presses "Send now" (still honouring quiet hours).
 *   AUTO   the row is due immediately (deferred to the end of quiet hours if needed).
 *
 * Plus `dunningResolver`: closes a live dunning request the moment its invoice is paid /
 * closed, before anything is sent (wired into requests.remind by the scheduler).
 *
 * Every write is the service role (core.requests is SELECT-only for members), org pinned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRequestRow, cancelRequest } from '@/lib/requests/service';
import { recordEvent } from '@/lib/requests/events';
import type { PolicyContext } from '@/lib/requests/policy';
import type { BatchResolver, Resolution } from '@/lib/requests/resolvers';
import type { RequestRow } from '@/lib/requests/types';
import type { DunningStep, DunningStepStage } from './dunning-policy';
import { holdMinutes } from './dunning-plan';

export const DUNNING_ACTOR = 'system:scheduler';

export function dunningDedupeKey(invoiceId: string, stage: DunningStepStage): string {
  return `dunning:${invoiceId}:${stage}`;
}

export interface NewDunningReminder {
  orgId: string;
  locationId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string;
  email: string;
  dueDate: string;
  balanceCents: number;
  step: DunningStep;
  nextStep: DunningStep | null;
  subject: string;
  body: string;
  /** true = wait for a person ("Send now"); false = due now. */
  draft: boolean;
}

/** The row to insert (pure apart from the policy context; exported for tests). */
export function buildDunningRow(n: NewDunningReminder, ctx: PolicyContext, now: Date): Record<string, unknown> {
  const isFinal = n.nextStep === null;
  const row = buildRequestRow(
    {
      orgId: n.orgId,
      locationId: n.locationId,
      kind: 'dunning',
      subjectType: 'invoice',
      subjectId: n.invoiceId,
      dedupeKey: dunningDedupeKey(n.invoiceId, n.step.stage),
      title: n.subject,
      message: n.body,
      deepLink: `/invoices?id=${n.invoiceId}`,
      recipient: { type: 'customer_contact', customerId: n.customerId, name: n.customerName, email: n.email },
      channels: ['email'],
      dueDate: n.dueDate,
      // One ask per step; the row stays open until the next step supersedes it (no
      // "no answer" noise in between), the final step escalates to a person once it goes.
      cadence: { anchor: 'created', offsetsMinutes: [0], repeatEveryMinutes: holdMinutes(n.step, n.nextStep), maxSends: 1 },
      escalateAfter: isFinal ? 1 : null,
      source: 'scheduler',
      createdBy: DUNNING_ACTOR,
      meta: {
        stage: n.step.stage,
        step_days: n.step.days,
        invoice_number: n.invoiceNumber,
        balance_cents: n.balanceCents,
        draft: n.draft,
        mode: n.draft ? 'draft' : 'auto',
      },
    },
    ctx,
    now,
  );
  if (n.draft) row.next_send_at = null;
  return row;
}

function isUnique(e: { message: string; code?: string } | null): boolean {
  return !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message));
}

/** Insert one reminder. `created: false` = that step was already waiting (dedupe). */
export async function createDunningReminder(
  admin: SupabaseClient,
  n: NewDunningReminder,
  ctx: PolicyContext,
  now: Date,
): Promise<{ created: boolean; id: string | null }> {
  const row = buildDunningRow(n, ctx, now);
  const { data, error } = await admin.schema('core').from('requests').insert(row).select('*').single();
  if (error) {
    if (isUnique(error as { message: string; code?: string })) return { created: false, id: null };
    throw new Error(`Could not create the reminder for ${n.invoiceNumber}: ${error.message}`);
  }
  const req = data as RequestRow;
  await recordEvent(
    admin,
    req,
    {
      event_type: 'created',
      actor: DUNNING_ACTOR,
      detail: n.draft
        ? 'Prepared by the dunning ladder — waiting for someone to review and send it.'
        : `Prepared by the dunning ladder — sending ${req.next_send_at ?? 'now'}.`,
      meta: { source: 'scheduler', stage: n.step.stage, draft: n.draft },
    },
    now,
  );
  return { created: true, id: req.id };
}

const CLOSED = new Set(['PAID', 'VOIDED', 'WRITTEN_OFF', 'CREDITED']);

/** Pure: is the dunning need already met for this invoice? */
export function decideDunningResolution(inv: { status: string; balance_cents: number | string } | undefined): Resolution {
  if (!inv) return { satisfied: true, via: 'resolver', note: 'The invoice no longer exists.' };
  if (CLOSED.has(inv.status) || Number(inv.balance_cents) <= 0) {
    return { satisfied: true, via: 'resolver', note: inv.status === 'PAID' || Number(inv.balance_cents) <= 0 ? 'The invoice was paid.' : `The invoice is ${inv.status.toLowerCase().replace('_', ' ')}.` };
  }
  return { satisfied: false };
}

/** Request-engine resolver for kind 'dunning': paid / closed invoice → fulfilled, nothing sent. */
export const dunningResolver: BatchResolver = async (db, orgId, requests) => {
  const out = new Map<string, Resolution>();
  const ids = Array.from(new Set(requests.filter((r) => r.subject_type === 'invoice' && r.subject_id).map((r) => r.subject_id as string)));
  if (ids.length === 0) return out;
  const { data, error } = await db.from('invoices').select('id, status, balance_cents').eq('org_id', orgId).in('id', ids);
  if (error) throw new Error(`Could not read invoices for payment reminders: ${error.message}`);
  const byId = new Map(((data ?? []) as Array<{ id: string; status: string; balance_cents: number | string }>).map((r) => [r.id, r]));
  for (const r of requests) {
    if (r.subject_type !== 'invoice' || !r.subject_id) continue;
    out.set(r.id, decideDunningResolution(byId.get(r.subject_id)));
  }
  return out;
};

/**
 * Cancel every LIVE dunning reminder queued for an invoice (marked disputed): nothing
 * already waiting in the request engine may go out while the customer disputes it. The
 * ladder itself holds new steps (stop_on_dispute). `admin` = the service-role writer
 * (core.requests is SELECT-only for members), org pinned. Returns how many were cancelled.
 */
export async function cancelDunningForInvoice(
  admin: SupabaseClient,
  orgId: string,
  invoiceId: string,
  actor: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<number> {
  const { data, error } = await admin
    .schema('core')
    .from('requests')
    .select('id')
    .eq('org_id', orgId)
    .eq('kind', 'dunning')
    .eq('subject_type', 'invoice')
    .eq('subject_id', invoiceId)
    .in('status', ['open', 'sent', 'snoozed']);
  if (error) throw new Error(`Could not read the queued reminders: ${error.message}`);
  let n = 0;
  for (const r of (data ?? []) as Array<{ id: string }>) {
    try {
      await cancelRequest({ db: admin, now }, orgId, r.id, actor, reason);
      n++;
    } catch (e) {
      // 409 = it closed in the meantime (sent / fulfilled) — nothing left to stop.
      if (!(e instanceof Error && /already closed/i.test(e.message))) throw e;
    }
  }
  return n;
}
