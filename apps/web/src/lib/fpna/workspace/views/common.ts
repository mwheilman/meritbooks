/** Shared wording for the tab builders. PURE. */

import { shortMonthLabel, type MonthKey } from '@/lib/analytics/months';
import type { WsChartPeriod, WsValue } from '../types';

/** "Oct ’25 – Sep ’26". */
export function rangeLabel(months: readonly MonthKey[]): string {
  if (months.length === 0) return '';
  if (months.length === 1) return shortMonthLabel(months[0]);
  return `${shortMonthLabel(months[0])} – ${shortMonthLabel(months[months.length - 1])}`;
}

function list(labels: string[]): string {
  if (labels.length <= 3) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
}

/** Footer notes: preliminary (hatched) months and gaps (never drawn as zero). */
export function footnotesFor(periods: readonly WsChartPeriod[], actual: readonly WsValue[]): string[] {
  const out: string[] = [];
  const prelim = periods.filter((p) => p.status === 'preliminary').map((p) => p.longLabel);
  if (prelim.length) out.push(`${list(prelim)} ${prelim.length === 1 ? 'is' : 'are'} preliminary (books not closed) — hatched`);
  const gaps = periods.filter((_, i) => actual[i] === null).map((p) => p.longLabel);
  if (gaps.length) out.push(`No figures on file for ${list(gaps)} (shown as a gap, not zero)`);
  return out;
}
