/**
 * Route glue for /api/dealer/** — keeps every route file a few lines:
 *
 *   export const POST = apiHandler(schema, dealerAction(DEALER_PERMS.post, (b, d) => service(d, b)));
 *
 * apiHandler (reserved spine) does Clerk auth + Zod + error capture; dealerAction adds
 * requirePermission(locationId) + the RLS client-access check, opens the DealerCtx, and
 * maps every dealer/engine/DB refusal to a consistent { error, code, details } response.
 * Success is always { data }.
 */

import { NextResponse } from 'next/server';
import type { ApiContext } from '@/lib/api-handler';
import { openDealerContext, type DealerCtx, type DealerPermission } from './service/context';
import { dealerErrorResponse } from './service/errors';
import { listDealer, LIST_SPECS, type DealerListKind } from './service/lists';

export function dealerAction<T extends { locationId: string }>(
  perm: DealerPermission | ((body: T) => DealerPermission),
  fn: (body: T, d: DealerCtx) => Promise<unknown>,
  opts: { status?: number } = {},
) {
  return async (body: T, api: ApiContext): Promise<NextResponse> => {
    const p = typeof perm === 'function' ? perm(body) : perm;
    const d = await openDealerContext(api, body.locationId, p);
    if (d instanceof NextResponse) return d;
    try {
      const data = await fn(body, d);
      return NextResponse.json({ data }, { status: opts.status ?? 200 });
    } catch (e) {
      return dealerErrorResponse(e);
    }
  };
}

const RESERVED = new Set(['locationId', 'page', 'per_page', 'sort', 'dir', 'q', 'from', 'to']);

/** GET list handler body for a dealer list kind (paginated / sortable / filterable). */
export type DealerListQuery = { locationId: string } & Record<string, string | undefined>;

export function dealerList(kind: DealerListKind, perm: DealerPermission) {
  return dealerAction<DealerListQuery>(perm, async (q, d) => {
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && !RESERVED.has(k) && LIST_SPECS[kind].filters.includes(k)) filters[k] = v;
    }
    return listDealer(d, kind, {
      page: q.page, per_page: q.per_page, sort: q.sort, dir: q.dir === 'asc' ? 'asc' : q.dir === 'desc' ? 'desc' : undefined,
      q: q.q, from: q.from, to: q.to, filters,
    });
  });
}
