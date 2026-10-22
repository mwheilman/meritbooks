/**
 * Access over the wire (GET /api/access/me, server → client component props). Sets become
 * sorted arrays; fromJson rebuilds an Access that can()/maskMoney() accept. Client-safe.
 */
import { PERSONA_GROUP, PROJECT_CAPABILITIES, type Access, type Grant, type MoneyLevel } from './types';
import { CAPABILITY_ACTIONS, isPersonaKey } from './templates';

export interface AccessJson {
  membershipId: string | null;
  persona: Access['persona'];
  group: Access['group'];
  title: string;
  grants: Grant[];
  byCompany: Record<string, Grant[]>;
  moneyLevel: MoneyLevel;
  jobScope: 'all' | 'own';
  preview: Access['preview'];
}

export function accessToJson(a: Access): AccessJson {
  return {
    membershipId: a.membershipId,
    persona: a.persona,
    group: a.group,
    title: a.title,
    grants: [...a.grants].sort(),
    byCompany: Object.fromEntries(Object.entries(a.byCompany).map(([k, s]) => [k, [...s].sort()])),
    moneyLevel: a.moneyLevel,
    jobScope: a.jobScope,
    preview: a.preview,
  };
}

const CAPS: ReadonlySet<string> = new Set(PROJECT_CAPABILITIES);
function isGrant(g: unknown): g is Grant {
  if (typeof g !== 'string') return false;
  const i = g.lastIndexOf(':');
  const cap = g.slice(0, i);
  return CAPS.has(cap) && (CAPABILITY_ACTIONS[cap as keyof typeof CAPABILITY_ACTIONS] as ReadonlyArray<string>).includes(g.slice(i + 1));
}

export function accessFromJson(j: AccessJson): Access {
  const persona = isPersonaKey(j.persona) ? j.persona : 'projects_labor';
  return {
    membershipId: j.membershipId ?? null,
    persona,
    group: PERSONA_GROUP[persona],
    title: j.title,
    grants: new Set((j.grants ?? []).filter(isGrant)),
    byCompany: Object.fromEntries(Object.entries(j.byCompany ?? {}).map(([k, v]) => [k, new Set((v ?? []).filter(isGrant))])),
    moneyLevel: j.moneyLevel,
    jobScope: j.jobScope === 'all' ? 'all' : 'own',
    preview: isPersonaKey(j.preview) ? j.preview : null,
  };
}
