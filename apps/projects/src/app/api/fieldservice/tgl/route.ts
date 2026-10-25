import { z } from 'zod';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { Need, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({ workOrderId: Uuid, reason: Need(500, 'Say why this is a replacement lead'), interest: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'), assetId: Uuid.nullish() });

/** Tech-generated lead (FS-38): lead-set credit goes to the tech for the TGL bonus when it sells. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  const id = await fsCall<string>(db, 'fs_set_tgl', { p_wo: body.workOrderId, p_reason: body.reason, p_interest: body.interest, p_asset: body.assetId ?? null, p_employee: null });
  return { leadId: id };
});
