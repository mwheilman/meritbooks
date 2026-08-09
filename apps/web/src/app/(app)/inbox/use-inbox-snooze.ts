'use client';

/**
 * INBOX SNOOZE — a purely LOCAL, view-only "remind me later" affordance.
 *
 * Snoozing hides a non-critical inbox row from the caller's own view until a
 * chosen time. It writes NOTHING to the server — no ledger post, no status
 * change, no money movement — it only records a per-browser preference in
 * localStorage. The underlying record is untouched and still counts toward the
 * header bell / server totals; a snoozed item simply drops out of *this* list
 * until it wakes. CRITICAL items are never snoozeable (see canSnooze).
 *
 * Org-scoping: the store is namespaced per Clerk org so switching tenants in the
 * same browser never leaks one org's snoozes into another's view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InboxSeverity } from './inbox-types';

type SnoozeMap = Record<string, number>; // itemId -> wake epoch ms

const KEY_PREFIX = 'mb.inbox.snooze';

export interface SnoozePreset {
  label: string;
  ms: number;
}

export const SNOOZE_PRESETS: SnoozePreset[] = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: 'Tomorrow', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** CRITICAL items can never be hidden — you don't get to snooze a fire. */
export function canSnooze(severity: InboxSeverity): boolean {
  return severity !== 'CRITICAL';
}

function storageKey(orgId: string | null | undefined): string {
  return `${KEY_PREFIX}.${orgId ?? 'default'}`;
}

function readStore(key: string): SnoozeMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SnoozeMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Drop entries whose wake time has already passed. Returns a fresh map. */
function pruneExpired(map: SnoozeMap, now: number): SnoozeMap {
  const out: SnoozeMap = {};
  for (const [id, wake] of Object.entries(map)) {
    if (typeof wake === 'number' && wake > now) out[id] = wake;
  }
  return out;
}

export interface UseInboxSnooze {
  /** True when the item is currently snoozed (wake time still in the future). */
  isSnoozed: (id: string) => boolean;
  /** Snooze an item for `ms` from now. */
  snooze: (id: string, ms: number) => void;
  /** Wake an item immediately (undo snooze). */
  unsnooze: (id: string) => void;
  /** How many items are currently snoozed. */
  snoozedCount: number;
  /** The active snooze ids (for filtering the visible list). */
  snoozedIds: Set<string>;
}

export function useInboxSnooze(orgId: string | null | undefined): UseInboxSnooze {
  const key = useMemo(() => storageKey(orgId), [orgId]);
  const [map, setMap] = useState<SnoozeMap>({});

  // Load + prune on mount / org change.
  useEffect(() => {
    const pruned = pruneExpired(readStore(key), Date.now());
    setMap(pruned);
    try {
      window.localStorage.setItem(key, JSON.stringify(pruned));
    } catch {
      /* storage unavailable — snooze silently becomes a no-op */
    }
  }, [key]);

  const persist = useCallback(
    (next: SnoozeMap) => {
      setMap(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key],
  );

  const snooze = useCallback(
    (id: string, ms: number) => {
      persist({ ...pruneExpired(map, Date.now()), [id]: Date.now() + ms });
    },
    [map, persist],
  );

  const unsnooze = useCallback(
    (id: string) => {
      const next = { ...map };
      delete next[id];
      persist(pruneExpired(next, Date.now()));
    },
    [map, persist],
  );

  const snoozedIds = useMemo(() => {
    const now = Date.now();
    return new Set(Object.entries(map).filter(([, wake]) => wake > now).map(([id]) => id));
  }, [map]);

  const isSnoozed = useCallback((id: string) => snoozedIds.has(id), [snoozedIds]);

  return { isSnoozed, snooze, unsnooze, snoozedCount: snoozedIds.size, snoozedIds };
}
