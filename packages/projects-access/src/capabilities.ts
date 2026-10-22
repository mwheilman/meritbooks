/**
 * MERIT PROJECTS CAPABILITY REGISTRY — the code source of truth for the `projects.*`
 * capabilities (docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md §2.1).
 *
 * Same field shape as the Books registry (apps/web/src/lib/rbac/capabilities.ts), with
 * `module: 'projects'`. Mirrored to `core.capabilities` by migration 1110_pm_access.sql
 * (GENERATED block — scripts/generate-seed.ts). A guard test replays every migration and
 * fails if the DB mirror and this registry differ.
 *
 * PURE: no I/O.
 */

export const ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'post',
  'release',
  'export',
  'configure',
] as const;
export type Action = (typeof ACTIONS)[number];

export type CapabilityTag = 'money' | 'sensitive' | 'locked' | 'group';
export type FieldClass = 'comp' | 'tin' | 'bank' | 'personal' | 'secrets';
export type ConstraintKind =
  | 'amount_limit'
  | 'dimension_restriction'
  | 'doc_types'
  | 'ownership'
  | 'period'
  | 'delivered_to_me'
  | 'assigned_to_me';
export type RiskTier = 'standard' | 'elevated' | 'high' | 'critical';

export const PROJECT_CAPABILITY_KEYS = [
  'projects.jobs',
  'projects.jobs_all',
  'projects.financials',
  'projects.contract_value',
  'projects.labor_rates',
  'projects.leads',
  'projects.customers',
  'projects.estimates',
  'projects.change_orders',
  'projects.commitments',
  'projects.billing',
  'projects.time',
  'projects.dispatch',
  'projects.documents',
  'projects.selections',
  'projects.production',
  'projects.store',
  'projects.reports',
  'projects.settings',
  'projects.team',
] as const;
export type ProjectCapabilityKey = (typeof PROJECT_CAPABILITY_KEYS)[number];

export interface ProjectCapabilityDef {
  key: ProjectCapabilityKey;
  module: 'projects';
  /** Builder left-rail area. */
  domain: string;
  actions: readonly Action[];
  label: string;
  description: string;
  tags: readonly CapabilityTag[];
  fieldClasses: readonly FieldClass[];
  supportsConstraints: readonly ConstraintKind[];
  introducedIn: string;
  status: 'active' | 'deprecated';
  aliasOf: string | null;
}

const INTRODUCED = 'projects-wave0a';

interface CapOpts {
  tags?: readonly CapabilityTag[];
  fieldClasses?: readonly FieldClass[];
  supportsConstraints?: readonly ConstraintKind[];
}

function cap(
  domain: string,
  key: ProjectCapabilityKey,
  actions: readonly Action[],
  label: string,
  description: string,
  opts: CapOpts = {},
): ProjectCapabilityDef {
  const ordered = ACTIONS.filter((a) => actions.includes(a));
  return {
    key,
    module: 'projects',
    domain,
    actions: ordered,
    label,
    description,
    tags: opts.tags ?? [],
    fieldClasses: opts.fieldClasses ?? [],
    supportsConstraints: opts.supportsConstraints ?? [],
    introducedIn: INTRODUCED,
    status: 'active',
    aliasOf: null,
  };
}

export const PROJECT_CAPABILITIES: readonly ProjectCapabilityDef[] = [
  cap('Jobs', 'projects.jobs', ['view', 'create', 'edit', 'delete'], 'Jobs',
    'Jobs, tasks, schedule, logs, photos and punch on the jobs the person can reach.'),
  cap('Jobs', 'projects.jobs_all', ['view'], 'All jobs',
    'Reach every job in the company, not only the jobs the person is on.'),
  cap('Money', 'projects.financials', ['view', 'edit', 'export'], 'Job financials',
    'Cost, budget dollars, committed, actual, margin, WIP, job cost and estimate cost lines.', { tags: ['money'] }),
  cap('Money', 'projects.contract_value', ['view'], 'Contract value',
    'Contract and sell price, change-order and invoice amounts.', { tags: ['money'] }),
  cap('Money', 'projects.labor_rates', ['view', 'edit'], 'Labor rates',
    'Individual pay rates and burden.', { tags: ['sensitive'], fieldClasses: ['comp'] }),
  cap('Sales', 'projects.leads', ['view', 'create', 'edit', 'delete'], 'Leads',
    'Leads, pipeline and activities.'),
  cap('Sales', 'projects.customers', ['view', 'create', 'edit'], 'Customers',
    'Customer and site contact information (writes still go through definer functions).'),
  cap('Sales', 'projects.estimates', ['view', 'create', 'edit', 'approve'], 'Estimates',
    'Estimates, quotes and proposals; approve = release below the margin floor.'),
  cap('Money', 'projects.change_orders', ['view', 'create', 'edit', 'approve'], 'Change orders',
    'Change orders (field roles create without a price — an app rule).', { tags: ['money'] }),
  cap('Money', 'projects.commitments', ['view', 'create', 'edit', 'approve'], 'Commitments',
    'Purchase orders and subcontracts.', { tags: ['money'] }),
  cap('Money', 'projects.billing', ['view', 'create', 'edit', 'approve', 'post'], 'Billing',
    'Billing requests, pay applications and draws; post = send to Books.', { tags: ['money'] }),
  cap('Field', 'projects.time', ['view', 'create', 'edit', 'approve'], 'Time',
    'Time entries (own entries need create; approve = crew / timesheet approval).'),
  cap('Field', 'projects.dispatch', ['view', 'edit'], 'Dispatch',
    'Dispatch, crew and install boards.'),
  cap('Field', 'projects.documents', ['view', 'create', 'edit', 'delete'], 'Documents',
    'Files, photos, drawings and field logs.'),
  cap('Field', 'projects.selections', ['view', 'create', 'edit', 'approve'], 'Selections',
    'Selections and allowances.'),
  cap('Field', 'projects.production', ['view', 'create', 'edit'], 'Production',
    'Work orders and the production board.'),
  cap('Store', 'projects.store', ['view', 'create', 'edit', 'approve'], 'Dealer store',
    'Units, deals, parts counter, rentals and warranty (deal gross needs Job financials).'),
  cap('Admin', 'projects.reports', ['view', 'export'], 'Reports',
    'Dashboards and reports.'),
  cap('Admin', 'projects.settings', ['view', 'configure'], 'Projects settings',
    'Packs, job types, stages, cost codes, templates and labor settings.'),
  cap('Admin', 'projects.team', ['view', 'edit'], 'Job teams',
    'Job-team assignment and Projects role assignment requests.'),
];

export const PROJECT_CAPABILITY_BY_KEY: ReadonlyMap<string, ProjectCapabilityDef> = new Map(
  PROJECT_CAPABILITIES.map((c) => [c.key, c]),
);

/** Resource-level risk tier, derived from tags exactly like the Books registry. */
export function riskTier(c: Pick<ProjectCapabilityDef, 'tags'>): RiskTier {
  if (c.tags.includes('locked')) return 'critical';
  if (c.tags.includes('money')) return 'high';
  if (c.tags.includes('sensitive')) return 'elevated';
  return 'standard';
}

/** Projects capabilities are never platform-only (H5). */
export function isPlatformOnly(_c: Pick<ProjectCapabilityDef, 'module'>): boolean {
  return false;
}

export function capabilitySupports(key: string, action: string): action is Action {
  const c = PROJECT_CAPABILITY_BY_KEY.get(key);
  return !!c && (c.actions as readonly string[]).includes(action);
}
