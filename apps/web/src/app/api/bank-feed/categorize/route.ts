export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { suggestCategory, CATEGORIZE_MODEL } from '@/lib/services/categorization';

/**
 * POST /api/bank-feed/categorize
 *   { transaction_id }                         -> one transaction
 *   { transaction_ids: [...] }                 -> a specific set
 *   { all_pending: true, location_id? }        -> every uncoded PENDING transaction
 *
 * Runs the metered, decision-logged AI categorizer (lib/services/categorization)
 * on bank-feed items and writes its suggestion onto the row's AI columns
 * (ai_account_id / ai_vendor_id / ai_department_id / ai_confidence / ai_reasoning),
 * flipping PENDING -> CATEGORIZED when an account is resolved. The existing Bank
 * Feed review UI already renders those columns and approves with
 * `final_account ?? ai_account`, so coded items are reviewable and postable in
 * place — no separate categorizer page.
 *
 * Tier-1 vendor-pattern matches are free; only novel descriptions spend a gateway
 * call. A budget block stops the batch and reports what was done so far.
 *
 * PERFORMANCE (Session 25): transactions are coded in BOUNDED-PARALLEL batches
 * (CONCURRENCY at a time) rather than strictly sequentially. 48 novel txns went
 * from ~10 min (one ~10s gateway call after another) to well under 90s. The
 * budget-block early-exit is preserved at the batch boundary: as soon as any
 * call in a batch reports budgetBlocked, we stop launching new batches and
 * report partial progress.
 */
const schema = z.object({
  transaction_id: z.string().uuid().optional(),
  transaction_ids: z.array(z.string().uuid()).max(200).optional(),
  all_pending: z.boolean().optional(),
  location_id: z.string().uuid().nullable().optional(),
  /** Re-code rows that already have an AI suggestion. Default false. */
  force: z.boolean().optional(),
});

interface TxnRow {
  id: string;
  description: string;
  amount_cents: number;
  status: string;
  location_id: string | null;
  ai_account_id: string | null;
}

/** Max gateway calls in flight at once. Tuned for the ~10s/call latency: 8 keeps
 *  the Anthropic side comfortable while cutting wall-clock ~8x. */
const CONCURRENCY = 8;

type CodeOutcome =
  | { kind: 'coded' }
  | { kind: 'skipped' }
  | { kind: 'failed' }
  | { kind: 'budget' };

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
  const { transaction_id, transaction_ids, all_pending, location_id, force } = parsed.data;

  if (!transaction_id && !transaction_ids?.length && !all_pending) {
    return NextResponse.json({ error: 'Provide transaction_id, transaction_ids, or all_pending: true' }, { status: 422 });
  }

  const orgId = await resolveOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }, { status: 503 });

  // Resolve the working set.
  let query = supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, status, location_id, ai_account_id')
    .eq('org_id', orgId);

  if (transaction_id) query = query.eq('id', transaction_id);
  else if (transaction_ids?.length) query = query.in('id', transaction_ids);
  else {
    query = query.eq('status', 'PENDING');
    if (location_id) query = query.eq('location_id', location_id);
    query = query.limit(100); // bound a single batch
  }

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const allTxns = (rows ?? []) as TxnRow[];

  // Partition up-front: terminal / already-coded / empty rows are skipped without
  // ever touching the gateway, so only the genuinely-codable set is parallelized.
  const codable: TxnRow[] = [];
  let skipped = 0;
  for (const txn of allTxns) {
    if (txn.status === 'POSTED' || txn.status === 'APPROVED') { skipped++; continue; }
    if (!force && txn.ai_account_id) { skipped++; continue; }
    if (!txn.description?.trim()) { skipped++; continue; }
    codable.push(txn);
  }

  let coded = 0;
  let failed = 0;
  let budgetBlocked = false;

  /** Code one transaction: run the categorizer, persist its suggestion. */
  async function codeOne(txn: TxnRow): Promise<CodeOutcome> {
    const res = await suggestCategory(supabase, apiKey!, {
      orgId: orgId!,
      description: txn.description,
      amountCents: Math.abs(txn.amount_cents),
      locationId: txn.location_id,
    });

    if (!res.ok) {
      if (res.budgetBlocked) return { kind: 'budget' };
      return { kind: 'failed' };
    }

    const s = res.suggestion;
    if (!s.accountId) return { kind: 'failed' };

    const { error: upErr } = await supabase
      .from('bank_transactions')
      .update({
        ai_account_id: s.accountId,
        ai_vendor_id: s.vendorId,
        ai_department_id: s.departmentId,
        ai_confidence: s.confidence,
        ai_reasoning: s.reasoning,
        ai_model_version: s.source === 'ai' ? CATEGORIZE_MODEL : 'vendor-pattern',
        status: txn.status === 'PENDING' ? 'CATEGORIZED' : txn.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', txn.id)
      .eq('org_id', orgId!);

    return upErr ? { kind: 'failed' } : { kind: 'coded' };
  }

  // Process in bounded-parallel batches; stop launching new batches once the
  // budget is exhausted (the in-flight batch still finishes and is tallied).
  for (let i = 0; i < codable.length; i += CONCURRENCY) {
    const batch = codable.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map(codeOne));
    for (const o of outcomes) {
      if (o.kind === 'coded') coded++;
      else if (o.kind === 'failed') failed++;
      else if (o.kind === 'budget') budgetBlocked = true;
    }
    if (budgetBlocked) break;
  }

  return NextResponse.json(
    {
      ok: true,
      processed: allTxns.length,
      coded,
      skipped,
      failed,
      budget_blocked: budgetBlocked,
    },
    { status: budgetBlocked && coded === 0 ? 402 : 200 },
  );
}
