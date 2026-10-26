/** Dashboard tab — the KPI cards of the effective dashboard (AC-W2). PURE over one dataset. */

import type { MonthKey } from '@/lib/analytics/months';
import type { EvaluateRequest } from '@/lib/metrics/types';
import { buildCard, type EvalCtx } from '../series';
import type { CardModel, DashboardCard, DashboardSettings } from '../types';

export function dashboardPlan(cards: readonly DashboardCard[], end: MonthKey, settings: DashboardSettings): EvaluateRequest[] {
  return cards.map((c) => ({ metric: c.metric, scope: { companyIds: [], weighting: 'full' }, periodEnd: end, basis: settings.basis, comparison: settings.comparison, sparkline: settings.sparkline }));
}

export function dashboardCards(ctx: EvalCtx, cards: readonly DashboardCard[], end: MonthKey, settings: DashboardSettings): CardModel[] {
  return cards.map((c) => buildCard(ctx, c.metric, end, settings.basis, settings.comparison, settings.sparkline));
}
