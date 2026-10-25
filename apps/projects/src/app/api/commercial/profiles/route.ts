export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { ProfileUpsert } from '@/lib/commercial/screen-schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/**
 * POST /api/commercial/profiles — trade data on the shared vendor / customer master (CGC-04):
 * CSI divisions, trades, licenses, union local, DBE/MBE/WBE/SDVOB, EMR, bonding, prequalification.
 * One profile per party (the master record itself is never copied).
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: false, body: ProfileUpsert }, async ({ db, body }) => {
  const pm = db.schema('pm');
  const row = {
    location_id: body.companyId, vendor_id: body.vendorId, customer_id: body.customerId, csi_divisions: body.csiDivisions, trades: body.trades, licenses: body.licenses,
    union_local: body.unionLocal, dbe: body.dbe, mbe: body.mbe, wbe: body.wbe, sdvob: body.sdvob, emr: body.emr, emr_year: body.emrYear,
    bonding_single_cents: body.bondingSingleCents, bonding_aggregate_cents: body.bondingAggregateCents, prequal_status: body.prequalStatus,
    prequal_expires: body.prequalExpires, notes: body.notes,
  };
  let q = pm.from('cm_company_profiles').select('id');
  q = body.vendorId ? q.eq('vendor_id', body.vendorId).is('customer_id', null) : q.eq('customer_id', body.customerId!).is('vendor_id', null);
  const found = await q.maybeSingle();
  if (found.error) throw cmError(found.error);
  const id = (found.data as { id: string } | null)?.id;
  if (id) return cmWrote<{ id: string }>(await pm.from('cm_company_profiles').update(row).eq('id', id).select('id').single());
  return cmWrote<{ id: string }>(await pm.from('cm_company_profiles').insert(row).select('id').single());
});
