export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { DirectoryEntryCreate } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/directory/entries — add a company or contact to the project directory (CGC-04). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: DirectoryEntryCreate }, async ({ db, body }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_project_directory').insert({
    job_id: body.jobId, party_role: body.partyRole, vendor_id: body.vendorId, customer_id: body.customerId, company_name: body.companyName,
    contact_name: body.contactName, email: body.email, phone: body.phone, trade: body.trade, csi_divisions: body.csiDivisions,
    distribution_groups: body.distributionGroups, is_primary: body.isPrimary,
  }).select('id').single());
});
