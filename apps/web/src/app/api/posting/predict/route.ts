export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { predictException } from '@/lib/posting/exception-predictor';
import { suggestExceptionViaGateway } from '@/lib/services/exception-ai';
import { getAnthropicApiKey } from '@/lib/ai/gateway';

/**
 * POST /api/posting/predict
 *   { location_id, account_id, amount_cents, description?, side?, ai? }
 *
 * Returns an advisory balance-sheet treatment (capitalize / prepaid /
 * deferred-revenue / expense) for a categorized line, using the company's policy
 * thresholds.
 *
 *   ai = false (default) -> deterministic, rule-based, FREE.
 *   ai = true            -> metered Core-gateway predictor (model judgment + one
 *                           clarifying question when ambiguous), decision-logged.
 *                           Falls back to the deterministic verdict if the gateway
 *                           is unavailable or budget-blocked, so the caller always
 *                           gets a usable treatment.
 *
 * The treatment vocabulary is identical either way, so the caller (UI or the AI JE
 * engine) hands it straight to the GATE 2 provisioning path:
 *   CAPITALIZE -> recordAssetAcquisition, PREPAID -> recordPrepaidPurchase,
 *   DEFERRED_REVENUE -> recordDeferredRevenue.
 */
export async function POST(request: Request) {
  const authResult = await auth().catch(() => null);
  const userId = (authResult as { userId?: string | null } | null)?.userId ?? null;
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (authResult?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((authResult!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;

  let body: {
    location_id?: string;
    account_id?: string;
    amount_cents?: number;
    description?: string;
    side?: 'expense' | 'revenue';
    ai?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.location_id || !body.account_id || typeof body.amount_cents !== 'number') {
    return NextResponse.json({ error: 'location_id, account_id, and amount_cents are required' }, { status: 422 });
  }

  const supabase = createAdminSupabase();

  try {
    const orgId = await resolveOrgId(supabase, claimOrgId);

    // AI path: metered gateway predictor with decision-log + deterministic fallback.
    if (body.ai === true) {
      const apiKey = getAnthropicApiKey();
      if (!apiKey) {
        // No key configured — degrade gracefully to the deterministic verdict.
        const prediction = await predictException(supabase, {
          orgId,
          locationId: body.location_id,
          accountId: body.account_id,
          amountCents: body.amount_cents,
          description: body.description,
          side: body.side,
        });
        return NextResponse.json({
          ok: true,
          source: 'deterministic',
          note: 'AI is not configured (Anthropic key missing) — returned the rule-based verdict.',
          prediction,
        });
      }

      const res = await suggestExceptionViaGateway(supabase, apiKey, {
        orgId,
        userId,
        locationId: body.location_id,
        accountId: body.account_id,
        amountCents: body.amount_cents,
        description: body.description,
        side: body.side,
      });

      // On a soft failure we still hand back the (deterministic) verdict, with a 200,
      // because the verdict is advisory and present; we surface the reason + budget flag.
      return NextResponse.json({
        ok: true,
        source: res.verdict.source,
        verdict: res.verdict,
        provisioning_action: res.verdict.provisioningAction,
        decision_id: res.verdict.decisionId,
        gateway: res.ok ? res.gateway : null,
        ...(res.ok ? {} : { ai_note: res.error, budget_blocked: res.budgetBlocked ?? false }),
      });
    }

    // Deterministic default (free).
    const prediction = await predictException(supabase, {
      orgId,
      locationId: body.location_id,
      accountId: body.account_id,
      amountCents: body.amount_cents,
      description: body.description,
      side: body.side,
    });
    return NextResponse.json({ ok: true, source: 'deterministic', prediction });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'prediction failed' }, { status: 500 });
  }
}
