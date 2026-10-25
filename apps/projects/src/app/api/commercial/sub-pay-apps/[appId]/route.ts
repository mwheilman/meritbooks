export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { SubPayAppAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/sub-pay-apps/:id — the application, its lines (G703 for the sub), the approval trail and the field's progress opinion. */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: ['commitment', 'sub_pay_app', 'billing'] }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const id = params.appId!;
  const [app, lines, actions, check] = await Promise.all([
    pm.from('cm_sub_pay_apps').select('*').eq('id', id).maybeSingle(),
    pm.from('cm_sub_pay_app_lines').select('id, commitment_line_id, line_no, description, scheduled_value_cents, previous_work_cents, this_period_work_cents, previous_stored_cents, stored_materials_cents, total_completed_cents, pct_complete, balance_to_finish_cents, retainage_rate, retainage_this_period_cents').eq('sub_pay_app_id', id).order('line_no'),
    pm.from('cm_sub_pay_app_actions').select('step, action, actor, note, created_at').eq('sub_pay_app_id', id).order('created_at'),
    pm.from('cm_v_sub_pay_app_check').select('*').eq('sub_pay_app_id', id).maybeSingle(),
  ]);
  if (app.error) throw cmError(app.error);
  if (!app.data) throw new HttpError(404, 'That pay application was not found.', 'NOT_FOUND');
  return { app: app.data, lines: lines.data ?? [], actions: actions.data ?? [], check: check.data ?? null };
});

/**
 * POST /api/commercial/sub-pay-apps/:id — submit (requests the conditional waiver), approve /
 * reject / send back at the current step (PM → project accountant → executive above the
 * threshold; the step's capability and separation of duties are checked in the database),
 * revise lines, void. Approval queues the payable for Merit Books.
 */
export const POST = route({
  access: { cap: 'projects.commitments', action: 'view' },
  ops: { submit: { cap: 'projects.commitments', action: 'edit' }, lines: { cap: 'projects.commitments', action: 'edit' }, void: { cap: 'projects.commitments', action: 'edit' } },
  mask: ['commitment', 'sub_pay_app'],
  body: SubPayAppAction,
}, async ({ db, body, params }) => {
  const id = params.appId!;
  switch (body.op) {
    case 'submit':
      return { id: await cmRpc<string>(db, 'cm_submit_sub_pay_app', { p_app: id }, 'commitment') };
    case 'approve':
      return cmRpc<Record<string, unknown>>(db, 'cm_act_sub_pay_app', { p_app: id, p_decision: 'APPROVE', p_note: body.note }, 'commitment');
    case 'reject':
      return cmRpc<Record<string, unknown>>(db, 'cm_act_sub_pay_app', { p_app: id, p_decision: 'REJECT', p_note: body.note }, 'commitment');
    case 'send_back':
      return cmRpc<Record<string, unknown>>(db, 'cm_act_sub_pay_app', { p_app: id, p_decision: 'REVISE', p_note: body.note }, 'commitment');
    case 'lines':
      return { id: await cmRpc<string>(db, 'cm_revise_sub_pay_app', { p_app: id, p_lines: body.lines }, 'commitment') };
    case 'void':
      return { id: await cmRpc<string>(db, 'cm_void_sub_pay_app', { p_app: id, p_reason: body.reason }, 'commitment') };
  }
});
