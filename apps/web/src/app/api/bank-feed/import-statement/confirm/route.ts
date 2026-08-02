export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { dedupeKey, STATEMENT_IMPORT_SOURCE, STATEMENT_EXTRACT_FEATURE } from '@/lib/bank/statement-parse';

/**
 * POST /api/bank-feed/import-statement/confirm
 *
 * Persists the human-reviewed statement lines into `bank_transactions` for a
 * manual (non-Plaid) account. Each row is inserted with status='PENDING' and no
 * plaid_transaction_id, so it flows into the EXISTING categorize/reconcile pipeline
 * exactly like a Plaid-sourced line — the AI categorizer and the reconciliation
 * engine then treat it identically.
 *
 * Canon §3: this is the human-approval step. Nothing was written to bank_transactions
 * during parse (only an ai_decisions PROPOSED row). This route:
 *   1. re-guards the target account (must exist, must NOT be Plaid-linked),
 *   2. dedupes each line against existing rows (date + signed cents + normalized
 *      description) so a double-confirm never double-inserts,
 *   3. inserts the survivors, and
 *   4. best-effort marks the originating ai_decisions row CONFIRMED.
 *
 * Source provenance: there is NO `source`/`import_source` column and NO metadata
 * JSONB on bank_transactions (migrations 005/010/030/065), so the import is marked
 * via the existing free-text `category` column = 'STATEMENT_IMPORT'. The categorizer
 * does not read `category` (it keys off description/vendor patterns), and the feed
 * GET does not surface it, so this is inert w.r.t. downstream behavior. A dedicated
 * `source` column is REPORTED as a follow-up (would need a migration on the reserved
 * spine — not taken here).
 *
 * Access: gated on the existing `bank_feed` permission ('edit'). RLS scopes every write.
 */

const lineSchema = z.object({
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'transaction_date must be YYYY-MM-DD'),
  description: z.string().trim().min(1).max(500),
  amount_cents: z.number().int().refine((n) => n !== 0, 'amount_cents must be non-zero'),
});

const bodySchema = z.object({
  bank_account_id: z.string().uuid(),
  decision_id: z.string().uuid().nullish(),
  transactions: z.array(lineSchema).min(1, 'At least one transaction is required').max(2000),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { bank_account_id: bankAccountId, decision_id: decisionId, transactions } = parsed.data;

  // ── Resolve + guard the target account (RLS-scoped) ──────────────────────────
  const { data: acct, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, location_id, plaid_account_id, is_active')
    .eq('id', bankAccountId)
    .maybeSingle();
  if (acctErr) return NextResponse.json({ error: acctErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  const account = acct as { id: string; location_id: string; plaid_account_id: string | null; is_active: boolean } | null;
  if (!account) {
    return NextResponse.json({ error: 'Bank account not found', code: 'ACCOUNT_NOT_FOUND' }, { status: 404 });
  }
  if (account.plaid_account_id != null) {
    return NextResponse.json(
      {
        error:
          'This account is linked to Plaid — its live feed is authoritative. Statement import is only for manual (non-Plaid) accounts.',
        code: 'PLAID_LINKED',
      },
      { status: 409 },
    );
  }

  // ── Dedupe against existing rows in the imported date span (idempotent) ──────
  const dates = transactions.map((t) => t.transaction_date).sort();
  const existingKeyCounts = new Map<string, number>();
  const { data: existing } = await supabase
    .from('bank_transactions')
    .select('transaction_date, amount_cents, description')
    .eq('bank_account_id', bankAccountId)
    .gte('transaction_date', dates[0])
    .lte('transaction_date', dates[dates.length - 1]);
  for (const e of (existing ?? []) as Array<{ transaction_date: string; amount_cents: number; description: string }>) {
    const k = dedupeKey(e.transaction_date, e.amount_cents, e.description);
    existingKeyCounts.set(k, (existingKeyCounts.get(k) ?? 0) + 1);
  }

  const remaining = new Map(existingKeyCounts);
  const toInsert: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const t of transactions) {
    const k = dedupeKey(t.transaction_date, t.amount_cents, t.description);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      skipped += 1;
      continue;
    }
    toInsert.push({
      org_id: orgId,
      bank_account_id: bankAccountId,
      location_id: account.location_id,
      transaction_date: t.transaction_date,
      description: t.description.trim(),
      amount_cents: t.amount_cents,
      category: STATEMENT_IMPORT_SOURCE, // source marker (no dedicated column — see header)
      status: 'PENDING' as const,
    });
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const { error: insErr, count } = await supabase
      .from('bank_transactions')
      .insert(toInsert, { count: 'exact' });
    if (insErr) {
      return NextResponse.json({ error: insErr.message, code: 'INSERT_FAILED' }, { status: 500 });
    }
    inserted = count ?? toInsert.length;
  }

  // ── Best-effort: mark the originating proposal CONFIRMED ──────────────────────
  if (decisionId) {
    try {
      await supabase
        .from('ai_decisions')
        .update({ status: 'CONFIRMED' })
        .eq('id', decisionId)
        .eq('org_id', orgId)
        .eq('feature', STATEMENT_EXTRACT_FEATURE);
    } catch (e) {
      console.error('[import-statement/confirm] decision update failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({ ok: true, inserted, skipped, total: transactions.length });
}
