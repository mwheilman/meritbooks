export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { extractCategorize } from '@/lib/nl/lanes/categorize';
import {
  makeLaneGateway,
  logLaneDecision,
  gatewayClientMeta,
  BudgetBlockedError,
} from '@/lib/nl/lanes/server';
import { resolveAccountByHint, fetchAccountLabels } from '@/lib/nl/lanes/resolve';

/**
 * POST /api/nl/categorize — P2 categorize/code PROPOSE step.
 *
 * NL → {merchant, target account, count}. Finds the matching bank-feed lines
 * (RLS-scoped), proposes a GL coding per line — the account the user named
 * (resolved against the approved COA) or the existing AI categorizer's suggestion
 * already on the row — and returns them for review. POSTS NOTHING. Approval routes
 * per line through the EXISTING gated /api/bank-feed/approve (which posts the
 * balanced JE with period/balance/COA gates). Writes an ai_decisions PROPOSED row.
 * Clarify-before-book: no identifiable merchant → one question, no scan.
 *
 * Gated on bank_feed:edit — the coding write path.
 */

const NL_FEATURE = 'NL_CATEGORIZE';
const schema = z.object({ prompt: z.string().min(2).max(2000) });

interface TxnRow {
  id: string;
  description: string;
  amount_cents: number;
  transaction_date: string;
  status: string;
  location_id: string | null;
  ai_account_id: string | null;
  ai_confidence: number | null;
  final_account_id: string | null;
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const supabase = ctx.supabase as SupabaseClient;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) return NextResponse.json({ error: 'AI is not configured.', code: 'NO_API_KEY' }, { status: 503 });

  let body: z.infer<typeof schema>;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const gw = makeLaneGateway({ admin, apiKey, orgId, userId, feature: NL_FEATURE });

  let extraction;
  try {
    extraction = await extractCategorize(body.prompt, gw.call);
  } catch (e) {
    if (e instanceof BudgetBlockedError) {
      return NextResponse.json({ error: e.message, code: 'BUDGET_BLOCKED' }, { status: 402 });
    }
    return NextResponse.json({ error: 'The categorizer could not run.', code: 'GATEWAY_ERROR' }, { status: 502 });
  }

  if (!extraction.draft) {
    await logLaneDecision(admin, {
      orgId, feature: NL_FEATURE, gateway: gw.meta(), inputSummary: body.prompt,
      proposedOutput: { clarify: extraction.clarifyingQuestion }, confidence: extraction.confidence,
      clarifyingQuestion: extraction.clarifyingQuestion, userId,
    });
    return NextResponse.json({
      clarifyingQuestion: extraction.clarifyingQuestion,
      candidates: [],
      gateway: gatewayClientMeta(gw.meta()),
    });
  }

  const { vendorQuery, accountHint, limit } = extraction.draft;

  // The account the user named (any type — they were explicit). Applied to every line.
  const hintAccount = accountHint ? await resolveAccountByHint(supabase, accountHint, []) : null;

  // Find uncoded/reviewable feed lines for this merchant (RLS-scoped; never POSTED).
  const { data: rows, error } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date, status, location_id, ai_account_id, ai_confidence, final_account_id')
    .ilike('description', `%${vendorQuery}%`)
    .not('status', 'in', '("POSTED","APPROVED")')
    .order('transaction_date', { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const txns = (rows ?? []) as TxnRow[];

  // Resolve labels for every proposed account (hint + any existing suggestions).
  const acctIds = [hintAccount?.id, ...txns.map((t) => t.final_account_id ?? t.ai_account_id)].filter(
    (v): v is string => Boolean(v),
  );
  const labels = await fetchAccountLabels(supabase, acctIds);

  const candidates = txns.map((t) => {
    const proposedAccountId = hintAccount?.id ?? t.final_account_id ?? t.ai_account_id ?? null;
    return {
      transactionId: t.id,
      description: t.description,
      amountCents: t.amount_cents,
      transactionDate: t.transaction_date,
      status: t.status,
      proposedAccountId,
      proposedAccountLabel: proposedAccountId
        ? hintAccount?.id === proposedAccountId
          ? hintAccount.label
          : labels.get(proposedAccountId) ?? null
        : null,
      confidence: hintAccount ? extraction.confidence : t.ai_confidence,
      source: hintAccount ? ('user-named' as const) : ('ai-suggested' as const),
    };
  });

  const decisionId = await logLaneDecision(admin, {
    orgId, feature: NL_FEATURE, gateway: gw.meta(), inputSummary: body.prompt,
    proposedOutput: {
      vendorQuery,
      accountHint,
      accountId: hintAccount?.id ?? null,
      accountLabel: hintAccount?.label ?? null,
      matched: candidates.length,
      transactionIds: candidates.map((c) => c.transactionId),
    },
    confidence: extraction.confidence,
    clarifyingQuestion: extraction.clarifyingQuestion,
    userId,
  });

  return NextResponse.json({
    clarifyingQuestion: extraction.clarifyingQuestion,
    decisionId,
    gateway: gatewayClientMeta(gw.meta()),
    vendorQuery,
    accountHint: hintAccount,
    candidates,
  });
}
