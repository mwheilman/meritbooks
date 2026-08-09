'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Loader2, AlertCircle, Calculator, Scale, Info, ChevronRight, Sparkles, Check, ArrowUpRight, ArrowDownRight, CheckCircle2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

// ── Types mirrored from /api/tax/depreciation ────────────────────────────────
interface ScheduleYear {
  ordinal: number;
  year: number;
  section179Cents: number;
  bonusCents: number;
  regularCents: number;
  totalCents: number;
  accumulatedCents: number;
}
interface AssetLine {
  assetId: string;
  name: string;
  category: string | null;
  acquisitionDate: string;
  costCents: number;
  taxMethod: string;
  recoveryYears: number | null;
  convention: string;
  section179Cents: number;
  bonusPct: number;
  schedule: ScheduleYear[];
  bookYearCents: number;
  taxYearCents: number;
  differenceCents: number;
}
interface DepreciationDifference {
  code: 'BOOK_DEPR_EXCESS' | 'TAX_DEPR_EXCESS';
  taxableEffect: 'ADD' | 'SUBTRACT';
  differenceType: 'TEMPORARY';
  amountCents: number;
}
interface Payload {
  taxYear: number;
  assets: AssetLine[];
  totalBookCents: number;
  totalTaxCents: number;
  netDifferenceCents: number;
  difference: DepreciationDifference | null;
  openProposal: { id: string; code: string | null; amountCents: number; targetLineFound: boolean } | null;
  overrideExists: boolean;
}

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const METHOD_LABEL: Record<string, string> = {
  NONE: 'Tax = Book',
  SL: 'Straight-line',
  MACRS: 'MACRS (GDS)',
  SECTION_179: 'MACRS + §179',
  BONUS: 'MACRS + Bonus',
};

export default function TaxDepreciationPage() {
  const nowYear = new Date().getFullYear();
  const [taxYear, setTaxYear] = useState(nowYear);
  const params = useMemo(() => ({ tax_year: String(taxYear) }), [taxYear]);
  const { data, isLoading, error, refetch } = useQuery<Payload>('/api/tax/depreciation', params);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const propose = async () => {
    setBusy(true);
    const res = await api.post<{ proposed: boolean; targetLineFound: boolean }>('/api/tax/depreciation', { action: 'propose', tax_year: taxYear });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    if (!res.data?.proposed) { addToast('success', 'Book and tax depreciation agree — no M-1 difference to propose'); refetch(); return; }
    addToast('success', res.data?.targetLineFound ? 'Depreciation difference proposed to the M-1 — confirm to feed it' : 'Proposed, but no posted book depreciation line was found to anchor it');
    refetch();
  };
  const confirm = async (decisionId: string) => {
    setBusy(true);
    const res = await api.post('/api/tax/depreciation', { action: 'confirm', decision_id: decisionId });
    setBusy(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Confirmed — the temporary difference now feeds Schedule M-1');
    refetch();
  };

  const years = useMemo(() => Array.from({ length: 8 }, (_, i) => nowYear - i), [nowYear]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Tax Depreciation (MACRS)"
        description="The parallel tax book — MACRS / §179 / bonus by class — and its reconciliation to posted book depreciation. The book-vs-tax delta is proposed as a temporary Schedule M-1 difference the ledger only records once you confirm it."
      />

      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <label className="text-xs text-slate-400">Tax year</label>
          <select className="input mt-1 w-32" value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <Link href="/book-to-tax" className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1">
          <Scale size={13} /> View Schedule M-1
        </Link>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>
      )}

      {!isLoading && !error && data && (
        (data.assets?.length ?? 0) === 0 ? (
          <EmptyState icon={Calculator} title="No fixed assets" description="Add depreciable assets on the Fixed Assets page to compute a MACRS tax schedule and the book-vs-tax reconciliation." />
        ) : (
          <div className="space-y-5">
            {/* Book-vs-tax reconciliation */}
            <ReconCard data={data} busy={busy} onPropose={propose} onConfirm={confirm} />

            {/* Per-asset MACRS schedules */}
            <section className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Per-asset tax depreciation schedule</h2>
                <p className="text-2xs text-slate-500 mt-0.5">MACRS GDS with the published half-year / mid-quarter conventions; §179 and bonus are year-1 special allowances. Tax depreciation never posts to the book GL.</p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">Asset</th>
                    <th className="text-left font-medium px-4 py-2.5">Method</th>
                    <th className="text-right font-medium px-4 py-2.5">Cost</th>
                    <th className="text-right font-medium px-4 py-2.5">Tax {data.taxYear}</th>
                    <th className="text-right font-medium px-4 py-2.5">Book {data.taxYear}</th>
                    <th className="text-right font-medium px-4 py-2.5">Difference</th>
                    <th className="px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(data.assets ?? []).map((a) => (
                    <AssetRows key={a.assetId} asset={a} taxYear={data.taxYear} expanded={expanded === a.assetId} onToggle={() => setExpanded(expanded === a.assetId ? null : a.assetId)} />
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )
      )}
    </div>
  );
}

function ReconCard(props: { data: Payload; busy: boolean; onPropose: () => void; onConfirm: (id: string) => void }) {
  const { data, busy, onPropose, onConfirm } = props;
  const diff = data.difference;
  const isAdd = diff?.taxableEffect === 'ADD';

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">Book-vs-tax reconciliation — {data.taxYear}</h2>
          <p className="text-2xs text-slate-500 mt-0.5">Posted book depreciation vs the deterministic MACRS tax schedule. The net delta is a temporary difference for Schedule M-1.</p>
        </div>
        <Calculator size={16} className="text-slate-600" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3 p-4">
        <Stat label="Book depreciation" valueCents={data.totalBookCents} />
        <Stat label="Tax depreciation" valueCents={data.totalTaxCents} />
        <Stat label="Net difference (book − tax)" valueCents={data.netDifferenceCents} tone={data.netDifferenceCents >= 0 ? 'add' : 'sub'} emphasize />
      </div>

      <div className="px-4 pb-4">
        {!diff ? (
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-2 text-sm text-slate-300">
            <Info size={15} className="text-blue-400 mt-0.5 shrink-0" />
            Book and tax depreciation agree for {data.taxYear} — no M-1 depreciation difference this year.
          </div>
        ) : data.overrideExists ? (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-start gap-2 text-sm text-slate-300">
            <CheckCircle2 size={15} className="text-emerald-400 mt-0.5 shrink-0" />
            <div>
              A <span className="font-medium text-white">{isAdd ? 'BOOK_DEPR_EXCESS' : 'TAX_DEPR_EXCESS'}</span> temporary difference of {fmt(diff.amountCents)} is feeding Schedule M-1 (line {isAdd ? '5a' : '8a'}).{' '}
              <Link href="/book-to-tax" className="text-emerald-400 hover:text-emerald-300">View the reconciliation →</Link>
            </div>
          </div>
        ) : data.openProposal ? (
          <div className="rounded border border-indigo-500/30 bg-indigo-500/5 p-3 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 text-sm text-slate-300">
              <Sparkles size={15} className="text-indigo-400 mt-0.5 shrink-0" />
              <div>
                Proposed: <span className="font-medium text-white">{isAdd ? 'Book depreciation over tax' : 'Tax depreciation over book (§179/bonus)'}</span> — a {diff.differenceType.toLowerCase()} {isAdd ? 'addition' : 'subtraction'} of {fmt(diff.amountCents)} on M-1 line {isAdd ? '5a' : '8a'}.
                {!data.openProposal.targetLineFound && (
                  <span className="block text-2xs text-amber-400 mt-1">No posted book depreciation line was found in {data.taxYear} to anchor the M-1 override — post book depreciation first.</span>
                )}
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm shrink-0"
              disabled={busy || !data.openProposal.targetLineFound}
              onClick={() => data.openProposal && onConfirm(data.openProposal.id)}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirm to M-1
            </button>
          </div>
        ) : (
          <div className="rounded border border-slate-700 bg-slate-900/40 p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-300">
              {isAdd ? <ArrowUpRight size={15} className="text-emerald-400" /> : <ArrowDownRight size={15} className="text-red-400" />}
              A {fmt(diff.amountCents)} temporary {isAdd ? 'addition (book > tax)' : 'subtraction (tax > book)'} is ready to propose to Schedule M-1.
            </div>
            <button className="btn btn-primary btn-sm shrink-0" disabled={busy} onClick={onPropose}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Propose to M-1
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Stat(props: { label: string; valueCents: number; tone?: 'add' | 'sub'; emphasize?: boolean }) {
  const { label, valueCents, tone, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg', emphasize ? (valueCents >= 0 ? 'text-emerald-300' : 'text-red-300') : 'text-white')}>
        {tone === 'sub' || valueCents < 0 ? '−' : tone === 'add' ? '+' : ''}{fmt(Math.abs(valueCents))}
      </p>
    </div>
  );
}

function AssetRows(props: { asset: AssetLine; taxYear: number; expanded: boolean; onToggle: () => void }) {
  const { asset, taxYear, expanded, onToggle } = props;
  const hasSchedule = asset.schedule.length > 0;
  return (
    <>
      <tr className="border-b border-slate-800/60 last:border-0 hover:bg-slate-900/30 cursor-pointer" onClick={hasSchedule ? onToggle : undefined}>
        <td className="px-4 py-2.5">
          <div className="text-slate-200">{asset.name}</div>
          <div className="text-2xs text-slate-600">{asset.category ?? '—'} · placed {asset.acquisitionDate}</div>
        </td>
        <td className="px-4 py-2.5">
          <span className="text-slate-300 text-xs">{METHOD_LABEL[asset.taxMethod] ?? asset.taxMethod}</span>
          {asset.recoveryYears && <span className="ml-1 text-2xs text-slate-600">{asset.recoveryYears}-yr · {asset.convention === 'MID_QUARTER' ? 'MQ' : 'HY'}</span>}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-slate-300">{fmt(asset.costCents)}</td>
        <td className="px-4 py-2.5 text-right font-mono text-white">{fmt(asset.taxYearCents)}</td>
        <td className="px-4 py-2.5 text-right font-mono text-slate-300">{fmt(asset.bookYearCents)}</td>
        <td className={clsx('px-4 py-2.5 text-right font-mono', asset.differenceCents === 0 ? 'text-slate-500' : asset.differenceCents > 0 ? 'text-emerald-400' : 'text-red-400')}>
          {asset.differenceCents === 0 ? '—' : `${asset.differenceCents > 0 ? '+' : '−'}${fmt(Math.abs(asset.differenceCents))}`}
        </td>
        <td className="px-2">
          {hasSchedule && <ChevronRight size={14} className={clsx('text-slate-600 transition-transform', expanded && 'rotate-90')} />}
        </td>
      </tr>
      {expanded && hasSchedule && (
        <tr className="bg-slate-950/40">
          <td colSpan={7} className="px-4 py-3">
            <table className="w-full text-2xs">
              <thead className="text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium py-1">Year</th>
                  <th className="text-right font-medium py-1">§179</th>
                  <th className="text-right font-medium py-1">Bonus</th>
                  <th className="text-right font-medium py-1">MACRS/SL</th>
                  <th className="text-right font-medium py-1">Total</th>
                  <th className="text-right font-medium py-1">Accumulated</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {asset.schedule.map((y) => (
                  <tr key={y.ordinal} className={clsx('border-t border-slate-800/40', y.year === taxYear && 'bg-emerald-500/5')}>
                    <td className="py-1 text-slate-300">{y.year}{y.year === taxYear && <span className="ml-1 text-emerald-400 not-italic">●</span>}</td>
                    <td className="py-1 text-right text-slate-400">{y.section179Cents ? fmt(y.section179Cents) : '—'}</td>
                    <td className="py-1 text-right text-slate-400">{y.bonusCents ? fmt(y.bonusCents) : '—'}</td>
                    <td className="py-1 text-right text-slate-400">{fmt(y.regularCents)}</td>
                    <td className="py-1 text-right text-white">{fmt(y.totalCents)}</td>
                    <td className="py-1 text-right text-slate-400">{fmt(y.accumulatedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
