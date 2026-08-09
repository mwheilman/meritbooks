'use client';

import { useState } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  Loader2, CalendarClock, Landmark, Repeat, AlertTriangle, ChevronDown, ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';

type ObligationKind = 'DEBT' | 'RECURRING' | 'LEASE' | 'PAYROLL' | 'OTHER';
interface ObligationItem {
  id: string; kind: ObligationKind; label: string; party: string | null;
  dueDate: string; amountCents: number; interestCents?: number; principalCents?: number;
}
interface ObligationBucket { days: number; label: string; totalCents: number; count: number; cashAfterCents: number }
interface ObligationsResponse {
  currentCashCents: number;
  asOfDate: string;
  items: ObligationItem[];
  buckets: ObligationBucket[];
  totalWithinHorizonCents: number;
  firstShortfallDays: number | null;
  debtItemCount: number;
  recurringItemCount: number;
}

function fmtDate(iso: string): string {
  return new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const KIND_ICON: Record<ObligationKind, typeof Landmark> = {
  DEBT: Landmark, RECURRING: Repeat, LEASE: Repeat, PAYROLL: Repeat, OTHER: CalendarClock,
};

/**
 * Upcoming obligations against the cash balance — scheduled debt-service payments
 * and recurring outflows over the next 90 days, bucketed so a treasurer sees what
 * cash is committed and where it would run short. Read-only, deterministic.
 */
export function CashObligations({ locationId }: { locationId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const params = locationId ? { location_id: locationId } : undefined;
  const { data, isLoading, error } = useQuery<ObligationsResponse>('/api/cash/obligations', params);

  if (isLoading) {
    return <div className="card p-6 flex items-center justify-center h-[168px]"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>;
  }
  if (error) {
    return <div className="card p-6 text-center text-xs text-red-400 h-[168px] flex items-center justify-center">{error}</div>;
  }

  const buckets = data?.buckets ?? [];
  const items = data?.items ?? [];
  const b30 = buckets.find((b) => b.days === 30);
  const b90 = buckets.find((b) => b.days === 90);
  const hasObligations = items.length > 0;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
            <CalendarClock size={14} className="text-amber-400" /> Upcoming Obligations
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Scheduled debt service + recurring outflows, next 90 days
          </p>
        </div>
        {hasObligations && (
          <div className="text-right">
            <p className="text-lg font-mono font-semibold text-white">{formatMoney(data?.totalWithinHorizonCents ?? 0, { compact: true })}</p>
            <p className="text-[11px] text-slate-500 font-mono">
              {data?.debtItemCount ?? 0} debt · {data?.recurringItemCount ?? 0} recurring
            </p>
          </div>
        )}
      </div>

      {!hasObligations ? (
        <div className="h-[64px] flex flex-col items-center justify-center text-center">
          <p className="text-xs text-slate-500">No scheduled obligations in the next 90 days.</p>
          <p className="text-[11px] text-slate-600 mt-0.5">Debt payments and recurring outflows will appear here.</p>
        </div>
      ) : (
        <>
          {/* Cash-after by horizon */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[b30, b90].filter(Boolean).map((b) => {
              const bucket = b as ObligationBucket;
              const short = bucket.cashAfterCents < 0;
              return (
                <div key={bucket.days} className={clsx('rounded-lg border p-2.5', short ? 'border-red-500/30 bg-red-500/[0.05]' : 'border-slate-800 bg-slate-800/20')}>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">{bucket.label}</p>
                  <p className="text-sm font-mono text-slate-300 mt-0.5">
                    Due {formatMoney(bucket.totalCents, { compact: true })}
                  </p>
                  <p className={clsx('text-[11px] font-mono mt-0.5', short ? 'text-red-400' : 'text-emerald-400/80')}>
                    Cash after {formatMoney(bucket.cashAfterCents, { compact: true })}
                  </p>
                </div>
              );
            })}
          </div>

          {data?.firstShortfallDays != null && (
            <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg border border-red-500/20 bg-red-500/[0.06] text-red-300 text-[11px]">
              <AlertTriangle size={13} />
              <span>Obligations exceed cash within {data.firstShortfallDays} days. Accelerate collections or defer disbursements.</span>
            </div>
          )}

          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? 'Hide' : 'Show'} {items.length} scheduled item{items.length === 1 ? '' : 's'}
          </button>

          {expanded && (
            <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-slate-800/40">
              {items.map((it) => {
                const Icon = KIND_ICON[it.kind];
                return (
                  <div key={it.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-slate-700/40 flex items-center justify-center shrink-0">
                        <Icon size={13} className="text-slate-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-slate-300 truncate">{it.label}</p>
                        <p className="text-[10px] text-slate-600 font-mono">
                          {fmtDate(it.dueDate)}
                          {it.party && <> · {it.party}</>}
                          {it.kind === 'DEBT' && it.interestCents != null && it.principalCents != null && (
                            <> · int {formatMoney(it.interestCents, { compact: true })} / prin {formatMoney(it.principalCents, { compact: true })}</>
                          )}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs font-mono text-slate-200 shrink-0">{formatMoney(it.amountCents)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
