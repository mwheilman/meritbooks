'use client';

/**
 * Dealer reports (FPB-dealer-pack §7, R1–R8) for the active client: report picker
 * (URL ?report=), period or as-of selector, the ledger table with drill links,
 * and XLSX / CSV / PDF export of exactly what is on screen.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';
import { BarChart3, FileText, RefreshCw } from 'lucide-react';
import { DEALER_REPORTS, dealerReportDef, isDealerReportKey, type DealerReport, type DealerReportKey } from '@/lib/dealer/reports/catalog';
import type { StatementModel } from '@/lib/reports/export/statement-model';
import { useDealerQuery } from '../_lib/use-dealer';
import { useDealerPack } from '../_components/dealer-shell';
import { Empty, ErrorPanel, Notice, Spinner } from '../_components/ui';
import { DateInput } from '../_components/forms';
import { DealerReportTable } from './_components/report-table';
import { DealerExportMenu } from './_components/export-buttons';
import { PERIOD_OPTIONS, isIsoDate, localToday, presetRange, type PeriodKey } from './_lib/period';

interface Payload {
  report: DealerReport;
  model: StatementModel;
}

export function DealerReportsClient() {
  const router = useRouter();
  const pathname = usePathname() ?? '/dealer/reports';
  const sp = useSearchParams();
  const fromUrl = sp?.get('report') ?? null;
  const reportKey: DealerReportKey = isDealerReportKey(fromUrl) ? fromUrl : 'dealer_fp_position';
  const def = dealerReportDef(reportKey);
  const { enabled, isLoading: packLoading, clientName } = useDealerPack();

  const today = localToday();
  const [periodKey, setPeriodKey] = useState<PeriodKey>('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [asOf, setAsOf] = useState(today);

  const range = useMemo(() => (periodKey === 'custom' ? { start: customStart, end: customEnd } : presetRange(periodKey)), [periodKey, customStart, customEnd]);
  const rangeError =
    def.mode === 'period' && periodKey === 'custom'
      ? !isIsoDate(customStart) || !isIsoDate(customEnd)
        ? 'Pick a start and end date.'
        : customStart > customEnd
          ? 'The start date must be on or before the end date.'
          : null
      : null;
  const asOfError = def.mode === 'asOf' && !isIsoDate(asOf) ? 'Pick an as-of date.' : null;
  const ready = !rangeError && !asOfError;

  const params = def.mode === 'asOf' ? { report: reportKey, asOf } : { report: reportKey, start: range.start, end: range.end };
  const q = useDealerQuery<Payload>(ready ? '/api/dealer/reports' : null, params);

  const pick = (k: DealerReportKey) => {
    const next = new URLSearchParams(sp?.toString() ?? '');
    next.set('report', k);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const report = q.data?.report ?? null;
  const hasRows = !!report && report.rows.some((r) => r.kind === 'account' || r.kind === 'subtotal' || r.kind === 'total');

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Dealer reports" className="card h-fit p-2">
        <ul className="space-y-0.5">
          {DEALER_REPORTS.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => pick(r.key)}
                aria-current={r.key === reportKey ? 'page' : undefined}
                className={clsx(
                  'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500',
                  r.key === reportKey ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200',
                )}
              >
                {r.label}
                <span className="mt-0.5 block text-2xs text-slate-500">{r.mode === 'asOf' ? 'Point in time' : 'For a period'}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="card min-w-0 overflow-hidden" aria-labelledby="dealer-report-title">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <h1 id="dealer-report-title" className="text-heading text-white">{def.label}</h1>
            <p className="mt-0.5 text-xs text-slate-400">{def.desc}</p>
            {report && (
              <p className="mt-1 text-xs text-slate-500">
                {report.entityLabel} · {report.periodLabel}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void q.refetch()} disabled={!ready || q.isLoading} className="btn-secondary btn-sm inline-flex items-center gap-1.5 disabled:opacity-40" aria-label="Refresh report">
              <RefreshCw size={13} className={q.isLoading ? 'animate-spin' : undefined} /> Refresh
            </button>
            <DealerExportMenu model={q.data?.model ?? null} disabled={!hasRows || q.isLoading} />
          </div>
        </header>

        <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 bg-slate-800/10 px-5 py-3">
          {def.mode === 'period' ? (
            <>
              <label className="flex flex-col gap-1 text-2xs uppercase tracking-caps text-slate-500">
                Period
                <select
                  value={periodKey}
                  onChange={(e) => setPeriodKey(e.target.value as PeriodKey)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs normal-case tracking-normal text-white"
                >
                  {PERIOD_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {periodKey === 'custom' ? (
                <>
                  <label className="flex flex-col gap-1 text-2xs uppercase tracking-caps text-slate-500">
                    From
                    <DateInput value={customStart} onChange={setCustomStart} invalid={!!rangeError && !isIsoDate(customStart)} aria-label="Start date" />
                  </label>
                  <label className="flex flex-col gap-1 text-2xs uppercase tracking-caps text-slate-500">
                    To
                    <DateInput value={customEnd} onChange={setCustomEnd} invalid={!!rangeError} aria-label="End date" />
                  </label>
                </>
              ) : (
                <span className="pb-1.5 font-mono text-xs text-slate-400">
                  {range.start} → {range.end}
                </span>
              )}
              {rangeError && <span className="pb-1.5 text-xs text-amber-300" role="alert">{rangeError}</span>}
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-2xs uppercase tracking-caps text-slate-500">
                As of
                <DateInput value={asOf} onChange={setAsOf} invalid={!!asOfError} max={today} aria-label="As-of date" />
              </label>
              <button type="button" className="btn-ghost btn-sm mb-0.5 text-xs" onClick={() => setAsOf(today)} disabled={asOf === today}>
                Today
              </button>
              {asOfError && <span className="pb-1.5 text-xs text-amber-300" role="alert">{asOfError}</span>}
            </>
          )}
        </div>

        {!packLoading && !enabled && (
          <div className="px-5 pt-4">
            <Notice tone="info">
              The dealer pack is off for {clientName ?? 'this client'}, so these reports show only what has been set up or imported so far.
            </Notice>
          </div>
        )}

        {!ready ? (
          <Empty icon={FileText} title="Choose the dates" description="Pick the dates for this report to run it." />
        ) : q.isLoading && !q.data ? (
          <Spinner label="Running the report…" />
        ) : q.error ? (
          <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
        ) : !report || !hasRows ? (
          <Empty
            icon={BarChart3}
            title="Nothing to report for these dates"
            description={
              <>
                {def.mode === 'period' ? 'No dealer activity was posted in this period.' : 'Nothing is open as of this date.'} Try another {def.mode === 'period' ? 'period' : 'date'}, or{' '}
                <Link href="/dealer" className="text-emerald-400 hover:text-emerald-300">
                  go to the dealer home
                </Link>
                .
              </>
            }
          />
        ) : (
          <div className={clsx(q.isLoading && 'opacity-60 transition-opacity')} aria-busy={q.isLoading}>
            <DealerReportTable report={report} />
          </div>
        )}
      </section>
    </div>
  );
}
