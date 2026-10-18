'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Loader2, Trash2, Check, Play, ChevronDown, AlertTriangle } from 'lucide-react';
import { addToast } from '@/hooks';

/**
 * Saved report VIEWS on /reports — a one-click library of "run this report the way I
 * like it". Each view captures the current report + period + company/industry scope +
 * basis + summary/detail + comparative mode; applying one drives the live selectors
 * and re-runs against today's ledger (scope is re-validated by the consolidation gate
 * and RLS, never trusted from the saved blob).
 *
 * Distinct from Saved Packs (multi-report NL-compiler bundles with scheduled email).
 * Degrades safe: if the backing table (migration 138) is absent, the control hides.
 */

export interface ViewConfig {
  periodKey?: string;
  customS?: string;
  customE?: string;
  selectedLocs?: string[];
  selectedIndustries?: string[];
  basis?: 'accrual' | 'cash';
  viewMode?: 'summary' | 'detail';
  compareMode?: 'none' | 'prior_period' | 'prior_year' | 'budget';
}

export interface SavedView {
  id: string;
  name: string;
  report_key: string;
  config: ViewConfig;
}

const COMPARE_LABEL: Record<string, string> = {
  prior_period: 'vs Prior Period',
  prior_year: 'vs Prior Year',
  budget: 'vs Budget',
};

export function SavedViews({
  currentReportKey,
  currentConfig,
  reportLabelFor,
  onApply,
}: {
  currentReportKey: string | null;
  currentConfig: ViewConfig;
  reportLabelFor: (key: string) => string;
  onApply: (view: SavedView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/reports/views');
      const j = (await resp.json()) as { available?: boolean; views?: SavedView[]; error?: string };
      if (!resp.ok) throw new Error(j.error ?? 'Could not load saved views.');
      setAvailable(j.available !== false);
      setViews(j.views ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || !currentReportKey || saving) return;
    setSaving(true);
    try {
      const resp = await fetch('/api/reports/views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, report_key: currentReportKey, config: currentConfig }),
      });
      const j = (await resp.json()) as { view?: SavedView; error?: string };
      if (!resp.ok) throw new Error(j.error ?? 'Could not save this view.');
      if (j.view) setViews((prev) => [j.view as SavedView, ...prev]);
      setName('');
      addToast('success', `Saved view “${trimmed}”.`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [name, currentReportKey, currentConfig, saving]);

  const remove = useCallback(async (view: SavedView) => {
    if (!window.confirm(`Delete saved view “${view.name}”?`)) return;
    setBusyId(view.id);
    try {
      const resp = await fetch(`/api/reports/views/${view.id}`, { method: 'DELETE' });
      if (!resp.ok) {
        const j = (await resp.json()) as { error?: string };
        throw new Error(j.error ?? 'Delete failed.');
      }
      setViews((prev) => prev.filter((v) => v.id !== view.id));
      addToast('success', `Deleted “${view.name}”.`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusyId(null);
    }
  }, []);

  const apply = useCallback(
    (view: SavedView) => {
      onApply(view);
      setOpen(false);
      addToast('success', `Applied “${view.name}”.`);
    },
    [onApply],
  );

  const summarize = useCallback((v: SavedView) => {
    const c = v.config ?? {};
    const bits: string[] = [];
    if (c.basis === 'cash') bits.push('Cash');
    if (c.viewMode === 'detail') bits.push('Detail');
    if (c.compareMode && c.compareMode !== 'none') bits.push(COMPARE_LABEL[c.compareMode] ?? c.compareMode);
    const scope =
      (c.selectedLocs?.length ?? 0) === 0
        ? 'All companies'
        : c.selectedLocs!.length === 1
          ? '1 company'
          : `${c.selectedLocs!.length} companies`;
    bits.push(scope);
    return bits.join(' · ');
  }, []);

  const countLabel = useMemo(() => (views.length > 0 ? String(views.length) : ''), [views.length]);

  // Hide entirely when the feature is unavailable (migration pending) and there's
  // nothing to show — keeps the toolbar clean rather than surfacing a dead control.
  if (!available && views.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white hover:border-slate-600 transition-colors"
        title="Save and re-run report configurations"
      >
        <Bookmark size={13} className="text-slate-500" />
        Saved views
        {countLabel && <span className="px-1 rounded bg-slate-700 text-[10px] text-slate-300">{countLabel}</span>}
        <ChevronDown size={11} className="text-slate-500" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-80 max-h-[26rem] overflow-y-auto bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50">
          {/* Save current */}
          {currentReportKey && (
            <div className="p-3 border-b border-slate-800">
              <p className="text-[11px] font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                <BookmarkPlus size={12} className="text-emerald-400" /> Save current view
              </p>
              <div className="flex items-center gap-1.5">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                  placeholder={`${reportLabelFor(currentReportKey)} — name it`}
                  maxLength={120}
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-950/60 border border-slate-800 rounded-lg text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
                />
                <button
                  onClick={() => void save()}
                  disabled={!name.trim() || saving}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Save
                </button>
              </div>
            </div>
          )}

          {/* List */}
          <div className="py-1">
            <p className="px-3 pt-2 pb-1 text-[10px] text-slate-600 uppercase tracking-wider">Saved views</p>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={16} className="text-slate-500 animate-spin" />
              </div>
            ) : error ? (
              <div className="mx-3 mb-2 flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[11px] text-red-300">{error}</p>
              </div>
            ) : views.length === 0 ? (
              <p className="px-3 py-4 text-[11px] text-slate-500 text-center">
                No saved views yet. Configure a report above, then save it here.
              </p>
            ) : (
              views.map((v) => (
                <div key={v.id} className="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-800/60 transition-colors">
                  <button onClick={() => apply(v)} className="flex-1 min-w-0 text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-white truncate">{v.name}</span>
                      <span className="px-1 rounded bg-slate-800 text-[9px] text-slate-400 shrink-0">
                        {reportLabelFor(v.report_key)}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{summarize(v)}</p>
                  </button>
                  <button
                    onClick={() => apply(v)}
                    title="Run this view"
                    className="p-1 rounded text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    onClick={() => void remove(v)}
                    disabled={busyId === v.id}
                    title="Delete view"
                    className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                  >
                    {busyId === v.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
