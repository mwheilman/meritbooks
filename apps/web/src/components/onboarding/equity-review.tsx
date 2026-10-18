'use client';

/**
 * EquityReview — the equity / cap-table onboarding surface.
 *
 * "Review, don't enter" (design spec §5): drop an operating agreement / cap table and
 * AI proposes the owners; or map a CSV; or enter them by hand — all three land in the
 * SAME editable table. A live ownership-sum banner ties the split to 100%; on save we
 * persist the cap table and wire the consolidation ownership, then surface how the
 * per-owner capital reconciles to the opening trial balance.
 *
 * Degrade-safe: with AI off, the drop path returns a calm notice and the CSV / manual
 * paths still work. All states (loading / empty / populated / error) are handled;
 * numbers use tabular-nums; every control is labelled and keyboard-reachable.
 */

import { useCallback, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Sparkles, AlertTriangle, Loader2, Plus, Trash2, Check, Info, Building2, FileText,
} from 'lucide-react';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { DropZone } from './drop-zone';
import {
  ownershipSumCheck,
  capTableBlockers,
} from '@/lib/onboarding/equity-import/normalize';
import {
  EQUITY_CLASSES,
  type EquityClass,
  type OwnershipBasis,
  type ProposedOwner,
} from '@/lib/onboarding/equity-import/types';

export interface EntityOption {
  id: string;
  name: string;
}

export interface EquityReviewProps {
  /** Companies in the tenant (for the target selector + holdco linking). */
  entities: EntityOption[];
  /** Preselected company id (e.g. the active company). */
  defaultEntityId?: string;
  /** Called after a successful save. */
  onCommitted?: () => void;
}

interface CommitReconcile {
  holderCapitalCents: number;
  openingEquityCents: number | null;
  varianceCents: number | null;
  tied: boolean;
  noCapitalStated: boolean;
}
interface CommitResponse {
  persisted: boolean;
  tableMissing: boolean;
  holdersWritten: number;
  consolidation: { edgesWired: number; tableAvailable: boolean };
  reconcile: CommitReconcile;
  warnings: string[];
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function blankOwner(): ProposedOwner {
  return {
    name: '',
    ownership_pct: null,
    units: null,
    capital_contributed_cents: null,
    equity_class: 'COMMON',
    is_preferred: false,
    preferred_terms: null,
    owner_entity_id: null,
    confidence: {},
    lowConfidenceFields: [],
  };
}

const CLASS_LABEL: Record<EquityClass, string> = {
  COMMON: 'Common',
  PREFERRED: 'Preferred',
  LLC_UNIT: 'LLC unit',
  PARTNER: 'Partner',
  OTHER: 'Other',
};

export function EquityReview({ entities, defaultEntityId, onCommitted }: EquityReviewProps) {
  const [entityId, setEntityId] = useState<string>(defaultEntityId ?? entities[0]?.id ?? '');
  const [basis, setBasis] = useState<OwnershipBasis>('PERCENT');
  const [owners, setOwners] = useState<ProposedOwner[]>([]);
  const [started, setStarted] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [docNote, setDocNote] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);

  const sum = useMemo(() => ownershipSumCheck(owners, basis), [owners, basis]);
  const blockers = useMemo(() => capTableBlockers({ owners, ownershipBasis: basis }), [owners, basis]);

  const patchOwner = useCallback((i: number, patch: Partial<ProposedOwner>) => {
    setOwners((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
    setResult(null);
  }, []);
  const addOwner = useCallback(() => { setOwners((p) => [...p, blankOwner()]); setStarted(true); setResult(null); }, []);
  const removeOwner = useCallback((i: number) => { setOwners((p) => p.filter((_, idx) => idx !== i)); setResult(null); }, []);

  const onFiles = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setError(null); setNotice(null);
    if (!ALLOWED.includes(file.type)) { setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File too large. Maximum 10MB.'); return; }
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/onboarding/import/equity', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) {
        // AI-off / budget → calm notice, keep manual + CSV available.
        if (res.status === 503) { setNotice(body.error ?? 'AI is unavailable — enter the cap table by hand.'); }
        else setError(body.error ?? 'Failed to read the document.');
        return;
      }
      setOwners(body.proposal.owners as ProposedOwner[]);
      setBasis((body.proposal.ownershipBasis as OwnershipBasis) ?? 'PERCENT');
      setDocNote(body.proposal.documentNote ?? null);
      setSnippet(body.proposal.snippet ?? null);
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setParsing(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!entityId) { setError('Select a company for this cap table.'); return; }
    setSaving(true); setError(null); setResult(null);
    try {
      const res = await fetch('/api/onboarding/import/equity', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId, owners, ownershipBasis: basis }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.blockers?.length ? body.blockers.join(' ') : body.error ?? 'Could not save the cap table.');
        return;
      }
      setResult(body as CommitResponse);
      onCommitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }, [entityId, owners, basis, onCommitted]);

  const canSave = owners.length > 0 && blockers.length === 0 && !!entityId && !saving;

  return (
    <div className="space-y-5">
      {/* Header + target company */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Building2 size={18} className="text-brand-400" /> Equity &amp; Cap Table
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Capture owners, ownership %, and capital — from a dropped operating agreement, a CSV, or by hand.
            We set up the holding-company structure and consolidation ownership from this.
          </p>
        </div>
        <label className="text-xs text-slate-400">
          <span className="mb-1 block">Company</span>
          <select
            value={entityId}
            onChange={(e) => { setEntityId(e.target.value); setResult(null); }}
            className="rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
          >
            {entities.length === 0 && <option value="">No companies yet</option>}
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-surface-900/60 px-3 py-2 text-xs text-slate-300">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-500" /> {notice}
        </div>
      )}

      {/* Source step — drop / manual (shown until the table has rows) */}
      {!started && (
        <div className="space-y-3">
          <DropZone
            label={parsing ? 'Reading the document…' : 'Drop an operating agreement or cap table'}
            hint={parsing ? 'This can take 15–30 seconds.' : 'PDF or image · we propose the owners · or enter them by hand'}
            accept=".pdf,image/*"
            onFiles={onFiles}
            disabled={parsing}
          />
          {parsing && (
            <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" /> Extracting ownership…</p>
          )}
          <button
            type="button"
            onClick={addOwner}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
          >
            <Plus size={13} /> Enter owners manually
          </button>
        </div>
      )}

      {/* AI provenance */}
      {started && (snippet || docNote) && (
        <div className="space-y-2">
          {docNote && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-surface-900/60 px-3 py-2 text-[11px] text-slate-400">
              <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {docNote}
            </div>
          )}
          {snippet && (
            <p className="border-l-2 border-ai/40 bg-surface-900/60 px-2 py-1.5 text-[11px] italic text-slate-400">
              <Sparkles size={11} className="mr-1 inline text-ai-fg" aria-hidden />&ldquo;{snippet}&rdquo;
            </p>
          )}
        </div>
      )}

      {/* Owner table */}
      {started && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1 rounded-lg border border-slate-700 p-0.5 text-xs" role="group" aria-label="Ownership basis">
              {(['PERCENT', 'UNITS'] as OwnershipBasis[]).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBasis(b)}
                  className={clsx('rounded-md px-2.5 py-1', basis === b ? 'bg-brand-500 text-slate-900' : 'text-slate-400 hover:text-white')}
                >
                  {b === 'PERCENT' ? 'By %' : 'By units'}
                </button>
              ))}
            </div>
            <button type="button" onClick={addOwner} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800/60">
              <Plus size={13} /> Add owner
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium text-right">{basis === 'PERCENT' ? 'Ownership %' : 'Units'}</th>
                  <th className="px-3 py-2 font-medium text-right">Capital contributed</th>
                  <th className="px-3 py-2 font-medium">Class</th>
                  <th className="px-3 py-2 font-medium">Is an entity? (holdco)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {owners.map((o, i) => {
                  const low = new Set(o.lowConfidenceFields);
                  return (
                    <tr key={i} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-3 py-2">
                        <input
                          aria-label={`Owner ${i + 1} name`}
                          value={o.name}
                          onChange={(e) => patchOwner(i, { name: e.target.value })}
                          placeholder="Owner / member name"
                          className={clsx('w-44 rounded-md border bg-surface-950 px-2 py-1 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                            low.has('name') ? 'border-warning/50' : 'border-slate-700')}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          aria-label={`Owner ${i + 1} ${basis === 'PERCENT' ? 'ownership percent' : 'units'}`}
                          value={basis === 'PERCENT' ? (o.ownership_pct ?? '') : (o.units ?? '')}
                          onChange={(e) => {
                            const v = e.target.value === '' ? null : Number(e.target.value);
                            patchOwner(i, basis === 'PERCENT' ? { ownership_pct: v } : { units: v });
                          }}
                          className={clsx('w-24 rounded-md border bg-surface-950 px-2 py-1 text-right text-sm tabular-nums text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                            low.has('ownership_pct') ? 'border-warning/50' : 'border-slate-700')}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center">
                          <span className="text-slate-500">$</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            aria-label={`Owner ${i + 1} capital contributed (dollars)`}
                            value={o.capital_contributed_cents === null ? '' : centsToDollars(o.capital_contributed_cents)}
                            onChange={(e) => patchOwner(i, { capital_contributed_cents: e.target.value === '' ? null : dollarsToCents(e.target.value) })}
                            className="w-28 rounded-md border border-slate-700 bg-surface-950 px-2 py-1 text-right text-sm tabular-nums text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`Owner ${i + 1} equity class`}
                          value={o.equity_class}
                          onChange={(e) => {
                            const ec = e.target.value as EquityClass;
                            patchOwner(i, { equity_class: ec, is_preferred: ec === 'PREFERRED' });
                          }}
                          className="rounded-md border border-slate-700 bg-surface-950 px-2 py-1 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                        >
                          {EQUITY_CLASSES.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`Owner ${i + 1} linked company`}
                          value={o.owner_entity_id ?? ''}
                          onChange={(e) => patchOwner(i, { owner_entity_id: e.target.value || null })}
                          className="rounded-md border border-slate-700 bg-surface-950 px-2 py-1 text-xs text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                        >
                          <option value="">Individual / external</option>
                          {entities.filter((en) => en.id !== entityId).map((en) => (
                            <option key={en.id} value={en.id}>{en.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" onClick={() => removeOwner(i)} aria-label={`Remove owner ${i + 1}`} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-300">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {owners.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-500">No owners yet — add one, or drop a document above.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Ownership-sum tie */}
          <div className={clsx('flex items-center justify-between rounded-lg border px-3 py-2 text-xs',
            sum.withinTolerance ? 'border-brand-500/30 bg-brand-500/[0.06] text-brand-300' : 'border-warning/40 bg-warning/[0.06] text-warning-fg')}>
            <span className="flex items-center gap-1.5">
              {sum.withinTolerance ? <Check size={13} /> : <AlertTriangle size={13} />}
              Ownership totals <strong className="tabular-nums">{sum.totalPct}%</strong>
              {basis === 'UNITS' && <span className="text-slate-500">({sum.unitsTotal} units)</span>}
            </span>
            {!sum.withinTolerance && (
              <span className="tabular-nums">
                {sum.varianceFromHundred > 0 ? 'over' : 'under'} by {Math.abs(sum.varianceFromHundred)}%
              </span>
            )}
          </div>

          {blockers.length > 0 && (
            <ul className="space-y-1 text-[11px] text-warning-fg">
              {blockers.map((b, i) => <li key={i} className="flex items-start gap-1.5"><AlertTriangle size={11} className="mt-0.5 shrink-0" /> {b}</li>)}
            </ul>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className={clsx('inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                canSave ? 'bg-brand-500 text-slate-900 hover:bg-brand-400' : 'cursor-not-allowed bg-slate-700 text-slate-500')}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save cap table
            </button>
            <span className="text-[11px] text-slate-500">Nothing posts to the ledger — this captures ownership only.</span>
          </div>
        </div>
      )}

      {/* Commit result — persistence + consolidation + reconcile */}
      {result && (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-surface-900/60 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-white">
            <FileText size={15} className="text-brand-400" />
            {result.persisted
              ? `Saved ${result.holdersWritten} owner${result.holdersWritten === 1 ? '' : 's'}.`
              : result.tableMissing
                ? 'Cap-table storage is not enabled in this environment yet — ask your admin to apply the equity_holders table.'
                : 'Cap table reviewed.'}
          </p>
          {result.consolidation.edgesWired > 0 && (
            <p className="text-xs text-slate-400">
              Wired {result.consolidation.edgesWired} ownership edge{result.consolidation.edgesWired === 1 ? '' : 's'} into consolidation
              {' '}— minority interest (NCI) will flow on consolidated statements.
            </p>
          )}
          {/* Opening-capital reconcile */}
          {!result.reconcile.noCapitalStated && result.reconcile.openingEquityCents !== null && (
            <p className={clsx('flex items-center gap-1.5 text-xs', result.reconcile.tied ? 'text-brand-300' : 'text-warning-fg')}>
              {result.reconcile.tied ? <Check size={12} /> : <AlertTriangle size={12} />}
              Capital contributed <span className="tabular-nums">{formatMoney(result.reconcile.holderCapitalCents)}</span>
              {' '}vs opening equity <span className="tabular-nums">{formatMoney(result.reconcile.openingEquityCents)}</span>
              {!result.reconcile.tied && result.reconcile.varianceCents !== null && (
                <span className="tabular-nums">· variance {formatMoney(result.reconcile.varianceCents, { showSign: true })}</span>
              )}
            </p>
          )}
          {result.reconcile.noCapitalStated && (
            <p className="text-[11px] text-slate-500">No per-owner capital entered — opening equity comes in through the trial balance.</p>
          )}
          {result.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-warning-fg"><AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}</p>
          ))}
        </div>
      )}
    </div>
  );
}
