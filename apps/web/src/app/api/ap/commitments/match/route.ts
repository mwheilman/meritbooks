export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { CommitmentMatchError, matchBillLine } from '@/lib/projects-seam/commitment-match';
import { logHumanAction } from '@/lib/trust/action-log';
import { isWriteScopeError } from '@/lib/db/scoped-writer';

/**
 * POST /api/ap/commitments/match { bill_line_id, commitment_line_id | null } — match an existing
 * bill line to a Merit Projects commitment line (or clear the match). Re-scores the 3-way status
 * and applies the commitment's payment hold to the bill if it is on hold. bills:create (the AP
 * entry right); reads are RLS-scoped, the writes go through the service role after this check.
 */
const body = z.object({
  bill_line_id: z.string().uuid(),
  commitment_line_id: z.string().uuid().nullable(),
});

export const POST = apiHandler(body, async (b, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'bills', 'create', { route: '/api/ap/commitments/match' });
  if (!guard.ok) return guard.response;
  try {
    const r = await matchBillLine(supabase, orgId, { billLineId: b.bill_line_id, commitmentLineId: b.commitment_line_id, matchedBy: userId });
    await logHumanAction(supabase, userId, orgId, {
      action: b.commitment_line_id ? 'bill.commitment_match' : 'bill.commitment_unmatch',
      subjectTable: 'bill_lines',
      subjectId: b.bill_line_id,
      summary: b.commitment_line_id ? `Matched bill line to a Projects commitment (${r.status ?? 'OK'})` : 'Cleared the Projects commitment match',
    });
    return NextResponse.json({ ok: true, three_way_status: r.status, held: r.held });
  } catch (e) {
    if (e instanceof CommitmentMatchError) return NextResponse.json({ error: e.message, code: 'COMMITMENT_MATCH_INVALID' }, { status: 422 });
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    console.error('[ap/commitments/match]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not match the bill line. Please try again.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
});
