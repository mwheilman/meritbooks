export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { buildBalanceTrend, type TrendTxn } from '@/lib/cash/trend';

/**
 * GET /api/cash/trend?location_id=<uuid>&weeks=13
 *
 * A simple weekly cash-balance trend for the Cash Position screen. We don't keep
 * a balance-history table; instead we reconstruct it deterministically from the
 * live consolidated bank balance and the dated transaction feed (see
 * lib/cash/trend.ts). Read-only, RLS-scoped. Degrade-safe: no accounts / no
 * feed → a flat line at the current balance.
 *
 * Only operating cash accounts (CHECKING/SAVINGS) count toward the trend so a
 * credit-card/LOC liability balance doesn't distort "cash on hand".
 */

const CASH_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS'];
const LOOKBACK_DAYS = 100; // > 13 weeks so the oldest boundary has full coverage

interface BankAccountRow {
  id: string;
  location_id: string;
  account_type: string | null;
  current_balance_cents: number | string | null;
  balance_updated_at: string | null;
}
interface TxnRow { transaction_date: string; amount_cents: number | string | null }

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const url = new URL(request.url);
  const locationId = url.searchParams.get('location_id');
  const weeksParam = Number(url.searchParams.get('weeks'));
  const weeks = Number.isFinite(weeksParam) ? Math.min(26, Math.max(4, Math.trunc(weeksParam))) : 13;

  // 1. In-scope operating cash accounts → current total + as-of date.
  let acctQ = supabase
    .from('bank_accounts')
    .select('id, location_id, account_type, current_balance_cents, balance_updated_at')
    .eq('is_active', true)
    .in('account_type', CASH_ACCOUNT_TYPES);
  if (locationId) acctQ = acctQ.eq('location_id', locationId);
  const { data: acctData, error: acctErr } = await acctQ;
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });

  const accounts = (acctData ?? []) as BankAccountRow[];
  const currentTotalCents = accounts.reduce((s, a) => s + Number(a.current_balance_cents ?? 0), 0);
  const asOf = accounts.reduce<string | null>((max, a) => {
    if (!a.balance_updated_at) return max;
    return !max || a.balance_updated_at > max ? a.balance_updated_at : max;
  }, null);

  // 2. Transaction feed over the look-back window for those accounts.
  let txns: TrendTxn[] = [];
  if (accounts.length > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);
    const sinceIso = since.toISOString().slice(0, 10);
    let txQ = supabase
      .from('bank_transactions')
      .select('transaction_date, amount_cents')
      .in('bank_account_id', accounts.map((a) => a.id))
      .gte('transaction_date', sinceIso);
    if (locationId) txQ = txQ.eq('location_id', locationId);
    const { data: txData, error: txErr } = await txQ;
    if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });
    txns = ((txData ?? []) as TxnRow[]).map((t) => ({
      date: t.transaction_date,
      amountCents: Number(t.amount_cents ?? 0),
    }));
  }

  const trend = buildBalanceTrend({ currentTotalCents, txns, weeks });

  return NextResponse.json({
    ...trend,
    asOfDate: asOf,
    accountCount: accounts.length,
    transactionCount: txns.length,
    hasFeed: txns.length > 0,
    meta: { locationId: locationId ?? null, consolidated: !locationId },
  });
}
