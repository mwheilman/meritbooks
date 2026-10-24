'use client';

import type { ApiError } from '@meritbooks/merit-ui';
import { parseCandidates, type MatchCandidate } from '@/lib/parties/match';

export type DoorResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'match'; candidates: MatchCandidate[]; message: string; field: string | null }
  | { kind: 'error'; error: ApiError };

/**
 * POST to a create door. A 409 MATCH_FOUND (the server's own matching-at-the-door check) comes
 * back with its candidates so the form can show them; the shared api client keeps only the
 * message, so this reads the body itself.
 */
export async function postToDoor<T>(url: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<DoorResult<T>> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
    if (res.status === 409 && o.code === 'MATCH_FOUND') {
      return { kind: 'match', candidates: parseCandidates(o.candidates), message: typeof o.error === 'string' ? o.error : 'This is already in Merit.', field: typeof o.field === 'string' ? o.field : null };
    }
    if (!res.ok) {
      return {
        kind: 'error',
        error: {
          error: typeof o.error === 'string' ? o.error : `Request failed (${res.status})`,
          code: typeof o.code === 'string' ? o.code : 'HTTP_ERROR',
          details: typeof o.details === 'object' && o.details !== null ? (o.details as Record<string, string[]>) : undefined,
        },
      };
    }
    return { kind: 'ok', data: json as T };
  } catch (e) {
    return { kind: 'error', error: { error: e instanceof Error ? e.message : 'Network error', code: 'NETWORK_ERROR' } };
  }
}

/** Field errors from a 422 as { field: first message }. */
export function fieldErrors(e: ApiError): Record<string, string> {
  return Object.fromEntries(Object.entries(e.details ?? {}).map(([k, m]) => [k, m[0] ?? '']));
}
