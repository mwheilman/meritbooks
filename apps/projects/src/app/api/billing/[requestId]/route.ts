export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm, rows } from '@/lib/pm/db';
import { BILLING_LINE_COLS, PAY_APP_COLS } from '@/lib/pm/money/queries';
import { loadBillingRequest } from '@/lib/pm/money/load';
import { callRpc, moneyError, wrote } from '@/lib/pm/money/rpc';
import { approvalSummary, decideObject } from '@/lib/approvals/server';
import { IsoDate, Text2000 } from '@/lib/pm/money/schemas';
import type { BillingLineRow, PayApplicationRow } from '@/lib/pm/money/types';

/** One request: lines, failing preconditions (pm.billing_preconditions) and, for SOV, its G702 row. */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: 'billing' }, async ({ db, params }) => {
  const request = await loadBillingRequest(db, params.requestId!);
  const [lines, preconditions, payApp] = await Promise.all([
    pm(db).from('billing_request_lines').select(BILLING_LINE_COLS).eq('billing_request_id', request.id).order('sort').order('line_no').then((r) => rows<BillingLineRow>(r, 'billing lines')),
    request.status === 'DRAFT' || request.status === 'REJECTED' ? callRpc<string[]>(db, 'billing_preconditions', { p_request: request.id }, 'billing request') : Promise.resolve([] as string[]),
    request.billing_subtype === 'SOV'
      ? pm(db).from('v_pay_application').select(PAY_APP_COLS).eq('billing_request_id', request.id).maybeSingle().then((r) => one<PayApplicationRow>(r, 'pay application'))
      : Promise.resolve(null),
  ]);
  return { request, lines, preconditions: preconditions ?? [], payApp };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('approve') }),
  z.object({ op: z.literal('void'), reason: Text2000.nullish() }),
  z.object({ op: z.literal('update'), occurredOn: IsoDate.optional(), memo: Text2000.nullish() }),
]);

/**
 * approve_and_emit_billing: preparer ≠ approver, preconditions, then JOB_BILLING to Merit Books
 * (EMITTED) — or UNISSUED where nothing is sent. Merit Books numbers and posts the invoice.
 * A REJECTED request is fixed and approved again (new event, same source_ref).
 */
export const POST = route({ access: { cap: 'projects.billing', action: 'edit' }, ops: { approve: { cap: 'projects.billing', action: 'approve' } }, mask: 'billing', body: Body }, async ({ db, params, body }) => {
  const r = await loadBillingRequest(db, params.requestId!);
  if (body.op === 'approve') {
    // through the approvals engine (1113); approve_and_emit_billing runs at the last step
    const a = await decideObject(db, 'billing_request', r.id, { objectError: (e) => moneyError(e, 'billing request') });
    if (a.status === 'not_needed') {
      const eventId = await callRpc<string | null>(db, 'approve_and_emit_billing', { p_request: r.id }, 'billing request');
      return { status: eventId ? 'EMITTED' : 'UNISSUED', eventId, resent: r.status === 'REJECTED', approval: approvalSummary(a) };
    }
    const eventId = typeof a.result?.event_id === 'string' ? a.result.event_id : null;
    if (a.status !== 'approved') return { status: r.status, eventId: null, resent: false, approval: approvalSummary(a) };
    return { status: eventId ? 'EMITTED' : 'UNISSUED', eventId, resent: r.status === 'REJECTED', approval: approvalSummary(a) };
  }
  if (body.op === 'void') {
    await callRpc(db, 'void_billing_request', { p_request: r.id, p_reason: body.reason ?? null }, 'billing request');
    return { ok: true };
  }
  if (r.status !== 'DRAFT' && r.status !== 'REJECTED') throw new HttpError(422, 'Only drafts and rejected requests can be changed.', 'PM_BILLING_NOT_APPROVABLE');
  const patch: Record<string, unknown> = {};
  if (body.occurredOn) patch.occurred_on = body.occurredOn;
  if (body.memo !== undefined) patch.memo = body.memo;
  wrote(await pm(db).from('billing_requests').update(patch).eq('id', r.id).select('id'), 'billing request');
  return { ok: true };
});
