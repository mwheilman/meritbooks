/**
 * The records a document can be linked to — table, label and search columns per record
 * type (Rule 11: every column verified against the migrations / live schema 2026-10-24).
 * Used to (1) verify an accepted / linked target exists in the org, (2) label a link
 * ("Lease: Acme Properties — Office 123 Main"), and (3) search for "Link to existing".
 *
 * Server-only (takes a Supabase client). Every query is org-pinned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordSpec {
  schema: 'public' | 'core';
  table: string;
  /** Human noun: "Lease". */
  noun: string;
  /** Columns the label is built from (selected + searched). */
  labelCols: string[];
  /** Column carrying the owning company, or null for org-level records. */
  locationCol: string | null;
  /** Rows soft-deleted by this column are excluded. */
  deletedCol?: string;
  label: (row: Record<string, unknown>) => string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const join = (...parts: unknown[]): string => parts.map(s).filter(Boolean).join(' — ');

export const RECORD_TYPES: Record<string, RecordSpec> = {
  lease: { schema: 'public', table: 'leases', noun: 'Lease', labelCols: ['lessor', 'description'], locationCol: 'location_id', label: (r) => join(r.lessor, r.description) || 'Lease' },
  debt_instrument: { schema: 'public', table: 'debt_instruments', noun: 'Loan', labelCols: ['name', 'lender'], locationCol: 'location_id', label: (r) => join(r.name, r.lender) || 'Loan' },
  covenant: { schema: 'public', table: 'loan_covenants', noun: 'Covenant', labelCols: ['covenant_type'], locationCol: 'location_id', label: (r) => s(r.covenant_type) || 'Covenant' },
  policy: { schema: 'public', table: 'insurance_policies', noun: 'Insurance policy', labelCols: ['carrier', 'policy_number', 'coverage_type'], locationCol: 'location_id', label: (r) => join(r.carrier, r.coverage_type, r.policy_number) || 'Policy' },
  prepaid: { schema: 'public', table: 'posting_schedules', noun: 'Prepaid schedule', labelCols: ['memo'], locationCol: 'location_id', label: (r) => s(r.memo) || 'Prepaid schedule' },
  subscription: { schema: 'public', table: 'subscriptions', noun: 'Subscription', labelCols: ['vendor_name', 'product'], locationCol: 'location_id', label: (r) => join(r.vendor_name, r.product) || 'Subscription' },
  fixed_asset: { schema: 'public', table: 'fixed_assets', noun: 'Fixed asset', labelCols: ['name', 'asset_tag'], locationCol: 'location_id', label: (r) => join(r.name, r.asset_tag) || 'Fixed asset' },
  bill: { schema: 'public', table: 'bills', noun: 'Bill', labelCols: ['bill_number'], locationCol: 'location_id', label: (r) => (s(r.bill_number) ? `#${s(r.bill_number)}` : 'Bill') },
  invoice: { schema: 'public', table: 'invoices', noun: 'Invoice', labelCols: ['invoice_number'], locationCol: 'location_id', label: (r) => (s(r.invoice_number) ? `#${s(r.invoice_number)}` : 'Invoice') },
  customer_contract: { schema: 'public', table: 'recurring_invoice_templates', noun: 'Recurring invoice', labelCols: ['name'], locationCol: 'location_id', label: (r) => s(r.name) || 'Recurring invoice' },
  vendor: { schema: 'core', table: 'vendors', noun: 'Vendor', labelCols: ['name', 'display_name'], locationCol: null, deletedCol: 'deleted_at', label: (r) => s(r.display_name) || s(r.name) || 'Vendor' },
  customer: { schema: 'core', table: 'customers', noun: 'Customer', labelCols: ['name', 'display_name'], locationCol: null, deletedCol: 'deleted_at', label: (r) => s(r.display_name) || s(r.name) || 'Customer' },
  payroll_run: { schema: 'public', table: 'payroll_runs', noun: 'Payroll run', labelCols: ['memo'], locationCol: 'location_id', label: (r) => join('Pay date', r.pay_date) || 'Payroll run' },
  bank_account: { schema: 'public', table: 'bank_accounts', noun: 'Bank account', labelCols: ['account_name', 'institution_name'], locationCol: 'location_id', label: (r) => join(r.institution_name, r.account_name, r.account_mask ? `••${s(r.account_mask)}` : '') || 'Bank account' },
  location: { schema: 'core', table: 'locations', noun: 'Company', labelCols: ['name'], locationCol: 'id', label: (r) => s(r.name) || 'Company' },
};

export const LINKABLE_RECORD_TYPES = Object.keys(RECORD_TYPES);

export function isRecordType(t: unknown): t is keyof typeof RECORD_TYPES {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(RECORD_TYPES, t);
}

export interface ResolvedRecord {
  id: string;
  label: string;
  locationId: string | null;
}

function base(db: SupabaseClient, spec: RecordSpec) {
  return spec.schema === 'core' ? db.schema('core').from(spec.table) : db.from(spec.table);
}

/** Load one record (org-pinned). null when it does not exist in the org. */
export async function resolveRecord(db: SupabaseClient, orgId: string, type: string, id: string): Promise<ResolvedRecord | null> {
  if (!isRecordType(type)) return null;
  const spec = RECORD_TYPES[type];
  const { data, error } = await base(db, spec).select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  if (spec.deletedCol && row[spec.deletedCol]) return null;
  const loc = spec.locationCol ? row[spec.locationCol] : null;
  return { id, label: `${spec.noun}: ${spec.label(row)}`, locationId: typeof loc === 'string' ? loc : null };
}

/** Search records of a type for "Link to existing record" (org-pinned, ≤ 20). */
export async function searchRecords(db: SupabaseClient, orgId: string, type: string, q: string, locationId?: string | null): Promise<ResolvedRecord[]> {
  if (!isRecordType(type)) return [];
  const spec = RECORD_TYPES[type];
  let query = base(db, spec).select('*').eq('org_id', orgId);
  if (spec.deletedCol) query = query.is(spec.deletedCol, null);
  if (locationId && spec.locationCol && spec.locationCol !== 'id') query = query.eq(spec.locationCol, locationId);
  const term = q.trim().replace(/[%,()]/g, ' ').slice(0, 80);
  if (term) query = query.or(spec.labelCols.map((c) => `${c}.ilike.%${term}%`).join(','));
  const { data } = await query.order('created_at', { ascending: false }).limit(20);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const loc = spec.locationCol ? row[spec.locationCol] : null;
    return { id: String(row.id), label: `${spec.noun}: ${spec.label(row)}`, locationId: typeof loc === 'string' ? loc : null };
  });
}
