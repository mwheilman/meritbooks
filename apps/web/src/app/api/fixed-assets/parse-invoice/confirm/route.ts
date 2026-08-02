export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { recordAssetAcquisition } from '@/lib/posting/provisioning';
import type { PostingFacts } from '@/lib/posting/posting-templates';
import type { PaymentRail } from '@/lib/posting/transaction-types';
import { BOOK_METHOD_VALUES, type BookDepreciationMethod } from '@/lib/fixed-assets/asset-parse';

/**
 * POST /api/fixed-assets/parse-invoice/confirm — confirm a PROPOSED capex asset.
 *
 * The human has reviewed the AI proposal (class / useful life / method / cost) and
 * confirms it into the fixed-asset register. This route WRITES: it creates the
 * asset via the EXISTING gated create path (`recordAssetAcquisition`), which posts
 * the balanced acquisition GL entry (DR the fixed-asset account / CR the cash rail)
 * AND inserts the `fixed_assets` row so the depreciation engine picks it up.
 *
 * Canon §3: the AI never wrote the asset — the human confirms, and the
 * deterministic engine does the accounting. All account resolution is by explicit
 * ID chosen in the UI (asset / depreciation-expense / accumulated-depreciation);
 * the engine refuses to guess. RLS-scoped write (`ctx.supabase`).
 *
 * If `decisionId` is supplied, the originating `ai_decisions` proposal is marked
 * APPROVED for the audit trail (non-fatal on failure).
 */

const CASH_RAILS: readonly PaymentRail[] = ['cash', 'check', 'ach', 'wire', 'debit_card', 'credit_card'];

interface ConfirmBody {
  locationId?: unknown;
  assetAccountId?: unknown;
  depreciationExpenseAccountId?: unknown;
  accumulatedDepreciationAccountId?: unknown;
  name?: unknown;
  category?: unknown;
  costCents?: unknown;
  salvageValueCents?: unknown;
  usefulLifeMonths?: unknown;
  depreciationMethod?: unknown;
  acquisitionDate?: unknown;
  rail?: unknown;
  departmentId?: unknown;
  decisionId?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — gate on the existing fixed-asset create permission.
  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  // ── Validate (never guess a required account or amount) ──────────────────────
  if (!isNonEmptyString(body.locationId)) {
    return NextResponse.json({ error: 'locationId is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.assetAccountId)) {
    return NextResponse.json({ error: 'assetAccountId (the fixed-asset account) is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.depreciationExpenseAccountId)) {
    return NextResponse.json({ error: 'depreciationExpenseAccountId is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.accumulatedDepreciationAccountId)) {
    return NextResponse.json({ error: 'accumulatedDepreciationAccountId is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.name)) {
    return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 422 });
  }

  const costCents = Number(body.costCents);
  if (!Number.isInteger(costCents) || costCents <= 0) {
    return NextResponse.json({ error: 'costCents must be a positive integer (bigint cents)', code: 'VALIDATION' }, { status: 422 });
  }

  const salvageValueCents = body.salvageValueCents === undefined ? 0 : Number(body.salvageValueCents);
  if (!Number.isInteger(salvageValueCents) || salvageValueCents < 0) {
    return NextResponse.json({ error: 'salvageValueCents must be a non-negative integer', code: 'VALIDATION' }, { status: 422 });
  }
  if (salvageValueCents >= costCents) {
    return NextResponse.json({ error: 'salvageValueCents must be less than costCents', code: 'VALIDATION' }, { status: 422 });
  }

  const usefulLifeMonths = Number(body.usefulLifeMonths);
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
    return NextResponse.json({ error: 'usefulLifeMonths must be a positive integer', code: 'VALIDATION' }, { status: 422 });
  }

  const method = String(body.depreciationMethod ?? 'STRAIGHT_LINE') as BookDepreciationMethod;
  if (!BOOK_METHOD_VALUES.includes(method)) {
    return NextResponse.json(
      { error: `depreciationMethod must be one of: ${BOOK_METHOD_VALUES.join(', ')}`, code: 'VALIDATION' },
      { status: 422 },
    );
  }

  if (!isNonEmptyString(body.acquisitionDate) || !ISO_DATE.test(body.acquisitionDate)) {
    return NextResponse.json({ error: 'acquisitionDate must be an ISO date (YYYY-MM-DD)', code: 'VALIDATION' }, { status: 422 });
  }
  const acquisitionDate = body.acquisitionDate;

  const rail = (isNonEmptyString(body.rail) ? body.rail : 'ach') as PaymentRail;
  if (!CASH_RAILS.includes(rail)) {
    return NextResponse.json(
      { error: `rail must be one of: ${CASH_RAILS.join(', ')}`, code: 'VALIDATION' },
      { status: 422 },
    );
  }

  const category = isNonEmptyString(body.category) ? body.category : undefined;
  const departmentId = isNonEmptyString(body.departmentId) ? body.departmentId : undefined;

  // ── Create via the EXISTING create path (posts GL + inserts fixed_assets) ─────
  const facts: PostingFacts = {
    org_id: orgId,
    location_id: body.locationId,
    entry_date: acquisitionDate,
    amount_cents: costCents,
    category_account_id: body.assetAccountId, // the fixed-asset account
    rail,
    department_id: departmentId,
    memo: `Capex acquisition — ${body.name}`.slice(0, 200),
  };

  const result = await recordAssetAcquisition(
    supabase,
    {
      facts,
      name: body.name,
      category,
      useful_life_months: usefulLifeMonths,
      depreciation_expense_account_id: body.depreciationExpenseAccountId,
      accumulated_depreciation_account_id: body.accumulatedDepreciationAccountId,
      salvage_value_cents: salvageValueCents,
      depreciation_method: method,
      acquisition_date: acquisitionDate,
    },
    { created_by: null }, // Clerk ids are text; GL author columns are uuid → null
  );

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Failed to create asset', code: 'CREATE_FAILED' }, { status: 422 });
  }

  // ── Mark the originating AI proposal APPROVED (audit trail; non-fatal) ────────
  if (isNonEmptyString(body.decisionId)) {
    try {
      await supabase
        .from('ai_decisions')
        .update({
          status: 'APPROVED',
          disposition_by_user: userId,
          disposition_at: new Date().toISOString(),
          disposition_note: `Confirmed into the fixed-asset register (asset ${result.provisioned_id ?? ''})`.trim(),
          posted_gl_entry_id: result.entry_id ?? null,
        })
        .eq('id', body.decisionId)
        .eq('org_id', orgId);
    } catch (e) {
      console.error('[fixed-assets/parse-invoice/confirm] decision update failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({
    ok: true,
    assetId: result.provisioned_id,
    entryId: result.entry_id,
    entryNumber: result.entry_number,
  });
}
