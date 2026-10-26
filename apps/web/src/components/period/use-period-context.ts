'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import type { MonthCloseState } from '@/lib/period/closed';
import { currentMonthOf, normalizeFyStart, type MonthKey, type PeriodContext } from '@/lib/period/resolve';

export interface PeriodContextData extends PeriodContext {
  today: string;
  closedThrough: MonthKey | null;
  /** Close state per month for the companies in scope (missing month = no period set up). */
  months: Record<MonthKey, MonthCloseState>;
  /** Months before `closedThrough` still not closed (open months before the first close). */
  openBefore?: MonthKey[];
}

interface ContextResponse {
  data?: {
    fyStartMonth: number;
    today: string;
    currentMonth: MonthKey;
    closedThrough: MonthKey | null;
    months: Record<MonthKey, MonthCloseState>;
    openBefore?: MonthKey[];
  };
}

/** Before the first read: the browser's month, a calendar fiscal year, nothing known closed. */
export function fallbackPeriodContext(now: Date = new Date()): PeriodContextData {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { fyStartMonth: 1, today, currentMonth: currentMonthOf(today), closedThrough: null, months: {} };
}

// One read per scope per session: module cache (SPA navigation) + sessionStorage (hard reload).
const cache = new Map<string, PeriodContextData>();
const inflight = new Map<string, Promise<PeriodContextData | null>>();
const SS_KEY = 'mb.period.ctx.';

function readSession(scope: string): PeriodContextData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SS_KEY + scope);
    if (!raw) return null;
    const v = JSON.parse(raw) as PeriodContextData;
    // A cached context from an earlier day is still a fine first paint; it is refreshed below.
    return typeof v?.currentMonth === 'string' ? { ...v, fyStartMonth: normalizeFyStart(v.fyStartMonth) } : null;
  } catch {
    return null;
  }
}

function load(scope: string, locationId: string | null): Promise<PeriodContextData | null> {
  const existing = inflight.get(scope);
  if (existing) return existing;
  const p = api
    .get<ContextResponse>('/api/period/context', locationId ? { location_id: locationId } : undefined)
    .then((res) => {
      const d = res.data?.data;
      if (res.error || !d) return null;
      const v: PeriodContextData = {
        fyStartMonth: normalizeFyStart(d.fyStartMonth),
        today: d.today,
        currentMonth: currentMonthOf(d.today),
        closedThrough: d.closedThrough ?? null,
        months: d.months ?? {},
        openBefore: d.openBefore ?? [],
      };
      cache.set(scope, v);
      try {
        window.sessionStorage.setItem(SS_KEY + scope, JSON.stringify(v));
      } catch {
        /* ignore */
      }
      return v;
    })
    .catch(() => null)
    .finally(() => inflight.delete(scope));
  inflight.set(scope, p);
  return p;
}

/**
 * The org's fiscal calendar + close state for the active company scope. `ready` turns true once
 * a real (or session-cached) context is in hand — hosts gate their first data fetch on it so a
 * non-January fiscal year never causes a wrong-months fetch followed by a right one.
 */
export function usePeriodContext(): { context: PeriodContextData; ready: boolean; error: boolean } {
  const { activeCompanyId } = useActiveCompany();
  const locationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const scope = locationId ?? 'all';
  const [state, setState] = useState<{ scope: string; context: PeriodContextData; ready: boolean; error: boolean }>(() => {
    const hit = cache.get(scope);
    return { scope, context: hit ?? fallbackPeriodContext(), ready: Boolean(hit), error: false };
  });

  useEffect(() => {
    let alive = true;
    const hit = cache.get(scope) ?? readSession(scope);
    if (hit) setState({ scope, context: hit, ready: true, error: false });
    if (cache.has(scope)) return () => { alive = false; };
    load(scope, locationId).then((v) => {
      if (!alive) return;
      if (v) setState({ scope, context: v, ready: true, error: false });
      // Degrade: a failed read still lets the page work on the calendar-year fallback.
      else setState((s) => ({ scope, context: s.scope === scope ? s.context : fallbackPeriodContext(), ready: true, error: true }));
    });
    return () => {
      alive = false;
    };
  }, [scope, locationId]);

  return { context: state.context, ready: state.ready && state.scope === scope, error: state.error };
}
