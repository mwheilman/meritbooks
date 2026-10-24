export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { ContactBody, contactPatch } from '@/lib/crm/schemas';
import { customerForWrite } from '@/lib/crm/customer-guard';
import { T } from '@/lib/crm/contract';

/** Edit a customer's contact (core.contacts through RLS: projects.customers:edit). */
export const PATCH = route({ access: { cap: 'projects.customers', action: 'edit' }, mask: false, body: ContactBody }, async ({ db, params, body, tenant }) => {
  const customer = await customerForWrite(db, tenant, params.customerId!);
  // consent_at is stamped by the core.contacts trigger when a consent flag turns on (1111)
  const patch = contactPatch(body);
  const res = await db.schema(T.contacts.schema).from(T.contacts.table).update(patch).eq('id', params.contactId!).eq('customer_id', customer.id).select('id');
  if (res.error) throw new PmQueryError('update contact', res.error);
  if (!res.data?.length) throw new HttpError(404, 'That contact was not found on this customer.', 'NOT_FOUND');
  return { ok: true };
});
