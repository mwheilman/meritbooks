export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { screenPayment, type ScreenResult, type RiskLevel } from '@/lib/controls/payment-fraud';

/**
 * Payment-Run Fraud Screen — EC "PAYMENT_FRAUD" (detect + screen; NEVER moves money).
 *
 * POST /api/controls/payment-fraud
 *   Body: { billId }  OR  { billIds: [...] }  (+ optional amountCents, explain)
 *
 * Screens a pending AP disbursement (a bill about to be paid) — or a batch — for
 * new-payee, bank-detail-change (BEC), unusual-amount, duplicate, and round-dollar
 * first-large indicators, computed DETERMINISTICALLY from the payment + the vendor's
 * own history. Returns a risk verdict per payment and writes a PROPOSED row to
 * ai_decisions (feature PAYMENT_FRAUD) for any review/block verdict, so it surfaces
 * in /exceptions.
 *
 * This endpoint DETECTS ONLY. It never releases, voids, or posts anything — money
 * movement stays in the gated release path (lib/money/approvals.ts). A block/review
 * verdict requires an explicit human override there before cash moves; this route
 * exists to compute and surface that verdict.
 *
 * Read/write run through the RLS-scoped client, so the database enforces org
 * isolation; the route never filters org_id by hand.
 *
 * AUTHORIZATION: gated on `bills:approve` — money-movement approval authority on the
 * AP surface (the reviewer of a payment run). NOTE(NEEDS CENTRAL): there is still no
 * dedicated `payments` permission in rbac/permissions.ts (task #33); `bills:approve`
 * is the closest fit for "may review/authorize a disbursement". See the report.
 */

const bodySchema = z
  .object({
    billId: z.string().uuid().optional(),
    billIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    amountCents: z.number().int().positive().optional(),
    explain: z.boolean().optional(),
  })
  .refine((b) => !!b.billId || (!!b.billIds && b.billIds.length > 0), {
    message: 'Provide billId or a non-empty billIds array.',
  });

interface BatchSummary {
  screened: number;
  clear: number;
  review: number;
  block: number;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'bills', 'approve');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;

  const anthropicApiKey = getAnthropicApiKey();
  const useAiExplanation = body.explain === true && !!anthropicApiKey;

  const ids = body.billIds ?? (body.billId ? [body.billId] : []);

  const results: ScreenResult[] = [];
  for (const id of ids) {
    // Serial: keeps memory + gateway concurrency low; batches are small (≤200).
    const res = await screenPayment(supabase, orgId, id, {
      amountCentsOverride: body.billIds ? undefined : body.amountCents,
      actorClerkUserId: userId,
      useAiExplanation,
      anthropicApiKey,
    });
    results.push(res);
  }

  const summary: BatchSummary = { screened: results.length, clear: 0, review: 0, block: 0 };
  for (const r of results) summary[r.verdict.level as RiskLevel] += 1;

  // Single-subject callers get the flat verdict; batch callers get the array.
  if (body.billId && !body.billIds) {
    const only = results[0];
    return NextResponse.json({ data: only, summary });
  }
  return NextResponse.json({ data: results, summary });
}
