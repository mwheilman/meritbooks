'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bookmark, Loader2, Download, Trash2, CalendarClock, AlertTriangle,
  ChevronRight, Mail, Check, X, Sheet,
} from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';
import { REPORT_CATALOG, type ReportType, type ReportSpec } from '@/lib/reports/compiler/spec';
import { nextOccurrence, cadenceLabel } from '@/lib/reports/compiler/packs';
import { PACKS_CHANGED_EVENT } from './report-compiler';

/**
 * Saved report packs on /reports — list, run/download, and schedule recurring
 * email delivery of a saved pack. A saved pack stores RELATIVE descriptors, so
 * "run" always re-resolves to today's fiscal dates. Scheduling is opt-in and
 * requires a cadence + recipients (the human gate): a pack never auto-emails.
 */

type Cadence = 'NONE' | 'MONTHLY' | 'QUARTERLY';

interface Pack {
  id: string;
  name: string;
  entity_label: string | null;
  specs: ReportSpec[];
  schedule_cadence: Cadence;
  recipients: string[] | null;
  schedule_active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  next_run_date: string | null;
}

function reportTitle(r: ReportType): string {
  return REPORT_CATALOG[r]?.title ?? r;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function SavedPacks() {
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runFmt, setRunFmt] = useState<'pdf' | 'xlsx' | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/reports/packs');
      const j = (await resp.json()) as { available?: boolean; packs?: Pack[]; error?: string };
      if (!resp.ok) throw new Error(j.error ?? 'Could not load saved packs.');
      setAvailable(j.available !== false);
      setPacks(j.packs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const handler = () => { void load(); };
    window.addEventListener(PACKS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PACKS_CHANGED_EVENT, handler);
  }, [load]);

  const runPack = useCallback(async (pack: Pack, fmt: 'pdf' | 'xlsx') => {
    if (running) return;
    setRunning(pack.id);
    setRunFmt(fmt);
    try {
      const resp = await fetch(`/api/reports/packs/${pack.id}/${fmt}`, { method: 'POST' });
      if (!resp.ok) {
        let msg = `${fmt.toUpperCase()} generation failed.`;
        try { const j = await resp.json(); msg = j.error ?? msg; } catch { /* binary */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${pack.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}_${new Date().toISOString().slice(0, 10)}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('success', `Generated “${pack.name}” (${fmt === 'xlsx' ? 'Excel' : 'PDF'}).`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setRunning(null);
      setRunFmt(null);
    }
  }, [running]);

  const deletePack = useCallback(async (pack: Pack) => {
    if (!window.confirm(`Delete saved pack “${pack.name}”? This can’t be undone.`)) return;
    try {
      const resp = await fetch(`/api/reports/packs/${pack.id}`, { method: 'DELETE' });
      if (!resp.ok) { const j = await resp.json(); throw new Error(j.error ?? 'Delete failed.'); }
      setPacks((prev) => prev.filter((p) => p.id !== pack.id));
      addToast('success', `Deleted “${pack.name}”.`);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Delete failed.');
    }
  }, []);

  const onSaved = useCallback((updated: Pack) => {
    setPacks((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setEditing(null);
  }, []);

  if (!available && !loading) {
    return (
      <div className="mb-5 rounded-2xl border border-slate-800 bg-slate-900/30 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Bookmark size={14} className="text-slate-500" />
          Saved report packs will be available once the pending database migration is applied. Ad-hoc report compilation still works above.
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-2xl border border-emerald-500/15 bg-gradient-to-br from-emerald-500/[0.05] to-transparent overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
          <Bookmark size={16} className="text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Saved report packs</p>
          <p className="text-[11px] text-slate-400">
            Reusable packs re-run against today’s ledger. Schedule one for automatic monthly or quarterly email delivery.
          </p>
        </div>
        {loading && <Loader2 size={15} className="text-slate-500 animate-spin" />}
      </div>

      {error && (
        <div className="mx-4 mb-3 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {!loading && !error && packs.length === 0 && (
        <div className="mx-4 mb-4 px-4 py-6 rounded-xl border border-dashed border-slate-800 text-center">
          <p className="text-xs text-slate-400">No saved packs yet.</p>
          <p className="text-[11px] text-slate-600 mt-1">
            Describe a report pack above, preview it, then name it and click “Save pack”.
          </p>
        </div>
      )}

      {packs.length > 0 && (
        <div className="px-3 pb-3 space-y-2">
          {packs.map((pack) => (
            <div key={pack.id} className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-white truncate">{pack.name}</span>
                      {pack.schedule_active ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-300 flex items-center gap-1">
                          <CalendarClock size={10} />
                          {pack.schedule_cadence === 'MONTHLY' ? 'Monthly' : 'Quarterly'}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-500">Not scheduled</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 truncate">{pack.entity_label ?? 'All Companies (Consolidated)'}</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {pack.specs.slice(0, 6).map((s, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded bg-slate-800/70 text-[10px] text-slate-300">
                          {reportTitle(s.report)}
                        </span>
                      ))}
                      {pack.specs.length > 6 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800/70 text-[10px] text-slate-500">
                          +{pack.specs.length - 6} more
                        </span>
                      )}
                    </div>
                    {pack.schedule_active && (
                      <p className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1">
                        <Mail size={11} className="text-emerald-500/70" />
                        Next: {fmtDate(pack.next_run_date)} → {(pack.recipients ?? []).length} recipient{(pack.recipients ?? []).length === 1 ? '' : 's'}
                      </p>
                    )}
                    {pack.last_run_at && (
                      <p className="text-[10px] text-slate-600 mt-0.5">Last run {fmtDate(pack.last_run_at)}{pack.last_run_status ? ` · ${pack.last_run_status}` : ''}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => runPack(pack, 'xlsx')}
                      disabled={running === pack.id}
                      title="Run & download as an Excel workbook (one sheet per report)"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition-colors"
                    >
                      {running === pack.id && runFmt === 'xlsx' ? <Loader2 size={13} className="animate-spin" /> : <Sheet size={13} />}
                      Excel
                    </button>
                    <button
                      onClick={() => runPack(pack, 'pdf')}
                      disabled={running === pack.id}
                      title="Run & download PDF"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
                    >
                      {running === pack.id && runFmt === 'pdf' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      PDF
                    </button>
                    <button
                      onClick={() => setEditing((id) => (id === pack.id ? null : pack.id))}
                      title="Schedule delivery"
                      className={clsx('p-1.5 rounded-lg transition-colors', editing === pack.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800')}
                    >
                      <CalendarClock size={15} />
                    </button>
                    <button
                      onClick={() => deletePack(pack)}
                      title="Delete pack"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
              {editing === pack.id && (
                <ScheduleEditor pack={pack} onSaved={onSaved} onCancel={() => setEditing(null)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule editor — cadence + recipients, with the human gate enforced here too.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ScheduleEditor({ pack, onSaved, onCancel }: { pack: Pack; onSaved: (p: Pack) => void; onCancel: () => void }) {
  const [cadence, setCadence] = useState<Cadence>(pack.schedule_cadence ?? 'NONE');
  const [recipientsText, setRecipientsText] = useState((pack.recipients ?? []).join(', '));
  const [saving, setSaving] = useState(false);

  // Split, dedupe (case-insensitive), and classify each entry so the user sees
  // exactly which addresses are valid before scheduling anything.
  const { valid, invalid } = useMemo(() => {
    const seen = new Set<string>();
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const raw of recipientsText.split(/[,;\s]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const lower = t.toLowerCase();
      if (EMAIL_RE.test(lower)) {
        if (!seen.has(lower)) { seen.add(lower); valid.push(lower); }
      } else {
        invalid.push(t);
      }
    }
    return { valid, invalid };
  }, [recipientsText]);

  // Mirror the server gate exactly (packs/[id] PATCH): a live schedule needs a real
  // cadence AND ≥1 valid recipient. Any invalid address blocks save so nothing is
  // scheduled against a typo.
  const wantsSchedule = cadence !== 'NONE';
  const canSave = !wantsSchedule || (valid.length > 0 && invalid.length === 0);

  // Preview the next fire date with the SAME deterministic math the server uses to
  // seed next_run_date, so the UI and the DB agree.
  const nextRun = useMemo(
    () => (wantsSchedule && canSave ? nextOccurrence(cadence, new Date().toISOString().slice(0, 10)) : null),
    [wantsSchedule, canSave, cadence],
  );

  const save = useCallback(async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const resp = await fetch(`/api/reports/packs/${pack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cadence, recipients: valid, schedule_active: wantsSchedule && valid.length > 0 }),
      });
      const j = (await resp.json()) as { pack?: Pack; error?: string };
      if (!resp.ok) throw new Error(j.error ?? 'Could not save the schedule.');
      addToast('success', cadence === 'NONE' ? 'Schedule turned off.' : `Scheduled ${cadence.toLowerCase()} delivery.`);
      if (j.pack) onSaved(j.pack);
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [pack.id, cadence, valid, wantsSchedule, canSave, saving, onSaved]);

  return (
    <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/40">
      <p className="text-[11px] font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
        <CalendarClock size={12} className="text-emerald-400" /> Recurring email delivery
      </p>
      <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
        {(['NONE', 'MONTHLY', 'QUARTERLY'] as Cadence[]).map((c) => (
          <button
            key={c}
            onClick={() => setCadence(c)}
            className={clsx(
              'px-2.5 py-1 rounded-full text-[11px] transition-colors',
              cadence === c ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700',
            )}
          >
            {c === 'NONE' ? 'Off' : c === 'MONTHLY' ? 'Monthly' : 'Quarterly'}
          </button>
        ))}
      </div>
      <input
        value={recipientsText}
        onChange={(e) => setRecipientsText(e.target.value)}
        placeholder="Recipient emails, comma-separated"
        className={clsx(
          'w-full px-3 py-1.5 bg-slate-900/60 border rounded-lg text-xs text-white placeholder:text-slate-600 focus:outline-none',
          invalid.length > 0 ? 'border-red-500/50 focus:border-red-500/70' : 'border-slate-800 focus:border-emerald-500/50',
        )}
      />

      {/* Live recipient validation */}
      {(valid.length > 0 || invalid.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {valid.map((e) => (
            <span key={e} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-[10px] text-emerald-300">
              <Check size={9} /> {e}
            </span>
          ))}
          {invalid.map((e, i) => (
            <span key={`${e}-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/10 text-[10px] text-red-300" title="Not a valid email address">
              <AlertTriangle size={9} /> {e}
            </span>
          ))}
        </div>
      )}
      {invalid.length > 0 && (
        <p className="text-[11px] text-red-400 mt-1.5">Fix or remove {invalid.length} invalid address{invalid.length === 1 ? '' : 'es'} before scheduling.</p>
      )}

      <div className="flex items-center justify-between gap-2 mt-2.5">
        <div className="min-w-0">
          <p className="text-[11px] text-slate-500">
            {cadence === 'NONE'
              ? 'Delivery is off — the pack stays available to run manually.'
              : canSave
                ? `Emails the PDF ${cadence.toLowerCase()} to ${valid.length} recipient${valid.length === 1 ? '' : 's'}.`
                : 'Add at least one valid recipient to enable delivery.'}
          </p>
          {nextRun && (
            <p className="text-[11px] text-emerald-300/80 mt-0.5 flex items-center gap-1">
              <CalendarClock size={10} /> First delivery: {fmtDate(nextRun)} ({cadenceLabel(cadence)})
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onCancel} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
            <X size={12} /> Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !canSave}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {saving ? 'Saving…' : cadence === 'NONE' ? 'Turn off delivery' : 'Save schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
