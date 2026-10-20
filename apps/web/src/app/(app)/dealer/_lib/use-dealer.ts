'use client';

/**
 * Dealer Pack (D2) client data layer. Every dealer request carries the active
 * client (`locationId`) explicitly; the org is the session's (never sent).
 * D1 envelope: success `{ data }`, failure `{ error, code, details? }`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { useDebounce } from '@/hooks/use-debounce';
import { addToast } from '@/hooks/use-toast';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import type { LookupItem, LookupKind } from '@/lib/dealer/lookups';

export type { DealerApiError };

/** The active client (core.locations) the dealer screens work in. */
export function useDealerClient(): { locationId: string | null; clientName: string | null; ready: boolean } {
  const { activeCompanyId, activeCompany, ready } = useActiveCompany();
  const locationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  return { locationId, clientName: activeCompany?.name ?? null, ready };
}

export interface DealerResult<T> {
  data: T | null;
  error: DealerApiError | null;
  status: number;
}

function unwrap<T>(res: { data: unknown; error: unknown; status: number }): DealerResult<T> {
  if (res.error) {
    const e = res.error as Partial<DealerApiError>;
    return { data: null, error: { error: e.error ?? 'Request failed', code: e.code ?? 'ERROR', details: e.details }, status: res.status };
  }
  const body = res.data as { data?: T } | null;
  return { data: (body?.data ?? null) as T | null, error: null, status: res.status };
}

function stringParams(p: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

export async function dealerGet<T>(path: string, locationId: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<DealerResult<T>> {
  return unwrap<T>(await api.get(path, stringParams({ ...params, locationId })));
}

export async function dealerSend<T>(
  method: 'post' | 'put' | 'patch',
  path: string,
  locationId: string,
  body: Record<string, unknown>,
): Promise<DealerResult<T>> {
  return unwrap<T>(await api[method](path, { ...body, locationId }));
}

/**
 * Run a write and toast the outcome. Returns the data on success, null on failure
 * (the error is toasted in plain English and also returned for inline display).
 */
export async function dealerMutate<T>(
  method: 'post' | 'put' | 'patch',
  path: string,
  locationId: string,
  body: Record<string, unknown>,
  successMessage?: string,
): Promise<DealerResult<T>> {
  const res = await dealerSend<T>(method, path, locationId, body);
  if (res.error) {
    const x = explainDealerError(res.error);
    addToast('error', `${x.title}. ${x.message}`);
  } else if (successMessage) {
    addToast('success', successMessage);
  }
  return res;
}

export interface DealerQuery<T> {
  data: T | null;
  error: DealerApiError | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

/** GET a dealer read model for the active client. `path = null` skips. */
export function useDealerQuery<T>(
  path: string | null,
  params: Record<string, string | number | boolean | null | undefined> = {},
  opts: { enabled?: boolean } = {},
): DealerQuery<T> & { locationId: string | null } {
  const { locationId } = useDealerClient();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [isLoading, setLoading] = useState(true);
  const key = JSON.stringify(params);
  const seq = useRef(0);
  const enabled = opts.enabled !== false && !!path && !!locationId;

  const refetch = useCallback(async () => {
    if (!enabled || !path || !locationId) {
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    const res = await dealerGet<T>(path, locationId, JSON.parse(key) as Record<string, string>);
    if (my !== seq.current) return; // a newer request won
    setData(res.data);
    setError(res.error);
    setLoading(false);
  }, [enabled, path, locationId, key]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, isLoading, refetch, locationId };
}

/** D1 list envelope (docs/dealer-pack-api.md §2). */
export interface ListPage<R> {
  rows: R[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  sort: string;
  dir: 'asc' | 'desc';
}

export interface ListState {
  page: number;
  perPage: number;
  sort: string;
  dir: 'asc' | 'desc';
  search: string;
  filters: Record<string, string>;
  from?: string;
  to?: string;
}

/**
 * Server-paginated, sortable, filterable, debounced-search list over a D1 list
 * route. Changing search / filters / sort resets to page 1.
 */
export function useDealerList<R>(path: string | null, initial: Partial<ListState> & { sort: string }) {
  const [state, setState] = useState<ListState>({
    page: 1,
    perPage: 50,
    dir: 'desc',
    search: '',
    filters: {},
    ...initial,
  });
  const q = useDebounce(state.search, 300);
  const params = useMemo(
    () => ({
      page: state.page,
      per_page: state.perPage,
      sort: state.sort,
      dir: state.dir,
      q: q || undefined,
      from: state.from,
      to: state.to,
      ...state.filters,
    }),
    [state.page, state.perPage, state.sort, state.dir, q, state.from, state.to, state.filters],
  );
  const query = useDealerQuery<ListPage<R>>(path, params);

  const setSort = useCallback((col: string) => {
    setState((s) => ({ ...s, page: 1, sort: col, dir: s.sort === col && s.dir === 'desc' ? 'asc' : 'desc' }));
  }, []);
  const setSearch = useCallback((search: string) => setState((s) => ({ ...s, page: 1, search })), []);
  const setFilter = useCallback((key: string, value: string | null) => {
    setState((s) => {
      const filters = { ...s.filters };
      if (value === null || value === '') delete filters[key];
      else filters[key] = value;
      return { ...s, page: 1, filters };
    });
  }, []);
  const setRange = useCallback((from?: string, to?: string) => setState((s) => ({ ...s, page: 1, from, to })), []);
  const setPage = useCallback((page: number) => setState((s) => ({ ...s, page })), []);

  return { ...query, state, setSort, setSearch, setFilter, setRange, setPage };
}

/**
 * Resolve display names for a set of ids (vendors, customers, departments,
 * accounts, units, lines, programs). Batched, cached per kind for the session.
 */
const nameCache = new Map<string, LookupItem>();

export function useNames(kind: LookupKind, ids: Array<string | null | undefined>): Map<string, LookupItem> {
  const { locationId } = useDealerClient();
  const unique = useMemo(
    () => [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.join(',')],
  );
  const [, bump] = useState(0);

  useEffect(() => {
    if (!locationId) return;
    const missing = unique.filter((id) => !nameCache.has(`${kind}:${id}`));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < missing.length; i += 150) {
        const chunk = missing.slice(i, i + 150);
        const res = await dealerGet<{ items: LookupItem[] }>('/api/dealer/lookups', locationId, { kind, ids: chunk.join(',') });
        for (const it of res.data?.items ?? []) nameCache.set(`${kind}:${it.id}`, it);
      }
      if (!cancelled) bump((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, unique, locationId]);

  return useMemo(() => {
    const m = new Map<string, LookupItem>();
    for (const id of unique) {
      const hit = nameCache.get(`${kind}:${id}`);
      if (hit) m.set(id, hit);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, unique, nameCache.size]);
}

/** Picker search (debounced) for one lookup kind. */
export function useLookupSearch(kind: LookupKind, q: string, opts: { types?: string[]; enabled?: boolean } = {}) {
  const { locationId } = useDealerClient();
  const dq = useDebounce(q, 250);
  const [items, setItems] = useState<LookupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = (opts.types ?? []).join(',');
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!locationId || !enabled) return;
    let cancelled = false;
    setLoading(true);
    void dealerGet<{ items: LookupItem[] }>('/api/dealer/lookups', locationId, { kind, q: dq || undefined, types: types || undefined }).then((res) => {
      if (cancelled) return;
      setItems(res.data?.items ?? []);
      setError(res.error ? explainDealerError(res.error).message : null);
      setLoading(false);
      for (const it of res.data?.items ?? []) nameCache.set(`${kind}:${it.id}`, it);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, dq, types, locationId, enabled]);

  return { items, loading, error };
}

/** Name for one id from a map, with a calm fallback. */
export function nameOf(map: Map<string, LookupItem>, id: string | null | undefined, fallback = '—'): string {
  if (!id) return fallback;
  return map.get(id)?.label ?? '…';
}
