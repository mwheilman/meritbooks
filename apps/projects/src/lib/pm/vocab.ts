/**
 * Vocabulary from `pm.v_vocabulary`, falling back to DEFAULT_VOCAB for every base
 * key (a missing or blank term never renders empty). Pure (unit-tested).
 */
import { DEFAULT_VOCAB, resolveVocabulary, type VocabKey } from '@/lib/packs';

export type Vocabulary = Record<VocabKey, string>;

export interface VocabRow {
  location_id: string;
  vocab_key: string;
  label: string | null;
}

/** One company's terms. */
export function vocabularyFrom(rows: ReadonlyArray<VocabRow>, locationId?: string | null): Vocabulary {
  const overrides: Record<string, string> = {};
  for (const r of rows) {
    if (locationId && r.location_id !== locationId) continue;
    if (typeof r.label === 'string') overrides[r.vocab_key] = r.label;
  }
  return resolveVocabulary(overrides);
}

/**
 * Workspace view across companies: a term is used only when every company with an
 * installed pack agrees on it; otherwise the neutral default ("Jobs").
 */
export function workspaceVocabulary(rows: ReadonlyArray<VocabRow>, locationIds: ReadonlyArray<string>): Vocabulary {
  if (locationIds.length === 0) return { ...DEFAULT_VOCAB };
  const per = locationIds.map((id) => vocabularyFrom(rows, id));
  const out = { ...DEFAULT_VOCAB } as Vocabulary;
  for (const key of Object.keys(DEFAULT_VOCAB) as VocabKey[]) {
    const first = per[0]?.[key];
    out[key] = first !== undefined && per.every((v) => v[key] === first) ? first : DEFAULT_VOCAB[key];
  }
  return out;
}

/** "jobs" → lower-cased mid-sentence term, keeping acronyms ("RO"). */
export function lower(term: string): string {
  return term
    .split(' ')
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ');
}
