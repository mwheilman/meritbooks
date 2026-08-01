export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

/**
 * Portfolio profitability board (Practice plane — accounting-firm-partner brief B9,
 * "per-client profitability": which entities make money and which quietly lose it).
 *
 * One P&L per entity (core.locations) for a period, plus a portfolio roll-up.
 * Everything is derived from the LIVE GL — never asserted status.
 *
 * DATA SOURCE / CORRECTNESS
 *  - Entity roster: `core.locations` (canonical master data; active only), same as
 *    the consolidated report. So zero-activity entities still show a row (a $0 P&L),
 *    not silently vanish.
 *  - P&L figures: `v_income_statement` — the canonical income-statement view
 *    (migration 009; forced `security_invoker` by migration 068, so it honors the
 *    caller's RLS org scope through the authed client). Its `amount_cents` is
 *    already signed REVENUE-positive and resolved by account TYPE
 *    (REVENUE / COGS / OPEX / OTHER — there is NO `EXPENSE` type; canon §2), so we
 *    never key off account numbers.
 *  - P&L math per entity, by TYPE:
 *        gross profit = revenue − COGS
 *        net income   = gross profit − OpEx − OTHER
 *        gross margin% = gross profit / revenue ; net margin% = net income / revenue
 *  - Roll-up is a straight sum of the per-entity rows (a management portfolio view).
 *    NOTE: this does NOT apply intercompany/interdepartmental eliminations — that is
 *    the job of the /reports Consolidated statement (GATE 11a). Internal activity is
 *    real to each entity's own P&L and is preserved here.
 *
 * All money is bigint cents end-to-end.
 */

const querySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type AcctType = 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';
const PL_TYPES: AcctType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

interface EntityRow {
  locationId: string;
  name: string;
  shortCode: string;
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  opexCents: number;
  otherCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  hasActivity: boolean;
}

/** margin % (2dp) or null when there is no revenue to divide by. */
function marginPct(num: number, revenue: number): number | null {
  if (revenue <= 0) return null;
  return Math.round((num / revenue) * 10000) / 100;
}

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const now = new Date();
  const startDate =
    params.start_date ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const endDefault = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const endDate = params.end_date ?? endDefault.toISOString().split('T')[0];

  // ── Entity roster (canonical master data; active entities only) ──────────────
  const { data: locations, error: locErr } = await ctx.supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');
  if (locErr) {
    console.error('[profitability] location roster error:', locErr);
    return NextResponse.json({ error: locErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  // ── P&L rows for the period (RLS-scoped, security_invoker view) ──────────────
  const { data: pl, error: plErr } = await ctx.supabase
    .from('v_income_statement')
    .select('location_id, account_type, amount_cents')
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);
  if (plErr) {
    console.error('[profitability] income-statement view error:', plErr);
    return NextResponse.json({ error: plErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  // ── Aggregate signed amount by location × account TYPE ───────────────────────
  const agg = new Map<string, Record<AcctType, number>>();
  for (const r of pl ?? []) {
    const locId = (r.location_id as string | null) ?? null;
    if (!locId) continue; // P&L with no entity can't be attributed to a portfolio row
    const type = r.account_type as AcctType;
    if (!PL_TYPES.includes(type)) continue;
    let bucket = agg.get(locId);
    if (!bucket) {
      bucket = { REVENUE: 0, COGS: 0, OPEX: 0, OTHER: 0 };
      agg.set(locId, bucket);
    }
    bucket[type] += Number(r.amount_cents ?? 0);
  }

  // ── Build one P&L row per entity ─────────────────────────────────────────────
  const entities: EntityRow[] = (locations ?? []).map((loc) => {
    const b = agg.get(loc.id as string) ?? { REVENUE: 0, COGS: 0, OPEX: 0, OTHER: 0 };
    const revenue = b.REVENUE;
    const cogs = b.COGS;
    const opex = b.OPEX;
    const other = b.OTHER;
    const grossProfit = revenue - cogs;
    const netIncome = grossProfit - opex - other;
    return {
      locationId: loc.id as string,
      name: loc.name as string,
      shortCode: (loc.short_code as string) ?? '',
      revenueCents: revenue,
      cogsCents: cogs,
      grossProfitCents: grossProfit,
      opexCents: opex,
      otherCents: other,
      netIncomeCents: netIncome,
      grossMarginPct: marginPct(grossProfit, revenue),
      netMarginPct: marginPct(netIncome, revenue),
      hasActivity: revenue !== 0 || cogs !== 0 || opex !== 0 || other !== 0,
    };
  });

  // Default rank: most profitable first (client can re-sort any column).
  entities.sort((a, b) => b.netIncomeCents - a.netIncomeCents);

  // ── Portfolio roll-up (straight sum of the per-entity rows) ──────────────────
  const sum = entities.reduce(
    (acc, e) => {
      acc.revenueCents += e.revenueCents;
      acc.cogsCents += e.cogsCents;
      acc.opexCents += e.opexCents;
      acc.otherCents += e.otherCents;
      return acc;
    },
    { revenueCents: 0, cogsCents: 0, opexCents: 0, otherCents: 0 },
  );
  const grossProfitCents = sum.revenueCents - sum.cogsCents;
  const netIncomeCents = grossProfitCents - sum.opexCents - sum.otherCents;

  const active = entities.filter((e) => e.hasActivity);
  const profitableCount = active.filter((e) => e.netIncomeCents > 0).length;
  const unprofitableCount = active.filter((e) => e.netIncomeCents < 0).length;

  // ── Period label ─────────────────────────────────────────────────────────────
  const isFullMonth = startDate.slice(8) === '01' && startDate.slice(0, 7) === endDate.slice(0, 7);
  const label = isFullMonth
    ? new Date(`${startDate}T00:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : `${startDate} → ${endDate}`;

  return NextResponse.json({
    period: { startDate, endDate, label },
    generatedAt: new Date().toISOString(),
    rollup: {
      revenueCents: sum.revenueCents,
      cogsCents: sum.cogsCents,
      grossProfitCents,
      opexCents: sum.opexCents,
      otherCents: sum.otherCents,
      netIncomeCents,
      grossMarginPct: marginPct(grossProfitCents, sum.revenueCents),
      netMarginPct: marginPct(netIncomeCents, sum.revenueCents),
      entityCount: entities.length,
      activeCount: active.length,
      profitableCount,
      unprofitableCount,
    },
    entities,
  });
});
