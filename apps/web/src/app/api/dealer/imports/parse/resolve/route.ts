export const dynamic = 'force-dynamic';

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { normKey } from '@/lib/dealer/imports/values';
import type { ResolveResponse } from '@/lib/dealer/imports/protocol';

/**
 * POST /api/dealer/imports/parse/resolve — match an import's serials / customer names /
 * make names to records already in Books, so a deal import can find its unit and
 * customer. READ-ONLY through the caller's RLS client (tenant + client scope).
 * Body: { locationId, serials[], customers[], vendors[] } → { data: Resolution }
 * Keys of every map are `normKey(text)` (upper-case, letters and digits only).
 * Ambiguous names (two customers that normalize the same) are left unresolved.
 */
const body = z.object({
  locationId: z.string().uuid(),
  serials: z.array(z.string().max(100)).max(5000),
  customers: z.array(z.string().max(200)).max(5000),
  vendors: z.array(z.string().max(200)).max(500),
});

const PAGE = 1000;
const MAX_PAGES = 30;

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await fetchPage(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw new Error(`Lookup failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

/** name → id, dropping names that more than one record shares. */
function uniqueMap(rows: Array<{ id: string; names: Array<string | null> }>, wanted: Set<string>): Record<string, string> {
  const hits = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const n of r.names) {
      const k = normKey(n);
      if (!k || !wanted.has(k)) continue;
      if (!hits.has(k)) hits.set(k, new Set());
      hits.get(k)!.add(r.id);
    }
  }
  const out: Record<string, string> = {};
  for (const [k, ids] of hits) if (ids.size === 1) out[k] = [...ids][0];
  return out;
}

async function resolve(db: SupabaseClient, orgId: string, locationId: string, b: z.infer<typeof body>): Promise<ResolveResponse> {
  const serials = new Set(b.serials.map(normKey).filter(Boolean));
  const customers = new Set(b.customers.map(normKey).filter(Boolean));
  const vendors = new Set(b.vendors.map(normKey).filter(Boolean));

  const [units, custs, vends] = await Promise.all([
    serials.size
      ? pageAll<{ id: string; serial_number: string; vin_hin: string | null }>((f, t) =>
          db.from('dealer_units').select('id, serial_number, vin_hin').eq('org_id', orgId).eq('location_id', locationId).neq('status', 'VOID').order('id').range(f, t))
      : Promise.resolve([]),
    customers.size
      ? pageAll<{ id: string; name: string; display_name: string | null }>((f, t) =>
          db.schema('core').from('customers').select('id, name, display_name').eq('org_id', orgId).is('deleted_at', null).order('id').range(f, t))
      : Promise.resolve([]),
    vendors.size
      ? pageAll<{ id: string; name: string; display_name: string | null }>((f, t) =>
          db.schema('core').from('vendors').select('id, name, display_name').eq('org_id', orgId).is('deleted_at', null).order('id').range(f, t))
      : Promise.resolve([]),
  ]);

  return {
    unitsBySerial: uniqueMap(units.map((u) => ({ id: u.id, names: [u.serial_number, u.vin_hin] })), serials),
    customersByName: uniqueMap(custs.map((c) => ({ id: c.id, names: [c.name, c.display_name] })), customers),
    vendorsByName: uniqueMap(vends.map((v) => ({ id: v.id, names: [v.name, v.display_name] })), vendors),
  };
}

export const POST = apiHandler(
  body,
  dealerAction<z.infer<typeof body>>(DEALER_PERMS.view, async (b, d) => resolve(d.db, d.orgId, d.locationId, b)),
);
