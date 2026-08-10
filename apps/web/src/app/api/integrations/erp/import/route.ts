export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  getMigrationProvider,
  getMigrationProviderDef,
  isMigrationProviderId,
  trialBalanceToConversionInput,
  MIGRATION_ENTITY_LABELS,
  type FetchResult,
} from '@/lib/integrations/erp/providers';

/**
 * POST /api/integrations/erp/import
 *
 * The "pull + deterministically map" step of a direct-API migration. It pulls a
 * provider's trial balance (plus counts for the other importable entities) and
 * returns the EXACT `{ mapping, rows }` shape the existing historical-conversion
 * route accepts. It POSTS NOTHING and stages nothing itself — the client hands the
 * returned `{ mapping, rows }` to POST /api/onboarding/conversion, so direct-API is
 * simply another SOURCE feeding the one conversion pipeline (assembly → account
 * mapping → balance check → preview → human tie-out → balanced opening JE).
 *
 * `useFixture:true` runs the MOCK adapter (works today, no credentials). Otherwise
 * the credential-gated real adapter runs and DEGRADES SAFE: with no OAuth credentials
 * it returns `notConnected` with a reason, never calling a live provider.
 *
 * GATE: settings_system:edit (matches the connector connect route). Fails closed.
 */

const bodySchema = z.object({
  erpId: z.string().min(1).max(32),
  useFixture: z.boolean().optional(),
});

export async function POST(request: Request) {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const { userId } = authRes;

  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const { erpId, useFixture } = parsed.data;

  if (!isMigrationProviderId(erpId)) {
    return NextResponse.json({ error: 'Unknown migration provider', code: 'NOT_FOUND' }, { status: 404 });
  }
  const def = getMigrationProviderDef(erpId);
  const provider = getMigrationProvider(erpId, { mock: !!useFixture });

  // Pull the trial balance — the opening-balances feed for the conversion pipeline.
  const tb = await provider.fetchTrialBalance();
  if (!tb.connected) {
    // Degrade-safe: no credentials (or live sync not enabled). Not an error.
    return NextResponse.json({
      ok: true,
      connected: false,
      source: useFixture ? 'mock' : 'live',
      erpId,
      providerName: def.name,
      reason: tb.reason,
    });
  }

  const input = trialBalanceToConversionInput(tb.records);

  // Best-effort counts for the OTHER importable entities (surfaced in the preview so
  // the user sees what the migration brings over). Failures here never block the TB.
  const [accounts, customers, vendors, ar, ap] = await Promise.all([
    provider.fetchAccounts(),
    provider.fetchCustomers(),
    provider.fetchVendors(),
    provider.fetchOpenAR(),
    provider.fetchOpenAP(),
  ]);

  const totalDebitCents = tb.records.reduce((s, r) => s + r.debitCents, 0);
  const totalCreditCents = tb.records.reduce((s, r) => s + r.creditCents, 0);

  return NextResponse.json({
    ok: true,
    connected: true,
    source: tb.source,
    erpId,
    providerName: def.name,
    // The exact input the existing conversion route accepts.
    mapping: input.mapping,
    rows: input.rows,
    summary: {
      openingBalanceEntity: MIGRATION_ENTITY_LABELS[def.openingBalanceEntity],
      trialBalanceLines: tb.records.length,
      totalDebitCents,
      totalCreditCents,
      balanced: totalDebitCents === totalCreditCents,
      entityCounts: {
        accounts: countOf(accounts),
        customers: countOf(customers),
        vendors: countOf(vendors),
        open_ar: countOf(ar),
        open_ap: countOf(ap),
      },
    },
  });
}

function countOf<T>(res: FetchResult<T>): number {
  return res.connected ? res.records.length : 0;
}
