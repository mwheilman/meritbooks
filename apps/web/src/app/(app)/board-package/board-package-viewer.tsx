'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Calendar, Building2, ChevronDown, Check, Loader2, AlertCircle, Sparkles, RefreshCw,
  Download, FileText, ShieldCheck, TrendingUp, TrendingDown, BookOpen,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import type { Location } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import type { BoardPackage } from '@/lib/reports/board-package';

interface BoardPackageResponse extends BoardPackage {
  aiMeta?: { requested: boolean; message: string | null };
}

// ── Period presets ────────────────────────────────────────────────────────────
function pad(n: number) { return String(n).padStart(2, '0'); }
function fmt(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const PERIODS = [
  { key: 'last_month', label: 'Last Month', get: () => { const n = new Date(); const d = new Date(n.getFullYear(), n.getMonth() - 1, 1); return { s: fmt(d), e: fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; } },
  { key: 'this_month', label: 'This Month', get: () => { const n = new Date(); return { s: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-01`, e: fmt(new Date(n.getFullYear(), n.getMonth() + 1, 0)) }; } },
  { key: 'this_qtr', label: 'This Quarter', get: () => { const n = new Date(); const q = Math.floor(n.getMonth() / 3) * 3; return { s: `${n.getFullYear()}-${pad(q + 1)}-01`, e: fmt(new Date(n.getFullYear(), q + 3, 0)) }; } },
  { key: 'last_qtr', label: 'Last Quarter', get: () => { const n = new Date(); let q = Math.floor(n.getMonth() / 3) * 3 - 3; let y = n.getFullYear(); if (q < 0) { q += 12; y--; } return { s: `${y}-${pad(q + 1)}-01`, e: fmt(new Date(y, q + 3, 0)) }; } },
  { key: 'ytd', label: 'Year to Date', get: () => ({ s: `${new Date().getFullYear()}-01-01`, e: fmt(new Date()) }) },
  { key: 'last_year', label: 'Last Year', get: () => { const y = new Date().getFullYear() - 1; return { s: `${y}-01-01`, e: `${y}-12-31` }; } },
  { key: 'custom', label: 'Custom Range', get: () => ({ s: '', e: '' }) },
];

interface LocationEx extends Location { industry: string | null }

export function BoardPackageViewer() {
  const [periodKey, setPeriodKey] = useState('last_month');
  const [customS, setCustomS] = useState('');
  const [customE, setCustomE] = useState('');
  const [selectedLocs, setSelectedLocs] = useState<string[]>([]);
  const [wantAi, setWantAi] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const { data: rawLocs } = useQuery<LocationEx[]>('/api/locations');
  const locations = rawLocs ?? [];

  const { s: sd, e: ed } = useMemo(() => {
    if (periodKey === 'custom') return { s: customS, e: customE };
    return PERIODS.find((p) => p.key === periodKey)?.get() ?? { s: '', e: '' };
  }, [periodKey, customS, customE]);

  const entityLabel = useMemo(() => {
    if (selectedLocs.length === 0) return 'All Companies (Consolidated)';
    if (selectedLocs.length === 1) return locations.find((l) => l.id === selectedLocs[0])?.name ?? 'Company';
    return `${selectedLocs.length} Companies (Consolidated)`;
  }, [selectedLocs, locations]);

  const ready = !!sd && !!ed;

  const params = useMemo(() => {
    const p: Record<string, string> = { start_date: sd, end_date: ed, as_of_date: ed, entity_label: entityLabel };
    if (selectedLocs.length > 0) p.location_ids = selectedLocs.join(',');
    if (wantAi) { p.ai = '1'; p._n = String(nonce); }
    return p;
  }, [sd, ed, entityLabel, selectedLocs, wantAi, nonce]);

  const queryKey = JSON.stringify(params);
  const { data, isLoading, error, refetch } = useQuery<BoardPackageResponse>(
    ready ? '/api/reports/board-package' : null,
    params,
    { key: queryKey },
  );

  const regenerateAi = useCallback(() => {
    // Flipping wantAi and/or bumping the nonce changes `params`, which triggers
    // useQuery to refetch with ai=1 — a fresh gateway call each time.
    setWantAi(true);
    setNonce((n) => n + 1);
  }, []);

  const downloadPdf = useCallback(async () => {
    if (!data || downloading) return;
    setDownloading(true);
    try {
      // Strip our non-schema field before POSTing the package back to the renderer.
      const { aiMeta: _omit, ...pkg } = data;
      void _omit;
      const resp = await fetch('/api/reports/board-package/pdf', {
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
      a.download = `board-package_${sd}_${ed}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('success', 'Board package PDF exported.');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setDownloading(false);
    }
  }, [data, downloading, sd, ed]);

  return (
    <div className="space-y-5">
      {/* ── Controls ── */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Calendar size={13} className="text-slate-500" />
          <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {periodKey === 'custom' && (
            <>
              <input type="date" value={customS} onChange={(e) => setCustomS(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
              <span className="text-slate-600 text-xs">to</span>
              <input type="date" value={customE} onChange={(e) => setCustomE(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
            </>
          )}
        </div>

        <CompanyMultiSelect options={locations.map((l) => ({ value: l.id, label: `${l.short_code} · ${l.name}`, group: l.industry ?? 'Other' }))} selected={selectedLocs} onChange={setSelectedLocs} />

        <div className="ml-auto">
          <button
            onClick={downloadPdf}
            disabled={!data || downloading || isLoading}
            className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {downloading ? 'Building PDF…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {/* ── States ── */}
      {!ready && <div className="card p-8 text-center text-sm text-slate-500">Select a reporting period to assemble the board package.</div>}
      {ready && isLoading && (
        <div className="card p-12 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={20} className="animate-spin" /> Assembling package for {entityLabel}…
        </div>
      )}
      {ready && !isLoading && error && (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
          <button onClick={refetch} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 underline">Try again</button>
        </div>
      )}

      {ready && !isLoading && !error && data && (
        <BoardPackagePreview data={data} entityLabel={entityLabel} onGenerateAi={regenerateAi} />
      )}
    </div>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────
function BoardPackagePreview({ data, entityLabel, onGenerateAi }: { data: BoardPackageResponse; entityLabel: string; onGenerateAi: () => void }) {
  const k = data.kpis;
  const is = data.statements.incomeStatement.summary;
  const bs = data.statements.balanceSheet.summary;
  const cf = data.statements.cashFlow;

  return (
    <div className="space-y-5">
      {/* Cover */}
      <div className="card p-5 border-l-4 border-l-emerald-500">
        <p className="text-[10px] uppercase tracking-widest text-slate-500">Confidential · Prepared for the Board</p>
        <h2 className="text-xl font-semibold text-white mt-1">{entityLabel}</h2>
        <p className="text-sm text-emerald-400 font-medium">{data.cover.title}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-slate-400">
          <span>Period: <span className="text-slate-200 font-mono">{data.meta.periodLabel}</span></span>
          <span>As of: <span className="text-slate-200 font-mono">{data.meta.asOfDate}</span></span>
          <span>{data.meta.basisLabel}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {data.cover.sectionList.map((sec, i) => (
            <span key={sec} className="px-2 py-0.5 rounded bg-slate-800 text-[11px] text-slate-400">{i + 1}. {sec}</span>
          ))}
        </div>
      </div>

      {/* Executive summary */}
      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center"><Sparkles size={14} className="text-indigo-400" /></div>
            <div>
              <p className="text-sm font-semibold text-white">Executive Summary</p>
              <p className="text-[11px] text-slate-500">Phrased from computed figures — the model never invents a number</p>
            </div>
          </div>
          <button onClick={onGenerateAi} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors">
            {data.executiveSummary.source === 'ai' ? <RefreshCw size={13} /> : <Sparkles size={13} />}
            {data.executiveSummary.source === 'ai' ? 'Regenerate' : 'Generate AI summary'}
          </button>
        </div>
        <p className="text-sm text-slate-200 leading-relaxed">{data.executiveSummary.text}</p>
        <div className="mt-3 flex items-center gap-2">
          <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium', data.executiveSummary.source === 'ai' ? 'text-indigo-300 bg-indigo-500/10' : 'text-amber-300 bg-amber-500/10')}>
            <ShieldCheck size={10} /> {data.executiveSummary.source === 'ai' ? `AI · ${data.executiveSummary.model ?? 'model'}` : 'Computed (deterministic)'}
          </span>
          {data.aiMeta?.message && <span className="text-[11px] text-amber-400/70">{data.aiMeta.message}</span>}
        </div>
      </div>

      {/* KPIs */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Key Performance Indicators</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {k.cards.map((c) => (
            <div key={c.key} className="card p-3 border-l-2 border-l-emerald-500/60">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">{c.label}</p>
              <p className="text-lg font-mono font-semibold text-white mt-0.5">{c.valueText}</p>
              {c.deltaPct != null ? (
                <p className={clsx('text-[11px] font-medium flex items-center gap-0.5 mt-0.5', c.favorable ? 'text-emerald-400' : 'text-red-400')}>
                  {c.favorable ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {c.deltaPct > 0 ? '+' : ''}{c.deltaPct}% vs prior
                </p>
              ) : c.hint ? (
                <p className="text-[11px] text-slate-500 mt-0.5">{c.hint}</p>
              ) : <p className="text-[11px] text-slate-700 mt-0.5">—</p>}
            </div>
          ))}
        </div>
      </div>

      {/* Statement summaries */}
      <div className="grid md:grid-cols-3 gap-4">
        <StatementCard title="Statement of Operations" rows={[
          { label: 'Revenue', cents: is.revenueCents },
          { label: 'Gross Profit', cents: is.grossProfitCents },
          { label: 'Operating Income', cents: is.ebitdaCents },
          { label: 'Net Income', cents: is.netIncomeCents, emph: true },
        ]} />
        <StatementCard title="Balance Sheet" rows={[
          { label: 'Total Assets', cents: bs.totalAssetsCents },
          { label: 'Total Liabilities', cents: bs.totalLiabilitiesCents },
          { label: 'Total Equity', cents: bs.totalEquityCents, emph: true },
        ]} footer={bs.isBalanced ? 'Balanced ✓' : `Off by ${formatMoney(Math.abs(bs.varianceCents))}`} footerOk={bs.isBalanced} />
        <StatementCard title="Cash Flows" rows={[
          { label: 'Operating', cents: cf.operating.totalCents },
          { label: 'Investing', cents: cf.investing.totalCents },
          { label: 'Financing', cents: cf.financing.totalCents },
          { label: 'Net Change in Cash', cents: cf.netChangeCents },
          { label: 'Ending Cash', cents: cf.endingCashCents, emph: true },
        ]} />
      </div>

      {/* Notes */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <BookOpen size={15} className="text-slate-400" />
          <p className="text-sm font-semibold text-white">Notes to Financial Statements</p>
        </div>
        <div className="space-y-4">
          {data.notes.notes.map((n) => (
            <div key={n.id} className="border-t border-slate-800 pt-3 first:border-t-0 first:pt-0">
              <p className="text-sm font-medium text-white flex items-center gap-2">
                {n.title}
                {n.editable && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 text-[10px]">Complete before issuing</span>}
              </p>
              {n.body.map((p, i) => (
                <p key={i} className={clsx('text-xs leading-relaxed mt-1.5', p.startsWith('[PLACEHOLDER') ? 'text-amber-400/70 italic' : 'text-slate-400')}>{p}</p>
              ))}
              {n.table && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-slate-500 border-b border-slate-800">
                      {n.table.columns.map((col, ci) => <th key={ci} className={clsx('py-1.5 px-2 font-semibold uppercase text-[10px]', ci === 0 ? 'text-left' : 'text-right')}>{col}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {n.table.rows.map((r, ri) => (
                        <tr key={ri}>
                          {r.map((cell, ci) => <td key={ci} className={clsx('py-1.5 px-2', ci === 0 ? 'text-slate-300' : 'text-right font-mono text-slate-400')}>{String(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <FileText size={12} /> Download the PDF for the full statement line items across all sections.
      </div>
    </div>
  );
}

function StatementCard({ title, rows, footer, footerOk }: { title: string; rows: { label: string; cents: number; emph?: boolean }[]; footer?: string; footerOk?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">{title}</p>
      <div className="space-y-1.5">
        {rows.map(({ label, cents, emph }) => (
          <div key={label} className={clsx('flex justify-between items-baseline', emph && 'pt-1.5 mt-1 border-t border-slate-800')}>
            <span className={clsx('text-xs', emph ? 'text-white font-medium' : 'text-slate-400')}>{label}</span>
            <span className={clsx('font-mono text-sm', emph ? (cents >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold') : 'text-slate-200')}>{formatMoney(cents)}</span>
          </div>
        ))}
      </div>
      {footer && <p className={clsx('mt-2 text-[11px]', footerOk ? 'text-emerald-400' : 'text-red-400')}>{footer}</p>}
    </div>
  );
}

// ── Company multi-select ────────────────────────────────────────────────────────
function CompanyMultiSelect({ options, selected, onChange }: { options: { value: string; label: string; group?: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const isAll = selected.length === 0;
  const displayText = isAll ? 'All Companies' : selected.length === 1 ? options.find((o) => o.value === selected[0])?.label ?? '1 selected' : `${selected.length} selected`;
  const toggle = (val: string) => selected.includes(val) ? onChange(selected.filter((s) => s !== val)) : onChange([...selected, val]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white hover:border-slate-600 transition-colors">
        <Building2 size={13} className="text-slate-500" />
        <span className={isAll ? 'text-slate-400' : 'text-emerald-400'}>{displayText}</span>
        <ChevronDown size={11} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 w-64 max-h-72 overflow-y-auto bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 py-1">
          <button onClick={() => onChange([])} className={clsx('w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-800 transition-colors', isAll ? 'text-emerald-400' : 'text-slate-400')}>
            <div className={clsx('w-3.5 h-3.5 rounded border flex items-center justify-center', isAll ? 'bg-emerald-600 border-emerald-500' : 'border-slate-600')}>{isAll && <Check size={9} className="text-white" />}</div>
            All Companies (Consolidated)
          </button>
          {options.map((opt) => {
            const checked = selected.includes(opt.value);
            return (
              <button key={opt.value} onClick={() => toggle(opt.value)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors">
                <div className={clsx('w-3.5 h-3.5 rounded border flex items-center justify-center', checked ? 'bg-emerald-600 border-emerald-500' : 'border-slate-600')}>{checked && <Check size={9} className="text-white" />}</div>
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
