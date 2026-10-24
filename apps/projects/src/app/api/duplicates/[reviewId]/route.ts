export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError, splitToken } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { loadReviewPair } from '@/lib/crm/duplicates';
import { choicesPayload } from '@/lib/crm/merge';
import { ReviewActionBody } from '@/lib/crm/schemas';
import { dismissArgs, mergeArgs } from '@/lib/crm/contract';

/** Both records of a pair side by side, and what each would bring on a merge. */
export const GET = route({ access: { cap: 'projects.customers', action: 'view' }, mask: false }, async ({ db, params }) => {
  const pair = await loadReviewPair(db, params.reviewId!);
  if (!pair) throw new HttpError(404, 'That pair was already resolved or one of the records is gone.', 'NOT_FOUND');
  return pair;
});

/**
 * Resolve a pair: merge (core.merge_parties, the chosen record kept, the other archived with
 * merged_into, every reference repointed, Books amounts and dates untouched) or "Not a duplicate"
 * (core.dismiss_duplicate; the pair is never suggested again).
 */
export const POST = route({ access: { cap: 'projects.customers', action: 'edit' }, mask: false, body: ReviewActionBody }, async ({ db, params, body }) => {
  const pair = await loadReviewPair(db, params.reviewId!);
  if (!pair) throw new HttpError(404, 'That pair was already resolved.', 'NOT_FOUND');
  if (body.op === 'dismiss') {
    const r = await db.schema('core').rpc('dismiss_duplicate', dismissArgs(pair.review.id));
    if (r.error) throw new PmQueryError('not a duplicate', r.error);
    return { ok: true, op: 'dismiss' };
  }
  if (body.survivorId !== pair.a.id && body.survivorId !== pair.b.id) throw new HttpError(422, 'Keep one of the two records.', 'VALIDATION');
  const victim = body.survivorId === pair.a.id ? pair.b : pair.a;
  const r = await db.schema('core').rpc('merge_parties', mergeArgs(pair.review.kind, body.survivorId, victim.id, choicesPayload(pair.review.kind, body.fields)));
  if (r.error) {
    const { token } = splitToken(r.error.message);
    if (token === 'CORE_MERGE_BOOKS_CONFLICT') {
      throw new HttpError(422, 'The two records have different payment terms, credit, tax or retainage settings. Merit Books settles those first; merge from Books, or ask someone with Books customer access.', token);
    }
    if (token === 'CORE_MERGE_BOOKS_AUTHORITY') throw new HttpError(403, 'Only an owner or someone with Books customer access can choose between Books settings.', token);
    if (token === 'CORE_MERGE_ARCHIVED') throw new HttpError(409, 'One of the records was already merged or archived. Refresh the queue.', token);
    throw new PmQueryError('merge', r.error);
  }
  return { ok: true, op: 'merge', survivorId: body.survivorId, moved: movedRows(r.data) };
});

/** Rows repointed by core.merge_parties (its jsonb summary: repointed[{table, column, rows}]). */
function movedRows(v: unknown): number {
  const rep = typeof v === 'object' && v !== null ? (v as { repointed?: unknown }).repointed : null;
  return Array.isArray(rep) ? rep.reduce<number>((s, x) => s + (typeof x === 'object' && x !== null && typeof (x as { rows?: unknown }).rows === 'number' ? (x as { rows: number }).rows : 0), 0) : 0;
}
