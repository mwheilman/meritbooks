export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { ADAPTERS } from '@/lib/imports/adapters';
import { ENTITY_DEFS } from '@/lib/imports/fields';
import { listBatches, listHandoffs } from '@/lib/imports/server';

const Query = z.object({ companyId: z.string().uuid() });

/**
 * GET /api/imports?companyId — the "where does your work live today" catalog (one tile per source,
 * its export recipes and how-to card), this company's imports and its opening positions for Books.
 */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  const [batches, handoffs] = await Promise.all([listBatches(db, query.companyId), listHandoffs(db, query.companyId)]);
  return {
    sources: ADAPTERS.map((a) => ({
      id: a.id, name: a.name, family: a.family, viaBooks: Boolean(a.viaBooks), howToExport: a.howToExport,
      files: a.entities.map((e) => ({ entity: e.entity, label: e.label, effect: ENTITY_DEFS[e.entity].effect, disposition: ENTITY_DEFS[e.entity].disposition })),
    })),
    batches,
    handoffs: handoffs.map(({ tieout, ...h }) => ({ ...h, tieSummary: tieout?.summary ?? null })),
  };
});
