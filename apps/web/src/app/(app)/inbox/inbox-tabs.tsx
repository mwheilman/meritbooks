'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ShieldCheck, Sparkles, CalendarClock, FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { InboxClient, type InboxGroupKey } from './inbox-client';
import { ExceptionsQueue } from './exceptions-queue';

// The unified Inbox. One screen for everything waiting on the caller, split into
// filter tabs. Consolidates the old /inbox (Action Inbox), /exceptions (Needs
// Attention, inline-resolve) and /flagged (retired subset) surfaces.
//
//   Approvals   → money-movement approvals + AP/expense policy blocks (/api/inbox)
//   Exceptions  → AI proposals + flagged bank/receipt/bill, with SAFE inline resolve
//                 (/api/exceptions — preserves the old /exceptions behavior)
//   Alerts      → time-sensitive obligations, overdue or due soon (/api/inbox)
//   Drafts      → unposted entries to finish (/api/inbox)

type TabKey = 'approvals' | 'exceptions' | 'alerts' | 'drafts';

const TABS: { key: TabKey; label: string; icon: typeof ShieldCheck }[] = [
  { key: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { key: 'exceptions', label: 'Exceptions', icon: Sparkles },
  { key: 'alerts', label: 'Alerts', icon: CalendarClock },
  { key: 'drafts', label: 'Drafts', icon: FileText },
];

// Which /api/inbox groups each (non-exceptions) tab renders. Policy blocks ride
// with Approvals since both are gates that hold money movement.
const GROUPS_FOR_TAB: Record<Exclude<TabKey, 'exceptions'>, InboxGroupKey[]> = {
  approvals: ['APPROVALS', 'POLICY_BLOCKS'],
  alerts: ['ALERTS'],
  drafts: ['DRAFTS'],
};

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200'
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function InboxTabs() {
  const [tab, setTab] = useState<TabKey>('approvals');

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbox"
        description="Everything that needs you, in one place — approvals and policy blocks, AI exceptions you can resolve inline, time-sensitive alerts, and unposted drafts."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
            {TABS.map(({ key, label, icon: Icon }) => (
              <TabBtn key={key} active={tab === key} onClick={() => setTab(key)} icon={<Icon size={14} />}>
                {label}
              </TabBtn>
            ))}
          </div>
        }
      />

      {tab === 'exceptions' ? (
        <ExceptionsQueue />
      ) : (
        <InboxClient only={GROUPS_FOR_TAB[tab]} />
      )}
    </div>
  );
}
