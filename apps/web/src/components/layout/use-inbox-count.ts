'use client';

import { useEffect, useState } from 'react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';

/**
 * The live "needs you" count for the rail's Inbox item — GET /api/inbox, the same
 * shared counting service (lib/work/needs-attention) the Inbox tabs and the home use,
 * SCOPED TO THE ACTIVE CLIENT exactly like the Inbox page (the shared useQuery hook
 * attaches `location_id`; this hook does the same by hand). So the rail badge, the
 * Inbox total and the home's "need you" are one number. 60s poll + refetch on focus
 * and on client switch. Read-only; RLS-scoped server-side. Fails quiet (no count).
 */
const POLL_MS = 60_000;

interface InboxSummary {
  scope?: { locationId?: string | null };
  counts?: { total?: number; critical?: number };
  items?: Array<{ severity?: string }>;
}

export interface InboxCount {
  total: number;
  critical: boolean;
}

/** Build the request URL for a client scope (exported for tests). */
export function inboxCountUrl(activeCompanyId: string | null | undefined): string {
  return isSpecificCompany(activeCompanyId)
    ? `/api/inbox?view=counts&location_id=${encodeURIComponent(activeCompanyId)}`
    : '/api/inbox?view=counts';
}

export function useInboxCount(enabled: boolean): InboxCount | null {
  const { activeCompanyId } = useActiveCompany();
  const [state, setState] = useState<InboxCount | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let alive = true;
    // A client switch must never show the previous client's count.
    setState(null);
    const url = inboxCountUrl(activeCompanyId);
    const load = async () => {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const body = (await res.json()) as InboxSummary;
        if (!alive) return;
        setState({
          total: body.counts?.total ?? 0,
          critical:
            typeof body.counts?.critical === 'number'
              ? body.counts.critical > 0
              : (body.items ?? []).some((i) => i.severity === 'CRITICAL'),
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
  }, [enabled, activeCompanyId]);
  return state;
}
