/**
 * Plain-words refusals for the access guard (route() and the onboarding routes). Pure apart
 * from HttpError; the 403 body is always { error, code: 'FORBIDDEN' }.
 */
import { HttpError } from '@/lib/api-errors';
import { can } from './can';
import type { Access, AccessAction, ProjectCapability } from './types';

export const FORBIDDEN = 'FORBIDDEN' as const;

const NOUN: Readonly<Record<ProjectCapability, string>> = {
  'projects.jobs': 'jobs',
  'projects.jobs_all': 'every job in the company',
  'projects.financials': 'job costs, budgets and margin',
  'projects.contract_value': 'contract and invoice amounts',
  'projects.labor_rates': 'pay rates',
  'projects.leads': 'leads',
  'projects.customers': 'customers',
  'projects.estimates': 'estimates',
  'projects.change_orders': 'change orders',
  'projects.commitments': 'purchase orders and subcontracts',
  'projects.billing': 'billing',
  'projects.time': 'time',
  'projects.dispatch': 'the schedule board',
  'projects.documents': 'documents and photos',
  'projects.selections': 'selections',
  'projects.production': 'production work',
  'projects.store': 'store records',
  'projects.reports': 'reports',
  'projects.settings': 'Projects settings',
  'projects.team': 'job teams',
};

const VERB: Readonly<Record<AccessAction, string>> = {
  view: 'see',
  create: 'add',
  edit: 'change',
  delete: 'remove',
  approve: 'approve',
  post: 'send to Merit Books',
  release: 'release',
  export: 'export',
  configure: 'set up',
};

/** "Your role doesn't let you approve billing. Ask an owner if you need it." */
export function forbiddenMessage(cap: ProjectCapability, action: AccessAction, companyName?: string | null): string {
  const what = action === 'post' ? `send ${NOUN[cap]} to Merit Books` : `${VERB[action]} ${NOUN[cap]}`;
  const where = companyName ? ` at ${companyName}` : '';
  return `Your role doesn’t let you ${what}${where}. Ask an owner if you need it.`;
}

export function forbiddenBody(cap: ProjectCapability, action: AccessAction, companyName?: string | null): { error: string; code: typeof FORBIDDEN } {
  return { error: forbiddenMessage(cap, action, companyName), code: FORBIDDEN };
}

/** Throw a 403 HttpError unless the caller holds cap:action (at the company, when given). */
export function requireCan(access: Access, cap: ProjectCapability, action: AccessAction, companyId?: string | null, companyName?: string | null): void {
  if (!can(access, cap, action, companyId)) throw new HttpError(403, forbiddenMessage(cap, action, companyName), FORBIDDEN);
}
