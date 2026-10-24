export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { SiteBody, sitePatch } from '@/lib/crm/schemas';
import { customerForWrite } from '@/lib/crm/customer-guard';
import { T } from '@/lib/crm/contract';

/** Edit a customer's site (core.sites through RLS: projects.customers:edit). */
export const PATCH = route({ access: { cap: 'projects.customers', action: 'edit' }, mask: false, body: SiteBody }, async ({ db, params, body, tenant }) => {
  const customer = await customerForWrite(db, tenant, params.customerId!);
  const res = await db.schema(T.sites.schema).from(T.sites.table).update(sitePatch(body)).eq('id', params.siteId!).eq('customer_id', customer.id).select('id');
  if (res.error) throw new PmQueryError('update site', res.error);
  if (!res.data?.length) throw new HttpError(404, 'That site was not found on this customer.', 'NOT_FOUND');
  return { ok: true };
});
