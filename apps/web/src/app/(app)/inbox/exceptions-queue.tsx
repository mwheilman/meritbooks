'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Conf, Icon, Keyhints, QueueTable, Seg, Tag, money, type QueueColumn, type TagTone } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { groupRowsByClient, type ExceptionItem, type ExceptionSource, type ExceptionsResponse, type Disposition } from './inbox-types';

// ── Autonomy disposition presentation ─────────────────────────────────────────

const DISPOSITION_ORDER: Disposition[] = ['AUTO', 'REVIEW', 'ESCALATE', 'BLOCKED'];

const DISPOSITION_META: Record<Disposition, { label: string; tone: TagTone; help: string }> = {
  AUTO: {
    label: 'Auto-eligible',
    tone: 'ai',
    help: 'The dial would let the machine apply this — but auto-post is off, so it still needs your approval.',
  },
  REVIEW: {
    label: 'Needs review',
    tone: 'warn',
    help: 'Routine: a human should review and approve.',
  },
  ESCALATE: {
    label: 'Escalate',
    tone: 'neg',
    help: 'Urgent: low confidence or high risk — a human must look.',
  },
  BLOCKED: {
    label: 'Blocked',
    tone: 'solid',
    help: 'The capability is off or the kill switch is engaged — suppressed from the auto lane.',
  },
};

// ── Source presentation ─────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<ExceptionSource, string> = {
  bank: 'Bank feed',
  receipt: 'Receipt',
  ai_proposal: 'AI proposal',
  cost: 'Job cost',
};

const SOURCE_ORDER: ExceptionSource[] = ['ai_proposal', 'bank', 'receipt', 'cost'];

// ── Sort ────────────────────────────────────────────────────────────────────────

type SortKey = 'urgency' | 'amount' | 'oldest';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'urgency', label: 'Newest first' },
  { key: 'amount', label: 'Highest amount' },
  { key: 'oldest', label: 'Oldest first' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** Sources with a SAFE (non-financial) resolve action + the button verb to show. */
const RESOLVE_LABEL: Partial<Record<ExceptionSource, string>> = {
  bank: 'Resolve',
  receipt: 'Resolve',
  ai_proposal: 'Dismiss',
};

/** The disposition filter: any row, every AI proposal, one disposition, or AI rows with none recorded. */
type DispoFilter = 'all' | 'ai' | Disposition | 'unscored';

const keyOf = (item: ExceptionItem) => `${item.source}:${item.id}`;

// ── Queue ─────────────────────────────────────────────────────────────────────
// The Inbox → Exceptions tab. Data is loaded by the shell (useInboxData) and passed
// in, so the tab count and this list never diverge. Keeps the SAFE inline-resolve
// behavior (bank/receipt/bill resolve + ai_proposal dismiss via /api/exceptions/
// resolve — never money movement) and the source/disposition/sort filters,
// J/K/↵/E keys (now through the merit-ui registry) and a session "resolved" trail.

interface ResolvedTrailItem {
  key: string;
  title: string;
  verb: string;
  at: number;
}

export interface ExceptionsQueueProps {
  data: ExceptionsResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** All-clients context: group rows by client (+ "Organization" for org-level items). */
  groupByClient?: boolean;
}

export function ExceptionsQueue({ data, isLoading, error, refetch, groupByClient = false }: ExceptionsQueueProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<ExceptionSource | 'all'>('all');
  const [dispoFilter, setDispoFilter] = useState<DispoFilter>('all');
  const [sort, setSort] = useState<SortKey>('urgency');
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [recentlyResolved, setRecentlyResolved] = useState<ResolvedTrailItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const items = useMemo(() => data?.data ?? [], [data]);
  const counts = data?.counts;

  const filtered = useMemo(() => {
    const base = items.filter((i) => {
      if (filter !== 'all' && i.source !== filter) return false;
      if (dispoFilter === 'ai') return i.source === 'ai_proposal';
      if (dispoFilter === 'unscored') return i.source === 'ai_proposal' && i.disposition === null;
      if (dispoFilter !== 'all' && i.disposition !== dispoFilter) return false;
      return true;
    });
    const sorted = [...base];
    if (sort === 'amount') {
      sorted.sort((a, b) => (b.amountCents ?? -1) - (a.amountCents ?? -1));
    } else if (sort === 'oldest') {
      sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    // 'urgency' keeps the server's newest-first order.
    return sorted;
  }, [items, filter, dispoFilter, sort]);

  // All-clients context: one band per client, busiest first, Organization last.
  const clientGroups = useMemo(
    () =>
      groupByClient
        ? groupRowsByClient(filtered, (i) => ({ id: i.companyId, name: i.companyName })).map((g) => ({
            id: g.id,
            title: g.title,
            count: g.rows.length.toLocaleString(),
            rows: g.rows,
          }))
        : undefined,
    [groupByClient, filtered],
  );

  // The AI-disposition chips sum to the AI proposal count (proposals with no recorded
  // disposition are their own "Not scored" chip), and "All AI" filters to exactly
  // those rows — so every chip's number is the number of rows it shows.
  const dispoChips = useMemo(() => {
    const byDisposition = counts?.byDisposition ?? { AUTO: 0, REVIEW: 0, ESCALATE: 0, BLOCKED: 0 };
    const unscored = counts?.unscored ?? 0;
    const aiTotal = DISPOSITION_ORDER.reduce((sum, d) => sum + (byDisposition[d] ?? 0), 0) + unscored;
    if (aiTotal === 0) return [];
    const list: { value: DispoFilter; label: string; count: number }[] = [
      { value: 'all', label: 'Any', count: counts?.total ?? 0 },
      { value: 'ai', label: 'All AI', count: aiTotal },
    ];
    for (const d of DISPOSITION_ORDER) {
      const c = byDisposition[d] ?? 0;
      if (c > 0) list.push({ value: d, label: DISPOSITION_META[d].label, count: c });
    }
    if (unscored > 0) list.push({ value: 'unscored', label: 'Not scored', count: unscored });
    return list;
  }, [counts]);

  const chips = useMemo(() => {
    const bySource = counts?.bySource ?? {};
    const list: { value: ExceptionSource | 'all'; label: string; count: number }[] = [{ value: 'all', label: 'All', count: counts?.total ?? 0 }];
    for (const src of SOURCE_ORDER) {
      const c = bySource[src] ?? 0;
      if (c > 0) list.push({ value: src, label: SOURCE_LABEL[src], count: c });
    }
    return list;
  }, [counts]);

  async function resolve(item: ExceptionItem) {
    const key = keyOf(item);
    setResolvingKey(key);
    const verb = item.source === 'ai_proposal' ? 'Dismissed' : 'Resolved';
    const result = await api.post<{ ok: boolean }>('/api/exceptions/resolve', {
      source: item.source,
      id: item.id,
    });
    if (result.error) {
      addToast('error', result.error.error || 'Could not resolve the item. Try again, or open it to act there.');
      setResolvingKey(null);
      return;
    }
    // The toast repeats the verb (kit §1.2).
    addToast('success', `${verb} · ${item.title}`);
    setRecentlyResolved((prev) => [{ key, title: item.title, verb, at: Date.now() }, ...prev].slice(0, 5));
    await refetch();
    setResolvingKey(null);
  }

  const columns = useMemo<QueueColumn<ExceptionItem>[]>(
    () => [
      {
        id: 'source',
        header: 'Source',
        width: 132,
        cell: (item) => <Tag tone={item.source === 'ai_proposal' ? 'ai' : 'default'}>{SOURCE_LABEL[item.source]}</Tag>,
      },
      {
        id: 'item',
        header: 'Needs a human',
        cell: (item) => (
          <>
            <a
              className="l1 mb-row-link"
              href={item.href}
              onClick={(e) => {
                e.preventDefault();
                router.push(item.href);
              }}
            >
              {item.title}
            </a>
            <span className="l2">{[item.subtitle, relativeTime(item.createdAt)].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      {
        id: 'conf',
        header: 'Confidence',
        width: 112,
        cell: (item) => (item.confidence !== null ? <Conf score={Math.round(item.confidence * 100)} /> : <span className="ink-3">—</span>),
      },
      {
        id: 'dispo',
        header: 'AI would',
        width: 132,
        cell: (item) =>
          item.disposition ? (
            <Tag tone={DISPOSITION_META[item.disposition].tone} title={DISPOSITION_META[item.disposition].help}>
              {DISPOSITION_META[item.disposition].label}
            </Tag>
          ) : (
            <span className="ink-3">—</span>
          ),
      },
      {
        id: 'amount',
        header: 'Amount',
        numeric: true,
        width: 120,
        cell: (item) => (item.amountCents !== null ? money(Math.round(item.amountCents)) : <span className="ink-3">—</span>),
      },
      {
        id: 'act',
        header: <span className="sr">Actions</span>,
        width: 112,
        cell: (item) => {
          const label = RESOLVE_LABEL[item.source];
          if (!label) return null;
          const busy = resolvingKey === keyOf(item);
          return (
            <Button
              disabled={resolvingKey !== null}
              onClick={(e) => {
                e.stopPropagation();
                void resolve(item);
              }}
            >
              {busy ? `${label.replace(/e$/, '')}ing…` : label}
            </Button>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, resolvingKey],
  );

  if (isLoading && !data) {
    return (
      <div className="surface wg-loading mb-state-block" aria-busy="true">
        <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '54%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '62%' }} aria-hidden="true" />
        <span className="t-cap" role="status">
          Loading exceptions…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface wg-state mb-state-block" role="alert">
        <span className="tag tag--neg">Not loaded</span>
        <span className="t-head">Exceptions didn’t load</span>
        <p>{error}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="mb-inbox-body">
      {counts && counts.total > 0 && (
        <p className="t-cap">
          {counts.total} {counts.total === 1 ? 'item' : 'items'} across your queues need a human. Resolve safe (non-financial) flags here, or open an
          item to act on it.
        </p>
      )}

      {recentlyResolved.length > 0 && (
        <div className="inline-notice mb-resolved" role="status">
          <Icon name="check" className="pos" />
          <div>
            <b>Resolved this session</b>
            <ul className="ev">
              {recentlyResolved.map((r) => (
                <li key={`${r.key}:${r.at}`}>
                  {r.verb} · {r.title}
                  <span className="dl" />
                  <span className="v">{relativeTime(new Date(r.at).toISOString())}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="surface wg-state mb-state-block">
          <span className="wg-done-mark" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="t-head">No exceptions right now</span>
          <p>No AI proposals, flagged lines or job costs are waiting. New ones land here; approvals are on the Approvals tab.</p>
        </div>
      ) : (
        <>
          <div className="mb-toolbar">
            <Seg aria-label="Filter by source" value={filter} onChange={setFilter} items={chips.map((c) => ({ value: c.value, label: c.label, count: c.count }))} />
            <span className="sp" />
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

          {/* Autonomy disposition — what the AI WOULD do vs must route (advisory). */}
          {dispoChips.length > 0 && (
            <div className="mb-toolbar">
              <span className="eyebrow">AI disposition</span>
              <Seg
                aria-label="Filter by AI disposition"
                value={dispoFilter}
                onChange={setDispoFilter}
                items={dispoChips.map((c) => ({ value: c.value, label: c.label, count: c.count }))}
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="surface wg-state mb-state-block">
              <span className="t-head">No items in this filter</span>
              <p>Choose “All” to see every exception.</p>
            </div>
          ) : (
            <div className="surface mb-queue">
              <QueueTable
                aria-label="Exceptions needing a human"
                columns={columns}
                rows={clientGroups ? undefined : filtered}
                groups={clientGroups}
                getRowId={keyOf}
                rowState={(i) => ({ attn: i.disposition === 'ESCALATE' })}
                cursorId={cursor}
                onCursorChange={(id) => setCursor(id)}
                onOpen={(i) => router.push(i.href)}
                // "e" resolves only SAFE (non-financial) rows; approvals/cost are never resolvable here.
                actions={[
                  {
                    key: 'e',
                    label: 'Resolve a safe flag',
                    run: (rows) => {
                      const item = rows[0];
                      if (item && RESOLVE_LABEL[item.source] && resolvingKey === null) void resolve(item);
                    },
                  },
                ]}
                flush
              />
            </div>
          )}
          <div className="mb-hints">
            <Keyhints
              hints={[
                { chord: 'j k', label: 'move' },
                { chord: 'enter', label: 'open' },
                { chord: 'e', label: 'resolve a safe flag' },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}
