export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { recordAssetAcquisition } from '@/lib/posting/provisioning';
import { resolveIntangibleAccounts } from '@/lib/intangibles/accounts';
import { PostingError } from '@/lib/posting/account-roles';
import {
  INTANGIBLE_CATEGORIES,
  isIntangibleCategory,
  isNonAmortizing,
  type IntangibleCategory,
} from '@/lib/intangibles/categories';
import type { PostingFacts } from '@/lib/posting/posting-templates';
import type { PaymentRail } from '@/lib/posting/transaction-types';

/**
 * Intangible assets = `public.fixed_assets` rows with an `INTANGIBLE_*` category.
 *
 * GET  /api/intangibles?location_id=&status=  — the intangible register with cost,
 *      accumulated amortization, net book value, and remaining life.
 * POST /api/intangibles                        — create an intangible: resolve the
 *      cost / amortization-expense / accumulated-amortization accounts BY ROLE, then
 *      post the balanced acquisition GL entry and insert the register row via the
 *      shared, gated create path. Goodwill is created but never amortized.
 *
 * RLS-scoped (`ctx.supabase`, org-filtered defense-in-depth). Canon §3: the human
 * confirms; the deterministic engine does the accounting; accounts are never guessed.
 */

const CASH_RAILS: readonly PaymentRail[] = ['cash', 'check', 'ach', 'wire', 'debit_card', 'credit_card'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface AssetRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  acquisition_date: string;
  acquisition_cost_cents: number;
  salvage_value_cents: number;
  useful_life_months: number;
  depreciation_method: string;
  accumulated_depreciation_cents: number;
  net_book_value_cents: number;
  last_depreciation_date: string | null;
  status: string;
  location_id: string;
}

function monthsBetween(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const status = searchParams.get('status');

  let query = supabase
    .from('fixed_assets')
    .select(
      'id, name, description, category, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method, accumulated_depreciation_cents, net_book_value_cents, last_depreciation_date, status, location_id',
    )
    .eq('org_id', orgId)
    .order('name');
  if (locationId) query = query.eq('location_id', locationId);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });

  const rows = ((data ?? []) as AssetRow[]).filter((r) => isIntangibleCategory(r.category));

  const assets = rows.map((a) => {
    const nonAmortizing = isNonAmortizing(a.category);
    // Elapsed amortized months from the last posted period (else 0).
    const elapsed = a.last_depreciation_date
      ? monthsBetween(a.acquisition_date, a.last_depreciation_date) + 1
      : 0;
    const remainingLifeMonths = nonAmortizing ? null : Math.max(0, a.useful_life_months - elapsed);
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      acquisitionDate: a.acquisition_date,
      acquisitionCostCents: a.acquisition_cost_cents,
      salvageValueCents: a.salvage_value_cents,
      usefulLifeMonths: a.useful_life_months,
      depreciationMethod: a.depreciation_method,
      accumulatedAmortizationCents: a.accumulated_depreciation_cents,
      netBookValueCents: a.net_book_value_cents,
      lastAmortizationDate: a.last_depreciation_date,
      remainingLifeMonths,
      amortizing: !nonAmortizing,
      status: a.status,
      locationId: a.location_id,
    };
  });

  const totalCost = assets.reduce((s, a) => s + a.acquisitionCostCents, 0);
  const totalAccum = assets.reduce((s, a) => s + a.accumulatedAmortizationCents, 0);
  const totalNBV = assets.reduce((s, a) => s + a.netBookValueCents, 0);
  const byStatus: Record<string, number> = {};
  for (const a of assets) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  return NextResponse.json({
    data: assets,
    summary: {
      count: assets.length,
      totalCostCents: totalCost,
      totalAccumAmortizationCents: totalAccum,
      totalNBVCents: totalNBV,
      goodwillCount: assets.filter((a) => !a.amortizing).length,
      byStatus,
    },
  });
}

interface CreateBody {
  locationId?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  costCents?: unknown;
  salvageValueCents?: unknown;
  usefulLifeMonths?: unknown;
  acquisitionDate?: unknown;
  rail?: unknown;
  departmentId?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — reuse the fixed-asset create permission (an intangible is a fixed asset).
  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  if (!isNonEmptyString(body.locationId)) {
    return NextResponse.json({ error: 'locationId is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.name)) {
    return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 422 });
  }
  const category = String(body.category ?? '');
  if (!(INTANGIBLE_CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${INTANGIBLE_CATEGORIES.join(', ')}`, code: 'VALIDATION' },
      { status: 422 },
    );
  }
  const goodwill = isNonAmortizing(category);

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

  // Goodwill is not amortized, so a useful life is irrelevant — store a nominal 1.
  // Finite-lived intangibles require a positive amortization life.
  let usefulLifeMonths: number;
  if (goodwill) {
    usefulLifeMonths = 1;
  } else {
    usefulLifeMonths = Number(body.usefulLifeMonths);
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
      return NextResponse.json({ error: 'usefulLifeMonths must be a positive integer', code: 'VALIDATION' }, { status: 422 });
    }
  }

  if (!isNonEmptyString(body.acquisitionDate) || !ISO_DATE.test(body.acquisitionDate)) {
    return NextResponse.json({ error: 'acquisitionDate must be an ISO date (YYYY-MM-DD)', code: 'VALIDATION' }, { status: 422 });
  }
  const acquisitionDate = body.acquisitionDate;

  const rail = (isNonEmptyString(body.rail) ? body.rail : 'ach') as PaymentRail;
  if (!CASH_RAILS.includes(rail)) {
    return NextResponse.json({ error: `rail must be one of: ${CASH_RAILS.join(', ')}`, code: 'VALIDATION' }, { status: 422 });
  }
  const departmentId = isNonEmptyString(body.departmentId) ? body.departmentId : undefined;

  // Resolve the three posting accounts BY ROLE (never guessed).
  let accounts;
  try {
    accounts = await resolveIntangibleAccounts(supabase, orgId, category, body.locationId);
  } catch (e) {
    const msg = e instanceof PostingError ? e.message : 'Could not resolve intangible accounts';
    return NextResponse.json({ error: msg, code: 'ACCOUNT_RESOLUTION' }, { status: 422 });
  }

  const facts: PostingFacts = {
    org_id: orgId,
    location_id: body.locationId,
    entry_date: acquisitionDate,
    amount_cents: costCents,
    category_account_id: accounts.asset.id, // the intangible cost account (1710 / goodwill 1700)
    rail,
    department_id: departmentId,
    memo: `Intangible acquisition — ${body.name}`.slice(0, 200),
  };

  const result = await recordAssetAcquisition(
    supabase,
    {
      facts,
      name: body.name,
      category: category as IntangibleCategory,
      useful_life_months: usefulLifeMonths,
      depreciation_expense_account_id: accounts.amortizationExpense.id,
      accumulated_depreciation_account_id: accounts.accumulatedAmortization.id,
      salvage_value_cents: salvageValueCents,
      depreciation_method: 'STRAIGHT_LINE', // the norm for finite-lived intangibles
      acquisition_date: acquisitionDate,
    },
    { created_by: null }, // Clerk ids are text; GL author columns are uuid → null
  );

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Failed to create intangible', code: 'CREATE_FAILED' }, { status: 422 });
  }

  return NextResponse.json({
    ok: true,
    assetId: result.provisioned_id,
    entryId: result.entry_id,
    entryNumber: result.entry_number,
    amortizing: !goodwill,
  });
}
