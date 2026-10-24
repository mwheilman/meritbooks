export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { NewContactBody } from '@/lib/crm/schemas';
import { customerForWrite } from '@/lib/crm/customer-guard';
import { contactsByIds } from '@/lib/crm/queries';
import { createContact } from '@/lib/parties/create';
import { matchConflict, noteOverride, resolveAtDoor } from '@/lib/parties/server';

/**
 * Add a contact to a customer (core.create_contact) — matched at the door first: an exact email
 * or phone already on file answers 409 MATCH_FOUND unless the form chose it or typed a reason.
 */
export const POST = route({ access: { cap: 'projects.customers', action: 'create' }, mask: false, body: NewContactBody }, async ({ db, params, body, tenant }) => {
  const customer = await customerForWrite(db, tenant, params.customerId!);
  const c = body.contact;
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
  const door = await resolveAtDoor(db, 'contact', { name, email: c.email, phone: c.phone }, body.match);
  if (door.kind === 'conflict') return matchConflict('contact', door.candidates, 'contact');
  if (door.kind === 'use') {
    const existing = (await contactsByIds(db, [door.id])).get(door.id);
    return { contact: { id: door.id }, existing: true, elsewhere: !!existing && existing.customer_id !== customer.id };
  }
  const id = await createContact(db, {
    customerId: customer.id, vendorId: null, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, title: c.title,
    roles: c.roles, isPrimary: c.isPrimary, canSign: c.canSign, canPay: c.canPay, smsConsent: c.smsConsent, emailConsent: c.emailConsent,
  });
  if (door.overrideOf && door.reason && id !== door.overrideOf.id) await noteOverride(db, 'contact', id, door.overrideOf, door.reason);
  return { contact: { id }, existing: id === door.overrideOf?.id, elsewhere: false };
});
