export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/accounts/balances
 *
 * Per-account ledger activity for the Chart of Accounts grouped view:
 *   - current-period net (movement during the selected fiscal month)
 *   - year-to-date net (movement Jan 1 → end of the selected period)
 *
 * Only POSTED entries count toward a balance (PENDING/DRAFT are excluded, the
 * same rule the reports use). Amounts are returned as RAW debit/credit sums and
 * a raw net (debit − credit) in cents; the client applies the account's
 * normal-balance sign so contra balances read correctly.
 *
 * SCOPING: runs on the request-scoped RLS client (requireAuthedContext), so the
 * database returns ONLY the caller's org. An optional `location_id` narrows to a
 * single company WITHIN the org (the shared useQuery hook attaches it when a
 * specific company is active in the header); it can never widen across tenants.
 *
 * Aggregation is done in code over paginated line pages rather than a DB
 * group-by so this needs no new migration/view. A tenant's POSTED lines for one
 * fiscal year are bounded (thousands, not millions); PAGE_CAP is a safety valve.
 */

const PAGE_SIZE = 1000;
const PAGE_CAP = 80; // 80k lines/year ceiling — far above any real single-tenant book

function lastDayOfMonth(year: number, month1: number): string {
  // month1 is 1-based; day 0 of the next month == last day of this month.
  const d = new Date(Date.UTC(year, month1, 0));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

interface Bucket {
  periodDebit: number;
  periodCredit: number;
  ytdDebit: number;
  ytdCredit: number;
  periodCount: number;
  ytdCount: number;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const now = new Date();
  const year = Number(searchParams.get('year')) || now.getUTCFullYear();
  const rawMonth = Number(searchParams.get('period_month'));
  const month = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getUTCMonth() + 1;
  const locationId = searchParams.get('location_id');

  const yearStart = `${year}-01-01`;
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const periodEnd = lastDayOfMonth(year, month);
  const ytdEnd = periodEnd; // YTD runs through the end of the selected period.

  const buckets = new Map<string, Bucket>();
  let scanned = 0;
  let truncated = false;

  for (let page = 0; page < PAGE_CAP; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('gl_entry_lines')
      .select(
        `account_id, debit_cents, credit_cents,
         gl_entries!inner(entry_date, status)`,
      )
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', yearStart)
      .lte('gl_entries.entry_date', ytdEnd)
      .order('account_id', { ascending: true })
      .range(from, to);

    // Company scope — gl_entry_lines carries its own location_id (indexed).
    if (locationId && locationId !== 'all') {
      query = query.eq('location_id', locationId);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[accounts/balances] query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const accountId = row.account_id as string;
      const entry = (Array.isArray(row.gl_entries) ? row.gl_entries[0] : row.gl_entries) as
        | { entry_date?: string; status?: string }
        | null;
      if (!entry || entry.status !== 'POSTED') continue;

      const debit = Number(row.debit_cents ?? 0);
      const credit = Number(row.credit_cents ?? 0);
      const inPeriod = !!entry.entry_date && entry.entry_date >= periodStart && entry.entry_date <= periodEnd;

      let b = buckets.get(accountId);
      if (!b) {
        b = { periodDebit: 0, periodCredit: 0, ytdDebit: 0, ytdCredit: 0, periodCount: 0, ytdCount: 0 };
        buckets.set(accountId, b);
      }
      b.ytdDebit += debit;
      b.ytdCredit += credit;
      b.ytdCount += 1;
      if (inPeriod) {
        b.periodDebit += debit;
        b.periodCredit += credit;
        b.periodCount += 1;
      }
    }

    scanned += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (page === PAGE_CAP - 1) truncated = true;
  }

  const balances: Record<
    string,
    {
      periodDebitCents: number;
      periodCreditCents: number;
      periodNetCents: number;
      ytdDebitCents: number;
      ytdCreditCents: number;
      ytdNetCents: number;
      periodActivityCount: number;
      ytdActivityCount: number;
    }
  > = {};

  for (const [accountId, b] of buckets) {
    balances[accountId] = {
      periodDebitCents: b.periodDebit,
      periodCreditCents: b.periodCredit,
      periodNetCents: b.periodDebit - b.periodCredit,
      ytdDebitCents: b.ytdDebit,
      ytdCreditCents: b.ytdCredit,
      ytdNetCents: b.ytdDebit - b.ytdCredit,
      periodActivityCount: b.periodCount,
      ytdActivityCount: b.ytdCount,
    };
  }

  return NextResponse.json({
    balances,
    period: {
      year,
      month,
      periodStart,
      periodEnd,
      yearStart,
      ytdEnd,
      label: `${new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${year}`,
    },
    meta: { linesScanned: scanned, truncated },
  });
}
