export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { EacAction } from '@/lib/commercial/schemas';
import { cmRpc, loadForecast } from '@/lib/commercial/server';

/** GET /api/commercial/eac/:id — the forecast and its cost-code lines. */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'budget', 'wip'] }, async ({ db, params }) => {
  const f = await loadForecast(db, params.forecastId!);
  if (!f.forecast) throw new HttpError(404, 'That forecast was not found.', 'NOT_FOUND');
  return f;
});

/**
 * POST /api/commercial/eac/:id — set a line's cost to complete, submit with the reason and
 * commentary (required when it moves), or approve / send back. Approval is the executive's and
 * never the preparer's; it emits JOB_PROGRESS to Merit Books.
 */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: ['job', 'budget', 'wip'], body: EacAction }, async ({ db, body, params }) => {
  const id = params.forecastId!;
  switch (body.op) {
    case 'line':
      return { id: await cmRpc<string>(db, 'cm_set_eac_line', { p_line: body.lineId, p_ctc_cents: body.ctcCents, p_commentary: body.commentary }) };
    case 'submit':
      return { id: await cmRpc<string>(db, 'cm_submit_eac', { p_forecast: id, p_reason_code: body.reasonCode, p_commentary: body.commentary, p_uninstalled_cents: body.uninstalledCents, p_inefficiency_cents: body.inefficiencyCents }) };
    case 'decide':
      return cmRpc<Record<string, unknown>>(db, 'cm_decide_eac', { p_forecast: id, p_approve: body.approve, p_note: body.note });
  }
});
