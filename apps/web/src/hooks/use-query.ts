'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api-client';

interface UseQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
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
 */
export function useQuery<T>(
  url: string,
  params?: Record<string, string>,
  options?: UseQueryOptions
): UseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const { enabled = true, refetchInterval } = options ?? {};

  const fetchData = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);

    const result = await api.get<T>(url, params);

    if (!mountedRef.current) return;

    if (result.error) {
      setError(result.error.error);
      setData(null);
    } else {
      setData(result.data);
    }
    setIsLoading(false);
  }, [url, JSON.stringify(params), enabled]);

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
