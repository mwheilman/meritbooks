'use client';

import { useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Loader2, AlertCircle, Download, FileText, Landmark, ArrowUpRight, ArrowDownRight, Info, Scale, Calculator,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { EmptyState } from '@/components/ui';
import type { TaxReturnPackage } from '@/lib/tax/return-package';

interface LocationOption { id: string; name: string }

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const signed = (cents: number) => `${cents < 0 ? '−' : ''}${fmt(Math.abs(cents))}`;

export function TaxPackageClient() {
  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(`${now.getFullYear()}-12-31`);
  const [rate, setRate] = useState('21');
  const [locationId, setLocationId] = useState<string>('all');
  const [downloading, setDownloading] = useState(false);

  const { data: locations } = useQuery<LocationOption[]>('/api/locations');
  const entityLabel = useMemo(() => {
    if (locationId === 'all') return 'All Companies (Consolidated)';
    return (locations ?? []).find((l) => l.id === locationId)?.name ?? 'Company';
  }, [locationId, locations]);

  const params = useMemo(
    () => ({ start_date: startDate, end_date: endDate, statutory_rate: rate, location_id: locationId, entity_label: entityLabel }),
    [startDate, endDate, rate, locationId, entityLabel],
  );
  const { data, isLoading, error, refetch } = useQuery<{ data: TaxReturnPackage }>('/api/tax/return-package', params);
  const pkg = data?.data;

  const downloadPdf = useCallback(async () => {
    if (!pkg || downloading) return;
    setDownloading(true);
    try {
      const resp = await fetch('/api/tax/return-package/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pkg),
      });
      if (!resp.ok) {
        let msg = 'PDF export failed.';
        try { const j = await resp.json(); msg = j.error ?? msg; } catch { /* binary body */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tax-return-package_${pkg.meta.taxYear}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('success', 'Tax return package PDF exported.');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setDownloading(false);
    }
  }, [pkg, downloading]);

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-slate-400">Period start</label>
          <input type="date" className="input mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Period end</label>
          <input type="date" className="input mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Statutory rate %</label>
          <input type="number" step="0.001" min="0" max="100" className="input mt-1 w-28 font-mono" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Company / entity</label>
          <select className="input mt-1 max-w-xs" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="all">All (consolidated preview)</option>
            {(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="ml-auto">
          <button
            onClick={downloadPdf}
            disabled={!pkg || downloading || isLoading}
            className="btn btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {downloading ? 'Building PDF…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
          <button onClick={refetch} className="ml-2 text-xs text-emerald-400 hover:text-emerald-300 underline">Try again</button>
        </div>
      )}

      {!isLoading && !error && !pkg && (
        <EmptyState icon={Landmark} title="No data" description="Choose a period, rate, and entity to assemble the tax return package." />
      )}

      {!isLoading && !error && pkg && <PackageBody pkg={pkg} entityLabel={entityLabel} />}
    </div>
  );
}

function PackageBody({ pkg, entityLabel }: { pkg: TaxReturnPackage; entityLabel: string }) {
  return (
    <div className="space-y-5">
      {/* Cover strip */}
      <div className="card p-5 border-l-4 border-l-emerald-500">
        <p className="text-[10px] uppercase tracking-widest text-slate-500">Confidential · Prepared for Tax Filing</p>
        <h2 className="text-xl font-semibold text-white mt-1">{entityLabel}</h2>
        <p className="text-sm text-emerald-400 font-medium">Corporate Tax Return Package · Form 1120 ({pkg.meta.taxYear})</p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-slate-400">
          <span>Tax period: <span className="text-slate-200 font-mono">{pkg.meta.periodLabel}</span></span>
          <span>Statutory rate: <span className="text-slate-200 font-mono">{pkg.meta.statutoryRatePct}%</span></span>
          <span>{pkg.meta.basisLabel}</span>
        </div>
      </div>

      {/* Preparer notes */}
      {pkg.preparerNotes.length > 0 && (
        <div className="card p-4 border-blue-500/30">
          <div className="flex items-center gap-2 mb-2"><Info size={14} className="text-blue-400" /><p className="text-sm font-semibold text-white">Preparer notes</p></div>
          <ul className="space-y-1.5">
            {pkg.preparerNotes.map((n, i) => (
              <li key={i} className="text-xs text-slate-300 flex gap-2"><span className="text-blue-400 shrink-0">•</span>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Pretax book income" valueCents={pkg.summary.pretaxBookIncomeCents} />
        <Kpi label="Taxable income" valueCents={pkg.summary.taxableIncomeCents} />
        <Kpi label="Current tax" valueCents={pkg.summary.currentTaxCents} />
        <Kpi label="Deferred tax" valueCents={pkg.summary.deferredTaxCents} />
        <Kpi label="Total provision" valueCents={pkg.summary.totalProvisionCents} emphasize />
        <Kpi label="Effective rate" rawText={`${pkg.summary.effectiveRatePct.toFixed(2)}%`} />
      </div>

      {/* Waterfall */}
      <section className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-white">Book income → taxable income → provision</h2>
          <p className="text-2xs text-slate-500 mt-0.5">Net income per books, adjusted by Schedule M-1 differences, to taxable income and the ASC 740 provision.</p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {pkg.waterfall.map((w) => (
              <tr key={w.key} className={clsx(w.kind === 'subtotal' && 'border-t border-slate-700 bg-slate-900/40')}>
                <td className={clsx('px-4 py-2.5', w.kind === 'subtotal' ? 'font-semibold text-white' : 'text-slate-300')}>{w.label}</td>
                <td className={clsx('px-4 py-2.5 text-right font-mono', w.kind === 'subtotal' ? 'font-semibold text-emerald-300' : w.kind === 'add' ? 'text-emerald-400' : w.kind === 'subtract' ? 'text-red-400' : 'text-slate-200')}>
                  {signed(w.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Schedule M-1 */}
      <section className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Schedule M-1 — book-to-tax reconciliation</h2>
            <p className="text-2xs text-slate-500 mt-0.5">{pkg.m1.adjustmentCount} adjustment line{pkg.m1.adjustmentCount === 1 ? '' : 's'} · P = permanent, T = temporary.</p>
          </div>
          <Link href="/book-to-tax" className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"><Scale size={13} /> Tag differences</Link>
        </div>
        <table className="w-full text-sm">
          <tbody>
            <MRow label="Net income per books (pretax)" cents={pkg.m1.bookNetIncomeCents} bold />
            <tr><td colSpan={2} className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-slate-500">Additions (increase taxable income)</td></tr>
            {pkg.m1.additions.length === 0
              ? <tr><td colSpan={2} className="px-4 py-2 text-xs text-slate-500">None tagged.</td></tr>
              : pkg.m1.additions.map((l) => <MLineRow key={l.code} line={l} />)}
            <MRow label="Total additions" cents={pkg.m1.totalAdditionsCents} subtotal />
            <tr><td colSpan={2} className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-slate-500">Subtractions (decrease taxable income)</td></tr>
            {pkg.m1.subtractions.length === 0
              ? <tr><td colSpan={2} className="px-4 py-2 text-xs text-slate-500">None tagged.</td></tr>
              : pkg.m1.subtractions.map((l) => <MLineRow key={l.code} line={l} />)}
            <MRow label="Total subtractions" cents={pkg.m1.totalSubtractionsCents} subtotal />
            <tr className="border-t-2 border-slate-700 bg-slate-900/40">
              <td className="px-4 py-3 font-semibold text-white">Taxable income</td>
              <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-300">{signed(pkg.m1.taxableIncomeCents)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Tax vs book depreciation */}
      <section className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Tax vs. book depreciation — {pkg.depreciation.taxYear}</h2>
            <p className="text-2xs text-slate-500 mt-0.5">Posted book depreciation vs. the MACRS/§179/bonus tax schedule. The net delta is a temporary M-1 difference.</p>
          </div>
          <Link href="/tax-depreciation" className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"><Calculator size={13} /> Detail</Link>
        </div>
        {pkg.depreciation.assets.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">No depreciable fixed assets for this tax year.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Asset</th>
                <th className="text-left font-medium px-4 py-2.5">Method</th>
                <th className="text-right font-medium px-4 py-2.5">Tax</th>
                <th className="text-right font-medium px-4 py-2.5">Book</th>
                <th className="text-right font-medium px-4 py-2.5">Difference</th>
              </tr>
            </thead>
            <tbody>
              {pkg.depreciation.assets.map((a) => (
                <tr key={a.assetId} className="border-b border-slate-800/40 last:border-0">
                  <td className="px-4 py-2 text-slate-200">{a.name}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{a.taxMethod}{a.recoveryYears ? ` · ${a.recoveryYears}yr` : ''}</td>
                  <td className="px-4 py-2 text-right font-mono text-white">{fmt(a.taxYearCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-300">{fmt(a.bookYearCents)}</td>
                  <td className={clsx('px-4 py-2 text-right font-mono', a.differenceCents === 0 ? 'text-slate-500' : a.differenceCents > 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {a.differenceCents === 0 ? '—' : `${a.differenceCents > 0 ? '+' : '−'}${fmt(Math.abs(a.differenceCents))}`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 bg-slate-900/40">
                <td className="px-4 py-2.5 font-semibold text-white" colSpan={2}>Totals</td>
                <td className="px-4 py-2.5 text-right font-mono text-white">{fmt(pkg.depreciation.totalTaxCents)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-slate-300">{fmt(pkg.depreciation.totalBookCents)}</td>
                <td className={clsx('px-4 py-2.5 text-right font-mono font-semibold', pkg.depreciation.netDifferenceCents >= 0 ? 'text-emerald-300' : 'text-red-300')}>
                  {signed(pkg.depreciation.netDifferenceCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Effective-rate reconciliation */}
        <section className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-white">Effective-rate reconciliation</h2>
            <p className="text-2xs text-slate-500 mt-0.5">Only permanent differences move the rate away from statutory.</p>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {pkg.effectiveRate.map((row, i) => (
                <tr key={i} className={clsx('border-b border-slate-800/40 last:border-0', i === pkg.effectiveRate.length - 1 && 'border-t-2 border-slate-700 bg-slate-900/40')}>
                  <td className={clsx('px-4 py-2.5', i === pkg.effectiveRate.length - 1 ? 'font-semibold text-white' : 'text-slate-300')}>{row.label}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-200">{signed(row.amountCents)}</td>
                  <td className={clsx('px-4 py-2.5 text-right font-mono', i === pkg.effectiveRate.length - 1 ? 'text-emerald-300' : 'text-slate-400')}>{row.ratePct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* DTA/DTL rollforward */}
        <section className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-white">Deferred tax rollforward — DTA / DTL</h2>
            <p className="text-2xs text-slate-500 mt-0.5">
              {pkg.deferred.rollforward.hasPriorHistory ? 'Beginning balances from prior filed provisions.' : 'No prior provisions on file — beginning balances are zero.'}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Deferred balance</th>
                <th className="text-right font-medium px-4 py-2.5">DTA</th>
                <th className="text-right font-medium px-4 py-2.5">DTL</th>
              </tr>
            </thead>
            <tbody>
              <RollRow label="Beginning balance" dta={pkg.deferred.rollforward.beginningDtaCents} dtl={pkg.deferred.rollforward.beginningDtlCents} />
              <RollRow label="Change this period" dta={pkg.deferred.rollforward.dtaChangeCents} dtl={pkg.deferred.rollforward.dtlChangeCents} />
              <tr className="border-t border-slate-700 bg-slate-900/40">
                <td className="px-4 py-2.5 font-semibold text-white">Ending balance</td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-300">{fmt(pkg.deferred.rollforward.endingDtaCents)}</td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold text-red-300">{fmt(pkg.deferred.rollforward.endingDtlCents)}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-xs text-slate-400">Net deferred tax asset (liability)</td>
                <td colSpan={2} className={clsx('px-4 py-2 text-right font-mono', pkg.deferred.rollforward.endingNetDtaCents >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {signed(pkg.deferred.rollforward.endingNetDtaCents)}
                </td>
              </tr>
            </tbody>
          </table>
          {pkg.deferred.items.length > 0 && (
            <div className="border-t border-slate-800">
              <p className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-slate-500">Temporary difference detail</p>
              <table className="w-full text-sm">
                <tbody>
                  {pkg.deferred.items.map((it) => (
                    <tr key={it.code} className="border-b border-slate-800/40 last:border-0">
                      <td className="px-4 py-2 text-slate-300">
                        {it.category === 'DTA' ? <ArrowUpRight size={12} className="inline text-emerald-400/70 mr-1" /> : <ArrowDownRight size={12} className="inline text-red-400/70 mr-1" />}
                        {it.label || it.code} <span className="text-2xs text-slate-600">({it.category})</span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-300">{signed(it.temporaryDiffCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-200">{fmt(it.deferredTaxCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <FileText size={12} /> Download the PDF for the full 1120-style package to hand to your preparer.
      </div>
    </div>
  );
}

function Kpi(props: { label: string; valueCents?: number; rawText?: string; emphasize?: boolean }) {
  const { label, valueCents, rawText, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg', emphasize ? 'text-emerald-300' : 'text-white')}>
        {rawText ?? (valueCents !== undefined ? signed(valueCents) : '—')}
      </p>
    </div>
  );
}

function MRow(props: { label: string; cents: number; bold?: boolean; subtotal?: boolean }) {
  return (
    <tr className={clsx(props.subtotal && 'border-t border-slate-800')}>
      <td className={clsx('px-4 py-2', props.bold || props.subtotal ? 'font-medium text-white' : 'text-slate-300')}>{props.label}</td>
      <td className={clsx('px-4 py-2 text-right font-mono', props.bold || props.subtotal ? 'font-medium text-white' : 'text-slate-200')}>{signed(props.cents)}</td>
    </tr>
  );
}

function MLineRow({ line }: { line: TaxReturnPackage['m1']['additions'][number] }) {
  return (
    <tr className="border-b border-slate-800/30 last:border-0">
      <td className="px-4 py-1.5 pl-8 text-slate-300">
        {line.label}
        <span className="ml-2 text-2xs text-slate-600">
          {line.m1Line ? `line ${line.m1Line}` : ''}{line.codeSection ? ` · ${line.codeSection}` : ''}
        </span>
        <span className={clsx('ml-2 text-2xs px-1 rounded', line.differenceType === 'PERMANENT' ? 'bg-slate-800 text-slate-400' : 'bg-indigo-500/10 text-indigo-300')}>
          {line.differenceType === 'PERMANENT' ? 'P' : 'T'}
        </span>
      </td>
      <td className="px-4 py-1.5 text-right font-mono text-slate-200">{fmt(line.amountCents)}</td>
    </tr>
  );
}

function RollRow(props: { label: string; dta: number; dtl: number }) {
  return (
    <tr className="border-b border-slate-800/40">
      <td className="px-4 py-2 text-slate-300">{props.label}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-200">{fmt(props.dta)}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-200">{fmt(props.dtl)}</td>
    </tr>
  );
}
