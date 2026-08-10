export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { listOriginationBatches } from '@/lib/money/origination';

/**
 * GET /api/ap/origination/list — the origination batches (+ per-payee items) for the
 * org, newest first, with vendor display names joined for the UI. READ-ONLY: no
 * money moves, nothing posts to the GL. RLS scopes every read to the caller's org;
 * the /checks page already gates who reaches this money surface.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const batches = await listOriginationBatches(supabase, orgId);

    // Join vendor display names for the item rows (best-effort; degrades to id).
    const vendorIds = Array.from(
      new Set(batches.flatMap((b) => b.items.map((i) => i.vendorId)).filter((v): v is string => !!v)),
    );
    const vendorNameById = new Map<string, string>();
    if (vendorIds.length > 0) {
      const { data: vData } = await supabase
        .schema('core')
        .from('vendors')
        .select('id, name, display_name')
        .in('id', vendorIds);
      for (const v of (vData ?? []) as Array<{ id: string; name: string; display_name: string | null }>) {
        vendorNameById.set(v.id, v.display_name || v.name);
      }
    }

    const shaped = batches.map((b) => ({
      ...b,
      items: b.items.map((i) => ({
        ...i,
        vendorName: i.vendorId ? vendorNameById.get(i.vendorId) ?? null : null,
      })),
    }));

    return NextResponse.json({ batches: shaped });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load origination batches' }, { status: 500 });
  }
}
