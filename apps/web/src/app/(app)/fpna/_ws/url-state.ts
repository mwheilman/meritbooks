'use client';

/**
 * /fpna view state in the URL (shareable, bookmarkable): tab · companies · weighting · range ·
 * by · from · dashboard. The period keys (period · basis · compare) belong to usePeriodParam.
 * Writes use history.replaceState (no navigation), keeping every other query key.
 */
import { useCallback, useEffect, useState } from 'react';
import { FPNA_TABS, type FpnaTab } from '@/lib/fpna/workspace/types';

export type ProfitBy = 'company' | 'department' | 'class' | 'job' | 'customer';

export interface WsUrlState {
  tab: FpnaTab;
  companies: string[];
  weighting: 'full' | 'ownership';
  range: '12' | '24' | '36';
  by: ProfitBy;
  from: string | null;
  dashboard: string | null;
}

const DEFAULTS: WsUrlState = { tab: 'dashboard', companies: [], weighting: 'full', range: '12', by: 'company', from: null, dashboard: null };
const BY: readonly ProfitBy[] = ['company', 'department', 'class', 'job', 'customer'];

function read(): WsUrlState {
  if (typeof window === 'undefined') return DEFAULTS;
  const q = new URLSearchParams(window.location.search);
  const tab = q.get('tab');
  const range = q.get('range');
  const by = q.get('by');
  const from = q.get('from');
  return {
    tab: tab && (FPNA_TABS as readonly string[]).includes(tab) ? (tab as FpnaTab) : DEFAULTS.tab,
    companies: (q.get('companies') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    weighting: q.get('weighting') === 'ownership' ? 'ownership' : 'full',
    range: range === '24' || range === '36' ? range : '12',
    by: by && (BY as readonly string[]).includes(by) ? (by as ProfitBy) : 'company',
    from: from && /^\d{4}-\d{2}$/.test(from) ? from : null,
    dashboard: q.get('dashboard'),
  };
}

function write(s: WsUrlState): void {
  const q = new URLSearchParams(window.location.search);
  const set = (k: string, v: string | null, dflt: string | null) => (v && v !== dflt ? q.set(k, v) : q.delete(k));
  set('tab', s.tab, 'dashboard');
  set('companies', s.companies.join(',') || null, null);
  set('weighting', s.weighting, 'full');
  set('range', s.range, '12');
  set('by', s.by, 'company');
  set('from', s.from, null);
  set('dashboard', s.dashboard, null);
  const qs = q.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

export function useWsUrlState(): [WsUrlState, (patch: Partial<WsUrlState>) => void, boolean] {
  const [state, setState] = useState<WsUrlState>(DEFAULTS);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setState(read());
    setReady(true);
  }, []);
  const update = useCallback((patch: Partial<WsUrlState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      write(next);
      return next;
    });
  }, []);
  return [state, update, ready];
}
