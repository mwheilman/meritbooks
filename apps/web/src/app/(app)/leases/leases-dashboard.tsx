'use client';

import { useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, Building2, Plus, RefreshCw, Trash2, ChevronDown, ChevronRight,
  PlayCircle, FileText, CheckCircle2, Pencil, TrendingUp, XCircle,
} from 'lucide-react';
import { LeaseParseReview } from './lease-parse-review';
import { LeaseRemeasureModal, type RemeasureMode } from './lease-remeasure-modal';

interface Lease {
  id: string;
  location_id: string;
  lessor: string;
  description: string | null;
  classification: 'OPERATING' | 'FINANCE';
  commencement_date: string;
  end_date: string;
  payment_cents: number;
  payment_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  payment_timing: 'ARREARS' | 'ADVANCE';
  term_months: number;
  discount_rate: number | string;
  rou_asset_cents: number;
  liability_cents: number;
  status: 'ACTIVE' | 'ENDED' | 'TERMINATED';
  periods_posted: number;
  notes: string | null;
}

interface ScheduleLine {
  id: string;
  period: number;
  period_date: string;
  payment_cents: number;
  interest_cents: number;
  principal_reduction_cents: number;
  liability_balance_cents: number;
  rou_amortization_cents: number;
  rou_balance_cents: number;
  lease_expense_cents: number;
  gl_entry_id: string | null;
  posted_at: string | null;
}

interface ListResponse {
  data: Lease[];
  summary: { total: number; active: number; ended: number };
}

interface DetailResponse {
  data: { lease: Lease; schedule: ScheduleLine[] };
}

const FREQ_LABEL: Record<Lease['payment_frequency'], string> = {
  MONTHLY: '/mo', QUARTERLY: '/qtr', ANNUAL: '/yr',
};

function periodsFor(lease: Lease): number {
  const per = lease.payment_frequency === 'MONTHLY' ? 1 : lease.payment_frequency === 'QUARTERLY' ? 3 : 12;
  return Math.max(1, Math.round(lease.term_months / per));
}

export function LeasesDashboard() {
  const { data, isLoading, error, refetch } = useQuery<ListResponse>('/api/leases');
  const [showUpload, setShowUpload] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, DetailResponse['data']>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [remeasure, setRemeasure] = useState<{ lease: Lease; mode: RemeasureMode } | null>(null);

  const leases = data?.data ?? [];
  const summary = data?.summary ?? { total: 0, active: 0, ended: 0 };
  const totalRou = leases.reduce((s, l) => s + Number(l.rou_asset_cents), 0);
  const totalLiab = leases.reduce((s, l) => s + Number(l.liability_cents), 0);

  const loadDetail = useCallback(async (id: string) => {
    const res = await api.get<DetailResponse>(`/api/leases/${id}`);
    if (!res.error && res.data) setDetail((d) => ({ ...d, [id]: res.data!.data }));
  }, []);

  function toggle(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!detail[id]) void loadDetail(id);
  }

  async function recordPeriod(id: string) {
    setBusy(id);
    const res = await api.post<{ posted: boolean; message: string }>(`/api/leases/${id}/record-period`, {});
    setBusy(null);
    if (res.error) { addToast('error', res.error.error || 'Failed to record the period.'); return; }
    const body = res.data;
    if (body && !body.posted) { addToast('info', body.message); }
    else { addToast('success', body?.message ?? 'Lease period recorded.'); }
    await refetch();
    await loadDetail(id);
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this lease and its schedule? This cannot be undone.')) return;
    const res = await api.delete(`/api/leases/${id}`);
    if (res.error) { addToast('error', res.error.error || 'Could not delete the lease.'); return; }
    addToast('success', 'Lease deleted.');
    if (expanded === id) setExpanded(null);
    await refetch();
  }

  return (
    <div className="space-y-6">
      {/* ── Metrics + action ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-stretch justify-between gap-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1 min-w-[320px]">
          <Metric label="Leases" value={String(summary.total)} sub={`${summary.active} active`} />
          <Metric label="ROU assets" value={formatMoney(totalRou, { compact: true })} />
          <Metric label="Lease liabilities" value={formatMoney(totalLiab, { compact: true })} />
          <Metric label="Fully recognized" value={String(summary.ended)} />
        </div>
        <div className="flex items-start gap-2">
          <button onClick={() => refetch()} className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600" title="Refresh" aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
          <button onClick={() => setShowUpload(true)} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-2">
            <Plus size={16} /> Upload lease
          </button>
        </div>
      </div>

      {/* ── States ───────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="card p-12 flex items-center justify-center text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading leases…
        </div>
      ) : error ? (
        <div className="card p-6 flex items-start gap-2 text-red-300">
          <AlertCircle size={16} className="mt-0.5" /> {error}
        </div>
      ) : leases.length === 0 ? (
        <div className="card p-12 text-center">
          <Building2 className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 font-medium">No leases yet</p>
          <p className="text-[12px] text-slate-500 mt-1 max-w-sm mx-auto">
            Drop a lease agreement — the AI extracts the terms, and after you confirm, MeritBooks sets up the ROU asset, the lease liability, and the full ASC 842 schedule.
          </p>
          <button onClick={() => setShowUpload(true)} className="mt-4 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-2">
            <Plus size={16} /> Upload your first lease
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {leases.map((l) => {
            const periods = periodsFor(l);
            const isOpen = expanded === l.id;
            const d = detail[l.id];
            return (
              <div key={l.id} className="card overflow-hidden">
                <div className="p-4 flex flex-wrap items-center gap-4">
                  <button onClick={() => toggle(l.id)} className="text-slate-500 hover:text-white" aria-label="Toggle schedule">
                    {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  </button>
                  <div className="min-w-[180px] flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{l.lessor}</span>
                      <ClassBadge c={l.classification} />
                      <StatusBadge s={l.status} />
                    </div>
                    <p className="text-[11px] text-slate-500 truncate">{l.description || 'Lease'}</p>
                  </div>
                  <Field label="Payment" value={`${formatMoney(Number(l.payment_cents))}${FREQ_LABEL[l.payment_frequency]}`} />
                  <Field label="ROU asset" value={formatMoney(Number(l.rou_asset_cents))} mono />
                  <Field label="Liability" value={formatMoney(Number(l.liability_cents))} mono />
                  <Field label="Recognized" value={`${l.periods_posted} / ${periods}`} />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => recordPeriod(l.id)}
                      disabled={busy === l.id || l.status !== 'ACTIVE'}
                      className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5"
                      title={l.status !== 'ACTIVE' ? 'Fully recognized' : 'Post the next period to the GL'}
                    >
                      {busy === l.id ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                      Record this month
                    </button>
                    <button
                      onClick={() => setRemeasure({ lease: l, mode: 'modify' })}
                      disabled={l.status !== 'ACTIVE'}
                      className="p-1.5 rounded-md text-slate-500 hover:text-emerald-400 hover:bg-slate-800 disabled:opacity-40"
                      aria-label="Modify lease" title="Modify lease"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setRemeasure({ lease: l, mode: 'cpi' })}
                      disabled={l.status !== 'ACTIVE'}
                      className="p-1.5 rounded-md text-slate-500 hover:text-blue-400 hover:bg-slate-800 disabled:opacity-40"
                      aria-label="Apply CPI or rate reset" title="Apply CPI / rate reset"
                    >
                      <TrendingUp size={14} />
                    </button>
                    <button
                      onClick={() => setRemeasure({ lease: l, mode: 'terminate' })}
                      disabled={l.status !== 'ACTIVE'}
                      className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-slate-800 disabled:opacity-40"
                      aria-label="Terminate lease" title="Terminate lease"
                    >
                      <XCircle size={14} />
                    </button>
                    <button onClick={() => remove(l.id)} className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Delete lease" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-slate-800 bg-slate-950/40 p-4">
                    {!d ? (
                      <div className="flex items-center gap-2 text-xs text-slate-500 py-4"><Loader2 size={14} className="animate-spin" /> Loading schedule…</div>
                    ) : d.schedule.length === 0 ? (
                      <p className="text-xs text-slate-500 py-2">No schedule lines.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="text-slate-500 text-left border-b border-slate-800">
                              <th className="py-1.5 pr-3 font-medium">#</th>
                              <th className="py-1.5 pr-3 font-medium">Date</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Payment</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Interest</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Principal</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Liability bal.</th>
                              <th className="py-1.5 pr-3 font-medium text-right">
                                {l.classification === 'OPERATING' ? 'Lease exp.' : 'Amort.'}
                              </th>
                              <th className="py-1.5 pr-3 font-medium text-right">ROU bal.</th>
                              <th className="py-1.5 pr-3 font-medium">GL</th>
                            </tr>
                          </thead>
                          <tbody className="font-mono">
                            {d.schedule.map((s) => (
                              <tr key={s.id} className={clsx('border-b border-slate-900', s.gl_entry_id && 'text-slate-500')}>
                                <td className="py-1.5 pr-3">{s.period}</td>
                                <td className="py-1.5 pr-3">{s.period_date}</td>
                                <td className="py-1.5 pr-3 text-right">{formatMoney(Number(s.payment_cents))}</td>
                                <td className="py-1.5 pr-3 text-right">{formatMoney(Number(s.interest_cents))}</td>
                                <td className="py-1.5 pr-3 text-right">{formatMoney(Number(s.principal_reduction_cents))}</td>
                                <td className="py-1.5 pr-3 text-right">{formatMoney(Number(s.liability_balance_cents))}</td>
                                <td className="py-1.5 pr-3 text-right">
                                  {formatMoney(Number(l.classification === 'OPERATING' ? s.lease_expense_cents : s.rou_amortization_cents))}
                                </td>
                                <td className="py-1.5 pr-3 text-right">{formatMoney(Number(s.rou_balance_cents))}</td>
                                <td className="py-1.5 pr-3">
                                  {s.gl_entry_id ? (
                                    <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> posted</span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-slate-600"><FileText size={12} /> pending</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showUpload && (
        <LeaseParseReview
          onClose={() => setShowUpload(false)}
          onCreated={() => { setShowUpload(false); void refetch(); }}
        />
      )}

      {remeasure && (
        <LeaseRemeasureModal
          lease={remeasure.lease}
          mode={remeasure.mode}
          onClose={() => setRemeasure(null)}
          onDone={async () => {
            const id = remeasure.lease.id;
            setRemeasure(null);
            await refetch();
            await loadDetail(id);
          }}
        />
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-white mt-0.5 font-mono">{value}</p>
      {sub && <p className="text-[10px] text-slate-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-[90px]">
      <p className="text-[10px] text-slate-600">{label}</p>
      <p className={clsx('text-xs text-slate-200', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

function ClassBadge({ c }: { c: Lease['classification'] }) {
  return (
    <span className={clsx(
      'px-1.5 py-0.5 rounded text-[10px] font-medium border',
      c === 'OPERATING'
        ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
        : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    )}>
      {c === 'OPERATING' ? 'Operating' : 'Finance'}
    </span>
  );
}

function StatusBadge({ s }: { s: Lease['status'] }) {
  const map: Record<Lease['status'], string> = {
    ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    ENDED: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    TERMINATED: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  return <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium border', map[s])}>{s.toLowerCase()}</span>;
}
