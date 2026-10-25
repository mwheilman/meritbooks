/**
 * "Needs attention" on a job (UX seat §3d Overview, first block): at most five items, each with
 * the evidence that raised it and one action. Rule-based checks, not AI — the screen labels them
 * that way. Pure (unit-tested); the page feeds it what it already loaded.
 */
import { guardCopy, guardFixHref } from '@/lib/pm/guards';

export interface AttentionInputs {
  jobId: string;
  /** The next forward stage and the checks it fails (pm.check_guards). */
  nextStage: { label: string; failing: ReadonlyArray<string> } | null;
  pendingCoCount: number;
  overdueTasks: number;
  hasBudgetModule: boolean;
  hasBudget: boolean;
  draftBilling: number;
  draftCommitments: number;
  punchOpen: number;
  /** Contract below cost (only passed when the caller sees both sides). */
  overContract: boolean | null;
  vocab: { change_orders: string; billing: string; commitments: string };
  /** Tabs this job has (an action never links to a tab the caller can't open). */
  hasTab: (tab: string) => boolean;
}

export interface AttentionItem {
  id: string;
  title: string;
  evidence: string;
  action: { label: string; href: string };
  tone: 'neg' | 'warn' | 'info';
}

export const MAX_ATTENTION = 5;

export function jobAttention(i: AttentionInputs): AttentionItem[] {
  const base = `/jobs/${i.jobId}`;
  const tab = (t: string) => (i.hasTab(t) ? `${base}?tab=${t}` : base);
  const out: AttentionItem[] = [];
  if (i.nextStage && i.nextStage.failing.length) {
    const first = i.nextStage.failing[0]!;
    out.push({
      id: 'stage', tone: 'warn',
      title: `Not ready for ${i.nextStage.label}`,
      evidence: i.nextStage.failing.map((g) => guardCopy(g).failing).join(' '),
      action: { label: guardCopy(first).fix.label, href: guardFixHref(first, i.jobId) },
    });
  }
  if (i.overContract) {
    out.push({ id: 'margin', tone: 'neg', title: 'Cost is over the contract', evidence: 'The projected cost is above the revised contract.', action: { label: 'Open job cost', href: tab('job-cost') } });
  }
  if (i.overdueTasks > 0) {
    out.push({ id: 'overdue', tone: 'warn', title: `${i.overdueTasks} ${i.overdueTasks === 1 ? 'task is' : 'tasks are'} overdue`, evidence: 'Past the due date and not done.', action: { label: 'Open the schedule', href: tab('schedule') } });
  }
  if (i.pendingCoCount > 0) {
    out.push({ id: 'co', tone: 'info', title: `${i.pendingCoCount} pending ${i.vocab.change_orders.toLowerCase()}`, evidence: 'Not in the contract until approved.', action: { label: 'Review', href: tab('change-orders') } });
  }
  if (i.hasBudgetModule && !i.hasBudget) {
    out.push({ id: 'budget', tone: 'warn', title: 'No budget yet', evidence: 'Cost tracking and margin need an original budget.', action: { label: 'Build the budget', href: tab('budget') } });
  }
  if (i.draftBilling > 0) {
    out.push({ id: 'billing', tone: 'info', title: `${i.draftBilling} ${i.vocab.billing.toLowerCase()} ${i.draftBilling === 1 ? 'draft' : 'drafts'} not sent`, evidence: 'Draft or sent back for changes.', action: { label: 'Open billing', href: tab('billing') } });
  }
  if (i.draftCommitments > 0) {
    out.push({ id: 'po', tone: 'info', title: `${i.draftCommitments} draft ${i.vocab.commitments.toLowerCase()}`, evidence: 'Not issued to the vendor yet.', action: { label: 'Open', href: tab('commitments') } });
  }
  if (i.punchOpen > 0) {
    out.push({ id: 'punch', tone: 'info', title: `${i.punchOpen} open punch ${i.punchOpen === 1 ? 'item' : 'items'}`, evidence: 'Open on this job.', action: { label: 'Open punch', href: tab('punch') } });
  }
  return out.slice(0, MAX_ATTENTION);
}
