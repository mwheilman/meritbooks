export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { runAmortization } from '@/lib/intangibles/amortization';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/intangibles/amortize
 *   { asOf?: 'YYYY-MM-DD', assetId?: string }
 *
 * Posts all due monthly amortization for the org's ACTIVE intangibles up to `asOf`
 * (defaults to today). When `assetId` is given, restricts to that asset. Goodwill /
 * indefinite-lived intangibles are skipped (impairment-only). Idempotent — a re-run
 * never double-posts (the `depreciation_runs` per-period guard). RLS-scoped write.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  asOf?: unknown;
  assetId?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — amortization posts to the GL; gate on the fixed-asset create permission.
  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let body: Body = {};
  try {
    body = (await request.json().catch(() => ({}))) as Body;
  } catch {
    body = {};
  }

  const asOf = typeof body.asOf === 'string' && ISO_DATE.test(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);
  const assetId = typeof body.assetId === 'string' && body.assetId.trim() !== '' ? body.assetId : undefined;

  try {
    const result = await runAmortization(supabase, orgId, asOf, assetId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof PostingError ? e.message : e instanceof Error ? e.message : 'Amortization run failed';
    return NextResponse.json({ error: msg, code: 'AMORTIZATION_FAILED' }, { status: 422 });
  }
}
