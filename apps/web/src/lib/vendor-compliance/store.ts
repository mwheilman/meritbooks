/**
 * Vendor compliance — reads (requirement sets, classification, on-file facts, the
 * companies each vendor works for). Every read is pinned to org_id. The caller passes the
 * client: the member's RLS client from a route (reads are member-SELECT) or the service
 * role from the scheduler / public portal (narrowed to a token-derived vendor).
 *
 * Tolerant of an un-migrated database: a missing 180 table reads as "no rows", so the
 * pay path degrades to the legacy doc-row behaviour rather than breaking payments.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  REQUIREMENT_COLUMNS,
  isVendorType,
  mergeRequirementSets,
  rowToSet,
  selectRequirementSet,
  type CoverageFact,
  type CoverageKind,
  type RequirementRow,
  type RequirementSet,
  type VendorClass,
  type VendorFacts,
} from './requirements';

type DB = SupabaseClient;

const PAGE = 1000;

/**
 * A CONFIRMED missing table (un-migrated DB) — the only error the pay path tolerates. A
 * missing COLUMN, a permission error or a network failure is NOT this and must fail closed.
 */
export function isMissingRelation(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.code === '42P01' || e.code === 'PGRST205') return true;
  return /relation "?[\w.]+"? does not exist|could not find the table/i.test(e.message ?? '');
}

/** Page through a query (PostgREST caps a response at 1000 rows). */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) {
      if (isMissingRelation(error)) return out;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function loadRequirementSets(db: DB, orgId: string, opts: { includeInactive?: boolean } = {}): Promise<RequirementSet[]> {
  const rows = await fetchAll<RequirementRow>((a, b) => {
    let q = db.from('vendor_requirements').select(REQUIREMENT_COLUMNS).eq('org_id', orgId);
    if (!opts.includeInactive) q = q.eq('is_active', true);
    return q.order('updated_at', { ascending: false }).range(a, b);
  });
  return rows.map(rowToSet);
}

export interface VendorBasics {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  is1099Eligible: boolean | null;
}

export async function loadVendors(db: DB, orgId: string, ids?: ReadonlyArray<string>): Promise<VendorBasics[]> {
  const rows: Array<Record<string, unknown>> = [];
  if (ids) {
    const list = Array.from(new Set(ids));
    for (let i = 0; i < list.length; i += 200) {
      const { data, error } = await db.schema('core').from('vendors').select('id, name, display_name, email, phone, is_active, is_1099_eligible, deleted_at').eq('org_id', orgId).in('id', list.slice(i, i + 200));
      if (error) throw new Error(`Could not read vendors: ${error.message}`);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
  } else {
    rows.push(
      ...(await fetchAll<Record<string, unknown>>((a, b) =>
        db.schema('core').from('vendors').select('id, name, display_name, email, phone, is_active, is_1099_eligible, deleted_at').eq('org_id', orgId).order('name').range(a, b),
      )),
    );
  }
  return rows
    .filter((v) => !v.deleted_at)
    .map((v) => ({
      id: v.id as string,
      name: ((v.display_name as string) || (v.name as string) || 'Unnamed vendor').trim(),
      email: (v.email as string | null) ?? null,
      phone: (v.phone as string | null) ?? null,
      isActive: v.is_active !== false,
      is1099Eligible: typeof v.is_1099_eligible === 'boolean' ? (v.is_1099_eligible as boolean) : null,
    }));
}

export interface VendorProfile {
  vendorType: VendorClass['vendorType'];
  workType: string | null;
}

export async function loadProfiles(db: DB, orgId: string, vendorIds?: ReadonlyArray<string>): Promise<Map<string, VendorProfile>> {
  const rows = await fetchAll<{ vendor_id: string; vendor_type: string | null; work_type: string | null }>((a, b) => {
    let q = db.from('vendor_compliance_profiles').select('vendor_id, vendor_type, work_type').eq('org_id', orgId);
    if (vendorIds && vendorIds.length <= 200) q = q.in('vendor_id', [...vendorIds]);
    return q.range(a, b);
  });
  return new Map(rows.map((r) => [r.vendor_id, { vendorType: isVendorType(r.vendor_type) ? r.vendor_type : null, workType: r.work_type }]));
}

/** vendor id → the companies (location ids) that have billed it. */
export async function loadVendorCompanies(db: DB, orgId: string, vendorIds?: ReadonlyArray<string>): Promise<Map<string, string[]>> {
  const rows = await fetchAll<{ vendor_id: string | null; location_id: string | null }>((a, b) => {
    let q = db.from('bills').select('vendor_id, location_id').eq('org_id', orgId).neq('status', 'VOIDED');
    if (vendorIds && vendorIds.length <= 200) q = q.in('vendor_id', [...vendorIds]);
    return q.range(a, b);
  });
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.vendor_id || !r.location_id) continue;
    const s = out.get(r.vendor_id) ?? new Set<string>();
    s.add(r.location_id);
    out.set(r.vendor_id, s);
  }
  return new Map(Array.from(out.entries()).map(([k, v]) => [k, Array.from(v)]));
}

interface DocRow {
  id: string;
  vendor_id: string;
  doc_type: string;
  status: string;
  expiration_date: string | null;
  coverage_amount_cents: number | string | null;
  submission_id?: string | null;
}

interface CoverageRow {
  vendor_id: string;
  coverage_type: string;
  each_occurrence_cents: number | string | null;
  aggregate_cents: number | string | null;
  expiration_date: string | null;
  additional_insured: boolean | null;
  waiver_of_subrogation: boolean | null;
  certificate_holder: string | null;
}

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

/** Pure: on-file facts for one vendor from its doc rows, accepted coverages and pending submissions. */
export function buildFacts(docs: ReadonlyArray<DocRow>, coverages: ReadonlyArray<CoverageRow>, pending: ReadonlyArray<{ doc_kind: string }>, today: string): VendorFacts {
  const w9Valid = docs.some((d) => d.doc_type === 'W9' && d.status === 'VALID');
  const wcExemptionValid = docs.some((d) => d.doc_type === 'WC_EXEMPTION' && d.status === 'VALID' && (!d.expiration_date || d.expiration_date >= today));
  const lines: CoverageFact[] = coverages.map((c) => ({
    coverageType: c.coverage_type as CoverageKind,
    eachOccurrenceCents: n(c.each_occurrence_cents),
    aggregateCents: n(c.aggregate_cents),
    expirationDate: c.expiration_date,
    additionalInsured: c.additional_insured,
    waiverOfSubrogation: c.waiver_of_subrogation,
    certificateHolder: c.certificate_holder,
  }));
  // Legacy doc rows (confirmed before 180, no structured lines) still count as evidence.
  for (const [docType, cov] of [['GL_COI', 'GENERAL_LIABILITY'], ['WC_COI', 'WORKERS_COMP']] as const) {
    if (lines.some((l) => l.coverageType === cov)) continue;
    for (const d of docs.filter((x) => x.doc_type === docType && (x.status === 'VALID' || x.status === 'EXPIRED'))) {
      lines.push({
        coverageType: cov,
        eachOccurrenceCents: n(d.coverage_amount_cents),
        aggregateCents: null,
        expirationDate: d.expiration_date,
        additionalInsured: null,
        waiverOfSubrogation: null,
        certificateHolder: null,
      });
    }
  }
  return {
    w9: { status: w9Valid ? 'valid' : 'missing' },
    coverages: lines,
    wcExemptionValid,
    pendingW9: pending.some((p) => p.doc_kind === 'W9'),
    pendingCoi: pending.some((p) => p.doc_kind === 'COI'),
  };
}

export interface FactsBundle {
  facts: Map<string, VendorFacts>;
  docs: Map<string, DocRow[]>;
}

/** On-file facts for many vendors (batched). */
export async function loadVendorFacts(db: DB, orgId: string, vendorIds: ReadonlyArray<string>, today: string): Promise<FactsBundle> {
  const ids = Array.from(new Set(vendorIds));
  const docs: DocRow[] = [];
  const coverages: CoverageRow[] = [];
  const pending: Array<{ vendor_id: string; doc_kind: string }> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [d, c, p] = await Promise.all([
      fetchAll<DocRow>((a, b) => db.from('vendor_compliance_docs').select('id, vendor_id, doc_type, status, expiration_date, coverage_amount_cents').eq('org_id', orgId).in('vendor_id', slice).range(a, b)),
      fetchAll<CoverageRow>((a, b) =>
        db.from('vendor_coverages').select('vendor_id, coverage_type, each_occurrence_cents, aggregate_cents, expiration_date, additional_insured, waiver_of_subrogation, certificate_holder').eq('org_id', orgId).eq('is_active', true).in('vendor_id', slice).range(a, b),
      ),
      fetchAll<{ vendor_id: string; doc_kind: string }>((a, b) => db.from('vendor_document_submissions').select('vendor_id, doc_kind').eq('org_id', orgId).in('status', ['received', 'ai_checked']).in('vendor_id', slice).range(a, b)),
    ]);
    docs.push(...d);
    coverages.push(...c);
    pending.push(...p);
  }
  const group = <T extends { vendor_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.vendor_id, [...(m.get(r.vendor_id) ?? []), r]);
    return m;
  };
  const dBy = group(docs);
  const cBy = group(coverages);
  const pBy = group(pending);
  const facts = new Map<string, VendorFacts>();
  for (const id of ids) facts.set(id, buildFacts(dBy.get(id) ?? [], cBy.get(id) ?? [], pBy.get(id) ?? [], today));
  return { facts, docs: dBy };
}

/** The set that governs a vendor for one company, or the strictest merge across its companies (locationId undefined). */
export function governingSet(
  sets: ReadonlyArray<RequirementSet>,
  v: VendorClass,
  scope: { locationId: string | null } | { companies: ReadonlyArray<string> },
): RequirementSet | null {
  if ('locationId' in scope) return selectRequirementSet(sets, v, scope.locationId);
  const companies = scope.companies.length ? scope.companies : [null];
  const picked = companies.map((c) => selectRequirementSet(sets, v, c)).filter((s): s is RequirementSet => !!s);
  const unique = Array.from(new Map(picked.map((s) => [s.id, s])).values());
  return mergeRequirementSets(unique);
}
