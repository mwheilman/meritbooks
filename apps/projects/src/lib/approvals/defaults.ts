/**
 * Default approval tiers by company size (seat 06 §2c rule 4) — the client mirror of
 * pm.approval_default_rules() in 1113_pm_approvals.sql. A parity test
 * (packages/projects-access/test/approvals.test.ts) fails when the two drift.
 *
 * A tier names the LOWEST role that may approve; higher roles on the same ladder may too.
 * Amounts are integer cents, `max` inclusive (null = no ceiling). `commitment` rows seed both
 * commitment and commitment_change. set ANY = any holder of the object's approve capability.
 */
import type { ApprovalObjectType, RuleCondition, SizeBucket } from './types';

export type RoleSet = 'ANY' | 'OWNER' | 'GM' | 'SALES_MGR' | 'PM' | 'PUR' | 'FOREMAN' | 'PA' | 'CONTROLLER' | 'PAYROLL';
export type DefaultObjectType = Exclude<ApprovalObjectType, 'commitment_change' | 'stage_transition'>;

export interface DefaultRule {
  size: SizeBucket;
  object_type: DefaultObjectType;
  min: number;
  max: number | null;
  step: number;
  set: RoleSet;
  condition: RuleCondition | null;
  distinct: boolean;
  due_days: number;
}

// BEGIN APPROVAL DEFAULTS (keep identical to pm.approval_default_rules())
export const DEFAULT_RULES: readonly DefaultRule[] = [
  { size: 'xs', object_type: 'commitment', min: 0, max: 1000000, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'commitment', min: 1000001, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'commitment', min: 0, max: null, step: 2, set: 'OWNER', condition: 'over_budget', distinct: false, due_days: 2 },
  { size: 's', object_type: 'commitment', min: 0, max: 1000000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'commitment', min: 1000001, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'commitment', min: 0, max: null, step: 2, set: 'OWNER', condition: 'over_budget', distinct: false, due_days: 2 },
  { size: 'm', object_type: 'commitment', min: 0, max: 250000, step: 1, set: 'PUR', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'commitment', min: 250001, max: 2500000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'commitment', min: 2500001, max: 10000000, step: 1, set: 'GM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'commitment', min: 10000001, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'commitment', min: 0, max: null, step: 2, set: 'GM', condition: 'over_budget', distinct: false, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 0, max: 500000, step: 1, set: 'PUR', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 500001, max: 5000000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 5000001, max: 25000000, step: 1, set: 'GM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 25000001, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 0, max: null, step: 2, set: 'GM', condition: 'over_budget', distinct: false, due_days: 2 },
  { size: 'l', object_type: 'commitment', min: 5000001, max: null, step: 3, set: 'CONTROLLER', condition: 'over_budget', distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'change_order', min: 0, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'change_order', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'change_order', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'change_order', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'l', object_type: 'change_order', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'change_order', min: 5000001, max: null, step: 2, set: 'GM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'change_order', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'estimate', min: 0, max: null, step: 1, set: 'OWNER', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 's', object_type: 'estimate', min: 0, max: null, step: 1, set: 'OWNER', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'm', object_type: 'estimate', min: 0, max: null, step: 1, set: 'GM', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'l', object_type: 'estimate', min: 0, max: null, step: 1, set: 'SALES_MGR', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'l', object_type: 'estimate', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'dealer_deal', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 1 },
  { size: 'xs', object_type: 'dealer_deal', min: 0, max: null, step: 2, set: 'OWNER', condition: 'below_margin_floor', distinct: false, due_days: 1 },
  { size: 's', object_type: 'dealer_deal', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 1 },
  { size: 's', object_type: 'dealer_deal', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: false, due_days: 1 },
  { size: 'm', object_type: 'dealer_deal', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 1 },
  { size: 'm', object_type: 'dealer_deal', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: false, due_days: 1 },
  { size: 'l', object_type: 'dealer_deal', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 1 },
  { size: 'l', object_type: 'dealer_deal', min: 0, max: null, step: 2, set: 'GM', condition: 'below_margin_floor', distinct: false, due_days: 1 },
  { size: 'xs', object_type: 'budget_transfer', min: 0, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'budget_transfer', min: 0, max: 500000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'budget_transfer', min: 500001, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'budget_transfer', min: 0, max: 500000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'budget_transfer', min: 500001, max: null, step: 1, set: 'GM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'budget_transfer', min: 0, max: 500000, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'budget_transfer', min: 500001, max: null, step: 1, set: 'GM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'budget_transfer', min: 5000001, max: null, step: 2, set: 'CONTROLLER', condition: null, distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'time_entry', min: 0, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'time_entry', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'time_entry', min: 0, max: null, step: 1, set: 'FOREMAN', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'time_entry', min: 0, max: null, step: 2, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'time_entry', min: 0, max: null, step: 1, set: 'FOREMAN', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'time_entry', min: 0, max: null, step: 2, set: 'PM', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'time_entry', min: 0, max: null, step: 3, set: 'GM', condition: 'overtime', distinct: true, due_days: 2 },
  { size: 'xs', object_type: 'draw', min: 0, max: null, step: 1, set: 'OWNER', condition: null, distinct: true, due_days: 3 },
  { size: 's', object_type: 'draw', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 3 },
  { size: 's', object_type: 'draw', min: 0, max: null, step: 2, set: 'OWNER', condition: null, distinct: true, due_days: 3 },
  { size: 'm', object_type: 'draw', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 3 },
  { size: 'm', object_type: 'draw', min: 0, max: null, step: 2, set: 'PA', condition: null, distinct: true, due_days: 3 },
  { size: 'm', object_type: 'draw', min: 0, max: null, step: 3, set: 'OWNER', condition: null, distinct: true, due_days: 3 },
  { size: 'l', object_type: 'draw', min: 0, max: null, step: 1, set: 'PM', condition: null, distinct: true, due_days: 3 },
  { size: 'l', object_type: 'draw', min: 0, max: null, step: 2, set: 'PA', condition: null, distinct: true, due_days: 3 },
  { size: 'l', object_type: 'draw', min: 0, max: null, step: 3, set: 'OWNER', condition: null, distinct: true, due_days: 3 },
  { size: 'xs', object_type: 'billing_request', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 2 },
  { size: 's', object_type: 'billing_request', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 2 },
  { size: 'm', object_type: 'billing_request', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 2 },
  { size: 'l', object_type: 'billing_request', min: 0, max: null, step: 1, set: 'ANY', condition: null, distinct: true, due_days: 2 },];
// END APPROVAL DEFAULTS

/** Mirror of pm.approval_role_set(). */
export const ROLE_SETS: Readonly<Record<RoleSet, readonly string[]>> = {
  ANY: [],
  OWNER: ['projects_owner'],
  GM: ['projects_gm', 'projects_owner'],
  SALES_MGR: ['projects_gm', 'projects_owner'],
  PM: ['projects_pm', 'projects_gm', 'projects_owner'],
  PUR: ['projects_purchasing', 'projects_pm', 'projects_gm', 'projects_owner'],
  FOREMAN: ['projects_supervisor', 'projects_pm', 'projects_gm', 'projects_owner'],
  PA: ['projects_project_accountant', 'projects_owner'],
  CONTROLLER: ['projects_project_accountant', 'projects_owner'],
  PAYROLL: ['projects_payroll_admin', 'projects_owner'],
};

/** Mirror of pm.approval_set_label(). */
export const SET_LABELS: Readonly<Record<RoleSet, string>> = {
  ANY: 'Any approver',
  OWNER: 'Owner',
  GM: 'General manager',
  SALES_MGR: 'Sales manager',
  PM: 'Project manager',
  PUR: 'Purchasing',
  FOREMAN: 'Foreman',
  PA: 'Project accountant',
  CONTROLLER: 'Controller',
  PAYROLL: 'Payroll',
};

export const SIZE_LABELS: Readonly<Record<SizeBucket, string>> = {
  xs: '5 people or fewer',
  s: '6 to 20 people',
  m: '21 to 50 people',
  l: 'More than 50 people',
};

/** Mirror of pm.approval_size_for_count(). */
export function sizeForCount(people: number): SizeBucket {
  if (people <= 5) return 'xs';
  if (people <= 20) return 's';
  if (people <= 50) return 'm';
  return 'l';
}

export interface ChainStep {
  step: number;
  set: RoleSet;
  label: string;
  condition: RuleCondition | null;
  distinct: boolean;
}

export type ChainFacts = Partial<Record<RuleCondition, boolean>>;

/**
 * The default chain for an object at a size, amount and facts — the same selection the engine
 * makes from seeded rules (pm._approval_build_chain): band inclusive, conditional rules only when
 * their fact holds, base rules first within a step, consecutive identical approvers collapsed.
 * Used to preview tiers in settings; the database decides.
 */
export function defaultChain(size: SizeBucket, objectType: ApprovalObjectType, amountCents: number, facts: ChainFacts = {}): ChainStep[] {
  const seedType: DefaultObjectType | null =
    objectType === 'commitment_change' ? 'commitment' : objectType === 'stage_transition' ? null : objectType;
  if (!seedType) return [];
  const amount = Math.max(0, Math.round(amountCents));
  const rules = DEFAULT_RULES
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.size === size && r.object_type === seedType && amount >= r.min && (r.max === null || amount <= r.max)
      && (r.condition === null || facts[r.condition] === true))
    .sort((a, b) => a.r.step - b.r.step || Number(a.r.condition !== null) - Number(b.r.condition !== null) || a.i - b.i);
  const out: ChainStep[] = [];
  let prev: string | null = null;
  for (const { r } of rules) {
    const key = `${SET_LABELS[r.set]}|${r.set === 'ANY' ? 'cap' : ''}|${ROLE_SETS[r.set].join(',')}`;
    if (key === prev) continue;
    prev = key;
    out.push({ step: out.length + 1, set: r.set, label: SET_LABELS[r.set], condition: r.condition, distinct: r.distinct });
  }
  return out;
}
