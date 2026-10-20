/** Job page tabs, driven by the job type's modules (blueprint §4). Pure. */
import type { ModuleKey } from '@/lib/packs';
import type { JobTab } from './guards';
import type { Vocabulary } from './vocab';
import { woVocab } from '@/lib/pm/ops/labels';

export interface TabDef {
  value: JobTab;
  label: string;
  /** Arrives in a later wave: honest placeholder, no fake data. */
  later?: boolean;
}

/**
 * Money tabs (estimates, commitments, billing, job cost) are live. Billing carries the
 * retainage release when the job type withholds retainage or uses the retainage module;
 * Job cost needs budgets by cost code.
 */
export function jobTabs(modules: ReadonlySet<ModuleKey>, v: Vocabulary): TabDef[] {
  const t: TabDef[] = [{ value: 'overview', label: 'Overview' }];
  if (modules.has('estimates')) t.push({ value: 'estimates', label: v.estimate });
  if (modules.has('budget')) t.push({ value: 'budget', label: 'Budget' });
  if (modules.has('schedule')) t.push({ value: 'schedule', label: 'Schedule' });
  if (modules.has('change_orders')) t.push({ value: 'change-orders', label: v.change_orders });
  t.push({ value: 'contract', label: 'Contract' });
  if (modules.has('commitments')) t.push({ value: 'commitments', label: v.commitments });
  if (modules.has('billing') || modules.has('retainage')) t.push({ value: 'billing', label: v.billing });
  if (modules.has('budget')) t.push({ value: 'job-cost', label: 'Job cost' });
  if (modules.has('dispatch')) t.push({ value: 'work-orders', label: woVocab(v).many });
  if (modules.has('production')) t.push({ value: 'production', label: 'Production' });
  if (modules.has('selections') || modules.has('procurement_markup')) t.push({ value: 'selections', label: v.selections });
  if (modules.has('lender_draws')) t.push({ value: 'draws', label: v.draws });
  if (modules.has('lots_units')) t.push({ value: 'units', label: 'Lots and units' });
  if (modules.has('daily_logs')) t.push({ value: 'logs', label: v.daily_logs });
  if (modules.has('punch_warranty')) t.push({ value: 'punch', label: 'Punch list' });
  if (modules.has('time')) t.push({ value: 'time', label: 'Time' });
  if (modules.has('documents')) t.push({ value: 'documents', label: 'Documents', later: true });
  t.push({ value: 'activity', label: 'Activity' });
  return t;
}

export function pickTab(tabs: ReadonlyArray<TabDef>, requested: string | undefined): TabDef {
  return tabs.find((t) => t.value === requested) ?? tabs[0]!;
}
