/**
 * Base vocabulary. Every VOCAB_KEY has a default here; packs override a subset with real
 * industry terms. The UI always reads through `t()` so a missing key never renders blank.
 */
import { VOCAB_KEYS, type VocabKey } from './types';

export const DEFAULT_VOCAB: Readonly<Record<VocabKey, string>> = Object.freeze({
  job: 'Job',
  jobs: 'Jobs',
  customer: 'Customer',
  customers: 'Customers',
  estimate: 'Estimate',
  estimates: 'Estimates',
  change_order: 'Change order',
  change_orders: 'Change orders',
  commitment: 'Commitment',
  commitments: 'Commitments',
  subcontractor: 'Subcontractor',
  subcontractors: 'Subcontractors',
  billing: 'Billing',
  invoice_request: 'Billing request',
  task: 'Task',
  tasks: 'Tasks',
  daily_log: 'Daily log',
  daily_logs: 'Daily logs',
  work_order: 'Work order',
  work_orders: 'Work orders',
  crew: 'Crew',
  crews: 'Crews',
  site: 'Site',
  phase: 'Phase',
  phases: 'Phases',
  selection: 'Selection',
  selections: 'Selections',
  draw: 'Draw',
  draws: 'Draws',
  pm: 'Project manager',
  superintendent: 'Superintendent',
});

/**
 * Singular/plural pairs. A pack that renames one side must rename the other, or the UI ends up
 * saying "1 Repair order" next to "Jobs".
 */
export const VOCAB_PAIRS: ReadonlyArray<readonly [VocabKey, VocabKey]> = [
  ['job', 'jobs'],
  ['customer', 'customers'],
  ['estimate', 'estimates'],
  ['change_order', 'change_orders'],
  ['commitment', 'commitments'],
  ['subcontractor', 'subcontractors'],
  ['task', 'tasks'],
  ['daily_log', 'daily_logs'],
  ['work_order', 'work_orders'],
  ['crew', 'crews'],
  ['phase', 'phases'],
  ['selection', 'selections'],
  ['draw', 'draws'],
];

export function isVocabKey(key: string): key is VocabKey {
  return (VOCAB_KEYS as readonly string[]).includes(key);
}

/** Fully resolved vocabulary: defaults for every base key, then the overrides (base keys only). */
export function resolveVocabulary(overrides: Record<string, string> | undefined): Record<VocabKey, string> {
  const out = { ...DEFAULT_VOCAB } as Record<VocabKey, string>;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (isVocabKey(k) && typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return out;
}

/** Look up a term. Falls back to the default, then to the key itself. */
export function t(vocab: Partial<Record<string, string>> | undefined, key: VocabKey): string {
  const v = vocab?.[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return DEFAULT_VOCAB[key] ?? key;
}

/** Lower-cased term for use mid-sentence ("3 repair orders"). Keeps acronyms like "RO" or "T&M". */
export function tLower(vocab: Partial<Record<string, string>> | undefined, key: VocabKey): string {
  return t(vocab, key)
    .split(' ')
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ');
}
