'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import {
  clampSelection,
  matchPreset,
  presetSelection,
  resolvePeriod,
  type PeriodBasis,
  type PeriodComparison,
  type PeriodPresetId,
  type PeriodSelection,
  type ResolvedPeriod,
} from '@/lib/period/resolve';
import { parsePeriodQuery, sameSelection, withPeriodQuery } from '@/lib/period/url';
import { fromPreferenceSample, preferenceKey, readRemembered, toPreferenceSample, toRemembered, writeRemembered, type RememberedPeriod } from '@/lib/period/memory';
import { usePeriodContext, type PeriodContextData } from './use-period-context';

export interface UsePeriodParamOptions {
  /** Stable per-page key for "remember my last choice" ('fpna', 'rev-rec.reports', …). */
  pageKey: string;
  /** Used when the URL and memory are silent. */
  defaultPreset?: Exclude<PeriodPresetId, 'custom'>;
  /** Bases this page can compute. Default: all. A month-only report passes ['month']. */
  bases?: readonly PeriodBasis[];
  /** Comparisons this page can compute (omit → comparison is always 'none'). */
  comparisons?: readonly PeriodComparison[];
  defaultCompare?: PeriodComparison;
  /** Query-key prefix when a page hosts two pickers. */
  prefix?: string;
  /** Keep the URL in sync (default true). */
  syncUrl?: boolean;
}

export interface UsePeriodParamResult {
  selection: PeriodSelection;
  period: ResolvedPeriod;
  setSelection: (next: PeriodSelection) => void;
  /** True once the fiscal calendar and the initial choice are known — gate the first fetch on it. */
  ready: boolean;
  context: PeriodContextData;
  /** The props to spread onto <PeriodPicker>. */
  pickerProps: {
    value: PeriodSelection;
    onChange: (next: PeriodSelection) => void;
    context: PeriodContextData;
    bases?: readonly PeriodBasis[];
    comparisons?: readonly PeriodComparison[];
  };
}

function allowedSel(sel: PeriodSelection, bases?: readonly PeriodBasis[], comparisons?: readonly PeriodComparison[]): PeriodSelection | null {
  if (bases && !bases.includes(sel.basis)) return null;
  const cmp = sel.compare ?? 'none';
  if (cmp !== 'none' && (!comparisons || !comparisons.includes(cmp))) return { ...sel, compare: 'none' };
  return sel;
}

function fromRemembered(r: RememberedPeriod, ctx: PeriodContextData): PeriodSelection {
  if ('preset' in r) return { ...presetSelection(r.preset, ctx), ...(r.compare ? { compare: r.compare } : {}) };
  return r.selection;
}

/**
 * Page period state: URL first (shareable, absolute), then this browser's last choice for the
 * page, then the org's learned usual choice, then `defaultPreset`. Writes go to the URL
 * (history.replaceState — no navigation, no Suspense requirement), to per-page memory, and as
 * one observation to the learned-preference store.
 */
export function usePeriodParam(opts: UsePeriodParamOptions): UsePeriodParamResult {
  const { pageKey, defaultPreset = 'last_month', bases, comparisons, defaultCompare = 'none', prefix = '', syncUrl = true } = opts;
  const { context, ready: ctxReady } = usePeriodContext();
  const [sel, setSel] = useState<PeriodSelection | null>(null);
  const [initDone, setInitDone] = useState(false);
  const touched = useRef(false);
  const basesKey = (bases ?? []).join(',');
  const cmpKey = (comparisons ?? []).join(',');

  const fallback = useCallback(
    (ctx: PeriodContextData): PeriodSelection => {
      const ps = presetSelection(defaultPreset, ctx);
      const base: PeriodSelection = !bases || bases.includes(ps.basis) ? ps : { basis: bases[0] ?? 'month', end: ctx.currentMonth };
      return allowedSel({ ...base, compare: defaultCompare }, bases, comparisons) ?? base;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultPreset, basesKey, cmpKey, defaultCompare],
  );

  // Initial choice — once the fiscal calendar is known.
  useEffect(() => {
    if (!ctxReady || initDone) return;
    let alive = true;
    const fromUrl = typeof window !== 'undefined' ? parsePeriodQuery(new URLSearchParams(window.location.search), prefix) : null;
    const urlSel = fromUrl ? allowedSel(fromUrl, bases, comparisons) : null;
    if (urlSel) {
      setSel({ ...urlSel, preset: matchPreset(urlSel, context) ?? undefined });
      setInitDone(true);
      return;
    }
    const mem = readRemembered(pageKey);
    const memSel = mem ? allowedSel(fromRemembered(mem, context), bases, comparisons) : null;
    if (memSel) {
      setSel(memSel);
      setInitDone(true);
      return;
    }
    // First visit on this browser: the org's learned usual choice, if it is confident.
    api
      .get<{ value: unknown; confidence: number }>('/api/learning/preferences', { scope: 'REPORT_PREFS', key: preferenceKey(pageKey) })
      .then((res) => {
        if (!alive || touched.current) return;
        const learned = res.data && res.data.confidence >= 0.5 ? fromPreferenceSample(res.data.value) : null;
        const lSel = learned ? allowedSel(fromRemembered(learned, context), bases, comparisons) : null;
        setSel(lSel ?? fallback(context));
        setInitDone(true);
      })
      .catch(() => {
        if (!alive) return;
        setSel(fallback(context));
        setInitDone(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxReady, initDone, pageKey, prefix]);

  // Back/forward: follow the URL.
  useEffect(() => {
    if (!syncUrl) return undefined;
    const onPop = () => {
      const u = parsePeriodQuery(new URLSearchParams(window.location.search), prefix);
      const ok = u ? allowedSel(u, bases, comparisons) : null;
      if (ok) setSel((cur) => (sameSelection(cur, ok) ? cur : { ...ok, preset: matchPreset(ok, context) ?? undefined }));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncUrl, prefix, basesKey, cmpKey, context]);

  const effective = useMemo(() => clampSelection(sel ?? fallback(context), context), [sel, fallback, context]);
  const period = useMemo(() => resolvePeriod(effective, context), [effective, context]);

  // Mirror into the URL once the choice is settled (so a reload/link reproduces it).
  useEffect(() => {
    if (!initDone || !syncUrl || typeof window === 'undefined') return;
    const next = withPeriodQuery(window.location.search, effective, prefix);
    if (next !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`);
    }
  }, [initDone, syncUrl, effective, prefix]);

  const lastObserved = useRef<string>('');
  const setSelection = useCallback(
    (next: PeriodSelection) => {
      touched.current = true;
      const ok = allowedSel(next, bases, comparisons);
      if (!ok) return;
      const clamped = clampSelection(ok, context);
      setSel(clamped);
      setInitDone(true);
      writeRemembered(pageKey, clamped);
      // One observation per distinct choice (fire-and-forget; degrade-safe server side).
      const sample = toPreferenceSample(toRemembered(clamped));
      const sig = JSON.stringify(sample);
      if (sig !== lastObserved.current) {
        lastObserved.current = sig;
        void api.post('/api/learning/preferences', { scope: 'REPORT_PREFS', key: preferenceKey(pageKey), sample });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageKey, basesKey, cmpKey, context],
  );

  return {
    selection: effective,
    period,
    setSelection,
    ready: ctxReady && initDone,
    context,
    pickerProps: { value: effective, onChange: setSelection, context, bases, comparisons },
  };
}
