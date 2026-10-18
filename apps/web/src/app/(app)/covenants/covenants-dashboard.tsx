'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, ShieldCheck, ShieldAlert, ShieldX, Plus, RefreshCw,
  FileText, Pencil, Trash2, CalendarClock, HelpCircle, X, Sparkles,
} from 'lucide-react';
import { CovenantEditor, type EditorCovenant } from './covenant-editor';
import { CovenantParseReview } from './covenant-parse-review';

type Band = 'PASS' | 'WARN' | 'BREACH' | 'UNKNOWN';
type Unit = 'RATIO' | 'CURRENCY';

interface Evaluation {
  value: number | null;
  numeratorCents: number | null;
  denominatorCents: number | null;
  unit: Unit;
  threshold: number;
  direction: 'MIN' | 'MAX';
  passed: boolean | null;
  band: Band;
  headroomPct: number | null;
  cushion: number | null;
}

interface Components {
  ebitdaCents: number;
  debtServiceCents: number;
  totalDebtCents: number;
  netDebtCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  liquidityCents: number;
  tangibleNetWorthCents: number;
  periodStart: string;
  periodEnd: string;
}

interface Breach {
  breachDate: string | null;
  breachIndex: number;
  crossingDate: string | null;
  breachedAtStart: boolean;
}

interface Covenant {
  id: string;
  location_id: string | null;
  loan_name: string;
  facility: string | null;
  lender_name: string | null;
  covenant_type: EditorCovenant['covenant_type'];
  threshold: number | string;
  direction: 'MIN' | 'MAX';
  test_frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  warn_headroom_pct: number | string;
  measurement: EditorCovenant['measurement'];
  status: EditorCovenant['status'];
  effective_date: string | null;
  maturity_date: string | null;
  notes: string | null;
}

interface StatusEntry {
  covenant: Covenant;
  periodEnd?: string;
  evaluation?: Evaluation;
  components?: Components;
  breach?: Breach;
  error?: true;
}

interface CovenantsResponse {
  data: StatusEntry[];
  summary: { total: number; breach: number; warn: number; pass: number; unknown: number };
}

interface CertificateResult {
  narrative: string;
  meta: { source: 'ai' | 'deterministic'; model: string | null };
}

const BAND_STYLE: Record<Band, { badge: string; icon: React.ReactNode; label: string }> = {
  PASS: { badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: <ShieldCheck size={14} />, label: 'In compliance' },
  WARN: { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: <ShieldAlert size={14} />, label: 'Tight' },
  BREACH: { badge: 'bg-red-500/10 text-red-400 border-red-500/20', icon: <ShieldX size={14} />, label: 'Breach' },
  UNKNOWN: { badge: 'bg-slate-700/40 text-slate-400 border-slate-700', icon: <HelpCircle size={14} />, label: 'Not computable' },
};

function fmtValue(v: number | null, unit: Unit): string {
  if (v === null) return '—';
  return unit === 'CURRENCY' ? formatMoney(Math.round(v * 100)) : `${v.toFixed(2)}x`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Headroom bar: green cushion filling toward the threshold; red when breached. */
function HeadroomBar({ headroomPct, band }: { headroomPct: number | null; band: Band }) {
  if (headroomPct === null) return <div className="h-1.5 rounded bg-slate-800" />;
  const magnitude = Math.min(1, Math.abs(headroomPct));
  const pct = Math.round(magnitude * 100);
  const color = band === 'BREACH' ? 'bg-red-500' : band === 'WARN' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
      <div className={clsx('h-full rounded', color)} style={{ width: `${Math.max(4, pct)}%` }} />
    </div>
  );
}

export function CovenantsDashboard() {
  const [editing, setEditing] = useState<EditorCovenant | null | 'new'>(null);
  const [parsing, setParsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [refreshKey, setRefreshKey] = useState('0');
  const [cert, setCert] = useState<{ name: string; result: CertificateResult } | null>(null);
  const [certLoadingId, setCertLoadingId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<CovenantsResponse>('/api/covenants', undefined, { key: refreshKey });

  const entries = data?.data ?? [];
  const summary = data?.summary;

  async function runTests() {
    setRunning(true);
    const res = await api.post<{ tested: number; alerted: number; cleared: number }>('/api/covenants/compute', {});
    setRunning(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', `Tested ${res.data?.tested ?? 0} covenant(s) · ${res.data?.alerted ?? 0} alert(s) to Needs Attention`);
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }

  async function draftCertificate(c: Covenant) {
    setCertLoadingId(c.id);
    const res = await api.post<CertificateResult>(`/api/covenants/${c.id}/certificate`, {});
    setCertLoadingId(null);
    if (res.error || !res.data) {
      addToast('error', res.error?.error ?? 'Failed to draft certificate');
      return;
    }
    setCert({ name: c.loan_name, result: res.data });
  }

  async function remove(c: Covenant) {
    if (!confirm(`Delete covenant "${c.loan_name}"? This removes its test history.`)) return;
    const res = await api.delete(`/api/covenants/${c.id}`);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Covenant deleted');
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }

  function toEditor(c: Covenant): EditorCovenant {
    return {
      id: c.id,
      loan_name: c.loan_name,
      facility: c.facility,
      lender_name: c.lender_name,
      location_id: c.location_id,
      covenant_type: c.covenant_type,
      threshold: Number(c.threshold),
      direction: c.direction,
      test_frequency: c.test_frequency,
      warn_headroom_pct: Number(c.warn_headroom_pct),
      status: c.status,
      effective_date: c.effective_date,
      maturity_date: c.maturity_date,
      notes: c.notes,
      measurement: c.measurement,
    };
  }

  const Controls = (
    <div className="flex items-center gap-2">
      <button
        onClick={runTests}
        disabled={running || entries.length === 0}
        className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg disabled:opacity-40 flex items-center gap-1.5"
      >
        {running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        Run covenant test
      </button>
      <button
        onClick={() => setParsing(true)}
        className="px-3 py-1.5 text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1.5"
      >
        <Sparkles size={13} /> Upload loan document
      </button>
      <button
        onClick={() => setEditing('new')}
        className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5"
      >
        <Plus size={13} /> Add covenant
      </button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          {summary && (
            <>
              <span className="text-slate-500">{summary.total} covenant{summary.total === 1 ? '' : 's'}</span>
              {summary.breach > 0 && <span className="text-red-400 font-medium">{summary.breach} breach</span>}
              {summary.warn > 0 && <span className="text-amber-400 font-medium">{summary.warn} tight</span>}
              {summary.pass > 0 && <span className="text-emerald-400">{summary.pass} compliant</span>}
              {summary.unknown > 0 && <span className="text-slate-500">{summary.unknown} n/a</span>}
            </>
          )}
        </div>
        {Controls}
      </div>

      {entries.length === 0 ? (
        <div className="card p-12 text-center">
          <ShieldCheck className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">No covenants defined</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Drop in a credit agreement and AI extracts the covenants — DSCR, FCCR, leverage, current
            ratio, minimum liquidity, tangible net worth — for you to review and confirm. MeritBooks then
            computes current headroom from the ledger and projects the breach date off your cash forecast.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setParsing(true)} className="px-4 py-2 text-sm font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg inline-flex items-center gap-1.5">
              <Sparkles size={14} /> Upload loan document
            </button>
            <button onClick={() => setEditing('new')} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5">
              <Plus size={14} /> Add manually
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {entries.map((entry) => {
            const c = entry.covenant;
            const e = entry.evaluation;
            const band: Band = entry.error || !e ? 'UNKNOWN' : e.band;
            const style = BAND_STYLE[band];
            const projected = entry.breach?.crossingDate ?? entry.breach?.breachDate ?? null;

            return (
              <div key={c.id} className={clsx('card p-4 border', band === 'BREACH' ? 'border-red-500/30' : band === 'WARN' ? 'border-amber-500/25' : 'border-slate-800')}>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{c.loan_name}</p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {c.facility ? `${c.facility} · ` : ''}{c.lender_name ?? 'No lender'} · {c.test_frequency.toLowerCase()}
                    </p>
                  </div>
                  <span className={clsx('shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium', style.badge)}>
                    {style.icon} {style.label}
                  </span>
                </div>

                <div className="flex items-end justify-between mb-1">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                      {c.covenant_type} · {c.direction === 'MIN' ? 'min' : 'max'} {fmtValue(Number(c.threshold), e?.unit ?? 'RATIO')}
                    </p>
                    <p className={clsx('text-2xl font-mono font-semibold mt-0.5', band === 'BREACH' ? 'text-red-400' : band === 'WARN' ? 'text-amber-300' : band === 'UNKNOWN' ? 'text-slate-500' : 'text-white')}>
                      {fmtValue(e?.value ?? null, e?.unit ?? 'RATIO')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Headroom</p>
                    <p className={clsx('text-sm font-mono', band === 'BREACH' ? 'text-red-400' : 'text-slate-300')}>
                      {e?.headroomPct === null || e?.headroomPct === undefined ? '—' : `${(e.headroomPct * 100).toFixed(1)}%`}
                    </p>
                  </div>
                </div>
                <HeadroomBar headroomPct={e?.headroomPct ?? null} band={band} />

                {/* Projected breach */}
                <div className="mt-3 flex items-center gap-1.5 text-[11px]">
                  <CalendarClock size={12} className={projected ? 'text-red-400' : 'text-slate-600'} />
                  {projected ? (
                    <span className="text-red-300">Projected breach {fmtDate(projected)}</span>
                  ) : (
                    <span className="text-slate-500">No breach projected in forecast horizon</span>
                  )}
                </div>

                {/* Drivers */}
                {entry.components && (
                  <div className="mt-3 pt-3 border-t border-slate-800/60 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                    <Driver label="EBITDA (TTM)" value={formatMoney(entry.components.ebitdaCents)} />
                    <Driver label="Debt service" value={formatMoney(entry.components.debtServiceCents)} />
                    <Driver label="Net debt" value={formatMoney(entry.components.netDebtCents)} />
                    <Driver label="Liquidity" value={formatMoney(entry.components.liquidityCents)} />
                  </div>
                )}

                <div className="mt-3 flex items-center gap-1.5">
                  <button
                    onClick={() => draftCertificate(c)}
                    disabled={certLoadingId === c.id}
                    className="px-2.5 py-1 text-[11px] font-medium bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 rounded-md flex items-center gap-1 disabled:opacity-50"
                  >
                    {certLoadingId === c.id ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                    Draft certificate
                  </button>
                  <button onClick={() => setEditing(toEditor(c))} className="px-2 py-1 text-[11px] text-slate-400 hover:text-white rounded-md hover:bg-slate-800 flex items-center gap-1">
                    <Pencil size={11} /> Edit
                  </button>
                  <button onClick={() => remove(c)} className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-400 rounded-md hover:bg-slate-800 flex items-center gap-1">
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Methodology note */}
      <p className="text-[11px] text-slate-600 leading-relaxed">
        Ratios are computed deterministically from the general ledger (EBITDA, debt service, debt, current
        assets/liabilities, liquidity, tangible net worth — resolved by account role/type). The projected
        breach date walks the 13-week cash-forecast trajectory to the first period the ratio crosses its
        threshold. AI is used only to phrase the compliance-certificate narrative — never to compute a number.
      </p>

      {parsing && (
        <CovenantParseReview
          onClose={() => setParsing(false)}
          onConfirmed={() => {
            setParsing(false);
            setRefreshKey((k) => String(Number(k) + 1));
            refetch();
          }}
        />
      )}

      {editing && (
        <CovenantEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRefreshKey((k) => String(Number(k) + 1));
            refetch();
          }}
        />
      )}

      {cert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setCert(null)}>
          <div className="card w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Compliance certificate — draft</h2>
                <p className="text-[11px] text-slate-500">
                  {cert.name} · {cert.result.meta.source === 'ai' ? `drafted by ${cert.result.meta.model ?? 'AI'}` : 'deterministic template'} · human sign-off required
                </p>
              </div>
              <button onClick={() => setCert(null)} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-sm text-slate-300 leading-relaxed font-sans bg-slate-950/60 rounded-lg p-4 border border-slate-800">
              {cert.result.narrative}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => { navigator.clipboard?.writeText(cert.result.narrative); addToast('success', 'Copied'); }}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-lg"
              >
                Copy
              </button>
              <button onClick={() => setCert(null)} className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Driver({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-300 font-mono">{value}</span>
    </div>
  );
}
