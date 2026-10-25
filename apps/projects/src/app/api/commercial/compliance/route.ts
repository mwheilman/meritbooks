export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { ComplianceAction } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, loadComplianceQueue } from '@/lib/commercial/server';

/** GET /api/commercial/compliance?jobId= — subcontracts with what blocks payment (COI, waivers, manual hold). */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: ['commitment'], query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  return { queue: await loadComplianceQueue(db, [query.jobId]) };
});

/**
 * POST /api/commercial/compliance — record a COI (verified against the requirements on the spot;
 * deficient or expired holds payment, CGC-47), re-verify one, run the renewal chase, or add a requirement.
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: ['commitment'], body: ComplianceAction }, async ({ db, body }) => {
  switch (body.op) {
    case 'record_coi': {
      const doc = {
        carrier: body.carrier, producer: body.producer, certificate_date: body.certificateDate, policies: body.policies, endorsements: body.endorsements,
        additional_insured: body.additionalInsured, waiver_of_subrogation: body.waiverOfSubrogation, primary_noncontributory: body.primaryNoncontributory,
        emr: body.emr, license_no: body.licenseNo, license_expires: body.licenseExpires, document_id: body.documentId,
      };
      return { id: await cmRpc<string>(db, 'cm_record_coi', { p_vendor: body.vendorId, p_location: body.companyId, p_job: body.jobId, p_commitment: body.commitmentId, p_doc: doc }, 'commitment') };
    }
    case 'verify_coi':
      return cmRpc<Record<string, unknown>>(db, 'cm_verify_coi', { p_coi: body.coiId }, 'commitment');
    case 'chase':
      return { chased: await cmRpc<number>(db, 'cm_compliance_chase_run', { p_location: body.companyId }, 'commitment') };
    case 'requirement':
      return cmWrote<{ id: string }>(await db.schema('pm').from('cm_compliance_requirements').insert({
        job_id: body.jobId, location_id: body.jobId ? null : body.companyId, requirement: body.requirement, min_limit_cents: body.minLimitCents, max_value: body.maxValue,
        endorsement_forms: body.endorsementForms,
      }).select('id').single());
  }
});
