/**
 * Field-side commercial rules (pure): labor productivity and fade, the submittal schedule, the
 * T&M ticket price at contract rates, the COI check and the lien-waiver form choice. Each mirrors
 * a migration 1120 function so a screen can preview what the database will decide.
 */
import { roundCents } from './math';

// ------------------------------------------------------------------ labor productivity (CGC-90)

export interface ProductivityInput {
  budgetQty: number | null;
  budgetHours: number;
  /** Hours per unit; null = budgetHours / budgetQty. */
  unitHours: number | null;
  installedQty: number;
  /** Latest % complete entry (codes measured by % instead of units). */
  lastPct: number | null;
  pctEntry: boolean;
  actualHours: number;
}

export interface Productivity {
  pctComplete: number;
  earnedHours: number;
  productivityFactor: number | null;
  pctHoursUsed: number | null;
  projectedHours: number | null;
  varianceHours: number | null;
}

const r = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** pm._cm_productivity for one cost code. */
export function productivity(i: ProductivityInput): Productivity {
  const pct = Math.min(i.pctEntry || !i.budgetQty ? i.lastPct ?? 0 : i.installedQty / i.budgetQty, 1);
  const earned = pct * i.budgetHours;
  return {
    pctComplete: r(pct, 4),
    earnedHours: r(earned, 2),
    productivityFactor: i.actualHours > 0 ? r(earned / i.actualHours, 4) : null,
    pctHoursUsed: i.budgetHours > 0 ? r(i.actualHours / i.budgetHours, 4) : null,
    projectedHours: pct > 0 ? r(i.actualHours / pct, 2) : null,
    varianceHours: pct > 0 ? r(i.actualHours / pct - i.budgetHours, 2) : null,
  };
}

export type FadeSeverity = 'WATCH' | 'FADE' | 'CRITICAL';

/** pm.cm_run_fade_alerts severity: hours used ahead of % complete, or a weak week. */
export function fadeSeverity(pctHoursUsed: number | null, pctComplete: number, weekEarned: number, weekActual: number): FadeSeverity | null {
  const gap = (pctHoursUsed ?? 0) - pctComplete;
  if (gap >= 0.15) return 'CRITICAL';
  if (gap >= 0.05) return 'FADE';
  if (weekActual > 0 && weekEarned / weekActual < 0.9) return 'WATCH';
  return null;
}

// ------------------------------------------------------------------ submittal schedule (CGC-66)

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Submit-by = required on site − lead time − review time (null without an on-site date). */
export function submitBy(requiredOnSite: string | null, leadTimeDays: number, reviewDays: number): string | null {
  return requiredOnSite ? addDays(requiredOnSite, -(leadTimeDays + reviewDays)) : null;
}

/** The register rules of pm.cm_generate_submittal_register, by MasterFormat division. */
export const REGISTER_RULES: Readonly<Record<string, readonly string[]>> = {
  '03': ['PRODUCT_DATA', 'SHOP_DRAWING', 'TEST_REPORT'],
  '04': ['PRODUCT_DATA', 'SAMPLE'],
  '05': ['SHOP_DRAWING', 'PRODUCT_DATA', 'CERTIFICATE'],
  '06': ['PRODUCT_DATA', 'SHOP_DRAWING'],
  '07': ['PRODUCT_DATA', 'SAMPLE', 'WARRANTY'],
  '08': ['SHOP_DRAWING', 'PRODUCT_DATA', 'SAMPLE', 'WARRANTY'],
  '09': ['PRODUCT_DATA', 'SAMPLE'],
  '10': ['PRODUCT_DATA', 'SHOP_DRAWING'],
  '11': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL', 'WARRANTY'],
  '12': ['PRODUCT_DATA', 'SAMPLE'],
  '13': ['SHOP_DRAWING', 'CALCULATIONS'],
  '14': ['SHOP_DRAWING', 'PRODUCT_DATA', 'OM_MANUAL', 'WARRANTY'],
  '21': ['SHOP_DRAWING', 'PRODUCT_DATA', 'CALCULATIONS', 'OM_MANUAL', 'TEST_REPORT'],
  '22': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL', 'WARRANTY', 'TEST_REPORT'],
  '23': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL', 'WARRANTY', 'TEST_REPORT'],
  '25': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL'],
  '26': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL', 'WARRANTY', 'TEST_REPORT'],
  '27': ['PRODUCT_DATA', 'SHOP_DRAWING', 'TEST_REPORT'],
  '28': ['PRODUCT_DATA', 'SHOP_DRAWING', 'OM_MANUAL', 'TEST_REPORT'],
  '31': ['PRODUCT_DATA', 'TEST_REPORT'],
  '32': ['PRODUCT_DATA', 'SAMPLE'],
  '33': ['PRODUCT_DATA', 'TEST_REPORT'],
};

export function divisionOf(section: string): string {
  return section.replace(/[^0-9]/g, '').slice(0, 2);
}

// ------------------------------------------------------------------ T&M at contract rates (CGC-52)

export interface RateSheet {
  laborRates: ReadonlyArray<{ class: string; st_cents: number; ot_cents?: number | null; dt_cents?: number | null }>;
  materialMarkupPct: number;
  equipmentRates: ReadonlyArray<{ equipment: string; hourly_cents: number }>;
  equipmentMarkupPct: number;
  subMarkupPct: number;
}

export interface TmLine {
  kind: 'LABOR' | 'MATERIAL' | 'EQUIPMENT' | 'SUBCONTRACT' | 'OTHER';
  laborClass: string | null;
  hoursSt: number;
  hoursOt: number;
  hoursDt: number;
  qty: number | null;
  unitCostCents: number | null;
  equipmentHours: number | null;
  description: string;
}

export interface TmPrice {
  laborCents: number;
  laborHours: number;
  materialCents: number;
  equipmentCents: number;
  subcontractCents: number;
  otherCents: number;
  totalCents: number;
}

/** pm._cm_tm_price. OT defaults to 1.5× and DT to 2× the straight-time rate. */
export function priceTicket(lines: ReadonlyArray<TmLine>, rs: RateSheet): TmPrice {
  const out: TmPrice = { laborCents: 0, laborHours: 0, materialCents: 0, equipmentCents: 0, subcontractCents: 0, otherCents: 0, totalCents: 0 };
  const rateFor = (cls: string | null) =>
    rs.laborRates.find((x) => x.class.toLowerCase() === (cls ?? 'default').toLowerCase())
    ?? rs.laborRates.find((x) => x.class.toLowerCase() === 'default')
    ?? rs.laborRates[0];
  for (const l of lines) {
    if (l.kind === 'LABOR') {
      const rt = rateFor(l.laborClass);
      const st = rt?.st_cents ?? 0;
      const ot = rt?.ot_cents ?? roundCents(st * 1.5);
      const dt = rt?.dt_cents ?? st * 2;
      out.laborCents += roundCents(l.hoursSt * st + l.hoursOt * ot + l.hoursDt * dt);
      out.laborHours += l.hoursSt + l.hoursOt + l.hoursDt;
    } else if (l.kind === 'MATERIAL') {
      out.materialCents += roundCents((l.qty ?? 0) * (l.unitCostCents ?? 0) * (1 + rs.materialMarkupPct));
    } else if (l.kind === 'EQUIPMENT') {
      const er = rs.equipmentRates.find((x) => x.equipment.toLowerCase() === l.description.toLowerCase());
      out.equipmentCents += roundCents((l.equipmentHours ?? l.qty ?? 0) * (er?.hourly_cents ?? l.unitCostCents ?? 0) * (1 + rs.equipmentMarkupPct));
    } else if (l.kind === 'SUBCONTRACT') {
      out.subcontractCents += roundCents((l.qty ?? 1) * (l.unitCostCents ?? 0) * (1 + rs.subMarkupPct));
    } else {
      out.otherCents += roundCents((l.qty ?? 1) * (l.unitCostCents ?? 0));
    }
  }
  out.totalCents = out.laborCents + out.materialCents + out.equipmentCents + out.subcontractCents + out.otherCents;
  return out;
}

// ------------------------------------------------------------------ COI check (CGC-47)

export type Requirement =
  | 'GL_EACH_OCCURRENCE' | 'GL_AGGREGATE' | 'AUTO_COMBINED' | 'UMBRELLA' | 'WORKERS_COMP' | 'EMPLOYERS_LIABILITY' | 'PROFESSIONAL'
  | 'POLLUTION' | 'ADDITIONAL_INSURED_ONGOING' | 'ADDITIONAL_INSURED_COMPLETED' | 'WAIVER_OF_SUBROGATION' | 'PRIMARY_NONCONTRIBUTORY'
  | 'W9' | 'LICENSE' | 'PAYMENT_BOND' | 'PERFORMANCE_BOND' | 'EMR' | 'CERTIFIED_PAYROLL';

export interface CoiPolicy {
  type: string;
  expires?: string | null;
  each_occurrence_cents?: number | null;
  aggregate_cents?: number | null;
  limit_cents?: number | null;
}

export interface Coi {
  policies: ReadonlyArray<CoiPolicy>;
  endorsements: ReadonlyArray<string>;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  primaryNoncontributory: boolean;
  emr: number | null;
  w9OnFile: boolean;
  licenseNo: string | null;
  licenseExpires: string | null;
}

export interface CoiRequirement {
  requirement: Requirement;
  minLimitCents: number | null;
  maxValue: number | null;
  endorsementForms: ReadonlyArray<string>;
  required: boolean;
}

export interface CoiResult {
  requirement: Requirement;
  ok: boolean;
  required: boolean;
  detail: string | null;
}

const POLICY_OF: Partial<Record<Requirement, string>> = {
  GL_EACH_OCCURRENCE: 'GL', GL_AGGREGATE: 'GL', AUTO_COMBINED: 'AUTO', UMBRELLA: 'UMBRELLA', WORKERS_COMP: 'WC',
  EMPLOYERS_LIABILITY: 'EL', PROFESSIONAL: 'PROFESSIONAL', POLLUTION: 'POLLUTION',
};

const norm = (s: string) => s.trim().toUpperCase();

/** pm._cm_verify_coi per requirement (bonds and certified payroll are not on a certificate: skipped). */
export function checkCoi(coi: Coi, reqs: ReadonlyArray<CoiRequirement>, today: string): { status: 'VERIFIED' | 'DEFICIENT' | 'EXPIRED'; results: CoiResult[]; earliestExpiry: string | null } {
  const endorsements = new Set(coi.endorsements.map(norm));
  const results: CoiResult[] = [];
  for (const q of reqs) {
    const pType = POLICY_OF[q.requirement];
    let ok: boolean | null = null;
    let detail: string | null = null;
    if (pType) {
      let pol: CoiPolicy | undefined = coi.policies.filter((p) => p.type.toUpperCase() === pType).sort((a, b) => (b.expires ?? '').localeCompare(a.expires ?? ''))[0];
      if (!pol && q.requirement === 'EMPLOYERS_LIABILITY') pol = coi.policies.find((p) => p.type.toUpperCase() === 'WC');
      const lim = q.requirement === 'GL_AGGREGATE' ? pol?.aggregate_cents
        : q.requirement === 'GL_EACH_OCCURRENCE' ? pol?.each_occurrence_cents : (pol?.limit_cents ?? pol?.each_occurrence_cents);
      if (!pol) { ok = false; detail = `No ${pType} policy on the certificate.`; }
      else if (pol.expires && pol.expires < today) { ok = false; detail = `${pType} policy expired ${pol.expires}.`; }
      else if (q.minLimitCents != null && (lim ?? 0) < q.minLimitCents) {
        ok = false; detail = `${pType} limit ${Math.trunc((lim ?? 0) / 100)} below the required ${Math.trunc(q.minLimitCents / 100)}.`;
      } else ok = true;
    } else if (q.requirement === 'ADDITIONAL_INSURED_ONGOING' || q.requirement === 'ADDITIONAL_INSURED_COMPLETED') {
      const forms = q.endorsementForms.length ? q.endorsementForms.map(norm) : [q.requirement === 'ADDITIONAL_INSURED_ONGOING' ? 'CG 20 10' : 'CG 20 37'];
      const blanket = q.endorsementForms.length === 0 && endorsements.has(q.requirement === 'ADDITIONAL_INSURED_ONGOING' ? 'CG 20 38' : 'CG 20 40');
      const missing = forms.filter((f) => !endorsements.has(f));
      if (!coi.additionalInsured) { ok = false; detail = 'Additional insured not shown.'; }
      else if (missing.length && !blanket) { ok = false; detail = `Missing endorsement ${missing.join(', ')}.`; }
      else ok = true;
    } else if (q.requirement === 'WAIVER_OF_SUBROGATION') {
      ok = coi.waiverOfSubrogation && q.endorsementForms.map(norm).every((f) => endorsements.has(f));
      detail = !coi.waiverOfSubrogation ? 'Waiver of subrogation not shown.' : !ok ? `Missing endorsement ${q.endorsementForms.join(', ')}.` : null;
    } else if (q.requirement === 'PRIMARY_NONCONTRIBUTORY') {
      ok = coi.primaryNoncontributory && q.endorsementForms.map(norm).every((f) => endorsements.has(f));
      detail = ok ? null : 'Primary and non-contributory wording not shown.';
    } else if (q.requirement === 'W9') {
      ok = coi.w9OnFile; detail = ok ? null : 'No W-9 on file.';
    } else if (q.requirement === 'LICENSE') {
      ok = !!coi.licenseNo && (!coi.licenseExpires || coi.licenseExpires >= today);
      detail = !coi.licenseNo ? 'No license number.' : !ok ? `License expired ${coi.licenseExpires}.` : null;
    } else if (q.requirement === 'EMR') {
      ok = coi.emr !== null && coi.emr <= (q.maxValue ?? 1.0);
      detail = coi.emr === null ? 'No EMR given.' : !ok ? `EMR ${coi.emr} above ${q.maxValue ?? 1.0}.` : null;
    }
    if (ok !== null) results.push({ requirement: q.requirement, ok, required: q.required, detail });
  }
  const expiries = coi.policies.map((p) => p.expires).filter((x): x is string => !!x).sort();
  const earliest = expiries[0] ?? null;
  const status = earliest && earliest < today ? 'EXPIRED' : results.every((x) => x.ok || !x.required) ? 'VERIFIED' : 'DEFICIENT';
  return { status, results, earliestExpiry: earliest };
}

// ------------------------------------------------------------------ lien waivers (CGC-46)

export type WaiverType = 'CONDITIONAL_PROGRESS' | 'UNCONDITIONAL_PROGRESS' | 'CONDITIONAL_FINAL' | 'UNCONDITIONAL_FINAL';

/** States with statutory forms seeded in 1120 (Florida: unconditional progress / final only). */
export const STATUTORY_STATES: Readonly<Record<string, string>> = {
  CA: 'Cal. Civ. Code §§ 8132, 8134, 8136, 8138', TX: 'Tex. Prop. Code § 53.284', AZ: 'A.R.S. § 33-1008', GA: 'O.C.G.A. § 44-14-366',
  NV: 'NRS 108.2457', UT: 'Utah Code § 38-1a-802', MI: 'MCL 570.1115', MS: 'Miss. Code § 85-7-433', MA: 'M.G.L. c. 254 § 32',
  FL: 'Fla. Stat. § 713.20',
};

/** The form key pm._cm_request_waiver picks: the state's statutory form, else the generic one. */
export function waiverFormKey(state: string | null, type: WaiverType): string {
  if (state && STATUTORY_STATES[state] && (state !== 'FL' || type.startsWith('UNCONDITIONAL'))) return `${state}_${type}`;
  return `GENERIC_${type}`;
}

export function waiverDocType(type: WaiverType): 'LIEN_WAIVER_CONDITIONAL' | 'LIEN_WAIVER_UNCONDITIONAL' | 'LIEN_WAIVER_FINAL' {
  return type === 'CONDITIONAL_PROGRESS' ? 'LIEN_WAIVER_CONDITIONAL' : type === 'UNCONDITIONAL_PROGRESS' ? 'LIEN_WAIVER_UNCONDITIONAL' : 'LIEN_WAIVER_FINAL';
}
