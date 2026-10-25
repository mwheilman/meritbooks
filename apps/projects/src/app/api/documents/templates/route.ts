export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { generateDocument } from '@/lib/templates/generate';
import { TEMPLATE_MONEY, TEMPLATE_SOURCE } from '@/lib/templates/loaders';
import { TEMPLATE_KEYS } from '@/lib/templates/types';

/** GET /api/documents/templates — the templates this caller may generate (money templates need the money capability). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ access }) => ({
  templates: TEMPLATE_KEYS.map((key) => ({ key, source: TEMPLATE_SOURCE[key], moneyCap: TEMPLATE_MONEY[key], allowed: !TEMPLATE_MONEY[key] || can(access, TEMPLATE_MONEY[key]!, 'view') })),
}));

const Body = z.object({
  template: z.enum(TEMPLATE_KEYS),
  sourceId: z.string().uuid(),
  title: z.string().trim().max(200).optional(),
  customerSigners: z.array(z.string().trim().max(120).nullable()).max(4).optional(),
  waiverType: z.enum(['conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final']).optional(),
  throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  amountCents: z.number().int().min(0).max(1e13).nullable().optional(),
});

/**
 * POST /api/documents/templates — render a branded PDF from a record (estimate → proposal /
 * contract, change order, billing request → pay-app cover, work order / install ticket, daily log,
 * PO, dealer quote → buyer's order, draw, lien waiver) and file it as a document version.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: Body }, async ({ db, tenant, userId, access, body }) => {
  const money = TEMPLATE_MONEY[body.template];
  if (money && !can(access, money, 'view')) {
    throw new HttpError(403, `This document shows job dollars. You need ${money === 'projects.financials' ? 'cost' : 'contract value'} access to create it.`, 'FORBIDDEN');
  }
  const g = await generateDocument(db, { orgId: tenant.orgId, userId }, {
    template: body.template, sourceId: body.sourceId, title: body.title,
    options: { customerSigners: body.customerSigners, waiverType: body.waiverType, throughDate: body.throughDate, amountCents: body.amountCents },
  });
  return { ok: true, ...g };
});
