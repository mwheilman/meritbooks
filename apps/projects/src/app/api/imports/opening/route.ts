export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { draftFor, ENTITIES_FOR_KIND } from '@/lib/imports/opening';
import { committedRows, listHandoffs, stageHandoff, tieOut } from '@/lib/imports/server';
import { OPENING_KINDS, type ImportEntity } from '@/lib/imports/types';

const Query = z.object({ companyId: z.string().uuid() });
const Body = z.object({
  companyId: z.string().uuid(),
  kind: z.enum(OPENING_KINDS),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the cut-over date'),
  sourceReportedDeferredCents: z.number().int().min(0).max(1e13).nullish(),
});

/** GET /api/imports/opening?companyId — the opening positions handed to Books, with their last tie-out. */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  return { handoffs: await listHandoffs(db, query.companyId) };
});

/**
 * POST /api/imports/opening — build the opening position of one kind from the committed imports
 * (mid-stream jobs → JOB_WIP; agreements → AGREEMENT_DEFERRED; units → DEALER_UNITS; …), stage it
 * (pm.opening_stage_handoff re-foots every total) and tie it out against Books right away.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const { rows, batchIds } = await committedRows(db, body.companyId, ENTITIES_FOR_KIND[body.kind] as ImportEntity[]);
  const draft = draftFor(body.kind, rows, body.asOf, { sourceReportedDeferredCents: body.sourceReportedDeferredCents ?? null });
  const staged = await stageHandoff(db, body.companyId, draft, batchIds);
  const tie = await tieOut(db, staged.handoff_id);
  return { handoff: staged, warnings: draft.payload.warnings, tieout: tie };
});
