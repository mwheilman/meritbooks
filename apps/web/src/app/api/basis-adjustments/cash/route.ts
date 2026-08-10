export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchIncomeStatement } from '@/app/api/reports/board-package/queries';
import { fetchCashIncomeStatement } from '@/lib/reports/income-statement-cash';
import { deriveCashAdjustments, type CashPnlAccount } from '@/lib/reports/basis/derive-cash';
import type { IncomeStatementPayload } from '@/lib/reports/board-package';
import type { NormalBalance } from '@/lib/reports/basis/apply-adjustments';

/**
 * DERIVE cash-basis presentation adjustments AUTOMATICALLY (live — never persisted).
 *
 * GET /api/basis-adjustments/cash?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD[&location_ids=…]
 *
 * The Basis toggle calls this when a reader flips to Cash. It reuses the SAME proven cash
 * conversion the NL report compiler uses (`fetchCashIncomeStatement`) — revenue on cash
 * received, expense on cash paid — and expresses the accrual→cash DIFFERENCE as per-account
 * presentation deltas (plus one balancing equity offset). Nothing is written; the accrual
 * GL stays the single book of record (CANON GATE 2). The response shape matches
 * `/api/basis-adjustments` so the overlay hook consumes it identically.
 *
 * Read-only: runs under RLS (org isolation by the DB); no write permission is required
 * because it computes a presentation, it does not mutate anything.
 */

const querySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  location_ids: z.string().optional(),
});

const PL_SECTION_NORMAL: Record<string, NormalBalance> = {
  REVENUE: 'CREDIT',
  OTHER: 'CREDIT',
  COGS: 'DEBIT',
  OPEX: 'DEBIT',
};

/**
 * Resolve retained-earnings (the reconciling-offset home): explicit role → standard 3020 →
 * any equity account. Fail-soft — null means the P&L still flips but the balancing plug is
 * skipped (surfaced as a small imbalance, not hidden).
 */
async function resolveEquityAccountId(supabase: SupabaseClient): Promise<string | null> {
  const { data: role } = await supabase
    .from('account_roles')
    .select('account_id')
    .eq('role_key', 'RETAINED_EARNINGS')
    .is('location_id', null)
    .maybeSingle();
  if (role?.account_id) return role.account_id as string;

  const { data: byNum } = await supabase
    .from('accounts')
    .select('id')
    .eq('account_number', '3020')
    .maybeSingle();
  if (byNum?.id) return byNum.id as string;

  const { data: anyEq } = await supabase
    .from('accounts')
    .select('id')
    .eq('account_type', 'EQUITY')
    .order('account_number')
    .limit(1)
    .maybeSingle();
  return (anyEq?.id as string) ?? null;
}

/**
 * Fetch the true normal balance for a set of account ids (RLS-scoped). Needed only to keep
 * the equity plug exact for OTHER-section accounts, whose natural side is ambiguous by type.
 */
async function loadNormalBalances(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<Map<string, NormalBalance>> {
  const map = new Map<string, NormalBalance>();
  if (accountIds.length === 0) return map;
  const { data } = await supabase
    .from('accounts')
    .select(`
      id,
      account_groups!inner(
        account_sub_types!inner(
          account_types!inner( normal_balance )
        )
      )
    `)
    .in('id', accountIds);
  for (const a of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const groups = a.account_groups as Record<string, unknown>;
    const subTypes = groups?.account_sub_types as Record<string, unknown>;
    const types = subTypes?.account_types as Record<string, unknown>;
    map.set(a.id as string, (types?.normal_balance as string) === 'CREDIT' ? 'CREDIT' : 'DEBIT');
  }
  return map;
}

/** Flatten an income-statement payload into per-account natural amounts (with section normal). */
function toAccounts(payload: IncomeStatementPayload): CashPnlAccount[] {
  const out: CashPnlAccount[] = [];
  for (const sec of payload.sections) {
    const secNormal = PL_SECTION_NORMAL[sec.type] ?? 'DEBIT';
    for (const g of sec.groups) {
      for (const a of g.accounts) {
        if (!a.accountId) continue;
        out.push({
          accountId: a.accountId,
          accountNumber: a.accountNumber,
          normalBalance: secNormal,
          naturalCents: a.amountCents,
        });
      }
    }
  }
  return out;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  const { start_date, end_date, location_ids } = parsed.data;
  const locationIds = (location_ids ?? '').split(',').filter(Boolean);

  let accrualPayload: IncomeStatementPayload;
  let cashPayload: IncomeStatementPayload;
  try {
    // Accrual base — the SAME aggregation the on-screen P&L renders, so the deltas land
    // exactly on top of what the reader already sees.
    accrualPayload = await fetchIncomeStatement(supabase, {
      startDate: start_date,
      endDate: end_date,
      locationIds,
      basis: 'accrual',
    });
    // The proven FULL cash conversion (reused, not reinvented).
    cashPayload = await fetchCashIncomeStatement(supabase, orgId, {
      startDate: start_date,
      endDate: end_date,
      locationIds,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to compute cash basis', code: 'COMPUTE_ERROR' }, { status: 500 });
  }

  const accrualAccounts = toAccounts(accrualPayload);
  const cashAccounts = toAccounts(cashPayload);

  // Correct the OTHER-section normal balance from the ledger (revenue-like vs expense-like).
  const referencedIds = [...new Set([...accrualAccounts, ...cashAccounts].map((a) => a.accountId))];
  const normals = await loadNormalBalances(supabase, referencedIds);
  const fix = (a: CashPnlAccount): CashPnlAccount => ({ ...a, normalBalance: normals.get(a.accountId) ?? a.normalBalance });
  const accrualFixed = accrualAccounts.map(fix);
  const cashFixed = cashAccounts.map(fix);

  const equityAccountId = await resolveEquityAccountId(supabase);
  const derived = deriveCashAdjustments(accrualFixed, cashFixed, equityAccountId);

  // Shape identical to /api/basis-adjustments so useBasisOverlay consumes it unchanged.
  const adjustments = derived.adjustments.map((adj, i) => ({
    id: `cash:${adj.accountId}:${i}`,
    basis: 'CASH' as const,
    customLabel: null,
    accountId: adj.accountId,
    amountCents: adj.amountCents,
    description: adj.description ?? null,
    adjustmentType: adj.adjustmentType ?? null,
    source: adj.source ?? 'DERIVED',
  }));

  return NextResponse.json({
    data: {
      adjustments,
      summary: {
        count: adjustments.length,
        netDebitPositiveCents: derived.netDebitPositiveCents,
        balances: derived.netDebitPositiveCents === 0,
      },
      meta: {
        accrualNetIncomeCents: accrualPayload.summary.netIncomeCents,
        cashNetIncomeCents: cashPayload.summary.netIncomeCents,
        equityOffsetCents: derived.equityOffsetCents,
        equityResolved: !!equityAccountId,
      },
    },
  });
}
