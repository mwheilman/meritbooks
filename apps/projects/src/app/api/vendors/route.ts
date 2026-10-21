export const dynamic = 'force-dynamic';

import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';
import { getVendor, searchVendors } from '@/lib/pm/money/queries';
import { NewVendorBody, sameName, vendorRpcArgs } from '@/lib/pm/parties/schemas';

/**
 * Add a subcontractor or supplier to the shared vendor master (core.vendors) through
 * pm.create_vendor (1108). Members cannot write core.vendors (168), so the definer function
 * creates a provisional vendor with w9_status MISSING: Merit Books' compliance chase then
 * requests the W-9 and COI. An exact name match returns the existing vendor.
 */
export const POST = route({ body: NewVendorBody }, async ({ db, body, tenant }) => {
  if (body.companyId) assertCompany(tenant, body.companyId);
  const before = (await searchVendors(db, body.name, 20)).filter((v) => sameName(v.name, body.name));
  const id = must(await db.schema('pm').rpc('create_vendor', vendorRpcArgs(body)), 'add vendor') as string | null;
  if (!id) throw new HttpError(500, 'The vendor was not added. Try again.', 'CREATE_FAILED');
  const v = await getVendor(db, id);
  return {
    vendor: {
      id,
      name: v ? v.display_name || v.name : body.name,
      email: v?.email ?? body.email,
      city: v?.city ?? null,
      retainagePct: v?.default_retainage_pct != null ? Math.min(Math.max(Number(v.default_retainage_pct), 0), 100) / 100 : 0,
    },
    existing: before.some((x) => x.id === id),
  };
});
