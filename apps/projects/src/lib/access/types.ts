/**
 * Merit Projects access model — the contract shared by the DB (pm.my_access, migration 1110),
 * the server (getAccess / route guard / masking) and the UI (nav, homes, money display).
 * Spec: docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md §2.
 */

export const PROJECT_CAPABILITIES = [
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
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

export type AccessAction = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'post' | 'release' | 'export' | 'configure';

/** 'projects.billing:approve' */
export type Grant = `${ProjectCapability}:${AccessAction}`;

export const PERSONAS = [
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
export type PersonaKey = (typeof PERSONAS)[number];

/** The five rails the UI builds (spec §5). */
export type PersonaGroup = 'management' | 'admin' | 'pm' | 'supervisor' | 'labor' | 'sales';

export const PERSONA_GROUP: Readonly<Record<PersonaKey, PersonaGroup>> = {
  projects_owner: 'management',
  projects_gm: 'management',
  projects_office_manager: 'admin',
  projects_project_accountant: 'admin',
  projects_dispatcher: 'admin',
  projects_purchasing: 'admin',
  projects_pm: 'pm',
  projects_supervisor: 'supervisor',
  projects_labor: 'labor',
  projects_sales: 'sales',
};

/** Rank used to pick the primary persona when a person holds several (highest wins). */
export const PERSONA_RANK: Readonly<Record<PersonaKey, number>> = {
  projects_owner: 100,
  projects_gm: 90,
  projects_project_accountant: 70,
  projects_office_manager: 65,
  projects_pm: 60,
  projects_purchasing: 55,
  projects_dispatcher: 50,
  projects_sales: 40,
  projects_supervisor: 30,
  projects_labor: 10,
};

/** 1 Labor · 2 Supervisor (hours/qty) · 3 PM ($ on own jobs) · 4 Management (all). Derived, never stored. */
export type MoneyLevel = 1 | 2 | 3 | 4;

/** One row of pm.my_access(). */
export interface AccessRow {
  location_id: string;
  capability: string;
  actions: string[];
  role_key: string | null;
  role_name: string | null;
}

export interface Access {
  membershipId: string | null;
  /** Primary persona (highest rank held, or the preview persona). */
  persona: PersonaKey;
  group: PersonaGroup;
  /** Industry title for the persona when the pack names one, else the role name. */
  title: string;
  /** Union of grants across all companies. */
  grants: ReadonlySet<Grant>;
  /** Grants per company id. */
  byCompany: Readonly<Record<string, ReadonlySet<Grant>>>;
  moneyLevel: MoneyLevel;
  jobScope: 'all' | 'own';
  /** Set when an owner is previewing another persona (narrowing only). */
  preview: PersonaKey | null;
}

export function grantKey(cap: ProjectCapability, action: AccessAction): Grant {
  return `${cap}:${action}`;
}
