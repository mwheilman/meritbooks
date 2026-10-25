export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { MoneyError, callRpc, moneyError } from '@/lib/pm/money/rpc';
import { HttpError } from '@/lib/api-errors';
import { decideObject } from '@/lib/approvals/server';
import { Uuid } from '@/lib/pm/money/schemas';

const Body = z.object({ ids: z.array(Uuid).min(1).max(50) });

export interface BulkResult {
  id: string;
  ok: boolean;
  status?: 'EMITTED' | 'UNISSUED' | 'PENDING_APPROVAL';
  /** Who it waits on when the engine recorded this approver's step but more steps remain. */
  waitingOn?: string | null;
  error?: string;
  code?: string;
  preconditions?: string[];
}

/**
 * Approve several billing requests in one go. Each runs on its own (one refusal never
 * blocks the rest) and reports back per row — separation of duties included.
 */
export const POST = route({ access: { cap: 'projects.billing', action: 'approve' }, mask: 'billing', body: Body }, async ({ db, body }) => {
  const results: BulkResult[] = [];
  for (const id of [...new Set(body.ids)]) {
    try {
      // through the approvals engine (1113); approve_and_emit_billing runs at the last step
      const a = await decideObject(db, 'billing_request', id, { objectError: (e) => moneyError(e, 'billing request') });
      if (a.status === 'not_needed') {
        const eventId = await callRpc<string | null>(db, 'approve_and_emit_billing', { p_request: id }, 'billing request');
        results.push({ id, ok: true, status: eventId ? 'EMITTED' : 'UNISSUED' });
      } else if (a.status === 'approved') {
        results.push({ id, ok: true, status: a.result?.event_id ? 'EMITTED' : 'UNISSUED' });
      } else {
        results.push({ id, ok: a.status === 'pending', status: 'PENDING_APPROVAL', waitingOn: a.waiting_on ?? null, error: a.status === 'pending' ? undefined : a.message ?? undefined, code: a.status.toUpperCase() });
      }
    } catch (e) {
      if (e instanceof MoneyError) results.push({ id, ok: false, error: e.message, code: e.code, preconditions: e.preconditions });
      else if (e instanceof HttpError) results.push({ id, ok: false, error: e.message, code: e.code });
      else throw e;
    }
  }
  return { results, approved: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length };
});
