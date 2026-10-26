/**
 * Firm mapping memory (spec §7.2) — pure key normalization and the rule recompute.
 *
 * Approving a mapping on a client writes (or reinforces) a rule in the firm's mapping set,
 * keyed by the source account NUMBER (when it has one) and by its normalized NAME. Each
 * client's answer is one evidence row. The rule's answer is the settled target when the
 * accounting manager settled it, else the answer most clients gave (ties → the earliest).
 * `conflict` is true when any client's answer differs from the rule's — that rule can't
 * land in Ready on its own until someone settles it.
 */

/** Exact-number key: trimmed, internal spaces dropped. Null when there is no number. */
export function numberKey(number: string | null | undefined): string | null {
  const k = (number ?? '').trim().replace(/\s+/g, '');
  return k.length > 0 && k.length <= 60 && /\d/.test(k) ? k : null;
}

/**
 * Name key: lowercase, account-number prefix and punctuation dropped, "&"→"and", common
 * noise words removed ("expense", "exp", "account"), whitespace collapsed.
 * "6125 · Truck Fuel – Installers" → "truck fuel installers".
 */
export function nameKey(name: string | null | undefined): string | null {
  let s = (name ?? '').toLowerCase();
  s = s.replace(/^\s*[\d.-]+\s*[·:\-–—]?\s*/, '');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  s = s.replace(/\b(expenses?|exp|accounts?|acct)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length >= 2 ? s.slice(0, 200) : null;
}

export interface RuleKey {
  matchKind: 'exact_number' | 'normalized_name';
  matchValue: string;
}

/** The rule keys a decision on this source account writes. */
export function ruleKeysFor(source: { number: string | null; name: string }): RuleKey[] {
  const out: RuleKey[] = [];
  const n = numberKey(source.number);
  if (n) out.push({ matchKind: 'exact_number', matchValue: n });
  const m = nameKey(source.name);
  if (m) out.push({ matchKind: 'normalized_name', matchValue: m });
  return out;
}

export interface Evidence {
  locationId: string;
  targetAccountId: string;
  decidedAt: string;
}

export interface RuleState {
  targetAccountId: string;
  /** Clients whose answer equals the rule's answer. */
  evidenceCount: number;
  conflict: boolean;
}

/** Recompute a rule from its evidence (one row per client) and an optional settled answer. */
export function recomputeRule(evidence: ReadonlyArray<Evidence>, settledTargetId: string | null): RuleState | null {
  if (evidence.length === 0 && !settledTargetId) return null;
  let target = settledTargetId;
  if (!target) {
    const tally = new Map<string, { n: number; first: string }>();
    for (const e of evidence) {
      const t = tally.get(e.targetAccountId);
      if (t) {
        t.n++;
        if (e.decidedAt < t.first) t.first = e.decidedAt;
      } else tally.set(e.targetAccountId, { n: 1, first: e.decidedAt });
    }
    let best: [string, { n: number; first: string }] | null = null;
    for (const entry of tally) {
      if (!best || entry[1].n > best[1].n || (entry[1].n === best[1].n && entry[1].first < best[1].first)) best = entry;
    }
    target = best ? best[0] : null;
  }
  if (!target) return null;
  const agree = evidence.filter((e) => e.targetAccountId === target).length;
  return { targetAccountId: target, evidenceCount: agree, conflict: evidence.some((e) => e.targetAccountId !== target) };
}

/** Which mapping-set family a source system belongs to. */
export function familyFor(systemId: string | null | undefined): 'quickbooks' | 'xero' | 'sage_intacct' | 'sage_50' | 'sage_desktop' | 'netsuite' | 'generic' {
  switch (systemId) {
    case 'quickbooks':
    case 'quickbooks-desktop':
      return 'quickbooks';
    case 'xero':
      return 'xero';
    case 'sage-intacct':
      return 'sage_intacct';
    case 'sage-50':
      return 'sage_50';
    case 'sage-100-300':
    case 'sage-100-contractor':
      return 'sage_desktop';
    case 'netsuite':
      return 'netsuite';
    default:
      return 'generic';
  }
}

export const FAMILY_LABEL: Record<ReturnType<typeof familyFor>, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
  sage_intacct: 'Sage Intacct',
  sage_50: 'Sage 50',
  sage_desktop: 'Sage desktop',
  netsuite: 'NetSuite',
  generic: 'Other systems',
};
