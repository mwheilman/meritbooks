export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { LOOKUP_KINDS, cleanIds, lookup } from '@/lib/dealer/lookups';

/**
 * GET /api/dealer/lookups?locationId=&kind=vendors|customers|departments|accounts|units|lines|programs|oem_programs
 *   &ids=a,b (resolve names)  or  &q=term (picker search)  [&types=ASSET,LIABILITY for accounts]
 * Read-only, RLS client (tenant + client scope). → { data: { items: LookupItem[] } }
 */
const query = z.object({
  locationId: z.string().uuid(),
  kind: z.enum(LOOKUP_KINDS),
  ids: z.string().max(8000).optional(),
  q: z.string().max(100).optional(),
  types: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER']);

export const GET = apiQueryHandler(
  query,
  dealerAction<z.infer<typeof query>>(DEALER_PERMS.view, async (b, d) => ({
    items: await lookup(d.db, {
      orgId: d.orgId,
      locationId: d.locationId,
      kind: b.kind,
      ids: cleanIds(b.ids),
      q: b.q,
      types: (b.types ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => ACCOUNT_TYPES.has(s)),
      limit: b.limit ? Number(b.limit) : undefined,
    }),
  })),
);
