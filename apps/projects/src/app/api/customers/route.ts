export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';
import { searchCustomers } from '@/lib/pm/people';
import { NewCustomerBody, customerRpcArgs, sameName } from '@/lib/pm/parties/schemas';

/** Customer picker (core.customers via RLS). */
export const GET = route(
  { access: { cap: 'projects.customers', action: 'view' }, mask: false, query: z.object({ q: z.string().max(80).default(''), companyId: z.string().uuid().optional() }) },
  async ({ db, query }) => ({ customers: (await searchCustomers(db, query.q, query.companyId ?? null, 8)).map((c) => ({ id: c.id, name: c.display_name || c.name })) }),
);

/**
 * Add a customer to the shared master (core.customers) now, through pm.create_customer (1108):
 * identity and contact only; an exact name match in the workspace returns the existing customer.
 */
export const POST = route({ access: { cap: 'projects.customers', action: 'create' }, mask: false, body: NewCustomerBody }, async ({ db, body, tenant }) => {
  if (body.companyId) assertCompany(tenant, body.companyId);
  const before = (await searchCustomers(db, body.name, null, 20)).filter((c) => sameName(c.name, body.name));
  const id = must(await db.schema('pm').rpc('create_customer', customerRpcArgs(body)), 'add customer') as string | null;
  if (!id) throw new HttpError(500, 'The customer was not added. Try again.', 'CREATE_FAILED');
  const row = must(await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').eq('id', id).maybeSingle(), 'customer') as
    | { id: string; name: string; display_name: string | null } | null;
  return { customer: { id, name: row ? row.display_name || row.name : body.name }, existing: before.some((c) => c.id === id) };
});
