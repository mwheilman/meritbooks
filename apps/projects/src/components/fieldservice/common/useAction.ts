'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, toast } from '@meritbooks/merit-ui';

/**
 * One POST action for the field-service completion screens: busy flag, the plain-language error
 * from the route, a toast on success and a server refresh so the page shows the new state.
 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, url: string, body: Record<string, unknown>, done?: string | ((d: T) => string | null)): Promise<T | null> => {
    setBusy(key);
    setError(null);
    const r = await api.post<T>(url, body);
    setBusy(null);
    if (r.error) {
      setError(r.error.error);
      return null;
    }
    const msg = typeof done === 'function' ? done(r.data as T) : done;
    if (msg) toast(msg);
    router.refresh();
    return r.data;
  }, [router]);
  return { run, busy, error, setError };
}

export const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export const fmtPhone = (p: string | null | undefined): string => {
  const d = (p ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p ?? '—';
};

export const words = (s: string | null | undefined): string => (s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
