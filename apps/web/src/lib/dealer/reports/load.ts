/**
 * Dealer report dispatcher: (report key, window) → { report, model }. Reads only
 * through the caller's RLS client. Period reports default to the current month;
 * point-in-time reports default to today.
 */

import { monthBounds, todayIso } from '@/lib/dealer/dates';
import type { StatementModel } from '@/lib/reports/export/statement-model';
import { dealerReportDef, type DealerReport, type DealerReportKey } from './catalog';
import { toStatementModel } from './model';
import { clientName, type ReportCtx } from './load-shared';
import { loadFloorPlanInterest, loadFloorPlanPosition } from './load-floor-plan';
import { loadUnitAging, loadUnitGross } from './load-units';
import { loadIncentiveAging, loadWarrantyAging } from './load-receivables';
import { loadDeptPnl } from './load-gl';
import { loadLenderRec } from './load-statements';

export interface DealerReportWindow {
  start?: string;
  end?: string;
  asOf?: string;
}

export function resolveWindow(key: DealerReportKey, w: DealerReportWindow, today = todayIso()): { start: string; end: string; asOf: string } {
  const month = monthBounds(today);
  const start = w.start ?? month.start;
  const end = w.end ?? (w.start ? monthBounds(w.start).end : month.end);
  const asOf = w.asOf ?? (dealerReportDef(key).mode === 'asOf' && w.end ? w.end : today);
  return { start, end, asOf };
}

export async function loadDealerReport(d: ReportCtx, key: DealerReportKey, w: DealerReportWindow): Promise<{ report: DealerReport; model: StatementModel }> {
  const { start, end, asOf } = resolveWindow(key, w);
  const entity = await clientName(d);
  let report: DealerReport;
  switch (key) {
    case 'dealer_fp_position':
      report = await loadFloorPlanPosition(d, asOf, entity);
      break;
    case 'dealer_fp_interest':
      report = await loadFloorPlanInterest(d, start, end, entity);
      break;
    case 'dealer_unit_aging':
      report = await loadUnitAging(d, asOf, entity);
      break;
    case 'dealer_unit_gross':
      report = await loadUnitGross(d, start, end, entity);
      break;
    case 'dealer_warranty_aging':
      report = await loadWarrantyAging(d, asOf, entity);
      break;
    case 'dealer_incentive_aging':
      report = await loadIncentiveAging(d, asOf, entity);
      break;
    case 'dealer_dept_pnl':
      report = await loadDeptPnl(d, start, end, entity);
      break;
    case 'dealer_lender_rec':
      report = await loadLenderRec(d, start, end, entity);
      break;
    default: {
      const never: never = key;
      throw new Error(`Unknown dealer report ${String(never)}`);
    }
  }
  return { report, model: toStatementModel(report) };
}
