'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '@/lib/api-client';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';

interface UseQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
  /** Change this value to force a refetch (cache-buster) */
  key?: string;
  /**
   * Company scoping. By default, when a specific company is active in the
   * header, the shared hook automatically attaches `location_id` to the request
   * so every processing page inherits company scoping centrally (an explicit
   * `location_id` in `params` always wins). Set `scope: false` for endpoints
   * that must stay consolidated regardless of the active company (e.g. the
   * cross-company dashboard/portfolio roll-ups).
   */
  scope?: boolean;
}

interface UseQueryResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

/**
 * Data fetching hook with automatic loading states and error handling.
 *
 * Usage:
 *   const { data, isLoading, error } = useQuery<TrialBalance[]>(
 *     '/api/gl/trial-balance',
 *     { location_id: selectedCompany }
 *   );
 *
 * Pass `null` as url to skip the fetch (conditional fetching).
 */
export function useQuery<T>(
  url: string | null,
  params?: Record<string, string>,
  options?: UseQueryOptions
): UseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const { enabled = true, refetchInterval, key, scope = true } = options ?? {};
  const shouldFetch = enabled && url !== null;

  // Central company scoping: when a specific company is active, attach it as
  // `location_id` unless the caller already provided one or opted out via
  // `scope: false`. This is a SUB-filter within the tenant RLS already isolates.
  const { activeCompanyId } = useActiveCompany();
  const effectiveParams = useMemo(() => {
    if (
      scope &&
      isSpecificCompany(activeCompanyId) &&
      (!params || params.location_id === undefined)
    ) {
      return { ...(params ?? {}), location_id: activeCompanyId };
    }
    return params;
  }, [params, scope, activeCompanyId]);

  const fetchData = useCallback(async () => {
    if (!shouldFetch || !url) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    const result = await api.get<T>(url, effectiveParams);

    if (!mountedRef.current) return;

    if (result.error) {
      setError(result.error.error);
      setData(null);
    } else {
      setData(result.data);
    }
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, JSON.stringify(effectiveParams), shouldFetch, key]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();

    let interval: ReturnType<typeof setInterval> | undefined;
    if (refetchInterval && refetchInterval > 0) {
      interval = setInterval(fetchData, refetchInterval);
    }

    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
    };
  }, [fetchData, refetchInterval]);

  return { data, error, isLoading, refetch: fetchData };
}

interface UseMutationResult<TInput, TOutput> {
  mutate: (input: TInput) => Promise<TOutput | null>;
  data: TOutput | null;
  error: string | null;
  isLoading: boolean;
  reset: () => void;
}

/**
 * Mutation hook for POST/PUT/DELETE operations.
 *
 * Usage:
 *   const { mutate, isLoading } = useMutation<PostJEInput, PostResult>('/api/gl/post');
 *   const result = await mutate(journalEntry);
 */
export function useMutation<TInput, TOutput>(
  url: string,
  method: 'post' | 'put' | 'patch' | 'delete' = 'post'
): UseMutationResult<TInput, TOutput> {
  const [data, setData] = useState<TOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const mutate = useCallback(async (input: TInput): Promise<TOutput | null> => {
    setIsLoading(true);
    setError(null);

    const result = method === 'delete'
      ? await api.delete<TOutput>(url)
      : await api[method]<TOutput>(url, input);

    if (result.error) {
      setError(result.error.error);
      setData(null);
      setIsLoading(false);
      return null;
    }

    setData(result.data);
    setIsLoading(false);
    return result.data;
  }, [url, method]);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { mutate, data, error, isLoading, reset };
}
