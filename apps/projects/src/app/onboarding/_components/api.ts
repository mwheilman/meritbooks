/** Typed fetch for the onboarding routes. Never throws. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; error: string };

async function call<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { ...init, credentials: 'same-origin' });
    const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!res.ok || body === null) {
      return {
        ok: false,
        status: res.status,
        code: body?.code ?? `HTTP_${res.status}`,
        error: body?.error ?? (res.status === 401 ? 'Your session ended. Sign in again.' : "That didn't go through. Try again."),
      };
    }
    return { ok: true, data: body };
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', error: "We couldn't reach Merit Projects. Check your connection and try again." };
  }
}

export function postJson<T>(url: string, body: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<ApiResult<T>> {
  return call<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function postForm<T>(url: string, form: FormData): Promise<ApiResult<T>> {
  return call<T>(url, { method: 'POST', body: form });
}
