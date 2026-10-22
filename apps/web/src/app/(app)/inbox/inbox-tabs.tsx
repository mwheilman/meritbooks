'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Button, Tabs, Tag } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { InboxClient } from './inbox-client';
import { ExceptionsQueue } from './exceptions-queue';
import { GROUPS_FOR_TAB, type TabKey } from './inbox-types';
import { useInboxData, HORIZON_OPTIONS } from './use-inbox-data';
import { useInboxSnooze } from './use-inbox-snooze';

// The unified Inbox (merit-ui). One screen for everything waiting on the caller,
// split into tabs. Consolidates the old /inbox (Action Inbox), /exceptions (Needs
// Attention, inline-resolve) and /flagged (retired subset) surfaces.
//
//   Approvals   → money-movement approvals + AP/expense policy blocks (/api/inbox)
//   Exceptions  → AI proposals + flagged bank/receipt/bill, with SAFE inline resolve
//                 (/api/exceptions — preserves the old /exceptions behavior)
//   Alerts      → time-sensitive obligations, overdue or due soon (/api/inbox)
//   Drafts      → unposted entries to finish (/api/inbox)
//
// The shell owns the two data sources (useInboxData) so the tab counts and the
// "needs you" total — exactly /api/inbox's total, the same value the rail's Inbox
// count shows — never diverge from the lists they head.

const TABS: { key: TabKey; label: string }[] = [
  { key: 'approvals', label: 'Approvals' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'drafts', label: 'Drafts' },
];

const PANEL_ID = 'inbox-panel';

export function InboxTabs() {
  const { orgId } = useAuth();
  const [tab, setTab] = useState<TabKey>('approvals');

  const {
    horizon,
    setHorizon,
    inbox,
    inboxLoading,
    inboxError,
    refetchInbox,
    exceptions,
    exLoading,
    exError,
    refetchExceptions,
    tabCounts,
    total,
    refetchAll,
  } = useInboxData();

  const snooze = useInboxSnooze(orgId);

  // Deep-link support: /inbox?tab=exceptions opens the right tab. Also lets the
  // retired /exceptions route redirect straight into its tab.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab');
    if (t && TABS.some((x) => x.key === t)) setTab(t as TabKey);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url.toString());
  }, [tab]);

  const anyLoading = inboxLoading || exLoading;

  return (
    <div className="mb-inbox">
      <PageHeader
        title="Inbox"
        description="Everything that needs you, in one place: approvals and policy blocks, AI exceptions you can resolve here, time-sensitive alerts, and unposted drafts."
        actions={
          <>
            {/* The total "needs you" — identical to the rail's Inbox count (/api/inbox). */}
            <Tag tone={total > 0 ? 'neg' : 'pos'} title="Total items needing you — matches the Inbox count on the rail">
              {total > 0 ? `${total > 99 ? '99+' : total} need you` : 'All caught up'}
            </Tag>
            <label className="mb-inline-field">
              <span className="t-cap">Alerts within</span>
              <select className="select" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} aria-label="Alert horizon">
                {HORIZON_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => void refetchAll()} disabled={anyLoading} aria-label="Refresh inbox">
              {anyLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />

      <Tabs
        aria-label="Inbox sections"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({ value: t.key, label: t.label, count: tabCounts[t.key] > 99 ? '99+' : tabCounts[t.key], panelId: PANEL_ID }))}
      />

      {/* Approval-authority context (kept from the old screen). */}
      {inbox && (
        <p className="t-cap mb-inbox-authority">
          {inbox.canApproveMoney
            ? 'You have money-movement approval authority — approvals you can clear are marked critical.'
            : 'Approvals waiting on another approver are shown for visibility.'}
        </p>
      )}

      <div id={PANEL_ID} role="tabpanel" aria-label={TABS.find((t) => t.key === tab)?.label}>
        {tab === 'exceptions' ? (
          <ExceptionsQueue data={exceptions} isLoading={exLoading} error={exError} refetch={refetchExceptions} />
        ) : (
          <InboxClient
            only={GROUPS_FOR_TAB[tab]}
            tabLabel={TABS.find((t) => t.key === tab)?.label ?? 'this tab'}
            data={inbox}
            isLoading={inboxLoading}
            error={inboxError}
            refetch={refetchInbox}
            snooze={snooze}
          />
        )}
      </div>
    </div>
  );
}
