export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, must, route } from '@/lib/api';
import { searchCustomers } from '@/lib/pm/people';
import { NewCustomerBody, sameName } from '@/lib/pm/parties/schemas';
import { insertCustomer } from '@/lib/pm/parties/create';
import { MatchDecisionBody } from '@/lib/parties/match';
import { matchConflict, noteOverride, resolveAtDoor } from '@/lib/parties/server';

/** Customer picker (core.customers via RLS). */
export const GET = route(
  { access: { cap: 'projects.customers', action: 'view' }, mask: false, query: z.object({ q: z.string().max(80).default(''), companyId: z.string().uuid().optional() }) },
  async ({ db, query }) => ({ customers: (await searchCustomers(db, query.q, query.companyId ?? null, 8)).map((c) => ({ id: c.id, name: c.display_name || c.name })) }),
);

const Body = NewCustomerBody.extend({ match: MatchDecisionBody });

/**
 * Add a customer to the shared master (core.customers) — matching at the door first
 * (SHARED-RECORDS §3): `match.useId` takes the existing customer; an exact identifier match with
 * no typed `match.newReason` answers 409 MATCH_FOUND with the candidates; otherwise
 * pm.create_customer (1108; an exact name already on file still links instead of duplicating).
 */
export const POST = route({ access: { cap: 'projects.customers', action: 'create' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  if (body.companyId) assertCompany(tenant, body.companyId);
  const door = await resolveAtDoor(db, 'customer', { name: body.name, email: body.email, phone: body.phone }, body.match);
  if (door.kind === 'conflict') return matchConflict('customer', door.candidates);
  if (door.kind === 'use') {
    const row = must(await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').eq('id', door.id).maybeSingle(), 'customer') as
      | { id: string; name: string; display_name: string | null } | null;
    return { customer: { id: door.id, name: row ? row.display_name || row.name : body.name }, existing: true };
  }
  const before = (await searchCustomers(db, body.name, null, 20)).filter((c) => sameName(c.name, body.name));
  const id = await insertCustomer(db, body);
  if (door.overrideOf && door.reason && !before.some((c) => c.id === id)) await noteOverride(db, 'customer', id, door.overrideOf, door.reason);
  const row = must(await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').eq('id', id).maybeSingle(), 'customer') as
    | { id: string; name: string; display_name: string | null } | null;
  return { customer: { id, name: row ? row.display_name || row.name : body.name }, existing: before.some((c) => c.id === id) };
});
