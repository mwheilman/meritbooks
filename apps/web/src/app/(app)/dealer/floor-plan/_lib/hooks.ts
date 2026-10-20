'use client';

/**
 * Slice D2-B client hooks: batched note references (invoice #, unit serial, line,
 * balance) for rows that only carry a `note_id`, and "who am I" for
 * separation-of-duties hints (the server is still the authority).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { dealerGet, useDealerClient } from '../../_lib/use-dealer';
import type { NoteRef } from './types';

const refCache = new Map<string, NoteRef>();

/** Resolve note ids → NoteRef (cached per session; call `invalidateNoteRefs` after a write). */
export function useNoteRefs(ids: Array<string | null | undefined>, version = 0): { refs: Map<string, NoteRef>; loading: boolean } {
  const { locationId } = useDealerClient();
  const unique = useMemo(
    () => [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.join(',')],
  );
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!locationId) return;
    const missing = unique.filter((id) => !refCache.has(`${locationId}:${id}`));
    if (missing.length === 0) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const res = await dealerGet<{ items: NoteRef[] }>('/api/dealer/note-refs', locationId, { ids: chunk.join(',') });
        for (const it of res.data?.items ?? []) refCache.set(`${locationId}:${it.id}`, it);
      }
      if (!cancelled) {
        setLoading(false);
        setTick((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unique, locationId, version]);

  const refs = useMemo(() => {
    const m = new Map<string, NoteRef>();
    if (!locationId) return m;
    for (const id of unique) {
      const hit = refCache.get(`${locationId}:${id}`);
      if (hit) m.set(id, hit);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, locationId, tick, version]);

  return { refs, loading };
}

/** Drop cached refs (balances/status change after payments). */
export function invalidateNoteRefs(ids?: string[]): void {
  if (!ids) {
    refCache.clear();
    return;
  }
  for (const k of [...refCache.keys()]) if (ids.some((id) => k.endsWith(`:${id}`))) refCache.delete(k);
}

/** The signed-in person's id (Clerk) — matches proposed_by / prepared_by on dealer rows. */
export function useMe(): string | null {
  const { userId } = useAuth();
  return userId ?? null;
}

/** "You" / "A colleague" / "—" for an actor id. */
export function actorLabel(actor: string | null | undefined, me: string | null): string {
  if (!actor) return '—';
  if (actor.startsWith('autonomy:')) return 'Automatic (autonomy rule)';
  return me && actor === me ? 'You' : 'A colleague';
}
