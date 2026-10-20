/**
 * Typed fetch wrapper returning { data, error, status } (ported from Books
 * lib/api-client.ts, unchanged in behaviour). Params merge INTO an existing
 * query string instead of appending a second "?".
 */

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, string[]>;
}

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
  status: number;
}

export type QueryParams = Record<string, string | undefined | null>;

export interface ApiClient {
  get<T>(url: string, params?: QueryParams): Promise<ApiResponse<T>>;
  post<T>(url: string, body: unknown): Promise<ApiResponse<T>>;
  put<T>(url: string, body: unknown): Promise<ApiResponse<T>>;
  patch<T>(url: string, body: unknown): Promise<ApiResponse<T>>;
  delete<T>(url: string): Promise<ApiResponse<T>>;
}

/** Merge params into a URL's own query string (set, so duplicates collapse). */
export function withParams(url: string, params?: QueryParams): string {
  const [path, existing = ''] = url.split('?');
  const sp = new URLSearchParams(existing);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : (path ?? url);
}

export function createApiClient(opts: { headers?: Record<string, string>; fetch?: typeof fetch } = {}): ApiClient {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  async function request<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
    try {
      const res = await doFetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...opts.headers, ...(init?.headers as Record<string, string> | undefined) },
      });
      const text = await res.text();
      const body: unknown = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const err = (body ?? {}) as Partial<ApiError>;
        return { data: null, error: { error: err.error ?? `Request failed (${res.status})`, code: err.code ?? 'HTTP_ERROR', details: err.details }, status: res.status };
      }
      return { data: body as T, error: null, status: res.status };
    } catch (err) {
      return { data: null, error: { error: err instanceof Error ? err.message : 'Network error', code: 'NETWORK_ERROR' }, status: 0 };
    }
  }
  return {
    get: <T>(url: string, params?: QueryParams) => request<T>(withParams(url, params)),
    post: <T>(url: string, body: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
    put: <T>(url: string, body: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
    patch: <T>(url: string, body: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  };
}

/** The default client. */
export const api: ApiClient = createApiClient();
