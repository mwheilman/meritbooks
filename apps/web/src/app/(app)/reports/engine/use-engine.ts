'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@meritbooks/merit-ui';
import type { CompanyMeta, DrillRequest, DrillResult, ReportRequest, ReportResult } from '@/lib/reports/engine/types';
import type { LayoutSummary } from '@/lib/reports/engine/layouts-store';
import type { ReportPref } from '@/lib/reports/engine/prefs';

export interface EngineMeta {
  companies: CompanyMeta[];
  departments: Array<{ id: string; name: string; code: string | null }>;
  classes: Array<{ id: string; name: string; code: string | null }>;
  accountGroups: Array<{ id: string; name: string; type: string; subType: string }>;
  accounts: Array<{ id: string; number: string; name: string; type: string; groupId: string }>;
  roles: string[];
  layouts: LayoutSummary[];
  fyStartMonth: number;
}

interface Envelope<T> {
  data: T;
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  code: string | null;
  loading: boolean;
  reload: () => void;
}

function useAsync<T>(fn: (() => Promise<{ data: T | null; error: string | null; code: string | null }>) | null, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; code: string | null; loading: boolean }>({ data: null, error: null, code: null, loading: !!fn });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!fn) {
      setState({ data: null, error: null, code: null, loading: false });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null, code: null }));
    void fn().then((r) => {
      if (mine !== seq.current) return; // a newer request superseded this one
      setState({ data: r.data, error: r.error, code: r.code, loading: false });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export function useEngineMeta(): AsyncState<EngineMeta> {
  return useAsync<EngineMeta>(async () => {
    const r = await api.get<Envelope<EngineMeta>>('/api/reports/engine/meta');
    return { data: r.data?.data ?? null, error: r.error?.error ?? null, code: r.error?.code ?? null };
  }, []);
}

/** Run a report; re-runs whenever the serialized request changes. */
export function useReport(request: ReportRequest | null, reportKey: string): AsyncState<ReportResult> {
  const body = request ? JSON.stringify({ ...request, reportKey }) : null;
  return useAsync<ReportResult>(
    body
      ? async () => {
          const r = await api.post<Envelope<ReportResult>>('/api/reports/engine/run', JSON.parse(body));
          return { data: r.data?.data ?? null, error: r.error?.error ?? null, code: r.error?.code ?? null };
        }
      : null,
    [body],
  );
}

export async function fetchDrill(req: DrillRequest): Promise<{ data: DrillResult | null; error: string | null }> {
  const r = await api.post<Envelope<DrillResult>>('/api/reports/engine/drill', req);
  return { data: r.data?.data ?? null, error: r.error?.error ?? null };
}

export function usePrefs(): AsyncState<ReportPref[]> & { toggle: (key: string, favorite: boolean) => Promise<void> } {
  const s = useAsync<ReportPref[]>(async () => {
    const r = await api.get<Envelope<ReportPref[]>>('/api/reports/engine/prefs');
    return { data: r.data?.data ?? [], error: r.error?.error ?? null, code: r.error?.code ?? null };
  }, []);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const toggle = useCallback(async (key: string, favorite: boolean) => {
    setOptimistic((o) => ({ ...o, [key]: favorite }));
    const r = await api.post('/api/reports/engine/prefs', { reportKey: key, favorite });
    if (r.error) setOptimistic((o) => ({ ...o, [key]: !favorite }));
  }, []);
  const data = s.data
    ? (() => {
        const map = new Map(s.data.map((p) => [p.reportKey, { ...p }]));
        for (const [k, v] of Object.entries(optimistic)) {
          const cur = map.get(k) ?? { reportKey: k, isFavorite: false, runCount: 0, lastRunAt: null };
          map.set(k, { ...cur, isFavorite: v });
        }
        return [...map.values()];
      })()
    : null;
  return { ...s, data, toggle };
}

export interface SavedView {
  id: string;
  name: string;
  report_key: string;
  config: { engine?: Record<string, unknown>; query?: string } & Record<string, unknown>;
  created_at: string;
}

export function useSavedViews(): AsyncState<SavedView[]> {
  return useAsync<SavedView[]>(async () => {
    const r = await api.get<{ available: boolean; views: SavedView[] }>('/api/reports/views');
    return { data: r.data?.views ?? [], error: r.error?.error ?? null, code: r.error?.code ?? null };
  }, []);
}
