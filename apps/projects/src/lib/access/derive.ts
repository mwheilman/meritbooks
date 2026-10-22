/**
 * Pure derivation of the caller's Access from pm.my_access() rows (spec §2.3, §2.4, §4).
 * No I/O here — server.ts fetches, this file decides (unit-tested).
 */
import {
  PERSONA_GROUP, PERSONA_RANK, PROJECT_CAPABILITIES,
  type Access, type AccessAction, type AccessRow, type Grant, type MoneyLevel, type PersonaKey, type ProjectCapability,
} from './types';
import { CAPABILITY_ACTIONS, PERSONA_LABEL, PERSONA_TEMPLATE_GRANTS, isPersonaKey } from './templates';

const CAP_SET: ReadonlySet<string> = new Set(PROJECT_CAPABILITIES);

function isCapability(v: string): v is ProjectCapability {
  return CAP_SET.has(v);
}

/** 'cap:action' grants per company from raw rows. Unknown caps/actions are dropped (fail closed). */
export function grantsByCompany(rows: ReadonlyArray<AccessRow>): Record<string, Set<Grant>> {
  const out: Record<string, Set<Grant>> = {};
  for (const r of rows) {
    if (!r || typeof r.location_id !== 'string' || !r.location_id || !isCapability(r.capability)) continue;
    const allowed = CAPABILITY_ACTIONS[r.capability] as ReadonlyArray<string>;
    const set = (out[r.location_id] ??= new Set<Grant>());
    for (const a of r.actions ?? []) {
      if (allowed.includes(a)) set.add(`${r.capability}:${a as AccessAction}`);
    }
  }
  return out;
}

export function unionGrants(byCompany: Readonly<Record<string, ReadonlySet<Grant>>>): Set<Grant> {
  const u = new Set<Grant>();
  for (const s of Object.values(byCompany)) for (const g of s) u.add(g);
  return u;
}

/**
 * Primary persona: the highest PERSONA_RANK among the template keys of the granting roles.
 * A custom tenant role whose key is not a template is inferred from its grants.
 */
export function choosePersona(rows: ReadonlyArray<AccessRow>, grants: ReadonlySet<Grant>): PersonaKey {
  let best: PersonaKey | null = null;
  for (const r of rows) {
    const k = r.role_key;
    if (isPersonaKey(k) && (best === null || PERSONA_RANK[k] > PERSONA_RANK[best])) best = k;
  }
  return best ?? inferPersona(grants);
}

/** Fallback for roles that are not one of the ten templates. */
export function inferPersona(g: ReadonlySet<Grant>): PersonaKey {
  const has = (x: Grant) => g.has(x);
  const all = has('projects.jobs_all:view');
  if (has('projects.settings:configure')) return 'projects_owner';
  if (all && has('projects.financials:view') && has('projects.contract_value:view')) {
    return has('projects.billing:post') && !has('projects.jobs:create') ? 'projects_project_accountant' : 'projects_gm';
  }
  if (all && has('projects.contract_value:view')) return 'projects_office_manager';
  if (all && has('projects.financials:view')) return 'projects_purchasing';
  if (all) return 'projects_dispatcher';
  if (has('projects.financials:view')) return 'projects_pm';
  if (has('projects.estimates:create') && has('projects.leads:view')) return 'projects_sales';
  if (has('projects.time:approve') || has('projects.jobs:edit')) return 'projects_supervisor';
  return 'projects_labor';
}

/** §2.3 — 1 Labor · 2 Supervisor (hours/qty) · 3 PM ($) · 4 Management (all money incl. rates). */
export function deriveMoneyLevel(g: ReadonlySet<Grant>): MoneyLevel {
  const fin = g.has('projects.financials:view');
  const cv = g.has('projects.contract_value:view');
  if (fin && cv && g.has('projects.labor_rates:view')) return 4;
  if (fin || cv) return 3;
  if (g.has('projects.time:approve') || g.has('projects.jobs:edit') || g.has('projects.dispatch:edit')) return 2;
  return 1;
}

export function deriveJobScope(g: ReadonlySet<Grant>): 'all' | 'own' {
  return g.has('projects.jobs_all:view') ? 'all' : 'own';
}

/** Preview narrowing: real ∩ template, per company. Never adds a grant. */
export function narrowToPersona(
  byCompany: Readonly<Record<string, ReadonlySet<Grant>>>,
  persona: PersonaKey,
): Record<string, Set<Grant>> {
  const tpl = PERSONA_TEMPLATE_GRANTS[persona];
  const out: Record<string, Set<Grant>> = {};
  for (const [loc, set] of Object.entries(byCompany)) out[loc] = new Set([...set].filter((g) => tpl.has(g)));
  return out;
}

export interface BuildOptions {
  membershipId?: string | null;
  /** Requested preview persona (cookie). Honoured only when the REAL grants include settings:configure. */
  preview?: string | null;
  /** Industry title resolver (pack roles slot). Return null to fall back. */
  titleFor?: (persona: PersonaKey) => string | null;
}

export function canPreview(realGrants: ReadonlySet<Grant>): boolean {
  return realGrants.has('projects.settings:configure');
}

export function buildAccess(rows: ReadonlyArray<AccessRow>, opts: BuildOptions = {}): Access {
  const realByCompany = grantsByCompany(rows);
  const realGrants = unionGrants(realByCompany);
  const realPersona = choosePersona(rows, realGrants);

  const preview = isPersonaKey(opts.preview) && canPreview(realGrants) ? opts.preview : null;
  const byCompany = preview ? narrowToPersona(realByCompany, preview) : realByCompany;
  const grants = preview ? unionGrants(byCompany) : realGrants;
  const persona = preview ?? realPersona;

  const roleName = preview ? null : rows.find((r) => r.role_key === persona && r.role_name)?.role_name ?? null;
  const title = opts.titleFor?.(persona) ?? roleName ?? PERSONA_LABEL[persona];

  return {
    membershipId: opts.membershipId ?? null,
    persona,
    group: PERSONA_GROUP[persona],
    title,
    grants,
    byCompany,
    moneyLevel: deriveMoneyLevel(grants),
    jobScope: deriveJobScope(grants),
    preview,
  };
}

/** No rows / no session: nothing granted. Every guarded route answers 403. */
export function emptyAccess(membershipId: string | null = null): Access {
  return buildAccess([], { membershipId });
}
