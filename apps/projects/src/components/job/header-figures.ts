/**
 * The job header's four figures by money level (UX seat §3d row 2; Wave 0a spec §2.3). Pure.
 *
 *   level 3–4 with both sides   Contract · Billed · Cost · Margin   (each links to its breakdown)
 *   contract only (office)      Contract · Billed · Pending changes · Open tasks
 *   cost only (purchasing)      Budget · Committed · Cost · Open tasks
 *   no dollars (level ≤ 2)      Stage · Open tasks · Overdue · Punch open   (hours and counts)
 *
 * A figure the caller may not see is never drawn as $0: the slot carries a count instead.
 */
import type { MoneyVis } from '@/components/money/visibility';
import { seesMargin } from '@/components/money/visibility';

export interface HeaderMoneyInputs {
  revisedContractCents: number;
  originalContractCents: number;
  billedCents: number | null;
  /** Actual cost to date (job cost). */
  costToDateCents: number | null;
  /** Projected final cost (or the cost estimate when no forecast exists). */
  projectedCostCents: number;
  committedCents: number | null;
  budgetCents: number | null;
  projectedMarginCents: number;
  pendingCoCents: number;
  pendingCoCount: number;
  openTasks: number;
  overdueTasks: number;
  punchOpen: number;
  stageLabel: string;
}

export interface HeaderFigure {
  key: 'contract' | 'billed' | 'cost' | 'margin' | 'budget' | 'committed' | 'pending' | 'tasks' | 'overdue' | 'punch' | 'stage';
  label: string;
  kind: 'money' | 'pct' | 'count' | 'text';
  /** cents for money; ratio 0..1 for pct; integer for count. */
  value: number | string | null;
  sub: string | null;
  href: string;
  tone?: 'neg' | 'warn';
}

/** `hasTab` (optional): a figure whose breakdown tab this job doesn't have links to the job itself. */
export function headerFigures(i: HeaderMoneyInputs, mv: MoneyVis, base: string, hasTab?: (tab: string) => boolean): HeaderFigure[] {
  const at = (tab: string) => (!hasTab || hasTab(tab) ? `${base}?tab=${tab}` : base);
  const tasks: HeaderFigure = { key: 'tasks', label: 'Open tasks', kind: 'count', value: i.openTasks, sub: i.overdueTasks ? `${i.overdueTasks} overdue` : null, href: at('schedule'), tone: i.overdueTasks ? 'warn' : undefined };
  if (seesMargin(mv)) {
    const pct = i.revisedContractCents > 0 ? i.projectedMarginCents / i.revisedContractCents : null;
    return [
      { key: 'contract', label: 'Contract', kind: 'money', value: i.revisedContractCents, sub: i.revisedContractCents !== i.originalContractCents ? 'Revised' : 'Original', href: at('contract') },
      { key: 'billed', label: 'Billed', kind: 'money', value: i.billedCents, sub: i.billedCents != null && i.revisedContractCents > 0 ? `${Math.round((i.billedCents / i.revisedContractCents) * 100)}% of contract` : null, href: at('billing') },
      { key: 'cost', label: 'Cost', kind: 'money', value: i.costToDateCents ?? i.projectedCostCents, sub: i.costToDateCents != null ? 'To date' : 'Estimated', href: at('job-cost') },
      { key: 'margin', label: 'Margin', kind: 'pct', value: pct, sub: `${i.projectedMarginCents < 0 ? 'Loss' : 'Projected'}`, href: at('budget'), tone: i.projectedMarginCents < 0 ? 'neg' : undefined },
    ];
  }
  if (mv.contract) {
    return [
      { key: 'contract', label: 'Contract', kind: 'money', value: i.revisedContractCents, sub: i.revisedContractCents !== i.originalContractCents ? 'Revised' : 'Original', href: at('contract') },
      { key: 'billed', label: 'Billed', kind: 'money', value: i.billedCents, sub: null, href: at('billing') },
      { key: 'pending', label: 'Pending changes', kind: 'money', value: i.pendingCoCents, sub: `${i.pendingCoCount} open`, href: at('change-orders') },
      tasks,
    ];
  }
  if (mv.cost) {
    return [
      { key: 'budget', label: 'Budget', kind: 'money', value: i.budgetCents, sub: i.budgetCents == null ? 'No budget yet' : null, href: at('budget') },
      { key: 'committed', label: 'Committed', kind: 'money', value: i.committedCents, sub: null, href: at('commitments') },
      { key: 'cost', label: 'Cost', kind: 'money', value: i.costToDateCents ?? i.projectedCostCents, sub: i.costToDateCents != null ? 'To date' : 'Estimated', href: at('job-cost') },
      tasks,
    ];
  }
  return [
    { key: 'stage', label: 'Stage', kind: 'text', value: i.stageLabel, sub: null, href: at('activity') },
    tasks,
    { key: 'overdue', label: 'Overdue', kind: 'count', value: i.overdueTasks, sub: 'Tasks past due', href: at('schedule'), tone: i.overdueTasks ? 'warn' : undefined },
    { key: 'punch', label: 'Punch open', kind: 'count', value: i.punchOpen, sub: null, href: at('punch') },
  ];
}
