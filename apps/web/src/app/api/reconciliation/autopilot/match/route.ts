export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { logAction, logHumanAction } from '@/lib/trust/action-log';
import { toMatchConfidence } from '@/lib/services/reconciliation-match';

/**
 * POST /api/reconciliation/autopilot/match
 *
 * Human disposition of an AI-proposed reconciliation match. Three actions:
 *
 *   • accept (bill)    → stage the statement line as settling an open bill:
 *                        matched_bill_id + match_type='BILL_PAYMENT' + confidence.
 *                        This is exactly what /api/bank-feed/approve reads to clear
 *                        Accounts Payable instead of re-expensing, so accepting here
 *                        pre-wires the clean settlement.
 *   • accept (pattern) → stamp the AI vendor/category pattern the row already
 *                        carries: match_type='VENDOR_PATTERN' + final_vendor_id +
 *                        confidence, so posting picks it up.
 *   • reject           → FLAG the line (status='FLAGGED'). It leaves the autopilot
 *                        and surfaces in the unified /exceptions "Needs Attention"
 *                        queue (bank source), where it can be resolved by hand.
 *
 * This route NEVER posts to the general ledger and never marks anything PAID/POSTED
 * — clearing to the book stays the job of the approve/posting path. It only records
 * the match intent + a full audit trail (AI proposal + human decision) in
 * core.action_log via the trust layer.
 *
 * All writes go through the RLS-scoped client, so the database enforces org
 * isolation.
 */

const matchSchema = z
  .object({
    transaction_id: z.string().uuid(),
    action: z.enum(['accept', 'reject']),
    candidate_type: z.enum(['bill', 'pattern', 'none']).optional(),
    candidate_id: z.string().uuid().nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    tier: z.enum(['auto', 'review', 'escalate']).optional(),
  })
  .refine((v) => v.action === 'reject' || v.candidate_type, {
    message: 'candidate_type is required to accept a match',
    path: ['candidate_type'],
  })
  .refine((v) => !(v.action === 'accept' && v.candidate_type === 'bill') || !!v.candidate_id, {
    message: 'candidate_id (bill id) is required to accept a bill match',
    path: ['candidate_id'],
  });

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = matchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const body = parsed.data;

  // Load the line (RLS scopes to org). Confirm it exists and isn't already posted.
  const { data: txn, error: txnErr } = await supabase
    .from('bank_transactions')
    .select('id, status, gl_entry_id, description, amount_cents, ai_vendor_id, location_id, reconciled_at')
    .eq('id', body.transaction_id)
    .maybeSingle();
  if (txnErr) {
    console.error('[recon/match] load failed:', txnErr.message);
    return NextResponse.json({ error: 'Failed to load transaction' }, { status: 500 });
  }
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  const t = txn as {
    id: string;
    status: string;
    gl_entry_id: string | null;
    description: string | null;
    amount_cents: number | string;
    ai_vendor_id: string | null;
    location_id: string | null;
    reconciled_at: string | null;
  };
  if (t.status === 'POSTED' && t.gl_entry_id) {
    return NextResponse.json({ error: 'Transaction is already cleared to the GL' }, { status: 400 });
  }
  if (t.reconciled_at != null) {
    return NextResponse.json(
      { error: 'Transaction is locked by a finalized reconciliation — undo it first' },
      { status: 409 },
    );
  }

  const confidence = body.confidence != null ? toMatchConfidence(body.confidence) : null;

  // ── REJECT → flag into the exception queue ───────────────────────────────────
  if (body.action === 'reject') {
    const { data, error } = await supabase
      .from('bank_transactions')
      .update({ status: 'FLAGGED' })
      .eq('id', body.transaction_id)
      .neq('status', 'POSTED')
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[recon/match] reject failed:', error.message);
      return NextResponse.json({ error: 'Failed to flag transaction' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Transaction can no longer be flagged' }, { status: 400 });

    await logHumanAction(supabase, userId, orgId, {
      action: 'reconciliation.match.reject',
      subjectTable: 'bank_transactions',
      subjectId: body.transaction_id,
      summary: `Rejected match for "${t.description ?? 'bank transaction'}" — sent to exceptions`,
      locationId: t.location_id,
      confidence,
      tier: body.tier ?? null,
      metadata: { candidateType: body.candidate_type ?? 'none' },
    });

    return NextResponse.json({ ok: true, action: 'reject', status: 'FLAGGED' });
  }

  // ── ACCEPT ───────────────────────────────────────────────────────────────────
  let update: Record<string, unknown>;
  let summary: string;

  if (body.candidate_type === 'bill') {
    // Verify the bill exists, is settleable, and belongs to the same location.
    const { data: bill, error: billErr } = await supabase
      .from('bills')
      .select('id, status, balance_cents, location_id, bill_number')
      .eq('id', body.candidate_id as string)
      .maybeSingle();
    if (billErr) {
      console.error('[recon/match] bill load failed:', billErr.message);
      return NextResponse.json({ error: 'Failed to load bill' }, { status: 500 });
    }
    if (!bill) return NextResponse.json({ error: 'Bill not found' }, { status: 404 });
    const b = bill as { id: string; status: string; balance_cents: number | string; location_id: string; bill_number: string | null };
    if (t.location_id && b.location_id && t.location_id !== b.location_id) {
      return NextResponse.json({ error: 'Bill belongs to a different company than the bank line' }, { status: 400 });
    }
    if (['PAID', 'VOIDED'].includes(b.status)) {
      return NextResponse.json({ error: 'Bill is already settled or voided' }, { status: 400 });
    }

    update = {
      matched_bill_id: b.id,
      match_type: 'BILL_PAYMENT',
      match_confidence: confidence,
    };
    summary = `Matched "${t.description ?? 'bank transaction'}" to bill ${b.bill_number ?? b.id.slice(0, 8)}`;
  } else if (body.candidate_type === 'pattern') {
    update = {
      match_type: 'VENDOR_PATTERN',
      match_confidence: confidence,
      // Carry the AI-suggested vendor forward if the row (or request) has one.
      final_vendor_id: body.candidate_id ?? t.ai_vendor_id ?? null,
    };
    summary = `Accepted AI pattern match for "${t.description ?? 'bank transaction'}"`;
  } else {
    return NextResponse.json({ error: 'Cannot accept a "none" candidate — reject or edit instead' }, { status: 400 });
  }

  const { data: updated, error: updErr } = await supabase
    .from('bank_transactions')
    .update(update)
    .eq('id', body.transaction_id)
    .neq('status', 'POSTED')
    .select('id')
    .maybeSingle();
  if (updErr) {
    console.error('[recon/match] accept update failed:', updErr.message);
    return NextResponse.json({ error: 'Failed to record match' }, { status: 500 });
  }
  if (!updated) return NextResponse.json({ error: 'Transaction can no longer be matched' }, { status: 400 });

  // Audit trail: the AI proposal, then the human acceptance — both in action_log.
  await logAction(supabase, {
    orgId,
    actorType: 'AI',
    action: 'reconciliation.match.proposed',
    subjectTable: 'bank_transactions',
    subjectId: body.transaction_id,
    summary: `AI proposed ${body.candidate_type} match (composite score)`,
    locationId: t.location_id,
    confidence,
    tier: body.tier ?? null,
    metadata: { candidateType: body.candidate_type, candidateId: body.candidate_id ?? null },
  });
  await logHumanAction(supabase, userId, orgId, {
    action: 'reconciliation.match.accept',
    subjectTable: 'bank_transactions',
    subjectId: body.transaction_id,
    summary,
    locationId: t.location_id,
    confidence,
    tier: body.tier ?? null,
    metadata: { candidateType: body.candidate_type, candidateId: body.candidate_id ?? null },
  });

  return NextResponse.json({ ok: true, action: 'accept', candidateType: body.candidate_type });
}
