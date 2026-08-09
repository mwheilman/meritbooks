export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey, isAiUnavailableError, aiUnavailablePayload } from '@/lib/ai/gateway';
import { extractInvoiceDraft } from '@/lib/nl/lanes/invoice';
import {
  makeLaneGateway,
  logLaneDecision,
  gatewayClientMeta,
  BudgetBlockedError,
} from '@/lib/nl/lanes/server';
import { resolveCustomerByName, resolveAccountByHint, defaultLocationId } from '@/lib/nl/lanes/resolve';

/**
 * POST /api/nl/draft-invoice — P4 create-invoice PROPOSE step.
 *
 * NL → structured DRAFT invoice (customer/amount/dates/revenue hint) through the
 * Core AI gateway. Writes an ai_decisions PROPOSED row. POSTS NOTHING. The client
 * renders an editable draft; on confirm it calls the EXISTING /api/invoices create
 * route, which delegates to the shared invoice-create core (rev-rec-aware: a
 * managed job routes revenue to Deferred Revenue 2410) with post_to_gl:false, so
 * it lands as a DRAFT invoice, not a posting. Clarify-before-book on a missing
 * customer/amount.
 *
 * Gated on invoices:create — the same permission the host create route enforces.
 */

const NL_FEATURE = 'NL_INVOICE_DRAFT';
const schema = z.object({ prompt: z.string().min(2).max(2000) });

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const supabase = ctx.supabase as SupabaseClient;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
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
    extraction = await extractInvoiceDraft(body.prompt, today, gw.call);
  } catch (e) {
    if (e instanceof BudgetBlockedError) {
      return NextResponse.json({ error: e.message, code: 'BUDGET_BLOCKED' }, { status: 402 });
    }
    // Org disabled / bad key / provider outage → calm paused state, never a raw 502.
    if (!isAiUnavailableError(e)) console.error('[nl-draft-invoice] unexpected gateway error:', e);
    return NextResponse.json({
      ...aiUnavailablePayload('AI is temporarily paused'),
      draft: null,
      gateway: gatewayClientMeta(gw.meta()),
    });
  }

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

  const customer = await resolveCustomerByName(supabase, draft.customerName);
  const locationId = await defaultLocationId(supabase);
  // An invoice line codes to a revenue account.
  const account = draft.accountHint
    ? await resolveAccountByHint(supabase, draft.accountHint, ['REVENUE', 'OTHER'])
    : null;

  const proposedOutput = {
    customerName: draft.customerName,
    customerId: customer?.id ?? null,
    amountCents: draft.amountCents,
    invoiceDate: draft.invoiceDate,
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
      customerMatched: customer,
      memo: draft.memo,
      confidence: extraction.confidence,
    },
  });
}
