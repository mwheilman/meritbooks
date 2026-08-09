'use client';

/**
 * INBOX DATA — one place that loads everything the unified Inbox shell needs, so
 * the tab bar can show per-tab counts + a total badge that matches the header
 * bell without each tab double-fetching.
 *
 * Two read-only, RLS-scoped sources (no writes here):
 *   • /api/inbox      → ranked "needs you" aggregate (approvals, policy blocks,
 *                       alerts, drafts — and the EXCEPTION count the bell shows).
 *                       Its `counts.total` is exactly what the header bell badges,
 *                       so `total` below is guaranteed to match it.
 *   • /api/exceptions → the broader flagged/held/proposed queue that powers the
 *                       Exceptions tab's inline (safe, non-financial) resolve.
 *
 * The alert horizon lives here (not inside a tab) so the Alerts tab count and the
 * Alerts list always agree.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@/hooks';
import type { InboxResponse, ExceptionsResponse, TabKey } from './inbox-types';

export interface UseInboxData {
  horizon: number;
  setHorizon: (d: number) => void;

  inbox: InboxResponse | null;
  inboxLoading: boolean;
  inboxError: string | null;
  refetchInbox: () => Promise<void>;

  exceptions: ExceptionsResponse | null;
  exLoading: boolean;
  exError: string | null;
  refetchExceptions: () => Promise<void>;

  /** Per-tab counts for the tab-bar badges. */
  tabCounts: Record<TabKey, number>;
  /** The single "needs you" total — identical to the header bell (/api/inbox). */
  total: number;
  /** Convenience: refetch both sources at once. */
  refetchAll: () => Promise<void>;
}

export const HORIZON_OPTIONS = [30, 60, 90];

export function useInboxData(): UseInboxData {
  const [horizon, setHorizon] = useState(30);

  const inboxParams = useMemo<Record<string, string>>(
    () => ({ alert_horizon: String(horizon) }),
    [horizon],
  );

  const {
    data: inbox,
    error: inboxError,
    isLoading: inboxLoading,
    refetch: refetchInbox,
  } = useQuery<InboxResponse>('/api/inbox', inboxParams);

  const {
    data: exceptions,
    error: exError,
    isLoading: exLoading,
    refetch: refetchExceptions,
  } = useQuery<ExceptionsResponse>('/api/exceptions');

  const tabCounts = useMemo<Record<TabKey, number>>(() => {
    const byType = inbox?.counts.byType;
    return {
      approvals: (byType?.APPROVAL ?? 0) + (byType?.POLICY_BLOCK ?? 0),
      alerts: byType?.ALERT ?? 0,
      drafts: byType?.DRAFT ?? 0,
      exceptions: exceptions?.counts.total ?? 0,
    };
  }, [inbox, exceptions]);

  const total = inbox?.counts.total ?? 0;

  return {
    horizon,
    setHorizon,
    inbox: inbox ?? null,
    inboxLoading,
    inboxError,
    refetchInbox,
    exceptions: exceptions ?? null,
    exLoading,
    exError,
    refetchExceptions,
    tabCounts,
    total,
    refetchAll: async () => {
      await Promise.all([refetchInbox(), refetchExceptions()]);
    },
  };
}
