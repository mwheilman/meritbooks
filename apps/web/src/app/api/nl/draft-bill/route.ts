export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey, isAiUnavailableError, aiUnavailablePayload } from '@/lib/ai/gateway';
import { extractBillDraft } from '@/lib/nl/lanes/bill';
import {
  makeLaneGateway,
  logLaneDecision,
  gatewayClientMeta,
  BudgetBlockedError,
} from '@/lib/nl/lanes/server';
import { resolveVendorByName, resolveAccountByHint, defaultLocationId } from '@/lib/nl/lanes/resolve';

/**
 * POST /api/nl/draft-bill — P3 create-bill PROPOSE step.
 *
 * NL → structured DRAFT bill (vendor/amount/dates/GL hint) through the Core AI
 * gateway. Writes an ai_decisions PROPOSED row. POSTS NOTHING and creates no bill.
 * The client renders the draft as an editable form; on confirm it calls the
 * EXISTING gated /api/bills/create (which keeps its own validation, vendor
 * compliance holds, and committed-cost attribution). Clarify-before-book: a
 * missing vendor/amount returns a clarifyingQuestion and no draft.
 *
 * Gated on bills:create — the same permission the host create route enforces.
 */

const NL_FEATURE = 'NL_BILL_DRAFT';
const schema = z.object({ prompt: z.string().min(2).max(2000) });

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const supabase = ctx.supabase as SupabaseClient;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json({ ...aiUnavailablePayload('AI is temporarily paused'), draft: null, gateway: null });
  }

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
  const today = new Date().toISOString().slice(0, 10);

  let extraction;
  try {
    extraction = await extractBillDraft(body.prompt, today, gw.call);
  } catch (e) {
    if (e instanceof BudgetBlockedError) {
      return NextResponse.json({ error: e.message, code: 'BUDGET_BLOCKED' }, { status: 402 });
    }
    // Org disabled / bad key / provider outage → calm paused state, never a raw 502.
    if (!isAiUnavailableError(e)) console.error('[nl-draft-bill] unexpected gateway error:', e);
    return NextResponse.json({
      ...aiUnavailablePayload('AI is temporarily paused'),
      draft: null,
      gateway: gatewayClientMeta(gw.meta()),
    });
  }

  // Clarify-before-book: no draft, ask one question.
  if (!extraction.draft) {
    await logLaneDecision(admin, {
      orgId, feature: NL_FEATURE, gateway: gw.meta(), inputSummary: body.prompt,
      proposedOutput: { clarify: extraction.clarifyingQuestion }, confidence: extraction.confidence,
      clarifyingQuestion: extraction.clarifyingQuestion, userId,
    });
    return NextResponse.json({
      clarifyingQuestion: extraction.clarifyingQuestion,
      draft: null,
      gateway: gatewayClientMeta(gw.meta()),
    });
  }

  const draft = extraction.draft;

  const vendor = await resolveVendorByName(supabase, draft.vendorName);
  const locationId = await defaultLocationId(supabase);
  // A bill codes to an expense/COGS account.
  const account = draft.accountHint
    ? await resolveAccountByHint(supabase, draft.accountHint, ['COGS', 'OPEX', 'OTHER'])
    : null;

  const proposedOutput = {
    vendorName: draft.vendorName,
    vendorId: vendor?.id ?? null,
    amountCents: draft.amountCents,
    billDate: draft.billDate,
    dueDate: draft.dueDate,
    lineDescription: draft.lineDescription,
    accountId: account?.id ?? null,
    accountLabel: account?.label ?? null,
    locationId,
  };

  const decisionId = await logLaneDecision(admin, {
    orgId, locationId, feature: NL_FEATURE, gateway: gw.meta(), inputSummary: body.prompt,
    proposedOutput, confidence: extraction.confidence,
    clarifyingQuestion: extraction.clarifyingQuestion, userId,
  });

  return NextResponse.json({
    clarifyingQuestion: extraction.clarifyingQuestion,
    decisionId,
    gateway: gatewayClientMeta(gw.meta()),
    draft: {
      ...proposedOutput,
      vendorMatched: vendor,
      memo: draft.memo,
      confidence: extraction.confidence,
    },
  });
}
