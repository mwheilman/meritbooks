'use client';

import { useCallback, useState } from 'react';
import { Status, api, money, toast, type PipKind, type StatusKind } from '@meritbooks/merit-ui';
import type { StageStatus } from '@/lib/onboarding/migration/stages';

/** Figures: integer cents → "3,184.62", negatives in parentheses (kit rule). */
export const amt = (cents: number) => money(Math.trunc(cents));

/** Status is never colour alone: pip shape + word. */
export function StageStatusWord({ status }: { status: StageStatus }) {
  const map: Record<StageStatus, { kind: StatusKind; pip: PipKind; word: string }> = {
    done: { kind: 'ready', pip: 'ready', word: 'Done' },
    current: { kind: 'track', pip: 'open', word: 'Now' },
    todo: { kind: 'track', pip: 'track', word: 'Next' },
    skipped: { kind: 'track', pip: 'closed', word: 'Skipped' },
  };
  const m = map[status];
  return <Status kind={m.kind} pip={m.pip}>{m.word}</Status>;
}

export function SeverityWord({ severity }: { severity: string }) {
  switch (severity) {
    case 'blocker':
      return <Status kind="blocked">Blocker</Status>;
    case 'warning':
      return <Status kind="risk">Warning</Status>;
    case 'info':
      return <Status kind="track" pip="open">Info</Status>;
    case 'passed':
      return <Status kind="ready">Passed</Status>;
    default:
      return <Status kind="track" pip="closed">Not applicable</Status>;
  }
}

/** POST an action, toast the outcome, return the body (null on failure). */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T extends { message?: string }>(key: string, url: string, body: unknown, opts: { quiet?: boolean } = {}): Promise<T | null> => {
    setBusy(key);
    try {
      const res = await api.post<T>(url, body);
      if (res.error) {
        toast(res.error.error, { tone: 'neg' });
        return null;
      }
      if (!opts.quiet && res.data?.message) toast(res.data.message, { tone: 'info' });
      return res.data;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

/** Upload one file (multipart) — returns the API body or null after a toast. */
export async function uploadFile<T extends { message?: string }>(url: string, fields: Record<string, string>, file: File): Promise<T | null> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', file);
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : null) as (T & { error?: string }) | null;
    if (!res.ok) {
      toast(body?.error ?? `Upload failed (${res.status})`, { tone: 'neg' });
      return null;
    }
    if (body?.message) toast(body.message, { tone: 'info' });
    return body;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Upload failed', { tone: 'neg' });
    return null;
  }
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
