export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { Uuid } from '@/lib/pm/money/schemas';
import { loadAudit, loadAuditCompany } from '@/lib/commercial/server';

/**
 * GET /api/commercial/audit?jobId= | ?companyId= — the billing auditor (CGC-53): approved COs
 * not on the SOV, signed T&M not billed, stored material not billed, retainage ready to bill,
 * over / under billing, subs approved past owner billing, work proceeding unpriced, cutoffs missed.
 */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing', 'job'], query: z.object({ jobId: Uuid.optional(), companyId: Uuid.optional() }) }, async ({ db, query }) => {
  if (query.jobId) return { findings: await loadAudit(db, query.jobId) };
  if (query.companyId) return { findings: await loadAuditCompany(db, query.companyId) };
  throw new HttpError(422, 'Pick a job or a company.', 'VALIDATION');
});
