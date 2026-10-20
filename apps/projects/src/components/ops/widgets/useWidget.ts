'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@meritbooks/merit-ui';
import type { WidgetKey } from '@/lib/pm/ops/widget-queries';

export interface WidgetPlacement {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Narrow the widget to one company of the current view (default: every company in view). */
  companyId?: string;
}

/** GET /api/ops/widgets/<key>, with a retry for the error state. */
export function useWidget<T>(key: WidgetKey, companyId?: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await api.get<T>(`/api/ops/widgets/${key}${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`);
    if (r.error) setError(r.error.error);
    else setData(r.data);
  }, [key, companyId]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, reload: load };
}
