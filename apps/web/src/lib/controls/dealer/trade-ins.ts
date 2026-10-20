/**
 * DL-11 — Trade-in risk (FPB §6). MEDIUM.
 *
 *   over-allowance  the trade's over-allowance ≥ `over_allowance_warn_bps` of the
 *                   sale price (D1's `overAllowanceBps`)      key DL-11:<trade>:over_allowance
 *   lien            a lien OWED / PROPOSED more than `lien_unpaid_days` after the
 *                   POSTED sale                               key DL-11:<trade>:lien
 */

import { diffDays } from '@/lib/dealer/dates';
import { overAllowanceBps } from '@/lib/dealer/engine/sale';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { bpsToPct, dateLabel } from '@/lib/dealer/ui/format';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { DEALER_FEATURES, money, plural, readFail, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export interface TradeIn {
  id: string;
  sale_id: string | null;
  serial_number: string | null;
  model: string | null;
  status: string;
  over_allowance_cents: number;
  lien_payoff_cents: number;
  lien_status: string;
}

export interface TradeSale {
  id: string;
  sale_date: string;
  sale_price_cents: number;
  status: string;
  unit_serial: string | null;
}

export function tradeRiskFindings(input: {
  asOf: string;
  overAllowanceWarnBps: number;
  lienUnpaidDays: number;
  trades: TradeIn[];
  sales: Map<string, TradeSale>;
}): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const t of input.trades) {
    if (t.status === 'VOID' || !t.sale_id) continue;
    const sale = input.sales.get(t.sale_id);
    if (!sale || sale.status === 'VOID') continue;
    const dealFor = sale.unit_serial ? `deal for serial ${sale.unit_serial}` : 'a unit deal';
    const tradeLabel = t.serial_number ? `trade serial ${t.serial_number}` : t.model ? `trade ${t.model}` : 'the trade';
    const base = {
      control: 'DL-11',
      href: dealerLinks.deal(sale.id),
      subjects: { trade_in_id: t.id, sale_id: sale.id },
      subjectTable: 'trade_ins',
      subjectId: t.id,
    };
    if (t.over_allowance_cents > 0) {
      const bps = overAllowanceBps(t.over_allowance_cents, sale.sale_price_cents);
      if (bps >= input.overAllowanceWarnBps) {
        out.push({
          ...base,
          kind: 'over_allowance',
          dedupKey: `DL-11:${t.id}:over_allowance`,
          severity: 'MEDIUM',
          amountAtRiskCents: t.over_allowance_cents,
          title: `Large trade over-allowance: ${dealFor} · ${money(t.over_allowance_cents)} (${bpsToPct(bps, 1)} of the sale)`,
          reason: `The customer was allowed ${money(t.over_allowance_cents)} more for ${tradeLabel} than it is worth, which is ${bpsToPct(bps, 1)} of the ${money(sale.sale_price_cents)} sale (the warning level is ${bpsToPct(input.overAllowanceWarnBps, 0)}). Over-allowance comes straight out of the deal's gross.`,
          question: 'Have the sales manager confirm the trade value and the deal gross.',
          facts: { over_allowance_bps: bps, sale_price_cents: sale.sale_price_cents },
        });
      }
    }
    if ((t.lien_status === 'OWED' || t.lien_status === 'PROPOSED') && t.lien_payoff_cents > 0 && sale.status === 'POSTED') {
      const days = diffDays(sale.sale_date, input.asOf);
      if (days > input.lienUnpaidDays) {
        out.push({
          ...base,
          kind: 'lien',
          dedupKey: `DL-11:${t.id}:lien`,
          severity: 'MEDIUM',
          amountAtRiskCents: t.lien_payoff_cents,
          title: `Trade-in lien unpaid: ${tradeLabel} · ${money(t.lien_payoff_cents)} owed ${plural(days, 'day')} after the sale`,
          reason: `The ${money(t.lien_payoff_cents)} lien on ${tradeLabel} is still ${t.lien_status === 'PROPOSED' ? 'waiting for release' : 'unpaid'} ${plural(days, 'day')} after the ${dateLabel(sale.sale_date)} sale. Until the lienholder is paid the dealer can't deliver clear title on resale.`,
          question: t.lien_status === 'PROPOSED' ? 'Release the lien payoff (a second person releases it).' : 'Propose the lien payoff to the lienholder.',
          facts: { sale_date: sale.sale_date, days_since_sale: days, lien_status: t.lien_status },
        });
      }
    }
  }
  return out;
}

async function collect(c: ClientScan): Promise<DealerFinding[]> {
  const tRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('trade_ins')
        .select('id, sale_id, serial_number, model, status, over_allowance_cents, lien_payoff_cents, lien_status')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['DRAFT', 'APPROVED', 'POSTED'])
        .not('sale_id', 'is', null),
    { label: 'DL-11 trade-ins' },
  );
  if (tRes.error) readFail('Trade-ins lookup failed', tRes.error);
  const trades = (tRes.data ?? []).map((t) => ({
    id: t.id as string,
    sale_id: (t.sale_id as string | null) ?? null,
    serial_number: (t.serial_number as string | null) ?? null,
    model: (t.model as string | null) ?? null,
    status: String(t.status),
    over_allowance_cents: Number(t.over_allowance_cents ?? 0),
    lien_payoff_cents: Number(t.lien_payoff_cents ?? 0),
    lien_status: String(t.lien_status ?? 'NONE'),
  }));
  // Only trades that can fire need their sale.
  const relevant = trades.filter((t) => t.over_allowance_cents > 0 || t.lien_status === 'OWED' || t.lien_status === 'PROPOSED');
  const saleIds = [...new Set(relevant.map((t) => t.sale_id).filter((x): x is string => !!x))];
  const sales = new Map<string, TradeSale>();
  for (let i = 0; i < saleIds.length; i += 200) {
    const s = await c.db
      .from('dealer_unit_sales')
      .select('id, unit_id, sale_date, sale_price_cents, status')
      .eq('org_id', c.orgId)
      .in('id', saleIds.slice(i, i + 200));
    if (s.error) readFail('Sales lookup failed', s.error);
    const rows = (s.data ?? []) as Array<{ id: string; unit_id: string; sale_date: string; sale_price_cents: number; status: string }>;
    const unitIds = [...new Set(rows.map((r) => r.unit_id))];
    const serials = new Map<string, string>();
    if (unitIds.length) {
      const u = await c.db.from('dealer_units').select('id, serial_number').eq('org_id', c.orgId).in('id', unitIds);
      if (u.error) readFail('Units lookup failed', u.error);
      for (const x of (u.data ?? []) as Array<{ id: string; serial_number: string }>) serials.set(x.id, x.serial_number);
    }
    for (const r of rows) {
      sales.set(r.id, { id: r.id, sale_date: r.sale_date, sale_price_cents: Number(r.sale_price_cents), status: r.status, unit_serial: serials.get(r.unit_id) ?? null });
    }
  }
  return tradeRiskFindings({
    asOf: c.asOf,
    overAllowanceWarnBps: c.settings.over_allowance_warn_bps,
    lienUnpaidDays: c.settings.lien_unpaid_days,
    trades: relevant,
    sales,
  });
}

export const TRADE_RISK_DETECTOR: DealerDetectorDef = {
  key: 'dealer_trade_risk',
  feature: DEALER_FEATURES.TRADE_RISK,
  control: 'DL-11',
  label: 'Trade-in over-allowance and unpaid liens',
  collect,
};
