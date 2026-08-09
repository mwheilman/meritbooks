'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { clsx } from 'clsx';
import { ShieldCheck, Sparkles, CalendarClock, FileText, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { InboxClient } from './inbox-client';
import { ExceptionsQueue } from './exceptions-queue';
import { GROUPS_FOR_TAB, type TabKey } from './inbox-types';
import { useInboxData, HORIZON_OPTIONS } from './use-inbox-data';
import { useInboxSnooze } from './use-inbox-snooze';

// The unified Inbox. One screen for everything waiting on the caller, split into
// filter tabs. Consolidates the old /inbox (Action Inbox), /exceptions (Needs
// Attention, inline-resolve) and /flagged (retired subset) surfaces.
//
//   Approvals   → money-movement approvals + AP/expense policy blocks (/api/inbox)
//   Exceptions  → AI proposals + flagged bank/receipt/bill, with SAFE inline resolve
//                 (/api/exceptions — preserves the old /exceptions behavior)
//   Alerts      → time-sensitive obligations, overdue or due soon (/api/inbox)
//   Drafts      → unposted entries to finish (/api/inbox)
//
// The shell owns the two data sources (useInboxData) so the tab-bar counts and the
// "needs you" total badge — which is exactly /api/inbox's total, the same value the
// header bell shows — never diverge from the lists they head.

const TABS: { key: TabKey; label: string; icon: typeof ShieldCheck }[] = [
  { key: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { key: 'exceptions', label: 'Exceptions', icon: Sparkles },
  { key: 'alerts', label: 'Alerts', icon: CalendarClock },
  { key: 'drafts', label: 'Drafts', icon: FileText },
];

function TabBtn({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
      )}
    >
      {icon}
      {children}
      {count > 0 && (
        <span
          className={clsx(
            'ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none',
            active ? 'bg-white/20 text-white' : 'bg-slate-700/60 text-slate-300',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

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
    <div className="space-y-6">
      <PageHeader
        title="Inbox"
        description="Everything that needs you, in one place — approvals and policy blocks, AI exceptions you can resolve inline, time-sensitive alerts, and unposted drafts."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Total "needs you" badge — identical to the header bell (/api/inbox). */}
            <span
              title="Total items needing you — matches the notifications bell"
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium',
                total > 0
                  ? 'border-red-500/30 bg-red-500/10 text-red-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
              )}
            >
              {total > 0 ? `${total > 99 ? '99+' : total} need you` : 'All caught up'}
            </span>

            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
              {TABS.map(({ key, label, icon: Icon }) => (
                <TabBtn
                  key={key}
                  active={tab === key}
                  onClick={() => setTab(key)}
                  icon={<Icon size={14} />}
                  count={tabCounts[key]}
                >
                  {label}
                </TabBtn>
              ))}
            </div>

            {/* Alert horizon applies to the Alerts source (overdue always included). */}
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-300">
              <span className="text-slate-500">Alerts within</span>
              <select
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
                className="bg-transparent text-xs text-slate-200 focus:outline-none"
              >
                {HORIZON_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>

            <button
              onClick={() => refetchAll()}
              className="btn-secondary btn-sm"
              title="Refresh"
              aria-label="Refresh inbox"
            >
              <RefreshCw size={14} className={clsx(anyLoading && 'animate-spin')} />
            </button>
          </div>
        }
      />

      {/* Approval-authority context line (kept from the old screen). */}
      {inbox && (
        <p className="text-xs text-slate-500">
          {inbox.canApproveMoney
            ? 'You have money-movement approval authority — approvals you can clear are flagged critical.'
            : 'Approvals awaiting another approver are shown for visibility.'}
        </p>
      )}

      {tab === 'exceptions' ? (
        <ExceptionsQueue
          data={exceptions}
          isLoading={exLoading}
          error={exError}
          refetch={refetchExceptions}
        />
      ) : (
        <InboxClient
          only={GROUPS_FOR_TAB[tab]}
          data={inbox}
          isLoading={inboxLoading}
          error={inboxError}
          refetch={refetchInbox}
          snooze={snooze}
        />
      )}
    </div>
  );
}
