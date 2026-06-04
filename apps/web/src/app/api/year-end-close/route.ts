export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import {
  getYearEndOverview,
  computeYearEndClose,
  runYearEndClose,
  reverseYearEndClose,
} from '@/lib/services/year-end-close';

async function resolveOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

// ─── GET: per-entity net income + close status for a year ─────────────────────
export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear() - 1), 10);

  const orgId = await resolveOrgId(supabase);
  if (!orgId) {
    return NextResponse.json({ fiscalYear: year, rows: [], totals: { revenueCents: 0, expenseCents: 0, netIncomeCents: 0, closedCount: 0 } });
  }
  return NextResponse.json(await getYearEndOverview(supabase, orgId, year));
}

// ─── POST: preview / run / reverse ────────────────────────────────────────────
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), location_id: z.string().uuid(), year: z.number().int().min(2000).max(2100) }),
  z.object({ action: z.literal('run'), location_id: z.string().uuid(), year: z.number().int().min(2000).max(2100) }),
  z.object({ action: z.literal('reverse'), close_id: z.string().uuid(), reason: z.string().min(3).max(1000) }),
]);

export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  const supabase = createAdminSupabase();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', details }, { status: 422 });
  }

  const orgId = await resolveOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const body = parsed.data;

  if (body.action === 'preview') {
    const comp = await computeYearEndClose(supabase, orgId, body.location_id, body.year);
    return NextResponse.json({
      fiscalYear: comp.fiscalYear,
      closeDate: comp.closeDate,
      accounts: comp.accounts,
      revenueCents: comp.revenueCents,
      expenseCents: comp.expenseCents,
      netIncomeCents: comp.netIncomeCents,
      isEmpty: comp.isEmpty,
    });
  }

  if (body.action === 'run') {
    const res = await runYearEndClose(supabase, orgId, body.location_id, body.year, userId);
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ close_id: res.closeId, entry_number: res.entryNumber, net_income_cents: res.netIncomeCents }, { status: 201 });
  }

  // reverse
  const res = await reverseYearEndClose(supabase, orgId, body.close_id, body.reason, userId);
  if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
