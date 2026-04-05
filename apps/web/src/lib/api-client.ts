/**
 * Typed API client for MeritBooks.
 *
 * Usage:
 *   const { data, error, loading } = useApi('/api/gl/trial-balance', { location_id: 'abc' });
 *   const result = await api.post('/api/gl/post', journalEntry);
 */

interface ApiError {
  error: string;
  code: string;
  details?: Record<string, string[]>;
}

interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
  status: number;
}

async function request<T>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    });

    const body = await res.json();

    if (!res.ok) {
      return {
        data: null,
        error: body as ApiError,
        status: res.status,
      };
    }

    return {
      data: body as T,
      error: null,
      status: res.status,
    };
  } catch (err) {
    return {
      data: null,
      error: {
        error: err instanceof Error ? err.message : 'Network error',
        code: 'NETWORK_ERROR',
      },
      status: 0,
    };
  }
}

export const api = {
  get: <T>(url: string, params?: Record<string, string>) => {
    const query = params
      ? '?' + new URLSearchParams(params).toString()
      : '';
    return request<T>(url + query);
  },

  post: <T>(url: string, body: unknown) =>
    request<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  put: <T>(url: string, body: unknown) =>
    request<T>(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  patch: <T>(url: string, body: unknown) =>
    request<T>(url, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  delete: <T>(url: string) =>
    request<T>(url, { method: 'DELETE' }),
};
