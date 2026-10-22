/**
 * Persona role templates — the grant list each platform template carries (spec §2.2).
 *
 * LOCAL MIRROR. The code source of truth is `packages/projects-access/src/roles.ts` (mirrored by
 * migration 1110). apps/projects does not depend on that package yet (no workspace link, no
 * transpilePackages entry), so the app keeps this copy for "preview as" narrowing only: the
 * server never GRANTS from it — effective grants are always (real grants from pm.my_access) ∩
 * (template grants), so drift could only hide more, never reveal. `access-templates.test.ts`
 * imports the package by path and fails on any difference.
 */
import { PERSONAS, grantKey, type AccessAction, type Grant, type PersonaKey, type ProjectCapability } from './types';

/** Actions each capability supports (spec §2.1). */
export const CAPABILITY_ACTIONS: Readonly<Record<ProjectCapability, readonly AccessAction[]>> = {
  'projects.jobs': ['view', 'create', 'edit', 'delete'],
  'projects.jobs_all': ['view'],
  'projects.financials': ['view', 'edit', 'export'],
  'projects.contract_value': ['view'],
  'projects.labor_rates': ['view', 'edit'],
  'projects.leads': ['view', 'create', 'edit', 'delete'],
  'projects.customers': ['view', 'create', 'edit'],
  'projects.estimates': ['view', 'create', 'edit', 'approve'],
  'projects.change_orders': ['view', 'create', 'edit', 'approve'],
  'projects.commitments': ['view', 'create', 'edit', 'approve'],
  'projects.billing': ['view', 'create', 'edit', 'approve', 'post'],
  'projects.time': ['view', 'create', 'edit', 'approve'],
  'projects.dispatch': ['view', 'edit'],
  'projects.documents': ['view', 'create', 'edit', 'delete'],
  'projects.selections': ['view', 'create', 'edit', 'approve'],
  'projects.production': ['view', 'create', 'edit'],
  'projects.store': ['view', 'create', 'edit', 'approve'],
  'projects.reports': ['view', 'export'],
  'projects.settings': ['view', 'configure'],
  'projects.team': ['view', 'edit'],
};

type Spec = Partial<Record<ProjectCapability, readonly AccessAction[] | 'all'>>;

function expand(spec: Spec): readonly Grant[] {
  const out: Grant[] = [];
  for (const [cap, acts] of Object.entries(spec) as Array<[ProjectCapability, readonly AccessAction[] | 'all']>) {
    const list = acts === 'all' ? CAPABILITY_ACTIONS[cap] : acts;
    for (const a of list) if (CAPABILITY_ACTIONS[cap].includes(a)) out.push(grantKey(cap, a));
  }
  return out;
}

const ALL: Spec = Object.fromEntries(
  (Object.keys(CAPABILITY_ACTIONS) as ProjectCapability[]).map((c) => [c, 'all' as const]),
);

const V = ['view'] as const;
const VC = ['view', 'create'] as const;
const VE = ['view', 'edit'] as const;
const VCE = ['view', 'create', 'edit'] as const;
const VCED = ['view', 'create', 'edit', 'delete'] as const;
const VCEA = ['view', 'create', 'edit', 'approve'] as const;

/** Mirrors PROJECT_ROLE_TEMPLATES in packages/projects-access/src/roles.ts (drift test: access-templates.test.ts). */
const SPECS: Readonly<Record<PersonaKey, Spec>> = {
  projects_owner: ALL,
  projects_gm: { ...ALL, 'projects.labor_rates': V, 'projects.settings': V },
  projects_office_manager: {
    'projects.jobs': VCE, 'projects.jobs_all': V, 'projects.contract_value': V, 'projects.leads': VCED,
    'projects.customers': VCE, 'projects.estimates': V, 'projects.change_orders': V, 'projects.billing': VCE,
    'projects.time': V, 'projects.dispatch': VE, 'projects.documents': VCED, 'projects.selections': V,
    'projects.production': V, 'projects.store': V, 'projects.reports': V, 'projects.settings': V, 'projects.team': V,
  },
  projects_project_accountant: {
    'projects.jobs': V, 'projects.jobs_all': V, 'projects.financials': ['view', 'export'], 'projects.contract_value': V,
    'projects.customers': V, 'projects.estimates': V, 'projects.change_orders': V, 'projects.commitments': ['view', 'approve'],
    'projects.billing': ['view', 'create', 'edit', 'approve', 'post'], 'projects.time': V, 'projects.documents': VC,
    'projects.reports': ['view', 'export'], 'projects.settings': V, 'projects.team': V,
  },
  projects_dispatcher: {
    'projects.jobs': VCE, 'projects.jobs_all': V, 'projects.leads': VCED, 'projects.customers': VCE, 'projects.time': V,
    'projects.dispatch': VE, 'projects.documents': VC, 'projects.production': V, 'projects.team': V,
  },
  projects_purchasing: {
    'projects.jobs': V, 'projects.jobs_all': V, 'projects.financials': V, 'projects.commitments': VCEA,
    'projects.documents': VCE, 'projects.production': V, 'projects.store': V,
  },
  projects_pm: {
    'projects.jobs': VCED, 'projects.financials': ['view', 'edit', 'export'], 'projects.contract_value': V,
    'projects.customers': V, 'projects.estimates': VCE, 'projects.change_orders': VCEA, 'projects.commitments': VCEA,
    'projects.billing': VCE, 'projects.time': VCEA, 'projects.dispatch': V, 'projects.documents': VCED,
    'projects.selections': VCEA, 'projects.production': VCE, 'projects.reports': V, 'projects.team': VE,
  },
  projects_supervisor: {
    'projects.jobs': VE, 'projects.change_orders': VC, 'projects.time': VCEA, 'projects.dispatch': V,
    'projects.documents': VCE, 'projects.selections': V, 'projects.production': VE, 'projects.team': V,
  },
  projects_labor: { 'projects.jobs': V, 'projects.time': VCE, 'projects.documents': VC },
  projects_sales: {
    'projects.jobs': V, 'projects.contract_value': V, 'projects.leads': VCED, 'projects.customers': VCE,
    'projects.estimates': VCEA, 'projects.documents': VC, 'projects.selections': V, 'projects.reports': V,
  },
};

function buildTemplates(): Record<PersonaKey, ReadonlySet<Grant>> {
  const out = {} as Record<PersonaKey, ReadonlySet<Grant>>;
  for (const p of PERSONAS) out[p] = new Set(expand(SPECS[p]));
  return out;
}

export const PERSONA_TEMPLATE_GRANTS: Readonly<Record<PersonaKey, ReadonlySet<Grant>>> = buildTemplates();

/** Default persona names (used when neither the pack nor the role gives a title). */
export const PERSONA_LABEL: Readonly<Record<PersonaKey, string>> = {
  projects_owner: 'Owner',
  projects_gm: 'General manager',
  projects_office_manager: 'Office manager',
  projects_project_accountant: 'Project accountant',
  projects_dispatcher: 'Dispatcher',
  projects_purchasing: 'Purchasing',
  projects_pm: 'Project manager',
  projects_supervisor: 'Supervisor',
  projects_labor: 'Crew',
  projects_sales: 'Sales',
};

export function isPersonaKey(v: unknown): v is PersonaKey {
  return typeof v === 'string' && (PERSONAS as ReadonlyArray<string>).includes(v);
}
