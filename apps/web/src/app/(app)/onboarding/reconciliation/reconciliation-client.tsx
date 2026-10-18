'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Loader2, AlertTriangle, Check, X, Scale, Download, ShieldCheck, ListChecks,
} from 'lucide-react';
import { formatMoney, centsToDollars } from '@meritbooks/shared';
import { downloadBlob } from '@/lib/reports/export/csv';

interface ReconLine {
  key: string; label: string;
  sourceCents: number; meritCents: number; varianceCents: number; ties: boolean;
}
interface ReconSection {
  key: string; label: string; applicable: boolean; note?: string;
  lines: ReconLine[];
  sourceTotalCents: number; meritTotalCents: number; varianceCents: number; ties: boolean;
}
interface Report {
  sections: ReconSection[]; ties: boolean; totalAbsVarianceCents: number; generatedAt: string;
}
interface InternalTie {
  key: string; label: string; controlRole: string;
  subledgerCents: number; controlCents: number; varianceCents: number; ties: boolean;
}
interface ReconResponse {
  sessionId: string; companyShortCode: string; asOfDate: string; posted: boolean;
  report: Report; internalTies: InternalTie[];
  varianceBlockers: string[]; internalTieBlockers: string[]; ready: boolean;
}
interface SessionListItem {
  id: string; status: string; companyShortCode: string; asOfDate: string;
  balanced: boolean; tiedOut: boolean; posted: boolean; createdAt: string;
}

export default function ReconciliationClient() {
  const [sessionId, setSessionId] = useState<string>('');
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [data, setData] = useState<ReconResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Pick up ?sessionId= from the URL (linked from the conversion "done" screen).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('sessionId');
    if (id) setSessionId(id);
  }, []);

  // Load the list of conversion sessions so the user can pick one.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/onboarding/conversion')
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => { if (!cancelled) setSessions(Array.isArray(d.sessions) ? d.sessions : []); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true); setError(''); setData(null);
    try {
      const r = await fetch(`/api/onboarding/reconciliation?sessionId=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Could not load the reconciliation');
      setData(j as ReconResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (sessionId) void load(sessionId); }, [sessionId, load]);

  const onExport = useCallback(() => {
    if (!data) return;
    const csv = toReconciliationCsv(data);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `conversion-reconciliation-${data.companyShortCode}-${data.asOfDate}.csv`);
  }, [data]);

  return (
    <div className="max-w-4xl mx-auto pb-16">
      {/* Session picker */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-slate-400 mb-1">Conversion session</label>
        <select
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white"
        >
          <option value="">Select a conversion to reconcile…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.companyShortCode} · as of {s.asOfDate} · {s.posted ? 'posted' : s.tiedOut ? 'tied out' : 'draft'}
            </option>
          ))}
        </select>
        {sessions.length === 0 && (
          <p className="text-2xs text-slate-500 mt-1">No conversions found yet — run a Historical Conversion first.</p>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-10 justify-center">
          <Loader2 size={16} className="animate-spin" /> Reconciling MeritBooks to your source books…
        </div>
      )}

      {!loading && !data && !error && sessionId === '' && (
        <div className="rounded-xl border border-slate-800 bg-surface-900/60 px-6 py-12 text-center">
          <Scale size={26} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm text-slate-300">Pick a conversion above to see MeritBooks vs. your source books.</p>
        </div>
      )}

      {!loading && data && <ReportView data={data} onExport={onExport} />}
    </div>
  );
}

function ReportView({ data, onExport }: { data: ReconResponse; onExport: () => void }) {
  const { report } = data;
  return (
    <div>
      {/* Verdict banner */}
      {data.ready ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          <ShieldCheck size={18} />
          <span>Reconciled to the penny — every section ties and the subledgers foot to their controls. Cleared to go live.</span>
        </div>
      ) : (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>
            {report.totalAbsVarianceCents > 0
              ? <>Off by <span className="font-mono font-semibold">{formatMoney(report.totalAbsVarianceCents)}</span> across sections. Every variance must be zero before go-live.</>
              : 'A subledger does not foot to its control account. Resolve it before go-live.'}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-slate-500">
          <span className="text-slate-300 font-medium">{data.companyShortCode}</span> · opening as of{' '}
          <span className="font-mono text-slate-300">{data.asOfDate}</span>
          {data.posted ? <span className="ml-2 rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 text-2xs">GL live</span>
            : <span className="ml-2 rounded bg-slate-700/50 text-slate-300 px-1.5 py-0.5 text-2xs">not yet posted</span>}
        </div>
        <button
          onClick={onExport}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.03] transition-colors"
        >
          <Download size={13} /> Export CSV
        </button>
      </div>

      {report.sections.map((s) => <SectionCard key={s.key} section={s} />)}

      {/* Live subledger → control integrity ties */}
      <div className="mt-5 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks size={15} className="text-brand-400" />
          <p className="text-sm font-semibold text-white">Subledger ties to control (live)</p>
        </div>
        <p className="text-2xs text-slate-500 mb-2">Each subledger detail must foot to its GL control account — a hard go-live check.</p>
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
                <th className="text-left font-medium px-3 py-2">Subledger</th>
                <th className="text-right font-medium px-3 py-2">Detail</th>
                <th className="text-right font-medium px-3 py-2">Control</th>
                <th className="text-right font-medium px-3 py-2">Variance</th>
                <th className="text-center font-medium px-3 py-2">Ties</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.internalTies.map((t) => (
                <tr key={t.key} className="bg-surface-900">
                  <td className="px-3 py-1.5 text-slate-200">{t.label} <span className="text-2xs text-slate-500">({t.controlRole})</span></td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-300">{formatMoney(t.subledgerCents)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-300">{formatMoney(t.controlCents)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${t.ties ? 'text-slate-600' : 'text-rose-300 font-semibold'}`}>{formatMoney(t.varianceCents)}</td>
                  <td className="px-3 py-1.5 text-center">{t.ties ? <Check size={14} className="inline text-emerald-400" /> : <X size={14} className="inline text-rose-400" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ section }: { section: ReconSection }) {
  const neutral = !section.applicable;
  return (
    <div className={`mt-4 rounded-xl border overflow-hidden ${neutral ? 'border-slate-800 bg-surface-900/50' : section.ties ? 'border-emerald-500/25 bg-surface-900' : 'border-amber-500/30 bg-surface-900'}`}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
        <div className="flex items-center gap-2">
          {neutral
            ? <span className="text-2xs rounded bg-slate-700/50 text-slate-400 px-1.5 py-0.5">n/a</span>
            : section.ties
              ? <Check size={16} className="text-emerald-400" />
              : <AlertTriangle size={15} className="text-amber-400" />}
          <p className="text-sm font-semibold text-white">{section.label}</p>
        </div>
        {!neutral && (
          <span className={`text-xs font-mono ${section.ties ? 'text-emerald-300' : 'text-amber-300'}`}>
            {section.ties ? 'variance 0' : `off ${formatMoney(Math.abs(section.varianceCents))}`}
          </span>
        )}
      </div>
      {section.note && <p className="px-4 py-2 text-2xs text-slate-500">{section.note}</p>}
      {section.lines.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              <th className="text-left font-medium px-3 py-2">Line</th>
              <th className="text-right font-medium px-3 py-2">Source</th>
              <th className="text-right font-medium px-3 py-2">MeritBooks</th>
              <th className="text-right font-medium px-3 py-2">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {section.lines.map((l) => (
              <tr key={l.key} className="bg-surface-900">
                <td className="px-3 py-1.5 text-slate-200">{l.label}</td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-300">{formatMoney(l.sourceCents)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-300">{formatMoney(l.meritCents)}</td>
                <td className={`px-3 py-1.5 text-right font-mono ${l.ties ? 'text-slate-600' : 'text-rose-300 font-semibold'}`}>
                  {l.ties ? '—' : formatMoney(l.varianceCents)}
                </td>
              </tr>
            ))}
          </tbody>
          {!neutral && (
            <tfoot>
              <tr className="bg-surface-950 border-t border-slate-700 text-sm font-semibold">
                <td className="px-3 py-2 text-slate-300">Total</td>
                <td className="px-3 py-2 text-right font-mono text-slate-200">{formatMoney(section.sourceTotalCents)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-200">{formatMoney(section.meritTotalCents)}</td>
                <td className={`px-3 py-2 text-right font-mono ${section.ties ? 'text-emerald-300' : 'text-rose-300'}`}>{formatMoney(section.varianceCents)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </div>
  );
}

/** Build a CSV (numeric dollar cells) of the reconciliation — reuses downloadBlob. */
function toReconciliationCsv(data: ReconResponse): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (cells: (string | number)[]) => cells.map((c) => (typeof c === 'number' ? String(c) : esc(c))).join(',');
  const out: string[] = [];
  out.push(line([`Conversion Reconciliation — ${data.companyShortCode}`]));
  out.push(line([`Opening as of ${data.asOfDate}`]));
  out.push(line([`Generated ${new Date(data.report.generatedAt).toLocaleString('en-US')}`]));
  out.push(line([data.ready ? 'READY — reconciled to the penny' : 'NOT READY — variances remain']));
  out.push('');
  out.push(line(['Section', 'Line', 'Source', 'MeritBooks', 'Variance', 'Ties']));
  for (const s of data.report.sections) {
    for (const l of s.lines) {
      out.push(line([s.label, l.label, centsToDollars(l.sourceCents), centsToDollars(l.meritCents), centsToDollars(l.varianceCents), l.ties ? 'Y' : 'N']));
    }
    if (s.applicable) {
      out.push(line([s.label, 'TOTAL', centsToDollars(s.sourceTotalCents), centsToDollars(s.meritTotalCents), centsToDollars(s.varianceCents), s.ties ? 'Y' : 'N']));
    }
    out.push('');
  }
  out.push(line(['Subledger ties to control (live)']));
  out.push(line(['Subledger', 'Control role', 'Detail', 'Control', 'Variance', 'Ties']));
  for (const t of data.internalTies) {
    out.push(line([t.label, t.controlRole, centsToDollars(t.subledgerCents), centsToDollars(t.controlCents), centsToDollars(t.varianceCents), t.ties ? 'Y' : 'N']));
  }
  return out.join('\r\n');
}
