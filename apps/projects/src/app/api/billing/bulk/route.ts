export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { MoneyError, callRpc } from '@/lib/pm/money/rpc';
import { Uuid } from '@/lib/pm/money/schemas';

const Body = z.object({ ids: z.array(Uuid).min(1).max(50) });

export interface BulkResult {
  id: string;
  ok: boolean;
  status?: 'EMITTED' | 'UNISSUED';
  error?: string;
  code?: string;
  preconditions?: string[];
}

/**
 * Approve several billing requests in one go. Each runs on its own (one refusal never
 * blocks the rest) and reports back per row — separation of duties included.
 */
export const POST = route({ body: Body }, async ({ db, body }) => {
  const results: BulkResult[] = [];
  for (const id of [...new Set(body.ids)]) {
    try {
      const eventId = await callRpc<string | null>(db, 'approve_and_emit_billing', { p_request: id }, 'billing request');
      results.push({ id, ok: true, status: eventId ? 'EMITTED' : 'UNISSUED' });
    } catch (e) {
      if (e instanceof MoneyError) results.push({ id, ok: false, error: e.message, code: e.code, preconditions: e.preconditions });
      else throw e;
    }
  }
  return { results, approved: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length };
});
