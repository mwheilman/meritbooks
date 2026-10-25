export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { PayAppAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/pay-apps/:id — pencil / certification stage, revisions and the pre-submit check (over/under after this bill). */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing', 'job'] }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const [st, preview] = await Promise.all([
    pm.from('cm_pay_app_status').select('*').eq('billing_request_id', params.requestId!).maybeSingle(),
    cmRpc<Record<string, unknown>>(db, 'cm_pay_app_preview', { p_request: params.requestId! }, 'billing request'),
  ]);
  if (st.error) throw cmError(st.error);
  return { status: st.data ?? null, preview };
});

/** POST /api/commercial/pay-apps/:id — pencil to the owner, owner returns it, revise (same number), architect certifies, portal status. */
export const POST = route({ access: { cap: 'projects.billing', action: 'edit' }, mask: ['billing'], body: PayAppAction }, async ({ db, body, params }) => {
  const id = params.requestId!;
  switch (body.op) {
    case 'pencil':
      return { id: await cmRpc<string>(db, 'cm_send_pencil', { p_request: id, p_to: body.to }, 'billing request') };
    case 'return':
      return { id: await cmRpc<string>(db, 'cm_return_pencil', { p_request: id, p_note: body.note }, 'billing request') };
    case 'certify':
      return { id: await cmRpc<string>(db, 'cm_certify_pay_app', { p_request: id, p_architect: body.architect, p_certified_cents: body.certifiedCents, p_notarized: body.notarized }, 'billing request') };
    case 'revise':
      return { id: await cmRpc<string>(db, 'cm_revise_pay_app', { p_request: id, p_lines: body.lines ?? null, p_reason: body.reason }, 'billing request') };
    case 'portal':
      return { id: await cmRpc<string>(db, 'cm_pay_app_portal', { p_request: id, p_portal: body.portal, p_status: body.status }, 'billing request') };
  }
});
