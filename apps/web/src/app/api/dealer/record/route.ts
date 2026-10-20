export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { DealerError, dbFail } from '@/lib/dealer/service/errors';
import { coerceMoney } from '@/lib/dealer/service/rows';

/**
 * GET /api/dealer/record?locationId=&kind=warranty|incentive|oem_program|oem_statement&id=
 *
 * One manufacturer-receivable record by id (slice D2-C: the warranty / incentive
 * drawers open from `?claim=<id>` deep links, and the OEM statement workspace needs
 * its header). The D1 list routes don't filter by id. Read-only, through the caller's
 * RLS client (tenant + client scope enforced by the database), org + client pinned.
 * → { data: Row } (whole row, *_cents as numbers) · 404 NOT_FOUND.
 */
const TABLES = {
  warranty: { table: 'warranty_claims', what: 'Warranty claim' },
  incentive: { table: 'oem_incentive_claims', what: 'Incentive claim' },
  oem_program: { table: 'oem_programs', what: 'Manufacturer program' },
  oem_statement: { table: 'oem_statements', what: 'Manufacturer statement' },
} as const;

const query = z.object({
  locationId: z.string().uuid(),
  kind: z.enum(['warranty', 'incentive', 'oem_program', 'oem_statement']),
  id: z.string().uuid(),
});

export const GET = apiQueryHandler(
  query,
  dealerAction<z.infer<typeof query>>(DEALER_PERMS.view, async (b, d) => {
    const spec = TABLES[b.kind];
    const { data, error } = await d.db
      .from(spec.table)
      .select('*')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .eq('id', b.id)
      .maybeSingle();
    if (error) dbFail(`${spec.what} lookup failed`, error);
    if (!data) throw new DealerError('NOT_FOUND', `${spec.what} not found for this client`);
    return coerceMoney<Record<string, unknown>>(data as Record<string, unknown>);
  }),
);
