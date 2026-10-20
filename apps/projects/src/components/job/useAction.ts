'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, toast, type ApiResponse } from '@meritbooks/merit-ui';

type Method = 'post' | 'patch' | 'delete';

/**
 * One mutation path for the job page: call the route, toast the verb on success
 * (or the route's plain-language error), then refresh the server-rendered data.
 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(key: string, method: Method, url: string, body?: unknown, ok?: string | ((d: T) => string | null), opts: { quietError?: boolean } = {}): Promise<ApiResponse<T>> => {
      setBusy(key);
      const res = method === 'delete' ? await api.delete<T>(url) : method === 'patch' ? await api.patch<T>(url, body ?? {}) : await api.post<T>(url, body ?? {});
      setBusy(null);
      if (res.error) {
        if (!opts.quietError) toast.error(res.error.error);
        return res;
      }
      const msg = typeof ok === 'function' ? ok(res.data as T) : ok;
      if (msg) toast(msg);
      router.refresh();
      return res;
    },
    [router],
  );

  return { run, busy };
}
