'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Button, InlineNotice, Tabs, Tag } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
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
//   Approvals   → money-movement + expense approvals, bills on AP-policy hold and
//                 expense-policy blocks
//   Exceptions  → AI proposals + flagged bank lines / receipts + job costs, with the
//                 SAFE inline resolve preserved from the old /exceptions screen
//   Alerts      → time-sensitive obligations, overdue or due soon
//   Drafts      → unposted manual entries to finish
//
// Every tab, badge and the "need you" total come from ONE /api/inbox read
// (lib/work/needs-attention — the same counting service as the home and the rail),
// scoped to the active client. In the all-clients context rows are grouped by client
// with an "Organization" group for items not tied to one client.

const TABS: { key: TabKey; label: string }[] = [
  { key: 'approvals', label: 'Approvals' },
  { key: 'exceptions', label: 'Exceptions' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'drafts', label: 'Drafts' },
];

const PANEL_ID = 'inbox-panel';

export function InboxTabs() {
  const { orgId } = useAuth();
  const { activeCompany, isAll } = useActiveCompany();
  const [tab, setTab] = useState<TabKey>('approvals');

  const {
    horizon,
    setHorizon,
    inbox,
    inboxLoading,
    inboxError,
    refetchInbox,
    exceptions,
    tabCounts,
    total,
    loaded,
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

  const anyLoading = inboxLoading;
  const clientName = activeCompany?.name ?? null;

  return (
    <div className="mb-inbox">
      <PageHeader
        title="Inbox"
        description="Everything that needs you, in one place: approvals and policy blocks, AI exceptions you can resolve here, time-sensitive alerts, and unposted drafts."
        actions={
          <>
            {/* The total "needs you" — identical to the rail's Inbox count. Never claim
                "all caught up" before the first load has answered. */}
            {loaded ? (
              <Tag tone={total > 0 ? 'neg' : 'pos'} title="Total items needing you — matches the Inbox count on the rail and the home">
                {total > 0 ? `${total.toLocaleString()} need you` : 'All caught up'}
              </Tag>
            ) : (
              <span className="wg-loading mb-tag-skel" aria-hidden="true">
                <span className="bar-l" style={{ width: 96 }} />
              </span>
            )}
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
            <Button onClick={() => void refetchInbox()} disabled={anyLoading} aria-label="Refresh inbox">
              {anyLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />

      <Tabs
        aria-label="Inbox sections"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({
          value: t.key,
          label: t.label,
          // No count until loaded — a "0" before the read answers is a false all-clear.
          count: loaded ? tabCounts[t.key].toLocaleString() : undefined,
          panelId: PANEL_ID,
        }))}
      />

      {/* Which books this inbox is showing — the scope is enforced server-side too. */}
      {loaded &&
        (isAll ? (
          <p className="t-cap mb-inbox-scope">
            All clients · grouped by client. <b>Organization</b> holds items not tied to one client (money-movement approvals,
            vendor documents, loan files).
          </p>
        ) : (
          <InlineNotice tone="info" title={`Showing ${clientName ?? 'this client'} only.`}>
            Items for other clients, and organization-wide items, are in the All clients view (⌘J).
          </InlineNotice>
        ))}
      {inbox && Object.values(inbox.truncated).some(Boolean) && (
        <InlineNotice tone="warn" title="Long queue.">
          The longest lanes show their first 500 items; the counts above are the full totals.
        </InlineNotice>
      )}

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
          <ExceptionsQueue data={exceptions} isLoading={inboxLoading || (!loaded && !inboxError)} error={inboxError} refetch={refetchInbox} groupByClient={isAll} />
        ) : (
          <InboxClient
            only={GROUPS_FOR_TAB[tab]}
            tabLabel={TABS.find((t) => t.key === tab)?.label ?? 'this tab'}
            data={inbox}
            isLoading={inboxLoading || (!loaded && !inboxError)}
            error={inboxError}
            refetch={refetchInbox}
            snooze={snooze}
            groupByClient={isAll}
          />
        )}
      </div>
    </div>
  );
}
