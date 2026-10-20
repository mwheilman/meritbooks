/**
 * createCompany — THE single company-creation path (FPB-onboarding §5, slice W5).
 *
 * Every surface that creates a company (Settings → Entities, the onboarding wizard
 * via /api/setup, bulk Portfolio onboarding, and the "Companies / Entities" CSV
 * import) goes through here, so a new company is always born the same way:
 *
 *   1. a `core.locations` row (org-scoped; name, short code, industry, fiscal-year
 *      start month, rev-rec method — the per-company settings entity creation has
 *      always seeded; everything else takes its column default, incl.
 *      onboarding_status = 'not_started'), and
 *   2. prior / current / next calendar-year fiscal periods with months before the
 *      current month SOFT_CLOSE and the current month onward OPEN (never
 *      HARD_CLOSE — a brand-new company has nothing closed, and HARD_CLOSE would
 *      block posting its opening balances).
 *
 * The chart of accounts is ORG-scoped (shared by every company in the tenant), so
 * it is NOT seeded per company here — callers run the idempotent
 * `seedChartOfAccounts` once per request (a bulk create of 17 companies seeds once).
 *
 * Friendly failures: invalid input → 422, duplicate name / short code → 409,
 * no org → 400, database failure → 500. Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SHORT_CODE_RE, companyNameKey, deriveShortCode, normalizeShortCode } from './short-code';
import { buildNewCompanyPeriods } from './fiscal-periods';

export { deriveShortCode, companyNameKey } from './short-code';

/** The nine canonical revenue-recognition methods (rev_rec_method_enum). */
export const REV_REC_METHODS = [
  'POINT_OF_SALE', 'AS_BILLED', 'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT',
  'MILESTONE', 'RATABLY', 'SUBSCRIPTION', 'CASH',
] as const;
export type RevRecMethod = (typeof REV_REC_METHODS)[number];
export const DEFAULT_REV_REC_METHOD: RevRecMethod = 'POINT_OF_SALE';

export interface CreateCompanyInput {
  orgId: string; name: string; shortCode?: string | null; industry?: string | null;
  fiscalYearStartMonth?: number; revRecMethod?: string | null;
}

export type CreateCompanyResult =
  | { ok: true; locationId: string; shortCode: string; periodsCreated: number }
  | { ok: false; error: string; status: number };

const NAME_MAX = 200;
const INDUSTRY_MAX = 100;

/**
 * Insert any missing fiscal periods for a company (idempotent — existing months
 * are left untouched, whatever their status). Used by createCompany and by the
 * Control Tower's "add missing periods" repair for companies created before this
 * path existed (e.g. by the old bulk import). Returns how many rows were added.
 *
 * `db` is the WRITE client: public.fiscal_periods is SELECT-only for members (migration
 * 171), so callers pass the service-role client AFTER their own permission check and
 * after verifying the company is in the caller's org (+ client scope). Rows are pinned
 * to `orgId` / `locationId`.
 */
export async function ensureFiscalPeriods(
  db: SupabaseClient,
  orgId: string,
  locationId: string,
  now: Date = new Date(),
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const rows = buildNewCompanyPeriods(orgId, locationId, now);
  const { data, error } = await db
    .from('fiscal_periods')
    .upsert(rows, { onConflict: 'org_id,location_id,period_year,period_month', ignoreDuplicates: true })
    .select('id');
  if (error) return { ok: false, error: error.message };
  return { ok: true, created: (data ?? []).length };
}

export async function createCompany(
  db: SupabaseClient,
  input: CreateCompanyInput,
  /**
   * WRITE CLIENT for core.locations (migration 167, M4): the table is service-role-
   * write only, so callers pass the service-role client here AFTER their own
   * permission check. Every write below is pinned to `input.orgId`. Defaults to `db`
   * (which fails closed for a member client).
   */
  opts: { writer?: SupabaseClient } = {},
): Promise<CreateCompanyResult> {
  const writer = opts.writer ?? db;
  // ── 1. Validate ────────────────────────────────────────────────────────────
  const orgId = (input.orgId ?? '').trim();
  if (!orgId) return { ok: false, error: 'No resolvable organization', status: 400 };

  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Company name is required', status: 422 };
  if (name.length > NAME_MAX) return { ok: false, error: `Company name must be ${NAME_MAX} characters or fewer`, status: 422 };

  const industry = input.industry?.trim() ? input.industry.trim() : null;
  if (industry && industry.length > INDUSTRY_MAX) {
    return { ok: false, error: `Industry must be ${INDUSTRY_MAX} characters or fewer`, status: 422 };
  }

  const fy = input.fiscalYearStartMonth ?? 1;
  if (!Number.isInteger(fy) || fy < 1 || fy > 12) {
    return { ok: false, error: 'Fiscal year start month must be 1–12', status: 422 };
  }

  const revRec = (input.revRecMethod ?? DEFAULT_REV_REC_METHOD) as string;
  if (!(REV_REC_METHODS as readonly string[]).includes(revRec)) {
    return { ok: false, error: `Unknown revenue recognition method "${revRec}"`, status: 422 };
  }

  const requestedCode = input.shortCode != null && String(input.shortCode).trim() !== ''
    ? String(input.shortCode).trim().toUpperCase()
    : null;
  if (requestedCode && !SHORT_CODE_RE.test(requestedCode)) {
    return { ok: false, error: 'Short code must be 1–10 uppercase letters or numbers', status: 422 };
  }

  // ── 2. Duplicate checks (org-scoped) ───────────────────────────────────────
  const { data: existing, error: exErr } = await db
    .schema('core').from('locations')
    .select('name, short_code')
    .eq('org_id', orgId)
    .limit(10000);
  if (exErr) return { ok: false, error: `Could not check existing companies: ${exErr.message}`, status: 500 };

  const rows = (existing ?? []) as Array<{ name: string | null; short_code: string | null }>;
  const key = companyNameKey(name);
  if (rows.some((r) => companyNameKey(r.name ?? '') === key)) {
    return { ok: false, error: `A company named "${name}" already exists`, status: 409 };
  }
  const taken = new Set(rows.map((r) => normalizeShortCode(r.short_code)).filter(Boolean));
  if (requestedCode && taken.has(requestedCode)) {
    return { ok: false, error: `Short code "${requestedCode}" already exists`, status: 409 };
  }
  const shortCode = requestedCode ?? deriveShortCode(name, taken);

  // ── 3. Create the company ──────────────────────────────────────────────────
  const { data: loc, error: locErr } = await writer
    .schema('core').from('locations')
    .insert({
      org_id: orgId,
      name,
      short_code: shortCode,
      industry,
      fiscal_year_start_month: fy,
      rev_rec_method: revRec,
    })
    .select('id')
    .single();
  if (locErr || !loc) {
    // 23505 = unique_violation: a concurrent create took the code between check and insert.
    if (locErr?.code === '23505') {
      return { ok: false, error: `Short code "${shortCode}" already exists`, status: 409 };
    }
    return { ok: false, error: `Could not create the company: ${locErr?.message ?? 'unknown error'}`, status: 500 };
  }
  const locationId = (loc as { id: string }).id;

  // ── 4. Fiscal periods ──────────────────────────────────────────────────────
  // fiscal_periods is member read-only (migration 171): written with the same write
  // client as the company itself (the service role from every production caller).
  const periods = await ensureFiscalPeriods(writer, orgId, locationId);
  if (!periods.ok) {
    // A company with no periods can't post anything. Roll the company back so the
    // caller can simply retry; if the rollback itself is refused, keep the company
    // (the Control Tower flags it and offers "Add missing periods").
    const { error: delErr } = await writer
      .schema('core').from('locations')
      .delete()
      .eq('org_id', orgId)
      .eq('id', locationId);
    if (!delErr) {
      return { ok: false, error: `Could not create fiscal periods for "${name}": ${periods.error}`, status: 500 };
    }
    console.error('[createCompany] periods failed and rollback refused:', periods.error, delErr.message);
    return { ok: true, locationId, shortCode, periodsCreated: 0 };
  }

  return { ok: true, locationId, shortCode, periodsCreated: periods.created };
}
