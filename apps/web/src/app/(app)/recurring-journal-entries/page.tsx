'use client';

import { useState, useCallback } from 'react';
import {
  Repeat, Plus, Loader2, AlertCircle, Clock, Check, Pause, Play, X,
  CalendarClock, Pencil, Ban, Send, ChevronRight, Layers,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { PageHeader } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { RecurringJeBuilder, type ExistingTemplate } from './recurring-je-builder';

// ─── Types (mirror the store's TemplateSummary / ProposedRunDetail) ─────────

interface TemplateRow {
  id: string;
  name: string;
  location_id: string;
  cadence: 'MONTHLY' | 'QUARTERLY';
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  line_count: number;
  amount_per_period_cents: number;
  periods_generated: number;
  last_period: string | null;
  next_period: string | null;
  next_post_date: string | null;
  pending_count: number;
  lines: ExistingTemplate['lines'];
}
interface TemplatesResponse {
  data: TemplateRow[];
  summary: { total: number; active: number; pending: number };
}

interface ProposedRun {
  id: string;
  template_id: string;
  template_name: string;
  period: string;
  entry_date: string;
  amount_cents: number;
  lines: { account_id: string; debit_cents: number; credit_cents: number }[];
}
interface RunsResponse {
  data: ProposedRun[];
  summary: { total: number; amount_cents: number };
}

const CADENCE_LABEL: Record<string, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly' };

const STATUS_STYLE: Record<string, { label: string; cls: string; icon: typeof Check }> = {
  ACTIVE: { label: 'Active', cls: 'bg-emerald-500/10 text-emerald-400', icon: Check },
  PAUSED: { label: 'Paused', cls: 'bg-slate-500/10 text-slate-400', icon: Pause },
  COMPLETED: { label: 'Completed', cls: 'bg-blue-500/10 text-blue-400', icon: Check },
  CANCELLED: { label: 'Cancelled', cls: 'bg-red-500/10 text-red-400', icon: Ban },
};

export default function RecurringJournalEntriesPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const {
    data: tData,
    isLoading: tLoading,
    error: tError,
  } = useQuery<TemplatesResponse>('/api/recurring-journal-entries', undefined, { key: String(refreshKey) });
  const {
    data: rData,
    isLoading: rLoading,
    error: rError,
  } = useQuery<RunsResponse>('/api/recurring-journal-entries/runs', undefined, { key: String(refreshKey) });

  const templates = tData?.data ?? [];
  const runs = rData?.data ?? [];
  const summary = tData?.summary;

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<ExistingTemplate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);

  const openNew = () => { setEditing(null); setBuilderOpen(true); };
  const openEdit = (t: TemplateRow) => {
    setEditing({
      id: t.id, name: t.name, location_id: t.location_id, cadence: t.cadence,
      start_date: t.start_date, end_date: t.end_date, entry_type: t.entry_type,
      memo: t.memo, lines: t.lines,
    });
    setBuilderOpen(true);
  };

  async function generateDue() {
    setGenerating(true);
    const res = await api.post<{ result: { proposed: unknown[]; skipped_existing: number; errors: unknown[] } }>(
      '/api/recurring-journal-entries/generate',
      {},
    );
    setGenerating(false);
    if (res.error) { addToast('error', res.error.error || 'Generate failed'); return; }
    const r = res.data?.result;
    const proposed = r?.proposed.length ?? 0;
    if (proposed === 0) addToast('info', 'No new entries due — everything is already proposed or posted');
    else addToast('success', `Proposed ${proposed} entr${proposed === 1 ? 'y' : 'ies'} for review`);
    if ((r?.errors.length ?? 0) > 0) addToast('error', `${r?.errors.length} template(s) had issues`);
    bump();
  }

  async function setStatus(t: TemplateRow, status: 'ACTIVE' | 'PAUSED') {
    setBusyTemplate(t.id);
    const res = await api.patch(`/api/recurring-journal-entries/${t.id}`, { status });
    setBusyTemplate(null);
    if (res.error) { addToast('error', res.error.error || 'Update failed'); return; }
    addToast('success', status === 'PAUSED' ? 'Template paused' : 'Template resumed');
    bump();
  }

  async function cancelTemplate(t: TemplateRow) {
    if (!confirm(`Cancel "${t.name}"? Posted periods stay; no future entries will be proposed.`)) return;
    setBusyTemplate(t.id);
    const res = await api.delete(`/api/recurring-journal-entries/${t.id}`);
    setBusyTemplate(null);
    if (res.error) { addToast('error', res.error.error || 'Cancel failed'); return; }
    addToast('success', 'Template cancelled');
    bump();
  }

  async function reviewRun(run: ProposedRun, action: 'approve' | 'reject') {
    if (action === 'reject' && !confirm(`Skip the ${run.period} entry for "${run.template_name}"? It won't be re-proposed.`)) return;
    setBusyRun(run.id);
    const res = await api.post<{ entry_number?: string }>('/api/recurring-journal-entries/approve', {
      run_id: run.id, action,
    });
    setBusyRun(null);
    if (res.error) { addToast('error', res.error.error || 'Action failed'); return; }
    if (action === 'approve') addToast('success', `Posted ${res.data?.entry_number ?? 'entry'} to the GL`);
    else addToast('info', 'Entry skipped');
    bump();
  }

  const errorAll = tError && rError;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring Journal Entries"
        description={
          summary
            ? `${summary.active} active · ${summary.total} template${summary.total === 1 ? '' : 's'} · ${runs.length} awaiting approval`
            : 'Scheduled entries that post a balanced journal each period'
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button" onClick={generateDue} disabled={generating}
              className={clsx('flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border',
                generating ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700')}
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />}
              Generate due
            </button>
            <button
              type="button" onClick={openNew}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <Plus size={14} /> New template
            </button>
          </div>
        }
      />

      {errorAll && (
        <div className="card p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400 text-sm">{tError || rError}</p>
        </div>
      )}

      {/* ── Review & post queue ─────────────────────────────────────────── */}
      {!rLoading && runs.length > 0 && (
        <div className="card overflow-hidden border-amber-500/25">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-amber-500/[0.04]">
            <div className="flex items-center gap-2">
              <Send size={15} className="text-amber-400" />
              <h2 className="text-sm font-semibold text-white">Awaiting approval</h2>
              <span className="text-xs text-slate-500">{runs.length} entr{runs.length === 1 ? 'y' : 'ies'} · {formatMoney(rData?.summary.amount_cents ?? 0)}</span>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/20">
                <th className="px-5 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Template</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Period</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Post date</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Lines</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Amount</th>
                <th className="px-5 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-slate-800/20">
                  <td className="px-5 py-3 text-white">{run.template_name}</td>
                  <td className="px-4 py-3 text-center text-xs font-mono text-slate-300">{run.period}</td>
                  <td className="px-4 py-3 text-center text-xs font-mono text-slate-400">{run.entry_date}</td>
                  <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">{run.lines.length}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono text-white">{formatMoney(run.amount_cents)}</td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button" onClick={() => reviewRun(run, 'reject')} disabled={busyRun === run.id}
                        className="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Skip
                      </button>
                      <button
                        type="button" onClick={() => reviewRun(run, 'approve')} disabled={busyRun === run.id}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {busyRun === run.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        Approve &amp; post
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Templates ───────────────────────────────────────────────────── */}
      {tLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : templates.length === 0 && !tError ? (
        <div className="card p-12 text-center">
          <Repeat className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-400">No recurring journal entries yet.</p>
          <p className="text-xs text-slate-600 mt-1 max-w-md mx-auto">
            Create a template for a fixed accrual (rent, insurance, depreciation) or a straight-line
            allocation across departments. Each period generates a balanced entry you approve before it posts.
          </p>
          <button
            type="button" onClick={openNew}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <Plus size={14} /> New template
          </button>
        </div>
      ) : templates.length > 0 ? (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-5 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Template</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Cadence</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Per period</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Lines</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Next run</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
                <th className="px-5 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {templates.map((t) => {
                const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.ACTIVE;
                const StIcon = st.icon;
                const busy = busyTemplate === t.id;
                return (
                  <tr key={t.id} className="hover:bg-slate-800/20">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-white font-medium">{t.name}</p>
                        {t.pending_count > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400">
                            <Clock size={9} /> {t.pending_count} pending
                          </span>
                        )}
                      </div>
                      {t.memo && <p className="text-xs text-slate-500 truncate max-w-[280px]">{t.memo}</p>}
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-slate-400">{CADENCE_LABEL[t.cadence] ?? t.cadence}</td>
                    <td className="px-4 py-3 text-right text-sm font-mono text-white">{formatMoney(t.amount_per_period_cents)}</td>
                    <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">{t.line_count}</td>
                    <td className="px-4 py-3 text-center">
                      {t.next_post_date ? (
                        <span className="text-xs font-mono text-slate-300">{t.next_post_date}</span>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', st.cls)}>
                        <StIcon size={9} /> {st.label}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {(t.status === 'ACTIVE' || t.status === 'PAUSED') && (
                          <>
                            <button
                              type="button" onClick={() => openEdit(t)} disabled={busy}
                              title="Edit" className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 disabled:opacity-40"
                            >
                              <Pencil size={14} />
                            </button>
                            {t.status === 'ACTIVE' ? (
                              <button
                                type="button" onClick={() => setStatus(t, 'PAUSED')} disabled={busy}
                                title="Pause" className="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-slate-800 disabled:opacity-40"
                              >
                                <Pause size={14} />
                              </button>
                            ) : (
                              <button
                                type="button" onClick={() => setStatus(t, 'ACTIVE')} disabled={busy}
                                title="Resume" className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-400 hover:bg-slate-800 disabled:opacity-40"
                              >
                                <Play size={14} />
                              </button>
                            )}
                            <button
                              type="button" onClick={() => cancelTemplate(t)} disabled={busy}
                              title="Cancel" className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-800 disabled:opacity-40"
                            >
                              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ── How it works (empty-state helper for populated screens) ─────── */}
      {templates.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-slate-900/60 border border-slate-800">
          <Layers size={14} className="text-indigo-400 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-500">
            <span className="text-slate-400">Generate due</span> stages a balanced entry for each period that has come due
            <ChevronRight size={11} className="inline mx-0.5 text-slate-600" />
            it lands in <span className="text-slate-400">Awaiting approval</span>
            <ChevronRight size={11} className="inline mx-0.5 text-slate-600" />
            you review and <span className="text-slate-400">Approve &amp; post</span> it to the GL. Nothing posts automatically.
          </p>
        </div>
      )}

      {builderOpen && (
        <RecurringJeBuilder
          existing={editing}
          onClose={() => setBuilderOpen(false)}
          onSaved={() => { setBuilderOpen(false); bump(); }}
        />
      )}
    </div>
  );
}
