/**
 * MERIT PROJECTS PERSONA ROLE TEMPLATES + PERMISSION SETS — code source of truth
 * (docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md §2.2).
 *
 * Platform templates (owner_level platform, audience internal_staff), seeded by migration
 * 1110_pm_access.sql through core.rbac_seed_platform_roles / _permission_sets (the same
 * functions Books uses in 158 / 159) and cloned into every tenant as standard roles.
 * The GENERATED blocks in 1110 are written by scripts/generate-seed.ts; a guard test fails
 * when the DB templates and this file differ.
 *
 * Template grants change only by shipping a NEW template version (same rule as Books).
 *
 * PURE: no I/O.
 */

import { ACTIONS, type Action, type ProjectCapabilityKey, PROJECT_CAPABILITIES } from './capabilities';

export const PERSONA_KEYS = [
  'projects_owner',
  'projects_gm',
  'projects_office_manager',
  'projects_project_accountant',
  'projects_dispatcher',
  'projects_purchasing',
  'projects_pm',
  'projects_supervisor',
  'projects_labor',
  'projects_sales',
] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

export type Audience = 'internal_staff' | 'client_staff' | 'external' | 'platform';
export type DefaultScope = 'all_clients' | 'assigned';
export type AssignableBand = 'tenant_admin_only' | 'managers' | 'any_grantor';

export interface FieldPolicy {
  comp: 'hidden' | 'grouped' | 'visible';
  tin: 'hidden' | 'masked' | 'reveal_logged' | 'visible';
  bank: 'hidden' | 'masked' | 'reveal_logged' | 'visible';
  personal: 'hidden' | 'visible';
}
export interface AuthPolicy {
  mfa_required: boolean;
  step_up_minutes?: number;
}

/** No Projects template uses grant constraints yet (always `{}`). */
export type GrantConstraints = Record<string, never>;

export interface TemplateGrant {
  capability: ProjectCapabilityKey;
  actions: Action[];
  constraints: GrantConstraints;
}

export interface ProjectRoleTemplate {
  key: PersonaKey;
  name: string;
  description: string;
  audience: Audience;
  defaultScope: DefaultScope;
  fieldPolicy: FieldPolicy;
  authPolicy: AuthPolicy;
  maxAssignmentDays: number | null;
  assignableBand: AssignableBand;
  /** Highest held rank wins as the primary persona (mirrors PERSONA_RANK in apps/projects types.ts). */
  rank: number;
  grants: TemplateGrant[];
}

export interface ProjectPermissionSetTemplate {
  key: string;
  name: string;
  description: string;
  audience: Audience;
  isEnvelope: boolean;
  isSealed: boolean;
  fieldPolicy: Partial<FieldPolicy>;
  maxAssignmentDays: number | null;
  grants: TemplateGrant[];
}

type GrantSpec = Partial<Record<ProjectCapabilityKey, readonly Action[]>>;

/** Normalize a grant spec: canonical action order, sorted by capability (the DB order). */
function grants(spec: GrantSpec): TemplateGrant[] {
  return (Object.entries(spec) as Array<[ProjectCapabilityKey, readonly Action[]]>)
    .filter(([, acts]) => acts.length > 0)
    .map(([capability, acts]) => ({
      capability,
      actions: ACTIONS.filter((a) => acts.includes(a)),
      constraints: {},
    }))
    .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));
}

/** Every projects capability with every action it supports. */
function everything(except: GrantSpec = {}): GrantSpec {
  const out: GrantSpec = {};
  for (const c of PROJECT_CAPABILITIES) out[c.key] = except[c.key] ?? c.actions;
  return out;
}

const HIDDEN: FieldPolicy = { comp: 'hidden', tin: 'hidden', bank: 'hidden', personal: 'hidden' };
const MFA: AuthPolicy = { mfa_required: true, step_up_minutes: 10 };
const NO_MFA: AuthPolicy = { mfa_required: false };

const V = ['view'] as const;
const VCE = ['view', 'create', 'edit'] as const;
const VCED = ['view', 'create', 'edit', 'delete'] as const;
const VC = ['view', 'create'] as const;
const VE = ['view', 'edit'] as const;

export const PROJECT_ROLE_TEMPLATES: readonly ProjectRoleTemplate[] = [
  {
    key: 'projects_owner',
    name: 'Projects owner',
    description: 'Every job and all money in the companies assigned, including pay rates, approvals, export and settings.',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: { comp: 'visible', tin: 'masked', bank: 'masked', personal: 'hidden' },
    authPolicy: MFA,
    maxAssignmentDays: null,
    assignableBand: 'tenant_admin_only',
    rank: 100,
    grants: grants(everything()),
  },
  {
    key: 'projects_gm',
    name: 'General manager',
    description: 'Every job and all job money; runs operations and approvals. Sees but does not edit pay rates; no settings changes.',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: { comp: 'grouped', tin: 'masked', bank: 'masked', personal: 'hidden' },
    authPolicy: MFA,
    maxAssignmentDays: null,
    assignableBand: 'tenant_admin_only',
    rank: 90,
    grants: grants(everything({ 'projects.labor_rates': V, 'projects.settings': V })),
  },
  {
    key: 'projects_office_manager',
    name: 'Office manager',
    description: 'Every job and customer; leads, billing requests, dispatch and documents. Contract values only — no cost or margin.',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 65,
    grants: grants({
      'projects.jobs': VCE,
      'projects.jobs_all': V,
      'projects.contract_value': V,
      'projects.leads': VCED,
      'projects.customers': VCE,
      'projects.estimates': V,
      'projects.change_orders': V,
      'projects.billing': VCE,
      'projects.time': V,
      'projects.dispatch': VE,
      'projects.documents': VCED,
      'projects.selections': V,
      'projects.production': V,
      'projects.store': V,
      'projects.reports': V,
      'projects.settings': V,
      'projects.team': V,
    }),
  },
  {
    key: 'projects_project_accountant',
    name: 'Project accountant',
    description: 'Every job and all job money; billing end to end (approve, send to Books), commitment approval, report export.',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: { comp: 'grouped', tin: 'masked', bank: 'masked', personal: 'hidden' },
    authPolicy: MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 70,
    grants: grants({
      'projects.jobs': V,
      'projects.jobs_all': V,
      'projects.financials': ['view', 'export'],
      'projects.contract_value': V,
      'projects.customers': V,
      'projects.estimates': V,
      'projects.change_orders': V,
      'projects.commitments': ['view', 'approve'],
      'projects.billing': ['view', 'create', 'edit', 'approve', 'post'],
      'projects.time': V,
      'projects.documents': VC,
      'projects.reports': ['view', 'export'],
      'projects.settings': V,
      'projects.team': V,
    }),
  },
  {
    key: 'projects_dispatcher',
    name: 'Dispatcher',
    description: 'Every job and customer; leads, scheduling and dispatch. No job money (price-book sell prices only).',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 50,
    grants: grants({
      'projects.jobs': VCE,
      'projects.jobs_all': V,
      'projects.leads': VCED,
      'projects.customers': VCE,
      'projects.time': V,
      'projects.dispatch': VE,
      'projects.documents': VC,
      'projects.production': V,
      'projects.team': V,
    }),
  },
  {
    key: 'projects_purchasing',
    name: 'Purchasing',
    description: 'Every job; writes and approves purchase orders and subcontracts. Sees job cost, not contract value.',
    audience: 'internal_staff',
    defaultScope: 'all_clients',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 55,
    grants: grants({
      'projects.jobs': V,
      'projects.jobs_all': V,
      'projects.financials': V,
      'projects.commitments': ['view', 'create', 'edit', 'approve'],
      'projects.documents': VCE,
      'projects.production': V,
      'projects.store': V,
    }),
  },
  {
    key: 'projects_pm',
    name: 'Project manager',
    description: 'Their own jobs, with full money on those jobs (no individual pay rates); approves change orders, commitments, time and selections.',
    audience: 'internal_staff',
    defaultScope: 'assigned',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 60,
    grants: grants({
      'projects.jobs': VCED,
      'projects.financials': ['view', 'edit', 'export'],
      'projects.contract_value': V,
      'projects.customers': V,
      'projects.estimates': VCE,
      'projects.change_orders': ['view', 'create', 'edit', 'approve'],
      'projects.commitments': ['view', 'create', 'edit', 'approve'],
      'projects.billing': VCE,
      'projects.time': ['view', 'create', 'edit', 'approve'],
      'projects.dispatch': V,
      'projects.documents': VCED,
      'projects.selections': ['view', 'create', 'edit', 'approve'],
      'projects.production': VCE,
      'projects.reports': V,
      'projects.team': VE,
    }),
  },
  {
    key: 'projects_supervisor',
    name: 'Supervisor',
    description: 'Their own jobs: schedule, logs, crew time approval and change-order requests. Hours and quantities only — no dollars.',
    audience: 'internal_staff',
    defaultScope: 'assigned',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 30,
    grants: grants({
      'projects.jobs': VE,
      'projects.change_orders': VC,
      'projects.time': ['view', 'create', 'edit', 'approve'],
      'projects.dispatch': V,
      'projects.documents': VCE,
      'projects.selections': V,
      'projects.production': VE,
      'projects.team': V,
    }),
  },
  {
    key: 'projects_labor',
    name: 'Crew',
    description: 'The jobs they are assigned to: today\'s work, their own time, photos and field logs. No dollars and nobody\'s pay.',
    audience: 'internal_staff',
    defaultScope: 'assigned',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'any_grantor',
    rank: 10,
    grants: grants({
      'projects.jobs': V,
      'projects.time': VCE,
      'projects.documents': VC,
    }),
  },
  {
    key: 'projects_sales',
    name: 'Sales',
    description: 'All leads; customers and estimates end to end; their own jobs. Contract values; cost only on the estimates they wrote.',
    audience: 'internal_staff',
    defaultScope: 'assigned',
    fieldPolicy: HIDDEN,
    authPolicy: NO_MFA,
    maxAssignmentDays: null,
    assignableBand: 'managers',
    rank: 40,
    grants: grants({
      'projects.jobs': V,
      'projects.contract_value': V,
      'projects.leads': VCED,
      'projects.customers': VCE,
      'projects.estimates': ['view', 'create', 'edit', 'approve'],
      'projects.documents': VC,
      'projects.selections': V,
      'projects.reports': V,
    }),
  },
];

export const PROJECT_PERMISSION_SET_TEMPLATES: readonly ProjectPermissionSetTemplate[] = [
  {
    key: 'projects_payroll_admin',
    name: 'Projects payroll admin',
    description: 'See individual pay rates and approve timesheets.',
    audience: 'internal_staff',
    isEnvelope: false,
    isSealed: false,
    fieldPolicy: { comp: 'visible' },
    maxAssignmentDays: null,
    grants: grants({ 'projects.labor_rates': V, 'projects.time': ['view', 'approve'] }),
  },
  {
    // Deploy backfill only (spec §3 + acceptance #7): members who were not owners keep reaching
    // every job and the operational modules projects_pm lacks (store, leads, dispatch) as they do
    // today. No approvals, posting, pay rates or settings. Flagged for the first access review.
    key: 'projects_legacy_all_jobs',
    name: 'Legacy all jobs (Projects)',
    description: 'Reach every job, the store, leads and dispatch, as before roles existed. Added by the deploy backfill — review and remove.',
    audience: 'internal_staff',
    isEnvelope: false,
    isSealed: false,
    fieldPolicy: {},
    maxAssignmentDays: null,
    grants: grants({
      'projects.jobs_all': V,
      'projects.store': VCE,
      'projects.leads': VCED,
      'projects.customers': VCE,
      'projects.dispatch': VE,
    }),
  },
];

export const PROJECT_ROLE_TEMPLATE_BY_KEY: ReadonlyMap<string, ProjectRoleTemplate> = new Map(
  PROJECT_ROLE_TEMPLATES.map((t) => [t.key, t]),
);

/** Template grants as `cap:action` strings (handy for preview-as intersection). */
export function templateGrantKeys(t: { grants: readonly TemplateGrant[] }): string[] {
  return t.grants.flatMap((g) => g.actions.map((a) => `${g.capability}:${a}`));
}
