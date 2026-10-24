export const dynamic = 'force-dynamic';

import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';
import { getVendor, searchVendors } from '@/lib/pm/money/queries';
import { NewVendorBody, sameName, vendorRpcArgs } from '@/lib/pm/parties/schemas';
import { MatchDecisionBody } from '@/lib/parties/match';
import { matchConflict, noteOverride, resolveAtDoor } from '@/lib/parties/server';

const Body = NewVendorBody.extend({ match: MatchDecisionBody });

/**
 * Add a subcontractor or supplier to the shared vendor master (core.vendors) through
 * pm.create_vendor (1108). Members cannot write core.vendors (168), so the definer function
 * creates a provisional vendor with w9_status MISSING: Merit Books' compliance chase then
 * requests the W-9 and COI. An exact name match returns the existing vendor.
 * Matching at the door first (SHARED-RECORDS §3): `match.useId` takes an existing vendor; an
 * exact identifier match with no typed `match.newReason` answers 409 MATCH_FOUND.
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'create' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  if (body.companyId) assertCompany(tenant, body.companyId);
  const door = await resolveAtDoor(db, 'vendor', { name: body.name, email: body.email, phone: body.phone }, body.match);
  if (door.kind === 'conflict') return matchConflict('vendor', door.candidates);
  if (door.kind === 'use') return vendorOut(await getVendor(db, door.id), door.id, body, true);
  const before = (await searchVendors(db, body.name, 20)).filter((v) => sameName(v.name, body.name));
  const id = must(await db.schema('pm').rpc('create_vendor', vendorRpcArgs(body)), 'add vendor') as string | null;
  if (!id) throw new HttpError(500, 'The vendor was not added. Try again.', 'CREATE_FAILED');
  if (door.overrideOf && door.reason && !before.some((x) => x.id === id)) await noteOverride(db, 'vendor', id, door.overrideOf, door.reason);
  return vendorOut(await getVendor(db, id), id, body, before.some((x) => x.id === id));
});

function vendorOut(v: Awaited<ReturnType<typeof getVendor>>, id: string, body: { name: string; email: string | null }, existing: boolean) {
  return {
    vendor: {
      id,
      name: v ? v.display_name || v.name : body.name,
      email: v?.email ?? body.email,
      city: v?.city ?? null,
      retainagePct: v?.default_retainage_pct != null ? Math.min(Math.max(Number(v.default_retainage_pct), 0), 100) / 100 : 0,
    },
    existing,
  };
}
