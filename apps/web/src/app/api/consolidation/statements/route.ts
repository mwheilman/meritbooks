export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { loadConsolidated } from '@/lib/consolidation/load';

/**
 * Consolidated financial statements (GATE 11a) — P&L + balance sheet across the
 * entity group, with an eliminations column, a non-controlling-interest line, and
 * one-line equity-method investments. RLS-scoped; the pure engine does the math.
 */
const querySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  root_entity_id: z.string().uuid().optional(),
  eliminate: z.enum(['true', 'false']).optional(),
  translate: z.enum(['true', 'false']).optional(),
  reporting_currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
});
type Query = z.infer<typeof querySchema>;

export const GET = apiQueryHandler(querySchema, async (params: Query, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const startDate = params.start_date ?? `${yyyy}-01-01`;
  const endDate = params.end_date ?? `${yyyy}-${mm}-${String(now.getUTCDate()).padStart(2, '0')}`;

  const loaded = await loadConsolidated(ctx.supabase, ctx.orgId, {
    startDate,
    endDate,
    rootEntityId: params.root_entity_id ?? null,
    eliminate: params.eliminate !== 'false',
    translate: params.translate !== 'false',
    reportingCurrency: params.reporting_currency
      ? params.reporting_currency.toUpperCase()
      : null,
  });

  return NextResponse.json({
    period: { startDate, endDate },
    rootEntityId: params.root_entity_id ?? null,
    entities: loaded.entities,
    entityMeta: loaded.entityMeta,
    ownershipTableAvailable: loaded.ownershipTableAvailable,
    intercompanyRolesResolved: loaded.intercompanyRolesResolved,
    scanned: loaded.scanned,
    fx: loaded.fx,
    ...loaded.result,
  });
});
