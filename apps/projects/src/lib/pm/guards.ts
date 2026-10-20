/**
 * Plain-words copy for the closed guard vocabulary (GUARDS in
 * @meritbooks/industry-packs, implemented as pm.guard_<name> in 1100).
 *
 *   need     — what a stage move needs, mid-sentence ("a customer")
 *   failing  — one human sentence when the guard blocks a move
 *   fix      — the verb and where to do it. `tab` = a job-page tab; `href` = a page.
 *
 * Pure (unit-tested: one entry per GUARDS name, nothing else).
 */
import { GUARDS, type GuardName } from '@/lib/packs';

export interface GuardCopy {
  need: string;
  failing: string;
  fix: { label: string; tab?: JobTab; href?: string };
}

export type JobTab =
  | 'overview' | 'estimates' | 'budget' | 'schedule' | 'change-orders' | 'contract' | 'activity'
  | 'commitments' | 'billing' | 'job-cost' | 'selections' | 'logs' | 'time' | 'documents'
  | 'work-orders' | 'production' | 'draws' | 'units' | 'punch';

export const GUARD_COPY: Readonly<Record<GuardName, GuardCopy>> = {
  has_customer: {
    need: 'a customer',
    failing: 'This job has no customer on file yet.',
    fix: { label: 'Choose the customer', tab: 'overview' },
  },
  has_contract_value: {
    need: 'a contract value',
    failing: 'There is no active contract with a value above zero.',
    fix: { label: 'Set the contract', tab: 'contract' },
  },
  has_budget: {
    need: 'a budget',
    failing: 'The original budget has no lines yet.',
    fix: { label: 'Build the budget', tab: 'budget' },
  },
  estimate_accepted: {
    need: 'an accepted estimate',
    failing: 'No estimate for this job has been accepted.',
    fix: { label: 'Open the estimate', tab: 'estimates' },
  },
  deposit_requested: {
    need: 'a deposit request',
    failing: 'The deposit has not been requested from the customer.',
    fix: { label: 'Request the deposit', tab: 'billing' },
  },
  selections_approved: {
    need: 'every selection approved',
    failing: 'Some selections are still waiting on the customer.',
    fix: { label: 'Open selections', tab: 'selections' },
  },
  no_open_change_orders: {
    need: 'no open change orders',
    failing: 'Change orders are still open; approve, reject or void them first.',
    fix: { label: 'Review change orders', tab: 'change-orders' },
  },
  punch_complete: {
    need: 'the punch list closed',
    failing: 'Punch list items are still open.',
    fix: { label: 'Open the punch list', href: '/punch-list' },
  },
  final_billed: {
    need: 'the contract fully billed',
    failing: 'Billing to date is below the revised contract.',
    fix: { label: 'Open billing', tab: 'billing' },
  },
  compliance_current: {
    need: 'compliance documents current',
    failing: 'A required certificate or lien waiver has expired.',
    fix: { label: 'Open commitments', tab: 'commitments' },
  },
  work_orders_closed: {
    need: 'every work order closed',
    failing: 'Work orders on this job are still open.',
    fix: { label: 'Open work orders', href: '/work-orders' },
  },
  production_complete: {
    need: 'production complete',
    failing: 'Shop operations on this job are not complete.',
    fix: { label: 'Open production', href: '/production' },
  },
};

export function isGuardName(name: string): name is GuardName {
  return (GUARDS as readonly string[]).includes(name);
}

/** Copy for a guard the database returned; unknown names still get a sentence. */
export function guardCopy(name: string): GuardCopy {
  if (isGuardName(name)) return GUARD_COPY[name];
  return { need: name.replace(/_/g, ' '), failing: `A check (${name.replace(/_/g, ' ')}) is not met yet.`, fix: { label: 'Open the job', tab: 'overview' } };
}

/** "Needs a customer, a contract value and a budget." — for stage machines in Settings. */
export function guardsSentence(guards: ReadonlyArray<string>): string {
  if (guards.length === 0) return 'No checks.';
  const parts = guards.map((g) => guardCopy(g).need);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Needs ${list}.`;
}

/** Link for a guard's fix, relative to a job. */
export function guardFixHref(name: string, jobId: string): string {
  const { fix } = guardCopy(name);
  if (fix.href) return fix.href;
  return `/jobs/${jobId}?tab=${fix.tab ?? 'overview'}`;
}
