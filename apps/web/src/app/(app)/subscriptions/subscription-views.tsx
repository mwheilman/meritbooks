'use client';

import Link from 'next/link';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import {
  TrendingUp, TrendingDown, CalendarClock, ExternalLink, Check, Ban, Pencil, XCircle,
  Copy, Clock, ArrowUpRight, Minus,
} from 'lucide-react';
import type { SubStatus } from './subscription-editor';
import {
  type Subscription, type RenewalDue, type TrendPoint, type PriceCreepItem, type SubsSummary,
  FLAG_STYLE, CADENCE_LABEL, fmtDate, fmtCents, fmtPct, annualized,
} from './subscription-types';

type Decide = (s: Subscription, action: 'keep' | 'cancel' | 'review') => void;

// ─────────────────────────────────────────────────────────────────────────────
// Run-rate summary + spend trend
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold font-mono', tone ?? 'text-white')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function RunRateSummary({ summary }: { summary: SubsSummary }) {
  const creepSignals = summary.newCount + summary.priceIncreaseCount + summary.duplicateCount + summary.staleCount;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        label="Monthly run-rate"
        value={formatMoney(summary.totalMonthlyCents)}
        sub={`${summary.count} active ${summary.count === 1 ? 'subscription' : 'subscriptions'}`}
      />
      <StatCard label="Annualized run-rate" value={formatMoney(summary.totalAnnualCents)} tone="text-emerald-400" />
      <StatCard
        label="Creep signals"
        value={String(creepSignals)}
        sub={`${summary.newCount} new · ${summary.priceIncreaseCount} price ↑ · ${summary.duplicateCount} overlap · ${summary.staleCount} stale`}
        tone={creepSignals > 0 ? 'text-amber-400' : 'text-white'}
      />
      <StatCard
        label="Renewals due"
        value={String(summary.renewalsDue)}
        sub={summary.noticePassed > 0 ? `${summary.noticePassed} past notice deadline` : `next ${summary.windowDays} days`}
        tone={summary.noticePassed > 0 ? 'text-red-400' : 'text-white'}
      />
    </div>
  );
}

/** Inline monthly run-rate trend — deterministic bars rebuilt from detection facts. */
export function SpendTrend({ trend, summary }: { trend: TrendPoint[]; summary: SubsSummary }) {
  const points = trend ?? [];
  const max = Math.max(1, ...points.map((p) => p.totalCents));
  const up = summary.trendDeltaCents > 0;
  const flat = summary.trendDeltaCents === 0;
  const DeltaIcon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const deltaTone = flat ? 'text-slate-400' : up ? 'text-amber-400' : 'text-emerald-400';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-white">Recurring-spend trend</div>
        <div className={clsx('flex items-center gap-1.5 text-xs font-mono', deltaTone)}>
          <DeltaIcon size={13} />
          {up ? '+' : ''}{formatMoney(summary.trendDeltaCents)}/mo
          <span className="text-slate-500">({fmtPct(summary.trendPct)} over {summary.trendMonths}m)</span>
        </div>
      </div>
      {points.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">Not enough history to chart a trend yet.</div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-28" role="img" aria-label="Monthly recurring-spend run-rate">
            {points.map((p, i) => {
              const h = Math.round((p.totalCents / max) * 100);
              const isLast = i === points.length - 1;
              return (
                <div key={p.month} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                  <div
                    className={clsx('w-full rounded-t transition-all', isLast ? 'bg-emerald-500' : 'bg-emerald-500/40 group-hover:bg-emerald-500/60')}
                    style={{ height: `${Math.max(2, h)}%` }}
                  />
                  <div className="absolute -top-7 hidden group-hover:block whitespace-nowrap text-[10px] font-mono bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-slate-200 z-10">
                    {p.label}: {formatMoney(p.totalCents)}/mo
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-1 mt-1.5">
            {points.map((p, i) => (
              <div key={p.month} className="flex-1 text-center text-[9px] text-slate-600 truncate">
                {i % 2 === 0 || points.length <= 6 ? p.label : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Price-creep list
// ─────────────────────────────────────────────────────────────────────────────

export function PriceCreepPanel({
  items,
  annualizedCreepCents,
  onFind,
  onDecide,
}: {
  items: PriceCreepItem[];
  annualizedCreepCents: number;
  onFind: (id: string) => void;
  onDecide: (id: string, action: 'keep' | 'cancel' | 'review') => void;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <TrendingUp size={15} className="text-red-400" /> Price creep
        </div>
        {items.length > 0 && (
          <div className="text-xs font-mono text-red-300">
            +{formatMoney(annualizedCreepCents)}/yr from increases
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">
          No price increases detected. When a subscription&apos;s charge rises above its prior steady amount, it shows here with the delta.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-left">
                <th className="px-1 py-1.5 font-medium">Subscription</th>
                <th className="px-1 py-1.5 font-medium text-right">Was</th>
                <th className="px-1 py-1.5 font-medium text-right">Now</th>
                <th className="px-1 py-1.5 font-medium text-right">Increase</th>
                <th className="px-1 py-1.5 font-medium text-right">Annualized</th>
                <th className="px-1 py-1.5 font-medium text-right">Renews</th>
                <th className="px-1 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-slate-800/70">
                  <td className="px-1 py-2">
                    <div className="text-white truncate max-w-[180px]">{it.vendor_name}</div>
                    {it.category && <div className="text-[11px] text-slate-500 truncate max-w-[180px]">{it.category}</div>}
                  </td>
                  <td className="px-1 py-2 text-right font-mono text-slate-500 line-through">{formatMoney(it.priorCents)}</td>
                  <td className="px-1 py-2 text-right font-mono text-slate-200">{formatMoney(it.currentCents)}{CADENCE_LABEL[it.billing_cadence]}</td>
                  <td className="px-1 py-2 text-right font-mono text-red-300 whitespace-nowrap">
                    +{formatMoney(it.deltaCents)} <span className="text-red-400/80">({fmtPct(it.pct)})</span>
                  </td>
                  <td className="px-1 py-2 text-right font-mono text-red-300">+{formatMoney(it.annualizedDeltaCents)}</td>
                  <td className="px-1 py-2 text-right text-xs text-slate-500 whitespace-nowrap">{fmtDate(it.next_renewal_date)}</td>
                  <td className="px-1 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => onDecide(it.id, 'cancel')} title="Flag to cancel" className="p-1 rounded text-amber-400 hover:bg-amber-500/10"><Ban size={14} /></button>
                      <button onClick={() => onFind(it.id)} title="Find in list" className="p-1 rounded text-slate-400 hover:bg-slate-800 hover:text-white"><ArrowUpRight size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Renewals — next N days, notice-aware, feeds the obligations calendar
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [30, 60, 90, 120];

export function RenewalsPanel({
  renewals,
  windowDays,
  onWindowChange,
  onDecide,
}: {
  renewals: RenewalDue[];
  windowDays: number;
  onWindowChange: (days: number) => void;
  onDecide: Decide;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <CalendarClock size={15} className="text-amber-400" /> Renewals — next {windowDays} days
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-800 overflow-hidden">
            {WINDOW_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => onWindowChange(d)}
                className={clsx('px-2.5 py-1 text-xs font-mono', d === windowDays ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')}
              >
                {d}d
              </button>
            ))}
          </div>
          <Link href="/obligations" className="text-xs text-indigo-300 hover:text-indigo-200 flex items-center gap-1">
            Calendar <ExternalLink size={12} />
          </Link>
        </div>
      </div>
      {renewals.length === 0 ? (
        <div className="text-xs text-slate-500 py-6 text-center">
          No renewals need a decision in the next {windowDays} days. Windows are notice-period aware — a subscription requiring notice shows up before the cancel window closes.
        </div>
      ) : (
        <div className="space-y-1">
          {renewals.map((r) => {
            const s = r.subscription;
            const tone = r.noticeWindowPassed ? 'text-red-400' : r.daysUntilNoticeDeadline <= 7 ? 'text-amber-400' : 'text-slate-400';
            return (
              <div key={s.id} className="flex items-center gap-3 text-sm py-1 border-b border-slate-800/50 last:border-0">
                <span className={clsx('font-mono text-xs w-28 shrink-0', tone)}>
                  {r.noticeWindowPassed ? 'notice passed' : `${r.daysUntilNoticeDeadline}d to decide`}
                </span>
                <span className="text-white flex-1 truncate">{s.vendor_name}</span>
                <span className="text-slate-400 font-mono whitespace-nowrap">{fmtCents(s.amount_cents)}{CADENCE_LABEL[s.billing_cadence]}</span>
                <span className="text-slate-500 text-xs w-24 text-right whitespace-nowrap">renews {fmtDate(s.next_renewal_date)}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {s.status !== 'KEPT' && (
                    <button onClick={() => onDecide(s, 'keep')} title="Keep" className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"><Check size={14} /></button>
                  )}
                  {s.status !== 'CANCELLING' && (
                    <button onClick={() => onDecide(s, 'cancel')} title="Flag to cancel" className="p-1 rounded text-amber-400 hover:bg-amber-500/10"><Ban size={14} /></button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Triage board — keep / review / flag-to-cancel lanes
// ─────────────────────────────────────────────────────────────────────────────

interface Lane {
  key: string;
  label: string;
  statuses: SubStatus[];
  accent: string;
}

const LANES: Lane[] = [
  { key: 'triage', label: 'Needs a decision', statuses: ['DETECTED', 'ACTIVE'], accent: 'text-indigo-300' },
  { key: 'review', label: 'Under review', statuses: ['UNDER_REVIEW'], accent: 'text-blue-300' },
  { key: 'keep', label: 'Keeping', statuses: ['KEPT'], accent: 'text-emerald-300' },
  { key: 'cancel', label: 'Flagged to cancel', statuses: ['CANCELLING'], accent: 'text-amber-300' },
  { key: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'], accent: 'text-slate-400' },
];

function TriageCard({ s, onDecide, onEdit }: { s: Subscription; onDecide: Decide; onEdit: (s: Subscription) => void }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">{s.vendor_name}</div>
          <div className="text-[11px] text-slate-500 font-mono">
            {fmtCents(s.amount_cents)}{CADENCE_LABEL[s.billing_cadence]} · {formatMoney(annualized(s))}/yr
          </div>
        </div>
      </div>
      {(s.creep_flags ?? []).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(s.creep_flags ?? []).map((f) => (
            <span key={f} className={clsx('text-[9px] px-1 py-0.5 rounded border inline-flex items-center gap-0.5', FLAG_STYLE[f].cls)}>
              {f === 'PRICE_INCREASE' && <TrendingUp size={9} />}
              {f === 'DUPLICATE_CATEGORY' && <Copy size={9} />}
              {f === 'STALE' && <Clock size={9} />}
              {FLAG_STYLE[f].label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-slate-500">renews {fmtDate(s.next_renewal_date)}</span>
        <div className="flex items-center gap-0.5">
          {s.status !== 'KEPT' && (
            <button onClick={() => onDecide(s, 'keep')} title="Keep" className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"><Check size={13} /></button>
          )}
          {(s.status === 'DETECTED' || s.status === 'ACTIVE') && (
            <button onClick={() => onDecide(s, 'review')} title="Mark under review" className="p-1 rounded text-blue-400 hover:bg-blue-500/10"><XCircle size={13} /></button>
          )}
          {s.status !== 'CANCELLING' && s.status !== 'CANCELLED' && (
            <button onClick={() => onDecide(s, 'cancel')} title="Flag to cancel" className="p-1 rounded text-amber-400 hover:bg-amber-500/10"><Ban size={13} /></button>
          )}
          <button onClick={() => onEdit(s)} title="Edit" className="p-1 rounded text-slate-400 hover:bg-slate-800 hover:text-white"><Pencil size={13} /></button>
        </div>
      </div>
    </div>
  );
}

export function TriageBoard({
  subs,
  onDecide,
  onEdit,
}: {
  subs: Subscription[];
  onDecide: Decide;
  onEdit: (s: Subscription) => void;
}) {
  const byLane = LANES.map((lane) => ({
    lane,
    items: subs.filter((s) => lane.statuses.includes(s.status)),
  }));

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {byLane.map(({ lane, items }) => {
        const monthly = items.reduce((sum, s) => sum + (s.amount_cents ?? 0) * (s.billing_cadence === 'ANNUAL' ? 1 / 12 : s.billing_cadence === 'QUARTERLY' ? 1 / 3 : 1), 0);
        return (
          <div key={lane.key} className="card p-3">
            <div className="flex items-center justify-between mb-2">
              <div className={clsx('text-xs font-medium', lane.accent)}>{lane.label}</div>
              <div className="text-[10px] text-slate-600 font-mono">{items.length}</div>
            </div>
            {items.length > 0 && lane.key !== 'cancelled' && (
              <div className="text-[10px] text-slate-500 font-mono mb-2">{formatMoney(Math.round(monthly))}/mo</div>
            )}
            <div className="space-y-2">
              {items.length === 0 ? (
                <div className="text-[11px] text-slate-600 py-4 text-center">Empty</div>
              ) : (
                items.map((s) => <TriageCard key={s.id} s={s} onDecide={onDecide} onEdit={onEdit} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
