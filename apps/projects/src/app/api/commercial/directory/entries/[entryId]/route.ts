export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { DirectoryEntryUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = { partyRole: 'party_role', contactName: 'contact_name', email: 'email', phone: 'phone', trade: 'trade', csiDivisions: 'csi_divisions', distributionGroups: 'distribution_groups', isPrimary: 'is_primary' } as const;

/** PATCH /api/commercial/directory/entries/:id — the contact, role, divisions and distribution groups. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: DirectoryEntryUpdate }, async ({ db, body, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_project_directory').update(toColumns(body, COLS)).eq('id', params.entryId!).select('id').single());
});

/** DELETE /api/commercial/directory/entries/:id — take the entry off this job's directory (the shared master is untouched). */
export const DELETE = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false }, async ({ db, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_project_directory').delete().eq('id', params.entryId!).select('id').single());
});
