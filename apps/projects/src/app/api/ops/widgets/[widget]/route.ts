export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { getScope } from '@/lib/scope';
import { APP_TZ, todayIso } from '@/lib/time';
import { localParts } from '@/lib/pm/ops/dispatch-math';
import {
  WIDGET_KEYS, loadDrawsInFlight, loadSelectionsDue, loadShop, loadSignals, loadTodaysVisits, type WidgetKey,
} from '@/lib/pm/ops/widget-queries';

const Query = z.object({
  /** Narrow to one company inside the current view (it must be one of the view's companies). */
  companyId: z.string().uuid().optional(),
});

/**
 * Home widgets (components/ops/widgets): Signals (pm.kpi_defs + pm.v_kpis), Today's visits
 * (dispatch_assignments on today + v_dispatch_queue), Shop load (v_work_center_load +
 * v_production_status), Selections due (v_selection_status) and Draws in flight (v_draw_summary).
 * Read-only, RLS client, scoped to the companies the current view covers.
 */
export const GET = route({ query: Query }, async ({ db, params, query, tenant }) => {
  const key = params.widget as WidgetKey;
  if (!(WIDGET_KEYS as ReadonlyArray<string>).includes(key)) throw new HttpError(404, 'There is no such home widget.', 'NOT_FOUND');
  const s = await getScope();
  const inView = s.kind === 'ready' ? s.scope.companyIds : tenant.companies.map((c) => c.id);
  if (query.companyId && !inView.includes(query.companyId)) throw new HttpError(403, 'That company is not in this view.', 'FORBIDDEN');
  const companyIds = query.companyId ? [query.companyId] : inView;
  const names = Object.fromEntries(tenant.companies.map((c) => [c.id, c.name]));
  const today = todayIso();
  const now = Date.now();
  switch (key) {
    case 'signals': return loadSignals(db, companyIds, names);
    case 'visits': return loadTodaysVisits(db, companyIds, today, localParts(new Date(now).toISOString(), APP_TZ).minutes);
    case 'shop': return loadShop(db, companyIds, today);
    case 'selections': return loadSelectionsDue(db, companyIds, today);
    case 'draws': return loadDrawsInFlight(db, companyIds, now);
  }
});
