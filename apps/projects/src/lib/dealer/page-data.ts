import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Picker lists the 1125 pages pass to their screens, read on the caller's RLS client (what the
 * person cannot see is simply not offered). Capped lists; the screens search within them.
 */
export interface Opt { id: string; label: string; sub?: string | null }

type Q = PromiseLike<{ data: unknown; error: unknown }>;
async function list<T>(q: Q): Promise<T[]> {
  const r = await q;
  return r.error ? [] : ((r.data ?? []) as T[]);
}

export async function vendorOpts(db: SupabaseClient): Promise<Opt[]> {
  const r = await list<{ id: string; name: string }>(db.schema('core').from('vendors').select('id, name').order('name').limit(1000));
  return r.map((v) => ({ id: v.id, label: v.name }));
}

export async function customerOpts(db: SupabaseClient): Promise<Opt[]> {
  const r = await list<{ id: string; name: string; display_name: string | null; phone: string | null; city: string | null }>(
    db.schema('core').from('customers').select('id, name, display_name, phone, city').is('deleted_at', null).order('name').limit(2000));
  return r.map((c) => ({ id: c.id, label: c.display_name || c.name, sub: [c.phone, c.city].filter(Boolean).join(' · ') || null }));
}

export async function unitOpts(db: SupabaseClient, companyId: string): Promise<Opt[]> {
  const r = await list<{ id: string; stock_number: string | null; serial_number: string | null; make: string | null; model: string | null; unit_status: string | null }>(
    db.schema('pm').from('assets').select('id, stock_number, serial_number, make, model, unit_status').eq('location_id', companyId).eq('status', 'ACTIVE').order('updated_at', { ascending: false }).limit(1500));
  return r.map((a) => ({ id: a.id, label: [a.stock_number, a.make, a.model, a.serial_number].filter(Boolean).join(' '), sub: a.unit_status ? a.unit_status.toLowerCase().replace('_', ' ') : 'customer unit' }));
}

export async function stockLocationOpts(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<Array<{ id: string; code: string; name: string; location_id: string }>> {
  if (!companyIds.length) return [];
  return list(db.schema('pm').from('stock_locations').select('id, code, name, location_id').in('location_id', [...companyIds]).eq('is_active', true).order('code'));
}

export async function managerOpts(db: SupabaseClient, companyId: string): Promise<Opt[]> {
  const r = await list<{ location_id: string; membership_id: string; display_name: string | null; email: string | null; role_key: string | null }>(
    db.schema('pm').from('v_company_team').select('location_id, membership_id, display_name, email, role_key').eq('location_id', companyId).in('role_key', ['projects_owner', 'projects_gm']).limit(200));
  const seen = new Set<string>();
  return r.filter((x) => !seen.has(x.membership_id) && seen.add(x.membership_id)).map((x) => ({ id: x.membership_id, label: x.display_name || x.email || 'Manager' }));
}

export async function contractOpts(db: SupabaseClient, companyId: string, statuses: ReadonlyArray<string>): Promise<Array<{ id: string; number: string; status: string; unit: string; customer: string | null }>> {
  const r = await list<{ id: string; number: string; status: string; asset_id: string; customer_id: string }>(
    db.schema('pm').from('rental_contracts').select('id, number, status, asset_id, customer_id').eq('location_id', companyId).in('status', [...statuses]).order('created_at', { ascending: false }).limit(300));
  const units = new Map((await list<{ id: string; stock_number: string | null; model: string | null }>(db.schema('pm').from('assets').select('id, stock_number, model').in('id', r.length ? r.map((x) => x.asset_id) : ['00000000-0000-0000-0000-000000000000']))).map((a) => [a.id, [a.stock_number, a.model].filter(Boolean).join(' ')]));
  const custs = new Map((await list<{ id: string; name: string }>(db.schema('core').from('customers').select('id, name').in('id', r.length ? r.map((x) => x.customer_id) : ['00000000-0000-0000-0000-000000000000']))).map((c) => [c.id, c.name]));
  return r.map((x) => ({ id: x.id, number: x.number, status: x.status, unit: units.get(x.asset_id) ?? 'Unit', customer: custs.get(x.customer_id) ?? null }));
}
