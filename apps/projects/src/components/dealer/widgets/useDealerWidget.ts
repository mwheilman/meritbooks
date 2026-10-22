'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@meritbooks/merit-ui';
import type { DealerWidgetKey } from '@/lib/pm/dealer/widget-queries';

export interface DealerWidgetPlacement {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Narrow to one company of the current view (default: every dealer company in view). */
  companyId?: string;
}

/** GET /api/dealer/widgets/<key>, with a retry for the error state. */
export function useDealerWidget<T>(key: DealerWidgetKey, companyId?: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await api.get<T>(`/api/dealer/widgets/${key}${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`);
    if (r.error) setError(r.error.error);
    else setData(r.data);
  }, [key, companyId]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, reload: load };
}
