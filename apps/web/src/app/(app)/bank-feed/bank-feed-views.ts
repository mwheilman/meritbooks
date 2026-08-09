/**
 * Bank-feed SAVED VIEWS — pure serialization/mutation helpers for a purely LOCAL,
 * view-only "saved filter" feature. A view captures the reviewer's current lens
 * (status tab, confidence band, vendor, search text, sort) so they can jump back
 * to "my low-confidence uncategorized queue" in one click.
 *
 * This writes NOTHING to the server — no ledger post, no status change, no money
 * movement. It is a per-browser convenience persisted in localStorage (the React
 * hook in `use-bank-feed-views.ts` handles storage + org/company namespacing).
 *
 * These functions are deterministic and unit-tested; the hook stays a thin shell.
 */

import type { ConfidenceBandFilter } from './bank-feed-refine';
import type { SortField, SortDir } from './bank-feed-content';

export interface SavedView {
  id: string;
  name: string;
  /** Status tab key: 'all' | 'PENDING' | 'CATEGORIZED' | 'FLAGGED'. */
  status: string;
  band: ConfidenceBandFilter;
  vendor: string | null;
  search: string;
  sortField: SortField;
  sortDir: SortDir;
}

const VALID_BANDS: ConfidenceBandFilter[] = ['all', 'high', 'medium', 'low', 'uncoded'];
const VALID_SORT_FIELDS: SortField[] = ['date', 'amount', 'confidence', 'vendor', 'company'];
const VALID_SORT_DIRS: SortDir[] = ['asc', 'desc'];

/** The lens portion of a view (everything except identity). */
export type ViewLens = Omit<SavedView, 'id' | 'name'>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Coerce arbitrary parsed JSON into a valid SavedView, or null if unusable. */
export function normalizeView(raw: unknown): SavedView | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  if (!id || !name) return null;

  const band = VALID_BANDS.includes(raw.band as ConfidenceBandFilter)
    ? (raw.band as ConfidenceBandFilter)
    : 'all';
  const sortField = VALID_SORT_FIELDS.includes(raw.sortField as SortField)
    ? (raw.sortField as SortField)
    : 'confidence';
  const sortDir = VALID_SORT_DIRS.includes(raw.sortDir as SortDir)
    ? (raw.sortDir as SortDir)
    : 'asc';

  return {
    id,
    name,
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'all',
    band,
    vendor: typeof raw.vendor === 'string' && raw.vendor ? raw.vendor : null,
    search: typeof raw.search === 'string' ? raw.search : '',
    sortField,
    sortDir,
  };
}

/** Parse a localStorage payload into a clean, de-duplicated list of views. */
export function parseViews(raw: string | null | undefined): SavedView[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SavedView[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const v = normalizeView(item);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}

export function serializeViews(views: SavedView[]): string {
  return JSON.stringify(views);
}

/** Stable-ish id for a new view (no crypto dependency for the test harness). */
export function newViewId(now: number = Date.now()): string {
  return `v_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Insert or replace a view. Matching is by trimmed, case-insensitive name so
 * "Save" over an existing name updates it in place rather than duplicating.
 */
export function upsertView(views: SavedView[], view: SavedView): SavedView[] {
  const key = view.name.trim().toLowerCase();
  const idx = views.findIndex((v) => v.name.trim().toLowerCase() === key);
  if (idx === -1) return [...views, view];
  const next = views.slice();
  next[idx] = { ...view, id: views[idx].id };
  return next;
}

export function removeView(views: SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}
