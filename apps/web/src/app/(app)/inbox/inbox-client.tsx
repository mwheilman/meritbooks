'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
  Ban,
  CalendarClock,
  Sparkles,
  FileText,
  Clock,
  BellOff,
  Undo2,
  ArrowUpDown,
  type LucideIcon,
} from 'lucide-react';
import type {
  InboxItem,
  InboxGroupKey,
  InboxSeverity,
  InboxResponse,
} from './inbox-types';
import { SEVERITY_RANK } from './inbox-types';
import { useListKeynav } from './use-list-keynav';
import { SNOOZE_PRESETS, canSnooze, type UseInboxSnooze } from './use-inbox-snooze';

// ── Presentation ────────────────────────────────────────────────────────────────

const GROUP_META: Record<
  InboxGroupKey,
  { title: string; hint: string; icon: LucideIcon; accent: string }
> = {
  APPROVALS: {
    title: 'Approvals',
    hint: 'Money movement + expense reports waiting on you',
    icon: ShieldCheck,
    accent: 'text-emerald-400',
  },
  POLICY_BLOCKS: {
    title: 'Policy blocks',
    hint: 'Held by AP or expense policy — resolve to release',
    icon: Ban,
    accent: 'text-red-400',
  },
  ALERTS: {
    title: 'Alerts',
    hint: 'Time-sensitive obligations — overdue or due soon',
    icon: CalendarClock,
    accent: 'text-amber-400',
  },
  EXCEPTIONS: {
    title: 'Exceptions',
    hint: 'AI proposals awaiting a human decision',
    icon: Sparkles,
    accent: 'text-indigo-400',
  },
  DRAFTS: {
    title: 'Drafts',
    hint: 'Unposted entries to review and finish',
    icon: FileText,
    accent: 'text-slate-300',
  },
};

const SEVERITY_META: Record<InboxSeverity, { dot: string; label: string }> = {
  CRITICAL: { dot: 'bg-red-500', label: 'Critical' },
  HIGH: { dot: 'bg-amber-500', label: 'High' },
  MEDIUM: { dot: 'bg-sky-500', label: 'Medium' },
  LOW: { dot: 'bg-slate-500', label: 'Low' },
};

const SEVERITY_ORDER: InboxSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

type SortKey = 'urgency' | 'amount' | 'oldest';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'urgency', label: 'Most urgent' },
  { key: 'amount', label: 'Highest amount' },
  { key: 'oldest', label: 'Oldest first' },
];

// ── Row ───────────────────────────────────────────────────────────────────────

function InboxRow({
  item,
  active,
  rowRef,
  onOpen,
  snooze,
}: {
  item: InboxItem;
  active: boolean;
  rowRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
  snooze: UseInboxSnooze;
}) {
  const sev = SEVERITY_META[item.severity];
  const overdue = item.dueOrAge.includes('overdue');
  const [menuOpen, setMenuOpen] = useState(false);
  const snoozeable = canSnooze(item.severity);

  return (
    <div
      ref={rowRef}
      data-active={active}
      className={clsx(
        'group relative flex items-center gap-4 rounded-lg border px-4 py-3 transition',
        active
          ? 'border-emerald-500/40 bg-slate-800/50 ring-1 ring-inset ring-emerald-500/20'
          : 'border-slate-800 bg-surface-900 hover:border-slate-700 hover:bg-slate-800/40',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-4 text-left focus:outline-none"
      >
        <span
          className={clsx('h-2 w-2 flex-none rounded-full', sev.dot)}
          title={`${sev.label} priority`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{item.title}</p>
          {item.subtitle && (
            <p className="mt-0.5 truncate text-xs text-slate-500">{item.subtitle}</p>
          )}
        </div>
        <div className="flex-none text-right">
          {item.amountCents !== null && (
            <p className="font-mono text-sm text-slate-200">{formatMoney(item.amountCents)}</p>
          )}
          <p className={clsx('text-xs', overdue ? 'text-red-400' : 'text-slate-500')}>
            {item.dueOrAge}
          </p>
        </div>
      </button>

      {/* Snooze — LOCAL, view-only; never available for CRITICAL items. */}
      {snoozeable && (
        <div className="relative flex-none">
          <button
            type="button"
            title="Snooze — hide from your view for a while (nothing is changed)"
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-md border border-slate-700 bg-slate-800/40 p-1.5 text-slate-400 opacity-0 transition hover:border-slate-600 hover:text-slate-200 focus:opacity-100 group-hover:opacity-100"
          >
            <Clock size={14} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-lg border border-slate-700 bg-surface-900 shadow-xl">
                <p className="px-3 py-1.5 text-2xs uppercase tracking-wide text-slate-500">
                  Snooze for
                </p>
                {SNOOZE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => {
                      snooze.snooze(item.id, p.ms);
                      setMenuOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/60 hover:text-white"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <span className="flex flex-none items-center gap-1.5">
        <span className="rounded-md border border-slate-700 bg-slate-800/40 px-2 py-1 text-xs font-medium text-slate-300 transition group-hover:border-emerald-500/40 group-hover:text-emerald-400">
          {item.actionLabel}
        </span>
        <ChevronRight size={16} className="text-slate-600 transition group-hover:text-slate-400" />
      </span>
    </div>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface InboxClientProps {
  /** Which groups this tab renders. */
  only: InboxGroupKey[];
  data: InboxResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  snooze: UseInboxSnooze;
}

export function InboxClient({ only, data, isLoading, error, refetch, snooze }: InboxClientProps) {
  const router = useRouter();
  const [sevFilter, setSevFilter] = useState<InboxSeverity | 'all'>('all');
  const [groupFilter, setGroupFilter] = useState<InboxGroupKey | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('urgency');
  const [showSnoozed, setShowSnoozed] = useState(false);

  // Items for this tab, in global rank order (server already ranked data.items).
  const tabItems = useMemo(
    () => (data?.items ?? []).filter((i) => only.includes(i.group)),
    [data, only],
  );

  // Available filter facets (only show chips that exist in this tab).
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

  const keynav = useListKeynav({
    count: visible.length,
    enabled: !isLoading && !error,
    onOpen: (i) => {
      const item = visible[i];
      if (item) router.push(item.actionHref);
    },
  });

  // ── States ───────────────────────────────────────────────────────────────────

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="mr-2 animate-spin" size={18} />
        Loading your inbox…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-red-900/40 bg-red-950/20 py-16 text-center">
        <AlertCircle className="mb-3 text-red-400" size={28} />
        <p className="text-sm font-medium text-red-300">Could not load this tab</p>
        <p className="mt-1 max-w-md text-xs text-slate-500">{error}</p>
        <button onClick={() => refetch()} className="btn-secondary btn-sm mt-4">
          <RefreshCw size={14} className="mr-1.5" />
          Retry
        </button>
      </div>
    );
  }

  const nothingInTab = tabItems.length === 0;

  return (
    <div className="space-y-5">
      {/* Degraded-source note */}
      {data && data.degraded.length > 0 && (
        <p className="rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-2 text-xs text-amber-400/80">
          Some sources were unavailable and skipped: {data.degraded.join(', ')}. The rest of your
          inbox is complete.
        </p>
      )}

      {nothingInTab ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-surface-900 py-16 text-center">
          <CheckCircle2 size={22} className="mb-2 text-emerald-400" />
          <p className="text-sm text-slate-300">Nothing in this tab right now.</p>
          <p className="mt-1 text-xs text-slate-500">
            New items will land here, ranked by what&apos;s most urgent. Other tabs may still need
            you — the counts above show the full picture.
          </p>
        </div>
      ) : (
        <>
          {/* Controls: severity + module filters, sort, snoozed toggle */}
          <div className="flex flex-wrap items-center gap-2">
            {severitiesPresent.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <FilterChip active={sevFilter === 'all'} onClick={() => setSevFilter('all')}>
                  All
                </FilterChip>
                {severitiesPresent.map((s) => (
                  <FilterChip key={s} active={sevFilter === s} onClick={() => setSevFilter(s)}>
                    <span className={clsx('h-1.5 w-1.5 rounded-full', SEVERITY_META[s].dot)} />
                    {SEVERITY_META[s].label}
                  </FilterChip>
                ))}
              </div>
            )}

            {groupsPresent.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs uppercase tracking-wide text-slate-600">Module</span>
                <FilterChip active={groupFilter === 'all'} onClick={() => setGroupFilter('all')}>
                  All
                </FilterChip>
                {groupsPresent.map((g) => (
                  <FilterChip key={g} active={groupFilter === g} onClick={() => setGroupFilter(g)}>
                    {GROUP_META[g].title}
                  </FilterChip>
                ))}
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {snoozed.length > 0 && (
                <button
                  onClick={() => setShowSnoozed((s) => !s)}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
                    showSnoozed
                      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                      : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
                  )}
                >
                  <BellOff size={13} />
                  Snoozed
                  <span className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-[10px]">
                    {snoozed.length}
                  </span>
                </button>
              )}
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-300">
                <ArrowUpDown size={13} className="text-slate-500" />
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {showSnoozed && (
            <p className="rounded-lg border border-indigo-900/30 bg-indigo-950/10 px-3 py-2 text-xs text-indigo-300/80">
              Showing snoozed items. These are hidden from your main view (and still counted in the
              header bell) until they wake. Wake one to bring it back.
            </p>
          )}

          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-surface-900 py-12 text-center">
              <CheckCircle2 size={20} className="mb-2 text-emerald-400" />
              <p className="text-sm text-slate-300">
                {showSnoozed ? 'No snoozed items in this tab.' : 'No items match this filter.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {visible.map((item, i) => {
                const rp = keynav.rowProps(i);
                return (
                  <div key={item.id} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {showSnoozed ? (
                        <SnoozedRow item={item} onWake={() => snooze.unsnooze(item.id)} />
                      ) : (
                        <InboxRow
                          item={item}
                          active={rp['data-active']}
                          rowRef={rp.ref}
                          onOpen={() => router.push(item.actionHref)}
                          snooze={snooze}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Keyboard + read-only hint */}
          {!showSnoozed && visible.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 pt-1 text-2xs text-slate-600">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              move
              <span className="text-slate-700">·</span>
              <Kbd>↵</Kbd>
              open
              <span className="text-slate-700">·</span>
              This view is read-only — acting on an item opens its own screen.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

function SnoozedRow({ item, onWake }: { item: InboxItem; onWake: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-surface-900/60 px-4 py-3">
      <BellOff size={14} className="flex-none text-indigo-400/70" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-slate-300">{item.title}</p>
        {item.subtitle && <p className="mt-0.5 truncate text-xs text-slate-600">{item.subtitle}</p>}
      </div>
      <button
        onClick={onWake}
        className="inline-flex flex-none items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/40 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-400"
      >
        <Undo2 size={13} />
        Wake
      </button>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
      {children}
    </kbd>
  );
}
