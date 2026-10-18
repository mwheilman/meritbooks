'use client';

/**
 * NOTIFICATIONS BELL — the real notifications center in the top header.
 *
 * A thin, read-only presenter over the ACTION INBOX aggregate (GET /api/inbox →
 * collectInbox). It reuses the exact same ranked "Needs you" feed that powers the
 * /inbox screen — pending money-movement approvals, AP policy blocks, overdue
 * obligations (alerts), open AI exceptions, and unposted JE drafts — and shows:
 *   • a LIVE count badge (real total of actionable items, never a fake dot), and
 *   • a dropdown of the top items grouped by section, each deep-linking to where
 *     you actually act on it, plus "View all in Inbox".
 *
 * No new tables, no writes. It polls the inbox on an interval and refreshes when
 * opened. Org isolation is enforced server-side by RLS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Bell, Loader2, CheckCircle2, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api-client';

const POLL_MS = 60_000;
const MAX_ITEMS = 8;

type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';
type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';
type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface InboxItem {
  id: string;
  type: InboxItemType;
  group: InboxGroupKey;
  title: string;
  subtitle: string | null;
  dueOrAge: string;
  severity: InboxSeverity;
  actionHref: string;
  actionLabel: string;
  amountCents: number | null;
}

interface InboxGroup {
  key: InboxGroupKey;
  items: InboxItem[];
}

interface InboxResponse {
  items: InboxItem[];
  groups: InboxGroup[];
  counts: { total: number; byType: Record<InboxItemType, number> };
  degraded: string[];
}

const GROUP_LABEL: Record<InboxGroupKey, string> = {
  APPROVALS: 'Approvals',
  POLICY_BLOCKS: 'Blocks',
  ALERTS: 'Alerts',
  EXCEPTIONS: 'Exceptions',
  DRAFTS: 'Drafts',
};

const SEVERITY_DOT: Record<InboxSeverity, string> = {
  CRITICAL: 'bg-red-500',
  HIGH: 'bg-amber-400',
  MEDIUM: 'bg-blue-400',
  LOW: 'bg-slate-500',
};

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    const res = await api.get<InboxResponse>('/api/inbox');
    if (!mountedRef.current) return;
    if (res.error) {
      setError(res.error.error);
    } else {
      setData(res.data);
    }
    setLoading(false);
  }, []);

  // Initial load + polling so the badge stays live without a page refresh.
  useEffect(() => {
    mountedRef.current = true;
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [load]);

  // Refresh on open so the dropdown is never stale.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const total = data?.counts.total ?? 0;
  const badge = total > 99 ? '99+' : String(total);

  // Trim to the top MAX_ITEMS across the already-ranked groups for the dropdown.
  const groups: InboxGroup[] = (() => {
    if (!data) return [];
    let budget = MAX_ITEMS;
    const out: InboxGroup[] = [];
    for (const g of data.groups) {
      if (budget <= 0) break;
      const items = g.items.slice(0, budget);
      if (items.length > 0) {
        out.push({ key: g.key, items });
        budget -= items.length;
      }
    }
    return out;
  })();

  const act = (item: InboxItem) => {
    setOpen(false);
    router.push(item.actionHref);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={total > 0 ? `Notifications, ${total} need you` : 'Notifications'}
        className="relative p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] transition-colors"
      >
        <Bell size={18} />
        {total > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-96 overflow-hidden rounded-xl border border-slate-800 bg-surface-900 shadow-2xl animate-slide-up">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-100">Notifications</span>
                {total > 0 && (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-2xs font-medium text-slate-300">
                    {total}
                  </span>
                )}
              </div>
              <Link
                href="/inbox"
                onClick={() => setOpen(false)}
                className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300"
              >
                View all
                <ArrowRight size={12} />
              </Link>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {loading && !data && (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
                  <Loader2 size={16} className="animate-spin" />
                  Loading…
                </div>
              )}

              {error && (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-red-400">Couldn’t load notifications.</p>
                  <button
                    onClick={load}
                    className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.03]"
                  >
                    Retry
                  </button>
                </div>
              )}

              {!loading && !error && total === 0 && (
                <div className="px-4 py-12 text-center">
                  <CheckCircle2 size={28} className="mx-auto text-brand-500/70" />
                  <p className="mt-2 text-sm text-slate-300">You’re all caught up</p>
                  <p className="mt-0.5 text-xs text-slate-600">Nothing needs you right now.</p>
                </div>
              )}

              {!error &&
                groups.map((group) => (
                  <div key={group.key}>
                    <div className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                      {GROUP_LABEL[group.key]}
                    </div>
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => act(item)}
                        className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                      >
                        <span
                          className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[item.severity])}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-100">{item.title}</div>
                          {item.subtitle && (
                            <div className="truncate text-xs text-slate-500">{item.subtitle}</div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5">
                          <span className="text-2xs text-slate-500">{item.dueOrAge}</span>
                          <span className="text-2xs font-medium text-brand-400">{item.actionLabel}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}

              {/* Footer link when there are more than we showed */}
              {!error && total > 0 && (
                <Link
                  href="/inbox"
                  onClick={() => setOpen(false)}
                  className="block border-t border-slate-800 px-4 py-3 text-center text-xs font-medium text-brand-400 hover:bg-white/[0.03]"
                >
                  View all in Inbox
                </Link>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
