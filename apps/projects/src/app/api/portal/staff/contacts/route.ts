export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { PmQueryError } from '@/lib/api-errors';

/** GET ?customerId|vendorId — the contacts a portal invitation can go to (core.contacts through RLS). */
const Query = z.object({ customerId: z.string().uuid().optional(), vendorId: z.string().uuid().optional() })
  .refine((q) => !!q.customerId !== !!q.vendorId, { message: 'customerId or vendorId' });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => {
  let q = db.schema('core').from('contacts').select('id, first_name, last_name, email, phone, can_sign, can_pay, is_primary')
    .eq('identity_status', 'active').order('is_primary', { ascending: false }).limit(100);
  q = query.customerId ? q.eq('customer_id', query.customerId) : q.eq('vendor_id', query.vendorId!);
  const r = await q;
  if (r.error) throw new PmQueryError('contacts', r.error);
  return { contacts: r.data ?? [] };
});
