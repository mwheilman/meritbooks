export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadWorklist } from '@/lib/collections/data';

/**
 * GET /api/collections/worklist — the prioritized AR collections worklist.
 *
 * A workflow layer ON TOP of the existing AR aging / DSO surface
 * (/api/invoices/collections). Every account is ranked by overdue-dollars × age ×
 * dossier-risk (with a broken-promise boost), carries its cadence stage + a
 * recommended next action, and surfaces pending/broken promises-to-pay. Pure
 * computation from real, RLS-scoped ledger data — no writes, no demo arrays.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const asOf = searchParams.get('as_of') ?? undefined;
  const locationId = searchParams.get('location_id');

  try {
    const result = await loadWorklist(supabase, orgId, { asOf, locationId });
    return NextResponse.json(result);
  } catch (e) {
    console.error('[collections worklist] failed', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load worklist' },
      { status: 500 },
    );
  }
}
