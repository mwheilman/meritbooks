'use client';

import { useCallback, useState } from 'react';
import { Brain, Loader2, Trash2, AlertCircle, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

/**
 * Learned Preferences (M14) — a transparency + control surface over the generic
 * org-scoped memory store. Every learning here is READ-ONLY personalization: it
 * defaults a selector or shows a hint, and never acts on the books. The tenant can
 * see exactly what MeritBooks has inferred about how they work, and forget any of it.
 */

interface Pref {
  scope: string;
  key: string;
  value: unknown;
  confidence: number;
  observations: number;
  updatedAt: string | null;
}

const SCOPE_LABEL: Record<string, string> = {
  CATEGORIZATION: 'Categorization',
  CLOSE_CADENCE: 'Close cadence',
  REPORT_PREFS: 'Report defaults',
  TONE: 'Narrative tone',
  METHOD_SSP: 'Rev-rec method',
};

function describe(p: Pref): string {
  if (p.scope === 'CLOSE_CADENCE' && p.value && typeof p.value === 'object' && 'closeDay' in p.value) {
    return `Typically finishes close around day ${(p.value as { closeDay: number }).closeDay}`;
  }
  if (p.scope === 'REPORT_PREFS' && p.value && typeof p.value === 'object') {
    const v = p.value as { period?: string; compare?: string; basis?: string };
    const parts = [v.period, v.basis, v.compare && v.compare !== 'none' ? `vs ${v.compare}` : null].filter(Boolean);
    return `${p.key.replace(/^report:/, '')} → ${parts.join(' · ') || '—'}`;
  }
  return typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value ?? '—');
}

export function LearnedPreferences() {
  const { data, isLoading, error, refetch } = useQuery<{ preferences: Pref[] }>('/api/learning/preferences');
  const [busy, setBusy] = useState<string | null>(null);
  const prefs = data?.preferences ?? [];

  const forget = useCallback(async (p: Pref) => {
    setBusy(`${p.scope}:${p.key}`);
    try {
      const res = await fetch(
        `/api/learning/preferences?scope=${encodeURIComponent(p.scope)}&key=${encodeURIComponent(p.key)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) { addToast('error', 'Failed to forget preference'); return; }
      addToast('success', 'Preference forgotten');
      refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusy(null);
    }
  }, [refetch]);

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{String(error)}</p></div>;

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Brain size={18} className="text-indigo-400" /> Learned Preferences</h2>
        <p className="text-xs text-slate-500 mt-1">
          What MeritBooks has learned about how your team works. These only pre-fill defaults and hints — they never post
          entries or approve anything. Forget any of them and it stops being suggested.
        </p>
      </div>

      {prefs.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500 border border-dashed border-slate-700/60 rounded-lg">
          <Sparkles className="w-6 h-6 mx-auto text-slate-600 mb-2" />
          Nothing learned yet. As you categorize, close periods, and run reports, your typical choices show up here.
        </div>
      ) : (
        <div className="space-y-2">
          {prefs.map((p) => {
            const id = `${p.scope}:${p.key}`;
            return (
              <div key={id} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-800">
                <span className="w-28 shrink-0 text-[10px] font-medium uppercase tracking-wider text-indigo-300/80">
                  {SCOPE_LABEL[p.scope] ?? p.scope}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 truncate">{describe(p)}</p>
                  <p className="text-[10px] text-slate-500 font-mono">
                    {p.observations} observation{p.observations === 1 ? '' : 's'} · {Math.round(p.confidence * 100)}% confidence
                  </p>
                </div>
                <button
                  onClick={() => forget(p)}
                  disabled={busy === id}
                  className={clsx(
                    'shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors',
                    'bg-slate-800 text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40',
                  )}
                  title="Forget this learned preference"
                >
                  {busy === id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Forget
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
