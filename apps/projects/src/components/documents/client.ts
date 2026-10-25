'use client';

/** Multipart upload to a Projects route; returns the JSON body or the route's plain error. */
export async function postForm<T>(url: string, form: FormData): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { data: null, error: body?.error ?? `The upload failed (${res.status}). Try again.` };
    return { data: body, error: null };
  } catch {
    return { data: null, error: 'No connection. Check your internet and try again.' };
  }
}

export function bytesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Fire the e-sign outbox for the caller (signed copies, next signers, record callbacks). */
export async function runSignCallbacks(envelopeId?: string): Promise<number> {
  try {
    const res = await fetch('/api/sign/callbacks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelopeId ? { envelopeId } : {}) });
    if (!res.ok) return 0;
    const b = (await res.json()) as { done?: number };
    return b.done ?? 0;
  } catch {
    return 0;
  }
}
