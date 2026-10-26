/**
 * Picker selection → the metric evaluator's period (PURE).
 *
 * The shared PeriodPicker speaks month · qtd · quarter · ytd · fy · ttm (· range, which the
 * registry cannot evaluate and /fpna does not offer). The registry evaluates windows that END
 * at a month: month · qtd · ytd · ttm. A whole quarter / fiscal year maps to its to-date
 * window at its last month; a window that runs past the current month is clamped to it
 * ("to date") — a future month is never evaluated as zero.
 */

import { compareMonths, type MonthKey } from '@/lib/analytics/months';
import { windowMonths } from '@/lib/metrics/evaluate';
import type { Basis, ComparisonKind } from '@/lib/metrics/types';
import { windowBounds, type PeriodBasis } from '@/lib/period/resolve';
import { COMPARISON_SHORT, windowLabel } from './series';
import type { WsPeriod } from './types';

export const PICKER_BASES: readonly PeriodBasis[] = ['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm'];

export interface PickerInput {
  end: MonthKey;
  basis: PeriodBasis;
  compare: ComparisonKind;
}

export function toMetricBasis(b: PeriodBasis): Basis {
  switch (b) {
    case 'month':
      return 'month';
    case 'qtd':
    case 'quarter':
      return 'qtd';
    case 'ytd':
    case 'fy':
      return 'ytd';
    case 'ttm':
      return 'ttm';
    case 'range':
      throw new Error('A custom range cannot be evaluated by the metric registry; choose month, quarter, year or TTM.');
    default: {
      const never: never = b;
      return never;
    }
  }
}

export function workspacePeriod(sel: PickerInput, fyStartMonth: number, currentMonth: MonthKey): WsPeriod {
  const basis = toMetricBasis(sel.basis);
  const snapped = sel.basis === 'quarter' || sel.basis === 'fy' ? windowBounds({ basis: sel.basis, end: sel.end }, fyStartMonth).end : sel.end;
  const end = compareMonths(snapped, currentMonth) > 0 ? currentMonth : snapped;
  const months = windowMonths(end, basis, fyStartMonth);
  return {
    end,
    basis,
    comparison: sel.compare,
    from: months[0],
    to: months[months.length - 1],
    label: windowLabel(end, basis),
    comparisonLabel: sel.compare === 'none' ? null : COMPARISON_SHORT[sel.compare],
    fyStartMonth,
  };
}
