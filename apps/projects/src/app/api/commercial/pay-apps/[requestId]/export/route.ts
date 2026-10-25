export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { exportPayApp, type SheetLine } from '@/lib/commercial/screen-logic';
import { PayAppExportQuery } from '@/lib/commercial/screen-schemas';
import { cmError } from '@/lib/commercial/server';

/**
 * GET /api/commercial/pay-apps/:id/export?format= — the application laid out for an owner / GC
 * portal import (Textura, GCPay, Procore Pay) or a G703-style / generic GC form (CGC-43), as CSV.
 * A file response is not walked by the JSON masker, so the contract-value check is made here.
 */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: false, query: PayAppExportQuery }, async ({ db, access, query, params }) => {
  const id = params.requestId!;
  const pm = db.schema('pm');
  const r = await pm.from('billing_requests').select('id, job_id, location_id, application_no, period_end, billing_subtype').eq('id', id).maybeSingle();
  if (r.error) throw cmError(r.error);
  const row = r.data as { id: string; job_id: string; location_id: string; application_no: number | null; period_end: string | null; billing_subtype: string | null } | null;
  if (!row || row.billing_subtype !== 'SOV') throw new HttpError(404, 'That pay application was not found.', 'NOT_FOUND');
  if (!can(access, 'projects.contract_value', 'view', row.location_id)) throw new HttpError(403, 'Exporting a pay application needs permission to see contract amounts.', 'FORBIDDEN');
  const [lines, job, st] = await Promise.all([
    pm.from('billing_request_lines').select('id, line_no, sort, line_type, description, sov_line_id, scheduled_value_cents, previous_work_cents, this_period_work_cents, stored_materials_cents, previous_stored_cents, total_completed_cents, pct_complete, balance_to_finish_cents, retainage_rate, retainage_work_to_date_cents, retainage_stored_to_date_cents, retainage_this_period_cents').eq('billing_request_id', id).order('sort').order('line_no'),
    pm.from('v_core_jobs_masked').select('job_number, name').eq('id', row.job_id).maybeSingle(),
    pm.from('cm_pay_app_status').select('revision').eq('billing_request_id', id).maybeSingle(),
  ]);
  if (lines.error) throw cmError(lines.error);
  const j = job.data as { job_number: string | null; name: string | null } | null;
  const out = exportPayApp(query.format, (lines.data ?? []) as SheetLine[], {
    applicationNo: row.application_no, periodEnd: row.period_end, jobLabel: [j?.job_number, j?.name].filter(Boolean).join(' ') || 'Job',
    revision: (st.data as { revision: number } | null)?.revision ?? 1,
  });
  return new NextResponse(out.body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.fileName}"`, 'cache-control': 'no-store' } });
});
