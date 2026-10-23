/**
 * Vendor requirement sets — PURE evaluation (no I/O; FPB-vendor-compliance-chase §19).
 *
 * A requirement set says what a vendor owes one company (or every company): a W-9, a
 * certificate of insurance with minimum limits, endorsements and a named certificate
 * holder, how early to chase a renewal, whether a gap blocks payment, and a grace period.
 *
 *   selectRequirementSet   most specific set for a vendor × company (company 8 · type 4 ·
 *                          work type 2 · 1099 status 1; ties → newest)
 *   mergeRequirementSets   the strictest union across the companies a vendor works for
 *                          (the chase asks for everything any of them needs)
 *   evaluateRequirements   rule-by-rule result against what is ON FILE (accepted)
 *   checkProposedCoi       the same rules against an AI read / keyed certificate that has
 *                          NOT been accepted yet (vendor read-back + reviewer queue)
 *
 * Checks are deterministic: limits compared in integer cents, dates as ISO strings,
 * holder names by a normalised comparison. AI never decides a result — it only supplies
 * the facts the reviewer confirms.
 */

export const VENDOR_TYPES = ['service_provider', 'supplier', 'subcontractor', 'professional', 'exempt', 'foreign'] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

export const VENDOR_TYPE_LABEL: Record<VendorType, string> = {
  service_provider: '1099 service provider',
  supplier: 'Supplier',
  subcontractor: 'Subcontractor',
  professional: 'Professional services',
  exempt: 'Exempt (landlord, utility, government)',
  foreign: 'Foreign vendor',
};

export const TAX_1099_SCOPES = ['any', 'eligible', 'not_eligible'] as const;
export type Tax1099Scope = (typeof TAX_1099_SCOPES)[number];

export const COVERAGE_TYPES = ['GENERAL_LIABILITY', 'WORKERS_COMP', 'AUTO', 'UMBRELLA', 'PROFESSIONAL', 'POLLUTION', 'OTHER'] as const;
export type CoverageKind = (typeof COVERAGE_TYPES)[number];

export function isVendorType(v: unknown): v is VendorType {
  return typeof v === 'string' && (VENDOR_TYPES as readonly string[]).includes(v);
}

/** One requirement set (a public.vendor_requirements row, camel-cased). */
export interface RequirementSet {
  id: string;
  name: string;
  locationId: string | null;
  vendorType: VendorType | null;
  tax1099: Tax1099Scope;
  workType: string | null;
  w9Required: boolean;
  coiRequired: boolean;
  minGlEachOccurrenceCents: number | null;
  minGlAggregateCents: number | null;
  minAutoCents: number | null;
  wcRequired: boolean;
  minWcEachAccidentCents: number | null;
  minUmbrellaCents: number | null;
  requireAdditionalInsured: boolean;
  requireWaiverOfSubrogation: boolean;
  /** Required certificate-holder wording; a merged set may carry several (one per company). */
  certificateHolderNames: string[];
  expiryLeadDays: number;
  blockPayment: boolean;
  graceDays: number;
  isActive: boolean;
  updatedAt: string;
}

export interface RequirementRow {
  id: string;
  name: string;
  location_id: string | null;
  vendor_type: string | null;
  tax_1099: string;
  work_type: string | null;
  w9_required: boolean;
  coi_required: boolean;
  min_gl_each_occurrence_cents: number | string | null;
  min_gl_aggregate_cents: number | string | null;
  min_auto_cents: number | string | null;
  wc_required: boolean;
  min_wc_each_accident_cents: number | string | null;
  min_umbrella_cents: number | string | null;
  require_additional_insured: boolean;
  require_waiver_of_subrogation: boolean;
  certificate_holder_name: string | null;
  expiry_lead_days: number;
  block_payment: boolean;
  grace_days: number;
  is_active: boolean;
  updated_at: string;
}

export const REQUIREMENT_COLUMNS =
  'id, name, location_id, vendor_type, tax_1099, work_type, w9_required, coi_required, min_gl_each_occurrence_cents, min_gl_aggregate_cents, min_auto_cents, wc_required, min_wc_each_accident_cents, min_umbrella_cents, require_additional_insured, require_waiver_of_subrogation, certificate_holder_name, expiry_lead_days, block_payment, grace_days, is_active, updated_at';

const cents = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export function rowToSet(r: RequirementRow): RequirementSet {
  return {
    id: r.id,
    name: r.name,
    locationId: r.location_id,
    vendorType: isVendorType(r.vendor_type) ? r.vendor_type : null,
    tax1099: (TAX_1099_SCOPES as readonly string[]).includes(r.tax_1099) ? (r.tax_1099 as Tax1099Scope) : 'any',
    workType: r.work_type,
    w9Required: !!r.w9_required,
    coiRequired: !!r.coi_required,
    minGlEachOccurrenceCents: cents(r.min_gl_each_occurrence_cents),
    minGlAggregateCents: cents(r.min_gl_aggregate_cents),
    minAutoCents: cents(r.min_auto_cents),
    wcRequired: !!r.wc_required,
    minWcEachAccidentCents: cents(r.min_wc_each_accident_cents),
    minUmbrellaCents: cents(r.min_umbrella_cents),
    requireAdditionalInsured: !!r.require_additional_insured,
    requireWaiverOfSubrogation: !!r.require_waiver_of_subrogation,
    certificateHolderNames: r.certificate_holder_name ? [r.certificate_holder_name] : [],
    expiryLeadDays: Number(r.expiry_lead_days ?? 30),
    blockPayment: !!r.block_payment,
    graceDays: Number(r.grace_days ?? 0),
    isActive: !!r.is_active,
    updatedAt: r.updated_at,
  };
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface VendorClass {
  vendorType: VendorType | null;
  workType: string | null;
  is1099Eligible: boolean | null;
}

function setMatches(s: RequirementSet, v: VendorClass, locationId: string | null): boolean {
  if (!s.isActive) return false;
  if (s.locationId && s.locationId !== locationId) return false;
  if (s.vendorType) {
    if (s.vendorType !== v.vendorType) return false;
  } else if (v.vendorType === 'exempt') {
    // An exempt vendor is only in scope for a set that targets exempt vendors explicitly.
    return false;
  }
  if (s.workType && s.workType !== v.workType) return false;
  if (s.tax1099 === 'eligible' && v.is1099Eligible !== true) return false;
  if (s.tax1099 === 'not_eligible' && v.is1099Eligible !== false) return false;
  return true;
}

function specificity(s: RequirementSet): number {
  return (s.locationId ? 8 : 0) + (s.vendorType ? 4 : 0) + (s.workType ? 2 : 0) + (s.tax1099 !== 'any' ? 1 : 0);
}

/** The most specific active set for this vendor in this company (null company = firm-wide sets only). */
export function selectRequirementSet(sets: ReadonlyArray<RequirementSet>, v: VendorClass, locationId: string | null): RequirementSet | null {
  const candidates = sets.filter((s) => setMatches(s, v, locationId));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => specificity(b) - specificity(a) || (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0))[0];
}

const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Strictest union (the chase asks for what every company the vendor works for needs). */
export function mergeRequirementSets(sets: ReadonlyArray<RequirementSet>): RequirementSet | null {
  if (sets.length === 0) return null;
  if (sets.length === 1) return sets[0];
  const [first, ...rest] = sets;
  return rest.reduce<RequirementSet>(
    (acc, s) => ({
      ...acc,
      id: `${acc.id}+${s.id}`,
      name: `${acc.name} + ${s.name}`,
      locationId: null,
      w9Required: acc.w9Required || s.w9Required,
      coiRequired: acc.coiRequired || s.coiRequired,
      minGlEachOccurrenceCents: maxOf(acc.minGlEachOccurrenceCents, s.minGlEachOccurrenceCents),
      minGlAggregateCents: maxOf(acc.minGlAggregateCents, s.minGlAggregateCents),
      minAutoCents: maxOf(acc.minAutoCents, s.minAutoCents),
      wcRequired: acc.wcRequired || s.wcRequired,
      minWcEachAccidentCents: maxOf(acc.minWcEachAccidentCents, s.minWcEachAccidentCents),
      minUmbrellaCents: maxOf(acc.minUmbrellaCents, s.minUmbrellaCents),
      requireAdditionalInsured: acc.requireAdditionalInsured || s.requireAdditionalInsured,
      requireWaiverOfSubrogation: acc.requireWaiverOfSubrogation || s.requireWaiverOfSubrogation,
      certificateHolderNames: Array.from(new Set([...acc.certificateHolderNames, ...s.certificateHolderNames])),
      expiryLeadDays: Math.max(acc.expiryLeadDays, s.expiryLeadDays),
      blockPayment: acc.blockPayment || s.blockPayment,
      graceDays: Math.min(acc.graceDays, s.graceDays),
    }),
    first,
  );
}

// ── Facts ────────────────────────────────────────────────────────────────────

/** One coverage line (accepted, or proposed by AI / keyed by a reviewer). */
export interface CoverageFact {
  coverageType: CoverageKind;
  eachOccurrenceCents: number | null;
  aggregateCents: number | null;
  expirationDate: string | null;
  additionalInsured: boolean | null;
  waiverOfSubrogation: boolean | null;
  certificateHolder: string | null;
}

/** What is on file for a vendor (accepted facts only) plus what is waiting for review. */
export interface VendorFacts {
  w9: { status: 'valid' | 'missing'; } ;
  /** Accepted, active coverage lines (expired ones included — the rule reports them). */
  coverages: CoverageFact[];
  /** A valid workers' comp exemption certificate. */
  wcExemptionValid: boolean;
  pendingW9: boolean;
  pendingCoi: boolean;
}

export const RULE_IDS = [
  'W9', 'COI_GL_OCCURRENCE', 'COI_GL_AGGREGATE', 'COI_AUTO', 'COI_WC', 'COI_UMBRELLA',
  'END_ADDITIONAL_INSURED', 'END_WAIVER_SUBROGATION', 'CERT_HOLDER',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type RuleOutcome = 'met' | 'expiring' | 'grace' | 'pending' | 'missing' | 'short' | 'expired' | 'not_met';

export interface RuleResult {
  rule: RuleId;
  label: string;
  outcome: RuleOutcome;
  /** Plain-English reason (named failure, never "non-compliant"). */
  reason: string;
  /** Expiry of the evidence, when there is one. */
  expiresOn: string | null;
}

/** Outcomes that block payment (when the set blocks). */
export const BLOCKING: ReadonlySet<RuleOutcome> = new Set(['pending', 'missing', 'short', 'expired', 'not_met']);

export const RULE_LABEL: Record<RuleId, string> = {
  W9: 'Form W-9',
  COI_GL_OCCURRENCE: 'General liability, each occurrence',
  COI_GL_AGGREGATE: 'General liability, aggregate',
  COI_AUTO: 'Auto liability',
  COI_WC: "Workers' compensation",
  COI_UMBRELLA: 'Umbrella / excess',
  END_ADDITIONAL_INSURED: 'Additional insured',
  END_WAIVER_SUBROGATION: 'Waiver of subrogation',
  CERT_HOLDER: 'Certificate holder',
};

/** $1,000,000.00 from integer cents (no floats on the money path). */
export function dollars(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(Math.trunc(c));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '(' : ''}$${whole}.${frac}${neg ? ')' : ''}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const LEGAL_SUFFIX = /\b(llc|l l c|inc|incorporated|co|company|corp|corporation|ltd|limited|lp|llp|pllc|pc|the)\b/g;

/** Normalised holder name: lower case, punctuation and entity suffixes removed. */
export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does the certificate's holder block name the required holder? (normalised; one contains the other) */
export function holderMatches(onCertificate: string | null | undefined, required: string): boolean {
  if (!onCertificate) return false;
  const a = normaliseName(onCertificate);
  const b = normaliseName(required);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Best line of one type: the unexpired one with the highest limit, else the latest-expiring. */
function bestLine(lines: ReadonlyArray<CoverageFact>, type: CoverageKind, today: string, pick: (c: CoverageFact) => number | null): CoverageFact | null {
  const of = lines.filter((l) => l.coverageType === type);
  if (of.length === 0) return null;
  const current = of.filter((l) => !l.expirationDate || l.expirationDate >= today);
  const pool = current.length ? current : of;
  return [...pool].sort((x, y) => (pick(y) ?? -1) - (pick(x) ?? -1) || ((y.expirationDate ?? '9999') > (x.expirationDate ?? '9999') ? 1 : -1))[0];
}

interface Ctx {
  set: RequirementSet;
  today: string;
  pending: boolean;
}

function dated(ctx: Ctx, rule: RuleId, line: CoverageFact, okReason: string): RuleResult {
  const exp = line.expirationDate;
  const base = { rule, label: RULE_LABEL[rule], expiresOn: exp };
  if (exp && exp < ctx.today) {
    if (addDays(exp, ctx.set.graceDays) >= ctx.today && ctx.set.graceDays > 0) {
      return { ...base, outcome: 'grace', reason: `Expired ${exp}; grace period runs to ${addDays(exp, ctx.set.graceDays)}.` };
    }
    return { ...base, outcome: ctx.pending ? 'pending' : 'expired', reason: ctx.pending ? `Expired ${exp}; a renewal is waiting for review.` : `Expired ${exp}.` };
  }
  if (exp && exp <= addDays(ctx.today, ctx.set.expiryLeadDays)) {
    return { ...base, outcome: 'expiring', reason: `${okReason} Expires ${exp}.` };
  }
  return { ...base, outcome: 'met', reason: okReason };
}

function missing(ctx: Ctx, rule: RuleId, what: string): RuleResult {
  return ctx.pending
    ? { rule, label: RULE_LABEL[rule], outcome: 'pending', reason: `${what} — a certificate is waiting for review.`, expiresOn: null }
    : { rule, label: RULE_LABEL[rule], outcome: 'missing', reason: `${what}.`, expiresOn: null };
}

function limitRule(ctx: Ctx, rule: RuleId, lines: ReadonlyArray<CoverageFact>, type: CoverageKind, field: 'eachOccurrenceCents' | 'aggregateCents', min: number, noun: string): RuleResult {
  const line = bestLine(lines, type, ctx.today, (c) => c[field]);
  if (!line) return missing(ctx, rule, `No ${noun} on file; ${dollars(min)} required`);
  const have = line[field];
  if (have === null) {
    return { rule, label: RULE_LABEL[rule], outcome: ctx.pending ? 'pending' : 'not_met', reason: `The certificate does not state the ${noun} limit; ${dollars(min)} required.`, expiresOn: line.expirationDate };
  }
  if (have < min) {
    return { rule, label: RULE_LABEL[rule], outcome: ctx.pending ? 'pending' : 'short', reason: `${capital(noun)} ${dollars(have)} on file; ${dollars(min)} required.`, expiresOn: line.expirationDate };
  }
  return dated(ctx, rule, line, `${capital(noun)} ${dollars(have)} (${dollars(min)} required).`);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every rule the set imposes, evaluated against coverage lines + W-9 state. */
function evaluateLines(set: RequirementSet, w9Valid: boolean, w9Pending: boolean, lines: ReadonlyArray<CoverageFact>, wcExempt: boolean, coiPending: boolean, today: string): RuleResult[] {
  const out: RuleResult[] = [];
  if (set.w9Required) {
    out.push(
      w9Valid
        ? { rule: 'W9', label: RULE_LABEL.W9, outcome: 'met', reason: 'A W-9 is on file.', expiresOn: null }
        : w9Pending
          ? { rule: 'W9', label: RULE_LABEL.W9, outcome: 'pending', reason: 'A W-9 is waiting for review.', expiresOn: null }
          : { rule: 'W9', label: RULE_LABEL.W9, outcome: 'missing', reason: 'No W-9 on file.', expiresOn: null },
    );
  }
  const ctx: Ctx = { set, today, pending: coiPending };
  const glOcc = set.minGlEachOccurrenceCents;
  const glAgg = set.minGlAggregateCents;
  if (set.coiRequired || glOcc !== null || glAgg !== null) {
    if (glOcc !== null) out.push(limitRule(ctx, 'COI_GL_OCCURRENCE', lines, 'GENERAL_LIABILITY', 'eachOccurrenceCents', glOcc, 'general liability each occurrence'));
    else {
      const gl = bestLine(lines, 'GENERAL_LIABILITY', today, (c) => c.eachOccurrenceCents);
      out.push(gl ? dated(ctx, 'COI_GL_OCCURRENCE', gl, 'General liability on file.') : missing(ctx, 'COI_GL_OCCURRENCE', 'No general liability certificate on file'));
    }
    if (glAgg !== null) out.push(limitRule(ctx, 'COI_GL_AGGREGATE', lines, 'GENERAL_LIABILITY', 'aggregateCents', glAgg, 'general liability aggregate'));
  }
  if (set.minAutoCents !== null) out.push(limitRule(ctx, 'COI_AUTO', lines, 'AUTO', 'eachOccurrenceCents', set.minAutoCents, 'auto liability'));
  if (set.wcRequired || set.minWcEachAccidentCents !== null) {
    const wc = bestLine(lines, 'WORKERS_COMP', today, (c) => c.eachOccurrenceCents);
    if (!wc && wcExempt) {
      out.push({ rule: 'COI_WC', label: RULE_LABEL.COI_WC, outcome: 'met', reason: "A workers' comp exemption is on file.", expiresOn: null });
    } else if (set.minWcEachAccidentCents !== null) {
      out.push(limitRule(ctx, 'COI_WC', lines, 'WORKERS_COMP', 'eachOccurrenceCents', set.minWcEachAccidentCents, "workers' comp employer's liability each accident"));
    } else {
      out.push(wc ? dated(ctx, 'COI_WC', wc, "Workers' comp on file.") : missing(ctx, 'COI_WC', "No workers' comp certificate or exemption on file"));
    }
  }
  if (set.minUmbrellaCents !== null) out.push(limitRule(ctx, 'COI_UMBRELLA', lines, 'UMBRELLA', 'eachOccurrenceCents', set.minUmbrellaCents, 'umbrella'));

  const gl = bestLine(lines, 'GENERAL_LIABILITY', today, (c) => c.eachOccurrenceCents);
  const flag = (rule: RuleId, on: boolean, value: boolean | null | undefined, words: string) => {
    if (!on) return;
    if (!gl) return void out.push(missing(ctx, rule, `No general liability certificate to show ${words}`));
    if (value === true) return void out.push({ rule, label: RULE_LABEL[rule], outcome: 'met', reason: `The certificate shows ${words}.`, expiresOn: gl.expirationDate });
    out.push({
      rule,
      label: RULE_LABEL[rule],
      outcome: ctx.pending ? 'pending' : 'not_met',
      reason: value === false ? `The certificate does not show ${words}; ask the agent to add it.` : `We could not confirm ${words} on the certificate.`,
      expiresOn: gl.expirationDate,
    });
  };
  flag('END_ADDITIONAL_INSURED', set.requireAdditionalInsured, gl?.additionalInsured, 'the certificate holder as additional insured');
  flag('END_WAIVER_SUBROGATION', set.requireWaiverOfSubrogation, gl?.waiverOfSubrogation, 'a waiver of subrogation');

  if (set.certificateHolderNames.length > 0) {
    const holders = lines.filter((l) => !l.expirationDate || l.expirationDate >= today).map((l) => l.certificateHolder).filter((h): h is string => !!h);
    const anyLine = lines.length > 0;
    const ok = set.certificateHolderNames.every((req) => holders.some((h) => holderMatches(h, req)));
    const wanted = set.certificateHolderNames.map((n) => `“${n}”`).join(' and ');
    if (!anyLine) out.push(missing(ctx, 'CERT_HOLDER', `No certificate on file; the holder must read ${wanted}`));
    else if (ok) out.push({ rule: 'CERT_HOLDER', label: RULE_LABEL.CERT_HOLDER, outcome: 'met', reason: `The holder reads ${wanted}.`, expiresOn: null });
    else {
      const seen = holders[0] ? `It reads “${holders[0]}”; ` : 'No holder is shown; ';
      out.push({ rule: 'CERT_HOLDER', label: RULE_LABEL.CERT_HOLDER, outcome: ctx.pending ? 'pending' : 'not_met', reason: `${seen}it must read ${wanted}. Ask the agent to reissue.`, expiresOn: null });
    }
  }
  return out;
}

/** Rule results for what is ON FILE. */
export function evaluateRequirements(set: RequirementSet, facts: VendorFacts, today: string): RuleResult[] {
  return evaluateLines(set, facts.w9.status === 'valid', facts.pendingW9, facts.coverages, facts.wcExemptionValid, facts.pendingCoi, today);
}

/** The COI rules only, against a proposed certificate (not yet accepted). */
export function checkProposedCoi(set: RequirementSet, lines: ReadonlyArray<CoverageFact>, today: string): RuleResult[] {
  const coiOnly: RequirementSet = { ...set, w9Required: false, coiRequired: true };
  return evaluateLines(coiOnly, true, false, lines, false, false, today);
}

export type VendorState = 'compliant' | 'expiring' | 'pending' | 'missing' | 'not_compliant' | 'not_required';

export interface RequirementSummary {
  state: VendorState;
  blocking: RuleResult[];
  expiring: RuleResult[];
  /** Earliest expiry across met/expiring dated evidence (renewal anchor). */
  nextExpiry: string | null;
  /** Hold applies (set blocks AND something blocks). Overrides are applied by the caller. */
  holds: boolean;
}

export function summarise(set: RequirementSet | null, results: ReadonlyArray<RuleResult>): RequirementSummary {
  if (!set) return { state: 'not_required', blocking: [], expiring: [], nextExpiry: null, holds: false };
  const blocking = results.filter((r) => BLOCKING.has(r.outcome));
  const expiring = results.filter((r) => r.outcome === 'expiring' || r.outcome === 'grace');
  const dates = results.filter((r) => r.expiresOn && (r.outcome === 'met' || r.outcome === 'expiring' || r.outcome === 'grace')).map((r) => r.expiresOn as string).sort();
  let state: VendorState = 'compliant';
  if (blocking.some((r) => r.outcome === 'missing')) state = 'missing';
  else if (blocking.some((r) => r.outcome !== 'pending')) state = 'not_compliant';
  else if (blocking.length) state = 'pending';
  else if (expiring.length) state = 'expiring';
  return { state, blocking, expiring, nextExpiry: dates[0] ?? null, holds: set.blockPayment && blocking.length > 0 };
}

/** One sentence for a hold message ("General liability each occurrence $500,000.00 on file; $1,000,000.00 required"). */
export function holdReasons(results: ReadonlyArray<RuleResult>): string {
  return results
    .filter((r) => BLOCKING.has(r.outcome))
    .map((r) => `${r.label}: ${r.reason.replace(/\.$/, '')}`)
    .join('; ');
}

// ── Proposed COI → coverage facts (from coi-parse's ProposedCoi shape) ───────

export interface ProposedCoiLike {
  certificate_holder: string | null;
  additional_insured: boolean | null;
  waiver_of_subrogation?: boolean | null;
  coverages: Array<{
    coverage_type: string;
    each_occurrence_cents: number | null;
    aggregate_cents: number | null;
    expiration_date: string | null;
  }>;
}

export function coverageFactsFromProposal(p: ProposedCoiLike): CoverageFact[] {
  return (p.coverages ?? []).map((c) => ({
    coverageType: (COVERAGE_TYPES as readonly string[]).includes(c.coverage_type) ? (c.coverage_type as CoverageKind) : 'OTHER',
    eachOccurrenceCents: c.each_occurrence_cents ?? null,
    aggregateCents: c.aggregate_cents ?? null,
    expirationDate: c.expiration_date ?? null,
    additionalInsured: p.additional_insured ?? null,
    waiverOfSubrogation: p.waiver_of_subrogation ?? null,
    certificateHolder: p.certificate_holder ?? null,
  }));
}

/** "Meets" | "Doesn't meet" | "Can't tell" for the vendor read-back. */
export function readBackWord(o: RuleOutcome): 'Meets' | "Doesn't meet" | 'Expiring soon' | 'Waiting for review' {
  if (o === 'met') return 'Meets';
  if (o === 'expiring' || o === 'grace') return 'Expiring soon';
  if (o === 'pending') return 'Waiting for review';
  return "Doesn't meet";
}
