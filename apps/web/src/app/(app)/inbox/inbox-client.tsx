'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Icon,
  InlineNotice,
  Keyhints,
  Pip,
  QueueTable,
  Seg,
  money,
  type PipKind,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { InboxItem, InboxGroupKey, InboxSeverity, InboxResponse } from './inbox-types';
import { SEVERITY_RANK } from './inbox-types';
import { SNOOZE_PRESETS, canSnooze, type UseInboxSnooze } from './use-inbox-snooze';

// ── Presentation ────────────────────────────────────────────────────────────────

const GROUP_TITLE: Record<InboxGroupKey, string> = {
  APPROVALS: 'Approvals',
  POLICY_BLOCKS: 'Policy blocks',
  ALERTS: 'Alerts',
  EXCEPTIONS: 'Exceptions',
  DRAFTS: 'Drafts',
};

// Status is never colour alone (kit §7.4): a pip SHAPE plus the word.
const SEVERITY_META: Record<InboxSeverity, { pip: PipKind; label: string }> = {
  CRITICAL: { pip: 'overdue', label: 'Critical' },
  HIGH: { pip: 'risk', label: 'High' },
  MEDIUM: { pip: 'open', label: 'Medium' },
  LOW: { pip: 'track', label: 'Low' },
};

const SEVERITY_ORDER: InboxSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

type SortKey = 'urgency' | 'amount' | 'oldest';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'urgency', label: 'Most urgent' },
  { key: 'amount', label: 'Highest amount' },
  { key: 'oldest', label: 'Oldest first' },
];

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface InboxClientProps {
  /** Which groups this tab renders. */
  only: InboxGroupKey[];
  /** "Approvals" — for the empty state. */
  tabLabel: string;
  data: InboxResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  snooze: UseInboxSnooze;
}

export function InboxClient({ only, tabLabel, data, isLoading, error, refetch, snooze }: InboxClientProps) {
  const router = useRouter();
  const [sevFilter, setSevFilter] = useState<InboxSeverity | 'all'>('all');
  const [groupFilter, setGroupFilter] = useState<InboxGroupKey | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('urgency');
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  // Items for this tab, in global rank order (server already ranked data.items).
  const tabItems = useMemo(() => (data?.items ?? []).filter((i) => only.includes(i.group)), [data, only]);

  // Available filter facets (only show what exists in this tab).
  const severitiesPresent = useMemo(() => {
    const set = new Set(tabItems.map((i) => i.severity));
    return SEVERITY_ORDER.filter((s) => set.has(s));
  }, [tabItems]);

  const groupsPresent = useMemo(() => {
    const set = new Set(tabItems.map((i) => i.group));
    return only.filter((g) => set.has(g));
  }, [tabItems, only]);

  // Partition by snooze first so the count/toggle is honest.
  const { active, snoozed } = useMemo(() => {
    const a: InboxItem[] = [];
    const s: InboxItem[] = [];
    for (const it of tabItems) (snooze.isSnoozed(it.id) ? s : a).push(it);
    return { active: a, snoozed: s };
  }, [tabItems, snooze]);

  const visible = useMemo(() => {
    const base = showSnoozed ? snoozed : active;
    const filtered = base.filter((i) => {
      if (sevFilter !== 'all' && i.severity !== sevFilter) return false;
      if (groupFilter !== 'all' && i.group !== groupFilter) return false;
      return true;
    });
    const sorted = [...filtered];
    if (sort === 'amount') {
      sorted.sort((a, b) => (b.amountCents ?? -1) - (a.amountCents ?? -1));
    } else if (sort === 'oldest') {
      // sortValue ascending = oldest / most-overdue first (see collect.ts).
      sorted.sort((a, b) => a.sortValue - b.sortValue || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    }
    // 'urgency' keeps the server's global rank order.
    return sorted;
  }, [active, snoozed, showSnoozed, sevFilter, groupFilter, sort]);

  const columns = useMemo<QueueColumn<InboxItem>[]>(
    () => [
      {
        id: 'priority',
        header: 'Priority',
        width: 112,
        cell: (item) => (
          <span className="mb-sev">
            <Pip kind={SEVERITY_META[item.severity].pip} />
            {SEVERITY_META[item.severity].label}
          </span>
        ),
      },
      {
        id: 'item',
        header: 'Needs you',
        cell: (item) => (
          <>
            <a
              className="l1 mb-row-link"
              href={item.actionHref}
              onClick={(e) => {
                e.preventDefault();
                router.push(item.actionHref);
              }}
            >
              {item.title}
            </a>
            <span className="l2">{[GROUP_TITLE[item.group], item.subtitle].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      {
        id: 'due',
        header: 'Due',
        width: 132,
        cell: (item) => <span className={item.dueOrAge.includes('overdue') ? 'neg b' : 'ink-2'}>{item.dueOrAge}</span>,
      },
      {
        id: 'amount',
        header: 'Amount',
        numeric: true,
        width: 128,
        cell: (item) => (item.amountCents !== null ? money(Math.round(item.amountCents)) : <span className="ink-3">—</span>),
      },
      {
        id: 'act',
        header: <span className="sr">Actions</span>,
        width: showSnoozed ? 112 : 232,
        cell: (item) =>
          showSnoozed ? (
            <Button variant="quiet" onClick={() => snooze.unsnooze(item.id)}>
              Wake
            </Button>
          ) : (
            <span className="mb-row-acts">
              {canSnooze(item.severity) && (
                <select
                  className="select mb-snooze"
                  aria-label={`Snooze ${item.title} — hides it from your view only; nothing is changed`}
                  title="Snooze — hide from your view for a while (nothing is changed)"
                  value=""
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const p = SNOOZE_PRESETS.find((x) => x.label === e.target.value);
                    if (p) snooze.snooze(item.id, p.ms);
                  }}
                >
                  <option value="" disabled>
                    Snooze
                  </option>
                  {SNOOZE_PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
              <Button variant="default" iconAfter="right" onClick={() => router.push(item.actionHref)}>
                {item.actionLabel}
              </Button>
            </span>
          ),
      },
    ],
    [router, snooze, showSnoozed],
  );

  // ── States ───────────────────────────────────────────────────────────────────

  if (isLoading && !data) {
    return (
      <div className="surface wg-loading mb-state-block" aria-busy="true">
        <span className="bar-l" style={{ width: '72%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '58%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '66%' }} aria-hidden="true" />
        <span className="t-cap" role="status">
          Loading your inbox…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface wg-state mb-state-block" role="alert">
        <span className="tag tag--neg">Not loaded</span>
        <span className="t-head">This tab didn’t load</span>
        <p>{error}</p>
        <Button onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }

  const nothingInTab = tabItems.length === 0;

  return (
    <div className="mb-inbox-body">
      {data && data.degraded.length > 0 && (
        <InlineNotice tone="warn" title="Some sources were skipped.">
          {data.degraded.join(', ')} didn’t answer. The rest of your inbox is complete.
        </InlineNotice>
      )}

      {nothingInTab ? (
        <div className="surface wg-state mb-state-block">
          <span className="wg-done-mark" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="t-head">Nothing in {tabLabel} right now</span>
          <p>New items land here ranked by urgency. The other tabs may still need you — their counts are above.</p>
        </div>
      ) : (
        <>
          {/* Controls: priority + module filters, sort, snoozed toggle */}
          <div className="mb-toolbar">
            {severitiesPresent.length > 1 && (
              <Seg
                aria-label="Filter by priority"
                value={sevFilter}
                onChange={setSevFilter}
                items={[
                  { value: 'all' as const, label: 'All' },
                  ...severitiesPresent.map((s) => ({ value: s, label: SEVERITY_META[s].label })),
                ]}
              />
            )}
            {groupsPresent.length > 1 && (
              <Seg
                aria-label="Filter by kind"
                value={groupFilter}
                onChange={setGroupFilter}
                items={[{ value: 'all' as const, label: 'All kinds' }, ...groupsPresent.map((g) => ({ value: g, label: GROUP_TITLE[g] }))]}
              />
            )}
            <span className="sp" />
            {snoozed.length > 0 && (
              <Button variant={showSnoozed ? 'primary' : 'default'} aria-pressed={showSnoozed} count={snoozed.length} onClick={() => setShowSnoozed((s) => !s)}>
                Snoozed
              </Button>
            )}
            <label className="mb-inline-field">
              <span className="t-cap">Sort</span>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {showSnoozed && (
            <InlineNotice tone="info" title="Showing snoozed items.">
              They’re hidden from your main view (and still counted on the rail) until they wake. Wake one to bring it back.
            </InlineNotice>
          )}

          {visible.length === 0 ? (
            <div className="surface wg-state mb-state-block">
              <span className="t-head">{showSnoozed ? 'No snoozed items in this tab' : 'No items match this filter'}</span>
              <p>Clear a filter to see the rest.</p>
            </div>
          ) : (
            <div className="surface mb-queue">
              <QueueTable
                aria-label={`${tabLabel}, most urgent first`}
                columns={columns}
                rows={visible}
                getRowId={(i) => i.id}
                rowState={(i) => ({ attn: i.severity === 'CRITICAL' })}
                cursorId={cursor}
                onCursorChange={(id) => setCursor(id)}
                onOpen={showSnoozed ? undefined : (i) => router.push(i.actionHref)}
                flush
              />
            </div>
          )}

          {!showSnoozed && visible.length > 0 && (
            <div className="mb-hints">
              <Keyhints
                hints={[
                  { chord: 'j k', label: 'move' },
                  { chord: 'enter', label: 'open' },
                ]}
              />
              <span className="t-cap">This view is read-only — acting on an item opens its own screen.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
