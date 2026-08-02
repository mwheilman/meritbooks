'use client';

/**
 * 3-WAY MATCH panel — renders a ThreeWayMatchResult as an ordered/received/billed
 * table with per-line variance + flags and an overall PASS/EXCEPTION verdict. Used
 * both in the PO detail drawer and (mountable) on the bill review. Pure presentation.
 */

import { clsx } from 'clsx';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { ThreeWayMatchResult, MatchFlag } from '@/lib/procurement/three-way-match';

const fmt = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2));

const FLAG_LABEL: Record<MatchFlag, string> = {
  OVER_BILL: 'Over-billed',
  OVER_RECEIPT: 'Over-received',
  UNDER_RECEIPT: 'Partial delivery',
  PRICE_VARIANCE: 'Price variance',
  UNMATCHED_BILL_LINE: 'No PO line',
  QTY_NOT_YET_RECEIVED: 'Not yet received',
};

function FlagPill({ flag }: { flag: MatchFlag }) {
  const benign = flag === 'UNDER_RECEIPT';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium',
        benign ? 'bg-slate-800 text-slate-400' : 'bg-red-500/15 text-red-300',
      )}
    >
      {FLAG_LABEL[flag]}
    </span>
  );
}

export function BillMatchPanel({ result }: { result: ThreeWayMatchResult }) {
  const isPass = result.verdict === 'PASS';
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950">
      {/* Verdict banner */}
      <div
        className={clsx(
          'flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800',
          isPass ? 'bg-emerald-500/10' : 'bg-red-500/10',
        )}
      >
        <div className="flex items-center gap-2">
          {isPass ? (
            <CheckCircle2 size={16} className="text-emerald-400" />
          ) : (
            <AlertTriangle size={16} className="text-red-400" />
          )}
          <span className={clsx('text-sm font-semibold', isPass ? 'text-emerald-300' : 'text-red-300')}>
            {isPass ? '3-way match clean' : '3-way match exception'}
          </span>
        </div>
        {!isPass && result.amountAtRiskCents > 0 && (
          <span className="font-mono text-sm text-red-300">{fmt(result.amountAtRiskCents)} at risk</span>
        )}
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-3 divide-x divide-slate-800 border-b border-slate-800 text-center">
        {[
          { label: 'Ordered', v: result.totals.orderedCents },
          { label: 'Received', v: result.totals.receivedCents },
          { label: 'Billed', v: result.totals.billedCents },
        ].map((t) => (
          <div key={t.label} className="px-3 py-2">
            <div className="text-2xs uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className="font-mono text-sm text-slate-200">{fmt(t.v)}</div>
          </div>
        ))}
      </div>

      {/* Per-line table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <th className="text-left font-medium px-3 py-2">Line</th>
              <th className="text-right font-medium px-3 py-2">Ordered</th>
              <th className="text-right font-medium px-3 py-2">Received</th>
              <th className="text-right font-medium px-3 py-2">Billed</th>
              <th className="text-right font-medium px-3 py-2">PO price</th>
              <th className="text-right font-medium px-3 py-2">Bill price</th>
              <th className="text-right font-medium px-3 py-2">Variance</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((l, i) => {
              const exception = l.verdict === 'EXCEPTION';
              return (
                <tr
                  key={l.billLineId ?? l.poLineId ?? i}
                  className={clsx('border-b border-slate-800/60', exception && 'bg-red-500/[0.04]')}
                >
                  <td className="px-3 py-2 text-slate-300 max-w-[180px] truncate">
                    {l.description ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{fmtQty(l.orderedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{fmtQty(l.receivedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-200">{fmtQty(l.billedQty)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{fmt(l.poUnitCostCents)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-200">{fmt(l.billUnitCostCents)}</td>
                  <td
                    className={clsx(
                      'px-3 py-2 text-right font-mono',
                      l.priceVarianceCents > 0 ? 'text-red-300' : l.priceVarianceCents < 0 ? 'text-emerald-300' : 'text-slate-500',
                    )}
                  >
                    {l.priceVarianceCents === 0 ? '—' : fmt(l.priceVarianceCents)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {l.flags.length === 0 ? (
                        <span className="text-2xs text-emerald-400">OK</span>
                      ) : (
                        l.flags.map((f) => <FlagPill key={f} flag={f} />)
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Reasons */}
      {result.reasons.length > 0 && (
        <ul className="px-4 py-3 space-y-1 text-2xs text-red-300/90 list-disc list-inside">
          {result.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
