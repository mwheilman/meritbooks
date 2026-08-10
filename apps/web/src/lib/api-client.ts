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
    // Merge params INTO any query string the url already carries, rather than
    // blindly prepending another "?". Prevents malformed URLs like
    // `/x?location_id=A?location_id=A` (which the server then reads as the uuid
    // "A?location_id=A" and rejects). `set` also de-dupes a key already present
    // in the url with the param value.
    const [path, existingQuery = ''] = url.split('?');
    const sp = new URLSearchParams(existingQuery);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
      }
    }
    const qs = sp.toString();
    return request<T>(qs ? `${path}?${qs}` : path);
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
