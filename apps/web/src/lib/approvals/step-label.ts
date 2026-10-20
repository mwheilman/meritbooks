/**
 * Plain-English labels for workflow-step approvers (05 R-12). Pure; safe in client code.
 *
 *   role step        → "Accounting Manager"
 *   capability step  → "Anyone who can approve bills" / "… up to at least $10,000"
 */

import { formatMoney } from '@meritbooks/shared';
import { CAPABILITY_BY_KEY, parseCapabilityRef } from '@/lib/rbac/capabilities';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import type { WorkflowDocType, WorkflowStepDef } from './workflow';

/** The capability each document type is approved on (05 §2.3 map; mig 165 backfill). */
export const DOC_TYPE_APPROVE_CAPABILITY: Record<WorkflowDocType, string> = {
  BILL: 'ap.bills:approve',
  JOURNAL_ENTRY: 'gl.journal_entries:approve',
  PAYMENT: 'pay.batches:approve',
  EXPENSE: 'exp.reports:approve',
  PAYROLL: 'payroll.runs:approve',
};

const ACTION_VERB: Record<string, string> = { approve: 'approve', post: 'post', release: 'release' };

/** "approve bills", "release payment runs" — lower-case phrase for a capability ref. */
export function capabilityPhrase(ref: string): string {
  const parsed = parseCapabilityRef(ref);
  if (!parsed) return ref;
  const label = CAPABILITY_BY_KEY.get(parsed.key)?.label ?? parsed.key;
  return `${ACTION_VERB[parsed.action] ?? parsed.action} ${label.toLowerCase()}`;
}

export function roleLabel(role: string): string {
  return ROLE_DEFINITIONS[role as UserRole]?.label ?? role;
}

/** Who can satisfy a step, in one plain line. */
export function stepApproverLabel(step: Pick<WorkflowStepDef, 'approverRole' | 'approverCapability' | 'minApproverLimitCents'>): string {
  if (step.approverRole) return roleLabel(step.approverRole);
  if (!step.approverCapability) return 'No approver set';
  const base = `Anyone who can ${capabilityPhrase(step.approverCapability)}`;
  const floor = step.minApproverLimitCents ?? null;
  return floor && floor > 0 ? `${base}, with a limit of at least ${formatMoney(floor)}` : base;
}
