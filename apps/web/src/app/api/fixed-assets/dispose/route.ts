export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { previewAssetDisposal, recordAssetDisposal, type DisposeAssetInput } from '@/lib/posting/asset-disposal';
import { PostingError } from '@/lib/posting/account-roles';
import type { PaymentRail } from '@/lib/posting/transaction-types';

/**
 * POST /api/fixed-assets/dispose
 *   { assetId, disposalDate, proceedsCents, rail?, cashAccountId?, preview? }
 *
 * preview=true  → compute the gain/loss and the exact balanced entry, post NOTHING
 *                 (the human sees it before confirming).
 * preview=false → post the disposal and mark the asset DISPOSED.
 *
 * Deterministic posting: the model is never involved. Invalid states (already
 * disposed, negative proceeds, missing gain/loss account) are refused, not posted.
 */
export async function POST(request: Request) {
  const a = await auth().catch(() => null);
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const assetId = typeof body.assetId === 'string' ? body.assetId : null;
  const disposalDate = typeof body.disposalDate === 'string' ? body.disposalDate : null;
  const proceedsCents = Number.isFinite(Number(body.proceedsCents)) ? Math.round(Number(body.proceedsCents)) : null;
  const preview = body.preview === true;
  const rail = typeof body.rail === 'string' ? (body.rail as PaymentRail) : undefined;
  const cashAccountId = typeof body.cashAccountId === 'string' ? body.cashAccountId : undefined;

  if (!assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 422 });
  if (proceedsCents === null || proceedsCents < 0) {
    return NextResponse.json({ error: 'proceedsCents must be a non-negative integer (cents)' }, { status: 422 });
  }
  if (!preview && !disposalDate) {
    return NextResponse.json({ error: 'disposalDate is required to post a disposal' }, { status: 422 });
  }

  const supabase = await createServerSupabase();
  try {
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const input: DisposeAssetInput = {
      orgId,
      assetId,
      disposalDate: disposalDate ?? new Date().toISOString().slice(0, 10),
      proceedsCents,
      rail,
      cashAccountId,
    };

    if (preview) {
      const result = await previewAssetDisposal(supabase, input);
      return NextResponse.json({ ok: true, preview: true, ...result });
    }

    const result = await recordAssetDisposal(supabase, input);
    return NextResponse.json({ ok: true, preview: false, ...result });
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Disposal failed' }, { status });
  }
}
