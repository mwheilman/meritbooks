export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { IncidentUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = {
  rootCause: 'root_cause', correctiveActions: 'corrective_actions', witnesses: 'witnesses', oshaRecordable: 'osha_recordable', oshaClassification: 'osha_classification',
  injuryOrIllness: 'injury_or_illness', daysAway: 'days_away', daysRestricted: 'days_restricted', privacyCase: 'privacy_case', wcClaimRef: 'wc_claim_ref', status: 'status',
} as const;

/** PATCH /api/commercial/safety/incidents/:id — investigation (witnesses, root cause, corrective actions) and the recordable determination (OSHA 301 fields). */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: IncidentUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (patch.osha_recordable === false) patch.osha_classification = null;
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_incidents').update(patch).eq('id', params.incidentId!).select('id').single());
});
