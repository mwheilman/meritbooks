/**
 * Plain-English sentences for access governance (05-RBAC-SPEC §1.7 UI language, §6.9, §6.10).
 * The screen says "Current" and "Proposed changes" — never template, version or draft jargon.
 * PURE: no I/O, safe for client components.
 */

import { formatMoney } from '@meritbooks/shared';
import { CAPABILITY_BY_KEY } from '@/lib/rbac/capabilities';
import type { SuggestionChange } from './types';

const VERB: Readonly<Record<string, string>> = {
  view: 'see',
  create: 'create',
  edit: 'edit',
  delete: 'delete',
  approve: 'approve',
  post: 'post',
  release: 'send or release',
  export: 'export',
  configure: 'configure',
};
const ACTION_ORDER = ['view', 'create', 'edit', 'delete', 'approve', 'post', 'release', 'export', 'configure'];

export function capabilityLabel(key: string): string {
  return CAPABILITY_BY_KEY.get(key)?.label ?? key;
}

export function actionVerb(action: string): string {
  return VERB[action] ?? action;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "approve and edit Bills" */
export function describeGrant(capability: string, actions: readonly string[]): string {
  const sorted = [...actions].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  return `${joinWords(sorted.map(actionVerb))} ${capabilityLabel(capability)}`;
}

function limitPhrase(constraints: Record<string, unknown> | undefined): string {
  const al = constraints?.amount_limit as { max_per_item_cents?: unknown } | undefined;
  const cents = al && typeof al.max_per_item_cents === 'number' ? al.max_per_item_cents : null;
  return cents === null ? '' : ` up to ${formatMoney(cents)}`;
}

/** One suggestion sentence, e.g. "Adds: approve Bills up to $25,000." */
export function describeSuggestion(change: SuggestionChange): string {
  if (change.kind === 'add') {
    return `Adds: ${describeGrant(change.capability, change.actions ?? [])}${limitPhrase(change.constraints)}.`;
  }
  if (change.kind === 'remove') {
    return `Removes: ${describeGrant(change.capability, change.actions ?? [])}.`;
  }
  const before = limitPhrase(change.before).trim() || 'no limit';
  const after = limitPhrase(change.after).trim() || 'no limit';
  return `Changes the limit on ${capabilityLabel(change.capability)}: ${before} → ${after}.`;
}

/** Group a suggestion batch into one "Adds …; Removes …" line for the library note. */
export function summarizeSuggestions(changes: readonly SuggestionChange[]): string {
  const adds = changes.filter((c) => c.kind === 'add').map((c) => describeGrant(c.capability, c.actions ?? []));
  const removes = changes.filter((c) => c.kind === 'remove').map((c) => describeGrant(c.capability, c.actions ?? []));
  const limits = changes.filter((c) => c.kind === 'constraint').map((c) => capabilityLabel(c.capability));
  const parts: string[] = [];
  if (adds.length) parts.push(`Adds: ${adds.join('; ')}`);
  if (removes.length) parts.push(`Removes: ${removes.join('; ')}`);
  if (limits.length) parts.push(`New limits on: ${limits.join(', ')}`);
  return parts.join('. ');
}

export interface ScopeInput {
  scope_type?: unknown;
  location_name?: unknown;
  client_set_name?: unknown;
}

export function scopeLabel(s: ScopeInput | null | undefined): string {
  const t = typeof s?.scope_type === 'string' ? s.scope_type : '';
  if (t === 'all_clients') return 'all clients';
  if (t === 'tenant') return 'the workspace';
  if (t === 'client') return typeof s?.location_name === 'string' && s.location_name ? s.location_name : 'one client';
  if (t === 'client_set') return typeof s?.client_set_name === 'string' && s.client_set_name ? s.client_set_name : 'a client group';
  if (t === 'consolidation_group') return 'a consolidation group';
  return 'unknown scope';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface PairChange {
  capability: string;
  action: string;
}
function pairs(v: unknown): PairChange[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is PairChange => !!x && typeof x === 'object' && typeof (x as PairChange).capability === 'string');
}
function pairSentence(list: PairChange[]): string {
  const byCap = new Map<string, string[]>();
  for (const p of list) byCap.set(p.capability, [...(byCap.get(p.capability) ?? []), p.action]);
  return [...byCap.entries()].map(([c, a]) => describeGrant(c, a)).join('; ');
}

export interface DescribeInput {
  event: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  affectedNames: string[];
  /** Current name of the role / permission set the entry is about (publishes carry no name). */
  subjectName?: string | null;
}

/** One line for the access-log timeline. Names come from the snapshot taken at the time. */
export function describeLogEntry(e: DescribeInput): string {
  const who = e.affectedNames.length ? joinWords(e.affectedNames) : 'someone';
  const snap = e.after ?? e.before ?? {};
  const what = str(snap.source_name) || 'a role';
  const where = scopeLabel(snap as ScopeInput);
  const [domain, verb] = e.event.split('.');
  if (domain === 'assignment') {
    switch (verb) {
      case 'grant': return `${who} was given ${what} on ${where}.`;
      case 'grant_pending': return `${who} was given ${what} on ${where}, waiting for a second approver.`;
      case 'approve': return `A second approver confirmed ${what} for ${who} on ${where}.`;
      case 'revoke': return `${who} lost ${what} on ${where}.`;
      case 'expire': return `${who}'s ${what} on ${where} ended at its end date.`;
      case 'end': return `${who}'s ${what} on ${where} was ended.`;
      case 'suspend': return `${who}'s ${what} on ${where} was suspended.`;
      case 'reinstate': return `${who}'s ${what} on ${where} was reinstated.`;
      case 'extend': return `${who}'s ${what} on ${where} was extended.`;
      case 'shorten': return `${who}'s ${what} on ${where} was shortened.`;
      case 'time_box': return `${who}'s ${what} on ${where} now has an end date.`;
      case 'mute': return `Some of ${what} was switched off for ${who} on ${where}.`;
      case 'read_only': return `${who}'s ${what} on ${where} was made ${snap.read_only === true ? 'read-only' : 'editable again'}.`;
      case 'limit_change': return `${who}'s limits under ${what} on ${where} changed.`;
      case 'delete': return `${who}'s ${what} on ${where} was deleted.`;
      case 'baseline': return `${who} had ${what} on ${where} when the access log started.`;
      default: return `${who}'s ${what} on ${where} changed.`;
    }
  }
  if (domain === 'role' || domain === 'permission_set') {
    const noun = domain === 'role' ? 'Role' : 'Permission set';
    const name = e.subjectName || str(snap.name) || noun.toLowerCase();
    if (verb === 'publish') {
      const adds = pairSentence(pairs(e.after?.adds));
      const removes = pairSentence(pairs(e.after?.removes));
      const parts = [adds && `adds: ${adds}`, removes && `removes: ${removes}`].filter(Boolean);
      return parts.length ? `${noun} "${name}" has a new Current — ${parts.join('; ')}.` : `${noun} "${name}" has a new Current (no grant changes).`;
    }
    if (verb === 'create') return `${noun} "${name}" was created.`;
    if (verb === 'archive') return `${noun} "${name}" was archived.`;
    if (verb === 'deprecate') return `${noun} "${name}" takes no new people.`;
    if (verb === 'activate') return `${noun} "${name}" is active.`;
    if (verb === 'delete') return `${noun} "${name}" was deleted.`;
    return `${noun} "${name}" settings changed.`;
  }
  if (domain === 'envelope') return verb === 'create' ? 'Client limits were set up for a client.' : "A client's limits changed.";
  if (domain === 'review') {
    if (verb === 'start') return `Access review "${str(e.after?.name)}" started.`;
    if (verb === 'close') return 'An access review was closed.';
    if (verb === 'decision') return `Access review: ${who}'s access — ${str(e.after?.decision) || 'decided'}.`;
  }
  if (domain === 'request') {
    const map: Record<string, string> = {
      create: `${who} asked for access.`,
      approve: `${who}'s access request was approved.`,
      deny: `${who}'s access request was declined.`,
      confirm: `A second approver confirmed ${who}'s access request.`,
      cancel: `${who} withdrew an access request.`,
      expire: `${who}'s access request expired undecided.`,
    };
    return map[verb] ?? `${who}'s access request changed.`;
  }
  if (domain === 'template_update') {
    if (verb === 'suggest') return `MeritBooks suggested updates for ${str(e.after?.role_name) || 'a role'}.`;
    if (verb === 'adopt') return 'MeritBooks suggestions were added to a role.';
    if (verb === 'dismiss') return 'MeritBooks suggestions were skipped.';
  }
  if (e.event === 'log.export') return 'The access log was exported.';
  if (e.event === 'review.export') return 'An access review report was exported.';
  return e.event;
}

/** Filter groups for the access-log event picker. */
export const LOG_EVENT_GROUPS: ReadonlyArray<{ key: string; label: string; prefixes: string[] }> = [
  { key: 'grants', label: 'Access given', prefixes: ['assignment.grant', 'assignment.grant_pending', 'assignment.approve', 'assignment.reinstate', 'assignment.baseline'] },
  { key: 'removals', label: 'Access removed or ended', prefixes: ['assignment.revoke', 'assignment.expire', 'assignment.end', 'assignment.delete', 'assignment.suspend'] },
  { key: 'changes', label: 'Access changed', prefixes: ['assignment.mute', 'assignment.read_only', 'assignment.limit_change', 'assignment.extend', 'assignment.shorten', 'assignment.time_box', 'assignment.update'] },
  { key: 'roles', label: 'Roles & permission sets', prefixes: ['role.', 'permission_set.', 'envelope.', 'template_update.'] },
  { key: 'reviews', label: 'Access reviews', prefixes: ['review.'] },
  { key: 'requests', label: 'Access requests', prefixes: ['request.'] },
];
