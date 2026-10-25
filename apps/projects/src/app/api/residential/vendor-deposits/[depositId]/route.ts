export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Day, Text } from '@/lib/residential/schemas';

const Body = z.object({ to: z.enum(['APPROVED', 'PAID', 'RELIEVED', 'VOID']), on: Day.nullish(), ref: Text(120).nullish() });

/** Special-order deposit lifecycle: requested → approved → paid → relieved at delivery (RES-58). */
export const POST = route({
  access: { cap: 'projects.commitments', action: 'edit' }, mask: 'commitment', body: Body,
}, async ({ db, params, body }) => ({ depositId: await resRpc<string>(db, 'res_advance_vendor_deposit', { p_deposit: params.depositId!, p_to: body.to, p_on: body.on ?? null, p_ref: body.ref ?? null }) }));
