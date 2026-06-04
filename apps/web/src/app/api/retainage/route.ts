export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { getRetainageRegister, releaseRetainage } from '@/lib/services/retainage';

async function resolveOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

// ─── GET: retainage register (held / released / outstanding per bill) ─────────
export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await resolveOrgId(supabase);
  if (!orgId) {
    return NextResponse.json({ rows: [], totals: { withheldCents: 0, releasedCents: 0, outstandingCents: 0 } });
  }
  const overview = await getRetainageRegister(supabase, orgId);
  return NextResponse.json(overview);
}

// ─── POST: release (and pay) withheld retainage on a bill ─────────────────────
const releaseSchema = z.object({
  bill_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_method: z.string().max(40).optional(),
  memo: z.string().max(1000).optional(),
});

export async function POST(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = releaseSchema.safeParse(raw);
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

  const res = await releaseRetainage(supabase, {
    orgId,
    billId: parsed.data.bill_id,
    amountCents: parsed.data.amount_cents,
    releaseDate: parsed.data.release_date,
    method: parsed.data.payment_method,
    memo: parsed.data.memo,
  });

  if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(
    { release_id: res.releaseId, entry_number: res.entryNumber, outstanding_cents: res.outstandingCents },
    { status: 201 },
  );
}
