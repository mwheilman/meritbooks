'use client';

/**
 * URL-synced screen state for the dealer claim screens (`?status=`, `?claim=`,
 * `?tab=`, `?aging=`): deep links from tiles, reports and exceptions land on the
 * same view, and Back/Forward keep working. Writes use router.replace (no history
 * spam, no scroll jump).
 */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export function useUrlParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname() ?? '';
  const serialized = sp?.toString() ?? '';

  const get = useCallback((key: string): string | null => new URLSearchParams(serialized).get(key), [serialized]);

  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(serialized);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      router.replace(s ? `${path}?${s}` : path, { scroll: false });
    },
    [serialized, router, path],
  );

  return { get, set };
}
