import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import type { CallerPop } from '@/lib/fieldservice/types';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ companyId: Uuid, phone: Text(40).optional(), customerId: Uuid.optional() });

/**
 * Caller pop (FS-02): matches by phone, then history, equipment, agreement badge, open estimates and
 * open work. Books AR comes back masked by the database (flags for everyone, amounts only with
 * contract value or billing); the response is masked again as an agreement / billing object.
 */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: ['billing', 'agreement'], query: Query }, async ({ db, query }) => {
  if (!query.phone && !query.customerId) throw new HttpError(422, 'Type a phone number or pick a customer.', 'VALIDATION');
  const pop = await fsCall<CallerPop>(db, 'fs_caller_pop', { p_location: query.companyId, p_phone: query.phone ?? null, p_customer: query.customerId ?? null });
  return { pop };
});
