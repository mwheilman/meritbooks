/**
 * Dealer Pack (D2) — name lookups + picker search for the dealer screens.
 *
 * D1 lists return ids for business objects (vendors, customers, departments,
 * accounts, units). PostgREST can't embed `core` from `public`, so the UI resolves
 * names here in one batched, RLS-scoped call (the caller's client — tenant + client
 * scope enforced by the database). Read-only; never writes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const LOOKUP_KINDS = ['vendors', 'customers', 'departments', 'accounts', 'units', 'lines', 'programs', 'oem_programs'] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export interface LookupItem {
  id: string;
  label: string;
  sub?: string | null;
  /** Kind-specific extras the picker may show (account type, unit status…). */
  meta?: Record<string, string | number | boolean | null>;
}

export interface LookupArgs {
  orgId: string;
  locationId: string;
  kind: LookupKind;
  ids?: string[];
  q?: string;
  /** accounts only: restrict to these account types (ASSET, LIABILITY, …). */
  types?: string[];
  limit?: number;
}

const SAFE = /[,()*\\%]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function term(q?: string): string | null {
  const t = (q ?? '').replace(SAFE, ' ').trim();
  return t.length ? t.slice(0, 80) : null;
}

/** Keep only well-formed ids (never forward junk into an `in.()` filter). */
export function cleanIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)))].slice(0, 200);
}

export async function lookup(db: SupabaseClient, a: LookupArgs): Promise<LookupItem[]> {
  const ids = a.ids ?? [];
  const t = term(a.q);
  const limit = Math.min(Math.max(a.limit ?? 25, 1), 200);
  switch (a.kind) {
    case 'vendors': {
      let q = db.schema('core').from('vendors').select('id, name, display_name, is_active').eq('org_id', a.orgId).is('deleted_at', null);
      if (ids.length) q = q.in('id', ids);
      else {
        q = q.eq('is_active', true);
        if (t) q = q.or(`name.ilike.%${t}%,display_name.ilike.%${t}%`);
      }
      const { data, error } = await q.order('name').limit(ids.length || limit);
      if (error) throw new Error(`Vendor lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; display_name: string | null }[]).map((v) => ({
        id: v.id,
        label: v.display_name || v.name,
        sub: v.display_name && v.display_name !== v.name ? v.name : null,
      }));
    }
    case 'customers': {
      let q = db.schema('core').from('customers').select('id, name, display_name, email').eq('org_id', a.orgId).is('deleted_at', null);
      if (ids.length) q = q.in('id', ids);
      else {
        q = q.eq('is_active', true);
        if (t) q = q.or(`name.ilike.%${t}%,display_name.ilike.%${t}%,email.ilike.%${t}%`);
      }
      const { data, error } = await q.order('name').limit(ids.length || limit);
      if (error) throw new Error(`Customer lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; display_name: string | null; email: string | null }[]).map((c) => ({
        id: c.id,
        label: c.display_name || c.name,
        sub: c.email,
      }));
    }
    case 'departments': {
      let q = db.schema('core').from('departments').select('id, name, code, location_id, is_active').eq('org_id', a.orgId);
      if (ids.length) q = q.in('id', ids);
      else {
        q = q.eq('is_active', true).or(`location_id.is.null,location_id.eq.${a.locationId}`);
        if (t) q = q.or(`name.ilike.%${t}%,code.ilike.%${t}%`);
      }
      const { data, error } = await q.order('name').limit(ids.length || 200);
      if (error) throw new Error(`Department lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; code: string | null; location_id: string | null }[]).map((d) => ({
        id: d.id,
        label: d.name,
        sub: d.code,
        meta: { shared: d.location_id === null },
      }));
    }
    case 'accounts': {
      let q = db
        .from('accounts')
        .select('id, account_number, name, account_type, company_location_id, is_active')
        .eq('org_id', a.orgId);
      if (ids.length) q = q.in('id', ids);
      else {
        q = q
          .eq('is_active', true)
          .eq('approval_status', 'APPROVED')
          .or(`company_location_id.is.null,company_location_id.eq.${a.locationId}`);
        if (a.types?.length) q = q.in('account_type', a.types);
        if (t) q = q.or(`account_number.ilike.${t}%,name.ilike.%${t}%`);
      }
      const { data, error } = await q.order('account_number').limit(ids.length || (t ? limit : 500));
      if (error) throw new Error(`Account lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; account_number: string; name: string; account_type: string }[]).map((x) => ({
        id: x.id,
        label: `${x.account_number} · ${x.name}`,
        sub: x.account_type,
        meta: { type: x.account_type, number: x.account_number },
      }));
    }
    case 'units': {
      let q = db
        .from('dealer_units')
        .select('id, serial_number, stock_number, model, model_year, status, condition')
        .eq('org_id', a.orgId)
        .eq('location_id', a.locationId);
      if (ids.length) q = q.in('id', ids);
      else {
        q = q.neq('status', 'VOID');
        if (t) q = q.or(`serial_number.ilike.%${t}%,stock_number.ilike.%${t}%,model.ilike.%${t}%,vin_hin.ilike.%${t}%`);
      }
      const { data, error } = await q.order('serial_number').limit(ids.length || limit);
      if (error) throw new Error(`Unit lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; serial_number: string; stock_number: string | null; model: string | null; model_year: number | null; status: string; condition: string }[]).map((u) => ({
        id: u.id,
        label: u.serial_number,
        sub: [u.model_year, u.model, u.stock_number ? `Stock ${u.stock_number}` : null].filter(Boolean).join(' · ') || null,
        meta: { status: u.status, condition: u.condition },
      }));
    }
    case 'lines': {
      let q = db.from('floor_plan_lines').select('id, name, status, lender_vendor_id').eq('org_id', a.orgId).eq('location_id', a.locationId);
      if (ids.length) q = q.in('id', ids);
      else if (t) q = q.ilike('name', `%${t}%`);
      const { data, error } = await q.order('name').limit(ids.length || 100);
      if (error) throw new Error(`Line lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; status: string; lender_vendor_id: string }[]).map((l) => ({
        id: l.id,
        label: l.name,
        sub: null,
        meta: { status: l.status, lenderVendorId: l.lender_vendor_id },
      }));
    }
    case 'programs': {
      let q = db.from('floor_plan_programs').select('id, name, status, line_id, rate_bps, free_floor_days').eq('org_id', a.orgId).eq('location_id', a.locationId);
      if (ids.length) q = q.in('id', ids);
      else if (t) q = q.ilike('name', `%${t}%`);
      const { data, error } = await q.order('name').limit(ids.length || 200);
      if (error) throw new Error(`Program lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; status: string; line_id: string; rate_bps: number; free_floor_days: number }[]).map((p) => ({
        id: p.id,
        label: p.name,
        sub: null,
        meta: { status: p.status, lineId: p.line_id, rateBps: Number(p.rate_bps), freeFloorDays: Number(p.free_floor_days) },
      }));
    }
    case 'oem_programs': {
      let q = db.from('oem_programs').select('id, name, program_code, program_type, treatment, status, oem_vendor_id').eq('org_id', a.orgId).eq('location_id', a.locationId);
      if (ids.length) q = q.in('id', ids);
      else if (t) q = q.or(`name.ilike.%${t}%,program_code.ilike.%${t}%`);
      const { data, error } = await q.order('name').limit(ids.length || 200);
      if (error) throw new Error(`Program lookup failed: ${error.message}`);
      return ((data ?? []) as { id: string; name: string; program_code: string | null; program_type: string; treatment: string; status: string; oem_vendor_id: string }[]).map((p) => ({
        id: p.id,
        label: p.name,
        sub: p.program_code,
        meta: { type: p.program_type, treatment: p.treatment, status: p.status, oemVendorId: p.oem_vendor_id },
      }));
    }
  }
}
