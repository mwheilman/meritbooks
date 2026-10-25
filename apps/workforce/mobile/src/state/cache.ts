/**
 * A read the phone keeps for offline: show the saved copy at once (sealed in SQLite, lib/kv.ts),
 * refresh it when there is signal, keep the saved copy and say how old it is when the refresh
 * fails. Used by the Wave C screens (drawings, sell options, repair orders, my pay).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, setJson } from '@/lib/kv';

export interface Cached<T> {
  value: T | null;
  /** When the saved copy was fetched (ms), or null. */
  at: number | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useCached<T>(key: string | null, guard: (v: unknown) => v is T, load: () => Promise<T>, online: boolean): Cached<T> {
  const [value, setValue] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!key);
  const loadRef = useRef(load);
  loadRef.current = load;
  const guardRef = useRef(guard);
  guardRef.current = guard;

  const refresh = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const fresh = await loadRef.current();
      setValue(fresh);
      setAt(Date.now());
      setError(null);
      await setJson(key, fresh).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not available right now.');
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    let alive = true;
    setValue(null);
    setAt(null);
    setError(null);
    if (!key) {
      setLoading(false);
      return undefined;
    }
    void getJson(key, (v): v is T => guardRef.current(v)).then((saved) => {
      if (!alive) return;
      if (saved) {
        setValue(saved.value);
        setAt(saved.updatedAt);
      }
      if (online) void refresh();
      else setLoading(false);
    });
    return () => {
      alive = false;
    };
    // online is read once per key; screens call refresh() on pull / when signal returns
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);

  return { value, at, error, loading, refresh };
}
