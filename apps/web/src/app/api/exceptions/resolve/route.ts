export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/exceptions/resolve
 *
 * SAFE, non-financial dismissal for the unified "Needs Attention" queue. This
 * route ONLY moves a flagged/held/proposed record back out of its exception
 * state. It NEVER posts to the general ledger, never touches money movement or
 * approvals, and never marks anything as paid/posted. It is the "I looked, this
 * doesn't need me" button.
 *
 * Supported sources and the exact status transition each performs:
 *   - bank        bank_transactions  FLAGGED  -> PENDING   (transaction_status_enum)
 *   - receipt     receipts           FLAGGED  -> PENDING   (transaction_status_enum; PENDING is the table default / pre-flag review state)
 *   - bill        bills              ON_HOLD  -> PENDING   (bills_status_check) + clear payment_hold_reason
 *   - ai_proposal ai_decisions       PROPOSED -> REJECTED  (ai_decisions status check) + stamp disposition_by_user / disposition_at
 *
 * `approval` and `cost` are intentionally NOT resolvable here — they gate real
 * money and belong to their own approval flows. Requesting them returns 400.
 *
 * All writes go through the RLS-scoped client, so the database enforces org
 * isolation; this route never filters org_id by hand.
 */

const RESOLVABLE_SOURCES = ['bank', 'receipt', 'bill', 'ai_proposal'] as const;
type ResolvableSource = (typeof RESOLVABLE_SOURCES)[number];

const resolveSchema = z.object({
  source: z.enum(RESOLVABLE_SOURCES),
  id: z.string().uuid(),
});

const SUBJECT_TABLE: Record<ResolvableSource, string> = {
  bank: 'bank_transactions',
  receipt: 'receipts',
  bill: 'bills',
  ai_proposal: 'ai_decisions',
};

function badRequest(error: string, code: string, status = 400): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  // Parse + validate body
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('Invalid JSON body', 'PARSE_ERROR');
  }

  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  const { source, id } = parsed.data;

  // Perform the safe transition. Each branch verifies the record is actually in
  // its exception state before writing, so a double-click or stale row can't
  // silently move a record out of a valid working status.
  let updateError: string | null = null;

  if (source === 'bank') {
    const { data, error } = await supabase
      .from('bank_transactions')
      .update({ status: 'PENDING' })
      .eq('id', id)
      .eq('status', 'FLAGGED')
      .select('id')
      .maybeSingle();
    if (error) updateError = error.message;
    else if (!data) return badRequest('Transaction is not flagged', 'NOT_RESOLVABLE');
  } else if (source === 'receipt') {
    const { data, error } = await supabase
      .from('receipts')
      .update({ status: 'PENDING' })
      .eq('id', id)
      .eq('status', 'FLAGGED')
      .select('id')
      .maybeSingle();
    if (error) updateError = error.message;
    else if (!data) return badRequest('Receipt is not flagged', 'NOT_RESOLVABLE');
  } else if (source === 'bill') {
    const { data, error } = await supabase
      .from('bills')
      .update({ status: 'PENDING', payment_hold_reason: null })
      .eq('id', id)
      .eq('status', 'ON_HOLD')
      .select('id')
      .maybeSingle();
    if (error) updateError = error.message;
    else if (!data) return badRequest('Bill is not on hold', 'NOT_RESOLVABLE');
  } else {
    // ai_proposal
    const { data, error } = await supabase
      .from('ai_decisions')
      .update({
        status: 'REJECTED',
        disposition_by_user: userId,
        disposition_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'PROPOSED')
      .select('id')
      .maybeSingle();
    if (error) updateError = error.message;
    else if (!data) return badRequest('Proposal is no longer pending', 'NOT_RESOLVABLE');
  }

  if (updateError) {
    console.error('[exceptions/resolve] update failed:', updateError);
    return NextResponse.json(
      { error: 'Failed to resolve item', code: 'UPDATE_ERROR' },
      { status: 500 }
    );
  }

  // Trust log — never throws.
  if (orgId) {
    await logHumanAction(supabase, userId, orgId, {
      action: 'exception.resolve',
      subjectTable: SUBJECT_TABLE[source],
      subjectId: id,
      summary: `Resolved ${source} item`,
      metadata: { source },
    });
  }

  return NextResponse.json({ ok: true });
}
