export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { recordImpairment } from '@/lib/intangibles/amortization';

/**
 * POST /api/intangibles/impair
 *   { assetId: string, amountCents: number, impairmentDate?: 'YYYY-MM-DD', memo?: string }
 *
 * Records a manual impairment write-down on an intangible — the ASC 350 path for
 * goodwill (which is never amortized) and for any impaired finite-lived intangible.
 * Posts DR Impairment Loss / CR Accumulated Amortization and marks the asset
 * IMPAIRED. The write-down cannot exceed the asset's current net book value.
 * RLS-scoped write.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  assetId?: unknown;
  amountCents?: unknown;
  impairmentDate?: unknown;
  memo?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
  if (!assetId) return NextResponse.json({ error: 'assetId is required', code: 'VALIDATION' }, { status: 422 });

  const amountCents = Number(body.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: 'amountCents must be a positive integer (bigint cents)', code: 'VALIDATION' }, { status: 422 });
  }

  const impairmentDate =
    typeof body.impairmentDate === 'string' && ISO_DATE.test(body.impairmentDate) ? body.impairmentDate : undefined;
  const memo = typeof body.memo === 'string' && body.memo.trim() !== '' ? body.memo : undefined;

  const result = await recordImpairment(supabase, orgId, assetId, amountCents, { impairmentDate, memo });
  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Impairment failed', code: 'IMPAIRMENT_FAILED' }, { status: 422 });
  }

  return NextResponse.json({
    ok: true,
    entryId: result.entry_id,
    entryNumber: result.entry_number,
    newAccumulatedCents: result.new_accumulated_cents,
    newNetBookValueCents: result.new_net_book_value_cents,
  });
}
