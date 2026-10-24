export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { SiteBody } from '@/lib/crm/schemas';
import { customerForWrite } from '@/lib/crm/customer-guard';
import { createSite } from '@/lib/parties/create';

/** Add a site to a customer (core.create_site: matches first and returns an existing site at the same address). */
export const POST = route({ access: { cap: 'projects.customers', action: 'create' }, mask: false, body: SiteBody }, async ({ db, params, body, tenant }) => {
  const customer = await customerForWrite(db, tenant, params.customerId!);
  const companyId = body.companyId ?? customer.locationId ?? tenant.activeCompanyId ?? null;
  if (companyId) assertCompany(tenant, companyId);
  const id = await createSite(db, {
    customerId: customer.id, companyId, name: body.name, line1: body.line1, line2: body.line2, city: body.city, state: body.state, zip: body.zip,
    accessNotes: body.accessNotes, taxJurisdiction: body.taxJurisdiction,
  });
  return { site: { id } };
});
