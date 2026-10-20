'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@meritbooks/merit-ui';
import { useAction } from '@/components/job/useAction';

/**
 * The ops mutation path: useAction (toast + router.refresh) plus a version that refetches the
 * open panel's detail, and the last error kept for the inline notice.
 */
export function useOps() {
  const { run, busy } = useAction();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async <T,>(key: string, method: 'post' | 'patch' | 'delete', url: string, body: unknown, ok: string | ((d: T) => string | null)): Promise<T | null> => {
      const r = await run<T>(key, method, url, body, ok, { quietError: true });
      setVersion((v) => v + 1);
      if (r.error) {
        setError(r.error.error);
        return null;
      }
      setError(null);
      return r.data;
    },
    [run],
  );

  return { act, busy, version, error, clearError: () => setError(null) };
}

/** GET a panel's detail, refetched whenever `version` moves. */
export function useDetail<T>(url: string | null, version: number) {
  return useQuery<T>(url, undefined, { key: String(version), scope: false });
}
