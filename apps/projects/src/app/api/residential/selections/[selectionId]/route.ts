export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import type { ChooseResult, SelectionPreview } from '@/lib/residential/types';
import { MethodZ, Text, Uuid } from '@/lib/residential/schemas';

/** Every option with what it does to the allowance — shown BEFORE the homeowner picks (RES-33). */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: 'selection' }, async ({ db, params }) =>
  resRpc<SelectionPreview>(db, 'res_selection_preview', { p_selection: params.selectionId! }));

const Choose = z.object({
  optionId: Uuid,
  approverName: Text(200).min(1, 'Who chose it?'),
  method: MethodZ.default('IN_PERSON'),
  approverEmail: z.string().email().max(254).nullish(),
  overageBilling: z.enum(['UPFRONT', 'NEXT_MILESTONE']).nullish(),
  createPo: z.boolean().default(true),
});

/**
 * The one flow: client approval → (over allowance) the allowance change order the homeowner just
 * signed, approved through Approvals → deposit request or the next milestone → draft PO to the
 * option's vendor + procurement item → vendor deposit when the special order needs one.
 */
export const POST = route({ access: { cap: 'projects.selections', action: 'approve' }, mask: ['selection', 'change_order', 'billing'], body: Choose }, async ({ db, params, body }) =>
  resRpc<ChooseResult>(db, 'res_choose_selection', {
    p_selection: params.selectionId!, p_option: body.optionId, p_approver_name: body.approverName, p_method: body.method,
    p_approver_email: body.approverEmail ?? null, p_signature_document: null, p_overage_billing: body.overageBilling ?? null, p_create_po: body.createPo,
  }));
