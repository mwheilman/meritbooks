export const dynamic = 'force-dynamic';
// A full pull is several paged Intuit calls; give it room (Vercel Pro allows 60s).
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  MIGRATION_ENTITY_LABELS,
  trialBalanceToConversionInput,
  type FetchResult,
} from '@/lib/integrations/erp/providers';
import { resolveMigrationProvider } from '@/lib/integrations/erp/resolve-provider';
import { touchQboLastSync } from '@/lib/integrations/erp/quickbooks/connection-store';
import { defaultCutoverDate } from '@/lib/integrations/erp/quickbooks/live-source';
import type { QboCompanyProfile } from '@/lib/integrations/erp/quickbooks/company-info';
import type { PreflightFinding } from '@/lib/integrations/erp/quickbooks/preflight';

/**
 * POST /api/integrations/erp/quickbooks/pull   { asOfDate?: "YYYY-MM-DD" }
 *
 * Pulls the connected org's QuickBooks books (read-only) and returns, in one call:
 *   • company      — CompanyInfo prefill (name, legal name, address, EIN, FY start)
 *   • mapping/rows — the trial balance as of `asOfDate` in the EXACT `{ mapping, rows }`
 *                    shape POST /api/onboarding/conversion accepts (same as
 *                    /api/integrations/erp/import), so the one conversion pipeline
 *                    (mapping → balance check → tie-out → human approval → opening JE)
 *                    does all the accounting. Nothing is posted or staged here.
 *   • summary      — totals, balanced?, entity counts
 *   • preflight    — plain-English QuickBooks clean-up findings, in dollars
 *
 * asOfDate defaults to the FPB cutover default (last day of the prior month).
 * Not connected / expired / Intuit down → `{ connected:false, reason }` (200) — the UI
 * offers reconnect or the guided-export upload. GATE: settings_system:edit.
 */

const bodySchema = z.object({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
});

export async function POST(request: Request) {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const guard = await requirePermission(authRes.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const asOfDate = parsed.data.asOfDate ?? defaultCutoverDate();

  const { provider, selection, qbo } = await resolveMigrationProvider('quickbooks', { orgId, asOfDate });
  if (!qbo || selection.kind !== 'live') {
    return NextResponse.json({
      ok: true,
      connected: false,
      reason: 'reason' in selection ? selection.reason : 'QuickBooks isn’t connected.',
    });
  }

  let company: QboCompanyProfile | null = null;
  try {
    company = await qbo.companyProfile();
  } catch {
    company = null;
  }

  const tb = await provider.fetchTrialBalance();
  if (!tb.connected) {
    return NextResponse.json({ ok: true, connected: false, reason: tb.reason, company });
  }
  const input = trialBalanceToConversionInput(tb.records);

  const [accounts, customers, vendors, ar, ap] = await Promise.all([
    provider.fetchAccounts(),
    provider.fetchCustomers(),
    provider.fetchVendors(),
    provider.fetchOpenAR(),
    provider.fetchOpenAP(),
  ]);

  let preflight: PreflightFinding[] = [];
  let preflightError: string | null = null;
  try {
    preflight = await qbo.preflight();
  } catch (err) {
    preflightError = err instanceof Error ? err.message : 'Pre-flight checks could not run.';
  }

  const { createAdminSupabase } = await import('@/lib/supabase/server');
  await touchQboLastSync(createAdminSupabase(), orgId);

  const totalDebitCents = tb.records.reduce((s, r) => s + r.debitCents, 0);
  const totalCreditCents = tb.records.reduce((s, r) => s + r.creditCents, 0);

  return NextResponse.json({
    ok: true,
    connected: true,
    source: 'live',
    erpId: 'quickbooks',
    providerName: 'QuickBooks Online',
    asOfDate,
    company,
    mapping: input.mapping,
    rows: input.rows,
    summary: {
      openingBalanceEntity: MIGRATION_ENTITY_LABELS.trial_balance,
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
    preflight,
    preflightError,
  });
}

function countOf<T>(res: FetchResult<T>): number {
  return res.connected ? res.records.length : 0;
}
