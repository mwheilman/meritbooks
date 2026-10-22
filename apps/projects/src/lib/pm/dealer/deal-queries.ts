import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmQueryError } from '@/lib/api-errors';
import { one, rows } from '@/lib/pm/db';
import { vendorNames } from '@/lib/pm/ops/scope';
import type { ActivityRow } from '@/lib/pm/types';
import { loadSettings } from './scope';
import {
  DEAL_COLS, DEAL_LINE_COLS, DEPOSIT_COLS, FI_COLS, OUTBOX_MARK_COLS, PIPELINE_COLS, QUOTE_COLS, TRADE_COLS,
  type DealLineRow, type DealPipelineRow, type DealRow, type DealTotals, type DealerSettingsRow, type DepositRow, type FiProductRow,
  type FloorStatus, type OutboxMarkRow, type QuoteRow, type TradeRow, type UnitCondition, type UnitStatus,
} from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

/** Open deals, plus closed ones (delivered, unwound, lost) from the last 180 days. */
export async function loadPipeline(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<DealPipelineRow[]> {
  if (!companyIds.length) return [];
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const res = await pm(db).from('v_dealer_deals_pipeline').select(PIPELINE_COLS).in('location_id', [...companyIds])
    .or(`stage.in.(QUOTE,WRITTEN,APPROVED,FUNDED),stage_entered_at.gte."${since}"`).order('stage_entered_at', { ascending: false }).limit(1000);
  return rows<DealPipelineRow>(res, 'deals').map((d) => ({
    ...d,
    sale_price_cents: d.sale_price_cents == null ? null : Number(d.sale_price_cents),
    front_gross_cents: d.front_gross_cents == null ? null : Number(d.front_gross_cents),
    back_gross_cents: d.back_gross_cents == null ? null : Number(d.back_gross_cents),
    total_gross_cents: d.total_gross_cents == null ? null : Number(d.total_gross_cents),
    front_gross_pct: d.front_gross_pct == null ? null : Number(d.front_gross_pct),
    balance_due_estimate_cents: d.balance_due_estimate_cents == null ? null : Number(d.balance_due_estimate_cents),
  }));
}

/** A unit on a deal line: identity, stock status and Merit Books' floor-plan word. */
export interface DealUnit {
  id: string;
  stock_number: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  model_year: number | null;
  condition: UnitCondition | null;
  unit_status: UnitStatus | null;
  dealer_cost_cents: number;
  retail_price_cents: number | null;
  advertised_price_cents: number | null;
  floored: boolean;
  floor_status: FloorStatus | null;
  payoff_cents: number | null;
  payoff_due_on: string | null;
  payoff_scheduled: boolean;
  floor_status_at: string | null;
  floor_note_ref: string | null;
  sot_alert_at: string | null;
  deal_id: string | null;
  pdi_open: boolean;
  pdi_done: boolean;
}

export interface DealWorkspace {
  deal: DealRow;
  lines: DealLineRow[];
  trades: TradeRow[];
  fi: FiProductRow[];
  deposits: DepositRow[];
  quotes: QuoteRow[];
  totals: DealTotals;
  units: Record<string, DealUnit>;
  settings: DealerSettingsRow;
  customer: string | null;
  vendors: Record<string, string>;
  activity: ActivityRow[];
  finalized: OutboxMarkRow | null;
  depositMarks: Record<string, OutboxMarkRow>;
}

const UNIT_COLS =
  'id, stock_number, serial_number, make, model, model_year, condition, unit_status, dealer_cost_cents, retail_price_cents, advertised_price_cents, ' +
  'floored, floor_status, payoff_cents, payoff_due_on, payoff_scheduled, floor_status_at, floor_note_ref, sot_alert_at, deal_id';

export async function loadDealWorkspace(db: SupabaseClient, dealId: string): Promise<DealWorkspace | null> {
  const deal = one<DealRow>(await pm(db).from('v_dealer_deals_masked').select(DEAL_COLS).eq('id', dealId).maybeSingle(), 'deal');
  if (!deal) return null;
  const [lines, trades, fi, deposits, quotes, totalsRes, settings, activity] = await Promise.all([
    rows<DealLineRow>(await pm(db).from('v_dealer_deal_lines_masked').select(DEAL_LINE_COLS).eq('deal_id', dealId).order('sort').order('line_no'), 'deal lines'),
    rows<TradeRow>(await pm(db).from('v_dealer_trades_masked').select(TRADE_COLS).eq('deal_id', dealId).order('created_at'), 'trades'),
    rows<FiProductRow>(await pm(db).from('v_dealer_fi_products_masked').select(FI_COLS).eq('deal_id', dealId).order('sort').order('created_at'), 'F&I products'),
    rows<DepositRow>(await pm(db).from('dealer_deposits').select(DEPOSIT_COLS).eq('deal_id', dealId).order('created_at'), 'deposits'),
    rows<QuoteRow>(await pm(db).from('v_dealer_quotes_masked').select(QUOTE_COLS).eq('deal_id', dealId).order('version', { ascending: false }), 'quotes'),
    pm(db).rpc('dealer_deal_totals', { p_deal: dealId }),
    loadSettings(db, [deal.location_id]),
    rows<ActivityRow>(await pm(db).from('activity').select('id, location_id, job_id, actor_type, actor_id, verb, subject_table, subject_id, summary, meta, created_at').in('subject_table', ['dealer_deals', 'dealer_quotes', 'dealer_deposits']).eq('location_id', deal.location_id).order('created_at', { ascending: false }).limit(200), 'deal timeline'),
  ]);
  if (totalsRes.error) throw new PmQueryError('deal totals', totalsRes.error);
  const unitIds = lines.map((l) => l.asset_id).filter((x): x is string => !!x);
  const unitRows = unitIds.length ? rows<Omit<DealUnit, 'pdi_open' | 'pdi_done'>>(await pm(db).from('v_assets_masked').select(UNIT_COLS).in('id', unitIds), 'deal units') : [];
  const pdi = unitIds.length ? rows<{ asset_id: string; status: string }>(await pm(db).from('work_orders').select('asset_id, status').in('asset_id', unitIds).eq('kind', 'PDI'), 'PDI orders') : [];
  const units: Record<string, DealUnit> = {};
  for (const u of unitRows) {
    const mine = pdi.filter((w) => w.asset_id === u.id);
    units[u.id] = {
      ...u, dealer_cost_cents: Number(u.dealer_cost_cents), payoff_cents: u.payoff_cents == null ? null : Number(u.payoff_cents),
      pdi_open: mine.some((w) => !['COMPLETE', 'CLOSED', 'CANCELLED'].includes(w.status)),
      pdi_done: mine.some((w) => w.status === 'COMPLETE' || w.status === 'CLOSED'),
    };
  }
  const markIds = [deal.finalized_outbox_id, ...deposits.map((d) => d.outbox_id)].filter((x): x is string => !!x);
  const marks = markIds.length ? rows<OutboxMarkRow>(await pm(db).from('dealer_outbox').select(OUTBOX_MARK_COLS).in('id', markIds), 'deal acks') : [];
  const markById = new Map(marks.map((m) => [m.id, m]));
  const customer = deal.customer_id
    ? await db.schema('pm').from('v_core_customers_masked').select('name, display_name').eq('id', deal.customer_id).maybeSingle().then((r) => { const c = r.data as { name: string; display_name: string | null } | null; return c ? c.display_name || c.name : null; })
    : null;
  const vendors = await vendorNames(db, [deal.finance_vendor_id, ...trades.map((t) => t.lienholder_vendor_id), ...fi.map((f) => f.provider_vendor_id), ...lines.map((l) => l.oem_vendor_id)]);
  const quoteIds = new Set(quotes.map((q) => q.id));
  const depositIds = new Set(deposits.map((d) => d.id));
  return {
    deal: {
      ...deal,
      tax_rate_estimate: deal.tax_rate_estimate == null ? null : Number(deal.tax_rate_estimate),
      finance_reserve_cents: Number(deal.finance_reserve_cents),
      subvention_cents: Number(deal.subvention_cents),
      delivery_checklist: Array.isArray(deal.delivery_checklist) ? deal.delivery_checklist : [],
    },
    lines: lines.map((l) => ({ ...l, qty: Number(l.qty), unit_price_cents: Number(l.unit_price_cents), amount_cents: Number(l.amount_cents), cost_cents: Number(l.cost_cents) })),
    trades: trades.map((t) => ({ ...t, acv_cents: t.acv_cents == null ? null : Number(t.acv_cents), allowance_cents: Number(t.allowance_cents), over_allowance_cents: Number(t.over_allowance_cents), payoff_cents: Number(t.payoff_cents), meter_reading: t.meter_reading == null ? null : Number(t.meter_reading) })),
    fi: fi.map((f) => ({ ...f, price_cents: Number(f.price_cents), cost_cents: Number(f.cost_cents) })),
    deposits: deposits.map((d) => ({ ...d, amount_cents: Number(d.amount_cents) })),
    quotes,
    totals: totalsRes.data as DealTotals,
    units,
    settings: settings[deal.location_id]!,
    customer,
    vendors,
    activity: activity.filter((a) => (a.subject_table === 'dealer_deals' && a.subject_id === deal.id) || (a.subject_table === 'dealer_quotes' && !!a.subject_id && quoteIds.has(a.subject_id)) || (a.subject_table === 'dealer_deposits' && !!a.subject_id && depositIds.has(a.subject_id))).slice(0, 40),
    finalized: deal.finalized_outbox_id ? markById.get(deal.finalized_outbox_id) ?? null : null,
    depositMarks: Object.fromEntries(deposits.flatMap((d) => {
      const m = d.outbox_id ? markById.get(d.outbox_id) : undefined;
      return m ? [[d.id, m] as const] : [];
    })),
  };
}
