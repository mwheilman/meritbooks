'use client';

/**
 * Renders a DealerReport in the ledger pattern: money mono + right-aligned,
 * sections / subtotals / totals, a drill link on every row that has one (unit,
 * note, claim, statement, deal) and the journal entry where there is exactly one.
 * Notes and KPIs render under the table. Presentation only — never changes a value.
 */

import Link from 'next/link';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { LEDGER_SUBTOTAL, LEDGER_TH, LEDGER_TOTAL, figColor } from '@/lib/reports/ledger';
import type { DealerCell, DealerReport, DealerReportColumn, DealerReportRow } from '@/lib/dealer/reports/catalog';
import { dateLabel } from '@/lib/dealer/ui/format';

function fmtCell(col: DealerReportColumn, v: DealerCell): string {
  if (v === null || v === undefined || v === '') return '';
  switch (col.kind) {
    case 'money':
      return typeof v === 'number' ? formatMoney(v) : String(v);
    case 'percent':
      return typeof v === 'number' ? `${(v / 100).toFixed(1)}%` : String(v);
    case 'count':
    case 'days':
      return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    case 'date':
      return typeof v === 'string' ? dateLabel(v) : String(v);
    default:
      return String(v);
  }
}

const NUMERIC = new Set(['money', 'percent', 'count', 'days']);

function LabelCell({ r }: { r: DealerReportRow }) {
  const pad = { paddingLeft: `${1 + (r.indent ?? 0) * 1}rem` };
  const text = (
    <>
      {r.code && <span className="mr-2 font-mono text-2xs text-slate-500">{r.code}</span>}
      {r.label}
    </>
  );
  return (
    <td style={pad} className="py-1.5 pr-3 text-left align-top">
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        {r.href ? (
          <Link href={r.href} className="rounded text-slate-100 underline-offset-2 hover:text-emerald-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500">
            {text}
          </Link>
        ) : (
          <span>{text}</span>
        )}
        {r.jeHref && (
          <Link href={r.jeHref} className="text-2xs font-medium text-slate-500 hover:text-emerald-300" title="Open the journal entry">
            JE →
          </Link>
        )}
      </span>
    </td>
  );
}

export function DealerReportTable({ report }: { report: DealerReport }) {
  const cols = report.columns;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <caption className="sr-only">
            {report.title} — {report.entityLabel}, {report.periodLabel}
          </caption>
          <thead>
            <tr className="border-b border-slate-800">
              <th scope="col" className={clsx('px-4 py-2.5 text-left text-2xs uppercase text-slate-500', LEDGER_TH)}>
                &nbsp;
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={clsx('whitespace-nowrap px-3 py-2.5 text-2xs uppercase text-slate-500', LEDGER_TH, NUMERIC.has(c.kind) ? 'text-right' : 'text-left')}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r, i) => {
              if (r.kind === 'spacer') {
                return (
                  <tr key={i} aria-hidden>
                    <td colSpan={cols.length + 1} className="h-3" />
                  </tr>
                );
              }
              const isSection = r.kind === 'section';
              const isSub = r.kind === 'subtotal';
              const isTotal = r.kind === 'total';
              const isNote = r.kind === 'note';
              return (
                <tr
                  key={i}
                  className={clsx(
                    isSection && 'text-xs font-semibold uppercase tracking-wide text-slate-400',
                    !isSection && !isSub && !isTotal && 'border-b border-slate-800/40 text-slate-300 hover:bg-slate-800/20',
                    isSub && clsx(LEDGER_SUBTOTAL, 'font-medium text-slate-100'),
                    isTotal && 'font-semibold text-white',
                    isNote && 'italic text-slate-400',
                    r.tone === 'warning' && 'text-amber-200',
                    r.tone === 'danger' && 'text-red-300',
                  )}
                >
                  <LabelCell r={r} />
                  {cols.map((c, ci) => {
                    const v = r.values[ci] ?? null;
                    const money = c.kind === 'money' && typeof v === 'number';
                    return (
                      <td
                        key={c.key}
                        className={clsx(
                          'whitespace-nowrap px-3 py-1.5 align-top',
                          NUMERIC.has(c.kind) ? 'text-right font-mono tabular-nums' : 'text-left',
                          money && figColor(v, isTotal ? 'text-white' : isSub ? 'text-slate-100' : 'text-slate-200'),
                          isTotal && LEDGER_TOTAL,
                        )}
                      >
                        {fmtCell(c, v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(report.kpis.length > 0 || report.notes.length > 0) && (
        <div className="border-t border-slate-800 px-5 py-4">
          {report.kpis.length > 0 && (
            <dl className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
              {report.kpis.map((k) => (
                <div key={k.label}>
                  <dt className="text-2xs uppercase tracking-caps text-slate-500">{k.label}</dt>
                  <dd className="font-mono text-lg tabular-nums text-white">{k.value}</dd>
                  {k.hint && <dd className="text-xs text-slate-500">{k.hint}</dd>}
                </div>
              ))}
            </dl>
          )}
          <ul className="space-y-1 text-xs text-slate-500">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
