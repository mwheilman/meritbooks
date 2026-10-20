/**
 * Read models for D2: sold-out-of-trust findings, the dealer-home summary, tie-out.
 * Every read runs on the caller's RLS client (d.db).
 */

import { detectSoldOutOfTrust, type SotFinding, type SotSignal } from '../engine/sot';
import { ageBucket, evaluateTieout, oldestDays, RECEIVABLE_EDGES, type AgeBucket, type TieoutRow } from '../engine/summary';
import { addDays, monthBounds } from '../dates';
import type { DealerCtx } from './context';
import { dbFail } from './errors';
import { coerceMoney } from './rows';
import { loadSettings, loadTieout } from './settings';

type Read = Pick<DealerCtx, 'db' | 'orgId' | 'locationId'>;

export async function loadSotFindings(d: Read, asOf: string): Promise<SotFinding[]> {
  const settings = await loadSettings(d);
  const [notesRes, dealsRes, auditRes] = await Promise.all([
    d.db.from('floor_plan_notes').select('id, unit_id, line_id, status, principal_balance_cents, sold_date, payoff_due_date')
      .eq('org_id', d.orgId).eq('location_id', d.locationId).in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT']).not('unit_id', 'is', null),
    d.db.from('dealer_unit_sales').select('unit_id, sale_date, external_deal_ref')
      .eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'PROPOSED').eq('source', 'DMS'),
    d.db.from('lender_statement_lines').select('matched_note_id, disposition_date, statement_id, lender_code')
      .eq('org_id', d.orgId).eq('location_id', d.locationId).eq('sau_flag', true).not('matched_note_id', 'is', null),
  ]);
  for (const r of [notesRes, dealsRes, auditRes]) if (r.error) dbFail('SOT inputs lookup failed', r.error);
  const notes = ((notesRes.data ?? []) as Record<string, unknown>[]).map((r) =>
    coerceMoney<{ id: string; unit_id: string; line_id: string; status: 'OPEN' | 'SOLD_UNPAID' | 'IN_DEFAULT'; principal_balance_cents: number; sold_date: string | null; payoff_due_date: string | null }>(r),
  );
  const unitIds = notes.map((n) => n.unit_id);
  const unitsRes = unitIds.length
    ? await d.db.from('dealer_units').select('id, serial_number, status, warranty_registered_date').eq('org_id', d.orgId).in('id', unitIds)
    : { data: [], error: null };
  if (unitsRes.error) dbFail('Units lookup failed', unitsRes.error);

  const statementIds = [...new Set(((auditRes.data ?? []) as { statement_id: string }[]).map((x) => x.statement_id))];
  const stRes = statementIds.length
    ? await d.db.from('lender_statements').select('id, statement_date').eq('org_id', d.orgId).in('id', statementIds)
    : { data: [], error: null };
  if (stRes.error) dbFail('Statements lookup failed', stRes.error);
  const stDate = new Map(((stRes.data ?? []) as { id: string; statement_date: string }[]).map((s) => [s.id, s.statement_date]));
  const noteUnit = new Map(notes.map((n) => [n.id, n.unit_id]));

  const signals: SotSignal[] = [
    ...((dealsRes.data ?? []) as { unit_id: string; sale_date: string; external_deal_ref: string | null }[]).map((x) => ({
      unitId: x.unit_id, source: 'DMS_DEAL' as const, date: x.sale_date, ref: x.external_deal_ref,
    })),
    ...((auditRes.data ?? []) as { matched_note_id: string; disposition_date: string | null; statement_id: string; lender_code: string | null }[])
      .filter((x) => noteUnit.has(x.matched_note_id))
      .map((x) => ({
        unitId: noteUnit.get(x.matched_note_id)!, source: 'LENDER_AUDIT' as const,
        date: x.disposition_date ?? stDate.get(x.statement_id) ?? asOf, ref: x.lender_code,
      })),
  ];
  return detectSoldOutOfTrust({
    asOf,
    graceDays: settings.sot_grace_days,
    notes,
    units: (unitsRes.data ?? []) as { id: string; serial_number: string; status: string; warranty_registered_date: string | null }[],
    signals,
  });
}

export interface LinePosition {
  lineId: string;
  lineName: string;
  lenderVendorId: string;
  lineStatus: string;
  creditLimitCents: number;
  principalCents: number;
  openNoteCount: number;
  soldUnpaidCount: number;
  soldUnpaidCents: number;
  accruedInterestCents: number;
  curtailmentsDue30dCents: number;
  utilizationBps: number | null;
  nextMaturityDate: string | null;
  lastReconciledDate: string | null;
}

export interface DealerSummary {
  asOf: string;
  enabled: boolean;
  floorPlan: { lines: LinePosition[]; totalPrincipalCents: number; totalLimitCents: number; utilizationBps: number | null };
  interestMtdCents: number;
  units: { inStockCount: number; inStockCostCents: number; flooredCount: number; ownedCount: number; byAge: AgeBucket[]; over365Count: number; withinTermWarning: number };
  sot: { count: number; criticalCount: number; principalCents: number; oldestDays: number | null };
  curtailmentsDue14d: { count: number; cents: number; missedCount: number };
  warranty: { openCents: number; byAge: AgeBucket[]; over60Cents: number };
  incentives: { openCents: number; byAge: AgeBucket[]; over60Cents: number };
  tieout: { ok: boolean; problems: string[]; rows: TieoutRow[] };
}

export async function loadSummary(d: Read, asOf: string): Promise<DealerSummary> {
  const settings = await loadSettings(d);
  const month = monthBounds(asOf);
  const [posRes, unitRes, curtRes, wRes, iRes, intRes, recRes] = await Promise.all([
    d.db.from('v_floor_plan_position').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId),
    d.db.from('v_unit_aging').select('unit_id, cost_cents, received_date, is_floored, maturity_date, is_consignment').eq('org_id', d.orgId).eq('location_id', d.locationId),
    d.db.from('floor_plan_curtailments').select('amount_cents, status, due_date').eq('org_id', d.orgId).eq('location_id', d.locationId).in('status', ['DUE', 'MISSED']).lte('due_date', addDays(asOf, 14)),
    d.db.from('v_warranty_aging').select('open_cents, submitted_date, status').eq('org_id', d.orgId).eq('location_id', d.locationId).neq('status', 'DRAFT'),
    d.db.from('v_incentive_aging').select('open_cents, submitted_date, earned_date').eq('org_id', d.orgId).eq('location_id', d.locationId),
    d.db.from('floor_plan_transactions').select('txn_type, interest_cents, accrual_cleared_cents').eq('org_id', d.orgId).eq('location_id', d.locationId)
      .eq('status', 'POSTED').in('txn_type', ['INTEREST_ACCRUAL', 'INTEREST_BILLED']).gte('txn_date', month.start).lte('txn_date', month.end),
    d.db.from('lender_statements').select('line_id, statement_date').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'APPROVED'),
  ]);
  for (const r of [posRes, unitRes, curtRes, wRes, iRes, intRes, recRes]) if (r.error) dbFail('Summary lookup failed', r.error);

  const lastRec = new Map<string, string>();
  for (const r of (recRes.data ?? []) as { line_id: string; statement_date: string }[]) {
    if (!lastRec.has(r.line_id) || r.statement_date > lastRec.get(r.line_id)!) lastRec.set(r.line_id, r.statement_date);
  }
  const lines: LinePosition[] = ((posRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    lineId: r.line_id as string,
    lineName: r.line_name as string,
    lenderVendorId: r.lender_vendor_id as string,
    lineStatus: r.line_status as string,
    creditLimitCents: Number(r.credit_limit_cents),
    principalCents: Number(r.principal_cents),
    openNoteCount: Number(r.open_note_count),
    soldUnpaidCount: Number(r.sold_unpaid_count),
    soldUnpaidCents: Number(r.sold_unpaid_cents),
    accruedInterestCents: Number(r.accrued_interest_cents),
    curtailmentsDue30dCents: Number(r.curtailments_due_30d_cents),
    utilizationBps: r.utilization_bps == null ? null : Number(r.utilization_bps),
    nextMaturityDate: (r.next_maturity_date as string | null) ?? null,
    lastReconciledDate: lastRec.get(r.line_id as string) ?? null,
  }));
  const totalPrincipal = lines.reduce((s, l) => s + l.principalCents, 0);
  const totalLimit = lines.reduce((s, l) => s + l.creditLimitCents, 0);

  const units = ((unitRes.data ?? []) as Record<string, unknown>[])
    .filter((u) => u.is_consignment !== true)
    .map((u) => ({ cost: Number(u.cost_cents), received: (u.received_date as string | null) ?? null, floored: u.is_floored === true, maturity: (u.maturity_date as string | null) ?? null }));
  const unitAge = ageBucket(units, settings.aging_buckets, asOf, (u) => ({ date: u.received, cents: u.cost }));
  const over365 = units.filter((u) => u.received && addDays(u.received, 365) < asOf).length;
  const termWarn = units.filter((u) => u.maturity && u.maturity <= addDays(asOf, settings.term_warning_days)).length;

  let interestMtd = 0;
  for (const t of (intRes.data ?? []) as { txn_type: string; interest_cents: number; accrual_cleared_cents: number }[]) {
    interestMtd += t.txn_type === 'INTEREST_ACCRUAL' ? Number(t.interest_cents) : Number(t.interest_cents) - Number(t.accrual_cleared_cents);
  }

  const curts = (curtRes.data ?? []) as { amount_cents: number; status: string }[];
  const w = ((wRes.data ?? []) as { open_cents: number; submitted_date: string | null }[]).map((x) => ({ cents: Number(x.open_cents), date: x.submitted_date }));
  const inc = ((iRes.data ?? []) as { open_cents: number; submitted_date: string | null; earned_date: string }[]).map((x) => ({ cents: Number(x.open_cents), date: x.submitted_date ?? x.earned_date }));
  const wAge = ageBucket(w, RECEIVABLE_EDGES, asOf, (x) => x);
  const iAge = ageBucket(inc, RECEIVABLE_EDGES, asOf, (x) => x);
  const over60 = (b: AgeBucket[]) => b.filter((x) => x.minDays > 60).reduce((s, x) => s + x.cents, 0);

  const sot = await loadSotFindings(d, asOf);
  const tieRows = await loadTieout(d);
  const tie = evaluateTieout(tieRows);

  return {
    asOf,
    enabled: settings.enabled,
    floorPlan: { lines, totalPrincipalCents: totalPrincipal, totalLimitCents: totalLimit, utilizationBps: totalLimit > 0 ? Math.round((totalPrincipal * 10_000) / totalLimit) : null },
    interestMtdCents: interestMtd,
    units: {
      inStockCount: units.length,
      inStockCostCents: units.reduce((s, u) => s + u.cost, 0),
      flooredCount: units.filter((u) => u.floored).length,
      ownedCount: units.filter((u) => !u.floored).length,
      byAge: unitAge.buckets,
      over365Count: over365,
      withinTermWarning: termWarn,
    },
    sot: {
      count: sot.length,
      criticalCount: sot.filter((f) => f.severity === 'CRITICAL').length,
      principalCents: sot.reduce((s, f) => s + f.principalCents, 0),
      oldestDays: oldestDays(sot.map((f) => f.earliestSaleDate), asOf),
    },
    curtailmentsDue14d: {
      count: curts.length,
      cents: curts.reduce((s, c) => s + Number(c.amount_cents), 0),
      missedCount: curts.filter((c) => c.status === 'MISSED').length,
    },
    warranty: { openCents: w.reduce((s, x) => s + x.cents, 0), byAge: wAge.buckets, over60Cents: over60(wAge.buckets) },
    incentives: { openCents: inc.reduce((s, x) => s + x.cents, 0), byAge: iAge.buckets, over60Cents: over60(iAge.buckets) },
    tieout: { ...tie, rows: tieRows },
  };
}
