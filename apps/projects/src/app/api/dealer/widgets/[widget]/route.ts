export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { getScope } from '@/lib/scope';
import { todayIso } from '@/lib/time';
import { dealerCompanyIds } from '@/lib/pm/dealer/scope';
import { DEALER_WIDGET_KEYS, loadAging, loadDesk, loadPartsBelow, loadRentalsOut, type DealerWidgetKey } from '@/lib/pm/dealer/widget-queries';

const Query = z.object({ companyId: z.string().uuid().optional() });

/**
 * Dealer home widgets: Units aging over 180 days (v_dealer_unit_inventory), Deals to desk
 * (v_dealer_deals_pipeline), Parts below minimum (v_parts_on_hand) and Rentals out (rental_contracts +
 * v_rental_utilization). Read-only, RLS client, the dealer companies of the current view.
 */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: ['dealer_unit', 'dealer_deal', 'part', 'rental'], query: Query }, async ({ db, params, query, tenant }) => {
  const key = params.widget as DealerWidgetKey;
  if (!(DEALER_WIDGET_KEYS as ReadonlyArray<string>).includes(key)) throw new HttpError(404, 'There is no such home widget.', 'NOT_FOUND');
  const s = await getScope();
  const inView = s.kind === 'ready' ? s.scope.companyIds : tenant.companies.map((c) => c.id);
  if (query.companyId && !inView.includes(query.companyId)) throw new HttpError(403, 'That company is not in this view.', 'FORBIDDEN');
  const packs = s.kind === 'ready' ? Object.fromEntries(s.scope.installs.map((i) => [i.location_id, i.pack_key])) : {};
  const companyIds = await dealerCompanyIds(db, query.companyId ? [query.companyId] : inView, packs);
  switch (key) {
    case 'aging': return loadAging(db, companyIds);
    case 'desk': return loadDesk(db, companyIds);
    case 'parts': return loadPartsBelow(db, companyIds);
    case 'rentals': return loadRentalsOut(db, companyIds, todayIso());
  }
});
