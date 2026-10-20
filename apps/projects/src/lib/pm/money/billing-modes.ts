/**
 * Which billing generators a job offers, from its job type (pm.job_types.billing_modes,
 * default_billing_mode) and modules. Pure (unit-tested).
 *
 *   PROGRESS_PCT   → progress      pm.generate_progress_billing
 *   SOV            → sov           pm.generate_sov_billing (+ activate_sov_version / revise_sov)
 *   MILESTONE      → milestone     pm.generate_milestone_billing
 *   TIME_MATERIALS → tm            pm.generate_tm_billing
 *   FIXED          → fixed         manual request (MILESTONE / FIXED), member-insertable
 *   DEPOSIT        → deposit       pm.request_deposit
 *   retainage      → retainage     pm.request_retainage_release — the retainage module, or any
 *                                  mode that withholds retainage (SOV, progress, draws)
 *   allowances     → allowance     pm.close_allowance / pm.bill_allowance_overage
 *   DRAW           → draws page (lender draws are their own module)
 *   RECURRING      → service agreements (their own module)
 */
import { RETAINAGE_BILLING_MODES, type BillingMode, type ModuleKey } from '@/lib/packs';

export type BillingUiMode = 'progress' | 'sov' | 'milestone' | 'tm' | 'fixed' | 'deposit' | 'retainage' | 'allowance';

export const BILLING_UI_LABELS: Readonly<Record<BillingUiMode, string>> = {
  progress: 'Progress %',
  sov: 'Pay application',
  milestone: 'Milestones',
  tm: 'Time & materials',
  fixed: 'Fixed amount',
  deposit: 'Deposit',
  retainage: 'Retainage release',
  allowance: 'Allowances',
};

export const BILLING_UI_WHAT: Readonly<Record<BillingUiMode, string>> = {
  progress: 'Bill the revised contract to a percent complete, less what has already been billed.',
  sov: 'An AIA G702/G703 pay application from the schedule of values: work this period, stored materials and retainage by line.',
  milestone: 'Bill completed milestones at their billing amount or share of the contract. Each milestone bills once.',
  tm: 'Bill approved, billable time in a date range at its pinned bill rate. Time bills once.',
  fixed: 'A fixed amount with your own description, for contracts billed in set installments.',
  deposit: 'Ask Merit Books to invoice a deposit before work starts. It is held as a customer deposit until applied.',
  retainage: 'Release retainage held on earlier bills, in full at closeout or in part.',
  allowance: 'Close an allowance at its actual cost; an overage becomes a change order, then a bill.',
};

const FROM_MODE: ReadonlyArray<readonly [BillingMode, BillingUiMode]> = [
  ['PROGRESS_PCT', 'progress'],
  ['SOV', 'sov'],
  ['MILESTONE', 'milestone'],
  ['TIME_MATERIALS', 'tm'],
  ['FIXED', 'fixed'],
  ['DEPOSIT', 'deposit'],
];

const MODE_FOR_UI: Readonly<Partial<Record<BillingUiMode, BillingMode>>> = Object.fromEntries(FROM_MODE.map(([m, u]) => [u, m]));

export interface BillingModeInput {
  billingModes: ReadonlyArray<string>;
  defaultBillingMode?: string | null;
  modules: ReadonlySet<ModuleKey>;
}

export interface BillingModesResult {
  modes: BillingUiMode[];
  /** The mode to open first: the job type's default when it is offered. */
  initial: BillingUiMode | null;
  /** The job type bills through lender draws (link to the Draws page). */
  draws: boolean;
  /** The job type bills on a recurring agreement (link to service agreements). */
  recurring: boolean;
}

export function billingModesFor(i: BillingModeInput): BillingModesResult {
  const set = new Set(i.billingModes);
  const modes: BillingUiMode[] = [];
  for (const [m, ui] of FROM_MODE) if (set.has(m)) modes.push(ui);
  const withholds = RETAINAGE_BILLING_MODES.some((m) => set.has(m));
  if (i.modules.has('retainage') || withholds) modes.push('retainage');
  if (i.modules.has('allowances')) modes.push('allowance');

  // the default first, the rest in wire order
  const def = FROM_MODE.find(([m]) => m === i.defaultBillingMode)?.[1] ?? null;
  if (def && modes.includes(def)) {
    modes.splice(modes.indexOf(def), 1);
    modes.unshift(def);
  }
  return { modes, initial: modes[0] ?? null, draws: set.has('DRAW'), recurring: set.has('RECURRING') };
}

/** Whether a UI mode is allowed by the job type (server-side re-check before an RPC). */
export function modeAllowed(i: BillingModeInput, mode: BillingUiMode): boolean {
  return billingModesFor(i).modes.includes(mode);
}

/** The wire mode a UI mode comes from (null for retainage / allowance, which follow other modes). */
export function wireModeOf(mode: BillingUiMode): BillingMode | null {
  return MODE_FOR_UI[mode] ?? null;
}
