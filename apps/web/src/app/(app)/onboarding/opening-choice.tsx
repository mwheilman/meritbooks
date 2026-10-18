'use client';

import { useCallback, useState } from 'react';
import { CircleCheck, Loader2, Sparkles, Undo2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';
import type { CompanyOnboarding } from '@/lib/onboarding/status';
import { OPENING_STATE_LABEL } from '@/lib/onboarding/wizard-progress';

/**
 * The EXPLICIT per-company opening-balance choice (FPB-onboarding §2.7).
 *
 * A company goes live either by posting opening balances (the conversion tool below
 * this) or by the owner deliberately choosing "Start fresh with no history" here — a
 * two-click confirm, recorded per company via POST /api/onboarding/company-status.
 * Nothing else (no source-tile click, no revisit) marks opening balances skipped.
 *
 *  - posted         → shows "Posted"; no start-fresh offer (the API refuses it too).
 *  - started_fresh  → shows "Started fresh" with an Undo.
 *  - not_started    → offers the explicit choice.
 */

export async function recordOpeningChoice(companyId: string, opening: 'fresh' | 'none'): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/onboarding/company-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, opening }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? 'Could not save that choice.' };
  } catch {
    return { ok: false, error: 'Network error saving that choice.' };
  }
}

export function OpeningChoice({
  company,
  onChanged,
}: {
  company: CompanyOnboarding | null;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const choose = useCallback(async (opening: 'fresh' | 'none') => {
    if (!company) return;
    setSaving(true);
    setError('');
    const r = await recordOpeningChoice(company.id, opening);
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? 'Could not save that choice.');
      return;
    }
    setConfirming(false);
    addToast('success', opening === 'fresh'
      ? `${company.name} will start fresh — no prior history.`
      : `Start-fresh undone for ${company.name}.`);
    await onChanged();
  }, [company, onChanged]);

  if (!company) {
    return (
      <div className="rounded-lg border border-warning/25 bg-warning/5 p-4 text-sm text-warning-fg flex items-start gap-2">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <span>Create a company first — opening balances belong to a specific company.</span>
      </div>
    );
  }

  const stateCls = company.opening === 'not_started' ? 'bg-slate-800 text-slate-400' : 'bg-brand-500/15 text-brand-300';

  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-3.5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-300">
          Opening balances for <span className="text-white font-medium">{company.name}</span>
        </p>
        <span className={clsx('text-[11px] px-2 py-0.5 rounded-full', stateCls)}>{OPENING_STATE_LABEL[company.opening]}</span>
      </div>

      {company.opening === 'posted' && (
        <p className="flex items-center gap-2 text-xs text-brand-300">
          <CircleCheck size={14} /> Posted and balanced — this company is live.
        </p>
      )}

      {company.opening === 'started_fresh' && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">You chose to start with no prior history. You can still import balances below at any time.</p>
          <button
            type="button"
            onClick={() => void choose('none')}
            disabled={saving}
            className="shrink-0 flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
          </button>
        </div>
      )}

      {company.opening === 'not_started' && !confirming && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">Brand-new business, or nothing worth bringing over?</p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-700 text-slate-200 hover:border-brand-500/40 hover:text-white transition-colors"
          >
            <Sparkles size={13} className="text-brand-400" /> Start fresh with no history
          </button>
        </div>
      )}

      {company.opening === 'not_started' && confirming && (
        <div className="rounded-lg border border-slate-700 bg-surface-950 p-3 space-y-2.5" role="alertdialog" aria-label="Confirm start fresh">
          <p className="text-xs text-slate-300">
            {company.name}&apos;s books will start at zero — no balances carried over from before. Your reports will
            only show activity from here on. You can still import history later.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void choose('fresh')}
              disabled={saving}
              autoFocus
              className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                saving ? 'bg-slate-700 text-slate-500' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
            >
              {saving && <Loader2 size={12} className="animate-spin" />} Yes, start fresh
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-xs text-slate-500 hover:text-slate-300 px-2">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-danger-fg" role="alert">{error}</p>}
    </div>
  );
}
