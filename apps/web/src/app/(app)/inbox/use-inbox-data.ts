'use client';

/**
 * INBOX DATA — one read of /api/inbox powers every tab, the tab badges and the
 * "need you" total, so none of them can disagree.
 *
 *   • /api/inbox is built by lib/work/needs-attention — the same counting service the
 *     home ("Also waiting", the four-step strip) and the rail's Inbox badge use — over
 *     ONE scoped item set. The shared useQuery hook attaches the active client
 *     (`location_id`), and the server validates it against the caller's client scope;
 *     switching clients refetches.
 *   • The Exceptions tab is a projection of the same payload (toExceptionsResponse) —
 *     it used to be a second endpoint with its own sources, which is how its count
 *     and the home's drifted apart.
 *
 * The alert horizon lives here (not inside a tab) so the Alerts tab count and the
 * Alerts list always agree. Read-only; no writes here.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { toExceptionsResponse, type InboxResponse, type ExceptionsResponse, type TabKey } from './inbox-types';

export interface UseInboxData {
  horizon: number;
  setHorizon: (d: number) => void;

  inbox: InboxResponse | null;
  inboxLoading: boolean;
  inboxError: string | null;
  refetchInbox: () => Promise<void>;

  /** The Exceptions tab — derived from the same payload as every other tab. */
  exceptions: ExceptionsResponse | null;

  /** Per-tab counts for the tab-bar badges (the server's full-set lane counts). */
  tabCounts: Record<TabKey, number>;
  /** The single "needs you" total — the sum of the four tabs; identical to the rail badge. */
  total: number;
  /** True once the first load has answered (never show "all clear" before that). */
  loaded: boolean;
}

export const HORIZON_OPTIONS = [30, 60, 90];

export function useInboxData(): UseInboxData {
  const [horizon, setHorizon] = useState(30);

  const inboxParams = useMemo<Record<string, string>>(() => ({ alert_horizon: String(horizon) }), [horizon]);

  const { data: raw, error: inboxError, isLoading: inboxLoading, refetch: refetchInbox } = useQuery<InboxResponse>('/api/inbox', inboxParams);

  // While a client switch is refetching, the previous payload belongs to the OLD
  // client — never show it (or its counts) under the new client's name.
  const { activeCompanyId } = useActiveCompany();
  const wanted = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const inbox = raw && (raw.scope?.locationId ?? null) === wanted ? raw : null;

  const exceptions = useMemo(() => (inbox ? toExceptionsResponse(inbox) : null), [inbox]);

  const tabCounts = useMemo<Record<TabKey, number>>(() => {
    const lanes = inbox?.counts.byLane;
    return {
      approvals: lanes?.approvals ?? 0,
      exceptions: lanes?.exceptions ?? 0,
      alerts: lanes?.alerts ?? 0,
      drafts: lanes?.drafts ?? 0,
    };
  }, [inbox]);

  return {
    horizon,
    setHorizon,
    inbox: inbox ?? null,
    inboxLoading,
    inboxError,
    refetchInbox,
    exceptions,
    tabCounts,
    total: inbox?.counts.total ?? 0,
    loaded: !!inbox,
  };
}
