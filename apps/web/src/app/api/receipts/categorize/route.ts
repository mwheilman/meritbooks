export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { suggestCategory } from '@/lib/services/categorization';

/**
 * POST /api/receipts/categorize
 *   { receipt_id }                       -> one receipt
 *   { all_pending: true, location_id? }  -> every uncoded PENDING receipt
 *
 * Runs the metered, decision-logged AI categorizer on receipts and writes the
 * suggested GL coding onto the row (account_id / department_id / vendor_id /
 * ai_confidence), flipping PENDING -> CATEGORIZED. The Receipts queue already
 * renders the GL category + confidence, so coded receipts appear in place.
 *
 * NOTE: this codes receipts; it does NOT post them. A receipt's posting/approval
 * path (POST /api/receipts/approve) does not yet exist and is tracked separately
 * — receipt posting must be reconciled with bank-feed matching to avoid
 * double-counting, so it is deliberately out of scope here.
 */
const schema = z.object({
  receipt_id: z.string().uuid().optional(),
  all_pending: z.boolean().optional(),
  location_id: z.string().uuid().nullable().optional(),
  force: z.boolean().optional(),
});

interface ReceiptRow {
  id: string;
  vendor_name: string | null;
  amount_cents: number | null;
  status: string;
  location_id: string | null;
  account_id: string | null;
  ai_extracted_data: Record<string, unknown> | null;
}

async function resolveOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

export async function POST(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
  const { receipt_id, all_pending, location_id, force } = parsed.data;

  if (!receipt_id && !all_pending) {
    return NextResponse.json({ error: 'Provide receipt_id or all_pending: true' }, { status: 422 });
  }

  const orgId = await resolveOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }, { status: 503 });

  let query = supabase
    .from('receipts')
    .select('id, vendor_name, amount_cents, status, location_id, account_id, ai_extracted_data')
    .eq('org_id', orgId);

  if (receipt_id) query = query.eq('id', receipt_id);
  else {
    query = query.eq('status', 'PENDING');
    if (location_id) query = query.eq('location_id', location_id);
    query = query.limit(100);
  }

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const receipts = (rows ?? []) as ReceiptRow[];
  let coded = 0;
  let skipped = 0;
  let failed = 0;
  let budgetBlocked = false;

  for (const r of receipts) {
    if (r.status === 'POSTED' || r.status === 'APPROVED') {
      skipped++;
      continue;
    }
    if (!force && r.account_id) {
      skipped++;
      continue;
    }
    const description = (r.vendor_name ?? '').trim();
    if (!description || r.amount_cents == null) {
      skipped++;
      continue;
    }

    const res = await suggestCategory(supabase, apiKey, {
      orgId,
      description: `${description} receipt`,
      amountCents: Math.abs(r.amount_cents),
      locationId: r.location_id,
    });

    if (!res.ok) {
      if (res.budgetBlocked) {
        budgetBlocked = true;
        break;
      }
      failed++;
      continue;
    }

    const s = res.suggestion;
    if (!s.accountId) {
      failed++;
      continue;
    }

    const merged = {
      ...(r.ai_extracted_data ?? {}),
      categorization: { confidence: s.confidence, reasoning: s.reasoning, source: s.source },
    };

    const { error: upErr } = await supabase
      .from('receipts')
      .update({
        account_id: s.accountId,
        department_id: s.departmentId,
        vendor_id: s.vendorId,
        ai_confidence: s.confidence,
        ai_extracted_data: merged,
        status: r.status === 'PENDING' ? 'CATEGORIZED' : r.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
      .eq('org_id', orgId);

    if (upErr) failed++;
    else coded++;
  }

  return NextResponse.json(
    { ok: true, processed: receipts.length, coded, skipped, failed, budget_blocked: budgetBlocked },
    { status: budgetBlocked && coded === 0 ? 402 : 200 },
  );
}
