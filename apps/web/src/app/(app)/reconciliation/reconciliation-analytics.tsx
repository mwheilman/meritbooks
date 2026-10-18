'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { ChevronDown, Layers, Scale, ArrowUpRight, ArrowDownLeft, CheckCircle2, AlertTriangle } from 'lucide-react';

// ── Types (mirror the additions to /api/reconciliation/session) ──────────────────
export interface AgingItemDto {
  id: string;
  description: string;
  amountCents: number;
  transactionDate: string;
  ageDays: number;
  isOutflow: boolean;
}
export interface AgingBucketDto {
  key: string;
  label: string;
  count: number;
  netCents: number;
  outflowCents: number;
  inflowCents: number;
  items: AgingItemDto[];
}
export interface AgingDto {
  asOfDate: string;
  oldestAgeDays: number;
  totals: { count: number; netCents: number; outflowCents: number; inflowCents: number };
  buckets: AgingBucketDto[];
}
export interface DifferenceComponentDto extends AgingItemDto {
  reducesDifferenceBy: number;
}
export interface DifferenceExplainerDto {
  differenceCents: number;
  outstandingNetCents: number;
  residualCents: number;
  fullyExplained: boolean;
  outstandingChecksCents: number;
  depositsInTransitCents: number;
  components: DifferenceComponentDto[];
}

/**
 * Reconciliation visibility analytics — two read-only, deterministic panels that
 * sit alongside the tie-out workspace (they change no state):
 *   • Aging — how long the outstanding reconciling items have been sitting.
 *   • Difference explainer — what the current statement-vs-book gap is made of.
 */
export function ReconciliationAnalytics({
  aging,
  explainer,
}: {
  aging: AgingDto | null;
  explainer: DifferenceExplainerDto | null;
}) {
  const hasAging = !!aging && aging.totals.count > 0;
  const hasExplainer = !!explainer && (explainer.components.length > 0 || explainer.differenceCents !== 0);
  if (!hasAging && !hasExplainer) return null;

  return (
    <div className="mb-4 space-y-3">
      {hasExplainer && explainer && <DifferenceExplainerPanel explainer={explainer} />}
      {hasAging && aging && <AgingPanel aging={aging} />}
    </div>
  );
}

// ── Difference explainer ─────────────────────────────────────────────────────────
function DifferenceExplainerPanel({ explainer }: { explainer: DifferenceExplainerDto }) {
  const [open, setOpen] = useState(true);
  const ties = explainer.differenceCents === 0;
  const explained = explainer.differenceCents - explainer.residualCents;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-800/30">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Scale size={14} className="text-indigo-400" />
        <span className="text-sm font-medium text-white">What makes up the difference</span>
        <span
          className={clsx(
            'ml-1 font-mono text-sm tabular-nums',
            ties ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {formatMoney(explainer.differenceCents)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-2xs text-slate-500">
          {ties
            ? 'ties to statement'
            : explainer.fullyExplained
              ? 'fully explained by outstanding items'
              : `${formatMoney(explainer.residualCents)} unexplained`}
          <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-4 py-3">
          {/* Waterfall summary */}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="Difference" value={formatMoney(explainer.differenceCents)} tone={ties ? 'good' : 'bad'} />
            <MiniStat
              label="Explained by items"
              value={formatMoney(explained)}
              hint={`${explainer.components.length} lines`}
            />
            <MiniStat label="Outstanding checks" value={formatMoney(-explainer.outstandingChecksCents)} tone="bad" />
            <MiniStat label="Deposits in transit" value={formatMoney(explainer.depositsInTransitCents)} tone="good" />
          </div>

          {explainer.components.length === 0 ? (
            <p className="py-2 text-center text-xs text-slate-500">
              {ties
                ? 'No outstanding items — the book ties to the statement.'
                : 'No outstanding items explain this difference — investigate the residual below.'}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Reconciling item</th>
                    <th className="px-3 py-2 text-right">Age</th>
                    <th className="px-3 py-2 text-right">Effect on difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {explainer.components.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/20">
                      <td className="px-3 py-2 font-mono text-xs text-slate-400">{c.transactionDate}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2 text-slate-200">
                          {c.isOutflow ? (
                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-red-400" />
                          ) : (
                            <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          )}
                          <span className="truncate">{c.description}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-slate-400">{c.ageDays}d</td>
                      <td
                        className={clsx(
                          'px-3 py-2 text-right font-mono tabular-nums',
                          c.reducesDifferenceBy < 0 ? 'text-red-400' : 'text-emerald-400',
                        )}
                      >
                        {formatMoney(c.reducesDifferenceBy)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Residual callout */}
          {ties ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle2 size={13} /> The book ties to the statement — no unexplained difference.
            </p>
          ) : explainer.fullyExplained ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
              <CheckCircle2 size={13} className="text-emerald-400" /> Clearing every outstanding item above resolves the
              difference to $0. Check them off as they appear on the statement.
            </p>
          ) : (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-300/90">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span>
                <span className="font-mono">{formatMoney(explainer.residualCents)}</span> of the difference is not
                explained by any outstanding item. Investigate it — it is never plugged.
              </span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Aging ────────────────────────────────────────────────────────────────────────
function AgingPanel({ aging }: { aging: AgingDto }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-800/30">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Layers size={14} className="text-amber-400" />
        <span className="text-sm font-medium text-white">Outstanding item aging</span>
        <span className="ml-1 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
          {aging.totals.count}
        </span>
        <span className="ml-auto flex items-center gap-2 text-2xs text-slate-500">
          oldest {aging.oldestAgeDays}d · net {formatMoney(aging.totals.netCents)}
          <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-4 py-3">
          {/* Band summary grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {aging.buckets.map((b) => {
              const active = expanded === b.key;
              const clickable = b.count > 0;
              return (
                <button
                  key={b.key}
                  onClick={() => clickable && setExpanded(active ? null : b.key)}
                  disabled={!clickable}
                  aria-expanded={active}
                  className={clsx(
                    'rounded-lg border px-3 py-2.5 text-left transition-colors',
                    b.key === '90_plus' && b.count > 0
                      ? 'border-red-500/30 bg-red-500/[0.05]'
                      : 'border-slate-800 bg-slate-900/40',
                    clickable ? 'cursor-pointer hover:border-slate-600' : 'cursor-default opacity-70',
                    active && 'ring-1 ring-brand-500/40',
                  )}
                >
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">{b.label}</p>
                  <p
                    className={clsx(
                      'mt-1 font-mono text-base tabular-nums',
                      b.netCents < 0 ? 'text-red-400' : b.netCents > 0 ? 'text-emerald-400' : 'text-slate-300',
                    )}
                  >
                    {formatMoney(b.netCents)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-600">
                    {b.count} item{b.count === 1 ? '' : 's'}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Drill-in list for the expanded band */}
          {expanded &&
            (() => {
              const band = aging.buckets.find((b) => b.key === expanded);
              if (!band || band.items.length === 0) return null;
              return (
                <div className="mt-3 overflow-hidden rounded-md border border-slate-800">
                  <div className="border-b border-slate-800 bg-slate-900/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {band.label} — {band.count} outstanding {band.count === 1 ? 'item' : 'items'}, oldest first
                  </div>
                  <ul className="divide-y divide-slate-800/40">
                    {band.items.map((it) => (
                      <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {it.isOutflow ? (
                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-red-400" />
                          ) : (
                            <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          )}
                          <span className="truncate text-xs text-slate-200">{it.description}</span>
                          <span className="font-mono text-2xs text-slate-500">{it.transactionDate}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="rounded bg-slate-700/40 px-1.5 py-0.5 font-mono text-2xs text-slate-400">
                            {it.ageDays}d
                          </span>
                          <span
                            className={clsx(
                              'font-mono text-xs tabular-nums',
                              it.isOutflow ? 'text-red-400' : 'text-emerald-400',
                            )}
                          >
                            {formatMoney(it.amountCents)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

          <p className="mt-3 text-2xs text-slate-600">
            Outstanding = recorded in the book but not yet cleared to the statement as of {aging.asOfDate}. Aged items
            (especially 90+) warrant investigation — a stale outstanding check may be void, an aged deposit may never
            have landed.
          </p>
        </div>
      )}
    </section>
  );
}

function MiniStat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'bad';
}) {
  const cls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-slate-200';
  return (
    <div className="rounded-md bg-slate-900/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 font-mono text-sm tabular-nums', cls)}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-600">{hint}</p>}
    </div>
  );
}
