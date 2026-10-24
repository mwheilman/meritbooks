import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, type ReadyTenant } from '@/lib/api';

/** The customer a contact/site door writes to: reachable, and in a company the caller holds the grant at. */
export async function customerForWrite(db: SupabaseClient, tenant: ReadyTenant, customerId: string): Promise<{ id: string; name: string; locationId: string | null }> {
  const res = await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name, location_id, deleted_at').eq('id', customerId).maybeSingle();
  if (res.error) throw new PmQueryError('customer', res.error);
  const c = res.data as { id: string; name: string; display_name: string | null; location_id: string | null; deleted_at: string | null } | null;
  if (!c || c.deleted_at) throw new HttpError(404, 'That customer was not found.', 'NOT_FOUND');
  if (c.location_id) assertCompany(tenant, c.location_id);
  return { id: c.id, name: c.display_name || c.name, locationId: c.location_id };
}
