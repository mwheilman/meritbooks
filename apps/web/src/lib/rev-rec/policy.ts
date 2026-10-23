/**
 * Revenue-recognition POLICY — the company's visible election (FPB-rev-rec-wip §3). PURE.
 *
 * The method itself lives where it always has (core.locations.rev_rec_method, the job-type
 * map, the job override — resolved by lib/services/rev-rec.ts). This module owns the
 * switches migration 179 adds and their inheritance:
 *
 *   job override  →  job-type rule  →  company policy  →  default
 *
 * for `accrue_underbillings` and `defer_overbillings` (nullable at the job and job-type
 * level = "inherits"). `exclude_from_wip` is job-only. Everything else is company-only.
 */

import type { RevRecMethod } from '@/lib/services/rev-rec';

export type RunCadence = 'MONTHLY_AT_CLOSE' | 'ON_DEMAND';
export type PostingMode = 'PROPOSE' | 'AUTO_POST';
export type RetainagePresentation = 'SEPARATE' | 'INCLUDED_IN_AR';

export const RUN_CADENCES: readonly RunCadence[] = ['MONTHLY_AT_CLOSE', 'ON_DEMAND'];
export const POSTING_MODES: readonly PostingMode[] = ['PROPOSE', 'AUTO_POST'];
export const RETAINAGE_PRESENTATIONS: readonly RetainagePresentation[] = ['SEPARATE', 'INCLUDED_IN_AR'];

export const REV_REC_METHODS: readonly RevRecMethod[] = [
  'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'MILESTONE', 'AS_BILLED',
  'POINT_OF_SALE', 'RATABLY', 'SUBSCRIPTION', 'CASH',
];

/** The company policy (one row of public.rev_rec_policies, or the defaults). */
export interface CompanyRevRecPolicy {
  accrueUnderbillings: boolean;
  deferOverbillings: boolean;
  lossProvision: boolean;
  runCadence: RunCadence;
  postingMode: PostingMode;
  materialityCents: number;
  retainagePresentation: RetainagePresentation;
}

export const DEFAULT_POLICY: Readonly<CompanyRevRecPolicy> = {
  accrueUnderbillings: true,
  deferOverbillings: true,
  lossProvision: true, // GAAP: recognize the full anticipated loss as soon as it is known
  runCadence: 'MONTHLY_AT_CLOSE',
  postingMode: 'PROPOSE',
  materialityCents: 0,
  retainagePresentation: 'SEPARATE',
};

/** The DB row shape (snake_case) → policy. Unknown / missing values fall back to the defaults. */
export interface RevRecPolicyRow {
  accrue_underbillings?: boolean | null;
  defer_overbillings?: boolean | null;
  loss_provision?: boolean | null;
  run_cadence?: string | null;
  posting_mode?: string | null;
  materiality_cents?: number | string | null;
  retainage_presentation?: string | null;
}

export function policyFromRow(row: RevRecPolicyRow | null | undefined): CompanyRevRecPolicy {
  if (!row) return { ...DEFAULT_POLICY };
  const pick = <T extends string>(v: string | null | undefined, allowed: readonly T[], d: T): T =>
    v && (allowed as readonly string[]).includes(v) ? (v as T) : d;
  const m = Number(row.materiality_cents ?? 0);
  return {
    accrueUnderbillings: row.accrue_underbillings ?? DEFAULT_POLICY.accrueUnderbillings,
    deferOverbillings: row.defer_overbillings ?? DEFAULT_POLICY.deferOverbillings,
    lossProvision: row.loss_provision ?? DEFAULT_POLICY.lossProvision,
    runCadence: pick(row.run_cadence, RUN_CADENCES, DEFAULT_POLICY.runCadence),
    postingMode: pick(row.posting_mode, POSTING_MODES, DEFAULT_POLICY.postingMode),
    materialityCents: Number.isFinite(m) && m > 0 ? Math.round(m) : 0,
    retainagePresentation: pick(row.retainage_presentation, RETAINAGE_PRESENTATIONS, DEFAULT_POLICY.retainagePresentation),
  };
}

/** Nullable switch overrides (job-type rule or job override). null/undefined = inherits. */
export interface SwitchOverride {
  accrueUnderbillings?: boolean | null;
  deferOverbillings?: boolean | null;
}

export type PolicySource = 'JOB' | 'JOB_TYPE' | 'COMPANY' | 'DEFAULT';

export interface ResolvedJobPolicy {
  accrueUnderbillings: boolean;
  deferOverbillings: boolean;
  excluded: boolean;
  source: { accrueUnderbillings: PolicySource; deferOverbillings: PolicySource };
}

/**
 * Resolve one job's switches: job → job type → company → default. `companyRowExists`
 * distinguishes "the company chose this" from "nobody chose; this is the default" for the
 * "inherits from company" display.
 */
export function resolveJobPolicy(args: {
  company: CompanyRevRecPolicy;
  companyRowExists: boolean;
  jobType?: SwitchOverride | null;
  job?: (SwitchOverride & { excludeFromWip?: boolean | null }) | null;
}): ResolvedJobPolicy {
  const companySource: PolicySource = args.companyRowExists ? 'COMPANY' : 'DEFAULT';
  const one = (key: 'accrueUnderbillings' | 'deferOverbillings'): [boolean, PolicySource] => {
    const j = args.job?.[key];
    if (j != null) return [j, 'JOB'];
    const t = args.jobType?.[key];
    if (t != null) return [t, 'JOB_TYPE'];
    return [args.company[key], companySource];
  };
  const [accrue, accrueSrc] = one('accrueUnderbillings');
  const [defer, deferSrc] = one('deferOverbillings');
  return {
    accrueUnderbillings: accrue,
    deferOverbillings: defer,
    excluded: args.job?.excludeFromWip === true,
    source: { accrueUnderbillings: accrueSrc, deferOverbillings: deferSrc },
  };
}

/** Plain-English source label for the "inherits from company" display. */
export function sourceLabel(src: PolicySource): string {
  switch (src) {
    case 'JOB': return 'Set on this job';
    case 'JOB_TYPE': return 'From the job type';
    case 'COMPANY': return 'Inherits from company';
    case 'DEFAULT': return 'Inherits from company (default)';
  }
}

/** Methods for which a construction-type loss provision applies (fixed-price contracts). */
export function isContractMethod(m: RevRecMethod): boolean {
  return m === 'PCT_COSTS_INCURRED' || m === 'PCT_COMPLETE' || m === 'COMPLETED_CONTRACT' || m === 'MILESTONE';
}

/** Owner wording for each method (the election card). */
export const METHOD_COPY: Readonly<Record<RevRecMethod, { label: string; short: string; who: string }>> = {
  PCT_COSTS_INCURRED: {
    label: 'Percent complete — by cost (recommended for contractors)',
    short: 'Revenue is earned as costs come in: costs to date ÷ estimated total cost.',
    who: 'Construction, HVAC, remodeling, long fixed-price jobs.',
  },
  PCT_COMPLETE: {
    label: 'Percent complete — by measured progress',
    short: 'Revenue is earned by surveyed physical progress (the % your project manager reports).',
    who: 'Jobs where cost is a poor measure of progress.',
  },
  COMPLETED_CONTRACT: {
    label: 'Completed contract',
    short: 'Nothing is earned until the job is finished; all billings wait as a liability until then.',
    who: 'Short or uncertain jobs.',
  },
  MILESTONE: {
    label: 'Milestones',
    short: 'Each accepted milestone earns its share of the contract.',
    who: 'Design, engineering and staged projects.',
  },
  AS_BILLED: {
    label: 'As billed (time & materials)',
    short: 'Revenue equals what you bill — nothing to accrue.',
    who: 'T&M and open-ended service work.',
  },
  POINT_OF_SALE: {
    label: 'At the point of sale',
    short: 'Revenue is earned when you invoice or ring the sale.',
    who: 'Retail, parts counters, one-time service calls.',
  },
  RATABLY: {
    label: 'Straight-line over the term',
    short: 'Revenue is spread evenly from the start date to the end date.',
    who: 'Retainers and fixed-term service agreements.',
  },
  SUBSCRIPTION: {
    label: 'Subscription (ratable)',
    short: 'Each period earns its share of the subscription.',
    who: 'Maintenance plans, memberships, SaaS.',
  },
  CASH: {
    label: 'When cash is collected',
    short: 'Revenue is earned only when the customer pays.',
    who: 'Cash-basis books.',
  },
};
