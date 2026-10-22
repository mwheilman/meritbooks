'use client';

import { useCallback, useState } from 'react';
import { useQuery, type ApiError } from '@meritbooks/merit-ui';
import { useAction } from '@/components/job/useAction';

export interface StoreFailure {
  text: string;
  code: string;
}

/**
 * The store's mutation path: useAction (toast the verb, refresh the server page) plus the last
 * failure WITH its code, because the desk reacts to specific tokens (a payoff that needs an
 * acknowledgement, a deal below the margin floor). `version` moves on every call so open panels
 * refetch.
 */
export function useStore() {
  const { run, busy } = useAction();
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState<StoreFailure | null>(null);

  const act = useCallback(
    async <T,>(key: string, method: 'post' | 'patch' | 'delete', url: string, body: unknown, ok: string | ((d: T) => string | null)): Promise<{ data: T | null; error: ApiError | null }> => {
      const r = await run<T>(key, method, url, body, ok, { quietError: true });
      setVersion((v) => v + 1);
      if (r.error) {
        setFailure({ text: r.error.error, code: r.error.code });
        return { data: null, error: r.error };
      }
      setFailure(null);
      return { data: r.data, error: null };
    },
    [run],
  );

  return { act, busy, version, failure, error: failure?.text ?? null, clearFailure: () => setFailure(null) };
}

/** GET a panel's detail, refetched whenever `version` moves. */
export function useStoreDetail<T>(url: string | null, version: number) {
  return useQuery<T>(url, undefined, { key: String(version), scope: false });
}
