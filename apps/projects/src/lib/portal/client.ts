'use client';
/**
 * Browser calls to the public portal API (same origin, session cookie). Never throws: returns
 * { ok, data } or { ok: false, error, code } with a sentence for the person.
 */
export type PostResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string; status: number; reason?: string | null };

export async function portalPost<T = Record<string, unknown>>(url: string, body: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; reason?: string | null };
    if (!res.ok) return { ok: false, error: data.error ?? 'That did not go through. Try again.', code: data.code ?? 'unavailable', status: res.status, reason: data.reason ?? null };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.', code: 'offline', status: 0 };
  }
}

export async function portalUpload(orgId: string, purpose: string, file: File): Promise<PostResult<{ documentId: string; fileName: string }>> {
  const fd = new FormData();
  fd.set('orgId', orgId);
  fd.set('purpose', purpose);
  fd.set('file', file);
  try {
    const res = await fetch('/api/portal/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = (await res.json().catch(() => ({}))) as { documentId: string; fileName: string; error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error ?? 'The upload did not finish. Try again.', code: data.code ?? 'unavailable', status: res.status };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.', code: 'offline', status: 0 };
  }
}
