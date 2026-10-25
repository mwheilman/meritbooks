export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { VisitContext, WillCall } from '@/lib/fieldservice/completion-types';

/**
 * GET /api/field/fs-tools?workOrderId= — what the phone caches for a visit beyond the sell screen
 * (/api/field/service): the checklists this visit should use (fields, ranges, red-tag rules — the
 * phone validates offline with lib/fieldservice/rules.ts validateForm), which are done, the visit's
 * notes, the equipment at the site with age and coverage, and the will-call POs waiting for this
 * tech (pickup code, lines), the visit's customer id and — only for a caller who may read invoice
 * reviews (projects.billing / projects.dispatch view) — its invoice review: id, state, whether Books
 * has issued the invoice and whether this caller may send the pay link. The review total is included
 * only with contract value on the job (pm.fs_visit_context); nothing else carries money.
 */
const Q = z.object({ workOrderId: z.string().uuid().optional() });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  const willCalls = await rpcLoad<WillCall[]>(db, 'fs_my_will_calls', {}, []);
  if (!query.workOrderId) return { willCalls: willCalls.data };
  const w = await db.schema('pm').from('work_orders').select('id, location_id, site_id, job_id').eq('id', query.workOrderId).maybeSingle();
  const wo = w.data as { id: string; location_id: string; site_id: string | null; job_id: string } | null;
  if (!wo) throw new HttpError(404, 'That visit was not found, or it is not yours.', 'NOT_FOUND');
  assertCompany(tenant, wo.location_id);
  const [ctx, forms, notes, equipment] = await Promise.all([
    rpcLoad<VisitContext | null>(db, 'fs_visit_context', { p_wo: wo.id }, null),
    rpcLoad<unknown[]>(db, 'fs_forms_for_wo', { p_wo: wo.id }, []),
    db.schema('pm').from('fs_visit_notes').select('id, source, diagnosis, work_performed, recommendations, customer_summary, created_at').eq('work_order_id', wo.id).order('created_at'),
    wo.site_id
      ? db.schema('pm').from('v_fs_asset_summary').select('asset_id, equipment_type, make, model, serial_number, age_years, parts_warranty_ends_on, labor_warranty_ends_on, parts_covered').eq('site_id', wo.site_id)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const r = ctx.data?.invoice_review ?? null;
  return {
    workOrderId: wo.id, jobId: wo.job_id, customerId: ctx.data?.customer_id ?? null,
    invoiceReview: r ? { id: r.id, status: r.status, flagCount: r.flag_count, blockingCount: r.blocking_count, invoiced: r.invoiced, canSendPayLink: r.can_send_pay_link, totalCents: r.total_cents } : null,
    contextError: ctx.error,
    forms: forms.data, formsError: forms.error, notes: notes.data ?? [], equipment: equipment.data ?? [], willCalls: willCalls.data,
  };
});
