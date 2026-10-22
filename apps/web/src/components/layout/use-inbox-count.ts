'use client';

import { useEffect, useState } from 'react';

/**
 * The live "needs you" count for the rail's Inbox item — the same GET /api/inbox
 * aggregate (and the same 60s poll) the old header bell used, so the rail count, the
 * Inbox page total and the server never disagree. Read-only; RLS-scoped server-side.
 * Fails quiet: on error the rail simply shows no count.
 */
const POLL_MS = 60_000;

interface InboxSummary {
  counts?: { total?: number };
  items?: Array<{ severity?: string }>;
}

export interface InboxCount {
  total: number;
  critical: boolean;
}

export function useInboxCount(enabled: boolean): InboxCount | null {
  const [state, setState] = useState<InboxCount | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/inbox', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const body = (await res.json()) as InboxSummary;
        if (!alive) return;
        setState({
          total: body.counts?.total ?? 0,
          critical: (body.items ?? []).some((i) => i.severity === 'CRITICAL'),
        });
      } catch {
        /* quiet: no count */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
  return state;
}
