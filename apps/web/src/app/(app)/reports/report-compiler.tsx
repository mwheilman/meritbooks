'use client';

import { useState, useCallback } from 'react';
import { Sparkles, Loader2, FileText, Download, AlertTriangle, ChevronRight, X, Wand2 } from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';
import type { ResolvedSpec } from '@/lib/reports/compiler/spec';

/**
 * NL Report Compiler UI — the "Describe a report pack" box on /reports.
 *
 * Flow: the user describes a pack in plain English → we PARSE it (AI maps to
 * allowlisted specs; deterministic code expands the dates) and show EXACTLY what
 * will be generated for confirmation → on Generate we run the ledger engines and
 * download ONE combined, branded PDF. The model never computes a figure; abstains
 * are shown honestly (never a guessed report).
 */

interface ParseSummary {
  report: string;
  basis: string;
  periods: string[];
  cashWarning: string | null;
}
interface CompileResponse {
  abstained: boolean;
  message?: string;
  supported?: string[];
  pack?: { entityLabel: string; locationIds: string[]; specs: ResolvedSpec[] };
  summary?: ParseSummary[];
  totalSections?: number;
}

const EXAMPLES = [
  'The last three years of P&L and balance sheets on accrual, in one PDF',
  '3 years of sales by customer plus this year’s P&L through June on accrual',
  'Trial balance and balance sheet as of last year-end, plus current AR and AP aging',
  'Cash flow statement and P&L for the last 12 months',
];

export function ReportCompiler({ entityLabel, locationIds }: { entityLabel: string; locationIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [parsing, setParsing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<CompileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const parse = useCallback(async () => {
    const p = prompt.trim();
    if (p.length < 2 || parsing) return;
    setParsing(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch('/api/reports/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p, entity_label: entityLabel, location_ids: locationIds }),
      });
      const j = (await resp.json()) as CompileResponse & { error?: string };
      if (!resp.ok) throw new Error(j.error ?? 'Could not parse the request.');
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setParsing(false);
    }
  }, [prompt, parsing, entityLabel, locationIds]);

  const generate = useCallback(async () => {
    if (!result?.pack || generating) return;
    setGenerating(true);
    try {
      const resp = await fetch('/api/reports/compile/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.pack),
      });
      if (!resp.ok) {
        let msg = 'PDF generation failed.';
        try { const j = await resp.json(); msg = j.error ?? msg; } catch { /* binary body */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-pack_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('success', 'Report pack PDF generated.');
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setGenerating(false);
    }
  }, [result, generating]);

  const totalSections = result?.totalSections ?? 0;

  return (
    <div className="mb-5 rounded-2xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/[0.07] to-transparent overflow-hidden">
      {/* Header / trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-indigo-500/[0.04] transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-indigo-500/15 flex items-center justify-center shrink-0">
          <Wand2 size={16} className="text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Describe a report pack</p>
          <p className="text-[11px] text-slate-400 truncate">
            e.g. “last three years of P&amp;L and balance sheets on accrual, in one PDF” — assembled into a single branded document
          </p>
        </div>
        <ChevronRight size={16} className={clsx('text-slate-500 transition-transform shrink-0', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1">
          {/* Input */}
          <div className="relative">
            <Sparkles className="absolute left-3 top-3 w-4 h-4 text-indigo-400 pointer-events-none" />
            <textarea
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); parse(); } }}
              rows={2}
              placeholder="Describe the reports, periods, and basis you want in one PDF…"
              className="w-full pl-9 pr-3 py-2.5 bg-slate-900/60 border border-indigo-500/25 rounded-xl text-sm text-white placeholder:text-indigo-300/40 focus:outline-none focus:border-indigo-500/50 resize-none"
            />
          </div>

          {/* Examples */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => { setPrompt(ex); reset(); }}
                className="px-2.5 py-1 rounded-full text-[11px] text-indigo-300/80 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={parse}
              disabled={prompt.trim().length < 2 || parsing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {parsing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {parsing ? 'Reading your request…' : 'Preview the pack'}
            </button>
            <span className="text-[11px] text-slate-600">⌘/Ctrl + Enter</span>
            {(result || error) && (
              <button onClick={reset} className="ml-auto flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300">
                <X size={12} /> Clear
              </button>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          {/* Abstain */}
          {result?.abstained && (
            <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs text-amber-200 whitespace-pre-line">{result.message}</p>
                </div>
              </div>
            </div>
          )}

          {/* Parsed pack → confirm */}
          {result && !result.abstained && result.summary && (
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
                <p className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <FileText size={13} className="text-emerald-400" />
                  I’ll generate {totalSections} report section{totalSections === 1 ? '' : 's'} in one PDF
                </p>
                <span className="text-[11px] text-slate-500">{result.pack?.entityLabel}</span>
              </div>
              <div className="divide-y divide-slate-800/60">
                {result.summary.map((s, i) => (
                  <div key={i} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-white font-medium">{s.report}</span>
                      <span className={clsx('px-1.5 py-0.5 rounded text-[10px]', s.basis === 'Cash' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-slate-800 text-slate-400')}>{s.basis}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {s.periods.map((p, pi) => (
                        <span key={pi} className="px-2 py-0.5 rounded bg-emerald-500/10 text-[11px] text-emerald-300 font-mono">{p}</span>
                      ))}
                    </div>
                    {s.cashWarning && (
                      <p className="mt-1.5 text-[11px] text-amber-400/80 flex items-center gap-1">
                        <AlertTriangle size={11} /> {s.cashWarning}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between gap-3 bg-slate-900/40">
                <p className="text-[11px] text-slate-500">Every figure is computed from your ledger — the AI only chose the reports and periods.</p>
                <button
                  onClick={generate}
                  disabled={generating}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {generating ? 'Building PDF…' : 'Generate PDF'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
