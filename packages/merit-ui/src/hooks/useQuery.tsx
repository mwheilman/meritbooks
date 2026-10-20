'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api as defaultApi, type ApiClient, type QueryParams } from './api';

/**
 * Scope injection. Books' useQuery imported its own useActiveCompany(); here
 * the app provides the scope instead, so the hook has no product coupling.
 *
 *   <ScopeParamsProvider params={{ company_id: activeCompanyId }}>…
 *
 * Every useQuery under it attaches those params unless the call already sets
 * that key or opts out with { scope: false } (cross-company roll-ups).
 * Scoping is a SUB-filter; RLS/authorization on the server is the boundary.
 */
interface ScopeValue {
  params: QueryParams;
  client: ApiClient;
}

const ScopeContext = createContext<ScopeValue>({ params: {}, client: defaultApi });

export function ScopeParamsProvider({ params, client, children }: { params: QueryParams; client?: ApiClient; children: ReactNode }) {
  const parent = useContext(ScopeContext);
  const key = JSON.stringify(params);
  const value = useMemo<ScopeValue>(
    () => ({ params: { ...parent.params, ...params }, client: client ?? parent.client }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, client, parent],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScopeParams(): QueryParams {
  return useContext(ScopeContext).params;
}

/** Merge scope params under explicit params (explicit wins; null/empty scope values drop). */
export function mergeScope(scope: QueryParams, params: QueryParams | undefined, enabled: boolean): QueryParams | undefined {
  if (!enabled) return params;
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(scope)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return { ...out, ...(params ?? {}) };
}

export interface UseQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
  /** Change to force a refetch. */
  key?: string;
  /** Attach the provider's scope params (default true). */
  scope?: boolean;
}

export interface UseQueryResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

/** GET with loading/error state. Pass url null to skip. */
export function useQuery<T>(url: string | null, params?: QueryParams, options: UseQueryOptions = {}): UseQueryResult<T> {
  const { enabled = true, refetchInterval, key, scope = true } = options;
  const ctx = useContext(ScopeContext);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled && url !== null);
  const seq = useRef(0);
  const effective = mergeScope(ctx.params, params, scope);
  const paramsKey = JSON.stringify(effective ?? {});
  const shouldFetch = enabled && url !== null;

  const fetchData = useCallback(async () => {
    if (!shouldFetch || url === null) {
      setIsLoading(false);
      return;
    }
    const mine = ++seq.current;
    setIsLoading(true);
    setError(null);
    const res = await ctx.client.get<T>(url, JSON.parse(paramsKey) as QueryParams);
    if (mine !== seq.current) return; // a newer request superseded this one
    if (res.error) {
      setError(res.error.error);
      setData(null);
    } else {
      setData(res.data);
    }
    setIsLoading(false);
  }, [url, paramsKey, shouldFetch, key, ctx.client]);

  useEffect(() => {
    void fetchData();
    let t: ReturnType<typeof setInterval> | undefined;
    if (refetchInterval && refetchInterval > 0) t = setInterval(() => void fetchData(), refetchInterval);
    return () => {
      seq.current++;
      if (t) clearInterval(t);
    };
  }, [fetchData, refetchInterval]);

  return { data, error, isLoading, refetch: fetchData };
}

export interface UseMutationResult<TInput, TOutput> {
  mutate: (input: TInput) => Promise<TOutput | null>;
  data: TOutput | null;
  error: string | null;
  isLoading: boolean;
  reset: () => void;
}

/** POST/PUT/PATCH/DELETE with loading/error state. */
export function useMutation<TInput, TOutput>(url: string, method: 'post' | 'put' | 'patch' | 'delete' = 'post'): UseMutationResult<TInput, TOutput> {
  const { client } = useContext(ScopeContext);
  const [data, setData] = useState<TOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const mutate = useCallback(
    async (input: TInput): Promise<TOutput | null> => {
      setIsLoading(true);
      setError(null);
      const res = method === 'delete' ? await client.delete<TOutput>(url) : await client[method]<TOutput>(url, input);
      setIsLoading(false);
      if (res.error) {
        setError(res.error.error);
        setData(null);
        return null;
      }
      setData(res.data);
      return res.data;
    },
    [url, method, client],
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { mutate, data, error, isLoading, reset };
}
